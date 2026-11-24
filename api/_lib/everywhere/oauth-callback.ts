import { redirect, requireMethod, type ApiRequest, type ApiResponse } from "../http.js"
import { platformOn, type EverywhereConfig } from "./config.js"
import { OAUTH_CODE } from "./identity.js"

/** The callback's output is a same-origin landing notice. The authenticated finish route owns OAuth exchange. */
export function createOAuthCallback(platform: "slack" | "linear", config: () => EverywhereConfig) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      if (!platformOn(config(), platform)) {
        response.statusCode = 404
        response.end()
        return
      }
      const search = new URL(request.url ?? "/", "https://vectordev.ai").searchParams
      const values = (key: string) => {
        if (search.has(key)) return search.getAll(key)
        const value = request.query?.[key]
        return typeof value === "string" ? [value] : (value ?? [])
      }
      const states = values("state")
      const codes = values("code")
      const errors = values("error")
      const state = states[0]
      if (states.length !== 1 || !state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
        response.statusCode = 400
        response.end()
        return
      }
      const fragment = new URLSearchParams({ platform })
      if (errors.length === 1 && errors[0] === "access_denied" && codes.length === 0) {
        fragment.set("error", "access_denied")
      } else if (errors.length === 0 && codes.length === 1 && codes[0] && OAUTH_CODE.test(codes[0])) {
        fragment.set("code", codes[0])
        fragment.set("state", state)
      } else {
        response.statusCode = 400
        response.end()
        return
      }
      response.setHeader("referrer-policy", "no-referrer")
      redirect(response, 303, `/everywhere#${fragment}`)
    } catch {
      response.statusCode = 400
      response.end()
    }
  }
}
