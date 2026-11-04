import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerMainCopy } from "@vectordevai/app/computer/main-copy"

export type ComputerNotifyTarget = { sessionID: string; directory: string }
export type ComputerNotification = { title: string; body: string }
type Holder = ComputerNotifyTarget & { startedAt: number; actions: number; apps: string[]; mode: Computer.Mode }
type Failure = ComputerNotifyTarget & { reason: "engine" | "error" }

const START_THROTTLE_MS = 5 * 60_000
const ASKED_MAX = 256

/**
 * Desktop main's Hands notifications (INV-T6): start, "needs you" and end, from fixed Vector-built copy only. The
 * holder is remembered because an ended state has none. Session titles, step lines and model text never appear.
 */
export function createComputerNotify(input: {
  show(message: ComputerNotification, onClick: () => void): void
  /** The Hands Settings page's "Notify me when it starts and finishes". */
  enabled(): boolean
  /** Whether one of Vector's own windows has focus. */
  focused(): boolean
  open(target: ComputerNotifyTarget): void
  /** Brings Vector back to the front after a foreground run ends. */
  front?(): void
  now?(): number
}) {
  const now = input.now ?? Date.now
  const started = new Map<string, number>()
  const asked = new Set<string>()
  const state: { holder?: Holder; failure?: Failure; closed: boolean } = { closed: false }
  const key = (target: ComputerNotifyTarget) => JSON.stringify([target.directory, target.sessionID])

  function send(message: ComputerNotification, target: ComputerNotifyTarget) {
    if (state.closed || !input.enabled()) return
    const destination = { sessionID: target.sessionID, directory: target.directory }
    try {
      input.show(message, () => input.open(destination))
    } catch {
      // A notification is a courtesy: the banner, tray and Tasks card still show the run.
    }
  }

  function start(holder: Holder) {
    const at = now()
    for (const [entry, time] of started) if (at - time >= START_THROTTLE_MS || at < time) started.delete(entry)
    if (started.has(key(holder))) return
    started.set(key(holder), at)
    send({ title: Hands.NAME, body: ComputerMainCopy.notificationStart() }, holder)
  }

  function ended(holder: Holder, phase: Computer.ComputerPhase) {
    const failure = state.failure && key(state.failure) === key(holder) ? state.failure.reason : undefined
    state.failure = undefined
    const body =
      phase === "done"
        ? ComputerMainCopy.notificationFinished({ count: holder.actions, app: list(holder.apps) })
        : phase === "stopped" && !failure
          ? ComputerMainCopy.notificationStopped()
          : ComputerMainCopy.notificationFailed({
              reason: ComputerMainCopy.failure({ reason: failure ?? "engine" }),
            })
    send({ title: Hands.NAME, body }, holder)
    if (!state.closed && holder.mode === "foreground" && (phase === "done" || phase === "stopped") && !failure)
      try {
        input.front?.()
      } catch {
        // Returning to the front is cosmetic.
      }
  }

  return {
    state(next: Computer.ComputerState) {
      if (state.closed) return
      const previous = state.holder
      if (next.holder) {
        const holder: Holder = {
          sessionID: next.holder.sessionID,
          directory: next.holder.directory,
          startedAt: next.holder.startedAt,
          actions: next.holder.actions,
          apps: [...new Set(next.apps.map((app) => app.name))],
          mode: next.mode,
        }
        // Every controller state is published, so an end is always seen before the next holder; nothing is guessed.
        state.holder = holder
        if (!previous || key(previous) !== key(holder) || previous.startedAt !== holder.startedAt) start(holder)
        const ask = next.ask
        if (ask && ["asking", "handoff", "paused"].includes(next.phase) && !asked.has(ask.requestID)) {
          if (asked.size >= ASKED_MAX) asked.clear()
          asked.add(ask.requestID)
          if (!input.focused())
            send(
              { title: ComputerMainCopy.notificationNeedsYou(), body: ask.title },
              { sessionID: holder.sessionID, directory: ask.directory },
            )
        }
        return
      }
      if (!previous) return
      state.holder = undefined
      asked.clear()
      // A run that ended without its Done or Stopped flash lost its engine (D18 disconnect).
      ended(previous, next.phase === "done" || next.phase === "stopped" ? next.phase : "off")
    },
    /** The next end of this conversation's run reads "couldn't finish", with a fixed reason. */
    fail(target: ComputerNotifyTarget, reason: Failure["reason"]) {
      if (!state.closed && state.holder && key(state.holder) === key(target)) state.failure = { ...target, reason }
    },
    close() {
      state.closed = true
      state.holder = undefined
      state.failure = undefined
      started.clear()
      asked.clear()
    },
  }
}

function list(names: readonly string[]) {
  if (names.length === 0) return undefined
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}
