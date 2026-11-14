import { handleHostedCron } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"
// Done by Morning's queue runs from the reaper (WP A55).
import "../_lib/hosted-jobs-runtime.js"

export const maxDuration = 60

/** The cloud computer's reaper (contract §4.19, every minute, `CRON_SECRET`; WP A53), with Done by Morning's queue (WP A55). */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedCron(request, response, "reaper", { budgetMs: 45_000 })
}
