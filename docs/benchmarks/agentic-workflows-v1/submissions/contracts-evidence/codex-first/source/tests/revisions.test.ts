import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStore } from "../server/storage"
import { ApiError, documentInput } from "../server/types"

const directories: string[] = []
const stores: ReturnType<typeof openStore>[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), "ew-revisions-")); directories.push(path); return path }
function storeAt(path = directory()) { const store = openStore(path); stores.push(store); return store }
function batch(id: string, operations: unknown[]) { return [JSON.stringify({ type: "batch", batchId: id }), ...operations.map(op => JSON.stringify(op))].join("\n") }
const upsert = (source: string, body = "amber fern", title = "Field log") => ({ type: "upsert", source, title, body })
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error("Expected rejection") }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe(expected) }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test("legacy migration preserves IDs, Unicode, timestamps, and rebuilds exact token search", async () => {
  for (const populated of [false, true]) {
    const path = directory()
    const db = new Database(join(path, "workbench.sqlite"))
    db.exec(await Bun.file("schema/legacy.sql").text())
    const body = "Café 🧭 東京 e\u0301 amber"
    if (populated) db.query("INSERT INTO documents VALUES (42,?,?,?,?)").run(" notes/古.md ", "Original", body, "2001-02-03T04:05:06.000Z")
    db.close()
    const store = storeAt(path)
    expect(store.revision()).toBe(populated ? 1 : 0)
    if (populated) {
      const row = { id: 42, source: " notes/古.md ", title: "Original", body, created_at: "2001-02-03T04:05:06.000Z", version: 1 }
      expect(store.get(42)).toEqual(row)
      expect(store.historical(42, 1)).toEqual(row)
      expect(store.search("AMBER").map(row => row.id)).toEqual([42])
      expect(store.import({ source: "new", title: "New", body: "" }).id).toBeGreaterThan(42)
    }
  }
})

test("revision lifecycle, stable IDs, canonical receipts, and history survive reopening", () => {
  const path = directory()
  let store = storeAt(path)
  const first = store.batch(batch("initial", [upsert("a"), upsert("b")]))
  expect(first.revision).toBe(1)
  expect(first.operations.map(op => op.version)).toEqual([1, 1])
  const id = first.operations[0].documentId!
  expect(store.batch(batch("unchanged", [upsert("a")])).operations[0].changed).toBe(false)
  expect(store.revision()).toBe(1)
  const original = store.historical(id, 1)
  expect(store.batch(batch("edit", [upsert("a", "cobalt")])).revision).toBe(2)
  expect(store.get(id)?.version).toBe(2)
  const deletion = store.batch(batch("delete", [{ type: "delete", source: "a" }, { type: "delete", source: "missing" }]))
  expect(deletion.revision).toBe(3)
  expect(deletion.operations).toEqual([
    { type: "delete", source: "a", documentId: id, version: null, changed: true },
    { type: "delete", source: "missing", documentId: null, version: null, changed: false },
  ])
  expect(store.get(id)).toBeNull()
  expect(store.search("cobalt")).toEqual([])
  expect(store.historical(id, 1)).toEqual(original)
  expect(store.batch(batch("delete-again", [{ type: "delete", source: "a" }])).revision).toBe(3)
  const revival = store.batch(batch("revive", [upsert("a")]))
  expect(revival.operations[0]).toMatchObject({ documentId: id, version: 3, changed: true })
  expect(store.versions(id).map(row => row.version)).toEqual([1, 2, 3])
  const pageBeforeRestart = store.searchPage("amber", 1)
  store.close(); stores.pop()
  store = storeAt(path)
  expect(store.historical(id, 1)).toEqual(original)
  expect(store.versions(id).map(row => row.version)).toEqual([1, 2, 3])
  expect(store.searchPage("amber", 1, pageBeforeRestart.nextCursor).results.map(row => row.source)).toEqual(["b"])
  const canonicalRetry = '\r\n {"extra":true,"batchId":"initial","type":"batch"}\r\n' +
    '{"title":"Field log","body":"amber fern","source":"a","type":"upsert","ignored":3}\r\n' +
    '{"body":"amber fern","source":"b","title":"Field log","type":"upsert"}\r\n'
  expect(store.batch(canonicalRetry)).toEqual({ ...first, replayed: true })
  expect(store.revision()).toBe(4)
  expect(store.get(id)?.version).toBe(3)
  code(() => store.batch(batch("initial", [upsert("b"), upsert("a")])), "batch_conflict")
  expect(store.revision()).toBe(4)
})

test("whole-request validation and a database failure roll back documents, index, history, revision, receipt", () => {
  const path = directory(), store = storeAt(path)
  const original = store.import({ source: "existing", title: "Old", body: "amber" })
  code(() => store.batch(batch("retry", [upsert("existing", "cobalt"), upsert("bad", "\ud800")])), "invalid_batch")
  expect(store.get(original.id)?.body).toBe("amber")
  expect(() => store.importMany([upsert("new"), upsert("bad", "\0")])).toThrow()
  expect(store.list()).toHaveLength(1)
  const db = new Database(join(path, "workbench.sqlite"))
  db.exec("CREATE TRIGGER force_failure BEFORE INSERT ON document_versions WHEN NEW.title = 'force failure' BEGIN SELECT RAISE(ABORT, 'test fault'); END")
  expect(() => store.batch(batch("retry", [upsert("existing", "cobalt"), upsert("new", "x", "force failure")]))).toThrow()
  expect(store.revision()).toBe(1)
  expect(store.get(original.id)?.body).toBe("amber")
  expect(store.versions(original.id)).toHaveLength(1)
  expect(store.search("amber")).toHaveLength(1)
  expect(store.search("cobalt")).toHaveLength(0)
  expect(db.query("SELECT * FROM batch_receipts").all()).toHaveLength(0)
  db.exec("DROP TRIGGER force_failure"); db.close()
  expect(store.batch(batch("retry", [upsert("new")])).revision).toBe(2)
})

test("batch rejects invalid syntax, sizes, duplicate sources, and Unicode without reserving IDs", () => {
  const store = storeAt()
  const invalid = [
    "", "{", batch("bad id", [upsert("a")]), batch("empty", []),
    batch("dup", [upsert("a"), { type: "delete", source: "a" }]),
    batch("extra", [{ type: "batch", batchId: "x" }]), batch("type", [{ type: "update", source: "a" }]),
    batch("many", Array.from({ length: 129 }, (_, i) => upsert(String(i)))),
    ...["", "  ", "a\n", "a\0", "🧭".repeat(201), "\udc00"].map(source => batch("source", [upsert(source)])),
    ...["", "  ", "🧭".repeat(201), "\ud800"].map(title => batch("title", [upsert("a", "body", title)])),
    ...["\0", "\ud800", "é".repeat(524289)].map(body => batch("body", [upsert("a", body)])),
  ]
  for (const input of invalid) code(() => store.batch(input), "invalid_batch")
  expect(store.list()).toEqual([])
  expect(store.revision()).toBe(0)
  expect(documentInput({ source: " 🧭 ", title: " 🧭 ", body: "é".repeat(524288) }).source).toBe(" 🧭 ")
  expect(store.batch(batch("empty", [{ type: "delete", source: "unknown" }])).revision).toBe(0)
  code(() => store.batch(batch("empty", [upsert("a")])), "batch_conflict")
})

test("lexical AND search, exact byte citations, pagination integrity, and revision invalidation", () => {
  const store = storeAt()
  const prefix = "🧭 Café e\u0301 東京\n".repeat(80)
  const body = prefix + "AMBER, Fern!\n<script>untrusted()</script>" + "🧭".repeat(180)
  store.importMany([
    { source: "a", title: "Field", body }, { source: "b", title: "Amber fern", body: "Café 🧭" },
    { source: "c", title: "Fern", body: "東京amber東京" }, { source: "d", title: "amber fern", body: "" },
    { source: "e", title: "x", body: "amberish fern" }, { source: "f", title: "x", body: "ambér fern" },
  ])
  expect(store.search("AMBER amber FERN").map(row => row.source)).toEqual(["a", "b", "c", "d"])
  expect(store.search("the")).toEqual([])
  const page = store.searchPage("AMBER fern", 2)
  const citation = page.results[0].citation
  expect(citation.startByte).toBe(Buffer.byteLength(prefix))
  expect(citation.quote).toContain("AMBER")
  expect(Buffer.byteLength(citation.quote)).toBeLessThanOrEqual(512)
  expect(Buffer.from(body).subarray(citation.startByte, citation.endByte).toString()).toBe(citation.quote)
  expect(page.results[0].snippet).toBe(citation.quote)
  expect(page.results[1].citation.quote).toBe("Café 🧭")
  const next = store.searchPage("AMBER fern", 2, page.nextCursor)
  expect(next.results.map(row => row.source)).toEqual(["c", "d"])
  expect(next.results[1].citation).toMatchObject({ startByte: 0, endByte: 0, quote: "" })
  expect(next.nextCursor).toBeNull()
  expect(store.citation(2, 1, 0, 5).quote).toBe("Café")
  expect(store.citation(2, 1, 5, 5).quote).toBe("")
  for (const range of [[4, 5], [0, 7], [0, 999], [5, 4], [-1, 0]]) code(() => store.citation(2, 1, ...range as [number, number]), "invalid_range")
  code(() => store.citation(999, 1, 0, 0), "not_found")
  code(() => store.searchPage("AMBER fern ", 2, page.nextCursor), "invalid_cursor")
  code(() => store.searchPage("AMBER fern", 3, page.nextCursor), "invalid_cursor")
  code(() => store.searchPage("AMBER fern", 2, page.nextCursor + "x"), "invalid_cursor")
  for (const query of ["", "東京", "a b c d e f g h i"]) code(() => store.searchPage(query, 2), "invalid_query")
  for (const limit of [0, 51, 1.5]) code(() => store.searchPage("amber", limit), "invalid_limit")
  const noOp = batch("noop", [{ type: "delete", source: "missing" }])
  store.batch(noOp); store.batch(noOp)
  expect(store.searchPage("AMBER fern", 2, page.nextCursor).results).toEqual(next.results)
  store.import({ source: "unrelated", title: "Z", body: "z" })
  code(() => store.searchPage("AMBER fern", 2, page.nextCursor), "stale_cursor")
  store.batch(batch("remove", [{ type: "delete", source: "a" }]))
  expect(store.citation(citation.documentId, citation.version, citation.startByte, citation.endByte)).toEqual(citation)
})

test("an excerpt prefers a complete matching token that fits the byte budget", () => {
  const store = storeAt()
  const long = "a".repeat(600)
  store.import({ source: "long", title: "Long tokens", body: `${long} 🧭 AMBER` })
  const result = store.searchPage(`${long} amber`, 10).results[0]
  expect(result.snippet).toBe("AMBER")
  expect(result.citation.startByte).toBe(606)
})
