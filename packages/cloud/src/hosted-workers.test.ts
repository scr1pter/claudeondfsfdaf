import { describe, expect, test } from "bun:test"
import { configProblems, isWorkerTarget, missingSecrets, parseJsonc, WORKERS, type WorkerTarget } from "./hosted-workers"

// WP A58: the deploy workflow's checks before a Worker is deployed. The committed configuration must carry the owner's
// real kill-flag namespace and no secret in plain vars; the owner must already have set every secret the Worker needs
// with `wrangler secret put`, read as names only. Nothing here calls Cloudflare.

const root = new URL("../../..", import.meta.url).pathname
const read = (file: string) => Bun.file(`${root}/${file}`).text()
const TARGETS = Object.keys(WORKERS) as WorkerTarget[]
const REAL_ID = "0123456789abcdef0123456789abcdef"

describe("wrangler.jsonc", () => {
  test("is read as JSON with its comments removed, and never inside a string", () => {
    expect(
      parseJsonc(`// heading
      {
        /* block
           comment */ "name": "vector-ops", // trailing
        "vars": { "API_ORIGIN": "https://vectordev.ai", "Q": "a \\" // not a comment" }
      }`),
    ).toEqual({ name: "vector-ops", vars: { API_ORIGIN: "https://vectordev.ai", Q: 'a " // not a comment' } })
    expect(() => parseJsonc('{"name": "x')).toThrow()
    expect(() => parseJsonc('{"name": "x"} /* open')).toThrow()
  })

  test("as committed, each Worker waits only for the owner's kill-flag namespace id", async () => {
    for (const target of TARGETS) {
      const worker = WORKERS[target]
      const text = await read(`${worker.directory}/wrangler.jsonc`)
      const problems = configProblems(target, text)
      expect({ target, problems: problems.length }).toEqual({ target, problems: 1 })
      expect(problems[0]).toContain(`Replace the ${worker.namespaces[0]} placeholder id`)
      expect(problems[0]).toContain(worker.guide)
      // Once the owner commits the namespace they created, nothing stops the deploy.
      expect(configProblems(target, text.replace(/"0{32}"/, `"${REAL_ID}"`))).toEqual([])
    }
  })

  test("a wrong name, a missing or doubled namespace, an id that is not one, or a secret in vars is refused", async () => {
    const text = (await read("packages/ops-worker/wrangler.jsonc")).replace(/"0{32}"/, `"${REAL_ID}"`)
    const config = parseJsonc(text) as Record<string, unknown>
    const variant = (change: (value: Record<string, unknown>) => void) => {
      const copy = structuredClone(config)
      change(copy)
      return JSON.stringify(copy)
    }
    for (const [label, changed] of [
      ["name", variant((value) => (value.name = "vector-ops-copy"))],
      ["no namespace", variant((value) => (value.kv_namespaces = []))],
      [
        "two namespaces",
        variant((value) => (value.kv_namespaces = [{ binding: "OPS_FLAGS", id: REAL_ID }, { binding: "OPS_FLAGS", id: REAL_ID }])),
      ],
      ["short id", variant((value) => (value.kv_namespaces = [{ binding: "OPS_FLAGS", id: "abc" }]))],
      ["upper-case id", variant((value) => (value.kv_namespaces = [{ binding: "OPS_FLAGS", id: REAL_ID.toUpperCase() }]))],
      ["secret in vars", variant((value) => (value.vars = { API_ORIGIN: "https://vectordev.ai", INTERNAL_SECRET: "x" }))],
      ["unreadable", "{ not json"],
      ["not an object", "[]"],
    ] as const)
      expect({ label, refused: configProblems("ops", changed).length > 0 }).toEqual({ label, refused: true })
  })
})

describe("the owner's Worker secrets", () => {
  const list = (names: string[]) => JSON.stringify(names.map((name) => ({ name, type: "secret_text" })), null, 2)

  test("every secret the Worker needs must already be set; only the missing names are answered", () => {
    expect(missingSecrets("relay", list(["TICKET_PUBLIC_KEYS", "INTERNAL_SECRET", "ACCOUNT_KEY"]))).toEqual([])
    expect(missingSecrets("relay", list(["INTERNAL_SECRET", "ACCOUNT_KEY", "SOMETHING_ELSE"]))).toEqual(["TICKET_PUBLIC_KEYS"])
    expect(missingSecrets("relay", "[]")).toEqual(["TICKET_PUBLIC_KEYS", "INTERNAL_SECRET", "ACCOUNT_KEY"])
    expect(missingSecrets("ops", list(["INTERNAL_SECRET", "ACCOUNT_KEY"]))).toEqual([])
    expect(missingSecrets("ops", list(["ACCOUNT_KEY"]))).toEqual(["INTERNAL_SECRET"])
    // Lines around the JSON (a notice wrangler prints) do not hide it.
    expect(missingSecrets("ops", `notice\n${list(["INTERNAL_SECRET", "ACCOUNT_KEY"])}\n`)).toEqual([])
  })

  test("an answer that is not a list of names cannot be read, which fails the deploy", () => {
    for (const output of ["", "not json", "{}", '{"name":"INTERNAL_SECRET"}', "[1, 2]", '[{"type":"secret_text"}]', "[ broken"])
      expect({ output, read: missingSecrets("ops", output) }).toEqual({ output, read: undefined })
  })

  test("the names checked are the ones each wrangler.jsonc and its owner guide tell the owner to set", async () => {
    for (const target of TARGETS) {
      const worker = WORKERS[target]
      const config = await read(`${worker.directory}/wrangler.jsonc`)
      const guide = await read(worker.guide)
      const listed = [...config.matchAll(/^\/\/\s+([A-Z][A-Z_]{2,})\s{2,}/gm)].map((match) => match[1])
      const told = [...guide.matchAll(/wrangler secret put ([A-Z][A-Z_]+)/g)].map((match) => match[1])
      expect({ target, listed: [...listed].sort() }).toEqual({ target, listed: [...worker.secrets].sort() })
      expect({ target, told: [...new Set(told)].sort() }).toEqual({ target, told: [...worker.secrets].sort() })
    }
  })

  test("only the two Workers can be named", () => {
    expect(TARGETS).toEqual(["relay", "ops"])
    for (const value of ["relay", "ops"]) expect(isWorkerTarget(value)).toBe(true)
    for (const value of ["all", "", "hosted", undefined, "RELAY"]) expect(isWorkerTarget(value)).toBe(false)
    expect(WORKERS.relay.name).toBe("vector-remote-relay")
    expect(WORKERS.ops.name).toBe("vector-ops")
  })
})
