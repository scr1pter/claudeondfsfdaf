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
//   is idle again (packages/app/src/context/permission-auto-respond.ts).
// - Sessions the phone creates carry only a title; no permission ruleset.
// - Every request names a directory, which must be one of the engine's projects (a worktree or a sandbox, never the
//   global "/"), so a phone cannot start agents anywhere else on this computer.

export type EngineRequest = {
  method: "GET" | "POST"
  path: string
  query: Record<string, string>
  body?: unknown
}
export type EngineAnswer = { status: number; body: unknown }
export type RouteAnswer = { status: number; body: unknown }

const ID = /^[A-Za-z0-9_-]{1,128}$/
const QUERY_VALUE = 512
const TEXT_LIMIT = 32_000
const ANSWER_LIMIT = 4 * 1024 * 1024

type Query = Record<string, (value: string) => boolean>
type Route = {
  method: "GET" | "POST"
  path: string
  query?: Query
  /** The body sent on, from what the phone sent; undefined refuses the request. */
  body?: (body: unknown) => unknown | undefined
  /** The project list carries no directory. */
  global?: true
}

const isInteger = (value: string) => /^\d{1,9}$/.test(value)
const isBoolean = (value: string) => value === "true" || value === "false"
const isId = (value: string) => ID.test(value)
const isText = (value: string) => value.length <= 200

/** The allowlist. `:name` segments are ids. Methods and paths not listed here never reach the engine. */
export const REMOTE_ROUTES: readonly Route[] = [
  { method: "GET", path: "/project", global: true },
  { method: "GET", path: "/session", query: { roots: isBoolean, limit: isInteger, start: isInteger, search: isText } },
  { method: "GET", path: "/session/status" },
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
]

/** Sessions whose current turn a phone started. The app's auto-accept answers none of their requests. */
export function createRemoteTurns() {
  const marked = new Map<string, number>()
  return {
    mark(sessionID: string, at = Date.now()) {
      marked.set(sessionID, at)
    },
    clear(sessionID: string) {
      marked.delete(sessionID)
    },
    /** Whether any of these sessions (a request's session and the sessions above it) runs a phone's turn. */
    has(sessionIDs: readonly string[]) {
      return sessionIDs.some((id) => marked.has(id))
    },
    /** Follows the engine's events: a session that is idle again ran its phone turn to the end. */
    observe(event: { type?: unknown; properties?: unknown }) {
      const properties = (event.properties ?? {}) as Record<string, unknown>
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (!sessionID) return
      if (event.type === "session.idle") marked.delete(sessionID)
      if (event.type === "session.status") {
        const status = properties.status as Record<string, unknown> | undefined
        if (status?.type === "idle") marked.delete(sessionID)
      }
    },
    get size() {
      return marked.size
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

  const send = async (request: EngineRequest): Promise<RouteAnswer> => {
    const answer = await deps.engine(request).catch(() => undefined)
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
      let body: unknown
      if (match.route.method === "POST") {
        body = match.route.body?.(request.body)
        if (body === undefined)
          return refuse(400, "REMOTE_BODY_REFUSED", "Vector could not send that to this computer.")
      }
      const turn = match.route.path === "/session/:sessionID/prompt_async" ? match.params.sessionID : undefined
      // Marked before the engine starts the turn, so no request it raises reaches the app's auto-accept first.
      if (turn) deps.turns.mark(turn)
      const answer = await send({
        method: match.route.method,
        path: match.path,
        query,
        ...(body !== undefined ? { body } : {}),
      })
      if (turn && (answer.status < 200 || answer.status >= 300)) deps.turns.clear(turn)
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
