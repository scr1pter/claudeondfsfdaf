import { shutdown } from "./instance-registry"

const callbacks = new Set<() => Promise<void>>()

// Modules register after creating a runtime. CLI shutdown must not initialize
// otherwise-unused layers or listeners just to close them.
export function registerRuntimeCleanup(dispose: () => Promise<void>) {
  callbacks.add(dispose)
}

export async function disposeRuntimes() {
  // Background work the runtimes stop from here on is interrupted by the shutdown, not cancelled.
  shutdown()
  const pending = [...callbacks]
  callbacks.clear()
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error("Vector runtime cleanup timed out")), 10_000)
  const results = await Promise.race([
    Promise.allSettled(pending.map((dispose) => dispose())),
    timeout.promise,
  ]).finally(() => clearTimeout(timer))
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Vector runtime cleanup failed")
}
