import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { paidModelPlan, protectModelPlanKey, revealModelPlanKey } from "../../../api/_lib/model-plan-account"
import {
  modelPlans,
  modelCreditMarkup,
  publicModelPlans,
  configuredPlanModels,
  modelPlanRequestCredits,
  requireModelPlans,
} from "../../../api/_lib/model-plan-config"
import { modelPlanRequest, requireModelPlanContext, streamModelPlanResponse } from "../../../api/_lib/model-plan-chat"
import { verifyModelPlanWebhook } from "../../../api/_lib/model-plan-stripe"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { Socket, type AddressInfo } from "node:net"
import config from "../../../api/model-plans/config"
import { readModelPlanConfig } from "../src/lib/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

const names = [
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  ...[10, 50, 100, 200].flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const saved = new Map(names.map((name) => [name, process.env[name]]))
afterEach(() =>
  names.forEach((name) => {
    const value = saved.get(name)
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }),
)

const now = Date.UTC(2026, 9, 9)
const start = Math.floor(now / 1000) - 86400
const end = start + 30 * 86400
const model = {
  id: "fixture/coder",
  name: "Fixture Coder",
  contextLength: 32000,
  maxOutputTokens: 8192,
  inputPrice: 0.1,
  outputPrice: 0.3,
}
function subscription() {
  process.env.STRIPE_MODEL_PLAN_10_PRICE_ID = "price_fixture10"
  process.env.MODEL_PLAN_10_CREDITS_USD = "7"
  return {
    id: "sub_fixture",
    status: "active",
    metadata: { vector_account_id: "account-one" },
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_fixture10",
            currency: "usd",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      paid: true,
      status: "paid",
      amount_paid: 1000,
      charge: { paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: "price_fixture10" }, period: { start, end }, proration: false }] },
    },
  }
}

describe("subscription configuration", () => {
  test("Codium stays unavailable without private allowance configuration", () => {
    names.forEach((name) => {
      delete process.env[name]
    })
    expect(modelPlans().map((plan) => plan.price)).toEqual([10, 50, 100, 200])
    expect(modelPlans().map((plan) => plan.credits)).toEqual([0, 0, 0, 0])
    expect(publicModelPlans().plans.every((plan) => !plan.available)).toBe(true)
    // Codium sells monthly plans only: the public configuration offers no top-ups.
    expect(publicModelPlans()).not.toHaveProperty("topups")
    expect(publicModelPlans().product).toBe("Vector Codium")
    expect(publicModelPlans()).not.toHaveProperty("markupPercent")
    expect(publicModelPlans().models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4.1-flash-1017",
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-luna",
      "moonshotai/kimi-k3.1-pro",
      "google/gemini-4-argon",
    ])
    expect(publicModelPlans().catalogUpdated).toBe("2026-10-23")
    expect(() => requireModelPlans()).toThrow("not available yet")
  })
  test("the public configuration carries no credit amounts, model prices or limits", () => {
    names.forEach((name) => delete process.env[name])
    const config = publicModelPlans()
    for (const offer of config.plans)
      expect(
        Object.keys(offer).every((key) => ["id", "name", "price", "available", "multiple", "tasks"].includes(key)),
      ).toBe(true)
    for (const model of config.models)
      expect(Object.keys(model).every((key) => ["id", "name", "category", "description"].includes(key))).toBe(true)
    const text = JSON.stringify(config)
    for (const key of [
      "credits",
      "inputPrice",
      "outputPrice",
      "contextLength",
      "maxOutputTokens",
      "markupPercent",
      "cached",
    ])
      expect(text).not.toContain(`"${key}":`)
  })
  test("coarse usage ranges are independent of private allowances and prices", () => {
    names.forEach((name) => delete process.env[name])
    const original = publicModelPlans()
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "100"
    process.env.MODEL_PLAN_10_CREDITS_USD = "0.5"
    process.env.MODEL_PLAN_100_CREDITS_USD = "70"
    expect(publicModelPlans().plans.map((plan) => plan.tasks)).toEqual(original.plans.map((plan) => plan.tasks))
    expect(original.plans.map((plan) => plan.multiple)).toEqual([undefined, 5, 10, 20])
    expect(original.plans[0]!.tasks).toEqual([
      [50, 500],
      [30, 300],
      [60, 600],
      [5, 50],
      [5, 50],
    ])
  })
  test("captured premium models reserve their native window and reply at every captured rate tier", () => {
    delete process.env.MODEL_PLAN_MODELS_JSON
    for (const id of ["moonshotai/kimi-k3.1-pro", "google/gemini-4-argon"]) {
      const model = configuredPlanModels().find((model) => model.id === id)!
      expect(modelPlanRequestCredits(model, "vector-50")).toBe(2.179072)
      expect(modelPlanRequestCredits(model, "vector-100")).toBe(4.358144)
      expect(model.description).toContain("Uses credits faster")
    }
  })
  test("markup is configurable and never rounds credits above the purchased allowance", () => {
    names.forEach((name) => delete process.env[name])
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "30"
    expect(modelCreditMarkup()).toBe(30)
    expect(modelPlans()[0].credits).toBe(7.69)
    expect(modelPlans()[3].credits).toBe(153.84)
    process.env.MODEL_PLAN_10_CREDITS_USD = "7"
    expect(modelPlans()[0].credits).toBe(7)
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "NaN"
    expect(() => modelPlans()).toThrow()
  })
  test("invalid or unprofitable credit configurations fail closed", () => {
    process.env.MODEL_PLAN_10_CREDITS_USD = "11"
    expect(modelPlans()[0].credits).toBe(0)
    process.env.MODEL_PLAN_10_CREDITS_USD = "NaN"
    expect(modelPlans()[0].credits).toBe(0)
    process.env.MODEL_PLANS_ENABLED = "true"
    expect(publicModelPlans().enabled).toBe(false)
  })
  test("allowances require whole cents without rejecting valid floating-point representations", () => {
    process.env.MODEL_PLAN_10_CREDITS_USD = "7.125"
    expect(modelPlans()[0].credits).toBe(0)
    process.env.MODEL_PLAN_200_CREDITS_USD = "133.33"
    expect(modelPlans()[3].credits).toBe(133.33)
  })
  test("configured paid models require bounded positive pricing and valid context", () => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([model])
    expect(configuredPlanModels()).toEqual([{ ...model, minPlan: "vector-10", weight: (0.1 + 0.3) / 1.5 }])
    for (const invalid of [
      { ...model, inputPrice: 0 },
      { ...model, id: "fixture/coder:free" },
      { ...model, maxOutputTokens: 99999 },
    ]) {
      process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([invalid])
      expect(() => configuredPlanModels()).toThrow()
    }
  })
})

describe("the public configuration route", () => {
  test("carries the perks every surface may list, none before A27, and every in-repo decoder still reads it", async () => {
    names.forEach((name) => delete process.env[name])
    const server = createServer((request, response) => void config(request, response))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/model-plans/config`
    const send = (_url: string, init: RequestInit) => fetch(url, init)
    const body = await (await fetch(url)).json()
    expect(body).toEqual({ ...publicModelPlans(), listed: [] })
    expect(readModelPlanConfig(body)).toMatchObject({ enabled: false, plans: expect.any(Array) })
    expect(await ModelPlanStatus.fetchOffers(send)).toMatchObject({ enabled: false })
    expect(await ModelPlanStatus.salesOpen(send)).toBe(false)
    server.close()
  })
})

describe("paid entitlement", () => {
  test("an active account needs a matching paid period and exact configured price", () => {
    const valid = subscription()
    expect(paidModelPlan(valid, "account-one", now)?.plan.credits).toBe(7)
    expect(paidModelPlan(valid, "account-two", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, status: "past_due" }, "account-one", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, status: "trialing" }, "account-one", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, current_period_end: Math.floor(now / 1000) }, "account-one", now)).toBeUndefined()
    valid.items.data[0].price.unit_amount = 100
    expect(paidModelPlan(valid, "account-one", now)).toBeUndefined()
  })
  test("unpaid, refunded, disputed, and old invoices cannot grant fresh credits", () => {
    const value = subscription()
    value.latest_invoice.paid = false
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.paid = true
    value.latest_invoice.charge.refunded = true
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.charge.refunded = false
    value.latest_invoice.charge.disputed = true
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.charge.disputed = false
    value.latest_invoice.lines.data[0].period.end -= 86400
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
  })
  test("cancellation at period end preserves the paid remainder", () => {
    const value = subscription()
    value.cancel_at_period_end = true
    expect(paidModelPlan(value, "account-one", now)?.cancelAtPeriodEnd).toBe(true)
    expect(paidModelPlan(value, "account-one", end * 1000)).toBeUndefined()
  })
})

describe("gateway request policy", () => {
  test("reviewed model routing pins precision, effort and options, and marks Haiku's cache breakpoints", () => {
    const models = configuredPlanModels()
    for (const model of models) {
      const body = modelPlanRequest(
        {
          model: model.id,
          messages: [
            { role: "system", content: "Stable instructions" },
            { role: "system", content: "Per-session context" },
            { role: "user", content: "Fix it" },
            {
              role: "assistant",
              content: null,
              // How both Vector runtimes send earlier reasoning back.
              reasoning_content: "Read the file before editing it.",
              reasoning_details: [
                { type: "reasoning.text", text: "Read the file before editing it.", signature: "sig" },
              ],
              tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
            },
            {
              role: "tool",
              tool_call_id: "call",
              content: [{ type: "text", text: "source", cache_control: { type: "ephemeral", ttl: "1h" } }],
            },
          ],
          tools: [
            {
              type: "function",
              cache_control: { type: "ephemeral", ttl: "1h" },
              function: { name: "read", description: "Read a file", parameters: { type: "object" }, extra: true },
            },
          ],
          tool_choice: "required",
          temperature: 0.2,
          parallel_tool_calls: true,
          reasoning: { effort: "max" },
          provider: { quantizations: ["fp4"] },
        },
        models,
      )
      // No reviewed endpoint takes it, and with require_parameters it would leave none to route to.
      expect(body).not.toHaveProperty("parallel_tool_calls")
      // Thinking models need their earlier reasoning on a tool-call turn; OpenRouter reads it as reasoning.
      expect(body.messages[3]).toMatchObject({
        role: "assistant",
        reasoning: "Read the file before editing it.",
        reasoning_details: [{ type: "reasoning.text", text: "Read the file before editing it.", signature: "sig" }],
      })
      expect(body.messages[3]).not.toHaveProperty("reasoning_content")
      // A tool keeps only its definition.
      expect(body.tools).toEqual([
        { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
      ])
      if (model.id.startsWith("anthropic/")) {
        expect(body.tool_choice).toBe("auto")
        expect(body.reasoning).toEqual({ effort: "high" })
        // Its endpoints refuse sampling options.
        expect(body).not.toHaveProperty("temperature")
        // Vector's stable system block, the whole system prompt, the latest user message and the conversation's end,
        // never a client's own marker.
        expect(
          body.messages.map((message) =>
            Array.isArray(message.content) ? message.content.map((part) => part.cache_control) : undefined,
          ),
        ).toEqual([
          [{ type: "ephemeral" }],
          [{ type: "ephemeral" }],
          [{ type: "ephemeral" }],
          undefined,
          [{ type: "ephemeral" }],
        ])
        expect(JSON.stringify(body)).not.toContain("1h")
        // Naming one tool forces it as surely as required does.
        expect(
          modelPlanRequest(
            {
              model: model.id,
              messages: [{ role: "user", content: "Fix it" }],
              tool_choice: { type: "function", function: { name: "read" } },
            },
            models,
          ).tool_choice,
        ).toBe("auto")
        // Each of these characters can be up to three tokens, so they count by their UTF-8 bytes.
        expect(() =>
          requireModelPlanContext({ ...body, messages: [{ role: "user", content: "界".repeat(34_000) }] }, model),
        ).toThrow()
        expect(() => requireModelPlanContext(body, model)).not.toThrow()
        continue
      }
      expect(body.provider).toMatchObject({ zdr: true, data_collection: "deny", require_parameters: true })
      expect(body.provider.quantizations).toEqual(model.quantizations)
      expect(body.tool_choice).toBe("required")
      expect(body.reasoning).toEqual({ effort: "high" })
      if (model.id === "deepseek/deepseek-v4.1-flash-1017" || model.id === "google/gemini-4-argon")
        expect(body).toHaveProperty("temperature", 0.2)
      else expect(body).not.toHaveProperty("temperature")
      if (model.id === "openai/gpt-6-luna") {
        expect(body).not.toHaveProperty("max_tokens")
        expect(body).toHaveProperty("max_completion_tokens", 8192)
        expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" })
        expect(JSON.stringify(body.messages)).toContain('"prompt_cache_breakpoint":{"mode":"explicit"}')
        expect(JSON.stringify(body.messages)).not.toContain("cache_control")
        expect(() => requireModelPlanContext(body, model)).not.toThrow()
      }
      if (model.id === "google/gemini-4-argon") {
        expect(JSON.stringify(body.messages)).toContain('"cache_control":{"type":"ephemeral"}')
        expect(body).not.toHaveProperty("prompt_cache_options")
      }
      if (!model.explicitCache) expect(JSON.stringify(body)).not.toContain("cache_control")
    }
  })

  test("refuses earlier reasoning that is not text or a list of reasoning blocks", () => {
    const assistant = { role: "assistant", content: "Done" }
    for (const extra of [
      { reasoning_content: 7 },
      { reasoning: { text: "x" } },
      { reasoning_details: "x" },
      { reasoning_details: [1] },
    ])
      expect(() =>
        modelPlanRequest(
          {
            model: model.id,
            messages: [
              { role: "user", content: "fix" },
              { ...assistant, ...extra },
            ],
          },
          [model],
        ),
      ).toThrow(expect.objectContaining({ code: "MODEL_PLAN_MESSAGE" }))
    // Only an assistant's own turn carries reasoning.
    expect(
      modelPlanRequest(
        {
          model: model.id,
          messages: [{ role: "user", content: "fix", reasoning: "injected", reasoning_details: [{ type: "x" }] }],
        },
        [model],
      ).messages,
    ).toEqual([{ role: "user", content: "fix" }])
  })

  test("the configured output parameter caps every model and client cache settings cannot override policy", () => {
    const models = configuredPlanModels()
    for (const model of models) {
      const body = modelPlanRequest(
        {
          model: model.id,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Fix the parser",
                  prompt_cache_breakpoint: { ttl: "12h" },
                  cache_control: { ttl: "1h" },
                },
              ],
            },
          ],
          max_tokens: 1_000_000,
          max_completion_tokens: 1_000_000,
          prompt_cache_options: { mode: "automatic", ttl: "12h" },
          tool_choice: { type: "function", function: { name: "read" } },
        },
        models,
      )
      expect(body).toHaveProperty(model.outputTokenParameter ?? "max_tokens", model.maxOutputTokens)
      expect(JSON.stringify(body)).not.toMatch(/12h|1h|automatic/)
      if (model.autoToolChoice) expect(body.tool_choice).toBe("auto")
      if (model.id === "openai/gpt-6-luna") {
        expect(() =>
          requireModelPlanContext({ ...body, messages: [{ role: "user", content: "x".repeat(600_000) }] }, model),
        ).toThrow(expect.objectContaining({ code: "MODEL_PLAN_CONTEXT" }))
      }
    }
  })

  test("preserves bounded retry timing without exposing upstream billing errors", async () => {
    for (const status of [402, 429]) {
      const response = new ServerResponse(new IncomingMessage(new Socket()))
      await expect(
        streamModelPlanResponse(
          Response.json(
            { error: { message: "private billing details" } },
            { status, headers: { "retry-after": "999" } },
          ),
          response,
        ),
      ).rejects.toMatchObject({ statusCode: status })
      expect(response.getHeader("retry-after")).toBe("300")
    }
  })
  test("a client that stops reading cannot hold the stream past the request's deadline", async () => {
    // An unattached response never drains, as a connection whose client stopped reading but stayed open.
    const response = new ServerResponse(new IncomingMessage(new Socket()))
    const frame = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "fixture" } }] })}\n\n`,
    )
    const upstream = new Response(new ReadableStream({ pull: (controller) => controller.enqueue(frame) }), {
      headers: { "content-type": "text/event-stream" },
    })
    const streamed = streamModelPlanResponse(upstream, response, undefined, AbortSignal.timeout(50)).then(
      () => "returned",
      () => "ended",
    )
    expect(await Promise.race([streamed, Bun.sleep(5_000).then(() => "stalled")])).toBe("ended")
  })
  test("preserves coding tools but pins model, pricing, privacy, and generation budget", () => {
    const result = modelPlanRequest(
      {
        model: model.id,
        messages: [{ role: "user", content: "fix it", arbitrary: "ignored" }],
        max_tokens: 99999,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        provider: { max_price: { completion: 9999 }, zdr: false },
        apiKey: "do-not-forward",
      },
      [model],
    )
    expect(result).toHaveProperty("max_tokens", 8192)
    expect(result.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.1, completion: 0.3, request: 0 },
    })
    expect(result.messages).toEqual([{ role: "user", content: "fix it" }])
    expect(result).not.toHaveProperty("apiKey")
    expect(result.plugins.every((plugin) => plugin.enabled === false)).toBe(true)
  })
  test("rejects paid add-ons, model fallback injection and remote media", () => {
    const body = { model: model.id, messages: [{ role: "user", content: "fix" }] }
    expect(() => modelPlanRequest({ ...body, model: "unlisted/expensive" }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, models: ["unlisted/expensive"] }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, plugins: [{ id: "web" }] }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, max_tokens: -1 }, [model])).toThrow()
    expect(() =>
      modelPlanRequest(
        {
          ...body,
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://private.example" } }] }],
        },
        [model],
      ),
    ).toThrow()
  })
})

describe("secrets and billing notifications", () => {
  test("OpenRouter credentials are encrypted and bound to their account and billing period", () => {
    process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET = "ab".repeat(32)
    const value = protectModelPlanKey("fixture-openrouter-secret", "user:sub:period")
    expect(value).not.toContain("fixture-openrouter-secret")
    expect(revealModelPlanKey(value, "user:sub:period")).toBe("fixture-openrouter-secret")
    expect(() => revealModelPlanKey(value, "other:sub:period")).toThrow()
    expect(() => revealModelPlanKey(value.slice(0, -5), "user:sub:period")).toThrow()
  })
  test("verifies raw-body Stripe signatures and rejects tampering and stale deliveries", () => {
    process.env.STRIPE_MODEL_PLAN_WEBHOOK_SECRET = "whsec_fixture"
    const raw = Buffer.from(JSON.stringify({ id: "evt_fixture", type: "invoice.paid", data: { object: {} } }))
    const timestamp = Math.floor(now / 1000)
    const digest = createHmac("sha256", "whsec_fixture").update(`${timestamp}.`).update(raw).digest("hex")
    const header = `t=${timestamp},v1=${"00".repeat(32)},v1=${digest}`
    expect(verifyModelPlanWebhook(raw, header, now).type).toBe("invoice.paid")
    expect(() => verifyModelPlanWebhook(Buffer.from("{}"), header, now)).toThrow()
    expect(() => verifyModelPlanWebhook(raw, header, now + 301000)).toThrow()
    expect(() => verifyModelPlanWebhook(raw, `t=${timestamp},v1=bad`, now)).toThrow()
  })
})
