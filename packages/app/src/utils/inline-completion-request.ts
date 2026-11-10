// Replacements wait for the previous request's cancellation to settle before starting more helper work.
export function createInlineCompletionQueue() {
  const state = {
    active: undefined as AbortController | undefined,
    tail: Promise.resolve(),
  }
  return {
    cancel() {
      state.active?.abort()
    },
    async run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) {
      state.active?.abort()
      const controller = new AbortController()
      state.active = controller
      const cancelled = () => controller.abort()
      signal?.addEventListener("abort", cancelled, { once: true })
      if (signal?.aborted) controller.abort()
      const previous = state.tail
      const finished = Promise.withResolvers<void>()
      state.tail = finished.promise
      try {
        await previous
        if (controller.signal.aborted) return
        const result = await work(controller.signal)
        return controller.signal.aborted ? undefined : result
      } finally {
        signal?.removeEventListener("abort", cancelled)
        if (state.active === controller) state.active = undefined
        finished.resolve()
      }
    },
  }
}

export async function requestInlineCompletion<T>(input: {
  signal: AbortSignal
  request: (signal: AbortSignal) => Promise<T>
  abort: () => Promise<unknown>
}) {
  if (input.signal.aborted) return
  const state = { stopping: undefined as Promise<unknown> | undefined }
  const cancel = () => {
    // Aborting fetch alone does not promise that the backend stopped its model invocation.
    state.stopping ??= Promise.resolve()
      .then(input.abort)
      .catch(() => undefined)
  }
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    if (input.signal.aborted) return
    const result = await input.request(input.signal)
    return input.signal.aborted ? undefined : result
  } finally {
    input.signal.removeEventListener("abort", cancel)
    if (state.stopping) await state.stopping
  }
}
