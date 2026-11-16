import { Effect, Option, Schema } from "effect"
import type { ProviderMetadata, ToolCallPart, ToolFileContent, ToolResultPart } from "../../schema"
import { ProviderShared } from "../shared"

const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Action = Schema.Record(Schema.String, Schema.Unknown)
export const SafetyCheck = Schema.Struct({
  id: ID,
  code: Schema.String.check(Schema.isMaxLength(256)),
  message: Schema.String.check(Schema.isMaxLength(1000)),
})
export type SafetyCheck = typeof SafetyCheck.Type

export const Call = Schema.Struct({
  type: Schema.Literal("computer_call"),
  id: ID,
  call_id: ID,
  status: Schema.optional(Schema.String),
  action: Schema.optional(Action),
  actions: Schema.optional(Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(10))),
  pending_safety_checks: Schema.optional(Schema.Array(SafetyCheck).check(Schema.isMaxLength(10))),
})
export type Call = typeof Call.Type

export const Output = Schema.Struct({
  type: Schema.Literal("computer_call_output"),
  call_id: ID,
  output: Schema.Struct({
    type: Schema.Literal("computer_screenshot"),
    image_url: Schema.String,
    detail: Schema.Literal("original"),
  }),
  acknowledged_safety_checks: Schema.Array(SafetyCheck),
})

// A computer output always contains an image, including after Stop or history pruning.
export const PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO4efPmfwAIpQOLvDzzewAAAABJRU5ErkJggg=="

export const parse = Effect.fn("OpenAIComputer.parse")(function* (value: unknown) {
  const call = yield* Schema.decodeUnknownEffect(Call)(value).pipe(
    Effect.mapError(() => ProviderShared.eventError("openai-responses", "Invalid native computer call")),
  )
  if (call.action && call.actions)
    return yield* ProviderShared.eventError("openai-responses", "A computer call cannot contain action and actions")
  const actions = (call.actions ?? (call.action ? [call.action] : [])).map(mapAction)
  if (!actions.length || actions.some((action) => action === undefined))
    return yield* ProviderShared.eventError("openai-responses", "Unsupported native computer action")
  return { call, input: { actions, safety_checks: call.pending_safety_checks ?? [] } }
})

export function call(part: ToolCallPart): Call | undefined {
  if (part.name !== "computer") return undefined
  const decoded = Schema.decodeUnknownOption(Call)(part.providerMetadata?.openai?.computerCall)
  return Option.isSome(decoded) && decoded.value.call_id === part.id ? decoded.value : undefined
}

export function reasoningID(part: ToolCallPart) {
  const value = part.providerMetadata?.openai?.reasoningItemId
  return typeof value === "string" ? value : undefined
}

/** Result metadata is copied by the engine; direct clients may retain the structured tool output. */
function resultMetadata(part: ToolResultPart): Record<string, unknown> | undefined {
  const direct = part.providerMetadata?.openai
  const value = part.result.value
  if (!ProviderShared.isRecord(value) || !ProviderShared.isRecord(value.metadata)) return direct
  const native = value.metadata.native
  return ProviderShared.isRecord(native) && native.provider === "openai" ? { ...native, ...direct } : direct
}

export function declined(part: ToolResultPart) {
  return resultMetadata(part)?.computerDeclined === true
}

export function acknowledged(part: ToolResultPart, original: Call): readonly SafetyCheck[] {
  const decoded = Schema.decodeUnknownOption(Schema.Array(SafetyCheck))(resultMetadata(part)?.acknowledgedSafetyChecks)
  if (Option.isNone(decoded)) return []
  // Only exact provider checks from the original call may be acknowledged.
  return (original.pending_safety_checks ?? []).filter((check) =>
    decoded.value.some(
      (answer) => answer.id === check.id && answer.code === check.code && answer.message === check.message,
    ),
  )
}

export function metadata(call: Call, reasoningItemId?: string): ProviderMetadata {
  return {
    openai: {
      itemId: call.id,
      callId: call.call_id,
      computerCall: call,
      ...(reasoningItemId ? { reasoningItemId } : {}),
    },
  }
}

export const result = Effect.fn("OpenAIComputer.result")(function* (part: ToolResultPart, original: Call) {
  const value = part.result.value
  const content = part.result.type === "content" ? part.result.value : undefined
  const structured = ProviderShared.isRecord(value) ? value : undefined
  const text = content
    ? content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
    : typeof value === "string"
      ? value
      : typeof structured?.output === "string"
        ? structured.output
        : typeof structured?.text === "string"
          ? structured.text
          : "The computer action returned no textual status."
  const images: ToolFileContent[] = content
    ? content.filter((item): item is ToolFileContent => item.type === "file" && item.mime.startsWith("image/"))
    : Array.isArray(structured?.attachments)
      ? structured.attachments.flatMap((attachment) =>
          ProviderShared.isRecord(attachment) &&
          typeof attachment.url === "string" &&
          typeof attachment.mime === "string" &&
          attachment.mime.startsWith("image/")
            ? [{ type: "file" as const, uri: attachment.url, mime: attachment.mime }]
            : [],
        )
      : []
  const last = images.at(-1)
  const image = last
    ? (yield* ProviderShared.validateToolFile("OpenAI Responses", last, new Set<string>(ProviderShared.IMAGE_MIMES)))
        .dataUrl
    : PLACEHOLDER
  return {
    output: {
      type: "computer_call_output" as const,
      call_id: original.call_id,
      output: { type: "computer_screenshot" as const, image_url: image, detail: "original" as const },
      acknowledged_safety_checks: acknowledged(part, original),
    },
    text,
  }
})

function mapAction(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const fields: Record<string, readonly string[]> = {
    click: ["x", "y", "button"],
    double_click: ["x", "y"],
    triple_click: ["x", "y"],
    move: ["x", "y"],
    drag: ["path"],
    type: ["text"],
    keypress: ["keys"],
    scroll: ["x", "y", "scroll_x", "scroll_y"],
    wait: ["seconds"],
    screenshot: [],
    mouse_down: ["button"],
    mouse_up: ["button"],
  }
  const allowed = typeof input.type === "string" && Object.hasOwn(fields, input.type) ? fields[input.type] : undefined
  if (!allowed || Object.keys(input).some((key) => key !== "type" && !allowed.includes(key))) return undefined
  const point = () =>
    Number.isSafeInteger(input.x) && Number.isSafeInteger(input.y) ? { x: input.x, y: input.y } : undefined
  const position = point()
  switch (input.type) {
    case "click":
      if (!position || (input.button !== undefined && !["left", "right", "middle"].includes(String(input.button))))
        return undefined
      return {
        action: input.button === "right" ? "right_click" : input.button === "middle" ? "middle_click" : "click",
        ...position,
      }
    case "double_click":
    case "triple_click":
      return position ? { action: input.type, ...position } : undefined
    case "move":
      return position ? { action: "mouse_move", ...position } : undefined
    case "drag":
      if (!Array.isArray(input.path) || input.path.length < 2 || input.path.length > 50) return undefined
      if (
        !input.path.every(
          (point) => ProviderShared.isRecord(point) && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y),
        )
      )
        return undefined
      return { action: "drag", path: input.path.map((point) => ({ x: point.x, y: point.y })) }
    case "type":
      return typeof input.text === "string" && input.text.length > 0 && input.text.length <= 4000
        ? { action: "type", text: input.text }
        : undefined
    case "keypress":
      // Keep individual keys intact until the engine knows the actual desktop platform.
      return Array.isArray(input.keys) &&
        input.keys.length > 0 &&
        input.keys.length <= 8 &&
        input.keys.every((key) => typeof key === "string")
        ? { action: "key", keys: input.keys }
        : undefined
    case "scroll":
      if (!position || !Number.isSafeInteger(input.scroll_x) || !Number.isSafeInteger(input.scroll_y)) return undefined
      // Provider deltas are pixels. The engine must not silently reinterpret them as wheel ticks.
      return { action: "scroll", ...position, scroll_x: input.scroll_x, scroll_y: input.scroll_y }
    case "wait":
      return input.seconds === undefined ||
        (typeof input.seconds === "number" && input.seconds >= 0 && input.seconds <= 30)
        ? { action: "wait", seconds: input.seconds ?? 1 }
        : undefined
    case "screenshot":
      return { action: "screenshot" }
    case "mouse_down":
    case "mouse_up":
      return (input.button === undefined || input.button === "left") && input.x === undefined && input.y === undefined
        ? { action: input.type }
        : undefined
    default:
      return undefined
  }
}

export * as OpenAIComputer from "./openai-computer"
