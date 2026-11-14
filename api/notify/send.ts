import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { requireUnrevokedCliToken } from "../_lib/revocation.js"
import type { SafeFetchOptions } from "../_lib/safe-fetch.js"
import { deliverPush, parseEncryptedAlert, PUSH_LIMITS, requirePushPlan, requirePushService } from "../_lib/web-push.js"

const HOUR_SECONDS = 60 * 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleNotifySend(request, response)
}

/**
 * `POST /api/notify/send {ciphertext, key?, urgency?}` (WP A37): the desktop relays one alert to the account's phones.
 *
 * The alert is encrypted end to end on the desktop (P7): the body carries only base64url ciphertext of at most 3 KB,
 * and a title, message or any other field is refused, so the server never holds an alert's text. Each phone gets the
 * ciphertext inside its own Web Push encryption. Only the desktop app's own sign-in (a `vct_` token marked `desktop`)
 * may send: a pasted CLI token gets 403 `DESKTOP_SIGN_IN_REQUIRED`, and a run token is never accepted (S3). 60 sends an
 * hour per account. The plan must allow phone alerts (§4.4: active or renewing), read from the entitlement snapshot
 * (S1); push must be configured and switched on. The answer counts phones reached, failed and removed (a push service
 * answering 404 or 410 deletes the subscription).
 */
export async function handleNotifySend(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  network: SafeFetchOptions = {},
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_096)
    const authorization = request.headers.authorization
    const token = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      typeof authorization === "string" ? authorization : "",
    )?.[1]
    if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    const claims = await requireUnrevokedCliToken(token, fetcher, clock())
    if (claims.client !== "desktop")
      throw new ApiError(403, "DESKTOP_SIGN_IN_REQUIRED", "Sign in to Vector again in the app to send phone alerts.")
    await enforceRateLimit(
      request,
      response,
      {
        scope: "notify-send",
        identifier: claims.id,
        limit: PUSH_LIMITS.sendsPerHour,
        windowSeconds: HOUR_SECONDS,
        requirePersistent: true,
      },
      fetcher,
    )
    const { payload, urgency } = parseEncryptedAlert(await readJson<unknown>(request, 4_096))
    const now = clock()
    const configuration = await requirePushService(fetcher, now)
    await requirePushPlan(claims.id, fetcher, now)
    json(response, 200, await deliverPush(claims.id, payload, configuration, { fetcher, now, urgency, network }))
  } catch (error) {
    handleApiError(response, error)
  }
}
