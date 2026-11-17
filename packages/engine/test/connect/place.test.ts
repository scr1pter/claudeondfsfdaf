import { afterEach, describe, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { Connect } from "@vectordevai/schema/connect"
import { Hands } from "@vectordevai/schema/hands"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { ComputerAvailability } from "@/computer/availability"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectGithubAgentAdapter } from "@/connect/adapters/github-agent"
import { ConnectHandsAdapter } from "@/connect/adapters/hands"
import { VectorScopeAdapter } from "@/connect/adapters/vectorscope"
import { ConnectHub } from "@/connect/hub"
import { ConnectMembers } from "@/connect/members"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { it, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

// CW-24a: in a Vector cloud workspace the supervisor sets VECTOR_CLOUD_WORKSPACE_WORKER=1 on the engine's container,
// and connect then lists what runs in this engine on Vector's servers, before Vector Local applies, for the list and
// for a hand-off alike. Without the marker nothing changes, byte for byte. The hub runs over a fake review member, the
// Hands adapter with a fake availability and the GitHub agent's adapter, and once over VectorScope's own adapter with a
// fake model resolution: no container, no network and no model call.

afterEach(disposeAllInstances)

const OFF_CLOUD = "Off in Vector Local: it runs on Vector's servers."

const REVIEW = [
  { id: "review", title: "Review", effects: ["read"], background: false, result: "review" },
] as const satisfies readonly Connect.Action[]

// A review member as VectorScope describes itself: in this engine, on a model on this computer.
const scopeMember: Connect.Member = {
  id: "vectorscope",
  kind: "agent",
  title: "VectorScope",
  summary: "Reviews your changes on your own review model.",
  owner: "vectorscope",
  place: "local",
  sendsTo: "this-computer",
  state: "ready",
  reach: "connect",
  actions: REVIEW,
}

// Every kind of source the hub composes, with every MCP status.
const SOURCES: Omit<ConnectMembers.Sources, "local"> = {
  adapters: [
    scopeMember,
    { ...scopeMember, id: "hosted-review", title: "Hosted review", sendsTo: "provider:vector-cloud" },
    {
      id: "computer",
      kind: "tool",
      title: Hands.NAME,
      summary: "The agent uses apps, with your approval.",
      owner: "hands",
      place: "local",
      state: "ready",
      reach: "computer",
    },
    {
      id: "github-agent",
      kind: "agent",
      title: "@vector on GitHub",
      summary: "Answers @vector on pull requests from your own GitHub Actions.",
      owner: "vector-at-mention",
      place: "your-cloud",
      state: "not-installed",
      reason: "Not set up in this repository.",
      reach: "none",
    },
  ],
  agents: [
    { name: "build", description: "The default agent.", mode: "primary", native: true },
    { name: "explore", description: "Explores the code.", mode: "subagent", native: true },
    { name: "secret", mode: "subagent", hidden: true },
  ],
  skills: [{ name: "release", description: "Cuts a release." }],
  workflows: [
    { name: "ship", title: "Ship", description: "Ships it." },
    { name: "broken", title: "Broken", issues: [{ message: "stage 2 has no agent" }] },
  ],
  mcp: {
    docs: { status: "connected" },
    tracker: { status: "connected" },
    off: { status: "disabled" },
    login: { status: "needs_auth" },
    cold: { status: "uninitialized" },
    broken: { status: "failed", error: "It refused the handshake." },
    register: { status: "needs_client_registration", error: "It needs a client registration." },
    legacy: { status: "unknown" },
  },
  remoteMcp: new Set(["tracker"]),
  tools: ["task", "browser", "vector_cloud", "computer", "read", "research"],
  desktop: { workspaces: 1, swarm: 2 },
}

const row = (list: readonly Connect.Member[], id: string) => list.find((member) => member.id === id)

const withoutPlace = (member: Connect.Member) => Object.entries(member).filter(([key]) => key !== "place")

// The desktop's own features, which a person reaches in the app. Their place in a cloud workspace is the owner's
// question (deviations, CN-15), so it is not pinned here. The primary agent runs in this engine and is pinned.
const DESKTOP = new Set(["codespace", "swarm", "help", "parallel-workspaces"])

describe("the runtime marker", () => {
  it.effect("cloudWorkspace is true only when VECTOR_CLOUD_WORKSPACE_WORKER is exactly 1", () =>
    Effect.gen(function* () {
      // The provider the engine's server reads its flags from (server.ts), over a given environment.
      const read = (env: Record<string, string>) =>
        RuntimeFlags.Service.useSync((flags) => flags.cloudWorkspace).pipe(
          Effect.provide(
            RuntimeFlags.Service.layer.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
              Layer.orDie,
            ),
          ),
        )
      expect(yield* read({ VECTOR_CLOUD_WORKSPACE_WORKER: "1" })).toBe(true)
      expect(yield* read({})).toBe(false)
      // The worker's entry requires exactly "1", so a boolean reading ("true", "yes", "on") never counts.
      for (const value of ["", "0", "true", "yes", "on", "01", " 1", "1 "])
        expect([value, yield* read({ VECTOR_CLOUD_WORKSPACE_WORKER: value })]).toEqual([value, false])
      // Neither does the umbrella experimental flag.
      expect(yield* read({ VECTOR_EXPERIMENTAL: "true" })).toBe(false)
      // A test layer without the override is not a cloud workspace.
      expect(
        yield* RuntimeFlags.Service.useSync((flags) => flags.cloudWorkspace).pipe(Effect.provide(RuntimeFlags.layer())),
      ).toBe(false)
    }),
  )
})

describe("the member list", () => {
  it.effect("unset, the list is byte-for-byte what it was", () =>
    Effect.sync(() => {
      for (const local of [false, true]) {
        const sources = { ...SOURCES, local }
        const before = JSON.stringify(ConnectMembers.compose(sources), null, 2)
        expect(before).toMatchSnapshot(`local ${local}`)
        expect(JSON.stringify(ConnectMembers.compose({ ...sources, cloudWorkspace: false }), null, 2)).toBe(before)
      }
    }),
  )

  it.effect("with the marker, every place that would be local reads vector-cloud and nothing else moves", () =>
    Effect.sync(() => {
      const before = ConnectMembers.compose({ ...SOURCES, local: false })
      const after = ConnectMembers.compose({ ...SOURCES, local: false, cloudWorkspace: true })
      expect(after.map((member) => member.id)).toEqual(before.map((member) => member.id))
      for (const [index, moved] of after.entries()) {
        const was = before[index]
        // Every other field, `sendsTo` and the summary included, is what it was.
        expect(withoutPlace(moved)).toEqual(withoutPlace(was))
        if (was.place !== "local") {
          expect([moved.id, moved.place]).toEqual([was.id, was.place])
          continue
        }
        if (DESKTOP.has(was.id)) continue
        expect([moved.id, moved.place]).toEqual([was.id, "vector-cloud"])
      }
      expect(after.filter((member) => member.place === "your-cloud").map((member) => member.id)).toEqual([
        "github-agent",
        "mcp:tracker",
      ])
      // The model's real destination stays, whatever the place.
      expect(row(after, "vectorscope")).toMatchObject({ place: "vector-cloud", sendsTo: "this-computer" })
      expect(row(after, "hosted-review")).toMatchObject({ place: "vector-cloud", sendsTo: "provider:vector-cloud" })
      expect(row(after, "mcp:docs")?.place).toBe("vector-cloud")
      // The agent the user talks to runs in this engine, so it is on Vector's servers too.
      expect(row(after, "agent:build")).toMatchObject({ place: "vector-cloud", reach: "ui" })

      const local = row(before, "vectorscope")!
      const mine = row(before, "github-agent")!
      const deploy = row(before, "vector-cloud")!
      expect(ConnectMembers.located(local, false)).toBe(local)
      expect(ConnectMembers.located(mine, true)).toBe(mine)
      expect(ConnectMembers.located(deploy, true)).toBe(deploy)
      const relocated = ConnectMembers.located(local, true)
      expect(relocated).toEqual({ ...local, place: "vector-cloud" })
      expect(local.place).toBe("local")
    }),
  )

  it.effect("Vector Local follows the cloud place, and MCP keeps MCP's own status", () =>
    Effect.sync(() => {
      const here = ConnectMembers.compose({ ...SOURCES, local: true })
      const cloud = ConnectMembers.compose({ ...SOURCES, local: true, cloudWorkspace: true })
      expect(row(here, "vectorscope")).toEqual(scopeMember)
      expect(row(cloud, "vectorscope")).toEqual({
        ...scopeMember,
        place: "vector-cloud",
        state: "off",
        reason: OFF_CLOUD,
      })
      // Each member's state and reason. "off" is the list's label under Vector Local: only a connect hand-off is
      // refused by it (the hub's admission), and the members reached any other way are not stopped by connect.
      expect(cloud.map((member) => [member.id, member.state, member.reason])).toEqual([
        ["vectorscope", "off", OFF_CLOUD],
        ["hosted-review", "off", OFF_CLOUD],
        ["computer", "off", OFF_CLOUD],
        ["github-agent", "not-installed", "Not set up in this repository."],
        ["agent:build", "off", OFF_CLOUD],
        ["agent:explore", "off", OFF_CLOUD],
        ["research", "off", OFF_CLOUD],
        ["codespace", "off", OFF_CLOUD],
        ["swarm", "off", OFF_CLOUD],
        ["brain", "off", OFF_CLOUD],
        ["help", "off", OFF_CLOUD],
        ["parallel-workspaces", "off", OFF_CLOUD],
        ["tasks", "off", OFF_CLOUD],
        ["browser", "off", OFF_CLOUD],
        ["vector-cloud", "off", OFF_CLOUD],
        ["tool:read", "off", OFF_CLOUD],
        ["skill:release", "off", OFF_CLOUD],
        ["workflow:ship", "off", OFF_CLOUD],
        ["workflow:broken", "unavailable", "This workflow has errors: stage 2 has no agent"],
        ["mcp:docs", "ready", undefined],
        ["mcp:tracker", "ready", undefined],
        ["mcp:off", "off", "Turned off in your MCP settings."],
        ["mcp:login", "unavailable", "Needs you to sign in: vector mcp auth login"],
        ["mcp:cold", "unavailable", "Configured, but it has not connected in this workspace."],
        ["mcp:broken", "unavailable", "It refused the handshake."],
        ["mcp:register", "unavailable", "It needs a client registration."],
        ["mcp:legacy", "unavailable", "Configured; connection status is unavailable in this engine."],
      ])
      const mcp = (list: readonly Connect.Member[]) =>
        list.filter((member) => member.kind === "mcp").map((member) => [member.id, member.state, member.reason])
      expect(mcp(cloud)).toEqual(mcp(here))
    }),
  )
})

// ---------------------------------------------------------------------------------------------------------------
// The hub

const handled = { count: 0 }

const clean: Connect.Result = {
  state: "completed",
  verdict: "clean",
  summary: "Nothing to flag.",
  findings: [],
  sessions: [],
  notes: [],
  sendsTo: "this-computer",
}

// A review member in this engine, as VectorScope's own adapter describes itself; that adapter runs in the last block.
const scope: ConnectAdapter.Adapter = {
  id: "vectorscope",
  owner: "vectorscope",
  describe: () => Effect.succeed(scopeMember),
  handle: () =>
    Effect.sync(() => {
      handled.count++
      return clean
    }),
}

const fakeAvailability = Layer.succeed(
  ComputerAvailability.Service,
  ComputerAvailability.Service.of({
    unavailable: () => Effect.succeed(undefined),
    capabilities: () => Effect.die(new Error("connect reads only unavailable()")),
    actions: () => Effect.die(new Error("connect reads only unavailable()")),
  }),
)

const FACTORIES: readonly ConnectAdapter.Factory<ConnectHandsAdapter.Services>[] = [
  Effect.succeed(scope),
  ConnectHandsAdapter.factory,
  ConnectGithubAgentAdapter.factory,
]

const graph = (cloudWorkspace: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      LayerNode.make({
        service: ConnectHub.Service,
        layer: ConnectHub.layerWith(FACTORIES),
        deps: [...ConnectHub.DEPS, ...ConnectHandsAdapter.DEPS],
      }),
      Session.node,
      Permission.node,
      Agent.node,
      SpendGuard.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
      BackgroundJob.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true, cloudWorkspace })],
      [ComputerAvailability.node, fakeAvailability],
    ],
  )

const cloud = testEffect(graph(true))
const plain = testEffect(graph(false))

const TOOLS = ["task", "browser", "vector_cloud", "computer", "read"]

const hands = {
  id: "computer",
  kind: "tool",
  title: Hands.NAME,
  owner: "hands",
  state: "ready",
  reach: "computer",
} as const

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

// ctx.ask as tool calls get it: every question is answered yes and recorded.
function asker() {
  const asks: unknown[] = []
  const ask: Tool.Context["ask"] = (request) => Effect.sync(() => void asks.push(request))
  return { asks, ask }
}

const say = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
  })

// Vector Local on, as the owner turns it on in their own config, for the length of `body`.
const withLocal = <A, E, R>(body: Effect.Effect<A, E, R>) => {
  const file = path.join(Global.Path.config, "vector.json")
  const apply = () => {
    Config.refreshLocal()
    Config.confirmLocal()
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ local: { enabled: true } }))
      apply()
      return before
    }),
    () => body,
    (before) =>
      Effect.sync(() => {
        if (before === undefined) rmSync(file, { force: true })
        else writeFileSync(file, before)
        apply()
        rmSync(Config.localConfirmedFile(), { force: true })
      }),
  )
}

const reviewOf = (sessionID: SessionID, directory: string) =>
  ({
    to: "vectorscope",
    action: "review",
    target: { kind: "uncommitted" },
    requester: { kind: "agent", sessionID, agent: "build" },
    directory,
    background: false,
  }) as ConnectHub.StartRequest

const setup = Effect.gen(function* () {
  handled.count = 0
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  const requester = yield* sessions.create({ title: "Requester" })
  yield* say(requester.id, "review my changes")
  return reviewOf(requester.id, test.directory)
})

describe("the hub in a cloud workspace", () => {
  cloud.instance("every member is on Vector's servers, and no summary the list writes says this computer", () =>
    Effect.gen(function* () {
      const hub = yield* ConnectHub.Service
      const list = yield* hub.members({ tools: TOOLS })
      // The desktop's own features are left out, as in the pure list above.
      expect(
        list.filter((member) => !DESKTOP.has(member.id) && member.place === "local").map((member) => member.id),
      ).toEqual([])
      expect(list.filter((member) => member.place === "your-cloud").map((member) => member.id)).toEqual([
        "github-agent",
      ])
      expect(row(list, Hands.ID)).toEqual({
        ...hands,
        summary: "The agent uses apps in this Vector cloud workspace, with your approval.",
        place: "vector-cloud",
      })
      expect(row(list, "vectorscope")).toMatchObject({
        place: "vector-cloud",
        sendsTo: "this-computer",
        state: "ready",
      })
      // What this covers: the summaries and reasons connect and its adapters write for this list, with Hands ready (its
      // availability reasons are Hands' own words) and no run (a result's wording is held; deviations, CN-15). Agents',
      // skills' and workflows' summaries are their authors' words.
      const written = list.filter((member) => !/^(agent|skill|workflow):/.test(member.id))
      expect(
        written
          .filter((member) => /this computer/i.test(`${member.summary} ${member.reason ?? ""}`))
          .map((member) => member.id),
      ).toEqual([])
    }),
  )

  plain.instance("without the marker the hub lists the same places as before, and a caller cannot set it", () =>
    Effect.gen(function* () {
      const hub = yield* ConnectHub.Service
      const list = yield* hub.members({ tools: TOOLS })
      expect(row(list, Hands.ID)).toEqual({
        ...hands,
        summary: "The agent uses apps on this computer, with your approval.",
        place: "local",
      })
      expect(row(list, "vectorscope")?.place).toBe("local")
      // The only member on Vector's servers is the deploy service.
      expect(list.filter((member) => member.place === "vector-cloud").map((member) => member.id)).toEqual([
        "vector-cloud",
      ])
      // The engine's place is its own flag, never a request's.
      // @ts-expect-error the members input has no place
      const asked = yield* hub.members({ tools: TOOLS, cloudWorkspace: true })
      expect(asked.map((member) => [member.id, member.place])).toEqual(list.map((member) => [member.id, member.place]))
    }),
  )

  cloud.instance("a hand-off follows the cloud place: Vector Local refuses it before anything is asked", () =>
    Effect.gen(function* () {
      const request = yield* setup
      const hub = yield* ConnectHub.Service
      const answers = asker()
      const refused = yield* withLocal(hub.run({ request, call: { ask: answers.ask } }))
      expect([refused.result?.state, refused.result?.refusal]).toEqual(["refused", "unavailable"])
      expect(refused.result?.summary).toContain(OFF_CLOUD)
      expect(answers.asks).toEqual([])
      expect(handled.count).toBe(0)
      // Without Vector Local the same member takes the run.
      const allowed = yield* hub.run({ request, call: { ask: answers.ask } })
      expect(allowed.result?.state).toBe("completed")
      expect(handled.count).toBe(1)
    }),
  )

  plain.instance("unset, Vector Local still lets the same member in this engine run", () =>
    Effect.gen(function* () {
      const request = yield* setup
      const hub = yield* ConnectHub.Service
      const answers = asker()
      const allowed = yield* withLocal(hub.run({ request, call: { ask: answers.ask } }))
      expect(allowed.result?.state).toBe("completed")
      expect(handled.count).toBe(1)
    }),
  )
})

// ---------------------------------------------------------------------------------------------------------------
// VectorScope's own adapter

// The model VectorScope's resolution returns; the provider below lists only lmstudio/test-model, with tool calls.
const scopeModel = { modelID: "test-model", context: 100_000 }

const scopeHub = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LayerNode.make({
        service: ConnectHub.Service,
        layer: ConnectHub.layerWith([
          VectorScopeAdapter.make({
            resolveModel: () =>
              Effect.sync(() => ({
                providerID: ProviderV2.ID.make("lmstudio"),
                modelID: ModelV2.ID.make(scopeModel.modelID),
                context: scopeModel.context,
                costKind: "local" as const,
              })),
            env: {},
          }),
        ]),
        deps: [...ConnectHub.DEPS, ...VectorScopeAdapter.DEPS],
      }),
      Session.node,
      SpendGuard.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
      Config.node,
      Git.node,
      CrossSpawnSpawner.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true, cloudWorkspace: true })]],
  ),
)

// Nothing listens at this address: no case here makes a model call.
const scopeInstance = { git: true, trusted: true, config: testProviderConfig("http://127.0.0.1:9/v1") } as const

const words = (member: Connect.Member | undefined) => `${member?.summary} ${member?.reason ?? ""}`

describe("VectorScope's own adapter in a cloud workspace", () => {
  const supported = process.platform === "linux" ? scopeHub.instance : scopeHub.instance.skip
  const unsupported = process.platform !== "linux" ? scopeHub.instance : scopeHub.instance.skip

  supported(
    "its row is on Vector's servers, keeps the model's destination, and its summary and reasons never say this computer",
    () =>
      Effect.gen(function* () {
        const hub = yield* ConnectHub.Service
        const vectorscope = () => hub.members().pipe(Effect.map((list) => row(list, "vectorscope")))
        scopeModel.modelID = "test-model"
        scopeModel.context = 100_000
        const ready = yield* vectorscope()
        expect(ready).toMatchObject({ place: "vector-cloud", sendsTo: "this-computer", state: "ready" })
        // Not ready, in the adapter's own words: a model the provider does not list, then one below 32k of context.
        scopeModel.modelID = "missing"
        const missing = yield* vectorscope()
        expect(missing).toMatchObject({ place: "vector-cloud", state: "unavailable" })
        expect(missing?.reason).toContain("is not available")
        scopeModel.modelID = "test-model"
        scopeModel.context = 8_000
        const small = yield* vectorscope()
        expect(small).toMatchObject({ place: "vector-cloud", state: "unavailable" })
        expect(small?.reason).toContain("at least 32k tokens of context")
        expect([ready, missing, small].filter((member) => /this computer/i.test(words(member)))).toEqual([])
      }),
    scopeInstance,
  )

  unsupported(
    "off Linux its row is on Vector's servers and its reason never says this computer",
    () =>
      Effect.gen(function* () {
        const hub = yield* ConnectHub.Service
        const listed = row(yield* hub.members(), "vectorscope")
        expect(listed).toMatchObject({ place: "vector-cloud", state: "unavailable" })
        expect(listed?.reason).toContain("require Linux")
        expect(words(listed)).not.toMatch(/this computer/i)
      }),
    scopeInstance,
  )
})
