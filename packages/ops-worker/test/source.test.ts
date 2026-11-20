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

/** The source with its comments taken out, so a comment that names a call is not counted as one. */
function code(text: string) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

/**
 * A call's arguments, from the text just after its opening parenthesis: split at its top-level commas and ended at its
 * own closing parenthesis, counting nested parentheses, brackets and braces and skipping quoted strings. Undefined when
 * the call never closes.
 */
function callArguments(after: string) {
  const args = [""]
  let depth = 0
  let quote = ""
  for (let index = 0; index < after.length; index++) {
    const char = after[index]!
    if (quote) {
      args[args.length - 1] += char === "\\" ? char + (after[++index] ?? "") : char
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (depth === 0 && char === ")") return args.map((arg) => arg.trim())
    if ("([{".includes(char)) depth++
    if (")]}".includes(char)) depth--
    if (depth === 0 && char === ",") args.push("")
    else args[args.length - 1] += char
  }
  return undefined
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
      expect({ file, found: code(text).match(/\b(?:Bun|process|Buffer|__dirname|console)\s*\./g) ?? [] }).toEqual({
        file,
        found: [],
      })
    }
  })

  test("protocol.ts, which the API imports, imports nothing", async () => {
    expect(await read("src/protocol.ts")).not.toMatch(/^\s*(?:import|export)\b[^"']*?from\s*["']/m)
  })

  test("every outbound fetch refuses to follow redirects", async () => {
    // Every call of `fetch(` or `fetcher(` (bare, or as a member such as `deps.fetch(`) must pass a second (options)
    // argument that says redirect: "manual". Not outbound, so left out: a method or interface definition (its first
    // parameter has a type), and `stub.fetch(`, the call to the account's Durable Object. runtime.ts's forwarder is
    // left out too, since it hands each caller's own options to the platform unchanged; it is pinned to exactly that
    // below.
    const outbound = (await sources()).flatMap(({ file, text }) =>
      [...code(text).matchAll(/(\bstub\.)?\b(?:fetcher|fetch)\s*\(/g)].flatMap((match) => {
        const after = code(text).slice(match.index + match[0].length)
        if (match[1] || /^\s*\w+\??\s*:/.test(after)) return []
        if (file === "runtime.ts" && after.startsWith("input, init)")) return []
        return [{ file, args: callArguments(after) }]
      }),
    )
    for (const { file, args } of outbound)
      expect({ file, args, manual: /redirect:\s*"manual"/.test(args?.[1] ?? "") }).toEqual({ file, args, manual: true })
    expect(outbound.map((entry) => entry.file).sort()).toEqual(["check.ts", "internal.ts", "ssrf.ts"])
    const runtime = code(await read("src/runtime.ts"))
    expect(runtime.match(/\bfetch\s*\(/g)).toHaveLength(2)
    expect(runtime).toContain("fetch: (input, init) => fetch(input, init),")
  })

  test("the entry module exports only the default handler and functions the runtime takes", () => {
    // workerd refuses a module whose exports are not handlers or classes: a string export (025d75da removed KILL_KEY)
    // failed only in the CI smoke before this test.
    expect(Object.keys(worker).sort()).toEqual(["OpsAccount", "default", "handleRequest"])
    expect(Object.keys(worker.default)).toEqual(["fetch"])
    for (const [name, value] of Object.entries(worker))
      if (name !== "default") expect({ name, type: typeof value }).toEqual({ name, type: "function" })
  })

  test("the kill flag is written in one place: one put and one delete, both inside flags()", async () => {
    const writes = (await sources()).flatMap(({ file, text }) =>
      [...code(text).matchAll(/OPS_FLAGS\.(put|delete)\s*\(/g)].map((match) => ({ file, write: match[1] })),
    )
    expect(writes).toEqual([
      { file: "ops-account.ts", write: "put" },
      { file: "ops-account.ts", write: "delete" },
    ])
    const account = code(await read("src/ops-account.ts"))
    const start = account.indexOf("  private async flags(")
    const body = account.slice(start, account.indexOf("\n  }\n", start))
    expect(start).toBeGreaterThan(0)
    expect(body.match(/OPS_FLAGS\.(?:put|delete)\s*\(/g)).toHaveLength(2)
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
    // Workers Logs and traces stay off until the owner turns them on here (owner-actions/hosted-ops.md).
    expect(value.observability).toEqual({ enabled: false })
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
