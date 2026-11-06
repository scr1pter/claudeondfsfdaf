import { join, resolve, sep } from "node:path"
import { ApiError } from "./types"
import type { Store } from "./storage"

const json = (value: unknown, status = 200) => Response.json(value, { status })

async function inputs(request: Request, code: string, ndjson: boolean): Promise<unknown[]> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await request.arrayBuffer())
    return ndjson ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : [JSON.parse(text)]
  } catch { throw new ApiError(code, "Request must contain valid UTF-8 and JSON on every nonblank line.") }
}

function integer(value: string | null, code: string, positive = true) {
  if (value === null || !/^\d+$/.test(value)) throw new ApiError(code, "Expected integer parameters.")
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw new ApiError(code, "Integer parameter is out of range.")
  return number
}

export function createHandler(store: Store, root = resolve("dist")) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-ndjson") throw new ApiError("invalid_batch", "Use application/x-ndjson for batches.")
        const receipt = store.batch(await inputs(request, "invalid_batch", true))
        return json(receipt, receipt.replayed ? 200 : 201)
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        const values = await inputs(request, "invalid_document", !!request.headers.get("content-type")?.includes("ndjson"))
        return json({ documents: store.importMany(values) }, 201)
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/health") return json({ ok: true, schemaVersion: 2, revision: store.revision() })
        if (url.pathname === "/api/documents") return json(store.collection())
        const match = /^\/api\/documents\/(\d+)(?:\/versions(?:\/(\d+))?)?$/.exec(url.pathname)
        if (match) {
          const id = Number(match[1])
          if (!Number.isSafeInteger(id) || id < 1) throw new ApiError("not_found", "Document not found.", 404)
          if (url.pathname.endsWith("/versions")) {
            const versions = store.versions(id)
            if (!versions.length) throw new ApiError("not_found", "Document not found.", 404)
            return json({ versions })
          }
          const version = match[2] === undefined ? undefined : Number(match[2])
          if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new ApiError("not_found", "Document version not found.", 404)
          const document = version === undefined ? store.get(id) : store.historical(id, version)
          if (!document) throw new ApiError("not_found", "Document version not found.", 404)
          return json({ document })
        }
        if (url.pathname === "/api/search") {
          const limit = url.searchParams.has("limit") ? integer(url.searchParams.get("limit"), "invalid_limit") : 10
          return json(store.searchPage(url.searchParams.get("q") ?? "", limit, url.searchParams.get("cursor")))
        }
        if (url.pathname === "/api/citations") {
          const parameter = (name: string, positive = true) => integer(url.searchParams.get(name), "invalid_range", positive)
          return json(store.citation(parameter("documentId"), parameter("version"), parameter("startByte", false), parameter("endByte", false)))
        }
      }
      if (url.pathname.startsWith("/api/")) throw new ApiError("not_found", "Unknown endpoint.", 404)
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const path = resolve(join(root, decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname)))
      if (!path.startsWith(root + sep)) throw new ApiError("not_found", "File not found.", 404)
      const file = Bun.file(path)
      return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")))
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status)
      return json({ error: { code: "internal_error", message: "The request could not be completed. No partial changes were saved." } }, 500)
    }
  }
}
