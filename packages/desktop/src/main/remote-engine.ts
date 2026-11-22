import { engineWindowMs, type EngineRequest } from "./remote-routes"

// How this computer asks its own engine what a paired phone asked for (WP A41). Split out of remote-runtime.ts, which
// imports Electron, so tests can drive the fetch and its window (CW-23b) against a loopback server.

/**
 * One request to the local engine over its authenticated loopback server, within the request's own window
 * (engineWindowMs). When the window ends the fetch rejects with a TimeoutError, which `send` (remote-routes.ts)
 * answers for a review start as REMOTE_REVIEW_TIMEOUT. `timeout` makes a window's signal: a test seam, which
 * remote-runtime.ts does not pass.
 */
export async function engineRequest(
  base: string,
  authorization: string,
  request: EngineRequest,
  timeout = (ms: number) => AbortSignal.timeout(ms),
) {
  const url = new URL(request.path, base)
  for (const [name, value] of Object.entries(request.query)) url.searchParams.set(name, value)
  const response = await fetch(url, {
    method: request.method,
    headers: {
      authorization,
      accept: "application/json",
      ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    redirect: "error",
    signal: timeout(engineWindowMs(request)),
  })
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = {
        error: { code: "REMOTE_ENGINE_ANSWER", message: "Vector's engine answered with something other than JSON." },
      }
    }
  }
  return { status: response.status, body }
}
