export * as SpendGuard from "./spend-guard"

// What a run may spend and when it must stop. A run belongs to a root session; subagent sessions link to it, so
// their spend counts against the root. The guard counts money as it is spent and never reads session.cost, so a
// revert cannot lower what a run has spent. The rules are pure; the service keeps one run per root in memory.
// Vectorscope shares costKindOf and priceOf, so a review and the run guard agree on which models can be priced.
// Every subagent one request starts also counts against that request's delegated ledger, found by its id, which the
// root itself never counts against: at its ceiling the subagents stop and the main agent carries on.

import { Context, Effect, Layer, Ref } from "effect"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import type { SessionID } from "@vectordevai/schema/session-id"
import { CodiumUsage } from "./codium-usage"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { NEXT_STEP_SLACK, nextStepCostUsd, type ReviewPrice } from "./review/plan"
import type { CostKind } from "./review/types"

export type { CostKind }

// review/types stays import-free for the desktop renderer, so its CostKind is held equal to the schema's here.
const costKindMatchesSchema: [CostKind] extends [RunBudget.CostKind]
  ? [RunBudget.CostKind] extends [CostKind]
    ? true
    : never
  : never = true

export const WARN_AT = 0.8
export const UNPRICED_STEPS = 40
export const LOOP_REPEATS = 3
export const LOOP_WINDOW = 8
export const ERROR_STREAK = 3
// Finished runs kept for snapshot(); the oldest is dropped first.
export const LAST_RUNS = 200

// The order matters: a free model with a catalog price is still free, an OAuth plan with a catalog price is billed by
// the plan, not per token, and a local server with a configured price is priced at it. `local` is a model server on
// this computer or a listed private address; a company endpoint on the internet without a price stays unknown.
export function costKindOf(input: {
  free: boolean
  listed: boolean
  oauthPlan: boolean
  local?: boolean
  codium?: boolean
}): CostKind {
  if (input.codium) return "codium"
  if (input.free) return "free"
  if (input.oauthPlan) return "plan"
  if (input.listed) return "priced"
  if (input.local) return "local"
  return "unknown"
}

// Catalog rates in USD per million tokens. A model with no input and no output rate has no price.
export function priceOf(cost: {
  input: number
  output: number
  cache?: { read?: number; write?: number }
}): ReviewPrice | undefined {
  if (cost.input === 0 && cost.output === 0) return undefined
  return {
    input: cost.input,
    output: cost.output,
    ...((cost.cache?.read ?? 0) > 0 ? { cacheRead: cost.cache?.read } : {}),
    ...((cost.cache?.write ?? 0) > 0 ? { cacheWrite: cost.cache?.write } : {}),
  }
}

// A tool call as the loop rules see it. `output` stands for what the call returned (the engine passes a digest) and
// `error` for how it failed, so a call that gets a different answer from the same input, such as a page observed
// after a click, is not a repeat.
export type Sig = { readonly tool: string; readonly input: string; readonly output?: string; readonly error?: string }
export type Estimate = { readonly lowUsd: number; readonly highUsd: number }
export type Stop = { readonly reason: RunBudget.StopReason; readonly message: string }
type Streak = { readonly tool: string; readonly error: string; readonly count: number }
// The loop detector's memory for one session of the run. Each session keeps its own, so parallel subagents that
// run the same tool once each are not one loop, and a patch in one session does not clear another's. `ring` holds
// the last LOOP_WINDOW calls since a file change; `stale` holds the calls since the latest one that returned
// something new, that one included.
export type Loop = { readonly ring: readonly Sig[]; readonly stale: readonly Sig[]; readonly errorStreak: Streak }

export type Run = {
  readonly rootID: SessionID
  readonly budget: RunBudget.Info
  readonly spentUsd: number
  readonly steps: number
  readonly unpricedSteps: number
  readonly codiumSteps: number
  // The cost kind of the latest step, for the spend snapshot.
  readonly costKind?: CostKind
  // Steps counted by cost kind, so a run's cost is known only when every step was priced. No limit reads it.
  readonly kinds: Readonly<Partial<Record<CostKind, number>>>
  readonly stopped?: Stop
  readonly warned: boolean
  readonly loops: ReadonlyMap<SessionID, Loop>
  // Off for a root that polices its own loops; see ignoreLoops.
  readonly loopRules: boolean
  // Set while the budget is begin()'s fallback, which no one has armed over since, with every budget tighten() has
  // held it to: what refall() may move to another fallback. Unset once the owner arms a budget of their own.
  readonly fallback?: { readonly tightened?: RunBudget.Info }
  // False turns the unpriced-step stop off, as on a delegated ledger whose budget sets no unpricedSteps.
  readonly unpricedRule?: boolean
}

export type Step = {
  readonly costUsd?: number
  readonly costKind: CostKind
  // Usage may be incomplete even when the model's catalog price is known.
  readonly unpriced?: boolean
  readonly price?: ReviewPrice
  // The step's whole context, and the part of it the provider reported as cache reads.
  readonly contextTokens: number
  readonly cachedTokens: number
  // Whether another provider step follows this one.
  readonly continues: boolean
  readonly tools: readonly {
    readonly tool: string
    readonly input: string
    readonly output?: string
    readonly error?: string
  }[]
  // Whether the step changed a file, which clears the loop detector's memory.
  readonly patched: boolean
}

export type Verdict =
  | {
      readonly state: "ok" | "warn"
      readonly reason?: undefined
      readonly message?: string
      readonly estimate?: Estimate
    }
  | (Stop & { readonly state: "stopped"; readonly estimate?: Estimate })

export type StopDetail = {
  readonly estimate?: Estimate
  readonly loop?: { readonly tool: string; readonly kind: "repeat" | "error" }
  // The root's own step that crossed the cap ended its turn, so its answer stands and nothing was cut short. A
  // subagent's final step is not: the root it answers to is cut short at its next step.
  readonly final?: boolean
  // The ledger that stopped. A delegated ledger's messages name the subagent ceiling instead of the run's cap.
  readonly scope?: ScopeSnapshot["kind"]
}

export function start(rootID: SessionID, budget: RunBudget.Info, loopRules = true): Run {
  return {
    rootID,
    budget,
    spentUsd: 0,
    steps: 0,
    unpricedSteps: 0,
    kinds: {},
    codiumSteps: 0,
    warned: false,
    loops: new Map(),
    loopRules,
  }
}

// The stricter of two budgets, limit by limit, for a source that may tighten the limits it is given and never loosen
// them, such as an invited guest's prompt or a child or batch budget. A limit only one side sets applies as it
// is; the warning share and the unpriced-step limit are compared with the defaults a side that leaves them out runs
// with, so `{ warnAt: 1 }` cannot push the warning past WARN_AT.
export function tighter(base: RunBudget.Info | undefined, next: RunBudget.Info): RunBudget.Info {
  const least = (left: number | undefined, right: number | undefined) =>
    left === undefined ? right : right === undefined ? left : Math.min(left, right)
  const usd = least(base?.usd, next.usd)
  const steps = least(base?.steps, next.steps)
  const warnAt =
    base?.warnAt === undefined && next.warnAt === undefined
      ? undefined
      : Math.min(base?.warnAt ?? WARN_AT, next.warnAt ?? WARN_AT)
  const unpricedSteps =
    base?.unpricedSteps === undefined && next.unpricedSteps === undefined
      ? undefined
      : Math.min(base?.unpricedSteps ?? UNPRICED_STEPS, next.unpricedSteps ?? UNPRICED_STEPS)
  return {
    ...(usd !== undefined && { usd }),
    ...(steps !== undefined && { steps }),
    ...(warnAt !== undefined && { warnAt }),
    ...(unpricedSteps !== undefined && { unpricedSteps }),
  }
}

// Called after every provider step of any session in the run, with the session that took the step. Spend and steps
// count against the run; loops are detected per session. A stopped run keeps counting what in-flight steps spent,
// and answers stop to every later step, which is how a stop reaches the rest of the lineage. `scope` is the kind of
// ledger `run` is, for the wording of its messages.
export function afterStep(
  run: Run,
  step: Step,
  sessionID = run.rootID,
  scope?: ScopeSnapshot["kind"],
): { run: Run; verdict: Verdict } {
  const counted = {
    ...run,
    steps: run.steps + 1,
    spentUsd:
      run.spentUsd + (step.costKind === "priced" || step.costKind === "unknown" ? Math.max(step.costUsd ?? 0, 0) : 0),
    unpricedSteps:
      run.unpricedSteps + (step.costKind === "unknown" || (step.costKind === "priced" && step.unpriced) ? 1 : 0),
    // A Codium step is billed to the account's plan: no dollars and no unpriced step, even with incomplete usage.
    codiumSteps: run.codiumSteps + (step.costKind === "codium" ? 1 : 0),
    costKind: step.costKind,
    kinds: { ...run.kinds, [step.costKind]: (run.kinds[step.costKind] ?? 0) + 1 },
  }
  if (run.stopped) return { run: counted, verdict: { state: "stopped", ...run.stopped } }
  const limits = checkLimits(counted, step, sessionID, scope)
  if (limits.state === "stopped") return stop(counted, limits)
  const loops = counted.loopRules
    ? checkLoops(counted, step, sessionID)
    : { run: counted, verdict: { state: "ok" } satisfies Verdict }
  if (loops.verdict.state === "stopped") return stop(loops.run, loops.verdict)
  if (limits.state === "warn") return { run: { ...loops.run, warned: true }, verdict: limits }
  return { run: loops.run, verdict: limits }
}

// The text a stopped run shows everywhere: the CLI, the TUI, the app and desktop logs.
export function stopMessage(reason: RunBudget.StopReason, run: Run, detail: StopDetail = {}): string {
  const cap = formatUsd(run.budget.usd ?? 0)
  // Only the subagent that stepped stops on a delegated ledger; the main agent is never counted against it.
  if (detail.scope === "delegated") {
    const ceiling = `${cap} ceiling for this request's subagents`
    const kept = "what it did is kept, and the main agent carries on."
    if (reason === "cap")
      return `Subagent spend ceiling reached: ${formatUsd(run.spentUsd)} spent against a ${ceiling}. Vector stopped this subagent after the step that crossed it; ${kept}`
    if (reason === "predicted")
      return `Subagent spend ceiling: ${formatUsd(run.spentUsd)} spent of a ${ceiling}, and this subagent's next step was estimated at ${formatRange(detail.estimate ?? { lowUsd: 0, highUsd: 0 })} at catalog list prices. Vector stopped it before that step; ${kept}`
    if (reason === "unpriced")
      return `Subagent unpriced-step limit reached: this request's subagents took ${run.unpricedSteps} unpriced or incomplete steps, so Vector cannot fully measure their cost against the ${ceiling}. Vector stopped this subagent; ${kept}`
    if (reason === "steps")
      return `Subagent step limit reached: this request's subagents used ${run.steps} of their ${run.budget.steps ?? run.steps} steps. Vector stopped this subagent; ${kept}`
  }
  if (reason === "cap" && detail.final)
    return `Spend cap reached: ${formatUsd(run.spentUsd)} spent against a ${cap} cap for this run, on a step that ended its turn. Its answer stands, and Vector starts no further step under this cap.`
  if (reason === "cap")
    return `Spend cap reached: ${formatUsd(run.spentUsd)} spent against a ${cap} cap for this run. Vector stopped after the step that crossed it.`
  if (reason === "predicted")
    return `Stopped before the next step: ${formatUsd(run.spentUsd)} spent of a ${cap} cap, and the next step was estimated at ${formatRange(detail.estimate ?? { lowUsd: 0, highUsd: 0 })} at catalog list prices.`
  if (reason === "unpriced")
    return `Stopped after ${run.unpricedSteps} unpriced or incomplete steps: Vector cannot fully measure their cost against your ${cap} cap. Without a dollar cap, step and loop limits still apply.`
  if (reason === "steps")
    return `Step limit reached: ${run.steps} of ${run.budget.steps ?? run.steps} steps used for this run.`
  const tool = detail.loop?.tool ?? "a tool"
  if (detail.loop?.kind === "error")
    return `Paused a repeating loop: \`${tool}\` failed with the same error ${ERROR_STREAK} times in a row.`
  return `Paused a repeating loop: \`${tool}\` returned the same result for the same input ${LOOP_REPEATS} times, with no new results or file changes in between.`
}

export function warnMessage(run: Run, scope?: ScopeSnapshot["kind"]) {
  if (scope === "delegated")
    return `Subagents in this request have spent ${formatUsd(run.spentUsd)} of their ${formatUsd(run.budget.usd ?? 0)} ceiling.`
  return `Approaching the spend cap: ${formatUsd(run.spentUsd)} of ${formatUsd(run.budget.usd ?? 0)} spent on this run.`
}

// Two decimals, or "<$0.01" for a positive amount that would round to zero.
export function formatUsd(usd: number) {
  const fixed = usd.toFixed(2)
  if (usd > 0 && fixed === "0.00") return "<$0.01"
  return `$${fixed}`
}

// A research report's Spend line (label plan §3.2): the run's own dollars at list prices, with "+ Codium" when Codium
// steps ran beside them. A run that spent no dollars gets no line, a Codium-only run included, so a saved report never
// names Codium without own dollars beside it.
export function reportSpend(run: Pick<Run, "spentUsd" | "codiumSteps"> | undefined) {
  if (!run || !(run.spentUsd > 0)) return undefined
  return CodiumUsage.withCodium(`${formatUsd(run.spentUsd)} at list prices`, run.codiumSteps)
}

function formatRange(estimate: Estimate) {
  const low = formatUsd(estimate.lowUsd)
  const high = formatUsd(estimate.highUsd)
  // Without a cache-read price the low and high estimates are the same.
  if (low === high) return low
  return `${low}–${high}`
}

function stop(run: Run, verdict: Stop & Verdict) {
  return { run: { ...run, stopped: { reason: verdict.reason, message: verdict.message } }, verdict }
}

// Step and dollar limits. Dollars are checked only with a dollar cap and a priced or unpriced model: plan, free and
// local models are not billed per token, so only the step and loop limits stop them. The next step is predicted from this step's context, like Vectorscope does. A
// final answer that reaches a limit still stops the run, so no other session of it starts another step, but the
// answer itself stands: callers end a turn early only for a step that continues.
function checkLimits(run: Run, step: Step, sessionID: SessionID, scope?: ScopeSnapshot["kind"]): Verdict {
  if (run.budget.steps !== undefined && run.steps >= run.budget.steps)
    return { state: "stopped", reason: "steps", message: stopMessage("steps", run, { scope }) }
  const usd = run.budget.usd
  if (usd === undefined || (step.costKind !== "priced" && step.costKind !== "unknown")) return { state: "ok" }
  if (run.spentUsd >= usd)
    return {
      state: "stopped",
      reason: "cap",
      message: stopMessage("cap", run, { final: !step.continues && sessionID === run.rootID, scope }),
    }
  if (
    (step.costKind === "unknown" || step.unpriced) &&
    run.unpricedRule !== false &&
    run.unpricedSteps >= (run.budget.unpricedSteps ?? UNPRICED_STEPS)
  )
    return { state: "stopped", reason: "unpriced", message: stopMessage("unpriced", run, { scope }) }
  const estimate =
    step.continues && step.price
      ? {
          lowUsd: nextStepCostUsd(step.contextTokens + NEXT_STEP_SLACK, step.price, step.cachedTokens),
          highUsd: nextStepCostUsd(step.contextTokens + NEXT_STEP_SLACK, step.price, 0),
        }
      : undefined
  if (estimate && run.spentUsd + estimate.lowUsd > usd)
    return {
      state: "stopped",
      reason: "predicted",
      message: stopMessage("predicted", run, { estimate, scope }),
      estimate,
    }
  const near =
    run.spentUsd >= usd * (run.budget.warnAt ?? WARN_AT) || (estimate && run.spentUsd + estimate.highUsd > usd)
  if (near && !run.warned) return { state: "warn", message: warnMessage(run, scope), ...(estimate ? { estimate } : {}) }
  return { state: "ok", ...(estimate ? { estimate } : {}) }
}

// A tool returning the same result for the same input LOOP_REPEATS times, with no call that returned something new
// and no file change in between, or the same tool failing with the same error ERROR_STREAK calls in a row. A call is
// new when no call in the last LOOP_WINDOW since the last file change had its tool, input and result. Observing a
// page between clicks, or `git status` between `git add` and `git commit`, returns something new each time, while a
// cycle of calls that keep getting the same answers does not.
function checkLoops(run: Run, step: Step, sessionID: SessionID): { run: Run; verdict: Verdict } {
  const loop = run.loops.get(sessionID) ?? { ring: [], stale: [], errorStreak: { tool: "", error: "", count: 0 } }
  const calls = step.tools.reduce<{ ring: readonly Sig[]; stale: readonly Sig[]; repeated?: Sig }>(
    (acc, item) => {
      const sig = { tool: item.tool, input: item.input, output: item.output, error: item.error }
      const stale = acc.ring.some((other) => sameCall(other, sig)) ? [...acc.stale, sig].slice(-LOOP_WINDOW) : [sig]
      return {
        ring: [...acc.ring, sig].slice(-LOOP_WINDOW),
        stale,
        repeated:
          acc.repeated ?? (stale.filter((other) => sameCall(other, sig)).length >= LOOP_REPEATS ? sig : undefined),
      }
    },
    step.patched ? { ring: [], stale: [] } : { ring: loop.ring, stale: loop.stale },
  )
  const streaks = step.tools.reduce<Streak[]>((all, item) => {
    const previous = all.at(-1) ?? loop.errorStreak
    if (item.error === undefined) return [...all, { tool: "", error: "", count: 0 }]
    if (item.tool === previous.tool && item.error === previous.error)
      return [...all, { ...previous, count: previous.count + 1 }]
    return [...all, { tool: item.tool, error: item.error, count: 1 }]
  }, [])
  const next = {
    ...run,
    loops: new Map(run.loops).set(sessionID, {
      ring: calls.ring,
      stale: calls.stale,
      errorStreak: streaks.at(-1) ?? loop.errorStreak,
    }),
  }
  const failing = streaks.find((streak) => streak.count >= ERROR_STREAK)
  if (failing)
    return {
      run: next,
      verdict: {
        state: "stopped",
        reason: "loop",
        message: stopMessage("loop", next, { loop: { tool: failing.tool, kind: "error" } }),
      },
    }
  if (calls.repeated)
    return {
      run: next,
      verdict: {
        state: "stopped",
        reason: "loop",
        message: stopMessage("loop", next, { loop: { tool: calls.repeated.tool, kind: "repeat" } }),
      },
    }
  return { run: next, verdict: { state: "ok" } }
}

function sameCall(left: Sig, right: Sig) {
  return (
    left.tool === right.tool && left.input === right.input && left.output === right.output && left.error === right.error
  )
}

export type LinkOptions = {
  readonly budget?: RunBudget.Info
  readonly batch?: { readonly id: string; readonly budget?: RunBudget.Info }
  // A settled child starts a new attempt only on an explicit continuation.
  readonly renew?: boolean
  // The request's delegated ledger: found by `id`, re-armed with `budget` on every link, else created at `seed`.
  readonly delegated?: {
    readonly id: string
    readonly budget: RunBudget.Info
    readonly seed?: {
      readonly spentUsd: number
      readonly steps: number
      readonly unpricedSteps: number
      readonly codiumSteps?: number
    }
  }
}

export type ScopeSnapshot = {
  readonly kind: "run" | "batch" | "child" | "delegated"
  readonly id: string
  readonly budget: RunBudget.Info
  readonly spentUsd: number
  readonly steps: number
  readonly unpricedSteps: number
  readonly codiumSteps: number
  readonly costKind?: CostKind
  readonly stopped?: Stop
}

// An ancillary request keeps the run/scopes that launched it, even after that session starts another run.
export interface Captured {
  readonly record: (usageID: string, step: Step) => Effect.Effect<Verdict>
  readonly stopped: Effect.Effect<Stop | undefined>
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly capture: (sessionID: SessionID) => Effect.Effect<Captured>
  // Sets the budget for the root of `sessionID`: replaces an active run's budget, or holds it for begin().
  readonly arm: (sessionID: SessionID, budget: RunBudget.Info) => Effect.Effect<void>
  // Like arm, for a sender who may not raise the owner's limits, such as an invited guest: each limit can only get
  // stricter than the one the run has. An active run keeps the stricter of its budget and this one; otherwise the
  // armed budget does, and one armed only this way is held to begin()'s `fallback` too.
  readonly tighten: (sessionID: SessionID, budget: RunBudget.Info) => Effect.Effect<void>
  // Starts a run for a root session with the armed budget, else `fallback`. A no-op while the run is active.
  // `carried` is a stopped run the new one carries on from, in place of `fallback`: the new run keeps its budget, which
  // stays the owner's when the owner armed it, so replaceFallback() moves it only when it was a fallback too.
  readonly begin: (
    rootID: SessionID,
    fallback?: RunBudget.Info,
    carried?: Pick<Run, "budget" | "fallback">,
  ) => Effect.Effect<void>
  // Moves the active run of `sessionID`'s root from begin()'s fallback to `fallback`, held to every budget tighten()
  // gave it, such as research's default caps moving from Focused's to Deep's. A run the owner armed a budget for keeps
  // that budget, and a root with no run going is left alone.
  readonly replaceFallback: (sessionID: SessionID, fallback: RunBudget.Info) => Effect.Effect<void>
  // Turns the loop rules off for a session that polices itself, such as a Vectorscope specialist: it has its own
  // step, cost and time limits, never edits files (so nothing would ever reset the loop window), and must account for
  // every stop it gets. Spend, step and cap checks still apply, in its own run or the run it is linked to.
  readonly ignoreLoops: (sessionID: SessionID) => Effect.Effect<void>
  // Counts `childID` against the run its parent counts against, and its child, batch and delegated ledgers. With a
  // delegated ledger and no active run of the root, that ledger is the run it counts against.
  readonly link: (childID: SessionID, parentID: SessionID, options?: LinkOptions) => Effect.Effect<void>
  // The delegated ledger with this id, while it is kept.
  readonly delegated: (id: string) => Effect.Effect<ScopeSnapshot | undefined>
  // Re-arms the delegated ledger as link() does, or creates it at its seed, with no session bound to it, so a launch
  // is checked against the current budget before its child exists. `rootID` is the root of its conversation.
  readonly rearm: (rootID: SessionID, delegated: NonNullable<LinkOptions["delegated"]>) => Effect.Effect<ScopeSnapshot>
  // Retains completed-attempt observations but allows old, unused launch ledgers to be reclaimed.
  readonly release: (sessionID: SessionID) => Effect.Effect<void>
  readonly scopes: (sessionID: SessionID) => Effect.Effect<ScopeSnapshot[]>
  // Drops a session's link to its root, so its next run is a run of its own, such as a helper started after the run
  // it once counted against has ended.
  readonly unlink: (sessionID: SessionID) => Effect.Effect<void>
  readonly rootOf: (sessionID: SessionID) => Effect.Effect<SessionID>
  // Whether the root of `sessionID` has a run going.
  readonly running: (sessionID: SessionID) => Effect.Effect<boolean>
  // Applies one provider step to the run of `sessionID`'s root and publishes session.spend. A root with no active
  // run is ignored. A linked subagent still stepping after its root's run ended, such as a background task, counts
  // against its launching run even when the root begins another, so it keeps its cap, loop rules and stop.
  // `confirm` settles whether the step changed a file when `step.patched` could only guess. It is awaited only when
  // the guess would pause the run as a loop, so the common step never waits on a snapshot.
  readonly record: (sessionID: SessionID, step: Step, confirm?: Effect.Effect<boolean>) => Effect.Effect<Verdict>
  // Files changed in `sessionID` after its step was recorded, so the loop rules forget what ran before.
  readonly changed: (sessionID: SessionID) => Effect.Effect<void>
  // Explicit user input was promoted: forget this Session's repeats and errors without renewing its budget.
  readonly resetLoops: (sessionID: SessionID) => Effect.Effect<void>
  readonly stopped: (sessionID: SessionID) => Effect.Effect<Stop | undefined>
  // Moves the run into the finished runs, and drops a budget armed for a run that never began.
  readonly end: (rootID: SessionID) => Effect.Effect<void>
  // The active run of `sessionID`'s root, else its last finished run.
  readonly snapshot: (sessionID: SessionID) => Effect.Effect<Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SpendGuard") {}

// A budget held for a root's next run. `tighten` marks one armed only by tighten(), which begin() holds to its
// fallback as well; one the owner armed replaces the fallback.
type Armed = { readonly budget: RunBudget.Info; readonly tighten: boolean }

type Ledger = {
  readonly kind: ScopeSnapshot["kind"]
  readonly id: string
  readonly lineage: number
  readonly run: Run
}

type Binding = { readonly run: number; readonly scopes: readonly number[]; readonly live: boolean }

type State = {
  readonly next: number
  readonly active: ReadonlyMap<SessionID, number>
  readonly last: ReadonlyMap<SessionID, number>
  readonly ledgers: ReadonlyMap<number, Ledger>
  readonly roots: ReadonlyMap<SessionID, SessionID>
  readonly bindings: ReadonlyMap<SessionID, Binding>
  readonly armed: ReadonlyMap<SessionID, Armed>
  readonly quiet: ReadonlySet<SessionID>
  readonly pins: ReadonlyMap<number, number>
  // Delegated ledger keys by id, the most recently linked last.
  readonly delegations: ReadonlyMap<string, number>
}

// A live child pins its launch ledger even after the parent has answered or started another run. Completed
// attempts keep observations for the same bounded history as roots, without retaining every old task forever.
// The last LAST_RUNS delegated ledgers are kept the same way, and an older one stays while a kept child counts on it.
function prune(current: State): State {
  const last = new Map([...current.last].slice(-LAST_RUNS))
  const retained = new Set([
    ...current.active.values(),
    ...last.values(),
    ...current.pins.keys(),
    ...[...current.delegations.values()].slice(-LAST_RUNS),
  ])
  current.bindings.forEach((binding) => {
    if (binding.live) retained.add(binding.run)
  })
  const bindings = new Map([...current.bindings].filter((entry) => retained.has(entry[1].run)))
  const referenced = new Set([...retained, ...[...bindings.values()].flatMap((binding) => [...binding.scopes])])
  const roots = new Map(
    [...current.roots].filter(
      ([id, rootID]) =>
        bindings.has(id) || (!current.bindings.has(id) && (current.active.has(rootID) || last.has(rootID))),
    ),
  )
  return {
    ...current,
    last,
    bindings,
    roots,
    ledgers: new Map([...current.ledgers].filter(([id]) => referenced.has(id))),
    quiet: new Set([...current.quiet].filter((id) => roots.has(id) || current.active.has(id) || last.has(id))),
    delegations: new Map([...current.delegations].filter(([, key]) => referenced.has(key))),
  }
}

// A delegated ledger takes the budget from the current config at every link, keeping its spend. A stop the new budget
// no longer justifies is cleared, a predicted one included: it estimated the next step of the child that made it, which
// has stopped. Spend already past a lowered limit stops it at once, so a launch checked against it is refused. The
// warning comes again only under a new ceiling.
function rearm(run: Run, budget: RunBudget.Info): Run {
  const next = {
    ...run,
    budget,
    unpricedRule: budget.unpricedSteps !== undefined,
    warned: run.warned && run.budget.usd === budget.usd && run.budget.warnAt === budget.warnAt,
    stopped: undefined,
  }
  if (run.stopped?.reason === "loop") return { ...next, stopped: run.stopped }
  const reason =
    budget.usd !== undefined && run.spentUsd >= budget.usd
      ? "cap"
      : budget.steps !== undefined && run.steps >= budget.steps
        ? "steps"
        : budget.usd !== undefined && budget.unpricedSteps !== undefined && run.unpricedSteps >= budget.unpricedSteps
          ? "unpriced"
          : undefined
  if (reason === undefined) return next
  return {
    ...next,
    stopped:
      run.stopped?.reason === reason
        ? run.stopped
        : { reason, message: stopMessage(reason, next, { scope: "delegated" }) },
  }
}

// Finds the request's delegated ledger by its id, in any lineage, and re-arms it, or creates it at the seeded spend.
// Its id moves to the end of the retention order.
function delegate(current: State, rootID: SessionID, input: NonNullable<LinkOptions["delegated"]>) {
  const found = current.delegations.get(input.id)
  const ledger = found === undefined ? undefined : current.ledgers.get(found)
  const key = found !== undefined && ledger ? found : current.next
  const delegations = new Map(current.delegations)
  delegations.delete(input.id)
  const seeded = {
    ...start(rootID, {}, false),
    spentUsd: input.seed?.spentUsd ?? 0,
    steps: input.seed?.steps ?? 0,
    unpricedSteps: input.seed?.unpricedSteps ?? 0,
    codiumSteps: input.seed?.codiumSteps ?? 0,
  }
  const armed: Ledger = {
    kind: "delegated",
    id: input.id,
    lineage: key,
    run: rearm(ledger?.run ?? seeded, input.budget),
  }
  const state: State = {
    ...current,
    next: ledger ? current.next : current.next + 1,
    delegations: delegations.set(input.id, key),
    ledgers: new Map(current.ledgers).set(key, armed),
  }
  return { key, state, ledger: armed }
}

function snapshotOf(ledger: Ledger): ScopeSnapshot {
  return {
    kind: ledger.kind,
    id: ledger.id,
    budget: ledger.run.budget,
    spentUsd: ledger.run.spentUsd,
    steps: ledger.run.steps,
    unpricedSteps: ledger.run.unpricedSteps,
    codiumSteps: ledger.run.codiumSteps,
    costKind: ledger.run.costKind,
    stopped: ledger.run.stopped,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const state = yield* Ref.make<State>({
      next: 1,
      active: new Map(),
      last: new Map(),
      ledgers: new Map(),
      roots: new Map(),
      bindings: new Map(),
      armed: new Map(),
      quiet: new Set(),
      pins: new Map(),
      delegations: new Map(),
    })
    const rootIn = (current: State, sessionID: SessionID) => current.roots.get(sessionID) ?? sessionID
    const runKey = (current: State, sessionID: SessionID, previous = false) =>
      current.bindings.get(sessionID)?.run ??
      current.active.get(rootIn(current, sessionID)) ??
      (previous || current.roots.has(sessionID) ? current.last.get(rootIn(current, sessionID)) : undefined)
    const keys = (current: State, sessionID: SessionID) => {
      const run = runKey(current, sessionID)
      return [...new Set([...(run === undefined ? [] : [run]), ...(current.bindings.get(sessionID)?.scopes ?? [])])]
    }
    const apply = (current: State, sessionID: SessionID, step: Step, captured?: readonly number[]) =>
      (captured ?? keys(current, sessionID)).flatMap((key) => {
        const ledger = current.ledgers.get(key)
        if (!ledger) return []
        // Loop detection belongs to the launch run, not to several nested budgets; a child whose launch is its
        // request's delegated ledger has it on its own ledger, which watches only its own calls. Every scope still
        // counts actual spend and steps once, including in-flight work that finishes after any applicable stop.
        const watched = !current.quiet.has(sessionID) && (ledger.kind !== "child" || ledger.id === sessionID)
        return [
          {
            key,
            ledger,
            next: afterStep(ledger.run, watched ? step : { ...step, tools: [] }, sessionID, ledger.kind),
          },
        ]
      })
    const verdict = (results: ReturnType<typeof apply>) =>
      results.find((item) => item.next.verdict.state === "stopped") ??
      results.find((item) => item.next.verdict.state === "warn") ??
      results[0]

    const record = Effect.fn("SpendGuard.record")(function* (
      sessionID: SessionID,
      input: Step,
      confirm?: Effect.Effect<boolean>,
      captured?: readonly number[],
    ) {
      const guess = verdict(apply(yield* Ref.get(state), sessionID, input, captured))?.next.verdict
      const step =
        confirm && !input.patched && guess?.state === "stopped" && guess.reason === "loop"
          ? { ...input, patched: yield* confirm }
          : input
      const results = yield* Ref.modify(state, (current) => {
        const results = apply(current, sessionID, step, captured)
        return [
          results,
          {
            ...current,
            ledgers: new Map([
              ...current.ledgers,
              ...results.map((item) => [item.key, { ...item.ledger, run: item.next.run }] as const),
            ]),
          },
        ] as const
      })
      const selected = verdict(results)
      if (!selected) return { state: "ok" } satisfies Verdict
      const root = results.find((item) => item.ledger.kind === "run")
      // Old launch work must not overwrite the new run's spend meter, and a child-only cap must not present
      // the parent as stopped. Its own session receives the scoped verdict instead.
      const current = yield* Ref.get(state)
      if (captured && !keys(current, sessionID).includes(selected.key)) return selected.next.verdict
      const published = root && current.active.get(root.next.run.rootID) === root.key ? root : selected
      yield* events.publish(SessionStatusEvent.Spend, {
        sessionID: published === root ? published.next.run.rootID : sessionID,
        state: published.next.verdict.state,
        reason: published.next.verdict.reason,
        message: published.next.verdict.message,
        spentUsd: published.next.run.spentUsd,
        capUsd: published.next.run.budget.usd,
        steps: published.next.run.steps,
        unpricedSteps: published.next.run.unpricedSteps,
        codiumSteps: published.next.run.codiumSteps,
        costKind: step.costKind,
        estimate: published.next.verdict.estimate,
      })
      if (selected !== published)
        yield* events.publish(SessionStatusEvent.Spend, {
          sessionID,
          state: selected.next.verdict.state,
          reason: selected.next.verdict.reason,
          message: selected.next.verdict.message,
          spentUsd: selected.next.run.spentUsd,
          capUsd: selected.next.run.budget.usd,
          steps: selected.next.run.steps,
          unpricedSteps: selected.next.run.unpricedSteps,
          codiumSteps: selected.next.run.codiumSteps,
          costKind: step.costKind,
          estimate: selected.next.verdict.estimate,
        })
      return selected.next.verdict
    })

    return Service.of({
      capture: Effect.fn("SpendGuard.capture")(function* (sessionID) {
        const captured = yield* Ref.modify(state, (current) => {
          const captured = keys(current, sessionID)
          const pins = new Map(current.pins)
          captured.forEach((key) => pins.set(key, (pins.get(key) ?? 0) + 1))
          return [captured, { ...current, pins }] as const
        })
        const receipt = yield* Ref.make({ closed: false, ids: new Set<string>() })
        return {
          record: Effect.fn("SpendGuard.capturedRecord")(function* (usageID: string, step: Step) {
            const fresh = yield* Ref.modify(receipt, (current) =>
              current.closed || current.ids.has(usageID)
                ? ([false, current] as const)
                : ([true, { ...current, ids: new Set(current.ids).add(usageID) }] as const),
            )
            if (!fresh) return { state: "ok" } satisfies Verdict
            return yield* record(sessionID, step, undefined, captured)
          }, Effect.uninterruptible),
          stopped: Ref.get(state).pipe(
            Effect.map((current) =>
              captured.map((key) => current.ledgers.get(key)?.run.stopped).find((stop) => stop !== undefined),
            ),
          ),
          release: Effect.gen(function* () {
            const open = yield* Ref.modify(
              receipt,
              (current) => [!current.closed, { ...current, closed: true }] as const,
            )
            if (!open) return
            yield* Ref.update(state, (current) => {
              const pins = new Map(current.pins)
              captured.forEach((key) => {
                const count = pins.get(key) ?? 0
                if (count <= 1) {
                  pins.delete(key)
                  return
                }
                pins.set(key, count - 1)
              })
              return prune({ ...current, pins })
            })
          }).pipe(Effect.uninterruptible),
        } satisfies Captured
      }),
      arm: Effect.fn("SpendGuard.arm")(function* (sessionID, budget) {
        yield* Ref.update(state, (current) => {
          const rootID = rootIn(current, sessionID)
          const key = current.active.get(rootID)
          const ledger = key === undefined ? undefined : current.ledgers.get(key)
          if (!ledger || key === undefined)
            return { ...current, armed: new Map(current.armed).set(rootID, { budget, tighten: false }) }
          const warned = ledger.run.warned && ledger.run.budget.usd === budget.usd
          // The owner's own budget: no fallback moves it again.
          return {
            ...current,
            ledgers: new Map(current.ledgers).set(key, {
              ...ledger,
              run: { ...ledger.run, budget, warned, fallback: undefined },
            }),
          }
        })
      }),
      tighten: Effect.fn("SpendGuard.tighten")(function* (sessionID, budget) {
        yield* Ref.update(state, (current) => {
          const rootID = rootIn(current, sessionID)
          const key = runKey(current, sessionID)
          const ledger = key === undefined ? undefined : current.ledgers.get(key)
          if (ledger && key !== undefined) {
            const next = tighter(ledger.run.budget, budget)
            const warned = ledger.run.warned && ledger.run.budget.usd === next.usd
            const fallback = ledger.run.fallback && { tightened: tighter(ledger.run.fallback.tightened, budget) }
            return {
              ...current,
              ledgers: new Map(current.ledgers).set(key, {
                ...ledger,
                run: { ...ledger.run, budget: next, warned, fallback },
              }),
            }
          }
          const held = current.armed.get(rootID)
          return {
            ...current,
            armed: new Map(current.armed).set(
              rootID,
              held ? { budget: tighter(held.budget, budget), tighten: held.tighten } : { budget, tighten: true },
            ),
          }
        })
      }),
      begin: Effect.fn("SpendGuard.begin")(function* (rootID, fallback, carried) {
        yield* Ref.update(state, (current) => {
          if (current.active.has(rootID)) return current
          const armed = new Map(current.armed)
          armed.delete(rootID)
          const held = current.armed.get(rootID)
          const base = carried ? carried.budget : fallback
          const budget = held ? (held.tighten ? tighter(base, held.budget) : held.budget) : (base ?? {})
          // What replaceFallback() may move: begin()'s fallback, or the carried run's budget when that was one, held to
          // every budget tighten() gave either. A budget the owner armed, for this run or the one it carries on from,
          // stays.
          const movable = held && !held.tighten ? undefined : carried ? carried.fallback : {}
          const moves =
            movable && held
              ? { tightened: movable.tightened ? tighter(movable.tightened, held.budget) : held.budget }
              : movable
          const bindings = new Map(current.bindings)
          current.roots.forEach((owner, childID) => {
            if (owner === rootID && !bindings.has(childID))
              bindings.set(childID, { run: current.next, scopes: [], live: true })
          })
          return {
            ...current,
            next: current.next + 1,
            armed,
            bindings,
            active: new Map(current.active).set(rootID, current.next),
            ledgers: new Map(current.ledgers).set(current.next, {
              kind: "run",
              id: `run:${current.next}`,
              lineage: current.next,
              run: {
                ...start(rootID, budget, !current.quiet.has(rootID)),
                ...(moves ? { fallback: moves } : {}),
              },
            }),
          }
        })
      }),
      replaceFallback: Effect.fn("SpendGuard.replaceFallback")(function* (sessionID, fallback) {
        yield* Ref.update(state, (current) => {
          const key = current.active.get(rootIn(current, sessionID))
          const ledger = key === undefined ? undefined : current.ledgers.get(key)
          if (!ledger || key === undefined || !ledger.run.fallback) return current
          const tightened = ledger.run.fallback.tightened
          const budget = tightened ? tighter(fallback, tightened) : fallback
          const warned = ledger.run.warned && ledger.run.budget.usd === budget.usd
          return {
            ...current,
            ledgers: new Map(current.ledgers).set(key, { ...ledger, run: { ...ledger.run, budget, warned } }),
          }
        })
      }),
      ignoreLoops: Effect.fn("SpendGuard.ignoreLoops")(function* (sessionID) {
        yield* Ref.update(state, (current) => {
          const quiet = new Set(current.quiet).add(sessionID)
          const key = current.active.get(sessionID)
          const ledger = key === undefined ? undefined : current.ledgers.get(key)
          if (!ledger || key === undefined) return { ...current, quiet }
          return {
            ...current,
            quiet,
            ledgers: new Map(current.ledgers).set(key, { ...ledger, run: { ...ledger.run, loopRules: false } }),
          }
        })
      }),
      link: Effect.fn("SpendGuard.link")(function* (childID, parentID, options) {
        yield* Ref.update(state, (prior) => {
          const rootID = rootIn(prior, parentID)
          // The root is never bound, so a delegated ledger never stops the main agent.
          if (childID === rootID) return prior
          const delegation = options?.delegated ? delegate(prior, rootID, options.delegated) : undefined
          const current = delegation?.state ?? prior
          const roots = new Map(current.roots).set(childID, rootID)
          const existing = current.bindings.get(childID)
          // Repeated admission may tighten an active child's cap; it never resets the amount already spent.
          if (existing && !options?.renew) {
            const ledgers = new Map(current.ledgers)
            existing.scopes.forEach((key) => {
              const ledger = ledgers.get(key)
              const budget =
                ledger?.kind === "child" && ledger.id === childID
                  ? options?.budget
                  : ledger?.kind === "batch" && ledger.id === options?.batch?.id
                    ? options.batch.budget
                    : undefined
              if (ledger && budget)
                ledgers.set(key, { ...ledger, run: { ...ledger.run, budget: tighter(ledger.run.budget, budget) } })
            })
            const bindings = delegation
              ? new Map(current.bindings).set(childID, {
                  ...existing,
                  scopes: [...new Set([...existing.scopes, delegation.key])],
                })
              : current.bindings
            return { ...current, roots, ledgers, bindings }
          }
          // With no active run of its root, a delegated child counts against its request's ledger as its run, so a
          // resume after a restart, a run the owner started, or a step after the root's run ended is still counted.
          const launch = delegation
            ? (current.bindings.get(parentID)?.run ?? current.active.get(rootID) ?? delegation.key)
            : runKey(current, parentID, true)
          if (launch === undefined) return { ...current, roots }
          const ledgers = new Map(current.ledgers)
          // Nested children inherit their parent's scopes, its delegated ledger among them.
          const scopes = [...(current.bindings.get(parentID)?.scopes ?? []), ...(delegation ? [delegation.key] : [])]
          const batch = options?.batch
          const found = batch
            ? [...ledgers].find(
                ([, ledger]) => ledger.kind === "batch" && ledger.lineage === launch && ledger.id === batch.id,
              )
            : undefined
          const batchKey = batch ? (found?.[0] ?? current.next) : undefined
          if (batch && batchKey !== undefined) {
            ledgers.set(
              batchKey,
              found
                ? { ...found[1], run: { ...found[1].run, budget: tighter(found[1].run.budget, batch.budget ?? {}) } }
                : { kind: "batch", id: batch.id, lineage: launch, run: start(rootID, batch.budget ?? {}, false) },
            )
            scopes.push(batchKey)
          }
          const childKey = current.next + Number(batch !== undefined && !found)
          // The delegated ledger the child runs on when its root has no run is shared and never pauses a loop, so the
          // child's own ledger does: a loop then stops that child alone.
          ledgers.set(childKey, {
            kind: "child",
            id: childID,
            lineage: launch,
            run: start(childID, options?.budget ?? {}, ledgers.get(launch)?.kind === "delegated"),
          })
          scopes.push(childKey)
          return {
            ...current,
            next: childKey + 1,
            roots,
            ledgers,
            bindings: new Map(current.bindings).set(childID, { run: launch, scopes: [...new Set(scopes)], live: true }),
          }
        })
      }),
      release: Effect.fn("SpendGuard.release")(function* (sessionID) {
        yield* Ref.update(state, (current) => {
          const binding = current.bindings.get(sessionID)
          return binding
            ? prune({ ...current, bindings: new Map(current.bindings).set(sessionID, { ...binding, live: false }) })
            : current
        })
      }),
      unlink: Effect.fn("SpendGuard.unlink")(function* (sessionID) {
        yield* Ref.update(state, (current) => {
          const roots = new Map(current.roots)
          const bindings = new Map(current.bindings)
          roots.delete(sessionID)
          bindings.delete(sessionID)
          return prune({ ...current, roots, bindings })
        })
      }),
      rootOf: Effect.fn("SpendGuard.rootOf")(function* (sessionID) {
        return rootIn(yield* Ref.get(state), sessionID)
      }),
      running: Effect.fn("SpendGuard.running")(function* (sessionID) {
        const current = yield* Ref.get(state)
        const key = runKey(current, sessionID)
        return key !== undefined && current.active.get(rootIn(current, sessionID)) === key
      }),
      record,
      changed: Effect.fn("SpendGuard.changed")(function* (sessionID) {
        yield* Ref.update(state, (current) => {
          const key = runKey(current, sessionID)
          const ledger = key === undefined ? undefined : current.ledgers.get(key)
          const loop = ledger?.run.loops.get(sessionID)
          if (!ledger || key === undefined || !loop?.ring.length) return current
          return {
            ...current,
            ledgers: new Map(current.ledgers).set(key, {
              ...ledger,
              run: { ...ledger.run, loops: new Map(ledger.run.loops).set(sessionID, { ...loop, ring: [], stale: [] }) },
            }),
          }
        })
      }),
      resetLoops: Effect.fn("SpendGuard.resetLoops")(function* (sessionID) {
        yield* Ref.update(state, (current) => ({
          ...current,
          ledgers: new Map([
            ...current.ledgers,
            ...keys(current, sessionID).flatMap((key) => {
              const ledger = current.ledgers.get(key)
              if (!ledger?.run.loops.has(sessionID)) return []
              const loops = new Map(ledger.run.loops)
              loops.delete(sessionID)
              return [[key, { ...ledger, run: { ...ledger.run, loops } }] as const]
            }),
          ]),
        }))
      }),
      stopped: Effect.fn("SpendGuard.stopped")(function* (sessionID) {
        const current = yield* Ref.get(state)
        return keys(current, sessionID)
          .map((key) => current.ledgers.get(key)?.run.stopped)
          .find((stop) => stop !== undefined)
      }),
      end: Effect.fn("SpendGuard.end")(function* (rootID) {
        yield* Ref.update(state, (current) => {
          const armed = new Map(current.armed)
          armed.delete(rootID)
          const key = current.active.get(rootID)
          if (key === undefined) return { ...current, armed }
          const active = new Map(current.active)
          active.delete(rootID)
          const last = new Map(current.last)
          last.delete(rootID)
          last.set(rootID, key)
          return prune({ ...current, armed, active, last })
        })
      }),
      snapshot: Effect.fn("SpendGuard.snapshot")(function* (sessionID) {
        const current = yield* Ref.get(state)
        const key = runKey(current, sessionID, true)
        return key === undefined ? undefined : current.ledgers.get(key)?.run
      }),
      scopes: Effect.fn("SpendGuard.scopes")(function* (sessionID) {
        const current = yield* Ref.get(state)
        const key = runKey(current, sessionID, true)
        return [
          ...new Set([...(key === undefined ? [] : [key]), ...(current.bindings.get(sessionID)?.scopes ?? [])]),
        ].flatMap((key) => {
          const ledger = current.ledgers.get(key)
          return ledger ? [snapshotOf(ledger)] : []
        })
      }),
      delegated: Effect.fn("SpendGuard.delegated")(function* (id) {
        const current = yield* Ref.get(state)
        const key = current.delegations.get(id)
        const ledger = key === undefined ? undefined : current.ledgers.get(key)
        return ledger ? snapshotOf(ledger) : undefined
      }),
      rearm: Effect.fn("SpendGuard.rearm")(function* (rootID, input) {
        return yield* Ref.modify(state, (current) => {
          const delegation = delegate(current, rootID, input)
          return [snapshotOf(delegation.ledger), delegation.state] as const
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
