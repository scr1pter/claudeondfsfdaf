import { handleHostedCron } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 60

/** The cloud computer's reaper (contract §4.19, every minute, `CRON_SECRET`; WP A53). */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedCron(request, response, "reaper", { budgetMs: 45_000 })
}
