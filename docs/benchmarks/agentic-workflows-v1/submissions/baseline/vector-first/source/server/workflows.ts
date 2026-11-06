import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type WorkflowRow = {
  id: string;
  name: string;
  concurrency: number;
  status: string;
  created_at: number;
  updated_at: number;
};
type NodeRow = {
  id: string;
  workflow_id: string;
  key: string;
  name: string;
  kind: string;
  depends_on: string;
  max_attempts: number;
  status: string;
  result: string | null;
  error: string | null;
  legacy_id: string | null;
  attempt_base: number;
};
type AttemptRow = {
  job_id: string;
  number: number;
  status: string;
  pid: number | null;
  started_at: number;
  finished_at: number | null;
};
type Definition = {
  name: string;
  concurrency: number;
  jobs: {
    key: string;
    name: string;
    kind: string;
    dependsOn: string[];
    maxAttempts: number;
  }[];
};
export const kinds = ["succeed", "fail", "fail_once", "block"];
const terminal = ["succeeded", "failed", "cancelled"];
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validate(input: unknown): Definition {
  if (
    !object(input) || !validName(input.name) ||
    !Number.isInteger(input.concurrency) || Number(input.concurrency) < 1 || Number(input.concurrency) > 3 ||
    !Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 40
  ) throw new Error("Invalid workflow name, concurrency, or jobs (1 to 40 required)");
  const keys = new Set<string>();
  const jobs = input.jobs.map((job: unknown) => {
    if (
      !object(job) || typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key) ||
      keys.has(job.key) || !validName(job.name) || typeof job.kind !== "string" || !kinds.includes(job.kind)
    ) throw new Error("Invalid or duplicate job key, name, or kind");
    keys.add(job.key);
    const maxAttempts = job.maxAttempts === undefined ? 1 : job.maxAttempts;
    const dependsOn = job.dependsOn === undefined ? [] : job.dependsOn;
    if (
      !Number.isInteger(maxAttempts) || Number(maxAttempts) < 1 || Number(maxAttempts) > 3 ||
      !Array.isArray(dependsOn) || dependsOn.some(key => typeof key !== "string") ||
      new Set(dependsOn).size !== dependsOn.length
    ) throw new Error("Invalid attempts or dependencies");
    return { key: job.key, name: job.name.trim(), kind: job.kind, maxAttempts: Number(maxAttempts), dependsOn: dependsOn as string[] };
  });
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("Dependencies must not contain cycles");
    if (visited.has(key)) return;
    const job = jobs.find(job => job.key === key);
    if (!job) throw new Error("Dependency references an unknown job");
    visiting.add(key);
    job.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  jobs.forEach(job => visit(job.key));
  return { name: input.name.trim(), concurrency: Number(input.concurrency), jobs };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class Runner {
  readonly database: Database;
  private active = new Map<string, { workflowId: string; child: ReturnType<typeof Bun.spawn>; done: Promise<void> }>();
  private stopped = false;
  private interval: ReturnType<typeof setInterval>;
  private limit: number;

  constructor(root: string, directory: string, private worker: string, private markers: string) {
    this.limit = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 3) throw new Error("WORKFLOW_CONCURRENCY must be an integer from 1 to 3");
    this.database = new Database(join(directory, "workflow.sqlite"));
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.transaction(() => {
      this.database.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workflow_nodes (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, depends_on TEXT NOT NULL, max_attempts INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, legacy_id TEXT UNIQUE REFERENCES jobs(id), attempt_base INTEGER NOT NULL DEFAULT 0, UNIQUE(workflow_id,key));
        CREATE TABLE IF NOT EXISTS attempts (job_id TEXT NOT NULL REFERENCES workflow_nodes(id), number INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(job_id,number));
        CREATE TABLE IF NOT EXISTS events (workflow_id TEXT NOT NULL REFERENCES workflows(id), seq INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, job_key TEXT, attempt INTEGER, PRIMARY KEY(workflow_id,seq));
        CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, contents TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id));
        CREATE INDEX IF NOT EXISTS workflow_nodes_workflow ON workflow_nodes(workflow_id);
      `);
      // Only unfinished v1 work needs adoption. Historical rows remain byte-for-byte intact.
      const unfinished = this.database.query<{ id: string; name: string; kind: string; status: string; attempt: number; created_at: number; updated_at: number }, []>("SELECT * FROM jobs WHERE status IN ('queued','running') AND id NOT IN (SELECT legacy_id FROM workflow_nodes WHERE legacy_id IS NOT NULL)").all();
      for (const job of unfinished) {
        const id = this.insert({ name: job.name, concurrency: 1, jobs: [{ key: "job", name: job.name, kind: job.kind, dependsOn: [], maxAttempts: 1 }] }, job.id, job.created_at);
        const node = this.nodes(id)[0];
        this.database.query("UPDATE workflow_nodes SET attempt_base=? WHERE id=?").run(job.attempt, node.id);
        if (job.status === "running") {
          const number = Math.max(1, job.attempt);
          this.database.query("UPDATE workflow_nodes SET status='running' WHERE id=?").run(node.id);
          this.database.query("INSERT INTO attempts VALUES(?,?,'running',NULL,?,NULL)").run(node.id, number, job.updated_at);
        }
      }
      this.database.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    })();
    this.database.transaction(() => {
      const unfinished = this.database.query<AttemptRow & { workflow_id: string; key: string }, []>("SELECT a.*, n.workflow_id, n.key FROM attempts a JOIN workflow_nodes n ON n.id=a.job_id WHERE a.status='running'").all();
      for (const attempt of unfinished) {
        this.database.query("UPDATE attempts SET status='interrupted', finished_at=? WHERE job_id=? AND number=?").run(Date.now(), attempt.job_id, attempt.number);
        this.database.query("UPDATE workflow_nodes SET status='queued' WHERE id=?").run(attempt.job_id);
        this.event(attempt.workflow_id, "job.interrupted", attempt.key, attempt.number);
        this.syncLegacy(attempt.job_id, "queued");
      }
    })();
    this.interval = setInterval(() => this.dispatch(), 40);
  }

  private event(id: string, type: string, jobKey?: string, attempt?: number) {
    this.database.query("INSERT INTO events(workflow_id,seq,type,created_at,job_key,attempt) SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,? FROM events WHERE workflow_id=?").run(id, type, Date.now(), jobKey ?? null, attempt ?? null, id);
    this.database.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), id);
  }

  nodes(id: string) { return this.database.query<NodeRow, [string]>("SELECT * FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid").all(id); }
  row(id: string) { return this.database.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id); }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      concurrency: row.concurrency,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      jobs: this.nodes(id).map(node => ({
        id: node.id,
        key: node.key,
        name: node.name,
        kind: node.kind,
        dependsOn: JSON.parse(node.depends_on) as string[],
        maxAttempts: node.max_attempts,
        status: node.status,
        result: node.result,
        error: node.error,
        attempts: this.database.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE job_id=? ORDER BY number")
          .all(node.id).map(a => ({
            number: a.number,
            status: a.status,
            pid: a.pid,
            startedAt: a.started_at,
            finishedAt: a.finished_at,
          })),
      })),
    };
  }
  list() { return this.database.query<{ id: string }, []>("SELECT id FROM workflows ORDER BY created_at,id").all().map(row => this.workflow(row.id)); }
  events(id: string, after: number) { return this.database.query<{ seq: number; type: string; created_at: number; job_key: string | null; attempt: number | null }, [string, number]>("SELECT * FROM events WHERE workflow_id=? AND seq>? ORDER BY seq").all(id, after).map(e => ({ seq: e.seq, type: e.type, createdAt: e.created_at, ...(e.job_key === null ? {} : { jobKey: e.job_key }), ...(e.attempt === null ? {} : { attempt: e.attempt }) })); }

  private insert(definition: Definition, legacyId: string | null = null, now = Date.now()) {
    const id = crypto.randomUUID();
    this.database.query("INSERT INTO workflows VALUES(?,?,?,'queued',?,?)").run(id, definition.name, definition.concurrency, now, now);
    for (const node of definition.jobs) this.database.query("INSERT INTO workflow_nodes(id,workflow_id,key,name,kind,depends_on,max_attempts,status,legacy_id) VALUES(?,?,?,?,?,?,?,'queued',?)").run(legacyId ?? crypto.randomUUID(), id, node.key, node.name, node.kind, JSON.stringify(node.dependsOn), node.maxAttempts, legacyId);
    this.event(id, "workflow.created");
    return id;
  }
  create(definition: Definition, key: string, contents: string) {
    return this.database.transaction(() => {
      const existing = this.database.query<{ contents: string; workflow_id: string }, [string]>("SELECT * FROM idempotency WHERE key=?").get(key);
      if (existing) return { conflict: existing.contents !== contents, replayed: true, workflow: this.workflow(existing.workflow_id) };
      const id = this.insert(definition);
      this.database.query("INSERT INTO idempotency VALUES(?,?,?)").run(key, contents, id);
      return { conflict: false, replayed: false, workflow: this.workflow(id) };
    })();
  }
  createLegacy(name: string, kind: string) {
    return this.database.transaction(() => {
      const id = crypto.randomUUID(), now = Date.now();
      this.database.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)").run(id, name, kind, now, now);
      this.insert({ name, concurrency: 1, jobs: [{ key: "job", name, kind, dependsOn: [], maxAttempts: 1 }] }, id);
      return this.legacy(id);
    })();
  }
  legacy(id: string) { return this.database.query("SELECT * FROM jobs WHERE id=?").get(id); }
  legacyList() { return this.database.query("SELECT * FROM jobs ORDER BY created_at,id").all(); }

  private syncLegacy(nodeId: string, status: string, attempt?: number, result: string | null = null, error: string | null = null) {
    this.database.query("UPDATE jobs SET status=?, attempt=COALESCE(?,attempt), result=?, error=?, updated_at=? WHERE id=(SELECT legacy_id FROM workflow_nodes WHERE id=?)").run(status, attempt ?? null, result, error, Date.now(), nodeId);
  }

  private settle(id: string) {
    const nodes = this.nodes(id);
    let changed: boolean;
    do {
      changed = false;
      for (const node of nodes) {
        if (node.status === "queued" && (JSON.parse(node.depends_on) as string[]).some(key => nodes.some(n => n.key === key && ["failed", "blocked", "cancelled"].includes(n.status)))) {
          this.database.query("UPDATE workflow_nodes SET status='blocked', error='A predecessor did not succeed' WHERE id=?").run(node.id);
          node.status = "blocked";
          this.event(id, "job.blocked", node.key);
          changed = true;
        }
      }
    } while (changed);
    if (nodes.every(n => !["queued", "running"].includes(n.status))) {
      const status = nodes.every(n => n.status === "succeeded") ? "succeeded" : "failed";
      this.database.query("UPDATE workflows SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), id);
      this.event(id, `workflow.${status}`);
    }
  }

  private dispatch() {
    if (this.stopped) return;
    const workflows = this.database.query<WorkflowRow, []>("SELECT * FROM workflows WHERE status IN ('queued','running') ORDER BY created_at,id").all();
    for (const workflow of workflows) {
      this.database.transaction(() => this.settle(workflow.id))();
      if (terminal.includes(this.row(workflow.id)!.status)) continue;
      const nodes = this.nodes(workflow.id);
      let running = [...this.active.values()].filter(a => a.workflowId === workflow.id).length;
      for (const node of nodes) {
        if (this.active.size >= this.limit || running >= workflow.concurrency) break;
        if (node.status !== "queued" || this.active.has(node.id) || !(JSON.parse(node.depends_on) as string[]).every(key => nodes.some(n => n.key === key && n.status === "succeeded"))) continue;
        this.start(node);
        running++;
      }
    }
  }

  private start(node: NodeRow) {
    const last = this.database.query<{ number: number }, [string]>("SELECT COALESCE(MAX(number),0) AS number FROM attempts WHERE job_id=?").get(node.id)!.number;
    const number = Math.max(last, node.attempt_base) + 1;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([process.execPath, this.worker, "--job-id", node.id, "--attempt", String(number), "--kind", node.kind], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, WORKFLOW_MARKER_DIR: this.markers, WORKFLOW_PARENT_PID: String(process.pid) } });
    } catch (failure) {
      this.database.transaction(() => {
        const now = Date.now();
        this.database.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(node.id, number, now, now);
        this.event(node.workflow_id, "job.failed", node.key, number);
        this.finish(node, number, false, null, `Worker could not start: ${String(failure).slice(0, 2000)}`);
      })();
      return;
    }
    this.database.transaction(() => {
      this.database.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(node.id, number, child.pid, Date.now());
      this.database.query("UPDATE workflow_nodes SET status='running' WHERE id=?").run(node.id);
      this.database.query("UPDATE workflows SET status='running',updated_at=? WHERE id=?").run(Date.now(), node.workflow_id);
      this.syncLegacy(node.id, "running", number);
      this.event(node.workflow_id, "job.started", node.key, number);
    })();
    const done = (async () => {
      const [code, stdout, stderr] = await Promise.all([child.exited, this.output(child.stdout as ReadableStream), this.output(child.stderr as ReadableStream)]);
      if (this.stopped) return;
      this.database.transaction(() => {
        const attempt = this.database.query<AttemptRow, [string, number]>("SELECT * FROM attempts WHERE job_id=? AND number=?").get(node.id, number)!;
        if (attempt.status !== "running") return;
        this.database.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?").run(code === 0 ? "succeeded" : "failed", Date.now(), node.id, number);
        this.event(node.workflow_id, code === 0 ? "job.succeeded" : "job.failed", node.key, number);
        this.finish(node, number, code === 0, code === 0 ? stdout.trim() : null, code === 0 ? null : (stderr.trim() || `Worker exited with code ${code}`).slice(0, 4096));
      })();
    })().finally(() => { this.active.delete(node.id); this.dispatch(); });
    this.active.set(node.id, { workflowId: node.workflow_id, child, done });
  }

  private async output(stream: ReadableStream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Drain pipes even after the output limit, so verbose children cannot deadlock.
      if (output.length < 65536) output += decoder.decode(value, { stream: true }).slice(0, 65536 - output.length);
    }
    return output + decoder.decode();
  }

  private finish(node: NodeRow, number: number, succeeded: boolean, result: string | null, error: string | null) {
    const failures = this.database.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM attempts WHERE job_id=? AND status='failed'").get(node.id)!.count;
    const retry = !succeeded && failures < node.max_attempts;
    const status = succeeded ? "succeeded" : retry ? "queued" : "failed";
    this.database.query("UPDATE workflow_nodes SET status=?,result=?,error=? WHERE id=?").run(status, result, error, node.id);
    this.syncLegacy(node.id, status, number, result, error);
    if (retry) this.event(node.workflow_id, "job.retrying", node.key, number);
    this.settle(node.workflow_id);
  }

  async cancel(id: string) {
    const row = this.row(id);
    if (!row) return 404;
    if (["succeeded", "failed"].includes(row.status)) return 409;
    if (row.status !== "cancelled") this.database.transaction(() => {
      this.database.query("UPDATE workflows SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), id);
      for (const node of this.nodes(id)) {
        if (!["queued", "running"].includes(node.status)) continue;
        this.database.query("UPDATE workflow_nodes SET status='cancelled' WHERE id=?").run(node.id);
        const attempt = this.database.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE job_id=? AND status='running'").get(node.id);
        if (attempt) this.database.query("UPDATE attempts SET status='cancelled',finished_at=? WHERE job_id=? AND number=?").run(Date.now(), node.id, attempt.number);
        this.syncLegacy(node.id, "cancelled");
        this.event(id, "job.cancelled", node.key, attempt?.number);
      }
      this.event(id, "workflow.cancelled");
    })();
    const children = [...this.active.values()].filter(a => a.workflowId === id);
    for (const { child } of children) child.kill("SIGKILL");
    await Promise.all(children.map(a => a.done));
    return 200;
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.interval);
    const children = [...this.active.values()];
    for (const { child } of children) child.kill("SIGKILL");
    await Promise.all(children.map(a => a.done));
    this.database.close();
  }
}
