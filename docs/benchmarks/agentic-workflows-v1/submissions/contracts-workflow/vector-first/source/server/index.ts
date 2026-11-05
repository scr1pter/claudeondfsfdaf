import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, canonical, kinds, validName, validate } from "./store";
import { Runner } from "./runner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.DATA_DIR ?? join(root, "..", "workflow-data");
const store = new Store(directory, root);
const runner = new Runner(store, root, directory);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (status: number, message: string) => json({ error: { code: `HTTP_${status}`, message } }, status);
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 8088), maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, schemaVersion: 2 });
      if (request.method === "GET" && url.pathname === "/api/jobs") return json({ jobs: store.legacyJobs() });
      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const job = store.job(url.pathname.slice("/api/jobs/".length));
        return job ? json({ job }) : error(404, "Job not found");
      }
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        const input = await request.json().catch(() => null);
        if (!input || Array.isArray(input) || !validName(input.name) || !kinds.includes(input.kind)) return error(400, "Invalid job");
        const id = store.create({ name: input.name.trim(), concurrency: 1,
          jobs: [{ key: "job", name: input.name.trim(), kind: input.kind, dependsOn: [], maxAttempts: 1 }] }, true);
        return json({ job: store.job(store.nodes(id)[0].id) }, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/workflows") {
        const key = request.headers.get("Idempotency-Key");
        if (!key || !key.trim() || key.length > 128) return error(400, "Idempotency-Key must contain 1-128 characters.");
        let input: unknown;
        let definition;
        try { input = await request.json(); definition = validate(input); }
        catch (failure) { return error(400, failure instanceof Error ? failure.message : "Invalid JSON"); }
        const content = canonical(input);
        const previous = store.db.query<{ content: string; workflow_id: string }, [string]>("SELECT * FROM idempotency WHERE key=?").get(key);
        if (previous) return previous.content === content ? json({ workflow: store.workflow(previous.workflow_id), replayed: true }) : error(409, "Idempotency key already used with different content.");
        const id = store.create(definition, false, key, content);
        return json({ workflow: store.workflow(id) }, 201);
      }
      if (request.method === "GET" && url.pathname === "/api/workflows") {
        const ids = store.db.query<{ id: string }, []>("SELECT id FROM workflows WHERE legacy=0 ORDER BY created_at DESC,rowid DESC").all();
        return json({ workflows: ids.map(row => store.workflow(row.id)) });
      }
      const match = /^\/api\/workflows\/([^/]+)(?:\/(events|cancel))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        const workflow = store.row(id);
        if (!workflow) return error(404, "Workflow not found");
        if (request.method === "GET" && !action) return json({ workflow: store.workflow(id) });
        if (request.method === "GET" && action === "events") {
          const raw = url.searchParams.get("after") ?? "0";
          const after = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) return error(400, "after must be a nonnegative integer.");
          return json({ events: store.events(id, after) });
        }
        if (request.method === "POST" && action === "cancel") {
          if (workflow.status === "cancelled") return json({ workflow: store.workflow(id) });
          if (["succeeded", "failed"].includes(workflow.status)) return error(409, "Completed workflows cannot be cancelled.");
          await runner.cancel(id);
          return json({ workflow: store.workflow(id) });
        }
      }
      if (request.method === "GET" && url.pathname === "/") return new Response(Bun.file(join(root, "public/index.html")), {
        headers: { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" }
      });
      return error(404, "Route not found");
    } catch (failure) {
      console.error(failure);
      return error(500, "An internal error occurred.");
    }
  }
});
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await runner.stop();
  store.db.close();
  process.exit(0);
});
