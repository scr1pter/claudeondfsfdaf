import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { createJobId, randomId } from "../../../packages/schema/src/everywhere"
import {
  EVERYWHERE_PREFIX,
  KEEP_MS,
  capScopes,
  everywhereKeys,
  freePart,
  isEverywhereKey,
  userIdValid,
} from "../../../api/_lib/everywhere/keys"
import {
  commandKeys,
  deleteKeys,
  getJson,
  getValue,
  runScript,
  setJson,
  setValue,
} from "../../../api/_lib/everywhere/store"
import { ApiError } from "../../../api/_lib/http"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, useKv, testEverywhereStore } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-03: store keys (contract 3.13) and the store wrapper. Keys start with `vector:everywhere:`, every part is checked,
 * and the store refuses any command that would touch another feature's keys.
 */

const account = randomUUID()
const slack = "slack:E0123ABCD:T0456EFGH"
const jira = `jira:${randomUUID()}`
const linear = `linear:${randomUUID()}`
const jid = createJobId()
const device = "AbCdEfGhIjKlMnOpQrStUA"

function code(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error instanceof ApiError ? error.code : "other"
  }
  return "built"
}

describe("keys", () => {
  test("every 3.13 key has its documented shape under the prefix", () => {
    const hash = "a".repeat(64)
    expect(everywhereKeys.install(slack)).toBe(`vector:everywhere:install:${slack}`)
    expect(everywhereKeys.installs(account)).toBe(`vector:everywhere:installs:${account}`)
    expect(everywhereKeys.link(slack, "U0123ABC")).toBe(`vector:everywhere:link:${slack}:U0123ABC`)
    expect(everywhereKeys.links(account)).toBe(`vector:everywhere:links:${account}`)
    expect(everywhereKeys.linkCode(hash)).toBe(`vector:everywhere:linkcode:${hash}`)
    expect(everywhereKeys.connectCode(hash)).toBe(`vector:everywhere:connectcode:${hash}`)
    expect(everywhereKeys.state("abcdefghijklmnop")).toBe("vector:everywhere:state:abcdefghijklmnop")
    expect(everywhereKeys.repo(slack, "C0123ABC")).toBe(`vector:everywhere:repo:${slack}:C0123ABC`)
    expect(everywhereKeys.job(jid)).toBe(`vector:everywhere:job:${jid}`)
    expect(everywhereKeys.jobBody(jid)).toBe(`vector:everywhere:job:${jid}:body`)
    expect(everywhereKeys.jobs(account)).toBe(`vector:everywhere:jobs:${account}`)
    expect(everywhereKeys.jobsDue()).toBe("vector:everywhere:jobs:due")
    expect(everywhereKeys.ready(account, device)).toBe(`vector:everywhere:ready:${account}:${device}`)
    expect(everywhereKeys.fit("0b6e2f2a-1111-4c3e")).toBe("vector:everywhere:fit:0b6e2f2a-1111-4c3e")
    expect(everywhereKeys.handoff(123, 456)).toBe("vector:everywhere:handoff:123:456")
    expect(everywhereKeys.count(capScopes.sponsor(account), "d20261111")).toBe(
      `vector:everywhere:count:sponsor:${account}:d20261111`,
    )
    expect(everywhereKeys.delivery("slack", "Ev0123ABC")).toBe("vector:everywhere:delivery:slack:Ev0123ABC")
    const jti = randomId()
    expect(everywhereKeys.offer(jti)).toBe(`vector:everywhere:offer:${jti}`)
    expect(everywhereKeys.seen(account)).toBe(`vector:everywhere:seen:${account}`)
    expect(everywhereKeys.ticket("b".repeat(64))).toBe(`vector:everywhere:ticket:${"b".repeat(64)}`)
    expect(everywhereKeys.jiraTask("task-1")).toBe("vector:everywhere:jira:task:task-1")
    expect(everywhereKeys.audit(account)).toBe(`vector:everywhere:audit:${account}`)
  })

  test("account ids are written lowercase, so one account has one key", () => {
    expect(everywhereKeys.audit(account.toUpperCase())).toBe(everywhereKeys.audit(account))
  })

  test("a malformed part is refused, never written into a key", () => {
    const refused = [
      () => everywhereKeys.install("slack:bad"),
      () => everywhereKeys.install(`${slack} `),
      () => everywhereKeys.installs("not-an-account"),
      () => everywhereKeys.link(slack, "U0123 ABC"),
      () => everywhereKeys.link(slack, "u0123abc"),
      () => everywhereKeys.link(linear, "U0123ABC"),
      () => everywhereKeys.linkCode("A".repeat(64)),
      () => everywhereKeys.linkCode("a".repeat(63)),
      () => everywhereKeys.state("short"),
      () => everywhereKeys.repo(slack, "C01:23"),
      () => everywhereKeys.job("vej_short"),
      () => everywhereKeys.ready(account, "device"),
      () => everywhereKeys.ready("not-an-account", device),
      () => everywhereKeys.handoff(0, 1),
      () => everywhereKeys.handoff(1.5, 1),
      () => everywhereKeys.count("anything:goes", "d20261111"),
      () => everywhereKeys.count(capScopes.sponsor(account), "20261111"),
      () => everywhereKeys.delivery("teams", "Ev1"),
      () => everywhereKeys.delivery("slack", ""),
      () => everywhereKeys.offer("not-a-random-id"),
      () => everywhereKeys.ticket("short"),
    ]
    for (const run of refused) expect(code(run)).toBe("EVERYWHERE_INVALID_ID")
  })

  test("platform user ids follow each platform's shape, and Jira's colon form stays unambiguous", () => {
    expect(userIdValid(slack, "U0123ABC")).toBe(true)
    expect(userIdValid(slack, "W0123ABC")).toBe(true)
    expect(userIdValid(jira, "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077")).toBe(true)
    expect(userIdValid(jira, "5b10ac8d82e05b22cc7d4ef5")).toBe(true)
    expect(userIdValid(jira, "a:b:c")).toBe(false)
    expect(userIdValid(linear, randomUUID())).toBe(true)
    expect(userIdValid("github:42", "12345")).toBe(true)
    expect(userIdValid("github:42", "octocat")).toBe(false)
    expect(everywhereKeys.link(jira, "557058:f58131cb")).toBe(`vector:everywhere:link:${jira}:557058:f58131cb`)
  })

  test("free-form ids are kept when plain and hashed otherwise, so the two never collide", () => {
    expect(freePart("Ev0123ABC")).toBe("Ev0123ABC")
    expect(freePart("a b")).toMatch(/^~[0-9a-f]{64}$/)
    expect(freePart("msg:1/2")).toMatch(/^~[0-9a-f]{64}$/)
    expect(freePart("msg:1/2")).not.toBe(freePart("msg:1/3"))
    expect(code(() => freePart(""))).toBe("EVERYWHERE_INVALID_ID")
    expect(code(() => freePart("x".repeat(513)))).toBe("EVERYWHERE_INVALID_ID")
  })

  test("the keep times match the contract", () => {
    expect(KEEP_MS.linkCode).toBe(600_000)
    expect(KEEP_MS.state).toBe(600_000)
    expect(KEEP_MS.jobBody).toBe(7_200_000)
    expect(KEEP_MS.deliveryPending).toBe(60_000)
    expect(KEEP_MS.deliveryDone).toBe(7 * 86_400_000)
    expect(KEEP_MS.offer).toBe(3_600_000)
    expect(KEEP_MS.seen).toBe(30 * 86_400_000)
    expect(KEEP_MS.audit).toBe(90 * 86_400_000)
    expect(KEEP_MS.jiraTask).toBe(2 * 86_400_000)
  })

  test("isEverywhereKey accepts only keys under the prefix", () => {
    expect(isEverywhereKey(everywhereKeys.job(jid))).toBe(true)
    expect(isEverywhereKey(EVERYWHERE_PREFIX)).toBe(false)
    expect(isEverywhereKey("vector:codium:live:switch:remote")).toBe(false)
    expect(isEverywhereKey(42)).toBe(false)
  })
})

describe("the store", () => {
  let restore: () => void
  beforeAll(() => {
    restore = useKv()
  })
  afterAll(() => restore())

  test("commands name their keys, and unknown commands name none", () => {
    expect(commandKeys(["GET", "a"])).toEqual(["a"])
    expect(commandKeys(["DEL", "a", "b"])).toEqual(["a", "b"])
    expect(commandKeys(["EVAL", "return 1", 2, "a", "b", "x"])).toEqual(["a", "b"])
    expect(commandKeys(["EVAL", "return 1", 3, "a"])).toBeUndefined()
    expect(commandKeys(["FLUSHALL"])).toBeUndefined()
    expect(commandKeys(["KEYS", "*"])).toBeUndefined()
    expect(commandKeys(["GET"])).toBeUndefined()
  })

  test("a command that would touch another feature's key, or no key, is refused before the store sees it", async () => {
    const fake = new FakeStore()
    const store = testEverywhereStore(fake.fetch)
    for (const command of [
      ["GET", "vector:codium:live:switch:remote"],
      ["DEL", everywhereKeys.job(jid), "vector:codium:live:account:1"],
      ["EVAL", "return 1", 1, "vector:shares:1"],
      ["EVAL", "return 1", 0],
      ["FLUSHALL"],
      ["KEYS", "vector:everywhere:*"],
    ] as const) {
      let failure = ""
      try {
        await store(command)
      } catch (error) {
        failure = error instanceof ApiError ? error.code : "other"
      }
      expect(failure).toBe("EVERYWHERE_STORE_REFUSED")
    }
    expect(fake.commands).toEqual([])
  })

  test("values, NX, XX and expiry", async () => {
    const fake = new FakeStore()
    const store = testEverywhereStore(fake.fetch)
    const key = everywhereKeys.state("abcdefghijklmnop")
    expect(await getValue(store, key)).toBeUndefined()
    expect(await setValue(store, key, "one", { ttlMs: KEEP_MS.state, onlyNew: true })).toBe(true)
    expect(await setValue(store, key, "two", { ttlMs: KEEP_MS.state, onlyNew: true })).toBe(false)
    expect(await getValue(store, key)).toBe("one")
    expect(await setValue(store, key, "three", { onlyExisting: true, ttlMs: 1_000 })).toBe(true)
    expect(fake.pttl(key)).toBe(1_000)
    fake.clock.advance(1_001)
    expect(await getValue(store, key)).toBeUndefined()
    expect(await setValue(store, key, "four", { onlyExisting: true })).toBe(false)
    expect(fake.commands.map(([name]) => name)).toEqual(["GET", "SET", "SET", "GET", "SET", "GET", "SET"])
  })

  test("JSON values decode, and a stored value of the wrong shape is a store fault, not data", async () => {
    const fake = new FakeStore()
    const store = testEverywhereStore(fake.fetch)
    const key = everywhereKeys.install(slack)
    const decode = (value: unknown) =>
      typeof value === "object" && value !== null && "connector" in value ? (value as { connector: string }) : undefined
    await setJson(store, key, { connector: account })
    expect(await getJson(store, key, decode)).toEqual({ connector: account })
    expect(fake.pttl(key)).toBe(-1)
    fake.send(["SET", key, "{not json"])
    await expect(getJson(store, key, decode)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    fake.send(["SET", key, '{"other":1}'])
    await expect(getJson(store, key, decode)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  })

  test("deleteKeys answers how many existed", async () => {
    const fake = new FakeStore()
    const store = testEverywhereStore(fake.fetch)
    await setValue(store, everywhereKeys.job(jid), "x", { ttlMs: 1_000 })
    expect(await deleteKeys(store, everywhereKeys.job(jid), everywhereKeys.jobBody(jid))).toBe(1)
    expect(await deleteKeys(store)).toBe(0)
  })

  test("an outage, an unknown script or a bad answer fails closed with 503", async () => {
    const fake = new FakeStore()
    const store = testEverywhereStore(fake.fetch)
    fake.down = true
    await expect(getValue(store, everywhereKeys.job(jid))).rejects.toMatchObject({ statusCode: 503 })
    fake.down = false
    await expect(runScript(store, "return 1", [everywhereKeys.job(jid)], [])).rejects.toMatchObject({ statusCode: 503 })
  })

  test("TTLs must be whole positive milliseconds", async () => {
    const store = testEverywhereStore(new FakeStore().fetch)
    for (const ttlMs of [0, -1, 1.5, Number.NaN])
      await expect(setValue(store, everywhereKeys.job(jid), "x", { ttlMs })).rejects.toThrow(RangeError)
  })
})
