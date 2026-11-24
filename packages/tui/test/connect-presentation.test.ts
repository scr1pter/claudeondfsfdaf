import { describe, expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2"
import {
  connectedMemberLine,
  connectedRunLine,
  connectedConsent,
  connectedDiff,
  oneTimePermissionReply,
} from "../src/routes/session/connect-presentation"

describe("connected tool presentation", () => {
  test("shows execution and model destinations independently", () => {
    expect(connectedMemberLine({ state: "ready", place: "local", sendsTo: "provider:chosen", reach: "connect" })).toBe(
      "ready; runs local; sends to provider:chosen; reach: connect",
    )
  })
  test("shows Codium as plan usage without dollar or token counts", () => {
    expect(
      connectedRunLine({
        status: "done",
        result: { summary: "Review done", sendsTo: "vector-codium", cost: { kind: "plan", usd: 20 } },
      }),
    ).toBe("Review done; sent to vector-codium; plan usage")
  })
  test("only identifies connect consent carrying an engine run", () => {
    expect(
      connectedConsent("connect_model", { runID: "cr_123", description: "Use the chosen model, up to $0.50." }),
    ).toBe("Use the chosen model, up to $0.50.")
    expect(connectedConsent("bash", { runID: "cr_123", description: "ignored" })).toBeUndefined()
  })
  test("a connected write approval retains its exact multiline patch and ignores unrelated metadata", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-\tbefore\n+\tafter\n"
    expect(connectedDiff("connect_write", { runID: "cr_1", diff })).toBe(diff)
    expect(connectedDiff("connect_model", { runID: "cr_1", diff })).toBeUndefined()
    expect(connectedDiff("connect_write", { runID: "not-a-run", diff })).toBeUndefined()
    expect(connectedDiff("connect_write", { runID: "cr_1", diff: 3 })).toBeUndefined()
    expect(connectedDiff("connect_write", { runID: "cr_1", diff: "" })).toBeUndefined()
  })

  test("marks a one-time reply for a Connect write with visible consent details", () => {
    expect(
      oneTimePermissionReply({
        id: "permission-write",
        permission: "connect_write",
        metadata: { runID: "cr_1", description: "Fix findings in your checkout." },
      }),
    ).toEqual({ requestID: "permission-write", reply: "once", confirm: true })
  })

  test("keeps other permissions on the ordinary one-time reply path", () => {
    for (const permission of ["read", "connect", "connect_model"]) {
      expect(oneTimePermissionReply({ id: "permission-1", permission, metadata: {} })).toEqual({
        requestID: "permission-1",
        reply: "once",
      })
    }
  })

  test("serializes the confirmation with the displayed request's directory and workspace", async () => {
    const client = createVectorClient({
      baseUrl: "http://vector.test",
      fetch: async (input) => {
        const request = new Request(input)
        const url = new URL(request.url)
        expect(url.pathname).toBe("/permission/permission-write/reply")
        expect(url.searchParams.get("directory")).toBe("/tmp/project")
        expect(url.searchParams.get("workspace")).toBe("workspace-1")
        expect(await request.json()).toEqual({ reply: "once", confirm: true })
        return Response.json(true)
      },
    })
    const reply = oneTimePermissionReply({
      id: "permission-write",
      permission: "connect_write",
      metadata: { runID: "cr_1", description: "Fix findings in your checkout." },
    })
    expect(reply).toBeDefined()
    if (!reply) return
    const result = await client.permission.reply({ ...reply, directory: "/tmp/project", workspace: "workspace-1" })
    expect(result.data).toBe(true)
  })

  test("does not offer approval for an incomplete Connect write or a cloud transfer", () => {
    const request = {
      id: "permission-write",
      permission: "connect_write",
      metadata: { runID: "cr_1", description: "Merge a fix into your checkout." },
    }

    expect(oneTimePermissionReply({ ...request, metadata: { ...request.metadata, runID: "cr_" } })).toBeUndefined()
    expect(
      oneTimePermissionReply({ ...request, metadata: { ...request.metadata, description: "\u001b[31m " } }),
    ).toBeUndefined()
    expect(oneTimePermissionReply({ ...request, metadata: { ...request.metadata, diff: 42 } })).toBeUndefined()
    expect(
      oneTimePermissionReply({
        ...request,
        permission: "connect_cloud",
        metadata: { runID: "cr_1", description: "Send code to Vector Cloud.", destination: "Vector Cloud" },
      }),
    ).toBeUndefined()
  })
})
