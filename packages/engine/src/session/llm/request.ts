import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { BrainDistill } from "@vectordevai/core/brain/distill"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import type { TaskSize } from "@vectordevai/core/task-size"

const USER_AGENT = `vector/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  // False when the agent may not launch the explore specialist, so the provider prompt does not suggest it.
  readonly explore?: boolean
  readonly stableSystem?: string[]
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  // Reasoning effort from the request's task size. The user's own pick wins, except that a greeting ("off") never
  // reasons at whatever effort the user chose for real work.
  readonly effort?: TaskSize.Effort
  readonly tools: Record<string, Tool>
  readonly purpose?: ModelPlanStatus.Purpose
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  // Sent as promptCacheKey or prompt_cache_key, where the options carry one, instead of the session ID.
  readonly cacheKey?: string
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const prompt = [
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model, input.explore)),
    ...(input.stableSystem ?? []),
  ]
  const rest = [...input.system, ...(input.user.system ? [input.user.system] : [])]
  // With stable parts, the prompt and those parts form the first block and everything per-session (directory, date,
  // references, project instructions, MCP, skills, the user's system text) the second, so a new session, directory or
  // date leaves the first block, and every prefix it starts, unchanged. A model that takes cache breakpoints gets one
  // on each block. A ChatGPT sign-in sends the first block as `instructions` and the second as a developer message
  // after it, as the Codex CLI does: the instructions and tools then stay the same from session to session, so a new
  // session's first request can read them from the provider's cache whichever of the two the provider renders first.
  // Elsewhere it stays one block, stable parts first: those providers cache the prefix without markers.
  const split = input.stableSystem && (ProviderTransform.usesCacheBreakpoints(input.model) || isOpenaiOauth)
  const system = (split ? [prompt, rest] : [[...prompt, ...rest]])
    .map((block) => block.filter((x) => x).join("\n"))
    .filter((block) => block)

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const breakpoints = ProviderTransform.promptCacheBreakpointsEnabled({
    setting: input.provider.options.promptCacheBreakpoints,
    providerID: input.provider.id,
    npm: input.model.api.npm,
    modelID: input.model.api.id,
    apiKey:
      input.auth?.type === "api" ||
      (!input.auth && (typeof input.provider.options.apiKey === "string" || typeof input.provider.key === "string")),
    url: input.provider.options.baseURL ?? input.model.api.url,
  })
  const stablePrefix = breakpoints ? prompt.filter(Boolean).join("\n") : undefined
  const cachePrefix =
    breakpoints &&
    !input.small &&
    !input.isWorkflow &&
    !input.flags.experimentalNativeLlm &&
    input.stableSystem?.length &&
    stablePrefix?.trim() &&
    system[0] === header &&
    system[0]?.startsWith(stablePrefix)
      ? ProviderTransform.promptCachePrefix(stablePrefix)
      : undefined

  const picked =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : undefined
  const variant = input.effort === "off" ? {} : (picked ?? {})
  // Sizing sets effort only where neither the user nor the agent's config did.
  const sized =
    !input.small && input.effort && (input.effort === "off" || !picked)
      ? ProviderTransform.effortOptions(input.model, input.effort)
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(
    mergeOptions(mergeOptions(mergeOptions(base, input.model.options), sized), input.agent.options),
    variant,
  )
  // A fork's first request of a run names its root's key, so it is routed to the cache that holds the parent's prefix.
  if (input.cacheKey)
    for (const key of ["promptCacheKey", "prompt_cache_key"]) if (key in options) options[key] = input.cacheKey
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  // A ChatGPT sign-in takes the leading block as `instructions` (all of it when nothing was split off) and the blocks
  // after it as developer items ahead of the conversation, the role the Codex CLI gives its environment, whatever role
  // the SDK would pick for the model on its own.
  const instructions = isOpenaiOauth ? (split ? system.slice(0, 1) : system) : []
  if (isOpenaiOauth) {
    options.instructions = instructions.join("\n")
    options.systemMessageMode = "developer"
  }

  const messages = input.isWorkflow
    ? input.messages
    : [
        ...system.slice(instructions.length).map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(
        input.model,
        // An automatic title keeps its provisional fallback if generation runs out of room. It must not inherit a
        // task-sized reasoning/output allowance, including Fast mode's increase.
        input.small && input.agent.name === "title"
          ? Math.min(input.flags.outputTokenMax ?? ProviderTransform.OUTPUT_TOKEN_MAX, 512)
          : input.agent.name === "distill"
            ? BrainDistill.LIMIT.output
            : input.user.executionMode === "fast"
              ? Math.floor((input.flags.outputTokenMax ?? ProviderTransform.OUTPUT_TOKEN_MAX) * 1.5)
              : input.flags.outputTokenMax,
      ),
      options,
    },
  )

  // Provider hooks may omit a normal task's limit. An automatic title must keep its smaller ceiling afterwards.
  if (input.small && input.agent.name === "title")
    params.maxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model,
      Math.min(
        params.maxOutputTokens ?? Infinity,
        input.flags.outputTokenMax ?? ProviderTransform.OUTPUT_TOKEN_MAX,
        512,
      ),
    )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    // The session header goes last and in one spelling: the free-model fetch reads it to apply the guest rule
    // (FreeModelGuests), so model configuration and plugins can neither replace it nor join a second value to it. A
    // Codium request's purpose is fixed the same way and is sent to Codium only.
    headers: Object.assign(
      Object.fromEntries(
        Object.entries({
          "x-session-affinity": input.sessionID,
          ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
          "User-Agent": USER_AGENT,
          ...input.model.headers,
          ...headers,
        }).filter(
          ([key]) =>
            !["x-session-id", "x-vector-purpose", ProviderTransform.PROMPT_CACHE_PREFIX_HEADER].includes(
              key.toLowerCase(),
            ),
        ),
      ),
      {
        "X-Session-Id": input.sessionID,
        ...(cachePrefix ? { [ProviderTransform.PROMPT_CACHE_PREFIX_HEADER]: cachePrefix } : {}),
      },
      input.model.providerID === ModelPlanStatus.PROVIDER_ID
        ? { "X-Vector-Purpose": input.purpose ?? (input.agent.name === "judge" ? "judge" : "chat") }
        : {},
    ),
  }
})

export function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  const offered = Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  // A workflow launches its agents through the task tool, so it is withheld whenever task is (G.3, G.9).
  if (!Object.hasOwn(offered, "task")) delete offered.workflow
  return offered
}

/**
 * Where the message at `index` of a request's messages lands in the prompt the AI SDK builds from them, which merges
 * each run of tool messages into one.
 */
export function promptIndex(messages: readonly ModelMessage[], index: number): number {
  let at = -1
  for (let i = 0; i <= index && i < messages.length; i++)
    if (messages[i]!.role !== "tool" || messages[i - 1]?.role !== "tool") at++
  return at
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
