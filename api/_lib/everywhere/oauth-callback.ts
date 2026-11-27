import { redirect, requireMethod, type ApiRequest, type ApiResponse } from "../http.js"
import { platformOn, type EverywhereConfig } from "./config.js"
import { OAUTH_CODE } from "./identity.js"

const STATE = /^[A-Za-z0-9_-]{16,128}$/
// Only the short OAuth error token is read. error_description and error_uri are the platform's text and never shown.
const ERROR = /^[a-z_]{1,64}$/

/**
 * The Slack and Linear OAuth callback. It carries no account authority and never exchanges a code: it redirects to a
 * fixed /everywhere landing, and only the bearer-authenticated account POST finishes the original state.
 */
export function oauthCallback(platform: "slack" | "linear", config: () => EverywhereConfig) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      if (!platformOn(config(), platform)) { response.statusCode = 404; response.end(); return }
      const location = landing(platform, request)
      if (!location) { response.statusCode = 400; response.end(); return }
      response.setHeader("referrer-policy", "no-referrer")
      redirect(response, 303, location)
    } catch { response.statusCode = 400; response.end() }
  }
}

/** Where the callback sends the browser: built from fixed values and a checked code and state, or undefined for 400. */
function landing(platform: "slack" | "linear", request: ApiRequest) {
  const search = new URL(request.url ?? "/", "https://vectordev.ai").searchParams
  const values = (key: string) => {
    if (search.has(key)) return search.getAll(key)
    const value = request.query?.[key]
    return typeof value === "string" ? [value] : (value ?? [])
  }
  const codes = values("code")
  const states = values("state")
  const errors = values("error")
  if (codes.length > 1 || states.length > 1 || errors.length > 1) return undefined
  const code = codes[0]
  const state = states[0]
  const error = errors[0]
  // Cancelled (access_denied) or refused: a fixed notice. The state is left to expire on the server.
  if (error !== undefined) {
    if (code !== undefined || !ERROR.test(error)) return undefined
    return `/everywhere#${new URLSearchParams({ platform, error: error === "access_denied" ? "access_denied" : "other" })}`
  }
  if (!code || !OAUTH_CODE.test(code)) return undefined
  // A grant started in the platform's directory has no state Vector issued. Its code is dropped, never exchanged,
  // and the person starts again through an install that issues one (spec 3.8: sign in first, then finish).
  if (!state) return `/everywhere?install=${platform}`
  if (!STATE.test(state)) return undefined
  // The fixed same-origin landing page reads the fragment and submits through the authenticated account API.
  return `/everywhere#${new URLSearchParams({ platform, code, state })}`
}
