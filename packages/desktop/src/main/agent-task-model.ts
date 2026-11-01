import { Billing } from "@vectordevai/schema/billing"
import type { Task } from "@vectordevai/schema/task"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"
import type { SwarmRunRecord } from "./swarm-orchestrator"

export function workspaceTaskID(record: Pick<ParallelWorkspaceRecord, "id" | "swarmRunId" | "swarmTaskId">) {
  return record.swarmRunId && record.swarmTaskId
    ? `swarm:${record.swarmRunId}:${record.swarmTaskId}`
    : `workspace:${record.id}`
}

export function workspaceTask(
  record: ParallelWorkspaceRecord,
  input: { now: number; swarm?: SwarmRunRecord; canMessage?: boolean },
): Task.Info {
  const task = input.swarm?.tasks.find((task) => task.id === record.swarmTaskId)
  const status: Task.Status = task
    ? swarmTaskStatus(task)
    : record.status === "queued"
      ? "queued"
      : ["planning", "editing", "running commands", "testing"].includes(record.status)
        ? "running"
        : record.status === "needs review"
          ? "waiting_on_user"
          : record.status === "failed"
            ? "failed"
            : record.status === "stopped" || record.status === "discarded"
              ? "stopped"
              : "completed"
  const startedAt = Date.parse(record.createdAt)
  const settled = status === "failed" || status === "stopped" || status === "completed" || status === "waiting_on_user"
  const completedAt = settled ? Date.parse(record.lastActivityAt) : undefined
  const cost =
    record.measuredCost ??
    (record.actualCost && /^\$\d+(?:\.\d+)?$/.test(record.actualCost) ? Number(record.actualCost.slice(1)) : undefined)
  return {
    id: workspaceTaskID(record),
    sessionID: record.agentSessionId,
    parentSessionID: input.swarm?.parentSessionId ?? record.parentSessionId ?? "",
    source: record.swarmRunId
      ? "swarm"
      : record.teamId
        ? "team"
        : record.runtime === "vector"
          ? "subagent"
          : "external",
    title: record.name,
    agent: record.agent ?? record.runtime,
    status,
    groupID: record.swarmRunId ?? record.teamId,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    completedAt: completedAt !== undefined && Number.isFinite(completedAt) ? completedAt : undefined,
    elapsedMs: Number.isFinite(startedAt) ? Math.max(0, (completedAt ?? input.now) - startedAt) : 0,
    currentStep: task?.lastAction ?? record.lastAction,
    ownedPaths: task?.fileHints ?? [],
    dependsOn: task?.dependsOn.map((id) => `swarm:${record.swarmRunId}:${id}`) ?? [],
    resultAvailable: Boolean(record.finalSummary || record.changedFiles.length),
    resultRef: record.changedFiles.length ? `workspace:${record.id}` : undefined,
    reason: task?.stopReason ?? record.stopReason ?? task?.error ?? record.error,
    attempt: Math.max(1, record.turns?.filter((turn) => turn.role === "user").length ?? 1),
    measuredCost: cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
    ...(record.billing ? { billing: record.billing } : {}),
    costKind:
      record.costKind ??
      ((record.billing === "codium" || (record.runtime === "vector" && Billing.isCodium(record.provider))) && !cost
        ? "codium"
        : cost !== undefined
          ? "priced"
          : "unknown"),
    controls: {
      inspect: true,
      message: input.canMessage === true && !settled && !task?.cancelRequested,
      stop: !settled && !task?.cancelRequested,
    },
  }
}

export function swarmTasks(run: SwarmRunRecord, now: number): Task.Info[] {
  const status: Task.Status = ["planning", "running"].includes(run.status)
    ? "running"
    : run.status === "needs review"
      ? "waiting_on_user"
      : ["canceled", "interrupted", "discarded"].includes(run.status)
        ? "stopped"
        : run.status === "failed"
          ? "failed"
          : "completed"
  const root: Task.Info = {
    id: `swarm:${run.id}`,
    parentSessionID: run.parentSessionId ?? "",
    source: "swarm",
    title: run.name,
    agent: "coordinator",
    groupID: run.id,
    status,
    startedAt: Date.parse(run.createdAt),
    completedAt: run.completedAt ? Date.parse(run.completedAt) : undefined,
    elapsedMs: Math.max(0, (run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.createdAt)),
    currentStep: run.currentStep,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: Boolean(run.summary),
    resultRef: run.summary ? `swarm:${run.id}` : undefined,
    reason: run.stopReason ?? run.error,
    attempt: 1,
    controls: { inspect: true, message: false, stop: status === "running" },
  }
  return [
    root,
    ...run.tasks.map(
      (task): Task.Info => ({
        id: `swarm:${run.id}:${task.id}`,
        parentSessionID: root.parentSessionID,
        source: "swarm",
        title: task.title,
        agent: task.role,
        groupID: run.id,
        status: swarmTaskStatus(task),
        startedAt: task.startedAt ? Date.parse(task.startedAt) : root.startedAt,
        completedAt: task.completedAt ? Date.parse(task.completedAt) : undefined,
        elapsedMs: task.startedAt
          ? Math.max(0, (task.completedAt ? Date.parse(task.completedAt) : now) - Date.parse(task.startedAt))
          : 0,
        currentStep: task.lastAction,
        ownedPaths: task.fileHints,
        dependsOn: task.dependsOn.map((id) => `swarm:${run.id}:${id}`),
        resultAvailable: Boolean(task.summary),
        reason: task.stopReason ?? task.error,
        attempt: 1,
        controls: {
          inspect: true,
          message: false,
          stop:
            ["planned", "creating", "queued", "running", "merging", "blocked"].includes(task.status) &&
            !task.cancelRequested,
        },
      }),
    ),
  ]
}

function swarmTaskStatus(task: SwarmRunRecord["tasks"][number]): Task.Status {
  if (["failed", "blocked"].includes(task.status)) return "failed"
  if (["canceled", "interrupted"].includes(task.status)) return "stopped"
  if (task.status === "complete") return "completed"
  if (["creating", "running", "merging"].includes(task.status)) return "running"
  return "queued"
}
