import { ApiError, queryValue, redirect, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { platformOn, readConfig, type EverywhereConfig, type LinearConfig } from "../config.js"
import type { DataKey } from "../crypto.js"
import { PLATFORM_HOSTS, platformFetch } from "../fetch.js"
import { installToken, OAUTH, type InstallRecord, type OAuthExchange } from "../identity.js"
import { linearApi } from "./client.js"
import { linearGrant, linearOAuth, parseLinearCredentials } from "./credentials.js"
import { linearId, linearObject } from "./verify.js"

export function linearExchange(config: LinearConfig, fetcher?: typeof fetch, now: () => number = Date.now): OAuthExchange {
  const exchange = async (code: string, app: boolean) => {
    const scopes = app ? OAUTH.linear.scopes.install : OAUTH.linear.scopes.link
    const credentials = linearGrant(await linearOAuth(config, { code, grant_type: "authorization_code", redirect_uri: OAUTH.linear.redirect }, fetcher), scopes, now())
    const me = await linearApi({ token: credentials.access, fetcher })("viewer")
    const viewer = linearObject(me.viewer)
    const organization = linearObject(viewer.organization).id
    if (!linearId(viewer.id) || !linearId(organization) || linearObject(me.organization).id !== organization ||
      viewer.app !== app || viewer.active !== true || viewer.guest !== false)
      throw new ApiError(400, "LINEAR_GRANT_INVALID", "Linear did not verify the requested identity.")
    return { credentials, viewer, organization }
  }
  return {
    install: async (code) => {
      const grant = await exchange(code, true)
      return { installation: `linear:${grant.organization}`, token: JSON.stringify(grant.credentials),
        scopes: OAUTH.linear.scopes.install, botUserId: String(grant.viewer.id), installer: { admin: true } }
    },
    link: async (code) => {
      const grant = await exchange(code, false)
      // Person-sign-in credentials are discarded. The account route links only the returned native ids.
      return { installation: `linear:${grant.organization}`, userId: String(grant.viewer.id), actor: { bot: false, external: false, guest: false } }
    },
  }
}

export async function revokeLinear(installation: string, record: InstallRecord, keys: readonly DataKey[], fetcher?: typeof fetch, beforeRequest?: () => Promise<void>): Promise<"confirmed" | "uncertain"> {
  if (!installation.startsWith("linear:")) return "uncertain"
  if (!beforeRequest) return "uncertain"
  const pair = parseLinearCredentials(installToken(keys, installation, record))
  if (!pair) return "uncertain"
  await beforeRequest?.()
  const response = await platformFetch("linear", new URL("/oauth/revoke", `https://${PLATFORM_HOSTS.linear[0]!.host}`), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: pair.refresh, token_type_hint: "refresh_token" }),
  }, fetcher)
  await response.body?.cancel().catch(() => undefined)
  return response.status === 200 ? "confirmed" : "uncertain"
}

/** No GET account authority: the original state is finished only by the bearer-authenticated account POST. */
export function linearOAuthCallback(config: () => EverywhereConfig = readConfig) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      if (!platformOn(config(), "linear")) { response.statusCode = 404; response.end(); return }
      const code = queryValue(request, "code")
      const state = queryValue(request, "state")
      if (!code || code.length > 1024 || !state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) { response.statusCode = 400; response.end(); return }
      response.setHeader("referrer-policy", "no-referrer")
      redirect(response, 303, `/everywhere#${new URLSearchParams({ platform: "linear", code, state })}`)
    } catch { response.statusCode = 400; response.end() }
  }
}
