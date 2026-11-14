import { expect, test } from "bun:test"
import {
  backgroundTracker,
  nextBackgroundEvent,
  trackConnect,
  trackShell,
  waitingFor,
} from "@/cli/cmd/run/background-wait"

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

// Background VectorScope reviews (connect, CW-08): the connect call whose saved run went on in the background, then the
// run's quiet note in the run's session. The ended run the review writes back into the call's part settles nothing.
const reviewCall = (runID: string, status: string, background = true) => ({
  type: "tool",
  tool: "connect",
  messageID: "msg_1",
  state: {
    status: "completed",
    metadata: { connect: { id: runID, status, request: { action: "review", background } } },
  },
})
const reviewNote = (runID: string, state: string, messageID: string, quiet = true) => ({
  type: "text",
  messageID,
  synthetic: true,
  metadata: { connectNotification: { runID, state, ...(quiet ? { quiet: true } : {}) }, taskQuiet: quiet },
})

test("a run waits for a background review until its note, which is quiet and starts no turn", () => {
  const tracker = backgroundTracker()
  expect(trackConnect(tracker, reviewCall("cr_one", "running"))).toBe(true)
  expect(tracker.running.has("cr_one")).toBe(true)
  expect(tracker.settled()).toBe(false)
  expect(waitingFor(tracker)).toBe("1 background review(s)")
  // The review writes its ended run into the call's part before its note: still waiting.
  expect(trackConnect(tracker, reviewCall("cr_one", "done"))).toBe(true)
  expect(tracker.settled()).toBe(false)
  expect(trackConnect(tracker, reviewNote("cr_one", "completed", "msg_5"))).toBe(true)
  expect(tracker.settled()).toBe(true)
  // A repeated part changes nothing.
  trackConnect(tracker, reviewCall("cr_one", "running"))
  expect(tracker.settled()).toBe(true)
})

test("a review its call reported, a foreground one, or another tool's part is not waited for", () => {
  const tracker = backgroundTracker()
  // Ended before its call returned: the call reported it, and no note follows.
  expect(trackConnect(tracker, reviewCall("cr_quick", "done"))).toBe(true)
  expect(trackConnect(tracker, reviewCall("cr_front", "running", false))).toBe(false)
  expect(trackConnect(tracker, { type: "tool", tool: "connect", state: { status: "completed", metadata: {} } })).toBe(
    false,
  )
  expect(trackConnect(tracker, { ...reviewCall("ses_x", "running") })).toBe(false)
  expect(trackConnect(tracker, { ...reviewCall("cr_two", "running"), state: { status: "running" } })).toBe(false)
  expect(trackConnect(tracker, started("shl_a"))).toBe(false)
  expect(trackShell(tracker, reviewCall("cr_two", "running"))).toBe(false)
  expect(tracker.settled()).toBe(true)
})

test("a note may come before the call's part, a waking note waits for its answer, and the timeout counts reviews", () => {
  const early = backgroundTracker()
  trackConnect(early, reviewNote("cr_fast", "cancelled", "msg_2"))
  trackConnect(early, reviewCall("cr_fast", "running"))
  expect(early.running.has("cr_fast")).toBe(false)
  expect(early.settled()).toBe(true)

  const waking = backgroundTracker()
  trackConnect(waking, reviewCall("cr_wake", "running"))
  trackConnect(waking, reviewNote("cr_wake", "completed", "msg_3", false))
  expect(waking.settled()).toBe(false)
  waking.answer("msg_4")
  expect(waking.settled()).toBe(true)

  const mixed = backgroundTracker()
  mixed.status("ses_child", "running", 1)
  trackShell(mixed, started("shl_a"))
  trackConnect(mixed, reviewCall("cr_a", "running"))
  trackConnect(mixed, reviewCall("cr_b", "running"))
  expect(waitingFor(mixed)).toBe("1 background subagent(s) and 1 background command(s) and 2 background review(s)")
})
