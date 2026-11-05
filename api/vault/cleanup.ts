import { timingSafeEqual } from "node:crypto"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { cleanupVaults, vaultStoreConfigured } from "../_lib/vault-store.js"

export const maxDuration = 60
const BUDGET_MS = 50_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultCleanup(request, response)
}

/**
 * The daily Brain Vault cleanup (contract §4.19, 03:40 UTC, `CRON_SECRET`): deletes read-only vaults 30 days after
 * their notice, sweeps uploads and versions that never committed an hour after their last request, prunes versions
 * older than the plan's version days (the newest is always kept), collects objects no version names, and deletes from
 * storage what all of that, forgetting and account deletion queued. It answers counts only. A run that cannot finish
 * leaves the rest for the next one. It cleans this server's Stripe mode only.
 */
export async function handleVaultCleanup(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the Brain Vault cleanup job.")
    if (!vaultStoreConfigured()) return json(response, 200, { enabled: false })
    json(response, 200, { enabled: true, ...(await cleanupVaults({ fetcher, clock, budgetMs: BUDGET_MS })) })
  } catch (error) {
    handleApiError(response, error)
  }
}
