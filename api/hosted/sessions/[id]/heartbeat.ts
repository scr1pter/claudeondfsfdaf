import { handleHostedHeartbeat } from "../../../_lib/hosted-api.js"
import type { ApiRequest, ApiResponse } from "../../../_lib/http.js"
// A Done by Morning job's session also gets its recording links here (WP A55).
import "../../../_lib/hosted-jobs-runtime.js"

export const maxDuration = 30

/** `POST /api/hosted/sessions/:id/heartbeat` (WP A53): the computer's daemon, through the run-API host only. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedHeartbeat(request, response)
}
