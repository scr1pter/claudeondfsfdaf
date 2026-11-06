import { describe, expect, test } from "bun:test"
import {
  combineCostKinds,
  contextRefusal,
  diffBudgetChars,
  estimateCostUsd,
  MIN_CONTEXT,
  nextStepCostUsd,
  planSpecialists,
} from "@vectordevai/core/review/plan"

describe("planSpecialists", () => {
  test("adds security for sensitive paths when it is auto", () => {
    expect(planSpecialists([{ path: "src/list.ts" }], { security: "auto" })).toEqual(["review"])
    expect(planSpecialists([{ path: "src/list.ts" }, { path: "src/db.ts" }], { security: "auto" })).toEqual([
      "review",
      "security",
    ])
    expect(planSpecialists([{ path: "src/login-form.ts", oldPath: "src/auth.ts" }], { security: "auto" })).toEqual([
      "review",
      "security",
    ])
    expect(planSpecialists([{ path: "src/renamed.ts", oldPath: "src/auth.ts" }], { security: "auto" })).toEqual([
      "review",
      "security",
    ])
  })

  test("follows always and off", () => {
    expect(planSpecialists([{ path: "src/list.ts" }], { security: "always" })).toEqual(["review", "security"])
    expect(planSpecialists([{ path: "src/db.ts" }], { security: "off" })).toEqual(["review"])
  })
})

describe("context budget", () => {
  test("gives the values in section 5.3", () => {
    expect(MIN_CONTEXT).toBe(32_000)
    expect(diffBudgetChars(32_000, 120_000)).toBe(16_800)
    expect(diffBudgetChars(128_000, 120_000)).toBe(79_800)
    expect(diffBudgetChars(1_000_000, 120_000)).toBe(120_000)
    expect(diffBudgetChars(1_000_000, 50_000)).toBe(50_000)
    expect(diffBudgetChars(10_000, 120_000)).toBe(8_000)
  })

  test("refuses models under 32k of context", () => {
    expect(contextRefusal("acme/tiny", 16_000)).toBe(
      "Vectorscope reviews need a model with at least 32k tokens of context; acme/tiny has 16k.",
    )
    expect(contextRefusal("acme/tiny", 0)).toBe(
      "Vectorscope reviews need a model with at least 32k tokens of context; acme/tiny has no listed context size.",
    )
    expect(contextRefusal("acme/ok", 32_000)).toBeUndefined()
    expect(contextRefusal("acme/big", 1_000_000)).toBeUndefined()
  })
})

describe("estimateCostUsd", () => {
  const price = { input: 3, output: 15, cacheRead: 0.3 }

  test("computes the low and high formulas in section 5.2", () => {
    const { low, high } = estimateCostUsd({ promptTokens: 10_000, maxSteps: 30, price })
    // low: 5 steps; 10k in full, 40k cached, 20k growth; 3k out
    expect(low).toBeCloseTo((10_000 + 20_000) * 3e-6 + 40_000 * 0.3e-6 + 3_000 * 15e-6, 10)
    // high: 30 steps; 300k + 1.74M growth at the full price; 18k out
    expect(high).toBeCloseTo(2_040_000 * 3e-6 + 18_000 * 15e-6, 10)
  })

  test("keeps low below high, and grows with steps", () => {
    for (const maxSteps of [2, 4, 8, 20, 30]) {
      const { low, high } = estimateCostUsd({ promptTokens: 20_000, maxSteps, price })
      expect(low).toBeLessThan(high)
    }
    const at = (maxSteps: number) => estimateCostUsd({ promptTokens: 20_000, maxSteps, price })
    expect(at(30).high).toBeGreaterThan(at(10).high)
    expect(at(8).low).toBeGreaterThan(at(4).low)
  })

  test("charges the full price for the low estimate when no cache price is known", () => {
    const cached = estimateCostUsd({ promptTokens: 20_000, maxSteps: 30, price }).low
    const uncached = estimateCostUsd({ promptTokens: 20_000, maxSteps: 30, price: { input: 3, output: 15 } }).low
    expect(uncached).toBeGreaterThan(cached)
  })
})

describe("nextStepCostUsd", () => {
  test("charges cache reads at the cache price when there is one", () => {
    expect(nextStepCostUsd(50_000, { input: 3, output: 15, cacheRead: 0.3 }, 40_000)).toBeCloseTo(
      (10_000 * 3 + 40_000 * 0.3 + 600 * 15) / 1e6,
      10,
    )
    expect(nextStepCostUsd(50_000, { input: 3, output: 15 }, 40_000)).toBeCloseTo((50_000 * 3 + 600 * 15) / 1e6, 10)
    expect(nextStepCostUsd(50_000, { input: 3, output: 15, cacheRead: 0.3 })).toBeCloseTo(
      (50_000 * 3 + 600 * 15) / 1e6,
      10,
    )
  })

  test("never counts more cached tokens than the context", () => {
    const price = { input: 3, output: 15, cacheRead: 0.3 }
    expect(nextStepCostUsd(10_000, price, 99_000)).toBeCloseTo(nextStepCostUsd(10_000, price, 10_000), 10)
    expect(nextStepCostUsd(0, { input: 0, output: 0 })).toBe(0)
  })
})

describe("combineCostKinds", () => {
  test("free passes add nothing to a priced or a subscription pass; other mixes have no single price", () => {
    expect(combineCostKinds(["priced", "priced"])).toBe("priced")
    expect(combineCostKinds(["free", "priced"])).toBe("priced")
    expect(combineCostKinds(["free", "plan"])).toBe("plan")
    expect(combineCostKinds(["free"])).toBe("free")
    expect(combineCostKinds(["priced", "plan"])).toBe("unknown")
    expect(combineCostKinds(["free", "unknown"])).toBe("unknown")
    expect(combineCostKinds([])).toBe("unknown")
  })

  // Codium mixed with a priced or a subscription pass is left to the review wording that shows "$X + Codium".
  test("a review whose passes ran on Vector Codium, alone or beside free passes, is a Codium review", () => {
    expect(combineCostKinds(["codium"])).toBe("codium")
    expect(combineCostKinds(["codium", "codium"])).toBe("codium")
    expect(combineCostKinds(["free", "codium"])).toBe("codium")
    expect(combineCostKinds(["codium", "free", "free"])).toBe("codium")
  })
})
