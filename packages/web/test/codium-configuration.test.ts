import { describe, expect, test } from "bun:test"
import { CodiumPlan } from "../../schema/src/codium-plan"
import { codiumEconomics } from "../scripts/codium-economics"

const root = new URL("../../../", import.meta.url)
const example = await Bun.file(new URL(".env.example", root)).text()
const entries = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1]!, match[2]!] as const)
const configuration = new Map(entries)
const deployment = await Bun.file(new URL("vercel.json", root)).json()
// Synthetic private allowances test the public ratios without prescribing production amounts.
const allowances = [2, 11, 24, 50]
const plans = CodiumPlan.PLANS.map((plan, index) => ({ ...plan, credits: allowances[index]! }))

describe("Codium deployment configuration", () => {
  test("the example uses the canonical tax switch, monthly prices and private blank allowances", () => {
    expect(entries.length).toBe(configuration.size)
    expect(configuration.get("MODEL_PLANS_ENABLED")).toBe("false")
    expect(configuration.get("CODIUM_STRIPE_AUTOMATIC_TAX")).toBe("false")
    expect(example).not.toMatch(
      /STRIPE_MODEL_TOPUP_|MODEL_TOPUP_\w*_CREDITS_USD|STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID/,
    )
    expect(configuration.has("STRIPE_AUTOMATIC_TAX")).toBe(false)
    for (const plan of CodiumPlan.PLANS) {
      expect(configuration.get(`STRIPE_MODEL_PLAN_${plan.price}_PRICE_ID`)).toBe("")
      expect(configuration.get(`MODEL_PLAN_${plan.price}_CREDITS_USD`)).toBe("")
    }
    expect(configuration.get("MODEL_CREDIT_MARKUP_PERCENT")).toBe("")
  })

  test("implemented risk, funding, owner and signed-spend settings have server-only configuration slots", () => {
    const names = [
      "CRON_SECRET",
      "VECTOR_ADMIN_EMAILS",
      "CODIUM_TEST_CREDIT_CAP_USD",
      "CODIUM_3DS_MIN_USD",
      "CODIUM_TRUST_RAMP_DAYS",
      "CODIUM_RENEWAL_GRACE_MINUTES",
      "CODIUM_EFW_REFUND",
      "CODIUM_RADAR_BLOCKLIST_ID",
      "CODIUM_CODIUM_OFF_PAUSE_MINUTES",
      "CODIUM_OWNER_EMAIL",
      "CODIUM_OWNER_SECRET",
      "CODIUM_FUNDING_MARGIN_PERCENT",
      "CODIUM_FUNDING_MARGIN_USD",
      "CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD",
      "CODIUM_SPEND_SPIKE_USD_PER_HOUR",
      "CODIUM_OPENROUTER_FEE_PERCENT",
      "VERCEL_MAIN_TEAM_ID",
      "VERCEL_SPEND_WEBHOOK_SECRET_MAIN",
      "VERCEL_HOSTED_TEAM_ID",
      "VERCEL_SPEND_WEBHOOK_SECRET_HOSTED",
    ]
    expect(names.filter((name) => !configuration.has(name))).toEqual([])
    expect(names.some((name) => name.startsWith("PUBLIC_"))).toBe(false)
  })

  test("the five billing schedules match the implemented routes and never poll future service routes", async () => {
    const crons = deployment.crons as { path: string; schedule: string }[]
    expect(crons.filter((cron) => cron.path.startsWith("/api/model-plans/"))).toEqual([
      { path: "/api/model-plans/funding", schedule: "*/10 * * * *" },
      { path: "/api/model-plans/outbox", schedule: "* * * * *" },
      { path: "/api/model-plans/replay", schedule: "*/10 * * * *" },
      { path: "/api/model-plans/sweep?scope=risk", schedule: "47 * * * *" },
      { path: "/api/model-plans/sweep", schedule: "23 4 * * *" },
    ])
    expect(crons.filter((cron) => /^\/api\/(hosted|vault|ops)\//.test(cron.path))).toEqual([])
    for (const cron of crons) {
      const pathname = new URL(cron.path, "https://fixture.example.test").pathname
      expect(await Bun.file(new URL(`.${pathname}.ts`, root)).exists()).toBe(true)
    }
  })
})

describe("Codium private monthly planning", () => {
  test("uses the current four monthly tiers and full-consumption arithmetic without a top-up offer", () => {
    const result = codiumEconomics(plans, {})
    expect(result.assumptions).toEqual({ provider: 5.5, payment: 2.9, fixed: 0.3, recurring: 0.7 })
    expect(result.rows.map((row) => [row.plan, row.price, row.billing])).toEqual(
      CodiumPlan.PLANS.map((plan) => [plan.name, plan.price, "Monthly"]),
    )
    expect(result.rows[0]).toMatchObject({
      modelCredits: 2,
      providerFee: "0.11",
      paymentFees: "0.66",
      beforeOtherExpenses: "7.23",
    })
    expect(result.rows.at(-1)).toMatchObject({
      modelCredits: 50,
      providerFee: "2.75",
      paymentFees: "7.50",
      beforeOtherExpenses: "139.75",
    })
    expect(JSON.stringify(result.rows)).not.toMatch(/topup|annual/i)
  })

  test("uses the ledger fee estimate unless an explicit planning override is present", () => {
    expect(codiumEconomics(plans, { CODIUM_OPENROUTER_FEE_PERCENT: "6" }).assumptions.provider).toBe(6)
    expect(
      codiumEconomics(plans, { CODIUM_OPENROUTER_FEE_PERCENT: "6", CODIUM_PROVIDER_FEE_PERCENT: "8" }).assumptions
        .provider,
    ).toBe(8)
    expect(
      codiumEconomics(plans, {
        CODIUM_PROVIDER_FEE_PERCENT: "0",
        CODIUM_PAYMENT_FEE_PERCENT: "0",
        CODIUM_PAYMENT_FIXED_USD: "0",
        CODIUM_SUBSCRIPTION_FEE_PERCENT: "0",
      }).rows[0]?.beforeOtherExpenses,
    ).toBe("8.00")
  })

  test("refuses absent, inconsistent or obsolete plan inputs instead of showing misleading margins", () => {
    expect(() =>
      codiumEconomics(
        plans.map((plan) => ({ ...plan, credits: 0 })),
        {},
      ),
    ).toThrow("MODEL_PLAN_")
    expect(() =>
      codiumEconomics(
        plans.map((plan) => ({ ...plan, credits: plan.price / 2 })),
        {},
      ),
    ).toThrow("usage multiples")
    expect(() => codiumEconomics(plans.slice(1), {})).toThrow("all four")
    // Intentionally bypass price literals to test rejection of obsolete runtime input.
    expect(() =>
      codiumEconomics(
        plans.map((plan) => ({ ...plan, price: plan.price + 1 })) as unknown as Parameters<typeof codiumEconomics>[0],
        {},
      ),
    ).toThrow("all four")
    expect(() =>
      codiumEconomics(
        plans.map((plan) => ({ ...plan, credits: plan.credits + 0.001 })),
        {},
      ),
    ).toThrow("MODEL_PLAN_")
    expect(() =>
      codiumEconomics(
        plans.map((plan) => ({ ...plan, credits: plan.price + 1 })),
        {},
      ),
    ).toThrow("MODEL_PLAN_")
  })

  test.each(["NaN", "Infinity", "-1", "garbage"])("refuses invalid fee assumptions: %s", (value) => {
    expect(() => codiumEconomics(plans, { CODIUM_PROVIDER_FEE_PERCENT: value })).toThrow("Fee assumptions")
    expect(() => codiumEconomics(plans, { CODIUM_PAYMENT_FIXED_USD: value })).toThrow("Fee assumptions")
  })

  test("does not treat blank optional fee settings as free provider or payment processing", () => {
    expect(
      codiumEconomics(plans, {
        CODIUM_PROVIDER_FEE_PERCENT: " ",
        CODIUM_OPENROUTER_FEE_PERCENT: " ",
        CODIUM_PAYMENT_FEE_PERCENT: "",
        CODIUM_PAYMENT_FIXED_USD: "",
        CODIUM_SUBSCRIPTION_FEE_PERCENT: "",
      }).assumptions,
    ).toEqual(codiumEconomics(plans, {}).assumptions)
  })
})
