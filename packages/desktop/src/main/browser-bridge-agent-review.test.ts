import { EventEmitter } from "node:events"
import { describe, expect, mock, test } from "bun:test"

// The bridge loads the agent and research browsers, which load Electron at module load. Only the bridge's own handling
// of a call is under test here, so both stand in. Bun keeps a module mock for the rest of a run; the desktop suite runs
// each file in its own process.
mock.module("./browser-agent", () => ({ runBrowserAgent: async () => ({ ok: true }) }))
mock.module("./research-browser", () => ({ runResearchBrowser: async () => ({ ok: true }) }))

const { callerGone } = await import("./browser-bridge")

// A response as the bridge's server holds one: it closes once, sent or not.
const response = (writableFinished: boolean) =>
  Object.assign(new EventEmitter(), { writableFinished }) as unknown as Parameters<typeof callerGone>[0]

describe("a call to the agent browser", () => {
  test("whose response closed before it was sent has ended, so its command is given up", () => {
    const ended = response(false)
    const gone = callerGone(ended)
    expect(gone.aborted).toBe(false)
    ;(ended as unknown as EventEmitter).emit("close")
    expect(gone.aborted).toBe(true)
  })

  test("whose response was sent has not: a command that finished is no call that ended", () => {
    const sent = response(true)
    const gone = callerGone(sent)
    ;(sent as unknown as EventEmitter).emit("close")
    expect(gone.aborted).toBe(false)
  })
})
