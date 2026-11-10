import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Job = {
  id: string; name: string; kind: string; status: string; attempt: number;
  result: string | null; error: string | null; created_at: number; updated_at: number;
};
export type WorkflowRow = {
  id: string; name: string; concurrency: number; status: string;
  created_at: number; updated_at: number; legacy: number; cancel_requested: number;
};
export type Node = Job & { workflow_id: string; key: string; depends_on: string; max_attempts: number };
export type Definition = {
  name: string; concurrency: number;
  jobs: { key: string; name: string; kind: string; dependsOn: string[]; maxAttempts: number }[];
};
export const kinds = ["succeed", "fail", "fail_once", "block"];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const validName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

export function validate(input: unknown): Definition {
  if (!record(input) || !validName(input.name) || !integer(input.concurrency, 3) ||
      !Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 40)
    throw new Error("Provide a name, concurrency 1-3 and 1-40 jobs.");
  const jobs = input.jobs.map((job: unknown) => {
    if (!record(job) || typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key) ||
        !validName(job.name) || typeof job.kind !== "string" || !kinds.includes(job.kind) ||
        (job.maxAttempts !== undefined && !integer(job.maxAttempts, 3)) ||
        (job.dependsOn !== undefined && (!Array.isArray(job.dependsOn) ||
          !job.dependsOn.every((key: unknown) => typeof key === "string"))))
      throw new Error("Each job needs a valid key, name, kind, dependencies and maxAttempts (1-3).");
    return { key: job.key, name: job.name.trim(), kind: job.kind,
      dependsOn: (job.dependsOn ?? []) as string[], maxAttempts: (job.maxAttempts ?? 1) as number };
  });
  const byKey = new Map(jobs.map(job => [job.key, job]));
  if (byKey.size !== jobs.length) throw new Error("Job keys must be unique.");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new Error("Dependencies must not contain cycles.");
    if (visited.has(key)) return;
    const job = byKey.get(key);
    if (!job) throw new Error("A dependency refers to a missing job.");
    if (new Set(job.dependsOn).size !== job.dependsOn.length) throw new Error("Dependencies must be unique.");
    visiting.add(key);
    job.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  jobs.forEach(job => visit(job.key));
  return { name: input.name.trim(), concurrency: input.concurrency, jobs };
}

// Object ordering is immaterial; arrays (including the job list) retain their order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class Store {
  db: Database;
  constructor(directory: string, root: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "workflow.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.transaction(() => {
      this.db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          legacy INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS workflow_nodes (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
          key TEXT NOT NULL, depends_on TEXT NOT NULL, max_attempts INTEGER NOT NULL,
          UNIQUE(workflow_id,key)
        );
        CREATE TABLE IF NOT EXISTS attempts (
          job_id TEXT NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL, status TEXT NOT NULL,
          pid INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(job_id,number)
        );
        CREATE TABLE IF NOT EXISTS events (
          workflow_id TEXT NOT NULL REFERENCES workflows(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
          created_at INTEGER NOT NULL, job_key TEXT, attempt INTEGER, PRIMARY KEY(workflow_id,seq)
        );
        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY, content TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id)
        );
        CREATE INDEX IF NOT EXISTS nodes_workflow ON workflow_nodes(workflow_id);
      `);
      // Completed legacy rows are intentionally never rewritten or scheduled.
      const legacy = this.db.query<Job, []>(`SELECT * FROM jobs WHERE status IN ('queued','running')
        AND id NOT IN (SELECT job_id FROM workflow_nodes)`).all();
      for (const job of legacy) {
        const id = crypto.randomUUID();
        this.db.query("INSERT INTO workflows(id,name,concurrency,status,created_at,updated_at,legacy) VALUES(?,?,1,'queued',?,?,1)")
          .run(id, job.name, job.created_at, job.updated_at);
        this.db.query("INSERT INTO workflow_nodes VALUES(?,?,?,'[]',1)").run(job.id, id, "job");
        if (job.status === "running" && job.attempt > 0)
          this.db.query("INSERT INTO attempts VALUES(?,?,'running',NULL,?,NULL)").run(job.id, job.attempt, job.updated_at);
      }
      this.db.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    })();
    this.recover();
  }

  row(id: string) { return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id); }
  nodes(id: string) {
    return this.db.query<Node, [string]>(`SELECT j.*,n.workflow_id,n.key,n.depends_on,n.max_attempts
      FROM jobs j JOIN workflow_nodes n ON j.id=n.job_id WHERE n.workflow_id=? ORDER BY n.rowid`).all(id);
  }
  job(id: string) { return this.db.query<Job, [string]>("SELECT * FROM jobs WHERE id=?").get(id); }
  legacyJobs() {
    return this.db.query<Job, []>(`SELECT j.* FROM jobs j WHERE NOT EXISTS (
      SELECT 1 FROM workflow_nodes n JOIN workflows w ON w.id=n.workflow_id WHERE n.job_id=j.id AND w.legacy=0
    ) ORDER BY j.created_at,j.id`).all();
  }
  event(id: string, type: string, key: string | null = null, attempt: number | null = null) {
    this.db.query(`INSERT INTO events SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,? FROM events WHERE workflow_id=?`)
      .run(id, type, Date.now(), key, attempt, id);
    this.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), id);
  }
  events(id: string, after: number) {
    return this.db.query<{ seq: number; type: string; createdAt: number; jobKey: string | null; attempt: number | null }, [string, number]>(
      "SELECT seq,type,created_at AS createdAt,job_key AS jobKey,attempt FROM events WHERE workflow_id=? AND seq>? ORDER BY seq").all(id, after);
  }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) return null;
    return { id: row.id, name: row.name, concurrency: row.concurrency, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      jobs: this.nodes(id).map(job => ({ id: job.id, key: job.key, name: job.name, kind: job.kind,
        dependsOn: JSON.parse(job.depends_on) as string[], maxAttempts: job.max_attempts,
        status: job.status, result: job.result, error: job.error,
        attempts: this.db.query<{ number: number; status: string; pid: number | null; startedAt: number; finishedAt: number | null }, [string]>(
          "SELECT number,status,pid,started_at AS startedAt,finished_at AS finishedAt FROM attempts WHERE job_id=? ORDER BY number").all(job.id)
      })) };
  }
  create(input: Definition, legacy = false, key?: string, content?: string) {
    return this.db.transaction(() => {
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db.query("INSERT INTO workflows(id,name,concurrency,status,created_at,updated_at,legacy) VALUES(?,?,?,'queued',?,?,?)")
        .run(id, input.name, input.concurrency, now, now, legacy ? 1 : 0);
      for (const job of input.jobs) {
        const jobId = crypto.randomUUID();
        this.db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)")
          .run(jobId, job.name, job.kind, now, now);
        this.db.query("INSERT INTO workflow_nodes VALUES(?,?,?,?,?)")
          .run(jobId, id, job.key, JSON.stringify(job.dependsOn), job.maxAttempts);
      }
      if (key) this.db.query("INSERT INTO idempotency VALUES(?,?,?)").run(key, content!, id);
      this.event(id, "workflow.created");
      return id;
    })();
  }
  recover() {
    this.db.transaction(() => {
      for (const workflow of this.db.query<WorkflowRow, []>("SELECT * FROM workflows WHERE status IN ('queued','running')").all()) {
        for (const job of this.nodes(workflow.id)) {
          const running = this.db.query<{ number: number }, [string]>("SELECT number FROM attempts WHERE job_id=? AND status='running'").all(job.id);
          for (const attempt of running) {
            const status = workflow.cancel_requested ? "cancelled" : "interrupted";
            this.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?")
              .run(status, Date.now(), job.id, attempt.number);
            this.event(workflow.id, `job.${status}`, job.key, attempt.number);
          }
          if (job.status === "running") this.db.query("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(Date.now(), job.id);
        }
        if (workflow.cancel_requested) this.finishCancellation(workflow.id);
      }
    })();
  }
  finishCancellation(id: string) {
    for (const job of this.nodes(id)) {
      if (job.status !== "queued" && job.status !== "running") continue;
      this.db.query("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), job.id);
      const already = this.db.query("SELECT 1 FROM events WHERE workflow_id=? AND job_key=? AND type='job.cancelled'").get(id, job.key);
      if (!already) this.event(id, "job.cancelled", job.key, job.attempt || null);
    }
    this.db.query("UPDATE workflows SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), id);
    this.event(id, "workflow.cancelled");
  }
}
