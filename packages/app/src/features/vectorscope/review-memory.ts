import { Option, Schema } from "effect"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"

/** Bound later to the normally generated client; this port never supplies owner authority. */
export interface ReviewMemoryTransport {
  inspect(input: ReviewMemoryControl.InspectInput, signal: AbortSignal): Promise<ReviewMemoryControl.Inspect>
  prepare(input: ReviewMemoryControl.Prepare, signal: AbortSignal): Promise<ReviewMemoryControl.Preview>
  confirm(input: ReviewMemoryControl.Confirmation, signal: AbortSignal): Promise<ReviewMemoryControl.ConfirmationResult>
  discard(previewId: string, signal: AbortSignal): Promise<void>
}
export class ReviewMemoryRequestError extends Error {
  constructor(
    readonly code:
      | "denied"
      | "unavailable"
      | "invalid"
      | "limit"
      | "stale"
      | "used"
      | "expired"
      | "disabled"
      | "not-found"
      | "source-unavailable",
  ) {
    super("The engine refused this review-memory request.")
  }
}
export interface ReviewMemorySelection {
  identity: object
  server: string
  directory: string
  /** Monotonic current-owner proof epoch, never advanced merely for layout or capability changes. */
  epoch: number
  owner: "owner" | "guest" | "unknown"
  connected: boolean
  capability?: boolean
  api: ReviewMemoryTransport
}
export interface ReviewMemoryDraft {
  kind: "preference" | "check"
  text: string
  paths: string
  reason: string
  visibility: "private" | "repository"
}
export interface ReviewMemoryViewState {
  status: "unavailable" | "idle" | "ready"
  busy?: "reading" | "preparing" | "confirming" | "discarding"
  read?: ReviewMemoryControl.Inspect
  preview?: ReviewMemoryControl.Preview
  retry?: ReviewMemoryControl.Confirmation
  draft: ReviewMemoryDraft
  reopening?: { id: string; reason: string }
  approved: boolean
  retryApproved: boolean
  offset: number
  message: string
}
export type ReviewMemoryIntent =
  | { action: "configure"; enabled: boolean }
  | Omit<ReviewMemoryControl.Record, "expected">
  | Omit<ReviewMemoryControl.Reopen, "expected">
  | { action: "approve" | "forget"; id: string }
  | { action: "erase" }

const draft = (): ReviewMemoryDraft => ({
  kind: "preference",
  text: "",
  paths: "*",
  reason: "",
  visibility: "repository",
})
export const emptyReviewMemory = (): ReviewMemoryViewState => ({
  status: "idle",
  draft: draft(),
  approved: false,
  retryApproved: false,
  offset: 0,
  message: "",
})
const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] => {
  const value = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  if (Option.isNone(value)) throw new Error("The engine response could not be verified.")
  return value.value
}
const unavailable = (scope: ReviewMemorySelection) =>
  !scope.connected
    ? "Reconnect to this engine before opening review memory."
    : scope.owner !== "owner"
      ? "Review memory is available only to the current engine owner."
      : scope.capability !== true
        ? "This engine does not offer verified repository review memory."
        : !scope.server || !scope.directory
          ? "Select this repository on its connected engine."
          : ""
const same = (left: ReviewMemorySelection, right: ReviewMemorySelection) =>
  left.identity === right.identity &&
  left.server === right.server &&
  left.directory === right.directory &&
  left.epoch === right.epoch &&
  left.owner === right.owner &&
  left.connected === right.connected &&
  left.capability === right.capability &&
  left.api === right.api
const reopenable = (entry: ReviewMemoryControl.Entry | undefined): entry is ReviewMemoryControl.ApprovedEntry =>
  entry?.origin === "review" && entry.kind === "outcome" && entry.status === "active"
const exactPreview = (
  preview: ReviewMemoryControl.Preview,
  request: ReviewMemoryControl.Prepare,
  repository: string,
) => {
  if (
    preview.repository !== repository ||
    preview.scope !== request.expectedScope ||
    preview.expected !== request.command.expected ||
    preview.operation !== request.command.action ||
    preview.payload.expected !== request.command.expected
  )
    return false
  const command = request.command
  if (preview.operation === "configure" && command.action === "configure")
    return preview.payload.enabled === command.enabled
  if (preview.operation === "record" && command.action === "record")
    return (
      preview.payload.text === command.text &&
      preview.payload.kind === command.kind &&
      preview.payload.reason === command.reason &&
      preview.payload.visibility === command.visibility &&
      JSON.stringify(preview.payload.paths) === JSON.stringify(command.paths) &&
      JSON.stringify(
        preview.payload.citations.map((citation) => [citation.path, citation.line, citation.head, citation.quote]),
      ) ===
        JSON.stringify(
          command.citations.map((citation) => [citation.path, citation.line, citation.head, citation.quote]),
        )
    )
  if (preview.operation === "approve" && command.action === "approve")
    return preview.payload.id === command.id && preview.payload.entry.id === command.id
  if (preview.operation === "reopen" && command.action === "reopen")
    return (
      preview.payload.id === command.id &&
      preview.payload.entry.id === command.id &&
      preview.payload.reason === command.reason
    )
  if (preview.operation === "forget" && command.action === "forget") return preview.payload.id === command.id
  return preview.operation === "erase" && command.action === "erase"
}

export function reviewMemoryController(input: {
  selection: ReviewMemorySelection
  changed: (state: ReviewMemoryViewState) => void
  clock?: { now: () => number; date: () => number; schedule: (delay: number, run: () => void) => () => void }
}) {
  const clock = input.clock ?? {
    now: () => performance.now(),
    date: () => Date.now(),
    schedule: (delay: number, run: () => void) => {
      const timer = setTimeout(run, delay)
      return () => clearTimeout(timer)
    },
  }
  let scope = { ...input.selection }
  let state = emptyReviewMemory()
  let epoch = 0
  let disposed = false
  let proofEpoch = Number.isSafeInteger(scope.epoch) && scope.epoch >= 0 ? scope.epoch : 0
  let authorityRetired =
    !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || scope.owner !== "owner" || !scope.connected
  let observation: AbortController | undefined
  let observed: { repository: string; scope: string } | undefined
  let expires = 0
  let timerEpoch = 0
  let cancelExpiry: (() => void) | undefined
  const emit = (patch: Partial<ReviewMemoryViewState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    input.changed(structuredClone(state))
  }
  const clear = (message: string, status: ReviewMemoryViewState["status"] = "idle") => {
    epoch++
    timerEpoch++
    observation?.abort()
    observation = undefined
    cancelExpiry?.()
    cancelExpiry = undefined
    expires = 0
    observed = undefined
    state = { ...emptyReviewMemory(), status, message }
    input.changed(structuredClone(state))
  }
  const begin = (busy: NonNullable<ReviewMemoryViewState["busy"]>) => {
    if (disposed || state.busy) return
    const refusal =
      unavailable(scope) || (authorityRetired ? "Verify current owner access after this connection changed." : "")
    if (refusal) {
      clear(refusal, "unavailable")
      return
    }
    const controller = new AbortController()
    const captured = ++epoch
    observation = controller
    emit({ busy, message: "" })
    return { signal: controller.signal, current: () => !disposed && epoch === captured && !controller.signal.aborted }
  }
  const read = async (signal: AbortSignal, offset = state.offset) =>
    decode(
      ReviewMemoryControl.Inspect,
      await scope.api.inspect({ offset, limit: ReviewMemoryControl.LIMIT.page }, signal),
    )
  const accept = (value: ReviewMemoryControl.Inspect) => {
    if (observed && (observed.repository !== value.repository || observed.scope !== value.scope)) {
      clear(
        "The repository scope changed. Private text and approvals were cleared. Refresh to read its current memory.",
      )
      return false
    }
    observed = { repository: value.repository, scope: value.scope }
    emit({ read: value, status: "ready" })
    return true
  }
  const expire = () => {
    timerEpoch++
    cancelExpiry?.()
    cancelExpiry = undefined
    expires = 0
    emit({
      preview: undefined,
      retry: undefined,
      approved: false,
      retryApproved: false,
      draft: draft(),
      reopening: undefined,
      message:
        "This approval expired. Read the current state before preparing another change; an earlier uncertain result is not attributed.",
    })
  }
  const arm = (preview: ReviewMemoryControl.Preview) => {
    cancelExpiry?.()
    const remaining = Math.min(ReviewMemoryControl.LIMIT.ttl, Math.max(0, preview.expiresAt - clock.date()))
    expires = clock.now() + remaining
    const captured = ++timerEpoch
    cancelExpiry = clock.schedule(Math.max(1, remaining), () => {
      if (!disposed && timerEpoch === captured) expire()
    })
  }
  const refresh = async (offset = state.offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ReviewMemoryControl.LIMIT.records) return
    const operation = begin("reading")
    if (!operation) return
    const retry = state.retry
    const previous = state.read
    const reopening = state.preview ? undefined : state.reopening
    const pendingDraft = state.preview ? draft() : state.draft
    if (!retry) {
      timerEpoch++
      cancelExpiry?.()
      cancelExpiry = undefined
      expires = 0
    }
    // A same-owner GET does not discard an unsubmitted human edit or unmount its focused input. Current authority
    // retirement and failed reads still clear all plaintext; a new generation cannot inherit the old reason.
    emit({ preview: undefined, approved: false, retryApproved: false, draft: pendingDraft, reopening, offset })
    try {
      const current = await read(operation.signal, offset)
      if (!operation.current() || !accept(current)) return
      const retained = retry && expires > clock.now() ? retry : undefined
      const unchanged =
        previous?.repository === current.repository &&
        previous.scope === current.scope &&
        previous.state.generation === current.state.generation
      emit({
        retry: retained,
        draft: unchanged ? pendingDraft : draft(),
        reopening:
          unchanged && reopening && reopenable(current.state.entries.find((entry) => entry.id === reopening.id))
            ? reopening
            : undefined,
        message: retained
          ? "Current state was read. It does not prove whether the uncertain confirmation committed. No action was resent."
          : "",
      })
    } catch {
      if (operation.current())
        clear(
          "Owner access or repository memory could not be verified. Private text and approvals were cleared.",
          "unavailable",
        )
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  const canPrepare = () =>
    !authorityRetired &&
    state.status === "ready" &&
    !!state.read &&
    !state.busy &&
    !state.preview &&
    !state.retry &&
    !unavailable(scope)
  const prepare = async (intent: ReviewMemoryIntent) => {
    if (!canPrepare() || !state.read) return
    if (intent.action === "reopen" && !reopenable(state.read.state.entries.find((entry) => entry.id === intent.id)))
      return
    const repository = state.read.repository
    const displayedScope = state.read.scope
    const generation = state.read.state.generation
    let request: ReviewMemoryControl.Prepare
    try {
      request = decode(ReviewMemoryControl.Prepare, {
        expectedScope: displayedScope,
        command: { ...intent, expected: generation },
      })
    } catch {
      emit({ message: "Enter bounded text, a reason, and at least one relative path pattern before previewing." })
      return
    }
    const operation = begin("preparing")
    if (!operation) return
    try {
      const fresh = await read(operation.signal)
      if (!operation.current() || !accept(fresh)) return
      if (fresh.repository !== repository || fresh.scope !== displayedScope || fresh.state.generation !== generation) {
        emit({
          draft: draft(),
          reopening: undefined,
          message: "Review memory changed. Inspect the refreshed entries before preparing another change.",
        })
        return
      }
      const command = request.command
      if (command.action === "reopen" && !reopenable(fresh.state.entries.find((entry) => entry.id === command.id))) {
        emit({
          reopening: undefined,
          message: "This outcome is no longer approved. Inspect its current state before preparing another change.",
        })
        return
      }
      const preview = decode(ReviewMemoryControl.Preview, await scope.api.prepare(request, operation.signal))
      if (!operation.current()) return
      if (!exactPreview(preview, request, repository) || preview.expiresAt <= clock.date())
        throw new Error("The exact preview could not be verified.")
      emit({ preview, draft: draft(), reopening: undefined, approved: false, retryApproved: false })
      arm(preview)
    } catch (cause) {
      if (!operation.current()) return
      clear(
        cause instanceof ReviewMemoryRequestError && cause.code === "denied"
          ? "Owner access changed. Private text and approvals were cleared."
          : "The preview could not be verified. Nothing was confirmed. Refresh before preparing again.",
        "unavailable",
      )
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  const confirm = async (retry = false) => {
    const preview = state.preview
    const confirmation = retry
      ? state.retry
      : preview && { previewId: preview.previewId, approvedSha256: preview.sha256 }
    if (!confirmation || (retry ? !state.retryApproved : !state.approved) || state.busy) return
    if (expires <= clock.now()) {
      expire()
      return
    }
    const operation = begin("confirming")
    if (!operation) return
    // Once sent, retain no private preview/draft, including on uncertain results.
    emit({
      read: undefined,
      preview: undefined,
      draft: draft(),
      reopening: undefined,
      approved: false,
      retryApproved: false,
      retry: undefined,
    })
    let message = "The confirmation response was received. Read the current memory below."
    try {
      const result = decode(
        ReviewMemoryControl.ConfirmationResult,
        await scope.api.confirm(confirmation, operation.signal),
      )
      if (preview) {
        if (preview.operation === "record" || preview.operation === "approve") {
          if (
            !("id" in result) ||
            result.status !== "active" ||
            (preview.operation === "record" &&
              (result.origin !== "owner" ||
                result.kind !== preview.payload.kind ||
                result.text !== preview.payload.text)) ||
            (preview.operation === "approve" && (result.origin !== "review" || result.id !== preview.payload.id))
          )
            throw new Error("The confirmation response did not match the approved change.")
        } else if (preview.operation === "reopen") {
          const original = preview.payload.entry
          if (
            !("id" in result) ||
            result.status !== "proposed" ||
            result.origin !== "review" ||
            result.kind !== "outcome" ||
            result.id !== original.id ||
            result.text !== original.text ||
            result.reason !== preview.payload.reason ||
            result.visibility !== original.visibility ||
            result.createdAt !== original.createdAt ||
            result.source.parentID !== original.source.parentID ||
            result.source.reviewID !== original.source.reviewID ||
            result.source.head !== original.source.head ||
            JSON.stringify(result.paths) !== JSON.stringify(original.paths) ||
            JSON.stringify(result.citations) !== JSON.stringify(original.citations)
          )
            throw new Error("The confirmation response did not match the outcome being reopened.")
        } else if (
          !("generation" in result) ||
          result.generation !== preview.expected + 1 ||
          (preview.operation === "configure" && result.enabled !== preview.payload.enabled)
        )
          throw new Error("The confirmation response did not match the approved change.")
      }
      if (!operation.current()) return
    } catch (cause) {
      if (!operation.current()) return
      if (!(cause instanceof ReviewMemoryRequestError)) {
        if (expires <= clock.now()) {
          expire()
          return
        }
        emit({
          status: "idle",
          retry: confirmation,
          message:
            "The result is uncertain. Private text was cleared. Refresh to inspect current state, or explicitly retry only this same confirmation.",
        })
        return
      }
      if (cause.code === "denied" || cause.code === "unavailable") {
        clear(
          "Owner access or the approval could not be verified. Private text and approvals were cleared.",
          "unavailable",
        )
        return
      }
      message =
        cause.code === "used"
          ? "This approval was already consumed. The current state does not prove which earlier request changed it. No action was resent."
          : "This approval cannot be used. Inspect current state before preparing another change."
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
    if (!operation.current()) return
    cancelExpiry?.()
    timerEpoch++
    cancelExpiry = undefined
    expires = 0
    const next = begin("reading")
    if (!next) return
    try {
      const current = await read(next.signal)
      if (next.current() && accept(current)) emit({ message })
    } catch {
      if (next.current())
        clear("The current owner state could not be verified. Refresh before making another change.", "unavailable")
    } finally {
      if (next.current()) emit({ busy: undefined })
    }
  }
  const discard = async () => {
    const preview = state.preview
    if (!preview || state.busy) return
    const operation = begin("discarding")
    if (!operation) return
    emit({ preview: undefined, approved: false, draft: draft(), reopening: undefined })
    cancelExpiry?.()
    timerEpoch++
    cancelExpiry = undefined
    expires = 0
    try {
      await scope.api.discard(preview.previewId, operation.signal)
      if (operation.current()) emit({ message: "Preview discarded. No change was confirmed." })
    } catch {
      if (operation.current())
        clear(
          "The preview could not be discarded under current owner authority. Private text was cleared.",
          "unavailable",
        )
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }
  const initialRefusal =
    unavailable(scope) || (authorityRetired ? "Verify current owner access after this connection changed." : "")
  clear(initialRefusal, initialRefusal ? "unavailable" : "idle")
  return {
    state: () => structuredClone(state),
    canRead: () => !disposed && !authorityRetired && !unavailable(scope),
    refresh,
    prepare,
    confirm: () => confirm(),
    retry: () => confirm(true),
    discard,
    canPrepare,
    selectReopen: (id: string) => {
      if (
        !canPrepare() ||
        state.reopening?.id === id ||
        !reopenable(state.read?.state.entries.find((entry) => entry.id === id))
      )
        return
      emit({ reopening: { id, reason: "" } })
    },
    editReopen: (reason: string) => {
      if (!canPrepare() || !state.reopening || reason.length > ReviewMemoryControl.LIMIT.reason) return
      emit({ reopening: { ...state.reopening, reason } })
    },
    cancelReopen: () => {
      if (canPrepare()) emit({ reopening: undefined })
    },
    prepareReopen: () => (state.reopening ? prepare({ action: "reopen", ...state.reopening }) : Promise.resolve()),
    editDraft: (patch: Partial<ReviewMemoryDraft>) => {
      if (!canPrepare()) return
      const next = { ...state.draft, ...patch }
      emit({
        draft: {
          ...next,
          text: next.text.slice(0, ReviewMemoryControl.LIMIT.body),
          reason: next.reason.slice(0, ReviewMemoryControl.LIMIT.reason),
          paths: next.paths.slice(0, ReviewMemoryControl.LIMIT.paths * 513),
        },
      })
    },
    prepareDraft: () =>
      prepare({
        action: "record",
        kind: state.draft.kind,
        text: state.draft.text.trim(),
        paths: state.draft.paths
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        citations: [],
        reason: state.draft.reason.trim(),
        visibility: state.draft.visibility,
      }),
    approve: (value: boolean) => {
      if (state.preview && !state.busy) emit({ approved: value })
    },
    approveRetry: (value: boolean) => {
      if (state.retry && !state.busy) emit({ retryApproved: value })
    },
    update: (next: ReviewMemorySelection) => {
      if (disposed || same(scope, next)) return false
      const valid = Number.isSafeInteger(next.epoch) && next.epoch >= 0
      const fresh = valid && next.epoch > proofEpoch && next.owner === "owner" && next.connected
      authorityRetired =
        (authorityRetired || !valid || next.epoch < proofEpoch || next.owner !== "owner" || !next.connected) && !fresh
      if (valid) proofEpoch = Math.max(proofEpoch, next.epoch)
      scope = { ...next }
      const refusal =
        unavailable(scope) || (authorityRetired ? "Verify current owner access after this connection changed." : "")
      clear(refusal, refusal ? "unavailable" : "idle")
      return true
    },
    retire: () => {
      if (!disposed) {
        authorityRetired = true
        clear("Connection authority changed. Refresh after owner access is verified.", "unavailable")
      }
    },
    dispose: () => {
      if (disposed) return
      clear("", "unavailable")
      disposed = true
    },
  }
}
