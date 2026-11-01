import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { createGithubApi } from "../../../api/_lib/github-api"
import { consumeGithubOidc } from "../../../api/_lib/github-oidc"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubTokenPermissions } from "../../../api/_lib/github-app"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("GitHub App HTTP/replay tests require explicit VECTOR_TEST_REDIS_URL for disposable loopback Redis", () => {})
    return
  }
  // Only random test-owned keys are touched; no flush/database-wide deletion.
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("GitHub exchange tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const state = { down: false, replayDown: false }
  const commands: Array<(string | number)[]> = []
  const keys = new Set<string>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      expect(request.headers.get("authorization")).toBe("Bearer github-fixture-kv")
      const command = (await request.json()) as (string | number)[]
      commands.push(command)
      if (state.down || (state.replayDown && command[0] === "SET")) return new Response(null, { status: 503 })
      keys.add(String(command[command[0] === "EVAL" ? 3 : 1]))
      return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
    },
  })
  const environment = ["NODE_ENV", "VECTOR_ABUSE_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

  beforeAll(async () => {
    await redis.connect()
    expect(await redis.send("PING", [])).toBe("PONG")
    Object.assign(process.env, {
      NODE_ENV: "production",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "github-fixture-kv",
    })
  })
  beforeEach(() => {
    process.env.VECTOR_ABUSE_SECRET = `github-fixture-${crypto.randomUUID()}`
    state.down = false
    state.replayDown = false
    commands.length = 0
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  async function apiFixture() {
    const fixture = await githubAppFixture({ store: persistentStore })
    const api = createGithubApi({ app: fixture.app, verify: fixture.verify })
    const server = createServer((request, response) => {
      void (request.url?.startsWith("/api/github/installation") ? api.installation : api.token)(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    return {
      ...fixture,
      async send(
        input: {
          method?: string
          path?: string
          token?: string
          body?: unknown
          raw?: string
          headers?: Record<string, string>
        } = {},
      ) {
        const method = input.method ?? "POST"
        const response = await fetch(`${origin}${input.path ?? "/api/github/token"}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
            ...input.headers,
          },
          ...(method === "GET" ? {} : { body: input.raw ?? JSON.stringify(input.body ?? { purpose: "task" }) }),
        })
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
      },
      async [Symbol.asyncDispose]() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await fixture[Symbol.asyncDispose]()
      },
    }
  }

  test("HTTP installation status and token exchange verify signatures and expose only the contracted credential", async () => {
    await using fixture = await apiFixture()
    const configuration = await fixture.send({ method: "GET", path: "/api/github/installation" })
    expect(await configuration.json()).toEqual({
      available: true,
      installUrl: "https://github.com/apps/vector-fixture/installations/new",
    })
    expect(fixture.state.requests).toEqual([])
    const status = await fixture.send({
      path: "/api/github/installation",
      token: await fixture.makeToken("installation"),
      body: {},
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({
      installed: true,
      repositoryId: fixture.repositoryId,
      installUrl: "https://github.com/apps/vector-fixture/installations/new",
    })
    expect(fixture.tokens.size).toBe(0)
    const identityToken = await fixture.makeToken()
    const response = await fixture.send({ token: identityToken, body: { purpose: "task", pullRequest: 17 } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(["bot", "expiresAt", "permissions", "repository", "repositoryId", "token"])
    expect(body).toMatchObject({
      repository: "fixture-owner/project",
      repositoryId: fixture.repositoryId,
      permissions: githubTokenPermissions.task,
      bot: { id: 9000, login: "vector-fixture[bot]" },
    })
    expect(fixture.tokens.has(body.token)).toBe(true)
    expect(JSON.stringify(body)).not.toContain(identityToken)
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY")
    expect(commands.some((command) => command[0] === "SET" && command[3] === "NX" && command[4] === "EX")).toBe(true)
    expect(JSON.stringify(commands)).not.toContain(identityToken)
    expect(JSON.stringify(commands)).not.toContain(body.token)
  })

  test("atomic Redis replay admission permits only one concurrent final credential", async () => {
    await using fixture = await apiFixture()
    const token = await fixture.makeToken()
    const responses = await Promise.all([fixture.send({ token }), fixture.send({ token })])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(await responses.find((response) => response.status === 409)!.json()).toMatchObject({
      error: { code: "OIDC_REPLAYED" },
    })
    expect(fixture.state.minted.filter((item) => item.purpose === "task")).toHaveLength(1)
    expect(fixture.tokens.size).toBe(1)
    const claim = commands.find((command) => command[0] === "SET")!
    expect(await redis.send("GET", [String(claim[1])])).toBe("1")
    const ttl = Number(await redis.send("TTL", [String(claim[1])]))
    expect(ttl).toBeGreaterThan(300)
    expect(ttl).toBeLessThanOrEqual(331)
  })

  test("failed final issuance consumes the proof; a fresh signed proof may retry within the job limit", async () => {
    await using fixture = await apiFixture()
    fixture.state.failFinalMint = true
    const token = await fixture.makeToken()
    const failed = await fixture.send({ token })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: "GITHUB_UNAVAILABLE" } })
    fixture.state.failFinalMint = false
    expect((await fixture.send({ token })).status).toBe(409)
    expect((await fixture.send({ token: await fixture.makeToken() })).status).toBe(200)
    expect(fixture.tokens.size).toBe(1)
  })

  test("persistent-store outages fail closed before issuing a final App token", async () => {
    await using fixture = await apiFixture()
    state.down = true
    const unavailable = await fixture.send({ token: await fixture.makeToken() })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ error: { code: "PERSISTENT_STORE_UNAVAILABLE" } })
    expect(fixture.state.requests).toEqual([])
    state.down = false
    state.replayDown = true
    const replay = await fixture.send({ token: await fixture.makeToken() })
    expect(replay.status).toBe(503)
    expect(await replay.json()).toMatchObject({ error: { code: "PERSISTENT_STORE_UNAVAILABLE" } })
    expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
    expect(fixture.tokens.size).toBe(0)
  })

  test("job and repository mint limits execute persistent Lua and stop excess final credentials", async () => {
    await using fixture = await apiFixture()
    for (const iteration of [0, 1, 2]) {
      expect((await fixture.send({ token: await fixture.makeToken() })).status).toBe(200)
      expect(fixture.tokens.size).toBe(iteration + 1)
    }
    const jobLimit = await fixture.send({ token: await fixture.makeToken() })
    expect(jobLimit.status).toBe(429)
    expect(Number(jobLimit.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await jobLimit.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
    for (let index = 0; index < 17; index++) {
      fixture.state.job.check_run_url = `https://api.github.com/repos/fixture-owner/project/check-runs/${2000 + index}`
      expect(
        (await fixture.send({ token: await fixture.makeToken("token", { check_run_id: String(2000 + index) }) }))
          .status,
      ).toBe(200)
    }
    fixture.state.job.check_run_url = "https://api.github.com/repos/fixture-owner/project/check-runs/3000"
    const repositoryLimit = await fixture.send({ token: await fixture.makeToken("token", { check_run_id: "3000" }) })
    expect(repositoryLimit.status).toBe(429)
    expect(fixture.state.minted.filter((item) => item.purpose === "task")).toHaveLength(20)
  })

  test("HTTP rejects unsupported bodies, origins, audiences and anonymous private installation queries", async () => {
    await using fixture = await apiFixture()
    const token = await fixture.makeToken()
    for (const body of [
      [],
      null,
      { purpose: "admin" },
      { purpose: "task", repository: "other/repo" },
      { purpose: "task", pullRequest: 0 },
      { purpose: "task", pullRequest: "17" },
    ]) {
      const response = await fixture.send({ token, raw: JSON.stringify(body) })
      expect(response.status).toBe(400)
    }
    expect((await fixture.send({ token, raw: "{" })).status).toBe(400)
    expect((await fixture.send({ token, raw: `{"extra":"${"x".repeat(2_000)}"}` })).status).toBe(413)
    expect((await fixture.send({ token, headers: { origin: "https://untrusted.example" } })).status).toBe(403)
    expect((await fixture.send({ token, headers: { "content-type": "text/plain" } })).status).toBe(415)
    expect((await fixture.send({ token, path: "/api/github/token?repository=other/repo" })).status).toBe(400)
    expect((await fixture.send({ method: "GET" })).status).toBe(405)
    expect((await fixture.send({ path: "/api/github/installation", body: {} })).status).toBe(401)
    expect((await fixture.send({ path: "/api/github/installation", token, body: {} })).status).toBe(401)
    expect((await fixture.send({ token: await fixture.makeToken("installation") })).status).toBe(401)
    expect(
      (
        await fixture.send({
          path: "/api/github/installation",
          token: await fixture.makeToken("installation"),
          body: { repository: "other/repo" },
        })
      ).status,
    ).toBe(400)
    expect(fixture.state.minted).toEqual([])
  })

  test("configuration and missing installation support polling without fabricating a bot or token", async () => {
    await using fixture = await apiFixture()
    fixture.state.installed = false
    const status = await fixture.send({
      path: "/api/github/installation",
      token: await fixture.makeToken("installation"),
      body: {},
    })
    expect(status.status).toBe(200)
    expect(status.headers.get("retry-after")).toBe("10")
    expect(await status.json()).toEqual({
      installed: false,
      repositoryId: fixture.repositoryId,
      installUrl: "https://github.com/apps/vector-fixture/installations/new",
      retryAfterSeconds: 10,
    })
    const missing = await fixture.send({ token: await fixture.makeToken() })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "APP_NOT_INSTALLED" } })
    fixture.state.enabled = false
    expect(await (await fixture.send({ method: "GET", path: "/api/github/installation" })).json()).toEqual({
      available: false,
    })
    const disabled = await fixture.send({ token: await fixture.makeToken() })
    expect(disabled.status).toBe(503)
    expect(await disabled.json()).toMatchObject({ error: { code: "GITHUB_APP_NOT_CONFIGURED" } })
    expect(fixture.state.minted).toEqual([])
  })

  test("proof expiry during repository authorization cannot reach replay admission or mint", async () => {
    await using fixture = await apiFixture()
    const identity = await fixture.identity()
    await expect(consumeGithubOidc({ ...identity, expiresAt: Math.floor(Date.now() / 1000) })).rejects.toMatchObject({
      code: "OIDC_INVALID",
    })
    expect(commands).toEqual([])
    expect(fixture.state.minted).toEqual([])
  })

  test("policy denials retain non-fallback status and upstream errors never echo credentials", async () => {
    await using fixture = await apiFixture()
    const token = await fixture.makeToken()
    fixture.state.permission = "read"
    const actor = await fixture.send({ token })
    expect(actor.status).toBe(403)
    expect(await actor.json()).toMatchObject({ error: { code: "ACTOR_NOT_ALLOWED" } })
    fixture.state.permission = "write"
    fixture.state.job.name = "Vector review"
    const job = await fixture.send({ token })
    expect(job.status).toBe(403)
    expect(await job.json()).toMatchObject({ error: { code: "WORKFLOW_NOT_TRUSTED" } })
    fixture.state.job.name = "Vector task"
    fixture.state.prHeadId = 998
    const fork = await fixture.send({ token, body: { purpose: "task", pullRequest: 17 } })
    expect(fork.status).toBe(403)
    expect(await fork.json()).toMatchObject({ error: { code: "EVENT_NOT_ALLOWED" } })
    fixture.state.failPath = "/repos/fixture-owner/project/actions/workflows/500"
    const failure = await fixture.send({ token })
    expect(failure.status).toBe(503)
    const text = await failure.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: "GITHUB_UNAVAILABLE" } })
    expect(text).not.toContain(token)
    expect(text).not.toContain("authorization")
    expect(text).not.toContain("fixture upstream failure")
    expect(text).not.toContain(fixture.config.privateKey)
    fixture.state.minted.forEach((credential) => expect(text).not.toContain(credential.token))
    expect(fixture.tokens.size).toBe(0)
    expect(commands.some((command) => command[0] === "SET")).toBe(false)
  })

  test("unauthenticated IP limits run before any GitHub request or signature-key fetch", async () => {
    await using fixture = await apiFixture()
    for (let attempt = 0; attempt < 60; attempt++) expect((await fixture.send()).status).toBe(401)
    const response = await fixture.send()
    expect(response.status).toBe(429)
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(fixture.state.requests).toEqual([])
    expect(fixture.state.minted).toEqual([])
    expect(commands).toHaveLength(61)
  })
  test("publish exchanges return no actions permission and agent/bind jobs cannot obtain tokens", async () => {
    await using fixture = await apiFixture()
    fixture.state.job.name = "Vector publish"
    const response = await fixture.send({ token: await fixture.makeToken(), body: { purpose: "publish" } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.permissions).toEqual(githubTokenPermissions.publish)
    expect(body.permissions).not.toHaveProperty("actions")
    for (const job of ["Vector agent", "Vector bind"]) {
      fixture.state.job.name = job
      const denied = await fixture.send({ token: await fixture.makeToken(), body: { purpose: "publish" } })
      expect(denied.status).toBe(403)
      expect((await denied.json()).error.code).toBe("WORKFLOW_NOT_TRUSTED")
    }
    expect(fixture.state.minted.filter((item) => item.purpose !== "validation")).toHaveLength(1)
  })

  test("mint verification caches binder write access for one hour in the real store, bound to generation", async () => {
    await using fixture = await apiFixture()
    fixture.state.job.name = "Vector agent"
    const identity = await fixture.verify(await fixture.makeToken("mint"), "mint")
    const options = {
      job: "agent" as const,
      thread: "17",
      commentId: 123,
      binder: { githubId: "790", login: "fixture-binder" },
      account: crypto.randomUUID(),
      defaultRef: "refs/heads/main",
      generation: 1,
    }
    expect(await fixture.app.verifyRun(identity, options)).toEqual({ installed: true, binder: "ok" })
    const key = `vector:cloud-agents:binder-ok:${fixture.repositoryId}`
    expect(await redis.send("GET", [key])).toBe(
      JSON.stringify({ account: options.account, githubId: "790", generation: 1 }),
    )
    expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(3590)
    expect(Number(await redis.send("TTL", [key]))).toBeLessThanOrEqual(3600)
    fixture.state.binderPermission = "read"
    expect(await fixture.app.verifyRun(identity, options)).toEqual({ installed: true, binder: "ok" })
    expect(await fixture.app.verifyRun(identity, { ...options, generation: 2 })).toEqual({
      installed: true,
      binder: "binder-left",
    })
    await redis.send("DEL", [key])
    expect(await fixture.app.verifyRun(identity, options)).toEqual({ installed: true, binder: "binder-left" })
    expect(await redis.send("GET", [key])).toBeNull()
    expect(fixture.tokens.size).toBe(0)
  })
}
