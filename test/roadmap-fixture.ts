import { ABUSE_RATE_LIMIT_SCRIPT } from "../api/_lib/abuse"

// WP A34's fakes: the store, as the Upstash REST commands the roadmap vote, the entitlement snapshot, token revocation
// and the rate limiter send them. Nothing here reaches a network: an unexpected address or command throws.

export const ROADMAP_KV_URL = "https://kv.roadmap.invalid"
export const ROADMAP_ENVIRONMENT = {
  KV_REST_API_URL: ROADMAP_KV_URL,
  KV_REST_API_TOKEN: "fixture-kv-token",
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  CODIUM_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: undefined,
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  VECTOR_CLI_TOKEN_SECRET: "roadmap-fixture-cli-secret-".padEnd(48, "x"),
  VECTOR_ABUSE_SECRET: "roadmap-fixture-abuse-secret-".padEnd(48, "x"),
} as const

/** Sets the environment (plus overrides) and returns the function that puts the previous one back. */
export function roadmapEnvironment(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = { ...ROADMAP_ENVIRONMENT, ...overrides }
  const original = new Map(Object.keys(values).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return () =>
    original.forEach((value, name) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
}

type Entry =
  | { kind: "string"; value: string }
  | { kind: "set"; value: Set<string> }
  | { kind: "hash"; value: Map<string, string> }

export class RoadmapStore {
  readonly data = new Map<string, Entry>()
  readonly expires = new Map<string, number>()
  readonly commands: string[][] = []
  /** Commands for which this returns true fail, as an unreachable store answers. */
  fail: (command: readonly string[]) => boolean = () => false

  private live(key: string) {
    const at = this.expires.get(key)
    if (at !== undefined && at <= Date.now()) {
      this.data.delete(key)
      this.expires.delete(key)
    }
    return this.data.get(key)
  }

  get(key: string) {
    const entry = this.live(key)
    return entry?.kind === "string" ? entry.value : undefined
  }

  hash(key: string) {
    const entry = this.live(key)
    return entry?.kind === "hash" ? entry.value : new Map<string, string>()
  }

  members(key: string) {
    const entry = this.live(key)
    return entry?.kind === "set" ? [...entry.value] : []
  }

  keys() {
    return [...this.data.keys()].filter((key) => this.live(key))
  }

  private ensureHash(key: string) {
    const entry = this.live(key)
    if (entry && entry.kind !== "hash") throw new Error("WRONGTYPE")
    if (entry) return entry.value
    const value = new Map<string, string>()
    this.data.set(key, { kind: "hash", value })
    return value
  }

  command(input: readonly unknown[]): unknown {
    const command = input.map(String)
    this.commands.push(command)
    if (this.fail(command)) throw new Error("store down")
    const [name, ...args] = command
    switch (name) {
      case "GET": {
        const entry = this.live(args[0]!)
        if (entry && entry.kind !== "string") throw new Error("WRONGTYPE")
        return entry?.value ?? null
      }
      case "MGET":
        return args.map((key) => this.get(key) ?? null)
      case "SET": {
        const [key, value, ...options] = args
        const exists = Boolean(this.live(key!))
        if ((options.includes("NX") && exists) || (options.includes("XX") && !exists)) return null
        this.data.set(key!, { kind: "string", value: value! })
        this.expires.delete(key!)
        const px = options.indexOf("PX")
        const ex = options.indexOf("EX")
        if (px >= 0) this.expires.set(key!, Date.now() + Number(options[px + 1]))
        if (ex >= 0) this.expires.set(key!, Date.now() + Number(options[ex + 1]) * 1000)
        return "OK"
      }
      case "DEL":
        return args.reduce((count, key) => {
          const existed = Boolean(this.live(key))
          this.data.delete(key)
          this.expires.delete(key)
          return count + (existed ? 1 : 0)
        }, 0)
      case "SADD": {
        const entry = this.live(args[0]!)
        if (entry && entry.kind !== "set") throw new Error("WRONGTYPE")
        const set = entry?.value ?? new Set<string>()
        if (!entry) this.data.set(args[0]!, { kind: "set", value: set })
        const before = set.size
        args.slice(1).forEach((member) => set.add(member))
        return set.size - before
      }
      case "SMEMBERS":
        return this.members(args[0]!)
      case "HGET":
        return this.hash(args[0]!).get(args[1]!) ?? null
      case "HSET": {
        const hash = this.ensureHash(args[0]!)
        let added = 0
        for (let index = 1; index < args.length; index += 2) {
          if (!hash.has(args[index]!)) added++
          hash.set(args[index]!, args[index + 1]!)
        }
        return added
      }
      case "HSETNX": {
        const hash = this.ensureHash(args[0]!)
        if (hash.has(args[1]!)) return 0
        hash.set(args[1]!, args[2]!)
        return 1
      }
      case "HVALS":
        return [...this.hash(args[0]!).values()]
      case "HLEN":
        return this.hash(args[0]!).size
      case "HDEL": {
        const entry = this.live(args[0]!)
        if (entry?.kind !== "hash") return 0
        const removed = args.slice(1).filter((field) => entry.value.delete(field)).length
        if (!entry.value.size) this.data.delete(args[0]!)
        return removed
      }
      case "EVAL": {
        // The rate limiter's counter, the only script these routes send.
        if (args[0] !== ABUSE_RATE_LIMIT_SCRIPT) throw new Error(`Unexpected script ${args[0]?.slice(0, 60)}`)
        const key = args[2]!
        const count = Number(this.get(key) ?? 0) + 1
        const ttl = this.expires.get(key)
        this.data.set(key, { kind: "string", value: String(count) })
        if (count === 1) this.expires.set(key, Date.now() + Number(args[3]) * 1000)
        else if (ttl !== undefined) this.expires.set(key, ttl)
        return [count, Math.ceil(((this.expires.get(key) ?? Date.now()) - Date.now()) / 1000)]
      }
    }
    throw new Error(`Unexpected store command ${name}`)
  }
}

/** The store and the `fetch` that reaches only it. */
export function roadmapFakes() {
  const store = new RoadmapStore()
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== ROADMAP_KV_URL) throw new Error(`Unexpected request to ${url.origin}`)
    try {
      return Response.json({ result: store.command(JSON.parse(String(init?.body)) as unknown[]) })
    } catch {
      return new Response("unavailable", { status: 503 })
    }
  }) as typeof fetch
  return { store, fetcher }
}
