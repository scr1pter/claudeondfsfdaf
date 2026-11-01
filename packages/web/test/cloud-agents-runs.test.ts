import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { GithubAgents } from "../../core/src/github-agents"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import {
  bindingFor,
  createBindCode,
  peekBindCode,
  redeemAndBind,
  revokeBinding,
  suspendBinding,
} from "../../../api/_lib/cloud-agents-binding"
import type { CloudAgentAllowance } from "../../../api/_lib/cloud-agents-entitlement"
import { liveKey, reserveRun, settleRun, usedKey } from "../../../api/_lib/cloud-agents-ledger"
import {
  eraseCloudAgentsAccount,
  listCloudRuns,
  recordRunEnd,
  recordRunStart,
  type RunStart,
} from "../../../api/_lib/cloud-agents-runs"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { persistentStore } from "../../../api/_lib/persistent-store"
import { githubAppFixture } from "./github-app-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  if (!configured) {
    test.skip("Cloud run-record tests require disposable loopback VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Run records require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const prefix = "vector:cloud-agents:"
  const keys = new Set<string>()
  const commands: (readonly (string | number)[])[] = []
  const state = { down: false }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      expect(request.headers.get("authorization")).toBe("Bearer run-record-fixture")
      const command = (await request.json()) as (string | number)[]
      commands.push(command)
      if (command[0] === "EVAL") command.slice(3, 3 + Number(command[2])).forEach((key) => keys.add(String(key)))
      else if (command[0] !== "SCAN") keys.add(String(command[1]))
      if (state.down) return new Response(null, { status: 503 })
      return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
    },
  })
  const environment = [
    "NODE_ENV",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_ABUSE_SECRET",
    "VECTOR_CLI_TOKEN_SECRET",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, {
      NODE_ENV: "production",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "run-record-fixture",
      VECTOR_CLI_TOKEN_SECRET: "run-record-fixture-secret-at-least-32",
    })
  })
  beforeEach(() => {
    state.down = false
    process.env.VECTOR_ABUSE_SECRET = `run-record-${randomUUID()}`
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
    const account = randomUUID()
    const now = Date.now()
    const identity = {
      repository: "fixture-owner/project",
      repositoryId: String(100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]!),
      ownerId: "456",
      actor: "fixture-person",
      actorId: "789",
      ref: "refs/heads/main",
      repositoryVisibility: "public" as const,
    }
    const code = await createBindCode({ account, repository: identity.repository, now })
    const binding = await redeemAndBind({
      code: code.code,
      account,
      identity,
      workflowVersion: "3",
      takeover: { adminVerified: false, allowanceInactive: false },
      now,
    })
    const allowance: Extract<CloudAgentAllowance, { active: true }> = {
      active: true,
      plan: "vector-200",
      limits: { atOnce: 2, hours: 1000, longestRunMin: 5, scheduledPerDay: 10, runCeilingShare: 0.1 },
      allowanceSeconds: 3_600_000,
      meterEpoch: `p${now}`,
      periodEnd: now + 30 * 86_400_000,
      premiumModels: true,
    }
    let sequence = 1000
    async function start(input: Partial<RunStart> = {}) {
      const runId = String(sequence++)
      const record: RunStart = {
        account,
        generation: binding.generation,
        jti: randomBytes(16).toString("base64url"),
        rid: GithubAgents.runId(identity.repositoryId, runId, 1, runId),
        runId,
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        event: "issue_comment",
        source: "github-comment",
        purpose: "task",
        startedAt: now,
        actor: { login: identity.actor, id: identity.actorId },
        ...input,
      }
      const answer = await reserveRun({
        account: record.account,
        rid: record.rid,
        repositoryId: record.repositoryId,
        thread: "17",
        generation: record.generation,
        jti: record.jti,
        source: record.source,
        purpose: record.purpose,
        ...(record.trigger && record.trigger.purpose !== "scheduled"
          ? { trigger: { source: record.trigger.source, purpose: record.trigger.purpose } }
          : {}),
        allowance,
        now: record.startedAt,
      })
      if (!answer.ok) throw new Error(`Fixture reserve refused: ${JSON.stringify(answer)}`)
      record.startedAt = answer.startedAt
      await recordRunStart(record)
      return record
    }
    async function settle(
      record: RunStart,
      outcome: GithubAgents.Outcome = "changes",
      endedAt = record.startedAt + 1000,
    ) {
      expect(
        (await settleRun(record.account, record.rid, { jti: record.jti, epoch: allowance.meterEpoch })).settled,
      ).toBe(true)
      expect(await recordRunEnd(record.rid, outcome, endedAt, record)).toBe(true)
    }
    async function rebind(next: string, current = account) {
      const code = await createBindCode({ account: next, repository: identity.repository, now })
      return redeemAndBind({
        code: code.code,
        account: next,
        current,
        identity,
        workflowVersion: "3",
        takeover: { adminVerified: true, allowanceInactive: false },
        now: now + 1,
      })
    }
    return { account, now, identity, binding, allowance, start, settle, rebind }
  }

  async function hash(key: string) {
    const raw = (await redis.send("EVAL", ["return redis.call('HGETALL', KEYS[1])", "1", key])) as string[]
    return Object.fromEntries(raw.flatMap((value, index) => (index % 2 ? [] : [[value, raw[index + 1]]])))
  }

  test("run and actor storage matches the published inventory, and the API never returns internal account/token fields", async () => {
    const before = new Set((await redis.send("KEYS", [`${prefix}*`])) as string[])
    const f = await fixture()
    const issued = await createBindCode({ account: f.account, repository: f.identity.repository, now: f.now })
    expect(issued.code).toMatch(/^vbc_/)
    const codeKey = `${prefix}bind-code:${createHash("sha256").update(issued.code).digest("hex")}`
    expect(JSON.parse(String(await redis.send("GET", [codeKey])))).toEqual({
      account: f.account,
      repository: f.identity.repository,
      exp: f.now + 600_000,
    })
    expect(Number(await redis.send("TTL", [codeKey]))).toBeGreaterThan(570)
    const run = await f.start()
    const runKey = `${prefix}run:${run.rid}`
    expect(Object.keys(await hash(runKey)).sort()).toEqual(
      [
        "account",
        "event",
        "generation",
        "jti",
        "purpose",
        "repository",
        "repositoryId",
        "rid",
        "runUrl",
        "source",
        "startedAt",
      ].sort(),
    )
    expect(await hash(`${runKey}:actor`)).toEqual(run.actor)
    expect(Number(await redis.send("TTL", [runKey]))).toBeGreaterThan(90 * 86_400 - 30)
    expect(Number(await redis.send("TTL", [`${runKey}:actor`]))).toBeGreaterThan(90 * 86_400 - 30)
    const live = JSON.parse(String(await redis.send("HGET", [liveKey(f.account), run.rid])))
    expect(Object.keys(live).sort()).toEqual(
      ["startedAt", "deadline", "lastReport", "epoch", "repo", "thr", "src", "pur", "gen", "jti"].sort(),
    )
    expect(Object.keys(await hash(`${prefix}binding:${f.identity.repositoryId}`)).sort()).toEqual(
      [
        "account",
        "binderGithubId",
        "binderLogin",
        "boundAt",
        "defaultRef",
        "generation",
        "ownerId",
        "repository",
        "repositoryId",
        "visibility",
        "workflowVersion",
      ].sort(),
    )
    expect(await redis.send("EXISTS", [usedKey(f.account, f.allowance.meterEpoch)])).toBe(1)
    await f.settle(run)
    expect(Object.keys(await hash(runKey)).sort()).toEqual(
      [
        "account",
        "event",
        "generation",
        "jti",
        "purpose",
        "repository",
        "repositoryId",
        "rid",
        "runUrl",
        "source",
        "startedAt",
        "endedAt",
        "outcome",
        "verdict",
      ].sort(),
    )
    const rows = await listCloudRuns(f.account)
    expect(rows).toEqual([
      {
        rid: run.rid,
        repositoryId: run.repositoryId,
        repository: run.repository,
        runUrl: `https://github.com/${run.repository}/actions/runs/${run.runId}`,
        event: "issue_comment",
        source: "github-comment",
        purpose: "task",
        startedAt: run.startedAt,
        endedAt: run.startedAt + 1000,
        outcome: "changes",
        verdict: "pass",
        actor: run.actor,
      },
    ])
    expect(JSON.stringify(rows)).not.toMatch(
      /account|generation|jti|email|subscription|billing|payment|fraud|dispute|closing/,
    )
    expect(JSON.stringify(rows)).not.toContain(f.account)
    expect(JSON.stringify(rows)).not.toContain(run.jti)
    const active = await f.start({ startedAt: f.now + 2000 })
    const actualKeys = ((await redis.send("KEYS", [`${prefix}*`])) as string[]).filter((key) => !before.has(key)).sort()
    const expectedKeys = [
      `${prefix}binding:${f.identity.repositoryId}`,
      `${prefix}gen:${f.identity.repositoryId}`,
      `${prefix}bindings:${f.account}`,
      codeKey,
      usedKey(f.account, f.allowance.meterEpoch),
      liveKey(f.account),
      `${prefix}runs:${f.account}`,
      ...[run, active].flatMap((item) => [`${prefix}run:${item.rid}`, `${prefix}run:${item.rid}:actor`]),
    ].sort()
    expect(actualKeys).toEqual(expectedKeys)
    expect(await redis.send("SMEMBERS", [`${prefix}bindings:${f.account}`])).toEqual([f.identity.repositoryId])
    expect(await redis.send("GET", [`${prefix}gen:${f.identity.repositoryId}`])).toBe("1")
    expect(await redis.send("ZREVRANGE", [`${prefix}runs:${f.account}`, "0", "-1"])).toEqual([active.rid, run.rid])
    expect(Object.keys(await hash(liveKey(f.account)))).toEqual([active.rid])
    const inventory = await Bun.file(
      new URL("../../../docs/vector/build/vector-at-mention-spec.md", import.meta.url),
    ).text()
    for (const field of Object.keys(await hash(runKey)))
      expect(inventory.slice(inventory.indexOf("## 2.16"))).toContain(`\`${field}\``)
  })

  test.each([...GithubAgents.OUTCOME])(
    "settle derives %s verdict, is idempotent, and preserves actor expiry",
    async (outcome) => {
      const f = await fixture()
      const run = await f.start()
      const key = `${prefix}run:${run.rid}:actor`
      await redis.send("PEXPIRE", [key, "500000"])
      await f.settle(run, outcome)
      expect(await recordRunEnd(run.rid, "failed", run.startedAt + 2000, run)).toBe(false)
      expect((await listCloudRuns(f.account))[0]?.verdict).toBe(
        outcome === "changes" ? "pass" : ["draft", "failed"].includes(outcome) ? "fail" : "none",
      )
      expect(Number(await redis.send("PTTL", [key]))).toBeLessThanOrEqual(500000)
      await redis.send("PEXPIRE", [key, "0"])
      expect((await listCloudRuns(f.account))[0]).not.toHaveProperty("actor")
    },
  )

  test("renewal rotates record identity, and older mints or delayed settles cannot overwrite it", async () => {
    const f = await fixture()
    const first = await f.start()
    const actor = `${prefix}run:${first.rid}:actor`
    await redis.send("PEXPIRE", [actor, "500000"])
    const second = await f.start({ ...first, jti: randomBytes(16).toString("base64url"), startedAt: f.now + 1000 })
    expect(second.startedAt).toBe(first.startedAt)
    await expect(recordRunStart(first)).rejects.toMatchObject({ code: "CLOUD_AGENTS_UNAVAILABLE" })
    expect(await recordRunEnd(first.rid, "failed", f.now + 2000, first)).toBe(false)
    expect((await hash(`${prefix}run:${first.rid}`)).jti).toBe(second.jti)
    expect(Number(await redis.send("PTTL", [actor]))).toBeLessThanOrEqual(500000)
    await f.settle(second)
  })

  test("a takeover cannot expose another account's run through an old index or accept a delayed settle", async () => {
    const f = await fixture()
    const old = await f.start()
    const account = randomUUID()
    const next = await f.rebind(account)
    const current = await f.start({
      ...old,
      account,
      generation: next.generation,
      jti: randomBytes(16).toString("base64url"),
      startedAt: f.now + 1000,
      actor: { login: "new-person", id: "900" },
    })
    expect(await recordRunEnd(old.rid, "failed", f.now + 2000, old)).toBe(false)
    expect(await listCloudRuns(f.account)).toEqual([])
    expect((await listCloudRuns(account))[0]?.actor?.login).toBe("new-person")
    await persistentStore(["SET", `vector:cli-revoked:${f.account}`, "1"])
    await eraseCloudAgentsAccount(f.account)
    await suspendBinding(f.binding, "binder-left")
    expect(await redis.send("EXISTS", [`${prefix}binder-left:${f.account}`])).toBe(0)
    expect((await bindingFor(f.identity.repositoryId))?.account).toBe(account)
    expect((await listCloudRuns(account))[0]?.rid).toBe(current.rid)
    await f.settle(current)
  })

  test("records are newest first and capped at 200, while erasure also removes trimmed records", async () => {
    const f = await fixture()
    const records: RunStart[] = []
    for (let i = 0; i < 201; i++) {
      const run = await f.start({ startedAt: f.now + i * 1000 })
      await f.settle(run)
      records.push(run)
    }
    expect(Number(await redis.send("ZCARD", [`${prefix}runs:${f.account}`]))).toBe(200)
    expect((await listCloudRuns(f.account)).length).toBe(20)
    expect((await listCloudRuns(f.account, { limit: 2 })).map((run) => run.rid)).toEqual(
      records
        .slice(-2)
        .reverse()
        .map((run) => run.rid),
    )
    expect(await redis.send("EXISTS", [`${prefix}run:${records[0]!.rid}`])).toBe(1)
    await persistentStore(["SET", `vector:cli-revoked:${f.account}`, "1"])
    await eraseCloudAgentsAccount(f.account)
    expect(
      await redis.send(
        "EXISTS",
        records.flatMap((run) => [`${prefix}run:${run.rid}`, `${prefix}run:${run.rid}:actor`]),
      ),
    ).toBe(0)
    expect(await listCloudRuns(f.account)).toEqual([])
  })

  test("binder-left privacy survives unbind and takeover, regardless of public visibility", async () => {
    for (const mode of ["bound", "unbound", "takeover"]) {
      const f = await fixture()
      const run = await f.start()
      await suspendBinding(f.binding, "binder-left")
      if (mode === "unbound") await revokeBinding(f.identity.repositoryId, f.account)
      if (mode === "takeover") await f.rebind(randomUUID())
      const row = (await listCloudRuns(f.account))[0]!
      expect(row.rid).toBe(run.rid)
      expect(row).not.toHaveProperty("repository")
      expect(row).not.toHaveProperty("runUrl")
      expect(row).not.toHaveProperty("actor")
    }
  })

  test("only server-started dispatches retain the bounded trigger fields", async () => {
    const f = await fixture()
    const run = await f.start({
      event: "workflow_dispatch",
      source: "github-dispatch",
      trigger: { source: "github-dispatch", purpose: "incident" },
    })
    expect((await listCloudRuns(f.account))[0]?.trigger).toEqual({ source: "github-dispatch", purpose: "incident" })
    const raw = await hash(`${prefix}run:${run.rid}`)
    expect(raw.triggerSource).toBe("github-dispatch")
    expect(raw.triggerPurpose).toBe("incident")
    await expect(recordRunStart({ ...run, source: "github-comment", event: "issue_comment" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })

  test("erasure removes ledgers, codes, bindings and generation pointers while counters and another account survive", async () => {
    const f = await fixture()
    const other = await fixture()
    await f.start({ event: "schedule", source: "github-schedule", purpose: "scheduled" })
    const preserved = await other.start()
    await createBindCode({ account: f.account, repository: f.identity.repository, now: f.now })
    await expect(eraseCloudAgentsAccount(f.account)).rejects.toMatchObject({ code: "ACCOUNT_REVOCATION_REQUIRED" })
    await persistentStore(["SET", `vector:cli-revoked:${f.account}`, "1"])
    await eraseCloudAgentsAccount(f.account)
    expect(await bindingFor(f.identity.repositoryId)).toBeUndefined()
    expect(await redis.send("GET", [`${prefix}gen:${f.identity.repositoryId}`])).toBe("2")
    expect(
      await redis.send("EXISTS", [
        liveKey(f.account),
        usedKey(f.account, f.allowance.meterEpoch),
        `${prefix}bindings:${f.account}`,
        `${prefix}runs:${f.account}`,
      ]),
    ).toBe(0)
    expect((await listCloudRuns(other.account))[0]?.rid).toBe(preserved.rid)
    const remaining = (await redis.send("KEYS", [`${prefix}*${f.account}*`])) as string[]
    expect(remaining).toEqual([])
    for (const key of (await redis.send("KEYS", [`${prefix}bind-code:*`])) as string[]) {
      expect(JSON.parse(String(await redis.send("GET", [key]))).account).not.toBe(f.account)
    }
  })

  test("attributable binder caches are erased after takeover even with no run; other-account caches survive", async () => {
    await using github = await githubAppFixture({ store: persistentStore })
    await using other = await githubAppFixture({ store: persistentStore })
    const account = randomUUID()
    const otherAccount = randomUUID()
    const identity = {
      repository: "fixture-owner/project",
      repositoryId: github.repositoryId,
      ownerId: "456",
      actor: "fixture-person",
      actorId: "789",
      ref: "refs/heads/main",
    }
    const code = await createBindCode({ account, repository: identity.repository, now: Date.now() })
    const binding = await redeemAndBind({
      code: code.code,
      account,
      identity,
      workflowVersion: "3",
      takeover: { adminVerified: false, allowanceInactive: false },
      now: Date.now(),
    })
    for (const [fixture, owner, generation] of [
      [github, account, binding.generation],
      [other, otherAccount, 1],
    ] as const) {
      fixture.state.job.name = "Vector agent"
      expect(
        await fixture.app.verifyRun(await fixture.verify(await fixture.makeToken("mint"), "mint"), {
          job: "agent",
          thread: "17",
          commentId: 123,
          binder: { githubId: "790", login: "fixture-binder" },
          account: owner,
          defaultRef: "refs/heads/main",
          generation,
        }),
      ).toEqual({ installed: true, binder: "ok" })
    }
    const newCode = await createBindCode({ account: otherAccount, repository: identity.repository, now: Date.now() })
    await redeemAndBind({
      code: newCode.code,
      account: otherAccount,
      current: account,
      identity,
      workflowVersion: "3",
      takeover: { adminVerified: true, allowanceInactive: false },
      now: Date.now(),
    })
    await persistentStore(["SET", `vector:cli-revoked:${account}`, "1"])
    await eraseCloudAgentsAccount(account)
    expect(await redis.send("GET", [`${prefix}binder-ok:${github.repositoryId}`])).toBeNull()
    expect(JSON.parse(String(await redis.send("GET", [`${prefix}binder-ok:${other.repositoryId}`]))).account).toBe(
      otherAccount,
    )
    expect((await bindingFor(github.repositoryId))?.account).toBe(otherAccount)
  })

  test("revocation inside atomic redemption and run writes stops delayed work after erasure", async () => {
    const f = await fixture()
    const run = await f.start()
    const code = await createBindCode({ account: f.account, repository: f.identity.repository, now: f.now })
    await persistentStore(["SET", `vector:cli-revoked:${f.account}`, "1"])
    await expect(
      createBindCode({ account: f.account, repository: f.identity.repository, now: f.now }),
    ).rejects.toMatchObject({ code: "CLI_TOKEN_INVALID" })
    await expect(
      redeemAndBind({
        code: code.code,
        account: f.account,
        current: f.account,
        identity: f.identity,
        workflowVersion: "3",
        takeover: { adminVerified: false, allowanceInactive: false },
        now: f.now,
      }),
    ).rejects.toMatchObject({ code: "BIND_CODE_INVALID" })
    expect((await peekBindCode(code.code, f.identity, f.now)).account).toBe(f.account)
    await expect(recordRunStart(run)).rejects.toMatchObject({ code: "CLOUD_AGENTS_UNAVAILABLE" })
    expect(await recordRunEnd(run.rid, "changes", f.now + 1000, run)).toBe(false)
    await eraseCloudAgentsAccount(f.account)
    await expect(
      redeemAndBind({
        code: code.code,
        account: f.account,
        identity: f.identity,
        workflowVersion: "3",
        takeover: { adminVerified: false, allowanceInactive: false },
        now: f.now,
      }),
    ).rejects.toMatchObject({ code: "BIND_CODE_INVALID" })
    await expect(recordRunStart(run)).rejects.toMatchObject({ code: "CLOUD_AGENTS_UNAVAILABLE" })
    expect(await recordRunEnd(run.rid, "changes", f.now + 1000, run)).toBe(false)
    expect(await redis.send("EXISTS", [`${prefix}run:${run.rid}`, `${prefix}run:${run.rid}:actor`])).toBe(0)
  })

  test("legacy binder caches remain unattributed and retain only their existing one-hour expiry", async () => {
    const f = await fixture()
    const key = `${prefix}binder-ok:${f.identity.repositoryId}`
    await persistentStore(["SET", key, JSON.stringify({ githubId: "790", generation: 1 }), "EX", 3600])
    await persistentStore(["SET", `vector:cli-revoked:${f.account}`, "1"])
    await eraseCloudAgentsAccount(f.account)
    expect(await redis.send("GET", [key])).toBe(JSON.stringify({ githubId: "790", generation: 1 }))
    expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(3590)
    expect(Number(await redis.send("TTL", [key]))).toBeLessThanOrEqual(3600)
    await redis.send("PERSIST", [key])
    await expect(eraseCloudAgentsAccount(f.account)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    await redis.send("EXPIRE", [key, "3600"])
  })

  test("a delayed GitHub permission check cannot recreate its binder cache after account erasure", async () => {
    const account = randomUUID()
    let intercepted = false
    await using github = await githubAppFixture({
      store: async (command) => {
        if (command[0] === "EVAL" && String(command[3]).startsWith(`${prefix}binder-ok:`)) {
          intercepted = true
          await persistentStore(["SET", `vector:cli-revoked:${account}`, "1"])
          await eraseCloudAgentsAccount(account)
        }
        return persistentStore(command)
      },
    })
    github.state.job.name = "Vector agent"
    await expect(
      github.app.verifyRun(await github.verify(await github.makeToken("mint"), "mint"), {
        job: "agent",
        thread: "17",
        commentId: 123,
        binder: { githubId: "790", login: "fixture-binder" },
        account,
        defaultRef: "refs/heads/main",
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(intercepted).toBe(true)
    expect(await redis.send("EXISTS", [`${prefix}binder-ok:${github.repositoryId}`])).toBe(0)
    expect(github.tokens.size).toBe(0)
  })

  test("malformed records and store outages fail closed, and invalid inputs never write", async () => {
    const f = await fixture()
    const run = await f.start()
    await persistentStore(["HSET", `${prefix}run:${run.rid}`, "unexpected", "field"])
    await expect(listCloudRuns(f.account)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    await redis.send("HDEL", [`${prefix}run:${run.rid}`, "unexpected"])
    const before = commands.length
    await expect(recordRunStart({ ...run, runId: "99999" })).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await expect(listCloudRuns(f.account, { limit: 201 })).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(commands.length).toBe(before)
    state.down = true
    await expect(listCloudRuns(f.account)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  })

  test("GET runs authenticates the owning desktop account and uses the neutral public shape", async () => {
    const f = await fixture()
    const run = await f.start()
    const api = createCloudAgentsApi({
      entitlement: async () => {
        throw new Error("Runs must not query billing")
      },
    })
    const server = createServer((request, response) => {
      void api.runs(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("HTTP fixture failed")
    try {
      for (const account of [f.account, randomUUID()]) {
        const token = mintCliToken({ id: account, email: "fixture@example.invalid" }, Date.now(), "desktop").token
        const response = await fetch(`http://127.0.0.1:${address.port}/runs`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("referrer-policy")).toBe("no-referrer")
        const body = await response.json()
        expect(body.runs.map((item: { rid: string }) => item.rid)).toEqual(account === f.account ? [run.rid] : [])
        expect(JSON.stringify(body)).not.toContain(account)
        expect(JSON.stringify(body)).not.toContain(run.jti)
        expect(JSON.stringify(body)).not.toMatch(/@example|billing|payment|subscription/)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
