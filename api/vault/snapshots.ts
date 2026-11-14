import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireVaultReader, vaultReadState } from "../_lib/vault-api.js"
import { listVault, vaultNotFound } from "../_lib/vault-store.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultSnapshots(request, response)
}

/**
 * `GET /api/vault/snapshots` (WP A44): the committed versions, newest first, `{snapshots, usage: {usedBytes,
 * quotaBytes}, readOnly, deleteAt?}`. Bytes only, never an amount (P1). `readOnly` while the plan takes no uploads
 * (§4.4); `deleteAt` once an ended plan's notice set the day the vault is deleted. Sign-in only, whatever the plan.
 */
export async function handleVaultSnapshots(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "GET")
    const now = clock()
    const caller = await requireVaultReader(request, response, fetcher, now)
    const listed = await listVault(caller.account, { fetcher, now })
    if (!listed) throw vaultNotFound()
    const state = vaultReadState(caller.snapshot, now)
    json(response, 200, {
      snapshots: listed.snapshots,
      usage: { usedBytes: listed.usedBytes, quotaBytes: state.quotaBytes },
      readOnly: state.readOnly,
      ...(listed.deleteAt ? { deleteAt: listed.deleteAt } : {}),
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
