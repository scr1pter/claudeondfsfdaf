import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { appendAudit } from "../../../api/_lib/everywhere/audit"
import { accountGuards, authorizedCommands, authorizedScript, fencedStore } from "../../../api/_lib/everywhere/authority"
import { captureControl } from "../../../api/_lib/everywhere/control"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { claimDelivery } from "../../../api/_lib/everywhere/dedupe"
import { eraseEverywhereAccount, eraseInstallation } from "../../../api/_lib/everywhere/erase"
import { createState, findLink, linkBySignIn, installationAuthority, issueLinkCode, readInstallSnapshot, readInstallState, readLinkSnapshot, recordInstall, redeemLinkCode, removeMapping, setMapping, setMappingByWord, unlink } from "../../../api/_lib/everywhere/identity"
import { createIntake } from "../../../api/_lib/everywhere/intake"
import { createJob, jobEraser, offerJob, openReply, readJob, readJobBody, recordSeen, sweepAccount, CREATE_JOB_SCRIPT } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { capKeys, readCounts } from "../../../api/_lib/everywhere/limits"
import { SWAP_SCRIPT, getValue, type Store } from "../../../api/_lib/everywhere/store"
import { createJobId } from "../../../packages/schema/src/everywhere"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"
import { realRedis, testAccountAuthority, testEverywhereStore, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()
let restore: () => void
beforeAll(() => { restore = useKv() })
afterAll(() => restore())

async function ready() {
  const f = routerFixture()
  const grant = { installation: f.trigger.installation, scopes: [], installer: { userId: f.trigger.actor.userId, admin: true } }
  await recordInstall(f.context(), { account: f.account, event: "install", grant })
  const link = async (account = f.account) => {
    const issued = await issueLinkCode(f.context(), { account, platform: "slack", installation: f.trigger.installation })
    return redeemLinkCode(f.context(), { installation: f.trigger.installation, userId: f.trigger.actor.userId,
      code: issued.code, place: "private", actor: { bot: false, guest: false, external: false } })
  }
  expect((await link()).ok).toBe(true)
  expect((await setMapping(f.context(), { account: f.account, installation: f.trigger.installation,
    place: f.parsed.place, repositories: [{ id: 101, fullName: "acme/app" }] })).ok).toBe(true)
  const intake = () => createIntake(f.adapter, { config: { ...f.config, offer: f.context().offer }, store: f.store,
    ports: f.ports, now: () => f.fake.clock.now, sleep: f.routing.sleep })
  return { ...f, grant, link, intake }
}
function pause() {
  let entered!: () => void, release!: () => void
  const wait = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { wait, release, stop: async () => { entered(); await gate } }
}
function state(f: Pick<ReturnType<typeof routerFixture>, "fake">) {
  return JSON.stringify([...f.fake.data.entries()].map(([key, value]) => [key, value.kind === "string" ? value : {
    kind: value.kind, value: [...value.value].sort(),
  }]).sort(([a], [b]) => String(a).localeCompare(String(b))))
}

test("missing account authority and any upstream tombstone bytes fail before durable writes", async () => {
  const f = routerFixture()
  const unconfigured: Store = async (command) => f.store(command)
  const input = { account: f.account, event: "install" as const, grant: { installation: f.trigger.installation, scopes: [], installer: { admin: true } } }
  await expect(recordInstall({ ...f.context(), store: unconfigured, accountAuthority: undefined }, input)).rejects.toMatchObject({ code: "EVERYWHERE_ACCOUNT_UNVERIFIED" })
  expect(f.fake.data.size).toBe(0)
  f.fake.send(["SET", `vector:codium:test:tombstone:${f.account}`, "malformed-is-still-deleting"])
  await expect(recordInstall(f.context(), input)).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(await getValue(f.store, everywhereKeys.install(f.trigger.installation))).toBeUndefined()
})

test("the account tombstone is checked inside Lua after a slow authority lookup", async () => {
  const f = routerFixture(), barrier = pause()
  const context = { ...f.context(), accountAuthority: async (account: string) => { await barrier.stop(); return testAccountAuthority(account) } }
  const pending = recordSeen(context, f.account, f.computer)
  await barrier.wait
  f.fake.send(["SET", `vector:codium:test:tombstone:${f.account}`, "deleting"])
  barrier.release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(await getValue(f.store, everywhereKeys.seen(f.account))).toBeUndefined()
})

test("native intake cannot spend an old link after unlink and relink during repository resolution", async () => {
  const f = await ready(), barrier = pause(), other = randomUUID()
  f.ports.repository = async (fullName) => { await barrier.stop(); return { id: 101, fullName, shared: false } }
  const jid = createJobId(f.fake.clock.now)
  const pending = f.intake().process(f.parsed, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: f.parsed.reply })
  await barrier.wait
  expect((await unlink(f.context(), { installation: f.trigger.installation, userId: f.trigger.actor.userId, account: f.account })).ok).toBe(true)
  expect((await f.link(other)).ok).toBe(true)
  barrier.release(); await pending
  expect(await readJob(f.store, jid)).toBeUndefined()
  expect((await findLink(f.store, f.trigger.installation, f.trigger.actor.userId))?.account).toBe(other)
  expect(await readCounts(f.store, { sponsor: f.account, installation: f.trigger.installation, userId: f.trigger.actor.userId }, f.fake.clock.now)).toEqual({
    sponsorToday: 0, sponsorLive: 0, requesterHour: 0, installationToday: 0,
  })
})

test("account deletion on a foreign installation fences a slow sponsored admission", async () => {
  const f = await ready(), sponsor = randomUUID(), barrier = pause()
  expect((await f.link(sponsor)).ok).toBe(true)
  f.ports.repository = async (fullName) => { await barrier.stop(); return { id: 101, fullName, shared: false } }
  const jid = createJobId(f.fake.clock.now)
  const pending = f.intake().process(f.parsed, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: f.parsed.reply }).catch((error: unknown) => error)
  await barrier.wait
  await eraseEverywhereAccount({ ...f.context(), jobs: jobEraser(f.store) }, sponsor)
  barrier.release(); await pending
  expect(await readJob(f.store, jid)).toBeUndefined()
  expect((await readInstallSnapshot(f.store, f.trigger.installation))?.record.connector).toBe(f.account)
  expect(await getValue(f.store, everywhereKeys.accountClosed(sponsor))).toBe("closed")
  expect(await readCounts(f.store, { sponsor, installation: f.trigger.installation, userId: f.trigger.actor.userId }, f.fake.clock.now)).toMatchObject({ sponsorToday: 0, sponsorLive: 0 })
})

test("connector account erasure cancels foreign-sponsored bodies without an optional jobs port or active adapter", async () => {
  const f = await ready(), sponsor = randomUUID()
  expect((await f.link(sponsor)).ok).toBe(true)
  const created = await createJob(f.context(), { platform: "slack", installation: f.trigger.installation, kind: "mention",
    requester: { userId: f.trigger.actor.userId, account: sponsor }, sponsor, repository: { id: 101, fullName: "acme/app", shared: false },
    task: "The linked person's private task", context: [], shared: false })
  if (!created.ok) throw new Error("Fixture foreign sponsored job missing")
  expect((await readJobBody(f.context(), created.job.jid))?.task).toBe("The linked person's private task")
  await eraseEverywhereAccount({ ...f.context(), accountAuthority: async () => undefined }, f.account)
  expect((await readJob(f.store, created.job.jid))?.state).toBe("cancelled")
  expect(await readJobBody(f.context(), created.job.jid)).toBeUndefined()
  expect(await readInstallState(f.store, f.trigger.installation)).toBeUndefined()
  expect(await getValue(f.store, everywhereKeys.accountClosed(sponsor))).toBeUndefined()
  expect((await readJob(f.store, created.job.jid))?.sponsor).toBe(sponsor)
})

test("closing precedes cleanup, refuses reconnect, and resumes without deleting a later grant", async () => {
  const f = await ready(), before = (await readInstallSnapshot(f.store, f.trigger.installation))!, other = randomUUID()
  let first = true
  const jobs = { installation: async () => { if (first) { first = false; throw new Error("fixture cleanup interrupted") } }, account: async () => undefined }
  await expect(eraseInstallation({ ...f.context(), jobs }, f.trigger.installation, "disconnected", { expected: before })).rejects.toThrow("fixture cleanup interrupted")
  expect(await readInstallSnapshot(f.store, f.trigger.installation)).toBeUndefined()
  expect((await readInstallState(f.store, f.trigger.installation))?.record.closing?.authority).toBe(installationAuthority(before))
  await expect(recordInstall(f.context(), { account: other, event: "install", grant: f.grant })).rejects.toMatchObject({ code: "EVERYWHERE_INSTALLATION_CLOSING" })
  await eraseInstallation({ ...f.context(), jobs }, f.trigger.installation, "disconnected", { expected: before })
  expect((await recordInstall(f.context(), { account: other, event: "install", grant: f.grant })).ok).toBe(true)
  await f.link(other)
  await setMapping(f.context(), { account: other, installation: f.trigger.installation, place: f.parsed.place, repositories: [{ id: 202, fullName: "other/repository" }] })
  const replacement = state(f)
  await expect(eraseInstallation({ ...f.context(), jobs }, f.trigger.installation, "disconnected", { expected: before })).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(replacement)
})

test("a stale cleanup facade cannot mutate any replacement state or index", async () => {
  const f = await ready(), snapshot = (await readInstallSnapshot(f.store, f.trigger.installation))!
  const scoped = fencedStore(f.store, [{ key: everywhereKeys.install(f.trigger.installation), value: snapshot.raw }])
  await recordInstall(f.context(), { account: randomUUID(), event: "install", grant: f.grant })
  const replacement = state(f)
  await expect(scoped(["DEL", everywhereKeys.repo(f.trigger.installation, f.parsed.place)])).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  await expect(authorizedCommands(scoped, [{ key: everywhereKeys.link(f.trigger.installation, f.trigger.actor.userId), value: (await readLinkSnapshot(f.store, f.trigger.installation, f.trigger.actor.userId))!.raw }], [["SREM", everywhereKeys.repos(f.trigger.installation), f.parsed.place]])).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(replacement)
})

test("late account audit, OAuth state, link code and readiness cannot recreate erased records", async () => {
  const f = await ready()
  await createState(f.context(), { account: f.account, platform: "linear", purpose: "link" })
  await eraseEverywhereAccount({ ...f.context(), jobs: jobEraser(f.store) }, f.account)
  const erased = state(f)
  await appendAudit(f.store, f.account, { event: "install", platform: "slack", installation: f.trigger.installation }, f.fake.clock.now, testAccountAuthority)
  for (const action of [() => createState(f.context(), { account: f.account, platform: "linear", purpose: "link" }),
    () => issueLinkCode(f.context(), { account: f.account, platform: "slack" }), () => recordSeen(f.context(), f.account, f.computer)])
    await expect(action()).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(erased)
})

test("new native jobs overwrite spoofed link and install proofs with exact server snapshots", async () => {
  const f = await ready(), jid = createJobId(f.fake.clock.now)
  await f.intake().process({ ...f.parsed, reply: { ...f.parsed.reply, installRevision: "spoof", linkRevision: "spoof" } },
    { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: { ...f.parsed.reply, installRevision: "spoof", linkRevision: "spoof" } })
  const job = (await readJob(f.store, jid))!, link = (await readLinkSnapshot(f.store, f.trigger.installation, f.trigger.actor.userId))!
  expect(openReply(f.context(), job)?.installRevision).toBe(installationAuthority((await readInstallSnapshot(f.store, f.trigger.installation))!))
  expect(openReply(f.context(), job)?.linkRevision).toBe(link.record.revision)
})

test("an install that read absence cannot cross an entire connect-and-erase ABA", async () => {
  const f = routerFixture(), barrier = pause(), other = randomUUID()
  let once = true
  const store: Store = async (command) => {
    if (once && command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes('revision'))) { once = false; await barrier.stop() }
    return f.store(command)
  }
  const grant = { installation: f.trigger.installation, scopes: [], installer: { admin: true } }
  const pending = recordInstall({ ...f.context(), store }, { account: f.account, event: "install", grant })
  await barrier.wait
  await recordInstall(f.context(), { account: other, event: "install", grant })
  await eraseInstallation({ ...f.context(), jobs: jobEraser(f.store) }, f.trigger.installation, "disconnected")
  const epoch = await getValue(f.store, everywhereKeys.installEpoch(f.trigger.installation))
  expect(epoch).toMatch(/^[A-Za-z0-9_-]{22}$/)
  barrier.release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(await readInstallState(f.store, f.trigger.installation)).toBeUndefined()
  expect(await getValue(f.store, everywhereKeys.installEpoch(f.trigger.installation))).toBe(epoch)
  expect(await f.store(["SMEMBERS", everywhereKeys.installs(f.account)])).toEqual([])
})

test("an old install cannot retry over a completed erase and replacement with fresh indexes", async () => {
  const f = await ready(), barrier = pause(), other = randomUUID()
  let once = true
  const store: Store = async (command) => {
    if (once && command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes('revision'))) { once = false; await barrier.stop() }
    return f.store(command)
  }
  const pending = recordInstall({ ...f.context(), store }, { account: f.account, event: "install", grant: f.grant })
  await barrier.wait
  await eraseInstallation({ ...f.context(), jobs: jobEraser(f.store) }, f.trigger.installation, "disconnected")
  await recordInstall(f.context(), { account: other, event: "install", grant: f.grant })
  await f.link(other)
  await setMapping(f.context(), { account: other, installation: f.trigger.installation, place: f.parsed.place,
    repositories: [{ id: 202, fullName: "replacement/repository" }] })
  const replacement = state(f)
  barrier.release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(replacement)
})

test("a stale link redemption cannot retry over a newer successful account link", async () => {
  const f = await ready(), other = randomUUID(), barrier = pause()
  await unlink(f.context(), { installation: f.trigger.installation, userId: f.trigger.actor.userId, account: f.account })
  const code = await issueLinkCode(f.context(), { account: f.account, platform: "slack" })
  let once = true
  const store: Store = async (command) => {
    if (once && command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes('linkedAt'))) { once = false; await barrier.stop() }
    return f.store(command)
  }
  const pending = redeemLinkCode({ ...f.context(), store }, { installation: f.trigger.installation, userId: f.trigger.actor.userId,
    code: code.code, place: "private", actor: { bot: false, guest: false, external: false } })
  await barrier.wait
  await f.link(other)
  const replacement = state(f)
  barrier.release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(replacement)
})

test("a delayed mapping removal and requester mapping write preserve later connector state", async () => {
  const f = await ready(), barrier = pause()
  let once = true
  const store: Store = async (command) => {
    if (once && command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes(JSON.stringify(["DEL", everywhereKeys.repo(f.trigger.installation, f.parsed.place)])))) {
      once = false; await barrier.stop()
    }
    return f.store(command)
  }
  const pending = removeMapping({ ...f.context(), store }, { account: f.account, installation: f.trigger.installation, place: f.parsed.place })
  await barrier.wait
  await setMapping(f.context(), { account: f.account, installation: f.trigger.installation, place: f.parsed.place, repositories: [{ id: 202, fullName: "new/repository" }] })
  const replacement = state(f)
  barrier.release()
  await expect(pending).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(state(f)).toBe(replacement)
  const sponsorWait = pause()
  const byWord = setMappingByWord(f.context(), { installation: f.trigger.installation, place: "COTHER", userId: f.trigger.actor.userId,
    actor: { bot: false, guest: false, external: false }, repository: { id: 101, fullName: "acme/app" }, maySponsor: async () => { await sponsorWait.stop(); return true } })
  await sponsorWait.wait
  await eraseInstallation({ ...f.context(), jobs: jobEraser(f.store) }, f.trigger.installation, "disconnected")
  sponsorWait.release()
  await expect(byWord).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(await getValue(f.store, everywhereKeys.repo(f.trigger.installation, "COTHER"))).toBeUndefined()
})

test("held due jobs retire under exact job CAS without requeue or native effects", async () => {
  const f = await ready(), job = await f.create()
  expect((await offerJob(f.context(), job.jid, { queueUntil: f.fake.clock.now + 60_000 })).ok).toBe(true)
  await captureControl(f.context(), f.trigger.installation, "signed-control-generated")
  expect(await sweepAccount(f.context(), f.account)).toEqual([])
  expect((await readJob(f.store, job.jid))?.state).toBe("offered")
  expect(await getValue(f.store, everywhereKeys.jobBody(job.jid))).toBeDefined()
  f.fake.clock.advance(30_001)
  const ended = await sweepAccount(f.context(), f.account)
  expect(ended).toHaveLength(1)
  expect(ended[0]?.job.state).toBe("expired")
  expect(await getValue(f.store, everywhereKeys.jobBody(job.jid))).toBeUndefined()
  expect(await f.store(["ZRANGE", everywhereKeys.jobs(f.account), 0, -1])).toEqual([])
  await expect(createJobEvents(f.context, { slack: f.adapter }).ended!(ended[0]!)).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
  expect(f.calls.some((call) => call.kind === "finish")).toBe(false)
})

test("an unavailable account authority does not become proof to retire a job", async () => {
  const f = await ready(), job = await f.create()
  f.fake.clock.advance(600_001)
  const before = state(f)
  expect(await sweepAccount({ ...f.context(), accountAuthority: async () => undefined }, f.account)).toEqual([])
  expect(state(f)).toBe(before)
  expect((await readJob(f.store, job.jid))?.state).toBe("received")
})

test("all indexed readiness devices are erased and the active registry is bounded", async () => {
  const f = await ready()
  const readiness = { takesJobs: true, remote: true, localMode: false, sandbox: true, waitForComputer: true, capsRoom: true, projects: true }
  const devices = Array.from({ length: 65 }, () => randomBytes(16).toString("base64url"))
  for (const device of devices.slice(0, 64)) await recordSeen(f.context(), f.account, device, readiness)
  await expect(recordSeen(f.context(), f.account, devices[64]!, readiness)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  expect(await f.store(["ZCARD", everywhereKeys.readyDevices(f.account)])).toBe(64)
  await eraseEverywhereAccount({ ...f.context(), jobs: jobEraser(f.store) }, f.account)
  for (const device of devices) expect(await getValue(f.store, everywhereKeys.ready(f.account, device))).toBeUndefined()
  expect(await f.store(["ZCARD", everywhereKeys.readyDevices(f.account)])).toBe(0)
})

test("record/index operations reject wrong Redis types before changing any protected poststate", async () => {
  for (const mode of ["install", "mapping", "link", "closing", "job"] as const) {
    const f = routerFixture(), store = testEverywhereStore(f.fake.fetch), ctx = { ...f.context(), store }
    const installation = mode === "link" ? `linear:${randomUUID()}` : f.trigger.installation
    const grant = { installation, scopes: [], installer: { admin: true } }
    if (mode !== "install") await recordInstall(ctx, { account: f.account, event: "install", grant })
    let action: () => Promise<unknown>
    if (mode === "install") {
      await store(["SET", everywhereKeys.installs(f.account), "corrupt-index"])
      action = () => recordInstall(ctx, { account: f.account, event: "install", grant })
    } else if (mode === "mapping") {
      await store(["SET", everywhereKeys.repos(installation), "corrupt-index"])
      action = () => setMapping(ctx, { account: f.account, installation, place: "C123", repositories: [{ id: 101, fullName: "acme/app" }] })
    } else if (mode === "link") {
      await store(["SET", everywhereKeys.links(f.account), "corrupt-index"])
      action = () => linkBySignIn(ctx, { account: f.account, installation, userId: randomUUID(), actor: { bot: false, guest: false, external: false } })
    } else if (mode === "closing") {
      await store(["SET", everywhereKeys.closingInstalls(), "corrupt-index"])
      action = () => eraseInstallation(ctx, installation, "disconnected")
    } else {
      const code = await issueLinkCode(ctx, { account: f.account, platform: "slack" })
      await redeemLinkCode(ctx, { installation, userId: f.trigger.actor.userId, code: code.code, place: "private", actor: { bot: false, guest: false, external: false } })
      await store(["SET", everywhereKeys.jobHistory(f.account), "corrupt-index"])
      action = () => createJob(ctx, { platform: "slack", installation, kind: "mention", requester: { userId: f.trigger.actor.userId, account: f.account },
        sponsor: f.account, repository: { id: 101, fullName: "acme/app", shared: false }, task: "Make my requested change", context: [], shared: false })
    }
    const before = state(f), expiry = JSON.stringify([...f.fake.expires])
    await expect(action()).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(state(f)).toBe(before)
    expect(JSON.stringify([...f.fake.expires])).toBe(expiry)
  }
})

test("noncanonical later counters fail before any quota increment or native admission write", async () => {
  for (const malformed of ["00", "01"]) {
    const f = await ready(), store = testEverywhereStore(f.fake.fetch), ctx = { ...f.context(), store }
    const subject = { sponsor: f.account, installation: f.trigger.installation, userId: f.trigger.actor.userId }, caps = capKeys(subject, ctx.now)
    await store(["SET", caps.sponsorToday.key, "0"])
    await store(["SET", caps.requesterHour.key, malformed])
    await store(["SET", caps.installationToday.key, "0"])
    await expect(readCounts(store, subject, ctx.now)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    const install = (await readInstallSnapshot(store, subject.installation))!, link = (await readLinkSnapshot(store, subject.installation, subject.userId))!
    const jid = createJobId(ctx.now), deliveryId = randomUUID()
    await claimDelivery(store, "slack", deliveryId, jid)
    const before = state(f), expiry = JSON.stringify([...f.fake.expires])
    await expect(createJob(ctx, { platform: "slack", installation: subject.installation, kind: "mention", requester: { userId: subject.userId, account: subject.sponsor },
      sponsor: subject.sponsor, repository: { id: 101, fullName: "acme/app", shared: false }, shared: false, task: "Make my requested change", context: [] },
    { jid, deliveryId, installationRecord: install.raw, linkRecord: link.raw })).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(state(f)).toBe(before)
    expect(JSON.stringify([...f.fake.expires])).toBe(expiry)
    expect(await getValue(store, caps.sponsorToday.key)).toBe("0")
    expect(await getValue(store, caps.requesterHour.key)).toBe(malformed)
    expect(await getValue(store, caps.installationToday.key)).toBe("0")
    expect(await readJob(store, jid)).toBeUndefined()
  }
})

test("a consumed older code cannot link after a newer code replaces its live pointer", async () => {
  const f = await ready(), barrier = pause()
  await unlink(f.context(), { installation: f.trigger.installation, userId: f.trigger.actor.userId, account: f.account })
  const older = await issueLinkCode(f.context(), { account: f.account, platform: "slack" })
  let once = true
  const pending = redeemLinkCode({ ...f.context(), store: async (command) => {
    if (once && command[0] === "EVAL" && typeof command[1] === "string" && command[1].endsWith(SWAP_SCRIPT)) { once = false; await barrier.stop() }
    return f.store(command)
  } }, { installation: f.trigger.installation, userId: f.trigger.actor.userId, code: older.code, place: "private", actor: { bot: false, guest: false, external: false } })
  await barrier.wait
  const newer = await issueLinkCode(f.context(), { account: f.account, platform: "slack" })
  const pointer = await getValue(f.store, everywhereKeys.linkCodes(f.account))
  barrier.release()
  expect(await pending).toEqual({ ok: false, code: "link-invalid" })
  expect(await findLink(f.store, f.trigger.installation, f.trigger.actor.userId)).toBeUndefined()
  expect(await getValue(f.store, everywhereKeys.linkCodes(f.account))).toBe(pointer)
  expect((await redeemLinkCode(f.context(), { installation: f.trigger.installation, userId: f.trigger.actor.userId, code: newer.code,
    place: "private", actor: { bot: false, guest: false, external: false } })).ok).toBe(true)
})

test("an absent mapping snapshot cannot borrow a later mapping to admit a job", async () => {
  const f = await ready(), key = everywhereKeys.repo(f.trigger.installation, f.parsed.place), barrier = pause()
  await f.store(["DEL", key])
  let once = true, repositoryCalls = 0
  f.ports.repository = async (fullName) => { repositoryCalls++; return { id: 101, fullName, shared: false } }
  const store: Store = async (command) => {
    const result = await f.store(command)
    if (once && command[0] === "GET" && command[1] === key) { once = false; await barrier.stop() }
    return result
  }
  const jid = createJobId(f.fake.clock.now)
  const pending = createIntake(f.adapter, { config: { ...f.config, offer: f.context().offer }, store, ports: f.ports, now: () => f.fake.clock.now,
    sleep: f.routing.sleep }).process(f.parsed, { jid, platform: "slack", installation: f.trigger.installation, shared: false, reply: f.parsed.reply })
  await barrier.wait
  await setMapping(f.context(), { account: f.account, installation: f.trigger.installation, place: f.parsed.place, repositories: [{ id: 101, fullName: "acme/app" }] })
  barrier.release(); await pending
  expect(repositoryCalls).toBe(0)
  expect(await readJob(f.store, jid)).toBeUndefined()
  expect(await readCounts(f.store, { sponsor: f.account, installation: f.trigger.installation, userId: f.trigger.actor.userId }, f.fake.clock.now)).toMatchObject({ sponsorToday: 0, sponsorLive: 0 })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("real Redis authority fences", () => {
  let redis: RealRedis
  beforeAll(async () => { redis = (await realRedis())! })
  afterAll(async () => { await redis?.close() })
  test("atomic admission rejects an erased link and a deleting account before every quota/index write", async () => {
    const store = testEverywhereStore(redis.fetch), f = routerFixture(), account = randomUUID()
    const ctx = { ...f.context(), store, now: Date.now(), accountAuthority: testAccountAuthority }
    const installation = `slack:T${randomBytes(6).toString("hex").toUpperCase()}`, userId = "U0ALICE01"
    await recordInstall(ctx, { account, event: "install", grant: { installation, scopes: [], installer: { admin: true } } })
    const code = await issueLinkCode(ctx, { account, platform: "slack", installation })
    await redeemLinkCode(ctx, { installation, userId, code: code.code, place: "private", actor: { bot: false, external: false, guest: false } })
    const install = (await readInstallSnapshot(store, installation))!, link = (await readLinkSnapshot(store, installation, userId))!
    const jid = createJobId(ctx.now), delivery = randomUUID()
    await claimDelivery(store, "slack", delivery, jid)
    const input = { platform: "slack" as const, installation, kind: "mention" as const, requester: { userId, account }, sponsor: account,
      repository: { id: 101, fullName: "acme/app", shared: false }, shared: false, task: "Make my requested change", context: [] }
    const barrier = pause()
    const pending = createJob({ ...ctx, store: async (command) => {
      if (command[0] === "EVAL" && typeof command[1] === "string" && command[1].endsWith(CREATE_JOB_SCRIPT)) await barrier.stop()
      return store(command)
    } }, input, { jid, deliveryId: delivery, installationRecord: install.raw, linkRecord: link.raw })
    await barrier.wait
    await unlink(ctx, { installation, userId, account })
    barrier.release()
    expect(await pending).toMatchObject({ ok: false, code: "installation-changed" })
    expect(await readJob(store, jid)).toBeUndefined()
    const guards = await accountGuards(ctx, account)
    await redis.fetch("https://kv.everywhere-fakes.invalid", { method: "POST", headers: { authorization: "Bearer everywhere-fake-kv" }, body: JSON.stringify(["SET", `vector:codium:test:tombstone:${account}`, "deleting"]) })
    await expect(authorizedScript(store, guards, CREATE_JOB_SCRIPT, [everywhereKeys.job(jid)], [])).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
    expect(await readJob(store, jid)).toBeUndefined()
    expect(await readCounts(store, { sponsor: account, installation, userId }, ctx.now)).toMatchObject({ sponsorToday: 0, sponsorLive: 0, requesterHour: 0, installationToday: 0 })
  })
  test("concurrent readiness writes honor the64-device bound and account cleanup erases every accepted device", async () => {
    const f = routerFixture(), store = testEverywhereStore(redis.fetch), account = randomUUID()
    const ctx = { ...f.context(), store, now: Date.now(), accountAuthority: testAccountAuthority }
    const devices = Array.from({ length: 65 }, () => randomBytes(16).toString("base64url"))
    const readiness = { takesJobs: true, remote: true, localMode: false, sandbox: true, waitForComputer: true, capsRoom: true, projects: true }
    const results = await Promise.allSettled(devices.map((device) => recordSeen(ctx, account, device, readiness)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(64)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await store(["ZCARD", everywhereKeys.readyDevices(account)])).toBe(64)
    await eraseEverywhereAccount(ctx, account)
    expect(await store(["ZCARD", everywhereKeys.readyDevices(account)])).toBe(0)
    for (const device of devices) expect(await getValue(store, everywhereKeys.ready(account, device))).toBeUndefined()
  })

  test("Redis wrong-type index leaves install, epoch, quota and record poststate untouched", async () => {
    const f = routerFixture(), store = testEverywhereStore(redis.fetch), account = randomUUID(), installation = `slack:T${randomBytes(8).toString("hex").toUpperCase()}`
    const ctx = { ...f.context(), store, now: Date.now() }
    await store(["SET", everywhereKeys.installs(account), "corrupt-index"])
    await expect(recordInstall(ctx, { account, event: "install", grant: { installation, scopes: [], installer: { admin: true } } })).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(await getValue(store, everywhereKeys.install(installation))).toBeUndefined()
    expect(await getValue(store, everywhereKeys.installEpoch(installation))).toBeUndefined()
    expect(await getValue(store, everywhereKeys.installs(account))).toBe("corrupt-index")
    expect(await getValue(store, everywhereKeys.audit(account))).toBeUndefined()
  })

  test("a concurrent cleanup cannot finalize an in-flight native revocation or admit a replacement early", async () => {
    const f = routerFixture(), store = testEverywhereStore(redis.fetch), account = randomUUID(), replacement = randomUUID()
    const installation = `slack:T${randomBytes(8).toString("hex").toUpperCase()}`, ctx = { ...f.context(), store, now: Date.now() }
    const grant = { installation, token: `generated-${randomUUID()}`, scopes: [], installer: { admin: true } }
    await recordInstall(ctx, { account, event: "install", grant })
    const barrier = pause()
    let proof!: () => Promise<void>, calls = 0
    const pending = eraseInstallation({ ...ctx, revoke: async (_installation, _record, beforeRequest) => {
      calls++; proof = beforeRequest; await proof(); await barrier.stop(); return "confirmed"
    } }, installation, "disconnected")
    await barrier.wait
    expect((await readInstallState(store, installation))?.record.closing?.revocation).toBe("pending")
    expect((await eraseInstallation(ctx, installation, "disconnected")).nativePending).toBe(true)
    expect((await readInstallState(store, installation))?.record.tokenEnc).toBeUndefined()
    await expect(recordInstall(ctx, { account: replacement, event: "install", grant })).rejects.toMatchObject({ code: "EVERYWHERE_INSTALLATION_CLOSING" })
    barrier.release()
    expect((await pending).nativePending).toBeUndefined()
    await recordInstall(ctx, { account: replacement, event: "install", grant })
    const current = (await readInstallSnapshot(store, installation))!
    await expect(proof()).rejects.toMatchObject({ code: "EVERYWHERE_AUTHORITY_CHANGED" })
    expect((await readInstallSnapshot(store, installation))?.raw).toBe(current.raw)
    expect(await store(["SMEMBERS", everywhereKeys.installs(replacement)])).toEqual([installation])
    expect(await store(["SMEMBERS", everywhereKeys.installs(account)])).toEqual([])
    expect(calls).toBe(1)
  })

  test("actual Lua rejects 00 and 01 later counters before changing any earlier counter or poststate", async () => {
    const f = routerFixture(), store = testEverywhereStore(redis.fetch), account = randomUUID(), installation = `slack:T${randomBytes(8).toString("hex").toUpperCase()}`
    const ctx = { ...f.context(), store, now: Date.now() }, userId = "U0ALICE01"
    await recordInstall(ctx, { account, event: "install", grant: { installation, scopes: [], installer: { admin: true } } })
    const code = await issueLinkCode(ctx, { account, platform: "slack", installation })
    await redeemLinkCode(ctx, { installation, userId, code: code.code, place: "private", actor: { bot: false, guest: false, external: false } })
    const install = (await readInstallSnapshot(store, installation))!, link = (await readLinkSnapshot(store, installation, userId))!
    const subject = { sponsor: account, installation, userId }, caps = capKeys(subject, ctx.now)
    for (const malformed of ["00", "01"]) {
      await store(["SET", caps.sponsorToday.key, "0"])
      await store(["SET", caps.requesterHour.key, malformed])
      await store(["SET", caps.installationToday.key, "0"])
      await expect(readCounts(store, subject, ctx.now)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      const jid = createJobId(ctx.now), deliveryId = randomUUID()
      await claimDelivery(store, "slack", deliveryId, jid)
      const keys = [caps.sponsorToday.key, caps.requesterHour.key, caps.installationToday.key, everywhereKeys.job(jid), everywhereKeys.jobBody(jid),
        everywhereKeys.delivery("slack", deliveryId), everywhereKeys.install(installation), everywhereKeys.installEpoch(installation), everywhereKeys.link(installation, userId)]
      const before = await store(["MGET", ...keys])
      const due = await store(["ZRANGE", everywhereKeys.jobsDue(), 0, -1])
      const history = await store(["ZRANGE", everywhereKeys.jobHistory(account), 0, -1])
      await expect(createJob(ctx, { platform: "slack", installation, kind: "mention", requester: { userId, account }, sponsor: account,
        repository: { id: 101, fullName: "acme/app", shared: false }, shared: false, task: "Make my requested change", context: [] },
      { jid, deliveryId, installationRecord: install.raw, linkRecord: link.raw })).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      expect(await store(["MGET", ...keys])).toEqual(before)
      expect(await store(["ZRANGE", everywhereKeys.jobsDue(), 0, -1])).toEqual(due)
      expect(await store(["ZRANGE", everywhereKeys.jobHistory(account), 0, -1])).toEqual(history)
      expect(await store(["ZRANGE", everywhereKeys.jobs(account), 0, -1])).toEqual([])
    }
  })

})
