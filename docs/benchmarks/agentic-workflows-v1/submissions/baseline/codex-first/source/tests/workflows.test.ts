import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// All process evidence and disposable databases stay out of authored source.
const root = resolve(import.meta.dir, "..");
const artifacts = join(root, ".verification", "tests");
mkdirSync(artifacts, { recursive: true });
type ServerProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;
type Job = { id: string; key: string; name: string; kind: string; status: string;
  result: string | null; error: string | null; dependsOn: string[]; maxAttempts: number;
  attempts: { number: number; status: string; pid: number; startedAt: number; finishedAt: number | null }[] };
type Workflow = { id: string; name: string; status: string; concurrency: number; jobs: Job[] };
type Event = { seq: number; type: string; jobKey?: string; attempt?: number };
const children = new Set<ServerProcess>();
const directories: string[] = [];
function directory() {
  const result = mkdtempSync(join(artifacts, "run-"));
  directories.push(result);
  return result;
}
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 6500): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for process state: ${JSON.stringify(last!)}`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stop(child: ServerProcess) {
  if (!children.has(child)) return;
  child.kill("SIGKILL");
  await child.exited;
  children.delete(child);
}
afterEach(async () => {
  await Promise.all([...children].map(stop));
  // Protected blocked workers detect parent disappearance themselves.
  for (const data of directories) {
    const markers = join(data, "markers");
    if (!existsSync(markers)) continue;
    for (const file of readdirSync(markers).filter((file) => file.endsWith(".started.json"))) {
      const { pid } = JSON.parse(readFileSync(join(markers, file), "utf8"));
      await until(() => alive(pid), (live) => !live);
    }
  }
  directories.length = 0;
});
async function start(data = directory(), limit = 2) {
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DATA_DIR: data, PORT: "0", WORKFLOW_CONCURRENCY: String(limit),
      WORKFLOW_WORKER_PATH: join(root, "server/worker.ts"), WORKFLOW_MARKER_DIR: join(data, "markers") },
  });
  children.add(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const port = await until(async () => {
    const next = await reader.read();
    if (next.done) throw new Error(`Server exited: ${await new Response(child.stderr).text()}`);
    output += decoder.decode(next.value);
    return /127\.0\.0\.1:(\d+)/.exec(output)?.[1];
  }, Boolean);
  reader.releaseLock();
  const base = `http://127.0.0.1:${port}`;
  async function request(path: string, method = "GET", body?: unknown, key?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== undefined) headers["Idempotency-Key"] = key;
    const response = await fetch(base + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const workflow = async (id: string): Promise<Workflow> => (await request(`/api/workflows/${id}`)).body.workflow;
  async function create(jobs: unknown[], concurrency = 2, name = "Test workflow", key = crypto.randomUUID()) {
    const response = await request("/api/workflows", "POST", { name, concurrency, jobs }, key);
    expect(response.status).toBe(201);
    return response.body.workflow as Workflow;
  }
  const events = async (id: string): Promise<Event[]> => (await request(`/api/workflows/${id}/events`)).body.events;
  function evidence(job: Job, number = job.attempts.at(-1)!.number) {
    return JSON.parse(readFileSync(join(data, "markers", `${job.id}.${number}.started.json`), "utf8"));
  }
  function release(job: Job) {
    writeFileSync(join(data, "markers", `${job.id}.${job.attempts.at(-1)!.number}.release`), "released by local test");
  }
  return { child, data, base, request, workflow, create, events, evidence, release };
}
const job = (key: string, kind = "succeed", dependsOn: string[] = [], maxAttempts = 1) => ({ key, name: key, kind, dependsOn, maxAttempts });

test("v1 migration preserves every completed field and legacy API across restarts", async () => {
  const data = directory();
  const db = new Database(join(data, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  const old = [
    { id: "old_success", name: "Original result", kind: "succeed", status: "succeeded", attempt: 3, result: "old stdout", error: null, created_at: 101, updated_at: 202 },
    { id: "old_failure", name: "Original failure", kind: "fail", status: "failed", attempt: 1, result: null, error: "old error", created_at: 303, updated_at: 404 },
  ];
  for (const record of old) db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(record));
  db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES('old_pending','Pending','succeed','queued',1,1)").run();
  db.close();
  let server = await start(data);
  expect((await server.request("/api/health")).body).toEqual({ ok: true, schemaVersion: 2 });
  for (const record of old) expect((await server.request(`/api/jobs/${record.id}`)).body.job).toEqual(record);
  await until(async () => (await server.request("/api/jobs/old_pending")).body.job.status, (status) => status === "succeeded");
  const created = await server.request("/api/jobs", "POST", { name: "New legacy", kind: "succeed" });
  expect(created.status).toBe(201);
  expect(created.body.job).toMatchObject({ name: "New legacy", kind: "succeed", status: "queued", attempt: 0 });
  await until(async () => (await server.request(`/api/jobs/${created.body.job.id}`)).body.job.status, (status) => status === "succeeded");
  await stop(server.child);
  server = await start(data);
  for (const record of old) expect((await server.request(`/api/jobs/${record.id}`)).body.job).toEqual(record);
  expect((await server.request("/api/jobs")).body.jobs).toHaveLength(4);
  expect((await server.request("/api/workflows")).body.workflows).toHaveLength(0);
  expect(readdirSync(join(data, "markers")).some((file) => file.startsWith("old_success") || file.startsWith("old_failure"))).toBe(false);
  const persisted = new Database(join(data, "workflow.sqlite"));
  expect(persisted.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe("2");
  persisted.close();
}, 20000);

test("failed migration rolls back schema version and legacy mutations", async () => {
  const data = directory();
  const db = new Database(join(data, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  db.exec("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES('preserved','Safe','succeed','succeeded',1,2); CREATE TABLE workflows(wrong_column TEXT);");
  db.close();
  const child = Bun.spawn([process.execPath, "server/index.ts"], { cwd: root, env: { ...process.env, PORT: "0", DATA_DIR: data }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.add(child);
  expect(await child.exited).not.toBe(0);
  const check = new Database(join(data, "workflow.sqlite"));
  expect(check.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe("1");
  expect(check.query<{ status: string }, []>("SELECT status FROM jobs WHERE id='preserved'").get()!.status).toBe("succeeded");
  expect(check.query("SELECT name FROM sqlite_master WHERE name='attempts'").get()).toBeNull();
  check.close();
});

test("validation is atomic, malformed bodies fail, and rejected keys remain reusable", async () => {
  const server = await start();
  const valid = { name: "Valid", concurrency: 2, jobs: [job("one")] };
  const invalid: unknown[] = [null, [], "text", {}, { ...valid, name: " " }, { ...valid, name: "x".repeat(121) },
    { ...valid, concurrency: "2" }, { ...valid, concurrency: 0 }, { ...valid, concurrency: 4 }, { ...valid, concurrency: 1.5 },
    { ...valid, jobs: [] }, { ...valid, jobs: Array.from({ length: 41 }, (_, i) => job(`j${i}`)) },
    { ...valid, jobs: [null] }, { ...valid, jobs: [job("1bad")] }, { ...valid, jobs: [job("a".repeat(33))] },
    { ...valid, jobs: [job("one"), job("one")] }, { ...valid, jobs: [job("one", "unknown")] },
    { ...valid, jobs: [{ ...job("one"), name: 1 }] }, { ...valid, jobs: [{ ...job("one"), dependsOn: null }] },
    { ...valid, jobs: [{ ...job("one"), dependsOn: [1] }] }, { ...valid, jobs: [job("one", "succeed", ["missing"])] },
    { ...valid, jobs: [job("one", "succeed", ["one"])] },
    { ...valid, jobs: [job("one"), job("two", "succeed", ["one", "one"])] },
    { ...valid, jobs: [job("one", "succeed", ["two"]), job("two", "succeed", ["one"])] },
    ...[0, 4, 1.5, "2", null].map((maxAttempts) => ({ ...valid, jobs: [{ ...job("one"), maxAttempts }] })),
  ];
  for (const body of invalid) expect((await server.request("/api/workflows", "POST", body, "reusable")).status).toBe(400);
  for (const key of [undefined, "", " ", "x".repeat(129)])
    expect((await server.request("/api/workflows", "POST", valid, key)).status).toBe(400);
  const malformed = await fetch(server.base + "/api/workflows", { method: "POST", headers: { "Idempotency-Key": "reusable" }, body: "{" });
  expect(malformed.status).toBe(400);
  expect((await server.request("/api/workflows")).body.workflows).toEqual([]);
  expect((await server.request("/api/jobs")).body.jobs).toEqual([]);
  const db = new Database(join(server.data, "workflow.sqlite"));
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()!.count).toBe(0);
  db.close();
  expect((await server.request("/api/workflows", "POST", valid, "reusable")).status).toBe(201);
  for (const path of ["/api/workflows/missing", "/api/workflows/missing/events", "/api/jobs/missing"])
    expect((await server.request(path)).status).toBe(404);
  expect((await server.request("/api/workflows/missing/cancel", "POST")).status).toBe(404);
  for (const body of [null, { name: "", kind: "succeed" }, { name: "valid", kind: "unknown" }])
    expect((await server.request("/api/jobs", "POST", body)).status).toBe(400);
});

test("idempotency sorts object properties, preserves array identity and survives restart without new events", async () => {
  let server = await start();
  const body = { name: "Idempotent", concurrency: 2, jobs: [job("a"), job("b", "succeed", ["a"])] };
  const responses = await Promise.all([server.request("/api/workflows", "POST", body, "stable"), server.request("/api/workflows", "POST", body, "stable")]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  const id = responses[0].body.workflow.id;
  expect(responses[1].body.workflow.id).toBe(id);
  await until(() => server.workflow(id), (workflow) => workflow.status === "succeeded");
  const before = await server.events(id);
  const reordered = { jobs: body.jobs.map(({ key, name, kind, dependsOn, maxAttempts }) => ({ maxAttempts, dependsOn, kind, name, key })), concurrency: 2, name: "Idempotent" };
  const replay = await server.request("/api/workflows", "POST", reordered, "stable");
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(await server.events(id)).toEqual(before);
  expect((await server.request("/api/workflows", "POST", { ...body, jobs: [...body.jobs].reverse() }, "stable")).status).toBe(409);
  await stop(server.child);
  server = await start(server.data);
  expect((await server.request("/api/workflows", "POST", body, "stable")).status).toBe(200);
  expect(await server.events(id)).toEqual(before);
  expect((await server.workflow(id)).jobs.map((job) => job.attempts.length)).toEqual([1, 1]);
  expect((await server.request("/api/workflows")).body.workflows).toHaveLength(1);
});

test("DAG execution uses real PIDs, observes predecessor completion, and retains fail_once history", async () => {
  const server = await start();
  const created = await server.create([job("gate", "block"), job("retry", "fail_once", ["gate"], 2), job("join", "succeed", ["retry"])]);
  let state = await until(() => server.workflow(created.id), (workflow) => workflow.jobs[0].status === "running");
  await until(() => existsSync(join(server.data, "markers", `${state.jobs[0].id}.1.started.json`)), Boolean);
  const evidence = server.evidence(state.jobs[0]);
  expect(evidence).toMatchObject({ jobId: state.jobs[0].id, attempt: 1, pid: state.jobs[0].attempts[0].pid, parent: server.child.pid });
  expect(alive(evidence.pid)).toBe(true);
  expect(state.jobs[0].attempts[0].finishedAt).toBeNull();
  expect(state.jobs.slice(1).every((job) => job.attempts.length === 0)).toBe(true);
  server.release(state.jobs[0]);
  state = await until(() => server.workflow(created.id), (workflow) => workflow.status === "succeeded");
  expect(state.jobs[1].attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
  expect(state.jobs[1].attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
  expect(state.jobs[1].attempts[0].startedAt).toBeGreaterThanOrEqual(state.jobs[0].attempts[0].finishedAt!);
  expect(state.jobs[2].attempts[0].startedAt).toBeGreaterThanOrEqual(state.jobs[1].attempts[1].finishedAt!);
  for (const item of state.jobs) {
    expect(JSON.parse(item.result!)).toMatchObject({ jobId: item.id, message: "completed" });
    expect(item.attempts.every((attempt) => attempt.pid > 0 && attempt.finishedAt !== null)).toBe(true);
  }
  const events = await server.events(state.id);
  expect(events.map((event) => event.type)).toEqual(["workflow.created", "job.started", "job.succeeded", "job.started", "job.failed", "job.retrying", "job.started", "job.succeeded", "job.started", "job.succeeded", "workflow.succeeded"]);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
});

test("retry exhaustion blocks descendants while independent work settles; events use strict isolated cursors", async () => {
  const server = await start();
  const created = await server.create([job("bad", "fail", [], 3), job("blocked", "succeed", ["bad"]), job("transitive", "succeed", ["blocked"]), job("independent", "block")]);
  let state = await until(() => server.workflow(created.id), (workflow) => workflow.jobs[0].status === "failed" && workflow.jobs[2].status === "blocked");
  expect(state.status).toBe("running");
  expect(state.jobs[0].attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "failed"]);
  expect(state.jobs[0].error).toContain("Synthetic worker requested failure");
  expect(state.jobs[0].error!.length).toBeLessThanOrEqual(4000);
  expect(state.jobs[1].attempts).toEqual([]);
  expect(state.jobs[2].attempts).toEqual([]);
  server.release(state.jobs[3]);
  state = await until(() => server.workflow(state.id), (workflow) => workflow.status === "failed");
  const history = await server.events(state.id);
  expect(history.filter((event) => event.type === "job.failed")).toHaveLength(3);
  expect(history.filter((event) => event.type === "job.retrying")).toHaveLength(2);
  expect(history.filter((event) => event.type === "job.blocked")).toHaveLength(2);
  expect(history.at(-1)!.type).toBe("workflow.failed");
  expect((await server.request(`/api/workflows/${state.id}/events?after=3`)).body.events).toEqual(history.filter((event) => event.seq > 3));
  expect((await server.request(`/api/workflows/${state.id}/events?after=999999`)).body.events).toEqual([]);
  for (const cursor of ["", "-1", "1.2", "abc", "1e2", "Infinity", "9007199254740992"])
    expect((await server.request(`/api/workflows/${state.id}/events?after=${cursor}`)).status).toBe(400);
  const other = await server.create([job("other_only")]);
  await until(() => server.workflow(other.id), (workflow) => workflow.status === "succeeded");
  expect((await server.events(other.id)).every((event) => !event.jobKey || event.jobKey === "other_only")).toBe(true);
  expect(await server.events(state.id)).toEqual(history);
  expect((await server.request(`/api/workflows/${state.id}/cancel`, "POST")).status).toBe(409);
});

for (const limit of [1, 2, 3]) test(`global live-worker bound ${limit} and workflow bound 1 apply to actual blocked processes`, async () => {
  const server = await start(undefined, limit);
  const one = await server.create([job("one", "block"), job("two", "block"), job("three", "block")], 1, "Serial");
  const many = await server.create([job("a", "block"), job("b", "block"), job("c", "block")], 3, "Parallel");
  const states = await until(async () => [await server.workflow(one.id), await server.workflow(many.id)],
    (values) => values.flatMap((workflow) => workflow.jobs).filter((job) => job.status === "running").length === limit);
  for (let i = 0; i < 6; i++) {
    const current = [await server.workflow(one.id), await server.workflow(many.id)];
    expect(current[0].jobs.filter((job) => job.status === "running").length).toBeLessThanOrEqual(1);
    const running = current.flatMap((workflow) => workflow.jobs).filter((job) => job.status === "running");
    expect(running).toHaveLength(limit);
    for (const active of running) expect(alive(active.attempts[0].pid)).toBe(true);
    await Bun.sleep(30);
  }
  expect(states.flatMap((workflow) => workflow.jobs).filter((job) => job.attempts.length)).toHaveLength(limit);
  await server.request(`/api/workflows/${one.id}/cancel`, "POST");
  const filling = await until(() => server.workflow(many.id), (workflow) => workflow.jobs.filter((job) => job.status === "running").length === limit);
  for (const active of filling.jobs.filter((job) => job.status === "running")) expect(alive(active.attempts[0].pid)).toBe(true);
  await server.request(`/api/workflows/${many.id}/cancel`, "POST");
});

test("cancellation reaps children, preserves results, prevents starts, is idempotent, and isolates other workflows", async () => {
  const server = await start();
  const created = await server.create([job("done"), job("running", "block", ["done"]), job("never", "succeed", ["running"])], 1);
  const state = await until(() => server.workflow(created.id), (workflow) => workflow.jobs[1].status === "running");
  const originalResult = state.jobs[0].result;
  const pid = state.jobs[1].attempts[0].pid;
  const other = await server.create([job("unaffected", "block")], 1, "Unrelated");
  const independent = await until(() => server.workflow(other.id), (workflow) => workflow.jobs[0].status === "running");
  const responses = await Promise.all([server.request(`/api/workflows/${created.id}/cancel`, "POST"), server.request(`/api/workflows/${created.id}/cancel`, "POST")]);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(alive(pid)).toBe(false);
  const cancelled = await server.workflow(created.id);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.jobs.map((job) => job.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
  expect(cancelled.jobs[0].result).toBe(originalResult);
  expect(cancelled.jobs[1].attempts[0].status).toBe("cancelled");
  expect(cancelled.jobs[1].attempts[0].finishedAt).not.toBeNull();
  const history = await server.events(created.id);
  expect(history.filter((event) => event.type === "job.cancelled")).toHaveLength(2);
  expect(history.at(-1)!.type).toBe("workflow.cancelled");
  expect((await server.request(`/api/workflows/${created.id}/cancel`, "POST")).status).toBe(200);
  await Bun.sleep(150);
  expect(await server.events(created.id)).toEqual(history);
  expect(existsSync(join(server.data, "markers", `${cancelled.jobs[2].id}.1.started.json`))).toBe(false);
  expect(alive(independent.jobs[0].attempts[0].pid)).toBe(true);
  server.release(independent.jobs[0]);
  await until(() => server.workflow(other.id), (workflow) => workflow.status === "succeeded");
  expect((await server.request(`/api/workflows/${other.id}/cancel`, "POST")).status).toBe(409);
});

test("crash recovery interrupts history, retries maxAttempts=1, and never reruns completed predecessors", async () => {
  let server = await start();
  const body = { name: "Recover", concurrency: 1, jobs: [job("complete"), job("interrupted", "block", ["complete"]), job("last", "succeed", ["interrupted"])] };
  const created = (await server.request("/api/workflows", "POST", body, "recover-key")).body.workflow as Workflow;
  const before = await until(() => server.workflow(created.id), (workflow) => workflow.jobs[1].status === "running");
  const pid = before.jobs[1].attempts[0].pid;
  const oldEvents = await server.events(created.id);
  await stop(server.child);
  server = await start(server.data);
  const recovered = await until(() => server.workflow(created.id), (workflow) => workflow.jobs[1].attempts.length === 2);
  expect(alive(pid)).toBe(false);
  expect(recovered.jobs[0]).toEqual(before.jobs[0]);
  expect(recovered.jobs[1].attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "running"]);
  expect(recovered.jobs[1].attempts[0].pid).toBe(pid);
  expect(recovered.jobs[1].attempts[0].finishedAt).not.toBeNull();
  expect(recovered.jobs[1].attempts[1].number).toBe(2);
  expect(alive(recovered.jobs[1].attempts[1].pid)).toBe(true);
  expect(recovered.jobs[2].attempts).toEqual([]);
  server.release(recovered.jobs[1]);
  const finished = await until(() => server.workflow(created.id), (workflow) => workflow.status === "succeeded");
  expect(finished.jobs[0].attempts).toHaveLength(1);
  expect(finished.jobs[1].attempts).toHaveLength(2);
  const history = await server.events(created.id);
  expect(history.slice(0, oldEvents.length)).toEqual(oldEvents);
  expect(history.filter((event) => event.type === "job.interrupted")).toHaveLength(1);
  expect(history.map((event) => event.seq)).toEqual(history.map((_, index) => index + 1));
  expect((await server.request("/api/workflows", "POST", body, "recover-key")).status).toBe(200);
  await stop(server.child);
  server = await start(server.data);
  expect(await server.workflow(created.id)).toEqual(finished);
  expect(await server.events(created.id)).toEqual(history);
  expect(existsSync(join(server.data, "markers", `${finished.jobs[0].id}.2.started.json`))).toBe(false);
}, 20000);
