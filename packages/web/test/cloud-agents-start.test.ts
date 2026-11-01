import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { bindingFor, createBindCode, redeemAndBind } from "../../../api/_lib/cloud-agents-binding"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { liveKey, liveRun } from "../../../api/_lib/cloud-agents-ledger"
import { readRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { eraseCloudAgentsAccount, listCloudRuns } from "../../../api/_lib/cloud-agents-runs"
import { peekRunTicket, startCloudRun } from "../../../api/_lib/cloud-agents-start"
import type { RunTrigger } from "../../../api/_lib/cloud-agents-entitlement"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("Cloud ticket tests require disposable loopback VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Ticket tests require loopback Redis")
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
    github.state.run.event = "workflow_dispatch"
    const bot = { id: github.state.botId, login: `${github.config.slug}[bot]`, type: "Bot" }
    github.state.run.actor = bot
    github.state.run.triggering_actor = bot
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
    async function bind(owner = account, installationId: string | undefined = "600") {
      const code = await createBindCode({ account: owner, repository: identity.repository, now: policy.now })
      return redeemAndBind({
        code: code.code,
        account: owner,
        current: (await bindingFor(github.repositoryId))?.account,
        identity,
        workflowVersion: "3",
        ...(installationId === "" ? {} : { installationId }),
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
      return send(
        "mint",
        await github.makeToken("mint", {
          event_name: "workflow_dispatch",
          actor: bot.login,
          actor_id: String(bot.id),
          ...claims,
        }),
        {
          purpose: "task",
          thread: "dispatch-1000",
          workflowVersion: "3",
          commentId: 123,
          ...body,
        },
      )
    }
    async function revoke() {
      await persistentStore(["SET", `vector:cli-revoked:${account}`, "1"])
    }
    const trigger: RunTrigger = {
      account,
      source: "ops",
      purpose: "incident",
      target: { kind: "github-run", repositoryId: Number(github.repositoryId) },
      prompt: "Untrusted production log: fixture-only",
    }
    const deps = {
      app: github.app,
      now: () => policy.now,
      fetcher,
      store: async (command: readonly (string | number)[]) => {
        await policy.onStore?.(command)
        return persistentStore(command)
      },
      entitlement: async () => {
        await policy.beforeCall?.()
        return policy.allowance
      },
    }
    async function start(change: Partial<RunTrigger> = {}) {
      return startCloudRun({ ...trigger, ...change }, deps)
    }
    async function botIdentity(change: Record<string, unknown> = {}) {
      return github.verify(
        await github.makeToken("mint", {
          event_name: "workflow_dispatch",
          actor: bot.login,
          actor_id: String(bot.id),
          ...change,
        }),
        "mint",
      )
    }
    function ticket() {
      const value = github.state.dispatches.at(-1)?.inputs.ticket
      if (!value) throw new Error("Fixture has no ticket")
      return value
    }
    return {
      trigger,
      deps,
      start,
      botIdentity,
      ticket,
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

  test("start rejects missing binding, another binder, unavailable App/source/purpose and every allowance reason", async () => {
    const f = await fixture()
    try {
      expect(await f.start({ target: { kind: "github-run", repositoryId: 999 } })).toEqual({
        ok: false,
        reason: "not-bound",
      })
      expect(await f.start({ account: crypto.randomUUID() })).toEqual({ ok: false, reason: "not-binder" })
      expect(await f.start({ source: "slack" })).toEqual({ ok: false, reason: "source-unavailable" })
      expect(await f.start({ purpose: "scheduled" })).toEqual({ ok: false, reason: "purpose-unavailable" })
      f.github.state.enabled = false
      expect(await f.start()).toEqual({ ok: false, reason: "app-required" })
      f.github.state.enabled = true
      for (const reason of [
        "none",
        "payment",
        "dispute",
        "fraud",
        "closing",
        "service-off",
        "source-unavailable",
        "not-in-plan",
      ] as const) {
        f.policy.allowance = { active: false, reason }
        expect(await f.start()).toEqual({ ok: false, reason })
      }
      expect(f.github.state.dispatches).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  test("dispatch uses exactly Actions write plus metadata read, revokes its token, and stores only the ticket inventory", async () => {
    const f = await fixture()
    try {
      const before = new Set((await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])) as string[])
      expect(await f.start()).toEqual({ ok: true, dispatchedAt: f.policy.now })
      expect(f.github.state.dispatches).toEqual([
        { ref: "refs/heads/main", inputs: { mode: "task", prompt: f.trigger.prompt, ticket: f.ticket() } },
      ])
      expect(f.github.state.minted[0]?.body).toEqual({
        repository_ids: [Number(f.github.repositoryId)],
        permissions: { actions: "write", metadata: "read" },
      })
      expect(f.github.state.events.at(-1)).toBe("revoke:dispatch")
      expect(f.github.tokens.size).toBe(0)
      const created = ((await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])) as string[]).filter(
        (key) => !before.has(key),
      )
      expect(created).toHaveLength(1)
      expect(created[0]).toMatch(/^vector:cloud-agents:ticket:[0-9a-f]{64}$/)
      const raw = await persistentStore(["GET", created[0]!])
      expect(JSON.parse(String(raw))).toEqual({
        repositoryId: f.github.repositoryId,
        account: f.account,
        generation: f.binding.generation,
        source: "ops",
        purpose: "incident",
        exp: f.policy.now + 900_000,
      })
      expect(String(raw)).not.toContain(f.ticket())
      expect(String(raw)).not.toContain(f.trigger.prompt)
      expect(Number(await persistentStore(["TTL", created[0]!]))).toBeGreaterThan(895)
      expect(Number(await persistentStore(["TTL", created[0]!]))).toBeLessThanOrEqual(900)
    } finally {
      await f.close()
    }
  })

  test("rename resolves by id, while transfer refuses to send the previous binder's prompt", async () => {
    const f = await fixture()
    try {
      f.github.state.repository.full_name = "fixture-owner/renamed"
      expect((await f.start()).ok).toBe(true)
      expect(f.github.state.requests).toContain("/app/installations/600")
      expect(f.github.state.requests).toContain("/installation/repositories")
      expect(f.github.state.requests.some((path) => path.startsWith("/repositories/"))).toBe(false)
      expect(f.github.state.requests).toContain("/repos/fixture-owner/renamed/actions/workflows/vector.yml/dispatches")
      f.github.state.repository.owner = { ...f.github.state.repository.owner, id: 999 }
      expect(await f.start()).toEqual({ ok: false, reason: "dispatch-failed" })
      expect(f.github.state.dispatches).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  test("dispatch failure and missing installation remove tickets; credential scope errors still revoke", async () => {
    const f = await fixture()
    try {
      f.github.state.dispatchStatus = 503
      expect(await f.start()).toEqual({ ok: false, reason: "dispatch-failed" })
      expect(await peekRunTicket(f.ticket(), await f.botIdentity(), f.binding, f.deps)).toBeUndefined()
      expect(f.github.tokens.size).toBe(0)
      f.github.state.dispatchStatus = 204
      f.github.state.installed = false
      expect(await f.start()).toEqual({ ok: false, reason: "app-required" })
      f.github.state.installed = true
      f.github.state.mintMode = "extra-permission"
      expect(await f.start()).toEqual({ ok: false, reason: "dispatch-failed" })
      expect(f.github.tokens.size).toBe(0)
    } finally {
      await f.close()
    }
  })

  test("tickets require exact repository, account, generation, bot and expiry", async () => {
    const f = await fixture()
    try {
      await f.start()
      const identity = await f.botIdentity()
      expect(await peekRunTicket(f.ticket(), identity, f.binding, f.deps)).toMatchObject({
        account: f.account,
        source: "ops",
        purpose: "incident",
      })
      for (const binding of [
        { ...f.binding, account: crypto.randomUUID() },
        { ...f.binding, repositoryId: "999" },
        { ...f.binding, generation: 2 },
      ])
        expect(await peekRunTicket(f.ticket(), identity, binding, f.deps)).toBeUndefined()
      expect(
        await peekRunTicket(f.ticket(), await f.botIdentity({ actor: "dependabot[bot]" }), f.binding, f.deps),
      ).toBeUndefined()
      expect(await peekRunTicket("bad", identity, f.binding, f.deps)).toBeUndefined()
      f.policy.now += 900_000
      expect(await peekRunTicket(f.ticket(), identity, f.binding, f.deps)).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  test("one ticket admits exactly one of two check runs that both peeked it", async () => {
    const f = await fixture()
    try {
      await f.start()
      f.github.state.extraJobs.push({
        ...f.github.state.job,
        id: 2001,
        check_run_url: "https://api.github.com/repos/fixture-owner/project/check-runs/1002",
      })
      const held: Array<() => void> = []
      f.policy.onStore = async (command) => {
        if (!reserveCommand(command)) return
        await new Promise<void>((resolve) => {
          held.push(resolve)
          if (held.length === 2) held.forEach((release) => release())
        })
      }
      const answers = await Promise.all(
        ["1001", "1002"].map((check_run_id) => f.mint({ ticket: f.ticket() }, { check_run_id })),
      )
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403])
      expect(await peekRunTicket(f.ticket(), await f.botIdentity(), f.binding, f.deps)).toBeUndefined()
      expect(await persistentStore(["HLEN", liveKey(f.account)])).toBe(1)
    } finally {
      await f.close()
    }
  })

  test("ticket-purpose mapping and trigger provenance survive mint, live storage and history", async () => {
    for (const purpose of ["task", "review", "incident", "changes"] as const) {
      const f = await fixture()
      try {
        expect((await f.start({ purpose })).ok).toBe(true)
        const minted = await f.mint({ ticket: f.ticket() })
        expect(minted.status).toBe(200)
        expect(readRunToken(minted.body.token, f.policy.now)).toMatchObject({
          src: "github-dispatch",
          pur: purpose === "review" ? "review" : "task",
        })
        expect(await liveRun(f.account, minted.body.runId)).toMatchObject({
          triggerSource: "ops",
          triggerPurpose: purpose,
        })
        expect((await listCloudRuns(f.account))[0]?.trigger).toEqual({ source: "ops", purpose })
        const live = JSON.parse(String(await persistentStore(["HGET", liveKey(f.account), minted.body.runId])))
        expect(Object.keys(live).sort()).toEqual(
          [
            "startedAt",
            "deadline",
            "lastReport",
            "epoch",
            "repo",
            "thr",
            "src",
            "pur",
            "gen",
            "jti",
            "triggerSource",
            "triggerPurpose",
          ].sort(),
        )
        expect(
          ((await persistentStore(["HKEYS", `vector:cloud-agents:run:${minted.body.runId}`])) as string[]).sort(),
        ).toEqual(
          [
            "rid",
            "account",
            "repository",
            "repositoryId",
            "runUrl",
            "event",
            "source",
            "purpose",
            "startedAt",
            "generation",
            "jti",
            "triggerSource",
            "triggerPurpose",
          ].sort(),
        )
      } finally {
        await f.close()
      }
    }
  })

  test("at-once refusal preserves the ticket for retry after another run settles", async () => {
    const f = await fixture()
    try {
      if (!f.policy.allowance.active) throw new Error("fixture allowance")
      f.policy.allowance.limits.atOnce = 1
      await f.start()
      const first = await f.mint({ ticket: f.ticket() })
      expect(first.status).toBe(200)
      await f.start()
      const ticket = f.ticket()
      f.github.state.extraJobs.push({
        ...f.github.state.job,
        id: 2001,
        check_run_url: "https://api.github.com/repos/fixture-owner/project/check-runs/1002",
      })
      expect((await f.mint({ ticket }, { check_run_id: "1002" })).body.error).toMatchObject({
        code: "MODEL_PLAN_RUN_LIMIT",
        limit: "at-once",
      })
      expect(await peekRunTicket(ticket, await f.botIdentity(), f.binding, f.deps)).toBeDefined()
      expect((await f.send("settle", first.body.token, { outcome: "changes" })).status).toBe(200)
      expect((await f.mint({ ticket }, { check_run_id: "1002" })).status).toBe(200)
    } finally {
      await f.close()
    }
  })

  test("a consumed ticket permits exact check-run renewal, never an unrelated or human run", async () => {
    const f = await fixture()
    try {
      expect((await f.mint()).status).toBe(403)
      await f.start()
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      const second = await f.mint()
      expect(second.status).toBe(200)
      expect(second.body.deadline).toBe(minted.body.deadline)
      expect((await f.send("settle", minted.body.token, { outcome: "failed" })).status).toBe(401)
      expect((await f.mint({}, { check_run_id: "999" })).status).toBe(403)
      expect((await f.mint({}, { actor_id: "789" })).body.error.code).toBe("ACTOR_NOT_ALLOWED")
      expect((await f.send("settle", second.body.token, { outcome: "changes" })).status).toBe(200)
      expect((await f.mint()).status).toBe(403)
    } finally {
      await f.close()
    }
  })

  test("lost reservation response retains atomic provenance so the same bot check run can recover", async () => {
    const f = await fixture()
    try {
      await f.start()
      f.policy.onStore = async (command) => {
        if (!reserveCommand(command)) return
        f.policy.onStore = undefined
        await persistentStore(command)
        throw new Error("lost reply after admission")
      }
      expect((await f.mint({ ticket: f.ticket() })).status).toBe(503)
      expect(await peekRunTicket(f.ticket(), await f.botIdentity(), f.binding, f.deps)).toBeUndefined()
      expect(await listCloudRuns(f.account)).toEqual([])
      const recovered = await f.mint()
      expect(recovered.status).toBe(200)
      expect((await listCloudRuns(f.account))[0]?.trigger).toEqual({ source: "ops", purpose: "incident" })
    } finally {
      await f.close()
    }
  })

  test("parallel bot renewals compare the observed JTI and keep the winner's authority", async () => {
    const f = await fixture()
    try {
      await f.start()
      const first = await f.mint({ ticket: f.ticket() })
      const held: Array<() => void> = []
      f.policy.onStore = async (command) => {
        if (!reserveCommand(command)) return
        await new Promise<void>((resolve) => {
          held.push(resolve)
          if (held.length === 2) held.forEach((release) => release())
        })
      }
      const answers = await Promise.all([f.mint(), f.mint()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403])
      const winner = answers.find((answer) => answer.status === 200)!
      expect((await f.send("settle", first.body.token, { outcome: "failed" })).status).toBe(401)
      expect((await f.send("heartbeat", winner.body.token, { state: "running" })).status).toBe(200)
      expect((await f.send("settle", winner.body.token, { outcome: "changes" })).status).toBe(200)
    } finally {
      await f.close()
    }
  })

  test("stale renewal cannot recreate authority after settle, rebind or erasure", async () => {
    for (const change of ["settle", "rebind", "erase"] as const) {
      const f = await fixture()
      try {
        await f.start()
        const first = await f.mint({ ticket: f.ticket() })
        expect(first.status).toBe(200)
        f.policy.onStore = async (command) => {
          if (!reserveCommand(command)) return
          f.policy.onStore = undefined
          if (change === "settle")
            expect((await f.send("settle", first.body.token, { outcome: "changes" })).status).toBe(200)
          if (change === "rebind") await f.bind()
          if (change === "erase") {
            await f.revoke()
            await eraseCloudAgentsAccount(f.account)
          }
        }
        const answer = await f.mint()
        expect(answer.status).toBe(change === "settle" ? 403 : change === "rebind" ? 409 : 404)
        if (change !== "rebind") expect(await liveRun(f.account, first.body.runId)).toBeUndefined()
      } finally {
        await f.close()
      }
    }
  })

  test("rebind invalidates a ticket and delayed ticket creation is fenced by rebind or erasure", async () => {
    const f = await fixture()
    try {
      await f.start()
      await f.bind()
      expect((await f.mint({ ticket: f.ticket() })).status).toBe(403)
      f.policy.beforeCall = async () => {
        await f.bind()
      }
      expect(await f.start()).toEqual({ ok: false, reason: "not-bound" })
      f.policy.beforeCall = async () => {
        await f.revoke()
        await eraseCloudAgentsAccount(f.account)
      }
      expect(await f.start()).toEqual({ ok: false, reason: "not-bound" })
      expect(f.github.state.dispatches).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  test("erasure deletes tickets written by startCloudRun while preserving another account's ticket", async () => {
    const f = await fixture()
    const g = await fixture()
    try {
      await f.start()
      await g.start()
      const old = await peekRunTicket(f.ticket(), await f.botIdentity(), f.binding, f.deps)
      const other = await peekRunTicket(g.ticket(), await g.botIdentity(), g.binding, g.deps)
      expect(old).toBeDefined()
      expect(other).toBeDefined()
      await f.revoke()
      await eraseCloudAgentsAccount(f.account)
      expect(await persistentStore(["GET", old!.key])).toBeNull()
      expect(await persistentStore(["GET", other!.key])).toBeString()
    } finally {
      await f.close()
      await g.close()
    }
  })

  test("expiry between ticket peek and reservation refuses admission", async () => {
    const f = await fixture()
    try {
      await f.start()
      const ticket = f.ticket()
      f.policy.beforeCall = async () => {
        f.policy.now += 900_000
      }
      expect((await f.mint({ ticket })).body.error.code).toBe("ACTOR_NOT_ALLOWED")
      expect(await persistentStore(["EXISTS", liveKey(f.account)])).toBe(0)
    } finally {
      await f.close()
    }
  })

  test("a bot cannot renew a human run that has no stored ticket provenance", async () => {
    const f = await fixture()
    try {
      const bot = f.github.state.run.actor
      const human = { id: 789, login: "fixture-person", type: "User" }
      f.github.state.run.actor = human
      f.github.state.run.triggering_actor = human
      const minted = await f.mint({}, { actor: human.login, actor_id: "789" })
      expect(minted.status).toBe(200)
      f.github.state.run.actor = bot
      f.github.state.run.triggering_actor = bot
      expect((await f.mint()).body.error.code).toBe("ACTOR_NOT_ALLOWED")
      expect((await liveRun(f.account, minted.body.runId))?.jti).toBe(readRunToken(minted.body.token, f.policy.now).jti)
      expect((await listCloudRuns(f.account))[0]?.trigger).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  test("legacy bindings without installation identity require rebind before any ticket or dispatch", async () => {
    const f = await fixture()
    try {
      await f.bind(f.account, "")
      expect((await bindingFor(f.github.repositoryId))?.installationId).toBeUndefined()
      const before = await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])
      expect(await f.start()).toEqual({ ok: false, reason: "app-required" })
      expect(await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])).toEqual(before)
      expect(f.github.state.requests).toEqual([])
      await f.bind()
      expect((await f.start()).ok).toBe(true)
      await persistentStore(["HSET", `vector:cloud-agents:binding:${f.github.repositoryId}`, "installationId", "1e3"])
      await expect(f.start()).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    } finally {
      await f.close()
    }
  })

  test("stateless installation credentials are accepted and a forbidden installation lookup sends no prompt", async () => {
    const f = await fixture()
    try {
      f.github.state.mintMode = "stateless"
      expect((await f.start()).ok).toBe(true)
      expect(f.github.state.minted[0]?.token).toContain(".")
      expect(f.github.tokens.size).toBe(0)
      f.github.state.failPath = "/app/installations/600"
      f.github.state.failStatus = 403
      expect(await f.start()).toEqual({ ok: false, reason: "dispatch-failed" })
      expect(f.github.state.dispatches).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  test("store failure cannot issue a ticket or dispatch", async () => {
    const f = await fixture()
    try {
      state.down = true
      await expect(f.start()).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      expect(f.github.state.dispatches).toHaveLength(0)
    } finally {
      state.down = false
      await f.close()
    }
  })
}

function reserveCommand(command: readonly (string | number)[]) {
  return (
    command[0] === "EVAL" &&
    String(command[3]).startsWith("vector:cloud-agents:live:") &&
    String(command[5]).startsWith("vector:cloud-agents:sched:")
  )
}
