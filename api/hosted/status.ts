import { handleHostedStatus } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 30

/** `GET /api/hosted/status` (WP A53): the cloud computer as the person's surfaces show it. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedStatus(request, response)
}
