import { describe, expect, test } from "bun:test"
import { SessionID } from "@vectordevai/schema/session-id"
import {
  combineSpend,
  formatUsd,
  measuredCost,
  measuredRun,
  newSpend,
  readSpend,
  sessionCost,
  sessionTokens,
  tokenTotal,
  usageDelta,
} from "./run-usage"

const snapshot = (input: {
  spentUsd: number
  unpricedSteps?: number
  codiumSteps?: number
  costKind?: "priced" | "unknown" | "free" | "codium"
}) => ({
  sessionID: SessionID.make("ses_run_usage"),
  state: "ok" as const,
  budget: { usd: 5 },
  spentUsd: input.spentUsd,
  steps: 3,
  unpricedSteps: input.unpricedSteps ?? 0,
  ...(input.codiumSteps !== undefined ? { codiumSteps: input.codiumSteps } : {}),
  costKind: input.costKind ?? "priced",
})

describe("usageDelta", () => {
  test("is undefined when either reading is missing", () => {
    expect(usageDelta(undefined, 1)).toBeUndefined()
    expect(usageDelta(1, undefined)).toBeUndefined()
  })

  test("never runs backwards", () => {
    expect(usageDelta(2, 0.5)).toBe(0)
    expect(usageDelta(0.5, 2)).toBe(1.5)
  })
})

describe("tokenTotal", () => {
  test("sums every reported bucket and is undefined when none is reported", () => {
    expect(tokenTotal({ input: 10, output: 5, cache: { read: 2 } })).toBe(17)
    expect(tokenTotal({})).toBeUndefined()
    expect(tokenTotal(undefined)).toBeUndefined()
  })
})

describe("sessionCost and sessionTokens", () => {
  test("add what the subagents and helpers below the session spent", () => {
    const data = {
      cost: 0.4,
      tokens: { input: 100, output: 20 },
      subagentCost: 0.25,
      subagentTokens: { input: 50, cache: { read: 10 } },
    }
    expect(sessionCost(data)).toBeCloseTo(0.65, 10)
    expect(sessionTokens(data)).toBe(180)
  })

  test("are undefined when the engine did not report the session's own spend", () => {
    expect(sessionCost({ subagentCost: 1 })).toBeUndefined()
    expect(sessionCost(undefined)).toBeUndefined()
    expect(sessionTokens({ subagentTokens: { input: 5 } })).toBeUndefined()
  })

  test("a session with no subagents reads its own spend", () => {
    expect(sessionCost({ cost: 0.3 })).toBe(0.3)
    expect(sessionTokens({ tokens: { output: 7 } })).toBe(7)
  })
})

describe("measuredCost", () => {
  test("prefers the guard's reading for a priced run", () => {
    // A revert lowered the session total, but the money was still spent.
    expect(measuredCost(snapshot({ spentUsd: 0.42 }), 0, 0.1)).toBe(0.42)
  })

  test("does not undercount a run whose earlier drains left the snapshot", () => {
    expect(measuredCost(snapshot({ spentUsd: 0.1 }), 0, 0.42)).toBe(0.42)
  })

  test("is unknown when unpriced steps ran and nothing was measured", () => {
    expect(measuredCost(snapshot({ spentUsd: 0, unpricedSteps: 2, costKind: "unknown" }), 1, 1)).toBeUndefined()
    expect(measuredCost(snapshot({ spentUsd: 0, unpricedSteps: 2, costKind: "unknown" }), undefined, undefined)).toBe(
      undefined,
    )
  })

  test("falls back to the session delta without a guard reading", () => {
    expect(measuredCost(undefined, 1, 1.25)).toBe(0.25)
    expect(measuredCost(undefined, undefined, 1)).toBeUndefined()
  })
})

describe("readSpend", () => {
  test("reads the snapshot from the spend route", async () => {
    const paths: string[] = []
    const read = await readSpend(async (path) => {
      paths.push(path)
      return { data: snapshot({ spentUsd: 1.5 }) }
    }, "ses_run_usage")
    expect(paths).toEqual(["/api/session/ses_run_usage/spend"])
    expect(read?.spentUsd).toBe(1.5)
  })

  test("is undefined for an empty, malformed or failed answer", async () => {
    expect(await readSpend(async () => ({}), "ses_a")).toBeUndefined()
    expect(await readSpend(async () => ({ data: { spentUsd: "lots" } }), "ses_a")).toBeUndefined()
    expect(
      await readSpend(async () => {
        throw new Error("engine down")
      }, "ses_a"),
    ).toBeUndefined()
  })
})

describe("combineSpend", () => {
  test("adds each drain's spend and steps to the run", () => {
    const first = combineSpend(undefined, snapshot({ spentUsd: 0.3 }))
    const both = combineSpend(first, snapshot({ spentUsd: 0.12, unpricedSteps: 1 }))
    expect(both?.spentUsd).toBeCloseTo(0.42)
    expect(both?.steps).toBe(6)
    expect(both?.unpricedSteps).toBe(1)
    expect(combineSpend(first, undefined)).toBe(first)
  })
})

describe("newSpend", () => {
  test("drops a reading that has not moved since the one already seen", () => {
    const seen = snapshot({ spentUsd: 0.3 })
    expect(newSpend(seen, snapshot({ spentUsd: 0.3 }))).toBeUndefined()
    expect(newSpend(seen, snapshot({ spentUsd: 0.31 }))?.spentUsd).toBe(0.31)
    expect(newSpend(undefined, seen)).toBe(seen)
    expect(newSpend(seen, undefined)).toBeUndefined()
  })
})

describe("formatUsd", () => {
  test("shows cents, and a tiny real spend as under a cent", () => {
    expect(formatUsd(0.42)).toBe("$0.42")
    expect(formatUsd(0.004)).toBe("<$0.01")
    expect(formatUsd(0)).toBe("$0.00")
  })
})

test("Codium drains combine without counting unknown or dollar spend", () => {
  const first = snapshot({ spentUsd: 0, costKind: "codium", codiumSteps: 2 })
  expect(measuredCost(first, 0, 0)).toBe(0)
  const mixed = combineSpend(first, snapshot({ spentUsd: 0.3 }))
  expect(mixed).toMatchObject({ spentUsd: 0.3, codiumSteps: 2, unpricedSteps: 0 })
  expect(combineSpend(mixed, first)).toMatchObject({ spentUsd: 0.3, codiumSteps: 4, unpricedSteps: 0 })
})

describe("measuredRun", () => {
  const zero = { cost: 0, tokens: { input: 0, output: 0 }, model: { providerID: "vector-plan" } }
  test("counts Codium presence and own usage without historical session activity", () => {
    expect(
      measuredRun(snapshot({ spentUsd: 0, costKind: "codium", codiumSteps: 2 }), zero, { ...zero, codiumSteps: 2 }),
    ).toEqual({ totalCostUsd: 0, totalTokens: 0, billing: "codium", costKind: "codium" })
    expect(
      measuredRun(
        undefined,
        { ...zero, codiumSteps: 5 },
        { ...zero, codiumSteps: 5, cost: 0.12, tokens: { input: 80 }, model: { providerID: "own" } },
      ),
    ).toEqual({ totalCostUsd: 0.12, totalTokens: 80, costKind: "priced" })
    expect(measuredRun(undefined, zero, { ...zero, subagentCodiumSteps: 2 })).toEqual({
      totalCostUsd: 0,
      totalTokens: 0,
      billing: "codium",
      costKind: "codium",
    })
  })
  test("a fresh mixed run retains only its own tokens and dollars", () => {
    expect(
      measuredRun(snapshot({ spentUsd: 0.12, costKind: "codium", codiumSteps: 2 }), zero, {
        ...zero,
        cost: 0.12,
        tokens: { input: 80 },
        codiumSteps: 2,
      }),
    ).toEqual({ totalCostUsd: 0.12, totalTokens: 80, billing: "codium", costKind: "priced" })
    // The guard still knows what was spent after a revert lowers the session reading.
    expect(
      measuredRun(snapshot({ spentUsd: 0.12, costKind: "codium", codiumSteps: 2 }), zero, { ...zero, codiumSteps: 2 })
        .totalCostUsd,
    ).toBe(0.12)
  })
  test("Codium does not turn own unknown work into measured zero, or consume its unknown count", () => {
    expect(
      measuredRun(snapshot({ spentUsd: 0, costKind: "codium", codiumSteps: 3, unpricedSteps: 1 }), zero, {
        ...zero,
        tokens: { input: 25 },
        codiumSteps: 3,
      }),
    ).toEqual({ totalCostUsd: undefined, totalTokens: 25, billing: "codium", costKind: "unknown" })
    expect(measuredRun(snapshot({ spentUsd: 0, costKind: "codium", codiumSteps: 3 }), undefined, undefined)).toEqual({
      totalCostUsd: 0,
      totalTokens: undefined,
      billing: "codium",
      costKind: "codium",
    })
  })
  test("unknown mixed work retains the guard's own subtotal after a revert or missing session read", () => {
    const guard = snapshot({ spentUsd: 0.12, costKind: "codium", codiumSteps: 3, unpricedSteps: 1 })
    for (const after of [undefined, { ...zero, cost: 0, codiumSteps: 3 }, { ...zero, cost: 0.04, codiumSteps: 3 }]) {
      expect(measuredRun(guard, zero, after)).toMatchObject({
        totalCostUsd: 0.12,
        billing: "codium",
        costKind: "unknown",
      })
    }
    expect(measuredRun(guard, zero, { ...zero, cost: 0.25, codiumSteps: 3 }).totalCostUsd).toBe(0.25)
  })
  test("legacy Codium totals hide inseparable tokens while retaining own dollars", () => {
    expect(measuredRun(undefined, zero, { ...zero, cost: 0.12, tokens: { input: 100_000 } })).toEqual({
      totalCostUsd: 0.12,
      totalTokens: undefined,
      billing: "codium",
      costKind: "priced",
    })
  })
  test("a later Codium drain retains the known own plan billing kind", () => {
    const plan = { ...snapshot({ spentUsd: 0 }), costKind: "plan" as const }
    const mixed = combineSpend(plan, snapshot({ spentUsd: 0, costKind: "codium", codiumSteps: 2 }))
    expect(measuredRun(mixed, zero, { ...zero, tokens: { input: 25 }, codiumSteps: 2 }).costKind).toBe("plan")
  })
})

test("a missing guard falls back to own unknown deltas after removing inclusive Codium counts", () => {
  const before = { cost: 0, tokens: { input: 0 }, codiumSteps: 2, unpricedSteps: 3 }
  const only = measuredRun(undefined, before, { ...before, codiumSteps: 5, unpricedSteps: 6 })
  expect(only).toEqual({ totalCostUsd: 0, totalTokens: 0, billing: "codium", costKind: "codium" })
  const mixed = measuredRun(undefined, before, { ...before, codiumSteps: 5, unpricedSteps: 7, tokens: { input: 25 } })
  expect(mixed).toEqual({ totalCostUsd: undefined, totalTokens: 25, billing: "codium", costKind: "unknown" })
})
