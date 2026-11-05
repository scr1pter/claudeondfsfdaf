import { createHash } from "node:crypto";
import { audit, id, log, now, store, type Entity } from "./db";

const configuredLimit = process.env.WORKER_LIMIT;
export const workerLimit = configuredLimit !== undefined && /^[1-4]$/.test(configuredLimit) ? Number(configuredLimit) : 2;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let started = false;
let scheduling = false;
let wakePending = false;

function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409, code: "state_conflict" });
}
function transition(job: Entity, event: string, message: string) {
  log(job.id, event, message);
  audit(job.projectId, job.actorId ?? null, `job.${event}`, job.id, { releaseId: job.releaseId, stepKey: job.stepKey, attempts: job.attempts, recoveryCount: job.recoveryCount });
}

/** Called inside the API's transaction, together with its idempotency receipt. */
export function createRun(release: Entity, actorId: string): { release: Entity; jobs: Entity[] } {
  if (release.status !== "ready") conflict("Only a ready release can run.");
  const keys = new Map<string, string>(release.steps.map((step: Entity) => [step.key, id()]));
  const jobs = release.steps.map((step: Entity) => ({
    id: keys.get(step.key), releaseId: release.id, stepKey: step.key, name: step.name, kind: step.kind,
    dependsOn: step.dependsOn.map((key: string) => keys.get(key)), status: "queued", attempts: 0, recoveryCount: 0,
    startedAt: null, finishedAt: null, error: null,
    projectId: release.projectId, actorId, durationMs: step.durationMs, failureMode: step.failureMode,
  }));
  const updated = { ...release, status: "running", revision: release.revision + 1, startedAt: now(), finishedAt: null, updatedAt: now() };
  store.put("releases", updated);
  for (const job of jobs) {
    store.put("jobs", job);
    transition(job, "queued", `Queued ${job.name}.`);
  }
  audit(release.projectId, actorId, "release.running", release.id, { jobIds: jobs.map((job: Entity) => job.id) });
  return { release: updated, jobs };
}

export function cancelRun(release: Entity, reason: string, actorId: string): Entity {
  if (release.status !== "running") conflict("Only a running release can be cancelled.");
  const stamp = now();
  for (const job of store.all("jobs").filter(job => job.releaseId === release.id && ["queued", "running"].includes(job.status))) {
    clearTimeout(timers.get(job.id));
    timers.delete(job.id);
    job.status = "cancelled";
    job.finishedAt = stamp;
    job.error = reason;
    store.put("jobs", job);
    transition(job, "cancelled", reason);
  }
  const updated = { ...release, status: "cancelled", revision: release.revision + 1, updatedAt: stamp, finishedAt: stamp };
  store.put("releases", updated);
  audit(release.projectId, actorId, "release.cancelled", release.id, { reason });
  return updated;
}

export function retryRun(release: Entity, actorId: string): Entity {
  if (release.status !== "failed") conflict("Only a failed release can be retried.");
  for (const job of store.all("jobs").filter(job => job.releaseId === release.id && ["failed", "blocked"].includes(job.status))) {
    job.status = "queued";
    job.startedAt = null;
    job.finishedAt = null;
    job.error = null;
    job.actorId = actorId;
    store.put("jobs", job);
    transition(job, "queued", "Queued for retry; previous attempts are retained.");
  }
  const updated = { ...release, status: "running", revision: release.revision + 1, updatedAt: now(), finishedAt: null };
  store.put("releases", updated);
  audit(release.projectId, actorId, "release.retried", release.id, {});
  return updated;
}

function finishReleases() {
  for (const release of store.all("releases").filter(release => release.status === "running")) {
    const jobs = store.all("jobs").filter(job => job.releaseId === release.id);
    if (!jobs.length || jobs.some(job => job.status === "queued" || job.status === "running")) continue;
    const succeeded = jobs.every(job => job.status === "succeeded");
    const stamp = now();
    release.status = succeeded ? "succeeded" : "failed";
    release.updatedAt = stamp;
    release.finishedAt = stamp;
    release.revision += 1;
    if (succeeded) {
      const environment = store.get("environments", release.environmentId);
      if (environment) {
        release.previousReleaseId = environment.activeReleaseId;
        environment.activeReleaseId = release.id;
        environment.updatedAt = stamp;
        store.put("environments", environment);
      }
    }
    store.put("releases", release);
    audit(release.projectId, jobs[0]?.actorId ?? null, `release.${release.status}`, release.id, { environmentId: release.environmentId });
  }
}

function writeArtifact(job: Entity, release: Entity) {
  // Only a successfully completed job creates bytes, and a successful job is
  // never retried. This guard also makes recovery resilient to old receipts.
  if (store.all("artifacts").some(artifact => artifact.jobId === job.id)) return;
  const content = `Harbor local simulation artifact\nRelease: ${release.versionLabel}\nStep: ${job.stepKey}\nName: ${job.name}\nAttempt: ${job.attempts}\nResult: succeeded\n`;
  const safeVersion = release.versionLabel.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50) || "release";
  const artifact = {
    id: id(), jobId: job.id, releaseId: release.id,
    name: `${safeVersion}-${job.stepKey}-${job.id.slice(0, 8)}.txt`,
    size: Buffer.byteLength(content, "utf8"), sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    createdAt: now(), content,
  };
  store.put("artifacts", artifact);
}

function complete(jobId: string, attempt: number) {
  timers.delete(jobId);
  if (!started) return;
  store.transaction(() => {
    const job = store.get("jobs", jobId);
    const release = job && store.get("releases", job.releaseId);
    // A cancelled, recovered, or later attempt cannot be overwritten by an old timer.
    if (!job || job.status !== "running" || job.attempts !== attempt || release?.status !== "running") return;
    const failed = job.failureMode === "always" || (job.failureMode === "once" && attempt === 1);
    job.status = failed ? "failed" : "succeeded";
    job.finishedAt = now();
    job.error = failed ? `Simulated ${job.failureMode} failure for ${job.stepKey}.` : null;
    store.put("jobs", job);
    if (!failed) writeArtifact(job, release);
    transition(job, job.status, failed ? job.error : `Completed ${job.name}; artifact generated.`);
  });
  wakeWorkers();
}

function schedule() {
  if (!started || scheduling) return;
  scheduling = true;
  try {
    const admitted: Entity[] = [];
    store.transaction(() => {
      // Propagate dependency failures before finalizing a release. This reaches
      // every descendant without ever executing a blocked step.
      let changed: boolean;
      do {
        changed = false;
        for (const job of store.all("jobs").filter(job => job.status === "queued")) {
          if (store.get("releases", job.releaseId)?.status !== "running") continue;
          if (job.dependsOn.some((dependency: string) => ["failed", "blocked", "cancelled"].includes(store.get("jobs", dependency)?.status))) {
            job.status = "blocked";
            job.finishedAt = now();
            job.error = "A dependency did not succeed.";
            store.put("jobs", job);
            transition(job, "blocked", job.error);
            changed = true;
          }
        }
      } while (changed);
      finishReleases();
      let capacity = workerLimit - store.all("jobs").filter(job => job.status === "running").length;
      for (const job of store.all("jobs").filter(job => job.status === "queued")) {
        if (capacity <= 0) break;
        if (store.get("releases", job.releaseId)?.status !== "running") continue;
        if (!job.dependsOn.every((dependency: string) => store.get("jobs", dependency)?.status === "succeeded")) continue;
        job.status = "running";
        job.attempts += 1;
        job.startedAt = now();
        job.finishedAt = null;
        job.error = null;
        store.put("jobs", job);
        transition(job, "started", `Started ${job.name}, attempt ${job.attempts}.`);
        admitted.push(job);
        capacity -= 1;
      }
    });
    for (const job of admitted) timers.set(job.id, setTimeout(() => complete(job.id, job.attempts), job.durationMs));
  } finally { scheduling = false; }
}

export function wakeWorkers(): void {
  if (!started || wakePending) return;
  wakePending = true;
  queueMicrotask(() => { wakePending = false; schedule(); });
}

export function startWorkers(): void {
  if (started) return;
  store.transaction(() => {
    for (const job of store.all("jobs").filter(job => job.status === "running")) {
      if (store.get("releases", job.releaseId)?.status !== "running") continue;
      job.status = "queued";
      job.recoveryCount += 1;
      job.finishedAt = null;
      job.error = null;
      store.put("jobs", job);
      transition(job, "recovered", "Recovered unfinished work after process restart.");
    }
  });
  started = true;
  wakeWorkers();
}

export function stopWorkers(): void {
  started = false;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
