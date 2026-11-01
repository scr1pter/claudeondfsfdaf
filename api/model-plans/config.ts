import { publicCodiumTiers, type PublicCodiumOptions } from "../_lib/codium-public.js"
import { handleApiError, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handlePublicCodiumConfig(request, response)
}

export async function handlePublicCodiumConfig(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  options: PublicCodiumOptions = {},
) {
  try {
    requireMethod(request, "GET")
    const body = await publicCodiumTiers(fetcher, options)
    response.statusCode = 200
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.setHeader("cache-control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30")
    response.end(JSON.stringify(body))
  } catch (error) {
    handleApiError(response, error)
  }
}
