import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { relayConfigured, relayKill } from "../_lib/remote-relay.js"
import { requireRemoteCaller } from "../_lib/remote-ticket.js"
import { phoneAppOrigin } from "../_lib/web-push.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRemoteKill(request, response)
}

/**
 * `POST /api/remote/kill` (WP A40), "Disconnect all": every relay connection the account has closes now, and every
 * ticket issued before now is refused, so each device must ask for a new ticket (a revoked account cannot). Paired
 * devices stay paired. The desktop app's own sign-in or a website session; it works whatever the plan. 10 an hour per
 * account. Answers `{revokedBefore, closed}`.
 */
export async function handleRemoteKill(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "POST")
    const phone = phoneAppOrigin()
    requireTrustedJsonRequest(request, 1_024, phone ? [phone] : [])
    const caller = await requireRemoteCaller(request, fetcher, clock())
    await enforceRateLimit(
      request,
      response,
      { scope: "remote-kill", identifier: caller.account, limit: 10, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    if (!relayConfigured()) throw new ApiError(503, "REMOTE_UNAVAILABLE", "Vector Remote is temporarily unavailable.")
    const now = clock()
    json(response, 200, await relayKill(caller.account, now, fetcher, now))
  } catch (error) {
    handleApiError(response, error)
  }
}
