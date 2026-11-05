// Everything Vector writes to GitHub: the sticky summary, the review body, inline comments and their "fixed"
// edits, the notes from section 1.1 and the cost wording. Every piece of model text goes through
// sanitizeModelMarkdown before it is placed, and Vector's own markers are added after it.

import { normalizeTitle } from "./fingerprint"
import { MAX_SUGGESTION_CHARS } from "./schema"
import {
  SUMMARY_MARKER,
  escapeVectorMarkers,
  findingMarker,
  inlineTitle,
  reviewMarker,
  setFindingStatus,
  stateMarker,
  type ClassifiedPrior,
} from "./state"
import type {
  Finding,
  ModelReport,
  PlacedFinding,
  PriorFinding,
  ReviewCost,
  ReviewOutcome,
  ReviewState,
  Selection,
  Severity,
  SkippedFile,
  Trust,
} from "./types"

export const MAX_BODY_CHARS = 60_000
const MAX_FINDING_BODY = 20_000
const MAX_SUMMARY_TEXT = 1_500
const MAX_EXCERPT = 300
const MAX_NOTE_CELL = 100
const MAX_RULE = 200
const MAX_ERROR = 200
const MAX_TABLE_ROWS = 10
const MAX_SKIPPED_SHOWN = 40
const MAX_UNREVIEWED_SHOWN = 10

// Built from char codes so the source stays plain text.
const ZWSP = String.fromCharCode(0x200b)
const HOLD_OPEN = String.fromCharCode(0xe000)
const HOLD_CLOSE = String.fromCharCode(0xe001)

// A fence opener after quote or list markers (or indented under a list item), with a `suggestion` info string.
const NESTED_SUGGESTION = /^([ \t>*+\-\d.)]*)(`{3,}|~{3,})[ \t]*suggestion\b/i
// A line that starts a new block ends any code span before it: a blank line, a quote, a heading, a list item, a
// table row or HTML.
const BLOCK_BREAK = /\n(?=[ \t]*(?:\n|$)|[ \t]{0,3}(?:[<>#|]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)))/g

export interface RepoRef {
  owner: string
  repo: string
}

export const SEVERITY_LABEL: Record<Severity, string> = { blocking: "**Blocking**", concern: "**Concern**", nit: "Nit" }
const SEVERITY_NAME: Record<Severity, string> = { blocking: "Blocking", concern: "Concern", nit: "Nit" }

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

const COMMANDS =
  "<sub>Comment `/vector review` to review again, `/vector review full` to start over, or `/vector pause` to stop automatic reviews. Resolve a comment or react to it with a thumbs-down to dismiss it.</sub>"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// ---------------------------------------------------------------------------------------------------------------
// Numbers and cost

export function formatUsd(value: number): string {
  return `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US")
}

// The model and what the review cost (section 5.5). The engine's `input` excludes cached tokens, so "in" adds
// them back and "of it cached" shows the cache reads.
export function costWording(cost: ReviewCost): string {
  if (cost.usageMissing) return `${cost.model} · cost and token usage unavailable`
  const tokensIn = cost.input + cost.cacheRead + cost.cacheWrite
  const usage =
    cost.cacheRead > 0
      ? `${formatTokens(tokensIn)} in, ${formatTokens(cost.cacheRead)} of it cached / ${formatTokens(cost.output)} out`
      : `${formatTokens(tokensIn)} in / ${formatTokens(cost.output)} out`
  if (cost.kind === "free") return `${cost.model.replace(/:free$/, "")} · free (${usage})`
  if (cost.kind === "priced" && cost.partial)
    return `${cost.model} · at least ${formatUsd(cost.costUsd)}: a reply that stopped early reported no usage (${usage})`
  if (cost.kind === "priced") return `${cost.model} · ${formatUsd(cost.costUsd)} (${usage})`
  if (cost.kind === "plan") return `${cost.model} · subscription sign-in, no per-token price (${usage})`
  return `${cost.model} · cost unknown: pricing or complete usage is unavailable (${usage})`
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitizing model text

// Removes images and raw HTML, keeps only links into github.com/<owner>/<repo>, turns @user into @<ZWSP>user,
// neutralizes /vector commands and escapes `<!--`. Code spans and fenced blocks are left as written, except that
// a `suggestion` fence becomes a plain one: only Vector decides what is committable.
export function sanitizeModelMarkdown(text: string, repo?: RepoRef): string {
  const lines = text.replace(/\r\n?/g, "\n").replaceAll(HOLD_OPEN, "").replaceAll(HOLD_CLOSE, "").split("\n")
  const out: string[] = []
  let prose: string[] = []
  let fence: string | undefined
  const flush = () => {
    if (prose.length) out.push(sanitizeProse(prose.join("\n"), repo))
    prose = []
  }
  for (const line of lines) {
    if (fence) {
      out.push(escapeVectorMarkers(line))
      if (closesFence(line, fence)) fence = undefined
      continue
    }
    const open = line.match(/^( {0,3})(`{3,}|~{3,})([ \t]*)(\S*)(.*)$/)
    // A backtick fence whose info string holds a backtick is not a fence in CommonMark, so it stays prose.
    if (open && !(open[2]?.startsWith("`") && `${open[4]}${open[5]}`.includes("`"))) {
      flush()
      fence = open[2] ?? "```"
      const info = (open[4] ?? "").toLowerCase() === "suggestion" ? "" : (open[4] ?? "")
      out.push(escapeVectorMarkers(`${open[1] ?? ""}${fence}${open[3] ?? ""}${info}${open[5] ?? ""}`))
      continue
    }
    // A fence inside a quote or a list item is still a fence to GitHub, so it loses `suggestion` too.
    prose.push(line.replace(NESTED_SUGGESTION, "$1$2"))
  }
  flush()
  // An unclosed fence would swallow everything Vector writes after the model text.
  if (fence) out.push(fence)
  return out.join("\n")
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= fence.length && [...trimmed].every((char) => char === fence[0])
}

// Code spans keep their text. When GitHub's parser might see the spans differently (a backslash before a backtick, or
// a backtick run left open), the whole text is sanitized as prose instead: an escaped `<` inside code is a smaller
// loss than a live image or mention outside it.
function sanitizeProse(text: string, repo?: RepoRef): string {
  const split = splitCodeSpans(text)
  if (split.unmatched || text.includes("\\`")) return sanitizeText(text, repo)
  return split.parts
    .map((part) => (part.code ? escapeVectorMarkers(part.text) : sanitizeText(part.text, repo)))
    .join("")
}

// Splits prose into text and inline code spans (a run of backticks closed by a run of the same length, within one
// block). `unmatched` is set when a backtick run has no closer.
function splitCodeSpans(text: string): { parts: { code: boolean; text: string }[]; unmatched: boolean } {
  const parts: { code: boolean; text: string }[] = []
  const breaks = [...text.matchAll(BLOCK_BREAK)].map((match) => match.index ?? 0)
  let unmatched = false
  let last = 0
  let index = 0
  while (index < text.length) {
    if (text[index] !== "`") {
      index++
      continue
    }
    let run = 1
    while (text[index + run] === "`") run++
    const limit = breaks.find((at) => at > index) ?? text.length
    let close = -1
    let search = index + run
    while (search < limit) {
      const found = text.indexOf("`".repeat(run), search)
      if (found === -1 || found >= limit) break
      let end = found
      while (text[end] === "`") end++
      if (end - found === run) {
        close = found
        break
      }
      search = end
    }
    if (close === -1) {
      unmatched = true
      index += run
      continue
    }
    if (index > last) parts.push({ code: false, text: text.slice(last, index) })
    parts.push({ code: true, text: text.slice(index, close + run) })
    index = last = close + run
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) })
  return { parts, unmatched }
}

function sanitizeText(text: string, repo?: RepoRef): string {
  // Allowed links and neutralized URLs are held aside so later steps cannot touch them.
  const held: string[] = []
  const hold = (value: string) => `${HOLD_OPEN}${held.push(value) - 1}${HOLD_CLOSE}`
  const code = (value: string) => hold("`" + value.replace(/`/g, "") + "`")
  const out = text
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/!\[([^\]\n]*)\]\[[^\]\n]*\]/g, "$1")
    // Bounded whitespace keeps this linear on long runs of spaces.
    .replace(
      /\[([^\]\n]+)\]\(\s{0,20}<?([^)\s>]*)>?(?:\s{1,20}(?:"[^"\n]*"|'[^'\n]*'))?\s{0,20}\)/g,
      (_, label: string, url: string) => (allowed(url, repo) ? hold(`[${neutralize(label)}](${url})`) : label),
    )
    .replace(/^( {0,3})\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm, (all, indent: string, label: string, url: string) =>
      allowed(url, repo) ? hold(all) : `${indent}\\[${label}]: ${code(url)}`,
    )
    .replace(/<((?:https?|ftp):\/\/[^>\s]+)>/gi, (_, url: string) =>
      allowed(url, repo) ? hold(`<${url}>`) : code(url),
    )
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]`]+/gi, (match: string) => {
      const trail = match.match(/[.,;:!?'"]+$/)?.[0] ?? ""
      const url = match.slice(0, match.length - trail.length)
      return (allowed(url, repo) ? hold(url) : code(url)) + trail
    })
    .replace(/<(?=[A-Za-z!/?])/g, "&lt;")
  return neutralize(out).replace(
    new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g"),
    (_, index: string) => held[Number(index)] ?? "",
  )
}

// A mention would notify someone, and bot text must never read as a command.
function neutralize(text: string): string {
  return text.replace(/(^|[^\w@\/])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`).replace(/(^|\s)\/(vector|vx)\b/gi, `$1/${ZWSP}$2`)
}

// Only https links into this repository. The URL is parsed, so dot segments, a user name or a port cannot turn a
// link that starts with the repository into one to another page on github.com.
function allowed(url: string, repo?: RepoRef): boolean {
  if (!repo || /\\|%2e|(^|\/)\.\.?(\/|$|[?#])/i.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return false
  if (parsed.username || parsed.password || parsed.port) return false
  const root = `/${repo.owner}/${repo.repo}`.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  return path === root || path.startsWith(root + "/")
}

// A code fence longer than any backtick run inside the text.
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

// ---------------------------------------------------------------------------------------------------------------
// Inline comments and the review body

export interface InlineOptions {
  head: string
  trust: Trust
  // commit: a committable suggestion; diff: the fix as a diff block; none: no fix shown. Without it a placed
  // finding follows its suggestionAllowed, and any other finding shows its fix as a diff.
  suggestion?: "commit" | "diff" | "none"
  lead?: string // "Returned after being fixed in …" or "Raised to Blocking (…)"
  repo?: RepoRef
  // false: no "/vector fix" hint, for reviews posted from the desktop, where that command needs the GitHub Action.
  commands?: boolean
}

export function buildInlineBody(finding: Finding | PlacedFinding, options: InlineOptions): string {
  const mode = options.suggestion ?? ("suggestionAllowed" in finding && finding.suggestionAllowed ? "commit" : "diff")
  const lines = [`${SEVERITY_LABEL[finding.severity]} · ${inlineText(finding.title, options.repo)}`, ""]
  if (options.lead) lines.push(`_${options.lead}_`, "")
  const body = sanitizeModelMarkdown(clip(finding.body, MAX_FINDING_BODY), options.repo).trim()
  if (body) lines.push(body, "")
  const fix = finding.suggestion && mode !== "none" ? finding.suggestion : undefined
  if (fix && fix.length > MAX_SUGGESTION_CHARS) lines.push("_The suggested fix is too long to show here._", "")
  else if (fix && mode === "commit") lines.push(suggestionBlock(fix), "")
  else if (fix && mode === "diff") lines.push(diffBlock(fix), "")
  const meta = [finding.category, `confidence ${finding.confidence.toFixed(2)}`]
  if (finding.verified) meta.push("verified")
  if (finding.rule) {
    // Clipped before it is sanitized, so a cut can never leave a code span open around raw HTML.
    const rule = inlineText(clip(oneLine(finding.rule), MAX_RULE), options.repo).replace(/"/g, "'")
    meta.push(`rule from .vector/review.md: "${rule}"`)
  }
  if (options.trust === "trusted" && options.commands !== false)
    meta.push("reply `/vector fix` to have Vector apply this")
  lines.push(
    `<sub>${meta.join(" · ")}</sub>`,
    findingMarker({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      sha: options.head,
      status: "open",
      words: normalizeTitle(finding.title),
    }),
  )
  return lines.join("\n")
}

// The edit that marks an inline finding fixed. It sends no notification: the first line says where it was
// fixed, the suggestion becomes a collapsed diff (so there is no stale "Commit suggestion" button), and the
// marker becomes st=f:<sha>.
export function buildFixedEdit(body: string, fixedIn: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  if (!lines[0]?.startsWith("**Fixed in ")) {
    const title = inlineTitle(body)
    lines[0] = `**Fixed in \`${short(fixedIn)}\`.**${title ? ` ~~${title}~~` : ""}`
  }
  const start = lines.findIndex((line) => /^`{3,}suggestion\s*$/.test(line))
  if (start !== -1) {
    const fence = lines[start]?.match(/^`+/)?.[0] ?? "```"
    const end = lines.findIndex((line, index) => index > start && closesFence(line, fence))
    if (end !== -1) {
      const code = lines.slice(start + 1, end).join("\n")
      lines.splice(
        start,
        end - start + 1,
        "<details><summary>Original suggestion</summary>",
        "",
        diffBlock(code),
        "</details>",
      )
    }
  }
  return setFindingStatus(lines.join("\n"), "fixed", fixedIn)
}

export function buildReviewBody(input: {
  head: string
  run: string
  inline: readonly Pick<Finding, "severity">[]
  summaryUrl?: string
  continued?: boolean
}): string {
  const marker = reviewMarker(input.head, input.run)
  if (input.continued) return `Vectorscope review of \`${short(input.head)}\` (continued).\n${marker}`
  const blocking = input.inline.filter((finding) => finding.severity === "blocking").length
  const concerns = input.inline.filter((finding) => finding.severity === "concern").length
  const parts: string[] = []
  if (blocking) parts.push(`${blocking} blocking ${blocking === 1 ? "issue" : "issues"}`)
  if (concerns) parts.push(`${concerns} ${concerns === 1 ? "concern" : "concerns"}`)
  const link = input.summaryUrl ? ` [Summary](${input.summaryUrl})` : ""
  return `Vectorscope review of \`${short(input.head)}\`: ${parts.length ? parts.join(" and ") : "no new comments"} on the changed lines.${link}\n${marker}`
}

// The lead line for findings that continue an earlier one, by id.
export function inlineLeads(
  selection: Pick<Selection, "reappeared" | "raised">,
  prior: readonly PriorFinding[],
): Record<string, string> {
  const byId = new Map(prior.map((entry) => [entry.id, entry]))
  const leads: Record<string, string> = {}
  for (const id of selection.reappeared) {
    const fixedIn = byId.get(id)?.fixedIn
    leads[id] = fixedIn ? `Returned after being fixed in \`${short(fixedIn)}\`` : "Returned after being fixed"
  }
  for (const entry of selection.raised) {
    const sha = byId.get(entry.id)?.sha
    leads[entry.id] = `Raised to Blocking (was a ${SEVERITY_NAME[entry.was]}${sha ? ` in \`${short(sha)}\`` : ""})`
  }
  return leads
}

function suggestionBlock(code: string): string {
  const fence = fenceFor(code)
  return `${fence}suggestion\n${escapeVectorMarkers(code)}\n${fence}`
}

function diffBlock(code: string): string {
  const fence = fenceFor(code)
  const lines = escapeVectorMarkers(code)
    .split("\n")
    .map((line) => `+${line}`)
  return `${fence}diff\n${lines.join("\n")}\n${fence}`
}

// ---------------------------------------------------------------------------------------------------------------
// Notes (section 1.1 and the variants in 1.2)

export function noteNothingToReview(): string {
  return "Nothing to review: every changed file is a lockfile, generated, or ignored."
}

export function noteTooLarge(input: {
  files: number
  lines: number
  maxFiles: number
  maxLines: number
  estimate?: { low: number; high: number }
}): string {
  const cost =
    input.estimate && input.estimate.high > 0
      ? `; with the current model that costs about ${formatUsd(input.estimate.low)}–${formatUsd(input.estimate.high)}`
      : ""
  return `Too large to review automatically: ${formatCount(input.files)} files and ${formatCount(input.lines)} changed lines (limits: ${formatCount(input.maxFiles)} files, ${formatCount(input.maxLines)} lines). Comment \`/vector review full\` to review it anyway${cost}.`
}

export function notePrBudget(input: { maxUsd: number; spentUsd: number; reviews: number }): string {
  return `Automatic reviews stopped: this pull request has used its ${formatUsd(input.maxUsd)} review budget (${formatUsd(input.spentUsd)} over ${reviews(input.reviews)}). Comment \`/vector review\` to run another.`
}

// `month` is the state's month key, such as "2026-09".
export function noteMonthBudget(input: { maxUsd: number; spentUsd: number; reviews: number; month: string }): string {
  const [year, month] = input.month.split("-").map(Number)
  const next = MONTHS[(month ?? 1) % 12] ?? "next month"
  const until = Number.isFinite(year) && month ? `${next} 1` : "next month"
  const prs = `${input.reviews} ${input.reviews === 1 ? "pull request" : "pull requests"}`
  return `Reviews are paused for this repository until ${until}: this month's ${formatUsd(input.maxUsd)} review budget is used (at least ${formatUsd(input.spentUsd)} across ${prs}). Raise \`REVIEW_MAX_COST_USD_PER_MONTH\` in \`.github/workflows/vector.yml\` to continue.`
}

// The month's spend could not be read while a monthly limit is set, so automatic reviews do not run uncapped.
export function noteMonthUnknown(input: { maxUsd: number; error: string }): string {
  const reason = sanitizeProse(clip(oneLine(input.error), MAX_ERROR), undefined).replace(/[.\s]+$/, "")
  return `Automatic reviews are paused: Vector could not read this month's review spending for the repository${reason ? ` (${reason})` : ""}, and a monthly limit of ${formatUsd(input.maxUsd)} is set. Comment \`/vector review\` to run one anyway.`
}

// A review that failed still spent what its reviewers used before it stopped, so the note says so.
export function noteFailed(error: string, cost?: ReviewCost): string {
  const reason = sanitizeProse(clip(oneLine(error), MAX_ERROR), undefined).replace(/[.\s]+$/, "") || "an unknown error"
  return `Vector could not finish this review: ${reason}.${cost ? ` ${failedSpend(cost)}` : ""} Comment \`/vector review\` to try again.`
}

// The workflow cannot run a review at all, such as a model whose key is not passed in. The job fails as well; this
// says why on the pull request, where the person who asked for the review is looking.
export function noteCannotStart(error: string): string {
  const reason =
    sanitizeProse(clip(oneLine(error), MAX_ERROR * 2), undefined).replace(/[.\s]+$/, "") || "an unknown error"
  return `Vectorscope could not start this review: ${reason}. Comment \`/vector review\` once that is fixed.`
}

export function failedSpend(cost: ReviewCost): string {
  return `Used before it stopped: ${costWording(cost)}.`
}

export function noteAlreadyReviewed(head: string): string {
  return `\`${short(head)}\` was already reviewed. Comment \`/vector review full\` to review it again.`
}

export function notePartial(input: {
  reason: NonNullable<ReviewOutcome["partial"]>
  reviewed?: number
  total?: number
  unreviewed: string[]
  maxCostUsd?: number
  maxSteps?: number
  timeoutMinutes?: number
  detail?: string
}): string {
  if (input.reason === "model-error") {
    const detail = input.detail ? `: ${sanitizeProse(clip(oneLine(input.detail), MAX_ERROR), undefined)}` : ""
    return `**Partial review.** One reviewer could not finish${detail}. Comment \`/vector review\` to try again.`
  }
  const stop =
    input.reason === "budget"
      ? `Stopped at the ${formatUsd(input.maxCostUsd ?? 0)} budget`
      : input.reason === "steps"
        ? `Stopped at the ${input.maxSteps ?? 0}-step limit`
        : `Stopped at the ${input.timeoutMinutes ?? 0}-minute time limit`
  const after = input.total ? ` after ${input.reviewed ?? 0} of ${input.total} files` : ""
  if (!input.unreviewed.length)
    return `**Partial review.** ${stop}${after}. Comment \`/vector review\` to continue now.`
  const shown = input.unreviewed.slice(0, MAX_UNREVIEWED_SHOWN).map(codeSpan).join(", ")
  const more =
    input.unreviewed.length > MAX_UNREVIEWED_SHOWN ? ` and ${input.unreviewed.length - MAX_UNREVIEWED_SHOWN} more` : ""
  return `**Partial review.** ${stop}${after}. Not reviewed: ${shown}${more}. The next run reviews them, or comment \`/vector review\` to continue now.`
}

export function noteSuperseded(newHead: string): string {
  return `A newer commit (\`${short(newHead)}\`) arrived during this review. Vectorscope reviews it next.`
}

export function noteRebase(baseRef: string): string {
  return `Rebased onto ${codeSpan(baseRef)} with no change to this pull request's own diff; nothing new to review.`
}

export function noteForcePush(since: string, files: number): string {
  return `History was rewritten since \`${short(since)}\`; Vectorscope reviewed the ${files} ${files === 1 ? "file" : "files"} whose changes differ.`
}

export function noteLowConfidence(count: number): string {
  return `_${count} lower-confidence ${count === 1 ? "note was" : "notes were"} left out._`
}

export function noteGeneratedHeader(path: string): string {
  return `${codeSpan(path)} gained a generated-file header in this pull request, so Vectorscope reviewed it anyway.`
}

// One line for any number of files, so thousands of them cannot crowd out the rest of the summary.
export function noteGeneratedHeaders(paths: readonly string[]): string | undefined {
  if (paths.length <= 1) return paths[0] === undefined ? undefined : noteGeneratedHeader(paths[0])
  const shown = paths.slice(0, 3).map(codeSpan)
  const rest = paths.length - shown.length
  const names = rest ? `${shown.join(", ")} and ${formatCount(rest)} more` : joinWords(shown)
  return `${names} gained a generated-file header in this pull request, so Vectorscope reviewed them anyway.`
}

export function noteMoved(count: number): string {
  return `Vector could not attach ${count} ${count === 1 ? "comment" : "comments"} to lines; ${count === 1 ? "it is" : "they are"} listed under Outside the changed lines.`
}

// GitHub refused the whole review because the reviewed commit is no longer part of the pull request.
export function noteCommitGone(head: string, count: number): string {
  return `\`${short(head)}\` is no longer part of this pull request, so Vector could not attach ${count} ${count === 1 ? "comment" : "comments"} to lines; ${count === 1 ? "it is" : "they are"} listed under Outside the changed lines.`
}

export function noteInlineCap(max: number, scope: "pr" | "review"): string {
  return `${scope === "pr" ? "This pull request" : "This review"} reached its ${max} inline comments. Further findings are listed here.`
}

export function noteVerifySkipped(): string {
  return "Blocking findings were not re-checked: too little budget or time was left for the verify pass."
}

// The shared verify policy (plan.ts, VS-06): a verify pass that left candidates without a verdict says how many are
// posted without being re-checked, and why: it did not finish, for one of these reasons, or it finished ("unanswered")
// without a verdict for them.
export function noteVerifyUnfinished(count: number, why: "budget" | "time" | "unfinished" | "unanswered"): string {
  const reason =
    why === "budget"
      ? "too little of the review's budget was left for the verify pass"
      : why === "time"
        ? "too little time was left for the verify pass"
        : why === "unanswered"
          ? `the verify pass gave no verdict for ${count === 1 ? "it" : "them"}`
          : "the verify pass did not finish"
  return `${formatCount(count)} ${count === 1 ? "finding was" : "findings were"} not re-checked: ${reason}.`
}

// With a triage model only what the review model confirmed is reported, so a double-check that did not finish leaves
// the cheaper pass's findings out instead of posting them unchecked. Under the shared verify policy (plan.ts, VS-06) a
// double-check that finished without a verdict for some of them says so too ("unanswered").
export function noteTriageUnchecked(
  count: number,
  triage: string,
  model: string,
  why: "unfinished" | "unanswered" = "unfinished",
): string {
  const findings = `${formatCount(count)} ${count === 1 ? "finding" : "findings"} from the cheaper first pass on ${triage}`
  const rule = "with a triage model, only findings the review model confirmed are reported."
  if (why === "unanswered")
    return `The double-check on ${model} gave no verdict for ${findings}, so ${count === 1 ? "it was" : "they were"} left out: ${rule}`
  return `The double-check on ${model} did not finish, so ${findings} ${count === 1 ? "was" : "were"} left out: ${rule}`
}

// With a triage model only the review model can close an earlier finding, so when its check did not finish the
// cheaper pass's word that some are fixed is not taken.
export function noteTriageFixedUnchecked(count: number, triage: string, model: string): string {
  return `The double-check on ${model} did not finish, so ${formatCount(count)} earlier ${count === 1 ? "finding" : "findings"} that the cheaper first pass on ${triage} called fixed ${count === 1 ? "stays" : "stay"} open.`
}

// ---------------------------------------------------------------------------------------------------------------
// The sticky summary

export interface SummaryInput {
  form?: "ci" | "desktop" // desktop: no markers or commands, and every finding listed with its fix as a diff
  inlinePosted?: boolean // desktop: the findings on changed lines went out as line comments, so they are not listed
  repo?: RepoRef
  pr?: number
  head: string
  baseRef: string
  since?: string // the last reviewed head
  mode: ReviewOutcome["mode"]
  report?: Pick<ModelReport, "summary" | "files">
  selection?: Selection
  files?: { path: string; additions: number; deletions: number }[] // the reviewed files, with their counts
  skipped?: SkippedFile[]
  banners?: string[] // quoted under the heading, such as notePartial
  notes?: string[] // paragraphs after the counts, such as noteSuperseded or noteMoved
  cost?: ReviewCost
  durationMs?: number
  prTotal?: { costUsd: number; reviews: number }
  runUrl?: string
  commentUrls?: Record<string, string> // finding id → its inline comment's URL
  state?: ReviewState
}

export function buildSummaryBody(input: SummaryInput): string {
  return capBody(input)
}

interface Limits {
  nits: number
  elsewhere: number
  outside: number
  notes: number
  table: number
  lists: number
  skipped: number
}

// Keeps the body at or under 60,000 characters by trimming nits, then elsewhere, then outside-diff findings, then
// the notes, then the file table (then, beyond that, the other lists). The state marker is already bounded and never
// trimmed.
export function capBody(input: SummaryInput, max = MAX_BODY_CHARS): string {
  const selection = input.selection
  const limits: Limits = {
    nits: selection?.nits.length ?? 0,
    elsewhere: selection?.elsewhere.length ?? 0,
    outside: selection?.outsideDiff.length ?? 0,
    notes: input.notes?.length ?? 0,
    table: MAX_TABLE_ROWS,
    lists: Math.max(
      selection?.stillOpen.length ?? 0,
      selection?.fixed.length ?? 0,
      selection?.dismissed.length ?? 0,
      selection?.overflow.length ?? 0,
    ),
    skipped: MAX_SKIPPED_SHOWN,
  }
  let body = render(input, limits)
  for (const key of ["nits", "elsewhere", "outside", "notes", "table", "lists", "skipped"] as const) {
    while (body.length > max && limits[key] > 0) {
      limits[key] = Math.floor(limits[key] / 2)
      body = render(input, limits)
    }
  }
  if (body.length <= max) return body
  const cut = body.lastIndexOf("\n---\n")
  const trailer = cut === -1 ? "" : body.slice(cut)
  return body.slice(0, Math.max(0, max - trailer.length - 40)) + "\n\n_…cut to fit GitHub's limit._\n" + trailer
}

function render(input: SummaryInput, limits: Limits): string {
  const selection = input.selection
  const lines = [selection ? `## Vectorscope review · Risk: ${capital(selection.risk)}` : "## Vectorscope review", ""]
  if (input.banners?.length) lines.push(quote(input.banners), "")
  const summary = input.report?.summary.trim()
  if (summary) lines.push(sanitizeModelMarkdown(clip(summary, MAX_SUMMARY_TEXT), input.repo).replace(/^>/, "\\>"), "")
  if (selection) {
    lines.push(countLine(selection), "")
    const since = sinceLine(input, selection)
    if (since) lines.push(since, "")
  }
  const low = selection?.dropped.find((entry) => entry.reason === "low-confidence")?.count ?? 0
  const notes = input.notes ?? []
  const hidden = notes.length - limits.notes
  for (const note of [
    ...notes.slice(0, limits.notes),
    ...(hidden > 0 ? [`_…and ${formatCount(hidden)} more ${hidden === 1 ? "note" : "notes"}._`] : []),
    ...(low ? [noteLowConfidence(low)] : []),
  ])
    lines.push(note, "")
  const table = fileTable(input, limits.table)
  if (table.length) lines.push(...table, "")
  if (selection && input.form === "desktop" && !input.inlinePosted)
    lines.push(...desktopFindings(selection, input.repo))
  if (selection) lines.push(...detailSections(input, selection, limits))
  const skipped = skippedSection(input.skipped ?? [], limits.skipped)
  if (skipped.length) lines.push(...skipped, "")
  lines.push("---", ...footer(input))
  if (input.form !== "desktop") lines.push(...markers(input.state))
  return lines.join("\n")
}

function countLine(selection: Selection): string {
  const onLines = [
    ...selection.inline,
    ...selection.overflow,
    ...selection.stillOpen.filter((entry) => entry.where === "inline"),
  ]
  const blocking = onLines.filter((entry) => entry.severity === "blocking").length
  const concerns = onLines.filter((entry) => entry.severity === "concern").length
  const nits = selection.nits.length
  const below = nits ? ` · ${nits} ${nits === 1 ? "nit" : "nits"} below` : ""
  const parts: string[] = []
  if (blocking) parts.push(`${blocking} blocking`)
  if (concerns) parts.push(`${concerns} ${concerns === 1 ? "concern" : "concerns"}`)
  if (!parts.length) return `**No issues found** on the changed lines${below || "."}`
  return `**${parts.join(" · ")}** on the changed lines${below}`
}

function sinceLine(input: SummaryInput, selection: Selection): string | undefined {
  if (!input.since) return undefined
  const returned = new Set(selection.reappeared)
  const fresh = [...selection.inline, ...selection.overflow, ...selection.outsideDiff, ...selection.elsewhere].filter(
    (finding) => !returned.has(finding.id),
  ).length
  const parts: string[] = []
  if (selection.fixed.length) parts.push(`${selection.fixed.length} fixed`)
  if (selection.stillOpen.length) parts.push(`${selection.stillOpen.length} still open`)
  if (selection.reappeared.length) parts.push(`${selection.reappeared.length} returned`)
  if (fresh) parts.push(`${fresh} new`)
  return `**Since last review** (\`${short(input.since)}\` → \`${short(input.head)}\`): ${parts.length ? parts.join(" · ") : "no changes"}`
}

function fileTable(input: SummaryInput, limit: number): string[] {
  const files = input.files ?? []
  const stats = new Map(files.map((file) => [file.path, file]))
  const rows: { path: string; note: string; additions: number; deletions: number }[] = []
  for (const entry of input.report?.files ?? []) {
    const stat = stats.get(entry.path)
    if (!stat || rows.some((row) => row.path === entry.path) || rows.length >= limit) continue
    rows.push({ path: entry.path, note: entry.note, additions: stat.additions, deletions: stat.deletions })
  }
  const out: string[] = []
  if (rows.length)
    out.push(
      "| File | + | − | Why it matters |",
      "| --- | ---: | ---: | --- |",
      ...rows.map(
        (row) =>
          `| ${cell(codeSpan(row.path))} | ${row.additions} | ${row.deletions} | ${cell(inlineText(clip(oneLine(row.note), MAX_NOTE_CELL), input.repo))} |`,
      ),
    )
  const shown = new Set(rows.map((row) => row.path))
  const rest = files.filter((file) => !shown.has(file.path))
  if (rest.length) {
    if (out.length) out.push("")
    const noun = rest.length === 1 ? "file" : "files"
    out.push(`_${rest.length} ${rows.length ? "more " : ""}${noun} changed (${kinds(rest)})._`)
  }
  return out
}

function kinds(files: readonly { path: string }[]): string {
  const present = (["code", "tests", "docs", "config"] as const).filter((kind) =>
    files.some((file) => kindOf(file.path) === kind),
  )
  return joinWords(present)
}

function kindOf(path: string): "code" | "tests" | "docs" | "config" {
  const value = path.toLowerCase()
  if (
    /(^|\/)(__tests__|tests?|spec|e2e)\//.test(value) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(value) ||
    /(_test\.(go|py)|(^|\/)test_[^/]+\.py)$/.test(value)
  )
    return "tests"
  if (/\.(md|mdx|rst|txt|adoc)$/.test(value) || /(^|\/)docs?\//.test(value)) return "docs"
  if (/\.(json|jsonc|ya?ml|toml|ini|cfg|conf|lock)$/.test(value) || /(^|\/)\.[^/]+$/.test(value)) return "config"
  return "code"
}

function detailSections(input: SummaryInput, selection: Selection, limits: Limits): string[] {
  const repo = input.repo
  const out: string[] = []
  const priorItem = (entry: PriorFinding, tail: string) =>
    `- ${where(entry.path, entry.line)} · ${inlineText(entry.title, repo)}${tail}`
  out.push(
    ...section(
      "Still open from earlier reviews",
      selection.stillOpen.length,
      selection.stillOpen.slice(0, limits.lists).map((entry) => {
        const url = commentUrl(input, entry)
        const held = (entry as ClassifiedPrior).authorDismissed ? " · resolved by the author without a change" : ""
        return `- ${SEVERITY_LABEL[entry.severity]} · ${where(entry.path, entry.line)} · ${inlineText(entry.title, repo)}${url ? ` ([comment](${url}))` : ""}${held}`
      }),
    ),
    ...section(
      "Fixed since last review",
      selection.fixed.length,
      selection.fixed
        .slice(0, limits.lists)
        .map((entry) => priorItem(entry, entry.fixedIn ? ` · fixed in \`${short(entry.fixedIn)}\`` : " · fixed")),
    ),
    ...section(
      "Dismissed",
      selection.dismissed.length,
      selection.dismissed
        .slice(0, limits.lists)
        .map((entry) =>
          priorItem(entry, entry.dismissedBy ? ` · dismissed by @${ZWSP}${entry.dismissedBy}` : " · dismissed"),
        ),
    ),
    ...section(
      "Outside the changed lines",
      selection.outsideDiff.length,
      selection.outsideDiff.slice(0, limits.outside).map((finding) => findingItem(finding, repo)),
    ),
  )
  const elsewhere = selection.elsewhere.slice(0, limits.elsewhere)
  out.push(
    ...section(
      "Elsewhere in this pull request",
      selection.elsewhere.length,
      selection.elsewhere.length === 1
        ? elsewhere.map((finding) =>
            findingItem(
              finding,
              repo,
              " Not in the code changed since the last review, so it is listed here rather than posted as a comment.",
            ),
          )
        : [
            "Not in the code changed since the last review, so these are listed here rather than posted as comments.",
            "",
            ...elsewhere.map((finding) => findingItem(finding, repo)),
          ],
    ),
    ...section(
      "Nits",
      selection.nits.length,
      selection.nits
        .slice(0, limits.nits)
        .map((finding) => `- ${where(finding.path, finding.line)} · ${inlineText(finding.title, repo)}`),
    ),
    ...section(
      "More findings",
      selection.overflow.length,
      selection.overflow.slice(0, limits.lists).map((finding) => findingItem(finding, repo)),
    ),
  )
  return out
}

function section(title: string, total: number, items: string[]): string[] {
  if (!total) return []
  const shown = items.filter((item) => item.startsWith("- ")).length
  const more = total > shown ? [`- …and ${total - shown} more`] : []
  return [`<details><summary>${title} (${total})</summary>`, "", ...items, ...more, "</details>", ""]
}

function findingItem(finding: Finding, repo: RepoRef | undefined, tail = ""): string {
  const title = inlineText(finding.title, repo)
  const body = excerpt(finding.body, repo)
  const text = body ? `${sentence(title)} ${body}` : tail ? sentence(title) : title
  return `- ${SEVERITY_LABEL[finding.severity]} · ${where(finding.path, finding.line)} · ${text}${tail}`
}

function desktopFindings(selection: Selection, repo?: RepoRef): string[] {
  if (!selection.inline.length) return []
  const out: string[] = []
  for (const finding of selection.inline) {
    out.push(
      `${SEVERITY_LABEL[finding.severity]} · ${where(finding.anchor.path, finding.anchor.line)} · ${inlineText(finding.title, repo)}`,
      "",
    )
    const body = sanitizeModelMarkdown(clip(finding.body, MAX_FINDING_BODY), repo).trim()
    if (body) out.push(body, "")
    if (finding.suggestion) out.push(diffBlock(finding.suggestion), "")
  }
  return out
}

function skippedSection(skipped: readonly SkippedFile[], limit: number): string[] {
  if (!skipped.length) return []
  // New code files hidden by a path rule come first, with their added-line counts.
  const counted = skipped.filter((file) => file.additions !== undefined)
  const sorted = [
    ...counted.sort((a, b) => (b.additions ?? 0) - (a.additions ?? 0)),
    ...skipped.filter((file) => file.additions === undefined),
  ]
  const shown = sorted.slice(0, limit).map((file) => {
    const added = file.additions === undefined ? "" : ` (+${file.additions} ${file.additions === 1 ? "line" : "lines"})`
    return `${codeSpan(file.path)} ${SKIP_REASON[file.reason]}${added}`
  })
  const more = sorted.length - shown.length
  const text = shown.length ? shown.join(" · ") + (more ? ` · and ${more} more` : "") : `${more} files`
  const noun = skipped.length === 1 ? "file" : "files"
  return [`<details><summary>Not reviewed (${skipped.length} ${noun})</summary>`, "", text, "</details>"]
}

function footer(input: SummaryInput): string[] {
  const parts = [`Reviewed \`${short(input.head)}\` against ${codeSpan(input.baseRef)}`]
  if (input.mode === "incremental" && input.since) parts.push(`incremental from \`${short(input.since)}\``)
  else if (input.mode === "carry" && input.since) parts.push(`carried over from \`${short(input.since)}\``)
  else parts.push("full review")
  if (input.cost) parts.push(costWording(input.cost))
  if (input.durationMs !== undefined) parts.push(formatDuration(input.durationMs))
  if (input.prTotal && input.prTotal.reviews > 0) {
    const spent = input.prTotal.costUsd > 0 ? `${formatUsd(input.prTotal.costUsd)} over ` : ""
    parts.push(`this pull request: ${spent}${reviews(input.prTotal.reviews)}`)
  }
  if (input.runUrl) parts.push(`[workflow run](${input.runUrl})`)
  const out = [`<sub>${parts.join(" · ")}</sub>`]
  if (input.form !== "desktop") out.push(COMMANDS)
  return out
}

function markers(state: ReviewState | undefined): string[] {
  return state ? [SUMMARY_MARKER, stateMarker(state)] : [SUMMARY_MARKER]
}

// ---------------------------------------------------------------------------------------------------------------
// Edits to the sticky while a review runs, and for notes

// First run: only the "Reviewing" line. Later runs keep the previous results, with the line quoted above them.
export function buildRunningBody(input: {
  previous?: string
  head: string
  startedAt: number
  state?: ReviewState
}): string {
  const running = `Reviewing \`${short(input.head)}\`…`
  if (!input.previous || !hasResults(input.previous))
    return [
      `## Vectorscope review · ${running}`,
      "",
      "This comment shows the results when the review finishes, usually in 2–5 minutes.",
      "",
      ...markers(input.state),
    ].join("\n")
  return withBanner(input.previous, `${running} (started ${clock(input.startedAt)} UTC)`, input.state)
}

// A note from section 1.1 (a skip, a failure, a rebase). Earlier results stay below it.
export function buildNoteBody(input: { previous?: string; note: string; state?: ReviewState }): string {
  if (!input.previous || !hasResults(input.previous))
    return ["## Vectorscope review", "", quote([input.note]), "", ...markers(input.state)].join("\n")
  return withBanner(input.previous, input.note, input.state)
}

function hasResults(body: string): boolean {
  const heading = body.split("\n").find((line) => line.startsWith("## Vectorscope review"))
  return heading !== undefined && !heading.includes("· Reviewing")
}

// Replaces the quoted block under the heading, and the state marker.
function withBanner(previous: string, banner: string, state: ReviewState | undefined): string {
  const lines = previous.replace(/\r\n?/g, "\n").split("\n")
  const heading = lines.findIndex((line) => line.startsWith("## Vectorscope review"))
  let index = heading + 1
  while (lines[index] === "") index++
  if (lines[index]?.startsWith(">")) {
    while (lines[index]?.startsWith(">")) index++
    while (lines[index] === "") index++
  } else index = heading + 1
  const rest = lines.slice(index)
  if (rest[0] === "") rest.shift()
  const body = [...lines.slice(0, heading + 1), "", quote([banner]), "", ...rest].join("\n")
  return state ? replaceState(body, state) : body
}

function replaceState(body: string, state: ReviewState): string {
  const stripped = body.replace(/\n?<!-- vector-review:state v1 [A-Za-z0-9_-]* -->/g, "")
  const at = stripped.lastIndexOf(SUMMARY_MARKER)
  if (at === -1) return `${stripped}\n${SUMMARY_MARKER}\n${stateMarker(state)}`
  const end = at + SUMMARY_MARKER.length
  return `${stripped.slice(0, end)}\n${stateMarker(state)}${stripped.slice(end)}`
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function quote(lines: readonly string[]): string {
  return lines.map((line) => `> ${line}`).join("\n>\n")
}

function inlineText(text: string, repo: RepoRef | undefined): string {
  return sanitizeProse(oneLine(text), repo)
}

function excerpt(body: string, repo: RepoRef | undefined): string {
  const text = oneLine(body.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, " "))
  if (!text) return ""
  if (text.length <= MAX_EXCERPT) return sanitizeProse(text, repo)
  const space = text.lastIndexOf(" ", MAX_EXCERPT)
  return sanitizeProse(text.slice(0, space > 0 ? space : MAX_EXCERPT), repo) + "…"
}

function sentence(text: string): string {
  return /[.!?:]$/.test(text) ? text : `${text}.`
}

function where(path: string, line: number | null): string {
  return codeSpan(line === null ? path : `${path}:${line}`)
}

// Paths and branch names come from the pull request, so they cannot close the code span or carry a marker.
function codeSpan(text: string): string {
  return "`" + escapeVectorMarkers(text.replace(/[\r\n]+/g, " ").replace(/`/g, "'")) + "`"
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|")
}

function commentUrl(input: SummaryInput, entry: PriorFinding): string | undefined {
  const known = input.commentUrls?.[entry.id]
  if (known) return known
  if (!input.repo || !input.pr || entry.commentId === undefined) return undefined
  return `https://github.com/${input.repo.owner}/${input.repo.repo}/pull/${input.pr}#discussion_r${entry.commentId}`
}

function reviews(count: number): string {
  return `${count} ${count === 1 ? "review" : "reviews"}`
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

function short(sha: string): string {
  return sha.slice(0, 7)
}
