import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { jiraClient } from "../../../api/_lib/everywhere/jira/client"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { linearApi } from "../../../api/_lib/everywhere/linear/client"
import { linearCooldown } from "../../../api/_lib/everywhere/linear/cooldown"
import { storeScore, type Store } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis, testEverywhereStore } from "./lib/everywhere-store"

installFetchGuard()
let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

const NOW = 1_795_000_000_000
const SCORES = [NOW + 120_000, String(NOW + 120_000)] as const
const MALFORMED = [-1, "-1", 1.5, "1.5", "1e12", "", true, {}, Number.MAX_SAFE_INTEGER + 1] as const

// A store that answers every command with one value, as a REST bridge (string) or native Redis (number) would.
const answering = (value: unknown): Store => async () => value

// The fake platforms answer locally; nothing reaches Linear or Atlassian.
function platform(body: unknown) {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname)
    return Response.json(body)
  }) as typeof fetch
  return { calls, fetcher }
}

describe("a stored cooldown score", () => {
  test("is read from native numbers and REST strings, and refused when malformed or negative", () => {
    for (const value of SCORES) expect(storeScore(value)).toBe(NOW + 120_000)
    for (const value of [null, undefined]) expect(storeScore(value)).toBe(0)
    for (const value of MALFORMED) expect(() => storeScore(value)).toThrow(expect.objectContaining({ code: "PERSISTENT_STORE_UNAVAILABLE" }))
  })
})

describe("the Linear cooldown", () => {
  const installation = `linear:${randomUUID()}`

  test("a native numeric score blocks until it passes, then calls proceed", async () => {
    for (const value of SCORES) {
      const linear = platform({ data: { viewer: { id: "viewer" } } })
      const cooldown = linearCooldown(answering(value), answering("OK"), installation)
      expect(await cooldown.read()).toBe(NOW + 120_000)
      const api = (now: number) => linearApi({ token: "generated-token", fetcher: linear.fetcher, now: () => now, cooldown })
      await expect(api(NOW)("viewer")).rejects.toMatchObject({ code: "LINEAR_UNAVAILABLE", retryMs: 120_000 })
      expect(linear.calls).toEqual([])
      // Once Retry-After has passed the same score no longer blocks: the installation does not go dark for a day.
      expect(await api(NOW + 120_001)("viewer")).toEqual({ viewer: { id: "viewer" } })
      expect(linear.calls).toEqual(["api.linear.app"])
    }
  })

  test("no score is no cooldown, and a malformed score is a store fault", async () => {
    for (const value of [null, undefined]) expect(await linearCooldown(answering(value), answering("OK"), installation).read()).toBe(0)
    for (const value of MALFORMED)
      await expect(linearCooldown(answering(value), answering("OK"), installation).read()).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  })

  test("writes keep the longest reset through the fenced store", async () => {
    const fake = new FakeStore()
    const store: Store = async (command) => fake.send(command)
    const cooldown = linearCooldown(store, store, installation)
    await cooldown.write(NOW + 120_000)
    await cooldown.write(NOW + 30_000)
    expect(await cooldown.read()).toBe(NOW + 120_000)
    expect(Number(await store(["PTTL", everywhereKeys.linearRetry(installation)]))).toBeGreaterThan(120_000)
  })
})

describe("the Jira cooldown", () => {
  const cloudId = randomUUID()
  const client = (store: Store, fetcher: typeof fetch, now = NOW) =>
    jiraClient({ cloudId, userToken: `jira-${randomBytes(12).toString("hex")}`, fetcher, store, now: () => now })

  test("a native numeric score blocks until it passes, then reads proceed", async () => {
    for (const value of SCORES) {
      const jira = platform({ accountId: "fixture-user" })
      await expect(client(answering(value), jira.fetcher)("myself")).rejects.toMatchObject({ code: "JIRA_UNAVAILABLE", retryMs: 120_000 })
      expect(jira.calls).toEqual([])
      expect(await client(answering(value), jira.fetcher, NOW + 120_001)("myself")).toEqual({ accountId: "fixture-user" })
      expect(jira.calls).toEqual(["api.atlassian.com"])
    }
  })

  test("no score is no cooldown, and a malformed score refuses the read before any request", async () => {
    for (const value of [null, undefined]) {
      const jira = platform({ accountId: "fixture-user" })
      expect(await client(answering(value), jira.fetcher)("myself")).toEqual({ accountId: "fixture-user" })
    }
    for (const value of MALFORMED) {
      const jira = platform({ accountId: "fixture-user" })
      await expect(client(answering(value), jira.fetcher)("myself")).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      expect(jira.calls).toEqual([])
    }
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("actual Redis cooldown scores", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })

  test("Linear and Jira read back the native score they wrote", async () => {
    const store = testEverywhereStore(redis.fetch)
    const installation = `linear:${randomUUID()}`
    const linear = linearCooldown(store, store, installation)
    await linear.write(NOW + 120_000)
    expect(await linear.read()).toBe(NOW + 120_000)

    const cloudId = randomUUID()
    await store(["ZADD", everywhereKeys.jiraRetry(`jira:${cloudId}`), NOW + 120_000, "until"])
    const jira = platform({ accountId: "fixture-user" })
    const read = (now: number) => jiraClient({ cloudId, userToken: "generated-token", fetcher: jira.fetcher, store, now: () => now })
    await expect(read(NOW)("myself")).rejects.toMatchObject({ retryMs: 120_000 })
    expect(await read(NOW + 120_001)("myself")).toEqual({ accountId: "fixture-user" })
  })
})
