import { Billing } from "@vectordevai/schema/billing"
import { Option, Schema } from "effect"
import { RunBudget } from "@vectordevai/schema/run-budget"

// What a desktop run reads from GET /api/session/:id to measure itself. The
// engine's JSON is untrusted, so every field is optional.
type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type EngineSessionResponse = {
  data?: {
    cost?: number
    tokens?: Tokens
    // What the subagents and Vector's helpers below the session spent, which cost and tokens leave out.
    unpricedSteps?: number
    subagentUnpricedSteps?: number
    codiumSteps?: number
    tokensOwnOnly?: boolean
    subagentTokensOwnOnly?: boolean
    subagentCodiumSteps?: number
    subagentCost?: number
    subagentTokens?: Tokens
    model?: { id?: string; providerID?: string }
  }
}

const SpendResponse = Schema.Struct({ data: RunBudget.Snapshot })

// What a session's work has cost so far: its own steps plus its subagents and helpers. Undefined when the engine
// did not say what the session itself cost.
export function sessionCost(data: EngineSessionResponse["data"]) {
  if (!Number.isFinite(data?.cost)) return undefined
  return (data?.cost ?? 0) + (Number.isFinite(data?.subagentCost) ? (data?.subagentCost ?? 0) : 0)
}

export function sessionTokens(data: EngineSessionResponse["data"]) {
  const own = tokenTotal(data?.tokens)
  // An older engine cannot separate positive Codium token totals. Zero before a fresh run is still a safe baseline.
  if (
    (data?.tokensOwnOnly !== true && (own ?? 0) > 0) ||
    (data?.subagentTokensOwnOnly !== true && (tokenTotal(data?.subagentTokens) ?? 0) > 0)
  )
    return undefined
  if (own === undefined) return undefined
  return own + (tokenTotal(data?.subagentTokens) ?? 0)
}

export function tokenTotal(tokens: Tokens | undefined) {
  if (!tokens) return undefined
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write]
  if (!values.some((value) => typeof value === "number" && Number.isFinite(value))) return undefined
  return values.reduce<number>(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  )
}

export function usageDelta(before: number | undefined, after: number | undefined) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined
  return Math.max((after ?? 0) - (before ?? 0), 0)
}

// The engine's spend guard snapshot for the root run of `sessionId`: the run in
// progress, else its last finished one. Undefined when the engine has none or
// cannot answer, which a caller treats as "no guard reading", never as zero.
export async function readSpend(get: (path: string) => Promise<unknown>, sessionId: string) {
  const response = await get(`/api/session/${encodeURIComponent(sessionId)}/spend`).catch(() => undefined)
  return Option.getOrUndefined(Schema.decodeUnknownOption(SpendResponse)(response))?.data
}

// The spend guard snapshot carries no run identity, so a reading equal in
// every field to one already seen is taken to be that same finished run, not a
// new one. Undefined means "no new reading".
export function newSpend(seen: RunBudget.Snapshot | undefined, next: RunBudget.Snapshot | undefined) {
  if (!seen || !next) return next
  return JSON.stringify(seen) === JSON.stringify(next) ? undefined : next
}

// A run's cost, from the best reading there is. The guard counts money as it
// is spent, subagents included, and a revert never lowers it, so a fully
// priced run trusts it. It is still floored at the session delta, because a run
// that drained more than once leaves only its last drain in the snapshot. A
// run with unpriced steps still preserves any positive known subtotal. When
// neither reading proves money was spent, its cost stays unknown rather than zero.
export function measuredCost(
  snapshot: RunBudget.Snapshot | undefined,
  before: number | undefined,
  after: number | undefined,
) {
  const delta = usageDelta(before, after)
  if (snapshot && snapshot.spentUsd > 0) return Math.max(snapshot.spentUsd, delta ?? 0)
  if (snapshot && snapshot.unpricedSteps === 0 && (snapshot.costKind === "priced" || (snapshot.codiumSteps ?? 0) > 0))
    return Math.max(snapshot.spentUsd, delta ?? 0)
  if (snapshot && snapshot.unpricedSteps > 0 && !delta) return undefined
  return delta
}

/** One launch's own usage and Codium presence, excluding earlier recurrences in the same session. */
export function measuredRun(
  snapshot: RunBudget.Snapshot | undefined,
  before: EngineSessionResponse["data"],
  after: EngineSessionResponse["data"],
) {
  const count = (data: EngineSessionResponse["data"]) =>
    data
      ? [data.codiumSteps, data.subagentCodiumSteps].reduce<number>(
          (total, value) => total + (Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0),
          0,
        )
      : undefined
  const legacy =
    after?.codiumSteps === undefined &&
    after?.subagentCodiumSteps === undefined &&
    Billing.of(after ?? {}) &&
    (usageDelta(tokenTotal(before?.tokens), tokenTotal(after?.tokens)) ?? 0) > 0
  const codium = (snapshot?.codiumSteps ?? 0) > 0 || (usageDelta(count(before), count(after)) ?? 0) > 0 || legacy
  // Session unknown counts include Codium; guard unknown counts already exclude it. Never subtract Codium twice.
  const ownUnknown = (data: EngineSessionResponse["data"]) =>
    data
      ? Math.max(
          0,
          [data.unpricedSteps, data.subagentUnpricedSteps].reduce<number>(
            (total, value) => total + (Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0),
            0,
          ) - (count(data) ?? 0),
        )
      : undefined
  const unknown = (snapshot?.unpricedSteps ?? 0) > 0 || (usageDelta(ownUnknown(before), ownUnknown(after)) ?? 0) > 0
  const measured = measuredCost(snapshot, sessionCost(before), sessionCost(after))
  const totalCostUsd = unknown && !measured ? undefined : measured
  const totalTokens = usageDelta(sessionTokens(before), sessionTokens(after))
  const costKind: RunBudget.CostKind = unknown
    ? "unknown"
    : (totalCostUsd ?? 0) > 0
      ? "priced"
      : codium && !totalTokens
        ? "codium"
        : snapshot?.costKind && snapshot.costKind !== "codium"
          ? snapshot.costKind
          : totalCostUsd === 0
            ? "free"
            : "unknown"
  return { totalCostUsd, totalTokens, costKind, ...(codium ? { billing: "codium" as const } : {}) }
}

// Folds one drain's guard reading into a run's total. Every drain of a session
// is its own guard run, so spend and step counts add up, and the latest drain's
// state stands for the run. A later Codium drain retains the preceding own billing kind.
export function combineSpend(total: RunBudget.Snapshot | undefined, drain: RunBudget.Snapshot | undefined) {
  if (!drain) return total
  if (!total) return drain
  return {
    ...drain,
    spentUsd: total.spentUsd + drain.spentUsd,
    steps: total.steps + drain.steps,
    unpricedSteps: total.unpricedSteps + drain.unpricedSteps,
    codiumSteps: (total.codiumSteps ?? 0) + (drain.codiumSteps ?? 0),
    costKind: drain.costKind === "codium" && total.costKind !== "codium" ? total.costKind : drain.costKind,
  }
}

// The measured cost an agent card shows. Two decimals like the engine's stop
// messages, and never "$0.00" for spend that was real but tiny.
export function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01"
  return `$${value.toFixed(2)}`
}
