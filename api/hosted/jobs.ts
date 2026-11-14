import { handleHostedJobs } from "../_lib/hosted-jobs-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 30

/** `GET|POST /api/hosted/jobs` (WP A55): Done by Morning's queue, queueing a job and saving a recurring job. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedJobs(request, response)
}
