import "../_lib/hosted-run.js"
import { handleModelPlanChat } from "../_lib/model-plan-chat.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export const maxDuration = 800
export const config = { api: { bodyParser: false } }
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanChat(request, response)
}
