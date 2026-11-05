import { requireInternalRequest } from "../_lib/hosted-internal.js"
import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeOpsReport, handleOpsReport, INCIDENT_LIMITS, type OpsReportOptions } from "../_lib/ops-incidents.js"

// The signature is checked over the raw body, so Vercel must not parse it first.
export const config = { api: { bodyParser: false } }
export const maxDuration = 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsWorkerReport(request, response)
}

/**
 * `POST /api/ops/worker` (WP A48): the ops Worker's reports (packages/ops-worker/src/protocol.ts `OpsReport`), signed
 * with A37's HMAC under the `ops` key; anything unsigned gets 401 before the body is read as JSON. Each event is taken
 * once, by its id (api/_lib/ops-incidents.ts): On Call's `monitor.down` and `monitor.up` open and resolve incidents and
 * alert the phone; Release Guard's `release.regressed` opens an incident and the one revert pull request; its
 * `release.passed` marks the release. A 2xx answer means every event in the report was taken; anything else and the
 * Worker sends the same events again later, and the ones already taken are not repeated.
 */
export async function handleOpsWorkerReport(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  options: Pick<OpsReportOptions, "github" | "alert"> = {},
) {
  try {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const started = Date.now()
    const now = clock()
    const body = await requireInternalRequest("ops", request, { now, fetcher, limit: 256 * 1024 })
    const report = decodeOpsReport(body)
    const result = await handleOpsReport(report, {
      fetcher,
      now,
      deadline: started + INCIDENT_LIMITS.reportBudgetMs,
      ...options,
    })
    json(response, 200, { ok: true, ...result })
  } catch (error) {
    handleApiError(response, error)
  }
}
