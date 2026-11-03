import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { listedPerks, type PerkServices } from "../../../api/_lib/codium-perks"
import { publicCodiumTiers } from "../../../api/_lib/codium-public"
import { codiumKey } from "../../../api/_lib/codium-keys"
import { ENTITLEMENTS, PERK_IDS } from "@vectordevai/schema/codium-entitlements"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import type { ModelPlanModel } from "../../../api/_lib/model-plan-config"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"

const all: PerkServices = Object.fromEntries(PERK_IDS.map((perk) => [perk, () => true]))
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    CODIUM_LISTED_PERKS: undefined,
    CODIUM_TRACK_B_LIVE: undefined,
    MODEL_PLAN_GLOBAL_INFLIGHT: undefined,
    MODEL_PLAN_PRIORITY_RESERVE: undefined,
    CODIUM_FOUNDING_LIMIT: undefined,
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "fixture-webhook",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "fixture-portal",
    VECTOR_GITHUB_APP_ENABLED: undefined,
    VECTOR_GITHUB_APP_ID: undefined,
    VECTOR_GITHUB_APP_CLIENT_ID: undefined,
    VECTOR_GITHUB_APP_SLUG: undefined,
    VECTOR_GITHUB_APP_PRIVATE_KEY: undefined,
  })
})
afterEach(() => restore())

describe("A27 public perk listing", () => {
  test("empty intent does no store work, ignores unknown names and cannot activate unfinished services", async () => {
    const fakes = codiumFakes()
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set())
    process.env.CODIUM_LISTED_PERKS = `unknown, ${PERK_IDS.join(",")}, priority`
    // WP A31 made founding a real readiness check (its window, read at runtime): open, it is listed too.
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set(["founding"]))
    // Closed, it is not, so the rest of this case measures priority's readiness alone.
    process.env.CODIUM_FOUNDING_LIMIT = "0"
    process.env.MODEL_PLAN_GLOBAL_INFLIGHT = "20"
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set(["priority"]))
    delete process.env.MODEL_PLAN_GLOBAL_INFLIGHT
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set())
    process.env.MODEL_PLAN_GLOBAL_INFLIGHT = "20"
    process.env.MODEL_PLAN_PRIORITY_RESERVE = "0"
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set())
    process.env.MODEL_PLAN_PRIORITY_RESERVE = "NaN"
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set())
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await listedPerks(fakes.fetcher, { services: all })).toEqual(new Set())
  })

  test("dependencies, Track B and real App configuration gate otherwise configured services", async () => {
    const fakes = codiumFakes()
    process.env.CODIUM_LISTED_PERKS =
      "scheduled,reviews,github-no-secret,overnight,on-call,ship-desk,release-guard,brain,auto-learns,brain-cloud,playbooks"
    expect(await listedPerks(fakes.fetcher, { services: all })).toEqual(new Set())
    process.env.CODIUM_LISTED_PERKS = PERK_IDS.join(",")
    process.env.CODIUM_TRACK_B_LIVE = "true"
    const withoutApp = await listedPerks(fakes.fetcher, { services: all })
    expect(withoutApp.has("scheduled")).toBe(true)
    expect(withoutApp.has("overnight")).toBe(true)
    expect(withoutApp.has("brain")).toBe(true)
    for (const perk of ["github-no-secret", "on-call", "release-guard", "ship-desk"] as const)
      expect(withoutApp.has(perk)).toBe(false)
    Object.assign(process.env, {
      VERCEL_ENV: "production",
      VECTOR_GITHUB_APP_ENABLED: "true",
      VECTOR_GITHUB_APP_ID: "123",
      VECTOR_GITHUB_APP_CLIENT_ID: "fixture-client",
      VECTOR_GITHUB_APP_SLUG: "vector-fixture",
      VECTOR_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfixture-only",
    })
    expect(await listedPerks(fakes.fetcher, { services: all })).toEqual(new Set(PERK_IDS))
    expect(await listedPerks(fakes.fetcher, { services: all, runtime: false })).toEqual(new Set())
  })

  test("service switches and per-perk kills transitively hide dependent copy", async () => {
    process.env.CODIUM_LISTED_PERKS = "github-agents,scheduled,reviews,computer,overnight,remote,alerts"
    const fakes = codiumFakes()
    fakes.store.set(codiumKey("switch", "cloudAgents"), "off")
    fakes.store.set(codiumKey("switch", "hosted"), "no-new")
    expect(await listedPerks(fakes.fetcher, { services: all })).toEqual(new Set(["remote", "alerts"]))
    const killed = codiumFakes()
    await killed.fetcher(process.env.KV_REST_API_URL!, {
      method: "POST",
      body: JSON.stringify(["SADD", codiumKey("perks-off"), "github-agents", "computer"]),
    })
    expect(await listedPerks(killed.fetcher, { services: all })).toEqual(new Set(["remote", "alerts"]))
  })

  test("unreadable or corrupt runtime data lists nothing, without leaking partial successes", async () => {
    process.env.CODIUM_LISTED_PERKS = "remote,priority"
    const unavailable = (async (_input: RequestInfo | URL) => new Response(null, { status: 503 })) as typeof fetch
    expect(await listedPerks(unavailable, { services: all })).toEqual(new Set())
    const corrupt = codiumFakes()
    corrupt.store.set(codiumKey("switch", "remote"), "invalid")
    expect(await listedPerks(corrupt.fetcher, { services: all })).toEqual(new Set())
    const off = codiumFakes()
    off.store.set(codiumKey("switch", "codium"), "off")
    expect(await listedPerks(off.fetcher, { services: all })).toEqual(new Set())
    expect(
      await listedPerks(codiumFakes().fetcher, {
        services: {
          remote: () => {
            throw new Error("not configured")
          },
        },
      }),
    ).toEqual(new Set())
  })
})

const model: ModelPlanModel = {
  id: "fixture/coder",
  name: "Fixture Coder",
  contextLength: 128_000,
  maxOutputTokens: 8_192,
  inputPrice: 1,
  outputPrice: 2,
  minPlan: "vector-10",
  providerOnly: ["private-provider"],
}

describe("A27 qualified public catalog", () => {
  test("production has no models or purchasable offers before accepted route evidence", async () => {
    const result = await publicCodiumTiers(codiumFakes().fetcher)
    expect(result.models).toEqual([])
    expect(result.enabled).toBe(false)
    expect(result.plans.every((plan) => !plan.available && plan.tasks.length === 0)).toBe(true)
    expect(result.listed).toEqual([])
    expect(result.plans.map((plan) => plan.price)).toEqual([10, 50, 100, 200])
    for (const plan of result.plans) {
      if (!CodiumPlan.isPlanId(plan.id)) throw new Error("Public plan identity must be canonical")
      expect(plan.multiple).toBe(ENTITLEMENTS[plan.id].usageMultiple)
      expect(plan.caps.inFlight).toBe(ENTITLEMENTS[plan.id].inFlight)
      expect(plan.caps).not.toHaveProperty("cloudAgents")
    }
    expect(result).not.toHaveProperty("topups")
  })

  test("only qualified per-tier variants advertise access or their accepted windows", async () => {
    const result = await publicCodiumTiers(codiumFakes().fetcher, {
      models: [
        model,
        { ...model, id: "fixture/staged" },
        {
          ...model,
          id: "fixture/pro",
          minPlan: "vector-50",
          tierContext: { "vector-100": 512_000, "vector-200": 768_000 },
        },
      ],
      qualify: (candidate) => candidate.id !== "fixture/staged" && candidate.contextLength <= 262_144,
    })
    expect(result.models.map((model) => model.id)).toEqual(["fixture/coder", "fixture/pro"])
    expect(result.models[1]).toMatchObject({
      minPlan: "vector-50",
      plans: ["vector-50"],
      contextByPlan: { "vector-50": 128_000 },
    })
    expect(result.models[0]!.plans).toEqual(CodiumPlan.PLANS.map((plan) => plan.id))
    expect(result.enabled).toBe(true)
    for (const field of ["providerOnly", "private-provider", "inputPrice", "outputPrice", "credits", "weight"])
      expect(JSON.stringify(result)).not.toContain(field)
  })

  test("preview locks are Ultra-only until expiry and disabled models are absent", async () => {
    const now = Date.UTC(2026, 10, 1)
    const preview = { ...model, previewUntil: now + 1000 }
    const result = await publicCodiumTiers(codiumFakes().fetcher, { models: [preview], qualify: () => true, now })
    expect(result.models[0]).toMatchObject({ minPlan: "vector-200", plans: ["vector-200"], previewUntil: now + 1000 })
    expect(result.plans.map((plan) => plan.available)).toEqual([false, false, false, true])
    const expired = await publicCodiumTiers(codiumFakes().fetcher, {
      models: [preview],
      qualify: () => true,
      now: now + 1000,
    })
    expect(expired.models[0]!.plans).toHaveLength(4)
    expect(expired.models[0]).not.toHaveProperty("previewUntil")
    const fakes = codiumFakes()
    await fakes.fetcher(process.env.KV_REST_API_URL!, {
      method: "POST",
      body: JSON.stringify(["SADD", codiumKey("models-off"), model.id]),
    })
    expect((await publicCodiumTiers(fakes.fetcher, { models: [model], qualify: () => true })).models).toEqual([])
  })

  test("prerenders never resolve runtime perks, offers or founder windows", async () => {
    process.env.CODIUM_LISTED_PERKS = PERK_IDS.join(",")
    const forbidden = (async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error("A prerender must not read a service")
    }) as typeof fetch
    const result = await publicCodiumTiers(forbidden, {
      runtime: false,
      models: [model],
      qualify: () => true,
      perks: { services: all },
    })
    expect(result.enabled).toBe(false)
    expect(result.listed).toEqual([])
    expect(result.models).toEqual([])
    expect(result.plans.every((plan) => !plan.available && plan.caps.foundingBoost === undefined)).toBe(true)
  })

  test("coarse tasks use canonical usage multiples and only the tiers that can use the model", async () => {
    const options = {
      models: [{ ...model, id: "deepseek/deepseek-v4.1-flash-1017", minPlan: "vector-50" as const }],
      qualify: () => true,
    }
    const first = await publicCodiumTiers(codiumFakes().fetcher, options)
    expect(first.plans.map((plan) => plan.tasks)).toEqual([[null], [[275, 2750]], [[600, 6000]], [[1250, 12500]]])
    process.env.MODEL_PLAN_50_CREDITS_USD = "0.1"
    const invalid = await publicCodiumTiers(codiumFakes().fetcher, options)
    expect(invalid.enabled).toBe(false)
    expect(invalid.plans.map((plan) => plan.tasks)).toEqual(first.plans.map((plan) => plan.tasks))
    expect(invalid.plans.map((plan) => plan.multiple)).toEqual([1, 5.5, 12, 25])
  })

  test("a later catalog-store failure also clears otherwise readable perks", async () => {
    process.env.CODIUM_LISTED_PERKS = "remote"
    const fakes = codiumFakes()
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body))
      if (command[0] === "SMEMBERS" && command[1] === codiumKey("models-off"))
        return new Response(null, { status: 503 })
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const result = await publicCodiumTiers(fetcher, { models: [model], qualify: () => true, perks: { services: all } })
    expect(result.listed).toEqual([])
    expect(result.models).toEqual([])
    expect(result.plans.every((plan) => plan.caps.remote === undefined && !plan.available)).toBe(true)
  })

  test("sales or Codium off and an unreadable catalog fail closed for purchases", async () => {
    for (const name of ["sales", "codium"] as const) {
      const fakes = codiumFakes()
      fakes.store.set(codiumKey("switch", name), "off")
      const result = await publicCodiumTiers(fakes.fetcher, { models: [model], qualify: () => true })
      expect(result.enabled).toBe(false)
      expect(result.plans.every((plan) => !plan.available)).toBe(true)
    }
    const unavailable = (async (_input: RequestInfo | URL) => new Response(null, { status: 503 })) as typeof fetch
    const result = await publicCodiumTiers(unavailable, { models: [model], qualify: () => true })
    expect(result.models).toEqual([])
    expect(result.enabled).toBe(false)
  })
})
