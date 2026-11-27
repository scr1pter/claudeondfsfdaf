import type { Connect } from "@vectordevai/schema/connect"
import type { createConnectClient } from "./client"
import { costLabel, destinationLabel, verdictLabel } from "./connect-model"

/** At most this many rows in all. Runs still going are never cut, so they can push the total above it. */
export const MAX_TASK_ROWS = 10

/** One connected run in the Background tasks pane. Every key is always present; an absent value is `undefined`. */
export type TaskRow = {
  id: Connect.RunID
  /** The registry member's title, else the run's member id. */
  title: string
  action: "Review" | "Fix"
  status: "Queued" | "Running" | "Done" | "Partial" | "Refused" | "Failed" | "Cancelled"
  /** The pane's `.vector-bg-tasks-card-status[data-status]` tone. */
  tone: "pending" | "running" | "done" | "failed" | "stopped"
  verdict: string | undefined
  sendsTo: string
  spend: string | undefined
  detail: string | undefined
  cancellable: boolean
}

export type TaskRowsClient = Pick<ReturnType<typeof createConnectClient>, "runs" | "list" | "cancel">
export type TaskRowsRead = { rows: readonly TaskRow[]; members: readonly Connect.Member[] }

/**
 * The session's own runs, those still going first. A row reads only the run's status, its member, and the result
 * fields Vector code writes; finding titles and bodies never reach it.
 */
export function taskRows(input: {
  sessionID: string
  runs: readonly Connect.Run[]
  members?: readonly Connect.Member[]
}): TaskRow[] {
  const own = input.runs.filter((run) => run.request.requester.sessionID === input.sessionID)
  return goingFirst(own, (run) => run.status !== "done").map((run) =>
    taskRow(
      run,
      input.members?.find((member) => member.id === run.request.to),
    ),
  )
}

/** Runs still going first, then the rest, at most `MAX_TASK_ROWS` in all; a run still going is never cut. */
export function goingFirst<T>(runs: readonly T[], going: (run: T) => boolean): T[] {
  const live = runs.filter(going)
  return [...live, ...runs.filter((run) => !going(run))].slice(0, Math.max(MAX_TASK_ROWS, live.length))
}

/**
 * One owner read of the session's runs. Undefined, with no request, while `connections` is off or there is no
 * session. "refused" when the engine answers the read with a 4xx (a guest, or the owner's own refusal), and "failed"
 * for anything else (the network, an abort, a timeout, a 5xx, an answer that does not decode), which a later read may
 * get past. The registry is read only when a run names a member the caller does not already know.
 */
export async function readTaskRows(input: {
  client: Pick<TaskRowsClient, "runs" | "list">
  sessionID: string | undefined
  connections: boolean
  members?: readonly Connect.Member[]
  signal?: AbortSignal
}): Promise<TaskRowsRead | "refused" | "failed" | undefined> {
  const sessionID = input.sessionID
  if (!input.connections || !sessionID) return undefined
  const runs = await input.client
    .runs(sessionID, input.signal)
    .catch((error: unknown) => (refused(error) ? ("refused" as const) : ("failed" as const)))
  if (typeof runs === "string") return runs
  const known = input.members ?? []
  if (runs.length === 0) return { rows: [], members: known }
  const members = runs.every((run) => known.some((member) => member.id === run.request.to))
    ? known
    : await input.client.list(sessionID, input.signal).catch(() => known)
  return { rows: taskRows({ sessionID, runs, members }), members }
}

// A `throwOnError` SDK call keeps the engine's answer status under `cause`; a network error or an abort has none.
function refused(error: unknown) {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (typeof cause !== "object" || cause === null || !("status" in cause) || typeof cause.status !== "number")
    return false
  return cause.status >= 400 && cause.status < 500
}

/** Cancels a run still going. A finished row makes no request, and an aborted or timed-out request is "failed". */
export async function cancelTaskRow(input: {
  client: Pick<TaskRowsClient, "cancel">
  sessionID: string
  row: Pick<TaskRow, "id" | "cancellable">
  signal?: AbortSignal
}): Promise<"cancelled" | "ended" | "failed"> {
  if (!input.row.cancellable) return "ended"
  return input.client.cancel(input.row.id, input.sessionID, input.signal).then(
    (cancelled) => (cancelled ? "cancelled" : "ended"),
    () => "failed",
  )
}

function taskRow(run: Connect.Run, member: Connect.Member | undefined): TaskRow {
  const result = run.result
  const state = runState(run)
  return {
    id: run.id,
    title: member?.title ?? run.request.to,
    action: run.request.action === "fix" ? "Fix" : "Review",
    status: state.status,
    tone: state.tone,
    verdict:
      run.request.action === "review" && result && (result.state === "completed" || result.state === "partial")
        ? verdictLabel(result)
        : undefined,
    // A finished run reports where its code went; it never borrows the member's current destination. A run's place is
    // its member's (CN-15), so a run in a Vector cloud workspace never reads "This computer".
    sendsTo: result
      ? `Code sent to: ${destinationLabel(result.sendsTo, member?.place)}`
      : `Sends code to: ${destinationLabel(member?.sendsTo, member?.place)}`,
    spend: spend(run, member),
    detail: detail(run),
    cancellable: run.status !== "done",
  }
}

const ENDED = {
  completed: { status: "Done", tone: "done" },
  partial: { status: "Partial", tone: "done" },
  refused: { status: "Refused", tone: "failed" },
  failed: { status: "Failed", tone: "failed" },
  cancelled: { status: "Cancelled", tone: "stopped" },
} as const satisfies Record<Connect.ResultState, Pick<TaskRow, "status" | "tone">>

export function runState(
  run: Pick<Connect.Run, "status"> & { readonly result?: Pick<Connect.Result, "state"> },
): Pick<TaskRow, "status" | "tone"> {
  if (run.status === "queued") return { status: "Queued", tone: "pending" }
  if (!run.result) return { status: "Running", tone: "running" }
  return ENDED[run.result.state]
}

// Vector Codium bills against the plan: any sign of it shows plan usage, never dollars or tokens.
function spend(run: Connect.Run, member: Connect.Member | undefined) {
  if (
    member?.owner === "codium" ||
    member?.sendsTo === "vector-codium" ||
    run.result?.sendsTo === "vector-codium" ||
    run.result?.cost?.kind === "plan"
  )
    return "Plan usage"
  if (!run.result) return undefined
  // Without its registry member, only a result naming another destination rules Codium out.
  if (!member && !run.result.sendsTo) return "Usage unavailable"
  return costLabel(run.result)
}

function detail(run: Connect.Run) {
  if (!run.result) return run.progress?.message
  if (run.result.state === "refused" || run.result.state === "failed") return run.result.summary
  return undefined
}
