import { handleModelPlanEstimate } from "../_lib/model-plan-estimate.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanEstimate(request, response)
}
