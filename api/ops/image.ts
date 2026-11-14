import { enforceRateLimit } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireOpsCaller } from "../_lib/ops-api.js"
import { imageLink } from "../_lib/ship-desk.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsImage(request, response)
}

/** The card and image number, from the rewrite's query (`/api/ops/image/:card/:n`) or the path itself. */
export function imageTarget(url: string | undefined) {
  const parsed = new URL(url ?? "/", "https://vectordev.ai")
  const card = parsed.searchParams.get("card")
  const n = parsed.searchParams.get("n")
  if (card !== null && n !== null) return { card, n }
  const match = /^\/api\/ops\/image\/([^/]+)\/([^/]+)\/?$/.exec(parsed.pathname)
  return match ? { card: decodeURIComponent(match[1]!), n: decodeURIComponent(match[2]!) } : { card: "", n: "" }
}

/**
 * `GET /api/ops/image/<card>/<n>` (WP A49): one of a Ship Desk card's screenshots, for the card's own account only.
 * The answer is a signed `vector-media` link that lives 60 seconds and pins the image's type (PNG or WebP, checked by
 * its signature when it was uploaded), `no-store` and an attachment disposition, with the image's size. This answer
 * itself is `no-store`, `nosniff` and under a sandbox CSP. A frozen plan hides the images (403 `SHIP_DESK_HIDDEN`).
 * Callers: an unrevoked `vct_` account token or a website session; run tokens and capture tickets get 401. 600 an hour.
 */
export async function handleOpsImage(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("content-security-policy", "default-src 'none'; sandbox")
  response.setHeader("referrer-policy", "no-referrer")
  try {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.")
    const now = clock()
    const caller = await requireOpsCaller(request, fetcher, now)
    await enforceRateLimit(
      request,
      response,
      { scope: "ops-image", identifier: caller.account, limit: 600, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    const target = imageTarget(request.url)
    json(response, 200, await imageLink(caller.account, target.card, target.n, fetcher, now))
  } catch (error) {
    handleApiError(response, error)
  }
}
