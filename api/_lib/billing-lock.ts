import { createHash, randomUUID } from "node:crypto"
import { ApiError } from "./http.js"

export const BILLING_MUTATION_TIMEOUT_MS = 10_000
const LEASE_MS = 60_000
const MINIMUM_REMAINING_MS = BILLING_MUTATION_TIMEOUT_MS + 5_000
const developmentLocks = new Set<string>()

/**
 * Serialize fresh device reads and writes across serverless instances. `options.key` names the lease's store key
 * outright, for callers that keep their keys in a namespace of their own (Codium's `codiumKey("lease", id)`).
 */
export async function withBillingMutation<T>(
  customer: string,
  work: (verify: () => Promise<void>) => Promise<T>,
  fetcher: typeof fetch = fetch,
  options: { key?: string } = {},
) {
  const kv = { url: process.env.KV_REST_API_URL?.trim(), token: process.env.KV_REST_API_TOKEN?.trim() }
  const upstash = {
    url: process.env.UPSTASH_REDIS_REST_URL?.trim(),
    token: process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  }
  const store = kv.url && kv.token ? kv : upstash.url && upstash.token ? upstash : undefined
  if (!store) {
    if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
      throw new ApiError(503, "BILLING_LOCK_UNAVAILABLE", "License changes are temporarily unavailable.")
    }
    const lock = options.key ?? customer
    if (developmentLocks.has(lock)) throw busy()
    developmentLocks.add(lock)
    try {
      return await work(async () => {})
    } finally {
      developmentLocks.delete(lock)
    }
  }

  const command = async (input: string[]) => {
    const response = await fetcher(store.url!, {
      method: "POST",
      headers: { authorization: `Bearer ${store.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)
    const payload: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
    if (!payload || typeof payload !== "object" || !("result" in payload) || "error" in payload) {
      throw new ApiError(503, "BILLING_LOCK_UNAVAILABLE", "License changes are temporarily unavailable.")
    }
    return payload.result
  }
  const key = options.key ?? `vector:billing-mutation:${createHash("sha256").update(customer).digest("hex")}`
  const token = randomUUID()
  const acquiredAt = Date.now()
  const acquired = await command(["SET", key, token, "NX", "PX", String(LEASE_MS)])
  if (acquired === null) throw busy()
  if (acquired !== "OK")
    throw new ApiError(503, "BILLING_LOCK_UNAVAILABLE", "License changes are temporarily unavailable.")
  let release = false
  try {
    const result = await work(async () => {
      const remaining = await command([
        "EVAL",
        "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('PTTL', KEYS[1])",
        "1",
        key,
        token,
      ])
      // Leave enough time for the one bounded Stripe write after this check.
      if (
        typeof remaining !== "number" ||
        remaining <= MINIMUM_REMAINING_MS ||
        Date.now() - acquiredAt >= LEASE_MS - MINIMUM_REMAINING_MS
      ) {
        throw new ApiError(503, "BILLING_LOCK_EXPIRED", "This license change timed out. Please retry.")
      }
    })
    release = true
    return result
  } catch (error) {
    // Domain validation failures occur before a write. An ambiguous Stripe
    // timeout keeps the lease until expiry instead of allowing an immediate
    // overlapping retry while Stripe might still be completing the request.
    release = error instanceof ApiError
    throw error
  } finally {
    // A delayed completion must never release a replacement owner's lease.
    if (release)
      await command([
        "EVAL",
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0",
        "1",
        key,
        token,
      ]).catch(() => undefined)
  }
}

function busy() {
  return new ApiError(409, "BILLING_MUTATION_BUSY", "Another license change is in progress. Please retry.")
}
