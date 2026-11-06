import { describe, expect, test } from "bun:test"
import {
  CALIBRATED_OUTPUT_PER_STEP,
  cacheReadShare,
  decideDispatch,
  estimateDispatch,
  remainingUsd,
  SHRINK_ORDER,
  shrinkStepCap,
  STEP_CAP_FRACTION,
  type DispatchDecision,
  type PassPlan,
  type Shrink,
} from "@vectordevai/core/review/dispatch"
import { estimateBands, estimateCostUsd, nextStepCostUsd, NEXT_STEP_SLACK } from "@vectordevai/core/review/plan"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"

// VS-24c: the pre-dispatch estimate and decision (contract VS-24 item 4) with VS-40's v2 beside it, at the default
// maxSteps: review at 30, security at ceil(2/3 · 30) = 20, verify at 10 (run.ts), on Sonnet-like prices.
const SONNET = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const SECURITY_STEPS = Math.ceil((DEFAULT_REVIEW_CONFIG.maxSteps * 2) / 3)
const SMALL: PassPlan[] = [
  {
    pass: "review",
    model: "anthropic/claude-sonnet-4-5",
    promptTokens: 5_300,
    maxSteps: DEFAULT_REVIEW_CONFIG.maxSteps,
    price: SONNET,
  },
  {
    pass: "security",
    model: "anthropic/claude-sonnet-4-5",
    promptTokens: 5_300,
    maxSteps: SECURITY_STEPS,
    price: SONNET,
  },
  { pass: "verify", model: "anthropic/claude-sonnet-4-5", promptTokens: 3_000, maxSteps: 10, price: SONNET },
]
const PILOT_USD = 0.75

// A dollar range that must be there: the passes it is read from are priced.
function priced(range: { low: number; high: number } | undefined) {
  if (!range) throw new Error("the estimate has no dollar range")
  return range
}

describe("estimateDispatch", () => {
  test("a small review at the default maxSteps: the high estimate is over both caps, the low one under", () => {
    expect(DEFAULT_REVIEW_CONFIG.maxSteps).toBe(30)
    expect(SECURITY_STEPS).toBe(20)
    const e = estimateDispatch(SMALL)
    expect(e.firstTurnTokens).toBe(13_600)
    // Low: 5 steps each. High: 30, 20 and 10 steps, whose growth alone is 2.68M tokens.
    expect(e.inputTokens).toEqual({ low: 128_000, high: 2_975_000 })
    const growth = SMALL.reduce((total, pass) => total + (4_000 * pass.maxSteps * (pass.maxSteps - 1)) / 2, 0)
    expect(growth).toBe(2_680_000)
    expect(e.outputTokens).toEqual({ low: 9_000, high: 36_000 })
    expect(e.usd?.low).toBeCloseTo(0.37212, 10)
    expect(e.usd?.high).toBeCloseTo(9.465, 10)
    expect(priced(e.usd).low).toBeLessThan(PILOT_USD)
    expect(priced(e.usd).high).toBeGreaterThan(DEFAULT_REVIEW_CONFIG.maxCostUsd)
    expect(e.unpriced).toEqual([])
  })

  test("each pass's dollars are estimateCostUsd's and its first step nextStepCostUsd's, unchanged", () => {
    const e = estimateDispatch(SMALL)
    e.passes.forEach((estimate, index) => {
      const plan = SMALL[index]
      expect(estimate.usd).toEqual(
        estimateCostUsd({ promptTokens: plan.promptTokens, maxSteps: plan.maxSteps, price: SONNET }),
      )
      expect(estimate.firstStepUsd).toBe(nextStepCostUsd(plan.promptTokens + NEXT_STEP_SLACK, SONNET))
      expect(estimate).toMatchObject(plan)
    })
    expect(e.firstStepUsd).toBeCloseTo(
      e.passes.reduce((total, estimate) => total + (estimate.firstStepUsd ?? 0), 0),
      12,
    )
  })

  test("an unpriced pass counts in the tokens, not in the dollars, and is listed", () => {
    const local: PassPlan = { pass: "review", model: "lmstudio/qwen", promptTokens: 9_000, maxSteps: 30 }
    const e = estimateDispatch([local, SMALL[2]])
    expect(e.firstTurnTokens).toBe(12_000)
    expect(e.unpriced).toEqual(["review"])
    expect(e.passes[0]?.usd).toBeUndefined()
    expect(e.passes[0]?.v2.usd).toBeUndefined()
    expect(e.usd).toEqual(estimateCostUsd({ promptTokens: 3_000, maxSteps: 10, price: SONNET }))
    const free = estimateDispatch([local])
    expect(free.usd).toBeUndefined()
    expect(free.v2.usd).toBeUndefined()
    expect(free.firstStepUsd).toBeUndefined()
  })

  test("no passes give zeros, and go", () => {
    const e = estimateDispatch([])
    expect(e).toEqual({
      passes: [],
      firstTurnTokens: 0,
      inputTokens: { low: 0, high: 0 },
      outputTokens: { low: 0, high: 0 },
      unpriced: [],
      v2: { fitted: "2026-09-14", outputTokens: { low: 0, high: 0 } },
    })
    expect(decideDispatch(e, { maxInputTokens: 1, remainingUsd: 0 })).toEqual({ go: true })
  })

  test("the input is not changed", () => {
    const passes = structuredClone(SMALL)
    estimateDispatch(passes)
    decideDispatch(estimateDispatch(passes), { maxInputTokens: 1, remainingUsd: 0, available: [...SHRINK_ORDER] })
    shrinkStepCap(passes, "review")
    expect(passes).toEqual(SMALL)
  })
})

describe("the v2 estimate (VS-40)", () => {
  test("h(S) against hand-computed values at P 5,300 and R 2,000", () => {
    const band = (steps: number) => ({ steps, growth: 2_000 })
    expect(cacheReadShare(5_300, band(1))).toBe(0)
    expect(cacheReadShare(5_300, band(5))).toBeCloseTo(1 - 13_300 / 46_500, 12)
    expect(cacheReadShare(5_300, band(5))).toBeCloseTo(0.71398, 5)
    expect(cacheReadShare(5_300, band(10))).toBeCloseTo(1 - 23_300 / 143_000, 12)
    expect(cacheReadShare(5_300, band(10))).toBeCloseTo(0.83706, 5)
    expect(cacheReadShare(5_300, band(20))).toBeCloseTo(1 - 43_300 / 486_000, 12)
    expect(cacheReadShare(5_300, band(30))).toBeCloseTo(1 - 63_300 / 1_029_000, 12)
    expect(cacheReadShare(0, band(1))).toBe(0)
    expect(cacheReadShare(Number.NaN, band(5))).toBe(0)
    expect(cacheReadShare(-5_000, band(2))).toBe(0)
  })

  test("a cached pass is priced at h(S) cache reads and the cache-write price, with 1,800 output tokens a step", () => {
    const e = estimateDispatch(SMALL.map((pass) => ({ ...pass, cached: true })))
    const review = e.passes[0]
    expect(review.v2.cacheReadShare.low).toBeCloseTo(0.71398, 5)
    expect(review.v2.cacheReadShare.high).toBeCloseTo(1 - 121_300 / 1_899_000, 12)
    expect(review.v2.cacheReadShare.high).toBeCloseTo(0.93612, 5)
    expect(review.v2.outputTokens).toEqual({ low: 9_000, high: 54_000 })
    // Low: 13,300 written at $3.75, 33,200 read at $0.30, 9,000 out at $15.
    expect(review.v2.usd?.low).toBeCloseTo(13_300 * 3.75e-6 + 33_200 * 0.3e-6 + 9_000 * 15e-6, 10)
    expect(review.v2.usd?.low).toBeCloseTo(0.194835, 10)
    // High: 121,300 written, 1,777,700 read, 54,000 out.
    expect(review.v2.usd?.high).toBeCloseTo(1.798185, 10)
    // The same estimateCostUsd prices it, with VS-40's inputs (I-10).
    expect(review.v2.usd).toEqual(
      estimateCostUsd({
        promptTokens: 5_300,
        maxSteps: 30,
        price: SONNET,
        cacheReadShare: review.v2.cacheReadShare,
        writePrice: SONNET.cacheWrite,
        outputPerStep: CALIBRATED_OUTPUT_PER_STEP.tokens,
      }),
    )
    expect(e.v2.fitted).toBe("2026-09-14")
    expect(CALIBRATED_OUTPUT_PER_STEP).toEqual({ tokens: 1_800, fitted: "2026-09-14", cases: 1 })
    // The legacy range is the same whether or not the pass is cached.
    expect(e.usd).toEqual(estimateDispatch(SMALL).usd)
  })

  test("without caching, or without a cache-read price, it uses the catalog's input price throughout", () => {
    const review = estimateDispatch(SMALL).passes[0]
    expect(review.v2.cacheReadShare).toEqual({ low: 0, high: 0 })
    expect(review.v2.usd?.low).toBeCloseTo(46_500 * 3e-6 + 9_000 * 15e-6, 10)
    expect(review.v2.usd?.low).toBeCloseTo(0.2745, 10)
    const listed = { input: 3, output: 15, cacheWrite: 3.75 }
    const unlisted = estimateDispatch([{ ...SMALL[0], price: listed, cached: true }]).passes[0]
    expect(unlisted.v2.cacheReadShare).toEqual({ low: 0, high: 0 })
    expect(unlisted.v2.usd?.low).toBeCloseTo(0.2745, 10)
  })

  test("never decides: an uncached v2 low over the pilot cap still goes on the legacy low", () => {
    const e = estimateDispatch(SMALL)
    expect(e.v2.usd?.low).toBeCloseTo(0.789, 10)
    expect(priced(e.v2.usd).low).toBeGreaterThan(PILOT_USD)
    expect(priced(e.usd).low).toBeLessThan(PILOT_USD)
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: PILOT_USD })).toEqual({ go: true })
  })
})

describe("decideDispatch", () => {
  test("goes at the default cap and the pilot's, although a high-estimate gate would fire at both", () => {
    const e = estimateDispatch(SMALL)
    for (const remaining of [DEFAULT_REVIEW_CONFIG.maxCostUsd, PILOT_USD]) {
      expect(priced(e.usd).high).toBeGreaterThan(remaining)
      expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: remaining })).toEqual({ go: true })
    }
    // The low estimate is the boundary.
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: priced(e.usd).low })).toEqual({ go: true })
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: priced(e.usd).low - 1e-9 })).toMatchObject({
      go: false,
      over: ["usd"],
    })
  })

  test("caps first-turn tokens, summed over the passes, free and local ones included", () => {
    const e = estimateDispatch(SMALL)
    expect(decideDispatch(e, { maxInputTokens: 13_600 })).toEqual({ go: true })
    expect(decideDispatch(e, { maxInputTokens: 13_599 })).toEqual({
      go: false,
      over: ["input-tokens"],
      stop: "budget-estimate",
      ineffective: [],
    })
    // 0 means no cap.
    expect(decideDispatch(e, { maxInputTokens: 0 })).toEqual({ go: true })
    const local = estimateDispatch([{ pass: "review", model: "lmstudio/qwen", promptTokens: 20_000, maxSteps: 30 }])
    expect(decideDispatch(local, { maxInputTokens: 19_999, remainingUsd: 0 })).toMatchObject({
      go: false,
      over: ["input-tokens"],
    })
    // A prompt whose size is not a number fits under no cap.
    const unknown = estimateDispatch([{ ...SMALL[0], promptTokens: Number.NaN }])
    expect(decideDispatch(unknown, { maxInputTokens: 100_000 })).toMatchObject({ go: false, over: ["input-tokens"] })
  })

  test("checks dollars only when a remainder is given and a pass is priced", () => {
    const e = estimateDispatch(SMALL)
    expect(decideDispatch(e, { maxInputTokens: 0 })).toEqual({ go: true })
    for (const remaining of [0, -1, Number.NaN])
      expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: remaining })).toMatchObject({
        go: false,
        over: ["usd"],
      })
    const free = estimateDispatch([{ pass: "review", model: "vector/free-model", promptTokens: 5_300, maxSteps: 30 }])
    expect(decideDispatch(free, { maxInputTokens: 0, remainingUsd: 0 })).toEqual({ go: true })
    expect(decideDispatch(e, { maxInputTokens: 1, remainingUsd: 0 })).toMatchObject({ over: ["input-tokens", "usd"] })
  })

  test("names the first available lever in SHRINK_ORDER, whatever order they are listed in", () => {
    const e = estimateDispatch(SMALL)
    const decide = (available: Shrink[]) => decideDispatch(e, { maxInputTokens: 1, remainingUsd: 0, available })
    expect(decide(["diff", "dependents", "cards", "lenses"])).toEqual({
      go: false,
      over: ["input-tokens", "usd"],
      shrink: "lenses",
      ineffective: [],
    })
    expect(decide(["diff", "cards"])).toMatchObject({ shrink: "cards" })
    expect(decide([])).toEqual({ go: false, over: ["input-tokens", "usd"], stop: "budget-estimate", ineffective: [] })
  })

  // VS-40's order, with each step-cap lever named only when it can lower a limit that is over. A step cap never lowers
  // first-turn tokens, and at the default caps halving them leaves S_low = min(5, cap) unchanged, so they are passed
  // over; under a cap below 10 halving cuts S below 5 and they act.
  test("walks SHRINK_ORDER, passing over levers that cannot lower the limit that is over", () => {
    expect(walk(SMALL, [...SHRINK_ORDER], { maxInputTokens: 0, remainingUsd: 0 })).toEqual([
      "lenses",
      "cards",
      "dependents",
      "diff",
      "stop",
    ])
    const tight = SMALL.map((pass) => ({ ...pass, maxSteps: 8 }))
    expect(walk(tight, [...SHRINK_ORDER], { maxInputTokens: 0, remainingUsd: 0 })).toEqual([
      "lenses",
      "cards",
      "steps:verify",
      "steps:security",
      "steps:review",
      "dependents",
      "diff",
      "stop",
    ])
    // Only the dollars are over a step cap's reach: with the token cap alone over, it is never named.
    expect(walk(tight, [...SHRINK_ORDER], { maxInputTokens: 1 })).toEqual([
      "lenses",
      "cards",
      "dependents",
      "diff",
      "stop",
    ])
  })

  test("with VS-24 wiring's live levers (step caps and diff trim), the defaults go straight to diff trim", () => {
    const e = estimateDispatch(SMALL)
    const live: Shrink[] = ["steps:verify", "steps:security", "steps:review", "diff"]
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: 0.1, available: live })).toEqual({
      go: false,
      over: ["usd"],
      shrink: "diff",
      ineffective: ["steps:verify", "steps:security", "steps:review"],
    })
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: 0.1, available: live.slice(0, 3) })).toEqual({
      go: false,
      over: ["usd"],
      stop: "budget-estimate",
      ineffective: ["steps:verify", "steps:security", "steps:review"],
    })
    // Halving every cap at the defaults lowers only the high estimate.
    const halved = (["verify", "security", "review"] as const).reduce(
      (passes, pass) => shrinkStepCap(passes, pass),
      SMALL,
    )
    expect(halved.map((pass) => pass.maxSteps)).toEqual([15, 10, 5])
    const after = estimateDispatch(halved)
    expect(after.usd?.low).toBe(e.usd?.low)
    expect(after.firstTurnTokens).toBe(e.firstTurnTokens)
    expect(priced(after.usd).high).toBeLessThan(priced(e.usd).high)
  })
})

describe("shrinkStepCap", () => {
  test("halves the named pass's cap, at least one step, never above the current cap", () => {
    expect(STEP_CAP_FRACTION).toBe(0.5)
    const cap = (maxSteps: number, fraction?: number) =>
      shrinkStepCap([{ ...SMALL[0], maxSteps }], "review", fraction)[0].maxSteps
    expect([30, 20, 10, 3, 1].map((steps) => cap(steps))).toEqual([15, 10, 5, 1, 1])
    for (const fraction of [2, 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(cap(30, fraction)).toBeLessThanOrEqual(30)
    expect(cap(30, 2)).toBe(30)
    expect(cap(30, 0)).toBe(30)
    expect(cap(30, Number.NaN)).toBe(30)
    expect(cap(30, 0.1)).toBe(3)
    expect(cap(0.5)).toBe(0.5)
  })

  test("changes only the named pass", () => {
    const shrunk = shrinkStepCap(SMALL, "security")
    expect(shrunk.map((pass) => pass.maxSteps)).toEqual([30, 10, 10])
    expect(shrunk[0]).toEqual(SMALL[0])
    expect(shrunk[2]).toEqual(SMALL[2])
    expect(shrinkStepCap(SMALL, "verify").map((pass) => pass.maxSteps)).toEqual([30, 20, 5])
  })
})

describe("remainingUsd (VS-40 item 3)", () => {
  const config = {
    maxCostUsd: DEFAULT_REVIEW_CONFIG.maxCostUsd,
    maxCostUsdPerPr: DEFAULT_REVIEW_CONFIG.maxCostUsdPerPr,
    maxCostUsdPerMonth: 50,
  }

  test("is maxCostUsd without prior spend, the CLI's case", () => {
    expect(remainingUsd(config)).toBe(2)
    expect(remainingUsd(DEFAULT_REVIEW_CONFIG)).toBe(DEFAULT_REVIEW_CONFIG.maxCostUsd)
  })

  test("includes this PR's and this month's prior spend when they are passed", () => {
    expect(remainingUsd(config, { trigger: "auto", prUsd: 9.5 })).toBeCloseTo(0.5, 12)
    expect(remainingUsd(config, { trigger: "auto", prUsd: 1 })).toBe(2)
    expect(remainingUsd(config, { trigger: "auto", monthUsd: 49.9 })).toBeCloseTo(0.1, 12)
    expect(remainingUsd(config, { trigger: "auto", prUsd: 12 })).toBe(-2)
    // A spend that cannot be read leaves nothing of its cap.
    expect(remainingUsd(config, { trigger: "auto", prUsd: Number.NaN })).toBe(Number.NEGATIVE_INFINITY)
    expect(remainingUsd(config, { trigger: "auto", monthUsd: -1 })).toBe(Number.NEGATIVE_INFINITY)
  })

  // decideSkip applies the per-PR cap to automatic reviews only, so `/review` on a PR past it still runs.
  test("leaves the per-PR cap out unless the review is automatic, and keeps the month cap for every trigger", () => {
    for (const trigger of ["command", "local", "desktop"] as const) {
      expect(remainingUsd(config, { trigger, prUsd: 12 })).toBe(2)
      expect(remainingUsd(config, { trigger, prUsd: Number.NaN })).toBe(2)
      expect(remainingUsd(config, { trigger, monthUsd: 49.9 })).toBeCloseTo(0.1, 12)
    }
    const e = estimateDispatch(SMALL)
    const decide = (trigger: "auto" | "command") =>
      decideDispatch(e, { maxInputTokens: 0, remainingUsd: remainingUsd(config, { trigger, prUsd: 12 }) })
    expect(decide("command")).toEqual({ go: true })
    expect(decide("auto")).toEqual({ go: false, over: ["usd"], stop: "budget-estimate", ineffective: [] })
  })

  test("drops the caps that are 0, which mean none, and is undefined when none is left", () => {
    const none = { maxCostUsd: 0, maxCostUsdPerPr: 0, maxCostUsdPerMonth: 0 }
    expect(remainingUsd(none, { trigger: "auto", prUsd: 5, monthUsd: 5 })).toBeUndefined()
    expect(remainingUsd({ ...config, maxCostUsd: 0 })).toBeUndefined()
    expect(remainingUsd({ ...config, maxCostUsd: 0 }, { trigger: "auto", prUsd: 4 })).toBe(6)
    expect(remainingUsd({ ...config, maxCostUsd: 0 }, { trigger: "command", prUsd: 4 })).toBeUndefined()
    // An uncapped review is never stopped for dollars.
    const e = estimateDispatch(SMALL)
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: remainingUsd({ ...config, maxCostUsd: 0 }) })).toEqual({
      go: true,
    })
  })
})

const STEP_PASS: Partial<Record<Shrink, "verify" | "security" | "review">> = {
  "steps:verify": "verify",
  "steps:security": "security",
  "steps:review": "review",
}

// The levers decideDispatch names, in order, applying a step-cap lever with shrinkStepCap and re-estimating, and
// taking every lever off the list once it is applied: what VS-24 wiring's shrink loop does, minus the prompt edits.
function walk(
  passes: readonly PassPlan[],
  available: Shrink[],
  limits: { maxInputTokens: number; remainingUsd?: number },
): (Shrink | "stop")[] {
  const decision: DispatchDecision = decideDispatch(estimateDispatch(passes), { ...limits, available })
  if (decision.go) return []
  if ("stop" in decision) return ["stop"]
  const lever = decision.shrink
  const step = STEP_PASS[lever]
  return [
    lever,
    ...walk(
      step ? shrinkStepCap(passes, step) : passes,
      available.filter((item) => item !== lever),
      limits,
    ),
  ]
}

describe("estimateBands at the default caps", () => {
  test("S_low is min(5, cap), which a 50% shrink moves only below a cap of 10", () => {
    expect([30, 20, 10, 8].map((cap) => estimateBands(cap).low.steps)).toEqual([5, 5, 5, 5])
    expect([15, 10, 5, 4].map((cap) => estimateBands(cap).low.steps)).toEqual([5, 5, 5, 4])
  })
})
