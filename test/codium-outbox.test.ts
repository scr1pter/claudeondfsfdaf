import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { codiumKey } from "../api/_lib/codium-keys"
import {
  ACTION_KINDS,
  configuredProvisioners,
  createActionRegistry,
  drainOutbox,
  enqueueAction,
  OUTBOX_DEAD_KEEP_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_SCRIPTS,
  outboxBackoffMs,
  provKey,
  registerAction,
  registerProvisioner,
  requeueBehindProvisioners,
  type ActionHandler,
  type ActionRegistry,
  type PerkProvisioner,
  type Transition,
} from "../api/_lib/codium-provision"
import {
  githubRuns,
  ownerNotice,
  ownerNotify,
  PROVISIONERS,
  RUN_TOKEN_REVOCATION_KEEP_MS,
  runTokenRevoked,
  runTokensRevokedBefore,
  runTokensRevokedKey,
} from "../api/_lib/codium-provisioners"
import {
  buildSnapshot,
  PRIORITY_LEAD_MS,
  readSnapshot,
  SNAPSHOT_SCRIPTS,
  writeSnapshot,
  type EntitlementSnapshot,
  type SnapshotFacts,
} from "../api/_lib/codium-snapshot"
import { ApiError, type ApiRequest, type ApiResponse } from "../api/_lib/http"
import { readModelPlanAccount } from "../api/_lib/model-plan-account"
import outboxCron from "../api/model-plans/outbox"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

// WP A06: the outbox and its provisioners (contract §4.8). Each new snapshot version queues one item per configured
// provisioner in the snapshot's own EVAL; the minute cron drains them, and durable actions, under one global lock and a
// time budget, freezes and revocations first; a failing item is retried with backoff and after ten tries becomes a
// dead letter the owner is told about; a provisioner never applies an older version over a newer one; and the daily
// sweep's re-enqueue repairs work that never ran. The store, Stripe, OpenRouter and the owner's email are in-memory
// fakes (packages/web/test/fixture/codium-fakes.ts); the outbox's Lua also runs against a real Valkey when
// VECTOR_TEST_REDIS_URL is set (the CI lane).

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 28, 12)
const ACCOUNT = "0b6a7c1e-3d2f-4a5b-8c9d-1e2f3a4b5c6d"
const NOTHING = { applied: 0, retried: 0, dead: 0, skipped: 0, busy: false }
// Placeholders only: the fake email service records what it is asked to send and reaches nothing.
const OWNER_ALERTS = {
  RESEND_API_KEY: "re_fixture_placeholder",
  VECTOR_PURCHASE_EMAIL_FROM: "codium-alerts@example.invalid",
  CODIUM_OWNER_EMAIL: "owner@example.invalid",
}

let restore = () => {}
let cleanup: (() => void)[] = []
let scopedActions: ActionRegistry | undefined
beforeEach(() => {
  restore = codiumTestEnvironment()
  scopedActions = undefined
})
afterEach(() => {
  for (const off of cleanup.reverse()) off()
  cleanup = []
  restore()
})

function environment(overrides: Record<string, string | undefined>) {
  restore()
  restore = codiumTestEnvironment(overrides)
}

function facts(account: string, overrides: Partial<SnapshotFacts> = {}): SnapshotFacts {
  return {
    account,
    state: "active",
    plan: "vector-100",
    subscription: "sub_outbox",
    periodStart: T0 - DAY,
    periodEnd: T0 + 29 * DAY,
    cancelAtPeriodEnd: false,
    source: "webhook",
    ...overrides,
  }
}

const NO_PLAN = { state: "none", plan: null, subscription: undefined, periodStart: 0, periodEnd: 0 } as const

/** Writes the account's next snapshot as reconcile does: one EVAL with the items its listeners ask for. */
async function change(fetcher: typeof fetch, account: string, overrides: Partial<SnapshotFacts>, now: number) {
  const previous = await readSnapshot(account, fetcher)
  const next = buildSnapshot(facts(account, overrides), previous, now)
  expect((await writeSnapshot(next, previous, fetcher, now)).written).toBe(true)
  return next
}

const itemKey = (id: string) => codiumKey("outbox", "item", id)
const queued = (fakes: CodiumFakes) => fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1]) as string[]
const dead = (fakes: CodiumFakes) => fakes.store.command(["ZRANGE", codiumKey("outbox", "dead"), 0, -1]) as string[]
const score = (fakes: CodiumFakes, id: string) => Number(fakes.store.command(["ZSCORE", codiumKey("outbox"), id]))
const record = (fakes: CodiumFakes, id: string) => JSON.parse(fakes.store.get(itemKey(id)) ?? "null")

/** A provisioner for the tests, recording what it applied; `fail` makes it throw while it returns true. */
function recorder(id: string, options: { fail?: () => boolean; during?: (t: Transition) => void } = {}) {
  const applied: Transition[] = []
  const provisioner: PerkProvisioner = {
    id,
    configured: () => true,
    async apply(t) {
      if (options.fail?.()) throw new ApiError(503, "TEST_DOWN", "The test service is down.")
      applied.push(t)
      options.during?.(t)
    },
  }
  cleanup.push(registerProvisioner(provisioner))
  return applied
}

function handle(kind: Parameters<typeof registerAction>[0], handler: ActionHandler) {
  scopedActions ??= createActionRegistry()
  cleanup.push(scopedActions.register(kind, handler))
}

function drainScoped(options: Parameters<typeof drainOutbox>[0]) {
  return drainOutbox({ ...options, ...(scopedActions ? { actionRegistry: scopedActions } : {}) })
}

// ── Items in the snapshot's EVAL ───────────────────────────────────────────────────────────────────────────────────

describe("provisioner items", () => {
  test("each new snapshot version queues one item per configured provisioner, in the snapshot's own EVAL", async () => {
    const fakes = codiumFakes({ now: T0 })
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
    // The stubs are not configured; owner-notify is once owner alerts are.
    expect(configuredProvisioners()).toEqual(["github-runs"])
    const first = await change(fakes.fetcher, ACCOUNT, {}, T0)
    const writes = fakes.store.commands.filter(
      (command) => command[0] === "EVAL" && command[1] === SNAPSHOT_SCRIPTS.WRITE,
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]!.slice(3, 3 + Number(writes[0]![2]))).toContain(itemKey(`github-runs:${ACCOUNT}:1`))
    expect(queued(fakes)).toEqual([`github-runs:${ACCOUNT}:1`])
    expect(score(fakes, `github-runs:${ACCOUNT}:1`)).toBe(T0)
    expect(record(fakes, `github-runs:${ACCOUNT}:1`)).toEqual({
      v: 1,
      type: "provision",
      provisioner: "github-runs",
      account: ACCOUNT,
      version: 1,
      cause: "first_payment",
      priority: false,
      to: JSON.parse(JSON.stringify(first)),
      attempts: 0,
      createdAt: T0,
    })

    environment(OWNER_ALERTS)
    expect(configuredProvisioners()).toEqual(["github-runs", "owner-notify"])
    const second = await change(fakes.fetcher, ACCOUNT, { cancelAtPeriodEnd: true }, T0 + 1000)
    expect(queued(fakes)).toEqual([`github-runs:${ACCOUNT}:1`, `github-runs:${ACCOUNT}:2`, `owner-notify:${ACCOUNT}:2`])
    expect(record(fakes, `owner-notify:${ACCOUNT}:2`)).toMatchObject({
      cause: "cancel_scheduled",
      from: JSON.parse(JSON.stringify(first)),
      to: JSON.parse(JSON.stringify(second)),
    })

    // A recheck that finds nothing new, and an account that has never had a plan, queue nothing.
    const recheck = buildSnapshot(facts(ACCOUNT, { cancelAtPeriodEnd: true }), second, T0 + 2000)
    expect(recheck.version).toBe(2)
    expect((await writeSnapshot(recheck, second, fakes.fetcher, T0 + 2000)).written).toBe(true)
    await change(fakes.fetcher, "never-paid", NO_PLAN, T0)
    expect(queued(fakes)).toHaveLength(3)
  })
})

// ── The drain ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("drainOutbox", () => {
  test("runs what is due under one global lock, records each provisioner's version, and costs one read when idle", async () => {
    const fakes = codiumFakes({ now: T0 })
    const applied = recorder("test-service")
    await change(fakes.fetcher, ACCOUNT, {}, T0)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, applied: 2 })
    expect(applied.map((t) => [t.to.version, t.cause, t.from])).toEqual([[1, "first_payment", undefined]])
    expect(queued(fakes)).toEqual([])
    expect(fakes.store.get(itemKey(`test-service:${ACCOUNT}:1`))).toBeUndefined()
    expect(fakes.store.get(provKey("test-service", ACCOUNT))).toBe("1")
    expect(fakes.store.get(provKey("github-runs", ACCOUNT))).toBe("1")
    expect(fakes.store.get(codiumKey("outbox", "lock"))).toBeUndefined()

    // A minute with nothing due: one read, no lock.
    const before = fakes.store.commands.length
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 60_000 })).toEqual(NOTHING)
    expect(fakes.store.commands.slice(before).map((command) => command[0])).toEqual(["ZRANGEBYSCORE"])

    // Another drain holds the lock: this one leaves everything to it.
    await change(fakes.fetcher, ACCOUNT, { cancelAtPeriodEnd: true }, T0 + 1000)
    fakes.store.command(["SET", codiumKey("outbox", "lock"), "another-drain", "PX", 60_000])
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 1000 })).toEqual({ ...NOTHING, busy: true })
    expect(applied).toHaveLength(1)
    expect(fakes.store.get(codiumKey("outbox", "lock"))).toBe("another-drain")
    fakes.clock.advance(60_001)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 61_001 })).toEqual({ ...NOTHING, applied: 2 })
    expect(applied.map((t) => [t.cause, t.from?.version, t.to.version])).toEqual([
      ["first_payment", undefined, 1],
      ["cancel_scheduled", 1, 2],
    ])
  })

  test("freezes and revocations drain first, and a retried one keeps its lane and its backoff", async () => {
    const fakes = codiumFakes({ now: T0 })
    const order: string[] = []
    let failFrozen = true
    handle("pool-ramp", async (action) => {
      order.push(`pool-ramp ${action.key}`)
    })
    recorder("test-service", {
      fail: () => {
        const failing = failFrozen && order.length === 0
        if (failing) order.push("frozen failed")
        return failing
      },
      during: (t) => order.push(`${t.account} ${t.to.state}`),
    })
    await enqueueAction("pool-ramp", "sub_old", { reason: "upgrade" }, T0 - HOUR, fakes.fetcher, T0)
    await change(fakes.fetcher, "account-active", {}, T0)
    const frozen = await change(fakes.fetcher, "account-frozen", { state: "frozen", reason: "disputed" }, T0 + 1000)
    expect(frozen.revokedBefore).toBe(T0 + 1000)
    expect(score(fakes, "test-service:account-frozen:1")).toBe(T0 + 1000 - PRIORITY_LEAD_MS)
    expect(score(fakes, "test-service:account-active:1")).toBe(T0)

    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2000 })).toEqual({
      ...NOTHING,
      applied: 4,
      retried: 1,
    })
    // The frozen account's items ran first; its failed one waits out its backoff in the priority lane.
    expect(order).toEqual(["frozen failed", "pool-ramp sub_old", "account-active active"])
    expect(score(fakes, "test-service:account-frozen:1")).toBe(T0 + 2000 + outboxBackoffMs(1) - PRIORITY_LEAD_MS)
    failFrozen = false
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2000 + outboxBackoffMs(1) - 1000 })).toEqual(NOTHING)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2000 + outboxBackoffMs(1) })).toEqual({
      ...NOTHING,
      applied: 1,
    })
    expect(order.at(-1)).toBe("account-frozen frozen")
  })

  test("a failing provisioner is retried with backoff, then set aside as a dead letter, and the owner is told", async () => {
    environment(OWNER_ALERTS)
    const fakes = codiumFakes({ now: T0 })
    let failing = true
    const applied = recorder("flaky", { fail: () => failing })
    await change(fakes.fetcher, ACCOUNT, {}, T0)
    const id = `flaky:${ACCOUNT}:1`
    // github-runs and owner-notify (nothing to tell about a first payment) apply; flaky fails its first try.
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, applied: 2, retried: 1 })
    let now = T0
    const waits: number[] = []
    for (let attempts = 1; attempts < OUTBOX_MAX_ATTEMPTS; attempts++) {
      expect(record(fakes, id)).toMatchObject({ attempts, error: "TEST_DOWN: The test service is down." })
      const due = score(fakes, id)
      waits.push(due - now)
      expect(await drainScoped({ fetcher: fakes.fetcher, now: due - 1000 })).toEqual(NOTHING)
      now = due
      const last = attempts + 1 === OUTBOX_MAX_ATTEMPTS
      // On the last try it becomes a dead letter, and its owner alert is sent in the same drain.
      expect(await drainScoped({ fetcher: fakes.fetcher, now })).toEqual(
        last ? { ...NOTHING, dead: 1, applied: 1 } : { ...NOTHING, retried: 1 },
      )
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600].map((seconds) => seconds * 1000))
    expect(queued(fakes)).toEqual([])
    expect(dead(fakes)).toEqual([id])
    expect(record(fakes, id)).toMatchObject({
      attempts: OUTBOX_MAX_ATTEMPTS,
      error: "TEST_DOWN: The test service is down.",
    })
    expect(fakes.store.expires.get(itemKey(id))).toBe(fakes.clock.now + OUTBOX_DEAD_KEEP_MS)
    expect(fakes.store.get(provKey("flaky", ACCOUNT))).toBeUndefined()
    expect(applied).toEqual([])
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.mail.sent[0]).toMatchObject({
      from: "codium-alerts@example.invalid",
      to: "owner@example.invalid",
      subject: "Vector Codium: an outbox job was set aside",
    })
    expect(fakes.mail.sent[0]!.text).toContain(`The outbox job ${id} failed 10 times`)
    expect(fakes.mail.sent[0]!.text).not.toMatch(/\$|@/)

    // The daily sweep queues it again (off the dead letters, tries starting over), and this time it applies.
    failing = false
    expect(await requeueBehindProvisioners(ACCOUNT, fakes.fetcher, now)).toBe(1)
    expect(dead(fakes)).toEqual([])
    expect(record(fakes, id)).toMatchObject({ attempts: 0, version: 1 })
    expect(await drainScoped({ fetcher: fakes.fetcher, now })).toEqual({ ...NOTHING, applied: 1 })
    expect(applied.map((t) => t.to.version)).toEqual([1])
    expect(fakes.store.get(provKey("flaky", ACCOUNT))).toBe("1")
    expect(fakes.mail.sent).toHaveLength(1)
  })

  test("an owner alert that cannot be sent is retried, and never alerts about itself", async () => {
    environment(OWNER_ALERTS)
    const fakes = codiumFakes({ now: T0 })
    fakes.mail.fail = true
    // An explicitly empty registry exercises missing handlers independently of installed production actions.
    scopedActions = createActionRegistry()
    await enqueueAction("pool-ramp", ACCOUNT, {}, T0, fakes.fetcher, T0)
    let now = T0
    for (let drain = 0; drain < 2 * OUTBOX_MAX_ATTEMPTS + 2; drain++) {
      await drainScoped({ fetcher: fakes.fetcher, now })
      now += HOUR
    }
    const alert = `owner-alert:outbox-dead:pool-ramp:${ACCOUNT}`
    expect(dead(fakes).sort()).toEqual([alert, `pool-ramp:${ACCOUNT}`].sort())
    expect(queued(fakes)).toEqual([])
    expect(record(fakes, `pool-ramp:${ACCOUNT}`).error).toStartWith("CODIUM_OUTBOX_NO_HANDLER")
    expect(record(fakes, alert)).toMatchObject({
      attempts: OUTBOX_MAX_ATTEMPTS,
      error: expect.stringContaining("CODIUM_OWNER_ALERT_FAILED"),
    })
    expect(fakes.mail.sent).toEqual([])
    // Each failed send gave its dedupe mark back, so a later send is not mistaken for a duplicate.
    expect(fakes.store.get(codiumKey("owner", "alert", `outbox-dead:pool-ramp:${ACCOUNT}`))).toBeUndefined()
  })

  test("an older version never overwrites a newer one", async () => {
    const fakes = codiumFakes({ now: T0 })
    const applied = recorder("test-service")
    const first = await change(fakes.fetcher, ACCOUNT, {}, T0)
    const late = fakes.store.get(itemKey(`test-service:${ACCOUNT}:1`))!
    const frozen = await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "disputed" }, T0 + 1000)
    // The freeze (version 2) is in the priority lane, so it runs first; version 1 then has nothing left to do.
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2000 })).toEqual({
      ...NOTHING,
      applied: 2,
      skipped: 2,
    })
    expect(applied.map((t) => t.to.version)).toEqual([2])
    expect(fakes.store.get(provKey("test-service", ACCOUNT))).toBe("2")
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(frozen.revokedBefore!)

    // A late copy of version 1's work is skipped too, and the applied version never goes down.
    fakes.store.command([
      "EVAL",
      OUTBOX_SCRIPTS.ENQUEUE,
      3,
      codiumKey("outbox"),
      itemKey(`test-service:${ACCOUNT}:1`),
      codiumKey("outbox", "dead"),
      `test-service:${ACCOUNT}:1`,
      late,
      T0,
      "replace",
    ])
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 3000 })).toEqual({ ...NOTHING, skipped: 1 })
    expect(applied.map((t) => t.to.version)).toEqual([2])
    expect(fakes.store.get(provKey("test-service", ACCOUNT))).toBe("2")
    // The snapshot itself: an older version is refused, and queues nothing.
    expect((await writeSnapshot(first, undefined, fakes.fetcher, T0 + 4000)).written).toBe(false)
    expect((await readSnapshot(ACCOUNT, fakes.fetcher))?.version).toBe(2)
    expect(queued(fakes)).toEqual([])

    // In the same lane, versions apply in order.
    await change(fakes.fetcher, "in-order", {}, T0)
    await change(fakes.fetcher, "in-order", { cancelAtPeriodEnd: true }, T0 + 1000)
    await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2000 })
    expect(applied.filter((t) => t.account === "in-order").map((t) => t.to.version)).toEqual([1, 2])
    expect(fakes.store.get(provKey("test-service", "in-order"))).toBe("2")
  })

  test("a crash after the snapshot write is repaired by the sweep's re-enqueue", async () => {
    const fakes = codiumFakes({ now: T0 })
    const applied = recorder("test-service")
    // The snapshot is written with its items, then the work is lost before it runs (here, with the store's outbox).
    const snapshot = await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "early_fraud_warning" }, T0)
    expect(queued(fakes)).toEqual([`github-runs:${ACCOUNT}:1`, `test-service:${ACCOUNT}:1`])
    for (const id of queued(fakes)) fakes.store.remove(itemKey(id))
    fakes.store.remove(codiumKey("outbox"))
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual(NOTHING)
    expect(applied).toEqual([])

    // The sweep finds both provisioners behind the snapshot and queues them again, still in the priority lane.
    expect(await requeueBehindProvisioners(ACCOUNT, fakes.fetcher, T0 + HOUR)).toBe(2)
    expect(queued(fakes)).toEqual([`github-runs:${ACCOUNT}:1`, `test-service:${ACCOUNT}:1`])
    expect(score(fakes, `test-service:${ACCOUNT}:1`)).toBe(T0 + HOUR - PRIORITY_LEAD_MS)
    // While they wait, running it again queues nothing new.
    expect(await requeueBehindProvisioners(ACCOUNT, fakes.fetcher, T0 + HOUR)).toBe(0)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + HOUR })).toEqual({ ...NOTHING, applied: 2 })
    expect(applied.map((t) => [t.to.version, t.to.state, t.cause, t.from])).toEqual([
      [1, "frozen", "early_fraud_warning", undefined],
    ])
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(snapshot.revokedBefore!)
    expect(await requeueBehindProvisioners(ACCOUNT, fakes.fetcher, T0 + HOUR)).toBe(0)

    // A provisioner configured after the change catches up the same way: here, owner alerts switched on later.
    environment(OWNER_ALERTS)
    expect(await requeueBehindProvisioners(ACCOUNT, fakes.fetcher, T0 + 2 * HOUR)).toBe(1)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2 * HOUR })).toEqual({ ...NOTHING, applied: 1 })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual([
      "Vector Codium: an account is on hold (early_fraud_warning)",
    ])

    // An account that never had a plan, or has no snapshot, has nothing to catch up on.
    await change(fakes.fetcher, "never-paid", NO_PLAN, T0)
    expect(await requeueBehindProvisioners("never-paid", fakes.fetcher, T0)).toBe(0)
    expect(await requeueBehindProvisioners("no-snapshot", fakes.fetcher, T0)).toBe(0)
  })

  test("a drain that dies mid-item leaves it queued, and the next drain after the lock lapses runs it again", async () => {
    const fakes = codiumFakes({ now: T0 })
    const applied = recorder("test-service", {
      during: () => {
        if (applied.length === 1) fakes.store.down = true
      },
    })
    await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "owner" }, T0)
    // The store goes away right after the provisioner's work, before the drain records it.
    await expect(drainScoped({ fetcher: fakes.fetcher, now: T0 })).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
    fakes.store.down = false
    expect(queued(fakes)).toContain(`test-service:${ACCOUNT}:1`)
    expect(fakes.store.get(provKey("test-service", ACCOUNT))).toBeUndefined()
    // Its lock could not be given back, so nothing runs until it lapses; then the work runs again (it is idempotent).
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, busy: true })
    fakes.clock.advance(50_000 + 30_000 + 1)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: fakes.clock.now })).toMatchObject({ applied: 1 })
    expect(applied.map((t) => t.to.version)).toEqual([1, 1])
    expect(fakes.store.get(provKey("test-service", ACCOUNT))).toBe("1")
    expect(queued(fakes)).toEqual([])
  })

  test("stops when its time is up, its item limit is reached or its lock is lost, and leaves the rest queued", async () => {
    const fakes = codiumFakes({ now: T0 })
    const ran: string[] = []
    let mode: "lose-lock" | "slow" | "plain" = "lose-lock"
    handle("pool-ramp", async (action) => {
      ran.push(action.key)
      if (mode === "lose-lock") fakes.store.remove(codiumKey("outbox", "lock"))
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 60))
    })
    for (const [index, key] of ["sub_1", "sub_2", "sub_3", "sub_4"].entries())
      await enqueueAction("pool-ramp", key, {}, T0 + index, fakes.fetcher, T0)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 10 })).toEqual({ ...NOTHING, applied: 1 })
    expect(queued(fakes)).toEqual(["pool-ramp:sub_2", "pool-ramp:sub_3", "pool-ramp:sub_4"])
    mode = "slow"
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 10, budgetMs: 25 })).toEqual({
      ...NOTHING,
      applied: 1,
    })
    mode = "plain"
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 + 10, limit: 1 })).toEqual({ ...NOTHING, applied: 1 })
    expect(ran).toEqual(["sub_1", "sub_2", "sub_3"])
    expect(queued(fakes)).toEqual(["pool-ramp:sub_4"])
  })

  test("a record that cannot be read is a dead letter at once, and a member without a record is dropped", async () => {
    const fakes = codiumFakes({ now: T0 })
    fakes.store.set(itemKey("broken:1"), "not json")
    fakes.store.command(["ZADD", codiumKey("outbox"), T0, "broken:1"])
    fakes.store.command(["ZADD", codiumKey("outbox"), T0, "orphan:1"])
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, dead: 1, skipped: 1 })
    expect(dead(fakes)).toEqual(["broken:1"])
    expect(queued(fakes)).toEqual([])
    // Without owner alerts configured, no alert is queued.
    expect(fakes.store.keys().filter((key) => key.includes("owner-alert"))).toEqual([])
  })
})

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("enqueueAction and action handlers", () => {
  test("scoped action registries isolate identical kinds while production still rejects duplicates", () => {
    const first = createActionRegistry()
    const second = createActionRegistry()
    const a = async () => {}
    const b = async () => {}
    first.register("pool-ramp", a)
    second.register("pool-ramp", b)
    expect(first.get("pool-ramp")).toBe(a)
    expect(second.get("pool-ramp")).toBe(b)
    expect(() => first.register("pool-ramp", b)).toThrow("already has a handler")
    expect(() => registerAction("reconcile", a)).toThrow("already has a handler")
  })

  test("one item per kind and key: the latest payload, the earliest due time, off the dead letters", async () => {
    const fakes = codiumFakes({ now: T0 })
    expect(ACTION_KINDS).toEqual([
      "reconcile",
      "supersede",
      "carry-trueup",
      "purchase-confirmation",
      "finalize-renewal",
      "pool-ramp",
      "pause-collection",
      "debit-apply",
      "model-settle",
    ])
    const id = "finalize-renewal:in_renewal"
    await enqueueAction("finalize-renewal", "in_renewal", { try: 1 }, T0 + HOUR, fakes.fetcher, T0)
    expect(score(fakes, id)).toBe(T0 + HOUR)
    await enqueueAction("finalize-renewal", "in_renewal", { try: 2 }, T0 + 2 * HOUR, fakes.fetcher, T0)
    expect(score(fakes, id)).toBe(T0 + HOUR)
    expect(record(fakes, id)).toEqual({
      v: 1,
      type: "action",
      kind: "finalize-renewal",
      key: "in_renewal",
      priority: false,
      payload: { try: 2 },
      attempts: 0,
      createdAt: T0,
    })
    await enqueueAction("finalize-renewal", "in_renewal", { try: 3 }, undefined, fakes.fetcher, T0 + 60_000)
    expect(score(fakes, id)).toBe(T0 + 60_000)

    // Work that stops money or access goes in the priority lane.
    await enqueueAction("reconcile", ACCOUNT, {}, undefined, fakes.fetcher, T0)
    await enqueueAction("pause-collection", "sub_paused", { behavior: "void" }, undefined, fakes.fetcher, T0)
    expect(score(fakes, `reconcile:${ACCOUNT}`)).toBe(T0 - PRIORITY_LEAD_MS)
    expect(score(fakes, "pause-collection:sub_paused")).toBe(T0 - PRIORITY_LEAD_MS)

    // Queuing a dead letter's work again takes it off the dead letters.
    fakes.store.command(["ZADD", codiumKey("outbox", "dead"), T0, "pool-ramp:sub_dead"])
    await enqueueAction("pool-ramp", "sub_dead", {}, undefined, fakes.fetcher, T0)
    expect(dead(fakes)).toEqual([])
    expect(queued(fakes)).toContain("pool-ramp:sub_dead")

    // Bad input is refused before anything is stored.
    const before = fakes.store.commands.length
    for (const [kind, key, at] of [
      ["unknown", "x", undefined],
      ["owner-alert", "x", undefined],
      ["reconcile", "", undefined],
      ["reconcile", "has space", undefined],
      ["reconcile", "a".repeat(201), undefined],
      ["reconcile", ACCOUNT, 1.5],
      ["reconcile", ACCOUNT, -1],
    ] as const)
      await expect(enqueueAction(kind as never, key, {}, at, fakes.fetcher, T0)).rejects.toMatchObject({
        code: "CODIUM_OUTBOX_INVALID",
      })
    expect(fakes.store.commands.length).toBe(before)
  })

  test("an item queued again while it runs is not lost; an action without a handler is retried", async () => {
    const fakes = codiumFakes({ now: T0 })
    const seen: unknown[] = []
    handle("pool-ramp", async (action, fetcher) => {
      seen.push(action.payload)
      if (seen.length === 1) await enqueueAction("pool-ramp", action.key, { step: 2 }, undefined, fetcher, action.now)
    })
    await enqueueAction("pool-ramp", ACCOUNT, { step: 1 }, undefined, fakes.fetcher, T0)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, applied: 2 })
    expect(seen).toEqual([{ step: 1 }, { step: 2 }])
    expect(queued(fakes)).toEqual([])

    // This scoped registry intentionally lacks pause-collection, regardless of production's installed handlers.
    await enqueueAction("pause-collection", ACCOUNT, {}, undefined, fakes.fetcher, T0)
    expect(await drainScoped({ fetcher: fakes.fetcher, now: T0 })).toEqual({ ...NOTHING, retried: 1 })
    expect(record(fakes, `pause-collection:${ACCOUNT}`)).toMatchObject({ attempts: 1 })
    expect(record(fakes, `pause-collection:${ACCOUNT}`).error).toStartWith("CODIUM_OUTBOX_NO_HANDLER")

    // One handler per kind, only for listed kinds; one provisioner per id, with a valid id.
    expect(() => registerAction("reconcile", async () => {})).toThrow()
    expect(() => registerAction("owner-alert" as never, async () => {})).toThrow()
    const quiet = { configured: () => true, apply: async () => {} }
    expect(() => registerProvisioner({ id: "github-runs", ...quiet })).toThrow()
    expect(() => registerProvisioner({ id: "Not An Id", ...quiet })).toThrow()
  })

  test("a queued reconcile reads Stripe again (source outbox), and its snapshot's own work drains with it", async () => {
    const fixture = loadStripeFixture("active-paid")
    const now = fixture.now * 1000
    const fakes = codiumFakes({ now })
    fakes.stripe.load(fixture.objects)
    fakes.store.set(codiumKey("account", fixture.accountId), JSON.stringify(fixture.account))
    // A hint that is not one reconcile knows is ignored.
    await enqueueAction("reconcile", fixture.accountId, { hint: { kind: "nonsense" } }, undefined, fakes.fetcher, now)
    expect(await drainScoped({ fetcher: fakes.fetcher, now })).toEqual({ ...NOTHING, applied: 2 })
    const snapshot = await readSnapshot(fixture.accountId, fakes.fetcher)
    expect(snapshot).toMatchObject({ state: "active", plan: "vector-10", version: 1, source: "outbox" })
    expect(fakes.store.get(provKey("github-runs", fixture.accountId))).toBe("1")
    expect(queued(fakes)).toEqual([])

    // debit-apply converges the account's key through the lease; with nothing pending it is done at once.
    const hash = (await readModelPlanAccount(fixture.accountId, fakes.fetcher))?.key?.hash
    expect(hash).toBeString()
    await enqueueAction("debit-apply", `${fixture.accountId}:${hash}`, {}, undefined, fakes.fetcher, now)
    await enqueueAction("debit-apply", `${fixture.accountId}:replaced_key`, {}, undefined, fakes.fetcher, now)
    expect(await drainScoped({ fetcher: fakes.fetcher, now })).toEqual({ ...NOTHING, applied: 2 })
  })
})

// ── The provisioners ───────────────────────────────────────────────────────────────────────────────────────────────

describe("github-runs", () => {
  test("turns revokedBefore into a mark run-token checks read, and only ever moves it forward", async () => {
    const fakes = codiumFakes({ now: T0 })
    await change(fakes.fetcher, ACCOUNT, {}, T0)
    await drainScoped({ fetcher: fakes.fetcher, now: T0 })
    // Nothing is revoked while the account is active, and nothing is written.
    expect(fakes.store.get(runTokensRevokedKey(ACCOUNT))).toBeUndefined()
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBeUndefined()
    expect(await runTokenRevoked(ACCOUNT, T0, fakes.fetcher)).toBe(false)

    const frozen = await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "disputed" }, T0 + HOUR)
    expect(frozen.revokedBefore).toBe(T0 + HOUR)
    await drainScoped({ fetcher: fakes.fetcher, now: T0 + HOUR })
    expect(runTokensRevokedKey(ACCOUNT)).toBe(`vector:codium:test:runs:revoked-before:${ACCOUNT}`)
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(T0 + HOUR)
    expect(await runTokenRevoked(ACCOUNT, T0 + HOUR - 1, fakes.fetcher)).toBe(true)
    expect(await runTokenRevoked(ACCOUNT, T0 + HOUR, fakes.fetcher)).toBe(false)
    expect(fakes.store.expires.get(runTokensRevokedKey(ACCOUNT))).toBe(fakes.clock.now + RUN_TOKEN_REVOCATION_KEEP_MS)

    // A won dispute keeps the mark: tokens issued before the freeze stay revoked.
    const back = await change(fakes.fetcher, ACCOUNT, {}, T0 + 2 * HOUR)
    expect(back.revokedBefore).toBe(T0 + HOUR)
    await drainScoped({ fetcher: fakes.fetcher, now: T0 + 2 * HOUR })
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(T0 + HOUR)
    // Whatever order work arrives in, the mark never moves back.
    await githubRuns.apply({ account: ACCOUNT, to: { ...frozen, revokedBefore: T0 }, cause: "disputed" }, fakes.fetcher)
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(T0 + HOUR)
    // An unreadable mark fails closed.
    fakes.store.set(runTokensRevokedKey(ACCOUNT), "unreadable")
    await expect(runTokenRevoked(ACCOUNT, T0, fakes.fetcher)).rejects.toMatchObject({
      code: "CODIUM_OUTBOX_UNAVAILABLE",
    })
  })
})

describe("owner-notify", () => {
  test("tells the owner about holds, risk endings and releases, by account id only, once per version", async () => {
    environment(OWNER_ALERTS)
    const fakes = codiumFakes({ now: T0 })
    let now = T0
    const step = async (overrides: Partial<SnapshotFacts>) => {
      now += HOUR
      const snapshot = await change(fakes.fetcher, ACCOUNT, overrides, now)
      await drainScoped({ fetcher: fakes.fetcher, now })
      return snapshot
    }
    await step({})
    const held = await step({ state: "frozen", reason: "disputed" })
    await step({})
    await step({ state: "frozen", reason: "owner" })
    await step({ state: "ended", reason: "disputed" })
    await step({ state: "ended", reason: "canceled" })
    await step({ state: "ended", reason: "refunded" })
    await step({ cancelAtPeriodEnd: true })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual([
      "Vector Codium: an account is on hold (disputed)",
      "Vector Codium: an account is no longer on hold",
      "Vector Codium: an account is on hold (owner)",
      "Vector Codium: an account ended (disputed)",
      "Vector Codium: an account ended (refunded)",
    ])
    for (const mail of fakes.mail.sent) {
      expect(mail.to).toBe("owner@example.invalid")
      expect(mail.text).toContain(`Account: ${ACCOUNT}`)
      expect(mail.text).not.toMatch(/\$|@|usd|cents|credit/i)
    }
    expect(fakes.mail.sent[0]!.text).toContain("State: active -> frozen (disputed)")

    // Applying the same version again (a retry, a re-queue) never sends twice.
    await ownerNotify.apply({ account: ACCOUNT, to: held, cause: "disputed" }, fakes.fetcher)
    expect(fakes.mail.sent).toHaveLength(5)

    // A send that fails is tried again by the outbox.
    fakes.mail.fail = true
    now += HOUR
    await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "early_fraud_warning" }, now)
    expect(await drainScoped({ fetcher: fakes.fetcher, now })).toEqual({ ...NOTHING, applied: 1, retried: 1 })
    fakes.mail.fail = false
    expect(await drainScoped({ fetcher: fakes.fetcher, now: now + outboxBackoffMs(1) })).toEqual({
      ...NOTHING,
      applied: 1,
    })
    expect(fakes.mail.sent.at(-1)?.subject).toBe("Vector Codium: an account is on hold (early_fraud_warning)")
  })

  test("says nothing about payments, renewals, upgrades or cancellations", () => {
    const base = buildSnapshot(facts(ACCOUNT), undefined, T0)
    const next = (overrides: Partial<SnapshotFacts>) => buildSnapshot(facts(ACCOUNT, overrides), base, T0 + HOUR)
    const quiet: [EntitlementSnapshot | undefined, EntitlementSnapshot][] = [
      [undefined, base],
      [base, next({ plan: "vector-200" })],
      [base, next({ state: "paused", reason: "payment_failed" })],
      [base, next({ state: "renewing" })],
      [base, next({ state: "ended", reason: "canceled" })],
      [base, next({ state: "ended", reason: "closing" })],
      [base, next({ cancelAtPeriodEnd: true })],
    ]
    for (const [from, to] of quiet)
      expect(ownerNotice({ account: ACCOUNT, ...(from ? { from } : {}), to, cause: "renewal" })).toBeUndefined()
  })
})

// ── The cron ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the outbox cron", () => {
  async function call(fetcher: typeof fetch, method = "GET", authorization?: string) {
    const request = { method, headers: authorization ? { authorization } : {} } as unknown as ApiRequest
    let body = ""
    const response = {
      statusCode: 200,
      setHeader: () => {},
      end: (value?: string) => {
        body = String(value ?? "")
      },
    } as unknown as ApiResponse
    await outboxCron(request, response, fetcher)
    return { status: response.statusCode, body: JSON.parse(body) as Record<string, unknown> }
  }

  test("runs every minute with CRON_SECRET only, does nothing without a Stripe key, and answers counts only", async () => {
    const config = await Bun.file(new URL("../vercel.json", import.meta.url)).json()
    expect(config.crons).toContainEqual({ path: "/api/model-plans/outbox", schedule: "* * * * *" })

    environment({ CRON_SECRET: "cron-fixture-secret" })
    const fakes = codiumFakes()
    expect((await call(fakes.fetcher)).status).toBe(401)
    expect((await call(fakes.fetcher, "GET", "Bearer wrong-secret-value")).status).toBe(401)
    expect((await call(fakes.fetcher, "POST", "Bearer cron-fixture-secret")).status).toBe(405)
    expect(fakes.store.commands).toEqual([])

    await change(fakes.fetcher, ACCOUNT, { state: "frozen", reason: "disputed" }, fakes.clock.now)
    const answer = await call(fakes.fetcher, "GET", "Bearer cron-fixture-secret")
    expect(answer).toEqual({
      status: 200,
      // The revocation, A11 switch-generation scan and its indexed account collection check each complete.
      body: { enabled: true, outbox: { ...NOTHING, applied: 3 }, debits: { applied: 0, retried: 0 } },
    })
    expect(await runTokensRevokedBefore(ACCOUNT, fakes.fetcher)).toBe(fakes.clock.now)

    environment({ CRON_SECRET: "cron-fixture-secret", STRIPE_SECRET_KEY: undefined })
    const before = fakes.store.commands.length
    expect(await call(fakes.fetcher, "GET", "Bearer cron-fixture-secret")).toEqual({
      status: 200,
      body: { enabled: false },
    })
    expect(fakes.store.commands.length).toBe(before)
  })
})

// ── The scripts on a real Valkey (CI) ──────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the outbox's Lua on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const mail: { subject: string; text: string }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input) === "https://api.resend.com/emails") {
      mail.push(JSON.parse(String(init?.body)))
      return Response.json({ id: "email_valkey" })
    }
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  const redis = (...command: (string | number)[]) => client!.send(String(command[0]), command.slice(1).map(String))
  const outbox = codiumKey("outbox")
  const deadLetters = codiumKey("outbox", "dead")
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
    mail.length = 0
  })

  test("ENQUEUE, FINISH, RETRY and RAISE", async () => {
    const { ENQUEUE, FINISH, RETRY, RAISE } = OUTBOX_SCRIPTS
    // ENQUEUE keeps the earlier due time, replaces the record, and leaves a waiting item alone in 'keep' mode.
    expect(await redis("EVAL", ENQUEUE, 3, outbox, itemKey("a:1"), deadLetters, "a:1", "r1", 200, "replace")).toBe(1)
    expect(await redis("EVAL", ENQUEUE, 3, outbox, itemKey("a:1"), deadLetters, "a:1", "r2", 300, "replace")).toBe(1)
    expect(Number(await redis("ZSCORE", outbox, "a:1"))).toBe(200)
    expect(await redis("GET", itemKey("a:1"))).toBe("r2")
    expect(await redis("EVAL", ENQUEUE, 3, outbox, itemKey("a:1"), deadLetters, "a:1", "r3", 100, "keep")).toBe(0)
    expect(await redis("GET", itemKey("a:1"))).toBe("r2")
    await redis("ZADD", deadLetters, 1, "b:1")
    expect(await redis("EVAL", ENQUEUE, 3, outbox, itemKey("b:1"), deadLetters, "b:1", "rb", -5, "keep")).toBe(1)
    expect(await redis("ZRANGE", deadLetters, 0, -1)).toEqual([])
    expect(Number(await redis("ZSCORE", outbox, "b:1"))).toBe(-5)

    // FINISH removes only what the drain read, and raises the applied version, never lowering it.
    await redis("EVAL", FINISH, 3, outbox, itemKey("a:1"), provKey("p", "x"), "a:1", "stale", 3)
    expect(await redis("GET", itemKey("a:1"))).toBe("r2")
    expect(await redis("GET", provKey("p", "x"))).toBe("3")
    await redis("EVAL", FINISH, 3, outbox, itemKey("a:1"), provKey("p", "x"), "a:1", "r2", 2)
    expect(await redis("GET", itemKey("a:1"))).toBeNull()
    expect(await redis("ZSCORE", outbox, "a:1")).toBeNull()
    expect(await redis("GET", provKey("p", "x"))).toBe("3")
    await redis("EVAL", FINISH, 2, outbox, itemKey("b:1"), "b:1", "rb", 0)
    expect(await redis("ZRANGE", outbox, 0, -1)).toEqual([])

    // RETRY reschedules, or buries with an alert queued in the same step, and drops dead letters past their keep.
    await redis("EVAL", ENQUEUE, 3, outbox, itemKey("c:1"), deadLetters, "c:1", "rc", 10, "replace")
    expect(await redis("EVAL", RETRY, 3, outbox, itemKey("c:1"), deadLetters, "c:1", "other", "x", 99, "0")).toBe(0)
    expect(await redis("EVAL", RETRY, 3, outbox, itemKey("c:1"), deadLetters, "c:1", "rc", "rc2", 50, "0")).toBe(1)
    expect(Number(await redis("ZSCORE", outbox, "c:1"))).toBe(50)
    await redis("ZADD", deadLetters, 5, "old:1")
    const args = ["c:1", "rc2", "rc3", 1000, "1", 60_000, 500, "alert:c", "ra", 1000]
    expect(await redis("EVAL", RETRY, 4, outbox, itemKey("c:1"), deadLetters, itemKey("alert:c"), ...args)).toBe(2)
    expect(await redis("ZRANGE", deadLetters, 0, -1)).toEqual(["c:1"])
    expect(await redis("ZRANGE", outbox, 0, -1)).toEqual(["alert:c"])
    expect(await redis("GET", itemKey("c:1"))).toBe("rc3")
    expect(Number(await redis("PTTL", itemKey("c:1")))).toBeGreaterThan(50_000)
    expect(await redis("GET", itemKey("alert:c"))).toBe("ra")

    // RAISE only moves forward.
    expect(await redis("EVAL", RAISE, 1, "raise-test", 20, 60_000)).toBe(1)
    expect(await redis("EVAL", RAISE, 1, "raise-test", 10, 60_000)).toBe(0)
    expect(await redis("GET", "raise-test")).toBe("20")
  })

  test("a drain on Valkey: the priority lane, a dead letter with its alert, and the sweep's re-enqueue", async () => {
    environment(OWNER_ALERTS)
    let failing = true
    const applied = recorder("valkey-service", { fail: () => failing })
    const now = Date.now()
    await change(fetcher, "valkey-active", {}, now)
    const frozen = await change(fetcher, "valkey-frozen", { state: "frozen", reason: "disputed" }, now)
    expect(Number(await redis("ZSCORE", outbox, "github-runs:valkey-frozen:1"))).toBe(now - PRIORITY_LEAD_MS)
    expect(await drainScoped({ fetcher, now })).toMatchObject({ applied: 4, retried: 2, busy: false })
    expect(await runTokensRevokedBefore("valkey-frozen", fetcher)).toBe(frozen.revokedBefore!)
    expect(await redis("GET", codiumKey("outbox", "lock"))).toBeNull()
    expect(mail.map((sent) => sent.subject)).toEqual(["Vector Codium: an account is on hold (disputed)"])

    let at = now
    for (let attempt = 2; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      at += HOUR
      await drainScoped({ fetcher, now: at })
    }
    expect((await redis("ZRANGE", deadLetters, 0, -1)) as string[]).toEqual([
      "valkey-service:valkey-active:1",
      "valkey-service:valkey-frozen:1",
    ])
    expect(mail.filter((sent) => sent.subject === "Vector Codium: an outbox job was set aside")).toHaveLength(2)

    failing = false
    expect(await requeueBehindProvisioners("valkey-frozen", fetcher, at)).toBe(1)
    expect(await requeueBehindProvisioners("valkey-active", fetcher, at)).toBe(1)
    expect(await drainScoped({ fetcher, now: at })).toMatchObject({ applied: 2 })
    expect(applied.map((t) => t.account).sort()).toEqual(["valkey-active", "valkey-frozen"])
    expect(await redis("GET", provKey("valkey-service", "valkey-frozen"))).toBe("1")
    expect(await redis("ZRANGE", deadLetters, 0, -1)).toEqual([])
  })
})
