import { describe, expect, test } from "bun:test"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { billingNotice, billingProgress, offerAction, offerPrice, planUnknown } from "./codium-billing"

const offer = (id: string, price: number, available = true) => ({
  id,
  name: CodiumPlan.name(id) ?? id,
  price,
  available,
})
const pro = { id: "vector-50", cancelAtPeriodEnd: false, state: "active" }
const renewal = Date.UTC(2026, 10, 1, 12)

describe("Codium plans in Vector", () => {
  test("nothing can be bought while Codium is not on sale: every button reads Coming soon", () => {
    expect(offerAction(offer("vector-10", 10, false))).toEqual({ label: "Coming soon" })
    expect(offerAction(offer("vector-100", 100, false), pro)).toEqual({ label: "Coming soon" })
  })

  test("someone without a plan subscribes; a subscriber sees their plan", () => {
    expect(offerAction(offer("vector-50", 50))).toEqual({
      label: "Subscribe",
      request: { kind: "checkout", plan: "vector-50" },
    })
    expect(offerAction(offer("vector-50", 50), pro)).toEqual({ label: "Current plan", current: true })
  })

  test("a subscriber upgrades now through /change, keeping what is left of this month, at the public price", () => {
    expect(offerAction(offer("vector-100", 100), pro)).toEqual({
      label: "Upgrade",
      request: { kind: "change", plan: "vector-100" },
      detail: "Upgrade to Max: $100 today, then monthly from today. Keeps what's left of this month.",
    })
    expect(offerAction(offer("vector-200", 200), pro)?.request).toEqual({ kind: "change", plan: "vector-200" })
  })

  test("a smaller plan switches at renewal through /change", () => {
    expect(offerAction(offer("vector-10", 10), pro)).toEqual({
      label: "Switch at renewal",
      request: { kind: "change", plan: "vector-10" },
      detail: "Plus starts on your renewal date.",
    })
  })

  test("while a smaller plan is scheduled, only it shows its start; the rest wait for Keep my plan", () => {
    const scheduled = { ...pro, scheduled: { id: "vector-10", name: "Plus", at: renewal } }
    expect(offerAction(offer("vector-10", 10), scheduled)).toEqual({ label: "Starts Nov 1, 2026", current: true })
    // vectordev.ai refuses any other change until the schedule is dropped, so none is offered.
    expect(offerAction(offer("vector-100", 100), scheduled)).toBeUndefined()
    expect(offerAction(offer("vector-200", 200), scheduled)).toBeUndefined()
    expect(offerAction(offer("vector-50", 50), scheduled)).toEqual({ label: "Current plan", current: true })
  })

  test("an ending, paused, renewing or frozen plan offers no change", () => {
    for (const plan of [
      { ...pro, cancelAtPeriodEnd: true },
      { ...pro, state: "paused" },
      { ...pro, state: "renewing" },
      { ...pro, state: "frozen" },
    ]) {
      expect(offerAction(offer("vector-100", 100), plan)).toBeUndefined()
      expect(offerAction(offer("vector-10", 10), plan)).toBeUndefined()
    }
    // A status from before plan states still offers changes to an active plan.
    expect(offerAction(offer("vector-100", 100), { id: "vector-50" })?.label).toBe("Upgrade")
  })

  test("no offer has a button until a signed-in read has said what the account's plan is", () => {
    const status = {
      signedIn: true,
      enabled: true,
      access: true,
      purchased: { bought: false },
      empty: false,
      low: false,
    }
    // Before the read answers, or when it failed, a subscriber would be offered Subscribe, which vectordev.ai refuses.
    expect(planUnknown(undefined)).toEqual({ kind: "info", text: "Reading your plan…" })
    expect(planUnknown({ ...status, error: "Vector could not load your Codium usage. Try again shortly." })).toEqual({
      kind: "error",
      text: "Vector could not load your Codium usage. Try again shortly.",
    })
    expect(planUnknown({ ...status, signedIn: false, access: false })).toEqual({
      kind: "info",
      text: "Sign in to Vector to choose a plan.",
    })
    // Once it has answered, with a plan or without one, the offers follow it.
    expect(planUnknown(status)).toBeUndefined()
    expect(
      planUnknown({ ...status, plan: { id: "vector-50", name: "Pro", renewsAt: renewal, cancelAtPeriodEnd: false } }),
    ).toBeUndefined()
  })

  test("shows the monthly public price and never what it buys", () => {
    expect(offerPrice(offer("vector-50", 50))).toBe("$50 a month")
    for (const plan of [undefined, pro])
      for (const item of [offer("vector-10", 10), offer("vector-100", 100)])
        expect(JSON.stringify(offerAction(item, plan))).not.toMatch(/credit|top-?up|once/i)
  })
})

describe("after a billing request", () => {
  test("says what happened in plain words, and nothing when the person only looked", () => {
    expect(billingNotice({ kind: "checkout", plan: "vector-10" }, { outcome: "completed" })).toEqual({
      kind: "done",
      text: "You are subscribed. Your plan shows here in a moment.",
    })
    expect(billingNotice({ kind: "change", plan: "vector-100" }, { outcome: "completed" })?.text).toBe(
      "Your plan is upgraded. It shows here in a moment, with what was left of this month.",
    )
    expect(
      billingNotice({ kind: "change", plan: "vector-10" }, { outcome: "scheduled", plan: "vector-10", at: renewal }),
    ).toEqual({
      kind: "done",
      text: "Your plan switches to Plus on Nov 1, 2026. Until then it stays as it is.",
    })
    expect(billingNotice({ kind: "keep" }, { outcome: "kept" })?.text).toBe(
      "You are keeping your plan. Nothing changes at renewal.",
    )
    expect(billingNotice({ kind: "portal", flow: "cancel" }, { outcome: "completed" })?.text).toContain(
      "until the end of this billing period",
    )
    expect(billingNotice({ kind: "portal", flow: "payment_method_update" }, { outcome: "completed" })?.text).toBe(
      "Your card is updated. Your plan picks up again once the payment goes through.",
    )
    expect(billingNotice({ kind: "checkout", plan: "vector-10" }, { outcome: "cancelled" })?.text).toBe(
      "Checkout was cancelled. Nothing was charged.",
    )
    expect(billingNotice({ kind: "portal" }, { outcome: "closed" })).toBeUndefined()
    expect(billingNotice({ kind: "portal" }, { outcome: "website" })?.text).toBe(
      "This continues on vectordev.ai in your browser.",
    )
    expect(
      billingNotice(
        { kind: "change", plan: "vector-100" },
        { outcome: "failed", message: "Change plans on vectordev.ai/account." },
      ),
    ).toEqual({ kind: "error", text: "Change plans on vectordev.ai/account." })
  })

  test("a request made while another billing window is open says so, and never how that window ended", () => {
    for (const request of [
      { kind: "checkout", plan: "vector-10" },
      { kind: "change", plan: "vector-100" },
      { kind: "keep" },
      { kind: "portal", flow: "cancel" },
    ] as const)
      expect(billingNotice(request, { outcome: "busy" })).toEqual({
        kind: "info",
        text: "A Stripe window is already open. Finish there or close it, then try again.",
      })
  })

  test("no notice speaks of credits or top-ups", () => {
    const notices = [
      billingNotice({ kind: "checkout", plan: "vector-10" }, { outcome: "completed" }),
      billingNotice({ kind: "change", plan: "vector-100" }, { outcome: "completed" }),
      billingNotice({ kind: "change", plan: "vector-10" }, { outcome: "scheduled", plan: "vector-10", at: renewal }),
      billingNotice({ kind: "keep" }, { outcome: "kept" }),
    ]
    expect(JSON.stringify(notices)).not.toMatch(/credit|top-?up/i)
  })
})

describe("while the billing window is open", () => {
  test("only the steps Stripe finishes promise that the window closes by itself", () => {
    for (const request of [
      { kind: "checkout", plan: "vector-10" },
      { kind: "portal", flow: "cancel" },
      { kind: "portal", flow: "payment_method_update" },
    ] as const)
      expect(billingProgress(request)).toBe("Finish in the Stripe window. It closes by itself when you are done.")
    expect(billingProgress({ kind: "portal" })).toBe("Manage billing in the Stripe window, then close it.")
    expect(billingProgress({ kind: "keep" }, "vector-50")).toBe("Saving your plan change…")
  })

  test("an upgrade waits for the person to pay in Stripe's checkout; a smaller plan is saved without a window", () => {
    const stripe = "Finish in the Stripe window. It closes by itself when you are done."
    expect(billingProgress({ kind: "change", plan: "vector-100" }, "vector-50")).toBe(stripe)
    expect(billingProgress({ kind: "change", plan: "vector-200" }, "vector-10")).toBe(stripe)
    expect(billingProgress({ kind: "change", plan: "vector-10" }, "vector-50")).toBe("Saving your plan change…")
    // Until the plan is read, a change is taken for an upgrade, so nobody waits on a window they must finish.
    expect(billingProgress({ kind: "change", plan: "vector-10" })).toBe(stripe)
  })
})
