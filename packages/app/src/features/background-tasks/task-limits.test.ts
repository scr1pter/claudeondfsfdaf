import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import { english, limitsLine, readLimits, spendText } from "./task-limits"

function limits(input: Partial<Task.Limits> = {}): Task.Limits {
  return { running: 5, queued: 2, maxRunning: 8, launched: 12, maxPerRequest: 32, ...input }
}

const spend = (input: Partial<NonNullable<Task.Limits["spend"]>> = {}) => ({
  spentUsd: 3.1,
  limitUsd: 25,
  unknownSteps: 0,
  warned: false,
  stopped: false,
  ...input,
})

describe("limits line", () => {
  test("running, waiting, started and the request's subagent spend", () => {
    expect(limitsLine(limits({ spend: spend() }))).toBe(
      "5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend",
    )
  })

  test("without spend the line stops at the request count, and waiting shows only while something waits", () => {
    expect(limitsLine(limits())).toBe("5 of 8 running · 2 waiting · 12 of 32 started this request")
    expect(limitsLine(limits({ queued: 0, running: 0, launched: 0 }))).toBe(
      "0 of 8 running · 0 of 32 started this request",
    )
  })

  test("unknown spend reads as unknown, never as $0.00", () => {
    expect(spendText(spend({ spentUsd: 0, unknownSteps: 2 }))).toBe("unknown of $25.00 subagent spend")
    expect(spendText(spend({ spentUsd: 1.2, unknownSteps: 1 }))).toBe("$1.20 + unknown of $25.00 subagent spend")
    expect(limitsLine(limits({ spend: spend({ spentUsd: 0, unknownSteps: 3 }) }))).not.toContain("$0.00")
  })

  test("a ledger with no ceiling and a stopped ledger", () => {
    expect(spendText(spend({ limitUsd: undefined }))).toBe("$3.10 subagent spend")
    expect(spendText(spend({ spentUsd: 25.4, stopped: true }))).toBe(
      "$25.40 of $25.00 subagent spend (ceiling reached)",
    )
  })

  test("a translator replaces every word", () => {
    const upper: typeof english = (key, params) => english(key, params).toUpperCase()
    expect(limitsLine(limits({ spend: spend() }), upper)).toBe(
      "5 OF 8 RUNNING · 2 WAITING · 12 OF 32 STARTED THIS REQUEST · $3.10 OF $25.00 SUBAGENT SPEND",
    )
  })
})

describe("reading limits", () => {
  test("a complete answer is kept, with or without spend", () => {
    expect(readLimits(limits())).toEqual(limits())
    expect(readLimits(limits({ spend: spend() }))).toEqual(limits({ spend: spend() }))
  })

  test("a guest's or an older engine's answer has none, and malformed values never become numbers", () => {
    expect(readLimits(undefined)).toBeUndefined()
    expect(readLimits("<html>")).toBeUndefined()
    expect(readLimits([])).toBeUndefined()
    expect(readLimits({ ...limits(), maxRunning: "8" })).toBeUndefined()
    expect(readLimits({ ...limits(), running: Number.NaN })).toBeUndefined()
    expect(readLimits({ ...limits(), spend: { spentUsd: "1" } })).toEqual(limits())
  })
})
