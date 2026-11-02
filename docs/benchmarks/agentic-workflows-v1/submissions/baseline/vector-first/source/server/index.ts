import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Runner, canonical, kinds, validate } from "./workflows";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.DATA_DIR ?? join(tmpdir(), "workflow-runner");
mkdirSync(directory, { recursive: true });
const runner = new Runner(root, directory, process.env.WORKFLOW_WORKER_PATH ?? join(root, "server/worker.ts"), process.env.WORKFLOW_MARKER_DIR ?? join(directory, "markers"));
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (status: number, message: string) => json({ error: { code: `HTTP_${status}`, message } }, status);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8088),
  maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") return json({ ok: true, schemaVersion: 2 });
    if (request.method === "GET" && path === "/api/jobs") return json({ jobs: runner.legacyList() });
    if (request.method === "GET" && path.startsWith("/api/jobs/")) {
      const job = runner.legacy(path.slice("/api/jobs/".length));
      return job ? json({ job }) : error(404, "Job not found");
    }
    if (request.method === "POST" && path === "/api/jobs") {
      let input;
      try { input = await request.json(); } catch { return error(400, "Invalid JSON"); }
      if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120 || !kinds.includes(input.kind)) return error(400, "Invalid job");
      return json({ job: runner.createLegacy(input.name.trim(), input.kind) }, 201);
    }
    if (request.method === "GET" && path === "/api/workflows") return json({ workflows: runner.list() });
    if (request.method === "POST" && path === "/api/workflows") {
      const key = request.headers.get("Idempotency-Key");
      if (!key || !key.trim() || key.length > 128) return error(400, "Idempotency-Key must be 1 to 128 characters");
      let input, definition;
      try { input = await request.json(); definition = validate(input); } catch (failure) { return error(400, failure instanceof Error ? failure.message : "Invalid JSON"); }
      const result = runner.create(definition, key, canonical(input));
      if (result.conflict) return error(409, "Idempotency key already used with different content");
      return json({ workflow: result.workflow, ...(result.replayed ? { replayed: true } : {}) }, result.replayed ? 200 : 201);
    }
    const match = /^\/api\/workflows\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
    if (match) {
      const [, id, action] = match;
      if (!runner.row(id)) return error(404, "Workflow not found");
      if (request.method === "GET" && !action) return json({ workflow: runner.workflow(id) });
      if (request.method === "GET" && action === "events") {
        const cursor = url.searchParams.get("after") ?? "0";
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return error(400, "after must be a nonnegative integer");
        return json({ events: runner.events(id, Number(cursor)) });
      }
      if (request.method === "POST" && action === "cancel") {
        const status = await runner.cancel(id);
        return status === 200 ? json({ workflow: runner.workflow(id) }) : error(status, "A completed workflow cannot be cancelled");
      }
    }
    if (request.method === "GET" && path === "/") return new Response(Bun.file(join(root, "public/index.html")), { headers: { "Cache-Control": "no-store" } });
    return error(404, "Route not found");
  },
});
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await runner.stop();
  process.exit(0);
});
