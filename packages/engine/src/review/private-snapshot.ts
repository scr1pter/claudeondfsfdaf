// A committed review reads from one private snapshot, including when its checkout is the fork's base.
// Acquire and release respect caller cancellation and a monotonic deadline. Recheck the bound identity before
// delivering results so a stale view never contributes evidence or context.
import { Effect, Fiber } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ReviewGit } from "./git"

export * as ReviewSnapshot from "./private-snapshot"

export type Placement = { directory: string; head: string; base?: string; signal?: AbortSignal }
const exactCommit = /^[0-9a-f]{40}$/

export function within<A>(
  input: Placement,
  deadline: number,
  read: (view: ReviewGit.View, signal: AbortSignal) => Effect.Effect<A>,
  unavailable: (reason: "error" | "time") => A,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    if (!exactCommit.test(input.head) || (input.base !== undefined && !exactCommit.test(input.base)))
      return unavailable("error")
    const remaining = deadline - performance.now()
    if (!(remaining > 0) || input.signal?.aborted) return unavailable("time")
    // Both metadata acquisition and release are masked. Arm the deadline before starting them. Interrupting the
    // wait aborts their native signal first, then joins the child so no snapshot is left copying after this review.
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = setTimeout(abort, Math.min(remaining, 60_000))
    input.signal?.addEventListener("abort", abort, { once: true })
    const signal = controller.signal
    const use = Effect.gen(function* () {
      const view = yield* ReviewGit.Current
      if (
        !view ||
        view.metadata.directory !== input.directory ||
        view.repository.directory !== input.directory ||
        !view.repository.isOpen() ||
        view.metadata.head !== view.repository.head ||
        !ReviewGit.sameBinding(view.repository, view.metadata) ||
        (view.repository.head !== input.head && view.repository.head !== input.base)
      )
        return unavailable("error")
      yield* view.preflight(signal)
      const result = yield* read(view, signal)
      yield* view.preflight(signal)
      return performance.now() < deadline && !signal.aborted ? result : unavailable("time")
    })
    const collect = Effect.gen(function* () {
      const current = yield* ReviewGit.Current
      const scoped = current
        ? use
        : ReviewGit.metadata(input.directory, signal).pipe(
            Effect.flatMap((metadata) => ReviewGit.within(metadata, metadata.head, use, signal)),
          )
      const refused = () => Effect.succeed(unavailable(signal.aborted ? "time" : "error"))
      return yield* scoped.pipe(
        Effect.catchTag("ReviewGit.Refused", refused),
        // Cleanup can surface the private port's own unavailable error as a defect. Unexpected program failures
        // and fiber interruption must still propagate to the caller.
        Effect.catchDefect((defect) => (defect instanceof ReadOnlyGit.Unavailable ? refused() : Effect.die(defect))),
      )
    })
    const cancelled = Effect.callback<A>((resume) => {
      const stopped = () => resume(Effect.succeed(unavailable("time")))
      if (signal.aborted) {
        stopped()
        return
      }
      signal.addEventListener("abort", stopped, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", stopped))
    })
    return yield* Effect.acquireUseRelease(
      Effect.forkChild(collect),
      (child) => Effect.raceFirst(Fiber.join(child), cancelled),
      (child) =>
        Effect.gen(function* () {
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", abort)
          abort()
          yield* Fiber.interrupt(child)
        }),
    )
  })
}
