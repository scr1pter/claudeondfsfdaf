import { handleHostedJobReport } from "../../../_lib/hosted-jobs-api.js"
import type { ApiRequest, ApiResponse } from "../../../_lib/http.js"

export const maxDuration = 30

/** `POST /api/hosted/jobs/:id/report` (WP A55): the job's session reports, through the run-API host only. */
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleHostedJobReport(request, response)
}
