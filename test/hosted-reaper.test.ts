import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { HOSTED_ABUSE } from "../api/_lib/codium-limits"
import { switchKey } from "../api/_lib/codium-switches"
import { hostedMinutesKey } from "../api/_lib/hosted-entitlement"
import { handleHostedBudget, handleHostedCron, handleHostedHeartbeat, handleHostedSessions } from "../api/_lib/hosted-api"
import {
  RENEW_AHEAD_MS,
  checkHostedDrift,
  hostedBudget,
  hostedRosterKey,
  reapHostedSessions,
  registerHostedJobsRunner,
  runHostedNightly,
} from "../api/_lib/hosted-crons"
import { hostedAccount, hostedRunningKey, readLine } from "../api/_lib/hosted-ledger"
import { computerName, hostedComputerKey, hostedReconcileKey } from "../api/_lib/hosted-provider"
import { HOSTED_DISK_GB_MAX, chargeMinuteMicro, costMinuteMicro } from "../api/_lib/hosted-rates"
import {
  STOP_GIVE_UP_MS,
  hostedLeaseKey,
  hostedSuspendKey,
  readSessionRecord,
  recordHostedModelRequest,
  type SessionRecord,
} from "../api/_lib/hosted-sessions"
import { readHostedRunToken } from "../api/_lib/hosted-tokens"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import {
  ACCOUNT_ID,
  BUDGET_SECRET,
  CRON,
  DAY,
  HOUR,
  MINUTE,
  daemonBeat,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  type HostedWorld,
} from "./hosted-sessions-fixture"

// WP A53: the reaper (every minute), the nightly job, the drift check and the budget answer. The provider, the store,
// the ledger and Stripe are fakes; the clock is the fakes' clock, moved by the tests.

let ledger: LedgerBackend
let restore = () => {}
beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = hostedSessionEnvironment()
  await ledger.reset()
})
afterEach(() => restore())

const NAME = () => computerName(ACCOUNT_ID, 1)

async function start(w: HostedWorld, body: Record<string, unknown> = {}) {
  const answer = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
    method: "POST",
    authorization: w.desktopToken(),
    body: { size: "standard", jobMinutes: 60, prompt: "Tidy the repository.", ...body },
  })
  expect(answer.status).toBe(201)
  return answer.body.session as Hosted.SessionView
}

/** The computer's daemon reports, as it does every 30 seconds. */
async function beat(w: HostedWorld, id: string, body: Record<string, unknown> = {}, computer = 1) {
  const answer = await invoke((request, response) => handleHostedHeartbeat(request, response, w.options), {
    method: "POST",
    authorization: w.provider.token(computerName(ACCOUNT_ID, computer))!,
    body: daemonBeat(id, { activeAt: w.fakes.clock.now, ...body }),
    query: { id },
  })
  return answer
}

const reap = (w: HostedWorld) => reapHostedSessions({ ...w.options, budgetMs: 45_000 })
const record = async (w: HostedWorld, id: string) => (await readSessionRecord(id, w.fetcher)) as SessionRecord

/** Moves the clock in steps of a minute, the daemon reporting activity and the reaper running each minute. */
async function run(w: HostedWorld, id: string, minutes: number, body: Record<string, unknown> = {}) {
  for (let minute = 0; minute < minutes; minute++) {
    w.advance(MINUTE)
    if ((await record(w, id)).state !== "ended") await beat(w, id, body)
    await reap(w)
  }
}

describe("blocks, deadlines and wrap-up (M8)", () => {
  test("the next block is held before the current one ends, with a fresh run token and lease", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    const first = readHostedRunToken(w.provider.token(NAME())!, w.fakes.clock.now)
    await run(w, session.id, 12)
    expect((await record(w, session.id)).block).toBe(1)
    expect(w.provider.calls.filter((call) => call.startsWith("token"))).toEqual([`token ${NAME()}`])
    const second = readHostedRunToken(w.provider.token(NAME())!, w.fakes.clock.now)
    expect(second.exp).toBeGreaterThan(first.exp)
    expect(second.session).toBe(session.id)
    // Block 0 settled at the moment block 1 opened (12 minutes), charged at the charged rate.
    expect(await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options)).toMatchObject({
      kind: "block",
      units: 12,
      chargedMicro: 12 * chargeMinuteMicro("standard"),
    })
    const lease = w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).get("1")!
    expect(Number(lease.split(":")[1])).toBeGreaterThan((await record(w, session.id)).stopBy)
    expect(RENEW_AHEAD_MS).toBe(3 * MINUTE)
  })

  test("at its deadline a session wraps up, then stops by its deadline plus five minutes, every minute charged", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w, { jobMinutes: 20 })
    await run(w, session.id, 20)
    const wrapping = await record(w, session.id)
    expect(wrapping).toMatchObject({ state: "wrapping", reason: "deadline" })
    expect(wrapping.wrapBy).toBe(Math.min(session.deadline + Hosted.WRAP_MS, wrapping.stopBy))
    expect((await beat(w, session.id)).body).toMatchObject({ state: "wrapping", wrapBy: wrapping.wrapBy })
    await run(w, session.id, 6)
    const ended = await record(w, session.id)
    expect(ended).toMatchObject({ state: "ended", reason: "deadline" })
    expect(w.provider.computers.get(NAME())!.status).toBe("stopped")
    const first = await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options)
    const second = await readLine(ACCOUNT_ID, `hb-${session.id}-1`, w.options)
    expect(first!.units + second!.units).toBe(Math.ceil((ended.stoppedAt! - ended.startedAt!) / MINUTE))
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(0)
  })

  test("a block that cannot be held (the plan's hours used) wraps the session up within its hold", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    const epoch = w.snapshot().meterEpoch
    // Someone used the rest of the month's hours on another computer meanwhile.
    w.fakes.store.hash(hostedMinutesKey(ACCOUNT_ID, epoch)).set("used", String(20 * 60))
    await run(w, session.id, 12)
    const wrapping = await record(w, session.id)
    expect(wrapping).toMatchObject({ state: "wrapping", reason: "hours", block: 0 })
    expect(wrapping.wrapBy).toBeLessThanOrEqual(wrapping.stopBy)
    await run(w, session.id, 6)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "hours" })
  })
})

describe("stops the reaper makes", () => {
  test("ten minutes with nothing done stops the session", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id)
    for (let minute = 0; minute < 10; minute++) {
      w.advance(MINUTE)
      await beat(w, session.id, { activeAt: session.createdAt })
      await reap(w)
    }
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "idle" })
  })

  test("a model request counts as activity", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    for (let minute = 0; minute < 12; minute++) {
      w.advance(MINUTE)
      await beat(w, session.id, { activeAt: session.createdAt })
      await recordHostedModelRequest(session.id, w.fakes.clock.now, w.fetcher)
      await reap(w)
    }
    expect((await record(w, session.id)).state).toBe("running")
  })

  test("a computer that stops reporting for three minutes is stopped; one that never reported gets five", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    w.advance(4 * MINUTE)
    await reap(w)
    expect((await record(w, session.id)).state).toBe("running")
    w.advance(MINUTE + 1)
    await reap(w)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "heartbeat" })

    const next = await start(w)
    await beat(w, next.id)
    w.advance(3 * MINUTE)
    await reap(w)
    expect(await record(w, next.id)).toMatchObject({ state: "ended", reason: "heartbeat" })
  })

  test("the agent finishing stops the session", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { done: true })
    await reap(w)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "finished" })
  })

  test("a take-over ends after 30 minutes and control goes back to the agent", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    const { handleHostedSessionAction } = await import("../api/_lib/hosted-api")
    await invoke((request, response) => handleHostedSessionAction(request, response, "takeover", w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: {},
      query: { id: session.id },
    })
    await run(w, session.id, 29, { activeAt: session.createdAt })
    expect((await record(w, session.id)).state).toBe("takeover")
    await run(w, session.id, 1, { activeAt: session.createdAt })
    const back = await record(w, session.id)
    expect(back.state).toBe("running")
    expect(back.releasedAt).toBe(w.fakes.clock.now)
  })

  test("the owner's stop switch stops every session; no-new lets them continue", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "no-new", changedAt: 1, generation: "a" }))
    await run(w, session.id, 1)
    expect((await record(w, session.id)).state).toBe("running")
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "stop", changedAt: 2, generation: "b" }))
    await run(w, session.id, 1)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "switch" })
  })

  test("a stop the provider cannot make is tried each minute, and given up once its block has lapsed", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { done: true })
    w.provider.fail.stop = true
    await reap(w)
    expect((await record(w, session.id)).state).toBe("stopping")
    w.advance(MINUTE)
    await reap(w)
    expect((await record(w, session.id)).state).toBe("stopping")
    w.advance(20 * MINUTE + STOP_GIVE_UP_MS)
    await reap(w)
    const ended = await record(w, session.id)
    expect(ended).toMatchObject({ state: "ended", reason: "finished" })
    // Nothing closed the block, so it lapsed and was charged its whole hold: every minute that could have run.
    expect(await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options)).toMatchObject({ units: 20 })
  })
})

describe("fair use (§4.2)", () => {
  test("more than 600 page loads an hour stops the session and holds the account", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { pageLoads: 300 })
    await beat(w, session.id, { pageLoads: 601 })
    await reap(w)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "abuse" })
    expect(JSON.parse(w.fakes.store.get(hostedSuspendKey(ACCOUNT_ID))!)).toMatchObject({ reason: "abuse" })
    const again = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 30, prompt: "Again." },
    })
    expect(again.body.error).toMatchObject({ code: "HOSTED_FROZEN", reason: "fair-use" })
  })

  test("Max's 5 GB a day of egress", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { egressBytes: 4_000_000_000 })
    await reap(w)
    expect((await record(w, session.id)).state).toBe("running")
    await beat(w, session.id, { egressBytes: 5_100_000_000 })
    await reap(w)
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "abuse" })
  })

  test("30 minutes above 80% of the processor with no model request", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await run(w, session.id, 29, { cpu: 95 })
    expect((await record(w, session.id)).state).toBe("running")
    await run(w, session.id, 2, { cpu: 95 })
    expect(await record(w, session.id)).toMatchObject({ state: "ended", reason: "abuse" })
  })

  test("a busy processor making model requests is working, not abusing", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    for (let minute = 0; minute < 35; minute++) {
      w.advance(MINUTE)
      await beat(w, session.id, { cpu: 95 })
      await recordHostedModelRequest(session.id, w.fakes.clock.now, w.fetcher)
      await reap(w)
    }
    expect((await record(w, session.id)).state).toBe("running")
  })
})

describe("the rest of the reaper's pass", () => {
  test("an orphan computer is stopped by the reconciler (M9), and due jobs run once registered", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { done: true })
    // The session ends, but its computer keeps running at the provider (it was resumed by hand, say).
    await reap(w)
    w.provider.computers.get(NAME())!.status = "running"
    w.fakes.store.remove(hostedReconcileKey())
    const ran: number[] = []
    registerHostedJobsRunner(async ({ clock }) => {
      ran.push(clock())
    })
    w.advance(MINUTE)
    const result = await reap(w)
    expect(result.reconcile).toMatchObject({ ran: true, stopped: [NAME()] })
    expect(ran).toEqual([w.fakes.clock.now])
    expect(result.jobs).toBe(true)
  })

  test("a block nothing closed is charged its whole hold by the reaper's settle pass", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    // The session record vanished (a store fault): nothing renews or closes its block.
    w.fakes.store.remove(codiumKey("hosted", "session", session.id))
    w.advance(31 * MINUTE)
    await reap(w)
    expect(await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options)).toMatchObject({ units: 20 })
  })

  test("the crons need CRON_SECRET", async () => {
    const w = await hostedWorld(ledger)
    for (const kind of ["reaper", "drift", "nightly"] as const) {
      const refused = await invoke((request, response) => handleHostedCron(request, response, kind, w.options), {
        method: "GET",
        authorization: "not-the-secret",
      })
      expect(refused.status).toBe(401)
    }
    const accepted = await invoke((request, response) => handleHostedCron(request, response, "drift", w.options), {
      method: "GET",
      authorization: CRON,
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ checked: 0, drifted: [] })
  })
})

describe("nightly, drift and the budget", () => {
  test("nightly charges each computer's storage and egress once, and trues its blocks down towards cost", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await run(w, session.id, 9)
    const { handleHostedSessionAction } = await import("../api/_lib/hosted-api")
    await invoke((request, response) => handleHostedSessionAction(request, response, "stop", w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: {},
      query: { id: session.id },
    })
    // The provider reports the computer's cumulative usage: barely any CPU, 2 GB out.
    Object.assign(w.provider.computers.get(NAME())!, { activeCpuMs: 30_000, durationMs: 9 * MINUTE, egressBytes: 2e9 })
    // A first reading (the night the computer was made) sets where the CPU reading starts.
    w.fakes.store.hash(codiumKey("hosted", "usage")).set(NAME(), JSON.stringify({ egressBytes: 0, activeCpuMs: 0, durationMs: 0 }))
    w.advance(DAY)
    const result = await runHostedNightly(w.options)
    const day = new Date(w.fakes.clock.now - DAY).toISOString().slice(0, 10)
    expect(result).toMatchObject({ day, charged: 1, trued: 1, failed: 0 })
    expect(await readLine(ACCOUNT_ID, `hs-${NAME()}-${day}`, w.options)).toMatchObject({
      kind: "storage",
      units: HOSTED_DISK_GB_MAX,
    })
    expect(await readLine(ACCOUNT_ID, `he-${NAME()}-${day}`, w.options)).toMatchObject({ kind: "egress", units: 2 })
    const block = (await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options))!
    expect(block.truedMicro!).toBeLessThan(block.chargedMicro)
    // Never below what it could have cost: memory for every billed minute plus all the CPU reported.
    const memory = Math.ceil((block.units * MINUTE * 4 * 21_200) / HOUR)
    const cpu = Math.ceil((30_000 * 128_000) / HOUR)
    expect(block.truedMicro!).toBeGreaterThanOrEqual(memory + cpu)
    expect(block.truedMicro!).toBeLessThanOrEqual(block.units * costMinuteMicro("standard") * 2)
    const again = await runHostedNightly(w.options)
    expect(again).toMatchObject({ charged: 0, trued: 0 })
  })

  test("a true-up that fails after the night's charges never makes the next night charge the same egress again (P8 review)", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await run(w, session.id, 9)
    const { handleHostedSessionAction } = await import("../api/_lib/hosted-api")
    await invoke((request, response) => handleHostedSessionAction(request, response, "stop", w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: {},
      query: { id: session.id },
    })
    Object.assign(w.provider.computers.get(NAME())!, { activeCpuMs: 30_000, durationMs: 9 * MINUTE, egressBytes: 2e9 })
    w.fakes.store.hash(codiumKey("hosted", "usage")).set(NAME(), JSON.stringify({ egressBytes: 0, activeCpuMs: 0, durationMs: 0 }))
    // The ledger refuses to record the true-up on the first night only.
    let refuse = true
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (refuse && url.endsWith("/rest/v1/rpc/vector_hosted") && String(init?.body).includes('"action":"trued"'))
        return new Response("unavailable", { status: 503 })
      return w.fetcher(input, init)
    }) as typeof fetch
    w.advance(DAY)
    const first = await runHostedNightly({ ...w.options, fetcher })
    const day1 = new Date(w.fakes.clock.now - DAY).toISOString().slice(0, 10)
    expect(first).toMatchObject({ day: day1, charged: 1, failed: 1 })
    expect(await readLine(ACCOUNT_ID, `he-${NAME()}-${day1}`, w.options)).toMatchObject({ kind: "egress", units: 2 })
    // One more GB the next day: only that GB is charged under the next day's line.
    refuse = false
    w.provider.computers.get(NAME())!.egressBytes = 3e9
    w.advance(DAY)
    const second = await runHostedNightly({ ...w.options, fetcher })
    const day2 = new Date(w.fakes.clock.now - DAY).toISOString().slice(0, 10)
    expect(second).toMatchObject({ day: day2, charged: 1, failed: 0 })
    expect(await readLine(ACCOUNT_ID, `he-${NAME()}-${day2}`, w.options)).toMatchObject({ kind: "egress", units: 1 })
  })

  test("a computer listed with no egress figure still pays its day of storage, and its egress is charged later (P8 review)", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await beat(w, session.id, { done: true })
    await reap(w)
    // The provider's egress figure is optional; this listing has none.
    Object.assign(w.provider.computers.get(NAME())!, { egressBytes: undefined })
    w.fakes.store.hash(codiumKey("hosted", "usage")).set(NAME(), JSON.stringify({ egressBytes: 5e8 }))
    w.advance(DAY)
    expect(await runHostedNightly(w.options)).toMatchObject({ charged: 1, failed: 0 })
    const day1 = new Date(w.fakes.clock.now - DAY).toISOString().slice(0, 10)
    expect(await readLine(ACCOUNT_ID, `hs-${NAME()}-${day1}`, w.options)).toMatchObject({ kind: "storage", units: HOSTED_DISK_GB_MAX })
    expect(await readLine(ACCOUNT_ID, `he-${NAME()}-${day1}`, w.options)).toBeUndefined()
    // Run again the same night: nothing more.
    expect(await runHostedNightly(w.options)).toMatchObject({ charged: 0 })
    // The next listing has the figure: everything since the last reading is charged once.
    w.provider.computers.get(NAME())!.egressBytes = 2e9
    w.advance(DAY)
    await runHostedNightly(w.options)
    const day2 = new Date(w.fakes.clock.now - DAY).toISOString().slice(0, 10)
    expect(await readLine(ACCOUNT_ID, `he-${NAME()}-${day2}`, w.options)).toMatchObject({ kind: "egress", units: 1.5 })
  })

  test("a computer running a session is not trued up that night", async () => {
    const w = await hostedWorld(ledger)
    const first = await start(w)
    await beat(w, first.id, { done: true })
    await reap(w)
    await start(w)
    w.fakes.store.hash(codiumKey("hosted", "usage")).set(NAME(), JSON.stringify({ egressBytes: 0, activeCpuMs: 0 }))
    w.advance(10 * MINUTE)
    const result = await runHostedNightly(w.options)
    expect(result.trued).toBe(0)
    expect(w.fakes.store.zset(codiumKey("hosted", "trueup", ACCOUNT_ID)).has(first.id)).toBe(true)
  })

  test("drift: a charge that went missing is reported to the owner, by account and minutes", async () => {
    const w = await hostedWorld(ledger)
    const session = await start(w)
    await run(w, session.id, 5)
    expect((await checkHostedDrift(w.options)).drifted).toEqual([])
    // The running block disappears from the ledger's store without being settled: 5 minutes charged nowhere.
    w.fakes.store.remove(hostedRunningKey(ACCOUNT_ID))
    w.advance(MINUTE)
    const drift = await checkHostedDrift(w.options)
    expect(drift.drifted).toEqual([{ account: ACCOUNT_ID, expectedMinutes: 6, chargedMinutes: 0 }])
  })

  test("the budget answer counts each roster account's hours left and every period starting before the cycle ends", async () => {
    const w = await hostedWorld(ledger)
    const snapshot = w.snapshot()
    w.fakes.store.hash(hostedRosterKey()).set(
      ACCOUNT_ID,
      JSON.stringify({ plan: "vector-100", state: "active", periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd }),
    )
    const cycleEnd = snapshot.periodEnd + 5 * DAY
    const answer = await hostedBudget({ cycleEnd }, w.options)
    // 20 h left this period (nothing used) and 20 h of the next, which starts before the cycle ends.
    expect(answer).toMatchObject({ accounts: 1, minutes: 2 * 20 * 60, computers: 1, retained: 0 })
    const days = Math.ceil((cycleEnd - w.fakes.clock.now) / DAY)
    // Egress too, at Max's fair-use cap of 5 GB every day, at the default $0.15 a GB (P8 review).
    expect(answer.egressGb).toBe(HOSTED_ABUSE.egressGbPerDay["vector-100"] * days)
    const expected =
      2400 * costMinuteMicro("standard") +
      Math.ceil(HOSTED_DISK_GB_MAX * days * Math.ceil(80_000 / 28)) +
      Math.ceil(5 * days * 150_000)
    expect(answer.worstCaseUsd).toBe(Math.ceil(expected / 10_000) / 100)
    const route = (authorization: string, cycle = String(cycleEnd)) =>
      invoke((request, response) => handleHostedBudget(request, response, w.options), {
        method: "GET",
        authorization,
        query: { cycleEnd: cycle },
      })
    expect((await route("wrong")).status).toBe(401)
    expect((await route(BUDGET_SECRET, "nope")).status).toBe(400)
    expect((await route(BUDGET_SECRET)).body).toEqual(answer)
    expect(hostedAccount(ACCOUNT_ID)).toHaveLength(64)
    expect(w.fakes.store.get(hostedComputerKey(NAME()))).toBeUndefined()
  })

  test("the budget steps periods by the shortest month and counts the disks kept for ended plans (P8 review)", async () => {
    const w = await hostedWorld(ledger)
    const snapshot = w.snapshot()
    w.fakes.store.hash(hostedRosterKey()).set(
      ACCOUNT_ID,
      JSON.stringify({ plan: "vector-100", state: "active", periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd }),
    )
    // A 28-day period after this one still starts before a cycle that ends 29 days after this period does.
    const cycleEnd = snapshot.periodEnd + 29 * DAY
    expect((await hostedBudget({ cycleEnd }, w.options)).minutes).toBe(3 * 20 * 60)
    // An ended plan's two computers keep their disks 14 days off the roster: their storage counts until the cycle ends.
    const ENDED = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c"
    w.fakes.store.hash(codiumKey("hosted", "names")).set(computerName(ENDED, 1), ENDED)
    w.fakes.store.hash(codiumKey("hosted", "names")).set(computerName(ENDED, 2), ENDED)
    w.fakes.store.hash(codiumKey("hosted", "names")).set(NAME(), ACCOUNT_ID)
    const answer = await hostedBudget({ cycleEnd }, w.options)
    expect(answer).toMatchObject({ computers: 1, retained: 2 })
    const days = Math.ceil((cycleEnd - w.fakes.clock.now) / DAY)
    const expected =
      3 * 20 * 60 * costMinuteMicro("standard") +
      Math.ceil(3 * HOSTED_DISK_GB_MAX * days * Math.ceil(80_000 / 28)) +
      Math.ceil(5 * days * 150_000)
    expect(answer.worstCaseUsd).toBe(Math.ceil(expected / 10_000) / 100)
  })
})
