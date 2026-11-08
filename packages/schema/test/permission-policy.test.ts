import { expect, test } from "bun:test"
import { PermissionPolicy } from "../src/permission-policy"

// An edit to a file Vector reads into a prompt asks every time: no saved "Always allow", rule or client auto-accept
// answers it, so `vector run --auto` refuses it too.
test("a change to a prompt source always asks and can never be approved for good", () => {
  expect(PermissionPolicy.PROMPT_SOURCE).toBe("prompt_source")
  expect(PermissionPolicy.requiresApproval(PermissionPolicy.PROMPT_SOURCE, [])).toBe(true)
  expect(PermissionPolicy.requiresApproval(PermissionPolicy.PROMPT_SOURCE, ["*"], ["agents/build.md"])).toBe(true)
  expect(PermissionPolicy.canAutoApprove(PermissionPolicy.PROMPT_SOURCE, ["*"])).toBe(false)
  expect(PermissionPolicy.canAlwaysApprove(PermissionPolicy.PROMPT_SOURCE, ["*"])).toBe(false)
})

test("an ordinary edit is unchanged", () => {
  expect(PermissionPolicy.requiresApproval("edit", ["*"], ["src/foo.ts"])).toBe(false)
  expect(PermissionPolicy.canAutoApprove("edit", ["*"], ["src/foo.ts"])).toBe(true)
  expect(PermissionPolicy.canAlwaysApprove("edit", ["*"], ["src/foo.ts"])).toBe(true)
})

// A command that drops the marker owner-only commands refuse under asks every time, so `--auto` never answers it.
test("a command that drops the agent marker always asks and can never be approved for good", () => {
  expect(
    PermissionPolicy.requiresApproval(PermissionPolicy.AGENT_MARKER, ["*"], ["env -i vector trust prompts approve"]),
  ).toBe(true)
  expect(PermissionPolicy.canAutoApprove(PermissionPolicy.AGENT_MARKER, ["*"])).toBe(false)
  expect(PermissionPolicy.canAlwaysApprove(PermissionPolicy.AGENT_MARKER, ["*"])).toBe(false)
})

test("ordinary workflow plans may use auto and Always approval", () => {
  expect(PermissionPolicy.workflowPattern()).toBe("run")
  expect(PermissionPolicy.canAutoApprove(PermissionPolicy.WORKFLOW, ["run"], ["run"])).toBe(true)
  expect(PermissionPolicy.canAlwaysApprove(PermissionPolicy.WORKFLOW, ["run"], ["run"])).toBe(true)
})

test("elevated workflow plans require a fresh answer in current and shipped clients", async () => {
  const legacy = await import("./fixtures/199111/permission-policy")
  for (const reason of ["web", "mcp", "agent", "large"] as const) {
    const patterns = [PermissionPolicy.workflowPattern(reason)]
    // A permissive caller cannot turn an elevated plan into an Always rule.
    for (const always of [[], ["run"], ["*"]]) {
      expect(PermissionPolicy.canAutoApprove("workflow", always, patterns)).toBe(false)
      expect(PermissionPolicy.canAlwaysApprove("workflow", always, patterns)).toBe(false)
      expect(legacy.canAutoApprove("workflow", always, patterns)).toBe(false)
      expect(legacy.canAlwaysApprove("workflow", always, patterns)).toBe(false)
    }
  }
})

test("an omitted or unknown workflow pattern cannot grant broad approval", () => {
  for (const patterns of [undefined, [], ["*"], ["run", "other"]]) {
    expect(PermissionPolicy.canAutoApprove("workflow", ["*"], patterns)).toBe(false)
    expect(PermissionPolicy.canAlwaysApprove("workflow", ["*"], patterns)).toBe(false)
  }
})
