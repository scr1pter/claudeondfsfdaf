import { createHmac, timingSafeEqual } from "node:crypto"
import { ApiError, type ApiRequest } from "./http.js"

// The Design Lab (design-lab/ in the repository) is private to the owner. A browser earns
// access once: it proves a Google sign-in to the owner's Vector account, and the API
// answers with a short-lived signed cookie scoped to /design-lab. Every file is then
// served by api/design-lab/serve.ts only while that cookie verifies.

const OWNER_EMAILS = ["krishnabharadwaj0521@gmail.com"]
export const DESIGN_LAB_COOKIE = "vector_design_lab"
const COOKIE_PATH = "/design-lab"
const TTL_SECONDS = 8 * 60 * 60

export function designLabOwners() {
  const configured = process.env.VECTOR_DESIGN_LAB_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  return configured?.length ? configured : OWNER_EMAILS
}

/**
 * Whether a signed-in account is on the Design Lab's allowlist, the one /design checks before it opens the lab. It
 * only tells the account page to show the Design tab, so the site's code never has to carry anyone's address;
 * api/design-lab still runs its full Google-only check.
 */
export function isDesignLabOwner(email: string) {
  return designLabOwners().includes(email.trim().toLowerCase())
}

/**
 * Accepts only a confirmed owner account whose current session came from Google.
 * Password and magic-link sessions to the same address are refused, so the lab
 * cannot be opened without the owner's Google account. Other owner-only pages
 * pass their own allowlist.
 */
export async function requireDesignLabOwner(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  owners = designLabOwners(),
) {
  const configuration = supabaseConfiguration()
  const token = bearerToken(request)
  if (!token) throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.")
  const response = await fetcher(`${configuration.url}/auth/v1/user`, {
    headers: { apikey: configuration.publishableKey, authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new ApiError(401, "SESSION_INVALID", "Your session expired. Sign in again.")
  const user: unknown = await response.json().catch(() => undefined)
  if (!isRecord(user) || typeof user.email !== "string") {
    throw new ApiError(401, "SESSION_INVALID", "Your session expired. Sign in again.")
  }
  const email = user.email.trim().toLowerCase()
  const confirmed = typeof user.email_confirmed_at === "string" && Number.isFinite(Date.parse(user.email_confirmed_at))
  if (!confirmed || !owners.includes(email)) {
    throw new ApiError(403, "DESIGN_LAB_FORBIDDEN", "This page isn't available for this account.")
  }
  if (!signedInWithGoogle(user, email, token)) {
    throw new ApiError(403, "GOOGLE_SIGN_IN_REQUIRED", "Sign in with Google to open this page.")
  }
  return { email }
}

// Supabase has already verified the token above, so its payload can be trusted here. A
// session's "amr" records how it was established; an "oauth" session on an account whose
// only OAuth identity is the owner's verified Google identity was a Google sign-in.
function signedInWithGoogle(user: Record<string, unknown>, email: string, token: string) {
  const identities = Array.isArray(user.identities) ? user.identities.filter(isRecord) : []
  const google = identities.some((identity) => {
    const data = isRecord(identity.identity_data) ? identity.identity_data : {}
    return (
      identity.provider === "google" &&
      typeof data.email === "string" &&
      data.email.trim().toLowerCase() === email &&
      data.email_verified !== false
    )
  })
  const otherOAuth = identities.some((identity) => identity.provider !== "google" && identity.provider !== "email")
  const methods = tokenAuthenticationMethods(token)
  return google && !otherOAuth && methods.includes("oauth")
}

function tokenAuthenticationMethods(token: string) {
  const payload = token.split(".")[1]
  if (!payload) return []
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!isRecord(claims) || !Array.isArray(claims.amr)) return []
    return claims.amr.flatMap((entry) => (isRecord(entry) && typeof entry.method === "string" ? [entry.method] : []))
  } catch {
    return []
  }
}

export function designLabCookie(email: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Math.floor(now / 1000) + TTL_SECONDS })).toString(
    "base64url",
  )
  const value = `v1.${payload}.${sign(`v1.${payload}`)}`
  return `${DESIGN_LAB_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export function clearedDesignLabCookie() {
  return `${DESIGN_LAB_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** The owner email a request's cookie was issued to, or undefined if it is missing, forged or expired. */
export function verifiedDesignLabCookie(request: Pick<ApiRequest, "headers">, now = Date.now()) {
  const value = readCookie(request, DESIGN_LAB_COOKIE)
  const [version, payload, signature] = value?.split(".") ?? []
  if (version !== "v1" || !payload || !signature) return undefined
  const expected = Buffer.from(sign(`v1.${payload}`))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!isRecord(claims) || typeof claims.e !== "string" || typeof claims.x !== "number") return undefined
    if (claims.x * 1000 <= now || !designLabOwners().includes(claims.e)) return undefined
    return claims.e
  } catch {
    return undefined
  }
}

// Prefer a dedicated secret; otherwise derive a purpose-bound key from the first server-only
// secret the deployment already has, so the lab works without extra setup and never shares
// raw key material with other signing uses.
function sign(value: string) {
  return createHmac("sha256", signingKey()).update(value).digest("base64url")
}

function signingKey() {
  const dedicated = process.env.VECTOR_DESIGN_LAB_SECRET ?? ""
  if (dedicated.length >= 32) return dedicated
  const base = [
    process.env.VECTOR_LICENSE_SECRET,
    process.env.VECTOR_CLI_TOKEN_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.CRON_SECRET,
  ].find((secret) => (secret ?? "").length >= 32)
  if (!base) throw new ApiError(503, "DESIGN_LAB_UNAVAILABLE", "This page is not configured.")
  return createHmac("sha256", base).update("vector-design-lab-cookie-v1").digest("base64url")
}

function supabaseConfiguration() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? process.env.SUPABASE_ANON_KEY?.trim() ?? ""
  if (!url || !publishableKey) {
    throw new ApiError(503, "ACCOUNT_NOT_CONFIGURED", "Vector accounts are temporarily unavailable.")
  }
  return { url, publishableKey }
}

function bearerToken(request: Pick<ApiRequest, "headers">) {
  const value = request.headers.authorization
  const header = Array.isArray(value) ? value[0] : value
  return /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "")?.[1]?.trim()
}

function readCookie(request: Pick<ApiRequest, "headers">, name: string) {
  const header = request.headers.cookie
  const raw = Array.isArray(header) ? header.join("; ") : (header ?? "")
  return raw
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
