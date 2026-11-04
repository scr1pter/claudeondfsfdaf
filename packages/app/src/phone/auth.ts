// Signing in on the phone app (WP A38). The phone signs in to the same Vector account as the website, with a session
// of its own on its own origin (A37's subscribe route and A40's phone tickets take exactly that). This is the small
// part of the account service's browser flow the phone needs, over fetch: Google through the PKCE code flow, or email
// and password, then refresh and sign out. The account service's address and public key come from the site's own
// `/api/auth/config`, the same answer the website reads, so none is built in.
//
// The session stays in this origin's localStorage. On iOS that is the installed app's own storage, which is why the
// app asks to be installed before signing in there.

export type AuthConfig = { url: string; publishableKey: string }
export type PhoneSession = { accessToken: string; refreshToken: string; expiresAt: number; email?: string }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
export type KeyValue = {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const SESSION_KEY = "vector-phone-session"
const VERIFIER_KEY = "vector-phone-pkce"
/** Refresh a session this long before it expires. */
const REFRESH_EARLY_MS = 60_000

export class AuthError extends Error {}

/** The account service's address and public key, from the site. */
export async function readAuthConfig(fetcher: Fetch): Promise<AuthConfig> {
  const response = await fetcher("/api/auth/config", { headers: { accept: "application/json" } }).catch(() => undefined)
  const body = response?.ok ? await response.json().catch(() => undefined) : undefined
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
  const url = typeof value?.url === "string" ? value.url.trim().replace(/\/+$/, "") : ""
  const publishableKey = typeof value?.publishableKey === "string" ? value.publishableKey.trim() : ""
  if (value?.available !== true || !/^https:\/\/[^/\s]+$/.test(url) || !publishableKey)
    throw new AuthError("Vector accounts are temporarily unavailable.")
  return { url, publishableKey }
}

/** A PKCE verifier's S256 challenge (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

/** A new PKCE verifier (64 URL-safe characters from 48 random bytes) and its challenge. */
export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  return { verifier, challenge: await pkceChallenge(verifier) }
}

/** The address that starts Google sign-in; the verifier is kept until the code comes back. */
export async function googleSignInUrl(config: AuthConfig, redirectTo: string, storage: KeyValue) {
  const { verifier, challenge } = await pkcePair()
  storage.set(VERIFIER_KEY, verifier)
  const url = new URL(`${config.url}/auth/v1/authorize`)
  url.searchParams.set("provider", "google")
  url.searchParams.set("redirect_to", redirectTo)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "s256")
  return url.toString()
}

/** Exchanges the code Google sign-in returned for a session, with the verifier kept when it started. */
export async function finishGoogleSignIn(
  config: AuthConfig,
  code: string,
  storage: KeyValue,
  fetcher: Fetch,
  now = Date.now(),
) {
  const verifier = storage.get(VERIFIER_KEY)
  storage.remove(VERIFIER_KEY)
  if (!verifier) throw new AuthError("Sign-in took too long or started elsewhere. Try again here.")
  return saveSession(await token(config, "pkce", { auth_code: code, code_verifier: verifier }, fetcher, now), storage)
}

export async function passwordSignIn(
  config: AuthConfig,
  email: string,
  password: string,
  storage: KeyValue,
  fetcher: Fetch,
  now = Date.now(),
) {
  return saveSession(await token(config, "password", { email: email.trim(), password }, fetcher, now), storage)
}

/**
 * The stored session, refreshed first when it is about to expire; undefined when signed out or when the account
 * service refused the refresh. A network failure throws and keeps the session for the next try.
 */
export async function currentSession(config: AuthConfig, storage: KeyValue, fetcher: Fetch, now = Date.now()) {
  const session = readSession(storage)
  if (!session) return undefined
  if (session.expiresAt - REFRESH_EARLY_MS > now) return session
  try {
    return saveSession(
      await token(config, "refresh_token", { refresh_token: session.refreshToken }, fetcher, now),
      storage,
    )
  } catch (cause) {
    if (!(cause instanceof AuthError)) throw cause
    storage.remove(SESSION_KEY)
    return undefined
  }
}

export async function signOut(config: AuthConfig, storage: KeyValue, fetcher: Fetch) {
  const session = readSession(storage)
  storage.remove(SESSION_KEY)
  if (!session) return
  await fetcher(`${config.url}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: config.publishableKey, authorization: `Bearer ${session.accessToken}` },
  }).catch(() => undefined)
}

export function readSession(storage: KeyValue): PhoneSession | undefined {
  const raw = storage.get(SESSION_KEY)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof value.accessToken === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.expiresAt === "number" &&
      (value.email === undefined || typeof value.email === "string")
    )
      return value as PhoneSession
  } catch {}
  storage.remove(SESSION_KEY)
  return undefined
}

async function token(
  config: AuthConfig,
  grant: "pkce" | "password" | "refresh_token",
  body: Record<string, string>,
  fetcher: Fetch,
  now: number,
): Promise<PhoneSession> {
  const response = await fetcher(`${config.url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: config.publishableKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  }).catch(() => {
    throw new Error("Vector could not reach its account service. Check your connection.")
  })
  const value = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!response.ok || !value) {
    if (response.status >= 500) throw new Error("Vector accounts are temporarily unavailable.")
    throw new AuthError(
      grant === "password" ? "That email and password did not match." : "Your sign-in expired. Sign in again.",
    )
  }
  const expiresIn = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 3600
  const user = value.user && typeof value.user === "object" ? (value.user as Record<string, unknown>) : undefined
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string")
    throw new AuthError("Your sign-in expired. Sign in again.")
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: now + expiresIn * 1000,
    ...(typeof user?.email === "string" ? { email: user.email } : {}),
  }
}

function saveSession(session: PhoneSession, storage: KeyValue) {
  storage.set(SESSION_KEY, JSON.stringify(session))
  return session
}

/** localStorage, or a store that keeps nothing when the browser refuses storage. */
export function browserStorage(): KeyValue {
  return {
    get: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch {}
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key)
      } catch {}
    },
  }
}

export function base64url(bytes: Uint8Array) {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}
