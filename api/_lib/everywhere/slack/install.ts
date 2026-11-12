import { ApiError, queryValue, redirect, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { platformOn, readConfig, type EverywhereConfig, type SlackConfig } from "../config.js"
import { installToken, OAUTH, type InstallRecord, type OAuthExchange } from "../identity.js"
import type { DataKey } from "../crypto.js"
import { createSlackClient } from "./client.js"
import { slackId, slackObject } from "./verify.js"

export function slackExchange(config: SlackConfig, fetcher?: typeof fetch): OAuthExchange {
  return { install: async (code) => {
    const grant = await createSlackClient({ fetcher })("oauth.v2.access", { code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: OAUTH.slack.redirect })
    const team = slackObject(grant.team)
    const enterprise = slackObject(grant.enterprise)
    const user = slackObject(grant.authed_user)
    const organization = grant.is_enterprise_install === true
    const scopes = typeof grant.scope === "string" ? grant.scope.split(",").filter(Boolean) : []
    const required = OAUTH.slack.scopes.install
    if (grant.app_id !== config.appId || grant.token_type !== "bot" || typeof grant.access_token !== "string" ||
      !slackId(grant.bot_user_id) || !slackId(user.id) || (!organization && !slackId(team.id)) ||
      (organization && !slackId(enterprise.id)) || grant.refresh_token !== undefined || grant.expires_in !== undefined ||
      scopes.length !== required.length || required.some((scope) => !scopes.includes(scope)))
      throw new ApiError(400, "SLACK_GRANT_INVALID", "Slack did not return the requested installation.")
    const token = grant.access_token
    const result = await createSlackClient({ token, fetcher })("users.info", { user: user.id })
    const installer = slackObject(result.user)
    if (installer.id !== user.id || installer.is_bot === true || installer.deleted === true || installer.is_restricted === true || installer.is_ultra_restricted === true)
      throw new ApiError(400, "SLACK_GRANT_INVALID", "Slack did not verify the installer.")
    const grid = slackObject(installer.enterprise_user)
    if (organization ? grid.enterprise_id !== enterprise.id : installer.team_id !== team.id &&
      !(grid.enterprise_id === enterprise.id && Array.isArray(grid.teams) && grid.teams.includes(team.id)))
      throw new ApiError(400, "SLACK_GRANT_INVALID", "Slack did not verify the installation workspace.")
    return { installation: organization ? `slack:${enterprise.id}` : slackId(enterprise.id) ? `slack:${enterprise.id}:${team.id}` : `slack:${team.id}`,
      token, scopes, botUserId: grant.bot_user_id, installer: { userId: user.id,
        admin: organization ? grid.is_admin === true || grid.is_owner === true : installer.is_admin === true || installer.is_owner === true } }
  } }
}

export async function revokeSlack(installation: string, record: InstallRecord, keys: readonly DataKey[], fetcher?: typeof fetch) {
  if (!installation.startsWith("slack:")) return
  const token = installToken(keys, installation, record)
  if (token) await createSlackClient({ token, fetcher })("auth.revoke", {})
}

/** The callback carries no account authority. Exchange only after a signed-in bearer POST with the original state. */
export function slackOAuthCallback(config: () => EverywhereConfig = readConfig) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      if (!platformOn(config(), "slack")) { response.statusCode = 404; response.end(); return }
      const code = queryValue(request, "code")
      const state = queryValue(request, "state")
      if (!code || code.length > 2048 || !state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) { response.statusCode = 400; response.end(); return }
      response.setHeader("referrer-policy", "no-referrer")
      // The fixed same-origin landing page reads the fragment and submits through the authenticated account API.
      redirect(response, 303, `/everywhere#${new URLSearchParams({ platform: "slack", code, state })}`)
    } catch { response.statusCode = 400; response.end() }
  }
}
