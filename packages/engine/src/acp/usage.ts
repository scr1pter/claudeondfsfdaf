import { Billing } from "@vectordevai/schema/billing"
import type { AgentSideConnection, Usage } from "@agentclientprotocol/sdk"
import type { AssistantMessage as VectorAssistantMessage, Message } from "@vectordevai/sdk/v2"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { makeGlobalNode, Node } from "@vectordevai/core/effect/app-node"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer, SynchronizedRef } from "effect"

export type AssistantTokenCost = Pick<VectorAssistantMessage, "cost" | "tokens" | "unpriced" | "billing"> &
  Partial<Pick<VectorAssistantMessage, "providerID">>

export type AssistantMessage = AssistantTokenCost &
  Pick<VectorAssistantMessage, "role"> &
  Partial<Pick<VectorAssistantMessage, "providerID" | "modelID" | "parentID" | "id">>

export type SessionMessage = {
  readonly info: { readonly role: Message["role"]; readonly id?: string } | AssistantMessage
  readonly parts?: ReadonlyArray<{ readonly type: string; readonly synthetic?: boolean }>
}

export type MessagesInput = {
  readonly sessionID: string
  readonly directory: string
}

export type SDK = {
  readonly session: {
    readonly messages: (
      parameters: { readonly sessionID: string; readonly directory: string },
      options: { readonly throwOnError: true },
    ) => Promise<{ readonly data?: readonly SessionMessage[] | null }>
  }
}

export interface MessageLoaderInterface {
  readonly messages: (input: MessagesInput) => Effect.Effect<readonly SessionMessage[], unknown>
}

export interface ContextLimitLoaderInterface {
  readonly providers: (directory: string) => Effect.Effect<Record<ProviderV2.ID, Provider.Info>, unknown>
}

export type UsageConnection = Pick<AgentSideConnection, "sessionUpdate">

export interface Interface {
  readonly buildUsage: (message: AssistantTokenCost) => Usage | undefined
  readonly latestAssistantMessage: (messages: readonly SessionMessage[]) => AssistantMessage | undefined
  readonly totalSessionCost: (messages: readonly SessionMessage[]) => number | undefined
  readonly contextLimit: (input: {
    readonly directory: string
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
  }) => Effect.Effect<number | undefined>
  /** Sends the session's usage_update and returns the messages it read, or undefined when it could not read them. */
  readonly sendUpdate: (input: {
    readonly connection: UsageConnection
    readonly sessionID: string
    readonly directory: string
  }) => Effect.Effect<readonly SessionMessage[] | undefined>
}

export class MessageLoader extends Context.Service<MessageLoader, MessageLoaderInterface>()(
  "@vector/ACPUsageMessageLoader",
) {}

export class ContextLimitLoader extends Context.Service<ContextLimitLoader, ContextLimitLoaderInterface>()(
  "@vector/ACPUsageContextLimitLoader",
) {}

export class Service extends Context.Service<Service, Interface>()("@vector/ACPUsage") {}

export function messageLoaderFromSDK(sdk: SDK): MessageLoaderInterface {
  return MessageLoader.of({
    messages: (input) =>
      Effect.promise(() =>
        sdk.session
          .messages({ sessionID: input.sessionID, directory: input.directory }, { throwOnError: true })
          .then((response) => response.data ?? []),
      ),
  })
}

export const messageLoaderLayer = (sdk: SDK) => Layer.succeed(MessageLoader, messageLoaderFromSDK(sdk))

export function buildUsage(message: AssistantTokenCost): Usage | undefined {
  if (Billing.of(message)) return
  const cachedReadTokens = message.tokens.cache.read
  const cachedWriteTokens = message.tokens.cache.write
  const thoughtTokens = message.tokens.reasoning

  return {
    inputTokens: message.tokens.input,
    outputTokens: message.tokens.output,
    totalTokens: message.tokens.input + message.tokens.output + thoughtTokens + cachedReadTokens + cachedWriteTokens,
    ...(thoughtTokens > 0 ? { thoughtTokens } : {}),
    ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
  }
}

// The last response that reported usage. A cancelled or failed step reports none, and reading its zeros would
// show an empty context window while the conversation still fills it.
export function latestAssistantMessage(messages: readonly SessionMessage[]): AssistantMessage | undefined {
  return messages
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .findLast((message) => message.info.tokens.output > 0)?.info
}

// Everything the prompt occupies: tokens.input leaves out cache reads and the prefix written to the cache this step.
export function contextTokens(message: AssistantTokenCost) {
  return message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
}

// Every provider step of a prompt is a separate assistant message, so a turn's usage is their sum: every reply from
// the prompt's own user message to the final one. An auto-compaction mid-turn adds a compaction marker and a synthetic
// "continue" message that later steps answer, so the turn starts at the last user message someone actually wrote.
export function turnUsage(messages: readonly SessionMessage[], finalID: string): Usage | undefined {
  const end = messages.findIndex((message) => message.info.id === finalID)
  if (end < 0) return undefined
  const start = messages
    .slice(0, end)
    .findLastIndex(
      (message) =>
        message.info.role === "user" &&
        (message.parts ?? []).some((part) => part.type !== "compaction" && part.synthetic !== true),
    )
  const steps = messages
    .slice(start + 1, end + 1)
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .filter((message) => Billing.hasOwnIdentity(message.info))
  if (!steps.length) return undefined
  return buildUsage({
    cost: steps.reduce((sum, step) => sum + step.info.cost, 0),
    tokens: {
      input: steps.reduce((sum, step) => sum + step.info.tokens.input, 0),
      output: steps.reduce((sum, step) => sum + step.info.tokens.output, 0),
      reasoning: steps.reduce((sum, step) => sum + step.info.tokens.reasoning, 0),
      cache: {
        read: steps.reduce((sum, step) => sum + step.info.tokens.cache.read, 0),
        write: steps.reduce((sum, step) => sum + step.info.tokens.cache.write, 0),
      },
    },
  })
}

// Undefined when a response ran on a model with no listed price: the rest of the session is not what it cost.
// Subagents keep their messages in their own sessions, so what they spent comes from the session's rollup.
export function totalSessionCost(
  messages: readonly SessionMessage[],
  subagents?: {
    readonly subagentCost?: number
    readonly subagentUnpricedSteps?: number
    readonly subagentCodiumSteps?: number
  },
): number | undefined {
  const assistant = messages.filter(
    (message): message is { readonly info: AssistantMessage } => message.info.role === "assistant",
  )
  if (
    assistant.some((message) => message.info.unpriced || Billing.of(message.info)) ||
    subagents?.subagentUnpricedSteps ||
    subagents?.subagentCodiumSteps
  )
    return undefined
  return assistant.reduce((sum, message) => sum + message.info.cost, 0) + (subagents?.subagentCost ?? 0)
}

export function findContextLimit(
  providers: Record<ProviderV2.ID, Provider.Info>,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
): number | undefined {
  return providers[providerID]?.models[modelID]?.limit.context
}

export const contextLimitLoaderLayer = Layer.effect(
  ContextLimitLoader,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service

    return ContextLimitLoader.of({
      providers: Effect.fn("ACPUsageContextLimitLoader.providers")(function* (directory) {
        const ctx = yield* store.load({ directory })
        return yield* Effect.gen(function* () {
          return yield* provider.list()
        }).pipe(Effect.provideService(InstanceRef, ctx))
      }),
    })
  }),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const messageLoader = yield* MessageLoader
    const contextLimitLoader = yield* ContextLimitLoader
    const limits = yield* SynchronizedRef.make(new Map<string, Effect.Effect<number | undefined>>())

    const cachedLimit = Effect.fnUntraced(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* SynchronizedRef.modifyEffect(
        limits,
        Effect.fnUntraced(function* (items) {
          const key = `${input.directory}\u0000${input.providerID}\u0000${input.modelID}`
          const current = items.get(key)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            contextLimitLoader.providers(input.directory).pipe(
              Effect.map((providers) => findContextLimit(providers, input.providerID, input.modelID)),
              Effect.catch((error) =>
                Effect.logError("failed to get providers for usage context limit", { error: error }).pipe(
                  Effect.as(undefined),
                ),
              ),
            ),
          )
          return [next, new Map(items).set(key, next)] as const
        }),
      )
    })

    const contextLimit = Effect.fn("ACPUsage.contextLimit")(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* yield* cachedLimit(input)
    })

    const sendUpdate = Effect.fn("ACPUsage.sendUpdate")(function* (input: {
      readonly connection: UsageConnection
      readonly sessionID: string
      readonly directory: string
    }) {
      const messages = yield* messageLoader
        .messages({ sessionID: input.sessionID, directory: input.directory })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
          ),
        )
      if (!messages) return

      const latest = messages.findLast(
        (message): message is { readonly info: AssistantMessage } => message.info.role === "assistant",
      )
      if (latest && !Billing.hasOwnIdentity(latest.info)) return messages
      const message = latestAssistantMessage(messages)
      if (!message?.providerID || !Billing.hasOwnIdentity(message) || !message.modelID) return messages

      const size = yield* contextLimit({
        directory: input.directory,
        providerID: ProviderV2.ID.make(message.providerID),
        modelID: ModelV2.ID.make(message.modelID),
      })
      if (!size) return messages
      const cost = totalSessionCost(messages)

      yield* Effect.promise(() =>
        input.connection
          .sessionUpdate({
            sessionId: input.sessionID,
            update: {
              sessionUpdate: "usage_update",
              used: contextTokens(message),
              size,
              cost: cost === undefined ? undefined : { amount: cost, currency: "USD" },
            },
          })
          .catch(() => {}),
      )
      return messages
    })

    return Service.of({
      buildUsage,
      latestAssistantMessage,
      totalSessionCost,
      contextLimit,
      sendUpdate,
    })
  }),
)

export const messageLoaderNode = LayerNode.unbound(MessageLoader, Node.tags.values.global)

export const contextLimitLoaderNode = makeGlobalNode({
  service: ContextLimitLoader,
  layer: contextLimitLoaderLayer,
  deps: [Provider.node, InstanceStore.node],
})

export const node = makeGlobalNode({ service: Service, layer, deps: [messageLoaderNode, contextLimitLoaderNode] })

export * as UsageService from "./usage"
