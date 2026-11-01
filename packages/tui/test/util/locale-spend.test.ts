import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("Locale.spend", () => {
  test("a fully priced session shows its cost, free ones included", () => {
    expect(Locale.spend(1.5, undefined)).toBe("$1.50")
    expect(Locale.spend(0, 0)).toBe("$0.00")
  })

  test("a session made only of unpriced steps is unknown, not $0.00", () => {
    expect(Locale.spend(0, 2)).toBe("cost unknown")
  })

  test("a session with some unpriced steps shows its cost as a lower bound", () => {
    expect(Locale.spend(0.42, 1)).toBe("$0.42 + unpriced")
  })

  test("a session's spend includes what its subagents spent", () => {
    expect(Locale.sessionSpend({ cost: 0.6, subagentCost: 2.4, subagentUnpricedSteps: 1 })).toEqual({
      cost: 3,
      unpriced: 1,
      codium: 0,
    })
    expect(Locale.sessionSpend(undefined)).toEqual({ cost: 0, unpriced: 0, codium: 0 })
  })
  test("Codium is separate from own unpriced work and preserves own dollars", () => {
    expect(Locale.spend(0, 3, 3)).toBe("Codium")
    expect(Locale.spend(0.12, 4, 3)).toBe("$0.12 + unpriced + Codium")
    expect(Locale.spend(0, 4, 3)).toBe("cost unknown + Codium")
    expect(
      Locale.sessionSpend({
        cost: 0.12,
        unpricedSteps: 3,
        codiumSteps: 3,
        subagentCodiumSteps: 2,
        subagentUnpricedSteps: 2,
      }),
    ).toEqual({ cost: 0.12, unpriced: 5, codium: 5 })
  })
  test("loaded legacy messages and children prevent old Codium figures resurfacing", () => {
    const legacy = Locale.sessionSpend({ cost: 0.12, unpricedSteps: 4 }, [
      { role: "assistant", providerID: "vector-plan" },
    ])
    expect(Locale.spend(legacy.cost, legacy.unpriced, legacy.codium)).toBe("$0.12 + Codium")
    expect(Locale.legacyCodium({ cost: 0.12 }, [], [{ model: { id: "test", providerID: "vector-plan" } }])).toBe(true)
    expect(Locale.legacyCodium({ cost: 0.12, codiumSteps: 0, subagentCodiumSteps: 0 })).toBe(false)
  })
})

test("legacy mixed sessions retain explicitly observed own unknown work", () => {
  const spend = Locale.sessionSpend({ cost: 0.12, unpricedSteps: 2 }, [
    { role: "assistant", providerID: "vector-plan", unpriced: true },
    { role: "assistant", providerID: "own", unpriced: true },
  ])
  expect(Locale.spend(spend.cost, spend.unpriced, spend.codium)).toBe("$0.12 + unpriced + Codium")
  const children = Locale.sessionSpend(
    { subagentCost: 0.12 },
    [],
    [{ model: { providerID: "vector-plan", id: "m" } }, { cost: 0.12, unpricedSteps: 2, codiumSteps: 0 }],
  )
  expect(Locale.spend(children.cost, children.unpriced, children.codium)).toBe("$0.12 + unpriced + Codium")
})
