import { handleCodiumOwner } from "../_lib/codium-owner-api.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 60
export default async function handler(request: ApiRequest, response: ApiResponse) {
  return handleCodiumOwner(request, response, "clear-risk")
}
