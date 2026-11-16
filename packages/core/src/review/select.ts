// Noise control: which findings go on lines, which are listed in the summary, and which are dropped. Matching to
// earlier findings is by location first; titles only break ties (section 3.9).

import { anchorText, buildAnchorIndex, lookupFile, resolveAnchor, suggestionAllowed, type DiffFile } from "./diff"
import { normalizeCode, normalizeTitle, titleSimilarity } from "./fingerprint"
import { INJECTION_TITLE, type TeamPattern } from "./prompt"
import {
  SEVERITIES,
  type Anchor,
  type Category,
  type DropReason,
  type Finding,
  type FocusHunk,
  type PlacedFinding,
  type PriorFinding,
  type ReviewConfig,
  type Risk,
  type Selection,
  type Severity,
  type Side,
  type Trust,
} from "./types"

// Lines: how close two findings must be to be the same one, and how close to a focus hunk counts as inside it. The
// strict guardrail's S7 reads it (guardrail.ts), so "the same class within 3 lines" cannot drift from selection.
export const NEAR = 3
// Two nearby findings in one run are the same one only with titles at least this alike (or the same fix or code).
const SAME_TITLE = 0.3
// The same defect reported at several places in one file: titles at least this alike, same category and severity.
const REPEAT_TITLE = 0.6
// An earlier finding whose thread GitHub marked outdated has no line, so it matches by title alone, this alike.
const OUTDATED_TITLE = 0.5
const TEAM_PENALTY = 0.15
const TEAM_SIMILARITY = 0.5
const TEAM_MATCHES = 2
// The per-run inline cap's clamp; the strict guardrail's S8 clamps maxComments the same way.
export const MAX_INLINE = 50
const LARGE_CHANGE = 800

const DROP_ORDER: DropReason[] = [
  "empty",
  "low-confidence",
  "nit",
  "ignored-path",
  "unknown-path",
  "duplicate",
  "dismissed",
  "rejected-by-verify",
  "unconfirmed",
]

export interface SelectInput {
  findings: Finding[]
  anchors: DiffFile[] // the anchoring diff
  head: string
  trust: Trust
  mode: "full" | "incremental"
  config: Pick<ReviewConfig, "minConfidence" | "minSeverity" | "maxComments" | "maxCommentsPerPr" | "suggestions"> &
    Partial<Pick<ReviewConfig, "nits">>
  prior?: PriorFinding[] // classified by classifyPrior, with current head lines
  focus?: FocusHunk[]
  inlinePosted?: number // state.inlinePosted
  ignored?: (path: string) => boolean
  // Resolved ahead of time for paths outside the diff; selection itself is synchronous.
  knownPath?: (path: string) => boolean
  teamDismissed?: TeamPattern[]
  dropped?: { reason: DropReason; count: number }[] // counted before selection, such as rejected-by-verify
  modelRisk?: Risk
  sensitiveChanged?: boolean
  changedLines?: number
}

export function categoryGroup(category: Category): "security" | "other" {
  return category === "security" ? "security" : "other"
}

type Located = Pick<Finding, "path" | "line" | "endLine" | "category" | "title"> & {
  id?: string
  side?: Side
  duplicateOf?: string
}

// New finding N matches earlier finding P when N names P in duplicateOf, when N has P's id (the same fingerprint,
// wherever P is now), or when both are on the same path and side, in the same category group, and N's range is within
// 3 lines of P's current line. Several candidates: the most similar title wins, then the nearest. P with no current
// line (GitHub marked its thread outdated, usually because its line was edited) matches by a title at least half alike.
export function matchPrior(finding: Located, prior: readonly PriorFinding[]): PriorFinding | undefined {
  if (finding.duplicateOf) {
    const named = prior.find((entry) => entry.id === finding.duplicateOf)
    if (named) return named
  }
  if (finding.id) {
    const same = prior.find((entry) => entry.id === finding.id)
    if (same) return same
  }
  let best: { prior: PriorFinding; similarity: number; distance: number } | undefined
  let outdated: { prior: PriorFinding; similarity: number } | undefined
  for (const entry of prior) {
    if (entry.path !== finding.path || entry.side !== (finding.side ?? "RIGHT")) continue
    if (categoryGroup(entry.category) !== categoryGroup(finding.category)) continue
    const similarity = titleSimilarity(finding.title, entry.title)
    if (entry.line === null) {
      if (similarity >= OUTDATED_TITLE && (!outdated || similarity > outdated.similarity))
        outdated = { prior: entry, similarity }
      continue
    }
    const distance = gap(finding.line, finding.endLine ?? finding.line, entry.line, entry.line)
    if (distance > NEAR) continue
    if (!best || similarity > best.similarity || (similarity === best.similarity && distance < best.distance))
      best = { prior: entry, similarity, distance }
  }
  return best?.prior ?? outdated?.prior
}

// A finding like at least two patterns the team dismissed before loses 0.15 confidence.
export function teamPenalty(finding: Pick<Finding, "category" | "title">, patterns: readonly TeamPattern[]): number {
  const words = normalizeTitle(finding.title)
  const matches = patterns.filter(
    (pattern) => pattern.category === finding.category && titleSimilarity(words, pattern.words) >= TEAM_SIMILARITY,
  ).length
  return matches >= TEAM_MATCHES ? TEAM_PENALTY : 0
}

// high: any blocking finding, or a security finding at concern or above. medium: any concern, a sensitive path
// changed with at least one finding, or more than 800 changed lines. The model's own risk can raise the result
// to medium, never to high.
export function computeRisk(input: {
  findings: readonly Pick<Finding, "severity" | "category">[]
  sensitiveChanged?: boolean
  changedLines?: number
  modelRisk?: Risk
}): Risk {
  const { findings } = input
  if (findings.some((f) => f.severity === "blocking" || (f.category === "security" && f.severity === "concern")))
    return "high"
  if (
    findings.some((f) => f.severity === "concern") ||
    (input.sensitiveChanged && findings.length > 0) ||
    (input.changedLines ?? 0) > LARGE_CHANGE
  )
    return "medium"
  return input.modelRisk === "medium" || input.modelRisk === "high" ? "medium" : "low"
}

// Nits are reported only when asked for: `nits: true`, or a minSeverity of "nit".
export function wantsNits(config: Partial<Pick<ReviewConfig, "nits" | "minSeverity">>): boolean {
  return config.nits === true || config.minSeverity === "nit"
}

// A nit, or a style finding short of blocking: what is left out while nits are off.
export function isNit(finding: Pick<Finding, "severity" | "category">): boolean {
  return finding.severity === "nit" || (finding.category === "style" && finding.severity !== "blocking")
}

export function selectFindings(input: SelectInput): Selection {
  const { config } = input
  const asked = wantsNits(config)
  const drops = new Map<DropReason, number>()
  const drop = (reason: DropReason, count = 1) => drops.set(reason, (drops.get(reason) ?? 0) + count)
  for (const entry of input.dropped ?? []) drop(entry.reason, entry.count)

  // 1–3. Empty findings, ignored and unknown paths, low confidence, and nits unless they were asked for. A path
  // written as "./x" or "b/x", or a renamed file's old path, becomes the diff's own path, so matching and anchoring
  // agree.
  const index = buildAnchorIndex(input.anchors)
  const kept: Finding[] = []
  for (const finding of input.findings) {
    const entry = finding.path.trim() ? lookupFile(index, finding.path) : undefined
    const path = entry?.file.path ?? finding.path
    if (!finding.title.trim() || !finding.path.trim()) drop("empty")
    else if (input.ignored?.(path)) drop("ignored-path")
    else if (!entry && input.knownPath && !input.knownPath(path)) drop("unknown-path")
    else if (finding.confidence < config.minConfidence) drop("low-confidence")
    else if (!asked && isNit(finding)) drop("nit")
    else kept.push({ ...finding, path })
  }

  // 4. Dedupe within the run, by id and then by location. The stronger finding is kept. Nearby findings are one only
  // when their titles are alike, they carry the same fix, or two reviewers flagged the same code, so a missing test
  // three lines from a bug stays its own finding. An id leaves the line out, so the same id further down the file is
  // the same defect at another place: the kept finding names it (6b).
  const codes = new Map<Finding, string>()
  const codeOf = (finding: Finding) => {
    let code = codes.get(finding)
    if (code === undefined) {
      const resolved = resolveAnchor(index, finding)
      code = resolved.ok ? normalizeCode(anchorText(index, resolved.anchor)) : ""
      codes.set(finding, code)
    }
    return code
  }
  // Kept finding → the other places it stands for, as "path:line". A duplicate hands over the places it named, and
  // its own place too when it is somewhere else.
  const places = new Map<Finding, string[]>()
  const fold = (into: Finding, finding: Finding, elsewhere = true) =>
    places.set(into, [
      ...(places.get(into) ?? []),
      ...(places.get(finding) ?? []),
      ...(finding.also ?? []),
      ...(elsewhere ? [`${finding.path}:${finding.line}`] : []),
    ])
  const unique: Finding[] = []
  for (const finding of kept.sort(stronger)) {
    const other =
      unique.find(
        (entry) => (entry.id === finding.id && !apart(entry, finding)) || sameFinding(entry, finding, codeOf),
      ) ?? unique.find((entry) => entry.id === finding.id)
    if (!other) {
      unique.push(finding)
      continue
    }
    drop("duplicate")
    fold(other, finding, apart(other, finding))
    // The security reviewer's copy of a defect the code reviewer found keeps the code reviewer's category.
    if (
      other.source === "security" &&
      finding.source === "review" &&
      other.category === "security" &&
      finding.category !== "security"
    )
      other.category = finding.category
  }

  // 5. Team memory, then the threshold again.
  const team = input.teamDismissed ?? []
  const candidates = unique.filter((finding) => {
    const penalty = team.length ? teamPenalty(finding, team) : 0
    if (!penalty) return true
    finding.confidence = Math.round((finding.confidence - penalty) * 100) / 100
    if (finding.confidence >= config.minConfidence) return true
    drop("low-confidence")
    return false
  })

  // 6. Earlier findings. The strongest finding claims a match first. A finding that continues an earlier one (it
  // returned after a fix, or was raised to blocking) takes over the earlier id once it is posted on a line (step 11),
  // so it stays one finding; one that is only listed keeps its own id and leaves the earlier comment alone.
  const prior = input.prior ?? []
  const available = [...prior]
  const continues = new Map<string, { prior: PriorFinding; raised: boolean }>()
  const posting: Finding[] = []
  const claim = (entry: PriorFinding) => available.splice(available.indexOf(entry), 1)
  for (const finding of candidates.sort(order)) {
    const match = matchPrior(finding, available)
    if (!match) {
      // An open comment that already names this place as the same defect covers it, unless it got worse since.
      const named = namedBy(finding, available)
      if (!named || (finding.severity === "blocking" && named.severity !== "blocking")) posting.push(finding)
    } else if (match.status === "outdated") posting.push(finding)
    else if (match.status === "dismissed") drop("dismissed")
    else if (match.status === "fixed" || (finding.severity === "blocking" && match.severity !== "blocking")) {
      claim(match)
      continues.set(finding.id, { prior: match, raised: match.status !== "fixed" })
      posting.push(finding)
    }
    // Otherwise it is still open: counted and listed through `stillOpen`, never commented again.
  }

  // 6b. The same defect at several places in one file is one finding. The strongest keeps its line and names the
  // others in its body, so a repeated pattern is one comment instead of one per occurrence. It runs after earlier
  // findings are matched, so a place the team dismissed never takes a new place with it, and a finding that continues
  // an earlier one stays its own. A finding carried from an earlier review keeps the places it already names.
  const folded: Finding[] = []
  for (const finding of posting) {
    const first = continues.has(finding.id) ? undefined : folded.find((entry) => repeats(entry, finding, codeOf))
    if (!first) {
      folded.push(finding)
      continue
    }
    drop("duplicate")
    fold(first, finding)
  }
  for (const finding of folded) {
    const named = places.get(finding)
    if (!named) continue
    const also = [...new Set([...(finding.also ?? []), ...named])]
      .filter((place) => place !== `${finding.path}:${finding.line}`)
      .toSorted((a, b) => lineOf(a) - lineOf(b))
    if (!also.length) continue
    finding.also = also
    finding.body = withAlso(finding.body, also)
  }

  // 7–9. Anchors, the incremental focus, and severity.
  const outsideDiff: Selection["outsideDiff"] = []
  const elsewhere: Finding[] = []
  const nits: Finding[] = []
  const placed: PlacedFinding[] = []
  for (const finding of folded) {
    const resolved = resolveAnchor(index, finding)
    if (!resolved.ok) outsideDiff.push({ ...finding, reason: resolved.reason })
    else if (
      input.mode === "incremental" &&
      input.focus &&
      finding.severity !== "blocking" &&
      !inFocus(resolved.anchor, input.focus, input.anchors)
    )
      elsewhere.push(finding)
    else if (finding.severity === "nit" || rank(finding.severity) < rank(config.minSeverity)) nits.push(finding)
    else placed.push({ ...finding, anchor: resolved.anchor, suggestionAllowed: false })
  }

  // 10–11. Order, then this run's cap and what is left of the pull request's cap. The first finding about instructions
  // aimed at AI reviewers is posted whatever the caps: it is the one a maintainer most needs to see.
  placed.sort(order)
  const perRun = Math.min(MAX_INLINE, Math.max(0, Math.floor(config.maxComments)))
  const perPr = Math.max(0, config.maxCommentsPerPr - (input.inlinePosted ?? 0))
  const cap = Math.min(perRun, perPr)
  const warning = perRun > 0 ? placed.find(isInjection) : undefined
  const rest = placed.filter((finding) => finding !== warning)
  const inline = [...(warning ? [warning] : []), ...rest.slice(0, cap)].sort(order)
  const overflow: Finding[] = rest.slice(cap)

  // A finding that continues an earlier one takes over its id now that it is on a line.
  const reappeared: string[] = []
  const raised: Selection["raised"] = []
  const superseded = new Set<string>()
  for (const [position, finding] of inline.entries()) {
    const continued = continues.get(finding.id)
    if (!continued) continue
    inline[position] = { ...finding, id: continued.prior.id }
    if (!continued.raised) reappeared.push(continued.prior.id)
    else {
      raised.push({ id: continued.prior.id, was: continued.prior.severity })
      superseded.add(continued.prior.id)
    }
  }

  // 12. Suggestions: the anchor rules (the anchor must be the model's own lines), the setting, and in untrusted mode
  // only after the verify pass confirmed it.
  for (const finding of inline)
    finding.suggestionAllowed =
      finding.suggestion !== undefined &&
      config.suggestions &&
      suggestionAllowed(index, finding.anchor, finding.suggestion, {
        trust: input.trust,
        verified: finding.verified,
        range: { line: finding.line, endLine: finding.endLine },
      })

  const stillOpen = prior.filter((entry) => entry.status === "open" && !superseded.has(entry.id))
  const selection: Selection = {
    inline,
    outsideDiff: outsideDiff.sort(order),
    elsewhere: elsewhere.sort(order),
    nits: nits.sort(order),
    overflow,
    stillOpen,
    fixed: prior.filter((entry) => entry.status === "fixed" && sameCommit(entry.fixedIn, input.head)),
    dismissed: prior.filter((entry) => entry.status === "dismissed"),
    reappeared,
    raised,
    dropped: DROP_ORDER.flatMap((reason) => {
      const count = drops.get(reason) ?? 0
      return count ? [{ reason, count }] : []
    }),
    risk: "low",
  }
  selection.risk = computeRisk({
    findings: [...inline, ...overflow, ...selection.outsideDiff, ...elsewhere, ...nits, ...stillOpen],
    sensitiveChanged: input.sensitiveChanged,
    changedLines: input.changedLines,
    modelRisk: input.modelRisk,
  })
  return selection
}

function rank(severity: Severity): number {
  return SEVERITIES.length - 1 - SEVERITIES.indexOf(severity)
}

// The posting order: severity, then verified, then confidence, then path and line.
function order(a: Finding, b: Finding): number {
  return (
    rank(b.severity) - rank(a.severity) ||
    Number(b.verified === true) - Number(a.verified === true) ||
    b.confidence - a.confidence ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line
  )
}

// Which of two duplicates is kept: the higher severity, then the higher confidence, then verified.
function stronger(a: Finding, b: Finding): number {
  return (
    rank(b.severity) - rank(a.severity) ||
    b.confidence - a.confidence ||
    Number(b.verified === true) - Number(a.verified === true) ||
    order(a, b)
  )
}

// Two findings of one run on the same path and side, within 3 lines, are one when their titles are alike, when they
// carry the same fix, or when different reviewers flagged the same code (whatever category each gave it). The strict
// guardrail's S7 reuses it (guardrail.ts).
export function sameFinding(a: Finding, b: Finding, code: (finding: Finding) => string): boolean {
  if (a.path !== b.path || a.side !== b.side) return false
  if (gap(a.line, a.endLine ?? a.line, b.line, b.endLine ?? b.line) > NEAR) return false
  if (titleSimilarity(a.title, b.title) >= SAME_TITLE) return true
  const fix = (finding: Finding) => (finding.suggestion ?? "").replace(/\s+/g, " ").trim()
  if (fix(a) && fix(a) === fix(b)) return true
  return a.source !== b.source && code(a) !== "" && code(a) === code(b)
}

// One defect repeated further down the same file: what sameFinding leaves apart because the lines are far apart.
// Alike titles are not enough ("Missing null check on user" and "... on session" are two bugs): the code at both
// places, or the fix, must be the same too.
function repeats(a: Finding, b: Finding, code: (finding: Finding) => string): boolean {
  if (a.path !== b.path || a.side !== b.side || a.category !== b.category || a.severity !== b.severity) return false
  if (titleSimilarity(a.title, b.title) < REPEAT_TITLE) return false
  const fix = (finding: Finding) => (finding.suggestion ?? "").replace(/\s+/g, " ").trim()
  return (code(a) !== "" && code(a) === code(b)) || (fix(a) !== "" && fix(a) === fix(b))
}

// The same finding twice on one side of a file, further apart than one place: the same defect in two places.
function apart(a: Finding, b: Finding): boolean {
  return a.side === b.side && gap(a.line, a.endLine ?? a.line, b.line, b.endLine ?? b.line) > NEAR
}

// An open earlier finding whose comment names this finding's place as another place of the same defect.
function namedBy(finding: Finding, prior: readonly PriorFinding[]): PriorFinding | undefined {
  return prior.find(
    (entry) =>
      entry.status === "open" &&
      entry.path === finding.path &&
      entry.side === finding.side &&
      categoryGroup(entry.category) === categoryGroup(finding.category) &&
      titleSimilarity(finding.title, entry.title) >= REPEAT_TITLE &&
      (entry.also ?? []).some((line) => gap(finding.line, finding.endLine ?? finding.line, line, line) <= NEAR),
  )
}

function lineOf(place: string) {
  return Number(place.slice(place.lastIndexOf(":") + 1))
}

// The lines a finding's "also at" sentence names, read back from a comment Vector posted. The last sentence is
// Vector's own: it ends the finding's text.
export function namedLines(text: string): number[] {
  const last = [...text.matchAll(ALSO_LINES)].at(-1)
  return last ? [...(last[1] ?? "").matchAll(/\d+/g)].map((match) => Number(match[0])) : []
}

const ALSO_LINES = /The same problem is also at lines? ((?:\d+, )*\d+(?: and \d+)?)\./g

// "path:line" entries of one file, as the sentence a reader sees under the finding. A sentence written by an earlier
// fold is replaced, so a carried finding never lists a place twice.
function withAlso(body: string, also: readonly string[]): string {
  const lines = [...new Set(also.map(lineOf))].toSorted((a, b) => a - b)
  const list = lines.length === 1 ? lines[0] : `${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`
  const sentence = `The same problem is also at ${lines.length === 1 ? "line" : "lines"} ${list}.`
  const own = body.replace(ALSO_SENTENCE, "").trim()
  return own ? `${own}\n\n${sentence}` : sentence
}

const ALSO_SENTENCE = /\s*The same problem is also at lines? [\d, ]+(?: and \d+)?\.\s*$/

function isInjection(finding: Finding): boolean {
  return finding.title.trim().toLowerCase() === INJECTION_TITLE.toLowerCase()
}

// 0 when the ranges overlap, otherwise the number of lines between them. S7's class clause measures with it too.
export function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd
  if (bEnd < aStart) return aStart - bEnd
  return 0
}

function inFocus(anchor: Anchor, focus: readonly FocusHunk[], files: readonly DiffFile[]): boolean {
  const [start, end] = headRange(anchor, files)
  return focus.some((hunk) => hunk.path === anchor.path && gap(start, end, hunk.start, hunk.end) <= NEAR)
}

// A removed line has no head line number, so it counts at the head range of the hunk it sits in.
function headRange(anchor: Anchor, files: readonly DiffFile[]): [number, number] {
  if (anchor.side === "RIGHT") return [anchor.startLine ?? anchor.line, anchor.line]
  const hunk = files
    .find((file) => file.path === anchor.path)
    ?.hunks.find((entry) => anchor.line >= entry.oldStart && anchor.line < entry.oldStart + Math.max(1, entry.oldLines))
  if (!hunk) return [anchor.line, anchor.line]
  return [hunk.newStart, hunk.newStart + Math.max(0, hunk.newLines - 1)]
}

function sameCommit(a: string | undefined, b: string): boolean {
  return Boolean(a) && (a!.startsWith(b) || b.startsWith(a!))
}
