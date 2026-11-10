import type { Store } from "./store";
import type { Node } from "./types";

type Worker = Bun.Subprocess<"ignore", "pipe", "pipe">;
type Live = { child: Worker; workflowId: string; done: Promise<void> };
const terminal = new Set(["succeeded", "failed", "blocked", "cancelled"]);

export class Runner {
  live = new Map<string, Live>();
  cancellations = new Map<string, Promise<void>>();
  stopping = false;
  interval: ReturnType<typeof setInterval>;
  constructor(public store: Store, public limit: number, public worker: string, public markers: string) {
    this.interval = setInterval(() => this.tick(), 40);
  }
  settle(id: string) {
    const { db } = this.store;
    const workflow = this.store.row(id)!;
    if (terminal.has(workflow.status)) return;
    const jobs = this.store.nodes(id);
    const byKey = new Map(jobs.map(job => [job.key, job]));
    let changed: boolean;
    do {
      changed = false;
      for (const job of jobs) {
        if (job.status !== "queued") continue;
        const blocked = (JSON.parse(job.depends_on) as string[]).find(key =>
          ["failed", "blocked", "cancelled"].includes(byKey.get(key)!.status));
        if (blocked) {
          job.status = "blocked";
          db.query("UPDATE jobs SET status='blocked',error=?,updated_at=? WHERE id=?")
            .run(`Predecessor ${blocked} did not succeed.`, Date.now(), job.id);
          this.store.event(id, "job.blocked", job.key);
          changed = true;
        }
      }
    } while (changed);
    if (jobs.every(job => terminal.has(job.status))) {
      const status = jobs.every(job => job.status === "succeeded") ? "succeeded" : "failed";
      db.query("UPDATE workflows SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), id);
      this.store.event(id, `workflow.${status}`);
    }
  }
  tick() {
    if (this.stopping) return;
    const workflows = this.store.db.query<{ id: string; concurrency: number }, []>(
      "SELECT id,concurrency FROM workflows WHERE status IN ('queued','running') ORDER BY created_at,rowid").all();
    for (const workflow of workflows) {
      this.store.db.transaction(() => this.settle(workflow.id))();
      if (this.live.size >= this.limit) continue;
      const jobs = this.store.nodes(workflow.id);
      const byKey = new Map(jobs.map(job => [job.key, job]));
      let running = [...this.live.values()].filter(value => value.workflowId === workflow.id).length;
      for (const job of jobs) {
        if (this.live.size >= this.limit || running >= workflow.concurrency) break;
        if (job.status !== "queued" || this.live.has(job.id)) continue;
        if (!(JSON.parse(job.depends_on) as string[]).every(key => byKey.get(key)!.status === "succeeded")) continue;
        this.launch(job); running++;
      }
    }
  }
  launch(job: Node) {
    const number = job.attempt + 1;
    let child: Worker;
    try {
      child = Bun.spawn([process.execPath, this.worker, "--job-id", job.id, "--attempt", String(number), "--kind", job.kind], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKFLOW_MARKER_DIR: this.markers, WORKFLOW_PARENT_PID: String(process.pid) },
      });
    } catch (failure) {
      this.store.db.transaction(() => {
        this.store.db.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(job.id, number, Date.now(), Date.now());
        this.finish(job, number, false, null, `Could not start worker: ${String(failure)}`);
      })();
      return;
    }
    this.store.db.transaction(() => {
      this.store.db.query("UPDATE jobs SET status='running',attempt=?,updated_at=? WHERE id=?").run(number, Date.now(), job.id);
      this.store.db.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(job.id, number, child.pid, Date.now());
      this.store.db.query("UPDATE workflows SET status='running',updated_at=? WHERE id=?").run(Date.now(), job.workflow_id);
      this.store.event(job.workflow_id, "job.started", job.key, number);
    })();
    const entry: Live = { child, workflowId: job.workflow_id, done: Promise.resolve() };
    this.live.set(job.id, entry);
    entry.done = (async () => {
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (this.stopping) return;
        this.store.db.transaction(() => {
          const attempt = this.store.db.query<{ status: string }, [string, number]>(
            "SELECT status FROM attempts WHERE job_id=? AND number=?").get(job.id, number);
          if (attempt?.status !== "running") return;
          this.store.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?")
            .run(code === 0 ? "succeeded" : "failed", Date.now(), job.id, number);
          this.finish(job, number, code === 0, stdout.trim(), stderr.trim() || `Worker exited with code ${code}.`);
        })();
      } finally {
        this.live.delete(job.id); this.tick();
      }
    })();
  }
  finish(job: Node, number: number, success: boolean, result: string | null, error: string) {
    const failures = this.store.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM attempts WHERE job_id=? AND status='failed'").get(job.id)!.count;
    const retry = !success && failures < job.max_attempts;
    this.store.db.query("UPDATE jobs SET status=?,attempt=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(success ? "succeeded" : retry ? "queued" : "failed", number, success ? result : null,
        success ? null : error.slice(0, 4000), Date.now(), job.id);
    this.store.event(job.workflow_id, success ? "job.succeeded" : "job.failed", job.key, number);
    if (retry) this.store.event(job.workflow_id, "job.retrying", job.key, number);
    this.settle(job.workflow_id);
  }
  async cancel(id: string) {
    const pending = this.cancellations.get(id);
    if (pending) return pending;
    this.store.db.transaction(() => {
      for (const job of this.store.nodes(id)) {
        if (job.status !== "queued" && job.status !== "running") continue;
        this.store.db.query("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), job.id);
        this.store.db.query("UPDATE attempts SET status='cancelled',finished_at=? WHERE job_id=? AND status='running'")
          .run(Date.now(), job.id);
        this.store.event(id, "job.cancelled", job.key, job.status === "running" ? job.attempt : undefined);
      }
      this.store.db.query("UPDATE workflows SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), id);
      this.store.event(id, "workflow.cancelled");
    })();
    const entries = [...this.live.values()].filter(entry => entry.workflowId === id);
    for (const entry of entries) entry.child.kill("SIGKILL");
    const done = Promise.all(entries.map(entry => entry.done)).then(() => {});
    this.cancellations.set(id, done);
    try { await done; }
    finally { this.cancellations.delete(id); }
  }
  async stop() {
    this.stopping = true; clearInterval(this.interval);
    const entries = [...this.live.values()];
    // Leave in-flight records for recovery, without turning shutdown into a worker failure.
    for (const entry of entries) entry.child.kill("SIGKILL");
    await Promise.all(entries.map(entry => entry.done));
  }
}
