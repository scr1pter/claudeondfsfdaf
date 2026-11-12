import { describe, expect, test } from "bun:test"
import { helperUsage, normalizeUsageSummary, usageStreakCalendar, usageTokens } from "./usage-summary"

describe("helperUsage", () => {
  test("groups helper spend under the names the user knows, most expensive first", () => {
    expect(
      helperUsage([
        { id: "codespace.autocomplete", sessions: 9, responses: 54, tokens: 40_000, cost: 0.03 },
        { id: "vectorscope.review", sessions: 2, responses: 14, tokens: 90_000, cost: 0.4 },
        { id: "vectorscope.verify", sessions: 2, responses: 2, tokens: 10_000, cost: 0.05 },
      ]),
    ).toEqual([
      { label: "Vectorscope review", sessions: 4, responses: 16, tokens: 100_000, cost: 0.45 },
      { label: "Autocomplete", sessions: 9, responses: 54, tokens: 40_000, cost: 0.03 },
    ])
  })

  test("is empty for a server that reports no helpers", () => {
    expect(helperUsage(normalizeUsageSummary({}).helpers)).toEqual([])
  })
})

test("Codium-only and mixed helper groups preserve work without reconstructing tokens or dollars", () => {
  expect(
    helperUsage([
      { id: "vectorscope.review", sessions: 2, responses: 3, tokens: 0, cost: 0, codiumSteps: 3 },
      { id: "vectorscope.verify", sessions: 1, responses: 1, tokens: 10, cost: 0.01 },
    ]),
  ).toEqual([{ label: "Vectorscope review", sessions: 3, responses: 4, tokens: 10, cost: 0.01, codiumSteps: 3 }])
  expect(usageTokens(0, 7)).toBe("Codium")
  expect(usageTokens(1500, 7, (value) => `${value / 1000}K`)).toBe("1.5K tokens + Codium")
  expect(usageTokens(0)).toBe("0 tokens")
})

test("normalization keeps optional Codium activity and older-server empty defaults", () => {
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  const summary = normalizeUsageSummary({
    codiumResponses: 4,
    days: [{ date, tokens: 0, tasks: 1, cost: 0, codium: 4 }],
  })
  expect(summary.codiumResponses).toBe(4)
  expect(summary.favoriteModels).toEqual([])
  expect(usageStreakCalendar(summary).at(-1)).toMatchObject({ date, active: true, tokens: 0, codium: 4, today: true })
  expect(normalizeUsageSummary(undefined).codiumResponses).toBeUndefined()
})

test("an older mixed summary hides inseparable tokens, preserves own dollars and never invents daily Codium", () => {
  const result = normalizeUsageSummary({
    lifetimeTokens: 9000,
    lifetimeCost: 0.5,
    inputTokens: 8500,
    outputTokens: 500,
    completedChats: 2,
    favoriteModels: [
      { providerID: "vector-plan", modelID: "plus", tokens: 8000, responses: 4, percentage: 88.9 },
      { providerID: "openai", modelID: "own", tokens: 1000, responses: 1, percentage: 11.1 },
    ],
    days: [{ date: "2026-11-01", tokens: 9000, tasks: 2, cost: 0.5 }],
    helpers: [{ id: "vectorscope.review", sessions: 1, responses: 1, tokens: 500, cost: 0.05 }],
  })
  expect(result).toMatchObject({
    legacyCodium: true,
    lifetimeTokens: 0,
    lifetimeCost: 0.5,
    inputTokens: 0,
    outputTokens: 0,
    completedChats: 2,
    codiumResponses: 4,
  })
  expect(result.favoriteModels).toEqual([
    { providerID: "openai", modelID: "own", tokens: 1000, responses: 1, percentage: 11.1 },
  ])
  expect(result.days).toEqual([{ date: "2026-11-01", tokens: 0, tasks: 2, cost: 0.5 }])
  expect(result.helpers?.[0]).toMatchObject({ sessions: 1, responses: 1, tokens: 0, cost: 0.05 })
  expect(result.helpers?.[0]?.codiumSteps).toBeUndefined()
  expect(usageTokens(0, undefined, undefined, true)).toBe("Token totals unavailable")
  expect(normalizeUsageSummary(result)).toEqual(result)
})
