import { describe, expect, test } from "bun:test"
import { compactTokens, delegatedSpend, formatSessionCost, sessionSpend, sessionTokens } from "./session-cost"

const format = (value: number) => `$${value.toFixed(2)}`
const t = (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) =>
  key === "session.cost.unknown" ? "Cost unknown" : `${params.cost} + unpriced`

describe("formatSessionCost", () => {
  test("a fully priced session shows its cost, free ones included", () => {
    expect(formatSessionCost({ cost: 1.5, unpricedSteps: undefined, format, t })).toBe("$1.50")
    expect(formatSessionCost({ cost: 0, unpricedSteps: 0, format, t })).toBe("$0.00")
  })

  test("a session made only of unpriced steps is unknown, not $0.00", () => {
    expect(formatSessionCost({ cost: 0, unpricedSteps: 3, format, t })).toBe("Cost unknown")
    expect(formatSessionCost({ cost: undefined, unpricedSteps: 1, format, t })).toBe("Cost unknown")
  })

  test("a session with some unpriced steps shows its cost as a lower bound", () => {
    expect(formatSessionCost({ cost: 0.42, unpricedSteps: 2, format, t })).toBe("$0.42 + unpriced")
  })

  test("a task's spend includes what its subagents spent", () => {
    const spend = sessionSpend({ cost: 0.6, subagentCost: 2.4, subagentUnpricedSteps: 1 })
    expect(spend).toEqual({ cost: 3, unpricedSteps: 1, codiumSteps: 0 })
    expect(formatSessionCost({ ...spend, format, t })).toBe("$3.00 + unpriced")
    expect(sessionSpend(undefined)).toEqual({ cost: 0, unpricedSteps: 0, codiumSteps: 0 })
  })
})

const tokens = (input: number, output = 0) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })

describe("sessionTokens", () => {
  test("a task's tokens include what its subagents and helpers used", () => {
    expect(sessionTokens({ tokens: tokens(1_000, 200), subagentTokens: tokens(4_000, 600) })).toBe(5_800)
    expect(sessionTokens({ tokens: tokens(10) })).toBe(10)
    expect(sessionTokens(undefined)).toBe(0)
    expect(compactTokens(5_800)).toBe("5.8k")
    expect(compactTokens(2_500_000)).toBe("2.5M")
  })
})

describe("delegatedSpend", () => {
  const launcher = {
    cost: 0.5,
    subagentCost: 1.75,
    subagentUnpricedSteps: 1,
    tokens: tokens(1_000),
    subagentTokens: tokens(7_300, 700),
  }

  test("names each helper by what the user calls it and leaves the rest to subagents", () => {
    const result = delegatedSpend(launcher, [
      { internal: "vectorscope.review", cost: 1, tokens: tokens(4_000, 400) },
      { internal: "vectorscope.verify", cost: 0.25, tokens: tokens(1_000, 100) },
      { internal: "codespace.autocomplete", cost: 0.0004, unpricedSteps: 1, tokens: tokens(300) },
      { cost: 0.4996, tokens: tokens(2_000, 200) },
    ])
    expect(result.helpers).toEqual([
      { label: "Vectorscope review", cost: 1.25, unpricedSteps: 0, codiumSteps: 0, tokens: 5_500 },
      { label: "Autocomplete", cost: 0.0004, unpricedSteps: 1, codiumSteps: 0, tokens: 300 },
    ])
    expect(result.subagents?.cost).toBeCloseTo(0.4996)
    expect(result.subagents).toMatchObject({ unpricedSteps: 0, tokens: 2_200 })
  })

  test("shows no subagent line when helpers account for everything delegated", () => {
    const result = delegatedSpend({ subagentCost: 0.3, subagentTokens: tokens(900) }, [
      { internal: "codespace.edit", cost: 0.1, tokens: tokens(300) },
      { internal: "codespace.edit", cost: 0.2, tokens: tokens(600) },
    ])
    expect(result.helpers).toMatchObject([{ label: "Inline edit", unpricedSteps: 0, tokens: 900 }])
    expect(result.helpers[0]?.cost).toBeCloseTo(0.3)
    expect(result.subagents).toBeUndefined()
    expect(delegatedSpend(undefined, [])).toEqual({ helpers: [], subagents: undefined })
  })
})

test("Codium totals and delegated work have labels without unknown cost or tokens", () => {
  const info = { cost: 0, unpricedSteps: 2, codiumSteps: 2, subagentUnpricedSteps: 3, subagentCodiumSteps: 3 }
  expect(sessionSpend(info)).toEqual({ cost: 0, unpricedSteps: 5, codiumSteps: 5 })
  expect(formatSessionCost({ ...sessionSpend(info), format, t })).toBe("Codium")
  const parts = delegatedSpend(info, [{ internal: "vectorscope.review", unpricedSteps: 3, codiumSteps: 3 }])
  expect(parts.helpers[0]).toMatchObject({ codiumSteps: 3, tokens: 0 })
  expect(parts.subagents).toBeUndefined()
})
test("older engines hide inseparable token totals but keep own dollars", () => {
  const old = { cost: 0.25, unpricedSteps: 4, tokens: tokens(9000), model: { providerID: "vector-plan" } }
  expect(sessionTokens(old)).toBe(0)
  expect(formatSessionCost({ ...sessionSpend(old), format, t })).toBe("$0.25 + Codium")
  const mixed = { ...old, model: { providerID: "own" } }
  const messages = [{ role: "assistant", providerID: "vector-plan" }]
  expect(sessionTokens(mixed, messages)).toBe(0)
  expect(formatSessionCost({ ...sessionSpend(mixed, messages), format, t })).toBe("$0.25 + Codium")
})

test("legacy delegated Codium cannot reappear as a token remainder", () => {
  const root = { subagentTokens: tokens(100000), subagentCost: 0.12, subagentUnpricedSteps: 1 }
  const helper = {
    internal: "vectorscope.review",
    model: { providerID: "vector-plan" },
    tokens: tokens(90000),
    cost: 0,
  }
  expect(sessionTokens(root, [], [helper])).toBe(0)
  expect(sessionSpend(root, [], [helper])).toMatchObject({ cost: 0.12, codiumSteps: 1 })
  const result = delegatedSpend(root, [helper])
  expect(result.helpers[0]).toMatchObject({ tokens: 0, codiumSteps: 1 })
  expect(result.subagents).toMatchObject({ tokens: 0, cost: 0.12, codiumSteps: 1 })
  expect(delegatedSpend(root, [], [{ role: "assistant", providerID: "vector-plan" }]).subagents).toMatchObject({
    tokens: 0,
    cost: 0.12,
    codiumSteps: 1,
  })
})
