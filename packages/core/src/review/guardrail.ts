// The strict guardrail (VectorScope contract §1.2 and §4 VS-27b, Now window): which verified findings a strict review
// keeps, as a StrictResult with what it dropped and whether the run finished. Pure and browser-safe, and no runner calls
// it before VS-27c. It reads no file and does no other I/O: the engine reads the head and base blobs strictBlobRequests
// names and hands them in, so the reads of the head and base trees, and their containment checks (I-8), stay in the
// engine.
//
// A candidate is kept only when all of these hold, checked in this order (types.ts STRICT_DROPS):
// - S1: it was verified, by the model or at runtime. A verify verdict that could not be read drops it as
//   `verdict-unreadable` and marks the result incomplete, as does one whose finding was not handed in; it is never
//   kept by default (Kodus issue #1937).
// - S2: its severity is readable and blocking, and its failure block names one of the five classes.
// - S3: it is anchored on a changed line: a RIGHT line the change added or one next to a deletion, or a LEFT line it
//   removed, at the model's own lines (a line snapped onto a nearby hunk does not count).
// - S4: at least one quote is its file's text at its line, apart from whitespace (quoteMatches).
// - S5: its trigger and impact are present, each at most 400 characters.
// - S6: it has a fix text. A committable suggestion under the existing rules is kept as one, and a patch of at most 3
//   hunks that applies to head at its own positions, and leaves a parseable file parsing, as a patch; any other fix is
//   kept as an unchecked plain diff, counted in fixUnchecked (C-14, Q17).
// - S7: no stronger finding already kept is the same one: the same id, sameFinding, or the same class within 3 lines.
// - S8: it falls within maxComments.

import {
  anchorText,
  applyFixPatch,
  buildAnchorIndex,
  lookupFile,
  resolveAnchor,
  suggestionAllowed,
  touched,
  type AnchorIndex,
  type DiffFile,
} from "./diff"
import { normalizeCode } from "./fingerprint"
import { ESCAPING_PATH, MAX_FAILURE_TEXT_CHARS, MAX_SUGGESTION_CHARS } from "./schema"
import { gap, MAX_INLINE, NEAR, sameFinding } from "./select"
import {
  STRICT_DROPS,
  type Anchor,
  type FailureClass,
  type Finding,
  type Quote,
  type ReviewConfig,
  type Side,
  type StrictDrop,
  type StrictFinding,
  type StrictResult,
  type Trust,
} from "./types"
import { unfinishedCauses, type UnfinishedCause, type VerdictCoverage } from "./verdict"

// S6: a fix patch has at most this many hunks.
export const MAX_FIX_HUNKS = 3

// Why a strict result is incomplete, in this order: verdict.ts's unfinished causes (apart from its strict flag, which
// this result is), then a verify verdict that could not be read (S1), then a file the engine could not read that left
// a finding with no matching quote (S4).
export type StrictIncomplete = Exclude<UnfinishedCause, "strict-incomplete"> | "verdict-unreadable" | "blob-unreadable"

// One file as the engine read it at one commit: its text, `{ absent: true }` when that commit's tree has no such file,
// or null when it could not be read. A path left out of the map reads as null, so a read the engine forgot fails
// closed: a quote on it marks the result incomplete instead of reading as a plain mismatch.
export type StrictBlob = string | null | { absent: true }

export interface StrictBlobs {
  head: ReadonlyMap<string, StrictBlob> // keyed by path at the head commit, as strictBlobRequests names them
  base: ReadonlyMap<string, StrictBlob> // keyed by path at the base commit
}

export interface StrictInput {
  head: string // the head commit, StrictResult.head
  anchors: DiffFile[] // the anchoring diff, as SelectInput.anchors
  blobs: StrictBlobs
  config: Pick<ReviewConfig, "maxComments" | "suggestions">
  trust: Trust
  verifier: string // the "provider/model" of the verify pass
  // The ids sent to verify that came back with no readable verdict (plan.ts's verifyUnanswered). Required, so a caller
  // cannot turn unreadable verdicts into plain unverified ones by leaving it out; [] when there are none. Any id here
  // that no finding in the list confirms marks the result incomplete, whether or not its finding was handed in (I-7),
  // so a caller that narrows the list first (selection folding a duplicate, or minConfidence) cannot hide one.
  unanswered: readonly string[]
  coverage: VerdictCoverage // what the run covered: partial, unreviewed, skipped, specialists, held
  // S6's parse check, which core cannot run (the parser is the engine's, VS-25a): whether `text` parses as the file at
  // `path`, or undefined when its language is not parseable. Absent: no parse check. It should return, not throw, on a
  // time limit or a grammar failure; a throw leaves that one patch unchecked, never failing the whole selection.
  parses?: (path: string, text: string) => boolean | undefined
}

// The head and base paths strictSelect reads for these findings, as the keys StrictBlobs must hold: each quote's file
// on its own side, and the head file of each finding with a patch on a file in the diff (S3 drops any other before S6
// reads it). Paths resolve as strictSelect resolves them (a diff path at head, a renamed file's old path at base, a
// path outside the diff as written), so VS-27c, VS-42 and VS-44 ask for the same keys. A path that could leave the
// repository (schema.ts ESCAPING_PATH) is never named, for findings built without decodeReport too; strictSelect reads
// it as a file the tree lacks. Containment against the tree-ish stays the engine's (I-8).
export function strictBlobRequests(
  findings: readonly Finding[],
  anchors: DiffFile[],
): { head: string[]; base: string[] } {
  const index = buildAnchorIndex(anchors)
  const wanted = findings
    .flatMap((finding) => [
      ...(finding.quotes ?? []).map((quote) => blobKey(index, quote.path, quote.side)),
      ...(finding.patch !== undefined && lookupFile(index, finding.path)
        ? [blobKey(index, finding.path, "RIGHT")]
        : []),
    ])
    .filter((entry) => !ESCAPING_PATH.test(entry.path))
  const keys = (side: Side) =>
    [...new Set(wanted.filter((entry) => entry.side === side).map((entry) => entry.path))].toSorted()
  return { head: keys("RIGHT"), base: keys("LEFT") }
}

// S4's matcher, exported for VS-42's preExistingSuspect and VS-44's certified() (I-10): whether a quote's code is the
// text of its file at its line, apart from whitespace. A RIGHT quote reads `head` and a LEFT quote `base`; a text that
// is missing or null never matches. Whitespace-only lines at the quote's start and end are left out first, its line
// moving past those at the start (as decodeQuote moves past empty ones), so a quote that was not cleaned matches too.
// Its remaining n lines are compared with the file's lines from that line on, n of them inside the file, with all
// whitespace removed from every line on both sides (as patchIdOf compares lines) and blank lines dropped, so CRLF,
// indentation and spacing never matter, including spacing present on one side only. Nothing else is forgiven. A quote
// with no letter or digit (a lone `}` or `);`) matches nothing: it matches almost any file, so it is no evidence the
// model read the code. It is positional: to ask whether head code also appears in base (VS-42), map its line to the
// base first (diff.ts mapLine) and pass a LEFT quote at that line.
export function quoteMatches(quote: Quote, text: { head?: string | null; base?: string | null }): boolean {
  const file = quote.side === "LEFT" ? text.base : text.head
  return typeof file === "string" && matchAt(file.split(LINE_BREAK), quote)
}

export function strictSelect(findings: readonly Finding[], input: StrictInput): StrictResult {
  const index = buildAnchorIndex(input.anchors)
  const lines = new Map<string, readonly string[] | "absent" | "unreadable">()
  const read = (side: Side, path: string) => {
    const key = `${side}\n${path}`
    const cached = lines.get(key)
    if (cached !== undefined) return cached
    const blob = ESCAPING_PATH.test(path)
      ? { absent: true }
      : ((side === "RIGHT" ? input.blobs.head : input.blobs.base).get(path) ?? null)
    const value = typeof blob === "string" ? blob.split(LINE_BREAK) : blob === null ? "unreadable" : "absent"
    lines.set(key, value)
    return value
  }
  // The parse check; one that throws reads as "threw", which leaves that patch unchecked.
  const parse = (path: string, text: string) => {
    if (!input.parses) return undefined
    try {
      return input.parses(path, text)
    } catch {
      return "threw" as const
    }
  }
  const headParses = new Map<string, ReturnType<typeof parse>>()
  const parsesAtHead = (path: string, text: string) => {
    if (!headParses.has(path)) headParses.set(path, parse(path, text))
    return headParses.get(path)
  }
  // S6(ii): the patch applies to the head file of a diff file at its own positions, and a file that parsed at head
  // still parses. A parse check that threw on either text passes nothing.
  const patched = (path: string | undefined, patch: string) => {
    if (path === undefined || ESCAPING_PATH.test(path)) return false
    const head = input.blobs.head.get(path)
    if (typeof head !== "string") return false
    const applied = applyFixPatch(head, patch, { path, maxHunks: MAX_FIX_HUNKS })
    if (!applied.ok) return false
    const before = parsesAtHead(path, head)
    if (before === "threw") return false
    if (before !== true) return true
    const after = parse(path, applied.text)
    return after !== false && after !== "threw"
  }
  const candidates = findings.map((original): StrictCandidate => {
    const finding = { ...original, path: lookupFile(index, original.path)?.file.path ?? original.path }
    const resolved = resolveAnchor(index, finding)
    const anchor = resolved.ok ? resolved.anchor : undefined
    const quotes = (finding.quotes ?? []).map((quote) => {
      const key = blobKey(index, quote.path, quote.side)
      return { quote: { ...quote, path: key.path }, file: read(quote.side, key.path) }
    })
    return {
      finding,
      scoped: finding.failure !== undefined,
      anchored: anchor !== undefined && onChangedLine(input.anchors, finding, anchor),
      quotes: {
        matched: quotes.flatMap((entry) =>
          Array.isArray(entry.file) && matchAt(entry.file, entry.quote) ? [entry.quote] : [],
        ),
        unreadable: quotes.some((entry) => entry.file === "unreadable"),
      },
      impact: finding.failure !== undefined && bounded(finding.failure.trigger) && bounded(finding.failure.impact),
      fix: () => {
        const suggestion = fixText(finding.suggestion)
        if (
          suggestion !== undefined &&
          anchor !== undefined &&
          input.config.suggestions &&
          suggestionAllowed(index, anchor, suggestion, {
            trust: input.trust,
            verified: true,
            range: { line: finding.line, endLine: finding.endLine },
          })
        )
          return { kind: "suggestion", text: suggestion }
        const patch = fixText(finding.patch)
        if (patch !== undefined && patched(lookupFile(index, finding.path)?.file.path, patch))
          return { kind: "patch", text: patch }
        const text = patch ?? suggestion
        return text === undefined ? undefined : { kind: "unchecked", text }
      },
      code: anchor ? normalizeCode(anchorText(index, anchor)) : "",
      ...(finding.failure ? { failureClass: finding.failure.class } : {}),
    }
  })
  const pass = strictRules(candidates, { maxComments: input.config.maxComments, unanswered: input.unanswered })
  const kept = pass.kept.flatMap((entry): StrictFinding[] => {
    const failure = entry.finding.failure
    if (!failure || !entry.quotes) return []
    const endLine = endLineOf(entry.finding)
    return [
      {
        id: entry.finding.id,
        class: failure.class,
        mechanism: failure.mechanism,
        path: entry.finding.path,
        line: entry.finding.line,
        ...(endLine !== undefined ? { endLine } : {}),
        side: entry.finding.side,
        title: entry.finding.title,
        trigger: failure.trigger,
        impact: failure.impact,
        quotes: entry.quotes,
        fix: entry.fix,
        verifiedBy: entry.finding.verifiedBy ?? "model",
        // A runtime confirmation names no model; VS-30 widens the input with its check.
        verifier: entry.finding.verifiedBy === "runtime" ? "runtime" : input.verifier,
      },
    ]
  })
  const incomplete = strictIncomplete(input.coverage, pass.unreadable)
  return {
    version: 1,
    head: input.head,
    complete: incomplete.length === 0,
    ...(incomplete.length ? { incomplete } : {}),
    findings: kept,
    dropped: pass.dropped,
    fixUnchecked: kept.filter((finding) => finding.fix.kind === "unchecked").length,
  }
}

// What the rule pass reads about one candidate, worked out by its caller: strictSelect from the diff and the blobs, and
// report.ts's offline re-selection from a replay artifact's records. A rule whose fact is absent is left out, since
// legacy output has no failure block and no quotes.
export interface StrictCandidate {
  finding: Finding // S1, S2's severity half, S7 and S8 read it directly
  scoped?: boolean // S2's class half: a failure block in one of the five classes
  anchored: boolean // S3
  quotes?: { matched: Quote[]; unreadable: boolean } // S4: the quotes that match, and whether a file was unreadable
  impact?: boolean // S5
  // S6, read only once S1 to S5 hold, since checking a patch applies it and may parse the file.
  fix: () => StrictFinding["fix"] | undefined
  code: string // sameFinding's anchored code, normalized; "" when unknown
  failureClass?: FailureClass // S7's class clause; absent leaves it out
}

export interface StrictPass {
  kept: { finding: Finding; fix: StrictFinding["fix"]; quotes?: Quote[] }[] // in strength order
  dropped: StrictResult["dropped"] // in STRICT_DROPS order, only reasons with a count of 1 or more
  // S1 and S4 met something they could not read. `verdict` also holds when an unanswered id has no candidate that
  // confirms it, so a verdict lost with a finding the caller left out still reads as unread (I-7).
  unreadable: { verdict: boolean; blob: boolean }
}

// The rules S1 to S8 over facts worked out beforehand, shared by strictSelect and report.ts's offline re-selection so
// both apply the same order, the same dedup and the same cap. Candidates are taken strongest first (a runtime
// confirmation, then confidence, then path, line, id, title and the whole finding, so the result never depends on input
// order), each dropped at the first rule it fails, and S7 compares a candidate only with those already kept.
export function strictRules(
  candidates: readonly StrictCandidate[],
  input: { maxComments: number; unanswered: readonly string[] },
): StrictPass {
  const unanswered = new Set(input.unanswered)
  const codes = new Map(candidates.map((candidate) => [candidate.finding, candidate.code]))
  const codeOf = (finding: Finding) => codes.get(finding) ?? ""
  const judged = candidates.toSorted(stronger).reduce(
    (state: { accepted: Accepted[]; drops: Judged[] }, candidate) => {
      const verdict = judge(candidate, { unanswered, accepted: state.accepted, code: codeOf })
      if ("fix" in verdict) return { ...state, accepted: [...state.accepted, { candidate, fix: verdict.fix }] }
      return { ...state, drops: [...state.drops, verdict] }
    },
    { accepted: [], drops: [] },
  )
  // S8, clamped as selection clamps its per-run cap.
  const cap = Math.min(MAX_INLINE, Math.max(0, Math.floor(input.maxComments)))
  const drops = [...judged.drops, ...judged.accepted.slice(cap).map((): Judged => ({ drop: "cap" }))]
  const confirmed = new Set(
    candidates.filter((candidate) => candidate.finding.verified === true).map((candidate) => candidate.finding.id),
  )
  return {
    kept: judged.accepted.slice(0, cap).map((entry) => ({
      finding: entry.candidate.finding,
      fix: entry.fix,
      ...(entry.candidate.quotes ? { quotes: entry.candidate.quotes.matched } : {}),
    })),
    dropped: STRICT_DROPS.flatMap((reason) => {
      const count = drops.filter((entry) => entry.drop === reason).length
      return count ? [{ reason, count }] : []
    }),
    unreadable: {
      verdict:
        drops.some((entry) => entry.unreadable === "verdict") || input.unanswered.some((id) => !confirmed.has(id)),
      blob: drops.some((entry) => entry.unreadable === "blob"),
    },
  }
}

// Why a strict result is incomplete: verdict.ts's unfinished causes for the run's coverage, then the reads S1 and S4
// could not make. Impact-slice incompleteness is not an input: it is context, never coverage (addendum VS-38 item 7).
export function strictIncomplete(
  coverage: VerdictCoverage,
  unreadable: { verdict: boolean; blob: boolean },
): StrictIncomplete[] {
  return [
    ...unfinishedCauses(coverage).filter(
      (cause): cause is Exclude<UnfinishedCause, "strict-incomplete"> => cause !== "strict-incomplete",
    ),
    ...(unreadable.verdict ? ["verdict-unreadable" as const] : []),
    ...(unreadable.blob ? ["blob-unreadable" as const] : []),
  ]
}

type Judged = { drop: StrictDrop; unreadable?: "verdict" | "blob" }
type Accepted = { candidate: StrictCandidate; fix: StrictFinding["fix"] }

// S1 to S7 for one candidate: the first rule it fails, or its fix.
function judge(
  candidate: StrictCandidate,
  context: { unanswered: ReadonlySet<string>; accepted: readonly Accepted[]; code: (finding: Finding) => string },
): Judged | { fix: StrictFinding["fix"] } {
  const finding = candidate.finding
  if (finding.verified !== true)
    return context.unanswered.has(finding.id)
      ? { drop: "verdict-unreadable", unreadable: "verdict" }
      : { drop: "unverified" }
  if (finding.severityUnreadable === true) return { drop: "severity-unreadable" }
  if (finding.severity !== "blocking") return { drop: "not-blocking" }
  if (candidate.scoped === false) return { drop: "out-of-scope" }
  if (!candidate.anchored) return { drop: "anchor" }
  if (candidate.quotes && !candidate.quotes.matched.length)
    return { drop: "quote-mismatch", ...(candidate.quotes.unreadable ? { unreadable: "blob" as const } : {}) }
  if (candidate.impact === false) return { drop: "no-impact" }
  const fix = candidate.fix()
  if (!fix) return { drop: "no-fix" }
  if (context.accepted.some((entry) => duplicates(entry.candidate, candidate, context.code)))
    return { drop: "duplicate" }
  return { fix }
}

// S7: the same id, the same finding as selection reads it (sameFinding), or the same class on the same path and side
// within NEAR lines, measured as selection measures it.
function duplicates(kept: StrictCandidate, candidate: StrictCandidate, code: (finding: Finding) => string) {
  const a = kept.finding
  const b = candidate.finding
  if (a.id === b.id || sameFinding(a, b, code)) return true
  return (
    kept.failureClass !== undefined &&
    kept.failureClass === candidate.failureClass &&
    a.path === b.path &&
    a.side === b.side &&
    gap(a.line, a.endLine ?? a.line, b.line, b.endLine ?? b.line) <= NEAR
  )
}

function stronger(left: StrictCandidate, right: StrictCandidate) {
  const a = left.finding
  const b = right.finding
  return (
    Number(b.verifiedBy === "runtime") - Number(a.verifiedBy === "runtime") ||
    b.confidence - a.confidence ||
    compare(a.path, b.path) ||
    a.line - b.line ||
    compare(a.id, b.id) ||
    compare(a.title, b.title) ||
    compare(JSON.stringify(a), JSON.stringify(b))
  )
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

// S3: the anchor is at the model's own lines (resolveAnchor may snap a line onto a nearby hunk, which does not count),
// and on code the change touched. On the RIGHT side some line of it was added, or sits next to a deletion
// (touched with no radius); the LEFT side holds only removed lines, so a LEFT anchor is on removed code.
function onChangedLine(anchors: DiffFile[], finding: Finding, anchor: Anchor) {
  if (anchor.line < finding.line || anchor.line > (endLineOf(finding) ?? finding.line)) return false
  if (anchor.side === "LEFT") return true
  const start = anchor.startLine ?? anchor.line
  return Array.from({ length: anchor.line - start + 1 }, (_, offset) => start + offset).some((line) =>
    touched(anchors, anchor.path, line, 0),
  )
}

// A finding's last line, as resolveAnchor reads it: only a whole number after its first line.
function endLineOf(finding: Pick<Finding, "line" | "endLine">) {
  return finding.endLine !== undefined && Number.isInteger(finding.endLine) && finding.endLine > finding.line
    ? finding.endLine
    : undefined
}

// S5: present, and at most MAX_FAILURE_TEXT_CHARS characters as JSON Schema's maxLength counts them: code points, which
// Array.from yields, not UTF-16 units.
function bounded(text: string) {
  return text.trim() !== "" && Array.from(text).length <= MAX_FAILURE_TEXT_CHARS
}

// A fix text, or undefined when there is none: empty, or over the cap the result schema allows.
function fixText(text: string | undefined) {
  return text !== undefined && text.trim() !== "" && text.length <= MAX_SUGGESTION_CHARS ? text : undefined
}

// Where a file is read: a diff file's own path at head, a renamed file's old path at base, and a path outside the diff
// as it is written.
function blobKey(index: AnchorIndex, path: string, side: Side) {
  const file = lookupFile(index, path)?.file
  if (!file) return { side, path }
  return { side, path: side === "RIGHT" ? file.path : (file.oldPath ?? file.path) }
}

const LINE_BREAK = /\r\n?|\n/

function matchAt(lines: readonly string[], quote: Quote) {
  const code = quote.code.split(LINE_BREAK)
  const first = code.findIndex((line) => line.trim() !== "")
  const last = code.findLastIndex((line) => line.trim() !== "")
  const wanted = bare(code.slice(first, last + 1))
  const start = quote.line - 1 + first
  const end = start + last - first + 1
  if (first < 0 || !Number.isSafeInteger(quote.line) || quote.line < 1 || end > lines.length) return false
  return /[\p{L}\p{N}]/u.test(wanted) && bare(lines.slice(start, end)) === wanted
}

// S4's comparison form: every line with all its whitespace removed, blank lines dropped.
function bare(lines: readonly string[]) {
  return lines
    .map((line) => line.replace(/\s+/g, ""))
    .filter(Boolean)
    .join("\n")
}
