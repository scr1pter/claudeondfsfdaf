import { afterAll, beforeAll, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createServer } from "node:http"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { bindingFor } from "../../../api/_lib/cloud-agents-binding"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { cloudAgentSecondsUsed, cloudAgentsGatewayHook, liveRun } from "../../../api/_lib/cloud-agents-ledger"
import { cloudAgentsRunVerifier, readRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { listCloudRuns } from "../../../api/_lib/cloud-agents-runs"
import { requireModelPlanCaller } from "../../../api/_lib/model-plan-caller"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

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
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/")
      expect(request.headers.get("authorization")).toBe("Bearer journey-fixture-kv")
      const command = (await request.json()) as (string | number)[]
      const offset = command[0] === "EVAL" ? 3 : 1
      const count = command[0] === "EVAL" ? Number(command[2]) : 1
      command.slice(offset, offset + count).forEach((key) => keys.add(String(key)))
      return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
    },
  })
  const environment = [
    "NODE_ENV",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_ABUSE_SECRET",
    "VECTOR_RUN_TOKEN_SECRET",
    "VECTOR_CLI_TOKEN_SECRET",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, {
      NODE_ENV: "production",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "journey-fixture-kv",
      VECTOR_ABUSE_SECRET: `journey-fixture-${crypto.randomUUID()}`,
      VECTOR_RUN_TOKEN_SECRET: "journey-run-fixture-secret-32-characters",
      VECTOR_CLI_TOKEN_SECRET: "journey-cli-fixture-secret-32-characters",
    })
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  test("signed bind to gateway activity, settlement and history share one run authority; rebind ends the next run", async () => {
    await using github = await githubAppFixture({ store: persistentStore })
    github.state.binder = { ...github.state.run.actor }
    github.state.permission = "admin"
    github.state.binderPermission = "admin"
    const account = crypto.randomUUID()
    const time = { now: Date.now() }
    const startedAt = time.now
    const allowance: CloudAgentAllowance = {
      active: true,
      plan: "vector-100",
      limits: { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
      allowanceSeconds: 144_000,
      meterEpoch: `journey:${startedAt}`,
      periodEnd: startedAt + 86_400_000,
      premiumModels: true,
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
      entitlement: async () => allowance,
    })
    const handlers = {
      code: api.bindCode,
      bind: api.bind,
      mint: api.mint,
      heartbeat: api.heartbeat,
      settle: api.settle,
      runs: api.runs,
    }
    const server = createServer((request, response) => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
      void handlers[route](request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Journey server could not bind")
    const origin = `http://127.0.0.1:${address.port}`
    const publicBodies: unknown[] = []
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
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      publicBodies.push(answer)
      return { status: response.status, body: answer }
    }
    const owner = (id: string) => mintCliToken({ id, email: "journey-owner@example.test" }, time.now, "desktop").token
    async function bind(id: string) {
      github.state.job.name = "Vector bind"
      github.state.run.event = "workflow_dispatch"
      const code = await send("code", owner(id), {
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
    async function mint(checkRunId = "1001") {
      github.state.job.name = "Vector agent"
      github.state.run.event = "issue_comment"
      const minted = await send("mint", await github.makeToken("mint", { check_run_id: checkRunId }), {
        purpose: "task",
        thread: "17",
        workflowVersion: "3",
        commentId: 123,
      })
      expect(minted.status).toBe(200)
      return minted.body
    }
    try {
      const bound = await bind(account)
      expect((await bindingFor(github.repositoryId))?.account).toBe(account)
      const minted = await mint()
      const claims = readRunToken(minted.token, time.now)
      expect(claims).toMatchObject({ sub: account, repo: github.repositoryId, gen: bound.generation, thr: "17" })
      time.now += 10_000
      expect(await send("heartbeat", minted.token, { state: "running" })).toMatchObject({
        status: 200,
        body: { ok: true, stop: false },
      })

      // The real static registration is exercised too; this journey never installs a replacement verifier.
      const verified = await cloudAgentsRunVerifier.verify(minted.token)
      const caller = await requireModelPlanCaller(
        { headers: { authorization: `Bearer ${minted.token}` } },
        fetcher,
        time.now,
      )
      expect(caller).toEqual(verified)
      expect(caller).toMatchObject({
        account: { id: account },
        kind: "run",
        purpose: "cloud-agents",
        run: { id: minted.runId, source: "github-comment", service: "cloud-agents" },
      })
      await cloudAgentsGatewayHook.afterSettle(caller, { endedAt: startedAt + 50_000 })
      expect((await liveRun(account, minted.runId))?.lastRequest).toBe(startedAt + 50_000)
      time.now = startedAt + 70_000
      expect(await send("settle", minted.token, { outcome: "changes" })).toMatchObject({
        status: 200,
        body: { ok: true },
      })
      expect(await cloudAgentSecondsUsed(account, claims.epoch, time.now)).toBe(50)
      const history = await send("runs", owner(account))
      expect(history.status).toBe(200)
      expect(history.body.runs).toHaveLength(1)
      expect(history.body.runs[0]).toMatchObject({
        rid: minted.runId,
        outcome: "changes",
        verdict: "pass",
        source: "github-comment",
      })
      expect(await listCloudRuns(account)).toEqual(history.body.runs)
      expect(await liveRun(account, minted.runId)).toBeUndefined()
      await expect(cloudAgentsRunVerifier.verify(minted.token)).rejects.toMatchObject({ statusCode: 401 })

      github.state.extraJobs.push({
        ...github.state.job,
        id: 2001,
        check_run_url: "https://api.github.com/repos/fixture-owner/project/check-runs/1002",
      })
      const next = await mint("1002")
      expect((await cloudAgentsRunVerifier.verify(next.token)).account.id).toBe(account)
      const rebound = await bind(crypto.randomUUID())
      expect(rebound.generation).toBeGreaterThan(bound.generation)
      await expect(cloudAgentsRunVerifier.verify(next.token)).rejects.toMatchObject({ statusCode: 401 })
      await expect(
        requireModelPlanCaller({ headers: { authorization: `Bearer ${next.token}` } }, fetcher, time.now),
      ).rejects.toMatchObject({ statusCode: 401 })
      expect((await send("heartbeat", next.token, { state: "running" })).status).toBe(401)
      expect(JSON.stringify(publicBodies)).not.toMatch(
        /journey-owner@example\.test|"(?:account|plan|email|brainSha|brainPublic|ticketHash)"|dispute|fraud|past_due|payment_failed|[$€£]\s*\d/i,
      )
      expect(github.tokens.size).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)
}
