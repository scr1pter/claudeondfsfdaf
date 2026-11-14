import { describe, expect, test } from "bun:test"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

// In Full access nothing the terminal tool adds blocks: its own asks are auto-approvable. A line it submits asks what
// the shell's scan asks, so network_command and the cloud prompts still ask every time.
describe("terminal permission policy", () => {
  test("names the terminal permissions and the patterns that tell own terminals from others", () => {
    expect(PermissionPolicy.TERMINAL).toBe("terminal")
    expect(PermissionPolicy.TERMINAL_INPUT).toBe("terminal_input")
    expect(`${PermissionPolicy.TERMINAL_OWN}pty_1`).toBe("own:pty_1")
    expect(`${PermissionPolicy.TERMINAL_OTHER}pty_1`).toBe("other:pty_1")
  })

  test("the agent's own terminals are auto-approvable; the user's and other sessions' only by the user", () => {
    for (const permission of [PermissionPolicy.TERMINAL, PermissionPolicy.TERMINAL_INPUT]) {
      for (const pattern of ["own:pty_1", "other:pty_1"]) {
        expect(PermissionPolicy.requiresApproval(permission, [pattern], [pattern])).toBe(false)
        // The user may still allow one terminal always, by its id.
        expect(PermissionPolicy.canAlwaysApprove(permission, [pattern], [pattern])).toBe(true)
      }
      expect(PermissionPolicy.canAutoApprove(permission, ["own:pty_1"], ["own:pty_1"])).toBe(true)
      // Full access or auto-accept never reads or types into the user's ssh session on its own.
      expect(PermissionPolicy.canAutoApprove(permission, ["other:pty_1"], ["other:pty_1"])).toBe(false)
    }
    // The shell tool's own ask when its sandbox fails is unchanged; a terminal asks under its own permission.
    expect(PermissionPolicy.canAutoApprove("unsandboxed_shell", [process.platform], [process.platform])).toBe(true)
    expect(PermissionPolicy.canAutoApprove(PermissionPolicy.TERMINAL_UNSANDBOXED, [], [process.platform])).toBe(false)
  })

  test("a submitted line's network check still asks every time", () => {
    expect(PermissionPolicy.canAutoApprove(PermissionPolicy.NETWORK_COMMAND, [], ["curl https://example.com"])).toBe(
      false,
    )
  })
})
