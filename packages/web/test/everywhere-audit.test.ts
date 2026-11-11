import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { REFUSAL_CODES, createJobId } from "../../../packages/schema/src/everywhere"
import {
  AUDIT_CODES,
  AUDIT_EVENTS,
  appendAudit,
  decodeAuditEntry,
  readAudit,
  type AuditInput,
} from "../../../api/_lib/everywhere/audit"
import { AUDIT_MAX_ENTRIES, KEEP_MS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { everywhereStore } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-03 and E16: the audit log. Entries are ids and fixed codes only (time, platform, installation, job id, code), with
 * no field that can hold text. Kept 90 days, at most 1,000 entries per account.
 */

const ALLOWED_FIELDS = ["actor", "at", "code", "device", "event", "id", "installation", "jid", "platform", "userId"]
const slack = "slack:T0123ABCD"
const device = "AbCdEfGhIjKlMnOpQrStUA"

let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

describe("entries", () => {
  test("an entry is stored with its time, platform, installation, job id and code, and read back newest first", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const account = randomUUID()
    const jid = createJobId(fake.clock.now)
    await appendAudit(store, account, { event: "job-accepted", installation: slack, jid }, fake.clock.now)
    fake.clock.advance(1_000)
    await appendAudit(store, account, { event: "route", installation: slack, jid, code: "laptop" }, fake.clock.now)
    fake.clock.advance(1_000)
    await appendAudit(store, account, { event: "decline", installation: slack, jid, code: "not-mapped", device }, fake.clock.now)
    const entries = await readAudit(store, account)
    expect(entries.map((entry) => entry.event)).toEqual(["decline", "route", "job-accepted"])
    expect(entries[0]).toMatchObject({
      event: "decline",
      platform: "slack",
      installation: slack,
      jid,
      code: "not-mapped",
      device,
      at: fake.clock.now,
    })
    expect(entries[0]!.id).toMatch(/^[0-9a-z]{26}$/)
  })

  test("the platform is taken from the installation, and a mismatch is refused", async () => {
    const decoded = decodeAuditEntry({ event: "install", installation: slack, id: "a".repeat(26), at: 1 })
    expect(decoded.ok && decoded.value.platform).toBe("slack")
    expect(decodeAuditEntry({ event: "install", installation: slack, platform: "linear", id: "a".repeat(26), at: 1 }).ok).toBe(false)
  })

  test("audit entries carry no text field: a field that could hold text is refused", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    const account = randomUUID()
    for (const extra of [
      { text: "Fix the login bug" },
      { message: "hello" },
      { summary: "Changed three files" },
      { task: "Please refactor" },
      { title: "PR title" },
      { name: "Ada Lovelace" },
      { url: "https://example.com" },
      { reason: "free form" },
    ]) {
      const input = { event: "job-accepted", installation: slack, ...extra } as unknown as AuditInput
      await expect(appendAudit(store, account, input)).rejects.toThrow(TypeError)
    }
  })

  test("codes are fixed words only; free text in a code is refused", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    const account = randomUUID()
    for (const code of ["fix the login bug", "Fix", "not-mapped ", "over limit", "x".repeat(41), "", 7])
      await expect(appendAudit(store, account, { event: "job-refused", code } as unknown as AuditInput)).rejects.toThrow(TypeError)
    for (const code of REFUSAL_CODES) await appendAudit(store, account, { event: "job-refused", code })
  })

  test("ids that could carry text are checked against their shape", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    const account = randomUUID()
    const bad: AuditInput[] = [
      { event: "link", installation: slack, userId: "U01 please run rm" },
      { event: "link", userId: "U0123ABC" },
      { event: "claim", device: "my laptop" },
      { event: "claim", jid: "vej_not-a-job" },
      { event: "connector-change", actor: "someone@example.com" },
      { event: "install", installation: "slack:hello world" },
      { event: "unknown-event" as never },
      { event: "install", platform: "teams" as never },
    ]
    for (const input of bad) await expect(appendAudit(store, account, input)).rejects.toThrow(TypeError)
  })

  test("what is stored holds only the allowed fields", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const account = randomUUID()
    await appendAudit(store, account, {
      event: "link",
      installation: slack,
      userId: "U0123ABC",
      actor: account.toUpperCase(),
    })
    const members = fake.sorted(everywhereKeys.audit(account))
    expect(members).toHaveLength(1)
    const stored = JSON.parse(members[0]!) as Record<string, unknown>
    for (const field of Object.keys(stored)) expect(ALLOWED_FIELDS).toContain(field)
    expect(stored.actor).toBe(account)
  })

  test("every event the contract lists has a name, and every code is unique", () => {
    for (const event of ["install", "connect", "connector-change", "link", "unlink", "job-accepted", "job-refused", "route", "offer", "claim", "decline", "settle", "post", "erase"])
      expect(AUDIT_EVENTS as readonly string[]).toContain(event)
    expect(new Set(AUDIT_CODES).size).toBe(AUDIT_CODES.length)
    for (const code of AUDIT_CODES) expect(code).toMatch(/^[a-z][a-z-]{1,39}$/)
  })
})

describe("retention", () => {
  test("the log keeps at most 1,000 entries, dropping the oldest", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const account = randomUUID()
    const start = fake.clock.now
    for (let index = 0; index < AUDIT_MAX_ENTRIES + 5; index++)
      await appendAudit(store, account, { event: "post", platform: "slack" }, start + index)
    expect(fake.sorted(everywhereKeys.audit(account))).toHaveLength(AUDIT_MAX_ENTRIES)
    const entries = await readAudit(store, account, AUDIT_MAX_ENTRIES)
    expect(entries).toHaveLength(AUDIT_MAX_ENTRIES)
    expect(entries[0]!.at).toBe(start + AUDIT_MAX_ENTRIES + 4)
    expect(entries.at(-1)!.at).toBe(start + 5)
  })

  test("entries older than 90 days go, and the log expires 90 days after its last entry", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const account = randomUUID()
    const first = fake.clock.now
    await appendAudit(store, account, { event: "install", installation: slack }, first)
    expect(fake.pttl(everywhereKeys.audit(account))).toBe(KEEP_MS.audit)
    fake.clock.advance(KEEP_MS.audit - 1)
    await appendAudit(store, account, { event: "link", installation: slack, userId: "U1" }, fake.clock.now)
    expect((await readAudit(store, account)).map((entry) => entry.event)).toEqual(["link", "install"])
    fake.clock.advance(2)
    await appendAudit(store, account, { event: "unlink", installation: slack, userId: "U1" }, fake.clock.now)
    expect((await readAudit(store, account)).map((entry) => entry.event)).toEqual(["unlink", "link"])
  })

  test("entries that no longer decode are left out when reading", async () => {
    const fake = new FakeStore()
    const store = everywhereStore(fake.fetch)
    const account = randomUUID()
    await appendAudit(store, account, { event: "install", installation: slack }, fake.clock.now)
    fake.send(["ZADD", everywhereKeys.audit(account), fake.clock.now + 1, JSON.stringify({ event: "install", id: "b".repeat(26), at: 2, text: "smuggled" })])
    fake.send(["ZADD", everywhereKeys.audit(account), fake.clock.now + 2, "{not json"])
    expect((await readAudit(store, account)).map((entry) => entry.event)).toEqual(["install"])
  })

  test("readAudit takes a limit between 1 and 1,000", async () => {
    const store = everywhereStore(new FakeStore().fetch)
    for (const limit of [0, 1_001, 1.5]) await expect(readAudit(store, randomUUID(), limit)).rejects.toThrow(RangeError)
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

  test("the append script stores, orders, trims old entries and sets the expiry", async () => {
    const store = everywhereStore(redis.fetch)
    const account = randomUUID()
    const now = Date.now()
    await appendAudit(store, account, { event: "install", installation: slack }, now - KEEP_MS.audit - 10)
    await appendAudit(store, account, { event: "link", installation: slack, userId: "U1" }, now - 1)
    await appendAudit(store, account, { event: "route", installation: slack, code: "queue" }, now)
    expect((await readAudit(store, account)).map((entry) => entry.event)).toEqual(["route", "link"])
    const ttl = Number(await store(["PTTL", everywhereKeys.audit(account)]))
    expect(ttl).toBeGreaterThan(KEEP_MS.audit - 60_000)
    expect(ttl).toBeLessThanOrEqual(KEEP_MS.audit)
  })
})
