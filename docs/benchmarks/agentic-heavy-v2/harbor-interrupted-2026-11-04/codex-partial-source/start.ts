import { resolve, sep } from "node:path";
import { handleApi, initializeBackend, stopBackend } from "./server/index";

const dist = resolve(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

initializeBackend();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    try {
      const response = await handleApi(request);
      if (response) return response;
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch { return new Response("Invalid path", { status: 400 }); }
      const filePath = resolve(dist, `.${pathname}`);
      if (filePath !== dist && !filePath.startsWith(dist + sep)) {
        return new Response("Not found", { status: 404 });
      }
      const file = Bun.file(filePath);
      if (filePath !== dist && await file.exists()) {
        return new Response(request.method === "HEAD" ? null : file, {
          headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff" },
        });
      }
      const index = Bun.file(resolve(dist, "index.html"));
      if (!await index.exists()) return new Response("Build the frontend with bun run build first.", { status: 503 });
      return new Response(request.method === "HEAD" ? null : index, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch (error) {
      console.error("Request failed", error);
      return Response.json({ error: { code: "INTERNAL_ERROR", message: "The local server could not complete this request." } }, { status: 500 });
    }
  },
});

console.log(`Harbor running at http://127.0.0.1:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopBackend(); server.stop(true); process.exit(0); });
}
