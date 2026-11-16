import type { Provider } from "@/provider/provider"

export type Family = "openai" | "anthropic" | "gemini"
export type Tier = "best" | "great" | "good" | "reader"

// Only these model APIs are selected for the native wire. The runtime/auth/config gate still belongs to E9.
const OPENAI_NATIVE = new Set(["gpt-5.4", "gpt-5.5"])
const ANTHROPIC_NATIVE = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])

/** Use the actual API model id: a display/catalog alias does not change the provider's wire capabilities. */
export function native(model: Provider.Model): "openai" | "anthropic" | undefined {
  if (!model.capabilities.input.image) return undefined
  const id = model.api.id.toLowerCase()
  if (model.providerID === "openai" && model.api.npm === "@ai-sdk/openai" && OPENAI_NATIVE.has(id)) return "openai"
  if (
    model.providerID === "anthropic" &&
    model.api.npm === "@ai-sdk/anthropic" &&
    ANTHROPIC_NATIVE.has(id.replace(/5\.5$/, "5-5"))
  )
    return "anthropic"
  return undefined
}

export function family(model: Provider.Model): Family | undefined {
  const id = model.api.id.toLowerCase()
  if (
    model.api.npm === "@ai-sdk/google" ||
    model.api.npm === "@ai-sdk/google-vertex" ||
    /(?:^|[/.])gemini(?:-|$)/.test(id)
  )
    return "gemini"
  if (model.providerID === "anthropic" || /(?:^|[/.])claude(?:-|$)/.test(id)) return "anthropic"
  if (model.providerID === "openai" || /(?:^|[/.])(?:gpt-|o[134](?:-|$)|computer-use-preview)/.test(id)) return "openai"
  return undefined
}

export function tier(model: Provider.Model): Tier {
  if (!model.capabilities.input.image) return "reader"
  if (native(model)) return "best"
  return family(model) ? "great" : "good"
}

export function coords(model: Provider.Model): "pixels" | "grid1000" {
  return family(model) === "gemini" ? "grid1000" : "pixels"
}

export * as ComputerModels from "./models"
