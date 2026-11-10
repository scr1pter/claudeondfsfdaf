import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"
import { FUNDING_SCRIPTS } from "../../../../api/_lib/codium-funding"
import { RAMP_SCRIPTS } from "../../../../api/_lib/codium-ramp"
import { POOL_SCRIPTS } from "../../../../api/_lib/codium-pool"
import { ACCOUNT_RECONCILE_SCRIPT, OUTBOX_SCRIPTS } from "../../../../api/_lib/codium-provision"
import { OWNER_AUDIT_SCRIPT } from "../../../../api/_lib/codium-owner"
import { ABUSE_RATE_LIMIT_SCRIPT } from "../../../../api/_lib/abuse"
import { SWITCH_SCRIPTS } from "../../../../api/_lib/codium-switches"
import { SNAPSHOT_SCRIPTS } from "../../../../api/_lib/codium-snapshot"
import { modelSpendKeys } from "../../../../api/_lib/codium-spend-ledger"
import { readyGenesisFields, spendScripts } from "./codium-spend-emulation"

/*
 * In-memory fakes for Codium's billing tests: Stripe (at the pinned API version), OpenRouter's key management API, the
 * Valkey store and the owner's email service, behind one injected `fetch`. Each records every call it receives, with its idempotency key, and
 * OpenRouter's keys keep their limits, so a test can say exactly what was asked of each service. Nothing here reaches
 * a real service: the fetcher throws on any other origin. Fixtures of Stripe objects live in `../fixtures/stripe/`.
 */

export const STRIPE_API_VERSION = "2025-02-24.acacia"
export const FAKE_KV_URL = "https://kv.codium-fakes.invalid"
export const FIXTURE_PRICES = [10, 50, 100, 200] as const
/**
 * The credits the fixtures assume, in dollars. They are made up for the tests and only keep the public usage multiples
 * (5.5x, 12x and 25x Plus) that Codium's configuration requires; the real pools stay private and never appear here.
 */
export const FIXTURE_CREDITS = { 10: "4", 50: "22", 100: "48", 200: "100" } as const

type Json = Record<string, unknown>

export type RecordedCall = {
  service: "stripe" | "openrouter"
  method: string
  /** Stripe: the path after `/v1/`. OpenRouter: the path after `/api/v1/`. */
  path: string
  query: URLSearchParams
  /** Stripe's form body, parsed. */
  form?: URLSearchParams
  /** OpenRouter's JSON body, parsed. */
  json?: Json
  idempotencyKey?: string
  stripeVersion?: string
}

/** A clock the store's expiries follow; tests move it instead of waiting. */
export class FakeClock {
  constructor(public now = Date.now()) {}
  advance(ms: number) {
    this.now += ms
    return this.now
  }
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────

type Value =
  | { kind: "string"; value: string }
  | { kind: "hash"; value: Map<string, string> }
  | { kind: "set"; value: Set<string> }
  | { kind: "zset"; value: Map<string, number> }
type Script = (keys: string[], argv: string[]) => unknown

// The billing lease's scripts (billing-lock.ts); the outbox's drain lock sends the same two, word for word.
const LEASE_CHECK = "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('PTTL', KEYS[1])"
const LEASE_RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0"
if (OUTBOX_SCRIPTS.LOCK_CHECK !== LEASE_CHECK || OUTBOX_SCRIPTS.LOCK_RELEASE !== LEASE_RELEASE)
  throw new Error("The outbox lock's scripts no longer match the billing lease's.")

/**
 * Enough of Valkey for Codium: strings with NX/PX, hashes, sorted sets, expiry on the fake clock, and the scripts
 * Codium sends, each recognised by its exact text and run as TypeScript (the account lease, the pool's, the
 * snapshot's and the outbox's). A script it does not know throws, so a new one cannot slip through untested.
 * `commands` records every command in order.
 */
export class FakeStore {
  readonly data = new Map<string, Value>()
  readonly expires = new Map<string, number>()
  readonly commands: string[][] = []
  readonly scripts = new Map<string, Script>()
  /** Set to make every command fail, as an unreachable store does. */
  down = false

  constructor(private readonly clock: FakeClock) {
    this.registerBuiltInScripts()
  }

  /** The value of a string key, or undefined. */
  get(key: string) {
    const value = this.live(key)
    return value?.kind === "string" ? value.value : undefined
  }

  set(key: string, value: string) {
    this.data.set(key, { kind: "string", value })
    this.expires.delete(key)
  }

  /**
   * The ledger of a pool whose key was created fresh (A17 GENESIS), for a test that seeds a key record directly
   * instead of provisioning one. Returns the `spendGenesis` marker that key record carries.
   */
  seedSpendGenesis(input: { account: string; pool: string; subscription: string; start: number; end: number }) {
    const nonce = `seed-${input.pool}`
    const ledger = this.hash(modelSpendKeys(input.pool).ledger)
    for (const [field, value] of readyGenesisFields({ ...input, nonce })) ledger.set(field, value)
    return { nonce, state: "ready" as const }
  }

  /** Every live key, for assertions. */
  keys() {
    return [...this.data.keys()].filter((key) => this.live(key))
  }

  command(input: readonly unknown[]): unknown {
    const command = input.map(String)
    this.commands.push(command)
    if (this.down) throw new Error("store down")
    const [name, ...args] = command
    switch (name) {
      case "GET":
        return this.get(args[0]!) ?? null
      case "MGET":
        return args.map((key) => this.get(key) ?? null)
      case "SET": {
        const [key, value, ...options] = args
        if (options.includes("NX") && this.live(key!)) return null
        this.set(key!, value!)
        const px = options.indexOf("PX")
        if (px >= 0) this.expires.set(key!, this.clock.now + Number(options[px + 1]))
        return "OK"
      }
      case "DEL":
        return args.reduce((count, key) => count + (this.remove(key) ? 1 : 0), 0)
      case "PTTL":
        return this.pttl(args[0]!)
      case "SCAN": {
        const pattern = args[args.indexOf("MATCH") + 1] ?? "*"
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern
        return ["0", this.keys().filter((key) => key.startsWith(prefix))]
      }
      case "SMEMBERS":
        return [...this.members(args[0]!)]
      case "SADD": {
        const members = this.members(args[0]!)
        const before = members.size
        args.slice(1).forEach((value) => members.add(value))
        return members.size - before
      }
      case "SREM": {
        const members = this.members(args[0]!)
        const removed = args.slice(1).reduce((sum, value) => sum + (members.delete(value) ? 1 : 0), 0)
        this.prune(args[0]!)
        return removed
      }
      case "ZSCAN":
        return ["0", [...this.zset(args[0]!)].flatMap(([member, score]) => [member, String(score)])]
      case "HSET":
        this.hash(args[0]!).set(args[1]!, args[2]!)
        return 1
      case "HGET":
        return this.hash(args[0]!).get(args[1]!) ?? null
      case "HSCAN":
        return ["0", [...this.hash(args[0]!)].flat()]
      case "ZADD": {
        const [key, ...rest] = args
        const flags = new Set<string>()
        while (rest.length && ["NX", "XX"].includes(rest[0]!)) flags.add(rest.shift()!)
        const set = this.zset(key!)
        const exists = set.has(rest[1]!)
        if ((flags.has("NX") && exists) || (flags.has("XX") && !exists)) {
          this.prune(key!)
          return 0
        }
        set.set(rest[1]!, Number(rest[0]))
        return exists ? 0 : 1
      }
      case "ZREM": {
        const removed = this.zset(args[0]!).delete(args[1]!) ? 1 : 0
        this.prune(args[0]!)
        return removed
      }
      case "ZSCORE": {
        const score = this.zset(args[0]!).get(args[1]!)
        this.prune(args[0]!)
        return score === undefined ? null : String(score)
      }
      case "ZCARD":
        return this.zset(args[0]!).size
      case "ZREVRANGE":
        return this.ordered(this.zset(args[0]!))
          .reverse()
          .slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1)
          .map(([member]) => member)
      case "ZRANGE": {
        const members = this.ordered(this.zset(args[0]!)).map(([member]) => member)
        this.prune(args[0]!)
        return members
      }
      case "ZRANGEBYSCORE": {
        const limit = args.indexOf("LIMIT")
        const found = this.between(this.zset(args[0]!), args[1]!, args[2]!)
        this.prune(args[0]!)
        const page =
          limit >= 0 ? found.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2])) : found
        // WITHSCORES answers member, score, member, score…, scores as strings, as the REST API does.
        return args.includes("WITHSCORES")
          ? page.flatMap(([member, score]) => [member, String(score)])
          : page.map(([member]) => member)
      }
      case "EVAL": {
        const [script, count, ...rest] = args
        const run = this.scripts.get(script!)
        if (!run) throw new Error(`Unexpected store script ${script!.slice(0, 80)}`)
        return run(rest.slice(0, Number(count)), rest.slice(Number(count)))
      }
    }
    throw new Error(`Unexpected store command ${name}`)
  }

  // Internals, shared with the scripts.

  live(key: string) {
    const at = this.expires.get(key)
    if (at !== undefined && at <= this.clock.now) this.remove(key)
    return this.data.get(key)
  }
  remove(key: string) {
    const existed = this.data.delete(key)
    this.expires.delete(key)
    return existed
  }
  hash(key: string) {
    const value = this.live(key)
    if (value?.kind === "hash") return value.value
    const created = new Map<string, string>()
    this.data.set(key, { kind: "hash", value: created })
    return created
  }
  members(key: string) {
    const value = this.live(key)
    if (value?.kind === "set") return value.value
    const created = new Set<string>()
    this.data.set(key, { kind: "set", value: created })
    return created
  }
  zset(key: string) {
    const value = this.live(key)
    if (value?.kind === "zset") return value.value
    const created = new Map<string, number>()
    this.data.set(key, { kind: "zset", value: created })
    return created
  }
  /** Valkey deletes a set or hash, and its lifetime, when its last member goes. */
  prune(key: string) {
    const value = this.data.get(key)
    if (value && value.kind !== "string" && value.value.size === 0) this.remove(key)
  }
  pttl(key: string) {
    if (!this.live(key)) return -2
    const at = this.expires.get(key)
    return at === undefined ? -1 : at - this.clock.now
  }
  private growTtl(key: string, ms: string) {
    if (this.pttl(key) < Number(ms)) this.expires.set(key, this.clock.now + Number(ms))
  }
  private ordered(set: Map<string, number>) {
    return [...set].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
  }
  private between(set: Map<string, number>, min: string, max: string) {
    const bound = (value: string) =>
      value === "-inf"
        ? { at: -Infinity, open: false }
        : value === "+inf"
          ? { at: Infinity, open: false }
          : value.startsWith("(")
            ? { at: Number(value.slice(1)), open: true }
            : { at: Number(value), open: false }
    const low = bound(min)
    const high = bound(max)
    return this.ordered(set).filter(
      ([, score]) => (low.open ? score > low.at : score >= low.at) && (high.open ? score < high.at : score <= high.at),
    )
  }

  private registerBuiltInScripts() {
    const reservations = (key: string, argv: string[]) => {
      const values = this.hash(key)
      let reserved = 0
      for (const [id, saved] of values) {
        const match = /^(\d+):(\d+)$/.exec(saved)
        if (!match || Number(match[1]) <= Number(argv[0]) || id === argv[2]) values.delete(id)
        else if (id !== argv[1]) reserved += Number(match[2])
      }
      this.prune(key)
      return reserved
    }
    const scripts: [string, Script][] = [
      [
        FUNDING_SCRIPTS.RELEASE,
        ([key], [token]) => {
          if (this.get(key!) !== token) return 0
          this.remove(key!)
          return 1
        },
      ],
      [FUNDING_SCRIPTS.RESERVED, ([key], argv) => reservations(key!, argv)],
      [
        FUNDING_SCRIPTS.RESERVE,
        ([key], argv) => {
          const reserved = reservations(key!, argv)
          const required =
            Math.ceil(((Number(argv[6]) + reserved + Number(argv[3])) * (100 + Number(argv[7]))) / 100) +
            Number(argv[8])
          if (Number(argv[5]) < required) return 0
          this.hash(key!).set(argv[1]!, `${argv[4]}:${argv[3]}`)
          return 1
        },
      ],
      [
        ABUSE_RATE_LIMIT_SCRIPT,
        ([key], [seconds]) => {
          const count = Number(this.get(key!) ?? 0) + 1
          const expiry = this.expires.get(key!)
          this.set(key!, String(count))
          this.expires.set(key!, count === 1 ? this.clock.now + Number(seconds) * 1000 : expiry!)
          return [count, Math.ceil(this.pttl(key!) / 1000)]
        },
      ],
      [
        OWNER_AUDIT_SCRIPT,
        ([key], [at, raw, before, ttl]) => {
          const entries = this.zset(key!)
          entries.set(raw!, Number(at))
          for (const [member, score] of entries) if (score <= Number(before)) entries.delete(member)
          this.expires.set(key!, this.clock.now + Number(ttl))
          return 1
        },
      ],
      [
        ACCOUNT_RECONCILE_SCRIPT,
        (keys, argv) => {
          this.set(keys[3]!, argv[4]!)
          return this.scripts.get(OUTBOX_SCRIPTS.ENQUEUE)!(keys.slice(0, 3), argv.slice(0, 4))
        },
      ],
      [
        SWITCH_SCRIPTS.WRITE,
        ([key, audit], [value, record, event, now, before, ttl]) => {
          const raw = this.get(key!)
          const old = raw?.startsWith("{") ? JSON.parse(raw) : undefined
          const previous = old?.value ?? raw ?? "on"
          if (previous === value && old?.generation && old?.changedAt !== undefined) return [raw, 0]
          const saved = JSON.parse(record!)
          if (value === "off" && previous === "off" && old?.offSince !== undefined) saved.offSince = old.offSince
          const rawSaved = JSON.stringify(saved)
          this.set(key!, rawSaved)
          const entries = this.zset(audit!)
          for (const [member, score] of entries) if (score <= Number(before)) entries.delete(member)
          entries.set(JSON.stringify({ ...JSON.parse(event!), previous }), Number(now))
          this.expires.set(audit!, this.clock.now + Number(ttl))
          return [rawSaved, 1]
        },
      ],
      [
        SWITCH_SCRIPTS.ESCALATE_HOSTED,
        ([key, audit], [value, record, event, now, before, ttl]) => {
          const raw = this.get(key!)
          const parsed = raw
            ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(raw))
            : undefined
          const old = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
          const previous = old ? old.value : (raw?.trim() ?? "on")
          const rank = (item: unknown) => ["on", "no-new", "stop"].findIndex((value) => value === item)
          if (
            rank(previous) < 0 ||
            rank(value) < 0 ||
            (old &&
              ([old.changedAt, old.offSince].some(
                (at) => at !== undefined && (!Number.isSafeInteger(at) || Number(at) < 0),
              ) ||
                (old.generation !== undefined && (typeof old.generation !== "string" || !old.generation))))
          )
            return ["", -1]
          if (rank(previous) >= rank(value)) return [raw, 0]
          this.set(key!, record!)
          const entries = this.zset(audit!)
          for (const [member, score] of entries) if (score <= Number(before)) entries.delete(member)
          entries.set(JSON.stringify({ ...JSON.parse(event!), previous }), Number(now))
          this.expires.set(audit!, this.clock.now + Number(ttl))
          return [record, 1]
        },
      ],
      [
        SWITCH_SCRIPTS.DISABLE,
        ([key, audit], [id, disabled, event, now, before, ttl]) => {
          const members = this.members(key!)
          const had = members.has(id!)
          if (disabled === "1") members.add(id!)
          else members.delete(id!)
          this.prune(key!)
          const changed = had !== (disabled === "1")
          if (changed) {
            const entries = this.zset(audit!)
            for (const [member, score] of entries) if (score <= Number(before)) entries.delete(member)
            entries.set(event!, Number(now))
            this.expires.set(audit!, this.clock.now + Number(ttl))
          }
          return changed ? 1 : 0
        },
      ],
      [
        RAMP_SCRIPTS.WRITE,
        ([owed, version], [account, cents, mode]) => {
          const values = this.hash(owed!)
          const previous = Number(values.get(account!) ?? 0)
          const value = mode === "raise" ? Math.max(previous, Number(cents)) : Number(cents)
          if (value) values.set(account!, String(value))
          else values.delete(account!)
          this.prune(owed!)
          if (value !== previous) this.set(version!, String(Number(this.get(version!) ?? 0) + 1))
          return value
        },
      ],
      [
        RAMP_SCRIPTS.READ,
        ([owed, version]) => {
          const entries = [...this.hash(owed!)].flat()
          this.prune(owed!)
          return [this.get(version!) ?? "0", entries]
        },
      ],
      [LEASE_CHECK, ([key], [token]) => (this.get(key!) === token ? this.pttl(key!) : -1)],
      [
        LEASE_RELEASE,
        ([key], [token]) => {
          if (this.get(key!) !== token) return 0
          this.remove(key!)
          return 1
        },
      ],
      [
        POOL_SCRIPTS.DEBIT,
        ([held, debits, due], [old, ref, record, score, member, ttl, expireAt, dueMember, dueAt]) => {
          const entries = this.hash(debits!)
          const recorded = entries.get(ref!)
          if (recorded !== undefined) {
            if (!recorded.includes(`"hold":"${old!}"`)) this.zset(held!).delete(old!)
            this.prune(held!)
            return 0
          }
          entries.set(ref!, record!)
          this.zset(held!).delete(old!)
          this.expires.set(debits!, Number(expireAt))
          this.zset(held!).set(member!, Number(score))
          this.growTtl(held!, ttl!)
          const queue = this.zset(due!)
          const current = queue.get(dueMember!)
          if (current === undefined || current > Number(dueAt)) queue.set(dueMember!, Number(dueAt))
          return 1
        },
      ],
      [
        POOL_SCRIPTS.APPLY,
        ([debits, held, account, due], [record, dueMember, ...pairs]) => {
          const entries = this.hash(debits!)
          for (let index = 0; index < pairs.length; index += 2) {
            const debit = entries.get(pairs[index]!)
            if (debit) entries.set(pairs[index]!, debit.replace('"applied":false', '"applied":true'))
            this.zset(held!).delete(pairs[index + 1]!)
            this.prune(held!)
          }
          if (record !== "") this.set(account!, record!)
          const pending = [...entries.values()].filter((value) => value.includes('"applied":false')).length
          this.prune(debits!)
          if (pending === 0) {
            this.zset(due!).delete(dueMember!)
            this.prune(due!)
          }
          return pending
        },
      ],
      [
        POOL_SCRIPTS.DEBITS,
        ([debits]) => {
          const flat = [...this.hash(debits!)].flat()
          this.prune(debits!)
          return flat
        },
      ],
      [
        SNAPSHOT_SCRIPTS.WRITE,
        ([snapshot, status, index, opened, outbox, ...items], argv) => {
          const current = this.get(snapshot!)
          if (current !== undefined) {
            try {
              const old = JSON.parse(current) as { version?: unknown }
              if (typeof old.version === "number" && old.version > Number(argv[1])) return 0
            } catch {
              // An unreadable snapshot is overwritten, as the script's pcall does.
            }
          }
          this.set(snapshot!, argv[0]!)
          if (argv[6] !== "") this.expires.set(snapshot!, this.clock.now + Number(argv[6]))
          this.remove(status!)
          if (argv[2] === "1") this.zset(index!).set(argv[4]!, Number(argv[3]))
          else {
            this.zset(index!).delete(argv[4]!)
            this.prune(index!)
          }
          if (argv[5] !== "" && this.get(opened!) === undefined) this.set(opened!, argv[5]!)
          items.forEach((key, position) => {
            const at = 7 + position * 3
            this.set(key, argv[at + 2]!)
            this.zset(outbox!).set(argv[at]!, Number(argv[at + 1]))
          })
          return 1
        },
      ],
      [
        SNAPSHOT_SCRIPTS.METER_ADD,
        ([meter], [amount, cap, expireAt]) => {
          const used = Number(this.get(meter!) ?? 0)
          if (used + Number(amount) > Number(cap)) return [0, used]
          this.set(meter!, String(used + Number(amount)))
          this.expires.set(meter!, Number(expireAt))
          return [1, used + Number(amount)]
        },
      ],
      [
        OUTBOX_SCRIPTS.ENQUEUE,
        ([outbox, item, dead], [id, raw, score, mode]) => {
          const set = this.zset(outbox!)
          const pending = set.get(id!)
          if (pending !== undefined && mode === "keep") return 0
          this.set(item!, raw!)
          if (pending === undefined || Number(score) < pending) set.set(id!, Number(score))
          this.zset(dead!).delete(id!)
          this.prune(dead!)
          return 1
        },
      ],
      [
        OUTBOX_SCRIPTS.FINISH,
        ([outbox, item, prov], [id, raw, version]) => {
          if (this.get(item!) === raw) {
            this.remove(item!)
            this.zset(outbox!).delete(id!)
            this.prune(outbox!)
          }
          if (prov !== undefined && Number(version) > (Number(this.get(prov) ?? 0) || 0)) this.set(prov, version!)
          return 1
        },
      ],
      [
        OUTBOX_SCRIPTS.RETRY,
        ([outbox, item, dead, alert], [id, raw, next, score, isDead, keep, before, alertId, alertRaw, alertScore]) => {
          if (this.get(item!) !== raw) return 0
          const queue = this.zset(outbox!)
          if (isDead !== "1") {
            this.set(item!, next!)
            queue.set(id!, Number(score))
            return 1
          }
          queue.delete(id!)
          this.set(item!, next!)
          this.expires.set(item!, this.clock.now + Number(keep))
          const letters = this.zset(dead!)
          for (const [member, at] of letters) if (at <= Number(before)) letters.delete(member)
          letters.set(id!, Number(score))
          if (alert !== undefined && !queue.has(alertId!)) {
            this.set(alert, alertRaw!)
            queue.set(alertId!, Number(alertScore))
          }
          this.prune(outbox!)
          return 2
        },
      ],
      [
        OUTBOX_SCRIPTS.RAISE,
        ([key], [value, keep]) => {
          if (Number(value) <= (Number(this.get(key!) ?? 0) || 0)) return 0
          this.set(key!, value!)
          this.expires.set(key!, this.clock.now + Number(keep))
          return 1
        },
      ],
    ]
    for (const [text, run] of scripts) this.scripts.set(text, run)
    // A17's ledger, fence and common hold (codium-spend-emulation.ts), on this store's values and clock.
    const spend = spendScripts({
      read: (key) => this.live(key),
      setString: (key, value, keepTtl) => {
        const at = this.expires.get(key)
        this.set(key, value)
        if (keepTtl && at !== undefined) this.expires.set(key, at)
      },
      hash: (key) => this.hash(key),
      zset: (key) => this.zset(key),
      prune: (key) => this.prune(key),
      pttl: (key) => this.pttl(key),
      expireAt: (key, at) => {
        if (this.live(key)) this.expires.set(key, at)
      },
    })
    for (const [text, run] of spend) this.scripts.set(text, run)
  }
}

// ── Stripe ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type StripeObjects = {
  customers?: Json[]
  subscriptions?: Json[]
  invoices?: Json[]
  charges?: Json[]
  payment_intents?: Json[]
  disputes?: Json[]
  early_fraud_warnings?: Json[]
  checkout_sessions?: Json[]
  refunds?: Json[]
  subscription_schedules?: Json[]
  /** Events as `GET /v1/events` lists them, each rendered at its own `api_version`. */
  events?: Json[]
}

const STRIPE_COLLECTIONS = [
  "customers",
  "subscriptions",
  "invoices",
  "charges",
  "payment_intents",
  "disputes",
  "early_fraud_warnings",
  "checkout_sessions",
  "refunds",
  "subscription_schedules",
  "events",
] as const

/**
 * Stripe's API for the objects Codium reads and writes, at {@link STRIPE_API_VERSION}: objects are stored as Stripe
 * returns them unexpanded (ids in place of related objects) and expanded only where a request asks with `expand[]`, so
 * a missing expansion shows up as a missing object, as it would against Stripe. A POST replayed with the same
 * idempotency key answers what the first one did, and one reused with a different body is refused, as Stripe does.
 */
export class FakeStripe {
  constructor(private readonly clock: FakeClock = new FakeClock()) {}
  readonly objects: Record<(typeof STRIPE_COLLECTIONS)[number], Map<string, Json>> = Object.fromEntries(
    STRIPE_COLLECTIONS.map((name) => [name, new Map<string, Json>()]),
  ) as never
  readonly calls: RecordedCall[] = []
  private readonly idempotency = new Map<string, { request: string; body: unknown }>()
  /** Answers a call with a failure of the test's choosing, before the fake looks at it. */
  fail?: (call: RecordedCall) => Response | undefined
  /** Invoices whose payment the card declines: `pay` counts the attempt and answers 402, as Stripe does. */
  readonly declines = new Set<string>()
  refundStatus = "succeeded"

  /** Adds objects as Stripe stores them (deep copies, so a fixture is never changed). */
  load(objects: StripeObjects) {
    for (const name of STRIPE_COLLECTIONS)
      for (const value of objects[name] ?? []) this.objects[name].set(String(value.id), structuredClone(value))
  }

  subscription(id: string) {
    return this.objects.subscriptions.get(id)
  }
  charge(id: string) {
    return this.objects.charges.get(id)
  }

  handle(call: RecordedCall): Response {
    this.calls.push(call)
    const failure = this.fail?.(call)
    if (failure) return failure
    const answer = this.answer(call)
    return Response.json(answer.body, { status: answer.status })
  }

  private answer(call: RecordedCall): Answer {
    if (call.stripeVersion !== STRIPE_API_VERSION)
      return stripeError(400, `Requests must pin Stripe-Version ${STRIPE_API_VERSION}.`)
    if (call.method !== "POST") return this.route(call)
    if (!call.idempotencyKey) return stripeError(400, "The fake requires an idempotency key on every POST.")
    const request = `${call.path}?${call.form?.toString() ?? ""}`
    const earlier = this.idempotency.get(call.idempotencyKey)
    if (earlier && earlier.request !== request)
      return stripeError(400, "Keys for idempotent requests can only be used with the same parameters.")
    if (earlier) return { status: 200, body: earlier.body }
    const answer = this.route(call)
    if (answer.status === 200) this.idempotency.set(call.idempotencyKey, { request, body: answer.body })
    return answer
  }

  private route(call: RecordedCall): Answer {
    const parts = call.path.split("/")
    const expand = call.query.getAll("expand[]")
    const ok = (body: unknown): Answer => ({ status: 200, body })
    const found = (value: Json | undefined) => (value ? ok(value) : stripeError(404, "No such object."))
    // Lists honour `created[gte]`/`created[lte]`, and `limit` with `starting_after` when the request names a limit.
    const list = (data: Json[]) => {
      const gte = call.query.get("created[gte]")
      const lte = call.query.get("created[lte]")
      let items = data.filter(
        (value) =>
          (gte === null || Number(value.created) >= Number(gte)) &&
          (lte === null || Number(value.created) <= Number(lte)),
      )
      const after = call.query.get("starting_after")
      if (after) {
        const at = items.findIndex((value) => value.id === after)
        items = at >= 0 ? items.slice(at + 1) : []
      }
      const limit = call.query.get("limit")
      const page = limit === null ? items : items.slice(0, Number(limit))
      return ok({ object: "list", data: page, has_more: items.length > page.length, url: `/v1/${call.path}` })
    }
    const [resource, id, action] = parts
    if (resource === "prices" && id && call.method === "GET") {
      const price = [...this.objects.subscriptions.values()]
        .flatMap((value) => {
          const items = value.items as { data?: { price?: Json }[] } | undefined
          return items?.data?.flatMap((item) => (item.price ? [item.price] : [])) ?? []
        })
        .find((price) => price.id === id)
      if (price) return ok(price)
      const amount = /^price_codium(10|50|100|200)$/.exec(id)?.[1]
      return amount
        ? ok({
            id,
            active: true,
            currency: "usd",
            unit_amount: Number(amount) * 100,
            recurring: { interval: "month", interval_count: 1 },
          })
        : stripeError(404, "No such price.")
    }
    if (resource === "invoices" && !id && call.method === "GET")
      return list(
        [...this.objects.invoices.values()].filter(
          (value) =>
            (!call.query.get("customer") || value.customer === call.query.get("customer")) &&
            (!call.query.get("subscription") || value.subscription === call.query.get("subscription")) &&
            (!call.query.get("status") || value.status === call.query.get("status")),
        ),
      )
    if (resource === "invoices" && id && call.method === "DELETE") {
      const invoice = this.objects.invoices.get(id)
      if (!invoice || invoice.status !== "draft") return stripeError(400, "Only draft invoices can be deleted.")
      this.objects.invoices.delete(id)
      return ok({ id, deleted: true })
    }
    if (resource === "checkout" && id === "sessions" && !action && call.method === "POST") {
      const session = {
        id: `cs_fixture${this.objects.checkout_sessions.size + 1}`,
        url: "https://checkout.stripe.com/c/fixture",
        status: "open",
        mode: call.form?.get("mode"),
        client_reference_id: call.form?.get("client_reference_id"),
        customer: call.form?.get("customer"),
        expires_at: Number(call.form?.get("expires_at")),
        metadata: {},
      }
      setMetadata(session, call.form ?? new URLSearchParams())
      this.objects.checkout_sessions.set(session.id, session)
      return ok(session)
    }
    if (resource === "billing_portal" && id === "sessions" && call.method === "POST")
      return ok({ url: "https://billing.stripe.com/p/fixture" })
    if (resource === "subscription_schedules" && !id && call.method === "POST") {
      const subscription = this.objects.subscriptions.get(call.form?.get("from_subscription") ?? "")
      if (!subscription || subscription.schedule) return stripeError(400, "Cannot create schedule.")
      const schedule = {
        id: `sub_sched${this.objects.subscription_schedules.size + 1}`,
        customer: subscription.customer,
        subscription: subscription.id,
        status: "active",
        phases: [],
      }
      subscription.schedule = schedule.id
      this.objects.subscription_schedules.set(schedule.id, schedule)
      return ok(schedule)
    }
    if (resource === "subscription_schedules" && id && call.method === "POST") {
      const schedule = this.objects.subscription_schedules.get(id)
      if (!schedule) return stripeError(404, "No such schedule.")
      if (action === "release") {
        schedule.status = "released"
        const subscription = this.objects.subscriptions.get(String(schedule.subscription))
        if (subscription) subscription.schedule = null
      } else {
        const form = call.form ?? new URLSearchParams()
        schedule.end_behavior = form.get("end_behavior")
        schedule.phases = [0, 1].map((phase) => ({
          start_date: Number(form.get(`phases[${phase}][start_date]`) ?? form.get("phases[0][end_date]")),
          items: [{ price: form.get(`phases[${phase}][items][0][price]`), quantity: 1 }],
        }))
      }
      return ok(schedule)
    }
    if (resource === "subscriptions" && call.method === "GET" && !id) {
      const customer = call.query.get("customer")
      const status = call.query.get("status")
      const subscriptions = [...this.objects.subscriptions.values()].filter(
        (value) =>
          (!customer || value.customer === customer) &&
          (status === "all" ? true : status ? value.status === status : value.status !== "canceled"),
      )
      return list(subscriptions.map((value) => this.expand(value, expand, "data.")))
    }
    if (resource === "subscriptions" && id && call.method === "GET")
      return found(this.expandOrUndefined(this.objects.subscriptions.get(id), expand))
    if (resource === "subscriptions" && id && call.method === "POST") {
      const subscription = this.objects.subscriptions.get(id)
      if (!subscription) return stripeError(404, "No such subscription.")
      const form = call.form ?? new URLSearchParams()
      if (form.has("pause_collection")) subscription.pause_collection = null
      if (form.has("pause_collection[behavior]"))
        subscription.pause_collection = { behavior: form.get("pause_collection[behavior]"), resumes_at: null }
      if (form.has("cancel_at_period_end"))
        subscription.cancel_at_period_end = form.get("cancel_at_period_end") === "true"
      setMetadata(subscription, form)
      return ok(subscription)
    }
    if (resource === "subscriptions" && id && call.method === "DELETE") {
      const subscription = this.objects.subscriptions.get(id)
      if (!subscription) return stripeError(404, "No such subscription.")
      Object.assign(subscription, { status: "canceled", canceled_at: 0, ended_at: 0 })
      return ok(subscription)
    }
    if (resource === "customers" && id && call.method === "GET") return found(this.objects.customers.get(id))
    if (resource === "charges" && call.method === "GET" && !id)
      return list(
        [...this.objects.charges.values()].filter(
          (value) => !call.query.get("customer") || value.customer === call.query.get("customer"),
        ),
      )
    if (resource === "charges" && id && call.method === "GET")
      return found(this.expandOrUndefined(this.objects.charges.get(id), expand))
    if (resource === "invoices" && id && call.method === "GET")
      return found(this.expandOrUndefined(this.objects.invoices.get(id), expand))
    if (resource === "invoices" && id && call.method === "POST") return this.invoiceAction(id, action, call)
    if (resource === "refunds" && !id && call.method === "GET")
      return list(
        [...this.objects.refunds.values()].filter(
          (refund) => !call.query.get("charge") || refund.charge === call.query.get("charge"),
        ),
      )
    if (resource === "charges" && !id && call.method === "GET")
      return list(
        [...this.objects.charges.values()].filter(
          (charge) => !call.query.get("customer") || charge.customer === call.query.get("customer"),
        ),
      )
    if (resource === "refunds" && !id && call.method === "POST") {
      const charge = this.objects.charges.get(call.form?.get("charge") ?? "")
      if (!charge || charge.paid !== true || charge.refunded === true)
        return stripeError(400, "Charge cannot be refunded.")
      const remaining = Number(charge.amount) - Number(charge.amount_refunded ?? 0)
      const amount = call.form?.has("amount") ? Number(call.form.get("amount")) : remaining
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining)
        return stripeError(400, "Invalid refund amount.")
      const refund = {
        id: `re_fraud${this.objects.refunds.size + 1}`,
        charge: charge.id,
        amount,
        currency: charge.currency ?? "usd",
        status: this.refundStatus,
        reason: call.form?.get("reason"),
        metadata: {},
      }
      setMetadata(refund, call.form ?? new URLSearchParams())
      if (!["failed", "canceled"].includes(this.refundStatus)) {
        charge.amount_refunded = Number(charge.amount_refunded ?? 0) + amount
        charge.refunded = charge.amount_refunded === charge.amount
      }
      this.objects.refunds.set(refund.id, refund)
      return ok(refund)
    }
    if (resource === "radar" && id === "value_list_items" && call.method === "POST")
      return ok({ id: "rsli_fixture", value_list: call.form?.get("value_list"), value: call.form?.get("value") })
    if (resource === "refunds" && id && call.method === "GET") return found(this.objects.refunds.get(id))
    if (resource === "subscription_schedules" && id && call.method === "GET")
      return found(this.objects.subscription_schedules.get(id))
    if (resource === "events" && call.method === "GET" && !id) {
      // Newest first, as Stripe lists them; `types[]` filters by type.
      const types = call.query.getAll("types[]")
      return list(
        [...this.objects.events.values()]
          .filter((value) => !types.length || types.includes(String(value.type)))
          .sort(
            (a, b) =>
              Number(b.created) - Number(a.created) ||
              (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0),
          ),
      )
    }
    if (resource === "disputes" && call.method === "GET" && !id)
      return list(
        [...this.objects.disputes.values()]
          .filter(
            (value) =>
              (!call.query.get("charge") || value.charge === call.query.get("charge")) &&
              (!call.query.get("payment_intent") || value.payment_intent === call.query.get("payment_intent")),
          )
          .map((value) => this.expand(value, expand, "data.")),
      )
    if (resource === "disputes" && id && call.method === "GET") return found(this.objects.disputes.get(id))
    if (resource === "radar" && id === "early_fraud_warnings" && call.method === "GET") {
      const warning = parts[2]
      if (warning) return found(this.objects.early_fraud_warnings.get(warning))
      return list(
        [...this.objects.early_fraud_warnings.values()].filter(
          (value) => !call.query.get("charge") || value.charge === call.query.get("charge"),
        ),
      )
    }
    if (resource === "checkout" && id === "sessions" && call.method === "GET" && !action)
      return list(
        [...this.objects.checkout_sessions.values()].filter(
          (value) =>
            (!call.query.get("customer") || value.customer === call.query.get("customer")) &&
            (!call.query.get("status") || value.status === call.query.get("status")),
        ),
      )
    if (resource === "checkout" && id === "sessions" && action && call.method === "GET")
      return found(this.objects.checkout_sessions.get(action))
    if (resource === "checkout" && id === "sessions" && action && parts[3] === "expire" && call.method === "POST") {
      const session = this.objects.checkout_sessions.get(action)
      if (!session) return stripeError(404, "No such checkout session.")
      session.status = "expired"
      return ok(session)
    }
    throw new Error(
      `Unexpected Stripe request ${call.method} /v1/${call.path}${call.query.size ? `?${call.query}` : ""}`,
    )
  }

  /**
   * `POST /v1/invoices/<id>` (update: `auto_advance`, metadata), `/finalize` (a draft becomes open) and `/pay` (an open
   * invoice is paid by a new charge, or, for an invoice in `declines`, the attempt is counted and answered 402).
   */
  private invoiceAction(id: string, action: string | undefined, call: RecordedCall): Answer {
    const invoice = this.objects.invoices.get(id)
    if (!invoice) return stripeError(404, "No such invoice.")
    const form = call.form ?? new URLSearchParams()
    const at = Math.floor(this.clock.now / 1000)
    const transitions = () => (invoice.status_transitions ??= {}) as Json
    if (!action) {
      if (form.has("auto_advance")) invoice.auto_advance = form.get("auto_advance") === "true"
      setMetadata(invoice, form)
      return { status: 200, body: invoice }
    }
    if (action === "void") {
      if (invoice.status !== "open") return stripeError(400, "Only open invoices can be voided.")
      invoice.status = "void"
      return { status: 200, body: invoice }
    }
    if (action === "finalize") {
      if (invoice.status !== "draft") return stripeError(400, "This invoice is already finalized.")
      Object.assign(invoice, { status: "open", auto_advance: form.get("auto_advance") !== "false" })
      transitions().finalized_at = at
      return { status: 200, body: invoice }
    }
    if (action === "pay") {
      if (invoice.status === "paid") return stripeError(400, "Invoice is already paid.")
      if (invoice.status !== "open") return stripeError(400, "You can only pay an open invoice.")
      invoice.attempt_count = Number(invoice.attempt_count ?? 0) + 1
      invoice.attempted = true
      if (this.declines.has(id))
        return { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Declined." } } }
      const charge: Json = {
        id: `ch_${id.slice("in_".length)}`,
        object: "charge",
        amount: invoice.amount_due,
        amount_captured: invoice.amount_due,
        amount_refunded: 0,
        captured: true,
        created: at,
        currency: invoice.currency ?? "usd",
        customer: invoice.customer,
        disputed: false,
        invoice: id,
        livemode: false,
        paid: true,
        refunded: false,
        status: "succeeded",
      }
      this.objects.charges.set(String(charge.id), charge)
      Object.assign(invoice, {
        status: "paid",
        paid: true,
        amount_paid: invoice.amount_due,
        amount_remaining: 0,
        charge: charge.id,
      })
      transitions().paid_at = at
      return { status: 200, body: invoice }
    }
    throw new Error(`Unexpected Stripe request POST /v1/invoices/${id}/${action}`)
  }

  private expandOrUndefined(value: Json | undefined, expand: string[]) {
    return value && this.expand(value, expand, "")
  }

  /** A deep copy of `value` with every path in `expand` (after `prefix`) replaced by its object. */
  private expand(value: Json, expand: string[], prefix: string): Json {
    const copy = structuredClone(value)
    const paths = expand.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("."))
    for (const path of paths) this.expandPath(copy, path)
    return copy
  }

  private expandPath(target: Json, path: string[]) {
    const [field, ...rest] = path
    if (!field) return
    const current = target[field]
    if (typeof current === "string") {
      const collection = RELATED[field]
      const related = collection && this.objects[collection].get(current)
      if (!related) return
      target[field] = structuredClone(related)
    }
    const next = target[field]
    if (next && typeof next === "object" && !Array.isArray(next)) this.expandPath(next as Json, rest)
  }
}

// Which collection an expandable field names.
const RELATED: Record<string, (typeof STRIPE_COLLECTIONS)[number] | undefined> = {
  latest_invoice: "invoices",
  invoice: "invoices",
  charge: "charges",
  latest_charge: "charges",
  payment_intent: "payment_intents",
  subscription: "subscriptions",
  customer: "customers",
}

type Answer = { status: number; body: unknown }

/** Applies `metadata[<name>]` fields of a form to an object's metadata; an empty value removes the name, as Stripe does. */
function setMetadata(target: Json, form: URLSearchParams) {
  for (const [name, value] of form) {
    const field = /^metadata\[(.+)\]$/.exec(name)?.[1]
    if (!field) continue
    const metadata = (target.metadata ??= {}) as Record<string, string>
    if (value === "") delete metadata[field]
    else metadata[field] = value
  }
}

function stripeError(status: number, message: string): Answer {
  return { status, body: { error: { type: "invalid_request_error", message } } }
}

// ── OpenRouter ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * OpenRouter's key management API: keys keep their name, limit, usage, expiry and whether they are disabled. A create
 * replayed with the same idempotency key answers the key the first one made.
 */
export class FakeOpenRouter {
  readonly keys = new Map<string, Json>()
  readonly calls: RecordedCall[] = []
  credits = { total_credits: 1000, total_usage: 0 }
  private readonly created = new Map<string, unknown>()
  fail?: (call: RecordedCall) => Response | undefined

  /** Adds a key as if Codium had made it earlier. */
  seed(hash: string, data: Json) {
    this.keys.set(hash, {
      hash,
      usage: 0,
      disabled: false,
      limit_reset: null,
      include_byok_in_limit: true,
      ...data,
    })
  }

  /** Each key's limit, by hash. */
  limits() {
    return Object.fromEntries([...this.keys].map(([hash, data]) => [hash, data.limit]))
  }

  handle(call: RecordedCall): Response {
    this.calls.push(call)
    const failure = this.fail?.(call)
    if (failure) return failure
    if (call.path === "credits") return Response.json({ data: this.credits })
    if (call.path === "keys" && call.method === "GET")
      return Response.json({ data: call.query.get("offset") === "0" ? [...this.keys.values()] : [] })
    if (call.path === "keys" && call.method === "POST") {
      const replay = call.idempotencyKey && this.created.get(call.idempotencyKey)
      if (replay) return Response.json(replay)
      const hash = `fake_key_${this.keys.size + 1}`
      const data = { ...call.json, hash, usage: 0, disabled: false }
      this.keys.set(hash, data)
      const body = { key: `fake-openrouter-secret-${this.keys.size}`, data }
      if (call.idempotencyKey) this.created.set(call.idempotencyKey, body)
      return Response.json(body)
    }
    const key = this.keys.get(call.path.split("/").at(-1) ?? "")
    if (!call.path.startsWith("keys/") || !key) return Response.json({ error: "Unknown key" }, { status: 404 })
    if (call.method === "PATCH") Object.assign(key, call.json)
    else if (call.method !== "GET") throw new Error(`Unexpected OpenRouter request ${call.method} ${call.path}`)
    return Response.json({ data: key })
  }
}

// ── Together ───────────────────────────────────────────────────────────────────────────────────────────────────

export type CodiumFakes = ReturnType<typeof codiumFakes>

/**
 * The owner's email service (Resend): records each email it is asked to send. Set `fail` to make sends fail, as an
 * outage or a rejected key does.
 */
export class FakeMail {
  readonly sent: { from: string; to: string; subject: string; text: string }[] = []
  fail = false
}

/** A store, Stripe, OpenRouter and the owner's email on one clock, and the `fetch` that reaches them and nothing else. */
export function codiumFakes(options: { now?: number } = {}) {
  const clock = new FakeClock(options.now)
  const store = new FakeStore(clock)
  const stripe = new FakeStripe(clock)
  const openRouter = new FakeOpenRouter()
  const mail = new FakeMail()
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    const body = init?.body === undefined || init.body === null ? "" : String(init.body)
    if (url.href === "https://api.resend.com/emails" && init?.method === "POST") {
      if (mail.fail) return new Response("unavailable", { status: 503 })
      mail.sent.push(JSON.parse(body) as FakeMail["sent"][number])
      return Response.json({ id: `email_${mail.sent.length}` })
    }
    if (url.origin === FAKE_KV_URL) {
      try {
        return Response.json({ result: store.command(JSON.parse(body) as unknown[]) })
      } catch (error) {
        if (store.down) return new Response("unavailable", { status: 503 })
        throw error
      }
    }
    const call = {
      method: init?.method ?? "GET",
      query: url.searchParams,
      ...(headers.get("idempotency-key") ? { idempotencyKey: headers.get("idempotency-key")! } : {}),
    }
    if (url.origin === "https://api.stripe.com" && url.pathname.startsWith("/v1/"))
      return stripe.handle({
        ...call,
        service: "stripe",
        path: url.pathname.slice("/v1/".length),
        ...(body ? { form: new URLSearchParams(body) } : {}),
        ...(headers.get("stripe-version") ? { stripeVersion: headers.get("stripe-version")! } : {}),
      })
    if (url.origin === "https://openrouter.ai" && url.pathname.startsWith("/api/v1/"))
      return openRouter.handle({
        ...call,
        service: "openrouter",
        path: url.pathname.slice("/api/v1/".length),
        ...(body ? { json: JSON.parse(body) as Json } : {}),
      })
    throw new Error(`Unexpected request to ${url.origin}`)
  }) as typeof fetch
  return { clock, store, stripe, openRouter, mail, fetcher }
}

const ENVIRONMENT = [
  "MODEL_PLANS_ENABLED",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "VERCEL_ENV",
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "CODIUM_RENEWAL_GRACE_MINUTES",
  "CODIUM_TRUST_RAMP_DAYS",
  // Owner alerts stay off unless a test turns them on, so no test depends on the shell it runs in.
  "RESEND_API_KEY",
  "VECTOR_PURCHASE_EMAIL_FROM",
  "CODIUM_OWNER_EMAIL",
  "VECTOR_BUG_REPORT_TO",
  ...FIXTURE_PRICES.flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]

/**
 * Sets the environment the fixtures assume (Stripe test mode, the fake store, the fixtures' price ids and credits, test
 * keys not capped) and returns a function that puts the previous environment back.
 */
export function codiumTestEnvironment(overrides: Record<string, string | undefined> = {}) {
  const original = new Map(ENVIRONMENT.concat(Object.keys(overrides)).map((name) => [name, process.env[name]]))
  for (const name of original.keys()) delete process.env[name]
  Object.assign(process.env, {
    MODEL_PLANS_ENABLED: "true",
    KV_REST_API_URL: FAKE_KV_URL,
    KV_REST_API_TOKEN: "fixture-kv-token",
    STRIPE_SECRET_KEY: "sk_test_codium_fixture",
    CODIUM_STRIPE_MODE: "test",
    VERCEL_ENV: "preview",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
    // The fixtures follow the plans' full credits; test mode would otherwise cap every key at the test cap.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
  })
  for (const price of FIXTURE_PRICES) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = FIXTURE_CREDITS[price]
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_codium${price}`
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return () =>
    original.forEach((value, name) => {
      delete process.env[name]
      if (value !== undefined) process.env[name] = value
    })
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────

const FIXTURES = fileURLToPath(new URL("../fixtures/stripe/", import.meta.url))

/** One scenario: Stripe objects at a moment, the account record around them, and what reconcile should make of it. */
export type StripeFixture = {
  /** The row of the contract's §4.4 "Stripe → state" table this fixture covers, or "governing". */
  row: string
  description: string
  apiVersion: string
  accountId: string
  /** Seconds since the epoch. */
  now: number
  /** The account record's fields before reconcile (customer, risk, closing). */
  account: Json
  /** A key Codium made earlier for this period (seconds), when the scenario has one. */
  key?: { subscription: string; start: number; end: number }
  hint?: { kind: "dispute"; charge: string } | { kind: "efw"; id: string; charge?: string }
  objects: StripeObjects
  expect: {
    state: string
    reason?: string
    plan: string | null
    subscription?: string
    periodStart: number
    periodEnd: number
    cancelAtPeriodEnd?: boolean
    /** What happens to the account's OpenRouter key: made now, kept on, switched off, or there is none. */
    key: "created" | "enabled" | "disabled" | "none"
    keyLimit?: number
    risk?: { blocked?: boolean; reason?: string; openDisputes?: string[]; efw?: string[] }
    duplicates?: string[]
    stripeCalls?: number
  }
}

export function stripeFixtureNames() {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort()
}

export function loadStripeFixture(name: string): StripeFixture {
  const fixture = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as StripeFixture
  if (fixture.apiVersion !== STRIPE_API_VERSION) throw new Error(`${name} is not at ${STRIPE_API_VERSION}`)
  return fixture
}
