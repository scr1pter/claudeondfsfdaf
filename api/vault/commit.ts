import { requireTrustedJsonRequest } from "../_lib/abuse.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeCommit, requireVaultWriter } from "../_lib/vault-api.js"
import { commitVersion } from "../_lib/vault-store.js"

export const maxDuration = 60
// What a commit may spend HEADing the version's new objects; the rest of the minute is the store's.
const HEAD_BUDGET_MS = 40_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultCommit(request, response)
}

/**
 * `POST /api/vault/commit {version, objects}` (WP A44). The server HEADs every object signed for the version that has
 * not been confirmed yet, and its manifest. One that is missing or whose size differs from the declared one is deleted
 * and answered 409 `VAULT_SIZE_MISMATCH`; `objects` must equal how many objects the version declared. Answers
 * `{snapshot}`; committing again answers the same snapshot. A version too large to check within the minute keeps what
 * was confirmed and answers 503, and running the backup again finds those objects present. Write rules in
 * vault-api.ts.
 */
export async function handleVaultCommit(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 1_024)
    const writer = await requireVaultWriter(request, response, fetcher, clock())
    const body = decodeCommit(await readJson(request, 1_024))
    const snapshot = await commitVersion(
      writer.account,
      { version: body.version, objects: body.objects },
      { fetcher, clock, budgetMs: HEAD_BUDGET_MS },
    )
    json(response, 200, { snapshot })
  } catch (error) {
    handleApiError(response, error)
  }
}
