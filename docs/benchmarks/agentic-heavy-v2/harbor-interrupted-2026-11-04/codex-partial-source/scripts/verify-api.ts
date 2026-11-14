// Synthetic, local-only HTTP integration verification. Start Harbor on PORT first.
import { strict as assert } from "node:assert";

const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const stamp = Date.now().toString(36);
let cookie = "";
let checks = 0;
async function request(path: string, method = "GET", body?: unknown, expected = 200, key?: string) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${raw}`);
  const data = raw && response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw;
  if (expected >= 400) {
    assert.equal(typeof data.error?.code, "string");
    assert.ok(data.error.message);
  }
  checks++;
  return { response, data };
}
async function actor(id: string) {
  const result = await request("/api/session", "POST", { actorId: id });
  const header = result.response.headers.get("set-cookie") ?? "";
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Lax/i);
  cookie = header.split(";")[0];
  assert.ok(cookie.split("=")[1].length >= 32);
}
const step = (key: string, failureMode = "never", dependsOn: string[] = [], durationMs = 100) => ({ key, name: `Verify ${key}`, kind: "check", dependsOn, durationMs, failureMode });
async function finished(path: string, expected: string) {
  for (let count = 0; count < 100; count++) {
    const { data } = await request(path);
    if (data.release.status === expected) return data.release;
    if (["failed", "cancelled", "succeeded"].includes(data.release.status) && data.release.status !== expected) throw new Error(`Unexpected release state ${data.release.status}; wanted ${expected}`);
    await Bun.sleep(80);
  }
  throw new Error(`Release did not reach ${expected}`);
}

await request("/api/health");
await request("/api/not-a-route", "GET", undefined, 404);
const actors = (await request("/api/actors")).data.actors;
assert.deepEqual(actors.map((entry: any) => entry.id).sort(), ["admin", "operator", "viewer"]);
await request("/api/projects", "GET", undefined, 401);
await actor("operator");
const project = (await request("/api/projects", "POST", { name: `API verification ${stamp}`, slug: `verify-${stamp}`, description: "Synthetic local verification" }, 201)).data.project;
const pp = `/api/projects/${project.id}`;
const environment = (await request(`${pp}/environments`, "POST", { name: "Protected production", protected: true }, 201)).data.environment;
await request(`${pp}/environments`, "POST", { name: "PROTECTED PRODUCTION" }, 409);
const runbook = (await request(`${pp}/runbooks`, "POST", { name: "Verified plan", steps: [step("check"), step("build", "never", ["check"])] }, 201)).data.runbook;
await request(`${pp}/runbooks/${runbook.id}`, "PATCH", { expectedVersion: 1, steps: [step("a", "never", ["b"]), step("b", "never", ["a"])] }, 400);
assert.equal((await request(`${pp}/runbooks/${runbook.id}`)).data.runbook.version, 1);
async function release(title: string, versionLabel: string, steps?: unknown[]) {
  return (await request(`${pp}/releases`, "POST", { title, versionLabel, environmentId: environment.id, ...(steps ? { steps } : { runbookId: runbook.id }) }, 201)).data.release;
}
async function approveAndRun(record: any, key: string) {
  const rp = `${pp}/releases/${record.id}`;
  let current = (await request(`${rp}/submit`, "POST", { expectedRevision: record.revision })).data.release;
  assert.equal(current.status, "awaiting_approval");
  await actor("admin");
  current = (await request(`${rp}/approve`, "POST", { expectedRevision: current.revision, decision: "approve", comment: "Reviewed synthetic snapshot" })).data.release;
  assert.equal(current.status, "ready");
  await request(`${rp}/run`, "POST", {}, 400);
  const run = (await request(`${rp}/run`, "POST", {}, 200, key)).data;
  const replay = (await request(`${rp}/run`, "POST", {}, 200, key)).data;
  assert.deepEqual(replay, run);
  await request(`${rp}/run`, "POST", { changed: true }, 409, key);
  return rp;
}
const first = await release("Initial stable release", "v1");
await request(`${pp}/runbooks/${runbook.id}`, "PATCH", { expectedVersion: 1, name: "Updated source plan", steps: [step("changed")] });
assert.equal((await request(`${pp}/releases/${first.id}`)).data.release.steps[0].key, "check");
await request(`${pp}/runbooks/${runbook.id}`, "PATCH", { expectedVersion: 1, name: "Stale" }, 409);
const firstPath = await approveAndRun(first, `first-${stamp}`);
await finished(firstPath, "succeeded");
const artifacts = (await request(`${firstPath}/artifacts`)).data.artifacts;
assert.equal(artifacts.length, 2);
for (const artifact of artifacts) {
  const result = await request(`/api/artifacts/${artifact.id}/content`);
  const bytes = new TextEncoder().encode(result.data);
  assert.equal(bytes.length, artifact.size);
  assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), artifact.sha256);
  assert.ok(result.data.includes("v1"));
  assert.match(result.response.headers.get("content-disposition") ?? "", /attachment/);
}
const jobs = (await request(`${firstPath}/jobs`)).data.jobs;
for (const job of jobs) {
  const logs = (await request(`/api/jobs/${job.id}/logs`)).data.logs;
  assert.deepEqual(logs.map((log: any) => log.sequence), logs.map((_: unknown, i: number) => i + 1));
  assert.equal(job.attempts, 1);
}
await actor("operator");
const second = await release("Fail once then recover", "v2", [step("flaky", "once"), step("dependent", "never", ["flaky"])]);
const secondPath = await approveAndRun(second, `second-${stamp}`);
await finished(secondPath, "failed");
await request(`${secondPath}/retry`, "POST", {});
const succeeded = await finished(secondPath, "succeeded");
assert.equal(succeeded.previousReleaseId, first.id);
const retryJobs = (await request(`${secondPath}/jobs`)).data.jobs;
assert.equal(retryJobs.find((job: any) => job.stepKey === "flaky").attempts, 2);
await request(`${secondPath}/rollback`, "POST", { reason: "Synthetic rollback verification" });
assert.equal((await request(`${pp}/environments/${environment.id}`)).data.environment.activeReleaseId, first.id);
await request(`${secondPath}/rollback`, "POST", { reason: "Repeat" }, 409);
await actor("operator");
const incident = (await request(`${pp}/incidents`, "POST", { environmentId: environment.id, releaseId: second.id, title: "Synthetic retry incident", severity: "sev2", summary: "Verification only" }, 201)).data.incident;
const ip = `${pp}/incidents/${incident.id}`;
await request(ip, "PATCH", { expectedVersion: 1, status: "resolved" }, 400);
await request(ip, "PATCH", { expectedVersion: 1, status: "resolved", resolution: "Recovered by retry" });
await request(ip, "PATCH", { expectedVersion: 1, title: "Stale" }, 409);
await request(ip, "PATCH", { expectedVersion: 2, status: "open" });
await request(`${ip}/notes`, "POST", { body: "Synthetic follow-up note" }, 201);
assert.equal((await request(ip)).data.incident.resolvedAt, null);
assert.ok((await request(`${ip}/timeline`)).data.events.length >= 4);
await actor("viewer");
await request(`${pp}/incidents`);
await request(`${ip}/notes`, "POST", { body: "Disallowed" }, 403);
await request(pp, "PATCH", { name: "Disallowed" }, 403);
await request(`${firstPath}/rollback`, "POST", { reason: "Disallowed" }, 403);
const exported = (await request(`${pp}/export`)).data;
assert.equal(exported.project.id, project.id);
assert.ok(!("sessions" in exported));
const events = (await request(`/api/audit?projectId=${project.id}`)).data.events;
assert.ok(events.length > 15);
assert.ok(events.every((event: any, index: number) => index === 0 || event.sequence > events[index - 1].sequence));
assert.equal((await request(`/api/audit?projectId=${project.id}&after=${events.at(-1).sequence}`)).data.events.length, 0);
await request("/api/dashboard");
await request(pp, "DELETE", undefined, 403);
await request("/api/session", "DELETE", undefined, 204);
await request("/api/session", "GET", undefined, 401);
console.log(JSON.stringify({ ok: true, checks, projectId: project.id, incidentId: incident.id, releaseIds: [first.id, second.id] }, null, 2));
