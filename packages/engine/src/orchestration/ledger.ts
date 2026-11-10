import { randomUUID } from "node:crypto"
import { Effect, Option, Schema, Semaphore } from "effect"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionID } from "@vectordevai/schema/session-id"

/** Guard accounting: unpricedSteps counts unknown-price activity only, never Codium. */
export type Usage = {
  readonly spentUsd: number
  readonly steps: number
  readonly unpricedSteps: number
  readonly codiumSteps: number
}
export type Group = { readonly budget: RunBudget.Info; readonly used?: Usage }
export type Stop = SpendGuard.Stop & {
  readonly scope: "group" | "ancestor"
  readonly kind: SpendGuard.ScopeSnapshot["kind"]
  readonly id: string
}
export type View = {
  readonly parentID?: SessionID
  readonly scopes: readonly SpendGuard.ScopeSnapshot[]
  readonly usage: Usage
  readonly groupStop?: Stop
  readonly ancestorStop?: Stop
}
export interface Handle {
  /** Only this returned ID may reach the engine-only task guard-parent marker. */
  readonly parent: (group?: string) => Effect.Effect<SessionID, LedgerError>
  readonly inspect: (group?: string) => Effect.Effect<View, LedgerError>
  readonly snapshot: () => Effect.Effect<Readonly<Record<string, Usage>>, LedgerError>
  /** Join child fibers and checkpoint snapshot() before closing the attempt. */
  readonly close: () => Effect.Effect<void>
}

export class LedgerError extends Schema.TaggedErrorClass<LedgerError>()("WorkflowLedger.LedgerError", {
  code: Schema.Literals(["invalid_usage", "invalid_budget", "missing_lineage", "unknown_group", "stopped", "closed"]),
  message: Schema.String,
  group: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["group", "ancestor"])),
  reason: Schema.optional(RunBudget.StopReason),
}) {}

type Bound = {
  readonly budget: RunBudget.Info
  readonly baseline: Usage
  readonly id?: SessionID
  readonly stopped?: Stop
}
const zero = (): Usage => ({ spentUsd: 0, steps: 0, unpricedSteps: 0, codiumSteps: 0 })

/** Convert durable display rollups, whose unpricedSteps includes Codium, to guard accounting. */
export function fromDisplay(input: {
  readonly cost: number
  readonly steps: number
  readonly unpricedSteps?: number
  readonly codiumSteps?: number
}): Usage {
  return {
    spentUsd: input.cost,
    steps: input.steps,
    unpricedSteps: Math.max(0, (input.unpricedSteps ?? 0) - (input.codiumSteps ?? 0)),
    codiumSteps: input.codiumSteps ?? 0,
  }
}

/**
 * One scoped handle per workflow attempt. The real run has already been linked by
 * TaskTool, with its own remaining budget and the request's delegated ledger.
 * Group names select budgets only; they never supply guard parent identities.
 * Resume passes cumulative group snapshots, then creates fresh remaining scopes.
 */
export const make = Effect.fn("WorkflowLedger.make")(function* (input: {
  readonly guard: SpendGuard.Interface
  readonly runID: SessionID
  readonly groups: Readonly<Record<string, Group>>
}) {
  const groups = new Map<string, Bound>()
  const lock = Semaphore.makeUnsafe(1)
  let closed = false
  const lineage = Effect.gen(function* () {
    const scopes = yield* input.guard.scopes(input.runID)
    if (
      !scopes.some((scope) => scope.kind === "child" && scope.id === input.runID) ||
      !scopes.some((scope) => scope.kind === "delegated")
    )
      return yield* new LedgerError({
        code: "missing_lineage",
        scope: "ancestor",
        message: "The workflow run must retain its own and delegated budget scopes before any child can start.",
      })
    return scopes
  })
  yield* lineage

  const close = Effect.gen(function* () {
    if (closed) return
    closed = true
    for (const group of groups.values()) {
      if (!group.id) continue
      yield* input.guard.release(group.id)
      yield* input.guard.unlink(group.id)
    }
  }).pipe(Effect.uninterruptible, lock.withPermits(1))
  yield* Effect.addFinalizer(() => close)

  for (const [name, group] of Object.entries(input.groups)) {
    const budget = Schema.decodeUnknownOption(RunBudget.Info, { onExcessProperty: "error" })(group.budget)
    if (Option.isNone(budget))
      return yield* new LedgerError({
        code: "invalid_budget",
        group: name,
        message: `Invalid workflow group budget: ${name}.`,
      })
    const baseline = { ...(group.used ?? zero()) }
    if (!validUsage(baseline))
      return yield* new LedgerError({
        code: "invalid_usage",
        group: name,
        message: `Invalid cumulative workflow group usage: ${name}.`,
      })
    const stopped = exhausted(budget.value, baseline, name)
    if (stopped) {
      groups.set(name, { budget: budget.value, baseline, stopped })
      continue
    }
    // Deliberately outside the generated SessionID shape. This private identity
    // has no Session row, prompt, model or externally supplied component.
    const id = SessionID.make(`ses_workflow_group_${randomUUID()}`)
    groups.set(name, { budget: budget.value, baseline, id })
    yield* input.guard.link(id, input.runID, { renew: true, budget: remaining(budget.value, baseline) })
    const inherited = yield* input.guard.scopes(id)
    if (!inherited.some((scope) => scope.kind === "child" && scope.id === id))
      return yield* new LedgerError({
        code: "missing_lineage",
        group: name,
        scope: "ancestor",
        message: "The workflow group could not inherit its run's budget scopes.",
      })
  }

  const inspect = Effect.fn("WorkflowLedger.inspect")(function* (name?: string) {
    if (closed) return yield* new LedgerError({ code: "closed", message: "This workflow ledger attempt is closed." })
    const ancestors = yield* lineage
    const bound = name === undefined ? undefined : groups.get(name)
    if (name !== undefined && !bound)
      return yield* new LedgerError({
        code: "unknown_group",
        group: name,
        message: `Unknown workflow budget group: ${name}.`,
      })
    const scopes = bound?.id ? yield* input.guard.scopes(bound.id) : ancestors
    const ownID = bound?.id ?? (bound ? undefined : input.runID)
    const own = ownID === undefined ? undefined : scopes.find((scope) => scope.kind === "child" && scope.id === ownID)
    if (bound?.id && !own)
      return yield* new LedgerError({
        code: "missing_lineage",
        group: name,
        scope: "ancestor",
        message: "The workflow group lost its budget binding.",
      })
    const ancestor = scopes.find(
      (scope) => scope.stopped && !(bound && scope.kind === "child" && scope.id === bound.id),
    )
    const usage = bound ? plus(bound.baseline, own) : plus(zero(), own)
    const groupStop =
      bound &&
      (bound.stopped ??
        (own?.stopped
          ? { ...own.stopped, scope: "group" as const, kind: own.kind, id: own.id }
          : exhausted(bound.budget, usage, name!)))
    return {
      parentID: bound ? bound.id : input.runID,
      scopes,
      usage,
      ...(groupStop ? { groupStop } : {}),
      ...(ancestor?.stopped
        ? { ancestorStop: { ...ancestor.stopped, scope: "ancestor" as const, kind: ancestor.kind, id: ancestor.id } }
        : {}),
    }
  })
  const handle: Handle = {
    parent: Effect.fn("WorkflowLedger.parent")(function* (name?: string) {
      const view = yield* inspect(name)
      const stopped = view.ancestorStop ?? view.groupStop
      if (stopped)
        return yield* new LedgerError({
          code: "stopped",
          group: name,
          scope: stopped.scope,
          reason: stopped.reason,
          message: stopped.message,
        })
      if (!view.parentID)
        return yield* new LedgerError({
          code: "missing_lineage",
          group: name,
          scope: "ancestor",
          message: "No workflow budget parent is available.",
        })
      return view.parentID
    }, lock.withPermits(1)),
    inspect: (name) => inspect(name).pipe(lock.withPermits(1)),
    snapshot: Effect.fn("WorkflowLedger.snapshot")(function* () {
      if (closed) return yield* new LedgerError({ code: "closed", message: "This workflow ledger attempt is closed." })
      yield* lineage
      const entries: [string, Usage][] = []
      for (const name of groups.keys()) entries.push([name, (yield* inspect(name)).usage])
      return Object.fromEntries(entries)
    }, lock.withPermits(1)),
    close: () => close,
  }
  return handle
})

function validUsage(usage: Usage) {
  return (
    Number.isFinite(usage.spentUsd) &&
    usage.spentUsd >= 0 &&
    [usage.steps, usage.unpricedSteps, usage.codiumSteps].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    usage.unpricedSteps + usage.codiumSteps <= usage.steps
  )
}

function plus(
  baseline: Usage,
  current?: Pick<SpendGuard.ScopeSnapshot, "spentUsd" | "steps" | "unpricedSteps" | "codiumSteps">,
): Usage {
  return {
    spentUsd: baseline.spentUsd + (current?.spentUsd ?? 0),
    steps: baseline.steps + (current?.steps ?? 0),
    unpricedSteps: baseline.unpricedSteps + (current?.unpricedSteps ?? 0),
    codiumSteps: baseline.codiumSteps + (current?.codiumSteps ?? 0),
  }
}

function remaining(budget: RunBudget.Info, used: Usage): RunBudget.Info {
  return {
    ...(budget.usd === undefined ? {} : { usd: budget.usd - used.spentUsd }),
    ...(budget.steps === undefined ? {} : { steps: budget.steps - used.steps }),
    ...(budget.warnAt === undefined ? {} : { warnAt: budget.warnAt }),
    ...(budget.usd === undefined
      ? {}
      : { unpricedSteps: (budget.unpricedSteps ?? SpendGuard.UNPRICED_STEPS) - used.unpricedSteps }),
  }
}

function exhausted(budget: RunBudget.Info, used: Usage, group: string): Stop | undefined {
  const reason =
    budget.steps !== undefined && used.steps >= budget.steps
      ? "steps"
      : budget.usd !== undefined && used.spentUsd >= budget.usd
        ? "cap"
        : budget.usd !== undefined && used.unpricedSteps >= (budget.unpricedSteps ?? SpendGuard.UNPRICED_STEPS)
          ? "unpriced"
          : undefined
  if (!reason) return
  return {
    scope: "group",
    kind: "child",
    id: group,
    reason,
    message: `Workflow group "${group}" reached its ${reason === "cap" ? "spend" : reason === "unpriced" ? "unknown-price step" : "step"} limit.`,
  }
}

export * as WorkflowLedger from "./ledger"
