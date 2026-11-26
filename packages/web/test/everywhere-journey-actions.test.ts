import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { mintRunToken } from "../../../api/_lib/cloud-agents-run-token"
import {
  notifyRunSettle,
  notifyRunStart,
  registerRunSettleListener,
  type RunEnd,
} from "../../../api/_lib/cloud-agents-runs"
import { createCloudPorts, createRunBodyVisibility } from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import type { EverywhereConfig } from "../../../api/_lib/everywhere/config"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { setMapping } from "../../../api/_lib/everywhere/identity"
import { createJiraRoutes } from "../../../api/_lib/everywhere/jira/a2a"
import { createJiraAdapter, type JiraDeps } from "../../../api/_lib/everywhere/jira/adapter"
import { readJob, readJobBody, readJobHistory, recordSeen, type JobsContext } from "../../../api/_lib/everywhere/jobs"
import { DEVICE_HEADER, READINESS_QUERY } from "../../../api/_lib/everywhere/jobs-api"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { createLinearAdapter, type LinearDeps } from "../../../api/_lib/everywhere/linear/adapter"
import { linearPlan } from "../../../api/_lib/everywhere/linear/render"
import { createLinearWebhook } from "../../../api/_lib/everywhere/linear/routes"
import type { Platforms } from "../../../api/_lib/everywhere/platform"
import { registerEverywhereRunHooks } from "../../../api/_lib/everywhere/run-hooks"
import { createSlackAdapter, type SlackDeps } from "../../../api/_lib/everywhere/slack/adapter"
import { slackPlan, slackResult } from "../../../api/_lib/everywhere/slack/render"
import { createSlackRoutes } from "../../../api/_lib/everywhere/slack/routes"
import { getValue, setJson, type Store } from "../../../api/_lib/everywhere/store"
import { codiumSwitches, readEverywhereSwitch } from "../../../api/_lib/everywhere/switch"
import { createJobBodyRoute } from "../../../api/everywhere/jobs/[jid]/body"
import { ENABLED_SOURCES, type RunSource } from "../../../packages/schema/src/codium-run-trigger"
import { ACTIONS_JOB_PROMPT, TIMING, jobOfActionsPrompt } from "../../../packages/schema/src/everywhere"
import { renderEnd, renderRefusal, renderResult } from "../../../packages/schema/src/everywhere-policy"
import { RouteHarness, type RouteAnswer } from "./lib/everywhere-account"
import {
  bindingFields,
  bindingStore,
  liveModes,
  preparer,
  privateApp,
  runId,
  sources,
  stubApp,
  vectorRun,
  vectorStore,
} from "./lib/everywhere-cloud-agents"
import { NativeJira, jiraFixture } from "./lib/everywhere-jira"
import {
  CASE_MS,
  CHECKS,
  PR_URL,
  expectNoReclaim,
  installJourney,
  journeyComputer,
  journeyPorts,
  mountJourney,
  onlyJob,
} from "./lib/everywhere-journey"
import { FakeLinear, linearFixture } from "./lib/everywhere-linear"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"
import { realRedis, testAccountAuthority, testEverywhereStore, type RealRedis } from "./lib/everywhere-store"

/*
 * VE-33 (EV-32): the Actions fallback journeys, mocked end to end (spec §8 VE-33, §9; E4, E8, E11, E17). For Slack and
 * Linear: the signed platform event, the real intake and router, presence through the real relay adapter against the
 * relay Worker on 127.0.0.1 with no computer connected (EV-19's harness), EV-29's real adapter over spec §9's
 * FakeCloudAgents (lib/everywhere-cloud-agents.ts: @vector's binding decoder behind a stub store, the App's live read
 * as a stand-in, a recording prepareCloudRun that returns a ticket hash, the live mode reader), @vector's real
 * notifyRunStart and notifyRunSettle over EV-30's real listeners, the run reading its request once through the real
 * body route with a real `vrt_` token, and the result posted through the platform's own adapter. Jira never takes the
 * Actions route (EV-30 (j)), so its journey shows the queue and Jira's own end. The sources are enabled only through
 * `createCloudPorts({sources})`; ENABLED_SOURCES is never edited, and D1 shows it still reserves all three. The result
 * carries no pull request link and so no checks line (EV-30 (f)); a public repository is refused `no-place`, not
 * `public-repository` (EV-29 (e)). Every key and credential is generated here, and nothing leaves loopback (G1).
 */

const slack = new FakeSlack()
const linear = new FakeLinear()
const jira = new NativeJira()
const journey = installJourney([slack, linear, jira])
/** The run's side: the body route answers on a server of its own, at its own path per job. */
const runs = new RouteHarness()
const THREAD = "1731335400.000100"
const TASK = "Fix the login button"

const previousRunSecret = process.env.VECTOR_RUN_TOKEN_SECRET
beforeAll(async () => {
  process.env.VECTOR_RUN_TOKEN_SECRET = randomBytes(32).toString("hex")
  await runs.start()
})
afterAll(async () => {
  await runs.stop()
  delete process.env.VECTOR_RUN_TOKEN_SECRET
  if (previousRunSecret !== undefined) process.env.VECTOR_RUN_TOKEN_SECRET = previousRunSecret
})

beforeEach(() => {
  slack.calls = []
  slack.answer = undefined
  slack.user = {
    id: "U0ALICE01",
    team_id: "T0123ABCD",
    is_bot: false,
    deleted: false,
    is_restricted: false,
    is_ultra_restricted: false,
  }
})

type Private = { readonly account: string; readonly jid: string; readonly text: string }

/**
 * spec §9's FakeCloudAgents behind EV-29's real adapter, with EV-30's real listeners on @vector's real run hooks. The
 * binding is `acme/app`'s, as the journey maps it. `enabled: false` keeps the default sources (ENABLED_SOURCES). A
 * second settle listener records what @vector's notify told the listeners. Both are removed in the teardown.
 */
function cloudAgents(input: {
  readonly account: string
  readonly config: EverywhereConfig
  readonly context: () => JobsContext
  readonly platforms: () => Platforms
  readonly fields?: (account: string) => Record<string, string>
  readonly app?: ReturnType<typeof stubApp>
  readonly enabled?: false
}) {
  const fields = input.fields
    ? input.fields(input.account)
    : bindingFields({ repositoryId: "101", account: input.account, with: { repository: "acme/app" } })
  const binding = bindingStore(() => fields)
  const app = input.app ?? privateApp()
  const prep = preparer()
  const mode = liveModes(async () => "codium")
  const ports = createCloudPorts({
    store: binding.store,
    app,
    prepare: prep.prepare,
    liveMode: mode.liveMode,
    ...(input.enabled === false ? {} : { sources: sources("slack", "linear", "jira") }),
  })
  const rid = runId()
  const vector = vectorStore(() => [vectorRun({ account: input.account, rid })])
  const events = createJobEvents(input.context, input.platforms)
  const remove = registerEverywhereRunHooks({
    config: input.config,
    hooks: {
      store: input.context().store,
      load: async () => ({
        context: input.context,
        settled: async (job) => {
          await events.settled?.(job)
        },
        switch: () => readEverywhereSwitch(input.config, codiumSwitches(journey.fetcher)),
      }),
    },
  })
  if (!remove) throw new Error("The everywhere run listeners were not registered.")
  const heard: RunEnd[] = []
  const stopHearing = registerRunSettleListener(async (_rid, end) => {
    heard.push(end)
  })
  journey.teardowns.push(async () => {
    remove()
    stopHearing()
  })
  return {
    binding,
    app,
    prep,
    mode,
    ports,
    rid,
    vector,
    heard,
    /** @vector's start hook for this ticket and run, as its mint route calls it. */
    start: (jid: string) => notifyRunStart(prep.state.ticketHash, rid, jid),
    /** @vector's settle hook for this run, with its record read from the stub of @vector's store. */
    settle: (end: Parameters<typeof notifyRunSettle>[1]) => notifyRunSettle(rid, end, vector.store),
  }
}

/**
 * A Slack journey: a linked requester in a mapped place (`acme/app`, private), the sponsor's plan, and no computer on
 * the relay. `seen` records a computer the sponsor was seen with (so a job may wait for it). The desktop's jobs client
 * stands by for the late claims; it is offered nothing.
 */
async function slackWorld(options: {
  readonly place: "channel" | "dm"
  readonly seen: boolean
  readonly fields?: (account: string) => Record<string, string>
  readonly app?: ReturnType<typeof stubApp>
  readonly enabled?: false
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
  const device = randomBytes(16).toString("base64url")
  if (options.seen) await recordSeen(f.context(), f.account, device)
  journey.seedPlan(f.account)

  const cloud = cloudAgents({
    account: f.account,
    config: f.config,
    context: f.context,
    platforms: () => ({ slack: adapter }),
    fields: options.fields,
    app: options.app,
    enabled: options.enabled,
  })
  const slept: number[] = []
  const deps: SlackDeps = {
    config: () => ({ ...f.config, offer: f.context().offer }),
    context: f.context,
    ports: { ...journeyPorts(journey, f), ...cloud.ports },
    fetcher: slack.fetch,
    sleep: async (ms) => {
      slept.push(ms)
      f.fake.clock.advance(ms)
    },
  }
  const adapter = createSlackAdapter(deps)
  const mounted = mountJourney(journey, {
    env: f.env,
    store: f.store,
    config: f.config,
    context: f.context,
    now: () => f.fake.clock.now,
    platforms: { slack: adapter },
    routes: { "/api/slack/events": createSlackRoutes(deps).events },
  })
  const signing = f.context().offer
  if (!signing) throw new Error("The router fixture signs offers.")
  const desktop = journeyComputer(journey, {
    account: f.account,
    device,
    offer: signing,
    now: () => f.fake.clock.now,
    claimAnswered: mounted.claimAnswered.promise,
  })
  journey.teardowns.push(async () => {
    mounted.claimAnswered.resolve()
    await desktop.close()
  })

  const send = () => {
    const body =
      options.place === "dm" ? f.envelope(TASK, { type: "message", channel: "D123", channel_type: "im" }) : f.envelope()
    return journey.harness.call("POST", "/api/slack/events", { body, headers: f.sign(JSON.stringify(body)) })
  }
  return {
    platform: "slack" as const,
    requester: "U0ALICE01",
    f,
    place,
    device,
    cloud,
    desktop,
    slept,
    cronSecret: mounted.cronSecret,
    send,
    natives: () => slack.calls.length,
  }
}

/** A Linear journey: the creator linked, the team mapped to `acme/app` alone, the sponsor's plan, no computer online. */
async function linearWorld(options: { readonly seen: boolean; readonly store?: Store }) {
  const f = await linearFixture(linear, { store: options.store })
  expect((await f.link()).ok).toBe(true)
  const mapped = await setMapping(f.context(), {
    account: f.account,
    installation: f.installation,
    place: linear.team,
    repositories: [{ id: 101, fullName: "acme/app" }],
    private: false,
  })
  if (!mapped.ok) throw new Error("The journey's mapping was refused.")
  const device = randomBytes(16).toString("base64url")
  if (options.seen) await recordSeen(f.context(), f.account, device)
  journey.seedPlan(f.account)

  const cloud = cloudAgents({
    account: f.account,
    config: f.config,
    context: f.context,
    platforms: () => ({ linear: adapter }),
  })
  const slept: number[] = []
  const privates: Private[] = []
  const deps: LinearDeps = {
    config: () => f.config,
    context: f.context,
    ports: { ...journeyPorts(journey, f), ...cloud.ports },
    fetcher: linear.fetch,
    sleep: async (ms) => {
      slept.push(ms)
      f.fake.clock.advance(ms)
    },
    // Production sets none, so a shared place's private text stays held (EV-20 (c)).
    privateResult: async (input) => {
      privates.push({ account: input.account, jid: input.jid, text: input.text })
    },
  }
  const adapter = createLinearAdapter(deps)
  const mounted = mountJourney(journey, {
    env: f.env,
    store: f.store,
    config: f.config,
    context: f.context,
    now: () => f.fake.clock.now,
    platforms: { linear: adapter },
    routes: { "/api/linear/webhook": createLinearWebhook(deps) },
  })
  const signing = f.context().offer
  if (!signing) throw new Error("The router fixture signs offers.")
  const desktop = journeyComputer(journey, {
    account: f.account,
    device,
    offer: signing,
    now: () => f.fake.clock.now,
    claimAnswered: mounted.claimAnswered.promise,
  })
  journey.teardowns.push(async () => {
    mounted.claimAnswered.resolve()
    await desktop.close()
  })

  const send = () => {
    const body = f.envelope()
    return journey.harness.call("POST", "/api/linear/webhook", { body, headers: f.sign(JSON.stringify(body)) })
  }
  return {
    platform: "linear" as const,
    requester: linear.user,
    f,
    device,
    cloud,
    desktop,
    slept,
    privates,
    cronSecret: mounted.cronSecret,
    send,
    natives: () => linear.calls.length,
  }
}

/** A Jira journey: the site connected, the requester linked, project PROJ mapped to `acme/app`, no computer online. */
async function jiraWorld(options: { readonly seen: boolean }) {
  const f = await jiraFixture(jira)
  const mapped = await setMapping(f.context(), {
    account: f.account,
    installation: f.installation,
    place: "PROJ",
    repositories: [{ id: 101, fullName: "acme/app" }],
    private: false,
  })
  if (!mapped.ok) throw new Error("The journey's mapping was refused.")
  const device = randomBytes(16).toString("base64url")
  if (options.seen) await recordSeen(f.context(), f.account, device)
  journey.seedPlan(f.account)

  const cloud = cloudAgents({
    account: f.account,
    config: f.config,
    context: f.context,
    platforms: () => ({ jira: adapter }),
  })
  const privates: Private[] = []
  const deps: JiraDeps = {
    config: () => f.config,
    context: f.context,
    ports: { ...journeyPorts(journey, f), ...cloud.ports },
    fetcher: jira.fetch,
    sleep: async (ms) => {
      f.fake.clock.advance(ms)
    },
    privateResult: async (input) => {
      privates.push({ account: input.account, jid: input.jid, text: input.text })
    },
  }
  const adapter = createJiraAdapter(deps).adapter
  const mounted = mountJourney(journey, {
    env: f.env,
    store: f.store,
    config: f.config,
    context: f.context,
    now: () => f.fake.clock.now,
    platforms: { jira: adapter },
    routes: { "/api/jira/a2a": createJiraRoutes(deps).a2a },
  })
  const signing = f.context().offer
  if (!signing) throw new Error("The router fixture signs offers.")
  const desktop = journeyComputer(journey, {
    account: f.account,
    device,
    offer: signing,
    now: () => f.fake.clock.now,
    claimAnswered: mounted.claimAnswered.promise,
  })
  journey.teardowns.push(async () => {
    mounted.claimAnswered.resolve()
    await desktop.close()
  })

  // Every call carries a fresh FIT for the server's current time, the user's token and a system token never used.
  const system = `unused-system-${randomUUID()}`
  const call = async (body: unknown) => {
    jira.now = f.fake.clock.now
    return journey.harness.call("POST", "/api/jira/a2a", {
      body,
      headers: {
        authorization: `Bearer ${await jira.sign()}`,
        "x-forge-oauth-user": jira.token,
        "x-forge-oauth-system": system,
      },
    })
  }
  const poll = (id: string) => call({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id } })
  return { f, device, cloud, desktop, privates, cronSecret: mounted.cronSecret, call, poll }
}

/** The state and the message text a Jira A2A answer gives, from a SendMessage (`result.task`) or a GetTask. */
function taskOf(answer: RouteAnswer) {
  const task = answer.body?.result?.task ?? answer.body?.result
  return {
    state: task?.status?.state as string | undefined,
    text: task?.status?.message?.parts?.[0]?.text as string | undefined,
  }
}

function sweep(w: { readonly cronSecret: string }) {
  return journey.harness.call("GET", "/api/everywhere/sweep", { token: w.cronSecret })
}

/** The ticket links the FakeStore holds: a dispatch writes one, and it goes when the job ends. */
function ticketKeys(f: { readonly fake: { readonly data: ReadonlyMap<string, unknown> } }) {
  const prefix = everywhereKeys.ticket("a".repeat(64)).slice(0, -64)
  return [...f.fake.data.keys()].filter((key) => key.startsWith(prefix))
}

type ActionsWorld = Awaited<ReturnType<typeof slackWorld>> | Awaited<ReturnType<typeof linearWorld>>

/**
 * Steps 1 to 6 for Slack and Linear, from the signed event to the settled job, with E8's late claims after the dispatch,
 * the start and the settle. Step 7, the post, is each platform's own: it answers the job id and where the native calls
 * stood after the dispatch and before the settle.
 */
async function throughActions(w: ActionsWorld) {
  const answer = await w.send()
  expect(answer.status).toBe(200)
  expect(answer.body).toEqual({ received: true })
  await drainAfter()

  // 3. Presence offline through the relay: no offer, no poll. 4. The fake prepareCloudRun gets only the fixed line.
  expect(journey.actions).toEqual(["presence"])
  expect(w.slept).toEqual([])
  const dispatched = await onlyJob(w.f.store, w.f.account)
  const jid = dispatched.jid
  expect(dispatched).toMatchObject({
    state: "dispatched",
    route: "actions",
    ticketHash: w.cloud.prep.state.ticketHash,
    repository: { id: 101, fullName: "acme/app", shared: false },
  })
  expect(await getValue(w.f.store, everywhereKeys.ticket(w.cloud.prep.state.ticketHash))).toBe(jid)
  expect(w.cloud.prep.state.triggers).toEqual([
    {
      source: w.platform,
      account: w.f.account,
      requestedBy: { platform: w.platform, userId: w.requester },
      target: { kind: "github-run", repositoryId: 101 },
      prompt: `${ACTIONS_JOB_PROMPT}${jid}`,
      purpose: "task",
      jobId: jid,
    },
  ])
  expect(jobOfActionsPrompt(w.cloud.prep.state.triggers[0]!.prompt)).toBe(jid)
  // E4, E11: the task never leaves for GitHub with the dispatch; the run reads it once, by reference (step 5).
  expect(JSON.stringify(w.cloud.prep.state.triggers)).not.toContain(TASK)
  // Facts, prepare and the router's recheck: three live visibility reads and five binding reads (EV-29 (h)).
  expect({
    dispatches: w.cloud.prep.state.dispatches,
    app: w.cloud.app.calls.length,
    mode: w.cloud.mode.calls.length,
    binding: w.cloud.binding.commands.length,
  }).toEqual({ dispatches: 1, app: 3, mode: 1, binding: 5 })
  const dispatchMark = w.natives()

  // E8 after the dispatch: a late laptop claim loses, by any computer, and a computer that asks is offered nothing.
  // These probes record the device as seen (the claim and pending routes do), which this world already did.
  await expectNoReclaim(journey, w.desktop, { jid, device: w.device })
  const pending = await journey.harness.call("GET", "/api/everywhere/jobs/pending", {
    token: w.desktop.token,
    headers: { [DEVICE_HEADER]: w.device },
    query: {
      [READINESS_QUERY.takesJobs]: "1",
      [READINESS_QUERY.remote]: "1",
      [READINESS_QUERY.localMode]: "0",
      [READINESS_QUERY.sandbox]: "1",
      [READINESS_QUERY.waitForComputer]: "1",
      [READINESS_QUERY.capsRoom]: "1",
      [READINESS_QUERY.projects]: "1",
    },
  })
  expect({ status: pending.status, body: pending.body }).toEqual({ status: 200, body: { offers: [], waiting: 0 } })

  // 5. The fake start hook: @vector's notifyRunStart reaches EV-30's listener, which links the run.
  const startMark = w.natives()
  await w.cloud.start(jid)
  expect(await readJob(w.f.store, jid)).toMatchObject({ state: "running", route: "actions", rid: w.cloud.rid })
  expect(await getValue(w.f.store, everywhereKeys.run(w.cloud.rid))).toBe(jid)
  expect(await getValue(w.f.store, everywhereKeys.runSettle(w.cloud.rid))).toBe(jid)
  expect(w.natives()).toBe(startMark)
  await expectNoReclaim(journey, w.desktop, { jid, device: w.device })

  // The run reads its request once, by reference, through the real body route with a real run token. The route is
  // called as Vercel calls it: the [jid] path segment arrives as the `jid` query value.
  const path = `/api/everywhere/jobs/${jid}/body`
  runs.mount({
    [path]: createJobBodyRoute({
      env: w.f.env,
      store: w.f.store,
      accountAuthority: testAccountAuthority,
      fetcher: journey.fetcher,
      now: () => w.f.fake.clock.now,
      switches: codiumSwitches(journey.fetcher),
      visibility: createRunBodyVisibility({ store: w.cloud.binding.store, app: w.cloud.app }),
      // The token's live-run check is cloud-agents-run-token.test.ts's; here its store answers live.
      runTokens: { store: async () => "ok", revokedBefore: async () => undefined },
    }),
  })
  const now = w.f.fake.clock.now
  const token = mintRunToken({
    sub: w.f.account,
    rid: w.cloud.rid,
    repo: "101",
    thr: "dispatch-1",
    gen: 1,
    src: "github-dispatch",
    pur: "task",
    epoch: "p1",
    dl: now + 45 * 60_000,
    iat: now - 1_000,
    jti: randomBytes(16).toString("base64url"),
  }).token
  const kept = await readJobBody(w.f.context(), jid)
  if (!kept) throw new Error("The journey's body is missing.")
  const read = await runs.call("GET", path, { token, query: { jid } })
  expect({ status: read.status, body: read.body }).toEqual({
    status: 200,
    body: {
      task: TASK,
      context: kept.context.map((item) => ({ from: item.from, text: item.text })),
      outside: w.platform,
    },
  })
  const again = await runs.call("GET", path, { token, query: { jid } })
  expect({ status: again.status, code: again.body?.error?.code }).toEqual({
    status: 410,
    code: "EVERYWHERE_BODY_GONE",
  })

  // 6. The fake settle hook with a pull request of the job's repository: @vector's notify passes the link on to its
  // listeners (the recording one hears it), and EV-30's listener settles the job and posts without it (EV-30 (f)).
  const resultMark = w.natives()
  await w.cloud.settle({ outcome: "changes", prUrl: PR_URL })
  expect(w.cloud.heard).toEqual([
    { outcome: "changes", runUrl: vectorRun({ account: w.f.account, rid: w.cloud.rid }).runUrl, prUrl: PR_URL },
  ])
  const settled = await readJob(w.f.store, jid)
  expect(settled).toMatchObject({ state: "settled", route: "actions", outcome: "changes", rid: w.cloud.rid })
  expect(settled?.result).toBeUndefined()
  expect(await readJobBody(w.f.context(), jid)).toBeUndefined()
  for (const key of [
    everywhereKeys.jobBody(jid),
    everywhereKeys.ticket(w.cloud.prep.state.ticketHash),
    everywhereKeys.run(w.cloud.rid),
    everywhereKeys.runSettle(w.cloud.rid),
    everywhereKeys.runBodyRead(w.cloud.rid),
  ])
    expect({ key, value: await getValue(w.f.store, key) }).toEqual({ key, value: undefined })
  expect(await w.f.store(["ZSCORE", everywhereKeys.jobsPosts(), jid])).toBeNull()
  await expectNoReclaim(journey, w.desktop, { jid, device: w.device })
  expect(journey.guard.violations).toEqual([])
  return { jid, dispatchMark, resultMark }
}

/**
 * S1's journey: the Slack thread gets the plan, then only the outcome; the requester alone gets the private copy.
 * `commands` is every command the world's store sent: the FakeStore's log, or the Valkey runs' recording.
 */
async function slackActions(
  w: Awaited<ReturnType<typeof slackWorld>>,
  commands: readonly unknown[] = w.f.fake.commands,
) {
  const run = await throughActions(w)
  const rendered = renderResult({
    platform: "slack",
    route: "actions",
    outcome: "changes",
    shared: true,
    repository: "acme/app",
  })
  // Neither a pull request link nor the checks line until the head-branch check exists (EV-30 (f), Left open).
  expect(rendered.text).toBe("Done in GitHub Actions.")

  const admitted = slack.calls.slice(0, run.dispatchMark)
  expect(admitted.map((call) => [call.method, call.body.status])).toEqual([
    ["agents.sessions.setStatus", "processing"],
    ["users.info", undefined],
    ["agents.sessions.setStatus", "processing"],
    ["chat.postMessage", undefined],
  ])
  expect(admitted[3]!.body).toMatchObject({
    channel: "C123",
    thread_ts: THREAD,
    text: "Vector is working on this task.",
    blocks: [slackPlan("actions")],
    unfurl_links: false,
    unfurl_media: false,
  })
  // Nothing reached Slack between the dispatch and the settle: not the late claims, the start or the body read.
  expect(run.resultMark).toBe(run.dispatchMark)

  const result = slack.calls.slice(run.resultMark)
  expect(result.map((call) => [call.method, call.body.status])).toEqual([
    ["chat.postMessage", undefined],
    ["chat.postEphemeral", undefined],
    ["agents.sessions.setStatus", "active"],
  ])
  expect(result[0]!.body).toMatchObject({
    channel: "C123",
    thread_ts: THREAD,
    text: rendered.text,
    blocks: [slackPlan("pushing", true), ...slackResult(rendered.text)],
    unfurl_links: false,
    unfurl_media: false,
  })
  expect(result[1]!.body).toMatchObject({
    channel: "C123",
    thread_ts: THREAD,
    user: "U0ALICE01",
    text: rendered.privateText,
    unfurl_links: false,
    unfurl_media: false,
  })
  // E17 in the shared thread: no repository name and no device; and no pull request link or checks line anywhere.
  for (const call of slack.calls.filter((each) => ["chat.postMessage", "chat.update"].includes(each.method))) {
    expect(JSON.stringify(call.body)).not.toContain("acme/app")
    expect(JSON.stringify(call.body)).not.toContain(w.device)
  }
  expect(JSON.stringify(slack.calls)).not.toContain(PR_URL)
  expect(JSON.stringify(slack.calls)).not.toContain(CHECKS)
  // E4 on the store's command log: the task never reached the store in plaintext.
  expect(commands.length).toBeGreaterThan(0)
  expect(JSON.stringify(commands)).not.toContain(TASK)
  return run
}

function activityInput(call: FakeLinear["calls"][number] | undefined) {
  return call?.variables.input as Record<string, unknown> | undefined
}

/** L1's journey: the session gets the GitHub runner's thought and plan, then the completed plan and the outcome. */
async function linearActions(
  w: Awaited<ReturnType<typeof linearWorld>>,
  commands: readonly unknown[] = w.f.fake.commands,
) {
  const run = await throughActions(w)
  const admitted = linear.calls.slice(0, run.dispatchMark)
  expect(admitted.map((call) => call.operation)).toEqual(["create", "user", "create", "session"])
  expect(activityInput(admitted[0])).toMatchObject({
    agentSessionId: linear.session,
    ephemeral: true,
    content: { type: "thought", body: "Received your request. Checking the connection and workspace." },
  })
  expect(activityInput(admitted[2])).toMatchObject({
    agentSessionId: linear.session,
    ephemeral: true,
    content: { type: "thought", body: "Starting your GitHub runner." },
  })
  expect(admitted[3]!.variables).toMatchObject({ id: linear.session, input: { plan: linearPlan("actions") } })
  expect(run.resultMark).toBe(run.dispatchMark)

  const result = linear.calls.slice(run.resultMark)
  expect(result.map((call) => call.operation)).toEqual(["session", "create"])
  // The job page and no pull request (EV-30 (f)).
  expect(result[0]!.variables).toEqual({
    id: linear.session,
    input: {
      plan: linearPlan("pushing", "completed"),
      addedExternalUrls: [{ label: "Vector job", url: `https://vectordev.ai/everywhere?job=${run.jid}` }],
    },
  })
  const rendered = renderResult({
    platform: "linear",
    route: "actions",
    outcome: "changes",
    shared: true,
    repository: "acme/app",
  })
  expect(rendered.text).toBe("Done in GitHub Actions.")
  expect(activityInput(result[1])).toMatchObject({
    agentSessionId: linear.session,
    content: { type: "response", body: rendered.text },
  })
  expect(w.privates).toEqual([{ account: w.f.account, jid: run.jid, text: rendered.privateText! }])

  // No `error` activity: Vector posted only thoughts and the response; the creator's prompt is the only other one.
  const activities = [...linear.activities.values()]
  expect(
    activities.filter((activity) => activity.user.id === linear.bot).map((activity) => activity.content.__typename),
  ).toEqual(["AgentActivityThoughtContent", "AgentActivityThoughtContent", "AgentActivityResponseContent"])
  expect(activities.filter((activity) => activity.user.id !== linear.bot)).toHaveLength(1)
  // E17 in the session: no repository name, device, pull request link or checks line in any post.
  for (const call of linear.calls.filter((each) => each.operation === "create" || each.operation === "session")) {
    const posted = JSON.stringify(call.variables)
    expect(posted).not.toContain("acme/app")
    expect(posted).not.toContain(w.device)
    expect(posted).not.toContain(PR_URL)
    expect(posted).not.toContain(CHECKS)
  }
  // E4 and E5: the task and Linear's tokens never reach the store in plaintext, and the tokens never reach GitHub.
  expect(commands.length).toBeGreaterThan(0)
  const sent = JSON.stringify(commands)
  for (const kept of [TASK, linear.token, linear.refresh]) expect(sent).not.toContain(kept)
  for (const secret of [linear.token, linear.refresh])
    expect(JSON.stringify(w.cloud.prep.state.triggers)).not.toContain(secret)
  return run
}

test(
  "S1: a Slack channel mention runs in GitHub Actions while the computer is offline, and the thread gets only the outcome (E4, E8, E11, E17)",
  async () => {
    const w = await slackWorld({ place: "channel", seen: true })
    const run = await slackActions(w)
    expect((await readJob(w.f.store, run.jid))?.shared).toBe(true)
  },
  CASE_MS,
)

test(
  "L1: a Linear session runs in GitHub Actions while the computer is offline, and the session gets only the outcome (E4, E5, E8, E11, E17)",
  async () => {
    const w = await linearWorld({ seen: true })
    const run = await linearActions(w)
    expect((await readJob(w.f.store, run.jid))?.shared).toBe(true)
  },
  CASE_MS,
)

test(
  "J1: a Jira assignment never takes the Actions route, even with Jira in the injected sources: it waits 10 minutes, then ends with Jira's own text (EV-30 (j))",
  async () => {
    const w = await jiraWorld({ seen: true })
    expect(w.cloud.ports.prepareCloud).toBeDefined()
    expect(w.cloud.ports.cloudSource!("jira")).toBe(false)
    const sent = await w.call(jira.message())
    expect(sent.status).toBe(200)
    expect(taskOf(sent)).toEqual({
      state: "TASK_STATE_SUBMITTED",
      text: "Received your request. Waiting for your computer.",
    })
    const task = String(sent.body.result.task.id)
    await drainAfter()

    const waiting = await onlyJob(w.f.store, w.f.account)
    expect(waiting).toMatchObject({ state: "waiting", route: "queue", kind: "assign" })
    expect(waiting.queueUntil).toBe(waiting.receivedAt + TIMING.jiraQueueMs)
    // No binding, visibility, mode or prepare read, and no ticket: routing never looked at Actions for Jira.
    expect({
      binding: w.cloud.binding.commands,
      app: w.cloud.app.calls,
      mode: w.cloud.mode.calls,
      triggers: w.cloud.prep.state.triggers,
      tickets: ticketKeys(w.f),
    }).toEqual({ binding: [], app: [], mode: [], triggers: [], tickets: [] })
    expect(journey.actions).toEqual(["presence"])
    expect(await readJobBody(w.f.context(), waiting.jid)).toBeDefined()

    w.f.fake.clock.now = waiting.queueUntil! - 1
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 0, posted: 0 } })
    expect(taskOf(await w.poll(task)).state).toBe("TASK_STATE_SUBMITTED")
    w.f.fake.clock.now = waiting.queueUntil!
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 1, posted: 1 } })
    await drainAfter()
    expect(await readJob(w.f.store, waiting.jid)).toMatchObject({ state: "expired", ending: "jira-waiting" })
    // E4: the expiry ended the job, so its sealed body is gone.
    expect(await getValue(w.f.store, everywhereKeys.jobBody(waiting.jid))).toBeUndefined()
    expect(taskOf(await w.poll(task))).toEqual({ state: "TASK_STATE_FAILED", text: renderEnd("jira-waiting", "jira") })
    expect(w.privates).toEqual([])
    await expectNoReclaim(journey, w.desktop, { jid: waiting.jid, device: w.device })
    expect(w.cloud.prep.state.triggers).toEqual([])
  },
  CASE_MS,
)

test.each([
  ["read public live at the facts' read", 1, false],
  ["read public live at prepareCloud's read", 2, false],
  ["read public live at the router's recheck", 3, false],
  ["the facts' read failing, which counts as public", 1, true],
] as const)(
  "P1 (E11): stored private, %s, and the computer never seen: refused no-place (EV-29 (e)), no ticket, never dispatched",
  async (_, publicFrom, fails) => {
    const reads = { count: 0 }
    const app = stubApp(async () => {
      if (++reads.count < publicFrom) return { publicRepository: false, visibility: "private" }
      if (fails) throw new Error("github down")
      return { publicRepository: true }
    })
    const w = await slackWorld({ place: "channel", seen: false, app })
    const answer = await w.send()
    expect(answer.status).toBe(200)
    await drainAfter()

    const text = renderRefusal("no-place", { platform: "slack", shared: true })
    // A refused job has left the live index at once; the account's history still holds it.
    expect(await w.f.store(["ZRANGE", everywhereKeys.jobs(w.f.account), 0, -1])).toEqual([])
    const history = await readJobHistory(w.f.store, w.f.account, { now: w.f.fake.clock.now, limit: 10 })
    if (publicFrom === 1) {
      // Refused at intake: no job, and the requester alone is told.
      expect(history.jobs).toEqual([])
      expect(slack.calls.map((call) => [call.method, call.body.status])).toEqual([
        ["agents.sessions.setStatus", "processing"],
        ["users.info", undefined],
        ["chat.postEphemeral", undefined],
        ["agents.sessions.setStatus", "active"],
      ])
      expect(slack.calls[2]!.body).toMatchObject({ channel: "C123", user: "U0ALICE01", text })
    }
    if (publicFrom > 1) {
      expect(history.jobs).toHaveLength(1)
      const job = history.jobs[0]!
      expect(job).toMatchObject({ state: "refused", code: "no-place" })
      // Never routed: no route, no dispatch time and no ticket on the record.
      expect({ route: job.route, dispatchedAt: job.dispatchedAt, ticketHash: job.ticketHash }).toEqual({
        route: undefined,
        dispatchedAt: undefined,
        ticketHash: undefined,
      })
      // E4: the refusal ended the job, so its sealed body is gone.
      expect(await getValue(w.f.store, everywhereKeys.jobBody(job.jid))).toBeUndefined()
      expect(slack.calls.map((call) => [call.method, call.body.status])).toEqual([
        ["agents.sessions.setStatus", "processing"],
        ["users.info", undefined],
        ["chat.postMessage", undefined],
        ["agents.sessions.setStatus", "active"],
      ])
      expect(slack.calls[2]!.body).toMatchObject({ channel: "C123", thread_ts: THREAD, text })
    }
    // The read that saw it public is the last one: prepareCloudRun is reached only after the second, private read.
    expect({
      app: w.cloud.app.calls.length,
      mode: w.cloud.mode.calls.length,
      triggers: w.cloud.prep.state.triggers.map((trigger) => trigger.prompt),
      cancels: w.cloud.prep.state.cancels,
      dispatches: w.cloud.prep.state.dispatches,
    }).toEqual({
      app: publicFrom,
      mode: publicFrom === 3 ? 1 : 0,
      triggers: publicFrom === 3 ? [`${ACTIONS_JOB_PROMPT}${history.jobs[0]?.jid}`] : [],
      cancels: publicFrom === 3 ? 1 : 0,
      dispatches: 0,
    })
    expect(ticketKeys(w.f)).toEqual([])
    expect(slack.calls.some((call) => JSON.stringify(call.body).includes(JSON.stringify(slackPlan("actions"))))).toBe(
      false,
    )
  },
  CASE_MS,
)

test(
  "W1: a binding with no stored workflow mode waits for the computer, then expires with Slack's own text",
  async () => {
    const w = await slackWorld({
      place: "channel",
      seen: true,
      fields: (account) =>
        bindingFields({ repositoryId: "101", account, with: { repository: "acme/app" }, drop: ["workflowMode"] }),
    })
    await w.send()
    await drainAfter()
    const waiting = await onlyJob(w.f.store, w.f.account)
    expect(waiting).toMatchObject({ state: "waiting", route: "queue" })
    expect(waiting.queueUntil).toBe(waiting.receivedAt + TIMING.queueMs)
    // The facts read the binding and its visibility, then the policy asks for a codium binding: prepareCloud never
    // runs, so no third binding read, no mode read, no ticket.
    expect({
      binding: w.cloud.binding.commands.length,
      app: w.cloud.app.calls.length,
      mode: w.cloud.mode.calls.length,
      triggers: w.cloud.prep.state.triggers.length,
      tickets: ticketKeys(w.f),
    }).toEqual({ binding: 2, app: 1, mode: 0, triggers: 0, tickets: [] })
    expect(slack.calls.map((call) => call.method)).toEqual([
      "agents.sessions.setStatus",
      "users.info",
      "agents.sessions.setStatus",
      "chat.postMessage",
    ])
    expect(slack.calls[3]!.body).toMatchObject({ blocks: [slackPlan("waiting")] })
    expect((await readJobBody(w.f.context(), waiting.jid))?.task).toBe(TASK)

    w.f.fake.clock.now = waiting.queueUntil! - 1
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 0, posted: 0 } })
    const mark = w.natives()
    w.f.fake.clock.now = waiting.queueUntil!
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 1, posted: 1 } })
    await drainAfter()
    expect(await readJob(w.f.store, waiting.jid)).toMatchObject({ state: "expired", ending: "expired" })
    // E4: the expiry ended the job, so its sealed body is gone.
    expect(await getValue(w.f.store, everywhereKeys.jobBody(waiting.jid))).toBeUndefined()
    const ended = slack.calls.slice(mark)
    expect(ended.map((call) => [call.method, call.body.status])).toEqual([
      ["chat.postMessage", undefined],
      ["agents.sessions.setStatus", "active"],
    ])
    expect(ended[0]!.body).toMatchObject({ channel: "C123", thread_ts: THREAD, text: renderEnd("expired", "slack") })
    await expectNoReclaim(journey, w.desktop, { jid: waiting.jid, device: w.device })
  },
  CASE_MS,
)

test(
  "N1: a dispatch whose run never starts fails not-started at 900 s with the fixed help; a late start moves nothing",
  async () => {
    const w = await slackWorld({ place: "dm", seen: true })
    await w.send()
    await drainAfter()
    const dispatched = await onlyJob(w.f.store, w.f.account)
    expect(dispatched).toMatchObject({ state: "dispatched", route: "actions", shared: false })
    const due = dispatched.dispatchedAt! + TIMING.dispatchStartMs
    expect((await readJobBody(w.f.context(), dispatched.jid))?.task).toBe(TASK)

    w.f.fake.clock.now = due - 1
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 0, posted: 0 } })
    const mark = w.natives()
    w.f.fake.clock.now = due
    expect(await sweep(w)).toMatchObject({ status: 200, body: { ended: 1, posted: 1 } })
    await drainAfter()
    const failed = await readJob(w.f.store, dispatched.jid)
    expect(failed).toMatchObject({ state: "failed", ending: "not-started" })
    // E4: the failure ended the job, so its sealed body is gone.
    expect(await getValue(w.f.store, everywhereKeys.jobBody(dispatched.jid))).toBeUndefined()
    const ended = slack.calls.slice(mark)
    expect(ended.map((call) => [call.method, call.body.status])).toEqual([
      ["chat.postMessage", undefined],
      ["agents.sessions.setStatus", "active"],
    ])
    expect(ended[0]!.body).toMatchObject({ channel: "D123", text: renderEnd("not-started", "slack") })
    expect(ticketKeys(w.f)).toEqual([])

    const late = w.natives()
    await w.cloud.start(dispatched.jid)
    expect((await readJob(w.f.store, dispatched.jid))?.version).toBe(failed?.version)
    expect(await getValue(w.f.store, everywhereKeys.run(w.cloud.rid))).toBeUndefined()
    expect(w.natives()).toBe(late)
    await expectNoReclaim(journey, w.desktop, { jid: dispatched.jid, device: w.device })
  },
  CASE_MS,
)

test(
  "D1: with the default sources there is no prepareCloud, so the same mention reads no binding, issues no ticket and waits (R-C8/R-A8 tripwire)",
  async () => {
    expect((["slack", "linear", "jira"] as RunSource[]).map((source) => ENABLED_SOURCES.has(source))).toEqual([
      false,
      false,
      false,
    ])
    const w = await slackWorld({ place: "channel", seen: true, enabled: false })
    expect(w.cloud.ports.prepareCloud).toBeUndefined()
    await w.send()
    await drainAfter()
    expect(await onlyJob(w.f.store, w.f.account)).toMatchObject({ state: "waiting", route: "queue" })
    expect({
      binding: w.cloud.binding.commands.length,
      app: w.cloud.app.calls.length,
      mode: w.cloud.mode.calls.length,
      triggers: w.cloud.prep.state.triggers.length,
      tickets: ticketKeys(w.f),
    }).toEqual({ binding: 0, app: 0, mode: 0, triggers: 0, tickets: [] })
  },
  CASE_MS,
)

test("G1: the fetch guard stops any request that leaves loopback, and the platform fakes answer only their own addresses", async () => {
  // The guard is the fetch in place. The probe aims at a reserved name that never resolves, so even a broken guard
  // sends nothing; the fakes refuse a foreign address before they send anything.
  expect(globalThis.fetch).not.toBe(journey.unguarded)
  await expect(globalThis.fetch("https://guard-probe.invalid/")).rejects.toThrow("The fetch guard stopped")
  expect(journey.guard.violations.splice(0)).toEqual(["guard-probe.invalid"])
  expect(() => slack.fetch("https://guard-probe.invalid/api/chat.postMessage")).toThrow("Unexpected fake Slack address")
  expect(() => linear.fetch("https://guard-probe.invalid/graphql")).toThrow("Unexpected fake Linear address")
  expect(() => jira.fetch("https://guard-probe.invalid/rest/api/3/myself")).toThrow(
    "Unexpected native Jira test address",
  )
})

/** Every command a REST store sends through `fetcher`, decoded: the Valkey runs' counterpart of the FakeStore's log. */
function recording(fetcher: typeof fetch) {
  const commands: unknown[] = []
  const record = (async (input: RequestInfo | URL, init?: RequestInit) => {
    commands.push(JSON.parse(String(init?.body)))
    return fetcher(input, init)
  }) as typeof fetch
  return { fetch: record, commands }
}

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeEach(async () => {
    redis = (await realRedis())!
  })
  // A describe's afterEach runs before the file's, so the journey's teardown runs here first, while Valkey is open.
  afterEach(async () => {
    await journey.teardown()
    await redis.close()
  })

  test(
    "R1: S1's journey on Valkey: the fenced dispatch, the start's link, the read-once script and the settle, with no task text in any command",
    async () => {
      const sent = recording(redis.fetch)
      const store = testEverywhereStore(sent.fetch)
      const w = await slackWorld({ place: "channel", seen: true, store })
      const run = await slackActions(w, sent.commands)
      expect(await readJob(store, run.jid)).toMatchObject({ state: "settled", route: "actions", outcome: "changes" })
      expect(w.f.fake.commands).toEqual([])
    },
    CASE_MS,
  )

  test(
    "R2: L1's journey on Valkey, with neither the task nor Linear's tokens in any command",
    async () => {
      const sent = recording(redis.fetch)
      const store = testEverywhereStore(sent.fetch)
      const w = await linearWorld({ seen: true, store })
      const run = await linearActions(w, sent.commands)
      expect(await readJob(store, run.jid)).toMatchObject({ state: "settled", route: "actions", outcome: "changes" })
      expect(w.f.fake.commands).toEqual([])
    },
    CASE_MS,
  )
})
