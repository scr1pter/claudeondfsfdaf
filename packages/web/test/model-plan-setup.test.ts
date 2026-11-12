import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { modelPlans } from "../../../api/_lib/model-plan-config"
import { MODEL_PLAN_STRIPE_VERSION, MODEL_PLAN_WEBHOOK_EVENTS } from "../../../api/_lib/model-plan-stripe"
import { codiumTestEnvironment } from "./fixture/codium-fakes"
import {
  archiveModelPlanTopups,
  modelPlanMonthlyPrices,
  modelPlanPortalConfiguration,
  modelPlanWebhook,
} from "../scripts/model-plan-setup"
import { setupModelPlans } from "../scripts/setup-model-plans"

type ObjectRecord = Record<string, unknown>
type Call = { path: string; method: string; body: URLSearchParams; query: URLSearchParams }
const webhook = "https://codium-test.example.test/api/model-plans/webhook"
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    STRIPE_SECRET_KEY: "sk_test_fixture",
    MODEL_PLANS_ENABLED: "false",
    VECTOR_PUBLIC_URL: "https://codium-test.example.test",
    VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
  })
})
afterEach(() => restore())

/** Local Stripe state with its real immutable tax/version rules and idempotent POST response replay. */
function setupStripeFake() {
  const products: ObjectRecord[] = []
  const prices: ObjectRecord[] = []
  const endpoints: ObjectRecord[] = []
  const configurations: ObjectRecord[] = []
  const calls: Call[] = []
  const idempotency = new Map<string, { request: string; value: ObjectRecord }>()
  let created = 0
  const state = {
    products,
    prices,
    endpoints,
    configurations,
    calls,
    idempotency,
    ignoreUpdates: false,
    fail: undefined as ((call: Call) => Response | undefined) | undefined,
  }
  const metadata = (target: ObjectRecord, body: URLSearchParams) => {
    const values = { ...(target.metadata as Record<string, string> | undefined) }
    for (const [key, value] of body) {
      const field = /^metadata\[(.+)\]$/.exec(key)?.[1]
      if (field) values[field] = value
    }
    target.metadata = values
  }
  const portal = (target: ObjectRecord, body: URLSearchParams) => {
    const features = structuredClone(target.features ?? {}) as Record<string, ObjectRecord>
    for (const [key, value] of body) {
      const field = /^features\[(.+)\]\[(enabled|mode)\]$/.exec(key)
      if (!field) continue
      const feature = (features[field[1]!] ??= {})
      feature[field[2]!] = field[2] === "enabled" ? value === "true" : value
    }
    target.features = features
    if (body.has("active")) target.active = body.get("active") === "true"
    metadata(target, body)
  }
  const updateEndpoint = (target: ObjectRecord, body: URLSearchParams) => {
    if (body.has("api_version")) throw new Error("Webhook API version is immutable after creation.")
    if (body.has("url")) target.url = body.get("url")
    if (body.has("disabled")) target.status = body.get("disabled") === "true" ? "disabled" : "enabled"
    const events = [...body].filter(([key]) => key.startsWith("enabled_events["))
    if (events.length) target.enabled_events = events.map(([, value]) => value)
  }
  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith("/v1/"))
        throw new Error(`Unexpected destination ${url.origin}`)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer sk_test_fixture")
      expect(headers.get("stripe-version")).toBe(MODEL_PLAN_STRIPE_VERSION)
      const method = init?.method ?? "GET"
      const body = new URLSearchParams(String(init?.body ?? ""))
      const path = url.pathname.slice(4)
      const call = { path, method, body, query: url.searchParams }
      calls.push(call)
      const failure = state.fail?.(call)
      if (failure) return failure
      const key = headers.get("idempotency-key")
      const request = `${path}?${body}`
      if (method === "POST") {
        expect(key).toBeTruthy()
        const cached = idempotency.get(key!)
        if (cached) {
          if (cached.request !== request) throw new Error("Idempotency parameters changed.")
          return Response.json(cached.value)
        }
      }
      const respond = (value: ObjectRecord) => {
        if (key) idempotency.set(key, { request, value: structuredClone(value) })
        return Response.json(value)
      }
      const [resource, second, third] = path.split("/")
      const list = (rows: ObjectRecord[]) => {
        const active = url.searchParams.get("active")
        const lookups = url.searchParams.getAll("lookup_keys[]")
        const values = rows.filter(
          (value) =>
            (active === null || value.active === (active === "true")) &&
            (!lookups.length || lookups.includes(String(value.lookup_key))),
        )
        const after = url.searchParams.get("starting_after")
        const start = after ? values.findIndex((value) => value.id === after) + 1 : 0
        const limit = Number(url.searchParams.get("limit") ?? 100)
        return respond({ data: values.slice(start, start + limit), has_more: start + limit < values.length })
      }
      if (resource === "products" && !second && method === "GET") return list(products)
      if (resource === "prices" && !second && method === "GET") return list(prices)
      if (resource === "webhook_endpoints" && !second && method === "GET") return list(endpoints)
      if (resource === "billing_portal" && second === "configurations" && !third && method === "GET")
        return list(configurations)
      const rows =
        resource === "products"
          ? products
          : resource === "prices"
            ? prices
            : resource === "webhook_endpoints"
              ? endpoints
              : configurations
      const id = resource === "billing_portal" ? third : second
      if (id) {
        const target = rows.find((value) => value.id === id)
        if (!target) return Response.json({ error: "not found" }, { status: 404 })
        if (method === "GET") return respond(target)
        if (state.ignoreUpdates) return respond(target)
        if (resource === "products") {
          for (const field of ["name", "statement_descriptor"]) if (body.has(field)) target[field] = body.get(field)
          metadata(target, body)
        } else if (resource === "prices") {
          if (body.has("tax_behavior")) {
            if (
              ["inclusive", "exclusive"].includes(String(target.tax_behavior)) &&
              target.tax_behavior !== body.get("tax_behavior")
            )
              throw new Error("Price tax behavior is immutable.")
            target.tax_behavior = body.get("tax_behavior")
          }
          if (body.has("active")) target.active = body.get("active") === "true"
          metadata(target, body)
        } else if (resource === "webhook_endpoints") updateEndpoint(target, body)
        else portal(target, body)
        return respond(target)
      }
      if (method !== "POST") throw new Error(`Unexpected request ${method} ${path}`)
      created++
      if (resource === "products") {
        const target = {
          id: `prod_${created}`,
          active: true,
          name: body.get("name"),
          statement_descriptor: body.get("statement_descriptor"),
        }
        metadata(target, body)
        products.push(target)
        return respond(target)
      }
      if (resource === "prices") {
        const target = {
          id: `price_${created}`,
          active: true,
          currency: body.get("currency"),
          unit_amount: Number(body.get("unit_amount")),
          product: body.get("product"),
          lookup_key: body.get("lookup_key"),
          tax_behavior: body.get("tax_behavior"),
          recurring: body.has("recurring[interval]")
            ? { interval: body.get("recurring[interval]"), interval_count: 1 }
            : null,
        }
        metadata(target, body)
        prices.push(target)
        return respond(target)
      }
      if (resource === "billing_portal") {
        const target = { id: `bpc_${created}`, active: true }
        portal(target, body)
        configurations.push(target)
        return respond(target)
      }
      if (resource === "webhook_endpoints") {
        const target: ObjectRecord = { id: `we_${created}`, status: "enabled", api_version: body.get("api_version") }
        const copy = new URLSearchParams(body)
        copy.delete("api_version")
        updateEndpoint(target, copy)
        endpoints.push(target)
        return respond({ ...target, secret: `whsec_${created}` })
      }
      throw new Error(`Unexpected request ${method} ${path}`)
    },
    { preconnect: () => {} },
  )
  return { ...state, fetcher, state }
}
type StripeFake = ReturnType<typeof setupStripeFake>
const writes = (fake: StripeFake) => fake.calls.filter((call) => call.method === "POST")
function seedMonthly(fake: StripeFake, tax = "exclusive") {
  for (const plan of modelPlans()) {
    fake.products.push({
      id: `prod_legacy${plan.price}`,
      active: true,
      name: `Vector Codium ${plan.price}`,
      metadata: {},
    })
    fake.prices.push({
      id: `price_legacy${plan.price}`,
      active: true,
      product: `prod_legacy${plan.price}`,
      lookup_key: `vector-models-${plan.price}-monthly-v1`,
      currency: "usd",
      unit_amount: plan.price * 100,
      recurring: { interval: "month", interval_count: 1 },
      tax_behavior: tax,
      metadata: {},
    })
  }
}
function seedTopup(fake: StripeFake, amount = 10) {
  fake.products.push({ id: `prod_topup${amount}`, active: true, name: `Vector Codium ${amount} top-up`, metadata: {} })
  fake.prices.push({
    id: `price_topup${amount}`,
    active: true,
    product: `prod_topup${amount}`,
    lookup_key: `vector-codium-topup-${amount}-v1`,
    currency: "usd",
    unit_amount: amount * 100,
    recurring: null,
  })
}
function seedWebhook(fake: StripeFake, changes: ObjectRecord = {}) {
  const endpoint = {
    id: "we_existing",
    url: webhook,
    api_version: MODEL_PLAN_STRIPE_VERSION,
    status: "enabled",
    enabled_events: [...MODEL_PLAN_WEBHOOK_EVENTS],
    ...changes,
  }
  fake.endpoints.push(endpoint)
  return endpoint
}

describe("A14 local owner setup key and dry-run", () => {
  test.each([undefined, "rk_test_fixture", "rk_live_fixture", "pk_test_fixture"])(
    "dry-run has zero network and four monthly prices with %s",
    async (key) => {
      if (key === undefined) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = key
      const fake = setupStripeFake()
      const lines: string[] = []
      expect(await setupModelPlans({ fetcher: fake.fetcher, log: (line) => lines.push(line) })).toEqual({
        applied: false,
      })
      expect(fake.calls).toEqual([])
      const output = lines.join("\n")
      expect(lines.filter((line) => line.includes("/month; lookup"))).toHaveLength(4)
      for (const amount of [10, 50, 100, 200]) expect(output).toContain(`$${amount}/month`)
      expect(output).toContain("VECTORDEV CODIUM")
      expect(output).toContain("tax_behavior=exclusive")
      expect(output).not.toContain("STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID")
      expect(output).toContain("No changes made")
    },
  )
  test("apply and every importable helper refuse a runtime restricted key before the first fetch", async () => {
    const fake = setupStripeFake()
    process.env.STRIPE_SECRET_KEY = "rk_test_fixture"
    for (const call of [
      () => setupModelPlans({ apply: true, fetcher: fake.fetcher, log: () => {} }),
      () => modelPlanMonthlyPrices(fake.fetcher),
      () => archiveModelPlanTopups(fake.fetcher),
      () => modelPlanPortalConfiguration(fake.fetcher),
      () => modelPlanWebhook(webhook, fake.fetcher),
    ])
      await expect(call()).rejects.toThrow("setup key")
    expect(fake.calls).toEqual([])
  })
  test("setup retains the existing live-key preview refusal", async () => {
    const fake = setupStripeFake()
    process.env.STRIPE_SECRET_KEY = "sk_live_fixture"
    process.env.CODIUM_STRIPE_MODE = "live"
    await expect(setupModelPlans({ apply: true, fetcher: fake.fetcher, log: () => {} })).rejects.toMatchObject({
      code: "MODEL_PLANS_CONFIGURATION",
    })
    expect(fake.calls).toEqual([])
  })
})

describe("A14 four owned monthly products and exact exclusive prices", () => {
  test("fake apply creates exactly four monthly products/prices, one no-change portal and exactly20 webhook events", async () => {
    const fake = setupStripeFake()
    seedTopup(fake)
    const lines: string[] = []
    const result = await setupModelPlans({ apply: true, fetcher: fake.fetcher, log: (line) => lines.push(line) })
    expect(result.applied).toBe(true)
    expect(fake.prices.filter((price) => price.recurring)).toHaveLength(4)
    expect(new Set(fake.prices.filter((price) => price.recurring).map((price) => price.product)).size).toBe(4)
    for (const product of fake.products.filter(
      (value) => (value.metadata as ObjectRecord).vector_codium === "monthly-v1",
    ))
      expect(product.statement_descriptor).toBe("VECTORDEV CODIUM")
    for (const price of fake.prices.filter((value) => value.recurring)) {
      expect(price.tax_behavior).toBe("exclusive")
      expect((price.metadata as ObjectRecord).vector_plan).toMatch(/^vector-(10|50|100|200)$/)
    }
    expect(fake.prices.find((price) => price.id === "price_topup10")!.active).toBe(false)
    expect(fake.configurations).toHaveLength(1)
    expect(fake.endpoints[0]!.enabled_events).toEqual([...MODEL_PLAN_WEBHOOK_EVENTS])
    expect(fake.endpoints[0]!.api_version).toBe(MODEL_PLAN_STRIPE_VERSION)
    expect(lines.join("\n")).toContain("STRIPE_MODEL_PLAN_WEBHOOK_SECRET=whsec_")
    expect(lines.join("\n")).not.toContain("STRIPE_MODEL_TOPUP_")
    expect(process.env.MODEL_PLANS_ENABLED).toBe("false")
  })
  test("repeated apply reuses products, prices, portal and webhook without another provider write", async () => {
    const fake = setupStripeFake()
    await setupModelPlans({ apply: true, fetcher: fake.fetcher, log: () => {} })
    const count = writes(fake).length
    const lines: string[] = []
    await setupModelPlans({ apply: true, fetcher: fake.fetcher, log: (line) => lines.push(line) })
    expect(writes(fake)).toHaveLength(count)
    expect(fake.products).toHaveLength(4)
    expect(fake.prices).toHaveLength(4)
    expect(fake.configurations).toHaveLength(1)
    expect(fake.endpoints).toHaveLength(1)
    expect(lines.join("\n")).not.toContain("STRIPE_MODEL_PLAN_WEBHOOK_SECRET=")
  })
  test("legacy numeric product names and unspecified tax are safely migrated in place", async () => {
    const fake = setupStripeFake()
    seedMonthly(fake, "unspecified")
    const found = await modelPlanMonthlyPrices(fake.fetcher)
    expect(found.map((value) => value.price)).toEqual([10, 50, 100, 200].map((amount) => `price_legacy${amount}`))
    expect(fake.products.map((product) => product.name)).toEqual([
      "Vector Codium Plus",
      "Vector Codium Pro",
      "Vector Codium Max",
      "Vector Codium Ultra",
    ])
    expect(fake.prices.every((price) => price.tax_behavior === "exclusive")).toBe(true)
  })
  test.each(["inclusive", "broken"])("unsafe existing tax %s is refused before any mutation", async (tax) => {
    const fake = setupStripeFake()
    seedMonthly(fake, tax)
    await expect(modelPlanMonthlyPrices(fake.fetcher)).rejects.toThrow(
      tax === "inclusive" ? "immutable inclusive" : "exclusive tax",
    )
    expect(writes(fake)).toEqual([])
  })
  test("an unrelated product sharing a monthly lookup is never renamed or marked", async () => {
    const fake = setupStripeFake()
    seedMonthly(fake)
    fake.products[0]!.name = "Unrelated product"
    await expect(modelPlanMonthlyPrices(fake.fetcher)).rejects.toThrow("not its owned Codium")
    expect(writes(fake)).toEqual([])
  })
  test("two plans sharing one product are refused before any metadata repair", async () => {
    const fake = setupStripeFake()
    seedMonthly(fake)
    fake.prices[1]!.product = fake.prices[0]!.product
    await expect(modelPlanMonthlyPrices(fake.fetcher)).rejects.toThrow("own Codium product")
    expect(writes(fake)).toEqual([])
  })
  test("a lost product-create response recovers its marked product without creating a fifth product", async () => {
    const fake = setupStripeFake()
    const original = fake.fetcher
    let lost = false
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await original(input, init)
        if (!lost && new URL(String(input)).pathname === "/v1/products" && init?.method === "POST") {
          lost = true
          return new Response("lost", { status: 503 })
        }
        return response
      },
      { preconnect: () => {} },
    )
    await expect(modelPlanMonthlyPrices(fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    await modelPlanMonthlyPrices(fetcher)
    expect(fake.products).toHaveLength(4)
    expect(fake.prices).toHaveLength(4)
  })
  test("duplicate marked orphan products are refused instead of picking one", async () => {
    const fake = setupStripeFake()
    fake.products.push(
      ...[1, 2].map((index) => ({
        id: `prod_duplicate${index}`,
        active: true,
        name: "Vector Codium Plus",
        metadata: { vector_codium: "monthly-v1", vector_plan: "vector-10" },
      })),
    )
    await expect(modelPlanMonthlyPrices(fake.fetcher)).rejects.toThrow("More than one Codium product")
    expect(writes(fake)).toEqual([])
  })
  test("provider updates must be confirmed by fresh reads before reporting success", async () => {
    const fake = setupStripeFake()
    seedMonthly(fake, "unspecified")
    fake.state.ignoreUpdates = true
    await expect(modelPlanMonthlyPrices(fake.fetcher)).rejects.toThrow("not its owned Codium monthly product")
    expect(fake.calls.at(-1)).toMatchObject({ path: "products/prod_legacy10", method: "GET" })
  })
  test("only exact historical one-time topup prices are archived", async () => {
    const fake = setupStripeFake()
    seedTopup(fake)
    fake.prices.push({ id: "price_unrelated", active: true, lookup_key: "unrelated-topup-10-v1" })
    expect(await archiveModelPlanTopups(fake.fetcher)).toEqual(["price_topup10"])
    expect(fake.prices.find((price) => price.id === "price_unrelated")!.active).toBe(true)
    expect(await archiveModelPlanTopups(fake.fetcher)).toEqual([])
  })
  test("an unrelated product using the old topup lookup is not archived", async () => {
    const fake = setupStripeFake()
    seedTopup(fake)
    fake.products[0]!.name = "Other service"
    await expect(archiveModelPlanTopups(fake.fetcher)).rejects.toThrow("not archived")
    expect(writes(fake)).toEqual([])
  })
})

describe("A14 portal and exact webhook convergence", () => {
  test("the portal is reused across idempotency expiry and safely repairs plan switching", async () => {
    const fake = setupStripeFake()
    const first = await modelPlanPortalConfiguration(fake.fetcher)
    fake.idempotency.clear()
    expect(await modelPlanPortalConfiguration(fake.fetcher)).toMatchObject({
      id: first.id,
      created: false,
      retired: [],
    })
    const feature = fake.configurations[0]!.features as Record<string, ObjectRecord>
    feature.subscription_update!.enabled = true
    await modelPlanPortalConfiguration(fake.fetcher)
    expect((fake.configurations[0]!.features as Record<string, ObjectRecord>).subscription_update!.enabled).toBe(false)
    expect(fake.configurations).toHaveLength(1)
  })
  test("old marked change portals are deactivated and unrelated configurations remain intact", async () => {
    const fake = setupStripeFake()
    fake.configurations.push(
      { id: "bpc_old", active: true, metadata: { vector_codium: "plan-change-v1" } },
      { id: "bpc_other", active: true, metadata: { other: "service" } },
    )
    expect(await modelPlanPortalConfiguration(fake.fetcher)).toMatchObject({ retired: ["bpc_old"] })
    expect(fake.configurations.find((value) => value.id === "bpc_old")!.active).toBe(false)
    expect(fake.configurations.find((value) => value.id === "bpc_other")!.active).toBe(true)
    expect(writes(fake).filter((call) => call.body.get("features[subscription_update][enabled]") === "true")).toEqual(
      [],
    )
  })
  test("duplicate marked no-change portals refuse before writes", async () => {
    const fake = setupStripeFake()
    fake.configurations.push(
      ...[1, 2].map((index) => ({
        id: `bpc_duplicate${index}`,
        active: true,
        metadata: { vector_codium: "portal-v1" },
      })),
    )
    await expect(modelPlanPortalConfiguration(fake.fetcher)).rejects.toThrow("More than one active Codium")
    expect(writes(fake)).toEqual([])
  })
  test("a deleted webhook recreated on the same day gets a fresh endpoint and secret", async () => {
    const fake = setupStripeFake()
    const first = await modelPlanWebhook(webhook, fake.fetcher)
    fake.endpoints.length = 0
    const second = await modelPlanWebhook(webhook, fake.fetcher)
    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(second.id).not.toBe(first.id)
    expect(second.created && first.created && second.secret !== first.secret).toBe(true)
  })
  test.each([
    { events: ["*"] },
    { events: ["invoice.paid"] },
    { events: [...MODEL_PLAN_WEBHOOK_EVENTS, "customer.created"] },
  ])("wildcard/missing/extra webhook events converge to exactly20: %j", async ({ events }) => {
    const fake = setupStripeFake()
    const endpoint = seedWebhook(fake, { enabled_events: events })
    expect(await modelPlanWebhook(webhook, fake.fetcher)).toMatchObject({
      created: false,
      updated: true,
      missing: [],
    })
    expect(endpoint.enabled_events).toEqual([...MODEL_PLAN_WEBHOOK_EVENTS])
  })
  test("disabled webhook and preview bypass rotation preserve the existing signing secret", async () => {
    const fake = setupStripeFake()
    const endpoint = seedWebhook(fake, { status: "disabled", url: `${webhook}?x-vercel-protection-bypass=old` })
    const next = `${webhook}?x-vercel-protection-bypass=new`
    const result = await modelPlanWebhook(next, fake.fetcher)
    expect(result).toMatchObject({ id: "we_existing", created: false, updated: true })
    expect(result).not.toHaveProperty("secret")
    expect(endpoint).toMatchObject({ url: next, status: "enabled" })
    expect(writes(fake)[0]!.body.has("api_version")).toBe(false)
    expect(writes(fake)[0]!.body.get("disabled")).toBe("false")
  })
  test("existing wrong immutable webhook version needs explicit owner migration", async () => {
    const fake = setupStripeFake()
    seedWebhook(fake, { api_version: "2020-08-27" })
    await expect(modelPlanWebhook(webhook, fake.fetcher)).rejects.toThrow("immutable API version")
    expect(writes(fake)).toEqual([])
  })
  test("duplicate same-address endpoints are refused rather than chosen silently", async () => {
    const fake = setupStripeFake()
    seedWebhook(fake)
    seedWebhook(fake, { id: "we_duplicate" })
    await expect(modelPlanWebhook(webhook, fake.fetcher)).rejects.toThrow("More than one webhook")
    expect(writes(fake)).toEqual([])
  })
  test("an endpoint beyond the first100 records is repaired without creating another", async () => {
    const fake = setupStripeFake()
    fake.endpoints.push(
      ...Array.from({ length: 150 }, (_, index) => ({
        id: `we_other${index}`,
        url: `https://other.example.test/${index}`,
        enabled_events: ["*"],
      })),
    )
    seedWebhook(fake, { enabled_events: ["invoice.paid"] })
    expect(await modelPlanWebhook(webhook, fake.fetcher)).toMatchObject({
      id: "we_existing",
      created: false,
      updated: true,
    })
    expect(fake.endpoints).toHaveLength(151)
  })
  test("an ignored provider webhook update is not called verified", async () => {
    const fake = setupStripeFake()
    seedWebhook(fake, { enabled_events: ["*"] })
    fake.state.ignoreUpdates = true
    await expect(modelPlanWebhook(webhook, fake.fetcher)).rejects.toThrow("did not confirm")
  })
  test("a partial or malformed provider listing never permits a setup mutation", async () => {
    const fake = setupStripeFake()
    fake.state.fail = (call) => (call.method === "GET" ? Response.json({ data: [] }) : undefined)
    await expect(modelPlanWebhook(webhook, fake.fetcher)).rejects.toThrow("read completely")
    expect(writes(fake)).toEqual([])
  })
})
