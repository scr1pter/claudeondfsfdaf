import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, Model, type ProviderMetadata } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { OpenAIChat } from "@vectordevai/llm/protocols/openai-chat"
import { OpenAICompatibleChat } from "@vectordevai/llm/protocols/openai-compatible-chat"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { tokens } from "@vectordevai/core/session/runner/publish-llm-event"

// Accounting-only fixtures: constructing these routes performs no provider request.
const usageTokens = { input: 1_000, output: 80, reasoning: 20, cache: { read: 0, write: 0 } }
const models = {
  priced: SessionRunnerModel.withPricing(
    Model.make({ id: "billed-fixture", provider: "openrouter", route: OpenAIChat.route }),
    [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }],
  ),
  unknown: Model.make({ id: "unknown-fixture", provider: "openrouter", route: OpenAIChat.route }),
  zero: SessionRunnerModel.withPricing(
    Model.make({ id: "zero-fixture", provider: "openrouter", route: OpenAIChat.route }),
    [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  ),
}

describe("V2 provider-reported billed cost", () => {
  for (const [name, model] of Object.entries(models)) {
    for (const cost of [0, 0.0123]) {
      test(`honors OpenRouter's explicit $${cost} charge over ${name} catalog pricing`, () => {
        const before = JSON.stringify(model)
        const metadata: ProviderMetadata = { openrouter: { usage: { cost } } }
        expect(SessionRunnerModel.calculateCost(model, usageTokens, metadata)).toBe(cost)
        const step = SessionRunnerModel.spendStep(
          model,
          { tokens: usageTokens, providerMetadata: metadata },
          { continues: false, patched: false },
        )
        expect(step.costUsd).toBe(cost)
        expect(step.costKind).toBe("priced")
        expect(JSON.stringify(model)).toBe(before)
      })
    }
  }

  for (const cost of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.0123", null]) {
    test(`invalid or missing billed cost ${String(cost)} falls back to catalog without inventing a free charge`, () => {
      const metadata = { openrouter: { usage: { cost } } } as ProviderMetadata
      expect(SessionRunnerModel.calculateCost(models.priced, usageTokens, metadata)).toBeCloseTo(0.003)
      expect(SessionRunnerModel.calculateCost(models.unknown, usageTokens, metadata)).toBeUndefined()
      expect(SessionRunnerModel.calculateCost(models.zero, usageTokens, metadata)).toBe(0)
      const native = { openai: { cost } }
      expect(SessionRunnerModel.calculateCost(models.priced, usageTokens, native)).toBeCloseTo(0.003)
      expect(SessionRunnerModel.calculateCost(models.unknown, usageTokens, native)).toBeUndefined()
      expect(SessionRunnerModel.calculateCost(models.zero, usageTokens, native)).toBe(0)
    })
  }

  for (const cost of [0, 0.0123]) {
    test(`native compatible wire preserves and bills trusted OpenRouter cost $${cost} only on its route`, async () => {
      let calls = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          calls++
          return new Response(
            [
              `data: ${JSON.stringify({ id: "wire-fixture", choices: [{ delta: { role: "assistant", content: "Done" }, finish_reason: null }] })}\n\n`,
              `data: ${JSON.stringify({ id: "wire-fixture", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost } })}\n\n`,
              "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        for (const provider of ["openrouter", "unrelated"]) {
          const model = SessionRunnerModel.withPricing(
            OpenAICompatibleChat.route
              .with({ provider, endpoint: { baseURL: `http://127.0.0.1:${server.port}/v1` } })
              .model({ id: "wire-fixture" }),
            [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }],
          )
          const request = LLM.request({
            model,
            prompt: "Bounded wire accounting fixture",
            generation: { maxTokens: 100 },
          })
          const before = JSON.stringify(request)
          const events = await Effect.runPromise(
            LLMClient.stream(request).pipe(
              Stream.runCollect,
              Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
            ),
          )
          const finish = events.find((event) => event.type === "step-finish")
          if (!finish || finish.type !== "step-finish") throw new Error("Wire fixture did not settle")
          expect(finish.usage?.providerMetadata?.openai?.cost).toBe(cost)
          const step = SessionRunnerModel.spendStep(
            model,
            { tokens: tokens(finish.usage), providerMetadata: finish.usage?.providerMetadata },
            { continues: false, patched: false },
          )
          expect(step.costUsd).toBe(provider === "openrouter" ? cost : 0.003)
          expect(step.costKind).toBe("priced")
          expect(JSON.stringify(request)).toBe(before)
        }
        expect(calls).toBe(2)
      } finally {
        await server.stop(true)
      }
    })
  }

  test("a custom OpenRouter destination accepts native cost while a lookalike or unrelated destination does not", () => {
    for (const url of [
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai.attacker.invalid/v1",
      "https://api.openai.com/v1",
    ]) {
      const model = SessionRunnerModel.withPricing(
        OpenAICompatibleChat.route
          .with({ provider: "custom", endpoint: { baseURL: url } })
          .model({ id: "route-fixture" }),
        [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }],
      )
      expect(SessionRunnerModel.calculateCost(model, usageTokens, { openai: { cost: 0.0123 } })).toBe(
        url === "https://openrouter.ai/api/v1" ? 0.0123 : 0.003,
      )
      expect(SessionRunnerModel.calculateCost(model, usageTokens, { openrouter: { usage: { cost: 0.0123 } } })).toBe(
        url === "https://openrouter.ai/api/v1" ? 0.0123 : 0.003,
      )
    }
  })
})
