import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { GithubAgents } from "../../core/src/github-agents"
import { notifyRunSettle, notifyRunStart } from "../../../api/_lib/cloud-agents-runs"
import { cloudAgentsEnabled } from "../../../api/_lib/model-plan-config"
import {
  ACTIONS_OUTCOME,
  createActionsRunEnd,
  createCloudPorts,
  createRunHooks,
  createHandoffBinding,
  type CloudPortsDeps,
  type RunJobDeps,
} from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { readConfig } from "../../../api/_lib/everywhere/config"
import { createJobEvents, postPending } from "../../../api/_lib/everywhere/events"
import {
  ACTIONS_CRON_GRACE_MS,
  ACTIONS_OUTCOMES,
  ACTIONS_OVERDUE_MS,
  claimJob,
  dispatchJob,
  offerJob,
  readJob,
  recordSeen,
  startDispatched,
  sweepDue,
} from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { routeJob } from "../../../api/_lib/everywhere/router"
import { registerEverywhereRunHooks } from "../../../api/_lib/everywhere/run-hooks"
// The registration module the two @vector routes import: in this process the flag is off, so it registers nothing.
import "../../../api/_lib/everywhere/run-hooks-registration"
import { productionPorts } from "../../../api/_lib/everywhere/runtime"
import { getValue, type Store } from "../../../api/_lib/everywhere/store"
import { createSweep } from "../../../api/_lib/everywhere/sweep"
import { ENABLED_SOURCES, type RunSource } from "../../../packages/schema/src/codium-run-trigger"
import { ACTIONS_JOB_PROMPT, TIMING, createJobId, jobOfActionsPrompt } from "../../../packages/schema/src/everywhere"
import type { SwitchState } from "../../../packages/schema/src/everywhere-policy"
import { githubAppFixture } from "./github-app-fixture"
import { everywhereEnv, RouteHarness, secret } from "./lib/everywhere-account"
import {
  BINDING_KEY,
  VECTOR_RUN_KEY,
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
  type Command,
} from "./lib/everywhere-cloud-agents"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"
import { realRedis, testEverywhereStore, useKv, withTestAccountAuthority, type RealRedis } from "./lib/everywhere-store"

/*
 * VE-30a (EV-29): the Actions route's ports over @vector, with @vector's real binding decoder behind a stub store, the
 * real attachmentRepository behind the GitHub App fixture, a recorded prepareCloudRun and the real router. Nothing
 * leaves loopback. The @vector stand-ins are spec §9's FakeCloudAgents in lib/everywhere-cloud-agents.ts (EV-32).
 */

const guard = installFetchGuard()

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const TICKET_PREFIX = everywhereKeys.ticket("a".repeat(64)).slice(0, -64)

type FixtureState = Awaited<ReturnType<typeof githubAppFixture>>["state"]

/** A world where every gate passes for a Slack job on repository 123 sponsored by `account`. */
function world(
  change: Partial<CloudPortsDeps> & { readonly fields?: () => ReturnType<Parameters<typeof bindingStore>[0]> } = {},
) {
  const account = randomUUID()
  const jid = createJobId(Date.now())
  const store = bindingStore(change.fields ?? (() => bindingFields({ repositoryId: "123", account })))
  const app = privateApp()
  const prep = preparer()
  const mode = liveModes(async () => "codium")
  const ports = createCloudPorts({
    store: store.store,
    app,
    prepare: prep.prepare,
    liveMode: mode.liveMode,
    sources: sources("slack"),
    ...change,
  })
  const input = {
    jid,
    source: "slack" as const,
    sponsor: account,
    requestedBy: { platform: "slack", userId: "U0ALICE01" },
    repositoryId: 123,
    bodyReference: jid,
  }
  return { account, jid, store, app, prep, mode, ports, input }
}

describe("prepareCloud", () => {
  test("P1: with the default sources there is no prepareCloud, and a disabled source reads nothing", async () => {
    // R-C8/R-A8 is the owner's: until a platform leaves RESERVED there is no Actions route at all.
    expect(createCloudPorts({ liveMode: async () => "codium" }).prepareCloud).toBeUndefined()
    const w = world({ sources: sources("linear") })
    expect(w.ports.prepareCloud).toBeDefined()
    expect(await w.ports.prepareCloud!(w.input)).toBeUndefined()
    expect(await w.ports.prepareCloud!({ ...w.input, source: "jira" })).toBeUndefined()
    expect({ store: w.store.commands.length, app: w.app.calls.length, prepare: w.prep.state.triggers.length }).toEqual({
      store: 0,
      app: 0,
      prepare: 0,
    })
    expect(w.ports.cloudSource!("linear")).toBe(true)
    expect((["github", "slack", "jira"] as const).map((platform) => w.ports.cloudSource!(platform))).toEqual([
      false,
      false,
      false,
    ])
  })

  test("P13 (EV-30): Jira has no Actions route even as an enabled source, until a run limit ends it before 50 minutes", async () => {
    const w = world({ sources: sources("jira") })
    expect(w.ports.prepareCloud).toBeUndefined()
    expect(w.ports.cloudSource!("jira")).toBe(false)
    const both = world({ sources: sources("slack", "jira") })
    expect(await both.ports.prepareCloud!({ ...both.input, source: "jira" })).toBeUndefined()
    expect({ store: both.store.commands.length, prepare: both.prep.state.triggers.length }).toEqual({
      store: 0,
      prepare: 0,
    })
    expect(both.ports.cloudSource!("slack")).toBe(true)
  })

  test("P2: without the live mode read there is no prepareCloud", () => {
    const w = world({ liveMode: undefined })
    expect(w.ports.prepareCloud).toBeUndefined()
    expect(createCloudPorts({ sources: sources("slack", "linear", "jira") }).prepareCloud).toBeUndefined()
  })

  test.each([
    ["no stored mode", { drop: ["workflowMode"] }],
    ["an own-key mode", { with: { workflowMode: "own-key" } }],
  ] as const)("P3: %s gives no route and reads nothing from GitHub", async (_, edit) => {
    const account = randomUUID()
    const w = world({ fields: () => bindingFields({ repositoryId: "123", account, ...edit }) })
    expect(await w.ports.prepareCloud!({ ...w.input, sponsor: account })).toBeUndefined()
    expect({ app: w.app.calls.length, mode: w.mode.calls.length, prepare: w.prep.state.triggers.length }).toEqual({
      app: 0,
      mode: 0,
      prepare: 0,
    })
  })

  test.each([
    ["a missing binding", (): undefined => undefined],
    [
      "a suspended binding",
      () => bindingFields({ repositoryId: "123", account: ACCOUNT, with: { suspended: "transferred" } }),
    ],
    ["another account's binding", () => bindingFields({ repositoryId: "123", account: randomUUID() })],
    ["no installation", () => bindingFields({ repositoryId: "123", account: ACCOUNT, drop: ["installationId"] })],
    ["a store that is down", (): "down" => "down"],
    [
      "a corrupt stored binding",
      () => bindingFields({ repositoryId: "123", account: ACCOUNT, with: { workflowMode: "byok" } }),
    ],
  ] as const)("P4: %s gives no route", async (_, fields) => {
    const w = world({ fields })
    expect(await w.ports.prepareCloud!({ ...w.input, sponsor: ACCOUNT })).toBeUndefined()
    expect({ app: w.app.calls.length, prepare: w.prep.state.triggers.length }).toEqual({ app: 0, prepare: 0 })
  })

  test("P4: an id that is not a repository id reads nothing", async () => {
    const w = world()
    for (const repositoryId of [0, -1, 1.5, Number.NaN, 2 ** 53])
      expect(await w.ports.prepareCloud!({ ...w.input, repositoryId })).toBeUndefined()
    expect(w.store.commands).toEqual([])
  })

  test("P5 (E11): a binding stored private whose repository is now public is refused before any ticket", async () => {
    await using fixture = await githubAppFixture()
    const account = randomUUID()
    const fields = bindingFields({ repositoryId: fixture.repositoryId, account })
    const w = world({ app: fixture.app, fields: () => fields })
    expect(fields.visibility).toBe("private")
    const input = { ...w.input, sponsor: account, repositoryId: Number(fixture.repositoryId) }
    expect(await w.ports.prepareCloud!(input)).toBeUndefined()
    expect({ mode: w.mode.calls.length, prepare: w.prep.state.triggers.length }).toEqual({ mode: 0, prepare: 0 })
    // One single-repository token, metadata only, revoked after the read.
    expect(fixture.state.minted.map((item) => item.body)).toEqual([
      { repository_ids: [Number(fixture.repositoryId)], permissions: { metadata: "read" } },
    ])
    expect(fixture.tokens.size).toBe(0)
    // The read also refreshes the binder's one-hour cache (a write, three times per dispatch).
    expect(fixture.state.cache.has(`vector:cloud-agents:binder-ok:${fixture.repositoryId}`)).toBe(true)
    expect(guard.violations).toEqual([])
  })

  test.each([
    ["the App is off", (state: FixtureState) => Object.assign(state, { enabled: false })],
    ["the App is not installed", (state: FixtureState) => Object.assign(state, { installed: false })],
    ["the installation is suspended", (state: FixtureState) => Object.assign(state, { suspended: true })],
    ["the binder lost write access", (state: FixtureState) => Object.assign(state, { binderPermission: "read" })],
    [
      "the repository read fails",
      (state: FixtureState) => Object.assign(state, { failPath: "/repos/fixture-owner/project" }),
    ],
    ["the repository is archived", (state: FixtureState) => Object.assign(state.repository, { archived: true })],
    ["the default branch moved", (state: FixtureState) => Object.assign(state.repository, { default_branch: "dev" })],
    ["the binder cache store is down", (state: FixtureState) => Object.assign(state, { storeDown: true })],
  ] as const)("P6: a private repository whose live read fails (%s) counts as public", async (_, change) => {
    await using fixture = await githubAppFixture()
    fixture.state.repository.private = true
    change(fixture.state)
    const account = randomUUID()
    const w = world({ app: fixture.app, fields: () => bindingFields({ repositoryId: fixture.repositoryId, account }) })
    expect(await w.ports.visibility!(Number(fixture.repositoryId))).toBeUndefined()
    expect(
      await w.ports.prepareCloud!({ ...w.input, sponsor: account, repositoryId: Number(fixture.repositoryId) }),
    ).toBeUndefined()
    expect(w.prep.state.triggers).toEqual([])
    expect(fixture.tokens.size).toBe(0)
    expect(guard.violations).toEqual([])
  })

  test("P6: a revoked CLI session makes the binder cache refuse, which counts as public", async () => {
    const seen: Command[] = []
    await using fixture = await githubAppFixture({
      store: async (command) => {
        seen.push(command)
        return command[0] === "GET" ? null : "revoked"
      },
    })
    fixture.state.repository.private = true
    const account = randomUUID()
    const w = world({ app: fixture.app, fields: () => bindingFields({ repositoryId: fixture.repositoryId, account }) })
    expect(await w.ports.visibility!(Number(fixture.repositoryId))).toBeUndefined()
    expect(seen.map((command) => command[0])).toEqual(["GET", "EVAL"])
    expect(String(seen[1]![4])).toBe(`vector:cli-revoked:${account}`)
    expect(fixture.tokens.size).toBe(0)
    expect(guard.violations).toEqual([])
  })

  test.each([
    ["own-key", async (): Promise<"own-key"> => "own-key"],
    ["no mode", async (): Promise<undefined> => undefined],
    [
      "a read that fails",
      async (): Promise<undefined> => {
        throw new Error("unreadable")
      },
    ],
  ] as const)("P7: a stored codium mode with a live read of %s gives no route", async (_, answer) => {
    const mode = liveModes(answer)
    const w = world({ liveMode: mode.liveMode })
    expect(await w.ports.prepareCloud!(w.input)).toBeUndefined()
    expect(mode.calls).toHaveLength(1)
    expect(w.prep.state.triggers).toEqual([])
  })

  test("P8: a body reference other than the job, a bad job id or a bad sponsor reads nothing", async () => {
    const w = world()
    for (const input of [
      { ...w.input, bodyReference: createJobId(Date.now()) },
      { ...w.input, jid: "vej_bad", bodyReference: "vej_bad" },
      { ...w.input, sponsor: "not-an-account" },
    ])
      expect(await w.ports.prepareCloud!(input)).toBeUndefined()
    expect({ store: w.store.commands.length, app: w.app.calls.length }).toEqual({ store: 0, app: 0 })
  })

  test("P9: every gate holds, so prepareCloudRun gets exactly the fixed line and the job id, and nothing dispatches", async () => {
    const w = world()
    const prepared = await w.ports.prepareCloud!({ ...w.input, sponsor: w.account.toUpperCase() })
    expect(prepared?.ticketHash).toBe(w.prep.state.ticketHash)
    expect(w.prep.state.triggers).toEqual([
      {
        source: "slack",
        account: w.account,
        requestedBy: { platform: "slack", userId: "U0ALICE01" },
        target: { kind: "github-run", repositoryId: 123 },
        prompt: `Vector everywhere job ${w.jid}`,
        purpose: "task",
        jobId: w.jid,
      },
    ])
    const prompt = w.prep.state.triggers[0]!.prompt
    expect(prompt).toBe(ACTIONS_JOB_PROMPT + w.jid)
    expect(prompt.trim()).toBe(prompt)
    expect(/\s$|^\s|\n/.test(prompt)).toBe(false)
    expect(jobOfActionsPrompt(prompt)).toBe(w.jid)
    expect(w.prep.state.dispatches).toBe(0)
    // One binding read, one live visibility read, one live mode read.
    expect({ store: w.store.commands.length, app: w.app.calls.length, mode: w.mode.calls.length }).toEqual({
      store: 1,
      app: 1,
      mode: 1,
    })
  })

  test.each([
    ["not-binder", async () => ({ ok: false as const, reason: "not-binder" as const })],
    ["source-unavailable", async () => ({ ok: false as const, reason: "source-unavailable" as const })],
    [
      "a throw",
      async (): Promise<never> => {
        throw new Error("PERSISTENT_STORE_UNAVAILABLE")
      },
    ],
  ] as const)("P10: prepareCloudRun answering %s gives no route", async (_, answer) => {
    const prep = preparer(answer)
    const w = world({ prepare: prep.prepare })
    expect(await w.ports.prepareCloud!(w.input)).toBeUndefined()
    expect(prep.state.triggers).toHaveLength(1)
  })

  test("P11: commit dispatches once and rejects with the reason code; cancel reaches prepareCloudRun's cancel", async () => {
    const w = world()
    const prepared = (await w.ports.prepareCloud!(w.input))!
    await prepared.commit()
    expect(w.prep.state.dispatches).toBe(1)
    w.prep.state.dispatchAnswer = { ok: false, reason: "dispatch-failed" }
    await expect(prepared.commit()).rejects.toThrow("dispatch-failed")
    expect(w.prep.state.dispatches).toBe(2)
    await prepared.cancel!()
    expect(w.prep.state.cancels).toBe(1)
  })

  test("P12 (R-C8/R-A8 tripwire): Slack, Linear and Jira stay reserved, and the real prepareCloudRun refuses them", async () => {
    expect(["slack", "linear", "jira"].filter((source) => ENABLED_SOURCES.has(source as RunSource))).toEqual([])
    const account = randomUUID()
    const store = bindingStore(() => bindingFields({ repositoryId: "123", account }))
    const ports = createCloudPorts({
      store: store.store,
      app: privateApp(),
      liveMode: async () => "codium",
      sources: sources("linear"),
    })
    const jid = createJobId(Date.now())
    const input = {
      jid,
      source: "linear" as const,
      sponsor: account,
      requestedBy: { platform: "linear", userId: "linear-user" },
      repositoryId: 123,
      bodyReference: jid,
    }
    expect(await ports.prepareCloud!(input)).toBeUndefined()
    // Only the adapter's binding read reached the store: prepareCloudRun said source-unavailable before its ticket.
    expect(store.commands).toHaveLength(1)
    expect(store.commands.some((command) => command.some((part) => String(part).includes("ticket")))).toBe(false)
  })
})

describe("the binding and visibility ports", () => {
  test.each([
    ["codium", {}, { appInstalled: true, codiumMode: true }],
    ["own-key", { with: { workflowMode: "own-key" } }, { appInstalled: true, codiumMode: false }],
    ["no stored mode", { drop: ["workflowMode"] }, { appInstalled: true, codiumMode: false }],
    ["no installation", { drop: ["installationId"] }, { appInstalled: false, codiumMode: true }],
  ] as const)("B1: a binding with %s maps to the router's facts", async (_, edit, expected) => {
    const account = randomUUID()
    const ports = createCloudPorts({
      store: bindingStore(() => bindingFields({ repositoryId: "123", account, ...edit })).store,
    })
    expect(await ports.binding(123)).toEqual({ account, ...expected })
  })

  test.each([
    ["suspended", () => bindingFields({ repositoryId: "123", account: ACCOUNT, with: { suspended: "binder-left" } })],
    ["missing", (): undefined => undefined],
    ["unreadable", (): "down" => "down"],
  ] as const)("B1: a %s binding answers none", async (_, fields) => {
    const ports = createCloudPorts({ store: bindingStore(fields).store })
    expect(await ports.binding(123)).toBeUndefined()
    expect(await ports.visibility!(123)).toBeUndefined()
  })

  test.each([
    ["public", { publicRepository: true }, "public"],
    ["private by GitHub's visibility field", { publicRepository: false, visibility: "private" }, "private"],
    ["internal by GitHub's visibility field", { publicRepository: false, visibility: "internal" }, "internal"],
    ["private:true with no visibility field", { publicRepository: false }, "internal"],
  ] as const)("B2: a live read of %s answers %s", async (_, answer, expected) => {
    const ports = createCloudPorts({
      store: bindingStore(() => bindingFields({ repositoryId: "123", account: ACCOUNT })).store,
      app: stubApp(async () => answer),
    })
    expect(await ports.visibility!(123)).toBe(expected)
  })

  test("B2: a failed read answers none, and so does a binding with no installation, which reads nothing", async () => {
    const failing = stubApp(async () => {
      throw new Error("GITHUB_UNAVAILABLE")
    })
    const ports = createCloudPorts({
      store: bindingStore(() => bindingFields({ repositoryId: "123", account: ACCOUNT })).store,
      app: failing,
    })
    expect(await ports.visibility!(123)).toBeUndefined()
    const none = stubApp(async () => ({ publicRepository: false, visibility: "private" }))
    const uninstalled = createCloudPorts({
      store: bindingStore(() => bindingFields({ repositoryId: "123", account: ACCOUNT, drop: ["installationId"] }))
        .store,
      app: none,
    })
    expect(await uninstalled.visibility!(123)).toBeUndefined()
    expect(none.calls).toEqual([])
  })

  test.each([
    ["private", "private"],
    ["internal", "internal"],
    [undefined, "internal"],
  ] as const)(
    "B3: through the real helper, GitHub's private:true with visibility %s reads %s",
    async (visibility, expected) => {
      await using fixture = await githubAppFixture()
      fixture.state.repository.private = true
      fixture.state.repository.visibility = visibility
      const account = randomUUID()
      const w = world({
        app: fixture.app,
        fields: () => bindingFields({ repositoryId: fixture.repositoryId, account }),
      })
      expect(await w.ports.visibility!(Number(fixture.repositoryId))).toBe(expected)
      const prepared = await w.ports.prepareCloud!({
        ...w.input,
        sponsor: account,
        repositoryId: Number(fixture.repositoryId),
      })
      if (expected === "private") expect(prepared).toBeDefined()
      else expect(prepared).toBeUndefined()
      expect(w.prep.state.triggers).toHaveLength(expected === "private" ? 1 : 0)
      expect(fixture.tokens.size).toBe(0)
      expect(guard.violations).toEqual([])
    },
  )
})

/** The router fixture's Slack job on acme/app (101) with the adapter's ports in place of the fixture's. */
function routed(
  change: Partial<CloudPortsDeps> & { readonly fields?: (account: string) => Record<string, string> | undefined } = {},
  options: Parameters<typeof routerFixture>[0] = {},
) {
  const f = routerFixture(options)
  const store = bindingStore(() =>
    change.fields ? change.fields(f.account) : bindingFields({ repositoryId: "101", account: f.account }),
  )
  const app = privateApp()
  const prep = preparer()
  const mode = liveModes(async () => "codium")
  f.ports.presence = async () => ({ online: false, computers: 0 })
  Object.assign(
    f.ports,
    createCloudPorts({
      store: store.store,
      app,
      prepare: prep.prepare,
      liveMode: mode.liveMode,
      sources: sources("slack"),
      ...change,
    }),
  )
  return { f, store, app, prep, mode }
}

function ticketKeys(f: ReturnType<typeof routerFixture>) {
  return [...f.fake.data.keys()].filter((key) => key.startsWith(TICKET_PREFIX))
}

describe("routing through the adapter", () => {
  test("R0: a platform that is not an enabled source reads no binding or visibility, and names no Actions route", async () => {
    const r = routed({ sources: sources("linear") })
    expect(r.f.ports.prepareCloud).toBeDefined()
    const job = await r.f.create()
    const facts = await r.f.facts()
    expect(facts.actions).toEqual({
      sourceEnabled: false,
      bodyByReference: true,
      modeRecorded: true,
      binding: undefined,
      visibility: undefined,
    })
    expect(await routeJob(r.f.routing, job, facts)).toEqual({
      action: "refuse",
      code: "no-place",
      why: { computer: "not-seen", actions: "none" },
    })
    expect({ store: r.store.commands.length, app: r.app.calls.length, prepare: r.prep.state.triggers.length }).toEqual({
      store: 0,
      app: 0,
      prepare: 0,
    })
  })

  test("R1 (E8): a dispatch stores the ticket link, moves the job before it dispatches, and a late claim loses", async () => {
    const r = routed()
    const job = await r.f.create()
    r.prep.state.onDispatch = async () => {
      expect((await readJob(r.f.store, job.jid))?.state).toBe("dispatched")
      expect((await claimJob(r.f.context(), { account: r.f.account, jid: job.jid, device: r.f.computer })).ok).toBe(
        false,
      )
    }
    expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({ action: "actions" })
    expect(await getValue(r.f.store, everywhereKeys.ticket(r.prep.state.ticketHash))).toBe(job.jid)
    expect(await readJob(r.f.store, job.jid)).toMatchObject({
      state: "dispatched",
      route: "actions",
      ticketHash: r.prep.state.ticketHash,
    })
    expect(r.prep.state.dispatches).toBe(1)
    expect(r.prep.state.triggers.map((trigger) => [trigger.prompt, trigger.jobId])).toEqual([
      [`${ACTIONS_JOB_PROMPT}${job.jid}`, job.jid],
    ])
    expect(r.f.calls).toContainEqual({ kind: "progress", value: "actions" })
    // Facts, prepare and the recheck before the fenced transition: three live reads.
    expect(r.app.calls).toHaveLength(3)
  })

  test("R2 (E11): stored private, live public, and the computer never seen: refused no-place, no ticket, no prepare", async () => {
    const r = routed({ app: stubApp(async () => ({ publicRepository: true })) })
    const job = await r.f.create()
    expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({
      action: "refuse",
      code: "no-place",
      why: { computer: "not-seen", actions: "public" },
    })
    expect((await readJob(r.f.store, job.jid))?.state).toBe("refused")
    expect(r.prep.state.triggers).toEqual([])
    expect(ticketKeys(r.f)).toEqual([])
  })

  test("R2: the same job waits for a computer seen recently, with no ticket and no prepare", async () => {
    const r = routed({ app: stubApp(async () => ({ publicRepository: true })) })
    await recordSeen(r.f.context(), r.f.account, r.f.computer)
    const job = await r.f.create()
    expect((await routeJob(r.f.routing, job, await r.f.facts())).action).toBe("queue")
    expect((await readJob(r.f.store, job.jid))?.state).toBe("waiting")
    expect(r.prep.state.triggers).toEqual([])
    expect(ticketKeys(r.f)).toEqual([])
  })

  test.each([
    [
      "fails",
      stubApp(async () => {
        throw new Error("GITHUB_UNAVAILABLE")
      }),
    ],
    ["says internal", stubApp(async () => ({ publicRepository: false, visibility: "internal" }))],
    ["says private:true with no visibility field", stubApp(async () => ({ publicRepository: false }))],
  ] as const)("R3: a visibility read that %s is refused as public", async (_, app) => {
    const r = routed({ app })
    const job = await r.f.create()
    expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({
      action: "refuse",
      code: "no-place",
      why: { computer: "not-seen", actions: "public" },
    })
    expect(r.prep.state.triggers).toEqual([])
    expect(ticketKeys(r.f)).toEqual([])
  })

  test("R4: a binding with no stored mode asks for an Actions binding", async () => {
    const r = routed({ fields: (account) => bindingFields({ repositoryId: "101", account, drop: ["workflowMode"] }) })
    const job = await r.f.create()
    expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({
      action: "refuse",
      code: "no-place",
      why: { computer: "not-seen", actions: "bind" },
    })
    expect(r.app.calls).toHaveLength(1)
    expect(r.prep.state.triggers).toEqual([])
  })

  test("R5: the switch at stop after prepare cancels the ticket, writes no link and dispatches nothing", async () => {
    const r = routed()
    r.f.ports.switch = async () => (r.prep.state.triggers.length ? "stop" : "on")
    const job = await r.f.create()
    expect((await routeJob(r.f.routing, job, await r.f.facts())).action).not.toBe("actions")
    expect({ cancels: r.prep.state.cancels, dispatches: r.prep.state.dispatches }).toEqual({
      cancels: 1,
      dispatches: 0,
    })
    expect((await readJob(r.f.store, job.jid))?.state).not.toBe("dispatched")
    expect(ticketKeys(r.f)).toEqual([])
  })

  test("R7: a laptop claim that lands during the recheck wins; the ticket is cancelled and its link is inert", async () => {
    const r = routed()
    const job = await r.f.create()
    const binding = r.f.ports.binding
    r.f.ports.binding = async (repositoryId) => {
      // The recheck's binding read follows prepare, so this claim lands between the recheck and dispatchJob.
      if (r.prep.state.triggers.length) {
        expect((await offerJob(r.f.context(), job.jid)).ok).toBe(true)
        const claim = { account: r.f.account, jid: job.jid, device: r.f.computer }
        expect((await claimJob(r.f.context(), claim)).ok).toBe(true)
      }
      return binding(repositoryId)
    }
    expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({ action: "laptop" })
    expect({ cancels: r.prep.state.cancels, dispatches: r.prep.state.dispatches }).toEqual({
      cancels: 1,
      dispatches: 0,
    })
    expect(await readJob(r.f.store, job.jid)).toMatchObject({ state: "claimed", route: "laptop" })
    expect((await readJob(r.f.store, job.jid))?.ticketHash).toBeUndefined()
    // dispatchJob wrote the link before its fenced transition lost. It names the cancelled ticket until the body ends,
    // and the start hook refuses it, because the job is not `dispatched` with that hash.
    expect(ticketKeys(r.f)).toEqual([everywhereKeys.ticket(r.prep.state.ticketHash)])
    expect(await startDispatched(r.f.context(), r.prep.state.ticketHash, "run-1")).toMatchObject({ ok: false })
    expect((await readJob(r.f.store, job.jid))?.state).toBe("claimed")
  })

  test("R8: a binding port that rejects answers no Actions route, in the facts and in the recheck", async () => {
    const failed = routed()
    failed.f.ports.binding = async () => {
      throw new Error("module failed to load")
    }
    const job = await failed.f.create()
    const facts = await failed.f.facts()
    expect(facts.actions?.binding).toBeUndefined()
    expect(await routeJob(failed.f.routing, job, facts)).toEqual({
      action: "refuse",
      code: "no-place",
      why: { computer: "not-seen", actions: "bind" },
    })
    expect(failed.prep.state.triggers).toEqual([])
    const late = routed()
    const binding = late.f.ports.binding
    late.f.ports.binding = async (repositoryId) => {
      if (late.prep.state.triggers.length) throw new Error("module failed to load")
      return binding(repositoryId)
    }
    const second = await late.f.create()
    expect((await routeJob(late.f.routing, second, await late.f.facts())).action).not.toBe("actions")
    expect({ cancels: late.prep.state.cancels, dispatches: late.prep.state.dispatches }).toEqual({
      cancels: 1,
      dispatches: 0,
    })
    expect((await readJob(late.f.store, second.jid))?.state).not.toBe("dispatched")
    expect(ticketKeys(late.f)).toEqual([])
  })

  test("R9: the router gates by source itself, so a source it no longer enables reaches no prepareCloud", async () => {
    const r = routed()
    const job = await r.f.create()
    const facts = await r.f.facts()
    expect(facts.actions?.sourceEnabled).toBe(true)
    // The adapter's prepareCloud would still prepare this Slack job; only the router's own check stops it.
    r.f.ports.cloudSource = () => false
    expect((await routeJob(r.f.routing, job, facts)).action).not.toBe("actions")
    expect(r.prep.state.triggers).toEqual([])
    expect((await readJob(r.f.store, job.jid))?.state).not.toBe("dispatched")
    expect(ticketKeys(r.f)).toEqual([])
  })

  describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
    let redis: RealRedis
    let restoreKv = () => {}
    beforeAll(async () => {
      // The everywhere store sends through persistentStore, which needs a KV address; the bridge ignores it.
      restoreKv = useKv()
      redis = (await realRedis())!
    })
    afterAll(async () => {
      await redis?.close()
      restoreKv()
    })

    test("R6: R1's dispatch on Valkey writes the ticket link and the fenced transition", async () => {
      const r = routed({}, { store: testEverywhereStore(redis.fetch) })
      const job = await r.f.create()
      expect(await routeJob(r.f.routing, job, await r.f.facts())).toEqual({ action: "actions" })
      expect(await getValue(r.f.store, everywhereKeys.ticket(r.prep.state.ticketHash))).toBe(job.jid)
      expect(await readJob(r.f.store, job.jid)).toMatchObject({
        state: "dispatched",
        ticketHash: r.prep.state.ticketHash,
      })
      expect((await claimJob(r.f.context(), { account: r.f.account, jid: job.jid, device: r.f.computer })).ok).toBe(
        false,
      )
      expect(r.prep.state.dispatches).toBe(1)
      expect(r.f.fake.commands).toEqual([])
    })
  })
})

describe("the handoff binding port", () => {
  test.each(["private", "internal", "public"])(
    "H1: a binding stored %s maps with laptopFirst false and shared, the route's fallback for a token without visibility",
    async (visibility) => {
      const account = randomUUID()
      const binding = createHandoffBinding({
        store: bindingStore(() => bindingFields({ repositoryId: "123", account, with: { visibility } })).store,
      })
      expect(await binding(123)).toEqual({
        account,
        githubId: 790,
        ownerId: 456,
        installationId: 600,
        laptopFirst: false,
        codiumMode: true,
        workflowVersion: "3",
        defaultRef: "refs/heads/main",
        repository: { id: 123, fullName: "fixture-owner/project", shared: true },
      })
    },
  )

  test("H1: an own-key binding maps codiumMode false", async () => {
    const binding = createHandoffBinding({
      store: bindingStore(() =>
        bindingFields({ repositoryId: "123", account: ACCOUNT, with: { workflowMode: "own-key" } }),
      ).store,
    })
    expect((await binding(123))?.codiumMode).toBe(false)
  })

  test.each([
    ["no installation", () => bindingFields({ repositoryId: "123", account: ACCOUNT, drop: ["installationId"] })],
    [
      "a suspended binding",
      () => bindingFields({ repositoryId: "123", account: ACCOUNT, with: { suspended: "deleted" } }),
    ],
    ["a missing binding", (): undefined => undefined],
    ["a store that is down", (): "down" => "down"],
  ] as const)("H2: %s answers none", async (_, fields) => {
    expect(await createHandoffBinding({ store: bindingStore(fields).store })(123)).toBeUndefined()
  })
})

/**
 * productionPorts reads persistentStore's env, so the env is the only seam. Each case points it at a loopback KV that
 * answers bindingFor's READ, with the App off, as it is wherever its env is unset, and restores it in a finally, so a
 * failing case cannot leave it for a later one.
 */
async function withLoopbackKv(run: (kv: { readonly requests: Command[]; readonly account: string }) => Promise<void>) {
  const names = [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VECTOR_GITHUB_APP_ENABLED",
  ]
  const saved = Object.entries(process.env).filter((entry) => names.includes(entry[0]))
  const kv = { requests: [] as Command[], account: randomUUID() }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      kv.requests.push((await request.json()) as Command)
      return Response.json({
        result: [Object.entries(bindingFields({ repositoryId: "123", account: kv.account })).flat()],
      })
    },
  })
  try {
    for (const name of names) delete process.env[name]
    process.env.KV_REST_API_URL = server.url.origin
    process.env.KV_REST_API_TOKEN = "everywhere-cloud-adapter-test"
    await run(kv)
  } finally {
    server.stop(true)
    for (const name of names) delete process.env[name]
    Object.assign(process.env, Object.fromEntries(saved))
  }
}

describe("productionPorts", () => {
  test("S1: with the flag off production has safePorts' binding and no visibility, cloudSource or prepareCloud", () =>
    withLoopbackKv(async (kv) => {
      const ports = productionPorts(readConfig({}))
      expect({ prepare: ports.prepareCloud, visibility: ports.visibility, source: ports.cloudSource }).toEqual({
        prepare: undefined,
        visibility: undefined,
        source: undefined,
      })
      expect(await ports.binding(123)).toBeUndefined()
      expect(kv.requests).toEqual([])
      expect(guard.violations).toEqual([])
    }))

  test("S2: with the flag on the binding is @vector's, and there is still no prepareCloud and no GitHub read", () =>
    withLoopbackKv(async (kv) => {
      const ports = productionPorts(readConfig(everywhereEnv()))
      expect(ports.prepareCloud).toBeUndefined()
      expect((["slack", "linear", "jira"] as const).map((platform) => ports.cloudSource!(platform))).toEqual([
        false,
        false,
        false,
      ])
      expect(await ports.binding(123)).toEqual({ account: kv.account, appInstalled: true, codiumMode: true })
      expect(await ports.visibility!(123)).toBeUndefined()
      expect(kv.requests).toEqual([
        ["EVAL", expect.any(String), "1", `${BINDING_KEY}123`],
        ["EVAL", expect.any(String), "1", `${BINDING_KEY}123`],
      ])
      expect(guard.violations).toEqual([])
    }))
})

/*
 * VE-30b (EV-30): the listeners on @vector's run hooks, registered through the real registry (cloud-agents-runs.ts
 * notifyRunStart and notifyRunSettle, with their 5 s budget) over the router fixture's store, and the cron's run read
 * through @vector's real listCloudRuns over a stub of @vector's store.
 */

/** The router fixture's Slack job, dispatched with its own ticket, and EV-30's listeners registered over its store. */
async function hooked(options: { readonly store?: (store: Store) => Store } = {}) {
  const f = routerFixture()
  const job = await f.create()
  const ticket = randomBytes(32).toString("hex")
  expect((await dispatchJob(f.context(), job.jid, { ticketHash: ticket })).ok).toBe(true)
  const events = createJobEvents(f.context, { slack: f.adapter })
  const state = { loads: 0, posts: 0, switch: "on" as SwitchState }
  const store = options.store ? options.store(f.store) : f.store
  const remove = registerEverywhereRunHooks({
    config: f.config,
    hooks: {
      store,
      load: async (): Promise<RunJobDeps> => {
        state.loads++
        return {
          context: () => ({ ...f.context(), store }),
          settled: async (settled) => {
            state.posts++
            await events.settled!(settled)
          },
          switch: async () => state.switch,
        }
      },
    },
  })
  if (!remove) throw new Error("the listeners were not registered")
  const rid = runId()
  const vector = vectorStore(() => [vectorRun({ account: f.account, rid })])
  const finishes = () => f.calls.filter((call) => call.kind === "finish")
  return { f, job, ticket, rid, state, remove, vector, finishes }
}

/** Runs `check` with the hooks of `hooked()`, and always removes them. */
async function withHooks(
  check: (h: Awaited<ReturnType<typeof hooked>>) => Promise<void>,
  options: Parameters<typeof hooked>[0] = {},
) {
  const h = await hooked(options)
  try {
    await check(h)
  } finally {
    h.remove()
  }
}

describe("the run hooks (VE-30b)", () => {
  test("L1: a start with the ticket's job id moves the dispatched job to running and links the run; a repeat moves nothing", () =>
    withHooks(async (h) => {
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      const running = await readJob(h.f.store, h.job.jid)
      expect(running).toMatchObject({ state: "running", route: "actions", rid: h.rid })
      expect(await getValue(h.f.store, everywhereKeys.run(h.rid))).toBe(h.job.jid)
      expect(await getValue(h.f.store, everywhereKeys.runSettle(h.rid))).toBe(h.job.jid)
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      expect((await readJob(h.f.store, h.job.jid))?.version).toBe(running?.version)
      expect(h.state.loads).toBe(2)
    }))

  test("L2: a start without a job id, or with a malformed one, reads nothing; one naming another job only reads the ticket", () =>
    withHooks(async (h) => {
      const mark = h.f.fake.commands.length
      await notifyRunStart(h.ticket, h.rid)
      await notifyRunStart(h.ticket, h.rid, "vej_short")
      expect(h.f.fake.commands.length).toBe(mark)
      expect(h.state.loads).toBe(0)
      await notifyRunStart(h.ticket, h.rid, createJobId(Date.now()))
      expect(h.f.fake.commands.slice(mark).map((command) => command[0])).toEqual(["GET"])
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("dispatched")
    }))

  test("L3: the settle posts the Actions result once, without the reported pull request; a repeat posts nothing", () =>
    withHooks(async (h) => {
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      // A pull request of the run's own repository passes @vector's check and still is not posted (EV-30 (f)).
      await notifyRunSettle(h.rid, { outcome: "changes", prUrl: "https://github.com/acme/app/pull/7" }, h.vector.store)
      const settled = await readJob(h.f.store, h.job.jid)
      expect(settled).toMatchObject({ state: "settled", route: "actions", outcome: "changes" })
      expect(settled?.result).toBeUndefined()
      expect(h.finishes()).toEqual([{ kind: "finish", value: { text: "Done in GitHub Actions." } }])
      expect(h.f.fake.sorted(everywhereKeys.jobsPosts())).toEqual([])
      await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
      expect(await postPending(h.f.context, { slack: h.f.adapter })).toBe(0)
      expect(h.finishes()).toHaveLength(1)
      expect(h.state.posts).toBe(1)
      expect((await readJob(h.f.store, h.job.jid))?.version).toBe(settled?.version)
    }))

  test("L10: a repeated settle whose index outlived the job's end (a failed unlink) is fenced and posts nothing", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      await withHooks(
        async (h) => {
          await notifyRunStart(h.ticket, h.rid, h.job.jid)
          await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
          expect(await getValue(h.f.store, everywhereKeys.runSettle(h.rid))).toBe(h.job.jid)
          const settled = await readJob(h.f.store, h.job.jid)
          await notifyRunSettle(h.rid, { outcome: "failed" }, h.vector.store)
          expect(await readJob(h.f.store, h.job.jid)).toMatchObject({ version: settled?.version, outcome: "changes" })
          expect({ posts: h.state.posts, finishes: h.finishes().length }).toEqual({ posts: 1, finishes: 1 })
        },
        {
          store: (store) =>
            withTestAccountAuthority(async (command) => {
              if (command[0] === "DEL" && command.some((part) => String(part).endsWith(":settle")))
                throw new Error("unlink lost")
              return store(command)
            }),
        },
      )
    } finally {
      errors.mockRestore()
    }
  })

  test("L4: a draft run reads failed, and @vector's outcomes all map into the everywhere outcomes", () =>
    withHooks(async (h) => {
      expect(Object.keys(ACTIONS_OUTCOME).sort()).toEqual([...GithubAgents.OUTCOME].sort())
      expect(Object.values(ACTIONS_OUTCOME).every((outcome) => ACTIONS_OUTCOMES.includes(outcome))).toBe(true)
      expect(ACTIONS_OUTCOME).toEqual({
        changes: "changes",
        "no-changes": "no-changes",
        draft: "failed",
        failed: "failed",
        refused: "refused",
        cancelled: "cancelled",
      })
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      await notifyRunSettle(h.rid, { outcome: "draft" }, h.vector.store)
      expect(await readJob(h.f.store, h.job.jid)).toMatchObject({ state: "settled", outcome: "failed" })
      expect(h.finishes()).toEqual([{ kind: "finish", value: { text: "The run in GitHub Actions failed." } }])
    }))

  test("L5: a settle whose budget ends after the transition is not posted by the hook; the outbox posts it once", async () => {
    const f = routerFixture()
    const job = await f.create()
    const ticket = randomBytes(32).toString("hex")
    const rid = runId()
    expect((await dispatchJob(f.context(), job.jid, { ticketHash: ticket })).ok).toBe(true)
    expect((await startDispatched(f.context(), ticket, rid, job.jid)).ok).toBe(true)
    const budget = new AbortController()
    // The budget ends right after the fenced transition, as when a settle's 5 s run out part-way.
    const store = withTestAccountAuthority(async (command) => {
      const answer = await f.store(command)
      if (command[0] === "EVAL" && command.includes(everywhereKeys.jobsPosts())) budget.abort()
      return answer
    })
    let posts = 0
    const hooks = createRunHooks({
      store: f.store,
      load: async () => ({
        context: () => ({ ...f.context(), store }),
        settled: async () => {
          posts++
        },
        switch: async () => "on",
      }),
    })
    await hooks.settle(rid, { outcome: "no-changes" }, budget.signal)
    expect(budget.signal.aborted).toBe(true)
    expect(await readJob(f.store, job.jid)).toMatchObject({ state: "settled", outcome: "no-changes" })
    expect(posts).toBe(0)
    expect(f.fake.sorted(everywhereKeys.jobsPosts())).toEqual([job.jid])
    expect(await postPending(f.context, { slack: f.adapter })).toBe(1)
    expect(await postPending(f.context, { slack: f.adapter })).toBe(0)
    expect(f.calls.filter((call) => call.kind === "finish")).toEqual([
      { kind: "finish", value: { text: "Finished in GitHub Actions with no changes." } },
    ])
    // A budget already spent stops the hooks before any read.
    const mark = f.fake.commands.length
    await hooks.settle(rid, { outcome: "changes" }, budget.signal)
    await hooks.start(ticket, rid, job.jid, budget.signal)
    expect(f.fake.commands.length).toBe(mark)
  })

  test("L6: under stop neither hook moves a job; no-new lets both through", () =>
    withHooks(async (h) => {
      h.state.switch = "stop"
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("dispatched")
      h.state.switch = "no-new"
      await notifyRunStart(h.ticket, h.rid, h.job.jid)
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("running")
      h.state.switch = "stop"
      await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("running")
      h.state.switch = "no-new"
      await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("settled")
      expect(h.finishes()).toHaveLength(1)
    }))

  test("L7: a settle with no settle index (its start was lost) reads one key and moves nothing; 900 s later the job ends not-started", () =>
    withHooks(async (h) => {
      const mark = h.f.fake.commands.length
      await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
      expect(h.f.fake.commands.slice(mark)).toEqual([["GET", everywhereKeys.runSettle(h.rid)]])
      expect(h.state.loads).toBe(0)
      expect((await readJob(h.f.store, h.job.jid))?.state).toBe("dispatched")
      // Recorded in EV-30 (k): the run did start, but the post says it did not; EV-27's body-route fallback is the fix.
      h.f.fake.clock.advance(TIMING.dispatchStartMs)
      expect((await sweepDue(h.f.context())).map((entry) => [entry.job.state, entry.ending])).toEqual([
        ["failed", "not-started"],
      ])
      expect(await postPending(h.f.context, { slack: h.f.adapter })).toBe(1)
      expect(h.finishes()).toEqual([
        { kind: "finish", value: { text: "GitHub Actions did not start; check the workflow uses Codium." } },
      ])
    }))

  test("L8: listener failures are logged with the hooks' fixed line and never touch @vector's run record", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await withHooks(
        async (h) => {
          await notifyRunStart(h.ticket, h.rid, h.job.jid)
          await notifyRunSettle(h.rid, { outcome: "changes" }, h.vector.store)
          expect(warn.mock.calls.map((call) => call[0])).toEqual([
            "Vector cloud-agents start listener failed",
            "Vector cloud-agents settle listener failed",
          ])
          // @vector's store saw only the settle's one record read, and no listener got it.
          expect(h.vector.commands).toEqual([["EVAL", expect.any(String), "1", `${VECTOR_RUN_KEY}${h.rid}`]])
          expect((await readJob(h.f.store, h.job.jid))?.state).toBe("dispatched")
        },
        {
          store: () => async () => {
            throw new Error("everywhere store down")
          },
        },
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("L9: with the flag off nothing registers, the registration module included; with it on, one remover removes both", async () => {
    const vector = vectorStore(() => [])
    expect(readConfig().enabled).toBe(false)
    expect(registerEverywhereRunHooks({ config: readConfig({}) })).toBeUndefined()
    // With no settle listener registered, @vector's notify does not even read the run record (EV-25).
    await notifyRunSettle(runId(), { outcome: "changes" }, vector.store)
    await notifyRunStart("a".repeat(64), runId(), createJobId(Date.now()))
    expect(vector.commands).toEqual([])
    const loads: string[] = []
    const remove = registerEverywhereRunHooks({
      config: readConfig(everywhereEnv()),
      hooks: {
        store: async () => {
          loads.push("store")
          return null
        },
        load: async () => {
          loads.push("load")
          throw new Error("not reached")
        },
      },
    })
    expect(remove).toBeDefined()
    await notifyRunSettle(runId(), { outcome: "changes" }, vector.store)
    expect(loads).toEqual(["store"])
    remove!()
    await notifyRunSettle(runId(), { outcome: "changes" }, vector.store)
    await notifyRunStart("a".repeat(64), runId(), createJobId(Date.now()))
    expect(loads).toEqual(["store"])
    expect(vector.commands).toHaveLength(1)
    // Vercel bundles each function's own graph: @vector's two routes that tell listeners load the registration.
    for (const route of ["mint", "settle"])
      expect(await Bun.file(new URL(`../../../api/cloud-agents/${route}.ts`, import.meta.url)).text()).toContain(
        'import "../_lib/everywhere/run-hooks-registration.js"',
      )
  })
})

describe("the cron's run read (VE-30b)", () => {
  const harness = new RouteHarness()
  beforeAll(() => harness.start())
  afterAll(() => harness.stop())

  test("C1: an ended run answers its outcome; an open, unknown or other account's run none; a failed or damaged read rejects", async () => {
    const account = randomUUID()
    const [ended, open, draft, other] = [runId(), runId(), runId(), runId()]
    const runs = [
      vectorRun({ account, rid: ended, outcome: "no-changes" }),
      vectorRun({ account, rid: open }),
      vectorRun({ account, rid: draft, outcome: "draft" }),
      vectorRun({ account: randomUUID(), rid: other, outcome: "changes" }),
    ]
    const vector = vectorStore(() => runs)
    const read = createActionsRunEnd({ store: vector.store, enabled: () => true })
    expect(await Promise.all([ended, open, draft, other, runId()].map((rid) => read(account, rid)))).toEqual([
      "no-changes",
      undefined,
      "failed",
      undefined,
      undefined,
    ])
    // Each read is the newest 200 of the sponsor's runs, read only.
    expect(vector.commands.filter((command) => command[0] === "ZREVRANGE")).toEqual(
      Array.from({ length: 5 }, () => ["ZREVRANGE", `vector:cloud-agents:runs:${account}`, 0, 199]),
    )
    expect(vector.commands.every((command) => command[0] === "ZREVRANGE" || command[0] === "EVAL")).toBe(true)
    await expect(
      createActionsRunEnd({ store: vectorStore(() => "down").store, enabled: () => true })(account, ended),
    ).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
    // One damaged neighbour among the 200 makes the whole read fail (EV-30, Left open).
    const damaged = vectorStore(() => [...runs, vectorRun({ account, rid: runId(), with: { event: "push" } })])
    await expect(
      createActionsRunEnd({ store: damaged.store, enabled: () => true })(account, ended),
    ).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
  })

  test("C2: while the cloud-agents service is off nothing is read, by the default gate too", async () => {
    const account = randomUUID()
    const rid = runId()
    const vector = vectorStore(() => [vectorRun({ account, rid, outcome: "changes" })])
    expect(await createActionsRunEnd({ store: vector.store, enabled: () => false })(account, rid)).toBeUndefined()
    const names = ["MODEL_PLANS_ENABLED", "VECTOR_GITHUB_BRAIN_ENABLED"]
    const saved = Object.entries(process.env).filter((entry) => names.includes(entry[0]))
    try {
      for (const name of names) delete process.env[name]
      expect(cloudAgentsEnabled()).toBe(false)
      expect(await createActionsRunEnd({ store: vector.store })(account, rid)).toBeUndefined()
      expect(vector.commands).toEqual([])
      for (const name of names) process.env[name] = "true"
      expect(cloudAgentsEnabled()).toBe(true)
      expect(await createActionsRunEnd({ store: vector.store })(account, rid)).toBe("changes")
      expect(vector.commands.map((command) => command[0])).toEqual(["ZREVRANGE", "EVAL"])
    } finally {
      // C5 relies on this restore: it asserts that the service is off in this process.
      for (const name of names) delete process.env[name]
      Object.assign(process.env, Object.fromEntries(saved))
    }
  })

  /** A started Actions job of the router fixture, its run in @vector's stub store, and the cron over both. */
  async function overdue(outcome: GithubAgents.Outcome | undefined, runEnd?: "default") {
    const f = routerFixture()
    const job = await f.create()
    const ticket = randomBytes(32).toString("hex")
    const rid = runId()
    expect((await dispatchJob(f.context(), job.jid, { ticketHash: ticket })).ok).toBe(true)
    expect((await startDispatched(f.context(), ticket, rid, job.jid)).ok).toBe(true)
    const vector = vectorStore(() => [vectorRun({ account: f.account, rid, ...(outcome ? { outcome } : {}) })])
    const cronSecret = secret()
    harness.mount({
      "/sweep": createSweep({
        config: () => ({ ...f.config, cronSecret }),
        context: f.context,
        platforms: () => ({ slack: f.adapter }),
        stopped: async () => false,
        ...(runEnd === "default" ? {} : { runEnd: createActionsRunEnd({ store: vector.store, enabled: () => true }) }),
      }),
    })
    const sweep = async () => (await harness.call("GET", "/sweep", { token: cronSecret })).body
    const finishes = () => f.calls.filter((call) => call.kind === "finish")
    return { f, job, rid, vector, sweep, finishes }
  }

  test("C3: past its longest run the cron settles a run @vector recorded as ended, and posts it once", async () => {
    const o = await overdue("changes")
    o.f.fake.clock.advance(ACTIONS_OVERDUE_MS - 1)
    expect(await o.sweep()).toEqual({ ended: 0, posted: 0 })
    expect(o.vector.commands).toEqual([])
    o.f.fake.clock.advance(1)
    expect(await o.sweep()).toEqual({ ended: 1, posted: 1 })
    expect(await readJob(o.f.store, o.job.jid)).toMatchObject({ state: "settled", outcome: "changes" })
    expect(o.finishes()).toEqual([{ kind: "finish", value: { text: "Done in GitHub Actions." } }])
    expect(await o.sweep()).toEqual({ ended: 0, posted: 0 })
    expect(o.vector.commands.map((command) => command[0])).toEqual(["ZREVRANGE", "EVAL"])
  })

  test("C4: an open run is failed, and its post says it failed, not that it was cancelled", async () => {
    const o = await overdue(undefined)
    o.f.fake.clock.advance(ACTIONS_OVERDUE_MS)
    expect(await o.sweep()).toEqual({ ended: 1, posted: 1 })
    expect(await readJob(o.f.store, o.job.jid)).toMatchObject({ state: "failed", outcome: "failed" })
    expect(o.finishes()).toEqual([{ kind: "finish", value: { text: "The run in GitHub Actions failed." } }])
  })

  test("C5: the production cron's default reader reads nothing while the service is off, and fails the run at its due time", async () => {
    expect(cloudAgentsEnabled()).toBe(false)
    const o = await overdue("changes", "default")
    o.f.fake.clock.advance(ACTIONS_OVERDUE_MS)
    expect(await o.sweep()).toEqual({ ended: 1, posted: 1 })
    expect(await readJob(o.f.store, o.job.jid)).toMatchObject({ state: "failed", outcome: "failed" })
    expect(guard.violations).toEqual([])
  })

  test("C6: a damaged neighbouring record makes the cron wait, then fail the run at its due time plus the grace", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const o = await overdue("changes")
      const damaged = vectorStore(() => [
        vectorRun({ account: o.f.account, rid: o.rid, outcome: "changes" }),
        vectorRun({ account: o.f.account, rid: runId(), with: { event: "push" } }),
      ])
      o.f.fake.clock.advance(ACTIONS_OVERDUE_MS)
      const cronSecret = secret()
      harness.mount({
        "/sweep": createSweep({
          config: () => ({ ...o.f.config, cronSecret }),
          context: o.f.context,
          platforms: () => ({ slack: o.f.adapter }),
          stopped: async () => false,
          runEnd: createActionsRunEnd({ store: damaged.store, enabled: () => true }),
        }),
      })
      const sweep = async () => (await harness.call("GET", "/sweep", { token: cronSecret })).body
      expect(await sweep()).toEqual({ ended: 0, posted: 0 })
      o.f.fake.clock.advance(ACTIONS_CRON_GRACE_MS - 1)
      expect(await sweep()).toEqual({ ended: 0, posted: 0 })
      o.f.fake.clock.advance(1)
      expect(await sweep()).toEqual({ ended: 1, posted: 1 })
      expect(await readJob(o.f.store, o.job.jid)).toMatchObject({ state: "failed", outcome: "failed" })
      expect(
        errors.mock.calls.filter((call) => (call[1] as { step?: string } | undefined)?.step === "run-end"),
      ).toHaveLength(3)
    } finally {
      errors.mockRestore()
    }
  })
})
