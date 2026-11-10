import { handleModelTopupRemoved } from "../_lib/model-plan-billing.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

// Top-ups were removed (WP A04): every request here answers JSON 410 MODEL_TOPUP_REMOVED.
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelTopupRemoved(request, response)
}
