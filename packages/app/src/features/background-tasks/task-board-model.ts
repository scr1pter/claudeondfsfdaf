import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import { formatUsd } from "@/features/economics/format-spend"
import {
  aggregateStatus,
  agentLabel,
  coveredByRun,
  isLive,
  modelShortName,
  readIsolation,
  readWorkflow,
  runIDs,
  subagentKind,
  type TaskAgent,
  type TaskCard,
  type TaskModel,
  type TaskStatus,
} from "./subagent-model"
import { english } from "./task-limits"

const statuses: Record<Task.Status, TaskStatus> = {
  queued: "pending",
  running: "running",
  waiting_on_user: "waiting",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
}

export type MergeOptions = {
  /** The catalogue's name for a model the board names, as the cards built from parts use. */
  modelName?(providerID: string, modelID: string): string | undefined
}

/** The run a workflow row belongs to: its own ID for the run row, `workflow.runID` (or `groupID`) for an agent. */
export function workflowRunID(task: Task.Info | undefined) {
  if (!task) return undefined
  if (task.workflow?.role === "run") return task.workflow.runID || task.id
  if (task.workflow?.role === "agent" && task.workflow.runID) return task.workflow.runID
  return task.groupID?.startsWith("workflow:") ? task.groupID.slice("workflow:".length) || undefined : undefined
}

/**
 * One grouping key per card. A workflow run and its agents share `subagent:workflow:<runID>`, the key an agent's own
 * `groupID` ("workflow:<runID>", source subagent) already gives, so the run row and its loaded agents are one card.
 */
function groupKey(task: Task.Info | undefined, fallback: string) {
  const run = workflowRunID(task)
  if (task && run) return `${task.source}:workflow:${run}`
  if (task?.groupID) return `${task.source}:${task.groupID}`
  if (task?.batchID) return `batch:${task.batchID}`
  return fallback
}

/** A board observation updates the latest run of a child; historical cards remain historical. */
export function mergeTaskBoard(
  cards: readonly TaskCard[],
  observed: readonly Task.Info[],
  options: MergeOptions = {},
): TaskCard[] {
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
  const groups = new Map<
    string,
    { title: string; description: string; label: string; agents: TaskAgent[]; runID?: string }
  >()
  const add = (
    key: string,
    task: Task.Info | undefined,
    agent: TaskAgent,
    seed: () => { title: string; description: string; label: string },
  ) => {
    const group = groups.get(key) ?? { ...seed(), agents: [] }
    const run = workflowRunID(task)
    if (run) {
      group.runID = run
      group.label = groupLabel(task) ?? group.label
      // The run row names the card, whichever row arrived first.
      if (task?.workflow?.role === "run") group.title = task.workflow.title || task.title
    }
    group.agents.push(agent)
    groups.set(key, group)
  }
  cards.forEach((card) =>
    card.agents.forEach((agent) => {
      const task =
        agent.sessionID && latest.get(agent.sessionID) === agent ? observations.get(agent.sessionID) : undefined
      if (task) claimed.add(task.id)
      const next = task ? boardAgent(task, agent, options) : agent
      add(groupKey(task, card.key), task, next, () => ({
        title: card.title,
        description: card.description,
        label: groupLabel(task) ?? card.kindLabel,
      }))
    }),
  )
  tasks
    .filter((task) => !claimed.has(task.id))
    .forEach((task) =>
      add(groupKey(task, `task:${task.id}`), task, boardAgent(task, undefined, options), () => ({
        title: task.title,
        description: "",
        label: groupLabel(task) ?? "Subagent",
      })),
    )
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
        ...(group.runID ? { runID: group.runID } : {}),
      }
    })
    .sort(
      (a, b) => Number(b.live) - Number(a.live) || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0),
    )
}

function boardModel(
  value: Task.Model | undefined,
  previous: TaskModel | undefined,
  options: MergeOptions,
): TaskModel | undefined {
  if (!value?.providerID || !value.modelID) return previous
  const same = previous?.providerID === value.providerID && previous.modelID === value.modelID
  const name = options.modelName?.(value.providerID, value.modelID) ?? (same ? previous.name : value.modelID)
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    ...(value.variant ? { variant: value.variant } : {}),
    name,
    short: modelShortName(name),
  }
}

/** The 1.99.113 board fields over what the part said; an older engine sends none and the part's copy stays. */
function boardFields(task: Task.Info, previous: TaskAgent | undefined, options: MergeOptions): Partial<TaskAgent> {
  const workflow = task.workflow ? readWorkflow(task.workflow) : previous?.workflow
  const result = task.result
    ? {
        format: task.result.format,
        ...(task.result.valid !== undefined ? { valid: task.result.valid } : {}),
        ...(task.result.attempts !== undefined ? { attempts: task.result.attempts } : {}),
      }
    : previous?.result
  const fields: Partial<TaskAgent> = {
    model: boardModel(task.model, previous?.model, options),
    effort: task.effort ?? previous?.effort,
    fork: task.fork ?? previous?.fork,
    result,
    isolation: task.isolation ? readIsolation(task.isolation) : previous?.isolation,
    interrupted: task.interrupted ?? previous?.interrupted,
    workflow: workflow?.role === "run" && !workflow.runID ? { ...workflow, runID: task.id } : workflow,
  }
  return {
    ...Object.fromEntries(Object.entries(fields).filter((entry) => entry[1] !== undefined)),
    // These describe the current state only, so a row that moved on clears what the part said before.
    queuedReason: task.status === "queued" ? (task.queuedReason ?? previous?.queuedReason) : undefined,
    waiting: task.status === "waiting_on_user" ? (task.waiting ?? previous?.waiting) : undefined,
  }
}

function boardAgent(task: Task.Info, previous: TaskAgent | undefined, options: MergeOptions = {}): TaskAgent {
  const agent = task.agent ?? "general"
  const codiumSteps =
    task.usage?.codiumSteps ?? (task.billing === "codium" || task.costKind === "codium" ? 1 : previous?.codiumSteps)
  return {
    key: previous?.key ?? `task:${task.id}`,
    agent,
    kind: subagentKind(agent),
    custom: false,
    label: agentLabel(agent),
    ...previous,
    ...boardFields(task, previous, options),
    task,
    title: task.title,
    sessionID: task.sessionID,
    status: statuses[task.status],
    // A board row says whether its job runs in the background; an engine that predates the field lists only
    // background work here, as before.
    background: task.background ?? true,
    startedAt: task.startedAt,
    endedAt: task.completedAt,
    tokens:
      task.usage?.tokensOwnOnly === true
        ? task.usage.total
        : previous?.tokensOwnOnly === true
          ? previous.tokens
          : undefined,
    tokensOwnOnly: task.usage?.tokensOwnOnly === true || previous?.tokensOwnOnly === true,
    cost: task.usage?.cost ?? task.measuredCost ?? previous?.cost,
    unpricedSteps: codiumSteps
      ? Math.max(
          task.usage?.unpricedSteps ?? previous?.unpricedSteps ?? 0,
          codiumSteps + (task.costKind === "unknown" ? 1 : 0),
        )
      : (task.usage?.unpricedSteps ?? previous?.unpricedSteps),
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
  if (workflowRunID(task)) return english("backgroundTasks.workflow")
  if (task?.batchID) return "Subagent batch"
}

/**
 * Usage belongs to a session, so resumed cards and workspace mirrors count once. A workflow run's usage already
 * includes its agents', so with the run row listed its loaded agents add nothing.
 */
export function taskSpend(agents: readonly TaskAgent[]) {
  const runs = runIDs(agents)
  const latest = new Map<string, TaskAgent>()
  agents.forEach((agent) => {
    if (coveredByRun(agent, runs)) return
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

function promptEnd(prompt: Prompt) {
  return prompt.reduce((end, part) => (part.type === "image" ? end : Math.max(end, part.end)), 0)
}

export function appendTaskQuestion(prompt: Prompt, agent: Pick<TaskAgent, "title" | "task" | "sessionID">): Prompt {
  const text = `What is the progress of ${JSON.stringify(agent.title)} (task ${agent.task?.id ?? agent.sessionID})? Inspect its latest activity and summarize any blockers.`
  const end = promptEnd(prompt)
  const content = `${end ? "\n\n" : ""}${text}`
  return [...prompt, { type: "text", content, start: end, end: end + content.length }]
}

/**
 * "Ask Vector to continue it" (5.I.3): the child's title as JSON, its task ID, and an agent part naming its subagent
 * type, so even a short message is offered the task tool and continues that child by its task_id. A draft the user
 * typed goes after it.
 */
export function appendTaskContinuation(
  prompt: Prompt,
  agent: Pick<TaskAgent, "title" | "task" | "sessionID" | "agent">,
  draft = "",
): Prompt {
  const start = promptEnd(prompt)
  const lead = `${start ? "\n\n" : ""}Continue ${JSON.stringify(agent.title)} (task ${agent.task?.id ?? agent.sessionID}) with its task_id, using `
  const mention = `@${agent.agent}`
  const note = draft.trim() ? `: ${draft.trim()}` : ": "
  const at = start + lead.length
  return [
    ...prompt,
    { type: "text", content: lead, start, end: at },
    { type: "agent", name: agent.agent, content: mention, start: at, end: at + mention.length },
    { type: "text", content: note, start: at + mention.length, end: at + mention.length + note.length },
  ]
}

/** "Ask Vector to resolve": the conflicting paths of an isolated child's merge, for the main agent to settle. */
export function appendTaskConflicts(
  prompt: Prompt,
  agent: Pick<TaskAgent, "title" | "task" | "sessionID">,
  conflicts: readonly string[],
): Prompt {
  const text = `Merging ${JSON.stringify(agent.title)} (task ${agent.task?.id ?? agent.sessionID}) conflicts in ${JSON.stringify(conflicts)}. Resolve the conflicts with care for both sides, then merge it with task_manage merge.`
  const end = promptEnd(prompt)
  const content = `${end ? "\n\n" : ""}${text}`
  return [...prompt, { type: "text", content, start: end, end: end + content.length }]
}

/**
 * Agents "Move to background" may move (5.D.2): running in the foreground, launched by the root itself, and offered by
 * the engine through `controls.background`. A child's own foreground subagents never are.
 */
export function promotableAgents(agents: readonly TaskAgent[], rootID: string | undefined) {
  if (!rootID) return []
  return [
    ...new Map(
      agents
        .filter(
          (agent) =>
            isLive(agent.status) && agent.task?.controls.background === true && agent.task.parentSessionID === rootID,
        )
        .map((agent) => [agent.task!.id, agent]),
    ).values(),
  ]
}

/** A batch, which an engine without `taskPromote` cannot move: only its old route for a single subagent exists. */
export function promotesBatch(agents: readonly TaskAgent[]) {
  return agents.length > 1 || agents.some((agent) => agent.task?.batchID !== undefined)
}

/**
 * A swarm coordinator owns cancellation of its children, and a workflow run owns its agents': issue one control per
 * scope.
 */
export function stoppableAgents(agents: readonly TaskAgent[]) {
  const runs = runIDs(agents)
  const unique = [
    ...new Map(
      agents
        .filter((agent) => isLive(agent.status) && agent.task?.controls.stop !== false && !coveredByRun(agent, runs))
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
