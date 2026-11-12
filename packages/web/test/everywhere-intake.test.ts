import { afterAll, beforeAll, expect, test } from "bun:test"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { createIntake } from "../../../api/_lib/everywhere/intake"
import { eraseInstallation } from "../../../api/_lib/everywhere/erase"
import { installationAuthority, readInstallSnapshot, recordInstall, setMapping } from "../../../api/_lib/everywhere/identity"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { CREATE_JOB_SCRIPT, jobEraser, openReply, readJob, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { readCounts } from "../../../api/_lib/everywhere/limits"
import { setJson } from "../../../api/_lib/everywhere/store"
import { createJobId } from "../../../packages/schema/src/everywhere"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"

installFetchGuard()
const harness = new RouteHarness()
beforeAll(() => harness.start())
afterAll(() => harness.stop())

async function ready() {
  const f = routerFixture()
  await setJson(f.store, everywhereKeys.install(f.trigger.installation), { connector: f.account, scopes: [], installedAt: f.fake.clock.now })
  await setJson(f.store, everywhereKeys.link(f.trigger.installation, f.trigger.actor.userId), { account: f.account, linkedAt: f.fake.clock.now })
  expect((await setMapping(f.context(), { account: f.account, installation: f.trigger.installation,
    place: f.parsed.place, repositories: [{ id: 101, fullName: "acme/app" }], private: true })).ok).toBe(true)
  await recordSeen(f.context(), f.account, f.computer)
  const intake = createIntake(f.adapter, { config: { ...f.config, offer: f.context().offer }, store: f.store, ports: f.ports,
    now: () => f.fake.clock.now, sleep: f.routing.sleep })
  return { ...f, intake }
}

test("the first platform signal precedes every potentially slow routing port", async () => {
  const f = await ready()
  const presence = f.ports.presence
  f.ports.presence = async (account) => {
    expect(f.calls[0]?.kind).toBe("ack")
    return presence(account)
  }
  const jid = createJobId(f.fake.clock.now)
  await f.intake.process(f.parsed, { ...f.routing.view(await f.create()), jid })
  expect((await readJob(f.store, jid))?.state).toBe("waiting")
})

test("duplicate delivery creates no second job or signal", async () => {
  const f = await ready()
  const view = { ...f.routing.view(await f.create()), jid: createJobId(f.fake.clock.now) }
  await f.intake.process(f.parsed, view)
  const count = f.calls.length
  await f.intake.process(f.parsed, { ...view, jid: createJobId(f.fake.clock.now + 1) })
  expect(f.calls).toHaveLength(count)
  expect(f.calls.filter((call) => call.kind === "offer")).toHaveLength(1)
})

test("native admission charges each quota once in the same transaction as its job", async () => {
  const f = await ready()
  const jid = createJobId(f.fake.clock.now)
  const spoof = { ...f.parsed, reply: { ...f.parsed.reply, installRevision: "webhook-cannot-choose-this" } }
  await f.intake.process(spoof, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: spoof.reply })
  expect(await readCounts(f.store, { sponsor: f.account, installation: f.trigger.installation, userId: f.trigger.actor.userId }, f.fake.clock.now)).toMatchObject({
    sponsorToday: 1, requesterHour: 1, installationToday: 1, sponsorLive: 1,
  })
  expect(await f.store(["GET", everywhereKeys.delivery("slack", f.trigger.deliveryId)])).toBe(`job:${jid}`)
  expect(openReply(f.context(), (await readJob(f.store, jid))!)?.installRevision).toBe(installationAuthority((await readInstallSnapshot(f.store, f.trigger.installation))!))
})

test("a slow native prepare cannot admit or reserve quota after erase, reconnect or credential refresh", async () => {
  for (const mode of ["erase", "reconnect", "refresh", "same-clock"] as const) {
    const f = await ready()
    if (mode === "same-clock") await recordInstall(f.context(), { account: f.account, event: "install", grant: {
      installation: f.trigger.installation, scopes: [], installer: { userId: f.trigger.actor.userId, admin: true },
    } })
    const before = await readInstallSnapshot(f.store, f.trigger.installation)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    f.adapter.prepare = async (parsed) => { enter(); await blocked; return parsed }
    const jid = createJobId(f.fake.clock.now)
    const pending = f.intake.process(f.parsed, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: f.parsed.reply })
    await entered
    if (mode !== "refresh") await eraseInstallation({ ...f.context(), jobs: jobEraser(f.store) }, f.trigger.installation, "uninstalled")
    if (mode !== "erase") {
      if (mode !== "same-clock") f.fake.clock.advance(1)
      expect((await recordInstall(f.context(), { account: f.account, event: "install", grant: {
        installation: f.trigger.installation, scopes: [], ...(mode !== "same-clock" ? { token: `fixture-${mode}-${jid}` } : {}),
        installer: { userId: f.trigger.actor.userId, admin: true },
      } })).ok).toBe(true)
      await setJson(f.store, everywhereKeys.link(f.trigger.installation, f.trigger.actor.userId), { account: f.account, linkedAt: f.fake.clock.now })
      expect((await setMapping(f.context(), { account: f.account, installation: f.trigger.installation, place: f.parsed.place,
        repositories: [{ id: 101, fullName: "acme/app" }], private: true })).ok).toBe(true)
      const current = await readInstallSnapshot(f.store, f.trigger.installation)
      expect(current?.raw).not.toBe(before?.raw)
      if (mode === "same-clock") {
        expect(current?.record.installedAt).toBe(before?.record.installedAt)
        expect(current?.record.tokenEnc).toBeUndefined()
        expect(before?.record.tokenEnc).toBeUndefined()
        expect(current?.record.revision).not.toBe(before?.record.revision)
      }
    }
    release()
    await pending
    expect(await readJob(f.store, jid)).toBeUndefined()
    expect(f.fake.sorted(everywhereKeys.jobHistory(f.account))).toEqual([])
    expect(f.calls.some((call) => call.kind === "offer")).toBe(false)
    expect(await readCounts(f.store, { sponsor: f.account, installation: f.trigger.installation, userId: f.trigger.actor.userId }, f.fake.clock.now)).toEqual({
      sponsorToday: 0, requesterHour: 0, installationToday: 0, sponsorLive: 0,
    })
  }
})

test("a lost create response cannot admit another job after the pending lease expires", async () => {
  const f = await ready()
  let crash = true
  const intake = createIntake(f.adapter, { config: { ...f.config, offer: f.context().offer }, ports: f.ports,
    now: () => f.fake.clock.now, sleep: f.routing.sleep, store: async (command) => {
      const result = await f.store(command)
      if (crash && command[0] === "EVAL" && command[1] === CREATE_JOB_SCRIPT) {
        crash = false
        throw new Error("Fixture lost the create response")
      }
      return result
    } })
  const jid = createJobId(f.fake.clock.now)
  const view = { jid, platform: "slack" as const, installation: f.trigger.installation, shared: false, reply: f.parsed.reply }
  await expect(intake.process(f.parsed, view)).rejects.toThrow("Fixture lost the create response")
  expect((await readJob(f.store, jid))?.state).toBe("received")
  expect(await f.store(["GET", everywhereKeys.delivery("slack", f.trigger.deliveryId)])).toBe(`job:${jid}`)
  f.fake.clock.advance(60_001)
  const calls = f.calls.length
  const retry = createJobId(f.fake.clock.now)
  await f.intake.process(f.parsed, { ...view, jid: retry })
  expect(await readJob(f.store, retry)).toBeUndefined()
  expect(f.fake.sorted(everywhereKeys.jobHistory(f.account))).toEqual([jid])
  expect(f.calls).toHaveLength(calls)
})

test("an unlinked requester receives a private link prompt and makes no offer", async () => {
  const f = await ready()
  await f.store(["DEL", everywhereKeys.link(f.trigger.installation, f.trigger.actor.userId)])
  const jid = createJobId(f.fake.clock.now)
  await f.intake.process(f.parsed, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: f.parsed.reply })
  expect(f.calls.map((call) => call.kind)).toEqual(["ack", "link"])
  expect(await readJob(f.store, jid)).toBeUndefined()
})

test("a platform HTTP acknowledgement never waits for a stalled store", async () => {
  const f = await ready()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const handler = createIntake(f.adapter, { config: f.config, ports: f.ports, now: () => f.fake.clock.now,
    sleep: f.routing.sleep, store: async (command) => { await blocked; return f.store(command) } }).handler
  harness.mount({ "/events": handler })
  const answer = await harness.call("POST", "/events", { body: {} })
  expect(answer.status).toBe(200)
  expect(f.calls).toHaveLength(0)
  release()
  await drainAfter()
})

test("disabled platforms and forged signatures never read the store", async () => {
  const f = await ready()
  let reads = 0
  const store = async () => { reads++; throw new Error("must not read") }
  harness.mount({ "/off": createIntake(f.adapter, { config: { ...f.config, enabled: false }, store }).handler })
  expect((await harness.call("POST", "/off", { body: {} })).status).toBe(404)
  f.adapter.verify = async () => ({ ok: false, status: 401 })
  harness.mount({ "/forged": createIntake(f.adapter, { config: f.config, store }).handler })
  expect((await harness.call("POST", "/forged", { body: {} })).status).toBe(401)
  expect(reads).toBe(0)
})
