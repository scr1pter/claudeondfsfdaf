import { afterEach, expect, test } from "bun:test"
import { engineRequest } from "./remote-engine"
import { REVIEW_START_MS, type EngineRequest } from "./remote-routes"

const AUTHORIZATION = `Basic ${btoa("vector:fixture-password")}`
const START: EngineRequest = {
  method: "POST",
  path: "/experimental/session/ses_1/connect",
  query: { directory: "/repo" },
  body: { to: "vectorscope", target: { type: "uncommitted" }, background: true },
  timeoutMs: REVIEW_START_MS,
}
const RUNS: EngineRequest = {
  method: "GET",
  path: "/experimental/connect/runs",
  query: { directory: "/repo", sessionID: "ses_1" },
}

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

// The local engine as it is while a review's question waits for a person: it takes each request and never answers.
function silentEngine() {
  const received: { method: string; path: string; authorization: string | null; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      received.push({
        method: request.method,
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
      return new Promise<Response>(() => {})
    },
  })
  servers.push(server)
  return { base: server.url.href, received }
}

// Stands in for AbortSignal.timeout with a clock the test moves: each window's signal fires once the clock passes it,
// with the reason AbortSignal.timeout gives. The real windows run 30 s and 3 minutes, longer than a test may wait.
function clock() {
  const windows: { ms: number; controller: AbortController }[] = []
  return {
    windows: () => windows.map((window) => window.ms),
    timeout: (ms: number) => {
      const controller = new AbortController()
      windows.push({ ms, controller })
      return controller.signal
    },
    advance: (to: number) =>
      windows
        .filter((window) => window.ms <= to)
        .forEach((window) => window.controller.abort(new DOMException("The operation timed out.", "TimeoutError"))),
  }
}

// How a request ended within `ms` of real time: answered, the name of the error it rejected with, or still waiting.
function within(request: Promise<unknown>, ms: number) {
  return Promise.race([
    request.then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? error.name : "not an Error"),
    ),
    Bun.sleep(ms).then(() => "waiting"),
  ])
}

test("a review start's fetch still waits when the 30 s window ends, and gives up at REVIEW_START_MS", async () => {
  const engine = silentEngine()
  const time = clock()
  const start = engineRequest(engine.base, AUTHORIZATION, START, time.timeout)
  const runs = engineRequest(engine.base, AUTHORIZATION, RUNS, time.timeout)
  start.catch(() => {})
  runs.catch(() => {})
  const deadline = Date.now() + 5_000
  while (engine.received.length < 2 && Date.now() < deadline) await Bun.sleep(1)
  expect(engine.received.map((request) => request.method).sort()).toEqual(["GET", "POST"])
  time.advance(30_000)
  // Any other request this computer makes gives up at 30 s, as before.
  expect(await within(runs, 5_000)).toBe("TimeoutError")
  expect(await within(start, 500)).toBe("waiting")
  time.advance(REVIEW_START_MS - 1)
  expect(await within(start, 500)).toBe("waiting")
  time.advance(REVIEW_START_MS)
  expect(await within(start, 5_000)).toBe("TimeoutError")
  // The windows the fetches were given, in the order they were made.
  expect(time.windows()).toEqual([REVIEW_START_MS, 30_000])
})

test("when its window ends, the fetch rejects with the TimeoutError a review start is answered 504 for", async () => {
  const engine = silentEngine()
  // The real AbortSignal.timeout, as remote-runtime.ts runs it, with a window of 500 ms instead of 3 minutes.
  const start = engineRequest(engine.base, AUTHORIZATION, { ...START, timeoutMs: 500 })
  // `send` (remote-routes.ts) answers 504 REMOTE_REVIEW_TIMEOUT for an Error named TimeoutError, and 502 otherwise.
  expect(await within(start, 10_000)).toBe("TimeoutError")
  // It was the engine that did not answer, and the window itself never reached it.
  expect(engine.received).toEqual([
    {
      method: "POST",
      path: "/experimental/session/ses_1/connect?directory=%2Frepo",
      authorization: AUTHORIZATION,
      body: JSON.stringify(START.body),
    },
  ])
})
