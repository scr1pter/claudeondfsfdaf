import { resolve, sep } from "node:path"
import type { Store } from "./storage"
import { ApiError, parseJson } from "./types"

const json = (value: unknown, status = 200) => Response.json(value, { status })

function integer(value: string | null, code: string, minimum: number): number {
  if (value === null || !value.length || /[^0-9]/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new ApiError(code === "not_found" ? 404 : 400, code, "Expected an integer within the allowed range.")
  }
  return Number(value)
}

async function inputText(request: Request, code: string) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await request.arrayBuffer()) }
  catch { throw new ApiError(400, code, "Request must contain valid UTF-8 text.") }
}

export function createHandler(store: Store, root = resolve("dist")) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, schemaVersion: 2, revision: store.revision() })
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-ndjson") {
          throw new ApiError(400, "invalid_batch", "Use application/x-ndjson for batch imports.")
        }
        const receipt = store.batch(await inputText(request, "invalid_batch"))
        return json(receipt, receipt.replayed ? 200 : 201)
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        const text = await inputText(request, "invalid_document")
        const inputs = request.headers.get("content-type")?.toLowerCase().includes("ndjson")
          ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => parseJson(line, "invalid_document"))
          : [parseJson(text, "invalid_document")]
        return json({ documents: store.importMany(inputs) }, 201)
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/documents") return json(store.collection())
        const match = /^\/api\/documents\/(\d+)(?:\/(versions)(?:\/(\d+))?)?$/.exec(url.pathname)
        if (match) {
          const id = integer(match[1], "not_found", 1)
          if (match[2] && !match[3]) return json({ versions: store.versions(id) })
          const document = match[3] ? store.historical(id, integer(match[3], "not_found", 1)) : store.get(id)
          if (!document) throw new ApiError(404, "not_found", "Document version not found.")
          return json({ document })
        }
        if (url.pathname === "/api/search") {
          const query = url.searchParams.get("q") ?? ""
          const limit = url.searchParams.has("limit") ? integer(url.searchParams.get("limit"), "invalid_limit", 1) : 10
          return json(store.searchPage(query, limit, url.searchParams.get("cursor") ?? undefined))
        }
        if (url.pathname === "/api/citations") {
          const values = ["documentId", "version", "startByte", "endByte"].map((name, i) => integer(url.searchParams.get(name), "invalid_range", i < 2 ? 1 : 0))
          return json(store.citation(values[0], values[1], values[2], values[3]))
        }
      }
      if (url.pathname.startsWith("/api/")) throw new ApiError(404, "not_found", "Unknown endpoint.")
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const path = resolve(root, "." + decodeURIComponent(url.pathname))
      if (path !== root && !path.startsWith(root + sep)) throw new ApiError(404, "not_found", "File not found.")
      const file = Bun.file(url.pathname === "/" ? resolve(root, "index.html") : path)
      if (await file.exists()) return new Response(file)
      return new Response(Bun.file(resolve(root, "index.html")))
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status)
      return json({ error: { code: "internal_error", message: "The request could not be completed. No partial changes were saved." } }, 500)
    }
  }
}
