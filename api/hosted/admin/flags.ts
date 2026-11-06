import { handleHostedFlags } from "../../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../../_lib/http.js"

export const maxDuration = 30

/** `GET|POST /api/hosted/admin/flags` (WP A53, owner only): drain, stop, resume, and holds on single accounts. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedFlags(request, response)
}
