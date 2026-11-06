import type { Message, Part, Session, SessionStatus, ToolPart } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import { GENERAL_SUBAGENT_ID, subagentIdentity } from "@vectordevai/session-ui/subagent-identity"
import { taskBatchEntries, taskItemState } from "@vectordevai/ui/task-batch"
import { isInternalSession } from "@/utils/internal-sessions"
import { english, type TaskTranslate } from "./task-limits"

/*
 * Pure derivation behind the Background tasks panel and the inline task chips.
 *
 * One card per user turn: every task tool part whose assistant message answers
 * the same user message. One phase per assistant message inside that turn: the
 * engine runs the task calls of one message together, and the next phase only
 * starts in a later message. A task part can contain several indexed agents.
 *
 * The engine now mirrors a lifecycle record onto the child session
 * (metadata.subagent) and onto the parent's task part metadata. Older sessions
 * have neither, so every field falls back to what was always there: the part's
 * input and state, metadata.sessionId, the child session info, session_status
 * and the child's own messages. Nothing here may throw or yield undefined text.
 */

export type SubagentKind = "subagent" | "specialist"

/** Display status. Colours: running purple, waiting amber, done green, failed red, stopped muted, pending outlined. */
export type TaskStatus = "pending" | "running" | "waiting" | "done" | "failed" | "stopped"

/** Engine lifecycle status (packages/engine/src/agent/subagent-kind.ts). */
export type LifecycleStatus = "queued" | "running" | "completed" | "error" | "cancelled"

/** Other names models use for the general-purpose Subagent; mirrors the engine's GENERAL_ALIASES. */
export const GENERAL_ALIASES: readonly string[] = ["general-purpose", "general_purpose", "subagent"]

export const KIND_LABEL: Record<SubagentKind, string> = {
  subagent: "Subagent",
  specialist: "Subagent specialist",
}

export type TaskModel = {
  providerID: string
  modelID: string
  variant?: string
  /** Catalogue name, or the model id when the catalogue does not know it. */
  name: string
  /** The name without a leading "Claude ", for the narrow table column. */
  short: string
}

/*
 * The 1.99.113 fields (4.5, 4.6). Each is read from the task part's metadata first, the child's record next, and a
 * board observation last, so chips show before the board refreshes. Enums the engine may extend stay strings.
 */

/** A checked answer: `format` "json" for an output_schema child; `valid` once checked. */
export type TaskResult = { format: string; valid?: boolean; attempts?: number }

/** The child's own worktree or copy. Never the directory: the record keeps none and the board strips it for viewers. */
export type TaskIsolation = {
  mode: string
  state: string
  branch?: string
  files?: number
  additions?: number
  deletions?: number
  merged?: string[]
  skipped?: string[]
  conflicts?: string[]
  error?: string
}

/** An unanswered permission or question. */
export type TaskWaiting = { kind: string; since: number; summary?: string }

/** Stopped by a restart, a crash or an instance disposal; nothing resumes it on its own. */
export type TaskInterrupted = { at: number; cause: string; resumedAt?: number; dismissedAt?: number }

export type TaskWorkflowStage = {
  id: string
  title: string
  phase: string
  total?: number
  done: number
  failed: number
  skipped: number
  running: number
  waiting: number
}

/** A workflow run (`role` "run") or one of its agents (`role` "agent"). */
export type TaskWorkflow = {
  role: string
  runID?: string
  title?: string
  stage?: string
  phase?: string
  item?: string
  round?: number
  verified?: boolean
  stages?: TaskWorkflowStage[]
  agents?: { launched: number; max: number; running: number }
}

export type TaskAgent = {
  key: string
  partID?: string
  callID?: string
  messageID?: string
  batchIndex?: number
  sessionID?: string
  agent: string
  kind: SubagentKind
  custom: boolean
  /** "Subagent", a specialist's own name, or a custom agent's id. */
  label: string
  title: string
  prompt?: string
  status: TaskStatus
  background: boolean
  startedAt?: number
  endedAt?: number
  tokens?: number
  tokensOwnOnly?: boolean
  toolUses?: number
  model?: TaskModel
  error?: string
  task?: Task.Info
  cost?: number
  unpricedSteps?: number
  codiumSteps?: number
  currentStep?: string
  ownedPaths?: readonly string[]
  dependsOn?: readonly string[]
  /** The effort the child runs at, when the call or Thorough set one: "default", "low", "medium" or "high". */
  effort?: string
  /** Started from the whole conversation (`fork: true`). */
  fork?: boolean
  result?: TaskResult
  isolation?: TaskIsolation
  /** Why a queued child has not started, e.g. "Waiting for a free subagent slot". */
  queuedReason?: string
  waiting?: TaskWaiting
  interrupted?: TaskInterrupted
  workflow?: TaskWorkflow
  /**
   * Later task parts that only added to this agent's live run (a task_id call
   * on a job still running). They get no row, square or chip of their own.
   */
  extendPartIDs?: string[]
}

export type TaskPhase = {
  key: string
  messageID?: string
  index: number
  name: string
  status: TaskStatus
  done: number
  total: number
  startedAt?: number
  endedAt?: number
  agents: TaskAgent[]
}

export type TaskCard = {
  key: string
  title: string
  description: string
  kindLabel: string
  status: TaskStatus
  live: boolean
  startedAt?: number
  endedAt?: number
  tokens?: number
  tokensOwnOnly?: boolean
  agents: TaskAgent[]
  phases: TaskPhase[]
  /** A workflow run's card: its run row and whichever of its agents have been loaded. */
  runID?: string
}

export type TaskSource = {
  rootID: string
  messages(sessionID: string): readonly Message[] | undefined
  parts(messageID: string): readonly Part[] | undefined
  session(sessionID: string): Session | undefined
  /** Known child sessions of the root, from the store or the children route. */
  children?: readonly Session[]
  status?(sessionID: string): SessionStatus | undefined
  /** True when the session has an unanswered permission or question request. */
  waiting?(sessionID: string): boolean
  modelName?(providerID: string, modelID: string): string | undefined
}

// ---------------------------------------------------------------------------
// Formatting

/** 950 → "950", 228_600 → "228.6k", 1_234_567 → "1.23M", unknown → "—". */
export function formatTokens(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  if (value < 1000) return String(Math.round(value))
  if (value < 999_950) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** 42_000 → "42s", 1_574_000 → "26m 14s", 3_840_000 → "1h 04m", unknown → "—". */
export function formatDuration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return "—"
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function formatAgentCount(count: number) {
  return count === 1 ? "1 agent" : `${count} agents`
}

/** Milliseconds a task has run: to its end once finished, to `now` while live. */
export function elapsedMs(
  item: { startedAt?: number; endedAt?: number; status: TaskStatus; task?: Task.Info },
  now: number,
) {
  if (item.task?.connection === "disconnected") return item.task.elapsedMs
  if (item.startedAt === undefined) return undefined
  const end = item.endedAt ?? (isLive(item.status) ? now : undefined)
  if (end === undefined) return undefined
  return Math.max(0, end - item.startedAt)
}

export function isLive(status: TaskStatus) {
  return status === "pending" || status === "running" || status === "waiting"
}

/** The word shown once a task stops running, or while it waits on the user. */
export function statusWord(status: TaskStatus) {
  if (status === "done") return "Done"
  if (status === "failed") return "Failed"
  if (status === "stopped") return "Stopped"
  if (status === "waiting") return "Needs you"
  if (status === "pending") return "Not started"
  return "Running"
}

// ---------------------------------------------------------------------------
// Kinds and names

/** Engine agent id for a task call. The resolved metadata agent wins; the raw subagent_type is alias-mapped. */
export function resolveAgent(input: {
  metadata?: unknown
  record?: unknown
  child?: unknown
  requested?: unknown
  title?: string
}) {
  for (const value of [input.metadata, input.record, input.child]) {
    const name = text(value)
    if (name) return name
  }
  const requested = text(input.requested)
  if (requested) {
    const lower = requested.toLowerCase()
    if (lower === GENERAL_SUBAGENT_ID || GENERAL_ALIASES.includes(lower)) return GENERAL_SUBAGENT_ID
    return requested
  }
  return suffixAgent(input.title) ?? GENERAL_SUBAGENT_ID
}

export function subagentKind(agent: string, reported?: unknown): SubagentKind {
  if (reported === "subagent" || reported === "specialist") return reported
  return agent === GENERAL_SUBAGENT_ID ? "subagent" : "specialist"
}

/** "Subagent" for the general agent, a specialist's display name, or a custom agent's id as written. */
export function agentLabel(agent: string) {
  if (agent === GENERAL_SUBAGENT_ID) return KIND_LABEL.subagent
  return subagentIdentity(agent)?.name ?? agent
}

/**
 * Card and chip kind label: "Subagent" / "Subagents" when every agent is the
 * general one, "Specialist · Review" for one specialist type, "Specialists"
 * for several, "Subagents & specialists" for a mix.
 */
export function kindLabel(agents: readonly Pick<TaskAgent, "agent" | "kind">[]) {
  if (agents.length === 0) return KIND_LABEL.subagent
  const specialists = agents.filter((agent) => agent.kind === "specialist")
  if (specialists.length === 0) return agents.length === 1 ? "Subagent" : "Subagents"
  if (specialists.length < agents.length) return "Subagents & specialists"
  const types = new Set(specialists.map((agent) => agent.agent))
  if (types.size === 1) return `Specialist · ${agentLabel(specialists[0]!.agent)}`
  return "Specialists"
}

const SUFFIX = /\s*\(@([^)]+) subagent\)\s*$/

/** Drops the engine's " (@explore subagent)" child-title suffix. */
export function stripSubagentSuffix(title: string | undefined) {
  return (title ?? "").replace(SUFFIX, "").trim()
}

function suffixAgent(title: string | undefined) {
  const match = title?.match(SUFFIX)
  return match?.[1]?.trim() || undefined
}

const TITLE_MAX = 60
const TITLE_WORDS = 6

/** Mirrors the engine's subagentTitle: the description, else the prompt's first words, capped near 60 characters. */
export function subagentTitle(description: unknown, prompt: unknown) {
  const collapse = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")
  const title = collapse(description) || collapse(prompt).split(" ").slice(0, TITLE_WORDS).join(" ")
  if (!title) return ""
  if (title.length <= TITLE_MAX) return title
  const cut = title.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function modelShortName(name: string) {
  return name.replace(/^Claude\s+/i, "").trim() || name
}

// ---------------------------------------------------------------------------
// Labels for the 1.99.113 fields (5.I.3). Every value a model or child wrote is returned as text for a text node.

/** "Opus 5 · high": the model column. "default" adds nothing, so it is left out. */
export function modelEffortLabel(
  agent: Pick<TaskAgent, "model" | "effort">,
  t: TaskTranslate = english,
): string | undefined {
  const effort = agent.effort && agent.effort !== "default" ? agent.effort : undefined
  if (!agent.model) return effort
  return effort ? t("backgroundTasks.effort", { model: agent.model.short, effort }) : agent.model.short
}

/** "Queued: waiting for a free subagent slot", from the engine's slot reason. */
export function queuedLabel(reason: string, t: TaskTranslate = english) {
  const trimmed = reason.trim()
  const lowered = /^[A-Z][a-z]/.test(trimmed) ? trimmed[0]!.toLowerCase() + trimmed.slice(1) : trimmed
  return t("backgroundTasks.queued", { reason: lowered })
}

/** "Needs your permission · 3m" or "Needs your answer · <1m". */
export function waitingLabel(waiting: TaskWaiting, now: number, t: TaskTranslate = english) {
  const minutes = Math.floor(Math.max(0, now - waiting.since) / 60_000)
  const time =
    minutes < 1 ? t("backgroundTasks.waiting.justNow") : t("backgroundTasks.waiting.minutes", { count: minutes })
  return waiting.kind === "question"
    ? t("backgroundTasks.waiting.question", { time })
    : t("backgroundTasks.waiting.permission", { time })
}

/**
 * The JSON chip: "valid" (green), "invalid" (red) or "pending". Its text says which too ("JSON valid"), so the state
 * is never shown by colour alone, and its tooltip adds the attempts.
 */
export function resultChip(result: TaskResult | undefined, t: TaskTranslate = english) {
  if (!result || result.format !== "json") return undefined
  const state: "valid" | "invalid" | "pending" =
    result.valid === true ? "valid" : result.valid === false ? "invalid" : "pending"
  const base = t(`backgroundTasks.json.${state}`)
  const title =
    result.attempts !== undefined && result.attempts > 1
      ? t("backgroundTasks.json.attempts", { label: base, count: result.attempts })
      : base
  return { state, label: t(`backgroundTasks.json.label.${state}`), title }
}

/**
 * What a workflow stage's count says beside done/total: its failed and skipped agents and whether one waits on the user.
 * The stage's bar shows them by colour only, and is hidden from screen readers.
 */
export function stageNotes(
  stage: Pick<Task.WorkflowStage, "failed" | "skipped" | "waiting">,
  t: TaskTranslate = english,
): string[] {
  return [
    ...(stage.failed > 0 ? [t("backgroundTasks.workflow.failed", { count: stage.failed })] : []),
    ...(stage.skipped > 0 ? [t("backgroundTasks.workflow.skipped", { count: stage.skipped })] : []),
    ...(stage.waiting > 0 ? [t("backgroundTasks.workflow.waiting")] : []),
  ]
}

/**
 * Below a review patch that was cut short: what the user can do to see the rest. The pane never holds the checkout's
 * folder, so a worktree's branch is named for git, and a copy (which has no branch) is merged whole.
 */
export function patchTruncatedText(isolation: Pick<TaskIsolation, "branch">, t: TaskTranslate = english) {
  return isolation.branch
    ? t("backgroundTasks.worktree.patchTruncated.branch", { branch: isolation.branch })
    : t("backgroundTasks.worktree.patchTruncated.copy")
}

/** "Worktree: vector/task-ses_1 · changed · 3 files changed". */
export function isolationLabel(isolation: TaskIsolation, t: TaskTranslate = english) {
  const kind = isolation.mode === "copy" ? t("backgroundTasks.worktree.copy") : t("backgroundTasks.worktree")
  const files =
    isolation.files === undefined
      ? []
      : [t(`backgroundTasks.worktree.files.${isolation.files === 1 ? "one" : "other"}`, { count: isolation.files })]
  return `${kind}: ${[...(isolation.branch ? [isolation.branch] : []), isolation.state, ...files].join(" · ")}`
}

/** Interrupted by a restart and neither resumed nor dismissed since. */
export function isInterrupted(agent: Pick<TaskAgent, "interrupted" | "status">) {
  const interrupted = agent.interrupted
  return (
    !!interrupted &&
    !isLive(agent.status) &&
    interrupted.resumedAt === undefined &&
    interrupted.dismissedAt === undefined
  )
}

/** A workflow agent whose run row stands for it: one stop, one spend and one count per run. */
export function coveredByRun(agent: Pick<TaskAgent, "task">, runs: ReadonlySet<string>) {
  const workflow = agent.task?.workflow
  return workflow?.role === "agent" && runs.has(workflow.runID)
}

/** The workflow runs listed among these agents, by run ID. */
export function runIDs(agents: readonly Pick<TaskAgent, "task">[]) {
  return new Set(
    agents.flatMap((agent) =>
      agent.task?.workflow?.role === "run" ? [agent.task.workflow.runID || agent.task.id] : [],
    ),
  )
}

// ---------------------------------------------------------------------------
// Lifecycle fields, read defensively from either surface

type Usage = { total?: number; toolUses?: number; cost?: number; unpricedSteps?: number; codiumSteps?: number }

type Lifecycle = {
  kind?: SubagentKind
  agent?: string
  custom?: boolean
  title?: string
  callID?: string
  batchIndex?: number
  parentMessageID?: string
  sessionID?: string
  background?: boolean
  status?: LifecycleStatus
  startedAt?: number
  completedAt?: number
  usage?: Usage
  error?: string
  ownedPaths?: readonly string[]
  dependsOn?: readonly string[]
  model?: { providerID: string; modelID: string; variant?: string }
  effort?: string
  fork?: boolean
  result?: TaskResult
  isolation?: TaskIsolation
  queuedReason?: string
  waiting?: TaskWaiting
  interrupted?: TaskInterrupted
  workflow?: TaskWorkflow
  groupID?: string
}

const LIFECYCLE_STATUSES: readonly string[] = ["queued", "running", "completed", "error", "cancelled"]

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readModel(value: unknown) {
  const item = record(value)
  const providerID = text(item?.providerID)
  const modelID = text(item?.modelID) ?? text(item?.id)
  if (!providerID || !modelID) return undefined
  const variant = text(item?.variant)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function readUsage(value: unknown): Usage | undefined {
  const item = record(value)
  if (!item) return undefined
  const tokens = record(item.tokens)
  const cache = record(tokens?.cache)
  const summed = tokens
    ? [tokens.input, tokens.output, tokens.reasoning, cache?.read, cache?.write].reduce<number>(
        (sum, part) => sum + (finite(part) ?? 0),
        0,
      )
    : undefined
  const total = finite(item.total) ?? summed
  const toolUses = finite(item.toolUses)
  if (total === undefined && toolUses === undefined && item.codiumSteps === undefined) return undefined
  return {
    total,
    toolUses,
    ...definedFields({
      cost: finite(item.cost),
      unpricedSteps: finite(item.unpricedSteps),
      codiumSteps: finite(item.codiumSteps),
    }),
  }
}

// A short lowercase word ("low", "high"); anything else is not an effort.
const EFFORT = /^[a-z][a-z-]{0,15}$/
const CONFLICTS_MAX = 50

function count(value: unknown) {
  const number = finite(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function strings(value: unknown, max: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, max)
    : undefined
}

/** `result` as the board sends it, or `structured` as the part ({valid, attempts}) and the record (schema too) keep it. */
function readResult(result: unknown, structured: unknown): TaskResult | undefined {
  const board = record(result)
  const format = text(board?.format)
  if (board && format)
    return definedFields({
      format,
      valid: typeof board.valid === "boolean" ? board.valid : undefined,
      attempts: count(board.attempts),
    }) as TaskResult
  const checked = record(structured)
  if (!checked) return undefined
  return definedFields({
    format: "json",
    valid: typeof checked.valid === "boolean" ? checked.valid : undefined,
    attempts: count(checked.attempts),
  }) as TaskResult
}

/** Isolation without its directory, which only the owner may see and the pane never shows. */
export function readIsolation(value: unknown): TaskIsolation | undefined {
  const item = record(value)
  const mode = text(item?.mode)
  const state = text(item?.state)
  if (!item || !mode || !state) return undefined
  return definedFields({
    mode,
    state,
    branch: text(item.branch),
    files: count(item.files),
    additions: count(item.additions),
    deletions: count(item.deletions),
    merged: strings(item.merged, 500),
    skipped: strings(item.skipped, 500),
    conflicts: strings(item.conflicts, CONFLICTS_MAX),
    error: text(item.error),
  }) as TaskIsolation
}

function readWaiting(value: unknown): TaskWaiting | undefined {
  const item = record(value)
  const kind = text(item?.kind)
  const since = finite(item?.since)
  if (!item || !kind || since === undefined) return undefined
  return definedFields({ kind, since, summary: text(item.summary) }) as TaskWaiting
}

/** The record's `interruption` or the board's `interrupted`; a cause it does not know reads as "unknown". */
function readInterrupted(value: unknown): TaskInterrupted | undefined {
  const item = record(value)
  const at = finite(item?.at)
  if (!item || at === undefined) return undefined
  return definedFields({
    at,
    cause: text(item.cause) ?? "unknown",
    resumedAt: finite(item.resumedAt),
    dismissedAt: finite(item.dismissedAt),
  }) as TaskInterrupted
}

function readStage(value: unknown): TaskWorkflowStage | undefined {
  const item = record(value)
  const id = text(item?.id)
  if (!item || !id) return undefined
  return definedFields({
    id,
    title: text(item.title) ?? id,
    phase: text(item.phase) ?? "",
    total: count(item.total),
    done: count(item.done) ?? 0,
    failed: count(item.failed) ?? 0,
    skipped: count(item.skipped) ?? 0,
    running: count(item.running) ?? 0,
    waiting: count(item.waiting) ?? 0,
  }) as TaskWorkflowStage
}

/** The board's `workflow`, or the record's (a run keeps its stages in `progress`). */
export function readWorkflow(value: unknown): TaskWorkflow | undefined {
  const item = record(value)
  const role = text(item?.role)
  if (!item || !role) return undefined
  const progress = record(item.progress)
  const stages = (Array.isArray(item.stages) ? item.stages : Array.isArray(progress?.stages) ? progress.stages : [])
    .map(readStage)
    .filter((stage): stage is TaskWorkflowStage => !!stage)
  const agents = record(item.agents) ?? record(progress?.agents)
  const launched = count(agents?.launched)
  const max = count(agents?.max)
  return definedFields({
    role,
    runID: text(item.runID),
    title: text(item.title),
    stage: text(item.stage),
    phase: text(item.phase),
    item: text(item.item),
    round: count(item.round),
    verified: typeof item.verified === "boolean" ? item.verified : undefined,
    stages: stages.length ? stages : undefined,
    agents:
      launched !== undefined && max !== undefined ? { launched, max, running: count(agents?.running) ?? 0 } : undefined,
  }) as TaskWorkflow
}

/** Reads lifecycle fields from a task part's metadata (parentMessageId, sessionId) or a child record (parentMessageID). */
export function readLifecycle(value: unknown): Lifecycle {
  const item = record(value)
  if (!item) return {}
  const kind = item.kind === "subagent" || item.kind === "specialist" ? item.kind : undefined
  const status = typeof item.status === "string" && LIFECYCLE_STATUSES.includes(item.status) ? item.status : undefined
  const effort = text(item.effort)
  return {
    kind,
    agent: text(item.agent),
    custom: typeof item.custom === "boolean" ? item.custom : undefined,
    title: text(item.title),
    callID: text(item.callID),
    batchIndex:
      typeof item.batchIndex === "number" && Number.isSafeInteger(item.batchIndex) && item.batchIndex >= 0
        ? item.batchIndex
        : undefined,
    parentMessageID: text(item.parentMessageID) ?? text(item.parentMessageId),
    sessionID: text(item.sessionId),
    background: typeof item.background === "boolean" ? item.background : undefined,
    status: status as LifecycleStatus | undefined,
    startedAt: finite(item.startedAt),
    completedAt: finite(item.completedAt),
    usage: readUsage(item.usage),
    error: text(item.error),
    ownedPaths: Array.isArray(item.ownedPaths)
      ? item.ownedPaths.filter((path): path is string => typeof path === "string")
      : undefined,
    dependsOn: Array.isArray(item.dependsOn)
      ? item.dependsOn.filter((id): id is string => typeof id === "string")
      : undefined,
    model: readModel(item.model),
    effort: effort && EFFORT.test(effort) ? effort : undefined,
    // The part says `fork: true`; the record keeps `{point, callID, …}`.
    fork: item.fork === true || record(item.fork) ? true : undefined,
    result: readResult(item.result, item.structured),
    isolation: readIsolation(item.isolation),
    // The part mirrors the record's slotReason as queuedReason.
    queuedReason: text(item.queuedReason) ?? text(item.slotReason),
    waiting: readWaiting(item.waiting),
    interrupted: readInterrupted(item.interruption ?? item.interrupted),
    workflow: readWorkflow(item.workflow),
    groupID: text(item.groupID),
  }
}

/** The child session's metadata.subagent record, or undefined for sessions that predate it. */
export function childRecord(session: Session | undefined) {
  const value = record(session?.metadata)?.subagent
  return record(value) ? readLifecycle(value) : undefined
}

// ---------------------------------------------------------------------------
// Status

export type StatusInput = {
  /** The parent task part's state, when there is a part. */
  part?: "pending" | "running" | "completed" | "error"
  partError?: string
  /** Lifecycle status from the part metadata or the matching child record. */
  reported?: LifecycleStatus
  background?: boolean
  startedAt?: number
  /** The child's session_status. */
  child?: SessionStatus["type"]
  /** The child's last assistant message, if its messages are loaded. */
  last?: { created?: number; completed?: number; error?: string }
  waiting?: boolean
}

const ABORTED = "MessageAbortedError"

function fromLast(last: StatusInput["last"]): TaskStatus | undefined {
  if (!last) return undefined
  if (last.error === ABORTED) return "stopped"
  if (last.error) return "failed"
  return "done"
}

function fromError(error: string | undefined): TaskStatus {
  return /cancel|abort|interrupt/i.test(error ?? "") ? "stopped" : "failed"
}

export function agentStatus(input: StatusInput): TaskStatus {
  const busy = input.child === "busy" || input.child === "retry"
  const status = baseStatus(input, busy)
  if (isLive(status) && input.waiting) return "waiting"
  return status
}

function baseStatus(input: StatusInput, busy: boolean): TaskStatus {
  const reported = input.reported
  if (reported === "completed") return "done"
  if (reported === "error") return "failed"
  if (reported === "cancelled") return "stopped"
  if (reported === "queued" || reported === "running") {
    if (busy) return "running"
    // A foreground part that failed before the lifecycle merged its outcome.
    if (input.part === "error") return fromError(input.partError)
    // A record that still says live while the child is idle: the job may have
    // died with an engine restart (idle children often have no status entry
    // at all after a reload). A finished reply from this run settles it.
    const last = input.last
    const current =
      last && last.completed !== undefined && (input.startedAt === undefined || (last.created ?? 0) >= input.startedAt)
    if (input.part !== "pending" && current) return fromLast(last) ?? "done"
    return reported === "queued" ? "pending" : "running"
  }
  // No lifecycle status: sessions from before the engine recorded one.
  if (input.part === "pending") return busy ? "running" : "pending"
  if (input.part === "running") return "running"
  if (input.part === "error") return fromError(input.partError)
  if (busy) return "running"
  return fromLast(input.last) ?? "done"
}

const SUMMARY_WORDS: readonly [TaskStatus, string][] = [
  ["running", "running"],
  ["waiting", "waiting on you"],
  ["pending", "not started"],
  ["done", "done"],
  ["failed", "failed"],
  ["stopped", "stopped"],
]

/** "2 running, 1 not started": the spoken form of a row of status squares. */
export function statusSummary(statuses: readonly TaskStatus[]) {
  return SUMMARY_WORDS.map(([status, word]) => {
    const count = statuses.filter((value) => value === status).length
    return count ? `${count} ${word}` : ""
  })
    .filter(Boolean)
    .join(", ")
}

/** Surface requests for user input even while other agents are still working. */
export function aggregateStatus(statuses: readonly TaskStatus[]): TaskStatus {
  for (const status of ["waiting", "running", "pending", "failed", "stopped"] as const) {
    if (statuses.includes(status)) return status
  }
  return "done"
}

// ---------------------------------------------------------------------------
// Child session measurements

type ChildFacts = {
  tokens?: number
  tokensOwnOnly?: boolean
  toolUses?: number
  last?: StatusInput["last"]
  lastModel?: { providerID: string; modelID: string; variant?: string }
  currentStep?: string
  cost?: number
  unpricedSteps?: number
  codiumSteps?: number
}

function tokenSum(tokens: unknown) {
  const item = record(tokens)
  if (!item) return 0
  const cache = record(item.cache)
  return [item.input, item.output, item.reasoning, cache?.read, cache?.write].reduce<number>(
    (sum, part) => sum + (finite(part) ?? 0),
    0,
  )
}

/**
 * Live facts from a child's own messages. Tokens sum every step-finish part
 * (the engine's own definition of usage); when no step parts are loaded the
 * assistant messages' tokens stand in, then the session row.
 */
export function childFacts(source: TaskSource, sessionID: string | undefined): ChildFacts {
  if (!sessionID) return {}
  const messages = source.messages(sessionID) ?? []
  let steps = 0
  let stepTokens: number | undefined
  let stepCodium = 0
  let messageCodium = 0
  let toolUses: number | undefined
  let messageTokens: number | undefined
  let last: ChildFacts["last"]
  let lastModel: ChildFacts["lastModel"]
  let currentStep: string | undefined
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const codium = Boolean(Billing.of(message))
    messageCodium += Number(codium)
    const own = Billing.hasOwnIdentity(message)
    if (own) messageTokens = (messageTokens ?? 0) + tokenSum(message.tokens)
    last = {
      created: finite(message.time?.created),
      completed: finite(message.time?.completed),
      error: text(message.error?.name),
    }
    const model = readModel({ providerID: message.providerID, modelID: message.modelID, variant: message.variant })
    if (model) lastModel = model
    const parts = source.parts(message.id)
    if (!parts) continue
    toolUses ??= 0
    for (const part of parts) {
      if (part.type === "tool") {
        toolUses += 1
        if (part.state)
          currentStep = `${part.tool}: ${"title" in part.state && part.state.title ? part.state.title : part.state.status}`
      }
      if (part.type === "step-finish") {
        steps += 1
        const billed = codium || Boolean(Billing.of(part))
        stepCodium += Number(billed)
        if (!billed && own) stepTokens = (stepTokens ?? 0) + tokenSum(part.tokens)
      }
    }
  }
  const session = source.session(sessionID)
  const legacy =
    session?.tokensOwnOnly !== true &&
    Boolean(messageCodium || (session?.codiumSteps ?? 0) > 0 || (session && Billing.of(session)))
  const row = tokenSum(session?.tokens)
  const tokens =
    steps > 0
      ? stepTokens
      : messageCodium
        ? messageTokens
        : legacy
          ? messageTokens
          : session?.tokensOwnOnly === true && row > 0
            ? row
            : messageTokens
  const codiumSteps = Math.max(session?.codiumSteps ?? 0, steps ? stepCodium : messageCodium, legacy ? 1 : 0)
  return {
    tokens,
    tokensOwnOnly: tokens !== undefined,
    toolUses,
    last,
    lastModel,
    currentStep,
    cost: finite(source.session(sessionID)?.cost),
    unpricedSteps: finite(source.session(sessionID)?.unpricedSteps),
    ...(codiumSteps ? { codiumSteps } : {}),
  }
}

// ---------------------------------------------------------------------------
// Agents

function modelRef(source: TaskSource, value: { providerID: string; modelID: string; variant?: string } | undefined) {
  if (!value) return undefined
  const name = text(source.modelName?.(value.providerID, value.modelID)) ?? value.modelID
  return { ...value, name, short: modelShortName(name) } satisfies TaskModel
}

function sessionModel(session: Session | undefined) {
  return readModel(session?.model)
}

type AgentSeed = {
  key: string
  part?: ToolPart
  messageID?: string
  child?: Session
  item?: { index: number; input: Record<string, unknown>; metadata: Record<string, unknown> }
}

function buildAgent(source: TaskSource, seed: AgentSeed): TaskAgent {
  const part = seed.part
  const state = part?.state
  const input = seed.item?.input ?? record(state?.input) ?? {}
  const meta = readLifecycle(
    seed.item?.metadata ?? ("metadata" in (state ?? {}) ? (state as { metadata?: unknown }).metadata : undefined),
  )
  const sessionID = meta.sessionID ?? seed.child?.id
  const child = sessionID ? (source.session(sessionID) ?? seed.child) : seed.child
  const stored = childRecord(child)
  // A task_id resume rewrites the child's record for the new run, so its run
  // fields only describe this part when the call ids agree.
  const matched =
    stored &&
    (!part ||
      ((!stored.callID || stored.callID === part.callID) &&
        (!stored.parentMessageID || stored.parentMessageID === seed.messageID) &&
        stored.batchIndex === seed.item?.index))
      ? stored
      : undefined
  const run: Lifecycle = { ...matched, ...definedFields(meta), ...finishedFields(matched, meta) }
  const facts = childFacts(source, sessionID)
  const agent = resolveAgent({
    metadata: meta.agent,
    record: stored?.agent,
    child: child?.agent,
    requested: input.subagent_type,
    title: child?.title,
  })
  const kind = subagentKind(agent, meta.kind ?? stored?.kind)
  const background = run.background ?? false
  const startedAt =
    run.startedAt ??
    (seed.item
      ? undefined
      : ((state && "time" in state ? finite((state as { time?: { start?: unknown } }).time?.start) : undefined) ??
        finite(child?.time?.created)))
  const partError = seed.item
    ? text(seed.item.metadata.error)
    : state?.status === "error"
      ? text(state.error)
      : undefined
  const status = agentStatus({
    part: seed.item ? taskItemState(seed.item.metadata.status, state?.status) : state?.status,
    partError,
    reported: run.status,
    background,
    startedAt,
    child: sessionID ? source.status?.(sessionID)?.type : undefined,
    last: facts.last,
    waiting: sessionID ? source.waiting?.(sessionID) : false,
  })
  const settledEnd =
    !background && (state?.status === "completed" || state?.status === "error") ? finite(state.time?.end) : undefined
  const endedAt = isLive(status)
    ? undefined
    : (run.completedAt ?? settledEnd ?? facts.last?.completed ?? finite(child?.time?.updated))
  const title =
    run.title || subagentTitle(input.description, input.prompt) || stripSubagentSuffix(child?.title) || "Subagent task"
  const model = modelRef(source, run.model ?? stored?.model ?? facts.lastModel ?? sessionModel(child))
  const codiumSteps =
    run.usage?.codiumSteps ?? facts.codiumSteps ?? (Billing.isCodium(model?.providerID) ? 1 : undefined)
  const error =
    run.error ?? partError ?? (facts.last?.error && facts.last.error !== ABORTED ? facts.last.error : undefined)
  return {
    key: seed.key,
    partID: part?.id,
    callID: part?.callID ?? stored?.callID,
    messageID: seed.messageID ?? stored?.parentMessageID,
    batchIndex: seed.item?.index ?? stored?.batchIndex,
    sessionID,
    agent,
    kind,
    custom: meta.custom ?? stored?.custom ?? (kind === "specialist" && !subagentIdentity(agent)),
    label: agentLabel(agent),
    title,
    prompt: text(input.prompt),
    status,
    background,
    startedAt,
    endedAt: endedAt !== undefined && startedAt !== undefined ? Math.max(endedAt, startedAt) : endedAt,
    // Lifecycle metadata is editable and may carry copied historical totals. Only loaded accounting facts certify tokens.
    tokens: facts.tokens,
    tokensOwnOnly: facts.tokensOwnOnly === true,
    toolUses: run.usage?.toolUses ?? facts.toolUses,
    model,
    error: status === "failed" ? error : undefined,
    cost: facts.cost ?? run.usage?.cost,
    unpricedSteps: facts.unpricedSteps ?? run.usage?.unpricedSteps,
    codiumSteps,
    currentStep: facts.currentStep,
    ownedPaths:
      run.ownedPaths ??
      (Array.isArray(input.owned_paths)
        ? input.owned_paths.filter((path): path is string => typeof path === "string")
        : undefined),
    dependsOn:
      run.dependsOn ??
      (Array.isArray(input.depends_on)
        ? input.depends_on.filter((id): id is string => typeof id === "string")
        : undefined),
    ...definedFields({
      effort: run.effort,
      fork: run.fork,
      result: run.result,
      isolation: run.isolation,
      queuedReason: status === "pending" ? run.queuedReason : undefined,
      waiting: run.waiting,
      interrupted: run.interrupted,
      // A run's record does not name itself; its session is the run.
      workflow:
        run.workflow?.role === "run" && !run.workflow.runID && sessionID
          ? { ...run.workflow, runID: sessionID }
          : run.workflow,
    }),
  }
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>
}

/**
 * The engine settles the child's record first and mirrors it onto the task part afterwards. The mirror waits for the
 * part to settle and gives up after ten minutes, and a client can miss its event, so a part can still say live long
 * after the run ended. A finished record for the same call outranks it: a run never goes back to live under one call.
 */
function finishedFields(record: Lifecycle | undefined, meta: Lifecycle): Partial<Lifecycle> {
  if (!record?.status || liveLifecycle(record.status) || !liveLifecycle(meta.status)) return {}
  return definedFields({
    status: record.status,
    completedAt: record.completedAt,
    usage: record.usage,
    error: record.error,
  })
}

function liveLifecycle(status: LifecycleStatus | undefined) {
  return status === "queued" || status === "running"
}

function looksLikeSubagent(session: Session) {
  return !!childRecord(session) || SUFFIX.test(session.title ?? "")
}

// ---------------------------------------------------------------------------
// Cards and phases

function firstPromptLine(source: TaskSource, userMessageID: string | undefined) {
  if (!userMessageID) return undefined
  for (const part of source.parts(userMessageID) ?? []) {
    if (part.type !== "text" || part.synthetic || part.ignored) continue
    const line = (part.text ?? "")
      .split("\n")
      .map((value) => value.trim())
      .find(Boolean)
    if (line) return line.replace(/\s+/g, " ")
  }
  return undefined
}

export function phaseName(index: number, agents: readonly Pick<TaskAgent, "agent" | "kind">[]) {
  const name = `Phase ${index}`
  if (agents.length === 0 || agents.some((agent) => agent.kind !== "specialist")) return name
  const type = agents[0]!.agent
  if (agents.some((agent) => agent.agent !== type)) return name
  return `${name} · ${agentLabel(type)}`
}

function minDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? Math.min(...list) : undefined
}

function maxDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? Math.max(...list) : undefined
}

function sumDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? list.reduce((sum, value) => sum + value, 0) : undefined
}

function buildPhase(key: string, index: number, messageID: string | undefined, agents: TaskAgent[]): TaskPhase {
  const status = aggregateStatus(agents.map((agent) => agent.status))
  return {
    key,
    messageID,
    index,
    name: phaseName(index, agents),
    status,
    done: agents.filter((agent) => agent.status === "done").length,
    total: agents.length,
    startedAt: minDefined(agents.map((agent) => agent.startedAt)),
    endedAt: isLive(status) ? undefined : maxDefined(agents.map((agent) => agent.endedAt)),
    agents,
  }
}

type CardSeed = {
  key: string
  userMessageID?: string
  phases: { key: string; messageID?: string; agents: TaskAgent[] }[]
}

/** A child session is one agent however many task parts drive it; a part with no child yet is its own. */
function agentIdentity(agent: Pick<TaskAgent, "key" | "sessionID">) {
  return agent.sessionID ?? `part:${agent.key}`
}

function perSession<T extends Pick<TaskAgent, "key" | "sessionID">>(agents: readonly T[]) {
  const seen = new Map<string, T>()
  for (const agent of agents) if (!seen.has(agentIdentity(agent))) seen.set(agentIdentity(agent), agent)
  return [...seen.values()]
}

/** Distinct agents: a child resumed with task_id counts once, however many runs it has had. */
export function countAgents(agents: readonly Pick<TaskAgent, "key" | "sessionID">[]) {
  return perSession(agents).length
}

/**
 * Each child session's tokens once, from its newest run that has a count. A
 * child's usage is cumulative across its runs, so adding runs double-counts.
 */
function sessionTokens(agents: readonly TaskAgent[]) {
  const newest = new Map<string, { startedAt: number; tokens: number }>()
  for (const agent of agents) {
    if (agent.tokens === undefined) continue
    const key = agentIdentity(agent)
    const startedAt = agent.startedAt ?? 0
    const seen = newest.get(key)
    if (!seen || startedAt >= seen.startedAt) newest.set(key, { startedAt, tokens: agent.tokens })
  }
  return sumDefined([...newest.values()].map((entry) => entry.tokens))
}

function buildCard(source: TaskSource, seed: CardSeed): TaskCard {
  const phases = seed.phases.map((phase, index) => buildPhase(phase.key, index + 1, phase.messageID, phase.agents))
  const agents = phases.flatMap((phase) => phase.agents)
  const status = aggregateStatus(agents.map((agent) => agent.status))
  const live = isLive(status)
  const single = agents.length === 1 ? agents[0] : undefined
  const titles = agents.map((agent) => agent.title)
  const title =
    single?.title ??
    firstPromptLine(source, seed.userMessageID) ??
    (agents.length > 1 ? `${titles[0]} and ${agents.length - 1} more` : (titles[0] ?? "Subagent task"))
  return {
    key: seed.key,
    title,
    description: single ? (single.prompt ?? "") : titles.join(", "),
    kindLabel: kindLabel(perSession(agents)),
    status,
    live,
    startedAt: minDefined(agents.map((agent) => agent.startedAt)),
    endedAt: live ? undefined : maxDefined(agents.map((agent) => agent.endedAt)),
    tokens: sessionTokens(agents),
    agents,
    phases,
  }
}

function isTaskPart(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "task"
}

/**
 * A task_id call on a job that is still running adds to that run rather than
 * starting one: the engine leaves the child's record on the launching call and
 * returns a second part for the same child (its message delivered or queued). That
 * part folds into the agent that owns the run. A resume of a finished child
 * rewrites the record to its own call, so it stays a run of its own.
 */
function extendsRun(source: TaskSource, owner: TaskAgent, agent: TaskAgent, part: ToolPart) {
  const recorded = childRecord(agent.sessionID ? source.session(agent.sessionID) : undefined)
  if (
    recorded?.callID === part.callID &&
    recorded.batchIndex === agent.batchIndex &&
    (!recorded.parentMessageID || recorded.parentMessageID === agent.messageID)
  )
    return false
  if (isLive(owner.status)) return true
  // The run has settled since; the part still extended it if it started first.
  return agent.startedAt !== undefined && owner.endedAt !== undefined && agent.startedAt < owner.endedAt
}

/**
 * Every subagent the root session started, grouped into cards (user turns)
 * and phases (assistant messages). Live cards come first, newest first;
 * finished ones follow, most recently finished first.
 */
export function buildTaskCards(source: TaskSource): TaskCard[] {
  // Vector's helper sessions (a Vectorscope review, autocomplete) are children of the task too, but not its subagents;
  // their spend shows in the session's cost instead.
  const children = (source.children ?? []).filter(
    (session) => session.parentID === source.rootID && !isInternalSession(session),
  )
  const byCall = new Map<string, Session>()
  for (const session of children) {
    const record = childRecord(session)
    if (record?.callID) byCall.set(JSON.stringify([record.parentMessageID, record.callID, record.batchIndex]), session)
  }

  const claimed = new Set<string>()
  // The agent that owns each child's latest run, for parts that only extend it.
  const owners = new Map<string, TaskAgent>()
  const cards = new Map<string, CardSeed>()
  const cardFor = (key: string, userMessageID?: string) => {
    const existing = cards.get(key)
    if (existing) return existing
    const next: CardSeed = { key, userMessageID, phases: [] }
    cards.set(key, next)
    return next
  }
  const messageParent = new Map<string, string>()

  for (const message of source.messages(source.rootID) ?? []) {
    if (message.role !== "assistant") continue
    messageParent.set(message.id, message.parentID)
    const parts = (source.parts(message.id) ?? []).filter(isTaskPart)
    if (parts.length === 0) continue
    const agents: TaskAgent[] = []
    for (const part of parts) {
      const metadata = part.state && "metadata" in part.state ? part.state.metadata : undefined
      const items = taskBatchEntries(part.state?.input, metadata)
      for (const item of items?.length ? items : [undefined]) {
        const meta = readLifecycle(item?.metadata ?? metadata)
        // An errored call can lose its metadata until the lifecycle merges it
        // back, so the child is also found through the call id.
        const child = meta.sessionID
          ? undefined
          : (byCall.get(JSON.stringify([message.id, part.callID, item?.index])) ??
            byCall.get(JSON.stringify([undefined, part.callID, item?.index])))
        const agent = buildAgent(source, {
          key: item ? `${part.id}:${item.index}` : part.id,
          part,
          messageID: message.id,
          child,
          item,
        })
        const owner = agent.sessionID ? owners.get(agent.sessionID) : undefined
        if (owner && extendsRun(source, owner, agent, part)) {
          owner.extendPartIDs = [...(owner.extendPartIDs ?? []), part.id]
          continue
        }
        if (agent.sessionID) {
          claimed.add(agent.sessionID)
          owners.set(agent.sessionID, agent)
        }
        agents.push(agent)
      }
    }
    // A message whose only task part extended an earlier run starts no phase.
    if (agents.length === 0) continue
    const key = message.parentID || message.id
    cardFor(key, message.parentID).phases.push({ key: message.id, messageID: message.id, agents })
  }

  // Children with no part in the loaded history: older pages, or a part that
  // was trimmed. Only sessions the task tool created count.
  const orphans = children.filter((session) => !claimed.has(session.id) && looksLikeSubagent(session))
  const orphanPhases = new Map<string, TaskAgent[]>()
  for (const session of orphans) {
    const agent = buildAgent(source, { key: `session:${session.id}`, child: session })
    const phaseKey = agent.messageID ?? `session:${session.id}`
    orphanPhases.set(phaseKey, [...(orphanPhases.get(phaseKey) ?? []), agent])
  }
  const earliest = (agents: readonly TaskAgent[]) => minDefined(agents.map((agent) => agent.startedAt)) ?? 0
  const orderedOrphans = [...orphanPhases].sort((a, b) => earliest(a[1]) - earliest(b[1]))
  for (const [phaseKey, agents] of orderedOrphans) {
    const userMessageID = messageParent.get(phaseKey)
    const card = cardFor(userMessageID ?? `orphan:${phaseKey}`, userMessageID)
    const sorted = agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const existing = card.phases.find((phase) => phase.key === phaseKey)
    if (existing) existing.agents.push(...sorted)
    else card.phases.push({ key: phaseKey, messageID: agents[0]?.messageID, agents: sorted })
  }

  const built = [...cards.values()].filter((card) => card.phases.some((phase) => phase.agents.length > 0))
  return built.map((seed) => buildCard(source, seed)).sort(compareCards)
}

function compareCards(a: TaskCard, b: TaskCard) {
  if (a.live !== b.live) return a.live ? -1 : 1
  if (a.live) return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)
}

export type TaskLocation = { card: TaskCard; phase: TaskPhase; agent: TaskAgent; first: boolean }

/** The copy of a session the engine updated last, from the store, the children route or a reload; a tie keeps the first. */
export function freshestSession(...copies: (Session | undefined)[]) {
  return copies.reduce<Session | undefined>((best, copy) => {
    if (!copy || !best) return best ?? copy
    return (copy.time?.updated ?? 0) > (best.time?.updated ?? 0) ? copy : best
  }, undefined)
}

/**
 * Sessions of agents shown live whose child the engine reports neither busy nor retrying. Events lost while the
 * stream was down leave cards like these behind, and only a fresh copy of the child and its messages settles them.
 */
export function idleLiveSessions(
  agents: readonly Pick<TaskAgent, "sessionID" | "status">[],
  status: (sessionID: string) => SessionStatus["type"] | undefined,
) {
  return [
    ...new Set(
      agents.flatMap((agent) => {
        if (!agent.sessionID || !isLive(agent.status)) return []
        const type = status(agent.sessionID)
        return type === "busy" || type === "retry" ? [] : [agent.sessionID]
      }),
    ),
  ]
}

/** Where a task part sits; `first` marks the part that carries its phase's inline chip. */
export function taskPartLocations(cards: readonly TaskCard[]) {
  const map = new Map<string, TaskLocation>()
  for (const card of cards) {
    for (const phase of card.phases) {
      const first = phase.agents.findIndex((agent) => agent.partID !== undefined)
      phase.agents.forEach((agent, position) => {
        // Several indexed children share one real part. Keep its first child
        // so a later sibling cannot hide the phase's inline task chip.
        if (agent.partID && !map.has(agent.partID))
          map.set(agent.partID, { card, phase, agent, first: position === first })
        for (const partID of agent.extendPartIDs ?? []) {
          if (!map.has(partID)) map.set(partID, { card, phase, agent, first: false })
        }
      })
    }
  }
  return map
}

export function locateTaskPart(cards: readonly TaskCard[], partID: string): TaskLocation | undefined {
  return taskPartLocations(cards).get(partID)
}

type CountedCard = { agents: readonly Pick<TaskAgent, "key" | "sessionID" | "status" | "task">[] }

/**
 * A card's agents as one count each. A workflow run's loaded agents are left out while its run row is listed: the run
 * stands for them, as it does for Stop and spend, so opening a run's stages never changes the counts.
 */
function counted(card: CountedCard) {
  const runs = runIDs(card.agents)
  return runs.size ? card.agents.filter((agent) => !coveredByRun(agent, runs)) : card.agents
}

/** Distinct agents still running, waiting or queued: what keeps the clock ticking. */
export function liveAgentCount(cards: readonly CountedCard[]) {
  return countAgents(cards.flatMap((card) => counted(card).filter((agent) => isLive(agent.status))))
}

/** Distinct agents running or waiting on you, for the header badge; queued ones have not started. */
export function runningAgentCount(cards: readonly CountedCard[]) {
  return countAgents(
    cards.flatMap((card) => counted(card).filter((agent) => agent.status === "running" || agent.status === "waiting")),
  )
}

/** Distinct agents blocked on a permission or question, including resumed runs. */
export function waitingAgentCount(cards: readonly CountedCard[]) {
  return countAgents(cards.flatMap((card) => counted(card).filter((agent) => agent.status === "waiting")))
}

/**
 * Sessions of the background agents still live, for Stop all. Stopping the main turn leaves these running, so the
 * pane is where they are stopped together. Foreground agents stop with the turn that waits on them.
 */
export function liveBackgroundSessions(
  cards: readonly { agents: readonly Pick<TaskAgent, "sessionID" | "status" | "background">[] }[],
) {
  return [
    ...new Set(
      cards.flatMap((card) =>
        card.agents.flatMap((agent) =>
          agent.background && agent.sessionID && isLive(agent.status) ? [agent.sessionID] : [],
        ),
      ),
    ),
  ]
}

/**
 * Hidden-finished bookkeeping: the trash records when each finished card was
 * cleared. A card that finishes again later (a resumed task) shows again.
 */
export function isDismissed(card: Pick<TaskCard, "live" | "endedAt">, dismissedAt: number | undefined) {
  if (card.live || dismissedAt === undefined) return false
  return card.endedAt === undefined || card.endedAt <= dismissedAt
}
import { Billing } from "@vectordevai/schema/billing"
