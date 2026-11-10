import { describe, expect, test } from "bun:test"
import {
  LIMIT_FIELDS,
  SCOPE_NOTES,
  parseUsd,
  parseWarnAt,
  recentRunMeta,
  summaryLine,
  withLimit,
  withWarnAt,
} from "./spend-limits-model"

const window = (costUsd: number, unmeasuredRuns: number) => ({ costUsd, tokens: 0, runs: 0, unmeasuredRuns })

describe("spend limit fields", () => {
  test("one overall set: per run, per day and per month, with no limit for one repository", () => {
    expect(LIMIT_FIELDS.map((field) => field.key)).toEqual(["perRun", "perDay", "perMonth"])
    expect(LIMIT_FIELDS.map((field) => field.label)).toEqual(["Per run", "Per day", "Per month"])
  })

  test("the page says the limits cover every repository and never says project", () => {
    expect(SCOPE_NOTES[0]).toContain("all your repositories together")
    for (const text of [...SCOPE_NOTES, ...LIMIT_FIELDS.map((field) => field.label)])
      expect(text.toLowerCase()).not.toContain("project")
  })

  test("a blank field clears the limit and anything else must be a positive amount", () => {
    expect(parseUsd("")).toEqual({ ok: true, usd: undefined })
    expect(parseUsd("$5")).toEqual({ ok: true, usd: 5 })
    expect(parseUsd("1,200.50")).toEqual({ ok: true, usd: 1200.5 })
    expect(parseUsd("0").ok).toBe(false)
    expect(parseUsd("five").ok).toBe(false)
  })

  test("warn at is a percentage stored as a fraction", () => {
    expect(parseWarnAt("80%")).toEqual({ ok: true, warnAt: 0.8 })
    expect(parseWarnAt(" ")).toEqual({ ok: true, warnAt: undefined })
    expect(parseWarnAt("120").ok).toBe(false)
  })

  test("setting and clearing a cap keeps the column's warn at", () => {
    const set = withLimit({ perDay: { usd: 25, warnAt: 0.9 } }, "perRun", 5)
    expect(set).toEqual({ perDay: { usd: 25, warnAt: 0.9 }, perRun: { usd: 5, warnAt: 0.9 } })
    expect(withLimit(set, "perDay", undefined)).toEqual({ perRun: { usd: 5, warnAt: 0.9 } })
  })

  test("a warn at set before any cap is applied to the first cap", () => {
    expect(withWarnAt({}, 0.7)).toEqual({})
    expect(withLimit({}, "perRun", 5, 0.7)).toEqual({ perRun: { usd: 5, warnAt: 0.7 } })
    // A stored warn at wins over one typed earlier.
    expect(withLimit({ perDay: { usd: 25, warnAt: 0.9 } }, "perRun", 5, 0.7).perRun).toEqual({ usd: 5, warnAt: 0.9 })
  })

  test("warn at applies to every cap in the column", () => {
    expect(withWarnAt({ perRun: { usd: 5 }, perDay: { usd: 25, warnAt: 0.5 } }, 0.7)).toEqual({
      perRun: { usd: 5, warnAt: 0.7 },
      perDay: { usd: 25, warnAt: 0.7 },
    })
    expect(withWarnAt({ perRun: { usd: 5, warnAt: 0.7 } }, undefined)).toEqual({ perRun: { usd: 5 } })
  })
})

describe("spend summary", () => {
  test("states today, this month and the unmeasured runs", () => {
    expect(summaryLine({ all: { day: window(2.1, 0), month: window(14.8, 3) } })).toBe(
      "Today: $2.10 · This month: $14.80 · 3 runs unmeasured",
    )
    expect(summaryLine({ all: { day: window(0, 0), month: window(0.004, 1) } })).toBe(
      "Today: $0.00 · This month: <$0.01 · 1 run unmeasured",
    )
    expect(summaryLine({ all: { day: window(1, 0), month: window(1, 0) } })).toBe("Today: $1.00 · This month: $1.00")
  })

  test("a run with no cost reads unmeasured, not free", () => {
    const meta = recentRunMeta({
      id: "1",
      projectPath: "/p",
      runId: "r",
      provider: "anthropic",
      model: "claude",
      at: "2026-09-27T10:00:00.000Z",
      source: "parallel",
    })
    expect(meta.startsWith("unmeasured · Parallel agent · ")).toBe(true)
  })
})

test("mixed Codium dollar windows retain own spend and the Codium label", () => {
  expect(
    summaryLine({
      all: { day: { ...window(0.12, 0), billing: "codium" }, month: { ...window(0.24, 0), billing: "codium" } },
    }),
  ).toBe("Today: $0.12 + Codium · This month: $0.24 + Codium")
  expect(
    recentRunMeta({
      id: "1",
      projectPath: "/p",
      runId: "r",
      provider: "vector-plan",
      model: "flash",
      at: "2026-09-27T10:00:00.000Z",
      source: "parallel",
      billing: "codium",
      costUsd: 0.12,
    }).startsWith("$0.12 + Codium · "),
  ).toBe(true)
})
