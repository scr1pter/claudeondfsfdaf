import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { accountIdentity, codiumSummary, deletionStep, sameEmail, settingsIdentity } from "./account-model"

const renewsAt = Date.UTC(2026, 10, 1, 12)

function status(input: Partial<ModelPlanStatus.Status> = {}): ModelPlanStatus.Status {
  return {
    signedIn: true,
    enabled: true,
    access: true,
    purchased: { bought: false },
    empty: false,
    low: false,
    ...input,
  }
}

describe("Codium on the Account page", () => {
  test("waits for the desktop, then follows the sign-in", () => {
    expect(codiumSummary()).toEqual({ kind: "loading" })
    expect(codiumSummary(status({ signedIn: false }))).toEqual({ kind: "signed-out" })
    expect(codiumSummary(status({ signedIn: false, error: "Your Vector sign-in expired. Sign in again." }))).toEqual({
      kind: "error",
      text: "Your Vector sign-in expired. Sign in again.",
    })
  })

  test("is Coming soon while sales are off and the account has never paid for Codium", () => {
    expect(codiumSummary(status({ enabled: false, access: false }))).toEqual({ kind: "coming-soon" })
  })

  test("keeps billing reachable for someone with past invoices but no plan", () => {
    expect(codiumSummary(status({ enabled: false, access: false, customer: true }))).toMatchObject({
      kind: "plan",
      plan: "Free",
      billing: true,
    })
    // Purchased credits from an older answer neither keep Codium showing nor appear anywhere.
    const old = codiumSummary(status({ enabled: false, access: false, purchased: { bought: true, state: "low" } }))
    expect(old).toEqual({ kind: "coming-soon" })
  })

  test("shows the plan and the share of this month's usage left, never an amount, credits or top-ups", () => {
    const summary = codiumSummary(
      status({
        plan: { id: "vector-50", name: "Pro", left: 0.4237, renewsAt, cancelAtPeriodEnd: false, state: "active" },
        purchased: { bought: true, state: "low" },
      }),
    )
    expect(summary).toEqual({
      kind: "plan",
      plan: "Pro",
      left: 0.4237,
      usage: "42% of this month's usage left",
      renewal: { label: "Renews", date: ModelPlanStatus.formatDate(renewsAt) },
      notice: undefined,
      billing: true,
    })
    expect(JSON.stringify(summary)).not.toMatch(/credit|purchased|top-?up/i)
    if (summary.kind !== "plan") throw new Error("Expected the plan summary")
    expect(summary.usage).not.toMatch(/\d(?!\d*%)/)
  })

  test("names an ending plan, an unverified share and an account with no plan, which is on Free", () => {
    expect(
      codiumSummary(status({ plan: { id: "vector-10", name: "Plus", renewsAt, cancelAtPeriodEnd: true } })),
    ).toMatchObject({ usage: "Usage unavailable", renewal: { label: "Ends" } })
    const none = codiumSummary(status())
    expect(none).toMatchObject({ kind: "plan", plan: "Free", billing: false })
    expect(none).not.toHaveProperty("usage")
    expect(none).not.toHaveProperty("renewal")
    expect(none).not.toHaveProperty("purchased")
  })

  test("a smaller plan scheduled for renewal shows its name and date", () => {
    const summary = codiumSummary(
      status({
        plan: {
          id: "vector-50",
          name: "Pro",
          left: 0.5,
          renewsAt,
          cancelAtPeriodEnd: false,
          state: "active",
          scheduled: { id: "vector-10", name: "Plus", at: renewsAt },
        },
      }),
    )
    expect(summary).toMatchObject({ scheduled: { name: "Plus", date: ModelPlanStatus.formatDate(renewsAt) } })
    expect(summary).not.toHaveProperty("payment")
  })

  test("a paused plan says what starts it again: a new card, or confirming the payment", () => {
    const paused = (action?: "update-card" | "confirm-payment") =>
      codiumSummary(
        status({
          access: false,
          plan: {
            id: "vector-50",
            name: "Pro",
            left: 0.5,
            renewsAt,
            cancelAtPeriodEnd: false,
            state: "paused",
            reason: action === "confirm-payment" ? "action_required" : "payment_failed",
            ...(action ? { action } : {}),
          },
        }),
      )
    expect(paused("update-card")).toMatchObject({
      payment: "update-card",
      notice: {
        kind: "empty",
        text: "Your Codium plan is paused until its payment goes through. Update your card to continue.",
      },
    })
    expect(paused("confirm-payment")).toMatchObject({
      payment: "confirm-payment",
      notice: { kind: "empty", text: "Your Codium plan is paused until you confirm its payment." },
    })
    // A paused answer without an action still needs a working card.
    expect(paused()).toMatchObject({ payment: "update-card" })
  })

  test("keeps a subscriber's plan visible when sales pause, with the server's notice", () => {
    const summary = codiumSummary(
      status({
        enabled: false,
        plan: { id: "vector-10", name: "Plus", left: 1, renewsAt, cancelAtPeriodEnd: false },
      }),
    )
    expect(summary).toMatchObject({ kind: "plan", plan: "Plus", billing: true })
    expect(summary).toMatchObject({ notice: { kind: "unavailable" } })
  })

  test("passes on the low and empty notices", () => {
    expect(codiumSummary(status({ low: true }))).toMatchObject({ notice: { kind: "low" } })
    expect(codiumSummary(status({ access: false }))).toMatchObject({ notice: { kind: "empty" } })
  })
})

describe("account identity", () => {
  test("leads with the name and keeps the email under it", () => {
    expect(accountIdentity({ name: "Ana Diaz", email: "ana@example.com" })).toEqual({
      title: "Ana Diaz",
      detail: "ana@example.com",
    })
  })

  test("shows the email alone when the account has no name", () => {
    expect(accountIdentity({ name: "  ", email: "ana@example.com" })).toEqual({
      title: "ana@example.com",
      detail: undefined,
    })
    expect(accountIdentity({})).toEqual({ title: "", detail: undefined })
  })
})

describe("the Settings header", () => {
  const photo = "data:image/png;base64,iVBORw0KGgo="
  const signedIn = { authenticated: true, pending: false }

  test("names the signed-in person beside their photo", () => {
    expect(settingsIdentity({ ...signedIn, name: "Ana Diaz", email: "ana@example.com", avatar: photo })).toEqual({
      name: "Ana Diaz",
      initials: "AD",
      photo,
    })
  })

  test("shows their initials when there is no photo", () => {
    expect(settingsIdentity({ ...signedIn, name: "Ana Maria Diaz", email: "ana@example.com" })).toEqual({
      name: "Ana Maria Diaz",
      initials: "AD",
      photo: undefined,
    })
    expect(settingsIdentity({ ...signedIn, name: "ana", email: "ana@example.com" })?.initials).toBe("A")
  })

  test("uses the part of the email before the @ when the account has no name", () => {
    expect(settingsIdentity({ ...signedIn, name: "  ", email: "ana.diaz@example.com" })).toEqual({
      name: "ana.diaz",
      initials: "AD",
      photo: undefined,
    })
  })

  test("keeps Vector's logo and name while no one is signed in", () => {
    expect(settingsIdentity({ authenticated: false, pending: false })).toBeUndefined()
    expect(settingsIdentity({ authenticated: false, pending: true, email: "ana@example.com" })).toBeUndefined()
    expect(settingsIdentity({ ...signedIn })).toBeUndefined()
  })

  test("falls back to the initials when the photo will not load, until a different photo arrives", () => {
    const other = "data:image/jpeg;base64,/9j/4AAQ"
    expect(settingsIdentity({ ...signedIn, name: "Ana Diaz", avatar: photo }, photo)).toEqual({
      name: "Ana Diaz",
      initials: "AD",
      photo: undefined,
    })
    expect(settingsIdentity({ ...signedIn, name: "Ana Diaz", avatar: other }, photo)?.photo).toBe(other)
  })

  test("never loads a URL or a non-raster image for the photo", () => {
    for (const avatar of ["https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zz4="])
      expect(settingsIdentity({ ...signedIn, name: "Ana Diaz", avatar })).toEqual({
        name: "Ana Diaz",
        initials: "AD",
        photo: undefined,
      })
  })
})

describe("deleting the account", () => {
  test("shows the desktop's own step first, so a confirmation in progress survives reopening the page", () => {
    expect(deletionStep(false)).toBe("closed")
    expect(deletionStep(true)).toBe("type")
    expect(deletionStep(false, "confirming")).toBe("confirming")
    expect(deletionStep(true, "confirmed")).toBe("confirmed")
  })

  test("asks for the account's own email, compared as vectordev.ai compares it", () => {
    expect(sameEmail(" Ana@Example.com ", "ana@example.com")).toBe(true)
    expect(sameEmail("ana@example.co", "ana@example.com")).toBe(false)
    expect(sameEmail("", "ana@example.com")).toBe(false)
    expect(sameEmail("ana@example.com")).toBe(false)
  })
})
