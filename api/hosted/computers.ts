import { handleHostedComputers } from "../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 60

/** `GET|POST /api/hosted/computers` (WP A53): the account's computers, and deleting one with its disk. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedComputers(request, response)
}
