import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { randomBytes, randomInt, randomUUID } from "node:crypto"
import { GithubAgents } from "@vectordevai/core/github-agents"
import type { CloudAgentAllowance, RunSource } from "../../../api/_lib/cloud-agents-entitlement"
import {
  cloudAgentSecondsUsed,
  cloudAgentsGatewayHook,
  liveKey,
  liveRun,
  recordCodiumRequest,
  releaseRun,
  reportRun,
  reserveRun,
  settleRun,
  usedKey,
  type LiveRun,
  type ReserveInput,
  type ReserveResult,
} from "../../../api/_lib/cloud-agents-ledger"

// Hours, slots and scheduled runs (vector-at-mention-spec 2.6 and 2.7, V06), against a real Redis or Valkey behind an
// in-process fake of the store's REST endpoint. CI runs this file in one Bun process with the other web GitHub tests
// against one Valkey, so it never flushes: every test uses fresh accounts, and afterAll deletes every key it touched.

const PREFIX = "vector:cloud-agents:"
const SECOND = 1000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
// 2026-10-14T09:30:00Z and 2026-11-14T09:30:00Z: the period the fixtures' allowance belongs to, in milliseconds.
const START = 1_791_970_200_000
const END = 1_794_648_600_000
const EPOCH = `p${START}`
// 2026-10-26T08:53:20Z. Every `now` is the ledger's own clock; the store's expiries are durations from it.
const T = 1_793_000_000_000
const TOKEN = "cloud-agents-ledger-fixture"
const SCHEDULE = { source: "github-schedule", purpose: "scheduled", thread: "schedule-0a1b2c3d" } as const

type Granted = Extract<CloudAgentAllowance, { active: true }>

// The plans' rows of contract 1.1, typed in as literals: this file never reads the entitlement module's table.
const PLANS = {
  plus: { plan: "vector-10", atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, premiumModels: false },
  pro: { plan: "vector-50", atOnce: 1, hours: 15, longestRunMin: 45, scheduledPerDay: 0, premiumModels: false },
  max: { plan: "vector-100", atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, premiumModels: true },
  ultra: { plan: "vector-200", atOnce: 6, hours: 120, longestRunMin: 120, scheduledPerDay: 20, premiumModels: true },
} as const

// Codium's shapes at origin/codium 99fcf1c0 (api/_lib/model-plan-caller.ts, model-plan-gateway-hooks.ts and
// codium-pool.ts), which A59 registers the hook against. The snapshot and the model stand in for Codium's types: the
// hook never reads them.
type PoolPurpose =
  | "chat"
  | "title"
  | "brain"
  | "review"
  | "judge"
  | "race"
  | "playbook"
  | "task"
  | "cloud-agents"
  | "hosted"
type ModelPlanCaller = {
  account: { id: string }
  kind: "desktop" | "cli" | "run"
  purpose: PoolPurpose
  run?: {
    id: string
    source: RunSource
    deadline: number
    ceilingShare?: number
    service: "cloud-agents" | "hosted"
    sessionId?: string
  }
}
type AfterSettleContext = {
  snapshot: { v: 1; account: string }
  model: { id: string }
  charge?: number
  startedAt: number
  endedAt: number
  streamed: boolean
}
type GatewayHook = {
  id: string
  beforeAdmit?(caller: ModelPlanCaller, context: { toolNames: readonly string[] }): Promise<void>
  afterSettle?(caller: ModelPlanCaller, context: AfterSettleContext): Promise<void>
}

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  // V06's done-criterion is this file passing against a loopback Redis, so a missing one fails instead of skipping.
  if (!configured) {
    test("ledger tests need VECTOR_TEST_REDIS_URL, a disposable loopback Redis or Valkey", () => {
      throw new Error("Set VECTOR_TEST_REDIS_URL=redis://127.0.0.1:<port> (contract 0.3).")
    })
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Ledger tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const state: { down: boolean; corrupt: boolean; gate?: { size: number; held: (() => void)[] } } = {
    down: false,
    corrupt: false,
  }
  const commands: string[][] = []
  const keys = new Set<string>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 })
      const command = ((await request.json()) as unknown[]).map(String)
      commands.push(command)
      if (state.down) return new Response(null, { status: 503 })
      if (state.corrupt) return Response.json({ result: { unexpected: true } })
      await gate()
      for (const key of command[0] === "EVAL" ? command.slice(3, 3 + Number(command[2])) : [command[1]]) keys.add(key)
      return redis.send(command[0], command.slice(1)).then(
        (result) => Response.json({ result }),
        (error: unknown) => Response.json({ error: String(error) }, { status: 400 }),
      )
    },
  })
  const environment = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

  // Holds the first `size` requests to arrive until all of them have, then lets them go together, so parallel calls
  // reach the store at once. A reserve split into a read and a later write would then let every read see a free slot.
  function gate() {
    const current = state.gate
    if (!current) return
    return new Promise<void>((resolve) => {
      current.held.push(resolve)
      if (current.held.length < current.size) return
      state.gate = undefined
      current.held.forEach((release) => release())
    })
  }

  beforeAll(async () => {
    await redis.connect()
    expect(await redis.send("PING", [])).toBe("PONG")
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    Object.assign(process.env, { KV_REST_API_URL: upstream.url.origin, KV_REST_API_TOKEN: TOKEN })
  })
  beforeEach(() => {
    state.down = false
    state.corrupt = false
    state.gate = undefined
    commands.length = 0
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  function allowance(name: keyof typeof PLANS, overrides: Partial<Granted> = {}): Granted {
    const plan = PLANS[name]
    return {
      active: true,
      plan: plan.plan,
      limits: {
        atOnce: plan.atOnce,
        hours: plan.hours,
        longestRunMin: plan.longestRunMin,
        scheduledPerDay: plan.scheduledPerDay,
        runCeilingShare: 0.1,
      },
      allowanceSeconds: plan.hours * 3600,
      meterEpoch: EPOCH,
      periodEnd: END,
      premiumModels: plan.premiumModels,
      ...overrides,
    }
  }

  function jti() {
    return randomBytes(16).toString("base64url")
  }

  // A mint's reservation for a fresh check run of a fresh repository.
  function mint(account: string, granted: Granted, now: number, overrides: Partial<ReserveInput> = {}): ReserveInput {
    const repositoryId = String(randomInt(100_000_000, 1_000_000_000))
    return {
      account,
      rid: GithubAgents.runId(repositoryId, randomInt(1, 2 ** 40), 1, randomInt(1, 2 ** 40)),
      repositoryId,
      thread: String(randomInt(1, 100_000)),
      generation: 1,
      jti: jti(),
      source: "github-comment",
      purpose: "task",
      allowance: granted,
      now,
      ...overrides,
    }
  }

  // What the run token signs (2.4): the jti and the epoch the reservation answered.
  function token(input: ReserveInput) {
    return { jti: input.jti, epoch: input.allowance.meterEpoch }
  }

  function reserved(result: ReserveResult) {
    if (!result.ok) throw new Error(`The reservation was refused: ${JSON.stringify(result)}`)
    return result
  }

  async function reserve(input: ReserveInput) {
    return reserved(await reserveRun(input))
  }

  // Writes made by the test itself, outside the fake store.
  async function write(command: string, key: string, args: string[]) {
    keys.add(key)
    await redis.send(command, [key, ...args])
  }

  async function ticket() {
    const key = `${PREFIX}ticket:${randomBytes(32).toString("hex")}`
    await write("SET", key, [JSON.stringify({ fixture: true }), "EX", "900"])
    return key
  }

  async function stored(account: string, rid: string) {
    const raw = await redis.send("HGET", [liveKey(account), rid])
    return typeof raw === "string" ? JSON.parse(raw) : raw
  }

  async function runs(account: string) {
    return (await redis.send("HGETALL", [liveKey(account)])) as Record<string, string>
  }

  async function used(account: string, epoch = EPOCH) {
    return redis.send("GET", [usedKey(account, epoch)])
  }

  function scheduledKey(account: string, day: string) {
    return `${PREFIX}sched:${account}:${day}`
  }

  async function exists(key: string) {
    return redis.send("EXISTS", [key])
  }

  // A duration from the ledger's clock, read back a few milliseconds of real time later.
  async function expectExpiry(key: string, expected: number) {
    const left = (await redis.send("PTTL", [key])) as number
    expect(left).toBeLessThanOrEqual(expected)
    expect(left).toBeGreaterThan(expected - 10 * SECOND)
  }

  // Everything the ledger keeps for an account, to show a call changed nothing.
  async function everything(account: string, days: string[] = []) {
    return {
      live: await runs(account),
      used: await used(account),
      scheduled: await Promise.all(days.map((day) => redis.send("GET", [scheduledKey(account, day)]))),
    }
  }

  function settledContext(endedAt: number, account: string): AfterSettleContext {
    return {
      snapshot: { v: 1, account },
      model: { id: "fixture" },
      startedAt: endedAt - SECOND,
      endedAt,
      streamed: false,
    }
  }

  const INVALID_REQUEST = { statusCode: 400, code: "INVALID_REQUEST" }
  const STORE_UNAVAILABLE = { statusCode: 503, code: "PERSISTENT_STORE_UNAVAILABLE" }

  describe("reserve", () => {
    test("a fresh reserve is one EVAL that writes exactly the live record and charges its reservation up front", async () => {
      const account = randomUUID()
      const input = mint(account, allowance("max"), T)
      expect(await reserveRun(input)).toStrictEqual({
        ok: true,
        renewed: false,
        startedAt: T,
        deadline: T + 45 * MINUTE,
        epoch: EPOCH,
        thread: input.thread,
        source: "github-comment",
        purpose: "task",
      })
      expect(commands).toHaveLength(1)
      expect(commands[0]?.[0]).toBe("EVAL")
      expect(commands[0]?.slice(2, 7)).toEqual([
        "4",
        liveKey(account),
        usedKey(account, EPOCH),
        scheduledKey(account, "2026-10-26"),
        `vector:cli-revoked:${account}`,
      ])
      const record: LiveRun = {
        startedAt: T,
        deadline: T + 45 * MINUTE,
        lastReport: T,
        epoch: EPOCH,
        repo: input.repositoryId,
        thr: input.thread,
        src: "github-comment",
        pur: "task",
        gen: 1,
        jti: input.jti,
      }
      expect(await stored(account, input.rid)).toStrictEqual(record)
      expect(await liveRun(account, input.rid)).toStrictEqual(record)
      expect(Object.keys(await runs(account))).toEqual([input.rid])
      // The whole reservation is charged now; a settle gives back what the run did not use.
      expect(await used(account)).toBe("2700")
      expect(await cloudAgentSecondsUsed(account, EPOCH, T)).toBe(0)
      // Agent time is kept until the period's end plus 40 days, and the live record at least as long.
      await expectExpiry(liveKey(account), END - T + 40 * DAY)
      await expectExpiry(usedKey(account, EPOCH), END - T + 40 * DAY)
      expect(await exists(scheduledKey(account, "2026-10-26"))).toBe(0)
    })

    test("agent time whose period has already ended is kept for 40 days from now, never deleted", async () => {
      const account = randomUUID()
      await reserve(mint(account, allowance("plus", { periodEnd: T - 3 * DAY }), T))
      expect(await used(account)).toBe("1800")
      await expectExpiry(usedKey(account, EPOCH), 40 * DAY)
    })

    test("parallel reservations respect atOnce", async () => {
      for (const [name, expected] of [
        ["plus", 1],
        ["max", 2],
        ["ultra", 6],
      ] as const) {
        const account = randomUUID()
        const granted = allowance(name)
        state.gate = { size: 20, held: [] }
        const results = await Promise.all(
          Array.from({ length: 20 }, () => mint(account, granted, T)).map((input) => reserveRun(input)),
        )
        expect({ name, granted: results.filter((result) => result.ok).length }).toEqual({ name, granted: expected })
        expect(results.filter((result) => !result.ok)).toStrictEqual(
          Array.from({ length: 20 - expected }, () => ({ ok: false, limit: "at-once" })),
        )
        expect(Object.keys(await runs(account))).toHaveLength(expected)
        expect(await used(account)).toBe(String(expected * granted.limits.longestRunMin * 60))
      }
    })

    test("parallel mints from one check run reserve it once and renew it for the rest", async () => {
      for (const extra of [{}, SCHEDULE]) {
        const account = randomUUID()
        const first = mint(account, allowance("max"), T, extra)
        const inputs = Array.from({ length: 8 }, (_, index) => (index ? { ...first, jti: jti() } : first))
        state.gate = { size: 8, held: [] }
        const results = (await Promise.all(inputs.map((input) => reserveRun(input)))).map(reserved)
        expect(results.filter((result) => !result.renewed)).toHaveLength(1)
        expect(new Set(results.map((result) => [result.startedAt, result.deadline].join(" ")))).toEqual(
          new Set([`${T} ${T + 45 * MINUTE}`]),
        )
        const live = await runs(account)
        expect(Object.keys(live)).toEqual([first.rid])
        expect(inputs.map((input) => input.jti)).toContain(JSON.parse(String(live[first.rid])).jti)
        expect(await used(account)).toBe("2700")
        expect(await redis.send("GET", [scheduledKey(account, "2026-10-26")])).toBe(extra === SCHEDULE ? "1" : null)
      }
    })

    test("minting again from the same check run keeps its deadline", async () => {
      const account = randomUUID()
      // Two runs fill both slots and leave 299 s of hours.
      const granted = allowance("max", { allowanceSeconds: 2 * 2700 + 299 })
      const first = mint(account, granted, T)
      await reserve(first)
      await reserve(mint(account, granted, T))
      expect(await reserveRun(mint(account, granted, T + MINUTE))).toStrictEqual({ ok: false, limit: "at-once" })
      await reportRun(account, first.rid, first, T + 5 * MINUTE)
      const consumeKey = await ticket()
      // A patched mint body cannot move the thread or the purpose the run was reserved with.
      const again = { ...first, jti: jti(), thread: "77", purpose: "review" as const, consumeKey, now: T + 9 * MINUTE }
      commands.length = 0
      expect(await reserveRun(again)).toStrictEqual({
        ok: true,
        renewed: true,
        startedAt: T,
        deadline: T + 45 * MINUTE,
        epoch: EPOCH,
        thread: first.thread,
        source: "github-comment",
        purpose: "task",
      })
      expect(commands).toHaveLength(1)
      // Only the jti changed: the start, the deadline and the last heartbeat stay, and nothing more is charged.
      expect(await stored(account, first.rid)).toStrictEqual({
        startedAt: T,
        deadline: T + 45 * MINUTE,
        lastReport: T + 5 * MINUTE,
        epoch: EPOCH,
        repo: first.repositoryId,
        thr: first.thread,
        src: "github-comment",
        pur: "task",
        gen: 1,
        jti: again.jti,
      })
      expect(await used(account)).toBe("5400")
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 9 * MINUTE)).toBe(0)
      expect(await exists(consumeKey)).toBe(0)
      // The replaced token holds nothing any more; the new one holds the run.
      expect(await reportRun(account, first.rid, first, T + 10 * MINUTE)).toStrictEqual({ live: false })
      expect(await settleRun(account, first.rid, token(first))).toStrictEqual({
        settled: false,
        seconds: 0,
      })
      expect(await reportRun(account, first.rid, again, T + 10 * MINUTE)).toStrictEqual({
        live: true,
        deadline: T + 45 * MINUTE,
      })

      // A renewal is not a scheduled run of its own, even with today's count at the cap.
      const other = randomUUID()
      const scheduled = mint(other, allowance("max"), T, SCHEDULE)
      await reserve(scheduled)
      await write("SET", scheduledKey(other, "2026-10-26"), ["5"])
      expect((await reserveRun({ ...scheduled, jti: jti(), now: T + MINUTE })).ok).toBe(true)
      expect(await redis.send("GET", [scheduledKey(other, "2026-10-26")])).toBe("5")
    })

    test("a generation change settles the old run and reserves fresh; an older generation cannot take it back", async () => {
      const account = randomUUID()
      const old = mint(account, allowance("max"), T)
      await reserve(old)
      await reportRun(account, old.rid, old, T + 10 * MINUTE)
      const rebound = { ...old, generation: 2, jti: jti(), now: T + 12 * MINUTE }
      expect(await reserveRun(rebound)).toStrictEqual({
        ok: true,
        renewed: false,
        startedAt: T + 12 * MINUTE,
        deadline: T + 57 * MINUTE,
        epoch: EPOCH,
        thread: old.thread,
        source: "github-comment",
        purpose: "task",
      })
      expect(await used(account)).toBe(String(600 + 2700))
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 12 * MINUTE)).toBe(600)
      expect(await reserveRun({ ...old, jti: jti(), now: T + 13 * MINUTE })).toStrictEqual({
        ok: false,
        limit: "at-once",
      })
      expect(await liveRun(account, old.rid)).toMatchObject({ gen: 2, jti: rebound.jti, startedAt: T + 12 * MINUTE })
      expect(await used(account)).toBe("3300")
    })

    test("deadline formula and the 5-minute floor", async () => {
      // Another live run's reservation is subtracted: 299 s left is refused, 300 s is a 300-s run.
      for (const [extra, expected] of [
        [299, { ok: false, limit: "hours" }],
        [300, { ok: true, deadline: T + SECOND + 300 * SECOND }],
      ] as const) {
        const account = randomUUID()
        const granted = allowance("max", { allowanceSeconds: 2700 + extra })
        await reserve(mint(account, granted, T))
        expect(await reserveRun(mint(account, granted, T + SECOND))).toMatchObject(expected)
      }
      // Settled time is subtracted.
      for (const [extra, expected] of [
        [299, { ok: false, limit: "hours" }],
        [300, { ok: true, deadline: T + 3 * MINUTE + 300 * SECOND }],
      ] as const) {
        const account = randomUUID()
        const granted = allowance("plus", { allowanceSeconds: 100 + extra })
        const first = mint(account, granted, T)
        await reserve(first)
        await reportRun(account, first.rid, first, T + 100 * SECOND)
        await settleRun(account, first.rid, token(first))
        expect(await reserveRun(mint(account, granted, T + 3 * MINUTE))).toMatchObject(expected)
      }
      // So is a live run of another epoch: the contract's sum runs over every live run.
      for (const [extra, expected] of [
        [299, { ok: false, limit: "hours" }],
        [300, { ok: true, deadline: T + SECOND + 300 * SECOND }],
      ] as const) {
        const account = randomUUID()
        await reserve(mint(account, allowance("max", { meterEpoch: "p1" }), T))
        const granted = allowance("max", { allowanceSeconds: 2700 + extra })
        expect(await reserveRun(mint(account, granted, T + SECOND))).toMatchObject(expected)
      }
      // With plenty left, the longest run decides; with no allowance, nothing runs.
      expect((await reserve(mint(randomUUID(), allowance("ultra"), T))).deadline).toBe(T + 120 * MINUTE)
      expect(await reserveRun(mint(randomUUID(), allowance("pro", { allowanceSeconds: 0 }), T))).toStrictEqual({
        ok: false,
        limit: "hours",
      })
    })

    test("consumeKey is deleted only when the reservation succeeds", async () => {
      const account = randomUUID()
      const granted = allowance("plus")
      await reserve(mint(account, granted, T))
      const consumeKey = await ticket()
      const refusals = [
        mint(account, granted, T, { consumeKey }),
        mint(randomUUID(), allowance("plus", { allowanceSeconds: 299 }), T, { consumeKey }),
        mint(randomUUID(), granted, T, { ...SCHEDULE, consumeKey }),
      ]
      expect(await Promise.all(refusals.map((input) => reserveRun(input)))).toStrictEqual([
        { ok: false, limit: "at-once" },
        { ok: false, limit: "hours" },
        { ok: false, limit: "scheduled" },
      ])
      expect(await exists(consumeKey)).toBe(1)
      const fresh = mint(randomUUID(), granted, T, { consumeKey })
      commands.length = 0
      await reserve(fresh)
      expect(commands[0]?.slice(2, 8)).toEqual([
        "5",
        liveKey(fresh.account),
        usedKey(fresh.account, EPOCH),
        scheduledKey(fresh.account, "2026-10-26"),
        `vector:cli-revoked:${fresh.account}`,
        consumeKey,
      ])
      expect(await exists(consumeKey)).toBe(0)
      // A renewal consumes the ticket it is given too.
      const second = await ticket()
      expect((await reserve({ ...fresh, jti: jti(), consumeKey: second, now: T + MINUTE })).renewed).toBe(true)
      expect(await exists(second)).toBe(0)
    })

    test("a ticket starts one run: parallel mints from different check runs that peeked it reserve once", async () => {
      // Ultra's six slots, so only the ticket decides.
      const account = randomUUID()
      const granted = allowance("ultra")
      const consumeKey = await ticket()
      const dispatch = { source: "github-dispatch", purpose: "task", thread: "dispatch-17", consumeKey } as const
      const inputs = Array.from({ length: 6 }, () => mint(account, granted, T, dispatch))
      state.gate = { size: 6, held: [] }
      const results = await Promise.all(inputs.map((input) => reserveRun(input)))
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toStrictEqual(
        Array.from({ length: 5 }, () => ({ ok: false, refusal: "ticket" })),
      )
      expect(Object.keys(await runs(account))).toHaveLength(1)
      expect(await used(account)).toBe(String(120 * 60))
      expect(await exists(consumeKey)).toBe(0)
      // The check run that consumed it renews without it.
      const holder = inputs[results.findIndex((result) => result.ok)]
      if (!holder) throw new Error("No mint reserved the run")
      expect(await reserveRun({ ...holder, jti: jti(), now: T + MINUTE })).toMatchObject({ ok: true, renewed: true })

      // Parallel mints of one check run that carry the ticket reserve once and renew for the rest.
      const one = randomUUID()
      const second = await ticket()
      const first = mint(one, granted, T, { ...dispatch, consumeKey: second })
      state.gate = { size: 8, held: [] }
      const renewals = await Promise.all(
        Array.from({ length: 8 }, (_, index) => reserveRun(index ? { ...first, jti: jti() } : first)),
      )
      expect(renewals.map((result) => result.ok && result.renewed).sort()).toEqual([
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ])
      expect(await exists(second)).toBe(0)

      // A ticket that is gone (consumed, expired or never stored) starts nothing and writes nothing, and is answered
      // before the slots, which a retry could free but the ticket cannot come back.
      const full = randomUUID()
      const plus = allowance("plus")
      await reserve(mint(full, plus, T))
      const before = await everything(full, ["2026-10-26"])
      for (const gone of [consumeKey, `${PREFIX}ticket:${randomBytes(32).toString("hex")}`]) {
        expect(await reserveRun(mint(full, plus, T + MINUTE, { ...dispatch, consumeKey: gone }))).toStrictEqual({
          ok: false,
          refusal: "ticket",
        })
        expect(await reserveRun(mint(randomUUID(), plus, T, { ...dispatch, consumeKey: gone }))).toStrictEqual({
          ok: false,
          refusal: "ticket",
        })
      }
      expect(await everything(full, ["2026-10-26"])).toStrictEqual(before)
    })

    test("a re-mint at or after the deadline is refused and leaves the token that still settles the run alone", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      await reserve(run)
      await reportRun(account, run.rid, run, T + 44 * MINUTE)
      const consumeKey = await ticket()
      const before = await everything(account)
      for (const now of [T + 45 * MINUTE, T + 47 * MINUTE])
        expect(await reserveRun({ ...run, jti: jti(), consumeKey, now })).toStrictEqual({
          ok: false,
          limit: "at-once",
        })
      expect(await everything(account)).toStrictEqual(before)
      expect(await exists(consumeKey)).toBe(1)
      // The earlier token still reports and settles, so the run's outcome is recorded, charged by the formula.
      expect(await reportRun(account, run.rid, run, T + 47 * MINUTE)).toStrictEqual({
        live: true,
        deadline: T + 45 * MINUTE,
      })
      expect(await settleRun(account, run.rid, token(run))).toStrictEqual({
        settled: true,
        seconds: 2700,
      })

      // One millisecond before its deadline the check run still renews.
      const other = randomUUID()
      const late = mint(other, allowance("max"), T)
      await reserve(late)
      await reportRun(other, late.rid, late, T + 44 * MINUTE)
      expect(await reserveRun({ ...late, jti: jti(), now: T + 45 * MINUTE - 1 })).toMatchObject({
        ok: true,
        renewed: true,
        deadline: T + 45 * MINUTE,
      })
    })
  })

  describe("settling", () => {
    test("settle bounds and the idle window", async () => {
      // Idle means more than 600 s since the later of the last heartbeat and the last Codium request.
      for (const activity of ["heartbeat", "request"] as const) {
        const account = randomUUID()
        const granted = allowance("plus")
        const first = mint(account, granted, T)
        await reserve(first)
        const at = T + 2 * MINUTE
        if (activity === "heartbeat") await reportRun(account, first.rid, first, at)
        else await recordCodiumRequest(account, first.rid, at)
        for (const quiet of [599_000, 600_000]) {
          expect(await reserveRun(mint(account, granted, at + quiet))).toStrictEqual({ ok: false, limit: "at-once" })
          expect(await cloudAgentSecondsUsed(account, EPOCH, at + quiet)).toBe(0)
        }
        expect(await liveRun(account, first.rid)).toBeDefined()
        expect((await reserve(mint(account, granted, at + 600_001))).startedAt).toBe(at + 600_001)
        expect(await liveRun(account, first.rid)).toBeUndefined()
        expect({ activity, used: await cloudAgentSecondsUsed(account, EPOCH, at + 600_001) }).toEqual({
          activity,
          used: 120,
        })
      }

      async function charged(activity: { report?: number; request?: number }) {
        const account = randomUUID()
        const run = mint(account, allowance("plus"), T)
        await reserve(run)
        if (activity.report) await reportRun(account, run.rid, run, activity.report)
        if (activity.request) await recordCodiumRequest(account, run.rid, activity.request)
        const settled = await settleRun(account, run.rid, token(run))
        expect(await used(account)).toBe(String(settled.seconds))
        return settled
      }
      // No activity after the start charges nothing; a millisecond rounds up to a second; the later activity wins;
      // a heartbeat after the deadline is capped at the deadline.
      expect(await charged({})).toStrictEqual({ settled: true, seconds: 0 })
      expect(await charged({ report: T + 1 })).toStrictEqual({ settled: true, seconds: 1 })
      expect(await charged({ report: T + 5 * MINUTE, request: T + 20 * MINUTE })).toStrictEqual({
        settled: true,
        seconds: 1200,
      })
      expect(await charged({ report: T + 20 * MINUTE, request: T + 5 * MINUTE })).toStrictEqual({
        settled: true,
        seconds: 1200,
      })
      expect(await charged({ report: T + 31 * MINUTE })).toStrictEqual({ settled: true, seconds: 1800 })
      expect(await charged({ request: T + 30 * MINUTE + 1 })).toStrictEqual({ settled: true, seconds: 1800 })
    })

    test("a run with no heartbeats and a Codium request at +20 min, idle-settled at +31 min, is charged 20 minutes", async () => {
      for (const path of ["status", "reserve"] as const) {
        const account = randomUUID()
        const granted = allowance("max")
        const run = mint(account, granted, T)
        await reserve(run)
        await recordCodiumRequest(account, run.rid, T + 20 * MINUTE)
        if (path === "reserve") await reserve(mint(account, granted, T + 31 * MINUTE))
        expect({ path, used: await cloudAgentSecondsUsed(account, EPOCH, T + 31 * MINUTE) }).toEqual({
          path,
          used: 1200,
        })
        expect(await liveRun(account, run.rid)).toBeUndefined()
      }
    })

    test("a stale heartbeat with a recent request is not idle", async () => {
      const account = randomUUID()
      const granted = allowance("plus")
      const run = mint(account, granted, T)
      await reserve(run)
      await reportRun(account, run.rid, run, T + MINUTE)
      await recordCodiumRequest(account, run.rid, T + 15 * MINUTE)
      // At +20 min the heartbeat is 19 minutes old, the request 5.
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 20 * MINUTE)).toBe(0)
      expect(await reserveRun(mint(account, granted, T + 20 * MINUTE))).toStrictEqual({ ok: false, limit: "at-once" })
      expect(await liveRun(account, run.rid)).toMatchObject({ lastReport: T + MINUTE, lastRequest: T + 15 * MINUTE })
    })

    test("every settle path charges the one formula", async () => {
      // A heartbeat at +5 min plus 1 ms and a request at +9 min plus 0.5 s: 541 s, whichever path settles it.
      const idleAt = T + 540_500 + 600_001
      const paths: Record<string, (account: string, run: ReserveInput) => Promise<unknown>> = {
        explicit: (account, run) => settleRun(account, run.rid, token(run)),
        "reserve sweep": (account) => reserveRun(mint(account, allowance("max"), idleAt)),
        "status sweep": (account) => cloudAgentSecondsUsed(account, EPOCH, idleAt),
        "generation change": (_, run) => reserveRun({ ...run, generation: 2, jti: jti(), now: T + 541_000 }),
      }
      for (const [path, settle] of Object.entries(paths)) {
        const account = randomUUID()
        const run = mint(account, allowance("max"), T)
        await reserve(run)
        await reportRun(account, run.rid, run, T + 300_001)
        await recordCodiumRequest(account, run.rid, T + 540_500)
        const answer = await settle(account, run)
        if (path === "explicit") expect(answer).toStrictEqual({ settled: true, seconds: 541 })
        expect({ path, used: await cloudAgentSecondsUsed(account, EPOCH, idleAt) }).toEqual({ path, used: 541 })
        expect({ path, gone: (await liveRun(account, run.rid))?.gen !== 1 }).toEqual({ path, gone: true })
      }
    })

    test("settleRun is idempotent, needs the token that holds the run, and gives back only into the token's epoch", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      await reserve(run)
      await reportRun(account, run.rid, run, T + MINUTE)
      expect(await settleRun(account, run.rid, { jti: jti(), epoch: EPOCH })).toStrictEqual({
        settled: false,
        seconds: 0,
      })
      expect(await liveRun(account, run.rid)).toBeDefined()
      commands.length = 0
      expect(await settleRun(account, run.rid, token(run))).toStrictEqual({
        settled: true,
        seconds: 60,
      })
      expect(commands).toHaveLength(1)
      expect(await used(account)).toBe("60")
      expect(await exists(liveKey(account))).toBe(0)
      expect(await settleRun(account, run.rid, token(run))).toStrictEqual({
        settled: false,
        seconds: 0,
      })
      expect(await used(account)).toBe("60")

      // A token naming another epoch than the run's gets no give-back: the whole reservation stays charged.
      const second = mint(account, allowance("max"), T + 4 * MINUTE)
      await reserve(second)
      await reportRun(account, second.rid, second, T + 5 * MINUTE)
      expect(await settleRun(account, second.rid, { jti: second.jti, epoch: "p1" })).toStrictEqual({
        settled: true,
        seconds: 2700,
      })
      expect(await used(account)).toBe("2760")
      expect(await exists(usedKey(account, "p1"))).toBe(0)

      // An unknown run settles nothing and creates nothing.
      const stranger = randomUUID()
      expect(await settleRun(stranger, run.rid, token(run))).toStrictEqual({ settled: false, seconds: 0 })
      expect([await exists(liveKey(stranger)), await exists(usedKey(stranger, EPOCH))]).toEqual([0, 0])
    })

    test("the live record is kept as long as the agent time its runs are charged to, and nothing shortens it", async () => {
      const account = randomUUID()
      const long = mint(account, allowance("ultra"), T)
      await reserve(long)
      await expectExpiry(liveKey(account), END - T + 40 * DAY)
      // A run of a period that ends 30 days later lengthens it.
      const later = mint(account, allowance("ultra", { meterEpoch: "p2", periodEnd: END + 30 * DAY }), T + MINUTE)
      await reserve(later)
      const kept = END + 30 * DAY - (T + MINUTE) + 40 * DAY
      await expectExpiry(liveKey(account), kept)
      // Heartbeats, requests, settles, releases, sweeps and a reserve whose period has ended leave it alone.
      await reportRun(account, long.rid, long, T + 2 * MINUTE)
      await recordCodiumRequest(account, long.rid, T + 2 * MINUTE)
      await settleRun(account, long.rid, token(long))
      const ended = mint(account, allowance("ultra", { periodEnd: T - DAY }), T + 4 * MINUTE)
      const fresh = await reserve(ended)
      if (fresh.renewed) throw new Error("A fresh reservation was answered as a renewal")
      await expectExpiry(usedKey(account, EPOCH), 40 * DAY)
      await reserve(mint(account, allowance("ultra"), T + 5 * MINUTE))
      await releaseRun(account, ended.rid, { ...fresh, jti: ended.jti })
      await cloudAgentSecondsUsed(account, "p2", T + 7 * MINUTE + 2 * HOUR)
      expect(Object.keys(await runs(account))).toHaveLength(1)
      await expectExpiry(liveKey(account), kept)
      // The hash goes with its last run.
      await cloudAgentSecondsUsed(account, EPOCH, T + 7 * MINUTE + 2 * HOUR)
      expect(await exists(liveKey(account))).toBe(0)

      // A run longer than its agent time's own expiry keeps the hash until its deadline plus a day.
      const marathon = randomUUID()
      const fifty = 50 * DAY
      await reserve(
        mint(
          marathon,
          allowance("plus", {
            periodEnd: T - DAY,
            allowanceSeconds: fifty / SECOND,
            limits: { ...allowance("plus").limits, longestRunMin: fifty / MINUTE },
          }),
          T,
        ),
      )
      await expectExpiry(usedKey(marathon, EPOCH), 40 * DAY)
      await expectExpiry(liveKey(marathon), fifty + DAY)
    })
  })

  describe("heartbeats and Codium requests", () => {
    test("reportRun answers live with the deadline for the holding token only, and creates nothing", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      await reserve(run)
      commands.length = 0
      expect(await reportRun(account, run.rid, run, T + MINUTE)).toStrictEqual({
        live: true,
        deadline: T + 45 * MINUTE,
      })
      expect(commands).toHaveLength(1)
      await reportRun(account, run.rid, run, T + 30 * SECOND)
      expect((await liveRun(account, run.rid))?.lastReport).toBe(T + MINUTE)
      // Past the deadline the run is live until it is settled; the charge stays capped at the deadline.
      expect(await reportRun(account, run.rid, run, T + 46 * MINUTE)).toStrictEqual({
        live: true,
        deadline: T + 45 * MINUTE,
      })
      const stranger = randomUUID()
      expect(await reportRun(stranger, run.rid, run, T)).toStrictEqual({ live: false })
      expect(await exists(liveKey(stranger))).toBe(0)
      expect(await settleRun(account, run.rid, token(run))).toStrictEqual({
        settled: true,
        seconds: 2700,
      })
      expect(await reportRun(account, run.rid, run, T + 48 * MINUTE)).toStrictEqual({ live: false })
      expect(await exists(liveKey(account))).toBe(0)
    })

    test("recordCodiumRequest keeps the latest request, and does nothing for a settled, unknown or another account's run", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      await reserve(run)
      commands.length = 0
      await recordCodiumRequest(account, run.rid, T + 5 * MINUTE)
      expect(commands).toHaveLength(1)
      await recordCodiumRequest(account, run.rid, T + 3 * MINUTE)
      expect((await liveRun(account, run.rid))?.lastRequest).toBe(T + 5 * MINUTE)
      // A request that ended before the run started is not the run's.
      const later = mint(account, allowance("max"), T + 10 * MINUTE)
      await reserve(later)
      await recordCodiumRequest(account, later.rid, T + 10 * MINUTE - 1)
      expect(await stored(account, later.rid)).not.toHaveProperty("lastRequest")
      await recordCodiumRequest(account, later.rid, T + 10 * MINUTE)
      expect((await liveRun(account, later.rid))?.lastRequest).toBe(T + 10 * MINUTE)
      await settleRun(account, run.rid, token(run))
      await recordCodiumRequest(account, run.rid, T + 12 * MINUTE)
      expect(await stored(account, run.rid)).toBeNull()
      await recordCodiumRequest(account, GithubAgents.runId(1, 2, 3, 4), T + 12 * MINUTE)
      expect(Object.keys(await runs(account))).toEqual([later.rid])
      const stranger = randomUUID()
      await recordCodiumRequest(stranger, later.rid, T + 12 * MINUTE)
      expect(await exists(liveKey(stranger))).toBe(0)
    })
  })

  describe("release", () => {
    test("releasing after a failed fresh mint charges 0 and frees the slot and the scheduled run", async () => {
      const account = randomUUID()
      const granted = allowance("max")
      const run = mint(account, granted, T, SCHEDULE)
      const result = await reserve(run)
      expect([await used(account), await redis.send("GET", [scheduledKey(account, "2026-10-26")])]).toEqual([
        "2700",
        "1",
      ])
      if (result.renewed) throw new Error("A fresh reservation was answered as a renewal")
      commands.length = 0
      await releaseRun(account, run.rid, { ...result, jti: run.jti })
      expect(commands).toHaveLength(1)
      expect(await exists(liveKey(account))).toBe(0)
      expect([await used(account), await redis.send("GET", [scheduledKey(account, "2026-10-26")])]).toEqual(["0", "0"])
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + SECOND)).toBe(0)
      await reserve(mint(account, granted, T + 2 * SECOND))
      await reserve(mint(account, granted, T + 2 * SECOND))
    })

    test("a release names the reservation it made, and a renewed or replaced one is left alone", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T, SCHEDULE)
      const result = await reserve(run)
      const fresh = { renewed: false as const, jti: run.jti, epoch: result.epoch, startedAt: result.startedAt }
      const before = await everything(account, ["2026-10-26"])
      for (const wrong of [{ jti: jti() }, { startedAt: T + 1 }, { epoch: "p1" }])
        await releaseRun(account, run.rid, { ...fresh, ...wrong })
      expect(await everything(account, ["2026-10-26"])).toStrictEqual(before)

      const renewal = await reserve({ ...run, jti: jti(), now: T + MINUTE })
      if (!renewal.renewed) throw new Error("The second mint should have renewed the run")
      const renewedBefore = await everything(account, ["2026-10-26"])
      await releaseRun(account, run.rid, fresh)
      expect(await everything(account, ["2026-10-26"])).toStrictEqual(renewedBefore)
      // A renewal cannot be released: its type is refused, and so is the value.
      const renewed = { ...renewal, jti: jti() }
      commands.length = 0
      // @ts-expect-error a renewed reservation is never released
      await expect(releaseRun(account, run.rid, renewed)).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
      expect(await everything(account, ["2026-10-26"])).toStrictEqual(renewedBefore)
    })

    test("a release uncounts the scheduled run on its start's UTC day, not the release's", async () => {
      // Reserved at 2026-10-27T23:59:59.900Z; another schedule at 00:00:00.050Z; released at 00:00:00.100Z.
      const midnight = Date.UTC(2026, 9, 28)
      const account = randomUUID()
      const granted = allowance("max")
      const run = mint(account, granted, midnight - 100, SCHEDULE)
      const result = await reserve(run)
      if (result.renewed) throw new Error("A fresh reservation was answered as a renewal")
      await reserve(mint(account, granted, midnight + 50, SCHEDULE))
      const days = ["2026-10-27", "2026-10-28"]
      expect((await everything(account, days)).scheduled).toEqual(["1", "1"])
      commands.length = 0
      await releaseRun(account, run.rid, { ...result, jti: run.jti })
      expect(commands[0]?.slice(2, 6)).toEqual([
        "3",
        liveKey(account),
        usedKey(account, EPOCH),
        scheduledKey(account, "2026-10-27"),
      ])
      expect((await everything(account, days)).scheduled).toEqual(["0", "1"])
      expect(await used(account)).toBe("2700")
    })
  })

  describe("scheduled runs and epochs", () => {
    test("Plus schedule refused; Max sixth schedule refused; resets at 00:00 UTC", async () => {
      // 2026-10-27T00:00:00.000Z.
      const day = Date.UTC(2026, 9, 27)
      const plus = randomUUID()
      expect(await reserveRun(mint(plus, allowance("plus"), day + HOUR, SCHEDULE))).toStrictEqual({
        ok: false,
        limit: "scheduled",
      })
      expect([await exists(scheduledKey(plus, "2026-10-27")), await exists(liveKey(plus))]).toEqual([0, 0])

      const account = randomUUID()
      const granted = allowance("max")
      for (const hour of [0, 1, 2, 3, 4]) {
        const run = mint(account, granted, day + hour * HOUR, SCHEDULE)
        await reserve(run)
        await settleRun(account, run.rid, token(run))
      }
      expect(await redis.send("GET", [scheduledKey(account, "2026-10-27")])).toBe("5")
      // Two days from the last scheduled mint's write.
      await expectExpiry(scheduledKey(account, "2026-10-27"), 2 * DAY)
      const lastMoment = day + DAY - 1
      expect(await reserveRun(mint(account, granted, lastMoment, SCHEDULE))).toStrictEqual({
        ok: false,
        limit: "scheduled",
      })
      // Comment and dispatch runs are never counted.
      const comment = mint(account, granted, lastMoment)
      const dispatch = mint(account, granted, lastMoment, { source: "github-dispatch", thread: "dispatch-17" })
      await reserve(comment)
      await reserve(dispatch)
      expect(await redis.send("GET", [scheduledKey(account, "2026-10-27")])).toBe("5")
      for (const run of [comment, dispatch]) await settleRun(account, run.rid, token(run))
      await reserve(mint(account, granted, day + DAY, SCHEDULE))
      expect(await redis.send("GET", [scheduledKey(account, "2026-10-28")])).toBe("1")
      expect(await redis.send("GET", [scheduledKey(account, "2026-10-27")])).toBe("5")
    })

    test("a scheduled check run that mints again after a generation change is counted once", async () => {
      // 2026-10-27T00:00:00.000Z. Max allows five schedules a day; the fifth is live when the repository is rebound.
      const day = Date.UTC(2026, 9, 27)
      const account = randomUUID()
      const granted = allowance("max")
      const count = (on: string, who = account) => redis.send("GET", [scheduledKey(who, on)])
      for (const hour of [0, 1, 2, 3]) {
        const run = mint(account, granted, day + hour * HOUR, SCHEDULE)
        await reserve(run)
        await settleRun(account, run.rid, token(run))
      }
      const fifth = mint(account, granted, day + 4 * HOUR, SCHEDULE)
      await reserve(fifth)
      expect(await liveRun(account, fifth.rid)).toStrictEqual({
        startedAt: day + 4 * HOUR,
        deadline: day + 4 * HOUR + 45 * MINUTE,
        lastReport: day + 4 * HOUR,
        epoch: EPOCH,
        repo: fifth.repositoryId,
        thr: SCHEDULE.thread,
        src: "github-schedule",
        pur: "scheduled",
        counted: true,
        gen: 1,
        jti: fifth.jti,
      })
      await reportRun(account, fifth.rid, fifth, day + 4 * HOUR + 2 * MINUTE)
      expect(await count("2026-10-27")).toBe("5")
      // Its check run mints again: one schedule event, so neither the cap at five nor a second count applies.
      const rebound = { ...fifth, generation: 2, jti: jti(), now: day + 4 * HOUR + 3 * MINUTE }
      const replaced = await reserve(rebound)
      if (replaced.renewed) throw new Error("A generation change was answered as a renewal")
      expect(replaced).toMatchObject({ startedAt: rebound.now, source: "github-schedule", purpose: "scheduled" })
      expect(await count("2026-10-27")).toBe("5")
      expect(await stored(account, fifth.rid)).not.toHaveProperty("counted")
      // The replacement counted nothing, so releasing it (its mint failed) uncounts nothing: the event still ran.
      await releaseRun(account, fifth.rid, { ...replaced, jti: rebound.jti })
      expect(await liveRun(account, fifth.rid)).toBeUndefined()
      expect(await count("2026-10-27")).toBe("5")
      expect(await reserveRun(mint(account, granted, day + 5 * HOUR, SCHEDULE))).toStrictEqual({
        ok: false,
        limit: "scheduled",
      })

      // Below the cap and across midnight: started at 23:59, minted again at 00:01, counted on its first day only.
      const other = randomUUID()
      const late = mint(other, granted, day + DAY - MINUTE, SCHEDULE)
      await reserve(late)
      await reserve({ ...late, generation: 2, jti: jti(), now: day + DAY + MINUTE })
      expect([await count("2026-10-27", other), await count("2026-10-28", other)]).toEqual(["1", null])
      // Nor is it counted again when the re-mint finds the check run's own record idle and settles it first.
      await reserve({ ...late, generation: 2, jti: jti(), now: day + DAY + 12 * MINUTE })
      expect(await liveRun(other, late.rid)).toMatchObject({ startedAt: day + DAY + 12 * MINUTE })
      expect(await stored(other, late.rid)).not.toHaveProperty("counted")
      expect([await count("2026-10-27", other), await count("2026-10-28", other)]).toEqual(["1", null])
    })

    test("new epoch starts fresh", async () => {
      const renewed = "sub_fixture:1794648600000"
      const account = randomUUID()
      const first = mint(account, allowance("plus"), T)
      await reserve(first)
      await reportRun(account, first.rid, first, T + 20 * MINUTE)
      await settleRun(account, first.rid, token(first))
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 21 * MINUTE)).toBe(1200)
      expect(await cloudAgentSecondsUsed(account, renewed, T + 21 * MINUTE)).toBe(0)
      // 1500 s in the new epoch would be under the floor had the old epoch's 1200 s carried over.
      const granted = allowance("plus", { meterEpoch: renewed, allowanceSeconds: 1500 })
      const next = mint(account, granted, T + 21 * MINUTE)
      expect((await reserve(next)).deadline).toBe(T + 21 * MINUTE + 1500 * SECOND)
      expect([await used(account), await used(account, renewed)]).toEqual(["1200", "1500"])
      await settleRun(account, next.rid, token(next))
      expect([await used(account), await used(account, renewed)]).toEqual(["1200", "0"])
    })

    test("an idle run of the old epoch frees its slot for the new one and keeps its reservation in its own epoch", async () => {
      const renewed = "sub_fixture:1794648600000"
      const account = randomUUID()
      const old = mint(account, allowance("plus"), T)
      await reserve(old)
      await reportRun(account, old.rid, old, T + 5 * MINUTE)
      const next = mint(account, allowance("plus", { meterEpoch: renewed }), T + 16 * MINUTE)
      expect((await reserve(next)).epoch).toBe(renewed)
      expect(await liveRun(account, old.rid)).toBeUndefined()
      expect([await used(account), await used(account, renewed)]).toEqual(["1800", "1800"])
      expect(await cloudAgentSecondsUsed(account, renewed, T + 16 * MINUTE)).toBe(0)
    })

    test("a run of the old epoch replaced after a generation change, like an idle one, keeps its reservation in its own epoch", async () => {
      const renewed = "sub_fixture:1794648600000"
      const account = randomUUID()
      const old = mint(account, allowance("max"), T)
      await reserve(old)
      await reportRun(account, old.rid, old, T + 5 * MINUTE)
      // The period renews, the repository is rebound, and the same check run mints again.
      const rebound = {
        ...old,
        generation: 2,
        jti: jti(),
        allowance: allowance("max", { meterEpoch: renewed }),
        now: T + 6 * MINUTE,
      }
      expect(await reserveRun(rebound)).toMatchObject({
        ok: true,
        renewed: false,
        startedAt: T + 6 * MINUTE,
        epoch: renewed,
      })
      expect(await liveRun(account, old.rid)).toMatchObject({ gen: 2, epoch: renewed, jti: rebound.jti })
      // Not the formula's 300 s: the reserve has no key for the old epoch, so nothing goes back into it.
      expect([await used(account), await used(account, renewed)]).toEqual(["2700", "2700"])
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 6 * MINUTE)).toBe(2700)
      expect(await cloudAgentSecondsUsed(account, renewed, T + 6 * MINUTE)).toBe(0)
    })

    test("a status read for another epoch leaves the current epoch's idle run to that epoch's own settle", async () => {
      const renewed = "sub_fixture:1794648600000"
      const account = randomUUID()
      const run = mint(account, allowance("plus", { meterEpoch: renewed }), T)
      await reserve(run)
      await reportRun(account, run.rid, run, T + 5 * MINUTE)
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 20 * MINUTE)).toBe(0)
      expect(await liveRun(account, run.rid)).toBeDefined()
      expect(await exists(usedKey(account, EPOCH))).toBe(0)
      expect(await cloudAgentSecondsUsed(account, renewed, T + 20 * MINUTE)).toBe(300)
      expect(await used(account, renewed)).toBe("300")
    })

    test("cloudAgentSecondsUsed counts lazily settled runs and leaves out live reservations", async () => {
      const account = randomUUID()
      const granted = allowance("max")
      const settled = mint(account, granted, T)
      await reserve(settled)
      await reportRun(account, settled.rid, settled, T + 4 * MINUTE)
      await settleRun(account, settled.rid, token(settled))
      const idle = mint(account, granted, T + 5 * MINUTE)
      await reserve(idle)
      await recordCodiumRequest(account, idle.rid, T + 8 * MINUTE)
      const live = mint(account, granted, T + 17 * MINUTE)
      await reserve(live)
      commands.length = 0
      expect(await cloudAgentSecondsUsed(account, EPOCH, T + 18 * MINUTE + 1)).toBe(240 + 180)
      expect(commands).toHaveLength(1)
      expect(Object.keys(await runs(account))).toEqual([live.rid])
      expect(await used(account)).toBe(String(240 + 180 + 2700))
      // Codium's two-argument call (A18) reads the clock itself.
      expect(await cloudAgentSecondsUsed(randomUUID(), EPOCH)).toBe(0)
    })

    test("a run nobody settles is kept as long as its agent time, and the next read charges it by the formula", async () => {
      // A Plus run whose job was cancelled at +2 min, or whose token a rebind, an unbind or a suspension killed then:
      // no settle comes, and no ledger call either until long after its deadline plus a day.
      const granted = allowance("plus", { allowanceSeconds: 1800 + 299 })
      for (const read of ["status", "reserve"] as const) {
        const account = randomUUID()
        const run = mint(account, granted, T)
        await reserve(run)
        await reportRun(account, run.rid, run, T + 2 * MINUTE)
        // The record outlives the agent time its reservation is charged to, so no reader ever sees that reservation.
        await expectExpiry(liveKey(account), END - T + 40 * DAY)
        expect(await redis.send("PTTL", [liveKey(account)])).toBeGreaterThanOrEqual(
          (await redis.send("PTTL", [usedKey(account, EPOCH)])) as number,
        )
        if (read === "status") expect(await cloudAgentSecondsUsed(account, EPOCH, T + 20 * DAY)).toBe(120)
        // 2099 − 120 s left, not 2099 − 1800.
        if (read === "reserve")
          expect(await reserveRun(mint(account, granted, T + 20 * DAY))).toMatchObject({
            ok: true,
            deadline: T + 20 * DAY + 1800 * SECOND,
          })
        expect({ read, gone: await liveRun(account, run.rid) }).toEqual({ read, gone: undefined })
        expect({ read, used: await used(account) }).toEqual({ read, used: read === "status" ? "120" : "1920" })
      }
    })

    test("times with odd milliseconds survive the scripts exactly", async () => {
      const start = T + 987
      const account = randomUUID()
      const run = mint(account, allowance("max"), start)
      expect(await reserve(run)).toMatchObject({ startedAt: start, deadline: start + 2_700_000 })
      await reportRun(account, run.rid, run, start + 123_457)
      await recordCodiumRequest(account, run.rid, start + 234_569)
      expect(await liveRun(account, run.rid)).toMatchObject({
        startedAt: 1_793_000_000_987,
        deadline: 1_793_002_700_987,
        lastReport: 1_793_000_124_444,
        lastRequest: 1_793_000_235_556,
      })
      expect(await redis.send("HGET", [liveKey(account), run.rid])).toContain('"startedAt":1793000000987,')
      expect(await settleRun(account, run.rid, token(run))).toStrictEqual({
        settled: true,
        seconds: 235,
      })
      // Sixteen digits, past the 14 significant digits Lua's tostring and cjson keep.
      const far = 8_000_000_000_000_001
      const distant = mint(randomUUID(), allowance("plus"), far)
      expect(await reserve(distant)).toMatchObject({ startedAt: far, deadline: far + 1_800_000 })
      await recordCodiumRequest(distant.account, distant.rid, far + 3)
      expect(await liveRun(distant.account, distant.rid)).toMatchObject({
        startedAt: far,
        deadline: 8_000_000_001_800_001,
        lastReport: far,
        lastRequest: 8_000_000_000_000_004,
      })
      expect(await settleRun(distant.account, distant.rid, token(distant))).toStrictEqual({
        settled: true,
        seconds: 1,
      })
    })
  })

  describe("the gateway hook", () => {
    test("the gateway hook records run requests and ignores other callers", async () => {
      expect(cloudAgentsGatewayHook.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/)
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      await reserve(run)
      const signed = {
        id: run.rid,
        source: "github-comment",
        deadline: T + 45 * MINUTE,
        service: "cloud-agents",
      } as const
      const caller: ModelPlanCaller = { account: { id: account }, kind: "run", purpose: "cloud-agents", run: signed }
      commands.length = 0
      expect(await cloudAgentsGatewayHook.afterSettle(caller, settledContext(T + 3 * MINUTE, account))).toBeUndefined()
      expect(commands).toHaveLength(1)
      expect((await liveRun(account, run.rid))?.lastRequest).toBe(T + 3 * MINUTE)

      const others: ModelPlanCaller[] = [
        { account: { id: account }, kind: "desktop", purpose: "chat" },
        { account: { id: account }, kind: "cli", purpose: "task" },
        { ...caller, purpose: "hosted", run: { ...signed, service: "hosted", sessionId: "session-1" } },
        { ...caller, kind: "desktop" },
        { account: { id: account }, kind: "run", purpose: "cloud-agents" },
      ]
      commands.length = 0
      for (const other of others)
        expect(await cloudAgentsGatewayHook.afterSettle(other, settledContext(T + 4 * MINUTE, account))).toBeUndefined()
      expect(commands).toEqual([])

      // A store failure, a reply it does not recognise or a value the ledger refuses never reaches the gateway; the
      // log line carries the run id only, and only one that matches the run-id grammar.
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      try {
        state.down = true
        expect(
          await cloudAgentsGatewayHook.afterSettle(caller, settledContext(T + 5 * MINUTE, account)),
        ).toBeUndefined()
        state.down = false
        state.corrupt = true
        expect(
          await cloudAgentsGatewayHook.afterSettle(caller, settledContext(T + 5 * MINUTE, account)),
        ).toBeUndefined()
        state.corrupt = false
        const odd = { ...caller, run: { ...signed, id: "gh:1" } }
        expect(await cloudAgentsGatewayHook.afterSettle(odd, settledContext(T + 5 * MINUTE, account))).toBeUndefined()
        const stranger = { ...caller, account: { id: "not-an-account" } }
        expect(
          await cloudAgentsGatewayHook.afterSettle(stranger, settledContext(T + 5 * MINUTE, account)),
        ).toBeUndefined()
        expect(warn.mock.calls).toEqual([
          ["Vector cloud-agents ledger miss", { runId: run.rid }],
          ["Vector cloud-agents ledger miss", { runId: run.rid }],
          ["Vector cloud-agents ledger miss", {}],
          ["Vector cloud-agents ledger miss", { runId: run.rid }],
        ])
      } finally {
        warn.mockRestore()
      }
      expect((await liveRun(account, run.rid))?.lastRequest).toBe(T + 3 * MINUTE)
    })
  })

  describe("failing closed", () => {
    test("store outage fails closed", async () => {
      const account = randomUUID()
      const granted = allowance("max")
      const run = mint(account, granted, T)
      const result = await reserve(run)
      const before = await everything(account, ["2026-10-26"])
      for (const failure of ["down", "corrupt"] as const) {
        state[failure] = true
        const calls = [
          reserveRun(mint(account, granted, T + MINUTE)),
          reserveRun({ ...run, jti: jti(), now: T + MINUTE }),
          reportRun(account, run.rid, run, T + MINUTE),
          recordCodiumRequest(account, run.rid, T + MINUTE),
          settleRun(account, run.rid, token(run)),
          releaseRun(account, run.rid, { renewed: false, jti: run.jti, epoch: EPOCH, startedAt: result.startedAt }),
          cloudAgentSecondsUsed(account, EPOCH, T + MINUTE),
          liveRun(account, run.rid),
        ]
        const results = await Promise.allSettled(calls)
        expect(
          results.map(
            (settled) => settled.status === "rejected" && settled.reason?.statusCode === 503 && settled.reason.code,
          ),
        ).toEqual(calls.map(() => STORE_UNAVAILABLE.code))
        state[failure] = false
      }
      expect(await everything(account, ["2026-10-26"])).toStrictEqual(before)
    })

    test("malformed live records answer 503 from every reader and write nothing", async () => {
      const base = () => ({
        startedAt: T,
        deadline: T + 30 * MINUTE,
        lastReport: T,
        epoch: EPOCH,
        repo: "123456789",
        thr: "42",
        src: "github-comment",
        pur: "task",
        gen: 1,
        jti: jti(),
      })
      const schedule = { src: "github-schedule", pur: "scheduled", thr: SCHEDULE.thread }
      const json = (change: (run: Record<string, unknown>) => void) => {
        const run: Record<string, unknown> = base()
        change(run)
        return JSON.stringify(run)
      }
      const corruptions: [string, string][] = [
        ["an unknown field", json((run) => (run.extra = 1))],
        ["no jti", json((run) => delete run.jti)],
        ["no deadline", json((run) => delete run.deadline)],
        ["a null time", json((run) => (run.lastReport = null))],
        ["a string time", json((run) => (run.startedAt = String(T)))],
        ["a fractional time", json((run) => (run.lastReport = T + 0.5))],
        ["a zero start", json((run) => (run.startedAt = 0))],
        ["a negative request", json((run) => (run.lastRequest = -1))],
        ["a deadline before the start", json((run) => (run.deadline = T - SECOND))],
        ["a reservation that is not whole seconds", json((run) => (run.deadline = T + 30 * MINUTE + 500))],
        ["a heartbeat before the start", json((run) => (run.lastReport = T - 1))],
        ["a request before the start", json((run) => (run.lastRequest = T - 1))],
        ["an epoch with a space", json((run) => (run.epoch = "p 1"))],
        ["an empty epoch", json((run) => (run.epoch = ""))],
        ["another source", json((run) => (run.src = "desktop"))],
        ["another purpose", json((run) => (run.pur = "incident"))],
        ["a bad thread", json((run) => (run.thr = "0"))],
        ["a padded repository id", json((run) => (run.repo = "0123"))],
        ["a numeric repository id", json((run) => (run.repo = 123456789))],
        ["a short jti", json((run) => (run.jti = "abc"))],
        ["a counted run that is not a schedule", json((run) => (run.counted = true))],
        ["a counted flag that is false", json((run) => Object.assign(run, schedule, { counted: false }))],
        ["a counted flag that is a number", json((run) => Object.assign(run, schedule, { counted: 1 }))],
        ["generation 0", json((run) => (run.gen = 0))],
        ["a fractional generation", json((run) => (run.gen = 1.5))],
        ["not JSON", "{"],
        ["a JSON array", "[1]"],
        ["a JSON string", '"run"'],
        ["JSON null", "null"],
      ]
      for (const [name, raw] of corruptions) {
        const account = randomUUID()
        const rid = GithubAgents.runId(123456789, randomInt(1, 2 ** 40), 1, randomInt(1, 2 ** 40))
        await write("HSET", liveKey(account), [rid, raw])
        const granted = allowance("max")
        const holder = { jti: jti(), epoch: EPOCH }
        const before = await everything(account, ["2026-10-26"])
        const results = await Promise.allSettled([
          liveRun(account, rid),
          reportRun(account, rid, holder, T + MINUTE),
          recordCodiumRequest(account, rid, T + MINUTE),
          settleRun(account, rid, holder),
          releaseRun(account, rid, { renewed: false, ...holder, startedAt: T }),
          cloudAgentSecondsUsed(account, EPOCH, T + MINUTE),
          reserveRun(mint(account, granted, T + MINUTE)),
          reserveRun(mint(account, granted, T + MINUTE, { rid })),
        ])
        expect({
          name,
          codes: results.map((settled) => settled.status === "rejected" && settled.reason?.code),
        }).toEqual({ name, codes: results.map(() => STORE_UNAVAILABLE.code) })
        expect({ name, after: await everything(account, ["2026-10-26"]) }).toStrictEqual({ name, after: before })
      }
    })

    test("only the calls that read every run refuse an account with one malformed run", async () => {
      const account = randomUUID()
      const granted = allowance("max")
      const healthy = mint(account, granted, T)
      await reserve(healthy)
      await write("HSET", liveKey(account), [GithubAgents.runId(1, 2, 3, 4), "{"])
      const before = await everything(account)
      for (const call of [
        () => reserveRun(mint(account, granted, T + MINUTE)),
        () => settleRun(account, healthy.rid, token(healthy)),
        () => releaseRun(account, healthy.rid, { renewed: false, ...token(healthy), startedAt: T }),
        () => cloudAgentSecondsUsed(account, EPOCH, T + MINUTE),
      ])
        await expect(call()).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await everything(account)).toStrictEqual(before)
      // A heartbeat and a Codium request touch only their own run.
      expect(await reportRun(account, healthy.rid, healthy, T + MINUTE)).toStrictEqual({
        live: true,
        deadline: T + 45 * MINUTE,
      })
      await recordCodiumRequest(account, healthy.rid, T + 2 * MINUTE)
      expect(await liveRun(account, healthy.rid)).toMatchObject({ lastReport: T + MINUTE, lastRequest: T + 2 * MINUTE })
    })

    test("a malformed count, or a key of another type, answers 503 with nothing written", async () => {
      const granted = allowance("max")
      for (const value of ["abc", "-1", "1.5", "01", "", "1e3"]) {
        const account = randomUUID()
        const run = mint(account, granted, T, SCHEDULE)
        await reserve(run)
        await write("SET", usedKey(account, EPOCH), [value])
        const before = await everything(account, ["2026-10-26"])
        for (const call of [
          () => reserveRun(mint(account, granted, T + MINUTE)),
          () => settleRun(account, run.rid, token(run)),
          () => releaseRun(account, run.rid, { renewed: false, ...token(run), startedAt: T }),
          () => cloudAgentSecondsUsed(account, EPOCH, T + MINUTE),
        ])
          await expect(call()).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect({ value, after: await everything(account, ["2026-10-26"]) }).toStrictEqual({ value, after: before })
      }
      for (const value of ["x", "-2", "5.0"]) {
        const account = randomUUID()
        const run = mint(account, granted, T, SCHEDULE)
        await reserve(run)
        await write("SET", scheduledKey(account, "2026-10-26"), [value])
        const before = await everything(account, ["2026-10-26"])
        await expect(reserveRun(mint(account, granted, T + MINUTE, SCHEDULE))).rejects.toMatchObject(STORE_UNAVAILABLE)
        await expect(
          releaseRun(account, run.rid, { renewed: false, ...token(run), startedAt: T }),
        ).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect({ value, after: await everything(account, ["2026-10-26"]) }).toStrictEqual({ value, after: before })
      }
      // Agent time below what a settle would give back means the store lost something: refuse rather than guess.
      const short = randomUUID()
      const run = mint(short, granted, T)
      await reserve(run)
      await write("SET", usedKey(short, EPOCH), ["100"])
      const before = await everything(short)
      await expect(settleRun(short, run.rid, token(run))).rejects.toMatchObject(STORE_UNAVAILABLE)
      await expect(cloudAgentSecondsUsed(short, EPOCH, T + MINUTE)).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await everything(short)).toStrictEqual(before)
      // Keys of another type.
      for (const [name, setup] of [
        ["live", (account: string) => write("SET", liveKey(account), ["x"])],
        ["used", (account: string) => write("HSET", usedKey(account, EPOCH), ["f", "1"])],
        ["sched", (account: string) => write("RPUSH", scheduledKey(account, "2026-10-26"), ["1"])],
      ] as const) {
        const account = randomUUID()
        await setup(account)
        const results = await Promise.allSettled([
          reserveRun(mint(account, granted, T)),
          reportRun(account, "gh-1-2-3-4", { jti: jti() }, T),
          recordCodiumRequest(account, "gh-1-2-3-4", T),
          settleRun(account, "gh-1-2-3-4", { jti: jti(), epoch: EPOCH }),
          releaseRun(account, "gh-1-2-3-4", { renewed: false, jti: jti(), epoch: EPOCH, startedAt: T }),
          cloudAgentSecondsUsed(account, EPOCH, T),
          liveRun(account, "gh-1-2-3-4"),
        ])
        const refused = results.map((settled) => settled.status === "rejected" && settled.reason?.code)
        // Each call refuses exactly when it reads the misfiled key.
        const reads = {
          live: [true, true, true, true, true, true, true],
          used: [true, false, false, true, true, true, false],
          sched: [true, false, false, false, true, false, false],
        }[name]
        expect({ name, refused }).toEqual({
          name,
          refused: reads.map((read) => (read ? STORE_UNAVAILABLE.code : false)),
        })
        expect(await exists(liveKey(account))).toBe(name === "live" ? 1 : 0)
      }
    })

    test("invalid inputs answer 400 and reach no store", async () => {
      const account = randomUUID()
      const granted = allowance("max")
      const valid = mint(account, granted, T)
      const reserves: unknown[] = [
        { ...valid, account: "not-a-uuid" },
        { ...valid, account: account.toUpperCase() },
        { ...valid, rid: "-" },
        { ...valid, rid: "gh:1" },
        { ...valid, rid: "a".repeat(129) },
        { ...valid, repositoryId: "0" },
        { ...valid, repositoryId: "0123" },
        { ...valid, repositoryId: "12a" },
        { ...valid, thread: "0" },
        { ...valid, thread: "dispatch-0" },
        { ...valid, thread: "schedule-XYZ" },
        { ...valid, generation: 0 },
        { ...valid, generation: 1.5 },
        { ...valid, generation: Number.NaN },
        { ...valid, generation: "1" },
        { ...valid, jti: "short" },
        { ...valid, jti: `${jti().slice(0, 21)}+` },
        { ...valid, source: "desktop" },
        { ...valid, source: "schedule" },
        { ...valid, purpose: "incident" },
        { ...valid, source: "github-schedule", purpose: "task" },
        { ...valid, purpose: "scheduled" },
        { ...valid, allowance: { active: false, reason: "none" } },
        { ...valid, allowance: { ...granted, meterEpoch: "" } },
        { ...valid, allowance: { ...granted, meterEpoch: "p 1" } },
        { ...valid, allowance: { ...granted, meterEpoch: "-p1" } },
        { ...valid, allowance: { ...granted, meterEpoch: "p".repeat(129) } },
        { ...valid, allowance: { ...granted, periodEnd: 0 } },
        { ...valid, allowance: { ...granted, periodEnd: 1.5 } },
        { ...valid, allowance: { ...granted, allowanceSeconds: -1 } },
        { ...valid, allowance: { ...granted, allowanceSeconds: 1.5 } },
        { ...valid, allowance: { ...granted, limits: { ...granted.limits, atOnce: 0 } } },
        { ...valid, allowance: { ...granted, limits: { ...granted.limits, atOnce: 1.5 } } },
        { ...valid, allowance: { ...granted, limits: { ...granted.limits, longestRunMin: 0 } } },
        { ...valid, allowance: { ...granted, limits: { ...granted.limits, scheduledPerDay: -1 } } },
        { ...valid, consumeKey: "" },
        { ...valid, consumeKey: `${PREFIX}binding:123` },
        { ...valid, consumeKey: `${PREFIX}ticket:${"A".repeat(64)}` },
        { ...valid, consumeKey: `${PREFIX}ticket:${"a".repeat(63)}` },
        { ...valid, now: 0 },
        { ...valid, now: Number.NaN },
        { ...valid, now: T + 0.5 },
        { ...valid, now: 8_640_000_000_000_001 },
      ]
      for (const input of reserves)
        await expect(reserveRun(input as ReserveInput)).rejects.toMatchObject(INVALID_REQUEST)
      const holder = token(valid)
      const fresh = { renewed: false as const, ...holder, startedAt: T }
      const calls: (() => Promise<unknown>)[] = [
        () => reportRun("not-a-uuid", valid.rid, holder, T),
        () => reportRun(account, "-", holder, T),
        () => reportRun(account, valid.rid, { jti: "short" }, T),
        () => reportRun(account, valid.rid, holder, 0),
        () => recordCodiumRequest(account.toUpperCase(), valid.rid, T),
        () => recordCodiumRequest(account, "gh:1", T),
        () => recordCodiumRequest(account, valid.rid, -1),
        () => recordCodiumRequest(account, valid.rid, T + 0.5),
        () => settleRun("", valid.rid, holder),
        () => settleRun(account, "", holder),
        () => settleRun(account, valid.rid, { ...holder, jti: "short" }),
        () => settleRun(account, valid.rid, { ...holder, epoch: "p 1" }),
        () => releaseRun("x", valid.rid, fresh),
        () => releaseRun(account, "a:b", fresh),
        () => releaseRun(account, valid.rid, { ...fresh, renewed: true } as unknown as typeof fresh),
        () => releaseRun(account, valid.rid, { ...fresh, jti: "short" }),
        () => releaseRun(account, valid.rid, { ...fresh, epoch: "" }),
        () => releaseRun(account, valid.rid, { ...fresh, startedAt: 0 }),
        () => cloudAgentSecondsUsed("x", EPOCH, T),
        () => cloudAgentSecondsUsed(account, "", T),
        () => cloudAgentSecondsUsed(account, "p/1", T),
        () => cloudAgentSecondsUsed(account, EPOCH, -T),
        () => liveRun("x", valid.rid),
        () => liveRun(account, "a b"),
      ]
      for (const call of calls) await expect(call()).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
    })

    test("each function sends exactly one EVAL", async () => {
      const account = randomUUID()
      const run = mint(account, allowance("max"), T)
      const calls: [string, () => Promise<unknown>][] = [
        ["reserveRun", () => reserveRun(run)],
        ["reserveRun renewal", () => reserveRun({ ...run, now: T + SECOND })],
        ["reportRun", () => reportRun(account, run.rid, run, T + SECOND)],
        ["recordCodiumRequest", () => recordCodiumRequest(account, run.rid, T + SECOND)],
        ["liveRun", () => liveRun(account, run.rid)],
        ["cloudAgentSecondsUsed", () => cloudAgentSecondsUsed(account, EPOCH, T + SECOND)],
        ["settleRun", () => settleRun(account, run.rid, token(run))],
        ["releaseRun", () => releaseRun(account, run.rid, { renewed: false, ...token(run), startedAt: T })],
      ]
      for (const [name, call] of calls) {
        commands.length = 0
        await call()
        expect({ name, commands: commands.map((command) => command[0]) }).toEqual({ name, commands: ["EVAL"] })
      }
    })
  })

  // 2.6's shapes, and Codium's: bun test does not check types; packages/web's typecheck checks this file.
  test("the ledger has 2.6's shapes and fits Codium's gateway hook and status call", () => {
    type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
    type Section26 = {
      startedAt: number
      deadline: number
      lastReport: number
      lastRequest?: number
      epoch: string
      repo: string
      thr: string
      src: "github-comment" | "github-dispatch" | "github-schedule"
      pur: "task" | "review" | "scheduled"
      counted?: true
      gen: number
      jti: string
      triggerSource?: RunSource
      triggerPurpose?: "task" | "review" | "incident" | "changes"
      ticketHash?: string
    }
    const shape: Equal<LiveRun, Section26> = true
    const hook: GatewayHook = cloudAgentsGatewayHook
    const strict: (caller: ModelPlanCaller, context: AfterSettleContext) => Promise<void> =
      cloudAgentsGatewayHook.afterSettle
    const returns: Equal<ReturnType<typeof cloudAgentsGatewayHook.afterSettle>, Promise<void>> = true
    const status: (accountId: string, meterEpoch: string) => Promise<number> = cloudAgentSecondsUsed
    expect([shape, returns, typeof hook.afterSettle, typeof strict, typeof status]).toEqual([
      true,
      true,
      "function",
      "function",
      "function",
    ])
  })
}
