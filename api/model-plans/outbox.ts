import { timingSafeEqual } from "node:crypto"
import { drainOutbox } from "../_lib/codium-provision.js"
import { queueCollectionSweep } from "../_lib/codium-collection.js"
// Registers the `finalize-renewal` action this cron runs (contract §4.4).
import "../_lib/codium-renewal.js"
// Registers `model-settle`: a model settlement whose answer was lost twice is retried here.
import "../_lib/model-plan-admit.js"
import { drainDebitApplies } from "../_lib/model-plan-account.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const maxDuration = 60
// The outbox gets most of the minute; pool debits waiting to be applied get what is left of it.
const OUTBOX_BUDGET_MS = 40_000
const TOTAL_BUDGET_MS = 50_000

/**
 * The minute outbox cron (contract §4.19): runs the provisioners' and actions' queued work (codium-provision.ts), then
 * the pool debits still waiting to lower a key's limit. It answers counts only, never an account or an amount. Until a
 * Stripe key is configured, reconcile cannot run, nothing can be queued, and the cron touches nothing.
 */
export default async function handler(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the Codium outbox job.")
    if (!process.env.STRIPE_SECRET_KEY?.trim()) return json(response, 200, { enabled: false })
    const started = Date.now()
    await queueCollectionSweep(fetcher, started)
    const outbox = await drainOutbox({ budgetMs: OUTBOX_BUDGET_MS, fetcher })
    // Another drain holds the lock and runs the debits after it.
    const debits = outbox.busy
      ? { applied: 0, retried: 0 }
      : await drainDebitApplies({ fetcher, budgetMs: Math.max(0, TOTAL_BUDGET_MS - (Date.now() - started)) })
    json(response, 200, { enabled: true, outbox, debits })
  } catch (error) {
    handleApiError(response, error)
  }
}
