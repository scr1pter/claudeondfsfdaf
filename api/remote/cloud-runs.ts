import { enforceRateLimit } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { remoteCloudRuns, requireRemoteCaller, type CloudRunReader } from "../_lib/remote-ticket.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRemoteCloudRuns(request, response)
}

/**
 * `GET /api/remote/cloud-runs?limit=` (WP A40): the account's newest runs of Vector's GitHub agent for the phone, from
 * the run records Codex's GitHub work keeps (registered at the integration commit, A59; until then `{runs: [],
 * available: false}`). They run in the user's own repo, on the user's own Actions minutes. Every paid plan includes
 * them, while the plan allows Remote (§4.4). The desktop app's own sign-in or a website session; 120 reads an hour per
 * account; at most 50 runs (20 by default).
 */
export async function handleRemoteCloudRuns(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  reader?: CloudRunReader,
) {
  try {
    requireMethod(request, "GET")
    const text = queryValue(request, "limit")
    const limit = text === undefined ? 20 : Number(text)
    if (!/^\d{1,2}$/.test(text ?? "20") || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ApiError(400, "REMOTE_RUNS_LIMIT", "Ask for between 1 and 50 runs.")
    const caller = await requireRemoteCaller(request, fetcher, clock())
    await enforceRateLimit(
      request,
      response,
      { scope: "remote-runs", identifier: caller.account, limit: 120, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    json(
      response,
      200,
      reader
        ? await remoteCloudRuns(caller.account, limit, fetcher, clock(), reader)
        : await remoteCloudRuns(caller.account, limit, fetcher, clock()),
    )
  } catch (error) {
    handleApiError(response, error)
  }
}
