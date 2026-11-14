import { requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeSetup, requireVaultReader, requireVaultWriter } from "../_lib/vault-api.js"
import { readVault, setupVault, vaultNotFound } from "../_lib/vault-store.js"

const BODY_BYTES = 8_192

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultSetup(request, response)
}

/**
 * `GET|POST /api/vault/setup` (WP A44).
 * - `GET` answers the account's vault `{vault, key, createdAt}`: the vault key wrapped under the recovery code, which
 *   only the code opens, so another computer can restore. 404 `VAULT_NOT_FOUND` without one. Sign-in only.
 * - `POST {vault, key}` creates the vault once, under the write rules (vault-api.ts). The same vault id again answers
 *   the stored vault; another id gets 409 `VAULT_EXISTS`.
 */
export async function handleVaultSetup(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    if (request.method === "GET") {
      const caller = await requireVaultReader(request, response, fetcher, clock())
      const vault = await readVault(caller.account, { fetcher, now: clock() })
      if (!vault) throw vaultNotFound()
      return json(response, 200, { vault: vault.vault, key: vault.key, createdAt: vault.createdAt })
    }
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, BODY_BYTES)
    const writer = await requireVaultWriter(request, response, fetcher, clock())
    const body = decodeSetup(await readJson(request, BODY_BYTES))
    const created = await setupVault(
      writer.account,
      { vault: body.vault, key: body.key, versionDays: writer.versionDays },
      { fetcher, now: clock() },
    )
    if (created === "exists")
      throw new ApiError(409, "VAULT_EXISTS", "Your account already holds another vault. Restore it with its recovery code.")
    json(response, 200, created)
  } catch (error) {
    handleApiError(response, error)
  }
}
