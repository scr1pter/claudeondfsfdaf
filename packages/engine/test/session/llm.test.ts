import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import path from "path"
import { streamText, tool, type ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { Provider } from "@/provider/provider"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { ProviderTransform } from "@/provider/transform"
import { ModelCatalog } from "@vectordevai/core/model-catalog"

import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { Session as SessionNs } from "@/session/session"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const openAIConfig = (model: ModelCatalog.Provider["models"][string], baseURL: string): Partial<ConfigV1.Info> => {
  const { experimental: _experimental, ...configModel } = model
  return {
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          [model.id]: JSON.parse(JSON.stringify(configModel)) as ConfigModel,
        },
        options: {
          apiKey: "test-openai-key",
          baseURL,
        },
      },
    },
  }
}

const LINED_ORIGIN = "https://lined-openai.test"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))
const itReasoningContext = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalReasoningContext: "all_turns" })],
  ]),
)

// LLM.stream returns a Stream, not an Effect, so we can't use the serviceUse proxy.
const drain = (input: LLM.StreamInput) => LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))

// drainWith builds an isolated runtime so custom replacements fully own LLM and
// its transitive deps.
const drainWith = (layer: Layer.Layer<LLM.Service>, input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

function llmLayerWithExecutor(
  options: {
    executor?: Layer.Layer<RequestExecutor.Service>
    flags?: Partial<RuntimeFlags.Info>
    /** The model servers' lines, for a test that reads them. */
    slots?: ModelSlots.Interface
  } = {},
) {
  return AppNodeBuilder.build(LLM.node, [
    [RuntimeFlags.node, RuntimeFlags.layer(options.flags)],
    ...(options.executor ? ([[LayerNodePlatform.requestExecutor, options.executor]] as const) : []),
    ...(options.slots ? ([[ModelSlots.node, Layer.succeed(ModelSlots.Service, options.slots)]] as const) : []),
  ])
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

  const adapt = (events: ReadonlyArray<AISDKAdapterEvent>) => {
    const state = LLMAISDK.adapterState()
    return Effect.runPromise(
      Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
    )
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests defensive adapter branches outside AI SDK's current typed surface
  const uncheckedAdapterEvent = (input: unknown) => input as AISDKAdapterEvent

  test.each([false, true])(
    "fails HTTP 200 SSE provider errors with sequence_number=%s without a false finish",
    async (sequence) => {
      const failure = {
        type: "error",
        ...(sequence ? { sequence_number: 1 } : {}),
        error: {
          type: "invalid_request_error",
          code: "unsupported_value",
          message: "Unsupported reasoning effort",
          param: "reasoning.effort",
        },
      }
      let requests = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          requests++
          return new Response(`event: error\ndata: ${JSON.stringify(failure)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      try {
        const sdk = createOpenAI({ apiKey: "test-key", baseURL: `${server.url.origin}/v1` })
        const stream = streamText({
          model: sdk.responses("gpt-6.1-sol"),
          prompt: "Generate a title",
          includeRawChunks: true,
          maxRetries: 0,
        })
        const parts: AISDKAdapterEvent[] = []
        for await (const part of stream.fullStream) parts.push(part)
        // Exercise the real SDK's permissive unknown-chunk fallback, as well as its normal error shape.
        expect(parts.filter((part) => part.type === "error")).toHaveLength(sequence ? 1 : 0)
        expect(parts.some((part) => part.type === "finish")).toBe(true)
        const state = LLMAISDK.adapterState()
        const visible: string[] = []
        const result = await Effect.runPromise(
          Stream.fromIterable(parts).pipe(
            Stream.mapEffect((part) => LLMAISDK.toLLMEvents(state, part)),
            Stream.flatMap((events) => Stream.fromIterable(events)),
            Stream.tap((event) =>
              Effect.sync(() => {
                visible.push(event.type)
              }),
            ),
            Stream.runDrain,
            Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ error: undefined }) }),
          ),
        )
        expect(result.error).toEqual(failure)
        expect(visible).toEqual(["step-start"])
        expect(requests).toBe(1)
      } finally {
        await server.stop(true)
      }
    },
  )

  test.each(["response.completed", "response.incomplete", "response.done"])(
    "retains OpenAI cache writes from raw %s without adding duplicate terminal usage",
    async (type) => {
      const raw = {
        type: "raw",
        rawValue: { type, response: { usage: { input_tokens_details: { cache_write_tokens: 3000 } } } },
      }
      const events = await adapt([
        uncheckedAdapterEvent(raw),
        uncheckedAdapterEvent(raw),
        uncheckedAdapterEvent({
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 12000, outputTokens: 200 },
        }),
        uncheckedAdapterEvent({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 12000, outputTokens: 200 },
        }),
      ])
      expect(events.map((event) => "usage" in event && event.usage?.cacheWriteInputTokens)).toEqual([3000, 3000])
    },
  )

  test.each([undefined, null, -1, 1.5, "3", Infinity, NaN, 0])(
    "preserves absent or invalid OpenAI cache-write counts as unknown and reported zero as zero: %p",
    async (value) => {
      const events = await adapt([
        uncheckedAdapterEvent({
          type: "raw",
          rawValue: {
            type: "response.completed",
            response: { usage: { input_tokens_details: { cache_write_tokens: value } } },
          },
        }),
        uncheckedAdapterEvent({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 12 } }),
        uncheckedAdapterEvent({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 12 } }),
      ])
      expect(events.map((event) => "usage" in event && event.usage?.cacheWriteInputTokens)).toEqual(
        value === 0 ? [0, 0] : [undefined, undefined],
      )
    },
  )

  test("uses SDK cache-write counts when present and resets raw usage across steps and streams", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "response.completed",
          response: { usage: { input_tokens_details: { cache_write_tokens: 3 } } },
        },
      }),
      uncheckedAdapterEvent({
        type: "finish-step",
        finishReason: "tool-calls",
        usage: { inputTokens: 12, inputTokenDetails: { cacheWriteTokens: 4 } },
      }),
      uncheckedAdapterEvent({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 12 } }),
      uncheckedAdapterEvent({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 24, inputTokenDetails: { cacheWriteTokens: 4 } },
      }),
      uncheckedAdapterEvent({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 12 } }),
      uncheckedAdapterEvent({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 12 } }),
    ])
    expect(events.map((event) => "usage" in event && event.usage?.cacheWriteInputTokens)).toEqual([
      4,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test("aggregates reported cache writes once per step for the stream total", async () => {
    const events = await adapt([
      ...[3, 0, 7].flatMap((count) => [
        uncheckedAdapterEvent({
          type: "raw",
          rawValue: {
            type: "response.completed",
            response: { usage: { input_tokens_details: { cache_write_tokens: count } } },
          },
        }),
        uncheckedAdapterEvent({ type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 12 } }),
      ]),
      uncheckedAdapterEvent({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 36 } }),
    ])
    expect(events.map((event) => "usage" in event && event.usage?.cacheWriteInputTokens)).toEqual([3, 0, 7, 10])
  })

  test("includes raw-only steps when the SDK total contains a partial cache-write sum", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "finish-step",
        finishReason: "tool-calls",
        usage: { inputTokens: 12, inputTokenDetails: { cacheWriteTokens: 4 } },
      }),
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "response.completed",
          response: { usage: { input_tokens_details: { cache_write_tokens: 3 } } },
        },
      }),
      uncheckedAdapterEvent({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 12 } }),
      uncheckedAdapterEvent({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 24, inputTokenDetails: { cacheWriteTokens: 4 } },
      }),
    ])
    expect(events.map((event) => "usage" in event && event.usage?.cacheWriteInputTokens)).toEqual([4, 3, 7])
  })

  test("maps AI SDK stream chunks without losing session-visible fields", async () => {
    const metadata = { openai: { itemID: "item-1" } }
    const events = await adapt([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", toolName: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", delta: '{"query":' },
      { type: "tool-input-delta", id: "call-1", delta: '"weather"}' },
      { type: "tool-input-end", id: "call-1", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        output: { title: "Lookup", output: "sunny", metadata: { ok: true } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "other",
        rawFinishReason: "other",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 1 },
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        finishReason: "other",
        rawFinishReason: "other",
        totalUsage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 2 },
        },
      },
    ])

    expect(events).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", name: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '{"query":' },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '"weather"}' },
      { type: "tool-input-end", id: "call-1", name: "lookup", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "lookup",
        result: { type: "json", value: { title: "Lookup", output: "sunny", metadata: { ok: true } } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "step-finish",
        index: 0,
        reason: "unknown",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: 1,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        reason: "unknown",
        usage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          reasoningTokens: 2,
          cacheReadInputTokens: 4,
        },
      },
    ])
  })

  test("creates stable block ids when AI SDK omits them", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({ type: "text-delta", text: "implicit text" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "implicit reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(events).toMatchObject([
      { type: "text-delta", id: "text-0", text: "implicit text" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "implicit reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  test("explicitly ignores non-session-visible AI SDK chunks", async () => {
    expect(
      await adapt([
        uncheckedAdapterEvent({ type: "abort" }),
        uncheckedAdapterEvent({ type: "source" }),
        uncheckedAdapterEvent({ type: "file" }),
        uncheckedAdapterEvent({ type: "raw" }),
        uncheckedAdapterEvent({ type: "tool-output-denied" }),
        uncheckedAdapterEvent({ type: "tool-approval-request" }),
      ]),
    ).toEqual([])
  })

  test("preserves tool-error cause", async () => {
    const error = new PermissionV1.RejectedError()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "tool-error",
        toolCallId: "call_123",
        toolName: "bash",
        input: {},
        error,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-error",
      id: "call_123",
      name: "bash",
      message: error.message,
      error,
    })
  })

  test("emits undefined usage when every AI SDK usage field is missing", async () => {
    // If every numeric field is undefined the translator should signal "no usage info"
    // by emitting undefined, not by polluting the event with usage: {}. Downstream cost
    // telemetry distinguishes "missing" from "zero," so emitting an empty object causes
    // false positives ("usage was tracked, just empty") instead of correct nulls.
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.usage).toBeUndefined()
  })

  test("reuses adapter state cleanly across streams once finish has fired", async () => {
    // adapterState() is meant to be per-stream, but the only thing finish currently clears
    // is toolNames — step, text counters, and the current text/reasoning IDs all leak
    // forward. A caller that reuses a state across two streams sees text-1/reasoning-1/
    // step index 1 on the second stream's first events. The test pins the intended
    // contract: after finish, the same state can be reused and starts fresh.
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<AISDKAdapterEvent>) =>
      Effect.runPromise(
        Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
      )

    await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "first" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "first reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
      {
        type: "finish-step",
        response: { id: "r1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    const secondStream = await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "second" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "second reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(secondStream).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-delta", id: "text-0", text: "second" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "second reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  // Anthropic emits cache write counts in providerMetadata.anthropic.cacheCreationInputTokens
  // rather than usage.inputTokenDetails.cacheWriteTokens. Session.getUsage falls back to the
  // metadata path — but only if the adapter preserves providerMetadata on step-finish.
  test("preserves providerMetadata on step-finish so Anthropic cache writes survive getUsage", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-3-5-sonnet" },
        finishReason: "stop",
        rawFinishReason: "stop",
        // Anthropic's AI SDK shape: cacheWriteTokens is NOT in usage, it arrives via providerMetadata.
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.providerMetadata).toEqual({ anthropic: { cacheCreationInputTokens: 300 } })
    expect(stepFinish.usage?.cacheWriteInputTokens).toBeUndefined()
    expect(stepFinish.usage?.cacheReadInputTokens).toBe(200)

    // End-to-end: with the metadata preserved, getUsage extracts cache.write from the fallback path.
    const result = SessionNs.getUsage({
      model: {
        id: "claude-3-5-sonnet",
        providerID: "anthropic",
        name: "Claude",
        limit: { context: 200_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { npm: "@ai-sdk/anthropic" },
        options: {},
      } as never,
      usage: stepFinish.usage!,
      metadata: stepFinish.providerMetadata,
    })
    expect(result.tokens.cache.write).toBe(300)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("captures Copilot billed usage from raw Anthropic message deltas per step", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "message_delta",
          copilot_usage: { total_nano_aiu: 4_473_525_000 },
        },
      }),
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 11_774,
          outputTokens: 39,
          totalTokens: 11_813,
          inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 11_771 },
          outputTokenDetails: { textTokens: 39, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 11_771 } },
      },
      {
        type: "finish-step",
        response: { id: "msg_follow_up", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: {} },
      },
    ])

    expect(events[0]).toMatchObject({
      type: "step-finish",
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 11_771 },
        copilot: { totalNanoAiu: 4_473_525_000 },
      },
    })
    expect(events[1]).toMatchObject({ type: "step-finish", providerMetadata: { anthropic: {} } })
    if (events[1].type !== "step-finish") throw new Error("expected step-finish")
    expect(events[1].providerMetadata?.copilot).toBeUndefined()
  })

  test("reads the input usage Anthropic reports as it starts a response", () => {
    expect(
      LLMAISDK.startedUsage({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 5_000,
            cache_creation_input_tokens: 175_000,
            cache_read_input_tokens: 20_000,
            output_tokens: 1,
          },
        },
      }),
    ).toEqual({
      inputTokens: 200_000,
      outputTokens: 1,
      cacheReadInputTokens: 20_000,
      cacheWriteInputTokens: 175_000,
      totalTokens: 200_001,
    })
    expect(LLMAISDK.startedUsage({ type: "content_block_delta", delta: { text: "hi" } })).toBeUndefined()
    expect(LLMAISDK.startedUsage(undefined)).toBeUndefined()
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response | Promise<Response>)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string, beforeHeaders = false) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    async response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })
      if (beforeHeaders) {
        await requestAborted.promise
        responseCanceled.resolve()
        return new Response(null, { status: 499 })
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelCatalog.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

function configModel(model: ModelCatalog.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  for (const enabled of [false, true]) {
    it.instance(
      `keeps the internal cache marker off the real SDK wire with breakpoint opt-in ${enabled}`,
      () =>
        Effect.gen(function* () {
          const request = waitRequest(
            "/responses",
            createEventResponse([
              {
                type: "response.created",
                response: { id: "resp-breakpoint", created_at: 1, model: "gpt-6.1-sol", service_tier: null },
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  service_tier: null,
                  usage: {
                    input_tokens: 1200,
                    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 },
                    output_tokens: 1,
                  },
                },
              },
            ]),
          )
          const providers = yield* Provider.Service
          const resolved = yield* providers.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6.1-sol"))
          const sessionID = SessionID.make(`ses_breakpoint_${enabled}`)
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [],
            prompt: "Stable provider policy.",
          } satisfies Agent.Info
          yield* drain({
            user: {
              id: MessageID.make(`msg_breakpoint_${enabled}`),
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.openai, modelID: resolved.id },
            },
            sessionID,
            model: resolved,
            agent,
            stableSystem: ["Stable tool policy."],
            system: ["Per-session context."],
            messages: [{ role: "user", content: "Question" }],
            tools: {},
          })
          const capture = yield* Effect.promise(() => request)
          expect(capture.headers.has(ProviderTransform.PROMPT_CACHE_PREFIX_HEADER)).toBe(false)
          expect(capture.headers.get("x-test-preserve")).toBe("yes")
          const messages = capture.body.input as {
            role: string
            content: string | { type: string; text: string; prompt_cache_breakpoint?: { mode: string; ttl: string } }[]
          }[]
          const expected = "Stable provider policy.\nStable tool policy.\nPer-session context."
          const first = messages[0]!
          expect(
            typeof first.content === "string" ? first.content : first.content.map((part) => part.text).join(""),
          ).toBe(expected)
          expect(messages[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "Question" }] })
          expect(capture.body.prompt_cache_key).toBe(sessionID)
          if (enabled) {
            expect(first.content).toEqual([
              {
                type: "input_text",
                text: "Stable provider policy.\nStable tool policy.",
                prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" },
              },
              { type: "input_text", text: "\nPer-session context." },
            ])
            expect(capture.body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" })
          } else expect(capture.body.prompt_cache_options).toBeUndefined()
        }),
      {
        trusted: true,
        config: () => {
          const config = openAIConfig(
            { ...loadFixture("openai", "gpt-5.2").model, id: "gpt-6.1-sol" },
            `http://127.0.0.1:${state.server!.port}/v1`,
          )
          config.provider!.openai!.options = {
            ...config.provider!.openai!.options,
            promptCacheBreakpoints: enabled,
            headers: { [ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]: "forged", "x-test-preserve": "yes" },
          }
          return config
        },
      },
    )
  }
  for (const verbosity of [undefined, "high"] as const) {
    it.instance(
      `preserves and prices OpenAI cache writes through the real SDK with verbosity ${verbosity ?? "default"}`,
      () =>
        Effect.gen(function* () {
          const request = waitRequest(
            "/responses",
            createEventResponse([
              {
                type: "response.created",
                response: { id: "resp-cache-write", created_at: 1, model: "gpt-6.1-sol", service_tier: null },
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  service_tier: null,
                  usage: {
                    input_tokens: 12000,
                    input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 3000 },
                    output_tokens: 200,
                    output_tokens_details: { reasoning_tokens: 50 },
                  },
                },
              },
            ]),
          )
          const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6.1-sol"))
          const sessionID = SessionID.make("session-cache-write")
          const agent = {
            name: "test",
            mode: "primary",
            options: verbosity ? { textVerbosity: verbosity } : {},
            permission: [],
          } satisfies Agent.Info
          const events = yield* LLM.Service.use((svc) =>
            svc
              .stream({
                user: {
                  id: MessageID.make("msg_cache-write"),
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: agent.name,
                  model: { providerID: ProviderV2.ID.openai, modelID: resolved.id },
                },
                sessionID,
                model: resolved,
                agent,
                system: ["Test"],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              })
              .pipe(Stream.runCollect),
          )
          const steps = events.filter((event) => event.type === "step-finish")
          expect(steps).toHaveLength(1)
          expect(steps[0].usage).toMatchObject({
            inputTokens: 12000,
            cacheReadInputTokens: 8000,
            cacheWriteInputTokens: 3000,
            outputTokens: 200,
            reasoningTokens: 50,
            totalTokens: 12200,
          })
          expect(events.find((event) => event.type === "finish")?.usage?.cacheWriteInputTokens).toBe(3000)
          const billed = SessionNs.getUsage({
            model: { ...resolved, cost: { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } } },
            usage: steps[0].usage!,
          })
          expect(billed.tokens).toEqual({
            total: 12200,
            input: 1000,
            output: 150,
            reasoning: 50,
            cache: { read: 8000, write: 3000 },
          })
          expect(billed.cost).toBeCloseTo(0.0123, 10)
          const capture = yield* Effect.promise(() => request)
          expect(capture.body.text).toMatchObject({ verbosity: verbosity ?? "low" })
          expect(capture.body.prompt_cache_key).toBe(sessionID)
          expect(capture.body.reasoning).toEqual({ effort: "medium", summary: "auto" })
        }),
      {
        trusted: true,
        config: () =>
          openAIConfig(
            { ...loadFixture("openai", "gpt-5.2").model, id: "gpt-6.1-sol" },
            `${state.server!.url.origin}/v1`,
          ),
      },
    )
  }

  itReasoningContext.instance(
    "sends reasoning.context through the real SDK only when the experimental flag sets it",
    () =>
      Effect.gen(function* () {
        const request = waitRequest(
          "/responses",
          createEventResponse([
            {
              type: "response.created",
              response: { id: "resp-context", created_at: 1, model: "gpt-6.1-sol", service_tier: null },
            },
            {
              type: "response.completed",
              response: {
                incomplete_details: null,
                service_tier: null,
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            },
          ]),
        )
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6.1-sol"))
        const sessionID = SessionID.make("session-reasoning-context")
        const agent = { name: "test", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
        yield* LLM.Service.use((svc) =>
          svc
            .stream({
              user: {
                id: MessageID.make("msg_reasoning-context"),
                sessionID,
                role: "user",
                time: { created: 1 },
                agent: agent.name,
                model: { providerID: ProviderV2.ID.openai, modelID: resolved.id },
              },
              sessionID,
              model: resolved,
              agent,
              system: ["Test"],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            })
            .pipe(Stream.runDrain),
        )
        const capture = yield* Effect.promise(() => request)
        expect(capture.body.reasoning).toEqual({ effort: "medium", summary: "auto", context: "all_turns" })
      }),
    {
      trusted: true,
      config: () =>
        openAIConfig(
          { ...loadFixture("openai", "gpt-5.2").model, id: "gpt-6.1-sol" },
          `${state.server!.url.origin}/v1`,
        ),
    },
  )

  // Every model on one provider shares the SDK, and its fetch, that the first model resolved built.
  for (const order of [
    ["gpt-5.5", "gpt-6.1-sol"],
    ["gpt-6.1-sol", "gpt-5.5"],
  ]) {
    itReasoningContext.instance(
      `decides reasoning.context by each request's model when ${order[0]} builds the shared OpenAI SDK`,
      () =>
        Effect.gen(function* () {
          const sent = yield* Effect.forEach(order, (id) =>
            Effect.gen(function* () {
              const request = waitRequest(
                "/responses",
                createEventResponse([
                  {
                    type: "response.created",
                    response: { id: `resp-${id}`, created_at: 1, model: id, service_tier: null },
                  },
                  {
                    type: "response.completed",
                    response: {
                      incomplete_details: null,
                      service_tier: null,
                      usage: { input_tokens: 10, output_tokens: 1 },
                    },
                  },
                ]),
              )
              const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(id))
              const sessionID = SessionID.make(`session-reasoning-context-${id}`)
              const agent = { name: "test", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
              yield* LLM.Service.use((svc) =>
                svc
                  .stream({
                    user: {
                      id: MessageID.make(`msg_reasoning-context-${id}`),
                      sessionID,
                      role: "user",
                      time: { created: 1 },
                      agent: agent.name,
                      model: { providerID: ProviderV2.ID.openai, modelID: resolved.id },
                    },
                    sessionID,
                    model: resolved,
                    agent,
                    system: ["Test"],
                    messages: [{ role: "user", content: "Hello" }],
                    tools: {},
                  })
                  .pipe(Stream.runDrain),
              )
              return (yield* Effect.promise(() => request)).body
            }),
          )
          expect(Object.fromEntries(sent.map((body) => [body.model, body.reasoning]))).toEqual({
            "gpt-5.5": { effort: "medium", summary: "auto" },
            "gpt-6.1-sol": { effort: "medium", summary: "auto", context: "all_turns" },
          })
        }),
      {
        trusted: true,
        config: () => {
          const config = openAIConfig(
            { ...loadFixture("openai", "gpt-5.2").model, id: "gpt-6.1-sol" },
            `${state.server!.url.origin}/v1`,
          )
          const models = config.provider!.openai.models!
          models["gpt-5.5"] = { ...models["gpt-6.1-sol"], id: "gpt-5.5" }
          return config
        },
      },
    )
  }

  const vivgridFixture = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }
  it.instance(
    "sends temperature, tokens, and reasoning options for openai-compatible models",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      }),
    {
      trusted: true,
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  for (const effort of ["off", "default", "high"] as const)
    it.instance(
      `the openai-compatible SDK puts a reasoning object from the request's effort in the body at ${effort} effort`,
      () =>
        Effect.gen(function* () {
          const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
          const request = waitRequest(
            "/chat/completions",
            new Response(createChatStream("Hello"), {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          )
          const resolved = yield* Provider.use.getModel(
            ProviderV2.ID.make(vivgridFixture.providerID),
            ModelV2.ID.make(fixture.model.id),
          )
          // The options a free model whose reasoning is optional gets (ProviderTransform.effortOptions), on a model
          // without the free proxy in front: the proxy forwards `reasoning` and drops `reasoning_effort`, so the
          // object itself has to reach the body.
          const model = {
            ...resolved,
            variants: { none: { reasoning: { effort: "none" } }, high: { reasoning: { effort: "high" } } },
          }
          const sessionID = SessionID.make("session-sized-reasoning")
          const agent = { name: "build", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
          yield* drain({
            user: {
              id: MessageID.make("msg_sized-reasoning"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: model.providerID, modelID: model.id },
            },
            sessionID,
            model,
            agent,
            effort,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          const body = (yield* Effect.promise(() => request)).body
          expect(body.reasoning).toEqual(
            effort === "off" ? { effort: "none" } : effort === "high" ? { effort: "high" } : undefined,
          )
          expect(body.reasoning_effort).toBeUndefined()
        }),
      {
        trusted: true,
        config: () => ({
          enabled_providers: [vivgridFixture.providerID],
          provider: {
            [vivgridFixture.providerID]: {
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }),
      },
    )

  const cerebrasFixture = { providerID: "cerebras", modelID: "gpt-oss-120b" }
  it.instance(
    "replays Cerebras assistant reasoning using the provider-supported field",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(cerebrasFixture.providerID, cerebrasFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(cerebrasFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-cerebras-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-cerebras-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(cerebrasFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text: "Previous answer" },
              ],
            },
            { role: "user", content: "Continue" },
          ] satisfies ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const messages = capture.body.messages as Array<Record<string, unknown>>
        const assistant = messages.find((msg) => msg.role === "assistant")

        expect(assistant?.reasoning).toBe("thinking")
        expect(assistant && "reasoning_content" in assistant).toBe(false)
      }),
    {
      trusted: true,
      config: () => ({
        enabled_providers: [cerebrasFixture.providerID],
        provider: {
          [cerebrasFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const alibabaQwenFixture = { providerID: "alibaba", modelID: "qwen-plus" }
  for (const phase of ["headers", "body"] as const)
    it.instance(
      `service stream cancellation cancels pending provider ${phase} promptly`,
      () =>
        Effect.gen(function* () {
          const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
          const pending = waitStreamingRequest("/chat/completions", phase === "headers")

          const resolved = yield* Provider.use.getModel(
            ProviderV2.ID.make(alibabaQwenFixture.providerID),
            ModelV2.ID.make(fixture.model.id),
          )
          const sessionID = SessionID.make("session-test-service-abort")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const user = {
            id: MessageID.make("msg_user-service-abort"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
          } satisfies SessionV1.User

          const fiber = yield* drain({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          }).pipe(Effect.exit, Effect.forkScoped)

          yield* Effect.promise(() => pending.request)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() => Promise.race([pending.responseCanceled, timeout(500)]))
          const exit = yield* Fiber.await(fiber)
          // Fiber.await returns an Exit<Exit<...>>. Unwrap once.
          const inner = Exit.isSuccess(exit) ? exit.value : exit
          expect(Exit.isFailure(inner)).toBe(true)
          if (Exit.isFailure(inner)) {
            expect(Cause.hasInterrupts(inner.cause)).toBe(true)
          }
          yield* Effect.promise(() => Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined))
        }),
      {
        trusted: true,
        config: () => ({
          enabled_providers: [alibabaQwenFixture.providerID],
          provider: {
            [alibabaQwenFixture.providerID]: {
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }),
      },
    )

  it.instance(
    "keeps tools enabled by prompt permissions",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      }),
    {
      trusted: true,
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends responses API payload for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model

        const responseChunks = [
          {
            type: "response.created",
            response: {
              id: "resp-1",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-1",
            delta: "Hello",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(responseChunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      }),
    {
      trusted: true,
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )

  it.instance(
    "keeps supported OpenAI models on AI SDK path when native flag is off",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const request = waitRequest(
          "/responses",
          createEventResponse(
            [
              {
                type: "response.created",
                response: {
                  id: "resp-flag-off",
                  created_at: Math.floor(Date.now() / 1000),
                  model: model.id,
                  service_tier: null,
                },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "item-flag-off", status: "in_progress", role: "assistant", content: [] },
              },
              {
                type: "response.content_part.added",
                item_id: "item-flag-off",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: "item-flag-off",
                delta: "Flag off",
                logprobs: null,
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  usage: {
                    input_tokens: 1,
                    input_tokens_details: null,
                    output_tokens: 1,
                    output_tokens_details: null,
                  },
                  service_tier: null,
                },
              },
            ],
            true,
          ),
        )
        const failingNativeClient = Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
            stream: () => Stream.die(new Error("native LLM client should not be used when the flag is off")),
            generate: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-flag-off")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(
          AppNodeBuilder.build(LLM.node, [
            [LayerNodePlatform.llmClient, failingNativeClient],
            [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
          ]),
          {
            user: {
              id: MessageID.make("msg_user-native-flag-off"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
            } satisfies SessionV1.User,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
        )

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(resolved.api.id)
      }),
    {
      trusted: true,
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )

  it.instance(
    "streams OpenAI through native runtime when opted in",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          { type: "response.created", response: { id: "resp-native" } },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "item-native", status: "in_progress" },
          },
          { type: "response.output_text.delta", item_id: "item-native", delta: "Hello native" },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.headers.get("Authorization")).toBe("Bearer test-openai-key")
        expect(capture.body.model).toBe(model.id)
        expect(capture.body.stream).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect(capture.body.include).toEqual(["reasoning.encrypted_content"])
        expect(JSON.stringify(capture.body.input)).toContain("You are a helpful assistant.")
        expect(capture.body.input).toContainEqual({ role: "user", content: [{ type: "input_text", text: "Hello" }] })
      }),
    {
      trusted: true,
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )

  it.instance(
    "uses injected native request executor for tool calls",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-injected-tool", call_id: "call-injected-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-injected-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-injected-tool",
              call_id: "call-injected-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        let captured: Record<string, unknown> | undefined
        let executed: unknown
        const executor = Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                captured = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
                return HttpClientResponse.fromWeb(request, createEventResponse(chunks, true))
              }),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-injected-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ executor, flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-injected-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        expect(captured?.model).toBe(model.id)
        expect(captured?.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-injected-tool" })
      }),
    {
      trusted: true,
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, "https://injected-openai.test/v1"),
    },
  )

  it.instance(
    "the native runtime waits in a server's line, as the AI SDK's requests do",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          { type: "response.created", response: { id: "resp-native-line" } },
          { type: "response.output_text.delta", item_id: "item-native-line", delta: "Hello" },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        const slots = ModelSlots.make()
        // The line at the server as each request is sent.
        const seen: ModelSlots.Queue[] = []
        const executor = Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.sync(() => {
                seen.push(slots.queue(LINED_ORIGIN))
                return HttpClientResponse.fromWeb(request, createEventResponse(chunks, true))
              }),
          }),
        )
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-line")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ executor, slots, flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-line"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        // The provider says its server takes one request at a time: the request held the permit while it was sent,
        // and gave it back when its reply ended.
        expect(seen).toEqual([{ permits: 1, running: 1, waiting: 0 }])
        expect(slots.queue(LINED_ORIGIN)).toEqual({ permits: 1, running: 0, waiting: 0 })
      }),
    {
      trusted: true,
      config: () => {
        const config = openAIConfig(loadFixture("openai", "gpt-5.2").model, `${LINED_ORIGIN}/v1`)
        const openai = config.provider!.openai!
        return { ...config, provider: { openai: { ...openai, options: { ...openai.options, concurrency: 1 } } } }
      },
    },
  )

  it.instance(
    "executes OpenAI tool calls through native runtime",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-native-tool", call_id: "call-native-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-native-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-native-tool",
              call_id: "call-native-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        let executed: unknown

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.body.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-native-tool" })
      }),
    {
      trusted: true,
      config: () => {
        const model = loadFixture("openai", "gpt-5.2").model
        return {
          enabled_providers: ["openai"],
          provider: {
            openai: {
              name: "OpenAI",
              env: ["OPENAI_API_KEY"],
              npm: "@ai-sdk/openai",
              api: "https://api.openai.com/v1",
              models: { [model.id]: JSON.parse(JSON.stringify(model)) as ConfigModel },
              options: { apiKey: "test-openai-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "accepts user image attachments as data URLs for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.created",
            response: {
              id: "resp-data-url",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-data-url", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-data-url",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-data-url",
            delta: "Looks good",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        const image = `data:image/png;base64,${Buffer.from(
          yield* Effect.promise(() =>
            Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
          ),
        ).toString("base64")}`

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                { type: "file", mediaType: "image/png", filename: "large-image.png", data: image },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      }),
    {
      trusted: true,
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )

  const minimaxFixture = { providerID: "minimax", modelID: "MiniMax-M2.5" }
  it.instance(
    "sends messages API payload for Anthropic Compatible models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(minimaxFixture.providerID, minimaxFixture.modelID).model

        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-1",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(minimaxFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("minimax"), modelID: ModelV2.ID.make("MiniMax-M2.5") },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      }),
    {
      trusted: true,
      config: () => ({
        enabled_providers: [minimaxFixture.providerID],
        provider: {
          [minimaxFixture.providerID]: {
            options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends anthropic tool_use blocks with tool_result immediately after them",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-tool-order",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies SessionV1.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages(input as any, resolved))
        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: modelMessages,
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
        expect(messages[0]?.role).toBe("user")
        expect(messages[0]?.content[0]).toMatchObject({
          type: "text",
          text: "Can you check whether there are any PDF files in my home directory?",
        })
        expect(messages.some((message) => message.content.some((part) => "cache_control" in part))).toBe(true)
        const toolUseIndex = messages.findIndex((message) => message.content.some((part) => part.type === "tool_use"))
        expect(toolUseIndex).toBeGreaterThan(0)
        expect(messages[toolUseIndex].role).toBe("assistant")
        expect(messages[toolUseIndex].content.filter((part) => part.type === "tool_use")).toMatchObject([
          {
            type: "tool_use",
            id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
            name: "read",
            input: { filePath: "/root" },
          },
          {
            type: "tool_use",
            id: "toolu_01APxrADs7VozN8uWzw9WwHr",
            name: "glob",
            input: { pattern: "**/*.pdf", path: "/root" },
          },
        ])
        expect(messages[toolUseIndex + 1]).toMatchObject({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT", content: "<path>/root</path>" },
            { type: "tool_result", tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr", content: "No files found" },
          ],
        })
      }),
    {
      trusted: true,
      config: () => {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        return {
          enabled_providers: ["anthropic"],
          provider: {
            anthropic: {
              name: "Anthropic",
              env: ["ANTHROPIC_API_KEY"],
              npm: "@ai-sdk/anthropic",
              api: "https://api.anthropic.com/v1",
              models: { [model.id]: configModel(model) as ConfigModel },
              options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  const geminiFixture = { providerID: "google", modelID: "gemini-2.5-flash" }
  it.instance(
    "sends Google API payload for Gemini models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(geminiFixture.providerID, geminiFixture.modelID).model
        const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

        const chunks = [
          {
            candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          },
        ]
        const request = waitRequest(pathSuffix, createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(geminiFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(geminiFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "reasoning", text: "" }] },
          ],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }])
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      }),
    {
      trusted: true,
      config: () => ({
        enabled_providers: [geminiFixture.providerID],
        provider: {
          [geminiFixture.providerID]: {
            options: { apiKey: "test-google-key", baseURL: `${state.server!.url.origin}/v1beta` },
          },
        },
      }),
    },
  )
})

describe("session.llm.stream tool order", () => {
  // One response: an edit, a shell check, a read and a second edit written after the check. Each edit waits for the
  // test to release it, so the order the calls actually ran in is observable.
  const call = (index: number, id: string, name: string, args: Record<string, unknown>) => {
    const item = { type: "function_call", id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) }
    return [
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      { type: "response.output_item.done", output_index: index, item: { ...item, status: "completed" } },
    ]
  }
  const chunks = [
    {
      type: "response.created",
      response: { id: "resp-tool-order", created_at: 1, model: "gpt-5.2", service_tier: null },
    },
    ...call(0, "call-edit", "edit", { filePath: "a.ts" }),
    ...call(1, "call-check", "bash", { command: "bun test" }),
    ...call(2, "call-read", "read", { filePath: "b.ts" }),
    ...call(3, "call-write", "write", { filePath: "c.ts" }),
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        service_tier: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]

  for (const runtime of ["ai-sdk", "native"] as const)
    it.instance(
      `starts a shell call only after every edit in its response has finished (${runtime})`,
      () =>
        Effect.gen(function* () {
          void waitRequest("/responses", createEventResponse(chunks, true))
          const log: string[] = []
          const release: Record<string, ReturnType<typeof deferred<void>>> = {
            "call-edit": deferred<void>(),
            "call-write": deferred<void>(),
          }
          const ended: Record<string, ReturnType<typeof deferred<void>>> = {
            "call-edit": deferred<void>(),
            "call-write": deferred<void>(),
          }
          const started = deferred<void>()
          const note = (entry: string) => {
            log.push(entry)
            if (["call-edit:start", "call-write:start", "call-read"].every((item) => log.includes(item)))
              started.resolve()
          }
          const edit = tool({
            description: "Edit a file",
            inputSchema: z.object({ filePath: z.string() }),
            execute: async (_args, options) => {
              note(`${options.toolCallId}:start`)
              await release[options.toolCallId].promise
              note(`${options.toolCallId}:end`)
              ended[options.toolCallId].resolve()
              return { output: "edited" }
            },
          })
          const tools = {
            edit,
            write: edit,
            read: tool({
              description: "Read a file",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => {
                note("call-read")
                return { output: "read" }
              },
            }),
            bash: tool({
              description: "Run a command",
              inputSchema: z.object({ command: z.string() }),
              execute: async () => {
                note("call-check")
                return { output: "checked" }
              },
            }),
          }
          const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.2"))
          const sessionID = SessionID.make(`session-tool-order-${runtime}`)
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const input = {
            user: {
              id: MessageID.make(`msg_user-tool-order-${runtime}`),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.openai, modelID: resolved.id },
            } satisfies SessionV1.User,
            sessionID,
            model: resolved,
            agent,
            system: [],
            messages: [{ role: "user", content: "Fix and check" }],
            tools,
          } satisfies LLM.StreamInput
          const fiber = yield* (
            runtime === "native"
              ? drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), input)
              : drain(input)
          ).pipe(Effect.forkChild)

          // Both edits and the read are running: the read did not wait, and the check has not started.
          yield* Effect.promise(() => started.promise)
          expect(log).not.toContain("call-check")
          release["call-edit"].resolve()
          yield* Effect.promise(() => ended["call-edit"].promise)
          // The check also waits for the edit written after it in the same response.
          expect(log).not.toContain("call-check")
          release["call-write"].resolve()
          yield* Fiber.join(fiber)

          expect(log.indexOf("call-read")).toBeLessThan(log.indexOf("call-edit:end"))
          expect(log.indexOf("call-check")).toBeGreaterThan(log.indexOf("call-edit:end"))
          expect(log.indexOf("call-check")).toBeGreaterThan(log.indexOf("call-write:end"))
        }),
      {
        trusted: true,
        config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
      },
    )
})
