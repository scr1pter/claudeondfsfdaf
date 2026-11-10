import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, Definition, LegacyJob, NodeRow, WorkflowRow } from "./model";

export class Store {
  readonly db: Database;
  constructor(directory: string, root: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "workflow.sqlite"));
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      // DDL, legacy adoption and the version marker commit together.
      this.atomic(() => {
        this.db.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));
        const version = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
        if (version !== "1" && version !== "2") throw new Error(`Unsupported schema version: ${version}`);
        this.db.exec(readFileSync(join(root, "sql/v2.sql"), "utf8"));
        const orphaned = this.db.query<LegacyJob, []>("SELECT * FROM jobs WHERE id NOT IN (SELECT job_id FROM workflow_jobs) AND status IN ('queued','running')").all();
        for (const job of orphaned) {
          const id = crypto.randomUUID();
          this.db.query("INSERT INTO workflows VALUES(?,?,?,?,?,?,1)").run(id, job.name, 1, job.status, job.created_at, job.updated_at);
          this.db.query("INSERT INTO workflow_jobs VALUES(?,?,?,'[]',1,0)").run(job.id, id, "job");
          this.event(id, "workflow.created");
          if (job.status === "running") {
            this.db.query("INSERT INTO attempts VALUES(?,?,'running',NULL,?,NULL)").run(job.id, Math.max(1, job.attempt), job.updated_at);
          }
        }
        this.db.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
      });
      this.recover();
      } catch (failure) {
      this.db.close();
      throw failure;
    }
  }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  event(workflowId: string, type: string, jobKey?: string, attempt?: number) {
    this.db.query(`INSERT INTO events(workflow_id,seq,type,created_at,job_key,attempt)
      VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE workflow_id=?),?,?,?,?)`)
      .run(workflowId, workflowId, type, Date.now(), jobKey ?? null, attempt ?? null);
  }
  row(id: string) { return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id); }
  nodes(id: string) {
    return this.db.query<NodeRow, [string]>(`SELECT j.*, w.workflow_id,w.key,w.dependencies,w.max_attempts,w.position
      FROM jobs j JOIN workflow_jobs w ON j.id=w.job_id WHERE w.workflow_id=? ORDER BY w.position`).all(id);
  }
  attempts(jobId: string) {
    return this.db.query<Attempt, [string]>(`SELECT number,status,pid,started_at AS startedAt,finished_at AS finishedAt
      FROM attempts WHERE job_id=? ORDER BY number`).all(jobId);
  }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) return null;
    return {
      id: row.id, name: row.name, concurrency: row.concurrency, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      jobs: this.nodes(id).map(job => ({ id: job.id, key: job.key, name: job.name, kind: job.kind,
        dependsOn: JSON.parse(job.dependencies) as string[], maxAttempts: job.max_attempts,
        status: job.status, attempts: this.attempts(job.id), result: job.result, error: job.error })),
    };
  }
  list() {
    return this.db.query<{ id: string }, []>("SELECT id FROM workflows WHERE is_legacy=0 ORDER BY created_at DESC,id").all().map(row => this.workflow(row.id));
  }
  legacyJobs() {
    return this.db.query<LegacyJob, []>(`SELECT * FROM jobs WHERE id NOT IN
      (SELECT wj.job_id FROM workflow_jobs wj JOIN workflows w ON w.id=wj.workflow_id WHERE w.is_legacy=0)
      ORDER BY created_at,id`).all();
  }
  legacyJob(id: string) { return this.legacyJobs().find(job => job.id === id); }
  create(definition: Definition, legacy = false) {
    const id = crypto.randomUUID(), now = Date.now();
    this.db.query("INSERT INTO workflows VALUES(?,?,?,'queued',?,?,?)").run(id, definition.name, definition.concurrency, now, now, legacy ? 1 : 0);
    definition.jobs.forEach((job, position) => {
      const jobId = crypto.randomUUID();
      this.db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)").run(jobId, job.name, job.kind, now, now);
      this.db.query("INSERT INTO workflow_jobs VALUES(?,?,?,?,?,?)").run(jobId, id, job.key, JSON.stringify(job.dependsOn), job.maxAttempts, position);
    });
    this.event(id, "workflow.created");
    return id;
  }
  events(id: string, after: number) {
    return this.db.query<{ seq: number; type: string; createdAt: number; jobKey: string | null; attempt: number | null }, [string, number]>(
      "SELECT seq,type,created_at AS createdAt,job_key AS jobKey,attempt FROM events WHERE workflow_id=? AND seq>? ORDER BY seq").all(id, after)
      .map(({ jobKey, attempt, ...event }) => ({ ...event, ...(jobKey === null ? {} : { jobKey }), ...(attempt === null ? {} : { attempt }) }));
  }
  private recover() {
    this.atomic(() => {
      const running = this.db.query<{ job_id: string; number: number; workflow_id: string; key: string }, []>(
        `SELECT a.job_id,a.number,w.workflow_id,w.key FROM attempts a JOIN workflow_jobs w ON w.job_id=a.job_id WHERE a.status='running'`).all();
      for (const attempt of running) {
        const now = Date.now();
        this.db.query("UPDATE attempts SET status='interrupted',finished_at=? WHERE job_id=? AND number=?").run(now, attempt.job_id, attempt.number);
        this.db.query("UPDATE jobs SET status='queued',attempt=MAX(attempt,?),updated_at=? WHERE id=? AND status='running'").run(attempt.number, now, attempt.job_id);
        this.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(now, attempt.workflow_id);
        this.event(attempt.workflow_id, "job.interrupted", attempt.key, attempt.number);
      }
    });
  }
}

