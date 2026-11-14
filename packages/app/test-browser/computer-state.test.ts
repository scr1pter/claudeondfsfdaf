import { afterEach, describe, expect, spyOn, test, vi } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import type { Computer } from "@vectordevai/schema/computer"
import { createFakeComputer } from "@/features/computer/fake-platform"
import { createComputerState, type ComputerStateInput } from "@/features/computer/use-computer-state"

/*
 * The shared Hands state behind the Tasks card, the Tasks dot and the composer line. The desktop's own state wins
 * whenever the desktop owns the run; otherwise the engine's computer.state event is used, but only while its holder
 * works, and never for longer than the engine stays quiet. Real fake platform, real event emitter; the silence wait
 * runs on fake timers.
 */

const HOLDER = "ses_holder"
const OTHER = "ses_other"
const QUEUED = "ses_queued"

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID: HOLDER, directory: "/repo", title: "Receipts", startedAt: 1000, actions: 3 },
    apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: "⌘⇧Esc",
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => wait(0)

function setup(input: Partial<ComputerStateInput> = {}) {
  const engine = createGlobalEmitter<{ "computer.state": { sessionID: string; state: unknown } }>()
  let subscribed = 0
  // A session missing here is one whose status the page has never seen.
  const [working, setWorking] = createSignal<Record<string, boolean>>({ [HOLDER]: true })
  const result = createRoot((dispose) => ({
    dispose,
    value: createComputerState({
      listen: (cb) => {
        subscribed++
        const stop = engine.on("computer.state", cb)
        return () => {
          subscribed--
          stop()
        }
      },
      working: (sessionID) => working()[sessionID],
      ...input,
    }),
  }))
  return {
    ...result,
    publish: (sessionID: string, next: unknown) => engine.emit("computer.state", { sessionID, state: next }),
    setWorking,
    subscribed: () => subscribed,
  }
}

describe("createComputerState", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("the desktop's state wins and engine events are ignored", async () => {
    const desktop = createFakeComputer({ state: state({ phase: "ready", holder: undefined }) })
    const { value, publish, subscribed, dispose } = setup({ desktop })
    await settle()
    expect(value.state()?.phase).toBe("ready")
    expect(value.desktop).toBe(desktop)
    expect(subscribed()).toBe(0)
    publish(HOLDER, state({ step: "From the engine" }))
    expect(value.state()?.phase).toBe("ready")
    desktop.emit(state())
    expect(value.state()?.step).toBe("Clicking “Save” in Numbers")
    dispose()
  })

  test("a newer desktop event beats the answer of the first read", async () => {
    const desktop = createFakeComputer({ state: state({ phase: "ready", holder: undefined }) })
    const { value, dispose } = setup({ desktop })
    // The read started at mount answers after this event.
    desktop.emit(state({ phase: "paused", pause: "input" }))
    await settle()
    expect(value.state()?.phase).toBe("paused")
    dispose()
  })

  test("a failed first desktop read is reported and tried once more", async () => {
    // A pause that started before the page opened: the desktop publishes nothing until it changes.
    const fake = createFakeComputer({ state: state({ phase: "paused", pause: "input" }) })
    let reads = 0
    const desktop = {
      ...fake,
      state: () => (++reads === 1 ? Promise.reject(new Error("IPC closed")) : fake.state()),
    }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { value, dispose } = setup({ desktop, retryMs: 5 })
      await settle()
      expect(value.state()).toBeUndefined()
      expect(errors).toHaveBeenCalledTimes(1)
      await wait(10)
      expect(reads).toBe(2)
      expect(value.state()?.phase).toBe("paused")
      dispose()
    } finally {
      errors.mockRestore()
    }
  })

  test("after a second failed read the desktop's next event is the state, and nothing reads again", async () => {
    const fake = createFakeComputer()
    let reads = 0
    const desktop = {
      ...fake,
      state: () => {
        reads++
        return Promise.reject(new Error("IPC closed"))
      },
    }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { value, dispose } = setup({ desktop, retryMs: 5 })
      await wait(20)
      expect(reads).toBe(2)
      expect(errors).toHaveBeenCalledTimes(2)
      expect(value.state()).toBeUndefined()
      fake.emit(state({ phase: "paused", pause: "input" }))
      expect(value.state()?.phase).toBe("paused")
      await wait(20)
      expect(reads).toBe(2)
      dispose()
    } finally {
      errors.mockRestore()
    }
  })

  test("a desktop event during the retry wait cancels the retry, and so does disposing", async () => {
    const fake = createFakeComputer()
    let reads = 0
    const desktop = {
      ...fake,
      state: () => {
        reads++
        return Promise.reject(new Error("IPC closed"))
      },
    }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const first = setup({ desktop, retryMs: 5 })
      await settle()
      fake.emit(state())
      await wait(20)
      expect(reads).toBe(1)
      expect(first.value.state()?.phase).toBe("working")
      first.dispose()

      reads = 0
      const second = setup({ desktop, retryMs: 5 })
      await settle()
      second.dispose()
      await wait(20)
      expect(reads).toBe(1)
    } finally {
      errors.mockRestore()
    }
  })

  test("without the desktop, the holder's engine event is the state", () => {
    const { value, publish, dispose } = setup()
    expect(value.desktop).toBeUndefined()
    expect(value.state()).toBeUndefined()
    publish(HOLDER, state())
    expect(value.state()?.step).toBe("Clicking “Save” in Numbers")
    dispose()
  })

  test("engine state clears after the engine goes quiet, and each event restarts the wait", () => {
    vi.useFakeTimers()
    const { value, publish, dispose } = setup({ silenceMs: 60 })
    publish(HOLDER, state())
    vi.advanceTimersByTime(40)
    publish(HOLDER, state({ step: "Typing in Numbers" }))
    // Past the first event's wait: the second event restarted it.
    vi.advanceTimersByTime(59)
    expect(value.state()?.step).toBe("Typing in Numbers")
    vi.advanceTimersByTime(1)
    expect(value.state()).toBeUndefined()
    dispose()
  })

  test("engine state clears when the holder stops working, and a late event cannot bring it back", () => {
    const { value, publish, setWorking, dispose } = setup()
    publish(HOLDER, state())
    expect(value.state()).toBeDefined()
    setWorking({ [HOLDER]: false })
    expect(value.state()).toBeUndefined()
    // The engine's forked final publish lands after the turn ended.
    publish(HOLDER, state({ phase: "done" }))
    expect(value.state()).toBeUndefined()
    // A new turn does not resurrect the old state; it waits for its own event.
    setWorking({ [HOLDER]: true })
    expect(value.state()).toBeUndefined()
    publish(HOLDER, state({ step: "New turn" }))
    expect(value.state()?.step).toBe("New turn")
    dispose()
  })

  test("a holder the page has never seen counts while a conversation queued behind it works", () => {
    // The holder works in a directory this page has not loaded and was busy before the page connected.
    const queued = state({ queue: [{ sessionID: QUEUED, title: "Taxes" }] })
    const { value, publish, setWorking, dispose } = setup()
    setWorking({ [QUEUED]: true })
    publish(HOLDER, queued)
    expect(value.state()?.holder?.sessionID).toBe(HOLDER)
    expect(value.state()?.queue.map((item) => item.sessionID)).toEqual([QUEUED])
    // Once the holder is seen going idle, it never counts again, whatever the queue.
    setWorking({ [HOLDER]: false, [QUEUED]: true })
    expect(value.state()).toBeUndefined()
    publish(HOLDER, queued)
    expect(value.state()).toBeUndefined()
    dispose()
  })

  test("a holder the page has never seen is dropped when nothing queued behind it works", () => {
    const { value, publish, setWorking, dispose } = setup()
    setWorking({})
    publish(HOLDER, state())
    expect(value.state()).toBeUndefined()
    setWorking({ [QUEUED]: false })
    publish(HOLDER, state({ queue: [{ sessionID: QUEUED, title: "Taxes" }] }))
    expect(value.state()).toBeUndefined()
    // The queued conversation finishes: the state it kept visible goes with it.
    setWorking({ [QUEUED]: true })
    publish(HOLDER, state({ queue: [{ sessionID: QUEUED, title: "Taxes" }] }))
    expect(value.state()).toBeDefined()
    setWorking({ [QUEUED]: false })
    expect(value.state()).toBeUndefined()
    dispose()
  })

  test("a malformed or foreign engine event is dropped and the last good state stays", () => {
    const { value, publish, setWorking, dispose } = setup()
    publish(HOLDER, state())
    publish(HOLDER, { ...state(), queue: undefined })
    publish(HOLDER, { ...state(), apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Num‮bers" }] })
    publish(HOLDER, { ...state(), apps: [{ key: "x", name: "Numbers", icon: "javascript:alert(1)" }] })
    publish(HOLDER, "not a state")
    expect(value.state()?.step).toBe("Clicking “Save” in Numbers")
    // Another session's engine cannot speak for the holder.
    setWorking({ [HOLDER]: true, [OTHER]: true })
    publish(OTHER, state({ step: "Spoofed" }))
    expect(value.state()?.step).toBe("Clicking “Save” in Numbers")
    dispose()
  })

  test("disposing unsubscribes from the desktop and the engine", async () => {
    const desktop = createFakeComputer()
    const first = setup({ desktop })
    first.dispose()
    desktop.emit(state())
    await settle()
    expect(first.value.state()).toBeUndefined()

    const second = setup({ silenceMs: 20 })
    expect(second.subscribed()).toBe(1)
    second.publish(HOLDER, state())
    second.dispose()
    expect(second.subscribed()).toBe(0)
    second.publish(HOLDER, state({ step: "After dispose" }))
    expect(second.value.state()?.step).not.toBe("After dispose")
  })
})
