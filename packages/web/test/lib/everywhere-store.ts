import { RedisClient } from "bun"
import { AUDIT_APPEND_SCRIPT } from "../../../../api/_lib/everywhere/audit"
import { LINK_TRIES_SCRIPT } from "../../../../api/_lib/everywhere/identity"
import { COUNT_JOB_SCRIPT } from "../../../../api/_lib/everywhere/limits"
import { SWAP_SCRIPT } from "../../../../api/_lib/everywhere/store"

/*
 * Store fakes for Vector everywhere tests (contract section 9).
 *
 * `FakeStore` is enough of Redis for the server foundation: strings with NX, XX and PX, counters, expiry on a fake
 * clock, sets and sorted sets, and the everywhere Lua scripts, each recognised by its exact text and run as TypeScript. A
 * script it does not know is an error, so a new one cannot slip through untested. Its `fetch` speaks the Redis REST
 * API that `persistentStore` calls, at a `.invalid` address that no real request can reach.
 *
 * `realRedis()` forwards the same REST calls to a disposable loopback Redis when VECTOR_TEST_REDIS_URL is set (CI),
 * so the atomic scripts also run against the real thing. It touches only the keys the test used and deletes them.
 */

export const FAKE_KV_URL = "https://kv.everywhere-fakes.invalid"
export const FAKE_KV_TOKEN = "everywhere-fake-kv"

export class FakeClock {
  constructor(public now = Date.UTC(2026, 10, 11, 14, 30)) {}
  advance(ms: number) {
    this.now += ms
    return this.now
  }
}

type Value =
  | { kind: "string"; value: string }
  | { kind: "set"; value: Set<string> }
  | { kind: "zset"; value: Map<string, number> }
type Script = (keys: string[], argv: string[]) => unknown

class ScriptError extends Error {}

export class FakeStore {
  readonly data = new Map<string, Value>()
  readonly expires = new Map<string, number>()
  readonly commands: string[][] = []
  /** When true, every call answers 503, as a store outage would. */
  down = false
  private readonly scripts = new Map<string, Script>([
    [AUDIT_APPEND_SCRIPT, (keys, argv) => this.auditAppend(keys, argv)],
    [COUNT_JOB_SCRIPT, (keys, argv) => this.countJob(keys, argv)],
    [SWAP_SCRIPT, (keys, argv) => this.swap(keys, argv)],
    [LINK_TRIES_SCRIPT, (keys, argv) => this.tries(keys, argv)],
  ])

  constructor(readonly clock = new FakeClock()) {}

  /** The Redis REST API, as `persistentStore` calls it. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(FAKE_KV_URL)) throw new Error("The fake store only answers its own address.")
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${FAKE_KV_TOKEN}`)
      return Response.json({ error: "unauthorized" }, { status: 401 })
    if (this.down) return new Response(null, { status: 503 })
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    try {
      return Response.json({ result: this.send(command) })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 400 })
    }
  }) as typeof fetch

  /** Runs one command, as Redis would. */
  send(command: readonly (string | number)[]): unknown {
    const [name = "", ...rest] = command.map(String)
    this.commands.push([name, ...rest])
    return this.run(name.toUpperCase(), rest)
  }

  private run(name: string, args: string[]): unknown {
    switch (name) {
      case "GET": {
        const value = this.read(args[0]!)
        if (value && value.kind !== "string") throw new ScriptError("WRONGTYPE")
        return value?.value ?? null
      }
      case "GETDEL": {
        const value = this.read(args[0]!)
        if (value && value.kind !== "string") throw new ScriptError("WRONGTYPE")
        if (value) this.remove(args[0]!)
        return value?.value ?? null
      }
      case "SET":
        return this.set(args)
      case "SADD": {
        const set = this.setOf(args[0]!, true)!
        let added = 0
        for (const member of args.slice(1)) {
          if (!set.has(member)) added++
          set.add(member)
        }
        return added
      }
      case "SREM": {
        const set = this.setOf(args[0]!)
        if (!set) return 0
        let removed = 0
        for (const member of args.slice(1)) if (set.delete(member)) removed++
        if (!set.size) this.remove(args[0]!)
        return removed
      }
      case "SMEMBERS":
        return [...(this.setOf(args[0]!) ?? [])]
      case "SISMEMBER":
        return this.setOf(args[0]!)?.has(args[1]!) ? 1 : 0
      case "DEL":
        return args.filter((key) => this.remove(key)).length
      case "EXISTS":
        return args.filter((key) => this.read(key)).length
      case "MGET":
        return args.map((key) => {
          const value = this.read(key)
          return value?.kind === "string" ? value.value : null
        })
      case "INCR":
        return this.incr(args[0]!)
      case "PEXPIRE": {
        if (!this.read(args[0]!)) return 0
        this.expires.set(args[0]!, this.clock.now + Number(args[1]))
        return 1
      }
      case "PTTL":
        return this.pttl(args[0]!)
      case "ZADD": {
        const set = this.zset(args[0]!, true)!
        let added = 0
        for (let index = 1; index < args.length; index += 2) {
          if (!set.has(args[index + 1]!)) added++
          set.set(args[index + 1]!, Number(args[index]))
        }
        return added
      }
      case "ZCARD":
        return this.zset(args[0]!)?.size ?? 0
      case "ZREVRANGE": {
        const sorted = this.sorted(args[0]!).reverse()
        return slice(sorted, Number(args[1]), Number(args[2]))
      }
      case "ZRANGE":
        return slice(this.sorted(args[0]!), Number(args[1]), Number(args[2]))
      case "ZREMRANGEBYSCORE":
        return this.zremByScore(args[0]!, args[1]!, args[2]!)
      case "ZREMRANGEBYRANK":
        return this.zremByRank(args[0]!, Number(args[1]), Number(args[2]))
      case "EVAL": {
        const script = this.scripts.get(args[0]!)
        if (!script) throw new ScriptError("The fake store does not know this script.")
        const count = Number(args[1])
        return script(args.slice(2, 2 + count), args.slice(2 + count))
      }
      default:
        throw new ScriptError(`The fake store does not know ${name}.`)
    }
  }

  private live(key: string) {
    const at = this.expires.get(key)
    if (at !== undefined && at <= this.clock.now) {
      this.data.delete(key)
      this.expires.delete(key)
    }
  }

  read(key: string) {
    this.live(key)
    return this.data.get(key)
  }

  private remove(key: string) {
    this.live(key)
    this.expires.delete(key)
    return this.data.delete(key)
  }

  private set(args: string[]) {
    const [key, value, ...options] = args as [string, string, ...string[]]
    let ttl: number | undefined
    let nx = false
    let xx = false
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!.toUpperCase()
      if (option === "PX") ttl = Number(options[++index])
      else if (option === "NX") nx = true
      else if (option === "XX") xx = true
      else throw new ScriptError(`SET option ${option}`)
    }
    const exists = this.read(key) !== undefined
    if ((nx && exists) || (xx && !exists)) return null
    this.data.set(key, { kind: "string", value })
    if (ttl === undefined) this.expires.delete(key)
    else this.expires.set(key, this.clock.now + ttl)
    return "OK"
  }

  private incr(key: string) {
    const value = this.read(key)
    if (value && value.kind !== "string") throw new ScriptError("WRONGTYPE")
    const current = value ? Number(value.value) : 0
    if (!Number.isSafeInteger(current)) throw new ScriptError("not an integer")
    this.data.set(key, { kind: "string", value: String(current + 1) })
    return current + 1
  }

  pttl(key: string) {
    if (!this.read(key)) return -2
    const at = this.expires.get(key)
    return at === undefined ? -1 : at - this.clock.now
  }

  /** A set's members. */
  private setOf(key: string, create = false) {
    const value = this.read(key)
    if (value && value.kind !== "set") throw new ScriptError("WRONGTYPE")
    if (value) return value.value
    if (!create) return undefined
    const fresh = new Set<string>()
    this.data.set(key, { kind: "set", value: fresh })
    return fresh
  }

  private zset(key: string, create = false) {
    const value = this.read(key)
    if (value && value.kind !== "zset") throw new ScriptError("WRONGTYPE")
    if (value) return value.value
    if (!create) return undefined
    const fresh = new Map<string, number>()
    this.data.set(key, { kind: "zset", value: fresh })
    return fresh
  }

  /** Members by score, then by member, as Redis orders them. */
  sorted(key: string) {
    return [...(this.zset(key)?.entries() ?? [])]
      .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0))
      .map(([member]) => member)
  }

  private zremByScore(key: string, min: string, max: string) {
    const set = this.zset(key)
    if (!set) return 0
    const bound = (text: string) => {
      if (text === "-inf") return { value: -Infinity, open: false }
      if (text === "+inf") return { value: Infinity, open: false }
      return text.startsWith("(") ? { value: Number(text.slice(1)), open: true } : { value: Number(text), open: false }
    }
    const low = bound(min)
    const high = bound(max)
    let removed = 0
    for (const [member, score] of [...set]) {
      const aboveLow = low.open ? score > low.value : score >= low.value
      const belowHigh = high.open ? score < high.value : score <= high.value
      if (aboveLow && belowHigh) {
        set.delete(member)
        removed++
      }
    }
    if (!set.size) this.remove(key)
    return removed
  }

  private zremByRank(key: string, start: number, stop: number) {
    const set = this.zset(key)
    if (!set) return 0
    const doomed = slice(this.sorted(key), start, stop)
    for (const member of doomed) set.delete(member)
    if (!set.size) this.remove(key)
    return doomed.length
  }

  private auditAppend(keys: string[], argv: string[]) {
    const [key] = keys as [string]
    const [score, member, cutoff, max, keep] = argv as [string, string, string, string, string]
    this.run("ZADD", [key, score, member])
    this.run("ZREMRANGEBYSCORE", [key, "-inf", `(${cutoff}`])
    const extra = (this.zset(key)?.size ?? 0) - Number(max)
    if (extra > 0) this.run("ZREMRANGEBYRANK", [key, "0", String(extra - 1)])
    this.run("PEXPIRE", [key, keep])
    return this.zset(key)?.size ?? 0
  }

  private swap(keys: string[], argv: string[]) {
    const [key] = keys as [string]
    const [expected, next] = argv as [string, string]
    const current = this.run("GET", [key]) as string | null
    if (!((current === null && expected === "") || current === expected)) return 0
    if (next === "") this.run("DEL", [key])
    else this.run("SET", [key, next])
    return 1
  }

  private tries(keys: string[], argv: string[]) {
    const count = this.incr(keys[0]!)
    if (count === 1) this.run("PEXPIRE", [keys[0]!, argv[0]!])
    return count
  }

  private countJob(keys: string[], argv: string[]) {
    const counts: number[] = []
    let full = false
    for (let index = 0; index < 3; index++) {
      const raw = this.run("GET", [keys[index]!]) as string | null
      const value = Number(raw ?? "0")
      if (!Number.isSafeInteger(value)) throw new ScriptError("not a number")
      counts.push(value)
      if (value >= Number(argv[index])) full = true
    }
    const live = this.zset(keys[3]!)?.size ?? 0
    if (live >= Number(argv[3])) full = true
    if (!full)
      for (let index = 0; index < 3; index++) {
        counts[index] = this.incr(keys[index]!)
        if (this.pttl(keys[index]!) < 0) this.run("PEXPIRE", [keys[index]!, argv[4 + index]!])
      }
    return [full ? 0 : 1, counts[0], counts[1], counts[2], live]
  }
}

function slice<T>(items: T[], start: number, stop: number) {
  const length = items.length
  const from = start < 0 ? Math.max(0, length + start) : start
  const to = stop < 0 ? length + stop : Math.min(stop, length - 1)
  return from > to ? [] : items.slice(from, to + 1)
}

/** Points `persistentStore` at a fake (or bridged) store for the duration of a test file. Answers a restore. */
export function useKv(): () => void {
  const previous = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  }
  process.env.KV_REST_API_URL = FAKE_KV_URL
  process.env.KV_REST_API_TOKEN = FAKE_KV_TOKEN
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

export type RealRedis = { readonly fetch: typeof fetch; close(): Promise<void> }

/** A REST bridge to the loopback Redis in VECTOR_TEST_REDIS_URL, or undefined when it is not set (local runs). */
export async function realRedis(): Promise<RealRedis | undefined> {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) return undefined
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Store tests need a loopback Redis.")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false, autoReconnect: false })
  await redis.connect()
  const touched = new Set<string>()
  const bridge = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = (JSON.parse(String(init?.body)) as (string | number)[]).map(String)
    const [name = "", ...args] = command
    if (name.toUpperCase() === "EVAL") args.slice(2, 2 + Number(args[1])).forEach((key) => touched.add(key))
    else if (["DEL", "EXISTS", "MGET"].includes(name.toUpperCase())) args.forEach((key) => touched.add(key))
    else if (args[0]) touched.add(args[0])
    try {
      return Response.json({ result: await redis.send(name, args) })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 400 })
    }
  }) as typeof fetch
  return {
    fetch: bridge,
    async close() {
      if (touched.size) await redis.send("DEL", [...touched])
      redis.close()
    },
  }
}
