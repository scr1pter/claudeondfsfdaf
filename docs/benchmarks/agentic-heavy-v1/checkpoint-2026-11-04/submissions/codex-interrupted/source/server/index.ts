import { resolve, extname } from "node:path";
import { handleApi } from "./api";

const root = resolve(import.meta.dir, "..", "dist");
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port number");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response("Invalid path", { status: 400 }); }
    const filename = resolve(root, "." + pathname);
    if (filename !== root && !filename.startsWith(root + "/") && !filename.startsWith(root + "\\")) return new Response("Not found", { status: 404 });
    const asset = Bun.file(filename);
    if (filename !== root && await asset.exists()) {
      return new Response(request.method === "HEAD" ? null : asset, {
        headers: { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff" },
      });
    }
    if (extname(pathname)) return new Response("Not found", { status: 404 });
    const entry = Bun.file(resolve(root, "index.html"));
    if (!await entry.exists()) return new Response("Build the frontend with bun run build before starting Foundry.", { status: 503 });
    return new Response(request.method === "HEAD" ? null : entry, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
    });
  },
  error() {
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, { status: 500 });
  },
});

console.log(`Foundry is listening on http://127.0.0.1:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
