import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import handler from "../api/cloud-workspaces.js"
import { closeCloudWorkspaces } from "../api/_lib/cloud-workspaces.js"
import { mintCliToken } from "../api/_lib/cli-token.js"
import { verifyWorkspaceRequest } from "../packages/cloud-workspaces/src/signing.js"

const ACCOUNT = "79b8ab70-d17d-449c-8d73-67ff7d00b362"
const OTHER = "cb95d173-b802-4510-8a82-819b5920ffcc"
const WORKSPACE = "d2ed95ab-109b-47b9-bcc5-bc14b9d4d098"
const SECRET = "workspace-service-fixture-".repeat(3)
const workspace = {
  id: WORKSPACE,
  repository: "fixture/project",
  branch: "main",
  title: "Fixture workspace",
  state: "creating",
  createdAt: 1000,
  updatedAt: 1000,
  revision: 1,
}
const changes = {
  digest: "a".repeat(64),
  diff: "diff --git a/src/feature.ts b/src/feature.ts\n+fixture change\n",
  files: ["src/feature.ts"],
}
const pullRequest = {
  url: "https://github.com/fixture/project/pull/42",
  branch: `vector/${WORKSPACE}`,
  commit: "b".repeat(40),
}
const githubToken = "github_pat_synthetic_publication_fixture_1234567890"
const keys = [
  "NODE_ENV",
  "VERCEL_ENV",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VECTOR_ABUSE_SECRET",
  "VECTOR_LICENSE_SECRET",
  "VECTOR_WORKSPACES_ENABLED",
  "VECTOR_WORKSPACES_ACCOUNTS",
  "VECTOR_WORKSPACES_ORIGIN",
  "VECTOR_WORKSPACES_SECRET",
]
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const state = {
  auth: 0,
  revoked: false,
  rateCount: 1,
  scopeCounts: {} as Record<string, number>,
  upstreamStatus: 200,
  upstreamContentType: "application/json",
  upstreamLocation: "",
  redirected: 0,
  override: undefined as unknown,
  commands: [] as unknown[],
  requests: [] as {
    path: string
    method: string
    account: string
    body: string
    authorization: string | null
    nonce: string
  }[],
}
let upstream: ReturnType<typeof Bun.serve>
let api: ReturnType<typeof createServer>
let origin = ""

beforeAll(async () => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/account/auth/v1/user") {
        state.auth++
        if (request.headers.get("authorization") !== "Bearer workspace-browser-fixture")
          return Response.json({ error: "fixture unauthorized" }, { status: 401 })
        return Response.json({
          id: ACCOUNT,
          email: "workspace@example.test",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        })
      }
      if (path === "/kv") {
        const command = (await request.json()) as unknown[]
        state.commands.push(command)
        if (command[0] === "GET") return Response.json({ result: state.revoked ? "1" : null })
        if (command[0] === "EVAL") {
          const count =
            Object.entries(state.scopeCounts).find(([scope]) =>
              String(command[3]).startsWith(`vector:abuse:${scope}:`),
            )?.[1] ?? state.rateCount
          return Response.json({ result: [count, 60] })
        }
        return Response.json({ error: "unsupported fixture command" }, { status: 400 })
      }
      if (path === "/redirected") {
        state.redirected++
        return Response.json({ private: "redirect should never be followed" })
      }
      if (path.startsWith("/workspaces") || path === "/accounts/close") {
        const body = await request.text()
        const verified = verifyWorkspaceRequest({
          secret: SECRET,
          headers: request.headers,
          method: request.method,
          path,
          body,
        })
        state.requests.push({
          path,
          method: request.method,
          account: verified.accountId,
          body,
          authorization: request.headers.get("authorization"),
          nonce: verified.nonce,
        })
        const result =
          state.override !== undefined
            ? state.override
            : path === "/accounts/close"
              ? { closed: true }
              : request.method === "GET"
                ? { enabled: true, workspaces: [workspace] }
                : path.endsWith("/delete")
                  ? { deleted: true }
                  : path.endsWith("/changes")
                    ? { workspace, changes }
                    : path.endsWith("/publish")
                      ? { workspace, pullRequest }
                      : path.endsWith("/engine")
                        ? null
                        : { workspace }
        return new Response(JSON.stringify(result), {
          status: state.upstreamStatus,
          headers: {
            "content-type": state.upstreamContentType,
            ...(state.upstreamLocation ? { location: state.upstreamLocation } : {}),
          },
        })
      }
      return Response.json({ error: "unknown fixture route" }, { status: 404 })
    },
  })
  api = createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  const address = api.address()
  if (!address || typeof address === "string") throw new Error("Workspace API fixture did not bind")
  origin = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  delete process.env.VERCEL_ENV
  delete process.env.SUPABASE_ANON_KEY
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  Object.assign(process.env, {
    NODE_ENV: "test",
    SUPABASE_URL: upstream.url.origin + "/account",
    SUPABASE_PUBLISHABLE_KEY: "workspace-publishable-fixture",
    KV_REST_API_URL: upstream.url.origin + "/kv",
    KV_REST_API_TOKEN: "workspace-kv-fixture",
    VECTOR_ABUSE_SECRET: "workspace-abuse-fixture-".repeat(3),
    VECTOR_LICENSE_SECRET: "workspace-license-fixture-".repeat(3),
    VECTOR_WORKSPACES_ENABLED: "true",
    VECTOR_WORKSPACES_ACCOUNTS: ACCOUNT,
    VECTOR_WORKSPACES_ORIGIN: upstream.url.origin,
    VECTOR_WORKSPACES_SECRET: SECRET,
  })
  Object.assign(state, {
    auth: 0,
    revoked: false,
    rateCount: 1,
    scopeCounts: {},
    upstreamStatus: 200,
    upstreamContentType: "application/json",
    upstreamLocation: "",
    redirected: 0,
    override: undefined,
  })
  state.commands.length = 0
  state.requests.length = 0
})

afterAll(async () => {
  api.closeAllConnections()
  await new Promise<void>((resolve) => api.close(() => resolve()))
  await upstream.stop(true)
  for (const key of keys) previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key])
})

async function send(
  input: {
    method?: string
    body?: unknown
    raw?: string
    path?: string
    token?: string | null
    headers?: Record<string, string>
  } = {},
) {
  const method = input.method ?? (input.body !== undefined || input.raw !== undefined ? "POST" : "GET")
  const response = await fetch(origin + (input.path ?? "/api/cloud-workspaces"), {
    method,
    headers: {
      "content-type": "application/json",
      ...(input.token === null ? {} : { authorization: `Bearer ${input.token ?? "workspace-browser-fixture"}` }),
      ...input.headers,
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: input.raw ?? JSON.stringify(input.body ?? {}) }),
  })
  return { status: response.status, headers: response.headers, body: (await response.json()) as unknown }
}

test("signed account list reaches only the fixed host and exposes public workspace metadata", async () => {
  const result = await send({ headers: { "x-vector-account": OTHER, "x-vector-signature": "forged-fixture" } })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ enabled: true, workspaces: [workspace] })
  expect(state.requests).toMatchObject([
    { path: "/workspaces", method: "GET", account: ACCOUNT, body: "", authorization: null },
  ])
  expect(state.commands).toContainEqual(["GET", `vector:cli-revoked:${ACCOUNT}`])
  expect(JSON.stringify(result.body)).not.toContain(SECRET)
  await send()
  expect(state.requests[0]!.nonce).not.toBe(state.requests[1]!.nonce)
})

test("account closure signs the verified account and queues cleanup even when pilot access and workspace creation are disabled", async () => {
  process.env.VECTOR_WORKSPACES_ENABLED = "false"
  process.env.VECTOR_WORKSPACES_ACCOUNTS = OTHER
  expect(await closeCloudWorkspaces(ACCOUNT)).toEqual({ closed: true })
  expect(state.requests).toMatchObject([
    { path: "/accounts/close", method: "POST", account: ACCOUNT, body: "{}", authorization: null },
  ])
  expect(state.auth).toBe(0)
  expect(state.commands).toEqual([])
  expect(await closeCloudWorkspaces(ACCOUNT)).toEqual({ closed: true })
  expect(state.requests[0]!.nonce).not.toBe(state.requests[1]!.nonce)
})

test("account closure skips only never-configured deployments and refuses partial configuration, host failures or invalid acknowledgements", async () => {
  delete process.env.VECTOR_WORKSPACES_ORIGIN
  delete process.env.VECTOR_WORKSPACES_SECRET
  expect(await closeCloudWorkspaces(ACCOUNT)).toBeUndefined()
  expect(state.requests).toEqual([])
  process.env.VECTOR_WORKSPACES_ORIGIN = upstream.url.origin
  await expect(closeCloudWorkspaces(ACCOUNT)).rejects.toMatchObject({
    statusCode: 503,
    code: "WORKSPACE_SERVICE_UNAVAILABLE",
  })
  delete process.env.VECTOR_WORKSPACES_ORIGIN
  process.env.VECTOR_WORKSPACES_SECRET = SECRET
  await expect(closeCloudWorkspaces(ACCOUNT)).rejects.toMatchObject({ statusCode: 503 })
  expect(state.requests).toEqual([])
  process.env.VECTOR_WORKSPACES_ORIGIN = upstream.url.origin
  state.upstreamStatus = 500
  state.override = { error: { message: "fixture-private-cleanup-password" } }
  await expect(closeCloudWorkspaces(ACCOUNT)).rejects.toMatchObject({
    statusCode: 503,
    message: "Cloud workspaces are temporarily unavailable. Please try again.",
  })
  state.upstreamStatus = 200
  for (const value of [{ closed: false }, { closed: true, runtimeId: "private-fixture" }, null]) {
    state.override = value
    await expect(closeCloudWorkspaces(ACCOUNT)).rejects.toMatchObject({ statusCode: 503 })
  }
})

test("disabled and non-pilot accounts still authenticate and check revocation without touching the host", async () => {
  process.env.VECTOR_WORKSPACES_ENABLED = "false"
  expect((await send()).body).toEqual({ enabled: false, workspaces: [] })
  expect(state.auth).toBe(1)
  expect(state.commands).toContainEqual(["GET", `vector:cli-revoked:${ACCOUNT}`])
  expect((await send({ body: { action: "start", workspaceId: WORKSPACE } })).status).toBe(403)
  process.env.VECTOR_WORKSPACES_ENABLED = "true"
  process.env.VECTOR_WORKSPACES_ACCOUNTS = OTHER
  expect((await send()).body).toEqual({ enabled: false, workspaces: [] })
  expect((await send({ body: { action: "start", workspaceId: WORKSPACE } })).status).toBe(403)
  expect(state.requests).toEqual([])
})

test("missing, invalid and revoked identities cannot read or mutate workspaces", async () => {
  expect((await send({ token: null })).status).toBe(401)
  expect((await send({ token: "invalid-fixture" })).status).toBe(401)
  state.revoked = true
  expect((await send()).status).toBe(401)
  expect((await send({ body: { action: "delete", workspaceId: WORKSPACE } })).status).toBe(401)
  expect(state.requests).toEqual([])
})

test("signed CLI account tokens use the same revoked-account and pilot gates without reaching the host as credentials", async () => {
  const token = mintCliToken({ id: ACCOUNT, email: "workspace@example.test" }).token
  expect((await send({ token })).status).toBe(200)
  expect(state.auth).toBe(0)
  expect(state.requests[0]!.account).toBe(ACCOUNT)
  expect(state.requests[0]!.authorization).toBeNull()
  expect(JSON.stringify(state.requests)).not.toContain(token)
  state.revoked = true
  expect((await send({ token })).status).toBe(401)
})

test("create validates the command and binds its idempotency key and optional GitHub token in the signed body", async () => {
  state.upstreamStatus = 202
  const command = {
    action: "create",
    repository: "fixture/project",
    idempotencyKey: WORKSPACE,
    githubToken: "github_pat_synthetic_workspace_fixture_1234567890",
  }
  const result = await send({ body: command })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ workspace })
  expect(JSON.parse(state.requests[0]!.body)).toEqual({ ...command, branch: "main", title: "fixture/project" })
  expect(state.requests[0]!.path).toBe("/workspaces")
  expect(JSON.stringify(result.body)).not.toContain(command.githubToken)
  expect(state.commands.filter((value) => Array.isArray(value) && value[0] === "EVAL")).toHaveLength(2)
})

test("start, stop and delete use fixed account-signed host routes", async () => {
  for (const action of ["start", "stop", "delete"]) {
    const result = await send({ body: { action, workspaceId: WORKSPACE } })
    expect(result.status).toBe(200)
    expect(result.body).toEqual(action === "delete" ? { deleted: true } : { workspace })
    expect(state.requests.at(-1)).toMatchObject({
      path: `/workspaces/${WORKSPACE}/${action}`,
      method: "POST",
      account: ACCOUNT,
      body: "{}",
    })
  }
})

test("changes returns the selected workspace's bounded review and optional existing pull request", async () => {
  const command = { action: "changes", workspaceId: WORKSPACE }
  let result = await send({ body: command })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ workspace, changes })
  expect(state.requests[0]).toMatchObject({
    path: `/workspaces/${WORKSPACE}/changes`,
    method: "POST",
    body: "{}",
    account: ACCOUNT,
  })
  state.override = { workspace, changes, pullRequest }
  result = await send({ body: command })
  expect(result.body).toEqual({ workspace, changes, pullRequest })
})

test("publish signs exactly the reviewed digest, ephemeral GitHub credential and title without returning the credential", async () => {
  const command = {
    action: "publish",
    workspaceId: WORKSPACE,
    digest: changes.digest,
    githubToken,
    title: "Fix the fixture",
  }
  const result = await send({ body: command })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ workspace, pullRequest })
  expect(state.requests).toHaveLength(1)
  expect(state.requests[0]).toMatchObject({
    path: `/workspaces/${WORKSPACE}/publish`,
    method: "POST",
    account: ACCOUNT,
    authorization: null,
  })
  expect(JSON.parse(state.requests[0]!.body)).toEqual({ digest: changes.digest, githubToken, title: command.title })
  expect(JSON.stringify(result.body)).not.toContain(githubToken)
  const counters = state.commands
    .filter((value): value is unknown[] => Array.isArray(value) && value[0] === "EVAL")
    .map((value) => String(value[3]))
  expect(counters).toHaveLength(2)
  expect(counters[0]).toStartWith("vector:abuse:cloud-workspaces-write:")
  expect(counters[1]).toStartWith("vector:abuse:cloud-workspaces-publish:")
})

test("publication refuses unsupported fields, unreviewed digests and malformed credentials before host access", async () => {
  const command = {
    action: "publish",
    workspaceId: WORKSPACE,
    digest: changes.digest,
    githubToken,
    title: "Fix the fixture",
  }
  for (const patch of [
    { digest: undefined },
    { digest: "a".repeat(63) },
    { digest: "not-a-digest" },
    { githubToken: "short" },
    { githubToken: "token with spaces".repeat(3) },
    { title: "" },
    { title: "bad\ntitle" },
    { title: "x".repeat(201) },
    { repository: "another/project" },
    { url: "https://untrusted.example" },
    { force: true },
  ]) {
    expect((await send({ body: { ...command, ...patch } })).status).toBe(400)
  }
  expect((await send({ body: { action: "changes", workspaceId: WORKSPACE, path: "/private" } })).status).toBe(400)
  expect(state.requests).toEqual([])
})

test("publishing has its own six-per-hour account cap and never retries an uncertain host failure", async () => {
  const command = {
    action: "publish",
    workspaceId: WORKSPACE,
    digest: changes.digest,
    githubToken,
    title: "Fix the fixture",
  }
  state.scopeCounts["cloud-workspaces-publish"] = 7
  let result = await send({ body: command })
  expect(result.status).toBe(429)
  expect(state.requests).toEqual([])
  state.scopeCounts["cloud-workspaces-publish"] = 6
  state.upstreamStatus = 500
  state.override = { error: { message: githubToken, request: "private-host-details" } }
  result = await send({ body: command })
  expect(result.status).toBe(503)
  expect(state.requests).toHaveLength(1)
  expect(JSON.stringify(result.body)).not.toContain(githubToken)
  expect(JSON.stringify(result.body)).not.toContain("private-host-details")
})

test("changes rejects extra private fields, oversized UTF-8 diffs and nonrelative or excessive file lists", async () => {
  const command = { action: "changes", workspaceId: WORKSPACE }
  state.override = { workspace, changes: { ...changes, diff: "x".repeat(256 * 1024) } }
  expect((await send({ body: command })).status).toBe(200)
  for (const patch of [
    { digest: "a".repeat(65) },
    { token: githubToken },
    { diff: "é".repeat(128 * 1024 + 1) },
    { files: Array.from({ length: 101 }, (_, index) => `src/file${index}.ts`) },
    { files: ["/private/key"] },
    { files: ["../private/key"] },
    { files: ["src/../private"] },
    { files: ["src\\private"] },
    { files: ["src/\nprivate"] },
    { files: ["x".repeat(1025)] },
  ]) {
    state.override = { workspace, changes: { ...changes, ...patch } }
    const result = await send({ body: command })
    expect(result.status).toBe(503)
    expect(JSON.stringify(result.body)).not.toContain(githubToken)
  }
})

test("publication receipts bind the exact requested workspace, repository, deterministic branch and canonical GitHub pull URL", async () => {
  const command = {
    action: "publish",
    workspaceId: WORKSPACE,
    digest: changes.digest,
    githubToken,
    title: "Fix the fixture",
  }
  for (const patch of [
    { url: "https://github.com/another/project/pull/42" },
    { url: "https://github.com/fixture/project/pull/42?token=private" },
    { url: "https://github.com/fixture/project/pull/42#private" },
    { url: "https://github.com/fixture/project/pull/0" },
    { url: "https://github.com/fixture/project/pull/042" },
    { url: "https://github.com/fixture/project/pull/42/" },
    { url: "https://github.com.evil.example/fixture/project/pull/42" },
    { url: "https://github.com@evil.example/fixture/project/pull/42" },
    { branch: `vector/${OTHER}` },
    { branch: "main" },
    { commit: "b".repeat(39) },
    { commit: "z".repeat(40) },
    { token: githubToken },
  ]) {
    state.override = { workspace, pullRequest: { ...pullRequest, ...patch } }
    expect((await send({ body: command })).status).toBe(503)
    state.override = { workspace, changes, pullRequest: { ...pullRequest, ...patch } }
    expect((await send({ body: { action: "changes", workspaceId: WORKSPACE } })).status).toBe(503)
  }
  state.override = {
    workspace: { ...workspace, id: OTHER },
    pullRequest: { ...pullRequest, branch: `vector/${OTHER}` },
  }
  expect((await send({ body: command })).status).toBe(503)
  state.override = { workspace, pullRequest, enginePassword: "private-host-password" }
  expect((await send({ body: command })).status).toBe(503)
})

test("engine commands preserve raw JSON and a successful no-content result as null", async () => {
  const command = { action: "engine", workspaceId: WORKSPACE, method: "GET", path: "/session?roots=true&limit=50" }
  state.override = [{ id: "ses_fixture", title: "Saved fixture conversation" }]
  expect((await send({ body: command })).body).toEqual(state.override)
  expect(state.requests[0]!.path).toBe(`/workspaces/${WORKSPACE}/engine`)
  expect(JSON.parse(state.requests[0]!.body)).toEqual({ path: command.path, method: "GET" })
  state.override = null
  const result = await send({
    body: {
      action: "engine",
      workspaceId: WORKSPACE,
      method: "POST",
      path: "/session/ses_fixture/prompt_async",
      body: { messageID: "msg_0123456789abABCDEFGHIJKLMN", parts: [{ type: "text", text: "Fix the test" }] },
    },
  })
  expect(result.status).toBe(200)
  expect(result.body).toBeNull()
})

test("query routing, arbitrary engine paths, privilege fields and hostile repository selectors are refused before host access", async () => {
  expect((await send({ path: "/api/cloud-workspaces?directory=/private" })).status).toBe(400)
  expect((await send({ method: "PUT" })).status).toBe(405)
  for (const body of [
    { action: "create", repository: "https://github.com/fixture/project", idempotencyKey: WORKSPACE },
    { action: "create", repository: "fixture/project", idempotencyKey: WORKSPACE, enginePassword: "fixture" },
    { action: "create", repository: "fixture/project", branch: "main/../../escape", idempotencyKey: WORKSPACE },
    { action: "start", workspaceId: WORKSPACE, ownerId: OTHER },
    { action: "engine", workspaceId: WORKSPACE, method: "GET", path: "/session?directory=/private" },
    { action: "engine", workspaceId: WORKSPACE, method: "GET", path: "https://elsewhere.example/session" },
    { action: "engine", workspaceId: WORKSPACE, method: "POST", path: "/config", body: {} },
    {
      action: "engine",
      workspaceId: WORKSPACE,
      method: "POST",
      path: "/session",
      body: { permission: [{ action: "allow" }] },
    },
  ])
    expect((await send({ body })).status).toBe(400)
  expect(state.requests).toEqual([])
})

test("untrusted JSON origins, malformed JSON and oversized streamed bodies cannot reach the host", async () => {
  expect((await send({ body: {}, headers: { origin: "https://untrusted.example" } })).status).toBe(403)
  expect((await send({ raw: "{" })).status).toBe(400)
  expect((await send({ raw: JSON.stringify({ value: "x".repeat(128 * 1024) }) })).status).toBe(413)
  expect(state.requests).toEqual([])
})

test("persistent rate-limit or revocation-store failures close the gateway", async () => {
  state.rateCount = 241
  expect((await send()).status).toBe(429)
  state.rateCount = 1
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  expect((await send()).status).toBe(503)
  expect(state.requests).toEqual([])
})

test("engine GET polling shares the 240-read account budget while mutations retain their 60-write budget", async () => {
  state.rateCount = 61
  const read = { action: "engine", workspaceId: WORKSPACE, method: "GET", path: "/session/status" }
  let result = await send({ body: read })
  expect(result.status).toBe(200)
  expect(result.headers.get("x-ratelimit-limit")).toBe("240")
  expect((await send()).status).toBe(200)
  result = await send({ body: { action: "stop", workspaceId: WORKSPACE } })
  expect(result.status).toBe(429)
  expect(result.headers.get("x-ratelimit-limit")).toBe("60")
  expect(state.requests).toHaveLength(2)
  const counters = state.commands
    .filter((value): value is unknown[] => Array.isArray(value) && value[0] === "EVAL")
    .map((value) => String(value[3]))
  expect(counters[0]).toBe(counters[1])
  expect(counters[0]).toStartWith("vector:abuse:cloud-workspaces-read:")
  expect(counters[2]).toStartWith("vector:abuse:cloud-workspaces-write:")
  state.rateCount = 241
  expect((await send({ body: read })).status).toBe(429)
  expect(state.requests).toHaveLength(2)
})

test("prompt admission has a separate persistent 12-per-minute budget across the account's workspaces", async () => {
  const prompt = {
    action: "engine",
    workspaceId: WORKSPACE,
    method: "POST",
    path: "/session/ses_fixture/prompt_async",
    body: { messageID: "msg_0123456789abABCDEFGHIJKLMN", parts: [{ type: "text", text: "Fix the test" }] },
  }
  state.scopeCounts["cloud-workspaces-prompt"] = 12
  let result = await send({ body: prompt })
  expect(result.status).toBe(200)
  expect(result.headers.get("x-ratelimit-limit")).toBe("12")
  state.scopeCounts["cloud-workspaces-prompt"] = 13
  result = await send({ body: { ...prompt, workspaceId: OTHER } })
  expect(result.status).toBe(429)
  expect(result.headers.get("x-ratelimit-limit")).toBe("12")
  expect(state.requests).toHaveLength(1)
  const counters = state.commands
    .filter((value): value is unknown[] => Array.isArray(value) && value[0] === "EVAL")
    .map((value) => String(value[3]))
    .filter((key) => key.startsWith("vector:abuse:cloud-workspaces-prompt:"))
  expect(counters).toHaveLength(2)
  expect(counters[0]).toBe(counters[1])
})

test("only a fixed root HTTPS origin or explicit development loopback HTTP can be configured", async () => {
  for (const configured of [
    "http://untrusted.example",
    upstream.url.origin + "/path",
    upstream.url.origin + "/x/..",
    upstream.url.origin + "?x=1",
    upstream.url.origin + "#secret",
    "https://user:password@host.example",
  ]) {
    process.env.VECTOR_WORKSPACES_ORIGIN = configured
    expect((await send()).status).toBe(503)
  }
  process.env.VECTOR_WORKSPACES_ORIGIN = upstream.url.origin
  process.env.NODE_ENV = "production"
  expect((await send()).status).toBe(503)
  process.env.NODE_ENV = "test"
  process.env.VERCEL_ENV = "preview"
  expect((await send()).status).toBe(503)
  delete process.env.VERCEL_ENV
  process.env.VECTOR_WORKSPACES_SECRET = "short"
  expect((await send()).status).toBe(503)
  expect(state.requests).toEqual([])
})

test("host errors and invalid public records are redacted rather than exposing runtime metadata or credentials", async () => {
  state.upstreamStatus = 500
  state.override = { error: { code: "private", message: "fixture-private-password-and-host" } }
  let result = await send()
  expect(result.status).toBe(503)
  expect(JSON.stringify(result.body)).not.toContain("fixture-private")
  state.upstreamStatus = 200
  for (const patch of [
    { enginePassword: "fixture-private-password" },
    { runtimeId: "private-container" },
    { ownerId: OTHER },
    { state: "unknown" },
    { state: ["running"] },
    { id: "invalid" },
    { updatedAt: -1 },
  ]) {
    state.override = { enabled: true, workspaces: [{ ...workspace, ...patch }] }
    result = await send()
    expect(result.status).toBe(503)
    expect(JSON.stringify(result.body)).not.toContain("fixture-private")
    expect(JSON.stringify(result.body)).not.toContain("private-container")
  }
})

test("host not-found responses remain generic and never reveal another account", async () => {
  state.upstreamStatus = 404
  state.override = { ownerId: OTHER, repository: "private/repository" }
  const result = await send({ body: { action: "start", workspaceId: WORKSPACE } })
  expect(result.status).toBe(404)
  expect(JSON.stringify(result.body)).not.toContain(OTHER)
  expect(JSON.stringify(result.body)).not.toContain("private/repository")
})

test("redirects, non-JSON and oversized upstream bodies fail closed", async () => {
  state.upstreamStatus = 302
  state.upstreamLocation = upstream.url.origin + "/redirected"
  expect((await send()).status).toBe(503)
  expect(state.redirected).toBe(0)
  state.upstreamStatus = 200
  state.upstreamLocation = ""
  state.upstreamContentType = "text/html"
  expect((await send()).status).toBe(503)
  state.upstreamContentType = "application/json"
  state.override = { value: "x".repeat(2 * 1024 * 1024) }
  expect(
    (await send({ body: { action: "engine", workspaceId: WORKSPACE, method: "GET", path: "/session" } })).status,
  ).toBe(503)
})
