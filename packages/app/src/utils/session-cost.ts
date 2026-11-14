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
): { cost: number; unpricedSteps: number; codiumSteps: number } {
  const legacy = legacyCodium(info, messages, children)
  const codiumSteps = legacy
    ? Math.max(1, (info?.codiumSteps ?? 0) + (info?.subagentCodiumSteps ?? 0))
    : (info?.codiumSteps ?? 0) + (info?.subagentCodiumSteps ?? 0)
  const knownOwn = legacy
    ? Math.max(
        messages.filter((message) => message.role === "assistant" && message.unpriced && !Billing.of(message)).length,
        info?.tokensOwnOnly === true ? CodiumUsage.ownUnpricedSteps(info.unpricedSteps, info.codiumSteps) : 0,
      ) +
      Math.max(
        info?.subagentTokensOwnOnly === true
          ? CodiumUsage.ownUnpricedSteps(info.subagentUnpricedSteps, info.subagentCodiumSteps)
          : 0,
        children.reduce((sum, child) => {
          const spend = sessionSpend(child)
          return sum + CodiumUsage.ownUnpricedSteps(spend.unpricedSteps, spend.codiumSteps)
        }, 0),
      )
    : 0
  return {
    cost: (info?.cost ?? 0) + (info?.subagentCost ?? 0),
    // Old engines cannot distinguish Codium from own unpriced work. Preserve their dollars, hiding mixed tokens.
    unpricedSteps: legacy ? codiumSteps + knownOwn : (info?.unpricedSteps ?? 0) + (info?.subagentUnpricedSteps ?? 0),
    codiumSteps,
  }
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

type Spend = {
  internal?: string
  cost?: number
  unpricedSteps?: number
  codiumSteps?: number
  tokensOwnOnly?: boolean
  subagentTokensOwnOnly?: boolean
  subagentCost?: number
  subagentUnpricedSteps?: number
  subagentCodiumSteps?: number
  model?: { providerID?: string }
  tokens?: Tokens
  subagentTokens?: Tokens
}

type BillingMessage = {
  role?: string
  billing?: string
  unpriced?: boolean
  tokens?: Tokens
  providerID?: string
  model?: { providerID?: string }
}

/** An older engine's totals cannot separate Codium tokens, so never display those totals. */
export function legacyCodium(
  info: Spend | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Spend[] = [],
) {
  return (
    CodiumUsage.hasCodium(info, messages, children) &&
    (info?.tokensOwnOnly !== true || info?.subagentTokensOwnOnly !== true)
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
): number | undefined {
  const ownMessages = messages.filter(
    (message) => message.role === "assistant" && Billing.hasOwnIdentity(message) && message.tokens,
  )
  const own =
    info?.tokensOwnOnly === true
      ? tokenCount(info.tokens)
      : ownMessages.reduce((sum, message) => sum + tokenCount(message.tokens), 0)
  const delegated =
    info?.subagentTokensOwnOnly === true
      ? tokenCount(info.subagentTokens)
      : children.reduce((sum, child) => sum + (sessionTokens(child) ?? 0), 0)
  const total = own + delegated
  return total > 0 || (info?.tokensOwnOnly === true && info?.subagentTokensOwnOnly === true) ? total : undefined
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
  const legacy =
    CodiumUsage.hasCodium({ subagentCodiumSteps: info?.subagentCodiumSteps }, [], children) &&
    info?.subagentTokensOwnOnly !== true
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
          tokens: current.tokens + (sessionTokens(child) ?? 0),
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
    tokens:
      info?.subagentTokensOwnOnly === true
        ? Math.max(0, tokenCount(info.subagentTokens) - helpers.reduce((total, helper) => total + helper.tokens, 0))
        : children.filter((child) => !child.internal).reduce((sum, child) => sum + (sessionTokens(child) ?? 0), 0),
  }
  const remainingCodium = Math.max(
    rest.codiumSteps,
    children.filter((child) => !child.internal).reduce((sum, child) => sum + sessionSpend(child).codiumSteps, 0),
  )
  const subagents = {
    ...rest,
    cost: rest.cost < 1e-8 ? 0 : rest.cost,
    ...(legacy && (rest.tokens || rest.unpricedSteps || rest.cost)
      ? {
          unpricedSteps:
            remainingCodium +
            children
              .filter((child) => !child.internal)
              .reduce((sum, child) => {
                const spend = sessionSpend(child)
                return sum + CodiumUsage.ownUnpricedSteps(spend.unpricedSteps, spend.codiumSteps)
              }, 0),
          codiumSteps: remainingCodium,
        }
      : {}),
  }
  return {
    helpers,
    subagents:
      subagents.cost || subagents.unpricedSteps || subagents.tokens || subagents.codiumSteps ? subagents : undefined,
  }
}
