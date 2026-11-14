import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  foundersPageUrl,
  foundersSlug,
  readFoundersName,
  readFoundingMember,
  setFoundersListing,
} from "../_lib/codium-founding.js"
import { readSnapshot } from "../_lib/codium-snapshot.js"
import { requireBillingUser } from "../_lib/model-plan-billing.js"
import { modelPlanOrigin } from "../_lib/model-plan-config.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleFoundingMembership(request, response)
}

/**
 * `GET|POST /api/account/founding` (WP A31): the signed-in account's founding membership, for the account page and
 * Settings, and its choice for the opt-in founders page. A website session or the desktop's account token, never a run
 * token. GET answers `{member: false}` or `{member: true, number, listed, name?, page}`, where `page` is the founders
 * page's address (by its random slug until it is public). POST `{listed, name?}` lists or unlists the founder, with an
 * optional display name; a frozen plan stays hidden whatever the choice.
 */
export async function handleFoundingMembership(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
) {
  try {
    if (request.method !== "GET" && request.method !== "POST") requireMethod(request, "GET")
    if (request.method === "POST") requireTrustedJsonRequest(request, 1024)
    const account = await requireBillingUser(request, fetcher)
    await enforceRateLimit(
      request,
      response,
      { scope: "codium-founding", identifier: account.id, limit: 30, windowSeconds: 3600, requirePersistent: true },
      fetcher,
    )
    if (request.method === "POST") {
      const body = await readJson<{ listed?: unknown; name?: unknown } | null>(request, 1024)
      if (
        typeof body?.listed !== "boolean" ||
        (body.name !== undefined && body.name !== null && typeof body.name !== "string")
      )
        throw new ApiError(400, "FOUNDERS_CHOICE_INVALID", "Choose whether to be listed on the founders page.")
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined
      const snapshot = await readSnapshot(account.id, fetcher)
      const changed = await setFoundersListing(
        account.id,
        { listed: body.listed, ...(name ? { name } : {}) },
        snapshot?.state === "frozen",
        fetcher,
      )
      if (!changed) throw new ApiError(404, "FOUNDING_MEMBER_REQUIRED", "Only founding members can choose this.")
    }
    json(response, 200, await foundingView(account.id, fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}

async function foundingView(account: string, fetcher: typeof fetch) {
  const member = await readFoundingMember(account, fetcher)
  if (!member || member.ended !== undefined) return { member: false }
  const name = await readFoundersName(account, fetcher)
  return {
    member: true,
    number: member.number,
    listed: member.listed,
    ...(name ? { name } : {}),
    page: foundersPageUrl(modelPlanOrigin(), await foundersSlug(fetcher)),
  }
}
