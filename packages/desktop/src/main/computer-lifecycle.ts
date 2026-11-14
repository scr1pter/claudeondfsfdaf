/** Owns startup across quit and engine failure, including a runtime whose async construction finishes late. */
export function createComputerLifecycle<T extends { stop(): Promise<void> }>(changed: (runtime?: T) => void) {
  const state: { closed: boolean; current?: T; starting?: Promise<T | undefined>; closing?: Promise<void> } = {
    closed: false,
  }
  const stopped = new WeakMap<T, Promise<void>>()
  function dispose(runtime: T) {
    const previous = stopped.get(runtime)
    if (previous) return previous
    // Invoke synchronously: input revocation must begin before waiting for any other shutdown work.
    let closing: Promise<void>
    try {
      closing = Promise.resolve(runtime.stop())
    } catch (error) {
      closing = Promise.reject(error)
    }
    stopped.set(runtime, closing)
    return closing
  }
  return {
    start(factory: () => Promise<T | undefined>) {
      if (state.closed) return Promise.resolve(undefined)
      if (state.starting) return state.starting
      state.starting = Promise.resolve()
        .then(factory)
        .then(async (runtime) => {
          if (!runtime) return
          if (state.closed) {
            await dispose(runtime)
            return
          }
          state.current = runtime
          changed(runtime)
          return runtime
        })
      return state.starting
    },
    retire(runtime: T) {
      if (state.current === runtime) {
        state.current = undefined
        changed()
      }
      return dispose(runtime)
    },
    stop() {
      if (state.closing) return state.closing
      state.closed = true
      const runtime = state.current
      state.current = undefined
      changed()
      const closing = runtime ? dispose(runtime) : Promise.resolve()
      state.closing = Promise.allSettled([
        closing,
        state.starting?.then((late) => (late ? dispose(late) : undefined)),
      ]).then(() => {})
      return state.closing
    },
  }
}
