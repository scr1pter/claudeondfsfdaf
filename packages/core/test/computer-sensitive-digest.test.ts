import { expect, test } from "bun:test"
import { ComputerSensitive } from "../src/computer/sensitive"

test("a sensitive approval binds the exact action and target across object insertion orders", () => {
  const first = ComputerSensitive.digest({
    kind: "click",
    button: "left",
    count: 1,
    at: { x: 12, y: 34 },
    modifiers: [],
  })
  expect(first).toMatch(/^[0-9a-f]{64}$/)
  expect(
    ComputerSensitive.digest({ modifiers: [], at: { y: 34, x: 12 }, count: 1, button: "left", kind: "click" }),
  ).toBe(first)
  expect(
    ComputerSensitive.digest({ kind: "click", button: "left", count: 1, at: { x: 13, y: 34 }, modifiers: [] }),
  ).not.toBe(first)
  expect(
    ComputerSensitive.digest({ kind: "click", button: "right", count: 1, at: { x: 12, y: 34 }, modifiers: [] }),
  ).not.toBe(first)
  expect(
    ComputerSensitive.digest({ kind: "click", button: "left", count: 2, at: { x: 12, y: 34 }, modifiers: [] }),
  ).not.toBe(first)
})

test("refs, text, key combinations, drag paths and executable paths cannot reuse a different step's proof", () => {
  const pairs: [ComputerSensitive.Step, ComputerSensitive.Step][] = [
    [
      { kind: "click", button: "left", count: 1, at: { ref: "e1" }, modifiers: [] },
      { kind: "click", button: "left", count: 1, at: { ref: "e2" }, modifiers: [] },
    ],
    [
      { kind: "type", text: "October" },
      { kind: "type", text: "November" },
    ],
    [
      { kind: "key", combo: ["cmd", "s"], repeat: 1 },
      { kind: "key", combo: ["cmd", "q"], repeat: 1 },
    ],
    [
      {
        kind: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        modifiers: [],
      },
      {
        kind: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 5, y: 6 },
        ],
        modifiers: [],
      },
    ],
    [
      { kind: "open", path: "/Applications/Calculator.app" },
      { kind: "open", path: "/Applications/Numbers.app" },
    ],
  ]
  for (const [before, after] of pairs)
    expect(ComputerSensitive.digest(before)).not.toBe(ComputerSensitive.digest(after))
  expect(ComputerSensitive.digest({ kind: "type", text: "October", ref: undefined })).toBe(
    ComputerSensitive.digest({ kind: "type", text: "October" }),
  )
})
