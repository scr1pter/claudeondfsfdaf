import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { llmClient } from "@vectordevai/core/effect/app-node-platform"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { providerCredentialAllowed, providerUsable } from "@vectordevai/core/provider-policy"
import { Context, Effect, Exit, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent, UsageInput } from "@vectordevai/llm"
import type { TaskSize } from "@vectordevai/core/task-size"
import { LLMClient } from "@vectordevai/llm/route"
import type { LLMClientService } from "@vectordevai/llm/route"
import type { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@vectordevai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { LLMTiming } from "./llm/timing"
import { NativePatch } from "./llm/native-patch"
import { Session } from "./session"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { ToolOrder } from "./llm/tool-order"
import { REQUEST_ID_HEADER } from "@/plugin/openai/transport"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  // False when the agent may not launch the explore specialist, so the provider prompt does not suggest it.
  explore?: boolean
  // System parts that are the same for every session of the agent on the model. They are sent with the provider prompt
  // as a block of their own, ahead of `system`, so the provider's prompt cache can reuse that block across sessions.
  stableSystem?: string[]
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  // Reasoning effort from the request's task size (LLMRequestPrep.prepare).
  effort?: TaskSize.Effort
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  // false for a request whose prefix is never sent again, such as a compaction summary: cache breakpoints would only
  // make the provider bill its whole input at the cache-write premium.
  cache?: boolean
  // Called with usage the provider reports as it starts a response, before the step finishes. Interrupted streams
  // may report nothing more, so these counters remain a known subtotal with incomplete final usage.
  started?: (usage: UsageInput) => void
  // The SDK accepted a streaming response, even when no usage or content chunk has arrived yet.
  accepted?: () => void
  // Called at the first event of the response, once the provider has the request and is answering it.
  answering?: () => void
  // What the request carries out of the brain (personal memory, private document passages, repository excerpts), for
  // Vector Local's network log. It travels in the request's attribution, never in a header.
  carried?: LocalMode.Carried
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
  requestID: string
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@vector/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
  | ModelSlots.Service
  | Session.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const slots = yield* ModelSlots.Service
    const sessions = yield* Session.Service

    // The top of a session's parent chain, or the last ancestor that could still be read.
    const rootOf = (session: Session.Info): Effect.Effect<Session.Info> =>
      session.parentID
        ? sessions.get(session.parentID).pipe(
            Effect.flatMap(rootOf),
            Effect.catch(() => Effect.succeed(session)),
          )
        : Effect.succeed(session)

    // Who a model call is for, for Vector Local's network log: the session, the root of its chain (so a subagent, a title,
    // a compaction, the judge and Vectorscope's helpers count in the session that started them), the agent, or a helper
    // session's internal name, and what the call carried out of the brain. It is read only while Vector Local is on.
    const attribution = Effect.fnUntraced(function* (input: StreamRequest) {
      if (!Egress.policy().enabled) return undefined
      const session = yield* sessions.get(SessionID.make(input.sessionID)).pipe(Effect.option)
      const root = Option.isSome(session) ? yield* rootOf(session.value) : undefined
      return {
        sessionID: input.sessionID,
        rootID: root?.id ?? input.parentSessionID ?? input.sessionID,
        agent: (Option.isSome(session) ? session.value.internal : undefined) ?? input.agent.name,
        purpose: "inference",
        carried: input.carried,
      } satisfies EgressAttribution.Info
    })

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        "request.id": input.requestID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      // A small request is a title or a name: on a model server someone hosts, its reply stays short.
      const laned = input.small ? Provider.brief(input.model) : input.model
      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(laned),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth
            .get(input.model.providerID)
            .pipe(
              Effect.map((stored) =>
                stored &&
                providerCredentialAllowed(
                  input.model.providerID,
                  stored,
                  providerUsable(input.model.providerID, { npm: input.model.api.npm, api: input.model.api.url }),
                )
                  ? stored
                  : undefined,
              ),
            ),
        ],
        { concurrency: "unbounded" },
      )

      // The GitLab provider package is large. Its workflow models come only from its bundled SDK, which the provider
      // loads for this npm name, so other models never load it here.
      const gitlab =
        input.model.api.npm === "gitlab-ai-provider"
          ? yield* Effect.promise(() => import("gitlab-ai-provider"))
          : undefined
      const isWorkflow = gitlab !== undefined && language instanceof gitlab.GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      if (
        input.model.providerID === "openai" &&
        info &&
        !flags.disableDefaultPlugins &&
        typeof item.options.fetch === "function"
      )
        Object.assign(prepared.headers, { [REQUEST_ID_HEADER]: input.requestID })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via vector's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (isWorkflow) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      // The OpenTelemetry tracer package loads only when the experimental exporter is configured.
      const tracer = yield* Effect.gen(function* () {
        if (!cfg.experimental?.openTelemetry) return undefined
        const { OtelTracer } = yield* Effect.promise(() => import("@effect/opentelemetry/Tracer"))
        return Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer))
      })
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const scope = yield* attribution(input)
      // The AI SDK starts its request inside streamText, so the request and everything it waits on (its place at a model
      // server, the provider's fetch) run inside the attribution scope.
      const send = (options: Parameters<typeof streamText>[0]) =>
        scope ? EgressAttribution.run(scope, () => streamText(options)) : streamText(options)

      // Runtime seam: native is an opt-in adapter over @vectordevai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          // The native runtime sends its requests itself, so on a server with a line (Provider.line) the stream holds
          // a permit in it, as getLanguage's requests do, until the reply ends.
          const line = yield* provider.line(input.model)
          const held = line
            ? Stream.unwrap(
                slots
                  .take({ origin: line.origin, permits: line.permits, priority: Provider.priorityOf(laned) })
                  .pipe(Effect.as(native.stream)),
              )
            : native.stream
          return {
            type: "native" as const,
            stream: scope ? held.pipe(Stream.provideService(EgressAttribution.Reference, scope)) : held,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: send({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields, and Anthropic
          // reports a response's input usage in message_start, which the SDK holds back until the response finishes.
          includeRawChunks:
            input.model.providerID.includes("github-copilot") ||
            input.model.api.npm === "@ai-sdk/openai" ||
            input.model.api.npm === "@ai-sdk/anthropic" ||
            input.model.api.npm === "@ai-sdk/google-vertex/anthropic",
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          // A workflow model runs its tools inside its own stream, so holding a shell call back to the end would wait
          // on itself.
          tools: isWorkflow ? prepared.tools : ToolOrder.tools(prepared.tools, input.abort),
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                      input.cache !== false,
                    )
                  }
                  return args.params
                },
                async wrapStream({ doStream }) {
                  const response = await doStream()
                  input.accepted?.()
                  return response
                },
              },
              NativePatch.middleware({
                model: input.model,
                options: prepared.params.options,
                tool: prepared.tools.apply_patch,
              }),
              ...(isWorkflow ? [] : [ToolOrder.middleware()]),
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const timing = LLMTiming.create()
            const requestID = crypto.randomUUID()
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )
            yield* Effect.addFinalizer((exit) =>
              Effect.logInfo("llm request timing", {
                "session.id": input.sessionID,
                "request.id": requestID,
                providerID: input.model.providerID,
                modelID: input.model.id,
                agent: input.agent.name,
                small: input.small ?? false,
                ...timing.summary(
                  Exit.hasInterrupts(exit) ? "interrupted" : Exit.isFailure(exit) ? "failure" : "success",
                ),
              }),
            )

            const result = yield* run({ ...input, abort: ctrl.signal, requestID })
            timing.ready()
            let answered = false
            const observe = (event: LLMEvent) =>
              Effect.sync(() => {
                timing.observe(event)
                if (answered || event.type === "provider-error" || event.type === "finish") return
                answered = true
                input.answering?.()
              })

            if (result.type === "native") return result.stream.pipe(Stream.tap(observe))

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  const usage = event.type === "raw" ? LLMAISDK.startedUsage(event.rawValue) : undefined
                  if (usage) input.started?.(usage)
                }),
              ),
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.tap(observe),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
    ModelSlots.node,
    Session.node,
  ],
})

export * as LLM from "./llm"
