import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

// Local production-asset preview used only by the browser regression.
const root = path.resolve(import.meta.dirname, "../../web/dist")
const port = Number(process.env.PORT ?? 3457)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port.")
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" }
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
    let file = path.resolve(root, `.${pathname}`)
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error("Invalid path.")
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html")
    const body = await readFile(file)
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body)
  } catch { response.writeHead(404).end("Not found") }
}).listen(port, "127.0.0.1", () => console.info(`Production asset preview on http://127.0.0.1:${port}`))
