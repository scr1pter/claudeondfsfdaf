import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { WorkflowRunner, validateWorkflow, canonicalJSON } from "./runner.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = new WorkflowRunner({
  directory: process.env.DATA_DIR ?? join(tmpdir(), "workflow-runner-local"),
  root,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (status: number, message: string) =>
  json({ error: { code: `HTTP_${status}`, message } }, status);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8088),
  maxRequestBodySize: 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/api/health")
        return json({ ok: true, schemaVersion: 2 });
      if (request.method === "GET" && path === "/api/jobs")
        return json({ jobs: runner.legacyJobs() });
      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (request.method === "GET" && jobMatch) {
        const job = runner.legacyJob(jobMatch[1]);
        return job ? json({ job }) : error(404, "Job not found");
      }
      if (request.method === "POST" && path === "/api/jobs") {
        const input = await request.json();
        const validated = validateWorkflow({ name: input?.name, concurrency: 1,
          jobs: [{ key: "job", name: input?.name, kind: input?.kind }] });
        const workflow = runner.create(validated, null, null, true);
        return json({ job: runner.legacyJob(workflow.jobs[0].id) }, 201);
      }
      if (request.method === "GET" && path === "/api/workflows")
        return json({ workflows: runner.workflows() });
      if (request.method === "POST" && path === "/api/workflows") {
        const key = request.headers.get("Idempotency-Key");
        if (!key?.trim() || key.length > 128)
          return error(400, "Idempotency-Key must contain 1–128 characters.");
        const input: unknown = await request.json();
        const validated = validateWorkflow(input);
        const identity = canonicalJSON(input);
        const prior = runner.replay(key);
        if (prior) {
          if (prior.identity !== identity)
            return error(409, "This idempotency key was used for different content.");
          return json({ workflow: runner.workflow(prior.id), replayed: true });
        }
        return json({ workflow: runner.create(validated, key, identity) }, 201);
      }
      const match = /^\/api\/workflows\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
      if (match) {
        const [, id, action] = match;
        const workflow = runner.workflow(id);
        if (!workflow) return error(404, "Workflow not found");
        if (request.method === "GET" && !action) return json({ workflow });
        if (request.method === "GET" && action === "events") {
          const cursor = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
            return error(400, "after must be a nonnegative integer.");
          return json({ events: runner.events(id, Number(cursor)) });
        }
        if (request.method === "POST" && action === "cancel") {
          if (["succeeded", "failed"].includes(workflow.status))
            return error(409, "A completed workflow cannot be cancelled.");
          await runner.cancel(id);
          return json({ workflow: runner.workflow(id) });
        }
      }
      if (request.method === "GET" && (path === "/" || path === "/index.html"))
        return new Response(Bun.file(join(root, "public/index.html")), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      if (request.method === "GET" && ["/app.js", "/styles.css"].includes(path))
        return new Response(Bun.file(join(root, "public", path.slice(1))));
      return error(404, "Route not found");
    } catch (failure) {
      if (failure instanceof SyntaxError || failure instanceof TypeError)
        return error(400, failure instanceof SyntaxError ? "Invalid JSON" : failure.message);
      console.error("Request failed:", failure);
      return error(500, "The request could not be completed.");
    }
  },
});
runner.start();
console.log(`Workflow Runner listening on http://127.0.0.1:${server.port}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    server.stop(true);
    await runner.close();
    process.exit(0);
  });
}
