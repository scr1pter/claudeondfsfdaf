import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { canonical, InputError, kind, name, validate } from "./model";
import { Store } from "./store";
import { Runner } from "./runner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(process.env.DATA_DIR ?? join(tmpdir(), "workflow-runner-data"));
const configuredLimit = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
if (!Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 3)
  throw new Error("WORKFLOW_CONCURRENCY must be an integer from 1 to 3.");
const store = new Store(directory, root);
const runner = new Runner(store, resolve(process.env.WORKFLOW_WORKER_PATH ?? join(root, "server/worker.ts")),
  resolve(process.env.WORKFLOW_MARKER_DIR ?? join(directory, "markers")), configuredLimit);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const error = (status: number, message: string) => json({ error: { code: `HTTP_${status}`, message } }, status);
async function body(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new InputError("Invalid JSON."); }
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 8088), maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (method === "GET" && path === "/api/health") return json({ ok: true, schemaVersion: 2 });
      if (method === "GET" && path === "/api/jobs") return json({ jobs: store.legacyJobs() });
      if (method === "GET" && path.startsWith("/api/jobs/")) {
        const job = store.legacyJob(path.slice("/api/jobs/".length));
        return job ? json({ job }) : error(404, "Job not found.");
      }
      if (method === "POST" && path === "/api/jobs") {
        const input = await body(request);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Invalid job.");
        const fields = input as Record<string, unknown>;
        const jobName = name(fields.name), jobKind = kind(fields.kind);
        const id = store.atomic(() => store.create({ name: jobName, concurrency: 1,
          jobs: [{ key: "job", name: jobName, kind: jobKind, dependsOn: [], maxAttempts: 1 }] }, true));
        return json({ job: store.legacyJob(store.nodes(id)[0]!.id) }, 201);
      }
      if (method === "GET" && path === "/api/workflows") return json({ workflows: store.list() });
      if (method === "POST" && path === "/api/workflows") {
        const key = request.headers.get("Idempotency-Key");
        if (!key || !key.trim() || key.length > 128) throw new InputError("Idempotency-Key must contain 1–128 characters.");
        const input = await body(request), definition = validate(input), identity = canonical(input);
        return store.atomic(() => {
          const existing = store.db.query<{ request: string; workflow_id: string }, [string]>("SELECT request,workflow_id FROM idempotency WHERE key=?").get(key);
          if (existing) return existing.request === identity
            ? json({ workflow: store.workflow(existing.workflow_id), replayed: true })
            : error(409, "Idempotency key already used with different content.");
          const id = store.create(definition);
          store.db.query("INSERT INTO idempotency VALUES(?,?,?)").run(key, identity, id);
          return json({ workflow: store.workflow(id) }, 201);
        });
      }
      const match = /^\/api\/workflows\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
      if (match) {
        const id = match[1]!, action = match[2], workflow = store.workflow(id);
        if (!workflow) return error(404, "Workflow not found.");
        if (method === "GET" && !action) return json({ workflow });
        if (method === "GET" && action === "events") {
          const cursor = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new InputError("after must be a nonnegative integer.");
          return json({ events: store.events(id, Number(cursor)) });
        }
        if (method === "POST" && action === "cancel") {
          if (["succeeded", "failed"].includes(workflow.status)) return error(409, "A completed workflow cannot be cancelled.");
          await runner.cancel(id);
          return json({ workflow: store.workflow(id) });
        }
      }
      if (method === "GET" && path === "/") {
        const built = Bun.file(join(root, "dist/index.html"));
        return new Response(await built.exists() ? built : Bun.file(join(root, "public/index.html")),
          { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
      }
      return error(404, "Route not found.");
    } catch (failure) {
      if (failure instanceof InputError) return error(400, failure.message);
      console.error(failure);
      return error(500, "Internal server error.");
    }
  },
});
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await runner.stop();
  store.db.close();
  process.exit(0);
});
