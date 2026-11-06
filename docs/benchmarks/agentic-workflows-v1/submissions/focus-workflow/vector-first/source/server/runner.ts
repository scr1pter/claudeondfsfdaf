import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LegacyJob = {
  id: string; name: string; kind: string; status: string; attempt: number;
  result: string | null; error: string | null; created_at: number; updated_at: number;
};
type WorkflowRow = {
  id: string; name: string; concurrency: number; status: string;
  created_at: number; updated_at: number;
};
type JobRow = {
  id: string; workflow_id: string; key: string; name: string; kind: string;
  dependencies: string; max_attempts: number; status: string;
  result: string | null; error: string | null; legacy_id: string | null; position: number;
};
type AttemptRow = {
  number: number; status: string; pid: number | null; started_at: number; finished_at: number | null;
};
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
type JobInput = { key: string; name: string; kind: string; dependsOn: string[]; maxAttempts: number };
export type WorkflowInput = { name: string; concurrency: number; jobs: JobInput[] };
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const kinds = ["succeed", "fail", "fail_once", "block"];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nameValid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const range = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

export function validateLegacy(value: unknown): { name: string; kind: string } {
  if (!object(value) || !nameValid(value.name) || typeof value.kind !== "string" || !kinds.includes(value.kind))
    throw new HttpError(400, "Provide a name (1-120 characters) and a valid job kind.");
  return { name: value.name.trim(), kind: value.kind };
}

export function validateWorkflow(value: unknown): WorkflowInput {
  if (!object(value) || !nameValid(value.name) || !range(value.concurrency, 3) ||
      !Array.isArray(value.jobs) || !range(value.jobs.length, 40))
    throw new HttpError(400, "Provide a workflow name, concurrency 1-3, and 1-40 jobs.");
  const jobs = value.jobs.map((job): JobInput => {
    const basic = validateLegacy(job);
    if (!object(job) || typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key) ||
        !range(job.maxAttempts === undefined ? 1 : job.maxAttempts, 3) ||
        (job.dependsOn !== undefined && (!Array.isArray(job.dependsOn) || job.dependsOn.some(key => typeof key !== "string"))))
      throw new HttpError(400, "Invalid job key, dependencies, or maxAttempts (1-3).");
    return { ...basic, key: job.key, maxAttempts: (job.maxAttempts as number | undefined) ?? 1,
      dependsOn: (job.dependsOn as string[] | undefined) ?? [] };
  });
  const byKey = new Map(jobs.map(job => [job.key, job]));
  if (byKey.size !== jobs.length) throw new HttpError(400, "Job keys must be unique.");
  for (const job of jobs) {
    if (new Set(job.dependsOn).size !== job.dependsOn.length ||
        job.dependsOn.some(key => key === job.key || !byKey.has(key)))
      throw new HttpError(400, "Dependencies must be unique existing keys, not the job itself.");
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new HttpError(400, "Workflow dependencies contain a cycle.");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const parent of byKey.get(key)!.dependsOn) visit(parent);
    visiting.delete(key);
    visited.add(key);
  }
  jobs.forEach(job => visit(job.key));
  return { name: value.name.trim(), concurrency: value.concurrency, jobs };
}

// Sort object keys recursively; array order is part of request identity.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class Runner {
  readonly db: Database;
  private live = new Map<string, { child: Child; done: Promise<void>; workflowId: string }>();
  private cancellations = new Map<string, Promise<unknown>>();
  private stopping = false;
  private timer: ReturnType<typeof setInterval>;
  private limit: number;
  constructor(private root: string, private directory: string) {
    const configured = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
    if (!range(configured, 3)) throw new Error("WORKFLOW_CONCURRENCY must be an integer from 1 to 3");
    this.limit = configured;
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "workflow.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.transaction(() => {
      this.db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
      const version = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value;
      if (!["1", "2"].includes(version)) throw new Error(`Unsupported schema version: ${version}`);
      this.db.exec(readFileSync(join(root, "sql/v2.sql"), "utf8"));
      if (version === "1") {
        for (const legacy of this.db.query<LegacyJob, []>("SELECT * FROM jobs WHERE status IN ('queued','running')").all()) {
          const id = this.insert({ name: legacy.name, concurrency: 1, jobs: [
            { key: "job", name: legacy.name, kind: legacy.kind, dependsOn: [], maxAttempts: 1 },
          ] }, legacy);
          if (legacy.attempt > 0) {
            this.db.query("INSERT INTO attempts VALUES(?,?,'interrupted',NULL,?,?)").run(legacy.id, legacy.attempt, legacy.updated_at, Date.now());
            this.event(id, "job.interrupted", "job", legacy.attempt);
          }
        }
      }
      this.db.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    })();
    this.db.transaction(() => {
      const interrupted = this.db.query<JobRow & { number: number }, []>(
        "SELECT j.*, a.number FROM workflow_jobs j JOIN attempts a ON a.job_id=j.id WHERE a.status='running'",
      ).all();
      for (const job of interrupted) {
        const cancelled = this.row(job.workflow_id)!.status === "cancelled";
        this.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?")
          .run(cancelled ? "cancelled" : "interrupted", Date.now(), job.id, job.number);
        this.db.query("UPDATE workflow_jobs SET status=? WHERE id=?").run(cancelled ? "cancelled" : "queued", job.id);
        this.event(job.workflow_id, cancelled ? "job.cancelled" : "job.interrupted", job.key, job.number);
      }
      for (const workflow of this.db.query<WorkflowRow, []>("SELECT * FROM workflows WHERE status='cancelled'").all()) {
        if (!this.db.query("SELECT 1 FROM events WHERE workflow_id=? AND type='workflow.cancelled'").get(workflow.id))
          this.event(workflow.id, "workflow.cancelled");
      }
    })();
    this.timer = setInterval(() => this.dispatch(), 40);
  }
  private row(id: string) { return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id); }
  private jobs(id: string) { return this.db.query<JobRow, [string]>("SELECT * FROM workflow_jobs WHERE workflow_id=? ORDER BY position").all(id); }
  private event(id: string, type: string, key?: string, attempt?: number) {
    const now = Date.now();
    this.db.query("INSERT INTO events SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,? FROM events WHERE workflow_id=?")
      .run(id, type, now, key ?? null, attempt ?? null, id);
    this.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(now, id);
  }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) throw new HttpError(404, "Workflow not found");
    return { id: row.id, name: row.name, concurrency: row.concurrency, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      jobs: this.jobs(id).map(job => ({ id: job.id, key: job.key, name: job.name, kind: job.kind,
        dependsOn: JSON.parse(job.dependencies) as string[], maxAttempts: job.max_attempts,
        status: job.status, result: job.result, error: job.error,
        attempts: this.db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE job_id=? ORDER BY number").all(job.id)
          .map(a => ({ number: a.number, status: a.status, pid: a.pid, startedAt: a.started_at, finishedAt: a.finished_at })),
      })),
    };
  }
  workflows() { return this.db.query<{ id: string }, []>("SELECT id FROM workflows ORDER BY created_at,id").all().map(row => this.workflow(row.id)); }
  legacyJobs() { return this.db.query<LegacyJob, []>("SELECT * FROM jobs ORDER BY created_at,id").all(); }
  legacyJob(id: string) {
    const job = this.db.query<LegacyJob, [string]>("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  }
  private insert(input: WorkflowInput, legacy?: LegacyJob) {
    const id = crypto.randomUUID(), now = Date.now();
    this.db.query("INSERT INTO workflows VALUES(?,?,?,'queued',?,?)").run(id, input.name, input.concurrency, now, now);
    input.jobs.forEach((job, position) => {
      this.db.query("INSERT INTO workflow_jobs VALUES(?,?,?,?,?,?,?,'queued',NULL,NULL,?,?)")
        .run(legacy?.id ?? crypto.randomUUID(), id, job.key, job.name, job.kind,
          JSON.stringify(job.dependsOn), job.maxAttempts, legacy?.id ?? null, position);
    });
    this.event(id, "workflow.created");
    return id;
  }
  create(input: unknown, key: string | null) {
    if (!key || !key.trim() || key.length > 128) throw new HttpError(400, "Idempotency-Key must contain 1-128 characters.");
    const valid = validateWorkflow(input), contents = canonical(input);
    return this.db.transaction(() => {
      const prior = this.db.query<{ contents: string; workflow_id: string }, [string]>("SELECT * FROM idempotency WHERE key=?").get(key);
      if (prior) {
        if (prior.contents !== contents) throw new HttpError(409, "Idempotency key already used with different content.");
        return { workflow: this.workflow(prior.workflow_id), replayed: true };
      }
      const id = this.insert(valid);
      this.db.query("INSERT INTO idempotency VALUES(?,?,?)").run(key, contents, id);
      return { workflow: this.workflow(id), replayed: false };
    })();
  }
  createLegacy(input: unknown) {
    const valid = validateLegacy(input);
    return this.db.transaction(() => {
      const id = crypto.randomUUID(), now = Date.now();
      this.db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)").run(id, valid.name, valid.kind, now, now);
      const job = this.legacyJob(id);
      this.insert({ name: valid.name, concurrency: 1, jobs: [{ ...valid, key: "job", dependsOn: [], maxAttempts: 1 }] }, job);
      return job;
    })();
  }
  events(id: string, after: string) {
    this.workflow(id);
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new HttpError(400, "after must be a nonnegative integer.");
    return this.db.query<{ seq: number; type: string; created_at: number; job_key: string | null; attempt: number | null }, [string, number]>(
      "SELECT * FROM events WHERE workflow_id=? AND seq>? ORDER BY seq",
    ).all(id, Number(after)).map(e => ({ seq: e.seq, type: e.type, createdAt: e.created_at,
      ...(e.job_key !== null ? { jobKey: e.job_key } : {}), ...(e.attempt !== null ? { attempt: e.attempt } : {}) }));
  }
  private syncLegacy(job: JobRow, attempt?: number) {
    if (!job.legacy_id) return;
    this.db.query("UPDATE jobs SET status=?,result=?,error=?,attempt=COALESCE(?,attempt),updated_at=? WHERE id=?")
      .run(job.status, job.result, job.error, attempt ?? null, Date.now(), job.legacy_id);
  }
  private dispatch() {
    if (this.stopping) return;
    for (const workflow of this.db.query<WorkflowRow, []>("SELECT * FROM workflows WHERE status IN ('queued','running') ORDER BY created_at,id").all()) {
      const jobs = this.jobs(workflow.id), byKey = new Map(jobs.map(j => [j.key, j]));
      let active = jobs.filter(j => j.status === "running").length;
      // Propagate blocked states to a fixed point, even when descendants precede parents in the array.
      let changed: boolean;
      do {
        changed = false;
        for (const job of jobs) {
          if (job.status === "queued" && (JSON.parse(job.dependencies) as string[]).some(k => ["failed", "blocked", "cancelled"].includes(byKey.get(k)!.status))) {
            this.db.transaction(() => {
              job.status = "blocked";
              job.error = "A predecessor did not succeed.";
              this.db.query("UPDATE workflow_jobs SET status='blocked',error=? WHERE id=?").run(job.error, job.id);
              this.syncLegacy(job);
              this.event(workflow.id, "job.blocked", job.key);
            })();
            changed = true;
          }
        }
      } while (changed);
      for (const job of jobs) {
        if (active >= workflow.concurrency || this.live.size >= this.limit) break;
        if (job.status !== "queued" || !(JSON.parse(job.dependencies) as string[]).every(k => byKey.get(k)!.status === "succeeded")) continue;
        this.start(job);
        active++;
      }
      if (jobs.every(j => !["queued", "running"].includes(j.status))) {
        const status = jobs.every(j => j.status === "succeeded") ? "succeeded" : "failed";
        this.db.transaction(() => {
          this.db.query("UPDATE workflows SET status=? WHERE id=?").run(status, workflow.id);
          this.event(workflow.id, `workflow.${status}`);
        })();
      }
    }
  }
  private start(job: JobRow) {
    const number = this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(number),0)+1 AS n FROM attempts WHERE job_id=?").get(job.id)!.n;
    let child: Child;
    try {
      child = Bun.spawn([process.execPath, process.env.WORKFLOW_WORKER_PATH ?? join(this.root, "server/worker.ts"),
        "--job-id", job.id, "--attempt", String(number), "--kind", job.kind], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKFLOW_MARKER_DIR: process.env.WORKFLOW_MARKER_DIR ?? join(this.directory, "markers"), WORKFLOW_PARENT_PID: String(process.pid) },
      });
    } catch (failure) {
      this.db.transaction(() => {
        this.db.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(job.id, number, Date.now(), Date.now());
        this.finish(job, number, 1, "", `Worker could not start: ${String(failure)}`);
      })();
      return;
    }
    this.db.transaction(() => {
      this.db.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(job.id, number, child.pid, Date.now());
      job.status = "running";
      this.db.query("UPDATE workflow_jobs SET status='running',error=NULL WHERE id=?").run(job.id);
      this.db.query("UPDATE workflows SET status='running' WHERE id=?").run(job.workflow_id);
      this.syncLegacy({ ...job, error: null }, number);
      this.event(job.workflow_id, "job.started", job.key, number);
    })();
    const done = (async () => {
      const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (!this.stopping) this.db.transaction(() => this.finish(job, number, code, stdout, stderr))();
      this.live.delete(job.id);
      this.dispatch();
    })();
    this.live.set(job.id, { child, done, workflowId: job.workflow_id });
  }
  private finish(job: JobRow, number: number, code: number, stdout: string, stderr: string) {
    const cancelled = this.row(job.workflow_id)!.status === "cancelled";
    const status = cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed";
    this.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?").run(status, Date.now(), job.id, number);
    const failures = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM attempts WHERE job_id=? AND status='failed'").get(job.id)!.n;
    const retry = status === "failed" && failures < job.max_attempts;
    job.status = retry ? "queued" : status;
    job.result = status === "succeeded" ? stdout.trim() : null;
    job.error = status === "failed" ? (stderr.trim() || `Worker exited with code ${code}`).slice(0, 4000) : null;
    this.db.query("UPDATE workflow_jobs SET status=?,result=?,error=? WHERE id=?").run(job.status, job.result, job.error, job.id);
    this.syncLegacy(job, number);
    this.event(job.workflow_id, `job.${status}`, job.key, number);
    if (retry) this.event(job.workflow_id, "job.retrying", job.key, number);
  }
  async cancel(id: string) {
    const existing = this.cancellations.get(id);
    if (existing) { await existing; return this.workflow(id); }
    const workflow = this.workflow(id);
    if (["succeeded", "failed"].includes(workflow.status)) throw new HttpError(409, "Completed workflows cannot be cancelled.");
    if (workflow.status === "cancelled") return workflow;
    this.db.transaction(() => {
      this.db.query("UPDATE workflows SET status='cancelled' WHERE id=?").run(id);
      for (const job of this.jobs(id).filter(j => j.status === "queued")) {
        job.status = "cancelled";
        this.db.query("UPDATE workflow_jobs SET status='cancelled' WHERE id=?").run(job.id);
        this.syncLegacy(job);
        this.event(id, "job.cancelled", job.key);
      }
    })();
    const children = [...this.live.values()].filter(value => value.workflowId === id);
    for (const { child } of children) child.kill();
    const done = Promise.all(children.map(c => c.done)).then(() => {
      this.db.transaction(() => this.event(id, "workflow.cancelled"))();
    });
    this.cancellations.set(id, done);
    await done;
    this.cancellations.delete(id);
    return this.workflow(id);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    const children = [...this.live.values()];
    for (const { child } of children) child.kill();
    // Keep unfinished attempts in storage so startup records interruption, not failure.
    await Promise.all(children.map(c => c.done));
    this.db.close();
  }
}
