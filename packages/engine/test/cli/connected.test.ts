import { afterEach, describe, expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { reviewTarget, formatConnectedResult, executeConnectedCommand } from "../../src/cli/cmd/connected"

const marker = process.env[ChildEnvironment.AGENT_MARKER]
afterEach(() => {
  if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = marker
})

describe("connected CLI targets", () => {
  test("defaults to working-tree changes and selects explicit targets", () => {
    expect(reviewTarget({ action: "review" })).toEqual({ kind: "uncommitted" })
    expect(reviewTarget({ action: "review", staged: true })).toEqual({ kind: "staged" })
    expect(reviewTarget({ action: "review", base: "main" })).toEqual({ kind: "branch", base: "main" })
  })
  test("refuses ambiguous targets and git options", () => {
    expect(() => reviewTarget({ action: "review", staged: true, base: "main" })).toThrow()
    expect(() => reviewTarget({ action: "review", base: "--upload-pack=bad" })).toThrow()
  })
  test("shows where a ready member runs and sends code", () => {
    expect(
      formatConnectedResult([{ title: "VectorScope", state: "ready", place: "local", sendsTo: "this-computer" }]),
    ).toBe("VectorScope: ready; runs local; sends to this-computer")
  })
  test("uses the actual directory-scoped SDK routes and serializes review targets", async () => {
    delete process.env[ChildEnvironment.AGENT_MARKER]
    const requests: Request[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      directory: "/fixture",
      throwOnError: true,
      fetch: async (request) => {
        requests.push(request)
        return Response.json(new URL(request.url).pathname.endsWith("/cancel") ? true : [])
      },
    })
    await executeConnectedCommand(client, { action: "list" })
    await executeConnectedCommand(client, { action: "runs", session: "ses_fixture" })
    await executeConnectedCommand(client, { action: "review", session: "ses_fixture", staged: true })
    await executeConnectedCommand(client, { action: "cancel", runID: "cr_fixture", session: "ses_fixture" })
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/experimental/connect"],
      ["GET", "/experimental/connect/runs"],
      ["POST", "/experimental/session/ses_fixture/connect"],
      ["POST", "/experimental/connect/runs/cr_fixture/cancel"],
    ])
    expect(await requests[2]!.json()).toEqual({ target: { kind: "staged" }, background: true })
    for (const request of requests)
      expect(decodeURIComponent(request.headers.get("x-vector-directory") ?? "")).toBe("/fixture")
  })
  test("the agent marker refuses review and cancellation before transport", async () => {
    process.env[ChildEnvironment.AGENT_MARKER] = "1"
    const requests: Request[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (request) => {
        requests.push(request)
        return Response.json([])
      },
    })
    await expect(executeConnectedCommand(client, { action: "review", session: "ses_fixture" })).rejects.toThrow(
      "cannot",
    )
    await expect(executeConnectedCommand(client, { action: "cancel", runID: "cr_fixture" })).rejects.toThrow("cannot")
    expect(requests).toHaveLength(0)
    await executeConnectedCommand(client, { action: "runs" })
    expect(requests).toHaveLength(1)
  })
})
