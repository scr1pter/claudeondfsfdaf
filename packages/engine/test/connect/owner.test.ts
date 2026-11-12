import { afterEach, expect } from "bun:test"
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Npm } from "@vectordevai/core/npm"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Auth } from "@/auth"
import { ConnectOwner } from "@/connect/owner"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowOwnerHandoffFailure } from "@/orchestration/owner-failure"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { NpmTest } from "../fake/npm"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

interface Probe {
  entered: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
  joining: Deferred.Deferred<void>
  fail: boolean
  exits: Exit.Exit<SessionV1.WithParts>[]
}
const control: { current?: Probe } = {}
const replacements: LayerNode.Replacements = [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true })],
  [Auth.node, Layer.mock(Auth.Service)({ all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) })],
  [Npm.node, NpmTest.noop],
]

// Decorate the real runner to observe the human waiter; its production state machine and work are unchanged.
const runner = Layer.effect(
  SessionRunState.Service,
  Effect.gen(function* () {
    const original = yield* SessionRunState.Service
    return SessionRunState.Service.of({
      ...original,
      ensureRunning: (id, interrupted, work) =>
        Effect.gen(function* () {
          const probe = control.current
          const waiting = yield* original
            .ensureRunning(id, interrupted, work)
            .pipe(Effect.forkChild({ startImmediately: true }))
          if (probe) yield* Deferred.succeed(probe.joining, undefined)
          return yield* Fiber.join(waiting).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                probe?.exits.push(exit)
              }),
            ),
          )
        }),
    })
  }),
).pipe(Layer.provide(AppNodeBuilderV1.build(SessionRunState.node, replacements)))
const withRunner = replacements.concat([[SessionRunState.node, runner]])
const prompt = Layer.effect(
  SessionPrompt.Service,
  Effect.gen(function* () {
    const original = yield* SessionPrompt.Service
    return SessionPrompt.Service.of({
      ...original,
      currentModel: (id, configured) =>
        Effect.gen(function* () {
          const probe = control.current
          if (probe) {
            yield* Deferred.succeed(probe.entered, undefined)
            yield* Deferred.await(probe.release)
            if (probe.fail) return yield* Effect.die(new Error("Fixture owner model resolution failed."))
          }
          return yield* original.currentModel(id, configured)
        }),
    })
  }),
).pipe(Layer.provide(AppNodeBuilderV1.build(SessionPrompt.node, withRunner)))

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilderV1.build(
      LayerNode.group([ConnectOwner.node, SessionPrompt.node, Session.node, Permission.node, CrossSpawnSpawner.node]),
      withRunner.concat([[SessionPrompt.node, prompt]]),
    ),
    testInstanceStoreLayer,
    TestLLMServer.layer,
  ).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ VECTOR_DISABLE_DEFAULT_PLUGINS: true, VECTOR_DISABLE_MODELS_FETCH: true }),
      ),
    ),
  ),
)

afterEach(async () => {
  delete control.current
  await disposeAllInstances()
  await resetDatabase()
})

for (const fail of [false, true])
  it.live(
    `a concurrent human gets its own turn after owner model resolution ${fail ? "fails" : "succeeds"}`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({
          trusted: true,
          config: { ...testProviderConfig(llm.url), model: "lmstudio/test-model", permission: { connect: "ask" } },
        })
        yield* provideInstance(directory)(
          Effect.gen(function* () {
            const owner = yield* ConnectOwner.Service
            const prompts = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const permissions = yield* Permission.Service
            const probe: Probe = {
              entered: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
              joining: yield* Deferred.make<void>(),
              fail,
              exits: [],
            }
            control.current = probe
            yield* Effect.addFinalizer(() => Deferred.succeed(probe.release, undefined))
            const session = yield* sessions.create({ title: "Owner/human runner regression" })
            const started = yield* owner.review(session.id, { background: false }).pipe(Effect.exit, Effect.forkChild)
            yield* awaitWithTimeout(
              Deferred.await(probe.entered),
              "Owner never reached model resolution.",
              "10 seconds",
            )
            const text = "Answer this NEWER human message in its own turn."
            const answer = "The newer human message was answered."
            yield* llm.text(answer)
            const human = yield* prompts
              .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text }] })
              .pipe(Effect.forkChild)
            yield* awaitWithTimeout(
              Deferred.await(probe.joining),
              "The human never joined the owner runner.",
              "10 seconds",
            )
            const savedHuman = yield* pollWithTimeout(
              sessions
                .messages({ sessionID: session.id })
                .pipe(
                  Effect.map((messages) =>
                    messages.find(
                      (message) =>
                        message.info.role === "user" &&
                        message.parts.some((part) => part.type === "text" && part.text === text),
                    ),
                  ),
                ),
              "The newer human input was not persisted.",
            )
            yield* Deferred.succeed(probe.release, undefined)
            if (!fail) {
              const ask = yield* pollWithTimeout(
                permissions
                  .list()
                  .pipe(Effect.map((pending) => pending.find((entry) => entry.permission === "connect"))),
                "The owner review never reached its approval.",
              )
              expect(yield* llm.inputs).toHaveLength(0)
              yield* permissions.reply({ requestID: ask.id, reply: "once" })
            }
            const owned = yield* Fiber.join(started)
            expect(Exit.isFailure(owned)).toBe(fail)
            const response = yield* awaitWithTimeout(
              Fiber.join(human),
              "The newer human input lost its own model turn.",
              "10 seconds",
            )
            expect(response.info.role).toBe("assistant")
            if (response.info.role === "assistant") {
              expect(response.info.parentID).toBe(savedHuman.info.id)
              expect(response.info.error).toBeUndefined()
            }
            expect(response.parts.some((part) => part.type === "text" && part.text.includes(answer))).toBe(true)
            // Prove this exercised an actual join, rather than merely starting the human after the owner finished.
            const joined = probe.exits[0]
            expect(joined).toBeDefined()
            if (fail) {
              expect(
                joined && Exit.isFailure(joined) && Cause.squash(joined.cause) instanceof WorkflowOwnerHandoffFailure,
              ).toBe(true)
            } else {
              expect(
                joined &&
                  Exit.isSuccess(joined) &&
                  joined.value.parts.some(
                    (part) =>
                      part.type === "tool" &&
                      part.state.status !== "pending" &&
                      part.state.metadata?.[WorkflowMarkers.OWNER_START] === true,
                  ),
              ).toBe(true)
            }
            expect(yield* permissions.list()).toEqual([])
          }),
        )
      }),
    30_000,
  )
