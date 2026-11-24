import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { afterEach, expect, jest, test } from "bun:test"
import os from "node:os"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { CLOSE } from "@vectordevai/relay/protocol"
import { branchFor } from "@vectordevai/core/everywhere/publish"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { offerPublicKey, signOffer } from "../../../../api/_lib/everywhere/offer"
import { unattendedRules, type RunnerEngine } from "./everywhere-engine"
import type { RepositoryMapping, RunnerGit } from "./everywhere-git"
import { createLedger, type RunnerLedger } from "./everywhere-ledger"
import { OFFER_KEYS } from "./everywhere-offer"
import type { RunnerDeps, SafeWorktree } from "./everywhere-runner"
import { everywhereSettings } from "./everywhere-settings"
import { createEverywhereJobs, jobsForLink, projectFolder } from "./everywhere-wiring"
import { setDesktopWorkBlocker } from "./keep-awake"
import { createRemoteLink, type LinkDependencies, type RemoteStatus } from "./remote-link"
import type { RemoteIdentity } from "./remote-pairing"
import { createMemoryRelay, ticketFor } from "./remote-relay.fixture"
import { requestMessage, SESSION_MESSAGE, sessionRequester } from "./everywhere-preference-bridge"
import type { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"

// VE-21's desktop wiring (EV-17): the jobs module on the real Remote link and the in-memory relay, composed exactly as
// startRemote composes them (jobsForLink), with fakes for the engine's config route, the jobs service and git.

installFetchGuard()
// One case sets this process's Vector Local policy, through the module's own API.
afterEach(() => {
  Egress.configure(LocalPolicy.OFF)
  // EV-18's stay-awake cases set keep-awake.ts's process-wide blocker; each releases its holds before this.
  setDesktopWorkBlocker(undefined)
})

const ORIGIN = "https://remote.vectordev.ai"
const RELAY = "wss://relay.example.test/v1/connect"
const SERVICE = "http://127.0.0.1"
const ENGINE = "http://127.0.0.1:4096"
const ACCOUNT = randomUUID()
const TOKEN = `vct_${Buffer.from(JSON.stringify({ v: 1, sub: ACCOUNT })).toString("base64url")}.fixture-signature`
const SIGNING = { kid: "test-signing-key", key: generateKeyPairSync("ed25519").privateKey }
const KEYS = { [SIGNING.kid]: offerPublicKey(SIGNING).publicKey }
const HELD = "This computer cannot yet create an unattended worktree safely. No changes were pushed."
const READY = { jobs: "1", remote: "1", local: "0", sandbox: "0", wait: "1", room: "1", projects: "1" }

const signed = (jid = createJobId(Date.now())) => signOffer(SIGNING, { account: ACCOUNT, jid, now: Date.now() }).offer
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, ms = 3_000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition never held")
    await sleep(5)
  }
}

async function turns(condition: () => boolean, count = 2_000) {
  for (let turn = 0; turn < count && !condition(); turn++) await Promise.resolve()
  if (!condition()) throw new Error("condition never held within microtask turns")
}

async function flush(count = 400) {
  for (let turn = 0; turn < count; turn++) await Promise.resolve()
}

/** Under jest's fake clock: one minute at a time, each followed by the microtasks it set off. */
async function minutes(count: number) {
  for (let step = 0; step < count; step++) {
    jest.advanceTimersByTime(60_000)
    await flush()
  }
}

/** This process's Vector Local on, allowing only these sources. */
function allowing(...sources: string[]) {
  Egress.configure(
    LocalPolicy.resolve({
      global: {
        enabled: true,
        allow: sources.map((source) => ({ source, reason: "Fixture", added_at: 1, added_by: "app" as const })),
      },
    }),
  )
}

function deferred() {
  const parts: { resolve: () => void; promise?: Promise<void> } = { resolve: () => {} }
  parts.promise = new Promise<void>((resolve) => {
    parts.resolve = resolve
  })
  return { promise: parts.promise, resolve: () => parts.resolve() }
}

const fetcherOf = (answer: (url: URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      answer(new URL(input instanceof Request ? input.url : String(input)), init),
    { preconnect: () => undefined },
  ) as typeof fetch

async function folderFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ev17-"))
  const project = path.join(root, "app")
  await mkdir(project)
  return { root, project, cleanup: () => rm(root, { recursive: true, force: true }) }
}

type Config = { everywhere?: Record<string, unknown>; locked?: unknown; [key: string]: unknown }
const on = (project: string, extra: Record<string, unknown> = {}): Config => ({
  everywhere: { enabled: true, projects: [{ directory: project, repository: "acme/app" }], ...extra },
  locked: [],
})
const off = (project: string): Config => ({
  everywhere: { enabled: false, projects: [{ directory: project, repository: "acme/app" }] },
  locked: [],
})

function jobFor(jid: string): EverywhereJob {
  const now = Date.now()
  return {
    v: 1,
    jid,
    platform: "slack",
    kind: "mention",
    requester: { label: "Requester", self: true },
    repository: { id: 101, fullName: "acme/app", shared: false },
    task: "Fix retry handling",
    context: [{ from: "teammate", text: "Retry three times." }],
    limits: { maxUsd: 50, minutes: 120, deadline: now + 120 * 60_000 },
    reply: { format: "slack", maxChars: 1500 },
    lease: { id: randomId(), expiresAt: now + 5 * 60_000 },
  }
}

type Request = {
  route: string
  method: string
  query: Record<string, string>
  device: string | null
  authorization: string | null
  body?: Record<string, unknown>
}

/** The jobs routes on loopback: every request recorded, each answered by route. */
function jobsService() {
  const requests: Request[] = []
  const hooks: {
    pending: (count: number) => unknown
    settle?: (body: Record<string, unknown>) => Promise<void>
  } = { pending: () => ({ offers: [], waiting: 0 }) }
  const fetcher = fetcherOf(async (url, init) => {
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const route = url.pathname.split("/").at(-1) ?? ""
    requests.push({
      route,
      method: init?.method ?? "GET",
      query: Object.fromEntries(url.searchParams),
      device: headers.get("x-vector-device"),
      authorization: headers.get("authorization"),
      ...(body ? { body } : {}),
    })
    if (route === "claim") return Response.json({ job: jobFor(String(body?.jid)) })
    if (route === "decline") return Response.json({ recorded: true })
    if (route === "report") return Response.json({ action: "continue" })
    if (route === "settle") {
      await hooks.settle?.(body ?? {})
      return Response.json({ settled: true })
    }
    if (route === "pending")
      return Response.json(hooks.pending(requests.filter((item) => item.route === "pending").length))
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })
  })
  const of = (route: string) => requests.filter((item) => item.route === route)
  return { requests, hooks, fetcher, of }
}

type EngineRoute = (url: URL, init?: RequestInit) => Response | Promise<Response>
type EngineCall = { method: string; path: string; search: string; headers: Headers; body?: Record<string, unknown> }

/**
 * GET /global/config, answered from `value` as it is when the request arrives; `hold` keeps that answer back. Any other
 * request is refused (a network error to the caller) unless `routes` answers it, keyed `METHOD /path`; those are
 * recorded in `calls`.
 */
function engineConfig(value: Config, routes: Record<string, EngineRoute> = {}) {
  const config: { value: Config; status: number; gets: number; hold?: Promise<void>; calls: EngineCall[] } = {
    value,
    status: 200,
    gets: 0,
    calls: [],
  }
  const fetcher = fetcherOf(async (url, init) => {
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`]
    if (route) {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      config.calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        headers: new Headers(init?.headers),
        ...(body ? { body } : {}),
      })
      return route(url, init)
    }
    if (url.pathname !== "/global/config" || init?.method) throw new Error("Only GET /global/config is read")
    if (new Headers(init?.headers).get("authorization") !== `Basic ${btoa("vector:owner-secret")}`)
      throw new Error("The owner's credentials are missing")
    config.gets += 1
    const status = config.status
    const snapshot = structuredClone(config.value)
    const hold = config.hold
    if (hold) await hold
    return status === 200 ? Response.json(snapshot) : Response.json({}, { status })
  })
  return { config, fetcher }
}

/** The engine's /global/event stream: `server.connected` first, as the engine sends it, then what the test pushes. */
function eventStream() {
  const queue: { payload: { type: string } }[] = []
  const subscriptions: AbortSignal[] = []
  const waiting: { wake?: () => void } = {}
  return {
    subscriptions,
    open: () => subscriptions.filter((signal) => !signal.aborted).length,
    push(type: string) {
      queue.push({ payload: { type } })
      waiting.wake?.()
    },
    async *events(signal: AbortSignal) {
      subscriptions.push(signal)
      yield { payload: { type: "server.connected" } }
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          waiting.wake = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    },
  }
}

function memoryLedger() {
  const store: { value?: RunnerLedger; reads: number; writes: number; verified: number; hold?: Promise<void> } = {
    reads: 0,
    writes: 0,
    verified: 0,
  }
  const real = createLedger({
    read: async () => {
      store.reads += 1
      return store.value
    },
    write: async (state) => {
      store.writes += 1
      store.value = state
    },
    now: () => Date.now(),
  })
  // Each offer that passed its signature check asks once for its single-use id. `hold` keeps it there: verified, but
  // neither recorded nor reserved yet.
  const ledger: typeof real = {
    ...real,
    useOnce: async (id, expiresAt) => {
      store.verified += 1
      await store.hold
      return real.useOnce(id, expiresAt)
    },
  }
  return { ledger, store }
}

type GitCall = { directory: string; method: string; args?: readonly string[] }
/** `base` and `hold` are read at each call, so a test can move origin/HEAD or hold a branch read open. */
type GitOptions = { base?: string; mapping?: RepositoryMapping; hold?: Promise<void> }
function fakeGit(calls: GitCall[], options: GitOptions = {}): RunnerDeps["git"] {
  return (directory) => {
    const record = (method: string, args?: readonly string[]) =>
      calls.push({ directory, method, ...(args ? { args } : {}) })
    const git: RunnerGit = {
      run: async (args) => {
        record("run", args)
        const answer = args[0] === "symbolic-ref" ? `${options.base ?? "origin/main"}\n` : ""
        await options.hold
        return answer
      },
      unchanged: async () => true,
      mapping: async () => {
        record("mapping")
        return options.mapping ?? "mapped"
      },
      snapshot: async (cwd) => ({
        directory: cwd ?? directory,
        gitDirectory: "/fixture/git",
        commonDirectory: "/fixture/common",
        config: [],
        pushUrl: "https://github.com/acme/app.git",
        baseSha: (cwd ? "b" : "a").repeat(40),
      }),
      fetch: async (_snapshot, base) => {
        record("fetch", [base])
        return "b".repeat(40)
      },
      stage: async () => ({ held: [], files: 1, diff: "diff --git a/file.ts b/file.ts\n" }),
      commit: async () => {
        record("commit")
        return undefined
      },
      push: async () => {
        record("push")
        return false
      },
    }
    return git
  }
}

/** A runner engine whose session stays busy until the runner aborts it. */
function holdingEngine() {
  const calls: string[] = []
  const prompted = deferred()
  const engine: RunnerDeps["engine"] = () => {
    const created: RunnerEngine = {
      create: async () => {
        calls.push("create")
        return `ses_everywhere${calls.filter((call) => call === "create").length}`
      },
      prompt: async () => {
        calls.push("prompt")
        prompted.resolve()
      },
      async *events(signal, ready) {
        ready()
        await prompted.promise
        yield { type: "session.status", properties: { sessionID: "ses_everywhere1", status: { type: "busy" } } }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      },
      abort: async () => {
        calls.push("abort")
      },
      rejectPermission: async () => {},
      rejectQuestion: async () => {},
      summary: async () => "Fixed retry handling.",
      posting: async (parts) => ({ status: "clean", parts }),
    }
    return created
  }
  return { engine, calls, prompted: prompted.promise }
}

const WORKTREE: SafeWorktree = {
  policy: "unattended-v1",
  create: async (input) => ({ directory: "/fixture/sandbox", from: input.from, branch: input.branch }),
}

/** A computer as startRemote builds it: the real link on the memory relay, the jobs module on fakes. */
function computer(
  initial: Config,
  options: {
    remote?: boolean
    /** "default": the module's own OFFER_KEYS. Otherwise these keys; omitted, the fixture's signing key. */
    keys?: "default" | Readonly<Record<string, string>>
    git?: GitOptions
    /** Read at each ticket request: a pending `hold` keeps the link connecting. */
    tickets?: { hold?: Promise<void> }
    token?: () => Promise<string | undefined>
    timing?: LinkDependencies["timing"]
    safeWorktree?: SafeWorktree
    runnerEngine?: RunnerDeps["engine"]
    /** "process": this process's own Vector Local policy (Egress.policy), as in the app. */
    localPolicy?: "process"
    /** The engine's other routes (EV-18's probes, the worktree route, the trust route). */
    engine?: Record<string, EngineRoute>
    power?: Parameters<typeof createEverywhereJobs>[0]["power"]
    preferences?: Parameters<typeof createEverywhereJobs>[0]["preferences"]
    createEverywhereSession?: Parameters<typeof createEverywhereJobs>[0]["createEverywhereSession"]
    now?: () => number
  } = {},
) {
  const relay = createMemoryRelay()
  const stored: { value?: RemoteIdentity } = {}
  const enabled = { value: options.remote ?? false }
  const minted: number[] = []
  const opened = { count: 0 }
  const statuses: RemoteStatus[] = []
  const logs: string[] = []
  const gitCalls: GitCall[] = []
  const events = eventStream()
  const engine = engineConfig(initial, options.engine)
  const service = jobsService()
  const memory = memoryLedger()
  const wiring = createEverywhereJobs({
    engine: { url: ENGINE, password: "owner-secret" },
    preferences: options.preferences,
    createEverywhereSession: options.createEverywhereSession,
    token: options.token ?? (async () => TOKEN),
    events: (signal) => events.events(signal),
    ledgerPath: "/fixture/user-data/everywhere/runner.json",
    ...(options.keys === "default" ? {} : { keys: options.keys ?? KEYS }),
    ledger: memory.ledger,
    service: { url: SERVICE, fetcher: service.fetcher },
    fetcher: engine.fetcher,
    git: fakeGit(gitCalls, options.git),
    runnerEngine:
      options.runnerEngine ??
      (options.createEverywhereSession
        ? undefined
        : () => {
            throw new Error("No unattended session may be created without the safe worktree")
          }),
    safeWorktree: options.safeWorktree,
    ...(options.localPolicy === "process" ? {} : { localPolicy: () => LocalPolicy.OFF }),
    ...(options.power ? { power: options.power } : {}),
    ...(options.now ? { now: options.now } : {}),
    log: (message) => logs.push(message),
  })
  const link = createRemoteLink({
    store: { read: async () => stored.value, write: async (identity) => void (stored.value = identity) },
    enabled: { get: () => enabled.value, set: (value) => void (enabled.value = value) },
    token: async () => TOKEN,
    // As startRemote: the ticket request is labelled `remote`, so Vector Local decides it and a block reads `local-off`.
    api: (url, init) =>
      Egress.fetch("remote", url, init, async (input) => {
        if (!String(input instanceof Request ? input.url : input).endsWith("/ticket")) return Response.json({})
        await options.tickets?.hold
        const identity = stored.value!
        relay.key(identity.device, identity.publicKey)
        minted.push(Date.now())
        return Response.json({ ticket: ticketFor("computer", identity.device), url: RELAY, protocol: "vector.v1" })
      }),
    // startRemote decides the relay's address as `remote` too; the fixture's relay address is not a Vector host.
    allowed: () => true,
    socket: (url, protocols) => {
      opened.count += 1
      return relay.socket(url, protocols)
    },
    engine: {
      request: async () => ({ status: 200, body: [] }),
      async *events(signal) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    },
    origin: ORIGIN,
    computerName: () => "Studio Mac",
    ...jobsForLink(wiring, (status) => statuses.push(status)),
    timing: options.timing ?? { heartbeatMs: 30, refreshMs: 60_000, batchMs: 20, retryMs: 10 },
  })
  return {
    relay,
    link,
    wiring,
    stored,
    enabled,
    minted,
    statuses,
    logs,
    gitCalls,
    events,
    config: engine.config,
    service,
    memory,
    sockets: () => opened.count,
    device: () => stored.value!.device,
    /** As startRemote: the link starts, then the jobs module with it. */
    begin() {
      void link.start()
      wiring.start(link)
    },
    stop() {
      wiring.stop()
      link.stop()
    },
  }
}

test("an offer frame reaches the runner, and without the safe worktree its claim settles held", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  try {
    // The consent step's stand-in: Remote turned on, which makes the identity.
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.link.status().state === "online")
    await until(() => env.service.of("pending").length === 1)
    const device = env.device()
    const jid = createJobId(Date.now())
    expect(env.relay.offer(signed(jid))).toBe(1)
    await until(() => env.service.of("settle").length === 1)
    // One more ask for waiting jobs follows the job.
    await until(() => env.service.of("pending").length === 2)
    expect(env.service.of("claim")).toEqual([
      { route: "claim", method: "POST", query: {}, device, authorization: `Bearer ${TOKEN}`, body: { jid, device } },
    ])
    expect(env.service.of("settle")[0]).toMatchObject({ device, authorization: `Bearer ${TOKEN}` })
    expect(env.service.of("settle")[0]?.body).toEqual({
      jid,
      lease: expect.any(String),
      outcome: "held",
      summary: HELD,
    })
    expect(
      env.service.requests.map((item) => item.route).filter((route) => route === "decline" || route === "report"),
    ).toEqual([])
    // The folder was mapped by the hardened check; nothing was fetched, committed or pushed, and no session made.
    expect(env.gitCalls.some((call) => ["fetch", "commit", "push"].includes(call.method))).toBe(false)
    expect((await env.memory.ledger.inspect()).jobs).toEqual([])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("the runner checks the new checkout before using the private session broker or explicit legacy fallback", async () => {
  const folders = await folderFixture()
  const bound = { version: 1, kind: "created", sessionID: "ses_bound" } as const
  const unavailable = { version: 1, kind: "unavailable" } as const
  const unsupported = { version: 1, kind: "unsupported" } as const
  const refused = { version: 1, kind: "refused" } as const
  const scenarios = [
    { trust: untrusted, replies: [unavailable, bound], path: "/session/ses_bound/prompt_async", legacy: false },
    { trust: untrusted, replies: [refused], path: undefined, legacy: false },
    { trust: untrusted, replies: [unavailable, unsupported], path: undefined, legacy: false },
    { trust: untrusted, replies: [unsupported], path: "/session/ses_legacy/prompt_async", legacy: true },
    { trust: answer({ trusted: true }), replies: [], path: undefined, legacy: false },
    { trust: answer({}, 503), replies: [], path: undefined, legacy: false },
  ] as const
  try {
    for (const scenario of scenarios) {
      const sent: EverywhereSessionWire.Request[] = []
      const listeners = new Set<(message: unknown) => void>()
      const sequence: string[] = []
      const broker = sessionRequester({
        send(message) {
          sequence.push("bind")
          const incoming = requestMessage(message, SESSION_MESSAGE)!
          const result = scenario.replies[sent.length]
          sent.push(incoming.request as EverywhereSessionWire.Request)
          for (const listener of listeners) listener({ type: SESSION_MESSAGE, id: incoming.id, result })
        },
        listen(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      })
      const env = computer(on(folders.project), {
        createEverywhereSession: broker,
        engine: {
          ...CAPABLE,
          "POST /experimental/worktree/unattended": (url, init) => {
            sequence.push("place")
            return created(url, init)
          },
          "GET /config/trust": (url, init) => {
            sequence.push("trust")
            expect(url.searchParams.get("directory")).toBe(SANDBOX)
            return scenario.trust(url, init)
          },
          "POST /session": () => {
            sequence.push("legacy create")
            return Response.json({ id: "ses_legacy" })
          },
          "GET /event": (_url, init) => {
            sequence.push("events")
            return new Response(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
                },
              }),
            )
          },
          "POST /session/ses_bound/prompt_async": () => new Response(null, { status: 503 }),
          "POST /session/ses_legacy/prompt_async": () => new Response(null, { status: 503 }),
          "POST /session/ses_bound/abort": () => Response.json(true),
          "POST /session/ses_legacy/abort": () => Response.json(true),
        },
      })
      try {
        await env.link.setEnabled(true)
        env.begin()
        await until(() => env.link.status().state === "online")
        const jid = createJobId(Date.now())
        expect(env.relay.offer(signed(jid))).toBe(1)
        await until(() => env.service.of("settle").length === 1)
        expect(sent).toHaveLength(scenario.replies.length)
        expect(sequence).toEqual([
          "place",
          "trust",
          ...scenario.replies.map(() => "bind"),
          ...(scenario.legacy ? ["legacy create"] : []),
          ...(scenario.path ? ["events"] : []),
        ])
        for (const message of sent) {
          expect([message.version, message.jid, message.directory, message.branch]).toEqual([
            1,
            jid,
            SANDBOX,
            branchFor(jid),
          ])
          expect(message.claim).toMatch(/^[a-f0-9]{64}$/)
        }
        expect(new Set(sent.map((message) => message.claim)).size).toBe(sent.length ? 1 : 0)
        expect(env.config.calls.some((call) => call.path === "/session")).toBe(scenario.legacy)
        expect(env.config.calls.find((call) => call.path.endsWith("/prompt_async"))?.path).toBe(scenario.path)
        expect(listeners.size).toBe(0)
      } finally {
        env.stop()
      }
    }
  } finally {
    await folders.cleanup()
  }
})

test("want() true keeps a connection for jobs alone, with only pings on it", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.link.status().state === "online")
    expect(env.wiring.want()).toBe(true)
    expect(env.wiring.state()).toBe("on")
    expect(env.link.status().phones).toEqual([])
    await sleep(100)
    expect(env.relay.online(env.device())).toBe(true)
    expect(env.link.status().state).toBe("online")
    expect(env.sockets()).toBe(1)
    expect(env.minted.length).toBe(1)
    expect(env.relay.texts.length).toBeGreaterThan(0)
    expect(env.relay.texts.every((text) => text === "ping")).toBe(true)
    expect(env.relay.seen).toEqual([])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("a reconnect asks for waiting jobs, so does a finished job, and each ask carries the readiness flags", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    const device = env.device()
    env.relay.drop(device, CLOSE.TICKET_EXPIRED)
    await until(() => env.service.of("pending").length === 2)
    expect(env.sockets()).toBe(2)
    env.relay.offer(signed())
    await until(() => env.service.of("settle").length === 1)
    await until(() => env.service.of("pending").length === 3)
    for (const ask of env.service.of("pending"))
      expect(ask).toEqual({ route: "pending", method: "GET", query: READY, device, authorization: `Bearer ${TOKEN}` })
    // "Disconnect all phones" makes a new identity: the next ask names the new device.
    await env.link.disconnectAll()
    await until(() => env.service.of("pending").length === 4)
    expect(env.device()).not.toBe(device)
    expect(env.service.of("pending")[3]?.device).toBe(env.device())
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("waiting jobs are asked for every five minutes, and no timer is left once jobs are off", async () => {
  // No project folder, so nothing here waits on the disk while the clock is fake.
  const env = computer({ everywhere: { enabled: true }, locked: [] }, { timing: {} })
  // The identity's keys are made under real timers.
  await env.link.setEnabled(true)
  jest.useFakeTimers()
  try {
    env.begin()
    await turns(() => env.link.status().state === "online")
    await turns(() => env.service.of("pending").length === 1)
    const device = env.device()
    await minutes(5)
    expect(env.service.of("pending").length).toBe(2)
    await minutes(5)
    expect(env.service.of("pending").length).toBe(3)
    expect(env.service.of("pending")[2]?.query.projects).toBe("0")
    // The settings page turns it off: PATCH /global/config, then the engine's `global.disposed`.
    env.config.value = { everywhere: { enabled: false }, locked: [] }
    env.events.push("global.disposed")
    await turns(() => env.wiring.state() === "off")
    await turns(() => !env.relay.online(device))
    await minutes(10)
    expect(env.service.of("pending").length).toBe(3)
    expect(env.link.status().state).toBe("ready")
    // Off leaves no timer of the jobs or of the link running, before anything is stopped. A minute passes first, so
    // each request's ten-second AbortSignal.timeout (a timer too) has lapsed.
    await minutes(1)
    expect(jest.getTimerCount()).toBe(0)
    env.stop()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    env.stop()
    jest.useRealTimers()
  }
})

test("a Remote the relay paused takes no job over pending either, until its link is online again", async () => {
  const env = computer({ everywhere: { enabled: true }, locked: [] }, { timing: {} })
  await env.link.setEnabled(true)
  jest.useFakeTimers()
  try {
    env.begin()
    await turns(() => env.link.status().state === "online")
    await turns(() => env.service.of("pending").length === 1)
    env.relay.drop(env.device(), CLOSE.REMOTE_PAUSED)
    await turns(() => env.link.status().state === "paused")
    // Jobs stay on, but the five-minute ask finds the link paused and sends nothing.
    expect(env.wiring.state()).toBe("on")
    await minutes(5)
    expect(env.link.status().state).toBe("paused")
    expect(env.service.of("pending").length).toBe(1)
    // The link tries again after ten minutes; once it is online the ask goes again and says Remote is connected.
    await minutes(6)
    await turns(() => env.link.status().state === "online")
    await turns(() =>
      env.service
        .of("pending")
        .slice(1)
        .some((ask) => ask.query.remote === "1"),
    )
  } finally {
    env.stop()
    jest.useRealTimers()
  }
})

test("with Remote blocked by Vector Local the link reads local-off, and the five-minute ask follows it", async () => {
  const env = computer({ everywhere: { enabled: true }, locked: [] }, { timing: {}, localPolicy: "process" })
  // The jobs service allowed, Remote not (its default): `pending` alone could reach jobs, so it must follow the link.
  allowing("everywhere")
  await env.link.setEnabled(true)
  jest.useFakeTimers()
  try {
    env.begin()
    await turns(() => env.link.status().state === "local-off")
    expect(env.wiring.state()).toBe("on")
    await minutes(11)
    expect(env.minted).toEqual([])
    expect(env.service.requests).toEqual([])
  } finally {
    env.stop()
    jest.useRealTimers()
  }
})

test("while the link is connecting again an ask still goes, and says Remote is not connected", async () => {
  const folders = await folderFixture()
  const tickets: { hold?: Promise<void> } = {}
  const env = computer(on(folders.project), { tickets })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    const minting = deferred()
    tickets.hold = minting.promise
    env.relay.drop(env.device(), CLOSE.TICKET_EXPIRED)
    await until(() => env.link.status().state === "connecting")
    // A job that ends meanwhile asks for the next one over HTTP, which a relay that drops does not stop.
    expect(await env.wiring.offer(signed())).toBe(true)
    await until(() => env.service.of("pending").length === 2)
    expect(env.service.of("pending")[1]?.query).toEqual({ ...READY, remote: "0" })
    minting.resolve()
    await until(() => env.service.of("pending").length === 3)
    expect(env.service.of("pending")[2]?.query).toEqual(READY)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("turning the toggle off aborts a running job through the runner's toggle path and closes the jobs connection", async () => {
  const folders = await folderFixture()
  const held = holdingEngine()
  const env = computer(on(folders.project), { safeWorktree: WORKTREE, runnerEngine: held.engine })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    const device = env.device()
    env.relay.offer(signed())
    await held.prompted
    const asked = env.service.of("pending").length
    env.config.value = off(folders.project)
    env.events.push("global.disposed")
    await until(() => env.service.of("settle").length === 1)
    expect(env.service.of("settle")[0]?.body).toMatchObject({ outcome: "cancelled" })
    expect(held.calls).toContain("abort")
    expect(env.gitCalls.some((call) => ["commit", "push"].includes(call.method))).toBe(false)
    expect(env.relay.online(device)).toBe(false)
    expect(env.link.status().state).toBe("ready")
    expect(env.wiring.state()).toBe("off")
    await sleep(100)
    expect(env.service.of("pending").length).toBe(asked)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("guard: OFFER_KEYS ships empty and is the module's default, so this computer tells the service it takes no jobs", async () => {
  // Meant to go red at the owner's key handoff (deviations, EV-17, "Owner action"): whoever pins the offer key updates
  // this guard case, and only it. The case below keeps testing an empty key set through `keys: {}`.
  expect(Object.keys(OFFER_KEYS)).toEqual([])
  const folders = await folderFixture()
  const env = computer(on(folders.project), { keys: "default" })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    expect(env.service.of("pending")[0]?.query).toEqual({ ...READY, jobs: "0" })
    expect(await env.wiring.offer(signed())).toBe(false)
    expect(env.service.requests.map((item) => item.route)).toEqual(["pending"])
    expect(env.memory.store.writes).toBe(0)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("with no offer key pinned every offer is refused before anything is sent or remembered", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project), { keys: {} })
  const waiting = signed()
  env.service.hooks.pending = () => ({ offers: [waiting], waiting: 1 })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    // The service is told this computer takes no jobs while no key is pinned.
    expect(env.service.of("pending")[0]?.query).toEqual({ ...READY, jobs: "0" })
    env.relay.offer(signed())
    expect(await env.wiring.offer(waiting)).toBe(false)
    expect(await env.wiring.offer(signed())).toBe(false)
    await sleep(100)
    expect(env.service.requests.map((item) => item.route)).toEqual(["pending"])
    expect(env.memory.store.writes).toBe(0)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("with the setting off, locked, malformed or unreadable, nothing connects, asks, reads the ledger or runs git", async () => {
  const folders = await folderFixture()
  const project = folders.project
  const cases: [string, Config, number][] = [
    ["absent", { locked: [] }, 200],
    ["off", off(project), 200],
    ["locked", { ...on(project), locked: ["everywhere"] }, 200],
    ["no lock list", { everywhere: on(project).everywhere }, 200],
    ["unknown key", on(project, { pushh: false }), 200],
    ["unreadable", on(project), 500],
  ]
  try {
    for (const [name, config, status] of cases) {
      const env = computer(config)
      env.config.status = status
      // A lease a crash left behind: nothing is settled for it while jobs are off.
      const jid = createJobId(Date.now())
      const lease = randomId()
      env.memory.store.value = {
        day: new Date().toISOString().slice(0, 10),
        count: 1,
        jobs: [{ jid, startedAt: Date.now(), lease }],
        offers: {},
        pending: [],
      }
      try {
        await env.link.setEnabled(true)
        env.begin()
        await until(() => env.config.gets >= 1)
        await sleep(100)
        const read = env.config.gets
        env.events.push("global.disposed")
        await until(() => env.config.gets > read)
        await sleep(100)
        expect({
          name,
          state: env.wiring.state(),
          want: env.wiring.want(),
          sockets: env.sockets(),
          minted: env.minted.length,
          requests: env.service.requests.length,
          reads: env.memory.store.reads,
          writes: env.memory.store.writes,
          git: env.gitCalls.length,
        }).toEqual({ name, state: "off", want: false, sockets: 0, minted: 0, requests: 0, reads: 0, writes: 0, git: 0 })
        // Jobs on: the stored lease is settled interrupted at the first "on", then waiting jobs are asked for.
        env.config.status = 200
        env.config.value = on(project)
        env.events.push("global.disposed")
        await until(() => env.service.of("pending").length === 1)
        expect(env.service.requests[0]?.route).toBe("settle")
        expect(env.service.requests[0]?.body).toMatchObject({ jid, lease, outcome: "interrupted" })
        expect((await env.memory.ledger.inspect()).jobs).toEqual([])
      } finally {
        env.stop()
      }
    }
  } finally {
    await folders.cleanup()
  }
})

test("the runner uses the supported sidecar settings and only falls back for explicit version skew", async () => {
  const folders = await folderFixture()
  type Preference = Awaited<ReturnType<NonNullable<Parameters<typeof createEverywhereJobs>[0]["preferences"]>>>
  let value: Preference = {
    version: 1,
    kind: "ready",
    snapshot: { revision: 1, everywhere: { enabled: false }, locked: [] },
  }
  const env = computer(on(folders.project), { preferences: async () => value })
  try {
    env.begin()
    expect(await env.wiring.refresh()).toBe("off")
    value = { version: 1, kind: "unavailable" }
    expect(await env.wiring.refresh()).toBe("off")
    value = { version: 1, kind: "unsupported" }
    expect(await env.wiring.refresh()).toBe("needs-remote")
    value = {
      version: 1,
      kind: "ready",
      snapshot: { revision: 2, everywhere: { enabled: true }, locked: ["everywhere"] },
    }
    expect(await env.wiring.refresh()).toBe("off")
    expect(env.sockets()).toBe(0)
    expect(env.service.requests).toEqual([])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("an offer that arrives while the last run's leases are recovered waits for them and is not declined busy", async () => {
  const folders = await folderFixture()
  const env = computer(off(folders.project))
  const stale = createJobId(Date.now())
  env.memory.store.value = {
    day: new Date().toISOString().slice(0, 10),
    count: 1,
    jobs: [{ jid: stale, startedAt: Date.now(), lease: randomId() }],
    offers: {},
    pending: [],
  }
  const recovery = deferred()
  env.service.hooks.settle = async (body) => {
    if (body.outcome === "interrupted") await recovery.promise
  }
  try {
    // A pairing keeps a connection, so an offer can arrive the moment jobs turn on.
    await env.link.startPairing()
    env.begin()
    await until(() => env.link.status().state === "online")
    env.config.value = on(folders.project)
    env.events.push("global.disposed")
    await until(() => env.service.of("settle").length === 1)
    const jid = createJobId(Date.now())
    env.relay.offer(signed(jid))
    await sleep(100)
    expect(env.service.of("claim")).toEqual([])
    recovery.resolve()
    await until(() => env.service.of("claim").length === 1)
    expect(env.service.of("claim")[0]?.body?.jid).toBe(jid)
    expect(env.service.of("decline")).toEqual([])
    await until(() => env.service.of("settle").length === 2)
    expect(env.service.of("settle")[1]?.body).toMatchObject({ jid, outcome: "held" })
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("with the setting off, a verified offer on a pairing's connection is declined off and nothing is claimed", async () => {
  const folders = await folderFixture()
  const env = computer(off(folders.project))
  try {
    env.begin()
    await env.link.startPairing()
    await until(() => env.link.status().state === "online")
    expect(env.wiring.state()).toBe("off")
    const jid = createJobId(Date.now())
    env.relay.offer(signed(jid))
    await until(() => env.service.of("decline").length === 1)
    expect(env.service.of("decline")[0]).toEqual({
      route: "decline",
      method: "POST",
      query: {},
      device: env.device(),
      authorization: `Bearer ${TOKEN}`,
      body: { jid, device: env.device(), reason: "off" },
    })
    await sleep(50)
    expect(env.service.requests.map((item) => item.route)).toEqual(["decline"])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("jobs on with Remote off is needs-remote and creates nothing until Remote is turned on", async () => {
  const folders = await folderFixture()
  const env = computer(off(folders.project))
  try {
    env.begin()
    await until(() => env.config.gets >= 1)
    await sleep(50)
    expect(env.wiring.state()).toBe("off")
    // Without Remote the engine's event stream is not kept open, so a settings change is read on request.
    expect(env.events.subscriptions).toEqual([])
    env.config.value = on(folders.project)
    expect(await env.wiring.refresh()).toBe("needs-remote")
    await sleep(50)
    expect(env.wiring.want()).toBe(false)
    expect(env.stored.value).toBeUndefined()
    expect(env.sockets()).toBe(0)
    expect(env.service.requests).toEqual([])
    expect({ reads: env.memory.store.reads, writes: env.memory.store.writes }).toEqual({ reads: 0, writes: 0 })
    // The listed folder is resolved already (deviations, EV-17 (h)): git's read-only mapping check and origin/HEAD,
    // once, in that folder, and nothing fetched, committed or pushed.
    expect(env.gitCalls.map((call) => call.args?.[0] ?? call.method)).toEqual(["mapping", "symbolic-ref"])
    // Asked again (the settings page, while Remote is off and no event stream is open), the folder is resolved afresh.
    expect(await env.wiring.refresh()).toBe("needs-remote")
    expect(env.gitCalls.map((call) => call.args?.[0] ?? call.method)).toEqual([
      "mapping",
      "symbolic-ref",
      "mapping",
      "symbolic-ref",
    ])
    // The consent step turns Remote on, which makes the identity; then jobs are on and waiting ones asked for.
    await env.link.setEnabled(true)
    await until(() => env.link.status().state === "online")
    await until(() => env.service.of("pending").length === 1)
    expect(env.wiring.state()).toBe("on")
    expect(env.events.open()).toBe(1)
    await sleep(50)
    expect(env.service.of("pending").length).toBe(1)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("the same offer twice at once is verified once and claimed once", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    const offer = signed()
    expect(await Promise.all([env.wiring.offer(offer), env.wiring.offer(offer)])).toEqual([true, false])
    expect(env.memory.store.verified).toBe(1)
    expect(env.service.of("claim").length).toBe(1)
    expect(Object.keys(env.memory.store.value?.offers ?? {})).toHaveLength(1)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("under Vector Local, no ask goes while it blocks the jobs service, and one that goes says Local blocks jobs", async () => {
  const folders = await folderFixture()
  // Remote allowed and the jobs service blocked (its default): the link is online, and nothing is sent or logged.
  const blocked = computer(on(folders.project), { localPolicy: "process" })
  // Only this case's events: the network log is the process's, and earlier cases write to it too.
  const earlier = new Set(Egress.events().map((event) => event.id))
  try {
    allowing("remote")
    await blocked.link.setEnabled(true)
    blocked.begin()
    await until(() => blocked.link.status().state === "online")
    await sleep(100)
    expect(blocked.service.requests).toEqual([])
    expect(Egress.events().filter((event) => event.source === "everywhere" && !earlier.has(event.id))).toEqual([])
  } finally {
    blocked.stop()
  }
  // Both allowed, the rest not: the ask goes, and says Vector Local blocks laptop jobs here.
  const allowed = computer(on(folders.project), { localPolicy: "process" })
  try {
    allowing("everywhere", "remote")
    await allowed.link.setEnabled(true)
    allowed.begin()
    await until(() => allowed.service.of("pending").length === 1)
    expect(allowed.service.of("pending")[0]?.query).toEqual({ ...READY, local: "1" })
  } finally {
    allowed.stop()
    await folders.cleanup()
  }
})

test("a sign-in that cannot be read counts as none: nothing is asked or claimed", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project), {
    token: async () => {
      throw new Error("The operating system credential store is locked")
    },
  })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.link.status().state === "online")
    await sleep(100)
    expect(await env.wiring.offer(signed())).toBe(false)
    env.relay.offer(signed())
    await sleep(50)
    expect(env.service.requests).toEqual([])
    expect(env.logs).not.toContain("Vector everywhere could not ask for waiting jobs.")
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("with room for two, both offers of one answer are claimed at once; with room for one, one is handed on", async () => {
  const folders = await folderFixture()
  const held = holdingEngine()
  const two = computer(on(folders.project, { at_once: 2 }), { safeWorktree: WORKTREE, runnerEngine: held.engine })
  const first = createJobId(Date.now())
  const second = createJobId(Date.now() + 1)
  two.service.hooks.pending = (count) => ({ offers: count === 1 ? [signed(first), signed(second)] : [], waiting: 2 })
  try {
    await two.link.setEnabled(true)
    two.begin()
    // Both are claimed while the first job is still running: the second offer does not wait for it.
    await until(() => two.service.of("claim").length === 2)
    expect(held.calls.includes("abort")).toBe(false)
    expect(
      two.service
        .of("claim")
        .map((item) => String(item.body?.jid))
        .sort(),
    ).toEqual([first, second].sort())
    expect(two.service.of("decline")).toEqual([])
  } finally {
    two.stop()
  }
  await until(() => two.service.of("settle").length === 2)
  const one = computer(on(folders.project))
  one.service.hooks.pending = (count) => ({ offers: count === 1 ? [signed(), signed()] : [], waiting: 2 })
  try {
    await one.link.setEnabled(true)
    one.begin()
    await until(() => one.service.of("settle").length === 1)
    await until(() => one.service.of("pending").length === 2)
    await sleep(50)
    // The second waited out its offer on the server instead of being declined busy here.
    expect(one.service.of("claim").length).toBe(1)
    expect(one.service.of("decline")).toEqual([])
  } finally {
    one.stop()
    await folders.cleanup()
  }
})

test("an ask counts an offer still being verified, so a reconnect then hands on nothing to be declined busy", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  const first = createJobId(Date.now())
  env.service.hooks.pending = (count) =>
    count === 1
      ? { offers: [signed(first)], waiting: 1 }
      : count === 2
        ? { offers: [signed()], waiting: 2 }
        : { offers: [], waiting: 0 }
  const verifying = deferred()
  env.memory.store.hold = verifying.promise
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.memory.store.verified === 1)
    // The relay reconnects while the first offer is verified but not yet reserved: the room is one, and it is taken.
    env.relay.drop(env.device(), CLOSE.TICKET_EXPIRED)
    await until(() => env.service.of("pending").length === 2)
    await sleep(50)
    expect(env.service.of("pending")[1]?.query).toEqual({ ...READY, room: "0" })
    expect(env.memory.store.verified).toBe(1)
    verifying.resolve()
    await until(() => env.service.of("settle").length === 1)
    await until(() => env.service.of("pending").length === 3)
    await sleep(50)
    expect(env.service.of("claim").map((item) => item.body?.jid)).toEqual([first])
    expect(env.service.of("decline")).toEqual([])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("two jobs that end together ask twice, and the second answer is not handed on past the room the first took", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project, { at_once: 2 }))
  const verifying = deferred()
  env.service.hooks.pending = (count) => {
    // From the second answer on, every offer is held once verified, so the ask after it sees them unreserved.
    if (count === 2) env.memory.store.hold = verifying.promise
    return count <= 3 ? { offers: [signed(), signed()], waiting: 2 } : { offers: [], waiting: 0 }
  }
  try {
    await env.link.setEnabled(true)
    env.begin()
    // Both offers of the first answer are claimed and settle held (no safe worktree), and each job's end asks again.
    await until(() => env.service.of("settle").length === 2)
    await until(() => env.service.of("pending").length === 3)
    await sleep(100)
    const handed = env.memory.store.verified - 2
    expect(handed).toBeGreaterThanOrEqual(1)
    expect(handed).toBeLessThanOrEqual(2)
    verifying.resolve()
    await until(() => env.service.of("settle").length === 2 + handed)
    await sleep(50)
    expect(env.service.of("claim").length).toBe(2 + handed)
    expect(env.service.of("decline")).toEqual([])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("a settings change that lands while a read is in flight is read again, never answered from before it", async () => {
  const folders = await folderFixture()
  const env = computer(on(folders.project))
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    // Quiet first: the start's read and the event stream's `server.connected` read are done.
    await sleep(50)
    const device = env.device()
    const hold = deferred()
    env.config.hold = hold.promise
    const before = env.config.gets
    env.events.push("global.disposed")
    await until(() => env.config.gets === before + 1)
    env.config.hold = undefined
    // The PATCH lands while that read is held open, and the engine says so again.
    env.config.value = off(folders.project)
    env.events.push("global.disposed")
    await sleep(20)
    hold.resolve()
    await until(() => env.wiring.state() === "off")
    await until(() => !env.relay.online(device))
    expect(env.config.gets).toBe(before + 2)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("a config change that lands while a folder is resolved resolves it again, so no base from before it is kept", async () => {
  const folders = await folderFixture()
  const git: GitOptions = { base: "origin/main" }
  const held = holdingEngine()
  const env = computer(on(folders.project), { git, safeWorktree: WORKTREE, runnerEngine: held.engine })
  const branchReads = () => env.gitCalls.filter((call) => call.args?.[0] === "symbolic-ref").length
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    // Quiet first: the start's read and the event stream's `server.connected` read are done.
    await sleep(50)
    const before = branchReads()
    const reading = deferred()
    git.hold = reading.promise
    env.events.push("global.disposed")
    await until(() => branchReads() === before + 1)
    git.hold = undefined
    // origin/HEAD moves and the engine says its config changed while that branch read is still held.
    git.base = "origin/release"
    env.events.push("global.disposed")
    await sleep(20)
    reading.resolve()
    await until(() => branchReads() === before + 2)
    // A job claimed now fetches the new base, never the one read before the change.
    env.relay.offer(signed())
    await held.prompted
    expect(env.gitCalls.filter((call) => call.method === "fetch").map((call) => call.args)).toEqual([["release"]])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("settings come from the user's own block, field by field, and an off block resolves no folder", async () => {
  const folders = await folderFixture()
  const calls: GitCall[] = []
  const folder = projectFolder(fakeGit(calls))
  const project = folders.project
  try {
    const defaults = await everywhereSettings(on(project), folder)
    expect(defaults).toEqual({
      enabled: true,
      modelAllowed: true,
      maxUsd: ConfigEverywhereV1.Defaults.max_usd,
      minutes: ConfigEverywhereV1.Defaults.minutes,
      atOnce: ConfigEverywhereV1.Defaults.at_once,
      perDay: ConfigEverywhereV1.Defaults.per_day,
      push: true,
      waitForComputer: true,
      stayAwake: false,
      projects: [{ directory: await realpath(project), repository: "acme/app", base: "main" }],
    })
    const chosen = await everywhereSettings(
      on(project, {
        max_usd: 7.5,
        minutes: 30,
        at_once: 2,
        per_day: 9,
        push: false,
        wait_for_computer: false,
        stay_awake: true,
        model: "openrouter/vendor/model-x",
      }),
      folder,
    )
    expect(chosen).toMatchObject({
      maxUsd: 7.5,
      minutes: 30,
      atOnce: 2,
      perDay: 9,
      push: false,
      waitForComputer: false,
      stayAwake: true,
      model: { providerID: "openrouter", modelID: "vendor/model-x" },
    })
    // Off, locked, unlisted locks, an unknown key and more than 64 folders are all off, and no folder is resolved.
    calls.length = 0
    const many = Array.from({ length: 70 }, (_, index) => ({
      directory: `${project}-${index}`,
      repository: "acme/app",
    }))
    for (const config of [
      off(project),
      { ...on(project), locked: ["everywhere"] },
      { everywhere: on(project).everywhere },
      on(project, { pushh: false }),
      { everywhere: { enabled: true, projects: many }, locked: [] },
      undefined,
    ]) {
      const settings = await everywhereSettings(config, folder)
      expect({ enabled: settings.enabled, projects: settings.projects }).toEqual({ enabled: false, projects: [] })
    }
    expect(calls).toEqual([])
  } finally {
    await folders.cleanup()
  }
})

test("each listed folder is resolved to its canonical path and default branch, or left out", async () => {
  const folders = await folderFixture()
  const project = folders.project
  const link = path.join(folders.root, "app-link")
  await symlink(project, link)
  const real = await realpath(project)
  const list = (...directories: string[]) => ({
    everywhere: { enabled: true, projects: directories.map((directory) => ({ directory, repository: "acme/app" })) },
    locked: [],
  })
  try {
    // A folder and a link to it are one folder.
    const calls: GitCall[] = []
    const both = await everywhereSettings(list(project, link), projectFolder(fakeGit(calls)))
    expect(both.projects).toEqual([{ directory: real, repository: "acme/app", base: "main" }])
    expect(calls.every((call) => call.directory === real)).toBe(true)
    // A missing folder is left out before git runs.
    calls.length = 0
    expect(
      (await everywhereSettings(list(path.join(folders.root, "missing")), projectFolder(fakeGit(calls)))).projects,
    ).toEqual([])
    expect(calls).toEqual([])
    // A folder git does not map to its repository is left out, and its branch is never read.
    calls.length = 0
    const other = projectFolder(fakeGit(calls, { mapping: "other-repository" }))
    expect((await everywhereSettings(list(project), other)).projects).toEqual([])
    expect(calls.map((call) => call.method)).toEqual(["mapping"])
    // The base is origin/HEAD's branch, by the runner's base rule.
    for (const [answer, base] of [
      ["origin/release/2.0", "release/2.0"],
      ["origin/../main", undefined],
      ["upstream/main", undefined],
      ["", undefined],
    ] as const) {
      const settings = await everywhereSettings(list(project), projectFolder(fakeGit([], { base: answer })))
      expect({ answer, projects: settings.projects }).toEqual({
        answer,
        projects: base ? [{ directory: real, repository: "acme/app", base }] : [],
      })
    }
  } finally {
    await folders.cleanup()
  }
})

// EV-18: the probe-gated safe worktree, the offline shell and the shared keep-awake, through the same composition.

const SANDBOX = "/fixture/user-data/everywhere-worktree/project/job"
const UNAVAILABLE =
  "This computer could not take the job: its repository must be listed for Vector everywhere, open in Vector and trusted. No changes were pushed."
const ENDED = "The unattended job ended without publishing changes."
const answer =
  (body: unknown, status = 200): EngineRoute =>
  () =>
    Response.json(body, { status })
const probes = (worktree: EngineRoute, shell: EngineRoute) => ({
  "GET /experimental/worktree/unattended": worktree,
  "GET /experimental/shell/unattended": shell,
})
const CAPABLE = probes(answer({ policy: "unattended-v1" }), answer({ shell: "offline-v1" }))
/** The engine's create route: the job's own branch and base, in a folder under its data folder. */
const created: EngineRoute = (_, init) => {
  const body = JSON.parse(String(init?.body)) as { branch: string; base: string }
  return Response.json({ directory: SANDBOX, branch: body.branch, base: body.base })
}
const untrusted = answer({ workspace: SANDBOX, trusted: false, ignored: true, settings: true, approvable: true })
const decide = (rules: readonly PermissionV1.Rule[], permission: string, pattern = "*") =>
  rules.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))?.action

/** holdingEngine, recording each session's folder and ruleset. */
function sessionEngine() {
  const held = holdingEngine()
  const sessions: { directory: string; rules: readonly PermissionV1.Rule[] }[] = []
  const engine: RunnerDeps["engine"] = (directory) => {
    const inner = held.engine(directory)
    return {
      ...inner,
      create: (job, rules) => {
        sessions.push({ directory, rules })
        return inner.create(job, rules)
      },
    }
  }
  return { ...held, engine, sessions }
}

test("the safe worktree is offered only while the engine's probe reports unattended-v1, and never falls back", async () => {
  const folders = await folderFixture()
  const project = await realpath(folders.project)
  const refused = () => {
    throw new Error("POST /experimental/worktree is never called")
  }
  // An engine without the route: its probe answers 404.
  const none = computer(on(folders.project), {
    engine: {
      ...probes(answer({}, 404), answer({ shell: "none" })),
      "POST /experimental/worktree/unattended": created,
      "POST /experimental/worktree": refused,
    },
  })
  try {
    await none.link.setEnabled(true)
    none.begin()
    await until(() => none.service.of("pending").length === 1)
    // It still tells the service it takes jobs (deviations, EV-18 (n)), and a claimed job settles held.
    expect(none.service.of("pending")[0]?.query).toEqual(READY)
    const jid = createJobId(Date.now())
    none.relay.offer(signed(jid))
    await until(() => none.service.of("settle").length === 1)
    expect(none.service.of("settle")[0]?.body).toEqual({
      jid,
      lease: expect.any(String),
      outcome: "held",
      summary: HELD,
    })
    expect(none.config.calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual([
      "GET /experimental/shell/unattended",
      "GET /experimental/worktree/unattended",
    ])
  } finally {
    none.stop()
  }

  // The probe says unattended-v1: the job's checkout comes from the owner-only route, then the trust check.
  const session = sessionEngine()
  const env = computer(on(folders.project), {
    engine: {
      ...probes(answer({ policy: "unattended-v1" }), answer({ shell: "none" })),
      "POST /experimental/worktree/unattended": created,
      "GET /config/trust": untrusted,
      "POST /experimental/worktree": refused,
    },
    runnerEngine: session.engine,
  })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.service.of("pending").length === 1)
    const jid = createJobId(Date.now())
    env.relay.offer(signed(jid))
    await session.prompted
    const calls = env.config.calls.filter((call) => !call.path.endsWith("/unattended") || call.method === "POST")
    expect(
      calls.map((call) => ({ method: call.method, path: call.path, search: call.search, body: call.body })),
    ).toEqual([
      {
        method: "POST",
        path: "/experimental/worktree/unattended",
        search: "",
        body: { directory: project, base: "b".repeat(40), branch: branchFor(jid), jid },
      },
      { method: "GET", path: "/config/trust", search: `?directory=${encodeURIComponent(SANDBOX)}`, body: undefined },
    ])
    for (const call of env.config.calls) {
      expect(call.headers.get("authorization")).toBe(`Basic ${btoa("vector:owner-secret")}`)
      expect(call.headers.has("x-vector-guest-request")).toBe(false)
    }
    // The session is made in the checkout the route returned, with the shell denied (the probe said none).
    expect(session.sessions.map((item) => item.directory)).toEqual([SANDBOX])
    expect(decide(session.sessions[0]!.rules, "bash", "bun test")).toBe("deny")
    expect(env.gitCalls.filter((call) => call.method === "fetch")).toEqual([
      { directory: project, method: "fetch", args: ["main"] },
    ])
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("a project the engine refuses is held; a trusted, malformed or failed checkout is never used", async () => {
  const folders = await folderFixture()
  const cases: {
    name: string
    routes: Record<string, EngineRoute>
    outcome: string
    summary: string
    trust: number
  }[] = [
    {
      name: "not open in Vector",
      routes: {
        "POST /experimental/worktree/unattended": answer({ message: "This project is not open in Vector." }, 403),
      },
      outcome: "held",
      summary: UNAVAILABLE,
      trust: 0,
    },
    {
      name: "trusted",
      routes: {
        "POST /experimental/worktree/unattended": created,
        "GET /config/trust": answer({
          workspace: SANDBOX,
          trusted: true,
          ignored: false,
          settings: true,
          approvable: true,
        }),
      },
      outcome: "failed",
      summary: ENDED,
      trust: 1,
    },
    {
      name: "trust unreadable",
      routes: { "POST /experimental/worktree/unattended": created, "GET /config/trust": answer({}, 500) },
      outcome: "failed",
      summary: ENDED,
      trust: 1,
    },
    {
      name: "an extra key",
      routes: {
        "POST /experimental/worktree/unattended": (url, init) =>
          Promise.resolve(created(url, init)).then(async (response) =>
            Response.json({ ...((await response.json()) as object), start: "npm install" }),
          ),
        "GET /config/trust": untrusted,
      },
      outcome: "failed",
      summary: ENDED,
      trust: 0,
    },
    {
      name: "a relative folder",
      routes: {
        "POST /experimental/worktree/unattended": (_, init) => {
          const body = JSON.parse(String(init?.body)) as { branch: string; base: string }
          return Response.json({ directory: "everywhere-worktree/job", branch: body.branch, base: body.base })
        },
        "GET /config/trust": untrusted,
      },
      outcome: "failed",
      summary: ENDED,
      trust: 0,
    },
    {
      name: "an engine error",
      routes: { "POST /experimental/worktree/unattended": answer({}, 500) },
      outcome: "failed",
      summary: ENDED,
      trust: 0,
    },
  ]
  try {
    for (const item of cases) {
      const session = sessionEngine()
      const env = computer(on(folders.project), {
        engine: { ...CAPABLE, ...item.routes },
        runnerEngine: session.engine,
      })
      try {
        await env.link.setEnabled(true)
        env.begin()
        await until(() => env.service.of("pending").length === 1)
        const jid = createJobId(Date.now())
        env.relay.offer(signed(jid))
        await until(() => env.service.of("settle").length === 1)
        expect({ name: item.name, settle: env.service.of("settle")[0]?.body }).toEqual({
          name: item.name,
          settle: { jid, lease: expect.any(String), outcome: item.outcome, summary: item.summary },
        })
        expect({ name: item.name, sessions: session.sessions }).toEqual({ name: item.name, sessions: [] })
        expect(env.config.calls.filter((call) => call.path === "/config/trust")).toHaveLength(item.trust)
        expect(env.config.calls.some((call) => call.path === "/experimental/worktree")).toBe(false)
      } finally {
        env.stop()
      }
    }
  } finally {
    await folders.cleanup()
  }
})

test("bash is allowed only on the engine's offline-v1 with no company lock on a key with rules, and pending says so", async () => {
  const folders = await folderFixture()
  const permission = { "*": "allow", bash: { "rm *": "deny" } }
  // A lock on any key that can carry permission rules: the company's values are not in the answer.
  const cases = [
    { name: "offline-v1", shell: "offline-v1", locked: [], sandbox: "1", bash: "allow" },
    { name: "company lock on permission", shell: "offline-v1", locked: ["permission"], sandbox: "0", bash: "deny" },
    { name: "company lock on agent", shell: "offline-v1", locked: ["agent"], sandbox: "0", bash: "deny" },
    { name: "company lock on mode", shell: "offline-v1", locked: ["mode"], sandbox: "0", bash: "deny" },
    { name: "company lock on tools", shell: "offline-v1", locked: ["tools"], sandbox: "0", bash: "deny" },
    {
      name: "company lock on default_agent",
      shell: "offline-v1",
      locked: ["default_agent"],
      sandbox: "0",
      bash: "deny",
    },
    { name: "other locks only", shell: "offline-v1", locked: ["share", "model"], sandbox: "1", bash: "allow" },
    { name: "none", shell: "none", locked: [], sandbox: "0", bash: "deny" },
  ] as const
  try {
    for (const item of cases) {
      const session = sessionEngine()
      const env = computer(
        { ...on(folders.project), permission, locked: item.locked },
        {
          engine: {
            ...probes(answer({ policy: "unattended-v1" }), answer({ shell: item.shell })),
            "POST /experimental/worktree/unattended": created,
            "GET /config/trust": untrusted,
          },
          runnerEngine: session.engine,
        },
      )
      try {
        await env.link.setEnabled(true)
        env.begin()
        await until(() => env.service.of("pending").length === 1)
        expect({ name: item.name, query: env.service.of("pending")[0]?.query }).toEqual({
          name: item.name,
          query: { ...READY, sandbox: item.sandbox },
        })
        env.relay.offer(signed())
        await session.prompted
        const rules = session.sessions[0]!.rules
        expect({ name: item.name, bash: decide(rules, "bash", "bun test") }).toEqual({
          name: item.name,
          bash: item.bash,
        })
        // The user's own shell deny holds, and nothing reopens the unsandboxed shell or a terminal.
        expect(decide(rules, "bash", "rm -rf src")).toBe("deny")
        for (const id of ["unsandboxed_shell", "terminal", "terminal_input", "mcp_fixture", "connect_write"])
          expect({ id, action: decide(rules, id) }).toEqual({ id, action: "deny" })
        // Exactly the ruleset built from the user's own rules, with the shell the engine's answer allows.
        const user = await everywhereSettings({ ...on(folders.project), permission, locked: [] }, async () => undefined)
        expect(rules).toEqual(unattendedRules(user.rules, item.bash === "allow" ? "offline-v1" : "none"))
      } finally {
        env.stop()
      }
    }
  } finally {
    await folders.cleanup()
  }
})

test("the probes run only while the block is on; a definite answer is kept, and none is asked again a minute later", async () => {
  const folders = await folderFixture()
  const clock = { offset: 0 }
  const answers = {
    worktree: [answer({}, 404)] as EngineRoute[],
    shell: [() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))] as EngineRoute[],
  }
  const env = computer(off(folders.project), {
    engine: probes(
      (url, init) => (answers.worktree.shift() ?? answer({ policy: "unattended-v1" }))(url, init),
      (url, init) => (answers.shell.shift() ?? answer({ shell: "offline-v1" }))(url, init),
    ),
    now: () => Date.now() + clock.offset,
  })
  const asked = () => env.config.calls.map((call) => call.path.split("/")[2])
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.config.gets >= 1)
    await sleep(50)
    // Off: the engine is not asked.
    expect(env.config.calls).toEqual([])
    env.config.value = on(folders.project)
    env.events.push("global.disposed")
    await until(() => env.service.of("pending").length === 1)
    // A 404 is a definite no; the shell probe timed out, so no shell yet.
    expect(asked().sort()).toEqual(["shell", "worktree"])
    expect(env.service.of("pending")[0]?.query.sandbox).toBe("0")
    // Within the minute, later reads ask nothing.
    const reads = env.config.gets
    env.events.push("global.disposed")
    await until(() => env.config.gets > reads)
    await sleep(50)
    expect(asked()).toHaveLength(2)
    // A minute on, the next read asks again: the shell answers, and the 404 is kept though the route now answers.
    clock.offset = 61_000
    env.events.push("global.disposed")
    await until(() => asked().length === 4)
    await sleep(50)
    env.relay.drop(env.device(), CLOSE.TICKET_EXPIRED)
    await until(() => env.service.of("pending").length === 2)
    expect(env.service.of("pending")[1]?.query.sandbox).toBe("1")
    // The kept 404 still gives no worktree, so a job is held before any checkout is asked for.
    const jid = createJobId(Date.now())
    env.relay.offer(signOffer(SIGNING, { account: ACCOUNT, jid, now: Date.now() + clock.offset }).offer)
    await until(() => env.service.of("settle").length === 1)
    expect(env.service.of("settle")[0]?.body).toEqual({
      jid,
      lease: expect.any(String),
      outcome: "held",
      summary: HELD,
    })
    expect(asked()).toHaveLength(4)
    // Both answered: nothing more is asked, whatever is read.
    const settled = env.config.gets
    env.events.push("global.disposed")
    env.events.push("global.disposed")
    await until(() => env.config.gets >= settled + 2)
    await sleep(50)
    expect(asked()).toHaveLength(4)
    // A new engine stream asks afresh, and waits for the answer.
    env.events.push("server.connected")
    await until(() => asked().length === 6)
    // Off again: nothing is asked.
    env.config.value = off(folders.project)
    env.events.push("server.connected")
    await until(() => env.wiring.state() === "off")
    await sleep(50)
    expect(asked()).toHaveLength(6)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("the rules are the user's own tools denies, permission block and their default agent's asks and denies; one that does not decode is off", async () => {
  const folders = await folderFixture()
  const calls: GitCall[] = []
  const folder = projectFolder(fakeGit(calls))
  const project = folders.project
  const home = os.homedir()
  try {
    const settings = await everywhereSettings(
      {
        ...on(project),
        tools: { write: false, webfetch: true, glob: false },
        permission: {
          "*": "allow",
          edit: { "~/notes/*": "deny", "$HOME/keys": "deny", "$HOMEWORK/*": "deny", "~": "deny", "src/*": "allow" },
          bash: "ask",
        },
        agent: {
          build: {
            permission: { bash: { "curl *": "deny", "git push*": "ask", "*": "allow" }, read: "deny", edit: "ask" },
          },
          plan: { permission: { edit: "deny" } },
        },
        mode: { build: { permission: { grep: { "dist/*": "ask", "*": "allow" } } } },
      },
      folder,
    )
    expect(settings.enabled).toBe(true)
    expect(settings.rules).toEqual([
      // The legacy tools map's switched-off tools, `write` as `edit`, under the block; a switched-on one adds nothing.
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "glob", pattern: "*", action: "deny" },
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: `${home}/notes/*`, action: "deny" },
      { permission: "edit", pattern: `${home}/keys`, action: "deny" },
      { permission: "edit", pattern: `${home}WORK/*`, action: "deny" },
      { permission: "edit", pattern: home, action: "deny" },
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      // The default agent's own block, then its legacy `mode` block, give only their asks and denies.
      { permission: "bash", pattern: "curl *", action: "deny" },
      { permission: "bash", pattern: "git push*", action: "ask" },
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "grep", pattern: "dist/*", action: "ask" },
    ])
    // `default_agent` names the agent whose asks and denies count, in both blocks; a bare action is every pattern.
    const plan = await everywhereSettings(
      {
        ...on(project),
        permission: "deny",
        default_agent: "plan",
        agent: { plan: { permission: { edit: "deny" } }, build: { permission: { read: "deny" } } },
        mode: { plan: { permission: { bash: "ask" } } },
      },
      folder,
    )
    expect(plan.rules).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
    ])
    // A block that does not decode, at the top, in the tools map, the agent or its mode, is off, and no folder is resolved.
    calls.length = 0
    for (const config of [
      { ...on(project), permission: { bash: "sometimes" } },
      { ...on(project), permission: ["allow"] },
      { ...on(project), tools: { bash: "no" } },
      { ...on(project), agent: { build: { permission: { edit: 1 } } } },
      { ...on(project), mode: { build: { permission: { edit: 1 } } } },
    ]) {
      const off = await everywhereSettings(config, folder)
      expect({ enabled: off.enabled, projects: off.projects, rules: off.rules }).toEqual({
        enabled: false,
        projects: [],
        rules: undefined,
      })
    }
    expect(calls).toEqual([])
  } finally {
    await folders.cleanup()
  }
})

test("stay awake holds the desktop's shared blocker only while jobs and the option are on and the computer is plugged in", async () => {
  const folders = await folderFixture()
  const blocker: string[] = []
  const ids = { next: 0 }
  setDesktopWorkBlocker({
    start: () => {
      ids.next += 1
      blocker.push(`start ${ids.next}`)
      return ids.next
    },
    stop: (id) => void blocker.push(`stop ${id}`),
  })
  const listeners = new Set<() => void>()
  const power = {
    battery: false,
    subscribed: 0,
    set(battery: boolean) {
      power.battery = battery
      for (const listener of [...listeners]) listener()
    },
  }
  const env = computer(on(folders.project, { stay_awake: true }), {
    power: {
      onBattery: () => power.battery,
      changed: (listener) => {
        power.subscribed += 1
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
  })
  try {
    // Remote off: jobs are not on, so nothing is held and power is not watched.
    env.begin()
    await until(() => env.wiring.state() === "needs-remote")
    expect(blocker).toEqual([])
    expect(power.subscribed).toBe(0)
    await env.link.setEnabled(true)
    await until(() => env.wiring.state() === "on")
    expect(blocker).toEqual(["start 1"])
    // The option turned off on the settings page: released with no state change.
    env.config.value = on(folders.project, { stay_awake: false })
    env.events.push("global.disposed")
    await until(() => blocker.length === 2)
    expect(blocker).toEqual(["start 1", "stop 1"])
    expect(listeners.size).toBe(0)
    env.config.value = on(folders.project, { stay_awake: true })
    env.events.push("global.disposed")
    await until(() => blocker.length === 3)
    // Unplugged, then plugged in again.
    power.set(true)
    power.set(false)
    expect(blocker).toEqual(["start 1", "stop 1", "start 2", "stop 2", "start 3"])
    // Remote turned off: jobs are no longer on.
    await env.link.setEnabled(false)
    await until(() => blocker.length === 6)
    expect(blocker.at(-1)).toBe("stop 3")
    await env.link.setEnabled(true)
    await until(() => blocker.length === 7)
    // Stopping the jobs releases it and stops watching power, before the link stops.
    env.wiring.stop()
    expect(blocker).toEqual(["start 1", "stop 1", "start 2", "stop 2", "start 3", "stop 3", "start 4", "stop 4"])
    expect(listeners.size).toBe(0)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})

test("stay awake lets the computer sleep while its link cannot deliver offers, though jobs stay on", async () => {
  const folders = await folderFixture()
  const blocker: string[] = []
  const ids = { next: 0 }
  setDesktopWorkBlocker({
    start: () => {
      ids.next += 1
      blocker.push(`start ${ids.next}`)
      return ids.next
    },
    stop: (id) => void blocker.push(`stop ${id}`),
  })
  const listeners = new Set<() => void>()
  const tickets: { hold?: Promise<void> } = {}
  const env = computer(on(folders.project, { stay_awake: true }), {
    tickets,
    power: {
      onBattery: () => false,
      changed: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
  })
  try {
    await env.link.setEnabled(true)
    env.begin()
    await until(() => env.link.status().state === "online")
    expect(blocker).toEqual(["start 1"])
    // Paused by the service: the relay delivers nothing, so the hold goes and power is not watched.
    env.relay.drop(env.device(), CLOSE.REMOTE_PAUSED)
    await until(() => env.link.status().state === "paused")
    expect(env.wiring.state()).toBe("on")
    expect(blocker).toEqual(["start 1", "stop 1"])
    expect(listeners.size).toBe(0)
    // Remote off and on again: held again from the moment the link connects.
    await env.link.setEnabled(false)
    await env.link.setEnabled(true)
    await until(() => env.link.status().state === "online")
    expect(blocker).toEqual(["start 1", "stop 1", "start 2"])
    // A dropped connection being made again (connecting) can deliver offers again at any moment: the hold stays.
    const minting = deferred()
    tickets.hold = minting.promise
    env.relay.drop(env.device(), CLOSE.TICKET_EXPIRED)
    await until(() => env.link.status().state === "connecting")
    await flush()
    expect(blocker).toEqual(["start 1", "stop 1", "start 2"])
    minting.resolve()
    tickets.hold = undefined
    await until(() => env.link.status().state === "online")
    expect(blocker).toEqual(["start 1", "stop 1", "start 2"])
    // Revoked: the first refusal is retried once (connecting, still held), the second is final and releases it.
    env.relay.revoke(env.device())
    env.relay.drop(env.device(), CLOSE.REMOTE_REVOKED)
    await until(() => env.link.status().state === "revoked")
    expect(env.wiring.state()).toBe("on")
    expect(blocker).toEqual(["start 1", "stop 1", "start 2", "stop 2"])
    expect(listeners.size).toBe(0)
  } finally {
    env.stop()
    await folders.cleanup()
  }
})
