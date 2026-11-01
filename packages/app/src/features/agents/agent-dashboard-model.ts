// Derives the Agent Dashboard's view of every agent from the parallel
// workspace records the desktop main process already keeps. Pure so the
// grouping, health, and conflict rules can be tested without a renderer.

import { formatUsd } from "@/features/economics/format-spend"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { RunBudget } from "@vectordevai/schema/run-budget"

export type DashboardAgentStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running commands"
  | "testing"
  | "complete"
  | "failed"
  | "needs review"
  | "stopped"
  | "merged"
  | "discarded"

export type DashboardAgentInput = {
  id: string
  name: string
  taskPrompt: string
  runtime: string
  provider: string
  model: string
  status: DashboardAgentStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  changedFiles: string[]
  estimatedCost: string
  actualCost?: string
  billing?: "codium"
  costKind?: RunBudget.CostKind
  agent?: string
  swarmRunId?: string
  swarmRole?: "coordinator" | "worker"
  teamId?: string
  pullRequestUrl?: string
  previewUrl?: string
  mergeState: "none" | "merged" | "discarded"
  error?: string
}

const RUNNING: DashboardAgentStatus[] = ["queued", "planning", "editing", "running commands", "testing"]
const FINISHED: DashboardAgentStatus[] = ["complete", "merged", "discarded", "stopped"]

export function isRunning(status: DashboardAgentStatus) {
  return RUNNING.includes(status)
}

export function isFinished(status: DashboardAgentStatus) {
  return FINISHED.includes(status)
}

export function needsAttention(agent: DashboardAgentInput) {
  return agent.status === "failed" || agent.status === "needs review" || Boolean(agent.error)
}

// Two agents "clash" when both still hold uncommitted work on the same file.
// Merged and discarded agents are excluded: their changes are already resolved,
// so reporting them would produce a permanent false alarm the user cannot clear.
export type AgentClash = {
  file: string
  agentIds: string[]
  agentNames: string[]
}

export function findClashes(agents: readonly DashboardAgentInput[]): AgentClash[] {
  const live = agents.filter((agent) => agent.mergeState === "none" && !isFinished(agent.status))
  const byFile = new Map<string, DashboardAgentInput[]>()
  for (const agent of live) {
    for (const file of new Set(agent.changedFiles)) {
      byFile.set(file, [...(byFile.get(file) ?? []), agent])
    }
  }
  return [...byFile.entries()]
    .filter(([, holders]) => holders.length > 1)
    .map(([file, holders]) => ({
      file,
      agentIds: holders.map((agent) => agent.id),
      agentNames: holders.map((agent) => agent.name),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

// A relayed message between two agents on the same team, as the dashboard
// renders it. Mirrors TeamMessage in the desktop main process; the app cannot
// import from packages/desktop, so the shape is restated here.
export type TeamConversationMessage = {
  id: string
  fromWorkspaceId: string
  fromName: string
  toWorkspaceId?: string
  text: string
  createdAt: string
}

export type TeamConversation = {
  teamId: string
  teamName: string
  messages: TeamConversationMessage[]
}

// Oldest first, so the exchange reads top-down like a transcript.
export function orderConversation(messages: readonly TeamConversationMessage[]) {
  return [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

// A handoff broadcast carries no recipient; a reply names one. Worth
// distinguishing so the transcript reads as a conversation rather than a log.
export function isDirected(message: TeamConversationMessage) {
  return Boolean(message.toWorkspaceId)
}

export type DashboardSummary = {
  total: number
  running: number
  attention: number
  finished: number
  changedFiles: number
  clashes: number
  teams: number
}

export function summarize(agents: readonly DashboardAgentInput[]): DashboardSummary {
  return {
    total: agents.length,
    running: agents.filter((agent) => isRunning(agent.status)).length,
    attention: agents.filter(needsAttention).length,
    finished: agents.filter((agent) => isFinished(agent.status)).length,
    changedFiles: new Set(agents.flatMap((agent) => agent.changedFiles)).size,
    clashes: findClashes(agents).length,
    teams: new Set(agents.map((agent) => agent.teamId).filter(Boolean)).size,
  }
}

// Agents in the same swarm run belong together; everything else is its own
// row. Coordinators sort ahead of their workers so a group reads top-down.
export type AgentGroup = {
  id: string
  label: string
  swarm: boolean
  agents: DashboardAgentInput[]
}

export function groupAgents(agents: readonly DashboardAgentInput[]): AgentGroup[] {
  // Collaborative teams set teamId, not swarmRunId, so grouping only on the
  // swarm key left every team member rendered as a solo row with no heading.
  // A swarm id still wins when both are present: a swarm worker's membership in
  // its run outranks any team it also joined.
  const solo = agents.filter((agent) => !agent.swarmRunId && !agent.teamId)
  const swarms = new Map<string, DashboardAgentInput[]>()
  for (const agent of agents.filter((item) => item.swarmRunId)) {
    swarms.set(agent.swarmRunId!, [...(swarms.get(agent.swarmRunId!) ?? []), agent])
  }
  const teams = new Map<string, DashboardAgentInput[]>()
  for (const agent of agents.filter((item) => !item.swarmRunId && item.teamId)) {
    teams.set(agent.teamId!, [...(teams.get(agent.teamId!) ?? []), agent])
  }

  const swarmGroups = [...swarms.entries()].map(([id, members]) => ({
    id,
    label: members.find((member) => member.swarmRole === "coordinator")?.name ?? "Agent team",
    swarm: true,
    agents: [...members].sort((a, b) => {
      if (a.swarmRole === b.swarmRole) return a.name.localeCompare(b.name)
      return a.swarmRole === "coordinator" ? -1 : 1
    }),
  }))

  // The dashboard input carries no team name, so the heading names the members
  // instead — that is what the user recognises the team by.
  const teamGroups = [...teams.entries()].map(([id, members]) => {
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name))
    const names = sorted.slice(0, 2).map((member) => member.name)
    return {
      id,
      label: sorted.length > 2 ? `${names.join(" & ")} +${sorted.length - 2}` : names.join(" & "),
      swarm: true,
      agents: sorted,
    }
  })

  return [
    ...swarmGroups,
    ...teamGroups,
    ...solo.map((agent) => ({ id: agent.id, label: agent.name, swarm: false, agents: [agent] })),
  ]
}

// Live agents first, then those needing attention, then the rest — the
// dashboard should lead with what is still moving or still blocked.
export function sortForDisplay(agents: readonly DashboardAgentInput[]): DashboardAgentInput[] {
  const rank = (agent: DashboardAgentInput) => {
    if (isRunning(agent.status)) return 0
    if (needsAttention(agent)) return 1
    return 2
  }
  return [...agents].sort((a, b) => {
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
  })
}

export function elapsedLabel(agent: DashboardAgentInput, now: number) {
  const started = Date.parse(agent.createdAt)
  if (!Number.isFinite(started)) return ""
  const end = isFinished(agent.status) ? Date.parse(agent.lastActivityAt) : now
  const seconds = Math.max(0, Math.round(((Number.isFinite(end) ? end : now) - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export type AgentCardDetails = {
  activity: string
  changes: string
  cost?: string
  runtime: string
}

// Board and list views carry the same compact operational context. Keeping the
// wording here prevents the two presentations from drifting into different
// interpretations of the same run.
export function agentCardDetails(agent: DashboardAgentInput): AgentCardDetails {
  const changedFiles = Math.max(agent.changedFilesCount, new Set(agent.changedFiles).size)
  return {
    activity: agent.error || agent.lastAction || agent.status,
    changes: changedFiles === 1 ? "1 file changed" : `${changedFiles} files changed`,
    cost: agentCostLabel({ ...agent, running: isRunning(agent.status) }),
    runtime: [agent.runtime, agent.model].filter(Boolean).join(" · "),
  }
}

// A Vector-runtime agent's cost is measured by the engine, so it shows that
// figure or says plainly that there is none yet. The prompt-length band is an
// estimate for external runtimes only, which report their own cost later.
export function agentCostLabel(agent: {
  runtime: string
  actualCost?: string
  estimatedCost: string
  running: boolean
  billing?: "codium"
  costKind?: RunBudget.CostKind
}) {
  if (agent.billing === "codium") {
    const amount = Number(agent.actualCost?.replace(/[$,\s]/g, ""))
    const known = agent.actualCost && amount !== 0 ? measuredCost(agent.actualCost) : undefined
    const own =
      agent.costKind === "unknown"
        ? known
          ? `${known} + unpriced`
          : "Cost unknown"
        : (known ??
          (agent.costKind === "free" ? "free model" : agent.costKind === "plan" ? "covered by plan" : undefined))
    return CodiumUsage.withCodium(own, 1)
  }
  if (agent.actualCost) return measuredCost(agent.actualCost)
  if (agent.runtime !== "vector") return agent.estimatedCost || undefined
  return agent.running ? "measuring…" : "unmeasured"
}

// The desktop records measured cost to four decimals ("$0.4213"). Cards print
// money the way the rest of the app does; anything that is not a plain amount
// is shown as the desktop wrote it.
function measuredCost(text: string) {
  const usd = Number(text.replace(/[$,\s]/g, ""))
  if (!text.trim() || !Number.isFinite(usd)) return text
  return formatUsd(usd)
}

// The board mirrors what a reviewer actually does with a run: watch it, act on
// it, or leave it alone. "Needs you" deliberately merges failed with needs
// review — both are stopped and waiting on a person, and splitting them puts
// the same decision in two places.
export type BoardColumnId = "running" | "attention" | "done"

export type BoardColumn = {
  id: BoardColumnId
  label: string
  agents: DashboardAgentInput[]
}

export function boardColumnFor(agent: DashboardAgentInput): BoardColumnId {
  if (isRunning(agent.status)) return "running"
  if (needsAttention(agent)) return "attention"
  return "done"
}

export function boardColumns(agents: readonly DashboardAgentInput[]): BoardColumn[] {
  const sorted = sortForDisplay(agents)
  const labels: Record<BoardColumnId, string> = {
    running: "Running",
    attention: "Needs you",
    done: "Done",
  }
  return (["running", "attention", "done"] as BoardColumnId[]).map((id) => ({
    id,
    label: labels[id],
    agents: sorted.filter((agent) => boardColumnFor(agent) === id),
  }))
}

export type AgentFilters = {
  query?: string
  statuses?: DashboardAgentStatus[]
  runtimes?: string[]
  // A team id, a swarm id, or "solo" for the agents that belong to neither.
  groups?: string[]
  // Mirrors what a reviewer asks about a run: is there a PR waiting, did it
  // already land, or did this one never open one.
  pullRequest?: "open" | "merged" | "none"
}

export function pullRequestStateFor(agent: DashboardAgentInput): "open" | "merged" | "none" {
  if (agent.mergeState === "merged") return "merged"
  return agent.pullRequestUrl ? "open" : "none"
}

function matchesQuery(agent: DashboardAgentInput, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [agent.name, agent.taskPrompt, agent.lastAction, agent.runtime, agent.model].some((field) =>
    field?.toLowerCase().includes(needle),
  )
}

function groupKeyFor(agent: DashboardAgentInput) {
  return agent.swarmRunId ?? agent.teamId ?? "solo"
}

// Every filter is an OR within itself and an AND against the others, which is
// what a chip row reads as: two statuses means either, a status and a runtime
// means both.
export function filterAgents(agents: readonly DashboardAgentInput[], filters: AgentFilters): DashboardAgentInput[] {
  return agents.filter((agent) => {
    if (!matchesQuery(agent, filters.query ?? "")) return false
    if (filters.statuses?.length && !filters.statuses.includes(agent.status)) return false
    if (filters.runtimes?.length && !filters.runtimes.includes(agent.runtime)) return false
    if (filters.groups?.length && !filters.groups.includes(groupKeyFor(agent))) return false
    if (filters.pullRequest && pullRequestStateFor(agent) !== filters.pullRequest) return false
    return true
  })
}

export function hasActiveFilters(filters: AgentFilters) {
  return Boolean(
    filters.query?.trim() ||
      filters.statuses?.length ||
      filters.runtimes?.length ||
      filters.groups?.length ||
      filters.pullRequest,
  )
}
