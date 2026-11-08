import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { validCliTokenID, verifyCliTokenClaims } from "./cli-token.js"

/**
 * CLI tokens are stateless HMAC grants with a ninety-day life (see cli-token.ts),
 * so deleting an account does not, by itself, stop a terminal that already holds
 * one. This is the small revocation list that closes that window: the account id
 * is written to the same Redis the rate limiter uses, and CLI verification
 * refuses any token whose subject appears there.
 *
 * The entry outlives the longest token it could invalidate, then expires on its
 * own, so the list never grows without bound.
 */

const REVOCATION_TTL_SECONDS = 100 * 24 * 60 * 60

function store() {
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  return url && token ? { url: url.replace(/\/+$/, ""), token } : undefined
}

export function revocationConfigured() {
  return Boolean(store())
}

const key = (accountID: string) => `vector:cli-revoked:${accountID}`
const tokenKey = (accountID: string, jti: string) => `${key(accountID)}:token:${jti}`
const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** Grants and shared inference require an authoritative revocation check. */
export async function requireUnrevokedAccount(accountID: string, fetcher: typeof fetch = fetch) {
  if (await persistentStore(["GET", key(accountID)], fetcher))
    throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
}

/** Marked CLI credentials can be revoked singly; account deletion still overrides every credential. */
export async function requireUnrevokedCliToken(token: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const claims = verifyCliTokenClaims(token, now)
  await requireUnrevokedAccount(claims.id, fetcher)
  if (claims.jti && (await persistentStore(["GET", tokenKey(claims.id, claims.jti)], fetcher)))
    throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  return claims
}

/** Internal only: all arguments come from authenticated verified token claims, never untrusted request fields. */
export async function revokeCliToken(
  accountID: string,
  jti: string,
  expiresAt: number,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!ACCOUNT_ID.test(accountID) || !validCliTokenID(jti) || !Number.isSafeInteger(expiresAt) || expiresAt < 0)
    throw new ApiError(400, "CLI_TOKEN_REVOCATION_INVALID", "Choose a valid account token to revoke.")
  if (expiresAt <= now) return
  const result = await persistentStore(
    ["SET", tokenKey(accountID, jti), "1", "EX", Math.ceil((expiresAt - now) / 1000)],
    fetcher,
  )
  if (result !== "OK")
    throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
}

/**
 * Returns false when no store is configured: the caller reports that tokens stay
 * valid until they expire rather than pretending the account was fully closed.
 */
export async function revokeAccountTokens(accountID: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const kv = store()
  if (!kv) return false
  const response = await fetcher(`${kv.url}/set/${encodeURIComponent(key(accountID))}/1?ex=${REVOCATION_TTL_SECONDS}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
  }).catch(() => undefined)
  if (!response?.ok) return false
  const body: unknown = await response.json().catch(() => undefined)
  return Boolean(body && typeof body === "object" && "result" in body && body.result === "OK" && !("error" in body))
}

/**
 * Fails open. A Redis outage must not lock every signed-in terminal out of a
 * free CLI; the account itself is already gone from Supabase, which is what
 * stops new tokens being minted.
 */
export async function accountTokensRevoked(accountID: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const kv = store()
  if (!kv) return false
  const response = await fetcher(`${kv.url}/get/${encodeURIComponent(key(accountID))}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  }).catch(() => undefined)
  if (!response?.ok) return false
  const body: unknown = await response.json().catch(() => undefined)
  return Boolean(body && typeof body === "object" && "result" in body && body.result)
}
