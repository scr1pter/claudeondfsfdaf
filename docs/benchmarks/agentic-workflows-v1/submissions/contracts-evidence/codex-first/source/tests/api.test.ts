import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHandler } from "../server/api"
import { openStore } from "../server/storage"

test("HTTP contract: atomic validation, receipts, pagination, deleted history, and safe errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ew-http-"))
  const store = openStore(directory)
  const handle = createHandler(store)
  async function request(path: string, body?: string, contentType = "application/x-ndjson") {
    const response = await handle(new Request(`http://127.0.0.1${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": contentType }, body }))
    return { status: response.status, value: await response.json() }
  }
  const batch = (id: string, operations: unknown[]) => [JSON.stringify({ type: "batch", batchId: id }), ...operations.map(row => JSON.stringify(row))].join("\n")
  const document = { source: "a", title: "Amber", body: "🧭 amber\nCafé e\u0301 東京" }
  const initial = batch("first", [{ type: "upsert", ...document }, { type: "upsert", source: "b", title: "Amber", body: "second" }])
  try {
    expect(await request("/api/health")).toEqual({ status: 200, value: { ok: true, schemaVersion: 2, revision: 0 } })
    expect((await request("/api/batches", initial, "application/json")).value.error.code).toBe("invalid_batch")
    const committed = await request("/api/batches", initial)
    expect(committed.status).toBe(201)
    expect(committed.value).toMatchObject({ batchId: "first", revision: 1, replayed: false })
    expect((await request("/api/batches", initial)).value).toEqual({ ...committed.value, replayed: true })
    expect((await request("/api/batches", batch("first", [{ type: "delete", source: "a" }]))).status).toBe(409)
    const bad = await request("/api/batches", batch("bad", [{ type: "upsert", ...document, body: "changed" }, { type: "delete", source: "a" }]))
    expect(bad.status).toBe(400)
    expect(bad.value.error.code).toBe("invalid_batch")
    const legacy = await request("/api/import", JSON.stringify({ source: "new", title: "New", body: "amber" }) + '\n{"source":"invalid"}')
    expect(legacy.status).toBe(400)
    expect((await request("/api/documents")).value.documents).toHaveLength(2)
    expect((await request("/api/documents/1")).value.document).toMatchObject({ ...document, id: 1, version: 1 })
    const first = await request("/api/search?q=AMBER&limit=1")
    expect(first.value.query).toBe("AMBER")
    expect(first.value.results[0].citation).toMatchObject({ documentId: 1, version: 1, startByte: 5 })
    const continuation = `/api/search?q=AMBER&limit=1&cursor=${encodeURIComponent(first.value.nextCursor)}`
    expect((await request(continuation)).value.results[0].id).toBe(2)
    for (const limit of ["0", "51", "1.5", "1e1", "", "NaN", "2x", " 2"]) {
      const response = await request(`/api/search?q=amber&limit=${encodeURIComponent(limit)}`)
      expect(response.status).toBe(400); expect(response.value.error.code).toBe("invalid_limit")
    }
    for (const query of ["", "東京", "a b c d e f g h i"]) expect((await request(`/api/search?q=${encodeURIComponent(query)}`)).value.error.code).toBe("invalid_query")
    expect((await request("/api/search?q=amber&cursor=garbage")).value.error.code).toBe("invalid_cursor")
    const cite = "/api/citations?documentId=1&version=1&startByte=0&endByte=4"
    expect((await request(cite)).value.quote).toBe("🧭")
    expect((await request(cite.replace("endByte=4", "endByte=1"))).value.error.code).toBe("invalid_range")
    expect((await request("/api/citations?documentId=1&version=1")).status).toBe(400)
    expect((await request(cite.replace("documentId=1", "documentId=999"))).status).toBe(404)
    await request("/api/batches", batch("delete", [{ type: "delete", source: "a" }]))
    expect((await request(continuation))).toMatchObject({ status: 409, value: { error: { code: "stale_cursor" } } })
    expect((await request("/api/documents/1")).status).toBe(404)
    expect((await request("/api/documents/1/versions")).value.versions.map((row: { version: number }) => row.version)).toEqual([1])
    expect((await request("/api/documents/1/versions/1")).value.document.body).toBe(document.body)
    expect((await request(cite)).value.quote).toBe("🧭")
    const imported = await request("/api/import", JSON.stringify(document), "application/json")
    expect(imported.status).toBe(201)
    expect(imported.value.documents[0]).toMatchObject({ ...document, id: 1, version: 2 })
    expect((await request("/api/unknown")).value).toEqual({ error: { code: "not_found", message: "Unknown endpoint." } })
    const invalidUtf8 = await handle(new Request("http://127.0.0.1/api/batches", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array([0xff]) }))
    expect(invalidUtf8.status).toBe(400)
    expect((await invalidUtf8.json()).error.code).toBe("invalid_batch")
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
