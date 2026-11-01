import { helperLabel } from "./internal-sessions"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { Billing } from "@vectordevai/schema/billing"

// A session's recorded cost, said honestly. A step on a model that lists no price adds nothing to the cost, so a
// total that includes such steps is only a lower bound, and one made of nothing else is unknown rather than $0.00.
export function formatSessionCost(input: {
  cost: number | undefined
  unpricedSteps: number | undefined
  codiumSteps?: number
  format: (value: number) => string
  t: (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) => string
}) {
  const cost = input.format(input.cost ?? 0)
  const unknown = CodiumUsage.ownUnpricedSteps(input.unpricedSteps, input.codiumSteps)
  const own = unknown
    ? input.t(input.cost ? "session.cost.partial" : "session.cost.unknown", { cost })
    : input.codiumSteps && !input.cost
      ? undefined
      : cost
  return CodiumUsage.withCodium(own, input.codiumSteps)
}

// What a task cost: the session's own steps plus everything its subagents spent, which the backend keeps apart.
export function sessionSpend(
  info: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
) {
  const legacy = legacyCodium(info, messages, children)
  const codiumSteps = legacy ? 1 : (info?.codiumSteps ?? 0) + (info?.subagentCodiumSteps ?? 0)
  return {
    cost: (info?.cost ?? 0) + (info?.subagentCost ?? 0),
    // Old engines cannot distinguish Codium from own unpriced work. Preserve their dollars, hiding mixed tokens.
    unpricedSteps: legacy ? codiumSteps : (info?.unpricedSteps ?? 0) + (info?.subagentUnpricedSteps ?? 0),
    codiumSteps,
  }
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

type Spend = {
  internal?: string
  cost?: number
  unpricedSteps?: number
  codiumSteps?: number
  subagentCost?: number
  subagentUnpricedSteps?: number
  subagentCodiumSteps?: number
  model?: { providerID?: string }
  tokens?: Tokens
  subagentTokens?: Tokens
}

type BillingMessage = { role?: string; billing?: string; providerID?: string; model?: { providerID?: string } }

/** An older engine's totals cannot separate Codium tokens, so never display those totals. */
export function legacyCodium(
  info: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
) {
  if (children.some((child) => legacyCodium(child))) return true
  return (
    info?.codiumSteps === undefined &&
    info?.subagentCodiumSteps === undefined &&
    (Boolean(info && Billing.of(info)) ||
      messages.some((message) => message.role === "assistant" && Billing.of(message)))
  )
}

function tokenCount(tokens: Tokens | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// The tokens a task used: the session's own plus what its subagents and Vector's helpers used for it.
export function sessionTokens(
  info: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
) {
  if (legacyCodium(info, messages, children)) return 0
  return tokenCount(info?.tokens) + tokenCount(info?.subagentTokens)
}

export function compactTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

// What a session delegated, as the backend keeps it in subagentCost and subagentTokens, split into the Vector helpers
// that worked for it (named, from its helper child sessions) and its subagents (the rest).
export function delegatedSpend(
  info: Spend | undefined,
  children: readonly Spend[],
  messages: readonly BillingMessage[] = [],
) {
  const legacy = legacyCodium(info, messages) || children.some((child) => legacyCodium(child))
  const helpers = [
    ...children
      .reduce((groups, child) => {
        if (!child.internal) return groups
        const label = helperLabel(child.internal)
        const current = groups.get(label) ?? { label, cost: 0, unpricedSteps: 0, codiumSteps: 0, tokens: 0 }
        const spend = sessionSpend(child)
        return groups.set(label, {
          label,
          cost: current.cost + spend.cost,
          unpricedSteps: current.unpricedSteps + spend.unpricedSteps,
          codiumSteps: current.codiumSteps + spend.codiumSteps,
          tokens: current.tokens + sessionTokens(child),
        })
      }, new Map<string, { label: string; cost: number; unpricedSteps: number; codiumSteps: number; tokens: number }>())
      .values(),
  ].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label))
  const rest = {
    // Float sums of the same steps can differ in the last bits; a remainder below a millionth of a cent is nothing.
    cost: Math.max(0, (info?.subagentCost ?? 0) - helpers.reduce((total, helper) => total + helper.cost, 0)),
    unpricedSteps: Math.max(
      0,
      (info?.subagentUnpricedSteps ?? 0) - helpers.reduce((total, helper) => total + helper.unpricedSteps, 0),
    ),
    codiumSteps: Math.max(
      0,
      (info?.subagentCodiumSteps ?? 0) - helpers.reduce((total, helper) => total + helper.codiumSteps, 0),
    ),
    tokens: Math.max(0, tokenCount(info?.subagentTokens) - helpers.reduce((total, helper) => total + helper.tokens, 0)),
  }
  const subagents = {
    ...rest,
    cost: rest.cost < 1e-8 ? 0 : rest.cost,
    ...(legacy && (rest.tokens || rest.unpricedSteps || rest.cost)
      ? { tokens: 0, unpricedSteps: 1, codiumSteps: 1 }
      : {}),
  }
  return {
    helpers,
    subagents:
      subagents.cost || subagents.unpricedSteps || subagents.tokens || subagents.codiumSteps ? subagents : undefined,
  }
}
