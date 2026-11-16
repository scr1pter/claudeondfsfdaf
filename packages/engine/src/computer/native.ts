import type { ModelMessage, Tool } from "ai"
import { ComputerModels } from "./models"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { isRecord } from "@/util/record"

type Choice = "openai" | "anthropic" | false

export interface Input {
  readonly sessionID: string
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly tools: Record<string, Tool>
  readonly messages: readonly ModelMessage[]
  readonly config: ConfigV1.Info
  /** A validated user mention from stored message parts, never inferred from screen or model text. */
  readonly requested?: boolean
}

/** Runtime choice belongs to the conversation; history restores it after the engine restarts. */
export function make() {
  const choices = new Map<string, Choice>()
  return {
    wants(input: Input) {
      if (!input.tools.computer) return false
      const historical = history(input.messages)
      const previous = historical === false ? false : (choices.get(input.sessionID) ?? historical)
      const family = ComputerModels.native(input.model)
      const eligible =
        input.config.computer?.native_tools === "auto" &&
        family !== undefined &&
        LLMNativeRuntime.status(input).type === "supported"
      // Simply offering the generic tool on every desktop turn does not opt a conversation into this runtime.
      if (previous === undefined && !input.requested) return false
      const choice = previous === undefined ? (eligible ? family! : false) : previous
      const selected = choice !== false && eligible && choice === family
      // An unsupported model, changed auth, or the off switch returns to the generic wire permanently.
      choices.set(input.sessionID, selected ? choice : false)
      return selected
    },
    forget(sessionID: string) {
      choices.delete(sessionID)
    },
  }
}

function history(messages: readonly ModelMessage[]): Choice | undefined {
  let choice: Choice | undefined
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "computer") continue
      const value = part as unknown as Record<string, unknown>
      const metadata = isRecord(value.providerMetadata) ? value.providerMetadata : value.providerOptions
      const openai = isRecord(metadata) && isRecord(metadata.openai) ? metadata.openai : undefined
      const anthropic = isRecord(metadata) && isRecord(metadata.anthropic) ? metadata.anthropic : undefined
      const next = openai?.computerCall ? "openai" : anthropic?.toolset_name === "computer" ? "anthropic" : false
      if (next === false || (choice !== undefined && choice !== next)) return false
      choice = next
    }
  }
  return choice
}

export * as ComputerNative from "./native"
