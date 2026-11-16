import { afterAll, beforeAll, expect, test } from "bun:test"
import { createAccountApi } from "../../../api/_lib/everywhere/account-api"
import { readConfig } from "../../../api/_lib/everywhere/config"
import { finishOAuth, createState, installToken, OAUTH, readInstall } from "../../../api/_lib/everywhere/identity"
import { platformExchanges } from "../../../api/_lib/everywhere/oauth-exchanges"
import { slackExchange, slackOAuthCallback } from "../../../api/_lib/everywhere/slack/install"
import { FakeAccounts, RouteHarness, everywhereEnv, testAccount } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"

installFetchGuard()
const native = new FakeSlack()
const harness = new RouteHarness()
const accounts = new FakeAccounts()
beforeAll(async () => { native.start(); accounts.start(); await harness.start() })
afterAll(async () => { await native.stop(); await harness.stop(); await accounts.stop() })

async function fixture() {
  const f = await slackFixture()
  native.calls = []
  native.answer = undefined
  native.user = { id: "U0ALICE01", team_id: "T0123ABCD", is_bot: false, deleted: false, is_restricted: false, is_ultra_restricted: false, is_admin: true }
  native.grant = { app_id: f.config.slack!.appId, token_type: "bot", access_token: f.token, bot_user_id: "U0BOT0001",
    team: { id: "T0123ABCD" }, scope: OAUTH.slack.scopes.install.join(","), authed_user: { id: "U0ALICE01", access_token: "never-store-user-token" } }
  return f
}

test("OAuth exchange validates app, exact scopes and native installer, storing only the sealed bot token", async () => {
  const f = await fixture()
  const state = await createState(f.context(), { account: f.account, platform: "slack", purpose: "install", installation: f.installation })
  const result = await finishOAuth(f.context(), { account: f.account, code: "generated-code", state: state.state,
    exchanges: platformExchanges(f.config, native.fetch), platformOn: () => true })
  expect(result).toMatchObject({ purpose: "install", platform: "slack", installation: f.installation })
  const record = await readInstall(f.store, f.installation)
  expect(record && installToken(f.context().keys, f.installation, record)).toBe(f.token)
  expect(JSON.stringify(f.fake.commands)).not.toContain(f.token)
  expect(JSON.stringify(f.fake.commands)).not.toContain("never-store-user-token")
  expect(native.calls[0]).toMatchObject({ method: "oauth.v2.access", authorization: null, body: { redirect_uri: OAUTH.slack.redirect } })
  expect(native.calls[1]?.authorization).toBe(`Bearer ${f.token}`)
})

test("wrong app, excess scopes, rotation and unproved team identity fail before an installation is returned", async () => {
  for (const patch of [{ app_id: "AOTHER" }, { scope: `${OAUTH.slack.scopes.install.join(",")},users:read.email` }, { refresh_token: "unsupported" }, { expires_in: 3600 }]) {
    const f = await fixture()
    Object.assign(native.grant, patch)
    await expect(slackExchange(f.config.slack!, native.fetch).install!("generated-code", { account: f.account, platform: "slack", purpose: "install", issuedAt: f.fake.clock.now })).rejects.toMatchObject({ code: "SLACK_GRANT_INVALID" })
  }
  const f = await fixture()
  native.user.team_id = "TOTHER"
  await expect(slackExchange(f.config.slack!, native.fetch).install!("generated-code", { account: f.account, platform: "slack", purpose: "install", issuedAt: f.fake.clock.now })).rejects.toMatchObject({ code: "SLACK_GRANT_INVALID" })
})

test("OAuth callback redirects only to the fixed same-origin fragment and cannot exchange as an account", async () => {
  const f = await fixture()
  harness.mount({ "/oauth": slackOAuthCallback(() => f.config) })
  const url = new URL(`${harness.origin}/oauth`)
  url.searchParams.set("code", "generated-code")
  url.searchParams.set("state", "generated-state-123456789")
  const response = await fetch(url, { redirect: "manual" })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/everywhere#platform=slack&code=generated-code&state=generated-state-123456789")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(native.calls).toHaveLength(0)
})

test("default account API uses native exchange while mismatched account/state is consumed without a platform call", async () => {
  const f = await fixture()
  const env = everywhereEnv("slack")
  const config = readConfig(env)
  const alice = accounts.add(testAccount("slack-alice@example.invalid"))
  const bob = accounts.add(testAccount("slack-bob@example.invalid"))
  const context = { store: f.store, keys: config.dataKeys, now: f.fake.clock.now }
  const state = await createState(context, { account: alice.id, platform: "slack", purpose: "install" })
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    return url.hostname === "127.0.0.1" ? fetch(input, init) : native.fetch(input, init)
  }) as typeof fetch
  harness.use(createAccountApi({ env, store: f.store, now: () => f.fake.clock.now, fetcher, notify: async () => {} }))
  expect((await harness.call("POST", "/api/everywhere/oauth-finish", { token: bob.token, body: { code: "generated-code", state: state.state } })).status).toBe(403)
  expect(native.calls).toHaveLength(0)
  expect((await harness.call("POST", "/api/everywhere/oauth-finish", { token: alice.token, body: { code: "generated-code", state: state.state } })).status).toBe(400)
  const fresh = await createState(context, { account: alice.id, platform: "slack", purpose: "install" })
  const completed = await harness.call("POST", "/api/everywhere/oauth-finish", { token: alice.token, body: { code: "generated-code", state: fresh.state } })
  expect(completed.status).toBe(200)
  expect(completed.body).toMatchObject({ purpose: "install", installation: f.installation })
  expect(native.calls.map((call) => call.method)).toEqual(["oauth.v2.access", "users.info"])
})
