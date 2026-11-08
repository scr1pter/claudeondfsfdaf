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
import { persistentStore } from "../_lib/persistent-store.js"
import { revocationConfigured, revokeAccountTokens } from "../_lib/revocation.js"
import { cancelModelPlanAccount } from "../_lib/model-plan-account.js"
import { forgetUsage } from "../_lib/usage.js"
import { closeCloudWorkspaces } from "../_lib/cloud-workspaces.js"

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
 *   3. revoke CLI tokens, which are stateless and would otherwise keep a
 *      terminal signed in for up to ninety days
 *   4. close model-plan checkout, subscriptions and inference access
 *   5. erase usage counts linked to the account, before the identity: once it
 *      is gone, an install's earlier unlinked days can no longer be found
 *   6. delete the identity itself
 *
 * The response says which of those actually happened.
 */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_096)
    const body = await readJson<{ confirm?: unknown }>(request, 4_096)
    const grant = /^Bearer (vdg_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
    const user = grant ? await requireUnusedGrant(grant) : await requireAccountUser(request)
    await enforceRateLimit(request, response, {
      scope: "account-delete",
      identifier: user.id,
      limit: 5,
      windowSeconds: 60 * 60,
    })

    const confirm = typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : ""
    if (!confirm || confirm !== user.email.trim().toLowerCase()) {
      throw new ApiError(
        400,
        "CONFIRMATION_MISMATCH",
        "Type the email address on this account to confirm you want it deleted.",
      )
    }

    const admin = adminConfiguration()
    if (!admin) {
      throw new ApiError(
        503,
        "DELETION_NOT_CONFIGURED",
        "Account deletion is not configured on this deployment. Nothing was changed; write to support and it will be done by hand.",
      )
    }

    const tokensRevoked = await revokeAccountTokens(user.id)
    if (revocationConfigured() && !tokensRevoked)
      throw new ApiError(503, "REVOCATION_FAILED", "Account access could not be revoked. Retry account deletion.")
    await closeCloudWorkspaces(user.id).catch(() => {
      throw new ApiError(503, "WORKSPACE_DELETION_FAILED", "Cloud workspace access could not be closed. Retry account deletion.")
    })
    await cancelModelPlanAccount(user.id).catch(() => {
      throw new ApiError(
        503,
        "BILLING_DELETION_FAILED",
        "Model billing cleanup could not finish. Retry account deletion.",
      )
    })
    const usageForgotten = await forgetUsage(user.id)
    await deleteAccountUser(admin, user.id)
    // Only a finished deletion uses the grant up, so a step that failed can be retried with the same confirmation.
    if ("jti" in user)
      await persistentStore(["SET", grantKey(user.jti), "1", "EX", String(GRANT_RECORD_SECONDS), "NX"]).catch(
        () => undefined,
      )

    json(response, 200, {
      deleted: true,
      email: user.email,
      cliTokens: tokensRevoked ? "revoked" : revocationConfigured() ? "revocation-failed" : "expire-within-90-days",
      // Linked days also go with the identity through the database's foreign keys.
      usageCounts: usageForgotten ? "deleted" : "deletion-failed",
    })
  } catch (error) {
    handleApiError(response, error)
  }
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

function adminConfiguration() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  return url && serviceRole ? { url, serviceRole } : undefined
}

async function deleteAccountUser(
  admin: { url: string; serviceRole: string },
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const result = await fetcher(`${admin.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      apikey: admin.serviceRole,
      authorization: `Bearer ${admin.serviceRole}`,
    },
  })
  if (!result.ok && result.status !== 404) {
    throw new ApiError(
      502,
      "DELETION_FAILED",
      "Model billing was closed, but Vector could not delete the identity. Retry account deletion.",
    )
  }
}

export const __test = { adminConfiguration, deleteAccountUser }
