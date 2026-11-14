import { handleHostedSessionAction } from "../../../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../../../_lib/http.js"

export const maxDuration = 60

/** `/api/hosted/sessions/:id/download` (WP A53; see handleHostedSessionAction). */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedSessionAction(request, response, "download")
}
