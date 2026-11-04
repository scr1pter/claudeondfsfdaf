import { handleModelPlanStatus } from "../_lib/model-plan-status.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"
// WP A42: the Remote meter (`meters.remote`) registers itself; status shows it while `remote` is listed.
import "../_lib/remote-meter.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanStatus(request, response)
}
