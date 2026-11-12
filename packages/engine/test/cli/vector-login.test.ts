import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@vectordevai/core/global"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { VectorAccount } from "@vectordevai/core/vector-account"
import codeHandler from "../../../../api/account/cli-code"
import exchangeHandler from "../../../../api/account/cli-exchange"
import verifyHandler from "../../../../api/account/cli-verify"
import { mintCliToken, verifyCliTokenClaims } from "../../../../api/_lib/cli-token"
import { revokeCliToken } from "../../../../api/_lib/revocation"
import { requireModelPlanCaller, requireModelPlanClient } from "../../../../api/_lib/model-plan-caller"
import {
  cliSignInCallback,
  cliSignInCancel,
  desktopSignInRequest,
  desktopSignInStep,
} from "../../../web/src/lib/desktop-sign-in"
// Loaded before this file sets the site, as when another test file in the same process loaded it first: the CLI reads
// its site on each call.
import {
  confirmStoredSignIn,
  login,
  storedTokenMarked,
  tokenMarked,
  type LoginOptions,
} from "../../src/cli/vector-account"

// The whole `vector login` flow, offline: the CLI's loopback listener and exchange, the website's request parsing,
// approval and callback, and the real code and exchange endpoints over a fake key-value store and identity service.

const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
const records = new Map<string, string>()
const exchanges: Record<string, unknown>[] = []
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/auth/v1/user")
      return request.headers.get("authorization") === "Bearer synthetic-session"
        ? Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z", user_metadata: {} })
        : new Response(null, { status: 401 })
    if (route.startsWith("/rest/v1/")) return Response.json(null)
    if (request.method === "GET" || route.startsWith("/set/")) return Response.json({ result: null })
    const parts = (await request.json()) as string[]
    // Revocation reads: what revokeCliToken wrote, else nothing is revoked.
    if (parts[0] === "GET") return Response.json({ result: records.get(parts[1]!) ?? null })
    if (parts[0] === "SET") {
      records.set(parts[1]!, parts[2]!)
      return Response.json({ result: "OK" })
    }
    if (parts[0] !== "EVAL") return Response.json({ result: null })
    if (parts[1]!.includes("'INCR'")) return Response.json({ result: [1, 300] })
    // The exchange's atomic check-and-delete, as its Lua script does it.
    const raw = records.get(parts[3]!)
    if (!raw) return Response.json({ result: null })
    const record = JSON.parse(raw)
    if (record.state !== parts[4] || record.challenge !== parts[5] || record.expiresAt <= Number(parts[6]))
      return Response.json({ result: null })
    records.delete(parts[3]!)
    return Response.json({ result: raw })
  },
})
const site = createServer((request: IncomingMessage, response: ServerResponse) => {
  // An outage or a captive portal: no answer from the account API counts as a refusal.
  if (state.down) return void response.writeHead(503).end()
  if (request.url === "/api/account/cli-code") return void codeHandler(request as never, response as never)
  if (request.url === "/api/account/cli-verify") return void verifyHandler(request as never, response as never)
  if (request.url !== "/api/account/cli-exchange") return void response.writeHead(404).end()
  // Keep what the CLI sent, to replay it exactly; the handler reads the same body.
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8")
    exchanges.push(JSON.parse(body))
    void exchangeHandler(Object.assign(request, { body }) as never, response as never)
  })
})
const environment = {
  NODE_ENV: "development",
  KV_REST_API_URL: upstream.url.origin,
  KV_REST_API_TOKEN: "synthetic-kv",
  VECTOR_CLI_TOKEN_SECRET: "synthetic-token-secret".repeat(3),
  VECTOR_ABUSE_SECRET: "synthetic-abuse-secret".repeat(3),
  SUPABASE_URL: upstream.url.origin,
  SUPABASE_PUBLISHABLE_KEY: "synthetic-public",
  VECTOR_SITE_URL: "",
  VECTOR_DISABLE_USAGE: "1",
}
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
const state = { origin: "", down: false }
const authFile = path.join(Global.Path.data, "cli-auth.json")
const teamsFile = path.join(Global.Path.data, "teams.json")
const checkedFile = path.join(Global.Path.data, "cli-token-checked.json")

beforeAll(async () => {
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
  const address = site.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
  Object.assign(process.env, { ...environment, VECTOR_SITE_URL: state.origin })
})
afterAll(() => {
  site.closeAllConnections()
  site.close()
  upstream.stop(true)
  for (const key of Object.keys(environment)) delete process.env[key]
  Object.assign(process.env, Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)))
})
beforeEach(async () => {
  records.clear()
  state.down = false
  exchanges.length = 0
  await rm(authFile, { force: true })
  await rm(teamsFile, { force: true })
  await rm(checkedFile, { force: true })
})

// Everything the CLI writes to the terminal while it runs.
async function captured<T>(run: () => Promise<T>) {
  const written: string[] = []
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const capture = (chunk: unknown) => (written.push(String(chunk)), true)
  process.stdout.write = capture as typeof process.stdout.write
  process.stderr.write = capture as typeof process.stderr.write
  try {
    return { value: await run(), text: () => written.join("") }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

// Starts `vector login`, and plays the website once the CLI opens it: the request it parses, then Approve.
async function start(options: LoginOptions = {}) {
  const opened = Promise.withResolvers<string>()
  const run = captured(() => login(undefined, { ...options, openBrowser: async (url) => opened.resolve(url) }))
  const url = new URL(await opened.promise)
  const request = desktopSignInRequest(url.search)
  if (request?.purpose !== "cli") throw new Error("Expected a CLI sign-in request")
  return { url, request, run }
}

async function mint(body: Record<string, unknown>) {
  const response = await fetch(`${state.origin}/api/account/cli-code`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-session" },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

function claims(token: string) {
  return JSON.parse(Buffer.from(token.slice(4).split(".")[0]!, "base64url").toString("utf8"))
}

// The gateway's own caller checks, run on exactly what the core client sends to Codium.
async function codiumCaller(token: string) {
  const seen = Promise.withResolvers<Headers>()
  await ModelPlans.createFetch({
    modelID: "vendor/coder",
    credential: async () => token,
    catalog: async () => ({
      enabled: true,
      models: [{ id: "vendor/coder", name: "Coder", contextLength: 32_000, maxOutputTokens: 4096 }],
    }),
    request: async (_url, init) => {
      seen.resolve(new Headers(init.headers))
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })("https://vectordev.ai/api/model-plans/chat", {
    headers: { "X-Vector-Purpose": "title" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  })
  const headers = Object.fromEntries((await seen.promise).entries())
  requireModelPlanClient({ headers })
  return requireModelPlanCaller({ headers })
}

test("vector login signs in through the website and the loopback, and stores a CLI grant it never shows", async () => {
  const { url, request, run } = await start()
  expect(url.origin + url.pathname).toBe(`${state.origin}/auth/cli`)
  expect(url.searchParams.get("purpose")).toBe("cli")
  // The page asks first: a link alone mints nothing.
  expect(desktopSignInStep(false, request)).toBe("ask")
  expect(records.size).toBe(0)
  expect(desktopSignInStep(true, request)).toBe("send")
  const minted = await mint({ state: request.state, challenge: request.challenge, purpose: "cli" })
  const callback = new URL(cliSignInCallback(minted, request))
  expect(callback.origin).toBe(`http://127.0.0.1:${request.port}`)
  // A callback with another state is refused and the CLI keeps waiting for the real one.
  const forged = new URL(callback)
  forged.searchParams.set("state", `${request.state.slice(0, -1)}${request.state.endsWith("A") ? "B" : "A"}`)
  expect((await fetch(forged)).status).toBe(400)
  const page = await fetch(callback)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).not.toContain(String(minted.code))
  // The code is taken once.
  expect((await fetch(callback)).status).toBe(409)
  const result = await run
  expect(result.value).toEqual(user)

  const stored = JSON.parse(await readFile(authFile, "utf8"))
  expect(claims(stored.token)).toMatchObject({ sub: user.id, client: "cli", jti: expect.any(String) })
  expect(tokenMarked(stored.token)).toBe(true)
  if (process.platform !== "win32") expect((await stat(authFile)).mode & 0o777).toBe(0o600)
  // The grant is never printed, put in a URL or shown on the callback page.
  for (const shown of [result.text(), url.href, callback.href, html]) expect(shown).not.toContain(stored.token)
  expect(result.text()).toContain(`Signed in as ${user.email}`)

  // The core client's chat request is accepted by the gateway's marked-caller gate as this CLI.
  expect(await VectorAccount.readVectorToken(authFile)).toBe(stored.token)
  expect(await codiumCaller(stored.token)).toMatchObject({ account: { id: user.id }, kind: "cli", purpose: "title" })

  // Replaying the exact exchange the CLI made is refused: the code was used.
  expect(exchanges).toHaveLength(1)
  const replay = await fetch(`${state.origin}/api/account/cli-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exchanges[0]),
  })
  expect(replay.status).toBe(400)
  expect(await replay.json()).toMatchObject({ error: { code: "DESKTOP_CODE_INVALID" } })
})

test("a code minted without the CLI purpose buys another credential, which the CLI refuses to keep", async () => {
  const { request, run } = await start()
  // The purpose is stripped on the way: the code now buys a desktop grant.
  const minted = await mint({ state: request.state, challenge: request.challenge })
  expect((await fetch(cliSignInCallback(minted, request))).status).toBe(200)
  const result = await run
  expect(result.value).toBeUndefined()
  expect(result.text()).toContain("did not return a CLI sign-in")
  await expect(stat(authFile)).rejects.toThrow()
})

test("a code bound to another challenge cannot be exchanged, and nothing is stored", async () => {
  const { request, run } = await start()
  const other = desktopSignInRequest(
    `?desktop=1&state=${request.state}&code_challenge=${"A".repeat(43)}&code_challenge_method=S256&purpose=cli&port=${request.port}`,
  )
  const minted = await mint({ state: request.state, challenge: other?.challenge, purpose: "cli" })
  expect((await fetch(cliSignInCallback(minted, request))).status).toBe(200)
  const result = await run
  expect(result.value).toBeUndefined()
  expect(result.text()).toContain("expired or was already used")
  await expect(stat(authFile)).rejects.toThrow()
})

test("Cancel on the page, an abort or a timeout ends the wait, closes the listener and stores nothing", async () => {
  const cancelled = await start()
  expect((await fetch(cliSignInCancel(cancelled.request))).status).toBe(400)
  const declined = await cancelled.run
  expect(declined.value).toBeUndefined()
  expect(declined.text()).toContain("Vector sign-in was declined")
  expect(records.size).toBe(0)

  const controller = new AbortController()
  const aborted = await start({ signal: controller.signal })
  controller.abort()
  expect((await aborted.run).value).toBeUndefined()
  // The listener is gone.
  await expect(fetch(`http://127.0.0.1:${aborted.request.port}/callback`)).rejects.toThrow()

  const timed = await start({ timeoutMs: 20 })
  const late = await timed.run
  expect(late.value).toBeUndefined()
  expect(late.text()).toContain("timed out")
  await expect(stat(authFile)).rejects.toThrow()
})

test("a browser sign-in as another account replaces a copied token's sign-in with its team choice", async () => {
  const other = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" }
  const present = (file: string) =>
    stat(file).then(
      () => true,
      () => false,
    )
  for (const [owner, kept] of [
    [other, false],
    [user, true],
  ] as const) {
    await writeFile(authFile, JSON.stringify({ token: mintCliToken(owner).token, user: owner, verifiedAt: Date.now() }))
    await writeFile(teamsFile, "{}")
    await writeFile(checkedFile, "[]")
    const { request, run } = await start()
    const minted = await mint({ state: request.state, challenge: request.challenge, purpose: "cli" })
    expect((await fetch(cliSignInCallback(minted, request))).status).toBe(200)
    expect((await run).value).toEqual(user)
    expect(JSON.parse(await readFile(authFile, "utf8")).user).toEqual(user)
    // Another account's team choice and checked tokens go with its sign-in; the same account keeps them.
    expect({ owner: owner.id, teams: await present(teamsFile), checked: await present(checkedFile) }).toEqual({
      owner: owner.id,
      teams: kept,
      checked: kept,
    })
  }
})

test("a copied token stays unmarked: it signs the CLI in for free models, and Codium refuses it", async () => {
  const copied = mintCliToken(user).token
  const result = await captured(() => login(copied))
  expect(result.value).toEqual(user)
  expect(result.text()).toContain("A copied token works with free models only")
  expect(result.text()).not.toContain(copied)
  expect(tokenMarked(copied)).toBe(false)
  expect(await storedTokenMarked()).toBe(false)
  await expect(codiumCaller(copied)).rejects.toMatchObject({ statusCode: 401, code: "CODIUM_SIGN_IN_REQUIRED" })
})

test("vector login keeps a stored grant only while vectordev.ai accepts it, and signs out one revoked or expired", async () => {
  const present = (file: string) =>
    stat(file).then(
      () => true,
      () => false,
    )
  const store = async (token: string) => {
    await writeFile(authFile, JSON.stringify({ token, user, verifiedAt: Date.now() }))
    await writeFile(teamsFile, "{}")
  }
  const grant = mintCliToken(user, Date.now(), "cli").token
  await store(grant)
  expect(await confirmStoredSignIn()).toBe(true)
  expect(JSON.parse(await readFile(authFile, "utf8")).token).toBe(grant)
  // An unreachable site is not a refusal: the sign-in stands, as at the day's check.
  state.down = true
  expect(await confirmStoredSignIn()).toBe(true)
  state.down = false
  expect(await present(authFile)).toBe(true)
  // Revoked on its own from the account, on a day this terminal already checked it.
  const claims = verifyCliTokenClaims(grant)
  if (!claims.jti) throw new Error("Expected a CLI grant")
  await revokeCliToken(claims.id, claims.jti, claims.expiresAt)
  expect(await confirmStoredSignIn()).toBe(false)
  expect({ auth: await present(authFile), teams: await present(teamsFile) }).toEqual({ auth: false, teams: false })
  // Past its ninety days.
  await store(mintCliToken(user, Date.now() - 91 * 24 * 60 * 60 * 1000, "cli").token)
  expect(await confirmStoredSignIn()).toBe(false)
  expect(await present(authFile)).toBe(false)
  expect(await confirmStoredSignIn()).toBe(false)
})
