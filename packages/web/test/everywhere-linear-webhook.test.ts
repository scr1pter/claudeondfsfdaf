import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { claimDelivery } from "../../../api/_lib/everywhere/dedupe"
import { findLink, installationAuthority, setMapping } from "../../../api/_lib/everywhere/identity"
import { CREATE_JOB_SCRIPT, cancelJob, createJob, claimJob, readJob, readJobBody, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { readCounts } from "../../../api/_lib/everywhere/limits"
import { REPLACE_NATIVE_RESERVATION_SCRIPT, replaceNativeReservation } from "../../../api/_lib/everywhere/native-resource"
import { createLinearAdapter } from "../../../api/_lib/everywhere/linear/adapter"
import { createLinearWebhook } from "../../../api/_lib/everywhere/linear/routes"
import { parseLinear } from "../../../api/_lib/everywhere/linear/parse"
import { everywhereStore, type Store } from "../../../api/_lib/everywhere/store"
import { createJobId } from "../../../packages/schema/src/everywhere"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeLinear, linearFixture } from "./lib/everywhere-linear"
import { realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()
const native = new FakeLinear()
const harness = new RouteHarness()
let restore: () => void
beforeAll(async () => { restore = useKv(); native.start(); await harness.start() })
afterAll(async () => { await drainAfter(); await harness.stop(); await native.stop(); restore() })

async function ready(mapped = false) {
  const f = await linearFixture(native)
  harness.mount({ "/linear": createLinearWebhook(f.deps) })
  const send = (body: unknown, delivery = randomUUID(), event = "AgentSessionEvent") => harness.call("POST", "/linear", { body, headers: f.sign(JSON.stringify(body), delivery, event) })
  if (mapped) {
    expect((await f.link()).ok).toBe(true)
    expect((await setMapping(f.context(), { account: f.account, installation: f.installation, place: native.team,
      repositories: [{ id: 101, fullName: "acme/app" }], private: false })).ok).toBe(true)
    await recordSeen(f.context(), f.account, f.computer)
    f.ports.offer = async () => {
      const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
      expect((await claimJob(f.context(), { account: f.account, jid, device: f.computer })).ok).toBe(true)
      return "sent"
    }
  }
  return { ...f, send }
}

test("invalid signatures, stale timestamps and app/header mismatches never read the store", async () => {
  const f = await ready()
  let reads = 0
  harness.mount({ "/linear": createLinearWebhook({ ...f.deps, context: () => ({ ...f.context(), store: async () => { reads++; throw new Error("Must not read") } }) }) })
  expect((await harness.call("POST", "/linear", { body: f.envelope() })).status).toBe(401)
  expect((await f.send({ ...f.envelope(), webhookTimestamp: f.fake.clock.now - 61_000 })).status).toBe(401)
  expect((await f.send({ ...f.envelope(), oauthClientId: "wrong-app" })).status).toBe(400)
  expect((await f.send(f.envelope(), randomUUID(), "OAuthApp")).status).toBe(400)
  expect(reads).toBe(0)
})

test("HTTP acknowledgement precedes a stalled store and the first thought precedes a slow routing port", async () => {
  const f = await ready(true)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  harness.mount({ "/linear": createLinearWebhook({ ...f.deps, context: () => ({ ...f.context(), store: async (command) => { await blocked; return f.store(command) } }) }) })
  const body = f.envelope()
  const start = performance.now()
  expect((await f.send(body)).status).toBe(200)
  expect(performance.now() - start).toBeLessThan(3000)
  expect(native.calls).toHaveLength(0)
  f.ports.presence = async () => {
    expect(native.calls.some((call) => call.operation === "create" && (call.variables.input as { content: { type: string } }).content.type === "thought")).toBe(true)
    return { online: true, computers: 1 }
  }
  release()
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
})

test("unlinked native identity receives a targeted auth signal and signed-body dedupe survives a changed header", async () => {
  const f = await ready()
  const body = f.envelope()
  const delivery = randomUUID()
  expect((await f.send(body, delivery)).status).toBe(200)
  await drainAfter()
  const auth = native.calls.filter((call) => call.operation === "create").map((call) => call.variables.input as Record<string, unknown>).find((input) => input.signal === "auth")
  expect(auth?.signalMetadata).toMatchObject({ userId: native.user, providerName: "Vector", url: "https://vectordev.ai/everywhere" })
  const before = native.calls.length
  expect((await f.send(body, delivery)).status).toBe(200)
  expect((await f.send(body)).status).toBe(200)
  await drainAfter()
  expect(native.calls).toHaveLength(before)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
})

test("only the creator's immutable activity is task text; all editable material stays context", async () => {
  const f = await ready(true)
  const body = f.envelope("Repair the requester-owned task", { action: "prompted" })
  expect((await f.send(body)).status).toBe(200)
  await drainAfter()
  const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
  expect(await readJob(f.store, jid)).toMatchObject({ state: "claimed", sponsor: f.account, shared: true, issue: { key: "ENG-123" } })
  const stored = await readJobBody(f.context(), jid)
  expect(stored?.task).toBe("Repair the requester-owned task")
  expect(stored?.context.some((item) => item.from === "platform" && item.text.includes("Edited description"))).toBe(true)
  expect(stored?.task).not.toContain("export secrets")
  const before = native.calls.length
  expect((await f.send(f.envelope("Spend the creator's budget", { action: "prompted", user: randomUUID() }))).status).toBe(200)
  await drainAfter()
  expect(native.calls).toHaveLength(before)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
})

test("delegation has a fixed task representation but cannot spend without a human-origin activity", async () => {
  const f = await ready(true)
  const body = f.envelope("ignored", { origin: false })
  const parsed = parseLinear(body, `${native.organization}:created:${native.session}`, f.snapshot.record)
  expect("ignore" in parsed ? undefined : parsed.trigger.task).toBe("Work on this issue.")
  expect((await f.send(body)).status).toBe(200)
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
  expect(native.calls.filter((call) => call.operation === "create").map((call) => (call.variables.input as { content: { type: string } }).content.type)).toEqual(["thought", "elicitation"])
})

test("guest, application and foreign identities are refused before quota or job admission", async () => {
  for (const patch of [{ guest: true }, { app: true }, { active: false }, { organization: { id: randomUUID() } }]) {
    const f = await ready(true)
    Object.assign(native.member, patch)
    expect((await f.send(f.envelope())).status).toBe(200)
    await drainAfter()
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
    expect(await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).toMatchObject({ sponsorToday: 0 })
  }
})

test("concurrent native prompts reserve only one job in the same session", async () => {
  const f = await ready(true)
  const answers = await Promise.all([f.send(f.envelope("First task", { action: "prompted" })), f.send(f.envelope("Second task", { action: "prompted" }))])
  expect(answers.every((answer) => answer.status === 200)).toBe(true)
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
  expect(await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).toMatchObject({ sponsorToday: 1, requesterHour: 1 })
})

test("a pending native reservation stays fenced until its short lease expires", async () => {
  const f = await ready(true)
  const body = f.envelope("Own request", { action: "prompted" })
  const parsed = parseLinear(body, `${native.organization}:prompted:${body.agentActivity!.id}`, f.snapshot.record)
  if ("ignore" in parsed) throw new Error(parsed.ignore)
  const first = { jid: createJobId(f.fake.clock.now), platform: "linear" as const, installation: f.installation, shared: true,
    reply: { ...parsed.reply, installRevision: installationAuthority(f.snapshot) } }
  const next = { ...first, jid: createJobId(f.fake.clock.now + 1) }
  expect(await f.adapter.reserve!(parsed, first)).toEqual({ resource: native.session, owner: first.jid })
  expect(await f.adapter.reserve!(parsed, next)).toBeUndefined()
  f.fake.clock.advance(30_001)
  expect(await f.adapter.reserve!(parsed, next)).toEqual({ resource: native.session, owner: next.jid })
  expect(await f.store(["GET", everywhereKeys.nativeResource("linear", f.installation, native.session)])).toBe(next.jid)
})

test("a cap race after reservation releases only the rejected request's pending pointer", async () => {
  const f = await ready(true)
  let race = true
  const store: Store = async (command) => {
    if (race && command[0] === "EVAL" && command[1] === CREATE_JOB_SCRIPT) {
      race = false
      for (let index = 0; index < 3; index++) expect((await createJob(f.context(), {
        platform: "linear", installation: f.installation, kind: "mention", sponsor: f.account, requester: { userId: native.user, account: f.account },
        repository: { id: 101, fullName: "acme/app", shared: false }, issue: { key: "ENG-123" }, task: "Other accepted work", context: [], shared: true,
      })).ok).toBe(true)
    }
    return f.store(command)
  }
  harness.mount({ "/linear": createLinearWebhook({ ...f.deps, context: () => ({ ...f.context(), store }) }) })
  expect((await f.send(f.envelope("Racing task", { action: "prompted" }))).status).toBe(200)
  await drainAfter()
  expect(await f.store(["GET", everywhereKeys.nativeResource("linear", f.installation, native.session)])).toBeNull()
  expect(await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).toMatchObject({ sponsorToday: 0, requesterHour: 0, sponsorLive: 3 })
})

test("native stop cancels only its sponsor and does not make further context, plan or issue API calls", async () => {
  const f = await ready(true)
  const active = await f.job()
  native.calls = []
  expect((await f.send(f.envelope("Stop", { action: "prompted", signal: "stop", user: randomUUID() }))).status).toBe(200)
  await drainAfter()
  expect((await readJob(f.store, active.view.jid))?.state).toBe("running")
  expect(native.calls).toHaveLength(0)
  expect((await f.send(f.envelope("Stop", { action: "prompted", signal: "stop" }))).status).toBe(200)
  await drainAfter()
  expect((await readJob(f.store, active.view.jid))?.state).toBe("cancelled")
  expect(native.calls.map((call) => call.operation)).toEqual(["create"])
  expect((native.calls[0]?.variables.input as { content: { type: string } }).content.type).toBe("response")
  const newer = await f.job()
  const oldStop = f.envelope("Stop", { action: "prompted", signal: "stop" })
  expect((await f.send(oldStop)).status).toBe(200)
  await drainAfter()
  expect((await readJob(f.store, newer.view.jid))?.state).toBe("cancelled")
  const newest = await f.job()
  const before = native.calls.length
  expect((await f.send(oldStop, randomUUID())).status).toBe(200)
  await drainAfter()
  expect((await readJob(f.store, newest.view.jid))?.state).toBe("running")
  expect(native.calls).toHaveLength(before)
})

test("revocation and definite team-access removal erase links and live bodies", async () => {
  for (const permission of [false, true]) {
    const f = await ready(true)
    const active = await f.job()
    const body = { type: permission ? "PermissionChange" : "OAuthApp", action: permission ? "teamAccessChanged" : "revoked",
      oauthClientId: f.config.linear!.clientId, organizationId: native.organization, appUserId: native.bot, webhookTimestamp: f.fake.clock.now,
      ...(permission ? { removedTeamIds: [native.team], addedTeamIds: [], canAccessAllPublicTeams: false } : {}) }
    expect((await f.send(body, randomUUID(), body.type)).status).toBe(200)
    await drainAfter()
    expect(await f.store(["GET", everywhereKeys.install(f.installation)])).toBeNull()
    expect(await f.store(["GET", everywhereKeys.jobBody(active.view.jid)])).toBeNull()
    expect(await findLink(f.store, f.installation, native.user)).toBeUndefined()
  }
})

test("a native authentication failure erases the current installation before any task can be admitted", async () => {
  const f = await ready(true)
  native.answer = (operation) => operation === "user" ? new Response(null, { status: 401 }) : undefined
  expect((await f.send(f.envelope("Do the task", { action: "prompted" }))).status).toBe(200)
  await drainAfter()
  expect(await f.store(["GET", everywhereKeys.install(f.installation)])).toBeNull()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
  expect(await findLink(f.store, f.installation, native.user)).toBeUndefined()
})

async function reservationFence(store: Store) {
  const f = await linearFixture(native)
  const context = { ...f.context(), store }
  const installation = `linear:${randomUUID()}`
  const raw = JSON.stringify({ connector: f.account, installedAt: context.now, scopes: [] })
  await store(["SET", everywhereKeys.install(installation), raw])
  const resource = randomUUID()
  const old = createJobId(context.now)
  const winner = createJobId(context.now + 1)
  const deliveryId = randomUUID()
  expect(await claimDelivery(store, "linear", deliveryId, old)).toBe("new")
  await store(["SET", everywhereKeys.nativeResource("linear", installation, resource), old, "PX", 30_000])
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const pending = createJob({ ...context, store: async (command) => { if (command[0] === "EVAL" && command[1] === CREATE_JOB_SCRIPT) { enter(); await blocked }; return store(command) } }, {
    platform: "linear", installation, kind: "followup", sponsor: f.account, requester: { userId: native.user, account: f.account },
    repository: { id: 101, fullName: "acme/app", shared: false }, issue: { key: "ENG-123" }, task: "Original request", context: [], shared: true,
  }, { jid: old, deliveryId, installationRecord: raw, reservation: { resource, owner: old } })
  await entered
  await store(["SET", everywhereKeys.nativeResource("linear", installation, resource), winner, "PX", 30_000])
  release()
  expect(await pending).toEqual({ ok: false, code: "reservation-changed" })
  expect(await readJob(store, old)).toBeUndefined()
  expect(await store(["GET", everywhereKeys.nativeResource("linear", installation, resource)])).toBe(winner)
  expect(await readCounts(store, { sponsor: f.account, installation, userId: native.user }, context.now)).toEqual({ sponsorToday: 0, requesterHour: 0, installationToday: 0, sponsorLive: 0 })
  const winningDelivery = randomUUID()
  expect(await claimDelivery(store, "linear", winningDelivery, winner)).toBe("new")
  const accepted = await createJob(context, { platform: "linear", installation, kind: "followup", sponsor: f.account,
    requester: { userId: native.user, account: f.account }, repository: { id: 101, fullName: "acme/app", shared: false },
    issue: { key: "ENG-123" }, task: "Winning request", context: [], shared: true,
  }, { jid: winner, deliveryId: winningDelivery, installationRecord: raw, reservation: { resource, owner: winner } })
  expect(accepted.ok).toBe(true)
  expect(Number(await store(["PTTL", everywhereKeys.nativeResource("linear", installation, resource)]))).toBeGreaterThan(2 * 60 * 60_000)
  expect(await readCounts(store, { sponsor: f.account, installation, userId: native.user }, context.now)).toEqual({ sponsorToday: 1, requesterHour: 1, installationToday: 1, sponsorLive: 1 })
}

test("a stale native reservation cannot admit or charge quota after another request takes ownership", async () => {
  const f = await linearFixture(native)
  await reservationFence(f.store)
})

test("a lost terminal-reservation replacement response cannot leave an unexpiring pending owner", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  expect((await cancelJob(f.context(), active.view.jid)).ok).toBe(true)
  const owner = createJobId(f.fake.clock.now)
  const key = everywhereKeys.nativeResource("linear", f.installation, native.session)
  const adapter = createLinearAdapter({ ...f.deps, context: () => ({ ...f.context(), store: async (command) => {
    const result = await f.store(command)
    if (command[0] === "EVAL" && command[1] === REPLACE_NATIVE_RESERVATION_SCRIPT) throw new Error("Generated lost reservation response")
    return result
  } }) })
  const view = { ...active.view, job: undefined, jid: owner }
  await expect(adapter.reserve!(active.parsed, view)).rejects.toThrow("Generated lost reservation response")
  expect(await f.store(["GET", key])).toBe(owner)
  expect(Number(await f.store(["PTTL", key]))).toBe(30_000)
  expect(await f.adapter.reserve!(active.parsed, { ...view, jid: createJobId(f.fake.clock.now) })).toBeUndefined()
  f.fake.clock.advance(30_001)
  const next = { ...view, jid: createJobId(f.fake.clock.now) }
  expect(await f.adapter.reserve!(active.parsed, next)).toEqual({ resource: native.session, owner: next.jid })
})

async function reservationReplacement(store: Store) {
  const installation = `linear:${randomUUID()}`
  const key = everywhereKeys.nativeResource("linear", installation, randomUUID())
  const previous = createJobId(Date.now())
  const owners = Array.from({ length: 12 }, () => createJobId(Date.now()))
  await store(["SET", key, previous, "PX", 60_000])
  const results = await Promise.all(owners.map((owner) => replaceNativeReservation(store, key, previous, owner)))
  expect(results.filter(Boolean)).toHaveLength(1)
  const winner = owners[results.findIndex(Boolean)]!
  expect(await store(["GET", key])).toBe(winner)
  expect(Number(await store(["PTTL", key]))).toBeGreaterThan(0)
  expect(Number(await store(["PTTL", key]))).toBeLessThanOrEqual(30_000)
  expect(await replaceNativeReservation(store, key, previous, createJobId(Date.now()))).toBe(false)
  expect(await store(["GET", key])).toBe(winner)
}

test("terminal native reservation replacement is one fenced owner and expiry transaction", async () => {
  await reservationReplacement((await linearFixture(native)).store)
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("actual Redis native resource fence", () => {
  let redis: RealRedis
  beforeAll(async () => { redis = (await realRedis())! })
  afterAll(async () => { await redis?.close() })
  test("key12 ownership change before EVAL refuses the stale native job before quota writes", async () => {
    await reservationFence(everywhereStore(redis.fetch))
  })
  test("terminal native reservation replacement races leave one short-lived owner", async () => {
    await reservationReplacement(everywhereStore(redis.fetch))
  })
})
