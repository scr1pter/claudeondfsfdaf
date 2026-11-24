import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ABUSE_RATE_LIMIT_SCRIPT } from "../../../api/_lib/abuse"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { mintRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { githubApp } from "../../../api/_lib/github-app"
import { githubOidcAudiences, type GithubIdentity } from "../../../api/_lib/github-oidc"

// B08's thread binding (owner ruling R1, option A) without Redis: the pure rule, then mint and artifact-key over HTTP
// with every outside piece a fake. The rate-limit store is a loopback fake that answers every counter with 1, the
// binding store answers one fixed binding, and the App, the identity check and the allowance record their calls. The
// atomic Lua paths are exercised against disposable Redis by cloud-agents-mint-api.test.ts in vector-at-mention.yml.

const account = "11111111-1111-4111-8111-111111111111"
const NOW = Date.now()

function identity(change: Partial<GithubIdentity> = {}): GithubIdentity {
  return {
    repository: "owner/project",
    repositoryId: "123",
    owner: "owner",
    ownerId: "7",
    actor: "writer",
    actorIsBot: false,
    actorId: "9",
    runId: "1000",
    runAttempt: "1",
    checkRunId: "1001",
    sha: "a".repeat(40),
    workflowSha: "a".repeat(40),
    ref: "refs/heads/main",
    workflowRef: "owner/project/.github/workflows/vector.yml@refs/heads/main",
    jobWorkflowRef: undefined,
    event: "issue_comment",
    subject: "repo:owner/project:ref:refs/heads/main",
    jti: "fixture-oidc-jti",
    expiresAt: Math.floor(NOW / 1000) + 300,
    audience: githubOidcAudiences.mint,
    runnerEnvironment: "github-hosted",
    refProtected: false,
    repositoryVisibility: "private",
    pullRequest: undefined,
    headRef: undefined,
    baseRef: undefined,
    ...change,
  }
}

const review17 = {
  event: "pull_request_review_comment",
  ref: "refs/pull/17/merge",
  workflowRef: "owner/project/.github/workflows/vector.yml@refs/pull/17/merge",
  pullRequest: 17,
  headRef: "fix",
  baseRef: "main",
} satisfies Partial<GithubIdentity>

type ThreadBody = { thread: string; purpose: "task" | "review"; pullRequest?: number }

describe("runThreadAllowed", () => {
  // Loaded when a test runs, so this file still loads (and its HTTP cases still run) against a build without the rule.
  const allowed = async (change: Partial<GithubIdentity>, body: ThreadBody) => {
    const { runThreadAllowed } = await import("../../../api/_lib/cloud-agents-api")
    return runThreadAllowed(identity(change), body)
  }

  test("a schedule names only a well-formed schedule thread", async () => {
    const schedule = { event: "schedule" }
    expect(await allowed(schedule, { thread: "schedule-0a1b2c3d", purpose: "task" })).toBe(true)
    for (const thread of ["17", "dispatch-1000", "schedule-0A1B2C3D", "schedule-0a1b2c3", "schedule-0a1b2c3d4"])
      expect(await allowed(schedule, { thread, purpose: "task" })).toBe(false)
  })

  test("a dispatch names its own run; only a person's dispatched review names its pull request", async () => {
    const dispatch = { event: "workflow_dispatch" }
    expect(await allowed(dispatch, { thread: "dispatch-1000", purpose: "task" })).toBe(true)
    expect(await allowed(dispatch, { thread: "dispatch-1000", purpose: "review" })).toBe(true)
    // Another conversation: an issue thread, another run's dispatch, a schedule's thread.
    for (const thread of ["5", "dispatch-999", "dispatch-10000", "schedule-0a1b2c3d"])
      expect(await allowed(dispatch, { thread, purpose: "task" })).toBe(false)
    expect(await allowed(dispatch, { thread: "5", purpose: "task", pullRequest: 5 })).toBe(false)
    expect(await allowed(dispatch, { thread: "5", purpose: "review", pullRequest: 5 })).toBe(true)
    expect(await allowed(dispatch, { thread: "5", purpose: "review", pullRequest: 6 })).toBe(false)
    expect(await allowed(dispatch, { thread: "5", purpose: "review" })).toBe(false)
    // Vector's App bot only ever runs a ticket's task on its own dispatch thread.
    const bot = { event: "workflow_dispatch", actor: "vector-fixture[bot]", actorIsBot: true }
    expect(await allowed(bot, { thread: "dispatch-1000", purpose: "task" })).toBe(true)
    expect(await allowed(bot, { thread: "5", purpose: "review", pullRequest: 5 })).toBe(false)
    expect(await allowed(bot, { thread: "dispatch-999", purpose: "task" })).toBe(false)
  })

  test("an issue or a comment names a number; a review comment names its signed pull request", async () => {
    for (const event of ["issue_comment", "issues"]) {
      expect(await allowed({ event }, { thread: "17", purpose: "task" })).toBe(true)
      for (const thread of ["dispatch-1000", "schedule-0a1b2c3d"])
        expect(await allowed({ event }, { thread, purpose: "task" })).toBe(false)
    }
    expect(await allowed(review17, { thread: "17", purpose: "review", pullRequest: 17 })).toBe(true)
    expect(await allowed(review17, { thread: "18", purpose: "review", pullRequest: 18 })).toBe(false)
    expect(await allowed(review17, { thread: "dispatch-1000", purpose: "task" })).toBe(false)
    expect(await allowed({ ...review17, pullRequest: undefined }, { thread: "17", purpose: "review" })).toBe(false)
  })

  test("any other event names no thread", async () => {
    for (const event of ["push", "pull_request", "pull_request_target", "workflow_run"])
      expect(await allowed({ event }, { thread: "17", purpose: "task" })).toBe(false)
  })
})

describe("over HTTP", () => {
  const variables = [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_ABUSE_SECRET",
    "VECTOR_RUN_TOKEN_SECRET",
    "VECTOR_RUN_ARTIFACT_SECRET",
    "MODEL_PLANS_ENABLED",
    "VECTOR_GITHUB_BRAIN_ENABLED",
  ]
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
  const binding = {
    repositoryId: "123",
    ownerId: "7",
    repository: "owner/project",
    account,
    visibility: "private",
    defaultRef: "refs/heads/main",
    generation: "1",
    binderGithubId: "9",
    binderLogin: "writer",
    workflowVersion: "3",
    boundAt: String(NOW - 86_400_000),
    installationId: "600",
  }
  const calls = {
    kv: [] as string[],
    store: [] as string[],
    app: [] as string[],
    entitlement: 0,
  }
  // The identity token is a key into this table, so each request names its own event.
  const identities = new Map<string, GithubIdentity>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer thread-http-fixture")
      const command = (await request.json()) as unknown[]
      if (command[0] === "GET" && command[1] === `vector:cli-revoked:${account}`) {
        calls.kv.push("revoked")
        return Response.json({ result: null })
      }
      if (command[0] === "EVAL" && command[1] === ABUSE_RATE_LIMIT_SCRIPT) {
        calls.kv.push(String(command[3]).split(":")[2] ?? "")
        return Response.json({ result: [1, 300] })
      }
      calls.kv.push(`unexpected ${String(command[0])}`)
      return new Response(null, { status: 500 })
    },
  })
  const api = createCloudAgentsApi({
    now: () => NOW,
    verify: async (token) => {
      const found = identities.get(token)
      if (!found) throw new Error("fixture has no identity for this token")
      return found
    },
    store: async (command) => {
      const keys = Number(command[2])
      const key = String(command[3])
      if (command[0] === "EVAL" && keys === 1 && key === "vector:cloud-agents:binding:123") {
        calls.store.push("binding")
        return [Object.entries(binding).flat()]
      }
      // requireLive's one check of the token's binding, generation, live run and revocation.
      if (command[0] === "EVAL" && keys === 4) {
        calls.store.push("run-check")
        return "ok"
      }
      if (command[0] === "EVAL" && keys === 1 && key === `vector:cloud-agents:live:${account}`) {
        calls.store.push("live-run")
        return null
      }
      calls.store.push(`unexpected ${String(command[0])} ${key}`)
      throw new Error("fixture store does not answer this command")
    },
    revokedBefore: async () => undefined,
    app: {
      ...githubApp,
      configuration: () => ({
        available: true,
        installUrl: "https://github.com/apps/vector-fixture/installations/new",
      }),
      verifyRun: async () => {
        calls.app.push("verifyRun")
        return { installed: true as const, binder: "ok" as const }
      },
    },
    // Past the thread check, the allowance answers that the service is off: no OIDC proof is consumed and nothing is
    // reserved, so each allowed case ends at 503 MODEL_PLANS_DISABLED.
    entitlement: async () => {
      calls.entitlement++
      return { active: false as const, reason: "service-off" as const }
    },
  })
  const handlers = { mint: api.mint, artifactKey: api.artifactKey }
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1) as keyof typeof handlers
    void handlers[route](request, response)
  })
  const fixture = { origin: "" }

  beforeAll(async () => {
    Object.assign(process.env, {
      MODEL_PLANS_ENABLED: "true",
      VECTOR_GITHUB_BRAIN_ENABLED: "true",
      KV_REST_API_URL: upstream.url.origin,
      KV_REST_API_TOKEN: "thread-http-fixture",
      VECTOR_ABUSE_SECRET: "fixture-thread-http-abuse-32-characters",
      VECTOR_RUN_TOKEN_SECRET: "fixture-thread-http-run-token-32-characters",
      VECTOR_RUN_ARTIFACT_SECRET: "fixture-thread-http-artifact-32-characters",
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture did not listen")
    fixture.origin = `http://127.0.0.1:${address.port}`
  })
  beforeEach(() => {
    calls.kv = []
    calls.store = []
    calls.app = []
    calls.entitlement = 0
    identities.clear()
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    upstream.stop(true)
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  })

  async function post(route: keyof typeof handlers, token: string, body: unknown) {
    const response = await fetch(`${fixture.origin}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as { error?: { code?: string }; key?: string } }
  }

  let tokens = 0
  /** One mint by a run of `change`'s event; what it answered and which steps it reached. */
  async function mint(change: Partial<GithubIdentity>, body: Record<string, unknown>) {
    const token = `oidc-${++tokens}`
    identities.set(token, identity(change))
    calls.kv = []
    calls.store = []
    calls.app = []
    calls.entitlement = 0
    const answer = await post("mint", token, { workflowVersion: "3", ...body })
    return {
      status: answer.status,
      code: answer.body.error?.code,
      app: calls.app.length,
      entitlement: calls.entitlement,
      store: [...calls.store],
      unexpected: calls.kv.filter((call) => call.startsWith("unexpected")),
    }
  }

  const dispatch = { event: "workflow_dispatch" }
  const refusedBeforeTheApp = {
    status: 403,
    code: "EVENT_NOT_ALLOWED",
    app: 0,
    entitlement: 0,
    store: ["binding"],
    unexpected: [],
  }
  const reachedTheAllowance = {
    status: 503,
    code: "MODEL_PLANS_DISABLED",
    app: 1,
    entitlement: 1,
    store: ["binding"],
    unexpected: [],
  }

  test("a run asking for another conversation is refused before the App, the allowance, OIDC and the reservation", async () => {
    const refused: [Partial<GithubIdentity>, Record<string, unknown>][] = [
      // A writer's task dispatch asking for issue thread 5, another run's dispatch thread, or a schedule's thread.
      [dispatch, { purpose: "task", thread: "5" }],
      [dispatch, { purpose: "task", thread: "dispatch-999" }],
      [dispatch, { purpose: "task", thread: "schedule-0a1b2c3d" }],
      // A dispatched review asking for a thread that is not its pull request.
      [dispatch, { purpose: "review", thread: "5", pullRequest: 6 }],
      [dispatch, { purpose: "review", thread: "5" }],
      // A schedule asking for an issue thread or a dispatch thread.
      [{ event: "schedule" }, { purpose: "task", thread: "17" }],
      [{ event: "schedule" }, { purpose: "task", thread: "dispatch-1000" }],
      // A comment asking for a schedule's or a dispatch's thread.
      [{ event: "issue_comment" }, { purpose: "task", thread: "schedule-0a1b2c3d", commentId: 123 }],
      [{ event: "issues" }, { purpose: "task", thread: "dispatch-1000" }],
      // A review comment asking for another pull request than its signed merge ref names.
      [review17, { purpose: "review", thread: "18", pullRequest: 18, commentId: 123 }],
    ]
    for (const [change, body] of refused)
      expect({ case: [change.event, body.thread], ...(await mint(change, body)) }).toEqual({
        case: [change.event, body.thread],
        ...refusedBeforeTheApp,
      })
  })

  test("each event's own thread passes the check and reaches the App and the allowance", async () => {
    const passing: [Partial<GithubIdentity>, Record<string, unknown>][] = [
      [dispatch, { purpose: "task", thread: "dispatch-1000" }],
      [dispatch, { purpose: "review", thread: "5", pullRequest: 5 }],
      [{ event: "schedule" }, { purpose: "task", thread: "schedule-0a1b2c3d" }],
      [{ event: "issue_comment" }, { purpose: "task", thread: "17", commentId: 123 }],
      [{ event: "issues" }, { purpose: "task", thread: "17" }],
      [review17, { purpose: "review", thread: "17", pullRequest: 17, commentId: 123 }],
    ]
    for (const [change, body] of passing)
      expect({ case: [change.event, body.thread], ...(await mint(change, body)) }).toEqual({
        case: [change.event, body.thread],
        ...reachedTheAllowance,
      })
  })

  test("artifact-key refuses a review token before its run limit and live-run read; a task token passes on", async () => {
    const token = (pur: "task" | "review") =>
      mintRunToken({
        sub: account,
        rid: GithubAgents.runId("123", "1000", "1", "1001"),
        repo: "123",
        thr: "dispatch-1000",
        gen: 1,
        src: "github-dispatch",
        pur,
        epoch: "p1793491200000",
        dl: NOW + 1_800_000,
        iat: NOW,
        jti: pur === "review" ? "R".repeat(22) : "T".repeat(22),
        cs: 0.1,
      }).token

    const reviewing = await post("artifactKey", token("review"), { thread: "dispatch-1000" })
    expect({ status: reviewing.status, code: reviewing.body.error?.code, key: reviewing.body.key }).toEqual({
      status: 403,
      code: "ARTIFACT_KEY_NOT_ALLOWED",
      key: undefined,
    })
    expect(calls.store).toEqual(["run-check"])
    expect(calls.kv).toEqual(["cloud-agents-ip"])

    calls.kv = []
    calls.store = []
    // The task token is past the review gate: its run limit is counted and its live run read, which the fixture has
    // not stored, so it ends at 401.
    const task = await post("artifactKey", token("task"), { thread: "dispatch-1000" })
    expect({ status: task.status, code: task.body.error?.code, key: task.body.key }).toEqual({
      status: 401,
      code: "MODEL_PLAN_RUN_EXPIRED",
      key: undefined,
    })
    expect(calls.store).toEqual(["run-check", "live-run"])
    expect(calls.kv).toEqual(["cloud-agents-ip", "cloud-agents-artifact-key-run"])
  })
})
