import { Effect, Exit, Option, RcMap, Scope } from "effect"
import type { Location } from "../location"
import type { LocationServiceMap } from "../location-service-map"
import { Pty } from "../pty"
import type { PtyID } from "./schema"

export * as PtyHold from "./hold"

/** What a holder hears from a terminal while it runs: its output, and its end (exit or removal). */
export type Watch = {
  readonly onData?: (chunk: string) => void
  readonly onEnd?: (event: { exitCode?: number }) => void
}

/**
 * Keeps a terminal's location services alive while the terminal runs. Terminals live in their location's services,
 * which core ends an hour after their last use (location-services.ts): a dev server the user is testing in the
 * browser, in a project nothing else touched for an hour, would be killed with them, with no word. Each running
 * terminal holds a reference of its own, released when its program exits or the terminal is removed. Call it with the
 * terminal's own Pty service in context, right after creating it. Returns whether the terminal still ran: one already
 * gone holds nothing, and its watch hears nothing.
 */
export const whileRunning = Effect.fn("PtyHold.whileRunning")(function* (
  locations: LocationServiceMap.Service["Service"],
  ref: Location.Ref,
  id: PtyID,
  watch: Watch = {},
) {
  const pty = yield* Pty.Service
  // The release runs from the terminal's end callback, with the services (and clock) of the caller.
  const run = Effect.runForkWith(yield* Effect.context<never>())
  const scope = yield* Scope.make()
  yield* RcMap.get(locations.rcMap, ref).pipe(
    Scope.provide(scope),
    Effect.catchCause((cause) =>
      Effect.logWarning("a terminal's location could not be held; it ends with the location", { id, cause }),
    ),
  )
  let released = false
  const release = () => {
    if (released) return
    released = true
    run(Scope.close(scope, Exit.void))
  }
  const attached = yield* pty
    .attach(id, {
      onData: (chunk) => watch.onData?.(chunk),
      onEnd: (event) => {
        release()
        watch.onEnd?.(event)
      },
    })
    .pipe(Effect.option)
  if (Option.isNone(attached)) {
    release()
    return false
  }
  attached.value.activate()
  return true
})
