// Terminal output for `vector review` (section 1.7). Pure: the command passes what it reviewed and the outcome, and
// gets back the text to print. Everything the model wrote is flattened to plain text with control characters removed,
// so a review of someone else's pull request cannot write escape sequences to the terminal.

import { Billing } from "@vectordevai/schema/billing"
import { reviewCostHasCodium, reviewCostIsCodium } from "@vectordevai/core/review/state"
import { costWording, formatDuration, formatTokens, formatUsd } from "@vectordevai/core/review/format"
import type {
  Finding,
  PlacedFinding,
  ReviewCost,
  ReviewOutcome,
  ReviewPass,
  Severity,
  SkippedFile,
} from "@vectordevai/core/review/types"

// What a local review compared. `baseRef` is "HEAD" when uncommitted or staged changes are reviewed on their own.
export interface LocalTarget {
  kind: "branch" | "uncommitted" | "staged" | "pr"
  label: string // "feature/refresh", "uncommitted changes", "pull request #7"
  baseRef: string
  mergeBase: string // the commit the diff starts from
  head: string
  branch?: string
  pr?: number
}

export interface RenderInput {
  target: LocalTarget
  outcome: ReviewOutcome
  limits: { maxCostUsd: number; maxSteps: number; timeoutMinutes: number }
  since?: string // the head of the last local review, when its findings were compared
  resumable?: boolean // the next `vector review` picks up files this one did not reach
  color?: boolean
}

const WIDTH = 100
const LABEL_WIDTH = 8 // "Blocking"
const MAX_SUGGESTION_LINES = 15
const MAX_SKIPPED_SHOWN = 10
const MAX_UNREVIEWED_SHOWN = 10

const NAME: Record<Severity, string> = { blocking: "Blocking", concern: "Concern", nit: "Nit" }

const SKIP_REASON: Record<SkippedFile["reason"], string> = {
  ignored: "ignored",
  lockfile: "lockfile",
  generated: "generated",
  vendored: "vendored",
  "build-output": "build output",
  binary: "binary",
  deleted: "deleted",
  "size-limit": "too large",
}

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  red: "\x1b[91m\x1b[1m",
  yellow: "\x1b[93m",
  reset: "\x1b[0m",
}

export function renderLocalReview(input: RenderInput): string {
  const { outcome, target } = input
  const selection = outcome.selection
  const paint = (code: string, text: string) => (input.color ? code + text + ANSI.reset : text)
  const severity = (value: Severity, text = NAME[value]) =>
    paint(value === "blocking" ? ANSI.red : value === "concern" ? ANSI.yellow : ANSI.dim, text)

  const lines: string[] = []
  const at = target.baseRef === "HEAD" ? short(target.mergeBase) : `merge-base ${short(target.mergeBase)}`
  const files = outcome.stats.files
  lines.push(
    paint(
      ANSI.bold,
      `Vectorscope review · ${plain(target.label)} vs ${plain(target.baseRef)} (${at}) · ${files} ${files === 1 ? "file" : "files"}, +${outcome.stats.additions} −${outcome.stats.deletions}`,
    ),
  )
  lines.push(`Risk: ${capitalize(selection.risk)} · ${counts(outcome)}`)
  const partial = partialLine(input)
  if (partial) lines.push(partial)

  // Findings on the changed lines, grouped by file: the most severe file first, lines in order within a file.
  const groups = new Map<string, PlacedFinding[]>()
  for (const finding of selection.inline)
    groups.set(finding.anchor.path, [...(groups.get(finding.anchor.path) ?? []), finding])
  for (const [file, findings] of groups) {
    const sorted = findings.toSorted((a, b) => a.anchor.line - b.anchor.line)
    const width = Math.max(...sorted.map((finding) => lineLabel(finding).length))
    const indent = " ".repeat(2 + width + 2)
    lines.push("", paint(ANSI.bold, plain(file)))
    for (const finding of sorted) {
      const label = NAME[finding.severity].padEnd(LABEL_WIDTH)
      lines.push(
        `  ${lineLabel(finding).padStart(width)}  ${severity(finding.severity, label)}  ${plain(finding.title)}`,
      )
      // Blocking findings carry their reasoning and fix; the rest are one line each, and --json has everything.
      if (finding.severity !== "blocking") continue
      const body = plain(finding.body)
      if (body) lines.push(indent + clipWords(body, WIDTH - indent.length))
      if (finding.suggestionAllowed && finding.suggestion) {
        lines.push(indent + "suggestion:")
        const code = finding.suggestion.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")
        for (const text of code.slice(0, MAX_SUGGESTION_LINES)) lines.push(`${indent}│ ${printable(text)}`)
        if (code.length > MAX_SUGGESTION_LINES)
          lines.push(`${indent}│ … ${code.length - MAX_SUGGESTION_LINES} more lines`)
      }
    }
  }

  const listed = (title: string, findings: Finding[]) => {
    if (!findings.length) return
    lines.push("", paint(ANSI.bold, title))
    for (const finding of findings)
      lines.push(`  ${plain(finding.path)}:${finding.line}  ${severity(finding.severity)}  ${plain(finding.title)}`)
  }
  listed("Outside the changed lines", selection.outsideDiff)
  listed("Elsewhere in this change", selection.elsewhere)
  listed(`More findings (${selection.overflow.length})`, selection.overflow)

  const tail: string[] = []
  if (selection.nits.length) tail.push(nitsLine(selection.nits, severity))
  if (outcome.skipped.length) tail.push(skippedLine(outcome.skipped))
  const low = selection.dropped.find((entry) => entry.reason === "low-confidence")?.count ?? 0
  if (low) tail.push(`${low} lower-confidence ${low === 1 ? "note was" : "notes were"} left out.`)
  for (const note of outcome.notes) tail.push(plain(note))
  if (input.since) tail.push(sinceLine(input.since, outcome))
  if (tail.length) lines.push("", ...tail)

  lines.push("", paint(ANSI.dim, footer(outcome)))
  const passes = outcome.passes ?? []
  if (passes.length > 1) lines.push(paint(ANSI.dim, passesLine(passes, outcome.cost)))
  return lines.join("\n") + "\n"
}

// The counts line: every new finding by severity, wherever it is listed.
function counts(outcome: ReviewOutcome): string {
  const selection = outcome.selection
  const all = [
    ...selection.inline,
    ...selection.overflow,
    ...selection.outsideDiff,
    ...selection.elsewhere,
    ...selection.nits,
  ]
  const blocking = all.filter((finding) => finding.severity === "blocking").length
  const concerns = all.filter((finding) => finding.severity === "concern").length
  const nits = all.filter((finding) => finding.severity === "nit").length
  const parts: string[] = []
  if (blocking) parts.push(`${blocking} blocking`)
  if (concerns) parts.push(`${concerns} ${concerns === 1 ? "concern" : "concerns"}`)
  if (nits) parts.push(`${nits} ${nits === 1 ? "nit" : "nits"}`)
  return parts.length ? parts.join(" · ") : "No issues found"
}

function partialLine(input: RenderInput): string | undefined {
  const { outcome, limits } = input
  if (!outcome.partial) return undefined
  const failed = outcome.specialists.find((entry) => entry.status === "failed" && entry.name !== "verify")
  const stop =
    outcome.partial === "budget"
      ? `stopped at the ${formatUsd(limits.maxCostUsd)} budget`
      : outcome.partial === "steps"
        ? `stopped at the ${limits.maxSteps}-step limit`
        : outcome.partial === "timeout"
          ? `stopped at the ${limits.timeoutMinutes}-minute time limit`
          : `${failed ? `the ${failed.name} reviewer` : "a reviewer"} could not finish${failed?.detail ? ` (${clipWords(plain(failed.detail), 160)})` : ""}`
  const unreviewed = outcome.unreviewed
  if (!unreviewed.length) return `Partial review: ${stop}.`
  const shown = unreviewed.slice(0, MAX_UNREVIEWED_SHOWN).map(plain).join(", ")
  const more = unreviewed.length > MAX_UNREVIEWED_SHOWN ? ` and ${unreviewed.length - MAX_UNREVIEWED_SHOWN} more` : ""
  const next = input.resumable ? " Run `vector review` again to review them." : ""
  return `Partial review: ${stop}. Not reviewed: ${shown}${more}.${next}`
}

// "Nits (3)  a.ts:18 openDB is imported but never used · …", as many as fit on one line. Findings of a higher
// severity land here only when --min-severity hides them, and then say which severity they are.
function nitsLine(findings: Finding[], severity: (value: Severity, text?: string) => string): string {
  const onlyNits = findings.every((finding) => finding.severity === "nit")
  const head = `${onlyNits ? "Nits" : "Below the severity bar"} (${findings.length})  `
  const items = findings.map((finding) => {
    const level = finding.severity === "nit" ? "" : `${NAME[finding.severity]} `
    return { plain: `${plain(finding.path)}:${finding.line} ${level}${plain(finding.title)}`, finding, level }
  })
  let used = head.length
  const shown: string[] = []
  for (const [index, item] of items.entries()) {
    const text = index === 0 ? clipWords(item.plain, WIDTH - head.length) : item.plain
    if (index > 0 && used + 3 + text.length > WIDTH) break
    used += (index > 0 ? 3 : 0) + text.length
    shown.push(
      item.level ? text.replace(item.level, severity(item.finding.severity, NAME[item.finding.severity]) + " ") : text,
    )
  }
  return head + shown.join(" · ") + (shown.length < items.length ? " · …" : "")
}

function skippedLine(skipped: SkippedFile[]): string {
  const shown = skipped.slice(0, MAX_SKIPPED_SHOWN).map((file) => {
    const added = file.additions ? `, +${file.additions}` : ""
    return `${plain(file.path)} (${SKIP_REASON[file.reason]}${added})`
  })
  const more = skipped.length > MAX_SKIPPED_SHOWN ? ` · ${skipped.length - MAX_SKIPPED_SHOWN} more` : ""
  return `Not reviewed: ${shown.join(" · ")}${more}`
}

// "Since last local review (9f8e7d6): 1 fixed · 1 still open". New findings are listed above, so they are not counted.
function sinceLine(since: string, outcome: ReviewOutcome): string {
  const selection = outcome.selection
  const parts: string[] = []
  if (selection.fixed.length) parts.push(`${selection.fixed.length} fixed`)
  if (selection.stillOpen.length) parts.push(`${selection.stillOpen.length} still open`)
  if (selection.reappeared.length) parts.push(`${selection.reappeared.length} returned`)
  return `Since last local review (${short(since)}): ${parts.length ? parts.join(" · ") : "nothing open from before"}`
}

// "anthropic/claude-sonnet-4 · 48.2k in / 3.1k out · 1m 52s · sessions: ses_1, ses_2"
function footer(outcome: ReviewOutcome): string {
  const parts: string[] = []
  if (outcome.cost) {
    if (reviewCostHasCodium(outcome.cost)) parts.push(costWording(outcome.cost))
    else parts.push(outcome.cost.model, costText(outcome.cost), usage(outcome.cost))
  }
  parts.push(formatDuration(outcome.durationMs))
  if (outcome.sessions.length) parts.push(`sessions: ${outcome.sessions.join(", ")}`)
  return parts.join(" · ")
}

// "By pass: review $0.0123 (40.1k in / 2.0k out) · double-check $0.0031 (9.2k in / 0.4k out)". Dollar amounts only
// when the review as a whole is priced.
function passesLine(passes: ReviewPass[], cost: ReviewCost | undefined): string {
  const name = {
    review: "review",
    security: "security",
    verify: "double-check",
    judge: "panel judge",
    lens: "lens",
    repro: "reproducer",
  } as const
  return `By pass: ${passes
    .map((pass) => {
      const explicit = pass.model.includes("/")
      const codium =
        pass.costKind === "codium" ||
        Billing.isCodium(pass.model.split("/")[0]) ||
        (!explicit && !pass.costKind && cost && reviewCostIsCodium(cost))
      if (codium) return `${name[pass.name]}: Codium`
      if (explicit && !Billing.hasOwnIdentity({ providerID: pass.model.split("/")[0] }))
        return `${name[pass.name]}: usage unavailable`
      const kind = pass.costKind ?? cost?.kind
      const dollars =
        pass.costUsd !== undefined && (kind === "priced" || (kind === "unknown" && pass.costUsd > 0))
          ? `${formatUsd(pass.costUsd)}${kind === "unknown" ? " + unpriced" : ""} `
          : ""
      return `${name[pass.name]} ${dollars}${pass.usageMissing ? "(token usage unavailable)" : `(${formatTokens(pass.input)} in / ${formatTokens(pass.output)} out)`}`
    })
    .join(" · ")}`
}

// Section 5.5, as in the summary comment's footer.
function costText(cost: ReviewCost): string {
  if (cost.kind === "priced") return formatUsd(cost.costUsd)
  if (cost.kind === "free") return "free"
  if (cost.kind === "plan") return "subscription sign-in, no per-token price"
  return "cost unknown: no price is listed for this model"
}

// The engine's `input` excludes cached tokens, so "in" adds them back.
function usage(cost: ReviewCost): string {
  const tokensIn = cost.input + cost.cacheRead + cost.cacheWrite
  if (cost.cacheRead > 0)
    return `${formatTokens(tokensIn)} in, ${formatTokens(cost.cacheRead)} of it cached / ${formatTokens(cost.output)} out`
  return `${formatTokens(tokensIn)} in / ${formatTokens(cost.output)} out`
}

// A range shows as "6–7". A removed line has a base line number; it is shown with a minus sign.
function lineLabel(finding: PlacedFinding): string {
  const { side, line, startLine } = finding.anchor
  const lines = startLine !== undefined && startLine < line ? `${startLine}–${line}` : String(line)
  return side === "LEFT" ? `−${lines}` : lines
}

// One line of prose: control characters removed, whitespace collapsed, and Markdown code spans unwrapped.
function plain(text: string): string {
  return printable(text).replace(/`+/g, "").replace(/\s+/g, " ").trim()
}

// Removes C0 and C1 control characters (escape sequences included), keeping tabs.
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

// Cuts at a word boundary so the text plus " …" fits in `max` characters.
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text
  const room = Math.max(1, max - 2)
  const cut = text.lastIndexOf(" ", room)
  return `${text.slice(0, cut > room / 2 ? cut : room)} …`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function short(sha: string): string {
  return /^[0-9a-f]{8,}$/.test(sha) ? sha.slice(0, 7) : sha
}
