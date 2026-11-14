import { describe, expect, test } from "bun:test"
import { publicEntitlements } from "@vectordevai/schema/codium-entitlements"
import {
  modelPlanPurchasable,
  modelPlanRedirect,
  readModelPlanConfig,
  readModelPlanStatus,
  type ModelPlanModel,
} from "./model-plans"

const plan = { id: "vector-10", name: "Plus", price: 10, available: true }
const config = { enabled: true, currency: "usd" as const, interval: "month" as const, plans: [plan] }
const status = {
  active: true,
  access: true,
  plan: { id: plan.id, name: "Plus", left: 0.25, renewsAt: 2_000, cancelAtPeriodEnd: false },
  purchased: { bought: false },
  empty: false,
  low: false,
}

describe("model plan API boundaries", () => {
  test("reads modern payment, renewal and listed meter fields without private amounts", () => {
    const listed = ["github-agents", "computer", "vault", "brain", "remote"] as const
    const current = {
      ...status,
      enabled: true,
      listed: [...listed],
      velocity: "coming",
      plan: {
        ...status.plan,
        id: "vector-100",
        name: "Max",
        state: "paused",
        reason: "action_required",
        action: "confirm-payment",
        today: { used: 0.4, resetsAt: 9_000, reached: false },
        scheduled: { id: "vector-50", name: "Old name", at: 10_000 },
        forecastDate: "2026-11-12",
        ramp: { until: 12_000 },
      },
      entitlements: { ...publicEntitlements("vector-100", new Set(listed)), dollars: 987654 },
      meters: {
        cloudAgents: { used: 0.25, exhausted: false, tokens: 987654 },
        hosted: { used: 0.4 },
        vault: { usedBytes: 10, quotaBytes: 100 },
        brain: { used: 0.02, cap: 0.1 },
        remote: { computers: 2, limit: 5 },
        secretCost: 987654,
      },
      secretAllowance: 987654,
    }
    const read = readModelPlanStatus(current)
    expect(read.plan).toMatchObject({
      state: "paused",
      reason: "action_required",
      action: "confirm-payment",
      scheduled: { id: "vector-50", name: "Pro", at: 10_000 },
      today: { used: 0.4, resetsAt: 9_000, reached: false },
      forecastDate: "2026-11-12",
      ramp: { until: 12_000 },
    })
    expect(new Set(read.listed)).toEqual(new Set(listed))
    expect(read.meters).toEqual({
      cloudAgents: { used: 0.25, exhausted: false },
      hosted: { used: 0.4 },
      vault: { usedBytes: 10, quotaBytes: 100 },
      brain: { used: 0.02, cap: 0.1 },
      remote: { computers: 2, limit: 5 },
    })
    expect(read.velocity).toBe("coming")
    expect(JSON.stringify(read)).not.toMatch(/987654|secret|dollars|tokens/)
  })

  test("drops unlisted or malformed optional meters while preserving the old status", () => {
    const read = readModelPlanStatus({
      ...status,
      listed: ["remote", "remote", "future-perk"],
      entitlements: { remote: { computers: 999 }, hosted: { computers: 999 } },
      meters: { hosted: { used: 0.2 }, remote: { computers: -1, limit: 1 } },
      velocity: "coming",
      labs: "coming",
    })
    expect(read.plan).toEqual(status.plan)
    expect(read.listed).toEqual(["remote"])
    expect(read.entitlements).toEqual({})
    expect(read.meters).toBeUndefined()
    expect(read.velocity).toBeUndefined()
    expect(read).not.toHaveProperty("labs")
    expect(
      readModelPlanStatus({
        ...status,
        plan: {
          ...status.plan,
          today: { used: 2, resetsAt: 10, reached: false },
          ramp: { until: -1 },
          forecastDate: "not-a-date",
        },
      }),
    ).toEqual(status)
  })
  test("reads listed perks, canonical caps and effective model plan membership", () => {
    const caps = publicEntitlements("vector-10", new Set(["remote"]))
    const model: ModelPlanModel = {
      id: "vendor/coder",
      name: "Coder",
      minPlan: "vector-10",
      contextLength: 128_000,
      plans: ["vector-10", "vector-50"],
      contextByPlan: { "vector-10": 128_000, "vector-50": 128_000 },
    }
    expect(
      readModelPlanConfig({
        ...config,
        listed: ["remote"],
        plans: [{ ...plan, multiple: 1, caps: { ...caps, privateAllowance: 123 } }],
        models: [model],
      }),
    ).toEqual({
      ...config,
      listed: ["remote"],
      plans: [{ ...plan, multiple: 1, caps }],
      models: [model],
    })
  })

  test("rejects fabricated public caps, invalid listing IDs and malformed model availability", () => {
    for (const value of [
      { ...config, listed: ["not-a-perk"] },
      { ...config, plans: [{ ...plan, caps: { inFlight: 999 } }] },
      { ...config, models: [{ id: "vendor/coder", name: "Coder", minPlan: "not-a-plan" }] },
      { ...config, models: [{ id: "vendor/coder", name: "Coder", plans: ["vector-10", "vector-10"] }] },
      { ...config, models: [{ id: "vendor/coder", name: "Coder", contextByPlan: { "vector-10": -1 } }] },
      { ...config, models: [{ id: "vendor/coder", name: "Coder", contextLength: Infinity }] },
    ])
      expect(() => readModelPlanConfig(value)).toThrow("could not load model plans")
  })

  test("reads the public catalog while preserving disabled plans", () => {
    expect(readModelPlanConfig(config)).toEqual(config)
    expect(readModelPlanConfig({ ...config, enabled: false, plans: [{ ...plan, available: false }] })).toMatchObject({
      enabled: false,
      plans: [{ available: false }],
    })
  })

  test("keeps only public fields, even when a response carries credit amounts or model prices", () => {
    const read = readModelPlanConfig({
      ...config,
      plans: [{ ...plan, credits: 7, multiple: 5, tasks: [[60, 550], null] }],
      models: [{ id: "vendor/coder", name: "Coder", inputPrice: 0.1, outputPrice: 0.4, contextLength: 128_000 }],
    })
    expect(read.plans).toEqual([{ ...plan, multiple: 5, tasks: [[60, 550], null] }])
    expect(read.models).toEqual([{ id: "vendor/coder", name: "Coder", contextLength: 128_000 }])
  })

  test("rejects malformed prices, multiples, ranges, currencies and duplicate plan IDs", () => {
    for (const value of [
      null,
      { ...config, currency: "eur" },
      { ...config, plans: [plan, plan] },
      { ...config, plans: [{ ...plan, price: NaN }] },
      { ...config, plans: [{ ...plan, available: "true" }] },
      { ...config, plans: [{ ...plan, multiple: 0.5 }] },
      { ...config, plans: [{ ...plan, tasks: [[550, 60]] }] },
      { ...config, plans: [{ ...plan, tasks: [[0, 60]] }] },
      { ...config, plans: [{ ...plan, tasks: [[60]] }] },
      { ...config, plans: [{ ...plan, tasks: "60–550" }] },
    ]) {
      expect(() => readModelPlanConfig(value)).toThrow("could not load model plans")
    }
  })

  test("reads optional public coding models and one-time credit packs without changing older responses", () => {
    const model = {
      id: "vendor/coder",
      name: "Coder",
      category: "everyday" as const,
      description: "For routine coding tasks.",
    }
    const current = {
      ...config,
      product: "Vector Codium",
      models: [model],
      topups: [{ ...plan, id: "codium-topup-10" }],
    }
    expect(readModelPlanConfig(current)).toEqual(current)
    for (const invalid of [
      { ...current, models: [model, model] },
      { ...current, models: [{ ...model, name: " " }] },
      { ...current, models: [{ ...model, category: "best" }] },
      { ...current, models: [{ ...model, id: "not a model" }] },
      { ...current, topups: [plan] },
      { ...current, topups: "credit packs" },
    ]) {
      expect(() => readModelPlanConfig(invalid)).toThrow("could not load model plans")
    }
  })

  test("accepts inactive customers and keeps missing usage unknown", () => {
    expect(readModelPlanStatus({ active: false, customer: true })).toEqual({ active: false, customer: true })
    expect(readModelPlanStatus(status)).toEqual(status)
    const unknown = readModelPlanStatus({ ...status, plan: { ...status.plan, left: undefined } }).plan
    expect(unknown).toEqual({ id: plan.id, name: "Plus", renewsAt: 2_000, cancelAtPeriodEnd: false })
    expect(unknown).not.toHaveProperty("left")
  })

  test("rejects invalid plans, shares and flags", () => {
    for (const value of [
      { ...status, plan: { ...status.plan, renewsAt: 1e30 } },
      { ...status, plan: { ...status.plan, left: 1.5 } },
      { ...status, plan: { ...status.plan, left: -0.1 } },
      { ...status, plan: { ...status.plan, cancelAtPeriodEnd: "false" } },
      { ...status, plan: undefined },
      { ...status, active: false },
      { ...status, purchased: { bought: true, state: "half" } },
      { ...status, low: "true" },
      { active: false, customer: "true" },
    ]) {
      expect(() => readModelPlanStatus(value)).toThrow("could not load your model plan")
    }
  })

  test("keeps only shares and flags, even when a response carries credit amounts", () => {
    const read = readModelPlanStatus({
      ...status,
      credits: 7,
      used: 5,
      remaining: 2,
      plan: { ...status.plan, credits: 7, remaining: 2 },
      purchased: { bought: true, state: "low", left: 0.5, credits: 7 },
      wallet: { credits: 7, used: 3, remaining: 4 },
    })
    // Purchased credits keep only their state: a share of every top-up ever bought would mislead a repeat buyer.
    expect(read).toEqual({ ...status, purchased: { bought: true, state: "low" } })
    expect(JSON.stringify(read)).not.toMatch(/credits|used|remaining|wallet/)
  })

  test("purchase requires availability and a confirmed inactive subscription", () => {
    expect(modelPlanPurchasable(config, plan, { active: false })).toBe(true)
    expect(modelPlanPurchasable(config, plan, { active: false, customer: true })).toBe(true)
    expect(modelPlanPurchasable({ ...config, enabled: false }, plan, { active: false })).toBe(false)
    expect(modelPlanPurchasable(config, { ...plan, available: false }, { active: false })).toBe(false)
    expect(modelPlanPurchasable(config, plan, status)).toBe(false)
    expect(modelPlanPurchasable(config, plan, undefined)).toBe(false)
  })

  test("purchased credits work without a subscription and keep unknown usage unknown", () => {
    expect(
      readModelPlanStatus({ active: false, access: true, purchased: { bought: true, state: "available" } }),
    ).toEqual({
      active: false,
      access: true,
      purchased: { bought: true, state: "available" },
    })
    expect(readModelPlanStatus({ ...status, purchased: { bought: true } })).toMatchObject({
      active: true,
      purchased: { bought: true },
    })
  })
})

describe("billing redirects", () => {
  test("allows the exact Stripe product origin", () => {
    expect(modelPlanRedirect({ url: "https://checkout.stripe.com/c/pay/cs_test#token" }, "checkout")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test#token",
    )
    expect(modelPlanRedirect({ url: "https://billing.stripe.com/p/session/test" }, "portal")).toBe(
      "https://billing.stripe.com/p/session/test",
    )
  })

  test("rejects cross-product, credentialed, deceptive, insecure and malformed redirects", () => {
    for (const url of [
      "https://billing.stripe.com/p/session/test",
      "https://checkout.stripe.com.attacker.example/",
      "https://checkout.stripe.com@attacker.example/",
      "https://user:secret@checkout.stripe.com/",
      "https://checkout.stripe.com:444/",
      "http://checkout.stripe.com/",
      "javascript:alert(1)",
      "/checkout",
      "not a URL",
    ]) {
      expect(() => modelPlanRedirect({ url }, "checkout")).toThrow("could not open billing")
    }
  })
})
