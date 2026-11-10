import type { NodeRow } from "./model";
import { Store } from "./store";

type Live = { child: ReturnType<typeof Bun.spawn>; done: Promise<void>; workflowId: string };
export class Runner {
  private live = new Map<string, Live>();
  private interval: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(private store: Store, private worker: string, private markers: string, private limit: number) {
    this.interval = setInterval(() => this.tick(), 40);
  }
  private tick() {
    if (this.stopping) return;
    const workflows = this.store.db.query<{ id: string; concurrency: number }, []>(
      "SELECT id,concurrency FROM workflows WHERE status IN ('queued','running') ORDER BY created_at,id").all();
    for (const workflow of workflows) {
      this.settle(workflow.id);
      if (!["queued", "running"].includes(this.store.row(workflow.id)!.status)) continue;
      const nodes = this.store.nodes(workflow.id);
      let active = [...this.live.values()].filter(run => run.workflowId === workflow.id).length;
      for (const node of nodes) {
        if (this.live.size >= this.limit || active >= workflow.concurrency) break;
        if (node.status !== "queued" || this.live.has(node.id)) continue;
        const dependencies = JSON.parse(node.dependencies) as string[];
        if (!dependencies.every(key => nodes.find(job => job.key === key)?.status === "succeeded")) continue;
        this.start(node);
        active++;
      }
    }
  }
  private settle(workflowId: string) {
    this.store.atomic(() => {
      const workflow = this.store.row(workflowId)!;
      if (!["queued", "running"].includes(workflow.status)) return;
      const nodes = this.store.nodes(workflowId);
      let changed: boolean;
      do {
        changed = false;
        for (const node of nodes) {
          if (node.status !== "queued") continue;
          const dependencies = JSON.parse(node.dependencies) as string[];
          if (dependencies.some(key => ["failed", "blocked", "cancelled"].includes(nodes.find(job => job.key === key)!.status))) {
            node.status = "blocked";
            this.store.db.query("UPDATE jobs SET status='blocked',error=?,updated_at=? WHERE id=?").run("A predecessor did not succeed.", Date.now(), node.id);
            this.store.event(workflowId, "job.blocked", node.key);
            this.store.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), workflowId);
            changed = true;
          }
        }
      } while (changed);
      if (nodes.every(node => !["queued", "running"].includes(node.status))) {
        const status = nodes.every(node => node.status === "succeeded") ? "succeeded" : "failed";
        this.store.db.query("UPDATE workflows SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), workflowId);
        this.store.event(workflowId, `workflow.${status}`);
      }
    });
  }
  private start(node: NodeRow) {
    const number = node.attempt + 1;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn([process.execPath, this.worker, "--job-id", node.id, "--attempt", String(number), "--kind", node.kind], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKFLOW_MARKER_DIR: this.markers, WORKFLOW_PARENT_PID: String(process.pid) },
      });
    } catch (failure) {
      this.store.atomic(() => {
        const now = Date.now();
        this.store.db.query("INSERT INTO attempts VALUES(?,?,'failed',NULL,?,?)").run(node.id, number, now, now);
        this.store.db.query("UPDATE jobs SET attempt=? WHERE id=?").run(number, node.id);
        this.finish(node, number, false, null, `Could not start worker: ${String(failure)}`);
      });
      return;
    }
    try {
      this.store.atomic(() => {
        const now = Date.now();
        this.store.db.query("UPDATE jobs SET status='running',attempt=?,updated_at=? WHERE id=?").run(number, now, node.id);
        this.store.db.query("INSERT INTO attempts VALUES(?,?,'running',?,?,NULL)").run(node.id, number, child.pid, now);
        this.store.db.query("UPDATE workflows SET status='running',updated_at=? WHERE id=?").run(now, node.workflow_id);
        this.store.event(node.workflow_id, "job.started", node.key, number);
      });
    } catch (failure) { child.kill(); throw failure; }
    const done = (async () => {
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        this.store.atomic(() => {
          // Shutdown leaves unfinished attempts for startup recovery.
          if (this.stopping || this.store.row(node.workflow_id)?.status === "cancelled") return;
          this.store.db.query("UPDATE attempts SET status=?,finished_at=? WHERE job_id=? AND number=?")
            .run(code === 0 ? "succeeded" : "failed", Date.now(), node.id, number);
          this.finish(node, number, code === 0, code === 0 ? stdout.trim() : null, stderr.trim() || `Worker exited with code ${code}.`);
        });
      } finally {
        this.live.delete(node.id);
        if (!this.stopping) this.settle(node.workflow_id);
      }
    })();
    this.live.set(node.id, { child, done, workflowId: node.workflow_id });
    void done.catch(failure => console.error("Worker completion failed", failure));
  }
  private finish(node: NodeRow, number: number, succeeded: boolean, result: string | null, error: string) {
    const failures = this.store.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM attempts WHERE job_id=? AND status='failed'").get(node.id)!.count;
    const retry = !succeeded && failures < node.max_attempts;
    this.store.db.query("UPDATE jobs SET status=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(succeeded ? "succeeded" : retry ? "queued" : "failed", result, succeeded ? null : error.slice(0, 4096), Date.now(), node.id);
    this.store.db.query("UPDATE workflows SET updated_at=? WHERE id=?").run(Date.now(), node.workflow_id);
    this.store.event(node.workflow_id, succeeded ? "job.succeeded" : "job.failed", node.key, number);
    if (retry) this.store.event(node.workflow_id, "job.retrying", node.key, number);
  }
  async cancel(id: string) {
    this.store.atomic(() => {
      if (this.store.row(id)!.status === "cancelled") return;
      const now = Date.now();
      for (const node of this.store.nodes(id)) {
        if (!["queued", "running"].includes(node.status)) continue;
        this.store.db.query("UPDATE attempts SET status='cancelled',finished_at=? WHERE job_id=? AND status='running'").run(now, node.id);
        this.store.db.query("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(now, node.id);
        this.store.event(id, "job.cancelled", node.key, node.status === "running" ? node.attempt : undefined);
      }
      this.store.db.query("UPDATE workflows SET status='cancelled',updated_at=? WHERE id=?").run(now, id);
      this.store.event(id, "workflow.cancelled");
    });
    const children = [...this.live.values()].filter(run => run.workflowId === id);
    for (const run of children) run.child.kill();
    await Promise.all(children.map(run => run.done));
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.interval);
    const children = [...this.live.values()];
    for (const run of children) run.child.kill();
    await Promise.allSettled(children.map(run => run.done));
  }
}
