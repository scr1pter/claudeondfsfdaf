import { Computer } from "@vectordevai/schema/computer"
import { ComputerError } from "./computer-bridge"
import type { createComputerSession, SessionClock, SessionScope, TypingWait } from "./computer-session"

type Phase = Computer.ComputerPhase
type Kind = "pointer" | "key" | "click" | "scroll" | "esc" | "chord"
type Controller = Pick<
  ReturnType<typeof createComputerSession>,
  "state" | "scope" | "subscribe" | "pause" | "stop" | "helperEvent" | "waitForInput" | "continueAfterInput"
>
type Shortcuts = {
  register(accelerator: string, callback: () => void): boolean
  isRegistered(accelerator: string): boolean
  unregister(accelerator: string): void
}
type Unavailable = "invalid_chord" | "chord_unavailable" | "escape_unavailable" | "escape_unsupported"
const ACTIVE = new Set<Phase>(["working", "waiting", "asking", "handoff", "paused"])
const QUIET_MS = 2000
const MAX_HISTORY = 256
const MAX_SUSPENSIONS = 256

/** All distances are logical DIP and all observations are physical input, unless explicitly tagged. */
export function classify(input: {
  kind: Kind
  dx?: number
  dy?: number
  mode: Computer.Mode
  phase: Phase
  inTarget?: boolean
  tagged?: boolean
  escStops?: boolean
}): "pause" | "wait" | "stop" | "ignore" {
  if (input.tagged || !ACTIVE.has(input.phase)) return "ignore"
  if (input.kind === "chord") return "stop"
  if (input.kind === "esc")
    return input.phase === "working" && input.mode === "foreground" && input.escStops !== false ? "stop" : "ignore"
  if (input.mode === "foreground") {
    if (input.phase !== "working") return "ignore"
    if (input.kind !== "pointer") return "pause"
    return !Number.isFinite(input.dx) ||
      !Number.isFinite(input.dy) ||
      Math.hypot(input.dx!, input.dy!) >= Computer.LIMITS.takeoverPx
      ? "pause"
      : "ignore"
  }
  if (input.phase !== "working" && input.phase !== "waiting") return "ignore"
  if (input.inTarget === false) return "ignore"
  if (input.kind === "key") return "wait"
  return input.inTarget === true && (input.kind === "click" || input.kind === "scroll") ? "pause" : "ignore"
}

/** Canonical Electron accelerator, or undefined when unsafe, malformed or reserved by the OS. */
export function validateChord(accelerator: string, platform: "darwin" | "win32"): string | undefined {
  if (typeof accelerator !== "string" || accelerator.length > 128 || /[^\x20-\x7e]/.test(accelerator)) return
  const parts = accelerator.split("+").map((part) => part.trim().toLowerCase())
  if (parts.length < 2 || parts.length > 5 || parts.some((part) => !part)) return
  const modifiers = new Set<string>()
  const keys: string[] = []
  for (const part of parts) {
    const modifier = ["commandorcontrol", "cmdorctrl", "commandorctrl", "cmdorcontrol"].includes(part)
      ? platform === "darwin"
        ? "Command"
        : "Control"
      : ["control", "ctrl", "ctl"].includes(part)
        ? "Control"
        : ["command", "cmd", "meta", "super"].includes(part)
          ? platform === "darwin"
            ? "Command"
            : "Super"
          : ["alt", "option", "opt"].includes(part)
            ? "Alt"
            : part === "shift"
              ? "Shift"
              : undefined
    if (modifier) {
      if (modifiers.has(modifier)) return
      modifiers.add(modifier)
      continue
    }
    const aliases: Record<string, string> = {
      esc: "Escape",
      escape: "Escape",
      space: "Space",
      spacebar: "Space",
      enter: "Enter",
      return: "Enter",
      tab: "Tab",
      backspace: "Backspace",
      delete: "Delete",
      del: "Delete",
      insert: "Insert",
      ins: "Insert",
      up: "Up",
      arrowup: "Up",
      down: "Down",
      arrowdown: "Down",
      left: "Left",
      arrowleft: "Left",
      right: "Right",
      arrowright: "Right",
      home: "Home",
      end: "End",
      pageup: "PageUp",
      pagedown: "PageDown",
      plus: "Plus",
      minus: "-",
      "-": "-",
    }
    const key =
      aliases[part] ??
      (/^[a-z0-9]$/.test(part) || /^f(?:[1-9]|1\d|2[0-4])$/.test(part) ? part.toUpperCase() : undefined)
    if (!key) return
    keys.push(key)
  }
  if (keys.length !== 1 || modifiers.size < 2 || ![...modifiers].some((modifier) => modifier !== "Shift")) return
  const key = keys[0]!
  const control = modifiers.has("Control")
  const alt = modifiers.has("Alt")
  const command = modifiers.has("Command")
  const shift = modifiers.has("Shift")
  if (platform === "darwin") {
    if (
      (control && alt) ||
      (command && key === "Space") ||
      (control && key === "Space") ||
      (command && alt && ["Escape", "D"].includes(key)) ||
      (command && control && key === "Q") ||
      (command && shift && ["Q", "3", "4", "5", "6"].includes(key)) ||
      (control && (["Up", "Down", "Left", "Right"].includes(key) || /^F[2-8]$/.test(key))) ||
      (command && key === "Tab")
    )
      return
  } else if (
    modifiers.has("Super") ||
    (alt && ["Tab", "Space", "F4"].includes(key)) ||
    (alt && !control && key === "Escape") ||
    (control && key === "Escape" && !alt) ||
    (control && alt && ["Delete", "End", "Tab", "Up", "Down", "Left", "Right"].includes(key))
  )
    return
  const result = [
    ...["Command", "Control", "Alt", "Shift", "Super"].filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+")
  return result.length <= 64 ? result : undefined
}

const clock: SessionClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Native observations are synchronous; shortcut and quiet-wait ownership never outlive their lease. */
export function createComputerTakeover(input: {
  platform: "darwin" | "win32"
  controller: Controller
  backend: Pick<Computer.ComputerBackend, "onEvent" | "capabilities">
  shortcuts: Shortcuts
  clock?: SessionClock
  onUnavailable?(reason: Unavailable): void
}) {
  const time = input.clock ?? clock
  const owned = new Set<string>()
  const versions = new Map<string, object>()
  const keys = new Map<number, number>()
  const suspensions = new Set<{ lease: number; generation: number }>()
  const state: {
    lease: number
    generation: number
    chord?: string
    escape: boolean
    closed: boolean
    refreshing: boolean
    again: boolean
    failure?: string
    target?: { scope: SessionScope; pid: number; name: string }
    wait?: TypingWait
    timer?: unknown
  } = { lease: 0, generation: 0, escape: false, closed: false, refreshing: false, again: false }

  function active(view = input.controller.state()) {
    return !!view.holder && view.lease > 0 && ACTIVE.has(view.phase)
  }
  function clearWait() {
    if (state.timer !== undefined) time.clearTimeout(state.timer)
    state.timer = undefined
    state.wait = undefined
  }
  function unregister(chord: string) {
    if (!owned.has(chord)) return
    versions.delete(chord)
    try {
      input.shortcuts.unregister(chord)
      owned.delete(chord)
    } catch {
      unavailable(chord === "Escape" ? "escape_unavailable" : "chord_unavailable", true)
    }
  }
  function unavailable(reason: Unavailable, terminal: boolean) {
    const failure = `${state.lease}:${reason}`
    const notify = state.failure !== failure
    state.failure = failure
    if (active()) {
      if (terminal) void input.controller.stop().catch(() => {})
      else if (input.controller.state().phase !== "paused") void input.controller.pause("detection").catch(() => {})
    }
    if (notify) {
      try {
        input.onUnavailable?.(reason)
      } catch {
        /* Diagnostics cannot keep input authority alive. */
      }
    }
  }
  function register(chord: string, role: "chord" | "escape") {
    const lease = state.lease
    const generation = state.generation
    const version = {}
    try {
      if (input.shortcuts.isRegistered(chord)) return false
      const success = input.shortcuts.register(chord, () => {
        const view = input.controller.state()
        if (
          state.closed ||
          versions.get(chord) !== version ||
          state.lease !== lease ||
          state.generation !== generation ||
          !active(view)
        )
          return
        if (
          role === "escape" &&
          (!view.escStops ||
            view.phase !== "working" ||
            view.mode !== "foreground" ||
            [...suspensions].some((entry) => entry.lease === lease && entry.generation === generation))
        )
          return
        void input.controller.stop().catch(() => {})
      })
      if (success) {
        owned.add(chord)
        versions.set(chord, version)
      }
      return success
    } catch {
      return false
    }
  }
  function refresh() {
    if (state.closed) return
    if (state.refreshing) {
      state.again = true
      return
    }
    state.refreshing = true
    try {
      do {
        state.again = false
        const view = input.controller.state()
        const lease = active(view) ? view.lease : 0
        if (lease !== state.lease) {
          state.generation++
          clearWait()
          suspensions.clear()
          state.target = undefined
          keys.clear()
          for (const chord of [...owned]) unregister(chord)
          state.chord = undefined
          state.escape = false
          state.failure = undefined
          state.lease = lease
        }
        if (!lease) continue
        if (view.phase !== "waiting" || view.mode !== "background") clearWait()
        const chord = validateChord(view.stopChord, input.platform)
        if (!chord) {
          unavailable("invalid_chord", true)
          continue
        }
        if (state.chord === chord && owned.has(chord)) {
          try {
            if (!input.shortcuts.isRegistered(chord)) {
              owned.delete(chord)
              versions.delete(chord)
              state.chord = undefined
            }
          } catch {
            unavailable("chord_unavailable", true)
            continue
          }
        }
        if (state.chord !== chord) {
          if (state.chord) unregister(state.chord)
          state.chord = undefined
          if (!register(chord, "chord")) {
            unavailable("chord_unavailable", true)
            continue
          }
          state.chord = chord
        }
        const escape =
          input.platform === "win32" &&
          view.phase === "working" &&
          view.mode === "foreground" &&
          view.escStops &&
          ![...suspensions].some((entry) => entry.lease === lease && entry.generation === state.generation)
        if (state.escape && !escape) {
          unregister("Escape")
          state.escape = false
        }
        if (escape && state.escape) {
          try {
            if (!input.shortcuts.isRegistered("Escape")) {
              owned.delete("Escape")
              versions.delete("Escape")
              state.escape = false
            }
          } catch {
            unavailable("escape_unavailable", false)
            continue
          }
        }
        if (escape && !state.escape) {
          if (!register("Escape", "escape")) {
            unavailable("escape_unavailable", false)
            continue
          }
          state.escape = true
        }
        if (input.platform === "darwin" && view.phase === "working" && view.mode === "foreground") {
          try {
            if (input.backend.capabilities().features["stop.esc"] !== true) unavailable("escape_unsupported", false)
          } catch {
            unavailable("escape_unsupported", false)
          }
        }
      } while (state.again)
    } finally {
      state.refreshing = false
    }
  }

  function prune() {
    for (const [pid, at] of keys) if (time.now() - at >= QUIET_MS) keys.delete(pid)
  }
  function remember(pid: number | undefined) {
    prune()
    if (keys.size >= MAX_HISTORY && !keys.has(pid ?? 0)) {
      keys.clear()
      keys.set(0, time.now())
    } else keys.set(pid ?? 0, time.now())
  }
  function recent(pid: number) {
    return Math.max(keys.get(pid) ?? -Infinity, keys.get(0) ?? -Infinity)
  }
  function quiet(app?: string) {
    const token = input.controller.waitForInput(app)
    if (!token) return
    clearWait()
    state.wait = token
    const deadline = recent(state.target?.pid ?? 0) + QUIET_MS
    const generation = state.generation
    state.timer = time.setTimeout(
      () => {
        if (state.closed || generation !== state.generation || state.wait !== token) return
        const view = input.controller.state()
        if (
          !active(view) ||
          view.lease !== token.scope.lease ||
          view.phase !== "waiting" ||
          view.mode !== "background"
        ) {
          clearWait()
          return
        }
        if (time.now() < recent(state.target?.pid ?? 0) + QUIET_MS) {
          quiet(state.target?.name)
          return
        }
        clearWait()
        void input.controller.continueAfterInput(token).catch(() => {})
      },
      Math.max(0, deadline - time.now()),
    )
  }

  function event(value: Computer.HelperEvent) {
    if (state.closed) return
    input.controller.helperEvent(value)
    if (value.event !== "user_input") return
    const view = input.controller.state()
    if (!active(view)) return
    if (value.kind === "key") remember(value.pid)
    const inTarget =
      value.pid === undefined ? undefined : state.target?.scope.lease === view.lease && state.target.pid === value.pid
    const verdict = classify({
      kind: value.kind,
      dx: value.dx,
      dy: value.dy,
      mode: view.mode,
      phase: view.phase,
      inTarget,
      escStops: view.escStops,
    })
    if (verdict === "pause") {
      clearWait()
      void input.controller.pause("input").catch(() => {})
    }
    if (verdict === "wait") quiet(state.target?.name)
  }

  const unsubscribe = input.controller.subscribe(refresh)
  const unlisten = input.backend.onEvent(event)
  refresh()
  return {
    event,
    refresh,
    target(scope: SessionScope, target: { pid: number; name: string }) {
      refresh()
      input.controller.scope(scope)
      const view = input.controller.state()
      if (view.phase !== "working") throw new ComputerError("paused", "The computer is waiting for you.")
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0)
        throw new ComputerError("changed", "The input target has no live process.")
      state.target = { scope: { ...scope }, pid: target.pid, name: Computer.clean(target.name, 256) }
      prune()
      if (view.mode === "background" && recent(target.pid) + QUIET_MS > time.now()) {
        quiet(state.target.name)
        throw new ComputerError("paused", "Waiting while you type in the target app.")
      }
    },
    suspendEsc() {
      const entry = { lease: state.lease, generation: state.generation }
      if (suspensions.size >= MAX_SUSPENSIONS) {
        unavailable("escape_unavailable", false)
        return () => {}
      }
      suspensions.add(entry)
      refresh()
      return () => {
        if (suspensions.delete(entry)) refresh()
      }
    },
    resumeEsc() {
      const entry = suspensions.values().next().value
      if (entry) suspensions.delete(entry)
      refresh()
    },
    close() {
      if (state.closed) return
      state.closed = true
      clearWait()
      unlisten()
      unsubscribe()
      for (const chord of [...owned]) unregister(chord)
      suspensions.clear()
      keys.clear()
      if (active()) void input.controller.stop().catch(() => {})
    },
  }
}
