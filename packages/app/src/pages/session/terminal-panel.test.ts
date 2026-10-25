import { describe, expect, test } from "bun:test"
import { typingTerminal } from "./helpers"
import { terminalTabLabel } from "./terminal-label"

const t = (key: string, vars?: Record<string, string | number | boolean>) => {
  if (key === "terminal.title.numbered") return `Terminal ${vars?.number}`
  if (key === "terminal.title") return "Terminal"
  return key
}

describe("terminalTabLabel", () => {
  test("returns custom title unchanged", () => {
    const label = terminalTabLabel({ title: "server", titleNumber: 3, t })
    expect(label).toBe("server")
  })

  test("normalizes default numbered title", () => {
    const label = terminalTabLabel({ title: "Terminal 2", titleNumber: 2, t })
    expect(label).toBe("Terminal 2")
  })

  test("falls back to generic title", () => {
    const label = terminalTabLabel({ title: "", titleNumber: 0, t })
    expect(label).toBe("Terminal")
  })
})

describe("typingTerminal", () => {
  const tabs = [{ id: "pty_user" }, { id: "pty_agent", agent: "ses_agent" }]

  test("sends typing outside a field to the user's active terminal", () => {
    expect(typingTerminal(tabs, "pty_user")).toBe("pty_user")
  })

  test("never sends a stray keystroke into an agent's terminal", () => {
    expect(typingTerminal(tabs, "pty_agent")).toBeUndefined()
    expect(typingTerminal(tabs, undefined)).toBeUndefined()
  })
})
