import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import { AUDIT_APPEND_SCRIPT, readAudit } from "../../../api/_lib/everywhere/audit"
import { readConfig, type OfferKey } from "../../../api/_lib/everywhere/config"
import type { DataKey } from "../../../api/_lib/everywhere/crypto"
import { claimDelivery, finishDelivery } from "../../../api/_lib/everywhere/dedupe"
import { eraseEverywhereAccount } from "../../../api/_lib/everywhere/erase"
import {
  ACTIONS_CRON_GRACE_MS,
  ACTIONS_OVERDUE_MS,
  CREATE_JOB_SCRIPT,
  RECEIVED_STALE_MS,
  TRANSITION_SCRIPT,
  cancelJob,
  claimJob,
  clearSummary,
  createJob,
  declineJob,
  dispatchJob,
  encodeJobRecord,
  eraseAccountJobs,
  eraseInstallationJobs,
  expectedBranch,
  jobEraser,
  offerJob,
  offerWaiting,
  openReply,
  openSummary,
  queueJob,
  readComputer,
  readJob,
  readJobBody,
  recordSeen,
  refuseJob,
  reportJob,
  settleDispatched,
  settleJob,
  startDispatched,
  sweepAccount,
  sweepDue,
  type ActionsOutcome,
  type ActionsRunEnd,
  type JobRecord,
  type JobsContext,
  type NewJob,
  type Readiness,
} from "../../../api/_lib/everywhere/jobs"
import { KEEP_MS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { readCounts } from "../../../api/_lib/everywhere/limits"
import { ownOfferKeys, verifyOffer } from "../../../api/_lib/everywhere/offer"
import {
  runScript,
  storeUnavailable,
  type Store,
  type StoreCommand,
} from "../../../api/_lib/everywhere/store"
import { TIMING, createJobId, decodeJob, type Settle } from "../../../packages/schema/src/everywhere"
import { everywhereEnv } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { seedJobAuthority } from "./lib/everywhere-job-authority"
import { FakeStore, realRedis, useKv, type RealRedis, testEverywhereStore, testAccountAuthority } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-05, E4 and E8: the job state machine. Every change is one EVAL fenced by the record's version, so a claim racing
 * a dispatch, or twelve computers claiming at once, leave exactly one winner. Bodies are sealed and live at most two
 * hours; no job waits longer than its body; a claim that finds the body gone ends the job `expired`. A laptop lease
 * without reports for five minutes becomes `lost`, an Actions run never does, and a dispatch with no start hook in
 * 900 s fails. The atomic paths also run against a real Redis when VECTOR_TEST_REDIS_URL is set (CI).
 */

let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

const ALICE = randomUUID()
const BOB = randomUUID()
const SLACK = "slack:T0123ABCD"
const SLACK_OTHER = "slack:T0999ZZZZ"
const LINEAR = `linear:${randomUUID()}`
const JIRA = `jira:${randomUUID()}`
const GITHUB = "github:4242"
const OFFER: OfferKey = { kid: "test-offer-key", key: generateKeyPairSync("ed25519").privateKey }
const KEYS: readonly DataKey[] = readConfig(everywhereEnv()).dataKeys

function device() {
  return randomBytes(16).toString("base64url")
}

let fake: FakeStore
let store: Store
beforeEach(() => {
  fake = new FakeStore()
  store = testEverywhereStore(fake.fetch)
})

function ctx(extra: Partial<JobsContext> = {}): JobsContext {
  return { store, keys: KEYS, now: fake.clock.now, offer: OFFER, accountAuthority: testAccountAuthority, ...extra }
}

function slackJob(extra: Partial<NewJob> = {}): NewJob {
  return {
    platform: "slack",
    installation: SLACK,
    kind: "mention",
    requester: { userId: "U0ALICE01", account: ALICE, label: "Alice <@U0ALICE01>" },
    sponsor: ALICE,
    repository: { id: 101, fullName: "acme/app", shared: false },
    shared: false,
    task: "Fix the login bug on Safari",
    context: [{ from: "teammate", text: "It fails after the redirect." }],
    reply: { channel: "C0123", thread: "1731335400.000100" },
    ...extra,
  }
}

async function created(input: NewJob = slackJob(), extra: Partial<JobsContext> = {}) {
  await seedJobAuthority(ctx(), input)
  const verdict = await createJob(ctx(extra), input)
  if (!verdict.ok) throw new Error(`createJob refused: ${verdict.code}`)
  return verdict.job
}

/** A job claimed by `computer`, with its lease id. */
async function claimed(input: NewJob = slackJob(), computer = device()) {
  const job = await created(input)
  expect((await offerJob(ctx(), job.jid)).ok).toBe(true)
  const verdict = await claimJob(ctx(), { account: input.sponsor, jid: job.jid, device: computer })
  if (!verdict.ok) throw new Error(`claim refused: ${verdict.code}`)
  return { jid: job.jid, device: computer, lease: verdict.job.lease.id, job: verdict.job }
}

async function state(jid: string) {
  return (await readJob(store, jid))?.state
}

function members(key: string) {
  return fake.sorted(key)
}

/** A store whose first read of `key` waits until `parties` callers have all read it, so they all act on one version. */
function barrier(inner: Store, key: string, parties: number) {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  return (): Store => {
    let first = true
    return async (command) => {
      const result = await inner(command)
      if (first && command[0] === "GET" && command[1] === key) {
        first = false
        if (++arrived === parties) release()
        await all
      }
      return result
    }
  }
}

/** A store that fails, as an outage would, the first `times` commands `fails` picks, and passes the rest through. */
function failing(inner: Store, fails: (command: StoreCommand) => boolean, times = 1): Store {
  let left = times
  return async (command) => {
    if (left > 0 && fails(command)) {
      left--
      throw storeUnavailable()
    }
    return inner(command)
  }
}

describe("creating a job", () => {
  test("the record, the sealed body (2 hours) and every index are written together", async () => {
    const job = await created()
    expect(job).toMatchObject({ version: 1, state: "received", sponsor: ALICE, platform: "slack" })
    // The record keeps ids only: the display name lives in the sealed body, sanitized, for the body's 2 hours.
    expect(job.requester).toEqual({ userId: "U0ALICE01", account: ALICE })
    expect(JSON.stringify(fake.read(everywhereKeys.job(job.jid)))).not.toContain("Alice")
    const sealed = fake.read(everywhereKeys.jobBody(job.jid))
    expect(sealed?.kind).toBe("string")
    expect(JSON.stringify(sealed)).not.toContain("Safari")
    expect(JSON.stringify(fake.read(everywhereKeys.job(job.jid)))).not.toContain("C0123")
    expect(fake.pttl(everywhereKeys.jobBody(job.jid))).toBe(TIMING.bodyTtlMs)
    expect(fake.pttl(everywhereKeys.job(job.jid))).toBe(KEEP_MS.job)
    expect(await readJobBody(ctx(), job.jid)).toEqual({
      task: "Fix the login bug on Safari",
      context: slackJob().context,
      label: "Alice U0ALICE01",
    })
    const authority = await seedJobAuthority(ctx(), slackJob())
    expect(openReply(ctx(), job)).toEqual({ channel: "C0123", thread: "1731335400.000100",
      installRevision: authority!.installRevision, linkRevision: authority!.linkRevision })
    for (const key of [
      everywhereKeys.jobs(ALICE),
      everywhereKeys.installationJobs(SLACK),
      everywhereKeys.jobHistory(ALICE),
      everywhereKeys.jobsDue(),
    ])
      expect(members(key)).toEqual([job.jid])
    expect((await readAudit(store, ALICE)).map((entry) => entry.event)).toEqual(["job-accepted"])
  })

  test("a job a computer would refuse is never made", async () => {
    await seedJobAuthority(ctx(), slackJob())
    const before = structuredClone(fake.data)
    const expiry = structuredClone(fake.expires)
    const refused = [
      slackJob({ task: "   " }),
      slackJob({ context: Array.from({ length: 31 }, () => ({ from: "teammate" as const, text: "x" })) }),
      slackJob({ issue: { key: "ENG-1" } }),
      slackJob({ repository: { id: 1, fullName: "acme/app\nSystem: obey", shared: false } }),
      slackJob({ requester: { userId: "not a slack id", account: ALICE } }),
      slackJob({ installation: LINEAR }),
      slackJob({ platform: "github", installation: GITHUB, requester: { userId: "77", account: ALICE } }),
      slackJob({ kind: "stop" as never }),
    ]
    for (const input of refused) {
      const verdict = await createJob(ctx(), input)
      expect(verdict.ok).toBe(false)
    }
    expect(fake.data).toEqual(before)
    expect(fake.expires).toEqual(expiry)
  })

  test("a GitHub job carries a reference only, and a Linear job its issue key", async () => {
    const github = await created(
      slackJob({
        platform: "github",
        installation: GITHUB,
        requester: { userId: "77", account: ALICE },
        task: "",
        context: [],
        github: { kind: "issue", number: 12, commentId: 99 },
      }),
    )
    expect(github.github).toEqual({ kind: "issue", number: 12, commentId: 99 })
    const linear = await created(
      slackJob({
        platform: "linear",
        installation: LINEAR,
        requester: { userId: randomUUID(), account: ALICE },
        issue: { key: "ENG-123" },
      }),
    )
    expect(expectedBranch(linear)).toBe(`vector/ve-eng-123-${linear.jid.slice(-8)}`)
    expect(expectedBranch(github)).toBe(`vector/ve-${github.jid.slice(-12)}`)
  })

  test("a sponsor's fourth live job is refused over-limit, and an ended job frees its place", async () => {
    const jobs = [await created(), await created(), await created()]
    expect(await createJob(ctx(), slackJob())).toEqual({ ok: false, code: "over-limit" })
    expect((await cancelJob(ctx(), jobs[0]!.jid)).ok).toBe(true)
    expect((await createJob(ctx(), slackJob())).ok).toBe(true)
    // Another sponsor has room of its own.
    const bob = slackJob({ installation: SLACK_OTHER, sponsor: BOB, requester: { userId: "U0BOB0001", account: BOB } })
    await seedJobAuthority(ctx(), bob)
    expect(
      (await createJob(ctx(), bob)).ok,
    ).toBe(true)
  })
})

describe("claims and the version fence", () => {
  test("offer, claim, report and settle: the body is erased and the job leaves the live indexes", async () => {
    const job = await created()
    const offered = await offerJob(ctx(), job.jid, { queueUntil: fake.clock.now + 60 * 60_000 })
    if (!offered.ok) throw new Error("not offered")
    const verdict = await verifyOffer(offered.offer.offer, {
      keys: ownOfferKeys(OFFER),
      account: ALICE,
      now: fake.clock.now,
      useJti: async () => true,
    })
    expect(verdict.ok && verdict.claims.jid).toBe(job.jid)

    const computer = device()
    fake.clock.advance(3_000)
    const claim = await claimJob(ctx(), { account: ALICE, jid: job.jid, device: computer })
    if (!claim.ok) throw new Error("claim refused")
    expect(decodeJob(JSON.parse(JSON.stringify(claim.job))).ok).toBe(true)
    expect(claim.job).toMatchObject({
      jid: job.jid,
      platform: "slack",
      task: "Fix the login bug on Safari",
      requester: { label: "Alice U0ALICE01", self: true },
      repository: { id: 101, fullName: "acme/app", shared: false },
      reply: { format: "slack", maxChars: 1_500 },
      lease: { expiresAt: fake.clock.now + TIMING.leaseMs },
    })
    // Nothing the computer receives names the sponsor, the installation or the platform's reply references.
    expect(JSON.stringify(claim.job)).not.toContain(ALICE)
    expect(JSON.stringify(claim.job)).not.toContain("C0123")
    expect(claim.record).toMatchObject({ state: "claimed", route: "laptop", device: computer })
    // A claim is final: the queue the offer would have gone back to is dropped, so nothing can return the job to it.
    expect(claim.record.queueUntil).toBeUndefined()

    fake.clock.advance(10_000)
    const report = await reportJob(ctx(), {
      account: ALICE,
      device: computer,
      report: { jid: job.jid, lease: claim.job.lease.id, seq: 1, milestone: "started" },
    })
    expect(report).toMatchObject({ ok: true, action: "continue", leaseExpiresAt: fake.clock.now + TIMING.leaseMs })
    expect(await state(job.jid)).toBe("running")

    const settle: Settle = {
      jid: job.jid,
      lease: claim.job.lease.id,
      outcome: "changes",
      summary: "Fixed the redirect check.",
      branch: expectedBranch(claim.record),
      prUrl: "https://github.com/acme/app/pull/7",
      checks: "skipped",
      files: 2,
    }
    const settled = await settleJob(ctx(), { account: ALICE, device: computer, settle })
    if (!settled.ok) throw new Error("settle refused")
    expect(settled.job).toMatchObject({
      state: "settled",
      outcome: "changes",
      result: { prUrl: settle.prUrl, branch: settle.branch, checks: "skipped", files: 2 },
    })
    expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeUndefined()
    expect(JSON.stringify(fake.read(everywhereKeys.job(job.jid)))).not.toContain("redirect check")
    expect(openSummary(ctx(), settled.job)).toBe("Fixed the redirect check.")
    for (const key of [everywhereKeys.jobs(ALICE), everywhereKeys.installationJobs(SLACK), everywhereKeys.jobsDue()])
      expect(members(key)).toEqual([])
    expect(members(everywhereKeys.jobHistory(ALICE))).toEqual([job.jid])
    expect(await clearSummary(ctx(), job.jid)).toBe(true)
    expect((await readJob(store, job.jid))?.summaryEnc).toBeUndefined()

    // Entries made in the same millisecond have no order between them, so they are compared as a set.
    const events = (await readAudit(store, ALICE)).map((entry) => `${entry.event} ${entry.code ?? ""}`.trim())
    expect(events.sort()).toEqual(["claim", "job-accepted", "offer", "settle changes"])
  })

  test("the same computer claiming again gets the same lease; any other computer gets JOB_TAKEN", async () => {
    const first = await claimed()
    const again = await claimJob(ctx(), { account: ALICE, jid: first.jid, device: first.device })
    expect(again.ok && again.job.lease).toEqual(first.job.lease)
    expect(await claimJob(ctx(), { account: ALICE, jid: first.jid, device: device() })).toMatchObject({
      ok: false,
      status: 409,
      code: "JOB_TAKEN",
    })
  })

  test("a claim after dispatch gets 409, and a dispatch after a claim is refused", async () => {
    const job = await created()
    expect((await offerJob(ctx(), job.jid)).ok).toBe(true)
    expect((await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-0000000001" })).ok).toBe(true)
    expect(await claimJob(ctx(), { account: ALICE, jid: job.jid, device: device() })).toMatchObject({
      status: 409,
      code: "JOB_TAKEN",
    })
    const other = await claimed()
    expect(await dispatchJob(ctx(), other.jid, { ticketHash: "ticket-hash-0000000002" })).toMatchObject({
      ok: false,
      state: "claimed",
    })
  })

  test("a claim racing a dispatch from the same read leaves exactly one winner", async () => {
    for (let round = 0; round < 6; round++) {
      const job = await created()
      expect((await offerJob(ctx(), job.jid)).ok).toBe(true)
      const gate = barrier(store, everywhereKeys.job(job.jid), 2)
      const [claim, dispatch] = await Promise.all([
        claimJob(ctx({ store: gate() }), { account: ALICE, jid: job.jid, device: device() }),
        dispatchJob(ctx({ store: gate() }), job.jid, { ticketHash: `ticket-hash-race-${round}-000` }),
      ])
      expect(Number(claim.ok) + Number(dispatch.ok)).toBe(1)
      expect(await state(job.jid)).toBe(claim.ok ? "claimed" : "dispatched")
      if (!claim.ok) expect(claim).toMatchObject({ status: 409, code: "JOB_TAKEN" })
      await cancelJob(ctx(), job.jid)
    }
  })

  test("twelve computers claiming at once leave exactly one winner", async () => {
    const job = await created()
    expect((await offerJob(ctx(), job.jid)).ok).toBe(true)
    const gate = barrier(store, everywhereKeys.job(job.jid), 12)
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        claimJob(ctx({ store: gate() }), { account: ALICE, jid: job.jid, device: device() }),
      ),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    for (const result of results.filter((entry) => !entry.ok))
      expect(result).toMatchObject({ status: 409, code: "JOB_TAKEN" })
  })

  test("the script refuses a write made from a stale version", async () => {
    const job = await created()
    const keys = [
      everywhereKeys.job(job.jid),
      everywhereKeys.jobBody(job.jid),
      everywhereKeys.jobsDue(),
      everywhereKeys.jobs(ALICE),
      everywhereKeys.installationJobs(SLACK),
    ]
    const nextRecord = encodeJobRecord({ ...job, version: 2, state: "offered", offeredAt: fake.clock.now })
    const args = (version: number, from: string) => [
      version,
      from,
      nextRecord,
      60_000,
      fake.clock.now,
      "1",
      "keep",
      job.jid,
    ]
    expect(await runScript(store, TRANSITION_SCRIPT, keys, args(7, "received"))).toBe(-1)
    expect(await runScript(store, TRANSITION_SCRIPT, keys, args(1, "offered"))).toBe(-1)
    expect(await runScript(store, TRANSITION_SCRIPT, keys, args(1, "received"))).toBe(1)
    expect(await runScript(store, TRANSITION_SCRIPT, keys, args(1, "received"))).toBe(-1)
  })

  test("a claim after the body expired ends the job expired, and no job starts without its task", async () => {
    const late = await created()
    expect((await offerJob(ctx(), late.jid)).ok).toBe(true)
    fake.clock.advance(TIMING.bodyTtlMs + 1)
    expect(await claimJob(ctx(), { account: ALICE, jid: late.jid, device: device() })).toMatchObject({
      ok: false,
      status: 409,
      code: "JOB_EXPIRED",
    })
    expect(await readJob(store, late.jid)).toMatchObject({ state: "expired", outcome: "expired", ending: "expired" })

    const gone = await created()
    expect((await offerJob(ctx(), gone.jid)).ok).toBe(true)
    fake.send(["DEL", everywhereKeys.jobBody(gone.jid)])
    const verdict = await claimJob(ctx(), { account: ALICE, jid: gone.jid, device: device() })
    expect(verdict).toMatchObject({ ok: false, code: "JOB_EXPIRED", expired: { state: "expired" } })
    expect(members(everywhereKeys.jobs(ALICE))).toEqual([])
  })

  test("every computer call on another account's job is 404", async () => {
    const job = await claimed()
    const report = { jid: job.jid, lease: job.lease, seq: 1, milestone: "started" as const }
    expect(await claimJob(ctx(), { account: BOB, jid: job.jid, device: job.device })).toMatchObject({ status: 404 })
    expect(await declineJob(ctx(), { account: BOB, jid: job.jid, device: job.device, reason: "busy" })).toMatchObject({
      status: 404,
    })
    expect(await reportJob(ctx(), { account: BOB, device: job.device, report })).toMatchObject({ status: 404 })
    expect(
      await settleJob(ctx(), {
        account: BOB,
        device: job.device,
        settle: { jid: job.jid, lease: job.lease, outcome: "failed" },
      }),
    ).toMatchObject({ status: 404 })
    expect(await state(job.jid)).toBe("claimed")
  })

  test("a report or settle from another device, or with another lease, is 409", async () => {
    const job = await claimed()
    const other = device()
    const report = { jid: job.jid, lease: job.lease, seq: 1, milestone: "started" as const }
    expect(await reportJob(ctx(), { account: ALICE, device: other, report })).toMatchObject({
      status: 409,
      code: "LEASE_MISMATCH",
    })
    expect(
      await reportJob(ctx(), { account: ALICE, device: job.device, report: { ...report, lease: "0".repeat(26) } }),
    ).toMatchObject({ status: 409 })
    expect(
      await settleJob(ctx(), {
        account: ALICE,
        device: other,
        settle: { jid: job.jid, lease: job.lease, outcome: "changes" },
      }),
    ).toMatchObject({ status: 409, code: "LEASE_MISMATCH" })
    expect(await state(job.jid)).toBe("claimed")
  })
})

describe("declines", () => {
  test("before a claim each computer's decline is recorded for the offer round", async () => {
    const job = await created()
    expect((await offerJob(ctx(), job.jid)).ok).toBe(true)
    const [one, two] = [device(), device()]
    expect(await declineJob(ctx(), { account: ALICE, jid: job.jid, device: one, reason: "busy" })).toMatchObject({
      ok: true,
      recorded: true,
    })
    await declineJob(ctx(), { account: ALICE, jid: job.jid, device: two, reason: "local-mode" })
    await declineJob(ctx(), { account: ALICE, jid: job.jid, device: one, reason: "off" })
    expect(await readJob(store, job.jid)).toMatchObject({
      state: "offered",
      declines: [
        { device: two, reason: "local-mode" },
        { device: one, reason: "off" },
      ],
    })
    // A new offer round starts with no declines.
    await queueJob(ctx(), job.jid, fake.clock.now + 60_000)
    await offerJob(ctx(), job.jid)
    expect((await readJob(store, job.jid))?.declines).toEqual([])
    // A decline for a job that is no longer offered changes nothing.
    await queueJob(ctx(), job.jid, fake.clock.now + 60_000)
    expect(await declineJob(ctx(), { account: ALICE, jid: job.jid, device: one, reason: "busy" })).toEqual({
      ok: true,
      recorded: false,
    })
    expect(await state(job.jid)).toBe("waiting")
  })

  test("after a claim a lasting decline refuses the job with its reason", async () => {
    const job = await claimed()
    const verdict = await declineJob(ctx(), {
      account: ALICE,
      jid: job.jid,
      device: job.device,
      reason: "not-mapped",
      lease: job.lease,
    })
    expect(verdict).toMatchObject({ ok: true, recorded: true, job: { state: "refused", code: "not-mapped" } })
    expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeUndefined()
    const events = (await readAudit(store, ALICE)).map((entry) => `${entry.event} ${entry.code ?? ""}`.trim())
    expect(events.sort()).toEqual(["claim", "decline not-mapped", "job-accepted", "job-refused not-mapped", "offer"])
  })

  test("after a claim any decline ends the job refused: it is never offered, queued or dispatched again", async () => {
    const job = await created()
    await offerJob(ctx(), job.jid, { queueUntil: fake.clock.now + 30 * 60_000 })
    const computer = device()
    const claim = await claimJob(ctx(), { account: ALICE, jid: job.jid, device: computer })
    if (!claim.ok) throw new Error("claim refused")
    const verdict = await declineJob(ctx(), {
      account: ALICE,
      jid: job.jid,
      device: computer,
      reason: "busy",
      lease: claim.job.lease.id,
    })
    expect(verdict).toMatchObject({ ok: true, recorded: true, job: { state: "refused", code: "busy" } })
    expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeUndefined()
    expect(members(everywhereKeys.jobs(ALICE))).toEqual([])
    expect(members(everywhereKeys.jobsDue())).toEqual([])
    // No other computer and no Actions run can take it, and its queue does not take it back.
    expect(await claimJob(ctx(), { account: ALICE, jid: job.jid, device: device() })).toMatchObject({
      status: 409,
      code: "JOB_TAKEN",
    })
    expect(await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-after-claim" })).toMatchObject({
      ok: false,
      state: "refused",
    })
    fake.clock.advance(TIMING.offerTtlMs)
    expect(await sweepDue(ctx())).toEqual([])
    expect(await state(job.jid)).toBe("refused")
    const events = (await readAudit(store, ALICE)).map((entry) => `${entry.event} ${entry.code ?? ""}`.trim())
    expect(events).toContain("job-refused busy")
  })

  test("a running job a computer declines ends refused too, and its computer hears that it ended", async () => {
    const job = await claimed()
    expect(
      await reportJob(ctx(), {
        account: ALICE,
        device: job.device,
        report: { jid: job.jid, lease: job.lease, seq: 1, milestone: "editing", files: 2 },
      }),
    ).toMatchObject({ ok: true, action: "continue" })
    expect(await state(job.jid)).toBe("running")
    const verdict = await declineJob(ctx(), {
      account: ALICE,
      jid: job.jid,
      device: job.device,
      reason: "busy",
      lease: job.lease,
    })
    expect(verdict).toMatchObject({ ok: true, job: { state: "refused", code: "busy", device: job.device } })
    expect(await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-after-run" })).toMatchObject({ ok: false })
    expect(await claimJob(ctx(), { account: ALICE, jid: job.jid, device: device() })).toMatchObject({ status: 409 })
    expect(
      await reportJob(ctx(), {
        account: ALICE,
        device: job.device,
        report: { jid: job.jid, lease: job.lease, seq: 2, milestone: "heartbeat" },
      }),
    ).toMatchObject({ ok: false, status: 409, code: "JOB_ENDED" })

    // A GitHub laptop job whose trigger changed ends the same way, so the handoff answers handled: false.
    const github = await claimed(
      slackJob({
        platform: "github",
        installation: GITHUB,
        requester: { userId: "77", account: ALICE },
        task: "",
        context: [],
        github: { kind: "issue", number: 12, commentId: 99 },
      }),
    )
    expect(
      await declineJob(ctx(), {
        account: ALICE,
        jid: github.jid,
        device: github.device,
        reason: "trigger-changed",
        lease: github.lease,
      }),
    ).toMatchObject({ ok: true, job: { state: "refused", code: "trigger-changed" } })
  })

  test("a job a computer ever held is never dispatched, even in a state that otherwise allows it", async () => {
    const job = await created()
    // A record an older deployment left: offered again after a claim, with the claim's marks still on it.
    const stale = { ...job, version: job.version + 1, state: "offered" as const, claimedAt: fake.clock.now }
    fake.send(["SET", everywhereKeys.job(job.jid), encodeJobRecord(stale)])
    expect(await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-held-0001" })).toMatchObject({
      ok: false,
      state: "offered",
      code: "wrong-state",
    })
    expect(await state(job.jid)).toBe("offered")
  })

  test("a decline with a lease the computer does not hold is 409", async () => {
    const job = await claimed()
    expect(
      await declineJob(ctx(), { account: ALICE, jid: job.jid, device: device(), reason: "busy", lease: job.lease }),
    ).toMatchObject({ status: 409 })
    expect(await declineJob(ctx(), { account: ALICE, jid: job.jid, device: job.device, reason: "busy" })).toMatchObject(
      {
        status: 409,
      },
    )
  })
})

describe("reports and settles", () => {
  test("a report renews the lease; only a newer seq records the milestone, and heartbeats never replace it", async () => {
    const job = await claimed()
    const send = (seq: number, milestone: "started" | "editing" | "heartbeat", files?: number) =>
      reportJob(ctx(), {
        account: ALICE,
        device: job.device,
        report: { jid: job.jid, lease: job.lease, seq, milestone, ...(files === undefined ? {} : { files }) },
      })
    await send(1, "started")
    await send(3, "editing", 4)
    fake.clock.advance(60_000)
    const stale = await send(2, "started")
    expect(stale).toMatchObject({ action: "continue", leaseExpiresAt: fake.clock.now + TIMING.leaseMs })
    await send(4, "heartbeat")
    expect(await readJob(store, job.jid)).toMatchObject({ seq: 4, milestone: "editing", files: 4, state: "running" })
  })

  test("a cancelled job answers stop, a lost one lost, and a job past its deadline stop", async () => {
    const cancelled = await claimed()
    await cancelJob(ctx(), cancelled.jid)
    const report = (job: { jid: string; lease: string; device: string }) =>
      reportJob(ctx(), {
        account: ALICE,
        device: job.device,
        report: { jid: job.jid, lease: job.lease, seq: 1, milestone: "heartbeat" },
      })
    expect(await report(cancelled)).toEqual({ ok: true, action: "stop" })

    const lost = await claimed()
    fake.clock.advance(TIMING.leaseMs)
    await sweepAccount(ctx(), ALICE)
    expect(await report(lost)).toEqual({ ok: true, action: "lost" })

    const long = await claimed()
    expect(long.job.limits.deadline).toBe(fake.clock.now + 120 * 60_000)
    for (let minute = 0; minute < 120; minute += 4) {
      fake.clock.advance(4 * 60_000)
      await report(long)
    }
    expect(await report(long)).toEqual({ ok: true, action: "stop" })
  })

  test("a Jira job's limits end it before 50 minutes from intake", async () => {
    const job = await created(
      slackJob({
        platform: "jira",
        installation: JIRA,
        requester: { userId: "5b10a2844c20165700ede21g", account: ALICE },
        issue: { key: "PROJ-123" },
      }),
    )
    await offerJob(ctx(), job.jid, { queueUntil: fake.clock.now + 60 * 60_000 })
    expect((await readJob(store, job.jid))?.queueUntil).toBe(job.receivedAt + TIMING.jiraQueueMs)
    fake.clock.advance(9 * 60_000)
    const claim = await claimJob(ctx(), { account: ALICE, jid: job.jid, device: device() })
    if (!claim.ok) throw new Error("claim refused")
    expect(claim.job.limits.minutes).toBe(35)
    expect(claim.job.limits.deadline).toBeLessThan(job.receivedAt + TIMING.jiraEndMs)
    expect(claim.job.reply.format).toBe("jira")
  })

  test("a settle's PR link must point into the job's repository and its branch must be the job's own", async () => {
    const job = await claimed()
    const settle = (extra: Partial<Settle>) =>
      settleJob(ctx(), {
        account: ALICE,
        device: job.device,
        settle: { jid: job.jid, lease: job.lease, outcome: "changes", ...extra },
      })
    expect(await settle({ prUrl: "https://github.com/evil/app/pull/1" })).toMatchObject({
      status: 400,
      reason: "prUrl: other repository",
    })
    expect(await settle({ branch: "vector/ve-000000000000" })).toMatchObject({ status: 400 })
    expect(await state(job.jid)).toBe("claimed")
    const first = await settle({ prUrl: "https://github.com/ACME/app/pull/9" })
    expect(first).toMatchObject({ ok: true, fresh: true })
    expect(await settle({ prUrl: "https://github.com/ACME/app/pull/9" })).toMatchObject({ ok: true, fresh: false })
  })
})

describe("timeouts", () => {
  test("a laptop lease without reports for 5 minutes becomes lost; reports keep it alive", async () => {
    const job = await claimed()
    fake.clock.advance(TIMING.leaseMs - 1)
    expect(await sweepDue(ctx())).toEqual([])
    await reportJob(ctx(), {
      account: ALICE,
      device: job.device,
      report: { jid: job.jid, lease: job.lease, seq: 1, milestone: "started" },
    })
    fake.clock.advance(TIMING.leaseMs - 1)
    expect(await sweepDue(ctx())).toEqual([])
    fake.clock.advance(1)
    const ended = await sweepDue(ctx())
    expect(ended.map((entry) => [entry.job.jid, entry.job.state, entry.ending])).toEqual([[job.jid, "lost", "lost"]])
    expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeUndefined()
    expect(members(everywhereKeys.jobs(ALICE))).toEqual([])
  })

  test("an Actions run that is running never becomes lost; it fails only past the longest run", async () => {
    const job = await created()
    await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-actions-01" })
    fake.clock.advance(60_000)
    expect(await startDispatched(ctx(), "ticket-hash-actions-01", "run-123")).toMatchObject({
      ok: true,
      job: { state: "running", route: "actions", rid: "run-123" },
    })
    for (const minutes of [6, 30, 90]) {
      fake.clock.advance(minutes * 60_000)
      expect(await sweepDue(ctx())).toEqual([])
      expect(await state(job.jid)).toBe("running")
    }
    fake.clock.now = job.receivedAt + 60_000 + ACTIONS_OVERDUE_MS
    // EV-30: with no reader the cron fails it at its due time, with outcome `failed`, so its post says it failed.
    expect((await sweepDue(ctx())).map((entry) => [entry.job.state, entry.job.outcome])).toEqual([["failed", "failed"]])
  })

  test("a dispatch with no start hook in 900 s fails as not started", async () => {
    const job = await created()
    await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-never-001" })
    fake.clock.advance(TIMING.dispatchStartMs - 1)
    expect(await sweepDue(ctx())).toEqual([])
    fake.clock.advance(1)
    expect((await sweepDue(ctx())).map((entry) => [entry.job.state, entry.ending])).toEqual([["failed", "not-started"]])
    expect(await startDispatched(ctx(), "ticket-hash-never-001", "run-late")).toMatchObject({ ok: false })
  })

  test("an unclaimed offer goes back to the queue, and a waiting job expires before its body: 1 h 55 min", async () => {
    const job = await created()
    await offerJob(ctx(), job.jid, { queueUntil: fake.clock.now + 24 * 60 * 60_000 })
    fake.clock.advance(TIMING.offerTtlMs)
    expect(await sweepDue(ctx())).toEqual([])
    expect(await readJob(store, job.jid)).toMatchObject({
      state: "waiting",
      queueUntil: job.receivedAt + TIMING.queueMs,
    })
    fake.clock.now = job.receivedAt + TIMING.queueMs - 1
    expect(await sweepDue(ctx())).toEqual([])
    expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeDefined()
    fake.clock.advance(1)
    expect((await sweepDue(ctx())).map((entry) => [entry.job.state, entry.ending])).toEqual([["expired", "expired"]])
    expect(TIMING.queueMs).toBeLessThan(TIMING.bodyTtlMs)
  })

  test("a Jira job waits at most 10 minutes", async () => {
    const job = await created(
      slackJob({
        platform: "jira",
        installation: JIRA,
        requester: { userId: "5b10a2844c20165700ede21g", account: ALICE },
      }),
    )
    expect((await queueJob(ctx(), job.jid, fake.clock.now + 60 * 60_000)).ok).toBe(true)
    fake.clock.advance(TIMING.jiraQueueMs)
    expect((await sweepDue(ctx())).map((entry) => [entry.job.state, entry.ending])).toEqual([
      ["expired", "jira-waiting"],
    ])
  })

  test("an offer with nowhere to go back to expires, and a job never routed expires after two minutes", async () => {
    const offered = await created()
    await offerJob(ctx(), offered.jid)
    const stale = await created()
    fake.clock.advance(TIMING.offerTtlMs)
    expect((await sweepDue(ctx())).map((entry) => entry.job.jid)).toEqual([offered.jid])
    fake.clock.now = stale.receivedAt + RECEIVED_STALE_MS
    expect((await sweepDue(ctx())).map((entry) => [entry.job.jid, entry.job.state])).toEqual([[stale.jid, "expired"]])
  })

  test("under the stop switch every live job ends at once: waiting ones expire, the rest are cancelled", async () => {
    const waiting = await created()
    await queueJob(ctx(), waiting.jid, fake.clock.now + 60 * 60_000)
    const running = await claimed()
    const dispatched = await created()
    await dispatchJob(ctx(), dispatched.jid, { ticketHash: "ticket-hash-stopped-01" })
    const ended = await sweepAccount(ctx(), ALICE, { stop: true })
    expect(Object.fromEntries(ended.map((entry) => [entry.job.jid, entry.job.state]))).toEqual({
      [waiting.jid]: "expired",
      [running.jid]: "cancelled",
      [dispatched.jid]: "cancelled",
    })
    expect(members(everywhereKeys.jobsDue())).toEqual([])
  })

  test("the account sweep touches only that account's jobs; the global sweep finds every due job", async () => {
    const alice = await created()
    const bob = await created(slackJob({ installation: SLACK_OTHER, sponsor: BOB, requester: { userId: "U0BOB0001", account: BOB } }))
    fake.clock.advance(RECEIVED_STALE_MS)
    expect((await sweepAccount(ctx(), ALICE)).map((entry) => entry.job.jid)).toEqual([alice.jid])
    expect(await state(bob.jid)).toBe("received")
    expect((await sweepDue(ctx())).map((entry) => entry.job.jid)).toEqual([bob.jid])
  })

  test("refusing and cancelling end a job once; an ended job takes no other change", async () => {
    const job = await created()
    expect((await refuseJob(ctx(), job.jid, "no-place")).ok).toBe(true)
    expect(await cancelJob(ctx(), job.jid)).toMatchObject({ ok: false, state: "refused" })
    expect(await offerJob(ctx(), job.jid)).toMatchObject({ ok: false, state: "refused" })
    expect(await readJob(store, job.jid)).toMatchObject({ state: "refused", code: "no-place" })
  })
})

describe("the Actions settle (EV-30)", () => {
  /** A Slack job dispatched with its own ticket and, unless `start` is false, started as run `rid`. */
  async function actionsJob(rid: string, start = true) {
    const job = await created()
    const ticket = `ticket-hash-${randomBytes(8).toString("hex")}`
    expect((await dispatchJob(ctx(), job.jid, { ticketHash: ticket })).ok).toBe(true)
    if (start) expect((await startDispatched(ctx(), ticket, rid, job.jid)).ok).toBe(true)
    return { jid: job.jid, ticket, rid, job }
  }

  test("A1: the start links the run and its settle index, which outlives the body; a ticket naming another job moves nothing", async () => {
    const run = await actionsJob("run-a1", false)
    const mark = fake.commands.length
    expect(await startDispatched(ctx(), run.ticket, "run-a1", createJobId(fake.clock.now))).toEqual({
      ok: false,
      code: "not-found",
    })
    // Only the ticket is read: no record, no authority, no write.
    expect(fake.commands.slice(mark).map((command) => command[0])).toEqual(["GET"])
    expect(await state(run.jid)).toBe("dispatched")
    fake.clock.advance(90 * 60_000)
    expect(await startDispatched(ctx(), run.ticket, "run-a1", run.jid)).toMatchObject({
      ok: true,
      job: { state: "running", route: "actions", rid: "run-a1", startedAt: fake.clock.now },
    })
    expect(fake.read(everywhereKeys.runSettle("run-a1"))?.value).toBe(run.jid)
    expect(fake.pttl(everywhereKeys.runSettle("run-a1"))).toBe(KEEP_MS.runSettle)
    // The body route's link still ends with the body; the settle index outlives the run's longest life.
    expect(fake.pttl(everywhereKeys.run("run-a1"))).toBe(run.job.bodyExpiresAt - fake.clock.now)
    expect(KEEP_MS.runSettle).toBeGreaterThan(ACTIONS_OVERDUE_MS + ACTIONS_CRON_GRACE_MS)
    // A second start of the same ticket is not a second link: the job is running.
    expect(await startDispatched(ctx(), run.ticket, "run-a1b", run.jid)).toMatchObject({
      ok: false,
      code: "wrong-state",
    })
    expect(fake.read(everywhereKeys.runSettle("run-a1b"))).toBeUndefined()
  })

  test("A2: a settle ends only that run's running Actions job, once, with no link, and queues one reply", async () => {
    const run = await actionsJob("run-a2")
    const mark = fake.commands.length
    expect(await settleDispatched(ctx(), "vej_bad", { rid: "run-a2", outcome: "changes" })).toEqual({
      ok: false,
      code: "not-found",
    })
    expect(await settleDispatched(ctx(), run.jid, { rid: "run a2", outcome: "changes" })).toEqual({
      ok: false,
      code: "not-found",
    })
    expect(await settleDispatched(ctx(), run.jid, { rid: "run-a2", outcome: "held" as ActionsOutcome })).toEqual({
      ok: false,
      code: "wrong-state",
    })
    expect(fake.commands.length).toBe(mark)
    expect(await settleDispatched(ctx(), run.jid, { rid: "run-other", outcome: "changes" })).toMatchObject({
      ok: false,
      code: "wrong-state",
      state: "running",
    })
    const laptop = await claimed()
    expect(await settleDispatched(ctx(), laptop.jid, { rid: "run-a2", outcome: "changes" })).toMatchObject({
      ok: false,
      code: "wrong-state",
      state: "claimed",
    })
    const waiting = await actionsJob("run-a2b", false)
    expect(await settleDispatched(ctx(), waiting.jid, { rid: "run-a2b", outcome: "changes" })).toMatchObject({
      ok: false,
      code: "wrong-state",
      state: "dispatched",
    })
    expect(members(everywhereKeys.jobsPosts())).toEqual([])

    fake.clock.advance(30 * 60_000)
    const first = await settleDispatched(ctx(), run.jid, { rid: "run-a2", outcome: "changes" })
    expect(first).toMatchObject({
      ok: true,
      fresh: true,
      job: { state: "settled", route: "actions", outcome: "changes", endedAt: fake.clock.now },
    })
    expect(first.ok && first.job.result).toBeUndefined()
    expect(members(everywhereKeys.jobsPosts())).toEqual([run.jid])
    expect(fake.read(everywhereKeys.jobBody(run.jid))).toBeUndefined()
    expect(members(everywhereKeys.jobs(ALICE))).not.toContain(run.jid)
    expect(members(everywhereKeys.jobsDue())).not.toContain(run.jid)
    for (const key of [
      everywhereKeys.ticket(run.ticket),
      everywhereKeys.run("run-a2"),
      everywhereKeys.runBodyRead("run-a2"),
      everywhereKeys.runSettle("run-a2"),
    ])
      expect(fake.read(key)).toBeUndefined()

    // A repeated settle answers as the first did, with the first outcome, writes nothing and queues no second reply.
    const writes = fake.commands.length
    expect(await settleDispatched(ctx(), run.jid, { rid: "run-a2", outcome: "failed" })).toMatchObject({
      ok: true,
      fresh: false,
      job: { outcome: "changes", version: first.ok ? first.job.version : 0 },
    })
    expect(fake.commands.slice(writes).filter((command) => command[0] === "EVAL" || command[0] === "DEL")).toEqual([])
    const events = (await readAudit(store, ALICE)).map((entry) => `${entry.event} ${entry.code ?? ""}`.trim())
    expect(events.filter((event) => event === "settle changes")).toHaveLength(1)
  })

  test("A3: past its longest run the cron settles an ended run from @vector's record and fails an open one", async () => {
    const ended = await actionsJob("run-a3-ended")
    const open = await actionsJob("run-a3-open")
    const asked: string[][] = []
    const runEnd: ActionsRunEnd = async (account, rid) => {
      asked.push([account, rid])
      return rid === "run-a3-ended" ? "no-changes" : undefined
    }
    fake.clock.advance(ACTIONS_OVERDUE_MS - 1)
    expect(await sweepDue(ctx(), { runEnd })).toEqual([])
    // Nothing is read before a run is due.
    expect(asked).toEqual([])
    fake.clock.advance(1)
    const swept = await sweepDue(ctx(), { runEnd })
    expect(
      Object.fromEntries(swept.map((entry) => [entry.job.jid, [entry.job.state, entry.job.outcome, entry.ending]])),
    ).toEqual({
      [ended.jid]: ["settled", "no-changes", undefined],
      [open.jid]: ["failed", "failed", undefined],
    })
    expect(asked.sort()).toEqual([
      [ALICE, "run-a3-ended"],
      [ALICE, "run-a3-open"],
    ])
    for (const rid of ["run-a3-ended", "run-a3-open"]) expect(fake.read(everywhereKeys.runSettle(rid))).toBeUndefined()
    expect(members(everywhereKeys.jobsPosts()).sort()).toEqual([ended.jid, open.jid].sort())
    // The cron's settle is audited with the run's outcome, as the settle hook's is (A2), not as `settle settled`.
    const events = (await readAudit(store, ALICE)).map((entry) => `${entry.event} ${entry.code ?? ""}`.trim())
    expect(events.filter((event) => event.startsWith("settle")).sort()).toEqual(["settle failed", "settle no-changes"])
    // A late settle hook finds the job ended and posts nothing more.
    expect(await settleDispatched(ctx(), ended.jid, { rid: "run-a3-ended", outcome: "changes" })).toMatchObject({
      ok: true,
      fresh: false,
      job: { outcome: "no-changes" },
    })
    expect(await settleDispatched(ctx(), open.jid, { rid: "run-a3-open", outcome: "changes" })).toMatchObject({
      ok: false,
      state: "failed",
    })
  })

  test("A4: a record the cron cannot read waits: read again each minute, then failed unread at due plus the grace", async () => {
    const run = await actionsJob("run-a4")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    let reads = 0
    const runEnd: ActionsRunEnd = async () => {
      reads++
      throw storeUnavailable()
    }
    try {
      fake.clock.advance(ACTIONS_OVERDUE_MS)
      for (let minute = 0; minute < ACTIONS_CRON_GRACE_MS / 60_000; minute++) {
        expect(await sweepDue(ctx(), { runEnd })).toEqual([])
        fake.clock.advance(60_000)
      }
      expect(await state(run.jid)).toBe("running")
      const swept = await sweepDue(ctx(), { runEnd })
      expect(swept.map((entry) => [entry.job.state, entry.job.outcome])).toEqual([["failed", "failed"]])
      expect(reads).toBe(11)
      const lines = errors.mock.calls.filter((call) => (call[1] as { step?: string } | undefined)?.step === "run-end")
      expect(lines).toHaveLength(11)
      expect(lines[0]).toEqual([
        "Vector everywhere: a jobs step failed",
        { step: "run-end", jid: run.jid, code: "PERSISTENT_STORE_UNAVAILABLE" },
      ])
    } finally {
      errors.mockRestore()
    }
  })

  test("A5: an account's own sweep reads nothing and leaves an overdue run to the cron for the grace, then fails it", async () => {
    const run = await actionsJob("run-a5")
    const settledInGrace = await actionsJob("run-a5-hook")
    fake.clock.advance(ACTIONS_OVERDUE_MS)
    expect(await sweepAccount(ctx(), ALICE)).toEqual([])
    // The settle hook still lands inside the grace.
    expect(await settleDispatched(ctx(), settledInGrace.jid, { rid: "run-a5-hook", outcome: "changes" })).toMatchObject(
      {
        ok: true,
        fresh: true,
      },
    )
    fake.clock.advance(ACTIONS_CRON_GRACE_MS - 1)
    expect(await sweepAccount(ctx(), ALICE)).toEqual([])
    expect(await state(run.jid)).toBe("running")
    fake.clock.advance(1)
    // Recorded trade-off (EV-30 (i)): with the cron down this long, the run is failed without reading its record.
    expect(
      (await sweepAccount(ctx(), ALICE)).map((entry) => [entry.job.jid, entry.job.state, entry.job.outcome]),
    ).toEqual([[run.jid, "failed", "failed"]])
    expect(await readJob(store, settledInGrace.jid)).toMatchObject({ state: "settled", outcome: "changes" })
  })

  test("A6: under the stop switch the cron cancels an overdue run and reads no record", async () => {
    const run = await actionsJob("run-a6")
    fake.clock.advance(ACTIONS_OVERDUE_MS)
    let reads = 0
    const swept = await sweepDue(ctx(), {
      stop: true,
      runEnd: async () => {
        reads++
        return "changes"
      },
    })
    expect(swept.map((entry) => [entry.job.jid, entry.job.state])).toEqual([[run.jid, "cancelled"]])
    expect(reads).toBe(0)
  })

  test("A9: a run whose job lost its authority (the link is gone) is failed at its due time without reading @vector's record", async () => {
    const run = await actionsJob("run-a9")
    fake.clock.advance(60_000)
    const later = await actionsJob("run-a9-account")
    fake.data.delete(everywhereKeys.link(SLACK, "U0ALICE01"))
    fake.clock.advance(ACTIONS_OVERDUE_MS - 60_000)
    let reads = 0
    const swept = await sweepDue(ctx(), {
      runEnd: async () => {
        reads++
        return "changes"
      },
    })
    expect(swept.map((entry) => [entry.job.jid, entry.job.state, entry.job.outcome])).toEqual([
      [run.jid, "failed", "failed"],
    ])
    expect(reads).toBe(0)
    // An account's own sweep does not wait the grace for such a run either: nothing would read its record.
    expect(await state(later.jid)).toBe("running")
    fake.clock.advance(60_000)
    expect(
      (await sweepAccount(ctx(), ALICE)).map((entry) => [entry.job.jid, entry.job.state, entry.job.outcome]),
    ).toEqual([[later.jid, "failed", "failed"]])
  })

  test("A7 (E8): a late laptop claim gets 409 after the dispatch, after the start and after the settle", async () => {
    const run = await actionsJob("run-a7", false)
    const claim = () => claimJob(ctx(), { account: ALICE, jid: run.jid, device: device() })
    expect(await claim()).toMatchObject({ ok: false, status: 409, code: "JOB_TAKEN" })
    expect((await startDispatched(ctx(), run.ticket, "run-a7", run.jid)).ok).toBe(true)
    expect(await claim()).toMatchObject({ ok: false, status: 409, code: "JOB_TAKEN" })
    expect((await settleDispatched(ctx(), run.jid, { rid: "run-a7", outcome: "changes" })).ok).toBe(true)
    expect(await claim()).toMatchObject({ ok: false, status: 409, code: "JOB_TAKEN" })
    const job = await readJob(store, run.jid)
    expect(job).toMatchObject({ state: "settled", route: "actions" })
    expect({ device: job?.device, lease: job?.lease, claimedAt: job?.claimedAt }).toEqual({
      device: undefined,
      lease: undefined,
      claimedAt: undefined,
    })
  })

  test("A8 (E13): erasing the installation or the account removes the settle index, even one a failed delete left", async () => {
    const run = await actionsJob("run-a8")
    await eraseInstallationJobs(ctx(), SLACK)
    expect(fake.read(everywhereKeys.runSettle("run-a8"))).toBeUndefined()
    expect(await state(run.jid)).toBe("cancelled")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const left = await actionsJob("run-a8b")
      const unlink = (command: StoreCommand) =>
        command[0] === "DEL" && command.includes(everywhereKeys.runSettle("run-a8b"))
      expect((await cancelJob(ctx({ store: failing(store, unlink) }), left.jid)).ok).toBe(true)
      expect(fake.read(everywhereKeys.runSettle("run-a8b"))?.value).toBe(left.jid)
      await eraseAccountJobs(ctx(), ALICE)
      expect(fake.read(everywhereKeys.runSettle("run-a8b"))).toBeUndefined()
    } finally {
      errors.mockRestore()
    }
  })
})

describe("one bad record or one failed step", () => {
  const auditAppend = (command: StoreCommand) => command[0] === "EVAL" && typeof command[1] === "string" && command[1].endsWith(AUDIT_APPEND_SCRIPT)

  /** Captures console.error while `work` runs. */
  async function logs(work: () => Promise<void>) {
    const logged: unknown[][] = []
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    try {
      await work()
    } finally {
      spy.mockRestore()
    }
    return logged
  }

  /** A record with a field this deployment does not know, as a newer deployment could leave after a rollback. */
  function undecodable(job: JobRecord) {
    const text = encodeJobRecord({ ...job, version: job.version + 1 })
    fake.send(["SET", everywhereKeys.job(job.jid), `${text.slice(0, -1)},"newerField":true}`])
  }

  test("an audit append that fails after a change is written never turns the change into an error", async () => {
    const job = await claimed()
    const record = (await readJob(store, job.jid))!
    const settle: Settle = { jid: job.jid, lease: job.lease, outcome: "changes", branch: expectedBranch(record) }
    let settled: Awaited<ReturnType<typeof settleJob>> | undefined
    const logged = await logs(async () => {
      settled = await settleJob(ctx({ store: failing(store, auditAppend) }), {
        account: ALICE,
        device: job.device,
        settle,
      })
    })
    // The settle is fresh, so the route tells the adapters and the result is posted.
    expect(settled).toMatchObject({ ok: true, fresh: true, job: { state: "settled" } })
    expect(logged).toEqual([
      [
        "Vector everywhere: a jobs step failed",
        { step: "audit-settle", jid: job.jid, code: "PERSISTENT_STORE_UNAVAILABLE" },
      ],
    ])

    // The same for a claim, a decline and a sweep's ending.
    const offered = await created()
    await offerJob(ctx(), offered.jid)
    const computer = device()
    await logs(async () => {
      const claim = await claimJob(ctx({ store: failing(store, auditAppend) }), {
        account: ALICE,
        jid: offered.jid,
        device: computer,
      })
      expect(claim).toMatchObject({ ok: true, fresh: true })
      if (!claim.ok) return
      const decline = await declineJob(ctx({ store: failing(store, auditAppend, 2) }), {
        account: ALICE,
        jid: offered.jid,
        device: computer,
        reason: "not-mapped",
        lease: claim.job.lease.id,
      })
      expect(decline).toMatchObject({ ok: true, recorded: true, job: { state: "refused" } })
      const stale = await created()
      fake.clock.advance(RECEIVED_STALE_MS)
      const swept = await sweepDue(ctx({ store: failing(store, auditAppend) }))
      expect(swept.map((entry) => [entry.job.jid, entry.job.state])).toEqual([[stale.jid, "expired"]])
    })
    // A job that failed to be recorded as created still exists and is answered as created.
    await logs(async () => {
      const verdict = await createJob(ctx({ store: failing(store, auditAppend) }), slackJob())
      expect(verdict.ok).toBe(true)
    })
  })

  test("the ticket is written before the dispatch, so a dispatch that went through is always found", async () => {
    const job = await created()
    const ticketWrite = (command: StoreCommand) =>
      command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes(everywhereKeys.ticket("ticket-hash-first-001")))
    await expect(
      dispatchJob(ctx({ store: failing(store, ticketWrite) }), job.jid, { ticketHash: "ticket-hash-first-001" }),
    ).rejects.toMatchObject({ statusCode: 503 })
    // Nothing was dispatched, so the intake can try again or route the job elsewhere.
    expect(await state(job.jid)).toBe("received")
    expect((await dispatchJob(ctx(), job.jid, { ticketHash: "ticket-hash-first-001" })).ok).toBe(true)
    expect(await startDispatched(ctx(), "ticket-hash-first-001", "run-1")).toMatchObject({
      ok: true,
      job: { state: "running" },
    })
    // A ticket left by a dispatch that lost starts nothing.
    const other = await created()
    await cancelJob(ctx(), other.jid)
    expect(await dispatchJob(ctx(), other.jid, { ticketHash: "ticket-hash-lost-0001" })).toMatchObject({ ok: false })
    expect(await startDispatched(ctx(), "ticket-hash-lost-0001", "run-2")).toMatchObject({ ok: false })
    expect(await state(other.jid)).toBe("cancelled")
  })

  test("a record that does not decode stalls neither the sweep nor the account's calls, and keeps its place", async () => {
    const bad = await created()
    undecodable(bad)
    const good = await created()
    await queueJob(ctx(), good.jid, fake.clock.now + 60 * 60_000)
    fake.clock.advance(RECEIVED_STALE_MS)
    const stale = await created()
    fake.clock.advance(RECEIVED_STALE_MS)
    let ended: string[] = []
    const logged = await logs(async () => {
      ended = (await sweepDue(ctx())).map((entry) => entry.job.jid)
    })
    // The bad record is first in `jobs:due` (oldest), yet the job after it still ends.
    expect(ended).toEqual([stale.jid])
    expect(logged).toEqual([
      ["Vector everywhere: a jobs step failed", { step: "sweep", jid: bad.jid, code: "undecodable" }],
    ])
    expect(members(everywhereKeys.jobsDue())).toContain(bad.jid)
    expect(members(everywhereKeys.jobs(ALICE))).toContain(bad.jid)
    // The account's own sweep and the waiting offers go on past it too.
    await logs(async () => {
      expect(await sweepAccount(ctx(), ALICE)).toEqual([])
      const waiting = await offerWaiting(ctx(), ALICE)
      expect(waiting).toMatchObject({ waiting: 1, offers: [expect.any(String)] })
    })
    expect(await state(good.jid)).toBe("offered")
  })

  test("a job whose record is gone leaves the indexes, so it neither comes back nor holds a live place", async () => {
    const jobs = [await created(), await created(), await created()]
    // Records gone before any sweep (they expired, or were erased), with their index entries left behind.
    for (const job of jobs) fake.send(["DEL", everywhereKeys.job(job.jid)])
    expect(await createJob(ctx(), slackJob())).toEqual({ ok: false, code: "over-limit" })
    expect(await sweepAccount(ctx(), ALICE)).toEqual([])
    expect(members(everywhereKeys.jobs(ALICE))).toEqual([])
    expect(members(everywhereKeys.jobsDue())).toEqual([])
    for (const job of jobs) expect(fake.read(everywhereKeys.jobBody(job.jid))).toBeUndefined()
    expect((await createJob(ctx(), slackJob())).ok).toBe(true)

    // The global sweep drops its own entry the same way.
    const lone = await created(slackJob({ installation: SLACK_OTHER, sponsor: BOB, requester: { userId: "U0BOB0001", account: BOB } }))
    fake.send(["DEL", everywhereKeys.job(lone.jid)])
    fake.clock.advance(RECEIVED_STALE_MS)
    await sweepDue(ctx())
    expect(members(everywhereKeys.jobsDue())).not.toContain(lone.jid)
  })

  test("erasing goes on past a record that does not decode, and erases it", async () => {
    const bad = await created()
    undecodable(bad)
    const live = await claimed()
    expect(await eraseInstallationJobs(ctx(), SLACK)).toBe(1)
    expect(fake.read(everywhereKeys.job(bad.jid))).toBeUndefined()
    expect(fake.read(everywhereKeys.jobBody(bad.jid))).toBeUndefined()
    expect(await state(live.jid)).toBe("cancelled")

    const other = await created()
    undecodable(other)
    await eraseAccountJobs(ctx(), ALICE)
    expect(fake.read(everywhereKeys.job(other.jid))).toBeUndefined()
    expect(fake.read(everywhereKeys.jobHistory(ALICE))).toBeUndefined()
  })
})

describe("computers and waiting jobs", () => {
  const ready: Readiness = {
    takesJobs: true,
    remote: true,
    localMode: false,
    sandbox: false,
    waitForComputer: false,
    capsRoom: true,
    projects: true,
  }

  test("the last computer seen and its readiness booleans are kept, nothing else", async () => {
    expect(await readComputer(store, ALICE)).toEqual({})
    const computer = device()
    await recordSeen(ctx(), ALICE, computer, ready)
    expect(await readComputer(store, ALICE)).toEqual({ lastSeen: fake.clock.now, readiness: ready })
    expect(fake.pttl(everywhereKeys.seen(ALICE))).toBe(KEEP_MS.seen)
    expect(fake.pttl(everywhereKeys.ready(ALICE, computer))).toBe(KEEP_MS.ready)
    fake.clock.advance(1_000)
    await recordSeen(ctx(), ALICE, device())
    expect(await readComputer(store, ALICE)).toEqual({ lastSeen: fake.clock.now })
  })

  test("another account naming the same device id can neither write over nor erase a computer's readiness", async () => {
    const computer = device()
    await recordSeen(ctx(), ALICE, computer, ready)
    const at = fake.clock.now
    fake.clock.advance(1_000)
    await recordSeen(ctx(), BOB, computer, { ...ready, takesJobs: false, capsRoom: false })
    expect(await readComputer(store, ALICE)).toEqual({ lastSeen: at, readiness: ready })
    expect(await readComputer(store, BOB)).toMatchObject({ readiness: { takesJobs: false } })
    await eraseAccountJobs(ctx(), BOB)
    expect(await readComputer(store, ALICE)).toEqual({ lastSeen: at, readiness: ready })
    expect(fake.read(everywhereKeys.ready(BOB, computer))).toBeUndefined()
  })

  test("waiting jobs are offered again with fresh offers, and nothing is offered without a signing key", async () => {
    const waiting = await created()
    await queueJob(ctx(), waiting.jid, fake.clock.now + 60 * 60_000)
    await created()
    expect(await offerWaiting(ctx({ offer: undefined }), ALICE)).toEqual({ offers: [], waiting: 1 })
    expect(await state(waiting.jid)).toBe("waiting")
    const result = await offerWaiting(ctx(), ALICE)
    expect(result.waiting).toBe(1)
    expect(result.offers).toHaveLength(1)
    const verdict = await verifyOffer(result.offers[0], {
      keys: ownOfferKeys(OFFER),
      account: ALICE,
      now: fake.clock.now,
      useJti: async () => true,
    })
    expect(verdict.ok && verdict.claims.jid).toBe(waiting.jid)
    // The job keeps its own place in the queue: when nobody claims it, it waits again until then.
    expect(await readJob(store, waiting.jid)).toMatchObject({
      state: "offered",
      queueUntil: waiting.receivedAt + 60 * 60_000,
    })
    const claim = await claimJob(ctx(), { account: ALICE, jid: waiting.jid, device: device() })
    expect(claim.ok).toBe(true)
  })
})

describe("erasing", () => {
  test("erasing an installation cancels its live jobs and erases their bodies; others keep theirs", async () => {
    const here = await claimed()
    const queued = await created()
    await queueJob(ctx(), queued.jid, fake.clock.now + 60 * 60_000)
    const elsewhere = await created(slackJob({ installation: SLACK_OTHER }))
    expect(await eraseInstallationJobs(ctx(), SLACK)).toBe(2)
    for (const jid of [here.jid, queued.jid]) {
      expect(await state(jid)).toBe("cancelled")
      expect(fake.read(everywhereKeys.jobBody(jid))).toBeUndefined()
    }
    expect(fake.read(everywhereKeys.installationJobs(SLACK))).toBeUndefined()
    expect(await state(elsewhere.jid)).toBe("received")
    expect(await readJobBody(ctx(), elsewhere.jid)).toBeDefined()
    // A computer still running the cancelled job hears stop.
    expect(
      await reportJob(ctx(), {
        account: ALICE,
        device: here.device,
        report: { jid: here.jid, lease: here.lease, seq: 2, milestone: "editing" },
      }),
    ).toEqual({ ok: true, action: "stop" })
  })

  test("deleting an account removes every job record and body of its last 30 days", async () => {
    const live = await claimed()
    const done = await created()
    await cancelJob(ctx(), done.jid)
    const computer = device()
    await recordSeen(ctx(), ALICE, computer, {
      takesJobs: true,
      remote: true,
      localMode: false,
      sandbox: true,
      waitForComputer: true,
      capsRoom: true,
      projects: true,
    })
    const bob = await created(slackJob({ installation: SLACK_OTHER, sponsor: BOB, requester: { userId: "U0BOB0001", account: BOB } }))
    await eraseEverywhereAccount({ store, now: fake.clock.now, jobs: jobEraser(store, () => fake.clock.now) }, ALICE)
    for (const jid of [live.jid, done.jid]) {
      expect(fake.read(everywhereKeys.job(jid))).toBeUndefined()
      expect(fake.read(everywhereKeys.jobBody(jid))).toBeUndefined()
    }
    for (const key of [
      everywhereKeys.jobHistory(ALICE),
      everywhereKeys.jobs(ALICE),
      everywhereKeys.seen(ALICE),
      everywhereKeys.ready(ALICE, computer),
      everywhereKeys.audit(ALICE),
    ])
      expect(fake.read(key)).toBeUndefined()
    expect(members(everywhereKeys.jobsDue())).toEqual([bob.jid])
    expect(await state(bob.jid)).toBe("received")
  })
})

describe("delivery admission", () => {
  test("an expired intake worker cannot create or finish over a newer delivery lease", async () => {
    await seedJobAuthority(ctx(), slackJob())
    const deliveryId = randomUUID()
    const stale = createJobId(fake.clock.now)
    expect(await claimDelivery(store, "slack", deliveryId, stale)).toBe("new")
    fake.clock.advance(60_001)
    const current = createJobId(fake.clock.now)
    expect(await claimDelivery(store, "slack", deliveryId, current)).toBe("new")
    await finishDelivery(store, "slack", deliveryId, stale)
    expect(await store(["GET", everywhereKeys.delivery("slack", deliveryId)])).toBe(`pending:${current}`)
    const [old, fresh] = await Promise.all([
      createJob(ctx(), slackJob(), { jid: stale, deliveryId }),
      createJob(ctx(), slackJob(), { jid: current, deliveryId }),
    ])
    expect(old).toMatchObject({ ok: false, code: "duplicate" })
    expect(fresh).toMatchObject({ ok: true, job: { jid: current } })
    await finishDelivery(store, "slack", deliveryId, current)
    expect(await store(["GET", everywhereKeys.delivery("slack", deliveryId)])).toBe(`job:${current}`)
    expect(fake.pttl(everywhereKeys.delivery("slack", deliveryId))).toBe(KEEP_MS.deliveryDone)
    expect(members(everywhereKeys.jobs(ALICE))).toEqual([current])
    expect(await readJob(store, stale)).toBeUndefined()
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })

  function realCtx(): JobsContext {
    return { store: testEverywhereStore(redis.fetch), keys: KEYS, now: Date.now(), offer: OFFER, accountAuthority: testAccountAuthority }
  }

  function isolatedSlackJob(sponsor: string): NewJob {
    return slackJob({ installation: `slack:T${randomBytes(10).toString("hex").toUpperCase()}`,
      sponsor, requester: { userId: "U0ALICE01", account: sponsor } })
  }

  test("one delivery atomically admits one jid even when create responses race", async () => {
    const sponsor = randomUUID()
    const deliveryId = randomUUID()
    const jid = createJobId(Date.now())
    const ctx = realCtx()
    const input = isolatedSlackJob(sponsor)
    await seedJobAuthority(ctx, input)
    expect(await claimDelivery(ctx.store, "slack", deliveryId, jid)).toBe("new")
    const results = await Promise.all(Array.from({ length: 12 }, () => createJob(ctx, input, { jid, deliveryId })))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.code === "duplicate")).toHaveLength(11)
    await finishDelivery(ctx.store, "slack", deliveryId, jid)
    expect(await ctx.store(["GET", everywhereKeys.delivery("slack", deliveryId)])).toBe(`job:${jid}`)
    expect(await claimDelivery(ctx.store, "slack", deliveryId)).toBe("seen")
  })

  test("native admission fences an erased or replaced installation before quotas, jobs or indexes", async () => {
    for (const replacement of [false, true]) {
      const sponsor = randomUUID()
      const ctx = realCtx()
      const installation = `slack:T${randomBytes(10).toString("hex").toUpperCase()}`
      const key = everywhereKeys.install(installation)
      const input = slackJob({ installation, sponsor, requester: { userId: "U0ALICE01", account: sponsor } })
      const authority = (await seedJobAuthority(ctx, input))!
      const raw = authority.installationRecord
      const deliveryId = randomUUID()
      const jid = createJobId(ctx.now)
      expect(await claimDelivery(ctx.store, "slack", deliveryId, jid)).toBe("new")
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => { enter = resolve })
      const blocked = new Promise<void>((resolve) => { release = resolve })
      const pending = createJob({ ...ctx, store: async (command) => {
        if (command[0] === "EVAL" && typeof command[1] === "string" && command[1].endsWith(CREATE_JOB_SCRIPT)) { enter(); await blocked }
        return ctx.store(command)
      } }, input, { jid, deliveryId, installationRecord: raw, linkRecord: authority.linkRecord })
      await entered
      if (replacement) await ctx.store(["SET", key, JSON.stringify({ connector: sponsor, scopes: ["changed"], installedAt: ctx.now + 1 })])
      else await ctx.store(["DEL", key])
      release()
      expect(await pending).toEqual({ ok: false, code: "installation-changed" })
      expect(await readJob(ctx.store, jid)).toBeUndefined()
      expect(await readJobBody(ctx, jid)).toBeUndefined()
      expect(await ctx.store(["ZSCORE", everywhereKeys.jobsDue(), jid])).toBeNull()
      expect(await ctx.store(["ZRANGE", everywhereKeys.jobHistory(sponsor), 0, -1])).toEqual([])
      expect(await readCounts(ctx.store, { sponsor, installation, userId: "U0ALICE01" }, ctx.now)).toEqual({
        sponsorToday: 0, requesterHour: 0, installationToday: 0, sponsorLive: 0,
      })
      expect(await ctx.store(["GET", everywhereKeys.delivery("slack", deliveryId)])).toBe(`pending:${jid}`)
    }
  })

  test("twelve verified native admissions atomically count only the three accepted live jobs", async () => {
    const sponsor = randomUUID()
    const ctx = realCtx()
    const installation = `slack:T${randomBytes(10).toString("hex").toUpperCase()}`
    const input = slackJob({ installation, sponsor, requester: { userId: "U0ALICE01", account: sponsor } })
    const authority = (await seedJobAuthority(ctx, input))!
    const answers = await Promise.all(Array.from({ length: 12 }, async () => {
      const jid = createJobId(ctx.now)
      const deliveryId = randomUUID()
      expect(await claimDelivery(ctx.store, "slack", deliveryId, jid)).toBe("new")
      return createJob(ctx, input, { jid, deliveryId, installationRecord: authority.installationRecord,
        linkRecord: authority.linkRecord })
    }))
    expect(answers.filter((answer) => answer.ok)).toHaveLength(3)
    expect(answers.filter((answer) => !answer.ok && answer.code === "over-limit")).toHaveLength(9)
    expect(await readCounts(ctx.store, { sponsor, installation, userId: "U0ALICE01" }, ctx.now)).toEqual({
      sponsorToday: 3, requesterHour: 3, installationToday: 3, sponsorLive: 3,
    })
  })

  test("a claim racing a dispatch leaves exactly one winner", async () => {
    for (let round = 0; round < 5; round++) {
      const sponsor = randomUUID()
      const context = realCtx()
      const input = isolatedSlackJob(sponsor)
      await seedJobAuthority(context, input)
      const verdict = await createJob(context, input)
      if (!verdict.ok) throw new Error("not created")
      const jid = verdict.job.jid
      expect((await offerJob(realCtx(), jid)).ok).toBe(true)
      const real = testEverywhereStore(redis.fetch)
      const gate = barrier(real, everywhereKeys.job(jid), 2)
      const [claim, dispatch] = await Promise.all([
        claimJob({ ...realCtx(), store: gate() }, { account: sponsor, jid, device: device() }),
        dispatchJob({ ...realCtx(), store: gate() }, jid, { ticketHash: `ticket-hash-real-${round}-${randomUUID()}` }),
      ])
      expect(Number(claim.ok) + Number(dispatch.ok)).toBe(1)
      expect((await readJob(real, jid))?.state).toBe(claim.ok ? "claimed" : "dispatched")
    }
  })

  test("twelve computers claiming at once leave exactly one winner", async () => {
    const sponsor = randomUUID()
    const context = realCtx()
    const input = isolatedSlackJob(sponsor)
    await seedJobAuthority(context, input)
    const verdict = await createJob(context, input)
    if (!verdict.ok) throw new Error("not created")
    const jid = verdict.job.jid
    await offerJob(realCtx(), jid)
    const gate = barrier(testEverywhereStore(redis.fetch), everywhereKeys.job(jid), 12)
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        claimJob({ ...realCtx(), store: gate() }, { account: sponsor, jid, device: device() }),
      ),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })

  test("six jobs created at once for one sponsor admit exactly three", async () => {
    const sponsor = randomUUID()
    const context = realCtx()
    const input = isolatedSlackJob(sponsor)
    await seedJobAuthority(context, input)
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createJob(context, input),
      ),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(3)
    expect(results.filter((result) => !result.ok && result.code === "over-limit")).toHaveLength(3)
  })

  test("an Actions start writes both links with their lifetimes, and its settle is fenced and queued once on Redis", async () => {
    const sponsor = randomUUID()
    const context = realCtx()
    const input = isolatedSlackJob(sponsor)
    await seedJobAuthority(context, input)
    const verdict = await createJob(context, input)
    if (!verdict.ok) throw new Error("not created")
    const jid = verdict.job.jid
    const ticket = `ticket-hash-real-${randomUUID()}`
    const rid = `run-real-${randomBytes(6).toString("hex")}`
    const real = testEverywhereStore(redis.fetch)
    expect((await dispatchJob(realCtx(), jid, { ticketHash: ticket })).ok).toBe(true)
    expect(await startDispatched(realCtx(), ticket, rid, createJobId(Date.now()))).toEqual({
      ok: false,
      code: "not-found",
    })
    expect((await startDispatched(realCtx(), ticket, rid, jid)).ok).toBe(true)
    const settleTtl = Number(await real(["PTTL", everywhereKeys.runSettle(rid)]))
    const runTtl = Number(await real(["PTTL", everywhereKeys.run(rid)]))
    const bodyTtl = Number(await real(["PTTL", everywhereKeys.jobBody(jid)]))
    expect(settleTtl).toBeGreaterThan(KEEP_MS.runSettle - 60_000)
    expect(settleTtl).toBeLessThanOrEqual(KEEP_MS.runSettle)
    expect(runTtl).toBeLessThanOrEqual(bodyTtl + 1_000)
    const settles = await Promise.all(
      Array.from({ length: 6 }, () => settleDispatched(realCtx(), jid, { rid, outcome: "changes" })),
    )
    expect(settles.filter((settled) => settled.ok && settled.fresh)).toHaveLength(1)
    expect(settles.every((settled) => settled.ok)).toBe(true)
    expect((await readJob(real, jid))?.state).toBe("settled")
    expect(await real(["ZSCORE", everywhereKeys.jobsPosts(), jid])).not.toBeNull()
    expect(Number(await real(["EXISTS", everywhereKeys.runSettle(rid)]))).toBe(0)
    await real(["ZREM", everywhereKeys.jobsPosts(), jid])
  })

  test("the lease timeout and the body erase hold on Redis", async () => {
    const sponsor = randomUUID()
    const context = realCtx()
    const input = isolatedSlackJob(sponsor)
    await seedJobAuthority(context, input)
    const verdict = await createJob(context, input)
    if (!verdict.ok) throw new Error("not created")
    const jid = verdict.job.jid
    await offerJob(realCtx(), jid)
    const computer = device()
    const claim = await claimJob(realCtx(), { account: sponsor, jid, device: computer })
    expect(claim.ok).toBe(true)
    const later = { ...realCtx(), now: Date.now() + TIMING.leaseMs + 1_000 }
    const ended = await sweepAccount(later, sponsor)
    expect(ended.map((entry) => entry.job.state)).toEqual(["lost"])
    expect(await readJobBody(realCtx(), jid)).toBeUndefined()
  })
})
