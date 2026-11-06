import { requireAccountUser } from "./account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { verifyDesktopToken } from "./cli-token.js"
import { modelPlanChange, modelPlanCheckout, modelPlanPortal } from "./model-plan-account.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import { modelPlansEnabled, requireModelPlans } from "./model-plan-config.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

/**
 * The account a Codium status or billing request acts for. The website signs in with a browser session. The desktop
 * app's main process holds the signed Vector account token instead, verified and checked against revocation exactly
 * as model requests are, so it can open checkout and the billing portal in its own window. The portal takes only the
 * desktop's own token (`desktop`), never one pasted into a terminal, since it can charge the saved card and change
 * the billing email. Deleting the account never accepts any of these tokens (see api/account/delete.ts).
 */
export async function requireBillingUser(
  request: ApiRequest,
  fetcher: typeof fetch = fetch,
  options: { desktop?: boolean } = {},
) {
  const authorization = String(request.headers.authorization ?? "")
  if (!/^Bearer vct_/.test(authorization)) return requireAccountUser(request, fetcher)
  const account = await requireModelPlanUser(request, fetcher)
  if (options.desktop) verifyDesktopToken(authorization.slice("Bearer ".length))
  return account
}

export async function handleModelPlanCheckout(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    requireModelPlans()
    const account = await requireBillingUser(request, fetcher)
    await enforceRateLimit(request, response, {
      scope: "model-plan-checkout",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const body = await readJson<{ plan?: unknown }>(request, 4096)
    if (typeof body.plan !== "string")
      throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Vector model plan.")
    json(response, 200, await modelPlanCheckout(account, body.plan, fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `/api/model-plans/topup`. Codium sells monthly plans only, so the route that sold top-ups answers every request, from
 * any caller and with any method, with JSON 410 `MODEL_TOPUP_REMOVED`. It reads nothing, calls no service and sells
 * nothing; an older Vector that still offers a top-up shows the message instead of a bare 404.
 */
export function handleModelTopupRemoved(_request: ApiRequest, response: ApiResponse) {
  handleApiError(
    response,
    new ApiError(
      410,
      "MODEL_TOPUP_REMOVED",
      "Vector Codium no longer sells top-ups. Choose or change a monthly plan instead.",
    ),
  )
}

export async function handleModelPlanPortal(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    // Keep cancellation reachable even when new model requests are disabled.
    if (!modelPlansEnabled() && !process.env.STRIPE_SECRET_KEY)
      throw new ApiError(503, "BILLING_UNAVAILABLE", "Billing is temporarily unavailable.")
    const account = await requireBillingUser(request, fetcher, { desktop: true })
    await enforceRateLimit(request, response, {
      scope: "model-plan-portal",
      identifier: account.id,
      limit: 20,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    // Home and payment/cancellation flows remain reachable while sales are paused; old change requests get 409.
    const flow = (await readJson<{ flow?: unknown } | null>(request, 4096))?.flow
    if (flow !== undefined && flow !== "change" && flow !== "cancel" && flow !== "payment_method_update")
      throw new ApiError(400, "BILLING_FLOW_INVALID", "Choose payment-method updates or cancellation.")
    json(response, 200, await modelPlanPortal(account.id, fetcher, { flow }))
  } catch (error) {
    handleApiError(response, error)
  }
}

/** Plan changes spend only for the signed-in web account or the desktop's own token. */
export async function handleModelPlanChange(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    if (request.method !== "POST" && request.method !== "DELETE") requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    // Undoing a scheduled downgrade remains available when sales or the gateway is paused.
    const account = await requireBillingUser(request, fetcher, { desktop: true })
    await enforceRateLimit(request, response, {
      scope: "model-plan-change",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    if (request.method === "DELETE") {
      json(response, 200, await modelPlanChange(account, undefined, fetcher))
      return
    }
    requireModelPlans()
    const body = await readJson<{ plan?: unknown }>(request, 4096)
    if (typeof body?.plan !== "string")
      throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Codium subscription.")
    json(response, 200, await modelPlanChange(account, body.plan, fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}
