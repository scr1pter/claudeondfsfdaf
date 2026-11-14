import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireVaultReader } from "../_lib/vault-api.js"
import { destroyVault, purgeVaults, vaultNotFound } from "../_lib/vault-store.js"

// Deleting reaches storage within the request (8 seconds at most); the cleanup finishes the rest.
export const maxDuration = 30

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultDelete(request, response)
}

/**
 * `DELETE /api/vault` (WP A44): deletes the account's vault, whatever the plan. The wrapped key and every version go
 * in one step, so nothing can be restored from the moment this answers; the encrypted objects are deleted from storage
 * now, and the daily cleanup finishes what one request cannot. Answers `{deleted: true}`, or 404 `VAULT_NOT_FOUND`.
 */
export async function handleVaultDelete(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "DELETE")
    const now = clock()
    const caller = await requireVaultReader(request, response, fetcher, now, "remove")
    if (!(await destroyVault(caller.account, { fetcher, now }))) throw vaultNotFound()
    await purgeVaults({ user: caller.account, budgetMs: 8_000, fetcher, clock }).catch(() => undefined)
    json(response, 200, { deleted: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
