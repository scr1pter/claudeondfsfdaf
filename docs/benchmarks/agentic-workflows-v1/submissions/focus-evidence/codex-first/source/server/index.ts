import { resolve, sep } from "node:path"
import { openStore } from "./storage"
import { ApiError, integerParameter, parseImport } from "./types"

const store = openStore(process.env.DATA_DIR ?? ".data")
const root = resolve("dist")
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
const notFound = () => new ApiError("not_found", "Document or version not found.", 404)

async function utf8(request: Request, code: string): Promise<string> {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await request.arrayBuffer()) }
  catch { throw new ApiError(code, "Request body must be valid UTF-8 text.") }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  maxRequestBodySize: 1024 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, schemaVersion: 2, revision: store.revision() })
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-ndjson") throw new ApiError("invalid_batch", "Use application/x-ndjson for batch imports.")
        const receipt = store.batch(await utf8(request, "invalid_batch"))
        return json(receipt, receipt.replayed ? 200 : 201)
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        const inputs = parseImport(await utf8(request, "invalid_document"), !!request.headers.get("content-type")?.toLowerCase().includes("ndjson"))
        return json({ documents: store.importMany(inputs) }, 201)
      }
      if (url.pathname === "/api/documents" && request.method === "GET") return json(store.collection())
      const match = /^\/api\/documents\/(\d+)(?:\/versions(?:\/(\d+))?)?$/.exec(url.pathname)
      if (match && request.method === "GET") {
        const id = Number(match[1])
        if (!Number.isSafeInteger(id) || id < 1) throw notFound()
        if (url.pathname.endsWith("/versions")) return json({ versions: store.versions(id) })
        const version = match[2] === undefined ? undefined : Number(match[2])
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw notFound()
        const document = version !== undefined ? store.historical(id, version) : store.get(id)
        if (!document) throw notFound()
        return json({ document })
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        const query = url.searchParams.get("q") ?? ""
        const limit = url.searchParams.has("limit") ? integerParameter(url.searchParams.get("limit"), true, "invalid_limit") : 10
        return json(store.searchPage(query, limit, url.searchParams.get("cursor")))
      }
      if (url.pathname === "/api/citations" && request.method === "GET") {
        const id = integerParameter(url.searchParams.get("documentId"), true)
        const version = integerParameter(url.searchParams.get("version"), true)
        const start = integerParameter(url.searchParams.get("startByte"))
        const end = integerParameter(url.searchParams.get("endByte"))
        return json(store.citation(id, version, start, end))
      }
      if (url.pathname.startsWith("/api/")) throw new ApiError("not_found", "Unknown endpoint or HTTP method.", 404)
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const path = resolve(root, "." + decodeURIComponent(url.pathname))
      if (!path.startsWith(root + sep) && path !== root) throw new ApiError("not_found", "File not found.", 404)
      const file = Bun.file(path)
      if (path !== root && await file.exists()) return new Response(file)
      return new Response(Bun.file(resolve(root, "index.html")), { headers: { "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } })
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status)
      console.error("Request failed.")
      return json({ error: { code: "internal_error", message: "The request could not be completed. No partial changes were committed." } }, 500)
    }
  },
})

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }))
function stop() { server.stop(true); store.close(); process.exit(0) }
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
