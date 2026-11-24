import type { WebAuthn } from "@vectordevai/core/webauthn/verify"
import { ApprovalError, type PasskeyApprovals } from "./remote-passkey"

// What a paired phone may ask of this computer's engine (WP A41, S6): an allowlist of the engine's HTTP routes, each
// with the query fields and body it may carry, checked here before anything reaches the engine. Everything else is
// refused: configuration, files, terminals, shell and command runs, sharing, session settings, provider sign-ins and
// every route of the engine's own API this list does not name.
//
// Remote never widens the computer's own permission rules:
// - A permission request is answered from the phone only "once", after a passkey check this computer verifies
//   (remote-passkey.ts), or "reject". "always" is refused, so a phone never adds a rule.
// - A turn the phone starts carries only text: no tools, agent, system prompt, permission rules or files. Its session
//   is marked (`RemoteTurns`), and the app's auto-accept leaves that session's requests to a person until the session
//   is idle again (packages/app/src/context/permission-auto-respond.ts). A helper session that turn starts or resumes
//   while the mark stands is marked too, and stays with a person until it is idle or its helper record has ended, so
//   a helper left running in the background keeps the hold after the phone's turn itself is over (Track B B09). A
//   phone turn the engine refuses puts back the hold that stood before it, so it never releases an earlier one.
// - Sessions the phone creates carry only a title; no permission ruleset.
// - Every request names a directory, which must be one of the engine's projects (a worktree or a sandbox, never the
//   global "/"), so a phone cannot start agents anywhere else on this computer.
// - Connected tools (CW-23b) are offered only while the engine's `/experimental/capabilities` reports `connections`,
//   read for each request. A phone may list the members, list and read a conversation's runs, cancel a run, and start
//   one VectorScope review of uncommitted, staged or branch changes in a conversation, after a passkey check bound to
//   that conversation, folder and target; its questions then wait for a person, as those of a phone's turn do.
//   Fixes, budgets, security passes, foreground runs, dismissals, registered findings and the sessionless folder
//   review are never reachable.

export type EngineRequest = {
  method: "GET" | "POST"
  path: string
  query: Record<string, string>
  body?: unknown
  /** How long this computer waits for the engine's answer; 30 s when unset (engineWindowMs). Never sent on. */
  timeoutMs?: number
}
export type EngineAnswer = { status: number; body: unknown }
export type RouteAnswer = { status: number; body: unknown }

/**
 * How long this computer waits for the engine to take a phone's review start (CW-23b), the one request given longer
 * than 30 s. The engine answers a background start only once the review's own `connect` and `connect_model` questions
 * are answered, so the start allows one full passkey challenge for such a question (APPROVAL_TTL_MS, 2 minutes) and a
 * minute more. It stays under the 300 s headers timeout of Node's fetch, so this is the window that applies. When it
 * ends, the request is dropped, the engine cancels a review still waiting, the phone hears REMOTE_REVIEW_TIMEOUT, and
 * the conversation stays held.
 */
export const REVIEW_START_MS = 3 * 60_000

/** How long this computer's fetch waits for the engine (remote-engine.ts): a request's own window, else 30 s. */
export function engineWindowMs(request: EngineRequest) {
  return request.timeoutMs ?? 30_000
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const QUERY_VALUE = 512
const TEXT_LIMIT = 32_000
const ANSWER_LIMIT = 4 * 1024 * 1024
const MAX_REVIEW_HOLDS = 64

type Query = Record<string, (value: string) => boolean>
type Route = {
  method: "GET" | "POST"
  path: string
  query?: Query
  /** The body sent on, from what the phone sent; undefined refuses the request. */
  body?: (body: unknown) => unknown | undefined
  /** The project list carries no directory. */
  global?: true
  /** Checks for `:name` segments beyond the id rule. */
  params?: Query
  /** Query fields the request must carry. */
  required?: readonly string[]
  /** Offered only while the engine reports connected tools on. */
  connect?: true
}

const isInteger = (value: string) => /^\d{1,9}$/.test(value)
const isBoolean = (value: string) => value === "true" || value === "false"
const isId = (value: string) => ID.test(value)
const isText = (value: string) => value.length <= 200
// As SessionID (schema session-id.ts) and Connect.RunID (schema connect.ts), within the id rule. The phone's RUN_ID
// (app phone/remote/model.ts) is the same run rule; the workspace supervisor's (cloud-workspaces protocol.ts) takes
// letters and digits only, which is all RunID.create() emits. remote-routes.test.ts checks this one against the schema.
const isSession = (value: string) => value.startsWith("ses") && isId(value)
const isRun = (value: string) => /^cr_[A-Za-z0-9_-]{1,61}$/.test(value)

type ReviewScope = { sessionID: string; directory: string }
type ReviewIdentity = ReviewScope & { runID: string }

function reviewIdentity(value: unknown): ReviewIdentity | undefined {
  const input = recordOf(value)
  if (!input || typeof input.runID !== "string" || !isRun(input.runID)) return
  if (typeof input.sessionID !== "string" || !isSession(input.sessionID)) return
  if (typeof input.directory !== "string" || !input.directory || input.directory.length > 4_096) return
  return { runID: input.runID, sessionID: input.sessionID, directory: input.directory }
}

function reviewRun(body: unknown, scope: ReviewScope) {
  const run = recordOf(body)
  const request = recordOf(run?.request)
  const requester = recordOf(request?.requester)
  if (!run || !request || !requester || typeof run.id !== "string" || !isRun(run.id)) return
  if (request.id !== run.id || requester.kind !== "user" || requester.sessionID !== scope.sessionID) return
  if (request.directory !== scope.directory || request.to !== "vectorscope" || request.action !== "review") return
  if (request.background !== true) return
  const status = run.status
  if (status !== "queued" && status !== "running" && (status !== "done" || typeof recordOf(run.result)?.state !== "string"))
    return
  return { runID: run.id, status, target: reviewTarget(request.target) }
}

const reviewID = ({ runID, sessionID, directory }: ReviewIdentity) => JSON.stringify([runID, sessionID, directory])

/** The allowlist. `:name` segments are ids. Methods and paths not listed here never reach the engine. */
export const REMOTE_ROUTES: readonly Route[] = [
  { method: "GET", path: "/project", global: true },
  { method: "GET", path: "/session", query: { roots: isBoolean, limit: isInteger, start: isInteger, search: isText } },
  { method: "GET", path: "/session/status" },
  { method: "GET", path: "/experimental/capabilities" },
  { method: "GET", path: "/experimental/session/:sessionID/tasks", query: { descendants: isBoolean, active: isBoolean, shells: isBoolean, limit: (value) => isInteger(value) && Number(value) >= 1 && Number(value) <= 200 } },
  { method: "POST", path: "/experimental/session/:sessionID/stop", body: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const body = value as Record<string, unknown>
    if (Object.keys(body).some((key) => key !== "helpers") || typeof body.helpers !== "boolean") return undefined
    return { helpers: body.helpers }
  } },
  { method: "GET", path: "/session/:sessionID" },
  { method: "GET", path: "/session/:sessionID/children" },
  { method: "GET", path: "/session/:sessionID/todo" },
  { method: "GET", path: "/session/:sessionID/diff", query: { messageID: isId } },
  { method: "GET", path: "/session/:sessionID/message", query: { limit: isInteger, before: isId } },
  { method: "GET", path: "/session/:sessionID/message/:messageID" },
  { method: "POST", path: "/session", body: sessionBody },
  { method: "POST", path: "/session/:sessionID/prompt_async", body: promptBody },
  { method: "POST", path: "/session/:sessionID/abort", body: () => ({}) },
  { method: "GET", path: "/permission" },
  { method: "POST", path: "/permission/:requestID/reply", body: () => ({}) },
  { method: "GET", path: "/question" },
  { method: "POST", path: "/question/:requestID/reply", body: questionBody },
  { method: "POST", path: "/question/:requestID/reject", body: () => ({}) },
  // Connected tools (CW-23b), offered only while the engine reports them on.
  { method: "GET", path: "/experimental/connect", query: { sessionID: isSession }, connect: true },
  {
    method: "GET",
    path: "/experimental/connect/runs",
    query: { sessionID: isSession },
    required: ["sessionID"],
    connect: true,
  },
  {
    method: "GET",
    path: "/experimental/connect/runs/:runID",
    params: { runID: isRun },
    query: { sessionID: isSession },
    required: ["sessionID"],
    connect: true,
  },
  {
    method: "POST",
    path: "/experimental/connect/runs/:runID/cancel",
    params: { runID: isRun },
    query: { sessionID: isSession },
    // Scoped as the run read is: the phone cancels only a run of a conversation it names.
    required: ["sessionID"],
    body: (value) => (value === undefined || (isRecord(value) && Object.keys(value).length === 0) ? {} : undefined),
    connect: true,
  },
  // Started only through startReview, after a passkey check; every other path refuses its body.
  {
    method: "POST",
    path: "/experimental/session/:sessionID/connect",
    params: { sessionID: isSession },
    body: () => undefined,
    connect: true,
  },
]

/** Phone-started turns and detached reviews whose approval requests must wait for a person. */
export function createRemoteTurns(engine?: (request: EngineRequest) => Promise<EngineAnswer>) {
  // Each held session's hold: when it began, and whether it came from the session above it (then the helper's own
  // record ending releases it as well).
  const marked = new Map<string, { at: number; inherited: boolean }>()
  const starting = new Set<ReviewScope>()
  type ReviewHold = ReviewIdentity & { checking?: boolean; recheck?: boolean }
  const reviews = new Map<string, ReviewHold>()

  function checkReview(key: string, hold: ReviewHold) {
    if (!engine) return
    if (hold.checking) {
      hold.recheck = true
      return
    }
    hold.checking = true
    void engine({
      method: "GET",
      path: `/experimental/connect/runs/${hold.runID}`,
      query: { sessionID: hold.sessionID, directory: hold.directory },
    })
      .then((answer) => {
        if (reviews.get(key) !== hold) return
        const run = answer.status === 200 ? reviewRun(answer.body, hold) : undefined
        // The scoped Connect API uses 400 even for a missing run. Generic failures leave approval manual.
        if (
          (run?.runID === hold.runID && run.status === "done") ||
          (answer.status === 400 && recordOf(answer.body)?.code === "not_found")
        )
          reviews.delete(key)
      })
      .catch(() => undefined)
      .finally(() => {
        hold.checking = false
        if (!hold.recheck || reviews.get(key) !== hold) return
        hold.recheck = false
        checkReview(key, hold)
      })
  }

  return {
    /**
     * Holds a session for the phone's turn about to start. The returned function puts back the hold that stood before,
     * for a turn the engine did not take: a helper an earlier phone turn started, or that turn's own mark, keeps its
     * hold. It changes nothing once something else has replaced or released this hold.
     */
    mark(sessionID: string, at = Date.now()) {
      const before = marked.get(sessionID)
      const hold = { at, inherited: false }
      marked.set(sessionID, hold)
      return () => {
        if (marked.get(sessionID) !== hold) return
        if (before) marked.set(sessionID, before)
        else marked.delete(sessionID)
      }
    },
    /** Holds a signed review's questions while starting, then only its exact run once the engine names it. */
    startReview(scope: ReviewScope, target: NonNullable<ReturnType<typeof reviewTarget>>) {
      if (starting.size + reviews.size >= MAX_REVIEW_HOLDS) return
      starting.add(scope)
      return (answer?: RouteAnswer) => {
        if (!starting.delete(scope) || answer?.status !== 200) return false
        const run = reviewRun(answer.body, scope)
        if (!run?.target || reviewKey(run.target) !== reviewKey(target)) return false
        if (run.status === "done") return true
        const hold: ReviewHold = { ...scope, runID: run.runID }
        const key = reviewID(hold)
        reviews.set(key, hold)
        // A run can finish between creating the response and receiving it, before its event can find this hold.
        checkReview(key, hold)
        return true
      }
    },
    /** Session lineage for ordinary phone turns, or the exact run for a detached review prompt. */
    has(sessionIDs: readonly string[], review?: unknown) {
      if (sessionIDs.some((id) => marked.has(id))) return true
      const identity = reviewIdentity(review)
      if (!identity || identity.sessionID !== sessionIDs[0]) return false
      return (
        reviews.has(reviewID(identity)) ||
        [...starting].some(
          ({ sessionID, directory }) => sessionID === identity.sessionID && directory === identity.directory,
        )
      )
    },
    cancelledReview(review: ReviewIdentity) {
      reviews.delete(reviewID(review))
    },
    clearReviews() {
      reviews.clear()
      starting.clear()
    },
    /**
     * Follows the engine's events: a session that is idle again ran its phone turn to the end; a helper session
     * created, or resumed (its record running again since the mark), under a marked session is the phone's too, until
     * it is idle or its record has ended. A deleted session holds nothing.
     */
    observe(event: { type?: unknown; properties?: unknown }, directory?: string) {
      const properties = (event.properties ?? {}) as Record<string, unknown>
      if (event.type === "server.connected") {
        // The server has subscribed before sending readiness, so no terminal update can fall between this read
        // and the stream. Repeat the scoped reads after a reconnect to cover completions during the outage.
        for (const [key, hold] of reviews) checkReview(key, hold)
        return
      }
      if (event.type === "connect.run.updated") {
        if (!directory || typeof properties.sessionID !== "string") return
        const scope = { sessionID: properties.sessionID, directory }
        const run = reviewRun(properties.run, scope)
        if (run?.status === "done") reviews.delete(reviewID({ ...scope, runID: run.runID }))
        return
      }
      if (event.type === "session.deleted") {
        const info = recordOf(properties.info)
        if (typeof info?.id === "string") {
          marked.delete(info.id)
          for (const [key, hold] of reviews) {
            if (hold.directory === directory && hold.sessionID === info.id) checkReview(key, hold)
          }
        }
        return
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = recordOf(properties.info)
        if (typeof info?.id !== "string") return
        const subagent = recordOf(recordOf(info.metadata)?.subagent)
        // As the engine's SubagentLifecycle.open: a queued or running record is work in flight.
        const open = subagent?.status === "queued" || subagent?.status === "running"
        const parent = typeof info.parentID === "string" ? marked.get(info.parentID)?.at : undefined
        const started =
          event.type === "session.created" ||
          (open && typeof subagent?.startedAt === "number" && parent !== undefined && subagent.startedAt >= parent)
        if (parent !== undefined && started && !marked.has(info.id)) {
          marked.set(info.id, { at: parent, inherited: true })
          return
        }
        if (marked.get(info.id)?.inherited && typeof subagent?.status === "string" && !open) marked.delete(info.id)
        return
      }
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (!sessionID) return
      if (event.type === "session.idle") marked.delete(sessionID)
      if (event.type === "session.status") {
        const status = properties.status as Record<string, unknown> | undefined
        if (status?.type === "idle") marked.delete(sessionID)
      }
    },
    get size() {
      return marked.size + starting.size + reviews.size
    },
  }
}

export type RemoteTurns = ReturnType<typeof createRemoteTurns>

export type RouteDependencies = {
  engine: (request: EngineRequest) => Promise<EngineAnswer>
  /** The engine's project directories (worktrees and sandboxes), never "/". */
  directories: () => Promise<ReadonlySet<string>>
  approvals: PasskeyApprovals
  credential: (phone: string) => WebAuthn.Credential | undefined
  saveCredential: (phone: string, credential: WebAuthn.Credential) => Promise<void>
  turns: RemoteTurns
}

/**
 * Handles one request from a paired phone. `phone` is the device id its channel belongs to. Answers carry the
 * engine's status and body, or 4xx with `{error: {code, message}}` when this computer refuses.
 */
export function createRemoteRoutes(deps: RouteDependencies) {
  const refuse = (status: number, code: string, message: string): RouteAnswer => ({
    status,
    body: { error: { code, message } },
  })

  const directoryOf = async (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 4_096) return undefined
    const allowed = await deps.directories()
    return allowed.has(value) && value !== "/" ? value : undefined
  }

  /**
   * `timedOut` answers instead of a 502 when this computer's own window for the request ended: its fetch then rejects
   * with a TimeoutError (remote-engine.ts).
   */
  const send = async (request: EngineRequest, timedOut?: RouteAnswer): Promise<RouteAnswer> => {
    const answer = await deps
      .engine(request)
      .catch((error: unknown) =>
        timedOut && error instanceof Error && error.name === "TimeoutError" ? timedOut : undefined,
      )
    if (!answer) return refuse(502, "REMOTE_ENGINE_UNAVAILABLE", "Vector on this computer did not answer.")
    if (JSON.stringify(answer.body ?? null).length > ANSWER_LIMIT)
      return refuse(413, "REMOTE_ANSWER_TOO_LARGE", "That answer is too large to send to your phone.")
    return { status: answer.status, body: answer.body ?? null }
  }

  const pendingPermission = async (directory: string, requestID: string) => {
    const answer = await deps
      .engine({ method: "GET", path: "/permission", query: { directory } })
      .catch(() => undefined)
    if (!answer || answer.status !== 200 || !Array.isArray(answer.body)) return undefined
    const found = answer.body.find(
      (item): item is { id: string; sessionID: string } =>
        Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === requestID,
    )
    return found && typeof found.sessionID === "string" ? found : undefined
  }

  const approval = async (phone: string, directory: string, body: unknown): Promise<RouteAnswer> => {
    const requestID = body && typeof body === "object" ? (body as Record<string, unknown>).requestID : undefined
    if (typeof requestID !== "string" || !ID.test(requestID))
      return refuse(400, "REMOTE_REQUEST_INVALID", "Name the permission request to allow.")
    const credential = deps.credential(phone)
    if (!credential) return refuse(403, "REMOTE_NOT_PAIRED", "This phone is not paired with this computer.")
    const request = await pendingPermission(directory, requestID)
    if (!request) return refuse(404, "REMOTE_PERMISSION_GONE", "That request was already answered.")
    return {
      status: 200,
      body: deps.approvals.challenge(phone, { requestID, sessionID: request.sessionID, directory }, credential.id),
    }
  }

  const reply = async (phone: string, directory: string, requestID: string, body: unknown): Promise<RouteAnswer> => {
    const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
    if (input.reply === "reject") {
      const message =
        typeof input.message === "string" && input.message.trim() ? input.message.trim().slice(0, 2_000) : undefined
      return send({
        method: "POST",
        path: `/permission/${requestID}/reply`,
        query: { directory },
        body: { reply: "reject", ...(message ? { message } : {}) },
      })
    }
    if (input.reply !== "once")
      return refuse(403, "REMOTE_ONCE_ONLY", "From your phone you can allow a request once, or deny it.")
    const credential = deps.credential(phone)
    if (!credential) return refuse(403, "REMOTE_NOT_PAIRED", "This phone is not paired with this computer.")
    const request = await pendingPermission(directory, requestID)
    if (!request) return refuse(404, "REMOTE_PERMISSION_GONE", "That request was already answered.")
    const target = { requestID, sessionID: request.sessionID, directory }
    const verified = await deps.approvals.verify(phone, target, input.passkey, credential).catch((error: unknown) => {
      if (error instanceof ApprovalError) return error
      throw error
    })
    if (verified instanceof ApprovalError) return refuse(403, verified.code, verified.message)
    await deps.saveCredential(phone, verified)
    return send({
      method: "POST",
      path: `/permission/${requestID}/reply`,
      query: { directory },
      body: { reply: "once" },
    })
  }

  // Read for each request, so turning connected tools off on this computer takes effect at once; any doubt is "off".
  const connectionsOff = async (directory: string) => {
    const answer = await deps
      .engine({ method: "GET", path: "/experimental/capabilities", query: { directory } })
      .catch(() => undefined)
    if (answer?.status === 200 && isRecord(answer.body) && answer.body.connections === true) return undefined
    return refuse(403, "REMOTE_CONNECT_OFF", "Connected tools are off on this computer.")
  }

  const reviewApproval = async (phone: string, directory: string, body: unknown): Promise<RouteAnswer> => {
    const review = reviewRequest(body)
    if (!review) return refuse(400, "REMOTE_REQUEST_INVALID", "Name the conversation and the changes to review.")
    const credential = deps.credential(phone)
    if (!credential) return refuse(403, "REMOTE_NOT_PAIRED", "This phone is not paired with this computer.")
    const off = await connectionsOff(directory)
    if (off) return off
    return {
      status: 200,
      body: deps.approvals.challenge(
        phone,
        { requestID: reviewKey(review.target), sessionID: review.sessionID, directory },
        credential.id,
      ),
    }
  }

  const startReview = async (
    phone: string,
    directory: string,
    sessionID: string,
    raw: unknown,
  ): Promise<RouteAnswer> => {
    const input = reviewBody(raw)
    if (!input)
      return refuse(
        400,
        "REMOTE_BODY_REFUSED",
        "From your phone you can start a VectorScope review of uncommitted, staged or branch changes.",
      )
    const credential = deps.credential(phone)
    if (!credential) return refuse(403, "REMOTE_NOT_PAIRED", "This phone is not paired with this computer.")
    const verified = await deps.approvals
      .verify(phone, { requestID: reviewKey(input.target), sessionID, directory }, input.passkey, credential)
      .catch((error: unknown) => {
        if (error instanceof ApprovalError) return error
        throw error
      })
    if (verified instanceof ApprovalError) return refuse(403, verified.code, verified.message)
    await deps.saveCredential(phone, verified)
    const off = await connectionsOff(directory)
    if (off) return off
    const finish = deps.turns.startReview({ sessionID, directory }, input.target)
    if (!finish) return refuse(429, "REMOTE_REVIEW_BUSY", "Too many phone reviews are still running on this computer.")
    // Keep the original turn hold until this start is identified or the next idle, whichever comes first. The
    // restore only releases this start's own mark, so independent signed phone turns keep their existing protection.
    const restore = deps.turns.has([sessionID]) ? undefined : deps.turns.mark(sessionID)
    return send(
      {
        method: "POST",
        path: `/experimental/session/${sessionID}/connect`,
        query: { directory },
        // Always the background run, so the engine answers once the review's questions are behind it.
        body: { to: "vectorscope", target: input.target, background: true },
        timeoutMs: REVIEW_START_MS,
      },
      // This computer's window normally ends before the phone's (PHONE_REVIEW_START_MS, app client.ts, says when it
      // does not), so the phone normally hears of the timeout from here, in the words it uses for its own. Any other
      // failure stays REMOTE_ENGINE_UNAVAILABLE.
      refuse(
        504,
        "REMOTE_REVIEW_TIMEOUT",
        "Your computer did not answer within 3 minutes. A review still waiting for an approval stops then; answer its approval right away.",
      ),
    ).then(
      (answer) => {
        if (finish(answer)) restore?.()
        return answer
      },
      (error) => {
        finish()
        throw error
      },
    )
  }

  return {
    async handle(phone: string, raw: unknown): Promise<RouteAnswer> {
      const request = readRequest(raw)
      if (!request) return refuse(400, "REMOTE_REQUEST_INVALID", "Vector could not read that request.")
      if (request.method === "POST" && request.path === "/remote/approval") {
        const directory = await directoryOf(request.directory)
        if (!directory)
          return refuse(
            403,
            "REMOTE_DIRECTORY",
            "That folder is not one of the repositories Vector has open on this computer.",
          )
        if (isRecord(request.body) && "review" in request.body) return reviewApproval(phone, directory, request.body)
        return approval(phone, directory, request.body)
      }
      const match = matchRoute(request.method, request.path)
      if (!match) return refuse(403, "REMOTE_ROUTE_REFUSED", "Your phone cannot do that on this computer.")
      const query: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.query)) {
        const check = match.route.query?.[name]
        if (!check || !check(value)) return refuse(400, "REMOTE_QUERY_REFUSED", `The ${name} field is not allowed.`)
        query[name] = value
      }
      if (match.route.global) {
        const answer = await send({ method: "GET", path: "/project", query })
        return answer.status === 200 ? { status: 200, body: publicProjects(answer.body) } : answer
      }
      const directory = await directoryOf(request.directory)
      if (!directory)
        return refuse(
          403,
          "REMOTE_DIRECTORY",
          "That folder is not one of the repositories Vector has open on this computer.",
        )
      query.directory = directory
      if (match.route.path === "/permission/:requestID/reply")
        return reply(phone, directory, match.params.requestID!, request.body)
      if (match.route.params && !Object.entries(match.route.params).every(([name, check]) => check(match.params[name])))
        return refuse(400, "REMOTE_PATH_REFUSED", "Vector could not find that on this computer.")
      const missing = match.route.required?.find((name) => query[name] === undefined)
      if (missing) return refuse(400, "REMOTE_QUERY_REFUSED", `The ${missing} field is needed.`)
      if (match.route.path === "/experimental/session/:sessionID/connect")
        return startReview(phone, directory, match.params.sessionID, request.body)
      if (match.route.connect) {
        // Everything this computer refuses by itself is refused before the engine is asked whether connect is on.
        if (match.route.method === "POST" && match.route.body?.(request.body) === undefined)
          return refuse(400, "REMOTE_BODY_REFUSED", "Vector could not send that to this computer.")
        const off = await connectionsOff(directory)
        if (off) return off
      }
      let body: unknown
      if (match.route.method === "POST") {
        body = match.route.body?.(request.body)
        if (body === undefined)
          return refuse(400, "REMOTE_BODY_REFUSED", "Vector could not send that to this computer.")
      }
      // Marked before the engine starts the turn, so no request it raises reaches the app's auto-accept first.
      const restore =
        match.route.path === "/session/:sessionID/prompt_async" ? deps.turns.mark(match.params.sessionID!) : undefined
      const answer = await send({
        method: match.route.method,
        path: match.path,
        query,
        ...(body !== undefined ? { body } : {}),
      })
      // A turn the engine did not take leaves the session as it was, still held if an earlier turn holds it.
      if (restore && (answer.status < 200 || answer.status >= 300)) restore()
      if (match.route.path === "/experimental/connect/runs/:runID/cancel" && answer.status === 200 && answer.body === true)
        deps.turns.cancelledReview({ runID: match.params.runID!, sessionID: query.sessionID!, directory })
      return answer
    },
  }
}

function readRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.method !== "GET" && input.method !== "POST") return undefined
  if (typeof input.path !== "string" || input.path.length > 512) return undefined
  const query: Record<string, string> = {}
  if (input.query !== undefined) {
    if (!input.query || typeof input.query !== "object" || Array.isArray(input.query)) return undefined
    for (const [name, item] of Object.entries(input.query)) {
      if (typeof item !== "string" || item.length > QUERY_VALUE) return undefined
      query[name] = item
    }
  }
  // The directory is its own field: a query field named directory or workspace would route the engine elsewhere.
  if ("directory" in query || "workspace" in query) return undefined
  return { method: input.method, path: input.path, query, directory: input.directory, body: input.body }
}

/** The route a method and path match, with its id segments, or undefined. Only plain segments match. */
export function matchRoute(method: string, path: string) {
  if (!path.startsWith("/") || path.includes("//") || /[?#%\\]/.test(path)) return undefined
  const segments = path.split("/").slice(1)
  for (const route of REMOTE_ROUTES) {
    if (route.method !== method) continue
    const pattern = route.path.split("/").slice(1)
    if (pattern.length !== segments.length) continue
    const params: Record<string, string> = {}
    const matched = pattern.every((part, index) => {
      const segment = segments[index]!
      if (part.startsWith(":")) {
        if (!ID.test(segment)) return false
        params[part.slice(1)] = segment
        return true
      }
      return part === segment
    })
    if (matched) return { route, params, path: `/${segments.join("/")}` }
  }
  return undefined
}

function recordOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function sessionBody(body: unknown) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : ""
  return title ? { title } : {}
}

/** A phone's turn: text parts only. Tools, agent, system prompt, model, files and every other field stay behind. */
function promptBody(body: unknown) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (!Array.isArray(input.parts) || input.parts.length === 0 || input.parts.length > 8) return undefined
  const parts: { type: "text"; text: string }[] = []
  let size = 0
  for (const part of input.parts) {
    if (!part || typeof part !== "object") return undefined
    const item = part as Record<string, unknown>
    if (item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) return undefined
    size += item.text.length
    if (size > TEXT_LIMIT) return undefined
    parts.push({ type: "text", text: item.text })
  }
  return { parts }
}

function questionBody(body: unknown) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (!Array.isArray(input.answers) || input.answers.length > 20) return undefined
  const answers: string[][] = []
  for (const answer of input.answers) {
    if (!Array.isArray(answer) || answer.length > 20) return undefined
    if (!answer.every((label) => typeof label === "string" && label.length <= 2_000)) return undefined
    answers.push(answer as string[])
  }
  return { answers }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

// A git ref or revision for a branch review's base, as Connect.Ref (schema connect.ts) and `vector connected review
// --base` (cli/cmd/connected.ts): never an option, no space or control character. A 7-40 hex commit id passes. The
// phone's REF (app phone/remote/client.ts) and the workspace supervisor's (cloud-workspaces protocol.ts) mirror the
// same schema; remote-routes.test.ts checks this copy against Connect.Ref.
const REF = /^(?!-)[^\s\u0000-\u001f\u007f]{1,256}$/

/** What a phone may review: uncommitted, staged, or branch changes against an optional base; never a task's. */
function reviewTarget(value: unknown) {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if ((value.kind === "uncommitted" || value.kind === "staged") && keys.length === 1) return { kind: value.kind }
  if (value.kind !== "branch" || keys.some((key) => key !== "kind" && key !== "base")) return undefined
  if (value.base === undefined) return { kind: "branch" as const }
  if (typeof value.base !== "string" || !REF.test(value.base)) return undefined
  return { kind: "branch" as const, base: value.base }
}

/** A review challenge's request: exactly `{review: {sessionID, target}}`. */
function reviewRequest(body: unknown) {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isRecord(body.review)) return undefined
  const review = body.review
  if (Object.keys(review).some((key) => key !== "sessionID" && key !== "target")) return undefined
  if (typeof review.sessionID !== "string" || !isSession(review.sessionID)) return undefined
  const target = reviewTarget(review.target)
  return target ? { sessionID: review.sessionID, target } : undefined
}

/**
 * A phone's review start: exactly VectorScope's `review` of one target, and the passkey answer. Anything else (a fix,
 * another member, a budget, a security pass, an earlier run to compare with, a foreground run) is refused. The action
 * is checked here, not sent, because the engine's review input has none.
 */
function reviewBody(body: unknown) {
  if (!isRecord(body) || Object.keys(body).some((key) => !["to", "action", "target", "passkey"].includes(key)))
    return undefined
  if (body.to !== "vectorscope" || body.action !== "review") return undefined
  const target = reviewTarget(body.target)
  return target ? { target, passkey: body.passkey } : undefined
}

/**
 * The approval a review start is checked against: the member, the action and the exact target. It has ":", which the
 * id rule refuses, so a permission's challenge never starts a review and a review's never answers a permission.
 */
function reviewKey(target: NonNullable<ReturnType<typeof reviewTarget>>) {
  return `connect-review:vectorscope:review:${JSON.stringify(target)}`
}

/** The project list as the phone sees it: ids, names and folders, without the global project. */
function publicProjects(body: unknown) {
  if (!Array.isArray(body)) return []
  return body.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const project = item as Record<string, unknown>
    if (typeof project.id !== "string" || typeof project.worktree !== "string" || project.worktree === "/") return []
    const sandboxes = Array.isArray(project.sandboxes)
      ? project.sandboxes.filter((value): value is string => typeof value === "string")
      : []
    return [
      {
        id: project.id,
        worktree: project.worktree,
        ...(typeof project.name === "string" ? { name: project.name } : {}),
        sandboxes,
      },
    ]
  })
}

/** The directories a phone may name: each project's worktree and sandboxes, never "/". */
export function projectDirectories(body: unknown): Set<string> {
  return new Set(publicProjects(body).flatMap((project) => [project.worktree, ...project.sandboxes]))
}
