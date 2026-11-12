import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { slackCooldown } from "../../../api/_lib/everywhere/slack/cooldown"
import { type Store } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis, testEverywhereStore } from "./lib/everywhere-store"

installFetchGuard()
let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

async function maximum(store: Store) {
  const installation = `slack:T${randomBytes(10).toString("hex").toUpperCase()}`
  const now = Date.now()
  const cold = () => slackCooldown(store, installation)
  await Promise.all(
    [120_000, 10_000, 30_000, 90_000, 15_000].map((delay) => cold().write("chat.postMessage", now + delay, delay)),
  )
  expect(await cold().read("chat.postMessage")).toBe(now + 120_000)
  expect(await cold().read("chat.postEphemeral")).toBe(0)
  expect(Number(await store(["PTTL", everywhereKeys.slackRetry(installation, "chat.postMessage")]))).toBeGreaterThan(
    120_000,
  )
}

test("concurrent shorter Retry-After replies cannot lower a cold instance's longest cooldown", async () => {
  const fake = new FakeStore()
  await maximum(async (command) => fake.send(command))
})

test("cooldown reads support REST string and native Redis numeric scores and refuse malformed deadlines", async () => {
  for (const value of [1_795_000_120_000, "1795000120000"]) {
    const cooldown = slackCooldown(async () => value, "slack:TTESTSCORE")
    expect(await cooldown.read("chat.postMessage")).toBe(1_795_000_120_000)
  }
  for (const value of [null, undefined]) {
    expect(await slackCooldown(async () => value, "slack:TTESTSCORE").read("chat.postMessage")).toBe(0)
  }
  for (const value of [-1, "-1", 1.5, "1.5", "1e12", "", true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(slackCooldown(async () => value, "slack:TTESTSCORE").read("chat.postMessage")).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
  }
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("actual Redis native cooldown", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })
  test("concurrent ZADD GT keeps the longest Retry-After across independent instances", async () => {
    await maximum(testEverywhereStore(redis.fetch))
  })
})
