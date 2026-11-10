import { requireAccountUser } from "../_lib/account.js"
import { mintCliToken } from "../_lib/cli-token.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  return handleCliToken(request, response)
}

/** Public copy/paste issuance stays unmarked regardless of any client or purpose in the request body. */
export async function handleCliToken(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  try {
    requireMethod(request, "POST")
    const user = await requireAccountUser(request, fetcher)
    json(response, 200, mintCliToken({ id: user.id, email: user.email }, now))
  } catch (error) {
    handleApiError(response, error)
  }
}
