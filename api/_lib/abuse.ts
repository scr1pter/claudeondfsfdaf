import { createHash, createHmac } from "node:crypto"
import { ApiError, type ApiRequest, type ApiResponse } from "./http.js"

type Counter = { count: number; resetAt: number }
type RateLimit = {
  scope: string
  limit: number
  windowSeconds: number
  identifier?: string
  requirePersistent?: boolean
}

const developmentCounters = new Map<string, Counter>()
const REDIS_TIMEOUT_MS = 2_000
export const ABUSE_RATE_LIMIT_SCRIPT =
  "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return { count, redis.call('TTL', KEYS[1]) }"

const production = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production"
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function header(request: ApiRequest, name: string) {
  const value = request.headers?.[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function allowedOrigins() {
  const configured = (process.env.VECTOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  const publicURL = process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai"
  const defaults = [publicURL, "https://vectordev.ai", "https://www.vectordev.ai"]
  return new Set(
    [...configured, ...defaults].flatMap((value) => {
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    }),
  )
}

function isDevelopmentOrigin(origin: string) {
  if (production()) return false
  try {
    const url = new URL(origin)
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Reject browser cross-origin use and make Vercel's pre-parsed request body
 * obey the same byte ceiling as a streamed body. Originless requests are kept
 * for the signed desktop app's main-process fetch; they are still IP limited.
 */
export function requireTrustedJsonRequest(request: ApiRequest, maximumBytes: number) {
  const origin = header(request, "origin")
  if (origin) {
    const normalized = (() => {
      try {
        return new URL(origin).origin
      } catch {
        return ""
      }
    })()
    if (!normalized || (!allowedOrigins().has(normalized) && !isDevelopmentOrigin(normalized))) {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.")
    }
  }

  const contentType = header(request, "content-type")
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "CONTENT_TYPE_INVALID", "Send this request as JSON.")
  }
  if (!contentType && production()) {
    throw new ApiError(415, "CONTENT_TYPE_REQUIRED", "Send this request as JSON.")
  }

  const declared = Number(header(request, "content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.")
  }
  if (request.body === undefined) return

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(request.body)
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
  }
  if (typeof serialized !== "string") {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.")
  }
}

function clientIP(request: ApiRequest) {
  const forwarded = header(request, "x-vercel-forwarded-for") ?? header(request, "x-forwarded-for")
  const value =
    forwarded?.split(",")[0]?.trim() || header(request, "x-real-ip")?.trim() || request.socket?.remoteAddress
  if (value && value.length <= 128) return value
  if (!production()) return "development"
  throw new ApiError(503, "ABUSE_PROTECTION_UNAVAILABLE", "Request protection is temporarily unavailable.")
}

function abuseSecret() {
  const value =
    process.env.VECTOR_ABUSE_SECRET?.trim() ||
    process.env.VECTOR_LICENSE_SECRET?.trim() ||
    process.env.KV_REST_API_TOKEN?.trim() ||
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (value && value.length >= 32) return value
  if (!production()) return "vector-development-rate-limit-secret"
  throw new ApiError(503, "ABUSE_PROTECTION_UNAVAILABLE", "Request protection is temporarily unavailable.")
}

function counterKey(request: ApiRequest, input: RateLimit) {
  const identity = input.identifier?.trim() || clientIP(request)
  const hash = createHmac("sha256", abuseSecret()).update(identity).digest("hex")
  return `vector:abuse:${input.scope}:${hash}`
}

function redisConfiguration() {
  const kv = { url: process.env.KV_REST_API_URL?.trim(), token: process.env.KV_REST_API_TOKEN?.trim() }
  if (kv.url && kv.token) return { url: kv.url.replace(/\/$/, ""), token: kv.token }
  const upstash = {
    url: process.env.UPSTASH_REDIS_REST_URL?.trim(),
    token: process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  }
  if (upstash.url && upstash.token) return { url: upstash.url.replace(/\/$/, ""), token: upstash.token }
  return undefined
}

async function incrementRemote(key: string, windowSeconds: number, fetcher: typeof fetch) {
  const config = redisConfiguration()
  if (!config) return undefined
  const response = await fetcher(config.url, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(["EVAL", ABUSE_RATE_LIMIT_SCRIPT, "1", key, String(windowSeconds)]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const payload: unknown = await response.json().catch(() => undefined)
  if (!isRecord(payload) || !Array.isArray(payload.result)) return undefined
  const count = Number(payload.result[0])
  const ttl = Number(payload.result[1])
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) return undefined
  return { count, resetAt: Date.now() + Math.max(1, ttl) * 1_000 }
}

function incrementDevelopment(key: string, windowSeconds: number) {
  const now = Date.now()
  const current = developmentCounters.get(key)
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowSeconds * 1_000 }
    developmentCounters.set(key, next)
    return next
  }
  const next = { ...current, count: current.count + 1 }
  developmentCounters.set(key, next)
  return next
}

/**
 * Production uses one atomic Redis EVAL counter shared by every Vercel
 * instance. The in-memory fallback is deliberately development-only.
 */
export async function enforceRateLimit(
  request: ApiRequest,
  response: ApiResponse,
  input: RateLimit,
  fetcher: typeof fetch = fetch,
) {
  const key = counterKey(request, input)
  const remote = await incrementRemote(key, input.windowSeconds, fetcher)
  if (!remote && (production() || input.requirePersistent)) {
    throw new ApiError(503, "ABUSE_PROTECTION_UNAVAILABLE", "Request protection is temporarily unavailable.")
  }
  const result = remote ?? incrementDevelopment(key, input.windowSeconds)
  const remaining = Math.max(0, input.limit - result.count)
  const reset = Math.ceil(result.resetAt / 1_000)
  response.setHeader("x-ratelimit-limit", String(input.limit))
  response.setHeader("x-ratelimit-remaining", String(remaining))
  response.setHeader("x-ratelimit-reset", String(reset))
  if (result.count <= input.limit) return
  response.setHeader("retry-after", String(Math.max(1, reset - Math.floor(Date.now() / 1_000))))
  throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.")
}

export function stableAbuseIdentifier(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex")
}
