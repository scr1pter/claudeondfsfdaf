import { handleHostedBudget } from "../../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../../_lib/http.js"

export const maxDuration = 30

/** `GET /api/hosted/admin/budget` (WP A53): the hosted team's worst case for the budget workflow (WP A56). */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedBudget(request, response)
}
