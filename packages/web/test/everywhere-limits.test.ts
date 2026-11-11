import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { SERVER_CAPS, createJobId } from "../../../packages/schema/src/everywhere"
import { overLimit } from "../../../packages/schema/src/everywhere-policy"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { capKeys, countJob, dayWindow, hourWindow, readCounts, type CapSubject } from "../../../api/_lib/everywhere/limits"
import { everywhereStore } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-03 and E3: server cap counters (3.9). Per sponsor 30 a day and 3 live, per requester 6 an hour, per installation
 * 200 a day. `countJob` checks and counts in one step, so the last place cannot be taken twice.
 */

let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

function subject(overrides: Partial<CapSubject> = {}): CapSubject {
  return { sponsor: randomUUID(), installation: "slack:T0123ABCD", userId: "U0123ABC", ...overrides }
}

describe("windows", () => {
  test("day and hour windows are UTC calendar windows", () => {
    const now = Date.UTC(2026, 10, 11, 14, 30, 15)
    expect(dayWindow(now)).toEqual({ id: "d20261111", endsAt: Date.UTC(2026, 10, 12) })
    expect(hourWindow(now)).toEqual({ id: "h2026111114", endsAt: Date.UTC(2026, 10, 11, 15) })
    expect(hourWindow(Date.UTC(2026, 11, 31, 23, 59, 59)).endsAt).toBe(Date.UTC(2027, 0, 1))
    expect(dayWindow(Date.UTC(2026, 0, 5)).id).toBe("d20260105")
  })

  test("each counter lives until a minute after its window ends", () => {
    const now = Date.UTC(2026, 10, 11, 14, 30)
    const keys = capKeys(subject(), now)
    expect(keys.requesterHour.ttlMs).toBe(30 * 60_000 + 60_000)
    expect(keys.sponsorToday.ttlMs).toBe(9.5 * 3_600_000 + 60_000)
    expect(keys.installationToday.ttlMs).toBe(keys.sponsorToday.ttlMs)
    expect(keys.sponsorLive.key).toMatch(/^vector:everywhere:jobs:/)
  })
})

describe("counting", () => {
  test("an account with no jobs reads all zeros", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    expect(await readCounts(store, subject())).toEqual({ sponsorToday: 0, sponsorLive: 0, requesterHour: 0, installationToday: 0 })
  })

  test("countJob counts the job in every window and sets each counter's expiry", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const who = subject()
    const result = await countJob(store, who, fake.clock.now)
    expect(result).toEqual({ admitted: true, counts: { sponsorToday: 1, requesterHour: 1, installationToday: 1, sponsorLive: 0 } })
    expect(await readCounts(store, who, fake.clock.now)).toEqual({ sponsorToday: 1, requesterHour: 1, installationToday: 1, sponsorLive: 0 })
    const keys = capKeys(who, fake.clock.now)
    expect(fake.pttl(keys.sponsorToday.key)).toBe(keys.sponsorToday.ttlMs)
    expect(fake.pttl(keys.requesterHour.key)).toBe(keys.requesterHour.ttlMs)
  })

  test("the 7th job in an hour from one requester is refused and counts nothing", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const who = subject()
    for (let index = 0; index < SERVER_CAPS.requesterPerHour; index++)
      expect((await countJob(store, who, fake.clock.now)).admitted).toBe(true)
    const refused = await countJob(store, who, fake.clock.now)
    expect(refused.admitted).toBe(false)
    expect(refused.counts.requesterHour).toBe(SERVER_CAPS.requesterPerHour)
    expect(overLimit(refused.counts)).toBe(true)
    expect(await readCounts(store, who, fake.clock.now)).toMatchObject({ sponsorToday: 6, installationToday: 6 })
    // The next hour has room again.
    fake.clock.advance(3_600_000)
    expect((await countJob(store, who, fake.clock.now)).admitted).toBe(true)
  })

  test("a sponsor with 3 live jobs is refused", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const who = subject()
    for (let index = 0; index < SERVER_CAPS.sponsorLive; index++)
      fake.send(["ZADD", everywhereKeys.jobs(who.sponsor), fake.clock.now, createJobId(fake.clock.now + index)])
    const result = await countJob(store, who, fake.clock.now)
    expect(result).toEqual({ admitted: false, counts: { sponsorToday: 0, requesterHour: 0, installationToday: 0, sponsorLive: 3 } })
    expect(overLimit((await readCounts(store, who, fake.clock.now)))).toBe(true)
  })

  test("a sponsor's 31st job of the day is refused, across requesters and installations", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const sponsor = randomUUID()
    for (let index = 0; index < SERVER_CAPS.sponsorPerDay; index++) {
      const who = subject({ sponsor, installation: index % 2 ? "slack:T0123ABCD" : `linear:${randomUUID()}`, userId: index % 2 ? `U${index}AB` : randomUUID() })
      expect((await countJob(store, who, fake.clock.now)).admitted).toBe(true)
    }
    expect((await countJob(store, subject({ sponsor, userId: "UNEW1" }), fake.clock.now)).admitted).toBe(false)
  })

  test("an installation's 201st job of the day is refused", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const installation = "slack:T0999ZZZZ"
    fake.send(["SET", capKeys(subject({ installation }), fake.clock.now).installationToday.key, String(SERVER_CAPS.installationPerDay)])
    expect((await countJob(store, subject({ installation }), fake.clock.now)).admitted).toBe(false)
    expect((await countJob(store, subject(), fake.clock.now)).admitted).toBe(true)
  })

  test("readCounts agrees with overLimit at each edge", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const who = subject()
    for (let index = 0; index < SERVER_CAPS.requesterPerHour - 1; index++) await countJob(store, who, fake.clock.now)
    expect(overLimit(await readCounts(store, who, fake.clock.now))).toBe(false)
    await countJob(store, who, fake.clock.now)
    expect(overLimit(await readCounts(store, who, fake.clock.now))).toBe(true)
  })

  test("a counter holding something other than a number is a store fault", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const who = subject()
    fake.send(["SET", capKeys(who, fake.clock.now).sponsorToday.key, "lots"])
    await expect(readCounts(store, who, fake.clock.now)).rejects.toMatchObject({ statusCode: 503 })
    await expect(countJob(store, who, fake.clock.now)).rejects.toMatchObject({ statusCode: 503 })
  })

  test("malformed subjects are refused", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    for (const bad of [subject({ sponsor: "nobody" }), subject({ installation: "slack:nope" }), subject({ userId: "has space" })])
      await expect(countJob(store, bad)).rejects.toMatchObject({ code: "EVERYWHERE_INVALID_ID" })
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })

  test("twelve jobs at once from one requester: exactly six are admitted", async () => {
    const store = everywhereStore(redis.fetch)
    const who = subject({ installation: `linear:${randomUUID()}`, userId: randomUUID() })
    const results = await Promise.all(Array.from({ length: 12 }, () => countJob(store, who)))
    expect(results.filter((result) => result.admitted)).toHaveLength(SERVER_CAPS.requesterPerHour)
    expect((await readCounts(store, who)).requesterHour).toBe(SERVER_CAPS.requesterPerHour)
    const ttl = Number(await store(["PTTL", capKeys(who, Date.now()).requesterHour.key]))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(3_660_000)
  })
})
