export * as BrainWorkflow from "./workflow"

import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { makeGlobalNode } from "../effect/app-node"
import type { CostKind } from "../review/types"
import { TaskSize } from "../task-size"
import { Brain } from "./brain"
import { BrainCredit } from "./credit"
import { BrainDatabase } from "./database"
import type { BrainSchema } from "./schema"
import { SkillStore } from "./skill-store"
import { BrainWorkflowRunTable } from "./sql"

// Self-tuned workflows (section 6): for each repository and size, Vector records which effort, subagent split and
// subagent model the build agent ran with, whether its checks passed, and what it cost. Advice may only make work
// cheaper: drop Thorough's size-raised high effort back to the model's default, work without subagents, or give
// `general` subagents the provider's strictly cheaper small model, and only when the runs here say that passes as
// often for at least 20% less. Runs where the user, the agent or config chose are left out, unknown cost is never
// counted as zero, and nothing here touches a spend cap.

/** Checked runs each side needs before advice compares them. */
export const MIN_RUNS = 6
/** How much lower a cheaper setting's pass rate (its lower bound) and checked share may be. */
export const MARGIN = 0.1
/** A cheaper setting costs at most this share of the default's. */
export const CHEAPER = 0.8
/** Exploration tries a cheaper setting on one request in this many. */
export const EXPLORE_EVERY = 10
/** Weight of priced runs each side needs before their dollars are compared. */
export const PRICED_WEIGHT = 3
export const KEEP = { days: 365, rows: 2_000 } as const
/** Runs whose effort someone chose say nothing about Vector's own defaults. */
export const EXCLUDED_SOURCES = ["user", "agent", "config", "explicit", "mixed"] as const

export type Outcome = "pass" | "fail" | "revert" | "none"
export type EffortSource = "size" | "learned" | "explore" | "user" | "agent" | "config" | "explicit" | "mixed"

/** One request of the build agent, numbers only: no prompt or file text. */
export type Observation = {
  readonly sessionID: string
  readonly requestID: string
  readonly at: number
  readonly tier: TaskSize.Tier
  readonly effortTier: TaskSize.Tier
  readonly agent: "build"
  readonly providerID: string
  readonly modelID: string
  readonly effort: string
  readonly effortSource: EffortSource
  readonly subagents: number
  readonly subagentModel?: "parent" | "small" | "mixed"
  readonly subagentModels: Readonly<Record<string, number>>
  readonly judgeRounds: number
  readonly outcome: Outcome
  readonly signal?: "recovered" | "judged" | "judge-fail" | "check-fail"
  /** Unknown unless every step was priced. */
  readonly costUsd?: number
  readonly costKinds: Readonly<Partial<Record<CostKind, number>>>
  readonly steps: number
  readonly unpricedSteps: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
  }
  readonly partial: boolean
  readonly stop?: RunBudget.StopReason
  readonly taint?: BrainSchema.Hold
  readonly advice?: Advice
}

export type Arm = {
  readonly effortTier: TaskSize.Tier
  readonly effort: string
  readonly split: "solo" | "subagents"
  readonly providerID: string
  readonly modelID: string
  readonly subagentModel?: "parent" | "small"
}

export type ArmStats = {
  readonly arm: Arm
  readonly rows: number
  /** Runs weighed by how recent they are (BrainCredit.factor). */
  readonly weight: number
  /** Weight of the runs with an outcome: a check, the judge or a revert. */
  readonly signal: number
  readonly passRate?: number
  /** The pass rate's one-sided Wilson lower bound (z 1.645). */
  readonly lower?: number
  readonly checkedShare: number
  /** Mean dollars over priced runs whose subagents had all finished. */
  readonly costUsd?: number
  readonly pricedWeight: number
  /** Mean tokens (input, output, reasoning and a tenth of cache reads), for effort decisions of one model alone. */
  readonly tokens?: number
  readonly lastAt: number
}

export type Advice = {
  readonly effortTier: TaskSize.Tier
  readonly effort?: "default"
  readonly split?: "solo"
  readonly subagentModel?: "small"
  readonly source: "learned" | "explore"
  readonly reason: string
  readonly basis: { readonly chosen: ArmStats; readonly instead: ArmStats }
}

export type Insights = {
  readonly mode: BrainSchema.WorkflowLearning
  readonly explore: boolean
  readonly tiers: readonly {
    readonly tier: TaskSize.Tier
    readonly arms: readonly ArmStats[]
    readonly advice?: Advice
    /** What would apply if the mode were apply, for Observe only. */
    readonly wouldAdvise?: Advice
    /** Runs left out because someone chose their effort, or they read the web. */
    readonly excluded: number
  }[]
}

/** Each arm's weighted runs, pass rate and cost. Runs someone chose the effort of, or that read the web, are left out. */
export function stats(rows: readonly Observation[], now: number): ArmStats[] {
  return [...Map.groupBy(rows.filter(counted), (row) => JSON.stringify(armOf(row))).values()].map((group) =>
    summary(
      armOf(group[0]!),
      group.map((row) => ({ row, weight: BrainCredit.factor(now - row.at) })),
    ),
  )
}

/**
 * Cheaper defaults for one request, each decided on its own: default effort instead of Thorough's high, working solo
 * instead of with subagents, and the small model for subagents. Each needs at least MIN_RUNS checked runs on both
 * sides, a pass rate whose lower bound is within MARGIN of the default's, as large a checked share within MARGIN, and
 * at most CHEAPER of its cost in dollars (or, for effort alone, in tokens of the same model). With nothing advised and
 * exploration on, one request in EXPLORE_EVERY tries a setting cheaper by construction that has too few runs yet.
 */
export function advise(input: {
  readonly stats: readonly ArmStats[]
  readonly effortTier: TaskSize.Tier
  readonly providerID: string
  readonly modelID: string
  readonly defaultEffort: TaskSize.Effort
  readonly subagentsOffered: boolean
  readonly namedSubagents: boolean
  readonly smallCheaper: boolean
  readonly explore: boolean
  readonly requestID: string
}): Advice | undefined {
  const own = input.stats.filter(
    (item) =>
      item.arm.effortTier === input.effortTier &&
      item.arm.providerID === input.providerID &&
      item.arm.modelID === input.modelID,
  )
  const thorough = input.effortTier === "thorough" && input.subagentsOffered
  const base: Arm = {
    effortTier: input.effortTier,
    effort: input.defaultEffort === "high" ? "high" : "default",
    split: thorough ? "subagents" : "solo",
    providerID: input.providerID,
    modelID: input.modelID,
    ...(thorough ? { subagentModel: "parent" as const } : {}),
  }
  const group = (arm: Arm, test: (item: Arm) => boolean) =>
    merge(
      arm,
      own.filter((item) => test(item.arm)),
    )
  // Lowering Standard's effort would turn thinking on for some providers, so the only effort move is high to default.
  const effort =
    input.defaultEffort === "high"
      ? {
          chosen: group({ ...base, effort: "default" }, (arm) => arm.effort === "default"),
          instead: group({ ...base, effort: "high" }, (arm) => arm.effort === "high"),
        }
      : undefined
  const split =
    thorough && !input.namedSubagents
      ? {
          chosen: group({ ...base, split: "solo", subagentModel: undefined }, (arm) => arm.split === "solo"),
          instead: group(base, (arm) => arm.split === "subagents"),
        }
      : undefined
  const model = input.smallCheaper
    ? {
        chosen: group({ ...base, split: "subagents", subagentModel: "small" }, (arm) => arm.subagentModel === "small"),
        instead: group(
          { ...base, split: "subagents", subagentModel: "parent" },
          (arm) => arm.subagentModel === "parent",
        ),
      }
    : undefined
  const won = {
    effort: effort && wins(effort.chosen, effort.instead, true) ? effort : undefined,
    split: split && wins(split.chosen, split.instead, false) ? split : undefined,
    model: model && wins(model.chosen, model.instead, false) ? model : undefined,
  }
  const basis = won.effort ?? won.split ?? won.model
  if (basis)
    return finish({
      effortTier: input.effortTier,
      ...(won.effort ? { effort: "default" as const } : {}),
      ...(won.split ? { split: "solo" as const } : {}),
      ...(won.model ? { subagentModel: "small" as const } : {}),
      source: "learned",
      basis,
    })
  if (!input.explore || fnv1a(input.requestID) % EXPLORE_EVERY !== 0) return undefined
  // Only settings cheaper by construction are tried: default effort sends no reasoning options, and the small model is
  // strictly cheaper by the catalog. Working solo is not, so it is never explored.
  if (effort && effort.chosen.signal < MIN_RUNS)
    return finish({ effortTier: input.effortTier, effort: "default", source: "explore", basis: effort })
  if (model && model.chosen.signal < MIN_RUNS)
    return finish({ effortTier: input.effortTier, subagentModel: "small", source: "explore", basis: model })
  return undefined
}

/** One plain sentence from the weighted counts behind an advice. */
export function explain(advice: Pick<Advice, "effortTier" | "source" | "basis">) {
  const chosen = advice.basis.chosen
  const instead = advice.basis.instead
  const tier = TaskSize.label(advice.effortTier)
  const names = labels(chosen.arm, instead.arm)
  if (advice.source === "explore")
    return `Trying ${names.chosen} on this ${tier} request to learn whether it passes as often for less: ${Math.round(chosen.signal)} checked runs so far.`
  return `${tier} work here passed ${passes(chosen)} of ${Math.round(chosen.signal)} checked runs ${names.chosen}${cost(chosen)} against ${passes(instead)} of ${Math.round(instead.signal)} ${names.instead}${cost(instead)}.`
}

export interface Interface {
  /** Adds a request's run, or adds a later run of it to the first; keeps a year and 2,000 runs per repository. */
  readonly record: (place: Brain.Place, observation: Observation) => Effect.Effect<void>
  /** The owner reverted these requests, which counts as a failure. */
  readonly reverted: (
    place: Brain.Place,
    input: { readonly sessionID: string; readonly requests: readonly string[] },
  ) => Effect.Effect<number>
  /** Advice for a request, or none unless the mode is apply. */
  readonly advice: (
    place: Brain.Place,
    input: Omit<Parameters<typeof advise>[0], "stats" | "explore">,
  ) => Effect.Effect<Advice | undefined>
  readonly insights: (place: Brain.Place) => Effect.Effect<Insights>
  /** Forgets the repository's runs, or one size's. */
  readonly reset: (place: Brain.Place, input?: { readonly tier?: TaskSize.Tier }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BrainWorkflow") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* BrainDatabase.Service
    const brain = yield* Brain.Service
    const ready = yield* Effect.cached(SkillStore.reconcile(database.db, "all"))
    return make(database.db, brain, ready)
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [BrainDatabase.node, Brain.node] })

const DAY = 24 * 60 * 60 * 1000

function make(db: BrainDatabase.Database, brain: Brain.Interface, ready: Effect.Effect<number>): Interface {
  const rowsOf = (place: Brain.Place, tier?: TaskSize.Tier) =>
    db
      .select()
      .from(BrainWorkflowRunTable)
      .where(
        and(
          eq(BrainWorkflowRunTable.repository_id, place.repository),
          tier ? eq(BrainWorkflowRunTable.effort_tier, tier) : undefined,
        ),
      )
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(toObservation)),
      )

  const record = Effect.fn("BrainWorkflow.record")(function* (place: Brain.Place, observation: Observation) {
    yield* ready
    if ((yield* brain.learnSettings()).workflow === "off") return
    // Unknown is never zero: a run with any step that was not priced has no cost, whatever the caller says.
    const priced =
      observation.unpricedSteps === 0 &&
      Object.entries(observation.costKinds).every(([kind, steps]) => kind === "priced" || !steps)
    const cost = priced ? observation.costUsd : undefined
    const now = Date.now()
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* SkillStore.mark(tx, place.repository)
          const known = yield* tx
            .select()
            .from(BrainWorkflowRunTable)
            .where(
              and(
                eq(BrainWorkflowRunTable.repository_id, place.repository),
                eq(BrainWorkflowRunTable.request_id, observation.requestID),
              ),
            )
            .get()
          const row = {
            repository_id: place.repository,
            session_id: observation.sessionID,
            request_id: observation.requestID,
            at: observation.at,
            tier: observation.tier,
            effort_tier: observation.effortTier,
            agent: observation.agent,
            provider_id: observation.providerID,
            model_id: observation.modelID,
            // A request run more than once at different settings is no evidence for either.
            effort: known && known.effort !== observation.effort ? "mixed" : observation.effort,
            effort_source:
              known && known.effort_source !== observation.effortSource ? ("mixed" as const) : observation.effortSource,
            subagents: (known?.subagents ?? 0) + observation.subagents,
            subagent_model:
              known?.subagent_model && observation.subagentModel && known.subagent_model !== observation.subagentModel
                ? ("mixed" as const)
                : (observation.subagentModel ?? known?.subagent_model ?? null),
            subagent_models: add(known?.subagent_models ?? {}, observation.subagentModels),
            judge_rounds: (known?.judge_rounds ?? 0) + observation.judgeRounds,
            outcome: observation.outcome,
            signal: observation.signal ?? null,
            cost_usd: known
              ? known.cost_usd === null || cost === undefined
                ? null
                : known.cost_usd + cost
              : (cost ?? null),
            cost_kinds: add(known?.cost_kinds ?? {}, observation.costKinds),
            steps: (known?.steps ?? 0) + observation.steps,
            unpriced_steps: (known?.unpriced_steps ?? 0) + observation.unpricedSteps,
            tokens_input: (known?.tokens_input ?? 0) + observation.tokens.input,
            tokens_output: (known?.tokens_output ?? 0) + observation.tokens.output,
            tokens_reasoning: (known?.tokens_reasoning ?? 0) + observation.tokens.reasoning,
            tokens_cache_read: (known?.tokens_cache_read ?? 0) + observation.tokens.cacheRead,
            partial: (known?.partial ?? false) || observation.partial,
            runs: (known?.runs ?? 0) + 1,
            stop: observation.stop ?? null,
            taint: observation.taint ?? known?.taint ?? null,
            advice: observation.advice ?? known?.advice ?? null,
          }
          if (known)
            yield* tx.update(BrainWorkflowRunTable).set(row).where(eq(BrainWorkflowRunTable.id, known.id)).run()
          if (!known) yield* tx.insert(BrainWorkflowRunTable).values(row).run()
          yield* tx
            .delete(BrainWorkflowRunTable)
            .where(
              and(
                eq(BrainWorkflowRunTable.repository_id, place.repository),
                lt(BrainWorkflowRunTable.at, now - KEEP.days * DAY),
              ),
            )
            .run()
          yield* tx
            .delete(BrainWorkflowRunTable)
            .where(
              and(
                eq(BrainWorkflowRunTable.repository_id, place.repository),
                notInArray(
                  BrainWorkflowRunTable.id,
                  tx
                    .select({ id: BrainWorkflowRunTable.id })
                    .from(BrainWorkflowRunTable)
                    .where(eq(BrainWorkflowRunTable.repository_id, place.repository))
                    .orderBy(desc(BrainWorkflowRunTable.at), desc(BrainWorkflowRunTable.id))
                    .limit(KEEP.rows),
                ),
              ),
            )
            .run()
        }),
      )
      .pipe(Effect.orDie)
  })

  const reverted = Effect.fn("BrainWorkflow.reverted")(function* (
    place: Brain.Place,
    input: { readonly sessionID: string; readonly requests: readonly string[] },
  ) {
    yield* ready
    if (input.requests.length === 0) return 0
    const rows = yield* db
      .update(BrainWorkflowRunTable)
      .set({ outcome: "revert" })
      .where(
        and(
          eq(BrainWorkflowRunTable.repository_id, place.repository),
          eq(BrainWorkflowRunTable.session_id, input.sessionID),
          inArray(BrainWorkflowRunTable.request_id, [...input.requests]),
        ),
      )
      .returning({ id: BrainWorkflowRunTable.id })
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

  const advice = Effect.fn("BrainWorkflow.advice")(function* (
    place: Brain.Place,
    input: Omit<Parameters<typeof advise>[0], "stats" | "explore">,
  ) {
    yield* ready
    const settings = yield* brain.learnSettings()
    if (settings.workflow !== "apply") return undefined
    return advise({
      ...input,
      stats: stats(yield* rowsOf(place, input.effortTier), Date.now()),
      explore: settings.workflowExplore,
    })
  })

  const insights = Effect.fn("BrainWorkflow.insights")(function* (place: Brain.Place) {
    yield* ready
    const settings = yield* brain.learnSettings()
    const rows = yield* rowsOf(place)
    const now = Date.now()
    return {
      mode: settings.workflow,
      explore: settings.workflowExplore,
      tiers: (["light", "standard", "thorough"] as const).map((tier) => {
        const own = rows.filter((row) => row.effortTier === tier)
        const arms = stats(own, now)
        // The card shows the model this size ran on most here.
        const top = [...Map.groupBy(arms, (item) => `${item.arm.providerID}/${item.arm.modelID}`).values()]
          .map((items) => ({ arm: items[0]!.arm, weight: items.reduce((sum, item) => sum + item.weight, 0) }))
          .toSorted((a, b) => b.weight - a.weight)[0]?.arm
        const proposal = top
          ? advise({
              stats: arms,
              effortTier: tier,
              providerID: top.providerID,
              modelID: top.modelID,
              defaultEffort: TaskSize.effort(tier),
              subagentsOffered: tier === "thorough",
              namedSubagents: false,
              smallCheaper: arms.some((item) => item.arm.subagentModel === "small"),
              explore: false,
              requestID: "",
            })
          : undefined
        return {
          tier,
          arms,
          ...(proposal && settings.workflow === "apply" ? { advice: proposal } : {}),
          ...(proposal && settings.workflow !== "apply" ? { wouldAdvise: proposal } : {}),
          excluded: own.filter((row) => !counted(row)).length,
        }
      }),
    } satisfies Insights
  })

  const reset = Effect.fn("BrainWorkflow.reset")(function* (
    place: Brain.Place,
    input?: { readonly tier?: TaskSize.Tier },
  ) {
    yield* ready
    const rows = yield* db
      .delete(BrainWorkflowRunTable)
      .where(
        and(
          eq(BrainWorkflowRunTable.repository_id, place.repository),
          input?.tier ? eq(BrainWorkflowRunTable.effort_tier, input.tier) : undefined,
        ),
      )
      .returning({ id: BrainWorkflowRunTable.id })
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

  return { record, reverted, advice, insights, reset }
}

function counted(row: Observation) {
  return (
    !(EXCLUDED_SOURCES as readonly string[]).includes(row.effortSource) &&
    row.effort !== "mixed" &&
    row.subagentModel !== "mixed" &&
    row.taint !== "web"
  )
}

function armOf(row: Observation): Arm {
  return {
    effortTier: row.effortTier,
    effort: row.effort,
    split: row.subagents > 0 ? "subagents" : "solo",
    providerID: row.providerID,
    modelID: row.modelID,
    ...(row.subagents > 0 && (row.subagentModel === "parent" || row.subagentModel === "small")
      ? { subagentModel: row.subagentModel }
      : {}),
  }
}

type Weighed = { readonly row: Observation; readonly weight: number }

function summary(arm: Arm, items: readonly Weighed[]): ArmStats {
  const sum = (list: readonly Weighed[], value: (item: Weighed) => number) =>
    list.reduce((total, item) => total + item.weight * value(item), 0)
  const weight = sum(items, () => 1)
  const checked = items.filter((item) => item.row.outcome !== "none")
  const signal = sum(checked, () => 1)
  // A revert counts as a run that did not pass.
  const passed = sum(
    checked.filter((item) => item.row.outcome === "pass"),
    () => 1,
  )
  const priced = items.filter((item) => item.row.costUsd !== undefined && !item.row.partial)
  const pricedWeight = sum(priced, () => 1)
  const whole = items.filter((item) => !item.row.partial)
  const wholeWeight = sum(whole, () => 1)
  return {
    arm,
    rows: items.length,
    weight,
    signal,
    ...(signal > 0 ? { passRate: passed / signal, lower: wilson(passed / signal, signal) } : {}),
    checkedShare: weight > 0 ? signal / weight : 0,
    ...(pricedWeight > 0 ? { costUsd: sum(priced, (item) => item.row.costUsd!) / pricedWeight } : {}),
    pricedWeight,
    ...(wholeWeight > 0
      ? {
          tokens:
            sum(
              whole,
              (item) =>
                item.row.tokens.input +
                item.row.tokens.output +
                item.row.tokens.reasoning +
                0.1 * item.row.tokens.cacheRead,
            ) / wholeWeight,
        }
      : {}),
    lastAt: Math.max(0, ...items.map((item) => item.row.at)),
  }
}

// The arms that share one side of a decision, as one: their weights added and their means weighed by them.
function merge(arm: Arm, items: readonly ArmStats[]): ArmStats {
  const add = (value: (item: ArmStats) => number) => items.reduce((total, item) => total + value(item), 0)
  const weight = add((item) => item.weight)
  const signal = add((item) => item.signal)
  const passed = add((item) => (item.passRate ?? 0) * item.signal)
  const pricedWeight = add((item) => item.pricedWeight)
  const tokened = items.filter((item) => item.tokens !== undefined)
  const tokenWeight = tokened.reduce((total, item) => total + item.weight, 0)
  return {
    arm,
    rows: add((item) => item.rows),
    weight,
    signal,
    ...(signal > 0 ? { passRate: passed / signal, lower: wilson(passed / signal, signal) } : {}),
    checkedShare: weight > 0 ? signal / weight : 0,
    ...(pricedWeight > 0 ? { costUsd: add((item) => (item.costUsd ?? 0) * item.pricedWeight) / pricedWeight } : {}),
    pricedWeight,
    ...(tokenWeight > 0
      ? { tokens: tokened.reduce((total, item) => total + item.tokens! * item.weight, 0) / tokenWeight }
      : {}),
    lastAt: Math.max(0, ...items.map((item) => item.lastAt)),
  }
}

function wins(chosen: ArmStats, instead: ArmStats, tokens: boolean) {
  if (chosen.signal < MIN_RUNS || instead.signal < MIN_RUNS) return false
  if (chosen.lower === undefined || instead.passRate === undefined) return false
  if (chosen.lower < instead.passRate - MARGIN || chosen.checkedShare < instead.checkedShare - MARGIN) return false
  if (
    chosen.costUsd !== undefined &&
    instead.costUsd !== undefined &&
    chosen.pricedWeight >= PRICED_WEIGHT &&
    instead.pricedWeight >= PRICED_WEIGHT
  )
    return chosen.costUsd <= CHEAPER * instead.costUsd
  // Tokens stand in for dollars only for effort, between arms of one model: subagent splits and models differ in price.
  if (!tokens || chosen.tokens === undefined || instead.tokens === undefined) return false
  return chosen.tokens <= CHEAPER * instead.tokens
}

function finish(input: Omit<Advice, "reason">): Advice {
  return { ...input, reason: explain(input) }
}

/** The one-sided Wilson lower bound of a pass rate over `n` runs, at z 1.645. */
function wilson(rate: number, n: number) {
  const z = 1.645
  return (rate + (z * z) / (2 * n) - z * Math.sqrt((rate * (1 - rate)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n)
}

/** 32-bit FNV-1a, so exploration draws the same way for a request every time it is asked. */
function fnv1a(text: string) {
  return [...new TextEncoder().encode(text)].reduce(
    (hash, byte) => Math.imul(hash ^ byte, 0x01000193) >>> 0,
    0x811c9dc5,
  )
}

function labels(chosen: Arm, instead: Arm) {
  if (chosen.effort !== instead.effort) return { chosen: "at default effort", instead: `at ${instead.effort}` }
  if (chosen.split !== instead.split) return { chosen: "working solo", instead: "with subagents" }
  return { chosen: "with the small model for subagents", instead: "with the main model for subagents" }
}

function passes(stats: ArmStats) {
  return Math.round((stats.passRate ?? 0) * stats.signal)
}

function cost(stats: ArmStats) {
  if (stats.costUsd !== undefined && stats.pricedWeight >= PRICED_WEIGHT) return ` (avg $${stats.costUsd.toFixed(2)})`
  if (stats.tokens !== undefined) return ` (avg ${Math.round(stats.tokens / 1000)}k tokens)`
  return ""
}

function add<K extends string>(a: Readonly<Partial<Record<K, number>>>, b: Readonly<Partial<Record<K, number>>>) {
  return Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => [
      key,
      ((a as Record<string, number>)[key] ?? 0) + ((b as Record<string, number>)[key] ?? 0),
    ]),
  ) as Record<K, number>
}

function toObservation(row: typeof BrainWorkflowRunTable.$inferSelect): Observation {
  return {
    sessionID: row.session_id,
    requestID: row.request_id,
    at: row.at,
    tier: row.tier,
    effortTier: row.effort_tier,
    agent: row.agent,
    providerID: row.provider_id,
    modelID: row.model_id,
    effort: row.effort,
    effortSource: row.effort_source,
    subagents: row.subagents,
    ...(row.subagent_model ? { subagentModel: row.subagent_model } : {}),
    subagentModels: row.subagent_models,
    judgeRounds: row.judge_rounds,
    outcome: row.outcome,
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    costKinds: row.cost_kinds,
    steps: row.steps,
    unpricedSteps: row.unpriced_steps,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
    },
    partial: row.partial,
    ...(row.stop ? { stop: row.stop } : {}),
    ...(row.taint ? { taint: row.taint } : {}),
    ...(row.advice ? { advice: row.advice } : {}),
  }
}
