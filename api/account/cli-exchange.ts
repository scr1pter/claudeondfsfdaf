import { requireUnrevokedAccount } from "../_lib/revocation.js"
import { enforceRateLimit, requireTrustedJsonRequest, stableAbuseIdentifier } from "../_lib/abuse.js"
import { consumeDesktopCode } from "../_lib/desktop-account.js"
import { mintCliToken, mintDeletionGrant } from "../_lib/cli-token.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  return handleCliExchange(request, response)
}

export async function handleCliExchange(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await enforceRateLimit(
      request,
      response,
      { scope: "desktop-exchange-ip", limit: 30, windowSeconds: 300, requirePersistent: true },
      fetcher,
    )
    const body = await readJson<{ code?: unknown }>(request, 2_000)
    await enforceRateLimit(
      request,
      response,
      {
        scope: "desktop-exchange-code",
        identifier: stableAbuseIdentifier(typeof body.code === "string" ? body.code : "invalid"),
        limit: 8,
        windowSeconds: 300,
        requirePersistent: true,
      },
      fetcher,
    )
    const exchanged = await consumeDesktopCode(body, fetcher, now)
    await requireUnrevokedAccount(exchanged.user.id, fetcher)
    // Only the saved PKCE purpose selects the credential. Exchange-body client/purpose fields grant nothing.
    json(
      response,
      200,
      exchanged.purpose === "delete"
        ? { ...mintDeletionGrant(exchanged.user, now), user: { email: exchanged.user.email } }
        : {
            ...mintCliToken(exchanged.user, now, exchanged.purpose === "cli" ? "cli" : "desktop"),
            user: exchanged.user,
          },
    )
  } catch (error) {
    handleApiError(response, error)
  }
}
