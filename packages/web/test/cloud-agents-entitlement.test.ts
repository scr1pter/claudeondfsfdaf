import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  cloudAgentEntitlement,
  cloudAgentRevokedBefore,
  createCloudAgentEntitlement,
  ENABLED_SOURCES,
  RUN_SOURCES,
  type CloudAgentAllowance,
  type CloudAgentLimits,
  type CodiumPlanId,
  type RunSource,
} from "../../../api/_lib/cloud-agents-entitlement"
import { codiumKey } from "../../../api/_lib/codium-keys"
import { buildSnapshot, snapshotKey, type EntitlementSnapshot } from "../../../api/_lib/codium-snapshot"
import { MODEL_SPEND_SCRIPTS } from "../../../api/_lib/codium-spend-ledger"
import { CodiumPlan } from "../../schema/src/codium-plan"
import { FakeClock, FakeStore } from "./fixture/codium-fakes"

// The @vector entitlement seam (vector-at-mention-spec 2.3, V04). Codium's A59 deletes the module's local backing and
// this test together, and its contract test takes these assertions over (INV-K3). Limits are read through the seam's
// results only, never through the module's table.

type PlanAnswer = Awaited<ReturnType<Parameters<typeof createCloudAgentEntitlement>[0]["plan"]>>

// Each plan's values, from the contract's 1.1 table and the Codium contract's §4.1 `cloudAgents` row.
const EXPECTED = {
  "vector-10": {
    limits: { atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, runCeilingShare: 0.1 },
    allowanceSeconds: 18_000,
    premiumModels: false,
  },
  "vector-50": {
    limits: { atOnce: 1, hours: 15, longestRunMin: 45, scheduledPerDay: 0, runCeilingShare: 0.1 },
    allowanceSeconds: 54_000,
    premiumModels: false,
  },
  "vector-100": {
    limits: { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
    allowanceSeconds: 144_000,
    premiumModels: true,
  },
  "vector-200": {
    limits: { atOnce: 6, hours: 120, longestRunMin: 120, scheduledPerDay: 20, runCeilingShare: 0.1 },
    allowanceSeconds: 432_000,
    premiumModels: true,
  },
} as const

// 2026-10-14T09:30:00Z and 2026-11-14T09:30:00Z, in milliseconds.
const START = 1_791_970_200_000
const END = 1_794_648_600_000
const NOW = START + 86_400_000
const KV = "https://kv.fixture.invalid"
const OPENROUTER = "https://openrouter.ai"

// CI runs this file in one Bun process after the GitHub API tests, so it assumes nothing about the environment it
// starts in, and puts back what it found.
const ENVIRONMENT = [
  "MODEL_PLANS_ENABLED",
  "VECTOR_CLOUD_AGENTS_ENABLED",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_CREDIT_MARKUP_PERCENT",
  ...CodiumPlan.PLANS.flatMap((plan) => [
    `MODEL_PLAN_${plan.price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${plan.price}_PRICE_ID`,
  ]),
]
const previous = new Map(ENVIRONMENT.map((name) => [name, process.env[name]]))
beforeEach(() => ENVIRONMENT.forEach((name) => delete process.env[name]))
afterEach(() => {
  ENVIRONMENT.forEach((name) => delete process.env[name])
  previous.forEach((value, name) => {
    if (value !== undefined) process.env[name] = value
  })
})

describe("the entitlement seam's local backing", () => {
  test("each plan's values, with the epoch and the period end in ms", async () => {
    expect(CodiumPlan.PLANS.map((plan) => plan.id)).toEqual(Object.keys(EXPECTED) as CodiumPlanId[])
    const results = await perPlan()
    expect(results).toStrictEqual(
      CodiumPlan.PLANS.map((plan) => ({
        active: true,
        plan: plan.id,
        limits: EXPECTED[plan.id].limits,
        allowanceSeconds: EXPECTED[plan.id].allowanceSeconds,
        meterEpoch: "p1791970200000",
        periodEnd: 1_794_648_600_000,
        premiumModels: EXPECTED[plan.id].premiumModels,
      })),
    )
    // The exact shape: nothing more, and no revokedBefore before A59.
    expect(results.map((result) => Object.keys(result).sort())).toEqual(
      results.map(() => ["active", "allowanceSeconds", "limits", "meterEpoch", "periodEnd", "plan", "premiumModels"]),
    )
    expect(results.map((result) => Object.keys(granted(result).limits).sort())).toEqual(
      results.map(() => ["atOnce", "hours", "longestRunMin", "runCeilingShare", "scheduledPerDay"]),
    )
  })

  test("INV-K3: no cap falls from Plus to Ultra, at once is at least 1, Plus and Pro schedule nothing, no key is an amount", async () => {
    const results = await perPlan()
    const limits = results.map((result) => granted(result).limits)
    const names = ["atOnce", "hours", "longestRunMin", "scheduledPerDay", "runCeilingShare"] as const
    expect(Object.keys(limits[0]!).sort()).toEqual([...names].sort())
    expect(
      Object.fromEntries(
        names.map((name) => [
          name,
          limits.every((entry, index) => index === 0 || entry[name] >= limits[index - 1]![name]),
        ]),
      ),
    ).toEqual(Object.fromEntries(names.map((name) => [name, true])))
    expect(limits.map((entry) => entry.atOnce >= 1)).toEqual([true, true, true, true])
    expect(
      results.flatMap((result) => (granted(result).limits.scheduledPerDay === 0 ? [granted(result).plan] : [])),
    ).toEqual(["vector-10", "vector-50"])
    expect(limits.map((entry) => entry.runCeilingShare > 0 && entry.runCeilingShare <= 1)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(
      [...results, ...(await refusals())].flatMap(keysOf).filter((key) => /usd|price|credit|cost|\$/i.test(key)),
    ).toEqual([])
  })

  test("INV-P2: no result carries an amount", async () => {
    const answers = [...(await perPlan()), ...(await refusals())]
    expect(answers.flatMap((answer) => (answer.active ? [] : [answer.reason]))).toEqual([
      "service-off",
      "source-unavailable",
      "none",
      "closing",
    ])
    expect(
      answers.map((answer) => JSON.stringify(answer)).filter((json) => /\$|usd|credit|cents|price|cost/i.test(json)),
    ).toEqual([])
  })

  test("service-off from either switch, before any store read", async () => {
    process.env.KV_REST_API_URL = KV
    process.env.KV_REST_API_TOKEN = "fixture-kv-token"
    const values = [undefined, "1", "TRUE", "true"]
    const switches = values
      .flatMap((plans) => values.map((agents) => ({ plans, agents })))
      .filter((pair) => pair.plans !== "true" || pair.agents !== "true")
    expect(switches).toHaveLength(15)
    const store = backend({})
    const account = randomUUID()
    const answers: CloudAgentAllowance[] = []
    // One combination at a time: the switches are process-wide.
    for (const pair of switches) {
      setSwitch("MODEL_PLANS_ENABLED", pair.plans)
      setSwitch("VECTOR_CLOUD_AGENTS_ENABLED", pair.agents)
      answers.push(await cloudAgentEntitlement(account, { source: "github-comment" }, store.fetcher))
    }
    expect(answers).toStrictEqual(switches.map(() => ({ active: false, reason: "service-off" })))
    expect(store.requests).toEqual([])

    // With both on, an account Codium has never seen has no plan, and only the store was asked.
    process.env.MODEL_PLANS_ENABLED = "true"
    process.env.VECTOR_CLOUD_AGENTS_ENABLED = "true"
    expect(await cloudAgentEntitlement(account, { source: "github-comment" }, store.fetcher)).toStrictEqual({
      active: false,
      reason: "none",
    })
    expect(store.requests.length).toBeGreaterThan(0)
    expect(store.requests.filter((request) => request.origin !== KV || request.command[0] !== "GET")).toEqual([])
  })

  test("each reserved or unknown source is source-unavailable before any plan read, and service-off comes first", async () => {
    expect(RUN_SOURCES).toEqual([
      "desktop",
      "cli",
      "phone",
      "schedule",
      "ops",
      "github-comment",
      "github-dispatch",
      "github-schedule",
      "slack",
      "linear",
      "jira",
    ])
    expect([...ENABLED_SOURCES]).toEqual([
      "desktop",
      "cli",
      "phone",
      "schedule",
      "ops",
      "github-comment",
      "github-dispatch",
      "github-schedule",
    ])
    const account = randomUUID()
    const on = seam(() => active("vector-200"))
    const refused = await Promise.all(
      ["slack", "linear", "jira", "github-review", "__proto__", "constructor", ""].map((source) =>
        on.entitlement(account, { source: source as RunSource, now: NOW }),
      ),
    )
    expect(refused).toStrictEqual(refused.map(() => ({ active: false, reason: "source-unavailable" })))
    expect(on.calls).toEqual([])
    const allowed = await Promise.all(
      [...ENABLED_SOURCES].map((source) => on.entitlement(account, { source, now: NOW })),
    )
    expect(allowed.map((answer) => answer.active)).toEqual([...ENABLED_SOURCES].map(() => true))

    const off = seam(
      () => active("vector-200"),
      () => false,
    )
    expect(await off.entitlement(account, { source: "slack", now: NOW })).toStrictEqual({
      active: false,
      reason: "service-off",
    })
    expect(off.calls).toEqual([])

    // The real default, with both switches on, refuses a reserved source before reading the store.
    process.env.MODEL_PLANS_ENABLED = "true"
    process.env.VECTOR_CLOUD_AGENTS_ENABLED = "true"
    process.env.KV_REST_API_URL = KV
    process.env.KV_REST_API_TOKEN = "fixture-kv-token"
    const store = backend({})
    expect(await cloudAgentEntitlement(randomUUID(), { source: "jira" }, store.fetcher)).toStrictEqual({
      active: false,
      reason: "source-unavailable",
    })
    expect(store.requests).toEqual([])
  })

  test("inactive is none, closing is closing, and a plan the table does not hold grants nothing", async () => {
    const answers: PlanAnswer[] = [
      { active: false },
      { active: false, closing: true },
      { active: false, closing: false },
      ...["vector-1000", "toString", "__proto__", "constructor", "hasOwnProperty"].map((plan) =>
        active(plan as CodiumPlanId),
      ),
    ]
    const results = await Promise.all(
      answers.map((answer) => seam(() => answer).entitlement(randomUUID(), { source: "github-comment", now: NOW })),
    )
    expect(results).toStrictEqual([
      { active: false, reason: "none" },
      { active: false, reason: "closing" },
      { active: false, reason: "none" },
      ...answers.slice(3).map(() => ({ active: false, reason: "none" }) as const),
    ])
  })

  test("a closing account (from readModelPlanAccount) is closing after one store read and no billing read", async () => {
    process.env.MODEL_PLANS_ENABLED = "true"
    process.env.VECTOR_CLOUD_AGENTS_ENABLED = "true"
    process.env.KV_REST_API_URL = KV
    process.env.KV_REST_API_TOKEN = "fixture-kv-token"
    const account = randomUUID()
    const store = backend({ [account]: { customer: "cus_fixture", closing: true } })
    expect(await cloudAgentEntitlement(account, { source: "github-dispatch" }, store.fetcher)).toStrictEqual({
      active: false,
      reason: "closing",
    })
    expect(store.requests).toHaveLength(1)
    expect(store.requests[0]).toMatchObject({ origin: KV, command: ["GET", expect.stringContaining(account)] })
  })

  // The only production path before A59, so the units V06's ledger and V07's tokens build on are pinned here: Stripe
  // gives the period in seconds; the snapshot and the seam keep it in milliseconds. This account has no monthly
  // key yet (neither the payment webhook nor a model request has provisioned one), the one state in which the default
  // reads no OpenRouter key.
  test("an active Max plan through the default, before its monthly key exists: the epoch and the period end in ms, and no OpenRouter read", async () => {
    const paid = maxPlan()
    const store = backend({ [paid.account]: { customer: "cus_fixture" } }, [paid.snapshot])
    expect(await cloudAgentEntitlement(paid.account, { source: "github-comment" }, store.fetcher)).toStrictEqual(
      paid.allowance,
    )
    expect(store.requests.filter((request) => request.origin !== KV)).toEqual([])
    expect(store.requests.filter((request) => request.origin === KV && request.command[0] !== "GET")).toEqual([])
  })

  // The usual paid state: once the payment webhook or a first model request has provisioned it, the account holds this
  // period's monthly key, and modelPlanStatus reads that key's usage from OpenRouter's management API on every uncached
  // call (contract 2.3; the deviations file's Contract section, item 8). If OpenRouter cannot answer, the call rejects
  // and the caller fails closed; the failure is not cached.
  test("an active Max plan whose monthly key exists: an OpenRouter failure rejects, then one read grants the same allowance", async () => {
    const paid = maxPlan()
    const key = { hash: "hash_fixture_max", encrypted: "fixture-encrypted", credits: 50, creditsMicro: 50_000_000 }
    const store = backend({}, [paid.snapshot], { [key.hash]: { hash: key.hash, disabled: false, usage: 12.5 } })
    const period = { subscription: "sub_fixture_max", start: paid.start, end: paid.end }
    store.store.set(
      codiumKey("account", paid.account),
      JSON.stringify({
        customer: "cus_fixture",
        key: {
          ...key,
          ...period,
          spendGenesis: store.store.seedSpendGenesis({ account: paid.account, pool: key.hash, ...period }),
        },
      }),
    )
    const openRouterRequests = () => store.requests.filter((request) => request.origin === OPENROUTER)
    store.openRouter.status = 503
    await expect(
      cloudAgentEntitlement(paid.account, { source: "github-comment" }, store.fetcher),
    ).rejects.toMatchObject({ statusCode: 503, code: "MODEL_PLAN_UPSTREAM" })
    expect(openRouterRequests()).toHaveLength(1)
    store.openRouter.status = 200
    expect(await cloudAgentEntitlement(paid.account, { source: "github-comment" }, store.fetcher)).toStrictEqual(
      paid.allowance,
    )
    // One read of the period's key per call, and never a write: no key is created, disabled or changed.
    expect(openRouterRequests()).toEqual(
      Array.from({ length: 2 }, () => ({
        origin: OPENROUTER,
        path: `/api/v1/keys/${key.hash}`,
        method: "GET",
        command: [],
      })),
    )
    expect(store.requests.filter((request) => request.origin !== KV && request.origin !== OPENROUTER)).toEqual([])
    expect(
      store.requests
        .filter((request) => request.origin === KV && request.command[0] !== "GET")
        .map((request) => request.command.slice(0, 2)),
    ).toEqual([
      ["EVAL", MODEL_SPEND_SCRIPTS.READ],
      ["EVAL", MODEL_SPEND_SCRIPTS.DAY],
    ])
  })
})

describe("the 60-s per-account plan cache", () => {
  test("a second call within 60 s makes no second plan() call; another account or an expired read asks again", async () => {
    const { entitlement, calls } = seam(() => active("vector-50"))
    await entitlement("a", { source: "github-comment", now: NOW })
    await entitlement("a", { source: "github-dispatch", now: NOW + 59_999 })
    expect(calls).toEqual(["a"])
    await entitlement("a", { source: "github-comment", now: NOW + 60_000 })
    expect(calls).toEqual(["a", "a"])
    await entitlement("b", { source: "github-comment", now: NOW + 60_000 })
    expect(calls).toEqual(["a", "a", "b"])
    // A call dated before the cached read cannot tell how old it is, so it asks again.
    await entitlement("b", { source: "github-comment", now: NOW + 59_999 })
    expect(calls).toEqual(["a", "a", "b", "b"])
  })

  test("parallel calls share one plan() call", async () => {
    const gate = Promise.withResolvers<PlanAnswer>()
    const { entitlement, calls } = seam(() => gate.promise)
    const answers = Promise.all(
      ["github-comment", "github-dispatch", "github-schedule"].map((source) =>
        entitlement("a", { source: source as RunSource, now: NOW }),
      ),
    )
    gate.resolve(active("vector-100"))
    expect((await answers).map((answer) => granted(answer).plan)).toEqual(["vector-100", "vector-100", "vector-100"])
    expect(calls).toEqual(["a"])
  })

  test("a failed read is not kept: that call rejects and the next one asks again", async () => {
    const failures = [new Error("store unavailable")]
    const { entitlement, calls } = seam(() => {
      const failure = failures.shift()
      if (failure) throw failure
      return active("vector-10")
    })
    await expect(entitlement("a", { source: "github-comment", now: NOW })).rejects.toThrow("store unavailable")
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW + 1 })).plan).toBe("vector-10")
    expect(calls).toEqual(["a", "a"])
  })

  test("the switch and the reserved sources win over a warm cache", async () => {
    const state = { on: true }
    const { entitlement, calls } = seam(
      () => active("vector-200"),
      () => state.on,
    )
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW })).plan).toBe("vector-200")
    state.on = false
    expect(await entitlement("a", { source: "github-comment", now: NOW + 1 })).toStrictEqual({
      active: false,
      reason: "service-off",
    })
    state.on = true
    expect(await entitlement("a", { source: "slack", now: NOW + 2 })).toStrictEqual({
      active: false,
      reason: "source-unavailable",
    })
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW + 3 })).plan).toBe("vector-200")
    expect(calls).toEqual(["a"])
  })

  test("a slow read that fails after a newer read replaced it leaves the newer one cached", async () => {
    const slow = Promise.withResolvers<PlanAnswer>()
    const queue = [slow.promise]
    const { entitlement, calls } = seam(() => queue.shift() ?? active("vector-100"))
    const first = entitlement("a", { source: "github-comment", now: NOW })
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW + 60_000 })).plan).toBe("vector-100")
    slow.reject(new Error("late store failure"))
    await expect(first).rejects.toThrow("late store failure")
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW + 60_001 })).plan).toBe("vector-100")
    expect(calls).toEqual(["a", "a"])
  })

  test("each result is the caller's own: changing one changes no later result", async () => {
    const { entitlement } = seam(() => active("vector-100"))
    const first = granted(await entitlement("a", { source: "github-comment", now: NOW }))
    first.limits.atOnce = 99
    first.limits.hours = 0
    expect(granted(await entitlement("a", { source: "github-comment", now: NOW + 1 })).limits).toStrictEqual(
      EXPECTED["vector-100"].limits,
    )
    expect(granted(await entitlement("b", { source: "github-comment", now: NOW + 1 })).limits).toStrictEqual(
      EXPECTED["vector-100"].limits,
    )
  })
})

// The seam's shapes as the contract's 2.3 writes them, and the functions A59 plugs in as Codium declares them (§4.18,
// codium-provisioners.ts, codium-run-trigger.ts). A change on either side fails the web typecheck, which checks this
// file; bun test does not check types.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type CodiumRunSource =
  | "desktop"
  | "cli"
  | "phone"
  | "schedule"
  | "ops"
  | "github-comment"
  | "github-dispatch"
  | "github-schedule"
  | "slack"
  | "linear"
  | "jira"
type Section23Allowance =
  | {
      active: true
      plan: CodiumPlanId
      limits: { atOnce: number; hours: number; longestRunMin: number; scheduledPerDay: number; runCeilingShare: number }
      allowanceSeconds: number
      meterEpoch: string
      periodEnd: number
      premiumModels: boolean
      revokedBefore?: number
    }
  | {
      active: false
      reason:
        | "none"
        | "payment"
        | "dispute"
        | "fraud"
        | "closing"
        | "service-off"
        | "source-unavailable"
        | "not-in-plan"
    }
type CodiumAllowance =
  | {
      active: true
      plan: (typeof CodiumPlan.PLANS)[number]["id"]
      limits: {
        readonly atOnce: number
        readonly hours: number
        readonly longestRunMin: number
        readonly scheduledPerDay: number
        readonly runCeilingShare: number
      }
      allowanceSeconds: number
      meterEpoch: string
      periodEnd: number
      premiumModels: boolean
      revokedBefore?: number
    }
  | {
      active: false
      reason:
        | "none"
        | "payment"
        | "dispute"
        | "fraud"
        | "closing"
        | "service-off"
        | "source-unavailable"
        | "not-in-plan"
    }
type CloudAgentAllowanceFunction = (
  accountId: string,
  input: { source: CodiumRunSource; now?: number },
  fetcher?: typeof fetch,
) => Promise<CodiumAllowance>
type RunTokensRevokedBefore = (account: string, fetcher?: typeof fetch) => Promise<number | undefined>

describe("the seams A59 swaps", () => {
  test("revokedBefore seam", async () => {
    const store = backend({})
    expect(
      await Promise.all([
        cloudAgentRevokedBefore(randomUUID()),
        cloudAgentRevokedBefore(randomUUID(), store.fetcher),
        cloudAgentRevokedBefore(randomUUID(), store.fetcher),
      ]),
    ).toEqual([undefined, undefined, undefined])
    expect(store.requests).toEqual([])
    // Codium's runTokensRevokedBefore has exactly this type, so A59 swaps the body and every consumer that injects a
    // fake typed `typeof cloudAgentRevokedBefore` (V07, V12) keeps compiling.
    const shape: Equal<typeof cloudAgentRevokedBefore, RunTokensRevokedBefore> = true
    expect(shape).toBe(true)
  })

  test("the entitlement seam has 2.3's shape, and Codium's cloudAgentAllowance drops in", () => {
    const shapes: [
      Equal<CloudAgentAllowance, Section23Allowance>,
      Equal<CloudAgentLimits, Extract<Section23Allowance, { active: true }>["limits"]>,
      Equal<CodiumPlanId, (typeof CodiumPlan.PLANS)[number]["id"]>,
      Equal<RunSource, CodiumRunSource>,
      // Codium's limits are readonly and its plan id comes from CodiumPlan, so the allowance types match both ways
      // rather than being identical.
      Mutual<CloudAgentAllowance, CodiumAllowance>,
      Mutual<typeof cloudAgentEntitlement, CloudAgentAllowanceFunction>,
      Mutual<ReturnType<typeof createCloudAgentEntitlement>, CloudAgentAllowanceFunction>,
    ] = [true, true, true, true, true, true, true]
    expect(shapes).toEqual([true, true, true, true, true, true, true])
  })

  // INV-K3: only the module itself names its table, so A59 can delete it with this test and break nothing else.
  test("no file in api/ or packages/ other than the module and this test names CLOUD_AGENT_LIMITS", () => {
    const root = path.join(import.meta.dir, "../../..")
    const files = ["api", "packages"].flatMap((directory) => sources(path.join(root, directory)))
    // A walk that missed a tree, or found nothing, would pass the check below vacuously.
    expect(files.length).toBeGreaterThan(1000)
    expect(files).toEqual(
      expect.arrayContaining([
        path.join(root, "api/_lib/model-plan-account.ts"),
        path.join(root, "packages/core/src/github-agents.ts"),
        path.join(root, "packages/web/src/pages/docs/vectorscope.astro"),
        import.meta.path,
      ]),
    )
    expect(
      files
        .filter((file) => /\bCLOUD_AGENT_LIMITS\b/.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(root, file))
        .sort(),
    ).toEqual(["api/_lib/cloud-agents-entitlement.ts", "packages/web/test/cloud-agents-entitlement.test.ts"])
  })
})

function active(plan: CodiumPlanId): PlanAnswer {
  return { active: true, plan, periodStart: START, periodEnd: END }
}

function granted(answer: CloudAgentAllowance) {
  if (!answer.active) throw new Error(`Expected an allowance, got ${answer.reason}`)
  return answer
}

/** The seam over an injected plan source that records each account it was asked about. */
function seam(answer: () => PlanAnswer | Promise<PlanAnswer>, enabled = () => true) {
  const calls: string[] = []
  const entitlement = createCloudAgentEntitlement({
    enabled,
    plan: async (accountId) => {
      calls.push(accountId)
      return answer()
    },
  })
  return { entitlement, calls }
}

function perPlan() {
  return Promise.all(
    CodiumPlan.PLANS.map((plan) =>
      seam(() => active(plan.id)).entitlement(randomUUID(), { source: "github-comment", now: NOW }),
    ),
  )
}

/** One result for each refusal the local backing can give. */
function refusals() {
  return Promise.all([
    seam(
      () => active("vector-200"),
      () => false,
    ).entitlement(randomUUID(), { source: "github-comment", now: NOW }),
    seam(() => active("vector-200")).entitlement(randomUUID(), { source: "linear", now: NOW }),
    seam(() => ({ active: false })).entitlement(randomUUID(), { source: "github-comment", now: NOW }),
    seam(() => ({ active: false, closing: true })).entitlement(randomUUID(), { source: "github-comment", now: NOW }),
  ])
}

function keysOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => [key, ...keysOf(entry)])
}

function setSwitch(name: string, value: string | undefined) {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

/**
 * Exact account/snapshot keys and the shared ledger fake, behind an injected fetcher. Only GET and the two ledger
 * read scripts are accepted; account reconciliation, provider writes and every other external request fail closed.
 */
function backend(
  accounts: Record<string, unknown>,
  snapshots: EntitlementSnapshot[] = [],
  keys: Record<string, unknown> = {},
) {
  const store = new FakeStore(new FakeClock())
  Object.entries(accounts).forEach(([account, value]) =>
    store.set(codiumKey("account", account), JSON.stringify(value)),
  )
  snapshots.forEach((snapshot) => store.set(snapshotKey(snapshot.account), JSON.stringify(snapshot)))
  const requests: { origin: string; path: string; method: string; command: unknown[] }[] = []
  const openRouter = { status: 200 }
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      if (url.origin === OPENROUTER) {
        requests.push({ origin: url.origin, path: url.pathname, method, command: [] })
        if (openRouter.status !== 200) return new Response(null, { status: openRouter.status })
        const hash = url.pathname.startsWith("/api/v1/keys/") ? url.pathname.slice("/api/v1/keys/".length) : ""
        if (method !== "GET" || !Object.hasOwn(keys, hash)) return new Response(null, { status: 404 })
        return Response.json({ data: keys[hash] })
      }
      if (url.origin !== KV) {
        requests.push({ origin: url.origin, path: url.pathname, method, command: [] })
        return new Response(null, { status: 404 })
      }
      const command: unknown = JSON.parse(String(init?.body))
      const parts = Array.isArray(command) ? command.map(String) : []
      requests.push({ origin: url.origin, path: url.pathname, method, command: parts })
      const read = parts[0] === "GET" && parts.length === 2
      const ledger = parts[0] === "EVAL" && [MODEL_SPEND_SCRIPTS.READ, MODEL_SPEND_SCRIPTS.DAY].includes(parts[1]!)
      if (!read && !ledger) return new Response(null, { status: 500 })
      return Response.json({ result: store.command(parts) })
    },
    { preconnect: fetch.preconnect },
  )
  return { fetcher, requests, openRouter, store }
}

/**
 * A paid Max period with a fresh reconciled snapshot. Stripe's period seconds are converted once at the snapshot
 * boundary; the seam must preserve its millisecond dates without reconciling or provisioning a key on this read.
 */
function maxPlan() {
  process.env.MODEL_PLANS_ENABLED = "true"
  process.env.VECTOR_CLOUD_AGENTS_ENABLED = "true"
  process.env.KV_REST_API_URL = KV
  process.env.KV_REST_API_TOKEN = "fixture-kv-token"
  process.env.CODIUM_STRIPE_MODE = "test"
  process.env.OPENROUTER_MANAGEMENT_KEY = "fixture-management-key"
  const account = randomUUID()
  const start = Math.floor(Date.now() / 1000) - 3600
  const end = start + 30 * 86_400
  return {
    account,
    start,
    end,
    snapshot: buildSnapshot(
      {
        account,
        state: "active",
        plan: "vector-100",
        subscription: "sub_fixture_max",
        periodStart: start * 1000,
        periodEnd: end * 1000,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      Date.now(),
    ),
    allowance: {
      active: true,
      plan: "vector-100",
      limits: EXPECTED["vector-100"].limits,
      allowanceSeconds: 144_000,
      meterEpoch: `p${start}000`,
      periodEnd: end * 1000,
      premiumModels: true,
    } satisfies CloudAgentAllowance,
  }
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") return []
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return sources(file)
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx|astro)$/.test(entry.name) ? [file] : []
  })
}
