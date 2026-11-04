import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Effect } from "effect"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { ResponseStall } from "@/provider/response-stall"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

const guard = NetworkGuard.use()
const CLOUD = ProviderV2.ID.make("cloud")
const MODEL = ModelV2.ID.make("qwen")

afterEach(disposeAllInstances)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("an explicitly configured cloud SSE deadline keeps its typed error when cleanup rejects", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const configured = yield* provider.getProvider(CLOUD)
        const cleanup = new Error("fake cloud cleanup rejected")
        const cancelled = Promise.withResolvers<unknown>()
        const requests: string[] = []
        const state: { signal?: AbortSignal | null } = {}
        configured.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(input instanceof Request ? input.url : String(input))
          state.signal = init?.signal
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: "cloud-stall", model: "qwen", choices: [{ index: 0, delta: { role: "assistant", content: "waiting" }, finish_reason: null }] })}\n\n`,
                  ),
                )
              },
              cancel(reason) {
                cancelled.resolve(reason)
                return Promise.reject(cleanup)
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        const model = yield* provider.getModel(CLOUD, MODEL)
        expect(yield* provider.line(model)).toBeUndefined()
        expect(ProviderError.ResponseStreamError).toBe(ResponseStall.ResponseStreamError)
        const language = yield* provider.getLanguage(model)
        const result = yield* Effect.promise(() =>
          language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "wait" }] }] }),
        )
        const primary = yield* Effect.promise(() =>
          result.stream
            .pipeTo(
              new WritableStream({
                write(part) {
                  if (part.type === "error") throw part.error
                },
              }),
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        )
        const deadline = ProviderError.unwrapTypedError(primary)
        expect(deadline).toBeInstanceOf(ProviderError.ResponseStreamError)
        expect(deadline).toMatchObject({ name: "ProviderResponseStreamError", message: "SSE read timed out" })
        expect(deadline).not.toBe(cleanup)
        expect(state.signal?.reason).toBe(deadline)
        expect(yield* Effect.promise(() => cancelled.promise)).toBe(deadline)
        expect(requests).toEqual(["https://api.cloud.invalid/v1/chat/completions"])
        expect(guard.outside()).toEqual([])
      }),
    {
      trusted: true,
      config: {
        formatter: false,
        lsp: false,
        provider: {
          cloud: {
            npm: "@ai-sdk/openai-compatible",
            models: { qwen: { id: "qwen", name: "qwen", tool_call: true, limit: { context: 4096, output: 1024 } } },
            options: {
              apiKey: "synthetic",
              baseURL: "https://api.cloud.invalid/v1",
              headerTimeout: 1000,
              chunkTimeout: 20,
            },
          },
        },
      },
    },
  ),
)
