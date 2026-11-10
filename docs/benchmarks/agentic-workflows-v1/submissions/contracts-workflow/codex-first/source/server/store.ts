import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Definition, LegacyJob, Node, WorkflowRow } from "./types";

export class Store {
  db: Database;
  constructor(directory: string, root: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "workflow.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.db.transaction(() => {
      this.db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          legacy INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS nodes (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
          key TEXT NOT NULL, depends_on TEXT NOT NULL, max_attempts INTEGER NOT NULL,
          UNIQUE(workflow_id,key)
        );
        CREATE INDEX IF NOT EXISTS nodes_workflow ON nodes(workflow_id);
        CREATE TABLE IF NOT EXISTS attempts (
          job_id TEXT NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL,
          status TEXT NOT NULL, pid INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER,
          PRIMARY KEY(job_id,number)
        );
        CREATE TABLE IF NOT EXISTS events (
          workflow_id TEXT NOT NULL REFERENCES workflows(id), seq INTEGER NOT NULL,
          type TEXT NOT NULL, created_at INTEGER NOT NULL, job_key TEXT, attempt INTEGER,
          PRIMARY KEY(workflow_id,seq)
        );
        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY, request TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id)
        );
      `);
      // Attach original v1 rows without rewriting their fields or rerunning completed work.
      const legacy = this.db.query<LegacyJob, []>(
        "SELECT jobs.* FROM jobs LEFT JOIN nodes ON nodes.job_id=jobs.id WHERE nodes.job_id IS NULL").all();
      for (const job of legacy) {
        const id = crypto.randomUUID();
        this.db.query("INSERT INTO workflows VALUES(?,?,?,?,?,?,1)")
          .run(id, job.name, 1, job.status, job.created_at, job.updated_at);
        this.db.query("INSERT INTO nodes VALUES(?,?,?,'[]',1)").run(job.id, id, "job");
        if (job.attempt > 0) this.db.query("INSERT INTO attempts VALUES(?,?,?,?,?,?)")
          .run(job.id, job.attempt, job.status === "queued" ? "interrupted" : job.status,
            null, job.created_at, job.status === "running" ? null : job.updated_at);
      }
      this.db.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    })();
    this.recover();
  }

  event(id: string, type: string, jobKey?: string, attempt?: number) {
    this.db.query(`INSERT INTO events(workflow_id,seq,type,created_at,job_key,attempt)
      VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE workflow_id=?),?,?,?,?)`)
      .run(id, id, type, Date.now(), jobKey ?? null, attempt ?? null);
    this.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), id);
  }
  recover() {
    this.db.transaction(() => {
      const running = this.db.query<Node, []>(`SELECT jobs.*,nodes.* FROM jobs JOIN nodes ON nodes.job_id=jobs.id
        WHERE jobs.status='running'`).all();
      for (const job of running) {
        this.db.query("UPDATE attempts SET status='interrupted',finished_at=? WHERE job_id=? AND status='running'")
          .run(Date.now(), job.id);
        this.db.query("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(Date.now(), job.id);
        this.event(job.workflow_id, "job.interrupted", job.key, job.attempt);
        this.event(job.workflow_id, "job.retrying", job.key, job.attempt);
      }
      this.db.query("UPDATE workflows SET status='queued' WHERE status='running'").run();
    })();
  }
  row(id: string) { return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id); }
  nodes(id: string) {
    return this.db.query<Node, [string]>(`SELECT jobs.*,nodes.* FROM nodes JOIN jobs ON jobs.id=nodes.job_id
      WHERE workflow_id=? ORDER BY nodes.rowid`).all(id);
  }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) return null;
    return { id: row.id, name: row.name, concurrency: row.concurrency, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, jobs: this.nodes(id).map(job => ({
        id: job.id, key: job.key, name: job.name, kind: job.kind, dependsOn: JSON.parse(job.depends_on) as string[],
        maxAttempts: job.max_attempts, status: job.status, result: job.result, error: job.error,
        attempts: this.db.query<{
          number: number; status: string; pid: number | null; startedAt: number; finishedAt: number | null;
        }, [string]>(`SELECT number,status,pid,started_at AS startedAt,finished_at AS finishedAt
          FROM attempts WHERE job_id=? ORDER BY number`).all(job.id),
      })) };
  }
  legacy(id?: string) {
    return this.db.query<LegacyJob, [string | null, string | null]>(`SELECT jobs.* FROM jobs JOIN nodes ON nodes.job_id=jobs.id
      JOIN workflows ON workflows.id=nodes.workflow_id WHERE workflows.legacy=1 AND (? IS NULL OR jobs.id=?)
      ORDER BY jobs.created_at,jobs.id`).all(id ?? null, id ?? null);
  }
  create(definition: Definition, legacy = false, key?: string, request?: string) {
    return this.db.transaction(() => {
      const id = crypto.randomUUID(), now = Date.now();
      this.db.query("INSERT INTO workflows VALUES(?,?,?,'queued',?,?,?)")
        .run(id, definition.name, definition.concurrency, now, now, legacy ? 1 : 0);
      for (const job of definition.jobs) {
        const jobId = crypto.randomUUID();
        this.db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)")
          .run(jobId, job.name, job.kind, now, now);
        this.db.query("INSERT INTO nodes VALUES(?,?,?,?,?)")
          .run(jobId, id, job.key, JSON.stringify(job.dependsOn), job.maxAttempts);
      }
      this.event(id, "workflow.created");
      if (key !== undefined) this.db.query("INSERT INTO idempotency VALUES(?,?,?)").run(key, request!, id);
      return this.workflow(id)!;
    })();
  }
}
