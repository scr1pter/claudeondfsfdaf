import type { Agent } from "./agent"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import type { Task } from "@vectordevai/schema/task"

/**
 * Vector has two kinds of subagent. The engine id `general` is the regular,
 * general-purpose Subagent, and it is what a task call gets when it names no
 * type. Every other subagent-mode agent, built in or user-defined, is a
 * Subagent specialist. UI and docs read `kind` instead of hard-coding names.
 */
export const GENERAL_SUBAGENT = "general"

/** Other names models use for the general-purpose Subagent; Claude-trained models emit "general-purpose". */
export const GENERAL_ALIASES = ["general-purpose", "general_purpose", "subagent"] as const

export type SubagentKind = "subagent" | "specialist"

export const SUBAGENT_LABEL: Record<SubagentKind, string> = {
  subagent: "Subagent",
  specialist: "Subagent specialist",
}

export type SubagentStatus = "queued" | "running" | "completed" | "error" | "cancelled"

export type SubagentEffort = "default" | "low" | "medium" | "high"
export const SUBAGENT_EFFORTS: readonly SubagentEffort[] = ["default", "low", "medium", "high"]
export type SubagentModelSource = "fork" | "call" | "agent" | "small" | "learned" | "parent"
export const SUBAGENT_MODEL_SOURCES: readonly SubagentModelSource[] = [
  "fork",
  "call",
  "agent",
  "small",
  "learned",
  "parent",
]
export type SubagentInterruptionCause = "shutdown" | "crash" | "disposed" | "unknown"
export const SUBAGENT_INTERRUPTION_CAUSES: readonly SubagentInterruptionCause[] = [
  "shutdown",
  "crash",
  "disposed",
  "unknown",
]

/** The request's delegated ledger as this child last saw it. Never stored in `budgetScopes`, whose kinds are fixed. */
export type SubagentDelegatedScope = {
  id: string
  budget: RunBudget.Info
  spentUsd: number
  steps: number
  unpricedSteps: number
  codiumSteps?: number
  stopped?: { reason: string; message: string }
}

/** Where a workflow run or one of its agents stands. `progress` is the run's progress record (core orchestration). */
export type SubagentWorkflow =
  | { role: "run"; title: string; revision: number; quiet?: boolean; progress: Record<string, unknown> }
  | {
      role: "agent"
      runID: string
      stage: string
      phase: string
      item: string
      key: string
      round?: number
      verifier?: boolean
      final?: boolean
      verified?: boolean
      output?: "structured" | "text"
    }

export type SubagentUsage = {
  /** Cost billed across all of the subagent's steps. */
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  /** Every token billed across all of the subagent's steps: input, output, reasoning, cache read and cache write. */
  total: number
  /** Tool calls the subagent made. */
  toolUses: number
  /** Model steps the subagent took. */
  steps: number
  unpricedSteps?: number
  /** How many of unpricedSteps ran on Vector Codium. Their tokens are not in tokens or total. */
  codiumSteps?: number
}

/**
 * Lifecycle record stored at `metadata.subagent` on every child session the
 * task tool creates. `Session.setMetadata` publishes `session.updated` on each
 * change, so the record is durable and reaches clients live.
 */
export type SubagentRecord = {
  kind: SubagentKind
  agent: string
  /** True for user-defined agents (markdown or config). They count as specialists. */
  custom: boolean
  title: string
  parentSessionID: string
  parentMessageID: string
  /** The task tool call that launched the current run. Absent only when the caller had no call id. */
  callID?: string
  /** Index within a task batch; callID remains the real provider tool call. */
  batchIndex?: number
  batchID?: string
  attempt?: number
  runtimeID?: string
  ownedPaths?: string[]
  dependsOn?: string[]
  successCriteria?: string[]
  resultRef?: string
  resultSummary?: string
  reason?: string
  /** An undelivered result note. `messageID` claims it for one parent message; `claimedAt` dates that claim. */
  notification?: {
    text: string
    state: "completed" | "error" | "cancelled"
    launchID: string
    messageID?: string
    claimedAt?: number
  }
  budgetScopes?: readonly import("@vectordevai/schema/task").Task.BudgetScope[]
  budget?: import("@vectordevai/schema/run-budget").RunBudget.Info
  /** Messages sent to this child; `from: "user"` when the user wrote one through the session's page. */
  mailbox?: Array<{
    id: string
    sender: string
    text: string
    delivery: "steer" | "queue"
    createdAt: number
    deliveredAt?: number
    from?: "user"
  }>
  model: { providerID: string; modelID: string; variant?: string }
  background: boolean
  status: SubagentStatus
  startedAt: number
  completedAt?: number
  usage?: SubagentUsage
  error?: string
  // The fields below are optional and validated one by one in SubagentLifecycle.read, which drops a malformed one.
  /** The conversation whose subagent slots and delegated ledger this child uses. */
  conversationID?: string
  rootSessionID?: string
  /** The request whose delegated ledger this child spends on. */
  requestID?: string
  effort?: SubagentEffort
  modelSource?: SubagentModelSource
  /** A child started from its parent's whole conversation. */
  fork?: { point: string; callID?: string; from?: string; warm?: boolean }
  /** A child whose final answer must match `schema` (at most 16 KiB). */
  structured?: { schema: Record<string, unknown>; schemaHash: string; attempts: number; valid?: boolean }
  delegatedScope?: SubagentDelegatedScope
  /** The engine process running this child. The machine id stays in the background_job row only. */
  owner?: { pid: number; boot: number }
  interruption?: {
    at: number
    cause: SubagentInterruptionCause
    reportedAt?: number
    resumedAt?: number
    dismissedAt?: number
  }
  waiting?: {
    kind: "permission" | "question"
    requestID: string
    since: number
    expiresAt?: number
    notedAt?: number
    summary?: string
  }
  stop?: { by: "user" | "agent" | "system"; at: number }
  /** When this child reported to its parent with task_manage report (the last 12), and how many of those woke it. */
  reports?: { at: number[]; wakes: number }
  /** Why the child is queued, such as "Waiting for a free subagent slot". */
  slotReason?: string
  /**
   * Display copy only: destructive isolation steps read the registry file under Vector's data folder. Never the
   * absolute directory: guests and `vector export` read session metadata (I19).
   */
  isolation?: Omit<Task.Isolation, "directory">
  workflow?: SubagentWorkflow
}

/**
 * Resolves the task tool's subagent_type. No type gives the general Subagent.
 * An alias of it gives `general` too, but only when no agent has that literal
 * name, so a user agent called "general-purpose" is never shadowed.
 */
export function resolveSubagentType(input: string | undefined, has: (name: string) => boolean) {
  const name = input?.trim() ?? ""
  if (!name) return GENERAL_SUBAGENT
  if (has(name)) return name
  const lower = name.toLowerCase()
  if (lower === GENERAL_SUBAGENT || (GENERAL_ALIASES as readonly string[]).includes(lower)) return GENERAL_SUBAGENT
  return name
}

export function subagentKind(agent: Pick<Agent.Info, "name" | "native">): { kind: SubagentKind; custom: boolean } {
  return {
    kind: agent.name === GENERAL_SUBAGENT ? "subagent" : "specialist",
    custom: agent.native !== true,
  }
}

export const SUBAGENT_TITLE_MAX = 60
const FALLBACK_TITLE_WORDS = 6

/**
 * The task description is the title on the subagent's card: trimmed, with
 * whitespace collapsed, capped near SUBAGENT_TITLE_MAX characters, and taken
 * from the first words of the prompt when the description is empty.
 */
export function subagentTitle(description: string | undefined, prompt: string) {
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim()
  const title =
    collapse(description ?? "") ||
    collapse(prompt).split(" ").slice(0, FALLBACK_TITLE_WORDS).join(" ") ||
    "Subagent task"
  if (title.length <= SUBAGENT_TITLE_MAX) return title
  const cut = title.slice(0, SUBAGENT_TITLE_MAX - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space >= SUBAGENT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}
