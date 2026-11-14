import { enforceRateLimit } from "../_lib/abuse.js"
import { requireEntitlement } from "../_lib/codium-entitlements.js"
import { listedPerks } from "../_lib/codium-perks.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { playbookLinks, readPlaybooks } from "../_lib/playbooks.js"
import { requireUnrevokedCliToken } from "../_lib/revocation.js"

const HOUR_SECONDS = 60 * 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handlePlaybooks(request, response)
}

/**
 * `GET /api/account/playbooks` (WP A36), for the client that installs Vector Playbooks (Track B, B07). It answers
 * `[{name, version, sha256, url}]`: every published playbook, each with a GET link to its file in the media bucket that
 * lives 10 minutes. The client checks the file's SHA-256 before it writes anything.
 *
 * - **Dark until listed.** Until `playbooks` is listed (`CODIUM_LISTED_PERKS`, `CODIUM_TRACK_B_LIVE=true`, its runtime
 *   perk switch, the media bucket and at least two published playbooks; contract §4.14), every request gets 404, before
 *   any sign-in is read, so the route says nothing about itself.
 * - **Who.** Only a Vector account token (`vct_`, from the desktop's sign-in or the CLI); run tokens never (S3). The
 *   plan comes from the entitlement snapshot, never from the client (S1): Pro, Max and Ultra while the plan is active or
 *   renewing (§4.4 "Playbooks downloads"). Otherwise the contract's own refusal: 402 `MODEL_PLAN_REQUIRED` or
 *   `MODEL_PLAN_PAYMENT_REQUIRED`, 403 `CODIUM_PERK_REQUIRED {perk: "playbooks", plan: "vector-50"}` or
 *   `MODEL_PLAN_BLOCKED`, 503 `MODEL_PLAN_RENEWING`. With a fresh snapshot nothing here calls Stripe (M4).
 * - 60 requests an hour per account.
 */
export async function handlePlaybooks(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    if (!(await listedPerks(fetcher)).has("playbooks")) throw new ApiError(404, "NOT_FOUND", "Not found.")
    requireMethod(request, "GET")
    const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
    if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    const account = await requireUnrevokedCliToken(token, fetcher)
    await enforceRateLimit(
      request,
      response,
      { scope: "playbooks", identifier: account.id, limit: 60, windowSeconds: HOUR_SECONDS, requirePersistent: true },
      fetcher,
    )
    const now = clock()
    await requireEntitlement(account.id, "playbooks", fetcher, now)
    json(response, 200, playbookLinks(await readPlaybooks({ fetcher }), now))
  } catch (error) {
    handleApiError(response, error)
  }
}
