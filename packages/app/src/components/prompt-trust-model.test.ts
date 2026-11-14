import { describe, expect, test } from "bun:test"
import { approval, outcome, refreshes } from "./prompt-trust-model"

// The prompt-trust banner: it reads the held list again whenever the hold may have changed, and Approve names back
// exactly what it showed, so a file held or changed after the list was read is never approved unseen.

describe("the prompt-trust banner", () => {
  test("reads the list again after an instance reload, a server restart or a reconnect, and on nothing else", () => {
    expect(refreshes("server.instance.disposed")).toBe(true)
    expect(refreshes("global.disposed")).toBe(true)
    expect(refreshes("server.connected")).toBe(true)
    expect(refreshes("session.idle")).toBe(false)
    expect(refreshes(undefined)).toBe(false)
  })

  test("approves the files it showed, with their fingerprints, and says when the list changed", () => {
    expect(approval([{ path: "/home/me/.config/vector/AGENTS.md", fingerprint: "ab" }, { path: "/gone.md" }])).toEqual({
      files: [{ path: "/home/me/.config/vector/AGENTS.md", fingerprint: "ab" }, { path: "/gone.md" }],
    })
    expect(outcome(200)).toBe("approved")
    expect(outcome(409)).toBe("changed")
    expect(outcome(403)).toBe("failed")
    expect(outcome(0)).toBe("failed")
  })
})
