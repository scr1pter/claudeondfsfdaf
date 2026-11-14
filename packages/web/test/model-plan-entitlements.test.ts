import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  CODIUM_AUTO_ROLES,
  CODIUM_CATALOG_UPDATED,
  CODIUM_JUDGES,
  CODIUM_MODELS,
  CODIUM_REVIEW_PAIRS,
  CODIUM_RUNTIME_CATALOG_UPDATED,
  CODIUM_TIER_MODELS,
} from "../../../api/_lib/codium-catalog"
import {
  configuredPlanModels,
  effectiveModel,
  modelAccess,
  modelPlanRequestCredits,
  nominalModelPlanRequestCredits,
  publicModelPlans,
  type ModelPlanModel,
} from "../../../api/_lib/model-plan-config"
import { capturedReservationMicro } from "../../../api/_lib/codium-reservations"
import { ENTITLEMENTS } from "../../schema/src/codium-entitlements"
import { CodiumPlan } from "../../schema/src/codium-plan"

const previous = process.env.MODEL_PLAN_MODELS_JSON
beforeEach(() => delete process.env.MODEL_PLAN_MODELS_JSON)
afterEach(() => {
  delete process.env.MODEL_PLAN_MODELS_JSON
  if (previous !== undefined) process.env.MODEL_PLAN_MODELS_JSON = previous
})
const ids = {
  deepseek: "deepseek/deepseek-v4.1-flash-1017",
  haiku: "anthropic/claude-haiku-5.5",
  luna: "openai/gpt-6-luna",
  sol: "openai/gpt-6.1-sol",
  kimi: "moonshotai/kimi-k3.1-pro",
  argon: "google/gemini-4-argon",
  sonnet: "anthropic/claude-sonnet-5.5",
  opus: "anthropic/claude-opus-5.5",
} as const
const candidate = (id: string) => configuredPlanModels({ tiered: true }).find((model) => model.id === id)!
const base = {
  id: "fixture/coder",
  name: "Fixture Coder",
  contextLength: 128000,
  maxOutputTokens: 8192,
  inputPrice: 0.3,
  outputPrice: 1.2,
}

describe("staged catalog boundary", () => {
  test("the active five and their public capture date stay separate from the explicit staged catalog", () => {
    expect(configuredPlanModels().map((model) => model.id)).toEqual(CODIUM_MODELS.map((model) => model.id))
    expect(configuredPlanModels()).toHaveLength(5)
    expect(configuredPlanModels()[2]!.contextLength).toBe(128000)
    expect(CODIUM_RUNTIME_CATALOG_UPDATED).toBe("2026-10-23")
    expect(publicModelPlans().catalogUpdated).toBe(CODIUM_RUNTIME_CATALOG_UPDATED)
    expect(CODIUM_CATALOG_UPDATED).toBe("2026-10-30")
    expect(configuredPlanModels({ tiered: true })).toHaveLength(15)
    expect(configuredPlanModels({ tiered: true })[0]!.id).toBe(ids.deepseek)
    expect(modelAccess(candidate(ids.deepseek), "vector-10")).toBe(true)
    expect(candidate(ids.luna).contextLength).toBe(256000)
  })

  test("ordinary overrides default to Plus with public price weights; staged overrides do not activate by default", () => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([base])
    expect(configuredPlanModels()[0]).toMatchObject({ minPlan: "vector-10", weight: 1 })
    expect(configuredPlanModels({ tiered: true })[0]).toMatchObject({ minPlan: "vector-10", weight: 1 })
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify(CODIUM_TIER_MODELS)
    expect(() => configuredPlanModels()).toThrow()
    expect(configuredPlanModels({ tiered: true })).toHaveLength(15)
  })

  test.each([
    { field: { upstream: ids.deepseek } },
    { field: { minPlan: "vector-50" } },
    { field: { previewUntil: Date.UTC(2026, 11) } },
    { field: { providerOnly: ["azure"] } },
    { field: { tierContext: { "vector-10": 128000 } } },
    { field: { manualOnly: true } },
    { field: { reasoningEffort: "xhigh" } },
    { field: { reasoningEffort: "max" } },
  ])("old admission refuses routing fields it cannot enforce: %j", ({ field }) => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([{ ...base, ...field }])
    expect(() => configuredPlanModels()).toThrow()
    expect(configuredPlanModels({ tiered: true })).toHaveLength(1)
  })
})

describe("tier access and windows", () => {
  test.each([
    // Owner, 30 Oct: Sol in; Terra (Plus) and Astra (Max, Ultra) out.
    { plan: "vector-10", expected: [ids.deepseek, ids.haiku, ids.luna] },
    { plan: "vector-50", expected: [ids.sol, ids.kimi, ids.argon, `${ids.kimi}:long`, `${ids.argon}:long`] },
    {
      plan: "vector-100",
      expected: [`${ids.deepseek}:long`, ids.sonnet, `${ids.sol}:deep`, `${ids.kimi}:fast`, `${ids.argon}:fast`],
    },
    { plan: "vector-200", expected: [ids.opus, `${ids.sol}:deepest`] },
  ] as const)("models first unlock on $plan", ({ plan, expected }) => {
    const models = configuredPlanModels({ tiered: true })
    expect(models.filter((model) => model.minPlan === plan).map((model) => model.id)).toEqual([...expected])
    for (const model of models)
      expect(modelAccess(model, plan)).toBe(CodiumPlan.rank(model.minPlan!) <= CodiumPlan.rank(plan))
  })

  test("preview is Ultra only until the exact expiry, then restores its ordinary minimum", () => {
    const until = Date.UTC(2026, 10, 5)
    const model = { ...base, minPlan: "vector-50" as const, previewUntil: until }
    expect(modelAccess(model, "vector-50", until - 1)).toBe(false)
    expect(modelAccess(model, "vector-100", until - 1)).toBe(false)
    expect(modelAccess(model, "vector-200", until - 1)).toBe(true)
    expect(modelAccess(model, "vector-50", until)).toBe(true)
    expect(modelAccess(model, "vector-10", until)).toBe(false)
    expect(modelAccess({ ...model, previewUntil: NaN }, "vector-200", until)).toBe(false)
    expect(modelAccess(model, "vector-200", NaN)).toBe(false)
    expect(modelAccess({ ...model, minPlan: "unknown" } as unknown as ModelPlanModel, "vector-200", until)).toBe(false)
    expect(modelAccess(model, "unknown" as CodiumPlan.PlanId, until)).toBe(false)
  })

  test("effective contexts grow per tier without changing the source model or output ceiling", () => {
    for (const id of [`${ids.kimi}:long`, `${ids.argon}:long`]) {
      const model = candidate(id)
      expect(CodiumPlan.PLANS.slice(1).map((plan) => effectiveModel(model, plan.id).contextLength)).toEqual([
        256000, 512000, 768000,
      ])
      expect(model.contextLength).toBe(256000)
      expect(effectiveModel(model, "vector-200").maxOutputTokens).toBe(8192)
      expect(modelPlanRequestCredits(model)).toBe(modelPlanRequestCredits(model, "vector-200"))
    }
    const deepseek = candidate(`${ids.deepseek}:long`)
    expect(effectiveModel(deepseek, "vector-100").contextLength).toBe(512000)
    expect(effectiveModel(deepseek, "vector-200").contextLength).toBe(768000)
    expect(effectiveModel({ ...base, contextLength: 1000000 }, "vector-10").contextLength).toBe(
      ENTITLEMENTS["vector-10"].contextMax,
    )
    expect(() => effectiveModel({ ...base, tierContext: { "vector-10": NaN } }, "vector-10")).toThrow()
    expect(() => effectiveModel({ ...base, contextLength: 100 }, "vector-10")).toThrow()
  })

  test("manual models and aliases retain the owner routing constraints; Sol is staged and Terra and Astra are gone", () => {
    const models = configuredPlanModels({ tiered: true })
    expect(models.filter((model) => model.manualOnly).map((model) => model.id)).toEqual([
      `${ids.kimi}:long`,
      `${ids.argon}:long`,
      `${ids.deepseek}:long`,
      `${ids.kimi}:fast`,
      `${ids.argon}:fast`,
    ])
    for (const model of models.filter((model) => model.id.includes(":")))
      expect(model.upstream).toBe(model.id.split(":")[0])
    expect(candidate(`${ids.kimi}:fast`).providerOnly).toEqual(["moonshotai/highspeed"])
    expect(candidate(`${ids.argon}:fast`).providerOnly).toEqual(["google-vertex/global/priority"])
    // Sol and its effort variants stay staged on Pro, Max and Ultra; none is manual or a preview.
    for (const [id, plan, effort] of [
      [ids.sol, "vector-50", "high"],
      [`${ids.sol}:deep`, "vector-100", "xhigh"],
      [`${ids.sol}:deepest`, "vector-200", "max"],
    ] as const) {
      expect(candidate(id)).toMatchObject({ minPlan: plan, reasoningEffort: effort, lab: "openai" })
      expect(candidate(id).manualOnly).not.toBe(true)
      expect(candidate(id)).not.toHaveProperty("previewUntil")
    }
    // Owner, 30 Oct: neither is ZDR on OpenRouter, the only route Vector uses.
    expect(models.some((model) => /terra|astra/i.test(model.id))).toBe(false)
    expect(models.some((model) => /velocity/i.test(model.id))).toBe(false)
  })
})

describe("captured reservations and unqualified nominal estimates", () => {
  test.each([
    { id: ids.luna, plan: "vector-10", hold: "0.269" },
    { id: ids.sol, plan: "vector-50", hold: "0.442" },
    ...[ids.kimi, ids.argon].flatMap((id) => [
      { id: `${id}:long`, plan: "vector-50", hold: "2.179" },
      { id: `${id}:long`, plan: "vector-100", hold: "4.358" },
      { id: `${id}:long`, plan: "vector-200", hold: "4.358" },
    ]),
    { id: `${ids.deepseek}:long`, plan: "vector-100", hold: "0.668" },
    { id: `${ids.deepseek}:long`, plan: "vector-200", hold: "0.668" },
    { id: ids.sonnet, plan: "vector-100", hold: "0.730" },
    { id: `${ids.sol}:deep`, plan: "vector-100", hold: "0.532" },
    { id: `${ids.kimi}:fast`, plan: "vector-100", hold: "0.676" },
    { id: `${ids.argon}:fast`, plan: "vector-100", hold: "0.608" },
    { id: ids.opus, plan: "vector-200", hold: "1.821" },
    { id: `${ids.sol}:deepest`, plan: "vector-200", hold: "1.064" },
  ])(
    "$id on $plan reports $hold; unqualified entries remain nominal and cannot authorize a request",
    ({ id, plan, hold }) => {
      const model = candidate(id)
      const credits =
        capturedReservationMicro(model) === undefined
          ? nominalModelPlanRequestCredits(model, plan as CodiumPlan.PlanId)
          : modelPlanRequestCredits(model, plan as CodiumPlan.PlanId)
      expect(credits.toFixed(3)).toBe(hold)
    },
  )

  test("weights compare public prices rather than context or private monthly pools", () => {
    const models = configuredPlanModels({ tiered: true })
    for (const model of models) expect(model.weight).toBe((model.inputPrice + model.outputPrice) / 1.5)
    expect(candidate(ids.deepseek).weight).toBe(1)
    expect(candidate(`${ids.deepseek}:long`).weight).toBe(1)
    expect(candidate(ids.kimi).weight).toBe(candidate(`${ids.kimi}:long`).weight)
  })
})

describe("automatic roles remain ordinary unlocked models", () => {
  test("Auto ceilings and review pairs follow the tier contract", () => {
    expect(CodiumPlan.PLANS.map((plan) => CODIUM_AUTO_ROLES[plan.id].ceiling)).toEqual([
      ids.deepseek,
      ids.sol,
      `${ids.sol}:deep`,
      `${ids.sol}:deepest`,
    ])
    expect(CodiumPlan.PLANS.map((plan) => CODIUM_REVIEW_PAIRS[plan.id].panelJudge)).toEqual([
      ids.haiku,
      ids.argon,
      ids.sonnet,
      ids.opus,
    ])
    for (const plan of CodiumPlan.PLANS) {
      expect(CODIUM_AUTO_ROLES[plan.id].floor).toBe(ids.luna)
      expect(CODIUM_AUTO_ROLES[plan.id].default).toBe(ids.deepseek)
      for (const id of [...Object.values(CODIUM_AUTO_ROLES[plan.id]), ...Object.values(CODIUM_REVIEW_PAIRS[plan.id])]) {
        expect(modelAccess(candidate(id), plan.id)).toBe(true)
        expect(candidate(id).manualOnly).not.toBe(true)
      }
      const pair = CODIUM_REVIEW_PAIRS[plan.id]
      expect(candidate(pair.triage).lab).not.toBe(candidate(pair.confirm).lab)
    }
  })

  test("judges use another lab, never manual models, and cover each eligible worker above Plus", () => {
    expect(CODIUM_JUDGES["vector-10"]).toEqual({})
    for (const plan of CodiumPlan.PLANS.slice(1)) {
      const judges: Readonly<Record<string, string>> = CODIUM_JUDGES[plan.id]
      const workers = configuredPlanModels({ tiered: true }).filter((model) => modelAccess(model, plan.id))
      expect(Object.keys(judges).sort()).toEqual(workers.map((model) => model.id).sort())
      for (const worker of workers) {
        const judge = candidate(judges[worker.id]!)
        expect(modelAccess(judge, plan.id)).toBe(true)
        expect(judge.manualOnly).not.toBe(true)
        expect(judge.lab).not.toBe(worker.lab)
        if (plan.id === "vector-100") expect(judge.id).toBe(worker.lab === "anthropic" ? `${ids.sol}:deep` : ids.sonnet)
        if (plan.id === "vector-200")
          expect(judge.id).toBe(worker.lab === "anthropic" ? `${ids.sol}:deepest` : ids.opus)
      }
    }
    const pro: Readonly<Record<string, string>> = CODIUM_JUDGES["vector-50"]
    for (const worker of [ids.deepseek, ids.kimi, ids.haiku, ids.argon]) expect(pro[worker]).toBe(ids.sol)
    for (const worker of [ids.sol, ids.luna]) expect(pro[worker]).toBe(ids.argon)
  })
})

describe("staged override validation", () => {
  test.each([
    { patch: { id: "fixture/coder:long" } },
    { patch: { minPlan: "unknown" } },
    { patch: { upstream: "not-a-model" } },
    { patch: { upstream: "fixture/model:free" } },
    { patch: { previewUntil: -1 } },
    { patch: { previewUntil: 1.5 } },
    { patch: { providerOnly: [] } },
    { patch: { providerOnly: ["azure", "azure"] } },
    { patch: { providerOnly: [" azure"] } },
    { patch: { tierContext: { unknown: 128000 } } },
    { patch: { minPlan: "vector-50", tierContext: { "vector-10": 128000 } } },
    { patch: { tierContext: { "vector-10": 8191 } } },
    { patch: { tierContext: { "vector-10": 262145 } } },
    { patch: { minPlan: "vector-50", tierContext: { "vector-50": 256000, "vector-100": 128000 } } },
    { patch: { tierContext: { "vector-100": 512000 } } },
    { patch: { contextLength: 300000 } },
    { patch: { contextLength: 0 } },
    { patch: { maxOutputTokens: 128001 } },
    { patch: { promptTokenLimit: 0 } },
    { patch: { inputPrice: 0 } },
    { patch: { outputPrice: -1 } },
    { patch: { weight: 0 } },
    { patch: { reasoningEffort: "low" } },
    { patch: { lab: "unknown" } },
  ])("refuses malformed, decreasing or unavailable routing configuration %j", ({ patch }) => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([{ ...base, ...patch }])
    expect(() => configuredPlanModels({ tiered: true })).toThrow()
  })

  test("duplicate model IDs never produce ambiguous routing", () => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([base, base])
    expect(() => configuredPlanModels({ tiered: true })).toThrow()
  })
})
