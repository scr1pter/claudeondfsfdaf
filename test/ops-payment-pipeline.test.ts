import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { listedPerks, perkServices } from "../api/_lib/codium-perks"
import { ops as opsProvisioner } from "../api/_lib/codium-provisioners"
import { snapshotKey } from "../api/_lib/codium-snapshot"
import { switchKey } from "../api/_lib/codium-switches"
import {
  opsAccountsKey,
  opsEraseDueKey,
  opsRosterKey,
  OPS_LOST_DISPUTE_ERASE_MS,
  rosterCounts,
} from "../api/_lib/ops-accounts"
import { eraseAccountOps } from "../api/_lib/ops-cleanup"
import { opsGuardHeldKey } from "../api/_lib/ops-guard"
import { opsHealthKey } from "../api/_lib/ops-health"
import {
  handleOpsReport,
  incidentIndexKey,
  incidentKey,
  registerOpsRunStarter,
  startIncidentFix,
  type AlertSender,
} from "../api/_lib/ops-incidents"
import { newOpsSettings, opsSettingsKey, updateOpsSettings } from "../api/_lib/ops-settings"
import { opsCall } from "../api/_lib/ops-worker"
import { cardIndexKey, cardKey, imageObjectKey, SHIP_DESK_LIMITS, type Card } from "../api/_lib/ship-desk"
import { handleOpsCards } from "../api/ops/cards"
import { handleOpsCleanup } from "../api/ops/cleanup"
import { handleOpsDomains } from "../api/ops/domains"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import type { OpsPlan } from "../packages/ops-worker/src/protocol"
import { CRON_SECRET, DAY, invoke, MAX, OpsWorld, ULTRA } from "./ops-fixture"

// WP A50: the payment pipeline as the ops services see it (§4.4's On Call, Release Guard and Ship Desk rows). Each
// snapshot reconcile would write goes through the ops provisioner, as the outbox runs it, to the ops Worker (A46's own
// code, in memory), the crons' account records and the ops routes:
//
//   active, renewing   checks and watches; settings can be added; cards readable; fix runs start
//   paused             On Call keeps checking and alerting; no new watch; no new settings; fix runs off; cards readable
//   ended              nothing runs; cards readable until they expire, then deleted with their images by the cleanup
//   frozen             nothing runs; cards hidden, and the cleanup deletes none of them
//   lost dispute       every ops record erased 30 days later
//   account deletion   every ops record erased at once
//
// GitHub, R2, push services and Cloudflare are fakes; nothing reaches a network.

const R2_ACCOUNT = "0123456789abcdef0123456789abcdef"
const R2_ORIGIN = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`
const MEDIA = {
  VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
  VECTOR_R2_MEDIA_ACCESS_KEY_ID: "fixturemediakey00001",
  VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: "fixtureMediaSecretAccessKey0123456789abcdefXY",
  VECTOR_R2_MEDIA_BUCKET: undefined,
}
const REPO = 42
const HOST = "shop.example.com"
const HEAD = "a".repeat(40)

let world: OpsWorld
let deleted: string[] = []
let mediaDown = false
let alerts: { account: string; title: string; allowPaused?: boolean }[] = []
const recordAlert: AlertSender = async (account, alert, options) => {
  alerts.push({ account, title: alert.title, allowPaused: options.allowPaused })
  return { sent: 1, failed: 0, removed: 0 }
}

beforeEach(() => {
  world = new OpsWorld(MEDIA)
  deleted = []
  mediaDown = false
  alerts = []
})
afterEach(() => {
  registerOpsRunStarter(undefined)
  setSystemTime()
  world.close()
})

/** The world's fetcher, with `vector-media` answering signed deletes. */
function fetcher(): typeof fetch {
  const base = world.fetcher()
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === R2_ORIGIN) {
      if (mediaDown) return new Response("unavailable", { status: 503 })
      if (init?.method !== "DELETE" || !url.searchParams.get("X-Amz-Signature"))
        return new Response(null, { status: 403 })
      deleted.push(decodeURIComponent(url.pathname.slice("/vector-media/".length)))
      return new Response(null, { status: 204 })
    }
    return base(input, init)
  }) as typeof fetch
}

/** A snapshot reconcile would write, through the ops provisioner as the outbox runs it. */
async function becomes(
  account: string,
  plan: PlanId | null,
  state: EntitlementSnapshot["state"],
  previous?: EntitlementSnapshot,
  reason?: EntitlementSnapshot["reason"],
) {
  const to = world.snapshotFor(account, plan, state, {
    ...(reason ? { reason } : {}),
    ...(previous ? { previous } : {}),
  })
  world.fakes.store.set(snapshotKey(account), JSON.stringify(to))
  setSystemTime(new Date(world.now))
  await opsProvisioner.apply({ account, from: previous, to, cause: "first_payment" }, fetcher())
  return to
}

/** The plan the provisioner last pushed to the Worker for the account. */
function pushed(account: string) {
  const body = world.worker.bodies.filter((item) => item.account === account && item.plan).at(-1)
  return body?.plan as OpsPlan | undefined
}

/** A verified domain, an On Call URL and a bound repository with both Release Guard and Ship Desk on. */
async function settings(account: string) {
  world.bind(REPO, account)
  await updateOpsSettings(
    account,
    () => ({
      ...newOpsSettings(),
      domains: [{ domain: HOST, token: "t".repeat(32), addedAt: world.now, verifiedAt: world.now, method: "dns" }],
      monitors: [{ id: "mon_aaaaaaaaaaaaaaaa", url: `https://${HOST}/health`, addedAt: world.now }],
      repos: [
        {
          repositoryId: REPO,
          repository: `octo-fixture/repo-${REPO}`,
          environment: "Production",
          productionUrl: `https://${HOST}`,
          paths: ["/"],
          releaseGuard: true,
          shipDesk: true,
          updatedAt: world.now,
        },
      ],
    }),
    fetcher(),
    world.now,
  )
}

/** A Ship Desk card as the CARD script stores it: its record, its retention past expiry and its index entry. */
function card(account: string, number: number, keepDays = 30): Card {
  const id = `crd_${String(number).padStart(22, "0")}`
  const value: Card = {
    v: 1,
    id,
    repositoryId: REPO,
    repository: `octo-fixture/repo-${REPO}`,
    number,
    url: `https://github.com/octo-fixture/repo-${REPO}/pull/${number}`,
    author: "app",
    state: "open",
    draft: false,
    baseRef: "main",
    headSha: HEAD,
    createdAt: world.now,
    updatedAt: world.now,
    expiresAt: world.now + keepDays * DAY,
    keepDays,
    images: [1, 2].map((n) => ({
      n,
      slot: n === 1 ? ("before" as const) : ("after" as const),
      route: "/",
      type: "image/png" as const,
      bytes: 100,
      width: 10,
      height: 10,
      key: imageObjectKey(
        { account, card: id, capture: "cap_0000000000000000000001", n, type: "image/png", keepDays },
        "test",
      ),
    })),
  }
  world.fakes.store.set(cardKey(account, id), JSON.stringify(value))
  world.fakes.store.expires.set(cardKey(account, id), value.expiresAt + SHIP_DESK_LIMITS.retainMs)
  world.fakes.store.zset(cardIndexKey(account)).set(id, world.now)
  return value
}

const cards = (account: string) =>
  invoke((request, response) => handleOpsCards(request, response, fetcher(), () => world.now), {
    method: "GET",
    authorization: world.token(account),
    url: "/api/ops/cards",
  })

const cleanup = (secret = CRON_SECRET) =>
  invoke((request, response) => handleOpsCleanup(request, response, fetcher(), () => world.now), {
    method: "GET",
    authorization: secret,
  })

const addDomain = (account: string, domain: string) =>
  invoke((request, response) => handleOpsDomains(request, response, fetcher(), () => world.now), {
    method: "POST",
    authorization: world.token(account),
    body: { domain },
  })

async function down(account: string, since = world.now) {
  return handleOpsReport(
    {
      v: 1,
      account,
      events: [
        {
          v: 1,
          id: `evt_down_${since}`.padEnd(16, "0"),
          kind: "monitor.down",
          at: world.now,
          monitor: "mon_aaaaaaaaaaaaaaaa",
          since,
          reason: "status",
          status: 502,
        },
      ],
    },
    { fetcher: fetcher(), now: world.now, alert: recordAlert },
  )
}

const opsKeys = (account: string) =>
  world.fakes.store.keys().filter((key) => key.includes(account) && key.includes(":ops:"))

describe("§4.4 through the ops provisioner", () => {
  test("active and renewing: checks and watches, on the roster, settings can be added, cards readable, fix runs start", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    expect(pushed(MAX)).toMatchObject({
      onCall: { urls: 5, intervalSec: 300 },
      releaseGuard: { perDay: 10, watchMin: 30, paths: 5 },
      validUntil: active.periodEnd + DAY,
    })
    await becomes(MAX, "vector-100", "renewing", active)
    expect(pushed(MAX)).toMatchObject({ onCall: { urls: 5 }, releaseGuard: { perDay: 10 } })
    expect(await rosterCounts(fetcher())).toEqual({ "vector-100": 1, "vector-200": 0 })
    expect((await addDomain(MAX, "api.example.com")).status).toBe(200)
    card(MAX, 1)
    expect((await cards(MAX)).body).toMatchObject({ hidden: false, cards: [{ number: 1 }] })
    await down(MAX)
    expect(alerts).toEqual([{ account: MAX, title: `On Call: ${HOST} failed two checks in a row`, allowPaused: true }])
    const triggers: unknown[] = []
    registerOpsRunStarter(async (trigger) => {
      triggers.push(trigger)
      return { id: "run_1" }
    })
    const incident = world.fakes.store.zset(incidentIndexKey(MAX)).keys().next().value!
    expect((await startIncidentFix(MAX, incident, {}, fetcher(), world.now)).fix.at).toBe(world.now)
    expect(triggers).toHaveLength(1)
  })

  test("paused: On Call keeps checking and alerting, no new watch, no new settings, no fix runs, cards readable, still budgeted", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    card(MAX, 1)
    await becomes(MAX, "vector-100", "paused", active)
    expect(pushed(MAX)).toMatchObject({ onCall: { urls: 5, intervalSec: 300 }, releaseGuard: null })
    expect(pushed(MAX)!.validUntil).toBeGreaterThan(world.now)
    const state = await opsCall("state", { account: MAX }, fetcher(), world.now)
    expect(state).toMatchObject({ active: true })
    await down(MAX)
    expect(alerts).toEqual([expect.objectContaining({ account: MAX, allowPaused: true })])
    const refused = await addDomain(MAX, "api.example.com")
    expect(refused.status).toBe(402)
    expect(refused.body.error.code).toBe("MODEL_PLAN_PAYMENT_REQUIRED")
    registerOpsRunStarter(async () => ({ id: "never" }))
    const incident = world.fakes.store.zset(incidentIndexKey(MAX)).keys().next().value!
    await expect(startIncidentFix(MAX, incident, {}, fetcher(), world.now)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_PAYMENT_REQUIRED",
    })
    expect((await cards(MAX)).body).toMatchObject({ hidden: false, cards: [{ number: 1 }] })
    // Paused subscribers stay in the guard's budget: their checks keep running.
    expect(await rosterCounts(fetcher())).toEqual({ "vector-100": 1, "vector-200": 0 })
  })

  test("ended: nothing runs; cards stay readable until they expire; the cleanup then deletes them with their images", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    const kept = card(MAX, 1)
    await becomes(MAX, "vector-100", "ended", active)
    expect(pushed(MAX)).toMatchObject({ onCall: null, releaseGuard: null })
    expect(pushed(MAX)!.validUntil).toBeLessThanOrEqual(world.now)
    expect(await rosterCounts(fetcher())).toEqual({ "vector-100": 0, "vector-200": 0 })
    expect(world.fakes.store.zset(opsAccountsKey()).has(MAX)).toBe(true)
    expect((await cards(MAX)).body.cards).toHaveLength(1)

    // Before expiry the cleanup leaves the card, and keeps the account on its list.
    expect((await cleanup()).body).toMatchObject({ enabled: true, accounts: 1, cardsExpired: 0, dropped: 0 })
    world.advance(30 * DAY + 1)
    expect((await cards(MAX)).body.cards).toEqual([])
    // Hidden, but its record is still there for the cleanup to find the images.
    expect(world.fakes.store.get(cardKey(MAX, kept.id))).toBeDefined()
    const swept = await cleanup()
    expect(swept.body).toMatchObject({ cardsExpired: 1, imagesDeleted: 2, failures: 0 })
    expect(deleted.sort()).toEqual(kept.images.map((image) => image.key).sort())
    expect(world.fakes.store.get(cardKey(MAX, kept.id))).toBeUndefined()
    expect(world.fakes.store.zset(cardIndexKey(MAX)).size).toBe(0)
    // Nothing left to expire and no plan: the account leaves the cleanup's list.
    expect(swept.body.dropped).toBe(1)
    expect(world.fakes.store.zset(opsAccountsKey()).has(MAX)).toBe(false)
    expect(JSON.stringify(swept.body)).not.toMatch(/\$|usd|credit/i)
  })

  test("images that cannot be deleted keep their card for the next run", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    card(MAX, 1)
    await becomes(MAX, "vector-100", "ended", active)
    world.advance(31 * DAY)
    mediaDown = true
    expect((await cleanup()).body).toMatchObject({ cardsExpired: 0, failures: 1, dropped: 0 })
    mediaDown = false
    expect((await cleanup()).body).toMatchObject({ cardsExpired: 1, imagesDeleted: 2, dropped: 1 })
  })

  test("frozen: nothing runs, cards are hidden and the cleanup deletes none; a won dispute shows them again", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    const kept = card(MAX, 1, 30)
    const frozen = await becomes(MAX, "vector-100", "frozen", active, "disputed")
    expect(pushed(MAX)).toMatchObject({ onCall: null, releaseGuard: null })
    expect(await rosterCounts(fetcher())).toEqual({ "vector-100": 0, "vector-200": 0 })
    expect((await cards(MAX)).body).toEqual({ cards: [], hidden: true })
    world.advance(29 * DAY)
    expect((await cleanup()).body).toMatchObject({ cardsExpired: 0, erased: 0, dropped: 0 })
    expect(world.fakes.store.get(cardKey(MAX, kept.id))).toBeDefined()
    expect(deleted).toEqual([])
    // The dispute is won: back to active, the card readable again within its days.
    await becomes(MAX, "vector-100", "active", frozen)
    expect((await cards(MAX)).body).toMatchObject({ hidden: false, cards: [{ number: 1 }] })
    expect(world.fakes.store.zset(opsEraseDueKey()).has(MAX)).toBe(false)
  })

  test("a lost dispute: every ops record is erased 30 days after the loss, not before", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    card(MAX, 1, 90)
    await down(MAX)
    world.fakes.store.set(opsHealthKey(MAX), JSON.stringify({ v: 1, domains: {} }))
    const frozen = await becomes(MAX, "vector-100", "frozen", active, "disputed")
    world.advance(DAY)
    const lost = await becomes(MAX, "vector-100", "ended", frozen, "disputed")
    expect(world.fakes.store.zset(opsEraseDueKey()).get(MAX)).toBe(lost.updatedAt + OPS_LOST_DISPUTE_ERASE_MS)
    // A rewrite of the same state later keeps the first date.
    world.advance(DAY)
    await becomes(MAX, "vector-100", "ended", lost, "disputed")
    expect(world.fakes.store.zset(opsEraseDueKey()).get(MAX)).toBe(lost.updatedAt + OPS_LOST_DISPUTE_ERASE_MS)

    world.advance(20 * DAY)
    expect((await cleanup()).body).toMatchObject({ erased: 0 })
    expect(world.fakes.store.get(opsSettingsKey(MAX))).toBeDefined()
    world.advance(9 * DAY)
    const erases = world.worker.actions.filter((action) => action === "erase").length
    expect((await cleanup()).body).toMatchObject({ erased: 1, failures: 0 })
    expect(world.worker.actions.filter((action) => action === "erase").length).toBe(erases + 1)
    expect(opsKeys(MAX)).toEqual([])
    expect(deleted).toHaveLength(2)
    for (const key of [opsAccountsKey(), opsEraseDueKey(), opsRosterKey("vector-100"), opsGuardHeldKey()])
      expect(world.fakes.store.zset(key).has(MAX)).toBe(false)
  })

  test("a lost dispute the owner clears before the 30 days are up is not erased", async () => {
    await settings(ULTRA)
    const active = await becomes(ULTRA, "vector-200", "active")
    const lost = await becomes(ULTRA, "vector-200", "ended", active, "disputed")
    expect(world.fakes.store.zset(opsEraseDueKey()).has(ULTRA)).toBe(true)
    world.advance(5 * DAY)
    await becomes(ULTRA, "vector-200", "active", lost)
    expect(world.fakes.store.zset(opsEraseDueKey()).has(ULTRA)).toBe(false)
    world.advance(30 * DAY)
    expect((await cleanup()).body).toMatchObject({ erased: 0 })
    expect(world.fakes.store.get(opsSettingsKey(ULTRA))).toBeDefined()
    // A due entry left behind (an older provisioner run) is dropped when the account is no longer in that state.
    world.fakes.store.zset(opsEraseDueKey()).set(ULTRA, world.now - 1)
    expect((await cleanup()).body).toMatchObject({ erased: 0 })
    expect(world.fakes.store.zset(opsEraseDueKey()).has(ULTRA)).toBe(false)
  })

  test("account deletion erases every ops record at once, and eraseAccountOps is one call for A57", async () => {
    await settings(MAX)
    const active = await becomes(MAX, "vector-100", "active")
    card(MAX, 1)
    await down(MAX)
    world.fakes.store.set(opsHealthKey(MAX), JSON.stringify({ v: 1, domains: {} }))
    await becomes(MAX, null, "ended", active, "closing")
    expect(world.worker.actions.at(-1)).toBe("erase")
    expect(opsKeys(MAX)).toEqual([])
    expect(deleted).toHaveLength(2)
    expect(world.fakes.store.zset(opsAccountsKey()).has(MAX)).toBe(false)
    expect(world.fakes.store.zset(opsEraseDueKey()).has(MAX)).toBe(false)
    // Media down: the erasure throws, so the outbox tries again.
    await settings(ULTRA)
    await becomes(ULTRA, "vector-200", "active")
    card(ULTRA, 2)
    mediaDown = true
    await expect(eraseAccountOps(ULTRA, fetcher(), world.now)).rejects.toMatchObject({
      statusCode: 503,
      code: "R2_UNAVAILABLE",
    })
  })
})

describe("the cleanup's housekeeping", () => {
  test("list entries whose incident or card expired are removed; the cron secret; nothing without the ops services", async () => {
    await settings(MAX)
    await becomes(MAX, "vector-100", "active")
    await down(MAX)
    const id = world.fakes.store.zset(incidentIndexKey(MAX)).keys().next().value!
    world.fakes.store.remove(incidentKey(MAX, id))
    world.fakes.store.zset(cardIndexKey(MAX)).set(`crd_${"g".repeat(22)}`, world.now)
    expect((await cleanup()).body).toMatchObject({ entriesPruned: 2, dropped: 0 })
    expect(world.fakes.store.zset(incidentIndexKey(MAX)).size).toBe(0)
    expect((await cleanup("not-the-secret")).status).toBe(401)
    delete process.env.VECTOR_OPS_ENABLED
    expect((await cleanup()).body).toMatchObject({ enabled: false, accounts: 0 })
  })
})

describe("listing (done: ops perks listable after the App and the security review)", () => {
  test("each ops perk is ready once its services are, and listed only with the App, phone alerts and the ops switch", async () => {
    process.env.CODIUM_LISTED_PERKS = "alerts,on-call,release-guard,ship-desk"
    // Phone alerts have their own readiness (A38); here they are taken as set up.
    const services = { ...perkServices, alerts: () => true }
    const listed = async () => [...(await listedPerks(fetcher(), { services }))].sort()
    expect(await listed()).toEqual(["alerts", "on-call", "release-guard", "ship-desk"])
    // Ship Desk keeps its screenshots in vector-media.
    delete process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID
    expect(await listed()).toEqual(["alerts", "on-call", "release-guard"])
    process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID = MEDIA.VECTOR_R2_MEDIA_ACCESS_KEY_ID
    // On Call and Ship Desk alert the phone (contract §1.2).
    expect([...(await listedPerks(fetcher(), { services: { ...services, alerts: () => false } }))].sort()).toEqual([
      "release-guard",
    ])
    // Release Guard's revert pull requests and Ship Desk's check runs need the App's own tokens; all three need the App.
    process.env.VECTOR_GITHUB_APP_ENABLED = "false"
    expect(await listed()).toEqual(["alerts"])
    // A half-configured App lists nothing at all (A48's fail-closed configuration).
    process.env.VECTOR_GITHUB_APP_ENABLED = "true"
    const key = process.env.VECTOR_GITHUB_APP_PRIVATE_KEY
    delete process.env.VECTOR_GITHUB_APP_PRIVATE_KEY
    expect(await listed()).toEqual([])
    process.env.VECTOR_GITHUB_APP_PRIVATE_KEY = key
    // The ops Worker, and the owner's ops switch.
    world.switchOff("ops")
    expect(await listed()).toEqual(["alerts"])
    world.fakes.store.remove(switchKey("ops"))
    expect(await listed()).toEqual(["alerts", "on-call", "release-guard", "ship-desk"])
    delete process.env.VECTOR_OPS_WORKER_URL
    expect(await listed()).toEqual(["alerts"])
  })
})
