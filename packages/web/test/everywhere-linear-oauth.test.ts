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

test.each(["unavailable", "rate-limited", "malformed"] as const)("a %s viewer preserves the rotated pair and retries verification without another refresh", async (failure) => {
  const f = await expired()
  let fail = true
  native.answer = async (operation) => {
    if (operation !== "viewer") return undefined
    const current = await readInstallSnapshot(f.store, f.installation)
    // The exchange already consumed the old refresh token. Its replacement must be durable before this probe.
    expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))).toMatchObject({
      v: 2, access: native.refreshed.access_token, refresh: native.refreshed.refresh_token, verification: "pending",
    })
    if (!fail) return undefined
    if (failure === "malformed") return Response.json({ data: { viewer: {}, organization: { id: native.organization } } })
    return new Response(null, { status: failure === "rate-limited" ? 429 : 503 })
  }
  const codes = { unavailable: "LINEAR_DELIVERY_UNCERTAIN", "rate-limited": "LINEAR_UNAVAILABLE", malformed: "LINEAR_AUTH_UNAVAILABLE" }
  await expect(f.access()).rejects.toMatchObject({ code: codes[failure] })
  const retained = await readInstallSnapshot(f.store, f.installation)
  expect(retained?.record.revision).toBe(f.snapshot.record.revision)
  expect(retained && parseLinearCredentials(installToken(f.context().keys, f.installation, retained.record))).toMatchObject({
    v: 2, refresh: native.refreshed.refresh_token, verification: "pending",
  })
  fail = false
  expect((await f.access()).token).toBe(native.refreshed.access_token)
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh", "viewer", "viewer"])
  const verified = await readInstallSnapshot(f.store, f.installation)
  const credentials = verified && parseLinearCredentials(installToken(f.context().keys, f.installation, verified.record))
  expect(credentials?.v).toBe(1)
  expect(credentials).not.toHaveProperty("verification")
  expect(JSON.stringify(f.fake.commands)).not.toContain(native.refreshed.access_token)
  expect(JSON.stringify(f.fake.commands)).not.toContain(native.refreshed.refresh_token)
})

test("a deadline reached after rotation retains the new pair without attempting its viewer", async () => {
  const f = await expired()
  const deadline = f.fake.clock.now + 8_000
  native.answer = async (operation) => {
    if (operation === "refresh") f.fake.clock.advance(8_001)
    return undefined
  }
  await expect(linearAccess({ context: f.context, installation: f.installation, config: f.config.linear!, fetcher: native.fetch, deadline })).rejects.toMatchObject({ code: "LINEAR_UNAVAILABLE" })
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh"])
  const current = await readInstallSnapshot(f.store, f.installation)
  expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))).toMatchObject({
    v: 2, refresh: native.refreshed.refresh_token, verification: "pending",
  })
  native.answer = undefined
  expect((await f.access()).token).toBe(native.refreshed.access_token)
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh", "viewer"])
})

test("a definite renewed-viewer mismatch quarantines the pair and never returns it through the fresh-token path", async () => {
  const f = await expired()
  native.viewers.set(native.refreshed.access_token, { id: native.user, app: false, active: true, organization: { id: native.organization } })
  await expect(f.access()).rejects.toMatchObject({ code: "LINEAR_AUTH_CHANGED" })
  const current = await readInstallSnapshot(f.store, f.installation)
  expect(current && parseLinearCredentials(installToken(f.context().keys, f.installation, current.record))).toMatchObject({
    v: 2, verification: "rejected",
  })
  await expect(f.access()).rejects.toMatchObject({ code: "LINEAR_RECONNECT_REQUIRED" })
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh", "viewer"])
  expect(parseLinearCredentials(JSON.stringify({ ...f.pair, verification: "pending" }))).toBeUndefined()
  expect(parseLinearCredentials(JSON.stringify({ ...f.pair, v: 2 }))).toBeUndefined()
})

test.each(["reconnect", "erase", "account-deleted"] as const)("%s during renewed-viewer verification cannot overwrite current authority", async (mode) => {
  const f = await expired()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), wait = new Promise<void>((resolve) => { release = resolve })
  native.answer = async (operation) => { if (operation === "viewer") { enter(); await wait }; return undefined }
  const pending = f.access()
  await entered
  const stored = await readInstallSnapshot(f.store, f.installation)
  expect(stored && parseLinearCredentials(installToken(f.context().keys, f.installation, stored.record))).toMatchObject({
    v: 2, verification: "pending",
  })
  await expect(f.access()).rejects.toMatchObject({ code: "LINEAR_REFRESH_BUSY" })
  if (mode === "erase") await eraseInstallation(f.context(), f.installation, "uninstalled")
  if (mode === "account-deleted") await f.store(["SET", everywhereKeys.accountClosed(f.account), "closed"])
  if (mode === "reconnect") await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation,
    token: JSON.stringify(f.pair), scopes: OAUTH.linear.scopes.install, botUserId: native.bot, installer: { admin: true } } })
  const protectedValue = await f.store(["GET", everywhereKeys.install(f.installation)])
  release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(await f.store(["GET", everywhereKeys.install(f.installation)])).toBe(protectedValue)
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh", "viewer"])
  if (mode === "erase") expect(await readInstallSnapshot(f.store, f.installation)).toBeUndefined()
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

test("connector deletion during OAuth refresh prevents the later viewer probe and credential commit", async () => {
  const f = await expired()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), wait = new Promise<void>((resolve) => { release = resolve })
  native.answer = async (operation) => { if (operation === "refresh") { enter(); await wait }; return undefined }
  const pending = f.access()
  await entered
  await f.store(["SET", everywhereKeys.accountClosed(f.account), "closed"])
  const before = await f.store(["GET", everywhereKeys.install(f.installation)])
  release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(native.calls.map((call) => call.operation)).toEqual(["refresh"])
  expect(await f.store(["GET", everywhereKeys.install(f.installation)])).toBe(before)
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
