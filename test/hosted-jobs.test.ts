import { RedisClient } from "bun"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { perkServices } from "../api/_lib/codium-perks"
import { hosted as hostedProvisioner } from "../api/_lib/codium-provisioners"
import { switchKey } from "../api/_lib/codium-switches"
import { registerHostedJobsRunner } from "../api/_lib/hosted-crons"
import { hostedMinutesKey } from "../api/_lib/hosted-entitlement"
import { handleHostedHeartbeat, handleHostedSessions } from "../api/_lib/hosted-api"
import {
  HOSTED_JOB_SCRIPTS,
  START_RETRY_MS,
  START_TRIES,
  applyHostedJobsTransition,
  chooseJudge,
  doneByMorningConfigured,
  eraseAccountHostedJobs,
  hostedJobKey,
  hostedJobsNightKey,
  hostedJobRecordingKey,
  hostedJobsRecurringDayKey,
  hostedRecurringDueKey,
  hostedSessionModelsKey,
  jobPrompt,
  nextRun,
  readJobRecord,
  recordHostedSessionModel,
  recurringRunId,
  runDueHostedJobs,
  enqueueHostedJob,
  type JobOptions,
} from "../api/_lib/hosted-jobs"
import { handleHostedJob, handleHostedJobApprove, handleHostedJobReport, handleHostedJobs } from "../api/_lib/hosted-jobs-api"
// The two routes' registrations: the reaper's job runner and the heartbeat's recording hook.
import "../api/_lib/hosted-jobs-runtime"
import { readLine } from "../api/_lib/hosted-ledger"
import { computerName } from "../api/_lib/hosted-provider"
import { readSessionRecord, stopHostedSession } from "../api/_lib/hosted-sessions"
import { configuredPlanModels } from "../api/_lib/model-plan-config"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import {
  ACCOUNT_ID,
  DAY,
  HOUR,
  MINUTE,
  R2_HOST,
  daemonBeat,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  type HostedWorld,
} from "./hosted-sessions-fixture"

// WP A55, Done by Morning: jobs queued with success criteria through one entry, the plan's caps (jobs a night and
// recurring jobs a day at enqueue; jobs at once and hours at start), recurring jobs on public pages only, the report
// accepted only with that job's own run token and checked by a judge from another lab, recordings kept 30 days for the
// owner only, "aims to deliver by", Approve that opens the pull request and merges nothing, a failed payment pausing
// the queue and a dispute cancelling it. The store, the ledger, the provider, the bucket and Stripe are fakes.

const root = path.join(import.meta.dir, "..")
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"
const SONNET = "anthropic/claude-sonnet-5.5"
const OTHER_ACCOUNT = "0b7d5a0e-1c2f-4b3a-8d4e-5f6a7b8c9d0e"

let ledger: LedgerBackend
let restore = () => {}
let alerts: { account: string; title: string; tag: string }[] = []
beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = hostedSessionEnvironment()
  await ledger.reset()
  alerts = []
})
afterEach(() => restore())

/** The jobs' scripts as TypeScript, step for step (hosted-jobs.ts). */
function registerJobScripts(w: HostedWorld) {
  const { store, clock } = w.fakes
  const { ENQUEUE, REFUND, SLOT, RECUR, MODELS } = HOSTED_JOB_SCRIPTS
  const counterSet = (key: string, value: number, ttl?: number) => {
    const at = store.expires.get(key)
    store.set(key, String(value))
    if (at !== undefined) store.expires.set(key, at)
    else if (ttl !== undefined) store.expires.set(key, clock.now + ttl)
  }
  store.scripts.set(ENQUEUE, ([counter, record, due, index], [cap, ttl, json, keep, id, at, created]) => {
    if (store.live(record!)) return -1
    const used = Number(store.get(counter!) ?? "0")
    if (used >= Number(cap)) return 0
    counterSet(counter!, used + 1, Number(ttl))
    store.set(record!, json!)
    store.expires.set(record!, clock.now + Number(keep))
    store.zset(due!).set(id!, Number(at))
    store.zset(index!).set(id!, Number(created))
    return used + 1
  })
  store.scripts.set(REFUND, ([counter]) => {
    const used = Number(store.get(counter!) ?? "0")
    if (used <= 0) return 0
    counterSet(counter!, used - 1)
    return used - 1
  })
  store.scripts.set(SLOT, ([running], [id, cap, ttl]) => {
    const members = store.members(running!)
    if (members.has(id!)) return 1
    if (members.size >= Number(cap)) {
      store.prune(running!)
      return 0
    }
    members.add(id!)
    if (store.pttl(running!) < Number(ttl)) store.expires.set(running!, clock.now + Number(ttl))
    return 1
  })
  store.scripts.set(RECUR, ([hash, due], [id, json, cap, member, at]) => {
    const fields = store.hash(hash!)
    if (!fields.has(id!) && fields.size >= Number(cap)) {
      store.prune(hash!)
      return 0
    }
    fields.set(id!, json!)
    store.zset(due!).set(member!, Number(at))
    return 1
  })
  store.scripts.set(MODELS, ([hash], [model, at, lab, ttl]) => {
    const fields = store.hash(hash!)
    fields.set(`c:${model}`, String(Number(fields.get(`c:${model}`) ?? "0") + 1))
    fields.set(`t:${model}`, at!)
    fields.set(`l:${model}`, lab!)
    store.expires.set(hash!, clock.now + Number(ttl))
    return 1
  })
}

async function world() {
  const w = await hostedWorld(ledger)
  registerJobScripts(w)
  return w
}

/** The tiered catalog (with Claude Sonnet 5.5, Max's judge) as served models, for picking judges. */
const TIERED = { models: configuredPlanModels({ tiered: true }), qualify: () => true }

function options(w: HostedWorld, extra: Partial<JobOptions> = {}): JobOptions {
  return {
    ...w.options,
    catalog: TIERED,
    alert: async (account, alert) => {
      alerts.push({ account, ...alert })
    },
    ...extra,
  }
}

const runQueue = (w: HostedWorld, extra: Partial<JobOptions> = {}) =>
  runDueHostedJobs({ ...options(w, extra), budgetMs: 15_000 })

function jobBody(w: HostedWorld, body: Record<string, unknown> = {}) {
  return {
    prompt: "Fix the flaky checkout test.",
    criteria: ["The checkout test passes ten runs in a row.", "No other test changes."],
    deliverBy: w.fakes.clock.now + 8 * HOUR,
    ...body,
  }
}

async function queue(w: HostedWorld, body: Record<string, unknown> = {}, authorization = w.desktopToken()) {
  return invoke((request, response) => handleHostedJobs(request, response, options(w)), {
    method: "POST",
    authorization,
    body: jobBody(w, body),
  })
}

async function queued(w: HostedWorld, body: Record<string, unknown> = {}) {
  const answer = await queue(w, body)
  expect([answer.status, answer.body?.error?.code]).toEqual([201, undefined])
  return answer.body.job as Hosted.JobView
}

async function record(w: HostedWorld, id: string) {
  return (await readJobRecord(id, w.fetcher))!
}

/** Queues one job and runs the queue: answers the job and its session's run token. */
async function started(w: HostedWorld, body: Record<string, unknown> = {}) {
  const job = await queued(w, body)
  const pass = await runQueue(w)
  expect(pass.started).toBe(1)
  const running = await record(w, job.id)
  expect(running.state).toBe("running")
  return { job: running, token: w.provider.token(computerName(ACCOUNT_ID, 1))! }
}

function report(w: HostedWorld, id: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return invoke((request, response) => handleHostedJobReport(request, response, options(w)), {
    method: "POST",
    authorization: token,
    body,
    query: { id },
    headers,
  })
}

function heartbeat(w: HostedWorld, session: string, token: string, body: Record<string, unknown> = {}) {
  return invoke((request, response) => handleHostedHeartbeat(request, response, w.options), {
    method: "POST",
    authorization: token,
    body: daemonBeat(session, { activeAt: w.fakes.clock.now, ...body }),
    query: { id: session },
  })
}

async function endSession(w: HostedWorld, session: string) {
  await stopHostedSession(ACCOUNT_ID, session, w.options)
  expect((await readSessionRecord(session, w.fetcher))!.state).toBe("ended")
}

/** Every numeric field a Done by Morning answer may carry: counts, minutes and times. */
const NUMERIC = new Set([
  "jobMinutes",
  "deliverBy",
  "startAfter",
  "createdAt",
  "startedAt",
  "endedAt",
  "submittedAt",
  "approvedAt",
  "segments",
  "until",
  "timeOfDay",
  "nextAt",
  "perNight",
  "atOnce",
  "recurringPerDay",
  "n",
  "expiresAt",
])
const MONEY = /\$|usd|price|cost|credit|cents|micro|charge|rate|amount|dollar|pool/i

function expectCounts(answer: unknown, at = "$") {
  if (Array.isArray(answer)) return answer.forEach((item, index) => expectCounts(item, `${at}[${index}]`))
  if (!answer || typeof answer !== "object") return
  for (const [key, value] of Object.entries(answer)) {
    expect(key).not.toMatch(MONEY)
    if (typeof value === "number") {
      expect([`${at}.${key}`, NUMERIC.has(key)]).toEqual([`${at}.${key}`, true])
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expectCounts(value, `${at}.${key}`)
  }
}

// ── Queueing ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("queueing a job (enqueueHostedJob, the single entry)", () => {
  test("the desktop queues a job: queued with its criteria, aims to deliver by its time, counts and times only (P1)", async () => {
    const w = await world()
    const answer = await queue(w, { title: "Flaky test" })
    expect(answer.status).toBe(201)
    const job = answer.body.job as Hosted.JobView
    expect(job).toMatchObject({
      state: "queued",
      title: "Flaky test",
      criteria: ["The checkout test passes ten runs in a row.", "No other test changes."],
      size: "standard",
      // Max's longest job is 4 hours; the job fits in the 8 hours before its time.
      jobMinutes: 240,
      startAfter: w.fakes.clock.now,
      deliverBy: w.fakes.clock.now + 8 * HOUR,
    })
    expect(Hosted.JOB_ID.test(job.id)).toBe(true)
    expectCounts(answer.body)
    const list = await invoke((request, response) => handleHostedJobs(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
    })
    expect(list.body).toMatchObject({ available: true, queue: "open", plan: { perNight: 3, atOnce: 1, recurringPerDay: 5 } })
    expect(list.body.jobs.map((item: Hosted.JobView) => item.id)).toEqual([job.id])
    expectCounts(list.body)
    // The session is told the criteria and the time it aims for, and that going live waits for the person.
    const prompt = jobPrompt(await record(w, job.id))
    expect(prompt).toContain(`${Hosted.DELIVER_LABEL} ${new Date(job.deliverBy).toISOString()}`)
    expect(prompt).toContain("1. The checkout test passes ten runs in a row.")
    expect(prompt).toContain("never merge it")
    expect(Hosted.DELIVER_LABEL).toBe("Aims to deliver by")
  })

  test("jobs a night are counted when queued (on the UTC date of the deliver-by time); a cancelled queued job gives its count back", async () => {
    const w = await world()
    const night = w.fakes.clock.now + 8 * HOUR
    const jobs = [await queued(w, { deliverBy: night }), await queued(w, { deliverBy: night }), await queued(w, { deliverBy: night })]
    const fourth = await queue(w, { deliverBy: night })
    expect([fourth.status, fourth.body.error.code, fourth.body.error.limit, fourth.body.error.cap]).toEqual([
      429,
      "HOSTED_JOB_LIMIT",
      "per-night",
      3,
    ])
    const date = new Date(night).toISOString().slice(0, 10)
    expect(w.fakes.store.get(hostedJobsNightKey(ACCOUNT_ID, date))).toBe("3")
    const cancel = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { action: "cancel" },
      query: { id: jobs[0]!.id },
    })
    expect(cancel.body.job).toMatchObject({ state: "cancelled", reason: "cancelled" })
    expect(w.fakes.store.get(hostedJobsNightKey(ACCOUNT_ID, date))).toBe("2")
    expect((await queue(w, { deliverBy: night })).status).toBe(201)
  })

  test("the job itself is checked: criteria, its time, its minutes, size and pages", async () => {
    const w = await world()
    const now = w.fakes.clock.now
    const cases: [Record<string, unknown>, number, string][] = [
      [{ criteria: [] }, 400, "HOSTED_REQUEST"],
      [{ criteria: Array.from({ length: 11 }, (_, index) => `criterion ${index}`) }, 400, "HOSTED_REQUEST"],
      [{ criteria: ["x".repeat(301)] }, 400, "HOSTED_REQUEST"],
      [{ deliverBy: now + 10 * MINUTE }, 400, "HOSTED_REQUEST"],
      [{ deliverBy: now + 25 * HOUR }, 400, "HOSTED_REQUEST"],
      [{ jobMinutes: 241 }, 403, "HOSTED_NOT_INCLUDED"],
      [{ jobMinutes: 10 }, 400, "HOSTED_REQUEST"],
      [{ jobMinutes: 120, deliverBy: now + HOUR }, 400, "HOSTED_REQUEST"],
      [{ size: "large" }, 403, "HOSTED_NOT_INCLUDED"],
      [{ pages: ["https://10.0.0.8/admin"] }, 400, "HOSTED_REQUEST"],
      [{ pages: ["https://localhost/"] }, 400, "HOSTED_REQUEST"],
      [{ pages: ["http://example.com/"] }, 400, "HOSTED_REQUEST"],
      [{ prompt: "" }, 400, "HOSTED_REQUEST"],
      [{ startAfter: now - HOUR }, 400, "HOSTED_REQUEST"],
      [{ plan: "vector-200" }, 400, "HOSTED_REQUEST"],
    ]
    for (const [body, status, code] of cases) {
      const answer = await queue(w, body)
      expect([JSON.stringify(body), answer.status, answer.body.error?.code]).toEqual([JSON.stringify(body), status, code])
    }
    expect((await queue(w, { pages: ["https://status.example.com/"] })).status).toBe(201)
    // A criterion is kept on one line.
    const folded = await queued(w, { criteria: ["two\nlines"] })
    expect(folded.criteria).toEqual(["two lines"])
  })

  test("a reserved source is refused with reason source-unavailable; only hosted jobs are queued here", async () => {
    const w = await world()
    const trigger = {
      source: "slack" as const,
      account: ACCOUNT_ID,
      target: { kind: "hosted-job" as const },
      prompt: "Check the site.",
      criteria: ["It loads."],
      deliverBy: w.fakes.clock.now + 4 * HOUR,
      purpose: "task" as const,
    }
    await expect(enqueueHostedJob(trigger, options(w))).rejects.toMatchObject({
      statusCode: 403,
      code: "HOSTED_JOB_REFUSED",
      detail: { reason: "source-unavailable" },
    })
    await expect(
      enqueueHostedJob({ ...trigger, source: "phone", target: { kind: "github-run", repositoryId: 7 } }, options(w)),
    ).rejects.toMatchObject({ code: "HOSTED_REQUEST" })
    const phone = await enqueueHostedJob({ ...trigger, source: "phone" }, options(w))
    expect(phone.state).toBe("queued")
    expect((await record(w, phone.id)).source).toBe("phone")
  })

  test("S1: the plan decides from the snapshot (Pro, paused, frozen, not listed, the switch, run tokens, unmarked tokens)", async () => {
    const w = await world()
    const expectCode = async (status: number, code: string, authorization?: string) => {
      const answer = await queue(w, {}, authorization)
      expect([answer.status, answer.body.error?.code]).toEqual([status, code])
    }
    // Run tokens never reach the person's routes (S3); a token copied from the website is not a marked token (S2).
    await expectCode(401, "SIGN_IN_REQUIRED", `vht_${"a".repeat(40)}`)
    await expectCode(401, "SIGN_IN_REQUIRED", `vrt_${"a".repeat(40)}`)
    await expectCode(401, "CODIUM_SIGN_IN_REQUIRED", w.desktopToken("unmarked"))
    w.setSnapshot({ plan: "vector-50" })
    await expectCode(403, "HOSTED_NOT_INCLUDED")
    w.setSnapshot({ plan: "vector-100", state: "paused", reason: "payment_failed" })
    await expectCode(402, "HOSTED_PAUSED")
    w.setSnapshot({ state: "frozen", reason: "disputed" })
    await expectCode(403, "HOSTED_FROZEN")
    w.setSnapshot({ state: "active", reason: undefined })
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "no-new", changedAt: w.fakes.clock.now, generation: "g" }))
    w.advance(31_000) // past the switch's 30-second cache
    await expectCode(503, "HOSTED_UNAVAILABLE")
    w.fakes.store.remove(switchKey("hosted"))
    w.advance(31_000)
    process.env.VECTOR_HOSTED_ALLOW_ACCOUNTS = ""
    await expectCode(503, "HOSTED_UNAVAILABLE")
  })
})

// ── Running the queue ──────────────────────────────────────────────────────────────────────────────────────────────

describe("running the queue (the reaper's pass)", () => {
  test("jobs at once and the plan's computers are counted at start: the second job waits, then starts when the first ends", async () => {
    const w = await world()
    const jobs = [await queued(w), await queued(w)]
    const pass = await runQueue(w)
    expect(pass).toMatchObject({ started: 1, waiting: 1 })
    const states = await Promise.all(jobs.map((job) => record(w, job.id)))
    const first = states.find((job) => job.state === "running")!
    const second = states.find((job) => job.state !== "running")!
    const running = await record(w, first.id)
    expect(running).toMatchObject({ state: "running" })
    expect(running.session).toBeDefined()
    expect((await record(w, second.id)).waiting).toBe("busy")
    // The job's session runs the composed prompt, from the schedule.
    const session = (await readSessionRecord(running.session!, w.fetcher))!
    expect(session).toMatchObject({ source: "schedule", title: "Done by Morning" })
    const beat = await heartbeat(w, session.id, w.provider.token(computerName(ACCOUNT_ID, 1))!)
    expect(beat.body.job.prompt).toBe(jobPrompt(running))
    await endSession(w, session.id)
    const next = await runQueue(w)
    expect(next).toMatchObject({ settled: 1, started: 1 })
    expect(await record(w, first.id)).toMatchObject({ state: "incomplete", reason: "stopped" })
    expect((await record(w, second.id)).state).toBe("running")
    expect(alerts.map((alert) => [alert.title, alert.tag])).toEqual([["Done by Morning: a job did not finish", "overnight"]])
  })

  test("hours are checked at start: a job that cannot start because the month's hours are used is missed", async () => {
    const w = await world()
    const job = await queued(w)
    w.fakes.store.hash(hostedMinutesKey(ACCOUNT_ID, w.snapshot().meterEpoch)).set("used", String(20 * 60))
    expect(await runQueue(w)).toMatchObject({ missed: 1 })
    expect(await record(w, job.id)).toMatchObject({ state: "missed", reason: "hours" })
    expect(w.provider.calls).toEqual([])
    expect(alerts.map((alert) => alert.title)).toEqual(["Done by Morning: a job could not start in time"])
  })

  test("a computer that keeps failing to boot is charged once, then the job is missed, never retried every minute (P8 review)", async () => {
    const w = await world()
    const job = await queued(w)
    // Every boot fails 30 seconds in, after the computer started: that session's minute is charged (M8).
    w.provider.boot = async (name: string) => {
      w.provider.calls.push(`boot ${name}`)
      w.advance(30_000)
      throw new Error("broken image")
    }
    expect(await runQueue(w)).toMatchObject({ started: 0, missed: 1 })
    for (let minute = 0; minute < 120; minute++) {
      w.advance(MINUTE)
      await runQueue(w)
    }
    expect(await record(w, job.id)).toMatchObject({ state: "missed", reason: "failed", startTries: 1 })
    expect(w.provider.calls.filter((call) => call.startsWith("start"))).toHaveLength(1)
    const sessions = [...w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys()]
    expect(sessions).toHaveLength(1)
    expect(await readLine(ACCOUNT_ID, `hb-${sessions[0]}-0`, w.options)).toMatchObject({ kind: "block", units: 1 })
    expect(alerts.map((alert) => alert.title)).toEqual(["Done by Morning: a job could not start"])
  })

  test("a start the provider refuses is tried again after 5 and 15 minutes, then the job is missed, nothing charged", async () => {
    const w = await world()
    const job = await queued(w)
    w.provider.fail.start = true
    const starts = () => w.provider.calls.filter((call) => call.startsWith("start")).length
    expect(await runQueue(w)).toMatchObject({ started: 0, waiting: 1 })
    expect(await record(w, job.id)).toMatchObject({ state: "queued", startTries: 1 })
    w.advance(4 * MINUTE)
    await runQueue(w)
    expect(starts()).toBe(1)
    w.advance(MINUTE)
    await runQueue(w)
    expect([starts(), (await record(w, job.id)).startTries]).toEqual([2, 2])
    w.advance(14 * MINUTE)
    await runQueue(w)
    expect(starts()).toBe(2)
    w.advance(MINUTE)
    expect(await runQueue(w)).toMatchObject({ missed: 1 })
    expect(await record(w, job.id)).toMatchObject({ state: "missed", reason: "failed", startTries: 3 })
    expect(starts()).toBe(START_TRIES)
    w.advance(HOUR)
    await runQueue(w)
    expect(starts()).toBe(START_TRIES)
    for (const session of w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys())
      expect((await readLine(ACCOUNT_ID, `hb-${session}-0`, w.options))?.units ?? 0).toBe(0)
    expect(START_RETRY_MS).toEqual([5 * MINUTE, 15 * MINUTE])
  })

  test("a job waits until its start; one still queued at its deliver-by time is missed, never started late", async () => {
    const w = await world()
    const now = w.fakes.clock.now
    const later = await queued(w, { startAfter: now + 2 * HOUR, deliverBy: now + 7 * HOUR, jobMinutes: 60 })
    expect(await runQueue(w)).toMatchObject({ started: 0, waiting: 0 })
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "no-new", changedAt: now, generation: "g" }))
    w.advance(2 * HOUR)
    expect(await runQueue(w)).toMatchObject({ waiting: 1 })
    expect((await record(w, later.id)).waiting).toBe("queue")
    w.advance(5 * HOUR)
    expect(await runQueue(w)).toMatchObject({ missed: 1, started: 0 })
    expect(await record(w, later.id)).toMatchObject({ state: "missed", reason: "late" })
    expect(w.provider.calls).toEqual([])
  })

  test("renewing starts nothing (started jobs continue); a failed payment pauses the queue and its jobs are missed if it lasts", async () => {
    const w = await world()
    const job = await queued(w, { deliverBy: w.fakes.clock.now + 3 * HOUR, jobMinutes: 60 })
    w.setSnapshot({ state: "renewing" })
    expect(await runQueue(w)).toMatchObject({ waiting: 1, started: 0 })
    w.setSnapshot({ state: "paused", reason: "payment_failed" })
    expect(await runQueue(w)).toMatchObject({ waiting: 1 })
    expect(await record(w, job.id)).toMatchObject({ state: "queued", waiting: "paused" })
    const list = await invoke((request, response) => handleHostedJobs(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
    })
    expect(list.body.queue).toBe("paused")
    // The paused plan's transition leaves the queue alone (§4.4: queue paused).
    await applyHostedJobsTransition(
      { account: ACCOUNT_ID, to: w.snapshot(), cause: "payment_failed" },
      options(w),
    )
    expect((await record(w, job.id)).state).toBe("queued")
    w.advance(3 * HOUR)
    await runQueue(w)
    expect(await record(w, job.id)).toMatchObject({ state: "missed", reason: "paused" })
    expect(w.provider.calls).toEqual([])
  })

  test("a dispute cancels the queue (recurring jobs kept for a won dispute); an ended plan cancels it and removes recurring jobs", async () => {
    const w = await world()
    const a = await queued(w)
    const pages = ["https://status.example.com/"]
    const recurring = await invoke((request, response) => handleHostedJobs(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { prompt: "Check the status page.", criteria: ["It says all systems normal."], pages, jobMinutes: 30, recurring: { timeOfDay: 600 } },
    })
    expect(recurring.status).toBe(201)
    const frozen = w.setSnapshot({ state: "frozen", reason: "disputed" })
    // Through the `hosted` provisioner, which runs Done by Morning's part first.
    await hostedProvisioner.apply({ account: ACCOUNT_ID, to: frozen, cause: "disputed" }, w.fetcher)
    expect(await record(w, a.id)).toMatchObject({ state: "cancelled", reason: "frozen" })
    expect(w.fakes.store.hash(codiumKey("hosted", "jobs", "recurring", ACCOUNT_ID)).size).toBe(1)
    w.setSnapshot({ state: "active", reason: undefined })
    const b = await queued(w)
    const ended = w.setSnapshot({ state: "ended", reason: "canceled" })
    await applyHostedJobsTransition({ account: ACCOUNT_ID, to: ended, cause: "ended" }, options(w))
    expect(await record(w, b.id)).toMatchObject({ state: "cancelled", reason: "plan" })
    expect(w.fakes.store.keys().filter((key) => key.includes(":hosted:jobs:recurring"))).toEqual([])
    // A downgrade to a plan without Done by Morning cancels too.
    w.setSnapshot({ state: "active", reason: undefined })
    const c = await queued(w)
    const pro = w.setSnapshot({ plan: "vector-50" })
    await applyHostedJobsTransition({ account: ACCOUNT_ID, to: pro, cause: "downgrade" }, options(w))
    expect(await record(w, c.id)).toMatchObject({ state: "cancelled", reason: "plan" })
  })

  test("the runner also cancels a queued job whose plan ended before any transition reached it", async () => {
    const w = await world()
    const job = await queued(w)
    w.setSnapshot({ state: "frozen", reason: "early_fraud_warning" })
    expect(await runQueue(w)).toMatchObject({ cancelled: 1 })
    expect(await record(w, job.id)).toMatchObject({ state: "cancelled", reason: "frozen" })
  })
})

// ── The report ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the report", () => {
  test("is accepted only with that job's own run token, never an account token or a browser-shaped request (S3, S7)", async () => {
    const w = await world()
    const { job, token } = await started(w)
    const body = { summary: "Fixed the race in the checkout test." }
    expect((await report(w, job.id, w.desktopToken(), body)).status).toBe(401)
    const browser = await report(w, job.id, token, body, { origin: "https://example.com" })
    expect([browser.status, browser.body.error.code]).toEqual([403, "HOSTED_RUN_REFUSED"])
    // A second job on another session: its token cannot report for the first job.
    const other = await enqueueHostedJob(
      {
        source: "desktop",
        account: ACCOUNT_ID,
        target: { kind: "hosted-job" },
        prompt: "Another job.",
        criteria: ["Done."],
        deliverBy: w.fakes.clock.now + 6 * HOUR,
        purpose: "task",
      },
      options(w),
    )
    const otherSession = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
      method: "GET",
      authorization: w.desktopToken(),
    })
    expect(otherSession.status).toBe(200)
    const wrong = await report(w, other.id, token, body)
    expect([wrong.status, wrong.body.error.code]).toEqual([403, "HOSTED_RUN_REFUSED"])
    const ok = await report(w, job.id, token, body)
    expect(ok.status).toBe(200)
  })

  test("the judge comes from another lab than every model the session used, and its pass or fail is taken only after the session asked it", async () => {
    const w = await world()
    const { job, token } = await started(w, { title: "Flaky test" })
    await recordHostedSessionModel(job.session!, { id: DEEPSEEK, lab: "deepseek" }, w.fakes.clock.now, w.fetcher)
    w.advance(MINUTE)
    const first = await report(w, job.id, token, {
      summary: "Fixed the race in the checkout test.",
      links: [{ title: "Run log", url: "https://ci.example.com/run/7" }],
      pullRequest: "https://github.com/acme/shop/pull/42",
    })
    expect(first.status).toBe(200)
    // Max: Claude Sonnet 5.5 checks the work of every model from another lab.
    expect(first.body).toEqual({ judge: { model: SONNET }, criteria: job.criteria })
    const results = [{ pass: true }, { pass: false, note: "One snapshot test was updated." }]
    const wrong = await report(w, job.id, token, { judge: DEEPSEEK, results })
    expect([wrong.status, wrong.body.error.code]).toEqual([409, "HOSTED_JOB_JUDGE"])
    const early = await report(w, job.id, token, { judge: SONNET, results })
    expect([early.status, early.body.error.code]).toEqual([409, "HOSTED_JOB_JUDGE"])
    w.advance(MINUTE)
    await recordHostedSessionModel(job.session!, { id: SONNET, lab: "anthropic" }, w.fakes.clock.now, w.fetcher)
    expect((await report(w, job.id, token, { judge: SONNET, results: [{ pass: true }] })).status).toBe(400)
    const verdict = await report(w, job.id, token, { judge: SONNET, results })
    expect(verdict.body).toEqual({ accepted: true })
    expect((await report(w, job.id, token, { judge: SONNET, results })).status).toBe(409)
    await endSession(w, job.session!)
    await runQueue(w)
    const detail = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
      query: { id: job.id },
    })
    expect(detail.body.job).toMatchObject({
      state: "reported",
      report: {
        summary: "Fixed the race in the checkout test.",
        links: [{ title: "Run log", url: "https://ci.example.com/run/7" }],
        pullRequest: "https://github.com/acme/shop/pull/42",
        judged: true,
        judge: { model: SONNET, lab: "anthropic" },
        results: [
          { criterion: job.criteria[0], pass: true },
          { criterion: job.criteria[1], pass: false, note: "One snapshot test was updated." },
        ],
      },
    })
    expect((await record(w, job.id)).report!.workerLabs).toEqual(["deepseek"])
    expectCounts(detail.body)
    expect(alerts.map((alert) => alert.title)).toEqual(["Done by Morning: a job is ready"])
  })

  test("with no served model from another lab the report stands unjudged, and says so", async () => {
    const w = await world()
    const { job, token } = await started(w)
    // The session used both of Max's judges' labs.
    await recordHostedSessionModel(job.session!, { id: SONNET, lab: "anthropic" }, w.fakes.clock.now, w.fetcher)
    await recordHostedSessionModel(job.session!, { id: "openai/gpt-6-luna", lab: "openai" }, w.fakes.clock.now, w.fetcher)
    const first = await report(w, job.id, token, { summary: "Done." })
    expect(first.body.judge).toBeNull()
    expect((await report(w, job.id, token, { judge: SONNET, results: [{ pass: true }, { pass: true }] })).body.error.code).toBe(
      "HOSTED_JOB_STATE",
    )
    await endSession(w, job.session!)
    await runQueue(w)
    const ended = await record(w, job.id)
    expect(ended.state).toBe("reported")
    const detail = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
      query: { id: job.id },
    })
    expect(detail.body.job.report).toMatchObject({ judged: false })
    expect(detail.body.job.report.judge).toBeUndefined()
    expect(detail.body.job.report.results).toBeUndefined()
  })

  test("chooseJudge: the most used model's judge first, any lab the session used excluded, unknown labs never judged", () => {
    const served = {
      judges: { [DEEPSEEK]: SONNET, [SONNET]: "openai/gpt-6.1-sol:deep", "openai/gpt-6-luna": SONNET },
      labs: { [DEEPSEEK]: "deepseek", [SONNET]: "anthropic", "openai/gpt-6.1-sol:deep": "openai", "openai/gpt-6-luna": "openai" },
    }
    expect(chooseJudge(served, [{ model: DEEPSEEK, count: 9, at: 1 }])).toEqual({ model: SONNET, lab: "anthropic" })
    expect(chooseJudge(served, [{ model: SONNET, count: 9, at: 1 }])).toEqual({ model: "openai/gpt-6.1-sol:deep", lab: "openai" })
    expect(
      chooseJudge(served, [
        { model: SONNET, count: 2, at: 1 },
        { model: "openai/gpt-6-luna", count: 1, at: 1 },
      ]),
    ).toBeUndefined()
    expect(chooseJudge(served, [{ model: "someone/unknown", count: 1, at: 1 }])).toBeUndefined()
    expect(chooseJudge(served, [])).toEqual({ model: SONNET, lab: "anthropic" })
    expect(chooseJudge({ judges: {}, labs: {} }, [])).toBeUndefined()
  })

  test("a session that ends with no report leaves the job incomplete with the session's reason", async () => {
    const w = await world()
    const { job } = await started(w)
    await endSession(w, job.session!)
    await runQueue(w)
    expect(await record(w, job.id)).toMatchObject({ state: "incomplete", reason: "stopped" })
    const late = await report(w, job.id, w.provider.token(computerName(ACCOUNT_ID, 1)) ?? "vht_x", { summary: "Late." })
    expect(late.status).toBeGreaterThanOrEqual(400)
  })

  test("what a report may carry is checked: summary, links, the pull request's address", async () => {
    const w = await world()
    const { job, token } = await started(w)
    for (const body of [
      {},
      { summary: "" },
      { summary: "x".repeat(4001) },
      { summary: "ok", links: [{ url: "http://example.com/" }] },
      { summary: "ok", links: Array.from({ length: 21 }, () => "https://example.com/") },
      { summary: "ok", pullRequest: "https://example.com/acme/shop/pull/1" },
      { summary: "ok", pullRequest: "https://github.com/acme/shop/issues/1" },
      { summary: "ok", extra: 1 },
    ]) {
      const answer = await report(w, job.id, token, body)
      expect([JSON.stringify(body).slice(0, 60), answer.status]).toEqual([JSON.stringify(body).slice(0, 60), 400])
    }
  })
})

// ── Approve ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("approve", () => {
  test("answers the pull request to open and records when; the server calls nothing and merges nothing (S9)", async () => {
    const w = await world()
    const calls: string[] = []
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)).host)
      return w.fetcher(input, init)
    }) as typeof fetch
    const { job, token } = await started(w)
    await report(w, job.id, token, { summary: "Ready for review.", pullRequest: "https://github.com/acme/shop/pull/42" })
    const before = calls.length
    const approve = await invoke((request, response) => handleHostedJobApprove(request, response, options(w, { fetcher: watched })), {
      method: "POST",
      authorization: w.desktopToken(),
      body: {},
      query: { id: job.id },
    })
    expect(approve.status).toBe(200)
    expect(approve.body.url).toBe("https://github.com/acme/shop/pull/42")
    expect(approve.body.job.approvedAt).toBe(w.fakes.clock.now)
    expect(calls.slice(before).some((host) => host.endsWith("github.com"))).toBe(false)
    // A job with no pull request has nothing to approve; another account's job is not found.
    const plain = await started(await (async () => {
      await endSession(w, job.session!)
      await runQueue(w)
      return w
    })())
    await report(w, plain.job.id, plain.token, { summary: "No changes needed." })
    const none = await invoke((request, response) => handleHostedJobApprove(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body: {},
      query: { id: plain.job.id },
    })
    expect([none.status, none.body.error.code]).toEqual([409, "HOSTED_JOB_STATE"])
  })

  test("another account's job is not found by any person's route", async () => {
    const w = await world()
    const job = await queued(w)
    const raw = w.fakes.store.get(hostedJobKey(job.id))!
    w.fakes.store.set(hostedJobKey(job.id), raw.replace(ACCOUNT_ID, OTHER_ACCOUNT))
    for (const [handler, method, body] of [
      [handleHostedJob, "GET", undefined],
      [handleHostedJob, "POST", { action: "cancel" }],
      [handleHostedJobApprove, "POST", {}],
    ] as const) {
      const answer = await invoke((request, response) => handler(request, response, options(w)), {
        method,
        authorization: w.desktopToken(),
        ...(body ? { body } : {}),
        query: { id: job.id },
      })
      expect([answer.status, answer.body.error.code]).toEqual([404, "HOSTED_JOB_NOT_FOUND"])
    }
  })
})

// ── Recurring jobs ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("recurring jobs", () => {
  const recurringBody = (extra: Record<string, unknown> = {}) => ({
    prompt: "Check the pricing page renders.",
    criteria: ["The page shows four plans."],
    pages: ["https://shop.example.com/pricing"],
    jobMinutes: 30,
    recurring: { timeOfDay: 600 },
    ...extra,
  })
  const add = (w: HostedWorld, body: Record<string, unknown>) =>
    invoke((request, response) => handleHostedJobs(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body,
    })

  test("run on public pages only, at most the plan's recurring jobs a day", async () => {
    const w = await world()
    expect((await add(w, recurringBody({ pages: undefined }))).status).toBe(400)
    expect((await add(w, recurringBody({ pages: [] }))).status).toBe(400)
    expect((await add(w, recurringBody({ pages: ["https://192.168.1.1/"] }))).status).toBe(400)
    expect((await add(w, recurringBody({ deliverBy: w.fakes.clock.now + HOUR }))).status).toBe(400)
    expect((await add(w, recurringBody({ recurring: { timeOfDay: 1440 } }))).status).toBe(400)
    expect((await add(w, recurringBody({ recurring: { timeOfDay: 60, days: [7] } }))).status).toBe(400)
    for (let index = 0; index < 5; index++) expect((await add(w, recurringBody())).status).toBe(201)
    const sixth = await add(w, recurringBody())
    expect([sixth.status, sixth.body.error.code, sixth.body.error.limit, sixth.body.error.cap]).toEqual([
      429,
      "HOSTED_JOB_LIMIT",
      "recurring",
      5,
    ])
  })

  test("each run is queued through the single entry once, counted per day, told to use public pages only, and the next run scheduled", async () => {
    const w = await world()
    const now = w.fakes.clock.now
    const minuteOfDay = Math.floor((now % DAY) / MINUTE)
    const timeOfDay = (minuteOfDay + 10) % 1440
    const saved = await add(w, recurringBody({ recurring: { timeOfDay } }))
    expect(saved.status).toBe(201)
    const view = saved.body.recurring as Hosted.RecurringView
    expect(view.nextAt).toBe(nextRun(now, { timeOfDay, days: [0, 1, 2, 3, 4, 5, 6] }))
    expectCounts(saved.body)
    expect(await runQueue(w)).toMatchObject({ fired: 0 })
    w.advance(view.nextAt - now)
    const pass = await runQueue(w)
    expect(pass).toMatchObject({ fired: 1, started: 1 })
    const id = recurringRunId(view.id, view.nextAt)
    const run = await record(w, id)
    expect(run).toMatchObject({ state: "running", source: "schedule", purpose: "scheduled", recurring: view.id, jobMinutes: 30 })
    expect(jobPrompt(run)).toContain("Work only from these public pages. Do not sign in anywhere")
    const day = new Date(view.nextAt).toISOString().slice(0, 10)
    expect(w.fakes.store.get(hostedJobsRecurringDayKey(ACCOUNT_ID, day))).toBe("1")
    expect(w.fakes.store.get(hostedJobsNightKey(ACCOUNT_ID, day))).toBeUndefined()
    const member = `${ACCOUNT_ID}:${view.id}`
    expect(w.fakes.store.zset(hostedRecurringDueKey()).get(member)).toBe(view.nextAt + DAY)
    // An overlapping pass that fires the same run again queues nothing new and counts nothing.
    w.fakes.store.zset(hostedRecurringDueKey()).set(member, view.nextAt)
    await runQueue(w)
    expect(w.fakes.store.get(hostedJobsRecurringDayKey(ACCOUNT_ID, day))).toBe("1")
    expect(w.fakes.store.zset(codiumKey("hosted", "jobs", "account", ACCOUNT_ID)).size).toBe(1)
    // Removing it stops later runs.
    const removed = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { action: "cancel" },
      query: { id: view.id },
    })
    expect(removed.body).toEqual({ id: view.id, removed: true })
    expect(w.fakes.store.zset(hostedRecurringDueKey()).has(member)).toBe(false)
  })

  test("a run more than two hours late is skipped, not queued", async () => {
    const w = await world()
    const now = w.fakes.clock.now
    const timeOfDay = (Math.floor((now % DAY) / MINUTE) + 10) % 1440
    const view = (await add(w, recurringBody({ recurring: { timeOfDay } }))).body.recurring as Hosted.RecurringView
    w.advance(view.nextAt - now + 3 * HOUR)
    expect(await runQueue(w)).toMatchObject({ fired: 0 })
    expect(w.fakes.store.zset(hostedRecurringDueKey()).get(`${ACCOUNT_ID}:${view.id}`)).toBe(view.nextAt + DAY)
  })
})

// ── Recordings ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("recordings (30 days, owner only)", () => {
  function objectKey(url: string) {
    return decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/"))
  }

  test("a job's session uploads its last segments to signed links; the owner gets 15-minute links for 30 days", async () => {
    const w = await world()
    const { job, token } = await started(w)
    const session = job.session!
    const first = await heartbeat(w, session, token)
    expect(first.body.recording).toEqual({ uploads: [] })
    const second = await heartbeat(w, session, token, {
      segments: [
        { n: 0, bytes: 1000 },
        { n: 1, bytes: Hosted.RECORDING_SEGMENT_MAX_BYTES + 1 },
      ],
    })
    expect(second.body.recording.uploads).toHaveLength(1)
    const upload = second.body.recording.uploads[0]
    expect(upload).toMatchObject({ n: 0, headers: { "content-length": "1000", "content-type": "video/mp2t" } })
    const key = objectKey(upload.url)
    expect(key).toMatch(new RegExp(`^recordings/test/[a-f0-9]{32}/${job.id}/slot-0\\.ts$`))
    expect(key).not.toContain(ACCOUNT_ID)
    // Not uploaded yet: a claim alone does not count.
    await heartbeat(w, session, token, { uploadedSegments: [0] })
    let detail = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
      query: { id: job.id },
    })
    expect(detail.body.job.recording).toBeUndefined()
    w.bucket.set(key, 1000)
    await heartbeat(w, session, token, { uploadedSegments: [0] })
    detail = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
      query: { id: job.id },
    })
    expect(detail.body.job.recording).toMatchObject({ segments: 1 })
    const link = new URL(detail.body.recording.segments[0].url)
    expect(link.host).toBe(R2_HOST)
    expect(link.searchParams.get("response-content-type")).toBe("video/mp2t")
    expect(link.searchParams.get("response-cache-control")).toBe("private, no-store")
    expect(Number(link.searchParams.get("X-Amz-Expires"))).toBe(900)
    expectCounts(detail.body)
    // A segment newer than the session's minutes allow (one a minute) gets no link and moves nothing, so a report can
    // never push the real segments out of the last ten (P8 review).
    const early = await heartbeat(w, session, token, { segments: [{ n: 999_999, bytes: 1 }, { n: 12, bytes: 500 }] })
    expect(early.body.recording.uploads).toEqual([])
    expect(w.fakes.store.hash(hostedJobRecordingKey(job.id)).get(String(999_999 % Hosted.RECORDING_SEGMENTS))).toBeUndefined()
    // A segment that falls out of the last ten gets no link; a newer one replaces the oldest slot.
    w.advance(12 * MINUTE)
    const window = await heartbeat(w, session, token, { segments: [{ n: 12, bytes: 500 }] })
    expect(window.body.recording.uploads.map((item: { n: number }) => item.n)).toEqual([12])
    const stale = await heartbeat(w, session, token, { segments: [{ n: 1, bytes: 500 }] })
    expect(stale.body.recording.uploads).toEqual([])
    // 30 days after the job ended, no more links.
    await endSession(w, session)
    await runQueue(w)
    w.advance(Hosted.RECORDING_DAYS * DAY + MINUTE)
    detail = await invoke((request, response) => handleHostedJob(request, response, options(w)), {
      method: "GET",
      authorization: w.desktopToken(),
      query: { id: job.id },
    })
    expect(detail.body.job.recording).toBeUndefined()
    expect(detail.body.recording).toBeUndefined()
  })

  test("a session that runs no job gets no recording in its answers", async () => {
    const w = await world()
    const start = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 30, prompt: "Look around." },
    })
    expect(start.status).toBe(201)
    const beat = await heartbeat(w, start.body.session.id, w.provider.token(computerName(ACCOUNT_ID, 1))!, {
      segments: [{ n: 0, bytes: 100 }],
    })
    expect(beat.status).toBe(200)
    expect(beat.body.recording).toBeUndefined()
  })
})

// ── Account deletion (P5) ──────────────────────────────────────────────────────────────────────────────────────────

describe("account deletion (P5)", () => {
  test("deletes every recording from the bucket, then every job record, link, counter, recurring job and models log", async () => {
    const w = await world()
    const deleted: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host === R2_HOST && init?.method === "DELETE") {
        const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"))
        deleted.push(key)
        w.bucket.delete(key)
        return new Response(null, { status: 204 })
      }
      return w.fetcher(input, init)
    }) as typeof fetch
    const { job, token } = await started(w)
    await recordHostedSessionModel(job.session!, { id: DEEPSEEK, lab: "deepseek" }, w.fakes.clock.now, w.fetcher)
    const beat = await heartbeat(w, job.session!, token, { segments: [{ n: 0, bytes: 10 }, { n: 1, bytes: 10 }] })
    for (const upload of beat.body.recording.uploads) w.bucket.set(decodeURIComponent(new URL(upload.url).pathname.split("/").slice(2).join("/")), 10)
    await heartbeat(w, job.session!, token, { uploadedSegments: [0, 1] })
    await queued(w)
    await invoke((request, response) => handleHostedJobs(request, response, options(w)), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { prompt: "Check.", criteria: ["Fine."], pages: ["https://example.com/"], jobMinutes: 20, recurring: { timeOfDay: 30 } },
    })
    const closing = w.setSnapshot({ state: "ended", reason: "closing" })
    const result = await applyHostedJobsTransition({ account: ACCOUNT_ID, to: closing, cause: "closing" }, options(w, { fetcher }))
    expect(result).toEqual({ jobs: 2, recordings: 2 })
    expect(deleted.map((key) => key.replace(/^recordings\/test\/[a-f0-9]{32}\//, "")).sort()).toEqual([
      `${job.id}/slot-0.ts`,
      `${job.id}/slot-1.ts`,
    ])
    expect([...w.bucket.keys()].filter((key) => key.startsWith("recordings/"))).toEqual([])
    expect(w.fakes.store.keys().filter((key) => key.includes(":hosted:jobs:"))).toEqual([])
    expect(w.fakes.store.get(hostedSessionModelsKey(job.session!))).toBeUndefined()
    // Idempotent: a retry finds nothing left.
    expect(await eraseAccountHostedJobs(ACCOUNT_ID, options(w, { fetcher }))).toEqual({ jobs: 0, recordings: 0 })
  })
})

// ── Listing, the gateway's log and the run-API host ────────────────────────────────────────────────────────────────

describe("wiring", () => {
  test("overnight lists with the computer: ready when the computer's services and the media bucket are", () => {
    const w = { provider: { configured: () => true } } as const
    expect(doneByMorningConfigured({ provider: w.provider as never })).toBe(true)
    process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID = ""
    expect(doneByMorningConfigured({ provider: w.provider as never })).toBe(false)
    // Without a provider configured from the environment, neither the computer nor Done by Morning is ready.
    expect(perkServices.overnight?.(fetch)).toBe(false)
    expect(perkServices.computer?.(fetch)).toBe(false)
  })

  test("the gateway's afterSettle notes each hosted request's model and lab for the judge", async () => {
    const w = await world()
    const { job } = await started(w)
    const { afterSettle } = await import("../api/_lib/model-plan-gateway-hooks")
    await import("../api/_lib/hosted-run")
    const original = globalThis.fetch
    globalThis.fetch = w.fetcher
    try {
      await afterSettle(
        {
          account: { id: ACCOUNT_ID },
          kind: "run",
          purpose: "hosted",
          run: { id: job.session!, source: "schedule", deadline: w.fakes.clock.now + HOUR, service: "hosted", sessionId: job.session! },
        } as never,
        {
          snapshot: w.snapshot() as EntitlementSnapshot,
          model: { id: DEEPSEEK, lab: "deepseek" } as never,
          startedAt: w.fakes.clock.now,
          endedAt: w.fakes.clock.now,
          streamed: false,
        },
      )
    } finally {
      globalThis.fetch = original
    }
    expect(w.fakes.store.hash(hostedSessionModelsKey(job.session!)).get(`c:${DEEPSEEK}`)).toBe("1")
    expect(w.fakes.store.hash(hostedSessionModelsKey(job.session!)).get(`l:${DEEPSEEK}`)).toBe("deepseek")
  })

  test("the run-API host lets a job's report through and still sends the person's job routes to the website", async () => {
    const vercel = (await Bun.file(path.join(root, "vercel.json")).json()) as {
      redirects: { source: string; has?: { type: string; value: string }[] }[]
    }
    const rule = vercel.redirects.find((item) => item.has?.some((has) => has.value === Hosted.RUN_API_HOST))!
    const redirected = new RegExp(`^${rule.source}$`)
    expect(redirected.test(`/api/hosted/jobs/jb_${"a".repeat(26)}/report`)).toBe(false)
    expect(redirected.test("/api/hosted/jobs")).toBe(true)
    expect(redirected.test("/api/hosted/status")).toBe(true)
  })

  test("the routes' registration module registered the queue's runner (one runner only)", () => {
    expect(() => registerHostedJobsRunner(async () => undefined)).toThrow("already registered")
  })
})

// ── The jobs' scripts on Valkey (CI only: VECTOR_TEST_REDIS_URL) ───────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the jobs' scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const send = async (command: (string | number)[]) =>
    (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null
  const { ENQUEUE, REFUND, SLOT, RECUR, MODELS } = HOSTED_JOB_SCRIPTS
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("ENQUEUE, REFUND, SLOT, RECUR and MODELS answer as their TypeScript copies do", async () => {
    const enqueue = (id: string, cap: number) =>
      send(["EVAL", ENQUEUE, 4, "c:night", `c:job:${id}`, "c:due", "c:index", cap, 86_400_000, `{"id":"${id}"}`, 60_000, id, 5, 7]).then(Number)
    expect(await enqueue("a", 2)).toBe(1)
    expect(await enqueue("a", 2)).toBe(-1)
    expect(await enqueue("b", 2)).toBe(2)
    expect(await enqueue("c", 2)).toBe(0)
    expect(Number(await send(["PTTL", "c:night"]))).toBeGreaterThan(80_000_000)
    expect(await send(["ZSCORE", "c:due", "a"])).toBe("5")
    expect(await send(["ZSCORE", "c:index", "b"])).toBe("7")
    expect(Number(await send(["EVAL", REFUND, 1, "c:night"]))).toBe(1)
    expect(Number(await send(["EVAL", REFUND, 1, "c:night"]))).toBe(0)
    expect(Number(await send(["EVAL", REFUND, 1, "c:night"]))).toBe(0)
    const slot = (id: string) => send(["EVAL", SLOT, 1, "c:running", id, 1, 60_000]).then(Number)
    expect(await slot("a")).toBe(1)
    expect(await slot("a")).toBe(1)
    expect(await slot("b")).toBe(0)
    const recur = (id: string) => send(["EVAL", RECUR, 2, "c:recurring", "c:rdue", id, "{}", 1, `acct:${id}`, 9]).then(Number)
    expect(await recur("r1")).toBe(1)
    expect(await recur("r1")).toBe(1)
    expect(await recur("r2")).toBe(0)
    expect(await send(["ZSCORE", "c:rdue", "acct:r1"])).toBe("9")
    await send(["EVAL", MODELS, 1, "c:models", DEEPSEEK, 100, "deepseek", 60_000])
    await send(["EVAL", MODELS, 1, "c:models", DEEPSEEK, 200, "deepseek", 60_000])
    expect(await send(["HGET", "c:models", `c:${DEEPSEEK}`])).toBe("2")
    expect(await send(["HGET", "c:models", `t:${DEEPSEEK}`])).toBe("200")
    expect(Number(await send(["PTTL", "c:models"]))).toBeGreaterThan(0)
  })
})
