import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { opsRateLimit, requireOpsCaller } from "../_lib/ops-api.js"
import { listCards, openCard, type ShipDeskContext } from "../_lib/ship-desk.js"

export const maxDuration = 30

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsCards(request, response)
}

/**
 * `GET /api/ops/cards` (WP A49): Ship Desk's cards, for the phone and the desktop (A50 builds the screens).
 *
 * - Without `id`: the newest cards, newest first, as stored (nothing is asked of GitHub).
 * - `?id=<card>`: one card, with its check runs read again from GitHub while the pull request is open and some are still
 *   running (at most once a minute) and the run's verdict read again from its record until the run ended.
 *
 * Each card has the pull request, its checks, the run's verdict (from Codex's run record, never the pull request's
 * body), its images (fetched one by one from `/api/ops/image/<card>/<n>`) and Approve: the pull request's address in
 * GitHub, and what the desktop needs to merge it with the person's own GitHub sign-in. Vector's server never merges.
 * Cards stay readable whatever the plan until they expire; a frozen plan hides them (`hidden: true`, or 403
 * `SHIP_DESK_HIDDEN` for one card). Callers: an unrevoked `vct_` account token or a website session; run tokens get 401
 * (S3). 240 an hour per account.
 */
export async function handleOpsCards(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  context: Omit<ShipDeskContext, "fetcher" | "now"> = {},
) {
  try {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.")
    const now = clock()
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-read", caller.account, 240, fetcher)
    const id = new URL(request.url ?? "/", "https://vectordev.ai").searchParams.get("id")
    if (id === null) return json(response, 200, await listCards(caller.account, fetcher, now))
    json(response, 200, await openCard(caller.account, id, { ...context, fetcher, now }))
  } catch (error) {
    handleApiError(response, error)
  }
}
