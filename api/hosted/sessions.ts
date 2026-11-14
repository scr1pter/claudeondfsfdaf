import { handleHostedSessions } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 60

/** `GET|POST /api/hosted/sessions` (WP A53): the account's cloud computer sessions, and starting one. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedSessions(request, response)
}
