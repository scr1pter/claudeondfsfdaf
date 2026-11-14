import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { mintRemoteTicket, parseTicketRequest, requireRemoteCaller, requireRoleCaller } from "../_lib/remote-ticket.js"
import { phoneAppOrigin } from "../_lib/web-push.js"

const HOUR_SECONDS = 60 * 60
/**
 * Tickets an account may mint an hour. A connected phone refreshes about every four minutes; five computers and five
 * phones reconnecting through a bad network stay well inside this.
 */
export const REMOTE_TICKETS_PER_HOUR = 300

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRemoteTicket(request, response)
}

/**
 * `POST /api/remote/ticket {role, device, name?, key?}` (WP A40): a five-minute ticket for one connection to the
 * Remote relay, `{ticket, url, protocol, expiresAt}`. The device opens `url` offering `protocol` and the ticket in
 * `Sec-WebSocket-Protocol`, and refreshes in-band with a new ticket from here before `expiresAt`.
 *
 * A computer needs the desktop app's own sign-in; a phone needs a website session sent from the phone app's origin.
 * Both need an account that is not revoked, Remote configured and switched on, and a plan that allows Remote now,
 * decided from the entitlement snapshot (S1, S6). The paired-computer count and the other caps come from the snapshot,
 * never the body. 300 tickets an hour per account.
 */
export async function handleRemoteTicket(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "POST")
    const phone = phoneAppOrigin()
    requireTrustedJsonRequest(request, 4_096, phone ? [phone] : [])
    const ticket = parseTicketRequest(await readJson<unknown>(request, 4_096))
    const caller = await requireRemoteCaller(request, fetcher, clock())
    requireRoleCaller(caller, ticket.role)
    await enforceRateLimit(
      request,
      response,
      {
        scope: "remote-ticket",
        identifier: caller.account,
        limit: REMOTE_TICKETS_PER_HOUR,
        windowSeconds: HOUR_SECONDS,
        requirePersistent: true,
      },
      fetcher,
    )
    json(response, 200, await mintRemoteTicket(caller, ticket, fetcher, clock()))
  } catch (error) {
    handleApiError(response, error)
  }
}
