import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { seal } from "../../../api/_lib/everywhere/crypto"
import { eraseInstallation } from "../../../api/_lib/everywhere/erase"
import { createState, findLink, finishOAuth, installToken, OAUTH, readInstallSnapshot, recordInstall } from "../../../api/_lib/everywhere/identity"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { platformExchanges } from "../../../api/_lib/everywhere/oauth-exchanges"
import { setJson } from "../../../api/_lib/everywhere/store"
import { linearAccess, parseLinearCredentials } from "../../../api/_lib/everywhere/linear/credentials"
import { linearExchange, linearOAuthCallback } from "../../../api/_lib/everywhere/linear/install"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeLinear, linearFixture } from "./lib/everywhere-linear"

installFetchGuard()
const native = new FakeLinear()
const harness = new RouteHarness()
beforeAll(async () => { native.start(); await harness.start() })
afterAll(async () => { await harness.stop(); await native.stop() })

async function expired() {
  const f = await linearFixture(native)
  await setJson(f.store, everywhereKeys.install(f.installation), { ...f.snapshot.record,
    tokenEnc: seal(f.context().keys, JSON.stringify({ ...f.pair, expiresAt: f.fake.clock.now - 1 }), everywhereKeys.install(f.installation)) })
  const access = () => linearAccess({ context: f.context, installation: f.installation, config: f.config.linear!, fetcher: native.fetch })
  return { ...f, access }
}

test("native app OAuth stores a sealed rotating pair and its per-installation viewer id", async () => {
  const f = await linearFixture(native)
  const state = await createState(f.context(), { account: f.account, platform: "linear", purpose: "install", installation: f.installation })
  const result = await finishOAuth(f.context(), { account: f.account, state: state.state, code: "generated-code",
    exchanges: platformExchanges(f.config, native.fetch, () => f.fake.clock.now), platformOn: () => true })
  expect(result).toMatchObject({ purpose: "install", installation: f.installation })
  const current = await readInstallSnapshot(f.store, f.installation)
  expect(current?.record.botUserId).toBe(native.bot)
  expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))).toMatchObject({ access: native.token, refresh: native.refresh })
  expect(JSON.stringify(f.fake.commands)).not.toContain(native.token)
  expect(JSON.stringify(f.fake.commands)).not.toContain(native.refresh)
  expect(native.calls[0]).toMatchObject({ operation: "oauth", authorization: null, variables: { grant_type: "authorization_code", redirect_uri: OAUTH.linear.redirect } })
})

test("person sign-in links the native viewer and discards its credentials", async () => {
  const f = await linearFixture(native)
  const person = `person-${randomBytes(24).toString("hex")}`
  native.grant = { ...native.grant, access_token: person, scope: "read" }
  native.viewers.set(person, { id: native.user, app: false, active: true, guest: false, organization: { id: native.organization } })
  const state = await createState(f.context(), { account: f.account, platform: "linear", purpose: "link", installation: f.installation })
  await finishOAuth(f.context(), { account: f.account, state: state.state, code: "generated-person-code",
    exchanges: platformExchanges(f.config, native.fetch, () => f.fake.clock.now), platformOn: () => true })
  expect(await findLink(f.store, f.installation, native.user)).toMatchObject({ account: f.account })
  expect(JSON.stringify(f.fake.commands)).not.toContain(person)
  expect((await readInstallSnapshot(f.store, f.installation))?.record.revision).toBe(f.snapshot.record.revision)
})

test("missing refresh token, excess scope or a guest/app identity cannot finish person linking", async () => {
  const f = await linearFixture(native)
  for (const patch of [{ refresh_token: undefined }, { scope: "read write admin" }]) {
    native.grant = { token_type: "Bearer", access_token: native.token, refresh_token: native.refresh, expires_in: 86400, scope: "read", ...patch }
    await expect(linearExchange(f.config.linear!, native.fetch, () => f.fake.clock.now).link!("generated", {
      account: f.account, platform: "linear", purpose: "link", issuedAt: f.fake.clock.now,
    })).rejects.toMatchObject({ code: "LINEAR_GRANT_INVALID" })
  }
  native.grant = { token_type: "Bearer", access_token: native.token, refresh_token: native.refresh, expires_in: 86400, scope: "read" }
  await expect(linearExchange(f.config.linear!, native.fetch).link!("generated", { account: f.account, platform: "linear", purpose: "link", issuedAt: f.fake.clock.now })).rejects.toMatchObject({ code: "LINEAR_GRANT_INVALID" })
})

test("refresh replaces the sealed pair together while preserving authorization revision", async () => {
  const f = await expired()
  const result = await f.access()
  expect(result.token).toBe(native.refreshed.access_token)
  const current = await readInstallSnapshot(f.store, f.installation)
  expect(current?.record.revision).toBe(f.snapshot.record.revision)
  expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))).toMatchObject({ access: native.refreshed.access_token, refresh: native.refreshed.refresh_token })
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh", "viewer"])
  expect(JSON.stringify(f.fake.commands)).not.toContain(String(native.refreshed.refresh_token))
})

test("independent refreshers perform only one renewal and cannot overwrite reconnect or resurrect erase", async () => {
  for (const mode of ["concurrent", "reconnect", "erase"] as const) {
    const f = await expired()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    native.answer = async (operation) => { if (operation === "refresh") { enter(); await blocked }; return undefined }
    const pending = f.access()
    await entered
    if (mode === "concurrent") await expect(f.access()).rejects.toMatchObject({ code: "LINEAR_REFRESH_BUSY" })
    if (mode === "erase") await eraseInstallation(f.context(), f.installation, "uninstalled")
    if (mode === "reconnect") await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation,
      token: JSON.stringify(f.pair), scopes: OAUTH.linear.scopes.install, botUserId: native.bot, installer: { admin: true } } })
    release()
    if (mode === "concurrent") expect((await pending).token).toBe(native.refreshed.access_token)
    else await expect(pending).rejects.toMatchObject({ code: "LINEAR_AUTH_CHANGED" })
    expect(native.calls.filter((call) => call.operation === "refresh")).toHaveLength(1)
    expect(native.calls.filter((call) => call.operation === "viewer")).toHaveLength(mode === "concurrent" ? 1 : 0)
    const current = await readInstallSnapshot(f.store, f.installation)
    if (mode === "erase") expect(current).toBeUndefined()
    if (mode === "reconnect") {
      expect(current?.record.revision).not.toBe(f.snapshot.record.revision)
      expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))?.access).toBe(f.pair.access)
    }
  }
})

test("callback has a fixed fragment destination and cannot exchange a code as an account", async () => {
  const f = await linearFixture(native)
  harness.mount({ "/oauth": linearOAuthCallback(() => f.config) })
  const response = await fetch(`${harness.origin}/oauth?code=generated&state=generated-state-123456789`, { redirect: "manual" })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/everywhere#platform=linear&code=generated&state=generated-state-123456789")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(native.calls).toHaveLength(0)
})
