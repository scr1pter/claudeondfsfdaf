import assert from "node:assert/strict"
import test from "node:test"
import { ResponseStall } from "../src/provider/response-stall.ts"

test("native Node keeps the SSE deadline when cleanup cancellation rejects", { timeout: 30_000 }, async () => {
  assert.equal(process.versions.bun, undefined, "this regression must run on native Node")
  const cancelled = Promise.withResolvers()
  const cleanup = new Error("fake cleanup cancellation rejected")
  const controller = new AbortController()
  const source = new Response(
    new ReadableStream({
      cancel(reason) {
        cancelled.resolve(reason)
        return Promise.reject(cleanup)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const primary = await ResponseStall.wrap(source, 20, controller)
    .text()
    .catch((error) => error)
  assert.ok(primary instanceof ResponseStall.ResponseStreamError)
  assert.equal(primary.name, "ProviderResponseStreamError")
  assert.equal(primary.message, "SSE read timed out")
  assert.equal(controller.signal.reason, primary)
  assert.equal(await cancelled.promise, primary)
  assert.notEqual(primary, cleanup)
  // The native test runner detects an unobserved cancellation rejection at this turn boundary.
  await new Promise((resolve) => setImmediate(resolve))
})
