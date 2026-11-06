import { describe, expect, test } from "bun:test"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import {
  executeModelPlanAction,
  fetchModelPlanAccount,
  modelPlanOffer,
  modelPlanRecovery,
  type ModelPlanAction,
} from "./model-plan-actions"
import { readModelPlanStatus, type ModelPlanConfig, type ModelPlanStatus } from "./model-plans"

const config: ModelPlanConfig = {
  enabled: true,
  currency: "usd",
  interval: "month",
  plans: CodiumPlan.PLANS.map((plan) => ({ ...plan, available: true })),
}
const active: ModelPlanStatus = {
  active: true,
  access: true,
  plan: { id: "vector-50", name: "Pro", state: "active", left: 0.4, renewsAt: 2_000_000, cancelAtPeriodEnd: false },
}

describe("account plan actions", () => {
  test("does not offer a charge before status is known and preserves current/closed labels", () => {
    expect(modelPlanOffer(config, config.plans[0]!, undefined)).toBeUndefined()
    expect(modelPlanOffer(config, config.plans[1]!, active)).toEqual({ label: "Current plan", current: true })
    expect(modelPlanOffer({ ...config, enabled: false }, config.plans[2]!, active)).toEqual({ label: "Coming soon" })
    expect(modelPlanOffer(config, config.plans[2]!, { ...active, enabled: false })).toEqual({ label: "Coming soon" })
    expect(modelPlanOffer(config, config.plans[0]!, { active: false })).toEqual({
      label: "Choose Plus",
      request: { kind: "checkout", plan: "vector-10" },
    })
  })

  test("paused recovery distinguishes invoice confirmation from updating the payment method", () => {
    expect(modelPlanRecovery(active)).toBeUndefined()
    expect(modelPlanRecovery(undefined)).toBeUndefined()
    for (const reason of ["payment_failed", "payment_pending"] as const)
      expect(modelPlanRecovery({ ...active, plan: { ...active.plan!, state: "paused", reason } })).toEqual({
        label: "Update payment method",
        request: { kind: "portal", flow: "payment_method_update" },
      })
    for (const extra of [{ reason: "action_required" }, { action: "confirm-payment" }] as const)
      expect(modelPlanRecovery({ ...active, plan: { ...active.plan!, state: "paused", ...extra } })).toEqual({
        label: "Confirm payment",
        request: { kind: "portal" },
      })
  })

  test("private pricing status reads are authenticated, uncached and decoded before use", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({
        ...active,
        secretAllowance: 123456,
        plan: { ...active.plan!, state: "paused", reason: "payment_failed" },
      })
    }) as typeof fetch
    const result = await fetchModelPlanAccount("fixture-session", fetcher)
    expect(result.plan?.state).toBe("paused")
    expect(result).not.toHaveProperty("secretAllowance")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/api/model-plans/status")
    expect(calls[0]?.init?.cache).toBe("no-store")
    expect(calls[0]?.init?.redirect).toBe("error")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fixture-session")
    await expect(fetchModelPlanAccount("", fetcher)).rejects.toThrow("Sign in")
    expect(calls).toHaveLength(1)
    const failed = (async (_input: RequestInfo | URL) => Response.json({}, { status: 503 })) as typeof fetch
    await expect(fetchModelPlanAccount("fixture-session", failed)).rejects.toThrow("could not read your plan")
    const malformed = (async (_input: RequestInfo | URL) => Response.json({})) as typeof fetch
    await expect(fetchModelPlanAccount("fixture-session", malformed)).rejects.toThrow()
  })

  test("states the complete immediate upgrade charge and sends lower tiers to renewal", () => {
    expect(modelPlanOffer(config, config.plans[2]!, active)).toEqual({
      label: "Upgrade to Max: $100 today, then monthly from today. Keeps what's left of this month.",
      request: { kind: "change", plan: "vector-100" },
    })
    expect(modelPlanOffer(config, config.plans[0]!, active)).toEqual({
      label: "Switch at renewal",
      detail: "Plus starts on your renewal date.",
      request: { kind: "change", plan: "vector-10" },
    })
    expect(modelPlanOffer(config, { ...config.plans[2]!, price: 999, name: "Injected" }, active)?.label).toContain(
      "Max: $100 today",
    )
  })

  test("paused sales still allow an active subscriber to schedule a lower tier without a new charge", () => {
    const closed = { ...config, enabled: false, plans: config.plans.map((plan) => ({ ...plan, available: false })) }
    const current = { ...active, enabled: false, plan: { ...active.plan!, id: "vector-100", name: "Max" } }
    expect(modelPlanOffer(closed, closed.plans[1]!, current)?.request).toEqual({ kind: "change", plan: "vector-50" })
    expect(modelPlanOffer(closed, closed.plans[3]!, current)).toEqual({ label: "Coming soon" })
    expect(modelPlanOffer(closed, closed.plans[0]!, { active: false, enabled: false })?.request).toBeUndefined()
    expect(
      modelPlanOffer(closed, closed.plans[1]!, { ...current, plan: { ...current.plan, state: "paused" } }),
    ).toBeUndefined()
    expect(
      modelPlanOffer(closed, closed.plans[1]!, { ...current, plan: { ...current.plan, cancelAtPeriodEnd: true } }),
    ).toBeUndefined()
  })

  test("paused, ending, frozen, pending and unknown plans cannot request another purchase", () => {
    for (const state of ["paused", "renewing", "frozen", "ended", "unknown"] as const)
      expect(modelPlanOffer(config, config.plans[2]!, { ...active, plan: { ...active.plan!, state } })).toBeUndefined()
    expect(
      modelPlanOffer(config, config.plans[2]!, { ...active, plan: { ...active.plan!, cancelAtPeriodEnd: true } }),
    ).toBeUndefined()
    expect(
      modelPlanOffer(config, config.plans[2]!, { ...active, plan: { ...active.plan!, changeBlocked: true } }),
    ).toBeUndefined()
    const scheduled = {
      ...active,
      plan: { ...active.plan!, scheduled: { id: "vector-10", name: "Plus", at: 2_000_000 } },
    }
    expect(modelPlanOffer(config, config.plans[0]!, scheduled)).toEqual({
      label: "Scheduled at renewal",
      current: true,
    })
    expect(modelPlanOffer(config, config.plans[2]!, scheduled)).toBeUndefined()
    const legacy = { ...active, plan: { ...active.plan!, state: undefined } }
    expect(modelPlanOffer(config, config.plans[2]!, legacy)?.request).toEqual({ kind: "change", plan: "vector-100" })
  })

  test("malformed new control fields remain visible but never restore an upgrade request", () => {
    for (const extra of [
      { state: "future-state" },
      { scheduled: { id: "unrecognized", at: 1000 } },
      { action: "future-action" },
    ]) {
      const status = readModelPlanStatus({ ...active, plan: { ...active.plan!, ...extra } })
      expect(status.plan?.left).toBe(0.4)
      expect(status.plan?.changeBlocked).toBe(true)
      expect(modelPlanOffer(config, config.plans[2]!, status)).toBeUndefined()
    }
  })

  test("billing requests use explicit routes, JSON bodies and authenticated methods", async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return Response.json({
        url: String(input).endsWith("portal")
          ? "https://billing.stripe.com/session/fixture"
          : "https://checkout.stripe.com/c/pay/fixture",
      })
    }) as typeof fetch
    for (const request of [
      { kind: "checkout", plan: "vector-10" },
      { kind: "change", plan: "vector-100" },
      { kind: "portal", flow: "payment_method_update" },
      { kind: "portal" },
    ] as const) {
      expect(await executeModelPlanAction(request, "fixture-session", fetcher)).toHaveProperty("url")
      const call = requests.at(-1)!
      expect(call.url).toBe(`/api/model-plans/${request.kind}`)
      expect(call.init?.method).toBe("POST")
      expect(call.init?.redirect).toBe("error")
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer fixture-session")
    }
    expect(requests.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { plan: "vector-10" },
      { plan: "vector-100" },
      { flow: "payment_method_update" },
      {},
    ])
  })

  test("downgrade and Keep my plan responses do not navigate or charge a checkout", async () => {
    const requests: { url: string; method?: string }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method })
      return Response.json({ scheduled: init?.method === "DELETE" ? false : { plan: "vector-10", at: 2_000_000 } })
    }) as typeof fetch
    expect(await executeModelPlanAction({ kind: "change", plan: "vector-10" }, "fixture-session", fetcher)).toEqual({
      scheduled: { id: "vector-10", name: "Plus", at: 2_000_000 },
    })
    expect(await executeModelPlanAction({ kind: "keep" }, "fixture-session", fetcher)).toEqual({ kept: true })
    expect(requests).toEqual([
      { url: "/api/model-plans/change", method: "POST" },
      { url: "/api/model-plans/change", method: "DELETE" },
    ])
  })

  test("refuses mismatched, malformed or unsafe billing responses", async () => {
    for (const body of [
      { scheduled: { plan: "vector-200", at: 1000 } },
      { scheduled: { plan: "vector-10", at: -1 } },
      { scheduled: false },
      { url: "https://example.invalid/checkout" },
      { url: "https://checkout.stripe.com@evil.invalid/" },
      {},
    ]) {
      const fetcher = (async (_input: RequestInfo | URL) => Response.json(body)) as typeof fetch
      await expect(
        executeModelPlanAction({ kind: "change", plan: "vector-10" }, "fixture-session", fetcher),
      ).rejects.toThrow()
    }
    const unavailable = (async (_input: RequestInfo | URL) =>
      Response.json({ error: { message: "Billing is paused" } }, { status: 409 })) as typeof fetch
    await expect(executeModelPlanAction({ kind: "keep" }, "fixture-session", unavailable)).rejects.toThrow(
      "Billing is paused",
    )
    const forbidden = (async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error("must not fetch")
    }) as typeof fetch
    await expect(executeModelPlanAction({ kind: "portal" }, "", forbidden)).rejects.toThrow("Sign in")
    await expect(
      executeModelPlanAction({ kind: "checkout", plan: "old-topup" } as ModelPlanAction, "fixture-session", forbidden),
    ).rejects.toThrow("Sign in")
  })
})
