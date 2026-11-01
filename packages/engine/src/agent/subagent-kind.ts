import type { Agent } from "./agent"

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

export type SubagentUsage = {
  /** Local accounting proof for these own-only session totals; serialized metadata never grants it to readers. */
  tokensOwnOnly?: boolean
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
  notification?: { text: string; state: "completed" | "error" | "cancelled"; launchID: string; messageID?: string }
  budgetScopes?: readonly import("@vectordevai/schema/task").Task.BudgetScope[]
  budget?: import("@vectordevai/schema/run-budget").RunBudget.Info
  mailbox?: Array<{ id: string; sender: string; text: string; delivery: "steer" | "queue"; createdAt: number; deliveredAt?: number }>
  model: { providerID: string; modelID: string; variant?: string }
  background: boolean
  status: SubagentStatus
  startedAt: number
  completedAt?: number
  usage?: SubagentUsage
  error?: string
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
