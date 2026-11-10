import type { VectorClient } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import type { Capabilities } from "../../context/sync"
import { backgroundStopRequests, interruptedTaskIDs, liveHelpers } from "./task-presentation"

/*
 * The terminal's task requests (5.I.5), each behind the engine's capability flags. Plain Esc Esc stays
 * `POST /session/:id/abort`, which never touches helpers; everything here is the wider stop, the background stop and
 * the task actions `/tasks` offers.
 */

type Client = VectorClient

export const STOP_REASON = "Stopped with the main turn from the terminal; partial work was kept."
export const BACKGROUND_REASON = "Stopped background subagents from the terminal; partial work was kept."

/** Route 3 takes at most 32 IDs per request. */
export const RESUME_CHUNK = 32

/** Engines before 1.99.113 refuse to stop anything under a session with more than 200 finished children. */
const TOO_MANY_DESCENDANTS = /too many descendants/i

function tooManyDescendants(error: unknown) {
  if (!(error instanceof Error)) return false
  const body = (error.cause as { body?: { code?: unknown; message?: unknown } } | undefined)?.body
  const message = typeof body?.message === "string" ? body.message : error.message
  return (body?.code === undefined || body.code === "invalid") && TOO_MANY_DESCENDANTS.test(message)
}

async function failures(requests: readonly Promise<unknown>[]) {
  return (await Promise.allSettled(requests)).filter((result) => result.status === "rejected").length
}

function abortEach(client: Client, sessionIDs: readonly string[], workspace?: string) {
  return failures(
    [...new Set(sessionIDs)].map((sessionID) => client.session.abort({ sessionID, workspace }, { throwOnError: true })),
  )
}

export type StopOutcome = {
  /** route 1, abort plus `task.stop`, or aborting each helper session. */
  via: "route" | "tasks" | "sessions"
  stopped: number
  shells: number
  excluded: number
  failed: number
}

/**
 * "Stop including helpers": the main turn and every helper this conversation started. Route 1 (`sessionStop`) also
 * fences the parent, so a helper's later report starts no turn until the user writes again (I5). An older engine gets
 * the abort, then `task.stop {all}`; when that is refused for a long history, or the engine has no task routes, each
 * live helper session the transcript knows is aborted instead. Route 1 failing throws.
 */
export async function stopIncludingHelpers(input: {
  client: Client
  sessionID: string
  workspace?: string
  capabilities: Pick<Capabilities, "sessionStop" | "experimentalBackgroundSubagents">
  /** Live helper sessions from the transcript, for the last fallback. */
  helpers: readonly string[]
  reason?: string
}): Promise<StopOutcome> {
  const { client, sessionID, workspace } = input
  const reason = input.reason ?? STOP_REASON
  if (input.capabilities.sessionStop) {
    const data = (
      await client.experimental.session.stop({ sessionID, helpers: true, reason, workspace }, { throwOnError: true })
    ).data
    return {
      via: "route",
      stopped: data?.tasks.length ?? 0,
      shells: data?.shells ?? 0,
      excluded: data?.excluded ?? 0,
      failed: 0,
    }
  }
  const abortFailed = await failures([client.session.abort({ sessionID, workspace }, { throwOnError: true })])
  if (input.capabilities.experimentalBackgroundSubagents) {
    let refused = false
    let failed = abortFailed
    const stopped = await client.experimental.task
      .stop({ sessionID, all: true, reason, workspace }, { throwOnError: true })
      .then((result) => result.data?.tasks.length ?? 0)
      .catch((error: unknown) => {
        if (tooManyDescendants(error)) refused = true
        else failed += 1
        return 0
      })
    if (!refused) return { via: "tasks", stopped, shells: 0, excluded: 0, failed }
  }
  const sessionFailed = await abortEach(client, input.helpers, workspace)
  return {
    via: "sessions",
    stopped: new Set(input.helpers).size - sessionFailed,
    shells: 0,
    excluded: 0,
    failed: abortFailed + sessionFailed,
  }
}

/**
 * "Stop background subagents": only this conversation's background children, through `task.stop({taskIDs})` in chunks
 * of 200 (`backgroundStopRequests`). It never touches foreground work or desktop workspaces. Without task routes, or
 * when the engine refuses for a long history, each live background session the transcript knows is aborted.
 */
export async function stopBackgroundSubagents(input: {
  client: Client
  sessionID: string
  workspace?: string
  capabilities: Pick<Capabilities, "experimentalBackgroundSubagents">
  /** Live background helper sessions from the transcript. */
  background: readonly string[]
  reason?: string
}): Promise<Omit<StopOutcome, "shells" | "excluded">> {
  const { client, sessionID, workspace } = input
  const reason = input.reason ?? BACKGROUND_REASON
  const known = new Set(input.background)
  if (input.capabilities.experimentalBackgroundSubagents) {
    const listed = (
      await client.experimental.task.list({ sessionID, active: "true", workspace }, { throwOnError: true })
    ).data
    const requests = backgroundStopRequests({ sessionID, tasks: listed?.tasks ?? [], background: known, reason })
    let stopped = 0
    let failed = 0
    let refused = false
    for (const request of requests) {
      const result = await client.experimental.task
        .stop({ ...request, workspace }, { throwOnError: true })
        .catch((error: unknown) => {
          if (tooManyDescendants(error)) refused = true
          else failed += 1
          return undefined
        })
      if (refused) break
      stopped += result?.data?.tasks.length ?? 0
    }
    if (!refused) return { via: "tasks", stopped, failed }
    for (const task of listed?.tasks ?? [])
      if (requests.some((request) => request.taskIDs.includes(task.id))) known.add(task.sessionID ?? task.id)
  }
  const sessionFailed = await abortEach(client, [...known], workspace)
  return { via: "sessions", stopped: known.size - sessionFailed, failed: sessionFailed }
}

/** How many helpers keep running for `sessionID`; 0 when the engine cannot say. */
export async function countHelpers(input: {
  client: Client
  sessionID: string
  workspace?: string
  capabilities: Pick<Capabilities, "experimentalBackgroundSubagents" | "backgroundShells">
}) {
  if (!input.capabilities.experimentalBackgroundSubagents) return 0
  const listed = await input.client.experimental.task
    .list(
      {
        sessionID: input.sessionID,
        active: "true",
        ...(input.capabilities.backgroundShells ? { shells: "true" as const } : {}),
        workspace: input.workspace,
      },
      { throwOnError: true },
    )
    .then((result) => result.data)
    .catch(() => undefined)
  return listed ? liveHelpers(listed) : 0
}

/** Route 3 in calls of at most 32 IDs. Each call is all or nothing on the engine. */
export async function resumeTasks(input: {
  client: Client
  sessionID: string
  taskIDs: readonly string[]
  text?: string
  workspace?: string
}) {
  const resumed: Task.Info[] = []
  for (let index = 0; index < input.taskIDs.length; index += RESUME_CHUNK) {
    const taskIDs = input.taskIDs.slice(index, index + RESUME_CHUNK)
    const result = await input.client.experimental.task
      .resume(
        {
          sessionID: input.sessionID,
          taskIDs: [...taskIDs],
          ...(input.text ? { text: input.text } : {}),
          workspace: input.workspace,
        },
        { throwOnError: true },
      )
      .catch((error: unknown) => {
        if (!resumed.length) throw error
        throw new Error(
          `Resumed ${resumed.length} subagent${resumed.length === 1 ? "" : "s"}, then: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    resumed.push(...(result.data?.tasks ?? []))
  }
  return resumed
}

/** "Resume all interrupted (N)": every helper a restart interrupted that can be resumed now. */
export async function resumeInterrupted(input: { client: Client; sessionID: string; workspace?: string }) {
  const listed = (
    await input.client.experimental.task.list(
      { sessionID: input.sessionID, workspace: input.workspace },
      { throwOnError: true },
    )
  ).data
  const taskIDs = interruptedTaskIDs(listed?.tasks ?? [])
  if (!taskIDs.length) return []
  return resumeTasks({ ...input, taskIDs })
}

/** A failed merge or discard as the terminal says it: route 5 and 6 are for the server owner only. */
export function ownerOnlyMessage(error: unknown) {
  const status = error instanceof Error ? (error.cause as { status?: unknown } | undefined)?.status : undefined
  if (status === 403) return "Only the server owner can merge or discard a subagent's worktree."
}
