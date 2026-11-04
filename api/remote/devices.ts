import { enforceRateLimit } from "../_lib/abuse.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { remoteDevices, requireRemoteCaller } from "../_lib/remote-ticket.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRemoteDevices(request, response)
}

/**
 * `GET /api/remote/devices` (WP A40): the account's paired computers and phones, in pairing order, with
 * `{device, role, name?, key?, pairedAt, lastSeen, online, overLimit}` each, the plan's limits, the fair-use state
 * (`ok`, `viewer` or `awake`) and whether devices can connect now. The desktop app's own sign-in or a website session;
 * it works whatever the plan, so a device can always be found and revoked. 120 reads an hour per account.
 */
export async function handleRemoteDevices(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "GET")
    const caller = await requireRemoteCaller(request, fetcher, clock())
    await enforceRateLimit(
      request,
      response,
      { scope: "remote-devices", identifier: caller.account, limit: 120, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    json(response, 200, await remoteDevices(caller.account, fetcher, clock()))
  } catch (error) {
    handleApiError(response, error)
  }
}
