import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { config, handleVercelSpend } from "../api/owner/spend-vercel"
import { codiumKey } from "../api/_lib/codium-keys"
import { readSwitch, readSwitchState, switchKey, switchAuditKey, writeSwitch } from "../api/_lib/codium-switches"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  codiumFakes,
  codiumTestEnvironment,
  FAKE_KV_URL,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

const now = Date.UTC(2026, 9, 28, 12)
const MAIN = "team_MainFixture"
const HOSTED = "team_HostedFixture"
const MAIN_SECRET = "main-webhook-fixture-secret"
const HOSTED_SECRET = "hosted-webhook-fixture-secret"
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    VERCEL_MAIN_TEAM_ID: MAIN,
    VERCEL_HOSTED_TEAM_ID: HOSTED,
    VERCEL_SPEND_WEBHOOK_SECRET_MAIN: MAIN_SECRET,
    VERCEL_SPEND_WEBHOOK_SECRET_HOSTED: HOSTED_SECRET,
    RESEND_API_KEY: "fixture-resend-key",
    VECTOR_PURCHASE_EMAIL_FROM: "Vector <billing@example.test>",
    CODIUM_OWNER_EMAIL: "owner@example.test",
  })
})
afterEach(() => restore())
const body = (teamId = HOSTED, thresholdPercent = 100) => ({
  teamId,
  thresholdPercent,
  budgetAmount: 500,
  currentSpend: 500,
})
const digest = (raw: string, secret: string) => createHmac("sha1", secret).update(raw).digest("hex")
async function callback(
  fakes: Pick<CodiumFakes, "fetcher">,
  input: unknown = body(),
  options: {
    signature?: string | string[] | null
    secret?: string
    raw?: string
    parsed?: unknown
    method?: string
  } = {},
) {
  const raw = options.raw ?? JSON.stringify(input)
  const signature = options.signature === undefined ? digest(raw, options.secret ?? HOSTED_SECRET) : options.signature
  const request = Object.assign(Readable.from([Buffer.from(raw)]), {
    method: options.method ?? "POST",
    headers: { ...(signature === null ? {} : { "x-vercel-signature": signature }), "content-type": "application/json" },
    ...(options.parsed === undefined ? {} : { body: options.parsed }),
  }) as ApiRequest
  let rawResponse = ""
  const headers: Record<string, unknown> = {}
  const response = {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers[name] = value
    },
    end(value?: string) {
      rawResponse = String(value ?? "")
    },
  } as unknown as ApiResponse
  await handleVercelSpend(request, response, fakes.fetcher, now)
  return {
    status: response.statusCode,
    body: JSON.parse(rawResponse) as Record<string, unknown>,
    raw: rawResponse,
    headers,
  }
}
function untouched(fakes: CodiumFakes) {
  expect(fakes.store.commands).toEqual([])
  expect(fakes.mail.sent).toEqual([])
  expect(fakes.stripe.calls).toEqual([])
  expect(fakes.openRouter.calls).toEqual([])
}

describe("A13 raw Vercel Spend signature and exact team binding", () => {
  test("pins the raw-body Vercel handler configuration", () => {
    expect(config).toEqual({ api: { bodyParser: false } })
  })
  test("verifies the exact whitespace and Unicode bytes before decoding", async () => {
    const fakes = codiumFakes({ now })
    const raw = `{\n  "teamId": "${MAIN}", "thresholdPercent": 50, "budgetAmount": 500, "currentSpend": 250, "note": "£ café"\n}\n`
    expect(await callback(fakes, undefined, { raw, secret: MAIN_SECRET })).toMatchObject({ status: 200 })
    expect(fakes.mail.sent).toHaveLength(1)
    const normalized = JSON.stringify(JSON.parse(raw))
    const other = codiumFakes({ now })
    expect(await callback(other, undefined, { raw: normalized, signature: digest(raw, MAIN_SECRET) })).toMatchObject({
      status: 401,
    })
    untouched(other)
  })
  test.each([
    { signature: null },
    { signature: "" },
    { signature: "a".repeat(39) },
    { signature: "g".repeat(40) },
    { signature: `sha1=${"a".repeat(40)}` },
    { signature: ["a".repeat(40), "b".repeat(40)] },
  ])("refuses missing, malformed or duplicate signature headers: %j", async ({ signature }) => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, body(), { signature })).toMatchObject({ status: 401 })
    untouched(fakes)
  })
  test("wrong signatures are refused before JSON parsing and known signatures still require valid JSON", async () => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, undefined, { raw: "{broken", signature: "a".repeat(40) })).toMatchObject({
      status: 401,
    })
    expect(await callback(fakes, undefined, { raw: "{broken" })).toMatchObject({ status: 400 })
    untouched(fakes)
  })
  test("a known team's secret cannot authenticate another configured or unknown team", async () => {
    for (const teamId of [HOSTED, "team_Unknown"]) {
      const fakes = codiumFakes({ now })
      expect(await callback(fakes, body(teamId), { secret: MAIN_SECRET })).toMatchObject({ status: 401 })
      untouched(fakes)
    }
  })
  test("a team missing its secret is refused even when another team is fully configured", async () => {
    const fakes = codiumFakes({ now })
    delete process.env.VERCEL_SPEND_WEBHOOK_SECRET_HOSTED
    expect(await callback(fakes)).toMatchObject({ status: 401 })
    untouched(fakes)
  })
  test("duplicate main/hosted team configuration cannot apply hosted controls to the website team", async () => {
    const fakes = codiumFakes({ now })
    process.env.VERCEL_HOSTED_TEAM_ID = MAIN
    expect(await callback(fakes, body(MAIN), { secret: MAIN_SECRET })).toMatchObject({ status: 503 })
    untouched(fakes)
  })
  test("the main team works independently when the hosted team is unconfigured", async () => {
    const fakes = codiumFakes({ now })
    delete process.env.VERCEL_HOSTED_TEAM_ID
    delete process.env.VERCEL_SPEND_WEBHOOK_SECRET_HOSTED
    expect(await callback(fakes, body(MAIN), { secret: MAIN_SECRET })).toMatchObject({ status: 200 })
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.store.get(switchKey("hosted"))).toBeUndefined()
  })
  test("a parsed substitute body, oversized raw body and wrong method never have effects", async () => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, body(), { parsed: body() })).toMatchObject({ status: 400 })
    expect(await callback(fakes, body(), { raw: " ".repeat(16_385) })).toMatchObject({ status: 413 })
    expect(await callback(fakes, body(), { method: "GET" })).toMatchObject({ status: 405 })
    untouched(fakes)
  })
  test.each([
    { ...body(), thresholdPercent: "100" },
    { ...body(), thresholdPercent: -1 },
    { ...body(), thresholdPercent: 75.5 },
    { ...body(), budgetAmount: -1 },
    { ...body(), budgetAmount: null },
    { ...body(), currentSpend: -1 },
    { ...body(), currentSpend: Number.MAX_SAFE_INTEGER + 1 },
    { ...body(), teamId: null },
    { type: "endOfBillingCycle", teamId: HOSTED },
    { type: "budget.reached", payload: body() },
  ])("a signed malformed or unsupported payload cannot mutate controls: %j", async (input) => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, input)).toMatchObject({ status: 400 })
    untouched(fakes)
  })
})

describe("A13 thresholds, idempotency and retry ordering", () => {
  test.each([
    [0, "on", 0],
    [49, "on", 0],
    [50, "on", 1],
    [74, "on", 1],
    [75, "no-new", 1],
    [99, "no-new", 1],
    [100, "stop", 1],
    [125, "stop", 1],
  ] as const)("hosted threshold %s applies %s and sends %s alert", async (threshold, value, emails) => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, body(HOSTED, threshold))).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe(value)
    expect(fakes.mail.sent).toHaveLength(emails)
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.openRouter.calls).toEqual([])
  })
  test.each([50, 75, 100])("main team threshold %s emails only, with no switch mutation", async (threshold) => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes, body(MAIN, threshold), { secret: MAIN_SECRET })).toMatchObject({ status: 200 })
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.store.commands.every((command) => command[0] === "SET")).toBe(true)
    expect(fakes.store.get(switchKey("hosted"))).toBeUndefined()
    expect(fakes.store.get(switchKey("sales"))).toBeUndefined()
  })
  test("the documented wholepercent threshold, not an inferred spend ratio, decides the guard", async () => {
    const lowSpend = codiumFakes({ now })
    expect(await callback(lowSpend, { ...body(), budgetAmount: 0, currentSpend: 0 })).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", lowSpend.fetcher, { fresh: true, now })).toBe("stop")
    const highSpend = codiumFakes({ now })
    expect(await callback(highSpend, { ...body(HOSTED, 50), currentSpend: 10_000 })).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", highSpend.fetcher, { fresh: true, now })).toBe("on")
  })
  test("replays produce one safety change, one audit and one deduplicated alert", async () => {
    const fakes = codiumFakes({ now })
    expect(await callback(fakes)).toMatchObject({ status: 200, body: { escalated: true } })
    expect(await callback(fakes)).toMatchObject({ status: 200, body: { escalated: false } })
    expect(fakes.store.zset(switchAuditKey()).size).toBe(1)
    expect(fakes.mail.sent).toHaveLength(1)
  })
  test("a late75 callback cannot downgrade an earlier100 stop or replace its generation", async () => {
    const fakes = codiumFakes({ now })
    await callback(fakes)
    const before = await readSwitchState("hosted", fakes.fetcher, { now })
    await callback(fakes, body(HOSTED, 75))
    expect(await readSwitchState("hosted", fakes.fetcher, { now })).toEqual(before)
    expect(fakes.store.zset(switchAuditKey()).size).toBe(1)
  })
  test("a stronger owner stop survives a75 callback; only an explicit owner action can reopen it", async () => {
    const fakes = codiumFakes({ now })
    await writeSwitch("hosted", "stop", "owner:fixture", fakes.fetcher, now)
    const before = await readSwitchState("hosted", fakes.fetcher, { now })
    await callback(fakes, body(HOSTED, 75))
    expect(await readSwitchState("hosted", fakes.fetcher, { now })).toEqual(before)
    await writeSwitch("hosted", "on", "owner:fixture", fakes.fetcher, now)
    // There is no signed timestamp/cycle to prove this callback old. Reopening never disables the spend guard.
    await callback(fakes, body(HOSTED, 75))
    expect(await readSwitch("hosted", fakes.fetcher, { now })).toBe("no-new")
  })
  test("a legacy billing-cycle event never reopens a stopped guard", async () => {
    const fakes = codiumFakes({ now })
    await callback(fakes)
    expect(await callback(fakes, { ...body(HOSTED, 0), type: "endOfBillingCycle" })).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
  })
  test.each([
    ["on", 75, "no-new"],
    ["no-new", 100, "stop"],
    ["stop", 75, "stop"],
  ] as const)("legacy bare hosted state %s at %s converges to %s", async (previous, threshold, value) => {
    const fakes = codiumFakes({ now })
    fakes.store.set(switchKey("hosted"), previous)
    expect(await callback(fakes, body(HOSTED, threshold))).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe(value)
  })
  test("a store failure after the guard write keeps the stop and notification retryable", async () => {
    const fakes = codiumFakes({ now })
    const original = fakes.fetcher
    let failed = false
    fakes.fetcher = (async (input, init) => {
      const command = new URL(String(input)).origin === FAKE_KV_URL ? (JSON.parse(String(init?.body)) as string[]) : []
      if (!failed && command[0] === "SET") {
        failed = true
        return new Response("unavailable", { status: 503 })
      }
      return original(input, init)
    }) as typeof fetch
    expect(await callback(fakes)).toMatchObject({ status: 503 })
    expect(fakes.store.get(switchKey("hosted"))).toContain('"value":"stop"')
    expect(fakes.mail.sent).toEqual([])
    expect(await callback(fakes)).toMatchObject({ status: 200 })
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.store.zset(switchAuditKey()).size).toBe(1)
  })
  test("mail failure leaves the stop applied and the same signed callback retryable", async () => {
    const fakes = codiumFakes({ now })
    fakes.mail.fail = true
    expect(await callback(fakes)).toMatchObject({
      status: 503,
      body: { error: { code: "VERCEL_SPEND_ALERT_UNAVAILABLE" } },
    })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
    expect(fakes.mail.sent).toEqual([])
    fakes.mail.fail = false
    expect(await callback(fakes)).toMatchObject({ status: 200 })
    expect(fakes.mail.sent).toHaveLength(1)
    expect(fakes.store.zset(switchAuditKey()).size).toBe(1)
  })
  test("missing mail configuration never claims notification delivery or prevents the safety write", async () => {
    const fakes = codiumFakes({ now })
    delete process.env.RESEND_API_KEY
    expect(await callback(fakes)).toMatchObject({ status: 503 })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
    expect(fakes.mail.sent).toEqual([])
  })
  test("an unavailable store refuses the callback without marking it done or sending mail", async () => {
    const fakes = codiumFakes({ now })
    fakes.store.down = true
    expect(await callback(fakes)).toMatchObject({ status: 503 })
    expect(fakes.mail.sent).toEqual([])
    fakes.store.down = false
    expect(await callback(fakes)).toMatchObject({ status: 200 })
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
  })
  test.each(["invalid", "{broken", '{"value":"stop","changedAt":"bad"}', '{"value":"no-new","generation":""}'])(
    "corrupt hosted state stays unchanged and refuses notification: %s",
    async (raw) => {
      const fakes = codiumFakes({ now })
      fakes.store.set(switchKey("hosted"), raw)
      expect(await callback(fakes)).toMatchObject({ status: 503 })
      expect(fakes.store.get(switchKey("hosted"))).toBe(raw)
      expect(fakes.mail.sent).toEqual([])
    },
  )
  test("responses and audits contain no amounts, secrets or email addresses", async () => {
    const fakes = codiumFakes({ now })
    const answer = await callback(fakes)
    const audit = JSON.stringify([...fakes.store.zset(switchAuditKey()).keys()])
    for (const secret of [MAIN_SECRET, HOSTED_SECRET, "budgetAmount", "currentSpend", "@", "fixture-resend-key"])
      expect(answer.raw + audit).not.toContain(secret)
    expect(answer.body).toEqual({ received: true, escalated: true })
    expect(answer.headers["cache-control"]).toBe("no-store")
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("A13 hosted escalation Lua on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  function seed() {
    const fakes = codiumFakes({ now })
    const fetcher = (async (input, init) => {
      if (new URL(String(input)).origin !== FAKE_KV_URL) return fakes.fetcher(input, init)
      const command = JSON.parse(String(init?.body)).map(String) as string[]
      return Response.json({ result: await client!.send(command[0]!, command.slice(1)) })
    }) as typeof fetch
    return { ...fakes, fetcher }
  }
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })
  test("parallel75/100 callbacks and reordered retries converge to stop with bounded audit", async () => {
    const fakes = seed()
    const answers = await Promise.all(
      Array.from({ length: 24 }, (_, index) => callback(fakes, body(HOSTED, index % 2 ? 75 : 100))),
    )
    expect(answers.every((answer) => answer.status === 200)).toBe(true)
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
    const entries = Number(await client!.send("ZCARD", [switchAuditKey()]))
    expect(entries).toBeGreaterThanOrEqual(1)
    expect(entries).toBeLessThanOrEqual(2)
    await callback(fakes, body(HOSTED, 75))
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
    expect(fakes.mail.sent).toHaveLength(2)
  })
  test("a concurrent owner stop cannot be lowered by callback writes", async () => {
    const fakes = seed()
    await Promise.all([
      writeSwitch("hosted", "stop", "owner:fixture", fakes.fetcher, now),
      ...Array.from({ length: 24 }, () => callback(fakes, body(HOSTED, 75))),
    ])
    expect(await readSwitch("hosted", fakes.fetcher, { fresh: true, now })).toBe("stop")
    const entries = Number(await client!.send("ZCARD", [switchAuditKey()]))
    expect(entries).toBeGreaterThanOrEqual(1)
    expect(entries).toBeLessThanOrEqual(2)
  })
  test("corrupt hosted records are refused without mutating the actual key or audit", async () => {
    const fakes = seed()
    const raw = '{"value":"stop","changedAt":"broken"}'
    await client!.send("SET", [switchKey("hosted"), raw])
    expect(await callback(fakes)).toMatchObject({ status: 503 })
    expect(await client!.send("GET", [switchKey("hosted")])).toBe(raw)
    expect(await client!.send("ZCARD", [switchAuditKey()])).toBe(0)
    expect(fakes.mail.sent).toEqual([])
  })
  test("delayed older responses cannot put a weaker guard back in the local cache", async () => {
    const fakes = seed()
    const original = fakes.fetcher
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let ready = () => {}
    const reached = new Promise<void>((resolve) => {
      ready = resolve
    })
    let delayed = false
    fakes.fetcher = (async (input, init) => {
      const response = await original(input, init)
      const command = new URL(String(input)).origin === FAKE_KV_URL ? (JSON.parse(String(init?.body)) as string[]) : []
      if (!delayed && command[0] === "EVAL" && command[5] === "no-new") {
        delayed = true
        ready()
        await held
      }
      return response
    }) as typeof fetch
    const earlier = callback(fakes, body(HOSTED, 75))
    await reached
    await callback(fakes)
    expect(await readSwitch("hosted", fakes.fetcher, { now })).toBe("stop")
    release()
    await earlier
    expect(await readSwitch("hosted", fakes.fetcher, { now })).toBe("stop")
  })
})
