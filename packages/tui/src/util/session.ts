import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Session } from "@vectordevai/sdk/v2"
import { Locale } from "./locale"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function isInternalSession(session: Pick<Session, "internal" | "title"> | undefined) {
  return Boolean(
    session?.internal ||
      session?.title.startsWith("Vector Tool · ") ||
      session?.title.startsWith("Vectorscope review · ") ||
      // Before Vectorscope had its name, the desktop titled reviewers "Vector review · #12 · review" (1.99.8) or
      // "Vecbot review · #12 · review", and `vector review` put the seven-character commit in the middle.
      /^(Vector|Vecbot) review · (#\d+|[0-9a-f]{7}) · (review|security|verify)$/.test(session?.title ?? ""),
  )
}

// Helpers are absent from list snapshots after reconnect. Resolve an unknown session before showing any attention
// surface; a failed lookup cannot prove that it is a user session. Known sessions keep synchronous notification order.
export function notifyVisibleSession(input: {
  sessionID?: string
  cached: (sessionID: string) => Session | undefined
  read: (sessionID: string) => Promise<Session | undefined>
  show: (session: Session | undefined) => void
}) {
  if (!input.sessionID) return input.show(undefined)
  const cached = input.cached(input.sessionID)
  if (cached) {
    if (!isInternalSession(cached)) input.show(cached)
    return
  }
  return input
    .read(input.sessionID)
    .then((session) => {
      if (session && !isInternalSession(session)) input.show(session)
    })
    .catch(() => undefined)
}

type Spend = Pick<
  Session,
  | "internal"
  | "title"
  | "cost"
  | "unpricedSteps"
  | "codiumSteps"
  | "tokensOwnOnly"
  | "subagentTokensOwnOnly"
  | "subagentCost"
  | "subagentUnpricedSteps"
  | "subagentCodiumSteps"
  | "model"
  | "tokens"
  | "subagentTokens"
>

// What a session delegated, as sidebar lines. The backend keeps it in subagentCost and subagentTokens, Vector's helpers
// included, so it is split by the session's children: the helpers among them and the subagents (the rest). Until the
// children are read the line cannot say which of the two spent it.
export function delegatedSpendLines(session: Spend | undefined, children: readonly Spend[] | undefined) {
  if (
    !session ||
    !(
      session.subagentCost ||
      session.subagentUnpricedSteps ||
      session.subagentCodiumSteps ||
      tokenCount(session.subagentTokens)
    )
  )
    return []
  const legacy =
    CodiumUsage.hasCodium({ subagentCodiumSteps: session.subagentCodiumSteps }, [], children ?? []) &&
    session.subagentTokensOwnOnly !== true
  const known = (children ?? []).map((child) => Locale.sessionSpend(child))
  const codium = legacy
    ? Math.max(
        1,
        known.reduce((sum, child) => sum + child.codium, 0),
      )
    : (session.subagentCodiumSteps ?? 0)
  const ownUnknown = Math.max(
    session.subagentTokensOwnOnly !== true
      ? 0
      : Math.max(0, (session.subagentUnpricedSteps ?? 0) - (session.subagentCodiumSteps ?? 0)),
    known.reduce((sum, child) => sum + Math.max(0, child.unpriced - child.codium), 0),
  )
  const total = {
    cost: session.subagentCost ?? 0,
    unpriced: legacy ? codium + ownUnknown : (session.subagentUnpricedSteps ?? 0),
    codium,
    tokens: session.subagentTokensOwnOnly === true ? tokenCount(session.subagentTokens) : 0,
  }
  if (!children) return [spendLine(total, "by subagents or Vector's helpers")]
  const helpers = children.filter(isInternalSession).reduce(
    (sum, child) => {
      const spend = Locale.sessionSpend(child)
      return {
        cost: sum.cost + spend.cost,
        unpriced: sum.unpriced + spend.unpriced,
        codium: sum.codium + spend.codium,
        tokens:
          sum.tokens +
          (child.tokensOwnOnly === true ? tokenCount(child.tokens) : 0) +
          (child.subagentTokensOwnOnly === true ? tokenCount(child.subagentTokens) : 0),
      }
    },
    { cost: 0, unpriced: 0, codium: 0, tokens: 0 },
  )
  const rest = Math.max(0, total.cost - helpers.cost)
  const subagents = {
    // Float sums of the same steps can differ in the last bits; a remainder below a millionth of a cent is nothing.
    cost: rest < 1e-8 ? 0 : rest,
    unpriced: Math.max(0, total.unpriced - helpers.unpriced),
    codium: Math.max(0, total.codium - helpers.codium),
    tokens: Math.max(0, total.tokens - helpers.tokens),
  }
  return [
    ...(subagents.cost || subagents.unpriced || subagents.tokens || subagents.codium
      ? [spendLine(subagents, "by subagents")]
      : []),
    ...(helpers.cost || helpers.unpriced || helpers.tokens || helpers.codium
      ? [spendLine(helpers, "by Vector's helpers")]
      : []),
  ]
}

function spendLine(spend: { cost: number; unpriced: number; tokens: number; codium: number }, by: string) {
  const tokens = spend.tokens ? ` · ${Locale.number(spend.tokens)} tokens` : ""
  return `${Locale.spend(spend.cost, spend.unpriced, spend.codium)}${tokens} ${by}`
}

function tokenCount(tokens: Session["tokens"]) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
