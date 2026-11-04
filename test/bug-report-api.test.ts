import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mintCliToken } from "../api/_lib/cli-token"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import {
  accountReportsKey,
  REPORT_ID,
  REPORT_RETENTION_MS,
  reportEmailConfigured,
  reportKey,
  reportSubjectTag,
} from "../api/_lib/support-reports"
import { handleBugReport } from "../api/support/bug-report"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { invoke, jsonHeaders, reportEnvironment, reportFakes } from "./support-reports-fixture"

// WP A33: the report tracker on the bug-report route. A report gets an `r_` id that goes in the owner's email and the
// answer (which keeps the email's `id`); the store keeps metadata only (P4); an account token gives the plan's subject
// tag and hourly limit while the plan is active or renewing; reports without a sign-in stay at 5 an hour per address.

const ACCOUNT = "4f9a1c2e-7b3d-4e8f-9a6b-1c2d3e4f5a6b"
const EMAIL = "subscriber@example.invalid"
const MESSAGE = "The diff view froze after I opened a 4 MB file.\nSteps: open big.json, scroll."
const REPLY = "Reporter@Example.invalid"

let restore = () => {}
let fakes = reportFakes()
const originalFetch = globalThis.fetch
beforeEach(() => {
  restore = reportEnvironment()
  fakes = reportFakes()
  // The email SDK sends with the global fetch.
  globalThis.fetch = fakes.fetcher
})
afterEach(() => {
  globalThis.fetch = originalFetch
  restore()
})

const token = (client?: "desktop" | "cli") => mintCliToken({ id: ACCOUNT, email: EMAIL }, Date.now(), client).token

function report(input: { ip?: string; authorization?: string; body?: Record<string, unknown> } = {}) {
  return invoke((request, response) => handleBugReport(request, response, fakes.fetcher), {
    headers: jsonHeaders(input.ip ?? "192.0.2.10", input.authorization ? { authorization: input.authorization } : {}),
    body: input.body ?? { message: MESSAGE, email: REPLY, version: "1.99.113", platform: "darwin", channel: "prod" },
  })
}

function seedPlan(plan: PlanId | null, state: SnapshotFacts["state"] = "active") {
  const now = Date.now()
  const snapshot = buildSnapshot(
    {
      account: ACCOUNT,
      state,
      ...(state === "paused" ? { reason: "payment_failed" as const } : {}),
      ...(state === "frozen" ? { reason: "disputed" as const } : {}),
      ...(state === "ended" ? { reason: "canceled" as const } : {}),
      plan,
      ...(plan ? { subscription: "sub_report" } : {}),
      periodStart: now - 86_400_000,
      periodEnd: now + 29 * 86_400_000,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    undefined,
    now,
  )
  fakes.store.command(["SET", snapshotKey(ACCOUNT), JSON.stringify(snapshot)])
}

/** Every value the report route wrote to a report key (record or index), as the store received them. */
function reportWrites() {
  return fakes.store.commands.filter((command) => command.slice(1).some((part) => part.includes(":reports:")))
}

describe("report ids and the answer", () => {
  test("a report gets an r_ id that goes in the email and the answer, which keeps the email's id", async () => {
    const result = await report()
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ delivered: true, id: "email_1", report: { status: "received" } })
    const id = result.body.report.id as string
    expect(id).toMatch(REPORT_ID)
    expect(id).toMatch(/^r_[a-z2-7]{26}$/)
    const [email] = fakes.mail.sent
    expect(email!.text).toContain(`Report: ${id}`)
    expect(email!.html).toContain(id)
    expect(email!.subject).toBe("Vector bug report · v1.99.113")
    // Ids are random: a second report gets another.
    const second = await report({ ip: "192.0.2.11" })
    expect(second.body.report.id).not.toBe(id)
  })

  test("the record is metadata only, kept 180 days, and never holds the message or the reply address (P4)", async () => {
    const result = await report()
    const id = result.body.report.id as string
    const stored = fakes.store.get(reportKey(id))!
    const record = JSON.parse(stored) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(["createdAt", "status", "updatedAt", "v"])
    expect(record).toMatchObject({ v: 1, status: "received" })
    expect(fakes.store.ttl(reportKey(id))).toBe(REPORT_RETENTION_MS)
    // Nothing the person wrote reaches the store, in any command the route sent.
    const everything = fakes.store.commands.flat().join("\n")
    for (const fragment of ["froze", "big.json", "Steps", REPLY.toLowerCase(), REPLY, "darwin", "1.99.113"])
      expect(everything).not.toContain(fragment)
    // Signed out, the report is linked to no one.
    expect(fakes.store.keys().filter((key) => key.includes(":reports:acct:"))).toEqual([])
    expect(reportWrites().every((command) => command[0] === "SET")).toBe(true)
  })

  test("the record key carries the Codium mode prefix", async () => {
    const id = (await report()).body.report.id as string
    expect(reportKey(id)).toBe(`vector:codium:test:reports:${id}`)
    expect(fakes.store.get(`vector:codium:test:reports:${id}`)).toBeDefined()
  })

  test("a store that cannot be written still delivers the report, without an id", async () => {
    fakes.store.fail = (command) => command[0] === "SET"
    const result = await report()
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ delivered: true, id: "email_1" })
    expect(fakes.mail.sent[0]!.text).not.toContain("Report:")
  })

  test("the report goes to VECTOR_BUG_REPORT_TO, and without it answers 503 and stores nothing", async () => {
    expect((await report()).status).toBe(200)
    expect(fakes.mail.sent[0]!.to).toBe("owner@example.invalid")
    delete process.env.VECTOR_BUG_REPORT_TO
    expect(reportEmailConfigured()).toBe(false)
    const result = await report({ ip: "192.0.2.12" })
    expect(result).toMatchObject({ status: 503, body: { error: { code: "EMAIL_NOT_CONFIGURED" } } })
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.store.keys().filter((key) => key.includes(":reports:"))).toHaveLength(1)
  })

  test("a failed email answers 502 and drops the record it had written", async () => {
    fakes.mail.fail = true
    const result = await report({ authorization: `Bearer ${token("desktop")}` })
    expect(result).toMatchObject({ status: 502, body: { error: { code: "EMAIL_FAILED" } } })
    expect(fakes.store.keys().filter((key) => key.includes(":reports:"))).toEqual([])
  })
})

describe("plan tags and limits", () => {
  test("subject tags name the plan, and Max and Ultra read first", () => {
    expect(reportSubjectTag({ tag: "plus", readFirst: false })).toBe("[Plus]")
    expect(reportSubjectTag({ tag: "pro", readFirst: false })).toBe("[Pro]")
    expect(reportSubjectTag({ tag: "max", readFirst: true })).toBe("[Max · read first]")
    expect(reportSubjectTag({ tag: "ultra", readFirst: true })).toBe("[Ultra · read first]")
  })

  test.each([
    ["vector-10", "[Plus] Vector bug report · v1.99.113", "plus", false],
    ["vector-50", "[Pro] Vector bug report · v1.99.113", "pro", false],
    ["vector-100", "[Max · read first] Vector bug report · v1.99.113", "max", true],
    ["vector-200", "[Ultra · read first] Vector bug report · v1.99.113", "ultra", true],
  ] as const)("an active %s account's report is tagged %s", async (plan, subject, tag, readFirst) => {
    seedPlan(plan)
    const result = await report({ authorization: `Bearer ${token("desktop")}` })
    expect(result.status).toBe(200)
    const id = result.body.report.id as string
    expect(fakes.mail.sent[0]!.subject).toBe(subject)
    expect(fakes.mail.sent[0]!.text).toContain(`Plan: ${reportSubjectTag({ tag, readFirst })}`)
    expect(JSON.parse(fakes.store.get(reportKey(id))!)).toMatchObject({ tag, readFirst })
    // Signed in, the report is in the account's index (for deletion), kept as long as the reports.
    expect(fakes.store.members(accountReportsKey(ACCOUNT))).toEqual([id])
    expect(fakes.store.ttl(accountReportsKey(ACCOUNT))).toBe(REPORT_RETENTION_MS)
    expect(accountReportsKey(ACCOUNT)).not.toContain(ACCOUNT)
  })

  test("a renewing plan keeps its tag; paused, ended and frozen plans and no plan get none", async () => {
    // Without a reply address, which has its own limit of 3 a day.
    const signed = () =>
      report({ authorization: `Bearer ${token("desktop")}`, body: { message: MESSAGE, version: "1.99.113" } })
    seedPlan("vector-100", "renewing")
    expect((await signed()).status).toBe(200)
    expect(fakes.mail.sent.at(-1)!.subject).toBe("[Max · read first] Vector bug report · v1.99.113")
    for (const state of ["paused", "ended", "frozen"] as const) {
      seedPlan("vector-200", state)
      expect((await signed()).status).toBe(200)
      expect(fakes.mail.sent.at(-1)!.subject).toBe("Vector bug report · v1.99.113")
    }
    // A new hour: the free limit of 5 would otherwise stop the sixth report of this case.
    for (const key of fakes.store.keys().filter((key) => key.startsWith("vector:abuse:")))
      fakes.store.command(["DEL", key])
    seedPlan(null, "none")
    expect((await signed()).status).toBe(200)
    expect(fakes.mail.sent.at(-1)!.subject).toBe("Vector bug report · v1.99.113")
    fakes.store.command(["DEL", snapshotKey(ACCOUNT)])
    expect((await signed()).status).toBe(200)
    expect(fakes.mail.sent.at(-1)!.subject).toBe("Vector bug report · v1.99.113")
    // Never a Stripe call: the tag comes from the stored snapshot alone.
    expect(fakes.store.commands.some((command) => command.join(" ").includes("stripe"))).toBe(false)
  })

  const send = async (count: number, authorization?: string, ip = "192.0.2.20") => {
    const statuses: number[] = []
    for (let index = 0; index < count; index++)
      statuses.push(
        (await report({ ip, ...(authorization ? { authorization } : {}), body: { message: `Report ${index}` } }))
          .status,
      )
    return statuses
  }

  test("without a sign-in, 5 reports an hour per address", async () => {
    expect(await send(6)).toEqual([200, 200, 200, 200, 200, 429])
    // Another address has its own count.
    expect(await send(1, undefined, "192.0.2.21")).toEqual([200])
  })

  test("signed in: free 5, Plus and Pro 15, Max and Ultra 30 an hour, per account", async () => {
    const authorization = `Bearer ${token("desktop")}`
    expect(await send(6, authorization)).toEqual([...Array(5).fill(200), 429])
    for (const [plan, limit] of [
      ["vector-10", 15],
      ["vector-50", 15],
      ["vector-100", 30],
      ["vector-200", 30],
    ] as const) {
      fakes = reportFakes()
      globalThis.fetch = fakes.fetcher
      seedPlan(plan)
      // The limit follows the account, not the address.
      const statuses: number[] = []
      for (let index = 0; index <= limit; index++)
        statuses.push(
          (await report({ ip: `198.51.100.${index % 4}`, authorization, body: { message: `Report ${index}` } })).status,
        )
      expect(statuses).toEqual([...Array(limit).fill(200), 429])
    }
  })

  test("free accounts on one address share its 5 reports an hour, so making accounts never raises it", async () => {
    const free = () =>
      `Bearer ${mintCliToken({ id: randomUUID(), email: "free@example.invalid" }, Date.now(), "desktop").token}`
    const statuses: number[] = []
    for (let index = 0; index < 6; index++)
      statuses.push(
        (await report({ ip: "192.0.2.40", authorization: free(), body: { message: `Report ${index}` } })).status,
      )
    expect(statuses).toEqual([...Array(5).fill(200), 429])
    // Reports without a sign-in from that address count against the same 5.
    expect((await report({ ip: "192.0.2.40", body: { message: "Signed out" } })).status).toBe(429)
    // A paid account on that address has its own plan limit, under the address's signed-in ceiling.
    seedPlan("vector-10")
    expect(
      (await report({ ip: "192.0.2.40", authorization: `Bearer ${token("desktop")}`, body: { message: "Paid" } }))
        .status,
    ).toBe(200)
  })

  test("a paused plan's account is held to the free limit", async () => {
    seedPlan("vector-200", "paused")
    expect(await send(6, `Bearer ${token("desktop")}`)).toEqual([...Array(5).fill(200), 429])
  })

  test("CLI and unmarked account tokens count too: reports spend nothing", async () => {
    seedPlan("vector-50")
    expect((await report({ authorization: `Bearer ${token("cli")}` })).status).toBe(200)
    expect((await report({ authorization: `Bearer ${token()}` })).status).toBe(200)
    expect(fakes.mail.sent.map((email) => email.subject)).toEqual([
      "[Pro] Vector bug report · v1.99.113",
      "[Pro] Vector bug report · v1.99.113",
    ])
  })

  test("a token that is not a valid, unrevoked account token is refused with 401, run tokens included (S3)", async () => {
    seedPlan("vector-200")
    for (const authorization of [
      "Bearer vrt_fixture.signature",
      "Bearer vht_fixture.signature",
      `Bearer ${token("desktop").slice(0, -2)}xx`,
      "Basic abc",
      "Bearer ",
    ]) {
      const result = await report({ authorization })
      expect(result.status).toBe(401)
    }
    fakes.store.command(["SET", `vector:cli-revoked:${ACCOUNT}`, "1"])
    expect((await report({ authorization: `Bearer ${token("desktop")}` })).status).toBe(401)
    expect(fakes.mail.sent).toEqual([])
  })
})
