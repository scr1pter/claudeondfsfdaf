import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { hosted, PROVISIONERS } from "../api/_lib/codium-provisioners"
import type { TransitionCause } from "../api/_lib/codium-provision"
import { handleHostedHeartbeat, handleHostedSessionAction, handleHostedSessions } from "../api/_lib/hosted-api"
import { applyHostedTransition, hostedRosterKey, reapHostedSessions, runHostedNightly } from "../api/_lib/hosted-crons"
import { hostedAccount, hostedRunningKey, readLine } from "../api/_lib/hosted-ledger"
import { computerName } from "../api/_lib/hosted-provider"
import { HOSTED_DISK_GB_MAX } from "../api/_lib/hosted-rates"
import {
  hostedDiskDueKey,
  hostedDownloadEgressKey,
  hostedDownloadUploadedKey,
  hostedSessionKey,
  hostedSessionsKey,
  readSessionRecord,
} from "../api/_lib/hosted-sessions"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import {
  ACCOUNT_ID,
  DAY,
  MINUTE,
  R2_HOST,
  daemonBeat,
  endedWithDisk,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  startDownload,
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

  test("ended: sessions stop at once; the disks are kept 14 days, charged nothing until a download starts, then deleted", async () => {
    const w = await hostedWorld(ledger)
    const session = await running(w)
    w.advance(3 * MINUTE)
    await transition(w, { state: "ended", reason: "canceled" }, "ended")
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "plan" })
    expect(w.provider.computers.get(NAME())!.status).toBe("stopped")
    expect(w.fakes.store.hash(hostedRosterKey()).has(ACCOUNT_ID)).toBe(false)
    const due = w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)!
    expect(due).toBe(w.fakes.clock.now + Hosted.ENDED_DISK_DAYS * DAY)
    // The end itself charges nothing for keeping it: the first download-only start of the computer does (H1a).
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

// H1a: the download-only start's part in the row: what the provisioner leaves running, what the nightly job charges and
// deletes. Fakes only.
describe("download-only starts in §4.4's row (H1a)", () => {
  const beat = (w: HostedWorld, id: string, body: Record<string, unknown>, fetcher = w.fetcher) =>
    invoke((request, response) => handleHostedHeartbeat(request, response, { ...w.options, fetcher }), {
      method: "POST",
      authorization: w.provider.token(NAME())!,
      body: daemonBeat(id, body),
      query: { id },
    })

  async function uploaded(w: HostedWorld, bytes: number) {
    const session = (await startDownload(w)).body.session as Hosted.SessionView
    await beat(w, session.id, {})
    const packed = await beat(w, session.id, { archiveBytes: bytes })
    const key = decodeURIComponent(new URL(packed.body.upload.url).pathname.split("/").slice(2).join("/"))
    w.bucket.set(key, bytes)
    await beat(w, session.id, { uploaded: true })
    return { session, key }
  }

  test("a replay of the ended transition leaves a running download alone; a freeze or a refund ends it", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const session = (await startDownload(w)).body.session as Hosted.SessionView
    await applyHostedTransition({ account: ACCOUNT_ID, to: w.snapshot(), cause: "ended" }, w.options)
    expect((await state(w, session.id)).state).toBe("running")
    await transition(w, { state: "frozen", reason: "disputed" }, "disputed")
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "frozen" })

    const refunded = await hostedWorld(ledger)
    await endedWithDisk(refunded)
    const other = (await startDownload(refunded)).body.session as Hosted.SessionView
    await transition(refunded, { state: "ended", reason: "refunded" }, "refunded")
    expect(await state(refunded, other.id)).toMatchObject({ state: "ended", reason: "plan" })
  })

  test("the nightly egress charge leaves a download's upload to Vector and charges the rest", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    await uploaded(w, 2_000_000_000)
    await reapHostedSessions(w.options)
    w.provider.computers.get(NAME())!.egressBytes += 2_500_000_000
    const nightly = await runHostedNightly(w.options)
    expect(nightly.charged).toBe(1)
    const lines = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(lines.filter((row) => row.kind === "egress").map((row) => row.units)).toEqual([0.5])
    expect(w.fakes.store.get(hostedDownloadEgressKey(ACCOUNT_ID, 1))).toBe("0")
    // No storage is charged for an ended plan's kept disk: its retention was.
    expect(lines.filter((row) => row.kind === "storage")).toEqual([])
    expect(lines.filter((row) => row.kind === "retention")).toHaveLength(1)
  })

  test("Vector pays at most one archive's worth of a computer's download uploads until its disk's date", async () => {
    const w = await hostedWorld(ledger)
    const due = (await endedWithDisk(w))!
    // The largest packed files a computer may upload (S3's single PUT, which R2 shares).
    const archive = 5 * 1024 ** 3
    const bytes = 4_000_000_000
    for (let round = 0; round < 3; round++) {
      const { session } = await uploaded(w, bytes)
      expect((await state(w, session.id)).download).toMatchObject({ bytes })
      await reapHostedSessions(w.options)
      expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "finished" })
    }
    // Every upload is counted until the deletion date; only the first archive's worth is set against the egress.
    expect(w.fakes.store.get(hostedDownloadUploadedKey(ACCOUNT_ID, 1))).toBe(String(3 * bytes))
    expect(w.fakes.store.expires.get(hostedDownloadUploadedKey(ACCOUNT_ID, 1))).toBe(due)
    expect(w.fakes.store.get(hostedDownloadEgressKey(ACCOUNT_ID, 1))).toBe(String(archive))
    w.provider.computers.get(NAME())!.egressBytes += 3 * bytes
    expect((await runHostedNightly(w.options)).charged).toBe(1)
    const lines = (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
    expect(lines.filter((row) => row.kind === "egress").map((row) => row.units)).toEqual([(3 * bytes - archive) / 1e9])
    expect(w.fakes.store.get(hostedDownloadEgressKey(ACCOUNT_ID, 1))).toBe("0")
  })

  test("at the date the disks and their packed files are deleted; the download link answers 404 or 410", async () => {
    const w = await hostedWorld(ledger)
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
    const options = { ...w.options, fetcher }
    const due = (await endedWithDisk(w))!
    const { session, key } = await uploaded(w, 4096)
    await reapHostedSessions(options)
    expect(await state(w, session.id)).toMatchObject({ state: "ended", reason: "finished" })
    const ask = () =>
      invoke((request, response) => handleHostedSessionAction(request, response, "download", options), {
        method: "POST",
        authorization: w.desktopToken(),
        body: {},
        query: { id: session.id },
      })
    const follow = (url: string) =>
      invoke((request, response) => handleHostedSessionAction(request, response, "download", options), {
        method: "GET",
        query: { id: session.id, t: new URL(url).searchParams.get("t")! },
      })
    const link = await ask()
    expect(link.status).toBe(200)
    expect(link.body.expiresAt).toBeLessThanOrEqual(due)
    w.advance(due - w.fakes.clock.now + MINUTE)
    expect((await follow(link.body.url)).status).toBe(404)
    expect((await runHostedNightly(options)).deleted).toBe(1)
    expect(deleted).toEqual([key])
    expect(w.bucket.has(key)).toBe(false)
    expect(w.provider.computers.size).toBe(0)
    expect(w.fakes.store.get(hostedDownloadUploadedKey(ACCOUNT_ID, 1))).toBeUndefined()
    expect(w.fakes.store.get(hostedDownloadEgressKey(ACCOUNT_ID, 1))).toBeUndefined()
    // The record outlives the files for the drift check and the true-up; a link to them now leads nowhere.
    const late = await ask()
    expect(late.status).toBe(200)
    const followed = await follow(late.body.url)
    expect(followed.status).toBe(410)
    expect(followed.body.error.code).toBe("HOSTED_DOWNLOAD_UNAVAILABLE")
  })
})
