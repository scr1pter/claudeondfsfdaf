import { createHash } from "node:crypto"
import { asSchema, jsonSchema, type ModelMessage, type Tool } from "ai"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { ComputerScale } from "./scale"

type Input = {
  readonly sessionID: string
  readonly model: Provider.Model
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly options: Record<string, unknown>
  readonly config?: ConfigV1.Info
}

type Definition = Pick<Tool, "description" | "inputSchema" | "strict" | "providerOptions" | "inputExamples">
type Conversation = {
  definition?: Definition
  present: boolean
  readonly discard: Set<string>
}

/** This SDK implements server-side result clearing without changing signed conversation history. */
export function retainHistory(model: Pick<Provider.Model, "api">) {
  return model.api.npm === "@ai-sdk/anthropic"
}

/** Owned by the LLM service, so definition snapshots cannot outlive its conversation state. */
export function make() {
  const conversations = new Map<string, Conversation>()
  const prepare = (input: Input) => {
    if (!retainHistory(input.model)) return input
    const names = toolNames(input.messages)
    const computer = input.tools.computer
    // Titles and summaries share the root session ID but do not replay its tool history or change its tools.
    if (!computer && !names.includes("computer")) return input
    const previous = conversations.get(input.sessionID)
    const current: Conversation = previous ?? { present: !!computer, discard: new Set<string>() }

    // After a reload the old definition is unknowable. A disabled tool must also stay absent. Drop only the
    // old signed blocks at that boundary; later responses under the stable definition retain their thinking.
    if (!previous || current.present !== !!computer) {
      for (const message of input.messages) {
        if (message.role !== "assistant" || typeof message.content === "string") continue
        for (const part of message.content) {
          const fingerprint = signedReasoning(part)
          if (fingerprint) current.discard.add(fingerprint)
        }
      }
    }
    current.present = !!computer
    if (computer && !current.definition)
      current.definition = {
        description: computer.description,
        inputSchema: jsonSchema(structuredClone(asSchema(computer.inputSchema).jsonSchema)),
        strict: computer.strict,
        providerOptions: structuredClone(computer.providerOptions),
        inputExamples: structuredClone(computer.inputExamples),
      }
    conversations.set(input.sessionID, current)
    const tools = computer ? { ...input.tools, computer: { ...computer, ...current.definition } } : input.tools
    const messages = current.discard.size
      ? input.messages.flatMap((message): ModelMessage[] => {
          if (message.role !== "assistant" || typeof message.content === "string") return [message]
          const content = message.content.filter((part) => {
            const fingerprint = signedReasoning(part)
            return !fingerprint || !current.discard.has(fingerprint)
          })
          return content.length ? [{ ...message, content }] : []
        })
      : input.messages
    return { messages, tools, options: clearing(input) }
  }
  return { prepare, forget: (sessionID: string) => conversations.delete(sessionID) }
}

/** Both Anthropic runtimes clear old results on the server; native calls do not initialize the generic snapshot. */
export function clearing(input: Omit<Input, "sessionID">): Record<string, unknown> {
  if (!retainHistory(input.model)) return input.options
  const names = toolNames(input.messages)
  if (!input.tools.computer && !names.includes("computer")) return input.options
  const context = isRecord(input.options.contextManagement) ? input.options.contextManagement : {}
  const edits = Array.isArray(context.edits)
    ? context.edits.filter((edit) => !isRecord(edit) || edit.type !== "clear_tool_uses_20250919")
    : []
  const plan = ComputerScale.plan(input.model, input.config)
  return {
    ...input.options,
    contextManagement: {
      ...context,
      edits: [
        ...edits,
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: plan.keep + plan.batch },
          keep: { type: "tool_uses", value: plan.keep },
          clearToolInputs: false,
          excludeTools: [...new Set([...Object.keys(input.tools), ...names])]
            .filter((name) => name !== "computer")
            .sort(),
        },
      ],
    },
  }
}

function toolNames(messages: ModelMessage[]) {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) =>
          part.type === "tool-call" || part.type === "tool-result" ? [part.toolName] : [],
        ),
  )
}

function signedReasoning(part: unknown) {
  if (!isRecord(part) || part.type !== "reasoning") return undefined
  const metadata = isRecord(part.providerOptions)
    ? part.providerOptions
    : isRecord(part.providerMetadata)
      ? part.providerMetadata
      : undefined
  if (!metadata) return undefined
  const signed = Object.values(metadata).find(
    (value) => isRecord(value) && (typeof value.signature === "string" || typeof value.redactedData === "string"),
  )
  return isRecord(signed)
    ? createHash("sha256")
        .update(JSON.stringify([part.text, signed.signature, signed.redactedData]))
        .digest("hex")
    : undefined
}

export * as ComputerGeneric from "./generic"
