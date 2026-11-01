import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { buildSnapshot } from "../../../api/_lib/codium-snapshot"
import type { ModelPlanCatalogOptions } from "../../../api/_lib/model-plan-catalog-policy"
import { configuredPlanModels, type ModelPlanModel } from "../../../api/_lib/model-plan-config"
import { CODIUM_AUTO_ID, handleModelPlanModels } from "../../../api/_lib/model-plan-models"
import { CodiumAuto } from "@vectordevai/core/codium-auto"
import { ModelPlans } from "@vectordevai/core/model-plans"
import type { CodiumPlan } from "../../../packages/schema/src/codium-plan"
import type { PlanState } from "../../../packages/schema/src/codium-entitlements"

// The catalog Vector polls about once a minute (§4.12). It reads only the store: the snapshot, the `codium` switch and
// `models-off`, never Stripe or OpenRouter, even when the snapshot is missing. External services are local fakes; the
// store fake answers reads only and throws on anything else.
const user = { id: "22222222-2222-4222-8222-222222222222", email: "fixture@example.test" }
const environment: Record<string, string> = {
  VECTOR_CLI_TOKEN_SECRET: "fixture-cli-token-secret-that-is-long-enough",
  KV_REST_API_URL: "https://kv.fixture.invalid",
  KV_REST_API_TOKEN: "fixture-kv-token",
  MODEL_PLANS_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_fixture_placeholder",
  STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture_placeholder",
  STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture_placeholder",
  OPENROUTER_MANAGEMENT_KEY: "fixture-management-placeholder",
  MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
  ...Object.fromEntries(
    [10, 50, 100, 200].map((price) => [`STRIPE_MODEL_PLAN_${price}_PRICE_ID`, `price_fixture${price}`]),
  ),
  // Made-up fixture allowances that keep the public usage multiples (5.5x, 12x and 25x Plus), which Codium's
  // configuration requires; a markup alone scales by price and cannot.
  ...Object.fromEntries(
    [
      [10, "4"],
      [50, "22"],
      [100, "48"],
      [200, "100"],
    ].map(([price, credits]) => [`MODEL_PLAN_${price}_CREDITS_USD`, credits]),
  ),
}
const previous = new Map([...Object.keys(environment), "MODEL_PLAN_MODELS_JSON"].map((key) => [key, process.env[key]]))
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"
const HAIKU = "anthropic/claude-haiku-5.5"
const LUNA = "openai/gpt-6-luna"
const KIMI = "moonshotai/kimi-k3.1-pro"
const ARGON = "google/gemini-4-argon"
const SOL = "openai/gpt-6.1-sol"
const STAGED_SOL = [SOL, "openai/gpt-6.1-sol:deep", "openai/gpt-6.1-sol:deepest"]

type Seed = {
  plan?: CodiumPlan.PlanId
  state?: PlanState
  switchOff?: boolean
  modelsOff?: string[]
  revoked?: boolean
}
type Entry = {
  id: string
  locked?: { plan: string }
  manualOnly?: boolean
  role?: string
  auto?: { floor: string; default: string; ceiling: string }
}

/**
 * A fresh store fake for one case. Each case gets its own fetcher, because switch and `models-off` reads are cached
 * for 30 s per fetcher (codium-switches.ts): a shared one would carry an earlier case's answer into the next.
 */
function service(seed: Seed = {}, options: ModelPlanCatalogOptions = {}) {
  const now = Date.now()
  const snapshot =
    seed.plan &&
    buildSnapshot(
      {
        account: user.id,
        state: seed.state ?? "active",
        ...(seed.state === "paused" ? { reason: "payment_failed" as const } : {}),
        plan: seed.state === "none" ? null : seed.plan,
        subscription: "sub_models",
        periodStart: now - 3_600_000,
        periodEnd: now + 29 * 86_400_000,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      now,
    )
  const calls: string[] = []
  const commands: string[][] = []
  current.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url !== environment.KV_REST_API_URL) throw new Error(`Unexpected request to ${url}`)
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    if (command[0] === "SMEMBERS" && command[1] === "vector:codium:test:models-off")
      return Response.json({ result: seed.modelsOff ?? [] })
    if (command[0] !== "GET") throw new Error(`Unexpected store command ${command[0]}`)
    if (command[1] === `vector:cli-revoked:${user.id}`) return Response.json({ result: seed.revoked ? "1" : null })
    if (command[1] === "vector:codium:test:switch:codium")
      return Response.json({ result: seed.switchOff ? "off" : null })
    if (command[1] === `vector:codium:test:ent:${user.id}`)
      return Response.json({ result: snapshot ? JSON.stringify(snapshot) : null })
    return Response.json({ result: null })
  }) as typeof fetch
  current.options = options
  return { calls, commands }
}
const current: { fetcher: typeof fetch; options: ModelPlanCatalogOptions } = { fetcher: fetch, options: {} }
const server = createServer(
  (request, response) => void handleModelPlanModels(request, response, current.fetcher, current.options),
)
const origin = { url: "" }

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  Object.assign(process.env, environment)
  delete process.env.MODEL_PLAN_MODELS_JSON
})
afterAll(() => {
  server.close()
  for (const [key, value] of previous) {
    delete process.env[key]
    if (value !== undefined) process.env[key] = value
  }
})

/** A catalog read; `token` "" sends no authorization, `catalog` false is a client without `X-Vector-Catalog: 2`. */
const models = async (token = mintCliToken(user, Date.now(), "desktop").token, catalog = true) => {
  const response = await fetch(`${origin.url}/api/model-plans/models`, {
    headers: {
      "x-vector-client": "1.99.113",
      ...(catalog ? { "x-vector-catalog": "2" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  return { status: response.status, body: await response.json() }
}
const everything = () => true
const tiered = () => configuredPlanModels({ tiered: true })
const ids = (body: { models: Entry[] }) => body.models.map((model) => model.id)
const find = (body: { models: Entry[] }, id: string) => body.models.find((model) => model.id === id)

test("production lists no model until a route is accepted, and reads only the store, never Stripe or OpenRouter", async () => {
  for (const seed of [{ plan: "vector-50" as const }, {}]) {
    const store = service(seed)
    const { status, body } = await models()
    expect(status).toBe(200)
    // ROUTE_ACCEPTANCES is empty: every route chat would answer 503 for is left out, here as there.
    expect(body).toEqual({
      enabled: true,
      plan: seed.plan ?? null,
      // Without a plan, Plus's public cap, as the locks are Plus's.
      limits: { inFlight: seed.plan ? 6 : 3 },
      models: [],
      review: {},
    })
    // A missing snapshot is never reconciled from here (M4): reads of the store only.
    expect(new Set(store.calls)).toEqual(new Set([environment.KV_REST_API_URL]))
    expect(store.commands.every((command) => command[0] === "GET" || command[0] === "SMEMBERS")).toBe(true)
  }
})

test("Plus sees its models, Pro's locked with the plan that unlocks them, and Codium Auto after DeepSeek", async () => {
  service({ plan: "vector-10" }, { qualify: everything })
  const { body } = await models()
  expect(body.plan).toBe("vector-10")
  expect(body.limits).toEqual({ inFlight: 3 })
  expect(ids(body)).toEqual([DEEPSEEK, "vector/codium-auto", HAIKU, LUNA, KIMI, ARGON])
  expect(body.models[0]).toEqual({
    id: DEEPSEEK,
    name: "DeepSeek V4.1 Flash 1017",
    contextLength: 262144,
    maxOutputTokens: 16384,
    lab: "deepseek",
    weight: 1,
    role: "default",
  })
  // Plus's default and ceiling are both DeepSeek; its floor is Luna. Auto's window is its smallest role's; its lab and
  // weight are its default model's (§4.12 lists both for every entry).
  expect(body.models[1]).toEqual({
    id: "vector/codium-auto",
    name: "Codium Auto",
    contextLength: 128000,
    maxOutputTokens: 8192,
    lab: "deepseek",
    weight: 1,
    auto: { floor: LUNA, default: DEEPSEEK, ceiling: DEEPSEEK },
  })
  expect(find(body, LUNA)).toMatchObject({ role: "floor" })
  for (const id of [KIMI, ARGON]) expect(find(body, id)).toMatchObject({ locked: { plan: "vector-50", name: "Pro" } })
  expect(find(body, KIMI)?.role).toBeUndefined()
  // Plus has no Second opinion judges; its review pairs are all its own models.
  expect(body.judges).toBeUndefined()
  expect(body.review).toEqual({ triage: DEEPSEEK, confirm: LUNA, panelJudge: HAIKU })
  // The current client decodes this answer whole: Auto names usable models, so it stays and resolves to them, and its
  // helpers start on the floor.
  const decoded = await ModelPlans.createClient({ request: async () => Response.json(body) }).catalog("vct_t.s", {
    force: true,
  })
  expect(decoded.models.map((model) => model.id)).toEqual(ids(body))
  expect(ModelPlans.AUTO_ID).toBe(CODIUM_AUTO_ID)
  expect(CodiumAuto.resolve({ catalog: decoded, tier: "chat", contextTokens: 1 })?.id).toBe(LUNA)
  expect(CodiumAuto.resolve({ catalog: decoded, tier: "thorough", contextTokens: 1 })?.id).toBe(DEEPSEEK)
  expect(CodiumAuto.helper(decoded)?.id).toBe(LUNA)

  // Pro unlocks them.
  service({ plan: "vector-50" }, { qualify: everything })
  expect((await models()).body.models.filter((model: Entry) => model.locked)).toEqual([])
})

test("old clients get only usable models in the four-field shape, Plus's set without a plan, and no Auto", async () => {
  service({}, { qualify: everything })
  expect(await models(undefined, false)).toEqual({
    status: 200,
    body: {
      enabled: true,
      models: configuredPlanModels()
        .filter((model) => model.id !== KIMI && model.id !== ARGON)
        .map((model) => ({
          id: model.id,
          name: model.name,
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
        })),
    },
  })
  // A Pro catalog with manual-only variants: an old client cannot keep those out of helpers and routing.
  service({ plan: "vector-50" }, { models: tiered(), qualify: everything })
  const pro = (await models(undefined, false)).body
  expect(ids(pro)).toEqual([DEEPSEEK, HAIKU, LUNA, SOL, KIMI, ARGON])
  expect(pro.models.every((model: object) => Object.keys(model).length === 4)).toBe(true)
})

test("Auto, judges and review keep only served models: with Sol staged, Pro's ceiling falls back to the default", async () => {
  service({ plan: "vector-50" }, { models: tiered(), qualify: (model) => !STAGED_SOL.includes(model.id) })
  const { body } = await models()
  expect(find(body, "vector/codium-auto")?.auto).toEqual({ floor: LUNA, default: DEEPSEEK, ceiling: DEEPSEEK })
  expect(ids(body).some((id) => STAGED_SOL.includes(id))).toBe(false)
  // Every Pro judge pair names Sol except Luna's: only that one is kept. The review keeps its served members.
  expect(body.judges).toEqual({ [LUNA]: ARGON })
  expect(body.review).toEqual({ triage: DEEPSEEK, panelJudge: ARGON })
  // Long variants are listed, manual only, and never carry a role.
  for (const id of ["moonshotai/kimi-k3.1-pro:long", "google/gemini-4-argon:long"])
    expect(find(body, id)).toMatchObject({ manualOnly: true, contextLength: 256000 })
  expect(body.models.filter((model: Entry) => model.manualOnly && model.role)).toEqual([])
  // Higher tiers are locked and described at their own plan: DeepSeek Long shows Max's 512K, Opus names Ultra.
  expect(find(body, "deepseek/deepseek-v4.1-flash-1017:long")).toMatchObject({
    contextLength: 512000,
    manualOnly: true,
    locked: { plan: "vector-100", name: "Max" },
  })
  expect(find(body, "anthropic/claude-opus-5.5")).toMatchObject({ locked: { plan: "vector-200", name: "Ultra" } })

  // With Sol served, Pro's ceiling, confirm model and judges are its own again.
  service({ plan: "vector-50" }, { models: tiered(), qualify: everything })
  const full = (await models()).body
  expect(find(full, "vector/codium-auto")?.auto?.ceiling).toBe(SOL)
  expect(full.review).toEqual({ triage: DEEPSEEK, confirm: SOL, panelJudge: ARGON })
  expect(Object.keys(full.judges)).toHaveLength(8)

  // Without the default or the floor, Auto is not offered.
  service({ plan: "vector-50" }, { models: tiered(), qualify: (model) => model.id !== DEEPSEEK && model.id !== LUNA })
  expect(ids((await models()).body)).not.toContain("vector/codium-auto")
})

test("a preview opens a model to Ultra only, and says so on every other plan", async () => {
  const until = Date.now() + 7 * 86_400_000
  const preview: ModelPlanModel = { ...tiered()[0]!, id: "fixture/preview", previewUntil: until }
  for (const plan of ["vector-10", "vector-100"] as const) {
    service({ plan }, { models: [preview], qualify: everything })
    expect((await models()).body.models).toEqual([
      expect.objectContaining({
        id: "fixture/preview",
        locked: { plan: "vector-200", name: "Ultra", previewUntil: until },
      }),
    ])
  }
  service({ plan: "vector-200" }, { models: [preview], qualify: everything })
  const ultra = (await models()).body.models[0]
  expect(ultra).toMatchObject({ id: "fixture/preview", preview: { until } })
  expect(ultra.locked).toBeUndefined()
})

test("models-off hides a model and every variant routed to it; the codium switch off empties the catalog", async () => {
  service({ plan: "vector-200", modelsOff: [ARGON] }, { models: tiered(), qualify: everything })
  const { body } = await models()
  expect(ids(body).filter((id) => id.startsWith("google/"))).toEqual([])
  expect(ids(body)).toContain(KIMI)

  const off = service({ plan: "vector-200", switchOff: true }, { models: tiered(), qualify: everything })
  expect(await models()).toEqual({ status: 200, body: { enabled: false, models: [] } })
  // Off is decided before the snapshot is read.
  expect(off.commands.map((command) => command[1])).not.toContain(`vector:codium:test:ent:${user.id}`)
})

test("a paused plan keeps its catalog; a plan that ended lists Plus's set with no plan", async () => {
  service({ plan: "vector-100", state: "paused" }, { qualify: everything })
  const paused = (await models()).body
  expect(paused.plan).toBe("vector-100")
  expect(paused.models.filter((model: Entry) => model.locked)).toEqual([])
  service({ plan: "vector-100", state: "none" }, { qualify: everything })
  const none = (await models()).body
  expect(none.plan).toBeNull()
  expect(none.limits).toEqual({ inFlight: 3 })
  expect(find(none, KIMI)).toMatchObject({ locked: { plan: "vector-50" } })
})

test("no amount leaves the server: the only numbers are public catalog figures, caps and timestamps (P1)", async () => {
  const until = Date.now() + 86_400_000
  service(
    { plan: "vector-200" },
    { models: [...tiered(), { ...tiered()[0]!, id: "fixture/preview", previewUntil: until }], qualify: everything },
  )
  const { body } = await models()
  expect(JSON.stringify(body)).not.toMatch(/price|cost|credit|usd|cents|\$/i)
  const numbers: string[] = []
  const walk = (value: unknown, key: string) => {
    if (typeof value === "number") numbers.push(key)
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key))
    else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => walk(item, name))
  }
  walk(body, "")
  expect(new Set(numbers)).toEqual(new Set(["contextLength", "maxOutputTokens", "weight", "inFlight", "until"]))
})

test("while sales are off the catalog is empty and nothing is checked, signed in or not", async () => {
  process.env.MODEL_PLANS_ENABLED = "false"
  const store = service({ plan: "vector-10" })
  for (const token of [mintCliToken(user).token, ""])
    expect(await models(token)).toEqual({ status: 200, body: { enabled: false, models: [] } })
  expect(store.calls).toEqual([])
})

test("an incomplete server configuration answers that Codium is temporarily unavailable", async () => {
  service({ plan: "vector-10" })
  delete process.env.OPENROUTER_MANAGEMENT_KEY
  expect(await models()).toMatchObject({ status: 503, body: { error: { code: "MODEL_PLANS_CONFIGURATION" } } })
})

test("revoked, forged and missing account tokens are refused", async () => {
  service({ revoked: true })
  expect((await models()).status).toBe(401)
  service()
  expect((await models(`${mintCliToken(user).token}x`)).status).toBe(401)
  expect((await models("")).status).toBe(401)
})
