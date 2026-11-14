import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { createConnectClient } from "./client"
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
