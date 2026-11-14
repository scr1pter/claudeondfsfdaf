import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import { ApplicationTools } from "../../src/tool/application-tools"
import { Credential } from "../../src/credential"
import { Database } from "../../src/database/database"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { EventV2 } from "../../src/event"
import { Location } from "../../src/location"
import { ModelV2 } from "../../src/model"
import { PluginInternal } from "../../src/plugin/internal"
import { ProjectV2 } from "../../src/project"
import { ReviewMemoryFence } from "../../src/review/memory-fence"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { FreeModelsResume } from "../../src/session/free-model-resume"
import { SessionMessage } from "../../src/session/message"
import { SessionProjector } from "../../src/session/projector"
import { SessionRunner } from "../../src/session/runner"
import { node } from "../../src/session/runner/llm"
import { SessionSchema } from "../../src/session/schema"
import { SessionStore } from "../../src/session/store"
import { tmpdir } from "../fixture/tmpdir"

// Actual execution coordinator, Location routing, Session/Event/Projector and
// SQL fences. Only downstream ready/runner/continuation ports record calls;
// these tests perform no model, credential, entitlement or financial work.
function fixture(filename = ":memory:") {
  const calls: string[] = []
  const runs: SessionSchema.ID[] = []
  const requests: FreeModelsResume.Input[] = []
  const state: { ready: Effect.Effect<void>; prepare: Effect.Effect<void> } = {
    ready: Effect.void,
    prepare: Effect.void,
  }
  const plugins = Layer.succeed(PluginInternal.Service, {
    ready: Effect.suspend(() => {
      calls.push("ready")
      return state.ready
    }),
  })
  const runner = Layer.succeed(SessionRunner.Service, {
    run: (input) =>
      Effect.sync(() => {
        calls.push("run")
        runs.push(input.sessionID)
      }),
  })
  const resume = Layer.succeed(FreeModelsResume.Service, {
    prepare: (input) =>
      Effect.suspend(() => {
        calls.push("prepare")
        requests.push(input)
        return state.prepare
      }),
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Credential.node,
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionExecution.node,
    ]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [
        ProjectV2.node,
        Layer.succeed(ProjectV2.Service, {
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      ],
      [SessionExecution.node, SessionExecutionLocal.node],
      [PluginInternal.node, plugins],
      [node, runner],
      [FreeModelsResume.node, resume],
    ],
  )
  return { layer, calls, runs, requests, state }
}

function failure<A, E>(effect: Effect.Effect<A, E>) {
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

const request = (sessionID: SessionSchema.ID): FreeModelsResume.Input => ({
  sessionID,
  messageID: SessionMessage.ID.create(),
  modelID: ModelV2.ID.make("synthetic-memory-fence-test"),
})

describe("Core local execution refuses fenced history", () => {
  test("a genuine ordinary Session still reaches ready, continuation preparation and its runner", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const created = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        })
        yield* execution.resume(created.id)
        yield* execution.resumeFreeModels(request(created.id))
        expect(probe.calls).toEqual(["ready", "run", "ready", "prepare", "ready", "run"])
        expect(probe.runs).toEqual([created.id, created.id])
        expect(probe.requests.map((input) => input.sessionID)).toEqual([created.id])
        expect((yield* execution.active).size).toBe(0)
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("fenced and unknown Sessions reach no ready, preparation or runner callback", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const database = yield* Database.Service
        const created = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        })
        yield* ReviewMemoryFence.make(database.db).mark(created.id)
        for (const sessionID of [created.id, SessionSchema.ID.make("ses_unregistered_execution")]) {
          yield* failure(execution.resume(sessionID))
          yield* failure(execution.resumeFreeModels(request(sessionID)))
        }
        yield* database.db.run(sql`UPDATE review_memory_fence SET version = 0`)
        yield* failure(execution.resume(created.id))
        yield* failure(execution.resumeFreeModels(request(created.id)))
        expect(probe.calls).toEqual([])
        expect(probe.requests).toEqual([])
        expect((yield* execution.active).size).toBe(0)
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("a source's deleted row or replaced metadata does not clear a descendant's denial", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const database = yield* Database.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
        const parent = yield* sessions.create({ location })
        const child = yield* sessions.create({ location, parentID: parent.id })
        const sibling = yield* sessions.create({ location })
        yield* ReviewMemoryFence.make(database.db).mark(parent.id)
        yield* database.db.run(sql`UPDATE session SET metadata = '{}', internal = NULL WHERE id = ${child.id}`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = ${parent.id}`)
        yield* failure(execution.resume(child.id))
        yield* failure(execution.resumeFreeModels(request(child.id)))
        expect(probe.calls).toEqual([])
        yield* execution.resume(sibling.id)
        expect(probe.calls).toEqual(["ready", "run"])
        expect(probe.runs).toEqual([sibling.id])
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("marking during the real plugin-ready wait refuses before runner and preparation", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const database = yield* Database.Service
        const created = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.state.ready = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
        const running = yield* execution.resumeFreeModels(request(created.id)).pipe(Effect.forkChild)
        yield* Effect.raceFirst(Deferred.await(entered), Fiber.join(running))
        yield* ReviewMemoryFence.make(database.db).mark(created.id)
        yield* Deferred.succeed(release, undefined)
        yield* failure(Fiber.join(running))
        expect(probe.calls).toEqual(["ready"])
        expect(probe.requests).toEqual([])
        expect(probe.runs).toEqual([])
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("a mark during continuation preparation blocks the following production drain", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const database = yield* Database.Service
        const created = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        })
        probe.state.prepare = ReviewMemoryFence.make(database.db).mark(created.id).pipe(Effect.orDie)
        yield* failure(execution.resumeFreeModels(request(created.id)))
        expect(probe.calls).toEqual(["ready", "prepare"])
        expect(probe.runs).toEqual([])
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("caller mutation cannot swap the checked continuation Session before preparation", async () => {
    await using directory = await tmpdir()
    const probe = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const database = yield* Database.Service
        const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
        const clean = yield* sessions.create({ location })
        const blocked = yield* sessions.create({ location })
        yield* ReviewMemoryFence.make(database.db).mark(blocked.id)
        const retained = { ...request(clean.id) }
        const selected: FreeModelsResume.Input = {
          get sessionID() {
            return retained.sessionID
          },
          get messageID() {
            retained.sessionID = blocked.id
            return retained.messageID
          },
          modelID: retained.modelID,
        }
        yield* execution.resumeFreeModels(selected)
        expect(probe.requests.map((input) => input.sessionID)).toEqual([clean.id])
        expect(Object.isFrozen(probe.requests[0])).toBe(true)
        expect(probe.runs).toEqual([clean.id])
      }).pipe(Effect.provide(probe.layer), Effect.scoped),
    )
  })

  test("a reopened actual database still refuses without a process registry", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "execution.sqlite")
    const first = fixture(filename)
    const sessionID = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const database = yield* Database.Service
        const created = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        })
        yield* ReviewMemoryFence.make(database.db).mark(created.id)
        return created.id
      }).pipe(Effect.provide(first.layer), Effect.scoped),
    )
    const restarted = fixture(filename)
    await Effect.runPromise(
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        yield* failure(execution.resume(sessionID))
        yield* failure(execution.resumeFreeModels(request(sessionID)))
        expect(restarted.calls).toEqual([])
      }).pipe(Effect.provide(restarted.layer), Effect.scoped),
    )
  })
})
