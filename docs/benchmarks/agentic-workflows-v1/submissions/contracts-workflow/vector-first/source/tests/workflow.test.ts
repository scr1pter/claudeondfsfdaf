import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Attempt = { number: number; status: string; pid: number; startedAt: number; finishedAt: number | null };
type Job = { id: string; key: string; status: string; attempts: Attempt[]; result: string | null; error: string | null };
type Workflow = { id: string; name: string; status: string; jobs: Job[] };
type Event = { seq: number; type: string; jobKey: string | null; attempt: number | null };
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await Bun.sleep(25);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
class Harness {
  directory = mkdtempSync(join(tmpdir(), "workflow-runner-test-"));
  child?: ReturnType<typeof Bun.spawn>;
  base = "";
  async start() {
    const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = socket.port!;
    await socket.stop(true);
    this.base = `http://127.0.0.1:${port}`;
    this.child = Bun.spawn([process.execPath, join(root, "server/index.ts")], {
      cwd: root, stdout: "ignore", stderr: "inherit",
      env: { ...process.env, DATA_DIR: this.directory, PORT: String(port), WORKFLOW_CONCURRENCY: "2",
        WORKFLOW_MARKER_DIR: join(this.directory, "markers"), WORKFLOW_WORKER_PATH: join(root, "server/worker.ts") }
    });
    await until(async () => {
      if (this.child?.exitCode !== null) throw new Error(`Server exited ${this.child?.exitCode}`);
      try { return await (await fetch(this.base + "/api/health")).json(); } catch { return null; }
    }, value => value?.schemaVersion === 2);
  }
  async stop(crash = false) {
    if (!this.child) return;
    this.child.kill(crash ? "SIGKILL" : "SIGTERM");
    await this.child.exited;
    this.child = undefined;
  }
  async close() { await this.stop(); await Bun.sleep(100); rmSync(this.directory, { recursive: true, force: true }); }
  async request(path: string, body?: unknown, key?: string, method?: string) {
    return fetch(this.base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async create(jobs: unknown[], concurrency = 2, key = crypto.randomUUID(), name = "Integration workflow") {
    const response = await this.request("/api/workflows", { name, concurrency, jobs }, key);
    expect(response.status).toBe(201);
    return (await response.json()).workflow as Workflow;
  }
  async get(id: string) { return (await (await this.request(`/api/workflows/${id}`)).json()).workflow as Workflow; }
  async events(id: string, after = 0) { return (await (await this.request(`/api/workflows/${id}/events?after=${after}`)).json()).events as Event[]; }
  wait(id: string, accept: (workflow: Workflow) => boolean) { return until(() => this.get(id), accept); }
  marker(job: Job, attempt: number, suffix = "started.json") { return join(this.directory, "markers", `${job.id}.${attempt}.${suffix}`); }
  async started(job: Job, attempt = 1) { await until(() => existsSync(this.marker(job, attempt)), Boolean); }
  release(job: Job, attempt = 1) { writeFileSync(this.marker(job, attempt, "release"), "release from integration test"); }
}
const node = (key: string, kind = "succeed", extra: Record<string, unknown> = {}) => ({ key, name: key, kind, ...extra });

test("startup migrates real v1 data without rewriting or rerunning completed jobs; legacy API stays usable", async () => {
  const h = new Harness();
  try {
    const db = new Database(join(h.directory, "workflow.sqlite"));
    db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
    db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-completed", "Old completed", "succeed", "succeeded", 7, "original result", "original error", 11, 22);
    db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-pending", "Old pending", "succeed", "queued", 0, null, null, 33, 33);
    const original = db.query("SELECT * FROM jobs WHERE id='legacy-completed'").get();
    db.close();
    await h.start();
    expect((await (await h.request("/api/jobs/legacy-completed")).json()).job).toEqual(original);
    await until(async () => (await (await h.request("/api/jobs/legacy-pending")).json()).job.status, status => status === "succeeded");
    const response = await h.request("/api/jobs", { name: "New legacy", kind: "succeed" });
    expect(response.status).toBe(201);
    const created = (await response.json()).job;
    await until(async () => (await (await h.request(`/api/jobs/${created.id}`)).json()).job.status, status => status === "succeeded");
    expect((await (await h.request("/api/jobs")).json()).jobs).toHaveLength(3);
    expect((await (await h.request("/api/workflows")).json()).workflows).toHaveLength(0);
    await h.stop(); await h.start();
    expect((await (await h.request("/api/jobs/legacy-completed")).json()).job).toEqual(original);
    expect(existsSync(join(h.directory, "markers", "legacy-completed.8.started.json"))).toBe(false);
    const migrated = new Database(join(h.directory, "workflow.sqlite"), { readonly: true });
    expect(migrated.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe("2");
    migrated.close();
  } finally { await h.close(); }
}, 20000);

test("validation is atomic; idempotency canonicalizes objects and survives restart; cursors and terminal cancellation are strict", async () => {
  const h = new Harness();
  try {
    await h.start();
    const valid = { name: "Validation", concurrency: 2, jobs: [node("one")] };
    const invalid = [null, [], {}, { ...valid, name: " " }, { ...valid, name: "x".repeat(121) },
      { ...valid, concurrency: "2" }, { ...valid, concurrency: 4 }, { ...valid, jobs: [] },
      { ...valid, concurrency: 1.5 }, { ...valid, jobs: "not an array" },
      { ...valid, jobs: Array.from({ length: 41 }, (_, i) => node(`j${i}`)) },
      { ...valid, jobs: [node("1bad")] }, { ...valid, jobs: [node("a"), node("a")] },
      { ...valid, jobs: [node("a", "unknown")] }, { ...valid, jobs: [node("a", "succeed", { maxAttempts: 0 })] },
      { ...valid, jobs: [node("a", "succeed", { maxAttempts: "2" })] },
      { ...valid, jobs: [node("a", "succeed", { name: false })] },
      { ...valid, jobs: [node("a", "succeed", { dependsOn: null })] },
      { ...valid, jobs: [node("a", "succeed", { dependsOn: [7] })] },
      { ...valid, jobs: [node("a", "succeed", { dependsOn: ["missing"] })] },
      { ...valid, jobs: [node("a", "succeed", { dependsOn: ["a"] })] },
      { ...valid, jobs: [node("a"), node("b", "succeed", { dependsOn: ["a", "a"] })] },
      { ...valid, jobs: [node("a", "succeed", { dependsOn: ["b"] }), node("b", "succeed", { dependsOn: ["a"] })] }];
    for (const input of invalid) expect((await h.request("/api/workflows", input, "reuse-after-invalid")).status).toBe(400);
    expect((await h.request("/api/workflows", valid)).status).toBe(400);
    expect((await h.request("/api/workflows", valid, "x".repeat(129))).status).toBe(400);
    expect((await fetch(h.base + "/api/workflows", { method: "POST", headers: { "Idempotency-Key": "malformed" }, body: "{" })).status).toBe(400);
    expect((await (await h.request("/api/workflows")).json()).workflows).toHaveLength(0);
    const response = await h.request("/api/workflows", valid, "reuse-after-invalid");
    expect(response.status).toBe(201);
    const workflow = (await response.json()).workflow;
    await h.wait(workflow.id, workflow => workflow.status === "succeeded");
    const events = await h.events(workflow.id);
    expect(events.map(event => event.type)).toEqual(["workflow.created", "job.started", "job.succeeded", "workflow.succeeded"]);
    const replayBody = { jobs: [{ kind: "succeed", name: "one", key: "one" }], concurrency: 2, name: "Validation" };
    const replay = await h.request("/api/workflows", replayBody, "reuse-after-invalid");
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    expect((await h.request("/api/workflows", { ...valid, name: "Different" }, "reuse-after-invalid")).status).toBe(409);
    expect((await h.request(`/api/workflows/${workflow.id}/cancel`, undefined, undefined, "POST")).status).toBe(409);
    expect(await h.events(workflow.id)).toEqual(events);
    expect(await h.events(workflow.id, 99999)).toEqual([]);
    expect((await h.events(workflow.id, 2)).map(event => event.seq)).toEqual([3, 4]);
    for (const after of ["-1", "1.5", "no", "", "1e2", "9007199254740992"])
      expect((await h.request(`/api/workflows/${workflow.id}/events?after=${after}`)).status).toBe(400);
    for (const path of ["/api/workflows/missing", "/api/workflows/missing/events", "/api/jobs/missing"])
      expect((await h.request(path)).status).toBe(404);
    expect((await h.request("/api/workflows/missing/cancel", undefined, undefined, "POST")).status).toBe(404);
    await h.stop(); await h.start();
    const persistent = await h.request("/api/workflows", replayBody, "reuse-after-invalid");
    expect(persistent.status).toBe(200);
    expect((await persistent.json()).workflow.id).toBe(workflow.id);
    expect(await h.events(workflow.id)).toEqual(events);
  } finally { await h.close(); }
}, 20000);

test("real dependency ordering, retry success/exhaustion, cascading blocking and independent work", async () => {
  const h = new Harness();
  try {
    await h.start();
    const workflow = await h.create([node("root", "block"), node("retry", "fail_once", { dependsOn: ["root"], maxAttempts: 2 }),
      node("failure", "fail", { dependsOn: ["root"], maxAttempts: 3 }), node("blocked", "succeed", { dependsOn: ["failure"] }),
      node("descendant", "succeed", { dependsOn: ["blocked"] }), node("independent", "block")]);
    const rootJob = workflow.jobs[0], independent = workflow.jobs[5];
    await h.started(rootJob); await h.started(independent);
    expect(existsSync(h.marker(workflow.jobs[1], 1))).toBe(false);
    h.release(rootJob);
    await h.wait(workflow.id, workflow => workflow.jobs[2].status === "failed" && workflow.jobs[1].status === "succeeded");
    expect((await h.get(workflow.id)).status).toBe("running");
    h.release(independent);
    const settled = await h.wait(workflow.id, workflow => workflow.status === "failed");
    expect(settled.jobs.map(job => job.status)).toEqual(["succeeded", "succeeded", "failed", "blocked", "blocked", "succeeded"]);
    expect(settled.jobs[1].attempts.map(attempt => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(settled.jobs[2].attempts.map(attempt => attempt.status)).toEqual(["failed", "failed", "failed"]);
    expect(settled.jobs[2].error).toContain("failure");
    expect(JSON.parse(settled.jobs[1].result!).jobId).toBe(settled.jobs[1].id);
    expect(settled.jobs[3].attempts).toHaveLength(0);
    expect(settled.jobs[4].attempts).toHaveLength(0);
    expect(settled.jobs[1].attempts[0].startedAt).toBeGreaterThanOrEqual(settled.jobs[0].attempts[0].finishedAt!);
    for (const job of settled.jobs) for (const attempt of job.attempts) {
      const evidence = JSON.parse(readFileSync(h.marker(job, attempt.number), "utf8"));
      expect(evidence.pid).toBe(attempt.pid);
      expect(evidence.parent).toBe(h.child!.pid);
      expect(attempt.finishedAt).not.toBeNull();
    }
    const events = await h.events(workflow.id);
    expect(events.filter(event => event.type === "job.retrying")).toHaveLength(3);
    expect(events.filter(event => event.type === "job.blocked")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("workflow.failed");
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  } finally { await h.close(); }
}, 20000);

test("global/per-workflow bounds, cancellation reaps only owned workers and never dispatches queued work", async () => {
  const h = new Harness();
  try {
    await h.start();
    const first = await h.create([node("a", "block"), node("b", "block")], 1);
    await h.started(first.jobs[0]);
    const second = await h.create([node("c", "block"), node("d", "block")], 3);
    await h.started(second.jobs[0]);
    await Bun.sleep(150);
    const a = await h.get(first.id), b = await h.get(second.id);
    expect(a.jobs.filter(job => job.status === "running")).toHaveLength(1);
    expect(b.jobs.filter(job => job.status === "running")).toHaveLength(1);
    const pid = a.jobs[0].attempts[0].pid;
    expect(alive(pid)).toBe(true);
    const cancel = await h.request(`/api/workflows/${first.id}/cancel`, undefined, undefined, "POST");
    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json()).workflow as Workflow;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.jobs.map(job => job.status)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled.jobs[0].attempts[0].status).toBe("cancelled");
    expect(cancelled.jobs[0].attempts[0].finishedAt).not.toBeNull();
    expect(alive(pid)).toBe(false);
    const events = await h.events(first.id);
    await h.request(`/api/workflows/${first.id}/cancel`, undefined, undefined, "POST");
    expect(await h.events(first.id)).toEqual(events);
    await h.started(second.jobs[1]);
    expect((await h.get(second.id)).status).toBe("running");
    expect((await h.events(second.id)).some(event => event.type === "workflow.cancelled")).toBe(false);
    expect(existsSync(h.marker(first.jobs[1], 1))).toBe(false);
    const running = await h.get(second.id);
    h.release(second.jobs[0]); h.release(second.jobs[1]);
    await h.wait(second.id, workflow => workflow.status === "succeeded");
    for (const job of running.jobs) expect(alive(job.attempts[0].pid)).toBe(false);
    expect((await h.get(first.id)).jobs[1].attempts).toHaveLength(0);
  } finally { await h.close(); }
}, 20000);

test("crash recovery interrupts unfinished attempts without consuming maxAttempts:1 and preserves completed results/events", async () => {
  const h = new Harness();
  try {
    await h.start();
    const input = { name: "Recovery", concurrency: 2, jobs: [node("finished"), node("held", "block", { maxAttempts: 1 }), node("after", "succeed", { dependsOn: ["held"] })] };
    const response = await h.request("/api/workflows", input, "recovery-key");
    const workflow = (await response.json()).workflow as Workflow;
    const running = await h.wait(workflow.id, workflow => workflow.jobs[0].status === "succeeded" && workflow.jobs[1].status === "running");
    await h.started(running.jobs[1]);
    const beforeEvents = await h.events(workflow.id);
    const oldPid = running.jobs[1].attempts[0].pid;
    await h.stop(true);
    await until(() => alive(oldPid), value => !value);
    await h.start();
    const recovered = await h.wait(workflow.id, workflow => workflow.jobs[1].attempts.length === 2);
    await h.started(recovered.jobs[1], 2);
    expect(recovered.jobs[1].attempts[0].status).toBe("interrupted");
    expect(recovered.jobs[1].attempts[0].finishedAt).not.toBeNull();
    expect(recovered.jobs[0].result).toBe(running.jobs[0].result);
    expect(recovered.jobs[0].attempts).toHaveLength(1);
    expect(recovered.jobs[2].attempts).toHaveLength(0);
    h.release(recovered.jobs[1], 2);
    const finished = await h.wait(workflow.id, workflow => workflow.status === "succeeded");
    expect(finished.jobs[1].attempts.map(attempt => attempt.status)).toEqual(["interrupted", "succeeded"]);
    const events = await h.events(workflow.id);
    expect(events.slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect(events.filter(event => event.type === "job.interrupted")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("workflow.succeeded");
    expect((await h.request("/api/workflows", input, "recovery-key")).status).toBe(200);
    await h.stop(); await h.start();
    await Bun.sleep(150);
    expect(await h.events(workflow.id)).toEqual(events);
    expect((await h.get(workflow.id)).jobs[1].attempts).toHaveLength(2);
  } finally { await h.close(); }
}, 20000);

test("simultaneous cancels preserve completed results; running replays do not execute twice and job array order is significant", async () => {
  const h = new Harness();
  try {
    await h.start();
    const input = { name: "Cancellation edges", concurrency: 1, jobs: [node("done"), node("held", "block"), node("queued")] };
    const created = await h.request("/api/workflows", input, "cancel-edges");
    const workflow = (await created.json()).workflow as Workflow;
    const running = await h.wait(workflow.id, value => value.jobs[1].status === "running");
    await h.started(running.jobs[1]);
    const before = await h.events(workflow.id);
    expect((await h.request("/api/workflows", input, "cancel-edges")).status).toBe(200);
    expect(await h.events(workflow.id)).toEqual(before);
    expect((await h.request("/api/workflows", { ...input, jobs: [...input.jobs].reverse() }, "cancel-edges")).status).toBe(409);
    const responses = await Promise.all(Array.from({ length: 3 }, () => h.request(`/api/workflows/${workflow.id}/cancel`, undefined, undefined, "POST")));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    const cancelled = await h.get(workflow.id);
    expect(cancelled.jobs[0]).toEqual(running.jobs[0]);
    expect(cancelled.jobs.map(job => job.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect(cancelled.jobs[2].attempts).toHaveLength(0);
    expect(existsSync(h.marker(cancelled.jobs[2], 1))).toBe(false);
    const events = await h.events(workflow.id);
    expect(events.filter(event => event.type === "workflow.cancelled")).toHaveLength(1);
    expect(events.filter(event => event.type === "job.cancelled")).toHaveLength(2);
  } finally { await h.close(); }
}, 20000);
