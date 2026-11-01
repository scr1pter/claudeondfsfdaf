import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { bindingFor, createBindCode, redeemAndBind } from "../../../api/_lib/cloud-agents-binding"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { liveKey, liveRun, usedKey } from "../../../api/_lib/cloud-agents-ledger"
import { mintRunToken, readRunToken, verifyRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { eraseCloudAgentsAccount, listCloudRuns } from "../../../api/_lib/cloud-agents-runs"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("Cloud mint API tests require disposable loopback VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Mint tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const keys = new Set<string>()
  const state = { down: false }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      expect(new URL(request.url).pathname).toBe("/")
      expect(request.headers.get("authorization")).toBe("Bearer mint-fixture-kv")
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
    "VECTOR_RUN_TOKEN_SECRET",
    "VECTOR_LICENSE_SECRET",
    "VECTOR_CLI_TOKEN_SECRET",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, {
      NODE_ENV: "production",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "mint-fixture-kv",
      VECTOR_RUN_TOKEN_SECRET: "cloud-mint-fixture-secret-32-characters",
      VECTOR_CLI_TOKEN_SECRET: "cloud-mint-cli-fixture-secret-32-characters",
    })
  })
  beforeEach(() => {
    process.env.VECTOR_ABUSE_SECRET = `mint-fixture-${crypto.randomUUID()}`
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
    github.state.job.name = "Vector agent"
    const account = crypto.randomUUID()
    const policy: {
      now: number
      allowance: CloudAgentAllowance
      before?: number
      beforeCall?: () => Promise<void>
      onStore?: (command: readonly (string | number)[]) => Promise<void>
    } = {
      now: Date.now(),
      allowance: {
        active: true,
        plan: "vector-100",
        limits: { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
        allowanceSeconds: 144_000,
        meterEpoch: "p1793491200000",
        periodEnd: Date.now() + 86_400_000,
        premiumModels: true,
      },
    }
    const identity = {
      repository: "fixture-owner/project",
      repositoryId: github.repositoryId,
      ownerId: "456",
      actor: github.state.binder.login,
      actorId: String(github.state.binder.id),
      ref: "refs/heads/main",
    }
    async function bind(owner = account) {
      const code = await createBindCode({ account: owner, repository: identity.repository, now: policy.now })
      return redeemAndBind({
        code: code.code,
        account: owner,
        current: (await bindingFor(github.repositoryId))?.account,
        identity,
        workflowVersion: "3",
        takeover: { adminVerified: true, allowanceInactive: false },
        now: policy.now,
      })
    }
    const binding = await bind()
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url)
        expect(target.origin).toBe(upstream.url.origin)
        return fetch(input, init)
      },
      { preconnect: fetch.preconnect },
    )
    const api = createCloudAgentsApi({
      app: github.app,
      verify: github.verify,
      fetcher,
      now: () => policy.now,
      store: async (command) => {
        await policy.onStore?.(command)
        return persistentStore(command)
      },
      entitlement: async () => {
        await policy.beforeCall?.()
        return policy.allowance
      },
      revokedBefore: async () => policy.before,
    })
    const handlers = { mint: api.mint, heartbeat: api.heartbeat, settle: api.settle }
    const server = createServer((request, response) => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
      void handlers[route](request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    async function send(route: keyof typeof handlers, token: string, body: unknown, query = "") {
      const response = await fetch(`${origin}/${route}${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const answer = await response.json()
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(JSON.stringify(answer)).not.toMatch(
        /"(?:reason|plan|account|email)"|billing|subscription|payment|dispute|fraud|closing|\$\d/i,
      )
      return { status: response.status, body: answer, retryAfter: response.headers.get("retry-after") }
    }
    async function mint(body: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) {
      return send("mint", await github.makeToken("mint", claims), {
        purpose: "task",
        thread: "17",
        workflowVersion: "3",
        commentId: 123,
        ...body,
      })
    }
    async function revoke() {
      await persistentStore(["SET", `vector:cli-revoked:${account}`, "1"])
    }
    return {
      github,
      account,
      binding,
      bind,
      policy,
      send,
      mint,
      revoke,
      async close() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await github[Symbol.asyncDispose]()
      },
    }
  }

  test("mint, renewal, heartbeat and atomic settlement keep one reservation and the first verdict", async () => {
    const f = await fixture()
    const logs = spyOn(console, "info").mockImplementation(() => {})
    try {
      const first = await f.mint()
      expect(first.status).toBe(200)
      const claims = readRunToken(first.body.token, f.policy.now)
      expect(claims.thr).toBe("17")
      expect(claims.gen).toBe(f.binding.generation)
      expect(first.body).toMatchObject({ heartbeatSeconds: 60, idleSeconds: 600 })
      expect(logs.mock.calls.at(-1)?.[1]).toEqual({
        repositoryId: f.github.repositoryId,
        runId: "1000",
        runAttempt: "1",
        checkRunId: "1001",
        source: "github-comment",
        purpose: "task",
      })
      f.policy.now += 60_000
      const second = await f.mint({ thread: "17" })
      expect(second.status).toBe(200)
      expect(second.body.deadline).toBe(first.body.deadline)
      expect((await f.send("heartbeat", first.body.token, { state: "running" })).status).toBe(401)
      expect((await f.send("heartbeat", second.body.token, { state: "running" })).body).toEqual({
        ok: true,
        stop: false,
      })
      const replies = await Promise.all(
        ["changes", "failed", "draft"].map((outcome) => f.send("settle", second.body.token, { outcome })),
      )
      expect(replies.map((x) => x.status)).toEqual([200, 200, 200])
      const records = await listCloudRuns(f.account)
      const outcome = records[0]?.outcome
      expect(["changes", "failed", "draft"]).toContain(outcome ?? "")
      expect(records[0]?.verdict).toBe(outcome === "changes" ? "pass" : "fail")
      expect(await liveRun(f.account, first.body.runId)).toBeUndefined()
      expect(await persistentStore(["GET", usedKey(f.account, claims.epoch)])).toBe("60")
      expect((await f.send("settle", second.body.token, { outcome: "cancelled" })).status).toBe(200)
      expect((await listCloudRuns(f.account))[0]?.outcome).toBe(outcome)
      expect((await f.send("heartbeat", second.body.token, { state: "running" })).status).toBe(401)
      await expect(verifyRunToken(second.body.token, { now: f.policy.now })).rejects.toMatchObject({ statusCode: 401 })
    } finally {
      logs.mockRestore()
      await f.close()
    }
  })

  test("settlement preserves both records on store failure and safely retries a lost response", async () => {
    const f = await fixture()
    try {
      const minted = await f.mint()
      f.policy.onStore = async (command) => {
        if (command[0] === "EVAL" && command[2] === "6") throw new Error("before atomic execution")
      }
      expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(503)
      expect(await liveRun(f.account, minted.body.runId)).toBeDefined()
      expect((await listCloudRuns(f.account))[0]?.endedAt).toBeUndefined()
      f.policy.onStore = async (command) => {
        if (command[0] !== "EVAL" || command[2] !== "6") return
        f.policy.onStore = undefined
        await persistentStore(command)
        throw new Error("response lost after atomic execution")
      }
      expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(503)
      expect(await liveRun(f.account, minted.body.runId)).toBeUndefined()
      expect((await f.send("settle", minted.body.token, { outcome: "failed" })).status).toBe(200)
      expect((await listCloudRuns(f.account))[0]?.outcome).toBe("changes")
    } finally {
      await f.close()
    }
  })

  test("settlement receipts reject forged, stale, revoked, expired and changed-generation tokens", async () => {
    const f = await fixture()
    try {
      const first = await f.mint()
      const second = await f.mint()
      expect((await f.send("settle", first.body.token, { outcome: "failed" })).status).toBe(401)
      expect((await f.send("settle", second.body.token, { outcome: "changes" })).status).toBe(200)
      const claims = readRunToken(second.body.token, f.policy.now)
      const forged = `${second.body.token.slice(0, -1)}!`
      expect((await f.send("settle", forged, { outcome: "failed" })).status).toBe(401)
      const { v, exp, ...mintable } = claims
      const stale = mintRunToken({ ...mintable, jti: "Z".repeat(22) })
      expect((await f.send("settle", stale.token, { outcome: "failed" })).status).toBe(401)
      f.policy.before = claims.iat + 1
      expect((await f.send("settle", second.body.token, { outcome: "failed" })).status).toBe(401)
      f.policy.before = undefined
      f.policy.now = exp
      expect((await f.send("settle", second.body.token, { outcome: "failed" })).status).toBe(401)
      f.policy.now = claims.iat
      await f.bind()
      expect((await f.send("settle", second.body.token, { outcome: "failed" })).status).toBe(401)
      await f.revoke()
      expect((await f.send("settle", second.body.token, { outcome: "failed" })).status).toBe(401)
    } finally {
      await f.close()
    }
  })

  test("heartbeat stops three minutes before deadline and remains available until exp", async () => {
    const f = await fixture()
    try {
      const minted = await f.mint()
      f.policy.now = minted.body.deadline - 180_001
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).body.stop).toBe(false)
      f.policy.now++
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).body.stop).toBe(true)
      f.policy.now = minted.body.deadline + 1
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).body.stop).toBe(true)
      f.policy.now = minted.body.deadline + 900_000
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).status).toBe(401)
    } finally {
      await f.close()
    }
  })

  test("all allowance reasons use neutral responses and never expose billing state", async () => {
    const f = await fixture()
    try {
      const reasons = [
        "none",
        "payment",
        "dispute",
        "fraud",
        "closing",
        "not-in-plan",
        "service-off",
        "source-unavailable",
      ] as const
      const answers: unknown[] = []
      for (const reason of reasons) {
        f.policy.allowance = { active: false, reason }
        const answer = await f.mint()
        expect(answer.status).toBe(reason === "service-off" ? 503 : 403)
        expect(answer.body.error.code).toBe(
          reason === "service-off"
            ? "MODEL_PLANS_DISABLED"
            : reason === "source-unavailable"
              ? "CLOUD_AGENTS_SOURCE_UNAVAILABLE"
              : "BINDING_UNAVAILABLE",
        )
        if (!["service-off", "source-unavailable"].includes(reason)) answers.push(answer.body)
      }
      expect(answers.every((value) => JSON.stringify(value) === JSON.stringify(answers[0]))).toBe(true)
    } finally {
      await f.close()
    }
  })

  test("strict mint fields, old workflow, runner and account credentials are refused", async () => {
    const f = await fixture()
    try {
      for (const body of [
        { thread: undefined },
        { thread: "bad:thread" },
        { purpose: "scheduled" },
        { workflowVersion: 3 },
        { account: f.account },
        { commentId: -1 },
        { pullRequest: "17" },
      ])
        expect((await f.mint(body)).status).toBe(400)
      expect((await f.mint({ workflowVersion: "2" })).body.error.code).toBe("WORKFLOW_UPDATE_REQUIRED")
      expect((await f.mint({}, { runner_environment: "self-hosted" })).body.error.code).toBe("RUNNER_NOT_SUPPORTED")
      const cli = mintCliToken({ id: f.account, email: "fixture@example.invalid" }, f.policy.now, "desktop").token
      expect((await f.send("mint", cli, { purpose: "task", thread: "17", workflowVersion: "3" })).body.error.code).toBe(
        "OIDC_INVALID",
      )
      expect((await f.send("mint", await f.github.makeToken("mint"), {}, "?account=x")).status).toBe(400)
    } finally {
      await f.close()
    }
  })

  test("bots and tickets fail closed with or without an installed App until V13", async () => {
    const f = await fixture()
    try {
      for (const installed of [true, false]) {
        f.github.state.installed = installed
        for (const actor of ["github-actions[bot]", "dependabot[bot]", "vector-fixture[bot]"])
          expect((await f.mint({}, { event_name: "workflow_dispatch", actor })).body.error.code).toBe(
            "ACTOR_NOT_ALLOWED",
          )
      }
      expect((await f.mint({ ticket: "not-issued" })).body.error.code).toBe("ACTOR_NOT_ALLOWED")
    } finally {
      await f.close()
    }
  })

  test("non-default ref, transferred owner, missing binding and revocation are refused", async () => {
    const f = await fixture()
    try {
      expect(
        (
          await f.mint(
            {},
            {
              ref: "refs/heads/feature",
              workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/heads/feature",
              sub: "repo:fixture-owner/project:ref:refs/heads/feature",
            },
          )
        ).body.error.code,
      ).toBe("WORKFLOW_NOT_TRUSTED")
      expect((await f.mint({}, { repository_owner_id: "999" })).body.error.code).toBe("BINDING_SUSPENDED")
      expect((await bindingFor(f.github.repositoryId))?.suspended).toBe("transferred")
      await f.bind()
      await f.revoke()
      expect((await f.mint()).body.error.code).toBe("REPO_NOT_BOUND")
      expect((await f.mint({}, { repository_id: "999" })).body.error.code).toBe("REPO_NOT_BOUND")
    } finally {
      await f.close()
    }
  })

  test("App authorization is fresh and binder-left suspends the binding", async () => {
    const f = await fixture()
    try {
      f.github.state.permission = "read"
      expect((await f.mint()).body.error.code).toBe("ACTOR_NOT_ALLOWED")
      f.github.state.permission = "write"
      f.github.state.comment.body = "task removed"
      expect((await f.mint()).body.error.code).toBe("COMMENT_CHANGED")
      f.github.state.comment.body = "/vector fix it"
      f.github.state.binderPermission = "read"
      expect((await f.mint()).body.error.code).toBe("BINDING_SUSPENDED")
      expect((await bindingFor(f.github.repositoryId))?.suspended).toBe("binder-left")
    } finally {
      await f.close()
    }
  })

  test("review comments without the App require a conversation comment", async () => {
    const f = await fixture()
    try {
      f.github.state.enabled = false
      expect(
        (
          await f.mint(
            { pullRequest: 17 },
            {
              event_name: "pull_request_review_comment",
              sub: "repo:fixture-owner/project:pull_request",
              ref: "refs/pull/17/merge",
              workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/pull/17/merge",
              head_ref: "fix",
              base_ref: "main",
            },
          )
        ).body.error.code,
      ).toBe("EVENT_NEEDS_APP")
    } finally {
      await f.close()
    }
  })

  test("hours and at-once limits are neutral and OIDC proofs are single-use", async () => {
    const f = await fixture()
    try {
      f.github.state.enabled = false
      if (!f.policy.allowance.active) throw new Error("fixture allowance")
      f.policy.allowance.allowanceSeconds = 299
      expect((await f.mint()).body.error).toMatchObject({ code: "MODEL_PLAN_RUN_LIMIT", limit: "hours" })
      f.policy.allowance.allowanceSeconds = 144_000
      f.policy.allowance.limits.atOnce = 1
      const proof = await f.github.makeToken("mint")
      const body = { purpose: "task", thread: "17", workflowVersion: "3" }
      expect((await f.send("mint", proof, body)).status).toBe(200)
      expect((await f.send("mint", proof, body)).body.error.code).toBe("OIDC_REPLAYED")
      expect((await f.mint({}, { check_run_id: "1002" })).body.error).toMatchObject({
        code: "MODEL_PLAN_RUN_LIMIT",
        limit: "at-once",
      })
    } finally {
      await f.close()
    }
  })

  test("Plus schedules are refused; Max's sixth schedule is refused and resets at UTC midnight", async () => {
    const f = await fixture()
    try {
      f.github.state.enabled = false
      if (!f.policy.allowance.active) throw new Error("fixture allowance")
      f.policy.allowance.limits.scheduledPerDay = 0
      const body = { thread: "schedule-0a1b2c3d" }
      expect((await f.mint(body, { event_name: "schedule" })).body.error).toMatchObject({
        code: "CODIUM_PERK_REQUIRED",
        perk: "scheduled",
      })
      f.policy.allowance.limits.scheduledPerDay = 5
      for (let index = 0; index < 5; index++) {
        const minted = await f.mint(body, { event_name: "schedule", check_run_id: String(1001 + index) })
        expect(minted.status).toBe(200)
        expect(readRunToken(minted.body.token, f.policy.now)).toMatchObject({
          src: "github-schedule",
          pur: "scheduled",
        })
        expect((await f.send("settle", minted.body.token, { outcome: "no-changes" })).status).toBe(200)
      }
      expect((await f.mint(body, { event_name: "schedule", check_run_id: "1006" })).body.error).toMatchObject({
        code: "MODEL_PLAN_RUN_LIMIT",
        limit: "scheduled",
      })
      f.policy.now = Math.floor(f.policy.now / 86_400_000) * 86_400_000 + 86_400_000
      expect((await f.mint(body, { event_name: "schedule", check_run_id: "1007" })).status).toBe(200)
    } finally {
      await f.close()
    }
  })

  test("delayed reservation cannot recreate erased account data or use a changed binding", async () => {
    const f = await fixture()
    try {
      f.policy.beforeCall = async () => {
        await f.revoke()
        await eraseCloudAgentsAccount(f.account)
      }
      expect((await f.mint()).body.error.code).toBe("REPO_NOT_BOUND")
      expect(await persistentStore(["EXISTS", liveKey(f.account)])).toBe(0)
      expect(await persistentStore(["EXISTS", usedKey(f.account, "p1793491200000")])).toBe(0)
    } finally {
      await f.close()
    }
    const g = await fixture()
    try {
      g.policy.beforeCall = async () => {
        await g.bind(crypto.randomUUID())
      }
      expect((await g.mint()).body.error.code).toBe("BINDING_SUSPENDED")
      expect(await persistentStore(["EXISTS", liveKey(g.account)])).toBe(0)
    } finally {
      await g.close()
    }
  })

  test("atomic settlement refuses revocation and generation changes after verification", async () => {
    for (const change of ["revoke", "rebind"] as const) {
      const f = await fixture()
      try {
        const minted = await f.mint()
        f.policy.onStore = async (command) => {
          if (command[0] !== "EVAL" || command[2] !== "6") return
          f.policy.onStore = undefined
          if (change === "revoke") await f.revoke()
          else await f.bind()
        }
        expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(401)
        expect(await liveRun(f.account, minted.body.runId)).toBeDefined()
        expect((await listCloudRuns(f.account))[0]?.endedAt).toBeUndefined()
      } finally {
        await f.close()
      }
    }
  })

  test("an account revocation alone invalidates an otherwise matching ended receipt", async () => {
    const f = await fixture()
    try {
      const minted = await f.mint()
      expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(200)
      await f.revoke()
      expect((await f.send("settle", minted.body.token, { outcome: "failed" })).status).toBe(401)
      expect((await listCloudRuns(f.account))[0]?.outcome).toBe("changes")
    } finally {
      await f.close()
    }
  })

  test("App upstream failures and disallowed events never reach reservation", async () => {
    const f = await fixture()
    try {
      f.github.state.failPath = "/repos/fixture-owner/project/installation"
      expect((await f.mint()).body.error.code).toBe("GITHUB_UNAVAILABLE")
      f.github.state.failPath = ""
      expect((await f.mint({}, { event_name: "push" })).body.error.code).toBe("EVENT_NOT_ALLOWED")
      expect((await f.send("mint", "forged", {})).body.error.code).toBe("OIDC_INVALID")
      expect(await persistentStore(["EXISTS", liveKey(f.account)])).toBe(0)
    } finally {
      await f.close()
    }
  })

  test("a fresh reservation is released when signing fails", async () => {
    const f = await fixture()
    const secret = process.env.VECTOR_RUN_TOKEN_SECRET
    const license = process.env.VECTOR_LICENSE_SECRET
    try {
      delete process.env.VECTOR_RUN_TOKEN_SECRET
      delete process.env.VECTOR_LICENSE_SECRET
      expect((await f.mint()).body.error.code).toBe("RUN_TOKENS_UNAVAILABLE")
      expect(await persistentStore(["EXISTS", liveKey(f.account)])).toBe(0)
      expect(await persistentStore(["GET", usedKey(f.account, "p1793491200000")])).toBe("0")
    } finally {
      if (secret !== undefined) process.env.VECTOR_RUN_TOKEN_SECRET = secret
      if (license !== undefined) process.env.VECTOR_LICENSE_SECRET = license
      await f.close()
    }
  })

  test("mint, heartbeat and settle enforce their persistent rate limits", async () => {
    const f = await fixture()
    try {
      f.github.state.enabled = false
      let minted = await f.mint()
      for (let index = 1; index < 30; index++) {
        minted = await f.mint()
        expect(minted.status).toBe(200)
      }
      const limited = await f.mint()
      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe("RATE_LIMITED")
      expect(limited.retryAfter).toBeTruthy()
      for (let index = 0; index < 90; index++)
        expect((await f.send("heartbeat", minted.body.token, { state: "running" })).status).toBe(200)
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).status).toBe(429)
      for (let index = 0; index < 10; index++)
        expect((await f.send("settle", minted.body.token, { outcome: "no-changes" })).status).toBe(200)
      expect((await f.send("settle", minted.body.token, { outcome: "no-changes" })).status).toBe(429)
    } finally {
      await f.close()
    }
  })

  test("store outage fails closed and returns no token", async () => {
    const f = await fixture()
    try {
      state.down = true
      const answer = await f.mint()
      expect(answer.status).toBe(503)
      expect(answer.body.error.code).toBe("PERSISTENT_STORE_UNAVAILABLE")
      expect(answer.body.token).toBeUndefined()
    } finally {
      state.down = false
      await f.close()
    }
  })
}
