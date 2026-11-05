import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HttpError, Runner } from "./runner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = new Runner(root, process.env.DATA_DIR ?? join(tmpdir(), "workflow-runner"));
const json = (value: unknown, status = 200) => Response.json(value, { status });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8088),
  maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url), method = request.method;
    try {
      if (method === "GET" && url.pathname === "/api/health") return json({ ok: true, schemaVersion: 2 });
      if (method === "GET" && url.pathname === "/api/jobs") return json({ jobs: runner.legacyJobs() });
      if (method === "GET" && /^\/api\/jobs\/[^/]+$/.test(url.pathname)) return json({ job: runner.legacyJob(url.pathname.split("/")[3]) });
      if (method === "POST" && url.pathname === "/api/jobs") return json({ job: runner.createLegacy(await body(request)) }, 201);
      if (method === "GET" && url.pathname === "/api/workflows") return json({ workflows: runner.workflows() });
      if (method === "POST" && url.pathname === "/api/workflows") {
        const result = runner.create(await body(request), request.headers.get("Idempotency-Key"));
        return json(result.replayed ? result : { workflow: result.workflow }, result.replayed ? 200 : 201);
      }
      const match = /^\/api\/workflows\/([^/]+)(?:\/(cancel|events))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (method === "GET" && !action) return json({ workflow: runner.workflow(id) });
        if (method === "GET" && action === "events") return json({ events: runner.events(id, url.searchParams.get("after") ?? "0") });
        if (method === "POST" && action === "cancel") return json({ workflow: await runner.cancel(id) });
      }
      if (method === "GET" && url.pathname === "/") {
        const built = Bun.file(join(root, "dist/index.html"));
        return new Response(await built.exists() ? built : Bun.file(join(root, "public/index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      throw new HttpError(404, "Route not found");
    } catch (failure) {
      const status = failure instanceof HttpError ? failure.status : 500;
      if (status === 500) console.error(failure);
      return json({ error: { code: `HTTP_${status}`, message: failure instanceof HttpError ? failure.message : "Internal server error" } }, status);
    }
  },
});
async function body(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
}
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  server.stop(true);
  await runner.stop();
  process.exit(0);
});
