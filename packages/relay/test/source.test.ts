import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import * as worker from "../src/index"
import { CLOSE, CLOSE_REASON } from "../src/protocol"

// WP A39: the Worker runs on Cloudflare's runtime, so its source uses web platform APIs only, never logs, and its
// configuration names the Durable Object, its SQLite migration and the kill-flag namespace with no secret in it.

const root = path.join(import.meta.dir, "..")
const read = (relative: string) => Bun.file(path.join(root, relative)).text()

async function sources() {
  const files = (await readdir(path.join(root, "src"))).filter((file) => file.endsWith(".ts"))
  return Promise.all(files.map(async (file) => ({ file, text: await read(`src/${file}`) })))
}

describe("source", () => {
  test("only relative imports: no Bun, Node or package module reaches the Worker", async () => {
    for (const { file, text } of await sources()) {
      const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^"']*?from\s*["']([^"']+)["']/gm)].map(
        (match) => match[1],
      )
      expect({ file, outside: specifiers.filter((specifier) => !specifier!.startsWith("./")) }).toEqual({
        file,
        outside: [],
      })
      expect({ file, dynamic: /\bimport\s*\(|\brequire\s*\(/.test(text) }).toEqual({ file, dynamic: false })
    }
  })

  test("no Bun or Node globals, and no logging", async () => {
    for (const { file, text } of await sources()) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
      expect({ file, found: code.match(/\b(?:Bun|process|Buffer|__dirname|console)\s*\./g) ?? [] }).toEqual({
        file,
        found: [],
      })
    }
  })

  test("the Worker exports its fetch handler and the Durable Object class", () => {
    expect(typeof worker.default.fetch).toBe("function")
    expect(typeof worker.AccountRelay).toBe("function")
    const prototype = worker.AccountRelay.prototype as unknown as Record<string, unknown>
    for (const handler of ["fetch", "webSocketMessage", "webSocketClose", "webSocketError", "alarm"])
      expect({ handler, type: typeof prototype[handler] }).toEqual({ handler, type: "function" })
  })

  test("close reasons are the codes' names and fit a close frame", () => {
    for (const [name, code] of Object.entries(CLOSE)) {
      expect(CLOSE_REASON[code]).toBe(name)
      expect(new TextEncoder().encode(CLOSE_REASON[code]).byteLength).toBeLessThanOrEqual(123)
      expect(code === 1009 || (code >= 4000 && code <= 4999)).toBe(true)
    }
    expect(new Set(Object.values(CLOSE)).size).toBe(Object.keys(CLOSE).length)
  })
})

describe("wrangler.jsonc", () => {
  async function config() {
    const text = await read("wrangler.jsonc")
    // Whole-line comments and trailing commas, as JSONC allows.
    const json = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
    return { text, value: JSON.parse(json) as Record<string, any> }
  }

  test("one Worker, the AccountRelay object on SQLite storage, and the REMOTE_FLAGS namespace", async () => {
    const { value } = await config()
    expect(value.name).toBe("vector-remote-relay")
    expect(value.main).toBe("src/index.ts")
    expect(value.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${value.compatibility_date}T00:00:00Z`).getTime()).toBeLessThan(Date.UTC(2026, 9, 20))
    expect(value.durable_objects.bindings).toEqual([{ name: "ACCOUNT_RELAY", class_name: "AccountRelay" }])
    expect(value.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AccountRelay"] }])
    expect(value.kv_namespaces.map((entry: { binding: string }) => entry.binding)).toEqual(["REMOTE_FLAGS"])
  })

  test("holds no secret: the keys are set with wrangler secret put", async () => {
    const { value, text } = await config()
    expect(value.vars).toBeUndefined()
    for (const name of ["TICKET_PUBLIC_KEYS", "INTERNAL_SECRET", "ACCOUNT_KEY"]) {
      expect(text).toContain(name)
      expect(JSON.stringify(value)).not.toContain(name)
    }
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43,}/)
  })
})
