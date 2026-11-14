import { handleHostedJob } from "../../_lib/hosted-jobs-api.js"
import type { ApiRequest, ApiResponse } from "../../_lib/http.js"

export const maxDuration = 60

/** `GET|POST /api/hosted/jobs/:id` (WP A55): one Done by Morning job (or recurring job), and cancelling it. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedJob(request, response)
}
