import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { requireAccountUser } from "../_lib/account.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import {
  parsePushSubscription,
  phoneAppOrigin,
  PUSH_LIMITS,
  removePushSubscription,
  requirePushPlan,
  requirePushService,
  savePushSubscription,
  vapidConfiguration,
} from "../_lib/web-push.js"

const HOUR_SECONDS = 60 * 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleNotifySubscribe(request, response)
}

/**
 * `/api/notify/subscribe` (WP A37), for the phone app's alerts.
 *
 * - `GET` answers `{publicKey}`, the VAPID key a browser needs to subscribe (503 `PUSH_UNAVAILABLE` until configured).
 * - `POST {subscription}` stores the browser's `PushSubscription.toJSON()` for the signed-in account: a Vector website
 *   session (the phone app signs in on its own origin). It needs push configured and switched on, and a plan that
 *   allows phone alerts (§4.4: active or renewing), decided here from the entitlement snapshot (S1). Only endpoints
 *   of the browsers' own push services are taken. An account keeps at most ten; an eleventh replaces the oldest.
 * - `DELETE {endpoint}` removes one, whatever the plan, so alerts can always be turned off.
 */
export async function handleNotifySubscribe(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    if (request.method === "GET") {
      const configuration = vapidConfiguration()
      if (!configuration) throw new ApiError(503, "PUSH_UNAVAILABLE", "Phone alerts are temporarily unavailable.")
      json(response, 200, { publicKey: configuration.publicKey })
      return
    }
    if (request.method !== "POST" && request.method !== "DELETE") requireMethod(request, "POST")
    const phone = phoneAppOrigin()
    requireTrustedJsonRequest(request, 4_096, phone ? [phone] : [])
    const user = await requireAccountUser(request, fetcher)
    await enforceRateLimit(
      request,
      response,
      {
        scope: "notify-subscribe",
        identifier: user.id,
        limit: 30,
        windowSeconds: HOUR_SECONDS,
        requirePersistent: true,
      },
      fetcher,
    )
    const body = await readJson<unknown>(request, 4_096)
    const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
    if (request.method === "DELETE") {
      if (typeof input.endpoint !== "string" || !input.endpoint || input.endpoint.length > PUSH_LIMITS.endpointChars)
        throw new ApiError(400, "PUSH_SUBSCRIPTION_INVALID", "That push subscription is not valid.")
      json(response, 200, { removed: await removePushSubscription(user.id, input.endpoint, fetcher) })
      return
    }
    const now = clock()
    const subscription = parsePushSubscription(input.subscription, now)
    await requirePushService(fetcher, now)
    await requirePushPlan(user.id, fetcher, now)
    json(response, 200, { subscribed: true, id: await savePushSubscription(user.id, subscription, fetcher, now) })
  } catch (error) {
    handleApiError(response, error)
  }
}
