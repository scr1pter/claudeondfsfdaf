import { afterEach, describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { manualClock } from "../../test/computer/fake-helper"
import { ComputerError } from "./computer-bridge"
import type { SessionScope, TypingWait } from "./computer-session"
import { classify, createComputerTakeover, validateChord } from "./computer-takeover"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const activePhases = ["working", "waiting", "asking", "handoff", "paused"] as const

describe("physical input classification", () => {
  const foreground = { mode: "foreground", phase: "working", inTarget: true, escStops: true } as const
  test("DIP threshold includes diagonal movement and missing deltas fail closed", () => {
    expect(classify({ ...foreground, kind: "pointer", dx: 7, dy: 0 })).toBe("ignore")
    expect(classify({ ...foreground, kind: "pointer", dx: 8, dy: 0 })).toBe("pause")
    expect(classify({ ...foreground, kind: "pointer", dx: -8, dy: 0 })).toBe("pause")
    expect(classify({ ...foreground, kind: "pointer", dx: 6, dy: 6 })).toBe("pause")
    expect(classify({ ...foreground, kind: "pointer", dx: 7 })).toBe("pause")
    expect(classify({ ...foreground, kind: "pointer", dy: 0 })).toBe("pause")
    expect(classify({ ...foreground, kind: "pointer", dx: NaN, dy: 0 })).toBe("pause")
  })
  for (const kind of ["key", "click", "scroll"] as const)
    test(`foreground ${kind} pauses synchronously`, () => {
      expect(classify({ ...foreground, kind, inTarget: false })).toBe("pause")
      expect(classify({ ...foreground, kind, phase: "paused" })).toBe("ignore")
    })
  test("tags are ignored before movement, chord and Escape classification", () => {
    for (const kind of ["pointer", "key", "click", "scroll", "esc", "chord"] as const)
      expect(classify({ ...foreground, kind, tagged: true, dx: 100, dy: 100 })).toBe("ignore")
  })
  test("background keys wait only for their target or an unknown relation", () => {
    expect(classify({ ...foreground, mode: "background", kind: "key" })).toBe("wait")
    expect(classify({ ...foreground, mode: "background", kind: "key", inTarget: undefined })).toBe("wait")
    expect(classify({ ...foreground, mode: "background", kind: "key", inTarget: false })).toBe("ignore")
    expect(classify({ ...foreground, mode: "background", kind: "key", phase: "waiting" })).toBe("wait")
    expect(classify({ ...foreground, mode: "background", kind: "key", phase: "asking" })).toBe("ignore")
    expect(classify({ ...foreground, mode: "background", kind: "pointer", dx: 100, dy: 100 })).toBe("ignore")
    expect(classify({ ...foreground, mode: "background", kind: "click" })).toBe("pause")
  })
  test("Escape stops only while its hint is true; chord works in every active phase", () => {
    for (const phase of activePhases) {
      expect(classify({ ...foreground, phase, kind: "chord" })).toBe("stop")
      expect(classify({ ...foreground, phase, kind: "esc" })).toBe(phase === "working" ? "stop" : "ignore")
    }
    expect(classify({ ...foreground, kind: "esc", escStops: false })).toBe("ignore")
    expect(classify({ ...foreground, kind: "esc", mode: "background" })).toBe("ignore")
    for (const phase of ["off", "setup", "ready", "done", "stopped"] as const)
      expect(classify({ ...foreground, phase, kind: "chord" })).toBe("ignore")
  })
})

describe("stop chord validation", () => {
  test("both product defaults are usable and aliases/modifier order canonicalize", () => {
    expect(validateChord(Hands.STOP_CHORD.darwin, "darwin")).toBe(Hands.STOP_CHORD.darwin)
    expect(validateChord(Hands.STOP_CHORD.win32, "win32")).toBe(Hands.STOP_CHORD.win32)
    expect(validateChord(" shift + cmd + esc ", "darwin")).toBe("Command+Shift+Escape")
    expect(validateChord("Shift+CmdOrCtrl+K", "win32")).toBe("Control+Shift+K")
    expect(validateChord("Shift+CommandOrControl+K", "darwin")).toBe("Command+Shift+K")
    expect(validateChord("shift+control+alt+escape", "win32")).toBe(Hands.STOP_CHORD.win32)
  })
  test("VoiceOver and known reserved OS accelerators are refused", () => {
    for (const chord of [
      "Ctrl+Option+K",
      "Command+Control+Option+K",
      "Command+Space",
      "Command+Option+Escape",
      "Command+Shift+4",
      "Control+Command+Q",
    ])
      expect(validateChord(chord, "darwin")).toBeUndefined()
    for (const chord of [
      "Control+Alt+Delete",
      "Control+Shift+Escape",
      "Alt+Shift+Tab",
      "Super+Shift+L",
      "Control+Alt+End",
    ])
      expect(validateChord(chord, "win32")).toBeUndefined()
  })
  test("unmodified, one-modifier, duplicate, malformed and control-containing input is refused", () => {
    for (const chord of [
      "",
      "Escape",
      "F9",
      "Ctrl+C",
      "Shift+K",
      "Ctrl+Shift",
      "Ctrl++K",
      "Ctrl+Ctrl+K",
      "Cmd+Meta+K",
      "Control+Shift+K+L",
      "Ctrl+Shift+Unknown",
      "Ctrl+Shift+K\n",
      "Ctrl+Shift+\u202eK",
    ])
      expect(validateChord(chord, "darwin")).toBeUndefined()
  })
})

function fixture(
  platform: "darwin" | "win32" = "win32",
  options: {
    external?: string
    fail?: string
    throws?: "register" | "isRegistered"
    diagnosticThrows?: boolean
    stopEsc?: boolean
  } = {},
) {
  const clock = manualClock(1000)
  const callbacks = new Set<(view: Computer.ComputerState) => void>()
  const events = new Set<(event: Computer.HelperEvent) => void>()
  const shortcuts = new Map<string, () => void>()
  const previous: { chord: string; callback: () => void }[] = []
  const unregistered: string[] = []
  const unavailable: string[] = []
  const state = {
    scope: { rootSessionID: "ses_0", sessionID: "ses_0", directory: "/virtual", lease: 0 } as SessionScope,
    view: {
      phase: "ready",
      backend: platform === "win32" ? "local-windows" : "local-macos",
      mode: "foreground",
      apps: [],
      queue: [],
      escStops: false,
      stopChord: Hands.STOP_CHORD[platform],
      lease: 0,
      reduceMotion: false,
    } as Computer.ComputerState,
    revision: 0,
    waiting: undefined as TypingWait | undefined,
    pauses: [] as { reason: Computer.PauseReason; at: number }[],
    stops: 0,
    continued: [] as TypingWait[],
    forwarded: [] as Computer.HelperEvent[],
    unregistrationThrows: undefined as string | undefined,
  }
  const publish = (patch: Partial<Computer.ComputerState>) => {
    state.view = { ...state.view, ...patch }
    state.view = { ...state.view, escStops: state.view.phase === "working" && state.view.mode === "foreground" }
    for (const callback of [...callbacks]) callback(structuredClone(state.view))
  }
  const controller = {
    state: () => structuredClone(state.view),
    scope(scope: Pick<SessionScope, "rootSessionID" | "sessionID" | "directory" | "lease">) {
      if (
        !state.view.holder ||
        Object.keys(state.scope).some(
          (key) => scope[key as keyof SessionScope] !== state.scope[key as keyof SessionScope],
        )
      )
        throw new ComputerError("stopped", "The test lease ended")
      return { ...state.scope }
    },
    subscribe(callback: (view: Computer.ComputerState) => void) {
      callbacks.add(callback)
      return () => void callbacks.delete(callback)
    },
    async pause(reason: Computer.PauseReason) {
      state.pauses.push({ reason, at: clock.now() })
      state.waiting = undefined
      state.revision++
      publish({ phase: "paused", pause: reason })
    },
    async stop() {
      state.stops++
      state.waiting = undefined
      state.revision++
      publish({ phase: "stopped", holder: undefined })
    },
    helperEvent(value: Computer.HelperEvent) {
      state.forwarded.push(value)
      if (value.event === "input_detection" && !value.alive && state.view.mode === "foreground")
        void controller.pause(value.reason === "secure_input" ? "secure_input" : "detection")
      if (value.event === "stop" && state.view.holder && (value.by === "chord" || state.view.escStops))
        void controller.stop()
    },
    waitForInput(_app?: string): TypingWait | undefined {
      if (
        state.view.mode !== "background" ||
        !state.view.holder ||
        (state.view.phase !== "working" && !(state.view.phase === "waiting" && state.waiting))
      )
        return
      if (state.waiting) return state.waiting
      const wait = { scope: { ...state.scope }, generation: ++state.revision }
      state.waiting = wait
      publish({ phase: "waiting" })
      return wait
    },
    async continueAfterInput(wait: TypingWait) {
      state.continued.push(wait)
      if (
        wait !== state.waiting ||
        wait.scope.lease !== state.scope.lease ||
        wait.generation !== state.revision ||
        state.view.phase !== "waiting" ||
        state.view.mode !== "background"
      )
        return false
      state.waiting = undefined
      publish({ phase: "working" })
      return true
    },
  }
  const external = () => {}
  if (options.external) shortcuts.set(options.external, external)
  const takeover = createComputerTakeover({
    platform,
    controller,
    clock,
    backend: {
      capabilities: () => ({ actions: [], features: { "stop.esc": options.stopEsc !== false } }),
      onEvent(callback) {
        events.add(callback)
        return () => void events.delete(callback)
      },
    },
    shortcuts: {
      register(chord, callback) {
        if (options.throws === "register") throw new Error("Virtual registration failure")
        if (options.fail === chord || shortcuts.has(chord)) return false
        shortcuts.set(chord, callback)
        previous.push({ chord, callback })
        return true
      },
      isRegistered(chord) {
        if (options.throws === "isRegistered") throw new Error("Virtual registration query failure")
        return shortcuts.has(chord)
      },
      unregister(chord) {
        unregistered.push(chord)
        if (state.unregistrationThrows === chord) throw new Error("Virtual unregistration failure")
        shortcuts.delete(chord)
      },
    },
    onUnavailable(reason) {
      unavailable.push(reason)
      if (options.diagnosticThrows) throw new Error("Virtual diagnostic failure")
    },
  })
  cleanups.push(takeover.close)
  return {
    takeover,
    controller,
    clock,
    state,
    shortcuts,
    previous,
    unregistered,
    unavailable,
    events,
    start(mode: Computer.Mode = "foreground", chord = Hands.STOP_CHORD[platform]) {
      const lease = state.scope.lease + 1
      state.scope = { rootSessionID: `ses_${lease}`, sessionID: `ses_${lease}`, directory: "/virtual", lease }
      state.waiting = undefined
      state.revision++
      publish({
        phase: "working",
        mode,
        lease,
        stopChord: chord,
        pause: undefined,
        holder: {
          sessionID: state.scope.rootSessionID,
          directory: "/virtual",
          title: "Virtual task",
          startedAt: 1,
          actions: 0,
        },
      })
      return { ...state.scope }
    },
    phase(phase: Computer.ComputerPhase) {
      state.waiting = undefined
      state.revision++
      publish({ phase })
    },
    emit(value: Computer.HelperEvent) {
      for (const callback of [...events]) callback(value)
    },
  }
}

describe("shortcut ownership and Esc suspension", () => {
  test("Windows reserves the chord through every active phase and Escape only while working in foreground", () => {
    const f = fixture()
    expect(f.shortcuts.size).toBe(0)
    f.start()
    expect([...f.shortcuts.keys()].sort()).toEqual(["Control+Alt+Shift+Escape", "Escape"])
    for (const phase of ["waiting", "asking", "handoff", "paused"] as const) {
      f.phase(phase)
      expect(f.shortcuts.has("Control+Alt+Shift+Escape")).toBe(true)
      expect(f.shortcuts.has("Escape")).toBe(false)
    }
    f.phase("working")
    expect(f.shortcuts.has("Escape")).toBe(true)
    f.phase("done")
    expect(f.shortcuts.size).toBe(0)
  })
  test("Escape is nested and stale registration callbacks cannot stop synthetic Escape or a successor", () => {
    const f = fixture()
    f.start()
    const oldEscape = f.shortcuts.get("Escape")!
    const releaseA = f.takeover.suspendEsc()
    const releaseB = f.takeover.suspendEsc()
    expect(f.shortcuts.has("Escape")).toBe(false)
    releaseA()
    expect(f.shortcuts.has("Escape")).toBe(false)
    releaseB()
    expect(f.shortcuts.has("Escape")).toBe(true)
    oldEscape()
    expect(f.state.stops).toBe(0)
    const stale = f.takeover.suspendEsc()
    const oldChord = f.shortcuts.get(Hands.STOP_CHORD.win32)!
    f.phase("stopped")
    f.start()
    const current = f.takeover.suspendEsc()
    stale()
    oldChord()
    expect(f.state.stops).toBe(0)
    expect(f.shortcuts.has("Escape")).toBe(false)
    current()
    expect(f.shortcuts.has("Escape")).toBe(true)
  })
  test("a suspension release cannot register Escape after Stop", async () => {
    const f = fixture()
    f.start()
    const release = f.takeover.suspendEsc()
    f.shortcuts.get(Hands.STOP_CHORD.win32)!()
    expect(f.state.stops).toBe(1)
    release()
    f.takeover.resumeEsc()
    expect(f.shortcuts.size).toBe(0)
  })
  test("Mac relies on native Escape and pauses when that capability is absent", () => {
    const good = fixture("darwin")
    good.start()
    expect([...good.shortcuts.keys()]).toEqual([Hands.STOP_CHORD.darwin])
    const missing = fixture("darwin", { stopEsc: false })
    missing.start()
    expect(missing.state.view.phase).toBe("paused")
    expect(missing.state.view.escStops).toBe(false)
    expect(missing.state.pauses.at(-1)?.reason).toBe("detection")
  })
  for (const failure of ["conflict", "register", "isRegistered"] as const)
    test(`${failure} cannot leave a working run without its stop chord`, () => {
      const f = fixture("win32", failure === "conflict" ? { external: Hands.STOP_CHORD.win32 } : { throws: failure })
      f.start()
      expect(f.state.view.phase).toBe("stopped")
      expect(f.state.stops).toBe(1)
      expect(f.unavailable).toContain("chord_unavailable")
      expect(f.unregistered).not.toContain(Hands.STOP_CHORD.win32)
    })
  test("a failed diagnostic callback cannot retain authority", () => {
    const f = fixture("win32", { fail: Hands.STOP_CHORD.win32, diagnosticThrows: true })
    expect(() => f.start()).not.toThrow()
    expect(f.state.view.phase).toBe("stopped")
  })
  test("unowned Escape is preserved while its registration failure pauses input", () => {
    const f = fixture("win32", { external: "Escape" })
    f.start()
    expect(f.state.view.phase).toBe("paused")
    expect(f.shortcuts.has(Hands.STOP_CHORD.win32)).toBe(true)
    expect(f.shortcuts.has("Escape")).toBe(true)
    f.takeover.close()
    expect(f.unregistered).not.toContain("Escape")
    expect(f.shortcuts.has("Escape")).toBe(true)
  })
  test("unregister failure stops authority and stale callback remains inert", () => {
    const f = fixture()
    f.start()
    const callback = f.shortcuts.get("Escape")!
    f.state.unregistrationThrows = "Escape"
    f.takeover.suspendEsc()
    expect(f.state.view.phase).toBe("stopped")
    const stops = f.state.stops
    callback()
    expect(f.state.stops).toBe(stops)
    expect(f.shortcuts.has("Escape")).toBe(true)
  })
})

describe("physical priority and scoped quiet waits", () => {
  test("foreground movement pauses immediately and native detection events reach the controller", () => {
    const f = fixture()
    f.start()
    f.emit({ event: "user_input", kind: "pointer", dx: 7, dy: 0, pid: 500 })
    expect(f.state.pauses).toEqual([])
    f.emit({ event: "user_input", kind: "pointer", dx: 8, dy: 0, pid: 500 })
    expect(f.state.pauses).toEqual([{ reason: "input", at: 1000 }])
    f.phase("working")
    f.emit({ event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" })
    expect(f.state.pauses.at(-1)?.reason).toBe("secure_input")
    expect(f.state.forwarded.at(-1)).toMatchObject({ event: "input_detection", holder: "Notes" })
  })
  test("keys before the first target are remembered and block its proof boundary until two seconds quiet", async () => {
    const f = fixture("darwin")
    const scope = f.start("background")
    f.emit({ event: "user_input", kind: "key", pid: 500 })
    expect(f.state.view.phase).toBe("working")
    expect(() => f.takeover.target(scope, { pid: 500, name: "Notes" })).toThrow()
    expect(f.state.view.phase).toBe("waiting")
    f.clock.advance(1999)
    expect(f.state.continued).toHaveLength(0)
    f.emit({ event: "user_input", kind: "key", pid: 500 })
    f.clock.advance(1999)
    expect(f.state.continued).toHaveLength(0)
    f.clock.advance(1)
    await Promise.resolve()
    expect(f.state.continued).toHaveLength(1)
    expect(f.state.view.phase).toBe("working")
    expect(() => f.takeover.target(scope, { pid: 500, name: "Notes" })).not.toThrow()
  })
  test("other-app keys do not delay the current target; missing PID is a bounded wildcard", async () => {
    const f = fixture("darwin")
    const scope = f.start("background")
    f.takeover.target(scope, { pid: 500, name: "Notes" })
    f.emit({ event: "user_input", kind: "key", pid: 501 })
    expect(f.state.view.phase).toBe("working")
    f.emit({ event: "user_input", kind: "key" })
    expect(f.state.view.phase).toBe("waiting")
    f.clock.advance(2000)
    await Promise.resolve()
    expect(f.state.view.phase).toBe("working")
  })
  test("history exhaustion conservatively guards a newly selected target", () => {
    const f = fixture("darwin")
    const scope = f.start("background")
    for (let pid = 1; pid <= 257; pid++) f.emit({ event: "user_input", kind: "key", pid })
    expect(() => f.takeover.target(scope, { pid: 999, name: "Next app" })).toThrow()
    expect(f.state.view.phase).toBe("waiting")
  })
  for (const phase of ["paused", "asking", "handoff"] as const)
    test(`a quiet timer never resumes an external ${phase} state`, async () => {
      const f = fixture("darwin")
      const scope = f.start("background")
      f.takeover.target(scope, { pid: 500, name: "Notes" })
      f.emit({ event: "user_input", kind: "key", pid: 500 })
      f.phase(phase)
      f.clock.advance(5000)
      await Promise.resolve()
      expect(f.state.view.phase).toBe(phase)
      expect(f.state.continued).toHaveLength(0)
    })
  test("old wait timers and old target callbacks cannot change a successor", async () => {
    const f = fixture("darwin")
    const old = f.start("background")
    f.takeover.target(old, { pid: 500, name: "Notes" })
    f.emit({ event: "user_input", kind: "key", pid: 500 })
    const next = f.start("background")
    expect(() => f.takeover.target(old, { pid: 500, name: "Old task" })).toThrow()
    f.takeover.target(next, { pid: 501, name: "Next task" })
    f.clock.advance(5000)
    await Promise.resolve()
    expect(f.state.view.lease).toBe(next.lease)
    expect(f.state.view.phase).toBe("working")
    expect(f.state.continued).toHaveLength(0)
  })
  test("closing removes listeners, owned registrations and wait timers", () => {
    const f = fixture("darwin")
    const scope = f.start("background")
    f.takeover.target(scope, { pid: 500, name: "Notes" })
    f.emit({ event: "user_input", kind: "key", pid: 500 })
    f.takeover.close()
    f.clock.advance(5000)
    expect(f.events.size).toBe(0)
    expect(f.shortcuts.size).toBe(0)
    expect(f.state.continued).toHaveLength(0)
    expect(f.state.view.phase).toBe("stopped")
  })
})
