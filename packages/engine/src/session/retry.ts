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
const CODIUM_CONCURRENCY = "MODEL_PLAN_CONCURRENCY"

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

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.sync(() => {
      // Waits for the account's other Codium requests to finish, counted for this retry loop only.
      let waits = 0
      return (meta: Schedule.InputMetadata<unknown>) => {
        const error = opts.parse(meta.input)
        const retry = retryable(error, opts.provider)
        if (!retry) return Cause.done(meta.attempt)
        const api = SessionV1.APIError.isInstance(error) ? error : undefined
        // Codium asks a request to wait while the account's other requests run (§4.10): that wait is bounded by time
        // alone. It neither counts toward the attempt bound nor lengthens the backoff of a failure after it, which
        // backs off from the failures counted so far.
        const waiting = api?.data.metadata?.code === CODIUM_CONCURRENCY
        if (waiting) waits++
        const counted = meta.attempt - waits
        const wait = delay(waiting ? waits : counted, api)
        // A provider that keeps failing must end the run with its last error instead of retrying unattended forever.
        if (counted > RETRY_MAX_ATTEMPTS || meta.elapsed + wait > RETRY_MAX_MS) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* opts.set({
            attempt: meta.attempt,
            message: retry.message,
            action: retry.action,
            next: now + wait,
          })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
      }
    }),
  )
}

export * as SessionRetry from "./retry"
