import {
  COMPUTER_SMOKE_REGION_FAILURES,
  type ComputerSmokeRegionFailure,
  type ComputerSmokeRegionRect,
  type ComputerSmokeWindowRegions,
} from "./computer-overlay-smoke-window-region"

export const COMPUTER_SMOKE_WINDOW_REGION_MARK = "computer-smoke-window-region "
export type ComputerSmokeWindowRegionSummary = {
  protocol: 1
  windows: number
  owned: number
  simple: number
  matched: number
  painted: number
  ok: boolean
  reason?: ComputerSmokeRegionFailure
}

/** Every unshaped window must match its own request, rather than another strip's rectangle. */
export function computerSmokeOuterWindowMatches(
  actual: ComputerSmokeRegionRect,
  requested: ComputerSmokeRegionRect,
  expected: ComputerSmokeRegionRect[],
) {
  const same = (left: ComputerSmokeRegionRect, right: ComputerSmokeRegionRect) =>
    left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  return same(actual, requested) && expected.some((bounds) => same(bounds, requested))
}

export function parseComputerSmokeWindowRegionSummary(line: string): ComputerSmokeWindowRegionSummary {
  if (!line.startsWith(COMPUTER_SMOKE_WINDOW_REGION_MARK) || line.length > 512)
    throw new Error("The computer smoke window region receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_WINDOW_REGION_MARK.length))
  const fields = ["protocol", "windows", "owned", "simple", "matched", "painted", "ok", "reason"]
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The computer smoke window region receipt is invalid.")
  const record = value as Record<string, unknown>
  const count = (number: unknown): number is number =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= Number(record.windows)
  if (
    Object.keys(record).some((key) => !fields.includes(key)) ||
    ![7, 8].includes(Object.keys(record).length) ||
    record.protocol !== 1 ||
    typeof record.windows !== "number" ||
    !Number.isSafeInteger(record.windows) ||
    record.windows < 1 ||
    record.windows > 256 ||
    ![record.owned, record.simple, record.matched, record.painted].every(count) ||
    typeof record.ok !== "boolean" ||
    (record.reason !== undefined &&
      (typeof record.reason !== "string" ||
        !COMPUTER_SMOKE_REGION_FAILURES.includes(record.reason as ComputerSmokeRegionFailure))) ||
    record.ok !==
      (record.owned === record.windows &&
        record.simple === record.windows &&
        record.matched === record.windows &&
        record.painted === record.windows &&
        record.reason === undefined)
  )
    throw new Error("The computer smoke window region receipt is invalid.")
  return {
    protocol: 1,
    windows: record.windows,
    owned: Number(record.owned),
    simple: Number(record.simple),
    matched: Number(record.matched),
    painted: Number(record.painted),
    ok: record.ok,
    ...(record.reason === undefined ? {} : { reason: record.reason as ComputerSmokeRegionFailure }),
  }
}

export function computerSmokeWindowRegionSummary(
  expected: ComputerSmokeRegionRect[],
  painted: number,
  result: ComputerSmokeWindowRegions,
) {
  const same = (left: ComputerSmokeRegionRect, right: ComputerSmokeRegionRect) =>
    left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  const contains = (outer: ComputerSmokeRegionRect, inner: ComputerSmokeRegionRect) =>
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  const rows = result.ok && result.windows.length === expected.length ? result.windows : []
  const owned = rows.filter((row, index) => row.index === index && row.owned === true).length
  const simple = rows.filter((row) => row.simple === true).length
  const matched = rows.filter(
    (row, index) =>
      row.matches === true &&
      same(row.regionRect, expected[index]!) &&
      row.windowRect.x === expected[index]!.x &&
      row.windowRect.y === expected[index]!.y &&
      contains(row.windowRect, row.regionRect),
  ).length
  return parseComputerSmokeWindowRegionSummary(
    COMPUTER_SMOKE_WINDOW_REGION_MARK +
      JSON.stringify({
        protocol: 1,
        windows: expected.length,
        owned,
        simple,
        matched,
        painted,
        ok:
          result.ok &&
          owned === expected.length &&
          simple === expected.length &&
          matched === expected.length &&
          painted === expected.length,
        ...(!result.ok ? { reason: result.reason } : {}),
      }),
  )
}
