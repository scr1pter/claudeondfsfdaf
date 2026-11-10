import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const verification = resolve(".verification")
mkdirSync(verification, { recursive: true })
const directory = mkdtempSync(join(verification, "http-"))
const port = process.env.PORT ?? "4123"
const base = `http://127.0.0.1:${port}`
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined

async function start() {
  child = Bun.spawn([process.execPath, "server/index.ts"], { cwd: resolve("."), env: { ...process.env, PORT: port, DATA_DIR: directory }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const reader = child.stdout.getReader()
  let output = ""
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Server failed to start: " + await new Response(child.stderr).text())
      output += new TextDecoder().decode(chunk.value)
    }
    expect(JSON.parse(output.trim()).ready).toBe(true)
  } finally { reader.releaseLock() }
}
async function stop() { if (child) { child.kill(); await child.exited; child = undefined } }
beforeAll(start)
afterAll(async () => { await stop(); rmSync(directory, { recursive: true, force: true }) })

async function request(path: string, status: number, options?: RequestInit) {
  const response = await fetch(base + path, options)
  const value = await response.json() as any
  expect(response.status).toBe(status)
  if (status >= 400) { expect(typeof value.error.code).toBe("string"); expect(typeof value.error.message).toBe("string"); expect(value.error.message).not.toMatch(/SQLITE|stack|INSERT INTO/i) }
  return value
}
function post(text: string, contentType = "application/x-ndjson"): RequestInit { return { method: "POST", headers: { "content-type": contentType }, body: text } }
const batch = (id: string, ...ops: unknown[]) => [JSON.stringify({ type: "batch", batchId: id }), ...ops.map((op) => JSON.stringify(op))].join("\n")
const upsert = (source: string, body = "Café 🧭 amber fern.\ne\u0301 東京", title = "Field note") => ({ type: "upsert", source, title, body })

test("HTTP public contract: atomic import, revisions, durable history/receipts/cursors and structured errors", async () => {
  expect(await request("/api/health", 200)).toEqual({ ok: true, schemaVersion: 2, revision: 0 })
  const seed = batch("http_seed", upsert("a"), upsert("b"), upsert("c"))
  const receipt = await request("/api/batches", 201, post(seed))
  expect(receipt).toMatchObject({ batchId: "http_seed", revision: 1, replayed: false })
  expect(receipt.operations.map((op: any) => op.documentId)).toEqual([1, 2, 3])
  const page = await request("/api/search?q=AMBER&limit=2", 200)
  expect(page.query).toBe("AMBER")
  expect(page.results.map((hit: any) => hit.id)).toEqual([1, 2])
  const cursorPath = `/api/search?q=AMBER&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`
  const bound = page.results[0].citation
  const citationPath = `/api/citations?documentId=1&version=1&startByte=${bound.startByte}&endByte=${bound.endByte}`
  expect(await request(citationPath, 200)).toEqual(bound)
  expect((await request("/api/documents", 200)).revision).toBe(1)
  expect((await request("/api/documents/1", 200)).document.version).toBe(1)
  const noop = await request("/api/batches", 201, post(batch("http_noop", upsert("a"))))
  expect(noop.operations[0].changed).toBe(false)
  expect((await request(cursorPath, 200)).results.map((hit: any) => hit.id)).toEqual([3])
  await stop()
  await start()
  expect((await request(cursorPath, 200)).results.map((hit: any) => hit.id)).toEqual([3])
  expect(await request("/api/batches", 200, post(seed))).toEqual({ ...receipt, replayed: true })

  expect((await request("/api/batches", 409, post(batch("http_seed", upsert("changed"))))).error.code).toBe("batch_conflict")
  expect((await request("/api/batches", 400, post(batch("invalid", upsert("new"), { type: "upsert", source: "bad", title: "", body: "x" })))).error.code).toBe("invalid_batch")
  expect((await request("/api/batches", 400, post(seed, "application/json"))).error.code).toBe("invalid_batch")
  expect((await request("/api/import", 400, post(JSON.stringify(upsert("new")) + '\n{"source":"bad","title":"","body":"x"}'))).error.code).toBe("invalid_document")
  expect((await request("/api/import", 400, post('{', "application/json"))).error.code).toBe("invalid_document")
  expect((await request("/api/documents", 200)).documents).toHaveLength(3)

  for (const limit of ["0", "51", "1.5", "1e1", "-1", "", "1%0A", "nope"]) expect((await request(`/api/search?q=amber&limit=${limit}`, 400)).error.code).toBe("invalid_limit")
  for (const query of ["", "東京", "a b c d e f g h i"]) expect((await request(`/api/search?q=${encodeURIComponent(query)}`, 400)).error.code).toBe("invalid_query")
  expect((await request("/api/search?q=amber&cursor=bad", 400)).error.code).toBe("invalid_cursor")
  expect((await request(cursorPath.replace("AMBER", "amber"), 400)).error.code).toBe("invalid_cursor")
  expect((await request(cursorPath.replace("limit=2", "limit=10"), 400)).error.code).toBe("invalid_cursor")
  expect((await request("/api/citations?documentId=1&version=1&startByte=4&endByte=5", 400)).error.code).toBe("invalid_range")
  for (const parameters of ["", "documentId=1&version=1&startByte=0", "documentId=0&version=1&startByte=0&endByte=0", "documentId=1&version=1&startByte=0.5&endByte=2"]) expect((await request(`/api/citations?${parameters}`, 400)).error.code).toBe("invalid_range")
  expect((await request("/api/citations?documentId=99&version=1&startByte=0&endByte=0", 404)).error.code).toBe("not_found")

  const changed = await request("/api/import", 201, post(JSON.stringify(upsert("a", "cobalt")), "application/json"))
  expect(changed.documents[0]).toMatchObject({ id: 1, source: "a", body: "cobalt", version: 2 })
  expect((await request(cursorPath, 409)).error.code).toBe("stale_cursor")
  expect((await request("/api/documents/1/versions", 200)).versions.map((row: any) => row.version)).toEqual([1, 2])
  expect((await request("/api/documents/1/versions/1", 200)).document.body).toBe(upsert("a").body)
  const deleted = await request("/api/batches", 201, post(batch("http_delete", { type: "delete", source: "a" })))
  expect(deleted.revision).toBe(3)
  expect((await request("/api/documents/1", 404)).error.code).toBe("not_found")
  expect((await request("/api/documents/1/versions/99", 404)).error.code).toBe("not_found")
  expect((await request("/api/documents/0", 404)).error.code).toBe("not_found")
  expect(await request(citationPath, 200)).toEqual(bound)
  await stop()
  await start()
  expect((await request("/api/health", 200)).revision).toBe(3)
  expect(await request("/api/batches", 200, post(seed))).toEqual({ ...receipt, replayed: true })
  const revived = await request("/api/import", 201, post(JSON.stringify(upsert("a", "revived")), "application/json"))
  expect(revived.documents[0]).toMatchObject({ id: 1, version: 3 })
  expect((await request("/api/health", 200)).revision).toBe(4)
  expect((await request("/api/no-such-route", 404)).error.code).toBe("not_found")
}, 20000)
