import { handleCloudWorkspaces } from "./_lib/cloud-workspaces.js"
import type { ApiRequest, ApiResponse } from "./_lib/http.js"

export const config = { api: { bodyParser: false } }
export const maxDuration = 35

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleCloudWorkspaces(request, response)
}
