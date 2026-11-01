// Reads provider-reported token usage and the recorded charge off assistant
// messages. Charges may use catalog rates or provider billing metadata. Nothing
// here estimates from character counts, so a run whose provider reported no
// usage yields undefined rather than a zero that would read as "free".
import { addUsage, emptyUsage, totalTokens, type TokenUsage, type VariantEvidence } from "./economics-types"
import { Billing } from "@vectordevai/schema/billing"

// Structural subset of the SDK's AssistantMessage. Declared locally so this
// module does not depend on generated SDK types that change shape on
// regeneration; any real AssistantMessage satisfies it.
export type UsageBearingMessage = {
  role?: string
  providerID?: string
  billing?: string
  modelID?: string
  variant?: string
  cost?: number
  // A step of this message ran on a model with no listed price, so its cost leaves that step out.
  unpriced?: boolean
  // Copied in by a fork; the original session already measured it.
  forked?: boolean
  // Why the reply ended early, when it did. Only a refusal before any response proves an unmeasured reply was free.
  error?: unknown
  // Present only when the caller has the full transcript parts, so an empty array proves no content streamed.
  parts?: readonly { type?: string }[]
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export type MeasuredUsage = {
  codium?: true
  usage: TokenUsage
  // Absent when any measured message ran unpriced or lacks its charge: what the rest cost is not what the run cost.
  costUsd?: number
  // A reply stopped or failed before reporting any usage, so costUsd is only the known part of what the run cost.
  partial?: true
  provider?: string
  model?: string
  mixedModels?: boolean
  variant?: VariantEvidence
  messageCount: number
}

export type SessionSpend = {
  codiumSteps?: number
  subagentCodiumSteps?: number
  cost?: number
  unpricedSteps?: number
  subagentCost?: number
  subagentUnpricedSteps?: number
}

// Session totals include ancillary requests, whose tokens and model do not belong to the main assistant's sample.
// The engine records an unmeasured reply as no spend, so a partial measurement leaves this a known subtotal too.
export function totalSessionCost(spend: SessionSpend | undefined, measuredCost: number | undefined) {
  if (!spend || spend.unpricedSteps || spend.subagentUnpricedSteps) return undefined
  if (measuredCost === undefined || !Number.isFinite(measuredCost)) return undefined
  if (typeof spend.cost !== "number" || !Number.isFinite(spend.cost) || spend.cost < 0) return undefined
  if (spend.cost + 1e-9 < measuredCost) return undefined
  const subagents = spend.subagentCost ?? 0
  if (!Number.isFinite(subagents) || subagents < 0) return undefined
  const total = spend.cost + subagents
  return Number.isFinite(total) ? total : undefined
}

const finite = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0

function usageOf(message: UsageBearingMessage): TokenUsage {
  return {
    input: finite(message.tokens?.input),
    output: finite(message.tokens?.output),
    reasoning: finite(message.tokens?.reasoning),
    cacheRead: finite(message.tokens?.cache?.read),
    cacheWrite: finite(message.tokens?.cache?.write),
  }
}

// Sums usage across every assistant message in a session. Returns undefined
// when nothing reported usage, so callers can render "not measured" instead of
// a fabricated zero. Attribute the total to a model only when every observed
// attempt used that same provider/model; missing usage cannot prove an earlier attempt was free.
export function measureUsage(messages: readonly UsageBearingMessage[]): MeasuredUsage | undefined {
  const assistant = messages.filter((message) => message.role === "assistant" && !message.forked)
  if (!assistant.length) return undefined

  const measured = assistant.filter((message) => totalTokens(usageOf(message)) > 0)
  if (!measured.length) return undefined

  // A positive recorded charge remains measured spend without token counters. A zero-cost attempt without usage
  // cannot establish free execution unless the provider refused it, so it leaves only a known part of the total.
  const reported = (message: UsageBearingMessage) =>
    totalTokens(usageOf(message)) > 0 || message.unpriced || (typeof message.cost === "number" && message.cost !== 0)
  const accounted = assistant.filter(reported)
  const unmeasured = assistant.some((message) => !reported(message) && !refused(message))
  const costs = accounted.map((message) => message.cost)
  const costUsd =
    accounted.some((message) => message.unpriced) ||
    costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      ? undefined
      : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  const first = measured[0]
  const identities = new Set(
    assistant
      .filter((message) => message.providerID && message.modelID)
      .map((message) => JSON.stringify([message.providerID, message.modelID])),
  )
  const attributable =
    !!first.providerID &&
    !!first.modelID &&
    assistant.every((message) => message.providerID === first.providerID && message.modelID === first.modelID)
  // Include observed attempts without reported usage: a later failure on another preset cannot qualify
  // the earlier preset's paid history. Forked history remains excluded, and absent names stay unknown.
  const configured = assistant.filter(
    (message) => message.providerID === first.providerID && message.modelID === first.modelID,
  )
  const variants = new Set(
    configured
      .map((message) => message.variant)
      .filter((variant): variant is string => typeof variant === "string" && variant.length > 0),
  )
  const variant: VariantEvidence | undefined =
    variants.size > 1
      ? { kind: "mixed" }
      : variants.size === 1 && configured.every((message) => message.variant === first.variant)
        ? { kind: "named", name: first.variant! }
        : undefined
  return {
    usage: measured.map(usageOf).reduce(addUsage, emptyUsage),
    ...(assistant.some((message) => Billing.of(message)) ? { codium: true as const } : {}),
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    ...(unmeasured ? { partial: true as const } : {}),
    provider: attributable ? first.providerID : undefined,
    model: attributable ? first.modelID : undefined,
    mixedModels: identities.size > 1 ? true : undefined,
    variant: attributable ? variant : undefined,
    messageCount: measured.length,
  }
}

// The provider refused the request instead of running it: an HTTP client error, rejected credentials, a prompt over
// the context window, or Vector's free-model limit. None is billed, so that reply's missing usage is a real zero.
// A stop, a network failure or a server error can come after the provider started work, so those stay unknown.
// A later rejected retry can follow an attempt the provider billed and dropped mid-stream; only a known empty
// transcript proves a refusal. Any part counts: through the AI SDK the engine writes step-start as soon as the
// provider's stream begins, so an attempt dropped before its first token can leave only that part behind.
function refused(message: UsageBearingMessage) {
  if (!message.parts || message.parts.length) return false
  const error = message.error
  if (!error || typeof error !== "object" || !("name" in error)) return false
  if (["ProviderAuthError", "ContextOverflowError", "FreeModelsLimitError"].includes(String(error.name))) return true
  // The engine sets a status only from the HTTP response, never for a failure inside a stream that had started.
  const status =
    error.name === "APIError" &&
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "statusCode" in error.data
      ? error.data.statusCode
      : undefined
  // A request timeout (408) or a proxy's record of the client closing the connection (499) can come after the
  // provider started work, so neither proves the reply was free.
  return typeof status === "number" && status >= 400 && status < 499 && status !== 408
}
