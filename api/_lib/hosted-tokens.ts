import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { ApiError } from "./http.js"

/*
 * The cloud computer's tokens (contract WP A53). None of them is a long-lived credential (S7).
 *
 * - **Run tokens** (`vht_`, §4.9): HMAC-SHA-256 under `VECTOR_HOSTED_RUN_SIGNING_KEY`, domain `vector-hosted-v1`. The
 *   session's computer never holds one: the provider's egress proxy adds it to requests for the run-API host only
 *   (WP A52). Each is bound to one account and one session and lives until a little after the block of time it was
 *   minted with (`stopBy`); the reaper mints the next one with each block. A run token is accepted only at chat,
 *   `/models`, estimate and the session's own heartbeat (S3), and every acceptance also checks that the session is
 *   live and that the account's run tokens were not revoked.
 * - **Viewer tokens** (`vvt1.`): Ed25519 under `VECTOR_HOSTED_VIEWER_SIGNING_KEY` (base64url PKCS#8 DER), five minutes,
 *   single use, view or control, carried in the live view URL's fragment. The computer's viewer proxy checks them with
 *   the public key (format in `Hosted.VIEWER_TOKEN_PREFIX`).
 * - **Download links** (`vhd1.`): HMAC under the run signing key, domain `vector-hosted-download-v1`, 24 hours, one
 *   session's packed files. The link leads to a fresh 15-minute signed R2 link each time it is opened.
 */

const RUN_DOMAIN = "vector-hosted-v1."
const DOWNLOAD_DOMAIN = "vector-hosted-download-v1."
const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const TOKEN = /^vht_([A-Za-z0-9_-]{16,4096})\.([A-Za-z0-9_-]{43})$/
const DOWNLOAD = /^vhd1\.([A-Za-z0-9_-]{16,1024})\.([A-Za-z0-9_-]{43})$/
/** A run token is never minted for longer than this, whatever the session's deadline. */
export const RUN_TOKEN_MAX_MS = 60 * 60_000

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function runSecret() {
  const value = process.env.VECTOR_HOSTED_RUN_SIGNING_KEY?.trim() ?? ""
  return value.length >= 32 ? value : undefined
}

/** Whether run tokens and download links can be signed here (`VECTOR_HOSTED_RUN_SIGNING_KEY`, at least 32 characters). */
export function hostedRunSigningConfigured() {
  return runSecret() !== undefined
}

let viewerCache: { setting: string; key: KeyObject | undefined } | undefined

/** The Ed25519 private key viewer tokens are signed with, or undefined when it is missing or not an Ed25519 key. */
function viewerSigningKey(): KeyObject | undefined {
  const setting = process.env.VECTOR_HOSTED_VIEWER_SIGNING_KEY?.trim() ?? ""
  if (viewerCache?.setting === setting) return viewerCache.key
  let key: KeyObject | undefined
  if (setting && /^[A-Za-z0-9_-]+$/.test(setting)) {
    try {
      const parsed = createPrivateKey({ key: Buffer.from(setting, "base64url"), format: "der", type: "pkcs8" })
      key = parsed.asymmetricKeyType === "ed25519" ? parsed : undefined
    } catch {
      key = undefined
    }
  }
  viewerCache = { setting, key }
  return key
}

/** Whether viewer tokens can be signed here. */
export function hostedViewerConfigured() {
  return viewerSigningKey() !== undefined
}

/** The viewer tokens' public key, raw 32 bytes as base64url (what the computer's viewer proxy checks with). */
export function viewerPublicKey() {
  const key = viewerSigningKey()
  if (!key) throw unavailable()
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string }
  if (typeof jwk.x !== "string") throw unavailable()
  return jwk.x
}

// ── Run tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedRunClaims = {
  v: 1
  /** The account the session spends. */
  account: string
  session: string
  source: Hosted.SessionSource
  /** Issued and expiry, in ms. */
  iat: number
  exp: number
  nonce: string
}

/** A run token for one session, valid from `iat` until `exp` (at most `RUN_TOKEN_MAX_MS` later). */
export function mintHostedRunToken(input: Omit<HostedRunClaims, "v" | "nonce">) {
  const secret = runSecret()
  if (!secret) throw unavailable()
  if (
    !ACCOUNT.test(input.account) ||
    !Hosted.SESSION_ID.test(input.session) ||
    !Hosted.SESSION_SOURCES.includes(input.source) ||
    !Number.isSafeInteger(input.iat) ||
    !Number.isSafeInteger(input.exp) ||
    input.exp <= input.iat ||
    input.exp - input.iat > RUN_TOKEN_MAX_MS
  )
    throw new Error("A hosted run token needs an account, a session and a lifetime of at most an hour.")
  const claims: HostedRunClaims = { v: 1, ...input, nonce: randomBytes(12).toString("base64url") }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `vht_${payload}.${mac(secret, RUN_DOMAIN, payload)}`
}

/**
 * The claims of a run token whose signature and lifetime hold at `now`, or 401 `MODEL_PLAN_RUN_EXPIRED`. Whether the
 * session is still live, and whether the account's run tokens were revoked, is for the caller to check.
 */
export function readHostedRunToken(token: string, now = Date.now()): HostedRunClaims {
  const secret = runSecret()
  if (!secret) throw unavailable()
  const match = TOKEN.exec(token)
  if (!match || !equal(mac(secret, RUN_DOMAIN, match[1]!), match[2]!)) throw runExpired()
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"))
  } catch {
    throw runExpired()
  }
  const value = claims as Partial<HostedRunClaims> | null
  if (
    !value ||
    value.v !== 1 ||
    typeof value.account !== "string" ||
    !ACCOUNT.test(value.account) ||
    typeof value.session !== "string" ||
    !Hosted.SESSION_ID.test(value.session) ||
    !Hosted.SESSION_SOURCES.some((source) => source === value.source) ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    typeof value.nonce !== "string" ||
    value.iat! > now + 60_000 ||
    value.exp! <= now ||
    value.exp! - value.iat! > RUN_TOKEN_MAX_MS
  )
    throw runExpired()
  return value as HostedRunClaims
}

// ── Viewer tokens ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ViewerClaims = {
  aud: "vector-viewer"
  sid: string
  computer: string
  mode: Hosted.ViewerMode
  jti: string
  iat: number
  exp: number
}

/** A single-use viewer token for one session's computer, valid `Hosted.VIEWER_TOKEN_MS`. */
export function mintViewerToken(input: { session: string; computer: string; mode: Hosted.ViewerMode; now: number }) {
  const key = viewerSigningKey()
  if (!key) throw unavailable()
  const iat = Math.floor(input.now / 1000)
  const claims: ViewerClaims = {
    aud: "vector-viewer",
    sid: input.session,
    computer: input.computer,
    mode: input.mode,
    jti: randomBytes(16).toString("base64url"),
    iat,
    exp: iat + Hosted.VIEWER_TOKEN_MS / 1000,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = sign(null, Buffer.from(Hosted.VIEWER_TOKEN_CONTEXT + payload), key).toString("base64url")
  return { token: `${Hosted.VIEWER_TOKEN_PREFIX}.${payload}.${signature}`, claims }
}

/**
 * What the computer's viewer proxy does with a token (WP A54 implements it there; kept here as the reference and for
 * tests): the claims when the signature, audience, session, computer and expiry hold, else undefined. Single use is the
 * proxy's own record of jtis it accepted.
 */
export function checkViewerToken(
  token: string,
  publicKey: string,
  expect: { session: string; computer: string; now: number },
): ViewerClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== Hosted.VIEWER_TOKEN_PREFIX) return undefined
  let key: KeyObject
  try {
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" })
  } catch {
    return undefined
  }
  if (!verify(null, Buffer.from(Hosted.VIEWER_TOKEN_CONTEXT + parts[1]), key, Buffer.from(parts[2]!, "base64url")))
    return undefined
  let claims: ViewerClaims
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as ViewerClaims
  } catch {
    return undefined
  }
  const now = Math.floor(expect.now / 1000)
  if (
    claims.aud !== "vector-viewer" ||
    claims.sid !== expect.session ||
    claims.computer !== expect.computer ||
    !Hosted.VIEWER_MODES.includes(claims.mode) ||
    typeof claims.jti !== "string" ||
    !(claims.exp > now) ||
    claims.exp - claims.iat > Hosted.VIEWER_TOKEN_MS / 1000
  )
    return undefined
  return claims
}

// ── Download links ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The session and the expiry (ms). The account is not in the link: the session's record names it. */
export type DownloadClaims = { s: string; exp: number }

/** A 24-hour download token for one session's packed files. */
export function mintDownloadToken(input: { session: string; now: number }) {
  const secret = runSecret()
  if (!secret) throw unavailable()
  const claims: DownloadClaims = { s: input.session, exp: input.now + Hosted.DOWNLOAD_LINK_MS }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return { token: `vhd1.${payload}.${mac(secret, DOWNLOAD_DOMAIN, payload)}`, expiresAt: claims.exp }
}

/** The claims of a download token for `session` that holds at `now`, or undefined. */
export function readDownloadToken(token: string, session: string, now: number): DownloadClaims | undefined {
  const secret = runSecret()
  if (!secret) return undefined
  const match = DOWNLOAD.exec(token)
  if (!match || !equal(mac(secret, DOWNLOAD_DOMAIN, match[1]!), match[2]!)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as DownloadClaims
    if (claims.s !== session || !(claims.exp > now))
      return undefined
    return claims
  } catch {
    return undefined
  }
}

// ── Requests ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * S7: a request carrying a run token must not look like a browser's (`Origin`, any `Sec-Fetch-*`, cookies). The
 * computer's daemon and agent send none of these; a page in the computer's browser that reached the run-API host would
 * (its URL policy bars the host as well, WP A54), so no web page can borrow the token the provider's proxy adds.
 */
export function refuseBrowserShaped(headers: Readonly<Record<string, unknown>>) {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === "origin" || lower === "cookie" || lower.startsWith("sec-fetch-"))
      throw new ApiError(403, "HOSTED_RUN_REFUSED", "This request is not accepted here.")
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

function mac(secret: string, domain: string, payload: string) {
  return createHmac("sha256", secret).update(domain + payload).digest("base64url")
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function runExpired() {
  return new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized. Save your work and finish the run.")
}

function unavailable() {
  return new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is temporarily unavailable. Try again shortly.")
}
