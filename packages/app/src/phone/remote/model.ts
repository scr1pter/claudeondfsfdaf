import { Connect } from "@vectordevai/schema/connect"
import { destinationLabel, metadataRunID, verdictLabel } from "@/features/connect/connect-model"
import { connectConsentDetails, connectConsentDiff } from "@/features/connect/consent"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { goingFirst, runState, type TaskRow } from "@/features/connect/task-rows"
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
  | { id: string; kind: "tool"; tool: string; state: string; title?: string; run?: string }
  | { id: string; kind: "other"; label: string }
export type MessageView = { id: string; role: "user" | "assistant"; created: number; parts: PartView[]; error?: string }

/** `sessionID` is the conversation open on the phone; a `connect` part points at its run only for that one. */
function partView(value: unknown, sessionID?: string): PartView | undefined {
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
    const run = part.tool === "connect" ? metadataRunID(fieldsOf(state.metadata) ?? {}, sessionID) : undefined
    return {
      id: part.id,
      kind: "tool",
      tool: typeof part.tool === "string" ? part.tool : "tool",
      state: typeof state.status === "string" ? state.status : "pending",
      ...(typeof state.title === "string" && state.title ? { title: state.title.slice(0, 200) } : {}),
      ...(run ? { run } : {}),
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

/** A session's messages as `GET /session/:id/message` answers them, for the conversation `sessionID` names. */
export function decodeMessages(body: unknown, sessionID?: string): MessageView[] {
  if (!Array.isArray(body)) return []
  return body
    .flatMap((item): MessageView[] => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      const info = messageInfo(entry.info)
      if (!info) return []
      const parts = Array.isArray(entry.parts)
        ? entry.parts.flatMap((part) => {
            const view = partView(part, sessionID)
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
    const view = partView(properties.part, sessionID)
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
  denyOnly?: true
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
  // Connected tools (CW-23c). `connect_cloud` is left out: its presentation stays held (CN-14).
  connect: "Hand work to a connected tool",
  connect_model: "Send code to a review model",
  connect_write: "Change files with a connected tool's fix",
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
  const detail = consentDetail(permission, metadata) ?? (command ?? patterns.join("\n")).slice(0, 2_000)
  const denyOnly =
    PermissionPolicy.requiresConnectConfirmation(permission) &&
    (permission !== "connect_write" || !Connect.writeApprovalDetails(metadata, Connect.MAX_PHONE_APPROVAL_DIFF))
  return {
    id: request.id,
    sessionID: request.sessionID,
    directory,
    title: TITLES[permission] ?? `Use ${permission}`,
    ...(detail ? { detail } : {}),
    ...(denyOnly ? { denyOnly: true } : {}),
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

// ── Connected tools (CW-23c) ─────────────────────────────────────────────────────────────────────────────────────
//
// A `connect` tool part only points at its run. The card shows the run as the engine answers
// `GET /experimental/connect/runs` for the open conversation, never the copy saved in the part: that copy can be cut
// short by a stop or a restart, which the engine reads as cancelled, and it does not follow later fixes and
// dismissals. What the engine answers is projected here for display, not decoded against the schema, and a run, a
// status, a verdict, a severity or a finding status this build does not know is left out (fail closed). Finding titles
// and paths are written by a model, so they stay plain text: format characters are removed (as core
// connect/frame.ts does), other control characters become a space, and nothing is HTML- or entity-encoded, because the
// page renders text nodes. Finding bodies and suggestions never reach the view, and no view offers a fix, a dismissal
// or a worktree.

export type ConnectFindingLine = { severity: Connect.Severity; title: string; place: string }
export type ConnectRunView = {
  id: string
  title: string
  status: TaskRow["status"]
  going: boolean
  verdict?: string
  sendsTo?: string
  detail?: string
  /** Findings neither fixed nor dismissed. */
  findings: number
  /** "3 open findings: 1 blocking, 2 concerns", once a run completed, in full or in part. */
  breakdown?: string
  /** The first open findings, the most severe first. */
  shown: ConnectFindingLine[]
}

/** The finding lines a card shows; the rest stay in Vector on the computer. */
const SHOWN = 5
/** The most of a fix's change an approval shows. */
// As the computer's run rule (desktop remote-routes.ts `isRun`, Connect.RunID within its id rule); model.test.ts
// checks that it keeps every id RunID.create() makes and nothing that is not a Connect.RunID.
const RUN_ID = /^cr_[A-Za-z0-9_-]{1,61}$/
// As Connect.SendsTo (schema connect.ts).
const SENDS_TO = /^(this-computer|vector-codium|(model-server|provider):\S+)$/

// Every literal the schema allows, so one it adds fails typecheck here until the phone knows how to show it.
const RUN_STATUS: Record<Connect.RunStatus, true> = { queued: true, running: true, done: true }
const ACTION: Record<Connect.ActionID, true> = { review: true, fix: true }
const RESULT_STATE: Record<Connect.ResultState, true> = {
  completed: true,
  partial: true,
  refused: true,
  failed: true,
  cancelled: true,
}
const VERDICT: Record<Connect.Verdict, true> = {
  clean: true,
  findings: true,
  blocking: true,
  incomplete: true,
  "not-reviewed": true,
}
const SEVERITY: Record<Connect.Severity, number> = { blocking: 0, concern: 1, nit: 2 }
const FINDING_STATUS: Record<Connect.FindingStatus, true> = {
  open: true,
  fixing: true,
  fixed: true,
  "still-open": true,
  new: true,
  dismissed: true,
}

/** Whether the computer reports connected tools on: exactly `connections: true` in a 200 answer, as it checks. */
export function connectionsOn(answer: { status: number; body: unknown }) {
  return answer.status === 200 && fieldsOf(answer.body)?.connections === true
}

/** The open conversation's runs, newest first, from what `GET /experimental/connect/runs` answered. */
export function connectRuns(body: unknown, sessionID: string): ConnectRunView[] {
  if (!Array.isArray(body)) return []
  return body.slice(0, 200).flatMap((item) => connectRun(item, sessionID) ?? [])
}

/** The runs list: those still going first, at most `MAX_TASK_ROWS` in all, as the desktop's Tasks pane lists them. */
export function connectRunRows(runs: readonly ConnectRunView[]) {
  return goingFirst(runs, (run) => run.going)
}

/** The card for an assistant's `connect` part, while connected tools are on and its run is in the engine's answer. */
export function connectCard(
  message: Pick<MessageView, "role">,
  part: PartView,
  runs: readonly ConnectRunView[] | undefined,
  connections: boolean,
) {
  if (!connections || message.role !== "assistant" || part.kind !== "tool" || part.tool !== "connect") return undefined
  return part.run ? runs?.find((run) => run.id === part.run) : undefined
}

/**
 * Whether an event may have changed the open conversation's runs: its turn ended, a `connect` part changed, or one of
 * its runs did. The computer streams `connect.run.updated` (desktop remote-link.ts `STREAMED`), so a review started
 * from the phone, which has no part, changes as its run does.
 */
export function connectRunsChanged(event: EngineEvent, sessionID: string) {
  const properties = fieldsOf(event.properties) ?? {}
  if (["session.idle", "session.status", "session.error", "connect.run.updated"].includes(event.type))
    return properties.sessionID === sessionID
  if (event.type !== "message.part.updated") return false
  // A part too large to stream arrives without its tool name.
  if (event.truncated) return properties.sessionID === sessionID
  const part = fieldsOf(properties.part)
  return part?.sessionID === sessionID && part.tool === "connect"
}

/** The open conversation's pending connected-tools questions, from what `GET /permission` answered. */
export function connectAsks(body: unknown, directory: string, sessionID: string): PermissionView[] {
  if (!Array.isArray(body)) return []
  return body.flatMap((item) => (connectAsk(item, sessionID) ? (permissionView(item, directory) ?? []) : []))
}

/** Applies one streamed event to those questions; `stale` when one of this conversation's arrived cut short. */
export function applyConnectAskEvent(asks: PermissionView[], sessionID: string, event: EngineEvent) {
  const properties = fieldsOf(event.properties) ?? {}
  if (event.type === "permission.replied")
    return { asks: asks.filter((item) => item.id !== properties.requestID), stale: false }
  if (event.type !== "permission.asked" || properties.sessionID !== sessionID) return { asks, stale: false }
  if (event.truncated) return { asks, stale: true }
  const view = connectAsk(properties, sessionID) ? permissionView(properties, event.directory) : undefined
  if (!view || asks.some((item) => item.id === view.id)) return { asks, stale: false }
  return { asks: [...asks, view], stale: false }
}

/** A connected-tools refusal in the engine's words (a 400 with its own message), else as any other refusal. */
export function connectRefusalText(answer: { status: number; body: unknown }) {
  const message = fieldsOf(answer.body)?.message
  if (answer.status === 400 && typeof message === "string" && message.trim()) return message.slice(0, 300)
  return refusalText(answer)
}

/** What to say after a cancel, or undefined when the run was stopped. */
export function connectCancelProblem(answer: { status: number; body: unknown }) {
  if (answer.status !== 200) return connectRefusalText(answer)
  return answer.body === true ? undefined : "That run had already ended."
}

function connectRun(value: unknown, sessionID: string): ConnectRunView | undefined {
  const run = fieldsOf(value)
  const request = fieldsOf(run?.request)
  if (!run || !request || typeof run.id !== "string" || !RUN_ID.test(run.id) || request.id !== run.id) return undefined
  if (fieldsOf(request.requester)?.sessionID !== sessionID || typeof request.to !== "string") return undefined
  if (!isOneOf(RUN_STATUS, run.status) || !isOneOf(ACTION, request.action)) return undefined
  const result = connectResult(run.result)
  // A run carries a result exactly when it is done.
  if ((run.result !== undefined && !result) || (run.status === "done") !== (result !== undefined)) return undefined
  const ended = result && (result.state === "completed" || result.state === "partial") ? result : undefined
  const open = (ended?.findings ?? [])
    .filter((finding) => finding.status !== "fixed" && finding.status !== "dismissed")
    .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])
  const progress = fieldsOf(run.progress)?.message
  const detail = !result
    ? typeof progress === "string"
      ? plain(progress, 300)
      : ""
    : result.state === "refused" || result.state === "failed"
      ? plain(result.summary, 300)
      : ""
  return {
    id: run.id,
    title: `${request.to === "vectorscope" ? "VectorScope" : plain(request.to, 60)} ${request.action}`,
    status: runState({ status: run.status, ...(result ? { result } : {}) }).status,
    going: run.status !== "done",
    ...(request.action === "review" && ended ? { verdict: verdictLabel(ended) } : {}),
    ...(result ? { sendsTo: `Code sent to: ${destinationLabel(result.sendsTo)}` } : {}),
    ...(detail ? { detail } : {}),
    findings: open.length,
    ...(ended ? { breakdown: breakdown(open) } : {}),
    shown: open.slice(0, SHOWN).map((finding) => ({
      severity: finding.severity,
      title: plain(finding.title, 200),
      place: tail(plain(finding.line ? `${finding.path}:${finding.line}` : finding.path, Infinity), 200),
    })),
  }
}

/** A run's result as the card reads it, or undefined when absent or not recognised. */
function connectResult(value: unknown) {
  const result = fieldsOf(value)
  if (!result || !isOneOf(RESULT_STATE, result.state) || !Array.isArray(result.findings)) return undefined
  if (result.verdict !== undefined && !isOneOf(VERDICT, result.verdict)) return undefined
  if (result.sendsTo !== undefined && !isSendsTo(result.sendsTo)) return undefined
  const findings = result.findings.flatMap((item) => connectFinding(item) ?? [])
  // One finding it cannot read would make the count and the verdict understate the review.
  if (findings.length !== result.findings.length) return undefined
  return {
    state: result.state,
    ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
    ...(result.sendsTo !== undefined ? { sendsTo: result.sendsTo } : {}),
    summary: typeof result.summary === "string" ? result.summary : "",
    findings,
  }
}

function connectFinding(value: unknown) {
  const finding = fieldsOf(value)
  if (!finding || !isOneOf(SEVERITY, finding.severity) || !isOneOf(FINDING_STATUS, finding.status)) return undefined
  if (typeof finding.title !== "string" || typeof finding.path !== "string") return undefined
  const line = Number.isSafeInteger(finding.line) && Number(finding.line) > 0 ? Number(finding.line) : undefined
  return { severity: finding.severity, status: finding.status, title: finding.title, path: finding.path, line }
}

function breakdown(open: readonly { severity: Connect.Severity }[]) {
  if (!open.length) return "No open findings"
  const counts = (["blocking", "concern", "nit"] as const).flatMap((severity) => {
    const count = open.filter((finding) => finding.severity === severity).length
    if (!count) return []
    return [`${count} ${severity === "blocking" || count === 1 ? severity : `${severity}s`}`]
  })
  return `${open.length} open ${open.length === 1 ? "finding" : "findings"}: ${counts.join(", ")}`
}

/** Whether a pending question is one of the connect hub's, in this conversation. */
function connectAsk(value: unknown, sessionID: string) {
  const request = fieldsOf(value)
  if (!request || request.sessionID !== sessionID || typeof request.permission !== "string") return false
  return (
    connectConsentDetails({ permission: request.permission, metadata: fieldsOf(request.metadata) ?? {} }) !== undefined
  )
}

/**
 * A connected-tools question in the hub's own sentence; a fix's question also shows its change, as text. Format
 * characters in the change (bidirectional controls, zero-width characters) are shown as their code point, so the code
 * cannot read differently from what it applies.
 */
function consentDetail(permission: string, metadata: Record<string, unknown>) {
  const sentence = connectConsentDetails({ permission, metadata })
  if (sentence === undefined || permission !== "connect_write") return sentence
  const diff = connectConsentDiff({ permission, metadata })
  if (diff === undefined) return `${sentence}\n\nThe change itself is shown only in Vector on your computer.`
  if (diff.length <= Connect.MAX_PHONE_APPROVAL_DIFF) return `${sentence}\n\n${visible(diff)}`
  return `${sentence}\n\n${visible(head(diff, Connect.MAX_PHONE_APPROVAL_DIFF))}\n\nThe rest of this change is shown only in Vector on your computer.`
}

/** Model-written text as one plain line: format characters removed, control characters and runs of space as one. */
function plain(value: string, limit: number) {
  return head(
    value
      .replace(/\p{Cf}/gu, "")
      .replace(/[\p{Cc}\s]+/gu, " ")
      .trim(),
    limit,
  )
}

/** Each format character as "[U+202E]", in text. */
function visible(value: string) {
  return value.replace(
    /\p{Cf}/gu,
    (char) => `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`,
  )
}

/** The start of a text, never ending in the first half of a surrogate pair. */
function head(value: string, limit: number) {
  const last = value.charCodeAt(limit - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}

/** The end of a long path, where its file name and line are, never starting in the second half of a surrogate pair. */
function tail(value: string, limit: number) {
  if (value.length <= limit) return value
  const start = value.length - limit + 1
  const first = value.charCodeAt(start)
  return `…${value.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start)}`
}

function isSendsTo(value: unknown): value is Connect.SendsTo {
  return typeof value === "string" && value.length <= 300 && SENDS_TO.test(value)
}

function isOneOf<K extends string>(values: Record<K, unknown>, value: unknown): value is K {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(values, value)
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}
