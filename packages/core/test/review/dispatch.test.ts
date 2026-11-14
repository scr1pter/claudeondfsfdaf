import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  CALIBRATED_OUTPUT_PER_STEP,
  cacheReadShare,
  calibratedOutputPerStep,
  decideDispatch,
  estimateDispatch,
  OUTPUT_FITS,
  remainingUsd,
  SHRINK_ORDER,
  shrinkStepCap,
  STEP_CAP_FRACTION,
  type DispatchDecision,
  type PassPlan,
  type Shrink,
} from "@vectordevai/core/review/dispatch"
import {
  estimateBands,
  estimateCostUsd,
  nextStepCostUsd,
  NEXT_STEP_SLACK,
  type ReviewPrice,
} from "@vectordevai/core/review/plan"
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

// VS-40a (addendum B §1.3): long-context tiers and effort-keyed output in the estimate. The grid and its digests were
// printed by estimateDispatch at HEAD bfd8bdd6, before VS-40a.
const GRID_PROMPTS = [0, 1, 1_234.5, 5_300, 52_000, 95_000, 190_000, 248_000]
const GRID_STEPS = [0, 1, 5, 7.9, 10, 20, 30]
const GRID_PRICES: ReviewPrice[] = [
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { input: 3, output: 15 },
  { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { input: 5, output: 30, cacheRead: 0.5 },
  { input: 1.1, output: 4.4, cacheRead: 0.11 },
]
const gridPlans = (attach: (price: ReviewPrice) => ReviewPrice): PassPlan[] =>
  GRID_PRICES.flatMap((price) =>
    GRID_PROMPTS.flatMap((promptTokens) =>
      GRID_STEPS.flatMap((maxSteps) =>
        [undefined, false, true].map((cached) => ({
          pass: "review",
          model: "vectorscope-projection/vendor/model",
          promptTokens,
          maxSteps,
          price: attach(price),
          ...(cached === undefined ? {} : { cached }),
        })),
      ),
    ),
  )
// A tier above 100,000 at five times each grid price, which the grid's larger prompts and growth pass.
const withTier = (price: ReviewPrice): ReviewPrice => ({
  ...price,
  tiers: [
    {
      above: 100_000,
      input: price.input * 5,
      output: price.output * 5,
      ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead * 5 }),
      ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite * 5 }),
    },
  ],
})
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
// The digest with VS-40a's additions left out: each estimate's `tiered` and each price's `tiers`.
const untiered = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value, (key, item) => (key === "tiered" || key === "tiers" ? undefined : item)))
    .digest("hex")
const HAIKU_55 = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const HAIKU_55_TIERS = [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]

describe("VS-40a: long-context tiers and effort", () => {
  test("with tiers and effort absent every estimate is HEAD's, and with tiers attached only `tiered` is added", () => {
    const plain = gridPlans((price) => price).map((plan) => estimateDispatch([plan]))
    expect(plain).toHaveLength(840)
    expect(digest(plain)).toBe("16756dd7fc95ae3614f2791951ba67273fa06166a11c8aed0a070be4944376d3")
    expect(digest([estimateDispatch(SMALL), estimateDispatch(SMALL.map((pass) => ({ ...pass, cached: true })))])).toBe(
      "ce537cbb6eb7767be99f60384d215e0c8fa626be69948bffd5d9ff605d874102",
    )
    expect(JSON.stringify(plain)).not.toContain("tiered")
    const attached = gridPlans(withTier).map((plan) => estimateDispatch([plan]))
    expect(untiered(attached)).toBe("16756dd7fc95ae3614f2791951ba67273fa06166a11c8aed0a070be4944376d3")
    expect(
      attached.every((estimate) => estimate.passes[0]?.tiered !== undefined && estimate.tiered !== undefined),
    ).toBe(true)
    // An empty list is no tier: nothing is added.
    expect(
      JSON.stringify(estimateDispatch(SMALL.map((pass) => ({ ...pass, price: { ...SONNET, tiers: [] } })))),
    ).not.toContain("tiered")
  })

  test("calibratedOutputPerStep is today's 1,800 without an effort, and a measured entry only for its model and effort", () => {
    const fit = { model: "anthropic/claude-haiku-5.5", effort: "high", tokens: 2_400, fitted: "2026-12-01", cases: 12 }
    expect(calibratedOutputPerStep()).toBe(CALIBRATED_OUTPUT_PER_STEP)
    expect(calibratedOutputPerStep("openrouter/anthropic/claude-haiku-5.5")).toBe(CALIBRATED_OUTPUT_PER_STEP)
    expect(calibratedOutputPerStep("openrouter/anthropic/claude-haiku-5.5", undefined, [fit])).toBe(
      CALIBRATED_OUTPUT_PER_STEP,
    )
    // The key is the model id within its provider, so a projection and a paid run find the same entry.
    expect(calibratedOutputPerStep("openrouter/anthropic/claude-haiku-5.5", "high", [fit])).toBe(fit)
    expect(calibratedOutputPerStep("vectorscope-projection/anthropic/claude-haiku-5.5", "high", [fit])).toBe(fit)
    expect(calibratedOutputPerStep("openrouter/anthropic/claude-haiku-5.5", "low", [fit])).toBe(
      CALIBRATED_OUTPUT_PER_STEP,
    )
    expect(calibratedOutputPerStep("openrouter/anthropic/claude-sonnet-4.5", "high", [fit])).toBe(
      CALIBRATED_OUTPUT_PER_STEP,
    )
    expect(calibratedOutputPerStep(undefined, "high", [fit])).toBe(CALIBRATED_OUTPUT_PER_STEP)
    // The table holds measured entries only: today none.
    for (const entry of OUTPUT_FITS) {
      expect(entry.fitted).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.cases).toBeGreaterThanOrEqual(1)
      expect(entry.tokens).toBeGreaterThan(0)
    }
    expect(OUTPUT_FITS).toEqual([])
    expect(CALIBRATED_OUTPUT_PER_STEP).toEqual({ tokens: 1_800, fitted: "2026-09-14", cases: 1 })
  })

  test("an effort with no measured entry leaves v2 at 1,800 a step: the estimate is the effort-free one plus the effort", () => {
    const plain = estimateDispatch(SMALL)
    const effort = estimateDispatch(SMALL.map((pass) => ({ ...pass, effort: "high" })))
    expect(effort.passes.map((estimate) => estimate.effort)).toEqual(["high", "high", "high"])
    expect({ ...effort, passes: effort.passes.map(({ effort: _effort, ...estimate }) => estimate) }).toEqual(plain)
    expect(plain.passes[0]).not.toHaveProperty("effort")
    // The shrink lever's re-estimate keeps the effort.
    expect(decideDispatch(effort, { maxInputTokens: 0, remainingUsd: 0.1, available: ["steps:review"] })).toEqual(
      decideDispatch(plain, { maxInputTokens: 0, remainingUsd: 0.1, available: ["steps:review"] }),
    )
  })

  // The dispatch's v2 names the fits it rests on, so its date stays true once OUTPUT_FITS gains an entry (I-5).
  test("a pass priced at a measured fit carries it, and the dispatch lists the fits its v2 rests on", () => {
    const fit = { model: "claude-sonnet-4-5", effort: "high", tokens: 2_400, fitted: "2026-12-01", cases: 12 }
    const plain = estimateDispatch(SMALL)
    const steps = plain.passes.map((estimate) => estimate.v2.outputTokens)
    // One pass at its measured fit: that pass carries the entry, the others none, and the dispatch lists it beside the
    // default's date, which the other passes rest on.
    const one = estimateDispatch(
      SMALL.map((pass) => (pass.pass === "review" ? { ...pass, effort: "high" } : pass)),
      [fit],
    )
    expect(one.passes[0]?.v2.fit).toBe(fit)
    expect(one.passes[0]?.v2.outputTokens).toEqual({
      low: (steps[0].low / 1_800) * 2_400,
      high: (steps[0].high / 1_800) * 2_400,
    })
    expect(priced(one.passes[0]?.v2.usd).high).toBeGreaterThan(priced(plain.passes[0]?.v2.usd).high)
    expect(one.passes[0]?.usd).toEqual(plain.passes[0]?.usd)
    expect(one.passes.slice(1)).toEqual(plain.passes.slice(1))
    expect(one.passes[1]?.v2).not.toHaveProperty("fit")
    expect(one.v2.fitted).toBe("2026-09-14")
    expect(one.v2.fits).toEqual([fit])
    expect(one.usd).toEqual(plain.usd)
    // Every pass at it: the default's date is left out, and the fit is listed once.
    const all = estimateDispatch(
      SMALL.map((pass) => ({ ...pass, effort: "high" })),
      [fit],
    )
    expect(all.passes.every((estimate) => estimate.v2.fit === fit)).toBe(true)
    expect(all.v2).not.toHaveProperty("fitted")
    expect(all.v2.fits).toHaveLength(1)
    expect(all.v2.fits?.[0]).toBe(fit)
    // A fit for another effort, or no passes, adds nothing: the default's date alone, as without a table.
    expect(
      estimateDispatch(
        SMALL.map((pass) => ({ ...pass, effort: "low" })),
        [fit],
      ).v2,
    ).toEqual(plain.v2)
    expect(plain.v2).not.toHaveProperty("fits")
    expect(plain.passes.every((estimate) => !("fit" in estimate.v2))).toBe(true)
    expect(estimateDispatch([], [fit]).v2).toEqual({ fitted: "2026-09-14", outputTokens: { low: 0, high: 0 } })
  })

  // A large Haiku 5.5 review: P 95,000 at the default 30 steps, cached. The low band's steps 4 and 5 pass 100,000
  // (L(4) = 101,000), the high band's steps 3 to 30.
  test("tiered figures sit beside the base-tier ones, which the gate keeps reading", () => {
    const plan: PassPlan = {
      pass: "review",
      model: "vectorscope-projection/anthropic/claude-haiku-5.5",
      promptTokens: 95_000,
      maxSteps: 30,
      price: HAIKU_55,
      cached: true,
    }
    const base = estimateDispatch([plan])
    const e = estimateDispatch([{ ...plan, price: { ...HAIKU_55, tiers: HAIKU_55_TIERS } }])
    const review = e.passes[0]
    expect(review.usd).toEqual(base.passes[0].usd)
    expect(review.v2.usd).toEqual(base.passes[0].v2.usd)
    expect(review.firstStepUsd).toBe(base.passes[0].firstStepUsd)
    expect(priced(review.usd).low).toBeCloseTo(0.0168, 12)
    expect(priced(review.usd).high).toBeCloseTo(0.468, 12)
    expect(priced(review.v2.usd).low).toBeCloseTo(0.021295, 12)
    expect(priced(review.v2.usd).high).toBeCloseTo(0.097165, 12)
    expect(review.tiered?.usd.low).toBeCloseTo(0.0324, 12)
    expect(review.tiered?.usd.high).toBeCloseTo(2.26, 12)
    expect(review.tiered?.v2.low).toBeCloseTo(0.038495, 12)
    expect(review.tiered?.v2.high).toBeCloseTo(0.425325, 12)
    // The gate reads the base-tier legacy low ($0.0168): a $0.02 remainder goes, as it does without tiers, although the
    // tiered low is over it.
    expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd: 0.02 })).toEqual({ go: true })
    expect(decideDispatch(base, { maxInputTokens: 0, remainingUsd: 0.02 })).toEqual({ go: true })
    for (const remainingUsd of [0, 0.01, 0.0168, 0.05])
      expect(decideDispatch(e, { maxInputTokens: 0, remainingUsd, available: [...SHRINK_ORDER] })).toEqual(
        decideDispatch(base, { maxInputTokens: 0, remainingUsd, available: [...SHRINK_ORDER] }),
      )
  })

  test("a tier listed but never reached changes nothing, bit for bit", () => {
    const tiers = [{ above: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }]
    for (const cached of [false, true]) {
      const e = estimateDispatch(SMALL.map((pass) => ({ ...pass, cached, price: { ...SONNET, tiers } })))
      for (const estimate of e.passes) {
        expect(estimate.tiered?.usd.low).toBe(priced(estimate.usd).low)
        expect(estimate.tiered?.usd.high).toBe(priced(estimate.usd).high)
        expect(estimate.tiered?.v2.low).toBe(priced(estimate.v2.usd).low)
        expect(estimate.tiered?.v2.high).toBe(priced(estimate.v2.usd).high)
      }
      expect(e.tiered).toEqual({ usd: priced(e.usd), v2: priced(e.v2.usd) })
    }
  })

  test("the dispatch's tiered range sums each priced pass's, or its base-tier one when its price lists no tier", () => {
    const review: PassPlan = {
      pass: "review",
      model: "vectorscope-projection/anthropic/claude-haiku-5.5",
      promptTokens: 95_000,
      maxSteps: 30,
      price: { ...HAIKU_55, tiers: HAIKU_55_TIERS },
    }
    const local: PassPlan = { pass: "security", model: "lmstudio/qwen", promptTokens: 9_000, maxSteps: 20 }
    const e = estimateDispatch([review, SMALL[2], local])
    const [first, second] = e.passes
    expect(second.tiered).toBeUndefined()
    expect(e.tiered?.usd.low).toBeCloseTo(priced(first.tiered?.usd).low + priced(second.usd).low, 12)
    expect(e.tiered?.usd.high).toBeCloseTo(priced(first.tiered?.usd).high + priced(second.usd).high, 12)
    expect(e.tiered?.v2.low).toBeCloseTo(priced(first.tiered?.v2).low + priced(second.v2.usd).low, 12)
    expect(e.tiered?.v2.high).toBeCloseTo(priced(first.tiered?.v2).high + priced(second.v2.usd).high, 12)
    expect(e.usd).toEqual(estimateDispatch([{ ...review, price: HAIKU_55 }, SMALL[2], local]).usd)
    expect(estimateDispatch([SMALL[2], local])).not.toHaveProperty("tiered")
  })

  test("a step count that is not a number is NaN or Infinity with tiers as without them, and never throws", () => {
    for (const maxSteps of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan: PassPlan = { ...SMALL[0], promptTokens: 95_000, maxSteps, price: HAIKU_55 }
      const base = estimateDispatch([plan])
      const e = estimateDispatch([{ ...plan, price: { ...HAIKU_55, tiers: HAIKU_55_TIERS } }])
      expect(untiered(e)).toBe(untiered(base))
      expect(e.passes[0]?.tiered?.usd.high).toBe(priced(base.passes[0]?.usd).high)
      expect(e.passes[0]?.tiered?.v2.high).toBe(priced(base.passes[0]?.v2.usd).high)
    }
    expect(estimateDispatch([{ ...SMALL[0], maxSteps: Number.POSITIVE_INFINITY }]).passes[0]?.usd?.high).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  // Item 4: T3-2's two levers (verify output or effort, a candidate cap) are offline projection sweeps only, so the
  // runtime order is VS-40's seven.
  test("adds no shrink lever", () => {
    expect([...SHRINK_ORDER]).toEqual([
      "lenses",
      "cards",
      "steps:verify",
      "steps:security",
      "steps:review",
      "dependents",
      "diff",
    ])
  })
})
