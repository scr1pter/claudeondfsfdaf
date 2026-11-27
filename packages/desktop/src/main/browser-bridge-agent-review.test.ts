import { EventEmitter } from "node:events"
import { describe, expect, mock, test } from "bun:test"

// What the bridge handed the agent browser for each command as its third argument: the end of the engine's call.
const handed: (AbortSignal | undefined)[] = []

// The bridge loads the agent and research browsers, which load Electron at module load. Only the bridge's own handling
// of a call is under test here, so both stand in. Bun keeps a module mock for the rest of a run; the desktop suite runs
// each file in its own process.
mock.module("./browser-agent", () => ({
  runBrowserAgent: async (_event: unknown, _input: unknown, gone?: AbortSignal) => {
    handed.push(gone)
    return { ok: true }
  },
}))
mock.module("./research-browser", () => ({ runResearchBrowser: async () => ({ ok: true }) }))

const { callerGone, startBrowserBridge, stopBrowserBridge } = await import("./browser-bridge")

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

  // The desktop's own bridge on 127.0.0.1, reached with the address and token it makes for itself, as the engine reaches
  // it. Under Bun the server never emits a response's close when its client goes away (Electron's Node does, and that
  // close is what callerGone listens for), so the end itself is proven on callerGone above; here the bridge is shown to
  // hand each agent command that end.
  test("over the bridge, each agent command is handed the end of its call", async () => {
    const bridge = await startBrowserBridge()
    try {
      handed.length = 0
      const answered = await fetch(`${bridge.url}/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ contextId: "ses_bridge", command: "openUrl", url: "http://localhost:3000/" }),
      })
      expect(answered.status).toBe(200)
      expect(await answered.json()).toEqual({ ok: true })
      expect(handed).toHaveLength(1)
      expect(handed[0]).toBeInstanceOf(AbortSignal)
      expect(handed[0]!.aborted).toBe(false)
    } finally {
      await stopBrowserBridge()
    }
  })
})
