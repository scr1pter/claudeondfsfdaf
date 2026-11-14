import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import cliVerify from "../api/account/cli-verify"
import deleteAccount from "../api/account/delete"
import { handleDownload } from "../api/download"
import { mintCliToken } from "../api/_lib/cli-token"
import { installerFromManifest, parseDownloadManifest, PUBLIC_DOWNLOAD_TARGETS } from "../api/_lib/downloads"
import { ApiError, type ApiRequest, type ApiResponse } from "../api/_lib/http"
import { createHash } from "node:crypto"
import {
  forgetUsage,
  recordDownload,
  recordUsage,
  SHARE_HEADER,
  shareableSummary,
  usageAccount,
} from "../api/_lib/usage"
import { handleCheckin } from "../api/usage/checkin"
import { handleUsageShares } from "../api/usage/shares"
import { handleUsageSummary } from "../api/usage/summary"
import { UsageReport } from "../packages/schema/src/usage-report"

const ACCOUNT = "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb"
const INSTALL = "5f0c7c2e-3b1a-4c8e-9f2d-6a7b8c9d0e1f"
const OWNER = "krishnabharadwaj0521@gmail.com"
const SUPABASE = "https://vector.supabase.co"
const variables = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_LICENSE_SECRET",
  "VECTOR_ADMIN_EMAILS",
  "VECTOR_DESIGN_LAB_EMAILS",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
]
const original = Object.fromEntries(variables.map((key) => [key, process.env[key]]))

beforeEach(() => {
  variables.forEach((key) => delete process.env[key])
  process.env.NODE_ENV = "test"
  process.env.SUPABASE_URL = SUPABASE
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role"
  process.env.SUPABASE_PUBLISHABLE_KEY = "fixture-publishable"
  process.env.VECTOR_CLI_TOKEN_SECRET = "fixture-token-secret".repeat(3)
})

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

type Call = { url: string; method?: string; headers: Record<string, string>; redirect?: string; body: unknown }

// A stand-in for Supabase's REST and auth endpoints that remembers every request it receives.
function supabase(routes: Record<string, () => Response> = {}) {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const route = routes[new URL(url).pathname]
    return route ? route() : Response.json({ status: "ok" })
  }) as typeof fetch
  return { calls, fetcher }
}

function invoke(handler: (request: ApiRequest, response: ApiResponse) => Promise<void>, request: Partial<ApiRequest>) {
  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value)
        return this
      },
      end(value?: string) {
        resolve({ status: this.statusCode, headers, body: value ? JSON.parse(value) : undefined })
        return this
      },
    } as unknown as ApiResponse
    void handler({ headers: {}, ...request } as ApiRequest, response).catch(reject)
  })
}

const checkin = {
  installId: INSTALL,
  client: "desktop",
  version: "1.99.105",
  platform: "darwin",
  arch: "arm64",
  sessions: 4,
  subagentSessions: 2,
}

function post(body: unknown, headers: Record<string, string> = {}): Partial<ApiRequest> {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body }
}

// The numbers behind Settings > Usage & streaks, as the desktop app and the CLI send them.
const report = {
  lifetimeTokens: 1_250_000,
  lifetimeCost: 18.42,
  inputTokens: 800_000,
  outputTokens: 250_000,
  reasoningTokens: 50_000,
  cachedTokens: 150_000,
  completedChats: 41,
  conversations: 12,
  activeDays: 9,
  currentStreak: 3,
  longestStreak: 6,
  averageTaskMs: 41_500,
  longestTaskMs: 912_000,
  modelResponses: 320,
  days: [
    { date: "2026-10-08", tokens: 120_000, tasks: 4, cost: 1.5 },
    { date: "2026-10-09", tokens: 90_000, tasks: 3, cost: 0.75 },
  ],
  favoriteModels: [
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 900_000, percentage: 72 },
    { providerID: "openrouter", modelID: "x-ai/grok-code-fast-1:free", tokens: 350_000, percentage: 28 },
  ],
  effortLevels: [
    { id: "default", label: "Default", tokens: 1_000_000, responses: 280, percentage: 80 },
    { id: "max", label: "Max", tokens: 250_000, responses: 40, percentage: 20 },
  ],
}

describe("desktop check-in", () => {
  test("records exactly the contract fields and answers 204", async () => {
    const storage = supabase()
    const token = mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token
    const result = await invoke(
      (request, response) => handleCheckin(request, response, storage.fetcher),
      post(
        { ...checkin, installId: INSTALL.toUpperCase() },
        {
          authorization: `Bearer ${token}`,
          "user-agent": "Vector/1.99.105 (fixture-agent)",
          "x-forwarded-for": "203.0.113.9",
        },
      ),
    )
    expect(result.status).toBe(204)
    expect(result.body).toBeUndefined()
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(storage.calls).toHaveLength(1)
    expect(storage.calls[0]).toEqual({
      url: `${SUPABASE}/rest/v1/rpc/vector_usage_record`,
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        apikey: "fixture-service-role",
        authorization: "Bearer fixture-service-role",
      },
      body: { request: { ...checkin, accountId: ACCOUNT } },
    })
    const sent = JSON.stringify(storage.calls[0]?.body)
    expect(sent).not.toContain("203.0.113.9")
    expect(sent).not.toContain("fixture-agent")
    expect(sent).not.toContain(token)
  })

  test("counts a check-in without an account when there is no token or it is not valid, and drops its report", async () => {
    const forged = `vct_${Buffer.from(JSON.stringify({ v: 1, sub: ACCOUNT, email: "x@y.z", exp: Date.now() + 1e9 })).toString("base64url")}.forged`
    for (const headers of [{}, { authorization: `Bearer ${forged}` }, { authorization: "Bearer not-a-vector-token" }]) {
      const storage = supabase()
      const result = await invoke(
        (request, response) => handleCheckin(request, response, storage.fetcher),
        post({ ...checkin, usage: report }, headers),
      )
      expect(result.status).toBe(204)
      // Anyone can invent an install ID, so model use without a verified account never reaches the totals.
      expect(storage.calls.map((call) => call.body)).toEqual([{ request: checkin }])
    }
  })

  test("answers 204 without recording when usage storage is not configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const storage = supabase()
    const result = await invoke((request, response) => handleCheckin(request, response, storage.fetcher), post(checkin))
    expect(result.status).toBe(204)
    expect(storage.calls).toHaveLength(0)
  })

  test("answers 204 when storage fails, because the app ignores every answer", async () => {
    const storage = supabase({ "/rest/v1/rpc/vector_usage_record": () => new Response("down", { status: 503 }) })
    const result = await invoke((request, response) => handleCheckin(request, response, storage.fetcher), post(checkin))
    expect(result.status).toBe(204)
    expect(storage.calls).toHaveLength(1)
  })

  test("refuses storage that is not https", async () => {
    process.env.SUPABASE_URL = "http://vector.supabase.co"
    const storage = supabase()
    expect(
      (await invoke((request, response) => handleCheckin(request, response, storage.fetcher), post(checkin))).status,
    ).toBe(204)
    expect(storage.calls).toHaveLength(0)
  })

  test("rejects anything outside the contract with 400 and records nothing", async () => {
    const invalid = [
      { ...checkin, installId: "not-a-uuid" },
      { ...checkin, installId: "5f0c7c2e-3b1a-1c8e-9f2d-6a7b8c9d0e1f" },
      { ...checkin, client: "cli" },
      { ...checkin, version: "1.2" },
      { ...checkin, version: `1.2.3-${"a".repeat(30)}` },
      { ...checkin, version: "1.2.3 <script>" },
      { ...checkin, platform: "freebsd" },
      { ...checkin, arch: "ia32" },
      { ...checkin, sessions: -1 },
      { ...checkin, sessions: 1.5 },
      { ...checkin, subagentSessions: 100_001 },
      { ...checkin, sessions: "4" },
      { ...checkin, prompt: "fix the bug in /Users/someone/secret.ts" },
      { installId: INSTALL, client: "desktop" },
      [checkin],
      { ...checkin, usage: { ...report, prompt: "fix the bug" } },
      { ...checkin, usage: { ...report, lifetimeTokens: -1 } },
      { ...checkin, usage: { ...report, lifetimeTokens: 1e12 + 1 } },
      { ...checkin, usage: { ...report, lifetimeCost: 2e9 } },
      { ...checkin, usage: { ...report, days: [{ ...report.days[0], tokens: 1e10 + 1 }] } },
      { ...checkin, usage: { ...report, days: [{ ...report.days[0], tasks: 1e6 + 1 }] } },
      { ...checkin, usage: { ...report, days: [{ ...report.days[0], cost: 1e6 + 0.01 }] } },
      { ...checkin, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], tokens: 1e12 + 1 }] } },
      { ...checkin, usage: { ...report, completedChats: 1.5 } },
      { ...checkin, usage: { ...report, days: [{ ...report.days[0], date: "2026-02-30" }] } },
      { ...checkin, usage: { ...report, days: [report.days[0], report.days[0]] } },
      { ...checkin, usage: { ...report, days: Array(9).fill(report.days[0]) } },
      { ...checkin, usage: { ...report, days: [{ ...report.days[0], path: "/Users/someone" }] } },
      { ...checkin, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], modelID: "my model" }] } },
      ...[
        "/Users/someone/models/qwen.gguf",
        "./models/qwen.gguf",
        "C:/models/qwen.gguf",
        "mnt/c/Users/someone/qwen.gguf",
        "home/someone/qwen.gguf",
      ].map((modelID) => ({
        ...checkin,
        usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], modelID }] },
      })),
      { ...checkin, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], providerID: "/opt/llm" }] } },
      { ...checkin, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], modelID: "m".repeat(121) }] } },
      { ...checkin, usage: { ...report, favoriteModels: Array(11).fill(report.favoriteModels[0]) } },
      { ...checkin, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], percentage: 101 }] } },
      { ...checkin, usage: { ...report, effortLevels: [{ ...report.effortLevels[0], label: "a\nb" }] } },
      { ...checkin, usage: { ...report, effortLevels: [{ id: "max", label: "Max", tokens: 1, percentage: 1 }] } },
      { ...checkin, usage: (({ days, ...rest }) => rest)(report) },
      { ...checkin, usage: "everything" },
    ]
    for (const body of invalid) {
      const storage = supabase()
      const result = await invoke((request, response) => handleCheckin(request, response, storage.fetcher), post(body))
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: { code: "USAGE_INVALID" } })
      expect(storage.calls).toHaveLength(0)
    }
  })

  test("records the usage report exactly as sent", async () => {
    const storage = supabase()
    const token = mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token
    const result = await invoke(
      (request, response) => handleCheckin(request, response, storage.fetcher),
      post({ ...checkin, usage: report }, { authorization: `Bearer ${token}` }),
    )
    expect(result.status).toBe(204)
    expect(storage.calls.map((call) => call.body)).toEqual([
      { request: { ...checkin, accountId: ACCOUNT, usage: report } },
    ])
  })

  test("accepts the upper bounds of a usage report", async () => {
    const storage = supabase()
    const usage = {
      ...report,
      lifetimeTokens: 1e12,
      lifetimeCost: 1e9,
      currentStreak: 100_000,
      longestTaskMs: 1e12,
      days: Array.from({ length: 8 }, (_, index) => ({
        date: `2026-10-0${index + 1}`,
        tokens: 1e10,
        tasks: 1e6,
        cost: 1e6,
      })),
      favoriteModels: Array.from({ length: 10 }, (_, index) => ({
        providerID: "p".repeat(120),
        modelID: `vendor/model-${index}:free@v1+x`,
        tokens: 1e12,
        percentage: 100,
      })),
      effortLevels: Array.from({ length: 10 }, (_, index) => ({
        id: `level-${index}`,
        label: `Level ${index}`,
        tokens: 1e12,
        responses: 1e9,
        percentage: 100,
      })),
    }
    const result = await invoke(
      (request, response) => handleCheckin(request, response, storage.fetcher),
      post({ ...checkin, usage }),
    )
    expect(result.status).toBe(204)
    expect(storage.calls).toHaveLength(1)
  })

  test("accepts the upper bound of each count and a prerelease version", async () => {
    const storage = supabase()
    const body = { ...checkin, version: "1.99.106-beta.2", sessions: 100_000, subagentSessions: 0 }
    expect(
      (await invoke((request, response) => handleCheckin(request, response, storage.fetcher), post(body))).status,
    ).toBe(204)
    expect(storage.calls[0]?.body).toEqual({ request: body })
  })

  test("only accepts a small JSON POST", async () => {
    const storage = supabase()
    const handler = (request: ApiRequest, response: ApiResponse) => handleCheckin(request, response, storage.fetcher)
    expect((await invoke(handler, { method: "GET" })).status).toBe(405)
    expect((await invoke(handler, post(checkin, { "content-type": "text/plain" }))).status).toBe(415)
    expect((await invoke(handler, post(checkin, { "content-length": "17000" }))).status).toBe(413)
    expect((await invoke(handler, post({ ...checkin, padding: "x".repeat(17_000) }))).status).toBe(413)
    expect(storage.calls).toHaveLength(0)
  })
})

describe("CLI check-in", () => {
  const cli = { installId: INSTALL, client: "cli", version: "1.99.106", platform: "linux", arch: "x64", usage: report }

  test("records the report against the token's account, one row per account, without the install ID", async () => {
    const storage = supabase()
    const token = mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token
    const result = await invoke(
      (request, response) => handleCheckin(request, response, storage.fetcher),
      post(cli, { authorization: `Bearer ${token}` }),
    )
    expect(result.status).toBe(204)
    expect(storage.calls.map((call) => call.body)).toEqual([
      {
        request: {
          client: "cli",
          accountId: ACCOUNT,
          version: "1.99.106",
          platform: "linux",
          arch: "x64",
          usage: report,
        },
      },
    ])
    expect(JSON.stringify(storage.calls)).not.toContain(INSTALL)
  })

  test("records nothing without a valid account token", async () => {
    for (const headers of [{}, { authorization: "Bearer vct_forged.token" }]) {
      const storage = supabase()
      const result = await invoke(
        (request, response) => handleCheckin(request, response, storage.fetcher),
        post(cli, headers),
      )
      expect(result.status).toBe(204)
      expect(storage.calls).toHaveLength(0)
    }
  })

  test("accepts every platform the CLI runs on and refuses desktop-only fields", async () => {
    const storage = supabase()
    const handler = (request: ApiRequest, response: ApiResponse) => handleCheckin(request, response, storage.fetcher)
    expect((await invoke(handler, post({ ...cli, platform: "freebsd", arch: "riscv64" }))).status).toBe(204)
    for (const body of [
      { ...cli, platform: "plan9" },
      { ...cli, arch: "mips" },
      { ...cli, sessions: 3 },
      { ...cli, installId: "not-a-uuid" },
      { ...cli, usage: { ...report, favoriteModels: [{ ...report.favoriteModels[0], providerID: "" }] } },
    ])
      expect((await invoke(handler, post(body))).status).toBe(400)
  })
})

describe("usage report from the local summary", () => {
  const summary = {
    ...report,
    unpricedResponses: 2,
    peakTokens: 300_000,
    longestTaskTokens: 40_000,
    averageTokensPerChat: 30_000,
    days: Array.from({ length: 10 }, (_, index) => ({
      date: `2026-09-${String(20 + index)}`,
      tokens: 1_000 * index,
      cost: 0.1234567 * index,
      tasks: index,
    })),
    favoriteModels: [
      ...report.favoriteModels.map((model) => ({ ...model, responses: 10 })),
      { providerID: "custom provider", modelID: "local", tokens: 1, responses: 1, percentage: 0 },
      // A local server naming the model by its file path: left out, never sent.
      { providerID: "llamacpp", modelID: "/Users/someone/models/qwen.gguf", tokens: 1, responses: 1, percentage: 0 },
    ],
    effortLevels: report.effortLevels,
  }

  test("keeps Codium activity from a filtered summary without sending its private counters", () => {
    const built = UsageReport.fromSummary({
      ...summary,
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      codiumResponses: 2,
      modelResponses: 2,
      completedChats: 1,
      favoriteModels: [],
      effortLevels: [],
      days: [{ date: "2026-09-29", tokens: 0, cost: 0, tasks: 1, codium: 2 }],
      helpers: [{ id: "vectorscope.review", sessions: 1, responses: 1, tokens: 0, cost: 0, codiumSteps: 1 }],
    })
    expect(built).toMatchObject({ lifetimeTokens: 0, lifetimeCost: 0, modelResponses: 2, completedChats: 1 })
    expect(built?.days).toEqual([{ date: "2026-09-29", tokens: 0, cost: 0, tasks: 1 }])
    expect(built?.favoriteModels).toEqual([])
    expect(JSON.stringify(built)).not.toMatch(/codium|vector-plan|vectorscope/)
  })

  test("keeps the last seven days and the listed fields, and leaves out what the server would refuse", () => {
    const built = UsageReport.fromSummary(summary)
    expect(built?.days.map((day) => day.date)).toEqual([
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
    ])
    expect(built?.days[0]?.cost).toBe(0.37037)
    expect(built?.favoriteModels).toEqual(report.favoriteModels)
    expect(Object.keys(built ?? {}).sort()).toEqual(Object.keys(report).sort())
    expect(UsageReport.decode(built)._tag).toBe("Some")
  })

  test("clamps numbers into range and refuses something that is not a summary", () => {
    const built = UsageReport.fromSummary({
      ...summary,
      lifetimeTokens: -5,
      lifetimeCost: Number.NaN,
      inputTokens: 5e15,
      currentStreak: 1e9,
      days: [{ date: "2026-09-29", tokens: 5e15, tasks: 5e9, cost: 5e9 }],
    })
    expect(built).toMatchObject({
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 1e12,
      currentStreak: 100_000,
      days: [{ date: "2026-09-29", tokens: 1e10, tasks: 1e6, cost: 1e6 }],
    })
    expect(UsageReport.fromSummary({ lifetimeTokens: 1 })).toBeUndefined()
    expect(UsageReport.fromSummary("usage")).toBeUndefined()
  })
})

describe("account from a desktop token", () => {
  const headers = (authorization?: string) => ({ headers: authorization ? { authorization } : {} })

  test("resolves the account a valid Vector token was minted for", () => {
    expect(usageAccount(headers(`Bearer ${mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token}`))).toBe(
      ACCOUNT,
    )
  })

  test("ignores expired, forged, malformed and non-account tokens", () => {
    const expired = mintCliToken(
      { id: ACCOUNT, email: "user@example.com" },
      Date.now() - 91 * 24 * 60 * 60 * 1000,
    ).token
    const notAnAccount = mintCliToken({ id: "preview", email: "user@example.com" }).token
    const valid = mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token
    const [payload] = valid.slice(4).split(".")
    for (const authorization of [
      undefined,
      `Bearer ${expired}`,
      `Bearer ${notAnAccount}`,
      `Bearer vct_${payload}.AAAA`,
      valid,
      `Basic ${valid}`,
      "Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature",
    ])
      expect(usageAccount(headers(authorization))).toBeUndefined()
  })

  test("ignores every token when token signing is not configured", () => {
    const token = mintCliToken({ id: ACCOUNT, email: "user@example.com" }).token
    delete process.env.VECTOR_CLI_TOKEN_SECRET
    expect(usageAccount(headers(`Bearer ${token}`))).toBeUndefined()
  })
})

describe("recording helpers", () => {
  test("send the download and forget requests exactly", async () => {
    const storage = supabase()
    await recordDownload({ accountId: ACCOUNT, target: "mac-arm64", version: "1.99.105" }, storage.fetcher)
    expect(await forgetUsage(ACCOUNT, storage.fetcher)).toBe(true)
    expect(storage.calls.map((call) => [call.url, call.body])).toEqual([
      [
        `${SUPABASE}/rest/v1/rpc/vector_usage_download`,
        { request: { accountId: ACCOUNT, target: "mac-arm64", version: "1.99.105" } },
      ],
      [`${SUPABASE}/rest/v1/rpc/vector_usage_forget`, { account: ACCOUNT }],
    ])
  })

  test("never reject, and report a forget that did not happen", async () => {
    const failing = (async () => {
      throw new Error("unreachable")
    }) as unknown as typeof fetch
    expect(await recordUsage({ ...checkin, client: "desktop" }, failing)).toBeUndefined()
    expect(
      await recordDownload({ accountId: ACCOUNT, target: "mac-arm64", version: "1.99.105" }, failing),
    ).toBeUndefined()
    expect(await forgetUsage(ACCOUNT, failing)).toBe(false)
    const refused = supabase({ "/rest/v1/rpc/vector_usage_forget": () => new Response("{}", { status: 404 }) })
    expect(await forgetUsage(ACCOUNT, refused.fetcher)).toBe(false)
    delete process.env.SUPABASE_URL
    expect(await forgetUsage(ACCOUNT, supabase().fetcher)).toBe(false)
  })

  test("give up after a short timeout", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch
    const started = Date.now()
    await recordUsage({ ...checkin, client: "desktop" }, hanging)
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})

describe("usage summary", () => {
  const summary = {
    generatedAt: "2026-10-09T12:00:00Z",
    today: "2026-10-09",
    totals: {
      accounts: 40,
      installs: 31,
      cliAccounts: 9,
      downloads: 52,
      downloadAccounts: 33,
      activeToday: 11,
      active7: 24,
      previous7: 20,
      active30: 35,
      sessions7: 310,
      subagentSessions7: 95,
    },
    daily: [
      {
        day: "2026-10-09",
        active: 11,
        desktop: 9,
        cli: 3,
        sessions: 40,
        subagentSessions: 12,
        tokens: 2_400_000,
        cost: 31.5,
        tasks: 52,
      },
    ],
    weekly: [
      { week: "2026-09-28", active: 20, desktop: 17, cli: 5, growth: null },
      { week: "2026-10-05", active: 24, desktop: 20, cli: 6, growth: 0.2 },
    ],
    monthly: [{ month: "2026-10-01", active: 30 }],
    retention: [{ cohort: "2026-09-14", size: 10, weeks: [0.6, 0.5, null, null] }],
    funnel: [{ week: "2026-10-05", signups: 6, downloaded: 4, active: 3 }],
    versions: [{ client: "desktop", version: "1.99.105", active: 18 }],
    platforms: [{ client: "desktop", platform: "darwin", arch: "arm64", active: 15 }],
    usage: {
      reporting: 30,
      lifetimeTokens: 98_000_000,
      lifetimeCost: 1_204.5,
      inputTokens: 60_000_000,
      outputTokens: 20_000_000,
      reasoningTokens: 6_000_000,
      cachedTokens: 12_000_000,
      completedChats: 2_400,
      conversations: 800,
      modelResponses: 21_000,
      tokens7: 14_000_000,
      previousTokens7: 11_000_000,
      cost7: 180.25,
      previousCost7: 150,
      tokensPerActive7: 583_333,
    },
    models: [
      { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 60_000_000, people: 18, share: 0.62 },
      { providerID: "acme-internal", modelID: "acme/coder-7b", tokens: 2_000_000, people: 1, share: 0.02 },
    ],
    efforts: [
      { id: "default", label: "Default", tokens: 70_000_000, responses: 15_000, people: 2, share: 0.7 },
      { id: "thinking-hard", label: "Thinking hard", tokens: 1_000_000, responses: 30, people: 1, share: 0.01 },
    ],
    streaks: { one: 6, twoToSix: 9, sevenPlus: 3 },
  }

  function session(method = "oauth") {
    const payload = Buffer.from(JSON.stringify({ amr: [{ method, timestamp: 1 }] })).toString("base64url")
    return { authorization: `Bearer header.${payload}.signature` }
  }

  function person(email: string) {
    return {
      id: ACCOUNT,
      email,
      email_confirmed_at: "2026-09-01T12:00:00.000Z",
      identities: [{ provider: "google", identity_data: { email, email_verified: true } }],
    }
  }

  function backend(user: Record<string, unknown>, payload: unknown = summary) {
    return supabase({
      "/auth/v1/user": () => Response.json(user),
      "/rest/v1/rpc/vector_usage_summary": () => Response.json(payload),
    })
  }

  test("shows the owner everyone's summary but their own use, uncached", async () => {
    const storage = backend(person(OWNER))
    const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
      method: "GET",
      headers: session(),
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual(summary)
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(storage.calls.map((call) => call.url)).toEqual([
      `${SUPABASE}/auth/v1/user`,
      `${SUPABASE}/rest/v1/rpc/vector_usage_summary`,
    ])
    expect(storage.calls[1]).toMatchObject({
      method: "POST",
      headers: { apikey: "fixture-service-role", authorization: "Bearer fixture-service-role" },
      body: { request: { excludeEmails: [OWNER] } },
    })
  })

  test("refuses another account, a password session and a signed-out visitor", async () => {
    const other = backend(person("someone@example.com"))
    const forbidden = await invoke((request, response) => handleUsageSummary(request, response, other.fetcher), {
      method: "GET",
      headers: session(),
    })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toMatchObject({ error: { code: "DESIGN_LAB_FORBIDDEN" } })

    const password = backend(person(OWNER))
    const notGoogle = await invoke((request, response) => handleUsageSummary(request, response, password.fetcher), {
      method: "GET",
      headers: session("password"),
    })
    expect(notGoogle.status).toBe(403)
    expect(notGoogle.body).toMatchObject({ error: { code: "GOOGLE_SIGN_IN_REQUIRED" } })

    const anonymous = backend(person(OWNER))
    const signedOut = await invoke((request, response) => handleUsageSummary(request, response, anonymous.fetcher), {
      method: "GET",
    })
    expect(signedOut.status).toBe(401)
    expect(signedOut.body).toMatchObject({ error: { code: "SIGN_IN_REQUIRED" } })
    for (const storage of [other, password, anonymous])
      expect(storage.calls.some((call) => call.url.includes("/rest/v1/rpc/"))).toBe(false)
  })

  test("uses the admin allowlist, falling back to the Design Lab owners", async () => {
    process.env.VECTOR_DESIGN_LAB_EMAILS = "designer@example.com"
    const designer = backend(person("designer@example.com"))
    expect(
      (
        await invoke((request, response) => handleUsageSummary(request, response, designer.fetcher), {
          method: "GET",
          headers: session(),
        })
      ).status,
    ).toBe(200)

    process.env.VECTOR_ADMIN_EMAILS = "Admin@Example.com"
    const admin = backend(person("admin@example.com"))
    expect(
      (
        await invoke((request, response) => handleUsageSummary(request, response, admin.fetcher), {
          method: "GET",
          headers: session(),
        })
      ).status,
    ).toBe(200)
    const replaced = backend(person("designer@example.com"))
    expect(
      (
        await invoke((request, response) => handleUsageSummary(request, response, replaced.fetcher), {
          method: "GET",
          headers: session(),
        })
      ).status,
    ).toBe(403)
  })

  test("labels Vector's own effort levels itself, whatever a report called them", async () => {
    const storage = backend(person(OWNER), {
      ...summary,
      efforts: [
        { ...summary.efforts[0], label: "zz visit evil.example" },
        { id: "max", label: "Visit evil.example", tokens: 5, responses: 1, people: 1, share: 0 },
        summary.efforts[1],
      ],
    })
    const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
      method: "GET",
      headers: session(),
    })
    expect((result.body as typeof summary).efforts.map((effort) => [effort.id, effort.label])).toEqual([
      ["default", "Default"],
      ["max", "Max"],
      ["thinking-hard", "Thinking hard"],
    ])
  })

  test("reads totals that many reports add up past 2^53", async () => {
    // A report may carry up to 1e12 lifetime tokens; ten thousand of them already pass Number.MAX_SAFE_INTEGER.
    const huge = 1e16 + 2
    const storage = backend(person(OWNER), {
      ...summary,
      daily: summary.daily.map((day) => ({ ...day, tokens: huge, tasks: huge })),
      usage: {
        ...summary.usage,
        lifetimeTokens: huge,
        inputTokens: huge,
        completedChats: huge,
        modelResponses: huge,
        tokens7: huge,
        tokensPerActive7: huge,
      },
      models: summary.models.map((model) => ({ ...model, tokens: huge })),
      efforts: summary.efforts.map((effort) => ({ ...effort, tokens: huge, responses: huge })),
    })
    const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
      method: "GET",
      headers: session(),
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ usage: { lifetimeTokens: huge }, daily: [{ tokens: huge }] })
  })

  test("reports unavailable storage instead of a malformed summary", async () => {
    for (const storage of [
      backend(person(OWNER), { ...summary, totals: { ...summary.totals, accounts: -1 } }),
      backend(person(OWNER), null),
      supabase({
        "/auth/v1/user": () => Response.json(person(OWNER)),
        "/rest/v1/rpc/vector_usage_summary": () => new Response("missing", { status: 404 }),
      }),
    ]) {
      const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
        method: "GET",
        headers: session(),
      })
      expect(result.status).toBe(503)
      expect(result.body).toMatchObject({ error: { code: "USAGE_UNAVAILABLE" } })
    }
  })

  test("only answers GET", async () => {
    const storage = backend(person(OWNER))
    const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
      method: "POST",
      headers: session(),
    })
    expect(result.status).toBe(405)
    expect(storage.calls).toHaveLength(0)
  })

  const TOKEN = "Q2hhcmFjdGVycyBvZiBhIHNoYXJlIGxpbmsgdG9rZW4"
  const hash = createHash("sha256").update(TOKEN).digest("hex")
  const opened = (answer: unknown) =>
    supabase({
      "/rest/v1/rpc/vector_usage_share_open": () => Response.json(answer),
      "/rest/v1/rpc/vector_usage_summary": () => Response.json(summary),
    })

  test("a share link reads the aggregates read-only, without its owner's session", async () => {
    const storage = opened({ status: "ok", expiresAt: "2026-10-24T09:00:00Z" })
    const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
      method: "GET",
      headers: { [SHARE_HEADER]: TOKEN },
    })
    expect(result.status).toBe(200)
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(result.body).toEqual({ shared: { expiresAt: "2026-10-24T09:00:00Z" }, summary: shareableSummary(summary) })
    expect(storage.calls.map((call) => [call.url, call.body])).toEqual([
      [`${SUPABASE}/rest/v1/rpc/vector_usage_share_open`, { request: { tokenHash: hash } }],
      [`${SUPABASE}/rest/v1/rpc/vector_usage_summary`, { request: { excludeEmails: [OWNER] } }],
    ])
    expect(JSON.stringify(storage.calls)).not.toContain(TOKEN)
  })

  test("a share link leaves out models and custom effort levels fewer than three people use", () => {
    const shared = shareableSummary(summary)
    expect(shared.models.map((model) => model.modelID)).toEqual(["claude-sonnet-4-5"])
    expect(shared.efforts.map((effort) => effort.id)).toEqual(["default"])
    expect({ ...shared, models: summary.models, efforts: summary.efforts }).toEqual(summary)
  })

  test("a share link leaves out the sessions and model use of a day fewer than three people were active", () => {
    const quiet = {
      day: "2026-10-08",
      active: 2,
      desktop: 1,
      cli: 1,
      sessions: 7,
      subagentSessions: 3,
      tokens: 450_000,
      cost: 6.25,
      tasks: 9,
    }
    const shared = shareableSummary({ ...summary, daily: [quiet, ...summary.daily] })
    // With about thirty people, a day with one or two active could be one person's day.
    expect(shared.daily).toEqual([
      { ...quiet, sessions: 0, subagentSessions: 0, tokens: 0, cost: 0, tasks: 0 },
      ...summary.daily,
    ])
  })

  test("an expired, revoked, unknown or malformed link says why and reads nothing", async () => {
    for (const [answer, status, code] of [
      [{ status: "expired" }, 410, "SHARE_EXPIRED"],
      [{ status: "revoked" }, 410, "SHARE_REVOKED"],
      [{ status: "missing" }, 404, "SHARE_NOT_FOUND"],
      [{ status: "surprise" }, 503, "USAGE_UNAVAILABLE"],
    ] as const) {
      const storage = opened(answer)
      const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
        method: "GET",
        headers: { [SHARE_HEADER]: TOKEN },
      })
      expect(result.status).toBe(status)
      expect(result.body).toMatchObject({ error: { code } })
      expect(storage.calls.map((call) => call.url)).toEqual([`${SUPABASE}/rest/v1/rpc/vector_usage_share_open`])
    }
    for (const token of ["short", `${TOKEN}=`, `${TOKEN} ${TOKEN}`]) {
      const storage = opened({ status: "ok", expiresAt: "2026-10-24T09:00:00Z" })
      const result = await invoke((request, response) => handleUsageSummary(request, response, storage.fetcher), {
        method: "GET",
        headers: { [SHARE_HEADER]: token },
      })
      expect(result.status).toBe(404)
      expect(storage.calls).toHaveLength(0)
    }
  })
})

describe("share links", () => {
  const link = {
    id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    label: "Seed round",
    createdAt: "2026-10-10T09:00:00Z",
    expiresAt: "2026-10-24T09:00:00Z",
    revokedAt: null,
    lastViewedAt: null,
    views: 0,
    state: "active",
  }

  function session() {
    const payload = Buffer.from(JSON.stringify({ amr: [{ method: "oauth", timestamp: 1 }] })).toString("base64url")
    return { authorization: `Bearer header.${payload}.signature` }
  }

  function backend(email = OWNER, rpc: Record<string, () => Response> = {}) {
    return supabase({
      "/auth/v1/user": () =>
        Response.json({
          id: ACCOUNT,
          email,
          email_confirmed_at: "2026-09-01T12:00:00.000Z",
          identities: [{ provider: "google", identity_data: { email, email_verified: true } }],
        }),
      "/rest/v1/rpc/vector_usage_share_create": () => Response.json({ status: "ok", share: link }),
      "/rest/v1/rpc/vector_usage_share_list": () => Response.json({ status: "ok", shares: [link] }),
      "/rest/v1/rpc/vector_usage_share_revoke": () => Response.json({ status: "ok" }),
      ...rpc,
    })
  }

  const run = (storage: ReturnType<typeof supabase>, request: Partial<ApiRequest>) =>
    invoke((req, res) => handleUsageShares(req, res, storage.fetcher), request)

  test("the owner creates a link: its token is answered once and only its hash is stored", async () => {
    const storage = backend()
    const result = await run(storage, post({ label: "  Seed round  ", days: 14 }, session()))
    expect(result.status).toBe(201)
    const body = result.body as { token: string; share: unknown }
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.share).toEqual(link)
    expect(storage.calls[1]).toMatchObject({
      url: `${SUPABASE}/rest/v1/rpc/vector_usage_share_create`,
      body: {
        request: { tokenHash: createHash("sha256").update(body.token).digest("hex"), label: "Seed round", days: 14 },
      },
    })
    expect(JSON.stringify(storage.calls)).not.toContain(body.token)
    const again = await run(backend(), post({ label: "Seed round", days: 14 }, session()))
    expect((again.body as { token: string }).token).not.toBe(body.token)
  })

  test("refuses a link without a label, with a long or control-character label, or another expiry", async () => {
    for (const body of [
      { label: "", days: 7 },
      { label: "   ", days: 7 },
      { label: "x".repeat(81), days: 7 },
      { label: "a\u0000b", days: 7 },
      { label: "Seed", days: 10 },
      { label: "Seed", days: "7" },
      { label: "Seed", days: 7, token: "mine" },
    ]) {
      const storage = backend()
      const result = await run(storage, post(body, session()))
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: { code: "SHARE_INVALID" } })
      expect(storage.calls.some((call) => call.url.includes("/rpc/"))).toBe(false)
    }
  })

  test("lists and revokes for the owner", async () => {
    const storage = backend()
    expect(await run(storage, { method: "GET", headers: session() })).toMatchObject({
      status: 200,
      body: { shares: [link] },
    })
    const revoked = await run(storage, { method: "DELETE", url: `/api/usage/shares?id=${link.id}`, headers: session() })
    expect(revoked.status).toBe(204)
    expect(storage.calls.at(-1)).toMatchObject({
      url: `${SUPABASE}/rest/v1/rpc/vector_usage_share_revoke`,
      body: { request: { id: link.id } },
    })
    const missing = backend(OWNER, {
      "/rest/v1/rpc/vector_usage_share_revoke": () => Response.json({ status: "missing" }),
    })
    expect(
      (await run(missing, { method: "DELETE", url: `/api/usage/shares?id=${link.id}`, headers: session() })).status,
    ).toBe(404)
    const malformed = backend()
    expect(
      (await run(malformed, { method: "DELETE", url: "/api/usage/shares?id=nope", headers: session() })).status,
    ).toBe(400)
    expect(malformed.calls.some((call) => call.url.includes("/rpc/"))).toBe(false)
  })

  test("needs the owner's Google session for every method", async () => {
    for (const request of [
      { method: "GET" },
      post({ label: "Seed", days: 7 }),
      { method: "DELETE", url: `/api/usage/shares?id=${link.id}` },
    ]) {
      const storage = backend()
      expect((await run(storage, request)).status).toBe(401)
      const other = backend("someone@example.com")
      expect((await run(other, { ...request, headers: { ...request.headers, ...session() } })).status).toBe(403)
      expect([...storage.calls, ...other.calls].some((call) => call.url.includes("/rpc/"))).toBe(false)
    }
    expect((await run(backend(), { method: "PUT", headers: session() })).status).toBe(405)
  })

  test("reports the live-link limit and unavailable storage", async () => {
    const full = backend(OWNER, { "/rest/v1/rpc/vector_usage_share_create": () => Response.json({ status: "limit" }) })
    expect(await run(full, post({ label: "Seed", days: 7 }, session()))).toMatchObject({
      status: 409,
      body: { error: { code: "SHARE_LIMIT" } },
    })
    const down = backend(OWNER, { "/rest/v1/rpc/vector_usage_share_list": () => new Response("down", { status: 503 }) })
    expect((await run(down, { method: "GET", headers: session() })).status).toBe(503)
  })
})

describe("installer downloads", () => {
  const version = "1.99.105"
  const manifest = parseDownloadManifest({
    schemaVersion: 1,
    version,
    channel: "latest",
    publishedAt: "2026-10-08T12:00:00.000Z",
    targets: Object.fromEntries(
      Object.entries(PUBLIC_DOWNLOAD_TARGETS).map(([target, filename]) => [
        target,
        {
          filename,
          pathname: `releases/vector-v${version}/${filename}`,
          url: `https://vector.public.blob.vercel-storage.com/releases/vector-v${version}/${filename}`,
          size: 123_456,
          sha256: "a".repeat(64),
          verification: "release-workflow",
        },
      ]),
    ),
  })
  const installer = (target: string | undefined) =>
    Promise.resolve({ manifest, installer: installerFromManifest(manifest, target) })
  const authenticate = () => Promise.resolve({ id: ACCOUNT, email: "user@example.com" })

  test("counts the download against the signed-in account", async () => {
    const recorded: unknown[] = []
    const result = await invoke(
      (request, response) =>
        handleDownload(request, response, installer, authenticate, (input) => {
          recorded.push(input)
          return Promise.resolve()
        }),
      { method: "GET", query: { target: "linux-x64" } },
    )
    expect(result.status).toBe(307)
    expect(recorded).toEqual([{ accountId: ACCOUNT, target: "linux-x64", version }])
  })

  test("still redirects when recording fails or never answers", async () => {
    for (const record of [() => Promise.reject(new Error("storage down")), () => new Promise<void>(() => undefined)]) {
      const result = await invoke(
        (request, response) => handleDownload(request, response, installer, authenticate, record),
        {
          method: "GET",
          query: { target: "windows-x64" },
        },
      )
      expect(result.status).toBe(307)
      expect(result.headers.location).toBe(
        `https://vector.public.blob.vercel-storage.com/releases/vector-v${version}/vector-desktop-win-x64.exe`,
      )
    }
  })

  test("records nothing for a visitor who is not signed in or asks for no real installer", async () => {
    const recorded: unknown[] = []
    const record = (input: unknown) => {
      recorded.push(input)
      return Promise.resolve()
    }
    const refused = () => Promise.reject(new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue."))
    await invoke((request, response) => handleDownload(request, response, installer, refused, record), {
      method: "GET",
      query: { target: "mac-arm64" },
    })
    const missing = await invoke(
      (request, response) => handleDownload(request, response, installer, authenticate, record),
      {
        method: "GET",
        query: { target: "mac-m9" },
      },
    )
    expect(missing.status).toBe(404)
    expect(recorded).toEqual([])
  })
})

// The CLI and account-deletion handlers call Supabase with the global fetch, so these run them
// against a loopback stand-in for Supabase.
describe("handlers that reach Supabase over the network", () => {
  const state = {
    calls: [] as { path: string; method: string; body: unknown }[],
    forget: 200,
    user: { id: ACCOUNT, email: "fixture@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" },
  }
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      state.calls.push({ path, method: request.method, body })
      if (path === "/auth/v1/user") return Response.json(state.user)
      if (path === "/rest/v1/rpc/vector_usage_forget") return Response.json({ status: "ok" }, { status: state.forget })
      return Response.json({ status: "ok" })
    },
  })
  const server = createServer((request, response) => {
    if (request.url === "/delete") return void deleteAccount(request, response)
    void cliVerify(request, response)
  })
  const origin = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "")
    }),
  )

  beforeEach(() => {
    process.env.SUPABASE_URL = fixture.url.origin
    state.calls = []
    state.forget = 200
  })

  afterAll(() => {
    server.closeAllConnections()
    server.close()
    fixture.stop(true)
  })

  const records = () => state.calls.filter((call) => call.path === "/rest/v1/rpc/vector_usage_record")

  async function until(condition: () => boolean) {
    const deadline = Date.now() + 2_000
    while (!condition() && Date.now() < deadline) await Bun.sleep(10)
  }

  async function verify(token: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${await origin}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ token }),
    })
    return { status: response.status, body: await response.json() }
  }

  const cliHeaders = { "x-vector-version": "1.99.105", "x-vector-platform": "linux-arm64" }

  test("CLI verification answers exactly as before and counts one day of CLI use", async () => {
    const token = mintCliToken({ id: ACCOUNT, email: "fixture@example.test" }).token
    const result = await verify(token, cliHeaders)
    expect(result).toEqual({ status: 200, body: { ok: true, user: { id: ACCOUNT, email: "fixture@example.test" } } })
    await until(() => records().length > 0)
    expect(records().map((call) => call.body)).toEqual([
      { request: { client: "cli", accountId: ACCOUNT, version: "1.99.105", platform: "linux", arch: "arm64" } },
    ])
  })

  test("CLI verification still refuses a bad token, and counts nothing for it", async () => {
    const result = await verify("vct_bad.token", cliHeaders)
    expect(result).toEqual({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID", message: "That CLI token is not valid. Generate a new one." } },
    })
    await Bun.sleep(50)
    expect(records()).toHaveLength(0)
  })

  test("the CLI's opt-out, an older CLI and malformed headers are not counted", async () => {
    const token = mintCliToken({ id: ACCOUNT, email: "fixture@example.test" }).token
    for (const headers of [
      { ...cliHeaders, "x-vector-usage": "off" },
      {},
      { "x-vector-version": "1.99.105" },
      { ...cliHeaders, "x-vector-platform": "Darwin arm64; /Users/someone" },
      { ...cliHeaders, "x-vector-version": "dev build" },
    ])
      expect((await verify(token, headers)).status).toBe(200)
    // A counted request after them proves the earlier ones had their chance to record.
    expect((await verify(token, { ...cliHeaders, "x-vector-version": "1.99.106" })).status).toBe(200)
    await until(() => records().length > 0)
    await Bun.sleep(50)
    expect(records().map((call) => call.body)).toEqual([
      { request: { client: "cli", accountId: ACCOUNT, version: "1.99.106", platform: "linux", arch: "arm64" } },
    ])
  })

  async function remove() {
    const response = await fetch(`${await origin}/delete`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-session", "content-type": "application/json" },
      body: JSON.stringify({ confirm: "fixture@example.test" }),
    })
    return { status: response.status, body: await response.json() }
  }

  test("account deletion erases usage counts before the identity", async () => {
    const result = await remove()
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ deleted: true, usageCounts: "deleted" })
    expect(state.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /auth/v1/user",
      "POST /rest/v1/rpc/vector_usage_forget",
      `DELETE /auth/v1/admin/users/${ACCOUNT}`,
    ])
    expect(state.calls[1]?.body).toEqual({ account: ACCOUNT })
  })

  test("account deletion still deletes the identity when erasing counts fails, and says so", async () => {
    state.forget = 500
    const result = await remove()
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ deleted: true, usageCounts: "deletion-failed" })
    expect(state.calls.at(-1)).toMatchObject({ method: "DELETE", path: `/auth/v1/admin/users/${ACCOUNT}` })
  })
})
