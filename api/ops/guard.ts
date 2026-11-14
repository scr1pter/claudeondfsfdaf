import { timingSafeEqual } from "node:crypto"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { runOpsGuard, type OpsGuardInput } from "../_lib/ops-guard.js"

export const maxDuration = 60
const BUDGET_MS = 45_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsGuard(request, response)
}

/**
 * The ops guard (contract §4.19, every 10 minutes, `CRON_SECRET`; WP A50): compares the ops Worker's month on
 * Cloudflare with a budget grown from the Max and Ultra subscribers it serves, emails the owner at 75%, and at 100%
 * holds only the accounts using more than their own plan explains (api/_lib/ops-guard.ts). It answers counts and a share
 * only, never a dollar figure.
 */
export async function handleOpsGuard(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  options: Pick<OpsGuardInput, "spend"> = {},
) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the ops guard job.")
    json(response, 200, await runOpsGuard({ fetcher, clock, budgetMs: BUDGET_MS, ...options }))
  } catch (error) {
    handleApiError(response, error)
  }
}
