import { createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { Session } from "@vectordevai/sdk/v2"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import type { DirectorySync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { modelDisplayName } from "@/utils/provider-brand"
import { isInternalSession } from "@/utils/internal-sessions"
import { loadDismissed, saveDismissed } from "./background-tasks-state"
import { NO_CAPABILITIES, type EngineCapabilities } from "./engine-capabilities"
import {
  appendTaskConflicts,
  appendTaskContinuation,
  mergeTaskBoard,
  promotableAgents,
  promotesBatch,
  stoppableAgents,
} from "./task-board-model"
import { english, readLimits, type TaskTranslate } from "./task-limits"
import {
  buildTaskCards,
  freshestSession,
  idleLiveSessions,
  isDismissed,
  isInterrupted,
  isLive,
  liveAgentCount,
  runningAgentCount,
  taskPartLocations,
  waitingAgentCount,
  type TaskAgent,
  type TaskCard,
  type TaskLocation,
  type TaskSource,
} from "./subagent-model"

// ---------------------------------------------------------------------------
// Requests (5.I.3). Pure over a client, so the pane, the chips and their tests share one behaviour.

export type TaskActionsClient = {
  experimental: {
    session: Pick<VectorClient["experimental"]["session"], "background">
    task: Pick<VectorClient["experimental"]["task"], "background" | "resume" | "merge" | "discard" | "changes">
    workflow: Pick<VectorClient["experimental"]["workflow"], "resume">
  }
}

/** Route 3 takes at most 32 task IDs per request. */
export const RESUME_CHUNK = 32

function chunks<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

/** The HTTP status and body the SDK keeps on an error thrown with `throwOnError`. */
function errorCause(error: unknown) {
  if (!(error instanceof Error)) return undefined
  const cause = error.cause as { status?: unknown; body?: { code?: unknown } } | undefined
  return {
    status: typeof cause?.status === "number" ? cause.status : undefined,
    code: typeof cause?.body?.code === "string" ? cause.body.code : undefined,
  }
}

/** A refusal for a principal who is not the server owner: merge, discard and workflow resume are owner-only (I11). */
export function ownerOnlyRefusal(error: unknown) {
  return errorCause(error)?.status === 403
}

/**
 * Move to background. With `taskPromote`, route 2 moves the named tasks, batch entries included, and answers which it
 * moved. Without it, the old route moves a single blocking subagent and answers a boolean. Resolves false when nothing
 * moved, so the caller can say so.
 */
export async function promoteRequest(input: {
  client: TaskActionsClient
  sessionID: string
  taskIDs: readonly string[]
  taskPromote: boolean
}): Promise<boolean> {
  if (input.taskPromote) {
    const result = await input.client.experimental.task.background(
      { sessionID: input.sessionID, taskIDs: [...input.taskIDs] },
      { throwOnError: true },
    )
    return (result.data?.tasks.length ?? 0) > 0
  }
  const result = await input.client.experimental.session.background(
    { sessionID: input.sessionID },
    { throwOnError: true },
  )
  return result.data === true
}

export type ResumeOutcome = {
  requested: number
  /** The tasks the engine resumed, as it observed them after the start. */
  resumed: readonly Task.Info[]
  /** IDs asked for that came back in no result: refused, or in a request that failed. */
  missing: readonly string[]
  /** The first failed request's error; the requests before it stand. */
  error?: unknown
}

/**
 * Route 3 in chunks of 32. The engine resumes a request's IDs all or none, so a failed chunk leaves its IDs missing
 * while earlier chunks stand; a later chunk is not sent after a failure. A result that lists fewer tasks than asked
 * is a partial resume too.
 */
export async function resumeRequest(input: {
  client: TaskActionsClient
  sessionID: string
  taskIDs: readonly string[]
  text?: string
}): Promise<ResumeOutcome> {
  const ids = [...new Set(input.taskIDs)]
  const resumed: Task.Info[] = []
  let error: unknown
  for (const taskIDs of chunks(ids, RESUME_CHUNK)) {
    const result = await input.client.experimental.task
      .resume(
        { sessionID: input.sessionID, taskIDs: [...taskIDs], ...(input.text ? { text: input.text } : {}) },
        { throwOnError: true },
      )
      .catch((cause: unknown) => {
        error = cause
        return undefined
      })
    if (error !== undefined) break
    resumed.push(...(result?.data?.tasks ?? []))
  }
  const done = new Set(resumed.flatMap((task) => [task.id, task.sessionID ?? task.id]))
  return {
    requested: ids.length,
    resumed,
    missing: ids.filter((id) => !done.has(id)),
    ...(error !== undefined ? { error } : {}),
  }
}

/** Route 4: an isolated child's changed files, with the patch for the owner. */
export async function changesRequest(input: { client: TaskActionsClient; sessionID: string; taskID: string }) {
  const result = await input.client.experimental.task.changes(
    { sessionID: input.sessionID, taskID: input.taskID, diff: "true" },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The changes are unavailable.")
  return result.data
}

/** Route 5 (owner only): brings the child's saved changes, or the named files, into the checkout. */
export async function mergeRequest(input: {
  client: TaskActionsClient
  sessionID: string
  taskID: string
  files?: readonly string[]
}) {
  const result = await input.client.experimental.task.merge(
    { sessionID: input.sessionID, taskID: input.taskID, ...(input.files?.length ? { files: [...input.files] } : {}) },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The merge result is unavailable.")
  return result.data
}

/** Route 6 (owner only): keeps a recovery copy, then removes the child's worktree and branch. */
export async function discardRequest(input: { client: TaskActionsClient; sessionID: string; taskID: string }) {
  const result = await input.client.experimental.task.discard(
    { sessionID: input.sessionID, taskID: input.taskID, reason: "Discarded by the user" },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The discard result is unavailable.")
  return result.data
}

/** "Continue with this message": route 3 with text, which also continues a completed child (5.D.3 check 4). */
export function continueRequest(input: { client: TaskActionsClient; sessionID: string; taskID: string; text: string }) {
  return resumeRequest({ client: input.client, sessionID: input.sessionID, taskIDs: [input.taskID], text: input.text })
}

/** Route 12 (owner only): resumes a workflow run, reusing its finished agents and retrying failed ones. */
export async function resumeRunRequest(input: { client: TaskActionsClient; sessionID: string; runID: string }) {
  const result = await input.client.experimental.workflow.resume(
    { sessionID: input.sessionID, runID: input.runID, workflowResumeInput: { retryFailed: true } },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The workflow run did not resume.")
  return result.data
}

/** The folder that holds a background command's log, with the server's own separators. */
export function outputFolder(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return cut > 0 ? path.slice(0, cut) : path
}

export type BackgroundTasks = {
  /** The top of the open session's family: its own id, or its parent's when a subagent is open. */
  rootID: Accessor<string | undefined>
  cards: Accessor<readonly TaskCard[]>
  live: Accessor<readonly TaskCard[]>
  /** Finished cards the trash has not hidden. */
  finished: Accessor<readonly TaskCard[]>
  /** Agents running, waiting or queued: what keeps the clock ticking. */
  liveCount: Accessor<number>
  /** Agents running or waiting on you, for the header badge. Queued ones have not started. */
  runningCount: Accessor<number>
  /** Agents with an unanswered permission or question. */
  waitingCount: Accessor<number>
  /** A shared one-second clock that only ticks while something is live. */
  now: Accessor<number>
  locate(partID: string): TaskLocation | undefined
  stop(card: TaskCard): Promise<void>
  /** Task identities of stoppable background agents, including desktop runners. */
  liveBackground: Accessor<readonly string[]>
  /** Stops every background agent still running in this session's family. */
  stopAllBackground(): Promise<void>
  openAgent(agent: TaskAgent): void
  canOpenAgent(agent: TaskAgent): boolean
  clearFinished(): void
  /** Brings back a card the trash hid, when a chip asks for it. */
  undismiss(cardKey: string): void
  /** While the caller is mounted, keep these agents' sessions cached and load old ones that have no usage record. */
  hold(agents: Accessor<readonly TaskAgent[]>): void
  inspect(agent: TaskAgent): Promise<Task.InspectResult>
  message(agent: TaskAgent, text: string): Promise<Task.MessageResult>
  stopAgent(agent: TaskAgent): Promise<void>
  ask(agent: TaskAgent): void
  refreshing: Accessor<boolean>
  error: Accessor<string | undefined>
  draft(agent: TaskAgent): string
  setDraft(agent: TaskAgent, text: string): void
  /** The engine's capability flags for this server; all off when unknown. */
  capabilities: Accessor<EngineCapabilities>
  /** The conversation's limits line data, sent only to the owner by an engine with `subagentLimits`. */
  limits: Accessor<Task.Limits | undefined>
  /** Background commands of the root session, from an engine with `backgroundShells`. */
  shells: Accessor<readonly Task.Shell[]>
  /** Helpers a restart interrupted that are neither resumed nor dismissed, once each. */
  interrupted: Accessor<readonly TaskAgent[]>
  /** Of these agents, the ones Move to background can move. */
  promotable(agents: readonly TaskAgent[]): TaskAgent[]
  /** True when the engine can move only a single subagent and these are a batch. */
  promoteBlocked(agents: readonly TaskAgent[]): boolean
  /** Moves them to the background; false (after a toast) when nothing moved. */
  promote(agents: readonly TaskAgent[]): Promise<boolean>
  /** Resumes stopped or interrupted helpers (route 3); a toast reports a partial resume. */
  resume(agents: readonly TaskAgent[], text?: string): Promise<ResumeOutcome>
  /** Fills the root composer with "continue it", an agent part naming its subagent type, and the draft. */
  askToContinue(agent: TaskAgent): void
  changes(agent: TaskAgent): Promise<Task.ChangesResult>
  merge(agent: TaskAgent): Promise<Task.MergeResult>
  discard(agent: TaskAgent): Promise<Task.DiscardResult>
  /** Fills the root composer with a request to resolve a merge's conflicts. */
  resolveConflicts(agent: TaskAgent, conflicts: readonly string[]): void
  stopShell(shell: Task.Shell): Promise<void>
  canOpenOutput(shell: Task.Shell): boolean
  openOutput(shell: Task.Shell): void
  /** While the caller is mounted, load this workflow run's agents and keep them current with the board. */
  watchRun(runID: Accessor<string | undefined>): void
  runLoading(runID: string): boolean
  canResumeRun(run: TaskAgent): boolean
  resumeRun(run: TaskAgent): Promise<void>
}

export type BackgroundTasksInput = {
  /** The open session. */
  sessionID: Accessor<string | undefined>
  sync: Accessor<DirectorySync>
  client: Accessor<VectorClient>
  /** Counts the event stream's reconnects; whatever happened while it was down never arrives as events. */
  reconnects: Accessor<number>
  /** Keeps a session cached while something shows it. */
  pin(sessionID: string): void
  unpin(sessionID: string): void
  /** Opens a session's page. */
  open(sessionID: string): void
  ask?(agent: TaskAgent, rootID: string): void
  /** Changes the root session's composer draft and focuses it, opening the root when a subagent is open. */
  compose?(rootID: string, change: (prompt: Prompt) => Prompt): void
  openDesktop?(task: Task.Info): void
  /** Opens a local folder in the file manager (desktop only; the app opens folders, never files). */
  openPath?(path: string): Promise<void>
  /** Whether the server runs on this computer, so the paths it reports are local ones. Nothing is opened otherwise. */
  local?: Accessor<boolean>
  capabilities?: Accessor<EngineCapabilities>
  /** The language's translator; English when absent. */
  t?: TaskTranslate
  desktop?: {
    api: NonNullable<NonNullable<Window["api"]>["agentTasks"]>
    sourcePath: Accessor<string>
  }
}

/** The Background tasks state for the open session's family, built from the session store and kept current. */
export function createBackgroundTasks(input: BackgroundTasksInput): BackgroundTasks {
  const rootID = createMemo(() => {
    let id = input.sessionID()
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const parent = input.sync().session.get(id)?.parentID
      if (!parent) return id
      id = parent
    }
    return id
  })

  // With a subagent open, the task parts live in the parent's history.
  createEffect(
    on(rootID, (root) => {
      if (!root || root === input.sessionID() || input.sync().data.message[root]) return
      void input
        .sync()
        .session.sync(root)
        .catch(() => undefined)
    }),
  )

  // The children route covers subagents whose task parts sit in history pages
  // that are not loaded. A reconnected stream fetches it again, since the
  // records it missed only arrive that way for children nothing else loads.
  const [fetched, setFetched] = createSignal<readonly Session[]>([])
  createEffect(
    on([rootID, input.reconnects], (current, previous) => {
      const root = current[0]
      if (root !== previous?.[0]) setFetched([])
      if (!root) return
      let alive = true
      onCleanup(() => {
        alive = false
      })
      Promise.resolve(input.client().session.children({ sessionID: root }))
        .then((result) => {
          if (alive) setFetched(result?.data ?? [])
        })
        .catch(() => undefined)
    }),
  )
  const fetchedByID = createMemo(() => new Map(fetched().map((session) => [session.id, session])))
  const t = input.t ?? english
  const capabilities = () => input.capabilities?.() ?? NO_CAPABILITIES
  const [board, setBoard] = createStore<{
    tasks: readonly Task.Info[]
    desktop: readonly Task.Info[]
    /** Workflow runs' agents, loaded while a run's stages are shown (`task.list` on the run). */
    runs: Record<string, readonly Task.Info[]>
    limits?: Task.Limits
    shells: readonly Task.Shell[]
    refreshing: boolean
    truncated: { engine: boolean; desktop: boolean }
    error?: string
  }>({
    tasks: [],
    desktop: [],
    runs: {},
    shells: [],
    refreshing: false,
    truncated: { engine: false, desktop: false },
  })
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  // Runs whose stages are on screen, with how many views hold each, and the ones loading for the first time.
  const watched = new Map<string, number>()
  const [loadingRuns, setLoadingRuns] = createStore<Record<string, boolean>>({})
  let boardRequest = 0
  const loadRun = async (sessionID: string, runID: string, request: number) => {
    if (!board.runs[runID]) setLoadingRuns(runID, true)
    const result = await input
      .client()
      .experimental.task.list({ sessionID: runID })
      .catch(() => undefined)
    setLoadingRuns(runID, false)
    if (request !== boardRequest || rootID() !== sessionID || !watched.has(runID)) return
    if (result?.data && Array.isArray(result.data.tasks)) setBoard("runs", runID, result.data.tasks)
  }
  const refreshBoard = async () => {
    const sessionID = rootID()
    if (!sessionID) return
    const request = ++boardRequest
    setBoard("refreshing", true)
    const shells = capabilities().backgroundShells
    for (const runID of watched.keys()) void loadRun(sessionID, runID, request)
    const [result, desktop] = await Promise.all([
      input
        .client()
        .experimental.task.list({ sessionID, descendants: "true", ...(shells ? { shells: "true" as const } : {}) })
        .catch(() => undefined),
      input.desktop?.api
        .list({ parentSessionID: sessionID, sourcePath: input.desktop.sourcePath() })
        .catch(() => undefined),
    ])
    if (request !== boardRequest || rootID() !== sessionID) return
    const observed = result?.data && Array.isArray(result.data.tasks) ? result.data : undefined
    const local = desktop && Array.isArray(desktop.tasks) ? desktop : undefined
    setBoard("refreshing", false)
    if (local) {
      setBoard("desktop", local.tasks)
      setBoard("truncated", "desktop", local.truncated)
    }
    if (observed) {
      setBoard("truncated", "engine", observed.truncated)
      // Each answer replaces both: a guest's or an older engine's has neither, and none may linger.
      setBoard("limits", readLimits(observed.limits))
      setBoard("shells", Array.isArray(observed.shells) ? observed.shells : [])
    }
    if (input.desktop && !local && board.desktop.length) {
      setBoard("error", "Desktop task updates unavailable. Showing the last known state.")
      if (observed) setBoard("tasks", observed.tasks)
      return
    }
    if (!observed) {
      if (board.tasks.length) setBoard("error", "Task updates unavailable. Showing the last known state.")
      if (!board.tasks.length && local?.truncated)
        setBoard("error", "Showing the most recent tasks. Open a child session for more.")
      return
    }
    setBoard("tasks", observed.tasks)
    setBoard(
      "error",
      board.truncated.engine || board.truncated.desktop
        ? "Showing the most recent tasks. Open a child session for more."
        : undefined,
    )
  }
  createEffect(
    on(rootID, () => {
      boardRequest += 1
      setBoard({
        tasks: [],
        desktop: [],
        limits: undefined,
        shells: [],
        refreshing: false,
        truncated: { engine: false, desktop: false },
        error: undefined,
      })
      setBoard("runs", reconcile({}))
    }),
  )

  const children = createMemo(() => {
    const root = rootID()
    if (!root) return [] as Session[]
    const found = new Map<string, Session>()
    // Vector's helpers (a Vectorscope review, autocomplete) are children too, but they are not the user's background
    // work; their spend is in the session's cost instead.
    for (const session of fetched())
      if (session.parentID === root && !isInternalSession(session)) found.set(session.id, session)
    for (const session of input.sync().data.session)
      if (session.parentID === root && !isInternalSession(session)) found.set(session.id, session)
    // The store follows live events and the fetch is a snapshot: whichever the engine updated last is current.
    return [...found.values()].map(
      (session) => freshestSession(input.sync().session.get(session.id), fetchedByID().get(session.id)) ?? session,
    )
  })
  // Refresh on engine events and reconnects, never on a polling interval. Batch
  // simultaneous child updates so a provider turn makes one observation request.
  createEffect(() => {
    const parent = rootID()
    if (parent) input.sync().session.get(parent)?.time.updated
    input.reconnects()
    children().forEach((child) => {
      child.time.updated
      input.sync().data.session_status[child.id]
      input.sync().data.permission[child.id]?.length
      input.sync().data.question[child.id]?.length
    })
    const timer = setTimeout(() => void refreshBoard(), 150)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => {
    boardRequest += 1
  })
  if (input.desktop) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = input.desktop.api.onChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshBoard(), 150)
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  }

  const source = (root: string): TaskSource => ({
    rootID: root,
    messages: (id) => input.sync().data.message[id],
    parts: (id) => input.sync().data.part[id],
    session: (id) => freshestSession(input.sync().session.get(id), fetchedByID().get(id)),
    children: children(),
    status: (id) => input.sync().data.session_status[id],
    waiting: (id) =>
      (input.sync().data.permission[id]?.length ?? 0) > 0 || (input.sync().data.question[id]?.length ?? 0) > 0,
    modelName: (providerID, modelID) => {
      const provider = input.sync().data.provider?.all?.get(providerID)
      const model = provider?.models?.[modelID]
      return provider && model ? modelDisplayName({ ...model, provider }) : undefined
    },
  })

  // Reconciled by key so cards, phases and agents keep their identity across
  // updates: the list never remounts and open phases stay open.
  const [state, setState] = createStore({ cards: [] as TaskCard[] })
  // This runs inside the session page, so a part in a shape nobody expected
  // keeps the last good list instead of taking the page down.
  createComputed(() => {
    const root = rootID()
    let next: TaskCard[] = []
    try {
      const current = root ? source(root) : undefined
      next = current
        ? mergeTaskBoard(
            buildTaskCards(current),
            [...board.tasks, ...board.desktop, ...Object.values(board.runs).flat()],
            { modelName: current.modelName },
          )
        : []
    } catch (error) {
      console.error("[background-tasks] could not read subagents", error)
      return
    }
    setState("cards", reconcile(next, { key: "key" }))
  })

  // A card left live by an engine restart, or by events lost while the
  // stream was down, only settles from a fresh copy of the child: its record
  // and its last reply. After a reload an idle child has no session_status
  // entry, and messages already cached can be the stale part, so reload each
  // such agent once, pane open or not, and once more after each reconnect.
  const settling = new Set<string>()
  let settlingRound = 0
  createEffect(() => {
    const round = input.reconnects()
    if (round !== settlingRound) settling.clear()
    settlingRound = round
    const agents = state.cards.flatMap((card) => card.agents)
    for (const id of idleLiveSessions(agents, (sessionID) => input.sync().data.session_status[sessionID]?.type)) {
      if (settling.has(id)) continue
      settling.add(id)
      void input
        .sync()
        .session.sync(id, { force: true })
        .catch(() => undefined)
    }
  })

  // The open session, its family's root (whose history holds the task parts)
  // and the children whose messages are loaded all missed whatever happened
  // while the stream was down.
  createEffect(
    on(
      input.reconnects,
      () => {
        const loaded = children().flatMap((child) => (input.sync().data.message[child.id] ? [child.id] : []))
        for (const id of new Set([input.sessionID(), rootID(), ...loaded])) {
          if (!id) continue
          void input
            .sync()
            .session.sync(id, { force: true })
            .catch(() => undefined)
        }
      },
      { defer: true },
    ),
  )

  const index = createMemo(() => taskPartLocations(state.cards))

  const liveCount = createMemo(() => liveAgentCount(state.cards))
  const runningCount = createMemo(() => runningAgentCount(state.cards))
  const waitingCount = createMemo(() => waitingAgentCount(state.cards))
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (liveCount() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return
      setNow(Date.now())
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const [dismissed, setDismissed] = createSignal<Record<string, number>>({})
  createEffect(on(rootID, (root) => setDismissed(root ? loadDismissed(root) : {})))

  const live = createMemo(() => state.cards.filter((card) => card.live))
  const finished = createMemo(() => {
    const hidden = dismissed()
    return state.cards.filter((card) => !card.live && !isDismissed(card, hidden[card.key]))
  })

  const clearFinished = () => {
    const root = rootID()
    if (!root) return
    const at = Date.now()
    const next = { ...dismissed() }
    for (const card of finished()) next[card.key] = Math.max(at, card.endedAt ?? 0)
    setDismissed(next)
    saveDismissed(root, next)
  }

  const undismiss = (cardKey: string) => {
    const root = rootID()
    const current = dismissed()
    if (!root || !(cardKey in current)) return
    const next = { ...current }
    delete next[cardKey]
    setDismissed(next)
    saveDismissed(root, next)
  }

  const stopSessions = async (ids: readonly string[]) => {
    const client = input.client()
    const results = await Promise.allSettled(
      ids.map((sessionID) =>
        Promise.resolve(client.session.abort({ sessionID })).then((result) => {
          const error = (result as { error?: unknown } | undefined)?.error
          if (error) throw error
        }),
      ),
    )
    // Reload what the cards are built from, so Stop always shows where each
    // agent really is, even with the event stream down. An agent whose run the
    // engine lost (it restarted mid-run) is settled as stopped by the abort.
    const root = rootID()
    await Promise.allSettled(
      [...ids, ...(root ? [root] : [])].map((sessionID) => input.sync().session.sync(sessionID, { force: true })),
    )
    if (results.every((result) => result.status === "fulfilled")) return
    showToast({
      variant: "error",
      title: "Could not stop every subagent",
      description: "Try again, or stop the whole session from the composer.",
    })
  }

  const stop = async (card: TaskCard) => {
    const results = await Promise.allSettled(stoppableAgents(card.agents).map(stopAgent))
    if (results.some((result) => result.status === "rejected"))
      showToast({
        variant: "error",
        title: "Could not stop every subagent",
        description: "Open its details to retry. Partial work has been kept.",
      })
  }
  const liveBackground = createMemo(() => [
    ...new Set(
      stoppableAgents(
        state.cards.flatMap((card) => card.agents).filter((agent) => agent.background && isLive(agent.status)),
      ).flatMap((agent) => agent.task?.id ?? agent.sessionID ?? []),
    ),
  ])
  const stopAllBackground = async () => {
    if (board.truncated.engine || board.truncated.desktop) {
      showToast({
        variant: "error",
        title: "The task list is incomplete",
        description: "Stop the visible tasks individually, or open a child session to manage its workers.",
      })
      return
    }
    const agents = state.cards
      .flatMap((card) => card.agents)
      .filter((agent) => agent.background && isLive(agent.status) && agent.task?.controls.stop !== false)
    const stopped = await Promise.allSettled(stoppableAgents(agents).map(stopAgent))
    if (stopped.some((result) => result.status === "rejected"))
      showToast({
        variant: "error",
        title: "Could not stop every subagent",
        description: "Open its details to retry. Partial work has been kept.",
      })
  }

  const desktopAgent = (agent: TaskAgent) => agent.task && /^(workspace|swarm):/.test(agent.task.id)
  const canOpenAgent = (agent: TaskAgent) =>
    desktopAgent(agent) ? Boolean(input.desktop && input.openDesktop) : Boolean(agent.sessionID)
  const openAgent = (agent: TaskAgent) => {
    if (desktopAgent(agent)) {
      if (input.desktop && agent.task) input.openDesktop?.(agent.task)
      return
    }
    if (!agent.sessionID) return
    input.open(agent.sessionID)
  }

  const inspect = async (agent: TaskAgent) => {
    const sessionID = rootID()
    const taskID = agent.task?.id ?? agent.sessionID
    if (!sessionID || !taskID) throw new Error("This task is not available yet.")
    if (input.desktop && board.desktop.some((task) => task.id === taskID))
      return input.desktop.api.inspect({ parentSessionID: sessionID, sourcePath: input.desktop.sourcePath(), taskID })
    const result = await input.client().experimental.task.inspect({ sessionID, taskID }, { throwOnError: true })
    if (!result.data) throw new Error("The task details are unavailable.")
    return result.data
  }
  const message = async (agent: TaskAgent, text: string) => {
    const sessionID = rootID()
    const taskID = agent.task?.id ?? agent.sessionID
    if (!sessionID || !taskID) throw new Error("This task is not available yet.")
    if (input.desktop && board.desktop.some((task) => task.id === taskID)) {
      const result = await input.desktop.api.message({
        parentSessionID: sessionID,
        sourcePath: input.desktop.sourcePath(),
        taskID,
        text,
      })
      await refreshBoard()
      return result
    }
    const result = await input
      .client()
      .experimental.task.message({ sessionID, taskID, text, delivery: "steer" }, { throwOnError: true })
    if (!result.data) throw new Error("The message was not accepted. Your draft has been kept.")
    await refreshBoard()
    return result.data
  }
  async function stopAgent(agent: TaskAgent) {
    const sessionID = rootID()
    if (!sessionID) return
    if (!agent.task) {
      if (agent.sessionID) await stopSessions([agent.sessionID])
      return
    }
    if (input.desktop && board.desktop.some((task) => task.id === agent.task?.id)) {
      await input.desktop.api.stop({
        parentSessionID: sessionID,
        sourcePath: input.desktop.sourcePath(),
        taskID: agent.task.id,
      })
      await refreshBoard()
      return
    }
    await input
      .client()
      .experimental.task.stop(
        { sessionID, taskIDs: [agent.task.id], reason: "Stopped by the user" },
        { throwOnError: true },
      )
    await refreshBoard()
  }

  const attempted = new Set<string>()
  const hold = (agents: Accessor<readonly TaskAgent[]>) => {
    const ids = createMemo(() =>
      [...new Set(agents().flatMap((agent) => (agent.sessionID ? [agent.sessionID] : [])))].sort().join("\n"),
    )
    createEffect(
      on(ids, (value) => {
        const list = value ? value.split("\n") : []
        for (const id of list) input.pin(id)
        onCleanup(() => {
          for (const id of list) input.unpin(id)
        })
      }),
    )
    // Sessions from before the lifecycle record only know their tokens from
    // their own messages, which the cache may have evicted.
    createEffect(() => {
      for (const agent of agents()) {
        const id = agent.sessionID
        if (!id || isLive(agent.status) || agent.tokens !== undefined || attempted.has(id)) continue
        if (input.sync().data.message[id]) continue
        attempted.add(id)
        void input
          .sync()
          .session.sync(id)
          .catch(() => undefined)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // 1.99.113 controls (5.I.3)

  const actions = (): TaskActionsClient => input.client()
  const taskID = (agent: TaskAgent) => agent.task?.id ?? agent.sessionID
  const reload = async () => {
    const root = rootID()
    await Promise.allSettled([refreshBoard(), ...(root ? [input.sync().session.sync(root, { force: true })] : [])])
  }
  const failure = (title: string, error: unknown) =>
    showToast({
      variant: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    })

  const interrupted = createMemo(() => {
    const seen = new Set<string>()
    return state.cards
      .flatMap((card) => card.agents)
      .filter((agent) => {
        const id = taskID(agent)
        if (!id || seen.has(id) || !isInterrupted(agent)) return false
        seen.add(id)
        return true
      })
  })

  const promotable = (agents: readonly TaskAgent[]) => promotableAgents(agents, rootID())
  const promoteBlocked = (agents: readonly TaskAgent[]) =>
    !capabilities().taskPromote && promotesBatch(promotable(agents))
  const promote = async (agents: readonly TaskAgent[]) => {
    const sessionID = rootID()
    const targets = promotable(agents)
    if (!sessionID || !targets.length || promoteBlocked(agents)) return false
    const moved = await promoteRequest({
      client: actions(),
      sessionID,
      taskIDs: targets.map((agent) => agent.task!.id),
      taskPromote: capabilities().taskPromote,
    }).catch((error: unknown) => {
      failure(t("backgroundTasks.promote.failed.title"), error)
      return undefined
    })
    if (moved === false)
      showToast({
        variant: "error",
        title: t("backgroundTasks.promote.none.title"),
        description: t("backgroundTasks.promote.none.description"),
      })
    await reload()
    return moved === true
  }

  const resume = async (agents: readonly TaskAgent[], text?: string) => {
    const sessionID = rootID()
    const ids = [...new Set(agents.flatMap((agent) => taskID(agent) ?? []))]
    if (!sessionID || !ids.length) return { requested: 0, resumed: [], missing: [] }
    const outcome = await resumeRequest({ client: actions(), sessionID, taskIDs: ids, text })
    if (outcome.missing.length && outcome.resumed.length)
      showToast({
        variant: "error",
        title: t("backgroundTasks.resume.partial.title", {
          resumed: outcome.resumed.length,
          requested: outcome.requested,
        }),
        description:
          outcome.error instanceof Error ? outcome.error.message : t("backgroundTasks.resume.partial.description"),
      })
    else if (outcome.missing.length)
      failure(
        t("backgroundTasks.resume.failed.title"),
        outcome.error ?? new Error(t("backgroundTasks.resume.partial.description")),
      )
    await reload()
    return outcome
  }

  const compose = (change: (prompt: Prompt) => Prompt) => {
    const root = rootID()
    if (root) input.compose?.(root, change)
  }
  const askToContinue = (agent: TaskAgent) =>
    compose((prompt) => appendTaskContinuation(prompt, agent, drafts[taskID(agent) ?? agent.key] ?? ""))
  const resolveConflicts = (agent: TaskAgent, conflicts: readonly string[]) =>
    compose((prompt) => appendTaskConflicts(prompt, agent, conflicts))

  const isolated = async <T>(agent: TaskAgent, run: (sessionID: string, taskID: string) => Promise<T>) => {
    const sessionID = rootID()
    const id = agent.task?.id
    if (!sessionID || !id) throw new Error("This task is not available yet.")
    return run(sessionID, id)
  }
  const changes = (agent: TaskAgent) =>
    isolated(agent, (sessionID, id) => changesRequest({ client: actions(), sessionID, taskID: id }))
  const merge = (agent: TaskAgent) =>
    isolated(agent, (sessionID, id) => mergeRequest({ client: actions(), sessionID, taskID: id })).finally(() =>
      reload(),
    )
  const discard = (agent: TaskAgent) =>
    isolated(agent, (sessionID, id) => discardRequest({ client: actions(), sessionID, taskID: id })).finally(() =>
      reload(),
    )

  const stopShell = async (shell: Task.Shell) => {
    const sessionID = rootID()
    if (!sessionID) return
    await input
      .client()
      .experimental.task.stop({ sessionID, taskIDs: [shell.id], reason: "Stopped by the user" }, { throwOnError: true })
      .catch((error: unknown) => failure(t("backgroundTasks.shells.stopFailed"), error))
    await refreshBoard()
  }
  // The log is a file and the desktop opens only folders, so Open output shows the folder that holds it.
  const canOpenOutput = (shell: Task.Shell) => !!shell.outputPath && !!input.openPath && input.local?.() === true
  const openOutput = (shell: Task.Shell) => {
    if (!shell.outputPath || !canOpenOutput(shell)) return
    void input
      .openPath?.(outputFolder(shell.outputPath))
      .catch((error: unknown) => failure(t("backgroundTasks.shells.openFailed"), error))
  }

  const watchRun = (runID: Accessor<string | undefined>) => {
    createEffect(
      on(runID, (id) => {
        const root = rootID()
        if (!id || !root) return
        watched.set(id, (watched.get(id) ?? 0) + 1)
        void loadRun(root, id, boardRequest)
        onCleanup(() => {
          const left = (watched.get(id) ?? 1) - 1
          if (left > 0) {
            watched.set(id, left)
            return
          }
          watched.delete(id)
          setBoard(
            "runs",
            produce((runs) => {
              delete runs[id]
            }),
          )
        })
      }),
    )
  }
  // A run that did not finish can be resumed by the owner (route 12), reusing its finished agents.
  const canResumeRun = (run: TaskAgent) =>
    capabilities().workflows &&
    run.task?.workflow?.role === "run" &&
    (run.task.controls.resume === true || run.status === "stopped" || run.status === "failed")
  const resumeRun = async (run: TaskAgent) => {
    const sessionID = rootID()
    const id = run.task?.id
    if (!sessionID || !id) return
    await resumeRunRequest({ client: actions(), sessionID, runID: id })
      .then(() => showToast({ variant: "success", title: t("backgroundTasks.workflow.resumed") }))
      .catch((error: unknown) =>
        ownerOnlyRefusal(error)
          ? showToast({ variant: "error", title: t("backgroundTasks.workflow.ownerOnly") })
          : failure(t("backgroundTasks.resume.failed.title"), error),
      )
    await reload()
  }

  return {
    rootID,
    cards: () => state.cards,
    live,
    finished,
    liveCount,
    runningCount,
    waitingCount,
    now,
    locate: (partID) => index().get(partID),
    stop,
    liveBackground,
    stopAllBackground,
    openAgent,
    canOpenAgent,
    clearFinished,
    undismiss,
    hold,
    inspect,
    message,
    stopAgent,
    ask: (agent) => {
      const root = rootID()
      if (root) input.ask?.(agent, root)
    },
    refreshing: () => board.refreshing,
    error: () => board.error,
    draft: (agent) => drafts[agent.task?.id ?? agent.sessionID ?? agent.key] ?? "",
    setDraft: (agent, text) => setDrafts(agent.task?.id ?? agent.sessionID ?? agent.key, text),
    capabilities,
    limits: () => board.limits,
    shells: () => board.shells,
    interrupted,
    promotable,
    promoteBlocked,
    promote,
    resume,
    askToContinue,
    changes,
    merge,
    discard,
    resolveConflicts,
    stopShell,
    canOpenOutput,
    openOutput,
    watchRun,
    runLoading: (runID) => loadingRuns[runID] === true,
    canResumeRun,
    resumeRun,
  }
}
