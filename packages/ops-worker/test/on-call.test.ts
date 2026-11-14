import { describe, expect, test } from "bun:test"
import { OPS_LIMITS } from "../src/limits"
import { Harness, NOW, html, planFor } from "./fakes"

// WP A46: On Call. Each verified URL is checked at the plan's interval (Max every 5 minutes, Ultra every minute), at most
// 6 probes in flight; two failures in a row make it down and send one report; storage keeps state changes and hourly
// totals only.

const HOST = "status.vector-fixture.com"
const url = (path: string) => `https://${HOST}/${path}`

async function ultra(paths: string[]) {
  const harness = new Harness()
  await harness.plan(planFor("vector-200"))
  await harness.config(
    [HOST],
    paths.map((path, index) => ({ id: `m${index}`, url: url(path) })),
  )
  return harness
}

describe("intervals per plan", () => {
  test("Max checks every 5 minutes and Ultra every minute, over an hour", async () => {
    for (const [id, expected] of [
      ["vector-100", 12],
      ["vector-200", 60],
    ] as const) {
      const harness = new Harness()
      await harness.plan(planFor(id))
      await harness.config([HOST], [{ id: "home", url: url("") }])
      await harness.runFor(60 * 60_000 - 1)
      const probes = harness.net.probes(url(""))
      expect({ id, probes }).toEqual({ id, probes: expected })
    }
  })

  test("an upgrade's shorter interval applies from now", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-100"))
    await harness.config([HOST], [{ id: "home", url: url("") }])
    await harness.runFor(30_000)
    expect(harness.net.probes(url(""))).toBe(1)
    await harness.plan(planFor("vector-200", { version: 2 }))
    expect(harness.state.alarm! - harness.clock.now).toBeLessThanOrEqual(60_000)
    await harness.runFor(10 * 60_000)
    expect(harness.net.probes(url(""))).toBeGreaterThanOrEqual(10)
  })

  test("monitors added later join the next round, so an account's checks share wakes", async () => {
    const harness = await ultra(["a"])
    await harness.runFor(40_000)
    harness.advance(10_000)
    await harness.config(
      [HOST],
      [
        { id: "m0", url: url("a") },
        { id: "m1", url: url("b") },
      ],
    )
    const fired = await harness.runFor(10 * 60_000)
    expect(fired).toBeLessThanOrEqual(11)
    expect(harness.net.probes(url("b"))).toBeGreaterThanOrEqual(9)
  })
})

describe("in-flight cap", () => {
  test("at most 6 probes run at once, however many URLs are due", async () => {
    const harness = await ultra(Array.from({ length: 10 }, (_, index) => `p${index}`))
    for (let index = 0; index < 10; index++)
      harness.net.sites.set(url(`p${index}`), async () => {
        await Bun.sleep(5)
        return new Response("ok")
      })
    await harness.fire()
    expect(harness.net.maxInFlight).toBe(OPS_LIMITS.probesInFlight)
    expect(OPS_LIMITS.probesInFlight).toBe(6)
    for (let index = 0; index < 10; index++) expect(harness.net.probes(url(`p${index}`))).toBe(1)
  })

  test("the plan's URL cap: only the first URLs on verified domains are checked", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-100"))
    const monitors = Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, url: url(`p${index}`) }))
    monitors.splice(1, 0, { id: "elsewhere", url: "https://unverified-site.com/" })
    await harness.config([HOST], monitors)
    await harness.fire()
    expect(harness.net.probes("https://unverified-site.com/")).toBe(0)
    expect([0, 1, 2, 3, 4, 5, 6].map((index) => harness.net.probes(url(`p${index}`)))).toEqual([1, 1, 1, 1, 1, 0, 0])
    const state = (await harness.state_()).body
    expect(state.monitors.find((monitor: { id: string }) => monitor.id === "elsewhere")).toMatchObject({
      probed: false,
      verified: false,
    })
  })

  test("the plan's domain cap: domains past it are not verified for this plan", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-100", { domains: 1 }))
    await harness.config(
      ["first-site.com", "second-site.com"],
      [
        { id: "a", url: "https://first-site.com/" },
        { id: "b", url: "https://second-site.com/" },
      ],
    )
    await harness.fire()
    expect(harness.net.probes("https://first-site.com/")).toBe(1)
    expect(harness.net.probes("https://second-site.com/")).toBe(0)
  })
})

describe("two failures in a row", () => {
  test("one failure sends nothing; the second makes the URL down and sends one report", async () => {
    const harness = await ultra(["health"])
    harness.net.sites.set(url("health"), () => new Response("boom", { status: 500 }))
    await harness.fire()
    expect(harness.net.events()).toEqual([])
    const firstFailure = harness.clock.now
    await harness.fire()
    expect(harness.net.events()).toEqual([
      expect.objectContaining({
        v: 1,
        kind: "monitor.down",
        monitor: "m0",
        since: firstFailure,
        reason: "status",
        status: 500,
      }),
    ])
    // Staying down sends nothing more.
    await harness.fire()
    await harness.fire()
    expect(harness.net.events()).toHaveLength(1)
  })

  test("inconclusive answers neither count nor break the run", async () => {
    const harness = await ultra(["health"])
    const answers = [
      new Response("x", { status: 500 }),
      new Response("x", { status: 403 }),
      html(503, "<div class='cf-chl'></div>"),
      new Response("x", { status: 429 }),
      new Response("x", { status: 401 }),
    ]
    harness.net.sites.set(url("health"), () => answers.shift() ?? new Response("x", { status: 502 }))
    for (let wake = 0; wake < 5; wake++) await harness.fire()
    expect(harness.net.events()).toEqual([])
    await harness.fire()
    expect(harness.net.events()).toEqual([
      expect.objectContaining({ kind: "monitor.down", reason: "status", status: 502 }),
    ])
  })

  test("a success between failures starts the count again; recovering sends one report", async () => {
    const harness = await ultra(["health"])
    const answers = [500, 200, 500, 200, 500, 500, 500, 200, 200]
    harness.net.sites.set(url("health"), () => new Response("x", { status: answers.shift() ?? 200 }))
    for (let wake = 0; wake < 4; wake++) await harness.fire()
    expect(harness.net.events()).toEqual([])
    await harness.fire()
    const downSince = harness.clock.now
    await harness.fire()
    await harness.fire()
    await harness.fire()
    expect(harness.net.events().map((event) => event.kind)).toEqual(["monitor.down", "monitor.up"])
    expect(harness.net.events()[1]).toMatchObject({ monitor: "m0", downSince })
  })

  test("a timeout, a network failure, a host with no address and a cross-domain redirect are failures", async () => {
    const harness = await ultra(["a", "b", "c"])
    harness.net.sites.set(url("a"), () => Promise.reject(new TypeError("Network connection lost.")))
    harness.net.sites.set(
      url("b"),
      () => new Response(null, { status: 302, headers: { location: "https://parked-domain.com/" } }),
    )
    harness.net.sites.set(url("c"), () => Promise.reject(new DOMException("timed out", "TimeoutError")))
    await harness.fire()
    await harness.fire()
    const reasons = harness.net
      .events()
      .map((event) => [event.monitor, event.reason])
      .sort()
    expect(reasons).toEqual([
      ["m0", "network"],
      ["m1", "redirect"],
      ["m2", "timeout"],
    ])
    const gone = new Harness()
    gone.net.dns.set(HOST, { status: 3 })
    await gone.plan(planFor("vector-200"))
    await gone.config([HOST], [{ id: "m0", url: url("") }])
    await gone.fire()
    await gone.fire()
    expect(gone.net.probes(url(""))).toBe(0)
    expect(gone.net.events()).toEqual([expect.objectContaining({ kind: "monitor.down", reason: "dns" })])
  })

  test("a host resolving to a private address is never probed and never reported down", async () => {
    const harness = new Harness()
    harness.net.dns.set(HOST, { A: ["104.16.132.229", "10.0.0.5"] })
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "m0", url: url("") }])
    for (let wake = 0; wake < 4; wake++) await harness.fire()
    expect(harness.net.probes(url(""))).toBe(0)
    expect(harness.net.events()).toEqual([])
    expect((await harness.state_()).body.monitors[0]).toMatchObject({ state: "unknown", reason: "address" })
  })

  test("DNS answers are reused for their TTL, so a host is not looked up on every check", async () => {
    const harness = await ultra(["a", "b"])
    await harness.runFor(10 * 60_000)
    // Two questions (A and AAAA) per lookup, at most once per 5 minutes for the one host.
    expect(harness.net.dnsQueries).toBeLessThanOrEqual(6)
    expect(harness.net.probes(url("a"))).toBeGreaterThanOrEqual(9)
  })
})

describe("storage: state changes and hourly totals only", () => {
  test("a day of checks leaves one row per change and one per monitor-hour", async () => {
    const harness = await ultra(["health"])
    let failing = false
    harness.net.sites.set(url("health"), () => new Response("x", { status: failing ? 500 : 200 }))
    await harness.runFor(3 * 60 * 60_000)
    failing = true
    await harness.runFor(10 * 60_000)
    failing = false
    await harness.runFor(21 * 60 * 60_000 - 10 * 60_000)
    const changes = harness.rows<{ state: string }>("SELECT state FROM changes ORDER BY at")
    expect(changes.map((row) => row.state)).toEqual(["up", "down", "up"])
    const hourly = harness.rows<{ hour: number; ok: number; failed: number }>(
      "SELECT hour, ok, failed FROM hourly ORDER BY hour",
    )
    expect(hourly.length).toBeGreaterThanOrEqual(23)
    expect(hourly.length).toBeLessThanOrEqual(24)
    expect(hourly.reduce((total, row) => total + row.failed, 0)).toBe(10)
    expect(new Set(hourly.map((row) => row.hour)).size).toBe(hourly.length)
    // Nothing else grows: no table holds a row per probe.
    const tables = harness
      .rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name)
    expect(tables.sort()).toEqual(["baselines", "changes", "hourly", "meta", "monitors", "outbox", "releases", "seen"])
    expect(harness.rows("SELECT * FROM outbox")).toEqual([])
    expect(harness.rows<{ k: string }>("SELECT k FROM meta ORDER BY k").map((row) => row.k)).toEqual([
      "account",
      "domains",
      "plan",
      "pruned_at",
      "run",
    ])
  })

  test("state answers each monitor, recent changes and hourly totals with no URL", async () => {
    const harness = await ultra(["health"])
    await harness.runFor(5 * 60_000)
    const state = (await harness.state_()).body
    expect(state.active).toBe(true)
    expect(state.monitors).toEqual([
      expect.objectContaining({ id: "m0", probed: true, verified: true, state: "up", reason: "status", status: 200 }),
    ])
    expect(state.changes).toEqual([expect.objectContaining({ monitor: "m0", state: "up" })])
    expect(state.hourly[0]).toMatchObject({ monitor: "m0", ok: expect.any(Number), failed: 0 })
    expect(JSON.stringify(state)).not.toContain(HOST)
  })

  test("changing a monitor's URL starts it over; removing one deletes its history", async () => {
    const harness = await ultra(["a"])
    await harness.runFor(2 * 60 * 60_000)
    expect(harness.rows("SELECT * FROM hourly WHERE monitor = 'm0'").length).toBeGreaterThan(0)
    await harness.config([HOST], [{ id: "m0", url: url("b") }])
    expect(harness.rows("SELECT * FROM hourly WHERE monitor = 'm0'")).toEqual([])
    expect((await harness.state_()).body.monitors[0]).toMatchObject({ id: "m0", state: "unknown" })
    await harness.runFor(5 * 60_000)
    await harness.config([HOST], [])
    expect(harness.rows("SELECT * FROM changes")).toEqual([])
    expect(harness.state.alarm).toBeNull()
  })

  test("state changes and totals older than 30 days are pruned", async () => {
    const harness = await ultra(["a"])
    await harness.runFor(2 * 60 * 60_000)
    const oldest = harness.rows<{ hour: number }>("SELECT min(hour) AS hour FROM hourly")[0]!.hour
    expect(oldest).toBeLessThan(NOW + 2 * 60 * 60_000)
    harness.clock.now += 31 * 24 * 60 * 60_000
    await harness.plan(planFor("vector-200", { version: 2, validUntil: harness.clock.now + 30 * 24 * 60 * 60_000 }))
    await harness.runFor(2 * 60 * 60_000)
    expect(harness.rows<{ hour: number }>("SELECT min(hour) AS hour FROM hourly")[0]!.hour).toBeGreaterThan(oldest)
  })
})
