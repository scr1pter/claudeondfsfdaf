import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStore } from "../server/storage"

test("v1 import, replacement, lexical lookup, and persistence remain available", () => {
  const directory = mkdtempSync(join(tmpdir(), "ew-public-"))
  const store = openStore(directory)
  const first = store.import({ source: "local/a.md", title: "Field record", body: "amber stone" })
  expect(store.search("AMBER").map((row) => row.id)).toEqual([first.id])
  const next = store.import({ source: "local/a.md", title: "Revised record", body: "cobalt stone" })
  expect(next.id).toBe(first.id)
  expect(store.search("amber")).toHaveLength(0)
  expect(store.get(first.id)?.body).toBe("cobalt stone")
  store.close()
  const reopened = openStore(directory)
  expect(reopened.get(first.id)?.title).toBe("Revised record")
  reopened.close()
  rmSync(directory, { recursive: true, force: true })
})

test("text remains exact through storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "ew-public-"))
  const store = openStore(directory)
  const body = "# Notes\nCafé 🧭 東京\n<script>untrusted()</script>"
  expect(store.import({ source: "local/text.md", title: "Text", body }).body).toBe(body)
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
