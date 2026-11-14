// Builds the markdown "evidence bundle" that `vector github run` attaches to
// the PR it opens (and to the comment it leaves on an existing PR). Everything
// here is pure: the handler gathers session messages, the git numstat and the
// judge's final text, and this module only formats them. That keeps the body
// unit-testable with fixture parts and lets the layout change without touching
// the GitHub plumbing.
//
// TODO(screenshots): browser/computer tool parts carry image attachments; once
// there is an asset store to upload them to, add a "Screenshots" section here.
import { Billing } from "@vectordevai/schema/billing"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { parseJudgeScores, parseJudgeVerdict } from "@/session/judge-verdict"

export type EvidenceChange = {
  file: string
  additions: number
  deletions: number
}

export type EvidenceCheck = {
  command: string
  /** Process exit code; `null` when unknown, `"error"` when the tool itself failed. */
  exit: number | null | "error"
  /** Tail of the command output, already trimmed to `CHECK_TAIL_LINES`. */
  output: string
}

export type MeasuredCost = {
  codium?: boolean
  /** Measured turns on Codium, excluded from every currency and token subtotal. */
  codiumTurns: number
  usageMissing?: boolean
  /** Measured own turns; absent on older own-only records. */
  ownTurns?: number
  /** Usage-bearing messages without positive provider identity. */
  unknownTurns?: number
  costUsd: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  provider?: string
  model?: string
  /** Assistant messages that reported usage. */
  turns: number
  /** Of those, the ones that ran on a model with no listed price; costUsd leaves them out. */
  unpriced: number
}

export type EvidenceInput = {
  /** The agent's final response, rendered verbatim above the evidence. */
  response: string
  changes: EvidenceChange[]
  /** Messages from the run's session plus any subagent sessions. */
  messages: readonly SessionV1.WithParts[]
  /** Final text of the judge subagent when it ran; omit when it did not. */
  judge?: string
  /** Absolute URL of the GitHub Actions run. */
  runUrl: string
  /** Verified Vector-owned public session URL, present only after explicit publication. */
  shareUrl?: string
  /** Issue number the PR closes. */
  closes?: number
  /** Extra line under the response, e.g. "Triggered by workflow_dispatch". */
  trigger?: string
}

export const CHECK_TAIL_LINES = 40
const CHECK_MAX_CHARS = 6000
const CHECK_MAX_COUNT = 12
const CHANGES_MAX_ROWS = 50
// GitHub rejects PR bodies and comments over 65,536 characters. Stay well
// under so the request that follows the push never fails on size.
export const BODY_MAX_CHARS = 60_000
const CHECK_COMPACT_CHARS = 1_500
const CHECK_COMPACT_COUNT = 3

// Commands whose outcome is evidence: anything that looks like a test,
// typecheck, lint or build. `\bcheck\b` deliberately does not match
// `checkout`; the shell builtin `test -f ...` is excluded separately.
const CHECK_COMMAND =
  /\b(test|tests|typecheck|tsc|lint|eslint|oxlint|biome|build|vitest|jest|pytest|mocha|check|clippy|vet)\b/i
const SHELL_TEST_BUILTIN = /^\s*(test|\[)\s/

export function isCheckCommand(command: string): boolean {
  if (SHELL_TEST_BUILTIN.test(command)) return false
  return CHECK_COMMAND.test(command)
}

/** Parses `git diff --numstat` output. Binary files report `-` and count as 0. */
export function parseNumstat(text: string): EvidenceChange[] {
  const out: EvidenceChange[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const [add, del, ...rest] = line.split("\t")
    const file = rest.join("\t").trim()
    if (!file) continue
    out.push({ file, additions: toCount(add), deletions: toCount(del) })
  }
  return out
}

function toCount(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)

// Same reducer approach as the app's token-usage.ts measureUsage: sum only the
// assistant messages that reported usage, and return undefined rather than a
// fabricated zero when none did. Provider/model come from the latest such
// message, since a run can switch models midway.
/** A stamped Codium step makes legacy message aggregates inseparable, even under an older own-provider identity. */
export function reviewUsageMessages(messages: readonly SessionV1.WithParts[]) {
  return messages.map((message) =>
    message.info.role === "assistant" && message.parts.some((part) => part.type === "step-finish" && Billing.of(part))
      ? { ...message, info: { ...message.info, billing: "codium" as const } }
      : message,
  )
}

export function measureCost(messages: readonly SessionV1.WithParts[]): MeasuredCost | undefined {
  const measured = reviewUsageMessages(messages).flatMap(({ info }) => {
    if (info.role !== "assistant" || info.forked) return []
    const t = info.tokens
    return Billing.of(info) ||
      (Billing.hasOwnIdentity(info) && finite(info.cost) > 0) ||
      [t?.input, t?.output, t?.reasoning, t?.cache?.read, t?.cache?.write].some((n) => finite(n) > 0)
      ? [info]
      : []
  })
  if (!measured.length) return undefined
  const own = measured.filter(Billing.hasOwnIdentity)
  const codiumTurns = measured.filter((message) => Billing.of(message)).length
  const unknown = measured.filter((message) => !Billing.of(message) && !Billing.hasOwnIdentity(message)).length
  const missing = own.some((message) =>
    [
      message.tokens?.input,
      message.tokens?.output,
      message.tokens?.reasoning,
      message.tokens?.cache?.read,
      message.tokens?.cache?.write,
    ].every((n) => finite(n) === 0),
  )
  const last = own.at(-1) ?? measured.at(-1)!
  return {
    ...(codiumTurns ? { codium: true, ownTurns: own.length } : {}),
    codiumTurns,
    ...(unknown ? { unknownTurns: unknown } : {}),
    ...(missing ? { usageMissing: true } : {}),
    costUsd: own.reduce((sum, m) => sum + finite(m.cost), 0),
    input: own.reduce((sum, m) => sum + finite(m.tokens?.input), 0),
    output: own.reduce((sum, m) => sum + finite(m.tokens?.output), 0),
    reasoning: own.reduce((sum, m) => sum + finite(m.tokens?.reasoning), 0),
    cacheRead: own.reduce((sum, m) => sum + finite(m.tokens?.cache?.read), 0),
    cacheWrite: own.reduce((sum, m) => sum + finite(m.tokens?.cache?.write), 0),
    provider: last.providerID,
    model: last.modelID,
    turns: measured.length,
    unpriced: own.filter((message) => message.unpriced).length + unknown,
  }
}

/** Every bash tool call that looks like a check, in execution order. */
export function collectChecks(messages: readonly SessionV1.WithParts[]): EvidenceCheck[] {
  const checks: EvidenceCheck[] = []
  for (const { parts } of messages) {
    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "bash") continue
      const state = part.state
      if (state.status !== "completed" && state.status !== "error") continue
      const input = state.input as Record<string, unknown>
      const command =
        typeof input.command === "string" && input.command.trim()
          ? input.command.trim()
          : state.status === "completed"
            ? state.title.trim()
            : ""
      if (!command || !isCheckCommand(command)) continue
      if (state.status === "error") {
        checks.push({ command, exit: "error", output: tail(state.error) })
        continue
      }
      const exit = state.metadata?.exit
      checks.push({
        command,
        exit: typeof exit === "number" && Number.isFinite(exit) ? exit : null,
        output: tail(stripShellMetadata(state.output)),
      })
    }
  }
  return checks
}

/**
 * Last text the assistant wrote in a (judge) session's latest run, undefined
 * when that run has no reply yet, or "" when it wrote no text or failed. The
 * verdict block is the final thing the judge prompt asks for. A judge resumed
 * with task_id starts a new run with a new brief, and the earlier run's
 * verdict no longer applies.
 */
export function judgeTextFromMessages(messages: readonly SessionV1.WithParts[]): string | undefined {
  const replies = messages
    .slice(messages.findLastIndex((message) => message.info.role === "user") + 1)
    .filter((message) => message.info.role === "assistant")
  const last = replies.at(-1)
  if (!last) return undefined
  if (last.info.role === "assistant" && last.info.error) return ""
  const text = replies
    .flatMap((message) => message.parts)
    .findLast((part): part is SessionV1.TextPart => part.type === "text" && part.text.trim().length > 0)
  return text?.text ?? ""
}

export function buildEvidenceBody(input: EvidenceInput): string {
  const checks = collectChecks(input.messages)
  const full = assemble(input, input.response.trim(), formatChecks(checks))
  if (full.length <= BODY_MAX_CHARS) return full
  // Too long: first shrink the check output (the usual culprit), then trim the
  // agent's response. The evidence sections and "Closes #N" always survive.
  const compact = assemble(input, input.response.trim(), formatChecks(checks, true))
  if (compact.length <= BODY_MAX_CHARS) return compact
  const marker = "\n\n_… response truncated; the full transcript is in the run log._"
  const without = assemble(input, "", formatChecks(checks, true))
  // A present response also costs its separator lines; measure that exactly.
  const overhead = assemble(input, "x", formatChecks(checks, true)).length - without.length - 1
  const room = BODY_MAX_CHARS - without.length - overhead - marker.length
  const response = room > 0 ? input.response.trim().slice(0, room) + marker : marker.trim()
  return assemble(input, response, formatChecks(checks, true))
}

function assemble(input: EvidenceInput, response: string, checks: string[]): string {
  const lines: string[] = []
  if (response) lines.push(response, "")
  if (input.trigger) lines.push(input.trigger, "")

  lines.push("## Vector evidence", "")
  lines.push("### Changes", "", ...formatChanges(input.changes), "")
  lines.push("### Checks", "", ...checks, "")
  lines.push(formatCost(measureCost(input.messages)))
  lines.push(formatJudge(input.judge))
  lines.push("")
  if (input.closes !== undefined) lines.push(`Closes #${input.closes}`, "")
  lines.push("---", `[Vector run](${input.runUrl})${input.shareUrl ? ` · [Public session](${input.shareUrl})` : ""}`)
  return lines.join("\n")
}

function formatChanges(changes: EvidenceChange[]): string[] {
  if (!changes.length) return ["_No file changes._"]
  const rows = changes.slice(0, CHANGES_MAX_ROWS)
  const additions = changes.reduce((sum, c) => sum + c.additions, 0)
  const deletions = changes.reduce((sum, c) => sum + c.deletions, 0)
  const out = [
    "| File | + | − |",
    "| --- | ---: | ---: |",
    ...rows.map((c) => `| \`${escapeCell(c.file)}\` | ${c.additions} | ${c.deletions} |`),
  ]
  if (changes.length > rows.length) out.push(`| _… and ${changes.length - rows.length} more_ | | |`)
  const noun = changes.length === 1 ? "file" : "files"
  out.push("", `_${changes.length} ${noun} changed, +${additions} −${deletions}_`)
  return out
}

function formatChecks(checks: EvidenceCheck[], compact = false): string[] {
  if (!checks.length) return ["_No test, typecheck, lint or build commands were run._"]
  const shown = checks.slice(-(compact ? CHECK_COMPACT_COUNT : CHECK_MAX_COUNT))
  const out: string[] = []
  if (checks.length > shown.length) out.push(`_Showing the last ${shown.length} of ${checks.length} checks._`, "")
  for (const check of shown) {
    const icon = check.exit === 0 ? "✅" : check.exit === null ? "⚠️" : "❌"
    const status = check.exit === "error" ? "tool error" : check.exit === null ? "exit unknown" : `exit ${check.exit}`
    const output =
      compact && check.output.length > CHECK_COMPACT_CHARS
        ? "…" + check.output.slice(-CHECK_COMPACT_CHARS)
        : check.output
    const fence = fenceFor(output)
    out.push(
      "<details>",
      `<summary>${icon} <code>${escapeHtml(check.command)}</code> (${status})</summary>`,
      "",
      `${fence}text`,
      output || "(no output)",
      fence,
      "",
      "</details>",
    )
  }
  return out
}

function formatCost(cost: MeasuredCost | undefined): string {
  if (!cost) return "**Cost:** not measured"
  const turns = `${cost.turns} ${cost.turns === 1 ? "turn" : "turns"}`
  if (cost.codium && cost.ownTurns === 0 && !cost.unknownTurns)
    return `**Cost:** Codium · Vector Codium${cost.model ? ` · ${cost.model}` : ""} · ${turns}`
  const usd = `$${cost.costUsd.toFixed(cost.costUsd > 0 && cost.costUsd < 0.01 ? 4 : 2)}`
  const ownPrice = cost.codium && cost.costUsd === 0 && cost.unpriced === 0 ? undefined : usd
  const parts = [
    // A turn on a model with no listed price adds nothing, so the cost is a lower bound, or unknown if that is all.
    [
      cost.unpriced === 0
        ? ownPrice
        : cost.costUsd > 0
          ? `${usd} + ${cost.unpriced} unpriced`
          : "unknown (no listed price)",
      cost.codium ? "Codium" : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" + "),
    ...(cost.usageMissing
      ? ["token usage unavailable"]
      : cost.unknownTurns && !(cost.ownTurns ?? cost.turns - cost.unknownTurns)
        ? []
        : [`${fmtTokens(cost.input)} in / ${fmtTokens(cost.output)} out${cost.codium ? " from other models" : ""}`]),
  ]
  if (!cost.codium && cost.reasoning > 0) parts.push(`${fmtTokens(cost.reasoning)} reasoning`)
  if (!cost.codium && cost.cacheRead > 0) parts.push(`${fmtTokens(cost.cacheRead)} cache read`)
  if (!cost.codium && cost.provider && cost.model && Billing.hasOwnIdentity({ providerID: cost.provider }))
    parts.push(`${cost.provider}/${cost.model}`)
  parts.push(turns)
  return `**Cost:** ${parts.join(" · ")}`
}

function formatJudge(text: string | undefined): string {
  if (text === undefined) return "**Judge:** not run"
  const verdict = parseJudgeVerdict(text)
  if (!verdict) return "**Judge:** ran, but wrote no verdict line"
  const icon = verdict === "PASS" ? "✅" : verdict === "FAIL" ? "❌" : "⚠️"
  const scores = parseJudgeScores(text)
  return `**Judge:** ${icon} ${verdict}${scores ? ` — ${scores}` : ""}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function tail(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n")
  let out = lines.slice(-CHECK_TAIL_LINES).join("\n")
  if (out.length > CHECK_MAX_CHARS) out = "…" + out.slice(-CHECK_MAX_CHARS)
  return out
}

// The shell tool appends a <shell_metadata> block (exit code, timeout notes)
// for the model's benefit; the summary line already carries the exit code.
function stripShellMetadata(output: string): string {
  return output.replace(/\n*<shell_metadata>[\s\S]*?<\/shell_metadata>\s*$/, "")
}

// A code fence must be longer than any backtick run inside it.
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/`/g, "'")
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
