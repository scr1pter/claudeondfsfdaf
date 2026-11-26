import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import {
  createPermissionBodyState,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionInfo,
  permissionOptions,
  permissionReject,
  permissionRun,
} from "@/cli/cmd/run/permission.shared"

function req(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run permission shared", () => {
  test("replies immediately for allow once", () => {
    const request = req()
    const out = permissionRun(createPermissionBodyState(request), request, "once")

    expect(out.reply).toEqual({
      requestID: "perm-1",
      reply: "once",
    })
  })

  test("shows the Connect write description and patch before an explicit one-time reply", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after\n"
    const request = req({
      permission: "connect_write",
      metadata: { runID: "cr_1", description: "Merge a fix into your checkout.", diff },
    })
    const state = createPermissionBodyState(request)
    expect(permissionInfo(request)).toMatchObject({
      title: "Apply review fixes",
      lines: ["Merge a fix into your checkout."],
      diff,
    })
    expect(permissionOptions(state)).toEqual(["once", "reject"])
    expect(permissionRun(state, request, "once").reply).toEqual({
      requestID: request.id,
      reply: "once",
      confirm: true,
    })
    expect(permissionRun(state, request, "reject").reply).toBeUndefined()
    expect(permissionRun(state, { ...request, id: "different-request" }, "once").reply).toBeUndefined()
  })

  test.each(["connect_write", "connect_cloud"])("only offers rejection for an unsupported %s ask", (permission) => {
    const request = req({ permission, metadata: { description: "Send results to the connected service." } })
    const state = createPermissionBodyState(request)
    expect(state.selected).toBe("reject")
    expect(permissionOptions(state)).toEqual(["reject"])
    expect(permissionRun(state, request, "once").reply).toBeUndefined()
  })

  test("requires confirmation for allow always", () => {
    const request = req({ always: ["*"] })
    const next = permissionRun(createPermissionBodyState(request), request, "always")
    expect(next.state.stage).toBe("always")
    expect(next.state.selected).toBe("confirm")
    expect(next.reply).toBeUndefined()

    expect(permissionRun(next.state, request, "confirm").reply).toEqual({
      requestID: "perm-1",
      reply: "always",
    })

    expect(permissionRun(next.state, request, "cancel").state).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("builds trimmed reject replies and stage transitions", () => {
    const request = req()
    const next = permissionRun(createPermissionBodyState(request), request, "reject")
    expect(next.state.stage).toBe("reject")

    const out = permissionReject({ ...next.state, message: "  use rg  " }, "perm-1")
    expect(out).toEqual({
      requestID: "perm-1",
      reply: "reject",
      message: "use rg",
    })

    expect(permissionCancel(next.state)).toMatchObject({
      stage: "permission",
      selected: "reject",
    })

    expect(permissionEscape(createPermissionBodyState(req()))).toMatchObject({
      stage: "reject",
      selected: "reject",
    })

    expect(permissionEscape({ ...next.state, stage: "always", selected: "confirm" })).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test.each(["browser_sensitive", "computer_observe", "computer_interact", "computer_sensitive"])(
    "does not offer or accept permanent approval for %s",
    (permission) => {
      const request = req({ permission, always: ["*"] })
      const state = createPermissionBodyState(request)
      expect(permissionOptions(state)).toEqual(["once", "reject"])
      expect(permissionRun(state, request, "always")).toEqual({ state })
    },
  )

  test("maps supported permission types into display info", () => {
    expect(
      permissionInfo(
        req({
          permission: "bash",
          metadata: {
            input: {
              command: "git status --short",
            },
          },
        }),
      ),
    ).toMatchObject({
      title: "Shell command",
      lines: ["$ git status --short"],
    })

    expect(
      permissionInfo(
        req({
          permission: "task",
          metadata: {
            description: "investigate stream",
            subagent_type: "general",
          },
        }),
      ),
    ).toMatchObject({
      title: "General Task",
      lines: ["◉ investigate stream"],
    })

    expect(
      permissionInfo(
        req({
          permission: "external_directory",
          patterns: ["/tmp/work/**/*.ts", "/tmp/work/**/*.tsx"],
        }),
      ),
    ).toMatchObject({
      title: "Access external directory /tmp/work",
      lines: ["- /tmp/work/**/*.ts", "- /tmp/work/**/*.tsx"],
    })

    expect(permissionInfo(req({ permission: "doom_loop" }))).toMatchObject({
      title: "Continue after repeated failures",
    })

    expect(permissionInfo(req({ permission: "custom_tool" }))).toMatchObject({
      title: "Call tool custom_tool",
      lines: ["Tool: custom_tool"],
    })
  })

  test("formats always-allow copy for wildcard and explicit patterns", () => {
    expect(permissionAlwaysLines(req({ permission: "bash", always: ["*"] }))).toEqual([
      "This will allow bash until Vector is restarted.",
    ])

    expect(permissionAlwaysLines(req({ always: ["src/**/*.ts", "src/**/*.tsx"] }))).toEqual([
      "This will allow the following patterns until Vector is restarted.",
      "- src/**/*.ts",
      "- src/**/*.tsx",
    ])
  })
})
