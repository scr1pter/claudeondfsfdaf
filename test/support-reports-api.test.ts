import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash, randomUUID } from "node:crypto"
import { perkServices } from "../api/_lib/codium-perks"
import {
  accountReportsKey,
  createReportRecord,
  decodeReportRecord,
  eraseAccountReports,
  newReportId,
  readReportViews,
  REPORT_RETENTION_MS,
  reportHash,
  reportKey,
  setReportStatus,
} from "../api/_lib/support-reports"
import { handleSupportReports, MAX_REPORT_IDS } from "../api/support/reports"
import { changelogReleases, fixedReportHashes } from "../packages/web/scripts/build-changelog"
import fixedReportsFile from "../packages/web/src/data/fixed-reports.json"
import {
  parseReportStatusArguments,
  validFixedReports,
  withFixedReport,
  withoutFixedReport,
} from "../script/report-status"
import { invoke, jsonHeaders, REPORT_KV_URL, reportEnvironment, reportFakes } from "./support-reports-fixture"

// WP A33: reading report statuses (free, by id alone), the owner's status script and the public fixed list the
// changelog carries. The store is a fake (support-reports-fixture.ts); nothing reaches a network. The last case runs the
// same store commands on a real Valkey when VECTOR_TEST_REDIS_URL is set (the CI lane), and is skipped otherwise.

const ACCOUNT = "4f9a1c2e-7b3d-4e8f-9a6b-1c2d3e4f5a6b"
let restore = () => {}
let fakes = reportFakes()
beforeEach(() => {
  restore = reportEnvironment()
  fakes = reportFakes()
})
afterEach(() => restore())

const statuses = (body: unknown, ip = "192.0.2.30") =>
  invoke((request, response) => handleSupportReports(request, response, fakes.fetcher), {
    headers: jsonHeaders(ip),
    body,
  })

async function stored(input: Parameters<typeof createReportRecord>[1] = {}) {
  const id = newReportId()
  expect(await createReportRecord(id, input, fakes.fetcher)).toBe(true)
  return id
}

describe("report ids and records", () => {
  test("ids are r_ and 26 base32 letters, never repeated", () => {
    const ids = Array.from({ length: 500 }, () => newReportId())
    expect(ids.every((id) => /^r_[a-z2-7]{26}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the changelog hash is the first 16 hex digits of the id's SHA-256", () => {
    const id = "r_abcdefghijklmnopqrstuvwxyz"
    expect(reportHash(id)).toBe(createHash("sha256").update(id).digest("hex").slice(0, 16))
    expect(reportHash(id)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("a record with any field this module does not write is refused, so a message can never be read back (P4)", () => {
    const record = { v: 1, status: "received", createdAt: 1, updatedAt: 1 }
    expect(decodeReportRecord(JSON.stringify(record))).toEqual(record as never)
    expect(decodeReportRecord(JSON.stringify({ ...record, message: "secret" }))).toBeUndefined()
    expect(decodeReportRecord(JSON.stringify({ ...record, email: "a@b.c" }))).toBeUndefined()
    expect(decodeReportRecord(JSON.stringify({ ...record, status: "lost" }))).toBeUndefined()
    expect(decodeReportRecord("not json")).toBeUndefined()
  })

  test("a record is written once: the same id is never overwritten", async () => {
    const id = newReportId()
    expect(await createReportRecord(id, { tag: "plus" }, fakes.fetcher)).toBe(true)
    expect(await createReportRecord(id, { tag: "ultra", readFirst: true }, fakes.fetcher)).toBe(false)
    expect(JSON.parse(fakes.store.get(reportKey(id))!)).toMatchObject({ tag: "plus", readFirst: false })
  })
})

describe("POST /api/support/reports", () => {
  test("answers each known report's status, release and commit, and leaves unknown ids out", async () => {
    const first = await stored()
    const second = await stored({ tag: "max", readFirst: true, account: ACCOUNT })
    await setReportStatus(
      first,
      { status: "fixed", fixedIn: "1.99.114", commit: "abc1234def" },
      { fetcher: fakes.fetcher },
    )
    const unknown = newReportId()
    const result = await statuses({ ids: [first, second, unknown, first] })
    expect(result.status).toBe(200)
    expect(result.body.reports).toEqual([
      { id: first, status: "fixed", updatedAt: expect.any(Number), fixedIn: "1.99.114", commit: "abc1234def" },
      { id: second, status: "received", updatedAt: expect.any(Number) },
    ])
    // Only the status travels back: no plan tag and no amounts.
    const fields = new Set(result.body.reports.flatMap((report: object) => Object.keys(report)))
    expect([...fields].sort()).toEqual(["commit", "fixedIn", "id", "status", "updatedAt"])
    expect(result.headers["cache-control"]).toBe("no-store")
  })

  test("refuses anything but a list of up to 100 report ids, sent as POST", async () => {
    for (const body of [
      {},
      { ids: "r_abcdefghijklmnopqrstuvwxyz" },
      { ids: ["r_short"] },
      { ids: ["R_ABCDEFGHIJKLMNOPQRSTUVWXYZ"] },
      { ids: Array.from({ length: MAX_REPORT_IDS + 1 }, () => newReportId()) },
      [],
    ]) {
      const result = await statuses(body)
      expect(result).toMatchObject({ status: 400, body: { error: { code: "REPORT_IDS_INVALID" } } })
    }
    expect((await statuses({ ids: [] })).body).toEqual({ reports: [] })
    expect((await statuses({ ids: Array.from({ length: MAX_REPORT_IDS }, () => newReportId()) })).status).toBe(200)
    const get = await invoke((request, response) => handleSupportReports(request, response, fakes.fetcher), {
      method: "GET",
      headers: jsonHeaders("192.0.2.31"),
    })
    expect(get.status).toBe(405)
  })

  test("refuses other sites' pages and answers 60 requests an hour per address", async () => {
    const foreign = await invoke((request, response) => handleSupportReports(request, response, fakes.fetcher), {
      headers: jsonHeaders("192.0.2.32", { origin: "https://attacker.example" }),
      body: { ids: [] },
    })
    expect(foreign.status).toBe(403)
    const results: number[] = []
    for (let index = 0; index < 61; index++) results.push((await statuses({ ids: [] }, "192.0.2.33")).status)
    expect(results.slice(0, 60).every((status) => status === 200)).toBe(true)
    expect(results[60]).toBe(429)
  })

  test("a store that cannot be read answers 503, never a made-up status", async () => {
    const id = await stored()
    fakes.store.fail = (command) => command[0] === "MGET"
    expect(await statuses({ ids: [id] })).toMatchObject({
      status: 503,
      body: { error: { code: "PERSISTENT_STORE_UNAVAILABLE" } },
    })
  })
})

describe("the owner's status script", () => {
  test("sets a status, keeps the record's expiry, and never creates a report that is gone", async () => {
    const id = await stored()
    fakes.store.now += 10 * 86_400_000
    const read = await setReportStatus(id, { status: "read" }, { fetcher: fakes.fetcher, now: fakes.store.now })
    expect(read).toMatchObject({ status: "read", updatedAt: fakes.store.now, createdAt: expect.any(Number) })
    expect(fakes.store.ttl(reportKey(id))).toBe(REPORT_RETENTION_MS - 10 * 86_400_000)
    const fixed = await setReportStatus(
      id,
      { status: "fixed", fixedIn: "1.99.114", commit: "0123abc" },
      { fetcher: fakes.fetcher },
    )
    expect(fixed).toMatchObject({ status: "fixed", fixedIn: "1.99.114", commit: "0123abc" })
    // Another status drops the release and commit, which belong to a fix.
    const reopened = await setReportStatus(id, { status: "fixing" }, { fetcher: fakes.fetcher })
    expect(reopened).not.toHaveProperty("fixedIn")
    expect(reopened).not.toHaveProperty("commit")
    const missing = newReportId()
    expect(await setReportStatus(missing, { status: "read" }, { fetcher: fakes.fetcher })).toBeUndefined()
    expect(fakes.store.get(reportKey(missing))).toBeUndefined()
    // The other mode's prefix holds nothing of this report.
    expect(await setReportStatus(id, { status: "read" }, { fetcher: fakes.fetcher, mode: "live" })).toBeUndefined()
    expect(await setReportStatus(id, { status: "read" }, { fetcher: fakes.fetcher, mode: "test" })).toBeDefined()
  })

  test("refuses a fixed status without its release, and malformed ids, versions and commits", async () => {
    const id = await stored()
    await expect(setReportStatus(id, { status: "fixed" }, { fetcher: fakes.fetcher })).rejects.toThrow("release")
    await expect(setReportStatus(id, { status: "fixed", fixedIn: "next" }, { fetcher: fakes.fetcher })).rejects.toThrow(
      "version",
    )
    await expect(
      setReportStatus(id, { status: "fixed", fixedIn: "1.99.114", commit: "xyz" }, { fetcher: fakes.fetcher }),
    ).rejects.toThrow("commit")
    await expect(setReportStatus("r_nope", { status: "read" }, { fetcher: fakes.fetcher })).rejects.toThrow("report id")
    await expect(setReportStatus(id, { status: "lost" as never }, { fetcher: fakes.fetcher })).rejects.toThrow("status")
  })

  test("reads its command line", () => {
    const id = newReportId()
    expect(parseReportStatusArguments([id, "fixed", "--fixed-in", "1.99.114", "--commit", "ABC1234"])).toEqual({
      id,
      status: "fixed",
      fixedIn: "1.99.114",
      commit: "abc1234",
    })
    expect(parseReportStatusArguments([id, "read", "--mode", "live"])).toEqual({ id, status: "read", mode: "live" })
    for (const argv of [
      [],
      [id],
      [id, "fixed"],
      [id, "read", "--fixed-in", "1.99.114"],
      [id, "lost"],
      ["r_short", "read"],
      [id, "read", "--mode", "prod"],
      [id, "read", "--note", "anything"],
      [id, "read", "extra"],
    ])
      expect(() => parseReportStatusArguments(argv)).toThrow()
  })

  test("records a fix under exactly one release in the public list, sorted, and takes it back", () => {
    const a = "r_aaaaaaaaaaaaaaaaaaaaaaaaaa"
    const b = "r_bbbbbbbbbbbbbbbbbbbbbbbbbb"
    let list = withFixedReport({}, "1.99.114", a)
    list = withFixedReport(list, "1.99.113", b)
    list = withFixedReport(list, "1.99.114", b)
    expect(list).toEqual({ "1.99.114": [reportHash(a), reportHash(b)].sort() })
    expect(Object.keys(withFixedReport(list, "1.99.120", a))).toEqual(["1.99.114", "1.99.120"])
    expect(validFixedReports(list)).toBe(true)
    expect(withoutFixedReport(list, a)).toEqual({ "1.99.114": [reportHash(b)] })
    expect(withoutFixedReport(withoutFixedReport(list, a), b)).toEqual({})
    expect(JSON.stringify(list)).not.toContain(a)
  })

  test("erases an account's reports and its index, for account deletion", async () => {
    const mine = [await stored({ account: ACCOUNT }), await stored({ account: ACCOUNT })]
    const anonymous = await stored()
    expect(fakes.store.members(accountReportsKey(ACCOUNT)).sort()).toEqual([...mine].sort())
    expect(await eraseAccountReports(ACCOUNT, fakes.fetcher)).toBe(2)
    expect(mine.map((id) => fakes.store.get(reportKey(id)))).toEqual([undefined, undefined])
    expect(fakes.store.members(accountReportsKey(ACCOUNT))).toEqual([])
    expect(fakes.store.get(reportKey(anonymous))).toBeDefined()
    expect(await readReportViews(mine, fakes.fetcher)).toEqual([])
    expect(await eraseAccountReports(ACCOUNT, fakes.fetcher)).toBe(0)
  })

  test("a report sent before go-live keeps its status and is erased with its account once the server runs live", async () => {
    // Production writes under the test prefix until a live Stripe key is configured.
    const before = await stored({ account: ACCOUNT })
    const anonymous = await stored()
    expect(await setReportStatus(before, { status: "read" }, { mode: "test", fetcher: fakes.fetcher })).toMatchObject({
      status: "read",
    })
    process.env.CODIUM_STRIPE_MODE = "live"
    const after = await stored({ account: ACCOUNT })
    expect(reportKey(after)).toStartWith("vector:codium:live:reports:")
    expect(
      (await readReportViews([before, after, anonymous], fakes.fetcher)).map((view) => [view.id, view.status]),
    ).toEqual([
      [before, "read"],
      [after, "received"],
      [anonymous, "received"],
    ])
    const answer = await statuses({ ids: [before] })
    expect(answer.status).toBe(200)
    expect(answer.body.reports).toEqual([{ id: before, status: "read", updatedAt: expect.any(Number) }])
    // Deleting the account erases both prefixes' records and indexes; the anonymous report was never linked.
    expect(await eraseAccountReports(ACCOUNT, fakes.fetcher)).toBe(2)
    expect(fakes.store.get(reportKey(before, "test"))).toBeUndefined()
    expect(fakes.store.get(reportKey(after, "live"))).toBeUndefined()
    expect(fakes.store.members(accountReportsKey(ACCOUNT, "test"))).toEqual([])
    expect(fakes.store.members(accountReportsKey(ACCOUNT, "live"))).toEqual([])
    expect(fakes.store.get(reportKey(anonymous, "test"))).toBeDefined()
    // A test server never reads the live prefix.
    process.env.CODIUM_STRIPE_MODE = "test"
    const live = newReportId()
    fakes.store.command([
      "SET",
      reportKey(live, "live"),
      JSON.stringify({ v: 1, status: "read", createdAt: 1, updatedAt: 1 }),
    ])
    expect(await readReportViews([live], fakes.fetcher)).toEqual([])
  })
})

describe("the public fixed list and the changelog", () => {
  test("the committed fixed list is well formed", () => {
    expect(validFixedReports(fixedReportsFile)).toBe(true)
    expect(() => fixedReportHashes(fixedReportsFile)).not.toThrow()
  })

  test("a release lists the hashes of the reports it fixed, and other releases list none", () => {
    const hash = reportHash("r_aaaaaaaaaaaaaaaaaaaaaaaaaa")
    const releases = changelogReleases({ "1.99.112": [hash] })
    expect(releases.find((release) => release.tag === "v1.99.112")).toMatchObject({ fixedReports: [hash] })
    expect(releases.filter((release) => "fixedReports" in release).map((release) => release.tag)).toEqual(["v1.99.112"])
    // With nothing fixed, the changelog is exactly what it was before the tracker.
    expect(changelogReleases({}).some((release) => "fixedReports" in release)).toBe(false)
  })

  test("a malformed fixed list fails the changelog build", () => {
    for (const value of [
      [],
      { next: [] },
      { "1.99.114": ["r_aaaaaaaaaaaaaaaaaaaaaaaaaa"] },
      { "1.99.114": ["0123456789abcdef", "0123456789abcdef"] },
    ])
      expect(() => fixedReportHashes(value)).toThrow()
  })
})

describe("read first", () => {
  test("can be listed only where reports reach the owner", () => {
    expect(perkServices["reports-first"]?.(fakes.fetcher)).toBe(true)
    delete process.env.RESEND_API_KEY
    expect(perkServices["reports-first"]?.(fakes.fetcher)).toBe(false)
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("on a real Valkey (CI only)", () => {
  test("records, expiry, status updates, reads and erasure behave as the fake does", async () => {
    const client = new RedisClient(valkeyURL!)
    // The store's REST commands, sent to Valkey as they are.
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).origin !== REPORT_KV_URL) throw new Error(`Unexpected request to ${String(input)}`)
      const [name, ...args] = JSON.parse(String(init?.body)) as (string | number)[]
      return Response.json({ result: await client.send(String(name), args.map(String)) })
    }) as typeof fetch
    const account = randomUUID()
    const id = newReportId()
    try {
      expect(await createReportRecord(id, { tag: "max", readFirst: true, account }, fetcher)).toBe(true)
      expect(await createReportRecord(id, {}, fetcher)).toBe(false)
      const ttl = Number(await client.send("PTTL", [reportKey(id)]))
      expect(ttl).toBeGreaterThan(REPORT_RETENTION_MS - 60_000)
      expect(Number(await client.send("PTTL", [accountReportsKey(account)]))).toBeGreaterThan(
        REPORT_RETENTION_MS - 60_000,
      )
      expect(await setReportStatus(id, { status: "fixed", fixedIn: "1.99.114" }, { fetcher })).toMatchObject({
        status: "fixed",
        fixedIn: "1.99.114",
      })
      // KEEPTTL: the status update kept the record's expiry.
      expect(Number(await client.send("PTTL", [reportKey(id)]))).toBeGreaterThan(REPORT_RETENTION_MS - 120_000)
      const missing = newReportId()
      expect(await setReportStatus(missing, { status: "read" }, { fetcher })).toBeUndefined()
      expect(await client.send("EXISTS", [reportKey(missing)])).toBe(0)
      expect(await readReportViews([id, missing], fetcher)).toEqual([
        { id, status: "fixed", updatedAt: expect.any(Number), fixedIn: "1.99.114" },
      ])
      expect(await eraseAccountReports(account, fetcher)).toBe(1)
      expect(await readReportViews([id], fetcher)).toEqual([])
    } finally {
      await client.send("DEL", [reportKey(id), accountReportsKey(account)])
      client.close()
    }
  })
})
