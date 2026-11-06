import { describe, expect, test } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { NamedError } from "@vectordevai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Duration, Effect, Exit, Fiber, Pull, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@vectordevai/core/provider"

const providerID = ProviderV2.ID.make("lmstudio")
const retryProvider = "test"
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  it.effect("policy stops retrying a 5xx error at attempt 11", () =>
    Effect.gen(function* () {
      const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
        new SessionV1.APIError({
          message: "Service Unavailable",
          statusCode: 503,
          isRetryable: false,
          responseHeaders: { "retry-after-ms": "0" },
        }).toObject(),
      )
      const attempts: number[] = []
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: retryProvider,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) => Effect.sync(() => attempts.push(info.attempt)),
        }),
      )
      const exits = yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS + 1 }), () =>
        Effect.exit(step(error)),
      )

      expect(attempts).toStrictEqual(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS }, (_, index) => index + 1))
      expect(exits.slice(0, SessionRetry.RETRY_MAX_ATTEMPTS).every(Exit.isSuccess)).toBe(true)
      const last = exits[SessionRetry.RETRY_MAX_ATTEMPTS]
      expect(Exit.isFailure(last) && Pull.isDoneCause(last.cause)).toBe(true)
    }),
  )

  it.effect("policy stops when the next wait would pass 15 minutes", () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: retryProvider,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: () => Effect.void,
        }),
      )
      const first = yield* Effect.exit(step(apiError({ "retry-after-ms": "0" })))
      yield* TestClock.adjust(Duration.minutes(14))
      const late = yield* Effect.exit(step(apiError({ "retry-after-ms": String(2 * 60_000) })))

      expect(Exit.isSuccess(first)).toBe(true)
      expect(Exit.isFailure(late) && Pull.isDoneCause(late.cause)).toBe(true)
    }),
  )

  it.effect("policy stops when a single retry-after hint passes 15 minutes", () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: retryProvider,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: () => Effect.void,
        }),
      )
      const exit = yield* Effect.exit(step(apiError({ "retry-after-ms": String(SessionRetry.RETRY_MAX_MS + 1) })))

      expect(Exit.isFailure(exit) && Pull.isDoneCause(exit.cause)).toBe(true)
    }),
  )
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })

  test("preserves provider quota messages without adding subscription actions", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Provider quota exceeded",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "retry-after": "900" },
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "ProviderQuotaExceededError", message: "Provider quota exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "openai")).toEqual({ message: "Provider quota exceeded" })
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})

describe("session.retry Codium answers", () => {
  const codium = ProviderV2.ID.make("vector-plan")
  // A Codium gateway answer as the engine records it: through the AI SDK's APICallError and the provider parser.
  const answer = (statusCode: number, code: string, headers: Record<string, string> = {}, dispatched = false) => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "Gateway answer",
        url: "https://vectordev.ai/api/model-plans/chat",
        requestBodyValues: {},
        statusCode,
        responseHeaders: headers,
        responseBody: JSON.stringify({
          error: { code, message: "Gateway answer.", ...(dispatched ? { dispatched: true } : {}) },
        }),
        isRetryable: statusCode === 429 || statusCode >= 500,
      }),
      { providerID: codium },
    )
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    return result
  }
  const policy = () =>
    Schedule.toStepWithMetadata(
      SessionRetry.policy({
        provider: retryProvider,
        parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
        set: () => Effect.void,
      }),
    )

  test("final answers are never retried, whatever their status", () => {
    for (const [status, code] of [
      [429, "MODEL_PLAN_DAILY_LIMIT"],
      [429, "MODEL_PLAN_RUN_LIMIT"],
      [429, "MODEL_PLAN_BRAIN_SHARE"],
      [503, "MODEL_PLAN_POOL_UNAVAILABLE"],
      [503, "MODEL_PLANS_CONFIGURATION"],
      [503, "MODEL_PLAN_MODEL_UNAVAILABLE"],
      [401, "MODEL_PLAN_RUN_EXPIRED"],
      [426, "CODIUM_UPDATE_REQUIRED"],
      [400, "MODEL_PLAN_ADDONS"],
    ] as const) {
      const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(answer(status, code))
      expect({ code, retry: SessionRetry.retryable(error, retryProvider) }).toEqual({ code, retry: undefined })
      expect(error.data.metadata).toMatchObject({ code })
      // None of these is a credit answer, so nothing offers a purchase for a daily, run or Brain limit.
      expect(error.data.metadata?.codium).toBe("unavailable")
    }
  })

  test("temporary answers are retried after their retry-after, and a transient gateway failure as any 5xx", () => {
    for (const [status, code] of [
      [503, "MODEL_PLAN_RENEWING"],
      [429, "MODEL_PLAN_BUSY"],
      [429, "MODEL_PLAN_CONCURRENCY"],
      [402, "MODEL_PLAN_CAPACITY"],
      [503, "MODEL_PLAN_UPSTREAM"],
    ] as const) {
      const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(answer(status, code, { "retry-after": "30" }))
      expect({ code, retry: SessionRetry.retryable(error, retryProvider) !== undefined }).toEqual({ code, retry: true })
      expect(error.data.metadata?.codium).toBeUndefined()
      expect(SessionRetry.delay(1, error)).toBe(30_000)
    }
  })

  test("an answer given after the gateway dispatched the request is final, since each resend is committed again", () => {
    for (const [status, code] of [
      [429, "MODEL_PLAN_BUSY"],
      [402, "MODEL_PLAN_CAPACITY"],
      [503, "MODEL_PLAN_UPSTREAM"],
      [503, "MODEL_PLAN_UNAVAILABLE"],
    ] as const) {
      const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
        answer(status, code, { "retry-after": "30" }, true),
      )
      expect({ code, retry: SessionRetry.retryable(error, retryProvider) }).toEqual({ code, retry: undefined })
      expect(error.data.metadata).toMatchObject({ codium: "unavailable", kind: "unavailable", code })
      expect(error.data.message).not.toContain("See plans")
    }
  })

  it.effect("waiting for the account's other requests is bounded by 15 minutes, not by the attempt count", () =>
    Effect.gen(function* () {
      const step = yield* policy()
      // A zero wait keeps the test clock still; the bound under test is the count.
      const waiting = answer(429, "MODEL_PLAN_CONCURRENCY", { "retry-after-ms": "0" })
      const exits = yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS * 3 }), () =>
        Effect.exit(step(waiting)),
      )
      expect(exits.every(Exit.isSuccess)).toBe(true)
      // Counted failures still end the run after their own bound.
      const renewing = answer(503, "MODEL_PLAN_RENEWING", { "retry-after-ms": "0" })
      const counted = yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS + 1 }), () =>
        Effect.exit(step(renewing)),
      )
      expect(counted.slice(0, SessionRetry.RETRY_MAX_ATTEMPTS).every(Exit.isSuccess)).toBe(true)
      const last = counted[SessionRetry.RETRY_MAX_ATTEMPTS]
      expect(Exit.isFailure(last) && Pull.isDoneCause(last.cause)).toBe(true)
      // The time bound still holds for the waits.
      const fresh = yield* policy()
      yield* Effect.exit(fresh(waiting))
      yield* TestClock.adjust(Duration.minutes(14))
      const late = yield* Effect.exit(
        fresh(answer(429, "MODEL_PLAN_CONCURRENCY", { "retry-after-ms": String(2 * 60_000) })),
      )
      expect(Exit.isFailure(late) && Pull.isDoneCause(late.cause)).toBe(true)
    }),
  )

  it.effect("waiting for the account's other requests does not lengthen a later failure's backoff", () =>
    Effect.gen(function* () {
      const step = yield* policy()
      const waiting = answer(429, "MODEL_PLAN_CONCURRENCY", { "retry-after-ms": "0" })
      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS }), () => step(waiting))
      // The gateway's transient failures come from an HTTP answer without a retry-after: the first counted failure
      // waits the first backoff step, as it would without the waits before it.
      const upstream = yield* step(answer(503, "MODEL_PLAN_UPSTREAM")).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(Duration.millis(SessionRetry.RETRY_INITIAL_DELAY))
      const first = yield* Fiber.join(upstream)
      expect(Duration.toMillis(first.duration)).toBe(SessionRetry.RETRY_INITIAL_DELAY)
      // A later wait still takes the gateway's retry-after, whatever the counted failures before it.
      const again = yield* step(answer(429, "MODEL_PLAN_CONCURRENCY", { "retry-after-ms": "500" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(Duration.millis(500))
      expect(Duration.toMillis((yield* Fiber.join(again)).duration)).toBe(500)
      // The next counted failure takes the second step.
      const second = yield* step(answer(503, "MODEL_PLAN_UPSTREAM")).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(Duration.millis(SessionRetry.RETRY_INITIAL_DELAY * SessionRetry.RETRY_BACKOFF_FACTOR))
      expect(Duration.toMillis((yield* Fiber.join(second)).duration)).toBe(
        SessionRetry.RETRY_INITIAL_DELAY * SessionRetry.RETRY_BACKOFF_FACTOR,
      )
    }),
  )

  it.effect("a renewing plan keeps the normal attempt bound", () =>
    Effect.gen(function* () {
      const step = yield* policy()
      const renewing = answer(503, "MODEL_PLAN_RENEWING", { "retry-after-ms": "0" })
      const exits = yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_ATTEMPTS + 1 }), () =>
        Effect.exit(step(renewing)),
      )
      expect(exits.slice(0, SessionRetry.RETRY_MAX_ATTEMPTS).every(Exit.isSuccess)).toBe(true)
      const last = exits[SessionRetry.RETRY_MAX_ATTEMPTS]
      expect(Exit.isFailure(last) && Pull.isDoneCause(last.cause)).toBe(true)
    }),
  )
})
