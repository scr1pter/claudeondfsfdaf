export * as ConnectPolicy from "./policy"

import { Connect } from "@vectordevai/schema/connect"
import { LocalPolicy } from "../local-mode/policy"
import { REVIEW_CONFIG_PATH, REVIEW_RULES_PATHS } from "../review/config"
import { reviewPermissionRules } from "../review/permission"
import type { CostKind as ReviewCostKind } from "../review/types"
import { Wildcard } from "../util/wildcard"
import type { PermissionV1 } from "../v1/permission"

// Connected tools' rules as pure functions over the schema's shapes: which permission each effect maps to, when a
// hand-off is refused before anything starts, which consents a review or a fix asks, where a member may run under
// Vector Local, the dollar cap, the paths a fix may write, the commands a fix child may run, the read rules a review
// must not get around, and the settings files a review must not trust. Nothing here reads the disk, the network or the
// environment; the engine's hub and its adapters pass in what they resolved and act on the answer.

type Rule = PermissionV1.Rule
type Ruleset = PermissionV1.Ruleset

/** The most review runs one request may start, whatever findings come back. */
export const MAX_REVIEWS_PER_REQUEST = 5
/** Connect's own cap on one review, in dollars, until `connect.review.max_cost_usd` says otherwise. */
export const DEFAULT_MAX_COST_USD = 2
/** The cap on a review that starts or keeps going after its run ended, when that run had no dollar limit. */
export const OUTSIDE_RUN_MAX_COST_USD = 0.5
/** The comment limit connect asks VectorScope for, so selection keeps every finding it can. */
export const MAX_COMMENTS = 50
/** The pattern the `connect` permission is asked with for a review. */
export const REVIEW_PATTERN = "vectorscope.review"

export type Decision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Connect.Refusal }

function refuse(code: Connect.RefusalCode, message: string): { ok: false; refusal: Connect.Refusal } {
  return { ok: false, refusal: new Connect.Refusal({ code, message }) }
}

// ---------------------------------------------------------------------------------------------------------------
// Effects and the narrowing check

// `read` maps to the requester's `read` rules and `write` to its `edit` rules (edit, write and apply_patch). Any other
// effect is unknown, and the hub refuses it.
const BASE_PERMISSION: Record<Connect.Effect, string> = { read: "read", write: "edit" }
const BASE = new Map<string, string>(Object.entries(BASE_PERMISSION))

/** The requester permission an effect maps to, or undefined for an effect connect does not accept. */
export function basePermission(effect: string): string | undefined {
  return BASE.get(effect)
}

/**
 * The rule that decides a permission and pattern: the last matching one, or an ask when none matches. The engine's
 * `Permission.evaluate` reads rules the same way.
 */
export function evaluate(permission: string, pattern: string, ruleset: Ruleset): Rule {
  return (
    ruleset.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    ) ?? {
      permission,
      pattern: "*",
      action: "ask",
    }
  )
}

/**
 * Whether a hand-off may start at all, before anything is asked. Each effect must be one connect accepts, and the
 * requester's own rules must not deny the permission it maps to. `patterns` are what the effect touches (a fix's owned
 * paths); without them the blanket `*` is checked. An ask in those rules does not refuse: the consent asks.
 */
export function narrowing(input: {
  readonly effects: readonly string[]
  readonly ruleset: Ruleset
  readonly patterns?: readonly string[]
}): Decision<readonly string[]> {
  if (input.effects.length === 0)
    return refuse("effect", "This action declares no effect, so connect did not start it.")
  const bases: string[] = []
  for (const effect of input.effects) {
    const base = basePermission(effect)
    if (!base) return refuse("effect", `Connect does not accept the "${clip(effect, 60)}" effect.`)
    bases.push(base)
  }
  const patterns = input.patterns && input.patterns.length > 0 ? input.patterns : ["*"]
  for (const base of bases)
    for (const pattern of patterns)
      if (evaluate(base, pattern, input.ruleset).action === "deny")
        return refuse(
          "permission",
          pattern === "*"
            ? `This session's permission rules deny ${base}, so connect did not start this hand-off.`
            : `This session's permission rules deny ${base} for ${clip(pattern, 300)}, so connect did not start this hand-off.`,
        )
  return { ok: true, value: bases }
}

/**
 * The order the hub follows for a hand-off: unknown effects and denied base permissions refuse first, and only then
 * are the consents asked. A refusal carries no consent, so nothing is asked.
 */
export function admit(input: {
  readonly effects: readonly string[]
  readonly ruleset: Ruleset
  readonly patterns?: readonly string[]
  readonly consents: () => readonly Connect.Consent[]
}): Decision<readonly Connect.Consent[]> {
  const narrowed = narrowing(input)
  if (!narrowed.ok) return narrowed
  return { ok: true, value: input.consents() }
}

// ---------------------------------------------------------------------------------------------------------------
// Consents

/**
 * What each consent asks and who may answer it. `connect` is allowed by the build agent's `*` default, so only a
 * user's rule makes it ask or deny. `connect_model` asks once per request and may be saved per model. `connect_write`
 * asks every time: it joins `requiresApproval`, so no rule, saved approval or auto-accept answers it.
 */
export const CONSENTS = {
  connect: {
    permission: "connect",
    when: "A read-only review on a model you chose, sent to this computer, your model server, or your own review model when it is not priced.",
    default: "allow",
    asked: "per-rule",
    saveable: true,
  },
  connect_model: {
    permission: "connect_model",
    when: "A review on a priced model, or on a model or triage model that the repository's review.json picks.",
    default: "ask",
    asked: "once-per-request",
    saveable: true,
  },
  connect_write: {
    permission: "connect_write",
    when: "Each fix batch, and each merge of a fix worktree into your checkout.",
    default: "ask",
    asked: "every-time",
    saveable: false,
  },
} as const satisfies Record<
  Connect.ConsentPermission,
  {
    permission: Connect.ConsentPermission
    when: string
    default: "allow" | "ask"
    asked: "per-rule" | "once-per-request" | "every-time"
    saveable: boolean
  }
>

/** One model a review would use, as the adapter resolved it without a model call. */
export interface ReviewModel {
  /** "provider/model" */
  readonly model: string
  /** The review pass or the cheaper triage pass (review.json's `triageModel`). */
  readonly role: "review" | "triage"
  readonly costKind: Connect.CostKind
  readonly sendsTo: Connect.SendsTo
  /** True when the repository's `.vector/review.json` picked it. */
  readonly fromRepository: boolean
}

/** Why a model needs `connect_model`, or undefined when it does not. */
export function modelConsentReason(model: ReviewModel, userModel: string | undefined): string | undefined {
  if (model.fromRepository && model.model !== userModel)
    return `${model.model} is picked by this repository's ${REVIEW_CONFIG_PATH}`
  if (model.costKind === "priced") return `${model.model} is priced`
  // A price Vector cannot read may still be charged, so it asks as a priced one does.
  if (model.costKind === "unknown") return `${model.model} has no price Vector can read`
  return undefined
}

/**
 * The consents a review asks, in order. `connect` (pattern `vectorscope.review`) always comes first; `connect_model`
 * follows when any model is priced, has no readable price, or is the repository's choice and not the user's own review
 * model (`agent.review.model`, else the configured default). The hub asks `connect_model` once per request.
 */
export function reviewConsents(input: {
  readonly models: readonly ReviewModel[]
  /** The user's own review model: `agent.review.model`, else the configured default. */
  readonly userModel?: string
  readonly maxCostUsd?: number
}): Connect.Consent[] {
  const main = input.models.find((model) => model.role === "review") ?? input.models[0]
  const review: Connect.Consent = {
    permission: "connect",
    patterns: [REVIEW_PATTERN],
    always: [REVIEW_PATTERN],
    message: "Review your changes with VectorScope.",
    ...(main ? { sendsTo: main.sendsTo } : {}),
  }
  const flagged = input.models.flatMap((model) => {
    const reason = modelConsentReason(model, input.userModel)
    return reason ? [{ model, reason }] : []
  })
  if (flagged.length === 0) return [review]
  const patterns = [...new Set(flagged.map((entry) => clip(entry.model.model, 500)))]
  const first = flagged[0].model
  const cap = positive(input.maxCostUsd)
  const where = flagged.map((entry) => `${entry.model.model} sends it to ${place(entry.model.sendsTo)}`)
  const message = [
    `Review your changes with VectorScope on ${patterns.join(" and ")}.`,
    `Why this asks: ${sentence(flagged.map((entry) => entry.reason))}.`,
    `Where the diff goes: ${sentence(where)}.`,
    cap !== undefined ? `The review stops at $${cap.toFixed(2)}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return [
    review,
    {
      permission: "connect_model",
      patterns,
      always: patterns,
      message: clip(message, Connect.MAX_SUMMARY),
      model: clip(first.model, 300),
      sendsTo: first.sendsTo,
      ...(cap !== undefined ? { maxCostUsd: cap } : {}),
    },
  ]
}

/**
 * The `connect_write` consent for one fix batch or one merge of a fix worktree. It never offers "Always allow". The
 * message is Vector's own words; the findings travel as ids, so a surface shows them as labelled data.
 */
export function writeConsent(input: {
  readonly kind: "fix" | "merge"
  readonly run: string
  readonly findings: readonly Pick<Connect.Finding, "id" | "severity" | "path" | "line">[]
  readonly paths: readonly string[]
  readonly mode?: Connect.FixMode
  readonly diff?: string
}): Connect.Consent {
  const paths = [...new Set(input.paths.filter((path) => path.trim() !== ""))]
  const patterns = paths.length > 0 && paths.length <= 50 ? paths.map((path) => clip(path, 500)) : ["*"]
  const listed = input.findings
    .slice(0, 10)
    .map((finding) => `${finding.severity} at ${clip(finding.path, 120)}${finding.line ? `:${finding.line}` : ""}`)
  const more = input.findings.length > listed.length ? ` and ${input.findings.length - listed.length} more` : ""
  const files = paths.length > 0 ? ` It may change ${plural(paths.length, "file")}.` : ""
  const head =
    input.kind === "merge"
      ? `Merge the fix worktree from ${input.run} into your checkout.`
      : `Fix ${plural(input.findings.length, "finding")} from ${input.run}${
          input.mode === "worktree" ? " in an isolated worktree" : input.mode === "here" ? " in your checkout" : ""
        }.`
  const message = `${head}${files}${listed.length ? ` Findings: ${listed.join("; ")}${more}.` : ""}`
  return {
    permission: "connect_write",
    patterns,
    always: [],
    message: clip(message, Connect.MAX_SUMMARY),
    findings: input.findings.slice(0, Connect.MAX_FINDINGS).map((finding) => finding.id),
    ...(input.diff !== undefined ? { diff: input.diff } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Place and where code goes, against Vector Local

/** Connect's cost kind for a review's: Vector Codium is plan usage. */
export function costKindOf(kind: ReviewCostKind): Connect.CostKind {
  return kind === "codium" ? "plan" : kind
}

/**
 * Where a review model sends the diff: Vector Codium; this computer or the model server it runs on, when the model is
 * local (the host comes from the model's API address); otherwise the provider the user configured. A local model whose
 * address Vector cannot read is a model server, never "this computer".
 */
export function sendsToOf(input: {
  readonly providerID: string
  readonly codium?: boolean
  readonly local?: boolean
  readonly url?: string
}): Connect.SendsTo {
  if (input.codium) return "vector-codium"
  if (input.local) {
    const server = serverOf(input.url)
    if (server === "this-computer") return "this-computer"
    return `model-server:${token(server ?? "unknown")}`
  }
  return `provider:${token(input.providerID) || "unknown"}`
}

function serverOf(url: string | undefined): string | undefined {
  if (!url || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  const name = LocalPolicy.host(parsed.hostname)
  if (!name) return undefined
  if (LocalPolicy.loopback(name)) return "this-computer"
  return `${name.includes(":") ? `[${name}]` : name}${parsed.port ? `:${parsed.port}` : ""}`
}

/** Whether results may call the place code went "local": only this computer or a model server the user lists. */
export function mayCallLocal(sendsTo: Connect.SendsTo | undefined): boolean {
  return Connect.isLocal(sendsTo)
}

/**
 * Whether a member may work while Vector Local is on. With it off, every place is allowed. With it on, the member's
 * code must run on this machine and send code nowhere but this computer or a listed model server.
 */
export function localGate(input: {
  readonly local: boolean
  readonly place: Connect.Place
  readonly sendsTo?: Connect.SendsTo
}): { readonly state: "ready" } | { readonly state: "off"; readonly reason: string } {
  if (!input.local) return { state: "ready" }
  if (input.place === "vector-cloud")
    return { state: "off", reason: "Off in Vector Local: it runs on Vector's servers." }
  if (input.place === "your-cloud")
    return { state: "off", reason: "Off in Vector Local: it runs in your own cloud accounts, not on this computer." }
  if (input.sendsTo !== undefined && !Connect.isLocal(input.sendsTo))
    return {
      state: "off",
      reason: clip(`Off in Vector Local: it would send your code to ${place(input.sendsTo)}.`, 500),
    }
  return { state: "ready" }
}

// ---------------------------------------------------------------------------------------------------------------
// Spend

/** Where the requester's run stands, read from the spend guard (`running`, `snapshot`, `stopped`). */
export interface RunSpend {
  /** The root's run is going, so a review counts against it through `parentID` and the helper rule. */
  readonly running: boolean
  /** The run's dollar limit (`budget.usd`), when it has one. */
  readonly limitUsd?: number
  readonly spentUsd?: number
  /** The run stopped (`guard.stopped`). */
  readonly stopped?: boolean
}

/** Whether a tool's `max_cost` is usable: a finite number of dollars greater than 0, or absent. */
export function maxCostInput(value: unknown): Decision<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return refuse("input", "max_cost must be a number of dollars greater than 0. Leave it out to use connect's cap.")
  return { ok: true, value }
}

/**
 * The dollar cap for one review: the smallest positive value of review.json's or the environment's `maxCostUsd`,
 * connect's own cap ($2, or `connect.review.max_cost_usd`), the tool's `max_cost`, and what the run has left. A 0 or a
 * missing value is skipped, never read as "no cap". After the run ended, what it had left caps the review, or $0.50
 * when it had no limit. A run that stopped refuses another review. A local model has no dollar cap (undefined); its
 * step and time limits and the per-request cap still apply.
 */
export function effectiveCap(input: {
  readonly costKind: Connect.CostKind
  readonly repository?: number
  readonly connect?: number
  readonly tool?: number
  readonly run: RunSpend
}): Decision<number | undefined> {
  const tool = maxCostInput(input.tool)
  if (!tool.ok) return tool
  if (input.run.stopped)
    return refuse("budget", "This run stopped on its budget, so connect did not start another review.")
  if (input.costKind === "local") return { ok: true, value: undefined }
  const limit = positive(input.run.limitUsd)
  const left = limit === undefined ? undefined : limit - Math.max(0, finite(input.run.spentUsd) ?? 0)
  if (left !== undefined && left <= 0)
    return refuse("budget", "This run has no budget left for a review, so connect did not start one.")
  const budget = input.run.running ? left : (left ?? OUTSIDE_RUN_MAX_COST_USD)
  const connect = positive(input.connect) ?? DEFAULT_MAX_COST_USD
  const caps = [positive(input.repository), connect, tool.value, positive(budget)].filter(
    (value): value is number => value !== undefined,
  )
  return { ok: true, value: Math.min(...caps) }
}

/** The per-request cap: refuses once `count` review runs were already recorded in this request. */
export function requestCap(count: number): Decision<number> {
  if (count >= MAX_REVIEWS_PER_REQUEST)
    return refuse(
      "limit",
      `This request already ran ${MAX_REVIEWS_PER_REQUEST} reviews, the most connect runs for one request. Tell the user what is still open instead of reviewing again.`,
    )
  return { ok: true, value: MAX_REVIEWS_PER_REQUEST - count }
}

// ---------------------------------------------------------------------------------------------------------------
// The owned-path rule

const RESOLVED: ReadonlySet<Connect.Bucket> = new Set(["inline", "overflow", "elsewhere", "nit"])
const NEVER_OWNED = [".github", ".vector"]

/**
 * The paths a fix may write: the paths of the given findings whose anchor resolved in the reviewed diff (inline,
 * overflow, elsewhere and nit; never outside-diff or still-open), that are among the diff's changed files, minus
 * `.github/**` and `.vector/**`. A model never widens it: every path comes from a finding's bucket and the diff.
 */
export function ownedPaths(input: {
  readonly findings: readonly Pick<Connect.Finding, "path" | "bucket">[]
  readonly changed: readonly string[]
}): string[] {
  const changed = new Set(input.changed.flatMap((path) => normalizePath(path) ?? []))
  const owned = new Set<string>()
  for (const finding of input.findings) {
    if (!RESOLVED.has(finding.bucket)) continue
    const path = normalizePath(finding.path)
    if (!path || !changed.has(path)) continue
    const lower = path.toLowerCase()
    if (NEVER_OWNED.some((dir) => lower === dir || lower.startsWith(`${dir}/`))) continue
    owned.add(path)
  }
  return [...owned].toSorted()
}

/**
 * A repository-relative path in one spelling: forward slashes, no leading "./", no repeated or trailing slash.
 * Undefined for an empty, absolute or escaping path.
 */
export function normalizePath(path: string): string | undefined {
  let clean = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
  while (clean.startsWith("./")) clean = clean.slice(2)
  clean = clean.replace(/\/+$/, "")
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return undefined
  if (clean.split("/").some((segment) => segment === "." || segment === "..")) return undefined
  return clean
}

// ---------------------------------------------------------------------------------------------------------------
// Check commands for fix children

/**
 * The commands a fix child may ask to run: VectorScope's own check list (test and typecheck commands, bare or with
 * paths and test names, never with a flag), read from its review rules so both stay one list.
 */
export function checkCommands(): string[] {
  return reviewPermissionRules({ checks: true })
    .filter((rule) => rule.permission === "bash" && rule.action === "allow" && !rule.pattern.endsWith(" *"))
    .map((rule) => rule.pattern)
}

/**
 * The `bash` rules of a fix child, in order: every command denied, the check commands asked one by one, then every
 * flag denied again (as VectorScope's rules do), with `tsc --noEmit` asked after it. The last matching rule wins, so no
 * other command runs.
 */
export function checkCommandRules(): Rule[] {
  return [
    { permission: "bash", pattern: "*", action: "deny" },
    ...reviewPermissionRules({ checks: true })
      .filter((rule) => rule.permission === "bash")
      .map((rule): Rule => (rule.action === "allow" ? { ...rule, action: "ask" } : rule)),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Fixes (CW-07)

/** The hidden agent a fix in an isolated worktree runs as. Only connect launches it; the task tool refuses a model. */
export const FIX_AGENT = "connect_fix"

/** The tools a fix child may use. Every other tool and permission is denied. */
export const FIX_TOOLS: readonly string[] = [
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "write",
  "apply_patch",
  "StructuredOutput",
]

// What a fix child never gets, whatever a rule says: the network, MCP resources and subagents. Denied last.
const FIX_DENIED = ["webfetch", "websearch", "network_command", "task"]

/**
 * The fixed part of the `connect_fix` agent's rules, which the agent puts after the defaults and the user's rules, so
 * it comes last and wins: every permission denied, then the fix tools allowed, the requester's own read defaults (so a
 * secret file still asks), the check commands asked one by one with every other command denied, the user's own rules
 * only where they narrow (a deny anywhere; an ask or allow only for a fix tool, never for the shell or the network),
 * and last the network tools, MCP resources and the task tool denied. `reads` are the agent defaults' `read` rules.
 */
export function fixAgentRules(input: { readonly user: Ruleset; readonly reads: Ruleset }): Rule[] {
  const narrowed = input.user.flatMap((rule): Rule[] => {
    if (rule.action === "deny") return [rule]
    return FIX_TOOLS.filter((tool) => Wildcard.match(tool, rule.permission)).map((tool) => ({
      ...rule,
      permission: tool,
    }))
  })
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...FIX_TOOLS.map((tool): Rule => ({ permission: tool, pattern: "*", action: "allow" })),
    ...input.reads.filter((rule) => rule.permission === "read"),
    ...checkCommandRules(),
    ...narrowed,
    { permission: "read", pattern: "mcp:*", action: "deny" },
    ...FIX_DENIED.map((permission): Rule => ({ permission, pattern: "*", action: "deny" })),
  ]
}

/** Why a chosen finding is not fixed through connect. */
export type FixSkip = { readonly id: string; readonly reason: string }

/**
 * Which of the chosen findings a fix may take on, and the files it may write: the owned-path rule applied finding by
 * finding, so each one left out says why. A finding already fixed or dismissed is left out too.
 */
export function fixable(input: {
  readonly findings: readonly Connect.Finding[]
  readonly changed: readonly string[]
}): { readonly findings: Connect.Finding[]; readonly skipped: FixSkip[]; readonly paths: string[] } {
  const findings: Connect.Finding[] = []
  const skipped: FixSkip[] = []
  const changed = new Set(input.changed.flatMap((path) => normalizePath(path) ?? []))
  for (const finding of input.findings) {
    const reason = skipReason(finding, changed)
    if (reason) skipped.push({ id: finding.id, reason })
    else findings.push(finding)
  }
  return { findings, skipped, paths: ownedPaths({ findings, changed: input.changed }) }
}

function skipReason(finding: Connect.Finding, changed: ReadonlySet<string>): string | undefined {
  if (finding.status === "fixed") return "it is already fixed"
  if (finding.status === "dismissed") return "it was dismissed"
  if (!RESOLVED.has(finding.bucket))
    return finding.bucket === "still-open"
      ? "it comes from VectorScope's saved state, not from the reviewed diff"
      : "its place is outside the reviewed diff"
  const path = normalizePath(finding.path)
  if (!path) return "its path is not a file in this repository"
  const lower = path.toLowerCase()
  if (NEVER_OWNED.some((dir) => lower === dir || lower.startsWith(`${dir}/`)))
    return "connect never fixes files under .github or .vector"
  if (!changed.has(path)) return "its file is no longer among the reviewed changes"
  return undefined
}

/** The files a fix of these findings could write, before the reviewed diff is read again; for the narrowing check. */
export function fixTouches(findings: readonly Pick<Connect.Finding, "path" | "bucket">[]): string[] {
  return ownedPaths({ findings, changed: findings.map((finding) => finding.path) })
}

/** The checked answer a fix child gives: the ids it fixed, and each id it skipped with a reason. */
export const FIX_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    fixed: { type: "array", items: { type: "string" } },
    skipped: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["fixed", "skipped"],
  additionalProperties: false,
}

/**
 * A fix child's answer, read as data: only ids of the findings it was given count, each once, fixed before skipped.
 * A model wrote it, so nothing in it chooses what happens next; reasons are cut to 500 characters.
 */
export function fixAnswer(
  value: unknown,
  ids: ReadonlySet<string>,
): { readonly fixed: string[]; readonly skipped: FixSkip[] } {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const fixed = [
    ...new Set(
      (Array.isArray(record.fixed) ? record.fixed : []).filter(
        (id): id is string => typeof id === "string" && ids.has(id),
      ),
    ),
  ]
  const done = new Set(fixed)
  const skipped: FixSkip[] = []
  for (const item of Array.isArray(record.skipped) ? record.skipped : []) {
    if (typeof item !== "object" || item === null) continue
    const { id, reason } = item as Record<string, unknown>
    if (typeof id !== "string" || !ids.has(id) || done.has(id)) continue
    done.add(id)
    skipped.push({ id, reason: clip(typeof reason === "string" ? reason.trim() : "", 500) || "no reason given" })
  }
  return { fixed, skipped }
}

/**
 * The `connect_write` question asked before a fix child's worktree is merged into the checkout by an agent: every
 * time, never saved, with the diff. The task's title is connect's own words ("Fix 2 findings from cr_…"); the review
 * run it names goes in `runID`, as the hub's own asks carry theirs, so a client shows the sentence.
 */
export function mergeAsk(input: {
  readonly title: string
  readonly patterns: readonly string[]
  readonly diff: string
}): {
  permission: "connect_write"
  patterns: string[]
  always: string[]
  metadata: { diff: string; description: string; runID?: string }
} {
  const patterns = [...new Set(input.patterns.filter((pattern) => pattern.trim() !== ""))]
  const run = /\bcr_[0-9A-Za-z]{1,61}\b/.exec(input.title)?.[0]
  return {
    permission: "connect_write",
    patterns: patterns.length > 0 ? patterns : ["*"],
    always: [],
    metadata: {
      diff: input.diff,
      description: clip(
        `Merge the fix worktree "${input.title}" into your checkout. It changes ${plural(patterns.length, "file")}.`,
        Connect.MAX_SUMMARY,
      ),
      ...(run ? { runID: run } : {}),
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Read rules a review must not get around

const ASK_ALL: Rule = { permission: "read", pattern: "*", action: "ask" }

/** VectorScope's own review session rules, whose read denies a review keeps whatever the requester allows. */
export function reviewRules(): Rule[] {
  return reviewPermissionRules({})
}

const reads = (rule: Rule) => Wildcard.match("read", rule.permission)

/**
 * The read patterns to look for before a review: every pattern the requester's merged ruleset denies or asks for
 * (no matching rule counts as an ask), less those VectorScope's own review rules deny outright. The hub looks for
 * files that match them in the review directory and confirms each with `readBlock`.
 *
 * It never drops a pattern a blocked file could need. A pattern is left out only when a later requester allow covers
 * it (that later rule decides every file it matches), or when a review deny covers it and every later review rule that
 * could match one of its files is a deny or is covered by a later requester allow.
 */
export function readPatterns(requester: Ruleset, review: Ruleset = reviewRules()): string[] {
  const rules = [ASK_ALL, ...requester.filter(reads)]
  const own = review.filter(reads)
  const out: string[] = []
  rules.forEach((rule, index) => {
    if (rule.action === "allow") return
    const later = rules.slice(index + 1)
    const allowedLater = (pattern: string) =>
      later.some((next) => next.action === "allow" && covers(next.pattern, pattern))
    if (allowedLater(rule.pattern)) return
    const denied = own.some(
      (deny, at) =>
        deny.action === "deny" &&
        covers(deny.pattern, rule.pattern) &&
        own
          .slice(at + 1)
          .every(
            (next) => next.action === "deny" || !overlaps(next.pattern, rule.pattern) || allowedLater(next.pattern),
          ),
    )
    if (denied) return
    if (!out.includes(rule.pattern)) out.push(rule.pattern)
  })
  return out
}

/**
 * Whether reviewing would let VectorScope read a file its requester could not read without a question: the requester's
 * rules deny or ask for it (no matching rule is an ask), and VectorScope's review rules do not deny it. `path` is the
 * name the read tool asks with: relative to the instance's worktree (the repository's top level), not to the folder
 * the review was started in.
 */
export function readBlock(
  path: string,
  requester: Ruleset,
  review: Ruleset = reviewRules(),
): { readonly path: string; readonly pattern: string; readonly action: "deny" | "ask" } | undefined {
  const own = evaluate("read", path, requester)
  if (own.action === "allow") return undefined
  if (evaluate("read", path, review).action === "deny") return undefined
  return { path, pattern: own.pattern, action: own.action }
}

/** The first of `paths` a review must not read, or undefined. */
export function firstReadBlock(paths: Iterable<string>, requester: Ruleset, review: Ruleset = reviewRules()) {
  for (const path of paths) {
    const block = readBlock(path, requester, review)
    if (block) return block
  }
  return undefined
}

/** The refusal for a file a review must not read. It names the requester's pattern, so the user knows what to change. */
export function readRefusal(block: {
  readonly path: string
  readonly pattern: string
  readonly action: "deny" | "ask"
}) {
  return new Connect.Refusal({
    code: "read-rule",
    message: clip(
      `${block.path} matches the read rule "${block.pattern}", which ${
        block.action === "deny" ? "denies reading it" : "asks before reading it"
      } in this session. VectorScope would read it without that rule, so connect did not review this directory.`,
      Connect.MAX_SUMMARY,
    ),
  })
}

// Wildcard patterns have two special characters: `*` (any text, `/` included) and `?` (one character). A pattern
// ending in " *" also matches without the space and what follows, which matters only to shell commands. Both checks
// below err on the side that keeps a pattern: `covers` may miss a containment, `overlaps` may see one that is not.

function chars(pattern: string, wide: boolean): string[] {
  let text = pattern.replaceAll("\\", "/")
  // Read wide, " *" is "*" (it matches more); read narrow, it needs the space (it matches less).
  if (wide && text.endsWith(" *")) text = text.slice(0, -2) + "*"
  // UTF-16 units, as Wildcard's `?` (a regular expression `.` without the u flag) reads them.
  return text.split("")
}

/** True only when every text `inner` matches, `outer` matches too. */
export function covers(outer: string, inner: string): boolean {
  const d = chars(outer, false)
  const p = chars(inner, true)
  const seen = new Set<number>()
  const stack: [number, number][] = [[0, 0]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    const key = i * (p.length + 1) + j
    if (seen.has(key)) continue
    seen.add(key)
    if (i === d.length && j === p.length) return true
    if (i === d.length) continue
    if (d[i] === "*") {
      stack.push([i + 1, j])
      // The outer star takes the inner's next element, whatever it matches.
      if (j < p.length) stack.push([i, j + 1])
      continue
    }
    if (j === p.length) continue
    if (d[i] === "?" ? p[j] !== "*" : p[j] === d[i]) stack.push([i + 1, j + 1])
  }
  return false
}

/**
 * Whether no pattern can tell a file beneath `a` from the same file beneath `b`: each one matches `a/<rest>` exactly
 * when it matches `b/<rest>`, for every rest. The hub's read check uses it to skip walking a link to a directory again
 * under the link's own name when the rules would decide every file there as they do under its real name. It errs
 * toward false (letter case is ignored on one side only, and `covers` may miss a containment).
 */
export function sameBeneath(patterns: readonly string[], a: string, b: string): boolean {
  return patterns.every((pattern) => beneathWithin(pattern, a, b) && beneathWithin(pattern, b, a))
}

// Every text beneath `from` the pattern matches, it also matches beneath `to` with the same rest.
function beneathWithin(pattern: string, from: string, to: string): boolean {
  // A rest is never empty (a file beneath has a name), so a state at the pattern's end matches nothing there.
  const wide = residues(pattern, from, true).filter((rest) => rest !== "")
  if (wide.length === 0) return true
  const narrow = residues(pattern, to, false)
  return wide.every((rest) => narrow.some((other) => covers(other, rest)))
}

// What is left of the pattern after it matched `<prefix>/`: one rest for each place the match can stand. Read wide, it
// ignores letter case and matches more; read narrow, it keeps case and matches less.
function residues(pattern: string, prefix: string, wide: boolean): string[] {
  const p = chars(pattern, wide)
  const close = (states: Set<number>) => {
    // A Set visits what is added while it is walked, so a run of stars closes in one pass.
    for (const index of states) if (p[index] === "*") states.add(index + 1)
    return states
  }
  let states = close(new Set([0]))
  for (const char of (prefix ? `${prefix}/` : "").replaceAll("\\", "/").split("")) {
    const next = new Set<number>()
    for (const index of states) {
      if (index >= p.length) continue
      const at = p[index]
      if (at === "*") next.add(index)
      else if (at === "?" || at === char || (wide && at.toLowerCase() === char.toLowerCase())) next.add(index + 1)
    }
    states = close(next)
    if (states.size === 0) return []
  }
  return [...states].map((index) => p.slice(index).join(""))
}

/** False only when no text matches both patterns. Letter case is ignored, so it errs toward an overlap. */
export function overlaps(a: string, b: string): boolean {
  const x = chars(a, true).map((char) => char.toLowerCase())
  const y = chars(b, true).map((char) => char.toLowerCase())
  const seen = new Set<number>()
  const stack: [number, number][] = [[0, 0]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    const key = i * (y.length + 1) + j
    if (seen.has(key)) continue
    seen.add(key)
    if (i === x.length && j === y.length) return true
    if (i < x.length && x[i] === "*") stack.push([i + 1, j])
    if (j < y.length && y[j] === "*") stack.push([i, j + 1])
    if (i === x.length || j === y.length) continue
    const xs = x[i] === "*"
    const ys = y[j] === "*"
    if (xs && ys) continue
    if (xs) stack.push([i, j + 1])
    else if (ys) stack.push([i + 1, j])
    else if (x[i] === "?" || y[j] === "?" || x[i] === y[j]) stack.push([i + 1, j + 1])
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Check 1: settings the reviewed changes may have edited

/** The files a non-PR review reads its settings from, in the working tree it reviews. */
export const SETTINGS_PATHS: readonly string[] = [REVIEW_CONFIG_PATH, ...REVIEW_RULES_PATHS, ".gitattributes"]

/** The note a review gets when the changes edit VectorScope's own settings. Its verdict is `incomplete`. */
export const SETTINGS_NOTE =
  "These changes edit VectorScope's own settings, so connect did not review them. Run `vector review` yourself."

const SETTINGS = new Set([...SETTINGS_PATHS, ".vector"].map((path) => path.toLowerCase()))

/**
 * A settings path that is a link, or lies beneath one, in the working tree a review reads. The review reads its
 * settings through links, so what it reads is the target.
 */
export interface SettingsLink {
  /** `.vector`, or one of `SETTINGS_PATHS`, whose real path differs from its own. */
  readonly path: string
  /** The real path, relative to the repository's root. Absent when Vector could not resolve it. */
  readonly target?: string
  /** The target lies outside the repository, so the reviewed changes cannot edit what it reads. */
  readonly outside?: boolean
}

/**
 * The changed paths that are VectorScope's settings files, or the `.vector` directory itself, or that a settings link
 * resolves to (or lies beneath, for a linked directory). Letter case is ignored, because on a case-insensitive disk
 * `.vector/Review.json` is the file the review reads. Pass both sides of a rename. A link Vector could not resolve is
 * returned itself (fail closed); one whose target lies outside the repository is not, since no change can edit it.
 */
export function editedSettings(changed: readonly string[], links: readonly SettingsLink[] = []): string[] {
  const clean = (path: string) => (normalizePath(path) ?? path.trim().replaceAll("\\", "/")).toLowerCase()
  const targets = links.flatMap((link) => (link.target === undefined ? [] : [clean(link.target)]))
  const edited = changed.filter((path) => {
    const name = clean(path)
    return SETTINGS.has(name) || targets.some((target) => name === target || name.startsWith(`${target}/`))
  })
  const unresolved = links.filter((link) => link.target === undefined && !link.outside).map((link) => link.path)
  return [...new Set([...edited, ...unresolved])]
}

// ---------------------------------------------------------------------------------------------------------------

/** Where code goes, in plain words for a consent or a reason. "local" never appears here. */
function place(sendsTo: Connect.SendsTo): string {
  if (sendsTo === "this-computer") return "this computer"
  if (sendsTo === "vector-codium") return "Vector Codium"
  if (sendsTo.startsWith("model-server:")) return `your model server ${sendsTo.slice("model-server:".length)}`
  return `the provider ${sendsTo.slice("provider:".length)}`
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

function token(value: string): string {
  return value.trim().replace(/\s+/g, "-").slice(0, 280)
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function sentence(parts: readonly string[]): string {
  return [...new Set(parts)].join("; ")
}
