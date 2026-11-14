import { enforceRateLimit, requireTrustedJsonRequest } from "../../../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../../../_lib/http.js"
import { RELAY_DEVICE_ID, relayConfigured, relayRevokeDevice } from "../../../_lib/remote-relay.js"
import { requireRemoteCaller } from "../../../_lib/remote-ticket.js"
import { phoneAppOrigin } from "../../../_lib/web-push.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRemoteRevoke(request, response)
}

/**
 * `POST /api/remote/devices/:id/revoke` (WP A40): unpairs one device. Its connections close at once and the relay
 * refuses its id from then on (it pairs again under a new id). The desktop app's own sign-in or a website session; it
 * works whatever the plan. 30 an hour per account. Answers `{revoked: true, closed}`.
 */
export async function handleRemoteRevoke(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "POST")
    const phone = phoneAppOrigin()
    requireTrustedJsonRequest(request, 1_024, phone ? [phone] : [])
    const device = queryValue(request, "id") ?? ""
    if (!RELAY_DEVICE_ID.test(device))
      throw new ApiError(400, "REMOTE_DEVICE_INVALID", "Choose one of your paired devices.")
    const caller = await requireRemoteCaller(request, fetcher, clock())
    await enforceRateLimit(
      request,
      response,
      { scope: "remote-revoke", identifier: caller.account, limit: 30, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    if (!relayConfigured()) throw new ApiError(503, "REMOTE_UNAVAILABLE", "Vector Remote is temporarily unavailable.")
    json(response, 200, await relayRevokeDevice(caller.account, device, fetcher, clock()))
  } catch (error) {
    handleApiError(response, error)
  }
}
