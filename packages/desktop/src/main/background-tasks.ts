import type { RunBudget } from "@vectordevai/schema/run-budget"
import { randomUUID } from "node:crypto"

import { getStore } from "./store"
import { createStoreCache } from "./store-cache"

const STORE_NAME = "background-tasks"
const STORE_KEY = "records"
const MAX_RECORDS = 400
const MAX_LOGS = 160
const MAX_ACTIONS = 200
const PROCESS_ID = randomUUID()

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "needs_input"
  | "complete"
  | "needs_review"
  | "failed"
  | "canceled"
  | "merged"
  | "discarded"
  | "interrupted"

export type BackgroundTaskKind = "parallel-workspace" | "browser-agent" | "terminal" | "agent" | "checkpoint"

export type BackgroundTaskAction = {
  id: string
  at: string
  label: string
  status: "pending" | "running" | "success" | "warning" | "failed"
  detail?: string
}

export type BackgroundTaskRecord = {
  id: string
  kind: BackgroundTaskKind
  projectPath?: string
  taskId?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  prompt: string
  provider: string
  model: string
  status: BackgroundTaskStatus
  progress: number
  currentStep: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  elapsedMs?: number
  changedFilesCount: number
  terminalActive: boolean
  browserActive: boolean
  costEstimate: string
  actualUsage?: string
  billing?: "codium"
  costKind?: RunBudget.CostKind
  errorSummary?: string
  logs: string[]
  actions: BackgroundTaskAction[]
  mergeState?: "none" | "merged" | "discarded"
  processID?: string
}

export type CreateBackgroundTaskInput = {
  kind: BackgroundTaskKind
  projectPath?: string
  taskId?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  prompt?: string
  provider?: string
  model?: string
  status?: BackgroundTaskStatus
  progress?: number
  currentStep?: string
  changedFilesCount?: number
  terminalActive?: boolean
  browserActive?: boolean
  costEstimate?: string
  actualUsage?: string
  billing?: "codium"
  costKind?: RunBudget.CostKind
  errorSummary?: string
  mergeState?: "none" | "merged" | "discarded"
  logs?: string[]
  actions?: BackgroundTaskAction[]
}

export type UpdateBackgroundTaskInput = Partial<
  Omit<BackgroundTaskRecord, "id" | "kind" | "createdAt" | "logs" | "actions">
> & {
  log?: string
  action?: Omit<BackgroundTaskAction, "id" | "at">
}

const now = () => new Date().toISOString()

const cache = createStoreCache<BackgroundTaskRecord>()

function readRecords(): BackgroundTaskRecord[] {
  const store = getStore(STORE_NAME)
  return cache.read(store, () => {
    const raw = store.get(STORE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is BackgroundTaskRecord => typeof item?.id === "string")
  })
}

function writeRecords(records: BackgroundTaskRecord[]) {
  const store = getStore(STORE_NAME)
  const kept = records.slice(0, MAX_RECORDS)
  store.set(STORE_KEY, kept)
  cache.wrote(store, kept)
}

function elapsed(startedAt?: string, completedAt?: string) {
  if (!startedAt) return undefined
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined
  return Math.max(0, end - start)
}

function normalizeRecord(record: BackgroundTaskRecord): BackgroundTaskRecord {
  const belongsToPreviousProcess = record.processID !== PROCESS_ID
  if (["queued", "running", "waiting", "needs_input"].includes(record.status) && belongsToPreviousProcess) {
    return {
      ...record,
      status: "interrupted",
      currentStep: "Interrupted while Vector was closed",
      updatedAt: now(),
      completedAt: now(),
      processID: PROCESS_ID,
      logs: ["Marked interrupted after app restart.", ...record.logs].slice(0, MAX_LOGS),
      actions: [
        {
          id: randomUUID(),
          at: now(),
          label: "Task interrupted",
          status: "warning" as const,
          detail: "Vector restarted before this task reported completion.",
        },
        ...record.actions,
      ].slice(0, MAX_ACTIONS),
    }
  }
  return record
}

export function listBackgroundTasks(scope?: string | { projectPath?: string; taskId?: string }) {
  const projectPath = typeof scope === "string" ? scope : scope?.projectPath
  const taskId = typeof scope === "string" ? undefined : scope?.taskId
  const records = readRecords()
  const normalized = records.map(normalizeRecord)
  // The app polls this list every 1.5 s on a task route. Rewriting the store on every poll re-read and rewrote the
  // whole file each time, so it is written only when a run left by an earlier process was just marked interrupted.
  if (normalized.some((record, index) => record !== records[index])) writeRecords(normalized)
  return normalized.filter((record) => {
    if (projectPath && record.projectPath !== projectPath) return false
    return record.taskId === taskId
  })
}

export function createBackgroundTask(input: CreateBackgroundTaskInput) {
  const timestamp = now()
  const record: BackgroundTaskRecord = {
    id: randomUUID(),
    kind: input.kind,
    projectPath: input.projectPath,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    name: input.name,
    prompt: input.prompt ?? "",
    provider: input.provider ?? "Current Vector provider",
    model: input.model ?? "Current selected model",
    status: input.status ?? "queued",
    progress: input.progress ?? 0,
    currentStep: input.currentStep ?? "Queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: input.status === "running" ? timestamp : undefined,
    completedAt: undefined,
    elapsedMs: undefined,
    changedFilesCount: input.changedFilesCount ?? 0,
    terminalActive: input.terminalActive ?? false,
    browserActive: input.browserActive ?? false,
    costEstimate: input.costEstimate ?? "Estimate unavailable",
    actualUsage: input.actualUsage,
    ...(input.billing ? { billing: input.billing } : {}),
    ...(input.costKind ? { costKind: input.costKind } : {}),
    errorSummary: input.errorSummary,
    logs: input.logs?.slice(0, MAX_LOGS) ?? [],
    actions: input.actions?.slice(0, MAX_ACTIONS) ?? [
      {
        id: randomUUID(),
        at: timestamp,
        label: input.currentStep ?? "Task queued",
        status: input.status === "failed" ? "failed" : input.status === "running" ? "running" : "pending",
      },
    ],
    mergeState: input.mergeState,
    processID: PROCESS_ID,
  }
  writeRecords([record, ...readRecords().filter((item) => item.id !== record.id)])
  return record
}

export function updateBackgroundTask(id: string, update: UpdateBackgroundTaskInput) {
  const { log, action, ...patch } = update
  const records = readRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index === -1) throw new Error("Background task was not found.")

  const current = records[index]!
  const timestamp = now()
  const completedAt =
    patch.completedAt ??
    (patch.status && ["complete", "needs_review", "failed", "canceled", "merged", "discarded"].includes(patch.status)
      ? timestamp
      : current.completedAt)
  const startedAt =
    patch.startedAt ?? (patch.status === "running" && !current.startedAt ? timestamp : current.startedAt)
  const nextLogs = log ? [log, ...current.logs].slice(0, MAX_LOGS) : current.logs
  const nextActions = action
    ? [
        {
          id: randomUUID(),
          at: timestamp,
          ...action,
        },
        ...current.actions,
      ].slice(0, MAX_ACTIONS)
    : current.actions

  records[index] = {
    ...current,
    ...patch,
    logs: nextLogs,
    actions: nextActions,
    startedAt,
    completedAt,
    elapsedMs: elapsed(startedAt, completedAt),
    updatedAt: timestamp,
  }
  writeRecords(records)
  return records[index]!
}

export function cancelBackgroundTask(id: string) {
  return updateBackgroundTask(id, {
    status: "canceled",
    progress: 100,
    currentStep: "Canceled by user",
    terminalActive: false,
    browserActive: false,
    log: `Canceled at ${now()}.`,
    action: {
      label: "Task canceled",
      status: "warning",
    },
  })
}

export function clearCompletedBackgroundTasks(scope?: string | { projectPath?: string; taskId?: string }) {
  const projectPath = typeof scope === "string" ? scope : scope?.projectPath
  const taskId = typeof scope === "string" ? undefined : scope?.taskId
  const completed = new Set<BackgroundTaskStatus>(["complete", "failed", "canceled", "merged", "discarded"])
  const remaining = readRecords().filter((record) => {
    if (projectPath && record.projectPath !== projectPath) return true
    if (record.taskId !== taskId) return true
    return !completed.has(record.status)
  })
  writeRecords(remaining)
  return listBackgroundTasks(scope)
}
