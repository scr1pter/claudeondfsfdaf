import type { NamedError } from "@vectordevai/core/util/error"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export type Retryable = {
  message: string
  action?: {
    reason: string
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_ATTEMPTS = 10
export const RETRY_MAX_MS = 15 * 60_000

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, _provider: string): Retryable | undefined {
  if (SessionV1.FreeModelsLimitError.isInstance(error)) return undefined
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    // Vector Codium billing and availability answers do not change on retry.
    if (error.data.metadata?.codium) return undefined
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

/**
 * A rule for the Codium gateway's answers that one caller pins for every model request of this process: today only a
 * Codium GitHub agent phase (V18c), which follows its run's stop-code table (contract 2.9.2). `classify` answers "stop"
 * (end the step with this error, no retry), "wait" (retry while `remaining()` is above zero, spaced by the usual delay
 * but never less than `minDelayMs` and never more than RETRY_MAX_DELAY_NO_HEADERS, so a longer retry-after is
 * shortened; the attempt and elapsed-time caps do not apply, the rule's window does), or undefined (the usual
 * retries). Nothing is pinned anywhere else, so the desktop, `vector run` and own-key runs retry as before.
 */
export type GatewayRule = {
  readonly classify: (error: Err, provider: string) => "stop" | "wait" | undefined
  /** How much longer a "wait" answer may be retried, in milliseconds; the rule keeps its own window. */
  readonly remaining: () => number
  /**
   * The shortest wait between "wait" retries, RETRY_INITIAL_DELAY by default: a zero or tiny retry-after must not
   * turn the window into a tight loop of requests.
   */
  readonly minDelayMs?: number
}

const pinned: { gateway?: GatewayRule } = {}

/** Pins `rule` for every later retry decision of this process, or removes it with undefined. */
export function pinGateway(rule: GatewayRule | undefined) {
  pinned.gateway = rule
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const api = SessionV1.APIError.isInstance(error) ? error : undefined
      const retryIn = (wait: number, retry: Retryable) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* opts.set({
            attempt: meta.attempt,
            message: retry.message,
            action: retry.action,
            next: now + wait,
          })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
      const gateway = pinned.gateway
      const kind = gateway?.classify(error, opts.provider)
      if (kind === "stop") return Cause.done(meta.attempt)
      if (gateway && kind === "wait") {
        const left = gateway.remaining()
        if (left <= 0) return Cause.done(meta.attempt)
        const wait = Math.max(delay(meta.attempt, api), gateway.minDelayMs ?? RETRY_INITIAL_DELAY)
        return retryIn(Math.min(wait, RETRY_MAX_DELAY_NO_HEADERS, left), {
          message: retryable(error, opts.provider)?.message ?? "Provider is busy",
        })
      }
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      const wait = delay(meta.attempt, api)
      // A provider that keeps failing must end the run with its last error instead of retrying unattended forever.
      if (meta.attempt > RETRY_MAX_ATTEMPTS || meta.elapsed + wait > RETRY_MAX_MS) return Cause.done(meta.attempt)
      return retryIn(wait, retry)
    }),
  )
}

export * as SessionRetry from "./retry"
