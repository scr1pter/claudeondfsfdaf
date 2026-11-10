import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Pty } from "@vectordevai/core/pty"

const sample = (pid: number) => ({
  id: "pty_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
  title: "demo",
  command: "cmd.exe",
  args: [],
  cwd: "C:\\",
  status: "running",
  pid,
})

describe("Pty.Info", () => {
  test("accepts pid 0 (Windows ConPTY assigns the pid asynchronously)", () => {
    expect(Schema.decodeUnknownSync(Pty.Info)(sample(0)).pid).toBe(0)
  })

  test("accepts a positive pid", () => {
    expect(Schema.decodeUnknownSync(Pty.Info)(sample(48012)).pid).toBe(48012)
  })

  test("rejects a negative pid", () => {
    expect(() => Schema.decodeUnknownSync(Pty.Info)(sample(-1))).toThrow()
  })

  test("accepts an exit code for retained exited sessions", () => {
    const info = Schema.decodeUnknownSync(Pty.Info)({ ...sample(48012), status: "exited", exitCode: 4 })
    expect(info.exitCode).toBe(4)
  })

  test("decodes and encodes an agent owner, and leaves the key off a user terminal", () => {
    const owner = { kind: "agent" as const, sessionID: "ses_agent" }
    const agent = Schema.decodeUnknownSync(Pty.Info)({ ...sample(48012), owner })
    expect(agent.owner).toEqual(owner)
    expect(Schema.encodeSync(Pty.Info)(agent).owner).toEqual(owner)
    const user = Schema.decodeUnknownSync(Pty.Info)(sample(48012))
    expect("owner" in user).toBe(false)
    expect("owner" in Schema.encodeSync(Pty.Info)(user)).toBe(false)
  })

  test("rejects an owner that is not an agent", () => {
    expect(() =>
      Schema.decodeUnknownSync(Pty.Info)({ ...sample(48012), owner: { kind: "user", sessionID: "ses_agent" } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Pty.Info)({ ...sample(48012), owner: { kind: "agent" } })).toThrow()
  })
})
