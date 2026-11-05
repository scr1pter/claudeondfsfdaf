import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { ops as opsProvisioner } from "../api/_lib/codium-provisioners"
import { opsRosterKey, readOpsRoster, rosterCounts } from "../api/_lib/ops-accounts"
import {
  accountUsage,
  analyticsConfiguration,
  capCost,
  GRAPHQL_ENDPOINT,
  monthStart,
  OPS_GUARD,
  opsGuardBudget,
  opsGuardCheckedKey,
  opsGuardHeldKey,
  priceSpend,
  readOpsSpend,
  type OpsSpend,
} from "../api/_lib/ops-guard"
import { opsCall } from "../api/_lib/ops-worker"
import { handleOpsGuard } from "../api/ops/guard"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { CRON_SECRET, DAY, invoke, MAX, NOW, OpsWorld, PRO, ULTRA } from "./ops-fixture"

// WP A50: the ops guard. Its budget grows with the Max and Ultra subscribers on the ops roster (kept by the ops
// provisioner): (Max x cap cost + Ultra x cap cost) x 2 + $5. The month's spend comes from Cloudflare's GraphQL
// Analytics API (a fake here; nothing reaches Cloudflare). At 75% the owner gets one email a month; at 100% only the
// accounts whose probes exceed what their own plan and monitors explain are held at the ops Worker (A46's own code, in
// memory), and everyone held is released once the spend is back under the budget. The cron's answer carries no dollars.

const HOUR = 3_600_000
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const NAMESPACE = "fedcba9876543210fedcba9876543210"
const ANALYTICS_TOKEN = "fixture-analytics-token-0000000000"
const SECOND_MAX = "a47a47a4-0000-4000-8000-000000000013"

const ENVIRONMENT = {
  RESEND_API_KEY: "re_fixture_owner_alerts",
  VECTOR_PURCHASE_EMAIL_FROM: "Vector <alerts@example.test>",
  CODIUM_OWNER_EMAIL: "owner@example.test",
  VECTOR_OPS_CF_ACCOUNT_ID: ACCOUNT_ID,
  VECTOR_OPS_CF_ANALYTICS_TOKEN: ANALYTICS_TOKEN,
  VECTOR_OPS_CF_NAMESPACE_ID: NAMESPACE,
  VECTOR_OPS_CF_SCRIPT: undefined,
  VECTOR_R2_ACCOUNT_ID: undefined,
  VECTOR_OPS_GUARD_CAP_COST_100_USD: undefined,
  VECTOR_OPS_GUARD_CAP_COST_200_USD: undefined,
}

let world = new OpsWorld(ENVIRONMENT)
beforeEach(() => {
  world = new OpsWorld(ENVIRONMENT)
})
afterEach(() => {
  setSystemTime()
  world.close()
})

/** Analytics totals that price to `usd` (requests only). */
function spendOf(usd: number): OpsSpend {
  const requests = Math.round((usd / OPS_GUARD.prices.requestsPerMillion) * 1_000_000)
  return { usd, requests, objectRequests: 0, activeMicros: 0, from: monthStart(world.now), to: world.now }
}

const run = (spend?: () => Promise<OpsSpend | undefined>, secret = CRON_SECRET, fetcher = world.fetcher()) =>
  invoke((request, response) => handleOpsGuard(request, response, fetcher, () => world.now, spend ? { spend } : {}), {
    method: "GET",
    authorization: secret,
  })

/** A transition through the ops provisioner, as the outbox runs it. */
async function transition(account: string, to: EntitlementSnapshot, from?: EntitlementSnapshot) {
  // The outbox signs its Worker calls with the real clock.
  setSystemTime(new Date(world.now))
  await opsProvisioner.apply({ account, from, to, cause: "first_payment" }, world.fetcher())
  return to
}

/** The account's Durable Object at the in-memory Worker. */
function objectOf(account: string) {
  for (const entry of world.worker.namespace.objects.values()) {
    const row = entry.state.sql.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'account'")[0]
    if (row && JSON.parse(row.v) === account) return entry
  }
  throw new Error(`no object for ${account}`)
}

/** A subscriber on the roster, with `monitors` On Call URLs at the Worker and `probes` spread over the last day. */
async function subscriber(account: string, plan: PlanId, monitors: number, probes: number) {
  const snapshot = world.seed(account, plan)
  await transition(account, snapshot)
  await opsCall(
    "config",
    {
      account,
      domains: ["shop.example.com"],
      monitors: Array.from({ length: monitors }, (_, index) => ({
        id: `m${index}`,
        url: `https://shop.example.com/page-${index}`,
      })),
    },
    world.fetcher(),
    world.now,
  )
  const sql = objectOf(account).state.sql
  const hour = Math.floor(world.now / HOUR) * HOUR
  for (let index = 0; index < 20; index++)
    sql.rows(
      "INSERT INTO hourly (monitor, hour, ok, failed, inconclusive, ms) VALUES (?, ?, ?, ?, ?, ?)",
      "m0",
      hour - (index + 1) * HOUR,
      Math.floor(probes / 20),
      0,
      0,
      100,
    )
  return snapshot
}

function suspended(account: string) {
  const row = objectOf(account).state.sql.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'suspended'")[0]
  return row ? (JSON.parse(row.v) as { reason: string }).reason : undefined
}

const emails = () => world.fakes.mail.sent.map((mail) => mail.subject)

describe("the budget", () => {
  test("(Max x cap cost + Ultra x cap cost) x 2 + $5, the cap costs overridable by the owner", () => {
    expect(capCost("vector-100")).toBe(0.11)
    expect(capCost("vector-200")).toBe(0.9)
    expect(opsGuardBudget({})).toBe(5)
    expect(opsGuardBudget({ "vector-100": 10, "vector-200": 5 })).toBeCloseTo((10 * 0.11 + 5 * 0.9) * 2 + 5, 10)
    // Plus and Pro have no ops caps: they never count.
    expect(opsGuardBudget({ "vector-10": 1000, "vector-50": 1000 })).toBe(5)
    process.env.VECTOR_OPS_GUARD_CAP_COST_200_USD = "1.5"
    process.env.VECTOR_OPS_GUARD_CAP_COST_100_USD = "not a number"
    expect(capCost("vector-200")).toBe(1.5)
    expect(capCost("vector-100")).toBe(0.11)
    process.env.VECTOR_OPS_GUARD_CAP_COST_100_USD = "500"
    expect(capCost("vector-100")).toBe(0.11)
  })

  test("the roster the provisioner keeps: Max and Ultra while active, renewing or paused; never Pro; ended leaves", async () => {
    const max = await transition(MAX, world.snapshotFor(MAX, "vector-100"))
    await transition(ULTRA, world.snapshotFor(ULTRA, "vector-200", "renewing"))
    await transition(PRO, world.snapshotFor(PRO, "vector-50"))
    expect(await rosterCounts(world.fetcher())).toEqual({ "vector-100": 1, "vector-200": 1 })
    const paused = world.snapshotFor(MAX, "vector-100", "paused", { previous: max })
    await transition(MAX, paused, max)
    expect((await readOpsRoster(world.fetcher())).map((entry) => entry.account).sort()).toEqual([MAX, ULTRA].sort())
    // A retried item changes nothing; the date on the plan stays the first one.
    const since = world.fakes.store.zset(opsRosterKey("vector-100")).get(MAX)
    world.advance(HOUR)
    await transition(MAX, world.snapshotFor(MAX, "vector-100", "active", { previous: paused }), paused)
    expect(world.fakes.store.zset(opsRosterKey("vector-100")).get(MAX)).toBe(since)
    // An upgrade moves the account to Ultra's set, dated from the change.
    const ultra = world.snapshotFor(MAX, "vector-200", "active", { previous: paused })
    await transition(MAX, ultra, paused)
    expect(await rosterCounts(world.fetcher())).toEqual({ "vector-100": 0, "vector-200": 2 })
    await transition(MAX, world.snapshotFor(MAX, "vector-200", "ended", { previous: ultra }), ultra)
    await transition(ULTRA, world.snapshotFor(ULTRA, "vector-200", "frozen"))
    expect(await rosterCounts(world.fetcher())).toEqual({ "vector-100": 0, "vector-200": 0 })
  })
})

describe("Cloudflare's analytics", () => {
  const answer = (data: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(data), { status })) as unknown as typeof fetch
  const body = (workers: number[], objects: number[], active: number[]) => ({
    data: {
      viewer: {
        accounts: [
          {
            workers: workers.map((requests) => ({ sum: { requests } })),
            objects: objects.map((requests) => ({ sum: { requests } })),
            periodic: active.map((activeTime) => ({ sum: { activeTime } })),
          },
        ],
      },
    },
  })

  test("one signed GraphQL request for the month so far, priced at the published rates without included amounts", async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return Response.json(body([4_000_000, 1_000_000], [2_000_000], [3_600_000_000]))
    }) as unknown as typeof fetch
    const spend = await readOpsSpend(fetcher, world.now)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(GRAPHQL_ENDPOINT)
    expect(seen[0]!.init.redirect).toBe("error")
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe(`Bearer ${ANALYTICS_TOKEN}`)
    const request = JSON.parse(String(seen[0]!.init.body))
    expect(request.variables).toEqual({
      account: ACCOUNT_ID,
      script: "vector-ops",
      namespace: NAMESPACE,
      start: new Date(Date.UTC(2026, 10, 1)).toISOString(),
      end: new Date(world.now).toISOString(),
    })
    for (const dataset of [
      "workersInvocationsAdaptive",
      "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups",
    ])
      expect(request.query).toContain(dataset)
    // 5M requests, 2M object requests, an hour of active time at 128 MB.
    const expected = 5 * 0.3 + 2 * 0.15 + ((3600 * 0.125) / 1_000_000) * 12.5
    expect(spend).toMatchObject({ requests: 5_000_000, objectRequests: 2_000_000, activeMicros: 3_600_000_000 })
    expect(spend!.usd).toBeCloseTo(expected, 10)
    expect(priceSpend({ requests: 0, objectRequests: 0, activeMicros: 0 })).toBe(0)
  })

  test("anything unexpected reads as no spend: errors, refusals, missing fields, odd values, no settings", async () => {
    expect(
      await readOpsSpend(answer({ errors: [{ message: "unknown field" }], data: null }), world.now),
    ).toBeUndefined()
    expect(await readOpsSpend(answer(body([1], [1], [1]), 403), world.now)).toBeUndefined()
    expect(await readOpsSpend(answer({ data: { viewer: { accounts: [] } } }), world.now)).toBeUndefined()
    expect(await readOpsSpend(answer(body([-1], [1], [1])), world.now)).toBeUndefined()
    expect(
      await readOpsSpend(answer({ data: { viewer: { accounts: [{ workers: [], objects: [] }] } } }), world.now),
    ).toBeUndefined()
    expect(
      await readOpsSpend(
        (async () => {
          throw new Error("unreachable")
        }) as unknown as typeof fetch,
        world.now,
      ),
    ).toBeUndefined()
    let called = false
    delete process.env.VECTOR_OPS_CF_ANALYTICS_TOKEN
    expect(analyticsConfiguration()).toBeUndefined()
    expect(
      await readOpsSpend(
        (async () => {
          called = true
          return Response.json(body([1], [1], [1]))
        }) as unknown as typeof fetch,
        world.now,
      ),
    ).toBeUndefined()
    expect(called).toBe(false)
    process.env.VECTOR_OPS_CF_ANALYTICS_TOKEN = ANALYTICS_TOKEN
    // The account id may come from the R2 settings (the same Cloudflare account).
    delete process.env.VECTOR_OPS_CF_ACCOUNT_ID
    process.env.VECTOR_R2_ACCOUNT_ID = ACCOUNT_ID
    expect(analyticsConfiguration()).toMatchObject({ accountId: ACCOUNT_ID, script: "vector-ops" })
    process.env.VECTOR_OPS_CF_NAMESPACE_ID = "not-a-namespace"
    expect(analyticsConfiguration()).toBeUndefined()
  })
})

describe("an account's own expected usage", () => {
  test("monitors at the plan's interval, release watches, a margin; a recent plan change counts at the fastest rate", () => {
    const now = NOW
    const hour = Math.floor(now / HOUR) * HOUR
    const state = (probes: number, monitors = 5, releases: unknown[] = []) => ({
      monitors: Array.from({ length: monitors }, (_, index) => ({ id: `m${index}` })),
      hourly: [{ monitor: "m0", hour: hour - HOUR, ok: probes, failed: 0, inconclusive: 0 }],
      releases,
    })
    const old = { plan: "vector-100" as PlanId, since: now - 30 * DAY }
    // Max: every 5 minutes, 25 hours → 300 rounds + 1 per monitor.
    expect(accountUsage(old, state(1505), now)).toEqual({ observed: 1505, expected: 1505, above: false })
    // Above means past 1.25 times that plus 12: 1893.25.
    expect(accountUsage(old, state(1893), now)!.above).toBe(false)
    expect(accountUsage(old, state(1894), now)!.above).toBe(true)
    // Rows older than the window do not count.
    const stale = state(10_000)
    stale.hourly[0]!.hour = hour - 30 * HOUR
    expect(accountUsage(old, stale, now)).toMatchObject({ observed: 0, above: false })
    // A release watched in the window adds its rounds at the plan's paths.
    const watched = accountUsage(old, state(0, 5, [{ at: now - HOUR, state: "passed" }]), now)!
    expect(watched.expected).toBe(1505 + 5 * (60 + 2))
    expect(accountUsage(old, state(0, 5, [{ at: now - HOUR, state: "skipped" }]), now)!.expected).toBe(1505)
    // Changed plan within the window (a downgrade from Ultra): Ultra's minute.
    expect(accountUsage({ plan: "vector-100", since: now - HOUR }, state(0, 1), now)!.expected).toBe(1501)
    expect(accountUsage(old, { monitors: "x" }, now)).toBeUndefined()
    expect(accountUsage(old, { ...state(1), hourly: [{ monitor: "m0", hour, ok: -1 }] }, now)).toBeUndefined()
  })
})

describe("the guard's run", () => {
  test("needs the cron secret; nothing without the ops services; nothing while the ops switch is off", async () => {
    expect((await run(undefined, "wrong-secret")).status).toBe(401)
    world.switchOff("ops")
    expect((await run(async () => spendOf(100))).body).toMatchObject({ enabled: true, switchedOff: true, held: 0 })
    delete process.env.VECTOR_OPS_WORKER_URL
    expect((await run(async () => spendOf(100))).body).toMatchObject({ enabled: false, held: 0 })
  })

  test("under 75%: nothing to say; at 75%: one email a month; the answer never carries a dollar figure", async () => {
    await subscriber(MAX, "vector-100", 1, 100)
    await subscriber(ULTRA, "vector-200", 1, 100)
    const budget = opsGuardBudget({ "vector-100": 1, "vector-200": 1 })
    const low = await run(async () => spendOf(budget * 0.5))
    expect(low.body).toMatchObject({
      enabled: true,
      level: "ok",
      share: 0.5,
      counts: { "vector-100": 1, "vector-200": 1 },
    })
    expect(emails()).toEqual([])
    const high = await run(async () => spendOf(budget * 0.8))
    expect(high.body).toMatchObject({ level: "alert", share: 0.8, held: 0 })
    expect(emails()).toEqual(["Vector ops guard: 80% of this month's budget"])
    expect(world.fakes.mail.sent[0]!.text).toContain(`of a $${budget.toFixed(2)} budget`)
    await run(async () => spendOf(budget * 0.9))
    expect(emails()).toHaveLength(1)
    expect(JSON.stringify(high.body)).not.toMatch(/\$|usd|cents|credit/i)
    expect(suspended(MAX)).toBeUndefined()
  })

  test("at 100%: only accounts above their own usage are held, once; under budget again, every hold is released", async () => {
    // Two Max subscribers with one monitor each: one probing as its plan explains, one far beyond it; Ultra quiet.
    await subscriber(MAX, "vector-100", 1, 280)
    await subscriber(SECOND_MAX, "vector-100", 1, 4_000)
    await subscriber(ULTRA, "vector-200", 2, 0)
    const budget = opsGuardBudget({ "vector-100": 2, "vector-200": 1 })
    const over = await run(async () => spendOf(budget * 1.2))
    expect(over.body).toMatchObject({ level: "hold", checked: 3, held: 1, failures: 0 })
    expect(suspended(SECOND_MAX)).toBe("guard")
    expect(suspended(MAX)).toBeUndefined()
    expect(suspended(ULTRA)).toBeUndefined()
    expect([...world.fakes.store.zset(opsGuardHeldKey()).keys()]).toEqual([SECOND_MAX])
    expect(emails()).toEqual(["Vector ops guard: this month's budget is used"])

    // Ten minutes later, still over: accounts checked within the hour are not read again.
    world.advance(10 * 60_000)
    const states = world.worker.actions.filter((action) => action === "state").length
    expect((await run(async () => spendOf(budget * 1.3))).body).toMatchObject({ level: "hold", checked: 0, held: 0 })
    expect(world.worker.actions.filter((action) => action === "state").length).toBe(states)
    expect(emails()).toHaveLength(1)

    // An hour on, they are read again; the held account is not read while held.
    world.advance(HOUR)
    expect((await run(async () => spendOf(budget * 1.3))).body).toMatchObject({ checked: 2, held: 0 })

    // A new month: the spend is back under the budget, and the hold is lifted at the Worker.
    world.advance(30 * DAY)
    expect((await run(async () => spendOf(1))).body).toMatchObject({ level: "ok", released: 1 })
    expect(suspended(SECOND_MAX)).toBeUndefined()
    expect(world.fakes.store.zset(opsGuardHeldKey()).size).toBe(0)
    expect(world.fakes.store.zset(opsGuardCheckedKey()).size).toBe(3)
  })

  test("a held account that left the roster is only forgotten, never written to at the Worker", async () => {
    const max = await subscriber(SECOND_MAX, "vector-100", 1, 4_000)
    const budget = opsGuardBudget({ "vector-100": 1 })
    expect((await run(async () => spendOf(budget * 2))).body).toMatchObject({ held: 1 })
    await transition(SECOND_MAX, world.snapshotFor(SECOND_MAX, "vector-100", "ended", { previous: max }), max)
    const suspends = world.worker.actions.filter((action) => action === "suspend").length
    expect((await run(async () => spendOf(1))).body).toMatchObject({ released: 1 })
    expect(world.worker.actions.filter((action) => action === "suspend").length).toBe(suspends)
  })

  test("the Worker unreachable for one account counts a failure and holds nothing", async () => {
    await subscriber(SECOND_MAX, "vector-100", 1, 4_000)
    world.worker.down = true
    const budget = opsGuardBudget({ "vector-100": 1 })
    expect((await run(async () => spendOf(budget * 2))).body).toMatchObject({ level: "hold", held: 0, failures: 1 })
    world.worker.down = false
  })

  test("without analytics nothing is held or released, and the owner hears why (once a day, or once a month)", async () => {
    await subscriber(SECOND_MAX, "vector-100", 1, 4_000)
    const graphql = (status: number) => {
      const base = world.fetcher()
      return (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === GRAPHQL_ENDPOINT
          ? new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status })
          : base(input, init)) as typeof fetch
    }
    expect((await run(undefined, CRON_SECRET, graphql(200))).body).toMatchObject({ level: "unknown", held: 0 })
    expect((await run(undefined, CRON_SECRET, graphql(500))).body).toMatchObject({ level: "unknown" })
    expect(emails()).toEqual(["Vector ops guard: Cloudflare's analytics could not be read"])
    expect(suspended(SECOND_MAX)).toBeUndefined()
    delete process.env.VECTOR_OPS_CF_ANALYTICS_TOKEN
    expect((await run(undefined, CRON_SECRET, graphql(200))).body).toMatchObject({ level: "unknown" })
    expect(emails()).toEqual([
      "Vector ops guard: Cloudflare's analytics could not be read",
      "Vector ops guard: Cloudflare's analytics are not set up",
    ])
  })

  test("a hold never outlives its month: with the analytics unreadable, last month's holds are released", async () => {
    await subscriber(SECOND_MAX, "vector-100", 1, 4_000)
    const budget = opsGuardBudget({ "vector-100": 1 })
    expect((await run(async () => spendOf(budget * 2))).body).toMatchObject({ held: 1 })
    expect(suspended(SECOND_MAX)).toBe("guard")
    // Later the same month, unreadable: the hold stays.
    world.advance(HOUR)
    expect((await run(async () => undefined)).body).toMatchObject({ level: "unknown", released: 0 })
    expect(suspended(SECOND_MAX)).toBe("guard")
    // The next month, still unreadable: the budget starts over, so the hold ends.
    world.advance(monthStart(world.now) + 32 * DAY - world.now)
    expect((await run(async () => undefined)).body).toMatchObject({ level: "unknown", released: 1, held: 0 })
    expect(suspended(SECOND_MAX)).toBeUndefined()
    expect(world.fakes.store.zset(opsGuardHeldKey()).size).toBe(0)
  })

  test("the real analytics path end to end: the GraphQL answer prices the month and decides the level", async () => {
    await subscriber(MAX, "vector-100", 1, 100)
    const base = world.fetcher()
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === GRAPHQL_ENDPOINT
        ? Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    workers: [{ sum: { requests: 18_000_000 } }],
                    objects: [{ sum: { requests: 0 } }],
                    periodic: [{ sum: { activeTime: 0 } }],
                  },
                ],
              },
            },
          })
        : base(input, init)) as typeof fetch
    // $5.40 of usage against a budget of 5 + 2 x 0.11 = $5.22: over.
    expect((await run(undefined, CRON_SECRET, fetcher)).body).toMatchObject({ level: "hold", share: 1.03, held: 0 })
  })
})
