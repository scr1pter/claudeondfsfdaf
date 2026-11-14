import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
type Attempt = { number: number; status: string; pid: number; startedAt: number; finishedAt: number | null };
type Job = { id: string; key: string; status: string; result: string | null; error: string | null; attempts: Attempt[] };
type Workflow = { id: string; status: string; jobs: Job[] };
type Event = { seq: number; type: string; jobKey?: string; attempt?: number };
const servers: { stop(): Promise<void> }[] = [];
const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), "workflow-test-")); directories.push(value); return value; };
async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do { last = await read(); if (predicate(last)) return last; await Bun.sleep(25); } while (Date.now() < end);
  throw new Error("Timed out waiting for state: " + JSON.stringify(last!));
}
async function start(data = directory(), concurrency = 2) {
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PORT: "0", DATA_DIR: data, WORKFLOW_CONCURRENCY: String(concurrency),
      WORKFLOW_WORKER_PATH: join(root, "server/worker.ts"), WORKFLOW_MARKER_DIR: join(data, "markers") },
  });
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let output = "";
  const ready = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Server exited: " + await errors);
      output += new TextDecoder().decode(chunk.value);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) return match[0];
    }
  })();
  let timer: ReturnType<typeof setTimeout>;
  const url = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Server readiness timeout")), 8000); })])
    .finally(() => clearTimeout(timer));
  let stopped = false;
  const server = {
    data, child, url,
    async request(path: string, body?: unknown, key?: string, method?: string) {
      const response = await fetch(url + path, { method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { "Content-Type": "application/json", ...(key !== undefined ? { "Idempotency-Key": key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() as any };
    },
    async workflow(id: string): Promise<Workflow> { return (await this.request("/api/workflows/" + id)).data.workflow; },
    async events(id: string): Promise<Event[]> { return (await this.request("/api/workflows/" + id + "/events")).data.events; },
    async create(jobs: unknown[], concurrency = 2, key = crypto.randomUUID(), name = "Checks"): Promise<Workflow> {
      const response = await this.request("/api/workflows", { name, concurrency, jobs }, key);
      expect(response.status).toBe(201);
      return response.data.workflow;
    },
    release(job: Job, attempt = 1) { writeFileSync(join(data, "markers", `${job.id}.${attempt}.release`), "release"); },
    async evidence(job: Job, attempt = 1) {
      const file = join(data, "markers", `${job.id}.${attempt}.started.json`);
      await until(() => existsSync(file), Boolean);
      return JSON.parse(readFileSync(file, "utf8")) as { pid: number; parent: number; attempt: number; jobId: string };
    },
    async stop() { if (stopped) return; stopped = true; child.kill("SIGKILL"); await child.exited; reader.releaseLock(); await errors; },
  };
  servers.push(server);
  return server;
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  await Bun.sleep(100); // Orphaned fixture workers observe parent disappearance themselves.
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});
const input = (key: string, kind = "succeed", dependsOn: string[] = [], maxAttempts = 1) => ({ key, name: key, kind, dependsOn, maxAttempts });
const terminal = (w: Workflow) => ["succeeded", "failed", "cancelled"].includes(w.status);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("v1 migration preserves completed rows exactly and resumes only unfinished legacy work", async () => {
  const data = directory(), db = new Database(join(data, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  for (const [id, status, result, error] of [["old-success", "succeeded", "old result", null], ["old-failure", "failed", null, "old error"]])
    db.query("INSERT INTO jobs VALUES(?,?,?, ?,2,?,?,11,22)").run(id, id, "succeed", status, result, error);
  db.query("INSERT INTO jobs VALUES('old-queued','Queued','succeed','queued',0,NULL,NULL,12,23)").run();
  db.query("INSERT INTO jobs VALUES('old-running','Running','succeed','running',1,NULL,NULL,13,24)").run();
  const before = db.query("SELECT * FROM jobs WHERE id IN ('old-success','old-failure') ORDER BY id").all(); db.close();
  let server = await start(data);
  expect((await server.request("/api/health")).data).toEqual({ ok: true, schemaVersion: 2 });
  await until(() => server.request("/api/jobs"), r => r.data.jobs.every((j: any) => ["succeeded", "failed"].includes(j.status)));
  expect((await server.request("/api/jobs")).data.jobs.filter((j: any) => ["old-success", "old-failure"].includes(j.id))).toEqual(before);
  expect(existsSync(join(data, "markers", "old-success.3.started.json"))).toBe(false);
  const legacy = await server.request("/api/jobs", { name: "New legacy", kind: "succeed" });
  expect(legacy.status).toBe(201);
  const done = await until(() => server.request("/api/jobs/" + legacy.data.job.id), r => r.data.job.status === "succeeded");
  expect(done.data.job.attempt).toBe(1); expect(JSON.parse(done.data.job.result).message).toBe("completed");
  await server.stop(); server = await start(data);
  expect((await server.request("/api/jobs")).data.jobs.filter((j: any) => ["old-success", "old-failure"].includes(j.id))).toEqual(before);
  const check = new Database(join(data, "workflow.sqlite"), { readonly: true });
  expect(check.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe("2"); check.close();
}, 20000);

test("validation is atomic; canonical idempotency and event cursors persist across restart", async () => {
  let server = await start();
  const valid = { name: "Publish", concurrency: 2, jobs: [input("a"), input("b", "succeed", ["a"])] };
  const invalid: unknown[] = [null, [], {}, { ...valid, name: " " }, { ...valid, name: 123 }, { ...valid, concurrency: "2" },
    { ...valid, jobs: [] }, { ...valid, jobs: Array.from({ length: 41 }, (_, n) => input("j" + n)) },
    ...[input("1bad"), { ...input("a"), kind: "unknown" }, { ...input("a"), dependsOn: "a" },
      { ...input("a"), dependsOn: [1] }, { ...input("a"), maxAttempts: null }, input("a", "succeed", [], 4),
      input("a", "succeed", ["missing"]), input("a", "succeed", ["a"])].map(job => ({ ...valid, jobs: [job] })),
    { ...valid, jobs: [input("a"), input("a")] },
    { ...valid, jobs: [input("a"), input("b", "succeed", ["a", "a"])] },
    { ...valid, jobs: [input("a", "succeed", ["b"]), input("b", "succeed", ["a"])] }];
  for (const body of invalid) expect((await server.request("/api/workflows", body, "same-key")).status).toBe(400);
  for (const key of [undefined, "", "x".repeat(129)]) expect((await server.request("/api/workflows", valid, key)).status).toBe(400);
  expect((await fetch(server.url + "/api/workflows", { method: "POST", headers: { "Idempotency-Key": "same-key" }, body: "{" })).status).toBe(400);
  expect((await server.request("/api/workflows")).data.workflows).toEqual([]);
  const created = await server.request("/api/workflows", valid, "same-key"); expect(created.status).toBe(201);
  const id = created.data.workflow.id;
  await until(() => server.workflow(id), terminal);
  const events = await server.events(id);
  const reorder = (v: any): any => Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
  const replay = await server.request("/api/workflows", reorder(valid), "same-key");
  expect(replay.status).toBe(200); expect(replay.data.replayed).toBe(true); expect(replay.data.workflow.id).toBe(id);
  expect((await server.request("/api/workflows", { ...valid, jobs: [...valid.jobs].reverse() }, "same-key")).status).toBe(409);
  expect(await server.events(id)).toEqual(events);
  for (const after of ["-1", "1.5", "wat", "", "1e2"]) expect((await server.request(`/api/workflows/${id}/events?after=${after}`)).status).toBe(400);
  expect((await server.request(`/api/workflows/${id}/events?after=999999`)).data.events).toEqual([]);
  expect((await server.request(`/api/workflows/${id}/events?after=2`)).data.events).toEqual(events.filter(e => e.seq > 2));
  expect(new Set(events.map(e => e.seq)).size).toBe(events.length);
  expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
  const data = server.data; await server.stop(); server = await start(data);
  expect((await server.request("/api/workflows", valid, "same-key")).status).toBe(200);
  expect(await server.events(id)).toEqual(events);
  for (const path of ["/api/jobs/missing", "/api/workflows/missing", "/api/workflows/missing/events"]) expect((await server.request(path)).status).toBe(404);
  expect((await server.request("/api/workflows/missing/cancel", undefined, undefined, "POST")).status).toBe(404);
}, 20000);

for (const limit of [1, 2, 3]) test(`real workers obey global concurrency ${limit}`, async () => {
  const server = await start(undefined, limit);
  const first = await server.create([input("a", "block"), input("b", "block"), input("c", "block")], 3);
  const other = await server.create([input("d", "block")], 3);
  const current = await until(async () => [await server.workflow(first.id), await server.workflow(other.id)], ws => ws.flatMap(w => w.jobs).filter(j => j.status === "running").length === limit);
  await Bun.sleep(200);
  const all = current.flatMap(w => w.jobs), running = all.filter(j => j.status === "running");
  expect(running.length).toBe(limit);
  for (const job of running) {
    const marker = await server.evidence(job);
    expect(marker.pid).toBe(job.attempts[0].pid); expect(alive(marker.pid)).toBe(true); expect(marker.parent).toBe(server.child.pid);
  }
  for (const job of all.filter(j => j.status === "queued")) expect(existsSync(join(server.data, "markers", `${job.id}.1.started.json`))).toBe(false);
  await server.request(`/api/workflows/${first.id}/cancel`, undefined, undefined, "POST");
  await server.request(`/api/workflows/${other.id}/cancel`, undefined, undefined, "POST");
  for (const job of running) expect(alive(job.attempts[0].pid)).toBe(false);
}, 15000);

test("per-workflow concurrency leaves room for independent workflows", async () => {
  const server = await start();
  const first = await server.create([input("a", "block"), input("b", "block")], 1);
  const second = await server.create([input("c", "block")], 3);
  const a = await until(() => server.workflow(first.id), w => w.jobs[0].status === "running");
  const b = await until(() => server.workflow(second.id), w => w.jobs[0].status === "running");
  await server.evidence(a.jobs[0]); await server.evidence(b.jobs[0]);
  expect((await server.workflow(first.id)).jobs[1].status).toBe("queued");
  server.release(a.jobs[0]);
  await until(() => server.workflow(first.id), w => w.jobs[1].status === "running");
  await server.evidence(a.jobs[1]); server.release(a.jobs[1]); server.release(b.jobs[0]);
  expect((await until(() => server.workflow(first.id), terminal)).status).toBe("succeeded");
  expect((await until(() => server.workflow(second.id), terminal)).status).toBe("succeeded");
  expect((await server.events(second.id)).filter(e => e.jobKey).every(e => e.jobKey === "c")).toBe(true);
}, 15000);

test("DAG ordering, successful retry, exhaustion, transitive blocking and independent progress", async () => {
  const server = await start();
  const workflow = await server.create([
    input("descendant", "succeed", ["blocked"]), input("blocked", "succeed", ["failure"]),
    input("root", "block"), input("retry", "fail_once", ["root"], 2), input("leaf", "succeed", ["retry"]),
    input("failure", "fail", [], 3),
  ]);
  const waiting = await until(() => server.workflow(workflow.id), w => w.jobs[5].status === "failed" && w.jobs[0].status === "blocked");
  expect(waiting.status).toBe("running");
  expect(waiting.jobs[5].attempts.map(a => a.status)).toEqual(["failed", "failed", "failed"]);
  expect(waiting.jobs[0].attempts).toEqual([]); expect(waiting.jobs[1].attempts).toEqual([]);
  await server.evidence(waiting.jobs[2]); server.release(waiting.jobs[2]);
  const done = await until(() => server.workflow(workflow.id), terminal);
  expect(done.status).toBe("failed"); expect(done.jobs[4].status).toBe("succeeded");
  expect(done.jobs[3].attempts.map(a => a.status)).toEqual(["failed", "succeeded"]);
  expect(done.jobs[3].attempts[0].startedAt).toBeGreaterThanOrEqual(done.jobs[2].attempts[0].finishedAt!);
  expect(done.jobs[4].attempts[0].startedAt).toBeGreaterThanOrEqual(done.jobs[3].attempts[1].finishedAt!);
  expect(JSON.parse(done.jobs[3].result!).attempt).toBe(2);
  expect(done.jobs[5].error).toContain("Synthetic worker requested failure");
  expect(done.jobs.flatMap(j => j.attempts).every(a => a.finishedAt !== null && a.pid > 0)).toBe(true);
  const events = await server.events(workflow.id);
  for (const type of ["workflow.created", "job.started", "job.succeeded", "job.failed", "job.retrying", "job.blocked", "workflow.failed"]) expect(events.some(e => e.type === type)).toBe(true);
  expect(events.filter(e => e.type === "job.retrying").length).toBe(3);
  expect((await server.request(`/api/workflows/${workflow.id}/cancel`, undefined, undefined, "POST")).status).toBe(409);
  expect(await server.events(workflow.id)).toEqual(events);
}, 15000);

test("cancellation reaps only its own workers, preserves results and is event-idempotent", async () => {
  const server = await start();
  const first = await server.create([input("done"), input("waiting", "block", ["done"]), input("queued", "succeed", ["waiting"])], 1);
  const other = await server.create([input("unrelated", "block")], 1);
  const running = await until(() => server.workflow(first.id), w => w.jobs[1].status === "running");
  const unrelated = await until(() => server.workflow(other.id), w => w.jobs[0].status === "running");
  await server.evidence(running.jobs[1]); await server.evidence(unrelated.jobs[0]);
  const responses = await Promise.all([1, 2].map(() => server.request(`/api/workflows/${first.id}/cancel`, undefined, undefined, "POST")));
  expect(responses.every(r => r.status === 200)).toBe(true);
  const cancelled = responses[0].data.workflow as Workflow;
  expect(cancelled.status).toBe("cancelled"); expect(cancelled.jobs[0].result).toBe(running.jobs[0].result);
  expect(cancelled.jobs.map(j => j.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
  expect(cancelled.jobs[1].attempts[0].status).toBe("cancelled"); expect(cancelled.jobs[1].attempts[0].finishedAt).not.toBeNull();
  expect(alive(running.jobs[1].attempts[0].pid)).toBe(false); expect(alive(unrelated.jobs[0].attempts[0].pid)).toBe(true);
  const events = await server.events(first.id);
  expect(events.filter(e => e.type === "workflow.cancelled").length).toBe(1);
  await server.request(`/api/workflows/${first.id}/cancel`, undefined, undefined, "POST");
  expect(await server.events(first.id)).toEqual(events);
  await Bun.sleep(150); expect(existsSync(join(server.data, "markers", `${running.jobs[2].id}.1.started.json`))).toBe(false);
  server.release(unrelated.jobs[0]); await until(() => server.workflow(other.id), terminal);
  expect((await server.request(`/api/workflows/${other.id}/cancel`, undefined, undefined, "POST")).status).toBe(409);
}, 15000);

test("crash recovery retains completed work and retries interrupted maxAttempts:1 with a new number", async () => {
  let server = await start();
  const body = { name: "Recovery", concurrency: 1, jobs: [input("done"), input("wait", "block", ["done"]), input("last", "succeed", ["wait"])] };
  const workflow = (await server.request("/api/workflows", body, "recover-key")).data.workflow as Workflow;
  const before = await until(() => server.workflow(workflow.id), w => w.jobs[1].status === "running");
  const old = await server.evidence(before.jobs[1]); const events = await server.events(workflow.id), data = server.data;
  await server.stop(); await until(() => alive(old.pid), v => !v);
  server = await start(data);
  const recovered = await until(() => server.workflow(workflow.id), w => w.jobs[1].attempts.length === 2);
  expect(recovered.jobs[0]).toEqual(before.jobs[0]);
  expect(recovered.jobs[1].attempts[0].status).toBe("interrupted"); expect(recovered.jobs[1].attempts[0].finishedAt).not.toBeNull();
  expect(recovered.jobs[1].attempts[1].number).toBe(2);
  await server.evidence(recovered.jobs[1], 2); server.release(recovered.jobs[1], 2);
  const done = await until(() => server.workflow(workflow.id), terminal); expect(done.status).toBe("succeeded");
  expect(done.jobs[0].attempts.length).toBe(1); expect(done.jobs[1].attempts.length).toBe(2);
  const after = await server.events(workflow.id);
  expect(after.slice(0, events.length)).toEqual(events); expect(after.some(e => e.type === "job.interrupted" && e.attempt === 1)).toBe(true);
  const replay = await server.request("/api/workflows", body, "recover-key"); expect(replay.status).toBe(200); expect(replay.data.workflow.id).toBe(workflow.id);
  expect(await server.events(workflow.id)).toEqual(after);
}, 20000);
