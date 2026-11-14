import { enforceRateLimit } from "./_lib/abuse.js"
import { foundersBadge, foundersPage } from "./_lib/codium-founding.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "./_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleFoundersPage(request, response)
}

/**
 * `GET /api/founders` (WP A31): the opt-in founders page, every founder who chose to be listed, by number and the
 * display name they chose. Until `FOUNDING.publicAfter` (30) founders are listed it answers only with the page's random
 * slug (the `x-vector-founders` header, or `slug` for a badge image) and 404 otherwise. `?badge=<number>` answers that
 * founder's badge as SVG. Nothing here names an account, an email or a plan.
 */
export async function handleFoundersPage(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    await enforceRateLimit(
      request,
      response,
      { scope: "codium-founders-ip", limit: 240, windowSeconds: 3600 },
      fetcher,
    ).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "ABUSE_PROTECTION_UNAVAILABLE") return
      throw error
    })
    const header = request.headers["x-vector-founders"]
    const slug = (typeof header === "string" ? header : undefined) ?? queryValue(request, "slug")
    const page = await foundersPage(slug, fetcher)
    const cache = page.public ? "public, max-age=0, s-maxage=60, stale-while-revalidate=30" : "private, no-store"
    const badge = queryValue(request, "badge")
    if (badge !== undefined) {
      const founder = /^[1-9][0-9]{0,6}$/.test(badge)
        ? page.founders.find((item) => item.number === Number(badge))
        : undefined
      if (!founder) throw new ApiError(404, "FOUNDER_NOT_LISTED", "This founder is not listed.")
      response.statusCode = 200
      response.setHeader("content-type", "image/svg+xml; charset=utf-8")
      response.setHeader("x-content-type-options", "nosniff")
      response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      response.setHeader("cache-control", cache)
      response.end(foundersBadge(founder))
      return
    }
    if (!page.public) return json(response, 200, page)
    response.statusCode = 200
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.setHeader("cache-control", cache)
    response.end(JSON.stringify(page))
  } catch (error) {
    handleApiError(response, error)
  }
}
