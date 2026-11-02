import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Kind = "succeed" | "fail" | "fail_once" | "block";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
type WorkflowStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type AttemptStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
type Definition = { key: string; name: string; kind: Kind; dependsOn: string[]; maxAttempts: number };
type Input = { name: string; concurrency: number; jobs: Definition[] };
type Job = {
  id: string; name: string; kind: Kind; status: JobStatus; attempt: number;
  result: string | null; error: string | null; created_at: number; updated_at: number;
};
type Node = Job & { workflow_id: string; key: string; depends_on: string; max_attempts: number };
type WorkflowRow = {
  id: string; name: string; concurrency: number; status: WorkflowStatus;
  created_at: number; updated_at: number; legacy: number;
};
type Attempt = { number: number; status: AttemptStatus; pid: number | null; startedAt: number; finishedAt: number | null };
type Event = { seq: number; type: string; createdAt: number; jobKey?: string; attempt?: number };
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
type Active = { child: Child; workflowId: string; done: Promise<void> };
const terminal = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const kinds = new Set(["succeed", "fail", "fail_once", "block"]);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function name(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120)
    throw new TypeError(`${field} must be a nonempty name of at most 120 characters.`);
  return value.trim();
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3)
    throw new TypeError(`${field} must be an integer from 1 to 3.`);
  return value;
}
export function validateWorkflow(value: unknown): Input {
  if (!object(value)) throw new TypeError("Workflow must be a JSON object.");
  const workflowName = name(value.name, "Workflow name");
  const concurrency = integer(value.concurrency, "Concurrency");
  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 40)
    throw new TypeError("A workflow must contain 1–40 jobs.");
  const keys = new Set<string>();
  const jobs: Definition[] = value.jobs.map((job, index) => {
    if (!object(job)) throw new TypeError(`Job ${index + 1} must be an object.`);
    if (typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key) || keys.has(job.key))
      throw new TypeError("Job keys must be unique and start with a letter (1–32 letters, digits, _ or -).");
    keys.add(job.key);
    if (typeof job.kind !== "string" || !kinds.has(job.kind))
      throw new TypeError(`Job ${job.key} has an invalid kind.`);
    const deps = job.dependsOn === undefined ? [] : job.dependsOn;
    if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== "string") || new Set(deps).size !== deps.length)
      throw new TypeError(`Job ${job.key}: dependsOn must be an array of unique keys.`);
    return { key: job.key, name: name(job.name, `Job ${job.key} name`), kind: job.kind as Kind,
      dependsOn: deps, maxAttempts: job.maxAttempts === undefined ? 1 : integer(job.maxAttempts, "maxAttempts") };
  });
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new TypeError("Dependencies must not contain a cycle or self-dependency.");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)!.dependsOn) {
      if (!byKey.has(dep)) throw new TypeError(`Job ${key} refers to missing predecessor ${dep}.`);
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
  }
  jobs.forEach((job) => visit(job.key));
  return { name: workflowName, concurrency, jobs };
}

// Sort object keys recursively; preserve array order and all original JSON contents.
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class WorkflowRunner {
  private db: Database;
  private root: string;
  private markers: string;
  private worker: string;
  private limit: number;
  private active = new Map<string, Active>();
  private cancelling = new Map<string, Promise<void>>();
  private stopping = false;
  private recoveryReadyAt = 0;
  private interval?: ReturnType<typeof setInterval>;

  constructor({ directory, root }: { directory: string; root: string }) {
    this.root = root;
    this.markers = process.env.WORKFLOW_MARKER_DIR ?? join(directory, "markers");
    this.worker = process.env.WORKFLOW_WORKER_PATH ?? join(root, "server/worker.ts");
    const requested = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
    this.limit = Number.isInteger(requested) && requested >= 1 && requested <= 3 ? requested : 2;
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "workflow.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.migrate();
    this.recover();
  }

  private migrate() {
    this.db.transaction(() => {
      this.db.exec(readFileSync(join(this.root, "sql/v1.sql"), "utf8"));
      const version = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value;
      if (!["1", "2"].includes(version)) throw new Error(`Unsupported schema version: ${version}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          legacy INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, request_identity TEXT
        );
        CREATE TABLE IF NOT EXISTS workflow_nodes (
          id TEXT PRIMARY KEY REFERENCES jobs(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
          key TEXT NOT NULL, depends_on TEXT NOT NULL, max_attempts INTEGER NOT NULL,
          UNIQUE(workflow_id,key)
        );
        CREATE INDEX IF NOT EXISTS nodes_workflow ON workflow_nodes(workflow_id);
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
      `);
      if (version === "1") {
        const legacy = this.db.query<Job, []>("SELECT * FROM jobs").all();
        for (const job of legacy) {
          const id = crypto.randomUUID();
          const status = job.status === "running" ? "running" : job.status === "blocked" ? "failed" : job.status;
          this.db.query("INSERT INTO workflows(id,name,concurrency,status,created_at,updated_at,legacy) VALUES(?,?,1,?,?,?,1)")
            .run(id, job.name, status, job.created_at, job.updated_at);
          this.db.query("INSERT INTO workflow_nodes VALUES(?,?,?,'[]',1)").run(job.id, id, "job");
          if (job.attempt > 0 && ["running", "succeeded", "failed", "cancelled"].includes(job.status))
            this.db.query("INSERT INTO attempts VALUES(?,?,?,?,?,?)")
              .run(job.id, job.attempt, job.status, null, job.created_at, job.status === "running" ? null : job.updated_at);
        }
      }
      this.db.query("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    })();
  }

  private recover() {
    this.db.transaction(() => {
      const running = this.db.query<Node, []>(`SELECT j.*,n.workflow_id,n.key,n.depends_on,n.max_attempts
        FROM jobs j JOIN workflow_nodes n ON n.id=j.id WHERE j.status='running'`).all();
      // Give the old fixture's 20ms parent watchdog time to exit after a crash,
      // without ever signalling a persisted PID that could now belong to someone else.
      if (running.length) this.recoveryReadyAt = Date.now() + 100;
      for (const job of running) {
        const now = Date.now();
        this.db.query("UPDATE attempts SET status='interrupted',finished_at=? WHERE job_id=? AND status='running'").run(now, job.id);
        this.db.query("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(now, job.id);
        this.event(job.workflow_id, "job.interrupted", job.key, job.attempt);
      }
    })();
  }

  private rows(id: string) {
    return this.db.query<Node, [string]>(`SELECT j.*,n.workflow_id,n.key,n.depends_on,n.max_attempts
      FROM jobs j JOIN workflow_nodes n ON n.id=j.id WHERE n.workflow_id=? ORDER BY n.rowid`).all(id);
  }
  private row(id: string) {
    return this.db.query<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id=?").get(id);
  }
  workflow(id: string) {
    const row = this.row(id);
    if (!row) return null;
    return { id: row.id, name: row.name, concurrency: row.concurrency, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      jobs: this.rows(id).map((job) => ({ id: job.id, key: job.key, name: job.name, kind: job.kind,
        dependsOn: JSON.parse(job.depends_on) as string[], maxAttempts: job.max_attempts,
        status: job.status, result: job.result, error: job.error,
        attempts: this.db.query<Attempt, [string]>(`SELECT number,status,pid,started_at AS startedAt,finished_at AS finishedAt
          FROM attempts WHERE job_id=? ORDER BY number`).all(job.id),
      })),
    };
  }
  workflows() {
    return this.db.query<{ id: string }, []>("SELECT id FROM workflows WHERE legacy=0 ORDER BY created_at DESC,rowid DESC")
      .all().map(({ id }) => this.workflow(id)!);
  }
  legacyJobs() {
    return this.db.query<Job, []>(`SELECT j.* FROM jobs j JOIN workflow_nodes n ON n.id=j.id
      JOIN workflows w ON w.id=n.workflow_id WHERE w.legacy=1 ORDER BY j.created_at,j.id`).all();
  }
  legacyJob(id: string) {
    return this.db.query<Job, [string]>(`SELECT j.* FROM jobs j JOIN workflow_nodes n ON n.id=j.id
      JOIN workflows w ON w.id=n.workflow_id WHERE w.legacy=1 AND j.id=?`).get(id);
  }
  replay(key: string) {
    return this.db.query<{ id: string; identity: string }, [string]>(
      "SELECT id,request_identity AS identity FROM workflows WHERE idempotency_key=?").get(key);
  }
  create(input: Input, key: string | null, identity: string | null, legacy = false) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO workflows(id,name,concurrency,status,created_at,updated_at,legacy,idempotency_key,request_identity)
        VALUES(?,?,?,'queued',?,?,?,?,?)`).run(id, input.name, input.concurrency, now, now, legacy ? 1 : 0, key, identity);
      for (const job of input.jobs) {
        const jobId = crypto.randomUUID();
        this.db.query("INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)")
          .run(jobId, job.name, job.kind, now, now);
        this.db.query("INSERT INTO workflow_nodes VALUES(?,?,?,?,?)")
          .run(jobId, id, job.key, JSON.stringify(job.dependsOn), job.maxAttempts);
      }
      this.event(id, "workflow.created");
    })();
    return this.workflow(id)!;
  }
  private event(id: string, type: string, jobKey?: string, attempt?: number) {
    this.db.query(`INSERT INTO events(workflow_id,seq,type,created_at,job_key,attempt)
      SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,? FROM events WHERE workflow_id=?`)
      .run(id, type, Date.now(), jobKey ?? null, attempt ?? null, id);
    this.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), id);
  }
  events(id: string, after: number): Event[] {
    return this.db.query<{ seq: number; type: string; created_at: number; job_key: string | null; attempt: number | null }, [string, number]>(
      "SELECT * FROM events WHERE workflow_id=? AND seq>? ORDER BY seq").all(id, after).map((event) => ({
        seq: event.seq, type: event.type, createdAt: event.created_at,
        ...(event.job_key === null ? {} : { jobKey: event.job_key }),
        ...(event.attempt === null ? {} : { attempt: event.attempt }),
      }));
  }

  start() {
    this.interval = setInterval(() => this.dispatch(), 40);
    this.dispatch();
  }
  private settle(id: string) {
    const workflow = this.row(id)!;
    if (!["queued", "running"].includes(workflow.status) || this.cancelling.has(id)) return;
    this.db.transaction(() => {
      const jobs = this.rows(id);
      const byKey = new Map(jobs.map((job) => [job.key, job]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const job of jobs) {
          const deps = JSON.parse(job.depends_on) as string[];
          if (job.status === "queued" && deps.some((key) => ["failed", "blocked", "cancelled"].includes(byKey.get(key)!.status))) {
            job.status = "blocked";
            this.db.query("UPDATE jobs SET status='blocked',error=?,updated_at=? WHERE id=?")
              .run("A predecessor did not succeed.", Date.now(), job.id);
            this.event(id, "job.blocked", job.key);
            changed = true;
          }
        }
      }
      if (jobs.every((job) => terminal.has(job.status))) {
        const status = jobs.every((job) => job.status === "succeeded") ? "succeeded" : "failed";
        this.db.query("UPDATE workflows SET status=? WHERE id=?").run(status, id);
        this.event(id, `workflow.${status}`);
      }
    })();
  }
  private dispatch() {
    if (this.stopping || Date.now() < this.recoveryReadyAt) return;
    const workflows = this.db.query<WorkflowRow, []>("SELECT * FROM workflows WHERE status IN ('queued','running') ORDER BY created_at,rowid").all();
    for (const workflow of workflows) this.settle(workflow.id);
    let progress = true;
    while (this.active.size < this.limit && progress) {
      progress = false;
      for (const workflow of workflows) {
        if (this.active.size >= this.limit) break;
        if (this.cancelling.has(workflow.id) || !["queued", "running"].includes(this.row(workflow.id)!.status)) continue;
        const count = [...this.active.values()].filter((entry) => entry.workflowId === workflow.id).length;
        if (count >= workflow.concurrency) continue;
        const jobs = this.rows(workflow.id);
        const byKey = new Map(jobs.map((job) => [job.key, job]));
        const eligible = jobs.find((job) => job.status === "queued" &&
          (JSON.parse(job.depends_on) as string[]).every((key) => byKey.get(key)!.status === "succeeded"));
        if (eligible) {
          this.launch(eligible);
          progress = true;
        }
      }
    }
  }

  private launch(job: Node) {
    const number = job.attempt + 1;
    let child: Child;
    try {
      child = Bun.spawn([process.execPath, this.worker, "--job-id", job.id, "--attempt", String(number), "--kind", job.kind], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKFLOW_MARKER_DIR: this.markers, WORKFLOW_PARENT_PID: String(process.pid) },
      });
    } catch (failure) {
      this.db.transaction(() => {
        this.db.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(job.id, number, Date.now(), Date.now());
        this.db.query("UPDATE jobs SET attempt=? WHERE id=?").run(number, job.id);
        this.failed(job, number, `Could not start worker: ${String(failure)}`);
      })();
      return;
    }
    // No await between spawn, persistence and active-slot reservation: an API request
    // or another dispatch cannot observe an unregistered live child.
    this.db.transaction(() => {
      this.db.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(job.id, number, child.pid, Date.now());
      this.db.query("UPDATE jobs SET status='running',attempt=?,error=NULL,updated_at=? WHERE id=?").run(number, Date.now(), job.id);
      this.db.query("UPDATE workflows SET status='running' WHERE id=?").run(job.workflow_id);
      this.event(job.workflow_id, "job.started", job.key, number);
    })();
    const entry: Active = { child, workflowId: job.workflow_id, done: Promise.resolve() };
    this.active.set(job.id, entry);
    entry.done = this.finish(job, number, child).finally(() => {
      this.active.delete(job.id);
      if (!this.stopping) {
        this.settle(job.workflow_id);
        this.dispatch();
      }
    });
  }
  private failed(job: Node, number: number, message: string) {
    this.db.query("UPDATE attempts SET status='failed',finished_at=? WHERE job_id=? AND number=?").run(Date.now(), job.id, number);
    const failures = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM attempts WHERE job_id=? AND status='failed'").get(job.id)!.count;
    const retry = failures < job.max_attempts;
    this.db.query("UPDATE jobs SET status=?,result=NULL,error=?,updated_at=? WHERE id=?")
      .run(retry ? "queued" : "failed", message.slice(0, 4000), Date.now(), job.id);
    this.event(job.workflow_id, "job.failed", job.key, number);
    if (retry) this.event(job.workflow_id, "job.retrying", job.key, number);
  }
  private async finish(job: Node, number: number, child: Child) {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
      child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
    ]);
    if (this.stopping || this.cancelling.has(job.workflow_id) || this.row(job.workflow_id)?.status === "cancelled") return;
    this.db.transaction(() => {
      if (code === 0) {
        this.db.query("UPDATE attempts SET status='succeeded',finished_at=? WHERE job_id=? AND number=?").run(Date.now(), job.id, number);
        this.db.query("UPDATE jobs SET status='succeeded',result=?,error=NULL,updated_at=? WHERE id=?").run(stdout.trim(), Date.now(), job.id);
        this.event(job.workflow_id, "job.succeeded", job.key, number);
      } else {
        this.failed(job, number, stderr.trim() || stdout.trim() || `Worker exited with code ${code}.`);
      }
    })();
  }

  async cancel(id: string) {
    if (this.cancelling.has(id)) return this.cancelling.get(id);
    if (this.row(id)?.status === "cancelled") return;
    // Install the guard before yielding; it stays set until all workers are reaped
    // and the cancellation and its events have committed together.
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    this.cancelling.set(id, pending);
    try {
      const children = [...this.active.values()].filter((entry) => entry.workflowId === id);
      for (const entry of children) entry.child.kill("SIGKILL");
      await Promise.all(children.map((entry) => entry.done));
      this.db.transaction(() => {
        for (const job of this.rows(id)) {
          if (!["queued", "running"].includes(job.status)) continue;
          this.db.query("UPDATE attempts SET status='cancelled',finished_at=? WHERE job_id=? AND status='running'").run(Date.now(), job.id);
          this.db.query("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), job.id);
          this.event(id, "job.cancelled", job.key, job.attempt || undefined);
        }
        this.db.query("UPDATE workflows SET status='cancelled' WHERE id=?").run(id);
        this.event(id, "workflow.cancelled");
      })();
    } finally {
      this.cancelling.delete(id);
      complete();
    }
    this.dispatch();
  }

  async close() {
    this.stopping = true;
    clearInterval(this.interval);
    for (const entry of this.active.values()) entry.child.kill("SIGKILL");
    await Promise.all([...this.active.values()].map((entry) => entry.done));
    // Unfinished rows stay durable; recovery retains them as interrupted attempts.
    this.db.close();
  }
}
