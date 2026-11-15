import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { createConnectClient, directoryReviewAnswer } from "./client"
import { reviewRun, sessionID } from "./test-fixture"

test("registry reads retain each selected project's model destination", async () => {
  const scopes: (string | null)[] = []
  const selected = (directory: string) =>
    createConnectClient(
      createVectorClient({
        baseUrl: "http://engine.test",
        directory,
        fetch: async (request) => {
          const scope = new URL(request.url).searchParams.get("directory")
          scopes.push(scope)
          return Response.json([
            {
              id: "vectorscope",
              kind: "agent",
              title: "VectorScope",
              summary: "Review selected changes.",
              owner: "vectorscope",
              place: "local",
              state: "ready",
              reach: "connect",
              actions: [{ id: "review", title: "Review", effects: ["read"], background: true, result: "review" }],
              sendsTo: scope === "/project-one" ? "provider:first-model" : "provider:second-model",
            },
          ])
        },
      }),
    )
  expect((await selected("/project-one").list())[0]?.sendsTo).toBe("provider:first-model")
  expect((await selected("/project-two").list())[0]?.sendsTo).toBe("provider:second-model")
  expect(scopes).toEqual(["/project-one", "/project-two"])
})

test("cancellation uses the existing authenticated directory transport and accepts its boolean result", async () => {
  const calls: Request[] = []
  const sdk = createVectorClient({
    baseUrl: "http://engine.test",
    directory: "/fixture/project",
    headers: { Authorization: "Bearer fixture-only" },
    fetch: async (request) => {
      calls.push(request)
      return Response.json(true)
    },
  })
  expect(await createConnectClient(sdk).cancel("cr_fixture", sessionID)).toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.method).toBe("POST")
  expect(new URL(calls[0]!.url).pathname).toBe("/experimental/connect/runs/cr_fixture/cancel")
  expect(new URL(calls[0]!.url).searchParams.get("directory")).toBe("/fixture/project")
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer fixture-only")
})

test("a false cancellation is valid and a malformed response is refused", async () => {
  const make = (data: unknown) =>
    createConnectClient(
      createVectorClient({
        baseUrl: "http://engine.test",
        fetch: async () => Response.json(data),
      }),
    )
  expect(await make(false).cancel("cr_fixture")).toBe(false)
  await expect(make({ status: "done" }).cancel("cr_fixture")).rejects.toThrow("invalid cancellation")
})

test("run responses are decoded before surfaces can treat them as reviews", async () => {
  const make = (data: unknown) =>
    createConnectClient(
      createVectorClient({
        baseUrl: "http://engine.test",
        fetch: async () => Response.json(data),
      }),
    )
  expect((await make(reviewRun()).get("cr_fixture", sessionID)).result?.verdict).toBe("incomplete")
  const original = reviewRun()
  const invalid = { ...original, result: { ...original.result!, verdict: "clean" } }
  await expect(make(invalid).get("cr_fixture", sessionID)).rejects.toBeDefined()
})

test("directory review preserves the captured authenticated checkout and decodes a sessionless queued run", async () => {
  const requestKey = "41b41bdc-cb6b-4c96-98d2-f0bad73db1c2"
  const fixture = reviewRun()
  const run = {
    ...fixture,
    request: {
      ...fixture.request,
      requester: { kind: "user" },
      target: { kind: "branch", base: "a".repeat(40) },
      background: true,
    },
    status: "queued",
    result: undefined,
  }
  const calls: Request[] = []
  const client = createConnectClient(
    createVectorClient({
      baseUrl: "http://engine.test",
      directory: fixture.request.directory,
      headers: { Authorization: "Bearer fixture-only" },
      fetch: async (request) => {
        calls.push(request)
        return Response.json(run)
      },
    }),
  )
  expect(
    (await client.directoryReview({ requestKey, target: { kind: "branch", base: "a".repeat(40) }, background: true }))
      .request.requester.sessionID,
  ).toBeUndefined()
  expect(new URL(calls[0]!.url).pathname).toBe("/experimental/connect/review")
  expect(new URL(calls[0]!.url).searchParams.get("directory")).toBe(fixture.request.directory)
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer fixture-only")
  expect(await calls[0]!.json()).toEqual({
    requestKey,
    target: { kind: "branch", base: "a".repeat(40) },
    background: true,
  })
})

test("engine refusals keep their typed code and message; other failures are unknown", async () => {
  const consumed = {
    code: "consumed" as const,
    message: "This review start did not complete and no review ran. Start a new review.",
  }
  const pending = {
    code: "pending" as const,
    message: "This review start is not confirmed yet. Retry it shortly; a retry never starts a second review.",
  }
  const start = (fetch: (request: Request) => Promise<Response>) =>
    createConnectClient(createVectorClient({ baseUrl: "http://engine.test", fetch })).directoryReview({
      requestKey: "41b41bdc-cb6b-4c96-98d2-f0bad73db1c2",
      target: { kind: "branch", base: "a".repeat(40) },
      background: true,
    })
  const answer = (body: unknown, status = 400) =>
    start(async () => Response.json(body, { status })).catch(directoryReviewAnswer)
  expect(await answer(consumed)).toEqual(consumed)
  expect(await answer(pending)).toEqual(pending)
  expect(await answer({ ...consumed, data: { message: "SDK wrapper text" } })).toEqual(consumed)
  // The SDK falls back to the request URL when the body has no message; that is never shown as the engine's words.
  await expect(start(async () => Response.json({ code: "consumed", message: "" }, { status: 400 }))).rejects.toThrow(
    "http://engine.test",
  )
  expect(await answer({ code: "consumed", message: "" })).toBeUndefined()
  expect(await answer({ code: "consumed" })).toBeUndefined()
  expect(await answer(consumed, 403)).toBeUndefined()
  expect(await answer(consumed, 500)).toBeUndefined()
  expect(await answer({ code: "invalid", message: "The review input is invalid." })).toBeUndefined()
  expect(await answer({ code: "other", message: "Something else happened." })).toBeUndefined()
  expect(await answer("consumed")).toBeUndefined()
  expect(
    await start(async () => {
      throw new TypeError("fetch failed")
    }).catch(directoryReviewAnswer),
  ).toBeUndefined()
  expect(directoryReviewAnswer({ message: "Not an error", cause: { status: 400, body: consumed } })).toBeUndefined()
})
