// What Vector keeps between runs: the markers it writes into GitHub comments, the compact state inside the
// sticky summary, and the rules (section 1.5) that decide what happened to each earlier finding.

import { DEFAULT_MENTIONS, parseReviewCommand } from "./command"
import { Billing } from "@vectordevai/schema/billing"
import { mapLine, touched, type DiffFile } from "./diff"
import type { TeamPattern } from "./prompt"
import { namedLines } from "./select"
import {
  CATEGORIES,
  SEVERITIES,
  type Category,
  type Finding,
  type PriorFinding,
  type ReviewCost,
  type ReviewOutcome,
  type ReviewState,
  type Selection,
  type Severity,
  type Side,
  type SummaryFinding,
} from "./types"

export const SUMMARY_MARKER = "<!-- vector-review:summary -->"
export const MAX_STATE_CHARS = 16_000
export const MAX_SUMMARY_FINDINGS = 60
export const MAX_STATE_TITLE = 60
const MARKER_WORDS = 6
// "The code changed near the anchor" means within this many lines.
const FIX_RADIUS = 5

const SHA = /^[0-9a-f]{7,40}$/
const STATUSES = ["open", "fixed", "dismissed", "outdated"] as const
const SEVERITY_CODE = { blocking: "b", concern: "c", nit: "n" } as const
const DISMISS_PHRASES = ["not an issue", "won't fix", "wontfix", "false positive"]

export function emptyState(): ReviewState {
  return { v: 1, reviews: 0, costUsd: 0, tokens: [0, 0], unreviewed: [], inlinePosted: 0, findings: [] }
}

// ---------------------------------------------------------------------------------------------------------------
// Markers

export function stateMarker(state: ReviewState): string {
  return `<!-- vector-review:state v1 ${encodeState(state)} -->`
}

// Only the last state marker in the sticky comment counts.
export function readState(body: string): ReviewState | undefined {
  const last = [...body.matchAll(/<!-- vector-review:state v1 ([A-Za-z0-9_-]*) -->/g)].at(-1)
  return last ? decodeState(last[1] ?? "") : undefined
}

export function reviewMarker(head: string, run: string): string {
  return `<!-- vector-review:review head=${short(head)} run=${run} -->`
}

export function parseReviewMarker(body: string): { head: string; run: string } | undefined {
  const last = [...body.matchAll(/<!-- vector-review:review head=([0-9a-f]{7,40}) run=([A-Za-z0-9_-]+) -->/g)].at(-1)
  return last ? { head: last[1] ?? "", run: last[2] ?? "" } : undefined
}

export interface FindingMarker {
  id: string
  severity: Severity
  category: Category
  sha: string // the commit the finding was raised on, short
  status: PriorFinding["status"] // "outdated" is written as st=x and also covers a superseded finding
  fixedIn?: string
  words: string[] // normalized title words, at most 6
}

export function findingMarker(marker: FindingMarker): string {
  const status =
    marker.status === "open"
      ? "o"
      : marker.status === "fixed"
        ? `f:${short(marker.fixedIn ?? marker.sha)}`
        : marker.status === "dismissed"
          ? "d"
          : "x"
  const words = marker.words.slice(0, MARKER_WORDS).join(",")
  return `<!-- vector-finding v1 id=${marker.id} sev=${SEVERITY_CODE[marker.severity]} cat=${marker.category} sha=${short(marker.sha)} st=${status}${words ? ` t=${words}` : ""} -->`
}

const FINDING_MARKER =
  /<!-- vector-finding v1 id=([0-9a-f]{12}) sev=([bcn]) cat=([a-z]+) sha=([0-9a-f]{7,40}) st=(o|d|x|f:[0-9a-f]{7,40})(?: t=(\S*))? -->/g

// The last marker in a comment is Vector's own: model text comes before it and has its `<!--` escaped.
export function parseFindingMarker(body: string): FindingMarker | undefined {
  const last = [...body.matchAll(FINDING_MARKER)].at(-1)
  if (!last) return undefined
  const category = CATEGORIES.find((entry) => entry === last[3])
  const severity = SEVERITIES.find((entry) => SEVERITY_CODE[entry] === last[2])
  if (!category || !severity) return undefined
  const st = last[5] ?? "o"
  const marker: FindingMarker = {
    id: last[1] ?? "",
    severity,
    category,
    sha: last[4] ?? "",
    status: st === "o" ? "open" : st === "d" ? "dismissed" : st === "x" ? "outdated" : "fixed",
    words: (last[6] ?? "").split(",").filter(Boolean).slice(0, MARKER_WORDS),
  }
  if (st.startsWith("f:")) marker.fixedIn = st.slice(2)
  return marker
}

// Rewrites the status in a comment's own (last) finding marker; used to mark a finding dismissed, fixed or
// superseded without touching the rest of the comment.
export function setFindingStatus(body: string, status: PriorFinding["status"], fixedIn?: string): string {
  const last = [...body.matchAll(FINDING_MARKER)].at(-1)
  const marker = parseFindingMarker(body)
  if (!last || !marker || last.index === undefined) return body
  const next = findingMarker({
    ...marker,
    status,
    fixedIn: status === "fixed" ? (fixedIn ?? marker.fixedIn) : undefined,
  })
  return body.slice(0, last.index) + next + body.slice(last.index + last[0].length)
}

// Makes any `<!-- vector…` that Vector did not write itself inert. GitHub shows `&lt;!--` as the literal text.
// Applied to model text and to everything the task job posts, so no job can be steered into writing a marker.
export function escapeVectorMarkers(text: string): string {
  return text.replace(/<!--(?=\s*vector)/gi, "&lt;!--")
}

export interface IssueCommentLike {
  id: number
  body?: string | null
  user?: { login?: string | null } | null
}

// The sticky summary is the oldest comment by the bot that carries the summary marker. A newer look-alike, even
// one posted by another workflow using the same token, is ignored.
export function findSticky<C extends IssueCommentLike>(comments: readonly C[], botLogin: string): C | undefined {
  let oldest: C | undefined
  for (const comment of comments) {
    if (comment.user?.login?.toLowerCase() !== botLogin.toLowerCase()) continue
    if (!(comment.body ?? "").includes(SUMMARY_MARKER)) continue
    if (!oldest || comment.id < oldest.id) oldest = comment
  }
  return oldest
}

// The title on the first line of an inline finding comment, open or fixed.
export function inlineTitle(body: string): string | undefined {
  const first = body.replace(/\r\n?/g, "\n").split("\n", 1)[0]?.trim() ?? ""
  const fixed = first.match(/^\*\*Fixed in `[^`]+`\.\*\* ~~(.+)~~$/)
  if (fixed) return fixed[1]
  return first.match(/^(?:\*\*(?:Blocking|Concern)\*\*|Nit) · (.+)$/)?.[1]
}

// ---------------------------------------------------------------------------------------------------------------
// Earlier findings

export interface FindingComment {
  id: number
  body: string
  path: string
  line: number | null // GitHub's current line for the thread; null when GitHub marks it outdated
  side?: Side
  threadId?: string
}

// An inline finding rebuilt from one of Vector's own review comments. Callers pass only bot-authored comments. The
// other places its text names are lines of the commit it was raised on; followAlso moves them to this head.
export function priorFromComment(comment: FindingComment): PriorFinding | undefined {
  const marker = parseFindingMarker(comment.body)
  if (!marker) return undefined
  const prior: PriorFinding = {
    id: marker.id,
    where: "inline",
    path: comment.path,
    line: comment.line,
    side: comment.side ?? "RIGHT",
    severity: marker.severity,
    category: marker.category,
    title: inlineTitle(comment.body) ?? marker.words.join(" "),
    sha: marker.sha,
    status: marker.status,
    commentId: comment.id,
  }
  if (comment.threadId) prior.threadId = comment.threadId
  if (marker.fixedIn) prior.fixedIn = marker.fixedIn
  const also = namedLines(comment.body)
  if (also.length) prior.also = also
  return prior
}

// An earlier finding's other places, moved through `changes` from the commit that named them to this head. A place
// whose code was deleted is left out. A LEFT finding's places are base lines, which do not move.
export function followAlso(prior: PriorFinding, changes: DiffFile[]): PriorFinding {
  if (!prior.also?.length || prior.side === "LEFT") return prior
  return { ...prior, also: followLines(changes, prior.path, prior.also) }
}

function followLines(changes: DiffFile[], path: string, lines: readonly number[]): number[] {
  return lines.flatMap((line) => {
    const mapped = mapLine(changes, path, line)
    return mapped === "deleted" ? [] : [mapped]
  })
}

// Summary-only findings from the state, moved from the last reviewed head to this head. `changes` is the diff between
// those two commits: lines follow it (a line whose code was deleted becomes null), and so does a renamed file's path,
// so the finding still matches by location and nextState writes the new path back.
export function priorFromState(state: ReviewState, changes?: DiffFile[]): PriorFinding[] {
  return state.findings.map((finding) => {
    const mapped = changes && finding.side === "RIGHT" ? mapLine(changes, finding.path, finding.line) : finding.line
    const renamed = changes?.find((file) => file.status === "renamed" && file.oldPath === finding.path)
    const prior: PriorFinding = {
      id: finding.id,
      where: "summary",
      path: renamed?.path ?? finding.path,
      line: mapped === "deleted" ? null : mapped,
      side: finding.side,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      sha: finding.sha,
      status: finding.status,
    }
    if (finding.fixedIn) prior.fixedIn = finding.fixedIn
    const also =
      changes && finding.side === "RIGHT" && finding.also ? followLines(changes, finding.path, finding.also) : finding.also
    if (also?.length) prior.also = also
    return prior
  })
}

// The earlier set: the state's summary findings plus inline findings rebuilt from comments. A comment wins over
// a state entry with the same id, and the newest comment wins among comments, because a finding that returned or
// was raised takes over its earlier id. An open summary entry still wins over a closed (fixed or superseded) comment:
// a finding that took over the id but was listed rather than posted must not vanish.
export function mergePrior(fromState: readonly PriorFinding[], fromComments: readonly PriorFinding[]): PriorFinding[] {
  const merged = new Map<string, PriorFinding>()
  for (const prior of fromState) merged.set(prior.id, prior)
  const comments = [...fromComments].sort((a, b) => (a.commentId ?? 0) - (b.commentId ?? 0))
  for (const prior of comments) {
    const kept = merged.get(prior.id)
    if (
      kept?.where === "summary" &&
      kept.status === "open" &&
      (prior.status === "fixed" || prior.status === "outdated")
    )
      continue
    merged.delete(prior.id)
    merged.set(prior.id, prior)
  }
  return [...merged.values()]
}

export interface ThreadInfo {
  resolved: boolean
  resolvedBy?: string
  reactions?: { content: string; users: string[] }[] // on the finding's own comment
  replies?: { author: string; body: string }[] // people's replies in its thread
}

export interface ClassifyContext {
  head: string
  changes?: DiffFile[] // from the finding's commit, or the last reviewed head, to this head
  headText?: string | null // the file at this head; null when it no longer exists
  modelStatus?: { status: "fixed" | "open"; reason: string }
  thread?: ThreadInfo
  isWriter: (login: string) => boolean // a cached permission lookup
  prAuthor: string
  // The workflow's mentions (its MENTIONS), the App handle included once the workflow bakes it in; DEFAULT_MENTIONS when
  // absent. The route job reads a dismissal with the same list.
  mentions?: string[]
}

export interface ClassifiedPrior extends PriorFinding {
  // The PR author tried to dismiss a blocking security finding. It stays open and the summary says so.
  authorDismissed?: boolean
}

// Applies the rules in section 1.5 to one earlier finding. Only open findings can change: a dismissed finding is
// never raised again, and a fixed one can only come back as a new match (select.ts).
export function classifyPrior(prior: PriorFinding, ctx: ClassifyContext): ClassifiedPrior {
  if (prior.status !== "open") return prior
  const deleted =
    ctx.headText === null || ctx.changes?.some((file) => file.path === prior.path && file.status === "deleted")
  if (deleted) return { ...prior, status: "outdated" }

  // A null line means GitHub marked the thread outdated: the anchored code changed or is gone. A LEFT finding's line
  // is a base line, which `touched` cannot place, so for it only GitHub's outdated mark counts.
  const changed =
    prior.line === null ||
    (prior.side !== "LEFT" && ctx.changes ? touched(ctx.changes, prior.path, prior.line, FIX_RADIUS) : false)
  const thread = ctx.thread
  if (changed && (thread?.resolved || ctx.modelStatus?.status === "fixed"))
    return { ...prior, status: "fixed", fixedIn: short(ctx.head) }

  const signals: string[] = []
  if (thread?.resolved && thread.resolvedBy) signals.push(thread.resolvedBy)
  for (const reaction of thread?.reactions ?? []) if (thumbsDown(reaction.content)) signals.push(...reaction.users)
  for (const reply of thread?.replies ?? [])
    if (dismissReply(reply.body, ctx.mentions ?? DEFAULT_MENTIONS)) signals.push(reply.author)

  // Only writers and the PR author can dismiss. A blocking security finding needs a writer other than the author.
  const guarded = prior.severity === "blocking" && prior.category === "security"
  const author = ctx.prAuthor.toLowerCase()
  let authorDismissed = false
  for (const login of signals) {
    const isAuthor = login.toLowerCase() === author
    if (guarded && isAuthor) {
      authorDismissed = true
      continue
    }
    if (isAuthor || ctx.isWriter(login)) return { ...prior, status: "dismissed", dismissedBy: login }
  }
  return authorDismissed ? { ...prior, authorDismissed: true } : prior
}

function thumbsDown(content: string): boolean {
  const value = content.toLowerCase()
  return value === "thumbs_down" || value === "-1"
}

// A reply starting with one of the phrases, or a `/vector dismiss` command. The command is read by the parser the
// route job runs, with the same mentions, so both jobs agree on it: a quote-reply ending in the command counts,
// "/vector dismissal" does not, and `@<slug> dismiss` counts once the workflow's MENTIONS names the App.
function dismissReply(body: string, mentions: string[]): boolean {
  const text = body.trim().toLowerCase().replace(/’/g, "'")
  return (
    DISMISS_PHRASES.some((phrase) => text.startsWith(phrase)) || parseReviewCommand(body, mentions).kind === "dismiss"
  )
}

// Repository-wide team memory: what the team dismissed on other pull requests. Callers pass Vector's own review
// comments, newest first.
export function teamPatterns(comments: readonly { path: string; body: string }[], max = 30): TeamPattern[] {
  const out: TeamPattern[] = []
  const seen = new Set<string>()
  for (const comment of comments) {
    const marker = parseFindingMarker(comment.body)
    if (!marker || marker.status !== "dismissed" || !marker.words.length) continue
    const slash = comment.path.lastIndexOf("/")
    const dir = slash === -1 ? "" : comment.path.slice(0, slash)
    const key = `${marker.category} ${dir} ${marker.words.join(",")}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ category: marker.category, dir, words: marker.words })
    if (out.length >= max) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// The next state

export interface NextStateInput {
  head: string
  base: string
  mode: ReviewOutcome["mode"]
  now: number
  // No specialist produced output: the head stays where it was so a re-run retries.
  failed?: boolean
  unreviewed?: string[]
  cost?: ReviewCost
  prior?: PriorFinding[] // classified, with current lines
  selection?: Selection // absent for carry and failed runs
  moved?: Finding[] // inline findings GitHub refused, now listed in the summary
  posted?: number // inline comments created by this run
  notedHead?: string
}

export function reviewCostHasCodium(cost: ReviewCost): boolean {
  return cost.kind === "codium" || cost.codium === true || cost.model.split(" + ").some(codiumModel)
}

export function reviewCostIsCodium(cost: ReviewCost): boolean {
  // Explicit mixed activity keeps its own kind. Older summaries had only the provider-qualified model name.
  return cost.kind === "codium" || (cost.codium !== true && cost.model.split(" + ").every(codiumModel))
}

function codiumModel(model: string): boolean {
  return Billing.isCodium(model.trim().split("/")[0])
}

export function nextState(prev: ReviewState | undefined, input: NextStateInput): ReviewState {
  const before = prev ?? emptyState()
  const cost = input.mode === "carry" ? undefined : input.cost
  const codium = cost ? reviewCostHasCodium(cost) : false
  const own = cost && !reviewCostIsCodium(cost) ? cost : undefined
  const tokens = own && (!codium || own.tokensOwnOnly === true) ? own : undefined
  const spent = own?.costUsd ?? 0
  const tokensIn = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0
  const month = monthKey(input.now)
  const next: ReviewState = {
    v: 1,
    reviews: before.reviews + (cost ? 1 : 0),
    costUsd: money(before.costUsd + spent),
    tokens: [before.tokens[0] + tokensIn, before.tokens[1] + (tokens?.output ?? 0)],
    month: { key: month, costUsd: money((before.month?.key === month ? before.month.costUsd : 0) + spent) },
    unreviewed: input.failed ? [...before.unreviewed] : [...new Set(input.unreviewed ?? [])],
    inlinePosted: before.inlinePosted + (input.posted ?? 0),
    findings: summaryFindings(before.findings, input),
  }
  if (before.codiumReviews !== undefined || codium) next.codiumReviews = (before.codiumReviews ?? 0) + (codium ? 1 : 0)
  const head = input.failed ? before.head : input.head
  const base = input.failed ? before.base : input.base
  if (head) next.head = head
  if (base) next.base = base
  if (input.failed) next.failed = true
  const noted = input.notedHead ?? before.notedHead
  if (noted) next.notedHead = noted
  return pruneState(next)
}

export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7)
}

function summaryFindings(previous: readonly SummaryFinding[], input: NextStateInput): SummaryFinding[] {
  const byId = new Map(previous.map((finding) => [finding.id, { ...finding }]))
  for (const prior of input.prior ?? []) {
    const entry = prior.where === "summary" ? byId.get(prior.id) : undefined
    if (!entry) continue
    entry.status = prior.status
    entry.path = prior.path
    if (prior.line !== null) entry.line = prior.line
    if (prior.status === "fixed" && prior.fixedIn) entry.fixedIn = short(prior.fixedIn)
    else delete entry.fixedIn
    if (prior.also?.length) entry.also = prior.also
    else delete entry.also
  }
  const selection = input.selection
  if (!selection) return [...byId.values()]
  // An inline comment now carries these ids, in its own marker.
  for (const finding of selection.inline) byId.delete(finding.id)
  const listed = [...selection.outsideDiff, ...selection.elsewhere, ...selection.nits, ...selection.overflow]
  for (const finding of [...listed, ...(input.moved ?? [])]) {
    byId.delete(finding.id)
    byId.set(finding.id, toSummaryFinding(finding, input.head))
  }
  return [...byId.values()]
}

export function toSummaryFinding(finding: Finding, head: string): SummaryFinding {
  const also = (finding.also ?? []).flatMap((place) => {
    const at = place.lastIndexOf(":")
    const line = Number(place.slice(at + 1))
    return place.slice(0, at) === finding.path && Number.isInteger(line) && line > 0 ? [line] : []
  })
  return {
    id: finding.id,
    path: finding.path,
    line: finding.line,
    side: finding.side,
    severity: finding.severity,
    category: finding.category,
    title: finding.title.slice(0, MAX_STATE_TITLE),
    sha: short(head),
    status: "open",
    ...(also.length ? { also } : {}),
  }
}

// Drops the oldest fixed, dismissed and outdated findings first, then the oldest nits, until at most 60 remain
// and the encoded state fits. If open concerns and blocking findings still do not fit, the oldest of those go
// next, and as a last resort the tail of `unreviewed`.
export function pruneState(state: ReviewState, maxChars = MAX_STATE_CHARS): ReviewState {
  const findings = state.findings.map((finding) =>
    finding.title.length > MAX_STATE_TITLE ? { ...finding, title: finding.title.slice(0, MAX_STATE_TITLE) } : finding,
  )
  const victims = findings
    .map((finding, index) => ({ index, tier: tier(finding) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((victim) => victim.index)
  const dropped = new Set<number>()
  const current = () => ({ ...state, findings: findings.filter((_, index) => !dropped.has(index)) })
  for (const index of victims) {
    const next = current()
    if (next.findings.length <= MAX_SUMMARY_FINDINGS && encodeRaw(next).length <= maxChars) break
    dropped.add(index)
  }
  let next = current()
  while (next.unreviewed.length && encodeRaw(next).length > maxChars)
    next = { ...next, unreviewed: next.unreviewed.slice(0, Math.floor(next.unreviewed.length / 2)) }
  return next
}

function tier(finding: SummaryFinding): number {
  if (finding.status !== "open") return 0
  return finding.severity === "nit" ? 1 : finding.severity === "concern" ? 2 : 3
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding: short keys, a table of paths, severities, categories and statuses as small integers, and full SHAs
// only for head and base, as base64url JSON. encodeState prunes first, so the result is never over 16,000 chars.

// The last two are optional: fixedIn ("" when only the places follow), then the other places' lines.
type CompactFinding = [string, number, number, number, number, number, string, string, number, string?, number[]?]

interface CompactState {
  v: 1
  h?: string
  b?: string
  r: number
  c: number
  k?: number
  t: [number, number]
  m?: [string, number]
  u: number[]
  f?: 1
  n?: string
  i: number
  x?: [string, string, number, number]
  s: CompactFinding[]
  p: string[]
}

export function encodeState(state: ReviewState): string {
  return encodeRaw(pruneState(state))
}

function encodeRaw(state: ReviewState): string {
  const paths = new Map<string, number>()
  const index = (path: string) => {
    const known = paths.get(path)
    if (known !== undefined) return known
    paths.set(path, paths.size)
    return paths.size - 1
  }
  const findings = state.findings.map((finding): CompactFinding => {
    const entry: CompactFinding = [
      finding.id,
      index(finding.path),
      finding.line,
      finding.side === "LEFT" ? 1 : 0,
      SEVERITIES.indexOf(finding.severity),
      CATEGORIES.indexOf(finding.category),
      finding.title,
      short(finding.sha),
      STATUSES.indexOf(finding.status),
    ]
    if (finding.fixedIn || finding.also?.length) entry.push(finding.fixedIn ? short(finding.fixedIn) : "")
    if (finding.also?.length) entry.push(finding.also)
    return entry
  })
  const compact: CompactState = {
    v: 1,
    r: state.reviews,
    c: state.costUsd,
    t: state.tokens,
    u: state.unreviewed.map(index),
    i: state.inlinePosted,
    s: findings,
    p: [...paths.keys()],
  }
  if (state.head) compact.h = state.head
  if (state.base) compact.b = state.base
  if (state.codiumReviews !== undefined) compact.k = count(state.codiumReviews)
  if (state.month) compact.m = [state.month.key, state.month.costUsd]
  if (state.failed) compact.f = 1
  if (state.notedHead) compact.n = state.notedHead
  if (state.inflight) compact.x = [state.inflight.run, state.inflight.head, state.inflight.at, state.inflight.costUsd]
  return toBase64url(JSON.stringify(compact))
}

// Lenient about entries, strict about shape: anything that is not a v1 state decodes to undefined, and a
// malformed finding entry is skipped.
export function decodeState(payload: string): ReviewState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(fromBase64url(payload))
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.v !== 1) return undefined
  const paths = Array.isArray(raw.p) ? raw.p.map((path) => (typeof path === "string" ? path : undefined)) : []
  const tokens = Array.isArray(raw.t) ? raw.t : []
  const state: ReviewState = {
    v: 1,
    reviews: count(raw.r),
    costUsd: amount(raw.c),
    tokens: [count(tokens[0]), count(tokens[1])],
    unreviewed: (Array.isArray(raw.u) ? raw.u : []).flatMap((entry) => {
      const path = typeof entry === "number" ? paths[entry] : undefined
      return path ? [path] : []
    }),
    inlinePosted: count(raw.i),
    findings: (Array.isArray(raw.s) ? raw.s : []).flatMap((entry) => {
      const finding = decodeFinding(entry, paths)
      return finding ? [finding] : []
    }),
  }
  if (isSha(raw.h)) state.head = raw.h
  if (isSha(raw.b)) state.base = raw.b
  if (raw.k !== undefined) state.codiumReviews = count(raw.k)
  if (Array.isArray(raw.m) && typeof raw.m[0] === "string" && /^\d{4}-\d{2}$/.test(raw.m[0]))
    state.month = { key: raw.m[0], costUsd: amount(raw.m[1]) }
  if (raw.f === 1) state.failed = true
  if (isSha(raw.n)) state.notedHead = raw.n
  if (Array.isArray(raw.x) && typeof raw.x[0] === "string" && isSha(raw.x[1]))
    state.inflight = { run: raw.x[0], head: raw.x[1], at: count(raw.x[2]), costUsd: amount(raw.x[3]) }
  return state
}

function decodeFinding(entry: unknown, paths: (string | undefined)[]): SummaryFinding | undefined {
  if (!Array.isArray(entry)) return undefined
  const [id, pathIndex, line, side, severity, category, title, sha, status, fixedIn, also] = entry
  const path = typeof pathIndex === "number" ? paths[pathIndex] : undefined
  const decoded = {
    severity: typeof severity === "number" ? SEVERITIES[severity] : undefined,
    category: typeof category === "number" ? CATEGORIES[category] : undefined,
    status: typeof status === "number" ? STATUSES[status] : undefined,
  }
  if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id) || !path) return undefined
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined
  if (!decoded.severity || !decoded.category || !decoded.status || typeof title !== "string" || !isSha(sha))
    return undefined
  const finding: SummaryFinding = {
    id,
    path,
    line,
    side: side === 1 ? "LEFT" : "RIGHT",
    severity: decoded.severity,
    category: decoded.category,
    title: title.slice(0, MAX_STATE_TITLE),
    sha,
    status: decoded.status,
  }
  if (isSha(fixedIn)) finding.fixedIn = fixedIn
  const places = Array.isArray(also)
    ? also.filter((place): place is number => typeof place === "number" && Number.isInteger(place) && place > 0)
    : []
  if (places.length) finding.also = places
  return finding
}

function toBase64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64url(payload: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("not base64url")
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4)
  const binary = atob(padded)
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function money(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function short(sha: string): string {
  return sha.slice(0, 7)
}
