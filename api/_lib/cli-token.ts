import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { ApiError } from "./http.js"

/**
 * Vector CLI tokens (`vct_…`): stateless HMAC-signed grants minted for a
 * signed-in Vector account so the free terminal agent can verify "this
 * machine belongs to an account" without holding a Supabase session.
 * Format: vct_<base64url payload>.<base64url hmac-sha256>.
 */

export type CliTokenUser = { id: string; email: string }

const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
const DELETION_GRANT_TTL_MS = 10 * 60 * 1000

function secret() {
  // Prefer a dedicated secret; otherwise derive a purpose-bound key so this
  // system never shares raw key material with other signing uses.
  const dedicated = process.env.VECTOR_CLI_TOKEN_SECRET ?? ""
  if (dedicated.length >= 32) return dedicated
  const base = process.env.VECTOR_LICENSE_SECRET ?? ""
  if (base.length < 32) throw new ApiError(503, "CLI_TOKENS_UNAVAILABLE", "Vector CLI tokens are not configured.")
  return createHmac("sha256", base).update("vector-cli-token-key-v1").digest("base64url")
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url")

function sign(payload: string, domain = "vector-cli-v1") {
  return createHmac("sha256", secret()).update(`${domain}.${payload}`).digest("base64url")
}

/**
 * `client` "desktop" marks a token the desktop app's main process got from its own sign-in (api/account/cli-exchange),
 * which it keeps encrypted. A token handed out to paste into a terminal has no mark: it can end up in shell history,
 * a dotfile or a screenshot, so it never opens the billing portal (see verifyDesktopToken). Verifiers from before the
 * mark ignore it, so a marked token works everywhere an unmarked one does.
 */
export function mintCliToken(user: CliTokenUser, now = Date.now(), client?: "desktop" | "cli") {
  const expiresAt = now + CLI_TOKEN_TTL_MS
  const payload = encode(
    JSON.stringify({
      v: 1,
      sub: user.id,
      email: user.email,
      exp: expiresAt,
      ...(client ? { client } : {}),
      ...(client === "cli" ? { jti: randomBytes(16).toString("base64url") } : {}),
    }),
  )
  return { token: `vct_${payload}.${sign(payload)}`, expiresAt }
}

export function verifyCliToken(token: string, now = Date.now()): CliTokenUser {
  const claims = verifyCliTokenClaims(token, now)
  return { id: claims.id, email: claims.email }
}

/** Signed account claims for caller admission and per-token revocation; existing user-only projections stay stable. */
export function verifyCliTokenClaims(token: string, now = Date.now()) {
  const parsed = cliPayload(token, now)
  const client = parsed.client
  const jti = parsed.jti
  if (
    (client !== undefined && client !== "desktop" && client !== "cli") ||
    (jti !== undefined && !validCliTokenID(jti)) ||
    (client === "cli" && jti === undefined)
  )
    throw new ApiError(401, "CLI_TOKEN_INVALID", "That CLI token is not valid. Generate a new one.")
  return {
    id: parsed.sub,
    email: parsed.email,
    ...(client ? { client } : {}),
    ...(typeof jti === "string" ? { jti } : {}),
    expiresAt: parsed.exp,
  }
}

export function validCliTokenID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  )
}

/**
 * A CLI token from the desktop app's own sign-in, for Stripe's billing portal, which can charge the saved card for a
 * bigger plan at once and change the billing email. A pasted token, or a desktop sign-in from before Vector 1.99.109,
 * gets DESKTOP_SIGN_IN_REQUIRED, and the desktop then opens the account page on the website.
 */
export function verifyDesktopToken(token: string, now = Date.now()): CliTokenUser {
  const claims = verifyCliTokenClaims(token, now)
  if (claims.client !== "desktop")
    throw new ApiError(403, "DESKTOP_SIGN_IN_REQUIRED", "Sign in to Vector again to manage billing in the app.")
  return { id: claims.id, email: claims.email }
}

function cliPayload(token: string, now: number) {
  const parsed = signedPayload(
    token,
    "vct_",
    "vector-cli-v1",
    new ApiError(401, "CLI_TOKEN_INVALID", "That CLI token is not valid. Generate a new one."),
  )
  if (typeof parsed.exp !== "number" || !Number.isSafeInteger(parsed.exp) || parsed.exp < 0)
    throw new ApiError(401, "CLI_TOKEN_INVALID", "That CLI token is not valid. Generate a new one.")
  if (parsed.exp <= now) throw new ApiError(401, "CLI_TOKEN_EXPIRED", "That CLI token has expired. Generate a new one.")
  return { ...parsed, exp: parsed.exp }
}

/**
 * Deletion grants (`vdg_…`): what the desktop app receives, instead of a CLI token, after a sign-in on vectordev.ai
 * from the last ten minutes that was made to delete the account. They last ten minutes and are signed under their own
 * domain, so neither kind passes for the other; api/account/delete.ts accepts each one once.
 */
export function mintDeletionGrant(user: CliTokenUser, now = Date.now()) {
  const expiresAt = now + DELETION_GRANT_TTL_MS
  const payload = encode(
    JSON.stringify({
      v: 1,
      sub: user.id,
      email: user.email,
      exp: expiresAt,
      jti: randomBytes(16).toString("base64url"),
    }),
  )
  return { grant: `vdg_${payload}.${sign(payload, "vector-delete-v1")}`, expiresAt }
}

export function verifyDeletionGrant(grant: string, now = Date.now()) {
  const invalid = new ApiError(
    401,
    "DELETION_GRANT_INVALID",
    "This confirmation is no longer valid. Confirm with your Vector sign-in again.",
  )
  const parsed = signedPayload(grant, "vdg_", "vector-delete-v1", invalid)
  if (
    typeof parsed.exp !== "number" ||
    !Number.isSafeInteger(parsed.exp) ||
    parsed.exp <= now ||
    typeof parsed.jti !== "string" ||
    !parsed.jti
  )
    throw invalid
  return { id: parsed.sub, email: parsed.email, jti: parsed.jti, expiresAt: parsed.exp }
}

const Signed = Schema.Struct({
  v: Schema.Literal(1),
  sub: Schema.String,
  email: Schema.String,
  exp: Schema.optional(Schema.Unknown),
  jti: Schema.optional(Schema.Unknown),
  client: Schema.optional(Schema.Unknown),
})

function signedPayload(token: string, prefix: string, domain: string, invalid: ApiError) {
  if (typeof token !== "string" || !token.startsWith(prefix)) throw invalid
  const parts = token.slice(prefix.length).split(".")
  const [payload, signature] = parts
  if (
    parts.length !== 2 ||
    !payload ||
    !signature ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    Buffer.from(payload, "base64url").toString("base64url") !== payload
  )
    throw invalid
  const expected = Buffer.from(sign(payload, domain))
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Signed))(
    Buffer.from(payload, "base64url").toString("utf8"),
  )
  if (Option.isNone(parsed)) throw invalid
  return parsed.value
}
