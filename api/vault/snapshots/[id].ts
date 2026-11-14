import { requireTrustedJsonRequest } from "../../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  type ApiRequest,
  type ApiResponse,
} from "../../_lib/http.js"
import { decodeDownloads, requireVaultReader, versionParam } from "../../_lib/vault-api.js"
import { downloadLinks, forgetVersion, purgeVaults, readVersion } from "../../_lib/vault-store.js"

const BODY_BYTES = 80_000

// Deleting reaches storage within the request (8 seconds at most); the cleanup finishes the rest.
export const maxDuration = 30

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultSnapshot(request, response)
}

/**
 * `/api/vault/snapshots/:id` (WP A44), one committed version, sign-in only and whatever the plan, so a paused or ended
 * plan can still restore (§4.4):
 * - `GET` answers `{snapshot, manifest: {url}}`, a GET link to its manifest valid 900 seconds;
 * - `POST {objects ≤1000}` answers `{downloads: [{id, url}]}` for the objects asked for that this version names;
 * - `DELETE` forgets it. What no other version names stops counting against the quota at once and is deleted from
 *   storage. Answers `{forgotten: true}`.
 * 404 `VAULT_NOT_FOUND` for a version that is not committed.
 */
export async function handleVaultSnapshot(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    const method = request.method
    if (method !== "GET" && method !== "POST" && method !== "DELETE")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for this endpoint.")
    if (method === "POST") requireTrustedJsonRequest(request, BODY_BYTES)
    const version = versionParam(queryValue(request, "id"))
    const now = clock()
    const caller = await requireVaultReader(request, response, fetcher, now, method === "DELETE" ? "remove" : "read")
    const missing = new ApiError(404, "VAULT_NOT_FOUND", `No backup version ${version}.`)
    if (method === "GET") {
      const found = await readVersion(caller.account, version, { fetcher, now })
      if (!found) throw missing
      return json(response, 200, found)
    }
    if (method === "POST") {
      const body = decodeDownloads(await readJson(request, BODY_BYTES))
      const downloads = await downloadLinks(caller.account, version, body.objects, { fetcher, now })
      if (!downloads) throw missing
      return json(response, 200, { downloads })
    }
    if (!(await forgetVersion(caller.account, version, { fetcher, now }))) throw missing
    await purgeVaults({ user: caller.account, budgetMs: 8_000, fetcher, clock }).catch(() => undefined)
    json(response, 200, { forgotten: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
