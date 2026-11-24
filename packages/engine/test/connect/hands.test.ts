import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Computer } from "@vectordevai/schema/computer"
import type { Connect } from "@vectordevai/schema/connect"
import { Hands } from "@vectordevai/schema/hands"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { ComputerAvailability } from "@/computer/availability"
import { ConnectAdapters } from "@/connect/adapters"
import { ConnectHandsAdapter } from "@/connect/adapters/hands"
import { VectorScopeAdapter } from "@/connect/adapters/vectorscope"
import { ConnectHub } from "@/connect/hub"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Parameters } from "@/tool/connect"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Vector Hands in connected tools (CW-21a): listed by its own adapter with Hands' real availability, and reached only
// through its own `computer` tool. The hub over the Hands adapter alone, with a fake ComputerAvailability: no desktop
// bridge, no network and no model. The adapter's only I/O in the engine is Hands' existing loopback bridge probe,
// which is Egress-gated, cached for 30 s and already made by the registry each turn.

afterEach(disposeAllInstances)

// What the fake availability answers in the current test, and how often connect asked it.
const script: { reason?: ComputerAvailability.Reason; fail?: boolean; probes: number } = { probes: 0 }

const reset = () => {
  delete script.reason
  delete script.fail
  script.probes = 0
}

const fakeAvailability = Layer.succeed(
  ComputerAvailability.Service,
  ComputerAvailability.Service.of({
    unavailable: () =>
      Effect.suspend(() => {
        script.probes++
        return script.fail ? Effect.die(new Error("the bridge probe failed")) : Effect.succeed(script.reason)
      }),
    capabilities: () => Effect.die(new Error("connect reads only unavailable()")),
    actions: () => Effect.die(new Error("connect reads only unavailable()")),
  }),
)

const graph = (fake: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      LayerNode.make({
        service: ConnectHub.Service,
        layer: ConnectHub.layerWith([ConnectHandsAdapter.factory]),
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
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true })],
      ...(fake ? [[ComputerAvailability.node, fakeAvailability] as const] : []),
    ],
  )

const it = testEffect(graph(true))
const real = testEffect(graph(false))

// Every reason Hands gives. A reason Hands adds later fails this file's typecheck until it is listed here.
const REASONS = Object.keys({
  desktop: true,
  platform: true,
  "macos-version": true,
  policy: true,
  offline: true,
  guest: true,
  wsl: true,
  elevated: true,
  "may-train": true,
  unattended: true,
  disabled: true,
  "cloud-workspace": true,
} satisfies Record<ComputerAvailability.Reason, true>) as ComputerAvailability.Reason[]

const hands = {
  id: "computer",
  kind: "tool",
  title: "Vector Hands",
  summary: "The agent uses apps on this computer, with your approval.",
  owner: "hands",
  place: "local",
  reach: "computer",
} as const

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

const computerRow = (list: readonly Connect.Member[]) => list.filter((item) => item.id === Hands.ID)

// ctx.ask as tool calls get it, recording each question.
function asker() {
  const asks: unknown[] = []
  const ask: Tool.Context["ask"] = (request) => Effect.sync(() => void asks.push(request))
  return { asks, ask }
}

// Prompt calls as a tool call lends them; connect must never prompt anything for Hands.
function recorder() {
  const prompts: SessionID[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.suspend(() => {
        prompts.push(input.sessionID)
        return Effect.die(new Error("connect prompted a session for Hands"))
      }),
  }
  return { ops, prompts }
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

describe("the member list", () => {
  it.instance("Hands is listed ready by its own adapter and reached only through its own tool", () =>
    Effect.gen(function* () {
      reset()
      const hub = yield* ConnectHub.Service
      const list = yield* hub.members({ tools: ["read", "computer"] })
      expect(computerRow(list)).toEqual([{ ...hands, state: "ready" }])
      expect(list.some((item) => item.id === "tool:computer")).toBe(false)
      expect(list.find((item) => item.id === "tool:read")?.reach).toBe("read")
      expect(script.probes).toBe(1)
    }),
  )

  it.instance("every reason Hands gives reads unavailable, in Hands' own words", () =>
    Effect.gen(function* () {
      reset()
      const hub = yield* ConnectHub.Service
      for (const reason of REASONS) {
        script.reason = reason
        const list = yield* hub.members({ tools: ["computer"] })
        // The hub decodes each member, so each message also fits the member's reason (Words(500)).
        expect(computerRow(list)).toEqual([
          { ...hands, state: "unavailable", reason: ComputerAvailability.message(reason) },
        ])
      }
      expect(script.probes).toBe(REASONS.length)
    }),
  )

  it.instance("not in this build when the registry does not offer computer, and left out without tool ids", () =>
    Effect.gen(function* () {
      reset()
      const hub = yield* ConnectHub.Service
      expect(computerRow(yield* hub.members({ tools: ["read"] }))).toEqual([
        { ...hands, state: "not-installed", reason: "Not in this build.", reach: "none" },
      ])
      expect(computerRow(yield* hub.members())).toEqual([])
      // The hub describes every adapter before it composes the list, so Hands was still asked, once per list.
      expect(script.probes).toBe(2)
    }),
  )

  it.instance("Hands keeps its own reason when the registry does not offer computer (CW-21)", () =>
    Effect.gen(function* () {
      reset()
      const hub = yield* ConnectHub.Service
      for (const reason of REASONS) {
        script.reason = reason
        // The computer tool is absent because Hands is unavailable: the row says why, with nothing to reach.
        expect(computerRow(yield* hub.members({ tools: ["read"] }))).toEqual([
          { ...hands, state: "unavailable", reason: ComputerAvailability.message(reason), reach: "none" },
        ])
      }
      expect(script.probes).toBe(REASONS.length)
    }),
  )

  it.instance("a failed probe reads unavailable as the hub's fallback, never ready", () =>
    Effect.gen(function* () {
      reset()
      script.fail = true
      const hub = yield* ConnectHub.Service
      // The hub's fallback for a member that cannot describe itself has nothing to reach, so it is shown whatever
      // the registry offers.
      const fallback = {
        id: "computer",
        kind: "agent",
        title: "computer",
        summary: "",
        owner: "hands",
        place: "local",
        state: "unavailable",
        reason: "Connect could not check whether it is ready.",
        reach: "none",
      } as const
      expect(computerRow(yield* hub.members({ tools: ["computer"] }))).toEqual([fallback])
      expect(computerRow(yield* hub.members({ tools: ["read"] }))).toEqual([fallback])
      expect(computerRow(yield* hub.members())).toEqual([fallback])
    }),
  )

  it.effect("the engine's hub builds the Hands adapter after VectorScope's, over Hands' own availability", () =>
    Effect.sync(() => {
      const scope = ConnectAdapters.ADAPTERS.indexOf(VectorScopeAdapter.factory)
      expect(scope).toBeGreaterThanOrEqual(0)
      expect(ConnectAdapters.ADAPTERS.indexOf(ConnectHandsAdapter.factory)).toBeGreaterThan(scope)
      expect((ConnectAdapters.DEPS as readonly unknown[]).includes(ComputerAvailability.node)).toBe(true)
      expect(ConnectHandsAdapter.ID).toBe(Hands.ID)
    }),
  )

  // Hands' real availability with no desktop bridge: its probe is a plain succeed, so nothing reaches the network.
  const unbridged = process.env[Computer.BRIDGE.urlEnv] ? real.instance.skip : real.instance
  unbridged("with no desktop bridge, Hands reads unavailable with its own reason", () =>
    Effect.gen(function* () {
      const hub = yield* ConnectHub.Service
      const row = computerRow(yield* hub.members({ tools: ["computer"] }))
      expect(row).toHaveLength(1)
      expect(row[0]).toMatchObject({ ...hands, state: "unavailable" })
      expect(REASONS.map(ComputerAvailability.message)).toContain(row[0]?.reason ?? "")
    }),
  )
})

describe("hand-offs to Hands", () => {
  it.instance("connect hands nothing to Hands, whoever asks", () =>
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const hub = yield* ConnectHub.Service
      const jobs = yield* BackgroundJob.Service
      const requester = yield* sessions.create({ title: "Requester" })
      yield* say(requester.id, "use my computer")
      const actions = {
        review: { action: "review", target: { kind: "uncommitted" } },
        fix: { action: "fix", run: "cr_missing", findings: ["f1"], mode: "here" },
      }
      for (const [name, action] of Object.entries(actions)) {
        const { asks, ask } = asker()
        const { ops, prompts } = recorder()
        const base = { to: Hands.ID, directory: test.directory, background: false, ...action }
        const agent = { kind: "agent", sessionID: requester.id, agent: "build" }
        const requesters: Record<string, ConnectHub.StartInput> = {
          agent: { request: { ...base, requester: agent } as ConnectHub.StartRequest, call: { ask } },
          user: {
            request: { ...base, requester: { kind: "user", sessionID: requester.id } } as ConnectHub.StartRequest,
            call: { ask },
          },
          workflow: {
            request: { ...base, requester: { kind: "workflow", sessionID: requester.id } } as ConnectHub.StartRequest,
            call: { ask },
          },
          background: {
            request: { ...base, requester: agent, background: true } as ConnectHub.StartRequest,
            call: { ask, promptOps: ops },
          },
          "after-run": {
            request: { ...base, requester: agent } as ConnectHub.StartRequest,
            call: { ask, promptOps: ops, unattended: true, afterRunCurrent: Effect.succeed(true) },
          },
        }
        for (const [who, input] of Object.entries(requesters)) {
          const run = yield* hub.run(input)
          expect([name, who, run.result?.state, run.result?.refusal]).toEqual([name, who, "refused", "unknown"])
          expect(run.result?.summary).toBe("computer is only listed; connect cannot hand work to it.")
          expect(run.result?.sessions).toEqual([])
        }
        expect(asks).toEqual([])
        expect(prompts).toEqual([])
      }
      expect((yield* jobs.list()).filter((job) => job.type === ConnectHub.JOB_TYPE)).toEqual([])
      expect(yield* hub.runs({ sessionID: requester.id })).toEqual([])
      // Refused before the member was described: Hands' availability was never read for a hand-off.
      expect(script.probes).toBe(0)
      expect(yield* sessions.children(requester.id)).toEqual([])
    }),
  )

  it.instance("a list-only hand-off keeps the isolated-task and helper refusal reasons", () =>
    Effect.gen(function* () {
      reset()
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const hub = yield* ConnectHub.Service
      const jobs = yield* BackgroundJob.Service
      const requester = yield* sessions.create({ title: "Requester" })
      const helper = yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })
      const review = { action: "review", to: Hands.ID, directory: test.directory, background: true } as const
      const target = { kind: "task", task: helper.id } as const
      const task = yield* hub.run({
        request: { ...review, target, requester: { kind: "user", sessionID: requester.id } },
      })
      expect(task.result).toMatchObject({
        refusal: "input",
        target,
        summary: "An isolated task review needs its launching conversation and VectorScope.",
      })
      const nested = yield* hub.run({
        request: { ...review, target: { kind: "uncommitted" }, requester: { kind: "agent", sessionID: helper.id } },
      })
      expect(nested.result).toMatchObject({
        refusal: "not-allowed",
        summary: "A helper session cannot hand work to another member.",
      })
      expect((yield* jobs.list()).filter((job) => job.type === ConnectHub.JOB_TYPE)).toEqual([])
      expect(yield* hub.runs()).toEqual([])
      expect(script.probes).toBe(0)
    }),
  )

  it.effect("neither the model's connect tool nor a helper handle can name Hands", () =>
    Effect.sync(() => {
      expect(Option.isNone(Schema.decodeUnknownOption(Parameters)({ action: "review", to: Hands.ID }))).toBe(true)
      expect(Option.isSome(Schema.decodeUnknownOption(Parameters)({ action: "review", to: "vectorscope" }))).toBe(true)
      expect(ConnectHub.HELPER_MEMBERS.has(Hands.ID)).toBe(false)
      expect(ConnectHub.HELPER_AGENTS[Hands.ID]).toBeUndefined()
    }),
  )
})

describe("I11: Hands stays in the conversation's root", () => {
  it.instance(
    "the connect_fix child is never offered computer, whatever the rules say",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const fixer = yield* agents.get(ConnectPolicy.FIX_AGENT)
        expect(fixer.name).toBe(ConnectPolicy.FIX_AGENT)
        expect(ConnectPolicy.FIX_TOOLS).not.toContain(Hands.ID)
        for (const permission of [Hands.ID, "computer_sensitive"])
          expect([permission, Permission.evaluate(permission, "*", fixer.permission).action]).toEqual([
            permission,
            "deny",
          ])
        // The registry's own filter: a tool whose last rule denies everything is never offered to the agent.
        expect(Permission.disabled([Hands.ID], fixer.permission).has(Hands.ID)).toBe(true)
        const build = yield* agents.get("build")
        expect(Permission.disabled([Hands.ID], build.permission).has(Hands.ID)).toBe(false)
      }),
    {
      trusted: true,
      config: {
        permission: { "*": "allow", computer: "allow" },
        agent: {
          build: { permission: { computer: "allow" } },
          [ConnectPolicy.FIX_AGENT]: { permission: { computer: "allow", computer_sensitive: "allow" } },
        },
      },
    },
  )
})
