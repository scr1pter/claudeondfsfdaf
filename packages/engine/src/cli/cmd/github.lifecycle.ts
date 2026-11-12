import { Cause, Effect, Exit, Fiber } from "effect"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { GithubSecrets } from "./github.secrets"
import { heartbeat, settle, type Services } from "./github.cloud"
import { EffectBridge } from "@/effect/bridge"

type CallbackRunner = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

/** Promise callbacks still belong to the job: drain their Git/model fibers before revoking its token. */
export function withGithubCallbacks<A, E, R>(use: (run: CallbackRunner) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const bridge = yield* EffectBridge.make()
      const run: CallbackRunner = (effect) =>
        bridge
          .promise(effect.pipe(Effect.forkIn(scope, { startImmediately: true })))
          // Fiber.join's observer cleanup in this Effect beta can stall an async child finalizer.
          .then((fiber) => Effect.runPromise(Fiber.await(fiber).pipe(Effect.flatMap((exit) => exit))))
      return yield* use(run)
    }),
  )
}

/** Actions cancellation must interrupt the Effect so credential finalizers finish before CLI exit. */
export function withGithubSignals<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const signal = Promise.withResolvers<void>()
      let received = false
      const stop = (code: 130 | 143) => {
        if (received) return
        received = true
        process.exitCode = code
        signal.resolve()
      }
      const interrupt = () => stop(130)
      const terminate = () => stop(143)
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt)
        process.removeListener("SIGTERM", terminate)
      }
      process.on("SIGINT", interrupt)
      process.on("SIGTERM", terminate)
      return { wait: signal.promise, cleanup }
    }),
    // Install both listeners before the job can acquire credentials or announce readiness.
    (signal) =>
      Effect.raceFirst(
        effect,
        Effect.promise(() => signal.wait),
      ),
    (signal) => Effect.sync(signal.cleanup),
  )
}

/** The agent/review owns graceful stopping and its final outcome; this scope owns heartbeat and bounded settlement. */
export function withRunHeartbeat<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    onStop: () => void
    outcome: () => GithubAgents.Outcome
    credentials?: Pick<ReturnType<typeof GithubSecrets.createGithubSecrets>, "runToken">
    services?: Services
    /** The time between running beats; HEARTBEAT_SECONDS by default. Tests shorten it. */
    intervalMs?: number
  },
) {
  return Effect.suspend(() => {
    const token = (input.credentials ?? GithubSecrets.credentials).runToken()
    if (!token) return effect
    return withGithubSignals(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          let stopped = false
          let cancelled = false
          let outcome: GithubAgents.Outcome = "failed"
          let settlement: Promise<boolean> | undefined
          const finish = () =>
            (settlement ??= settle({
              token,
              outcome: cancelled ? "cancelled" : outcome,
              services: input.services,
              signal: AbortSignal.timeout(5000),
            }))
          // Cancellation starts settlement immediately, independently of a slow inner cleanup. Normal completion
          // settles on scope exit; retries share the first operation/outcome, as the server's lifecycle requires.
          const cancel = () => {
            cancelled = true
            stopped = true
            void finish()
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              process.on("SIGTERM", cancel)
              process.on("SIGINT", cancel)
            }),
            () =>
              Effect.sync(() => {
                process.removeListener("SIGTERM", cancel)
                process.removeListener("SIGINT", cancel)
              }),
          )
          // Registered before the heartbeat fiber, so normal scope cleanup interrupts its timer before settling.
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await finish()
            }),
          )
          const pulse = Effect.gen(function* () {
            while (!stopped) {
              yield* Effect.sleep(input.intervalMs ?? GithubAgents.HEARTBEAT_SECONDS * 1000)
              const answer = yield* Effect.promise((signal) =>
                heartbeat({ token, state: "running", services: input.services, signal }),
              )
              if (!answer.ok || answer.stop) {
                stopped = true
                input.onStop()
              }
            }
          })
          yield* Effect.forkIn(pulse, scope)
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                stopped = true
                outcome = cancelled
                  ? "cancelled"
                  : Exit.isFailure(exit)
                    ? Cause.hasInterrupts(exit.cause)
                      ? "cancelled"
                      : "failed"
                    : input.outcome()
              }),
            ),
          )
        }),
      ),
    )
  })
}
