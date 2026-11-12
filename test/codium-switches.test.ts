import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { queueCollectionSweep, syncCodiumCollection } from "../api/_lib/codium-collection"
import { requireEntitlement } from "../api/_lib/codium-entitlements"
import { codiumKey } from "../api/_lib/codium-keys"
import { drainOutbox } from "../api/_lib/codium-provision"
import { finalizeRenewal } from "../api/_lib/codium-renewal"
import {
  readSwitch,
  readSwitchState,
  readDisabledSet,
  writeSwitch,
  writeDisabledItem,
  switchKey,
  switchAuditKey,
} from "../api/_lib/codium-switches"
import { ApiError } from "../api/_lib/http"
import {
  listSubscriptions,
  modelPlanCredential,
  readModelPlanAccount,
  reconcileModelPlanAccount,
  withCodiumLease,
} from "../api/_lib/model-plan-account"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

const fixture = loadStripeFixture("renewing-draft-invoice")
const id = fixture.accountId
const now = fixture.now * 1000
const MINUTE = 60_000
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({ CODIUM_CODIUM_OFF_PAUSE_MINUTES: "60" })
})
afterEach(() => restore())
function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  return fakes
}
function time(fakes: CodiumFakes, value: number) {
  fakes.clock.now = value
  return value
}
const writes = (fakes: CodiumFakes) => fakes.stripe.calls.filter((call) => call.method !== "GET")
const pauseWrites = (fakes: CodiumFakes) => writes(fakes).filter((call) => call.form?.has("pause_collection[behavior]"))
const resumeWrites = (fakes: CodiumFakes) => writes(fakes).filter((call) => call.form?.get("pause_collection") === "")
async function sync(fakes: CodiumFakes, at = fakes.clock.now, verify?: () => Promise<void>) {
  return withCodiumLease(
    id,
    async (lease) =>
      syncCodiumCollection(
        id,
        (await readModelPlanAccount(id, fakes.fetcher))!,
        await listSubscriptions(String(fixture.account.customer), fakes.fetcher),
        verify ?? lease,
        fakes.fetcher,
        at,
      ),
    fakes.fetcher,
  )
}
function risk(fakes: CodiumFakes, held: boolean) {
  const account = JSON.parse(fakes.store.get(codiumKey("account", id))!)
  account.risk = {
    blocked: false,
    openDisputes: held ? { ch_old: { status: "needs_response", at: now } } : {},
    efw: [],
  }
  fakes.store.set(codiumKey("account", id), JSON.stringify(account))
}
function funded(fakes: CodiumFakes) {
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({
      status: "open",
      checkedAt: fakes.clock.now,
      since: now,
      balance: 100_000,
      owed: 0,
      reserved: 0,
      required: 0,
      keys: 0,
    }),
  )
}

describe("A11 audited runtime switches", () => {
  test("a remote change is honored at the 30-second boundary; authoritative reads bypass the cache", async () => {
    const fakes = seed()
    expect(await readSwitch("codium", fakes.fetcher, { now })).toBe("on")
    fakes.store.set(switchKey("codium"), "off")
    expect(await readSwitch("codium", fakes.fetcher, { now: now + 29_999 })).toBe("on")
    expect(await readSwitch("codium", fakes.fetcher, { now: now + 30_000 })).toBe("off")
    fakes.store.set(switchKey("codium"), "on")
    expect(await readSwitch("codium", fakes.fetcher, { fresh: true, now: now + 30_001 })).toBe("on")
  })
  test("atomic no-ops preserve the first off timestamp and do not duplicate the audit", async () => {
    const fakes = seed()
    const first = await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    const again = await Promise.all(
      Array.from({ length: 10 }, () => writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now + MINUTE)),
    )
    expect(
      again.every((value) => !value.changed && value.offSince === now && value.generation === first.generation),
    ).toBe(true)
    expect(fakes.store.zset(switchAuditKey()).size).toBe(1)
    expect(JSON.parse([...fakes.store.zset(switchAuditKey()).keys()][0]!)).toMatchObject({
      actor: "owner:fixture",
      previous: "on",
      value: "off",
    })
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, now + 59 * MINUTE)
    const restarted = await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now + 60 * MINUTE)
    expect(restarted.offSince).toBe(now + 60 * MINUTE)
    expect(restarted.generation).not.toBe(first.generation)
  })
  test("model and perk kills are audited sets, isolated from ordinary service switches", async () => {
    const fakes = seed()
    await writeDisabledItem("models-off", "vendor/model", true, "owner:fixture", fakes.fetcher, now)
    await writeDisabledItem("perks-off", "computer", true, "owner:fixture", fakes.fetcher, now)
    expect(await readDisabledSet("models-off", fakes.fetcher, { now })).toEqual(new Set(["vendor/model"]))
    expect(await readDisabledSet("perks-off", fakes.fetcher, { now })).toEqual(new Set(["computer"]))
    expect(await readSwitch("codium", fakes.fetcher, { now })).toBe("on")
    expect(await writeDisabledItem("models-off", "vendor/model", true, "owner:fixture", fakes.fetcher, now)).toEqual({
      changed: false,
    })
    await writeDisabledItem("models-off", "vendor/model", false, "owner:fixture", fakes.fetcher, now)
    expect(await readDisabledSet("models-off", fakes.fetcher, { now })).toEqual(new Set())
    expect(fakes.store.zset(switchAuditKey()).size).toBe(3)
  })
  test("bad values, corrupt reads and email actors never become an unaudited switch write", async () => {
    const fakes = seed()
    await expect(writeSwitch("hosted", "off", "owner:fixture", fakes.fetcher, now)).rejects.toMatchObject({
      code: "CODIUM_SWITCH_INVALID",
    })
    await expect(writeSwitch("codium", "off", "owner@example.test", fakes.fetcher, now)).rejects.toMatchObject({
      code: "CODIUM_SWITCH_INVALID",
    })
    fakes.store.set(switchKey("codium"), '{"value":"off","offSince":-1}')
    await expect(readSwitch("codium", fakes.fetcher, { fresh: true })).rejects.toMatchObject({
      code: "CODIUM_SWITCH_UNAVAILABLE",
    })
    expect(fakes.store.zset(switchAuditKey()).size).toBe(0)
  })
  test("codium-off refuses direct model admission and entitlement without touching Stripe or a provider", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await expect(modelPlanCredential(id, fakes.fetcher, now, 0.01)).rejects.toMatchObject({
      code: "MODEL_PLANS_DISABLED",
    })
    await expect(requireEntitlement(id, "codium", fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLANS_DISABLED",
    })
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.openRouter.calls).toEqual([])
  })
})

describe("A11 collection pause ownership", () => {
  test("59 minutes leaves collection alone; 60 pauses and holds the exact renewal once", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await sync(fakes, time(fakes, now + 59 * MINUTE))
    expect(writes(fakes)).toEqual([])
    await sync(fakes, time(fakes, now + 60 * MINUTE))
    await sync(fakes)
    expect(pauseWrites(fakes)).toHaveLength(1)
    expect(fakes.stripe.subscription("sub_renewing")!.pause_collection).toMatchObject({ behavior: "void" })
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.auto_advance).toBe(false)
    expect(fakes.stripe.objects.invoices.get("in_renewingP1")!.status).toBe("paid")
  })
  test("switch-on resumes only the owned pause and the exact renewal pays once", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await sync(fakes, time(fakes, now + 60 * MINUTE))
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
    await sync(fakes)
    await sync(fakes)
    expect(resumeWrites(fakes)).toHaveLength(1)
    funded(fakes)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.status).toBe("paid")
    expect(writes(fakes).filter((call) => call.path === "invoices/in_renewal/pay")).toHaveLength(1)
  })
  test("a renewal's legacy frozen pause lifts after its final risk hold clears", async () => {
    const fakes = seed()
    risk(fakes, true)
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, now)).toMatchObject({
      outcome: "refused",
      reason: "frozen",
      paused: true,
    })
    expect(fakes.stripe.subscription("sub_renewing")!.metadata).toMatchObject({ vector_paused_for: "frozen" })
    await sync(fakes)
    expect(resumeWrites(fakes)).toEqual([])
    risk(fakes, false)
    await sync(fakes)
    expect(resumeWrites(fakes)).toHaveLength(1)
    expect(fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1])).toContain("finalize-renewal:in_renewal")
  })
  test("a risk pause retains the held renewal through a lost win response and pays it once", async () => {
    const fakes = seed()
    const charge = "ch_renewingP1"
    fakes.stripe.charge(charge)!.disputed = true
    fakes.stripe.load({ disputes: [{ id: "dp_renewal", charge, status: "needs_response" }] })
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: { kind: "dispute", charge } })
    expect(fakes.stripe.subscription("sub_renewing")!.metadata).toMatchObject({ vector_risk_pause: id })
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, now)).toMatchObject({ reason: "frozen" })
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.auto_advance).toBe(false)
    fakes.stripe.objects.disputes.get("dp_renewal")!.status = "won"
    let lost = false
    const fetcher = (async (input, init) => {
      const response = await fakes.fetcher(input, init)
      if (
        !lost &&
        String(input).includes("subscriptions/sub_renewing") &&
        new URLSearchParams(String(init?.body ?? "")).get("pause_collection") === ""
      ) {
        lost = true
        return new Response("lost response", { status: 503 })
      }
      return response
    }) as typeof fetch
    await expect(reconcileModelPlanAccount(id, fetcher, now)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    funded(fakes)
    await drainOutbox({ now, fetcher: fakes.fetcher })
    await drainOutbox({ now, fetcher: fakes.fetcher })
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.status).toBe("paid")
    expect(writes(fakes).filter((call) => call.path === "invoices/in_renewal/pay")).toHaveLength(1)
  })
  test("an already-owned pause discovers and remembers a later visible renewal", async () => {
    const fakes = seed()
    fakes.stripe.subscription("sub_renewing")!.latest_invoice = "in_renewingP1"
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await sync(fakes, time(fakes, now + 60 * MINUTE))
    fakes.stripe.subscription("sub_renewing")!.latest_invoice = "in_renewal"
    await sync(fakes)
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.auto_advance).toBe(false)
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
    await sync(fakes)
    expect(fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1])).toContain("finalize-renewal:in_renewal")
    expect(pauseWrites(fakes)).toHaveLength(1)
  })
  test("a frozen renewal guard preserves an existing owner pause", async () => {
    const fakes = seed()
    risk(fakes, true)
    fakes.stripe.subscription("sub_renewing")!.pause_collection = { behavior: "keep_as_draft", resumes_at: null }
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, now)).toMatchObject({ reason: "frozen", paused: false })
    expect(pauseWrites(fakes)).toEqual([])
    risk(fakes, false)
    await sync(fakes)
    expect(resumeWrites(fakes)).toEqual([])
    expect(fakes.stripe.subscription("sub_renewing")!.pause_collection).toEqual({
      behavior: "keep_as_draft",
      resumes_at: null,
    })
  })

  test("service and dispute holds can clear in either order without an early resume", async () => {
    for (const serviceFirst of [false, true]) {
      const fakes = seed()
      await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
      await sync(fakes, time(fakes, now + 60 * MINUTE))
      risk(fakes, true)
      if (serviceFirst) await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
      else risk(fakes, false)
      await sync(fakes)
      expect(resumeWrites(fakes)).toEqual([])
      risk(fakes, false)
      await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
      await sync(fakes)
      expect(resumeWrites(fakes)).toHaveLength(1)
    }
  })
  test("owner takeover is preserved, and a later off cycle uses a new provider intent", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await sync(fakes, time(fakes, now + 60 * MINUTE))
    const first = pauseWrites(fakes)[0]!.idempotencyKey
    fakes.stripe.subscription("sub_renewing")!.pause_collection = { behavior: "void", resumes_at: fixture.now + 86400 }
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
    await sync(fakes)
    expect(resumeWrites(fakes)).toEqual([])
    fakes.stripe.subscription("sub_renewing")!.pause_collection = null
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, fakes.clock.now)
    await sync(fakes, time(fakes, fakes.clock.now + 60 * MINUTE))
    expect(pauseWrites(fakes)).toHaveLength(2)
    expect(pauseWrites(fakes)[1]!.idempotencyKey).not.toBe(first)
  })
  test("a lost lease after pause retains its invoice intent and retry finishes the hold", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    time(fakes, now + 60 * MINUTE)
    await expect(
      sync(fakes, fakes.clock.now, async () => {
        if (pauseWrites(fakes).length) throw new ApiError(503, "BILLING_LOCK_EXPIRED", "retry")
      }),
    ).rejects.toMatchObject({ code: "BILLING_LOCK_EXPIRED" })
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.auto_advance).not.toBe(false)
    await sync(fakes)
    expect(pauseWrites(fakes)).toHaveLength(1)
    expect(fakes.stripe.objects.invoices.get("in_renewal")!.auto_advance).toBe(false)
  })
  test("a lost lease after resume retains the exact renewal for the next retry", async () => {
    const fakes = seed()
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await sync(fakes, time(fakes, now + 60 * MINUTE))
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, fakes.clock.now)
    await expect(
      sync(fakes, fakes.clock.now, async () => {
        if (resumeWrites(fakes).length) throw new ApiError(503, "BILLING_LOCK_EXPIRED", "retry")
      }),
    ).rejects.toMatchObject({ code: "BILLING_LOCK_EXPIRED" })
    await sync(fakes)
    expect(resumeWrites(fakes)).toHaveLength(1)
    expect(fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1])).toContain("finalize-renewal:in_renewal")
  })
  test("stale jobs cannot borrow time from an earlier off generation", async () => {
    const fakes = seed()
    fakes.store.zset(codiumKey("idx", "period-end")).set(id, now + 86400_000)
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now)
    await queueCollectionSweep(fakes.fetcher, now)
    await writeSwitch("codium", "on", "owner:fixture", fakes.fetcher, now + 59 * MINUTE)
    await writeSwitch("codium", "off", "owner:fixture", fakes.fetcher, now + 60 * MINUTE)
    time(fakes, now + 60 * MINUTE)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect(pauseWrites(fakes)).toEqual([])
    time(fakes, now + 120 * MINUTE)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect(pauseWrites(fakes)).toHaveLength(1)
  })
  test("sales-off never pauses or refuses a funded renewal", async () => {
    const fakes = seed()
    await writeSwitch("sales", "off", "owner:fixture", fakes.fetcher, now)
    funded(fakes)
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, now)).toMatchObject({ outcome: "paid" })
    expect(pauseWrites(fakes)).toEqual([])
    expect(await readSwitchState("codium", fakes.fetcher, { now })).toMatchObject({ value: "on" })
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("A11 switch Lua on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input, init) => {
    const command = JSON.parse(String(init?.body)).map(String) as string[]
    return Response.json({ result: await client!.send(command[0]!, command.slice(1)) })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })
  test("parallel same-value mutations keep one generation/off clock and one audit", async () => {
    const values = await Promise.all(
      Array.from({ length: 20 }, (_, index) => writeSwitch("codium", "off", "owner:fixture", fetcher, now + index)),
    )
    expect(new Set(values.map((value) => value.generation)).size).toBe(1)
    expect(values.filter((value) => value.changed)).toHaveLength(1)
    expect(await client!.send("ZCARD", [switchAuditKey()])).toBe(1)
  })
  test("parallel kill-set writes audit only effective changes", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        writeDisabledItem("models-off", "vendor/model", true, "owner:fixture", fetcher, now),
      ),
    )
    expect(await readDisabledSet("models-off", fetcher, { fresh: true, now })).toEqual(new Set(["vendor/model"]))
    expect(await client!.send("ZCARD", [switchAuditKey()])).toBe(1)
  })
})
