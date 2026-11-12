import { describe, expect, test } from "bun:test"
import { recommendationAvailable, recommendModel } from "./economics-recommender"
import { outcomeQualityScore, type ModelOutcome } from "./economics-types"

let idCounter = 0
function outcome(partial: Partial<ModelOutcome> & Pick<ModelOutcome, "provider" | "model">): ModelOutcome {
  idCounter += 1
  return {
    id: `outcome-${idCounter}`,
    projectId: "proj-1",
    category: "frontend",
    createdAt: Date.now(),
    hadChecks: false,
    execution: "completed",
    variant: { kind: "named", name: "low" },
    latencyMs: 1000,
    latencyKind: "assistant-reply-sum",
    changedFiles: 1,
    ...partial,
  }
}

describe("recommendModel", () => {
  test("finite reply-time samples retain a finite median even near the numeric limit", () => {
    const samples = Array.from({ length: 4 }, () =>
      outcome({ provider: "p", model: "m", costUsd: 1, latencyMs: Number.MAX_VALUE }),
    )
    expect(recommendModel(samples, "frontend")).toMatchObject({
      medianLatencyMs: Number.MAX_VALUE,
      timedSamples: 4,
      unknownLatencySamples: 0,
    })
  })

  test("timing can break a fully priced quality tie only with complete comparable coverage", () => {
    const slow = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "slow", costUsd: 1, latencyMs: 100 }))
    const fast = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "fast", costUsd: 1, latencyMs: 10 }))
    expect(recommendModel([...slow, ...fast], "frontend")?.model).toBe("fast")
    for (const patch of [{ latencyMs: undefined }, { latencyMs: NaN }, { latencyMs: -1 }, { latencyKind: undefined }]) {
      const partial = fast.map((item, index) => (index === 0 ? { ...item, ...patch } : item))
      expect(recommendModel([...slow, ...partial], "frontend")).toBeUndefined()
    }
  })

  test("legacy zero and positive durations remain unknown, with cost and failure evidence retained", () => {
    const outcomes = [0, 100, 200].map((latencyMs) =>
      outcome({ provider: "p", model: "legacy", costUsd: 1, latencyMs, latencyKind: undefined }),
    )
    outcomes.push(
      outcome({
        provider: "p",
        model: "legacy",
        costUsd: 2,
        execution: "failed",
        latencyMs: 0,
        latencyKind: undefined,
      }),
    )
    const result = recommendModel(outcomes, "frontend")!
    expect(result).toMatchObject({
      sampleSize: 4,
      completedSamples: 3,
      pricedSamples: 4,
      timedSamples: 0,
      unknownLatencySamples: 4,
    })
    expect(result.medianLatencyMs).toBeUndefined()
    expect(result.medianCostUsd).toBe(1)
    expect(result.evidence).toContain("3 completed or positively validated runs; 1 failed, aborted or incomplete")
  })

  test("strict quality or price winners do not require timing to justify the decision", () => {
    const higherPrice = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "costly", costUsd: 2 }))
    const lowerPrice = Array.from({ length: 3 }, () =>
      outcome({ provider: "p", model: "cheap", costUsd: 1, latencyMs: undefined }),
    )
    expect(recommendModel([...higherPrice, ...lowerPrice], "frontend")?.model).toBe("cheap")
    const checked = lowerPrice.map((item) => ({ ...item, hadChecks: true, checksPassed: true, costUsd: 3 }))
    expect(recommendModel([...higherPrice, ...checked], "frontend")?.model).toBe("cheap")
  })

  test("unknown legacy execution cannot satisfy eligibility without actual passing checks", () => {
    const unknown = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "m", execution: undefined }))
    expect(recommendModel(unknown, "frontend")).toBeUndefined()
    expect(
      recommendModel(
        unknown.map((item) => ({ ...item, hadChecks: true, checksPassed: true })),
        "frontend",
      )?.completedSamples,
    ).toBe(3)
    expect(
      recommendModel(
        unknown.map((item) => ({ ...item, hadChecks: true, checksPassed: false })),
        "frontend",
      ),
    ).toBeUndefined()
  })

  test("known unsuccessful execution cannot qualify through a stale passing validation", () => {
    for (const execution of ["failed", "aborted", "incomplete"] as const) {
      const outcomes = Array.from({ length: 3 }, () =>
        outcome({
          provider: "p",
          model: "m",
          execution,
          hadChecks: true,
          checksPassed: true,
          costUsd: 0,
          costPriced: true,
        }),
      )
      expect(recommendModel(outcomes, "frontend")).toBeUndefined()
    }
  })

  test("stale passing validation cannot improve an already eligible unsuccessful model's quality", () => {
    const reliable = Array.from({ length: 4 }, () => outcome({ provider: "p", model: "reliable", costUsd: 2 }))
    const completed = [0.1, 0.2, 0.3, 0.4].map((costUsd) => outcome({ provider: "p", model: "cheap", costUsd }))
    expect(outcomeQualityScore(completed)).toBe(0.5)

    for (const execution of ["failed", "aborted", "incomplete"] as const) {
      const unsuccessful = outcome({
        provider: "p",
        model: "cheap",
        execution,
        hadChecks: true,
        checksPassed: true,
        costUsd: 0.01,
      })
      const samples = [...completed, unsuccessful]
      expect(outcomeQualityScore(samples)).toBe(0.4)
      expect(recommendModel([...reliable, ...samples], "frontend")?.model).toBe("reliable")
      const evidence = recommendModel(samples, "frontend")!
      expect(evidence).toMatchObject({ sampleSize: 5, completedSamples: 4, pricedSamples: 5, medianCostUsd: 0.2 })
      expect(evidence.evidence).toContain("4 completed or positively validated runs; 1 failed, aborted or incomplete")
      expect(outcomeQualityScore([...completed, { ...unsuccessful, checksPassed: false }])).toBeCloseTo(4 / 15)
    }
  })

  test("completed and positively validated legacy outcomes still earn validation credit", () => {
    const reliable = Array.from({ length: 4 }, () => outcome({ provider: "p", model: "reliable", costUsd: 0.1 }))
    const completed = Array.from({ length: 4 }, () => outcome({ provider: "p", model: "validated", costUsd: 2 }))
    for (const execution of ["completed", undefined] as const) {
      const samples = [
        ...completed,
        outcome({ provider: "p", model: "validated", execution, hadChecks: true, checksPassed: true, costUsd: 2 }),
      ]
      expect(outcomeQualityScore(samples)).toBeCloseTo(2 / 3)
      expect(recommendModel([...reliable, ...samples], "frontend")).toMatchObject({
        model: "validated",
        completedSamples: 5,
      })
    }
  })

  test("failures remain in quality and cost evidence after a model has enough completions", () => {
    const good = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "reliable", costUsd: 2 }))
    const completed = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "flaky", costUsd: 1 }))
    const failed = (["failed", "aborted", "incomplete"] as const).map((execution) =>
      outcome({ provider: "p", model: "flaky", execution, costUsd: 0.01 }),
    )
    expect(recommendModel([...good, ...completed, ...failed], "frontend")?.model).toBe("reliable")
    const evidence = recommendModel([...completed, ...failed], "frontend")!
    expect(evidence.sampleSize).toBe(6)
    expect(evidence.completedSamples).toBe(3)
    expect(evidence.checkPassRate).toBeUndefined()
    expect(evidence.medianCostUsd).toBeCloseTo(0.505)
    expect(outcomeQualityScore([...completed, ...failed])).toBe(0.25)
    expect(evidence.evidence).toContain("3 completed or positively validated runs; 3 failed, aborted or incomplete")
  })

  test("only currently selectable connected models can win, including at use time", () => {
    const outcomes = ["gone", "live"].flatMap((model) =>
      Array.from({ length: 3 }, () => outcome({ provider: "p", model, costUsd: model === "gone" ? 0.01 : 1 })),
    )
    const models = [{ providerID: "p", modelID: "live", variants: ["low"] }]
    const result = recommendModel(outcomes, "frontend", 3, models)!
    expect(result.model).toBe("live")
    expect(recommendModel(outcomes, "frontend", 3, [])).toBeUndefined()
    expect(recommendationAvailable(result, models)).toBe(true)
    expect(recommendationAvailable(result, [])).toBe(false)
    expect(recommendationAvailable(result, [{ providerID: "other", modelID: "live", variants: ["low"] }])).toBe(false)
    expect(recommendationAvailable(result, [{ providerID: "p", modelID: "live", variants: ["max"] }])).toBe(false)
  })

  test("cold start returns undefined when no model has enough samples", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
  })

  test("returns undefined on completely empty history", () => {
    expect(recommendModel([], "frontend")).toBeUndefined()
  })

  test("ignores outcomes from other task categories", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
  })

  test("ranks by check pass rate first", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: true }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.provider).toBe("anthropic")
    expect(result?.model).toBe("claude-sonnet-5")
    expect(result?.checkPassRate).toBeCloseTo(2 / 3, 6)
    expect(result?.sampleSize).toBe(3)
  })

  test("abstains when the sole completed preset has only failed validation", () => {
    const samples = Array.from({ length: 3 }, () =>
      outcome({ provider: "p", model: "fails", hadChecks: true, checksPassed: false, costUsd: 1 }),
    )
    expect(recommendModel(samples, "frontend")).toBeUndefined()
  })

  test("abstains when every completed preset has only failed validation", () => {
    const samples = ["cheap", "expensive"].flatMap((model, index) =>
      Array.from({ length: 3 }, () =>
        outcome({ provider: "p", model, hadChecks: true, checksPassed: false, costUsd: index + 1 }),
      ),
    )
    expect(recommendModel(samples, "frontend")).toBeUndefined()
  })

  test("stale passing checks on unsuccessful executions cannot rescue failed-only validation", () => {
    const samples = Array.from({ length: 3 }, () =>
      outcome({ provider: "p", model: "fails", hadChecks: true, checksPassed: false, costUsd: 1 }),
    )
    for (const execution of ["failed", "aborted", "incomplete"] as const) {
      expect(
        recommendModel(
          [...samples, outcome({ provider: "p", model: "fails", execution, hadChecks: true, checksPassed: true })],
          "frontend",
        ),
      ).toBeUndefined()
    }
  })

  test("credible passing validation restores eligibility without dropping failed checks or their costs", () => {
    const samples = [1, 2, 3].map((costUsd) =>
      outcome({ provider: "p", model: "recovers", hadChecks: true, checksPassed: false, costUsd }),
    )
    for (const execution of ["completed", undefined] as const) {
      const result = recommendModel(
        [
          ...samples,
          outcome({ provider: "p", model: "recovers", execution, hadChecks: true, checksPassed: true, costUsd: 10 }),
        ],
        "frontend",
      )
      expect(result).toMatchObject({
        sampleSize: 4,
        completedSamples: 4,
        pricedSamples: 4,
        unknownCostSamples: 0,
        checkPassRate: 0.25,
        medianCostUsd: 2.5,
      })
      expect(result?.evidence).toContain("checks passed 1/4 runs")
    }
  })

  test("completed presets without observed validation remain eligible", () => {
    for (const validation of [{ hadChecks: false, checksPassed: false }, { hadChecks: true }] as const) {
      const samples = Array.from({ length: 3 }, () => outcome({ provider: "p", model: "unchecked", ...validation }))
      expect(recommendModel(samples, "frontend")).toMatchObject({
        model: "unchecked",
        completedSamples: 3,
        checkPassRate: undefined,
      })
    }
  })

  test("a model whose checks all failed never outranks one that was never checked", () => {
    const failing = Array.from({ length: 3 }, () =>
      outcome({
        provider: "acme",
        model: "always-fails",
        hadChecks: true,
        checksPassed: false,
        costUsd: 5,
        costPriced: true,
      }),
    )
    const unchecked = Array.from({ length: 20 }, () =>
      outcome({ provider: "acme", model: "unchecked", costUsd: 0.01, costPriced: true }),
    )
    expect(recommendModel([...failing, ...unchecked], "frontend", 3)?.model).toBe("unchecked")
    // Passing checks still lifts a model above one with no check data, whatever it costs.
    const passing = Array.from({ length: 3 }, () =>
      outcome({ provider: "acme", model: "passes", hadChecks: true, checksPassed: true, costUsd: 5, costPriced: true }),
    )
    expect(recommendModel([...passing, ...unchecked], "frontend", 3)?.model).toBe("passes")
  })

  test("quality remains decisive when prices are unknown", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: true }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.model).toBe("claude-sonnet-5")
    expect(result?.checkPassRate).toBeCloseTo(2 / 3, 6)
  })

  test("abstains instead of using latency to conceal an unpriced quality tie", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 4000 }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 4200 }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 3800 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 1000 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 1200 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 900 }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result).toBeUndefined()
  })

  test("evidence reports the check pass rate in the expected format", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: false }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.evidence).toContain("checks passed 3/4 runs")
  })

  test("minSamples is configurable", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
    expect(recommendModel(outcomes, "frontend", 2)?.model).toBe("claude-sonnet-5")
  })
})

describe("recommendModel cost ranking", () => {
  const usage = { input: 1_000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const runs = (provider: string, model: string, costUsd: number) =>
    [0, 1, 2].map(() => outcome({ provider, model, costUsd, usage, latencyMs: 1_000 }))

  test("prefers the cheaper model when correctness and latency tie", () => {
    const result = recommendModel(
      [...runs("openai", "gpt-4o", 0.05), ...runs("openai", "gpt-4o-mini", 0.002)],
      "frontend",
      3,
    )
    expect(result?.model).toBe("gpt-4o-mini")
    expect(result?.medianCostUsd).toBeCloseTo(0.002, 10)
    expect(result?.medianTokens).toBe(1_200)
  })

  test("fully priced equal-quality equal-cost candidates may use measured latency", () => {
    const fast = runs("p", "fast", 1).map((item) => ({ ...item, latencyMs: 100 }))
    expect(recommendModel([...runs("p", "slow", 1), ...fast], "frontend")?.model).toBe("fast")
  })

  test("correctness still outranks cost — an expensive model that passes checks beats a cheap one that fails", () => {
    const cheapFailing = [0, 1, 2].map(() =>
      outcome({ provider: "openai", model: "cheap", costUsd: 0.001, usage, hadChecks: true, checksPassed: false }),
    )
    const pricyPassing = [0, 1, 2].map(() =>
      outcome({ provider: "anthropic", model: "pricy", costUsd: 0.5, usage, hadChecks: true, checksPassed: true }),
    )
    expect(recommendModel([...cheapFailing, ...pricyPassing], "frontend", 3)?.model).toBe("pricy")
  })

  test("abstains on a quality tie between measured and unmeasured spend", () => {
    const unmeasured = [0, 1, 2].map(() => outcome({ provider: "x", model: "unmeasured", latencyMs: 1_000 }))
    const measured = [0, 1, 2].map(() =>
      outcome({ provider: "y", model: "measured", costUsd: 9.99, usage, latencyMs: 1_000 }),
    )
    expect(recommendModel([...unmeasured, ...measured], "frontend", 3)).toBeUndefined()
  })

  test("the engine's zero-cost compatibility fallback is not mistaken for a free model", () => {
    const unknown = [0, 1, 2].map(() =>
      outcome({ provider: "x", model: "unpriced", costUsd: 0, usage, latencyMs: 1_000 }),
    )
    const measured = runs("y", "priced", 9.99)
    const result = recommendModel([...unknown, ...measured], "frontend", 3)
    expect(result).toBeUndefined()
  })

  test("a fully priced free run ranks as free; a run with no listed price stays unknown", () => {
    const free = [0, 1, 2].map(() =>
      outcome({ provider: "openrouter", model: "free:free", costUsd: 0, costPriced: true, usage, latencyMs: 1_000 }),
    )
    const unpriced = [0, 1, 2].map(() =>
      outcome({ provider: "local", model: "unpriced", costUsd: undefined, usage, latencyMs: 500 }),
    )
    const paid = runs("y", "priced", 0.5)
    expect(recommendModel([...free, ...unpriced, ...paid], "frontend", 3)).toBeUndefined()
    const result = recommendModel([...free, ...paid], "frontend", 3)
    expect(result?.model).toBe("free:free")
    expect(result?.medianCostUsd).toBe(0)
  })

  test("omits cost fields entirely when no run reported usage", () => {
    const result = recommendModel(
      [0, 1, 2].map(() => outcome({ provider: "x", model: "m" })),
      "frontend",
      3,
    )
    expect(result?.medianCostUsd).toBeUndefined()
    expect(result?.medianTokens).toBeUndefined()
    expect(result?.evidence.some((line) => line.includes("tokens at $"))).toBe(false)
  })

  test("surfaces measured spend as evidence", () => {
    const result = recommendModel(runs("openai", "gpt-4o", 0.0125), "frontend", 3)
    expect(result?.evidence).toContain("3/3 priced; median $0.0125 per priced run")
    expect(result?.evidence).toContain("median 1,200 tokens")
  })

  test("one priced run does not become three cost samples or break a quality tie", () => {
    const partial = runs("p", "partial", 0.001).map((item, index) => ({
      ...item,
      costUsd: index ? undefined : item.costUsd,
    }))
    const result = recommendModel(partial, "frontend")!
    expect(result).toMatchObject({ sampleSize: 3, pricedSamples: 1, unknownCostSamples: 2, medianCostUsd: 0.001 })
    expect(result.evidence).toContain("1/3 priced; median $0.0010 per priced run")
    expect(recommendModel([...partial, ...runs("p", "complete", 2)], "frontend")).toBeUndefined()
    const winner = partial.map((item) => ({ ...item, hadChecks: true, checksPassed: true }))
    expect(recommendModel([...winner, ...runs("p", "complete", 2)], "frontend")?.model).toBe("partial")
  })

  test("an unpriced failure stays in the cost denominator even after enough successful samples", () => {
    const items = [...runs("p", "m", 1), outcome({ provider: "p", model: "m", execution: "failed" })]
    expect(recommendModel(items, "frontend")).toMatchObject({
      sampleSize: 4,
      completedSamples: 3,
      pricedSamples: 3,
      unknownCostSamples: 1,
    })
  })

  test("known-free, invalid and explicitly incomplete prices are distinguished", () => {
    const items = [
      outcome({ provider: "p", model: "m", costUsd: 0, costPriced: true }),
      outcome({ provider: "p", model: "m", costUsd: 3, costPriced: false }),
      outcome({ provider: "p", model: "m", costUsd: Number.NaN }),
      outcome({ provider: "p", model: "m", costUsd: -1 }),
    ]
    expect(recommendModel(items, "frontend")).toMatchObject({
      pricedSamples: 1,
      unknownCostSamples: 3,
      medianCostUsd: 0,
    })
  })
})

describe("exact effort evidence", () => {
  const runs = (name: string | undefined, count: number, costUsd = 1) =>
    Array.from({ length: count }, () =>
      outcome({ provider: "p", model: "m", variant: name ? { kind: "named", name } : undefined, costUsd }),
    )

  test("low and max cannot pool their samples or costs", () => {
    expect(recommendModel([...runs("low", 2), ...runs("max", 2)], "frontend")).toBeUndefined()
    const result = recommendModel([...runs("low", 3, 0.1), ...runs("max", 3, 2)], "frontend")
    expect(result).toMatchObject({ variant: "low", sampleSize: 3, medianCostUsd: 0.1 })
  })

  test("unknown and mixed effort remain in history without qualifying a named preset", () => {
    const items = [
      ...runs("low", 2),
      ...runs(undefined, 3),
      ...runs("max", 3).map((item) => ({ ...item, variant: { kind: "mixed" as const } })),
    ]
    expect(recommendModel(items, "frontend")).toBeUndefined()
    expect(items).toHaveLength(8)
  })

  test("identical UI labels do not merge exact presets or substitute an unavailable one", () => {
    expect(recommendModel([...runs("xhigh", 2), ...runs("max", 2)], "frontend")).toBeUndefined()
    expect(
      recommendModel(runs("xhigh", 3), "frontend", 3, [{ providerID: "p", modelID: "m", variants: ["max"] }]),
    ).toBeUndefined()
    expect(
      recommendModel(runs("xhigh", 3), "frontend", 3, [{ providerID: "p", modelID: "m", variants: ["xhigh"] }])
        ?.variant,
    ).toBe("xhigh")
  })
})

test("historical Codium outcomes cannot win a cheapest-model recommendation", () => {
  const codium = Array.from({ length: 4 }, () =>
    outcome({ provider: "vector-plan", model: "vector-flash", costUsd: 0, costPriced: true }),
  )
  expect(recommendModel(codium, "frontend")).toBeUndefined()
  const own = Array.from({ length: 4 }, () => outcome({ provider: "anthropic", model: "sonnet", costUsd: 0.12 }))
  expect(recommendModel([...codium, ...own], "frontend")?.provider).toBe("anthropic")
})
