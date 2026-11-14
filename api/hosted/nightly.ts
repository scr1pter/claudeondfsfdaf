import { handleHostedCron } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 300

/** The cloud computer's nightly (contract §4.19, 02:30 UTC, `CRON_SECRET`; WP A53). */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedCron(request, response, "nightly", { budgetMs: 250_000 })
}
