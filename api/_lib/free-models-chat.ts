import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { Option, Schema } from "effect"
import {
  FREE_MODELS_CONSENT_ACCEPTED,
  FREE_MODELS_CONSENT_HEADER,
  FREE_MODELS_DISCLOSURE,
  FREE_MODELS_DISCLOSURE_HEADER,
  FreeModelLimit,
  type FreeModelLimitReason,
} from "../../packages/schema/src/free-model.js"
import { freeModelDataPolicy } from "../../packages/core/src/free-model-catalog.js"
import {
  FREE_MODEL_TRAINING_CONSENT_REQUIRED,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_TITLE,
  FREE_MODELS_UNAVAILABLE,
  freeModelsLimitTitle,
  freeModelsTokensRanOut,
} from "../../packages/core/src/free-model-choice.js"
import { freeModelRequest } from "../../packages/core/src/free-model-request.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import type { CliTokenUser } from "./cli-token.js"
import { requireUnrevokedCliToken } from "./revocation.js"
import { currentFreeModelCatalog, freeModelsEnabled, openRouterHeaders } from "./free-models-catalog.js"
import { persistentStore } from "./persistent-store.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

const MAX_BYTES = 4_500_000
const ROOT = "https://openrouter.ai/api/v1"
const KeyLimits = Schema.Struct({
  data: Schema.Struct({
    free_model_daily_requests: Schema.Struct({ used: Schema.Number, limit: Schema.Number, remaining: Schema.Number }),
  }),
})
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const nextDay = (now: number) => (Math.floor(now / 86400000) + 1) * 86400000
const RESET = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" })

class Limit extends Error {
  constructor(readonly detail: FreeModelLimit) {
    super(detail.message)
  }
}

export function freeModelLimit(reason: FreeModelLimitReason, resetAt: number): FreeModelLimit {
  return {
    type: "free_models_limit",
    code: "VECTOR_FREE_MODELS_LIMIT",
    reason,
    resetAt,
    // Clients from 1.99.109 write their own notice from reason and resetAt; this is for any other reader.
    message: `${freeModelsLimitTitle({ reason, resetAt })}. ${freeModelsTokensRanOut({ reason }) ? "More free tokens are available at" : "Try again at"} ${RESET.format(resetAt)}. Until then, use a model from a provider you've connected with your own key.`,
  }
}

function setting(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new ApiError(503, "FREE_MODELS_CONFIGURATION", `${FREE_MODELS_TITLE} are temporarily unavailable.`)
  return value
}

/**
 * Operator accounts listed in FREE_MODELS_UNMETERED_ACCOUNTS, which is set only in the server environment, skip the
 * per-account minute and daily caps. Everything shared still applies to them and counts their requests: the shared
 * per-minute cap, the upstream daily quota and the pending-pool reservation. Entries are account ids or email
 * addresses separated by commas or whitespace, matched only against the verified token's account.
 */
function unmeteredAccount(account: CliTokenUser) {
  const listed = (process.env.FREE_MODELS_UNMETERED_ACCOUNTS ?? "").split(/[\s,]+/).filter(Boolean)
  const email = account.email.trim().toLowerCase()
  return listed.includes(account.id) || listed.some((entry) => entry.toLowerCase() === email)
}

function upstreamLimit(response: Response, status: number, now: number) {
  const raw = Number(response.headers.get("x-ratelimit-reset"))
  const retry = Number(response.headers.get("retry-after"))
  const date = Date.parse(response.headers.get("retry-after") ?? "")
  const reset =
    Number.isFinite(raw) && raw > 0
      ? raw > 1e12
        ? raw
        : raw * 1000
      : Number.isFinite(retry) && retry > 0
        ? now + retry * 1000
        : Number.isFinite(date)
          ? date
          : now + 60000
  return freeModelLimit(status === 402 ? "balance" : "upstream", Math.min(nextDay(now), Math.max(now + 1000, reset)))
}

export async function streamFreeModelResponse(upstream: Response, response: ApiResponse, now = Date.now()) {
  if (upstream.status === 402 || upstream.status === 429) throw new Limit(upstreamLimit(upstream, upstream.status, now))
  if (!upstream.ok || !upstream.body)
    throw new ApiError(
      503,
      "FREE_MODELS_UPSTREAM_UNAVAILABLE",
      "This free model is temporarily unavailable. Try another free model.",
    )
  if (!upstream.headers.get("content-type")?.includes("text/event-stream"))
    throw new ApiError(503, "FREE_MODELS_UPSTREAM_INVALID", "The free model did not return a response stream.")
  response.statusCode = 200
  response.setHeader("content-type", "text/event-stream; charset=utf-8")
  response.setHeader("cache-control", "no-store, no-transform")
  response.setHeader("x-accel-buffering", "no")
  response.flushHeaders()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const controller = new AbortController()
  let buffered = ""
  const cancel = () => {
    controller.abort()
    void reader.cancel().catch(() => undefined)
  }
  response.once("close", cancel)
  try {
    while (!response.destroyed) {
      const part = await reader.read()
      buffered = (buffered + decoder.decode(part.value, { stream: !part.done })).replace(/\r\n/g, "\n")
      if (buffered.length > 1_000_000)
        throw new ApiError(503, "FREE_MODELS_STREAM_INVALID", "The free model returned an invalid response stream.")
      let end = buffered.indexOf("\n\n")
      while (end !== -1) {
        const frame = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data === "[DONE]") {
          response.end("data: [DONE]\n\n")
          return
        }
        if (data) {
          const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(data)
          if (Option.isNone(decoded) || !isRecord(decoded.value))
            throw new ApiError(503, "FREE_MODELS_STREAM_INVALID", "The free model returned an invalid response stream.")
          const value = decoded.value
          if (isRecord(value.error)) {
            const status = Number(value.error.code ?? value.error.status)
            if (status === 429 || status === 402) throw new Limit(upstreamLimit(upstream, status, now))
            // A provider refusal can arrive as a stream error; it is never retried on another endpoint.
            throw new ApiError(
              503,
              "FREE_MODELS_UPSTREAM_UNAVAILABLE",
              "This free model is temporarily unavailable. Try another free model.",
            )
          }
          if (!response.write(`data: ${JSON.stringify(value)}\n\n`))
            await once(response, "drain", { signal: controller.signal })
        }
        end = buffered.indexOf("\n\n")
      }
      if (part.done)
        throw new ApiError(503, "FREE_MODELS_STREAM_INVALID", "The free model returned an incomplete response stream.")
    }
  } finally {
    response.off("close", cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function enforceFreeLimit(
  request: ApiRequest,
  response: ApiResponse,
  cap: { scope: string; limit: number; windowSeconds: number; identifier: string; reason: FreeModelLimitReason },
) {
  await enforceRateLimit(request, response, { ...cap, requirePersistent: true }).catch((error: unknown) => {
    if (error instanceof ApiError && error.statusCode === 429)
      throw new Limit(freeModelLimit(cap.reason, Number(response.getHeader("x-ratelimit-reset")) * 1000))
    throw error
  })
}

export async function handleFreeModelsChat(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const ticket = randomUUID()
  const pool = `vector:free-models:pending:${Math.floor(now / 86400000)}`
  let reserved = false
  const controller = new AbortController()
  const close = () => controller.abort()
  response.once("close", close)
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, MAX_BYTES)
    if (!freeModelsEnabled()) throw new ApiError(503, "FREE_MODELS_DISABLED", FREE_MODELS_UNAVAILABLE)
    const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
    const account = await requireUnrevokedCliToken(token ?? "", fetcher, now)
    const unmetered = unmeteredAccount(account)
    const disclosure = request.headers[FREE_MODELS_DISCLOSURE_HEADER] === FREE_MODELS_DISCLOSURE
    const consent = disclosure && request.headers[FREE_MODELS_CONSENT_HEADER] === FREE_MODELS_CONSENT_ACCEPTED
    const all = await currentFreeModelCatalog(fetcher, now, { disclosure: true })
    // A client that does not disclose may-train models, such as 1.99.108, routes among no-training models only.
    const noTraining = all.models.filter((model) => freeModelDataPolicy(model) === "no-training")
    const catalog = disclosure ? all : { ...all, enabled: all.enabled && noTraining.length > 0, models: noTraining }
    if (!catalog.enabled) throw new ApiError(503, "FREE_MODELS_UNAVAILABLE", FREE_MODELS_UNAVAILABLE)
    const body = await readJson(request, MAX_BYTES)
    // Refuse a may-train model before any allowance is spent: an older client never showed its label, and a newer
    // one must carry the user's acceptance.
    const listed = isRecord(body) ? all.models.find((model) => model.id === body.model) : undefined
    if (listed && freeModelDataPolicy(listed) !== "no-training" && !disclosure)
      throw new ApiError(
        403,
        "FREE_MODELS_DISCLOSURE_REQUIRED",
        `This free model is labelled "${FREE_MODEL_TRAINING_LABEL}". Update Vector to see that notice and choose whether to use it.`,
      )
    if (listed && freeModelDataPolicy(listed) !== "no-training" && !consent)
      throw new ApiError(403, "FREE_MODELS_CONSENT_REQUIRED", FREE_MODEL_TRAINING_CONSENT_REQUIRED)
    const input = (() => {
      try {
        return {
          ...freeModelRequest(body, catalog.models, { trainingConsent: consent }),
          user: createHash("sha256").update(account.id).digest("hex"),
        }
      } catch (error) {
        throw new ApiError(
          400,
          "FREE_MODELS_REQUEST_INVALID",
          error instanceof Error ? error.message : "The free model request is invalid.",
        )
      }
    })()
    for (const cap of [
      {
        scope: "free-models-minute",
        // One agent prompt makes a request per tool step, so a lower default stops an agent mid-prompt.
        limit: setting("FREE_MODELS_MINUTE_PER_USER", 10, 20),
        windowSeconds: 60,
        identifier: account.id,
        reason: "user_minute" as const,
      },
      {
        scope: "free-models-shared-minute",
        limit: 20,
        windowSeconds: 60,
        identifier: "shared-openrouter-account",
        reason: "upstream" as const,
      },
    ]) {
      // An unmetered account skips only its own cap; the shared one still counts and stops its requests.
      if (unmetered && cap.identifier === account.id) continue
      await enforceFreeLimit(request, response, cap)
    }
    const keyResponse = await fetcher(`${ROOT}/key`, {
      headers: openRouterHeaders(),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    })
    if (keyResponse.status === 402 || keyResponse.status === 429)
      throw new Limit(upstreamLimit(keyResponse, keyResponse.status, now))
    const decoded = keyResponse.ok ? Schema.decodeUnknownOption(KeyLimits)(await keyResponse.json()) : Option.none()
    if (Option.isNone(decoded))
      throw new ApiError(
        503,
        "FREE_MODELS_LIMITS_UNAVAILABLE",
        "Limits for free models provided by Vector could not be checked. Try again later.",
      )
    const quota = decoded.value.data.free_model_daily_requests
    if (
      ![quota.remaining, quota.used, quota.limit].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      quota.remaining > quota.limit
    )
      throw new ApiError(
        503,
        "FREE_MODELS_LIMITS_UNAVAILABLE",
        "Limits for free models provided by Vector could not be checked. Try again later.",
      )
    if (!quota.remaining) throw new Limit(freeModelLimit("shared_daily", nextDay(now)))
    // Built for every account, so a bad setting fails the same way for an unmetered one.
    const daily = {
      scope: `free-models-daily:${Math.floor(now / 86400000)}`,
      limit: setting("FREE_MODELS_DAILY_PER_USER", Math.max(1, Math.min(20, Math.floor(quota.limit / 10))), 1000),
      windowSeconds: Math.ceil((nextDay(now) - now) / 1000),
      identifier: account.id,
      reason: "user_daily" as const,
    }
    if (!unmetered) await enforceFreeLimit(request, response, daily)
    const reserve =
      "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4]); redis.call('EXPIRE', KEYS[1], 86400); return 1"
    reserved =
      (await persistentStore(["EVAL", reserve, 1, pool, now, quota.remaining, now + 810000, ticket], fetcher)) === 1
    if (!reserved) throw new Limit(freeModelLimit("upstream", now + 60000))
    const upstream = await fetcher(`${ROOT}/chat/completions`, {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(790000)]),
    })
    await streamFreeModelResponse(upstream, response, now)
  } catch (error) {
    if (response.destroyed) return
    const detail =
      error instanceof Limit
        ? error.detail
        : {
            code: error instanceof ApiError ? error.code : "FREE_MODELS_UNAVAILABLE",
            message:
              error instanceof ApiError
                ? error.statusCode === 413
                  ? "This conversation is larger than the 4.5 MB limit for free models provided by Vector. Compact it, or use a model from a provider you've connected with your own key."
                  : error.message
                : FREE_MODELS_UNAVAILABLE,
          }
    if (response.headersSent) {
      response.end(`data: ${JSON.stringify({ error: detail })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (!request.readableEnded) response.setHeader("connection", "close")
    if (error instanceof Limit)
      response.setHeader("retry-after", String(Math.max(1, Math.ceil((error.detail.resetAt - now) / 1000))))
    json(response, error instanceof Limit ? 429 : error instanceof ApiError ? error.statusCode : 503, { error: detail })
  } finally {
    // Early validation can reject a body before readJson consumes it. Drain it
    // so a keep-alive connection cannot strand the next request behind it.
    request.resume()
    response.off("close", close)
    controller.abort()
    if (reserved) await persistentStore(["ZREM", pool, ticket], fetcher).catch(() => undefined)
  }
}
