import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { opsRateLimit, readOpsBody, requireOpsCaller } from "../_lib/ops-api.js"
import { listIncidents, snoozeIncident, startIncidentFix, unsnoozeIncident } from "../_lib/ops-incidents.js"

export const maxDuration = 30

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsIncidents(request, response)
}

const FIELDS = ["id", "action", "hours", "repositoryId"] as const

/**
 * `/api/ops/incidents` (WP A48): On Call and Release Guard incidents, for the account's cards (A50 builds the screens).
 *
 * - `GET`: the newest incidents, each with what failed, any running snooze and, for a release, the commits the revert
 *   undoes, the migration paths it touches, and Undo: the revert pull request (merged by the person in GitHub, or in
 *   the desktop with their own GitHub sign-in), or, when Vector could not write, "open in GitHub" and the host's
 *   rollback link. 240 an hour per account.
 * - `POST {id, action: "snooze", hours}`: no alerts and no automatic revert for that URL, or that repository and
 *   environment, for 1 to 24 hours. `{id, action: "unsnooze"}` ends it.
 * - `POST {id, action: "fix", repositoryId?}`: "Fix it", a run of Vector's GitHub agent in the person's own repository,
 *   started only by this request (never on its own), within the plan's fix runs a day and one per incident.
 *
 * Callers: an unrevoked `vct_` account token or a website session; run tokens get 401 (S3). Writes take 60 an hour.
 */
export async function handleOpsIncidents(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    const now = clock()
    if (request.method === "GET") {
      const caller = await requireOpsCaller(request, fetcher, now)
      await opsRateLimit(request, response, "ops-read", caller.account, 240, fetcher)
      return json(response, 200, await listIncidents(caller.account, fetcher, now))
    }
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    const body = await readOpsBody(request, FIELDS)
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-write", caller.account, 60, fetcher)
    switch (body.action) {
      case "snooze":
        return json(response, 200, await snoozeIncident(caller.account, body.id, body.hours, fetcher, now))
      case "unsnooze":
        return json(response, 200, await unsnoozeIncident(caller.account, body.id, fetcher))
      case "fix":
        return json(
          response,
          200,
          await startIncidentFix(caller.account, body.id, { repositoryId: body.repositoryId }, fetcher, now),
        )
    }
    throw new ApiError(400, "OPS_INVALID", "Choose snooze, unsnooze or fix.")
  } catch (error) {
    handleApiError(response, error)
  }
}
