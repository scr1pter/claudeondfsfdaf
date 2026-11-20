import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { mintCliToken } from "../../../../api/_lib/cli-token"
import { buildSnapshot, snapshotKey } from "../../../../api/_lib/codium-snapshot"
import { createRemotePorts } from "../../../../api/_lib/everywhere/adapters/remote"
import { drainAfter } from "../../../../api/_lib/everywhere/after"
import type { EverywhereConfig, OfferKey } from "../../../../api/_lib/everywhere/config"
import { createJobEvents } from "../../../../api/_lib/everywhere/events"
import { readJob, readJobBody, type JobRecord, type JobsContext } from "../../../../api/_lib/everywhere/jobs"
import { DEVICE_HEADER, createJobsApi } from "../../../../api/_lib/everywhere/jobs-api"
import { everywhereKeys } from "../../../../api/_lib/everywhere/keys"
import { offerPublicKey } from "../../../../api/_lib/everywhere/offer"
import type { Platforms } from "../../../../api/_lib/everywhere/platform"
import type { Ports } from "../../../../api/_lib/everywhere/ports"
import type { Store } from "../../../../api/_lib/everywhere/store"
import { createSweep } from "../../../../api/_lib/everywhere/sweep"
import { codiumSwitches, readEverywhereSwitch, readRemoteSwitch } from "../../../../api/_lib/everywhere/switch"
import type { ApiRequest, ApiResponse } from "../../../../api/_lib/http"
import { fromUtf8 } from "../../../../packages/relay/src/bytes"
import { handleRequest } from "../../../../packages/relay/src/index"
import { FRAME, decodeFrame } from "../../../../packages/relay/src/protocol"
import { Harness, INTERNAL_SECRET, type FakeSocket } from "../../../../packages/relay/test/fakes"
import type { RunnerEngine } from "../../../desktop/src/main/everywhere-engine"
import type { RunnerGit } from "../../../desktop/src/main/everywhere-git"
import { createLedger, type RunnerLedger } from "../../../desktop/src/main/everywhere-ledger"
import { createOfferVerifier } from "../../../desktop/src/main/everywhere-offer"
import { createEverywhereJobsClient, createEverywhereRunner } from "../../../desktop/src/main/everywhere-runner"
import type { RunnerSettings } from "../../../desktop/src/main/everywhere-settings"
import { codiumFakes, codiumTestEnvironment } from "../fixture/codium-fakes"
import { RouteHarness, secret } from "./everywhere-account"
import { installFetchGuard } from "./everywhere-fetch-guard"
import { testAccountAuthority, withTestAccountAuthority, type FakeClock } from "./everywhere-store"

/*
 * The laptop journey harness (spec §8 VE-22, §9): the platform-neutral half of a mocked job, shared by the Slack
 * journey (EV-19, VE-22a) and the Linear and Jira journeys (EV-20, VE-22b). It holds the relay Worker on 127.0.0.1
 * (packages/relay on its in-memory runtime fakes, as EV-09 does) under the real relay adapter, Codium's fakes for the
 * plan and the switches, the jobs routes and the sweep on a loopback server, and on the computer the desktop's own jobs
 * client, offer verifier, ledger and runner, with the engine, git, the worktree and the pull request as gated stand-ins.
 * The offer key is generated in the test and reaches the computer through the verifier's `keys` parameter; OFFER_KEYS
 * is never touched. Nothing leaves loopback: `installJourney` arms the fetch guard for the whole file.
 */

/** What one store command costs before the first native signal (E12): EV-19 deviation (g). */
export const STORE_LATENCY_MS = 100
/** Each journey test ends well inside the file's 30-second limit, so a red case names itself. */
export const CASE_MS = 15_000
export const FROM = "b".repeat(40)
export const HEAD = "c".repeat(40)
export const SUMMARY = "Fixed the login button so it submits once."
export const PR_URL = "https://github.com/acme/app/pull/7"
export const CHECKS = "Checks have not run on this pull request yet"
/** A one-line diff the desktop's own scan accepts; "submitOnce" must never reach the server (E4). */
export const DIFF = "diff --git a/src/login.ts b/src/login.ts\n@@ -0,0 +1 @@\n+export const submitOnce = true\n"

const DAY = 86_400_000

/**
 * Installs the journey's servers and hooks for the whole test file: call once at the top level. `natives` are the
 * platform fakes the file uses; they start after the jobs server and stop before it.
 */
export function installJourney(natives: readonly { start(): unknown; stop(): unknown }[]) {
  const guard = installFetchGuard()
  /** The global fetch before the guard's beforeAll replaces it, for the check that the guard is the one in place. */
  const unguarded = globalThis.fetch
  const ticketKey = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64url")
  const harness = new RouteHarness()
  const current: { relay?: Harness; fakes?: ReturnType<typeof codiumFakes>; restore: () => void } = {
    restore: () => {},
  }
  /** The internal actions that reached the relay, in order. */
  const actions: string[] = []
  /** Opens every gate of the journey a test built: a failed assertion never leaves the runner or the router waiting. */
  const teardowns: (() => Promise<void>)[] = []

  /** The relay of the running test; each test gets a fresh one in beforeEach. */
  const relay = () => {
    if (!current.relay) throw new Error("The journey's relay is made in beforeEach: use it inside a test.")
    return current.relay
  }
  const fakes = () => {
    if (!current.fakes) throw new Error("The journey's Codium fakes are made in beforeEach: use them inside a test.")
    return current.fakes
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path.startsWith("/internal/v1/")) actions.push(path.slice("/internal/v1/".length))
      return handleRequest(request, relay().env, relay().runtime)
    },
  })

  /** Loopback goes to the guarded global fetch (the relay); everything else to the Codium fakes. */
  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "127.0.0.1") return fetch(input, init)
      return fakes().fetcher(input, init)
    },
    { preconnect: () => undefined },
  )

  /** A paid plan with Remote, written as Codium's webhook would, on the relay's clock. */
  const seedPlan = (account: string) => {
    const now = relay().clock.now
    fakes().store.set(
      snapshotKey(account),
      JSON.stringify(
        buildSnapshot(
          {
            account,
            state: "active",
            plan: "vector-50",
            subscription: `sub_journey${account.slice(-4)}`,
            periodStart: now - DAY,
            periodEnd: now + 29 * DAY,
            cancelAtPeriodEnd: false,
            source: "webhook",
          },
          undefined,
          now,
        ),
      ),
    )
  }

  const teardown = async () => {
    for (const each of teardowns.splice(0)) await each()
    await bounded(drainAfter())
  }

  const previousSecret = process.env.VECTOR_CLI_TOKEN_SECRET
  beforeAll(async () => {
    process.env.VECTOR_CLI_TOKEN_SECRET = randomBytes(32).toString("hex")
    await harness.start()
    for (const native of natives) await native.start()
  })
  afterAll(async () => {
    await bounded(drainAfter())
    for (const native of natives) await native.stop()
    await harness.stop()
    await server.stop(true)
    delete process.env.VECTOR_CLI_TOKEN_SECRET
    if (previousSecret !== undefined) process.env.VECTOR_CLI_TOKEN_SECRET = previousSecret
  })

  beforeEach(async () => {
    current.relay = await Harness.create()
    actions.length = 0
    current.fakes = codiumFakes({ now: current.relay.clock.now })
    current.restore = codiumTestEnvironment({
      VECTOR_REMOTE_ENABLED: "true",
      VECTOR_REMOTE_TICKET_SIGNING_KEY: ticketKey,
      VECTOR_REMOTE_RELAY_URL: `ws://127.0.0.1:${server.port}`,
      VECTOR_HOSTED_INTERNAL_SECRET: INTERNAL_SECRET,
      CODIUM_LISTED_PERKS: undefined,
      NODE_ENV: "test",
    })
  })
  afterEach(async () => {
    await teardown()
    current.restore()
  })

  return { guard, unguarded, harness, actions, teardowns, relay, fetcher, seedPlan, teardown }
}

export type Journey = ReturnType<typeof installJourney>

/** At most five seconds: a hung step after a failure must not hold the test run (or the shared Bun lock) for long. */
export async function bounded(work: Promise<unknown>) {
  const timeout = Promise.withResolvers<void>()
  const timer = setTimeout(timeout.resolve, 5_000)
  await Promise.race([work, timeout.promise]).finally(() => clearTimeout(timer))
}

/** A stand-in's pause: `entered` once the runner reaches it, and it goes on once `open` is resolved. */
export function gate() {
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

/**
 * E12: every store command waits for `gate`, then costs STORE_LATENCY_MS on the server's clock while `timing.slow` is
 * set, which the journey clears at the first native signal. `gated: false` opens the gate at once.
 */
export function slowStore(store: Store, clock: FakeClock, options: { readonly gated: boolean }) {
  const gate = Promise.withResolvers<void>()
  if (!options.gated) gate.resolve()
  const timing = { slow: true, commands: 0, signalAt: 0 }
  const slow = withTestAccountAuthority(async (command) => {
    await gate.promise
    if (timing.slow) {
      clock.advance(STORE_LATENCY_MS)
      timing.commands++
    }
    return store(command)
  })
  return { store: slow, gate, timing }
}

/** The fixture's ports with the relay adapter's presence, offer and plan check, and the switches read from Codium. */
export function journeyPorts(
  journey: Journey,
  input: { readonly config: EverywhereConfig; readonly ports: Ports; readonly account: string },
): Ports {
  const remote = createRemotePorts({
    config: { ...input.config, allowAccounts: new Set([input.account]) },
    fetcher: journey.fetcher,
    now: () => journey.relay().clock.now,
  })
  return {
    ...input.ports,
    presence: remote.presence,
    offer: remote.offer,
    perk: remote.perk,
    switch: (name) =>
      name === "everywhere"
        ? readEverywhereSwitch(input.config, codiumSwitches(journey.fetcher))
        : readRemoteSwitch(codiumSwitches(journey.fetcher)),
  }
}

/** Mounts the platform's routes with the five jobs routes and the sweep; the claim route counts and announces. */
export function mountJourney(
  journey: Journey,
  input: {
    readonly env: Record<string, string>
    readonly store: Store
    readonly config: EverywhereConfig
    readonly context: () => JobsContext
    readonly now: () => number
    readonly platforms: Platforms
    readonly routes: Parameters<RouteHarness["mount"]>[0]
  },
) {
  const claims = { count: 0 }
  const claimAnswered = Promise.withResolvers<void>()
  const api = createJobsApi({
    env: input.env,
    store: input.store,
    accountAuthority: testAccountAuthority,
    fetcher: journey.fetcher,
    now: input.now,
    events: createJobEvents(input.context, input.platforms),
  })
  const cronSecret = secret()
  const sweep = createSweep({
    config: () => ({ ...input.config, cronSecret }),
    context: input.context,
    platforms: () => input.platforms,
    stopped: async () => (await readEverywhereSwitch(input.config, codiumSwitches(journey.fetcher))) === "stop",
  })
  journey.harness.mount({
    ...input.routes,
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
  return { claims, claimAnswered, cronSecret }
}

/**
 * The computer: the desktop's jobs client on the desktop token, the verifier with its pinned key, a ledger in memory,
 * and the runner over gated stand-ins. `pinned: "other"` pins a key the server does not sign with.
 */
export function journeyComputer(
  journey: Journey,
  input: {
    readonly account: string
    readonly device: string
    readonly socket?: FakeSocket
    readonly offer: OfferKey
    readonly pinned?: "server" | "other"
    readonly now: () => number
    readonly claimAnswered: Promise<void>
  },
) {
  const token = mintCliToken({ id: input.account, email: "requester@example.com" }, input.now(), "desktop").token
  const jobs = createEverywhereJobsClient({
    token: async () => token,
    device: input.device,
    url: journey.harness.origin,
  })
  const pinned = offerPublicKey(
    input.pinned === "other" ? { kid: input.offer.kid, key: generateKeyPairSync("ed25519").privateKey } : input.offer,
  )
  const ledgerState: { stored?: RunnerLedger } = {}
  const ledger = createLedger({
    read: async () => ledgerState.stored,
    write: async (state) => {
      ledgerState.stored = state
    },
    now: input.now,
  })
  const verify = createOfferVerifier({
    account: input.account,
    keys: { [pinned.kid]: pinned.publicKey },
    now: input.now,
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
      create: async (worktree) => {
        recorded.worktrees.push({
          directory: worktree.directory,
          repository: worktree.repository,
          jid: worktree.jid,
          from: worktree.from,
          branch: worktree.branch,
        })
        return { directory: "/fixture/sandbox", from: worktree.from, branch: worktree.branch }
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
    openPr: async (pr) => {
      recorded.prs.push({ branch: pr.branch, base: pr.base, summary: pr.summary, held: pr.held })
      return PR_URL
    },
    now: input.now,
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
    const frames = input.socket?.frames() ?? []
    for (const frame of frames.slice(relayed.length)) {
      const decoded = decodeFrame(frame)
      const text = decoded ? fromUtf8(decoded.ciphertext) : undefined
      relayed.push({ kind: decoded?.kind, device: decoded?.device, text })
      if (decoded?.kind === FRAME.JOB_OFFER && text !== undefined) offers.push(runner.offer(text))
    }
    const last = offers.at(-1)
    if (!last) return
    await Promise.race([
      input.claimAnswered,
      last.then(
        () => undefined,
        () => undefined,
      ),
    ])
  }

  const close = async () => {
    life.over = true
    prompted.resolve()
    for (const each of Object.values(gates)) {
      each.entered.resolve()
      each.open.resolve()
    }
    runner.stop()
    await bounded(drainAfter())
    await bounded(Promise.allSettled(offers))
  }

  return { token, jobs, ledger, runner, gates, recorded, logs, relayed, offers, turn, close }
}

export type JourneyComputer = ReturnType<typeof journeyComputer>

/** The one job the sponsor has, read from whichever store the journey runs on. */
export async function onlyJob(store: Store, account: string): Promise<JobRecord> {
  const members = await store(["ZRANGE", everywhereKeys.jobs(account), 0, -1])
  const jids = Array.isArray(members) ? members.filter((member): member is string => typeof member === "string") : []
  expect(jids).toHaveLength(1)
  const job = await readJob(store, jids[0]!)
  if (!job) throw new Error("The journey's job is missing.")
  return job
}

/**
 * Step 8: the pushing gate opens, the offer ends true, and the job settles `changes` with the pull request in its
 * repository; the body and then the summary are erased once the result is posted (E4), the outbox entry is gone, the
 * ledger is empty, and nothing was logged, refused or asked.
 */
export async function expectSettled(
  computer: JourneyComputer,
  input: {
    readonly store: Store
    readonly context: () => JobsContext
    readonly jid: string
    readonly branch: string
    readonly device: string
  },
): Promise<JobRecord> {
  computer.gates.pushing.open.resolve()
  expect(await computer.offers[0]).toBe(true)
  await drainAfter()
  expect(computer.recorded.pushes).toEqual([input.branch])
  expect(computer.recorded.prs).toEqual([{ branch: input.branch, base: "main", summary: SUMMARY, held: 0 }])
  const settled = await readJob(input.store, input.jid)
  expect(settled).toMatchObject({ state: "settled", outcome: "changes", route: "laptop", device: input.device })
  if (!settled) throw new Error("The journey's job is missing.")
  expect(settled.result).toEqual({ branch: input.branch, prUrl: PR_URL, headSha: HEAD, files: 1, checks: "skipped" })
  expect(settled.summaryEnc).toBeUndefined()
  expect(await readJobBody(input.context(), input.jid)).toBeUndefined()
  expect(await input.store(["ZSCORE", everywhereKeys.jobsPosts(), input.jid])).toBeNull()
  const ledger = await computer.ledger.inspect()
  expect({ jobs: ledger.jobs, pending: ledger.pending }).toEqual({ jobs: [], pending: [] })
  expect(computer.logs).toEqual([])
  expect(computer.recorded.rejected).toEqual([])
  return settled
}

/** E8: an ended job (settled or expired) is never claimed again, by another computer or by its own. */
export async function expectNoReclaim(
  journey: Journey,
  computer: JourneyComputer,
  input: { readonly jid: string; readonly device: string },
) {
  for (const device of [randomBytes(16).toString("base64url"), input.device]) {
    const late = await journey.harness.call("POST", "/api/everywhere/jobs/claim", {
      token: computer.token,
      headers: { [DEVICE_HEADER]: device },
      body: { jid: input.jid, device },
    })
    expect({ device, status: late.status, code: late.body?.error?.code }).toEqual({
      device,
      status: 409,
      code: "JOB_TAKEN",
    })
  }
  await expect(computer.jobs.claim(input.jid)).rejects.toThrow("Everywhere job stopped")
}
