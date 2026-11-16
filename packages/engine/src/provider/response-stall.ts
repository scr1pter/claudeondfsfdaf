import type { Interface } from "./deadlines"

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export function wrap(
  res: Response,
  ms: number,
  ctl: AbortController,
  deadlines: Interface = {
    schedule: (ms, run) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
  },
) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const cancel = deadlines.schedule(ms, () => {
          const err = new ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          // Cancellation is cleanup; its rejection must not escape or replace the primary deadline error.
          void reader.cancel(err).catch(() => undefined)
          reject(err)
        })

        reader.read().then(
          (part) => {
            cancel()
            resolve(part)
          },
          (err) => {
            cancel()
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

export * as ResponseStall from "./response-stall.ts"
