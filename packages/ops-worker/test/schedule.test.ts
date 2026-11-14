import { describe, expect, test } from "bun:test"
import { OPS_LIMITS } from "../src/limits"
import { ACCOUNT, DAY, Harness, NOW, SHA, planFor } from "./fakes"

// WP A46: one alarm at the next due time, always at least 25 s ahead, with wakes capped per hour; a pushed plan's
// validUntil stops everything by itself; the Worker-level kill flag stops everything and fails closed; the ops guard can
// hold one account.

const HOST = "status.vector-fixture.com"
const HOME = `https://${HOST}/`

async function setup(plan = planFor("vector-200")) {
  const harness = new Harness()
  await harness.plan(plan)
  await harness.config([HOST], [{ id: "home", url: HOME }])
  return harness
}

describe("alarms", () => {
  test("no work, no alarm: a plan alone or monitors alone schedule nothing", async () => {
    const plain = new Harness()
    await plain.plan(planFor("vector-200"))
    expect(plain.state.alarm).toBeNull()
    const unplanned = new Harness()
    await unplanned.config([HOST], [{ id: "home", url: HOME }])
    expect(unplanned.state.alarm).toBeNull()
    const noChecks = new Harness()
    await noChecks.plan(planFor("vector-200", { onCall: null }))
    await noChecks.config([HOST], [{ id: "home", url: HOME }])
    expect(noChecks.state.alarm).toBeNull()
  })

  test("the alarm is always at least 25 s ahead, even when work is already due", async () => {
    const harness = await setup()
    expect(harness.state.alarm).toBe(NOW + OPS_LIMITS.alarmMinAheadMs)
    for (let wake = 0; wake < 50; wake++) {
      const before = harness.clock.now
      await harness.fire()
      expect(harness.state.alarm! - harness.clock.now).toBeGreaterThanOrEqual(OPS_LIMITS.alarmMinAheadMs)
      expect(harness.clock.now).toBeGreaterThan(before)
    }
  })

  test("a wake does everything due within the next 25 s, so close work shares a wake", async () => {
    const harness = await setup()
    await harness.fire()
    // A release watched alongside the checks: its 30 s rounds and the 60 s checks fall into one wake when close.
    await harness.call("release", {
      account: ACCOUNT,
      repositoryId: 7,
      environment: "production",
      sha: SHA("a"),
      deployment: "1001",
      at: harness.clock.now,
      urls: [HOME],
    })
    const probedBefore = harness.net.probes(HOME)
    const fired = await harness.runFor(60 * 60_000)
    // 60 check rounds and 120 watch rounds in the hour, in at most 120 wakes.
    expect(fired).toBeLessThanOrEqual(121)
    // The check and the watch share each URL's probe: one request per wake.
    expect(harness.net.probes(HOME) - probedBefore).toBeLessThanOrEqual(fired)
  })

  test("wakes are capped per clock hour; past the cap the next alarm waits for the next hour", async () => {
    const harness = await setup()
    await harness.fire()
    const run = JSON.parse(harness.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'run'")[0]!.v)
    const hour = Math.floor(harness.clock.now / 3_600_000) * 3_600_000
    run.wakes = { hour, count: OPS_LIMITS.maxWakesPerHour }
    harness.state.sql.exec("UPDATE meta SET v = ? WHERE k = 'run'", JSON.stringify(run))
    await harness.plan(planFor("vector-200", { version: 2 }))
    expect(harness.state.alarm).toBe(hour + 3_600_000)
    expect(OPS_LIMITS.maxWakesPerHour).toBeGreaterThanOrEqual(120)
  })
})

describe("validUntil", () => {
  test("checks stop by themselves once the pushed plan's validUntil passes, and the alarm goes away", async () => {
    const harness = await setup(planFor("vector-200", { validUntil: NOW + 10 * 60_000 }))
    await harness.runFor(10 * 60_000 - 1)
    const before = harness.net.probes(HOME)
    expect(before).toBeGreaterThanOrEqual(9)
    await harness.runFor(60 * 60_000)
    expect(harness.net.probes(HOME)).toBe(before)
    expect(harness.state.alarm).toBeNull()
    expect((await harness.state_()).body.active).toBe(false)
  })

  test("a running watch is stopped when the plan lapses, with no verdict", async () => {
    const harness = await setup(planFor("vector-200", { validUntil: NOW + 5 * 60_000 }))
    await harness.release({ sha: SHA("b"), urls: [HOME] })
    await harness.runFor(10 * 60_000)
    expect(harness.rows<{ state: string }>("SELECT state FROM releases")).toEqual([{ state: "stopped" }])
    expect(harness.net.events()).toEqual([])
  })

  test("a newer plan starts checks again; an older plan (by version) is ignored", async () => {
    const harness = await setup(planFor("vector-200", { version: 5, validUntil: NOW + 60_000 }))
    await harness.runFor(5 * 60_000)
    const stale = await harness.plan(planFor("vector-200", { version: 4, validUntil: harness.clock.now + DAY }))
    expect(stale.body).toEqual({ applied: false, version: 5 })
    expect(harness.state.alarm).toBeNull()
    const fresh = await harness.plan(planFor("vector-200", { version: 6, validUntil: harness.clock.now + DAY }))
    expect(fresh.body).toEqual({ applied: true, version: 6 })
    expect(harness.state.alarm).not.toBeNull()
  })

  test("a plan valid further ahead than 40 days, or outside any plan's bounds, is refused", async () => {
    const harness = new Harness()
    expect((await harness.plan(planFor("vector-200", { validUntil: NOW + 41 * DAY }))).status).toBe(400)
    expect((await harness.plan(planFor("vector-200", { onCall: { urls: 11, intervalSec: 60 } }))).status).toBe(400)
    expect((await harness.plan(planFor("vector-200", { onCall: { urls: 5, intervalSec: 30 } }))).status).toBe(400)
    expect((await harness.plan(planFor("vector-200", { domains: 11 }))).status).toBe(400)
    expect(
      (await harness.plan(planFor("vector-200", { releaseGuard: { perDay: 10, watchMin: 121, paths: 5 } }))).status,
    ).toBe(400)
    expect(
      (await harness.plan(planFor("vector-200", { releaseGuard: { perDay: 10, watchMin: 30, paths: 6 } }))).status,
    ).toBe(400)
  })
})

describe("kill flag", () => {
  test("while set, a wake probes nothing, sends nothing and only re-reads the flag every 10 minutes", async () => {
    const harness = await setup()
    await harness.fire()
    const before = harness.net.requests.length
    harness.kv.values.set("kill", "1")
    await harness.fire()
    expect(harness.net.requests.length).toBe(before)
    expect(harness.state.alarm! - harness.clock.now).toBe(OPS_LIMITS.killRecheckMs)
    await harness.runFor(60 * 60_000)
    expect(harness.net.requests.length).toBe(before)
    harness.kv.values.delete("kill")
    await harness.runFor(15 * 60_000)
    expect(harness.net.probes(HOME)).toBeGreaterThan(1)
  })

  test("a flag that cannot be read counts as set", async () => {
    const harness = await setup()
    harness.kv.failing = true
    await harness.fire()
    expect(harness.net.requests).toEqual([])
    expect(harness.state.alarm! - harness.clock.now).toBe(OPS_LIMITS.killRecheckMs)
  })

  test("no release is watched while the Worker is off", async () => {
    const harness = await setup()
    harness.kv.values.set("kill", "1")
    expect((await harness.release({ sha: SHA("c"), urls: [HOME] })).body).toEqual({ accepted: false, reason: "off" })
  })
})

describe("suspend", () => {
  test("a held account runs nothing until released; updates are ordered by `at`", async () => {
    const harness = await setup()
    await harness.fire()
    const held = await harness.call("suspend", { account: ACCOUNT, suspended: true, reason: "guard", at: 10 })
    expect(held.body).toEqual({ applied: true, suspended: true })
    expect(harness.state.alarm).toBeNull()
    const late = await harness.call("suspend", { account: ACCOUNT, suspended: false, reason: "guard", at: 9 })
    expect(late.body).toEqual({ applied: false, suspended: true })
    expect((await harness.release({ sha: SHA("d"), urls: [HOME] })).body).toEqual({
      accepted: false,
      reason: "not-in-plan",
    })
    const before = harness.net.probes(HOME)
    await harness.runFor(30 * 60_000)
    expect(harness.net.probes(HOME)).toBe(before)
    await harness.call("suspend", { account: ACCOUNT, suspended: false, reason: "guard", at: 11 })
    await harness.runFor(5 * 60_000)
    expect(harness.net.probes(HOME)).toBeGreaterThan(before)
  })
})
