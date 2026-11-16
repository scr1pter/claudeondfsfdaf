import { Option, Schema } from "effect"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { decodeLocalRun, type DecodedRun } from "@vectordevai/core/review/local-result"
import { pathKey } from "@/utils/path-key"

export interface LocalReviewAPI {
  verify(signal: AbortSignal): Promise<ReviewRun.Target>
  list(cursor: string | undefined, signal: AbortSignal): Promise<unknown>
  start(request: ReviewRun.Start, signal: AbortSignal): Promise<unknown>
  get(runID: string, signal: AbortSignal): Promise<unknown>
  stop(runID: string, signal: AbortSignal): Promise<unknown>
}

export interface LocalReviewScope {
  identity: object
  server: string
  parentID: string
  directory: string
  projectID: string
  api: LocalReviewAPI
}

export interface LocalReviewState {
  busy?: "checking" | "starting" | "reading" | "stopping"
  target?: ReviewRun.Target
  intent?: ReviewRun.Start
  current?: DecodedRun
  runs: readonly ReviewRun.Summary[]
  next?: string
  discovered: boolean
  uncertain: boolean
  error: string
}

// Only the unpaid retry descriptor survives panel unmounts. Never retain an
// artifact, finding text, credentials, or a proof of owner access here.
const pending = new WeakMap<object, Map<string, ReviewRun.Start>>()
class LocalReviewRefusal extends Error {}
const scopeKey = (scope: LocalReviewScope) =>
  JSON.stringify([scope.server, scope.parentID, scope.directory, scope.projectID])
const valid = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) throw new LocalReviewRefusal("The engine returned an invalid local review response.")
  return decoded.value
}

export function localReviewTransport(
  client: Pick<VectorClient, "session" | "review">,
  source: Pick<LocalReviewScope, "parentID" | "directory" | "projectID">,
): LocalReviewAPI {
  const params = { sessionID: source.parentID, directory: source.directory }
  const answer = <T>(result: { data?: T; response: Response }) => {
    if (result.response.status !== 200 || result.data === undefined)
      throw new LocalReviewRefusal("Owner access or this conversation's local review placement could not be verified.")
    return result.data
  }
  const placement = async (signal: AbortSignal) => {
    if (!source.parentID || !source.directory || !source.projectID)
      throw new LocalReviewRefusal("Open an existing main conversation in this checkout before reviewing.")
    const session = answer(await client.session.get(params, { signal, throwOnError: false }))
    if (
      session.id !== source.parentID ||
      session.parentID ||
      session.internal ||
      session.projectID !== source.projectID ||
      pathKey(session.directory) !== pathKey(source.directory)
    )
      throw new LocalReviewRefusal("Open this main conversation in its own checkout before reviewing.")
  }
  return {
    verify: async (signal) => {
      // A directory string or a stale sidebar selection never creates a parent
      // or authorizes another project's code. The engine independently repeats
      // this check before routing the owner-only target and every effect.
      await placement(signal)
      return valid(ReviewRun.Target, answer(await client.review.target(params, { signal, throwOnError: false })))
    },
    list: async (cursor, signal) => {
      await placement(signal)
      return answer(
        await client.review.list(
          { ...params, limit: "50", ...(cursor ? { cursor } : {}) },
          { signal, throwOnError: false },
        ),
      )
    },
    start: async (request, signal) => {
      await placement(signal)
      return answer(await client.review.start({ ...params, reviewRunStart: request }, { signal, throwOnError: false }))
    },
    get: async (runID, signal) => {
      await placement(signal)
      return answer(await client.review.get({ ...params, runID }, { signal, throwOnError: false }))
    },
    stop: async (runID, signal) => {
      await placement(signal)
      return answer(await client.review.stop({ ...params, runID }, { signal, throwOnError: false }))
    },
  }
}

export function localReviewCanStart(state: LocalReviewState, enabled: boolean) {
  return (
    enabled &&
    !!state.target &&
    state.discovered &&
    !state.next &&
    !state.busy &&
    !state.intent &&
    !state.runs.some((run) => run.status === "running" || run.status === "unknown") &&
    !["running", "unknown"].includes(state.current?.run.status ?? "")
  )
}

export function localReviewController(input: {
  scope: LocalReviewScope
  enabled: () => boolean
  changed: (state: LocalReviewState) => void
  requestID?: () => string
}) {
  const scope = { ...input.scope }
  const key = scopeKey(scope)
  const retained = pending.get(scope.identity)?.get(key)
  let state: LocalReviewState = {
    runs: [],
    discovered: false,
    uncertain: !!retained,
    error: "",
    ...(retained ? { intent: retained } : {}),
  }
  let revision = 0
  let disposed = false
  let observation: AbortController | undefined
  const emit = (patch: Partial<LocalReviewState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    input.changed(state)
  }
  const keep = (request: ReviewRun.Start | undefined) => {
    if (!request) {
      pending.get(scope.identity)?.delete(key)
      return
    }
    const values = pending.get(scope.identity) ?? new Map<string, ReviewRun.Start>()
    values.set(key, request)
    pending.set(scope.identity, values)
  }
  const begin = (busy: NonNullable<LocalReviewState["busy"]>) => {
    if (disposed || state.busy) return
    const controller = new AbortController()
    observation = controller
    const epoch = ++revision
    emit({ busy, error: "" })
    return { signal: controller.signal, current: () => !disposed && revision === epoch && !controller.signal.aborted }
  }
  const failure = (cause: unknown) =>
    cause instanceof LocalReviewRefusal ? cause.message : "The engine could not complete the local review request."
  const decoded = async (value: unknown, request: ReviewRun.Start, runID?: string) => {
    const result = await decodeLocalRun(value, { parentID: scope.parentID, request, ...(runID ? { runID } : {}) })
    if (!result)
      throw new LocalReviewRefusal("The saved review could not be verified. It has not been shown as reviewed.")
    return result
  }
  const receive = (value: DecodedRun) => {
    const terminal = !["running", "unknown"].includes(value.run.status)
    // Receiving a different history entry must not discard an unresolved POST.
    if (state.intent?.requestID === value.run.request.requestID && terminal) keep(undefined)
    emit({
      current: value,
      ...(state.intent?.requestID === value.run.request.requestID
        ? { intent: terminal ? undefined : state.intent, uncertain: false }
        : {}),
    })
  }
  const check = async (more = false) => {
    const operation = begin("checking")
    if (!operation) return
    try {
      const page = valid(ReviewRun.List, await scope.api.list(more ? state.next : undefined, operation.signal))
      if (page.runs.some((run) => run.parentID !== scope.parentID))
        throw new LocalReviewRefusal("The engine returned another conversation's review history.")
      if (!operation.current()) return
      const runs = more ? [...state.runs, ...page.runs] : page.runs
      if (new Set(runs.map((run) => run.runID)).size !== runs.length || (more && page.next === state.next))
        throw new LocalReviewRefusal("The review discovery cursor did not advance safely.")
      emit({ runs, next: page.next, discovered: true })
      const target = await scope.api.verify(operation.signal).catch(() => undefined)
      if (!operation.current()) return
      emit({
        target,
        ...(target
          ? {}
          : { error: "The current checkout cannot start a review. Retained results and owned Stop remain available." }),
      })
      const match = state.intent && runs.find((run) => run.request.requestID === state.intent!.requestID)
      if (match && state.intent) {
        const result = await decoded(await scope.api.get(match.runID, operation.signal), state.intent, match.runID)
        if (operation.current()) receive(result)
      }
    } catch (cause) {
      if (operation.current()) emit({ target: undefined, error: failure(cause) })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  const canStart = () => localReviewCanStart(state, input.enabled())
  const start = async (kind: ReviewRun.Target["kind"], maxCost?: number, retry = false) => {
    if (!input.enabled() || (!retry && !canStart()) || (retry && (!state.uncertain || !state.intent))) return
    if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0)) {
      emit({ error: "Enter a positive maximum cost, or leave it empty." })
      return
    }
    let request: ReviewRun.Start
    try {
      request = retry
        ? state.intent!
        : valid(ReviewRun.Start, {
            requestID: (input.requestID ?? (() => crypto.randomUUID()))(),
            target: { ...state.target!, kind },
            ...(maxCost === undefined ? {} : { maxCost }),
          })
    } catch {
      emit({ error: "A secure review retry key could not be created. No review was started." })
      return
    }
    const operation = begin("starting")
    if (!operation) return
    let sent = false
    try {
      const target = await scope.api.verify(operation.signal)
      if (!operation.current() || !input.enabled()) return
      if (!retry && target.head !== request.target.head)
        throw new LocalReviewRefusal("The Git head changed. Check this checkout again before starting.")
      keep(request)
      emit({ intent: request, uncertain: true, current: undefined })
      sent = true
      const result = await decoded(await scope.api.start(request, operation.signal), request)
      if (operation.current()) receive(result)
    } catch (cause) {
      if (operation.current())
        emit({
          error: sent
            ? `${failure(cause)} Check existing runs or retry this exact request. Vector will not start another review automatically.`
            : failure(cause),
          ...(sent ? { uncertain: true } : {}),
        })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  const read = async (summary: ReviewRun.Summary | ReviewRun.Info, stopping = false) => {
    if (stopping && (!summary.canStop || summary.status !== "running")) return
    const operation = begin(stopping ? "stopping" : "reading")
    if (!operation) return
    emit({ current: undefined })
    try {
      const result = await decoded(
        await (stopping ? scope.api.stop : scope.api.get)(summary.runID, operation.signal),
        summary.request,
        summary.runID,
      )
      if (operation.current()) {
        receive(result)
        const { artifact, ...summary } = result.run
        emit({
          runs: state.runs.map((run) => (run.runID === result.run.runID ? { ...summary, hasResult: !!artifact } : run)),
        })
      }
    } catch (cause) {
      if (operation.current()) emit({ error: failure(cause) })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  input.changed(state)
  return {
    state: () => state,
    canStart,
    check,
    start: (kind: ReviewRun.Target["kind"], maxCost?: number) => start(kind, maxCost),
    retry: () => (state.intent ? start(state.intent.target.kind, state.intent.maxCost, true) : Promise.resolve()),
    read: (summary: ReviewRun.Summary) => read(summary),
    refresh: () => (state.current ? read(state.current.run) : Promise.resolve()),
    stop: () => (state.current ? read(state.current.run, true) : Promise.resolve()),
    dispose: () => {
      disposed = true
      revision++
      observation?.abort()
    },
  }
}
