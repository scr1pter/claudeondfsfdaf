import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerNativeActions } from "@/computer/native-actions"

describe("native computer action normalization", () => {
  test("a mapped OpenAI batch stays one ordered generic call", () => {
    expect(
      ComputerNativeActions.input(
        {
          actions: [
            { action: "click", x: 100, y: 80 },
            { action: "type", text: "hello" },
          ],
          safety_checks: [{ id: "check_1", code: "sensitive", message: "Confirm" }],
        },
        "darwin",
      ),
    ).toEqual({
      action: "click",
      actions: [
        { action: "click", x: 100, y: 80 },
        { action: "type", text: "hello" },
      ],
    })
  })

  test("CUA and xdotool key names normalize without changing Control into Command", () => {
    for (const keys of [["CTRL", "SHIFT", "A"], "Control_L+Shift_R+a"])
      for (const platform of ["darwin", "win32"] as const)
        expect(ComputerNativeActions.input({ actions: [{ action: "key", keys }] }, platform).actions?.[0].keys).toBe(
          "ctrl+shift+a",
        )
    for (const keys of [["META", "ARROWLEFT"], "Super_L+Left", "Command+Left"])
      expect(ComputerNativeActions.input({ actions: [{ action: "key", keys }] }, "darwin").actions?.[0].keys).toBe(
        "cmd+arrowleft",
      )
    expect(
      ComputerNativeActions.input({ actions: [{ action: "key", keys: ["META", "LEFT"] }] }, "win32").actions?.[0].keys,
    ).toBe("win+arrowleft")
  })

  test("key normalization preserves named navigation and punctuation", () => {
    for (const [wire, expected] of [
      ["Return", "enter"],
      ["BackSpace", "backspace"],
      ["Page_Down", "pagedown"],
      ["Prior", "pageup"],
      ["Escape", "escape"],
      ["SPACE", "space"],
      [" ", "space"],
      ["plus", "+"],
      ["+", "+"],
      ["quotedbl", '"'],
      ["Control_L+slash", "ctrl+/"],
      ["F5", "f5"],
    ])
      expect(ComputerNativeActions.input({ member: "key", text: wire }, "darwin").keys).toBe(expected)
  })

  test("Anthropic click members map to the shared input and preserve full-frame points", () => {
    for (const [member, action] of [
      ["left_click", "click"],
      ["click", "click"],
      ["right_click", "right_click"],
      ["middle_click", "middle_click"],
      ["double_click", "double_click"],
      ["triple_click", "triple_click"],
      ["mouse_move", "mouse_move"],
    ] as const)
      expect(ComputerNativeActions.input({ member, coordinate: [300, 200] }, "darwin")).toEqual({
        action,
        x: 300,
        y: 200,
      })
    expect(ComputerNativeActions.input({ member: "click", x: 8, y: 10, button: "right" }, "win32")).toEqual({
      action: "right_click",
      x: 8,
      y: 10,
    })
  })

  test("zoom does not turn later coordinates into crop-relative points", () => {
    expect(ComputerNativeActions.input({ member: "zoom", region: [100, 120, 600, 620] }, "darwin")).toEqual({
      action: "zoom",
      region: { x0: 100, y0: 120, x1: 600, y1: 620 },
    })
    expect(ComputerNativeActions.input({ member: "click", coordinate: [400, 300] }, "darwin")).toEqual({
      action: "click",
      x: 400,
      y: 300,
    })
  })

  test("drag requires explicit full-frame path or start and end", () => {
    expect(
      ComputerNativeActions.input(
        { member: "left_click_drag", start_coordinate: [10, 20], coordinate: [50, 80] },
        "darwin",
      ),
    ).toEqual({
      action: "drag",
      path: [
        { x: 10, y: 20 },
        { x: 50, y: 80 },
      ],
    })
    expect(
      ComputerNativeActions.input(
        { member: "drag", path: [[10, 20], { x: 30, y: 40 }], modifiers: "Shift_L" },
        "win32",
      ),
    ).toEqual({
      action: "drag",
      path: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
      modifiers: "shift",
    })
    expect(() => ComputerNativeActions.input({ member: "left_click_drag", coordinate: [50, 80] }, "darwin")).toThrow()
  })

  test("Anthropic wheel-step counts stay separate from native pixel scrolling", () => {
    expect(
      ComputerNativeActions.input(
        { member: "scroll", scroll_direction: "down", scroll_amount: 3, coordinate: [50, 80] },
        "win32",
      ),
    ).toEqual({ action: "scroll", direction: "down", amount: 3, x: 50, y: 80 })
    expect(ComputerNativeActions.scrolls({ member: "scroll", scroll_direction: "down", scroll_amount: 3 })).toEqual([])
  })

  test("native pixel scrolling retains exact diagonal deltas and original batch indices", () => {
    const value = {
      actions: [
        { action: "key", keys: ["META", "A"] },
        { action: "scroll", x: 50, y: 80, scroll_x: -7, scroll_y: 109 },
        { action: "scroll", x: 75, y: 100, scroll_x: 0, scroll_y: -10_000 },
      ],
    }
    expect(ComputerNativeActions.input(value, "darwin")).toEqual({
      action: "key",
      actions: [
        { action: "key", keys: "cmd+a" },
        { action: "scroll", x: 50, y: 80 },
        { action: "scroll", x: 75, y: 100 },
      ],
    })
    expect(ComputerNativeActions.scrolls(value)).toEqual([
      { index: 1, dx: -7, dy: 109 },
      { index: 2, dx: 0, dy: -10_000 },
    ])
  })

  test("invalid pixel values and mixed units refuse the entire native call", () => {
    for (const action of [
      { action: "scroll", x: 50, y: 80, scroll_x: 0, scroll_y: 0 },
      { action: "scroll", x: 50, y: 80, scroll_x: 1, scroll_y: 10_001 },
      { action: "scroll", x: 50, y: 80, scroll_x: -10_001, scroll_y: 0 },
      { action: "scroll", x: 50, y: 80, scroll_x: 0.5, scroll_y: 1 },
      { action: "scroll", x: 50, y: 80, scroll_x: 0, scroll_y: Infinity },
      { action: "scroll", x: 50, y: 80, scroll_y: 100 },
      { action: "scroll", y: 80, scroll_x: 0, scroll_y: 100 },
      { action: "scroll", x: 0.5, y: 80, scroll_x: 0, scroll_y: 100 },
      { action: "scroll", x: 50, y: 80, scroll_x: 0, scroll_y: 100, direction: "down", amount: 1 },
      { action: "click", x: 50, y: 80, scroll_x: 0, scroll_y: 100 },
    ]) {
      const value = { actions: [{ action: "type", text: "hello" }, action] }
      expect(() => ComputerNativeActions.input(value, "darwin")).toThrow()
      expect(() => ComputerNativeActions.scrolls(value)).toThrow()
    }
  })

  test("scroll context extraction validates the whole bounded batch", () => {
    const scroll = { action: "scroll", x: 1, y: 2, scroll_x: 10_000, scroll_y: 0 }
    expect(ComputerNativeActions.scrolls({ actions: Array(10).fill(scroll) })).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ index, dx: 10_000, dy: 0 })),
    )
    for (const actions of [
      Array(11).fill(scroll),
      [scroll, { action: "key", keys: "malformed-provider-key" }],
      [scroll, { action: "unknown" }],
    ])
      expect(() => ComputerNativeActions.scrolls({ actions })).toThrow()
  })

  test("native waits and holds retain shared bounds", () => {
    expect(ComputerNativeActions.input({ member: "wait", duration: 2.5 }, "darwin")).toEqual({
      action: "wait",
      seconds: 2.5,
    })
    expect(ComputerNativeActions.input({ member: "hold_key", text: "Right", duration: 10 }, "win32")).toEqual({
      action: "hold_key",
      keys: "arrowright",
      seconds: 10,
    })
    for (const value of [
      { member: "wait", duration: 31 },
      { member: "wait", duration: -1 },
      { member: "hold_key", text: "Right", duration: 10.1 },
    ])
      expect(() => ComputerNativeActions.input(value, "darwin")).toThrow()
  })

  test("native mouse button members only support the shared left button", () => {
    expect(ComputerNativeActions.input({ member: "left_mouse_down" }, "darwin")).toEqual({ action: "mouse_down" })
    expect(ComputerNativeActions.input({ member: "mouse_up", button: "left" }, "win32")).toEqual({ action: "mouse_up" })
    expect(() => ComputerNativeActions.input({ member: "mouse_down", button: "right" }, "win32")).toThrow()
  })

  test("unsupported members and ambiguous fields never silently become generic actions", () => {
    for (const value of [
      { member: "unknown", action: "screenshot" },
      { member: "click", coordinate: [1, 2], x: 1, y: 2 },
      { member: "click", coordinate: [1, 2], button: "back" },
      { member: "mouse_move", ref: "ui_1" },
      { member: "click", ref: "ui_1", coordinate: [1, 2] },
      { member: "click", coordinate: [1, 2], count: 3 },
      { member: "key", text: "A", keys: ["B"] },
      { member: "wait", duration: 1, seconds: 2 },
      { member: "screenshot", actions: [{ action: "click", x: 1, y: 2 }] },
      { actions: [{ action: "click", x: 1, y: 2, button: "right" }] },
      { actions: [{ action: "screenshot" }], acknowledged_safety_checks: [] },
    ])
      expect(() => ComputerNativeActions.input(value, "darwin")).toThrow()
  })

  test("a malformed suffix rejects the whole batch before execution", () => {
    for (const actions of [
      [],
      Array(Computer.LIMITS.batchSteps + 1).fill({ action: "screenshot" }),
      [{ action: "type", text: "hello" }, { action: "unknown" }],
      [
        { action: "type", text: "hello" },
        { action: "key", keys: "Control_L++" },
      ],
      [{ action: "type", text: "x".repeat(Computer.LIMITS.typeTextChars + 1) }],
    ])
      expect(() => ComputerNativeActions.input({ actions }, "darwin")).toThrow()
  })

  test("invalid key strings do not appear in the error", () => {
    for (const keys of ["Control_L+bad-provider-value", ["ctrl", "+"], "ctrl+ctrl+a", "ctrl+\n", []]) {
      expect(() => ComputerNativeActions.input({ actions: [{ action: "key", keys }] }, "darwin")).toThrow(
        "The native computer action is invalid or unsupported.",
      )
    }
  })
})
