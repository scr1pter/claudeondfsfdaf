import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Hosted } from "../packages/schema/src/hosted"
import {
  handleHostedComputers,
  handleHostedHeartbeat,
  handleHostedSessionAction,
  handleHostedSessions,
  handleHostedStatus,
} from "../api/_lib/hosted-api"
import { computerName } from "../api/_lib/hosted-provider"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import { ACCOUNT_ID, hostedSessionEnvironment, hostedWorld, invoke } from "./hosted-sessions-fixture"

// WP A53: what the cloud computer tells people and computers carries copy fields and numeric fields named as counts,
// shares and times only, never an amount (P1); its copy never mentions GitHub or Actions and makes no promise (H3,
// H4); and the hosted rates are imported by no client package.

const root = path.join(import.meta.dir, "..")

let ledger: LedgerBackend
let restore = () => {}
beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = hostedSessionEnvironment()
  await ledger.reset()
})
afterEach(() => restore())

/** Every numeric field any hosted answer may carry: counts, shares, sizes in plain units, and times in ms. */
const NUMERIC_FIELDS = new Set([
  "computer",
  "computers",
  "hours",
  "jobMinutes",
  "diskDays",
  "used",
  "createdAt",
  "deadline",
  "runningAt",
  "endedAt",
  "wrapBy",
  "since",
  "until",
  "requestedAt",
  "readyAt",
  "rampUntil",
  "expiresAt",
  "disksDeletedAt",
])
/** Every text field: states, reasons, names, ids, links and the viewer key. */
const TEXT_FIELDS = new Set([
  "id",
  "state",
  "reason",
  "size",
  "source",
  "title",
  "access",
  "control",
  "viewerKey",
  "prompt",
  "url",
  "mode",
  "session",
  "content-length",
  "content-type",
  "host",
  "x-amz-content-sha256",
])
const MONEY = /\$|usd|price|cost|credit|cents|micro|charge|rate|amount|dollar|pool/i

function walk(value: unknown, at: string, found: { key: string; value: unknown; at: string }[]) {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`, found))
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      found.push({ key, value: item, at: `${at}.${key}` })
      walk(item, `${at}.${key}`, found)
    }
}

function expectCopyAndCounts(answer: unknown) {
  const fields: { key: string; value: unknown; at: string }[] = []
  walk(answer, "$", fields)
  for (const field of fields) {
    expect(field.key).not.toMatch(MONEY)
    if (typeof field.value === "number") {
      expect([field.at, NUMERIC_FIELDS.has(field.key)]).toEqual([field.at, true])
      expect(Number.isFinite(field.value)).toBe(true)
      expect(field.value).toBeGreaterThanOrEqual(0)
      if (field.key === "used") expect(field.value).toBeLessThanOrEqual(1)
    }
    if (typeof field.value === "string" && !/^\d+$/.test(field.key))
      expect([field.at, TEXT_FIELDS.has(field.key)]).toEqual([field.at, true])
  }
}

describe("hosted answers carry copy fields and counts only (P1)", () => {
  test("start, list, status, computers, viewer, files and the heartbeat", async () => {
    const w = await hostedWorld(ledger)
    const call = (handler: Parameters<typeof invoke>[0], input: Parameters<typeof invoke>[1]) => invoke(handler, input)
    const start = await call((q, r) => handleHostedSessions(q, r, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 45, prompt: "Check the site.", title: "Site check" },
    })
    expect(start.status).toBe(201)
    const id = start.body.session.id as string
    const answers = [
      start.body,
      (await call((q, r) => handleHostedSessions(q, r, w.options), { method: "GET", authorization: w.desktopToken() })).body,
      (await call((q, r) => handleHostedStatus(q, r, w.options), { method: "GET", authorization: w.desktopToken() })).body,
      (await call((q, r) => handleHostedComputers(q, r, w.options), { method: "GET", authorization: w.desktopToken() })).body,
      (
        await call((q, r) => handleHostedSessionAction(q, r, "viewer", w.options), {
          method: "POST",
          authorization: w.desktopToken(),
          body: { mode: "view" },
          query: { id },
        })
      ).body,
      (
        await call((q, r) => handleHostedSessionAction(q, r, "download", w.options), {
          method: "POST",
          authorization: w.desktopToken(),
          body: {},
          query: { id },
        })
      ).body,
      (
        await call((q, r) => handleHostedHeartbeat(q, r, w.options), {
          method: "POST",
          authorization: w.provider.token(computerName(ACCOUNT_ID, 1))!,
          body: { cpu: 5, archiveBytes: 1024 },
          query: { id },
        })
      ).body,
    ]
    for (const answer of answers) {
      expect(answer.error).toBeUndefined()
      expectCopyAndCounts(answer)
    }
    // The upload link is signed for exactly the packed size, not a figure about money.
    expect(answers[6].upload.headers["content-length"]).toBe("1024")
  })

  test("the schema's vocabulary names no amount", () => {
    for (const name of Object.keys(Hosted)) expect(name).not.toMatch(MONEY)
    for (const code of Object.keys(Hosted.ERROR_CODES)) expect(code).toStartWith("HOSTED_")
    expect(Object.values(Hosted.ERROR_CODES).every((status) => status >= 400 && status < 600)).toBe(true)
  })
})

describe("copy (H3, H4)", () => {
  const files = [
    ...new Bun.Glob("api/_lib/hosted-*.ts").scanSync({ cwd: root }),
    ...new Bun.Glob("api/hosted/**/*.ts").scanSync({ cwd: root }),
  ]

  test("every message the cloud computer sends names no amount, GitHub or Actions, and promises nothing", async () => {
    expect(files.length).toBeGreaterThan(15)
    const messages: string[] = []
    for (const file of files) {
      const text = await Bun.file(path.join(root, file)).text()
      for (const match of text.matchAll(/new ApiError\(\s*\d+,\s*"[A-Z_]+",\s*"([^"]+)"/g)) messages.push(match[1]!)
      for (const match of text.matchAll(/throw new ApiError\(\s*\d+,\s*"[A-Z_]+",\s*`([^`]+)`/g)) messages.push(match[1]!)
    }
    expect(messages.length).toBeGreaterThan(30)
    for (const raw of messages) {
      // A template's placeholders are code, not copy.
      const message = raw.replace(/\$\{[^}]*\}/g, "")
      expect(message).not.toMatch(/\$|\bGitHub\b|\bActions\b|guarantee|24\/7|\bSLA\b|exclusive|uptime|credits?\b/i)
      expect(message).not.toMatch(/\d+ ?(?:tokens|USD|dollars)/i)
    }
  })

  test("the hosted rates and the API's hosted modules are imported by no client package", async () => {
    const clients = ["packages/app/src", "packages/desktop/src", "packages/web/src", "packages/core/src", "packages/engine/src", "packages/schema/src", "packages/ui/src", "packages/sdk/js/src"]
    const offenders: string[] = []
    for (const directory of clients) {
      if (!(await Bun.file(path.join(root, directory, "..", "package.json")).exists()) && !directory.includes("sdk")) continue
      for (const file of new Bun.Glob(`${directory}/**/*.{ts,tsx,js,mjs,astro}`).scanSync({ cwd: root })) {
        const text = await Bun.file(path.join(root, file)).text()
        // Imports only: a comment may say where the rates live.
        if (/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*(?:hosted-rates|_lib\/hosted-)/.test(text)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("the run-API host (S7)", () => {
  test("answers only the computers' routes; everything else is sent to the website", async () => {
    const vercel = (await Bun.file(path.join(root, "vercel.json")).json()) as {
      redirects: { source: string; has?: { type: string; value: string }[]; destination: string }[]
    }
    const rules = vercel.redirects.filter((rule) => rule.has?.some((item) => item.type === "host" && item.value === Hosted.RUN_API_HOST))
    expect(rules).toHaveLength(1)
    expect(rules[0]!.destination).toBe("https://vectordev.ai/")
    const redirected = new RegExp(`^${rules[0]!.source}$`)
    for (const kept of [
      "/api/hosted/sessions/hs_abcdefghijklmnopqrstuvwxyz/heartbeat",
      "/api/model-plans/chat",
      "/api/model-plans/models",
      "/api/model-plans/estimate",
    ])
      expect([kept, redirected.test(kept)]).toEqual([kept, false])
    for (const sent of ["/", "/account", "/api/model-plans/status", "/api/account/delete", "/api/hosted/status", "/api/owner/codium"])
      expect([sent, redirected.test(sent)]).toEqual([sent, true])
  })
})

