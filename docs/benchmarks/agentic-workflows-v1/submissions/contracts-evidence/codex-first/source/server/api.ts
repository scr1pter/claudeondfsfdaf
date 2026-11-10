import { join, resolve } from "node:path"
import type { openStore } from "./storage"
import { ApiError, parseLines, positiveInteger } from "./types"

const json = (value: unknown, status = 200) => Response.json(value, { status })
const notFound = () => { throw new ApiError("not_found", "Document version not found.", 404) }
async function requestText(request: Request, code: string) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await request.arrayBuffer()) }
  catch { throw new ApiError(code, "Request must contain valid UTF-8 text.") }
}

export function createHandler(store: ReturnType<typeof openStore>, root = resolve("dist")) {
  return async (request: Request) => {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, schemaVersion: 2, revision: store.revision() })
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-ndjson") throw new ApiError("invalid_batch", "Batch requests require application/x-ndjson.")
        const receipt = store.batch(await requestText(request, "invalid_batch"))
        return json(receipt, receipt.replayed ? 200 : 201)
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        let inputs: unknown[]
        try {
          const text = await requestText(request, "invalid_document")
          inputs = request.headers.get("content-type")?.includes("ndjson") ? parseLines(text) : [JSON.parse(text)]
        } catch { throw new ApiError("invalid_document", "Import must contain valid UTF-8 JSON document objects.") }
        return json({ documents: store.importMany(inputs) }, 201)
      }
      if (url.pathname === "/api/documents" && request.method === "GET") return json(store.collection())
      const match = /^\/api\/documents\/([0-9]+)(?:\/versions(?:\/([0-9]+))?)?$/.exec(url.pathname)
      if (match && request.method === "GET") {
        const id = positiveInteger(match[1])
        if (id === null) return notFound()
        if (url.pathname.endsWith("/versions")) return json({ versions: store.versions(id) })
        const version = match[2] === undefined ? null : positiveInteger(match[2])
        if (match[2] !== undefined && version === null) return notFound()
        const document = version === null ? store.get(id) : store.historical(id, version)
        return document ? json({ document }) : notFound()
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        const rawLimit = url.searchParams.get("limit")
        const limit = rawLimit === null ? 10 : positiveInteger(rawLimit)
        if (limit === null || limit > 50) throw new ApiError("invalid_limit", "Limit must be an integer from 1 to 50.")
        return json(store.searchPage(url.searchParams.get("q") ?? "", limit, url.searchParams.get("cursor")))
      }
      if (url.pathname === "/api/citations" && request.method === "GET") {
        const id = positiveInteger(url.searchParams.get("documentId"))
        const version = positiveInteger(url.searchParams.get("version"))
        const offset = (key: string) => {
          const raw = url.searchParams.get(key)
          return raw !== null && /^[0-9]+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
        }
        const start = offset("startByte"), end = offset("endByte")
        if (id === null || version === null || start === null || end === null) throw new ApiError("invalid_range", "Supply documentId, version, startByte, and endByte as valid integers.")
        return json(store.citation(id, version, start, end))
      }
      if (url.pathname.startsWith("/api/")) throw new ApiError("not_found", "Unknown endpoint.", 404)
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const file = Bun.file(join(root, url.pathname === "/" ? "index.html" : url.pathname))
      if (await file.exists()) return new Response(file)
      return new Response(Bun.file(join(root, "index.html")))
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status)
      return json({ error: { code: "internal_error", message: "The request could not be completed." } }, 500)
    }
  }
}

