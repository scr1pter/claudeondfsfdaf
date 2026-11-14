import { enginePlace } from "./local-model"

// When Settings > Vector Local cannot read from the engine (Vector Local's status, or the model servers Find servers
// looks for): what failed in plain words, whether it may pass on its own, and when Vector tries again. A failure that may
// pass (the engine did not answer, was busy or slow, or broke) is tried again on its own a few times, each wait about
// twice the last; Try again starts over at any time. A refusal or an answer Vector does not understand is not tried
// again on its own, since asking again gets the same answer.

export type ReadTarget = "status" | "servers"

export type ReadFailure = {
  readonly target: ReadTarget
  readonly reason: "unreachable" | "slow" | "busy" | "broken" | "refused" | "unreadable"
  /** The HTTP status the engine answered with, when it answered. */
  readonly code?: number
  /** The engine's own reason, when it refused. */
  readonly message?: string
}

/** The automatic tries after a failure that may pass: 1, 2, 4 and 8 seconds apart, each give or take a fifth. */
export const RETRY = { attempts: 4, first: 1_000, max: 15_000, jitter: 0.2 } as const

/** How long the app waits for GET /local before it counts as too slow: an engine that hangs is tried again too. */
export const READ_TIMEOUT = 10_000

const SLOW = new Set([408, 504])
const BUSY = new Set([425, 429, 503])

/** What failed, from the HTTP status the engine answered with (none when it did not answer) and its error. */
export function readFailure(target: ReadTarget, answer: { status?: number; error?: unknown }): ReadFailure {
  const code = answer.status
  if (code === undefined) return { target, reason: noAnswer(answer.error) }
  if (SLOW.has(code)) return { target, reason: "slow", code }
  if (BUSY.has(code)) return { target, reason: "busy", code }
  // 501 says the engine does not do this at all, which asking again does not change.
  if (code >= 500 && code !== 501) return { target, reason: "broken", code }
  // A success Vector could not use, such as a body that is not the shape it asked for.
  if (code < 400) return { target, reason: "unreadable", code }
  const message = engineMessage(answer.error)
  return { target, reason: "refused", code, ...(message ? { message } : {}) }
}

/** Whether a failure may pass on its own, so Vector tries again without being asked. */
export function transient(failure: ReadFailure) {
  return failure.reason !== "refused" && failure.reason !== "unreadable"
}

/** The error's two sentences: what Vector could not read, then why, in plain words. */
export function readErrorText(failure: ReadFailure, remote?: string) {
  return { title: TITLE[failure.target](remote), reason: REASON[failure.reason](failure) }
}

const TITLE: Record<ReadTarget, (remote?: string) => string> = {
  status: (remote) => `Vector could not read Vector Local's status from its engine${remote ? ` on ${remote}` : ""}.`,
  servers: (remote) => `Vector could not look for model servers ${enginePlace(remote)}.`,
}

const REASON: Record<ReadFailure["reason"], (failure: ReadFailure) => string> = {
  unreachable: () => "The engine did not answer. It may still be starting, or the connection to it dropped.",
  slow: (failure) => `The engine took too long to answer${code(failure)}.`,
  busy: (failure) => `The engine was too busy to answer${code(failure)}.`,
  broken: (failure) => `Something went wrong inside the engine${code(failure)}.`,
  refused: (failure) =>
    failure.message
      ? `The engine said: ${sentence(failure.message)}`
      : `The engine turned the request down${code(failure)}.`,
  unreadable: () => "Vector did not understand the engine's answer. Vector and its engine may be different versions.",
}

/** Where the automatic tries stand: how many ran since the last success or Try again, and the wait before the next. */
export type RetryState = { readonly attempt: number; readonly wait: number | undefined }

/** The line under the error: trying now, the wait before the next try, or that Vector stopped trying on its own. */
export function retryText(failure: ReadFailure, retry: RetryState, trying: boolean) {
  if (trying) return "Trying again…"
  if (retry.wait !== undefined) {
    const seconds = Math.max(1, Math.round(retry.wait / 1000))
    return `Trying again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
  }
  if (transient(failure) && retry.attempt >= RETRY.attempts)
    return `Vector tried again ${retry.attempt} times and stopped trying on its own. Press Try again in a moment.`
  return undefined
}

/** The wait before automatic try `attempt` (0 for the first), or undefined when Vector does not try again on its own. */
export function retryDelay(failure: ReadFailure, attempt: number, random: () => number = Math.random) {
  if (!transient(failure) || attempt >= RETRY.attempts) return undefined
  const base = Math.min(RETRY.first * 2 ** attempt, RETRY.max)
  // Spread out, so several windows reading one engine that just came back do not all ask at the same moment.
  return Math.round(base * (1 + RETRY.jitter * (2 * random() - 1)))
}

type Timer = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

const TIMER: Timer = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Tries a read again on its own after a failure that may pass. The caller says when each read finished (`settled`, with
 * its failure or undefined), and `now` is the Try again button: it reads at once and starts the waits over.
 */
export function createReadRetry(input: {
  run: () => void
  onChange: (state: RetryState) => void
  timer?: Timer
  random?: () => number
}) {
  const timer = input.timer ?? TIMER
  let attempt = 0
  let pending: unknown
  let disposed = false
  const cancel = () => {
    if (pending !== undefined) timer.clear(pending)
    pending = undefined
  }
  return {
    settled(failure: ReadFailure | undefined) {
      cancel()
      // A read that finishes after the page closed starts nothing.
      if (disposed) return
      if (!failure) attempt = 0
      const wait = failure ? retryDelay(failure, attempt, input.random) : undefined
      input.onChange({ attempt, wait })
      if (wait === undefined) return
      pending = timer.set(() => {
        pending = undefined
        attempt += 1
        input.onChange({ attempt, wait: undefined })
        input.run()
      }, wait)
    },
    now() {
      cancel()
      if (disposed) return
      attempt = 0
      input.onChange({ attempt, wait: undefined })
      input.run()
    },
    /** Cancels the try that is waiting, as when a read starts some other way. */
    stop: cancel,
    /** Cancels the waiting try for good, as when the page closes: nothing after it reads again. */
    dispose() {
      disposed = true
      cancel()
    },
  }
}

function noAnswer(error: unknown): ReadFailure["reason"] {
  const name = (error as { name?: unknown } | undefined)?.name
  if (name === "TimeoutError") return "slow"
  // The engine answered with a body that is not JSON.
  if (error instanceof SyntaxError) return "unreadable"
  return "unreachable"
}

function engineMessage(error: unknown) {
  const value = error as { data?: { message?: unknown }; message?: unknown } | undefined
  return [value?.data?.message, value?.message].find(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  )
}

function code(failure: ReadFailure) {
  return failure.code ? ` (error ${failure.code})` : ""
}

function sentence(text: string) {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}
