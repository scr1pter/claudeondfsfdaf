import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { openStore } from "../server/storage"
import { ApiError, documentInput, integerParameter, parseBatch, parseImport } from "../server/types"

const verification = resolve(".verification")
mkdirSync(verification, { recursive: true })
const directories: string[] = []
const stores: ReturnType<typeof openStore>[] = []
function directory() { const path = mkdtempSync(join(verification, "unit-")); directories.push(path); return path }
function storeAt(path = directory()) { const store = openStore(path); stores.push(store); return store }
function batch(id: string, ...operations: unknown[]) { return [JSON.stringify({ type: "batch", batchId: id }), ...operations.map((operation) => JSON.stringify(operation))].join("\n") }
const upsert = (source: string, body = "amber fern", title = "Field note") => ({ type: "upsert", source, title, body })
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error("Expected rejection") }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe(expected) }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("legacy migration preserves IDs, timestamps and Unicode, rebuilds lexical index, and runs once", () => {
  const path = directory()
  const legacy = new Database(join(path, "workbench.sqlite"))
  legacy.exec(readFileSync("schema/legacy.sql", "utf8"))
  const body = "Café 🧭 東京 e\u0301 <script>untrusted()</script> amber"
  legacy.query("INSERT INTO documents VALUES (?, ?, ?, ?, ?)").run(7, " first ", "Original", body, "2020-01-02T03:04:05.000Z")
  legacy.query("INSERT INTO documents VALUES (?, ?, ?, ?, ?)").run(42, "second", "Other", "fern", "2021-02-03T00:00:00Z")
  legacy.query("INSERT INTO document_tokens VALUES (7, 'wrong')").run()
  legacy.close()
  const store = storeAt(path)
  expect(store.revision()).toBe(1)
  expect(store.list().map((row) => row.id)).toEqual([7, 42])
  expect(store.get(7)).toEqual({ id: 7, source: " first ", title: "Original", body, created_at: "2020-01-02T03:04:05.000Z", version: 1 })
  expect(store.historical(7, 1)).toEqual(store.get(7))
  expect(store.search("amber").map((row) => row.id)).toEqual([7])
  expect(store.search("wrong")).toEqual([])
  const reopened = storeAt(path)
  expect(reopened.revision()).toBe(1)
  expect(reopened.versions(7)).toHaveLength(1)
  expect(reopened.import({ source: "new", title: "New", body: "" }).id).toBeGreaterThan(42)
})

test("fresh and empty legacy stores start at revision zero", () => {
  expect(storeAt().revision()).toBe(0)
  const path = directory()
  const legacy = new Database(join(path, "workbench.sqlite"))
  legacy.exec(readFileSync("schema/legacy.sql", "utf8"))
  legacy.close()
  expect(storeAt(path).revision()).toBe(0)
})

test("immutable contiguous versions, deletes, no-ops, revival and durable original receipts", () => {
  const path = directory()
  const store = storeAt(path)
  const text = batch("first", upsert("a"), upsert("b"), { type: "delete", source: "unknown" })
  const first = store.batch(text)
  expect(first.revision).toBe(1)
  expect(first.operations.map((op) => op.documentId)).toEqual([1, 2, null])
  expect(first.operations[2]).toEqual({ type: "delete", source: "unknown", documentId: null, version: null, changed: false })
  expect(store.batch(batch("noop", upsert("a"))).operations[0]).toMatchObject({ version: 1, changed: false })
  expect(store.revision()).toBe(1)
  expect(store.import({ source: "a", title: "Field note", body: "cobalt" }).version).toBe(2)
  expect(store.revision()).toBe(2)
  expect(store.batch(batch("delete", { type: "delete", source: "a" })).operations[0]).toEqual({ type: "delete", source: "a", documentId: 1, version: null, changed: true })
  expect(store.get(1)).toBeNull()
  expect(store.search("cobalt")).toEqual([])
  expect(store.historical(1, 1)?.body).toBe("amber fern")
  expect(store.batch(batch("delete_again", { type: "delete", source: "a" })).revision).toBe(3)
  expect(store.import({ source: "a", title: "Field note", body: "cobalt" })).toMatchObject({ id: 1, version: 3 })
  expect(store.versions(1).map((row) => row.version)).toEqual([1, 2, 3])
  expect(store.revision()).toBe(4)
  const equivalent = '\r\n{"ignored":true,"batchId":"first","type":"batch"}\r\n' +
    '{"body":"amber fern","title":"Field note","source":"a","type":"upsert","extra":9}\r\n\r\n' +
    '{"title":"Field note","type":"upsert","body":"amber fern","source":"b"}\r\n' +
    '{"source":"unknown","type":"delete","body":"ignored"}\r\n'
  expect(store.batch(equivalent)).toEqual({ ...first, replayed: true })
  code(() => store.batch(batch("first", upsert("b"), upsert("a"), { type: "delete", source: "unknown" })), "batch_conflict")
  expect(store.revision()).toBe(4)
  const reopened = storeAt(path)
  expect(reopened.batch(text)).toEqual({ ...first, replayed: true })
  expect(reopened.get(1)?.version).toBe(3)
  expect(reopened.historical(1, 1)?.body).toBe("amber fern")
})

test("whole-request validation leaves no writes or receipt; invalid batches can be corrected", () => {
  const store = storeAt()
  const invalid = [
    "", "{}", "not json", batch("x"), batch("bad id", upsert("a")), batch("x\n", upsert("a")),
    batch("x", upsert("a"), upsert("a")), batch("x", upsert("a"), { type: "batch", batchId: "extra" }),
    batch("x", upsert("a"), { type: "unknown", source: "b" }), batch("x", upsert("a"), upsert("bad\nsource")),
    batch("x", upsert("a"), upsert("b", "\uD800")), batch("x", upsert("a"), upsert("b", "\0")),
    batch("x", ...Array.from({ length: 129 }, (_, i) => upsert(String(i)))),
  ]
  for (const text of invalid) {
    code(() => store.batch(text), "invalid_batch")
    expect(store.collection()).toEqual({ documents: [], revision: 0 })
  }
  expect(store.batch(batch("x", upsert("a"))).replayed).toBe(false)
  expect(() => store.importMany([{ source: "b", title: "Good", body: "text" }, { source: "c", title: "", body: "bad" }])).toThrow()
  expect(store.list().map((row) => row.source)).toEqual(["a"])
  code(() => parseImport('{"source":"b","title":"Valid","body":"text"}\n{', true), "invalid_document")
})

test("a database failure rolls back document versions, search, revision and receipt together", () => {
  const path = directory()
  const store = storeAt(path)
  store.batch(batch("seed", upsert("a")))
  const fault = new Database(join(path, "workbench.sqlite"))
  fault.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON batch_receipts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const text = batch("atomic", upsert("a", "cobalt"), upsert("b", "cobalt"))
  expect(() => store.batch(text)).toThrow()
  expect(store.revision()).toBe(1)
  expect(store.get(1)?.version).toBe(1)
  expect(store.versions(1)).toHaveLength(1)
  expect(store.list()).toHaveLength(1)
  expect(store.search("amber")).toHaveLength(1)
  expect(store.search("cobalt")).toHaveLength(0)
  expect(fault.query("SELECT * FROM batch_receipts WHERE batch_id = 'atomic'").get()).toBeNull()
  fault.exec("DROP TRIGGER receipt_failure")
  fault.close()
  expect(store.batch(text)).toMatchObject({ revision: 2, replayed: false })
})

test("Unicode scalar and byte limits preserve accepted text without trimming", () => {
  const accepted = { source: "🧭".repeat(200), title: "🧭".repeat(200), body: "🧭".repeat(262144) }
  expect(documentInput(accepted)).toEqual(accepted)
  expect(documentInput({ source: " padded ", title: " padded ", body: "\r\n e\u0301 " })).toEqual({ source: " padded ", title: " padded ", body: "\r\n e\u0301 " })
  for (const input of [
    { ...accepted, source: "🧭".repeat(201) }, { ...accepted, title: "🧭".repeat(201) },
    { ...accepted, body: accepted.body + "a" }, { ...accepted, title: "\udfff" },
    { ...accepted, source: "\ud800" }, { ...accepted, body: "a\ud800" },
    { ...accepted, source: "\u001f" }, { ...accepted, title: " \t\n " },
  ]) expect(() => documentInput(input)).toThrow()
  for (const value of ["1\n", "1.0", "1e1", "-1", " 1", "", "Infinity", "9007199254740992"]) code(() => integerParameter(value), "invalid_range")
})

test("literal ASCII tokens require all terms across title and body", () => {
  const store = storeAt()
  store.importMany([
    { source: "a", title: "AMBER", body: "東京fern🧭 café e\u0301 42" },
    { source: "b", title: "amber", body: "ferns caf stone" },
    { source: "c", title: "amber fern", body: "" },
  ])
  expect(store.search("AMBER fern amber").map((row) => row.source)).toEqual(["a", "c"])
  expect(store.search("amber caf").map((row) => row.source)).toEqual(["a", "b"])
  expect(store.search("fern 42").map((row) => row.source)).toEqual(["a"])
  expect(store.search("fer")).toEqual([])
  for (const q of ["", "🧭 東京", "a b c d e f g h i"]) code(() => store.search(q), "invalid_query")
})

test("pagination has no gaps, binds exact query and limit, survives no-ops/restart, and rejects stale revisions", () => {
  const path = directory()
  const store = storeAt(path)
  const initial = batch("seed", ...Array.from({ length: 7 }, (_, i) => upsert(String(i))))
  store.batch(initial)
  const q = " AMBER "
  const page1 = store.searchPage(q, 2)
  expect(page1.results.map((row) => row.id)).toEqual([1, 2])
  const cursor = page1.nextCursor!
  code(() => store.searchPage("amber", 2, cursor), "invalid_cursor")
  code(() => store.searchPage(q, 10, cursor), "invalid_cursor")
  for (const invalid of ["", "e30", cursor + "bad", "garbage"]) code(() => store.searchPage(q, 2, invalid), "invalid_cursor")
  store.batch(initial)
  store.batch(batch("noop", upsert("0")))
  const reopened = storeAt(path)
  let next: string | null = cursor
  const ids = page1.results.map((row) => row.id)
  while (next) {
    const page = reopened.searchPage(q, 2, next)
    ids.push(...page.results.map((row) => row.id))
    next = page.nextCursor
  }
  expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7])
  store.import({ source: "unrelated", title: "Other", body: "cobalt" })
  code(() => reopened.searchPage(q, 2, cursor), "stale_cursor")
  for (const limit of [0, 51, 1.5, NaN]) code(() => store.searchPage(q, limit), "invalid_limit")
})

test("citations use exact UTF-8 slices at scalar boundaries and remain available after deletion", () => {
  const store = storeAt()
  const body = "東京🧭 e\u0301 Café\r\n".repeat(60) + "AMBER fern. <img src=x onerror=bad()>\n" + "🧭".repeat(160)
  const row = store.import({ source: "unicode", title: "Note", body })
  const result = store.search("amber")[0]
  const bound = result.citation
  expect(bound.startByte).toBeGreaterThan(0)
  expect(bound.endByte - bound.startByte).toBeLessThanOrEqual(512)
  expect(bound.quote).toContain("AMBER")
  expect(bound.quote).toBe(Buffer.from(body).subarray(bound.startByte, bound.endByte).toString("utf8"))
  expect(result.snippet).toBe(bound.quote)
  expect(store.citation(row.id, 1, bound.startByte, bound.endByte)).toEqual(bound)
  expect(store.citation(row.id, 1, 0, 0).quote).toBe("")
  const end = Buffer.byteLength(body)
  expect(store.citation(row.id, 1, end, end).quote).toBe("")
  for (const [start, finish] of [[1, 3], [0, 1], [-1, 0], [2, 1], [0, end + 1]]) code(() => store.citation(row.id, 1, start, finish), "invalid_range")
  code(() => store.citation(999, 1, 0, 0), "not_found")
  code(() => store.citation(row.id, 999, 0, 0), "not_found")
  store.import({ source: "unicode", title: "Replacement", body: "new body" })
  store.batch(batch("delete", { type: "delete", source: "unicode" }))
  expect(store.citation(row.id, 1, bound.startByte, bound.endByte)).toEqual(bound)
  const empty = store.import({ source: "empty", title: "amber", body: "" })
  expect(store.search("amber")[0].citation).toEqual({ documentId: empty.id, version: 1, startByte: 0, endByte: 0, quote: "" })
  const titleOnly = store.import({ source: "title-only", title: "amber", body: "🧭".repeat(300) })
  expect(store.search("amber").find((hit) => hit.id === titleOnly.id)?.citation).toMatchObject({ startByte: 0, endByte: 512, quote: "🧭".repeat(128) })
  const exactToken = "x".repeat(512)
  const long = store.import({ source: "long-token", title: "Long token", body: "東京 🧭 " + exactToken + " end" })
  expect(store.search(exactToken).find((hit) => hit.id === long.id)?.citation.quote).toBe(exactToken)
  const mixed = store.import({ source: "mixed-token", title: "Mixed tokens", body: "x".repeat(600) + " 東京 amber" })
  expect(store.search("x".repeat(600) + " amber").find((hit) => hit.id === mixed.id)?.citation.quote).toContain("amber")
})
