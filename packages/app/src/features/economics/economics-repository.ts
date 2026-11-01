// Persists verified ModelOutcome history per project, using Vector's standard
// desktop/web persistence pattern: electron-store IPC when running in the
// desktop shell, falling back to localStorage in the web build. Keys are
// namespaced per project via an FNV-1a hash (the same `checksum` helper
// persist.ts uses) so unrelated projects never collide or leak into each
// other's history.
import { checksum } from "@vectordevai/core/util/encode"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { createEffect, createSignal } from "solid-js"
import type { MeasuredLatency, ModelOutcome, TaskCategory } from "./economics-types"
import { totalSessionCost, type MeasuredUsage, type SessionSpend } from "./token-usage"

const STORAGE_NAME = "vector.model-economics.v1.dat"
const MAX_OUTCOMES_PER_PROJECT = 500
export type WorkspaceOutcomeVersion = {
  workspaceRevision: number
  sessionID?: string
  sessionUpdatedAt?: number
}
type StoredOutcome = ModelOutcome & { sessionUpdatedAt?: number; workspaceVersion?: WorkspaceOutcomeVersion }

type StoreApi = {
  storeGet?: (name: string, key: string) => Promise<string | null>
  storeSet?: (name: string, key: string, value: string) => Promise<void>
  storeDelete?: (name: string, key: string) => Promise<void>
}

function storeApi(): StoreApi | undefined {
  return globalThis.window?.api as StoreApi | undefined
}

function projectKey(projectId: string) {
  return `outcomes:${checksum(projectId) ?? "0"}`
}

function localStorageKey(projectId: string) {
  return `${STORAGE_NAME}:${projectKey(projectId)}`
}

function parseOutcomes(raw: string | null): StoredOutcome[] {
  if (!raw) return []
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  return Array.isArray(parsed) ? (parsed as StoredOutcome[]).filter(eligibleOutcome) : []
}

async function readOutcomes(projectId: string): Promise<StoredOutcome[]> {
  const api = storeApi()
  if (api?.storeGet) {
    const raw = await api.storeGet(STORAGE_NAME, projectKey(projectId))
    return parseOutcomes(raw)
  }
  return parseOutcomes(globalThis.localStorage?.getItem(localStorageKey(projectId)) ?? null)
}

async function writeOutcomes(projectId: string, outcomes: StoredOutcome[]): Promise<void> {
  const capped = outcomes.filter(eligibleOutcome).slice(-MAX_OUTCOMES_PER_PROJECT)
  const value = JSON.stringify(capped)

  const api = storeApi()
  if (api?.storeSet) {
    await api.storeSet(STORAGE_NAME, projectKey(projectId), value)
    return
  }
  globalThis.localStorage?.setItem(localStorageKey(projectId), value)
}

// Recording reads, appends to and writes back a project's whole list, so records for one project run one at a time;
// two at once would each write a list without the other's outcome.
const queues = new Map<string, Promise<void>>()
const sessionRevisions = new Map<string, number>()
// Bumped after each new outcome is written, so views showing a project's history read it again.
const [version, setVersion] = createSignal(0)

export function recordOutcome(outcome: ModelOutcome, updatedAt?: number): Promise<void> {
  return queueOutcome(outcome.projectId, () => appendOutcome(outcome, updatedAt)).catch(() => undefined)
}

function queueOutcome<T>(projectId: string, update: () => Promise<T>) {
  const key = projectKey(projectId)
  const next = (queues.get(key) ?? Promise.resolve()).then(update)
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// Workspace validation/status and session spend advance independently. Replace only a complete snapshot
// that does not regress either axis; a rerun's new session is ordered by the workspace revision alone.
export function recordWorkspaceOutcome(outcome: ModelOutcome, input: WorkspaceOutcomeVersion, current = () => true) {
  return queueOutcome<"written" | "unchanged" | "stale">(outcome.projectId, async () => {
    if (!current()) return "stale"
    if (!Number.isFinite(input.workspaceRevision) || input.workspaceRevision < 0) return "stale"
    if (
      input.sessionUpdatedAt !== undefined &&
      (!Number.isFinite(input.sessionUpdatedAt) || input.sessionUpdatedAt < 0)
    )
      return "stale"
    const existing = await readOutcomes(outcome.projectId)
    const previous = existing.find((item) => item.id === outcome.id)
    if (previous) {
      const prior = previous.workspaceVersion ?? {
        workspaceRevision: 0,
        sessionID: input.sessionID,
        sessionUpdatedAt: previous.sessionUpdatedAt,
      }
      if (prior.sessionID !== input.sessionID && input.workspaceRevision <= prior.workspaceRevision) return "stale"
      if (prior.sessionID === input.sessionID) {
        if (
          input.workspaceRevision < prior.workspaceRevision ||
          (input.sessionUpdatedAt ?? -1) < (prior.sessionUpdatedAt ?? -1)
        )
          return "stale"
        if (input.workspaceRevision === prior.workspaceRevision && input.sessionUpdatedAt === prior.sessionUpdatedAt)
          return "unchanged"
      }
    }
    // A new run or disposal can invalidate this capture while the storage read is in flight.
    if (!current()) return "stale"
    await writeOutcomes(outcome.projectId, [
      ...existing.filter((item) => item.id !== outcome.id),
      { ...outcome, workspaceVersion: { ...input } },
    ])
    setVersion((value) => value + 1)
    return "written"
  })
}

// One sample per ordinary session, refreshed from cumulative usage. An absent outcome means the
// measured session now mixes models; its earlier single-model sample must no longer influence rankings.
export function recordSessionOutcome(input: {
  sessionID: string
  projectId: string
  updatedAt: number
  outcome?: ModelOutcome
}): Promise<void> {
  return queueOutcome(input.projectId, async () => {
    if (!Number.isFinite(input.updatedAt)) return
    const id = `session:${input.sessionID}`
    const key = JSON.stringify([input.projectId, id])
    const existing = await readOutcomes(input.projectId)
    const previous = existing.find((outcome) => outcome.id === id)
    if (input.updatedAt <= Math.max(sessionRevisions.get(key) ?? -1, previous?.sessionUpdatedAt ?? -1)) return
    const remaining = existing.filter((outcome) => outcome.id !== id)
    if (!input.outcome && !previous) {
      sessionRevisions.set(key, input.updatedAt)
      return
    }
    await writeOutcomes(
      input.projectId,
      input.outcome
        ? [...remaining, { ...input.outcome, id, projectId: input.projectId, sessionUpdatedAt: input.updatedAt }]
        : remaining,
    )
    // Commit the revision only after storage succeeds, including removal of mixed-model evidence.
    sessionRevisions.set(key, input.updatedAt)
    setVersion((value) => value + 1)
  })
}

async function appendOutcome(outcome: ModelOutcome, updatedAt?: number) {
  const existing = await readOutcomes(outcome.projectId)
  const previous = existing.find((item) => item.id === outcome.id)
  if (updatedAt !== undefined && !Number.isFinite(updatedAt)) return
  if (previous?.workspaceVersion) return
  // A later title settlement can update terminal workspace spend; stale snapshots cannot replace newer evidence.
  if (previous && (updatedAt === undefined || updatedAt <= (previous.sessionUpdatedAt ?? -1))) return
  await writeOutcomes(outcome.projectId, [
    ...existing.filter((item) => item.id !== outcome.id),
    { ...outcome, ...(updatedAt === undefined ? {} : { sessionUpdatedAt: updatedAt }) },
  ])
  setVersion((value) => value + 1)
}

/**
 * Forgets a project's recorded outcomes, or one session's, when the owner erases what Vector learned there or resets
 * workflow insights. The recommender and learned workflow defaults read separate data, so erasing one clears both.
 */
export function clearOutcomes(projectId: string, input: { readonly sessionID?: string } = {}): Promise<void> {
  return queueOutcome(projectId, async () => {
    const sessionID = input.sessionID
    const kept = sessionID
      ? (await readOutcomes(projectId)).filter(
          (outcome) => outcome.id !== `session:${sessionID}` && outcome.workspaceVersion?.sessionID !== sessionID,
        )
      : []
    await writeOutcomes(projectId, kept)
    setVersion((value) => value + 1)
  }).catch(() => undefined)
}

// Filter at the storage boundary so every consumer, including exports and model rankings, sees the same history.
export async function listOutcomes(projectId: string): Promise<ModelOutcome[]> {
  return readOutcomes(projectId).catch(() => [])
}

// Older samples named the runtime as their provider and lack the durable exclusion mark. Keep retired labels too.
const OWN_AGENT_NAMES = new Set(
  [
    ...ExternalAgent.catalog.flatMap((agent) => [agent.id, agent.name]),
    "Cursor Agent",
    "Kilo Code",
    "Droid",
    "Antigravity CLI",
    "antigravity",
  ].map((name) => name.toLowerCase()),
)

function eligibleOutcome(outcome: ModelOutcome) {
  return !ExternalAgent.excludedFromLearning(outcome) && !OWN_AGENT_NAMES.has(outcome.provider?.toLowerCase() ?? "")
}

// A project's outcome history that stays current as new outcomes are recorded. A signal rather than a resource:
// outcomes are refreshed after sessions finish new work, and reading a resource while it refetches would suspend the
// page around the reader.
export function createOutcomes(projectId: () => string) {
  const [outcomes, setOutcomes] = createSignal<ModelOutcome[]>([])
  createEffect(() => {
    const id = projectId()
    version()
    void listOutcomes(id).then((list) => {
      if (projectId() === id) setOutcomes(list)
    })
  })
  return outcomes
}

// The real evidence record parallel workspaces produce is the renderer-side
// ParallelWorkspaceRecord type in pages/layout-new.tsx. That type isn't
// exported (and this module doesn't own that file), so this is the minimal
// structural subset this mapper actually reads — any real
// ParallelWorkspaceRecord satisfies it.
export type WorkspaceRecordForEconomics = {
  id: string
  runtime?: string
  excludedFromLearning?: boolean
  provider: string
  model: string
  sourcePath: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  validationPassed?: boolean
  validationReport?: { hadChecks: boolean; passed: boolean }
  status?: string
}

export function isTerminalWorkspace(record: Pick<WorkspaceRecordForEconomics, "status">) {
  return ["complete", "failed", "needs review", "stopped", "merged", "discarded"].includes(record.status ?? "")
}

export function outcomesFromWorkspaceRecord(
  record: WorkspaceRecordForEconomics,
  category: TaskCategory,
  measured?: MeasuredUsage,
  spend?: SessionSpend,
  timing?: MeasuredLatency,
): ModelOutcome | undefined {
  if (Billing.isCodium(record.provider) || measured?.codium || spend?.codiumSteps || spend?.subagentCodiumSteps)
    return undefined
  if (ExternalAgent.excludedFromLearning(record)) return undefined
  // Keep cumulative history, but validation is not evidence for the requested model when observed work disagrees.
  const attributable = !measured || (measured.provider === record.provider && measured.model === record.model)
  // Workspace age changes on refresh, validation and integration. Only actual reply history supplies timing.
  // Message history omits ancillary and delegated work. Without authoritative session totals the full cost is unknown.
  const costUsd = totalSessionCost(spend, measured?.costUsd)

  return {
    id: record.id,
    projectId: record.sourcePath,
    provider: attributable ? record.provider : undefined,
    model: attributable ? record.model : undefined,
    mixedModels: measured?.mixedModels,
    variant: attributable ? measured?.variant : undefined,
    category,
    createdAt: Date.now(),
    checksPassed: record.validationPassed ?? record.validationReport?.passed,
    hadChecks: record.validationReport?.hadChecks ?? false,
    execution:
      record.status === "failed"
        ? "failed"
        : record.status === "stopped"
          ? "aborted"
          : record.status === "complete" || record.status === "needs review" || record.status === "merged"
            ? "completed"
            : undefined,
    ...timing,
    changedFiles: record.changedFilesCount,
    usage: measured?.usage,
    costUsd,
    ...(costUsd !== undefined ? { costPriced: !measured?.partial } : {}),
  }
}
import { Billing } from "@vectordevai/schema/billing"
