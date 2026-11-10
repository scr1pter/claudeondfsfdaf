import { join } from "node:path";
import { Store, type Node, type WorkflowRow } from "./store";

type Live = { child: ReturnType<typeof Bun.spawn>; workflowId: string; done: Promise<void> };
export class Runner {
  live = new Map<string, Live>();
  cancellations = new Map<string, Promise<void>>();
  stopping = false;
  private ticking = false;
  private interval: ReturnType<typeof setInterval>;
  private limit: number;
  constructor(private store: Store, private root: string, private directory: string) {
    const value = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
    this.limit = Number.isInteger(value) && value >= 1 && value <= 3 ? value : 2;
    this.interval = setInterval(() => this.tick(), 40);
  }
  tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      const workflows = this.store.db.query<WorkflowRow, []>(
        "SELECT * FROM workflows WHERE status IN ('queued','running') AND cancel_requested=0 ORDER BY created_at,rowid").all();
      for (const workflow of workflows) {
        this.settle(workflow.id);
        if (!['queued', 'running'].includes(this.store.row(workflow.id)!.status)) continue;
        let active = [...this.live.values()].filter(item => item.workflowId === workflow.id).length;
        for (const job of this.store.nodes(workflow.id)) {
          if (this.live.size >= this.limit || active >= workflow.concurrency) break;
          if (job.status !== "queued") continue;
          const nodes = this.store.nodes(workflow.id);
          const dependencies = JSON.parse(job.depends_on) as string[];
          if (!dependencies.every(key => nodes.find(node => node.key === key)?.status === "succeeded")) continue;
          this.start(job);
          active++;
        }
      }
    } finally { this.ticking = false; }
  }
  private settle(id: string) {
    this.store.db.transaction(() => {
      let changed = true;
      while (changed) {
        changed = false;
        const nodes = this.store.nodes(id);
        for (const job of nodes) {
          if (job.status !== "queued") continue;
          if (!(JSON.parse(job.depends_on) as string[]).some(key =>
            ["failed", "blocked", "cancelled"].includes(nodes.find(node => node.key === key)!.status))) continue;
          this.store.db.query("UPDATE jobs SET status='blocked',error=?,updated_at=? WHERE id=?")
            .run("A predecessor did not succeed.", Date.now(), job.id);
          this.store.event(id, "job.blocked", job.key);
          changed = true;
        }
      }
      const nodes = this.store.nodes(id);
      if (nodes.some(job => job.status === "queued" || job.status === "running")) return;
      const status = nodes.every(job => job.status === "succeeded") ? "succeeded" : "failed";
      this.store.db.query("UPDATE workflows SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), id);
      this.store.event(id, `workflow.${status}`);
    })();
  }
  private start(job: Node) {
    const attempt = job.attempt + 1;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([process.execPath, process.env.WORKFLOW_WORKER_PATH ?? join(this.root, "server/worker.ts"),
        "--job-id", job.id, "--attempt", String(attempt), "--kind", job.kind], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKFLOW_MARKER_DIR: process.env.WORKFLOW_MARKER_DIR ?? join(this.directory, "markers"),
          WORKFLOW_PARENT_PID: String(process.pid) }
      });
    } catch (failure) {
      this.store.db.transaction(() => {
        this.store.db.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(job.id, attempt, Date.now(), Date.now());
        this.store.db.query("UPDATE jobs SET attempt=? WHERE id=?").run(attempt, job.id);
        this.failed(job, attempt, `Could not start worker: ${String(failure)}`);
      })();
      return;
    }
    this.store.db.transaction(() => {
      this.store.db.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(job.id, attempt, child.pid, Date.now());
      this.store.db.query("UPDATE jobs SET status='running',attempt=?,updated_at=? WHERE id=?").run(attempt, Date.now(), job.id);
      this.store.db.query("UPDATE workflows SET status='running',updated_at=? WHERE id=?").run(Date.now(), job.workflow_id);
      this.store.event(job.workflow_id, "job.started", job.key, attempt);
    })();
    const done = this.collect(job, attempt, child);
    this.live.set(job.id, { child, workflowId: job.workflow_id, done });
  }
  private failed(job: Node, attempt: number, message: string) {
    const failures = this.store.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM attempts WHERE job_id=? AND status='failed'").get(job.id)!.count;
    const retry = failures < job.max_attempts;
    this.store.db.query("UPDATE jobs SET status=?,result=NULL,error=?,updated_at=? WHERE id=?")
      .run(retry ? "queued" : "failed", message.slice(0, 4096) || "Worker failed.", Date.now(), job.id);
    this.store.event(job.workflow_id, "job.failed", job.key, attempt);
    if (retry) this.store.event(job.workflow_id, "job.retrying", job.key, attempt);
  }
  private async collect(job: Node, attempt: number, child: ReturnType<typeof Bun.spawn>) {
    // Drain both pipes immediately, retaining bounded output without deadlocking a child.
    const read = async (stream: ReadableStream<Uint8Array> | number | null | undefined, limit: number) => {
      if (!stream || typeof stream === "number") return "";
      const decoder = new TextDecoder();
      let text = "";
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = decoder.decode(value, { stream: true });
        if (text.length < limit) text += part.slice(0, limit - text.length);
      }
      return (text + decoder.decode()).trim();
    };
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, read(child.stdout, 1024 * 1024), read(child.stderr, 4096)]);
      if (this.stopping) return;
      this.store.db.transaction(() => {
        const cancelled = !!this.store.row(job.workflow_id)?.cancel_requested;
        const status = cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed";
        this.store.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?")
          .run(status, Date.now(), job.id, attempt);
        if (cancelled) {
          this.store.db.query("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(Date.now(), job.id);
          this.store.event(job.workflow_id, "job.cancelled", job.key, attempt);
        } else if (code === 0) {
          this.store.db.query("UPDATE jobs SET status='succeeded',result=?,error=NULL,updated_at=? WHERE id=?")
            .run(stdout, Date.now(), job.id);
          this.store.event(job.workflow_id, "job.succeeded", job.key, attempt);
        } else this.failed(job, attempt, stderr || `Worker exited with code ${code}.`);
      })();
    } finally {
      this.live.delete(job.id);
      this.tick();
    }
  }
  cancel(id: string): Promise<void> {
    const existing = this.cancellations.get(id);
    if (existing) return existing;
    this.store.db.query("UPDATE workflows SET cancel_requested=1 WHERE id=?").run(id);
    const children = [...this.live.values()].filter(item => item.workflowId === id);
    for (const item of children) item.child.kill("SIGKILL");
    const done = Promise.all(children.map(item => item.done)).then(() => {
      this.store.db.transaction(() => this.store.finishCancellation(id))();
    });
    this.cancellations.set(id, done);
    return done;
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.interval);
    const children = [...this.live.values()];
    for (const item of children) item.child.kill("SIGKILL");
    await Promise.all(children.map(item => item.done));
  }
}
