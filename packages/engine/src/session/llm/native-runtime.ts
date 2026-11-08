import type { Auth } from "@/auth"
import { providerUsable, providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, Fiber, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import {
  LLMRequest,
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type JsonSchema,
  type LLMEvent,
} from "@vectordevai/llm"
import type { LLMClientShape } from "@vectordevai/llm/route"
import { LLMNative } from "./native-request"
import { ToolOrder } from "./tool-order"

const BOUNDARY = Symbol("vector.native-cache-boundary")

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  /** False for a request whose prefix is never sent again: no cache breakpoints (LLM.StreamInput.cache). */
  readonly cache?: boolean
  /** The index in `messages` of a fork's last inherited message, which takes a cache breakpoint of its own. */
  readonly boundary?: number
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  if (!providerUsable(providerID, input.provider) || providerID !== input.provider.id)
    return { type: "unsupported", reason: "provider is not supported" }
  if (input.auth && !providerCredentialAllowed(providerID, input.auth, providerUsable(providerID, input.provider)))
    return { type: "unsupported", reason: "provider sign-in is paused" }
  if (providerID !== "openai" && providerID !== "anthropic")
    return { type: "unsupported", reason: "provider is not openai or anthropic" }
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === "openai" && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

export function stream(input: StreamInput): StreamResult {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current

  // Integration point with @vectordevai/llm: native-request lowers session data
  // into an LLMRequest, then LLMClient handles route selection and transport.
  //
  // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
  // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
  // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
  // include, textVerbosity, promptCacheKey). Both sides intentionally use
  // OpenAI's official wire field names, so this is identity, not translation
  // — if a field ever needs to differ between the two surfaces, the
  // translation belongs here, not split across both packages.
  const tools = nativeTools(input.tools, input)
  // The native request places its own cache breakpoints and does not read the transform's markers, so the fork's
  // boundary goes to it too, found again after the transform may have dropped or rewritten messages.
  const tagged =
    input.boundary === undefined
      ? input.messages
      : input.messages.map((message, index) =>
          index === input.boundary ? Object.assign({ ...message }, { [BOUNDARY]: true }) : message,
        )
  const messages = ProviderTransform.message(
    tagged,
    input.model,
    input.providerOptions ?? {},
    input.cache !== false,
    input.boundary,
  )
  const boundary = input.boundary === undefined ? -1 : messages.findIndex((message) => BOUNDARY in message)
  const request = LLMNative.request({
    model: input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    messages,
    cache: input.cache !== false,
    ...(boundary >= 0 ? { boundary } : {}),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
    headers: { ...providerHeaders(input.provider.options.headers), ...input.headers },
  })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        // As on the AI SDK path (ToolOrder), shell calls start once the response has ended and its edits have finished.
        const edits: Fiber.Fiber<void>[] = []
        const shells: Extract<LLMEvent, { type: "tool-call" }>[] = []
        const dispatch = (event: Extract<LLMEvent, { type: "tool-call" }>) =>
          ToolRuntime.dispatch(tools, event).pipe(
            Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
            Effect.catchCause((cause) => Queue.failCause(results, cause)),
            Effect.asVoid,
            FiberSet.run(settlements, { startImmediately: true }),
          )
        const provider = input.llmClient
          .stream(
            LLMRequest.update(request, {
              tools: [...request.tools, ...toDefinitions(tools)],
            }),
          )
          .pipe(
            Stream.flatMap((event) => {
              if (event.type !== "tool-call" || event.providerExecuted) return Stream.make(event)
              if (ToolOrder.shell(event.name)) {
                shells.push(event)
                return Stream.make(event)
              }
              return Stream.make(event).pipe(
                Stream.concat(
                  Stream.fromEffectDrain(
                    dispatch(event).pipe(
                      Effect.tap((fiber) =>
                        Effect.sync(() => {
                          if (ToolOrder.mutates(event.name)) edits.push(fiber)
                        }),
                      ),
                    ),
                  ),
                ),
              )
            }),
            Stream.concat(
              Stream.fromEffectDrain(
                Effect.suspend(() => Fiber.awaitAll(edits)).pipe(
                  Effect.andThen(Effect.suspend(() => Effect.forEach(shells, dispatch, { discard: true }))),
                  Effect.andThen(FiberSet.awaitEmpty(settlements)),
                  Effect.andThen(Queue.end(results)),
                  Effect.asVoid,
                ),
              ),
            ),
          )
        return provider.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )

  return {
    ...current,
    stream: fetch ? stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : stream,
  }
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== "openai" || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains vector-owned. The native runtime only adapts
      // the @vectordevai/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
