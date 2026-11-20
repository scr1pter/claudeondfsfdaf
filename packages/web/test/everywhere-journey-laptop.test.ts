import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { buildSnapshot, snapshotKey } from "../../../api/_lib/codium-snapshot"
import { createRemotePorts } from "../../../api/_lib/everywhere/adapters/remote"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { setMapping } from "../../../api/_lib/everywhere/identity"
import { expectedBranch, readJob, readJobBody, recordSeen, type JobRecord } from "../../../api/_lib/everywhere/jobs"
import { DEVICE_HEADER, createJobsApi } from "../../../api/_lib/everywhere/jobs-api"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { offerPublicKey } from "../../../api/_lib/everywhere/offer"
import type { Ports } from "../../../api/_lib/everywhere/ports"
import { createSlackAdapter, type SlackDeps } from "../../../api/_lib/everywhere/slack/adapter"
import { createSlackRoutes } from "../../../api/_lib/everywhere/slack/routes"
import { setJson, type Store } from "../../../api/_lib/everywhere/store"
import { createSweep } from "../../../api/_lib/everywhere/sweep"
import { codiumSwitches, readEverywhereSwitch, readRemoteSwitch } from "../../../api/_lib/everywhere/switch"
import type { ApiRequest, ApiResponse } from "../../../api/_lib/http"
import { fromUtf8 } from "../../../packages/relay/src/bytes"
import { handleRequest } from "../../../packages/relay/src/index"
import { DEVICE_BYTES, FRAME, decodeFrame } from "../../../packages/relay/src/protocol"
import { Harness, INTERNAL_SECRET } from "../../../packages/relay/test/fakes"
import { OFFER_PATTERN, TIMING } from "../../../packages/schema/src/everywhere"
import { renderEnd } from "../../../packages/schema/src/everywhere-policy"
import { unattendedRules, type RunnerEngine } from "../../desktop/src/main/everywhere-engine"
import type { RunnerGit } from "../../desktop/src/main/everywhere-git"
import { createLedger, type RunnerLedger } from "../../desktop/src/main/everywhere-ledger"
import { createOfferVerifier } from "../../desktop/src/main/everywhere-offer"
import { createEverywhereJobsClient, createEverywhereRunner } from "../../desktop/src/main/everywhere-runner"
import type { RunnerSettings } from "../../desktop/src/main/everywhere-settings"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"
import { RouteHarness, secret } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"
import {
  realRedis,
  testAccountAuthority,
  testEverywhereStore,
  withTestAccountAuthority,
  type RealRedis,
} from "./lib/everywhere-store"

/*
 * VE-22a (EV-19): the laptop journey, Slack first (spec §8 VE-22, §9; E4, E8, E12, E17). Everything the job crosses is
 * the real code: the signed Slack event route, the intake and router, the relay adapter against the relay Worker itself
 * (packages/relay, on its in-memory runtime fakes, served on 127.0.0.1, as EV-09 does), the jobs routes on a loopback
 * server, and on the computer the desktop's own jobs client, offer verifier, ledger and runner. Only the engine, git,
 * the worktree and the pull request are the journey's stand-ins, with gates, so each milestone's Slack post is seen on
 * its own. Codium's store is the Codium fakes'. The offer key is generated here and reaches the computer through the
 * verifier's `keys` parameter; OFFER_KEYS is never touched. Nothing leaves loopback: the fetch guard fails any test
 * that tries, and J5 proves it is in place.
 */

const guard = installFetchGuard()
/** The global fetch before the guard's beforeAll replaces it, for J5's check that the guard is the one in place. */
const unguarded = globalThis.fetch

const DAY = 86_400_000
/** What one store command costs before the first Slack signal (E12). See deviation (g) for how it was chosen. */
const STORE_LATENCY_MS = 100
const TICKET_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64url")
const THREAD = "1731335400.000100"
const FROM = "b".repeat(40)
const HEAD = "c".repeat(40)
const SUMMARY = "Fixed the login button so it submits once."
const PR_URL = "https://github.com/acme/app/pull/7"
const CHECKS = "Checks have not run on this pull request yet"
/** A one-line diff the desktop's own scan accepts; "submitOnce" must never reach the server (E4). */
const DIFF = "diff --git a/src/login.ts b/src/login.ts\n@@ -0,0 +1 @@\n+export const submitOnce = true\n"
/** Each journey test ends well inside the file's 30-second limit, so a red case names itself. */
const CASE_MS = 15_000

const harness = new RouteHarness()
const native = new FakeSlack()
let h = await Harness.create()
let fakes = codiumFakes()
let restore = () => {}
/** The internal actions that reached the relay, in order. */
const actions: string[] = []
/** Opens every gate of the journey a test built: a failed assertion never leaves the runner or the router waiting. */
const teardowns: (() => Promise<void>)[] = []

const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/internal/v1/")) actions.push(path.slice("/internal/v1/".length))
    return handleRequest(request, h.env, h.runtime)
  },
})

const previousSecret = process.env.VECTOR_CLI_TOKEN_SECRET
beforeAll(async () => {
  process.env.VECTOR_CLI_TOKEN_SECRET = randomBytes(32).toString("hex")
  await harness.start()
  native.start()
})
afterAll(async () => {
  await bounded(drainAfter())
  await native.stop()
  await harness.stop()
  await relay.stop(true)
  delete process.env.VECTOR_CLI_TOKEN_SECRET
  if (previousSecret !== undefined) process.env.VECTOR_CLI_TOKEN_SECRET = previousSecret
})

beforeEach(async () => {
  h = await Harness.create()
  actions.length = 0
  fakes = codiumFakes({ now: h.clock.now })
  restore = codiumTestEnvironment({
    VECTOR_REMOTE_ENABLED: "true",
    VECTOR_REMOTE_TICKET_SIGNING_KEY: TICKET_KEY,
    VECTOR_REMOTE_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    VECTOR_HOSTED_INTERNAL_SECRET: INTERNAL_SECRET,
    CODIUM_LISTED_PERKS: undefined,
    NODE_ENV: "test",
  })
  native.calls = []
  native.answer = undefined
  native.user = {
    id: "U0ALICE01",
    team_id: "T0123ABCD",
    is_bot: false,
    deleted: false,
    is_restricted: false,
    is_ultra_restricted: false,
  }
})
afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown()
  await bounded(drainAfter())
  restore()
})

/** At most five seconds: a hung step after a failure must not hold the test run (or the shared Bun lock) for long. */
async function bounded(work: Promise<unknown>) {
  const timeout = Promise.withResolvers<void>()
  const timer = setTimeout(timeout.resolve, 5_000)
  await Promise.race([work, timeout.promise]).finally(() => clearTimeout(timer))
}

/** A stand-in's pause: `entered` once the runner reaches it, and it goes on once `open` is resolved. */
function gate() {
  const entered = Promise.withResolvers<void>()
  const open = Promise.withResolvers<void>()
  return {
    entered,
    open,
    pass: async () => {
      entered.resolve()
      await open.promise
    },
  }
}

/** Loopback goes to the guarded global fetch (the relay); everything else to the Codium fakes. */
function codiumFetcher(): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "127.0.0.1") return fetch(input, init)
      return fakes.fetcher(input, init)
    },
    { preconnect: () => undefined },
  )
}

/** A paid plan with Remote, written as Codium's webhook would, on the relay's clock. */
function seedPlan(account: string) {
  fakes.store.set(
    snapshotKey(account),
    JSON.stringify(
      buildSnapshot(
        {
          account,
          state: "active",
          plan: "vector-50",
          subscription: `sub_journey${account.slice(-4)}`,
          periodStart: h.clock.now - DAY,
          periodEnd: h.clock.now + 29 * DAY,
          cancelAtPeriodEnd: false,
          source: "webhook",
        },
        undefined,
        h.clock.now,
      ),
    ),
  )
}

function planStatuses(body: Record<string, unknown>) {
  const blocks = body.blocks as readonly { readonly tasks?: readonly { readonly status: string }[] }[] | undefined
  return blocks?.[0]?.tasks?.map((task) => task.status)
}

/**
 * One journey: a linked requester in a mapped place, the sponsor's plan, and (with `computer`) one computer connected
 * to the relay running the real desktop runner. `pinned: "other"` pins a key the server does not sign with.
 */
async function world(options: {
  readonly place: "channel" | "dm"
  readonly computer: boolean
  readonly pinned?: "server" | "other"
  readonly store?: Store
}) {
  const f = await slackFixture({ store: options.store })
  const place = options.place === "dm" ? "D123" : "C123"
  await setJson(f.store, everywhereKeys.link(f.installation, "U0ALICE01"), {
    account: f.account,
    linkedAt: f.fake.clock.now,
  })
  const mapped = await setMapping(f.context(), {
    account: f.account,
    installation: f.installation,
    place,
    repositories: [{ id: 101, fullName: "acme/app" }],
    private: true,
  })
  if (!mapped.ok) throw new Error("The journey's mapping was refused.")
  const computer = options.computer ? await h.computer({ sub: f.account }) : undefined
  const device = computer?.dev ?? randomBytes(16).toString("base64url")
  await recordSeen(f.context(), f.account, device)
  seedPlan(f.account)
  const fetcher = codiumFetcher()

  // E12: every store command on the Slack path waits for `storeGate`, then costs STORE_LATENCY_MS on the server's clock
  // until the first native signal has been sent.
  const storeGate = Promise.withResolvers<void>()
  const ack = Promise.withResolvers<void>()
  const timing = { slow: true, commands: 0, signalAt: 0 }
  const slowStore = withTestAccountAuthority(async (command) => {
    await storeGate.promise
    if (timing.slow) {
      f.fake.clock.advance(STORE_LATENCY_MS)
      timing.commands++
    }
    return f.store(command)
  })
  const slackContext = () => ({ ...f.context(), store: slowStore })

  const remote = createRemotePorts({
    config: { ...f.config, allowAccounts: new Set([f.account]) },
    fetcher,
    now: () => h.clock.now,
  })
  const ports: Ports = {
    ...f.ports,
    presence: remote.presence,
    offer: remote.offer,
    perk: remote.perk,
    switch: (name) =>
      name === "everywhere"
        ? readEverywhereSwitch(f.config, codiumSwitches(fetcher))
        : readRemoteSwitch(codiumSwitches(fetcher)),
  }

  // The router's offer poll: the computer acts while the server waits, then the server's clock moves on.
  const slept: number[] = []
  const sleep = async (ms: number) => {
    slept.push(ms)
    await turn()
    f.fake.clock.advance(ms)
  }
  const slackDeps: SlackDeps = {
    config: () => ({ ...f.config, offer: f.context().offer }),
    context: slackContext,
    ports,
    fetcher: native.fetch,
    sleep,
  }
  const adapter = createSlackAdapter(slackDeps)
  const routes = createSlackRoutes(slackDeps)

  const claims = { count: 0 }
  const claimAnswered = Promise.withResolvers<void>()
  const api = createJobsApi({
    env: f.env,
    store: f.store,
    accountAuthority: testAccountAuthority,
    fetcher,
    now: () => f.fake.clock.now,
    events: createJobEvents(slackContext, { slack: adapter }),
  })
  const cronSecret = secret()
  const sweep = createSweep({
    config: () => ({ ...f.config, cronSecret }),
    context: slackContext,
    platforms: () => ({ slack: adapter }),
    stopped: async () => (await readEverywhereSwitch(f.config, codiumSwitches(fetcher))) === "stop",
  })
  harness.mount({
    "/api/slack/events": routes.events,
    "/api/everywhere/jobs/claim": async (request: ApiRequest, response: ApiResponse) => {
      claims.count++
      await api.claim(request, response)
      claimAnswered.resolve()
    },
    "/api/everywhere/jobs/decline": api.decline,
    "/api/everywhere/jobs/report": api.report,
    "/api/everywhere/jobs/settle": api.settle,
    "/api/everywhere/jobs/pending": api.pending,
    "/api/everywhere/sweep": sweep,
  })

  // Every native call, with the server's clock when it reached Slack. The first signal ends the slow store.
  const seen: { method: string; status: unknown; at: number }[] = []
  native.answer = (method, body) => {
    seen.push({ method, status: body.status, at: f.fake.clock.now })
    if (method === "agents.sessions.setStatus" && timing.slow) {
      timing.slow = false
      timing.signalAt = f.fake.clock.now
      ack.resolve()
    }
    return undefined
  }

  // The computer: the desktop's jobs client on the desktop token, the verifier with its pinned key, a ledger in memory.
  const token = mintCliToken({ id: f.account, email: "requester@example.com" }, f.fake.clock.now, "desktop").token
  const jobs = createEverywhereJobsClient({ token: async () => token, device, url: harness.origin })
  const signing = f.context().offer
  if (!signing) throw new Error("The router fixture signs offers.")
  const pinned = offerPublicKey(
    options.pinned === "other" ? { kid: signing.kid, key: generateKeyPairSync("ed25519").privateKey } : signing,
  )
  const ledgerState: { stored?: RunnerLedger } = {}
  const ledger = createLedger({
    read: async () => ledgerState.stored,
    write: async (state) => {
      ledgerState.stored = state
    },
    now: () => f.fake.clock.now,
  })
  const verify = createOfferVerifier({
    account: f.account,
    keys: { [pinned.kid]: pinned.publicKey },
    now: () => f.fake.clock.now,
    useOnce: ledger.useOnce,
  })

  const gates = { mapping: gate(), create: gate(), editing: gate(), pushing: gate() }
  const prompted = Promise.withResolvers<void>()
  const recorded = {
    fetches: [] as { base: string; jid: string }[],
    worktrees: [] as { directory: string; repository: string; jid: string; from: string; branch: string }[],
    engines: [] as string[],
    creates: [] as (readonly PermissionV1.Rule[])[],
    prompts: [] as { task: string; context: readonly unknown[]; maxUsd: number }[],
    commits: [] as string[],
    pushes: [] as string[],
    prs: [] as { branch: string; base: string; summary: string; held: number }[],
    rejected: [] as string[],
  }
  const git: RunnerGit = {
    run: async () => "",
    unchanged: async () => true,
    mapping: async () => {
      await gates.mapping.pass()
      return "mapped"
    },
    snapshot: async (directory) => ({
      directory: directory ?? "/fixture/project",
      gitDirectory: "/fixture/git",
      commonDirectory: "/fixture/common",
      config: [],
      pushUrl: "https://github.com/acme/app.git",
      baseSha: directory ? FROM : "a".repeat(40),
    }),
    fetch: async (_snapshot, base, jid) => {
      recorded.fetches.push({ base, jid })
      return FROM
    },
    stage: async () => ({ held: [], files: 1, diff: DIFF }),
    commit: async (_snapshot, _directory, message) => {
      recorded.commits.push(message)
      return HEAD
    },
    push: async (_snapshot, _directory, branch) => {
      recorded.pushes.push(branch)
      return true
    },
  }
  const engine: RunnerEngine = {
    create: async (_job, rules) => {
      recorded.creates.push(rules)
      await gates.create.pass()
      return "ses_journey"
    },
    prompt: async (_session, job, maxUsd) => {
      recorded.prompts.push({ task: job.task, context: job.context, maxUsd })
      prompted.resolve()
    },
    async *events(_signal, ready) {
      ready()
      await prompted.promise
      yield { type: "session.status", properties: { sessionID: "ses_journey", status: { type: "busy" } } }
      yield {
        type: "message.part.updated",
        properties: { part: { sessionID: "ses_journey", type: "tool", tool: "edit" } },
      }
      await gates.editing.pass()
      yield { type: "session.status", properties: { sessionID: "ses_journey", status: { type: "idle" } } }
    },
    abort: async () => undefined,
    rejectPermission: async (id) => {
      recorded.rejected.push(id)
    },
    rejectQuestion: async (id) => {
      recorded.rejected.push(id)
    },
    summary: async () => SUMMARY,
    posting: async (parts) => ({ status: "clean", parts }),
  }
  const settings: RunnerSettings = {
    enabled: true,
    modelAllowed: true,
    maxUsd: 5,
    minutes: 30,
    atOnce: 1,
    perDay: 20,
    push: true,
    projects: [{ directory: "/fixture/project", repository: "acme/app", base: "main" }],
  }
  const logs: string[] = []
  const runner = createEverywhereRunner({
    settings: async () => settings,
    verify,
    ledger,
    jobs,
    safeWorktree: {
      policy: "unattended-v1",
      create: async (input) => {
        recorded.worktrees.push({
          directory: input.directory,
          repository: input.repository,
          jid: input.jid,
          from: input.from,
          branch: input.branch,
        })
        return { directory: "/fixture/sandbox", from: input.from, branch: input.branch }
      },
    },
    git: () => git,
    engine: (directory) => {
      recorded.engines.push(directory)
      return engine
    },
    privateRepository: async () => {
      await gates.pushing.pass()
      return true
    },
    openPr: async (input) => {
      recorded.prs.push({ branch: input.branch, base: input.base, summary: input.summary, held: input.held })
      return PR_URL
    },
    now: () => f.fake.clock.now,
    // A ticker that never ticks: no real interval and no heartbeat, so every report is a milestone.
    every: () => () => undefined,
    localPolicy: () => LocalPolicy.OFF,
    log: (message) => {
      logs.push(message)
    },
  })

  // spec §9's FakeRelay into the desktop's offer source: each JOB_OFFER frame the relay sent the computer's socket is
  // handed to the runner, as the Remote link's `jobs.offer(text)` does (EV-11). The server's poll waits for the claim's
  // answer, or for the runner to drop the offer.
  const relayed: { kind?: number; device?: Uint8Array; text?: string }[] = []
  const offers: Promise<boolean>[] = []
  const life = { over: false }
  async function turn() {
    // After a failed assertion the teardown ends the journey: no frame reaches the runner any more.
    if (life.over) return
    const frames = computer?.socket.frames() ?? []
    for (const frame of frames.slice(relayed.length)) {
      const decoded = decodeFrame(frame)
      const text = decoded ? fromUtf8(decoded.ciphertext) : undefined
      relayed.push({ kind: decoded?.kind, device: decoded?.device, text })
      if (decoded?.kind === FRAME.JOB_OFFER && text !== undefined) offers.push(runner.offer(text))
    }
    const last = offers.at(-1)
    if (!last) return
    await Promise.race([
      claimAnswered.promise,
      last.then(
        () => undefined,
        () => undefined,
      ),
    ])
  }

  const sent = { at: 0 }
  const send = () => {
    const body =
      options.place === "dm"
        ? f.envelope("Fix the login button", { type: "message", channel: "D123", channel_type: "im" })
        : f.envelope()
    sent.at = f.fake.clock.now
    return harness.call("POST", "/api/slack/events", { body, headers: f.sign(JSON.stringify(body)) })
  }

  teardowns.push(async () => {
    life.over = true
    for (const pending of [storeGate, ack, prompted, claimAnswered]) pending.resolve()
    for (const each of Object.values(gates)) {
      each.entered.resolve()
      each.open.resolve()
    }
    runner.stop()
    await bounded(drainAfter())
    await bounded(Promise.allSettled(offers))
  })

  return {
    f,
    place,
    device,
    token,
    jobs,
    ledger,
    adapter,
    storeGate,
    ack,
    timing,
    slept,
    seen,
    claims,
    gates,
    recorded,
    logs,
    relayed,
    offers,
    send,
    sentAt: () => sent.at,
    cronSecret,
  }
}

type World = Awaited<ReturnType<typeof world>>

/** The one job the sponsor has, read from whichever store the journey runs on. */
async function onlyJob(w: World): Promise<JobRecord> {
  const members = await w.f.store(["ZRANGE", everywhereKeys.jobs(w.f.account), 0, -1])
  const jids = Array.isArray(members) ? members.filter((member): member is string => typeof member === "string") : []
  expect(jids).toHaveLength(1)
  const job = await readJob(w.f.store, jids[0]!)
  if (!job) throw new Error("The journey's job is missing.")
  return job
}

/** The native calls since `mark`, in order. */
function since(mark: number) {
  return native.calls.slice(mark)
}

/** Steps 1 and 2: the signed event is answered before any store work, and its first signal is inside Slack's budget. */
async function admit(w: World) {
  const answer = await w.send()
  expect(answer.status).toBe(200)
  expect(answer.body).toEqual({ received: true })
  // Answered while every store command still waits: nothing has reached the store or Slack yet.
  expect(native.calls).toEqual([])
  expect(w.timing.commands).toBe(0)
  w.storeGate.resolve()
  await w.ack.promise
  // Within Slack's budget on the server's clock, with every store command before it slow, and first of all calls.
  expect(w.timing.signalAt - w.sentAt()).toBeLessThanOrEqual(w.adapter.ackMs)
  expect(w.timing.commands).toBeGreaterThan(0)
  expect({ method: w.seen[0]?.method, status: w.seen[0]?.status }).toEqual({
    method: "agents.sessions.setStatus",
    status: "processing",
  })
}

/** Steps 1 to 9 on the computer: returns what each case checks for its place. */
async function laptopJourney(w: World) {
  await admit(w)

  // 3 to 5. Routing: presence and one offer through the relay, the signed frame verified and claimed while the server
  // polls, inside the offer window. The intake ends once the claim is seen; the runner then waits at its first gate.
  await drainAfter()
  expect(w.slept).toEqual([2_000])
  expect(actions).toEqual(["presence", "job-offer"])
  expect(w.relayed.map((frame) => ({ kind: frame.kind, device: frame.device }))).toEqual([
    { kind: FRAME.JOB_OFFER, device: new Uint8Array(DEVICE_BYTES) },
  ])
  expect(w.relayed[0]!.text).toMatch(OFFER_PATTERN)
  expect(Object.keys((await w.ledger.inspect()).offers)).toHaveLength(1)
  expect(w.claims.count).toBe(1)
  const claimed = await onlyJob(w)
  const jid = claimed.jid
  const branch = expectedBranch(claimed)
  expect(claimed).toMatchObject({ state: "claimed", route: "laptop", device: w.device })
  expect(claimed.claimedAt! - w.sentAt()).toBeLessThan(TIMING.offerWindowMs)
  const plans = native.calls.filter((call) => call.method === "chat.postMessage")
  expect(plans).toHaveLength(1)
  expect(plans[0]!.body).toMatchObject({
    channel: w.place,
    thread_ts: THREAD,
    unfurl_links: false,
    unfurl_media: false,
  })
  const updates = native.calls.filter((call) => call.method === "chat.update")
  expect(updates.length).toBeGreaterThan(0)
  expect(planStatuses(updates.at(-1)!.body)).toEqual(["in_progress", "pending", "pending"])
  await w.gates.mapping.entered.promise

  // 6 and 7. Started: the runner's first milestone, one status, the session title and the plan.
  const startedMark = native.calls.length
  w.gates.mapping.open.resolve()
  await w.gates.create.entered.promise
  await drainAfter()
  expect(await readJob(w.f.store, jid)).toMatchObject({ state: "running", milestone: "started" })
  const started = since(startedMark)
  expect(started.map((call) => call.method)).toEqual([
    "agents.sessions.setStatus",
    "agents.sessions.rename",
    "chat.update",
  ])
  expect(started[0]!.body.status).toBe("processing")
  expect(planStatuses(started[2]!.body)).toEqual(["in_progress", "pending", "pending"])
  expect(w.recorded.fetches).toEqual([{ base: "main", jid }])
  expect(w.recorded.worktrees).toEqual([
    { directory: "/fixture/project", repository: "acme/app", jid, from: FROM, branch },
  ])
  expect(w.recorded.engines).toEqual(["/fixture/sandbox"])
  // No offline shell was offered, so the session's commands stay denied.
  expect(w.recorded.creates).toEqual([unattendedRules()])
  expect(w.recorded.creates[0]!.some((rule) => rule.permission === "bash" && rule.action === "allow")).toBe(false)

  // Editing: the first edit tool reports `editing`.
  const editingMark = native.calls.length
  w.gates.create.open.resolve()
  await w.gates.editing.entered.promise
  await drainAfter()
  const editing = await readJob(w.f.store, jid)
  expect(editing).toMatchObject({ state: "running", milestone: "editing" })
  expect(editing?.limits?.maxUsd).toBeNumber()
  const edited = since(editingMark)
  expect(edited.map((call) => call.method)).toEqual(["agents.sessions.setStatus", "chat.update"])
  expect(edited[0]!.body.status).toBe("processing")
  expect(planStatuses(edited[1]!.body)).toEqual(["complete", "in_progress", "pending"])
  expect(w.recorded.prompts).toEqual([
    { task: "Fix the login button", context: [], maxUsd: Math.min(editing!.limits!.maxUsd, 5) },
  ])

  // Pushing: acknowledged by the server before anything is pushed or settled.
  const pushingMark = native.calls.length
  w.gates.editing.open.resolve()
  await w.gates.pushing.entered.promise
  await drainAfter()
  expect(await readJob(w.f.store, jid)).toMatchObject({ state: "running", milestone: "pushing" })
  const pushing = since(pushingMark)
  expect(pushing.map((call) => call.method)).toEqual(["agents.sessions.setStatus", "chat.update"])
  expect(pushing[0]!.body.status).toBe("processing")
  expect(planStatuses(pushing[1]!.body)).toEqual(["complete", "complete", "in_progress"])
  expect(w.recorded.commits).toHaveLength(1)
  expect(w.recorded.commits[0]).toContain("[skip ci]")
  expect(w.recorded.pushes).toEqual([])
  expect(w.recorded.prs).toEqual([])

  // 8 and 9. Settle `changes` with the pull request in the job's repository; the result is posted and the summary,
  // like the body before it, is erased (E4).
  const resultMark = native.calls.length
  w.gates.pushing.open.resolve()
  expect(await w.offers[0]).toBe(true)
  await drainAfter()
  expect(w.recorded.pushes).toEqual([branch])
  expect(w.recorded.prs).toEqual([{ branch, base: "main", summary: SUMMARY, held: 0 }])
  const settled = await readJob(w.f.store, jid)
  expect(settled).toMatchObject({ state: "settled", outcome: "changes", route: "laptop", device: w.device })
  expect(settled!.result).toEqual({ branch, prUrl: PR_URL, headSha: HEAD, files: 1, checks: "skipped" })
  expect(settled!.summaryEnc).toBeUndefined()
  expect(await readJobBody(w.f.context(), jid)).toBeUndefined()
  expect(await w.f.store(["ZSCORE", everywhereKeys.jobsPosts(), jid])).toBeNull()
  const ledger = await w.ledger.inspect()
  expect({ jobs: ledger.jobs, pending: ledger.pending }).toEqual({ jobs: [], pending: [] })
  expect(w.logs).toEqual([])
  expect(w.recorded.rejected).toEqual([])
  const result = since(resultMark)
  expect(result.at(-1)).toMatchObject({ method: "agents.sessions.setStatus", body: { status: "active" } })

  // E8: a settled job is never claimed again, by another computer or by the one that ran it.
  for (const device of [randomBytes(16).toString("base64url"), w.device]) {
    const late = await harness.call("POST", "/api/everywhere/jobs/claim", {
      token: w.token,
      headers: { [DEVICE_HEADER]: device },
      body: { jid, device },
    })
    expect({ device, status: late.status, code: late.body?.error?.code }).toEqual({
      device,
      status: 409,
      code: "JOB_TAKEN",
    })
  }
  await expect(w.jobs.claim(jid)).rejects.toThrow("Everywhere job stopped")
  expect(w.claims.count).toBe(4)
  return { jid, result }
}

/** No computer online: the job waits until the queue limit, then the sweep ends it with Slack's own text. */
async function offlineJourney(w: World) {
  await admit(w)
  await drainAfter()
  const waiting = await onlyJob(w)
  expect(waiting).toMatchObject({ state: "waiting", route: "queue" })
  expect(waiting.receivedAt).toBeGreaterThanOrEqual(w.sentAt())
  expect(waiting.receivedAt - w.sentAt()).toBeLessThanOrEqual(w.adapter.ackMs)
  expect(waiting.queueUntil).toBe(waiting.receivedAt + TIMING.queueMs)
  // E4: a job waits only while its body lives.
  expect(waiting.queueUntil!).toBeLessThan(waiting.bodyExpiresAt)
  expect(actions).toEqual(["presence"])
  expect(w.slept).toEqual([])
  expect(w.claims.count).toBe(0)

  const sweep = () => harness.call("GET", "/api/everywhere/sweep", { token: w.cronSecret })
  w.f.fake.clock.now = waiting.queueUntil! - 1
  expect(await sweep()).toMatchObject({ status: 200, body: { ended: 0, posted: 0 } })
  expect((await readJob(w.f.store, waiting.jid))?.state).toBe("waiting")
  expect(await readJobBody(w.f.context(), waiting.jid)).toMatchObject({ task: "Fix the login button" })

  const mark = native.calls.length
  w.f.fake.clock.now = waiting.queueUntil!
  expect(await sweep()).toMatchObject({ status: 200, body: { ended: 1, posted: 1 } })
  await drainAfter()
  expect(await readJob(w.f.store, waiting.jid)).toMatchObject({ state: "expired", ending: "expired" })
  expect(await readJobBody(w.f.context(), waiting.jid)).toBeUndefined()
  const ended = since(mark)
  expect(ended.map((call) => call.method)).toEqual(["chat.postMessage", "agents.sessions.setStatus"])
  expect(ended[0]!.body).toMatchObject({
    channel: "C123",
    thread_ts: THREAD,
    text: renderEnd("expired", "slack"),
    unfurl_links: false,
    unfurl_media: false,
  })
  expect(String(ended[0]!.body.text)).toContain("did not pick this up in time")
  expect(ended[1]!.body.status).toBe("active")
  expect(native.calls.some((call) => call.method === "chat.postEphemeral")).toBe(false)
  return waiting.jid
}

/** E17 in a shared place: only the outcome and the link are posted there; the summary goes to the requester alone. */
function expectSharedResult(w: World, result: readonly FakeSlack["calls"][number][]) {
  // Everything the thread shows, text and blocks together: every post and every update of the plan or the result.
  const thread = native.calls.filter((call) => call.method === "chat.postMessage" || call.method === "chat.update")
  for (const call of thread) {
    const posted = JSON.stringify(call.body)
    expect(posted).not.toContain(SUMMARY)
    expect(posted).not.toContain(CHECKS)
    expect(posted.replaceAll(PR_URL, "")).not.toContain("acme/app")
  }
  expect(result.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "chat.postEphemeral",
    "agents.sessions.setStatus",
  ])
  const shared = result[0]!.body
  expect(shared).toMatchObject({ channel: "C123", thread_ts: THREAD, unfurl_links: false, unfurl_media: false })
  expect(String(shared.text)).toContain("Done on your computer.")
  expect(String(shared.text)).toContain(PR_URL)
  const ephemeral = result[1]!.body
  expect(ephemeral).toMatchObject({
    channel: "C123",
    thread_ts: THREAD,
    user: "U0ALICE01",
    unfurl_links: false,
    unfurl_media: false,
  })
  expect(String(ephemeral.text)).toContain(SUMMARY)
  expect(String(ephemeral.text)).toContain(CHECKS)
  expect(JSON.stringify(native.calls)).not.toContain(w.device)
}

test(
  "J1: a shared-channel mention runs on the computer and posts only the outcome and the link there (E4, E8, E12, E17)",
  async () => {
    const w = await world({ place: "channel", computer: true })
    const journey = await laptopJourney(w)
    expect((await readJob(w.f.store, journey.jid))?.shared).toBe(true)
    expect(native.calls.find((call) => call.method === "agents.sessions.rename")?.body.title).toBe("Vector task")
    expectSharedResult(w, journey.result)
    // E4 on the FakeStore's command log: the diff, the summary and the task never reached the store in plaintext.
    const commands = JSON.stringify(w.f.fake.commands)
    expect(commands).not.toContain("submitOnce")
    expect(commands).not.toContain(SUMMARY)
    expect(commands).not.toContain("Fix the login button")
  },
  CASE_MS,
)

test(
  "J2: a direct message is a private place: the summary comes back in the reply",
  async () => {
    const w = await world({ place: "dm", computer: true })
    const journey = await laptopJourney(w)
    expect((await readJob(w.f.store, journey.jid))?.shared).toBe(false)
    expect(native.calls.find((call) => call.method === "agents.sessions.rename")?.body.title).toBe(
      "acme/app: Fix the login button",
    )
    expect(journey.result.map((call) => call.method)).toEqual(["chat.postMessage", "agents.sessions.setStatus"])
    const reply = journey.result[0]!.body
    expect(reply).toMatchObject({ channel: "D123", thread_ts: THREAD, unfurl_links: false, unfurl_media: false })
    expect(String(reply.text)).toContain(SUMMARY)
    expect(String(reply.text)).toContain(PR_URL)
    expect(String(reply.text)).toContain(CHECKS)
    expect(native.calls.some((call) => call.method === "chat.postEphemeral")).toBe(false)
  },
  CASE_MS,
)

test(
  "J3: with no computer online the job waits, then expires with Slack's own text at the queue limit",
  async () => {
    await offlineJourney(await world({ place: "channel", computer: false }))
  },
  CASE_MS,
)

test(
  "J4: an offer signed with a key the computer does not pin is dropped: no claim, and the job waits after the window",
  async () => {
    const w = await world({ place: "channel", computer: true, pinned: "other" })
    await admit(w)
    await drainAfter()
    expect(w.slept).toEqual(Array.from({ length: TIMING.offerWindowMs / 2_000 }, () => 2_000))
    expect(actions).toEqual(["presence", "job-offer"])
    expect(w.relayed).toHaveLength(1)
    expect(w.claims.count).toBe(0)
    // Nothing was consumed, nothing was declined: the computer stays silent about an offer it cannot verify.
    expect((await w.ledger.inspect()).offers).toEqual({})
    expect(await Promise.all(w.offers)).toEqual([false])
    const job = await onlyJob(w)
    expect(job).toMatchObject({ state: "waiting", route: "queue" })
    expect(job.declines ?? []).toEqual([])
    expect(job.device).toBeUndefined()
    expect(native.calls.some((call) => call.method === "chat.postEphemeral")).toBe(false)
    expect(native.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1)
  },
  CASE_MS,
)

test("J5: the fetch guard stops any request that leaves loopback", async () => {
  // The guard is the fetch in place. The probe aims at a reserved name that never resolves, so even a broken guard
  // sends nothing, and no case aims a request at a real host: the jobs client's default origin is pinned without a
  // request in packages/desktop everywhere-runner.test.ts (deviation (n)).
  expect(globalThis.fetch).not.toBe(unguarded)
  await expect(globalThis.fetch("https://guard-probe.invalid/")).rejects.toThrow("The fetch guard stopped")
  expect(guard.violations.splice(0)).toEqual(["guard-probe.invalid"])
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeEach(async () => {
    redis = (await realRedis())!
  })
  afterEach(async () => {
    for (const teardown of teardowns.splice(0)) await teardown()
    await bounded(drainAfter())
    await redis.close()
  })

  test(
    "R1: J1's journey runs the create and transition scripts on Valkey",
    async () => {
      const store = testEverywhereStore(redis.fetch)
      const w = await world({ place: "channel", computer: true, store })
      const journey = await laptopJourney(w)
      expectSharedResult(w, journey.result)
      // The journey ran on Valkey alone: the job is there, settled, and the fixture's FakeStore saw no command.
      expect(await readJob(store, journey.jid)).toMatchObject({ state: "settled", outcome: "changes", shared: true })
      expect(w.f.fake.commands).toEqual([])
    },
    CASE_MS,
  )

  test(
    "R2: J3's wait and expiry on Valkey",
    async () => {
      const store = testEverywhereStore(redis.fetch)
      const w = await world({ place: "channel", computer: false, store })
      const jid = await offlineJourney(w)
      expect(await readJob(store, jid)).toMatchObject({ state: "expired", ending: "expired" })
      expect(w.f.fake.commands).toEqual([])
    },
    CASE_MS,
  )
})
