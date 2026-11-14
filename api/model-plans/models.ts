import "../_lib/hosted-run.js"
import { handleModelPlanModels } from "../_lib/model-plan-models.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanModels(request, response)
}
