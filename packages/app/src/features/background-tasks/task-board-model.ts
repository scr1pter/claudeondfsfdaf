import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import { formatUsd } from "@/features/economics/format-spend"
import {
  aggregateStatus,
  agentLabel,
  isLive,
  subagentKind,
  type TaskAgent,
  type TaskCard,
  type TaskStatus,
} from "./subagent-model"

const statuses: Record<Task.Status, TaskStatus> = {
  queued: "pending",
  running: "running",
  waiting_on_user: "waiting",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
}

/** A board observation updates the latest run of a child; historical cards remain historical. */
export function mergeTaskBoard(cards: readonly TaskCard[], observed: readonly Task.Info[]): TaskCard[] {
  const tasks = [...new Map(observed.map((task) => [task.sessionID ?? task.id, task])).values()]
  if (!tasks.length) return [...cards]
  const latest = new Map<string, TaskAgent>()
  cards
    .flatMap((card) => card.agents)
    .forEach((agent) => {
      if (!agent.sessionID) return
      const previous = latest.get(agent.sessionID)
      if (!previous || (agent.startedAt ?? 0) >= (previous.startedAt ?? 0)) latest.set(agent.sessionID, agent)
    })
  const observations = new Map(tasks.flatMap((task) => (task.sessionID ? [[task.sessionID, task] as const] : [])))
  const claimed = new Set<string>()
  const groups = new Map<string, { title: string; description: string; label: string; agents: TaskAgent[] }>()
  cards.forEach((card) =>
    card.agents.forEach((agent) => {
      const task =
        agent.sessionID && latest.get(agent.sessionID) === agent ? observations.get(agent.sessionID) : undefined
      if (task) claimed.add(task.id)
      const next = task ? boardAgent(task, agent) : agent
      const key = task?.groupID ? `${task.source}:${task.groupID}` : task?.batchID ? `batch:${task.batchID}` : card.key
      const group = groups.get(key) ?? {
        title: card.title,
        description: card.description,
        label: groupLabel(task) ?? card.kindLabel,
        agents: [],
      }
      group.agents.push(next)
      groups.set(key, group)
    }),
  )
  tasks
    .filter((task) => !claimed.has(task.id))
    .forEach((task) => {
      const key = task.groupID
        ? `${task.source}:${task.groupID}`
        : task.batchID
          ? `batch:${task.batchID}`
          : `task:${task.id}`
      const group = groups.get(key) ?? {
        title: task.title,
        description: "",
        label: groupLabel(task) ?? "Subagent",
        agents: [],
      }
      group.agents.push(boardAgent(task))
      groups.set(key, group)
    })
  return [...groups]
    .map(([key, group]): TaskCard => {
      const status = aggregateStatus(group.agents.map((agent) => agent.status))
      const started = group.agents.flatMap((agent) => (agent.startedAt === undefined ? [] : [agent.startedAt]))
      const ended = group.agents.flatMap((agent) => (agent.endedAt === undefined ? [] : [agent.endedAt]))
      const phases = new Map<string, TaskAgent[]>()
      group.agents.forEach((agent) => {
        const phase = agent.messageID ?? key
        phases.set(phase, [...(phases.get(phase) ?? []), agent])
      })
      return {
        key,
        title: group.title,
        description: group.description,
        kindLabel: group.label,
        status,
        live: isLive(status),
        startedAt: started.length ? Math.min(...started) : undefined,
        endedAt: !isLive(status) && ended.length ? Math.max(...ended) : undefined,
        tokens: taskSpend(group.agents).tokens,
        agents: group.agents,
        phases: [...phases].map(([phase, agents], index) => ({
          key: phase,
          messageID: agents[0]?.messageID,
          index: index + 1,
          name: `Phase ${index + 1}`,
          status: aggregateStatus(agents.map((agent) => agent.status)),
          done: agents.filter((agent) => agent.status === "done").length,
          total: agents.length,
          agents,
          startedAt: agents[0]?.startedAt,
          endedAt: agents.every((agent) => !isLive(agent.status))
            ? Math.max(...agents.map((agent) => agent.endedAt ?? 0))
            : undefined,
        })),
      }
    })
    .sort(
      (a, b) => Number(b.live) - Number(a.live) || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0),
    )
}

function boardAgent(task: Task.Info, previous?: TaskAgent): TaskAgent {
  const agent = task.agent ?? "general"
  const codiumSteps = task.usage?.codiumSteps ?? previous?.codiumSteps
  const legacy = task.usage?.codiumSteps === undefined && Boolean(codiumSteps)
  return {
    key: previous?.key ?? `task:${task.id}`,
    agent,
    kind: subagentKind(agent),
    custom: false,
    label: agentLabel(agent),
    ...previous,
    task,
    title: task.title,
    sessionID: task.sessionID,
    status: statuses[task.status],
    background: true,
    startedAt: task.startedAt,
    endedAt: task.completedAt,
    tokens: legacy ? (previous?.tokens ?? 0) : (task.usage?.total ?? previous?.tokens),
    cost: task.usage?.cost ?? task.measuredCost ?? previous?.cost,
    unpricedSteps: task.usage?.unpricedSteps ?? previous?.unpricedSteps,
    codiumSteps,
    toolUses: task.usage?.toolUses ?? previous?.toolUses,
    currentStep:
      task.connection === "disconnected"
        ? `Disconnected · last known: ${task.currentStep ?? task.status}`
        : (task.currentStep ?? task.lastTool),
    ownedPaths: task.ownedPaths,
    dependsOn: task.dependsOn,
    error: task.status === "failed" ? task.reason : undefined,
  }
}

function groupLabel(task: Task.Info | undefined) {
  if (task?.source === "team") return "Team"
  if (task?.source === "swarm") return "Swarm"
  if (task?.source === "external") return "External agent"
  if (task?.batchID) return "Subagent batch"
}

/** Usage belongs to a session, so resumed cards and workspace mirrors count once. */
export function taskSpend(agents: readonly TaskAgent[]) {
  const latest = new Map<string, TaskAgent>()
  agents.forEach((agent) => {
    const key = agent.sessionID ?? agent.task?.id ?? agent.key
    const previous = latest.get(key)
    if (!previous || (agent.startedAt ?? 0) >= (previous.startedAt ?? 0)) latest.set(key, agent)
  })
  const values = [...latest.values()]
  const measured = values.filter(
    (agent) =>
      (agent.codiumSteps && !agent.tokens) ||
      (agent.cost !== undefined && Number.isFinite(agent.cost) && agent.cost >= 0),
  )
  return {
    cost: measured.length ? measured.reduce((sum, agent) => sum + (agent.cost ?? 0), 0) : undefined,
    unknown:
      measured.length !== values.length ||
      values.some((agent) => CodiumUsage.ownUnpricedSteps(agent.unpricedSteps, agent.codiumSteps) > 0),
    codiumSteps: values.reduce((sum, agent) => sum + (agent.codiumSteps ?? 0), 0),
    tokens: values.some((agent) => agent.tokens !== undefined)
      ? values.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0)
      : undefined,
  }
}

export function taskCost(agents: readonly TaskAgent[]) {
  const spend = taskSpend(agents)
  const own =
    spend.cost === undefined || (spend.cost === 0 && spend.unknown)
      ? "Cost unknown"
      : spend.cost === 0 && spend.codiumSteps
        ? undefined
        : `${formatUsd(spend.cost)}${spend.unknown ? " + unpriced usage" : ""}`
  return CodiumUsage.withCodium(own, spend.codiumSteps)
}

export function appendTaskQuestion(prompt: Prompt, agent: Pick<TaskAgent, "title" | "task" | "sessionID">): Prompt {
  const text = `What is the progress of ${JSON.stringify(agent.title)} (task ${agent.task?.id ?? agent.sessionID})? Inspect its latest activity and summarize any blockers.`
  const end = prompt.reduce((end, part) => (part.type === "image" ? end : Math.max(end, part.end)), 0)
  const content = `${end ? "\n\n" : ""}${text}`
  return [...prompt, { type: "text", content, start: end, end: end + content.length }]
}

/** A swarm coordinator owns cancellation of its children; issue one control per scope. */
export function stoppableAgents(agents: readonly TaskAgent[]) {
  const unique = [
    ...new Map(
      agents
        .filter((agent) => isLive(agent.status) && agent.task?.controls.stop !== false)
        .map((agent) => [agent.task?.id ?? agent.sessionID ?? agent.key, agent]),
    ).values(),
  ]
  const swarms = new Set(
    unique.flatMap((agent) =>
      agent.task?.groupID && agent.task.id === `swarm:${agent.task.groupID}` ? [agent.task.groupID] : [],
    ),
  )
  return unique.filter(
    (agent) =>
      !agent.task?.groupID || !swarms.has(agent.task.groupID) || agent.task.id === `swarm:${agent.task.groupID}`,
  )
}

/** Desktop measurements describe the latest workspace run, not the native ledger's lifetime total. */
export function desktopSpendAgents(agents: readonly TaskAgent[]) {
  return agents.filter(
    (agent) =>
      agent.task && !agent.task.usage && (agent.task.id.startsWith("workspace:") || agent.task.id.startsWith("swarm:")),
  )
}
