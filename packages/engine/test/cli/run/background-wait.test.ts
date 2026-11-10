import { expect, test } from "bun:test"
import { backgroundTracker, nextBackgroundEvent, trackShell, waitingFor } from "@/cli/cmd/run/background-wait"

test("background wait expires even when an event stream goes silent", async () => {
  const pending = Promise.withResolvers<IteratorResult<string>>()
  expect(await nextBackgroundEvent({ next: () => pending.promise }, 10)).toEqual({ timedOut: true })
  pending.resolve({ value: "late event", done: false })
})

test("an event wins without waiting out the background timeout", async () => {
  const pending = Promise.withResolvers<IteratorResult<string>>()
  const result = nextBackgroundEvent({ next: () => pending.promise }, 10_000)
  pending.resolve({ value: "completed", done: false })
  expect(await result).toEqual({ timedOut: false, disconnected: false, event: { value: "completed", done: false } })
})

test("a normal end and unbounded active provider stream preserve their result", async () => {
  expect(await nextBackgroundEvent({ next: async () => ({ value: undefined, done: true }) })).toEqual({
    timedOut: false,
    disconnected: false,
    event: { value: undefined, done: true },
  })
})

test("an ended stream with an unfinished parent or child is a disconnect, never completion", async () => {
  expect(await nextBackgroundEvent({ next: async () => ({ value: undefined, done: true }) }, 10_000, true)).toEqual({
    timedOut: false,
    disconnected: true,
  })
})

// Background commands (5.H): the shell call that started one, then its exit note in the run's session.
const started = (shellID: string) => ({
  type: "tool",
  tool: "bash",
  messageID: "msg_1",
  state: { status: "completed", metadata: { background: true, shellID, output: "" } },
})
const exited = (shellID: string, state: string, messageID: string, quiet = false) => ({
  type: "text",
  messageID,
  synthetic: true,
  metadata: { shellNotification: { shellID, state }, ...(quiet ? { taskQuiet: true } : {}) },
})

test("a run waits for a background command until the turn that answers its exit note", () => {
  const tracker = backgroundTracker()
  expect(trackShell(tracker, started("shl_one"))).toBe(true)
  expect(tracker.running.has("shl_one")).toBe(true)
  expect(tracker.settled()).toBe(false)
  expect(waitingFor(tracker)).toBe("1 background command(s)")
  expect(trackShell(tracker, exited("shl_one", "completed", "msg_5"))).toBe(true)
  // The note wakes the parent: the run waits for the turn that reads it.
  expect(tracker.settled()).toBe(false)
  tracker.answer("msg_6")
  expect(tracker.settled()).toBe(true)
  // A repeated part changes nothing.
  trackShell(tracker, started("shl_one"))
  expect(tracker.settled()).toBe(true)
})

test("a stopped or quietly noted command settles at its note, and a note may come before the call's part", () => {
  const stopped = backgroundTracker()
  trackShell(stopped, started("shl_stop"))
  trackShell(stopped, exited("shl_stop", "stopped", "msg_3", true))
  expect(stopped.settled()).toBe(true)

  const early = backgroundTracker()
  trackShell(early, exited("shl_fast", "failed", "msg_2"))
  trackShell(early, started("shl_fast"))
  expect(early.running.has("shl_fast")).toBe(false)
  expect(early.settled()).toBe(false)
  early.answer("msg_4")
  expect(early.settled()).toBe(true)
})

test("only a background shell call or a command's note is tracked, and the timeout counts both kinds", () => {
  const tracker = backgroundTracker()
  expect(trackShell(tracker, { type: "tool", state: { status: "completed", metadata: { output: "" } } })).toBe(false)
  expect(
    trackShell(tracker, {
      type: "tool",
      state: { status: "running", metadata: { background: true, shellID: "shl_x" } },
    }),
  ).toBe(false)
  expect(
    trackShell(tracker, {
      type: "tool",
      state: { status: "completed", metadata: { background: true, sessionId: "ses_child" } },
    }),
  ).toBe(false)
  expect(
    trackShell(tracker, { type: "text", messageID: "msg_1", metadata: { taskNotification: { taskID: "ses_child" } } }),
  ).toBe(false)
  expect(tracker.settled()).toBe(true)
  expect(waitingFor(tracker)).toBe("0 background subagent(s)")
  tracker.status("ses_child", "running", 1)
  trackShell(tracker, started("shl_a"))
  trackShell(tracker, started("shl_b"))
  expect(waitingFor(tracker)).toBe("1 background subagent(s) and 2 background command(s)")
})
