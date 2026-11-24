import { describe, expect, test } from "bun:test"
import { OPS_LIMITS } from "../src/limits"
import { passedBaseline, newWatch, regression, stepWatch, watchWindow } from "../src/release-watch"
import { DAY, Harness, NOW, SHA, planFor } from "./fakes"

// WP A46: Release Guard's watch. It waits 60 s after the deployment reported success, compares with the last good
// release every 30 s for the plan's watch length, ends when a newer deployment arrives, and dedupes by (repository,
// environment, sha). A path that passed on the last good release and fails twice in a row is a regression.

const HOST = "shop.vector-fixture.com"
const A = `https://${HOST}/`
const B = `https://${HOST}/checkout`
const WATCH_MS = planFor("vector-100").releaseGuard!.watchMin * 60_000

async function maxPlan() {
  const harness = new Harness()
  await harness.plan(planFor("vector-100"))
  await harness.config([HOST], [])
  return harness
}

/** Watches one release to its end with every path answering 200. */
async function goodRelease(harness: Harness, sha: string) {
  expect((await harness.release({ sha, urls: [A, B] })).body).toMatchObject({ accepted: true })
  await harness.runFor(WATCH_MS + 2 * 60_000)
}

describe("the window", () => {
  test("a watch starts 60 s after success, at once for a late report, never more than 60 s ahead", () => {
    expect(watchWindow(NOW, NOW, 30)).toEqual({ startAt: NOW + 60_000, endAt: NOW + 60_000 + 30 * 60_000 })
    expect(watchWindow(NOW - 5 * 60_000, NOW, 30).startAt).toBe(NOW)
    expect(watchWindow(NOW + 10 * 60_000, NOW, 60)).toEqual({ startAt: NOW + 60_000, endAt: NOW + 61 * 60_000 })
    expect(OPS_LIMITS.releaseSettleMs).toBe(60_000)
    expect(OPS_LIMITS.releaseStepMs).toBe(30_000)
  })

  test("nothing is probed before the 60 s are up, then every 30 s for the plan's watch length", async () => {
    const harness = await maxPlan()
    const accepted = (await harness.release({ sha: SHA("1"), urls: [A] })).body
    expect(accepted).toEqual({ accepted: true, startAt: NOW + 60_000, endAt: NOW + 60_000 + WATCH_MS })
    expect(harness.state.alarm).toBe(NOW + 60_000)
    await harness.runFor(59_999)
    expect(harness.net.probes(A)).toBe(0)
    await harness.runFor(WATCH_MS + 60_000)
    expect(harness.net.probes(A)).toBe(WATCH_MS / 30_000)
    expect(harness.net.events()).toEqual([
      expect.objectContaining({ kind: "release.passed", sha: SHA("1"), repositoryId: 42 }),
    ])
    expect(harness.state.alarm).toBeNull()
  })
})

describe("the first round", () => {
  test("is never pulled early into a check's wake", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "home", url: `https://${HOST}/home` }])
    await harness.fire()
    expect(harness.clock.now).toBe(NOW + 25_000)
    // Success at NOW + 10 s: the watch starts at NOW + 70 s, 10 s after the next check's wake at NOW + 60 s.
    expect((await harness.release({ sha: SHA("1"), at: NOW + 10_000, urls: [A] })).body).toMatchObject({
      accepted: true,
      startAt: NOW + 70_000,
    })
    await harness.fire()
    expect(harness.clock.now).toBe(NOW + 60_000)
    expect(harness.net.probes(A)).toBe(0)
    await harness.fire()
    expect(harness.clock.now).toBeGreaterThanOrEqual(NOW + 70_000)
    expect(harness.net.probes(A)).toBe(1)
  })
})

describe("regressions", () => {
  test("a path that passed on the last good release and fails twice in a row opens one regression report", async () => {
    const harness = await maxPlan()
    await goodRelease(harness, SHA("1"))
    harness.net.sites.set(B, () => new Response("broken", { status: 500 }))
    await harness.release({ sha: SHA("2"), urls: [A, B] })
    await harness.runFor(60_000)
    expect(harness.net.events().filter((event) => event.kind === "release.regressed")).toEqual([])
    await harness.runFor(30_000)
    const regressed = harness.net.events().filter((event) => event.kind === "release.regressed")
    expect(regressed).toEqual([
      expect.objectContaining({
        sha: SHA("2"),
        goodSha: SHA("1"),
        environment: "production",
        failing: [{ url: B, reason: "status", status: 500 }],
      }),
    ])
    // The watch ended: no more rounds, no second report.
    const probes = harness.net.probes(B)
    await harness.runFor(WATCH_MS)
    expect(harness.net.probes(B)).toBe(probes)
    expect(harness.net.events().filter((event) => event.kind === "release.regressed")).toHaveLength(1)
    expect(harness.rows("SELECT sha, state FROM releases ORDER BY at, sha")).toEqual([
      { sha: SHA("1"), state: "passed" },
      { sha: SHA("2"), state: "regressed" },
    ])
    // The last good release stays the baseline.
    expect(harness.rows("SELECT sha FROM baselines")).toEqual([{ sha: SHA("1") }])
  })

  test("one failure, or failures broken by a success, are not a regression; inconclusive answers do not count", async () => {
    const harness = await maxPlan()
    await goodRelease(harness, SHA("1"))
    const answers = [500, 200, 500, 403, 429, 200, 500, 401]
    harness.net.sites.set(B, () => new Response("x", { status: answers.shift() ?? 200 }))
    await harness.release({ sha: SHA("2"), urls: [A, B] })
    await harness.runFor(WATCH_MS + 2 * 60_000)
    expect(harness.net.events().map((event) => event.kind)).toEqual(["release.passed", "release.passed"])
  })

  test("the first release watched has no baseline, so nothing can regress; it becomes the baseline", async () => {
    const harness = await maxPlan()
    harness.net.sites.set(B, () => new Response("x", { status: 500 }))
    await harness.release({ sha: SHA("1"), urls: [A, B] })
    await harness.runFor(WATCH_MS + 2 * 60_000)
    expect(harness.net.events().map((event) => event.kind)).toEqual(["release.passed"])
    expect(harness.rows("SELECT sha, ok FROM baselines")).toEqual([{ sha: SHA("1"), ok: JSON.stringify([A]) }])
    // B never passed, so it cannot regress on the next release either.
    await harness.release({ sha: SHA("2"), urls: [A, B] })
    await harness.runFor(WATCH_MS + 2 * 60_000)
    expect(harness.net.events().map((event) => event.kind)).toEqual(["release.passed", "release.passed"])
  })

  test("a watch with no conclusive answer gives no verdict and leaves the baseline alone", async () => {
    const harness = await maxPlan()
    await goodRelease(harness, SHA("1"))
    harness.net.sites.set(A, () => new Response("x", { status: 403 }))
    harness.net.sites.set(B, () => new Response("x", { status: 429 }))
    await harness.release({ sha: SHA("2"), urls: [A, B] })
    await harness.runFor(WATCH_MS + 2 * 60_000)
    expect(harness.rows("SELECT sha, state FROM releases ORDER BY at, sha")).toEqual([
      { sha: SHA("1"), state: "passed" },
      { sha: SHA("2"), state: "stopped" },
    ])
    expect(harness.rows("SELECT sha FROM baselines")).toEqual([{ sha: SHA("1") }])
  })

  test("pure rules: regression needs a baseline pass and two failures; a pass keeps earlier passes it could not check", () => {
    const watch = newWatch(
      { repositoryId: 1, environment: "production", sha: SHA("2"), deployment: "9", at: NOW, urls: [A, B] },
      { sha: SHA("1"), ok: [A, B] },
      30,
      NOW,
    )
    const fail = { outcome: "fail" as const, reason: "timeout" as const, ms: 8000 }
    const unknown = { outcome: "inconclusive" as const, reason: "auth" as const, status: 403, ms: 5 }
    stepWatch(watch, (url) => (url === A ? fail : unknown), NOW + 60_000)
    expect(regression(watch)).toEqual([])
    stepWatch(watch, (url) => (url === A ? fail : unknown), NOW + 90_000)
    expect(regression(watch)).toEqual([{ url: A, reason: "timeout" }])
    expect(passedBaseline({ ...watch, last: { [A]: "ok" } })).toEqual({ sha: SHA("2"), ok: [A, B] })
    expect(passedBaseline({ ...watch, last: { [A]: "ok", [B]: "fail" } })).toEqual({ sha: SHA("2"), ok: [A] })
  })
})

describe("intake", () => {
  test("a newer deployment ends the running watch; the same sha again is a duplicate", async () => {
    const harness = await maxPlan()
    await harness.release({ sha: SHA("1"), urls: [A] })
    await harness.runFor(2 * 60_000)
    expect((await harness.release({ sha: SHA("1"), urls: [A] })).body).toEqual({ accepted: false, reason: "duplicate" })
    expect((await harness.release({ sha: SHA("2"), urls: [A] })).body).toMatchObject({ accepted: true })
    expect(harness.rows("SELECT sha, state FROM releases ORDER BY at, sha")).toEqual([
      { sha: SHA("1"), state: "superseded" },
      { sha: SHA("2"), state: "watching" },
    ])
    const state = (await harness.state_()).body
    expect(state.watches).toEqual([expect.objectContaining({ sha: SHA("2") })])
  })

  test("environments are compared without case, as GitHub and the API compare them", async () => {
    const harness = await maxPlan()
    expect((await harness.release({ sha: SHA("1"), environment: "Production", urls: [A] })).body).toMatchObject({
      accepted: true,
    })
    expect((await harness.release({ sha: SHA("1"), environment: "production", urls: [A] })).body).toEqual({
      accepted: false,
      reason: "duplicate",
    })
    harness.advance(1_000)
    expect((await harness.release({ sha: SHA("2"), environment: "PRODUCTION", urls: [A] })).body).toMatchObject({
      accepted: true,
    })
    expect(harness.rows("SELECT environment, sha, state FROM releases ORDER BY at, sha")).toEqual([
      { environment: "production", sha: SHA("1"), state: "superseded" },
      { environment: "production", sha: SHA("2"), state: "watching" },
    ])
    expect((await harness.state_()).body.watches).toEqual([
      expect.objectContaining({ environment: "production", sha: SHA("2") }),
    ])
  })

  test("the length is checked on the name as sent: a 255-unit name with İ, longer once folded, is watched", async () => {
    // The API accepts 255 UTF-16 units on the raw name (ops-settings.ts environmentName); folding turns İ into two.
    const harness = await maxPlan()
    const environment = `İ${"a".repeat(254)}`
    expect([environment.length, environment.toLowerCase().length]).toEqual([255, 256])
    expect((await harness.release({ sha: SHA("1"), environment, urls: [A] })).body).toMatchObject({ accepted: true })
    expect(harness.rows("SELECT environment FROM releases")).toEqual([{ environment: environment.toLowerCase() }])
    expect((await harness.release({ sha: SHA("2"), environment: `${environment}a`, urls: [A] })).status).toBe(400)
  })

  test("an older deployment reported late is not watched, and a report older than a day is stale", async () => {
    const harness = await maxPlan()
    await harness.release({ sha: SHA("2"), urls: [A] })
    expect((await harness.release({ sha: SHA("1"), at: NOW - 60_000, urls: [A] })).body).toEqual({
      accepted: false,
      reason: "older",
    })
    expect((await harness.release({ sha: SHA("3"), at: NOW - DAY - 1, urls: [A] })).body).toEqual({
      accepted: false,
      reason: "stale",
    })
    // Another environment or repository is watched on its own.
    expect(
      (await harness.release({ sha: SHA("1"), at: NOW - 60_000, environment: "eu", urls: [A] })).body,
    ).toMatchObject({
      accepted: true,
    })
    expect(
      (await harness.release({ sha: SHA("1"), at: NOW - 60_000, repositoryId: 43, urls: [A] })).body,
    ).toMatchObject({
      accepted: true,
    })
    expect((await harness.state_()).body.watches).toHaveLength(3)
  })

  test("the plan's releases a day: the dedupe runs before the count, and the count resets at 00:00 UTC", async () => {
    const harness = await maxPlan()
    const perDay = planFor("vector-100").releaseGuard!.perDay
    for (let index = 0; index < perDay; index++) {
      harness.advance(1_000)
      const sha = index.toString(16).padStart(40, "0")
      expect((await harness.release({ sha, urls: [A] })).body).toMatchObject({ accepted: true })
      // A repeat never counts twice.
      expect((await harness.release({ sha, urls: [A] })).body).toEqual({ accepted: false, reason: "duplicate" })
    }
    harness.advance(1_000)
    expect((await harness.release({ sha: SHA("f"), urls: [A] })).body).toEqual({
      accepted: false,
      reason: "daily-limit",
    })
    expect((await harness.release({ sha: SHA("f"), urls: [A] })).body).toEqual({ accepted: false, reason: "duplicate" })
    harness.clock.now = Math.ceil(harness.clock.now / DAY) * DAY + 1_000
    expect((await harness.release({ sha: SHA("e"), urls: [A] })).body).toMatchObject({ accepted: true })
  })

  test("only verified URLs are watched, at most the plan's paths; none verified is refused", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-100", { releaseGuard: { perDay: 10, watchMin: 30, paths: 2 } }))
    await harness.config([HOST], [])
    const urls = [A, "https://other-site.com/", B, `https://${HOST}/three`]
    expect((await harness.release({ sha: SHA("1"), urls })).body).toMatchObject({ accepted: true })
    await harness.runFor(2 * 60_000)
    expect(harness.net.probes("https://other-site.com/")).toBe(0)
    expect(harness.net.probes(`https://${HOST}/three`)).toBe(0)
    expect(harness.net.probes(A)).toBeGreaterThan(0)
    expect(harness.net.probes(B)).toBeGreaterThan(0)
    expect((await harness.release({ sha: SHA("2"), urls: ["https://other-site.com/"] })).body).toEqual({
      accepted: false,
      reason: "not-verified",
    })
  })

  test("without Release Guard in the plan nothing is watched", async () => {
    const harness = new Harness()
    expect((await harness.release({ sha: SHA("1"), urls: [A] })).body).toEqual({
      accepted: false,
      reason: "not-in-plan",
    })
    await harness.plan(planFor("vector-100", { releaseGuard: null }))
    await harness.config([HOST], [])
    expect((await harness.release({ sha: SHA("1"), urls: [A] })).body).toEqual({
      accepted: false,
      reason: "not-in-plan",
    })
    expect(harness.rows("SELECT * FROM releases")).toEqual([])
  })

  test("malformed releases are refused", async () => {
    const harness = await maxPlan()
    for (const body of [
      { sha: "abc", urls: [A] },
      { sha: SHA("A"), urls: [A] },
      { sha: SHA("1"), urls: [] },
      { sha: SHA("1"), urls: ["http://shop.vector-fixture.com/"] },
      { sha: SHA("1"), urls: [A, A, A, A, A, A] },
      { sha: SHA("1"), urls: [A], repositoryId: 0 },
      { sha: SHA("1"), urls: [A], environment: "" },
      { sha: SHA("1"), urls: [A], deployment: "has spaces" },
    ])
      expect({ body, status: (await harness.release(body)).status }).toEqual({ body, status: 400 })
  })
})

// R46-17: the run state is one meta row, and Cloudflare refuses a value over 2 MB. An Ultra account at its largest
// (10 monitors and 10 domains, every URL at the longest allowed, and the most watches it may run at once, each with five
// such paths, a baseline that passed on all of them and a failure recorded for each) stays under the bound, and one
// more release is recorded without a watch and answered, never failed.
describe("the run state's size (R46-17)", () => {
  const long = (host: string, tag: string) => {
    const base = `https://${host}/${tag}-`
    return base + "a".repeat(OPS_LIMITS.urlMaxLength - base.length)
  }
  const stored = (harness: Harness) =>
    harness.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'run'").map((row) => Buffer.byteLength(row.v))[0] ?? 0

  test("an Ultra account at its largest stays under the bound, and a release past the watch cap is answered unwatched", async () => {
    const harness = new Harness()
    const hosts = Array.from({ length: OPS_LIMITS.maxDomains }, (_, index) => `d${index}.vector-fixture.com`)
    // One minute watches so the baselines pass quickly; a watch's size does not depend on its length.
    await harness.plan(planFor("vector-200", { releaseGuard: { perDay: 100, watchMin: 1, paths: 5 } }))
    await harness.config(
      hosts,
      hosts.map((host, index) => ({ id: `monitor-${index}`, url: long(host, "monitor") })),
    )
    const repos = Array.from({ length: OPS_LIMITS.maxConcurrentWatches }, (_, index) => 1_000 + index)
    const paths = (repo: number) =>
      Array.from({ length: OPS_LIMITS.maxReleasePaths }, (_, index) =>
        long(hosts[repo % hosts.length]!, `${repo}-${index}`),
      )
    for (const repositoryId of repos)
      expect((await harness.release({ repositoryId, sha: SHA("1"), urls: paths(repositoryId) })).body).toMatchObject({
        accepted: true,
      })
    await harness.runFor(4 * 60_000)
    expect(harness.rows("SELECT repo FROM releases WHERE state = 'passed'")).toHaveLength(repos.length)
    // Every path now fails: one step records a failure for each, and no watch has failed twice yet.
    for (const repositoryId of repos)
      for (const url of paths(repositoryId)) harness.net.sites.set(url, () => new Response("down", { status: 500 }))
    for (const repositoryId of repos)
      expect((await harness.release({ repositoryId, sha: SHA("2"), urls: paths(repositoryId) })).body).toMatchObject({
        accepted: true,
      })
    await harness.runFor(60_000)
    expect(harness.rows("SELECT repo FROM releases WHERE state = 'watching'")).toHaveLength(repos.length)
    const size = stored(harness)
    expect(size).toBeGreaterThan(OPS_LIMITS.maxRunStateBytes * 0.8)
    expect(size).toBeLessThan(OPS_LIMITS.maxRunStateBytes)

    const extra = 1_000 + repos.length
    const answer = await harness.release({ repositoryId: extra, sha: SHA("3"), urls: paths(extra) })
    expect(answer).toEqual({ status: 200, body: { accepted: false, reason: "daily-limit" } })
    expect(harness.rows("SELECT state FROM releases WHERE repo = ?", extra)).toEqual([{ state: "skipped" }])
    expect(harness.rows("SELECT repo FROM releases WHERE state = 'watching'")).toHaveLength(repos.length)
    expect(stored(harness)).toBeLessThan(OPS_LIMITS.maxRunStateBytes)
  })
})
