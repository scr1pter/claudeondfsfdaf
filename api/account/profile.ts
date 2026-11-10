import { enforceRateLimit } from "../_lib/abuse.js"
import { readAccountProfile } from "../_lib/account.js"
import { verifyCliTokenClaims } from "../_lib/cli-token.js"
import { accountTokensRevoked, requireUnrevokedCliToken } from "../_lib/revocation.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

/**
 * The signed-in desktop's display name and profile photo URL, for the sidebar's account chip. The desktop reads
 * them at most once a day, so a sign-in saved before either was carried shows them without signing in again.
 * The answer is display-only and grants nothing.
 */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    // As generous as CLI verification, and like it, a missing limiter never fails the request.
    await enforceRateLimit(request, response, {
      scope: "account-profile-ip",
      limit: 120,
      windowSeconds: 60 * 60,
    }).catch((error) => {
      if (error instanceof ApiError && error.code === "ABUSE_PROTECTION_UNAVAILABLE") return
      throw error
    })
    const token = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? ""
    const user = verifyCliTokenClaims(token)
    if (user.jti) await requireUnrevokedCliToken(token)
    if (!user.jti && (await accountTokensRevoked(user.id)))
      throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    const profile = await readAccountProfile(user.id)
    json(response, 200, { name: profile.name ?? null, avatar: profile.avatar ?? null })
  } catch (error) {
    handleApiError(response, error)
  }
}
