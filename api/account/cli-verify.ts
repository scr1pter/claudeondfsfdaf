import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { verifyCliTokenClaims } from "../_lib/cli-token.js"
import { accountTokensRevoked, requireUnrevokedCliToken } from "../_lib/revocation.js"
import { afterResponse, recordCliUsage } from "../_lib/usage.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_000)
    // Generous: the CLI re-verifies once a day per machine. Protects the HMAC oracle, not users.
    // If the KV-backed limiter is not configured, verification must still work —
    // a missing rate limiter should never lock people out of `vector login`.
    await enforceRateLimit(request, response, { scope: "cli-verify-ip", limit: 120, windowSeconds: 60 * 60 }).catch(
      (error) => {
        if (error instanceof ApiError && error.code === "ABUSE_PROTECTION_UNAVAILABLE") return
        throw error
      },
    )
    const body = await readJson<{ token?: unknown }>(request, 4_000)
    const token = typeof body.token === "string" ? body.token : ""
    const claims = verifyCliTokenClaims(token)
    if (claims.jti) await requireUnrevokedCliToken(token)
    const user = { id: claims.id, email: claims.email }
    // A token outlives the account that minted it, so a deleted account's
    // terminal would keep verifying for up to ninety days without this.
    if (!claims.jti && (await accountTokensRevoked(user.id))) {
      throw new ApiError(401, "CLI_TOKEN_INVALID", "That CLI token is not valid. Generate a new one.")
    }
    json(response, 200, { ok: true, user })
    // One day of CLI use, counted after the answer so verification never waits on it.
    afterResponse(recordCliUsage(request, user.id))
  } catch (error) {
    handleApiError(response, error)
  }
}
