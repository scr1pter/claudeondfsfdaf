import { timingSafeEqual } from "node:crypto"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { cleanupOps } from "../_lib/ops-cleanup.js"

export const maxDuration = 60
const BUDGET_MS = 45_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsCleanup(request, response)
}

/**
 * The daily ops cleanup (contract §4.19, 04:40 UTC, `CRON_SECRET`; WP A50): deletes Ship Desk cards past their keep days
 * with their images, removes list entries whose incident or card expired, and erases an account's ops records 30 days
 * after it lost a dispute (api/_lib/ops-cleanup.ts). It answers counts only.
 */
export async function handleOpsCleanup(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the ops cleanup job.")
    json(response, 200, await cleanupOps({ fetcher, clock, budgetMs: BUDGET_MS }))
  } catch (error) {
    handleApiError(response, error)
  }
}
