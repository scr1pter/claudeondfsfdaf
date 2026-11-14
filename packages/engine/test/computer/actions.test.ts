import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { ComputerActions } from "@/computer/actions"

const frame: Computer.Frame = {
  id: "latest-full-frame",
  scope: "display",
  display: "second-display",
  bounds: { x: -1600, y: 20, w: 1600, h: 1000 },
  scale: 2,
  image: { w: 1280, h: 800 },
  at: 0,
  hash: "0123456789abcdef",
}

describe("computer action translation", () => {
  test("coordinate clicks use the latest screenshot's pixels without another display scaling pass", () => {
    expect(ComputerActions.step({ action: "double_click", x: 1279, y: 799, modifiers: "cmd+shift" }, frame)).toEqual({
      kind: "click",
      button: "left",
      count: 2,
      at: { x: 1279, y: 799 },
      modifiers: ["cmd", "shift"],
    })
    expect(ComputerActions.step({ action: "right_click", x: 0, y: 0 }, frame)).toMatchObject({
      button: "right",
      count: 1,
    })
    expect(ComputerActions.step({ action: "middle_click", x: 0, y: 0 }, frame)).toMatchObject({
      button: "middle",
      count: 1,
    })
    expect(ComputerActions.step({ action: "triple_click", x: 0, y: 0 }, frame)).toMatchObject({
      button: "left",
      count: 3,
    })
  })

  test("Gemini click and drag endpoints resolve to full-frame pixels", () => {
    expect(ComputerActions.step({ action: "click", x: 999, y: 999 }, frame, "grid1000")).toMatchObject({
      at: { x: 1279, y: 799 },
    })
    expect(
      ComputerActions.step(
        {
          action: "drag",
          path: [
            { x: 0, y: 0 },
            { x: 999, y: 999 },
          ],
        },
        frame,
        "grid1000",
      ),
    ).toEqual({
      kind: "drag",
      path: [
        { x: 0, y: 0 },
        { x: 1279, y: 799 },
      ],
      modifiers: [],
    })
  })

  test("coordinates require a frame and both axes", () => {
    expect(() => ComputerActions.step({ action: "click", x: 1, y: 1 })).toThrow("Take a fresh screenshot")
    expect(() => ComputerActions.step({ action: "mouse_move", x: 1 }, frame)).toThrow("both x and y")
    expect(() => ComputerActions.step({ action: "scroll", direction: "down", y: 1 }, frame)).toThrow("both x and y")
  })

  test("out-of-frame and invalid grid coordinates never clamp into an actionable point", () => {
    for (const point of [
      { x: -1, y: 0 },
      { x: 1280, y: 0 },
      { x: 0, y: 800 },
      { x: 0.5, y: 1 },
    ])
      expect(() => ComputerActions.step({ action: "click", ...point }, frame)).toThrow(ComputerActions.ActionError)
    for (const x of [-1, 1000, 1.5, Number.NaN])
      expect(() => ComputerActions.step({ action: "mouse_move", x, y: 0 }, frame, "grid1000")).toThrow(
        ComputerActions.ActionError,
      )
  })

  test("accessibility references work without a frame and cannot compete with coordinates", () => {
    expect(ComputerActions.step({ action: "click", ref: "ui_12" })).toMatchObject({ at: { ref: "ui_12" } })
    expect(ComputerActions.step({ action: "type", ref: "ui_12", text: "hello" })).toEqual({
      kind: "type",
      ref: "ui_12",
      text: "hello",
    })
    expect(() => ComputerActions.step({ action: "click", ref: "ui_12", x: 4, y: 5 }, frame)).toThrow(
      "either an accessibility ref",
    )
    expect(() => ComputerActions.step({ action: "click", ref: "other-app-control" })).toThrow(
      ComputerActions.ActionError,
    )
  })

  test("the complete drag path is bounded before a step can be sent", () => {
    expect(() => ComputerActions.step({ action: "drag", path: [{ x: 0, y: 0 }] }, frame)).toThrow("2 to 50")
    expect(() =>
      ComputerActions.step(
        {
          action: "drag",
          path: [
            { x: 0, y: 0 },
            { x: 1280, y: 0 },
          ],
        },
        frame,
      ),
    ).toThrow("outside")
    expect(() =>
      ComputerActions.step({ action: "drag", path: Array.from({ length: 51 }, () => ({ x: 0, y: 0 })) }, frame),
    ).toThrow("2 to 50")
  })

  test("down and up use only the current pointer rather than ignoring an asserted target", () => {
    expect(ComputerActions.step({ action: "mouse_down" })).toEqual({ kind: "down", button: "left" })
    expect(ComputerActions.step({ action: "mouse_up" })).toEqual({ kind: "up", button: "left" })
    for (const target of [{ x: 1, y: 2 }, { ref: "ui_1" }, { modifiers: "shift" }])
      expect(() => ComputerActions.step({ action: "mouse_down", ...target }, frame)).toThrow("current pointer")
  })

  test("scroll direction and bounded amount survive translation without display scaling", () => {
    expect(ComputerActions.step({ action: "scroll", direction: "up", amount: 20 })).toEqual({
      kind: "scroll",
      dx: 0,
      dy: -20,
    })
    expect(ComputerActions.step({ action: "scroll", direction: "left", x: 999, y: 999 }, frame, "grid1000")).toEqual({
      kind: "scroll",
      at: { x: 1279, y: 799 },
      dx: -1,
      dy: 0,
    })
    expect(ComputerActions.step({ action: "scroll", direction: "right", amount: 3 })).toEqual({
      kind: "scroll",
      dx: 3,
      dy: 0,
    })
    expect(ComputerActions.step({ action: "scroll", direction: "down" })).toEqual({ kind: "scroll", dx: 0, dy: 1 })
    for (const amount of [0, 21, 1.5])
      expect(() => ComputerActions.step({ action: "scroll", direction: "down", amount })).toThrow("1 to 20")
    expect(() => ComputerActions.step({ action: "scroll" })).toThrow("requires a direction")
    expect(() => ComputerActions.step({ action: "scroll", direction: "down", ref: "ui_1" })).toThrow(
      "not an accessibility ref",
    )
  })

  test("native pixel scroll preserves exact deltas and full-frame coordinate validation", () => {
    expect(ComputerActions.step({ action: "scroll", x: 100, y: 200 }, frame, "pixels", { dx: -321, dy: 765 })).toEqual({
      kind: "scroll",
      at: { x: 100, y: 200 },
      unit: "pixel",
      dx: -321,
      dy: 765,
    })
    expect(() => ComputerActions.step({ action: "scroll", x: 1280, y: 0 }, frame, "pixels", { dx: 0, dy: 1 })).toThrow(
      "outside",
    )
    expect(() => ComputerActions.step({ action: "scroll", x: 0, y: 0 }, undefined, "pixels", { dx: 0, dy: 1 })).toThrow(
      "fresh screenshot",
    )
    for (const dy of [NaN, Infinity, 0.5, 10001, -10001])
      expect(() => ComputerActions.step({ action: "scroll", x: 0, y: 0 }, frame, "pixels", { dx: 0, dy })).toThrow(
        "invalid fields",
      )
    expect(() =>
      ComputerActions.step({ action: "scroll", x: 0, y: 0, direction: "up" }, frame, "pixels", { dx: 0, dy: 1 }),
    ).toThrow("cannot mix")
    expect(() => ComputerActions.step({ action: "click", x: 0, y: 0 }, frame, "pixels", { dx: 0, dy: 1 })).toThrow(
      "requires a scroll",
    )
  })

  test("key combinations retain physical key names for the live layout check", () => {
    expect(ComputerActions.step({ action: "key", keys: "Control + KeyQ", repeat: 2 })).toEqual({
      kind: "key",
      combo: ["Control", "KeyQ"],
      repeat: 2,
    })
    expect(ComputerActions.step({ action: "key", keys: "+" })).toEqual({ kind: "key", combo: ["+"], repeat: 1 })
    expect(() => ComputerActions.step({ action: "key", keys: "cmd++s" })).toThrow(ComputerActions.ActionError)
    expect(() => ComputerActions.step({ action: "key", keys: "Enter\u0000" })).toThrow(ComputerActions.ActionError)
    expect(() => ComputerActions.step({ action: "key", keys: "Enter\n" })).toThrow(ComputerActions.ActionError)
    expect(() => ComputerActions.step({ action: "key" })).toThrow(ComputerActions.ActionError)
    expect(() => ComputerActions.step({ action: "key", keys: "a", repeat: 21 })).toThrow(ComputerActions.ActionError)
    expect(() => ComputerActions.step({ action: "click", ref: "ui_1", modifiers: "shift+s" })).toThrow("modifier keys")
  })

  test("wait and hold durations are bounded in milliseconds", () => {
    expect(ComputerActions.step({ action: "wait" })).toEqual({ kind: "wait", ms: 1000 })
    expect(ComputerActions.step({ action: "wait", seconds: 0.125 })).toEqual({ kind: "wait", ms: 125 })
    expect(ComputerActions.step({ action: "hold_key", keys: "shift", seconds: 10 })).toEqual({
      kind: "key",
      combo: ["shift"],
      repeat: 1,
      holdMs: 10_000,
    })
    expect(() => ComputerActions.step({ action: "hold_key", keys: "shift", seconds: 10.001 })).toThrow(
      "between 0 and 10",
    )
    for (const seconds of [-1, 30.01, Number.POSITIVE_INFINITY, Number.NaN])
      expect(() => ComputerActions.step({ action: "wait", seconds })).toThrow("between 0 and 30")
  })

  test("typing is non-empty and never reports supplied text in validation errors", () => {
    expect(() => ComputerActions.step({ action: "type", text: "" })).toThrow("requires non-empty text")
    const text = "private contents".repeat(400)
    expect(() => ComputerActions.step({ action: "type", text })).toThrow("invalid fields")
    expect(() => ComputerActions.step({ action: "type", text })).not.toThrow(text)
  })

  test("non-input actions do not accidentally become bridge input", () => {
    for (const action of [
      "screenshot",
      "zoom",
      "cursor_position",
      "list_apps",
      "open_app",
      "focus_window",
      "read_ui",
      "handoff",
    ] as const)
      expect(ComputerActions.step({ action })).toBeUndefined()
  })
})
