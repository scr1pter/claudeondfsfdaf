// One batch uses the ordinary specialist, permission and session admission paths. Only the
// authenticated caller can supply a previously completed cursor; review reports never choose a batch.
import { createHash } from "node:crypto"
import type { Effect } from "effect"
import type { RulePart } from "@vectordevai/core/review/config"
import { strictIncomplete } from "@vectordevai/core/review/guardrail"
import { codeSpan } from "@vectordevai/core/review/format"
import { renderPatch, type DiffFile } from "@vectordevai/core/review/diff"
import { planReviewBatches, type ReviewBatchPlan } from "@vectordevai/core/review/plan"
import { advanceBatchCursor, batchCoverage, startBatchCursor, type BatchCursor } from "@vectordevai/core/review/state"
import { unfinishedCauses } from "@vectordevai/core/review/verdict"
import type { ReviewConfig, ReviewOutcome } from "@vectordevai/core/review/types"
import type { RunInput } from "./run"

export interface ReviewBatchStore {
  resume(plan: ReviewBatchPlan): BatchCursor | "mismatch" | undefined
  policy?: string
  begin?(plan: ReviewBatchPlan, cursor: BatchCursor): Effect.Effect<void, Error>
  // Called after the final model outcome. The CLI applies the cursor to its existing
  // locked ReviewState and writes finding, cost and coverage updates together.
  spent?(plan: ReviewBatchPlan, monthlyCap?: boolean, headCap?: boolean): number | undefined
  record(plan: ReviewBatchPlan, cursor: BatchCursor, cost: ReviewOutcome["cost"]): void
}

export function exceedsBatchLimits(files: readonly DiffFile[], config: ReviewConfig): boolean {
  if (files.length > config.maxFiles) return true
  let lines = 0
  let chars = 0
  for (const file of files) {
    lines += file.additions + file.deletions
    chars += renderPatch([file]).length + Number(chars > 0)
    if (lines > config.maxChangedLines || chars > config.maxDiffChars) return true
  }
  return false
}

export function activeReviewBatch(
  input: RunInput & { ruleParts?: readonly RulePart[] },
  files: readonly DiffFile[],
  maxDiffChars: number,
  clusters?: ReadonlyMap<string, string>,
  dependents?: ReadonlyMap<string, number>,
) {
  const modelIdentity = (choice?: RunInput["model"]) =>
    choice && [choice.providerID, choice.modelID, choice.variant, choice.context, choice.costKind, choice.price]
  const policy = createHash("sha256")
    .update(
      JSON.stringify([
        input.config,
        input.trust,
        modelIdentity(input.model),
        modelIdentity(input.triage),
        modelIdentity(input.judge),
        input.rules,
        input.ruleParts,
        input.rulesSource,
        input.context.instructions,
        input.context.requirements,
        input.context.teamDismissed,
        input.allowDirs,
        input.readRoot,
        input.identity,
        input.instructionsFromContext,
        input.batchStore?.policy,
        input.readDenies,
        input.admittedReads?.patterns,
        input.skipped,
        input.checks,
      ]),
    )
    .digest("hex")
  const plan = planReviewBatches({
    base: input.base,
    head: input.head,
    files,
    limits: { ...input.config, maxDiffChars },
    clusters,
    dependents,
    policy,
  })
  const previous = (input.restartBatch ?? input.forceFull) ? undefined : input.batchStore?.resume(plan)
  const restored = previous && previous !== "mismatch" && batchCoverage(plan, previous) ? previous : undefined
  const mismatch = previous !== undefined && !restored
  const cursor = restored ?? startBatchCursor(plan)
  const coverage = batchCoverage(plan, cursor)!
  const paths = new Set(coverage.next?.paths)
  return { plan, cursor, coverage, paths, mismatch }
}

export function finishReviewBatch(
  input: RunInput,
  batch: ReturnType<typeof activeReviewBatch>,
  result: ReviewOutcome,
  unavailable: readonly string[],
  reason?: string,
  attempted = true,
): ReviewOutcome {
  const { plan, cursor, coverage } = batch
  // Files deliberately outside this batch cannot prevent this particular batch from completing.
  // A stopped specialist, unreviewed changed line, unreadable strict verdict or held file in it can.
  const worked = result.specialists.some(
    (entry) => (entry.name === "review" || entry.name === "security") && entry.status === "ok",
  )
  const batchOnly = {
    ...result,
    // Strict results include global skipped/held causes. Re-evaluate those below against
    // this batch, retaining the two evidence failures only strict selection can establish.
    strict: result.strict
      ? {
          ...result.strict,
          complete:
            result.strict.complete ||
            (!!result.strict.incomplete?.length &&
              !result.strict.incomplete.some(
                (reason) => reason === "verdict-unreadable" || reason === "blob-unreadable",
              )),
        }
      : undefined,
    skipped: result.skipped.filter((file) => batch.paths.has(file.path)),
    held: result.held?.filter((file) => batch.paths.has(file.path)),
  }
  const next =
    coverage.next && worked && !unfinishedCauses(batchOnly).length
      ? (advanceBatchCursor(plan, cursor, {
          id: coverage.next.id,
          head: plan.head,
          complete: true,
          covered: coverage.next.paths,
        }) ?? cursor)
      : cursor
  const after = batchCoverage(plan, next)!
  const deletedHeld = new Set(result.held?.filter((file) => file.status === "deleted").map((file) => file.path))
  const withheldCoverage = result.skipped
    .filter((file) => file.reason === "size-limit" || (file.reason === "held-back" && !deletedHeld.has(file.path)))
    .map((file) => file.path)
  const unreviewed = [
    ...new Set([
      ...after.unreviewed,
      ...result.unreviewed,
      ...unavailable.filter((path) => !deletedHeld.has(path)),
      ...withheldCoverage,
    ]),
  ]
  const complete = after.complete && !unreviewed.length
  const message = complete
    ? `Completed all ${plan.batches.length} review batches (${after.covered.length} files).`
    : `Partial batch coverage: ${next.completed} of ${plan.batches.length} batches complete; ${unreviewed.length} changed files remain unreviewed.`
  const deferred = new Set(unreviewed)
  const withheld = input.prior.filter((finding) => !batch.paths.has(finding.path))
  const unseen = new Set(withheld.map((finding) => finding.id))
  const strict =
    result.strict && !complete
      ? {
          ...result.strict,
          complete: false,
          incomplete: strictIncomplete(
            { ...result, unreviewed },
            {
              verdict: result.strict.incomplete?.includes("verdict-unreadable") === true,
              blob: result.strict.incomplete?.includes("blob-unreadable") === true,
            },
          ),
        }
      : result.strict
  const selection = {
    ...result.selection,
    ...(!complete ? { diffIncomplete: true as const } : {}),
    ...(strict
      ? { strict: { complete: strict.complete, findingCount: strict.findings.length, dropped: strict.dropped } }
      : {}),
    stillOpen: [
      ...result.selection.stillOpen.filter((finding) => !unseen.has(finding.id)),
      ...withheld.filter((finding) => finding.status === "open"),
    ],
    fixed: result.selection.fixed.filter((finding) => !unseen.has(finding.id)),
    dismissed: result.selection.dismissed.filter((finding) => !unseen.has(finding.id)),
  }
  const { cost, ...review } = result
  if (!batch.mismatch) input.batchStore?.record(plan, next, attempted ? cost : undefined)
  return {
    ...review,
    ...(attempted && cost ? { cost } : {}),
    selection,
    ...(strict ? { strict } : {}),
    report: result.report.priorStatus
      ? { ...result.report, priorStatus: result.report.priorStatus.filter((finding) => !unseen.has(finding.id)) }
      : result.report,
    unreviewed,
    // A zero-attempt transport receipt describes the diff it refused on this invocation.
    // Earlier completed batches remain covered and cannot be reported as newly refused.
    stats:
      result.partial === "budget-estimate"
        ? result.stats
        : {
            files: input.files.length,
            additions: input.files.reduce((n, file) => n + file.additions, 0),
            deletions: input.files.reduce((n, file) => n + file.deletions, 0),
          },
    notes: [
      ...result.notes,
      ...(reason ? [reason] : []),
      message,
      ...(deferred.size
        ? [
            `Unreviewed changes: ${[...deferred].slice(0, 10).map(codeSpan).join(", ")}${deferred.size > 10 ? " …" : ""}.`,
          ]
        : []),
    ],
  }
}
