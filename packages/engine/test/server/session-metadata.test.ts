import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Agent } from "@/agent/agent"
import type { SubagentRecord } from "@/agent/subagent-kind"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { SessionApi, SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

type ReadGate = {
  sessionID: SessionID
  read: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
  claimed: boolean
}

class PatchGate extends Context.Service<PatchGate, { current?: ReadGate }>()("MetadataTest.PatchGate") {}
const gateLayer = Layer.sync(PatchGate, () => ({}))
const services = AppNodeBuilder.build(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    InstanceStore.node,
    CrossSpawnSpawner.node,
    EventV2Bridge.node,
    ShareNext.node,
    Database.node,
    SessionAudience.node,
  ]),
  [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })]],
)

// Observe only the production handler's initial read. Lifecycle updates below use the actual service directly.
const observedSession = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const real = yield* Session.Service
    const gate = yield* PatchGate
    return Session.Service.of({
      ...real,
      get: (id) =>
        Effect.gen(function* () {
          const info = yield* real.get(id)
          const held = gate.current
          if (held && held.sessionID === id && !held.claimed) {
            held.claimed = true
            yield* Deferred.succeed(held.read, undefined)
            yield* Deferred.await(held.release)
          }
          return info
        }),
    })
  }),
)

const TestApi = HttpApi.make("vector-instance").addHttpApi(SessionApi)
const middleware = Layer.mergeAll(
  schemaErrorLayer,
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect),
  ),
  instanceContextLayer,
  Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* effect.pipe(
          Effect.provideService(WorkspaceRouteContext, {
            directory: request.headers["x-vector-directory"] ?? process.cwd(),
          }),
        )
      }),
    ),
  ),
)

const unrelated = Layer.mergeAll(
  Layer.mock(SessionShare.Service)({}),
  Layer.mock(PublicSessionShare.Service)({}),
  Layer.mock(Config.Service)({}),
  Layer.mock(SessionPrompt.Service)({}),
  Layer.mock(SessionRevert.Service)({}),
  Layer.mock(SessionCompaction.Service)({}),
  Layer.mock(SessionRunState.Service)({}),
  Layer.mock(Agent.Service)({}),
  Layer.mock(Permission.Service)({}),
  Layer.mock(SessionStatus.Service)({}),
  Layer.mock(Todo.Service)({}),
  Layer.mock(SessionSummary.Service)({}),
  Layer.mock(Provider.Service)({}),
  Layer.mock(FreeModelGuests.Service)({}),
)

const served = HttpRouter.serve(
  HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(sessionHandlers.pipe(Layer.provide(observedSession))),
    Layer.provide([unrelated, middleware]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(services), Layer.provideMerge(gateLayer))
const it = testEffect(served)

const patch = (sessionID: SessionID, metadata: Record<string, unknown>, directory: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.patch(SessionPaths.update.replace(":sessionID", sessionID)).pipe(
      HttpClientRequest.setHeader("x-vector-directory", directory),
      HttpClientRequest.bodyJson({ metadata }),
      Effect.flatMap(HttpClient.execute),
    )
    expect(response.status).toBe(200)
    return (yield* response.json) as Session.Info
  })

it.instance("PATCH cannot add a forged lifecycle record to an ordinary session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const session = yield* sessions.create({ metadata: { previous: true } })
    const updated = yield* patch(
      session.id,
      { public: "next", subagent: { ownedPaths: ["**"], status: "running" } },
      test.directory,
    )
    expect(updated.metadata).toEqual({ public: "next" })
    expect((yield* sessions.get(session.id)).metadata).toEqual({ public: "next" })
  }),
)

it.instance("PATCH cannot modify or remove any raw stored lifecycle value", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const values: unknown[] = [
      { version: 999, opaque: { future: ["retained"] } },
      null,
      false,
      "legacy lifecycle value",
      ["legacy", "array"],
    ]
    for (const raw of values) {
      const session = yield* sessions.create({ metadata: { previous: true, subagent: raw } })
      for (const metadata of [
        { public: "next", subagent: { forged: true } },
        { public: "next" },
        { public: "next", subagent: null },
      ]) {
        const updated = yield* patch(session.id, metadata, test.directory)
        expect(updated.metadata).toEqual({ public: "next", subagent: raw })
        expect((yield* sessions.get(session.id)).metadata).toEqual({ public: "next", subagent: raw })
      }
    }
  }),
)

it.instance("PATCH preserves a lifecycle update made after its initial requireSession read", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const gate = yield* PatchGate
    const record: SubagentRecord = {
      kind: "subagent",
      agent: "general",
      custom: false,
      title: "Fixture task",
      parentSessionID: SessionID.descending(),
      parentMessageID: MessageID.ascending(),
      model: { providerID: "fixture", modelID: "fixture" },
      background: true,
      status: "running",
      startedAt: Date.now(),
      attempt: 1,
    }
    const session = yield* sessions.create({ metadata: { public: "before", subagent: record } })
    const read = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    gate.current = { sessionID: session.id, read, release, claimed: false }
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
    const response = yield* patch(session.id, { public: "after", subagent: { attempt: 0 } }, test.directory).pipe(
      Effect.forkScoped,
    )
    yield* awaitWithTimeout(Deferred.await(read), "PATCH did not reach its initial session read")
    yield* SubagentLifecycle.write(sessions, session.id, { status: "completed", completedAt: 123, attempt: 2 })
    const latest = (yield* sessions.get(session.id)).metadata?.subagent
    expect(latest).toMatchObject({ status: "completed", completedAt: 123, attempt: 2 })
    yield* Deferred.succeed(release, undefined)
    const updated = yield* Fiber.join(response)
    expect(updated.metadata).toEqual({ public: "after", subagent: latest })
    expect((yield* sessions.get(session.id)).metadata).toEqual({ public: "after", subagent: latest })
    gate.current = undefined
  }),
)
