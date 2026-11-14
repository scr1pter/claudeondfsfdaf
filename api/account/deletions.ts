import { timingSafeEqual } from "node:crypto"
import { drainAccountDeletions, type DeletionOptions } from "../_lib/codium-erase.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const maxDuration = 60
const BUDGET_MS = 45_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleAccountDeletions(request, response)
}

/**
 * The account-deletion cleanup (WP A57, P5; every 10 minutes, `CRON_SECRET`): finishes every deletion that stopped
 * part-way (a service or the identity could not be reached) once it is due again, and runs each finished deletion's
 * follow-up pass. A deletion that keeps failing is retried with a backoff of up to six hours and the owner is emailed.
 * It answers counts only.
 */
export async function handleAccountDeletions(
  request: ApiRequest,
  response: ApiResponse,
  options: DeletionOptions = {},
) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the account deletion job.")
    json(response, 200, await drainAccountDeletions({ ...options, budgetMs: BUDGET_MS }))
  } catch (error) {
    handleApiError(response, error)
  }
}
