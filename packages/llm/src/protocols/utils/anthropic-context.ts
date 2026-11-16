import { Effect, Schema } from "effect"
import { HttpOptions, LLMRequest } from "../../schema"
import { ProviderShared } from "../shared"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ToolUses = Schema.Struct({ type: Schema.Literal("tool_uses"), value: Count })
const InputTokens = Schema.Struct({ type: Schema.Literal("input_tokens"), value: Count })
const Trigger = Schema.Union([ToolUses, InputTokens])
const Input = Schema.Struct({
  edits: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("clear_tool_uses_20250919"),
      trigger: Schema.optional(Trigger),
      keep: Schema.optional(ToolUses),
      clearAtLeast: Schema.optional(InputTokens),
      clearToolInputs: Schema.optional(Schema.Boolean),
      excludeTools: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

export const Body = Schema.Struct({
  edits: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("clear_tool_uses_20250919"),
      trigger: Schema.optional(Trigger),
      keep: Schema.optional(ToolUses),
      clear_at_least: Schema.optional(InputTokens),
      clear_tool_inputs: Schema.optional(Schema.Boolean),
      exclude_tools: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

export const lower = Effect.fn("AnthropicContext.lower")(function* (request: LLMRequest) {
  const value = request.providerOptions?.anthropic?.contextManagement
  if (value === undefined) return undefined
  const input = yield* Schema.decodeUnknownEffect(Input)(value).pipe(
    Effect.mapError(() =>
      ProviderShared.invalidRequest("Anthropic context management requires valid clear_tool_uses_20250919 edits"),
    ),
  )
  return {
    edits: input.edits.map((edit) => ({
      type: edit.type,
      trigger: edit.trigger,
      keep: edit.keep,
      clear_at_least: edit.clearAtLeast,
      clear_tool_inputs: edit.clearToolInputs,
      exclude_tools: edit.excludeTools,
    })),
  }
})

/** Merge after request overrides so a caller's beta list cannot remove a required protocol beta. */
export function withBeta(request: LLMRequest) {
  const headers = Object.entries(request.http?.headers ?? {})
  const betas = headers
    .filter(([key]) => key.toLowerCase() === "anthropic-beta")
    .flatMap(([, value]) =>
      value
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean),
    )
  return LLMRequest.update(request, {
    http: new HttpOptions({
      ...request.http,
      headers: {
        ...Object.fromEntries(headers.filter(([key]) => key.toLowerCase() !== "anthropic-beta")),
        "anthropic-beta": [...new Set([...betas, "context-management-2025-06-27"])].join(","),
      },
    }),
  })
}

export * as AnthropicContext from "./anthropic-context"
