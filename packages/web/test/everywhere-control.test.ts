import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { eraseEverywhereAccount, eraseInstallation } from "../../../api/_lib/everywhere/erase"
import { installationAuthority, readInstallSnapshot, readInstallState, recordInstall, unlink } from "../../../api/_lib/everywhere/identity"
import { cancelJob, openReply } from "../../../api/_lib/everywhere/jobs"
import { createSlackAdapter } from "../../../api/_lib/everywhere/slack/adapter"
import { createLinearAdapter } from "../../../api/_lib/everywhere/linear/adapter"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { revokeSlack } from "../../../api/_lib/everywhere/slack/install"
import { revokeLinear } from "../../../api/_lib/everywhere/linear/install"
import { createSlackRoutes } from "../../../api/_lib/everywhere/slack/routes"
import { createLinearWebhook } from "../../../api/_lib/everywhere/linear/routes"
import { linearOptions } from "../../../api/_lib/everywhere/linear/selection"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeLinear, linearFixture } from "./lib/everywhere-linear"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"

installFetchGuard()
const harness = new RouteHarness(), slack = new FakeSlack(), linear = new FakeLinear()
beforeAll(async () => { await harness.start(); slack.start(); linear.start() })
afterAll(async () => { await drainAfter(); await slack.stop(); await linear.stop(); await harness.stop() })

async function readySlack() {
  slack.calls = []; slack.answer = undefined
  const f = await slackFixture()
  harness.mount({ "/slack": createSlackRoutes({ config: () => f.config, context: f.context, ports: f.ports, fetcher: slack.fetch }).events })
  const send = (body: unknown) => harness.call("POST", "/slack", { body, headers: f.sign(JSON.stringify(body)) })
  const reconnect = async () => recordInstall(f.context(), { account: f.account, event: "install", grant: {
    installation: f.installation, token: `${f.token}-replacement`, scopes: f.record.scopes, botUserId: f.record.botUserId, installer: { admin: true },
  } })
  return { ...f, send, reconnect }
}
function pause() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), wait = new Promise<void>((resolve) => { release = resolve })
  return { entered, release, stop: async () => { enter(); await wait } }
}

test("a first delayed Slack uninstall preserves a valid fresh authorization regardless of event dispatch time", async () => {
  const f = await readySlack()
  const body = { ...f.envelope("", { type: "app_uninstalled" }), event_time: Math.floor(f.fake.clock.now / 1000) + 1 }
  await f.reconnect()
  const fresh = (await readInstallSnapshot(f.store, f.installation))!
  expect((await f.send(body)).status).toBe(200); await drainAfter()
  expect((await readInstallSnapshot(f.store, f.installation))?.raw).toBe(fresh.raw)
  expect(slack.calls).toHaveLength(1)
  expect(slack.calls[0]).toMatchObject({ method: "auth.test", authorization: `Bearer ${f.token}-replacement` })
  expect(await f.store(["GET", everywhereKeys.installHold(f.installation, installationAuthority(fresh))])).toBeNull()
})

test("a processed Slack revocation cannot retarget a same-clock replacement on replay", async () => {
  const f = await readySlack(), event = f.envelope("", { type: "tokens_revoked", tokens: { bot: [f.record.botUserId] } })
  slack.answer = (method) => method === "auth.test" ? Response.json({ ok: false, error: "token_revoked" }) : undefined
  await f.send(event); await drainAfter()
  expect(await readInstallState(f.store, f.installation)).toBeUndefined()
  await f.reconnect()
  const fresh = (await readInstallSnapshot(f.store, f.installation))!, calls = slack.calls.length
  await f.send(event); await drainAfter()
  expect((await readInstallSnapshot(f.store, f.installation))?.raw).toBe(fresh.raw)
  expect(slack.calls).toHaveLength(calls)
})

test("a captured unusable-token proof completing after reconnect cannot close or hold the fresh grant", async () => {
  const f = await readySlack(), barrier = pause()
  slack.answer = async (method) => { if (method === "auth.test") { await barrier.stop(); return Response.json({ ok: false, error: "invalid_auth" }) } }
  await f.send(f.envelope("", { type: "app_uninstalled" })); await barrier.entered
  await f.reconnect()
  const fresh = (await readInstallSnapshot(f.store, f.installation))!
  const before = JSON.stringify([...f.fake.data.entries()])
  barrier.release(); await drainAfter()
  expect((await readInstallSnapshot(f.store, f.installation))?.raw).toBe(fresh.raw)
  expect(JSON.stringify([...f.fake.data.entries()])).toBe(before)
})

test("expired, missing, wrong-identity and ambiguous Slack proof hold without erasing data", async () => {
  for (const proof of [() => Response.json({ ok: false, error: "token_expired" }), () => new Response(null, { status: 401 }),
    () => Response.json({ ok: false, error: "missing_scope" }), () => new Response(null, { status: 503 }),
    () => Response.json({ ok: true, team_id: "TOTHER", user_id: "U0BOT0001", bot_id: "B0BOT0001" })]) {
    const f = await readySlack(), before = (await readInstallState(f.store, f.installation))!
    slack.answer = (method) => method === "auth.test" ? proof() : undefined
    await f.send(f.envelope("", { type: "app_uninstalled" })); await drainAfter()
    expect((await readInstallState(f.store, f.installation))?.raw).toBe(before.raw)
    expect(await readInstallSnapshot(f.store, f.installation)).toBeUndefined()
    expect(await f.store(["GET", everywhereKeys.installHold(f.installation, installationAuthority(before))])).not.toBeNull()
  }
})

test("reconnecting clears an ambiguous hold but the old semantic receipt cannot create another", async () => {
  const f = await readySlack(), event = f.envelope("", { type: "app_uninstalled" })
  slack.answer = () => new Response(null, { status: 503 })
  await f.send(event); await drainAfter()
  expect(await readInstallSnapshot(f.store, f.installation)).toBeUndefined()
  await f.reconnect()
  const fresh = (await readInstallSnapshot(f.store, f.installation))!
  await f.send(event); await drainAfter()
  expect((await readInstallSnapshot(f.store, f.installation))?.raw).toBe(fresh.raw)
})

test("missing or deleting account authority prevents the native credential probe and retains a hold", async () => {
  for (const deleting of [false, true]) {
    const f = await readySlack(), before = (await readInstallState(f.store, f.installation))!
    if (deleting) await f.store(["SET", everywhereKeys.accountClosed(f.account), "closed"])
    harness.mount({ "/slack": createSlackRoutes({ config: () => f.config, context: () => ({ ...f.context(),
      ...(!deleting ? { accountAuthority: async () => undefined } : {}),
    }), ports: f.ports, fetcher: slack.fetch }).events })
    await f.send(f.envelope("", { type: "app_uninstalled" })); await drainAfter()
    expect(slack.calls).toHaveLength(0)
    expect((await readInstallState(f.store, f.installation))?.raw).toBe(before.raw)
    expect(await readInstallSnapshot(f.store, f.installation)).toBeUndefined()
    expect(await f.store(["GET", everywhereKeys.installHold(f.installation, installationAuthority(before))])).not.toBeNull()
  }
})

test("Linear signed semantic control receipt survives reconnect and ignores changed delivery headers/times", async () => {
  const f = await linearFixture(linear)
  harness.mount({ "/linear": createLinearWebhook(f.deps) })
  const body = { type: "OAuthApp", action: "revoked", createdAt: new Date(f.fake.clock.now - 1000).toISOString(),
    organizationId: linear.organization, oauthClientId: f.config.linear!.clientId, webhookId: randomUUID(), webhookTimestamp: f.fake.clock.now }
  const send = (payload: typeof body) => harness.call("POST", "/linear", { body: payload, headers: f.sign(JSON.stringify(payload), randomUUID(), payload.type) })
  await send(body); await drainAfter()
  expect(await readInstallSnapshot(f.store, f.installation)).toBeUndefined()
  expect((await readInstallState(f.store, f.installation))?.raw).toBe(f.snapshot.raw)
  await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation, token: JSON.stringify(f.pair),
    scopes: f.snapshot.record.scopes, botUserId: linear.bot, installer: { admin: true } } })
  const fresh = (await readInstallSnapshot(f.store, f.installation))!
  await send({ ...body, webhookTimestamp: f.fake.clock.now + 1 }); await drainAfter()
  expect((await readInstallSnapshot(f.store, f.installation))?.raw).toBe(fresh.raw)
  expect([...f.fake.data.keys()].filter((key) => key.startsWith("vector:everywhere:control:"))).toHaveLength(1)
  expect(linear.calls).toHaveLength(0)
})

function protectedState(f: Awaited<ReturnType<typeof slackFixture>> | Awaited<ReturnType<typeof linearFixture>>) {
  // Releasing this invocation's anonymous status lock is allowed; every connection/job/index value is compared.
  return JSON.stringify([...f.fake.data.entries()].filter(([key]) => !key.endsWith(":status") && !key.endsWith(":posting")).map(([key, value]) =>
    [key, value.kind === "string" ? value : { kind: value.kind, value: [...value.value].sort() }]).sort(([a], [b]) => String(a).localeCompare(String(b))))
}

test("Slack cooldown delay cannot emit a stale mutation after reconnect, unlink, account closure or stop", async () => {
  for (const mode of ["reconnect", "unlink", "account", "cancel"] as const) {
    const f = await readySlack(), job = await f.create(), barrier = pause()
    const view = { jid: job.jid, platform: "slack" as const, installation: f.installation, shared: true,
      reply: { ...openReply(f.context(), job), user: f.trigger.actor.userId }, job }
    let once = true
    const context = () => ({ ...f.context(), store: async (command: readonly (string | number)[]) => {
      const result = await f.store(command)
      if (once && command[0] === "ZSCORE" && String(command[1]).startsWith("vector:everywhere:slack:retry:")) { once = false; await barrier.stop() }
      return result
    } })
    const pending = createSlackAdapter({ config: () => f.config, context, ports: f.ports, fetcher: slack.fetch }).progress(view, "editing")
    await barrier.entered
    if (mode === "reconnect") await f.reconnect()
    if (mode === "unlink") await unlink(f.context(), { installation: f.installation, userId: f.trigger.actor.userId, account: f.account })
    if (mode === "account") await f.store(["SET", everywhereKeys.accountClosed(f.account), "closed"])
    if (mode === "cancel") await cancelJob(f.context(), job.jid)
    const before = protectedState(f)
    barrier.release()
    await expect(pending).rejects.toMatchObject({ statusCode: 409 })
    expect(slack.calls).toHaveLength(0)
    expect(protectedState(f)).toBe(before)
  }
})

test("Linear cooldown delay rechecks current token and task authority before any native mutation", async () => {
  for (const mode of ["reconnect", "unlink", "account", "cancel"] as const) {
    const f = await linearFixture(linear), active = await f.job(), barrier = pause()
    let once = true
    const context = () => ({ ...f.context(), store: async (command: readonly (string | number)[]) => {
      const result = await f.store(command)
      if (once && command[0] === "ZSCORE" && String(command[1]).startsWith("vector:everywhere:linear:retry:")) { once = false; await barrier.stop() }
      return result
    } })
    const pending = createLinearAdapter({ ...f.deps, context }).progress(active.view, "editing")
    await barrier.entered
    if (mode === "reconnect") await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation,
      token: JSON.stringify(f.pair), scopes: f.snapshot.record.scopes, botUserId: linear.bot, installer: { admin: true } } })
    if (mode === "unlink") await unlink(f.context(), { installation: f.installation, userId: linear.user, account: f.account })
    if (mode === "account") await f.store(["SET", everywhereKeys.accountClosed(f.account), "closed"])
    if (mode === "cancel") await cancelJob(f.context(), active.view.jid)
    const before = protectedState(f)
    barrier.release()
    await expect(pending).rejects.toMatchObject({ statusCode: 409 })
    expect(linear.calls).toHaveLength(0)
    expect(protectedState(f)).toBe(before)
  }
})

test("in-flight revocation keeps closing until confirmation and stale native proof cannot affect a reconnect", async () => {
  for (const platform of ["slack", "linear"] as const) {
    const f = platform === "slack" ? await readySlack() : await linearFixture(linear)
    const barrier = pause()
    let proof!: () => Promise<void>
    const captured = (await readInstallState(f.store, f.installation))!
    const transport = (installation: string, record: typeof captured.record, beforeRequest: () => Promise<void>) => platform === "slack"
      ? revokeSlack(installation, record, f.context().keys, slack.fetch, beforeRequest)
      : revokeLinear(installation, record, f.context().keys, linear.fetch, beforeRequest)
    if (platform === "slack") slack.answer = async (method) => { if (method === "auth.revoke") await barrier.stop(); return undefined }
    else linear.answer = async (operation) => { if (operation === "revoke") await barrier.stop(); return undefined }
    const pending = eraseInstallation({ ...f.context(), revoke: async (installation, record, beforeRequest) => {
      proof = beforeRequest
      return transport(installation, record, beforeRequest)
    } }, f.installation, "disconnected")
    await barrier.entered
    expect((await readInstallState(f.store, f.installation))?.record.closing?.revocation).toBe("pending")
    const local = await eraseInstallation(f.context(), f.installation, "disconnected")
    expect(local.nativePending).toBe(true)
    expect((await readInstallState(f.store, f.installation))?.record.tokenEnc).toBeUndefined()
    const grant = { installation: f.installation, scopes: captured.record.scopes, token: platform === "slack" ? "replacement-slack-token" : JSON.stringify({ ...("pair" in f ? f.pair : {}), access: "replacement-access", refresh: "replacement-refresh" }),
      botUserId: captured.record.botUserId, installer: { admin: true } }
    await expect(recordInstall(f.context(), { account: f.account, event: "install", grant })).rejects.toMatchObject({ code: "EVERYWHERE_INSTALLATION_CLOSING" })
    barrier.release()
    expect((await pending).nativePending).toBeUndefined()
    expect(await readInstallState(f.store, f.installation)).toBeUndefined()
    await recordInstall(f.context(), { account: f.account, event: "install", grant })
    const replacement = protectedState(f)
    const before = platform === "slack" ? slack.calls.length : linear.calls.length
    await expect(proof()).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
    const stale = await transport(f.installation, captured.record, proof).catch(() => "uncertain" as const)
    expect(stale).toBe("uncertain")
    expect(platform === "slack" ? slack.calls.length : linear.calls.length).toBe(before)
    expect(protectedState(f)).toBe(replacement)
    if (platform === "slack") slack.answer = undefined
    else linear.answer = undefined
  }
})

test("a suspended revoker cannot start after another cleanup scrubs its generation", async () => {
  for (const platform of ["slack", "linear"] as const) {
    const f = platform === "slack" ? await readySlack() : await linearFixture(linear), barrier = pause()
    let callbacks = 0
    const pending = eraseInstallation({ ...f.context(), revoke: async (installation, record, beforeRequest) => {
      callbacks++; await barrier.stop()
      return platform === "slack" ? revokeSlack(installation, record, f.context().keys, slack.fetch, beforeRequest) :
        revokeLinear(installation, record, f.context().keys, linear.fetch, beforeRequest)
    } }, f.installation, "disconnected")
    await barrier.entered
    expect((await eraseInstallation(f.context(), f.installation, "disconnected")).nativePending).toBe(true)
    const scrubbed = (await readInstallState(f.store, f.installation))!
    expect(scrubbed.record.tokenEnc).toBeUndefined()
    expect(scrubbed.record.scopes).toEqual([])
    barrier.release()
    expect((await pending).nativePending).toBe(true)
    expect(platform === "slack" ? slack.calls : linear.calls).toHaveLength(0)
    const marker = (await readInstallState(f.store, f.installation))!
    expect(marker.record.closing?.revocation).toBe("uncertain")
    const retry = await eraseInstallation({ ...f.context(), revoke: async () => { callbacks++; return "confirmed" } }, f.installation, "disconnected")
    expect(retry.nativePending).toBe(true)
    expect(callbacks).toBe(1)
    expect((await readInstallState(f.store, f.installation))?.raw).toBe(marker.raw)
  }
})

test("account deletion scrubs an unresolved native revoke without needing active-account authority", async () => {
  const f = await readySlack(), barrier = pause()
  slack.answer = async (method) => { if (method === "auth.revoke") await barrier.stop(); return undefined }
  const pending = eraseInstallation({ ...f.context(), revoke: (installation, record, beforeRequest) => revokeSlack(installation, record, f.context().keys, slack.fetch, beforeRequest) }, f.installation, "disconnected")
  await barrier.entered
  await eraseEverywhereAccount({ ...f.context(), accountAuthority: async () => undefined }, f.account)
  const marker = (await readInstallState(f.store, f.installation))!
  expect(marker.record.tokenEnc).toBeUndefined()
  expect(marker.record.scopes).toEqual([])
  expect(marker.record.botUserId).toBeUndefined()
  expect(marker.record.closing?.revocation).toBe("uncertain")
  expect(await f.store(["GET", everywhereKeys.accountClosed(f.account)])).toBe("closed")
  barrier.release(); await pending
  expect(await readInstallState(f.store, f.installation)).toBeUndefined()
  slack.answer = undefined
})

test("legacy name-only repository entries cannot create opaque native choices", () => {
  expect(linearOptions(randomUUID(), randomUUID(), [{ fullName: "acme/reused-name" }])).toEqual([])
  const old = linearOptions("authority", "team", [{ id: 101, fullName: "acme/reused-name" }], "nonce")
  const replacement = linearOptions("authority", "team", [{ id: 202, fullName: "acme/reused-name" }], "nonce")
  expect(old[0]?.value).not.toBe(replacement[0]?.value)
})
