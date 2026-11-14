import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import * as worker from "../src/index"

// WP A46: the Worker runs on Cloudflare's runtime, so its source uses web platform APIs only and never logs; its
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

  test("protocol.ts, which the API imports, imports nothing", async () => {
    expect(await read("src/protocol.ts")).not.toMatch(/^\s*(?:import|export)\b[^"']*?from\s*["']/m)
  })

  test("every outbound fetch refuses to follow redirects", async () => {
    for (const { file, text } of await sources()) {
      const calls = text.match(/\b(?:fetcher|deps\.fetch)\(/g) ?? []
      const manual = text.match(/redirect:\s*"manual"/g) ?? []
      expect({ file, manual: manual.length >= calls.length }).toEqual({ file, manual: true })
    }
  })

  test("the Worker exports its fetch handler and the Durable Object class with its alarm", () => {
    expect(typeof worker.default.fetch).toBe("function")
    expect(typeof worker.OpsAccount).toBe("function")
    const prototype = worker.OpsAccount.prototype as unknown as Record<string, unknown>
    for (const handler of ["fetch", "alarm"])
      expect({ handler, type: typeof prototype[handler] }).toEqual({ handler, type: "function" })
  })
})

describe("wrangler.jsonc", () => {
  async function config() {
    const text = await read("wrangler.jsonc")
    // Whole-line comments and trailing commas, as JSONC allows.
    const json = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
    return { text, value: JSON.parse(json) as Record<string, any> }
  }

  test("one Worker, the OpsAccount object on SQLite storage, and the OPS_FLAGS namespace", async () => {
    const { value } = await config()
    expect(value.name).toBe("vector-ops")
    expect(value.main).toBe("src/index.ts")
    expect(value.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${value.compatibility_date}T00:00:00Z`).getTime()).toBeLessThan(Date.UTC(2026, 9, 20))
    expect(value.durable_objects.bindings).toEqual([{ name: "OPS_ACCOUNT", class_name: "OpsAccount" }])
    expect(value.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["OpsAccount"] }])
    expect(value.kv_namespaces.map((entry: { binding: string }) => entry.binding)).toEqual(["OPS_FLAGS"])
  })

  test("holds no secret: the only variable is the API's public origin, and the keys are set with wrangler secret put", async () => {
    const { value, text } = await config()
    expect(value.vars).toEqual({ API_ORIGIN: "https://vectordev.ai" })
    for (const name of ["INTERNAL_SECRET", "ACCOUNT_KEY"]) {
      expect(text).toContain(name)
      expect(JSON.stringify(value)).not.toContain(name)
    }
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43,}/)
  })
})
