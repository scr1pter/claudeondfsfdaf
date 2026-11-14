import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Task } from "@vectordevai/schema/task"
import { sanitizeTerminalText } from "../../util/presentation"

/*
 * How `/tasks`, its task actions and the session's toasts print subagent tasks (5.I.5). Titles, reports, notes, file
 * names, branches, workflow titles and JSON come from models or children, so every one of them passes
 * `sanitizeTerminalText` here before it reaches the terminal (I13). Multi-line text keeps its lines.
 */

const safe = sanitizeTerminalText

/** Text a model or child wrote, line by line, with tabs as two spaces. */
export function safeBlock(text: string) {
  return text
    .split("\n")
    .map((line) => safe(line.replaceAll("\t", "  ")))
    .join("\n")
}

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting_on_user"])

// Desktop Parallel Workspaces and Swarm keep their own runners and Stop; the terminal never stops them.
const DESKTOP_TASK = /^(workspace|swarm):/

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function usd(value: number) {
  return `$${value.toFixed(2)}`
}

function minutes(since: number, now: number) {
  const value = Math.floor(Math.max(0, now - since) / 60_000)
  return value < 1 ? "<1m" : `${value}m`
}

/** A task's title as the terminal shows it. A workflow run is named by its workflow's title. */
export function taskTitle(task: Pick<Task.Info, "title" | "workflow">) {
  return safe(task.workflow?.role === "run" && task.workflow.title ? task.workflow.title : task.title)
}

/** Whether a restart interrupted this task and it is neither resumed nor dismissed yet. */
export function pendingInterruption(task: Pick<Task.Info, "interrupted">) {
  return (
    task.interrupted !== undefined &&
    task.interrupted.resumedAt === undefined &&
    task.interrupted.dismissedAt === undefined
  )
}

function statusText(task: Task.Info, now: number) {
  if (task.connection === "disconnected") return `Disconnected (last known: ${safe(task.status)})`
  if (task.waiting)
    return `${task.waiting.kind === "question" ? "Needs your answer" : "Needs your permission"} · ${minutes(task.waiting.since, now)}`
  if (task.status === "waiting_on_user") return "Needs you"
  if (pendingInterruption(task)) return "Interrupted by a restart"
  return task.status
}

function usageText(task: Task.Info) {
  return (
    CodiumUsage.taskText(task) ??
    (task.usage
      ? [
          `${task.usage.total.toLocaleString("en-US")} tokens`,
          task.usage.unpricedSteps
            ? "cost partly unknown"
            : task.costKind === "plan"
              ? "covered by plan"
              : task.costKind === "free"
                ? "free model"
                : `$${task.usage.cost.toFixed(4)}`,
        ]
      : task.measuredCost !== undefined
        ? [`$${task.measuredCost.toFixed(4)} reported`, "tokens unavailable"]
        : [
            task.costKind === "plan"
              ? "covered by plan"
              : task.costKind === "free"
                ? "free model"
                : "usage unavailable",
          ])
  )
}

/** "gpt-5 · high effort · fork": the model's short name, the effort when it is not the default, and the fork badge. */
export function modelText(task: Pick<Task.Info, "model" | "effort" | "fork">) {
  const parts = [
    ...(task.model ? [`${task.model.modelID}${task.model.variant ? ` (${task.model.variant})` : ""}`] : []),
    ...(task.effort && task.effort !== "default" ? [`${task.effort} effort`] : []),
    ...(task.fork ? ["fork"] : []),
  ]
  return parts.length ? parts.map(safe).join(" · ") : undefined
}

/** "worktree vector/task-1 · changed · 3 files (+12 -4)". */
export function isolationText(isolation: Task.Isolation) {
  const changed =
    isolation.files === undefined
      ? []
      : [
          `${count(isolation.files, "file")}${isolation.additions !== undefined || isolation.deletions !== undefined ? ` (+${isolation.additions ?? 0} -${isolation.deletions ?? 0})` : ""}`,
        ]
  return [
    `${isolation.mode === "copy" ? "copy" : "worktree"}${isolation.branch ? ` ${safe(isolation.branch)}` : ""}`,
    safe(isolation.state),
    ...changed,
  ].join(" · ")
}

function resultText(result: Task.Result | undefined) {
  if (!result || result.format !== "json") return []
  return [result.valid === true ? "JSON valid" : result.valid === false ? "JSON failed its schema" : "JSON"]
}

function workflowText(workflow: Task.Workflow | undefined) {
  if (!workflow) return []
  if (workflow.role === "run") {
    const agents = workflow.agents
    return [
      ...(agents
        ? [`${agents.launched} of ${agents.max} agents${agents.running ? ` · ${agents.running} running` : ""}`]
        : []),
      ...(workflow.stop ? [safe(workflow.stop.message)] : []),
    ]
  }
  return [
    [workflow.stage, workflow.item]
      .filter((value): value is string => !!value)
      .map(safe)
      .join(" · "),
    ...(workflow.round !== undefined && workflow.round > 1 ? [`round ${workflow.round}`] : []),
    ...(workflow.verified === true ? ["verified"] : []),
  ].filter(Boolean)
}

export function taskDescription(task: Task.Info, now = Date.now()) {
  return [
    statusText(task, now),
    `${Math.round(task.elapsedMs / 1000)}s`,
    ...usageText(task),
    ...(modelText(task) ? [modelText(task)!] : []),
    ...(task.status === "queued" && task.queuedReason ? [safe(task.queuedReason)] : []),
    ...(task.currentStep ? [safe(task.currentStep)] : []),
    ...(task.isolation ? [isolationText(task.isolation)] : []),
    ...resultText(task.result),
    ...workflowText(task.workflow),
    ...(task.inbox?.unread ? [count(task.inbox.unread, "unread message")] : []),
    ...(task.dependsOn.length
      ? [`${task.dependsOn.length} ${task.dependsOn.length === 1 ? "dependency" : "dependencies"}`]
      : []),
  ].join(" · ")
}

const SENDERS: Record<string, string> = {
  user: "You",
  parent: "Main agent",
  peer: "Another subagent",
  task: "This subagent",
}

export function taskProgress(result: Task.InspectResult, now = Date.now()) {
  const task = result.task
  return [
    taskDescription(task, now),
    ...(task.reason ? [safe(task.reason)] : []),
    ...(task.waiting?.summary ? [safe(task.waiting.summary)] : []),
    ...(pendingInterruption(task)
      ? [`Interrupted when Vector stopped (${safe(task.interrupted!.cause)}). Nothing resumes on its own.`]
      : []),
    ...(task.isolation?.conflicts?.length ? [`Conflicts: ${task.isolation.conflicts.map(safe).join(", ")}`] : []),
    ...(task.isolation?.error ? [`Worktree error: ${safe(task.isolation.error)}`] : []),
    ...(task.ownedPaths.length ? [`Owns: ${task.ownedPaths.map(safe).join(", ")}`] : []),
    ...(task.dependsOn.length ? [`Depends on: ${task.dependsOn.map(safe).join(", ")}`] : []),
    ...result.steps.map(
      (step) => `${safe(step.tool ?? "Step")}${step.status ? ` (${safe(step.status)})` : ""}: ${safe(step.text)}`,
    ),
    ...(result.messages?.length
      ? [
          [
            "Messages:",
            ...result.messages.map(
              (message) => `  ${SENDERS[message.sender] ?? safe(message.sender)}: ${safeBlock(message.text)}`,
            ),
          ].join("\n"),
        ]
      : []),
    ...(result.structured
      ? [
          `Structured result (${result.structured.valid ? "valid" : "did not match its schema"}${result.structured.truncated ? ", bounded" : ""}):\n${safeBlock(result.structured.json)}`,
        ]
      : []),
    safeBlock(result.output),
    ...(result.truncated
      ? [`Showing bounded progress. Result reference: ${safe(task.resultRef ?? task.sessionID ?? task.id)}`]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** "5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend" (5.B.10, I9). */
export function limitsLine(limits: Task.Limits) {
  const spend = limits.spend
  const amount = !spend
    ? undefined
    : spend.unknownSteps > 0
      ? spend.spentUsd > 0
        ? `${usd(spend.spentUsd)} + unknown`
        : "unknown"
      : usd(spend.spentUsd)
  return [
    `${limits.running} of ${limits.maxRunning} running`,
    ...(limits.queued > 0 ? [`${limits.queued} waiting`] : []),
    `${limits.launched} of ${limits.maxPerRequest} started this request`,
    ...(spend
      ? [
          `${amount}${spend.limitUsd !== undefined ? ` of ${usd(spend.limitUsd)}` : ""} subagent spend${spend.stopped ? " (ceiling reached)" : ""}`,
        ]
      : []),
  ].join(" · ")
}

export const INTERRUPTED_CATEGORY = "Interrupted by a restart"

function runOf(task: Pick<Task.Info, "groupID" | "workflow">) {
  if (task.workflow?.role === "agent") return task.workflow.runID
  if (task.groupID?.startsWith("workflow:")) return task.groupID.slice("workflow:".length)
}

/** The `/tasks` category a task is listed under. */
export function taskCategory(task: Task.Info, tasks: readonly Task.Info[] = []) {
  if (pendingInterruption(task)) return INTERRUPTED_CATEGORY
  if (task.workflow?.role === "run") return `Workflow ${taskTitle(task)}`
  const runID = runOf(task)
  if (runID) {
    const run = tasks.find((item) => item.id === runID)
    return `Workflow ${run ? taskTitle(run) : task.workflow?.title ? safe(task.workflow.title) : safe(runID.slice(-8))}`
  }
  if (task.groupID) return `${task.source === "swarm" ? "Swarm" : "Team"} ${safe(task.groupID.slice(-8))}`
  if (task.batchID) return `Batch ${safe(task.batchID.slice(-8))}`
  if (task.source === "external") return "External agents"
  return "Subagents"
}

/**
 * Tasks in the order `/tasks` lists them: the interrupted ones first, then every category where it first appears,
 * with a workflow run ahead of its own agents.
 */
export function orderedTasks(tasks: readonly Task.Info[]) {
  const categories = tasks.map((task) => taskCategory(task, tasks))
  const first = new Map<string, number>()
  categories.forEach((category, index) => {
    if (!first.has(category)) first.set(category, index)
  })
  return tasks
    .map((task, index) => ({ task, index, category: categories[index] }))
    .toSorted(
      (a, b) =>
        Number(a.category !== INTERRUPTED_CATEGORY) - Number(b.category !== INTERRUPTED_CATEGORY) ||
        first.get(a.category)! - first.get(b.category)! ||
        Number(a.task.workflow?.role !== "run") - Number(b.task.workflow?.role !== "run") ||
        a.index - b.index,
    )
    .map((item) => ({ task: item.task, category: item.category }))
}

/** The subagents a restart interrupted that can be resumed now: not resumed, not dismissed, resumable. */
export function interruptedTaskIDs(tasks: readonly Task.Info[]) {
  return tasks
    .filter((task) => task.source === "subagent" && pendingInterruption(task) && task.controls.resume === true)
    .map((task) => task.id)
}

/**
 * Helpers that keep running after the main turn stops: this session's own queued, running or waiting subagents that
 * do not end with the turn (foreground work does), plus its running background commands. Desktop workspaces and a
 * workflow run's own agents (they stop with their run) are not counted.
 */
export function liveHelpers(result: {
  tasks: readonly Pick<Task.Info, "id" | "source" | "status" | "background" | "workflow">[]
  shells?: readonly Pick<Task.Shell, "status">[]
}) {
  return (
    result.tasks.filter(
      (task) =>
        task.source === "subagent" &&
        !DESKTOP_TASK.test(task.id) &&
        task.workflow?.role !== "agent" &&
        ACTIVE.has(task.status) &&
        task.background !== false,
    ).length + (result.shells ?? []).filter((shell) => shell.status === "running").length
  )
}

/** `task.stop` takes at most 200 IDs per request. */
export const STOP_CHUNK = 200

export type StopRequest = { sessionID: string; taskIDs: string[]; reason?: string }

/**
 * The `task.stop` requests behind "Stop background subagents": only this conversation's live background subagents,
 * at most 200 IDs each. Foreground work, desktop workspaces, a workflow run's agents and tasks the engine says cannot
 * be stopped are left out. `background` names the helper sessions the transcript knows were launched in the
 * background, for an engine that does not send `Task.Info.background`.
 */
export function backgroundStopRequests(input: {
  sessionID: string
  tasks: readonly Task.Info[]
  background?: ReadonlySet<string>
  reason?: string
}): StopRequest[] {
  const ids = [
    ...new Set(
      input.tasks
        .filter(
          (task) =>
            task.source === "subagent" &&
            !DESKTOP_TASK.test(task.id) &&
            task.workflow?.role !== "agent" &&
            ACTIVE.has(task.status) &&
            task.controls.stop !== false &&
            (task.background === true ||
              (task.background === undefined && !!input.background?.has(task.sessionID ?? task.id))),
        )
        .map((task) => task.id),
    ),
  ]
  const requests: StopRequest[] = []
  for (let index = 0; index < ids.length; index += STOP_CHUNK)
    requests.push({
      sessionID: input.sessionID,
      taskIDs: ids.slice(index, index + STOP_CHUNK),
      ...(input.reason ? { reason: input.reason } : {}),
    })
  return requests
}

const BAR = 10

/** One line per stage of a workflow run: "Review each file  ████░░░░░░ 4 of 10 · 2 running · 1 failed". */
export function stageLines(workflow: Task.Workflow | undefined) {
  return (workflow?.stages ?? []).map((stage) => {
    const settled = stage.done + stage.failed + stage.skipped
    const total = stage.total
    const filled = total ? Math.min(BAR, Math.round((settled / total) * BAR)) : 0
    return [
      `${safe(stage.title)}  ${total ? "█".repeat(filled) + "░".repeat(BAR - filled) : "…"} ${settled}${total !== undefined ? ` of ${total}` : ""}`,
      ...(stage.running ? [`${stage.running} running`] : []),
      ...(stage.waiting ? [`${stage.waiting} waiting`] : []),
      ...(stage.failed ? [`${stage.failed} failed`] : []),
      ...(stage.skipped ? [`${stage.skipped} skipped`] : []),
    ].join(" · ")
  })
}

/** The toast after Esc Esc stopped only the main turn and helpers keep running. */
export function helpersLeftMessage(count: number, shortcut?: string) {
  return `Stopped the main turn. ${count === 1 ? "1 helper" : `${count} helpers`} still running · ${shortcut || "/stop-all"} stops them`
}

/** What "Stop including helpers" did. */
export function stoppedHelpersMessage(result: { stopped: number; shells: number; excluded: number; failed: number }) {
  const parts = [
    "the main turn",
    ...(result.stopped > 0 ? [count(result.stopped, "helper")] : []),
    ...(result.shells > 0 ? [count(result.shells, "background command")] : []),
  ]
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]
  return [
    `Stopped ${listed}. Partial work is kept.`,
    ...(result.excluded > 0 ? ["Agent workspaces keep running; stop them from the Agent Dashboard."] : []),
    ...(result.failed > 0 ? [`${count(result.failed, "stop request")} failed.`] : []),
  ].join(" ")
}

/** The one-time toast when the board lists helpers a restart interrupted. */
export function interruptedToast(count: number, shortcut?: string) {
  return `${count === 1 ? "1 subagent" : `${count} subagents`} stopped when Vector restarted. Nothing resumes on its own · ${shortcut || "/tasks"} to resume`
}
