import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  artifactKey,
  bindRepository,
  brainDownload,
  heartbeat,
  mintRunToken,
  settle,
  verifyGithubRun,
  type Services,
} from "../../src/cli/cmd/github.cloud"
import { createGithubSecrets, readRunToken, runTokenPath, writeRunToken } from "../../src/cli/cmd/github.secrets"

const TOKEN = "vrt_e30.c2ln"
const CLI = "vct_e30.c2ln"
const NOW = Date.UTC(2026, 10, 1)
const success = {
  token: TOKEN,
  runId: "gh-301-401-1-601",
  deadline: NOW + 3_600_000,
  heartbeatSeconds: 60,
  idleSeconds: 600,
}
const failure = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "PRIVATE SERVER DIAGNOSTIC", ...extra },
})

async function fixture(
  answer: (index: number, request: Request) => Response | Promise<Response> = () => Response.json(success),
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vector-cloud-"))
  let elapsed = 0
  const requests: { path: string; body: unknown; authorization: string | null }[] = []
  const masks: string[] = []
  const waits: number[] = []
  const notices: string[] = []
  const audiences: string[] = []
  const beforeWrite: boolean[] = []
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    VECTOR_MODE: "codium",
    VECTOR_THREAD: "7",
    VECTOR_WORKFLOW_VERSION: "3",
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: path.join(directory, "output"),
    GITHUB_ENV: path.join(directory, "environment"),
    GITHUB_REPOSITORY: "fixture/repository",
    GITHUB_REPOSITORY_ID: "301",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_PATH: path.join(directory, "event"),
    VECTOR_BIND_CODE: "vbc_" + "a".repeat(43),
  }
  await fs.writeFile(env.GITHUB_OUTPUT!, "")
  await fs.writeFile(env.GITHUB_ENV!, "")
  await fs.writeFile(env.GITHUB_EVENT_PATH!, JSON.stringify({ repository: { default_branch: "main" } }))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.clone().json(),
        authorization: request.headers.get("authorization"),
      })
      return answer(requests.length, request)
    },
  })
  const origin = server.url.origin
  const services: Services = {
    oidc: async (audience) => {
      audiences.push(audience)
      return `oidc.${audiences.length}.proof`
    },
    mask: (value) => {
      masks.push(value)
      if (value === TOKEN) beforeWrite.push(existsSync(runTokenPath(env)))
    },
    request: async (url, init) => {
      expect(url.startsWith("https://vectordev.ai/api/cloud-agents/")).toBe(true)
      expect(init.redirect).toBe("error")
      expect(init.credentials).toBe("omit")
      return fetch(origin + new URL(url).pathname, init)
    },
    now: () => NOW + elapsed,
    monotonic: () => elapsed,
    wait: async (ms) => {
      waits.push(ms)
      elapsed += ms
    },
    notice: (message) => notices.push(message),
  }
  return {
    directory,
    env,
    services,
    requests,
    masks,
    waits,
    notices,
    audiences,
    beforeWrite,
    advance: (ms: number) => {
      elapsed += ms
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
async function* channel(value: unknown) {
  yield JSON.stringify(value) + "\n"
}
const runChannel = { v: 1, githubToken: "fixture-github-token", runToken: TOKEN, keys: {} }
const ownChannel = {
  v: 1,
  githubToken: "fixture-github-token",
  cliToken: CLI,
  keys: { AWS_ACCESS_KEY_ID: "fixture-id", AWS_BEARER_TOKEN_BEDROCK: "fixture-key" },
}
const channelEnv = (mode = "codium"): Record<string, string | undefined> => ({
  GITHUB_ACTIONS: "true",
  VECTOR_MODE: mode,
  VECTOR_SECRET_CHANNEL: "stdin",
  GITHUB_TOKEN: "os-github",
  VECTOR_CLI_TOKEN: CLI,
  VECTOR_SECRET_ENV_NAMES: "CUSTOM_CREDENTIAL",
  CUSTOM_CREDENTIAL: "os-private",
})

describe("cloud command HTTP boundary", () => {
  test.skipIf(process.platform === "win32")(
    "mint masks before exclusive private storage and emits no credential through file commands",
    async () => {
      await using f = await fixture()
      expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("ok")
      expect(f.beforeWrite).toEqual([false])
      expect(f.masks).toEqual(["oidc.1.proof", TOKEN])
      expect(await fs.readFile(runTokenPath(f.env), "utf8")).toBe(TOKEN)
      expect((await fs.stat(runTokenPath(f.env))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.dirname(runTokenPath(f.env)))).mode & 0o777).toBe(0o700)
      expect(await fs.readFile(f.env.GITHUB_ENV!, "utf8")).toBe(
        `VECTOR_RUN_DEADLINE=${success.deadline}\nVECTOR_RUN_ID=${success.runId}\n`,
      )
      expect(await fs.readFile(f.env.GITHUB_OUTPUT!, "utf8")).toBe(`rid=${success.runId}\nstatus=ok\n`)
      expect(f.requests[0]!.body).toEqual({ purpose: "task", thread: "7", workflowVersion: "3" })
      expect(f.audiences).toEqual([GithubAgents.AUDIENCE.mint])
      await expect(mintRunToken({ purpose: "task", env: f.env, services: f.services })).rejects.toThrow(
        "Could not store",
      )
      expect(await fs.readFile(runTokenPath(f.env), "utf8")).toBe(TOKEN)
    },
  )
  for (const [status, code, result, extra] of [
    [400, "INVALID_REQUEST", "denied", {}],
    [400, "INVALID_JSON", "denied", {}],
    [401, "OIDC_INVALID", "denied", {}],
    ...["WORKFLOW_NOT_TRUSTED", "EVENT_NOT_ALLOWED", "ACTOR_NOT_ALLOWED", "COMMENT_CHANGED"].map(
      (code) => [403, code, "denied", {}] as const,
    ),
    [403, "EVENT_NEEDS_APP", "needs-app", {}],
    [403, "RUNNER_NOT_SUPPORTED", "runner", {}],
    [404, "REPO_NOT_BOUND", "not-bound", {}],
    [409, "BINDING_SUSPENDED", "suspended", {}],
    [426, "WORKFLOW_UPDATE_REQUIRED", "update-required", {}],
    [403, "BINDING_UNAVAILABLE", "binding-unavailable", {}],
    [403, "CODIUM_PERK_REQUIRED", "not-in-plan", { perk: "scheduled" }],
    [403, "CLOUD_AGENTS_SOURCE_UNAVAILABLE", "source-unavailable", {}],
    [503, "MODEL_PLANS_DISABLED", "service-off", {}],
    [429, "MODEL_PLAN_RUN_LIMIT", "hours", { limit: "hours" }],
    [429, "MODEL_PLAN_RUN_LIMIT", "scheduled", { limit: "scheduled" }],
    ...["PERSISTENT_STORE_UNAVAILABLE", "GITHUB_UNAVAILABLE", "RUN_TOKENS_UNAVAILABLE", "CLOUD_AGENTS_UNAVAILABLE"].map(
      (code) => [503, code, "unavailable", {}] as const,
    ),
  ] as const)
    test(`${code} ${result}`, async () => {
      await using f = await fixture(() => Response.json(failure(code, extra), { status }))
      expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe(result)
      expect(existsSync(runTokenPath(f.env))).toBe(false)
      expect(await fs.readFile(f.env.GITHUB_ENV!, "utf8")).toBe("")
      expect(f.notices).toEqual([])
      expect(await fs.readFile(f.env.GITHUB_OUTPUT!, "utf8")).toBe(`status=${result}\n`)
    })
  test("malformed success, tokens and unknown error fields grant nothing", async () => {
    for (const value of [
      { ...success, token: TOKEN + "\n" },
      { ...success, deadline: NOW - 1 },
      { ...success, heartbeatSeconds: 1 },
      { ...success, account: "private" },
      { ...success, runId: "bad\nstatus=ok" },
    ]) {
      await using f = await fixture(() => Response.json(value))
      expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("unavailable")
      expect(existsSync(runTokenPath(f.env))).toBe(false)
      expect(f.masks).not.toContain(value.token)
    }
    await using f = await fixture(() =>
      Response.json(failure("REPO_NOT_BOUND", { account: "private" }), { status: 404 }),
    )
    expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("unavailable")
  })
  test("at-once waits at most ten elapsed minutes and never sends the next late mint", async () => {
    await using f = await fixture(() =>
      Response.json(failure("MODEL_PLAN_RUN_LIMIT", { limit: "at-once" }), { status: 429 }),
    )
    expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("at-once")
    expect(f.waits.reduce((sum, ms) => sum + ms, 0)).toBe(GithubAgents.AT_ONCE_WAIT_MS)
    expect(f.waits).toHaveLength(20)
    expect(f.requests).toHaveLength(20)
    expect(existsSync(runTokenPath(f.env))).toBe(false)
  })
  test("slow responses count toward the at-once deadline and late successes never write", async () => {
    await using f = await fixture((index) => {
      if (index === 1) return Response.json(failure("MODEL_PLAN_RUN_LIMIT", { limit: "at-once" }), { status: 429 })
      f.advance(GithubAgents.AT_ONCE_WAIT_MS)
      return Response.json(success)
    })
    expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("at-once")
    expect(f.requests).toHaveLength(2)
    expect(f.waits).toEqual([30_000])
    expect(existsSync(runTokenPath(f.env))).toBe(false)
    expect(f.masks).not.toContain(TOKEN)
  })
  test("late OIDC and aborted requests cannot create run authority", async () => {
    await using f = await fixture(() =>
      Response.json(failure("MODEL_PLAN_RUN_LIMIT", { limit: "at-once" }), { status: 429 }),
    )
    const oidc = f.services.oidc
    f.services.oidc = async (audience) => {
      if (f.audiences.length) f.advance(GithubAgents.AT_ONCE_WAIT_MS)
      return oidc(audience)
    }
    expect(await mintRunToken({ purpose: "task", env: f.env, services: f.services })).toBe("at-once")
    expect(f.requests).toHaveLength(1)
    expect(existsSync(runTokenPath(f.env))).toBe(false)
    const abort = new AbortController()
    abort.abort()
    await expect(
      mintRunToken({ purpose: "task", env: f.env, services: f.services, signal: abort.signal }),
    ).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
  })
  test("replay/rate retries use fresh proof, are bounded, and never print server text", async () => {
    for (const code of ["OIDC_REPLAYED", "RATE_LIMITED"]) {
      await using f = await fixture(() =>
        Response.json(failure(code), {
          status: code === "OIDC_REPLAYED" ? 409 : 429,
          headers: { "retry-after": "999999" },
        }),
      )
      expect(await mintRunToken({ purpose: "review", env: f.env, services: f.services })).toBe("unavailable")
      expect(f.requests).toHaveLength(4)
      expect(new Set(f.requests.map((r) => r.authorization)).size).toBe(4)
      expect(f.waits).toEqual(Array(3).fill(code === "RATE_LIMITED" ? 30_000 : 1000))
      expect(f.notices).toEqual([])
    }
  })
  test("bind checks the local default branch and reports no account identity", async () => {
    await using f = await fixture(() =>
      Response.json({
        bound: true,
        repository: "fixture/repository",
        repositoryId: "301",
        generation: 1,
        workflowUpdate: false,
      }),
    )
    f.env.GITHUB_REF = "refs/heads/feature"
    expect(await bindRepository({ env: f.env, services: f.services })).toBe(2)
    expect(f.requests).toHaveLength(0)
    expect(f.notices).toEqual(["Run the bind from the default branch."])
    f.env.GITHUB_REF = "refs/heads/main"
    expect(await bindRepository({ env: f.env, services: f.services })).toBe(0)
    expect(f.audiences).toEqual([GithubAgents.AUDIENCE.bind])
    expect(f.notices.at(-1)).toBe("Bound fixture/repository to a Vector account.")
  })
  test("heartbeat/settle decode strictly; missing own-key run credentials never call cloud", async () => {
    await using f = await fixture((_index, request) =>
      Response.json(new URL(request.url).pathname.endsWith("heartbeat") ? { ok: true, stop: false } : { ok: true }),
    )
    expect(await heartbeat({ state: "running", services: f.services })).toEqual({ ok: false, stop: true })
    expect(await settle({ outcome: "changes", services: f.services })).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(await heartbeat({ token: TOKEN, state: "starting", services: f.services })).toEqual({
      ok: true,
      stop: false,
    })
    expect(await settle({ token: TOKEN, outcome: "changes", services: f.services })).toBe(true)
    expect(f.requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
    await using invalid = await fixture(() => Response.json({ ok: true, stop: false, account: "private" }))
    expect(await heartbeat({ token: TOKEN, state: "starting", services: invalid.services })).toEqual({
      ok: false,
      stop: true,
    })
  })
})

async function authorized() {
  const holder = createGithubSecrets()
  await holder.load(channelEnv(), channel(runChannel))
  expect(await holder.authorize(async () => true)).toBe(true)
  return holder
}
const KEY = { key: Buffer.alloc(32, 7).toString("base64url"), keyId: "a".repeat(16) }
const BRAIN_KEY = { key: Buffer.alloc(32, 9).toString("base64url"), keyId: "b".repeat(16) }
const UPLOAD_ID = `vbu_${"u".repeat(32)}`
// The step env a desktop Brain run's agent step receives (BT01): brainDownload reads its id only from here.
const BRAIN_ENV = { VECTOR_THREAD: "dispatch-9", VECTOR_BRAIN_UPLOAD: UPLOAD_ID }
// The largest answer the route can give: a 512 KiB upload plus its tag, and the Brain conversation key. Spec 2.13's
// literals, not the client's formula, so a mistake in that formula fails here.
const BRAIN_CIPHERTEXT = 699_072
const BRAIN_RESPONSE = 703_168
const largest = {
  uploadId: UPLOAD_ID,
  key: Buffer.alloc(32, 3).toString("base64url"),
  aad: `vector-brain-upload-v1|11111111-1111-4111-8111-111111111111|301|3|${UPLOAD_ID}`,
  nonce: Buffer.alloc(12, 4).toString("base64url"),
  ciphertext: Buffer.alloc(512 * 1024 + 16, 5).toString("base64url"),
  sha256: "c".repeat(64),
  bytes: 512 * 1024,
  approvedAt: NOW,
  publicRepository: false,
  artifactKey: BRAIN_KEY,
}
const padded = (value: unknown, size: number) => {
  const text = JSON.stringify(value)
  return new Response(text + " ".repeat(size - Buffer.byteLength(text)), {
    headers: { "content-type": "application/json" },
  })
}

describe("conversation and Brain key clients", () => {
  test("artifact key sends only the run's own thread and decodes a strict key", async () => {
    await using f = await fixture(() => Response.json(KEY))
    const result = await artifactKey({
      env: { VECTOR_THREAD: "7", VECTOR_BRAIN_UPLOAD: "" },
      holder: await authorized(),
      services: f.services,
    })
    expect(result).toEqual({ status: "ok", key: KEY })
    expect(f.requests).toEqual([
      { path: GithubAgents.ENDPOINT.artifactKey, body: { thread: "7" }, authorization: `Bearer ${TOKEN}` },
    ])
    expect(f.masks).toEqual([KEY.key])
    expect(f.notices).toEqual([])
  })
  for (const [status, code, result, extra] of [
    [400, "INVALID_REQUEST", "refused", {}],
    [401, "RUN_TOKEN_INVALID", "refused", {}],
    [401, "MODEL_PLAN_RUN_EXPIRED", "expired", {}],
    [403, "ARTIFACT_KEY_NOT_ALLOWED", "not-allowed", {}],
    [429, "RATE_LIMITED", "unavailable", {}],
    ...["PERSISTENT_STORE_UNAVAILABLE", "RUN_ARTIFACTS_UNAVAILABLE", "CLOUD_AGENTS_UNAVAILABLE"].map(
      (code) => [503, code, "unavailable", {}] as const,
    ),
    [403, "INVALID_REQUEST", "unavailable", {}],
    [403, "ARTIFACT_KEY_NOT_ALLOWED", "unavailable", { limit: "hours" }],
  ] as const)
    test(`artifact key ${status} ${code}${Object.keys(extra).length ? " with limit" : ""} is ${result}`, async () => {
      await using f = await fixture(() => Response.json(failure(code, extra), { status }))
      const answer = await artifactKey({
        env: { VECTOR_THREAD: "7" },
        holder: await authorized(),
        services: f.services,
      })
      expect(answer).toEqual({ status: result })
      expect(f.requests).toHaveLength(1)
      expect(f.masks).toEqual([])
      expect(f.notices).toEqual([])
      expect(JSON.stringify(answer)).not.toContain("PRIVATE SERVER DIAGNOSTIC")
    })
  test("malformed, oversized or redirected key answers grant nothing", async () => {
    const answers = [
      () => Response.json({ ...KEY, account: "private" }),
      () => Response.json({ ...KEY, key: KEY.key.slice(1) }),
      () => Response.json({ ...KEY, key: "A".repeat(42) + "B" }),
      () => Response.json({ ...KEY, keyId: "A".repeat(16) }),
      () => Response.json(failure("ARTIFACT_KEY_NOT_ALLOWED")),
      () => new Response(null, { status: 200 }),
      () => padded(KEY, 16_385),
    ]
    await using f = await fixture((index) => answers[index - 1]!())
    const holder = await authorized()
    for (const _ of answers)
      expect(await artifactKey({ env: { VECTOR_THREAD: "7" }, holder, services: f.services })).toEqual({
        status: "unavailable",
      })
    expect(f.requests).toHaveLength(answers.length)
    // The cap itself: the same key with spaces up to exactly 16,384 bytes is read.
    await using exact = await fixture(() => padded(KEY, 16_384))
    expect(await artifactKey({ env: { VECTOR_THREAD: "7" }, holder, services: exact.services })).toEqual({
      status: "ok",
      key: KEY,
    })
    expect(f.masks).toEqual([])
    let followed = 0
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        followed++
        return Response.json(KEY)
      },
    })
    try {
      await using moved = await fixture(() => Response.redirect(target.url.origin + "/key", 302))
      expect(await artifactKey({ env: { VECTOR_THREAD: "7" }, holder, services: moved.services })).toEqual({
        status: "unavailable",
      })
      expect(await brainDownload({ env: BRAIN_ENV, holder, services: moved.services })).toEqual({
        status: "unavailable",
      })
      expect(moved.requests).toHaveLength(2)
      expect(moved.masks).toEqual([])
    } finally {
      await target.stop(true)
    }
    expect(followed).toBe(0)
  })
  test("a key or Brain read that never answers is cut off, one without a caller signal still has its own, and an aborted one never asks", async () => {
    await using f = await fixture()
    const holder = await authorized()
    const request = f.services.request
    let asked = 0
    f.services.request = () => {
      asked++
      return new Promise<Response>(() => {})
    }
    expect(
      await artifactKey({
        env: { VECTOR_THREAD: "7" },
        holder,
        services: f.services,
        signal: AbortSignal.timeout(100),
      }),
    ).toEqual({ status: "unavailable" })
    expect(
      await brainDownload({ env: BRAIN_ENV, holder, services: f.services, signal: AbortSignal.timeout(100) }),
    ).toEqual({ status: "unavailable" })
    expect(asked).toBe(2)
    // Without a caller signal each client still hands the transport post()'s own timeout signal (20 s by default).
    const signals: (AbortSignal | null | undefined)[] = []
    f.services.request = async (_, init) => {
      signals.push(init.signal)
      return Response.json(failure("RATE_LIMITED"), { status: 429 })
    }
    expect(await artifactKey({ env: { VECTOR_THREAD: "7" }, holder, services: f.services })).toEqual({
      status: "unavailable",
    })
    expect(await brainDownload({ env: BRAIN_ENV, holder, services: f.services })).toEqual({ status: "unavailable" })
    expect(signals).toHaveLength(2)
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal!.aborted).toBe(false)
    }
    f.services.request = request
    const abort = new AbortController()
    abort.abort()
    expect(
      await artifactKey({ env: { VECTOR_THREAD: "7" }, holder, services: f.services, signal: abort.signal }),
    ).toEqual({ status: "unavailable" })
    expect(await brainDownload({ env: BRAIN_ENV, holder, services: f.services, signal: abort.signal })).toEqual({
      status: "unavailable",
    })
    expect(f.requests).toHaveLength(0)
    expect(f.masks).toEqual([])
  })
  test("own-key, unauthorized, threadless and Brain runs make no key request, and no id makes no Brain read", async () => {
    await using f = await fixture(() => Response.json(KEY))
    const own = createGithubSecrets()
    await own.load(channelEnv("own-key"), channel(ownChannel))
    const pending = createGithubSecrets()
    await pending.load(channelEnv(), channel(runChannel))
    expect(pending.pendingRunToken()).toBe(TOKEN)
    const holder = await authorized()
    for (const unauthorized of [own, pending, createGithubSecrets()]) {
      expect(await artifactKey({ env: { VECTOR_THREAD: "7" }, holder: unauthorized, services: f.services })).toEqual({
        status: "absent",
      })
      expect(await brainDownload({ env: BRAIN_ENV, holder: unauthorized, services: f.services })).toEqual({
        status: "absent",
      })
    }
    for (const thread of [undefined, "", "7\n", "abc", "dispatch-0", "schedule-XYZ"])
      expect(await artifactKey({ env: { VECTOR_THREAD: thread }, holder, services: f.services })).toEqual({
        status: "absent",
      })
    // A desktop Brain run's conversation key comes only from brain-download (deviations, "2026-11-15 BT03" item 4).
    for (const upload of [UPLOAD_ID, "malformed"])
      expect(
        await artifactKey({
          env: { VECTOR_THREAD: "dispatch-9", VECTOR_BRAIN_UPLOAD: upload },
          holder,
          services: f.services,
        }),
      ).toEqual({ status: "brain-run" })
    for (const uploadId of ["", "vbu_short", UPLOAD_ID + "\n", `vbu_${"u".repeat(33)}`, ` ${UPLOAD_ID}`])
      expect(await brainDownload({ env: { VECTOR_BRAIN_UPLOAD: uploadId }, holder, services: f.services })).toEqual({
        status: "absent",
      })
    // The id is never a parameter: a step env without VECTOR_BRAIN_UPLOAD has none to send.
    expect(await brainDownload({ env: { VECTOR_THREAD: "dispatch-9" }, holder, services: f.services })).toEqual({
      status: "absent",
    })
    expect(f.requests).toHaveLength(0)
    expect(f.masks).toEqual([])
  })
  test("brain download sends only the step's own upload id, whose step never asks for the ordinary key, and decodes the largest approved envelope", async () => {
    const withoutKey = { ...largest, artifactKey: undefined }
    const answers = [largest, withoutKey]
    expect(largest.ciphertext).toHaveLength(BRAIN_CIPHERTEXT)
    await using f = await fixture((index) => Response.json(answers[index - 1]))
    const holder = await authorized()
    // The one variable that gives brainDownload its id is the one that keeps artifactKey from asking.
    expect(await artifactKey({ env: BRAIN_ENV, holder, services: f.services })).toEqual({ status: "brain-run" })
    expect(await brainDownload({ env: BRAIN_ENV, holder, services: f.services })).toEqual({
      status: "ok",
      download: largest,
    })
    expect(f.masks).toEqual([largest.key, BRAIN_KEY.key])
    expect(await brainDownload({ env: BRAIN_ENV, holder, services: f.services })).toEqual({
      status: "ok",
      download: withoutKey,
    })
    expect(f.masks).toEqual([largest.key, BRAIN_KEY.key, largest.key])
    expect(f.requests).toEqual(
      Array(2).fill({
        path: GithubAgents.ENDPOINT.brainDownload,
        body: { uploadId: UPLOAD_ID },
        authorization: `Bearer ${TOKEN}`,
      }),
    )
    expect(f.notices).toEqual([])
  })
  for (const [status, code, result] of [
    [400, "BRAIN_UPLOAD_INVALID", "refused"],
    [401, "RUN_TOKEN_INVALID", "refused"],
    [401, "MODEL_PLAN_RUN_EXPIRED", "expired"],
    [503, "BRAIN_UPLOAD_UNAVAILABLE", "unavailable"],
    [503, "ABUSE_PROTECTION_UNAVAILABLE", "unavailable"],
    [503, "RUN_ARTIFACTS_UNAVAILABLE", "unavailable"],
    [429, "RATE_LIMITED", "unavailable"],
    [403, "ORIGIN_NOT_ALLOWED", "unavailable"],
    [415, "CONTENT_TYPE_INVALID", "unavailable"],
    [413, "BODY_TOO_LARGE", "unavailable"],
    [405, "METHOD_NOT_ALLOWED", "unavailable"],
    [400, "INVALID_JSON", "unavailable"],
    [403, "ARTIFACT_KEY_NOT_ALLOWED", "unavailable"],
    [401, "BRAIN_UPLOAD_INVALID", "unavailable"],
  ] as const)
    test(`brain download ${status} ${code} is ${result}`, async () => {
      await using f = await fixture(() => Response.json(failure(code), { status }))
      const answer = await brainDownload({ env: BRAIN_ENV, holder: await authorized(), services: f.services })
      expect(answer).toEqual({ status: result })
      expect(f.requests).toHaveLength(1)
      expect(f.masks).toEqual([])
      expect(f.notices).toEqual([])
      expect(JSON.stringify(answer)).not.toContain("PRIVATE SERVER DIAGNOSTIC")
    })
  test("a Brain answer for another upload, with extra or out-of-range fields, or past its size cap grants nothing", async () => {
    const answers = [
      Response.json({ ...largest, uploadId: `vbu_${"v".repeat(32)}` }),
      Response.json({ ...largest, account: "11111111-1111-4111-8111-111111111111" }),
      Response.json({ ...largest, ticketHash: "d".repeat(64) }),
      Response.json({ ...largest, bytes: 0 }),
      Response.json({ ...largest, bytes: 512 * 1024 + 1 }),
      Response.json({ ...largest, aad: "a".repeat(257) }),
      Response.json({ ...largest, nonce: largest.nonce.slice(1) }),
      Response.json({ ...largest, ciphertext: largest.ciphertext + "A" }),
      Response.json({ ...largest, ciphertext: "A".repeat(22) }),
      Response.json({ ...largest, ciphertext: largest.ciphertext.slice(0, -1) + "=" }),
      Response.json({ ...largest, sha256: "C".repeat(64) }),
      Response.json({ ...largest, publicRepository: "false" }),
      Response.json({ ...largest, approvedAt: 0 }),
      Response.json({ ...largest, key: "A".repeat(42) + "B" }),
      Response.json({ ...largest, artifactKey: { ...BRAIN_KEY, account: "private" } }),
      Response.json({ ...largest, artifactKey: { ...BRAIN_KEY, key: "A".repeat(42) + "B" } }),
      padded(largest, BRAIN_RESPONSE + 1),
    ]
    await using f = await fixture((index) => answers[index - 1]!)
    const holder = await authorized()
    for (const _ of answers)
      expect(await brainDownload({ env: BRAIN_ENV, holder, services: f.services })).toEqual({
        status: "unavailable",
      })
    expect(f.requests).toHaveLength(answers.length)
    expect(f.masks).toEqual([])
    // The cap itself: the largest answer padded to exactly the cap is read, one byte more is not (above).
    await using exact = await fixture(() => padded(largest, BRAIN_RESPONSE))
    expect(await brainDownload({ env: BRAIN_ENV, holder, services: exact.services })).toEqual({
      status: "ok",
      download: largest,
    })
  })
})

describe("private GitHub credentials", () => {
  test("the holder redacts foreign Vector token literals using the canonical grammar", () => {
    const holder = createGithubSecrets()
    const values = ["vrt_fixture-agent.signature", "vct_foreign-payload.signature", "vrt_a-.b_"]
    const text = JSON.stringify({ command: values.join(" ") }) + "\n" + values.join("\n")
    expect(holder.redact(text)).toBe(
      '{"command":"[redacted] [redacted] [redacted]"}\n[redacted]\n[redacted]\n[redacted]',
    )
    const prose = "vrt_ documentation; vct_payload without a signature; vct_.missing; prefix_vrt_a.b"
    expect(holder.redact(prose)).toBe(prose)
    const tooLong = `vrt_${"a".repeat(1020)}.signature`
    expect(holder.redact(tooLong)).toBe(tooLong)
    expect(holder.loaded()).toBe(false)
    expect(holder.pendingRunToken()).toBeUndefined()
  })

  test("the holder redacts literal and JSON-escaped channel values without changing credentials", async () => {
    const holder = createGithubSecrets()
    const secret = 'fixture.key[private]\\path"first\nfixture-second-private-line'
    const value = {
      v: 1,
      githubToken: "fixture-github-redaction-token",
      cliToken: "vct_fixture.redaction",
      keys: { CUSTOM_CREDENTIAL: secret, SHORT_CREDENTIAL: "x.y[7]" },
    }
    await holder.load(
      { GITHUB_ACTIONS: "true", VECTOR_MODE: "own-key", VECTOR_SECRET_CHANNEL: "stdin" },
      channel(value),
    )
    const serialized = JSON.stringify({ command: `print ${secret}`, short: value.keys.SHORT_CREDENTIAL })
    expect(holder.redact(serialized)).toBe('{"command":"print [redacted]","short":"[redacted]"}')
    expect(holder.redact(`${value.githubToken} ${value.cliToken} ${secret}`)).toBe("[redacted] [redacted] [redacted]")
    expect(holder.redact("fixture-second-private-line")).toBe("[redacted]")
    expect(holder.redact("ordinary output stays readable")).toBe("ordinary output stays readable")
    expect(holder.providerKeys()).toEqual(value.keys)
    expect(holder.githubToken() === value.githubToken && holder.cliToken() === value.cliToken).toBe(true)
  })

  test("overlapping held values and foreign token matches are masked against the original text", async () => {
    const holder = createGithubSecrets()
    const value = {
      v: 1 as const,
      githubToken: "fixture-github-overlap-token",
      cliToken: "vct_overlap.signature",
      keys: { WHOLE_CREDENTIAL: "prefix vrt_a.b private-suffix", SHORT_CREDENTIAL: "fixture" },
    }
    await holder.load(
      { GITHUB_ACTIONS: "true", VECTOR_MODE: "own-key", VECTOR_SECRET_CHANNEL: "stdin" },
      channel(value),
    )
    expect(holder.redact(`${value.keys.WHOLE_CREDENTIAL}\nvrt_fixture-agent.signature`)).toBe("[redacted]\n[redacted]")
    expect(
      holder.redact(JSON.stringify({ full: value.keys.WHOLE_CREDENTIAL, foreign: "vct_fixture-other.signature" })),
    ).toBe('{"full":"[redacted]","foreign":"[redacted]"}')
    expect(holder.providerKeys()).toEqual(value.keys)
  })

  test("the channel leaves no OS credentials and loading alone authorizes no model", async () => {
    const holder = createGithubSecrets()
    const env = channelEnv()
    await holder.load(env, channel(runChannel))
    expect(holder.pendingRunToken()).toBe(TOKEN)
    expect(holder.runToken()).toBeUndefined()
    for (const name of ["GITHUB_TOKEN", "VECTOR_CLI_TOKEN", "CUSTOM_CREDENTIAL"]) expect(env[name]).toBeUndefined()
    expect(await holder.authorize(async (token) => token === TOKEN)).toBe(true)
    expect(holder.runToken()).toBe(TOKEN)
    expect(await holder.authorize(async () => false)).toBe(false)
    expect(holder.runToken()).toBeUndefined()
  })
  test("the account run gate has no refusal or offline fallback", async () => {
    for (const status of [200, 401, 503]) {
      await using f = await fixture(() =>
        Response.json(status === 200 ? { ok: true, stop: false } : failure("PRIVATE"), { status }),
      )
      const holder = createGithubSecrets()
      await holder.load(channelEnv(), channel(runChannel))
      expect(await verifyGithubRun(holder, f.services)).toBe(status === 200)
      expect(holder.runToken()).toEqual(status === 200 ? TOKEN : undefined)
      expect(f.requests[0]!.body).toEqual({ state: "starting" })
      expect(f.requests[0]!.path).toBe(GithubAgents.ENDPOINT.heartbeat)
      expect(f.notices).toEqual([])
    }
    await using f = await fixture()
    f.services.request = async () => {
      throw new Error("PRIVATE authenticated transport failure")
    }
    const holder = createGithubSecrets()
    await holder.load(channelEnv(), channel(runChannel))
    expect(await verifyGithubRun(holder, f.services)).toBe(false)
    expect(holder.runToken()).toBeUndefined()
  })
  test("a late-starting heartbeat cannot grant model authority", async () => {
    await using f = await fixture(() => Response.json({ ok: true, stop: true }))
    const holder = createGithubSecrets()
    await holder.load(channelEnv(), channel(runChannel))
    expect(await verifyGithubRun(holder, f.services)).toBe(false)
    expect(holder.runToken()).toBeUndefined()
  })
  test("captured nonsuffix names are cleared even with an empty advertised list", async () => {
    for (const malformed of [false, true]) {
      const env: Record<string, string | undefined> = {
        ...channelEnv("own-key"),
        VECTOR_SECRET_ENV_NAMES: "",
        CUSTOM_CREDENTIAL: "inherited-private",
      }
      const holder = createGithubSecrets()
      const input = { ...ownChannel, keys: { CUSTOM_CREDENTIAL: malformed ? 42 : "channel-private" } }
      if (malformed) await expect(holder.load(env, channel(input))).rejects.toThrow()
      if (!malformed) await holder.load(env, channel(input))
      expect(env.CUSTOM_CREDENTIAL).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.VECTOR_CLI_TOKEN).toBeUndefined()
    }
  })
  test("a delayed older success cannot reopen a newer refused authorization", async () => {
    const holder = createGithubSecrets()
    await holder.load(channelEnv(), channel(runChannel))
    const older = Promise.withResolvers<boolean>()
    const pending = holder.authorize(() => older.promise)
    expect(await holder.authorize(async () => false)).toBe(false)
    older.resolve(true)
    expect(await pending).toBe(false)
    expect(holder.runToken()).toBeUndefined()
  })
  test("own-key channels require their CLI secret and preserve provider keys only in memory", async () => {
    const holder = createGithubSecrets()
    const env = channelEnv("own-key")
    await holder.load(env, channel(ownChannel))
    expect(holder.cliToken()).toBe(CLI)
    expect(holder.providerKeys()).toEqual(ownChannel.keys)
    expect(holder.runToken()).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    for (const cliToken of [undefined, "bad", TOKEN]) {
      const refused = createGithubSecrets()
      await expect(refused.load(channelEnv("own-key"), channel({ ...ownChannel, cliToken }))).rejects.toThrow(
        "credentials are unavailable",
      )
      expect(refused.loaded()).toBe(false)
    }
  })
  test("invalid channel shapes and mixed domains fail closed and clear fallback credentials", async () => {
    for (const value of [
      { ...runChannel, v: 2 },
      { ...runChannel, extra: "bad" },
      { ...runChannel, cliToken: CLI },
      { ...runChannel, keys: { OPENAI_API_KEY: "bad" } },
      { ...ownChannel, keys: { VECTOR_MODE: "own-key" } },
    ]) {
      const env = channelEnv()
      await expect(createGithubSecrets().load(env, channel(value))).rejects.toThrow("credentials are unavailable")
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.VECTOR_CLI_TOKEN).toBeUndefined()
    }
  })
  test.skipIf(process.platform === "win32")(
    "private token files are consumed once and links/insecure modes are refused",
    async () => {
      await using f = await fixture()
      await writeRunToken(TOKEN, f.env)
      expect(await readRunToken(f.env)).toBe(TOKEN)
      expect(existsSync(runTokenPath(f.env))).toBe(false)
      await fs.writeFile(path.join(f.directory, "target"), TOKEN, { mode: 0o600 })
      await fs.symlink(path.join(f.directory, "target"), runTokenPath(f.env))
      await expect(readRunToken(f.env)).rejects.toThrow()
      expect(await fs.readFile(path.join(f.directory, "target"), "utf8")).toBe(TOKEN)
      await fs.unlink(runTokenPath(f.env))
      await writeRunToken(TOKEN, f.env)
      await fs.chmod(runTokenPath(f.env), 0o644)
      await expect(readRunToken(f.env)).rejects.toThrow()
    },
  )
  test.skipIf(process.platform === "win32")(
    "a file growing after stat is read at most 1025 bytes and remains refused",
    async () => {
      await using f = await fixture()
      await writeRunToken(TOKEN, f.env)
      let read = 0
      await expect(
        readRunToken(f.env, async (file, flags) => {
          const handle = await fs.open(file, flags)
          return {
            stat: async () => {
              const info = await handle.stat()
              await fs.appendFile(file, "x".repeat(1_048_576))
              return info
            },
            read: async (buffer, offset, length, position) => {
              expect(length).toBeLessThanOrEqual(1025)
              const result = await handle.read(buffer, offset, length, position)
              read += result.bytesRead
              return result
            },
            close: () => handle.close(),
          }
        }),
      ).rejects.toThrow("credentials are unavailable")
      expect(read).toBe(1025)
      expect(existsSync(runTokenPath(f.env))).toBe(true)
    },
  )
  test.skipIf(process.platform === "win32")(
    "the review loader unlinks its token and clears inherited account credentials",
    async () => {
      await using f = await fixture()
      await writeRunToken(TOKEN, f.env)
      f.env.GITHUB_TOKEN = "fixture-github-token"
      f.env.VECTOR_CLI_TOKEN = CLI
      const holder = createGithubSecrets()
      await holder.load(f.env, channel({ unused: true }))
      expect(holder.pendingRunToken()).toBe(TOKEN)
      expect(holder.runToken()).toBeUndefined()
      expect(existsSync(runTokenPath(f.env))).toBe(false)
      expect(f.env.GITHUB_TOKEN).toBeUndefined()
      expect(f.env.VECTOR_CLI_TOKEN).toBeUndefined()
    },
  )
})

// These file controls rely on POSIX owner/mode checks. Windows cannot establish that authority, and must refuse it.
test.skipIf(process.platform !== "win32")(
  "Windows cannot mint or load a token through POSIX private files",
  async () => {
    await using f = await fixture()
    await expect(mintRunToken({ purpose: "task", env: f.env, services: f.services })).rejects.toThrow("Could not store")
    expect(existsSync(runTokenPath(f.env))).toBe(false)
    expect(await fs.readFile(f.env.GITHUB_ENV!, "utf8")).toBe("")
    expect(await fs.readFile(f.env.GITHUB_OUTPUT!, "utf8")).toBe("")
    await fs.writeFile(runTokenPath(f.env), TOKEN)
    f.env.GITHUB_TOKEN = "fixture-windows-github-token"
    f.env.VECTOR_CLI_TOKEN = CLI
    const holder = createGithubSecrets()
    await expect(holder.load(f.env, channel({ unused: true }))).rejects.toThrow("credentials are unavailable")
    expect(holder.loaded()).toBe(false)
    expect(holder.pendingRunToken()).toBeUndefined()
    expect(await fs.readFile(runTokenPath(f.env), "utf8")).toBe(TOKEN)
    expect(f.env.GITHUB_TOKEN).toBeUndefined()
    expect(f.env.VECTOR_CLI_TOKEN).toBeUndefined()
  },
)
