import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.DATA_DIR ?? join(root, ".data");
mkdirSync(directory, { recursive: true });
const database = new Database(join(directory, "workflow.sqlite"));
database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
database.exec(readFileSync(join(root, "sql/v1.sql"), "utf8"));

type Job = {
  id: string;
  name: string;
  kind: string;
  status: string;
  attempt: number;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
const worker =
  process.env.WORKFLOW_WORKER_PATH ?? join(root, "server/worker.ts");
const markers = process.env.WORKFLOW_MARKER_DIR ?? join(directory, "markers");
database.exec("UPDATE jobs SET status='queued' WHERE status='running'");
const current: { child?: ReturnType<typeof Bun.spawn>; id?: string } = {};

async function dispatch() {
  if (current.child) return;
  const job = database
    .query<
      Job,
      []
    >("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1")
    .get();
  if (!job) return;
  const attempt = job.attempt + 1;
  database
    .query(
      "UPDATE jobs SET status='running', attempt=?, updated_at=? WHERE id=?",
    )
    .run(attempt, Date.now(), job.id);
  const child = Bun.spawn(
    [
      process.execPath,
      worker,
      "--job-id",
      job.id,
      "--attempt",
      String(attempt),
      "--kind",
      job.kind,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WORKFLOW_MARKER_DIR: markers,
        WORKFLOW_PARENT_PID: String(process.pid),
      },
    },
  );
  current.child = child;
  current.id = job.id;
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  database
    .query(
      "UPDATE jobs SET status=?, result=?, error=?, updated_at=? WHERE id=?",
    )
    .run(
      code === 0 ? "succeeded" : "failed",
      code === 0 ? stdout.trim() : null,
      code === 0 ? null : stderr.trim(),
      Date.now(),
      job.id,
    );
  current.child = undefined;
  current.id = undefined;
}
const interval = setInterval(() => void dispatch(), 40);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (status: number, message: string) =>
  json({ error: { code: `HTTP_${status}`, message } }, status);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8088),
  maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health")
      return json({
        ok: true,
        schemaVersion: Number(
          database
            .query<
              { value: string },
              []
            >("SELECT value FROM meta WHERE key='schema_version'")
            .get()?.value,
        ),
      });
    if (request.method === "GET" && url.pathname === "/api/jobs")
      return json({
        jobs: database
          .query<Job, []>("SELECT * FROM jobs ORDER BY created_at, id")
          .all(),
      });
    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const job = database
        .query<Job, [string]>("SELECT * FROM jobs WHERE id=?")
        .get(url.pathname.slice("/api/jobs/".length));
      return job ? json({ job }) : error(404, "Job not found");
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return error(400, "Invalid JSON");
      }
      if (
        !input ||
        typeof input !== "object" ||
        !("name" in input) ||
        !("kind" in input) ||
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 120 ||
        typeof input.kind !== "string" ||
        !["succeed", "fail", "fail_once", "block"].includes(input.kind)
      )
        return error(400, "Invalid job");
      const id = crypto.randomUUID();
      const now = Date.now();
      database
        .query(
          "INSERT INTO jobs(id,name,kind,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)",
        )
        .run(id, input.name, input.kind, now, now);
      return json(
        {
          job: database
            .query<Job, [string]>("SELECT * FROM jobs WHERE id=?")
            .get(id),
        },
        201,
      );
    }
    if (request.method === "GET" && url.pathname === "/")
      return new Response(Bun.file(join(root, "public/index.html")));
    return error(404, "Route not found");
  },
});
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(interval);
    current.child?.kill();
    server.stop(true);
    process.exit(0);
  });
}
