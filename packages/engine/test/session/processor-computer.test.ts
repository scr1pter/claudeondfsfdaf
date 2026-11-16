import { expect } from "bun:test"
import { Context, Effect, Layer, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ComputerSession } from "@/computer/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Image } from "@/image/image"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class Fixture extends Context.Service<
  Fixture,
  {
    events: LLMEvent[]
    asks: string[]
    images: SessionV1.FilePart[]
    invalidated: string[]
    completed: { sessionID: SessionID; userMessageID: MessageID }[]
    image: "same" | "resize" | "unavailable"
    reject: boolean
  }
>()("@test/ComputerProcessor") {}

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
const model: Provider.Model = {
  id: ModelV2.ID.make("computer-test"),
  providerID: ProviderV2.ID.make("test"),
  name: "Computer test",
  api: { id: "computer-test", url: "https://example.invalid", npm: "@ai-sdk/openai" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const fixture = Layer.sync(Fixture, () => ({
  events: [],
  asks: [],
  images: [],
  invalidated: [],
  completed: [],
  image: "same" as const,
  reject: false,
}))

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionProcessor.node, Session.node, SessionProjector.node, SpendGuard.node]), [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [
      ComputerSession.node,
      Layer.unwrap(
        Effect.map(Fixture, (state) =>
          Layer.mock(ComputerSession.Service)({
            invalidate: (sessionID) =>
              Effect.sync(() => {
                state.invalidated.push(sessionID)
              }),
            markCompleted: (sessionID, userMessageID) =>
              Effect.sync(() => {
                state.completed.push({ sessionID, userMessageID })
              }),
          }),
        ),
      ).pipe(Layer.provide(fixture)),
    ],
    [Provider.node, Layer.mock(Provider.Service)({ line: () => Effect.succeed(undefined) })],
    [Auth.node, Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) })],
    [Agent.node, Layer.mock(Agent.Service)({ get: () => Effect.succeed(agent), helper: () => Effect.succeed(agent) })],
    [Snapshot.node, Layer.mock(Snapshot.Service)({ track: () => Effect.succeed(undefined) })],
    [SessionSummary.node, Layer.mock(SessionSummary.Service)({ summarize: () => Effect.void })],
    [Plugin.node, Layer.mock(Plugin.Service)({ trigger: (_name, _input, output) => Effect.succeed(output) })],
    [
      LLM.node,
      Layer.effect(
        LLM.Service,
        Effect.map(Fixture, (state) => LLM.Service.of({ stream: () => Stream.fromIterable(state.events) })),
      ).pipe(Layer.provide(fixture)),
    ],
    [
      Permission.node,
      Layer.unwrap(
        Effect.map(Fixture, (state) =>
          Layer.mock(Permission.Service)({
            ask: (input) =>
              Effect.gen(function* () {
                state.asks.push(input.permission)
                if (state.reject) return yield* new PermissionV1.RejectedError()
                return "once" as const
              }),
          }),
        ),
      ).pipe(Layer.provide(fixture)),
    ],
    [
      Image.node,
      Layer.effect(
        Image.Service,
        Effect.map(Fixture, (state) =>
          Image.Service.of({
            normalize: (input) =>
              Effect.gen(function* () {
                state.images.push(input)
                if (state.image === "unavailable") return yield* new Image.ResizerUnavailableError()
                return state.image === "resize" ? { ...input, url: "data:image/png;base64,cmVzaXplZA==" } : input
              }),
          }),
        ),
      ).pipe(Layer.provide(fixture)),
    ],
  ]).pipe(Layer.provideMerge(fixture)),
)

type Call = {
  action: string
  code?: string
  hash?: string | null
  x?: number
  point?: boolean
  ref?: string
  intent?: string
  name?: string
  query?: string
  actions?: Record<string, unknown>[]
  native?: Record<string, unknown> & { member: string }
}

const run = Effect.fn("test.computerSteps")(function* (steps: Call[][]) {
  const state = yield* Fixture
  const instance = yield* TestInstance
  const session = yield* Session.Service
  const processor = yield* SessionProcessor.Service
  const guard = yield* SpendGuard.Service
  const chat = yield* session.create({})
  yield* guard.begin(chat.id)
  let parent: SessionV1.User | undefined
  let sequence = 0
  for (const calls of steps) {
    if (!parent) {
      parent = {
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
        time: { created: Date.now() },
      }
      yield* session.updateMessage(parent)
    }
    const message: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "assistant",
      parentID: parent.id,
      agent: "build",
      mode: "build",
      modelID: model.id,
      providerID: model.providerID,
      path: { cwd: instance.directory, root: instance.directory },
      time: { created: Date.now() },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    yield* session.updateMessage(message)
    state.events = [
      LLMEvent.stepStart({ index: 0 }),
      ...calls.flatMap((call) => {
        const id = `call-${++sequence}`
        const name = call.name ?? "computer"
        return [
          LLMEvent.toolCall({
            id,
            name,
            providerExecuted: true,
            ...(call.native
              ? { providerMetadata: { anthropic: { toolset_name: "computer", member: call.native.member } } }
              : {}),
            input: call.native ?? {
              action: call.action,
              app: "app:macos:com.apple.Safari",
              x: call.x ?? 100,
              y: 200,
              ref: call.ref,
              intent: call.intent,
              query: call.query,
              actions: call.actions,
            },
          }),
          LLMEvent.toolResult({
            id,
            name,
            providerExecuted: true,
            result: {
              type: "json",
              value: {
                title: call.action,
                output: `Screenshot ${sequence}`,
                metadata: {
                  action: call.action,
                  code: call.code,
                  app: { key: "app:macos:com.apple.Safari", name: "Safari" },
                  target: { role: "button", name: "Save" },
                  point: call.point === false ? undefined : { x: call.x ?? 100, y: 200 },
                  frame:
                    call.hash === null
                      ? undefined
                      : { id: `frame_${sequence}`, width: 1440, height: 900, hash: call.hash ?? "0123456789abcdef" },
                },
                attachments: [
                  {
                    id: PartID.ascending(),
                    sessionID: chat.id,
                    messageID: message.id,
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${Buffer.from(`pixels-${sequence}`).toString("base64")}`,
                  },
                ],
              },
            },
          }),
        ]
      }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      }),
      LLMEvent.finish({ reason: "stop" }),
    ]
    const handle = yield* processor.create({ assistantMessage: message, sessionID: chat.id, model })
    yield* handle.process({
      sessionID: chat.id,
      user: parent,
      agent,
      model,
      system: [],
      messages: [{ role: "user", content: "Use the app" }],
      tools: {},
    })
    yield* processor.settle(chat.id)
  }
  if (!parent) throw new Error("Expected at least one assistant step")
  const messages = yield* session.messages({ sessionID: chat.id })
  return {
    state,
    sessionID: chat.id,
    userMessageID: parent.id,
    budget: yield* guard.snapshot(chat.id),
    tools: messages.flatMap((message) => message.parts.filter((part) => part.type === "tool")),
  }
})

for (const action of ["screenshot", "zoom", "cursor_position", "wait", "scroll", "read_ui", "list_apps"]) {
  for (const separate of [false, true]) {
    it.instance(
      `three ${action} calls do not trip either loop guard ${separate ? "across messages" : "in one message"}`,
      () =>
        Effect.gen(function* () {
          const calls = Array.from({ length: 3 }, () => ({ action }))
          const result = yield* run(separate ? calls.map((call) => [call]) : [calls])
          expect(result.tools).toHaveLength(3)
          expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
          expect(result.state.completed).toEqual(
            calls.map(() => ({
              sessionID: result.sessionID,
              userMessageID: result.userMessageID,
            })),
          )
          expect(result.state.asks).toEqual([])
          expect(result.budget?.stopped).toBeUndefined()
        }),
    )
  }
}

for (const native of [
  { member: "screenshot" },
  { member: "wait", duration: 1 },
  { member: "scroll", scroll_direction: "down", scroll_amount: 1 },
]) {
  for (const separate of [false, true]) {
    it.instance(
      `three native ${native.member} calls do not trip either loop guard ${separate ? "across messages" : "in one message"}`,
      () =>
        Effect.gen(function* () {
          const calls = Array.from({ length: 3 }, () => ({ action: native.member, native }))
          const result = yield* run(separate ? calls.map((call) => [call]) : [calls])
          expect(result.tools).toHaveLength(3)
          expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
          expect(result.tools.map((part) => part.state.input)).toEqual(calls.map(() => native))
          expect(result.state.asks).toEqual([])
          expect(result.budget?.stopped).toBeUndefined()
        }),
    )
  }
}

it.instance("different native interaction members do not trip either loop guard", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ["left_click", "right_click", "middle_click"].map((member) => [
        { action: member === "left_click" ? "click" : member, native: { member, coordinate: [100, 200] } },
      ]),
    )
    expect(result.tools).toHaveLength(3)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("equivalent native click spellings still trip both loop guards", () =>
  Effect.gen(function* () {
    const result = yield* run([
      [{ action: "click", native: { member: "left_click", coordinate: [100, 200] } }],
      [{ action: "click", native: { member: "click", x: 100, y: 200 } }],
      [{ action: "click", native: { member: "click", button: "left", coordinate: [100, 200] } }],
    ])
    expect(result.tools).toHaveLength(3)
    expect(result.state.asks).toEqual(["doom_loop"])
    expect(result.budget?.stopped?.reason).toBe("loop")
  }),
)

it.instance("different native drag paths do not trip either loop guard", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Array.from({ length: 3 }, (_, index) => [
        {
          action: "drag",
          native: {
            member: "left_click_drag",
            start_coordinate: [index * 10, 0],
            coordinate: [100, 200],
          },
        },
      ]),
    )
    expect(result.tools).toHaveLength(3)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("a refused computer output marks its user turn but another tool does not", () =>
  Effect.gen(function* () {
    const result = yield* run([
      [
        { action: "read_ui", code: "denied", hash: null },
        { name: "lookup", action: "read" },
      ],
    ])
    expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
    expect(result.state.completed).toEqual([{ sessionID: result.sessionID, userMessageID: result.userMessageID }])
  }),
)

for (const separate of [false, true]) {
  it.instance(`three identical clicks trip both loop guards ${separate ? "across messages" : "in one message"}`, () =>
    Effect.gen(function* () {
      // Capture IDs, screenshot bytes/labels, frame-scoped refs and intent text all change, but the action does not.
      const calls = Array.from({ length: 3 }, (_, index) => ({
        action: "click",
        ref: `ui_${index}`,
        intent: `Try ${index}`,
      }))
      const result = yield* run(separate ? calls.map((call) => [call]) : [calls])
      expect(result.state.asks).toEqual(["doom_loop"])
      expect(result.budget?.stopped?.reason).toBe("loop")
      expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
    }),
  )
}

for (const change of ["frame", "target", "missing-frame"]) {
  it.instance(`repeated clicks with a ${change} change do not trip either loop guard`, () =>
    Effect.gen(function* () {
      const result = yield* run(
        Array.from({ length: 3 }, (_, index) => [
          {
            action: "click",
            hash: change === "missing-frame" ? null : change === "frame" ? `${index}123456789abcdef` : undefined,
            x: change === "target" ? index * 100 : undefined,
          },
        ]),
      )
      expect(result.tools).toHaveLength(3)
      expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
      expect(result.state.asks).toEqual([])
      expect(result.budget?.stopped).toBeUndefined()
    }),
  )
}

it.instance("different accessibility refs with the same label remain different targets without a resolved point", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Array.from({ length: 3 }, (_, index) => [{ action: "click", ref: `ui_${index}`, point: false }]),
    )
    expect(result.tools).toHaveLength(3)
    expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("an observation between clicks breaks the repeated interaction sequence", () =>
  Effect.gen(function* () {
    const result = yield* run([
      [{ action: "click" }],
      [{ action: "click" }],
      [{ action: "screenshot" }],
      [{ action: "click" }],
    ])
    expect(result.tools).toHaveLength(4)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("another tool between clicks breaks the repeated interaction sequence", () =>
  Effect.gen(function* () {
    const result = yield* run([
      [{ action: "click" }],
      [{ action: "click" }],
      [{ name: "lookup", action: "click" }],
      [{ action: "click" }],
    ])
    expect(result.tools).toHaveLength(4)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("observation-only batches do not trip either loop guard", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Array.from({ length: 3 }, () => [
        { action: "screenshot", actions: [{ action: "screenshot" }, { action: "wait" }] },
      ]),
    )
    expect(result.tools).toHaveLength(3)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("different open_app queries remain different actions", () =>
  Effect.gen(function* () {
    const result = yield* run(["Safari", "Mail", "Notes"].map((query) => [{ action: "open_app", query }]))
    expect(result.tools).toHaveLength(3)
    expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("mixed batches retain their observation action parameters", () =>
  Effect.gen(function* () {
    const result = yield* run(
      Array.from({ length: 3 }, (_, index) => [
        {
          action: "click",
          actions: [
            { action: "click", x: 100, y: 200 },
            { action: "scroll", direction: "down", amount: index + 1 },
          ],
        },
      ]),
    )
    expect(result.tools).toHaveLength(3)
    expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
    expect(result.state.asks).toEqual([])
    expect(result.budget?.stopped).toBeUndefined()
  }),
)

it.instance("empty assistant steps do not hide repeated interactions", () =>
  Effect.gen(function* () {
    const result = yield* run([[{ action: "click" }], [], [{ action: "click" }], [], [{ action: "click" }]])
    expect(result.state.asks).toEqual(["doom_loop"])
    expect(result.budget?.stopped?.reason).toBe("loop")
  }),
)

it.instance("rejecting a repeat request leaves the completed computer result intact", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    state.reject = true
    const result = yield* run([[{ action: "click" }, { action: "click" }, { action: "click" }]])
    expect(result.state.asks).toEqual(["doom_loop"])
    expect(result.tools).toHaveLength(3)
    expect(result.tools.every((part) => part.state.status === "completed")).toBe(true)
  }),
)

for (const image of ["same", "resize", "unavailable"] as const) {
  it.instance(
    `computer screenshot normalization ${image === "same" ? "preserves matching frame coordinates" : `refuses ${image} images`}`,
    () =>
      Effect.gen(function* () {
        const state = yield* Fixture
        state.image = image
        const result = yield* run([[{ action: "screenshot" }]])
        expect(state.images).toHaveLength(1)
        expect(result.tools).toHaveLength(1)
        const part = result.tools[0]
        if (image === "same") {
          expect(state.invalidated).toEqual([])
          expect(state.completed).toEqual([{ sessionID: result.sessionID, userMessageID: result.userMessageID }])
          expect(part.state.status).toBe("completed")
          if (part.state.status !== "completed") throw new Error("Missing computer result")
          expect(part.state.attachments).toEqual(state.images)
          expect(part.state.metadata.frame).toMatchObject({ width: 1440, height: 900 })
          return
        }
        expect(part.state.status).toBe("error")
        expect(state.completed).toEqual([])
        expect(state.invalidated).toEqual([part.sessionID])
        if (part.state.status !== "error") throw new Error("Unsafe screenshot was accepted")
        expect(part.state.error).toContain("Capture a fresh screenshot")
        expect(part.state).not.toHaveProperty("attachments")
      }),
  )
}
