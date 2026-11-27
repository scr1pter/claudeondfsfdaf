import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { buildLocationServiceMap, LocationServiceMap } from "@vectordevai/core/location-services"
import { Pty } from "@vectordevai/core/pty"
import { PtyID } from "@vectordevai/core/pty/schema"
import { Config } from "@/config/config"
import { ComputerSession } from "@/computer/session"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { TerminalTool } from "../../src/tool/terminal"
import type { Tool } from "../../src/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The agent environment review's terminal cases (docs/vector/build/agent-environment-status.md). The tool is built as
// terminal.test.ts builds it; the terminals are stand-ins, so nothing is spawned and every case runs on every platform.

// The location services the tool reaches, built as the app's are, on this test's event bus.
const locations = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: Layer.unwrap(
    EventV2.Service.use((events) =>
      Effect.succeed(buildLocationServiceMap([[EventV2.node, Layer.succeed(EventV2.Service, events)]])),
    ),
  ),
  deps: [EventV2.node],
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        ComputerSession.node,
        Session.node,
        Agent.node,
        RuntimeFlags.node,
        Permission.node,
        EventV2.node,
        FreeModelGuests.node,
        locations,
      ]),
      [[locations, locations]],
    ),
    testInstanceStoreLayer,
  ),
)

type Ask = Parameters<Tool.Context["ask"]>[0]

const SESSION = "ses_review"

const context = (asked: Ask[] = []): Tool.Context => ({
  sessionID: SessionID.make(SESSION),
  messageID: MessageID.make("msg_review"),
  callID: "call_review",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input) =>
    Effect.sync(() => {
      asked.push(input)
    }),
})

const init = Effect.fn("TerminalAgentReviewTest.init")(function* () {
  const info = yield* TerminalTool
  return yield* info.init()
})

// The terminals a location holds: the user's own, another session's agent's, and this session's agent's. What each
// reveal publishes is recorded.
const terminals = () => {
  const make = (title: string, owner?: Pty.Owner): Pty.Info => ({
    id: PtyID.ascending(),
    title,
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/repo",
    status: "running",
    pid: 0,
    ...(owner ? { owner } : {}),
  })
  const user = make("zsh")
  const other = make("deploy", { kind: "agent", sessionID: "ses_other" })
  const mine = make("dev server", { kind: "agent", sessionID: SESSION })
  const all = [user, other, mine]
  const revealed: { id: string; focus: boolean }[] = []
  return {
    user,
    other,
    mine,
    revealed,
    layer: Layer.mock(Pty.Service, {
      list: () => Effect.sync(() => [...all]),
      get: (id) =>
        Effect.sync(() => {
          const info = all.find((item) => item.id === id)
          if (!info) throw new Error("No such stand-in terminal")
          return info
        }),
      reveal: (id, input) =>
        Effect.sync(() => {
          revealed.push({ id, focus: input?.focus === true })
        }),
    }),
  }
}

const withTerminals = <A, E, R>(layer: Layer.Layer<Pty.Service>, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* body.pipe(provideInstance(dir), Effect.provide(buildLocationServiceMap([[Pty.node, layer]])))
  })

const SHOWN = (id: string) =>
  `Asked Vector to show ${id} in the terminal panel. A client without a terminal panel shows nothing.`

describe("tool.terminal reveal", () => {
  it.live("moves the keyboard only into a terminal the agent opened, never the user's or another session's", () => {
    const pty = terminals()
    return withTerminals(
      pty.layer,
      Effect.gen(function* () {
        const tool = yield* init()
        const asked: Ask[] = []
        for (const info of [pty.user, pty.other]) {
          const shown = yield* tool.execute({ action: "reveal", id: info.id, focus: true }, context(asked))
          expect(shown.output).toBe(
            `${SHOWN(info.id)} The keyboard focus stays where it is: Vector moves it only into a terminal you opened.`,
          )
        }
        // Shown without focus, nothing is said about it.
        expect((yield* tool.execute({ action: "reveal", id: pty.user.id }, context(asked))).output).toBe(
          SHOWN(pty.user.id),
        )
        // Its own terminal takes the keyboard, for the user to type what the agent must not.
        expect((yield* tool.execute({ action: "reveal", id: pty.mine.id, focus: true }, context(asked))).output).toBe(
          SHOWN(pty.mine.id),
        )
        expect(pty.revealed).toEqual([
          { id: pty.user.id, focus: false },
          { id: pty.other.id, focus: false },
          { id: pty.user.id, focus: false },
          { id: pty.mine.id, focus: true },
        ])
        // Showing a terminal asks nothing, as before.
        expect(asked).toEqual([])
      }),
    )
  })
})
