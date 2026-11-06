import { describe, expect, test } from "bun:test"
import {
  ActionError,
  BATCH_FAILURE,
  LIMITS,
  TOOL_ACTIONS,
  UNSUPPORTED,
  keysym,
  parseToolInput,
  plan,
  pressPoints,
  toStep,
  typesText,
  type Frame,
} from "../src/actions"

// WP A54: hostd's action API takes the local computer-use tool's own input (names, fields, limits, batch rule), so the
// agent drives a cloud computer the way it drives a desktop; coordinates are pixels of the latest screenshot.

const frame: Frame = {
  id: "f1",
  scope: "display",
  display: "0",
  bounds: { x: 0, y: 0, w: 1280, h: 800 },
  scale: 1,
  image: { w: 1280, h: 800 },
  at: 1,
  hash: "0123456789abcdef",
}
const half: Frame = { ...frame, scale: 0.5, image: { w: 640, h: 400 } }

function refused(run: () => unknown, code: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ActionError)
    expect((error as ActionError).code).toBe(code as never)
    return
  }
  throw new Error("expected a refusal")
}

describe("the action format matches the local computer-use tool", () => {
  test("the same 22 actions, limits and batch failure text", () => {
    expect(TOOL_ACTIONS).toEqual([
      "screenshot",
      "zoom",
      "cursor_position",
      "click",
      "double_click",
      "triple_click",
      "right_click",
      "middle_click",
      "mouse_move",
      "drag",
      "mouse_down",
      "mouse_up",
      "scroll",
      "type",
      "key",
      "hold_key",
      "wait",
      "list_apps",
      "open_app",
      "focus_window",
      "read_ui",
      "handoff",
    ])
    expect(LIMITS).toMatchObject({ typeTextChars: 4000, batchSteps: 10, dragPointsMax: 50, repeatMax: 20, waitSecondsMax: 30, holdSecondsMax: 10 })
    expect(BATCH_FAILURE).toBe("Not executed: an earlier computer action in this turn failed.")
  })

  test("inputs are checked strictly: unknown fields and out-of-range values are refused", () => {
    expect(parseToolInput({ action: "click", x: 10, y: 20, intent: "open menu" })).toEqual({ action: "click", x: 10, y: 20, intent: "open menu" })
    refused(() => parseToolInput({ action: "click", x: 10, y: 20, evil: true }), "failed")
    refused(() => parseToolInput({ action: "teleport" }), "failed")
    refused(() => parseToolInput({ action: "type", text: "x".repeat(4001) }), "failed")
    refused(() => parseToolInput({ action: "click", x: 1.5, y: 2 }), "failed")
    refused(() => parseToolInput({ action: "scroll", direction: "sideways" }), "failed")
    refused(() => parseToolInput({ action: "hold_key", keys: "a", seconds: 11 }), "failed")
    expect(parseToolInput({ action: "wait", seconds: 30 }).seconds).toBe(30)
    refused(() => parseToolInput({ action: "wait", seconds: 31 }), "failed")
    refused(() => parseToolInput({ action: "drag", path: [{ x: 1, y: 1 }] }), "failed")
    refused(() => parseToolInput({ action: "click", ref: "button-1" }), "failed")
  })

  test("a batch holds at most 10 steps and never a handoff or a nested batch", () => {
    const steps = Array.from({ length: 10 }, () => ({ action: "wait", seconds: 0 }))
    expect(parseToolInput({ action: "screenshot", actions: steps }).actions).toHaveLength(10)
    refused(() => parseToolInput({ action: "screenshot", actions: [...steps, { action: "wait" }] }), "failed")
    refused(() => parseToolInput({ action: "screenshot", actions: [{ action: "handoff" }] }), "failed")
    refused(() => parseToolInput({ action: "screenshot", actions: [{ action: "wait", actions: [] }] }), "failed")
  })

  test("actions a cloud computer cannot do, and accessibility references, answer unsupported_action", () => {
    for (const action of UNSUPPORTED) refused(() => toStep({ action }, frame), "unsupported_action")
    refused(() => toStep({ action: "click", ref: "ui_3" }, frame), "unsupported_action")
  })
})

describe("steps", () => {
  test("clicks map screenshot pixels to the display, refusing a missing or stale frame", () => {
    expect(toStep({ action: "double_click", x: 100, y: 50, modifiers: "ctrl+shift" }, frame)).toEqual({
      kind: "click",
      button: "left",
      count: 2,
      at: { x: 100, y: 50 },
      modifiers: ["ctrl", "shift"],
    })
    expect(toStep({ action: "right_click", x: 100, y: 50 }, half)).toMatchObject({ button: "right", at: { x: 200, y: 100 } })
    refused(() => toStep({ action: "click", x: 1, y: 1 }, undefined), "stale_frame")
    refused(() => toStep({ action: "click", x: 1280, y: 1 }, frame), "out_of_bounds")
    refused(() => toStep({ action: "click", x: 1, y: 1, modifiers: "a" }, frame), "failed")
  })

  test("scroll, type, keys, hold and wait follow the local normalization", () => {
    expect(toStep({ action: "scroll", direction: "up", amount: 3 }, frame)).toEqual({ kind: "scroll", dx: 0, dy: -3 })
    expect(toStep({ action: "scroll", direction: "right", x: 5, y: 6 }, frame)).toEqual({ kind: "scroll", at: { x: 5, y: 6 }, dx: 1, dy: 0 })
    expect(toStep({ action: "type", text: "hello" }, frame)).toEqual({ kind: "type", text: "hello" })
    refused(() => toStep({ action: "type", text: "" }, frame), "failed")
    expect(toStep({ action: "key", keys: "ctrl+c", repeat: 2 }, frame)).toEqual({ kind: "key", combo: ["ctrl", "c"], repeat: 2 })
    expect(toStep({ action: "hold_key", keys: "shift", seconds: 1.5 }, frame)).toEqual({ kind: "key", combo: ["shift"], repeat: 1, holdMs: 1500 })
    expect(toStep({ action: "wait", seconds: 2 }, frame)).toEqual({ kind: "wait", ms: 2000 })
    refused(() => toStep({ action: "mouse_down", x: 1, y: 1 }, frame), "failed")
    expect(toStep({ action: "screenshot" }, frame)).toBeUndefined()
  })
})

describe("xdotool commands", () => {
  test("a click moves first, holds modifiers around the click, and releases them", () => {
    expect(plan({ kind: "click", button: "middle", count: 1, at: { x: 3, y: 4 }, modifiers: ["cmd"] })).toEqual([
      { argv: ["mousemove", "--sync", "3", "4"] },
      { argv: ["keydown", "super"] },
      { argv: ["click", "--repeat", "1", "--delay", "80", "2"] },
      { argv: ["keyup", "super"] },
    ])
  })

  test("typed text goes on stdin, never on the command line", () => {
    const commands = plan({ kind: "type", text: "secret-looking text --window 1" })
    expect(commands).toEqual([{ argv: ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], stdin: "secret-looking text --window 1" }])
    expect(commands.flatMap((command) => ("argv" in command ? command.argv : [])).join(" ")).not.toContain("secret")
  })

  test("keys become X keysyms; names xdotool could read as options are refused", () => {
    expect(["enter", "Esc", "cmd", "+", "F12", "a", "Page_Up"].map(keysym)).toEqual(["Return", "Escape", "super", "plus", "F12", "a", "Prior"])
    expect(() => keysym("--window")).toThrow()
    expect(() => keysym("a b")).toThrow()
    expect(plan({ kind: "key", combo: ["ctrl", "shift", "t"], repeat: 1 })).toEqual([
      { argv: ["key", "--clearmodifiers", "--repeat", "1", "--delay", "50", "ctrl+shift+t"] },
    ])
    expect(plan({ kind: "key", combo: ["a"], repeat: 1, holdMs: 500 })).toEqual([
      { argv: ["keydown", "a"] },
      { sleepMs: 500 },
      { argv: ["keyup", "a"] },
    ])
  })

  test("scrolls press wheel buttons; drags hold the left button along the path", () => {
    expect(plan({ kind: "scroll", dx: -2, dy: 3 })).toEqual([
      { argv: ["click", "--repeat", "3", "--delay", "40", "5"] },
      { argv: ["click", "--repeat", "2", "--delay", "40", "6"] },
    ])
    expect(plan({ kind: "drag", path: [{ x: 1, y: 1 }, { x: 9, y: 9 }], modifiers: [] })).toEqual([
      { argv: ["mousemove", "--sync", "1", "1"] },
      { argv: ["mousedown", "1"] },
      { argv: ["mousemove", "--sync", "9", "9"] },
      { argv: ["mouseup", "1"] },
    ])
  })

  test("what the credential guard and the CAPTCHA check look at", () => {
    expect(typesText({ kind: "type", text: "x" })).toBe(true)
    expect(typesText({ kind: "key", combo: ["ctrl", "v"], repeat: 1 })).toBe(true)
    expect(typesText({ kind: "key", combo: ["Tab"], repeat: 1 })).toBe(false)
    expect(typesText({ kind: "key", combo: ["shift", "tab"], repeat: 1 })).toBe(false)
    expect(typesText({ kind: "key", combo: ["enter"], repeat: 1 })).toBe(false)
    expect(typesText({ kind: "click", button: "left", count: 1, at: { x: 1, y: 1 }, modifiers: [] })).toBe(false)
    expect(pressPoints({ kind: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], modifiers: [] })).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
    expect(pressPoints({ kind: "move", at: { x: 1, y: 1 } })).toEqual([])
  })
})
