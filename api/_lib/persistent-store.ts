import { ApiError } from "./http.js"

/** Replace one string only if it still equals the expected value, with the new expiry in milliseconds. */
export const COMPARE_AND_SET_WITH_EXPIRY = `local current = redis.call('GET', KEYS[1]) if not current then current = '' end if current ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1`

/** Protected account operations never fall back to process-local state, including in development. */
export async function persistentStore(
  command: readonly (string | number)[],
  request: typeof fetch = fetch,
): Promise<unknown> {
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!url || !token) throw unavailable()
  const response = await request(url.replace(/\/+$/, ""), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  }).catch(() => undefined)
  if (!response?.ok) throw unavailable()
  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object" || !("result" in body) || "error" in body) throw unavailable()
  return body.result
}

function unavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
}
