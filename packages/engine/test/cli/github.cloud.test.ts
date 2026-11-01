import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  bindRepository,
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
  test("mint masks before exclusive private storage and emits no credential through file commands", async () => {
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
    await expect(mintRunToken({ purpose: "task", env: f.env, services: f.services })).rejects.toThrow("Could not store")
    expect(await fs.readFile(runTokenPath(f.env), "utf8")).toBe(TOKEN)
  })
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

describe("private GitHub credentials", () => {
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
  test("private token files are consumed once and links/insecure modes are refused", async () => {
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
  })
  test("a file growing after stat is read at most 1025 bytes and remains refused", async () => {
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
  })
  test("the review loader unlinks its token and clears inherited account credentials", async () => {
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
  })
})
