import { dirname, join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "./store";
import { Runner } from "./runner";
import { canonical, kinds, validName, validate } from "./validation";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.DATA_DIR ?? join(tmpdir(), "workflow-runner");
const store = new Store(directory, root);
const configuredLimit = Number(process.env.WORKFLOW_CONCURRENCY ?? 2);
if (!Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 3)
  throw new Error("WORKFLOW_CONCURRENCY must be an integer from 1 to 3.");
const runner = new Runner(store, configuredLimit,
  resolve(process.env.WORKFLOW_WORKER_PATH ?? join(root, "server/worker.ts")),
  process.env.WORKFLOW_MARKER_DIR ?? join(directory, "markers"));
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (status: number, message: string) => json({ error: { code: `HTTP_${status}`, message } }, status);

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 8088), maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    try {
      if (method === "GET" && path === "/api/health") return json({ ok: true, schemaVersion: 2 });
      if (method === "GET" && path === "/api/jobs") return json({ jobs: store.legacy() });
      if (method === "GET" && path.startsWith("/api/jobs/")) {
        const job = store.legacy(path.slice("/api/jobs/".length))[0];
        return job ? json({ job }) : error(404, "Job not found");
      }
      if (method === "POST" && path === "/api/jobs") {
        const input = await request.json();
        if (!input || typeof input !== "object" || !validName(input.name) || !kinds.includes(input.kind))
          return error(400, "Invalid job name or kind.");
        const workflow = store.create({ name: input.name.trim(), concurrency: 1,
          jobs: [{ key: "job", name: input.name.trim(), kind: input.kind, dependsOn: [], maxAttempts: 1 }] }, true);
        return json({ job: store.legacy(workflow.jobs[0].id)[0] }, 201);
      }
      if (method === "GET" && path === "/api/workflows") {
        const ids = store.db.query<{ id: string }, []>("SELECT id FROM workflows WHERE legacy=0 ORDER BY created_at,rowid").all();
        return json({ workflows: ids.map(row => store.workflow(row.id)) });
      }
      if (method === "POST" && path === "/api/workflows") {
        const key = request.headers.get("Idempotency-Key");
        if (!key || !key.trim() || key.length > 128) return error(400, "Provide an Idempotency-Key of 1 to 128 characters.");
        const input: unknown = await request.json();
        let definition;
        try { definition = validate(input); }
        catch (failure) { return error(400, (failure as Error).message); }
        const identity = canonical(input);
        const previous = store.db.query<{ request: string; workflow_id: string }, [string]>(
          "SELECT request,workflow_id FROM idempotency WHERE key=?").get(key);
        if (previous) return previous.request === identity
          ? json({ workflow: store.workflow(previous.workflow_id), replayed: true })
          : error(409, "This idempotency key was already used with different contents.");
        return json({ workflow: store.create(definition, false, key, identity) }, 201);
      }
      const match = /^\/api\/workflows\/([^/]+)(?:\/(cancel|events))?$/.exec(path);
      if (match) {
        const [, id, action] = match;
        const workflow = store.row(id);
        if (!workflow) return error(404, "Workflow not found");
        if (method === "GET" && !action) return json({ workflow: store.workflow(id) });
        if (method === "GET" && action === "events") {
          const cursor = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(cursor)) return error(400, "after must be a nonnegative integer.");
          // A cursor beyond JS's exact sequence range is still a valid future cursor.
          if (BigInt(cursor) > BigInt(Number.MAX_SAFE_INTEGER)) return json({ events: [] });
          const rows = store.db.query<{
            seq: number; type: string; createdAt: number; jobKey: string | null; attempt: number | null;
          }, [string, number]>(`SELECT seq,type,created_at AS createdAt,job_key AS jobKey,attempt FROM events
            WHERE workflow_id=? AND seq>? ORDER BY seq`).all(id, Number(cursor));
          return json({ events: rows.map(row => ({ seq: row.seq, type: row.type, createdAt: row.createdAt,
            ...(row.jobKey === null ? {} : { jobKey: row.jobKey }), ...(row.attempt === null ? {} : { attempt: row.attempt }) })) });
        }
        if (method === "POST" && action === "cancel") {
          if (["succeeded", "failed"].includes(workflow.status)) return error(409, "A completed workflow cannot be cancelled.");
          if (workflow.status !== "cancelled" || runner.cancellations.has(id)) await runner.cancel(id);
          return json({ workflow: store.workflow(id) });
        }
      }
      if (method === "GET" && ["/", "/app.js", "/styles.css"].includes(path)) {
        const file = Bun.file(join(root, "public", path === "/" ? "index.html" : path.slice(1)));
        const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
        return new Response(file, { headers: { "Content-Type": types[extname(file.name!)], "Cache-Control": "no-cache" } });
      }
      return error(404, "Route not found");
    } catch (failure) {
      if (failure instanceof SyntaxError) return error(400, "Invalid JSON");
      console.error(failure);
      return error(500, "The request could not be completed.");
    }
  },
});
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop(true);
  await runner.stop();
  store.db.close();
  process.exit(0);
});
