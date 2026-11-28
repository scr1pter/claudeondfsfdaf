import { alertTitle, type PhoneAlert } from "./phone-alerts"

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// A helper is a child session with lifecycle metadata. A fork also has a parent, but no lifecycle.
function helperSession(value: unknown) {
  const info = record(value)
  const lifecycle = record(record(info?.metadata)?.subagent)
  if (!info || !lifecycle || typeof info.id !== "string" || typeof info.parentID !== "string") return undefined
  return { id: info.id, parentID: info.parentID, lifecycle }
}

/**
 * Whether a helper's ask reaches the paired phones through createHelperPhoneAlerts instead of the ask alert. The
 * engine records a helper's wait only while it runs, so any other child keeps the ask alert.
 */
export function helperOwnsAskPhoneAlert(value: unknown) {
  return helperSession(value)?.lifecycle.status === "running"
}

/** Read lifecycle-owned metadata, never a task's output. No reason, prompt or partial command is included in a push. */
export function helperPhoneAlert(value: unknown, now: number) {
  const helper = helperSession(value)
  if (!helper) return undefined
  const lifecycle = helper.lifecycle
  const parent = typeof lifecycle.rootSessionID === "string" ? lifecycle.rootSessionID : helper.parentID
  const waiting = record(lifecycle.waiting)
  const interrupted = record(lifecycle.interruption)
  const event =
    waiting && (waiting.kind === "permission" || waiting.kind === "question") && typeof waiting.since === "number"
      ? { at: waiting.since, label: "A helper needs you", waiting: true }
      : interrupted &&
          interrupted.resumedAt === undefined &&
          interrupted.dismissedAt === undefined &&
          typeof interrupted.at === "number"
        ? { at: interrupted.at, label: "A helper was interrupted", waiting: false }
        : undefined
  if (!event || !Number.isFinite(event.at) || event.at > now || now - event.at > 5 * 60_000) return undefined
  return { parent, label: event.label, waiting: event.waiting, key: `${helper.id}:${event.at}:${event.label}` }
}

type Session = { title?: string | null; parentID?: string; internal?: string }

// How long a helper's wait must stand before the phones hear of it. A request auto-accept answers is gone well within
// it: the engine clears the helper's `waiting` once the request is answered, and that cleared state would otherwise
// have reached the phone as a "needs you" nobody needed (Track B B09). An interruption is never answered that way, so
// it goes at once.
const SETTLE_MS = 3_000

/**
 * The paired phones' alerts for helpers (Track B B09), from the engine's `session.updated` events. Each fresh waiting or
 * interrupted state alerts once, titled with the conversation's session (never the helper's title, report, prompt or
 * command); a wait only when it still stands after a short settle. The conversation must be one the person can see and
 * not internal; an interruption also skips the conversation being looked at.
 */
export function createHelperPhoneAlerts(input: {
  lookup(directory: string, sessionID: string): Promise<Session | undefined>
  allowed(sessionID: string, session: Session): boolean
  viewed(directory: string, sessionID: string): boolean
  disposed(): boolean
  send(alert: PhoneAlert): unknown
  now?: () => number
  settleMs?: number
}) {
  const sent = new Set<string>()
  // The notice each helper's latest update carries, by session id: a settled notice alerts only while it is the latest.
  const latest = new Map<string, string>()
  return async (directory: string, info: unknown) => {
    const id = record(info)?.id
    if (typeof id !== "string") return
    const notice = helperPhoneAlert(info, (input.now ?? Date.now)())
    if (!notice) {
      latest.delete(id)
      return
    }
    // A notice already sent or settling never becomes the latest again, so a late or replayed update repeating a wait
    // that was answered during its settle sends nothing.
    if (sent.has(notice.key)) return
    latest.set(id, notice.key)
    sent.add(notice.key)
    if (sent.size > 500) sent.delete(sent.values().next().value!)
    if (notice.waiting) await new Promise((resolve) => setTimeout(resolve, input.settleMs ?? SETTLE_MS))
    if (latest.get(id) !== notice.key) return
    latest.delete(id)
    if (input.disposed()) return
    const session = await input.lookup(directory, notice.parent)
    if (input.disposed() || !session || !input.allowed(notice.parent, session)) return
    // A wait is the only phone push for a helper's ask (ask-notification-controller.ts), so like every ask's push it goes
    // whoever looks at the conversation here: the person may be driving it from the phone.
    if (!notice.waiting && input.viewed(directory, notice.parent)) return
    await input.send({
      event: "needsYou",
      title: alertTitle(notice.label, session.title ?? undefined),
      route: "sessions",
    })
  }
}
