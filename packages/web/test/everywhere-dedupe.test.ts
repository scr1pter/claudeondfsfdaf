import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { randomId } from "../../../packages/schema/src/everywhere"
import { claimDelivery, finishDelivery, useOnce } from "../../../api/_lib/everywhere/dedupe"
import { KEEP_MS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { everywhereStore } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-03: delivery dedupe (3.2 step 4). A second delivery of the same id is seen. Pending lasts 60 seconds, done 7 days.
 * The atomic paths also run against a real Redis when VECTOR_TEST_REDIS_URL is set (CI).
 */

let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

describe("deliveries", () => {
  test("the first delivery is new and a second delivery of the same id is seen", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    expect(await claimDelivery(store, "slack", "Ev0123ABC")).toBe("new")
    expect(await claimDelivery(store, "slack", "Ev0123ABC")).toBe("seen")
    expect(fake.read(everywhereKeys.delivery("slack", "Ev0123ABC"))).toEqual({ kind: "string", value: "pending" })
    expect(fake.pttl(everywhereKeys.delivery("slack", "Ev0123ABC"))).toBe(KEEP_MS.deliveryPending)
  })

  test("a finished delivery stays seen for 7 days, then is forgotten", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const id = randomUUID()
    expect(await claimDelivery(store, "linear", id)).toBe("new")
    await finishDelivery(store, "linear", id)
    expect(fake.read(everywhereKeys.delivery("linear", id))).toEqual({ kind: "string", value: "done" })
    expect(fake.pttl(everywhereKeys.delivery("linear", id))).toBe(7 * 86_400_000)
    fake.clock.advance(6 * 86_400_000)
    expect(await claimDelivery(store, "linear", id)).toBe("seen")
    fake.clock.advance(86_400_000 + 1)
    expect(await claimDelivery(store, "linear", id)).toBe("new")
  })

  test("a delivery whose work never finished is free again after 60 seconds, for the platform's retry", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    expect(await claimDelivery(store, "slack", "Ev1")).toBe("new")
    fake.clock.advance(59_999)
    expect(await claimDelivery(store, "slack", "Ev1")).toBe("seen")
    fake.clock.advance(2)
    expect(await claimDelivery(store, "slack", "Ev1")).toBe("new")
  })

  test("the same id on two platforms is two deliveries", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    const id = randomUUID()
    expect(await claimDelivery(store, "github", id)).toBe("new")
    expect(await claimDelivery(store, "linear", id)).toBe("new")
    expect(await claimDelivery(store, "github", id)).toBe("seen")
  })

  test("ids with unusual characters are hashed into the key, and still dedupe", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const id = "a2a:message/with spaces?and=query"
    expect(await claimDelivery(store, "jira", id)).toBe("new")
    expect(await claimDelivery(store, "jira", id)).toBe("seen")
    const keys = [...fake.data.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^vector:everywhere:delivery:jira:~[0-9a-f]{64}$/)
    expect(keys[0]).not.toContain("spaces")
  })

  test("a missing, oversized or control-character id is refused", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    for (const id of ["", "x".repeat(201), "line\nbreak", "nul\u0000"])
      await expect(claimDelivery(store, "slack", id)).rejects.toMatchObject({ code: "EVERYWHERE_DELIVERY_INVALID" })
  })

  test("a store outage fails closed instead of treating the delivery as new", async () => {
    const fake = new FakeStore()
    fake.down = true
    await expect(claimDelivery(everywhereStore(fake.fetch), "slack", "Ev2")).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe("single-use ids", () => {
  test("useOnce answers true once, then false until the key expires", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const key = everywhereKeys.offer(randomId())
    expect(await useOnce(store, key, KEEP_MS.offer)).toBe(true)
    expect(await useOnce(store, key, KEEP_MS.offer)).toBe(false)
    fake.clock.advance(KEEP_MS.offer)
    expect(await useOnce(store, key, KEEP_MS.offer)).toBe(true)
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

  test("concurrent deliveries of one id: exactly one is new", async () => {
    const store = everywhereStore(redis.fetch)
    const id = `test-${randomUUID()}`
    const answers = await Promise.all(Array.from({ length: 12 }, () => claimDelivery(store, "slack", id)))
    expect(answers.filter((answer) => answer === "new")).toHaveLength(1)
    await finishDelivery(store, "slack", id)
    expect(await claimDelivery(store, "slack", id)).toBe("seen")
  })

  test("concurrent uses of one id: exactly one wins", async () => {
    const store = everywhereStore(redis.fetch)
    const key = everywhereKeys.offer(randomId())
    const answers = await Promise.all(Array.from({ length: 12 }, () => useOnce(store, key, 60_000)))
    expect(answers.filter(Boolean)).toHaveLength(1)
  })
})
