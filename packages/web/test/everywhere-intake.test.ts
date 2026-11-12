import { afterAll, beforeAll, expect, test } from "bun:test"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { createIntake } from "../../../api/_lib/everywhere/intake"
import { setMapping } from "../../../api/_lib/everywhere/identity"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { readJob, recordSeen } from "../../../api/_lib/everywhere/jobs"
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
