import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import type { Definition } from "../server/model";

type Workflow = NonNullable<ReturnType<Store["workflow"]>>;
type Event = ReturnType<Store["events"]>[number];
const root = resolve(import.meta.dir, "..");
const instances: Harness[] = [];
const directories: string[] = [];
const disposable = () => { const directory = mkdtempSync(join(tmpdir(), "workflow-test-")); directories.push(directory); return directory; };
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do { value = await read(); if (accept(value)) return value; await Bun.sleep(25); } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${JSON.stringify(value!)}`);
}
class Harness {
  child!: Bun.Subprocess<"ignore", "pipe", "pipe">;
  base = "";
  logs = "";
  stderr!: Promise<string>;
  constructor(readonly directory = disposable(), readonly limit = 2) { instances.push(this); }
  async start() {
    this.logs = "";
    this.child = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PORT: "0", DATA_DIR: this.directory, WORKFLOW_MARKER_DIR: join(this.directory, "markers"),
        WORKFLOW_WORKER_PATH: join(root, "server/worker.ts"), WORKFLOW_CONCURRENCY: String(this.limit) },
    });
    this.stderr = new Response(this.child.stderr).text();
    const reader = this.child.stdout.getReader();
    void (async () => { while (true) { const chunk = await reader.read(); if (chunk.done) break; this.logs += new TextDecoder().decode(chunk.value); } })();
    await until(() => this.logs, text => /listening on http:\/\/127.0.0.1:\d+/.test(text));
    this.base = this.logs.match(/http:\/\/127.0.0.1:\d+/)![0];
    expect((await this.get("/api/health"))).toEqual({ ok: true, schemaVersion: 2 });
    return this;
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGKILL");
    await this.child.exited;
    const errors = await this.stderr;
    expect(errors).toBe("");
  }
  async request(path: string, input?: unknown, key?: string) {
    return fetch(this.base + path, input === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(input),
    });
  }
  async get(path: string) { const response = await this.request(path); expect(response.status).toBe(200); return response.json(); }
  async create(jobs: Definition["jobs"] | unknown[], concurrency = 2, name = "Test workflow", key = crypto.randomUUID()): Promise<Workflow> {
    const response = await this.request("/api/workflows", { name, concurrency, jobs }, key);
    expect(response.status).toBe(201);
    return (await response.json()).workflow;
  }
  async workflow(id: string): Promise<Workflow> { return (await this.get(`/api/workflows/${id}`)).workflow; }
  async events(id: string): Promise<Event[]> { return (await this.get(`/api/workflows/${id}/events`)).events; }
  async settled(id: string) { return until(() => this.workflow(id), w => ["succeeded", "failed", "cancelled"].includes(w.status)); }
  marker(jobId: string, attempt: number, suffix: string) { return join(this.directory, "markers", `${jobId}.${attempt}.${suffix}`); }
  async started(jobId: string, attempt = 1) {
    await until(() => existsSync(this.marker(jobId, attempt, "started.json")), Boolean);
    return JSON.parse(readFileSync(this.marker(jobId, attempt, "started.json"), "utf8")) as { pid: number; parent: number; jobId: string; attempt: number };
  }
  release(jobId: string, attempt = 1) { writeFileSync(this.marker(jobId, attempt, "release"), "release from test client"); }
  async cancel(id: string) { return this.request(`/api/workflows/${id}/cancel`, {}); }
}
const node = (key: string, kind = "succeed", dependsOn: string[] = [], maxAttempts = 1) => ({ key, name: key, kind, dependsOn, maxAttempts });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  // Workers from crash tests exit themselves after observing that their parent disappeared.
  await Bun.sleep(80);
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes("workflow-test-")) throw new Error("Unsafe cleanup target");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable v1 migration preserves every completed field, serves UI, and runs new legacy work", async () => {
  const directory = disposable(), db = new Database(join(directory, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  const original = { id: "old_completed", name: "Old completed", kind: "succeed", status: "succeeded", attempt: 7, result: "original result", error: null, created_at: 11, updated_at: 12 };
  db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(original));
  db.query("INSERT INTO jobs VALUES('old_queued','Old queued','succeed','queued',0,NULL,NULL,13,14)").run();
  db.close();
  const app = await new Harness(directory).start();
  expect((await app.get("/api/jobs/old_completed")).job).toEqual(original);
  await until(() => app.get("/api/jobs/old_queued"), value => value.job.status === "succeeded");
  const response = await app.request("/api/jobs", { name: " New legacy ", kind: "succeed" });
  expect(response.status).toBe(201);
  const id = (await response.json()).job.id;
  const completed = await until(() => app.get(`/api/jobs/${id}`), value => value.job.status === "succeeded");
  expect(completed.job.name).toBe("New legacy");
  expect(JSON.parse(completed.job.result).jobId).toBe(id);
  expect((await fetch(app.base)).status).toBe(200);
  expect(await (await fetch(app.base)).text()).toContain("Workflow Runner");
  await app.stop(); await app.start();
  expect((await app.get("/api/jobs/old_completed")).job).toEqual(original);
  expect((await app.get(`/api/jobs/${id}`)).job.attempt).toBe(1);
  expect(readdirSync(join(directory, "markers")).some(file => file.startsWith("old_completed."))).toBe(false);
  const migrated = new Database(join(directory, "workflow.sqlite"));
  expect(migrated.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe("2"); migrated.close();
});

test("invalid graphs, types, JSON and headers are atomic and do not consume idempotency keys", async () => {
  const app = await new Harness().start();
  const valid = { name: "Valid", concurrency: 2, jobs: [node("a")] };
  const invalid: unknown[] = [null, [], {}, { ...valid, name: " " }, { ...valid, name: "x".repeat(121) },
    ...[0, 4, "2", 1.5, null].map(concurrency => ({ ...valid, concurrency })),
    { ...valid, jobs: [] }, { ...valid, jobs: Array.from({ length: 41 }, (_, n) => node(`a${n}`)) },
    ...[null, "bad", {}, [node("a"), node("a")], [node("a", "nope")], [node("1a")], [node("a", "succeed", ["a"])],
      [node("a", "succeed", ["missing"])], [node("a", "succeed", ["b"]), node("b", "succeed", ["a"])],
      [node("a"), node("b", "succeed", ["a", "a"])], [{ ...node("a"), dependsOn: null }], [{ ...node("a"), maxAttempts: "2" }],
      [node("a", "succeed", [], 0)], [node("a", "succeed", [], 4)]].map(jobs => ({ ...valid, jobs }))];
  for (const payload of invalid) expect((await app.request("/api/workflows", payload, "reusable")).status).toBe(400);
  for (const key of [undefined, "", " ", "x".repeat(129)]) expect((await app.request("/api/workflows", valid, key)).status).toBe(400);
  expect((await fetch(app.base + "/api/workflows", { method: "POST", headers: { "Idempotency-Key": "reusable" }, body: "{" })).status).toBe(400);
  const db = new Database(join(app.directory, "workflow.sqlite"));
  for (const table of ["jobs", "workflows", "events", "idempotency"]) expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0);
  db.close();
  expect((await app.request("/api/workflows", valid, "reusable")).status).toBe(201);
});

test("idempotency canonicalizes nested object order, isolates array order and persists across restart", async () => {
  const app = await new Harness().start();
  const payload = { name: "Idempotent", concurrency: 1, jobs: [node("a"), node("b")] };
  const initial = await app.request("/api/workflows", payload, "stable"); expect(initial.status).toBe(201);
  const workflow: Workflow = (await initial.json()).workflow;
  await app.settled(workflow.id);
  const events = await app.events(workflow.id);
  const reordered = { jobs: payload.jobs.map(job => ({ maxAttempts: job.maxAttempts, dependsOn: job.dependsOn, kind: job.kind, name: job.name, key: job.key })), concurrency: 1, name: "Idempotent" };
  for (let index = 0; index < 2; index++) {
    const replay = await app.request("/api/workflows", reordered, "stable"); expect(replay.status).toBe(200);
    const data = await replay.json(); expect(data.replayed).toBe(true); expect(data.workflow.id).toBe(workflow.id);
    expect(await app.events(workflow.id)).toEqual(events);
    if (index === 0) { await app.stop(); await app.start(); }
  }
  expect((await app.request("/api/workflows", { ...payload, jobs: [...payload.jobs].reverse() }, "stable")).status).toBe(409);
  expect((await app.get("/api/workflows")).workflows).toHaveLength(1);
  expect((await app.workflow(workflow.id)).jobs.every(job => job.attempts.length === 1)).toBe(true);
});

test("dependencies use real completion; failed attempts retry and preserve PID evidence and ordered events", async () => {
  const app = await new Harness().start();
  const workflow = await app.create([node("gate", "block"), node("retry", "fail_once", ["gate"], 2), node("final", "succeed", ["retry"])]);
  const marker = await app.started(workflow.jobs[0]!.id);
  const running = await app.workflow(workflow.id);
  expect(running.jobs[0]!.attempts[0]!.pid).toBe(marker.pid); expect(marker.parent).toBe(app.child.pid); expect(alive(marker.pid)).toBe(true);
  expect(running.jobs[0]!.attempts[0]!.finishedAt).toBeNull();
  expect(running.jobs[1]!.attempts).toHaveLength(0);
  app.release(workflow.jobs[0]!.id);
  const done = await app.settled(workflow.id); expect(done.status).toBe("succeeded");
  expect(done.jobs[1]!.attempts.map(attempt => attempt.status)).toEqual(["failed", "succeeded"]);
  expect(done.jobs[1]!.attempts[0]!.startedAt).toBeGreaterThanOrEqual(done.jobs[0]!.attempts[0]!.finishedAt!);
  expect(done.jobs[2]!.attempts[0]!.startedAt).toBeGreaterThanOrEqual(done.jobs[1]!.attempts[1]!.finishedAt!);
  for (const job of done.jobs) {
    expect(JSON.parse(job.result!).jobId).toBe(job.id);
    for (const attempt of job.attempts) {
      const evidence = await app.started(job.id, attempt.number);
      expect(attempt.pid).toBe(evidence.pid); expect(attempt.finishedAt).toBeNumber(); expect(alive(evidence.pid)).toBe(false);
      expect(existsSync(app.marker(job.id, attempt.number, "finished.json"))).toBe(true);
    }
  }
  const events = await app.events(workflow.id);
  expect(events.map(event => event.type)).toEqual(["workflow.created", "job.started", "job.succeeded", "job.started", "job.failed", "job.retrying", "job.started", "job.succeeded", "job.started", "job.succeeded", "workflow.succeeded"]);
  expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect((await app.get(`/api/workflows/${workflow.id}/events?after=4`)).events).toEqual(events.slice(4));
  expect((await app.get(`/api/workflows/${workflow.id}/events?after=9999`)).events).toEqual([]);
  for (const after of ["-1", "1.2", "abc", "", "1e2", "9007199254740992"]) expect((await app.request(`/api/workflows/${workflow.id}/events?after=${after}`)).status).toBe(400);
  expect((await app.cancel(workflow.id)).status).toBe(409);
  expect(await app.events(workflow.id)).toEqual(events);
});

test("retry exhaustion blocks transitive successors while independent work finishes", async () => {
  const app = await new Harness().start();
  const workflow = await app.create([node("bad", "fail", [], 3), node("child", "succeed", ["bad"]), node("grandchild", "succeed", ["child"]), node("independent")]);
  const done = await app.settled(workflow.id); expect(done.status).toBe("failed");
  expect(done.jobs.map(job => job.status)).toEqual(["failed", "blocked", "blocked", "succeeded"]);
  expect(done.jobs[0]!.attempts.map(attempt => attempt.status)).toEqual(["failed", "failed", "failed"]);
  expect(done.jobs[0]!.error).toContain("Synthetic worker requested failure");
  expect(done.jobs[1]!.attempts).toHaveLength(0); expect(done.jobs[2]!.attempts).toHaveLength(0);
  const events = await app.events(workflow.id);
  expect(events.filter(event => event.type === "job.retrying")).toHaveLength(2);
  expect(events.filter(event => event.type === "job.blocked")).toHaveLength(2);
  expect(events.at(-1)!.type).toBe("workflow.failed");
  expect((await app.cancel(workflow.id)).status).toBe(409);
});

test("global process capacity and per-workflow concurrency both bound actual workers, including legacy", async () => {
  const app = await new Harness(undefined, 2).start();
  const first = await app.create([node("a", "block"), node("b", "block")], 1);
  const second = await app.create([node("c", "block"), node("d", "block")], 3);
  const legacy = await (await app.request("/api/jobs", { name: "capacity", kind: "block" })).json();
  await app.started(first.jobs[0]!.id); await app.started(second.jobs[0]!.id);
  await Bun.sleep(150);
  expect(existsSync(app.marker(first.jobs[1]!.id, 1, "started.json"))).toBe(false);
  expect(existsSync(app.marker(second.jobs[1]!.id, 1, "started.json"))).toBe(false);
  expect(existsSync(app.marker(legacy.job.id, 1, "started.json"))).toBe(false);
  expect(readdirSync(join(app.directory, "markers")).filter(file => file.endsWith("started.json"))).toHaveLength(2);
  app.release(first.jobs[0]!.id); await app.started(first.jobs[1]!.id);
  expect(existsSync(app.marker(second.jobs[1]!.id, 1, "started.json"))).toBe(false);
  expect((await app.cancel(first.id)).status).toBe(200);
  await app.started(second.jobs[1]!.id);
  expect((await app.workflow(second.id)).jobs.filter(job => job.status === "running")).toHaveLength(2);
  expect((await app.cancel(second.id)).status).toBe(200);
  await app.started(legacy.job.id); app.release(legacy.job.id);
  await until(() => app.get(`/api/jobs/${legacy.job.id}`), data => data.job.status === "succeeded");
});

test("cancellation reaps only its workers, preserves completed results and emits no duplicate events", async () => {
  const app = await new Harness(undefined, 3).start();
  const workflow = await app.create([node("done"), node("running", "block", ["done"]), node("queued", "succeed", ["running"])], 1);
  const other = await app.create([node("other", "block")]);
  const child = await app.started(workflow.jobs[1]!.id), unaffected = await app.started(other.jobs[0]!.id);
  const response = await app.cancel(workflow.id); expect(response.status).toBe(200);
  const done: Workflow = (await response.json()).workflow;
  expect(done.status).toBe("cancelled"); expect(done.jobs.map(job => job.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
  expect(JSON.parse(done.jobs[0]!.result!).message).toBe("completed");
  expect(done.jobs[1]!.attempts[0]!.status).toBe("cancelled"); expect(done.jobs[1]!.attempts[0]!.finishedAt).toBeNumber();
  expect(alive(child.pid)).toBe(false); expect(alive(unaffected.pid)).toBe(true);
  expect(existsSync(app.marker(workflow.jobs[2]!.id, 1, "started.json"))).toBe(false);
  const events = await app.events(workflow.id);
  expect(events.filter(event => event.type === "job.cancelled")).toHaveLength(2); expect(events.at(-1)!.type).toBe("workflow.cancelled");
  expect((await app.cancel(workflow.id)).status).toBe(200); expect(await app.events(workflow.id)).toEqual(events);
  const otherEvents = await app.events(other.id); expect(otherEvents.every(event => !event.jobKey || event.jobKey === "other")).toBe(true);
  app.release(other.jobs[0]!.id); expect((await app.settled(other.id)).status).toBe("succeeded");
});

test("restart interrupts and recovers maxAttempts:1 without rerunning completed work", async () => {
  const app = await new Harness().start();
  const workflow = await app.create([node("done"), node("gate", "block", ["done"], 1), node("tail", "succeed", ["gate"])]);
  const old = await app.started(workflow.jobs[1]!.id);
  const before = await app.events(workflow.id);
  await app.stop(); await until(() => alive(old.pid), value => !value);
  await app.start();
  const next = await app.started(workflow.jobs[1]!.id, 2);
  expect(next.pid).not.toBe(old.pid);
  const recovered = await app.workflow(workflow.id);
  expect(recovered.jobs[0]!.attempts).toHaveLength(1);
  expect(recovered.jobs[1]!.attempts.map(attempt => attempt.status)).toEqual(["interrupted", "running"]);
  expect(recovered.jobs[1]!.attempts[0]!.finishedAt).toBeNumber();
  app.release(workflow.jobs[1]!.id, 2);
  expect((await app.settled(workflow.id)).status).toBe("succeeded");
  const events = await app.events(workflow.id); expect(events.slice(0, before.length)).toEqual(before);
  expect(events.filter(event => event.type === "job.interrupted")).toHaveLength(1);
  expect(events.at(-1)!.type).toBe("workflow.succeeded");
  await app.stop(); await app.start();
  expect(await app.events(workflow.id)).toEqual(events);
  expect((await app.workflow(workflow.id)).jobs[1]!.attempts).toHaveLength(2);
});

test("unknown workflow/job routes return 404 and independent event histories stay separate", async () => {
  const app = await new Harness().start();
  for (const path of ["/api/jobs/missing", "/api/workflows/missing", "/api/workflows/missing/events"]) expect((await app.request(path)).status).toBe(404);
  expect((await app.cancel("missing")).status).toBe(404);
  const a = await app.create([node("alpha")]), b = await app.create([node("beta", "fail")]);
  await app.settled(a.id); await app.settled(b.id);
  const aEvents = await app.events(a.id), bEvents = await app.events(b.id);
  expect(aEvents.every(event => !event.jobKey || event.jobKey === "alpha")).toBe(true);
  expect(bEvents.every(event => !event.jobKey || event.jobKey === "beta")).toBe(true);
  expect(aEvents[0]!.seq).toBe(1); expect(bEvents[0]!.seq).toBe(1);
});

test("a failed migration rolls back DDL and leaves the v1 version and rows intact", () => {
  const directory = disposable(), schemaRoot = disposable();
  mkdirSync(join(schemaRoot, "sql"));
  writeFileSync(join(schemaRoot, "sql/v1.sql"), readFileSync(join(root, "sql/v1.sql")));
  writeFileSync(join(schemaRoot, "sql/v2.sql"), "CREATE TABLE partial_migration(value TEXT); INVALID SQL;");
  const before = new Database(join(directory, "workflow.sqlite"));
  before.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  before.query("INSERT INTO jobs VALUES('kept','Kept','fail','failed',1,NULL,'old error',1,2)").run();
  before.close();
  expect(() => new Store(directory, schemaRoot)).toThrow();
  const after = new Database(join(directory, "workflow.sqlite"));
  expect(after.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe("1");
  expect(after.query("SELECT name FROM sqlite_master WHERE name='partial_migration'").get()).toBeNull();
  expect(after.query<{ error: string }, []>("SELECT error FROM jobs WHERE id='kept'").get()!.error).toBe("old error");
  after.close();
});

test("unfinished v1 running jobs recover with increasing attempts", async () => {
  const directory = disposable(), db = new Database(join(directory, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  db.query("INSERT INTO jobs VALUES('v1_running','Recover me','succeed','running',2,NULL,NULL,1,2)").run();
  db.close();
  const app = await new Harness(directory).start();
  const completed = await until(() => app.get("/api/jobs/v1_running"), value => value.job.status === "succeeded");
  expect(completed.job.attempt).toBe(3);
  expect(JSON.parse(completed.job.result).attempt).toBe(3);
  expect((await app.started("v1_running", 3)).parent).toBe(app.child.pid);
});

for (const limit of [1, 3]) test(`configured global capacity ${limit} is enforced with real blocking workers`, async () => {
  const app = await new Harness(undefined, limit).start();
  const workflow = await app.create([node("a", "block"), node("b", "block"), node("c", "block"), node("d", "block")], 3);
  for (let index = 0; index < limit; index++) await app.started(workflow.jobs[index]!.id);
  await Bun.sleep(100);
  expect((await app.workflow(workflow.id)).jobs.filter(job => job.status === "running")).toHaveLength(limit);
  expect(existsSync(app.marker(workflow.jobs[limit]!.id, 1, "started.json"))).toBe(false);
  expect((await app.cancel(workflow.id)).status).toBe(200);
});

test("cancel before dispatch never starts queued jobs; concurrent idempotency requests create once", async () => {
  const app = await new Harness(undefined, 1).start();
  const occupied = await app.create([node("occupied", "block")]); await app.started(occupied.jobs[0]!.id);
  const payload = { name: "Queued", concurrency: 3, jobs: [{ key: "queued", name: " Queued node ", kind: "succeed" }] };
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.request("/api/workflows", payload, "parallel-key")));
  expect(responses.map(response => response.status).sort()).toEqual([200, 200, 200, 200, 201]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  const workflow: Workflow = bodies[0].workflow;
  expect(new Set(bodies.map(body => body.workflow.id)).size).toBe(1);
  expect(workflow.jobs[0]!.maxAttempts).toBe(1); expect(workflow.jobs[0]!.dependsOn).toEqual([]); expect(workflow.jobs[0]!.name).toBe("Queued node");
  expect((await app.cancel(workflow.id)).status).toBe(200);
  expect((await app.events(workflow.id)).map(event => event.type)).toEqual(["workflow.created", "job.cancelled", "workflow.cancelled"]);
  app.release(occupied.jobs[0]!.id); await app.settled(occupied.id); await Bun.sleep(100);
  expect((await app.workflow(workflow.id)).jobs[0]!.attempts).toHaveLength(0);
  expect(existsSync(app.marker(workflow.jobs[0]!.id, 1, "started.json"))).toBe(false);
});
