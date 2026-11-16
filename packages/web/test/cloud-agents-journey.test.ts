import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { buildAgentsWorkflow } from "@vectordevai/core/review/workflow"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { cloudBrainArtifactKey, cloudRunArtifactKey } from "../../../api/_lib/cloud-agents-artifact"
import { bindingFor } from "../../../api/_lib/cloud-agents-binding"
import { bindBrainUpload } from "../../../api/_lib/cloud-agents-brain"
import { createDesktopCloudAgentApi } from "../../../api/_lib/cloud-agents-desktop"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { cloudAgentSecondsUsed, cloudAgentsGatewayHook, liveRun } from "../../../api/_lib/cloud-agents-ledger"
import { createOwnerArtifactReadApi } from "../../../api/_lib/cloud-agents-owner-artifact"
import { cloudAgentsRunVerifier, readRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { eraseCloudAgentsAccount, listCloudRuns } from "../../../api/_lib/cloud-agents-runs"
import { prepareCloudRun } from "../../../api/_lib/cloud-agents-start"
import { requireModelPlanCaller } from "../../../api/_lib/model-plan-caller"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

const ARTIFACT_SECRET = "journey-artifact-fixture-secret-32-characters"
const LESSON = "JOURNEY-LESSON"
const SKILL = "JOURNEY-SKILL"
const PROMPT = "Maintain this repository with the approved context"
const BRAIN_FAILED = "This Brain attachment request could not be completed."
const READ_FAILED = "This GitHub result is unavailable. Reconnect the repository and try again from the desktop."

journey()

function journey() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("GitHub agent server journey requires disposable loopback VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("The journey requires loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const keys = new Set<string>()
  // Every store command any route sends, counted before it reaches Redis, so a refusal can prove it did no store work.
  const traffic = { commands: 0 }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/")
      expect(request.headers.get("authorization")).toBe("Bearer journey-fixture-kv")
      const command = (await request.json()) as (string | number)[]
      traffic.commands += 1
      const offset = command[0] === "EVAL" ? 3 : 1
      const count = command[0] === "EVAL" ? Number(command[2]) : 1
      command.slice(offset, offset + count).forEach((key) => keys.add(String(key)))
      return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
    },
  })
  const environment = [
    "NODE_ENV",
    "MODEL_PLANS_ENABLED",
    "VECTOR_GITHUB_BRAIN_ENABLED",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_ABUSE_SECRET",
    "VECTOR_RUN_TOKEN_SECRET",
    "VECTOR_CLI_TOKEN_SECRET",
    "VECTOR_RUN_ARTIFACT_SECRET",
    "VECTOR_LICENSE_SECRET",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    // The bind, mint, run and artifact-key routes read the switch from process.env (`cloudAgentsEnabled`, a Codium
    // file), so it is set here and restored after the file; the desktop Brain routes and the owner read take it only
    // from each stage's own env object.
    Object.assign(process.env, {
      NODE_ENV: "production",
      MODEL_PLANS_ENABLED: "true",
      VECTOR_GITHUB_BRAIN_ENABLED: "true",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "journey-fixture-kv",
      VECTOR_RUN_TOKEN_SECRET: "journey-run-fixture-secret-32-characters",
      VECTOR_CLI_TOKEN_SECRET: "journey-cli-fixture-secret-32-characters",
      VECTOR_RUN_ARTIFACT_SECRET: ARTIFACT_SECRET,
    })
    delete process.env.VECTOR_LICENSE_SECRET
  })
  beforeEach(() => {
    process.env.VECTOR_ABUSE_SECRET = `journey-fixture-${crypto.randomUUID()}`
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  /**
   * One repository behind its own signed fake GitHub App, served by the real route handlers (named after their
   * api/cloud-agents files) on a loopback server. A second stage may share the first one's account and clock.
   */
  async function stage(input: { account?: string; time?: { now: number }; atOnce?: number } = {}) {
    const github = await githubAppFixture({ store: persistentStore })
    github.state.binder = { ...github.state.run.actor }
    github.state.permission = "admin"
    github.state.binderPermission = "admin"
    const person = { ...github.state.run.actor }
    const bot = { id: github.state.botId, login: `${github.config.slug}[bot]`, type: "Bot" }
    const account = input.account ?? crypto.randomUUID()
    const time = input.time ?? { now: Date.now() }
    const allowance: CloudAgentAllowance = {
      active: true,
      plan: "vector-100",
      limits: { atOnce: input.atOnce ?? 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
      allowanceSeconds: 144_000,
      meterEpoch: `journey:${time.now}`,
      periodEnd: time.now + 86_400_000,
      premiumModels: true,
    }
    const entitlement = async () => allowance
    // `eligible` stands for Codium's answer (an active allowance with github-agents and brain-cloud listed); the real
    // listing needs Codium's switches and App configuration, which these fakes do not have.
    const policy = { eligible: true, brain: true }
    const brainEnv = {
      VECTOR_RUN_ARTIFACT_SECRET: ARTIFACT_SECRET,
      get VECTOR_GITHUB_BRAIN_ENABLED() {
        return policy.brain ? "true" : undefined
      },
    }
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
        expect(target.origin).toBe(upstream.url.origin)
        return fetch(input, init)
      },
      { preconnect: fetch.preconnect },
    )
    const api = createCloudAgentsApi({
      app: github.app,
      verify: github.verify,
      fetcher,
      now: () => time.now,
      entitlement,
    })
    const desktop = createDesktopCloudAgentApi({
      store: persistentStore,
      fetcher,
      now: () => time.now,
      env: brainEnv,
      app: github.app,
      eligible: async () => policy.eligible,
      prepare: (trigger, deps) => prepareCloudRun(trigger, { ...deps, entitlement }),
    })
    const handlers = {
      "bind-code": api.bindCode,
      bind: api.bind,
      mint: api.mint,
      heartbeat: api.heartbeat,
      settle: api.settle,
      runs: api.runs,
      "artifact-key": api.artifactKey,
      "brain-prepare": desktop.prepare,
      "brain-commit": desktop.commit,
      "brain-download": desktop.download,
      "desktop-run": desktop.start,
      "owner-artifact-key": createOwnerArtifactReadApi({
        store: persistentStore,
        fetcher,
        now: () => time.now,
        env: brainEnv,
        app: github.app,
      }),
    }
    const server = createServer((request, response) => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
      void handlers[route](request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Journey server could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    const bodies: unknown[] = []
    const masked: string[] = []
    function expectSafeHeaders(response: Response) {
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    }
    async function send(route: keyof typeof handlers, token: string, body?: unknown) {
      const response = await fetch(`${origin}/${route}`, {
        method: route === "runs" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const answer = await response.json()
      expectSafeHeaders(response)
      bodies.push(answer)
      return { status: response.status, body: answer }
    }
    const ownerToken = (id = account) =>
      mintCliToken({ id, email: "journey-owner@example.test" }, time.now, "desktop").token
    async function bind(id = account) {
      github.state.run.actor = { ...person }
      github.state.run.triggering_actor = { ...person }
      github.state.job.name = "Vector bind"
      github.state.run.event = "workflow_dispatch"
      const code = await send("bind-code", ownerToken(id), {
        repository: github.state.repository.full_name,
        repositoryId: Number(github.repositoryId),
        githubUserId: github.state.run.actor.id,
        defaultRef: "refs/heads/main",
      })
      expect(code.status).toBe(200)
      const bound = await send("bind", await github.makeToken("bind", { event_name: "workflow_dispatch" }), {
        code: code.body.code,
        workflowVersion: "3",
      })
      expect(bound.status).toBe(200)
      expect(bound.body).toMatchObject({ bound: true, repositoryId: github.repositoryId, workflowUpdate: false })
      return bound.body
    }
    /** A comment run by the person on thread 17, or the App bot's dispatch run with its ticket. */
    async function mint(change: { checkRunId?: string; thread?: string; bot?: boolean; ticket?: string } = {}) {
      const checkRunId = change.checkRunId ?? "1001"
      const actor = change.bot ? bot : person
      github.state.job.name = "Vector agent"
      github.state.run.event = change.bot ? "workflow_dispatch" : "issue_comment"
      github.state.run.actor = { ...actor }
      github.state.run.triggering_actor = { ...actor }
      if (checkRunId !== "1001")
        github.state.extraJobs.push({
          ...github.state.job,
          id: 1000 + Number(checkRunId),
          check_run_url: `https://api.github.com/repos/fixture-owner/project/check-runs/${checkRunId}`,
        })
      const minted = await send(
        "mint",
        await github.makeToken("mint", {
          check_run_id: checkRunId,
          ...(change.bot ? { event_name: "workflow_dispatch", actor: bot.login, actor_id: String(bot.id) } : {}),
        }),
        {
          purpose: "task",
          thread: change.thread ?? "17",
          workflowVersion: "3",
          commentId: 123,
          ...(change.ticket === undefined ? {} : { ticket: change.ticket }),
        },
      )
      expect(minted.status).toBe(200)
      return minted.body
    }
    /**
     * The owner's approved repository context as the desktop packs it (core's BrainRunBundle.pack) and seals it
     * (core's BrainUpload.upload), through the real marked-desktop prepare and commit routes. The fixture
     * repository's visibility decides whether the shareable skill travels (only to a private repository).
     */
    async function upload() {
      const { BrainRunBundle } = await import("@vectordevai/core/brain/run-bundle")
      const { BrainUpload } = await import("@vectordevai/core/brain/upload")
      const packed = await BrainRunBundle.pack({
        ownerStartedDesktop: true,
        includeBrain: true,
        publicRepository: !github.state.repository.private,
        memory: {
          format: "vector-memory",
          version: 1,
          scope: "all",
          exportedAt: 1,
          entries: [
            {
              id: "e1",
              kind: "lesson",
              scope: "repository",
              status: "active",
              text: `${LESSON}: run the repository's tests`,
              paths: [],
              pinned: true,
              evidence: [],
              createdAt: 1,
            },
          ],
          documents: [],
        },
        shareableSkills: [
          {
            id: "s1",
            kind: "skill",
            scope: "repository",
            status: "active",
            text: "Check changes",
            paths: [],
            pinned: true,
            evidence: [],
            createdAt: 1,
            skill: {
              name: "journey-check",
              description: "Check changes",
              procedure: `${SKILL}: run the repository's tests`,
              checks: ["bun test"],
              commands: [],
              version: 1,
            },
          },
        ],
        insights: {
          format: "vector-workflow-insights",
          version: 1,
          rows: [
            {
              tier: "standard",
              model: "journey-model",
              effort: "medium",
              split: "solo",
              runs: 3,
              passRate: 1,
              checkedShare: 1,
            },
          ],
        },
        screen: async (parts) => parts.map(() => true),
      })
      const approved = { key: "", aad: "", approvedAt: 0 }
      const reference = await BrainUpload.upload({
        repositoryId: github.repositoryId,
        selection: packed,
        approvedSha256: packed.sha256,
        includeBrain: true,
        transport: async (kind, body) => {
          const answer = await send(kind === "prepare" ? "brain-prepare" : "brain-commit", ownerToken(), body)
          expect(answer.status).toBe(200)
          if (kind === "prepare") Object.assign(approved, { key: answer.body.key, aad: answer.body.aad })
          if (kind === "commit") approved.approvedAt = answer.body.approvedAt
          return answer.body
        },
      })
      return { uploadId: reference.uploadId, sha256: reference.sha256, bytes: packed.bytes, approved }
    }
    async function desktopRun(reference: { uploadId: string; sha256: string }) {
      const started = await send("desktop-run", ownerToken(), {
        repositoryId: github.repositoryId,
        prompt: PROMPT,
        brain: { uploadId: reference.uploadId, sha256: reference.sha256 },
      })
      expect(started).toEqual({ status: 200, body: { ok: true, dispatchedAt: time.now } })
      const dispatched = github.state.dispatches.at(-1)
      if (!dispatched) throw new Error("The desktop run dispatched nothing")
      return dispatched
    }
    // The engine's own run clients (github.cloud.ts) reach this stage's routes: only https://vectordev.ai/api/cloud-agents/
    // is accepted, and it is rewritten to the loopback server.
    const client = {
      oidc: async (): Promise<string> => {
        throw new Error("The journey's run clients never ask for an identity token")
      },
      mask: (value: string) => {
        masked.push(value)
      },
      request: async (target: string, init: RequestInit) => {
        const requested = new URL(target)
        expect(requested.origin).toBe("https://vectordev.ai")
        expect(requested.pathname.startsWith("/api/cloud-agents/")).toBe(true)
        const response = await fetch(`${origin}/${requested.pathname.slice("/api/cloud-agents/".length)}`, init)
        expectSafeHeaders(response)
        bodies.push(await response.clone().json())
        return response
      },
      now: () => time.now,
      monotonic: () => performance.now(),
      wait: async () => {},
      notice: () => {
        throw new Error("The journey's run clients print nothing")
      },
    }
    return {
      github,
      origin,
      account,
      time,
      policy,
      brainEnv,
      fetcher,
      bodies,
      masked,
      client,
      send,
      ownerToken,
      cliToken: () => mintCliToken({ id: account, email: "journey-owner@example.test" }, time.now).token,
      bind,
      mint,
      upload,
      desktopRun,
      async [Symbol.asyncDispose]() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await github[Symbol.asyncDispose]()
      },
    }
  }

  test("signed bind to gateway activity, settlement and history share one run authority; rebind ends the next run", async () => {
    await using s = await stage()
    const startedAt = s.time.now
    const bound = await s.bind()
    expect((await bindingFor(s.github.repositoryId))?.account).toBe(s.account)
    const minted = await s.mint()
    const claims = readRunToken(minted.token, s.time.now)
    expect(claims).toMatchObject({ sub: s.account, repo: s.github.repositoryId, gen: bound.generation, thr: "17" })
    s.time.now += 10_000
    expect(await s.send("heartbeat", minted.token, { state: "running" })).toMatchObject({
      status: 200,
      body: { ok: true, stop: false },
    })

    // The real static registration is exercised too; this journey never installs a replacement verifier.
    const verified = await cloudAgentsRunVerifier.verify(minted.token)
    const caller = await requireModelPlanCaller(
      { headers: { authorization: `Bearer ${minted.token}` } },
      s.fetcher,
      s.time.now,
    )
    expect(caller).toEqual(verified)
    expect(caller).toMatchObject({
      account: { id: s.account },
      kind: "run",
      purpose: "cloud-agents",
      run: { id: minted.runId, source: "github-comment", service: "cloud-agents" },
    })
    await cloudAgentsGatewayHook.afterSettle(caller, { endedAt: startedAt + 50_000 })
    expect((await liveRun(s.account, minted.runId))?.lastRequest).toBe(startedAt + 50_000)
    s.time.now = startedAt + 70_000
    expect(await s.send("settle", minted.token, { outcome: "changes" })).toMatchObject({
      status: 200,
      body: { ok: true },
    })
    expect(await cloudAgentSecondsUsed(s.account, claims.epoch, s.time.now)).toBe(50)
    const history = await s.send("runs", s.ownerToken())
    expect(history.status).toBe(200)
    expect(history.body.runs).toHaveLength(1)
    expect(history.body.runs[0]).toMatchObject({
      rid: minted.runId,
      outcome: "changes",
      verdict: "pass",
      source: "github-comment",
    })
    expect(await listCloudRuns(s.account)).toEqual(history.body.runs)
    expect(await liveRun(s.account, minted.runId)).toBeUndefined()
    await expect(cloudAgentsRunVerifier.verify(minted.token)).rejects.toMatchObject({ statusCode: 401 })

    const next = await s.mint({ checkRunId: "1002" })
    expect((await cloudAgentsRunVerifier.verify(next.token)).account.id).toBe(s.account)
    const rebound = await s.bind(crypto.randomUUID())
    expect(rebound.generation).toBeGreaterThan(bound.generation)
    await expect(cloudAgentsRunVerifier.verify(next.token)).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      requireModelPlanCaller({ headers: { authorization: `Bearer ${next.token}` } }, s.fetcher, s.time.now),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect((await s.send("heartbeat", next.token, { state: "running" })).status).toBe(401)
    expectPublic(s.bodies)
    expect(s.github.tokens.size).toBe(0)
  }, 30_000)

  test.each(["public", "private"])(
    "a desktop Brain run's marked upload, declared App dispatch, ticket mint, Brain download, settlement and owner read share one run authority in a %s repository",
    async (visibility) => {
      const { artifactKey, brainDownload } = await import("@vectordevai/engine/cli/cmd/github.cloud")
      const { GithubBrain } = await import("@vectordevai/engine/cli/cmd/github.brain")
      await using s = await stage()
      // The App's current answer for the repository is the only visibility source; a shareable skill travels only to a
      // private repository, and the Brain key, the run record and the owner read carry the same visibility.
      const publicRepository = visibility === "public"
      s.github.state.repository.private = !publicRepository
      const bound = await s.bind()
      const index = `vector:cloud-agents:brain:account:${s.account}`

      // Only a marked desktop sign-in can attach repository context; the refusal's own wording never crosses.
      expect(
        await s.send("brain-prepare", s.cliToken(), {
          repositoryId: s.github.repositoryId,
          sha256: "a".repeat(64),
          bytes: 1,
          includeBrain: true,
        }),
      ).toEqual({ status: 403, body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED", message: BRAIN_FAILED } } })
      expect(await redis.send("SCARD", [index])).toBe(0)

      // The real prepare and commit store only the envelope, for at most two hours.
      const upload = await s.upload()
      const uploadKey = `vector:cloud-agents:brain:${upload.uploadId}`
      const stored = await redis.send("GET", [uploadKey])
      expect(stored).not.toContain(LESSON)
      expect(stored).not.toContain(SKILL)
      expect(stored).not.toContain(PROMPT)
      expect(JSON.parse(stored).ticketHash).toBeUndefined()
      const ttl = await redis.send("PTTL", [uploadKey])
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(7_200_000)
      expect(await redis.send("SCARD", [index])).toBe(1)

      // desktop-run prepares the ticket and dispatches through the App with inputs the generated Codium file declares.
      const minted0 = s.github.state.minted.length
      const events0 = s.github.state.events.length
      const dispatch = await s.desktopRun(upload)
      expect(s.github.state.dispatches).toHaveLength(1)
      expect(dispatch).toEqual({
        ref: "refs/heads/main",
        inputs: {
          mode: "task",
          prompt: PROMPT,
          ticket: expect.stringMatching(/^vtk_[A-Za-z0-9_-]{43}$/),
          brain_upload: upload.uploadId,
        },
      })
      const inputs = declared()
      expect(Object.fromEntries(Object.keys(dispatch.inputs).map((key) => [key, inputs[key]?.type]))).toEqual({
        mode: "choice",
        prompt: "string",
        ticket: "string",
        brain_upload: "string",
      })
      expect(inputs.mode?.options).toContain(dispatch.inputs.mode)
      expect(s.github.state.minted.slice(minted0).map((item) => item.body.permissions)).toEqual([
        { metadata: "read" },
        { actions: "write", metadata: "read" },
      ])
      expect(s.github.state.events.slice(events0).filter((event) => event.startsWith("revoke:"))).toEqual([
        "revoke:attachment",
        "revoke:dispatch",
      ])
      const ticket = dispatch.inputs.ticket
      const ticketHash = createHash("sha256").update(ticket).digest("hex")
      expect(JSON.parse(await redis.send("GET", [uploadKey])).ticketHash).toBe(ticketHash)

      // The App bot's run mints with that ticket, which is consumed into the live run's desktop provenance.
      const minted = await s.mint({ bot: true, thread: "dispatch-1000", ticket })
      expect(readRunToken(minted.token, s.time.now)).toMatchObject({
        sub: s.account,
        repo: s.github.repositoryId,
        gen: bound.generation,
        thr: "dispatch-1000",
        src: "github-dispatch",
        pur: "task",
      })
      expect(await liveRun(s.account, minted.runId)).toMatchObject({
        triggerSource: "desktop",
        triggerPurpose: "task",
        ticketHash,
      })
      expect(await redis.send("EXISTS", [`vector:cloud-agents:ticket:${ticketHash}`])).toBe(0)
      const record = `vector:cloud-agents:run:${minted.runId}`
      const holder = { runToken: () => minted.token }
      const thread = { VECTOR_THREAD: "dispatch-1000" }

      // Its own thread's ordinary key, before any Brain use: an owner-desktop run never holds it (BT03).
      async function ordinaryRefused() {
        const refused = await s.send("artifact-key", minted.token, { thread: "dispatch-1000" })
        expect({
          status: refused.status,
          code: refused.body.error?.code,
          key: refused.body.key,
          keyId: refused.body.keyId,
        }).toEqual({ status: 403, code: "ARTIFACT_KEY_NOT_ALLOWED", key: undefined, keyId: undefined })
        expect(await artifactKey({ env: thread, holder, services: s.client })).toEqual({ status: "not-allowed" })
      }
      await ordinaryRefused()
      expect((await s.send("artifact-key", minted.token, { thread: "17" })).body.error.code).toBe("INVALID_REQUEST")

      // Codium's answer for this account (fixture): without it the download refuses and records nothing.
      s.policy.eligible = false
      expect(await s.send("brain-download", minted.token, { uploadId: upload.uploadId })).toEqual({
        status: 503,
        body: { error: { code: "BRAIN_UPLOAD_UNAVAILABLE", message: BRAIN_FAILED } },
      })
      expect(await redis.send("HGET", [record, "brainSha"])).toBeNull()
      s.policy.eligible = true

      // The engine's strict client reads the real answer first; the route's own answer is the same object.
      const downloaded = await brainDownload({
        env: { VECTOR_BRAIN_UPLOAD: upload.uploadId },
        holder,
        services: s.client,
      })
      expect(downloaded.status).toBe("ok")
      if (downloaded.status !== "ok") throw new Error("The engine client refused the real download answer")
      const download = downloaded.download
      const direct = await s.send("brain-download", minted.token, { uploadId: upload.uploadId })
      expect(direct.status).toBe(200)
      expect(Object.keys(direct.body).sort()).toEqual([
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
      expect(direct.body).toEqual(download)
      expect({ key: download.key, aad: download.aad, approvedAt: download.approvedAt }).toEqual(upload.approved)
      expect(download.publicRepository).toBe(publicRepository)
      const scope = { sub: s.account, repo: s.github.repositoryId, gen: bound.generation, thr: "dispatch-1000" }
      const brainKey = cloudBrainArtifactKey(
        scope,
        { sha256: upload.sha256, publicRepository },
        { VECTOR_RUN_ARTIFACT_SECRET: ARTIFACT_SECRET },
      )
      const ordinary = cloudRunArtifactKey(scope)
      expect(download.artifactKey).toEqual(brainKey)
      expect(brainKey.key).not.toBe(ordinary.key)
      // The visibility is part of the Brain key's derivation, not only a recorded field.
      expect(brainKey.key).not.toBe(
        cloudBrainArtifactKey(
          scope,
          { sha256: upload.sha256, publicRepository: !publicRepository },
          { VECTOR_RUN_ARTIFACT_SECRET: ARTIFACT_SECRET },
        ).key,
      )
      expect(await redis.send("HMGET", [record, "brainSha", "brainPublic"])).toEqual([
        upload.sha256,
        publicRepository ? "1" : "0",
      ])
      expect(s.masked).toEqual([download.key, brainKey.key])
      const opened = GithubBrain.openUpload(download, {
        repositoryId: s.github.repositoryId,
        uploadId: upload.uploadId,
        publicRepository,
      })
      expect(opened?.bytes).toEqual(upload.bytes)
      expect(opened?.bundle.memory.entries.map((entry) => entry.text)).toEqual([
        `${LESSON}: run the repository's tests`,
      ])
      expect(opened?.bundle.memory.skills?.map((entry) => entry.skill?.procedure)).toEqual(
        publicRepository ? [] : [`${SKILL}: run the repository's tests`],
      )
      expect(opened?.approval).toEqual({
        source: "desktop",
        repositoryId: s.github.repositoryId,
        sha256: upload.sha256,
        approvedAt: upload.approved.approvedAt,
        audience: "owner-desktop",
        publicRepository,
      })
      expect(opened?.brainKey).toEqual(brainKey)

      // After Brain context the ordinary key stays refused.
      await ordinaryRefused()

      expect(await s.send("heartbeat", minted.token, { state: "running" })).toEqual({
        status: 200,
        body: { ok: true, stop: false },
      })
      const caller = await requireModelPlanCaller(
        { headers: { authorization: `Bearer ${minted.token}` } },
        s.fetcher,
        s.time.now,
      )
      expect(caller).toEqual(await cloudAgentsRunVerifier.verify(minted.token))
      expect(caller).toMatchObject({
        account: { id: s.account },
        kind: "run",
        run: { id: minted.runId, source: "github-dispatch", service: "cloud-agents" },
      })

      expect(await s.send("settle", minted.token, { outcome: "changes" })).toEqual({ status: 200, body: { ok: true } })
      const history = await s.send("runs", s.ownerToken())
      expect(history.body.runs).toEqual([
        expect.objectContaining({
          rid: minted.runId,
          outcome: "changes",
          verdict: "pass",
          source: "github-dispatch",
          trigger: { source: "desktop", purpose: "task" },
        }),
      ])
      expect(JSON.stringify(history.body)).not.toMatch(/brainSha|brainPublic|ticketHash/)

      // Settlement ends the run's Brain and key authority.
      expect(await s.send("brain-download", minted.token, { uploadId: upload.uploadId })).toEqual({
        status: 401,
        body: { error: { code: "MODEL_PLAN_RUN_EXPIRED", message: BRAIN_FAILED } },
      })
      expect(
        await brainDownload({ env: { VECTOR_BRAIN_UPLOAD: upload.uploadId }, holder, services: s.client }),
      ).toEqual({
        status: "expired",
      })
      expect((await s.send("artifact-key", minted.token, { thread: "dispatch-1000" })).status).toBe(401)

      // The owner reads the completed run's key: the Brain domain the run saved under, never the ordinary key.
      const startedAt = history.body.runs[0].startedAt
      expect(Math.abs(startedAt - Date.now())).toBeLessThan(60_000)
      function artifact(change: Record<string, unknown> = {}) {
        s.github.state.artifact = {
          id: 55,
          name: "vector-session-dispatch-1000",
          expired: false,
          size_in_bytes: 4096,
          created_at: new Date(startedAt).toISOString(),
          expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          workflow_run: {
            id: 1000,
            repository_id: Number(s.github.repositoryId),
            head_repository_id: Number(s.github.repositoryId),
          },
          ...change,
        }
      }
      s.github.state.run.event = "workflow_dispatch"
      artifact()
      const read = () => s.send("owner-artifact-key", s.ownerToken(), { rid: minted.runId, artifactId: "55" })
      const readMinted = s.github.state.minted.length
      const readEvents = s.github.state.events.length
      const owner = await read()
      expect(owner).toEqual({
        status: 200,
        body: {
          ...brainKey,
          repositoryId: s.github.repositoryId,
          thread: "dispatch-1000",
          rid: minted.runId,
          artifactId: "55",
          publicRepository,
        },
      })
      expect(owner.body.key).toBe(download.artifactKey?.key)
      expect(owner.body.key).not.toBe(ordinary.key)
      expect(s.github.state.minted.slice(readMinted).map((item) => item.body.permissions)).toEqual([
        { metadata: "read" },
        { actions: "read", metadata: "read" },
      ])
      expect(s.github.state.events.slice(readEvents).filter((event) => event.startsWith("revoke:"))).toEqual([
        "revoke:attachment",
        "revoke:validation",
      ])
      expect(s.github.state.requests.filter((path) => path.includes("/zip"))).toEqual([])
      const refusal = { status: 503, body: { error: { code: "ARTIFACT_READ_UNAVAILABLE", message: READ_FAILED } } }
      // Fresh writer permission, not the binder cache.
      s.github.state.binderPermission = "read"
      expect(await read()).toEqual(refusal)
      s.github.state.binderPermission = "admin"
      expect((await read()).status).toBe(200)
      // Exact artifact and run metadata, each change alone.
      for (const change of [
        { name: "vector-session-17" },
        { expired: true },
        {
          workflow_run: {
            id: 1001,
            repository_id: Number(s.github.repositoryId),
            head_repository_id: Number(s.github.repositoryId),
          },
        },
      ]) {
        artifact(change)
        expect(await read()).toEqual(refusal)
      }
      artifact()
      s.github.state.run.event = "issue_comment"
      expect(await read()).toEqual(refusal)
      s.github.state.run.event = "workflow_dispatch"
      expect((await read()).status).toBe(200)
      // A caller-chosen thread, a run token and an unmarked token are refused before any GitHub request.
      const requested = s.github.state.requests.length
      expect(
        await s.send("owner-artifact-key", s.ownerToken(), { rid: minted.runId, artifactId: "55", thread: "17" }),
      ).toEqual(refusal)
      expect(await s.send("owner-artifact-key", minted.token, { rid: minted.runId, artifactId: "55" })).toEqual(refusal)
      expect(await s.send("owner-artifact-key", s.cliToken(), { rid: minted.runId, artifactId: "55" })).toEqual(refusal)
      expect(s.github.state.requests.length).toBe(requested)

      // A same-account rebind moves the generation, so the completed run's Brain key is no longer derivable.
      expect((await s.bind()).generation).toBe(bound.generation + 1)
      expect(await read()).toEqual(refusal)

      expectPublic(s.bodies)
      expect(s.github.tokens.size).toBe(0)
    },
    30_000,
  )

  test("another thread, another repository's token, an expired token, the Brain switch, a rebind and account revocation each end the keys they guard", async () => {
    const { artifactKey, brainDownload } = await import("@vectordevai/engine/cli/cmd/github.cloud")
    await using a = await stage({ atOnce: 5 })
    await using b = await stage({ account: a.account, time: a.time, atOnce: 5 })
    const boundA = await a.bind()
    const boundB = await b.bind()
    // Equal generations, so a key difference below comes from the repository alone.
    expect(boundB.generation).toBe(boundA.generation)
    const u1 = await a.upload()
    const dispatch = await a.desktopRun(u1)
    const desktopRun = await a.mint({ bot: true, thread: "dispatch-1000", ticket: dispatch.inputs.ticket })
    const comment = await a.mint({ checkRunId: "1002" })
    const otherRepository = await b.mint()
    const records = [desktopRun, comment, otherRepository].map((run) => `vector:cloud-agents:run:${run.runId}`)
    const scope = { sub: a.account, repo: a.github.repositoryId, gen: boundA.generation, thr: "17" }
    const brainKey = cloudBrainArtifactKey(
      { ...scope, thr: "dispatch-1000" },
      { sha256: u1.sha256, publicRepository: true },
      a.brainEnv,
    )
    const invalid = {
      status: 400,
      body: { error: { code: "INVALID_REQUEST", message: "This request could not be completed." } },
    }
    const brainUnavailable = {
      status: 503,
      body: { error: { code: "BRAIN_UPLOAD_UNAVAILABLE", message: BRAIN_FAILED } },
    }
    const readUnavailable = {
      status: 503,
      body: { error: { code: "ARTIFACT_READ_UNAVAILABLE", message: READ_FAILED } },
    }
    const download = (token: string, uploadId = u1.uploadId) => a.send("brain-download", token, { uploadId })
    const ordinaryKey = (token: string, thread = "17") => a.send("artifact-key", token, { thread })

    // The ordinary key for the token's own thread.
    const own = await ordinaryKey(comment.token)
    expect(own).toEqual({ status: 200, body: cloudRunArtifactKey(scope) })

    // Another thread: refused, and for a desktop run the thread check comes before its own refusal.
    expect(await ordinaryKey(comment.token, "18")).toEqual(invalid)
    expect(await ordinaryKey(desktopRun.token)).toEqual(invalid)

    // Another repository's token, sent to this repository's server: its key is its own repository's.
    const other = await ordinaryKey(otherRepository.token)
    expect(other).toEqual({ status: 200, body: cloudRunArtifactKey({ ...scope, repo: b.github.repositoryId }) })
    expect(other.body.key).not.toBe(own.body.key)
    // A body naming a repository is a body-shape refusal: no field selects one.
    expect(
      await a.send("artifact-key", otherRepository.token, { thread: "17", repositoryId: a.github.repositoryId }),
    ).toEqual(invalid)
    // Not a desktop ticket run: this repository's own comment run with its own upload, so only the trigger differs.
    expect(await download(comment.token)).toEqual(brainUnavailable)
    // A combined refusal: another repository's comment run (not a desktop run, and not this upload's repository).
    expect(await download(otherRepository.token)).toEqual(brainUnavailable)
    // An upload of the other repository bound to this desktop run's own live ticket: only the repository differs.
    const uploadB = await b.upload()
    const live = await liveRun(a.account, desktopRun.runId)
    if (!live?.ticketHash) throw new Error("The desktop run has no live ticket")
    await bindBrainUpload(
      {
        account: a.account,
        repositoryId: b.github.repositoryId,
        generation: boundB.generation,
        uploadId: uploadB.uploadId,
        sha256: uploadB.sha256,
        ticketHash: live.ticketHash,
      },
      { store: persistentStore, env: b.brainEnv },
    )
    expect(await download(desktopRun.token, uploadB.uploadId)).toEqual({
      status: 400,
      body: { error: { code: "BRAIN_UPLOAD_INVALID", message: BRAIN_FAILED } },
    })
    expect(await Promise.all(records.map((record) => redis.send("HGET", [record, "brainSha"])))).toEqual(
      records.map(() => null),
    )
    // An ordinary run has no owner-readable result.
    const beforeOrdinaryRead = a.github.state.requests.length
    expect(await a.send("owner-artifact-key", a.ownerToken(), { rid: comment.runId, artifactId: "55" })).toEqual(
      readUnavailable,
    )
    expect(a.github.state.requests.length).toBe(beforeOrdinaryRead)

    // The Brain switch off: each route answers its fixed 503 with no store command and no GitHub request.
    const switchedOff = {
      commands: traffic.commands,
      a: a.github.state.requests.length,
      b: b.github.state.requests.length,
      dispatches: a.github.state.dispatches.length,
    }
    a.policy.brain = false
    process.env.VECTOR_GITHUB_BRAIN_ENABLED = "false"
    try {
      const oidc = await a.github.makeToken("mint", { check_run_id: "1003" })
      const answers = [
        await a.send("brain-prepare", a.ownerToken(), {
          repositoryId: a.github.repositoryId,
          sha256: u1.sha256,
          bytes: u1.bytes.length,
          includeBrain: true,
        }),
        await a.send("brain-commit", a.ownerToken(), {
          uploadId: u1.uploadId,
          nonce: "A".repeat(16),
          ciphertext: "A".repeat(32),
        }),
        await download(desktopRun.token),
        await a.send("desktop-run", a.ownerToken(), {
          repositoryId: a.github.repositoryId,
          prompt: PROMPT,
          brain: { uploadId: u1.uploadId, sha256: u1.sha256 },
        }),
        await a.send("owner-artifact-key", a.ownerToken(), { rid: desktopRun.runId, artifactId: "55" }),
        await ordinaryKey(comment.token),
        await a.send("mint", oidc, { purpose: "task", thread: "17", workflowVersion: "3", commentId: 123 }),
      ]
      expect(answers.map((answer) => [answer.status, answer.body.error?.code])).toEqual([
        [503, "BRAIN_UPLOAD_UNAVAILABLE"],
        [503, "BRAIN_UPLOAD_UNAVAILABLE"],
        [503, "BRAIN_UPLOAD_UNAVAILABLE"],
        [503, "BRAIN_UPLOAD_UNAVAILABLE"],
        [503, "ARTIFACT_READ_UNAVAILABLE"],
        [503, "CLOUD_AGENTS_UNAVAILABLE"],
        [503, "CLOUD_AGENTS_UNAVAILABLE"],
      ])
      // The fixed answer comes before any method, query, body or credential check (B08 source authority).
      const probe = await fetch(`${a.origin}/brain-download?probe=1`)
      expect([probe.status, probe.headers.get("cache-control"), await probe.json()]).toEqual([
        503,
        "no-store",
        { error: { code: "BRAIN_UPLOAD_UNAVAILABLE", message: BRAIN_FAILED } },
      ])
      expect({
        commands: traffic.commands,
        a: a.github.state.requests.length,
        b: b.github.state.requests.length,
        dispatches: a.github.state.dispatches.length,
      }).toEqual(switchedOff)
    } finally {
      a.policy.brain = true
      process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
    }
    expect(await redis.send("HGET", [records[0]!, "brainSha"])).toBeNull()
    // The same request with the switch back on: the switch alone made the difference.
    const first = await download(desktopRun.token)
    expect(first.status).toBe(200)
    expect(first.body.artifactKey).toEqual(brainKey)

    // An expired token: the deadline alone refuses, through the route and through the engine's clients.
    const before = a.time.now
    a.time.now = Math.max(comment.deadline, desktopRun.deadline, otherRepository.deadline)
    try {
      const expired = [await ordinaryKey(comment.token), await download(desktopRun.token)]
      expect(expired.map((answer) => [answer.status, answer.body.error?.code])).toEqual([
        [401, "MODEL_PLAN_RUN_EXPIRED"],
        [401, "MODEL_PLAN_RUN_EXPIRED"],
      ])
      expect(
        await artifactKey({
          env: { VECTOR_THREAD: "17" },
          holder: { runToken: () => comment.token },
          services: a.client,
        }),
      ).toEqual({ status: "expired" })
      expect(
        await brainDownload({
          env: { VECTOR_BRAIN_UPLOAD: u1.uploadId },
          holder: { runToken: () => desktopRun.token },
          services: a.client,
        }),
      ).toEqual({ status: "expired" })
    } finally {
      a.time.now = before
    }
    expect(await ordinaryKey(comment.token)).toEqual(own)
    expect(await download(desktopRun.token)).toEqual(first)

    // A same-account rebind of this repository ends both keys; the other repository's run keeps its own.
    expect((await a.bind()).generation).toBe(boundA.generation + 1)
    expect((await download(desktopRun.token)).status).toBe(401)
    expect((await ordinaryKey(comment.token)).status).toBe(401)
    expect((await a.send("heartbeat", desktopRun.token, { state: "running" })).status).toBe(401)
    expect(await ordinaryKey(otherRepository.token)).toEqual(other)

    // Revocation, then erasure (A57's order), removes every upload, record and binding of the account.
    const index = `vector:cloud-agents:brain:account:${a.account}`
    const prepare = () =>
      a.send("brain-prepare", a.ownerToken(), {
        repositoryId: a.github.repositoryId,
        sha256: u1.sha256,
        bytes: u1.bytes.length,
        includeBrain: true,
      })
    const u3 = await prepare()
    expect(u3.status).toBe(200)
    expect(await redis.send("SCARD", [index])).toBe(3)
    await persistentStore(["SET", `vector:cli-revoked:${a.account}`, "1"])
    const revoked = await prepare()
    expect([revoked.status, revoked.body.error?.code]).toEqual([401, "CLI_TOKEN_INVALID"])
    expect(await redis.send("SCARD", [index])).toBe(3)
    expect((await ordinaryKey(otherRepository.token)).status).toBe(401)
    await eraseCloudAgentsAccount(a.account)
    const erased = [
      ...[u1.uploadId, uploadB.uploadId, u3.body.uploadId].map((id) => `vector:cloud-agents:brain:${id}`),
      index,
      ...records.flatMap((record) => [record, `${record}:actor`]),
    ]
    expect(await Promise.all(erased.map((key) => redis.send("EXISTS", [key])))).toEqual(erased.map(() => 0))
    expect(await bindingFor(a.github.repositoryId)).toBeUndefined()
    expect(await bindingFor(b.github.repositoryId)).toBeUndefined()
    expect(await redis.send("KEYS", [`vector:cloud-agents:*${a.account}*`])).toEqual([])

    expectPublic([...a.bodies, ...b.bodies])
    expect(a.github.tokens.size).toBe(0)
    expect(b.github.tokens.size).toBe(0)
  }, 60_000)
}

/**
 * P6 (INV-P1, INV-P2) and provenance over every answer the journey received. Keys, envelopes and Vector's random
 * credentials are base64url, which could spell a short word such as "usd" by chance, so they are redacted first.
 */
function expectPublic(bodies: unknown[]) {
  const text = JSON.stringify(bodies, (name, value) =>
    typeof value === "string" &&
    (["key", "ciphertext", "nonce", "aad"].includes(name) || /^(?:vbc|vrt|vbu)_/.test(value))
      ? "[random]"
      : value,
  )
  expect(text).not.toMatch(
    /journey-owner@example\.test|"(?:account|plan|email|reason|share|brainSha|brainPublic|ticketHash|triggerSource|jti|wrapped|envelope)"|billing|subscription|dispute|fraud|past_due|payment|closing|\b(?:usd|cents?|credits?|price)\b|vector-(?:10|50|100|200)\b|(?:Plus|Pro|Max|Ultra) plan|[$€£]\s*\d/i,
  )
}

/** The workflow_dispatch inputs of the Codium workflow the builder writes (BT01). */
function declared() {
  const workflow = Bun.YAML.parse(
    buildAgentsWorkflow({
      mode: "codium",
      provider: "vector",
      model: "vector-plan",
      keys: [],
      autoReview: false,
      version: GithubAgents.MIN_AGENTS_CLI,
    }),
  ) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[] }> } } }
  return workflow.on.workflow_dispatch.inputs
}
