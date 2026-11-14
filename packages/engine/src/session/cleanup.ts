import { Effect } from "effect"
import type { Session } from "./session"

export type Hook = (info: Session.Info) => Effect.Effect<void, unknown>
const hooks = new Set<Hook>()

/** Register lightweight cleanup; isolation hooks enqueue registry work rather than running Git during deletion. */
export function register(hook: Hook) {
  hooks.add(hook)
  return () => {
    hooks.delete(hook)
  }
}

export const run = Effect.fn("SessionCleanup.run")(function* (info: Session.Info) {
  yield* Effect.forEach(
    [...hooks],
    (hook) =>
      Effect.suspend(() => hook(info)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("session cleanup failed", { sessionID: info.id, cause })),
      ),
    { discard: true },
  )
})

export * as SessionCleanup from "./cleanup"
