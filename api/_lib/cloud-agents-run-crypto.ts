import { createHmac } from "node:crypto"
import { ApiError } from "./http.js"

// This leaf contains no entitlement, registry or run lifecycle imports. A health check must not initialize those
// services, and the token verifier can also be an import entrypoint before Codium's caller registry initializes.
export function signRunTokenPayload(payload: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  return createHmac("sha256", key(env)).update(`vector-run-v1.${payload}`).digest("base64url")
}

/** Crypto/configuration self-check only. No token, account, live reservation or key is returned or persisted. */
export function runTokenCryptoReady(env: Readonly<Record<string, string | undefined>> = process.env) {
  try {
    const probe = Buffer.from(signRunTokenPayload("vector-run-readiness-v1", env), "base64url")
    const valid = probe.length === 32
    probe.fill(0)
    return valid
  } catch {
    return false
  }
}

// A dedicated secret, or a key derived from the license secret for this purpose alone, as cli-token.ts derives its
// own: the two share no key material unless an operator sets them equal, and their HMAC domains differ even then.
function key(env: Readonly<Record<string, string | undefined>>) {
  const dedicated = env.VECTOR_RUN_TOKEN_SECRET ?? ""
  if (dedicated.length >= 32) return dedicated
  const base = env.VECTOR_LICENSE_SECRET ?? ""
  if (base.length < 32) throw new ApiError(503, "RUN_TOKENS_UNAVAILABLE", "Vector run tokens are not configured.")
  return createHmac("sha256", base).update("vector-run-token-key-v1").digest("base64url")
}
