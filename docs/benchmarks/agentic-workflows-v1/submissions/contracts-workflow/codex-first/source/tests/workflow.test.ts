import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "../server/store";

type Workflow = NonNullable<ReturnType<Store["workflow"]>>;
const root = resolve(import.meta.dir, "..");
const delay = () => Bun.sleep(25);
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, description = "condition"): Promise<T> {
  const deadline = Date.now() + 8000;
  let latest: T;
  do {
    latest = await read();
    if (accept(latest)) return latest;
    await delay();
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest)}`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const node = (key: string, kind = "succeed", dependsOn: string[] = [], maxAttempts = 1) =>
  ({ key, name: key, kind, dependsOn, maxAttempts });
const definition = (jobs = [node("one")], concurrency = 2, name = "Integration workflow") => ({ name, concurrency, jobs });

class App {
  directory = mkdtempSync(join(tmpdir(), "workflow-runner-test-"));
  child?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  base = "";
  log = "";
  async start(limit = 2) {
    this.log = "";
    this.child = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PORT: "0", DATA_DIR: this.directory, WORKFLOW_CONCURRENCY: String(limit),
        WORKFLOW_MARKER_DIR: join(this.directory, "markers"), WORKFLOW_WORKER_PATH: join(root, "server/worker.ts") },
    });
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.log += decoder.decode(value, { stream: true });
      }
    };
    void consume(this.child.stdout); void consume(this.child.stderr);
    await until(() => this.log, log => /listening on http:\/\/127\.0\.0\.1:\d+/.test(log), "startup");
    this.base = this.log.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    expect((await this.request("/api/health")).body).toEqual({ ok: true, schemaVersion: 2 });
  }
  async request(path: string, body?: unknown, key?: string, method?: string) {
    const response = await fetch(this.base + path, { method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async create(input = definition(), key: string = crypto.randomUUID()) {
    const response = await this.request("/api/workflows", input, key);
    expect(response.status).toBe(201);
    return response.body.workflow as Workflow;
  }
  async workflow(id: string): Promise<Workflow> { return (await this.request("/api/workflows/" + id)).body.workflow; }
  async wait(id: string, check: (workflow: Workflow) => boolean) { return until(() => this.workflow(id), check, "workflow transition"); }
  async events(id: string) { return (await this.request(`/api/workflows/${id}/events?after=0`)).body.events as { seq: number; type: string; jobKey?: string; attempt?: number }[]; }
  async cancel(id: string) { return this.request(`/api/workflows/${id}/cancel`, undefined, undefined, "POST"); }
  marker(jobId: string, attempt: number, suffix = "started.json") { return join(this.directory, "markers", `${jobId}.${attempt}.${suffix}`); }
  release(jobId: string, attempt = 1) { writeFileSync(this.marker(jobId, attempt, "release"), "release from integration test"); }
  async evidence(jobId: string, attempt = 1) {
    await until(() => existsSync(this.marker(jobId, attempt)), Boolean, "worker evidence");
    return JSON.parse(readFileSync(this.marker(jobId, attempt), "utf8"));
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGKILL"); await this.child.exited;
  }
  async dispose() {
    await this.stop();
    // The fixture notices its missing parent itself, including on Windows.
    await Bun.sleep(150);
    const target = resolve(this.directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("workflow-runner-test-"))
      throw new Error("Refusing cleanup outside this test's temporary directory.");
    rmSync(target, { recursive: true, force: true });
  }
}

test("startup migrates a v1 database exactly and legacy HTTP jobs still execute", async () => {
  const app = new App();
  const database = new Database(join(app.directory, "workflow.sqlite"));
  database.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  const old = { id: "legacy-complete", name: "Old completed", kind: "succeed", status: "succeeded", attempt: 7,
    result: "preserved result", error: null, created_at: 123, updated_at: 456 };
  database.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(old));
  database.query("INSERT INTO jobs VALUES('legacy-failed','Old failed','fail','failed',1,NULL,'old error',124,457)").run();
  database.close();
  try {
    await app.start();
    expect((await app.request("/api/jobs/legacy-complete")).body.job).toEqual(old);
    expect((await app.request("/api/jobs")).body.jobs).toHaveLength(2);
    for (const kind of ["succeed", "fail", "fail_once"]) {
      const response = await app.request("/api/jobs", { name: "New " + kind, kind });
      expect(response.status).toBe(201);
      const job = await until(async () => (await app.request("/api/jobs/" + response.body.job.id)).body.job,
        job => ["succeeded", "failed"].includes(job.status));
      expect(job.attempt).toBe(1);
      expect(job.status).toBe(kind === "succeed" ? "succeeded" : "failed");
      if (kind === "succeed") expect(JSON.parse(job.result).jobId).toBe(job.id);
      else expect(job.error).toContain("Synthetic worker");
      const evidence = await app.evidence(job.id);
      expect(evidence.parent).toBe(app.child!.pid);
    }
    await app.stop(); await app.start();
    expect((await app.request("/api/jobs/legacy-complete")).body.job).toEqual(old);
    expect((await app.request("/api/jobs/legacy-failed")).body.job.error).toBe("old error");
    expect(existsSync(app.marker(old.id, 8))).toBe(false);
    expect((await app.request("/api/jobs/missing")).status).toBe(404);
    expect((await app.request("/api/jobs", { name: [], kind: "succeed" })).status).toBe(400);
  } finally { await app.dispose(); }
}, 20000);

test("validation is atomic; canonical idempotency and event cursors survive restart", async () => {
  const app = new App();
  try {
    await app.start();
    const invalid: unknown[] = [null, [], {}, definition([], 2), definition([node("one")], 0),
      definition([node("one")], 4), definition([node("one")], 1.5), definition([node("one")], 2, " "),
      definition([node("one")], 2, "x".repeat(121)), definition([node("one"), node("one")]),
      definition([node("1bad")]), definition([node("bad.key")]), definition([node("one", "unknown")]),
      definition([node("one", "succeed", ["missing"])]), definition([node("one", "succeed", ["one"])]),
      definition([node("a", "succeed", ["b"]), node("b", "succeed", ["a"])]),
      definition([node("a"), node("b", "succeed", ["a", "a"])]),
      definition([node("one", "succeed", [], 0)]), definition([node("one", "succeed", [], 4)]),
      definition([{ ...node("one"), dependsOn: null } as never]),
      definition([{ ...node("one"), maxAttempts: "2" } as never]),
      definition([{ ...node("one"), name: false } as never]),
      definition(Array.from({ length: 41 }, (_, index) => node("j" + index)))];
    for (const body of invalid) expect((await app.request("/api/workflows", body, "reusable")).status).toBe(400);
    for (const key of [undefined, "", "x".repeat(129)])
      expect((await app.request("/api/workflows", definition(), key)).status).toBe(400);
    const malformed = await fetch(app.base + "/api/workflows", { method: "POST", headers: { "Idempotency-Key": "reusable" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await app.request("/api/workflows")).body.workflows).toEqual([]);
    const database = new Database(join(app.directory, "workflow.sqlite"));
    for (const table of ["workflows", "jobs", "nodes", "events", "attempts", "idempotency"])
      expect(database.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
    database.close();
    const input = definition([node("hold", "block"), node("next", "succeed", ["hold"])]);
    const created = await app.create(input, "reusable");
    await app.wait(created.id, workflow => workflow.jobs[0].status === "running");
    await app.evidence(created.jobs[0].id);
    const history = await app.events(created.id);
    const reordered = { jobs: input.jobs.map(job => ({ maxAttempts: job.maxAttempts, dependsOn: job.dependsOn,
      kind: job.kind, name: job.name, key: job.key })), concurrency: input.concurrency, name: input.name };
    const replay = await app.request("/api/workflows", reordered, "reusable");
    expect(replay.status).toBe(200); expect(replay.body.replayed).toBe(true); expect(replay.body.workflow.id).toBe(created.id);
    expect(await app.events(created.id)).toEqual(history);
    expect((await app.request("/api/workflows", { ...input, jobs: input.jobs.slice().reverse() }, "reusable")).status).toBe(409);
    expect((await app.request("/api/workflows", { ...input, name: "different" }, "reusable")).status).toBe(409);
    for (const cursor of ["-1", "1.5", "NaN", "", "1e2"])
      expect((await app.request(`/api/workflows/${created.id}/events?after=${cursor}`)).status).toBe(400);
    expect((await app.request(`/api/workflows/${created.id}/events?after=99999`)).body.events).toEqual([]);
    expect((await app.request(`/api/workflows/${created.id}/events?after=9007199254740992`)).body.events).toEqual([]);
    expect((await app.request(`/api/workflows/${created.id}/events?after=1`)).body.events).toEqual(history.filter(event => event.seq > 1));
    expect((await app.request("/api/workflows/missing")).status).toBe(404);
    expect((await app.request("/api/workflows/missing/events")).status).toBe(404);
    expect((await app.cancel("missing")).status).toBe(404);
    await app.cancel(created.id);
    const settledEvents = await app.events(created.id);
    await app.stop(); await app.start();
    expect((await app.request("/api/workflows", reordered, "reusable")).body.workflow.id).toBe(created.id);
    expect(await app.events(created.id)).toEqual(settledEvents);
  } finally { await app.dispose(); }
}, 20000);

test("DAG ordering, real stdout, retries, exhaustion and downstream blocking", async () => {
  const app = new App();
  try {
    await app.start();
    const workflow = await app.create(definition([node("lint", "block"), node("test", "fail_once", ["lint"], 2),
      node("publish", "succeed", ["test"])]));
    const running = await app.wait(workflow.id, value => value.jobs[0].status === "running");
    const evidence = await app.evidence(workflow.jobs[0].id);
    expect(running.jobs[0].attempts[0].pid).toBe(evidence.pid);
    expect(running.jobs[0].attempts[0].finishedAt).toBe(null);
    expect(alive(evidence.pid)).toBe(true);
    await Bun.sleep(150);
    expect((await app.workflow(workflow.id)).jobs[1].attempts).toEqual([]);
    app.release(workflow.jobs[0].id);
    const done = await app.wait(workflow.id, value => value.status === "succeeded");
    expect(done.jobs[1].attempts.map(attempt => attempt.status)).toEqual(["failed", "succeeded"]);
    for (const job of done.jobs) {
      expect(JSON.parse(job.result!).jobId).toBe(job.id);
      expect(job.error).toBe(null);
      for (const attempt of job.attempts) {
        const proof = await app.evidence(job.id, attempt.number);
        expect(attempt.pid).toBe(proof.pid);
        expect(proof.parent).toBe(app.child!.pid);
        expect(attempt.finishedAt).toBeGreaterThanOrEqual(attempt.startedAt);
        expect(alive(proof.pid)).toBe(false);
      }
    }
    expect(done.jobs[1].attempts[0].startedAt).toBeGreaterThanOrEqual(done.jobs[0].attempts[0].finishedAt!);
    const events = await app.events(done.id);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map(event => event.type)).toContain("job.retrying");
    expect(events.at(-1)!.type).toBe("workflow.succeeded");
    expect((await app.cancel(done.id)).status).toBe(409);
    const failing = await app.create(definition([node("bad", "fail", [], 3), node("blocked", "succeed", ["bad"]),
      node("also_blocked", "succeed", ["blocked"]), node("independent")]));
    const failed = await app.wait(failing.id, value => value.status === "failed");
    expect(failed.jobs.map(job => job.status)).toEqual(["failed", "blocked", "blocked", "succeeded"]);
    expect(failed.jobs[0].attempts.map(attempt => attempt.status)).toEqual(["failed", "failed", "failed"]);
    expect(failed.jobs[0].error).toContain("Synthetic worker requested failure");
    expect(failed.jobs[1].attempts).toEqual([]);
    expect(existsSync(app.marker(failed.jobs[1].id, 1))).toBe(false);
    const failureEvents = await app.events(failed.id);
    expect(failureEvents.filter(event => event.type === "job.failed")).toHaveLength(3);
    expect(failureEvents.filter(event => event.type === "job.retrying")).toHaveLength(2);
    expect(failureEvents.filter(event => event.type === "job.blocked")).toHaveLength(2);
    expect(failureEvents.at(-1)!.type).toBe("workflow.failed");
    expect(events.every(event => !["bad", "blocked", "independent"].includes(event.jobKey ?? ""))).toBe(true);
    expect((await app.cancel(failed.id)).status).toBe(409);
    expect(await app.events(failed.id)).toEqual(failureEvents);
  } finally { await app.dispose(); }
}, 20000);

test("global worker bound and per-workflow bound hold across independent workflows", async () => {
  const app = new App();
  try {
    await app.start(2);
    const a = await app.create(definition([node("a1", "block"), node("a2", "block"), node("a3", "block")], 1, "A"));
    const b = await app.create(definition([node("b1", "block"), node("b2", "block"), node("b3", "block")], 3, "B"));
    await app.wait(a.id, workflow => workflow.jobs[0].status === "running");
    await app.wait(b.id, workflow => workflow.jobs[0].status === "running");
    const sample = async () => {
      const states = await Promise.all([app.workflow(a.id), app.workflow(b.id)]);
      const running = states.flatMap(value => value.jobs).filter(job => job.status === "running");
      expect(running).toHaveLength(2);
      expect(states[0].jobs.filter(job => job.status === "running")).toHaveLength(1);
      for (const job of running) {
        const evidence = await app.evidence(job.id);
        expect(alive(evidence.pid)).toBe(true);
      }
      return states;
    };
    await sample(); await Bun.sleep(150); await sample();
    expect(existsSync(app.marker(a.jobs[1].id, 1))).toBe(false);
    expect(existsSync(app.marker(b.jobs[1].id, 1))).toBe(false);
    app.release(b.jobs[0].id);
    await app.wait(b.id, workflow => workflow.jobs[1].status === "running");
    await sample();
    app.release(a.jobs[0].id);
    await app.wait(a.id, workflow => workflow.jobs[1].status === "running");
    await sample();
    await app.cancel(a.id); await app.cancel(b.id);
  } finally { await app.dispose(); }
}, 20000);

for (const limit of [1, 3]) test(`global concurrency ${limit} bounds real live workers`, async () => {
  const app = new App();
  try {
    await app.start(limit);
    const workflow = await app.create(definition([node("a", "block"), node("b", "block"), node("c", "block"), node("d", "block")], 3));
    const running = await app.wait(workflow.id, value => value.jobs.filter(job => job.status === "running").length === limit);
    await Bun.sleep(100);
    expect((await app.workflow(workflow.id)).jobs.filter(job => job.status === "running")).toHaveLength(limit);
    for (const job of running.jobs.filter(job => job.status === "running")) expect(alive((await app.evidence(job.id)).pid)).toBe(true);
    expect(running.jobs.filter(job => job.status === "queued")).toHaveLength(4 - limit);
    await app.cancel(workflow.id);
  } finally { await app.dispose(); }
}, 20000);

test("cancel reaps only its own workers, preserves results and is idempotent", async () => {
  const app = new App();
  try {
    await app.start();
    const workflow = await app.create(definition([node("done"), node("hold", "block", ["done"]), node("queued", "block", ["hold"])]));
    const other = await app.create(definition([node("other", "block")]));
    const running = await app.wait(workflow.id, value => value.jobs[1].status === "running");
    await app.wait(other.id, value => value.jobs[0].status === "running");
    const pid = (await app.evidence(workflow.jobs[1].id)).pid;
    const otherPid = (await app.evidence(other.jobs[0].id)).pid;
    const responses = await Promise.all([app.cancel(workflow.id), app.cancel(workflow.id)]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const cancelled = responses[0].body.workflow as Workflow;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.jobs.map(job => job.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect(cancelled.jobs[0].result).toBe(running.jobs[0].result);
    expect(cancelled.jobs[1].attempts[0].status).toBe("cancelled");
    expect(cancelled.jobs[1].attempts[0].finishedAt).not.toBeNull();
    expect(cancelled.jobs[2].attempts).toEqual([]);
    expect(alive(pid)).toBe(false); expect(alive(otherPid)).toBe(true);
    const events = await app.events(workflow.id);
    expect(events.filter(event => event.type === "workflow.cancelled")).toHaveLength(1);
    expect(events.filter(event => event.type === "job.cancelled")).toHaveLength(2);
    await app.cancel(workflow.id); expect(await app.events(workflow.id)).toEqual(events);
    await Bun.sleep(100); expect(existsSync(app.marker(workflow.jobs[2].id, 1))).toBe(false);
    app.release(other.jobs[0].id); await app.wait(other.id, value => value.status === "succeeded");
  } finally { await app.dispose(); }
}, 20000);

test("crash recovery retains attempts, retries maxAttempts 1 and never reruns completed nodes", async () => {
  const app = new App();
  try {
    await app.start();
    const input = definition([node("done"), node("hold", "block", ["done"]), node("after", "succeed", ["hold"])]);
    const workflow = await app.create(input, "durable-key");
    const before = await app.wait(workflow.id, value => value.jobs[1].status === "running");
    const oldPid = (await app.evidence(workflow.jobs[1].id)).pid;
    const beforeEvents = await app.events(workflow.id);
    await app.stop();
    await until(() => alive(oldPid), value => !value, "old worker exits with parent");
    await app.start();
    const recovered = await app.wait(workflow.id, value => value.jobs[1].attempts.length === 2 && value.jobs[1].status === "running");
    expect(recovered.jobs[0]).toEqual(before.jobs[0]);
    expect(recovered.jobs[1].attempts.map(attempt => attempt.status)).toEqual(["interrupted", "running"]);
    expect(recovered.jobs[1].attempts[0].finishedAt).not.toBeNull();
    expect(recovered.jobs[1].attempts[0].pid).toBe(oldPid);
    expect(recovered.jobs[1].attempts[1].finishedAt).toBeNull();
    await app.evidence(workflow.jobs[1].id, 2);
    app.release(workflow.jobs[1].id, 2);
    const done = await app.wait(workflow.id, value => value.status === "succeeded");
    expect(done.jobs[1].attempts.map(attempt => attempt.status)).toEqual(["interrupted", "succeeded"]);
    expect(existsSync(app.marker(workflow.jobs[0].id, 2))).toBe(false);
    const events = await app.events(workflow.id);
    expect(events.slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect(events.map(event => event.type)).toContain("job.interrupted");
    expect(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq)).toBe(true);
    await app.stop(); await app.start();
    expect((await app.request("/api/workflows", input, "durable-key")).body.replayed).toBe(true);
    expect(await app.workflow(workflow.id)).toEqual(done);
    expect(await app.events(workflow.id)).toEqual(events);
  } finally { await app.dispose(); }
}, 20000);
