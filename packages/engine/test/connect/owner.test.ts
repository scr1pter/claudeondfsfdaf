import { afterEach, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import os from "node:os"
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { Node } from "@vectordevai/core/effect/app-node"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Npm } from "@vectordevai/core/npm"
import type { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Hands } from "@vectordevai/schema/hands"
import { Auth } from "@/auth"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectDirectory } from "@/connect/directory"
import { ConnectOwner } from "@/connect/owner"
import { ConnectHub } from "@/connect/hub"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowOwnerHandoffFailure } from "@/orchestration/owner-failure"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { NpmTest } from "../fake/npm"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { connectConsentMember } from "../fixture/connect-consent-member"
import { noSweep } from "../fixture/connect-sweep"

interface Probe {
  entered: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
  joining: Deferred.Deferred<void>
  fail: boolean
  exits: Exit.Exit<SessionV1.WithParts>[]
}
const control: { current?: Probe; ownerStarts: number } = { ownerStarts: 0 }
const listOnlyMember: ConnectAdapter.Adapter = {
  id: Hands.ID,
  owner: "hands",
  describe: () => Effect.die(new Error("The owner must not probe a list-only hand-off.")),
}
const replacements: LayerNode.Replacements = [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true })],
  [Auth.node, Layer.mock(Auth.Service)({ all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) })],
  [Npm.node, NpmTest.noop],
  // This regression owns model-resolution/runner arbitration, not Linux-only VectorScope execution.
  [ConnectHub.node, ConnectHub.nodeWith([connectConsentMember, listOnlyMember])],
]

// Decorate the real runner to observe the human waiter; its production state machine and work are unchanged.
const runner = Layer.effect(
  SessionRunState.Service,
  Effect.gen(function* () {
    const original = yield* SessionRunState.Service
    return SessionRunState.Service.of({
      ...original,
      startRunning: (id, interrupted, work) =>
        Effect.sync(() => {
          control.ownerStarts++
        }).pipe(Effect.andThen(original.startRunning(id, interrupted, work))),
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

// The real audience over the test's database, except that a test can make the owner's isolation fence fail or skip it.
const fence: { mode?: "fail" | "skip" } = {}
const fencedAudience = Node.makeGlobalNode({
  service: SessionAudience.Service,
  layer: Layer.effect(
    SessionAudience.Service,
    Effect.map(Database.Service, (database) => {
      const real = SessionAudience.make(database)
      return SessionAudience.Service.of({
        ...real,
        fenceIsolation: (input) =>
          fence.mode === "fail"
            ? Effect.fail(new SessionAudience.Denied({ reason: "owner_required", message: "Fixture fence failure." }))
            : fence.mode === "skip"
              ? Effect.void
              : real.fenceIsolation(input),
      })
    }),
  ),
  deps: [Database.node],
})

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilderV1.build(
      LayerNode.group([
        ConnectOwner.node,
        SessionPrompt.node,
        Session.node,
        Permission.node,
        CrossSpawnSpawner.node,
        BackgroundJobStore.node,
      ]),
      withRunner.concat([
        [SessionPrompt.node, prompt],
        [SessionAudience.node, fencedAudience],
      ]),
    ),
    testInstanceStoreLayer,
    TestLLMServer.layer,
  ).pipe(
    Layer.provide(noSweep),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ VECTOR_DISABLE_DEFAULT_PLUGINS: true, VECTOR_DISABLE_MODELS_FETCH: true }),
      ),
    ),
  ),
)

// The owner's stale-snapshot sweep, replaced: each call is recorded and stays pending until it is released.
const swept: { input: Parameters<typeof ReadOnlyGit.sweepStale>[0]; release: () => void }[] = []
const fakeSweep: typeof ReadOnlyGit.sweepStale = (input) => {
  const pending = Promise.withResolvers<{ removed: number; kept: number; failed: number }>()
  swept.push({ input, release: () => pending.resolve({ removed: 0, kept: 0, failed: 0 }) })
  return pending.promise
}
const sweepGraph = (experimentalConnect: boolean) =>
  testEffect(
    AppNodeBuilderV1.build(ConnectOwner.node, [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect })],
      ...replacements.filter(([node]) => node !== RuntimeFlags.node),
    ]).pipe(
      Layer.provide(Layer.succeed(ConnectOwner.Sweep, fakeSweep)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ VECTOR_DISABLE_DEFAULT_PLUGINS: true, VECTOR_DISABLE_MODELS_FETCH: true }),
        ),
      ),
    ),
  )
const off = sweepGraph(false)
const on = sweepGraph(true)

afterEach(async () => {
  delete control.current
  control.ownerStarts = 0
  delete fence.mode
  for (const item of swept.splice(0)) item.release()
  await disposeAllInstances()
  await resetDatabase()
})

off.live(
  "with Connect off the owner starts no private Git snapshot sweep",
  () =>
    Effect.gen(function* () {
      yield* ConnectOwner.Service
      yield* Effect.sleep("200 millis")
      expect(swept).toEqual([])
    }),
  30_000,
)

off.live("with Connect off every owner read and action refuses as disabled", () =>
  Effect.gen(function* () {
    const owner = yield* ConnectOwner.Service
    // No such conversation exists: the flag is checked before any session lookup, input check or ledger write.
    const sessionID = SessionID.make("ses_connect_off")
    const target = { kind: "uncommitted" } as const
    for (const refused of [
      Effect.flip(owner.members()),
      Effect.flip(owner.runs()),
      Effect.flip(owner.get("cr_x")),
      Effect.flip(owner.cancel("cr_x")),
      Effect.flip(owner.review(sessionID, { target })),
      Effect.flip(owner.directoryReview({ target, requestKey: randomUUID() })),
      Effect.flip(owner.register({ sessionID, target, findings: [] })),
      Effect.flip(owner.dismiss("cr_x", { sessionID, findings: ["f_x"] })),
    ])
      expect(yield* refused).toMatchObject({
        code: "disabled",
        message: "Connected tools are off in this build.",
      })
  }),
)

on.live(
  "with Connect on the owner sweeps the temporary folder once without waiting for it",
  () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => swept.forEach((item) => item.release())))
      // The owner was built while the sweep is still pending, so startup never waits for it.
      yield* ConnectOwner.Service
      yield* pollWithTimeout(
        Effect.sync(() => (swept.length > 0 ? true : undefined)),
        "The owner never swept the temporary folder.",
      )
      yield* Effect.sleep("100 millis")
      expect(swept.map((item) => item.input.directory)).toEqual([os.tmpdir()])
      expect(Number.isFinite(swept[0]?.input.now)).toBe(true)
      expect(swept[0]?.input.olderThanMs).toBeUndefined()
    }),
  30_000,
)

it.live("an owner list-only refusal creates no conversation runner, transcript or ledger row", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({
      trusted: true,
      config: { ...testProviderConfig(llm.url), model: "lmstudio/test-model", permission: { connect: "ask" } },
    })
    yield* provideInstance(directory)(
      Effect.gen(function* () {
        const owner = yield* ConnectOwner.Service
        const sessions = yield* Session.Service
        const permissions = yield* Permission.Service
        const conversation = yield* sessions.create({ title: "List-only Connect" })
        for (const background of [false, true]) {
          const run = yield* owner.review(conversation.id, { to: Hands.ID, background })
          expect(run.result).toMatchObject({
            state: "refused",
            refusal: "unknown",
            summary: "computer is only listed; connect cannot hand work to it.",
          })
        }
        expect(control.ownerStarts).toBe(0)
        expect(yield* sessions.messages({ sessionID: conversation.id })).toEqual([])
        expect(yield* owner.runs(conversation.id)).toEqual([])
        expect(yield* permissions.list()).toEqual([])
        expect(yield* llm.inputs).toEqual([])
      }),
    )
  }),
)

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

for (const mode of ["fail", "skip"] as const)
  it.live(
    `a start that ${mode === "fail" ? "fails its owner fence" : "the hub refuses before the binding gate"} tombstones its key, so a retry answers consumed`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({
          trusted: true,
          config: { ...testProviderConfig(llm.url), model: "lmstudio/test-model", permission: { connect: "ask" } },
        })
        fence.mode = mode
        yield* provideInstance(directory)(
          Effect.gen(function* () {
            const owner = yield* ConnectOwner.Service
            const sessions = yield* Session.Service
            const permissions = yield* Permission.Service
            const jobs = yield* BackgroundJobStore.Service
            const input = { requestKey: randomUUID() }
            const first = yield* owner.directoryReview(input).pipe(Effect.flip)
            expect(first.code).toBe(mode === "fail" ? "forbidden" : "invalid")
            if (mode === "skip") expect(first.message).toContain("private execution authority")
            const retry = yield* owner
              .directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() })
              .pipe(Effect.flip)
            expect(retry.code).toBe("consumed")
            expect(retry.message).toBe("This review start did not complete and no review ran. Start a new review.")
            const anchors = (yield* sessions.list({ internal: true, roots: true })).filter(
              (row) => row.internal === ConnectDirectory.INTERNAL,
            )
            expect(anchors).toHaveLength(1)
            expect(yield* jobs.forParent(anchors[0].id)).toEqual([])
            expect(yield* permissions.list()).toEqual([])
            expect(yield* llm.inputs).toHaveLength(0)
          }),
        )
      }),
    30_000,
  )
