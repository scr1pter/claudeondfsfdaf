export * as ConnectFindings from "./findings"

import { Connect } from "@vectordevai/schema/connect"
import { matchPrior } from "../review/select"
import type { Finding, PlacedFinding, PriorFinding, ReviewOutcome, Selection, SkippedFile } from "../review/types"
import { normalizePath } from "./policy"

// VectorScope's results as connect's findings. Connect takes every selection bucket in VectorScope's own order and
// never re-ranks or re-filters; it cuts only at the schema's limit, after the verdict has seen every finding. Comparing
// two reviews of the same target kind labels findings fixed, still open or new: for the working tree and the index
// with core's `matchPrior` over the earlier run's saved findings, for a branch from VectorScope's own state.

/** VectorScope's selection buckets in its own order, with the bucket each becomes. */
export const BUCKETS = [
  ["inline", "inline"],
  ["overflow", "overflow"],
  ["outsideDiff", "outside-diff"],
  ["elsewhere", "elsewhere"],
  ["nits", "nit"],
  ["stillOpen", "still-open"],
] as const satisfies readonly (readonly [keyof Selection, Connect.Bucket])[]

export type Buckets = Pick<Selection, (typeof BUCKETS)[number][0]>

/** Statuses that no longer count: the finding was fixed, or a person dismissed it. */
const SETTLED: ReadonlySet<Connect.FindingStatus> = new Set(["fixed", "dismissed"])

/** Whether a finding still counts toward the verdict and the counts. */
export function active(finding: Pick<Connect.Finding, "status">): boolean {
  return !SETTLED.has(finding.status)
}

/**
 * Every finding of a selection, bucket by bucket in VectorScope's order and in each bucket's own order. Nothing is
 * dropped or re-ranked here; `finish` cuts at the schema's limit once the verdict has seen them all.
 */
export function fromSelection(selection: Buckets): Connect.Finding[] {
  return [
    ...selection.inline.map((finding) => fromFinding(finding, "inline")),
    ...selection.overflow.map((finding) => fromFinding(finding, "overflow")),
    ...selection.outsideDiff.map((finding) => fromFinding(finding, "outside-diff")),
    ...selection.elsewhere.map((finding) => fromFinding(finding, "elsewhere")),
    ...selection.nits.map((finding) => fromFinding(finding, "nit")),
    ...selection.stillOpen.map(fromPrior),
  ]
}

/**
 * One finding from a bucket of the current review. Its suggestion is kept only where VectorScope allowed it (an inline
 * finding whose anchor rules passed), and only when it fits whole: a suggestion is never cut.
 */
export function fromFinding(
  finding: Finding | PlacedFinding,
  bucket: Exclude<Connect.Bucket, "still-open">,
): Connect.Finding {
  const allowed = "suggestionAllowed" in finding && finding.suggestionAllowed
  const suggestion =
    allowed && finding.suggestion !== undefined && finding.suggestion.length <= Connect.MAX_BODY
      ? finding.suggestion
      : undefined
  return {
    id: id(finding.id),
    severity: finding.severity,
    category: finding.category,
    path: path(finding.path),
    ...(line(finding.line) ? { line: finding.line } : {}),
    side: finding.side === "LEFT" ? "LEFT" : "RIGHT",
    title: title(finding.title),
    body: clip(finding.body ?? "", Connect.MAX_BODY),
    source: finding.source === "security" ? "security" : "review",
    ...(finding.verified !== undefined ? { verified: finding.verified } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    bucket,
    status: "open",
  }
}

/**
 * One earlier finding VectorScope's state says is still open. State keeps no body, so it is empty, and its line is
 * absent when GitHub marked the thread outdated. State keeps no source either; it reads as the code reviewer's.
 */
export function fromPrior(prior: PriorFinding): Connect.Finding {
  return {
    id: id(prior.id),
    severity: prior.severity,
    category: prior.category,
    path: path(prior.path),
    ...(prior.line !== null && line(prior.line) ? { line: prior.line } : {}),
    side: prior.side === "LEFT" ? "LEFT" : "RIGHT",
    title: title(prior.title),
    body: "",
    source: "review",
    bucket: "still-open",
    status: "still-open",
  }
}

/** What the verdict reads from VectorScope's outcome. */
export type OutcomeFacts = Pick<ReviewOutcome, "partial" | "specialists" | "unreviewed" | "skipped">

/**
 * The verdict, until VectorScope supplies one. `incomplete` when the changes edit VectorScope's settings (check 1),
 * the outcome is partial, a pass failed, timed out or stopped, a file went unreviewed, or a file was skipped for its
 * size. Then `blocking` when any finding still counting is blocking, in any bucket; `findings` when any is a concern;
 * `clean` otherwise. With no outcome (nothing to review), `not-reviewed`. A partial review is never clean.
 */
export function verdict(input: {
  readonly outcome?: OutcomeFacts
  readonly settingsEdited?: boolean
  readonly findings: readonly Pick<Connect.Finding, "severity" | "status">[]
}): Connect.Verdict {
  if (input.settingsEdited) return "incomplete"
  const outcome = input.outcome
  if (!outcome) return "not-reviewed"
  if (
    outcome.partial !== undefined ||
    outcome.specialists.some(
      (pass) => pass.status === "failed" || pass.status === "timeout" || pass.status === "stopped",
    ) ||
    outcome.unreviewed.length > 0 ||
    outcome.skipped.some((file) => file.reason === "size-limit")
  )
    return "incomplete"
  const counting = input.findings.filter(active)
  if (counting.some((finding) => finding.severity === "blocking")) return "blocking"
  if (counting.some((finding) => finding.severity === "concern")) return "findings"
  return "clean"
}

const SKIP_WORDS: Record<SkippedFile["reason"], string> = {
  ignored: "ignored by the review settings",
  lockfile: "lockfile",
  generated: "generated",
  vendored: "vendored",
  "build-output": "build output",
  binary: "binary",
  deleted: "deleted",
  "size-limit": "too large to review",
}

const PARTIAL_WORDS: Record<NonNullable<ReviewOutcome["partial"]>, string> = {
  budget: "it reached its spend cap",
  steps: "it used all its steps",
  timeout: "it ran out of time",
  "model-error": "the model returned an error",
}

const PASS_WORDS: Record<string, string> = { failed: "failed", timeout: "timed out", stopped: "stopped" }

/** "3 files skipped: generated", one line per reason, in VectorScope's order of reasons. */
export function skipNotes(skipped: readonly Pick<SkippedFile, "reason">[]): string[] {
  const counts = new Map<string, number>()
  for (const file of skipped) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1)
  return Object.entries(SKIP_WORDS).flatMap(([reason, words]) => {
    const count = counts.get(reason) ?? 0
    return count ? [`${count} ${count === 1 ? "file" : "files"} skipped: ${words}`] : []
  })
}

/**
 * Vector's notes about an outcome: why it is incomplete, the files left out, and VectorScope's own deterministic notes.
 * No model wrote any of them.
 */
export function outcomeNotes(outcome: OutcomeFacts & Pick<ReviewOutcome, "notes">): string[] {
  const notes: string[] = []
  if (outcome.partial) notes.push(`The review stopped early because ${PARTIAL_WORDS[outcome.partial]}.`)
  for (const pass of outcome.specialists) {
    const words = PASS_WORDS[pass.status]
    if (words) notes.push(`The ${pass.name} pass ${words}.`)
  }
  if (outcome.unreviewed.length > 0) {
    const shown = outcome.unreviewed.slice(0, 5).map((file) => clip(file, 120))
    const more = outcome.unreviewed.length - shown.length
    notes.push(
      `${outcome.unreviewed.length} ${outcome.unreviewed.length === 1 ? "file was" : "files were"} not reviewed: ${shown.join(", ")}${
        more > 0 ? ` and ${more} more` : ""
      }.`,
    )
  }
  notes.push(...skipNotes(outcome.skipped))
  notes.push(...outcome.notes.map((note) => note.trim()).filter(Boolean))
  return notes.map((note) => clip(note, 1_000)).slice(0, 100)
}

/** The note a cached outcome carries: VectorScope returned its stored review of this commit. */
export function cachedNote(head: string): string {
  return `Already reviewed at ${head.slice(0, 7)}.`
}

/**
 * The findings a result carries: the first 200, with a note when more were found. Call it after the verdict, which
 * counts every finding.
 */
export function finish(findings: readonly Connect.Finding[]): { findings: Connect.Finding[]; notes: string[] } {
  if (findings.length <= Connect.MAX_FINDINGS) return { findings: [...findings], notes: [] }
  return {
    findings: findings.slice(0, Connect.MAX_FINDINGS),
    notes: [`Showing the first ${Connect.MAX_FINDINGS} of ${findings.length} findings.`],
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing two reviews

/** Same target kind, and the same registered task for full task worktree reviews. */
export function comparable(previous: Connect.Target | undefined, current: Connect.Target): boolean {
  return (
    previous !== undefined &&
    previous.kind === current.kind &&
    (current.kind !== "task" || (previous.kind === "task" && previous.task === current.task))
  )
}

/**
 * Labels this review's findings against an earlier working-tree, index or full task review. A finding that matches an
 * earlier one (core's `matchPrior`: by id, then by place and a similar title) is still open, whatever status the
 * earlier run saved: a saved run is session data, and only a person's click dismisses a finding (CW-17), so an
 * earlier `dismissed` never hides a finding this review raised. One that matches none is new. Each earlier finding is
 * claimed once, by the first match in VectorScope's order. An earlier finding nothing matched is fixed, appended with
 * an empty body, but only when its file is still among `changed` (when given): one in a file this review no longer
 * covers is left out with a note, because connect cannot tell. Earlier findings already fixed are not matched again,
 * and an earlier dismissed one nothing matched is left out rather than called fixed.
 */
export function compareWorktree(input: {
  readonly previous: readonly Connect.Finding[]
  readonly current: readonly Connect.Finding[]
  readonly changed?: readonly string[]
}): { findings: Connect.Finding[]; notes: string[] } {
  const available = input.previous.filter((finding) => finding.status !== "fixed").map(asPrior)
  const labelled = input.current.map((finding): Connect.Finding => {
    const located = {
      id: finding.id,
      path: finding.path,
      line: finding.line ?? 0,
      category: finding.category,
      title: finding.title,
      side: finding.side,
    }
    // Without a line, only the id or a similar title can match, as for an earlier finding GitHub marked outdated.
    const pool =
      finding.line === undefined
        ? available.map((entry) => ({ ...entry.prior, line: null }))
        : available.map((entry) => entry.prior)
    const match = matchPrior(located, pool)
    if (!match) return { ...finding, status: "new" }
    const index = pool.indexOf(match)
    available.splice(index, 1)
    return { ...finding, status: "still-open" }
  })
  const changed = input.changed ? new Set(input.changed.flatMap((path) => normalizePath(path) ?? [])) : undefined
  const gone = available.filter((entry) => entry.source.status !== "dismissed")
  const fixed = gone.filter((entry) => !changed || changed.has(normalizePath(entry.source.path) ?? entry.source.path))
  const uncovered = gone.length - fixed.length
  return {
    findings: [...labelled, ...fixed.map((entry) => settle(entry.source))],
    notes:
      uncovered > 0
        ? [
            `${uncovered} earlier ${uncovered === 1 ? "finding is" : "findings are"} in files this review no longer covers, so connect cannot say whether ${uncovered === 1 ? "it is" : "they are"} fixed.`,
          ]
        : [],
  }
}

/**
 * Labels a branch review's findings from VectorScope's own state. Still-open findings come from `stillOpen` (already
 * in the still-open bucket); a finding raised to blocking continues an open one, so it is still open; every other
 * finding of this review is new; and `selection.fixed` lists what this head fixed, appended with an empty body. A fixed
 * finding keeps the bucket it had in the earlier run when that run names it; otherwise it reads as coming from state.
 */
export function compareBranch(input: {
  readonly current: readonly Connect.Finding[]
  readonly selection: Pick<Selection, "fixed" | "raised">
  readonly previous?: readonly Connect.Finding[]
}): { findings: Connect.Finding[]; notes: string[] } {
  const raised = new Set(input.selection.raised.map((entry) => entry.id))
  const labelled = input.current.map((finding): Connect.Finding => {
    if (finding.bucket === "still-open") return { ...finding, status: "still-open" }
    return { ...finding, status: raised.has(finding.id) ? "still-open" : "new" }
  })
  const seen = new Set(labelled.map((finding) => finding.id))
  const earlier = new Map((input.previous ?? []).map((finding) => [finding.id, finding]))
  const fixed = input.selection.fixed
    .map((prior) => {
      const mapped = fromPrior(prior)
      const before = earlier.get(mapped.id)
      return settle(before ? { ...mapped, bucket: before.bucket, source: before.source } : mapped)
    })
    .filter((finding) => !seen.has(finding.id))
  return { findings: [...labelled, ...fixed], notes: [] }
}

/**
 * Compares this review with an earlier one. Only reviews of the same target kind compare; any other pair is refused.
 * Branch reviews read VectorScope's state (`selection`); working-tree, index and full task reviews read the earlier run's
 * saved findings.
 */
export function compare(input: {
  readonly target: Connect.Target
  readonly previous: { readonly target?: Connect.Target; readonly findings: readonly Connect.Finding[] }
  readonly current: readonly Connect.Finding[]
  readonly selection?: Pick<Selection, "fixed" | "raised">
  readonly changed?: readonly string[]
}):
  | { readonly ok: true; readonly findings: Connect.Finding[]; readonly notes: string[] }
  | { readonly ok: false; readonly refusal: Connect.Refusal } {
  if (!comparable(input.previous.target, input.target))
    return {
      ok: false,
      refusal: new Connect.Refusal({
        code: "input",
        message: `That earlier run ${
          input.previous.target ? `reviewed ${targetWords(input.previous.target)}` : "has no review target"
        }, and this review covers ${targetWords(input.target)}. \`since\` compares only reviews of the same kind.`,
      }),
    }
  const compared =
    input.target.kind === "branch"
      ? compareBranch({
          current: input.current,
          selection: input.selection ?? { fixed: [], raised: [] },
          previous: input.previous.findings,
        })
      : compareWorktree({ previous: input.previous.findings, current: input.current, changed: input.changed })
  return { ok: true, ...compared }
}

/** A review target in plain words. */
export function targetWords(target: Connect.Target): string {
  if (target.kind === "uncommitted") return "uncommitted changes"
  if (target.kind === "staged") return "staged changes"
  if (target.kind === "task") return `task ${target.task}’s isolated changes`
  return target.base ? `the branch against ${target.base}` : "the branch against its base"
}

function asPrior(finding: Connect.Finding): { prior: PriorFinding; source: Connect.Finding } {
  return {
    source: finding,
    prior: {
      id: finding.id,
      where: "summary",
      path: finding.path,
      line: finding.line ?? null,
      side: finding.side,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      sha: "",
      status: "open",
    },
  }
}

function settle(finding: Connect.Finding): Connect.Finding {
  const { suggestion: _, ...rest } = finding
  return { ...rest, body: "", status: "fixed" }
}

const CONTROL = /[\u0000-\u001f\u007f]/g

function id(value: string): string {
  const clean = value.replace(CONTROL, "_").slice(0, 200)
  return clean || "finding"
}

function path(value: string): string {
  const clean = value.trim().replace(CONTROL, "")
  return clip(clean || "(no path)", 4_096)
}

function title(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim()
  return clip(clean || "(no title)", 300)
}

function line(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value > 0
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}
