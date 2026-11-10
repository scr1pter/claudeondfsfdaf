import { describe, expect, test } from "bun:test"
import { terminalPermissionScope } from "./terminal-permission-scope"

describe("terminal permission scope", () => {
  test("names the terminal and shows the text exactly as it would be typed, with Enter", () => {
    expect(
      terminalPermissionScope({
        permission: "terminal_input",
        metadata: { id: "pty_1", title: "zsh", text: "git push --force\nrm -rf build", enter: true },
      }),
    ).toEqual({
      terminal: "zsh (pty_1)",
      action: undefined,
      text: "git push --force\nrm -rf build",
      enter: true,
      keys: [],
    })
  })

  test("shows the keys a keys call would press", () => {
    expect(
      terminalPermissionScope({
        permission: "terminal_input",
        metadata: { id: "pty_2", title: "claude", keys: ["up", "enter", 3] },
      }),
    ).toEqual({ terminal: "claude (pty_2)", action: undefined, text: undefined, enter: false, keys: ["up", "enter"] })
  })

  test("names what a read, wait, resize or close would do to a terminal the agent did not open", () => {
    for (const action of ["read", "wait", "resize", "close"] as const)
      expect(
        terminalPermissionScope({ permission: "terminal", metadata: { action, id: "pty_3", title: " dev server " } }),
      ).toEqual({ terminal: "dev server (pty_3)", action, text: undefined, enter: false, keys: [] })
    expect(
      terminalPermissionScope({ permission: "terminal", metadata: { action: "type", id: "pty_3", text: "ls" } }),
    ).toEqual({ terminal: "pty_3", action: undefined, text: undefined, enter: false, keys: [] })
  })

  test("ignores other permissions and metadata that says nothing", () => {
    expect(terminalPermissionScope({ permission: "bash", metadata: { id: "pty_1", text: "ls" } })).toBeUndefined()
    expect(terminalPermissionScope({ permission: "terminal_input", metadata: { id: 1, text: 2 } })).toBeUndefined()
  })

  test("an empty line is still shown, so Enter alone is never approved blind", () => {
    expect(
      terminalPermissionScope({ permission: "terminal_input", metadata: { text: "", enter: true } }),
    ).toMatchObject({ text: "", enter: true })
  })
})
