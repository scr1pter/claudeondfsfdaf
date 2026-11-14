export * as ModelAttempt from "./model-attempt"

/** Internal HTTP send port. It grants no destination, credential or public request authority. */
export type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class Refused extends Error {
  constructor() {
    super("The review memory request is unavailable.")
    this.name = "ModelAttempt.Refused"
  }
}

export interface Lease {
  readonly fetch: Send
  readonly signal: AbortSignal
  /** Permanently closes admission and waits for cancellation of already acquired response bodies. */
  readonly release: () => Promise<void>
}

/**
 * Private plumbing for a future internal FetchHttpClient consumer, not a general fetch replacement.
 * A caller must supply the genuine asynchronous source/generation checkpoint and an already admitted HTTP send.
 * No binding is installed globally. Each call has its own checkpoint; no successful decision is cached.
 * Only status, statusText, headers and body consumption are preserved for body-bearing responses. Their new
 * Response does not promise original URL/type/redirected/clone metadata. Null-body responses are returned intact.
 */
export function create(input: {
  readonly checkpoint: (signal: AbortSignal) => Promise<boolean>
  readonly owner: AbortSignal
  readonly send: Send
}): Lease {
  const checkpoint = input.checkpoint
  const owner = input.owner
  const send = input.send
  const controller = new AbortController()
  const active = new Set<() => void>()
  const cleaning = new Set<Promise<void>>()
  const discarded = new WeakSet<Response>()
  let closed = false
  let cleanupFailed = false

  const track = (cleanup: () => Promise<unknown>) => {
    const task = Promise.resolve()
      .then(cleanup)
      .then(
        () => undefined,
        () => {
          cleanupFailed = true
          poison()
        },
      )
    cleaning.add(task)
    void task.then(() => cleaning.delete(task))
    return task
  }
  const discard = (response: Response) => {
    if (!response.body || discarded.has(response)) return
    discarded.add(response)
    void track(() => response.body!.cancel(new Refused()))
  }
  const poison = () => {
    if (closed) return
    closed = true
    owner.removeEventListener("abort", poison)
    controller.abort(new Refused())
    for (const stop of [...active]) stop()
  }
  const current = (signal?: AbortSignal) => {
    if (closed || owner.aborted || signal?.aborted) {
      poison()
      throw new Refused()
    }
  }
  owner.addEventListener("abort", poison, { once: true })
  if (owner.aborted) poison()

  const fetch: Send = async (request, init) => {
    current()
    // An explicitly supplied init signal (including null) overrides Request.signal, as fetch does.
    const requestSignal =
      init?.signal === undefined
        ? request instanceof Request
          ? request.signal
          : undefined
        : (init.signal ?? undefined)
    const signal = AbortSignal.any([owner, controller.signal, ...(requestSignal ? [requestSignal] : [])])
    const options: RequestInit = { ...init, signal, redirect: "error" }
    const halted = Promise.withResolvers<never>()
    // Abort may win before either awaited promise is installed; it must never become an unhandled rejection.
    void halted.promise.catch(() => {})
    let bodyStop: (() => Promise<void>) | undefined
    let finished = false
    let transferred = false
    const requestAborted = () => poison()
    const stop = () => {
      halted.reject(new Refused())
      void bodyStop?.()
    }
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(stop)
      requestSignal?.removeEventListener("abort", requestAborted)
    }
    active.add(stop)
    requestSignal?.addEventListener("abort", requestAborted, { once: true })

    try {
      current(signal)
      let admitted: boolean
      try {
        admitted = await Promise.race([checkpoint(signal), halted.promise])
      } catch {
        poison()
        throw new Refused()
      }
      if (admitted !== true) {
        poison()
        throw new Refused()
      }
      current(signal)

      // No asynchronous gap separates the final decision from this actual HTTP invocation.
      const pending = send(request, options)
      let claimed = false
      void pending.then(
        (response) => {
          // A non-cooperative sender may complete after abort/release. Its late body still has an owner.
          if (!claimed && closed) discard(response)
        },
        () => undefined,
      )
      const response = await Promise.race([pending, halted.promise])
      if (closed || signal.aborted) {
        discard(response)
        current(signal)
      }
      claimed = true
      // HEAD and 204/205/304 must not be reconstructed with a forbidden body.
      if (!response.body) return response
      // Bun may expose a body on Response.error(). That status cannot be reconstructed by this internal port.
      if (response.status < 200 || response.status > 599) {
        discard(response)
        poison()
        throw new Refused()
      }

      const reader = response.body.getReader()
      let output: ReadableStreamDefaultController<Uint8Array> | undefined
      let cancelled: Promise<void> | undefined
      const unlock = () => {
        if (finished) return
        finish()
        try {
          reader.releaseLock()
        } catch {
          cleanupFailed = true
          poison()
        }
      }
      const cancel = (unavailable: boolean) => {
        if (cancelled) return cancelled
        if (unavailable) output?.error(new Refused())
        cancelled = track(async () => {
          try {
            await reader.cancel(new Refused())
          } finally {
            unlock()
          }
        })
        return cancelled
      }
      bodyStop = () => cancel(true)
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            output = value
          },
          async pull(value) {
            try {
              current(signal)
              const chunk = await reader.read().catch((error: unknown) => {
                // A failed read has already errored the raw stream; cancel() would only repeat that error.
                unlock()
                throw error
              })
              current(signal)
              if (chunk.done) {
                unlock()
                value.close()
                return
              }
              value.enqueue(chunk.value)
            } catch (error) {
              value.error(closed ? new Refused() : error)
              if (!finished && !cancelled) await cancel(false)
            }
          },
          // SDKs may stop at a terminal SSE frame before EOF. This cleans that body, not the whole lease.
          cancel: () => cancel(false),
        },
        { highWaterMark: 0 },
      )
      current(signal)
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      })
      transferred = true
      return result
    } catch (error) {
      if (closed) throw new Refused()
      throw error
    } finally {
      if (!transferred) {
        if (bodyStop) await bodyStop()
        finish()
      }
    }
  }

  return Object.freeze({
    fetch: Object.freeze(fetch),
    signal: controller.signal,
    async release() {
      poison()
      await Promise.all([...cleaning])
      if (cleanupFailed) throw new Refused()
    },
  })
}
