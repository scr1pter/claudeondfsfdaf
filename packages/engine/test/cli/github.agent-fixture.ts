// Fakes for the agent phase's tests (V18b, V18c): an event file outside the repository, a loopback fake GitHub that
// records every request, a git origin that demands credentials and counts its hits, a vectordev.ai recorder behind the
// cloud client's Services seam, channel holders made with createGithubSecrets, and a fake Codium gateway with its
// catalog and run credential behind the services the provider layer reads. Nothing here assigns process.env, and no
// request leaves this computer.

import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import type { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import type { Services } from "../../src/cli/cmd/github.cloud"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"

export const OWNER = "octo"
export const REPO = "widgets"
export const RUN_ID = "4242"

// Fixture credentials only; none is a real token.
export const CHANNEL = {
  githubToken: "fixture-agent-github-token",
  cliToken: "vct_fixture-agent.signature",
  runToken: "vrt_fixture-agent.signature",
  keys: {
    ANTHROPIC_API_KEY: "fixture-agent-anthropic-key",
    // A name SECRET_NAME_PATTERN does not match, so only the loader keeps it out of a child's environment.
    V18B_PROVIDER_CREDENTIAL: "fixture-agent-nonsuffix-credential",
  },
} as const

/** Every fixture credential value, for checks that none reached an environment or an output. */
export const VALUES = [CHANNEL.githubToken, CHANNEL.cliToken, CHANNEL.runToken, ...Object.values(CHANNEL.keys)]

/** A well-formed one-time run ticket (`vtk_` and 43 safe characters); not a real one. */
export const TICKET_FIXTURE = `vtk_${"fixtureTicket_-".repeat(3).slice(0, 43)}`

/** The one model the fake Codium catalog lists, so `MODEL: vector-plan` picks it. */
export const CODIUM_MODEL = {
  id: "codium-fixture",
  name: "Codium Fixture",
  contextLength: 100_000,
  maxOutputTokens: 8_000,
}

export type Recorded = { method: string; path: string; query?: string; authorization?: string }

const scratch: string[] = []

/** A folder outside every repository, removed by cleanup(). */
export async function folder(prefix = "vector-agent-") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  scratch.push(dir)
  return dir
}

export async function cleanup() {
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
}

/** The event payload as the sandbox hands it over: a file outside the checkout. */
export async function eventFile(payload: unknown) {
  const file = path.join(await folder("vector-agent-event-"), "event.json")
  await fs.writeFile(file, JSON.stringify(payload))
  return file
}

export async function git(cwd: string, args: string[]) {
  const result =
    await $`git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false -c user.name=Test -c user.email=test@vector.test ${args}`
      .cwd(cwd)
      .quiet()
      .nothrow()
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/**
 * Commits everything the test setup wrote into the repository (its vector.json), so the phase's base is the tree the
 * agent starts from and a run with no edits has no patch. Returns the base commit after checking the tree is clean.
 */
export async function commitSetup(dir: string) {
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "setup"])
  const status = await git(dir, ["status", "--porcelain"])
  if (status !== "") throw new Error(`The test repository is not clean: ${status}`)
  return git(dir, ["rev-parse", "HEAD"])
}

/** Back to the base between runs in one repository: the agent's edits and the bundle go. */
export async function resetTree(dir: string) {
  await git(dir, ["checkout", "-q", "--", "."])
  await git(dir, ["clean", "-fdq"])
}

/** Every ref and HEAD, to show the phase moved none. */
export async function refs(dir: string) {
  return [await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]), await git(dir, ["rev-parse", "HEAD"])]
}

/** A git origin that answers every request with 401 Basic, so a fetch or push would need credentials. */
export function authRemote() {
  const hits: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response("auth required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="git"' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/${OWNER}/${REPO}.git`, hits, stop: () => server.stop(true) }
}

type Thread = { number: number; kind: "issue" | "pr"; data: Record<string, unknown> }

/**
 * A fake GitHub API: collaborator permissions from `roles` (anyone else is "read"), GraphQL answers for the threads
 * given, and review comments by id. Every request is recorded with its method, path and GraphQL query.
 */
export function fakeGithub(input: {
  roles?: Record<string, string>
  threads?: Thread[]
  reviewComments?: Record<number, Record<string, unknown>>
}) {
  const seen: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "POST" ? await request.text() : ""
      const query = text ? (JSON.parse(text) as { query?: string }).query : undefined
      seen.push({
        method: request.method,
        path: url.pathname,
        ...(query ? { query } : {}),
        ...(request.headers.get("authorization") ? { authorization: request.headers.get("authorization")! } : {}),
      })
      const permission = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(url.pathname)
      if (request.method === "GET" && permission) {
        const role = input.roles?.[decodeURIComponent(permission[1]!)] ?? "read"
        return Response.json({ permission: role, role_name: role, user: { login: permission[1] } })
      }
      const comment = /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)$/.exec(url.pathname)
      if (request.method === "GET" && comment && input.reviewComments?.[Number(comment[1])])
        return Response.json(input.reviewComments[Number(comment[1])])
      if (request.method === "POST" && url.pathname === "/graphql" && query) {
        const variables = (JSON.parse(text) as { variables?: { number?: number } }).variables
        const thread = input.threads?.find((item) => item.number === variables?.number)
        if (thread && query.includes("issue(number") && thread.kind === "issue")
          return Response.json({ data: { repository: { issue: thread.data } } })
        if (thread && query.includes("pullRequest(number") && thread.kind === "pr")
          return Response.json({ data: { repository: { pullRequest: thread.data } } })
      }
      return Response.json({ message: "Not Found" }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

export function comment(id: number, login: string | null, body: string) {
  return {
    id: `IC_${id}`,
    databaseId: String(id),
    body,
    author: login ? { login } : null,
    createdAt: "2026-11-01T00:00:00Z",
  }
}

export function issueData(input: { title: string; body: string; author: string; comments?: unknown[] }) {
  return {
    title: input.title,
    body: input.body,
    author: { login: input.author },
    createdAt: "2026-11-01T00:00:00Z",
    state: "OPEN",
    comments: { nodes: input.comments ?? [] },
  }
}

export function pullData(input: {
  title: string
  author: string
  head?: string
  fork?: boolean
  comments?: unknown[]
}) {
  return {
    title: input.title,
    body: "PR body",
    author: { login: input.author },
    baseRefName: "main",
    headRefName: input.head ?? "feature/login",
    headRefOid: "0".repeat(40),
    createdAt: "2026-11-01T00:00:00Z",
    additions: 1,
    deletions: 0,
    state: "OPEN",
    baseRepository: { nameWithOwner: `${OWNER}/${REPO}` },
    headRepository: { nameWithOwner: input.fork ? `stranger/${REPO}` : `${OWNER}/${REPO}` },
    commits: { totalCount: 1, nodes: [] },
    files: { nodes: [] },
    comments: { nodes: input.comments ?? [] },
    reviews: { nodes: [] },
  }
}

/**
 * The vectordev.ai side of the cloud client, through its Services seam: every request is recorded with its path, body
 * and authorization, and settle is accepted. A heartbeat is answered `{ok: true, stop: false}`, or with what `heartbeat`
 * returns for its body.
 */
export function cloudRecorder(options: { heartbeat?: (body: unknown) => unknown } = {}) {
  const requests: { path: string; body: unknown; authorization?: string }[] = []
  const services: Services = {
    oidc: async () => {
      throw new Error("The agent phase never asks for an identity token")
    },
    mask: () => {},
    now: () => 0,
    monotonic: () => 0,
    wait: async () => {},
    notice: () => {},
    request: async (url, init) => {
      const request = new Request(url, init)
      const body: unknown = await request.json().catch(() => undefined)
      requests.push({
        path: new URL(request.url).pathname,
        body,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      if (!request.url.endsWith("/heartbeat")) return Response.json({ ok: true })
      return Response.json(options.heartbeat?.(body) ?? { ok: true, stop: false })
    },
  }
  return { services, requests }
}

/**
 * A channel holder of its own, loaded from one channel line; process.env is never read or changed. A Codium holder's
 * run token is authorized, as the account gate's starting heartbeat would, unless `authorized` is false.
 */
export async function holder(mode: "own-key" | "codium", authorized = true) {
  const secrets = GithubSecrets.createGithubSecrets()
  const line =
    mode === "codium"
      ? { v: 1, githubToken: CHANNEL.githubToken, runToken: CHANNEL.runToken, keys: {} }
      : { v: 1, githubToken: CHANNEL.githubToken, cliToken: CHANNEL.cliToken, keys: CHANNEL.keys }
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    VECTOR_MODE: mode,
    VECTOR_SECRET_CHANNEL: "stdin",
  }
  await secrets.load(
    env,
    (async function* () {
      yield JSON.stringify(line) + "\n"
    })(),
  )
  if (mode === "codium" && authorized) await secrets.authorize(async () => true)
  return secrets
}

/** What the fake gateway does with one task request: send it on to the fake model server, hold it, or refuse it. */
export type GatewayAction =
  | { kind: "forward" }
  | { kind: "hold" }
  | { kind: "refuse"; status: number; code?: string; limit?: string }

export type GatewayRequest = { authorization?: string; title: boolean; action: GatewayAction["kind"] }

/**
 * A fake Codium gateway with its catalog and run credential, as runtime() replacements. While `codium` is false (the
 * default) the catalog is off and the credential is missing, so an own-key test sees no Codium provider; set it before
 * an instance's first provider read, since the provider layer keeps its list per instance. The catalog lists
 * CODIUM_MODEL only for the fixture run token. A title request is always sent on to the fake model server at `target`,
 * which answers titles itself. Every other request takes the next action from `queue`, or `sticky` once the queue is
 * empty (forward by default). A refusal is the gateway's `{error: {code, message, limit?}}` with `retry-after-ms: 1`,
 * and calls `onRefusal` first; a held request waits until its caller aborts it and resolves `held`.
 */
export function codiumFakes() {
  const state = {
    codium: false,
    target: "",
    queue: [] as GatewayAction[],
    sticky: { kind: "forward" } as GatewayAction,
    onRefusal: (() => {}) as () => void,
    held: Promise.withResolvers<void>(),
    reads: [] as (string | undefined)[],
    requests: [] as GatewayRequest[],
  }
  const reset = (input: Partial<Pick<typeof state, "codium" | "target" | "queue" | "sticky" | "onRefusal">> = {}) => {
    state.codium = input.codium ?? state.codium
    state.target = input.target ?? state.target
    state.queue = input.queue ?? []
    state.sticky = input.sticky ?? { kind: "forward" }
    state.onRefusal = input.onRefusal ?? (() => {})
    state.held = Promise.withResolvers<void>()
    state.reads.splice(0)
    state.requests.splice(0)
  }
  const forward = (body: string, signal: AbortSignal | null | undefined) =>
    fetch(`${state.target}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: signal ?? undefined,
    })
  const request = async (url: string, init: RequestInit) => {
    if (url !== ModelPlans.CHAT_URL) throw new Error("The fake gateway answers chat requests only.")
    const body = typeof init.body === "string" ? init.body : ""
    const title = body.includes("Generate a title for this conversation")
    const action: GatewayAction = title ? { kind: "forward" } : (state.queue.shift() ?? state.sticky)
    state.requests.push({
      authorization: new Headers(init.headers).get("authorization") ?? undefined,
      title,
      action: action.kind,
    })
    if (action.kind === "forward") return forward(body, init.signal)
    if (action.kind === "hold") {
      state.held.resolve()
      return new Promise<Response>((_, reject) => {
        const signal = init.signal
        if (!signal) return
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    state.onRefusal()
    return new Response(
      action.code === undefined
        ? ""
        : JSON.stringify({
            error: {
              code: action.code,
              message: "fixture gateway words: credits, plan, $9",
              ...(action.limit ? { limit: action.limit } : {}),
            },
          }),
      { status: action.status, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
    )
  }
  const replacements: LayerNode.Replacements = [
    [
      ModelPlans.node,
      Layer.succeed(
        ModelPlans.Service,
        ModelPlans.Service.of({
          catalog: (token) =>
            Effect.sync(() => {
              state.reads.push(token)
              return token === CHANNEL.runToken && state.codium
                ? { enabled: true, models: [CODIUM_MODEL] }
                : { enabled: false, models: [] }
            }),
          request,
        }),
      ),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(
        FreeModels.CredentialsService,
        FreeModels.CredentialsService.of({
          get: (provider) => Effect.sync(() => (provider === "vector" && state.codium ? CHANNEL.runToken : undefined)),
        }),
      ),
    ],
  ]
  return { state, reset, replacements }
}

/** The agent step's environment as the sandbox starts the engine with it (SANDBOX_ENV_ALLOW), for one event. */
export function stepEnv(input: {
  event: string
  eventName: string
  thread: string
  github: string
  mode?: "own-key" | "codium"
  model?: string
  prompt?: string
  mentions?: string
  /** VECTOR_RUN_DEADLINE, epoch milliseconds as mint writes it. */
  deadline?: string
}): Record<string, string | undefined> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_EVENT_NAME: input.eventName,
    GITHUB_EVENT_PATH: input.event,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: input.github,
    VECTOR_MODE: input.mode ?? "own-key",
    VECTOR_THREAD: input.thread,
    VECTOR_WORKFLOW_VERSION: "3",
    MODEL: input.model ?? "lmstudio/test-model",
    MENTIONS: input.mentions ?? "/vector,/vs",
    ...(input.prompt !== undefined ? { VECTOR_PROMPT: input.prompt } : {}),
    ...(input.deadline !== undefined ? { VECTOR_RUN_DEADLINE: input.deadline } : {}),
  }
}

/**
 * The agent phase's clock for a test: time moves only when the test moves it, each timer is recorded and fires only
 * when the test fires it, running heartbeats come every `heartbeatMs` (an hour unless a test asks for them), and a
 * concurrency retry waits at least 1 ms of real time rather than RETRY_INITIAL_DELAY.
 */
export function fakeClock(start = 1_800_000_000_000, heartbeatMs = 3_600_000) {
  const state = { now: start, timers: [] as { ms: number; fire: () => void; cleared: boolean }[] }
  return {
    state,
    clock: {
      now: () => state.now,
      timer: (ms: number, fire: () => void) => {
        const entry = { ms, fire, cleared: false }
        state.timers.push(entry)
        return () => {
          entry.cleared = true
        }
      },
      heartbeatMs,
      minDelayMs: 1,
    },
  }
}
