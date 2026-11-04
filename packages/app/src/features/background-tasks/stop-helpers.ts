import type { VectorClient } from "@vectordevai/sdk/v2/client"
import type { EngineCapabilities } from "./engine-capabilities"
import { isLive, type TaskAgent } from "./subagent-model"

/*
 * "Stop including helpers" (5.I.2): stop the main turn and every helper this conversation started. Plain Stop stays
 * `POST /session/:id/abort`, which never touches helpers; this module is only for the wider stop and the count the
 * composer's Stop menu shows.
 */

export type StopScope = "turn" | "all"

/** The live background helpers under the root, as the Tasks pane knows them. */
export type HelperTargets = {
  /** How many helpers "Stop including helpers (N)" names. */
  count: number
  /** Their task IDs, for `task.stop` on an engine without route 1. */
  taskIDs: readonly string[]
  /** Every helper's own session, for the last fallback: aborting each one. */
  sessionIDs: readonly string[]
  /** Helpers the engine lists no task row for (sessions from before the board), aborted by session on any engine. */
  untracked: readonly string[]
}

export const NO_HELPERS: HelperTargets = Object.freeze({ count: 0, taskIDs: [], sessionIDs: [], untracked: [] })

// Desktop Parallel Workspaces and Swarm keep their own runners and Stop, and stay out of "Stop including helpers".
const WORKSPACE_TASK = /^(workspace|swarm):/

/**
 * Live background subagents under the root, workspace tasks excluded. Foreground work is not counted: it ends with the
 * main turn. A task the engine says cannot be stopped is left out, as the Tasks pane's own "Stop all" does.
 */
export function helperTargets(agents: readonly TaskAgent[]): HelperTargets {
  const seen = new Set<string>()
  const taskIDs: string[] = []
  const sessionIDs: string[] = []
  const untracked: string[] = []
  for (const agent of agents) {
    if (!agent.background || !isLive(agent.status)) continue
    const task = agent.task
    if (task && (WORKSPACE_TASK.test(task.id) || task.source !== "subagent" || task.controls.stop === false)) continue
    // A workflow run's agents, loaded while its stages are open, stop with their run: the run row is the helper.
    if (task?.workflow?.role === "agent") continue
    const key = task?.id ?? agent.sessionID
    if (!key || seen.has(key)) continue
    seen.add(key)
    const sessionID = task?.sessionID ?? agent.sessionID
    if (task) taskIDs.push(task.id)
    else if (sessionID) untracked.push(sessionID)
    if (sessionID) sessionIDs.push(sessionID)
  }
  if (seen.size === 0) return NO_HELPERS
  return { count: seen.size, taskIDs, sessionIDs, untracked }
}

/** `task.stop` takes at most 200 IDs per request. */
export const STOP_CHUNK = 200

/** Engines before 1.99.113 refuse to stop anything under a session with more than 200 finished children. */
const TOO_MANY_DESCENDANTS = /too many descendants/i

export type StopHelpersResult = {
  /** Which step of the chain stopped them: route 1, abort plus `task.stop`, or aborting each helper's session. */
  via: "route" | "tasks" | "sessions"
  /** Helpers the engine reported stopped (route and tasks), or helper sessions aborted. */
  stopped: number
  /** Agent workspaces route 1 left running (stopped from the Agent Dashboard). */
  excluded: number
  /** Requests that failed; the rest of the stop still went ahead. */
  failed: number
}

type StopClient = {
  session: Pick<VectorClient["session"], "abort">
  experimental: {
    session: Pick<VectorClient["experimental"]["session"], "stop">
    task: Pick<VectorClient["experimental"]["task"], "stop">
  }
}

export const HELPERS_REASON = "Stopped with the main agent; partial work was kept."

function tooManyDescendants(error: unknown) {
  if (!(error instanceof Error)) return false
  const body = (error.cause as { body?: { code?: unknown; message?: unknown } } | undefined)?.body
  const message = typeof body?.message === "string" ? body.message : error.message
  return (body?.code === undefined || body.code === "invalid") && TOO_MANY_DESCENDANTS.test(message)
}

function chunks<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

async function settled(requests: readonly Promise<unknown>[]) {
  const results = await Promise.allSettled(requests)
  return results.filter((result) => result.status === "rejected").length
}

/**
 * Stops the main turn and its helpers, following the engine's capability flags:
 * 1. route 1 (`sessionStop`), which also fences the parent so no new turn starts until the user writes;
 * 2. otherwise abort plus `task.stop({taskIDs})` in chunks of 200, on an engine with the task routes;
 * 3. otherwise, or when `task.stop` answers `invalid` with the too-many-descendants refusal, `session.abort` for each
 *    live helper session.
 * The main turn's abort is never repeated. Route 1 failing throws: nothing else is tried behind the engine's back.
 */
export async function stopSession(input: {
  client: StopClient
  sessionID: string
  capabilities: EngineCapabilities
  targets: HelperTargets
  reason?: string
}): Promise<StopHelpersResult> {
  const { client, sessionID, targets } = input
  const reason = input.reason ?? HELPERS_REASON
  if (input.capabilities.sessionStop) {
    const result = await client.experimental.session.stop({ sessionID, helpers: true, reason }, { throwOnError: true })
    const data = result.data
    return { via: "route", stopped: data?.tasks.length ?? 0, excluded: data?.excluded ?? 0, failed: 0 }
  }

  const abortFailed = await settled([client.session.abort({ sessionID }, { throwOnError: true })])
  const abortSessions = (ids: readonly string[]) =>
    settled(ids.map((id) => client.session.abort({ sessionID: id }, { throwOnError: true })))

  if (input.capabilities.backgroundSubagents) {
    let stopped = 0
    let failed = abortFailed
    let refused = false
    for (const taskIDs of chunks(targets.taskIDs, STOP_CHUNK)) {
      const result = await client.experimental.task
        .stop({ sessionID, taskIDs: [...taskIDs], reason }, { throwOnError: true })
        .catch((error: unknown) => {
          if (tooManyDescendants(error)) refused = true
          else failed += 1
          return undefined
        })
      if (refused) break
      stopped += result?.data?.tasks.length ?? 0
    }
    if (!refused) {
      const untrackedFailed = await abortSessions(targets.untracked)
      return {
        via: "tasks",
        stopped: stopped + targets.untracked.length - untrackedFailed,
        excluded: 0,
        failed: failed + untrackedFailed,
      }
    }
    // The older engine refuses the whole selection under a long history; each helper's own session still stops.
    const sessionFailed = await abortSessions(targets.sessionIDs)
    return {
      via: "sessions",
      stopped: targets.sessionIDs.length - sessionFailed,
      excluded: 0,
      failed: failed + sessionFailed,
    }
  }

  const sessionFailed = await abortSessions(targets.sessionIDs)
  return {
    via: "sessions",
    stopped: targets.sessionIDs.length - sessionFailed,
    excluded: 0,
    failed: abortFailed + sessionFailed,
  }
}
