import { prepareToolsAndToolChoice } from "ai/internal"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import { openRouterModelRouting } from "@vectordevai/core/free-model-catalog"
import { openRouterOnlineVariant } from "@vectordevai/core/review/privacy"
import { MAX_STEPS_PROMPT } from "@vectordevai/core/session/runner/max-steps"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { LLMRequestPrep } from "./llm/request"

interface Input {
  prepared: LLMRequestPrep.Prepared
  model: Provider.Model
  conditional?: { maxSerializedTextChars: number; text: string }
}

// These review routes share the normalized text/function-tool request. Workflow and custom adapters may append
// server-side context. An unknown adapter must not certify a smaller, locally visible part of its request.
const TEXT_ADAPTERS = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/github-copilot",
  "@ai-sdk/anthropic",
  "@ai-sdk/google-vertex/anthropic",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/mantle",
])
const REMOTE_CONTEXT = new Set([
  "cachedcontent",
  "previousresponseid",
  "conversation",
  "conversationid",
  "threadid",
  "assistantid",
  "promptid",
  "prompt",
  "body",
  "extrabody",
  "model",
  "models",
  "route",
  "preset",
  "plugins",
  "websearchoptions",
  "websearch",
  "googlesearch",
  "googlesearchretrieval",
  "grounding",
  "urlcontext",
  "filesearch",
  "filestores",
  "fileuri",
  "fileid",
  "vectorstoreids",
  "mcpservers",
  "container",
  "containerid",
  "deferredtools",
  "retrievalconfig",
])

// Connection settings are not model input. In particular, never inspect headers, auth or a gateway's BYOK map.
// This filter is only for transport options; a JSON tool schema may legitimately have a property called "password".
const CONNECTION =
  /^(?:headers?|authorization|auth|oauth|credentials?|apikey|accesskeyid|secretaccesskey|accesstoken|refreshtoken|token|password|secret|byok|baseurl|fetch|dispatcher|agent)$/i

function optionData(options: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (value == null || typeof value === "boolean" || typeof value === "string") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(visit)
    if (
      typeof value === "object" &&
      (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype)
    )
      return optionData(value as Record<string, unknown>)
    throw new Error("Unrepresentable model options")
  }
  const pairs: [string, unknown][] = []
  for (const key of Object.keys(options)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase()
    if (CONNECTION.test(normalized)) continue
    const property = Object.getOwnPropertyDescriptor(options, key)
    if (!property || !("value" in property)) throw new Error("Unrepresentable model options")
    if (property.value != null && REMOTE_CONTEXT.has(normalized)) throw new Error("External context cannot be measured")
    pairs.push([key, visit(property.value)])
  }
  return Object.fromEntries(pairs)
}

// The structured review creates a new session with text input. The SDK lowers a plain user string into a text part.
// No attachment or external identifier can enter this projection. Cache transforms can mutate parts, so copy first.
function firstMessages(prepared: LLMRequestPrep.Prepared): ModelMessage[] | undefined {
  const messages: ModelMessage[] = []
  for (const [index, message] of prepared.messages.entries()) {
    if (message.role === "system") messages.push(structuredClone(message))
    else if (message.role === "user") {
      if (typeof message.content === "string")
        messages.push({ ...structuredClone(message), content: [{ type: "text", text: message.content }] })
      else if (message.content.every((part) => part.type === "text")) messages.push(structuredClone(message))
      else return undefined
    } else if (
      message.role === "assistant" &&
      index === prepared.messages.length - 1 &&
      message.content === MAX_STEPS_PROMPT
    ) {
      // The stock one-step agent appends exactly this instruction to its first request.
      messages.push({ role: "assistant", content: [{ type: "text", text: MAX_STEPS_PROMPT }] })
    } else return undefined
  }
  return messages.some((message) => message.role === "user") ? messages : undefined
}

function reserveCharacters(messages: ModelMessage[], bound: NonNullable<Input["conditional"]>): number | undefined {
  if (
    !bound.text ||
    ProviderTransform.sanitizeSurrogates(bound.text) !== bound.text ||
    !Number.isSafeInteger(bound.maxSerializedTextChars) ||
    bound.maxSerializedTextChars < 0
  )
    return undefined
  let matches = 0
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "text") continue
      const index = part.text.indexOf(bound.text)
      if (index < 0) continue
      if (++matches !== 1 || part.text.indexOf(bound.text, index + 1) !== -1) return undefined
    }
  }
  return matches === 1 ? Math.max(0, bound.maxSerializedTextChars - JSON.stringify(bound.text).length) : undefined
}

/** Estimated first-turn tokens from the normalized text request. No provider code, transport, or tool is invoked. */
export function reviewRequestProjection(
  input: Input,
): Effect.Effect<{ promptTokens: number; cached?: boolean } | undefined> {
  return Effect.tryPromise(async () => {
    const { model, prepared } = input
    if (!TEXT_ADAPTERS.has(model.api.npm)) return undefined
    const ids = [model.api.id, model.id]
    // A compatible gateway or local relay can forward these IDs without identifying OpenRouter in its own URL.
    if (ids.some((id) => openRouterOnlineVariant(id) || openRouterModelRouting(undefined, id).length > 0))
      return undefined
    // Search-preview and deep-research models attach hosted results without an ordinary client-side tool definition.
    if (
      ids.some((id) =>
        /(?:^|\/)(?:gpt-(?:4o(?:-mini)?-search-preview|5-search-api)|o[34](?:-mini)?-deep-research)(?:$|[-:@])/i.test(
          id,
        ),
      )
    )
      return undefined
    const messages = firstMessages(prepared)
    if (!messages) return undefined
    const active = Object.keys(prepared.tools).filter((name) => name !== "invalid")
    if (active.some((name) => prepared.tools[name]?.type === "provider")) return undefined
    const options = optionData(prepared.params.options)
    const system = new Set(messages.filter((message) => message.role === "system").map((message) => message.content))
    if (
      options.instructions !== prepared.system.join("\n") &&
      prepared.system.some((text) => !system.has(text) && text !== options.instructions)
    )
      return undefined
    const selected = await prepareToolsAndToolChoice({
      tools: prepared.tools,
      toolChoice: ProviderTransform.toolChoice(model, options, "required"),
      activeTools: active,
    })
    const tools = []
    for (const item of selected.tools ?? []) {
      if (item.type !== "function" || item.inputSchema == null) return undefined
      const { type, inputSchema, ...definition } = item
      tools.push({ type, function: { ...definition, parameters: inputSchema } })
    }
    const normalizedMessages = ProviderTransform.message(messages, model, prepared.messageTransformOptions)
    const extra = input.conditional ? reserveCharacters(normalizedMessages, input.conditional) : 0
    if (extra === undefined) return undefined
    const { temperature, topP, topK, maxOutputTokens } = prepared.params
    // Use the prepared messages: system blocks are already messages, or the provider's OAuth instructions option.
    // The envelope includes the streaming and schema framing. Its UTF-16 JSON length is a local estimate, not a tokenizer.
    const body = JSON.stringify({
      model: model.api.id,
      messages: normalizedMessages,
      tools: selected.tools ? tools : undefined,
      tool_choice: selected.toolChoice,
      max_tokens: maxOutputTokens,
      temperature,
      top_p: topP,
      top_k: topK,
      providerOptions: ProviderTransform.providerOptions(model, options),
      stream: true,
      ...(model.api.npm === "@ai-sdk/openai-compatible" ? { stream_options: { include_usage: true } } : {}),
    })
    const chars = body.length + extra
    if (!Number.isSafeInteger(chars)) return undefined
    return { promptTokens: Math.ceil(chars / 3.5), cached: ProviderTransform.caches(model) }
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}
