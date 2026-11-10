// What a prompt evolution run found, as report.json and report.md. For each variant and suite: pass rate, contract
// coverage, mean tokens and modelled US dollars per run, each against the baseline; every sentence the variant removed
// or changed, tagged with the clause it states; and, for the owner to apply by hand, the unified diff against its base.
//
// - candidate (offline): scripted pass rate at least the baseline's, every clause of the base still stated, footprint
//   and replay cost at most the baseline's, and no removed safety sentence that states no clause.
// - promotable: a candidate whose live pass rate is not worse: the lower bound of the 95% bootstrap interval of
//   Δpass (variant - baseline) is at least -DELTA. Offline suites alone never make a variant promotable, since they
//   can only reward deleting text no contract covers.
// - The identity variant must change nothing on the deterministic suites, or the report is invalid. Live, it is a
//   control arm: when its own interval excludes 0, live noise is too high and nothing is promotable.

import { join } from "node:path"
import { SAFETY, clause, coverage, sentences, stated, touches } from "./contracts"
import { MIN_REPEAT, type LiveRun } from "./live"
import { REPO_ROOT, type Variant } from "./variants"

export const DELTA = 0.05
export const SAMPLES = 2_000
export const OFFLINE = ["scripted", "footprint", "replay"] as const
export type Suite = (typeof OFFLINE)[number]

/** One arm's totals in one suite. */
export type Measure = {
  readonly runs: number
  /** Runs that passed: the scripted suite's hidden acceptance tests. */
  readonly passed?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheRead: number
  readonly usd: number
}

export type Arm = {
  readonly suites: Partial<Record<Suite, Measure>>
  readonly live?: readonly LiveRun[]
}

export type Change = {
  readonly kind: "removed" | "changed" | "added"
  readonly before?: string
  readonly after?: string
  /** The clauses the base sentence (or an added one) states, and whether the variant still states each. */
  readonly clauses: readonly { readonly id: string; readonly kept: boolean }[]
  /** The base sentence is in SAFETY. */
  readonly safety: boolean
}

export type Meta = {
  readonly date: string
  readonly revision: string
  readonly command: string
  readonly suites: readonly Suite[]
  readonly live: boolean
  readonly dryRun: boolean
  /** What the live arm was asked for and how far it got. */
  readonly liveRun?: LivePlan
}

/** The live arm's plan and outcome: its pinned model, the tasks and repeats asked for, and the spend cap it stopped at. */
export type LivePlan = {
  readonly model: string
  readonly tasks: readonly string[]
  readonly repeat: number
  readonly maxSpend: number
  readonly spent: number
  /** The cap stopped the run before every arm ran every task and repeat. */
  readonly stopped: boolean
}

type Interval = { readonly mean: number; readonly low: number; readonly high: number }

export async function build(input: {
  readonly meta: Meta
  readonly baseline: Arm
  readonly variants: readonly { readonly variant: Variant; readonly rendered: string; readonly arm: Arm }[]
}) {
  const { createTwoFilesPatch } = await import(Bun.resolveSync("diff", join(REPO_ROOT, "packages", "core")))
  const ran = input.meta.suites.filter((suite) => input.baseline.suites[suite])
  const identity = input.variants.find((item) => item.variant.id === "identity")
  const invalid = identity
    ? ran.flatMap((suite) => {
        const moved = deltas(identity.arm.suites[suite], input.baseline.suites[suite])
        if (!moved) return [`identity did not finish the ${suite} suite`]
        return Object.values(moved).some((value) => value !== 0)
          ? [`identity moved the ${suite} suite: ${JSON.stringify(moved)}`]
          : []
      })
    : ["the identity variant did not run"]
  const control =
    identity?.arm.live && input.baseline.live ? bootstrap(input.baseline.live, identity.arm.live) : undefined
  const noise = control !== undefined && (control.low > 0 || control.high < 0)
  // Every arm compared live needs MIN_REPEAT measured runs of every task asked for (or every task any of them ran): a
  // run the cap stopped, or one whose runs errored, leaves arms with fewer runs and other task mixes than the plan.
  const plan = input.meta.liveRun
  const tasks = plan?.tasks ?? [
    ...new Set(
      [input.baseline, ...input.variants.map((item) => item.arm)].flatMap((arm) =>
        (arm.live ?? []).map((run) => run.task),
      ),
    ),
  ]
  const short = (runs: readonly LiveRun[] | undefined) =>
    tasks.filter((task) => measured(runs ?? []).filter((run) => run.task === task).length < MIN_REPEAT)
  const unfinished = [
    ...(plan?.stopped
      ? [`the live run stopped at the spend cap ($${plan.spent.toFixed(2)} of $${plan.maxSpend}) before it finished`]
      : []),
    ...(input.baseline.live && short(input.baseline.live).length
      ? [`the baseline has fewer than ${MIN_REPEAT} measured live runs of ${short(input.baseline.live).join(", ")}`]
      : []),
    ...(identity?.arm.live && short(identity.arm.live).length
      ? [
          `the identity control has fewer than ${MIN_REPEAT} measured live runs of ${short(identity.arm.live).join(", ")}, so live noise cannot be judged`,
        ]
      : []),
  ]
  const variants = await Promise.all(
    input.variants.map(async (item) => {
      const base = await Bun.file(join(REPO_ROOT, item.variant.base)).text()
      const covered = coverage(item.rendered, item.variant)
      const suites = Object.fromEntries(
        ran.flatMap((suite) => {
          const measure = item.arm.suites[suite]
          return measure ? [[suite, { ...measure, delta: deltas(measure, input.baseline.suites[suite]) }]] : []
        }),
      ) as Partial<Record<Suite, Measure & { delta?: ReturnType<typeof deltas> }>>
      const changed = changes(base, item.rendered, item.variant)
      const live = item.arm.live && input.baseline.live ? bootstrap(input.baseline.live, item.arm.live) : undefined
      const reasons = [
        ...(item.variant.id === "identity" ? ["it is the control arm"] : []),
        ...(invalid.length ? ["the report is invalid"] : []),
        ...OFFLINE.flatMap((suite) =>
          !ran.includes(suite)
            ? [`the ${suite} suite did not run`]
            : item.arm.suites[suite]
              ? []
              : [`it did not finish the ${suite} suite`],
        ),
        ...(ran.includes("scripted") && rate(item.arm.suites.scripted) < rate(input.baseline.suites.scripted)
          ? ["scripted pass rate is below the baseline's"]
          : []),
        ...(covered.missing.length ? [`no longer states ${covered.missing.join(", ")}`] : []),
        ...(["footprint", "replay"] as const).flatMap((suite) =>
          ran.includes(suite) && cost(item.arm.suites[suite]) > cost(input.baseline.suites[suite])
            ? [`costs more than the baseline on ${suite}`]
            : [],
        ),
        ...changed
          .filter((change) => change.safety && change.clauses.length === 0)
          .map((change) => `removes a safety sentence no clause covers: ${change.before}`),
      ]
      const candidate = reasons.length === 0
      const promotion = [
        ...(live ? [] : ["it has no live runs"]),
        ...(live ? unfinished : []),
        ...(live && short(item.arm.live).length
          ? [`it has fewer than ${MIN_REPEAT} measured live runs of ${short(item.arm.live).join(", ")}`]
          : []),
        ...(noise ? ["live noise too high: the identity control moved"] : []),
        ...(live && live.low < -DELTA ? [`live Δpass may be as low as ${live.low.toFixed(3)}, below -${DELTA}`] : []),
      ]
      return {
        id: item.variant.id,
        description: item.variant.description,
        agent: item.variant.agent,
        base: item.variant.base,
        coverage: covered,
        suites,
        ...(live ? { live: { ...live, runs: measured(item.arm.live!).length } } : {}),
        ...(item.arm.live ? { liveRuns: item.arm.live } : {}),
        candidate,
        promotable: candidate && promotion.length === 0,
        reasons: candidate ? promotion : reasons,
        changes: changed,
        patch: createTwoFilesPatch(`a/${item.variant.base}`, `b/${item.variant.base}`, base, item.rendered) as string,
      }
    }),
  )
  return {
    ...input.meta,
    status: input.meta.dryRun ? ("dry-run" as const) : invalid.length ? ("invalid" as const) : ("valid" as const),
    invalid,
    ...(control ? { control: { ...control, noise } } : {}),
    baseline: input.baseline,
    variants,
  }
}

export type Report = Awaited<ReturnType<typeof build>>

/** Base against variant, sentence by sentence: what was removed, changed or added, and the clauses each touches. */
export function changes(base: string, rendered: string, variant: Pick<Variant, "base">): Change[] {
  const before = sentences(base)
  const after = sentences(rendered)
  // Longest common subsequence of sentences; what lies between two kept sentences is one hunk.
  const table = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0))
  const backwards = (length: number) => Array.from({ length }, (_, index) => length - 1 - index)
  for (const i of backwards(before.length))
    for (const j of backwards(after.length))
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const hunks: { removed: string[]; added: string[] }[] = [{ removed: [], added: [] }]
  const at = { i: 0, j: 0 }
  while (at.i < before.length || at.j < after.length) {
    const hunk = hunks.at(-1)!
    if (at.i < before.length && at.j < after.length && before[at.i] === after[at.j]) {
      hunks.push({ removed: [], added: [] })
      at.i += 1
      at.j += 1
      continue
    }
    if (at.j >= after.length || (at.i < before.length && table[at.i + 1]![at.j]! >= table[at.i]![at.j + 1]!)) {
      hunk.removed.push(before[at.i]!)
      at.i += 1
      continue
    }
    hunk.added.push(after[at.j]!)
    at.j += 1
  }
  const safety = new Set(SAFETY.filter((item) => item.source === variant.base).map((item) => item.sentence))
  const tag = (sentence: string) => touches(sentence).map((id) => ({ id, kept: stated(clause(id), rendered) }))
  return hunks.flatMap((hunk) =>
    Array.from({ length: Math.max(hunk.removed.length, hunk.added.length) }, (_, index) => {
      const removed = hunk.removed[index]
      const added = hunk.added[index]
      return {
        kind:
          removed === undefined
            ? ("added" as const)
            : added === undefined
              ? ("removed" as const)
              : ("changed" as const),
        ...(removed === undefined ? {} : { before: removed }),
        ...(added === undefined ? {} : { after: added }),
        clauses: tag(removed ?? added!),
        safety: removed !== undefined && safety.has(removed),
      }
    }),
  )
}

/**
 * The 95% bootstrap interval of the difference in pass rate, variant minus baseline. Runs are resampled within each
 * task, so the mix of tasks stays the same, from a fixed seed, so a report reads the same every time it is built.
 * Only runs that measured something count: unavailable and error runs are not failures.
 */
export function bootstrap(baseline: readonly LiveRun[], variant: readonly LiveRun[], samples = SAMPLES): Interval {
  const a = measured(baseline)
  const b = measured(variant)
  const passRate = (runs: readonly LiveRun[]) =>
    runs.length ? runs.filter((run) => run.outcome === "pass").length / runs.length : 0
  const random = mulberry32(0x5eed)
  const resample = (runs: readonly LiveRun[]) =>
    Object.values(Object.groupBy(runs, (run) => run.task)).flatMap((group) =>
      group!.map(() => group![Math.floor(random() * group!.length)]!),
    )
  const differences = Array.from({ length: samples }, () => passRate(resample(b)) - passRate(resample(a))).toSorted(
    (x, y) => x - y,
  )
  return {
    mean: passRate(b) - passRate(a),
    low: differences[Math.floor(samples * 0.025)]!,
    high: differences[Math.ceil(samples * 0.975) - 1]!,
  }
}

/** Why a report may not be archived under docs/benchmarks, if it may not. */
export function archivable(input: { readonly suites: readonly Suite[]; readonly live: boolean }) {
  if (input.live) return "--archive refuses live results: they are never committed (script/agent-eval/README.md)."
  if (input.suites.includes("replay"))
    return "--archive refuses replay results: they come from your own private traces."
  return undefined
}

export function markdown(report: Report) {
  const money = (value: number | undefined) => (value === undefined ? "" : `$${value.toFixed(6)}`)
  const signed = (value: number | undefined, digits = 0) =>
    value === undefined ? "" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`
  const row = (
    id: string,
    suite: Suite,
    measure: (Measure & { delta?: Record<string, number> }) | undefined,
    covered?: number,
  ) => {
    if (!measure) return []
    const runs = Math.max(1, measure.runs)
    return [
      `| ${id} | ${suite} | ${measure.passed === undefined ? "" : `${measure.passed}/${measure.runs}`} | ${covered === undefined ? "" : `${Math.round(covered * 100)}%`} | ${Math.round(measure.inputTokens / runs)} | ${Math.round(measure.outputTokens / runs)} | ${Math.round(measure.cacheRead / runs)} | ${money(measure.usd / runs)} | ${measure.delta ? signed(measure.delta.inputTokens) : ""} | ${measure.delta ? money(measure.delta.usd) : ""} |`,
    ]
  }
  const label = (variant: Report["variants"][number]) =>
    variant.promotable ? "promotable" : variant.candidate ? "candidate" : "not a candidate"
  return [
    "# Prompt evolution report",
    "",
    `${report.date} · \`${report.revision}\` · \`${report.command}\``,
    "",
    report.status === "dry-run"
      ? "Dry run: the variants were rendered and checked against the contracts, and no suite ran."
      : report.status === "valid"
        ? "Valid: the identity variant changed nothing."
        : `**Invalid**: ${report.invalid.join("; ")}. Nothing in it is a candidate.`,
    ...(report.liveRun
      ? [
          "",
          `Live: \`${report.liveRun.model}\`, ${report.liveRun.repeat} repeats of ${report.liveRun.tasks.join(", ")}, $${report.liveRun.spent.toFixed(4)} spent of $${report.liveRun.maxSpend}.`,
          ...(report.liveRun.stopped
            ? [
                "",
                `**Live run stopped at the spend cap ($${report.liveRun.spent.toFixed(4)} of $${report.liveRun.maxSpend}): nothing is promotable.**`,
              ]
            : []),
          "",
          "Measured live runs per task:",
          "",
          ...[
            { id: "baseline", live: report.baseline.live },
            ...report.variants.map((variant) => ({ id: variant.id, live: variant.liveRuns })),
          ].map(
            (arm) =>
              `- ${arm.id}: ${report.liveRun!.tasks.map((task) => `${task} ${measured(arm.live ?? []).filter((run) => run.task === task).length}`).join(", ")}`,
          ),
        ]
      : []),
    ...(report.control
      ? [
          "",
          `Live control: identity's Δpass is ${signed(report.control.mean, 3)} (95% interval ${report.control.low.toFixed(3)} to ${report.control.high.toFixed(3)})${report.control.noise ? ". Live noise too high: nothing is promotable." : "."}`,
        ]
      : []),
    "",
    "Means per run. Δ is against the baseline (the shipped prompts).",
    "",
    "| Arm | Suite | Pass | Coverage | Input | Output | Cache read | USD | Δ input | Δ USD |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...OFFLINE.flatMap((suite) => row("baseline", suite, report.baseline.suites[suite])),
    ...report.variants.flatMap((variant) =>
      OFFLINE.flatMap((suite) => row(variant.id, suite, variant.suites[suite], variant.coverage.share)),
    ),
    ...report.variants.flatMap((variant) => [
      "",
      `## ${variant.id}: ${label(variant)}`,
      "",
      `${variant.description} Agent \`${variant.agent}\`, base \`${variant.base}\`. It states ${variant.coverage.present.length} of the base's ${variant.coverage.present.length + variant.coverage.missing.length} clauses.`,
      ...(variant.live
        ? [
            "",
            `Live Δpass ${signed(variant.live.mean, 3)} over ${variant.live.runs} runs (95% interval ${variant.live.low.toFixed(3)} to ${variant.live.high.toFixed(3)}).`,
          ]
        : []),
      ...(variant.reasons.length
        ? [
            "",
            ...variant.reasons.map(
              (reason) => `- ${variant.candidate ? "Not promotable" : "Not a candidate"}: ${reason}`,
            ),
          ]
        : []),
      "",
      "### Removed and changed sentences",
      "",
      ...(variant.changes.length
        ? variant.changes.map((change) => {
            // A clause is words, and words can be turned around: a reworded safety sentence is never taken as still
            // saying the same thing without the owner reading it.
            const reworded = change.kind === "changed" && change.safety
            const tags = change.clauses.length
              ? change.clauses
                  .map(
                    (item) =>
                      `${item.id} (${!item.kept ? "dropped" : reworded ? "reworded: read it and confirm it still says the same" : "still stated"})`,
                  )
                  .join(", ")
              : "uncovered"
            const text =
              change.kind === "changed"
                ? `"${change.before}" → "${change.after}"`
                : `"${change.before ?? change.after}"`
            return `- ${change.kind}${change.safety ? " safety sentence" : ""}: ${text} — ${tags}`
          })
        : ["None."]),
      "",
      "### Promotion",
      "",
      `To promote it, apply this to \`${variant.base}\` on a normal branch and open a pull request; the harness never writes under \`packages/\`.`,
      "",
      ...(variant.changes.length ? ["```diff", variant.patch.trimEnd(), "```"] : ["No change to apply."]),
    ]),
    "",
  ].join("\n")
}

// The difference of each mean per run, variant minus baseline.
function deltas(variant: Measure | undefined, baseline: Measure | undefined) {
  if (!variant || !baseline) return undefined
  const mean = (measure: Measure, value: number) => value / Math.max(1, measure.runs)
  const round = (value: number) => Math.round(value * 1e9) / 1e9
  return {
    ...(baseline.passed === undefined ? {} : { passRate: round(rate(variant) - rate(baseline)) }),
    inputTokens: round(mean(variant, variant.inputTokens) - mean(baseline, baseline.inputTokens)),
    outputTokens: round(mean(variant, variant.outputTokens) - mean(baseline, baseline.outputTokens)),
    cacheRead: round(mean(variant, variant.cacheRead) - mean(baseline, baseline.cacheRead)),
    usd: round(mean(variant, variant.usd) - mean(baseline, baseline.usd)),
  }
}

function rate(measure: Measure | undefined) {
  return measure?.passed === undefined ? 0 : measure.passed / Math.max(1, measure.runs)
}

function cost(measure: Measure | undefined) {
  return measure ? measure.usd / Math.max(1, measure.runs) : Infinity
}

function measured(runs: readonly LiveRun[]) {
  return runs.filter((run) => run.outcome === "pass" || run.outcome === "fail")
}

function mulberry32(seed: number) {
  const state = { value: seed }
  return () => {
    state.value = (state.value + 0x6d2b79f5) | 0
    const t = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const u = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((u ^ (u >>> 14)) >>> 0) / 4_294_967_296
  }
}
