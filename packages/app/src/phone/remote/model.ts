import type { EngineEvent, RemoteState, RemoteView } from "./client"

// What the phone's Remote pages show (WP A42), as pure functions of what the computer and Vector's API answer. The
// computer decides what a request may do (its allowlist) and the server decides what the plan allows (S1); these only
// decide what is on screen.

/** The relay this phone app connects to. The phone origin's CSP (vercel.json) names the same host. */
export const RELAY_HOST = "relay.vectordev.ai"

/** Whether the phone may open the relay address a ticket named: Vector's relay, or a local one in development. */
export function relayAllowed(url: URL, origin: string) {
  if (url.protocol === "wss:" && url.host === RELAY_HOST && !url.port) return true
  const local = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host)
  return local(new URL(origin).hostname) && local(url.hostname) && (url.protocol === "ws:" || url.protocol === "wss:")
}

/** This phone's plain name for the computer and Devices: the kind of device, never anything personal. */
export function phoneName(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number } = {}) {
  const agent = nav.userAgent ?? ""
  if (/\biPad\b/.test(agent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)) return "iPad"
  if (/\biPhone\b/.test(agent)) return "iPhone"
  if (/\bAndroid\b/.test(agent)) return /\bMobile\b/.test(agent) ? "Android phone" : "Android tablet"
  return "Phone"
}

/** The pairing link a page was opened with (`/phone/pair#<offer>`), or undefined. */
export function pairingLinkFromLocation(location: { origin: string; pathname: string; hash: string }) {
  if (!/^\/phone\/pair\/?$/.test(location.pathname) || location.hash.length < 2) return undefined
  return `${location.origin}/phone/pair${location.hash}`
}

/** Six digits as people read them: "123 456". */
export function spacedCode(code: string) {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export type RemoteNotice = { text: string; action?: "reconnect" | "reset" }

/** What to say about the connection, and what the person can do about it, or undefined while all is well. */
export function remoteNotice(view: Pick<RemoteView, "state" | "message">): RemoteNotice | undefined {
  const again: RemoteState[] = ["offline", "idle-closed", "replaced", "unavailable", "signed-out"]
  if (view.state === "idle" || view.state === "online") return undefined
  if (view.state === "connecting") return { text: "Connecting to Vector Remote…" }
  const text = view.message ?? "Vector Remote is not connected."
  if (view.state === "revoked") return { text, action: "reset" }
  if (again.includes(view.state)) return { text, action: view.state === "signed-out" ? undefined : "reconnect" }
  return { text }
}

/** A paired computer's channel, in words. */
export function computerLine(computer: RemoteView["computers"][number]) {
  if (computer.channel === "open") return "Connected"
  if (computer.channel === "opening") return "Connecting…"
  if (computer.channel === "not-paired") return "This computer no longer has this phone paired. Pair it again."
  if (computer.channel === "update-phone") return "Update this phone app to use this computer."
  if (computer.channel === "update-desktop") return "Update Vector on this computer to use it from your phone."
  return computer.online ? "Online" : "Not connected. Open Vector on that computer and turn on Remote."
}

// ── Devices (`GET /api/remote/devices`) ──────────────────────────────────────────────────────────────────────────

export type AccountDevice = {
  device: string
  role: "computer" | "phone"
  name: string
  pairedAt: number
  lastSeen: number
  online: boolean
  overLimit: boolean
}
export type AccountDevices = {
  devices: AccountDevice[]
  limits: { computers: number; phones: number }
  fairUse: "ok" | "viewer" | "awake"
  available: boolean
}

const DEVICE = /^[A-Za-z0-9_-]{21}[AQgw]$/
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0)

export function decodeDevices(body: unknown): AccountDevices {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const limits = value.limits && typeof value.limits === "object" ? (value.limits as Record<string, unknown>) : {}
  const devices = Array.isArray(value.devices)
    ? value.devices.flatMap((item): AccountDevice[] => {
        if (!item || typeof item !== "object") return []
        const entry = item as Record<string, unknown>
        if (typeof entry.device !== "string" || !DEVICE.test(entry.device)) return []
        if (entry.role !== "computer" && entry.role !== "phone") return []
        return [
          {
            device: entry.device,
            role: entry.role,
            name:
              typeof entry.name === "string" && entry.name.trim()
                ? entry.name.slice(0, 64)
                : entry.role === "computer"
                  ? "Computer"
                  : "Phone",
            pairedAt: count(entry.pairedAt),
            lastSeen: count(entry.lastSeen),
            online: entry.online === true,
            overLimit: entry.overLimit === true,
          },
        ]
      })
    : []
  return {
    devices,
    limits: { computers: count(limits.computers), phones: count(limits.phones) },
    fairUse: value.fairUse === "viewer" || value.fairUse === "awake" ? value.fairUse : "ok",
    available: value.available === true,
  }
}

/** "2 of 3 computers paired", from the status meter when the server sends it, else the account's device list. */
export function pairedCount(meter: { computers: number; limit: number } | undefined, devices?: AccountDevices) {
  const computers = meter?.computers ?? devices?.devices.filter((item) => item.role === "computer").length
  const limit = meter?.limit ?? devices?.limits.computers
  if (computers === undefined || limit === undefined) return undefined
  return `${computers} of ${limit} ${limit === 1 ? "computer" : "computers"} paired.`
}

export function fairUseLine(fairUse: AccountDevices["fairUse"]) {
  if (fairUse === "viewer") return "This month's phone viewing time is used up. Phones reconnect when your plan renews."
  if (fairUse === "awake") return "This month's Remote time is used up. Devices reconnect when your plan renews."
  return undefined
}

export function lastSeenLine(device: AccountDevice, now = Date.now()) {
  if (device.online) return "Connected now"
  if (!device.lastSeen) return "Not seen yet"
  const minutes = Math.round((now - device.lastSeen) / 60_000)
  if (minutes < 2) return "Seen just now"
  if (minutes < 60) return `Seen ${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `Seen ${hours} ${hours === 1 ? "hour" : "hours"} ago`
  return `Seen ${Math.round(hours / 24)} days ago`
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Project = { id: string; worktree: string; name: string; sandboxes: string[] }
export type SessionRow = {
  id: string
  title: string
  directory: string
  project: string
  updated: number
  status: "idle" | "busy" | "retry"
}

export function decodeProjects(body: unknown): Project[] {
  if (!Array.isArray(body)) return []
  return body.flatMap((item): Project[] => {
    if (!item || typeof item !== "object") return []
    const project = item as Record<string, unknown>
    if (typeof project.id !== "string" || typeof project.worktree !== "string" || project.worktree === "/") return []
    const name =
      typeof project.name === "string" && project.name.trim()
        ? project.name
        : (project.worktree.split(/[\\/]/).filter(Boolean).pop() ?? project.worktree)
    const sandboxes = Array.isArray(project.sandboxes)
      ? project.sandboxes.filter((value): value is string => typeof value === "string")
      : []
    return [{ id: project.id, worktree: project.worktree, name, sandboxes }]
  })
}

export function statusOf(value: unknown): SessionRow["status"] {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined
  return type === "busy" ? "busy" : type === "retry" ? "retry" : "idle"
}

/** The sessions to list, newest first: top-level sessions only, without internal ones. */
export function sessionRows(
  project: Project,
  directory: string,
  sessions: unknown,
  statuses: unknown,
): SessionRow[] {
  if (!Array.isArray(sessions)) return []
  const status = statuses && typeof statuses === "object" ? (statuses as Record<string, unknown>) : {}
  return sessions
    .flatMap((item): SessionRow[] => {
      if (!item || typeof item !== "object") return []
      const session = item as Record<string, unknown>
      if (typeof session.id !== "string" || session.parentID || session.internal) return []
      const time = session.time && typeof session.time === "object" ? (session.time as Record<string, unknown>) : {}
      if (typeof time.archived === "number") return []
      return [
        {
          id: session.id,
          title: typeof session.title === "string" && session.title.trim() ? session.title : "Untitled session",
          directory,
          project: project.name,
          updated: typeof time.updated === "number" ? time.updated : 0,
          status: statusOf(status[session.id]),
        },
      ]
    })
    .sort((a, b) => b.updated - a.updated)
}

export type PartView =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "tool"; tool: string; state: string; title?: string }
  | { id: string; kind: "other"; label: string }
export type MessageView = { id: string; role: "user" | "assistant"; created: number; parts: PartView[]; error?: string }

function partView(value: unknown): PartView | undefined {
  if (!value || typeof value !== "object") return undefined
  const part = value as Record<string, unknown>
  if (typeof part.id !== "string") return undefined
  if (part.type === "text") {
    if (part.synthetic || part.ignored) return undefined
    return { id: part.id, kind: "text", text: typeof part.text === "string" ? part.text : "" }
  }
  if (part.type === "reasoning") return undefined
  if (part.type === "tool") {
    const state = part.state && typeof part.state === "object" ? (part.state as Record<string, unknown>) : {}
    return {
      id: part.id,
      kind: "tool",
      tool: typeof part.tool === "string" ? part.tool : "tool",
      state: typeof state.status === "string" ? state.status : "pending",
      ...(typeof state.title === "string" && state.title ? { title: state.title.slice(0, 200) } : {}),
    }
  }
  if (part.type === "file") return { id: part.id, kind: "other", label: "A file" }
  if (part.type === "patch") return { id: part.id, kind: "other", label: "Changes to files" }
  return undefined
}

function messageInfo(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const info = value as Record<string, unknown>
  if (typeof info.id !== "string" || (info.role !== "user" && info.role !== "assistant")) return undefined
  const time = info.time && typeof info.time === "object" ? (info.time as Record<string, unknown>) : {}
  const error = info.error && typeof info.error === "object" ? (info.error as Record<string, unknown>) : undefined
  const data = error?.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : undefined
  return {
    id: info.id,
    role: info.role as "user" | "assistant",
    created: typeof time.created === "number" ? time.created : 0,
    ...(error ? { error: typeof data?.message === "string" ? data.message.slice(0, 300) : "The turn stopped." } : {}),
  }
}

/** A session's messages as `GET /session/:id/message` answers them. */
export function decodeMessages(body: unknown): MessageView[] {
  if (!Array.isArray(body)) return []
  return body
    .flatMap((item): MessageView[] => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      const info = messageInfo(entry.info)
      if (!info) return []
      const parts = Array.isArray(entry.parts)
        ? entry.parts.flatMap((part) => {
            const view = partView(part)
            return view ? [view] : []
          })
        : []
      return [{ ...info, parts }]
    })
    .sort((a, b) => a.created - b.created)
}

/**
 * Applies one streamed event to a session's messages. Answers `stale` when the event left out what was needed
 * (`truncated`), so the page offers to load the session again instead of showing something partial.
 */
export function applyMessageEvent(messages: MessageView[], sessionID: string, event: EngineEvent) {
  const properties = (event.properties ?? {}) as Record<string, unknown>
  const info = (properties.info ?? {}) as Record<string, unknown>
  const part = (properties.part ?? {}) as Record<string, unknown>
  const session = properties.sessionID ?? info.sessionID ?? part.sessionID
  if (session !== sessionID) return { messages, stale: false }
  if (event.truncated) return { messages, stale: true }
  const next = messages.map((message) => ({ ...message, parts: message.parts.slice() }))
  const find = (id: unknown) => next.find((message) => message.id === id)
  if (event.type === "message.updated") {
    const updated = messageInfo(properties.info)
    if (!updated) return { messages, stale: false }
    const existing = find(updated.id)
    if (existing) Object.assign(existing, updated)
    else next.push({ ...updated, parts: [] })
    return { messages: next.sort((a, b) => a.created - b.created), stale: false }
  }
  if (event.type === "message.removed") return { messages: next.filter((item) => item.id !== properties.messageID), stale: false }
  if (event.type === "message.part.updated") {
    const view = partView(properties.part)
    const message = find(part.messageID)
    if (!message) return { messages, stale: true }
    const index = message.parts.findIndex((item) => item.id === part.id)
    if (!view) {
      if (index >= 0) message.parts.splice(index, 1)
    } else if (index >= 0) message.parts[index] = view
    else message.parts.push(view)
    return { messages: next, stale: false }
  }
  if (event.type === "message.part.delta") {
    const message = find(properties.messageID)
    const target = message?.parts.find((item) => item.id === properties.partID)
    if (!message || !target) return { messages, stale: true }
    if (target.kind === "text" && properties.field === "text" && typeof properties.delta === "string")
      Object.assign(target, { text: target.text + properties.delta })
    return { messages: next, stale: false }
  }
  if (event.type === "message.part.removed") {
    const message = find(properties.messageID)
    if (message) message.parts = message.parts.filter((item) => item.id !== properties.partID)
    return { messages: next, stale: false }
  }
  return { messages, stale: false }
}

// ── Approvals ────────────────────────────────────────────────────────────────────────────────────────────────────

export type PermissionView = {
  id: string
  sessionID: string
  directory: string
  title: string
  detail?: string
}
export type QuestionView = {
  id: string
  sessionID: string
  directory: string
  questions: { header: string; question: string; options: string[]; multiple: boolean }[]
}

const TITLES: Record<string, string> = {
  bash: "Run a command",
  edit: "Edit files",
  write: "Write a file",
  read: "Read a file",
  webfetch: "Fetch a web page",
  websearch: "Search the web",
  external_directory: "Work outside the repository",
  task: "Start an agent",
}

/** One pending permission request, in words, with what it would do. */
export function permissionView(value: unknown, directory: string): PermissionView | undefined {
  if (!value || typeof value !== "object") return undefined
  const request = value as Record<string, unknown>
  if (typeof request.id !== "string" || typeof request.sessionID !== "string") return undefined
  const permission = typeof request.permission === "string" ? request.permission : "permission"
  const metadata = request.metadata && typeof request.metadata === "object" ? (request.metadata as Record<string, unknown>) : {}
  const patterns = Array.isArray(request.patterns)
    ? request.patterns.filter((item): item is string => typeof item === "string")
    : []
  const command = typeof metadata.command === "string" ? metadata.command : undefined
  const detail = (command ?? patterns.join("\n")).slice(0, 2_000)
  return {
    id: request.id,
    sessionID: request.sessionID,
    directory,
    title: TITLES[permission] ?? `Use ${permission}`,
    ...(detail ? { detail } : {}),
  }
}

export function questionView(value: unknown, directory: string): QuestionView | undefined {
  if (!value || typeof value !== "object") return undefined
  const request = value as Record<string, unknown>
  if (typeof request.id !== "string" || typeof request.sessionID !== "string" || !Array.isArray(request.questions))
    return undefined
  const questions = request.questions.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const question = item as Record<string, unknown>
    if (typeof question.question !== "string") return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) =>
          option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string"
            ? [(option as { label: string }).label.slice(0, 200)]
            : [],
        )
      : []
    return [
      {
        header: typeof question.header === "string" ? question.header.slice(0, 60) : "",
        question: question.question.slice(0, 2_000),
        options,
        multiple: question.multiple === true,
      },
    ]
  })
  if (!questions.length) return undefined
  return { id: request.id, sessionID: request.sessionID, directory, questions }
}

/**
 * Applies one streamed event to the pending requests, with no request to the computer: the phone sends data only when
 * its person does something, and the relay closes a phone that is idle for 30 minutes.
 */
export function applyApprovalEvent(
  lists: { permissions: PermissionView[]; questions: QuestionView[] },
  event: EngineEvent,
) {
  const properties = (event.properties ?? {}) as Record<string, unknown>
  if (event.truncated && /^(permission|question)\.asked$/.test(event.type)) return { ...lists, stale: true }
  if (event.type === "permission.asked") {
    const view = permissionView(properties, event.directory)
    if (!view || lists.permissions.some((item) => item.id === view.id)) return { ...lists, stale: false }
    return { permissions: [...lists.permissions, view], questions: lists.questions, stale: false }
  }
  if (event.type === "question.asked") {
    const view = questionView(properties, event.directory)
    if (!view || lists.questions.some((item) => item.id === view.id)) return { ...lists, stale: false }
    return { permissions: lists.permissions, questions: [...lists.questions, view], stale: false }
  }
  if (event.type === "permission.replied")
    return {
      permissions: lists.permissions.filter((item) => item.id !== properties.requestID),
      questions: lists.questions,
      stale: false,
    }
  if (event.type === "question.replied" || event.type === "question.rejected")
    return {
      permissions: lists.permissions,
      questions: lists.questions.filter((item) => item.id !== properties.requestID),
      stale: false,
    }
  return { ...lists, stale: false }
}

/** Applies one streamed event to the session list: titles, times and busy or idle, with no request to the computer. */
export function applySessionEvent(rows: SessionRow[], projects: readonly Project[], event: EngineEvent) {
  const properties = (event.properties ?? {}) as Record<string, unknown>
  const id = properties.sessionID
  if (typeof id !== "string") return rows
  if (event.type === "session.status") {
    const status = statusOf(properties.status)
    return rows.map((row) => (row.id === id ? { ...row, status } : row))
  }
  if (event.type === "session.idle") return rows.map((row) => (row.id === id ? { ...row, status: "idle" as const } : row))
  if (event.type === "session.deleted") return rows.filter((row) => row.id !== id)
  if (event.type !== "session.updated" && event.type !== "session.created") return rows
  const project = projects.find((item) => item.worktree === event.directory || item.sandboxes.includes(event.directory))
  if (!project) return rows
  const [updated] = sessionRows(project, event.directory, [properties.info], {})
  if (!updated) return rows.filter((row) => row.id !== id)
  const existing = rows.find((row) => row.id === id)
  const next = existing
    ? rows.map((row) => (row.id === id ? { ...updated, status: row.status } : row))
    : [...rows, updated]
  return next.sort((a, b) => b.updated - a.updated)
}

/** An answer the computer refused, in words. */
export function refusalText(answer: { status: number; body: unknown }) {
  const error = answer.body && typeof answer.body === "object" ? (answer.body as { error?: unknown }).error : undefined
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined
  if (typeof message === "string" && message.trim()) return message.slice(0, 300)
  return answer.status === 404 ? "That was already answered." : "The computer did not do that."
}
