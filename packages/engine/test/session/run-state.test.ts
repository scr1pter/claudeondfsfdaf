import { describe, expect } from "bun:test"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionRunState.node,
      Session.node,
      SessionStatus.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const within = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const record = (status: string) => ({
  subagent: {
    kind: "specialist",
    agent: "explore",
    title: "Map the auth flow",
    callID: "call_1",
    parentSessionID: "ses_parent",
    parentMessageID: "msg_parent",
    model: { providerID: "test", modelID: "test" },
    status,
    startedAt: 1,
  },
})

// Every session.updated published while `body` runs.
const updates = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const seen: unknown[] = []
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === Session.Event.Updated.type) seen.push(event.data)
      return Effect.void
    })
    yield* body.pipe(Effect.ensuring(unsubscribe))
    return seen
  })

describe("SessionRunState.cancel with nothing running", () => {
  for (const status of ["running", "queued"]) {
    it.instance(`settles a ${status} subagent record that no job in this process will settle`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const runState = yield* SessionRunState.Service
        const events = yield* EventV2Bridge.Service
        // The engine stopped mid-run and started again: the record still says live, and no runner or job knows it.
        const child = yield* sessions.create({ metadata: record(status) })
        const idle = yield* Deferred.make<unknown>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === SessionStatus.Event.Status.type) Deferred.doneUnsafe(idle, Effect.succeed(event.data))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        const before = Date.now()
        const seen = yield* updates(runState.cancel(child.id))

        const settled = SubagentLifecycle.read(yield* sessions.get(child.id))
        expect(settled).toMatchObject({ ...record("cancelled").subagent, usage: { cost: 0, total: 0, steps: 0 } })
        expect(settled?.completedAt).toBeGreaterThanOrEqual(before)
        // Settling the orphan and recording that the user stopped it are separate lifecycle writes.
        expect(seen).toHaveLength(2)
        expect(seen[0]).toMatchObject({ info: { metadata: { subagent: { status: "cancelled" } } } })
        expect(seen[1]).toMatchObject({
          info: { metadata: { subagent: { status: "cancelled", stop: { by: "user" } } } },
        })
        expect(yield* within(idle, "stop never reported the session idle")).toEqual({
          sessionID: child.id,
          status: { type: "idle" },
        })
      }),
    )
  }

  it.instance("leaves a finished record alone and publishes nothing for it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const child = yield* sessions.create({ metadata: record("completed") })
      const current = yield* sessions.get(child.id)

      expect(yield* updates(runState.cancel(child.id))).toEqual([])
      expect(yield* sessions.get(child.id)).toEqual(current)
    }),
  )

  it.instance("leaves a live record to the job this process still has for it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const background = yield* BackgroundJob.Service
      const child = yield* sessions.create({ metadata: record("running") })
      // The child's run has returned, and the task call that owns the job is about to write the outcome.
      yield* background.start({ id: child.id, type: "task", run: Effect.succeed("done") })
      yield* background.wait({ id: child.id })
      const current = yield* sessions.get(child.id)

      expect(yield* updates(runState.cancel(child.id))).toEqual([])
      expect(yield* sessions.get(child.id)).toEqual(current)
    }),
  )

  it.instance("still succeeds for a session that does not exist", () =>
    Effect.gen(function* () {
      const runState = yield* SessionRunState.Service
      yield* runState.cancel(SessionID.descending())
    }),
  )
})
