import { handleHostedJobApprove } from "../../../_lib/hosted-jobs-api.js"
import type { ApiRequest, ApiResponse } from "../../../_lib/http.js"

export const maxDuration = 30

/** `POST /api/hosted/jobs/:id/approve` (WP A55): answers the job's pull request to open; the server merges nothing. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedJobApprove(request, response)
}
