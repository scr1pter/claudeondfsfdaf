import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { readReportViews, validReportId } from "../_lib/support-reports.js"

/** The most ids one request may ask about; the desktop keeps fewer than this. */
export const MAX_REPORT_IDS = 100

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleSupportReports(request, response)
}

/**
 * `POST /api/support/reports {ids}` (WP A33): the status of each report the caller holds the id of. The id is the
 * only credential, so no sign-in is needed and the tracker stays free for everyone; the answer carries only the status,
 * when it last changed, and for a fix the release and commit. Ids without a record (never stored, older than 180 days,
 * or erased with their account) are left out. The ids travel in the body, never in the address.
 */
export async function handleSupportReports(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 8_000)
    await enforceRateLimit(request, response, { scope: "support-reports-ip", limit: 60, windowSeconds: 3600 }, fetcher)
    const body = await readJson<unknown>(request, 8_000)
    const ids = body && typeof body === "object" && !Array.isArray(body) ? (body as { ids?: unknown }).ids : undefined
    if (!Array.isArray(ids) || ids.length > MAX_REPORT_IDS || !ids.every(validReportId))
      throw new ApiError(400, "REPORT_IDS_INVALID", `Send up to ${MAX_REPORT_IDS} report ids.`)
    json(response, 200, { reports: await readReportViews(ids, fetcher) })
  } catch (error) {
    handleApiError(response, error)
  }
}
