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
// - S9 (VS-42), only under `guardrail: "strict"` with `scopeGate: "introduced"` (scopeGateApplies), checked after S5
//   and before S6: the model does not label it pre-existing, and preExistingSuspect does not hold, so some code it
//   quotes was touched by the change or differs from the base. It relies on the quotes alone: an anchor on an added
//   line whose quotes are all unchanged code is a suspect, even when the new line is what misuses the old code. A
//   finding S9 cannot check, because a base it needs could not be read, is kept and counted (StrictPass
//   preExistingUnchecked).
// - S6: it has a fix text. A committable suggestion under the existing rules is kept as one, and a patch of at most 3
//   hunks that applies to head at its own positions, and leaves a parseable file parsing, as a patch; any other fix is
//   kept as an unchecked plain diff, counted in fixUnchecked (C-14, Q17).
// - S7: no stronger finding already kept is the same one: the same id, sameFinding, or the same class within 3 lines.
// - S8: it falls within maxComments.
//
// VS-44's certificate check (certified(), with certificateBlobRequests) is S1's under `guardrail: "strict"` with
// `verifyEvidence: "certificate"`: a confirmed verdict counts as verified only when its certificate holds. It is pure
// and exported, and no rule in strictSelect calls it before VS-44 wiring, which adds its drops (CertificateDrop).

import {
  anchorText,
  applyFixPatch,
  buildAnchorIndex,
  endLineOf,
  lookupFile,
  onChangedLine,
  resolveAnchor,
  suggestionAllowed,
  touched,
  type AnchorIndex,
  type DiffFile,
} from "./diff"
import { normalizeCode } from "./fingerprint"
import {
  ESCAPING_PATH,
  MAX_FAILURE_TEXT_CHARS,
  MAX_FINDING_QUOTES,
  MAX_SUGGESTION_CHARS,
  MAX_TRACE_QUOTES,
} from "./schema"
import { gap, MAX_INLINE, NEAR, sameFinding } from "./select"
import { otherSide } from "./trivial"
import {
  STRICT_DROPS,
  type Anchor,
  type CertificateEvidence,
  type FailureClass,
  type Finding,
  type Quote,
  type ReviewConfig,
  type Side,
  type StrictDrop,
  type StrictFinding,
  type StrictResult,
  type Trust,
  type VerifyCertificate,
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
// closed: a quote on it marks the result incomplete instead of reading as a plain mismatch. S9's base reads are the
// exception: S9 only ever drops, so a base it cannot read leaves the finding kept, never incomplete, and counted as
// unchecked (StrictPass.preExistingUnchecked).
export type StrictBlob = string | null | { absent: true }

export interface StrictBlobs {
  head: ReadonlyMap<string, StrictBlob> // keyed by path at the head commit, as strictBlobRequests names them
  base: ReadonlyMap<string, StrictBlob> // keyed by path at the base commit
}

export interface StrictInput {
  head: string // the head commit, StrictResult.head
  anchors: DiffFile[] // the anchoring diff, as SelectInput.anchors
  blobs: StrictBlobs
  // S6 reads `suggestions`, S8 `maxComments`, and S9 runs only when `guardrail` is "strict" and `scopeGate` is
  // "introduced" (scopeGateApplies). VS-27c passes the review's whole ReviewConfig here and to strictBlobRequests: a
  // config without both keys leaves S9 out, and a base S9 cannot read keeps its finding, so neither shows as a drop.
  config: Pick<ReviewConfig, "maxComments" | "suggestions" | "guardrail" | "scopeGate">
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

// The head and base paths strictSelect reads for these findings under `config`, as the keys StrictBlobs must hold: each
// quote's file on its own side, and the head file of each finding with a patch on a file in the diff (S3 drops any
// other before S6 reads it). Under scopeGateApplies, S9 also reads each head quote's file at base, unless the change
// added or deleted that file (touched holds on every line of it, so it is never a suspect). Paths resolve as
// strictSelect resolves them (a diff path at head, a renamed file's old path at base, a path outside the diff as
// written), so VS-27c, VS-42 and VS-44 ask for the same keys. `config` is required so that VS-27c cannot leave out the
// keys S9 needs: it passes the review's whole ReviewConfig, as to strictSelect. A path that could leave the repository
// (schema.ts ESCAPING_PATH) is never named, for findings built without decodeReport too; strictSelect reads it as a
// file the tree lacks. Containment against the tree-ish stays the engine's (I-8).
export function strictBlobRequests(
  findings: readonly Finding[],
  anchors: DiffFile[],
  config: Pick<ReviewConfig, "guardrail" | "scopeGate">,
): { head: string[]; base: string[] } {
  const index = buildAnchorIndex(anchors)
  const gate = scopeGateApplies(config)
  const wanted = findings
    .flatMap((finding) => [
      ...(finding.quotes ?? []).flatMap((quote) => {
        const own = blobKey(index, quote.path, quote.side)
        if (!gate || quote.side !== "RIGHT") return [own]
        const status = lookupFile(index, quote.path)?.file.status
        return status === "added" || status === "deleted" ? [own] : [own, blobKey(index, quote.path, "LEFT")]
      }),
      ...(finding.patch !== undefined && lookupFile(index, finding.path)
        ? [blobKey(index, finding.path, "RIGHT")]
        : []),
    ])
    .filter((entry) => !ESCAPING_PATH.test(entry.path))
  const keys = (side: Side) =>
    [...new Set(wanted.filter((entry) => entry.side === side).map((entry) => entry.path))].toSorted()
  return { head: keys("RIGHT"), base: keys("LEFT") }
}

// Whether S9 runs: only under `guardrail: "strict"` with `scopeGate: "introduced"`. Set without strict, the key is
// ignored (config.ts gives the note), since S9 reads the quotes only the strict schema asks for.
export function scopeGateApplies(config: Pick<ReviewConfig, "guardrail" | "scopeGate">): boolean {
  return config.guardrail === "strict" && config.scopeGate === "introduced"
}

// S9's suspect check (VS-42): whether a finding looks like a defect that was already there at the base. All of these
// hold:
// - its anchor resolves at its own lines, on the RIGHT side and on a changed line (S3); a LEFT anchor is exempt;
// - the anchor's lines hold a line the change added (a modified line is an added one): an anchor S3 accepts only
//   because it sits next to a deletion is a deletion defect, which is exempt;
// - S4 matched at least one of its quotes, and every matched quote is head code: a matched base quote is removed code,
//   so the finding rests on the deletion and is exempt;
// - no line a matched quote spans touches a change (an added line, or one next to a deletion: diff.ts touched with no
//   radius, the ranges its changedSpans holds), and each is the base file's text at the base line its first line maps
//   to (trivial.ts otherSide; the same line for a file outside the diff), as S4's matcher reads it (quoteMatches), at
//   the base path a rename gives (DiffFile.oldPath).
// Only the quotes S4 matched count, so an invented quote never saves a finding and never exempts one (I-2). A base that
// is unreadable, missing or absent, or a head line the change added, never makes a finding a suspect. Paths resolve as
// strictSelect resolves them, files are read as strictSelect reads them (lineReader), and `head` and `base` are keyed
// as strictBlobRequests names them.
export function preExistingSuspect(
  finding: Pick<Finding, "path" | "line" | "endLine" | "side" | "quotes">,
  head: ReadonlyMap<string, StrictBlob>,
  base: ReadonlyMap<string, StrictBlob>,
  files: DiffFile[],
): boolean {
  const index = buildAnchorIndex(files)
  const read = lineReader({ head, base })
  const resolved = resolveAnchor(index, finding)
  const matched = (finding.quotes ?? []).flatMap((quote) => {
    const own = { ...quote, path: blobKey(index, quote.path, quote.side).path }
    const file = read(quote.side, own.path)
    return Array.isArray(file) && matchAt(file, own) ? [own] : []
  })
  const context = { index, anchors: files, base: (path: string) => read("LEFT", path) }
  return suspect(finding, resolved.ok ? resolved.anchor : undefined, matched, context) === true
}

// VS-44's certificate check (addendum A item 3): whether a verify certificate makes its finding verified, and if not,
// why. S1's under `guardrail: "strict"` with `verifyEvidence: "certificate"`; no rule in strictSelect calls it before
// VS-44 wiring. "rejected" is S1's `unverified` and "unsure" is `verdict-unsure`, and neither reads a file. A confirmed
// certificate is certified only when all of these hold (CERTIFICATE_MISMATCHES names each failure):
// - it answers this finding: the same id;
// - its trace holds 1 to MAX_TRACE_QUOTES quotes, and each is its file's text at its line as S4 reads a quote
//   (quoteMatches: whitespace and CRLF forgiven, a quote with no letter or digit matching nothing, a LEFT quote read
//   against the base). A quote with path "" is the finding's file;
// - a trace quote that matched, or whose file could not be read, lies in a change or on the anchor: a RIGHT line it spans
//   was added or sits next to a deletion (diff.ts touched with no radius), a LEFT line it spans is one the change
//   removed, or a line it spans is on the finding's anchor as resolveAnchor places it, on the anchor's side, in its file
//   and within its lines (startLine to line). The anchor is used, not the model's own range, which can cover lines in
//   hunks the anchor leaves out. Guards never anchor a trace, and a quote that did not match never does, nor does one
//   whose file could not be read when it could match no file (no letter or digit, or no line from 1);
// - its reach is "caller-shown" or "entry-point". Nothing checks the label, so it can only veto (I-2).
// Quotes can only veto: a matching trace never verifies a finding the verifier did not confirm (I-2). Guards never veto:
// the first MAX_FINDING_QUOTES are read, and those that match are kept as evidence. `noGuards` and `reason` are never
// attached. `blobUnreadable` holds when the only failure is the trace and every quote that did not match is on a file
// that could not be read (null or missing from the map) and could match were it read, so VS-44 wiring can fail closed
// as `blob-unreadable` (I-7). A quote that could match no file, such as a lone `}`, leaves a plain mismatch, so a model
// cannot turn a mismatch into an incomplete review by quoting punctuation in a file the engine did not read; so does a
// file the tree lacks. Paths resolve as strictSelect resolves them (a diff path at head, a
// renamed file's old path at base, a path outside the diff as written), a path that could leave the repository reads
// as a file the tree lacks, and files are read as strictSelect reads them (lineReader), keyed as
// certificateBlobRequests names them.
export function certified(
  finding: Pick<Finding, "id" | "path" | "line" | "endLine" | "side">,
  certificate: VerifyCertificate,
  input: Pick<StrictInput, "anchors" | "blobs">,
): CertificateCheck {
  return certify(finding, certificate, {
    index: buildAnchorIndex(input.anchors),
    anchors: input.anchors,
    read: lineReader(input.blobs),
  })
}

// Why a confirmed certificate failed certified(), in the order they are listed; "id" alone ends the check. "no-trace"
// is a trace that is missing, empty or over MAX_TRACE_QUOTES, and "trace-unreadable" one the decoder could not keep
// (VerifyCertificate.traceUnreadable), so a format failure is counted apart. "trace": some trace quote does not match.
// "unanchored" is worked out over the quotes that matched, or whose file could not be read and that could match, so a
// trace that is all invented shows both "trace" and "unanchored". "reach": it is "assumed" or could not be read.
export const CERTIFICATE_MISMATCHES = ["id", "no-trace", "trace-unreadable", "trace", "unanchored", "reach"] as const
export type CertificateMismatch = (typeof CERTIFICATE_MISMATCHES)[number]

// The StrictDrop values VS-44 wiring adds after `verdict-unreadable`, as S1's: the verifier was unsure, or its
// certificate failed certified(). They join STRICT_DROPS, and the result schema's enum under the key, with that wiring.
export type CertificateDrop = "verdict-unsure" | "certificate-mismatch"

export type CertificateCheck =
  | ({ certified: true } & CertificateEvidence)
  | { certified: false; drop: Extract<StrictDrop, "unverified"> | Extract<CertificateDrop, "verdict-unsure"> }
  | {
      certified: false
      drop: Extract<CertificateDrop, "certificate-mismatch">
      because: CertificateMismatch[]
      blobUnreadable: boolean
    }

// The head and base paths certified() reads for these certificates, as the keys StrictBlobs must hold, so VS-44 wiring
// merges them with strictBlobRequests. A certificate is paired with each finding of its id, and only a confirmed one
// whose trace holds 1 to MAX_TRACE_QUOTES quotes is read: each trace quote's file and the first MAX_FINDING_QUOTES
// guards' files, on their own sides, a quote with path "" naming the finding's file. That is exactly what certified()
// reads for the pair. Paths resolve as strictBlobRequests resolves them, and a path that could leave the repository is
// never named. Containment against the tree-ish stays the engine's (I-8).
export function certificateBlobRequests(
  findings: readonly Pick<Finding, "id" | "path">[],
  certificates: readonly VerifyCertificate[],
  anchors: DiffFile[],
): { head: string[]; base: string[] } {
  const index = buildAnchorIndex(anchors)
  const wanted = certificates
    .flatMap((certificate) => {
      const quotes = certificateQuotes(certificate)
      return findings
        .filter((finding) => finding.id === certificate.id)
        .flatMap((finding) => quotes.map((quote) => blobKey(index, quote.path || finding.path, quote.side)))
    })
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
// base first (trivial.ts otherSide, as preExistingSuspect does; diff.ts mapLine maps base to head) and pass a LEFT
// quote at that line. strictSelect, preExistingSuspect and certified() apply its body (matchAt) to the lines lineReader
// gives, so all of them match a quote as this does.
export function quoteMatches(quote: Quote, text: { head?: string | null; base?: string | null }): boolean {
  const file = quote.side === "LEFT" ? text.base : text.head
  return typeof file === "string" && matchAt(file.split(LINE_BREAK), quote)
}

// The facts strictSelect's rule pass reads about each finding, worked out from the diff and the blobs (report.ts works
// out its own from a replay artifact). Exported so that a caller can run strictRules itself and read what the pass
// counts beyond the result: StrictPass.preExistingUnchecked, which no result field carries before VS-42 wiring.
export function strictCandidates(findings: readonly Finding[], input: StrictInput): StrictCandidate[] {
  const index = buildAnchorIndex(input.anchors)
  const read = lineReader(input.blobs)
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
  const gate = scopeGateApplies(input.config)
  // S9 reads each base through the cache S4 reads quotes through, so a base file is split once per run.
  const context = { index, anchors: input.anchors, base: (path: string) => read("LEFT", path) }
  return findings.map((original): StrictCandidate => {
    const finding = { ...original, path: lookupFile(index, original.path)?.file.path ?? original.path }
    const resolved = resolveAnchor(index, finding)
    const anchor = resolved.ok ? resolved.anchor : undefined
    const quotes = (finding.quotes ?? []).map((quote) => {
      const key = blobKey(index, quote.path, quote.side)
      return { quote: { ...quote, path: key.path }, file: read(quote.side, key.path) }
    })
    const matched = quotes.flatMap((entry) =>
      Array.isArray(entry.file) && matchAt(entry.file, entry.quote) ? [entry.quote] : [],
    )
    return {
      finding,
      scoped: finding.failure !== undefined,
      anchored: anchor !== undefined && onChangedLine(input.anchors, finding, anchor),
      quotes: { matched, unreadable: quotes.some((entry) => entry.file === "unreadable") },
      ...(gate
        ? {
            preExisting: () => finding.scope === "pre-existing" || suspect(finding, anchor, matched, context),
          }
        : {}),
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
}

export function strictSelect(findings: readonly Finding[], input: StrictInput): StrictResult {
  const pass = strictRules(strictCandidates(findings, input), {
    maxComments: input.config.maxComments,
    unanswered: input.unanswered,
  })
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
// legacy output has no failure block and no quotes, and a replay artifact records no base blobs for S9.
export interface StrictCandidate {
  finding: Finding // S1, S2's severity half, S7 and S8 read it directly
  scoped?: boolean // S2's class half: a failure block in one of the five classes
  anchored: boolean // S3
  quotes?: { matched: Quote[]; unreadable: boolean } // S4: the quotes that match, and whether a file was unreadable
  impact?: boolean // S5
  // S9, read only once S1 to S5 hold, since it may read base files: true drops the finding as pre-existing (the model's
  // label, or preExistingSuspect), and "unchecked" keeps it because a base the check needed could not be read, which
  // the pass counts. strictCandidates sets it only under scopeGateApplies.
  preExisting?: () => boolean | "unchecked"
  // S6, read only once S1 to S5 and S9 hold, since checking a patch applies it and may parse the file.
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
  // Kept findings S9 could not check, because a base it needed was null or missing from the map: S9 only ever drops,
  // so it keeps them, and this count says so (I-7). Counted among the kept, after S8, as fixUnchecked is, and 0 when no
  // candidate carries S9's fact. No result field carries it before VS-42 wiring puts it in ReviewOutcome.notes.
  preExistingUnchecked: number
}

// The rules S1 to S9 over facts worked out beforehand, shared by strictSelect and report.ts's offline re-selection so
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
      if ("fix" in verdict) return { ...state, accepted: [...state.accepted, { candidate, ...verdict }] }
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
    preExistingUnchecked: judged.accepted.slice(0, cap).filter((entry) => entry.unchecked).length,
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
type Accepted = { candidate: StrictCandidate; fix: StrictFinding["fix"]; unchecked: boolean }

// S1 to S5, S9, S6 and S7 for one candidate: the first rule it fails, or its fix and whether S9 could not check it.
function judge(
  candidate: StrictCandidate,
  context: { unanswered: ReadonlySet<string>; accepted: readonly Accepted[]; code: (finding: Finding) => string },
): Judged | Omit<Accepted, "candidate"> {
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
  const preExisting = candidate.preExisting?.()
  if (preExisting === true) return { drop: "pre-existing" }
  const fix = candidate.fix()
  if (!fix) return { drop: "no-fix" }
  if (context.accepted.some((entry) => duplicates(entry.candidate, candidate, context.code)))
    return { drop: "duplicate" }
  return { fix, unchecked: preExisting === "unchecked" }
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

// What S9 reads beside a finding: the diff, and each base file's lines as lineReader gives them.
type SuspectContext = { index: AnchorIndex; anchors: DiffFile[]; base: (path: string) => FileLines }

// S9's suspect check on a finding already resolved: its anchor, if any, and the quotes S4 matched (preExistingSuspect
// lists the conditions). "unchecked" when only a base that could not be read stands between it and a suspect: every
// other condition holds, and no matched quote is known to differ from the base.
function suspect(
  finding: Pick<Finding, "line" | "endLine">,
  anchor: Anchor | undefined,
  matched: readonly Quote[],
  context: SuspectContext,
) {
  if (!anchor || anchor.side !== "RIGHT" || !onChangedLine(context.anchors, finding, anchor)) return false
  if (!addedIn(context.index, anchor)) return false
  if (!matched.length || matched.some((quote) => quote.side !== "RIGHT")) return false
  const checks = matched.map((quote) => unchangedSinceBase(quote, context))
  if (checks.includes(false)) return false
  return checks.includes("unchecked") ? "unchecked" : true
}

// Whether the anchor's lines hold one the change added.
function addedIn(index: AnchorIndex, anchor: Anchor) {
  const start = anchor.startLine ?? anchor.line
  return (lookupFile(index, anchor.path)?.file.hunks ?? []).some((hunk) =>
    hunk.lines.some(
      (line) =>
        line.kind === "add" && line.newLine !== undefined && line.newLine >= start && line.newLine <= anchor.line,
    ),
  )
}

// One matched head quote, for S9: true when no line it spans touches a change and its code is the base text at the
// base line its first line maps to, read at the base path; "unchecked" when that base is null or missing from the map.
// A head line with no base line (the change added it) is a change, and a base the tree lacks holds no old code.
function unchangedSinceBase(quote: Quote, context: SuspectContext): boolean | "unchecked" {
  const trimmed = trimQuote(quote)
  if (!trimmed) return false
  const span = trimmed.code.split(LINE_BREAK).length
  const lines = Array.from({ length: span }, (_, offset) => trimmed.line + offset)
  if (lines.some((line) => touched(context.anchors, quote.path, line, 0))) return false
  const file = lookupFile(context.index, quote.path)?.file
  const line = file ? otherSide(file, "RIGHT")(trimmed.line) : trimmed.line
  if (line === undefined) return false
  const base = context.base(blobKey(context.index, quote.path, "LEFT").path)
  if (base === "unreadable") return "unchecked"
  return base !== "absent" && matchAt(base, { ...trimmed, side: "LEFT", line })
}

// What certified() reads beside a finding: the diff, and each file's lines as lineReader gives them. Shared, so VS-44
// wiring can check every certificate of a run through strictCandidates' one reader.
type CertificateContext = { index: AnchorIndex; anchors: DiffFile[]; read: (side: Side, path: string) => FileLines }

// certified() over a context already built (certified() lists the conditions).
function certify(
  finding: Pick<Finding, "id" | "path" | "line" | "endLine" | "side">,
  certificate: VerifyCertificate,
  context: CertificateContext,
): CertificateCheck {
  if (certificate.id !== finding.id)
    return { certified: false, drop: "certificate-mismatch", because: ["id"], blobUnreadable: false }
  if (certificate.verdict === "rejected") return { certified: false, drop: "unverified" }
  if (certificate.verdict === "unsure") return { certified: false, drop: "verdict-unsure" }
  const trace = usableTrace(certificate)
  // The list certificateBlobRequests names, so certified() reads exactly that: the trace's quotes, then the guards'.
  const read = certificateQuotes(certificate).map((quote) => readQuote(quote, finding.path, context))
  const steps = read.slice(0, trace?.length ?? 0)
  const guards = read.slice(steps.length).flatMap((entry) => (entry.matched ? [entry.quote] : []))
  const resolved = resolveAnchor(context.index, finding)
  const anchor = resolved.ok ? resolved.anchor : undefined
  const unmatched = steps.filter((step) => !step.matched)
  // A quote whose file could not be read and that could match were it read: only the read is missing for it.
  const pending = (step: ReturnType<typeof readQuote>) =>
    step.file === "unreadable" && matchable(step.quote) !== undefined
  const reach =
    certificate.reach === "caller-shown" || certificate.reach === "entry-point" ? certificate.reach : undefined
  const because = CERTIFICATE_MISMATCHES.filter((reason) => {
    if (reason === "no-trace") return !trace && certificate.traceUnreadable !== true
    if (reason === "trace-unreadable") return !trace && certificate.traceUnreadable === true
    if (reason === "trace") return unmatched.length > 0
    if (reason === "unanchored")
      return (
        trace !== undefined && !steps.some((step) => (step.matched || pending(step)) && anchored(step, anchor, context))
      )
    if (reason === "reach") return reach === undefined
    return false
  })
  // `reach` is tested again only so that TypeScript knows it is set: an unset reach is already in `because`.
  if (because.length || reach === undefined)
    return {
      certified: false,
      drop: "certificate-mismatch",
      because,
      blobUnreadable: because.length === 1 && because[0] === "trace" && unmatched.every(pending),
    }
  return { certified: true, trace: steps.map((step) => step.quote), guards, reach }
}

// A certificate's trace when certified() checks it: a confirmed verdict's trace of 1 to MAX_TRACE_QUOTES quotes.
function usableTrace(certificate: VerifyCertificate) {
  if (certificate.verdict !== "confirmed" || !certificate.trace) return undefined
  return certificate.trace.length >= 1 && certificate.trace.length <= MAX_TRACE_QUOTES ? certificate.trace : undefined
}

// Every quote certified() reads for a certificate, in the order it reads them: its usable trace, then its first
// MAX_FINDING_QUOTES guards, or nothing when the trace is not usable. certified() and certificateBlobRequests both read
// this one list, so what is read is what is requested by construction.
function certificateQuotes(certificate: VerifyCertificate) {
  const trace = usableTrace(certificate)
  return trace ? [...trace, ...certificate.guards.slice(0, MAX_FINDING_QUOTES)] : []
}

// One certificate quote read for certified(): at the path it names, or the finding's when it names none, resolved as
// strictSelect resolves a quote's file.
function readQuote(quote: Quote, findingPath: string, context: CertificateContext) {
  const path = quote.path || findingPath
  const key = blobKey(context.index, path, quote.side)
  const own = { ...quote, path: key.path }
  const file = context.read(quote.side, key.path)
  return {
    quote: own,
    entry: lookupFile(context.index, path),
    file,
    matched: Array.isArray(file) && matchAt(file, own),
  }
}

// Whether a trace quote lies in a change or on the anchor (certified() says how each is read).
function anchored(
  step: ReturnType<typeof readQuote>,
  anchor: Anchor | undefined,
  context: CertificateContext,
): boolean {
  const trimmed = trimQuote(step.quote)
  const entry = step.entry
  if (!trimmed || !entry) return false
  const lines = Array.from({ length: trimmed.code.split(LINE_BREAK).length }, (_, offset) => trimmed.line + offset)
  const changed =
    step.quote.side === "RIGHT"
      ? lines.some((line) => touched(context.anchors, entry.file.path, line, 0))
      : lines.some((line) => entry.left.has(line))
  if (changed) return true
  if (!anchor || anchor.side !== step.quote.side || anchor.path !== entry.file.path) return false
  const start = anchor.startLine ?? anchor.line
  return lines.some((line) => line >= start && line <= anchor.line)
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

// One file's lines on one side, as strictCandidates and preExistingSuspect read it.
type FileLines = readonly string[] | "absent" | "unreadable"

// Reads files as S4 and S9 read them, splitting each side's file once: its lines, "absent" when that commit's tree
// lacks it or its path could leave the repository (never read), and "unreadable" when it is null or missing from the
// map.
function lineReader(blobs: StrictBlobs) {
  const lines = new Map<string, FileLines>()
  return (side: Side, path: string) => {
    const key = `${side}\n${path}`
    const cached = lines.get(key)
    if (cached !== undefined) return cached
    const blob = ESCAPING_PATH.test(path)
      ? { absent: true }
      : ((side === "RIGHT" ? blobs.head : blobs.base).get(path) ?? null)
    const value = typeof blob === "string" ? blob.split(LINE_BREAK) : blob === null ? "unreadable" : "absent"
    lines.set(key, value)
    return value
  }
}

const LINE_BREAK = /\r\n?|\n/

// quoteMatches over a file already split into lines.
function matchAt(lines: readonly string[], quote: Quote) {
  const trimmed = matchable(quote)
  if (!trimmed) return false
  const code = trimmed.code.split(LINE_BREAK)
  const start = trimmed.line - 1
  const end = start + code.length
  if (end > lines.length) return false
  return bare(lines.slice(start, end)) === bare(code)
}

// A quote as matchAt compares it (trimQuote's form), or undefined when it can match no file whatever the file holds:
// nothing but whitespace, a line that is not a whole number from 1, or no letter or digit (whitespace is neither, so
// testing the trimmed code tests its bare form). certified() reads it to tell a quote whose unread file is all that is
// missing from one that could never match.
function matchable(quote: Quote) {
  const trimmed = trimQuote(quote)
  if (!trimmed || !Number.isSafeInteger(quote.line) || quote.line < 1) return undefined
  return /[\p{L}\p{N}]/u.test(trimmed.code) ? trimmed : undefined
}

// S4's trimming rule, shared by S9 to find the head lines a quote spans: the quote without the whitespace-only lines at
// its start and end, its line moved past those at the start, or undefined when no other line is left.
function trimQuote(quote: Quote): Quote | undefined {
  const code = quote.code.split(LINE_BREAK)
  const first = code.findIndex((line) => line.trim() !== "")
  if (first < 0) return undefined
  const last = code.findLastIndex((line) => line.trim() !== "")
  return { ...quote, line: quote.line + first, code: code.slice(first, last + 1).join("\n") }
}

// S4's comparison form: every line with all its whitespace removed, blank lines dropped.
function bare(lines: readonly string[]) {
  return lines
    .map((line) => line.replace(/\s+/g, ""))
    .filter(Boolean)
    .join("\n")
}
