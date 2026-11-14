import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { bindingFor, createBindCode, suspendBinding, touchBinding } from "../../../api/_lib/cloud-agents-binding"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { consumeGithubOidc } from "../../../api/_lib/github-oidc"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("Cloud binding API tests require disposable loopback VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Binding API tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const keys = new Set<string>()
  const users = new Map<string, { id: string; email: string }>()
  const publicRepos = new Map<string, { body: unknown; status: number; calls: number }>()
  const state = { down: false }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const pathname = new URL(request.url).pathname
      if (pathname === "/auth/v1/user") {
        const user = users.get(request.headers.get("authorization") ?? "")
        return user
          ? Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
          : new Response(null, { status: 401 })
      }
      if (pathname.startsWith("/public/")) {
        expect(request.headers.has("authorization")).toBe(false)
        const entry = publicRepos.get(pathname.slice(8))!
        entry.calls++
        return Response.json(entry.body, { status: entry.status })
      }
      expect(pathname).toBe("/")
      expect(request.headers.get("authorization")).toBe("Bearer binding-fixture-kv")
      const command = (await request.json()) as (string | number)[]
      const count = command[0] === "EVAL" ? Number(command[2]) : 1
      command
        .slice(command[0] === "EVAL" ? 3 : 1, command[0] === "EVAL" ? 3 + count : 2)
        .forEach((key) => keys.add(String(key)))
      if (state.down) return new Response(null, { status: 503 })
      return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
    },
  })
  const environment = [
    "NODE_ENV",
    "VECTOR_ABUSE_SECRET",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_CLI_TOKEN_SECRET",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, {
      NODE_ENV: "production",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "binding-fixture-kv",
      VECTOR_CLI_TOKEN_SECRET: "cloud-binding-fixture-secret-32-characters",
      SUPABASE_URL: upstream.url.origin,
      SUPABASE_PUBLISHABLE_KEY: "binding-fixture-public-key",
    })
  })
  beforeEach(() => {
    process.env.VECTOR_ABUSE_SECRET = `binding-fixture-${crypto.randomUUID()}`
    state.down = false
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  async function fixture() {
    const github = await githubAppFixture({ store: persistentStore })
    github.state.run.event = "workflow_dispatch"
    github.state.job.name = "Vector bind"
    const user = { id: crypto.randomUUID(), email: "binding-fixture@example.invalid" }
    const other = { id: crypto.randomUUID(), email: "other-fixture@example.invalid" }
    users.set(`Bearer session_${user.id}`, user)
    const desktop = mintCliToken(user, Date.now(), "desktop").token
    const otherDesktop = mintCliToken(other, Date.now(), "desktop").token
    const publicRepo = {
      body: { ...github.state.repository, private: false, visibility: "public" },
      status: 200,
      calls: 0,
    }
    publicRepos.set(github.repositoryId, publicRepo)
    const allowance: CloudAgentAllowance = {
      active: true,
      plan: "vector-10",
      limits: { atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, runCeilingShare: 0.1 },
      allowanceSeconds: 18_000,
      meterEpoch: "p1793491200000",
      periodEnd: Date.now() + 86_400_000,
      premiumModels: false,
    }
    const policy: { allowance: CloudAgentAllowance; calls: string[]; now: number } = {
      allowance,
      calls: [],
      now: Date.now(),
    }
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url)
        if (target.origin === upstream.url.origin) return fetch(input, init)
        expect(target.href).toBe("https://api.github.com/repos/fixture-owner/project")
        expect(init?.redirect).toBe("error")
        return fetch(new URL(`/public/${github.repositoryId}`, upstream.url), init)
      },
      { preconnect: fetch.preconnect },
    )
    const api = createCloudAgentsApi({
      app: github.app,
      verify: github.verify,
      store: persistentStore,
      fetcher,
      now: () => policy.now,
      entitlement: async (account) => {
        policy.calls.push(account)
        return policy.allowance
      },
    })
    const handlers = { "bind-code": api.bindCode, bind: api.bind, bindings: api.bindings, unbind: api.unbind }
    const server = createServer((request, response) => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
      void handlers[route](request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    async function send(
      route: keyof typeof handlers,
      input: { token?: string; body?: unknown; query?: string; method?: string } = {},
    ) {
      const method = input.method ?? (route === "bindings" ? "GET" : "POST")
      const response = await fetch(`${origin}/${route}${input.query ?? ""}`, {
        method,
        headers: { authorization: `Bearer ${input.token ?? desktop}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(input.body ?? {}) }),
      })
      const body = await response.json()
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(JSON.stringify(body)).not.toMatch(/@example|billing|subscription|payment|dispute|fraud|closing|\$\d/i)
      return { status: response.status, body, retryAfter: response.headers.get("retry-after") }
    }
    async function code(input: { token?: string; body?: Record<string, unknown> } = {}) {
      return send("bind-code", {
        token: input.token,
        body: {
          repository: "fixture-owner/project",
          repositoryId: Number(github.repositoryId),
          defaultRef: "refs/heads/main",
          ...input.body,
        },
      })
    }
    async function bind(code: string, input: { claims?: Record<string, unknown>; version?: string } = {}) {
      return send("bind", {
        token: await github.makeToken("bind", { event_name: "workflow_dispatch", ...input.claims }),
        body: { code, workflowVersion: input.version ?? "3" },
      })
    }
    return {
      github,
      user,
      other,
      desktop,
      otherDesktop,
      publicRepo,
      policy,
      send,
      code,
      bind,
      async [Symbol.asyncDispose]() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await github[Symbol.asyncDispose]()
      },
    }
  }

  test("desktop and Supabase accounts bind, list and unbind without exposing account data", async () => {
    await using f = await fixture()
    const code = await f.code({ token: `session_${f.user.id}` })
    expect(code.status).toBe(200)
    expect(code.body.code).toMatch(/^vbc_[A-Za-z0-9_-]{43}$/)
    expect(code.body.expiresAt).toBe(f.policy.now + 600_000)
    const bound = await f.bind(code.body.code, { version: "2" })
    expect(bound.body).toEqual({
      bound: true,
      repository: "fixture-owner/project",
      repositoryId: f.github.repositoryId,
      generation: 1,
      workflowUpdate: true,
    })
    expect(f.github.tokens.size).toBe(0)
    await touchBinding(f.github.repositoryId, f.policy.now + 1000)
    const listing = await f.send("bindings")
    expect(listing.body.bindings).toEqual([
      {
        repository: "fixture-owner/project",
        repositoryId: f.github.repositoryId,
        generation: 1,
        boundAt: f.policy.now,
        lastUsedAt: f.policy.now + 1000,
        binder: { login: "fixture-person" },
        workflowVersion: "2",
        codium: "ready",
      },
    ])
    expect(f.policy.calls).toEqual([f.user.id])
    expect(
      (
        await f.send("unbind", {
          token: f.otherDesktop,
          body: { repositoryId: f.github.repositoryId, expectedGeneration: 1 },
        })
      ).status,
    ).toBe(403)
    expect(
      (await f.send("unbind", { body: { repositoryId: f.github.repositoryId, expectedGeneration: 1 } })).body,
    ).toEqual({ ok: true })
    expect(await bindingFor(f.github.repositoryId)).toBeUndefined()
  })

  test("a stale displayed generation cannot unbind a same-owner replacement", async () => {
    await using f = await fixture()
    expect((await f.bind((await f.code()).body.code)).status).toBe(200)
    const displayed = (await f.send("bindings")).body.bindings[0]
    expect(displayed.generation).toBe(1)
    expect((await f.bind((await f.code()).body.code)).status).toBe(200)
    const replacement = (await bindingFor(f.github.repositoryId))!
    expect(replacement.generation).toBe(2)
    const stale = await f.send("unbind", {
      body: { repositoryId: displayed.repositoryId, expectedGeneration: displayed.generation },
    })
    expect(stale.status).toBe(403)
    expect(stale.body.error.code).toBe("ACTOR_NOT_ALLOWED")
    expect(await bindingFor(f.github.repositoryId)).toEqual(replacement)
    expect((await f.send("bindings")).body.bindings[0].generation).toBe(2)
    expect(
      (
        await f.send("unbind", {
          body: { repositoryId: displayed.repositoryId, expectedGeneration: replacement.generation },
        })
      ).body,
    ).toEqual({ ok: true })
    expect(await bindingFor(f.github.repositoryId)).toBeUndefined()
  })

  test("public unbind requires an explicit positive safe integer generation and accepts no extra fields", async () => {
    await using f = await fixture()
    expect((await f.bind((await f.code()).body.code)).status).toBe(200)
    const before = (await bindingFor(f.github.repositoryId))!
    for (const condition of [
      {},
      ...[0, -1, 1.5, null, "1", true, Number.MAX_SAFE_INTEGER + 1].map((expectedGeneration) => ({
        expectedGeneration,
      })),
    ]) {
      expect((await f.send("unbind", { body: { repositoryId: f.github.repositoryId, ...condition } })).status).toBe(400)
      expect(await bindingFor(f.github.repositoryId)).toEqual(before)
    }
    expect(
      (
        await f.send("unbind", {
          body: { repositoryId: f.github.repositoryId, expectedGeneration: before.generation, account: f.user.id },
        })
      ).status,
    ).toBe(400)
    expect(await bindingFor(f.github.repositoryId)).toEqual(before)
  })

  test("only verified App-backed bind stores installation identity; public projections hide it and no-App rebind clears it", async () => {
    await using f = await fixture()
    const code = await f.code()
    expect((await f.code({ body: { installationId: "999" } })).status).toBe(400)
    expect(
      (
        await f.send("bind", {
          token: await f.github.makeToken("bind", { event_name: "workflow_dispatch" }),
          body: { code: code.body.code, workflowVersion: "3", installationId: "999" },
        })
      ).status,
    ).toBe(400)
    expect((await f.bind(code.body.code)).status).toBe(200)
    const binding = await bindingFor(f.github.repositoryId)
    expect(binding?.installationId).toBe("600")
    expect(
      ((await persistentStore(["HKEYS", `vector:cloud-agents:binding:${f.github.repositoryId}`])) as string[]).sort(),
    ).toEqual(
      [
        "repositoryId",
        "ownerId",
        "repository",
        "account",
        "visibility",
        "defaultRef",
        "generation",
        "binderGithubId",
        "binderLogin",
        "workflowVersion",
        "boundAt",
        "installationId",
      ].sort(),
    )
    expect(JSON.stringify((await f.send("bindings")).body)).not.toContain("installationId")
    f.github.state.enabled = false
    expect((await f.bind((await f.code()).body.code)).status).toBe(200)
    const rebound = await bindingFor(f.github.repositoryId)
    expect(rebound?.generation).toBe((binding?.generation ?? 0) + 1)
    expect(rebound?.installationId).toBeUndefined()
  })

  test("unmarked desktop credentials and revoked accounts cannot create or redeem bind codes", async () => {
    await using f = await fixture()
    const unmarked = mintCliToken(f.user).token
    expect((await f.code({ token: unmarked })).body.error.code).toBe("DESKTOP_SIGN_IN_REQUIRED")
    const code = await f.code()
    await persistentStore(["SET", `vector:cli-revoked:${f.user.id}`, "1"])
    expect((await f.code()).status).toBe(401)
    expect((await f.bind(code.body.code)).status).toBe(401)
    expect(await bindingFor(f.github.repositoryId)).toBeUndefined()
  })

  test("without the App, protected refs and the code's default ref bind", async () => {
    for (const protectedRef of [false, true]) {
      await using f = await fixture()
      f.github.state.enabled = false
      const code = await f.code({ body: protectedRef ? { defaultRef: undefined } : {} })
      expect((await f.bind(code.body.code, { claims: { ref_protected: String(protectedRef) } })).status).toBe(200)
      expect(f.publicRepo.calls).toBe(0)
    }
  })

  test("public fallback verifies repository identity and caches only a matching default branch", async () => {
    await using f = await fixture()
    f.github.state.enabled = false
    const code = await f.code({ body: { defaultRef: undefined } })
    const claims = { repository_visibility: "public" }
    expect((await f.bind(code.body.code, { claims })).status).toBe(200)
    expect(f.publicRepo.calls).toBe(1)
    const key = `vector:cloud-agents:default-branch:${f.github.repositoryId}`
    expect(JSON.parse(String(await redis.send("GET", [key])))).toEqual({
      repository: "fixture-owner/project",
      ownerId: "456",
      defaultRef: "refs/heads/main",
    })
    expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(3590)
    expect((await f.bind((await f.code({ body: { defaultRef: undefined } })).body.code, { claims })).status).toBe(200)
    expect(f.publicRepo.calls).toBe(1)
    await persistentStore(["SET", key, "bad cache"])
    expect(
      (await f.bind((await f.code({ body: { defaultRef: undefined } })).body.code, { claims })).body.error.code,
    ).toBe("PERSISTENT_STORE_UNAVAILABLE")
  })

  test("a refused default branch preserves the code; private fallback never fetches GitHub", async () => {
    await using f = await fixture()
    f.github.state.enabled = false
    const code = await f.code({ body: { defaultRef: undefined } })
    expect((await f.bind(code.body.code)).body.error.code).toBe("BIND_NEEDS_DEFAULT_BRANCH")
    expect(f.publicRepo.calls).toBe(0)
    f.publicRepo.body.default_branch = "other"
    expect((await f.bind(code.body.code, { claims: { repository_visibility: "public" } })).body.error.code).toBe(
      "BIND_NEEDS_DEFAULT_BRANCH",
    )
    f.publicRepo.body.default_branch = "main"
    expect((await f.bind(code.body.code, { claims: { repository_visibility: "public" } })).status).toBe(200)
  })

  test("used codes, repository and actor mismatches share BIND_CODE_INVALID; replay preserves an unused code", async () => {
    await using f = await fixture()
    const code = await f.code({ body: { githubUserId: 789 } })
    expect((await f.bind(code.body.code, { claims: { actor: "other-person", actor_id: "790" } })).body.error.code).toBe(
      "BIND_CODE_INVALID",
    )
    const wrong = await createBindCode({ account: f.user.id, repository: "fixture-owner/other", now: f.policy.now })
    expect((await f.bind(wrong.code)).body.error.code).toBe("BIND_CODE_INVALID")
    const proof = await f.github.makeToken("bind", { event_name: "workflow_dispatch" })
    await consumeGithubOidc(await f.github.verify(proof, "bind"))
    const replay = await f.send("bind", { token: proof, body: { code: code.body.code, workflowVersion: "3" } })
    expect(replay.body.error.code).toBe("OIDC_REPLAYED")
    expect((await f.bind(code.body.code)).status).toBe(200)
    expect((await f.bind(code.body.code)).body.error.code).toBe("BIND_CODE_INVALID")
  })

  test("takeovers require inactivity, age, suspension, transfer or a verified App admin", async () => {
    for (const mode of [
      "active",
      "service-off",
      "source-unavailable",
      "inactive",
      "aged",
      "suspended",
      "transferred",
      "admin",
    ] as const) {
      await using f = await fixture()
      expect((await f.bind((await f.code()).body.code)).status).toBe(200)
      const code = await f.code({ token: f.otherDesktop })
      if (mode === "inactive") f.policy.allowance = { active: false, reason: "none" }
      if (mode === "service-off" || mode === "source-unavailable") f.policy.allowance = { active: false, reason: mode }
      if (mode === "aged") f.policy.now += 30 * 86_400_000
      if (mode === "suspended") await suspendBinding((await bindingFor(f.github.repositoryId))!, "binder-left")
      if (mode === "transferred") {
        // The App is absent, so the signed owner id is the authority for the transferred binding.
        f.github.state.enabled = false
      }
      if (mode === "admin") f.github.state.permission = "admin"
      const fresh = mode === "aged" ? await f.code({ token: f.otherDesktop }) : code
      const answer = await f.bind(fresh.body.code, {
        claims: mode === "transferred" ? { repository_owner_id: "999" } : {},
      })
      const refused = ["active", "service-off", "source-unavailable"].includes(mode)
      expect({ mode, status: answer.status }).toEqual({ mode, status: refused ? 409 : 200 })
      if (refused) expect(answer.body.error.code).toBe("REPO_BOUND_ELSEWHERE")
      expect((await bindingFor(f.github.repositoryId))?.account).toBe(refused ? f.user.id : f.other.id)
    }
  })

  test("parallel accounts can redeem only one binding and the losing code survives", async () => {
    await using f = await fixture()
    const first = await f.code()
    const second = await f.code({ token: f.otherDesktop })
    const results = await Promise.all([f.bind(first.body.code), f.bind(second.body.code)])
    expect(results.map((item) => item.status).sort()).toEqual([200, 409])
    const binding = (await bindingFor(f.github.repositoryId))!
    expect(binding.generation).toBe(1)
    expect(binding.account === f.user.id || binding.account === f.other.id).toBe(true)
    f.github.state.permission = "admin"
    expect((await f.bind(results[0]!.status === 200 ? second.body.code : first.body.code)).status).toBe(200)
  })

  test("binder-left listings hide repository and binder even for formerly public repositories", async () => {
    await using f = await fixture()
    expect((await f.bind((await f.code()).body.code, { claims: { repository_visibility: "public" } })).status).toBe(200)
    await suspendBinding((await bindingFor(f.github.repositoryId))!, "binder-left")
    const listing = await f.send("bindings")
    expect(listing.body.bindings).toEqual([
      {
        repositoryId: f.github.repositoryId,
        generation: 2,
        boundAt: f.policy.now,
        workflowVersion: "3",
        codium: "unavailable",
        suspended: "binder-left",
      },
    ])
    expect(f.policy.calls).toEqual([f.user.id])
  })

  test("body validation, query strings and store outages fail closed", async () => {
    await using f = await fixture()
    for (const body of [
      { repository: "fixture-owner/project", extra: true },
      { repository: "fixture-owner/project", repositoryId: 1.2 },
      { repository: "fixture-owner/project", defaultRef: 3 },
    ]) {
      expect((await f.send("bind-code", { body })).status).toBe(400)
    }
    expect((await f.send("bindings", { query: "?token=never" })).status).toBe(400)
    expect((await f.send("unbind", { body: { repositoryId: 42 } })).status).toBe(400)
    state.down = true
    expect((await f.code()).body.error.code).toBe("PERSISTENT_STORE_UNAVAILABLE")
  })

  test("bind-code account and bind repository limits stop excess requests", async () => {
    await using f = await fixture()
    for (let i = 0; i < 10; i++) expect((await f.code()).status).toBe(200)
    const limited = await f.code()
    expect(limited.status).toBe(429)
    expect(limited.retryAfter).toBeTruthy()
    f.github.state.enabled = false
    for (let i = 0; i < 10; i++) expect((await f.bind("vbc_" + "A".repeat(43))).status).toBe(403)
    expect((await f.bind("vbc_" + "A".repeat(43))).status).toBe(429)
  })

  test("public fallback refuses wrong ids, owners, visibility and missing repositories without burning the code", async () => {
    for (const mode of ["id", "owner", "private", "missing"] as const) {
      await using f = await fixture()
      f.github.state.installed = false
      const code = await f.code({ body: { defaultRef: undefined } })
      const previous = { ...f.publicRepo.body }
      if (mode === "id") f.publicRepo.body.id++
      if (mode === "owner") f.publicRepo.body.owner = { ...f.publicRepo.body.owner, id: 999 }
      if (mode === "private") f.publicRepo.body.private = true
      if (mode === "missing") f.publicRepo.status = 404
      const claims = { repository_visibility: "public" }
      expect((await f.bind(code.body.code, { claims })).body.error.code).toBe("BIND_NEEDS_DEFAULT_BRANCH")
      f.publicRepo.body = previous
      f.publicRepo.status = 200
      expect((await f.bind(code.body.code, { claims })).status).toBe(200)
    }
  })

  test("account read rate limits apply before another entitlement read", async () => {
    await using f = await fixture()
    for (let i = 0; i < 60; i++) expect((await f.send("bindings")).status).toBe(200)
    expect((await f.send("bindings")).status).toBe(429)
    expect(f.policy.calls).toHaveLength(60)
  })
}
