import { publicModelPlans } from "../_lib/model-plan-config.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    // The perks every surface may show (§4.14). A27 lists them (`listedPerks`, `publicCodiumTiers`); none until then.
    json(response, 200, { ...publicModelPlans(), listed: [] })
  } catch (error) {
    handleApiError(response, error)
  }
}
