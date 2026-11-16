import { FreeModelsResume } from "../free-model-resume"
import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { PluginInternal } from "../../plugin/internal"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { Database } from "../../database/database"
import { ReviewMemoryFence } from "../../review/memory-fence"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const database = yield* Database.Service
    const memory = ReviewMemoryFence.make(database.db)
    const ordinary = (sessionID: SessionSchema.ID) =>
      memory
        .requiresLease(sessionID)
        .pipe(
          Effect.flatMap((required) =>
            required
              ? Effect.fail(
                  new ReviewMemoryFence.Refused({ message: "The review memory history boundary is unavailable." }),
                )
              : Effect.void,
          ),
        )
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError | FreeModelsResume.Rejected
    >({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        yield* ordinary(sessionID)
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* loaded(
          ordinary(sessionID).pipe(
            Effect.andThen(SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))),
          ),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      resumeFreeModels: (input) => {
        const request = Object.freeze({
          sessionID: input.sessionID,
          messageID: input.messageID,
          modelID: input.modelID,
        })
        return coordinator.runExclusive(
          request.sessionID,
          Effect.gen(function* () {
            yield* ordinary(request.sessionID)
            const session = yield* store.get(request.sessionID)
            if (!session) return yield* new FreeModelsResume.Rejected({ message: "Session not found." })
            yield* loaded(
              ordinary(request.sessionID).pipe(
                Effect.andThen(FreeModelsResume.Service.use((service) => service.prepare(request))),
              ),
            ).pipe(Effect.provide(locations.get(session.location)))
          }),
          new FreeModelsResume.Rejected({ message: "This session is busy. Wait for the current turn to finish." }),
        )
      },
      wake: coordinator.wake,
    })
  }),
)

// A Location's built-in plugins load in the background as its services start, and they add the agents and models a turn
// reads. Work that starts with the Location, a first prompt or one after the Location sat idle, waits for them;
// otherwise it finds no model and the drain fails with nothing recorded in the session.
const loaded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  PluginInternal.Service.use((plugins) => plugins.ready).pipe(Effect.andThen(effect))

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, Database.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
