import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler } from "../server/http"
import { openStore } from "../server/storage"

const fixtures: { directory: string; store: ReturnType<typeof openStore> }[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

function setup(legacy?: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "ew-revisions-"))
  if (legacy !== undefined) {
    const db = new Database(join(directory, "workbench.sqlite"))
    db.exec(readFileSync(new URL("../schema/legacy.sql", import.meta.url), "utf8"))
    if (legacy) db.query("INSERT INTO documents (id, source, title, body, created_at) VALUES (?, ?, ?, ?, ?)").run(42, "old.md", "Original", "Café 🧭 amber", "2020-01-02T03:04:05Z")
    db.close()
  }
  const fixture = { directory, store: openStore(directory) }
  fixtures.push(fixture)
  return {
    fixture,
    get store() { return fixture.store },
    async request(path: string, body?: string, contentType = "application/x-ndjson") {
      const response = await createHandler(fixture.store)(new Request(`http://localhost${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": contentType }, body }))
      return { status: response.status, value: await response.json() }
    },
  }
}

const upsert = (source: string, body = "amber fern", title = "Field log") => ({ type: "upsert", source, title, body })
const batch = (id: string, ...operations: unknown[]) => [{ type: "batch", batchId: id }, ...operations].map((value) => JSON.stringify(value)).join("\n")

test("fresh and legacy databases migrate durably without changing text, IDs, or timestamps", async () => {
  for (const legacy of [undefined, false, true]) {
    const app = setup(legacy)
    expect((await app.request("/api/health")).value).toEqual({ ok: true, schemaVersion: 2, revision: legacy ? 1 : 0 })
    if (legacy) {
      const original = { id: 42, source: "old.md", title: "Original", body: "Café 🧭 amber", created_at: "2020-01-02T03:04:05Z", version: 1 }
      expect(app.store.get(42)).toEqual(original)
      expect(app.store.historical(42, 1)).toEqual(original)
      expect(app.store.search("amber").map((row) => row.id)).toEqual([42])
    }
    app.store.close()
    app.fixture.store = openStore(app.fixture.directory)
    expect(app.store.revision()).toBe(legacy ? 1 : 0)
  }
})

test("batch replacements, deletion, no-ops, revival and receipts survive restart", async () => {
  const app = setup()
  const original = batch("first", upsert("a"), upsert("b"))
  const first = await app.request("/api/batches", original)
  expect(first.status).toBe(201)
  expect(first.value.revision).toBe(1)
  const id = first.value.operations[0].documentId
  expect(first.value.operations.map((result: { version: number }) => result.version)).toEqual([1, 1])
  expect((await app.request("/api/batches", batch("noop", upsert("a")))).value.operations[0].changed).toBe(false)
  expect(app.store.revision()).toBe(1)
  const changed = await app.request("/api/batches", batch("second", upsert("a", "cobalt"), { type: "delete", source: "b" }))
  expect(changed.value.revision).toBe(2)
  expect(app.store.get(id)?.version).toBe(2)
  expect(app.store.list()).toHaveLength(1)
  expect(app.store.historical(id, 1)?.body).toBe("amber fern")
  const deleted = await app.request("/api/batches", batch("third", { type: "delete", source: "a" }))
  expect(deleted.value.operations[0]).toEqual({ type: "delete", source: "a", documentId: id, version: null, changed: true })
  expect(app.store.get(id)).toBeNull()
  expect(app.store.search("cobalt")).toEqual([])
  const noop = await app.request("/api/batches", batch("fourth", { type: "delete", source: "a" }, { type: "delete", source: "missing" }))
  expect(noop.value.revision).toBe(3)
  expect(noop.value.operations[1].documentId).toBeNull()
  const revived = app.store.import({ source: "a", title: "Field log", body: "cobalt" })
  expect(revived.id).toBe(id)
  expect(revived.version).toBe(3)
  expect(app.store.versions(id).map((row) => row.version)).toEqual([1, 2, 3])
  app.store.close()
  app.fixture.store = openStore(app.fixture.directory)
  const replay = await app.request("/api/batches", original)
  expect(replay).toEqual({ status: 200, value: { ...first.value, replayed: true } })
  expect(app.store.revision()).toBe(4)
  const conflict = await app.request("/api/batches", batch("first", upsert("different")))
  expect(conflict.status).toBe(409)
  expect(conflict.value.error.code).toBe("batch_conflict")
  expect(app.store.revision()).toBe(4)
})

test("identity ignores JSON formatting, ignored properties and line endings, but binds order and fields", async () => {
  const app = setup()
  const first = await app.request("/api/batches", batch("identity", upsert("a"), upsert("b")))
  const formatted = '\r\n {"extra":1,"batchId":"identity","type":"batch"}\r\n\r\n' +
    '{"body":"amber fern","title":"Field log","source":"a","type":"upsert","ignored":true}\r\n' +
    '{"source":"b","body":"amber fern","type":"upsert","title":"Field log"}\r\n'
  expect((await app.request("/api/batches", formatted)).value).toEqual({ ...first.value, replayed: true })
  for (const text of [batch("identity", upsert("b"), upsert("a")), batch("identity", upsert("a", "different"), upsert("b"))]) {
    expect((await app.request("/api/batches", text)).value.error.code).toBe("batch_conflict")
  }
  const reserved = await app.request("/api/batches", batch("reserved", { type: "delete", source: "unknown" }))
  expect(reserved.value.revision).toBe(1)
  expect((await app.request("/api/batches", batch("reserved", upsert("unknown")))).status).toBe(409)
})

test("whole-request validation rejects malformed batches without reserving IDs or creating documents", async () => {
  const app = setup()
  const badOperations = [
    upsert(""), upsert("a\n"), upsert("a", "bad\0body"), upsert("a", "\ud800"), upsert("a", "ok", "\udfff"),
    upsert("\ud800"), upsert("a", "ok", " "), upsert("a".repeat(201)), upsert("a", "ok", "🧭".repeat(201)),
    upsert("a", "🧭".repeat(262145)), { type: "unknown", source: "a" }, { type: "batch", batchId: "extra" }, [], null,
  ]
  const invalid = ["", "not json", batch("id"), batch("bad id", upsert("a")), batch("id", upsert("same"), upsert("same")),
    JSON.stringify(upsert("a")), batch("id", ...Array.from({ length: 129 }, (_, i) => upsert(String(i)))),
    ...badOperations.map((operation) => batch("id", upsert("valid"), operation))]
  for (const text of invalid) {
    const result = await app.request("/api/batches", text)
    expect(result.status).toBe(400)
    expect(result.value.error.code).toBe("invalid_batch")
    expect(app.store.list()).toEqual([])
    expect(app.store.revision()).toBe(0)
  }
  expect((await app.request("/api/batches", batch("id", upsert("valid")))).status).toBe(201)
  expect((await app.request("/api/batches", batch("json", upsert("a")), "application/json")).value.error.code).toBe("invalid_batch")
})

test("Unicode scalar and UTF-8 byte limits accept exact boundaries without trimming values", async () => {
  const app = setup()
  const source = "🧭".repeat(200)
  const body = "🧭".repeat(262144)
  const row = app.store.import({ source, title: "🧭".repeat(200), body })
  expect(row.source).toBe(source)
  expect(row.body).toBe(body)
  const exact = app.store.import({ source: " spaced ", title: " title ", body: " \r\nCafé é 東京 🧭 " })
  expect(exact.source).toBe(" spaced ")
  expect(exact.title).toBe(" title ")
  expect(exact.body).toBe(" \r\nCafé é 東京 🧭 ")
  const result = await app.request("/api/batches", batch("max", ...Array.from({ length: 128 }, (_, i) => upsert(`max-${i}`))))
  expect(result.status).toBe(201)
  expect(result.value.operations).toHaveLength(128)
})

test("legacy JSON and NDJSON importer shares validation, atomic revision and version history", async () => {
  const app = setup()
  const result = await app.request("/api/import", [upsert("a"), upsert("b")].map((value) => JSON.stringify(value)).join("\n"))
  expect(result.status).toBe(201)
  expect(result.value.documents).toHaveLength(2)
  expect(app.store.revision()).toBe(1)
  const invalid = await app.request("/api/import", JSON.stringify(upsert("a", "changed")) + "\n" + JSON.stringify(upsert("bad\0source")))
  expect(invalid.value.error.code).toBe("invalid_document")
  expect(app.store.get(1)?.body).toBe("amber fern")
  expect(app.store.versions(1)).toHaveLength(1)
  expect(app.store.revision()).toBe(1)
  const replacement = await app.request("/api/import", JSON.stringify(upsert("a", "changed")), "application/json")
  expect(replacement.value.documents[0].version).toBe(2)
  expect((await app.request("/api/import", "\n")).status).toBe(400)
})

test("a mid-write SQLite failure rolls back documents, versions, tokens, revision and receipt", async () => {
  const app = setup()
  app.store.import(upsert("existing", "original"))
  const db = new Database(join(app.fixture.directory, "workbench.sqlite"))
  db.exec(`CREATE TRIGGER reject_failure BEFORE INSERT ON documents WHEN NEW.source = 'failure'
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
  const text = batch("retry", upsert("existing", "changed"), upsert("new"), upsert("failure"))
  const failed = await app.request("/api/batches", text)
  expect(failed.status).toBe(500)
  expect(JSON.stringify(failed.value)).not.toContain("synthetic failure")
  expect(app.store.list()).toHaveLength(1)
  expect(app.store.get(1)?.body).toBe("original")
  expect(app.store.versions(1)).toHaveLength(1)
  expect(app.store.search("changed")).toEqual([])
  expect(app.store.search("original")).toHaveLength(1)
  expect(app.store.revision()).toBe(1)
  db.exec("DROP TRIGGER reject_failure")
  db.close()
  const success = await app.request("/api/batches", text)
  expect(success.status).toBe(201)
  expect(success.value.replayed).toBe(false)
  expect(success.value.revision).toBe(2)
})

test("receipt insertion failure rolls back an otherwise finished batch and its revision", async () => {
  const app = setup()
  const db = new Database(join(app.fixture.directory, "workbench.sqlite"))
  db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON batch_receipts
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`)
  const text = batch("receipt_retry", upsert("a"), upsert("b"))
  const failed = await app.request("/api/batches", text)
  expect(failed.status).toBe(500)
  expect(app.store.list()).toEqual([])
  expect(app.store.versions(1)).toEqual([])
  expect(app.store.search("amber")).toEqual([])
  expect(app.store.revision()).toBe(0)
  db.exec("DROP TRIGGER reject_receipt")
  db.close()
  const retry = await app.request("/api/batches", text)
  expect(retry.status).toBe(201)
  expect(retry.value.replayed).toBe(false)
  expect(retry.value.revision).toBe(1)
  expect((await app.request("/api/batches", text)).status).toBe(200)
})

test("literal lexical tokens are ASCII runs, distinct, case-insensitive, and combined across title and body", async () => {
  const app = setup()
  app.store.importMany([
    upsert("a", "東京AMBERé stone é café", "Fern"), upsert("b", "amber stones", "Fern"),
    upsert("c", "amber stone", "Other"), upsert("d", "Kelvin", "Unicode"),
  ])
  expect(app.store.search("FERN amber amber stone").map((row) => row.source)).toEqual(["a"])
  expect(app.store.search("cafe")).toEqual([])
  expect(app.store.search("caf").map((row) => row.source)).toEqual(["a"])
  expect(app.store.search("kelvin")).toEqual([])
  expect(app.store.search("elvin").map((row) => row.source)).toEqual(["d"])
  for (const query of ["", "東京", "İ", "a b c d e f g h i"]) {
    expect((await app.request(`/api/search?q=${encodeURIComponent(query)}`)).value.error.code).toBe("invalid_query")
  }
})

test("pagination binds exact query and limit, survives no-op/replay/restart, and detects all material changes", async () => {
  const app = setup()
  const seed = batch("seed", ...Array.from({ length: 7 }, (_, i) => upsert(`s${i}`)))
  await app.request("/api/batches", seed)
  const first = app.store.searchPage("AMBER", 2)
  expect(first.results.map((row) => row.id)).toEqual([1, 2])
  expect(first.query).toBe("AMBER")
  const cursor = first.nextCursor!
  for (const suffix of [`q=amber&limit=2&cursor=${cursor}`, `q=AMBER&limit=3&cursor=${cursor}`, "q=AMBER&limit=2&cursor=garbage", "q=AMBER&limit=2&cursor="]) {
    expect((await app.request(`/api/search?${suffix}`)).value.error.code).toBe("invalid_cursor")
  }
  await app.request("/api/batches", seed)
  app.store.import(upsert("s0"))
  app.store.close()
  app.fixture.store = openStore(app.fixture.directory)
  let page = app.store.searchPage("AMBER", 2, cursor)
  const ids = [...first.results, ...page.results].map((row) => row.id)
  while (page.nextCursor) {
    page = app.store.searchPage("AMBER", 2, page.nextCursor)
    ids.push(...page.results.map((row) => row.id))
  }
  expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(page.nextCursor).toBeNull()
  app.store.import(upsert("unrelated", "cobalt"))
  const stale = await app.request(`/api/search?q=AMBER&limit=2&cursor=${cursor}`)
  expect(stale.status).toBe(409)
  expect(stale.value.error.code).toBe("stale_cursor")
})

test("limits reject empty, fractional, rounded, signed, and out-of-bounds values", async () => {
  const app = setup()
  app.store.importMany(Array.from({ length: 12 }, (_, i) => upsert(String(i))))
  expect((await app.request("/api/search?q=amber")).value.results).toHaveLength(10)
  for (const limit of ["", "0", "51", "-1", "1.5", "2x", "1e1", "Infinity", "9007199254740993"]) {
    const result = await app.request(`/api/search?q=amber&limit=${limit}`)
    expect(result.status).toBe(400)
    expect(result.value.error.code).toBe("invalid_limit")
  }
})

test("excerpts and citations preserve exact Unicode bytes and remain resolvable after deletion", async () => {
  const app = setup()
  const body = "🧭東京 é Café\r\n".repeat(80) + "AMBER! <script>no()</script>\n" + "🧭".repeat(200)
  const row = app.store.import(upsert("a", body))
  const result = app.store.search("amber")[0]
  const bytes = Buffer.from(body, "utf8")
  expect(result.citation.startByte).toBe(Buffer.byteLength(body.slice(0, body.indexOf("AMBER")), "utf8"))
  expect(result.snippet).toBe(result.citation.quote)
  expect(result.snippet).toContain("AMBER!")
  expect(Buffer.byteLength(result.snippet)).toBeLessThanOrEqual(512)
  expect(bytes.subarray(result.citation.startByte, result.citation.endByte).toString("utf8")).toBe(result.snippet)
  app.store.import(upsert("a", "changed"))
  app.store.batch([{ type: "batch", batchId: "delete" }, { type: "delete", source: "a" }])
  const { startByte, endByte } = result.citation
  const resolved = await app.request(`/api/citations?documentId=${row.id}&version=1&startByte=${startByte}&endByte=${endByte}`)
  expect(resolved.value).toEqual(result.citation)
  expect((await app.request(`/api/documents/${row.id}`)).status).toBe(404)
  expect((await app.request(`/api/documents/${row.id}/versions/1`)).value.document.body).toBe(body)
  expect((await app.request(`/api/documents/${row.id}/versions`)).value.versions.map((value: { version: number }) => value.version)).toEqual([1, 2])
  for (const [start, end] of [[0, 0], [0, 4], [4, 4], [bytes.length, bytes.length]]) {
    expect(app.store.citation(row.id, 1, start, end).quote).toBe(bytes.subarray(start, end).toString("utf8"))
  }
  for (const [start, end] of [[1, 4], [0, 3], [4, 0], [0, bytes.length + 1]]) {
    expect((await app.request(`/api/citations?documentId=${row.id}&version=1&startByte=${start}&endByte=${end}`)).value.error.code).toBe("invalid_range")
  }
  expect((await app.request("/api/citations?documentId=999&version=1&startByte=0&endByte=0")).status).toBe(404)
  for (const params of ["", "documentId=1&version=1&startByte=0", "documentId=0&version=1&startByte=0&endByte=0", "documentId=1&version=1&startByte=0.5&endByte=1"]) {
    expect((await app.request(`/api/citations?${params}`)).value.error.code).toBe("invalid_range")
  }
})

test("excerpts prefer a complete fitting query token over a token larger than the excerpt cap", () => {
  const app = setup()
  const long = "a".repeat(513)
  app.store.import(upsert("long", `${long}\nFERN`))
  const result = app.store.search(`${long} fern`)[0]
  expect(result.snippet).toBe("FERN")
  expect(result.citation.startByte).toBe(514)
  expect(result.citation.endByte).toBe(518)
})

test("title-only matches quote the initial body or an empty range, and reads never change revision", async () => {
  const app = setup()
  app.store.importMany([upsert("empty", "", "amber"), upsert("text", "🧭Café é\n東京", "amber")])
  const results = app.store.searchPage("amber").results
  expect(results[0].citation).toEqual({ documentId: 1, version: 1, startByte: 0, endByte: 0, quote: "" })
  expect(results[1].snippet).toBe("🧭Café é\n東京")
  for (const path of ["/api/health", "/api/documents", "/api/documents/1", "/api/documents/1/versions", "/api/documents/1/versions/1", "/api/documents/999/versions"]) await app.request(path)
  expect((await app.request("/api/documents")).value.revision).toBe(1)
  expect(app.store.revision()).toBe(1)
})

test("invalid UTF-8 and malformed importer JSON use safe API errors", async () => {
  const app = setup()
  const response = await createHandler(app.store)(new Request("http://localhost/api/batches", {
    method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array([0xc3, 0x28]),
  }))
  expect(response.status).toBe(400)
  expect((await response.json()).error.code).toBe("invalid_batch")
  expect((await app.request("/api/import", "{", "application/json")).value.error.code).toBe("invalid_document")
  expect(app.store.revision()).toBe(0)
})
