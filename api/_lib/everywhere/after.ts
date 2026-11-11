import { ApiError } from "../http.js"

/*
 * Work after the response (contract 3.2 step 6). A platform route acknowledges within its budget and the rest of the
 * intake runs here. On Vercel the work is registered with the request context's `waitUntil`, the hook
 * @vercel/functions reads (the way api/_lib/usage.ts `afterResponse` does), so the function stays up until it ends.
 * Where no request context exists (a plain Node server, tests) the work still starts at once, in this process.
 *
 * Failures are caught and logged with the step's fixed name and an error code only: never a payload, a token or an
 * error message, which could quote one.
 */

const STEP = /^[a-z][a-z0-9-]{0,63}$/
const running = new Set<Promise<void>>()

type RequestContext = { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }

function waitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const context = Reflect.get(globalThis, Symbol.for("@vercel/request-context")) as RequestContext | undefined
  const waiter = context?.get?.()?.waitUntil
  return typeof waiter === "function" ? waiter : undefined
}

function report(step: string, error: unknown) {
  const code = error instanceof ApiError ? error.code : "error"
  console.error("Vector everywhere: a background step failed", { step, code })
}

/**
 * Runs `work` after the current step, without delaying the response. Answers a promise that settles when the work
 * ends (it never rejects), so a caller with nothing else to wait for may await it. `step` is a fixed name for logs.
 */
export function after(step: string, work: () => unknown): Promise<void> {
  if (!STEP.test(step)) throw new RangeError("A step name is a fixed slug.")
  const settled: Promise<void> = Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      (error: unknown) => report(step, error),
    )
    .finally(() => running.delete(settled))
  running.add(settled)
  waitUntil()?.(settled)
  return settled
}

/** How many background steps are still running in this process. */
export function afterCount() {
  return running.size
}

/** Waits until every background step has ended, including steps those steps started. For tests and the sweep. */
export async function drainAfter(): Promise<void> {
  while (running.size) await Promise.all([...running])
}
