import { RAMP_SCRIPTS } from "../api/_lib/codium-ramp"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import {
  EMPTY_LEDGER,
  MODEL_HOLD_MS,
  DEBIT_HOLD_MS,
  DEBIT_RETRY_MS,
  debitHoldTicket,
  holdMember,
  limitMatches,
  limitUsd,
  parseHoldMember,
  POOL_SCRIPTS,
  poolFigures,
  poolShareUsed,
  readDebits,
  readPoolLedger,
  usdToMicro,
  usdToMicroCeil,
} from "../api/_lib/codium-pool"
import {
  applyPoolDebits,
  drainDebitApplies,
  holdPool,
  keyExpiresAt,
  modelPlanCredential,
  modelPlanStatus,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { SNAPSHOT_SCRIPTS } from "../api/_lib/codium-snapshot"
import { renewalGraceMinutes } from "../api/_lib/codium-limits"
import { readyGenesisFields, spendScripts } from "../packages/web/test/fixture/codium-spend-emulation"
import { modelPlanBalance } from "../api/_lib/model-plan-status"

// Invariants M1–M3 (WP A03): the OpenRouter key is the hard cap, spend is held before it starts, and what is available
// is one figure everywhere. Stripe and OpenRouter are fakes behind the injected fetcher. The store is a real Valkey when
// VECTOR_TEST_REDIS_URL is set (the CI lane), so the pool's Lua runs for real there; otherwise it is an in-memory store
// that runs the same scripts as TypeScript, step for step.

const user = { id: "77777777-7777-4777-8777-777777777777" }
const KV = "https://kv.pool-fixture.invalid"
const PRICES = [10, 50, 100, 200] as const
// Made-up credits that keep the public multiples (5.5x, 12x and 25x Plus); the real pools stay private.
const CREDITS = { 10: "4", 50: "22", 100: "48", 200: "100" } as const
const HASH = "hash_pool1"
const HOUR = 3_600_000

const environment = [
  "MODEL_PLANS_ENABLED",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "VERCEL_ENV",
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_PLAN_MODELS_JSON",
  ...PRICES.flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const original = new Map(environment.map((name) => [name, process.env[name]]))

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────────

const database = process.env.VECTOR_TEST_REDIS_URL ? new RedisClient(process.env.VECTOR_TEST_REDIS_URL) : undefined

type Value =
  | { kind: "string"; value: string }
  | { kind: "hash"; value: Map<string, string> }
  | { kind: "zset"; value: Map<string, number> }
const memory = { data: new Map<string, Value>(), expires: new Map<string, number>() }

async function redis(command: readonly (string | number)[]): Promise<unknown> {
  if (database) return database.send(String(command[0]), command.slice(1).map(String))
  return memoryCommand(command.map(String))
}

function live(key: string) {
  const at = memory.expires.get(key)
  if (at !== undefined && at <= Date.now()) {
    memory.data.delete(key)
    memory.expires.delete(key)
  }
  return memory.data.get(key)
}
function remove(key: string) {
  memory.data.delete(key)
  memory.expires.delete(key)
}
function zset(key: string) {
  const value = live(key)
  if (value?.kind === "zset") return value.value
  const created = new Map<string, number>()
  memory.data.set(key, { kind: "zset", value: created })
  return created
}
function hash(key: string) {
  const value = live(key)
  if (value?.kind === "hash") return value.value
  const created = new Map<string, string>()
  memory.data.set(key, { kind: "hash", value: created })
  return created
}
// Redis deletes a set or hash, and its lifetime, when its last member goes.
function prune(key: string) {
  const value = memory.data.get(key)
  if (value && value.kind !== "string" && value.value.size === 0) remove(key)
}
function pttl(key: string) {
  if (!live(key)) return -2
  const at = memory.expires.get(key)
  return at === undefined ? -1 : at - Date.now()
}
const ordered = (set: Map<string, number>) => [...set].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
const bound = (value: string, side: "min" | "max") => {
  if (value === "-inf") return { at: -Infinity, open: false }
  if (value === "+inf") return { at: Infinity, open: false }
  return value.startsWith("(") ? { at: Number(value.slice(1)), open: true } : { at: Number(value), open: false }
}
function between(set: Map<string, number>, min: string, max: string) {
  const low = bound(min, "min")
  const high = bound(max, "max")
  return ordered(set).filter(
    ([, score]) => (low.open ? score > low.at : score >= low.at) && (high.open ? score < high.at : score <= high.at),
  )
}
function growTtl(key: string, ms: string) {
  if (pttl(key) < Number(ms)) memory.expires.set(key, Date.now() + Number(ms))
}

/** The pool's scripts as TypeScript, one line of Lua at a time, plus the account lease's two. */
const scripts = new Map<string, (keys: string[], argv: string[]) => unknown>([
  [
    RAMP_SCRIPTS.WRITE,
    ([owed, version], [account, cents, mode]) => {
      const values = hash(owed!)
      const previous = Number(values.get(account!) ?? 0)
      const value = mode === "raise" ? Math.max(previous, Number(cents)) : Number(cents)
      if (value) values.set(account!, String(value))
      else values.delete(account!)
      prune(owed!)
      if (value !== previous)
        memory.data.set(version!, {
          kind: "string",
          value: String(
            Number(live(version!)?.kind === "string" ? (live(version!) as { value: string }).value : 0) + 1,
          ),
        })
      return value
    },
  ],
  [
    RAMP_SCRIPTS.READ,
    ([owed, version]) => {
      const current = live(version!)
      const entries = [...hash(owed!)].flat()
      prune(owed!)
      return [current?.kind === "string" ? current.value : "0", entries]
    },
  ],
  [
    POOL_SCRIPTS.DEBIT,
    ([held, debits, due], [old, ref, record, score, member, ttl, expireAt, dueMember, dueAt]) => {
      const entries = hash(debits!)
      const recorded = entries.get(ref!)
      if (recorded !== undefined) {
        if (!recorded.includes(`"hold":"${old!}"`)) zset(held!).delete(old!)
        prune(held!)
        return 0
      }
      entries.set(ref!, record!)
      zset(held!).delete(old!)
      memory.expires.set(debits!, Number(expireAt))
      zset(held!).set(member!, Number(score))
      growTtl(held!, ttl!)
      const queue = zset(due!)
      const current = queue.get(dueMember!)
      if (current === undefined || current > Number(dueAt)) queue.set(dueMember!, Number(dueAt))
      return 1
    },
  ],
  [
    POOL_SCRIPTS.APPLY,
    ([debits, held, account, due], [record, dueMember, ...pairs]) => {
      const entries = hash(debits!)
      for (let index = 0; index < pairs.length; index += 2) {
        const debit = entries.get(pairs[index]!)
        if (debit) entries.set(pairs[index]!, debit.replace('"applied":false', '"applied":true'))
        zset(held!).delete(pairs[index + 1]!)
        prune(held!)
      }
      if (record !== "") {
        memory.data.set(account!, { kind: "string", value: record! })
        memory.expires.delete(account!)
      }
      const pending = [...entries.values()].filter((value) => value.includes('"applied":false')).length
      prune(debits!)
      if (pending === 0) {
        zset(due!).delete(dueMember!)
        prune(due!)
      }
      return pending
    },
  ],
  [
    POOL_SCRIPTS.DEBITS,
    ([debits]) => {
      const flat = [...hash(debits!)].flat()
      prune(debits!)
      return flat
    },
  ],
  // A17's ledger, fence and common hold, shared with the billing fakes (codium-spend-emulation.ts).
  ...spendScripts({
    read: (key) => live(key),
    setString: (key, value, keepTtl) => {
      const at = memory.expires.get(key)
      memory.data.set(key, { kind: "string", value })
      if (keepTtl && at !== undefined) memory.expires.set(key, at)
      else memory.expires.delete(key)
    },
    hash,
    zset,
    prune,
    pttl,
    expireAt: (key, at) => {
      if (live(key)) memory.expires.set(key, at)
    },
  }),
  [
    "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('PTTL', KEYS[1])",
    ([key], [token]) => {
      const value = live(key!)
      return value?.kind === "string" && value.value === token ? pttl(key!) : -1
    },
  ],
  [
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0",
    ([key], [token]) => {
      const value = live(key!)
      if (value?.kind !== "string" || value.value !== token) return 0
      remove(key!)
      return 1
    },
  ],
  [
    // Reconcile's snapshot write (WP A05; test/codium-billing.test.ts covers it): only what these tests can see.
    SNAPSHOT_SCRIPTS.WRITE,
    ([snapshot, status, index, opened, outbox, ...items], argv) => {
      memory.data.set(snapshot!, { kind: "string", value: argv[0]! })
      memory.expires.delete(snapshot!)
      if (argv[6] !== "") memory.expires.set(snapshot!, Date.now() + Number(argv[6]))
      remove(status!)
      if (argv[2] === "1") zset(index!).set(argv[4]!, Number(argv[3]))
      else zset(index!).delete(argv[4]!)
      prune(index!)
      if (argv[5] !== "" && !live(opened!)) memory.data.set(opened!, { kind: "string", value: argv[5]! })
      items.forEach((key, position) => {
        memory.data.set(key, { kind: "string", value: argv[9 + position * 3]! })
        zset(outbox!).set(argv[7 + position * 3]!, Number(argv[8 + position * 3]))
      })
      return 1
    },
  ],
])

function memoryCommand(command: string[]): unknown {
  const [name, ...args] = command
  if (name === "FLUSHDB") {
    memory.data.clear()
    memory.expires.clear()
    return "OK"
  }
  if (name === "GET") {
    const value = live(args[0]!)
    return value?.kind === "string" ? value.value : null
  }
  if (name === "SET") {
    const [key, value, ...options] = args
    if (options.includes("NX") && live(key!)) return null
    memory.data.set(key!, { kind: "string", value: value! })
    memory.expires.delete(key!)
    const px = options.indexOf("PX")
    if (px >= 0) memory.expires.set(key!, Date.now() + Number(options[px + 1]))
    return "OK"
  }
  if (name === "PTTL") return pttl(args[0]!)
  if (name === "DEL") return args.reduce((count, key) => count + (live(key) ? (remove(key), 1) : 0), 0)
  if (name === "HSET") {
    hash(args[0]!).set(args[1]!, args[2]!)
    return 1
  }
  if (name === "ZADD") {
    const xx = args[1] === "XX"
    const [key, score, member] = xx ? [args[0], args[2], args[3]] : args
    const set = zset(key!)
    if (xx && !set.has(member!)) {
      prune(key!)
      return 0
    }
    set.set(member!, Number(score))
    return 1
  }
  if (name === "ZREM") {
    const set = zset(args[0]!)
    const removed = set.delete(args[1]!) ? 1 : 0
    prune(args[0]!)
    return removed
  }
  if (name === "ZRANGE") {
    const members = ordered(zset(args[0]!)).map(([member]) => member)
    prune(args[0]!)
    return members
  }
  if (name === "ZSCORE") {
    const score = zset(args[0]!).get(args[1]!)
    prune(args[0]!)
    return score === undefined ? null : String(score)
  }
  if (name === "ZRANGEBYSCORE") {
    const limit = args.indexOf("LIMIT")
    const found = between(zset(args[0]!), args[1]!, args[2]!).map(([member]) => member)
    prune(args[0]!)
    return limit >= 0 ? found.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2])) : found
  }
  if (name === "EVAL") {
    const [script, count, ...rest] = args
    const run = scripts.get(script!)
    if (!run) throw new Error(`Unexpected store script ${script!.slice(0, 60)}`)
    return run(rest.slice(0, Number(count)), rest.slice(Number(count)))
  }
  throw new Error(`Unexpected store command ${name}`)
}

// ── Stripe and OpenRouter ──────────────────────────────────────────────────────────────────────────────────────────

type Call = { method: string; path: string; body: Record<string, unknown> }
const world = {
  subscriptions: [] as Record<string, unknown>[],
  keys: new Map<string, Record<string, unknown>>(),
  openRouter: [] as Call[],
  failPatches: 0,
  stripe: 0,
}

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const body = init?.body === undefined || init.body === null ? "" : String(init.body)
  if (url.origin === KV) return Response.json({ result: await redis(JSON.parse(body) as (string | number)[]) })
  if (url.origin === "https://api.stripe.com") {
    world.stripe++
    if (url.pathname === "/v1/subscriptions") return Response.json({ data: world.subscriptions, has_more: false })
    if (url.pathname === "/v1/charges/ch_before")
      return Response.json({
        id: "ch_before",
        customer: "cus_pool",
        paid: true,
        refunded: false,
        disputed: false,
        amount_refunded: 0,
      })
    throw new Error(`Unexpected Stripe request ${url.pathname}`)
  }
  if (url.origin === "https://openrouter.ai" && url.pathname.startsWith("/api/v1/keys")) {
    const method = init?.method ?? "GET"
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    world.openRouter.push({ method, path: url.pathname, body: parsed })
    if (method === "POST") {
      const hash = `hash_pool${world.keys.size + 1}`
      const data = { ...parsed, hash, usage: 0, disabled: false }
      world.keys.set(hash, data)
      return Response.json({ key: `pool-secret-${world.keys.size}`, data })
    }
    const key = world.keys.get(url.pathname.split("/").at(-1)!)
    if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
    if (method === "PATCH") {
      if (world.failPatches > 0) {
        world.failPatches--
        return Response.json({ error: "fixture outage" }, { status: 503 })
      }
      Object.assign(key, parsed)
    }
    return Response.json({ data: key })
  }
  throw new Error(`Unexpected request to ${url.origin}`)
}) as typeof fetch

const patches = () => world.openRouter.filter((call) => call.method === "PATCH")

function period() {
  const start = Math.floor(Date.now() / 1000) - 3600
  return { start, end: start + 30 * 86_400 }
}

function subscription(price: (typeof PRICES)[number]) {
  const { start, end } = period()
  return {
    id: "sub_pool",
    customer: "cus_pool",
    status: "active",
    cancel_at_period_end: false,
    metadata: { vector_account_id: user.id },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: {
            id: `price_pool${price}`,
            active: true,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_pool",
      paid: true,
      status: "paid",
      amount_paid: price * 100,
      charge: {
        id: "ch_pool",
        paid: true,
        refunded: false,
        disputed: false,
        amount_refunded: 0,
        payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
      },
      lines: { data: [{ price: { id: `price_pool${price}` }, period: { start, end }, proration: false }] },
    },
  }
}

/**
 * A paid month on `price`'s plan whose key already exists: the account record as the pool keeps it, the OpenRouter key
 * at `limit` with `usage` spent, and `applied` debits already taken off it. A current key was created fresh, so its
 * pool has a trusted genesis (A17), optionally with a `committed` model floor; a `legacy` one predates both. The
 * account is then reconciled once, as the webhook would, which writes its snapshot; the calls that made are forgotten.
 */
async function seed(options: {
  price: (typeof PRICES)[number]
  limit: number
  usage?: number
  carryMicro?: number
  applied?: number[]
  legacy?: boolean
  committed?: number
}) {
  const { start, end } = period()
  const credits = Number(CREDITS[options.price])
  const creditsMicro = usdToMicro(credits)
  const appliedMicro = (options.applied ?? []).reduce((sum, value) => sum + value, 0)
  const key = {
    hash: HASH,
    encrypted: protectModelPlanKey("pool-secret-1", `${user.id}:sub_pool:${start}`),
    subscription: "sub_pool",
    start,
    end,
    credits,
    ...(options.legacy
      ? {}
      : {
          spendGenesis: { nonce: "seed-genesis", state: "ready" },
          creditsMicro,
          limitMicro: creditsMicro + (options.carryMicro ?? 0) - appliedMicro,
          ...(options.carryMicro
            ? {
                carry: {
                  micro: options.carryMicro,
                  fromSubscription: "sub_before",
                  fromStart: start - 600,
                  fromCharge: "ch_before",
                },
              }
            : {}),
        }),
  }
  await redis(["SET", `vector:codium:test:account:${user.id}`, JSON.stringify({ customer: "cus_pool", key })])
  if (!options.legacy)
    for (const [field, value] of readyGenesisFields({
      account: user.id,
      pool: HASH,
      subscription: "sub_pool",
      start,
      end,
      nonce: "seed-genesis",
      committedMicro: options.committed,
    }))
      await redis(["HSET", `vector:codium:test:model-spend:${HASH}`, field, value])
  for (const [index, micro] of (options.applied ?? []).entries())
    await redis([
      "HSET",
      `vector:codium:test:debits:${user.id}:${HASH}`,
      `seeded-${index}`,
      JSON.stringify({
        micro,
        applied: true,
        hold: `seed${index}:hosted:-:${micro}`,
        purpose: "hosted",
        at: Date.now(),
      }),
    ])
  world.subscriptions = [subscription(options.price)]
  world.keys.set(HASH, {
    hash: HASH,
    name: `Vector test ${user.id} sub_pool ${start}`,
    limit: options.limit,
    usage: options.usage ?? 0,
    disabled: false,
    limit_reset: null,
    include_byok_in_limit: true,
    // As provisioning makes it since WP A07: the period's end plus the renewal grace (M11).
    expires_at: keyExpiresAt(end),
  })
  await reconcileModelPlanAccount(user.id, fetcher)
  world.openRouter.length = 0
  world.stripe = 0
}

const heldMembers = async () => (await redis(["ZRANGE", `vector:codium:test:held:${HASH}`, 0, -1])) as string[]
const ledger = () => readPoolLedger(user.id, HASH, Date.now(), fetcher)
const status = async () => {
  const monthly = await modelPlanStatus(user.id, fetcher)
  return { monthly, balance: modelPlanBalance(monthly) }
}

beforeEach(async () => {
  environment.forEach((name) => delete process.env[name])
  Object.assign(process.env, {
    MODEL_PLANS_ENABLED: "true",
    KV_REST_API_URL: KV,
    KV_REST_API_TOKEN: "fixture-kv-token",
    STRIPE_SECRET_KEY: "sk_test_pool_fixture",
    CODIUM_STRIPE_MODE: "test",
    // These tests use the plans' full credits; test mode would otherwise cap every key at $0.50.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
    VERCEL_ENV: "preview",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
  })
  for (const price of PRICES) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = CREDITS[price]
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_pool${price}`
  }
  await redis(["FLUSHDB"])
  world.subscriptions = []
  world.keys.clear()
  world.openRouter.length = 0
  world.failPatches = 0
  world.stripe = 0
})
afterEach(() =>
  original.forEach((value, name) => {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }),
)

// ── Arithmetic ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("pool arithmetic", () => {
  test("amounts are whole micro-dollars, holds never round down, and limits are set in whole cents", () => {
    expect(usdToMicro(0.000031)).toBe(31)
    expect(usdToMicro(4.97)).toBe(4_970_000)
    expect(usdToMicroCeil(0.012288)).toBe(12_288)
    expect(usdToMicroCeil(0.0000001)).toBe(1)
    expect(usdToMicroCeil(0.001)).toBe(1_000)
    expect(limitUsd(49_936_000)).toBe(49.94)
    expect(limitUsd(49_935_000)).toBe(49.94)
    expect(limitUsd(-5)).toBe(0)
    expect(() => usdToMicro(Number.NaN)).toThrow()
  })

  test("a limit within half a cent matches, so a key set in cents is never PATCHed again", () => {
    expect(limitMatches(49.94, 49_936_000)).toBe(true)
    expect(limitMatches(49.93, 49_936_000)).toBe(false)
    expect(limitMatches(49.95, 49_936_000)).toBe(false)
    // The value a half-cent target is PATCHed to matches it.
    expect(limitMatches(limitUsd(49_935_000), 49_935_000)).toBe(true)
    expect(limitMatches("49.94", 49_936_000)).toBe(false)
    expect(limitMatches(undefined, 0)).toBe(false)
  })

  test("every figure comes from credits, carry, usage, debits and holds", () => {
    const ledger = {
      heldMicro: 1_500_000,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 564_000,
      pendingMicro: 1_000_000,
    }
    const figures = poolFigures({ creditsMicro: 48_000_000, carryMicro: 2_500_000 }, 10_000_000, ledger)
    expect(figures).toEqual({
      totalMicro: 50_500_000,
      spentMicro: 11_564_000,
      limitMicro: 49_936_000,
      remainingMicro: 38_936_000,
      // The pending debit is among the holds, so it is counted once.
      availableMicro: 50_500_000 - 564_000 - 10_000_000 - 1_500_000,
    })
    expect(poolShareUsed(figures)).toBe(0.23)
    // Model spend is the larger of lagging usage and the committed floor, never their sum; an abandoned reservation
    // (unknown outcome) is held at its full amount, and neither lowers the provider key's limit.
    const floored = poolFigures({ creditsMicro: 48_000_000, carryMicro: 2_500_000 }, 10_000_000, {
      ...ledger,
      committedMicro: 12_000_000,
      abandonedMicro: 700_000,
    })
    expect(floored).toEqual({
      totalMicro: 50_500_000,
      spentMicro: 13_564_000,
      limitMicro: 49_936_000,
      remainingMicro: 36_936_000,
      availableMicro: 50_500_000 - 564_000 - 12_000_000 - 1_500_000 - 700_000,
    })
    expect(
      poolFigures({ creditsMicro: 4_000_000, carryMicro: 0 }, 3_000_000, {
        ...EMPTY_LEDGER,
        committedMicro: 2_000_000,
      }),
    ).toMatchObject({ spentMicro: 3_000_000, availableMicro: 1_000_000 })
  })

  test("the share used is a whole percent, and used + left is exactly 100", () => {
    for (let spent = 0; spent <= 4_000_000; spent += 25_001) {
      const used = poolShareUsed({ totalMicro: 4_000_000, spentMicro: spent })
      expect(Math.round(used * 100) / 100).toBe(used)
      expect(Math.round(used * 100) + Math.round((1 - used) * 100)).toBe(100)
    }
    expect(poolShareUsed({ totalMicro: 4_000_000, spentMicro: 6_000_000 })).toBe(1)
    expect(poolShareUsed({ totalMicro: 0, spentMicro: 0 })).toBe(1)
  })

  test("a held member is <ticket>:<purpose>:<runId or ->:<micro>", () => {
    expect(holdMember("ticket-1", "hosted", undefined, 12_288)).toBe("ticket-1:hosted:-:12288")
    expect(holdMember("ticket-1", "cloud-agents", "run_7", 1)).toBe("ticket-1:cloud-agents:run_7:1")
    expect(parseHoldMember("ticket-1:cloud-agents:run_7:1")).toEqual({
      ticket: "ticket-1",
      purpose: "cloud-agents",
      run: "run_7",
      micro: 1,
    })
    expect(parseHoldMember("ticket-1:0.012288")).toBeUndefined()
    expect(() => holdMember("ticket-1", "hosted", "a:b", 1)).toThrow()
    expect(() => holdMember("ticket-1", "hosted", "-", 1)).toThrow()
    expect(() => holdMember("ticket-1", "hosted", undefined, 0.5)).toThrow()
  })
})

// ── M1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M1: the provider key is the hard cap", () => {
  test("a key keeps its carry and debits, is never repaired to the plan's credits, and 49.936 vs 49.94 is no PATCH", async () => {
    // Max: 48 of credits, 2.50 carried from an upgrade, 0.564 of hosted debits applied: 49.936, set as 49.94.
    await seed({ price: 100, limit: 49.94, usage: 10, carryMicro: 2_500_000, applied: [564_000] })
    await reconcileModelPlanAccount(user.id, fetcher)
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)
    expect(patches()).toEqual([])
    expect(world.keys.get(HASH)?.limit).toBe(49.94)

    // A key whose limit drifted, here back to the plan's credits, is set to the pool's limit, not to the credits.
    world.keys.get(HASH)!.limit = 48
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.body).toMatchObject({ limit: 49.94, disabled: false })
    expect(world.keys.get(HASH)?.limit).toBe(49.94)
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(patches()).toHaveLength(1)
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      creditsMicro: 48_000_000,
      carry: { micro: 2_500_000 },
      limitMicro: 49_936_000,
    })
  })

  test("a switched-off key is switched back on at the pool's limit, its usage kept", async () => {
    await seed({ price: 10, limit: 3.5, usage: 2, applied: [500_000] })
    world.keys.get(HASH)!.disabled = true
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)
    expect(world.keys.get(HASH)).toMatchObject({ disabled: false, limit: 3.5, usage: 2 })
    expect(patches().map((call) => call.body.limit)).toEqual([3.5])
  })

  test("a new month's key starts at its credits in whole micro-dollars, and a record from before them is filled in", async () => {
    world.subscriptions = [subscription(50)]
    await redis(["SET", `vector:codium:test:account:${user.id}`, JSON.stringify({ customer: "cus_pool" })])
    await modelPlanCredential(user.id, fetcher)
    const created = world.openRouter.filter((call) => call.method === "POST")
    expect(created.map((call) => call.body.limit)).toEqual([22])
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      credits: 22,
      creditsMicro: 22_000_000,
      limitMicro: 22_000_000,
    })

    // A record written before the pool counted in micro-dollars has no debits: its limit is its credits.
    world.openRouter.length = 0
    await seed({ price: 100, limit: 48, legacy: true })
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(patches()).toEqual([])
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      creditsMicro: 48_000_000,
      limitMicro: 48_000_000,
    })
  })
})

// ── M2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M2: spend is held before it starts", () => {
  test("every pool charge holds in one set, and a 12 h hold survives a later 660 s one", async () => {
    await seed({ price: 100, limit: 48 })
    const block = await holdPool(user.id, 1, 12 * HOUR, "hosted", { fetcher, runId: "job_1" })
    const short = await holdPool(user.id, 0.5, MODEL_HOLD_MS, "review", { fetcher })
    const members = (await heldMembers()).map((member) => parseHoldMember(member))
    expect(members.map((member) => member?.purpose).sort()).toEqual(["hosted", "review"])
    expect(members.find((member) => member?.purpose === "hosted")).toMatchObject({ run: "job_1", micro: 1_000_000 })
    expect(members.find((member) => member?.purpose === "review")).toMatchObject({ micro: 500_000 })
    // The shorter hold did not shorten the set's lifetime.
    expect(Number(await redis(["PTTL", `vector:codium:test:held:${HASH}`]))).toBeGreaterThan(12 * HOUR - 60_000)

    // Eleven minutes on, the short hold has lapsed and the 12-hour one has not.
    const later = await holdPool(user.id, 0.25, 60_000, "hosted", { fetcher, clock: () => Date.now() + 700_000 })
    const after = (await heldMembers()).map((member) => parseHoldMember(member)?.ticket)
    expect(after.sort()).toEqual([block.ticket, later.ticket].sort())
    await short.release()
    await block.release()
    await later.release()
    expect(await heldMembers()).toEqual([])
  })

  test("a charge cannot spend what another holds, by the figure a model credential checks too", async () => {
    await seed({ price: 10, limit: 4, usage: 1 })
    const block = await holdPool(user.id, 2.9, HOUR, "hosted", { fetcher })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 0.2)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await expect(holdPool(user.id, 0.2, MODEL_HOLD_MS, "chat", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await block.release()
    const request = await holdPool(user.id, 0.2, MODEL_HOLD_MS, "chat", { fetcher })
    await expect(holdPool(user.id, 2.9, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await request.release()
    // A model credential holds nothing itself: model requests are held by ADMIT (model-plan-admit.ts).
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.2)
    expect(await heldMembers()).toEqual([])
  })

  test("a model reservation, live or abandoned, holds what a pool charge cannot spend until it is settled", async () => {
    await seed({ price: 10, limit: 4, usage: 1 })
    const ledgerKey = `vector:codium:test:model-spend:${HASH}`
    const reservationsKey = `vector:codium:test:model-reservations:${HASH}`
    // A model request reserved 2.5 of the 3 available, recorded as ADMIT records it (model-plan-admit.ts).
    const deadline = Date.now() + MODEL_HOLD_MS
    const ticket = crypto.randomUUID()
    const member = holdMember(ticket, "chat", undefined, 2_500_000)
    const record = {
      account: user.id,
      pool: HASH,
      ticket,
      member,
      purpose: "chat",
      micro: "2500000",
      day: new Date(deadline).toISOString().slice(0, 10),
      epoch: "fixture",
      version: "1",
      deadline: String(deadline),
      admittedAt: String(deadline - MODEL_HOLD_MS),
      periodEnd: String(period().end * 1000),
      runUntil: String(deadline),
      state: "open",
    }
    await redis(["HSET", reservationsKey, ticket, JSON.stringify(record)])
    await redis(["HSET", ledgerKey, "reserved", "2500000"])
    await redis(["HSET", ledgerKey, "openCount", "1"])
    await redis(["ZADD", `vector:codium:test:held:${HASH}`, deadline, member])
    expect(await ledger()).toMatchObject({ heldMicro: 2_500_000, abandonedMicro: 0 })
    await expect(holdPool(user.id, 0.6, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    // Past its deadline the request's outcome is unknown: abandoned, it keeps counting at its full amount.
    const later = () => deadline + 1
    await expect(holdPool(user.id, 0.6, HOUR, "hosted", { fetcher, clock: later })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await (await holdPool(user.id, 0.5, HOUR, "hosted", { fetcher, clock: later })).release()
    // Settled as a cancel (nothing was dispatched), as SETTLE records it: what it held is free again.
    await redis([
      "HSET",
      reservationsKey,
      ticket,
      JSON.stringify({ ...record, state: "done", kind: "cancel", charge: "0", gcAt: String(deadline + 86_400_000) }),
    ])
    await redis(["HSET", ledgerKey, "reserved", "0"])
    await redis(["HSET", ledgerKey, "openCount", "0"])
    await redis(["ZREM", `vector:codium:test:held:${HASH}`, member])
    expect((await holdPool(user.id, 0.6, HOUR, "hosted", { fetcher, clock: later })).micro).toBe(600_000)
  })

  test("a reservation that names the retired Astra group fails the pool closed instead of counting it", async () => {
    await seed({ price: 10, limit: 4, usage: 1 })
    const ledgerKey = `vector:codium:test:model-spend:${HASH}`
    const reservationsKey = `vector:codium:test:model-reservations:${HASH}`
    const deadline = Date.now() + MODEL_HOLD_MS
    const ticket = crypto.randomUUID()
    const member = holdMember(ticket, "chat", undefined, 1_000_000)
    const record = {
      account: user.id,
      pool: HASH,
      ticket,
      member,
      purpose: "chat",
      micro: "1000000",
      day: new Date(deadline).toISOString().slice(0, 10),
      epoch: "fixture",
      version: "1",
      deadline: String(deadline),
      admittedAt: String(deadline - MODEL_HOLD_MS),
      periodEnd: String(period().end * 1000),
      runUntil: String(deadline),
      state: "open",
    }
    await redis(["HSET", reservationsKey, ticket, JSON.stringify(record)])
    await redis(["HSET", ledgerKey, "reserved", "1000000"])
    await redis(["HSET", ledgerKey, "openCount", "1"])
    await redis(["ZADD", `vector:codium:test:held:${HASH}`, deadline, member])
    // As ADMIT writes it today the record reads and counts, so the counters agree with it.
    expect(await ledger()).toMatchObject({ heldMicro: 1_000_000 })
    // Only ADMIT before 30 Oct could add the Astra group. Such a record is malformed now, so nothing is spent past it.
    await redis(["HSET", reservationsKey, ticket, JSON.stringify({ ...record, group: "astra" })])
    await expect(ledger()).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
    await expect(holdPool(user.id, 0.5, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
  })

  test("two settles racing lose no debit, and a replayed settle records nothing new", async () => {
    await seed({ price: 100, limit: 48 })
    const first = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    const second = await holdPool(user.id, 2, HOUR, "hosted", { fetcher })
    const settled = await Promise.all([first.settle(0.75, "block-a"), second.settle(1.25, "block-b")])
    expect(settled).toEqual([
      { recorded: true, applied: true },
      { recorded: true, applied: true },
    ])
    expect(world.keys.get(HASH)?.limit).toBe(46)
    expect(
      (await readDebits(user.id, HASH, fetcher)).map((debit) => [debit.ref, debit.micro, debit.applied]).sort(),
    ).toEqual([
      ["block-a", 750_000, true],
      ["block-b", 1_250_000, true],
    ])
    expect(await heldMembers()).toEqual([])
    expect((await readModelPlanAccount(user.id, fetcher))?.key?.limitMicro).toBe(46_000_000)

    const again = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    expect(await again.settle(0.75, "block-a")).toEqual({ recorded: false, applied: true })
    expect(world.keys.get(HASH)?.limit).toBe(46)
    expect(await heldMembers()).toEqual([])
    expect(await ledger()).toEqual({
      heldMicro: 0,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 2_000_000,
      pendingMicro: 0,
    })
  })

  test("a failed PATCH is retried, and the charge stays held, counted once, until it is applied", async () => {
    await seed({ price: 10, limit: 4, usage: 0.5 })
    const block = await holdPool(user.id, 3, HOUR, "hosted", { fetcher })
    world.failPatches = 1
    expect(await block.settle(2.5, "block-1")).toEqual({ recorded: true, applied: false })
    // The key still says 4, but the charge is held, and every figure counts it exactly once.
    expect(world.keys.get(HASH)?.limit).toBe(4)
    const held = await heldMembers()
    expect(held.map((member) => parseHoldMember(member))).toEqual([
      { ticket: debitHoldTicket("block-1"), purpose: "hosted", run: undefined, micro: 2_500_000 },
    ])
    expect(Number(await redis(["ZSCORE", `vector:codium:test:held:${HASH}`, held[0]!]))).toBeGreaterThan(
      Date.now() + DEBIT_HOLD_MS - 60_000,
    )
    expect(await ledger()).toEqual({
      heldMicro: 2_500_000,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 0,
      pendingMicro: 2_500_000,
    })
    expect((await status()).monthly).toMatchObject({ credits: 4, used: 3, remaining: 1, available: 1 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1.1)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })

    // The outbox's debit-apply runs once the retry is due, and nothing changes in what is available.
    expect(await drainDebitApplies({ fetcher })).toEqual({ applied: 0, retried: 0 })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 1,
      retried: 0,
    })
    expect(world.keys.get(HASH)?.limit).toBe(1.5)
    expect(await heldMembers()).toEqual([])
    expect(await ledger()).toEqual({
      heldMicro: 0,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 2_500_000,
      pendingMicro: 0,
    })
    expect((await status()).monthly).toMatchObject({ credits: 4, used: 3, remaining: 1, available: 1 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1.1)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 0,
      retried: 0,
    })
  })

  test("a retry that fails again waits for the next one, and the debit stays held", async () => {
    await seed({ price: 10, limit: 4 })
    const block = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    world.failPatches = 2
    expect(await block.settle(1, "block-1")).toEqual({ recorded: true, applied: false })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 0,
      retried: 1,
    })
    expect(await ledger()).toEqual({
      heldMicro: 1_000_000,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 0,
      pendingMicro: 1_000_000,
    })
    // Any pass under the lease applies it too: here the account's next provisioning.
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(world.keys.get(HASH)?.limit).toBe(3)
    expect(await ledger()).toEqual({
      heldMicro: 0,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 1_000_000,
      pendingMicro: 0,
    })
    // ...which also took the key off the retry queue.
    expect(await drainDebitApplies({ fetcher, now: Date.now() + 10 * DEBIT_RETRY_MS })).toEqual({
      applied: 0,
      retried: 0,
    })
  })

  test("a settle retried while its debit is pending keeps that debit held, and two settles of one hold count twice", async () => {
    await seed({ price: 10, limit: 4 })
    const block = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    world.failPatches = 2
    expect(await block.settle(1, "block-1")).toEqual({ recorded: true, applied: false })
    // The caller retries the same settle while the key still cannot be updated: nothing new is recorded, and the
    // pending debit is still counted, once, as held.
    expect(await block.settle(1, "block-1")).toEqual({ recorded: false, applied: false })
    expect(await ledger()).toEqual({
      heldMicro: 1_000_000,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 0,
      pendingMicro: 1_000_000,
    })
    expect((await heldMembers()).map((member) => parseHoldMember(member)?.ticket)).toEqual([debitHoldTicket("block-1")])
    expect(await applyPoolDebits(user.id, HASH, fetcher)).toEqual({ applied: 1, pending: 0 })
    expect(world.keys.get(HASH)?.limit).toBe(3)
    expect(await ledger()).toEqual({
      heldMicro: 0,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 1_000_000,
      pendingMicro: 0,
    })

    // Two charges settled on one hold, with the same amount and different refs, are two debits, each held.
    const twice = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    world.failPatches = 2
    expect(await twice.settle(0.5, "block-2")).toEqual({ recorded: true, applied: false })
    expect(await twice.settle(0.5, "block-3")).toEqual({ recorded: true, applied: false })
    expect(await ledger()).toEqual({
      heldMicro: 1_000_000,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 1_000_000,
      pendingMicro: 1_000_000,
    })
    expect(await applyPoolDebits(user.id, HASH, fetcher)).toEqual({ applied: 2, pending: 0 })
    expect(world.keys.get(HASH)?.limit).toBe(2)
    expect(await ledger()).toEqual({
      heldMicro: 0,
      abandonedMicro: 0,
      committedMicro: 0,
      appliedMicro: 2_000_000,
      pendingMicro: 0,
    })
    expect(debitHoldTicket("block-2")).not.toBe(debitHoldTicket("block-3"))
  })

  test("a debit on a key the account replaced is applied without touching that key", async () => {
    await seed({ price: 10, limit: 4 })
    const old = "hash_replaced"
    await redis([
      "HSET",
      `vector:codium:test:debits:${user.id}:${old}`,
      "block-old",
      JSON.stringify({
        micro: 250_000,
        applied: false,
        hold: "t-old:hosted:-:250000",
        purpose: "hosted",
        at: Date.now(),
      }),
    ])
    await redis(["ZADD", `vector:codium:test:held:${old}`, Date.now() + HOUR, "t-old:hosted:-:250000"])
    expect(await applyPoolDebits(user.id, old, fetcher)).toEqual({ applied: 1, pending: 0 })
    expect(world.openRouter).toEqual([])
    expect(await readDebits(user.id, old, fetcher)).toMatchObject([{ ref: "block-old", applied: true }])
    expect(await redis(["ZRANGE", `vector:codium:test:held:${old}`, 0, -1])).toEqual([])
  })

  test("a pool hold names a known purpose, a valid run and a bounded lifetime", async () => {
    await seed({ price: 100, limit: 48 })
    const refused = [
      holdPool(user.id, 1, 3 * 86_400_000, "hosted", { fetcher }),
      holdPool(user.id, 1, HOUR, "mining" as never, { fetcher }),
      holdPool(user.id, 1, HOUR, "hosted", { fetcher, runId: "a b" }),
      holdPool(user.id, 0, HOUR, "hosted", { fetcher }),
    ]
    for (const hold of refused) await expect(hold).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    const block = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    await expect(block.settle(-1, "block-1")).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    await expect(block.settle(1, "has space")).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    await block.release()
    expect(await heldMembers()).toEqual([])
  })
})

// ── M3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M3: available is the same figure everywhere", () => {
  test("hosted spend lowers status left and refuses a model hold, on the fast path and under the lease alike", async () => {
    await seed({ price: 10, limit: 4, usage: 1 })
    expect((await status()).balance.plan).toMatchObject({ left: 0.75 })
    expect((await status()).monthly).toMatchObject({ shareUsed: 0.25, available: 3 })

    // A running block holds, which does not move the share, but a model request cannot spend it.
    const block = await holdPool(user.id, 2.5, HOUR, "hosted", { fetcher })
    expect((await status()).balance.plan).toMatchObject({ left: 0.75 })
    expect((await status()).monthly).toMatchObject({ available: 0.5 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })

    // Its charge is spend: the share left drops, and so does what a request may hold.
    expect(await block.settle(2, "block-1")).toEqual({ recorded: true, applied: true })
    expect(world.keys.get(HASH)?.limit).toBe(2)
    const after = await status()
    expect(after.balance.plan).toMatchObject({ left: 0.25 })
    expect(after.monthly).toMatchObject({ credits: 4, used: 3, remaining: 1, available: 1, shareUsed: 0.75 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1.5)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.9)

    // Under the lease (the key's limit had drifted back up), the answer is the same and the key is set right again.
    world.keys.get(HASH)!.limit = 4
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1.5)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    expect(world.keys.get(HASH)?.limit).toBe(2)
    world.keys.get(HASH)!.limit = 4
    await modelPlanCredential(user.id, fetcher, Date.now(), 0.9)
    expect(world.keys.get(HASH)?.limit).toBe(2)
    expect(await heldMembers()).toEqual([])
  })

  test("a committed model floor counts while provider usage lags, in status, holds and credentials alike", async () => {
    // 2.5 of model charges settled durably; the provider still reports only 1.
    await seed({ price: 10, limit: 4, usage: 1, committed: 2_500_000 })
    expect((await status()).monthly).toMatchObject({ credits: 4, used: 2.5, remaining: 1.5, available: 1.5 })
    await expect(holdPool(user.id, 1.6, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 1.6)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    const hold = await holdPool(user.id, 1.5, HOUR, "hosted", { fetcher })
    // Once usage catches up the figure is the same, not double: model spend is max(usage, committed).
    world.keys.get(HASH)!.usage = 2.5
    expect((await status()).monthly).toMatchObject({ used: 2.5, remaining: 1.5, available: 0 })
    // The hold takes all that is left, so no request can be admitted: status says empty although 38% is unspent.
    expect((await status()).balance).toMatchObject({ plan: { left: 0.38 }, empty: true, low: false })
    await hold.release()
    world.keys.get(HASH)!.usage = 3
    expect((await status()).monthly).toMatchObject({ used: 3, remaining: 1, available: 1 })
    expect((await status()).balance).toMatchObject({ plan: { left: 0.25 }, empty: false, low: false })
    // The provider key's limit is never lowered by the floor (M1).
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(patches()).toEqual([])
  })
})

describe("A17: the common hold's fence", () => {
  const accountKey = `vector:codium:test:account:${user.id}`
  const snapshotKey = `vector:codium:test:ent:${user.id}`

  test("a hold observed before a billing write to the private record is refused, and retried once read again", async () => {
    await seed({ price: 100, limit: 48 })
    let paused = () => {}
    let release = () => {}
    const reached = new Promise<void>((resolve) => (paused = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    // The HOLD is delayed after its credential read, while another writer changes the record (here: a transition
    // barrier, as a key replacement saves before reading any source balance).
    const delayed = (async (input, init) => {
      const body = init?.body === undefined ? "" : String(init.body)
      if (body.startsWith('["EVAL"') && body.includes("model_pool_fence") && body.includes('\\"required\\"')) {
        paused()
        await gate
      }
      return fetcher(input, init)
    }) as typeof fetch
    const held = holdPool(user.id, 1, HOUR, "hosted", { fetcher: delayed }).catch((error: unknown) => error)
    await reached
    const saved = JSON.parse(String(await redis(["GET", accountKey])))
    await redis([
      "SET",
      accountKey,
      JSON.stringify({ ...saved, transition: { subscription: "sub_next", start: 1, at: Date.now() } }),
    ])
    release()
    expect(await held).toMatchObject({ statusCode: 503, code: "MODEL_PLAN_RENEWING", retryAfterSeconds: 1 })
    expect(await heldMembers()).toEqual([])
    // While the barrier stands every new hold is refused the same retryable way, before any provider read. (Here
    // another request already holds this minute's on-demand reconcile, as the replacement's own reconcile would.)
    world.openRouter.length = 0
    await redis(["SET", `vector:codium:test:reconcile:${user.id}`, "taken", "PX", 60_000])
    await expect(holdPool(user.id, 1, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_RENEWING",
    })
    expect(world.openRouter).toEqual([])
    await redis(["SET", accountKey, JSON.stringify(saved)])
    expect((await holdPool(user.id, 1, HOUR, "hosted", { fetcher })).micro).toBe(1_000_000)
  })

  test("a hold landing after its period, snapshot or ledger moved on is refused before any write", async () => {
    await seed({ price: 100, limit: 48 })
    const snapshot = JSON.parse(String(await redis(["GET", snapshotKey])))
    const ledgerKey = `vector:codium:test:model-spend:${HASH}`
    // Each change lands between the credential read and the HOLD, as a concurrent reconcile or corruption would.
    const race = async (change: () => Promise<unknown>) => {
      let paused = () => {}
      let release = () => {}
      const reached = new Promise<void>((resolve) => (paused = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      const delayed = (async (input, init) => {
        const body = init?.body === undefined ? "" : String(init.body)
        if (body.startsWith('["EVAL"') && body.includes('\\"required\\"')) {
          paused()
          await gate
        }
        return fetcher(input, init)
      }) as typeof fetch
      const held = holdPool(user.id, 1, HOUR, "hosted", { fetcher: delayed }).catch((error: unknown) => error)
      await reached
      await change()
      release()
      return held
    }
    const restore = async () => {
      await redis(["SET", snapshotKey, JSON.stringify(snapshot)])
      for (const [field, value] of readyGenesisFields({
        account: user.id,
        pool: HASH,
        subscription: "sub_pool",
        start: snapshot.periodStart / 1000,
        end: snapshot.periodEnd / 1000,
        nonce: "seed-genesis",
      }))
        await redis(["HSET", ledgerKey, field, value])
    }
    for (const state of ["paused", "frozen", "ended"]) {
      expect(
        await race(() =>
          redis(["SET", snapshotKey, JSON.stringify({ ...snapshot, state, version: snapshot.version + 1 })]),
        ),
      ).toMatchObject({ code: "MODEL_PLAN_RENEWING" })
      await restore()
    }
    expect(
      await race(() =>
        redis([
          "SET",
          snapshotKey,
          JSON.stringify({ ...snapshot, subscription: "sub_next", meterEpoch: "sub_next:1" }),
        ]),
      ),
    ).toMatchObject({ code: "MODEL_PLAN_RENEWING" })
    await restore()
    expect(await race(() => redis(["DEL", snapshotKey]))).toMatchObject({ code: "MODEL_PLAN_RENEWING" })
    await restore()
    // A ledger that no longer proves this key's genesis, or that cannot be read, is final.
    const foreign = JSON.parse(
      readyGenesisFields({
        account: user.id,
        pool: HASH,
        subscription: "sub_pool",
        start: 1,
        end: 2,
        nonce: "other",
      })[0][1],
    )
    expect(
      await race(() =>
        redis([
          "HSET",
          ledgerKey,
          "genesis",
          JSON.stringify({ ...foreign, start: snapshot.periodStart / 1000, end: snapshot.periodEnd / 1000 }),
        ]),
      ),
    ).toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
    await restore()
    expect(await race(() => redis(["HSET", ledgerKey, "committed", "1.5"]))).toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
    expect(await heldMembers()).toEqual([])
  })

  test("a renewing snapshot holds through its grace and never past it; an active one stops at its period's end (M11)", async () => {
    await seed({ price: 100, limit: 48 })
    const stored = JSON.parse(String(await redis(["GET", snapshotKey])))
    const end: number = stored.periodEnd
    const grace = renewalGraceMinutes() * 60_000
    let at = 0
    const hold = (snapshot: typeof stored, from: number, fetch = fetcher) => {
      at = from
      return holdPool(user.id, 1, HOUR, "hosted", { fetcher: fetch, clock: () => at, snapshot })
    }
    // The credential's provider read lasts until `after`, so the HOLD is placed then: the fence decides at that time.
    const late = (snapshot: typeof stored, from: number, after: number) =>
      hold(snapshot, from, (async (input, init) => {
        if (String(input).startsWith("https://openrouter.ai")) at = after
        return fetcher(input, init)
      }) as typeof fetch).catch((error: unknown) => error)
    await (await hold(stored, end - 1)).release()
    expect(await late(stored, end - 1, end)).toMatchObject({ code: "MODEL_PLAN_RENEWING" })
    // Reconcile says renewing while the renewal is collected: the period's key keeps serving through the grace.
    const renewing = { ...stored, state: "renewing", version: stored.version + 1 }
    await redis(["SET", snapshotKey, JSON.stringify(renewing)])
    for (const offset of [0, 30 * 60_000, grace - 1]) await (await hold(renewing, end + offset)).release()
    // A hold priced inside the grace that lands at its end is refused by the fence; one asked past it never reaches a
    // credential.
    expect(await late(renewing, end + grace - 1, end + grace)).toMatchObject({ code: "MODEL_PLAN_RENEWING" })
    expect(await hold(renewing, end + grace).catch((error: unknown) => error)).toMatchObject({
      code: "MODEL_PLAN_RENEWING",
    })
    expect(await heldMembers()).toEqual([])
  })

  test("a key without a trusted genesis fails closed and is never given a fresh zero", async () => {
    await seed({ price: 100, limit: 48, legacy: true })
    await expect(holdPool(user.id, 1, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
    await expect(readPoolLedger(user.id, HASH, Date.now(), fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
    expect(await redis(["GET", `vector:codium:test:model-spend:${HASH}`])).toBeNull()
  })

  test("a hold reads its snapshot by the entitlement rules: a missing one is reconciled, not a final 402", async () => {
    await seed({ price: 100, limit: 48 })
    // Right after checkout (before the webhook's reconcile wrote it), after a store flush, or unreadable: no snapshot.
    await redis(["DEL", snapshotKey])
    const hold = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    expect(hold.micro).toBe(1_000_000)
    expect(world.stripe).toBeGreaterThan(0)
    expect(JSON.parse(String(await redis(["GET", snapshotKey])))).toMatchObject({ state: "active" })
    await hold.release()
    // A fresh stored snapshot is used as it is: no further Stripe read (M4).
    const reads = world.stripe
    await (await holdPool(user.id, 1, HOUR, "hosted", { fetcher })).release()
    expect(world.stripe).toBe(reads)
  })

  test("a hold's lifetime starts after its credential reads, not when it was asked for", async () => {
    await seed({ price: 100, limit: 48 })
    let at = Date.now()
    // Every store or provider call takes a simulated 40 seconds.
    const slow = (async (input, init) => {
      at += 40_000
      return fetcher(input, init)
    }) as typeof fetch
    const asked = at
    const hold = await holdPool(user.id, 1, 60_000, "hosted", { fetcher: slow, clock: () => at })
    const score = Number(await redis(["ZSCORE", `vector:codium:test:held:${HASH}`, (await heldMembers())[0]!]))
    expect(score).toBeGreaterThan(asked + 60_000)
    expect(hold.expiresAt).toBe(score)
    await hold.release()
  })
})

describe("A51 obligation: nonmodel producers", () => {
  // The common HOLD enforces the month and the run's pool binding only. Any producer that starts calling holdPool
  // (hosted blocks, WP A51 and later) must first enforce the shared day, Brain and run caps atomically, keep its run
  // binding as long as it runs, hold its worst case (a charge settled above its hold is charged to the pool it was
  // placed on, or, after an upgrade, to the successor as a carry shortfall) and settle within the carry true-up's retry
  // window. This tripwire fails when a production module calls holdPool, or reaches the same HOLD through placeHold
  // or the script itself, so that obligation is reviewed, not lost.
  test("no production module places a pool hold until its producer is reviewed against the shared caps", async () => {
    // The only reviewed call is holdPool's own HOLD. Adding a producer here is that producer's review.
    const reviewed = ["_lib/model-plan-account.ts: placeHold("]
    const root = new URL("../api/", import.meta.url).pathname
    const calls: string[] = []
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root }))
      for (const match of (await Bun.file(root + file).text()).matchAll(
        /(?<!function )\b(?:holdPool|placeHold)\(|\bPOOL_SCRIPTS\.HOLD\b/g,
      ))
        calls.push(`${file}: ${match[0]}`)
    expect(calls.sort()).toEqual(reviewed)
  })
})
