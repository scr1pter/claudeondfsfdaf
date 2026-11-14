import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { listReports, reportHash, reportStatuses, reportTitle, sendBugReport } from "./bug-report"

// WP A33 on the desktop: a sent report's id is kept in userData's reports.json with a 60-character title of its own;
// the renderer gets hashes and titles, never ids; statuses come from vectordev.ai through Vector Local's
// `report-status` source. Requests go to a fake; any other connection off this computer throws.
const guard = NetworkGuard.use()

const ID = "r_abcdefghijklmnopqrstuvwxyz"
const NOW = Date.UTC(2026, 10, 2, 12)
let directory = ""
let file = ""
type Call = { url: string; authorization?: string; body: Record<string, unknown> }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vector-reports-"))
  file = join(directory, "reports.json")
})
afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await rm(directory, { recursive: true, force: true })
})

function service(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call = {
      url: String(input),
      ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, fetcher }
}

const deps = (fetcher: typeof fetch, token?: string) => ({
  fetch: fetcher,
  file,
  now: () => NOW,
  version: "1.99.113",
  ...(token ? { token: async () => token } : {}),
})

test("keeps the report's id with a 60-character title, and the renderer sees only its hash", async () => {
  const { calls, fetcher } = service(() => Response.json({ delivered: true, id: "email_1", report: { id: ID } }))
  const message = `\n  ${"The diff view froze when I opened a very large JSON file in the review pane".padEnd(90, "!")}\nmore`
  const result = await sendBugReport({ message, email: "me@example.invalid" }, deps(fetcher, "vct_signed.token"))
  expect(result).toEqual({ delivered: true, tracked: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe("https://vectordev.ai/api/support/bug-report")
  expect(calls[0]!.authorization).toBe("Bearer vct_signed.token")
  expect(calls[0]!.body).toMatchObject({ version: "1.99.113", email: "me@example.invalid" })
  const stored = JSON.parse(await readFile(file, "utf8")) as {
    reports: { id: string; title: string; sentAt: number }[]
  }
  expect(stored.reports).toEqual([{ id: ID, title: reportTitle(message), sentAt: NOW }])
  expect(reportTitle(message)).toHaveLength(60)
  expect(reportTitle(message).startsWith("The diff view froze")).toBe(true)
  const listed = await listReports(deps(fetcher))
  expect(listed).toEqual([
    { hash: createHash("sha256").update(ID).digest("hex").slice(0, 16), title: reportTitle(message), sentAt: NOW },
  ])
  expect(JSON.stringify(listed)).not.toContain(ID)
  expect(listed[0]!.hash).toBe(reportHash(ID))
  expect(guard.outside()).toEqual([])
})

test("a token vectordev.ai refuses never costs the report: it is sent again without one", async () => {
  const { calls, fetcher } = service((call) =>
    call.authorization
      ? Response.json({ error: { code: "CLI_TOKEN_INVALID", message: "Sign in again" } }, { status: 401 })
      : Response.json({ delivered: true, id: "email_1", report: { id: ID } }),
  )
  expect(await sendBugReport({ message: "Broken" }, deps(fetcher, "vct_revoked.token"))).toEqual({
    delivered: true,
    tracked: true,
  })
  expect(calls.map((call) => call.authorization ?? "none")).toEqual(["Bearer vct_revoked.token", "none"])
})

test("an answer without a report id is delivered but not tracked, and errors keep their message", async () => {
  const untracked = service(() => Response.json({ delivered: true, id: "email_1" }))
  expect(await sendBugReport({ message: "Broken" }, deps(untracked.fetcher))).toEqual({
    delivered: true,
    tracked: false,
  })
  expect(await listReports(deps(untracked.fetcher))).toEqual([])
  const limited = service(() => Response.json({ error: { message: "Too many requests." } }, { status: 429 }))
  expect(await sendBugReport({ message: "Broken" }, deps(limited.fetcher))).toEqual({
    delivered: false,
    error: "Too many requests.",
  })
  expect(limited.calls).toHaveLength(1)
})

test("statuses come from vectordev.ai by id, in the body, and reach the renderer without ids", async () => {
  await writeFile(
    file,
    JSON.stringify({
      reports: [
        { id: ID, title: "Froze", sentAt: NOW - 1000 },
        { id: "r_bbbbbbbbbbbbbbbbbbbbbbbbbb", title: "Closed", sentAt: NOW - 500 },
        { id: "r_cccccccccccccccccccccccccc", title: "Too old", sentAt: NOW - 181 * 86_400_000 },
        { id: "not-an-id", title: "Junk", sentAt: NOW },
      ],
    }),
  )
  const { calls, fetcher } = service(() =>
    Response.json({
      reports: [
        { id: ID, status: "fixed", fixedIn: "1.99.114", commit: "abc1234", updatedAt: NOW },
        { id: "r_bbbbbbbbbbbbbbbbbbbbbbbbbb", status: "Not A Status!", updatedAt: NOW },
      ],
    }),
  )
  const result = await reportStatuses(deps(fetcher))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe("https://vectordev.ai/api/support/reports")
  expect(calls[0]!.body).toEqual({ ids: ["r_bbbbbbbbbbbbbbbbbbbbbbbbbb", ID] })
  expect(result).toEqual({
    checked: "ok",
    reports: [
      { hash: reportHash("r_bbbbbbbbbbbbbbbbbbbbbbbbbb"), title: "Closed", sentAt: NOW - 500 },
      {
        hash: reportHash(ID),
        title: "Froze",
        sentAt: NOW - 1000,
        status: "fixed",
        fixedIn: "1.99.114",
        commit: "abc1234",
      },
    ],
  })
  expect(JSON.stringify(result)).not.toContain("r_")
})

test("Vector Local keeps the status check off, and a failed check still lists the reports", async () => {
  await writeFile(file, JSON.stringify({ reports: [{ id: ID, title: "Froze", sentAt: NOW }] }))
  const { calls, fetcher } = service(() => Response.json({ reports: [] }))
  Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
  expect(await reportStatuses(deps(fetcher))).toEqual({
    checked: "local-off",
    reports: [{ hash: reportHash(ID), title: "Froze", sentAt: NOW }],
  })
  expect(calls).toEqual([])
  expect(Egress.events({ blocked: true }).map((event) => `${event.source} ${event.origin}`)).toContain(
    "report-status https://vectordev.ai",
  )
  Egress.configure(LocalPolicy.OFF)
  const failing = service(() => new Response("down", { status: 503 }))
  expect((await reportStatuses(deps(failing.fetcher))).checked).toBe("unavailable")
  // No reports, no request.
  await rm(file)
  const idle = service(() => Response.json({ reports: [] }))
  expect(await reportStatuses(deps(idle.fetcher))).toEqual({ reports: [], checked: "ok" })
  expect(idle.calls).toEqual([])
  expect(guard.outside()).toEqual([])
})
