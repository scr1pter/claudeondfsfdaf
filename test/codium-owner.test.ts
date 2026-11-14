import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { Readable } from "node:stream"
import { Option, Schema } from "effect"
import { CodiumOwner } from "../packages/schema/src/codium-owner"
import { handleCodiumOwner, ownerAuditKey, type CodiumOwnerAction } from "../api/_lib/codium-owner-api"
import { codiumKey } from "../api/_lib/codium-keys"
import { ACCOUNT_RECONCILE_SCRIPT, drainOutbox, saveAccountAndReconcile } from "../api/_lib/codium-provision"
import { readSnapshot } from "../api/_lib/codium-snapshot"
import { readDisabledSet } from "../api/_lib/codium-switches"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  listSubscriptions,
  modelPlanChange,
  modelPlanCheckout,
  ownerRefundQuote,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

const fixture = loadStripeFixture("active-paid")
const id = fixture.accountId
const now = fixture.now * 1000
const owner = "owner@example.test"
const customer = String(fixture.account.customer)
const authURL = "https://owner-auth.example.test"
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    VECTOR_ADMIN_EMAILS: owner,
    SUPABASE_URL: authURL,
    SUPABASE_PUBLISHABLE_KEY: "public-owner-fixture",
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_owner_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_owner_fixture",
    MODEL_PLAN_MODELS_JSON: JSON.stringify([
      {
        id: "fixture/model",
        name: "Fixture",
        contextLength: 8192,
        maxOutputTokens: 2048,
        inputPrice: 1,
        outputPrice: 1,
      },
    ]),
  })
})
afterEach(() => restore())
function token(amr = [{ method: "oauth", timestamp: now / 1000 }]) {
  return `fixture.${Buffer.from(JSON.stringify({ amr, iat: now / 1000 })).toString("base64url")}.fixture`
}
function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  const auth = { email: owner, google: true, verified: true }
  const fetcher = (async (input, init) => {
    if (String(input) !== `${authURL}/auth/v1/user`) return fakes.fetcher(input, init)
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer fixture."))
      return new Response("invalid", { status: 401 })
    return Response.json({
      id,
      email: auth.email,
      email_confirmed_at: auth.verified ? "2026-01-01T00:00:00Z" : null,
      identities: auth.google
        ? [{ provider: "google", identity_data: { email: auth.email, email_verified: true } }]
        : [{ provider: "email" }],
    })
  }) as typeof fetch
  return { ...fakes, auth, fetcher }
}
async function call(
  fakes: ReturnType<typeof seed>,
  action: CodiumOwnerAction,
  body?: unknown,
  options: { token?: string | null; origin?: string } = {},
) {
  const supplied = options.token === undefined ? token() : options.token
  const request = Object.assign(Readable.from([]), {
    method: action === "dashboard" ? "GET" : "POST",
    headers: {
      ...(supplied ? { authorization: `Bearer ${supplied}` } : {}),
      "content-type": "application/json",
      origin: options.origin ?? "https://vectordev.ai",
    },
    body,
  }) as unknown as ApiRequest
  const headers: Record<string, unknown> = {}
  let raw = ""
  const response = {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers[name] = value
    },
    end(value?: string) {
      raw = String(value ?? "")
    },
  } as unknown as ApiResponse
  await handleCodiumOwner(request, response, action, fakes.fetcher, now)
  return { status: response.statusCode, body: JSON.parse(raw) as Record<string, unknown>, raw, headers }
}
async function quote(fakes: ReturnType<typeof seed>) {
  return {
    account: id,
    ...ownerRefundQuote(
      id,
      (await readModelPlanAccount(id, fakes.fetcher))!,
      await listSubscriptions(customer, fakes.fetcher),
      now,
    )!,
  }
}
const refunds = (fakes: CodiumFakes) =>
  fakes.stripe.calls.filter((item) => item.method === "POST" && item.path === "refunds")
const financial = (fakes: CodiumFakes) => fakes.stripe.calls.filter((item) => item.method !== "GET")
function funded(fakes: CodiumFakes) {
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({
      status: "open",
      checkedAt: now,
      since: now,
      balance: 1_000_000,
      owed: 0,
      reserved: 0,
      required: 0,
      keys: 0,
    }),
  )
}

describe("A12 Google owner boundary and audit", () => {
  test("anonymous and non-owner sessions are refused before store/provider data", async () => {
    const fakes = seed()
    expect(await call(fakes, "dashboard", undefined, { token: null })).toMatchObject({ status: 401 })
    fakes.auth.email = "other@example.test"
    expect(await call(fakes, "dashboard")).toMatchObject({ status: 403 })
    expect(fakes.store.commands).toEqual([])
    expect(fakes.stripe.calls).toEqual([])
  })
  test("password-only owner session gets GOOGLE_SIGN_IN_REQUIRED", async () => {
    const fakes = seed()
    fakes.auth.google = false
    expect(
      await call(fakes, "dashboard", undefined, { token: token([{ method: "password", timestamp: now / 1000 }]) }),
    ).toMatchObject({ status: 403, body: { error: { code: "GOOGLE_SIGN_IN_REQUIRED" } } })
  })
  for (const amr of [
    [
      { method: "oauth", timestamp: now / 1000 - 601 },
      { method: "totp", timestamp: now / 1000 },
    ],
    [{ method: "oauth", timestamp: now / 1000 + 60 }],
    [{ method: "oauth", timestamp: now / 1000 - 600 }],
  ])
    test(`stale/future original OAuth refuses a mutation despite fresh JWT/MFA: ${JSON.stringify(amr)}`, async () => {
      const fakes = seed()
      expect(await call(fakes, "switch", { name: "sales", value: "off" }, { token: token(amr) })).toMatchObject({
        status: 401,
        body: { error: { code: "RECENT_SIGN_IN_REQUIRED" } },
      })
      expect(fakes.store.commands).toEqual([])
    })
  test("fresh Google changes atomically audited switches; audit and responses contain no email", async () => {
    const fakes = seed()
    expect(await call(fakes, "switch", { name: "sales", value: "off" })).toMatchObject({
      status: 200,
      body: { accepted: true },
    })
    expect(fakes.store.zset(ownerAuditKey()).size).toBe(2)
    const raw = JSON.stringify([...fakes.store.zset(ownerAuditKey()).keys()])
    expect(raw).not.toContain(owner)
    expect(raw).not.toContain("@")
    expect(raw).toContain("completed")
  })
  test("cross-origin writes and incomplete refund confirmations are rejected before effects", async () => {
    const fakes = seed()
    expect(
      await call(fakes, "switch", { name: "codium", value: "off" }, { origin: "https://evil.example" }),
    ).toMatchObject({ status: 403 })
    expect(await call(fakes, "refund-end", { account: id })).toMatchObject({ status: 400 })
    expect(financial(fakes)).toEqual([])
  })
  test("a removed model can be restored but a new unknown disabled ID is refused", async () => {
    const fakes = seed()
    fakes.store.members(codiumKey("models-off")).add("old/model")
    expect(await call(fakes, "switch", { name: "model-off:old/model", value: "on" })).toMatchObject({ status: 200 })
    expect(await readDisabledSet("models-off", fakes.fetcher, { fresh: true })).toEqual(new Set())
    expect(await call(fakes, "switch", { name: "model-off:unknown/model", value: "off" })).toMatchObject({
      status: 400,
    })
  })
  test("owner replay validates seconds and leaves the cron cursor untouched", async () => {
    const fakes = seed()
    fakes.store.set(codiumKey("stripe", "cursor"), "123")
    expect(await call(fakes, "replay", { since: Math.floor(now / 1000) - 3600 })).toMatchObject({
      status: 200,
      body: { accepted: true },
    })
    expect(fakes.store.get(codiumKey("stripe", "cursor"))).toBe("123")
    expect(await call(fakes, "replay", { since: now })).toMatchObject({ status: 400 })
  })
})

describe("A12 private dashboard", () => {
  test("the explicit wire shape includes owner metrics and never emails, provider secrets or encrypted keys", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    funded(fakes)
    fakes.stripe.objects.customers.get(customer)!.email = "customer-secret@example.test"
    fakes.stripe.subscription("sub_active")!.private_secret = "stripe-private-secret"
    const answer = await call(fakes, "dashboard")
    expect(answer.status).toBe(200)
    expect(Option.isSome(Schema.decodeUnknownOption(CodiumOwner.Dashboard)(answer.body))).toBe(true)
    expect(answer.raw).not.toContain("@")
    expect(answer.raw).not.toContain("stripe-private-secret")
    expect(answer.raw).not.toContain((await readModelPlanAccount(id, fakes.fetcher))!.key!.encrypted)
    expect(answer.body.accounts).toMatchObject([{ account: id, refundCents: 1000, refundCharge: "ch_active" }])
    expect(answer.headers["x-robots-tag"]).toContain("noindex")
  })
  test("sales readiness uses the canonical configuration guard when provider management is missing", async () => {
    const fakes = seed()
    funded(fakes)
    expect((await call(fakes, "dashboard")).body.sales).toMatchObject({ enabled: true })
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    const answer = await call(fakes, "dashboard")
    expect(answer.status).toBe(200)
    expect(answer.body.sales).toMatchObject({ enabled: false, reason: "Codium billing configuration is incomplete." })
    expect(
      (answer.body.subscriptions as Record<string, unknown>[]).find((plan) => plan.plan === "vector-10"),
    ).toMatchObject({ count: 1 })
    expect(answer.raw).not.toContain("OPENROUTER_MANAGEMENT_KEY")
  })
  test("future or old funding is never projected as current sales authorization", async () => {
    for (const checkedAt of [now + 1, now - 15 * 60_000]) {
      const fakes = seed()
      funded(fakes)
      const value = JSON.parse(fakes.store.get(codiumKey("funding"))!)
      fakes.store.set(codiumKey("funding"), JSON.stringify({ ...value, checkedAt }))
      const answer = await call(fakes, "dashboard")
      expect(answer.status).toBe(200)
      expect(answer.body.sales).toMatchObject({
        enabled: false,
        reason: "No current verified funding reading is available.",
      })
    }
  })
  test("future replay checkpoints cannot claim current webhook health", async () => {
    const fakes = seed()
    fakes.store.set(codiumKey("stripe", "cursor"), String(Math.floor(now / 1000) + 60))
    const answer = await call(fakes, "dashboard")
    expect(answer.status).toBe(200)
    expect(answer.body.health).toMatchObject({ webhooks: { status: "unknown" } })
  })
  test("an unavailable provider leaves payment quotes and risk counts unknown", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.fail = () => new Response("unavailable", { status: 503 })
    const answer = await call(fakes, "dashboard")
    expect(answer.status).toBe(200)
    expect(answer.body.risk).toMatchObject({ disputes30d: null, paidInvoices30d: null })
    expect((answer.body.accounts as Record<string, unknown>[])[0]).not.toHaveProperty("refundCents")
  })
})

describe("A12 immutable refund and end operation", () => {
  test("freezes and disables before financial effects, refunds the current source once and ends", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.stripe.fail = (item) => {
      if (item.method !== "GET") {
        expect(JSON.parse(fakes.store.get(codiumKey("ent", id))!).state).toBe("frozen")
        expect(fakes.openRouter.keys.get(key.hash)!.disabled).toBe(true)
      }
      return undefined
    }
    const expected = await quote(fakes)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(1)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd!.done).toBe(true)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended", reason: "refunded" })
  })
  test("a fresh zero-refund confirmation preserves the prior settled refund while ending new checkouts", async () => {
    const fakes = seed()
    expect(await call(fakes, "refund-end", await quote(fakes))).toMatchObject({ status: 200 })
    const fresh = await quote(fakes)
    expect(fresh.expectedRefundCents).toBe(0)
    expect(fresh.expectedCharge).toBeNull()
    funded(fakes)
    await modelPlanCheckout({ id, email: owner }, "vector-10", fakes.fetcher, now)
    const session = [...fakes.stripe.objects.checkout_sessions.values()][0]!
    expect(await call(fakes, "refund-end", fresh)).toMatchObject({ status: 200 })
    expect(session.status).toBe("expired")
    expect(refunds(fakes)).toHaveLength(1)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended", reason: "refunded" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended", reason: "refunded" })
  })
  test("a later paid subscription remains independent of the completed owner refund", async () => {
    const fakes = seed()
    const original = await quote(fakes)
    expect(await call(fakes, "refund-end", original)).toMatchObject({ status: 200 })
    const sub = structuredClone(fixture.objects.subscriptions![0]!)
    const invoice = structuredClone(fixture.objects.invoices![0]!)
    const charge = structuredClone(fixture.objects.charges![0]!)
    Object.assign(sub, { id: "sub_later", latest_invoice: "in_later", created: now / 1000 })
    Object.assign(invoice, { id: "in_later", subscription: "sub_later", charge: "ch_later" })
    Object.assign(charge, { id: "ch_later", invoice: "in_later" })
    fakes.stripe.load({ subscriptions: [sub], invoices: [invoice], charges: [charge] })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active", subscription: "sub_later" })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.subscription).toBe("sub_later")
    expect(await call(fakes, "refund-end", original)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(1)
    expect(fakes.stripe.subscription("sub_later")!.status).toBe("active")
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active", subscription: "sub_later" })
  })
  test("ending an expired period without a cash refund records canceled on its retired key", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const subscription = fakes.stripe.subscription("sub_active")!
    subscription.current_period_end = now / 1000 - 1
    const invoice = fakes.stripe.objects.invoices.get("in_active")!
    const lines = invoice.lines as { data: { period: { end: number } }[] }
    lines.data[0]!.period.end = now / 1000 - 1
    const expected = await quote(fakes)
    expect(expected.expectedRefundCents).toBe(0)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(0)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.revoked).toBe("canceled")
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended", reason: "canceled" })
  })
  test("a key-disable failure performs no cancellation or refund and intent remains queued", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const expected = await quote(fakes)
    fakes.openRouter.fail = (item) =>
      item.method === "PATCH" ? new Response("unavailable", { status: 503 }) : undefined
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 503 })
    expect(financial(fakes)).toEqual([])
    expect(fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1])).toContain(`reconcile:${id}`)
  })
  test("a lost response after successful refund discovers the exact refund and never posts twice", async () => {
    const fakes = seed()
    const expected = await quote(fakes)
    const original = fakes.fetcher
    let lost = false
    fakes.fetcher = (async (input, init) => {
      const response = await original(input, init)
      if (!lost && String(input).endsWith("/refunds") && init?.method === "POST") {
        lost = true
        return new Response("lost", { status: 503 })
      }
      return response
    }) as typeof fetch
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 502 })
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(1)
  })
  test("HTTP200 pending is not completed; settlement is checked without another refund", async () => {
    const fakes = seed()
    fakes.stripe.refundStatus = "pending"
    const expected = await quote(fakes)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({
      status: 503,
      body: { error: { code: "CODIUM_REFUND_PENDING" } },
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd!.done).toBe(false)
    const refund = [...fakes.stripe.objects.refunds.values()][0]!
    refund.status = "succeeded"
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(1)
  })
  test("HTTP200 failed remains incomplete and only a new owner confirmation starts another attempt", async () => {
    const fakes = seed()
    fakes.stripe.refundStatus = "failed"
    const expected = await quote(fakes)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({
      status: 503,
      body: { error: { code: "CODIUM_REFUND_FAILED" } },
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd!.done).toBe(false)
    await drainOutbox({ now, fetcher: fakes.fetcher })
    expect(refunds(fakes)).toHaveLength(1)
    fakes.stripe.refundStatus = "succeeded"
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(2)
    expect(new Set(refunds(fakes).map((item) => item.idempotencyKey)).size).toBe(2)
  })
  test("a partial prior refund returns only the remaining amount", async () => {
    const fakes = seed()
    Object.assign(fakes.stripe.charge("ch_active")!, { amount_refunded: 400 })
    fakes.stripe.load({
      refunds: [{ id: "re_prior", charge: "ch_active", amount: 400, currency: "usd", status: "succeeded" }],
    })
    const expected = await quote(fakes)
    expect(expected.expectedRefundCents).toBe(600)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)[0]!.form!.get("amount")).toBe("600")
  })
  test("changed source or amount after preview is refused before any financial action", async () => {
    const fakes = seed()
    const expected = await quote(fakes)
    expect(await call(fakes, "refund-end", { ...expected, expectedCharge: "ch_foreign" })).toMatchObject({
      status: 409,
    })
    expect(await call(fakes, "refund-end", { ...expected, expectedRefundCents: 999 })).toMatchObject({ status: 409 })
    expect(
      await call(fakes, "refund-end", {
        ...expected,
        expectedPeriodStart: Number(expected.expectedPeriodStart) - 1000,
      }),
    ).toMatchObject({ status: 409 })
    expect(financial(fakes)).toEqual([])
  })
  test("simultaneous confirmations cannot create two refund operations", async () => {
    const fakes = seed()
    const expected = await quote(fakes)
    const answers = await Promise.all([call(fakes, "refund-end", expected), call(fakes, "refund-end", expected)])
    expect(answers.some((answer) => answer.status === 200)).toBe(true)
    expect(answers.every((answer) => [200, 409].includes(answer.status))).toBe(true)
    expect(refunds(fakes)).toHaveLength(1)
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(refunds(fakes)).toHaveLength(1)
  })
  test("a foreign customer charge cannot be refunded even when it appears in the invoice expansion", async () => {
    const fakes = seed()
    const expected = await quote(fakes)
    fakes.stripe.charge("ch_active")!.customer = "cus_foreign"
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 409 })
    expect(financial(fakes)).toEqual([])
  })
  test("an HTTP200 malformed refund result never completes the saved operation", async () => {
    const fakes = seed()
    fakes.stripe.fail = (item) =>
      item.method === "POST" && item.path === "refunds"
        ? Response.json({ id: "re_wrong", charge: "ch_foreign", amount: 1000, currency: "usd", status: "succeeded" })
        : undefined
    expect(await call(fakes, "refund-end", await quote(fakes))).toMatchObject({ status: 503 })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd!.done).toBe(false)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "frozen" })
  })
  test("a pending refund prevents clear-risk from reopening access", async () => {
    const fakes = seed()
    fakes.stripe.refundStatus = "pending"
    expect(await call(fakes, "refund-end", await quote(fakes))).toMatchObject({ status: 503 })
    expect(await call(fakes, "clear-risk", { account: id })).toMatchObject({
      status: 409,
      body: { error: { code: "CODIUM_ACCOUNT_UNAVAILABLE" } },
    })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "frozen" })
  })
  test("real pending subscription and upgrade checkouts are expired using their actual identity contract", async () => {
    for (const upgrade of [false, true]) {
      const fakes = seed()
      if (!upgrade) fakes.stripe.objects.subscriptions.clear()
      funded(fakes)
      const user = { id, email: owner }
      if (upgrade) await modelPlanChange(user, "vector-50", fakes.fetcher, now)
      else await modelPlanCheckout(user, "vector-10", fakes.fetcher, now)
      const session = [...fakes.stripe.objects.checkout_sessions.values()][0]!
      expect(session.client_reference_id).toBe(id)
      expect((session.metadata as Record<string, unknown>).vector_account_id).toBeUndefined()
      expect(await call(fakes, "refund-end", await quote(fakes))).toMatchObject({ status: 200 })
      expect(session.status).toBe("expired")
    }
  })
  test("a real checkout completing between subscription and session discovery requires a fresh quote", async () => {
    const fakes = seed()
    fakes.stripe.objects.subscriptions.clear()
    funded(fakes)
    await modelPlanCheckout({ id, email: owner }, "vector-10", fakes.fetcher, now)
    const session = [...fakes.stripe.objects.checkout_sessions.values()][0]!
    const expected = await quote(fakes)
    const original = fakes.fetcher
    let completed = false
    fakes.fetcher = (async (input, init) => {
      const response = await original(input, init)
      if (!completed && new URL(String(input)).pathname === "/v1/subscriptions" && init?.method === "GET") {
        completed = true
        fakes.stripe.load({ subscriptions: fixture.objects.subscriptions })
        Object.assign(session, { status: "complete", subscription: "sub_active" })
      }
      return response
    }) as typeof fetch
    expect(await call(fakes, "refund-end", expected)).toMatchObject({
      status: 409,
      body: { error: { code: "CODIUM_REFUND_CHANGED" } },
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd).toBeUndefined()
    expect(financial(fakes).filter((item) => item.path !== "checkout/sessions")).toEqual([])
    expect(await call(fakes, "refund-end", await quote(fakes))).toMatchObject({ status: 200 })
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
  })
  test("a captured checkout completing after final confirmation still has its subscription canceled", async () => {
    const fakes = seed()
    fakes.stripe.objects.subscriptions.clear()
    funded(fakes)
    await modelPlanCheckout({ id, email: owner }, "vector-10", fakes.fetcher, now)
    const session = [...fakes.stripe.objects.checkout_sessions.values()][0]!
    const expected = await quote(fakes)
    const original = fakes.fetcher
    let reads = 0
    fakes.fetcher = (async (input, init) => {
      const response = await original(input, init)
      if (new URL(String(input)).pathname === "/v1/subscriptions" && init?.method === "GET" && ++reads === 2) {
        fakes.stripe.load({ subscriptions: fixture.objects.subscriptions })
        Object.assign(session, { status: "complete", subscription: "sub_active" })
      }
      return response
    }) as typeof fetch
    expect(await call(fakes, "refund-end", expected)).toMatchObject({ status: 200 })
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect((await readModelPlanAccount(id, fakes.fetcher))!.ownerEnd!.checkouts).toContain(session.id)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "ended" })
  })
})

describe("A12 exact risk acknowledgement", () => {
  test("fresh open disputes cannot be cleared and pending owner operations remain held", async () => {
    const fakes = seed()
    fakes.stripe.charge("ch_active")!.disputed = true
    fakes.stripe.load({ disputes: [{ id: "dp_active", charge: "ch_active", status: "needs_response" }] })
    expect(await call(fakes, "clear-risk", { account: id })).toMatchObject({
      status: 409,
      body: { error: { code: "CODIUM_DISPUTE_OPEN" } },
    })
  })
  test("an acknowledged lost dispute does not reblock on replay; a later open transition invalidates it", async () => {
    const fakes = seed()
    fakes.stripe.charge("ch_active")!.disputed = true
    fakes.stripe.load({ disputes: [{ id: "dp_active", charge: "ch_active", status: "lost" }] })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "dispute", charge: "ch_active" } })
    expect(await call(fakes, "clear-risk", { account: id })).toMatchObject({ status: 200 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "dispute", charge: "ch_active" } })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk!.blocked).toBe(false)
    fakes.stripe.objects.disputes.get("dp_active")!.status = "needs_response"
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "dispute", charge: "ch_active" } })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk!.openDisputes).toHaveProperty("ch_active")
    fakes.stripe.objects.disputes.get("dp_active")!.status = "lost"
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "dispute", charge: "ch_active" } })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk!.blocked).toBe(true)
  })
  test("clearing one warning does not ignore another warning on the same charge", async () => {
    const fakes = seed()
    fakes.stripe.load({ early_fraud_warnings: [{ id: "issfr_old", charge: "ch_active", actionable: false }] })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "efw", id: "issfr_old" } })
    expect(await call(fakes, "clear-risk", { account: id })).toMatchObject({ status: 200 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "efw", id: "issfr_old" } })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk!.efw).toEqual([])
    fakes.stripe.load({ early_fraud_warnings: [{ id: "issfr_new", charge: "ch_active", actionable: false }] })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "efw", id: "issfr_new" } })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk!.efw).toEqual(["ch_active"])
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("A12 intent publication on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  test("account intent and its unique repair action publish atomically", async () => {
    const fakes = seed()
    const fetcher = (async (_input, init) => {
      const command = JSON.parse(String(init?.body)).map(String) as string[]
      return Response.json({ result: await client!.send(command[0]!, command.slice(1)) })
    }) as typeof fetch
    await client!.send("FLUSHDB", [])
    await saveAccountAndReconcile(id, fixture.account, fetcher, now)
    const before = await client!.send("GET", [codiumKey("outbox", "item", `reconcile:${id}`)])
    await saveAccountAndReconcile(id, { ...fixture.account, ownerMarker: true }, fetcher, now)
    expect(await client!.send("GET", [codiumKey("account", id)])).toContain('"ownerMarker":true')
    expect(await client!.send("GET", [codiumKey("outbox", "item", `reconcile:${id}`)])).not.toBe(before)
    expect(ACCOUNT_RECONCILE_SCRIPT).toContain("redis.call('SET', KEYS[4], ARGV[5])")
    expect(fakes.stripe.calls).toEqual([])
  })
})
