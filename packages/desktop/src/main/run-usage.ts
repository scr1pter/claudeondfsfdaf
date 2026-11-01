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
    codiumSteps?: number
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
// run with unpriced steps falls back to the session delta, and when that shows
// nothing the cost is unknown rather than zero.
export function measuredCost(
  snapshot: RunBudget.Snapshot | undefined,
  before: number | undefined,
  after: number | undefined,
) {
  const delta = usageDelta(before, after)
  if (snapshot?.costKind === "priced" && snapshot.unpricedSteps === 0) return Math.max(snapshot.spentUsd, delta ?? 0)
  if (snapshot && snapshot.unpricedSteps > 0 && !delta) return undefined
  return delta
}

// Folds one drain's guard reading into a run's total. Every drain of a session
// is its own guard run, so spend and step counts add up, and the latest drain's
// state and cost kind stand for the run.
export function combineSpend(total: RunBudget.Snapshot | undefined, drain: RunBudget.Snapshot | undefined) {
  if (!drain) return total
  if (!total) return drain
  return {
    ...drain,
    spentUsd: total.spentUsd + drain.spentUsd,
    steps: total.steps + drain.steps,
    unpricedSteps: total.unpricedSteps + drain.unpricedSteps,
    codiumSteps: (total.codiumSteps ?? 0) + (drain.codiumSteps ?? 0),
  }
}

// The measured cost an agent card shows. Two decimals like the engine's stop
// messages, and never "$0.00" for spend that was real but tiny.
export function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01"
  return `$${value.toFixed(2)}`
}
