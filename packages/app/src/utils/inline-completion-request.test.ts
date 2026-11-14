import { describe, expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { createInlineCompletionQueue, requestInlineCompletion } from "./inline-completion-request"

describe("inline completion cancellation", () => {
  test("does not start a request whose editor token was already cancelled", async () => {
    const queue = createInlineCompletionQueue()
    const controller = new AbortController()
    controller.abort()
    const calls: string[] = []
    expect(await queue.run(controller.signal, async () => calls.push("started"))).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("waits for the previous backend stop before starting a replacement", async () => {
    const queue = createInlineCompletionQueue()
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<string>()
    const stopped = Promise.withResolvers<void>()
    const stopping = Promise.withResolvers<void>()
    const calls: string[] = []
    const first = queue.run(undefined, (signal) =>
      requestInlineCompletion({
        signal,
        request: async () => {
          calls.push("first")
          started.resolve()
          return response.promise
        },
        abort: () => {
          calls.push("abort first")
          stopping.resolve()
          return stopped.promise
        },
      }),
    )
    await started.promise
    const second = queue.run(undefined, async () => {
      calls.push("second")
      return "replacement"
    })
    await stopping.promise
    response.resolve("obsolete")
    await Promise.resolve()
    expect(calls).toEqual(["first", "abort first"])
    stopped.resolve()
    expect(await first).toBeUndefined()
    expect(await second).toBe("replacement")
    expect(calls).toEqual(["first", "abort first", "second"])
  })

  test("skips an already replaced request while an older request is still settling", async () => {
    const queue = createInlineCompletionQueue()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const calls: string[] = []
    const first = queue.run(undefined, async () => {
      started.resolve()
      await finish.promise
      return "old"
    })
    await started.promise
    const second = queue.run(undefined, async () => calls.push("middle"))
    const third = queue.run(undefined, async () => calls.push("latest"))
    finish.resolve()
    await Promise.all([first, second, third])
    expect(calls).toEqual(["latest"])
  })

  test("panel cleanup cancels active work and drops a late successful response", async () => {
    const queue = createInlineCompletionQueue()
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<string>()
    const first = queue.run(undefined, async (signal) => {
      started.resolve()
      await response.promise
      expect(signal.aborted).toBe(true)
      return "late"
    })
    await started.promise
    queue.cancel()
    response.resolve("late")
    expect(await first).toBeUndefined()
  })

  test("failed requests release the queue for later work", async () => {
    const queue = createInlineCompletionQueue()
    await expect(
      queue.run(undefined, async () => {
        throw new Error("offline")
      }),
    ).rejects.toThrow("offline")
    expect(await queue.run(undefined, async () => "next")).toBe("next")
  })

  test("a completed response no longer listens for cancellation", async () => {
    const controller = new AbortController()
    const calls: string[] = []
    expect(
      await requestInlineCompletion({
        signal: controller.signal,
        request: async () => "complete",
        abort: async () => calls.push("abort"),
      }),
    ).toBe("complete")
    controller.abort()
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  test("the real SDK sends backend abort only to the active autocomplete helper", async () => {
    const promptStarted = Promise.withResolvers<void>()
    const backendStopped = Promise.withResolvers<void>()
    const routes: string[] = []
    const client = createVectorClient({
      baseUrl: "http://autocomplete.test",
      throwOnError: true,
      fetch: Object.assign(
        async (source: RequestInfo | URL, init?: RequestInit) => {
          const request = source instanceof Request ? source : new Request(source, init)
          const path = new URL(request.url).pathname
          routes.push(`${request.method} ${path}`)
          if (path === "/session/ses_autocomplete/message") {
            promptStarted.resolve()
            return new Promise<Response>((resolve, reject) => {
              const cancel = () => reject(new DOMException("Cancelled autocomplete", "AbortError"))
              request.signal.addEventListener("abort", cancel, { once: true })
              if (request.signal.aborted) cancel()
              void backendStopped.promise.then(() => {
                request.signal.removeEventListener("abort", cancel)
                resolve(Response.json({ parts: [{ type: "text", text: "obsolete" }] }))
              })
            })
          }
          if (path === "/session/ses_autocomplete/abort") {
            backendStopped.resolve()
            return Response.json(true)
          }
          throw new Error(`Unexpected endpoint: ${path}`)
        },
        { preconnect() {} },
      ),
    })
    const controller = new AbortController()
    const response = requestInlineCompletion({
      signal: controller.signal,
      request: (signal) =>
        client.session.prompt(
          { sessionID: "ses_autocomplete", agent: "autocomplete", parts: [{ type: "text", text: "synthetic code" }] },
          { signal },
        ),
      abort: () => client.session.abort({ sessionID: "ses_autocomplete" }),
    }).catch(() => undefined)
    await promptStarted.promise
    controller.abort()
    expect(await response).toBeUndefined()
    expect(routes).toEqual(["POST /session/ses_autocomplete/message", "POST /session/ses_autocomplete/abort"])
  })
})
