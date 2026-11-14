import { Effect } from "effect"
import { LLMEvent, type ToolCallPart, type ToolContent, type ToolResultPart } from "../../schema"
import { ProviderShared } from "../shared"

const BATCH_FAILURE = "Not executed: an earlier computer action in this turn failed."

/** The wire member and original input survive engine normalization and error synthesis. */
export function call(part: ToolCallPart) {
  const metadata = part.providerMetadata?.anthropic
  if (metadata?.toolset_name === "computer" && typeof metadata.member === "string")
    return { member: metadata.member, input: metadata.input ?? {} }
  if (part.name !== "computer" || !ProviderShared.isRecord(part.input) || typeof part.input.member !== "string")
    return undefined
  return {
    member: part.input.member,
    input: Object.fromEntries(Object.entries(part.input).filter(([key]) => key !== "member")),
  }
}

export const event = Effect.fn("AnthropicComputer.event")(function* (item: LLMEvent, initialInput = false) {
  if (item.type !== "tool-call" || item.providerMetadata?.anthropic?.toolset_name !== "computer") return item
  const metadata = item.providerMetadata.anthropic
  const input = initialInput ? metadata.input : item.input
  if (!ProviderShared.isRecord(input) || typeof metadata.member !== "string" || !metadata.member)
    return yield* ProviderShared.eventError(
      "anthropic-messages",
      "Anthropic computer toolset input must be an object with a member name",
    )
  return LLMEvent.toolCall({
    ...item,
    name: "computer",
    input: { ...input, member: metadata.member },
    providerMetadata: { ...item.providerMetadata, anthropic: { ...metadata, input } },
  })
})

/** Native runtime outputs retain the engine's structure; replay also accepts canonical content. */
export function content(part: ToolResultPart): ReadonlyArray<ToolContent> {
  if (part.result.type === "content") {
    return [
      ...part.result.value.filter((item) => item.type === "file"),
      ...part.result.value.filter((item) => item.type === "text"),
    ]
  }
  const value = part.result.value
  if (!ProviderShared.isRecord(value) || typeof value.output !== "string")
    return [{ type: "text", text: ProviderShared.toolResultText(part) }]
  const attachments = Array.isArray(value.attachments) ? value.attachments : []
  return [
    ...attachments.flatMap((attachment): ToolContent[] =>
      ProviderShared.isRecord(attachment) && typeof attachment.url === "string" && typeof attachment.mime === "string"
        ? [{ type: "file", uri: attachment.url, mime: attachment.mime }]
        : [],
    ),
    { type: "text", text: value.output },
  ]
}

export function failed(part: ToolResultPart) {
  const value = part.result.value
  const metadata =
    ProviderShared.isRecord(value) && ProviderShared.isRecord(value.metadata) ? value.metadata : undefined
  return (
    part.providerMetadata?.anthropic?.computerDeclined === true ||
    part.providerMetadata?.anthropic?.computerError === true ||
    typeof metadata?.code === "string" ||
    content(part).some((item) => item.type === "text" && item.text.includes(BATCH_FAILURE))
  )
}

export * as AnthropicComputer from "./anthropic-computer"
