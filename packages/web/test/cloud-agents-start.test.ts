import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { cloudBrainArtifactKey, cloudRunArtifactKey } from "../../../api/_lib/cloud-agents-artifact"
import { bindingFor, createBindCode, redeemAndBind, suspendBinding } from "../../../api/_lib/cloud-agents-binding"
import { bindBrainUpload, commitBrainUpload, prepareBrainUpload } from "../../../api/_lib/cloud-agents-brain"
import { createDesktopCloudAgentApi } from "../../../api/_lib/cloud-agents-desktop"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { liveKey, liveRun, runRecordKey } from "../../../api/_lib/cloud-agents-ledger"
import { readRunToken } from "../../../api/_lib/cloud-agents-run-token"
import {
  eraseCloudAgentsAccount,
  listCloudRuns,
  recordRunBrainContext,
  registerRunSettleListener,
  registerRunStartListener,
  type RunEnd,
} from "../../../api/_lib/cloud-agents-runs"
import {
  peekRunTicket,
  prepareCloudRun,
  startCloudRun,
  type CloudRunTrigger,
} from "../../../api/_lib/cloud-agents-start"
import type { RunTrigger } from "../../../api/_lib/cloud-agents-entitlement"
import { ApiError } from "../../../api/_lib/http"
import { opsRunStarter } from "../../../api/_lib/ops-incidents"
import "../../../api/_lib/ops-registration"
import { createOpsRunStarter } from "../../../api/_lib/ops-run-starter"
import { repoBindingsAvailable, repositoryBinding } from "../../../api/_lib/ops-settings"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { ACTIONS_JOB_PROMPT, createJobId } from "../../../packages/schema/src/everywhere"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

test("EV-28: only a linked ticket can carry its exact Actions job marker", async () => {
  const trigger: CloudRunTrigger = {
    source: "desktop",
    account: crypto.randomUUID(),
    target: { kind: "github-run", repositoryId: 301 },
    purpose: "task",
    prompt: "Review the release notes",
  }
  const jobId = createJobId()
  const marker = `${ACTIONS_JOB_PROMPT}${jobId}`
  let bindingReads = 0
  const store = async () => {
    bindingReads++
    return [[]]
  }

  for (const invalid of [
    { prompt: marker },
    { prompt: ` ${marker}\n` },
    { jobId, prompt: trigger.prompt },
    { jobId, prompt: `${ACTIONS_JOB_PROMPT}${createJobId()}` },
    { jobId, prompt: ` ${marker}` },
    { jobId, prompt: `${marker}\n` },
  ]) {
    await expect(prepareCloudRun({ ...trigger, ...invalid }, { store })).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    })
  }
  expect(bindingReads).toBe(0)

  await expect(prepareCloudRun(trigger, { store })).resolves.toEqual({ ok: false, reason: "not-bound" })
  await expect(prepareCloudRun({ ...trigger, jobId, prompt: marker }, { store })).resolves.toEqual({
    ok: false,
    reason: "not-bound",
  })
  expect(bindingReads).toBe(2)
})

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
  const state = { down: false, commands: 0 }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      expect(new URL(request.url).pathname).toBe("/")
      expect(request.headers.get("authorization")).toBe("Bearer mint-fixture-kv")
      const command = (await request.json()) as (string | number)[]
      state.commands += 1
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
    "MODEL_PLANS_ENABLED",
    "VECTOR_GITHUB_BRAIN_ENABLED",
    "VECTOR_ABUSE_SECRET",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_RUN_TOKEN_SECRET",
    "VECTOR_RUN_ARTIFACT_SECRET",
    "VECTOR_LICENSE_SECRET",
    "VECTOR_CLI_TOKEN_SECRET",
  ]
  // The desktop Brain routes take their switch and wrapping secret from this env; the ordinary artifact-key route reads
  // the same secret from process.env.
  const brainEnv = {
    VECTOR_GITHUB_BRAIN_ENABLED: "true",
    MODEL_PLANS_ENABLED: "true",
    VECTOR_RUN_ARTIFACT_SECRET: "cloud-start-artifact-fixture-secret-32-characters",
  }
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, {
      NODE_ENV: "production",
      MODEL_PLANS_ENABLED: "true",
      VECTOR_GITHUB_BRAIN_ENABLED: "true",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "mint-fixture-kv",
      VECTOR_RUN_TOKEN_SECRET: "cloud-mint-fixture-secret-32-characters",
      VECTOR_RUN_ARTIFACT_SECRET: brainEnv.VECTOR_RUN_ARTIFACT_SECRET,
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
      eligible: boolean
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
      eligible: true,
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
    const store = async (command: readonly (string | number)[]) => {
      await policy.onStore?.(command)
      return persistentStore(command)
    }
    const entitlement = async () => {
      await policy.beforeCall?.()
      return policy.allowance
    }
    const api = createCloudAgentsApi({
      app: github.app,
      verify: github.verify,
      fetcher,
      now: () => policy.now,
      store,
      entitlement,
      revokedBefore: async () => policy.before,
    })
    // The desktop API has no revokedBefore seam: its run reader and desktop revocation checks read the real store
    // through `fetcher`, which reaches this file's KV bridge.
    const desktop = createDesktopCloudAgentApi({
      store,
      fetcher,
      now: () => policy.now,
      env: brainEnv,
      app: github.app,
      eligible: async () => policy.eligible,
      limit: async () => {},
      prepare: (trigger, prepareDeps) => prepareCloudRun(trigger, { ...prepareDeps, entitlement }),
    })
    const handlers = {
      mint: api.mint,
      heartbeat: api.heartbeat,
      settle: api.settle,
      artifactKey: api.artifactKey,
      prepare: desktop.prepare,
      commit: desktop.commit,
      download: desktop.download,
      desktopRun: desktop.start,
    }
    const server = createServer((request, response) => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
      void handlers[route](request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    async function post(route: keyof typeof handlers, token: string, body: unknown, query = "") {
      const response = await fetch(`${origin}/${route}${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const answer = await response.json()
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      return { status: response.status, body: answer, retryAfter: response.headers.get("retry-after") }
    }
    // Brain answers carry random base64url, which the copy check below could match by chance; they use post().
    async function send(route: keyof typeof handlers, token: string, body: unknown, query = "") {
      const answer = await post(route, token, body, query)
      expect(JSON.stringify(answer.body)).not.toMatch(
        /"(?:reason|plan|account|email)"|billing|subscription|payment|dispute|fraud|closing|\$\d/i,
      )
      return answer
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
    const deps = { app: github.app, now: () => policy.now, fetcher, store, entitlement }
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
    function job(check_run_id: string) {
      github.state.extraJobs.push({
        ...github.state.job,
        id: 1000 + Number(check_run_id),
        check_run_url: `https://api.github.com/repos/fixture-owner/project/check-runs/${check_run_id}`,
      })
    }
    /** The desktop flow over HTTP: prepare, local encryption, commit and start, then the bot's ticket mint. */
    async function brainRun(check_run_id = "1001") {
      const content = Buffer.from(
        JSON.stringify({ format: "vector-brain-run", version: 1, note: "approved knowledge" }),
      )
      const sha256 = createHash("sha256").update(content).digest("hex")
      const token = mintCliToken({ id: account, email: "fixture@example.test" }, Date.now(), "desktop").token
      const prepared = await post("prepare", token, {
        repositoryId: github.repositoryId,
        sha256,
        bytes: content.length,
        includeBrain: true,
      })
      expect(prepared.status).toBe(200)
      const encrypted = seal(prepared.body, content)
      expect((await post("commit", token, { uploadId: prepared.body.uploadId, ...encrypted })).status).toBe(200)
      const started = await post("desktopRun", token, {
        repositoryId: github.repositoryId,
        prompt: "Maintain this repository",
        brain: { uploadId: prepared.body.uploadId, sha256 },
      })
      expect(started.body).toEqual({ ok: true, dispatchedAt: policy.now })
      expect(github.state.dispatches.at(-1)?.inputs.brain_upload).toBe(prepared.body.uploadId)
      const minted = await mint({ ticket: ticket() }, { check_run_id })
      expect(minted.status).toBe(200)
      return { content, sha256, prepared: prepared.body, encrypted, minted: minted.body }
    }
    return {
      trigger,
      deps,
      start,
      botIdentity,
      ticket,
      job,
      brainRun,
      github,
      account,
      binding,
      bind,
      policy,
      post,
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

  test("a prepared run sends nothing before its route commits, can cancel, and dispatches at most once", async () => {
    const f = await fixture()
    try {
      const lost = await prepareCloudRun(f.trigger, f.deps)
      expect(lost.ok).toBe(true)
      if (!lost.ok) throw new Error("Fixture could not prepare")
      expect(lost.ticketHash).toMatch(/^[0-9a-f]{64}$/)
      expect(f.github.state.dispatches).toEqual([])
      expect(await persistentStore(["EXISTS", `vector:cloud-agents:ticket:${lost.ticketHash}`])).toBe(1)
      expect(await lost.cancel()).toBe(true)
      expect(await lost.dispatch()).toEqual({ ok: false, reason: "not-bound" })
      expect(f.github.state.dispatches).toEqual([])
      expect(await persistentStore(["EXISTS", `vector:cloud-agents:ticket:${lost.ticketHash}`])).toBe(0)

      const won = await prepareCloudRun(f.trigger, f.deps)
      if (!won.ok) throw new Error("Fixture could not prepare")
      expect(f.github.state.dispatches).toEqual([])
      const results = await Promise.all([won.dispatch(), won.dispatch(), won.dispatch()])
      expect(results).toEqual([
        { ok: true, dispatchedAt: f.policy.now },
        { ok: true, dispatchedAt: f.policy.now },
        { ok: true, dispatchedAt: f.policy.now },
      ])
      expect(f.github.state.dispatches).toHaveLength(1)
      expect(await won.cancel()).toBe(false)
      expect(await persistentStore(["EXISTS", `vector:cloud-agents:ticket:${won.ticketHash}`])).toBe(1)
    } finally {
      await f.close()
    }
  })

  test("prepared dispatch rechecks expiry, revocation and allowance without sending an Actions request", async () => {
    for (const change of ["expired", "revoked", "allowance"] as const) {
      const f = await fixture()
      try {
        const prepared = await prepareCloudRun(f.trigger, f.deps)
        if (!prepared.ok) throw new Error("Fixture could not prepare")
        if (change === "expired") f.policy.now += 900_000
        if (change === "revoked") await f.revoke()
        if (change === "allowance") f.policy.allowance = { active: false, reason: "service-off" }
        expect(await prepared.dispatch()).toEqual({
          ok: false,
          reason: change === "allowance" ? "service-off" : "not-bound",
        })
        expect(f.github.state.dispatches).toEqual([])
        expect(await persistentStore(["EXISTS", `vector:cloud-agents:ticket:${prepared.ticketHash}`])).toBe(0)
      } finally {
        await f.close()
      }
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

  // WP A59: the binding reader and "Fix it" starter that api/_lib/ops-registration.ts registers for Codium's ops. Each
  // case sets VECTOR_GITHUB_BRAIN_ENABLED itself and puts back this file's value.
  test("ops reads the bound account through the registered reader, never a suspended one, and nothing while off", async () => {
    const f = await fixture()
    try {
      const starter = opsRunStarter()
      expect(repoBindingsAvailable()).toBe(true)
      expect(typeof starter).toBe("function")
      await import("../../../api/_lib/ops-registration")
      expect(opsRunStarter()).toBe(starter)
      expect(await repositoryBinding(Number(f.github.repositoryId))).toEqual({
        account: f.account,
        repository: "fixture-owner/project",
        installationId: 600,
      })
      delete process.env.VECTOR_GITHUB_BRAIN_ENABLED
      const before = state.commands
      expect(await repositoryBinding(Number(f.github.repositoryId))).toBeUndefined()
      expect(await starter!(f.trigger).catch((error) => error)).toMatchObject({
        statusCode: 503,
        code: "OPS_FIX_UNAVAILABLE",
      })
      expect(state.commands).toBe(before)
      process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
      await suspendBinding(f.binding, "transferred")
      expect(await repositoryBinding(Number(f.github.repositoryId))).toBeUndefined()
      expect(f.github.state.dispatches).toHaveLength(0)
    } finally {
      process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
      await f.close()
    }
  })

  test("the ops fix starter maps every refusal to fixed text and dispatches a started run exactly once", async () => {
    const f = await fixture()
    const refused = async (change: Partial<RunTrigger> = {}) => {
      const error = await createOpsRunStarter(f.deps)({ ...f.trigger, ...change }).catch((error) => error)
      expect(error).toBeInstanceOf(ApiError)
      expect(error.message).not.toMatch(/not-bound|not-binder|app-required|dispatch-failed|payment|dispute|fraud/)
      return [error.statusCode, error.code, error.message]
    }
    const notBound = [409, "OPS_REPO_NOT_BOUND", "Connect this repository to your Vector account first."]
    try {
      process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
      expect(await refused({ target: { kind: "github-run", repositoryId: 999 } })).toEqual(notBound)
      expect(await refused({ account: crypto.randomUUID() })).toEqual(notBound)
      f.github.state.enabled = false
      expect(await refused()).toEqual([
        503,
        "OPS_FIX_APP_REQUIRED",
        "Install Vector's GitHub App on this repository to start a fix run.",
      ])
      f.github.state.enabled = true
      const active = f.policy.allowance
      for (const reason of ["none", "payment", "dispute", "fraud", "closing", "service-off", "not-in-plan"] as const) {
        f.policy.allowance = { active: false, reason }
        expect(await refused()).toEqual([
          403,
          "OPS_FIX_NOT_ALLOWED",
          "Your Vector Codium plan does not allow a fix run right now.",
        ])
      }
      f.policy.allowance = active
      expect(f.github.state.dispatches).toHaveLength(0)
      f.github.state.dispatchStatus = 503
      expect(await refused()).toEqual([503, "OPS_FIX_UNAVAILABLE", "The fix run could not start. Try again shortly."])
      expect(f.github.state.dispatches).toHaveLength(1)
      f.github.state.dispatchStatus = 204
      expect(await createOpsRunStarter(f.deps)(f.trigger)).toEqual({})
      expect(f.github.state.dispatches).toHaveLength(2)
      expect(f.github.state.dispatches.at(-1)?.inputs.ticket).toMatch(/^vtk_/)
    } finally {
      process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
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
          ticketHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        })
        expect((await liveRun(f.account, minted.body.runId))?.ticketHash).toBe(
          createHash("sha256").update(f.ticket()).digest("hex"),
        )
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
            "ticketHash",
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
            "thread",
          ].sort(),
        )
      } finally {
        await f.close()
      }
    }
  })

  test("Brain key provenance records immutable approved metadata only for the exact live desktop ticket", async () => {
    const f = await fixture()
    try {
      expect((await f.start({ source: "desktop", purpose: "task" })).ok).toBe(true)
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      const claims = readRunToken(minted.body.token, f.policy.now)
      const live = await liveRun(f.account, minted.body.runId)
      if (!live?.ticketHash) throw new Error("Fixture has no live desktop ticket")
      const input = {
        account: f.account,
        repositoryId: claims.repo,
        generation: claims.gen,
        rid: claims.rid,
        jti: claims.jti,
        thread: claims.thr,
        ticketHash: live.ticketHash,
        sha256: "a".repeat(64),
        publicRepository: false,
        now: f.policy.now,
      }
      await recordRunBrainContext(input)
      await recordRunBrainContext(input)
      expect(
        await persistentStore(["HMGET", `vector:cloud-agents:run:${claims.rid}`, "brainSha", "brainPublic"]),
      ).toEqual([input.sha256, "0"])
      for (const changed of [
        { sha256: "b".repeat(64) },
        { publicRepository: true },
        { ticketHash: "c".repeat(64) },
        { jti: "x".repeat(22) },
      ])
        await expect(recordRunBrainContext({ ...input, ...changed })).rejects.toMatchObject({ statusCode: 503 })
      expect(JSON.stringify(await listCloudRuns(f.account))).not.toMatch(/brainSha|brainPublic|thread/)
      await f.revoke()
      await expect(recordRunBrainContext(input)).rejects.toMatchObject({ statusCode: 503 })
    } finally {
      await f.close()
    }
  })

  test("at-once refusal preserves the ticket for retry after another run settles", async () => {
    const f = await fixture()
    try {
      if (!f.policy.allowance.active) throw new Error("fixture allowance")
      f.policy.allowance = { ...f.policy.allowance, limits: { ...f.policy.allowance.limits, atOnce: 1 } }
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
      // KEYS order follows hash-table buckets and can change across a rehash; compare the key sets.
      const before = ((await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])) as string[]).sort()
      expect(await f.start()).toEqual({ ok: false, reason: "app-required" })
      expect(((await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])) as string[]).sort()).toEqual(before)
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

  async function expire(key: string) {
    await redis.send("PEXPIRE", [key, "1"])
    const until = Date.now() + 2_000
    while ((await redis.send("PTTL", [key])) !== -2) {
      if (Date.now() > until) throw new Error(`${key} did not expire`)
      await Bun.sleep(5)
    }
  }

  test("an owner-started Brain run downloads exactly its approved bytes and records only immutable metadata", async () => {
    const f = await fixture()
    try {
      const run = await f.brainRun()
      const download = () => f.post("download", run.minted.token, { uploadId: run.prepared.uploadId })
      const answer = await download()
      expect(answer.status).toBe(200)
      expect(Object.keys(answer.body).sort()).toEqual([
        "aad",
        "approvedAt",
        "artifactKey",
        "bytes",
        "ciphertext",
        "key",
        "nonce",
        "publicRepository",
        "sha256",
        "uploadId",
      ])
      expect(answer.body).toMatchObject({
        uploadId: run.prepared.uploadId,
        key: run.prepared.key,
        aad: run.prepared.aad,
        ...run.encrypted,
        sha256: run.sha256,
        bytes: run.content.length,
        publicRepository: true,
      })
      const opened = unseal(answer.body)
      expect(opened).toEqual(run.content)
      expect(createHash("sha256").update(opened).digest("hex")).toBe(run.sha256)
      const claims = { sub: f.account, repo: f.github.repositoryId, gen: f.binding.generation, thr: "dispatch-1000" }
      expect(answer.body.artifactKey).toEqual(
        cloudBrainArtifactKey(claims, { sha256: run.sha256, publicRepository: true }, brainEnv),
      )
      expect(answer.body.artifactKey.key).not.toBe(cloudRunArtifactKey(claims).key)
      const record = `vector:cloud-agents:run:${run.minted.runId}`
      expect(await redis.send("HMGET", [record, "brainSha", "brainPublic"])).toEqual([run.sha256, "1"])
      expect(await download()).toEqual(answer)
      expect(JSON.stringify(await listCloudRuns(f.account))).not.toMatch(/brainSha|brainPublic|ticketHash/)
    } finally {
      await f.close()
    }
  })

  test("a Brain run's key domain takes the repository's current visibility at its first download; a later change refuses", async () => {
    for (const startPublic of [true, false]) {
      const f = await fixture()
      try {
        f.github.state.repository.private = !startPublic
        const run = await f.brainRun()
        expect(run.prepared.publicRepository).toBe(startPublic)
        const record = `vector:cloud-agents:run:${run.minted.runId}`
        const download = () => f.post("download", run.minted.token, { uploadId: run.prepared.uploadId })
        // The repository changes visibility after the owner approved the upload and before the run reads it.
        f.github.state.repository.private = startPublic
        const first = await download()
        expect(first.status).toBe(200)
        expect(first.body.publicRepository).toBe(!startPublic)
        expect(first.body.artifactKey).toEqual(
          cloudBrainArtifactKey(
            { sub: f.account, repo: f.github.repositoryId, gen: f.binding.generation, thr: "dispatch-1000" },
            { sha256: run.sha256, publicRepository: !startPublic },
            brainEnv,
          ),
        )
        const recorded = [run.sha256, startPublic ? "0" : "1"]
        expect(await redis.send("HMGET", [record, "brainSha", "brainPublic"])).toEqual(recorded)
        // The first download fixed the key domain, so a later visibility change refuses every further download.
        f.github.state.repository.private = !startPublic
        const second = await download()
        expect({ status: second.status, key: second.body.key, artifactKey: second.body.artifactKey }).toEqual({
          status: 503,
          key: undefined,
          artifactKey: undefined,
        })
        expect(await redis.send("HMGET", [record, "brainSha", "brainPublic"])).toEqual(recorded)
      } finally {
        await f.close()
      }
    }
  })

  test("a Brain download needs the exact live desktop ticket, this repository's upload and a current allowance", async () => {
    const f = await fixture()
    try {
      if (!f.policy.allowance.active) throw new Error("fixture allowance")
      f.policy.allowance = { ...f.policy.allowance, limits: { ...f.policy.allowance.limits, atOnce: 5 } }
      const run = await f.brainRun()
      const live = await liveRun(f.account, run.minted.runId)
      if (!live?.ticketHash) throw new Error("Fixture has no live desktop ticket")
      // An ops ticket run, and a writer's own dispatch of the same workflow.
      expect((await f.start()).ok).toBe(true)
      f.job("1002")
      const ops = await f.mint({ ticket: f.ticket() }, { check_run_id: "1002" })
      expect(ops.status).toBe(200)
      f.job("1003")
      const bot = f.github.state.run.actor
      const human = { id: 789, login: "fixture-person", type: "User" }
      f.github.state.run.actor = human
      f.github.state.run.triggering_actor = human
      const writer = await f.mint({}, { actor: human.login, actor_id: "789", check_run_id: "1003" })
      f.github.state.run.actor = bot
      f.github.state.run.triggering_actor = bot
      expect(writer.status).toBe(200)
      // Uploads of the same account that this run must not read: one bound to another ticket, and one of another
      // bound repository that is bound to this run's own ticket.
      const deps = { store: persistentStore, env: brainEnv }
      async function upload(repositoryId: string, generation: number, ticketHash: string) {
        const prepared = await prepareBrainUpload(
          {
            account: f.account,
            repositoryId,
            generation,
            publicRepository: true,
            source: "desktop",
            includeBrain: true,
            sha256: run.sha256,
            bytes: run.content.length,
          },
          deps,
        )
        await commitBrainUpload(
          { account: f.account, uploadId: prepared.uploadId, ...seal(prepared, run.content) },
          deps,
        )
        await bindBrainUpload(
          { account: f.account, repositoryId, generation, uploadId: prepared.uploadId, sha256: run.sha256, ticketHash },
          deps,
        )
        return prepared.uploadId
      }
      const other = String(100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]!)
      await persistentStore(["HSET", `vector:cloud-agents:binding:${other}`, "account", f.account, "generation", "1"])
      await persistentStore(["SET", `vector:cloud-agents:gen:${other}`, "1"])
      const otherTicket = await upload(f.github.repositoryId, f.binding.generation, "c".repeat(64))
      const otherRepository = await upload(other, 1, live.ticketHash)
      const records = [run.minted.runId, ops.body.runId, writer.body.runId].map(
        (rid) => `vector:cloud-agents:run:${rid}`,
      )
      async function refused(token: string, uploadId: string, status: number) {
        const answer = await f.post("download", token, { uploadId })
        expect({ status: answer.status, key: answer.body.key, artifactKey: answer.body.artifactKey }).toEqual({
          status,
          key: undefined,
          artifactKey: undefined,
        })
        for (const record of records) expect(await redis.send("HGET", [record, "brainSha"])).toBeNull()
      }
      await refused(ops.body.token, run.prepared.uploadId, 503)
      await refused(writer.body.token, run.prepared.uploadId, 503)
      await refused(run.minted.token, otherTicket, 400)
      await refused(run.minted.token, otherRepository, 400)
      f.policy.eligible = false
      await refused(run.minted.token, run.prepared.uploadId, 503)
      f.policy.eligible = true
      // The same live run and upload with the allowance back: each refusal above came from the one thing it changed.
      expect((await f.post("download", run.minted.token, { uploadId: run.prepared.uploadId })).status).toBe(200)
      expect(await redis.send("HGET", [records[0]!, "brainSha"])).toBe(run.sha256)
    } finally {
      await f.close()
    }
  })

  test("a Brain download refuses a rebound, revoked, settled, expired or unreachable run and an expired upload", async () => {
    const expected = { rebind: 401, revoked: 401, settled: 401, deadline: 401, outage: 503, upload: 400 }
    for (const change of ["rebind", "revoked", "settled", "deadline", "outage", "upload"] as const) {
      const f = await fixture()
      try {
        const run = await f.brainRun()
        if (change === "rebind") await f.bind()
        if (change === "revoked") await f.revoke()
        if (change === "settled")
          expect((await f.send("settle", run.minted.token, { outcome: "no-changes" })).status).toBe(200)
        if (change === "deadline") f.policy.now = run.minted.deadline
        if (change === "outage") state.down = true
        // The upload's own two hours run out while the run token is still live.
        if (change === "upload") await expire(`vector:cloud-agents:brain:${run.prepared.uploadId}`)
        const answer = await f.post("download", run.minted.token, { uploadId: run.prepared.uploadId })
        state.down = false
        expect({ change, status: answer.status, key: answer.body.key, artifactKey: answer.body.artifactKey }).toEqual({
          change,
          status: expected[change],
          key: undefined,
          artifactKey: undefined,
        })
        if (change === "upload") expect(answer.body.error.code).toBe("BRAIN_UPLOAD_INVALID")
        expect(await redis.send("HGET", [`vector:cloud-agents:run:${run.minted.runId}`, "brainSha"])).toBeNull()
      } finally {
        state.down = false
        await f.close()
      }
    }
  })

  test("an owner-desktop run never gets the ordinary conversation key, before or after its Brain download, while other ticket runs do", async () => {
    const f = await fixture()
    try {
      const run = await f.brainRun()
      async function refused(token: string) {
        const answer = await f.send("artifactKey", token, { thread: "dispatch-1000" })
        expect({
          status: answer.status,
          code: answer.body.error?.code,
          key: answer.body.key,
          keyId: answer.body.keyId,
        }).toEqual({ status: 403, code: "ARTIFACT_KEY_NOT_ALLOWED", key: undefined, keyId: undefined })
      }
      await refused(run.minted.token)
      expect((await f.post("download", run.minted.token, { uploadId: run.prepared.uploadId })).status).toBe(200)
      await refused(run.minted.token)
      // A bot renewal of the same check run keeps the desktop provenance, so it is refused too.
      const renewed = await f.mint()
      expect(renewed.status).toBe(200)
      expect(renewed.body.deadline).toBe(run.minted.deadline)
      await refused(renewed.body.token)
      // An ops ticket run on the same dispatch thread still gets the ordinary key.
      expect((await f.start()).ok).toBe(true)
      f.job("1002")
      const ops = await f.mint({ ticket: f.ticket() }, { check_run_id: "1002" })
      expect(ops.status).toBe(200)
      const key = await f.post("artifactKey", ops.body.token, { thread: "dispatch-1000" })
      expect(key.status).toBe(200)
      expect(key.body).toEqual(
        cloudRunArtifactKey({
          sub: f.account,
          repo: f.github.repositoryId,
          gen: f.binding.generation,
          thr: "dispatch-1000",
        }),
      )
    } finally {
      await f.close()
    }
  })

  // EV-25 (R-A1 to R-A3): the ticket's job id and the run start and settle listeners. vector-at-mention runs every
  // cloud-agents file in one process and the listener registry is process-wide, so every case removes its listeners.

  /** Records every start and settle the listeners hear; `remove` takes both listeners away again. */
  function hear() {
    const starts: Array<{ ticketHash: string; rid: string; jobId?: string }> = []
    const settles: Array<{ rid: string; end: RunEnd }> = []
    const removers = [
      registerRunStartListener(async (ticketHash, rid, jobId) => void starts.push({ ticketHash, rid, jobId })),
      registerRunSettleListener(async (rid, end) => void settles.push({ rid, end })),
    ]
    return { starts, settles, remove: () => removers.forEach((remove) => remove()) }
  }

  async function jobTicket(f: Awaited<ReturnType<typeof fixture>>, jobId?: string) {
    const prepared = await prepareCloudRun(
      jobId === undefined ? f.trigger : { ...f.trigger, jobId, prompt: `${ACTIONS_JOB_PROMPT}${jobId}` },
      f.deps,
    )
    if (!prepared.ok) throw new Error("Fixture could not prepare")
    expect(await prepared.dispatch()).toEqual({ ok: true, dispatchedAt: f.policy.now })
    return prepared.ticketHash
  }

  test("R-A1: a ticket stores a valid job id that RESERVE admits and only the prompt carries it to GitHub", async () => {
    const f = await fixture()
    const heard = hear()
    try {
      const jobId = createJobId(f.policy.now)
      const prompt = `${ACTIONS_JOB_PROMPT}${jobId}`
      const prepared = await prepareCloudRun({ ...f.trigger, jobId, prompt }, f.deps)
      if (!prepared.ok) throw new Error("Fixture could not prepare")
      const key = `vector:cloud-agents:ticket:${prepared.ticketHash}`
      const six = {
        repositoryId: f.github.repositoryId,
        account: f.account,
        generation: f.binding.generation,
        source: "ops" as const,
        purpose: "incident" as const,
        exp: f.policy.now + 900_000,
      }
      expect(JSON.parse(String(await persistentStore(["GET", key])))).toEqual({ ...six, jobId })
      expect(await prepared.dispatch()).toEqual({ ok: true, dispatchedAt: f.policy.now })
      expect(f.github.state.dispatches).toEqual([
        { ref: "refs/heads/main", inputs: { mode: "task", prompt, ticket: f.ticket() } },
      ])
      expect(prepared.ticketHash).toBe(createHash("sha256").update(f.ticket()).digest("hex"))
      expect(await peekRunTicket(f.ticket(), await f.botIdentity(), f.binding, f.deps)).toEqual({
        ...six,
        jobId,
        key,
        ticketHash: prepared.ticketHash,
      })
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      expect((await liveRun(f.account, minted.body.runId))?.ticketHash).toBe(prepared.ticketHash)
      expect(await persistentStore(["EXISTS", key])).toBe(0)
      expect(heard.starts).toEqual([{ ticketHash: prepared.ticketHash, rid: minted.body.runId, jobId }])

      const tickets = async () => ((await redis.send("KEYS", ["vector:cloud-agents:ticket:*"])) as string[]).sort()
      const before = await tickets()
      const seen = { commands: 0, entitlements: 0 }
      f.policy.onStore = async () => void seen.commands++
      f.policy.beforeCall = async () => void seen.entitlements++
      for (const bad of [
        "vej_",
        jobId.slice(0, -1),
        `${jobId}0`,
        jobId.toUpperCase(),
        `vej_i${jobId.slice(5)}`,
        `${jobId}\n`,
        ` ${jobId}`,
        42,
      ])
        await expect(
          prepareCloudRun({ ...f.trigger, jobId: bad } as unknown as CloudRunTrigger, f.deps),
        ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REQUEST" })
      expect(seen).toEqual({ commands: 0, entitlements: 0 })
      expect(await tickets()).toEqual(before)
      expect(f.github.state.dispatches).toHaveLength(1)
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("R-A1: RESERVE refuses a ticket changed after the peek: another seventh field, an eighth, or a null, malformed or long job id", async () => {
    for (const change of ["seventh", "eighth", "null", "malformed", "long"] as const) {
      const f = await fixture()
      const heard = hear()
      try {
        const jobId = createJobId(f.policy.now)
        const key = `vector:cloud-agents:ticket:${await jobTicket(f, jobId)}`
        const stored = JSON.parse(String(await persistentStore(["GET", key])))
        const rewritten =
          change === "seventh"
            ? { ...stored, jobId: undefined, note: "1" }
            : change === "eighth"
              ? { ...stored, note: "1" }
              : change === "null"
                ? { ...stored, jobId: null }
                : change === "malformed"
                  ? { ...stored, jobId: jobId.toUpperCase() }
                  : { ...stored, jobId: `${jobId}0` }
        f.policy.onStore = async (command) => {
          if (!reserveCommand(command)) return
          f.policy.onStore = undefined
          expect(await persistentStore(["SET", key, JSON.stringify(rewritten), "KEEPTTL"])).toBe("OK")
        }
        expect((await f.mint({ ticket: f.ticket() })).status).toBe(503)
        expect(await persistentStore(["EXISTS", key])).toBe(1)
        expect(await persistentStore(["HLEN", liveKey(f.account)])).toBe(0)
        expect(heard.starts).toEqual([])
      } finally {
        heard.remove()
        await f.close()
      }
    }
  })

  test("R-A2: the mint that consumes a ticket tells the start listener once; renewals, later mints and a removed listener tell nobody", async () => {
    const f = await fixture()
    const heard = hear()
    try {
      const jobId = createJobId(f.policy.now)
      const first = await jobTicket(f, jobId)
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      expect(heard.starts).toEqual([{ ticketHash: first, rid: minted.body.runId, jobId }])
      const renewed = await f.mint()
      expect(renewed.status).toBe(200)
      expect(renewed.body.runId).toBe(minted.body.runId)
      expect((await f.send("settle", renewed.body.token, { outcome: "changes" })).status).toBe(200)
      expect((await f.mint()).status).toBe(403)
      expect((await f.mint({ ticket: f.ticket() })).status).toBe(403)
      expect(heard.starts).toHaveLength(1)

      f.job("1002")
      const second = await jobTicket(f)
      const plain = await f.mint({ ticket: f.ticket() }, { check_run_id: "1002" })
      expect(plain.status).toBe(200)
      expect(heard.starts).toEqual([
        { ticketHash: first, rid: minted.body.runId, jobId },
        { ticketHash: second, rid: plain.body.runId, jobId: undefined },
      ])

      heard.remove()
      f.job("1003")
      await jobTicket(f, createJobId(f.policy.now))
      expect((await f.mint({ ticket: f.ticket() }, { check_run_id: "1003" })).status).toBe(200)
      expect(heard.starts).toHaveLength(2)
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("R-A2: two check runs that peeked one ticket tell the start listener once, for the winner", async () => {
    const f = await fixture()
    const heard = hear()
    try {
      const jobId = createJobId(f.policy.now)
      const ticketHash = await jobTicket(f, jobId)
      f.job("1002")
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
      const winner = answers.find((answer) => answer.status === 200)!
      expect(heard.starts).toEqual([{ ticketHash, rid: winner.body.runId, jobId }])
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("R-A2: a concurrent mint of the same check run, which RESERVE renews, tells nobody", async () => {
    const f = await fixture()
    const heard = hear()
    try {
      const ticketHash = await jobTicket(f)
      const key = `vector:cloud-agents:ticket:${ticketHash}`
      const peeked = Promise.withResolvers<void>()
      const answered = Promise.withResolvers<void>()
      const seen = { peeks: 0, reserves: 0 }
      // Both mints peek the ticket before either reserves; the second reserves only after the first has answered.
      f.policy.onStore = async (command) => {
        if (command[0] === "GET" && command[1] === key && ++seen.peeks === 2) peeked.resolve()
        if (!reserveCommand(command)) return
        if (++seen.reserves === 1) return peeked.promise
        await answered.promise
      }
      const answers = await Promise.all(
        [0, 1].map(() =>
          f.mint({ ticket: f.ticket() }).then((answer) => {
            answered.resolve()
            return answer
          }),
        ),
      )
      expect(seen).toEqual({ peeks: 2, reserves: 2 })
      expect(answers.map((answer) => answer.status)).toEqual([200, 200])
      expect(answers[0]!.body.runId).toBe(answers[1]!.body.runId)
      expect(heard.starts).toEqual([{ ticketHash, rid: answers[0]!.body.runId, jobId: undefined }])
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("R-A2: a mint that fails after its reservation tells nobody, and its recovery does not either", async () => {
    for (const failure of ["record", "reply"] as const) {
      const f = await fixture()
      const heard = hear()
      try {
        await jobTicket(f, createJobId(f.policy.now))
        f.policy.onStore = async (command) => {
          if (failure === "record" ? !startCommand(command) : !reserveCommand(command)) return
          f.policy.onStore = undefined
          if (failure === "reply") await persistentStore(command)
          throw new Error("store failure")
        }
        expect((await f.mint({ ticket: f.ticket() })).status).toBe(503)
        if (failure === "reply") expect((await f.mint()).status).toBe(200)
        expect(heard.starts).toEqual([])
      } finally {
        heard.remove()
        await f.close()
      }
    }
  })

  test("listener failures change no answer or record and log one fixed line each, with no id", async () => {
    const f = await fixture()
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const heard = hear()
    const removers = [
      registerRunStartListener((ticketHash, rid, jobId) => {
        throw new Error(`boom ${ticketHash} ${rid} ${jobId}`)
      }),
      registerRunStartListener(async (ticketHash, rid, jobId) => {
        throw new Error(`boom ${ticketHash} ${rid} ${jobId}`)
      }),
      registerRunSettleListener(async (rid, end) => {
        throw new Error(`boom ${rid} ${end.runUrl}`)
      }),
    ]
    try {
      const jobId = createJobId(f.policy.now)
      const ticketHash = await jobTicket(f, jobId)
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      expect(Object.keys(minted.body).sort()).toEqual(["deadline", "heartbeatSeconds", "idleSeconds", "runId", "token"])
      await until(() => warn.mock.calls.length === 2)
      expect(heard.starts).toEqual([{ ticketHash, rid: minted.body.runId, jobId }])
      expect((await f.send("heartbeat", minted.body.token, { state: "running" })).status).toBe(200)
      expect(await liveRun(f.account, minted.body.runId)).toBeDefined()
      expect((await listCloudRuns(f.account)).map((run) => run.rid)).toEqual([minted.body.runId])

      expect(await f.send("settle", minted.body.token, { outcome: "changes" })).toMatchObject({
        status: 200,
        body: { ok: true },
      })
      await until(() => heard.settles.length === 1 && warn.mock.calls.length === 3)
      expect((await listCloudRuns(f.account))[0]?.outcome).toBe("changes")
      expect(await liveRun(f.account, minted.body.runId)).toBeUndefined()
      expect((await f.send("settle", minted.body.token, { outcome: "failed" })).status).toBe(200)
      await Bun.sleep(100)
      expect(heard.settles).toHaveLength(1)
      expect(warn.mock.calls).toEqual([
        ["Vector cloud-agents start listener failed"],
        ["Vector cloud-agents start listener failed"],
        ["Vector cloud-agents settle listener failed"],
      ])
      const logged = JSON.stringify(warn.mock.calls)
      for (const value of [ticketHash, minted.body.runId, jobId, f.account, f.github.repositoryId, "boom"])
        expect(logged).not.toContain(value)
    } finally {
      removers.forEach((remove) => remove())
      heard.remove()
      warn.mockRestore()
      await f.close()
    }
  })

  test("a hanging listener delays no answer, still runs once, and is cut off after five seconds with a fixed warning", async () => {
    const f = await fixture()
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const calls = { start: 0, settle: 0 }
    const removers = [
      registerRunStartListener(async () => {
        calls.start++
        await new Promise(() => {})
      }),
      registerRunSettleListener(async () => {
        calls.settle++
        await new Promise(() => {})
      }),
    ]
    try {
      await jobTicket(f, createJobId(f.policy.now))
      const begun = performance.now()
      const minted = await f.mint({ ticket: f.ticket() })
      expect(minted.status).toBe(200)
      // The engine gives its whole settle 5 s (github.cloud.ts), so neither answer may wait on a listener.
      expect(performance.now() - begun).toBeLessThan(4_000)
      const settling = performance.now()
      expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(200)
      expect(performance.now() - settling).toBeLessThan(4_000)
      await until(() => calls.settle === 1)
      expect(calls).toEqual({ start: 1, settle: 1 })
      await until(() => warn.mock.calls.length === 2, 15_000)
      expect(performance.now() - begun).toBeGreaterThanOrEqual(4_900)
      expect(warn.mock.calls).toEqual([
        ["Vector cloud-agents start listeners timed out"],
        ["Vector cloud-agents settle listeners timed out"],
      ])
      expect(calls).toEqual({ start: 1, settle: 1 })
    } finally {
      removers.forEach((remove) => remove())
      warn.mockRestore()
      await f.close()
    }
  })

  test("R-A3: only the settle that ends the run tells the settle listener, with its outcome, the run's page and its pull request", async () => {
    const f = await fixture()
    const heard = hear()
    const reads: string[] = []
    try {
      await jobTicket(f, createJobId(f.policy.now))
      const minted = await f.mint({ ticket: f.ticket() })
      const run = (await listCloudRuns(f.account))[0]!
      const pulls = { changes: 7, failed: 8, draft: 9 }
      f.policy.onStore = async (command) => {
        if (recordRead(command)) reads.push(String(command[3]))
      }
      const answers = await Promise.all(
        (["changes", "failed", "draft"] as const).map((outcome) =>
          f.send("settle", minted.body.token, {
            outcome,
            prUrl: `https://github.com/${run.repository}/pull/${pulls[outcome]}`,
          }),
        ),
      )
      expect(answers.map((answer) => [answer.status, answer.body])).toEqual([
        [200, { ok: true }],
        [200, { ok: true }],
        [200, { ok: true }],
      ])
      await until(() => heard.settles.length === 1)
      const outcome = (await listCloudRuns(f.account))[0]!.outcome as keyof typeof pulls
      expect(heard.settles).toEqual([
        {
          rid: minted.body.runId,
          end: { outcome, runUrl: run.runUrl, prUrl: `https://github.com/${run.repository}/pull/${pulls[outcome]}` },
        },
      ])
      expect(reads).toEqual([runRecordKey(minted.body.runId)])
      expect((await f.send("settle", minted.body.token, { outcome: "cancelled" })).status).toBe(200)
      expect(reads).toHaveLength(1)

      // A committing settle whose reply is lost tells nobody, and neither does its retry: the event is at most once.
      f.job("1002")
      await jobTicket(f, createJobId(f.policy.now))
      const lost = await f.mint({ ticket: f.ticket() }, { check_run_id: "1002" })
      expect(lost.status).toBe(200)
      f.policy.onStore = async (command) => {
        if (recordRead(command)) reads.push(String(command[3]))
        if (!settleCommand(command)) return
        f.policy.onStore = async (next) => {
          if (recordRead(next)) reads.push(String(next[3]))
        }
        await persistentStore(command)
        throw new Error("lost settle reply")
      }
      expect((await f.send("settle", lost.body.token, { outcome: "changes" })).status).toBe(503)
      expect((await f.send("settle", lost.body.token, { outcome: "changes" })).status).toBe(200)
      expect((await listCloudRuns(f.account)).find((entry) => entry.rid === lost.body.runId)?.outcome).toBe("changes")
      await Bun.sleep(100)
      expect(reads).toHaveLength(1)
      expect(heard.settles).toHaveLength(1)
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("F-c: the settle listener keeps only a pull request of the run's own repository; any other prUrl is ignored, never refused", async () => {
    const f = await fixture()
    const heard = hear()
    try {
      await jobTicket(f)
      const probe = await f.mint({ ticket: f.ticket() })
      const own = (await listCloudRuns(f.account))[0]!.repository!
      expect((await f.send("settle", probe.body.token, { outcome: "changes" })).status).toBe(200)
      await until(() => heard.settles.length === 1)
      expect(heard.settles[0]!.end).toEqual({ outcome: "changes", runUrl: expect.any(String) })
      const cases: Array<[unknown, string | undefined]> = [
        [`https://github.com/${own}/pull/12`, `https://github.com/${own}/pull/12`],
        [`https://github.com/${own.toUpperCase()}/pull/13`, `https://github.com/${own}/pull/13`],
        ["https://github.com/fixture-owner/other/pull/12", undefined],
        [`http://github.com/${own}/pull/12`, undefined],
        [`https://github.com/${own}/pull/12/files`, undefined],
        [`https://github.com/${own}/issues/12`, undefined],
        [`https://github.com.example/${own}/pull/12`, undefined],
        [`https://github.com/${own}/pull/0`, undefined],
        [`https://github.com/${own}/pull/12345678901`, undefined],
        [`https://github.com/${own}/pull/12\n`, undefined],
        [12, undefined],
        [null, undefined],
      ]
      for (const [index, [prUrl, kept]] of cases.entries()) {
        const check = String(2001 + index)
        f.job(check)
        await jobTicket(f)
        const minted = await f.mint({ ticket: f.ticket() }, { check_run_id: check })
        expect(minted.status).toBe(200)
        expect(await f.send("settle", minted.body.token, { outcome: "draft", prUrl })).toMatchObject({
          status: 200,
          body: { ok: true },
        })
        await until(() => heard.settles.length === index + 2)
        const runUrl = (await listCloudRuns(f.account)).find((run) => run.rid === minted.body.runId)?.runUrl
        expect(heard.settles[index + 1]).toEqual({
          rid: minted.body.runId,
          end: { outcome: "draft", runUrl, ...(kept === undefined ? {} : { prUrl: kept }) },
        })
      }
      // Every other field is still refused, before the run token is read.
      f.job("2100")
      await jobTicket(f)
      const refused = await f.mint({ ticket: f.ticket() }, { check_run_id: "2100" })
      expect(
        await f.send("settle", refused.body.token, {
          outcome: "changes",
          prUrl: `https://github.com/${own}/pull/12`,
          note: "1",
        }),
      ).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } })
      expect(await liveRun(f.account, refused.body.runId)).toBeDefined()
      expect(heard.settles).toHaveLength(cases.length + 1)
    } finally {
      heard.remove()
      await f.close()
    }
  })

  test("no listener runs while the cloud-agents service is off", async () => {
    const f = await fixture()
    const heard = hear()
    const reads: string[] = []
    const saved = {
      VECTOR_GITHUB_BRAIN_ENABLED: process.env.VECTOR_GITHUB_BRAIN_ENABLED,
      MODEL_PLANS_ENABLED: process.env.MODEL_PLANS_ENABLED,
    }
    const switches = [
      ["VECTOR_GITHUB_BRAIN_ENABLED", "CLOUD_AGENTS_UNAVAILABLE"],
      ["MODEL_PLANS_ENABLED", "MODEL_PLANS_DISABLED"],
    ] as const
    try {
      await jobTicket(f, createJobId(f.policy.now))
      const ticket = f.ticket()
      for (const [name, code] of switches) {
        process.env[name] = "false"
        expect(await f.mint({ ticket })).toMatchObject({ status: 503, body: { error: { code } } })
        process.env[name] = "true"
      }
      expect(await peekRunTicket(ticket, await f.botIdentity(), f.binding, f.deps)).toBeDefined()
      expect(heard.starts).toEqual([])
      const minted = await f.mint({ ticket })
      expect(minted.status).toBe(200)
      expect(heard.starts).toHaveLength(1)

      f.policy.onStore = async (command) => {
        if (recordRead(command)) reads.push(String(command[3]))
      }
      for (const [name, code] of switches) {
        process.env[name] = "false"
        expect(await f.send("settle", minted.body.token, { outcome: "changes" })).toMatchObject({
          status: 503,
          body: { error: { code } },
        })
        process.env[name] = "true"
      }
      expect(await liveRun(f.account, minted.body.runId)).toBeDefined()
      await Bun.sleep(100)
      expect(reads).toEqual([])
      expect(heard.settles).toEqual([])
      expect((await f.send("settle", minted.body.token, { outcome: "changes" })).status).toBe(200)
      await until(() => heard.settles.length === 1)
      expect(reads).toEqual([runRecordKey(minted.body.runId)])
    } finally {
      for (const [name, value] of Object.entries(saved))
        value === undefined ? delete process.env[name] : (process.env[name] = value)
      heard.remove()
      await f.close()
    }
  })
}

function seal(prepared: { key: string; aad: string }, content: Uint8Array) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(prepared.key, "base64url"), nonce)
  cipher.setAAD(Buffer.from(prepared.aad))
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([cipher.update(content), cipher.final(), cipher.getAuthTag()]).toString("base64url"),
  }
}

function unseal(value: { key: string; aad: string; nonce: string; ciphertext: string }) {
  const bytes = Buffer.from(value.ciphertext, "base64url")
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(value.key, "base64url"),
    Buffer.from(value.nonce, "base64url"),
  )
  decipher.setAAD(Buffer.from(value.aad))
  decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()])
}

/** recordRunStart's START script: seven keys, the run record's first. */
function startCommand(command: readonly (string | number)[]) {
  return (
    command[0] === "EVAL" && String(command[2]) === "7" && String(command[3]).startsWith("vector:cloud-agents:run:")
  )
}

/** The ledger's SETTLE_RECORDED script: the live hash first and the run record third. */
function settleCommand(command: readonly (string | number)[]) {
  return (
    command[0] === "EVAL" &&
    String(command[2]) === "6" &&
    String(command[3]).startsWith("vector:cloud-agents:live:") &&
    String(command[5]).startsWith("vector:cloud-agents:run:")
  )
}

/** The settle notification's one read of the run record (cloud-agents-runs.ts RECORD). */
function recordRead(command: readonly (string | number)[]) {
  return (
    command[0] === "EVAL" &&
    command[1] === "return redis.call('HGETALL', KEYS[1])" &&
    String(command[3]).startsWith("vector:cloud-agents:run:")
  )
}

async function until(check: () => boolean, ms = 5_000) {
  const end = performance.now() + ms
  while (!check()) {
    if (performance.now() > end) throw new Error("A run listener was not heard in time")
    await Bun.sleep(5)
  }
}

function reserveCommand(command: readonly (string | number)[]) {
  return (
    command[0] === "EVAL" &&
    String(command[3]).startsWith("vector:cloud-agents:live:") &&
    String(command[5]).startsWith("vector:cloud-agents:sched:")
  )
}
