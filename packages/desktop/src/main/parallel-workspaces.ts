import { Billing } from "@vectordevai/schema/billing"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { app } from "electron"
import { VERIFIED_COMPLETION_POLICY } from "@vectordevai/app/judge"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { taskBoardChanged } from "./task-board-events"
import { backupBeforeOverwrite } from "./workspace-checkpoint"
import { copyProject, hashFile, hashProject, listProjectFiles } from "@vectordevai/core/isolation/copy"

import {
  cancelBackgroundTask,
  createBackgroundTask,
  updateBackgroundTask,
  type BackgroundTaskStatus,
} from "./background-tasks"
import {
  classifyTaskDifficulty,
  contextBudgetForDifficulty,
  createContextBudgetPack,
  formatContextBudgetForAgent,
  type TaskDifficulty,
} from "./context-budget"
import { getStore } from "./store"
import { createStoreCache } from "./store-cache"
import { createPullRequest } from "./github"
import { checkPost } from "./posting-check"
import {
  externalModelValue,
  runExternalCodingAgent,
  runningTerminalAgents,
  serializeExternalAgentStart,
  type CodingAgentRuntime,
  type RunExternalAgentInput,
  type ExternalAgentRunResult,
} from "./external-agents"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { markTeamMessagesDelivered, pendingTeamMessages, postTeamMessage, teamForWorkspace } from "./agent-teams"
import { formatDelivery, formatHandoff, type TeamMessage } from "./agent-team-model"
import { priorFor, recordValidationRun } from "./failure-memory"
import { formatValidationForRepair, validateWorkspace, type WorkspaceValidationReport } from "./workspace-guardrails"
import { whileDesktopWorks } from "./keep-awake"
import { parseUnifiedDiff, selectUnifiedDiff, type UnifiedDiffSelection } from "./unified-diff"
import { scanChangedSecrets } from "./secret-scanner"
import { spendLedger } from "./spend-limits"
import {
  combineSpend,
  formatUsd,
  measuredCost,
  newSpend,
  readSpend,
  sessionCost,
  sessionTokens,
  usageDelta,
  type EngineSessionResponse,
} from "./run-usage"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { parallelSessionCreateRequest } from "./parallel-session-scope"
import { repoRulesForPrompt } from "./repo-rules"
import { formatRulesForPrompt } from "./repo-rules-model"
import {
  appendTurn,
  continuationPrompt,
  updateTurnChat,
  type AgentChat,
  settleRunningTurns,
  settleTurn,
  type ParallelWorkspaceTurn,
} from "./parallel-workspace-turns"

export type { ParallelWorkspaceTurn } from "./parallel-workspace-turns"

// Keep persisted metadata and isolated checkout directories on distinct paths.
// electron-store creates a file with STORE_NAME, so sharing that name with the
// workspace directory makes either the store or the checkout root unreadable.
const STORE_NAME = "parallel-workspaces-state"
const STORE_KEY = "records"
const PROCESS_ID = randomUUID()
const WORKSPACE_DIRECTORY_NAME = "parallel-workspace-runs"

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
])

export type ParallelWorkspaceStatus =
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

export type ParallelWorkspaceRuntime = "vector" | CodingAgentRuntime

export type ParallelWorkspaceRecord = {
  id: string
  // Orders durable snapshots even when writes share a timestamp or the clock moves backward.
  revision?: number
  name: string
  taskPrompt: string
  runtime: ParallelWorkspaceRuntime
  provider: string
  model: string
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  baseCommit?: string
  agentSessionId?: string
  // The external CLI's own conversation id — codex thread_id, claude
  // session_id. Deliberately not agentSessionId: that field is engine-session
  // identity and drainTeamOutbox matches senders against it.
  externalSessionId?: string
  // The value an external CLI gets for its model flag on its next turn. Unset
  // (every record from before the picker) runs the CLI's own default model.
  runtimeModel?: string
  // The last model this workspace's CLI refused, and when (ISO). The app drops
  // it from that runtime's Recently used unless it was picked again after, so a
  // new agent never starts on a model the CLI will not run.
  refusedRuntimeModel?: { model: string; at: string }
  backgroundTaskId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  // Whether this workspace's agent runs under the verified-completion policy.
  // Captured per workspace so a run keeps the behaviour it was launched with.
  llmJudge?: boolean
  teamId?: string
  status: ParallelWorkspaceStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  estimatedCost: string
  actualCost?: string
  measuredCost?: number
  runOwnerID?: string
  stopReason?: string
  finalSummary: string
  mergeState: "none" | "merged" | "discarded"
  // Set just before a merge starts writing into the source. With mergeState still "none" it means Vector stopped
  // part-way through those writes, so the source may already hold some of this workspace's changes.
  mergeStartedAt?: string
  // The checkpoint of the merge mergeStartedAt marks. Its folder holds every file that merge was about to write as it
  // was before, and their names, so the merge can be undone (rollBackUnfinishedMerge).
  mergeCheckpointPath?: string
  // Why the last merge into the source failed, until the agent runs again. "conflict": the source holds other changes
  // where this workspace's changes go, so the same changes would be refused again. "error": anything else, such as a
  // write that failed. Either way the merge undoes what it wrote, and mergeStartedAt stays set only when it could not.
  mergeFailure?: "conflict" | "error"
  // A merged workspace whose isolated copy Vector had not finished removing, and the commit the user asked for that the
  // merge had not made yet. A restart finishes the cleanup and reports the commit (finishInterruptedMerge).
  cleanupPending?: boolean
  pendingCommit?: string
  // The agent's own summary of its work, kept when a merge replaces finalSummary with what the merge did.
  summaryBeforeMerge?: string
  logs: string[]
  terminalOutput: string[]
  browserResults: string[]
  changedFiles: string[]
  diff: string
  checkpointPath?: string
  pullRequestUrl?: string
  /** The latest Vercel preview of this workspace, at its stable branch address when Vercel assigned one. */
  previewUrl?: string
  baselineHashes?: Record<string, string>
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  // Optional so every already-persisted record stays valid with no migration;
  // the UI falls back to the raw log view when it is empty.
  turns?: ParallelWorkspaceTurn[]
  taskDifficulty?: TaskDifficulty
  retryLimit?: number
  validationReport?: WorkspaceValidationReport
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
  // Set on every workspace of a user's own coding agent: nothing from it goes into what Vector learns from or
  // measures (ExternalAgent.excludedFromLearning). Kept on the record so it holds after the agent leaves the catalog.
  excludedFromLearning?: boolean
}

export type ParallelWorkspaceEngine = {
  url: string
  username: string | null
  password: string | null
}

type ActiveParallelRun = {
  controller: AbortController
  engine: ParallelWorkspaceEngine
  sessionId?: string
  acceptsTeamMessages?: boolean
  // Set only by followUpParallelWorkspace. Carried on the queue entry so a
  // follow-up rides executeParallelWorkspace's existing ledger pre-flight,
  // catch and finally instead of duplicating them.
  followUp?: string
  externalAgentRunner?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult>
  // Set once the ledger allows the run. See ParallelRunSpend.
  spend?: ParallelRunSpend
}

// What a Vector-runtime run holds and has spent. `budgetUsd` is the ledger
// headroom it reserved, sent as the engine budget with every prompt it admits.
// Each drain of the session is its own guard run, so `measured` sums the
// drains read so far, `counted` is the last reading added to it, a later
// prompt only gets what is left, and `draining` says a drain has started that
// is not in `measured` yet.
type ParallelRunSpend = {
  projectPath: string
  budgetUsd?: number
  measured?: RunBudget.Snapshot
  counted?: RunBudget.Snapshot
  draining: boolean
  before?: EngineSessionResponse["data"]
}

// The engine can take longer than this only when it is wedged, and a wedged
// engine must not keep a finished run's reservation held.
const SPEND_READ_TIMEOUT_MS = 5_000

const activeRuns = new Map<string, ActiveParallelRun>()
const queuedRuns = new Map<string, ActiveParallelRun>()
// No cap: every launch the user asks for starts. A swarm throttles itself with
// its scheduler's `slots` check (swarm-orchestrator.ts) and passes no
// concurrency here, so the shared pool only narrows when a caller explicitly
// asks it to.
let maxConcurrentRuns = Number.POSITIVE_INFINITY

// The statuses in which an agent is doing work and competing for the CPU.
// "queued" is waiting for a slot and "needs review" has finished.
const RUNNING_STATUSES: ParallelWorkspaceStatus[] = ["planning", "editing", "running commands", "testing"]

function normalizeConcurrency(value?: number) {
  if (value === undefined || Number.isNaN(value)) return maxConcurrentRuns
  if (value === Number.POSITIVE_INFINITY) return value
  return Math.max(1, Math.floor(value))
}

function drainParallelRunQueue() {
  while (activeRuns.size < maxConcurrentRuns && queuedRuns.size > 0) {
    const next = queuedRuns.entries().next().value as [string, ActiveParallelRun] | undefined
    if (!next) return
    const [id, run] = next
    queuedRuns.delete(id)
    const record = readRecords().find((item) => item.id === id)
    if (!record || record.mergeState !== "none") continue
    activeRuns.set(id, run)
    const started = updateRecord(id, (current) => ({
      ...current,
      status: "planning",
      progress: 0,
      lastAction: `Starting isolated ${runtimeLabel(current.runtime)} session`,
      lastActivityAt: now(),
      error: undefined,
      logs: [`Agent slot opened at ${now()}.`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(started, `Parallel agent started with ${runtimeLabel(started.runtime)}.`)
    void executeParallelWorkspace(id, run.engine, run.controller)
  }
}

export type CreateParallelWorkspaceInput = {
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  name?: string
  taskPrompt: string
  runtime?: ParallelWorkspaceRuntime
  provider?: string
  model?: string
  // The external CLI's model flag value; ignored for a Vector-runtime agent.
  runtimeModel?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  teamId?: string
  sharedPath?: string
  llmJudge?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  failed: boolean
}

const now = () => new Date().toISOString()
// What an external agent's `model` reads while its CLI picks the model itself.
const RUNTIME_DEFAULT_MODEL = "Runtime default"
const workspaceRoot = () => join(app.getPath("userData"), WORKSPACE_DIRECTORY_NAME)
const runtimeLabel = (runtime: ParallelWorkspaceRuntime) =>
  runtime === "vector" ? "Vector" : (ExternalAgent.find(runtime)?.name ?? "Vector")

const cache = createStoreCache<ParallelWorkspaceRecord>()

function readRecords(): ParallelWorkspaceRecord[] {
  const store = getStore(STORE_NAME)
  return cache.read(store, () => {
    const raw = store.get(STORE_KEY)
    if (!Array.isArray(raw)) return []
    const records = raw
      .filter((item): item is ParallelWorkspaceRecord => typeof item?.id === "string")
      .map(
        (item): ParallelWorkspaceRecord => ({
          ...item,
          revision: item.revision ?? 0,
          runtime: ExternalAgent.isChatId(item.runtime) ? item.runtime : "vector",
          // Read before the runtime above can fall back to Vector's, so an agent's record never starts counting.
          ...(ExternalAgent.excludedFromLearning(item) ? { excludedFromLearning: true } : {}),
        }),
      )
    const compacted = records.map(compactClosedParallelWorkspace)
    // Closed workspaces have no checkout left and cannot be run or reviewed
    // again. Older versions nevertheless retained their full binary diff,
    // baseline hash table and every changed filename. One real history file had
    // reached 48 MB, so each streamed agent event synchronously serialized that
    // whole file and pinned Electron's main thread. Migrate it on the first read;
    // identity is preserved for already-compact records, so this writes once.
    if (compacted.some((record, index) => record !== records[index])) store.set(STORE_KEY, compacted)
    return compacted
  })
}

export function compactClosedParallelWorkspace(record: ParallelWorkspaceRecord) {
  const closed =
    record.mergeState === "merged" ||
    record.mergeState === "discarded" ||
    record.status === "merged" ||
    record.status === "discarded"
  if (!closed || (!record.diff && !record.baselineHashes && (record.changedFiles?.length ?? 0) === 0)) return record
  return {
    ...record,
    // changedFilesCount and finalSummary retain the useful historical result.
    // These payloads only support review, rerun, and merge, all of which are
    // forbidden once the isolated checkout is closed.
    diff: "",
    baselineHashes: undefined,
    changedFiles: [],
  }
}

function writeRecords(records: ParallelWorkspaceRecord[]) {
  const store = getStore(STORE_NAME)
  store.set(STORE_KEY, records)
  cache.wrote(store, records)
  taskBoardChanged()
}

function updateRecord(id: string, update: (record: ParallelWorkspaceRecord) => ParallelWorkspaceRecord) {
  const records = readRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index === -1) throw new Error("Parallel workspace was not found.")
  records[index] = compactClosedParallelWorkspace({
    ...update(records[index]!),
    revision: (records[index]!.revision ?? 0) + 1,
  })
  writeRecords(records)
  return records[index]!
}

function backgroundStatus(status: ParallelWorkspaceStatus): BackgroundTaskStatus {
  if (status === "queued") return "queued"
  if (status === "planning" || status === "editing" || status === "running commands" || status === "testing") {
    return "running"
  }
  if (status === "needs review") return "needs_review"
  if (status === "complete") return "complete"
  if (status === "failed") return "failed"
  if (status === "stopped") return "canceled"
  if (status === "merged") return "merged"
  if (status === "discarded") return "discarded"
  return "waiting"
}

function syncBackgroundTask(record: ParallelWorkspaceRecord, log?: string) {
  if (!record.backgroundTaskId) return
  try {
    updateBackgroundTask(record.backgroundTaskId, {
      workspaceName: record.name,
      prompt: record.taskPrompt,
      provider: record.provider,
      model: record.model,
      projectPath: record.sourcePath,
      taskId: record.parentSessionId,
      workspaceId: record.id,
      status: backgroundStatus(record.status),
      progress: record.progress,
      currentStep: record.lastAction,
      changedFilesCount: record.changedFilesCount,
      terminalActive: record.status === "running commands",
      browserActive: record.status === "testing",
      costEstimate: record.estimatedCost,
      actualUsage: record.actualCost,
      errorSummary: record.error,
      mergeState: record.mergeState,
      log,
      action: {
        label: record.lastAction,
        status:
          record.status === "failed"
            ? "failed"
            : record.status === "needs review"
              ? "warning"
              : record.status === "merged" || record.status === "complete"
                ? "success"
                : backgroundStatus(record.status) === "running"
                  ? "running"
                  : "pending",
        detail: record.error || record.finalSummary,
      },
    })
  } catch {
    // Background tasks are an observability layer; workspace operations must not fail because
    // task metadata was cleared or migrated.
  }
}

function safeName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.slice(0, 42) || "workspace"
}

function withTimeout<T>(promise: Promise<T>, message: string, milliseconds = 25_000) {
  let timeout: NodeJS.Timeout | undefined
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function engineHeaders(engine: ParallelWorkspaceEngine) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (engine.username && engine.password) {
    headers.authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`
  }
  return headers
}

async function engineRequest<T>(
  engine: ParallelWorkspaceEngine,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const base = engine.url.endsWith("/") ? engine.url : `${engine.url}/`
  const response = await fetch(new URL(path.replace(/^\//, ""), base), {
    method: init.method ?? "GET",
    headers: engineHeaders(engine),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vector engine request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// Aborting a run's requests does not stop the model work the engine admitted, so Stop, Discard and a failed run
// interrupt the session too. Each waits at most 5 seconds for the engine to confirm, so an engine that never answers
// cannot hang them or a swarm waiting on its workers. The request itself is never cancelled: the engine's HTTP server
// interrupts a handler whose client disconnects, so a slow interrupt would be dropped and the session would keep
// spending after Stop. `note` hears when the engine did not confirm in time, and how the request ended.
export async function interruptEngineSession(
  engine: ParallelWorkspaceEngine,
  sessionId: string,
  note: (message: string) => void,
) {
  const answer = engineRequest(engine, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
  }).then(
    () => "",
    (error) =>
      `The engine did not confirm the interrupt, so the session may still be running: ${error instanceof Error ? error.message : String(error)}`,
  )
  const expired = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => expired.resolve(undefined), 5_000)
  const failure = await Promise.race([answer, expired.promise]).finally(() => clearTimeout(timer))
  if (failure) note(failure)
  if (failure !== undefined) return
  note("The engine had not confirmed the interrupt after 5 seconds. Vector is still waiting for it.")
  void answer.then((late) => note(late || "The engine confirmed the interrupt.")).catch(() => undefined)
}

// A workspace's interrupt notes go to its log, while the workspace still exists.
function logTo(id: string) {
  return (message: string) => {
    if (!readRecords().some((record) => record.id === id)) return
    updateRecord(id, (current) => ({ ...current, logs: [message, ...current.logs].slice(0, 120) }))
  }
}

function collectText(value: unknown, output: string[] = []) {
  if (!value) return output
  if (typeof value === "string") return output
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output)
    return output
  }
  if (typeof value !== "object") return output
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string" && record.text.trim()) output.push(record.text.trim())
  for (const item of Object.values(record)) collectText(item, output)
  return output
}

type EngineActiveSession = Record<string, unknown>

function sleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Parallel workspace run was canceled.", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new DOMException("Parallel workspace run was canceled.", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function activeSessionMap(value: unknown): Record<string, EngineActiveSession> {
  if (!value || typeof value !== "object") return {}
  const record = value as Record<string, unknown>
  const candidate = record.data && typeof record.data === "object" ? record.data : record
  return candidate as Record<string, EngineActiveSession>
}

async function refreshRunningWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  const { changedFiles, diff } =
    record.isolation === "git-worktree" ? await gitDiff(record) : await fallbackDiff(record)
  return updateRecord(id, (current) => ({
    ...current,
    changedFiles,
    diff,
    changedFilesCount: changedFiles.length,
    riskLevel: riskFromDiff(diff, changedFiles),
    lastActivityAt: now(),
  }))
}

// The engine going idle says the turn ended, not that it succeeded. A provider
// 429, an auth failure or a context overflow all end the turn with
// finish: "error", and without this the workspace was recorded as "complete
// with no file changes" — a green result for a run that never did anything,
// on exactly the unattended path the feature exists to protect.
// Both message shapes are accepted: v2 is flat, the legacy route wraps in `info`.
type EngineTurnMessage = {
  type?: string
  finish?: string
  error?: { message?: string; data?: { message?: string } } | string
  info?: { role?: string; finish?: string; error?: { message?: string; data?: { message?: string } } | string }
}

async function engineTurnFailure(
  sessionId: string,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
): Promise<string | undefined> {
  const last = await lastEngineAssistant(sessionId, engine, signal)
  if (!last) return undefined
  if (last.finish !== "error" && !last.error) return undefined
  if (typeof last.error === "string") return last.error
  return last.error?.data?.message ?? last.error?.message ?? "The agent's turn ended with an error."
}

async function lastEngineAssistant(sessionId: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const raw = await engineRequest<{ data?: EngineTurnMessage[] } | undefined>(
    engine,
    `/api/session/${encodeURIComponent(sessionId)}/message?limit=20`,
    { signal },
  ).catch(() => undefined)
  return (raw?.data ?? [])
    .map((item) => (item.info?.role === "assistant" ? item.info : item.type === "assistant" ? item : undefined))
    .filter(Boolean)
    .at(-1)
}

async function waitForEngineSessionIdle(
  id: string,
  sessionId: string,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  const startedAt = Date.now()
  const timeoutAt = startedAt + 30 * 60_000
  let observedBusy = false
  let idleSamples = 0
  let lastState = "starting"
  let lastDiffRefresh = 0

  while (Date.now() < timeoutAt) {
    if (signal.aborted) throw new DOMException("Parallel workspace run was canceled.", "AbortError")
    // Parallel Workspaces use the v2 session engine. The legacy
    // /session/status route only tracks v1 sessions and can report idle while
    // the v2 agent is still editing. /api/session/active is the authoritative
    // registry for the engine loop admitted by /api/session/:id/prompt.
    const raw = await engineRequest<unknown>(engine, "/api/session/active", { signal })
    const state = activeSessionMap(raw)[sessionId] ? "busy" : "idle"

    if (state !== "idle") {
      observedBusy = true
      idleSamples = 0
    } else {
      idleSamples += 1
      // Busy sessions disappear from /api/session/active when they become
      // idle. If the session was never observed busy, give the engine a real
      // grace window: under heavy concurrency the prompt can be durably
      // admitted seconds before the agent loop starts, and declaring "idle"
      // too early marks an untouched workspace complete while the agent later
      // edits it with nobody watching.
      if ((observedBusy && idleSamples >= 1) || (Date.now() - startedAt >= 20_000 && idleSamples >= 6)) return
    }

    if (state !== lastState) {
      lastState = state
      const label = state === "busy" ? "Agent is editing and running tools" : "Waiting for the isolated agent to start"
      const updated = updateRecord(id, (current) => ({
        ...current,
        status: "running commands",
        lastAction: label,
        lastActivityAt: now(),
        logs: [`Engine status changed to ${state}.`, ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(updated, label)
    }

    if (Date.now() - lastDiffRefresh >= 2_000) {
      lastDiffRefresh = Date.now()
      const updated = await refreshRunningWorkspace(id)
      syncBackgroundTask(updated)
    }
    await sleep(650, signal)
  }

  throw new Error("The isolated agent did not become idle within 30 minutes. Its files are preserved for review.")
}

const EXTERNAL_RUNTIME_RULES_POLICY =
  "Read .vector/RULES.md when present before making changes. It is authoritative for this repository, including teammate-authored content outside Vector's managed rules block."

function parallelAgentPrompt(record: ParallelWorkspaceRecord) {
  const contextPack = record.contextFiles?.length
    ? [
        record.contextSummary || `Vector indexed ${record.contextIndexedFiles ?? 0} source files locally.`,
        `Inspect these task-relevant files first (about ${(record.contextTokenEstimate ?? 0).toLocaleString()} tokens if all are read):`,
        ...record.contextFiles.map((file) => `- ${file}`),
        "Expand beyond this context pack only when imports, references, or validation failures prove another file is relevant.",
      ].join("\n")
    : "Use repository search to identify the smallest relevant context before reading large files."
  return [
    record.swarmRunId
      ? `You are Vector's ${record.agent || "general"} worker inside an automatically orchestrated engineering swarm.`
      : "You are Vector's Parallel Workspace engineering agent.",
    `You are operating only inside this ${record.isolatedPath === record.sourcePath || teamForWorkspace(record.id)?.topology === "collaborative" ? "shared" : "isolated"} workspace: ${record.isolatedPath}`,
    record.isolatedPath === record.sourcePath
      ? "This workspace is the repository itself. Your edits apply directly; preserve other agents' and the user's changes."
      : `The repository at ${record.sourcePath} must remain untouched.`,
    record.teamId ? "Other teammates share this work. Coordinate overlapping edits and preserve their changes." : "",
    record.swarmTaskId ? `Swarm task ID: ${record.swarmTaskId}` : "",
    "Inspect the repository before editing. Make the smallest complete implementation that satisfies the task.",
    record.taskDifficulty === "complex"
      ? "Create a visible plan, parallelize independent exploration when useful, and validate each major phase before continuing."
      : "Keep a concise plan for the work and update it when evidence changes the approach.",
    "Use terminal tools when useful, run the most relevant available checks, and repair failures you introduce.",
    "Do not expose credentials or copy secrets into source files.",
    "Finish with a concise summary of changed files, validation performed, and any remaining risk.",
    EXTERNAL_RUNTIME_RULES_POLICY,
    // Memory no longer lives in the repository: two workspaces editing it conflicted on merge, and a commit took it off
    // the computer. Vector's own agents save what they learn with the memory tool, on this computer.
    "Do not add to .vector/BRAIN.md or BRAIN.md on your own; Vector keeps what it learns on this computer, outside the repository.",
    // Rules are keyed on the MAIN project path, not the isolated checkout: a
    // worktree lives under Vector's own directory and would match nothing. The
    // engine also loads .vector/RULES.md for Vector-runtime agents, but an
    // external CLI reads its own instruction files and never sees that one, so
    // the prompt is the only place the rules reliably reach every runtime.
    formatRulesForPrompt(repoRulesForPrompt(record.sourcePath, record.changedFiles)),
    // Same policy the composer injects, so turning the setting on covers
    // isolated agents too rather than only the session you are typing in.
    record.llmJudge ? "" : undefined,
    record.llmJudge ? VERIFIED_COMPLETION_POLICY : undefined,
    "",
    contextPack,
    "",
    `Mission: ${record.name}`,
    `Task: ${record.taskPrompt}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

// What a user's own coding agent is sent: the user's words first, as typed, then plain facts about the repository
// and nothing else. It runs as the user's own agent, so Vector gives it no role, persona, working style or completion
// policy, nothing Vector learned or remembers, and no messages from other agents (Vector's own agent keeps its brief,
// parallelAgentPrompt).
export function externalAgentPrompt(record: ParallelWorkspaceRecord, request = record.taskPrompt) {
  return [request, "", externalRepositoryContext(record)].join("\n")
}

// A follow-up the agent's CLI could not resume: the user's new words, then what the earlier turns left behind here.
export function externalContinuationPrompt(record: ParallelWorkspaceRecord, request: string) {
  return [
    request,
    "",
    "This continues earlier work in this folder, from a conversation that could not be resumed.",
    `The earlier request was: ${record.taskPrompt}`,
    record.finalSummary ? `The last reply was:\n${record.finalSummary}` : undefined,
    record.changedFiles.length
      ? `Files already changed here:\n${record.changedFiles.map((file) => `- ${file}`).join("\n")}`
      : "No files have been changed here yet.",
    "",
    externalRepositoryContext(record),
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

// The message "Try a fix" sends: the failed check's own output, which is what the user asks their agent to look at.
export function externalRepairRequest(report: WorkspaceValidationReport) {
  return [
    "This check failed after the changes in this folder. Please fix what makes it fail, then run it again.",
    "",
    report.failureSummary.slice(-6_000),
  ].join("\n")
}

const EXTERNAL_RULES_LINE =
  "This repository's rules are in .vector/RULES.md when that file exists. Read it before making changes."

function externalRepositoryContext(record: ParallelWorkspaceRecord) {
  const shared = record.isolatedPath === record.sourcePath || teamForWorkspace(record.id)?.topology === "collaborative"
  return [
    record.isolatedPath === record.sourcePath
      ? `This folder is the repository itself (${record.isolatedPath}): changes apply to it directly, and changes already in it may be the user's or another agent's, so keep them.`
      : `This folder is an isolated copy of the repository (${record.isolatedPath}).`,
    shared && record.isolatedPath !== record.sourcePath
      ? "Other agents work in this folder too, so keep changes that are not yours."
      : "",
    EXTERNAL_RULES_LINE,
    formatRulesForPrompt(repoRulesForPrompt(record.sourcePath, record.changedFiles)),
    record.contextFiles?.length
      ? `Files that look relevant to this request:\n${record.contextFiles.map((file) => `- ${file}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function validationLogLines(report: WorkspaceValidationReport) {
  if (!report.checks.length) return ["No repository checks were detected for this workspace."]
  return report.checks.flatMap((check) => {
    const command = [check.command, ...check.args].join(" ")
    const status = check.status === "passed" ? "PASS" : check.status === "failed" ? "FAIL" : "SKIP"
    return [`[${status}] $ ${command} (${check.durationMs}ms)`, check.output]
  })
}

function validationSummary(report: WorkspaceValidationReport) {
  if (!report.checks.length || !report.hadChecks) return "No runnable deterministic checks were available."
  const passed = report.checks.filter((check) => check.status === "passed").length
  const skipped = report.checks.filter((check) => check.status === "skipped").length
  if (report.passed)
    return `${passed} deterministic check${passed === 1 ? "" : "s"} passed${skipped ? `; ${skipped} skipped` : ""}.`
  const failed = report.checks.find((check) => check.status === "failed")
  return `${failed?.label || "A deterministic check"} failed after the isolated edit.`
}

// `report.passed` is computed as `failures.length === 0`, so it is vacuously
// true when no checks ran at all. Branching user-facing copy on it alone tells
// the user their work was verified when nothing was executed. Every status
// string routes through here so "nothing ran" can never render as "passed".
function checksOutcome(report: WorkspaceValidationReport) {
  if (!report.hadChecks || !report.checks.length) return "none" as const
  return report.passed ? ("passed" as const) : ("failed" as const)
}

function checksAction(report: WorkspaceValidationReport) {
  const outcome = checksOutcome(report)
  if (outcome === "none") return "No deterministic checks were available to run"
  return outcome === "passed" ? "Deterministic checks passed" : "Deterministic checks found a failure"
}

function reviewAction(report: WorkspaceValidationReport) {
  const outcome = checksOutcome(report)
  if (outcome === "none") return "Ready for review — no deterministic checks were available"
  return outcome === "passed"
    ? "Workspace is validated and ready for review"
    : "Workspace needs review: deterministic checks failed"
}

// Failure signatures are knowledge about the repository, not about this run, so
// they accumulate against the source project even though the checks ran in a
// throwaway worktree that is deleted on merge. Both paths are passed as roots
// so the same failure seen from either tree collapses to one signature.
// `repairDescription` is what the agent said it changed in the pass this run is
// verifying: a passing check turns it into the known repair for that signature.
// Only Vector's own agent's runs are remembered: a user's own coding agent's
// diff and words stay out of everything Vector learns from.
export async function rememberValidation(
  record: ParallelWorkspaceRecord,
  report: WorkspaceValidationReport,
  repairDescription = "",
) {
  if (ExternalAgent.excludedFromLearning(record)) return undefined
  return recordValidationRun(record.sourcePath, {
    report,
    changedFiles: record.changedFiles,
    diff: record.diff,
    roots: [record.isolatedPath, record.sourcePath],
    repairDescription,
  })
}

// core.quotePath defaults on, so git C-quotes any non-ASCII path — a file named
// café.txt comes back as "caf\303\251.txt". Every caller here parses these
// lists as literal paths, so a merge would list a name that does not exist,
// skip it in the review diff and the secret scan, and then throw ENOENT partway
// through — after `git apply` had already written to main. Disabling it once at
// the single chokepoint covers status, ls-files and diff --name-only together.
const GIT_PATH_CONFIG = ["-c", "core.quotePath=false"]

export function runGit(
  args: string[],
  cwd: string,
  options: { allowFailure?: boolean; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const allowFailure = options.allowFailure ?? false
  return withTimeout(
    new Promise<CommandResult>((resolve, reject) => {
      const child = execFile(
        "git",
        [...GIT_PATH_CONFIG, ...args],
        { cwd, env: untrustedChildEnvironment(process.env, options.env), maxBuffer: 96 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const result = { stdout: String(stdout), stderr: String(stderr), failed: Boolean(error) }
          if (error && !allowFailure) return reject(error)
          resolve(result)
        },
      )
      if (options.input !== undefined) {
        child.stdin?.write(options.input)
        child.stdin?.end()
      }
    }),
    `Git command timed out: git ${args.join(" ")}`,
  )
}

async function gitRoot(sourcePath: string) {
  const result = await runGit(["rev-parse", "--show-toplevel"], sourcePath, { allowFailure: true })
  const root = result.stdout.trim()
  return root || undefined
}

async function gitIsClean(sourcePath: string) {
  const result = await runGit(["status", "--porcelain"], sourcePath, { allowFailure: true })
  return !result.failed && result.stdout.trim().length === 0
}

// Only inject a throwaway identity when the repo has none, so a commit never
// overrides the user's own git config. Mirrors github.ts buildCommitArgs; kept
// local so parallel merges do not depend on the GitHub module's internals.
async function buildCommitArgs(projectPath: string, message: string): Promise<string[]> {
  const email = await runGit(["config", "user.email"], projectPath, { allowFailure: true })
  const hasEmail = !email.failed && email.stdout.trim().length > 0
  const identity = hasEmail ? [] : ["-c", "user.name=Vector", "-c", "user.email=noreply@vectordev.ai"]
  return [...identity, "commit", "-m", message]
}

function extension(file: string) {
  const dot = file.lastIndexOf(".")
  return dot === -1 ? "" : file.slice(dot).toLowerCase()
}

// Vector sets no agent cap, and a copy workspace duplicates the whole project,
// so many agents on an uncommitted tree can fill the disk. Warn only, never
// block: statfs fails on some filesystems, and the copy goes ahead either way.
const LOW_DISK_BYTES = 5 * 1024 ** 3

async function noteLowDisk(directory: string, logs: string[]) {
  try {
    const disk = await statfs(directory)
    const free = disk.bavail * disk.bsize
    if (free < LOW_DISK_BYTES) {
      logs.push(
        `Only ${(free / 1024 ** 3).toFixed(1)} GB of disk space is free; copying the repository for this agent may fill the disk.`,
      )
    }
  } catch {
    // This filesystem cannot report free space, so there is nothing to warn about.
  }
}

function riskFromDiff(diff: string, changedFiles: string[]) {
  const additions = (diff.match(/^\+/gm) ?? []).length
  const deletions = (diff.match(/^-/gm) ?? []).length
  if (changedFiles.length >= 12 || deletions > 400 || additions > 800) return "high"
  if (changedFiles.length >= 4 || deletions > 80 || additions > 180) return "medium"
  return "low"
}

async function textPreview(path: string) {
  const text = await readFile(path, "utf8").catch(() => "")
  return text.slice(0, 40_000)
}

function normalizeStatusLine(line: string) {
  const file = line.slice(3).trim()
  if (file.includes(" -> ")) return file.split(" -> ").pop()?.trim() ?? file
  return file
}

// External runtimes cannot accept a prompt while their CLI is running, so
// their queued messages are folded into the next prompt. Vector sessions use
// durable live admission below instead.
export function pendingTeammateDelivery(record: Pick<ParallelWorkspaceRecord, "id" | "name">, basePrompt: string) {
  const team = teamForWorkspace(record.id)
  if (!team) return { prompt: basePrompt, messageIds: [] }
  // Bound each external turn; unread messages remain durable for following turns.
  const pending = pendingTeamMessages(team.id, record.id).slice(0, 4)
  if (!pending.length) return { prompt: basePrompt, messageIds: [] }
  return {
    prompt: [formatDelivery(pending, record.name), basePrompt].filter(Boolean).join("\n\n"),
    messageIds: pending.map((message) => message.id),
  }
}

// Members of a shared workspace all write to one outbox, so each entry carries
// the sending session. Files are atomically claimed and every entry has a
// durable id, making a crash between routing and cleanup safe to replay.
export async function drainTeamOutbox(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const outbox = join(record.isolatedPath, ".vector", "team-outbox.jsonl")
  const existing = outboxDrains.get(outbox)
  if (existing) return existing
  const drain = (async () => {
    const directory = dirname(outbox)
    const prefix = `${basename(outbox)}.`
    const legacy = (await readDirectoryIfExists(directory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".processing"))
      .map((name) => join(directory, name))
    const processing = `${outbox}.${randomUUID()}.processing`
    const rotated = await rename(outbox, processing)
      .then(() => processing)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    const durableDirectory = join(record.isolatedPath, ".vector", "team-outbox")
    const durable = await Promise.all(
      (await readDirectoryIfExists(durableDirectory))
        .filter((name) => name.endsWith(".processing") || name.endsWith(".json"))
        .map(async (name) => {
          const source = join(durableDirectory, name)
          if (name.endsWith(".processing")) return source
          return rename(source, `${source}.processing`)
            .then(() => `${source}.processing`)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            })
        }),
    )
    const siblings = readRecords().filter((item) => team.memberIds.includes(item.id))
    const memberNames = Object.fromEntries(siblings.map((item) => [item.id, item.name]))
    for (const claimed of [
      ...new Set([
        ...legacy,
        ...(rotated ? [rotated] : []),
        ...durable.filter((path): path is string => Boolean(path)),
      ]),
    ].sort()) {
      const raw = await readFile(claimed, "utf8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        const entry = parseTeamOutboxEntry(line)
        if (!entry) continue
        // Attribute by session so a shared outbox routes to the right sender.
        const sender = siblings.find((item) => item.agentSessionId === entry.sessionID) ?? record
        const recipient = entry.to
          ? siblings.find((item) => item.name.toLowerCase() === entry.to!.trim().toLowerCase())
          : undefined
        postTeamMessage({
          messageId:
            entry.id ??
            createHash("sha256")
              .update(`${entry.sessionID ?? ""}\n${entry.to ?? ""}\n${entry.message}\n${entry.createdAt ?? ""}`)
              .digest("hex"),
          teamId: team.id,
          fromWorkspaceId: sender.id,
          fromName: sender.name,
          // Preserve an unknown requested recipient as an invalid id so the
          // router bounces it. Dropping it to undefined turns a typo into a
          // broadcast to the entire team.
          toWorkspaceId: entry.to ? (recipient?.id ?? `unknown:${entry.to.trim()}`) : undefined,
          text: entry.message,
          memberNames:
            entry.to && !recipient ? { ...memberNames, [`unknown:${entry.to.trim()}`]: entry.to.trim() } : memberNames,
        })
      }
      // If the process dies after routing but before this remove, replay is
      // harmless because every entry carries an id and appendMessage dedupes.
      await rm(claimed, { force: true })
    }
  })()
  outboxDrains.set(outbox, drain)
  try {
    await drain
  } finally {
    if (outboxDrains.get(outbox) === drain) outboxDrains.delete(outbox)
  }
}

const outboxDrains = new Map<string, Promise<void>>()

async function readDirectoryIfExists(directory: string) {
  return readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

function parseTeamOutboxEntry(line: string) {
  const value = (() => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      return undefined
    }
  })()
  if (!value || typeof value !== "object") return
  const message = Reflect.get(value, "message")
  const id = Reflect.get(value, "id")
  const to = Reflect.get(value, "to")
  const sessionID = Reflect.get(value, "sessionID")
  const createdAt = Reflect.get(value, "createdAt")
  if (typeof message !== "string" || !message.trim()) return
  if (id !== undefined && typeof id !== "string") return
  if (to !== undefined && typeof to !== "string") return
  if (sessionID !== undefined && typeof sessionID !== "string") return
  if (createdAt !== undefined && typeof createdAt !== "string") return
  return { id, to, message, sessionID, createdAt }
}

// Outboxes must be drained while members are running: everyone starts together,
// so no messages exist when the initial prompts are admitted. Active Vector
// sessions receive them through the durable prompt inbox; external runtimes
// keep them pending for their next turn.
const TEAM_SWEEP_INTERVAL_MS = 4_000
const teamSweeps = new Map<string, { timer: NodeJS.Timeout; runs: Set<string> }>()
const activeTeamSweeps = new Map<string, Promise<void>>()

function startTeamSweep(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const existing = teamSweeps.get(team.id)
  if (existing) {
    existing.runs.add(record.id)
    return
  }
  const timer = setInterval(() => {
    void sweepTeamOutboxes(team.id).catch((error) => console.warn("Unable to sweep teammate messages", error))
  }, TEAM_SWEEP_INTERVAL_MS)
  // A sweep must never hold the process open on its own.
  timer.unref?.()
  teamSweeps.set(team.id, { timer, runs: new Set([record.id]) })
}

function stopTeamSweep(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const sweep = teamSweeps.get(team.id)
  if (!sweep) return
  sweep.runs.delete(record.id)
  if (sweep.runs.size > 0) return
  clearInterval(sweep.timer)
  teamSweeps.delete(team.id)
}

// Routes whatever every member has written so far. Reading each member's outbox
// rather than only the one that just finished is what lets a message cross
// between two agents that are both still working.
export async function sweepTeamOutboxes(teamId: string) {
  const existing = activeTeamSweeps.get(teamId)
  if (existing) return existing
  const sweep = (async () => {
    const members = readRecords().filter((record) => teamForWorkspace(record.id)?.id === teamId)
    const drained = await Promise.allSettled(members.map((member) => drainTeamOutbox(member)))
    drained.forEach((result, index) => {
      if (result.status === "rejected") reportTeamDeliveryFailure(members[index]!, result.reason)
    })
    const delivered = await Promise.allSettled(
      members.map(async (member) => {
        const active = activeRuns.get(member.id)
        if (!active?.sessionId || !active.acceptsTeamMessages || member.runtime !== "vector") return
        await admitVectorPrompt(member, active, "", false)
      }),
    )
    delivered.forEach((result, index) => {
      if (result.status === "rejected") reportTeamDeliveryFailure(members[index]!, result.reason)
    })
  })()
  activeTeamSweeps.set(teamId, sweep)
  try {
    await sweep
  } finally {
    if (activeTeamSweeps.get(teamId) === sweep) activeTeamSweeps.delete(teamId)
  }
}

function reportTeamDeliveryFailure(record: ParallelWorkspaceRecord, error: unknown) {
  if (activeRuns.get(record.id)?.controller.signal.aborted) return
  const current = getParallelWorkspace(record.id)
  if (!current || current.mergeState !== "none") return
  const detail = `Teammate messages remain queued for retry: ${error instanceof Error ? error.message : String(error)}`
  if (current.logs?.includes(detail)) return
  updateRecord(record.id, (entry) => ({ ...entry, logs: [detail, ...(entry.logs ?? [])].slice(0, 120) }))
}

async function admitVectorPrompt(
  record: ParallelWorkspaceRecord,
  active: ActiveParallelRun,
  prompt: string,
  required = true,
) {
  if (!active.sessionId) throw new Error("Vector's isolated agent session is not ready.")
  const team = teamForWorkspace(record.id)
  const pending = team ? nextVectorTeammateDelivery(pendingTeamMessages(team.id, record.id)) : []
  if (!prompt && !pending.length && !required) return false
  const budgetUsd = await promptBudgetUsd(active, active.sessionId)
  if (budgetUsd !== undefined && budgetUsd <= 0) {
    // A teammate note can wait for a run that still has money; this one has none.
    if (!required) return false
    throw new Error(
      `Spend limit reached: this agent has spent the ${formatUsd(active.spend?.budgetUsd ?? 0)} of headroom it was given. Raise or clear the limit in Settings → Spend limits to continue.`,
    )
  }
  const text = [pending.length ? formatDelivery(pending, record.name) : "", prompt].filter(Boolean).join("\n\n")
  await engineRequest(active.engine, `/api/session/${encodeURIComponent(active.sessionId)}/prompt`, {
    method: "POST",
    // A response can be lost after the server durably admitted the input. The
    // same message id turns the next sweep into an exact retry instead of
    // delivering the teammate note twice.
    body: {
      id: vectorPromptMessageId(
        active.sessionId,
        text,
        pending.map((message) => message.id),
      ),
      prompt: { text },
      resume: true,
      budget: budgetUsd === undefined ? undefined : { usd: budgetUsd },
    },
    signal: active.controller.signal,
  })
  if (active.spend) active.spend.draining = true
  if (team && pending.length)
    markTeamMessagesDelivered(
      team.id,
      record.id,
      pending.map((message) => message.id),
    )
  return true
}

// Keep the retry identity stable if another teammate message arrives after a
// server admitted this prompt but before its response reached the desktop.
// The next sweep sends the next oldest message after this one is acknowledged.
export function nextVectorTeammateDelivery(pending: readonly TeamMessage[]) {
  return pending.slice(0, 1)
}

export function vectorPromptMessageId(sessionId: string, prompt: string, teammateMessageIds: readonly string[]) {
  return `msg_vector_${createHash("sha256")
    .update(`${sessionId}\n${teammateMessageIds.join("\n")}\n${prompt}`)
    .digest("hex")}`
}

// Broadcasts what this agent just did so teammates sharing the workspace can
// adapt instead of rediscovering it from the diff.
function broadcastHandoff(record: ParallelWorkspaceRecord, summary: string) {
  const team = teamForWorkspace(record.id)
  if (!team || team.memberIds.length < 2) return
  postTeamMessage({
    teamId: team.id,
    fromWorkspaceId: record.id,
    fromName: record.name,
    text: formatHandoff(record.name, summary, record.changedFiles),
  })
}

async function fallbackDiff(record: ParallelWorkspaceRecord) {
  // A copy has no Git base to diff against. Until its immutable hash snapshot
  // exists, treating every missing hash as a missing file makes the whole
  // project appear newly added. Creation now records the snapshot before the
  // workspace becomes visible, while this guard keeps older persisted records
  // and interrupted migrations from ever exposing that false massive diff.
  if (record.baselineHashes === undefined) return { changedFiles: [], diff: "" }
  const sourceFiles = await listProjectFiles(record.sourcePath)
  const isolatedFiles = await listProjectFiles(record.isolatedPath)
  const allFiles = Array.from(new Set([...sourceFiles, ...isolatedFiles]))
    .filter((file) => !isInternalWorkspaceFile(file))
    .sort()
  const changedFiles: string[] = []
  const blocks: string[] = []

  for (const file of allFiles) {
    const before = record.baselineHashes?.[file] ?? "missing"
    const isolatedPath = join(record.isolatedPath, file)
    const isolatedHash = await hashFile(isolatedPath).catch(() => "missing")
    if (before === isolatedHash) continue
    changedFiles.push(file)
    const ext = extension(file)
    blocks.push(`diff --vector a/${file} b/${file}`)
    if (!TEXT_EXTENSIONS.has(ext)) {
      blocks.push("Binary or large file changed.")
      continue
    }
    const sourceText = await textPreview(join(record.sourcePath, file))
    const isolatedText = await textPreview(isolatedPath)
    blocks.push(`--- a/${file}`)
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(
      sourceText
        ? sourceText
            .split("\n")
            .slice(0, 80)
            .map((line) => `- ${line}`)
            .join("\n")
        : "- <missing>",
    )
    blocks.push(
      isolatedText
        ? isolatedText
            .split("\n")
            .slice(0, 120)
            .map((line) => `+ ${line}`)
            .join("\n")
        : "+ <deleted>",
    )
  }

  return { changedFiles, diff: blocks.join("\n") }
}

// Vector's own coordination files live inside the workspace because the engine
// resolves them relative to the agent's working directory. They are bookkeeping,
// not the agent's work, so they never belong in a diff or a merge.
// .vector/BRAIN.md is deliberately NOT here: durable project memory is
// something the user may legitimately want to keep.
const INTERNAL_WORKSPACE_FILES = new Set([
  join(".vector", "team.json").replaceAll("\\", "/"),
  join(".vector", "team-outbox.jsonl").replaceAll("\\", "/"),
])

export function isInternalWorkspaceFile(file: string) {
  const normalized = file.replaceAll("\\", "/")
  return (
    INTERNAL_WORKSPACE_FILES.has(normalized) ||
    normalized.startsWith(".vector/team-outbox/") ||
    normalized.startsWith(".vector/team-outbox.jsonl.")
  )
}

async function gitDiff(record: ParallelWorkspaceRecord) {
  // -uall lists untracked files individually. Without it git collapses a new
  // directory to a single "dir/" entry, which both hid every file in a newly
  // created directory from the review diff (textPreview cannot read a
  // directory) and made per-file exclusions impossible to apply.
  const status = await runGit(["status", "--porcelain", "-uall"], record.isolatedPath, { allowFailure: true })
  const untrackedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("??"))
    .map(normalizeStatusLine)
    .filter(Boolean)
    .filter((file) => !isInternalWorkspaceFile(file))
  const baseCommit = record.baseCommit ?? "HEAD"
  const trackedFiles = await runGit(["diff", "--name-only", baseCommit, "--"], record.isolatedPath, {
    allowFailure: true,
  })
  const changedFiles = [
    ...new Set([
      ...trackedFiles.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => !isInternalWorkspaceFile(file)),
      ...untrackedFiles,
    ]),
  ]
  const diff = await runGit(["diff", "--no-ext-diff", "--binary", baseCommit, "--"], record.isolatedPath, {
    allowFailure: true,
  })
  const blocks = [diff.stdout.trim()]
  for (const file of untrackedFiles) {
    const fullPath = join(record.isolatedPath, file)
    if (!TEXT_EXTENSIONS.has(extension(file))) continue
    const text = await textPreview(fullPath)
    if (!text) continue
    blocks.push(`diff --git a/${file} b/${file}`)
    blocks.push("new file mode 100644")
    blocks.push("--- /dev/null")
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(
      text
        .split("\n")
        .slice(0, 300)
        .map((line) => `+${line}`)
        .join("\n"),
    )
  }
  return { changedFiles, diff: blocks.filter(Boolean).join("\n") }
}

// Build a unified diff of the MAIN project's working tree against HEAD, in the
// same header format ParallelDiffReview/parseUnifiedDiff already parse. Mirrors
// gitDiff() but runs against sourcePath with base HEAD so the review UI can show
// "Main" and "Side-by-side" columns. Returns "" when sourcePath is not a git
// repository (read-only; never mutates the tree).
export async function mainWorkingTreeDiff(sourcePath: string): Promise<string> {
  if (!(await gitRoot(sourcePath))) return ""
  // -uall for the same reason as gitDiff: a collapsed "dir/" entry cannot be
  // read by textPreview, so new directories would silently show no changes.
  const status = await runGit(["status", "--porcelain", "-uall"], sourcePath, { allowFailure: true })
  const untrackedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("??"))
    .map(normalizeStatusLine)
    .filter(Boolean)
  const diff = await runGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], sourcePath, {
    allowFailure: true,
  })
  const blocks = [diff.stdout.trim()]
  for (const file of untrackedFiles) {
    const fullPath = join(sourcePath, file)
    if (!TEXT_EXTENSIONS.has(extension(file))) continue
    const text = await textPreview(fullPath)
    if (!text) continue
    blocks.push(`diff --git a/${file} b/${file}`)
    blocks.push("new file mode 100644")
    blocks.push("--- /dev/null")
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(
      text
        .split("\n")
        .slice(0, 300)
        .map((line) => `+${line}`)
        .join("\n"),
    )
  }
  return blocks.filter(Boolean).join("\n")
}

export async function refreshParallelWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  // Merged/discarded workspaces had their isolated checkout cleaned up; a
  // refresh would re-diff a missing directory and wipe the recorded history.
  if (record.mergeState !== "none") return record
  if (!(await stat(record.isolatedPath).catch(() => undefined))) return record
  const { changedFiles, diff } =
    record.isolation === "git-worktree" ? await gitDiff(record) : await fallbackDiff(record)
  const riskLevel = riskFromDiff(diff, changedFiles)
  // Polling unchanged swarm workspaces must not advance their revision or rebuild every workspace view.
  if (
    record.diff === diff &&
    record.riskLevel === riskLevel &&
    record.changedFilesCount === changedFiles.length &&
    JSON.stringify(record.changedFiles) === JSON.stringify(changedFiles) &&
    (activeRuns.has(id) || queuedRuns.has(id) || !changedFiles.length || record.status === "needs review")
  )
    return record
  const updated = updateRecord(id, (current) => ({
    ...current,
    changedFiles,
    diff,
    changedFilesCount: changedFiles.length,
    riskLevel,
    lastActivityAt: now(),
    lastAction: changedFiles.length
      ? `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} detected`
      : "No isolated changes yet",
    // A refresh during a live turn must not flip the record to "needs review"
    // under the running agent: the mission path already refreshed mid-run, and
    // a follow-up refreshes mid-turn too, which made the churn visible.
    status:
      current.mergeState !== "none" || activeRuns.has(id) || queuedRuns.has(id)
        ? current.status
        : changedFiles.length
          ? "needs review"
          : current.status,
  }))
  syncBackgroundTask(updated)
  return updated
}

export function listParallelWorkspaces(scope?: { sourcePath?: string; parentSessionId?: string }) {
  const records = readRecords()
  let changed = false
  const next = records.map((record) => {
    const wasRunning =
      RUNNING_STATUSES.includes(record.status) ||
      (record.status === "queued" && Boolean(record.runOwnerID) && record.runOwnerID !== PROCESS_ID)
    if (!wasRunning || activeRuns.has(record.id) || queuedRuns.has(record.id)) return record
    changed = true
    const interrupted: ParallelWorkspaceRecord = {
      ...record,
      revision: (record.revision ?? 0) + 1,
      status: "failed",
      progress: 0,
      lastAction: "Interrupted by app restart",
      lastActivityAt: now(),
      error:
        "This agent stopped when Vector closed. Review the isolated files, then run the workspace again if needed.",
      finalSummary: "The previous run was interrupted before Vector received a completion signal.",
      turns: settleRunningTurns(record.turns, { state: "failed", text: "This turn stopped when Vector closed." }),
      logs: ["Vector detected an interrupted agent run after restart.", ...record.logs].slice(0, 120),
    }
    syncBackgroundTask(interrupted, "Interrupted run detected after Vector restarted.")
    return interrupted
  })
  if (changed) writeRecords(next)
  next
    .filter((record) => record.cleanupPending && !finishingMerges.has(record.id))
    .forEach((record) => void finishInterruptedMerge(record))
  if (!scope) return next
  return next.filter((record) => {
    if (scope.sourcePath && record.sourcePath !== scope.sourcePath) return false
    if ("parentSessionId" in scope && record.parentSessionId !== scope.parentSessionId) return false
    return true
  })
}

// Cloud actions an agent takes from its isolated workspace belong to the
// project the workspace was created from (see cloud-scope.ts).
export function parallelWorkspaceCloudScopes() {
  return readRecords().map((record) => ({
    id: record.id,
    name: record.name,
    sourcePath: record.sourcePath,
    isolatedPath: record.isolatedPath,
  }))
}

// Called when a preview of this workspace's worktree is published, from the
// Cloud console or by the workspace's own agent.
export function recordParallelWorkspacePreview(id: string, url: string) {
  if (!readRecords().some((record) => record.id === id)) return
  updateRecord(id, (current) => ({
    ...current,
    previewUrl: url,
    lastActivityAt: now(),
    logs: [`Published a preview: ${url}`, ...current.logs].slice(0, 120),
  }))
}

export function getParallelWorkspace(id: string) {
  return readRecords().find((record) => record.id === id)
}

export async function createParallelWorkspace(input: CreateParallelWorkspaceInput) {
  if (!input.parentSessionId) {
    throw new Error("Open a task session before creating an isolated agent workspace.")
  }
  const sourceStat = await stat(input.sourcePath).catch(() => undefined)
  if (!sourceStat?.isDirectory())
    throw new Error("Choose a valid repository folder before creating a parallel workspace.")

  const createdAt = now()
  const id = randomUUID()
  const sourceRoot = (await gitRoot(input.sourcePath)) ?? input.sourcePath
  const activeInScope = readRecords().filter(
    (record) =>
      record.sourcePath === sourceRoot &&
      record.parentSessionId === input.parentSessionId &&
      record.swarmRole !== "coordinator" &&
      record.mergeState === "none" &&
      !["failed", "stopped", "complete"].includes(record.status),
  )
  const root = workspaceRoot()
  const workspaceDir = join(root, id)
  let isolatedPath = join(workspaceDir, "workspace")
  const taskDifficulty = classifyTaskDifficulty(input.taskPrompt)
  const runtime = input.runtime ?? "vector"
  // A terminal-only agent opens in the built-in terminal instead; only a chat runtime can run here.
  if (runtime !== "vector" && !ExternalAgent.isChatId(runtime)) throw new Error("Choose a runtime Vector can run here.")
  // The user's own agent runs only when that user starts it: never as a worker an orchestrator schedules.
  if (runtime !== "vector" && (input.swarmRunId || input.swarmTaskId || input.swarmRole))
    throw new Error(
      `${runtimeLabel(runtime)} runs only when you start it, so it cannot work in a swarm. Swarms run Vector's own agent.`,
    )
  if (runtime !== "vector" && (await ownAgentsRunning()) >= ExternalAgent.MAX_RUNNING)
    throw new Error(ExternalAgent.RUN_LIMIT_MESSAGE)
  // A Vector-runtime agent is measured by the engine, so it shows no guess.
  const estimatedCost = runtime === "vector" ? "" : "Reported by runtime when available"
  const name = input.name?.trim() || `Agent ${activeInScope.length + 1}`
  const runtimeName = runtimeLabel(runtime)
  const provider = runtime === "vector" ? input.provider?.trim() || "Current Vector provider" : runtimeName
  const runtimeModel = runtime === "vector" ? undefined : externalModelValue(input.runtimeModel)
  const model =
    runtime === "vector" ? input.model?.trim() || "Current selected model" : (runtimeModel ?? RUNTIME_DEFAULT_MODEL)

  let isolation: ParallelWorkspaceRecord["isolation"] = "copy"
  let gitBranch: string | undefined
  let baseCommit: string | undefined
  const logs: string[] = []
  // Working and queued agents compete for the CPU (a comparison creates every
  // record before it runs any of them); results waiting for review don't.
  // activeInScope still names the new agent above.
  const cores = availableParallelism()
  const working =
    activeInScope.filter((record) => record.status === "queued" || RUNNING_STATUSES.includes(record.status)).length + 1
  if (working > cores) {
    logs.push(
      `${working} agents are working in this task on a ${cores}-core machine; builds and tests may wait for CPU.`,
    )
  }

  // A collaborative member joins an existing tree rather than getting its own,
  // which is the point of the topology: teammates see each other's edits as
  // they happen instead of at merge time. Skip worktree creation entirely and
  // adopt the shared checkout.
  const joinShared = Boolean(input.sharedPath)
  if (input.sharedPath) {
    isolatedPath = input.sharedPath
    isolation = input.sharedPath === sourceRoot ? "copy" : "git-worktree"
    baseCommit =
      (await runGit(["rev-parse", "HEAD"], input.sharedPath, { allowFailure: true })).stdout.trim() || undefined
    logs.push(`Joined the shared workspace at ${input.sharedPath}.`)
  }

  await mkdir(workspaceDir, { recursive: true })
  const rootGit = await gitRoot(sourceRoot)
  if (joinShared) {
    // Nothing to provision: the tree already exists and teammates are in it.
  } else if (rootGit && (await gitIsClean(sourceRoot))) {
    baseCommit = (await runGit(["rev-parse", "HEAD"], sourceRoot, { allowFailure: true })).stdout.trim() || undefined
    gitBranch = `vector-parallel/${safeName(name)}-${id.slice(0, 8)}`
    try {
      await runGit(["worktree", "add", "-b", gitBranch, isolatedPath, "HEAD"], sourceRoot)
      isolation = "git-worktree"
      logs.push(`Created git worktree on ${gitBranch}.`)
    } catch (error) {
      logs.push(`Git worktree failed, using isolated copy: ${error instanceof Error ? error.message : String(error)}`)
      await noteLowDisk(workspaceDir, logs)
      await copyProject(sourceRoot, isolatedPath)
    }
  } else {
    logs.push(
      rootGit
        ? "The repository has uncommitted changes, using isolated copy to preserve current state."
        : "No git repository found, using isolated copy.",
    )
    await noteLowDisk(workspaceDir, logs)
    await copyProject(sourceRoot, isolatedPath)
  }

  // Written only after provisioning: `git worktree add` refuses a target
  // directory that already has anything in it, so creating this marker first
  // made worktree creation fail for the first member of every team and
  // silently drop it into an unisolated copy.
  //
  // The engine-side tool checks for this marker before offering to message a
  // teammate, so an agent working alone is never told a message was queued.
  if (input.teamId) {
    await mkdir(join(isolatedPath, ".vector"), { recursive: true }).catch(() => undefined)
    await writeFile(
      join(isolatedPath, ".vector", "team.json"),
      JSON.stringify({ teamId: input.teamId, workspaceId: id, name }, null, 2),
      "utf8",
    ).catch(() => undefined)
  }

  // Copy workspaces have no commit to serve as their immutable comparison
  // base. Persist the copied tree's hashes before publishing the record so a
  // renderer refresh can never race the lazy run preparation and classify
  // every file as newly added. Hash the isolated tree (not sourceRoot): the
  // source can keep changing while provisioning, but this exact snapshot is
  // what the agent receives and what merge conflict checks must compare.
  const baselineHashes = isolation === "copy" ? await hashProject(isolatedPath) : undefined

  await mkdir(join(workspaceDir, "metadata"), { recursive: true })
  await writeFile(
    join(workspaceDir, "metadata", "task.md"),
    [
      `# ${name}`,
      "",
      `Created: ${createdAt}`,
      `Runtime: ${runtimeName}`,
      `Provider: ${provider}`,
      `Model: ${model}`,
      "",
      "## Task",
      input.taskPrompt.trim() || "No task prompt provided.",
      "",
      "This workspace is isolated. Open it in Vector to run the agent. Merge when the result is ready.",
      "",
    ].join("\n"),
    "utf8",
  )

  const backgroundTask =
    input.swarmRole === "coordinator"
      ? undefined
      : createBackgroundTask({
          kind: "parallel-workspace",
          projectPath: sourceRoot,
          taskId: input.parentSessionId,
          workspaceId: id,
          workspaceName: name,
          name,
          prompt: input.taskPrompt.trim(),
          provider,
          model,
          status: "queued",
          progress: 0,
          currentStep: "Isolated workspace created",
          changedFilesCount: 0,
          terminalActive: false,
          browserActive: false,
          costEstimate: estimatedCost,
          mergeState: "none",
          logs: [`Created isolated workspace at ${isolatedPath}.`, ...logs],
        })

  const record: ParallelWorkspaceRecord = {
    id,
    revision: 0,
    name,
    taskPrompt: input.taskPrompt.trim(),
    runtime,
    provider,
    model,
    runtimeModel,
    sourcePath: sourceRoot,
    parentSessionId: input.parentSessionId,
    engineParentSessionId: input.engineParentSessionId,
    isolatedPath,
    isolation,
    gitBranch,
    baseCommit,
    backgroundTaskId: backgroundTask?.id,
    agent: input.agent,
    swarmRunId: input.swarmRunId,
    swarmTaskId: input.swarmTaskId,
    swarmRole: input.swarmRole,
    teamId: input.teamId,
    llmJudge: input.llmJudge === true,
    status: "queued",
    runOwnerID: PROCESS_ID,
    stopReason: undefined,
    progress: 0,
    lastAction: "Isolated workspace created",
    createdAt,
    lastActivityAt: createdAt,
    changedFilesCount: 0,
    riskLevel: "low",
    estimatedCost,
    finalSummary: "Workspace is ready. Open it to run an isolated agent session, then review the diff before merging.",
    mergeState: "none",
    logs,
    terminalOutput: [],
    browserResults: [],
    changedFiles: [],
    diff: "",
    baselineHashes,
    taskDifficulty,
    // Vector's own agent repairs a failed check by itself; the user's own agent only when the user chooses Try a fix.
    retryLimit: runtime !== "vector" ? 0 : taskDifficulty === "complex" ? 2 : taskDifficulty === "trivial" ? 0 : 1,
    repairAttempts: 0,
    ...(runtime !== "vector" ? { excludedFromLearning: true } : {}),
  }
  writeRecords([record, ...readRecords()])
  return record
}

async function ensureParallelWorkspaceIsolation(record: ParallelWorkspaceRecord) {
  const isolated = await stat(record.isolatedPath).catch(() => undefined)
  if (isolated?.isDirectory()) return record
  const source = await stat(record.sourcePath).catch(() => undefined)
  if (!source?.isDirectory()) {
    throw new Error(
      "The repository folder no longer exists. Open the repository again before rerunning this workspace.",
    )
  }

  await rm(dirname(record.isolatedPath), { recursive: true, force: true }).catch(() => undefined)
  await copyProject(record.sourcePath, record.isolatedPath)
  const baselineHashes = await hashProject(record.isolatedPath)
  const restored = updateRecord(record.id, (current) => ({
    ...current,
    isolation: "copy",
    gitBranch: undefined,
    baseCommit: undefined,
    baselineHashes,
    changedFiles: [],
    changedFilesCount: 0,
    diff: "",
    progress: 0,
    error: undefined,
    lastAction: "Rebuilt interrupted isolated workspace",
    lastActivityAt: now(),
    // The rebuilt tree has none of the prior edits, and claude's resume is
    // scoped to the cwd it was created in — resuming here would hand the agent
    // a transcript describing files that no longer exist.
    externalSessionId: undefined,
    turns: appendTurn(current.turns, {
      id: randomUUID(),
      role: "vector",
      text: "The isolated workspace was missing, so Vector rebuilt it from the repository. The previous conversation could not be carried over.",
      at: now(),
      state: "done",
    }),
    logs: [
      "The isolated checkout was missing, so Vector rebuilt it from the repository before starting the agent.",
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(restored, "Rebuilt the missing isolated workspace from the repository.")
  return restored
}

async function prepareParallelWorkspaceContext(record: ParallelWorkspaceRecord) {
  const needsBaseline = record.isolation === "copy" && record.baselineHashes === undefined
  const needsContext = record.taskDifficulty !== "trivial" && record.contextIndexedFiles === undefined
  if (!needsBaseline && !needsContext) return record

  const [baselineHashes, contextPack] = await Promise.all([
    needsBaseline ? hashProject(record.isolatedPath) : Promise.resolve(record.baselineHashes),
    needsContext
      ? createContextBudgetPack(
          record.isolatedPath,
          record.taskPrompt,
          contextBudgetForDifficulty(record.taskDifficulty ?? "standard"),
        ).catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  const contextTokens = contextPack?.estimatedTokens ?? record.contextTokenEstimate
  const updated = updateRecord(record.id, (current) => ({
    ...current,
    baselineHashes,
    estimatedCost: current.runtime === "vector" ? "" : current.estimatedCost,
    contextFiles: contextPack?.files.map((file) => file.path) ?? current.contextFiles,
    contextIndexedFiles: contextPack?.indexedFileCount ?? current.contextIndexedFiles,
    contextTokenEstimate: contextTokens,
    contextSummary: contextPack ? formatContextBudgetForAgent(contextPack).split("\n")[0] : current.contextSummary,
    logs: contextPack
      ? [
          `Context budget selected ${contextPack.selectedFileCount} of ${contextPack.indexedFileCount} indexed files (~${contextPack.estimatedTokens.toLocaleString()} tokens).`,
          ...current.logs,
        ].slice(0, 120)
      : current.logs,
    lastActivityAt: now(),
  }))
  syncBackgroundTask(updated, "Task-specific context is ready in the isolated workspace.")
  return updated
}

async function runExternalWorkspacePass(input: {
  id: string
  record: ParallelWorkspaceRecord
  prompt: string
  controller: AbortController
  turnId: string
  resumeSessionId?: string
  // Read once when the turn starts, so a model picked while it runs waits for
  // the next turn instead of switching between this turn's passes.
  model?: string
  runner?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult>
}) {
  input.controller.signal.throwIfAborted()
  const pendingLogs: string[] = []
  const pendingOutput: string[] = []
  let pendingChat: AgentChat | undefined
  let lastPersistedAt = 0
  let flushTimer: NodeJS.Timeout | undefined
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (!pendingLogs.length && !pendingOutput.length && !pendingChat) return
    const logs = pendingLogs.splice(0)
    const output = pendingOutput.splice(0)
    const chat = pendingChat
    pendingChat = undefined
    const updated = updateRecord(input.id, (current) => ({
      ...current,
      status: "running commands",
      progress: 0,
      // Name the step in progress ("Thinking" as soon as codex starts a turn),
      // else the last tool step; a finished "Thinking" never lingers as the label.
      // A flush that carries only stderr keeps the current label instead of
      // flickering to the generic one.
      lastAction: chat
        ? (chat.activity.findLast((entry) => entry.state === "running")?.label ??
          chat.activity.findLast((entry) => entry.kind === "tool")?.label ??
          "Working on your request")
        : current.lastAction,
      lastActivityAt: now(),
      // Runs before the reversals below: `logs` is a live array and .reverse()
      // mutates in place, which would make the transcript read backwards.
      turns: chat ? updateTurnChat(current.turns, input.turnId, chat) : current.turns,
      logs: [...[...logs].reverse(), ...current.logs].slice(0, 120),
      terminalOutput: [...[...output].reverse(), ...current.terminalOutput].slice(0, 240),
    }))
    // Measure the quiet period from the END of the synchronous store write.
    // With a large legacy store, measuring from its start made every queued
    // stdout line immediately eligible for another full-file rewrite.
    lastPersistedAt = Date.now()
    syncBackgroundTask(updated, updated.lastAction)
  }
  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, Math.max(0, 400 - (Date.now() - lastPersistedAt)))
    flushTimer.unref?.()
  }

  const result = await (input.runner ?? runExternalCodingAgent)({
    runtime: input.record.runtime as CodingAgentRuntime,
    cwd: input.record.isolatedPath,
    prompt: input.prompt,
    resumeSessionId: input.resumeSessionId,
    model: input.model,
    signal: input.controller.signal,
    // Persisted the moment it appears rather than at close: a crash or a user
    // stop mid-turn must still leave a resumable conversation behind.
    onSessionId: (sessionId) => {
      updateRecord(input.id, (current) => ({ ...current, externalSessionId: sessionId }))
    },
    onEvent: (event) => {
      if (event.stream === "activity") pendingLogs.push(event.text)
      if (event.stream !== "activity") pendingOutput.push(event.text)
      scheduleFlush()
    },
    onChat: (chat) => {
      pendingChat = chat
      scheduleFlush()
    },
  }).finally(flush)
  input.controller.signal.throwIfAborted()
  // A refused model fails the turn with the CLI's own error, and the picker
  // goes back to the CLI's default, unless the user already chose another.
  // Retrying on another model would spend on one nobody picked. The refusal is
  // kept either way, so the app stops starting new agents on that model.
  const refused = result.modelRejected ? input.model : undefined
  if (refused && getParallelWorkspace(input.id)) {
    updateRecord(input.id, (current) => {
      const refusedRuntimeModel = { model: refused, at: now() }
      if (current.runtimeModel !== refused) return { ...current, refusedRuntimeModel }
      return {
        ...current,
        refusedRuntimeModel,
        runtimeModel: undefined,
        model: RUNTIME_DEFAULT_MODEL,
        logs: [
          `${runtimeLabel(current.runtime)} would not run the model "${refused}", so the next turn uses its default model.`,
          ...current.logs,
        ].slice(0, 120),
      }
    })
  }
  // A rejected resume still spends one user action. Clear it for the next explicit send, without spawning another
  // process now. Keep the CLI's error intact so the user can decide whether to continue.
  if (result.resumeRejected && !result.modelRejected) {
    updateRecord(input.id, (current) => ({
      ...current,
      externalSessionId: undefined,
      turns: (current.turns ?? []).map((turn) => (turn.id === input.turnId ? { ...turn, resumed: false } : turn)),
      logs: [
        `${runtimeLabel(current.runtime)} could not resume. Your next message starts a new conversation with a summary of the earlier work.`,
        ...current.logs,
      ].slice(0, 120),
    }))
  }
  if (result.exitCode !== 0) {
    // agentOutcome already classified this failure — "installed but not signed
    // in", "exited with code N" — and that sentence is the only part the user
    // can act on. Throwing the raw stream-json tail instead buried it, so a
    // signed-out CLI read as "Vector is broken" rather than "run `claude`".
    throw new Error(
      result.error?.trim() ||
        `${runtimeLabel(input.record.runtime)} could not complete this request. See diagnostics for details.`,
    )
  }
  return result
}

async function executeExternalParallelWorkspace(
  id: string,
  initial: ParallelWorkspaceRecord,
  controller: AbortController,
  runId: string,
  followUp?: string,
  runner?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult>,
) {
  const resumeSessionId = followUp ? initial.externalSessionId : undefined
  const turnId = randomUUID()
  let record = updateRecord(id, (current) => ({
    ...current,
    agentSessionId: undefined,
    // A fresh run is a NEW conversation; a follow-up must keep the id or it
    // restarts from nothing instead of resuming.
    externalSessionId: followUp ? current.externalSessionId : undefined,
    status: "editing",
    progress: 0,
    lastAction: followUp
      ? `${runtimeLabel(current.runtime)} is working on your message`
      : `${runtimeLabel(current.runtime)} is inspecting the agent workspace`,
    lastActivityAt: now(),
    error: undefined,
    turns: followUp
      ? appendTurn(current.turns, {
          id: turnId,
          role: "agent",
          text: "",
          at: now(),
          state: "running",
          resumed: Boolean(resumeSessionId),
        })
      : [
          { id: randomUUID(), role: "user", text: current.taskPrompt, at: now(), state: "done" },
          { id: turnId, role: "agent", text: "", at: now(), state: "running", resumed: false },
        ],
    logs: [
      followUp
        ? resumeSessionId
          ? `${runtimeLabel(current.runtime)} resumed its existing conversation.`
          : `${runtimeLabel(current.runtime)} could not resume, so the follow-up restates the task.`
        : `${runtimeLabel(current.runtime)} started in ${current.isolatedPath}.`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(record, record.lastAction)
  // The turn runs the model it started with; a model picked meanwhile applies from the next turn.
  const model = record.runtimeModel

  const costs: number[] = []
  // Recompute rather than trusting the renderer's last persisted refresh. It
  // closes the migration edge where an older app already stored a false
  // all-files diff before the baseline became available.
  const beforeDiff = (record.isolation === "git-worktree" ? await gitDiff(record) : await fallbackDiff(record)).diff
  // Every prompt is the user's own words and plain repository facts (externalAgentPrompt). Teammates' messages stay
  // out: an agent another person steers could otherwise reach the user's own agent through them. A resumed CLI
  // already holds the conversation, so it gets the new words and the rules line, which may have changed since.
  const firstRun = await runExternalWorkspacePass({
    id,
    record,
    turnId,
    controller,
    resumeSessionId,
    model,
    runner,
    prompt: !followUp
      ? externalAgentPrompt(record)
      : resumeSessionId
        ? [followUp, "", EXTERNAL_RULES_LINE].join("\n")
        : externalContinuationPrompt(record, followUp),
  })

  if (firstRun.actualCost) costs.push(Number(firstRun.actualCost.replace("$", "")))

  record = updateRecord(id, (current) => ({
    ...current,
    turns: settleTurn(current.turns, turnId, {
      text: firstRun.summary,
      state: "done",
      cost: firstRun.actualCost,
      notices: firstRun.notices,
    }),
  }))

  // External turns are allowed to inspect or answer without editing. The same
  // rule applies to the first mission and to follow-ups: deterministic checks
  // validate an edit, so running a whole repository suite after a read-only
  // turn can manufacture an unrelated failure. Compare the complete review diff
  // from immediately before and after this turn so an unchanged pre-existing
  // follow-up diff is preserved as well.
  const answered = await refreshParallelWorkspace(id)
  if (answered.diff === beforeDiff) {
    const measuredCosts = costs.filter(Number.isFinite)
    const totalCost = measuredCosts.reduce((sum, value) => sum + value, 0)
    const noopLedger = await spendLedger()
    await noopLedger.recordRunCost({
      projectPath: answered.sourcePath,
      runId,
      provider: answered.provider,
      model: answered.model,
      source: "parallel",
      totalCostUsd: measuredCosts.length ? totalCost : undefined,
    })
    controller.signal.throwIfAborted()
    const unchanged = updateRecord(id, (current) => ({
      ...current,
      status: current.changedFilesCount ? "needs review" : "complete",
      progress: 100,
      actualCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : current.actualCost,
      riskLevel: current.changedFilesCount ? riskFromDiff(current.diff, current.changedFiles) : "low",
      lastActivityAt: now(),
      lastAction: followUp
        ? `${runtimeLabel(current.runtime)} replied with no file changes`
        : `${runtimeLabel(current.runtime)} completed with no file changes`,
      finalSummary: firstRun.summary,
      error: undefined,
      logs: ["No files changed on this turn, so the deterministic checks were skipped.", ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(unchanged, unchanged.lastAction)
    return
  }

  record = updateRecord(id, (current) => ({
    ...current,
    status: "testing",
    progress: 0,
    lastAction: "Running repository checks",
    lastActivityAt: now(),
  }))
  syncBackgroundTask(record, `${runtimeLabel(record.runtime)} completed. Running deterministic checks.`)

  const refreshed = await refreshParallelWorkspace(id)
  const validation = await validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles, {
    signal: controller.signal,
  })
  // Nothing about this run goes into Vector's memory of failed checks: the diff and the account of the work are the
  // user's own agent's, which stay out of everything Vector learns from (ExternalAgent.excludedFromLearning).
  controller.signal.throwIfAborted()
  const failed = checksOutcome(validation) === "failed"
  record = updateRecord(id, (current) => ({
    ...current,
    validationReport: validation,
    validationPassed: validation.passed,
    terminalOutput: [...validationLogLines(validation), ...current.terminalOutput].slice(0, 240),
    lastAction: checksAction(validation),
    lastActivityAt: now(),
    logs: [`Guardrails: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(record, validationSummary(validation))

  const measuredCosts = costs.filter(Number.isFinite)
  const totalCost = measuredCosts.reduce((sum, value) => sum + value, 0)
  // The ledger the pre-flight allowance reads. A runtime that reported no cost
  // at all is recorded with no total, which the ledger marks unmeasured: a 0
  // would let unknown spend count as proof this run was free.
  const ledger = await spendLedger()
  await ledger.recordRunCost({
    projectPath: refreshed.sourcePath,
    runId,
    provider: refreshed.provider,
    model: refreshed.model,
    source: "parallel",
    totalCostUsd: measuredCosts.length ? totalCost : undefined,
  })
  controller.signal.throwIfAborted()
  const finalSummary = `${firstRun.summary}\n\nGuardrails: ${validationSummary(validation)}`
  // A failed check waits for the user: "Try a fix" (repairParallelWorkspace) sends it to the agent as a message of
  // theirs. Vector never runs the user's agent again on its own.
  const completed = updateRecord(id, (current) => ({
    ...current,
    status: current.changedFilesCount ? "needs review" : "complete",
    progress: 100,
    actualCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : current.actualCost,
    riskLevel: current.changedFilesCount === 0 ? "low" : validation.passed ? current.riskLevel : "high",
    lastAction: failed
      ? `A check failed. Try a fix sends it to ${runtimeLabel(current.runtime)}.`
      : current.changedFilesCount
        ? reviewAction(validation)
        : `${runtimeLabel(current.runtime)} completed with no file changes`,
    lastActivityAt: now(),
    finalSummary,
    error: validation.passed ? undefined : validation.failureSummary.slice(0, 12_000),
    logs: [
      `${runtimeLabel(current.runtime)} completed with ${current.changedFilesCount} changed file${current.changedFilesCount === 1 ? "" : "s"}. ${validationSummary(validation)}`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(completed, completed.lastAction)
}

async function executeParallelWorkspace(id: string, engine: ParallelWorkspaceEngine, controller: AbortController) {
  // One run is one execution of this workspace, not the workspace itself, so
  // a rerun gets its own per-run budget instead of inheriting a spent one.
  // The workspace id stays in front so a ledger row is traceable back here.
  const runId = `${id}:${Date.now()}`
  try {
    controller.signal.throwIfAborted()
    const persisted = readRecords().find((record) => record.id === id)
    if (!persisted) throw new Error("Parallel workspace was not found.")
    const ledger = await spendLedger()
    // The headroom is held inside the check, so agents launched beside this
    // one cannot be handed the same dollars.
    const allowance = await ledger.checkAllowance({
      runId,
      source: "parallel",
      reserve: true,
      billing: persisted.runtime === "vector" && Billing.isCodium(persisted.provider) ? "codium" : undefined,
    })
    // Blocked means the money is already spent, so the agent must never start.
    // Throwing lands in the catch below, which is the same failed-record shape
    // every other pre-flight failure uses, so the reason reaches the UI.
    if (!allowance.allowed) {
      throw new Error(allowance.reason || "A spend limit blocked this parallel agent run.")
    }
    const launched = activeRuns.get(id)
    if (launched)
      launched.spend = { projectPath: persisted.sourcePath, budgetUsd: allowance.budgetUsd, draining: false }
    // A warning is information, not a gate: the run proceeds and the user gets
    // told how close the cap is.
    const warning = allowance.state === "warn" ? allowance.reason : undefined
    if (warning) {
      const warned = updateRecord(id, (current) => ({
        ...current,
        lastActivityAt: now(),
        logs: [warning, ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(warned, warning)
    }
    const queuedRun = activeRuns.get(id)
    const followUp = queuedRun?.followUp
    // ensureParallelWorkspaceIsolation rebuilds a missing tree from sourcePath
    // as a fresh copy, which would silently discard exactly the work being
    // followed up on. A follow-up has to fail loudly instead.
    if (followUp && !(await stat(persisted.isolatedPath).catch(() => undefined))) {
      throw new Error(
        "The isolated workspace folder is gone, so this agent cannot continue. Run the workspace again to start fresh.",
      )
    }
    const initial = await ensureParallelWorkspaceIsolation(persisted)
    controller.signal.throwIfAborted()
    // Started before either runtime branch: every member of a team has to be
    // swept while the others are still working, which is the only window in
    // which a queued message can reach anybody.
    startTeamSweep(initial)
    if (initial.runtime !== "vector") {
      const prepared = await prepareParallelWorkspaceContext(initial)
      // An external agent's CLI runs in this process, out of the engine's sight, so it keeps the computer awake itself.
      await whileDesktopWorks(() =>
        executeExternalParallelWorkspace(id, prepared, controller, runId, followUp, queuedRun?.externalAgentRunner),
      )
      return
    }

    const createRequest = parallelSessionCreateRequest({
      workspaceId: initial.id,
      workspaceName: initial.name,
      isolatedPath: initial.isolatedPath,
      sourcePath: initial.sourcePath,
      parentSessionId: initial.parentSessionId,
      engineParentSessionId: initial.engineParentSessionId,
      provider: initial.provider,
      model: initial.model,
      agent: initial.agent,
    })
    const created = await engineRequest<{ id?: string }>(engine, createRequest.path, {
      method: "POST",
      body: createRequest.body,
      signal: controller.signal,
    })
    const sessionId = created?.id
    if (!sessionId) throw new Error("Vector's engine did not return a session ID for the isolated workspace.")
    const active = activeRuns.get(id)
    if (!active) throw new Error("Vector's isolated agent run was interrupted before its session started.")
    active.sessionId = sessionId
    if (active.spend) {
      const before = await engineRequest<EngineSessionResponse | undefined>(
        engine,
        `/api/session/${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      ).catch(() => undefined)
      active.spend.before = before?.data
    }
    const vectorTurnId = randomUUID()

    let record = updateRecord(id, (current) => ({
      ...current,
      agentSessionId: sessionId,
      status: "planning",
      progress: 0,
      lastAction: "Preparing task-specific repository context",
      lastActivityAt: now(),
      error: undefined,
      turns: followUp
        ? appendTurn(current.turns, {
            id: vectorTurnId,
            role: "agent",
            text: "",
            at: now(),
            state: "running",
            resumed: false,
          })
        : [
            { id: randomUUID(), role: "user", text: current.taskPrompt, at: now(), state: "done" },
            { id: vectorTurnId, role: "agent", text: "", at: now(), state: "running", resumed: false },
          ],
      logs: [`Engine session ${sessionId} started in ${current.isolatedPath}.`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, "Vector agent session started in the isolated workspace.")

    record = await prepareParallelWorkspaceContext(record)
    record = updateRecord(id, (current) => ({
      ...current,
      status: "editing",
      lastAction: "Agent is inspecting the agent workspace",
      lastActivityAt: now(),
    }))
    syncBackgroundTask(record, "Task context prepared; the Vector agent is now working.")

    await admitVectorPrompt(
      record,
      active,
      followUp
        ? continuationPrompt({
            missionBrief: parallelAgentPrompt(record),
            previousSummary: record.finalSummary,
            changedFiles: record.changedFiles,
            instruction: followUp,
          })
        : parallelAgentPrompt(record),
    )
    active.acceptsTeamMessages = true
    record = updateRecord(id, (current) => ({
      ...current,
      status: "running commands",
      progress: 0,
      lastAction: "Agent is editing and validating the workspace",
      lastActivityAt: now(),
      logs: ["Task admitted by the Vector engine. Waiting for tool execution and validation.", ...current.logs].slice(
        0,
        120,
      ),
    }))
    syncBackgroundTask(record, "Task admitted; agent tool execution is active.")

    await waitForEngineSessionIdle(id, sessionId, engine, controller.signal)
    active.acceptsTeamMessages = false
    await measureDrain(active, engine, sessionId)

    const turnFailure = await engineTurnFailure(sessionId, engine, controller.signal)
    if (turnFailure) throw new Error(turnFailure)

    record = updateRecord(id, (current) => ({
      ...current,
      status: "testing",
      progress: 0,
      lastAction: "Running repository checks",
      lastActivityAt: now(),
    }))
    syncBackgroundTask(record, "Agent became idle. Running deterministic checks in the isolated workspace.")

    let refreshed = await refreshParallelWorkspace(id)
    // The agent's session is idle now, so only this keeps the computer awake through the checks.
    let validation = await whileDesktopWorks(() =>
      validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles, { signal: controller.signal }),
    )
    await rememberValidation(refreshed, validation)
    controller.signal.throwIfAborted()
    record = updateRecord(id, (current) => ({
      ...current,
      validationReport: validation,
      validationPassed: validation.passed,
      terminalOutput: [...validationLogLines(validation), ...current.terminalOutput].slice(0, 160),
      lastAction: checksAction(validation),
      lastActivityAt: now(),
      logs: [`Guardrails: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, validationSummary(validation))

    const retryLimit = record.retryLimit ?? (record.taskDifficulty === "complex" ? 2 : 1)
    for (let attempt = 1; !validation.passed && attempt <= retryLimit && !controller.signal.aborted; attempt += 1) {
      // What this repository already knows about this exact failure, read after
      // the run above was recorded so the count and the flakiness verdict
      // include it. Empty until a signature has been seen before.
      const guidance = await priorFor(record.sourcePath, validation, [record.isolatedPath, record.sourcePath])
      controller.signal.throwIfAborted()
      record = updateRecord(id, (current) => ({
        ...current,
        status: "editing",
        riskLevel: "high",
        repairAttempts: attempt,
        lastAction: `Agent is repairing deterministic validation failure (${attempt}/${retryLimit})`,
        lastActivityAt: now(),
        logs: [
          ...(guidance ? ["Prior failures in this repository were included in the repair prompt."] : []),
          `Vector returned the exact failing check to the agent for evidence-driven repair pass ${attempt} of ${retryLimit}.`,
          ...current.logs,
        ].slice(0, 120),
      }))
      syncBackgroundTask(record, `Repairing the failed deterministic check (${attempt}/${retryLimit}).`)
      await admitVectorPrompt(
        record,
        active,
        [
          guidance,
          formatValidationForRepair(validation),
          `This is repair pass ${attempt} of ${retryLimit}. Diagnose from the exact output, make only evidence-backed changes, and rerun the relevant check yourself before finishing.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      )
      active.acceptsTeamMessages = true
      await waitForEngineSessionIdle(id, sessionId, engine, controller.signal)
      active.acceptsTeamMessages = false
      await measureDrain(active, engine, sessionId)

      // A repair pass that died on a provider error must not read as a repair
      // attempt that simply did not fix anything.
      const repairFailure = await engineTurnFailure(sessionId, engine, controller.signal)
      if (repairFailure) throw new Error(repairFailure)

      refreshed = await refreshParallelWorkspace(id)
      validation = await whileDesktopWorks(() =>
        validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles, { signal: controller.signal }),
      )
      // The agent's own account of this repair pass, so a check that now passes
      // records what actually fixed it rather than a bare list of edited files.
      const repairContext = await engineRequest<{ data?: unknown }>(
        engine,
        `/api/session/${encodeURIComponent(sessionId)}/context`,
        { signal: controller.signal },
      ).catch(() => undefined)
      await rememberValidation(refreshed, validation, collectText(repairContext?.data).at(-1) ?? "")
      controller.signal.throwIfAborted()
      record = updateRecord(id, (current) => ({
        ...current,
        status: "testing",
        validationReport: validation,
        validationPassed: validation.passed,
        terminalOutput: [
          `--- Guardrail repair verification ${attempt}/${retryLimit} ---`,
          ...validationLogLines(validation),
          ...current.terminalOutput,
        ].slice(0, 220),
        lastAction: validation.passed
          ? `Repair ${attempt} verified by deterministic checks`
          : `Repair ${attempt} did not pass validation`,
        lastActivityAt: now(),
        logs: [`Repair verification ${attempt}/${retryLimit}: ${validationSummary(validation)}`, ...current.logs].slice(
          0,
          120,
        ),
      }))
      syncBackgroundTask(record, `Repair verification ${attempt}/${retryLimit}: ${validationSummary(validation)}`)
    }

    const context = await engineRequest<{ data?: unknown }>(
      engine,
      `/api/session/${encodeURIComponent(sessionId)}/context`,
      { signal: controller.signal },
    ).catch(() => undefined)
    const summaries = collectText(context?.data)
    refreshed = await refreshParallelWorkspace(id)
    controller.signal.throwIfAborted()
    const agentSummary =
      summaries.at(-1) ||
      (refreshed.changedFilesCount
        ? `The isolated agent changed ${refreshed.changedFilesCount} file${refreshed.changedFilesCount === 1 ? "" : "s"}. Review the diff before merging.`
        : "The isolated agent completed without producing a file diff.")
    const finalSummary = `${agentSummary}\n\nGuardrails: ${validationSummary(validation)}`
    const completed = updateRecord(id, (current) => ({
      ...current,
      status: current.changedFilesCount ? "needs review" : "complete",
      progress: 100,
      riskLevel: current.changedFilesCount === 0 ? "low" : validation.passed ? current.riskLevel : "high",
      lastAction: current.changedFilesCount ? reviewAction(validation) : "Agent completed with no file changes",
      lastActivityAt: now(),
      finalSummary,
      turns: settleTurn(current.turns, vectorTurnId, { text: agentSummary, state: "done" }),
      error: validation.passed ? undefined : validation.failureSummary.slice(0, 12_000),
      logs: [
        `${current.changedFilesCount ? `Agent completed with ${current.changedFilesCount} changed file${current.changedFilesCount === 1 ? "" : "s"}.` : "Agent completed without changing files."} ${validationSummary(validation)}`,
        ...current.logs,
      ].slice(0, 120),
    }))
    syncBackgroundTask(completed, completed.lastAction)
    await drainTeamOutbox(completed)
    broadcastHandoff(completed, agentSummary)
  } catch (error) {
    const stopped = controller.signal.aborted
    // A failed or timed-out run must not leave the engine session running and
    // spending the user's API keys in the background.
    const active = activeRuns.get(id)
    if (active?.sessionId && !stopped) await interruptEngineSession(engine, active.sessionId, logTo(id))
    const detail = stopped
      ? "The parallel agent was stopped by the user."
      : error instanceof Error
        ? error.message
        : String(error)
    // A workspace can be discarded while its agent is still running, and then
    // this bookkeeping has nothing left to write to. updateRecord throws on a
    // missing id, so without this the failure handler itself raised an
    // unhandled rejection out of a background run.
    if (!readRecords().some((record) => record.id === id && record.mergeState === "none")) return
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: stopped ? "stopped" : "failed",
      progress: 0,
      lastAction: stopped ? "Workspace stopped" : "Agent execution failed",
      lastActivityAt: now(),
      // Load-bearing: without it a spend-cap block or a signed-out CLI leaves a
      // spinner in the transcript, which reads as "my message broke this".
      turns: settleRunningTurns(current.turns, { state: stopped ? "stopped" : "failed", text: detail }),
      error: stopped ? undefined : detail,
      finalSummary: detail,
      logs: [detail, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(failed, detail)
  } finally {
    // A failed or stopped run spent real money too, so the spend is recorded on
    // every exit path. Its engine reads time out, so whatever the run still
    // holds is released even when the engine never answers.
    await recordVectorRunSpend(id, runId, engine, activeRuns.get(id)).catch(() => undefined)
    await spendLedger()
      .then((ledger) => ledger.release(runId))
      .catch(() => undefined)
    // An aborted or failed run would otherwise strand whatever it wrote, so the
    // outbox is drained on every exit path, not only the success path.
    const settled = readRecords().find((record) => record.id === id)
    if (settled) {
      await drainTeamOutbox(settled).catch(() => undefined)
      stopTeamSweep(settled)
    }
    activeRuns.delete(id)
    drainParallelRunQueue()
  }
}

// Adds a finished drain's guard reading to the run. A guard stop that cut the
// agent's turn short ends the run here, before its checks or a repair pass can
// start another drain. A final answer that crossed the cap also leaves the
// guard stopped, but the turn finished, so its checks and diff are collected
// like any other. A reading already counted means the drain has not begun
// yet, as when the idle wait gave up waiting for it, so it stays pending for
// the finally to read.
async function measureDrain(active: ActiveParallelRun, engine: ParallelWorkspaceEngine, sessionId: string) {
  if (!active.spend) return
  const snapshot = newSpend(active.spend.counted, await readSpend((path) => engineRequest(engine, path), sessionId))
  if (!snapshot) return
  active.spend.measured = combineSpend(active.spend.measured, snapshot)
  active.spend.counted = snapshot
  active.spend.draining = false
  if (snapshot.state !== "stopped") return
  if (answered(await lastEngineAssistant(sessionId, engine, active.controller.signal))) return
  throw new Error(`Stopped by spend guard: ${snapshot.message ?? "the run reached its spend limit."}`)
}

// Whether a turn's last assistant message is a finished answer: no error, and
// a finish that does not ask for another step.
function answered(message: { finish?: string; error?: unknown } | undefined) {
  if (!message || message.error) return false
  return message.finish !== undefined && message.finish !== "tool-calls" && message.finish !== "error"
}

// Records a Vector-runtime run's measured cost in the ledger and on its card.
// A drain that never reached measureDrain, because the run failed or was
// stopped mid-turn, is read here instead.
async function recordVectorRunSpend(
  id: string,
  runId: string,
  engine: ParallelWorkspaceEngine,
  active: ActiveParallelRun | undefined,
) {
  const spend = active?.spend
  if (!active?.sessionId || !spend) return
  const sessionId = active.sessionId
  const after = await engineRequest<EngineSessionResponse | undefined>(
    engine,
    `/api/session/${encodeURIComponent(sessionId)}`,
    { signal: AbortSignal.timeout(SPEND_READ_TIMEOUT_MS) },
  ).catch(() => undefined)
  const last = spend.draining
    ? newSpend(
        spend.counted,
        await readSpend(
          (path) => engineRequest(engine, path, { signal: AbortSignal.timeout(SPEND_READ_TIMEOUT_MS) }),
          sessionId,
        ),
      )
    : undefined
  const cost = measuredCost(combineSpend(spend.measured, last), sessionCost(spend.before), sessionCost(after?.data))
  const record = readRecords().find((item) => item.id === id)
  const ledger = await spendLedger()
  await ledger.recordRunCost({
    projectPath: spend.projectPath,
    runId,
    provider: after?.data?.model?.providerID ?? record?.provider ?? "Current Vector provider",
    model: after?.data?.model?.id ?? record?.model ?? "Current selected model",
    source: "parallel",
    totalCostUsd: cost,
    totalTokens: usageDelta(sessionTokens(spend.before), sessionTokens(after?.data)),
  })
  if (!record) return
  const stop =
    last?.state === "stopped"
      ? `Stopped by spend guard: ${last.message ?? "the run reached its spend limit."}`
      : undefined
  const measured = updateRecord(id, (current) => ({
    ...current,
    actualCost: cost === undefined ? current.actualCost : formatUsd(cost),
    measuredCost: cost ?? current.measuredCost,
    logs: stop ? [stop, ...current.logs].slice(0, 120) : current.logs,
  }))
  syncBackgroundTask(measured)
}

// The cap a prompt is admitted with, none when the run has no headroom limit.
// A teammate note that joins a drain still running keeps that drain's cap,
// which the engine replaces with the one sent: the drain's guard run already
// counts what it has spent, so taking that spend off the headroom as well
// would count it twice and stop the agent early. Any other prompt starts a
// drain, and a guard run, of its own with the headroom left, and so does a
// note sent while a stopped drain winds down, since the run after it starts
// under the cap sent here.
async function promptBudgetUsd(active: ActiveParallelRun, sessionId: string) {
  const spend = active.spend
  if (spend?.budgetUsd === undefined) return undefined
  const signal = active.controller.signal
  const live =
    spend.draining &&
    (await engineRequest<unknown>(active.engine, "/api/session/active", { signal })
      .then((raw) => Boolean(activeSessionMap(raw)[sessionId]))
      .catch(() => false))
  // The engine answers with the session's run in progress, ahead of any finished one.
  const reading = live
    ? newSpend(spend.counted, await readSpend((path) => engineRequest(active.engine, path, { signal }), sessionId))
    : undefined
  if (reading?.budget.usd !== undefined && reading.state !== "stopped") return reading.budget.usd
  return spend.budgetUsd - (await spentSoFar(spend, active, sessionId))
}

// What a run has spent before the prompt it is about to admit. The drain
// readings miss one that ended after the last idle check, which a teammate
// note admitted in that gap would otherwise be handed again, so the session's
// own cost since the run began is the floor.
async function spentSoFar(spend: ParallelRunSpend, active: ActiveParallelRun, sessionId: string) {
  const now = await engineRequest<EngineSessionResponse | undefined>(
    active.engine,
    `/api/session/${encodeURIComponent(sessionId)}`,
    { signal: active.controller.signal },
  ).catch(() => undefined)
  return Math.max(spend.measured?.spentUsd ?? 0, usageDelta(sessionCost(spend.before), sessionCost(now?.data)) ?? 0)
}

export function runParallelWorkspace(...args: Parameters<typeof admitParallelWorkspace>) {
  if (getParallelWorkspace(args[0])?.runtime === "vector") return admitParallelWorkspace(...args)
  return serializeExternalAgentStart(() => admitParallelWorkspace(...args))
}

async function admitParallelWorkspace(
  id: string,
  engine: ParallelWorkspaceEngine,
  concurrency?: number,
  dependencies?: { runExternalCodingAgent?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult> },
) {
  const existingRun = activeRuns.get(id)
  if (existingRun || queuedRuns.has(id)) return readRecords().find((record) => record.id === id)
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.mergeState !== "none") throw new Error("Merged or discarded workspaces cannot be run again.")
  if (current.runtime === "vector" && current.excludedFromLearning)
    throw new Error(
      "This workspace used a coding agent that is no longer available. Start a new workspace with an installed agent.",
    )
  // Refused rather than queued, so the user's agent never starts later out of sight. The record says why, and the
  // user starts it again with a message once one has finished.
  if (current.runtime !== "vector" && (await ownAgentsRunning()) >= ExternalAgent.MAX_RUNNING) {
    const refused = updateRecord(id, (record) => ({
      ...record,
      status: "stopped",
      stopReason: ExternalAgent.RUN_LIMIT_MESSAGE,
      lastAction: ExternalAgent.RUN_LIMIT_MESSAGE,
      lastActivityAt: now(),
      error: ExternalAgent.RUN_LIMIT_MESSAGE,
      logs: [ExternalAgent.RUN_LIMIT_MESSAGE, ...record.logs].slice(0, 120),
    }))
    syncBackgroundTask(refused, ExternalAgent.RUN_LIMIT_MESSAGE)
    throw new Error(ExternalAgent.RUN_LIMIT_MESSAGE)
  }

  // Only an explicit concurrency choice may retune the shared pool; an
  // undefined value must not stomp a swarm that is already draining.
  if (concurrency !== undefined) maxConcurrentRuns = normalizeConcurrency(concurrency)
  const controller = new AbortController()
  queuedRuns.set(id, { controller, engine, externalAgentRunner: dependencies?.runExternalCodingAgent })
  const queued = updateRecord(id, (record) => ({
    ...record,
    status: "queued",
    runOwnerID: PROCESS_ID,
    stopReason: undefined,
    progress: 0,
    lastAction:
      activeRuns.size < maxConcurrentRuns
        ? `Starting isolated ${runtimeLabel(record.runtime)} session`
        : "Queued for an agent slot",
    lastActivityAt: now(),
    error: undefined,
    mergeFailure: undefined,
    logs: [`Run requested at ${now()}.`, ...record.logs].slice(0, 120),
  }))
  syncBackgroundTask(queued, `Parallel agent queued for ${runtimeLabel(queued.runtime)}.`)
  drainParallelRunQueue()
  return readRecords().find((record) => record.id === id) ?? queued
}

// A follow-up is another pass on the same record, so it goes through the same
// queue as a run: concurrency, abort, the ledger pre-flight and the restart
// sweep all keep working with no second code path.
export function followUpParallelWorkspace(...args: Parameters<typeof admitExternalFollowUp>) {
  return serializeExternalAgentStart(() => admitExternalFollowUp(...args))
}

async function admitExternalFollowUp(
  id: string,
  engine: ParallelWorkspaceEngine,
  text: string,
  dependencies?: { runExternalCodingAgent?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult> },
) {
  const instruction = text.trim()
  if (!instruction) throw new Error("Type a message before sending it to the agent.")
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.runtime === "vector") throw new Error("Vector agents continue in their own chat session.")
  if (current.mergeState !== "none") throw new Error("Merged or discarded workspaces cannot be continued.")
  // runParallelWorkspace returns silently when a run is in flight; a typed
  // message must never be dropped without the user being told.
  if (activeRuns.has(id) || queuedRuns.has(id)) {
    throw new Error("This agent is still working. Wait for the current turn to finish, or stop it first.")
  }
  if ((await ownAgentsRunning()) >= ExternalAgent.MAX_RUNNING) throw new Error(ExternalAgent.RUN_LIMIT_MESSAGE)
  if (!(await stat(current.isolatedPath).catch(() => undefined))) {
    throw new Error(
      "This workspace's isolated folder is gone, so the conversation cannot continue. Run it again to start a new one.",
    )
  }

  const controller = new AbortController()
  // Registered BEFORE any status write: listParallelWorkspaces rewrites a
  // running record it cannot find in these maps to "failed", and the renderer
  // polls that list every 1.5s.
  queuedRuns.set(id, {
    controller,
    engine,
    followUp: instruction,
    externalAgentRunner: dependencies?.runExternalCodingAgent,
  })
  const queued = updateRecord(id, (record) => ({
    ...record,
    status: "queued",
    runOwnerID: PROCESS_ID,
    stopReason: undefined,
    progress: 0,
    error: undefined,
    mergeFailure: undefined,
    lastAction: activeRuns.size < maxConcurrentRuns ? "Sending your message to the agent" : "Queued for an agent slot",
    lastActivityAt: now(),
    turns: appendTurn(record.turns, {
      id: randomUUID(),
      role: "user",
      text: instruction,
      at: now(),
      state: "done",
    }),
    logs: [`Follow-up message sent at ${now()}.`, ...record.logs].slice(0, 120),
  }))
  syncBackgroundTask(queued, `Follow-up message queued for ${runtimeLabel(queued.runtime)}.`)
  drainParallelRunQueue()
  return readRecords().find((record) => record.id === id) ?? queued
}

// "Try a fix": the user's one click that sends a failed check to their own coding agent, once, as a message of theirs
// that the conversation shows. Vector never runs the user's agent again on a failed check by itself.
export async function repairParallelWorkspace(
  id: string,
  engine: ParallelWorkspaceEngine,
  dependencies?: { runExternalCodingAgent?: (input: RunExternalAgentInput) => Promise<ExternalAgentRunResult> },
) {
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.runtime === "vector") throw new Error("Vector's own agent repairs its failed checks in its own session.")
  const report = current.validationReport
  if (!report || checksOutcome(report) !== "failed")
    throw new Error("No check has failed here, so there is nothing to fix.")
  return followUpParallelWorkspace(id, engine, externalRepairRequest(report), dependencies)
}

// The user's own coding agents running in Vector's chat: a turn in progress or one about to start.
export function runningChatAgents() {
  const live = new Set([...activeRuns.keys(), ...queuedRuns.keys()])
  return readRecords().filter((record) => live.has(record.id) && record.runtime !== "vector").length
}

// With the ones open in a terminal: what ExternalAgent.MAX_RUNNING counts.
async function ownAgentsRunning() {
  return runningChatAgents() + (await runningTerminalAgents())
}

// The model an external agent's CLI runs from its next turn; undefined goes back
// to the CLI's own default. Each turn is its own CLI process that resumes the
// conversation by id, so nothing is restarted: a turn in progress keeps the
// model it started with, and the next spawn passes the new flag.
export function setParallelWorkspaceRuntimeModel(id: string, value?: string) {
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.runtime === "vector") throw new Error("Vector agents choose their model in their own chat session.")
  if (current.mergeState !== "none") throw new Error("Merged or discarded workspaces cannot be continued.")
  const runtimeModel = externalModelValue(value)
  if (runtimeModel === current.runtimeModel) return current
  const updated = updateRecord(id, (record) => ({
    ...record,
    runtimeModel,
    model: runtimeModel ?? RUNTIME_DEFAULT_MODEL,
    logs: [
      `${runtimeLabel(record.runtime)} will use ${runtimeModel ? `the model "${runtimeModel}"` : "its default model"} from the next turn.`,
      ...record.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(updated)
  return updated
}

export async function stopParallelWorkspace(id: string, reason?: string) {
  const active = activeRuns.get(id)
  const queued = queuedRuns.get(id)
  queuedRuns.delete(id)
  active?.controller.abort()
  queued?.controller.abort()
  if (active?.sessionId) await interruptEngineSession(active.engine, active.sessionId, logTo(id))
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  // Stopping is only meaningful for work in flight; settled records
  // (needs review, complete, failed) keep their status.
  if (!active && !queued && current.status !== "queued") return current
  const stoppedAt = now()
  const updated = updateRecord(id, (record) => ({
    ...record,
    status: "stopped",
    lastAction: "Workspace stopped",
    stopReason: reason?.slice(0, 1000),
    lastActivityAt: stoppedAt,
    logs: [`Stopped at ${stoppedAt}.`, ...record.logs].slice(0, 80),
  }))
  if (updated.backgroundTaskId) {
    try {
      cancelBackgroundTask(updated.backgroundTaskId)
    } catch {
      syncBackgroundTask(updated, "Parallel workspace task was stopped.")
    }
  }
  return updated
}

export function parallelWorkspaceCanMessage(id: string) {
  const active = activeRuns.get(id)
  const record = getParallelWorkspace(id)
  return (
    record?.runtime === "vector" &&
    Boolean(active?.sessionId && active.acceptsTeamMessages && !active.controller.signal.aborted)
  )
}

export async function messageParallelWorkspace(
  id: string,
  text: string,
  coordination?: { sender: string; messageID: string; delivery: "steer" | "queue" },
) {
  const invalid = TaskMailbox.bodyError(text)
  if (invalid) throw new Error(invalid)
  const active = activeRuns.get(id)
  if (!active?.sessionId || !parallelWorkspaceCanMessage(id))
    throw new Error(
      "This agent cannot receive a message while idle or during validation. Open its session to continue.",
    )
  const budgetUsd = await promptBudgetUsd(active, active.sessionId)
  if (budgetUsd !== undefined && budgetUsd <= 0) throw new Error("This agent has reached its spend limit.")
  if (activeRuns.get(id) !== active || !parallelWorkspaceCanMessage(id))
    throw new Error("This agent finished before the message was sent. Your draft has been kept.")
  const messageID = coordination?.messageID ?? `msg_vector_${randomUUID().replaceAll("-", "")}`
  await engineRequest(active.engine, `/api/session/${encodeURIComponent(active.sessionId)}/prompt`, {
    method: "POST",
    body: {
      id: messageID,
      prompt: {
        text: coordination
          ? TaskMailbox.envelope(text.trim(), {
              sender: coordination.sender,
              recipient: active.sessionId,
              relation: "parent",
            })
          : text.trim(),
      },
      delivery: coordination?.delivery ?? "steer",
      resume: true,
      budget: budgetUsd === undefined ? undefined : { usd: budgetUsd },
    },
    signal: active.controller.signal,
  })
  if (active.spend) active.spend.draining = true
  taskBoardChanged()
  return { messageID }
}

async function createCheckpoint(record: ParallelWorkspaceRecord) {
  const checkpointDir = join(workspaceRoot(), "main-checkpoints", record.id, `before-merge-${Date.now()}`)
  await mkdir(checkpointDir, { recursive: true })
  const checkpointPath = join(checkpointDir, "main-state.patch")
  if (await gitRoot(record.sourcePath)) {
    // HEAD-relative diff captures staged AND unstaged main-project changes;
    // the plain worktree diff used before silently missed staged work.
    const diff = await runGit(["diff", "--binary", "HEAD", "--"], record.sourcePath, { allowFailure: true })
    await writeFile(checkpointPath, diff.stdout || "# Main workspace had no git diff before merge.\n", "utf8")
    await writeFile(
      join(checkpointDir, "README.md"),
      [
        "# Vector merge checkpoint",
        "",
        "`main-state.patch` is the repository's staged+unstaged diff against HEAD taken right before this merge.",
        "Files in `overwritten/` are copies of untracked repository files this merge replaced.",
        "To undo the merge's effect on a previously untracked file, copy it back from `overwritten/`.",
        "",
      ].join("\n"),
      "utf8",
    )
  } else {
    // A non-git project has no diff to capture, so the only thing that can
    // restore it is a copy of each file the merge is about to touch. The hash
    // map is kept for conflict detection but it is not a backup — it was the
    // whole of the "checkpoint" before, which meant a copy-mode merge could
    // delete untracked work irrecoverably.
    await Promise.all(
      (record.changedFiles ?? []).map((file) => backupBeforeOverwrite(checkpointPath, record.sourcePath, file)),
    )
    await writeFile(
      join(checkpointDir, "baseline-hashes.json"),
      JSON.stringify(record.baselineHashes ?? {}, null, 2),
      "utf8",
    )
    await writeFile(
      checkpointPath,
      "# This folder is not a git repository, so there is no diff to capture.\n# Pre-merge copies of every affected file are in `overwritten/`.\n",
      "utf8",
    )
    await writeFile(
      join(checkpointDir, "README.md"),
      [
        "# Vector merge checkpoint",
        "",
        "This folder is not a git repository, so Vector copied every file this merge",
        "was about to change or delete into `overwritten/` before touching anything.",
        "",
        "To undo the merge for a file, copy it back from `overwritten/` over the version",
        "in your folder. `baseline-hashes.json` records what Vector believed each file",
        "looked like when the workspace was created.",
        "",
      ].join("\n"),
      "utf8",
    )
  }
  return checkpointPath
}

async function fileContentsEqual(a: string, b: string) {
  const [hashA, hashB] = await Promise.all([hashFile(a).catch(() => "a"), hashFile(b).catch(() => "b")])
  return hashA === hashB
}

// After a completed merge or discard nothing runs in the isolated checkout
// again, so remove the worktree, its branch, and the per-run directory. The
// record keeps the diff text and logs as durable history.
async function cleanupIsolation(record: ParallelWorkspaceRecord) {
  // A shared tree belongs to the team, not to one member. Removing it here
  // would delete a checkout teammates are still working in, and for a
  // shared-main workspace `dirname(isolatedPath)` is the parent of the user's
  // own repository. Neither is ever safe to remove on one agent finishing.
  if (record.teamId || record.isolatedPath === record.sourcePath) return
  if (record.isolation === "git-worktree") {
    await runGit(["worktree", "remove", "--force", record.isolatedPath], record.sourcePath, {
      allowFailure: true,
    }).catch(() => undefined)
    if (record.gitBranch) {
      await runGit(["branch", "-D", record.gitBranch], record.sourcePath, { allowFailure: true }).catch(() => undefined)
    }
  }
  await rm(dirname(record.isolatedPath), { recursive: true, force: true }).catch(() => undefined)
}

// Merges into the same folder run one at a time. Each checks the folder for conflicts before it writes, so two merges
// interleaving there (sibling swarm workers finishing together into staging) could both pass, and the later write would
// silently replace the earlier one's change to a file they share.
const mergeQueues = new Map<string, Promise<void>>()

function serializeMerge(sourcePath: string, merge: () => Promise<void>) {
  const queued = (mergeQueues.get(sourcePath) ?? Promise.resolve()).catch(() => undefined).then(merge)
  mergeQueues.set(sourcePath, queued)
  return queued.finally(() => {
    if (mergeQueues.get(sourcePath) === queued) mergeQueues.delete(sourcePath)
  })
}

// A merge refused because the source holds other changes where this workspace's changes go. Merging the same changes
// again would be refused the same way.
class MergeConflict extends Error {}

// `git apply --3way --check` passes a patch it can only apply with conflicts, and says so on stderr alone. Applying
// it then writes conflict markers into the files, so that is a conflict as much as a failed check. LC_ALL=C keeps the
// message in English whatever the user's locale.
const CONFLICTED = /^Applied patch to '.*' with conflicts\.$/m

async function checkPatch(patch: string, cwd: string) {
  const check = await runGit(["apply", "--3way", "--check", "-"], cwd, {
    allowFailure: true,
    input: patch,
    env: { LC_ALL: "C" },
  })
  return { clean: !check.failed && !CONFLICTED.test(check.stderr), detail: check.stderr.trim() }
}

const MERGE_FILES = "merge-files.json"

// Called just before a merge's first write into the source, with every file the merge may write. Their current
// contents go into the checkpoint first, because each write deletes or overwrites a file in the user's real project:
// for a non-git project nothing else could restore it. The first attempt also names the files in the checkpoint and
// records it with mergeStartedAt, so after a restart a merge Vector stopped part-way through can be told apart from one
// that never began, and undone exactly. A retry keeps that record: only the first attempt's copies hold the files as
// they were before any of this workspace's changes arrived. `indexed` are the files `git apply` also stages.
async function recordMergeStarted(
  record: ParallelWorkspaceRecord,
  checkpointPath: string,
  files: string[],
  indexed: string[] = [],
) {
  await Promise.all(files.map((file) => backupBeforeOverwrite(checkpointPath, record.sourcePath, file)))
  if (record.mergeStartedAt) return
  await writeFile(join(dirname(checkpointPath), MERGE_FILES), JSON.stringify({ files, indexed }), "utf8")
  updateRecord(record.id, (current) => ({
    ...current,
    mergeStartedAt: now(),
    mergeCheckpointPath: checkpointPath,
    lastActivityAt: now(),
  }))
}

// Undoes a merge Vector stopped part-way through, so the workspace can be merged afresh, or its task run again on a
// source that holds none of its changes. Finishing such a merge in place cannot work once `git apply` stopped between
// files: the source then matches neither the patch nor the index, so the patch applies in neither direction. Every
// file that merge was about to write goes back to how it was before the merge began, so nothing else may have merged
// into the source since. Whatever a file held instead is kept in the checkpoint's `rolled-back` folder. A merge that
// left no list of its files cannot be undone, and says so. Either way the workspace stops counting as mid-merge, so
// nothing retries a merge that cannot finish forever.
export async function rollBackUnfinishedMerge(id: string) {
  const sourcePath = getParallelWorkspace(id)?.sourcePath
  if (!sourcePath) return
  await serializeMerge(sourcePath, () => undoUnfinishedMerge(id))
}

// The undo itself, for a caller that already holds the source's merge queue.
async function undoUnfinishedMerge(id: string) {
  // Read once the queue is ours: a merge of this workspace that ran in the meantime has already settled it.
  const record = getParallelWorkspace(id)
  if (!record?.mergeStartedAt || record.mergeState !== "none") return
  const checkpoint = record.mergeCheckpointPath ? dirname(record.mergeCheckpointPath) : ""
  const manifest = checkpoint
    ? await readFile(join(checkpoint, MERGE_FILES), "utf8")
        .then((text) => JSON.parse(text) as { files?: unknown; indexed?: unknown })
        .catch(() => undefined)
    : undefined
  const files = Array.isArray(manifest?.files)
    ? manifest.files.filter((file): file is string => typeof file === "string")
    : []
  const indexed = Array.isArray(manifest?.indexed)
    ? manifest.indexed.filter((file): file is string => typeof file === "string")
    : []
  const restored = (
    await Promise.all(
      files.map(async (file) => ((await restoreBeforeMerge(record.sourcePath, checkpoint, file)) ? [file] : [])),
    )
  ).flat()
  // `git apply --3way` staged the patch too. Before it ran, the index matched these files (it refuses otherwise), so
  // staging them as restored puts the index back as well.
  if (indexed.length)
    await runGit(["update-index", "--add", "--remove", "--", ...indexed], record.sourcePath, { allowFailure: true })
  const one = restored.length === 1
  const detail = manifest
    ? `Vector undid an unfinished merge into ${record.sourcePath}, putting ${restored.length} file${one ? "" : "s"} back as ${one ? "it was" : "they were"} before it began.${restored.length ? ` What ${one ? "it" : "they"} held instead is in ${join(checkpoint, "rolled-back")}.` : ""}`
    : `Vector could not undo an unfinished merge into ${record.sourcePath}, because it left no list of the files it was writing. The source may still hold part of this workspace's changes.`
  updateRecord(id, (current) => ({
    ...current,
    mergeStartedAt: undefined,
    mergeCheckpointPath: undefined,
    lastActivityAt: now(),
    logs: [detail, ...current.logs].slice(0, 120),
  }))
}

// Puts one file back as the merge found it: the copy the merge saved, or no file when there was none. Returns whether
// the file had to change.
async function restoreBeforeMerge(sourcePath: string, checkpoint: string, file: string) {
  const before = join(checkpoint, "overwritten", file)
  const target = join(sourcePath, file)
  const existed = await lstat(before).catch(() => undefined)
  const present = await lstat(target).catch(() => undefined)
  if (existed ? present && (await fileContentsEqual(before, target)) : !present) return false
  // backupBeforeOverwrite keeps its copy in `overwritten/` beside the path it is given.
  await backupBeforeOverwrite(join(checkpoint, "rolled-back", "state"), sourcePath, file)
  await rm(target, { recursive: true, force: true })
  if (!existed) return true
  await mkdir(dirname(target), { recursive: true })
  await cp(before, target, { recursive: true, force: true, verbatimSymlinks: true })
  return true
}

async function mergeGitWorktree(record: ParallelWorkspaceRecord, force: boolean, checkpointPath: string) {
  const patch = (
    await runGit(["diff", "--binary", record.baseCommit ?? "HEAD", "--"], record.isolatedPath, { allowFailure: true })
  ).stdout
  const untracked = (
    await runGit(["ls-files", "--others", "--exclude-standard"], record.isolatedPath, { allowFailure: true })
  ).stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)

  // An untracked file in the worktree may collide with the user's own
  // uncommitted-untracked file in main. Overwriting silently is data loss —
  // `git diff` checkpoints never capture untracked content.
  const collisions: string[] = []
  for (const file of untracked) {
    const target = join(record.sourcePath, file)
    const exists = await stat(target).catch(() => undefined)
    if (exists && !(await fileContentsEqual(join(record.isolatedPath, file), target))) collisions.push(file)
  }
  if (collisions.length && !force) {
    throw new MergeConflict(
      `Merge blocked: ${collisions.slice(0, 8).join(", ")} exist${collisions.length === 1 ? "s" : ""} in your repository with different content. Review or force-merge to overwrite (a backup copy is saved to the checkpoint).`,
    )
  }

  // Finishing a merge Vector stopped part-way through: the patch may already be in the source, where it now applies
  // only in reverse. Applying it again would fail, so only the untracked copies are redone.
  const landed =
    Boolean(record.mergeStartedAt && patch.trim()) &&
    !(await runGit(["apply", "--reverse", "--check", "-"], record.sourcePath, { allowFailure: true, input: patch }))
      .failed
  const pending = patch.trim() && !landed ? patch : ""
  // Forcing cannot get past this: git applies no patch its check refuses, and one it can only apply with conflicts
  // would leave conflict markers in the source.
  const check = pending ? await checkPatch(pending, record.sourcePath) : undefined
  if (check && !check.clean) throw new MergeConflict(`Merge conflict detected.\n${check.detail}`)
  // Every path the patch writes, both sides of a rename included.
  const patched = pending
    ? (
        await runGit(["diff", "--name-only", "--no-renames", record.baseCommit ?? "HEAD", "--"], record.isolatedPath, {
          allowFailure: true,
        })
      ).stdout
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    : []
  await recordMergeStarted(record, checkpointPath, [...new Set([...patched, ...untracked])], patched)
  if (pending) {
    const applied = await runGit(["apply", "--3way", "-"], record.sourcePath, {
      allowFailure: true,
      input: pending,
      env: { LC_ALL: "C" },
    })
    // Conflicts here mean the source changed after the check, outside Vector.
    if (applied.failed && CONFLICTED.test(applied.stderr)) throw new MergeConflict(applied.stderr)
    if (applied.failed) throw new Error(applied.stderr || "Git could not apply the workspace diff.")
  }

  for (const file of untracked) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
  }
}

async function mergeCopy(record: ParallelWorkspaceRecord, force: boolean, checkpointPath: string) {
  const refreshed = await refreshParallelWorkspace(record.id)
  const conflicts: string[] = []
  for (const file of refreshed.changedFiles) {
    const sourceHash = await hashFile(join(record.sourcePath, file)).catch(() => "missing")
    const baselineHash = record.baselineHashes?.[file] ?? "missing"
    // A source file that already holds this workspace's version loses nothing when it is copied again. That is the
    // case for every file a merge Vector stopped part-way through had already copied.
    if (sourceHash === baselineHash) continue
    if (sourceHash !== (await hashFile(join(record.isolatedPath, file)).catch(() => "missing"))) conflicts.push(file)
  }
  if (conflicts.length && !force) {
    throw new MergeConflict(
      `Merge conflict detected in ${conflicts.slice(0, 8).join(", ")}. The repository changed since workspace creation.`,
    )
  }
  await recordMergeStarted(record, checkpointPath, refreshed.changedFiles)
  for (const file of refreshed.changedFiles) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const fromStat = await stat(from).catch(() => undefined)
    if (!fromStat) {
      await rm(to, { force: true, recursive: true })
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
  }
}

async function validateBeforeIntegration(record: ParallelWorkspaceRecord, allowSecrets = false) {
  const secrets = await scanChangedSecrets(record.sourcePath, record.isolatedPath, record.changedFiles)
  if (secrets.length && !allowSecrets) {
    const summary = secrets
      .slice(0, 8)
      .map((finding) => `${finding.file}:${finding.line} (${finding.kind})`)
      .join(", ")
    const updated = updateRecord(record.id, (current) => ({
      ...current,
      status: "needs review",
      riskLevel: "high",
      lastAction: "Secret scan requires review",
      lastActivityAt: now(),
      error: `Potential credentials detected: ${summary}`,
      logs: [`Secret scan blocked integration: ${summary}`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(updated, "Potential credentials must be reviewed before integration.")
    throw new Error(
      `Secret scan blocked integration. Review ${summary}. Vector never includes secret values in this report; explicitly confirm the force action only if these are intentional test credentials.`,
    )
  }
  const validationReport = await whileDesktopWorks(() => validateWorkspace(record.isolatedPath, record.changedFiles))
  const updated = updateRecord(record.id, (current) => ({
    ...current,
    validationReport,
    validationPassed: validationReport.passed,
    terminalOutput: [...validationLogLines(validationReport), ...current.terminalOutput].slice(0, 160),
    lastActivityAt: now(),
    logs: [`Pre-merge checks: ${validationSummary(validationReport)}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(updated, validationSummary(validationReport))
  if (!validationReport.passed) {
    throw new Error(
      validationReport.failureSummary || "Workspace checks failed. Fix them before integrating these changes.",
    )
  }
  return updated
}

export async function mergeParallelWorkspace(id: string, force = false, commit?: { message: string }) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState === "merged") return refreshed
  if (refreshed.mergeState === "discarded") throw new Error("Discarded workspaces cannot be merged.")
  if (!refreshed.changedFiles.length) throw new Error("There are no changes to merge.")
  // A copy merge reads a missing file as one the agent deleted, so merging from a checkout that is gone would delete
  // those files from the source.
  if (!(await stat(refreshed.isolatedPath).catch(() => undefined)))
    throw new Error("This workspace's isolated copy no longer exists, so its changes cannot be merged.")
  const record = await validateBeforeIntegration(refreshed, force)
  const checkpointPath = await createCheckpoint(record)
  try {
    await serializeMerge(record.sourcePath, () =>
      (record.isolation === "git-worktree"
        ? mergeGitWorktree(record, force, checkpointPath)
        : mergeCopy(record, force, checkpointPath)
      ).catch(async (error: unknown) => {
        // A merge that fails part-way leaves the source holding some of these changes. They are undone while the queue
        // is still this merge's, so no other merge into the folder has written there since. An undo that fails leaves
        // mergeStartedAt set, so a swarm's Resume tries it again.
        await undoUnfinishedMerge(id).catch((undo: unknown) =>
          logTo(id)(`Vector could not undo what this merge wrote into ${record.sourcePath}: ${String(undo)}`),
        )
        throw error
      }),
    )
  } catch (error) {
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: "failed",
      lastAction: "Merge blocked",
      lastActivityAt: now(),
      checkpointPath,
      mergeFailure: error instanceof MergeConflict ? "conflict" : "error",
      error: error instanceof Error ? error.message : String(error),
      logs: [`Merge blocked: ${error instanceof Error ? error.message : String(error)}`, ...current.logs].slice(0, 80),
    }))
    syncBackgroundTask(failed, "Merge was blocked by a conflict or failed patch.")
    return failed
  }
  // Every change is in the source now. Record that before the cleanup, which can take seconds: Vector closing during it
  // must not leave a workspace that looks unmerged, or a swarm would run its task again on top of its own changes. The
  // record also says what is left to do, so a restart can finish the cleanup and report a commit it never made.
  finishingMerges.add(id)
  updateRecord(id, (current) => ({
    ...current,
    status: "merged",
    mergeState: "merged",
    checkpointPath,
    cleanupPending: true,
    pendingCommit: commit?.message?.trim() || undefined,
    summaryBeforeMerge: current.summaryBeforeMerge ?? current.finalSummary,
    lastAction: "Merged; removing the isolated copy",
    lastActivityAt: now(),
  }))
  await cleanupIsolation(record)

  // Optional real commit: the merge already landed in main's working tree
  // (checkpoint + untracked backups preserved). Committing is a separate,
  // reversible step (git reset --soft HEAD~1), so a commit failure must never
  // discard the successful merge — it is recorded and surfaced instead.
  let commitNote = ""
  let commitError = ""
  if (commit?.message?.trim()) {
    try {
      if (!(await gitRoot(record.sourcePath))) {
        commitError = "Changes were merged, but the folder is not a git repository, so nothing was committed."
      } else if (await gitIsClean(record.sourcePath)) {
        commitNote = "Main working tree was already clean after the merge; nothing to commit."
      } else {
        // The user typed the message, so the posting check only asks when it repeats what Vector knows about them.
        const [message] =
          (await checkPost({ cwd: record.sourcePath, parts: [commit.message.trim()], typed: true })) ?? []
        if (!message) commitError = "Changes were merged, but nothing was committed."
        if (message) {
          await runGit(["add", "-A"], record.sourcePath)
          await runGit(await buildCommitArgs(record.sourcePath, message), record.sourcePath)
          const sha = (
            await runGit(["rev-parse", "--short", "HEAD"], record.sourcePath, { allowFailure: true })
          ).stdout.trim()
          commitNote = sha ? `Committed to main: ${sha}` : "Committed to main."
        }
      }
    } catch (error) {
      commitError = `Merge succeeded, but the git commit failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Closing the record compacted its file list away, so the summary counts from `record`.
  const merged = updateRecord(id, (current) => ({
    ...current,
    status: "merged",
    progress: 100,
    mergeState: "merged",
    checkpointPath,
    cleanupPending: undefined,
    pendingCommit: undefined,
    error: commitError || undefined,
    lastAction: commitNote.startsWith("Committed")
      ? "Merged and committed to the repository"
      : `Merged into ${mergeTarget(record)}`,
    lastActivityAt: now(),
    finalSummary: [
      `Merged ${record.changedFiles.length} changed file${record.changedFiles.length === 1 ? "" : "s"} into ${mergeTarget(record)}.`,
      commitNote,
      commitError,
    ]
      .filter(Boolean)
      .join(" "),
    logs: [
      `Merged at ${now()}. Worktree cleaned up. Main checkpoint: ${checkpointPath}`,
      ...(commitNote ? [commitNote] : []),
      ...(commitError ? [commitError] : []),
      ...current.logs,
    ].slice(0, 80),
  }))
  finishingMerges.delete(id)
  syncBackgroundTask(
    merged,
    commitError
      ? "Merged into the repository, but the commit failed."
      : commitNote.startsWith("Committed")
        ? "Parallel workspace merged and committed to the repository."
        : `Parallel workspace merged into ${mergeTarget(record)}.`,
  )
  return merged
}

// A swarm worker merges into the swarm's staging workspace; everything else merges into the project it came from.
function mergeTarget(record: ParallelWorkspaceRecord) {
  return record.swarmRole === "worker" ? "swarm staging" : "the repository"
}

// Merges in this process whose changes are in the source and that are still removing the isolated copy or committing.
const finishingMerges = new Set<string>()

// Finishes a merge Vector closed during, after its changes reached the source. The isolated copy and branch are
// removed now. A commit the user asked for is reported instead of made: the source may have changed since Vector
// closed, and committing everything in it would sweep those changes in.
async function finishInterruptedMerge(record: ParallelWorkspaceRecord) {
  finishingMerges.add(record.id)
  await cleanupIsolation(record)
  const skipped = record.pendingCommit
    ? "Vector closed before it made the commit you asked for, so nothing was committed. Commit the merged changes yourself if you still want them committed."
    : ""
  if (readRecords().some((item) => item.id === record.id)) {
    const finished = updateRecord(record.id, (current) => ({
      ...current,
      cleanupPending: undefined,
      pendingCommit: undefined,
      error: skipped || undefined,
      lastAction: skipped ? "Merged; the requested commit was not made" : `Merged into ${mergeTarget(current)}`,
      lastActivityAt: now(),
      finalSummary: [
        `Merged ${current.changedFilesCount} changed file${current.changedFilesCount === 1 ? "" : "s"} into ${mergeTarget(current)}.`,
        skipped,
      ]
        .filter(Boolean)
        .join(" "),
      logs: [
        `Vector closed while this merge was removing the isolated copy; the cleanup finished at ${now()}.`,
        ...(skipped ? [skipped] : []),
        ...current.logs,
      ].slice(0, 80),
    }))
    syncBackgroundTask(finished, skipped || `Parallel workspace merged into ${mergeTarget(finished)}.`)
  }
  finishingMerges.delete(record.id)
}

export async function openParallelWorkspacePullRequest(id: string) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState !== "none") throw new Error("This workspace is already closed.")
  if (refreshed.isolation !== "git-worktree" || !refreshed.gitBranch) {
    throw new Error("Pull requests require a Git repository with an isolated worktree.")
  }
  if (!refreshed.changedFiles.length) throw new Error("There are no workspace changes to open as a pull request.")
  const record = await validateBeforeIntegration(refreshed)
  const result = await createPullRequest({
    projectPath: record.isolatedPath,
    title: record.name,
    ...(record.finalSummary ? { body: record.finalSummary } : {}),
    ...(record.taskPrompt ? { task: record.taskPrompt } : {}),
  })
  if (!result.ok || !result.url) throw new Error(result.error || "GitHub did not return a pull request URL.")
  const updated = updateRecord(id, (current) => ({
    ...current,
    pullRequestUrl: result.url,
    lastAction: "Pull request ready for review",
    lastActivityAt: now(),
    logs: [`Opened pull request: ${result.url}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(updated, "Workspace pull request opened on GitHub.")
  return updated
}

async function mergeSelectedGitChanges(
  record: ParallelWorkspaceRecord,
  selection: UnifiedDiffSelection,
  force: boolean,
  checkpointPath: string,
) {
  const patch = (
    await runGit(["diff", "--binary", record.baseCommit ?? "HEAD", "--"], record.isolatedPath, { allowFailure: true })
  ).stdout
  // Hunk IDs were hashed from the diff snapshot the user reviewed. If the
  // workspace changed since, missing IDs must fail loudly instead of being
  // silently dropped while the log claims every approved hunk merged.
  if (selection.hunkIds?.length) {
    const freshIds = new Set(parseUnifiedDiff(patch).flatMap((file) => file.hunks.map((hunk) => hunk.id)))
    const missing = selection.hunkIds.filter((id) => !freshIds.has(id))
    if (missing.length) {
      throw new Error(
        `${missing.length} of ${selection.hunkIds.length} approved hunk${selection.hunkIds.length === 1 ? "" : "s"} no longer match the workspace diff. Refresh the review and approve again.`,
      )
    }
  }
  const selectedPatch = selectUnifiedDiff(patch, selection)
  const untracked = new Set(
    (
      await runGit(["ls-files", "--others", "--exclude-standard"], record.isolatedPath, {
        allowFailure: true,
      })
    ).stdout
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const selectedUntracked = (selection.files ?? []).filter((file) => untracked.has(file))

  if (!selectedPatch.trim() && !selectedUntracked.length) {
    throw new Error("Select at least one changed hunk or file before merging.")
  }

  if (selectedPatch.trim()) {
    const reverseCheck = await runGit(["apply", "--reverse", "--check", "-"], record.isolatedPath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (reverseCheck.failed) {
      throw new Error(
        `The selected diff is stale and can no longer be separated safely.\n${reverseCheck.stderr.trim()}`,
      )
    }
    // As in a full merge, forcing cannot get past a conflict without leaving conflict markers in the main project.
    const sourceCheck = await checkPatch(selectedPatch, record.sourcePath)
    if (!sourceCheck.clean) throw new Error(`Selected changes conflict with the repository.\n${sourceCheck.detail}`)
    const applied = await runGit(["apply", "--3way", "-"], record.sourcePath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (applied.failed) throw new Error(applied.stderr || "Git could not apply the selected changes.")

    const removed = await runGit(["apply", "--reverse", "-"], record.isolatedPath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (removed.failed) {
      throw new Error(
        "The selected changes reached main, but Vector could not remove them from the isolated review. Refresh the workspace before merging again.",
      )
    }
  }

  for (const file of selectedUntracked) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const exists = await stat(to).catch(() => undefined)
    if (exists && !(await fileContentsEqual(from, to)) && !force) {
      throw new Error(`Merge blocked: ${file} exists in your repository with different content.`)
    }
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
    await rm(from, { force: true, recursive: true })
  }
}

async function mergeSelectedCopyChanges(
  record: ParallelWorkspaceRecord,
  selection: UnifiedDiffSelection,
  force: boolean,
  checkpointPath: string,
) {
  if (selection.hunkIds?.length) {
    throw new Error("Folders without Git support selective review one complete file at a time.")
  }
  const refreshed = await refreshParallelWorkspace(record.id)
  const changed = new Set(refreshed.changedFiles)
  const files = Array.from(new Set(selection.files ?? [])).filter((file) => changed.has(file))
  if (!files.length) throw new Error("Select at least one changed file before merging.")

  const conflicts: string[] = []
  for (const file of files) {
    const sourceHash = await hashFile(join(record.sourcePath, file)).catch(() => "missing")
    const baselineHash = record.baselineHashes?.[file] ?? "missing"
    if (sourceHash !== baselineHash) conflicts.push(file)
  }
  if (conflicts.length && !force) {
    throw new Error(`Selected files conflict with newer edits in the repository: ${conflicts.slice(0, 8).join(", ")}.`)
  }

  const nextBaseline = { ...(record.baselineHashes ?? {}) }
  for (const file of files) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const fromStat = await stat(from).catch(() => undefined)
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    if (!fromStat) {
      await rm(to, { force: true, recursive: true })
      nextBaseline[file] = "missing"
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
    nextBaseline[file] = await hashFile(from).catch(() => "missing")
  }
  updateRecord(record.id, (current) => ({ ...current, baselineHashes: nextBaseline }))
}

export async function mergeParallelWorkspaceSelection(id: string, selection: UnifiedDiffSelection, force = false) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState !== "none") throw new Error("This workspace is no longer available for review.")
  if (!refreshed.changedFiles.length) throw new Error("There are no changes to merge.")
  const record = await validateBeforeIntegration(refreshed, force)
  const checkpointPath = await createCheckpoint(record)

  try {
    await serializeMerge(record.sourcePath, () =>
      record.isolation === "git-worktree"
        ? mergeSelectedGitChanges(record, selection, force, checkpointPath)
        : mergeSelectedCopyChanges(record, selection, force, checkpointPath),
    )
  } catch (error) {
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: "needs review",
      lastAction: "Selective merge blocked",
      lastActivityAt: now(),
      checkpointPath,
      error: error instanceof Error ? error.message : String(error),
      logs: [
        `Selective merge blocked: ${error instanceof Error ? error.message : String(error)}`,
        ...current.logs,
      ].slice(0, 120),
    }))
    syncBackgroundTask(failed, "Selective merge was blocked; the isolated changes remain available.")
    return failed
  }

  const remaining = await refreshParallelWorkspace(id)
  const acceptedCount = (selection.hunkIds?.length ?? 0) + (selection.files?.length ?? 0)
  const complete = remaining.changedFiles.length === 0
  if (complete) await cleanupIsolation(remaining)
  const updated = updateRecord(id, (current) => ({
    ...current,
    status: complete ? "merged" : "needs review",
    progress: complete ? 100 : current.progress,
    mergeState: complete ? "merged" : "none",
    checkpointPath,
    error: undefined,
    lastAction: complete ? "All approved changes merged" : "Approved changes merged; review remains",
    lastActivityAt: now(),
    summaryBeforeMerge: current.summaryBeforeMerge ?? current.finalSummary,
    finalSummary: complete
      ? `All approved changes were merged into ${mergeTarget(current)}.`
      : `${current.changedFiles.length} changed file${current.changedFiles.length === 1 ? "" : "s"} remain in isolated review.`,
    logs: [
      `Merged ${acceptedCount} approved review item${acceptedCount === 1 ? "" : "s"} at ${now()}. Checkpoint: ${checkpointPath}`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(updated, complete ? "Workspace review fully merged." : "Approved changes merged; review remains.")
  return updated
}

export async function discardParallelWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  // Deleting a live agent's directory out from under it keeps the engine
  // session running (and spending tokens) against a removed path — stop the
  // run before touching the filesystem.
  const active = activeRuns.get(id)
  const queued = queuedRuns.get(id)
  queuedRuns.delete(id)
  active?.controller.abort()
  queued?.controller.abort()
  if (active?.sessionId) await interruptEngineSession(active.engine, active.sessionId, logTo(id))
  await cleanupIsolation(record)
  const discarded = updateRecord(id, (current) => ({
    ...current,
    status: "discarded",
    progress: 100,
    mergeState: "discarded",
    lastAction: "Discarded isolated workspace",
    lastActivityAt: now(),
    logs: [`Discarded at ${now()}.`, ...current.logs].slice(0, 80),
  }))
  syncBackgroundTask(discarded, "Parallel workspace discarded.")
  return discarded
}

// Merged, discarded, failed, and stopped workspaces keep their record as
// history, but the list fills the launch cap over time. Removal deletes the
// record (never a live run) so the workspace list stays usable.
export async function removeParallelWorkspaceRecord(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) return readRecords()
  if (activeRuns.has(id) || queuedRuns.has(id)) {
    throw new Error("Stop this workspace before removing it from the list.")
  }
  if (
    record.mergeState === "none" &&
    ["needs review", "complete"].includes(record.status) &&
    record.changedFilesCount > 0
  ) {
    throw new Error("This workspace still has unreviewed changes. Merge or discard it first.")
  }
  await cleanupIsolation(record)
  const next = readRecords().filter((item) => item.id !== id)
  writeRecords(next)
  if (record.backgroundTaskId) {
    try {
      cancelBackgroundTask(record.backgroundTaskId)
    } catch {
      // The mirrored task may already be settled; removal proceeds regardless.
    }
  }
  return next
}
