import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { verifyDeletionGrant } from "../_lib/cli-token.js"
import {
  deleteAccountIdentity,
  finishAccountDeletion,
  identityAdmin,
  type DeletionOptions,
} from "../_lib/codium-erase.js"
import type { DeletionStage } from "../_lib/codium-tombstone.js"
import { markAccountDeleting } from "../_lib/codium-tombstone.js"
import { persistentStore } from "../_lib/persistent-store.js"

/**
 * Deleting a Vector account, from the website with its browser session or from
 * the desktop app with a deletion grant (see cli-token.ts), which needs a sign-in
 * from the last ten minutes. The desktop's long-lived account token is never
 * enough: it is stored on the machine and carries the email to type. The order
 * matters, because the steps are not equally reversible:
 *
 *   1. confirm the person typed their own email, so a stray click cannot do this
 *   2. check the Supabase admin key exists BEFORE destroying anything, so a
 *      misconfigured deployment fails with nothing half-done
 *   3. set the tombstone (WP A57, codium-tombstone.ts): from here every Codium
 *      path refuses the account, and an unfinished deletion is finished by the
 *      cleanup cron, so nothing below is left half-done for good
 *   4. revoke CLI and desktop tokens, which are stateless and would otherwise
 *      keep a terminal signed in for up to ninety days, then close the
 *      account's cloud workspaces on their host (best effort here; step 5
 *      records it), then close the account's Codium snapshot, then cancel
 *      model-plan checkout, subscriptions and keys
 *   5. erase every Codium and hosted record (codium-erase.ts), the cloud
 *      workspaces' close first, and write the erase marker
 *   6. erase usage counts linked to the account, before the identity: once it
 *      is gone, an install's earlier unlinked days can no longer be found
 *   7. delete the identity itself, which waits for the erase marker
 *
 * The response says which of those actually happened. A step that fails after the
 * tombstone answers an error that says the deletion has started and Vector will
 * finish it; retrying with the same confirmation continues it.
 */
export const maxDuration = 60
// Erase parts not started by then are left for the cleanup cron, so the answer comes back inside the time limit and,
// usually, inside the desktop app's 30-second wait (main/vector-account.ts).
const ERASE_BUDGET_MS = 20_000
// The cleanup cron picks a deletion up this long after the request, if the request never finished it.
const CRON_PICKUP_MS = 5 * 60_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleAccountDelete(request, response)
}

export async function handleAccountDelete(
  request: ApiRequest,
  response: ApiResponse,
  options: DeletionOptions & { verifyUser?: (request: ApiRequest) => Promise<{ id: string; email: string }> } = {},
) {
  try {
    const started = Date.now()
    const fetcher = options.fetcher ?? fetch
    const clock = options.clock ?? Date.now
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_096)
    const body = await readJson<{ confirm?: unknown }>(request, 4_096)
    const grant = /^Bearer (vdg_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
    const user = options.verifyUser
      ? await options.verifyUser(request)
      : grant
        ? await requireUnusedGrant(grant)
        : await requireAccountUser(request)
    await enforceRateLimit(
      request,
      response,
      { scope: "account-delete", identifier: user.id, limit: 5, windowSeconds: 60 * 60 },
      fetcher,
    )

    const confirm = typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : ""
    if (!confirm || confirm !== user.email.trim().toLowerCase()) {
      throw new ApiError(
        400,
        "CONFIRMATION_MISMATCH",
        "Type the email address on this account to confirm you want it deleted.",
      )
    }

    if (!identityAdmin()) {
      throw new ApiError(
        503,
        "DELETION_NOT_CONFIGURED",
        "Account deletion is not configured on this deployment. Nothing was changed; write to support and it will be done by hand.",
      )
    }

    if (storeConfigured()) {
      const now = clock()
      await markAccountDeleting(user.id, now, now + CRON_PICKUP_MS, fetcher).catch(() => {
        throw new ApiError(
          503,
          "DELETION_UNAVAILABLE",
          "Account deletion is temporarily unavailable. Nothing was changed; retry account deletion.",
        )
      })
    }

    const outcome = await finishAccountDeletion(user.id, {
      ...options,
      fetcher,
      clock,
      deadline: started + ERASE_BUDGET_MS,
    })
    if (outcome.state === "busy")
      throw new ApiError(
        409,
        "ACCOUNT_DELETION_IN_PROGRESS",
        "Your account is already being deleted. Try again in a minute.",
        {
          retryAfterSeconds: 60,
        },
      )
    if (outcome.state === "pending") throw pendingError(outcome.stage)
    if (outcome.state !== "deleted") throw pendingError("check")
    // Only a finished deletion uses the grant up, so a step that failed can be retried with the same confirmation.
    if ("jti" in user && typeof user.jti === "string")
      await persistentStore(["SET", grantKey(user.jti), "1", "EX", String(GRANT_RECORD_SECONDS), "NX"], fetcher).catch(
        () => undefined,
      )

    json(response, 200, {
      deleted: true,
      email: user.email,
      cliTokens: outcome.tokens,
      // Linked days also go with the identity through the database's foreign keys.
      usageCounts: outcome.usage,
      codium: "erased",
    })
  } catch (error) {
    handleApiError(response, error)
  }
}

/** What a deletion that started but did not finish answers, by the step that stopped it. Vector finishes it anyway. */
function pendingError(stage: DeletionStage) {
  const detail = { pending: true, stage }
  if (stage === "revoke")
    return new ApiError(
      503,
      "REVOCATION_FAILED",
      "Deletion has started, but account access could not be revoked yet. Vector keeps trying and finishes the deletion by itself, or you can retry account deletion.",
      { detail, retryAfterSeconds: 60 },
    )
  if (stage === "close" || stage === "billing")
    return new ApiError(
      503,
      "BILLING_DELETION_FAILED",
      "Deletion has started, but model billing cleanup could not finish yet. Vector keeps trying and finishes the deletion by itself, or you can retry account deletion.",
      { detail, retryAfterSeconds: 60 },
    )
  if (stage === "identity")
    return new ApiError(
      502,
      "DELETION_FAILED",
      "Your records are erased, but Vector could not delete the account itself yet. Vector keeps trying, or you can retry account deletion.",
      { detail, retryAfterSeconds: 60 },
    )
  return new ApiError(
    503,
    "ACCOUNT_ERASE_PENDING",
    "Deletion has started and Vector Codium is closed for this account, but some records could not be erased yet. Vector keeps trying and deletes the account once they are, or you can retry account deletion.",
    { detail, retryAfterSeconds: 60 },
  )
}

function storeConfigured() {
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  return Boolean(url && token)
}

// Longer than a grant's ten minutes, so a used grant stays refused until it has expired anyway.
const GRANT_RECORD_SECONDS = 15 * 60

async function requireUnusedGrant(grant: string) {
  const verified = verifyDeletionGrant(grant)
  if (await persistentStore(["GET", grantKey(verified.jti)]))
    throw new ApiError(
      401,
      "DELETION_GRANT_USED",
      "This confirmation was already used. Confirm with your Vector sign-in again.",
    )
  return verified
}

function grantKey(jti: string) {
  return `vector:deletion-grant:${jti}`
}

export const __test = { adminConfiguration: identityAdmin, deleteAccountUser: deleteAccountIdentity }
