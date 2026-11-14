import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import {
  addOpsMonitor,
  listOpsMonitors,
  opsRateLimit,
  readOpsBody,
  removeOpsMonitor,
  requireOpsCaller,
  requireOpsCaps,
} from "../_lib/ops-api.js"
import { requireOpsService } from "../_lib/ops-worker.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsMonitors(request, response)
}

/**
 * `/api/ops/monitors` (WP A47): the account's On Call URLs.
 *
 * - `GET`: each URL with whether its domain is verified and whether the Worker checks it (on the plan's verified
 *   domains, among the plan's URLs, in the order added); the plan's URL count and check interval; whether the Worker has
 *   the current list. 240 an hour per account.
 * - `POST {url}`: adds an https URL on a verified domain (403 OPS_DOMAIN_UNVERIFIED otherwise), within the plan's URL
 *   count (429 OPS_LIMIT). The same URL again answers it unchanged. Needs the ops services, On Call listed and a plan
 *   with it.
 * - `DELETE {id}`: removes one, whatever the plan.
 *
 * Writes take 60 an hour per account. The Worker gets the new list after every change.
 */
export async function handleOpsMonitors(
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
      return json(response, 200, await listOpsMonitors(caller.account, fetcher, now))
    }
    if (request.method !== "POST" && request.method !== "DELETE")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for this endpoint.")
    const body = await readOpsBody(request, request.method === "POST" ? ["url"] : ["id"])
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-write", caller.account, 60, fetcher)
    if (request.method === "DELETE")
      return json(response, 200, await removeOpsMonitor(caller.account, body.id, fetcher, now))
    await requireOpsService(fetcher, now)
    const caps = await requireOpsCaps(caller.account, ["on-call"], fetcher, now)
    json(response, 200, await addOpsMonitor(caller.account, body.url, caps, fetcher, now))
  } catch (error) {
    handleApiError(response, error)
  }
}
