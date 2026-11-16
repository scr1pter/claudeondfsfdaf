import { expect, test } from "bun:test"
import { OAUTH } from "../../../api/_lib/everywhere/identity"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()
test("the importable Slack manifest requests exactly the intended events and scopes", async () => {
  const manifest = await Bun.file(new URL("../../../integrations/slack/manifest.json", import.meta.url)).json()
  expect(manifest.oauth_config.scopes.bot).toEqual([...OAUTH.slack.scopes.install])
  expect(manifest.oauth_config.redirect_urls).toEqual([OAUTH.slack.redirect])
  expect(manifest.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.im", "agent_session_stopped", "app_uninstalled", "tokens_revoked"])
  expect(manifest.features.agent_view.agent_description.split(/\s+/).length).toBeLessThanOrEqual(25)
  expect(manifest.settings.socket_mode_enabled).toBe(false)
  expect(manifest.settings.token_rotation_enabled).toBe(false)
  expect(manifest.settings.org_deploy_enabled).toBe(true)
  expect(manifest.settings.event_subscriptions.request_url.endsWith("/api/slack/events")).toBe(true)
  expect(manifest.settings.interactivity.request_url.endsWith("/api/slack/interactivity")).toBe(true)
})
