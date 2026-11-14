import { describe, expect } from "bun:test"
import path from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import { Context, Effect, Layer, Result, Stream } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { ModelV2 } from "@vectordevai/core/model"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ReviewMemoryFence } from "@vectordevai/core/review/memory-fence"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class Vendor extends Context.Service<
  Vendor,
  {
    url: string
    text: (value: string) => Effect.Effect<void>
    calls: Effect.Effect<number>
  }
>()("@test/LLMMemoryFenceVendor") {}

class Probe extends Context.Service<
  Probe,
  {
    server: Vendor["Service"]
    loads: number
    hooks: number
    permits: number
    line: boolean
    language: Effect.Effect<void>
    headers: Effect.Effect<void>
    permit: Effect.Effect<void>
  }
>()("@test/LLMMemoryFence") {}

const server = LayerNode.make({
  service: Vendor,
  layer: Layer.effect(
    Vendor,
    Effect.gen(function* () {
      const queued: string[] = []
      let calls = 0
      const listener = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              calls++
              const text = queued.shift()
              if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses" || text === undefined)
                return new Response("Unexpected fixture request", { status: 500 })
              // Match the explicit Responses wire fixtures used by the existing
              // native transport tests; optional numeric details stay numeric.
              const events = [
                {
                  type: "response.created",
                  sequence_number: 1,
                  response: { id: "resp_fixture", created_at: 1, model: "gpt-5.2", service_tier: null },
                },
                {
                  type: "response.output_item.added",
                  sequence_number: 2,
                  output_index: 0,
                  item: { type: "message", id: "msg_fixture" },
                },
                {
                  type: "response.output_text.delta",
                  sequence_number: 3,
                  item_id: "msg_fixture",
                  delta: text,
                  logprobs: null,
                },
                {
                  type: "response.output_item.done",
                  sequence_number: 4,
                  output_index: 0,
                  item: { type: "message", id: "msg_fixture" },
                },
                {
                  type: "response.completed",
                  sequence_number: 5,
                  response: {
                    incomplete_details: null,
                    service_tier: null,
                    usage: {
                      input_tokens: 1,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens: 1,
                      output_tokens_details: { reasoning_tokens: 0 },
                    },
                  },
                },
              ]
              return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "content-type": "text/event-stream" },
              })
            },
          }),
        ),
        (listener) =>
          Effect.promise(async () => {
            await listener.stop(true)
          }),
      )
      return {
        url: `${listener.url.origin}/v1`,
        text: (value: string) =>
          Effect.sync(() => {
            queued.push(value)
          }),
        calls: Effect.sync(() => calls),
      }
    }),
  ),
  deps: [],
})
const probe = LayerNode.make({
  service: Probe,
  layer: Layer.effect(
    Probe,
    Effect.gen(function* () {
      return {
        server: yield* Vendor,
        loads: 0,
        hooks: 0,
        permits: 0,
        line: false,
        language: Effect.void,
        headers: Effect.void,
        permit: Effect.void,
      }
    }),
  ),
  deps: [server],
})

const provider = LayerNode.make({
  service: Provider.Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* Probe
      return Layer.mock(Provider.Service, {
        getLanguage: () =>
          Effect.gen(function* () {
            state.loads++
            yield* state.language
            return createOpenAI({ apiKey: "loopback-fixture", baseURL: state.server.url }).responses("gpt-5.2")
          }),
        getProvider: () =>
          Effect.succeed({
            id: ProviderV2.ID.openai,
            name: "Loopback fixture",
            source: "config",
            env: [],
            options: { apiKey: "loopback-fixture", baseURL: state.server.url },
            models: {},
          }),
        line: () =>
          Effect.sync(() =>
            state.line
              ? { origin: new URL(state.server.url).origin, permits: 1, hosted: true, local: true }
              : undefined,
          ),
      })
    }),
  ),
  deps: [probe],
})

const plugin = LayerNode.make({
  service: Plugin.Service,
  layer: Layer.effect(
    Plugin.Service,
    Effect.gen(function* () {
      const state = yield* Probe
      return Plugin.Service.of({
        trigger: (name, _input, output) =>
          Effect.gen(function* () {
            state.hooks++
            if (name === "chat.headers") yield* state.headers
            return output
          }),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      })
    }),
  ),
  deps: [probe],
})

const slots = LayerNode.make({
  service: ModelSlots.Service,
  tag: ModelSlots.node.tag,
  layer: Layer.effect(
    ModelSlots.Service,
    Effect.gen(function* () {
      const state = yield* Probe
      return ModelSlots.Service.of({
        ...ModelSlots.make(),
        take: () =>
          Effect.gen(function* () {
            state.permits++
            yield* state.permit
          }),
      })
    }),
  ),
  deps: [probe],
})

const root = LayerNode.group([
  LLM.node,
  Session.node,
  SessionProjector.node,
  EventV2Bridge.node,
  Database.node,
  CrossSpawnSpawner.node,
  probe,
])

function graph(native: boolean, filename = ":memory:") {
  return AppNodeBuilder.build(root, [
    [Database.node, Database.layerFromPath(filename)],
    [Provider.node, provider],
    [Plugin.node, plugin],
    [ModelSlots.node, slots],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: native, disableDefaultPlugins: true })],
  ])
}

function input(sessionID: string): LLM.StreamInput {
  const model = {
    id: ModelV2.ID.make("gpt-5.2"),
    providerID: ProviderV2.ID.openai,
    api: { id: "gpt-5.2", url: "http://127.0.0.1/v1", npm: "@ai-sdk/openai" },
    name: "Loopback fixture",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 1024 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } satisfies Provider.Model
  return {
    sessionID,
    model,
    user: {
      id: MessageID.ascending(),
      sessionID: SessionID.make(sessionID),
      role: "user",
      time: { created: 1 },
      agent: "fixture",
      model: { providerID: model.providerID, modelID: model.id },
    },
    agent: { name: "fixture", mode: "primary", options: {}, permission: [] },
    system: [],
    messages: [{ role: "user", content: "Synthetic fixture" }],
    tools: {},
  }
}

// Instance discovery has its own database; real Session creation below uses
// this graph's isolated database, including its project foreign key.
const createSession = Effect.fnUntraced(function* (input: Parameters<Session.Interface["create"]>[0] = {}) {
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die("InstanceRef not provided")
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: instance.project.id, worktree: AbsolutePath.make(instance.worktree), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  const sessions = yield* Session.Service
  return yield* sessions.create(input)
})

function refused<A, R>(effect: Effect.Effect<A, unknown, R>) {
  return Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewMemoryFence.Refused)
      if (result.failure instanceof ReviewMemoryFence.Refused)
        expect(result.failure.message).toBe("The review memory history boundary is unavailable.")
    }
  })
}

for (const native of [false, true]) {
  const it = testEffect(graph(native))
  describe(`legacy LLM memory fence (${native ? "native" : "ai-sdk"})`, () => {
    it.instance("an ordinary real Session reaches only the loopback vendor", () =>
      Effect.gen(function* () {
        const llm = yield* LLM.Service
        const state = yield* Probe
        const ordinary = yield* createSession()
        yield* state.server.text("fixture accepted")
        const events = yield* llm.stream(input(ordinary.id)).pipe(Stream.runCollect)
        expect(events.some((event) => event.type === "finish")).toBe(true)
        expect(state.loads).toBe(1)
        expect(yield* state.server.calls).toBe(1)
      }),
    )

    it.instance("unknown, malformed and permanently fenced Sessions refuse before provider preparation", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const llm = yield* LLM.Service
        const state = yield* Probe
        const blocked = yield* createSession()
        yield* ReviewMemoryFence.make(database.db).mark(blocked.id)
        for (const id of ["ses_unregistered_fixture", "ses_invalid/fixture", blocked.id])
          yield* refused(llm.stream(input(id)).pipe(Stream.runDrain))
        expect(state.loads).toBe(0)
        expect(state.hooks).toBe(0)
        expect(yield* state.server.calls).toBe(0)
      }),
    )

    it.instance("deferred consumption classifies the construction-time primitive Session ID", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const llm = yield* LLM.Service
        const state = yield* Probe
        const original = yield* createSession()
        const ordinary = yield* createSession()
        const request = input(original.id)
        const stream = llm.stream(request)
        yield* ReviewMemoryFence.make(database.db).mark(original.id)
        request.sessionID = ordinary.id
        yield* refused(stream.pipe(Stream.runDrain))
        expect(state.loads).toBe(0)
        expect(yield* state.server.calls).toBe(0)

        const allowed = input(ordinary.id)
        const pinned = llm.stream(allowed)
        allowed.sessionID = original.id
        yield* state.server.text("fixture accepted")
        yield* pinned.pipe(Stream.runDrain)
        expect(yield* state.server.calls).toBe(1)
      }),
    )

    for (const boundary of ["language", "headers"] as const)
      it.instance(`a fence committed during awaited ${boundary} preparation prevents transport`, () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const llm = yield* LLM.Service
          const state = yield* Probe
          const ordinary = yield* createSession()
          state[boundary] = ReviewMemoryFence.make(database.db).mark(ordinary.id).pipe(Effect.orDie)
          yield* refused(llm.stream(input(ordinary.id)).pipe(Stream.runDrain))
          expect(state.loads).toBe(1)
          expect(yield* state.server.calls).toBe(0)
        }),
      )

    it.instance("real history forks retain the fence after metadata replacement and source deletion", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const llm = yield* LLM.Service
        const state = yield* Probe
        const source = yield* createSession({ metadata: { fixture: "source" } })
        const message = yield* sessions.updateMessage(input(source.id).user)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: source.id,
          type: "text",
          text: "Synthetic retained history",
        })
        const fork = yield* sessions.fork({ sessionID: source.id })
        const child = yield* sessions.create({ parentID: source.id })
        expect(fork.parentID).toBeUndefined()
        expect(JSON.stringify(yield* sessions.messages({ sessionID: fork.id }))).toContain("Synthetic retained history")
        yield* ReviewMemoryFence.make(database.db).mark(source.id)
        yield* sessions.setMetadata({ sessionID: source.id, metadata: {} })
        yield* sessions.setMetadata({ sessionID: fork.id, metadata: { reviewMemory: false } })
        yield* refused(llm.stream(input(child.id)).pipe(Stream.runDrain))
        yield* sessions.remove(source.id)
        yield* refused(llm.stream(input(fork.id)).pipe(Stream.runDrain))
        yield* refused(llm.stream(input(source.id)).pipe(Stream.runDrain))
        expect(state.loads).toBe(0)
        expect(yield* state.server.calls).toBe(0)
      }),
    )

    it.instance("corrupt durable fence rows fail closed", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const llm = yield* LLM.Service
        const state = yield* Probe
        const ordinary = yield* createSession()
        yield* ReviewMemoryFence.make(database.db).mark(ordinary.id)
        yield* database.db.run(sql`UPDATE review_memory_fence SET version = 0`)
        yield* refused(llm.stream(input(ordinary.id)).pipe(Stream.runDrain))
        expect(state.loads).toBe(0)
        expect(yield* state.server.calls).toBe(0)
      }),
    )
  })
}

const native = testEffect(graph(true))
native.instance("native transport rechecks after its deferred permit wait", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const llm = yield* LLM.Service
    const state = yield* Probe
    const ordinary = yield* createSession()
    state.line = true
    state.permit = ReviewMemoryFence.make(database.db).mark(ordinary.id).pipe(Effect.orDie)
    yield* refused(llm.stream(input(ordinary.id)).pipe(Stream.runDrain))
    expect(state.permits).toBe(1)
    expect(yield* state.server.calls).toBe(0)
  }),
)

const reopen = testEffect(Layer.empty)
for (const native of [false, true])
  reopen.instance(`a fresh ${native ? "native" : "ai-sdk"} graph reopens the actual durable fence`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const filename = path.join(instance.directory, "llm-memory-fence.sqlite")
      const id = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const source = yield* createSession()
        const fork = yield* sessions.fork({ sessionID: source.id })
        yield* ReviewMemoryFence.make(database.db).mark(source.id)
        yield* sessions.remove(source.id)
        return fork.id
      }).pipe(Effect.provide(graph(native, filename)), Effect.scoped)
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const llm = yield* LLM.Service
        const state = yield* Probe
        expect((yield* sessions.get(id)).id).toBe(id)
        yield* refused(llm.stream(input(id)).pipe(Stream.runDrain))
        expect(state.loads).toBe(0)
        expect(yield* state.server.calls).toBe(0)
      }).pipe(Effect.provide(graph(native, filename)), Effect.scoped)
    }),
  )
