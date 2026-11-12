import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { slackCooldown } from "../../../api/_lib/everywhere/slack/cooldown"
import { everywhereStore, type Store } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()
let restore: () => void
beforeAll(() => { restore = useKv() })
afterAll(() => restore())

async function maximum(store: Store) {
  const installation = `slack:T${randomBytes(10).toString("hex").toUpperCase()}`
  const now = Date.now()
  const cold = () => slackCooldown(store, installation)
  await Promise.all([120_000, 10_000, 30_000, 90_000, 15_000].map((delay) => cold().write("chat.postMessage", now + delay, delay)))
  expect(await cold().read("chat.postMessage")).toBe(now + 120_000)
  expect(await cold().read("chat.postEphemeral")).toBe(0)
  expect(Number(await store(["PTTL", everywhereKeys.slackRetry(installation, "chat.postMessage")]))).toBeGreaterThan(120_000)
}

test("concurrent shorter Retry-After replies cannot lower a cold instance's longest cooldown", async () => {
  const fake = new FakeStore()
  await maximum(async (command) => fake.send(command))
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("actual Redis native cooldown", () => {
  let redis: RealRedis
  beforeAll(async () => { redis = (await realRedis())! })
  afterAll(async () => { await redis?.close() })
  test("concurrent ZADD GT keeps the longest Retry-After across independent instances", async () => {
    await maximum(everywhereStore(redis.fetch))
  })
})
