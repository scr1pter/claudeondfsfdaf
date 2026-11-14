import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken, verifyCliTokenClaims } from "../../../api/_lib/cli-token"
import {
  createRunVerifierRegistry,
  registerRunVerifier,
  requireModelPlanCaller,
  requireModelPlanClient,
  type ModelPlanCaller,
} from "../../../api/_lib/model-plan-caller"
import { handleModelPlanChat, requireModelPlanUser } from "../../../api/_lib/model-plan-chat"
import { handleModelPlanModels } from "../../../api/_lib/model-plan-models"
import { handleModelPlanStatus } from "../../../api/_lib/model-plan-status"
import {
  handleModelPlanChange,
  handleModelPlanCheckout,
  handleModelPlanPortal,
} from "../../../api/_lib/model-plan-billing"
import { ApiError } from "../../../api/_lib/http"
import { revokeCliToken } from "../../../api/_lib/revocation"
import profile from "../../../api/account/profile"
import deleteAccount from "../../../api/account/delete"

const user = { id: "22222222-2222-4222-8222-222222222222", email: "fixture@example.test" }
const now = Date.UTC(2026, 9, 29)
const run: ModelPlanCaller = {
  account: { id: user.id },
  kind: "run",
  purpose: "review",
  run: {
    id: "run_fixture",
    source: "github-comment",
    deadline: now + 3600000,
    service: "cloud-agents",
    ceilingShare: 0.1,
  },
}
const record = new Map<string, string>()
const state = { unavailable: false, calls: [] as string[][], providers: [] as string[] }
const environment: Record<string, string> = {
  VECTOR_CLI_TOKEN_SECRET: "fixture-caller-secret-that-is-long-enough",
  VECTOR_ABUSE_SECRET: "fixture-caller-abuse-secret-that-is-long-enough",
  MODEL_PLANS_ENABLED: "true",
  MODEL_PLANS_MIN_CLIENT: "1.99.113",
  MODEL_PLAN_REQUIRE_MARKED_TOKENS: "true",
  MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
  STRIPE_SECRET_KEY: "sk_test_caller_fixture",
  STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
  OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
  KV_REST_API_TOKEN: "fixture-store-token",
  SUPABASE_PUBLISHABLE_KEY: "fixture-auth-key",
  ...Object.fromEntries(
    [10, 50, 100, 200].map((price) => [`STRIPE_MODEL_PLAN_${price}_PRICE_ID`, `price_fixture${price}`]),
  ),
  ...Object.fromEntries(
    [
      [10, 4],
      [50, 22],
      [100, 48],
      [200, 100],
    ].map(([price, credits]) => [`MODEL_PLAN_${price}_CREDITS_USD`, String(credits)]),
  ),
}
const names = [
  ...Object.keys(environment),
  "KV_REST_API_URL",
  "SUPABASE_URL",
  "NODE_ENV",
  "VERCEL_ENV",
  "MODEL_PLAN_MODELS_JSON",
]
const previous = new Map(names.map((key) => [key, process.env[key]]))
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/auth/v1/user") return new Response(null, { status: 401 })
    if (state.unavailable) return new Response(null, { status: 503 })
    const command = (await request.json()) as string[]
    state.calls.push(command)
    if (command[0] === "GET") return Response.json({ result: record.get(command[1]!) ?? null })
    if (command[0] === "SET") {
      record.set(command[1]!, command[2]!)
      return Response.json({ result: "OK" })
    }
    if (command[0] === "EVAL" && command[1]?.includes("'INCR'")) return Response.json({ result: [1, 60] })
    // The catalog reads the owner's switched-off models (A18): none here.
    if (command[0] === "SMEMBERS" && command[1] === "vector:codium:test:models-off")
      return Response.json({ result: [] })
    throw new Error("Unexpected caller fixture command")
  },
})
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== upstream.url.origin) {
    state.providers.push(url.origin)
    throw new Error("Caller fixture refuses external destinations")
  }
  return fetch(input, init)
}) as typeof fetch
const incoming = (headers: IncomingMessage["headers"]) => ({ headers })
const modern = { "x-vector-client": "1.99.113", "x-vector-catalog": "2" }
const bearer = (token: string, extra: Record<string, string> = {}) =>
  incoming({ authorization: `Bearer ${token}`, ...extra })
const runtimeRun = { ...run, run: { ...run.run!, deadline: Date.now() + 3600000 } }
// These are test-only static service registrations. Production has no run verifier until its service/admission ships.
registerRunVerifier("vrt_", async (token) => {
  if (token !== "vrt_fixture.signature") throw new ApiError(401, "FIXTURE_RUN_INVALID", "Invalid fixture run")
  return runtimeRun
})
registerRunVerifier("vht_", async (token) => {
  if (token !== "vht_fixture.signature") throw new ApiError(401, "FIXTURE_RUN_INVALID", "Invalid fixture run")
  return {
    ...runtimeRun,
    purpose: "hosted",
    run: { ...runtimeRun.run, service: "hosted", sessionId: "session_fixture" },
  }
})
const server = createServer((request, response) => {
  if (request.url === "/chat") return void handleModelPlanChat(request, response, fetcher)
  if (request.url === "/models") return void handleModelPlanModels(request, response, fetcher)
  if (request.url === "/status") return void handleModelPlanStatus(request, response, fetcher)
  if (request.url === "/checkout") return void handleModelPlanCheckout(request, response, fetcher)
  if (request.url === "/change") return void handleModelPlanChange(request, response, fetcher)
  if (request.url === "/portal") return void handleModelPlanPortal(request, response, fetcher)
  if (request.url === "/profile") return void profile(request, response)
  return void deleteAccount(request, response)
})
const origin = { url: "" }
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  Object.assign(process.env, environment, {
    KV_REST_API_URL: upstream.url.origin,
    SUPABASE_URL: upstream.url.origin,
    NODE_ENV: "development",
  })
  delete process.env.VERCEL_ENV
  delete process.env.MODEL_PLAN_MODELS_JSON
  record.clear()
  state.calls = []
  state.providers = []
  state.unavailable = false
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  for (const [key, value] of previous) {
    delete process.env[key]
    if (value !== undefined) process.env[key] = value
  }
})
async function request(route: string, token?: string, headers: Record<string, string> = modern) {
  const get = ["models", "status", "profile"].includes(route)
  const response = await fetch(`${origin.url}/${route}`, {
    method: get ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    // An unknown model deliberately stops an authenticated chat before any credential/hold/provider work.
    ...(get
      ? {}
      : {
          body: JSON.stringify({
            model: "fixture/not-listed",
            messages: [{ role: "user", content: "fixture" }],
            plan: "vector-10",
          }),
        }),
  })
  return { status: response.status, body: await response.json() }
}

describe("client protocol hints", () => {
  test.each([
    "",
    "1.99.112",
    "1.9.999",
    "1.99.113-beta",
    "1.99.113.1",
    "v1.99.113",
    "1.99",
    "1.99.NaN",
    "99999.1.1",
    "local",
  ])("production refuses missing/old/malformed version %s", (version) => {
    process.env.VERCEL_ENV = "production"
    expect(() => requireModelPlanClient(incoming({ "x-vector-client": version }))).toThrow()
  })
  test("numeric versions compare by component; local requires both production signals to be absent", () => {
    for (const version of ["1.99.113", "1.100.0", "2.0.0"])
      expect(requireModelPlanClient(incoming({ "x-vector-client": version }))).toBe(version)
    expect(requireModelPlanClient(incoming({ "x-vector-client": "local" }))).toBe("local")
    process.env.NODE_ENV = "production"
    expect(() => requireModelPlanClient(incoming({ "x-vector-client": "local" }))).toThrow()
    expect(() => requireModelPlanClient(incoming({ "x-vector-client": ["2.0.0", "local"] }))).toThrow()
  })
  test.each(["", "1.99.112", "1.99.113-beta", "local"])(
    "actual chat refuses %s before revocation, hold or provider reads",
    async (version) => {
      process.env.VERCEL_ENV = "production"
      expect(
        await request("chat", mintCliToken(user, Date.now(), "desktop").token, { "x-vector-client": version }),
      ).toMatchObject({ status: 426, body: { error: { code: "CODIUM_UPDATE_REQUIRED" } } })
      expect(state.calls).toEqual([])
      expect(state.providers).toEqual([])
      expect(await request("models", undefined, { "x-vector-client": version })).toEqual({
        status: 200,
        body: { enabled: false, models: [] },
      })
    },
  )
})

describe("marked account callers", () => {
  test.each(["desktop", "cli"] as const)(
    "signed %s claim, not headers, grants the paid caller kind",
    async (client) => {
      const token = mintCliToken(user, now, client).token
      expect(await requireModelPlanCaller(bearer(token, { "x-vector-purpose": "judge" }), fetcher, now)).toEqual({
        account: { id: user.id },
        kind: client,
        purpose: "judge",
      })
    },
  )
  test("only documented account purposes are hints; run-only and unknown values count as task", async () => {
    const token = mintCliToken(user, now, "desktop").token
    for (const purpose of ["chat", "title", "brain", "review", "judge", "race", "playbook", "task"] as const)
      expect((await requireModelPlanCaller(bearer(token, { "x-vector-purpose": purpose }), fetcher, now)).purpose).toBe(
        purpose,
      )
    for (const purpose of ["", "unknown", "cloud-agents", "hosted"])
      expect((await requireModelPlanCaller(bearer(token, { "x-vector-purpose": purpose }), fetcher, now)).purpose).toBe(
        "task",
      )
  })
  test("legacy marks are refused by default, retained for general status/free auth, and only explicitly overridden", async () => {
    const token = mintCliToken(user, now).token
    await expect(requireModelPlanCaller(bearer(token, modern), fetcher, now)).rejects.toMatchObject({
      code: "CODIUM_SIGN_IN_REQUIRED",
    })
    expect(await requireModelPlanUser(bearer(token) as IncomingMessage, fetcher, now)).toEqual(user)
    process.env.MODEL_PLAN_REQUIRE_MARKED_TOKENS = "false"
    expect((await requireModelPlanCaller(bearer(token), fetcher, now)).kind).toBe("cli")
  })
  test("revoking one cli jti leaves another grant and desktop sign-in usable", async () => {
    const first = mintCliToken(user, now, "cli")
    const second = mintCliToken(user, now, "cli")
    const claims = verifyCliTokenClaims(first.token, now)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fetcher, now)
    await expect(requireModelPlanCaller(bearer(first.token), fetcher, now)).rejects.toMatchObject({
      code: "CODIUM_SIGN_IN_REQUIRED",
    })
    expect((await requireModelPlanCaller(bearer(second.token), fetcher, now)).kind).toBe("cli")
    expect((await requireModelPlanCaller(bearer(mintCliToken(user, now, "desktop").token), fetcher, now)).kind).toBe(
      "desktop",
    )
  })
  test("actual chat/models refuse unmarked, suffixed, expired and revoked grants while status retains legacy auth", async () => {
    const desktop = mintCliToken(user, Date.now(), "desktop").token
    const unmarked = mintCliToken(user).token
    for (const token of [
      unmarked,
      `${desktop}.suffix`,
      mintCliToken(user, Date.now() - 100 * 86400000, "desktop").token,
    ])
      for (const route of ["chat", "models"])
        expect(await request(route, token)).toMatchObject({
          status: 401,
          body: { error: { code: "CODIUM_SIGN_IN_REQUIRED" } },
        })
    expect(await request("status", unmarked)).toMatchObject({ status: 200, body: { active: false } })
    const cli = mintCliToken(user, Date.now(), "cli").token
    const claims = verifyCliTokenClaims(cli)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fetcher)
    for (const route of ["chat", "models", "status", "profile"]) expect((await request(route, cli)).status).toBe(401)
    expect(state.providers).toEqual([])
  })
  test("actual marked chat passes auth and stops at model validation, while CLI cannot open the portal", async () => {
    for (const client of ["desktop", "cli"] as const) {
      const token = mintCliToken(user, Date.now(), client).token
      expect(await request("chat", token)).toMatchObject({ status: 400, body: { error: { code: "MODEL_PLAN_MODEL" } } })
      expect((await request("models", token)).status).toBe(200)
      if (client === "cli")
        expect(await request("portal", token)).toMatchObject({
          status: 403,
          body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
        })
    }
    state.unavailable = true
    expect((await request("chat", mintCliToken(user, Date.now(), "cli").token)).status).toBe(503)
    expect(state.providers).toEqual([])
  })
})

describe("run verifier domains", () => {
  test("registrations are isolated, prefixes exact and duplicate production registration rejected", async () => {
    const registry = createRunVerifierRegistry()
    await expect(requireModelPlanCaller(bearer("vrt_fixture.signature"), fetcher, now, registry)).rejects.toMatchObject(
      { code: "MODEL_PLAN_RUN_EXPIRED" },
    )
    registry.register("vrt_", async () => run)
    expect(
      (
        await requireModelPlanCaller(
          bearer("vrt_fixture.signature", { "x-vector-purpose": "brain" }),
          fetcher,
          now,
          registry,
        )
      ).purpose,
    ).toBe("review")
    expect(() => registry.register("vrt_", async () => run)).toThrow("exactly one")
    expect(() => registry.register("other_" as "vrt_", async () => run)).toThrow("exactly one")
    expect(() => registerRunVerifier("vrt_", async () => run)).toThrow("exactly one")
    await expect(
      requireModelPlanCaller(bearer("unknown_fixture.signature"), fetcher, now, registry),
    ).rejects.toMatchObject({ code: "CODIUM_SIGN_IN_REQUIRED" })
  })
  test.each([
    { patch: { kind: "cli" } },
    { patch: { account: { id: "foreign" } } },
    { patch: { purpose: "unknown" } },
    { patch: { run: undefined } },
    { patch: { run: { ...run.run, id: "" } } },
    // The admission grammar (§4.6 held member and `run:<id>`): no ':', at most 128 characters, never '-'.
    { patch: { run: { ...run.run, id: "github:12345:7" } } },
    { patch: { run: { ...run.run, id: "x".repeat(129) } } },
    { patch: { run: { ...run.run, id: "-" } } },
    { patch: { run: { ...run.run, source: "slack" } } },
    { patch: { run: { ...run.run, deadline: now } } },
    { patch: { run: { ...run.run, deadline: Infinity } } },
    { patch: { run: { ...run.run, service: "hosted" } } },
    { patch: { run: { ...run.run, ceilingShare: 0 } } },
    { patch: { run: { ...run.run, ceilingShare: 1.01 } } },
  ])("untrusted verifier results cannot widen run authority %j", async ({ patch }) => {
    const registry = createRunVerifierRegistry()
    registry.register("vrt_", async () => ({ ...run, ...patch }) as unknown as ModelPlanCaller)
    await expect(requireModelPlanCaller(bearer("vrt_fixture.signature"), fetcher, now, registry)).rejects.toMatchObject(
      { code: "MODEL_PLAN_RUN_EXPIRED" },
    )
  })
  test("hosted tokens need a matching service and session; account revocation and store failures apply to runs", async () => {
    const registry = createRunVerifierRegistry()
    registry.register("vht_", async () => ({ ...run, run: { ...run.run!, service: "hosted" } }))
    await expect(requireModelPlanCaller(bearer("vht_fixture.signature"), fetcher, now, registry)).rejects.toMatchObject(
      { code: "MODEL_PLAN_RUN_EXPIRED" },
    )
    const valid = createRunVerifierRegistry()
    valid.register("vht_", async () => ({
      ...run,
      purpose: "hosted",
      run: { ...run.run!, service: "hosted", sessionId: "session_fixture" },
    }))
    expect((await requireModelPlanCaller(bearer("vht_fixture.signature"), fetcher, now, valid)).run?.sessionId).toBe(
      "session_fixture",
    )
    record.set(`vector:cli-revoked:${user.id}`, "1")
    await expect(requireModelPlanCaller(bearer("vht_fixture.signature"), fetcher, now, valid)).rejects.toMatchObject({
      statusCode: 401,
    })
    state.unavailable = true
    await expect(requireModelPlanCaller(bearer("vht_fixture.signature"), fetcher, now, valid)).rejects.toMatchObject({
      statusCode: 503,
    })
  })
  test.each(["vrt_fixture.signature", "vht_fixture.signature"])(
    "actual %s runs enter only chat/models, never account or billing endpoints",
    async (token) => {
      expect((await request("models", token)).status).toBe(200)
      expect(await request("chat", token)).toMatchObject({ status: 400, body: { error: { code: "MODEL_PLAN_MODEL" } } })
      for (const route of ["status", "checkout", "change", "portal", "profile", "delete"])
        expect((await request(route, token)).status).toBe(401)
      expect(state.providers).toEqual([])
    },
  )
})
