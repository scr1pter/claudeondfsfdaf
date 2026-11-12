import type { Connect } from "@vectordevai/schema/connect"
import type { PermissionRequest } from "@vectordevai/sdk/v2/client"
import { connectConsentDetails } from "./consent"

export type DirectoryReviewTarget = { workspaceID: string; directory: string; base: string }

export type DirectoryReviewTransport = {
  runs: (signal: AbortSignal) => Promise<readonly Connect.Run[]>
  get: (id: string, signal: AbortSignal) => Promise<Connect.Run>
  start: () => Promise<Connect.Run>
  pending: (signal: AbortSignal) => Promise<readonly PermissionRequest[]>
  reply: (id: string, reply: "once" | "reject") => Promise<unknown>
  cancel: (id: string) => Promise<unknown>
}

export type DirectoryReviewState = {
  phase: "loading" | "ready" | "unavailable"
  busy: boolean
  run?: Connect.Run
  permission?: PermissionRequest
  error: string
  admissionUncertain?: boolean
}

/** The directory and base come from the native workspace record, never a chat or event. */
export function directoryRunMatches(run: Connect.Run, target: DirectoryReviewTarget) {
  return (
    run.id === run.request.id &&
    run.request.directory === target.directory &&
    run.request.requester.kind === "user" &&
    run.request.requester.sessionID === undefined &&
    run.request.to === "vectorscope" &&
    run.request.action === "review" &&
    run.request.target?.kind === "branch" &&
    run.request.target.base === target.base
  )
}

export function directoryPermissionMatches(request: PermissionRequest, run: Connect.Run) {
  return (
    run.status !== "done" &&
    (request.permission === "connect" || request.permission === "connect_model") &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    typeof request.sessionID === "string" &&
    request.sessionID.length > 0 &&
    request.metadata?.directoryReview === true &&
    request.metadata.runID === run.id &&
    request.metadata.directory === run.request.directory &&
    connectConsentDetails(request) !== undefined
  )
}

/** Events only invalidate owner reads. Disposal stops observation and never cancels admitted work. */
export function createDirectoryReviewController(input: {
  target: DirectoryReviewTarget
  enabled: boolean
  current: () => boolean
  transport: DirectoryReviewTransport
  subscribe: (invalidate: () => void) => () => void
  changed: (state: DirectoryReviewState) => void
  admission?: { pending: () => boolean; hold: (retry: boolean) => void; confirm: () => void }
}) {
  const abort = new AbortController()
  const answered = new Set<string>()
  const cancelled = new Set<string>()
  let state: DirectoryReviewState = {
    phase: input.enabled ? "loading" : "unavailable",
    busy: false,
    error: "",
    admissionUncertain: input.admission?.pending() ?? false,
  }
  let runID: string | undefined
  let disposed = false
  let retired = false
  let starting = false
  let dirty = false
  let reading: Promise<void> | undefined
  const current = () => !disposed && !retired && input.enabled && input.current()
  const update = (patch: Partial<DirectoryReviewState>) => {
    if (!current()) return
    state = { ...state, ...patch }
    input.changed(state)
  }
  const retire = (error = "") => {
    if (retired) return
    const publish = current()
    state = {
      phase: "unavailable",
      busy: false,
      run: undefined,
      permission: undefined,
      error,
      admissionUncertain: state.admissionUncertain,
    }
    runID = undefined
    dirty = false
    retired = true
    abort.abort()
    unsubscribe()
    if (publish) input.changed(state)
  }
  const read = async () => {
    if (!current()) return
    if (!runID) {
      const runs = await input.transport.runs(abort.signal)
      if (!current()) return
      runID = runs
        .filter((run) => directoryRunMatches(run, input.target))
        .sort((a, b) => b.time.created - a.time.created)[0]?.id
    }
    if (!runID) return update({ phase: "ready", run: undefined, permission: undefined, error: "" })
    const id = runID
    const [run, pending] = await Promise.all([
      input.transport.get(id, abort.signal),
      input.transport.pending(abort.signal),
    ])
    if (!current() || runID !== id) return
    if (run.id !== id || !directoryRunMatches(run, input.target))
      throw new Error("The engine returned a review for another workspace.")
    update({
      phase: "ready",
      run,
      permission: pending.find((request) => directoryPermissionMatches(request, run) && !answered.has(request.id)),
      error: "",
    })
  }
  const refresh = (): Promise<void> => {
    if (!current()) return Promise.resolve()
    dirty = true
    if (starting) {
      return Promise.resolve()
    }
    if (reading) return reading
    reading = (async () => {
      while (dirty && current() && !starting) {
        dirty = false
        await read()
      }
    })()
      .catch(() => {
        if (!current() || abort.signal.aborted) return
        retire("Workspace review access could not be verified. Reopen the workspace to try again.")
      })
      .finally(() => {
        reading = undefined
        if (dirty && current()) void refresh()
      })
    return reading
  }
  // Install before the first read and, in particular, before any review POST.
  const unsubscribe = input.enabled ? input.subscribe(() => void refresh()) : () => undefined
  input.changed(state)
  if (input.enabled) void refresh()

  return {
    get state() {
      return state
    },
    refresh,
    retire,
    async start(retry = false) {
      if (
        !current() ||
        state.phase !== "ready" ||
        state.busy ||
        (state.admissionUncertain && (!retry || !input.admission)) ||
        (!state.admissionUncertain && retry) ||
        (!retry && state.run && state.run.status !== "done")
      )
        return
      starting = true
      runID = undefined
      update({ busy: true, permission: undefined, error: "" })
      // Persist only an unpaid uncertainty marker; a list cannot prove a lost POST will never admit later.
      const held = (() => {
        try {
          input.admission?.hold(retry)
          return true
        } catch {
          return false
        }
      })()
      if (!held || !current()) {
        starting = false
        update({
          busy: false,
          admissionUncertain: true,
          error: "This review start cannot be tracked safely. Starting another review is blocked.",
        })
        return
      }
      update({ admissionUncertain: true })
      // A view change must not abort the admission POST or implicitly stop the durable job.
      await input.transport
        .start()
        .then((run) => {
          if (!current()) return false
          if (!directoryRunMatches(run, input.target))
            throw new Error("The engine returned a review for another workspace.")
          runID = run.id
          input.admission?.confirm()
          update({ admissionUncertain: false })
          update({ run: undefined })
          return true
        })
        .catch(() => {
          update({
            admissionUncertain: true,
            error:
              "The review start was not confirmed. Refresh to inspect existing reviews; starting another review remains blocked until this request can be identified.",
          })
          return false
        })
        .finally(() => {
          starting = false
        })
      if (current()) await refresh()
      update({ busy: false })
    },
    async reply(id: string, reply: "once" | "reject") {
      if (!current() || state.busy || answered.has(id) || state.permission?.id !== id) return
      const expected = runID
      update({ busy: true })
      await refresh()
      if (!current()) return
      if (
        runID !== expected ||
        state.permission?.id !== id ||
        !state.run ||
        !directoryPermissionMatches(state.permission, state.run)
      ) {
        update({ busy: false })
        return
      }
      answered.add(id)
      update({ permission: undefined })
      const replied = await input.transport
        .reply(id, reply)
        .then(() => true)
        .catch(() => {
          retire("Workspace review approval could not be verified.")
          return false
        })
      update({ busy: false })
      if (replied && current()) await refresh()
    },
    async cancel() {
      const expected = runID
      const latestRun = () => state.run
      if (!current() || state.busy || !expected || cancelled.has(expected) || state.run?.status === "done") return
      update({ busy: true })
      await refresh()
      if (!current()) return
      if (runID !== expected || state.phase !== "ready" || latestRun()?.status === "done") {
        update({ busy: false })
        return
      }
      cancelled.add(expected)
      const stopped = await input.transport
        .cancel(expected)
        .then(() => true)
        .catch(() => {
          retire("Workspace review cancellation could not be verified.")
          cancelled.delete(expected)
          return false
        })
      update({ busy: false, permission: undefined })
      if (stopped && current()) await refresh()
    },
    dispose() {
      retire()
      disposed = true
    },
  }
}
