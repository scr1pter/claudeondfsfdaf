import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionAdmission } from "../../src/session/admission"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { Snapshot } from "../../src/snapshot"
import { Permission } from "../../src/permission"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
        // The fake server answers any number of requests at once, unlike a model server whose count nobody set.
        concurrency: 64,
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      lmstudio: {
        ...cfg.provider.lmstudio,
        options: {
          ...cfg.provider.lmstudio.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

// The step-start snapshot returns at once; the one taken after the step waits until the run is interrupted.
const stalledSnapshot = () => {
  let calls = 0
  return Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: () => Effect.suspend(() => (++calls === 1 ? Effect.succeed("start") : Effect.never)),
      patch: () => Effect.succeed({ hash: "start", files: [] }),
      restore: () => Effect.void,
      revert: () => Effect.void,
      diff: () => Effect.succeed(""),
      diffFull: () => Effect.succeed([]),
    }),
  )
}
const billedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "done" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: new Usage({ inputTokens: 100_000, outputTokens: 1_000, totalTokens: 101_000 }),
        }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
// Reports Anthropic-style usage as the response starts, then either hangs until stopped or fails mid-stream.
const unfinishedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      Stream.suspend(() => {
        input.started?.({
          inputTokens: 180_000,
          outputTokens: 1,
          cacheWriteInputTokens: 175_000,
          totalTokens: 180_001,
        })
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        ).pipe(
          Stream.concat(input.messages[0]?.content === "fail" ? Stream.fail(new Error("stream broke")) : Stream.never),
        )
      }),
  }),
)
const itUnfinished = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, unfinishedLLM]]))
const itStalledSnapshot = testEffect(
  LayerNode.compile(root, [...replacements, [LLM.node, billedLLM], [Snapshot.node, stalledSnapshot()]]),
)

// The opening snapshot lands only when the test releases it; the closing one returns at once. Each landing is logged
// next to what the test and the tool record, so the log is the order things happened in.
const snapshotGate = { log: [] as string[], release: defer<void>(), tracks: 0 }
const gatedSnapshot = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () =>
      Effect.suspend(() =>
        ++snapshotGate.tracks === 1
          ? Effect.promise(() => snapshotGate.release.promise).pipe(
              Effect.map(() => {
                snapshotGate.log.push("opening snapshot")
                return "opening"
              }),
            )
          : Effect.sync(() => {
              snapshotGate.log.push("closing snapshot")
              return "closing"
            }),
      ),
    patch: (hash) =>
      Effect.sync(() => {
        snapshotGate.log.push(`patch from ${hash}`)
        return { hash, files: ["/changed.txt"] }
      }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: () => Effect.succeed([]),
  }),
)
const itGatedSnapshot = testEffect(
  LayerNode.compile(
    LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
    [...replacements, [Snapshot.node, gatedSnapshot]],
  ),
)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

itGatedSnapshot.live(
  "session.processor effect tests send the request before the opening snapshot lands and hold tools until it does",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          yield* llm.tool("lookup", { query: "weather" })

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const run = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "tool" }],
              tools: {
                lookup: tool({
                  description: "Look up information",
                  inputSchema: z.object({ query: z.string() }),
                  execute: async (input) => {
                    snapshotGate.log.push("tool")
                    return { title: "Weather lookup", output: `result:${input.query}`, metadata: {} }
                  },
                }),
              },
            })
            .pipe(Effect.forkChild)

          // The provider has the request while the opening snapshot is still being taken.
          yield* llm.wait(1)
          snapshotGate.log.push("request")
          snapshotGate.release.resolve()
          expect(yield* Fiber.join(run)).toBe("continue")
          yield* processors.settle(chat.id)

          expect(snapshotGate.log).toEqual([
            "request",
            "opening snapshot",
            "tool",
            "closing snapshot",
            "patch from opening",
          ])
          const parts = yield* MessageV2.parts(msg.id)
          expect(parts.find((part) => part.type === "step-start")).toMatchObject({ snapshot: "opening" })
          expect(parts.find((part) => part.type === "step-finish")).toMatchObject({ snapshot: "closing" })
          expect(parts.find((part) => part.type === "patch")).toMatchObject({
            hash: "opening",
            files: ["/changed.txt"],
          })
          const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          expect(call?.state.status).toBe("completed")
        }),
      { trusted: true, config: (url) => providerCfg(url) },
    ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { trusted: true, config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { trusted: true, config: cfg },
  ),
)

itStalledSnapshot.live(
  "session.processor effect tests keep a billed step's cost when cancelled during its snapshot",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "billed step")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const run = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "billed step" }],
              tools: {},
            })
            .pipe(Effect.forkChild)
          yield* waitFor(
            session.messages({ sessionID: chat.id }).pipe(
              Effect.map((messages) =>
                messages.flatMap((message) => message.parts).find((part) => part.type === "step-finish"),
              ),
              Effect.orDie,
            ),
            "the step was never recorded",
          )
          yield* Fiber.interrupt(run)

          // 100K input and 1K output at $3 and $15 per million tokens.
          const saved = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
          expect(saved.info.role === "assistant" && saved.info.cost).toBeCloseTo(0.315)
          expect((yield* session.get(chat.id)).cost).toBeCloseTo(0.315)
        }),
      {
        trusted: true,
        config: {
          provider: {
            lmstudio: {
              ...cfg.provider.lmstudio,
              models: {
                "test-model": { ...cfg.provider.lmstudio.models["test-model"], cost: { input: 3, output: 15 } },
              },
            },
          },
        },
      },
    ),
)

for (const guarded of [false, true]) {
  for (const outcome of ["stopped", "fail"] as const) {
    itUnfinished.live(
      `session.processor effect tests record what a ${outcome === "fail" ? "failed" : "stopped"} step was billed as it started${guarded ? " with admission observations" : ""}`,
      () =>
        provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const database = yield* Database.Service
              const { processors, session, provider } = yield* boot()
              const chat = yield* session.create({})
              const parent = yield* user(chat.id, outcome)
              const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
              const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
              const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

              const observed: number[] = []
              const settled: SessionAdmission.Settlement[] = []
              const run = yield* handle
                .process({
                  user: {
                    id: parent.id,
                    sessionID: chat.id,
                    role: "user",
                    time: parent.time,
                    agent: parent.agent,
                    model: { providerID: ref.providerID, modelID: ref.modelID },
                  } satisfies SessionV1.User,
                  sessionID: chat.id,
                  model: mdl,
                  agent: agent(),
                  system: [],
                  messages: [{ role: "user", content: outcome }],
                  tools: {},
                })
                .pipe(
                  Effect.provideService(
                    SessionAdmission.Current,
                    guarded
                      ? {
                          sessionID: chat.id,
                          admit: () => ({
                            observe: (cost) => observed.push(cost),
                            settle: (result) => settled.push(result),
                          }),
                        }
                      : undefined,
                  ),
                  Effect.forkChild,
                )
              if (outcome === "stopped") {
                yield* waitFor(
                  MessageV2.parts(msg.id).pipe(
                    Effect.map((parts) => parts.find((part) => part.type === "text")),
                    Effect.provideService(Database.Service, database),
                  ),
                  "the step never streamed",
                )
                yield* Fiber.interrupt(run)
                yield* Fiber.await(run)
              }
              if (outcome === "fail") yield* Fiber.join(run)

              // 5K input and 175K cache write at $3 and $3.75 per million tokens, plus one output token at $15.
              const expected = (5_000 * 3 + 175_000 * 3.75 + 15) / 1_000_000
              const saved = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
              const finished = saved.parts.filter((part) => part.type === "step-finish")
              expect(finished).toHaveLength(1)
              expect(finished[0]).toMatchObject({
                reason: outcome === "fail" ? "error" : "abort",
                tokens: { input: 5_000, cache: { write: 175_000 } },
              })
              expect(saved.info.role === "assistant" && saved.info.cost).toBeCloseTo(expected)
              expect((yield* session.get(chat.id)).cost).toBeCloseTo(expected)
              if (guarded) {
                expect(observed).toHaveLength(2)
                expect(observed[0]).toBeCloseTo(expected)
                expect(observed[1]).toBeCloseTo(expected)
                expect(settled).toHaveLength(1)
                expect(settled[0]?.cost).toBeCloseTo(expected)
                expect(settled[0]?.complete).toBe(false)
              }
              if (!guarded) {
                expect(observed).toEqual([])
                expect(settled).toEqual([])
              }
            }),
          {
            trusted: true,
            config: {
              provider: {
                lmstudio: {
                  ...cfg.provider.lmstudio,
                  models: {
                    "test-model": {
                      ...cfg.provider.lmstudio.models["test-model"],
                      cost: { input: 3, output: 15, cache_write: 3.75 },
                    },
                  },
                },
              },
            },
          },
        ),
    )
  }
}

// The transport is the real AI SDK against the local HTTP fixture. These tests count provider requests, not just
// admission callbacks, and deliberately request SDK retries to verify guarded attempts cannot hide another call.
const admissionTurn = Effect.fn("test.admissionTurn")(function* (dir: string, sessionID: SessionID) {
  const { processors, provider } = yield* boot()
  const parent = yield* user(sessionID, "admission")
  const msg = yield* assistant(sessionID, parent.id, path.resolve(dir))
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID, model })
  return {
    handle,
    run: handle.process({
      user: {
        id: parent.id,
        sessionID,
        role: "user",
        time: parent.time,
        agent: "build",
        model: ref,
      },
      sessionID,
      model,
      agent: agent(),
      system: [],
      messages: [{ role: "user", content: "admission" }],
      tools: {},
      retries: 3,
    }),
  }
})

it.live("session admission refusal stops before the provider without a retryable error", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        const chat = yield* session.create({})
        const turn = yield* admissionTurn(dir, chat.id)
        const calls: string[] = []
        expect(
          yield* turn.run.pipe(
            Effect.provideService(SessionAdmission.Current, {
              sessionID: chat.id,
              admit: () => {
                calls.push("admit")
                return undefined
              },
            }),
          ),
        ).toBe("stop")
        expect(calls).toEqual(["admit"])
        expect(yield* llm.calls).toBe(0)
        expect(turn.handle.message.error).toBeUndefined()
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session admission settles a failed attempt before retry and disables hidden SDK retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.error(503, { error: "temporary" })
        yield* llm.text("must remain unused")
        const chat = yield* session.create({})
        const turn = yield* admissionTurn(dir, chat.id)
        const order: string[] = []
        const settled: SessionAdmission.Settlement[] = []
        expect(
          yield* turn.run.pipe(
            Effect.provideService(SessionAdmission.Current, {
              sessionID: chat.id,
              admit: () => {
                order.push("admit")
                if (settled.length) return
                return {
                  settle: (result) => {
                    order.push("settle")
                    settled.push(result)
                  },
                }
              },
            }),
          ),
        ).toBe("stop")
        expect(order).toEqual(["admit", "settle", "admit"])
        expect(settled).toEqual([{ cost: 0, context: 0, cached: 0, complete: false }])
        expect(yield* llm.calls).toBe(1)
        expect(turn.handle.message.error).toBeUndefined()
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session admission settles interrupted HTTP work exactly once and isolates unrelated sessions", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.push(raw({ head: [], hang: true }))
        yield* llm.push(reply().text("unrelated").usage({ input: 10, output: 1 }).stop())
        const chat = yield* session.create({})
        const other = yield* session.create({})
        const turn = yield* admissionTurn(dir, chat.id)
        const unrelated = yield* admissionTurn(dir, other.id)
        const settled: SessionAdmission.Settlement[] = []
        const admitted: string[] = []
        const policy: SessionAdmission.Policy = {
          sessionID: chat.id,
          admit: (request) => {
            admitted.push(request.messageID)
            return { settle: (result) => settled.push(result) }
          },
        }
        const fiber = yield* turn.run.pipe(Effect.provideService(SessionAdmission.Current, policy), Effect.forkChild)
        yield* llm.wait(1)
        expect(yield* unrelated.run.pipe(Effect.provideService(SessionAdmission.Current, policy))).toBe("continue")
        yield* Fiber.interrupt(fiber)
        expect(admitted).toHaveLength(1)
        expect(settled).toHaveLength(1)
        expect(settled[0]).toMatchObject({ cost: 0, complete: false })
        expect(yield* llm.calls).toBe(2)
        yield* llm.push(reply().text("ordinary").usage({ input: 10, output: 1 }).stop())
        const ordinary = yield* admissionTurn(dir, chat.id)
        expect(yield* ordinary.run).toBe("continue")
        expect(admitted).toHaveLength(1)
        expect(settled).toHaveLength(1)
        expect(yield* llm.calls).toBe(3)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session admission settles reported complete usage once despite persisted snapshot updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { session } = yield* boot()
        yield* llm.push(reply().text("complete").usage({ input: 10, output: 1 }).stop())
        const chat = yield* session.create({})
        const turn = yield* admissionTurn(dir, chat.id)
        const settled: SessionAdmission.Settlement[] = []
        expect(
          yield* turn.run.pipe(
            Effect.provideService(SessionAdmission.Current, {
              sessionID: chat.id,
              admit: () => ({ settle: (result) => settled.push(result) }),
            }),
          ),
        ).toBe("continue")
        expect(settled).toHaveLength(1)
        expect(settled[0]).toMatchObject({ complete: true, context: 10, cost: 0, usage: { totalTokens: 11 } })
        expect(yield* llm.calls).toBe(1)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)

// The doom-loop check asks the session's agent (build's defaults ask doom_loop), so the pending asks show it.
const itAsks = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      Permission.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    replacements,
  ),
)

// One assistant step that makes the same terminal call three times, answered by a stand-in terminal tool.
const repeatTerminal = Effect.fn("test.repeatTerminal")(function* (
  dir: string,
  llm: TestLLMServer["Service"],
  input: Record<string, string>,
) {
  const { processors, session, provider } = yield* boot()
  yield* llm.push(reply().tool("terminal", input).tool("terminal", input).tool("terminal", input))
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, "terminal")
  const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const run = yield* handle
    .process({
      user: {
        id: parent.id,
        sessionID: chat.id,
        role: "user",
        time: parent.time,
        agent: parent.agent,
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent: agent(),
      system: [],
      messages: [{ role: "user", content: "terminal" }],
      tools: {
        terminal: tool({
          description: "Terminal",
          inputSchema: z.object({ action: z.string(), id: z.string(), text: z.string().optional() }),
          execute: async () => ({ title: "Terminal", output: "cursor=0", metadata: {} }),
        }),
      },
    })
    .pipe(Effect.forkChild)
  return { run, msg }
})

itAsks.live("session.processor polling a terminal with the same call is progress, not a doom loop", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const polled = yield* repeatTerminal(dir, llm, { action: "read", id: "pty_1" })
        expect(yield* Fiber.join(polled.run)).toBe("continue")
        expect(yield* permission.list()).toEqual([])
        const parts = yield* MessageV2.parts(polled.msg.id)
        expect(parts.filter((part) => part.type === "tool" && part.state.status === "completed")).toHaveLength(3)

        // The same input typed three times is not polling: it still asks.
        const typed = yield* repeatTerminal(dir, llm, { action: "type", id: "pty_1", text: "y" })
        const asked = yield* waitFor(
          permission.list().pipe(Effect.map((list) => list.find((item) => item.permission === "doom_loop"))),
          "doom_loop was not asked",
        )
        expect(asked.patterns).toEqual(["terminal"])
        yield* permission.reply({ requestID: asked.id, reply: "once" })
        yield* Fiber.join(typed.run)
      }),
    { trusted: true, config: (url) => providerCfg(url) },
  ),
)
