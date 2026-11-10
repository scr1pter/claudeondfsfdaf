import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const testRoot = join(tmpdir(), "vector");
mkdirSync(testRoot, { recursive: true });
type Workflow = { id: string; status: string; jobs: { id: string; key: string; status: string; result: string | null; error: string | null; attempts: { number: number; status: string; pid: number; finishedAt: number | null }[] }[] };
type Event = { seq: number; type: string; jobKey?: string; attempt?: number };

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  let latest: T;
  do {
    latest = await read();
    if (predicate(latest)) return latest;
    await Bun.sleep(35);
  } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${JSON.stringify(latest!)}`);
}

async function start(directory: string, limit = 2) {
  const child = Bun.spawn([process.execPath, "server/index.ts"], { cwd: root, env: { ...process.env, PORT: "0", DATA_DIR: directory, WORKFLOW_MARKER_DIR: join(directory, "markers"), WORKFLOW_WORKER_PATH: join(root, "server/worker.ts"), WORKFLOW_CONCURRENCY: String(limit) }, stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout>;
  const ready = await Promise.race([
    (async () => {
      const reader = child.stdout.getReader();
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Server exited before ready: ${output}\n${await new Response(child.stderr).text()}`);
        output += new TextDecoder().decode(value);
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) { reader.releaseLock(); return match[0]; }
      }
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("Server readiness timeout")); }, 10000); }),
  ]).finally(() => clearTimeout(timer));
  const request = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(ready + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return {
    child, request,
    raw: (path: string, body: string, key = "raw") => fetch(ready + path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body }),
    workflow: async (id: string) => (await request(`/api/workflows/${id}`)).data.workflow as Workflow,
    events: async (id: string, after = 0) => (await request(`/api/workflows/${id}/events?after=${after}`)).data.events as Event[],
    stop: async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; },
  };
}
const definition = (jobs: unknown[], concurrency = 2, name = "Checks") => ({ name, concurrency, jobs });
const job = (key: string, kind = "succeed", dependsOn: string[] = [], maxAttempts = 1) => ({ key, name: key, kind, dependsOn, maxAttempts });
const disposable = () => mkdtempSync(join(testRoot, "workflow-tests-"));
const release = (directory: string, id: string, attempt = 1) => writeFileSync(join(directory, "markers", `${id}.${attempt}.release`), "");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("migration preserves completed v1 rows exactly and legacy jobs still execute", async () => {
  const directory = disposable();
  const db = new Database(join(directory, "workflow.sqlite"));
  db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
  db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run("legacy", "Legacy completed", "succeed", "succeeded", 7, "saved result", "saved error", 123, 456);
  db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-queued", "Legacy queued", "succeed", "queued", 0, null, null, 124, 124);
  db.query("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-running", "Legacy running", "succeed", "running", 1, null, null, 125, 126);
  const before = db.query("SELECT * FROM jobs WHERE id='legacy'").get();
  db.close();
  let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    app = await start(directory);
    expect((await app.request("/api/health")).data).toEqual({ ok: true, schemaVersion: 2 });
    expect((await app.request("/api/jobs/legacy")).data.job).toEqual(before);
    for (const id of ["legacy-queued", "legacy-running"]) {
      const recovered = await until(async () => (await app!.request(`/api/jobs/${id}`)).data.job, j => j.status === "succeeded");
      expect(recovered.attempt).toBe(id === "legacy-queued" ? 1 : 2);
    }
    const adopted = (await app.request("/api/workflows")).data.workflows.find((w: { name: string }) => w.name === "Legacy running");
    expect(adopted.jobs[0].attempts.map((a: { status: string }) => a.status)).toEqual(["interrupted", "succeeded"]);
    const created = await app.request("/api/jobs", { name: "New legacy", kind: "succeed" });
    expect(created.status).toBe(201);
    const completed = await until(async () => (await app!.request(`/api/jobs/${created.data.job.id}`)).data.job, j => j.status === "succeeded");
    expect(JSON.parse(completed.result).jobId).toBe(created.data.job.id);
    expect(existsSync(join(directory, "markers", "legacy.8.started.json"))).toBe(false);
    await app.stop();
    app = await start(directory);
    expect((await app.request("/api/jobs/legacy")).data.job).toEqual(before);
    const check = new Database(join(directory, "workflow.sqlite"));
    expect(check.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "2" });
    check.close();
  } finally { await app?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 20000);

test("validation is atomic; canonical idempotency and event cursors persist", async () => {
  const directory = disposable();
  let app = await start(directory);
  try {
    const invalid = [
      null, [], { ...definition([job("a")]), name: " " }, definition([]), definition([job("a")], 4),
      definition([job("a"), job("a")]), definition([job("a", "other")]),
      definition([job("a", "succeed", ["missing"])]), definition([job("a", "succeed", ["a"])]),
      definition([job("a", "succeed", ["b"]), job("b", "succeed", ["a"])]),
      definition([job("a"), job("b", "succeed", ["a", "a"])]),
      definition([{ ...job("a"), maxAttempts: "2" }]), definition([{ ...job("a"), dependsOn: null }]),
      definition([{ ...job("a"), name: 42 }]), definition(Array.from({ length: 41 }, (_, i) => job(`a${i}`))),
      definition([{ ...job("a"), key: "1bad" }]), definition([{ ...job("a"), name: "x".repeat(121) }]),
      definition([{ ...job("a"), maxAttempts: 0 }]), definition([{ ...job("a"), maxAttempts: 4 }]),
      definition([{ ...job("a"), dependsOn: [1] }]), definition([job("a")], 1.5),
    ];
    for (const body of invalid) expect((await app.request("/api/workflows", body, "reusable")).status).toBe(400);
    expect((await app.raw("/api/workflows", "{bad")).status).toBe(400);
    expect((await app.request("/api/workflows", definition([job("a")]))).status).toBe(400);
    expect((await app.request("/api/workflows", definition([job("a")]), "x".repeat(129))).status).toBe(400);
    expect((await app.request("/api/workflows")).data.workflows).toEqual([]);
    const body = { name: "Checks", concurrency: 2, jobs: [job("a")] };
    const created = await app.request("/api/workflows", body, "reusable");
    expect(created.status).toBe(201);
    const id = created.data.workflow.id;
    await until(() => app.workflow(id), w => w.status === "succeeded");
    const events = await app.events(id);
    const reordered = { jobs: body.jobs.map(j => ({ maxAttempts: j.maxAttempts, dependsOn: j.dependsOn, kind: j.kind, name: j.name, key: j.key })), concurrency: body.concurrency, name: body.name };
    const replay = await app.request("/api/workflows", reordered, "reusable");
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.workflow.id).toBe(id);
    expect((await app.request("/api/workflows", { ...body, name: "Different" }, "reusable")).status).toBe(409);
    expect(await app.events(id)).toEqual(events);
    const ordered = definition([job("first"), job("second")]);
    expect((await app.request("/api/workflows", ordered, "ordered")).status).toBe(201);
    expect((await app.request("/api/workflows", { ...ordered, jobs: [...ordered.jobs].reverse() }, "ordered")).status).toBe(409);
    expect(events.map(e => e.type)).toEqual(["workflow.created", "job.started", "job.succeeded", "workflow.succeeded"]);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await app.events(id, 2)).toEqual(events.slice(2));
    expect(await app.events(id, 999)).toEqual([]);
    for (const cursor of ["-1", "1.5", "no", "", "1e2"]) expect((await app.request(`/api/workflows/${id}/events?after=${cursor}`)).status).toBe(400);
    expect((await app.request("/api/workflows/unknown")).status).toBe(404);
    expect((await app.request("/api/workflows/unknown/events")).status).toBe(404);
    expect((await app.request("/api/workflows/unknown/cancel", {})).status).toBe(404);
    await app.stop(); app = await start(directory);
    expect((await app.request("/api/workflows", reordered, "reusable")).data.workflow.id).toBe(id);
    expect(await app.events(id)).toEqual(events);
  } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 25000);

test("global worker bounds of one and three override wider workflow requests", async () => {
  for (const limit of [1, 3]) {
    const directory = disposable();
    const app = await start(directory, limit);
    try {
      const id = (await app.request("/api/workflows", definition([job("a", "block"), job("b", "block"), job("c", "block"), job("d", "block")], 3), `limit-${limit}`)).data.workflow.id;
      const workflow = await until(() => app.workflow(id), w => w.jobs.filter(j => j.status === "running").length === limit);
      await Bun.sleep(150);
      expect((await app.workflow(id)).jobs.filter(j => j.status === "running")).toHaveLength(limit);
      expect(workflow.jobs.filter(j => j.status === "queued")).toHaveLength(4 - limit);
      const cancelled = await app.request(`/api/workflows/${id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      for (const node of workflow.jobs.filter(j => j.status === "running")) expect(alive(node.attempts[0].pid)).toBe(false);
    } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
}, 20000);

test("real workers respect dependencies and the shared concurrency bound", async () => {
  const directory = disposable();
  const app = await start(directory, 2);
  try {
    const first = (await app.request("/api/workflows", definition([job("a", "block"), job("b", "block"), job("join", "succeed", ["a", "b"])]), "graph")).data.workflow.id;
    const running = await until(() => app.workflow(first), w => w.jobs.filter(j => j.status === "running").length === 2);
    const [a, b, joined] = running.jobs;
    await until(async () => existsSync(join(directory, "markers", `${a.id}.1.started.json`)) && existsSync(join(directory, "markers", `${b.id}.1.started.json`)), Boolean);
    for (const node of [a, b]) {
      const evidence = JSON.parse(readFileSync(join(directory, "markers", `${node.id}.1.started.json`), "utf8"));
      expect(evidence.pid).toBe(node.attempts[0].pid);
      expect(evidence.parent).toBe(app.child.pid);
      expect(alive(evidence.pid)).toBe(true);
    }
    const second = (await app.request("/api/workflows", definition([job("c", "block"), job("d", "block")], 1), "serial")).data.workflow.id;
    await Bun.sleep(250);
    expect((await app.workflow(second)).jobs.every(j => j.status === "queued")).toBe(true);
    expect(existsSync(join(directory, "markers", `${joined.id}.1.started.json`))).toBe(false);
    release(directory, a.id);
    const serial = await until(() => app.workflow(second), w => w.jobs[0].status === "running");
    expect(serial.jobs[1].status).toBe("queued");
    expect((await app.workflow(first)).jobs[2].status).toBe("queued");
    release(directory, b.id);
    const done = await until(() => app.workflow(first), w => w.status === "succeeded");
    expect(done.jobs.every(j => j.status === "succeeded")).toBe(true);
    const events = await app.events(first);
    expect(events.findIndex(e => e.type === "job.started" && e.jobKey === "join")).toBeGreaterThan(events.findIndex(e => e.type === "job.succeeded" && e.jobKey === "b"));
    expect((await app.events(second)).every(e => !e.jobKey || ["c", "d"].includes(e.jobKey))).toBe(true);
    release(directory, serial.jobs[0].id);
    const next = await until(() => app.workflow(second), w => w.jobs[1].status === "running");
    release(directory, next.jobs[1].id);
    await until(() => app.workflow(second), w => w.status === "succeeded");
  } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 25000);

test("retry exhaustion blocks descendants while independent work succeeds", async () => {
  const directory = disposable();
  const app = await start(directory);
  try {
    const id = (await app.request("/api/workflows", definition([job("retry", "fail_once", [], 2), job("fail", "fail", [], 3), job("blocked", "succeed", ["fail"]), job("alsoBlocked", "succeed", ["blocked"]), job("independent")]), "retries")).data.workflow.id;
    const workflow = await until(() => app.workflow(id), w => w.status === "failed");
    expect(workflow.jobs.map(j => j.status)).toEqual(["succeeded", "failed", "blocked", "blocked", "succeeded"]);
    expect(workflow.jobs[0].attempts.map(a => a.status)).toEqual(["failed", "succeeded"]);
    expect(workflow.jobs[1].attempts.map(a => a.number)).toEqual([1, 2, 3]);
    expect(workflow.jobs[1].error).toContain("Synthetic worker requested failure");
    expect(workflow.jobs[2].attempts).toEqual([]);
    expect(workflow.jobs.flatMap(j => j.attempts).every(a => a.pid > 0 && a.finishedAt !== null)).toBe(true);
    expect(JSON.parse(workflow.jobs[0].result!).attempt).toBe(2);
    const events = await app.events(id);
    expect(events.filter(e => e.type === "job.retrying")).toHaveLength(3);
    expect(events.filter(e => e.type === "job.blocked")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("workflow.failed");
    expect((await app.request(`/api/workflows/${id}/cancel`, {})).status).toBe(409);
    expect(await app.events(id)).toEqual(events);
  } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 20000);

test("cancel reaps children, preserves results, is repeatable and isolated", async () => {
  const directory = disposable();
  const app = await start(directory);
  try {
    const id = (await app.request("/api/workflows", definition([job("done"), job("wait", "block", ["done"]), job("later", "succeed", ["wait"])], 1), "cancel")).data.workflow.id;
    const running = await until(() => app.workflow(id), w => w.jobs[1].status === "running");
    const other = (await app.request("/api/workflows", definition([job("other", "block")]), "other")).data.workflow.id;
    await until(() => app.workflow(other), w => w.jobs[0].status === "running");
    const cancelled = await app.request(`/api/workflows/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.workflow.status).toBe("cancelled");
    expect(cancelled.data.workflow.jobs.map((j: { status: string }) => j.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect(cancelled.data.workflow.jobs[0].result).toBe(running.jobs[0].result);
    expect(alive(running.jobs[1].attempts[0].pid)).toBe(false);
    expect(cancelled.data.workflow.jobs[1].attempts[0].status).toBe("cancelled");
    const events = await app.events(id);
    expect(events.at(-1)?.type).toBe("workflow.cancelled");
    expect(events.filter(e => e.type === "job.cancelled")).toHaveLength(2);
    expect((await app.request(`/api/workflows/${id}/cancel`, {})).status).toBe(200);
    expect(await app.events(id)).toEqual(events);
    await Bun.sleep(150);
    expect(existsSync(join(directory, "markers", `${running.jobs[2].id}.1.started.json`))).toBe(false);
    expect((await app.workflow(other)).status).toBe("running");
    await app.request(`/api/workflows/${other}/cancel`, {});
  } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 20000);

test("crash recovery preserves attempts, does not spend failure allowance, and never reruns completed work", async () => {
  const directory = disposable();
  let app = await start(directory);
  try {
    const id = (await app.request("/api/workflows", definition([job("done"), job("wait", "block", ["done"], 1)], 1), "recover")).data.workflow.id;
    const running = await until(() => app.workflow(id), w => w.jobs[1].status === "running");
    const pid = running.jobs[1].attempts[0].pid;
    await until(async () => existsSync(join(directory, "markers", `${running.jobs[1].id}.1.started.json`)), Boolean);
    await app.stop();
    await until(async () => alive(pid), value => !value);
    app = await start(directory);
    const recovered = await until(() => app.workflow(id), w => w.jobs[1].attempts.length === 2 && w.jobs[1].status === "running");
    expect(recovered.jobs[0]).toEqual(running.jobs[0]);
    expect(recovered.jobs[1].attempts[0].status).toBe("interrupted");
    expect(recovered.jobs[1].attempts[0].finishedAt).not.toBeNull();
    expect(recovered.jobs[1].attempts[1].number).toBe(2);
    expect(existsSync(join(directory, "markers", `${running.jobs[0].id}.2.started.json`))).toBe(false);
    release(directory, recovered.jobs[1].id, 2);
    const done = await until(() => app.workflow(id), w => w.status === "succeeded");
    expect(done.jobs[1].attempts.map(a => a.status)).toEqual(["interrupted", "succeeded"]);
    const events = await app.events(id);
    expect(events.filter(e => e.type === "job.interrupted")).toHaveLength(1);
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)).toBe(true);
    expect((await app.request(`/api/workflows/${id}/cancel`, {})).status).toBe(409);
    await app.stop(); app = await start(directory);
    expect(await app.workflow(id)).toEqual(done);
    expect(await app.events(id)).toEqual(events);
  } finally { await app.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 25000);
