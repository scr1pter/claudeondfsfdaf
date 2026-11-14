// Ctrl+C and "Stop including helpers" for `vector run` (5.I.6).
//
// `interruptPlan` is the pure rule for one Ctrl+C in a non-interactive run attached to a terminal: the first press stops
// the main turn (everything with --stop-helpers), and a second press within 5 seconds stops everything and exits 130.
// Without --attach the engine runs in this process, and the terminal sends its interrupt to the whole process group:
// the engine's stdio MCP and LSP servers (and on Windows its background commands) get it too. Helpers left running
// would work without them, so there every press stops everything and exits.
// The split-footer mode (`--mini`) keeps its own two-press interrupt in footer.ts and only uses the SDK helpers below.
//
// Helper counts and stops go through the engine's routes, behind its capability flags. An engine without route 1
// gets today's abort, plus `task.stop {all}` when helpers should stop too.
import type { VectorClient } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import { interruptedTaskIDs, outdated, resumeTasks } from "../tasks"

export const INTERRUPT_WINDOW_MS = 5_000
export const INTERRUPT_EXIT_CODE = 130
const STOP_TIMEOUT_MS = 5_000
const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting_on_user"])

export type InterruptPlan = {
  /** "turn" stops only the main turn; "all" also stops every helper this conversation started. */
  stop: "turn" | "all"
  /** Exit with 130 once the stop has been sent. */
  exit: boolean
}

/**
 * What one Ctrl+C does. `previous` is the time of the press before it, if any. `inProcess`: the engine runs in this
 * process (no --attach), so the press also reached the processes it started.
 */
export function interruptPlan(input: {
  now: number
  previous?: number
  stopHelpers: boolean
  inProcess?: boolean
}): InterruptPlan {
  if (input.inProcess) return { stop: "all", exit: true }
  const again =
    input.previous !== undefined && input.now >= input.previous && input.now - input.previous <= INTERRUPT_WINDOW_MS
  if (again) return { stop: "all", exit: true }
  return { stop: input.stopHelpers ? "all" : "turn", exit: false }
}

/** Only a non-interactive run at a terminal handles Ctrl+C itself; SIGTERM and runs without a terminal are unchanged. */
export function handlesInterrupt(input: { interactive: boolean; workflow: boolean; tty: boolean }) {
  return !input.interactive && !input.workflow && input.tty
}

function helpers(count: number) {
  return count === 1 ? "1 helper" : `${count} helpers`
}

/** Printed after the first Ctrl+C when helpers keep running. */
export function helpersLeftMessage(count: number) {
  return `Stopped the main turn. ${helpers(count)} ${count === 1 ? "is" : "are"} still running. Press Ctrl+C again to stop them and exit.`
}

/** Shown in the split footer after an interrupt that left helpers running. */
export function helpersNotice(count: number) {
  return `${helpers(count)} still running · "Stop including helpers" in the command palette stops them`
}

/** What a "Stop including helpers" from the footer did. */
export function stoppedNotice(result: StopOutcome) {
  const parts = [
    result.helpers > 0 ? `Stopped ${helpers(result.helpers)}` : "No helpers were running",
    ...(result.shells > 0 ? [`${result.shells} background command${result.shells === 1 ? "" : "s"}`] : []),
  ]
  return `${parts.join(" and ")}.${result.excluded > 0 ? " Agent workspaces keep running; stop them from the Agent Dashboard." : ""}`
}

/**
 * Live helpers in a task listing: the session's own queued or running subagents that do not stop with the main turn
 * (foreground work ends with it), plus its running background commands. Desktop workspaces are not counted.
 */
export function liveHelpers(result: {
  tasks: readonly Pick<Task.Info, "source" | "status" | "background">[]
  shells?: readonly Pick<Task.Shell, "status">[]
}) {
  return (
    result.tasks.filter((task) => task.source === "subagent" && ACTIVE.has(task.status) && task.background !== false)
      .length + (result.shells ?? []).filter((shell) => shell.status === "running").length
  )
}

async function supports(client: VectorClient, flag: string, signal?: AbortSignal) {
  const capability = await client.experimental.capabilities
    .get(undefined, { throwOnError: false, signal: signal ?? AbortSignal.timeout(STOP_TIMEOUT_MS) })
    .catch(() => undefined)
  const data: unknown = capability?.response?.ok ? capability.data : undefined
  return !!data && typeof data === "object" && (data as Record<string, unknown>)[flag] === true
}

/** How many helpers keep running for `sessionID`; 0 when the engine cannot say. */
export async function countHelpers(client: VectorClient, sessionID: string, signal?: AbortSignal) {
  const listed = await client.experimental.task
    .list({ sessionID, active: "true", shells: "true" }, { throwOnError: true, signal })
    .then((result) => result.data)
    .catch(() => undefined)
  return listed ? liveHelpers(listed) : 0
}

export type StopOutcome = { aborted?: boolean; helpers: number; shells: number; excluded: number }

/**
 * Stops the main turn, and every helper with `helpers`. Route 1 fences the parent, so a helper's later report starts
 * no turn until the user writes again (I5). An engine without it gets the abort it had, then `task.stop {all}`.
 */
export async function stopSession(
  client: VectorClient,
  sessionID: string,
  input: { helpers: boolean; reason?: string; signal?: AbortSignal },
): Promise<StopOutcome> {
  if (await supports(client, "sessionStop", input.signal)) {
    const result = (
      await client.experimental.session.stop(
        { sessionID, helpers: input.helpers, ...(input.reason ? { reason: input.reason } : {}) },
        { throwOnError: true, signal: input.signal },
      )
    ).data
    return { aborted: result.aborted, helpers: result.tasks.length, shells: result.shells, excluded: result.excluded }
  }
  await client.session.abort({ sessionID }, { throwOnError: true, signal: input.signal })
  if (!input.helpers) return { helpers: 0, shells: 0, excluded: 0 }
  const stopped = await client.experimental.task
    .stop(
      { sessionID, all: true, ...(input.reason ? { reason: input.reason } : {}) },
      { throwOnError: true, signal: input.signal },
    )
    .then((result) => result.data.tasks.length)
    .catch(() => 0)
  return { helpers: stopped, shells: 0, excluded: 0 }
}

/** Resumes every helper a restart interrupted (D.3). Throws the update message on an engine without route 3. */
export async function resumeInterrupted(client: VectorClient, sessionID: string) {
  if (!(await supports(client, "taskResume"))) throw new Error(outdated("resume interrupted helpers"))
  const listed = (await client.experimental.task.list({ sessionID }, { throwOnError: true })).data
  const ids = interruptedTaskIDs(listed.tasks)
  if (!ids.length) return 0
  return (await resumeTasks(client, sessionID, ids)).tasks.length
}

type Signals = {
  on(event: "SIGINT", listener: () => void): unknown
  off(event: "SIGINT", listener: () => void): unknown
}

/**
 * Handles Ctrl+C for a non-interactive `vector run` at a terminal until `dispose`. `interrupted` says whether any press
 * arrived, so the run can exit 130 when it ends on its own.
 */
export function watchInterrupts(input: {
  client: VectorClient
  sessionID: string
  stopHelpers: boolean
  /** The engine runs in this process (no --attach): every press stops everything and exits. */
  inProcess?: boolean
  /** Attached connected reviews have their own cancellation route and outlive this CLI. */
  stopReviews?: () => Promise<void>
  write: (text: string) => void
  /** Ends the process with `code`; called once the stop has been sent (or has timed out). */
  exit: (code: number) => void
  now?: () => number
  signals?: Signals
}) {
  const signals = input.signals ?? process
  const now = input.now ?? Date.now
  let previous: number | undefined
  let interrupted = false
  const stop = async (helpers: boolean) => {
    try {
      return await stopSession(input.client, input.sessionID, { helpers, signal: AbortSignal.timeout(STOP_TIMEOUT_MS) })
    } finally {
      if (helpers) await input.stopReviews?.()
    }
  }
  const handler = () => {
    const at = now()
    const plan = interruptPlan({ now: at, previous, stopHelpers: input.stopHelpers, inProcess: input.inProcess })
    previous = at
    interrupted = true
    if (plan.exit) {
      void stop(true)
        .catch(() => undefined)
        .finally(() => input.exit(INTERRUPT_EXIT_CODE))
      return
    }
    if (plan.stop === "all") {
      void stop(true).catch(() => undefined)
      return
    }
    void stop(false)
      .catch(() => undefined)
      .then(() => countHelpers(input.client, input.sessionID, AbortSignal.timeout(STOP_TIMEOUT_MS)))
      .then((count) => {
        // A second press may already be stopping everything.
        if (count > 0 && previous === at) input.write(helpersLeftMessage(count))
      })
  }
  signals.on("SIGINT", handler)
  return {
    get interrupted() {
      return interrupted
    },
    dispose() {
      signals.off("SIGINT", handler)
    },
  }
}
