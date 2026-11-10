import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { hosted, PROVISIONERS } from "../api/_lib/codium-provisioners"
import type { TransitionCause } from "../api/_lib/codium-provision"
import { handleHostedSessions } from "../api/_lib/hosted-api"
import { applyHostedTransition, hostedRosterKey, reapHostedSessions, runHostedNightly } from "../api/_lib/hosted-crons"
import { hostedAccount, hostedRunningKey, readLine } from "../api/_lib/hosted-ledger"
import { computerName } from "../api/_lib/hosted-provider"
import { HOSTED_DISK_GB_MAX } from "../api/_lib/hosted-rates"
import { hostedDiskDueKey, hostedSessionKey, hostedSessionsKey, readSessionRecord } from "../api/_lib/hosted-sessions"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import {
  ACCOUNT_ID,
  DAY,
  MINUTE,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  type HostedWorld,
} from "./hosted-sessions-fixture"

// WP A53: every transition in §4.4's cloud computer row, through the `hosted` provisioner (codium-provisioners.ts):
// what happens to running sessions, to new ones, and to the computers' disks. Fakes only.

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

async function start(w: HostedWorld) {
  return invoke((request, response) => handleHostedSessions(request, response, w.options), {
    method: "POST",
    authorization: w.desktopToken(),
    body: { size: "standard", jobMinutes: 120, prompt: "Keep working." },
  })
}

async function running(w: HostedWorld) {
  const answer = await start(w)
  expect(answer.status).toBe(201)
  return answer.body.session as Hosted.SessionView
}

/**
 * Moves the account to `patch` and runs the `hosted` provisioner's work on the change, as the outbox does (with the
 * fake clock and provider; the provisioner itself passes the real ones).
 */
async function transition(w: HostedWorld, patch: Partial<EntitlementSnapshot>, cause: TransitionCause = "owner") {
  const from = w.snapshot()
  const to = w.setSnapshot(patch)
  await applyHostedTransition({ account: ACCOUNT_ID, from, to, cause }, w.options)
  return to
}

const state = async (w: HostedWorld, id: string) => (await readSessionRecord(id, w.fetcher))!

describe("the hosted provisioner", () => {
  test("is configured with the ledger or the provider and replaces the stub in the provisioner list", () => {
    expect(hosted.configured()).toBe(true)
    restore()
    restore = hostedSessionEnvironment({ SUPABASE_SERVICE_ROLE_KEY: undefined })
    expect(hosted.configured()).toBe(false)
    expect(PROVISIONERS.map((provisioner) => provisioner.id)).toEqual([
      "github-runs",
      "remote",
      "push",
      "vault",
      "hosted",
      "ops",
      "founding",
      "owner-notify",
    ])
  })
})

describe("§4.4's cloud computer row", () => {
  test("active: new sessions start within the caps, and the account is on the roster", async () => {
    const w = await hostedWorld(ledger)
    await transition(w, {}, "first_payment")
    expect(JSON.parse(w.fakes.store.hash(hostedRosterKey()).get(ACCOUNT_ID)!)).toMatchObject({ plan: "vector-100", state: "active" })
    expect((await start(w)).status).toBe(201)
  })

  test("renewing: running sessions continue and hold their blocks within the grace; no new ones start", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    const snapshot = w.snapshot()
    await transition(w, { state: "renewing", periodEnd: w.fakes.clock.now }, "renewal")
    expect((await state(w, session.id)).state).toBe("running")
    const refused = await start(w)
    expect(refused.status).toBe(503)
    expect(refused.body.error.code).toBe("MODEL_PLAN_RENEWING")
    expect(snapshot.state).toBe("active")
  })

  test("renewing past the grace: running sessions wrap up", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    await transition(w, { state: "renewing", periodEnd: w.fakes.clock.now - 3 * 60 * MINUTE }, "renewal")
    expect(await state(w, session.id)).toMatchObject({ state: "wrapping", reason: "plan" })
  })

  test("paused: running sessions wrap up, snapshot and stop within five minutes; new ones are refused", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    await transition(w, { state: "paused", reason: "payment_failed" }, "payment_failed")
    const wrapping = await state(w, session.id)
    expect(wrapping).toMatchObject({ state: "wrapping", reason: "plan" })
    expect(wrapping.wrapBy).toBe(w.fakes.clock.now + Hosted.WRAP_MS)
    expect((await start(w)).body.error.code).toBe("HOSTED_PAUSED")
    w.advance(Hosted.WRAP_MS)
    await reapHostedSessions(w.options)
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "plan" })
    expect(w.provider.computers.get(NAME())!.status).toBe("stopped")
    // The disks stay: a paused plan keeps them at the plan's own retention.
    expect(w.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
  })

  test("payment recovered: sessions start again", async () => {
    const w = await hostedWorld(ledger)
    await transition(w, { state: "paused", reason: "payment_failed" }, "payment_failed")
    await transition(w, { state: "active", reason: undefined }, "payment_recovered")
    expect((await start(w)).status).toBe(201)
  })

  test("ended: sessions stop at once; the disks are kept 14 days, at Vector's cost while no download exists, then deleted", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    w.advance(3 * MINUTE)
    await transition(w, { state: "ended", reason: "canceled" }, "ended")
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "plan" })
    expect(w.provider.computers.get(NAME())!.status).toBe("stopped")
    expect(w.fakes.store.hash(hostedRosterKey()).has(ACCOUNT_ID)).toBe(false)
    const due = w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)!
    expect(due).toBe(w.fakes.clock.now + Hosted.ENDED_DISK_DAYS * DAY)
    // No route lets an ended plan download its disk yet, so the final period is charged nothing for keeping it
    // (P8 review; codium-deviations.md).
    const key = w.fakes.store.get(codiumKey("account", ACCOUNT_ID))!
    const start = (JSON.parse(key) as { key: { start: number } }).key.start
    expect(await readLine(ACCOUNT_ID, `hr-${NAME()}-sub_renewing-${start}`, w.options)).toBeUndefined()
    const rows = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(rows.some((row) => row.kind === "retention")).toBe(false)
    // Again (the sweep's catch-up) changes nothing: one charge, the first date.
    await applyHostedTransition({ account: ACCOUNT_ID, to: w.snapshot(), cause: "ended" }, w.options)
    expect(w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)).toBe(due)
    w.advance(13 * DAY)
    expect((await runHostedNightly(w.options)).deleted).toBe(0)
    w.advance(DAY + MINUTE)
    expect((await runHostedNightly(w.options)).deleted).toBe(1)
    expect(w.provider.computers.size).toBe(0)
    expect(w.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
  })

  test("a subscriber who comes back before the deletion keeps the disks", async () => {
    const w = await hostedWorld(ledger)
    await running(w)
    await transition(w, { state: "ended", reason: "canceled" }, "ended")
    await transition(w, { state: "active", reason: undefined }, "first_payment")
    expect(w.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
    w.advance(15 * DAY)
    await runHostedNightly(w.options)
    expect(w.provider.computers.has(NAME())).toBe(true)
  })

  test("a move to a plan without a cloud computer is an end for the disks, charged nothing to the new plan's pool", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    await transition(w, { plan: "vector-50" }, "downgrade")
    expect((await state(w, session.id)).state).toBe("ended")
    expect(w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)).toBe(w.fakes.clock.now + Hosted.ENDED_DISK_DAYS * DAY)
    const rows = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(rows.some((row) => row.kind === "retention")).toBe(false)
  })

  test("frozen: everything stops at once; the disks are kept with no date while the dispute is open", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    await transition(w, { state: "frozen", reason: "disputed" }, "disputed")
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "frozen" })
    expect(w.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
    w.advance(60 * DAY)
    await runHostedNightly(w.options)
    expect(w.provider.computers.has(NAME())).toBe(true)
  })

  test("a won dispute brings the account back with its disks", async () => {
    const w = await hostedWorld(ledger)
    await running(w)
    await transition(w, { state: "frozen", reason: "disputed" }, "disputed")
    await transition(w, { state: "active", reason: undefined }, "dispute_won")
    expect(w.fakes.store.hash(hostedRosterKey()).has(ACCOUNT_ID)).toBe(true)
    expect((await start(w)).status).toBe(201)
  })

  test("a lost dispute: the disks are kept 30 days at Vector's cost, then deleted", async () => {
    const w = await hostedWorld(ledger)
    await running(w)
    await transition(w, { state: "frozen", reason: "disputed" }, "disputed")
    await transition(w, { state: "ended", reason: "disputed" }, "ended")
    expect(w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)).toBe(
      w.fakes.clock.now + Hosted.LOST_DISPUTE_DISK_DAYS * DAY,
    )
    const rows = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(rows.some((row) => row.kind === "retention")).toBe(false)
    w.advance(30 * DAY + MINUTE)
    expect((await runHostedNightly(w.options)).deleted).toBe(1)
  })

  test("account deletion (closing): sessions stop, computers and disks are deleted, records erased, lines kept (P5)", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    w.advance(4 * MINUTE)
    await transition(w, { state: "ended", reason: "closing" }, "closing")
    // Every hosted key of the account is gone (read before anything below touches the fake store).
    const left = w.fakes.store.keys().filter((key) => key.includes(ACCOUNT_ID) && key.startsWith("vector:codium:test:hosted:"))
    expect(left).toEqual([])
    expect(w.provider.computers.size).toBe(0)
    expect(w.fakes.store.get(hostedSessionKey(session.id))).toBeUndefined()
    expect(w.fakes.store.zset(hostedSessionsKey(ACCOUNT_ID)).size).toBe(0)
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(0)
    const lines = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(lines.map((row) => row.ref)).toEqual([`hb-${session.id}-0`])
    expect(JSON.stringify(lines)).not.toContain(ACCOUNT_ID)
  })

  test("no plan, and a plan without a cloud computer that never had one: nothing happens", async () => {
    const w = await hostedWorld(ledger)
    await transition(w, { plan: "vector-50" }, "downgrade")
    await transition(w, { state: "none", plan: null }, "ended")
    expect(w.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
    expect(w.provider.calls).toEqual([])
  })

  test("an upgrade keeps running sessions and opens the new plan's caps", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    await transition(w, { plan: "vector-200" }, "upgrade")
    expect((await state(w, session.id)).state).toBe("running")
    expect(JSON.parse(w.fakes.store.hash(hostedRosterKey()).get(ACCOUNT_ID)!)).toMatchObject({ plan: "vector-200" })
    expect((await start(w)).status).toBe(201)
    expect(HOSTED_DISK_GB_MAX).toBeGreaterThan(0)
  })
})
