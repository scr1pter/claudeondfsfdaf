import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import type { RepoBinding } from "../../../api/_lib/cloud-agents-binding"
import type { CloudRunTrigger, prepareCloudRun, StartCloudRunResult } from "../../../api/_lib/cloud-agents-start"
import {
  createCloudPorts,
  createHandoffBinding,
  type CloudPortsDeps,
} from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { readConfig } from "../../../api/_lib/everywhere/config"
import { claimJob, offerJob, readJob, recordSeen, startDispatched } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { routeJob } from "../../../api/_lib/everywhere/router"
import { productionPorts } from "../../../api/_lib/everywhere/runtime"
import { getValue } from "../../../api/_lib/everywhere/store"
import { ENABLED_SOURCES, type RunSource } from "../../../packages/schema/src/codium-run-trigger"
import { ACTIONS_JOB_PROMPT, createJobId, jobOfActionsPrompt } from "../../../packages/schema/src/everywhere"
import { githubAppFixture } from "./github-app-fixture"
import { everywhereEnv } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"
import { realRedis, testEverywhereStore, useKv, type RealRedis } from "./lib/everywhere-store"

/*
 * VE-30a (EV-29): the Actions route's ports over @vector, with @vector's real binding decoder behind a stub store, the
 * real attachmentRepository behind the GitHub App fixture, a recorded prepareCloudRun and the real router. Nothing
 * leaves loopback.
 */

const guard = installFetchGuard()

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const BINDING_KEY = "vector:cloud-agents:binding:"
const TICKET_PREFIX = everywhereKeys.ticket("a".repeat(64)).slice(0, -64)

type Command = readonly (string | number)[]
type FixtureState = Awaited<ReturnType<typeof githubAppFixture>>["state"]

/** A stored binding hash, as @vector's REDEEM writes it; `drop` removes fields, `with` adds or replaces them. */
function bindingFields(input: {
  readonly repositoryId: string
  readonly account: string
  readonly with?: Record<string, string>
  readonly drop?: readonly string[]
}) {
  const fields: Record<string, string> = {
    repositoryId: input.repositoryId,
    ownerId: "456",
    repository: "fixture-owner/project",
    account: input.account,
    visibility: "private",
    defaultRef: "refs/heads/main",
    generation: "1",
    binderGithubId: "790",
    binderLogin: "fixture-binder",
    workflowVersion: "3",
    boundAt: String(Date.now()),
    installationId: "600",
    workflowMode: "codium",
    ...input.with,
  }
  for (const name of input.drop ?? []) delete fields[name]
  return fields
}

/** Answers bindingFor's one READ with the hash, so @vector's real decoder runs; "down" throws like a lost store. */
function bindingStore(answer: () => Record<string, string> | undefined | "down") {
  const commands: Command[] = []
  const store = async (command: Command) => {
    commands.push(command)
    const value = answer()
    if (value === "down") throw new Error("store down")
    expect(command[0]).toBe("EVAL")
    expect(command[2]).toBe("1")
    expect(String(command[3]).startsWith(BINDING_KEY)).toBe(true)
    return [value ? Object.entries(value).flat() : []]
  }
  return { store, commands }
}

/** A stand-in for attachmentRepository; `visibility` is the field EV-30 asks github-app.ts to add. */
function stubApp(answer: () => Promise<{ publicRepository: boolean; visibility?: string }>) {
  const calls: RepoBinding[] = []
  return {
    calls,
    attachmentRepository: async (binding: RepoBinding) => {
      calls.push(binding)
      return answer()
    },
  }
}
const privateApp = () => stubApp(async () => ({ publicRepository: false, visibility: "private" }))

function preparer(answer?: () => Promise<Awaited<ReturnType<typeof prepareCloudRun>>>) {
  const state = {
    triggers: [] as CloudRunTrigger[],
    ticketHash: randomBytes(32).toString("hex"),
    dispatches: 0,
    cancels: 0,
    dispatchAnswer: { ok: true, dispatchedAt: 1 } as StartCloudRunResult,
    onDispatch: async () => {},
  }
  const prepare: typeof prepareCloudRun = async (trigger) => {
    state.triggers.push(trigger)
    if (answer) return answer()
    return {
      ok: true,
      ticketHash: state.ticketHash,
      dispatch: async () => {
        state.dispatches++
        await state.onDispatch()
        return state.dispatchAnswer
      },
      cancel: async () => {
        state.cancels++
        return true
      },
    }
  }
  return { state, prepare }
}

function liveModes(answer: () => Promise<"codium" | "own-key" | undefined>) {
  const calls: RepoBinding[] = []
  return {
    calls,
    liveMode: async (binding: RepoBinding) => {
      calls.push(binding)
      return answer()
    },
  }
}

const sources = (...names: RunSource[]) => new Set<RunSource>(names)

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

  test("P2: without EV-30's live mode read there is no prepareCloud", () => {
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
    ["private", false],
    ["internal", true],
  ] as const)(
    "B3: through the real helper, GitHub's private:true with visibility %s reads internal, so there is no route",
    async (visibility) => {
      await using fixture = await githubAppFixture()
      Object.assign(fixture.state.repository, { private: true, visibility })
      const account = randomUUID()
      const w = world({
        app: fixture.app,
        fields: () => bindingFields({ repositoryId: fixture.repositoryId, account }),
      })
      // attachmentRepository answers only `publicRepository` today, so private and internal look the same (EV-30).
      expect(await w.ports.visibility!(Number(fixture.repositoryId))).toBe("internal")
      expect(
        await w.ports.prepareCloud!({ ...w.input, sponsor: account, repositoryId: Number(fixture.repositoryId) }),
      ).toBeUndefined()
      expect(w.prep.state.triggers).toEqual([])
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
    "H1: a binding stored %s maps with laptopFirst false and is always shared until EV-31 reads it live",
    async (visibility) => {
      const account = randomUUID()
      const binding = createHandoffBinding({
        store: bindingStore(() => bindingFields({ repositoryId: "123", account, with: { visibility } })).store,
      })
      expect(await binding(123)).toEqual({
        account,
        githubId: 790,
        installationId: 600,
        laptopFirst: false,
        codiumMode: true,
        workflowVersion: "3",
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
