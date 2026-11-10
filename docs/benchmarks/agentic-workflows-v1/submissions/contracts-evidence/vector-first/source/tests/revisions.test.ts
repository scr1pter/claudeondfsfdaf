import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler } from "../server/api"
import { openStore } from "../server/storage"
import { terms } from "../server/types"

const cleanup: (() => void)[] = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

function fixture(legacy?: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "ew-revisions-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  if (legacy !== undefined) {
    const db = new Database(join(directory, "workbench.sqlite"))
    db.exec(readFileSync(new URL("../schema/legacy.sql", import.meta.url), "utf8"))
    if (legacy) {
      db.query("INSERT INTO documents (id, source, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(37, " legacy/🧭.md ", "Original Café", "# Amber\n東京 e\u0301 🧭", "2020-01-02T03:04:05.000Z")
    }
    db.close()
  }
  let store = openStore(directory)
  cleanup.push(() => store.close())
  return {
    directory,
    get store() { return store },
    restart() { store.close(); store = openStore(directory) },
    async api(path: string, body?: string, contentType = "application/x-ndjson") {
      const response = await createHandler(store)(new Request(`http://localhost${path}`, body === undefined ? undefined : {
        method: "POST", headers: { "content-type": contentType }, body,
      }))
      return { status: response.status, value: await response.json() }
    },
  }
}

const doc = (source: string, body = "amber fern", title = "Field record") => ({ source, title, body })
const upsert = (source: string, body = "amber fern", title = "Field record") => ({ type: "upsert", ...doc(source, body, title) })
const batch = (batchId: string, operations: unknown[]) => [{ type: "batch", batchId }, ...operations].map((value) => JSON.stringify(value)).join("\n")

test("migration preserves legacy IDs, exact content and timestamps, and initializes revision once", async () => {
  const f = fixture(true)
  const original = f.store.get(37)!
  expect(original).toEqual({ id: 37, source: " legacy/🧭.md ", title: "Original Café", body: "# Amber\n東京 e\u0301 🧭", created_at: "2020-01-02T03:04:05.000Z", version: 1 })
  expect(f.store.historical(37, 1)).toEqual(original)
  expect(f.store.search("amber").map((row) => row.id)).toEqual([37])
  expect((await f.api("/api/health")).value).toEqual({ ok: true, schemaVersion: 2, revision: 1 })
  f.restart()
  expect(f.store.get(37)).toEqual(original)
  expect(f.store.revision()).toBe(1)
  expect(f.store.import(doc("new")).id).toBeGreaterThan(37)
})

test("fresh and empty legacy databases start at revision zero and reads do not create state", async () => {
  for (const legacy of [undefined, false]) {
    const f = fixture(legacy)
    expect((await f.api("/api/health")).value.revision).toBe(0)
    expect((await f.api("/api/documents")).value).toEqual({ documents: [], revision: 0 })
    for (const path of ["/api/documents/1", "/api/documents/1/versions", "/api/documents/1/versions/1", "/api/citations?documentId=1&version=1&startByte=0&endByte=0"]) {
      expect((await f.api(path)).status).toBe(404)
    }
    expect(f.store.revision()).toBe(0)
    f.restart()
    expect(f.store.revision()).toBe(0)
  }
})

test("changed requests increment once, exact upserts are no-ops, deletes retain history and revival retains ID", () => {
  const f = fixture()
  const first = f.store.batch(batch("first", [upsert("a"), upsert("b")]))
  expect(first.revision).toBe(1)
  const id = first.operations[0].documentId!
  const original = f.store.get(id)!
  const unchanged = f.store.batch(batch("noop", [upsert("a"), { type: "delete", source: "unknown" }]))
  expect(unchanged.operations).toEqual([
    { type: "upsert", source: "a", documentId: id, version: 1, changed: false },
    { type: "delete", source: "unknown", documentId: null, version: null, changed: false },
  ])
  expect(unchanged.revision).toBe(1)
  f.store.batch(batch("replace", [upsert("a", "cobalt", "Revised")]))
  expect(f.store.get(id)?.version).toBe(2)
  expect(f.store.search("amber").map((row) => row.source)).toEqual(["b"])
  const deleted = f.store.batch(batch("delete", [{ type: "delete", source: "a" }]))
  expect(deleted.operations[0]).toEqual({ type: "delete", source: "a", documentId: id, version: null, changed: true })
  expect(f.store.get(id)).toBeNull()
  expect(f.store.historical(id, 1)).toEqual(original)
  expect(f.store.search("cobalt")).toEqual([])
  expect(f.store.batch(batch("deleteAgain", [{ type: "delete", source: "a" }])).operations[0].changed).toBe(false)
  expect(f.store.revision()).toBe(3)
  const revived = f.store.batch(batch("revive", [upsert("a", "cobalt", "Revised")]))
  expect(revived.operations[0]).toMatchObject({ documentId: id, version: 3, changed: true })
  expect(f.store.versions(id).map((row) => row.version)).toEqual([1, 2, 3])
  f.restart()
  expect(f.store.get(id)?.version).toBe(3)
  expect(f.store.historical(id, 1)).toEqual(original)
  expect(f.store.revision()).toBe(4)
})

test("batch identity ignores formatting and extra properties, persists original receipt, and conflicts without changes", async () => {
  const f = fixture()
  const text = batch("retry_1", [upsert("a"), upsert("b")])
  const first = await f.api("/api/batches", text)
  expect(first.status).toBe(201)
  f.store.import(doc("a", "new material"))
  f.restart()
  const alternate = '\r\n {"batchId":"retry_1","extra":true,"type":"batch"}\r\n\r\n' +
    '{"body":"amber fern","title":"Field record","source":"a","ignored":0,"type":"upsert"}\r\n' +
    '{"source":"b","type":"upsert","title":"Field record","body":"amber fern"}\r\n'
  const replay = await f.api("/api/batches", alternate)
  expect(replay.status).toBe(200)
  expect(replay.value).toEqual({ ...first.value, replayed: true })
  expect(f.store.revision()).toBe(2)
  expect(f.store.get(1)?.body).toBe("new material")
  for (const changed of [[upsert("b"), upsert("a")], [upsert("a", "different"), upsert("b")]]) {
    const conflict = await f.api("/api/batches", batch("retry_1", changed))
    expect(conflict.status).toBe(409)
    expect(conflict.value.error.code).toBe("batch_conflict")
  }
  const noop = batch("reserved", [{ type: "delete", source: "missing" }])
  expect((await f.api("/api/batches", noop)).value.revision).toBe(2)
  expect((await f.api("/api/batches", batch("reserved", [upsert("missing")]))).status).toBe(409)
  expect((await f.api("/api/batches", noop)).value.replayed).toBe(true)
  expect(f.store.revision()).toBe(2)
})

test("whole batch validation rejects malformed protocols before any writes", async () => {
  const f = fixture()
  const good = upsert("would-write")
  const invalid = [
    "", "not json", JSON.stringify(good), batch("headerOnly", []),
    batch("extra", [good, { type: "batch", batchId: "extra2" }]),
    batch("unknown", [good, { type: "edit", source: "bad" }]),
    batch("duplicate", [good, { type: "delete", source: "would-write" }]),
    batch("bad id", [good]), batch("trailing\n", [good]), batch("x".repeat(81), [good]),
    batch("tooMany", Array.from({ length: 129 }, (_, i) => upsert(`s${i}`))),
    batch("missing", [good, { type: "upsert", source: "missing" }]),
    batch("array", [good, []]),
    batch("badJson", [good]) + "\n{",
  ]
  for (const text of invalid) {
    const result = await f.api("/api/batches", text)
    expect(result.status).toBe(400)
    expect(result.value.error.code).toBe("invalid_batch")
    expect(f.store.list()).toEqual([])
    expect(f.store.revision()).toBe(0)
  }
  expect((await f.api("/api/batches", batch("wrongType", [good]), "application/json")).status).toBe(400)
  expect(f.store.batch(batch("max", Array.from({ length: 128 }, (_, i) => upsert(`s${i}`)))).operations).toHaveLength(128)
  expect(f.store.revision()).toBe(1)
})

test("field validation is shared by legacy imports and batches, counts scalars/bytes, and never normalizes", async () => {
  const f = fixture()
  const invalid = [
    { source: " " }, { source: "a\nb" }, { source: "a\u001fb" }, { source: "a\0b" },
    { source: "🧭".repeat(201) }, { source: "\ud800" },
    { title: "\t" }, { title: "🧭".repeat(201) }, { title: "\udfff" },
    { body: "\ud800z" }, { body: "z\udfff" }, { body: "a\0b" }, { body: "🧭".repeat(262145) }, { body: 42 },
  ]
  for (const fields of invalid) {
    const value = { ...doc("bad"), ...fields }
    const imported = await f.api("/api/import", [doc("before"), value].map((row) => JSON.stringify(row)).join("\n"))
    expect(imported.status).toBe(400)
    expect(imported.value.error.code).toBe("invalid_document")
    const batched = await f.api("/api/batches", batch("validate", [upsert("before"), { ...value, type: "upsert" }]))
    expect(batched.status).toBe(400)
    expect(batched.value.error.code).toBe("invalid_batch")
    expect(f.store.list()).toEqual([])
  }
  const exact = doc(" 🧭" + "x".repeat(197) + " ", "🧭".repeat(262144), "🧭".repeat(200))
  const accepted = await f.api("/api/import", JSON.stringify(exact), "application/json")
  expect(accepted.status).toBe(201)
  expect(accepted.value.documents[0]).toMatchObject({ ...exact, version: 1 })
  expect(f.store.revision()).toBe(1)
})

test("legacy NDJSON uses one transaction/revision and exact imports create no extra version", async () => {
  const f = fixture()
  const text = [doc("a"), doc("b")].map((row) => JSON.stringify(row)).join("\r\n\r\n")
  const first = await f.api("/api/import", text)
  expect(first.status).toBe(201)
  expect(first.value.documents.map((row: { version: number }) => row.version)).toEqual([1, 1])
  expect(f.store.revision()).toBe(1)
  expect((await f.api("/api/import", text)).status).toBe(201)
  expect(f.store.revision()).toBe(1)
  expect(f.store.versions(1)).toHaveLength(1)
  const invalid = await f.api("/api/import", JSON.stringify(doc("partial")) + "\n{invalid")
  expect(invalid.status).toBe(400)
  expect(f.store.list()).toHaveLength(2)
  const changed = await f.api("/api/import", [doc("a", "cobalt"), doc("b", "cobalt")].map((row) => JSON.stringify(row)).join("\n"))
  expect(changed.value.documents.map((row: { version: number }) => row.version)).toEqual([2, 2])
  expect(f.store.revision()).toBe(2)
})

test("a late SQL failure rolls back documents, versions, tokens, revision and receipt; errors expose no internals", async () => {
  const f = fixture()
  const original = f.store.import(doc("a"))
  const db = new Database(join(f.directory, "workbench.sqlite"))
  cleanup.push(() => db.close())
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON batch_receipts BEGIN SELECT RAISE(ABORT, 'private SQL details'); END")
  const input = batch("rollback", [upsert("a", "cobalt"), upsert("new")])
  const result = await f.api("/api/batches", input)
  expect(result.status).toBe(500)
  expect(JSON.stringify(result.value)).not.toContain("private SQL")
  expect(f.store.get(original.id)).toEqual(original)
  expect(f.store.list()).toHaveLength(1)
  expect(f.store.versions(original.id)).toHaveLength(1)
  expect(f.store.search("cobalt")).toEqual([])
  expect(f.store.search("amber")).toHaveLength(1)
  expect(f.store.revision()).toBe(1)
  expect(db.query("SELECT * FROM batch_receipts").all()).toHaveLength(0)
  db.exec("DROP TRIGGER fail_receipt")
  expect((await f.api("/api/batches", input)).status).toBe(201)
  expect(f.store.revision()).toBe(2)

  db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON document_versions WHEN NEW.title = 'Fail' BEGIN SELECT RAISE(ABORT, 'private'); END")
  const failedImport = await f.api("/api/import", [doc("firstPartial"), doc("secondPartial", "text", "Fail")].map((row) => JSON.stringify(row)).join("\n"))
  expect(failedImport.status).toBe(500)
  expect(f.store.list().map((row) => row.source)).toEqual(["a", "new"])
  expect(f.store.revision()).toBe(2)
})

test("lexical search uses distinct ASCII runs across title/body, not substrings or Unicode case folding", async () => {
  const f = fixture()
  expect(terms("AMBER amber Kelvin İX CAFÉ 東京alpha🧭" )).toEqual(["amber", "elvin", "x", "caf", "alpha"])
  f.store.importMany([
    doc("whole", "東京AMBER🧭 café e\u0301", "Fern"),
    doc("substring", "amberish", "Fern"),
    doc("titleOnly", "", "AMBER fern"),
    doc("wrong", "amber", "No fernlike"),
  ])
  const result = await f.api("/api/search?q=AMBER%20fern%20amber")
  expect(result.value.query).toBe("AMBER fern amber")
  expect(result.value.results.map((row: { source: string }) => row.source)).toEqual(["whole", "titleOnly"])
  expect(result.value.results[1].citation).toMatchObject({ startByte: 0, endByte: 0, quote: "" })
  for (const q of ["", "東京🧭", "a b c d e f g h i"]) {
    const invalid = await f.api(`/api/search?q=${encodeURIComponent(q)}`)
    expect(invalid.status).toBe(400)
    expect(invalid.value.error.code).toBe("invalid_query")
  }
  for (const limit of ["", "0", "51", "2.5", "1e1", "-1", "abc", "NaN", "1%0A"]) {
    const invalid = await f.api(`/api/search?q=amber&limit=${limit}`)
    expect(invalid.status).toBe(400)
    expect(invalid.value.error.code).toBe("invalid_limit")
  }
})

test("UTF-8 citations preserve original bytes, stay under 512 bytes, and resolve after deletion/restart", async () => {
  const f = fixture()
  const prefix = "Café 🧭 東京 e\u0301\n".repeat(60)
  const body = prefix + "AMBER! <script>unsafe()</script>\n" + "🧭é東京".repeat(100)
  const row = f.store.import(doc("unicode", body))
  const hit = f.store.search("amber")[0]
  const citation = hit.citation
  expect(citation.startByte).toBe(Buffer.byteLength(prefix))
  expect(citation.quote).toContain("AMBER!")
  expect(Buffer.byteLength(citation.quote)).toBeLessThanOrEqual(512)
  expect(Buffer.from(body).subarray(citation.startByte, citation.endByte).toString("utf8")).toBe(citation.quote)
  expect(hit.snippet).toBe(citation.quote)
  expect(f.store.citation(row.id, 1, citation.startByte, citation.endByte)).toEqual(citation)
  f.store.import(doc("unicode", "replacement"))
  f.store.batch(batch("delete", [{ type: "delete", source: "unicode" }]))
  f.restart()
  const params = new URLSearchParams(Object.entries(citation).filter(([key]) => key !== "quote").map(([key, value]) => [key, String(value)]))
  expect((await f.api(`/api/citations?${params}`)).value).toEqual(citation)
  expect((await f.api(`/api/documents/${row.id}`)).status).toBe(404)
  expect((await f.api(`/api/documents/${row.id}/versions/1`)).value.document.body).toBe(body)
  expect((await f.api(`/api/documents/${row.id}/versions`)).value.versions.map((v: { version: number }) => v.version)).toEqual([1, 2])
})

test("citation ranges reject missing, invalid, out-of-bounds and scalar-splitting offsets; empty boundary ranges work", async () => {
  const f = fixture()
  const row = f.store.import(doc("ranges", "Aé🧭東Z"))
  for (const boundary of [0, 1, 3, 7, 10, 11]) {
    expect(f.store.citation(row.id, 1, boundary, boundary).quote).toBe("")
  }
  for (const [start, end] of [[2, 3], [3, 4], [8, 10], [0, 12], [7, 3]]) {
    const response = await f.api(`/api/citations?documentId=1&version=1&startByte=${start}&endByte=${end}`)
    expect(response.status).toBe(400)
    expect(response.value.error.code).toBe("invalid_range")
  }
  for (const suffix of ["", "documentId=1&version=1&startByte=0", "documentId=0&version=1&startByte=0&endByte=0", "documentId=1&version=1&startByte=0.5&endByte=1", "documentId=1&version=1&startByte=-1&endByte=0"]) {
    expect((await f.api(`/api/citations?${suffix}`)).value.error.code).toBe("invalid_range")
  }
  expect((await f.api("/api/citations?documentId=1&version=9&startByte=0&endByte=0")).status).toBe(404)
  const titleOnly = f.store.import(doc("title-only", "🧭東京".repeat(200), "needle"))
  const hit = f.store.search("needle")[0]
  expect(hit.citation.startByte).toBe(0)
  expect(hit.citation.quote).toBe(titleOnly.body.slice(0, hit.citation.quote.length))
  expect(Buffer.byteLength(hit.citation.quote)).toBeLessThanOrEqual(512)
})

test("excerpts select a whole fitting query token even when an earlier matching token exceeds the byte cap", () => {
  const f = fixture()
  const long = "a".repeat(600)
  f.store.import(doc("long-token", long + "\nAMBER 🧭"))
  const hit = f.store.search(`${long} amber`)[0]
  expect(hit.citation.startByte).toBe(601)
  expect(hit.citation.quote).toBe("AMBER 🧭")
})

test("pagination visits every hit once and binds exact query, limit and revision across no-ops/replays/restarts", async () => {
  const f = fixture()
  f.store.importMany(Array.from({ length: 7 }, (_, i) => doc(`page${i}`)))
  let page = f.store.searchPage("AMBER", 2)
  const firstCursor = page.nextCursor!
  const ids = page.results.map((row) => row.id)
  f.store.batch(batch("noop", [upsert("page0")]))
  f.restart()
  f.store.batch(batch("noop", [upsert("page0")]))
  while (page.nextCursor) {
    page = f.store.searchPage("AMBER", 2, page.nextCursor)
    ids.push(...page.results.map((row) => row.id))
  }
  expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(page.nextCursor).toBeNull()
  for (const [q, limit, cursor] of [["amber", 2, firstCursor], ["AMBER", 10, firstCursor], ["AMBER", 2, "garbage"], ["AMBER", 2, firstCursor + "x"], ["AMBER", 2, ""]] as const) {
    const params = new URLSearchParams({ q, limit: String(limit), cursor })
    const response = await f.api(`/api/search?${params}`)
    expect(response.status).toBe(400)
    expect(response.value.error.code).toBe("invalid_cursor")
  }
  f.store.import(doc("unrelated", "cobalt"))
  const stale = await f.api(`/api/search?${new URLSearchParams({ q: "AMBER", limit: "2", cursor: firstCursor })}`)
  expect(stale.status).toBe(409)
  expect(stale.value.error.code).toBe("stale_cursor")
  expect(f.store.searchPage("AMBER", 2).revision).toBe(2)
})

test("HTTP rejects malformed UTF-8 and emits structured errors without exposing stored markup as HTML", async () => {
  const f = fixture()
  const response = await createHandler(f.store)(new Request("http://localhost/api/batches", {
    method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array([0xff]),
  }))
  expect(response.status).toBe(400)
  expect((await response.json()).error.code).toBe("invalid_batch")
  const body = '<script>window.pwned=1</script><img src="http://invalid.example/" onerror="alert(1)">\n[link](javascript:alert(1))'
  const imported = await f.api("/api/import", JSON.stringify(doc("<b>source</b>", body, "<h1>title</h1>")), "application/json")
  expect(imported.status).toBe(201)
  expect((await f.api("/api/documents/1")).value.document.body).toBe(body)
  expect((await f.api("/api/missing")).value.error.code).toBe("not_found")
  expect(f.store.revision()).toBe(1)
})
