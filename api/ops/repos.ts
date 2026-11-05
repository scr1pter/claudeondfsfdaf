import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import {
  listOpsRepos,
  opsRateLimit,
  parseOpsRepo,
  readOpsBody,
  removeOpsRepo,
  requireOpsCaller,
  requireOpsCaps,
  saveOpsRepo,
} from "../_lib/ops-api.js"
import { requireOpsService } from "../_lib/ops-worker.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsRepos(request, response)
}

const REPO_FIELDS = ["repositoryId", "environment", "productionUrl", "paths", "releaseGuard", "shipDesk"] as const

/**
 * `/api/ops/repos` (WP A47): the repositories Release Guard and Ship Desk work in.
 *
 * - `GET`: the account's ops id (named in each repository's .vector/ops.json), whether repository bindings can be read
 *   yet, each repository's settings with whether it is still bound to the account, and the plan's path count. 240 an
 *   hour per account.
 * - `POST {repositoryId, environment, productionUrl?, paths?, releaseGuard, shipDesk}`: sets up a repository that is
 *   bound to the account (409 OPS_REPO_NOT_BOUND otherwise). `environment` is the deployment environment Release Guard
 *   watches (GitHub's name for it, such as Production). Release Guard needs `productionUrl` on a verified domain (403
 *   OPS_DOMAIN_UNVERIFIED); `paths` are joined to it, at most the plan's count. Answers the settings, the
 *   .vector/ops.json to commit (contract §4.15) and the URLs Release Guard will check. Needs the ops services and a plan
 *   with them.
 * - `DELETE {repositoryId}`: removes one, whatever the plan.
 *
 * Writes take 60 an hour per account.
 */
export async function handleOpsRepos(
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
      return json(response, 200, await listOpsRepos(caller.account, fetcher, now))
    }
    if (request.method !== "POST" && request.method !== "DELETE")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for this endpoint.")
    const body = await readOpsBody(request, request.method === "POST" ? REPO_FIELDS : ["repositoryId"])
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-write", caller.account, 60, fetcher)
    if (request.method === "DELETE")
      return json(response, 200, await removeOpsRepo(caller.account, body.repositoryId, fetcher, now))
    const input = parseOpsRepo(body)
    await requireOpsService(fetcher, now)
    const caps = await requireOpsCaps(caller.account, fetcher, now)
    json(response, 200, await saveOpsRepo(caller.account, input, caps, fetcher, now))
  } catch (error) {
    handleApiError(response, error)
  }
}
