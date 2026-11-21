import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { setMapping } from "../../../api/_lib/everywhere/identity"
import { expectedBranch, readJob, readJobBody, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { createSlackAdapter, type SlackDeps } from "../../../api/_lib/everywhere/slack/adapter"
import { createSlackRoutes } from "../../../api/_lib/everywhere/slack/routes"
import { setJson, type Store } from "../../../api/_lib/everywhere/store"
import { DEVICE_BYTES, FRAME } from "../../../packages/relay/src/protocol"
import { OFFER_PATTERN, TIMING } from "../../../packages/schema/src/everywhere"
import { renderEnd } from "../../../packages/schema/src/everywhere-policy"
import { unattendedRules } from "../../desktop/src/main/everywhere-engine"
import {
  CASE_MS,
  CHECKS,
  FROM,
  PR_URL,
  SUMMARY,
  expectNoReclaim,
  expectSettled,
  installJourney,
  journeyComputer,
  journeyPorts,
  mountJourney,
  onlyJob,
  slowStore,
} from "./lib/everywhere-journey"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"
import { realRedis, testEverywhereStore, type RealRedis } from "./lib/everywhere-store"

/*
 * VE-22a (EV-19): the laptop journey, Slack first (spec §8 VE-22, §9; E4, E8, E12, E17). Everything the job crosses is
 * the real code: the signed Slack event route, the intake and router, the relay adapter against the relay Worker itself
 * (packages/relay, on its in-memory runtime fakes, served on 127.0.0.1, as EV-09 does), the jobs routes on a loopback
 * server, and on the computer the desktop's own jobs client, offer verifier, ledger and runner. Only the engine, git,
 * the worktree and the pull request are the journey's stand-ins, with gates, so each milestone's Slack post is seen on
 * its own. Codium's store is the Codium fakes'. The offer key is generated here and reaches the computer through the
 * verifier's `keys` parameter; OFFER_KEYS is never touched. Nothing leaves loopback: the fetch guard fails any test
 * that tries, and J5 proves it is in place. The platform-neutral half is lib/everywhere-journey.ts (EV-20), which the
 * Linear and Jira journeys share.
 */

const native = new FakeSlack()
const journey = installJourney([native])
const THREAD = "1731335400.000100"

beforeEach(() => {
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
  const computer = options.computer ? await journey.relay().computer({ sub: f.account }) : undefined
  const device = computer?.dev ?? randomBytes(16).toString("base64url")
  await recordSeen(f.context(), f.account, device)
  journey.seedPlan(f.account)

  // E12: every store command on the Slack path waits for the store's gate, then costs STORE_LATENCY_MS on the server's
  // clock until the first native signal has been sent.
  const slow = slowStore(f.store, f.fake.clock, { gated: true })
  const ack = Promise.withResolvers<void>()
  const slackContext = () => ({ ...f.context(), store: slow.store })
  const ports = journeyPorts(journey, f)

  // The router's offer poll: the computer acts while the server waits, then the server's clock moves on.
  const slept: number[] = []
  const sleep = async (ms: number) => {
    slept.push(ms)
    await desktop.turn()
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
  const mounted = mountJourney(journey, {
    env: f.env,
    store: f.store,
    config: f.config,
    context: slackContext,
    now: () => f.fake.clock.now,
    platforms: { slack: adapter },
    routes: { "/api/slack/events": routes.events },
  })

  // Every native call, with the server's clock when it reached Slack. The first signal ends the slow store.
  const seen: { method: string; status: unknown; at: number }[] = []
  native.answer = (method, body) => {
    seen.push({ method, status: body.status, at: f.fake.clock.now })
    if (method === "agents.sessions.setStatus" && slow.timing.slow) {
      slow.timing.slow = false
      slow.timing.signalAt = f.fake.clock.now
      ack.resolve()
    }
    return undefined
  }

  const signing = f.context().offer
  if (!signing) throw new Error("The router fixture signs offers.")
  const desktop = journeyComputer(journey, {
    account: f.account,
    device,
    socket: computer?.socket,
    offer: signing,
    pinned: options.pinned,
    now: () => f.fake.clock.now,
    claimAnswered: mounted.claimAnswered.promise,
  })

  const sent = { at: 0 }
  const send = () => {
    const body =
      options.place === "dm"
        ? f.envelope("Fix the login button", { type: "message", channel: "D123", channel_type: "im" })
        : f.envelope()
    sent.at = f.fake.clock.now
    return journey.harness.call("POST", "/api/slack/events", { body, headers: f.sign(JSON.stringify(body)) })
  }

  journey.teardowns.push(async () => {
    for (const pending of [slow.gate, ack, mounted.claimAnswered]) pending.resolve()
    await desktop.close()
  })

  return {
    ...desktop,
    ...mounted,
    f,
    place,
    device,
    adapter,
    storeGate: slow.gate,
    ack,
    timing: slow.timing,
    slept,
    seen,
    send,
    sentAt: () => sent.at,
  }
}

type World = Awaited<ReturnType<typeof world>>

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
  expect(journey.actions).toEqual(["presence", "job-offer"])
  expect(w.relayed.map((frame) => ({ kind: frame.kind, device: frame.device }))).toEqual([
    { kind: FRAME.JOB_OFFER, device: new Uint8Array(DEVICE_BYTES) },
  ])
  expect(w.relayed[0]!.text).toMatch(OFFER_PATTERN)
  expect(Object.keys((await w.ledger.inspect()).offers)).toHaveLength(1)
  expect(w.claims.count).toBe(1)
  const claimed = await onlyJob(w.f.store, w.f.account)
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
  await expectSettled(w, { store: w.f.store, context: w.f.context, jid, branch, device: w.device })
  const result = since(resultMark)
  expect(result.at(-1)).toMatchObject({ method: "agents.sessions.setStatus", body: { status: "active" } })

  await expectNoReclaim(journey, w, { jid, device: w.device })
  expect(w.claims.count).toBe(4)
  return { jid, result }
}

/** No computer online: the job waits until the queue limit, then the sweep ends it with Slack's own text. */
async function offlineJourney(w: World) {
  await admit(w)
  await drainAfter()
  const waiting = await onlyJob(w.f.store, w.f.account)
  expect(waiting).toMatchObject({ state: "waiting", route: "queue" })
  expect(waiting.receivedAt).toBeGreaterThanOrEqual(w.sentAt())
  expect(waiting.receivedAt - w.sentAt()).toBeLessThanOrEqual(w.adapter.ackMs)
  expect(waiting.queueUntil).toBe(waiting.receivedAt + TIMING.queueMs)
  // E4: a job waits only while its body lives.
  expect(waiting.queueUntil!).toBeLessThan(waiting.bodyExpiresAt)
  expect(journey.actions).toEqual(["presence"])
  expect(w.slept).toEqual([])
  expect(w.claims.count).toBe(0)

  const sweep = () => journey.harness.call("GET", "/api/everywhere/sweep", { token: w.cronSecret })
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
    const run = await laptopJourney(w)
    expect((await readJob(w.f.store, run.jid))?.shared).toBe(true)
    expect(native.calls.find((call) => call.method === "agents.sessions.rename")?.body.title).toBe("Vector task")
    expectSharedResult(w, run.result)
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
    const run = await laptopJourney(w)
    expect((await readJob(w.f.store, run.jid))?.shared).toBe(false)
    expect(native.calls.find((call) => call.method === "agents.sessions.rename")?.body.title).toBe(
      "acme/app: Fix the login button",
    )
    expect(run.result.map((call) => call.method)).toEqual(["chat.postMessage", "agents.sessions.setStatus"])
    const reply = run.result[0]!.body
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
    expect(journey.actions).toEqual(["presence", "job-offer"])
    expect(w.relayed).toHaveLength(1)
    expect(w.claims.count).toBe(0)
    // Nothing was consumed, nothing was declined: the computer stays silent about an offer it cannot verify.
    expect((await w.ledger.inspect()).offers).toEqual({})
    expect(await Promise.all(w.offers)).toEqual([false])
    const job = await onlyJob(w.f.store, w.f.account)
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
  expect(globalThis.fetch).not.toBe(journey.unguarded)
  await expect(globalThis.fetch("https://guard-probe.invalid/")).rejects.toThrow("The fetch guard stopped")
  expect(journey.guard.violations.splice(0)).toEqual(["guard-probe.invalid"])
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeEach(async () => {
    redis = (await realRedis())!
  })
  afterEach(async () => {
    await journey.teardown()
    await redis.close()
  })

  test(
    "R1: J1's journey runs the create and transition scripts on Valkey",
    async () => {
      const store = testEverywhereStore(redis.fetch)
      const w = await world({ place: "channel", computer: true, store })
      const run = await laptopJourney(w)
      expectSharedResult(w, run.result)
      // The journey ran on Valkey alone: the job is there, settled, and the fixture's FakeStore saw no command.
      expect(await readJob(store, run.jid)).toMatchObject({ state: "settled", outcome: "changes", shared: true })
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
