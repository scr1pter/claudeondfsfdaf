import { expect, test } from "bun:test"
import {
  COMPUTER_SMOKE_WINDOW_REGION_MARK,
  computerSmokeOuterWindowMatches,
  computerSmokeWindowRegionSummary,
  parseComputerSmokeWindowRegionSummary,
} from "./computer-overlay-smoke-window-region-report"
import type { ComputerSmokeWindowRegions } from "./computer-overlay-smoke-window-region"

const expected = [
  { x: -1024, y: 0, width: 1024, height: 24 },
  { x: 0, y: 744, width: 1024, height: 24 },
]
const result = (): ComputerSmokeWindowRegions => ({
  ok: true,
  windows: expected.map((bounds, index) => ({
    index,
    windowRect: { ...bounds, height: 39 },
    regionRect: { ...bounds },
    owned: true,
    simple: true,
    matches: true,
  })),
})
const line = (value: unknown) => COMPUTER_SMOKE_WINDOW_REGION_MARK + JSON.stringify(value)

test("a banner or cursor cannot substitute another window's requested rectangle", () => {
  const banner = { x: 192, y: 8, width: 640, height: 40 }
  expect(computerSmokeOuterWindowMatches(banner, banner, [...expected, banner])).toBe(true)
  expect(computerSmokeOuterWindowMatches(expected[0]!, banner, [...expected, banner])).toBe(false)
  const cursor = { x: -1024, y: 0, width: 1024, height: 768 }
  expect(computerSmokeOuterWindowMatches(cursor, cursor, [...expected, banner])).toBe(false)
})

test("a pass requires exact OS region extents plus the logical glow paint, while retaining taller containers", () => {
  expect(computerSmokeWindowRegionSummary(expected, 2, result())).toEqual({
    protocol: 1,
    windows: 2,
    owned: 2,
    simple: 2,
    matched: 2,
    painted: 2,
    ok: true,
  })
  expect(computerSmokeWindowRegionSummary(expected, 1, result()).ok).toBe(false)
  const changed = result()
  if (!changed.ok) throw new Error("Expected the fixed native result fixture.")
  changed.windows[0]!.regionRect.height = 39
  expect(computerSmokeWindowRegionSummary(expected, 2, changed).matched).toBe(1)
  expect(computerSmokeWindowRegionSummary(expected, 2, changed).ok).toBe(false)
  changed.windows[0]!.regionRect = { ...expected[0]! }
  changed.windows[0]!.windowRect.width = 1000
  expect(computerSmokeWindowRegionSummary(expected, 2, changed).ok).toBe(false)
})

test("an unavailable or incomplete native observer cannot establish a pass", () => {
  expect(computerSmokeWindowRegionSummary(expected, 2, { ok: false, reason: "parent" })).toEqual({
    protocol: 1,
    windows: 2,
    owned: 0,
    simple: 0,
    matched: 0,
    painted: 2,
    ok: false,
    reason: "parent",
  })
  expect(computerSmokeWindowRegionSummary(expected, 2, { ok: true, windows: [] }).ok).toBe(false)
})

test("the aggregate receipt rejects arbitrary private data, invalid counts and contradictory passes", () => {
  const value = computerSmokeWindowRegionSummary(expected, 2, result())
  expect(parseComputerSmokeWindowRegionSummary(line(value))).toEqual(value)
  for (const patch of [
    { protocol: 2 },
    { windows: 0 },
    { windows: 257 },
    { owned: -1 },
    { simple: 3 },
    { matched: 0.5 },
    { painted: "PRIVATE" },
    { ok: false },
    { reason: "PRIVATE_PATH" },
    { pid: 123 },
    { hwnd: "PRIVATE" },
    { ok: true, reason: "parent" },
  ])
    expect(() => parseComputerSmokeWindowRegionSummary(line({ ...value, ...patch }))).toThrow()
  expect(() => parseComputerSmokeWindowRegionSummary(line(value) + " ".repeat(513))).toThrow()
})
