import { describe, expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { ReviewMemoryRequestError } from "./review-memory"
import { reviewMemoryTransport } from "./review-memory-transport"

const scope = `vrs1_${"1".repeat(64)}`
const read: ReviewMemoryControl.Inspect = {
  repository: "repo",
  scope,
  state: { enabled: false, generation: 0, entries: [] },
}
const preview: ReviewMemoryControl.ConfigurePreview = {
  previewId: "00000000-0000-4000-8000-000000000001",
  sha256: "a".repeat(64),
  expiresAt: 120_000,
  repository: "repo",
  scope,
  expected: 0,
  operation: "configure",
  payload: { expected: 0, enabled: true },
}

describe("actual generated SDK review-memory transport", () => {
  test("uses only captured directory placement and canonical generated payload parameters for every operation", async () => {
    const calls: { method: string; url: URL; body?: unknown }[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)
        calls.push({
          method: request.method,
          url,
          ...(request.method === "POST" ? { body: await request.json() } : {}),
        })
        return Response.json(
          request.method === "DELETE"
            ? true
            : url.pathname.endsWith("/prepare")
              ? preview
              : url.pathname.endsWith("/confirm")
                ? { enabled: true, generation: 1 }
                : read,
        )
      },
    })
    const api = reviewMemoryTransport({ client, directory: "/repo with spaces", current: () => true })
    const signal = new AbortController().signal
    expect(await api.inspect({ offset: 0, limit: 50 }, signal)).toEqual(read)
    const command: ReviewMemoryControl.Prepare = {
      expectedScope: scope,
      command: { action: "configure", expected: 0, enabled: true },
    }
    expect(await api.prepare(command, signal)).toEqual(preview)
    const confirmation = { previewId: preview.previewId, approvedSha256: preview.sha256 }
    expect(await api.confirm(confirmation, signal)).toEqual({ enabled: true, generation: 1 })
    await api.discard(preview.previewId, signal)
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/experimental/review-memory"],
      ["POST", "/experimental/review-memory/prepare"],
      ["POST", "/experimental/review-memory/confirm"],
      ["DELETE", `/experimental/review-memory/previews/${preview.previewId}`],
    ])
    for (const call of calls) {
      expect(call.url.searchParams.get("directory")).toBe("/repo with spaces")
      expect(call.url.searchParams.has("workspace")).toBe(false)
    }
    expect(calls[0].url.searchParams.get("offset")).toBe("0")
    expect(calls[0].url.searchParams.get("limit")).toBe("50")
    expect(calls[1].body).toEqual(command)
    expect(calls[2].body).toEqual(confirmation)
  })

  test("stale placement or aborted signals send zero SDK requests; caller authority fields cannot alter the query", async () => {
    const calls: string[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (input) => {
        calls.push(String(input))
        return Response.json(read)
      },
    })
    const api = reviewMemoryTransport({ client, directory: "/repo", current: () => false })
    await expect(Promise.resolve().then(() => api.inspect({}, new AbortController().signal))).rejects.toBeInstanceOf(
      ReviewMemoryRequestError,
    )
    const aborted = new AbortController()
    aborted.abort()
    const current = reviewMemoryTransport({ client, directory: "/repo", current: () => true })
    await expect(Promise.resolve().then(() => current.inspect({}, aborted.signal))).rejects.toThrow()
    const forged = {
      expectedScope: scope,
      command: { action: "configure" as const, expected: 0, enabled: true },
      directory: "/foreign",
    }
    await expect(
      Promise.resolve().then(() => current.prepare(forged, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ReviewMemoryRequestError)
    expect(calls).toEqual([])
  })

  test("a frozen canonical record allocates the SDK wire arrays without changing paths or quoted citations", async () => {
    const command: ReviewMemoryControl.Record = Object.freeze({
      action: "record",
      expected: 0,
      kind: "check",
      text: "Check parsing before use.",
      paths: Object.freeze(["src/parser.ts", "src/reader.ts"]),
      citations: Object.freeze([
        Object.freeze({ path: "src/parser.ts", line: 7, head: "a".repeat(40), quote: 'return "quoted"\n' }),
      ]),
      reason: "Keep the exact reviewed condition.",
      visibility: "repository",
    })
    const input: ReviewMemoryControl.Prepare = Object.freeze({ expectedScope: scope, command })
    const sent: unknown[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (value) => {
        const request = value instanceof Request ? value : new Request(value)
        sent.push(await request.json())
        const { action, ...payload } = command
        return Response.json({ ...preview, operation: action, payload })
      },
    })
    const api = reviewMemoryTransport({ client, directory: "/repo", current: () => true })
    const result = await api.prepare(input, new AbortController().signal)
    expect(sent).toEqual([input])
    expect(result.operation).toBe("record")
    expect(Object.isFrozen(command.paths)).toBe(true)
    expect(Object.isFrozen(command.citations[0])).toBe(true)
    expect(command.citations[0].quote).toBe('return "quoted"\n')
  })

  test("a late valid SDK response cannot establish data after the captured binding has changed", async () => {
    const entered = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<Response>()
    const binding = { current: true }
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async () => {
        entered.resolve()
        return answer.promise
      },
    })
    const api = reviewMemoryTransport({ client, directory: "/repo", current: () => binding.current })
    const waiting = api.inspect({}, new AbortController().signal)
    await entered.promise
    binding.current = false
    answer.resolve(Response.json(read))
    await expect(waiting).rejects.toBeInstanceOf(ReviewMemoryRequestError)
  })

  test("guest, HTML and malformed answers never establish a read; known used refusals retain only their code", async () => {
    for (const mode of ["guest", "html", "malformed", "used"] as const) {
      const denied: string[] = []
      const client = createVectorClient({
        baseUrl: "http://fixture.invalid",
        fetch: async () =>
          mode === "guest"
            ? Response.json({ message: "PRIVATE_UPSTREAM_DETAIL" }, { status: 403 })
            : mode === "html"
              ? new Response("<html>login</html>", { headers: { "content-type": "text/html" } })
              : mode === "used"
                ? Response.json({ code: "used", message: "PRIVATE_UPSTREAM_DETAIL" }, { status: 400 })
                : Response.json({ ...read, owner: true }),
      })
      const api = reviewMemoryTransport({
        client,
        directory: "/repo",
        current: () => true,
        denied: () => denied.push("retired"),
      })
      const failure = await api.inspect({}, new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("Missing transport refusal")
      expect(failure.message).not.toContain("PRIVATE_")
      expect(denied).toEqual(mode === "guest" ? ["retired"] : [])
      if (mode === "used") expect(failure instanceof ReviewMemoryRequestError && failure.code).toBe("used")
    }
  })
})
