import { Option, Schema } from "effect"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { ComputerScreenshotHistory } from "@vectordevai/app/computer/screenshot-history"
import { clampRetention } from "./computer-settings"

type Removal = ComputerScreenshotHistory.Removal
type Holder = NonNullable<Computer.ComputerState["holder"]>
type Timer = ReturnType<typeof setTimeout>

/** E13's owner-only route. It removes every copy of the selected screenshots, and `all` also vacuums the database. */
export const PRUNE_PATH = "/computer/screenshots/prune"
export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
/** The startup sweep waits until the app's own first reads are done. */
export const STARTUP_MS = 30_000
// Delete all vacuums and truncates the write-ahead log of a database that can be large.
const PRUNE_MS = 300_000
const DAYS = { "1d": 1, "7d": 7, "30d": 30 } as const
const decodeResult = Schema.decodeUnknownOption(
  Schema.Struct({ removed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
)

/**
 * What a scheduled sweep deletes for a retention choice already clamped to company policy. `session` keeps screenshots
 * until the conversation is deleted. `task` keeps only the running task's: everything that ended before it started,
 * or everything when no task runs (the computer is never held across a restart).
 */
export function retentionCutoff(retention: Computer.Retention, now: number, holder?: Holder): Removal | undefined {
  if (retention === "session") return
  if (retention === "task") return { before: holder ? Math.min(now, holder.startedAt) : now }
  return { before: now - DAYS[retention] * DAY_MS }
}

/** The local engine's prune route, over its authenticated loopback server. It answers how many screenshots went. */
export function computerPrune(
  connection: { url: string; password: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
) {
  const authorization = `Basic ${Buffer.from(`vector:${connection.password}`).toString("base64")}`
  return async (removal: Removal): Promise<number> => {
    // No directory: the deletion covers the whole database, and the engine serves it from the place it already uses
    // for the app's own server-wide reads instead of starting a project instance for it.
    const response = await fetcher(new URL(PRUNE_PATH, connection.url), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(removal),
      signal: AbortSignal.timeout(PRUNE_MS),
    })
    if (!response.ok) throw new Error(`The engine answered ${response.status}.`)
    const result = decodeResult(await response.json().catch(() => undefined))
    if (Option.isNone(result)) throw new Error("The engine did not answer with a count.")
    return result.value.removed
  }
}

export type ComputerRetentionTimers = {
  setTimeout(callback: () => void, ms: number): Timer
  clearTimeout(timer: Timer): void
  setInterval(callback: () => void, ms: number): Timer
  clearInterval(timer: Timer): void
}

const realTimers: ComputerRetentionTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
}

/**
 * D23: screenshots are deleted on the user's schedule, clamped by company policy (INV-C8). A sweep runs shortly after
 * the engine connects and then hourly; with `task`, the holder's screenshots also go when its task ends. Delete all
 * removes every screenshot and the engine vacuums. Deletions run one at a time, and after each one that removed
 * anything the renderer windows are told what went, because the engine never republishes the parts it changed.
 */
export function createComputerRetention(input: {
  settings: { get(): Computer.ResolvedComputerSettings }
  /** The child session that held a lease, when it differs from the root (its screenshots are stored there). */
  holderSession?(lease: number): string | undefined
  removed(removal: Removal): void
  warn(message: string, ...fields: unknown[]): void
  now?(): number
  timers?: ComputerRetentionTimers
}) {
  const now = input.now ?? Date.now
  const timers = input.timers ?? realTimers
  let prune: ((removal: Removal) => Promise<number>) | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let deleting: Promise<{ removed: number }> | undefined
  let startup: Timer | undefined
  let hourly: Timer | undefined
  let closed = false
  let task: { holder: Holder; lease: number } | undefined

  function effective(): Computer.Retention {
    const settings = input.settings.get()
    return clampRetention(settings.prefs.retention, settings.policy.maxRetentionDays)
  }

  function warn(error: unknown) {
    input.warn("Computer screenshot retention failed", error instanceof Error ? error.name : "Error")
  }

  /** One deletion at a time, in order; the renderer hears about each one that changed something. */
  function run(removal: Removal): Promise<number> {
    const next = tail.then(async () => {
      if (closed || !prune) throw new Error(`${Hands.NAME} can't reach Vector's engine.`)
      const removed = await prune(removal)
      if (!closed && (removed > 0 || "all" in removal)) {
        try {
          input.removed(removal)
        } catch (error) {
          warn(error)
        }
      }
      return removed
    })
    tail = next.catch(() => {})
    return next
  }

  async function sweep() {
    if (closed || !prune) return
    const removal = retentionCutoff(effective(), now(), task?.holder)
    if (!removal) return
    await run(removal).then(() => undefined, warn)
  }

  function unref(timer: Timer) {
    ;(timer as { unref?: () => void }).unref?.()
    return timer
  }

  function ended(previous: { holder: Holder; lease: number }) {
    if (effective() !== "task") return
    // Only what the finished task stored: a follow-up task can start at once in the same conversation.
    const before = now()
    const sessions = new Set([previous.holder.sessionID, input.holderSession?.(previous.lease)])
    for (const sessionID of sessions) if (sessionID) void run({ sessionID, before }).then(() => undefined, warn)
  }

  return {
    /** The engine is up: sweep once shortly, then hourly. A second engine connection keeps the first schedule. */
    attach(next: (removal: Removal) => Promise<number>) {
      if (closed || prune) return
      prune = next
      startup = unref(timers.setTimeout(() => void sweep(), STARTUP_MS))
      hourly = unref(timers.setInterval(() => void sweep(), HOUR_MS))
    },
    /** The controller's published state: a holder leaving (or changing) ends its task. */
    observe(state: Computer.ComputerState) {
      const holder = state.holder
      if (
        task &&
        (!holder ||
          holder.sessionID !== task.holder.sessionID ||
          holder.startedAt !== task.holder.startedAt ||
          state.lease !== task.lease)
      ) {
        const previous = task
        task = undefined
        ended(previous)
      }
      if (holder) task = { holder, lease: state.lease }
    },
    /** Settings changed: a new retention, or a new company maximum, applies now rather than at the next hour. */
    changed(previous: Computer.ResolvedComputerSettings) {
      if (clampRetention(previous.prefs.retention, previous.policy.maxRetentionDays) !== effective()) void sweep()
    },
    sweep,
    /** Settings' Delete all. A second press while one runs joins it, so its count is never replaced by zero. */
    deleteAll(): Promise<{ removed: number }> {
      if (deleting) return deleting
      const current = run({ all: true }).then(
        (removed) => ({ removed }),
        (error: unknown) => {
          warn(error)
          throw new Error(`${Hands.NAME} couldn't delete the screenshots. Try again.`)
        },
      )
      deleting = current
      void current.then(
        () => (deleting = undefined),
        () => (deleting = undefined),
      )
      return current
    },
    stop() {
      closed = true
      if (startup) timers.clearTimeout(startup)
      if (hourly) timers.clearInterval(hourly)
      startup = undefined
      hourly = undefined
    },
  }
}
