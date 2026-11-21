import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { parseUnifiedDiff, renderPatch } from "@vectordevai/core/review/diff"
import { cacheReadShare } from "@vectordevai/core/review/dispatch"
import { noteTriageUnchecked, noteVerifyUnfinished } from "@vectordevai/core/review/format"
import {
  bandCostUsd,
  combineCostKinds,
  contextRefusal,
  diffBudgetChars,
  estimateBands,
  estimateCostUsd,
  MAX_REVIEW_SESSIONS,
  MIN_CONTEXT,
  nextStepCostUsd,
  OUTPUT_PER_STEP,
  passInputTokens,
  planDepth,
  planReviewBatches,
  planIsolatedVerify,
  planSpecialists,
  priceAt,
  tierProblems,
  verifyCandidates,
  verifyUnanswered,
  verifyUnconfirmed,
  type BlindCandidate,
  type CacheReads,
  type DepthInput,
  type EstimateBand,
  type IsolatedVerifyInput,
  type PlannedVerifyCall,
  type ReviewPrice,
  type ReviewTier,
  type VerifyRule,
} from "@vectordevai/core/review/plan"
import { buildVerifyPrompt } from "@vectordevai/core/review/prompt"
import { orderByRiskDensity, RISK_BANDS } from "@vectordevai/core/review/risk"
import {
  REVIEW_LENSES,
  type FailureClass,
  type FailureMechanism,
  type Finding,
  type ReviewConfig,
  type Severity,
  type Trust,
} from "@vectordevai/core/review/types"

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

// VS-28c: the depth planner (contract §4 VS-28's depth table). Nothing calls it before VS-28 wiring.
describe("planDepth", () => {
  const PLAIN = [{ path: "src/list.ts" }]
  const SENSITIVE = [{ path: "src/list.ts" }, { path: "src/auth.ts" }]
  const SECURITY = ["auto", "always", "off"] as const
  const auto = (
    files: { path: string; oldPath?: string }[],
    security: ReviewConfig["security"],
    band: (typeof RISK_BANDS)[number],
    lenses?: ReviewConfig["lenses"],
  ) => planDepth({ depth: "auto", files, config: { security, ...(lenses ? { lenses } : {}) }, risk: { band } })

  test("fixed depth is exactly planSpecialists, with no lens and no limit (D3)", () => {
    for (const files of [PLAIN, SENSITIVE, [{ path: "src/renamed.ts", oldPath: "src/auth.ts" }]])
      for (const security of SECURITY) {
        const plan = planDepth({ depth: "fixed", files, config: { security } })
        const specialists = planSpecialists(files, { security })
        expect(plan).toEqual({
          requested: "fixed",
          effective: "fixed",
          specialists,
          lenses: [],
          sessions: specialists.length + 1,
          limited: [],
        })
      }
  })

  test("auto plans by band: low as planSpecialists under auto, medium adds security, high the lenses", () => {
    expect(auto(PLAIN, "auto", "low")).toEqual({
      requested: "auto",
      effective: "low",
      specialists: ["review"],
      lenses: [],
      sessions: 2,
      limited: [],
    })
    expect(auto(SENSITIVE, "auto", "low").specialists).toEqual(["review", "security"])
    expect(auto(PLAIN, "auto", "medium").specialists).toEqual(["review", "security"])
    expect(auto(PLAIN, "auto", "high")).toMatchObject({
      effective: "high",
      specialists: ["review", "security"],
      lenses: [],
    })
    expect(auto(PLAIN, "auto", "high", "high")).toEqual({
      requested: "auto",
      effective: "high",
      specialists: ["review", "security"],
      lenses: ["concurrency", "resource", "access", "data-integrity"],
      sessions: 7,
      limited: [],
    })
    // Lenses run on the high band only, and only under lenses: "high".
    for (const band of ["low", "medium"] as const) expect(auto(SENSITIVE, "auto", band, "high").lenses).toEqual([])
    expect(auto(PLAIN, "auto", "high", "off").lenses).toEqual([])
    // Fixed depth never runs a lens, whatever the band would be.
    expect(planDepth({ depth: "fixed", files: PLAIN, config: { security: "always" } }).lenses).toEqual([])
    // An automatic depth always has a band: riskOf needs only the files, so a missing one is a caller's bug, caught by
    // the type alone (planDepth has no runtime guard for it).
    // @ts-expect-error "auto" without a risk does not type-check.
    const unbanded: DepthInput = { depth: "auto", files: PLAIN, config: { security: "auto" } }
    void unbanded
  })

  test("security always adds security on every band", () => {
    for (const band of RISK_BANDS) expect(auto(PLAIN, "always", band).specialists).toEqual(["review", "security"])
  })

  // An explicit "off" wins over every band, and drops the access lens too (it looks for authentication and
  // authorization defects); the plan says so wherever the band would have added either.
  test("security off wins over every band, drops the access lens, and says so in limited", () => {
    expect(auto(PLAIN, "off", "low")).toMatchObject({ specialists: ["review"], limited: [] })
    expect(auto(SENSITIVE, "off", "low")).toMatchObject({ specialists: ["review"], limited: ["security-off"] })
    expect(auto(PLAIN, "off", "medium")).toMatchObject({ specialists: ["review"], limited: ["security-off"] })
    expect(auto(PLAIN, "off", "high", "high")).toEqual({
      requested: "auto",
      effective: "high",
      specialists: ["review"],
      lenses: ["concurrency", "resource", "data-integrity"],
      sessions: 5,
      limited: ["security-off"],
    })
  })

  test("auto never plans fewer passes than fixed, and never more sessions than the bound", () => {
    const sets = [PLAIN, SENSITIVE, [{ path: "test/auth.test.ts" }], []]
    for (const files of sets)
      for (const security of SECURITY)
        for (const band of RISK_BANDS)
          for (const lenses of [undefined, "off", "high"] as const) {
            const plan = auto(files, security, band, lenses)
            const fixed = planDepth({ depth: "fixed", files, config: { security } })
            for (const specialist of fixed.specialists) expect(plan.specialists).toContain(specialist)
            expect(plan.sessions).toBe(plan.specialists.length + plan.lenses.length + 1)
            // One session stays for VS-30's repro.
            expect(plan.sessions).toBeLessThanOrEqual(MAX_REVIEW_SESSIONS - 1)
            for (const lens of plan.lenses) expect(REVIEW_LENSES).toContain(lens)
            expect(plan.effective).toBe(band)
          }
    expect(MAX_REVIEW_SESSIONS).toBe(8)
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

  // VS-40 (addendum A): with none of its inputs, estimateCostUsd returns exactly what it returned before them. Each
  // number was printed by estimateCostUsd at 8f38f824, before VS-24c, and is compared bit for bit.
  test("with none of VS-40's inputs it returns today's numbers, bit for bit", () => {
    const sonnet = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const cases: [Parameters<typeof estimateCostUsd>[0], { low: number; high: number }][] = [
      [
        { promptTokens: 5_300, maxSteps: 30, price: sonnet },
        { low: 0.12725999999999998, high: 5.9670000000000005 },
      ],
      [
        { promptTokens: 5_300, maxSteps: 20, price: sonnet },
        { low: 0.12725999999999998, high: 2.778 },
      ],
      [
        { promptTokens: 3_000, maxSteps: 10, price: sonnet },
        { low: 0.11760000000000001, high: 0.72 },
      ],
      [
        { promptTokens: 5_300, maxSteps: 30, price: { input: 3, output: 15 } },
        { low: 0.1845, high: 5.9670000000000005 },
      ],
      [
        { promptTokens: 1_234.5, maxSteps: 7.9, price: { input: 1.1, output: 4.4, cacheRead: 0.11 } },
        { low: 0.03710113, high: 0.12038565000000001 },
      ],
      [
        { promptTokens: 80_000, maxSteps: 0, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
        { low: 1.2449999999999999, high: 1.2449999999999999 },
      ],
      [
        { promptTokens: 10_000, maxSteps: 30, price },
        { low: 0.147, high: 6.390000000000001 },
      ],
    ]
    for (const [input, today] of cases) {
      const now = estimateCostUsd(input)
      expect(now.low).toBe(today.low)
      expect(now.high).toBe(today.high)
    }
    expect(estimateCostUsd({ promptTokens: Number.NaN, maxSteps: 30, price: sonnet })).toEqual({
      low: Number.NaN,
      high: Number.NaN,
    })
    expect(OUTPUT_PER_STEP).toBe(600)
  })

  test("its bands are today's: low 5 steps (or fewer) at R 2,000, high maxSteps at R 4,000", () => {
    expect(estimateBands(30)).toEqual({ low: { steps: 5, growth: 2_000 }, high: { steps: 30, growth: 4_000 } })
    expect(estimateBands(3)).toEqual({ low: { steps: 3, growth: 2_000 }, high: { steps: 3, growth: 4_000 } })
    expect(estimateBands(0)).toEqual({ low: { steps: 1, growth: 2_000 }, high: { steps: 1, growth: 4_000 } })
    expect(estimateBands(7.9).high.steps).toBe(7)
    // S·P + R·S(S−1)/2: 5·5,300 + 2,000·10 and 30·5,300 + 4,000·435.
    expect(passInputTokens(5_300, estimateBands(30).low)).toBe(46_500)
    expect(passInputTokens(5_300, estimateBands(30).high)).toBe(1_899_000)
    expect(passInputTokens(9, { steps: 1, growth: 4_000 })).toBe(9)
  })

  test("VS-40's inputs each move the estimate as hand-computed", () => {
    const at = (extra: Partial<Parameters<typeof estimateCostUsd>[0]>, over: ReviewPrice = price) =>
      estimateCostUsd({ promptTokens: 10_000, maxSteps: 30, price: over, ...extra })
    // Output at 1,800 tokens a step: 5 and 30 steps of 1,200 more tokens at $15.
    expect(at({ outputPerStep: 1_800 }).low).toBeCloseTo(0.147 + 5 * 1_200 * 15e-6, 12)
    expect(at({ outputPerStep: 1_800 }).high).toBeCloseTo(6.39 + 30 * 1_200 * 15e-6, 12)
    // The uncached input at $6: low 30k (10k + 20k growth), high 2.04M.
    expect(at({ writePrice: 6 }).low).toBeCloseTo(0.147 + 30_000 * 3e-6, 12)
    expect(at({ writePrice: 6 }).high).toBeCloseTo(6.39 + 2_040_000 * 3e-6, 12)
    // Half of each band's input from the cache: low 70k, high 2.04M.
    const half = at({ cacheReadShare: { low: 0.5, high: 0.5 } })
    expect(half.low).toBeCloseTo(35_000 * 3e-6 + 35_000 * 0.3e-6 + 3_000 * 15e-6, 12)
    expect(half.high).toBeCloseTo(1_020_000 * 3e-6 + 1_020_000 * 0.3e-6 + 18_000 * 15e-6, 12)
    // A share outside 0..1 is clamped, and one that is not a number reads as no cache read.
    expect(at({ cacheReadShare: { low: 2, high: -1 } })).toEqual({
      low: 70_000 * 0.3e-6 + 3_000 * 15e-6,
      high: 2_040_000 * 3e-6 + 18_000 * 15e-6,
    })
    expect(at({ cacheReadShare: { low: Number.NaN, high: Number.NaN } }).low).toBeCloseTo(
      70_000 * 3e-6 + 3_000 * 15e-6,
      12,
    )
    // Without a cache-read price the share is ignored, so the result is the legacy one.
    const uncached = { input: 3, output: 15 }
    expect(at({ cacheReadShare: { low: 0.9, high: 0.9 } }, uncached)).toEqual(at({}, uncached))
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

describe("the verify policy", () => {
  type Item = Pick<Finding, "id" | "severity" | "confidence" | "suggestion"> & { title: string }
  const SEVERITY: Severity[] = ["blocking", "concern", "nit"]
  // Every severity, a confidence on each side of 0.7, with and without a suggestion; then two findings that share an
  // id with earlier ones, as the review and security passes can report the same defect.
  const findings: Item[] = [
    ...SEVERITY.flatMap((severity) =>
      [0.5, 0.9].flatMap((confidence) =>
        [undefined, "  return items[items.length - 1]"].map((suggestion) => ({
          id: `${severity}-${confidence}-${suggestion ? "fix" : "plain"}`,
          title: "first",
          severity,
          confidence,
          ...(suggestion ? { suggestion } : {}),
        })),
      ),
    ),
    { id: "blocking-0.9-plain", title: "again", severity: "blocking", confidence: 0.95 },
    { id: "nit-0.5-fix", title: "again", severity: "nit", confidence: 0.6, suggestion: "  return 0" },
  ]
  const VERIFY: ReviewConfig["verify"][] = ["blocking", "all", "off"]
  const TRUST: Trust[] = ["trusted", "untrusted"]
  const rules = (policy: VerifyRule["policy"]): VerifyRule[] =>
    VERIFY.flatMap((verify) =>
      TRUST.flatMap((trust) =>
        [false, true].map((triaged) => ({ verify, policy, minConfidence: 0.7, trust, triaged })),
      ),
    )
  const ids = (items: readonly Item[]) => items.map((item) => item.id)

  // The candidate rules as engine review/run.ts and the desktop's ai-review.ts wrote them before the policy, copied
  // unchanged. With the opt-in off, each surface must pick exactly what it picked then (D3).
  function engineBefore(normalized: Item[], rule: VerifyRule) {
    const config = { verify: rule.verify, minConfidence: rule.minConfidence }
    const triaged = rule.triaged
    const all = config.verify === "all" || triaged
    return [
      ...new Map(
        (config.verify === "off" && !triaged ? [] : normalized)
          .filter((finding) =>
            all
              ? finding.severity !== "nit" && finding.confidence >= config.minConfidence
              : (finding.severity === "blocking" && finding.confidence >= config.minConfidence) ||
                (rule.trust === "untrusted" && finding.suggestion !== undefined),
          )
          .map((finding) => [finding.id, finding]),
      ).values(),
    ]
  }
  function desktopBefore(proposed: Item[], rule: VerifyRule) {
    const config = { verify: rule.verify, minConfidence: rule.minConfidence }
    const triage = rule.triaged
    return config.verify === "off" && !triage
      ? []
      : proposed.filter(
          (finding) =>
            (finding.severity !== "nit" && finding.confidence >= config.minConfidence) ||
            (rule.trust === "untrusted" && finding.suggestion !== undefined),
        )
  }

  test("with the opt-in off, each surface picks exactly the findings it picked before the policy", () => {
    for (const policy of ["legacy", undefined] as const)
      for (const rule of rules(policy)) {
        const engine = verifyCandidates(findings, rule, "engine")
        const desktop = verifyCandidates(findings, rule, "desktop")
        expect(engine).toEqual(engineBefore(findings, rule))
        expect(engine.every((item, index) => item === engineBefore(findings, rule)[index])).toBe(true)
        expect(desktop).toEqual(desktopBefore(findings, rule))
        expect(desktop.every((item, index) => item === desktopBefore(findings, rule)[index])).toBe(true)
      }
  })

  test("with the opt-in off, a triage pass leaves out the same unconfirmed findings as before", () => {
    const verdictSets: Map<string, "confirmed" | "rejected">[] = [
      new Map(),
      new Map(findings.map((item) => [item.id, "confirmed"] as const)),
      new Map(findings.map((item, index) => [item.id, index % 2 ? "confirmed" : "rejected"] as const)),
      new Map(findings.filter((item) => item.severity === "blocking").map((item) => [item.id, "confirmed"] as const)),
    ]
    for (const rule of rules("legacy"))
      for (const verdicts of verdictSets) {
        const engine = verifyCandidates(findings, rule, "engine")
        const desktop = verifyCandidates(findings, rule, "desktop")
        expect(ids(verifyUnconfirmed(engine, verdicts, rule.triaged))).toEqual(
          ids(rule.triaged ? engine.filter((item) => verdicts.get(item.id) !== "confirmed") : []),
        )
        expect(ids(verifyUnconfirmed(desktop, verdicts, rule.triaged))).toEqual(
          ids(
            rule.triaged
              ? desktop.filter((item) => item.severity !== "nit" && verdicts.get(item.id) !== "confirmed")
              : [],
          ),
        )
      }
  })

  test("shared: blocking, all and off, with every untrusted suggestion and one candidate per id", () => {
    const pick = (verify: ReviewConfig["verify"], trust: Trust, triaged = false) =>
      ids(verifyCandidates(findings, { verify, policy: "shared", minConfidence: 0.7, trust, triaged }, "engine"))
    expect(pick("blocking", "trusted")).toEqual(["blocking-0.9-plain", "blocking-0.9-fix"])
    expect(pick("all", "trusted")).toEqual([
      "blocking-0.9-plain",
      "blocking-0.9-fix",
      "concern-0.9-plain",
      "concern-0.9-fix",
    ])
    expect(pick("off", "trusted")).toEqual([])
    // Untrusted: every suggestion too, whatever its severity or confidence, since its fix needs the verified mark.
    expect(pick("blocking", "untrusted")).toEqual([
      "blocking-0.5-fix",
      "blocking-0.9-plain",
      "blocking-0.9-fix",
      "concern-0.5-fix",
      "concern-0.9-fix",
      "nit-0.5-fix",
      "nit-0.9-fix",
    ])
    expect(pick("all", "untrusted")).toEqual([
      "blocking-0.5-fix",
      "blocking-0.9-plain",
      "blocking-0.9-fix",
      "concern-0.5-fix",
      "concern-0.9-plain",
      "concern-0.9-fix",
      "nit-0.5-fix",
      "nit-0.9-fix",
    ])
    // "off" is an explicit choice and wins, except after a triage pass, which reads it as "all".
    expect(pick("off", "untrusted")).toEqual([])
    expect(pick("off", "untrusted", true)).toEqual(pick("all", "untrusted"))
    expect(pick("blocking", "trusted", true)).toEqual(pick("all", "trusted"))
    // A shared id is one candidate, at its first place, carrying the later finding, as the engine always sent it.
    const merged = verifyCandidates(
      findings,
      { verify: "all", policy: "shared", minConfidence: 0.7, trust: "trusted", triaged: false },
      "engine",
    )
    expect(merged[0]).toMatchObject({ id: "blocking-0.9-plain", title: "again" })
  })

  test("shared: both surfaces pick the same findings", () => {
    for (const rule of rules("shared"))
      expect(verifyCandidates(findings, rule, "desktop")).toEqual(verifyCandidates(findings, rule, "engine"))
  })

  test("shared is never laxer than the engine's rule, and changes the desktop's only for an explicit blocking", () => {
    for (const rule of rules("shared")) {
      const shared = ids(verifyCandidates(findings, rule, "engine"))
      const engine = ids(verifyCandidates(findings, { ...rule, policy: "legacy" }, "engine"))
      const desktop = ids(verifyCandidates(findings, { ...rule, policy: "legacy" }, "desktop"))
      for (const id of engine) expect(shared).toContain(id)
      if (rule.verify !== "blocking" || rule.triaged) expect(shared).toEqual([...new Set(desktop)])
      else expect(shared.length).toBeLessThan(new Set(desktop).size)
    }
  })

  test("after a triage pass only confirmed findings above a nit are kept; otherwise a missing verdict leaves out nothing", () => {
    const rule: VerifyRule = { verify: "all", policy: "shared", minConfidence: 0.7, trust: "untrusted", triaged: true }
    const candidates = verifyCandidates(findings, rule, "engine")
    const verdicts = new Map<string, "confirmed" | "rejected">([
      ["blocking-0.9-plain", "confirmed"],
      ["concern-0.9-plain", "rejected"],
    ])
    expect(ids(verifyUnconfirmed(candidates, verdicts, true))).toEqual([
      "blocking-0.5-fix",
      "blocking-0.9-fix",
      "concern-0.5-fix",
      "concern-0.9-plain",
      "concern-0.9-fix",
    ])
    expect(verifyUnconfirmed(candidates, verdicts, false)).toEqual([])
    expect(ids(verifyUnanswered(candidates, verdicts))).toEqual([
      "blocking-0.5-fix",
      "blocking-0.9-fix",
      "concern-0.5-fix",
      "concern-0.9-fix",
      "nit-0.5-fix",
      "nit-0.9-fix",
    ])
    // After the triage pass the unanswered ones above a nit are left out (verifyUnconfirmed), so only the untrusted
    // nits' suggestions are posted without a verdict. Together they are every candidate without one.
    expect(ids(verifyUnanswered(candidates, verdicts, true))).toEqual(["nit-0.5-fix", "nit-0.9-fix"])
    const leftOut = verifyUnconfirmed(candidates, verdicts, true).filter((item) => !verdicts.has(item.id))
    expect([...ids(leftOut), ...ids(verifyUnanswered(candidates, verdicts, true))].toSorted()).toEqual(
      ids(verifyUnanswered(candidates, verdicts)).toSorted(),
    )
    // A pass that answered for every candidate leaves nothing unanswered.
    const answered = new Map(candidates.map((item) => [item.id, "confirmed"] as const))
    expect(verifyUnanswered(candidates, answered)).toEqual([])
    expect(verifyUnanswered(candidates, answered, true)).toEqual([])
  })

  test("a verify pass that left findings without a verdict says how many were not re-checked, and why", () => {
    expect(noteVerifyUnfinished(1, "budget")).toBe(
      "1 finding was not re-checked: too little of the review's budget was left for the verify pass.",
    )
    expect(noteVerifyUnfinished(3, "time")).toBe(
      "3 findings were not re-checked: too little time was left for the verify pass.",
    )
    expect(noteVerifyUnfinished(2, "unfinished")).toBe(
      "2 findings were not re-checked: the verify pass did not finish.",
    )
    // It finished, but gave no verdict for them.
    expect(noteVerifyUnfinished(1, "unanswered")).toBe(
      "1 finding was not re-checked: the verify pass gave no verdict for it.",
    )
    expect(noteVerifyUnfinished(2, "unanswered")).toBe(
      "2 findings were not re-checked: the verify pass gave no verdict for them.",
    )
  })

  test("after a triage pass, the note for findings left out keeps its words and adds one for a pass that finished", () => {
    // The wording both surfaces have always used for a double-check that did not finish (D3).
    expect(noteTriageUnchecked(2, "a/cheap", "b/strong")).toBe(
      "The double-check on b/strong did not finish, so 2 findings from the cheaper first pass on a/cheap were left out: with a triage model, only findings the review model confirmed are reported.",
    )
    expect(noteTriageUnchecked(1, "a/cheap", "b/strong", "unfinished")).toBe(
      "The double-check on b/strong did not finish, so 1 finding from the cheaper first pass on a/cheap was left out: with a triage model, only findings the review model confirmed are reported.",
    )
    // The shared policy: it finished without a verdict for them.
    expect(noteTriageUnchecked(1, "a/cheap", "b/strong", "unanswered")).toBe(
      "The double-check on b/strong gave no verdict for 1 finding from the cheaper first pass on a/cheap, so it was left out: with a triage model, only findings the review model confirmed are reported.",
    )
    expect(noteTriageUnchecked(3, "a/cheap", "b/strong", "unanswered")).toBe(
      "The double-check on b/strong gave no verdict for 3 findings from the cheaper first pass on a/cheap, so they were left out: with a triage model, only findings the review model confirmed are reported.",
    )
  })
})

// VS-40a (addendum B §1.3): long-context tiers. The grid's digests were printed by estimateCostUsd and nextStepCostUsd
// at HEAD bfd8bdd6, before VS-40a, and are compared over every cell: with tiers absent and with tiers attached, which
// neither function reads.
const HAIKU_55 = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const HAIKU_55_TIER = { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
const GPT_55 = { input: 5, output: 30, cacheRead: 0.5 }
const GPT_55_TIER = { above: 272_000, input: 10, output: 45, cacheRead: 1 }
const GRID_PROMPTS = [0, 1, 1_234.5, 5_300, 52_000, 95_000, 190_000, 248_000]
const GRID_STEPS = [0, 1, 5, 7.9, 10, 20, 30]
const GRID_PRICES: ReviewPrice[] = [
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { input: 3, output: 15 },
  HAIKU_55,
  GPT_55,
  { input: 1.1, output: 4.4, cacheRead: 0.11 },
]
const GRID_CONTEXTS = [0, 3_000, 100_000, 100_001, 272_001]
const GRID_CACHED = [0, 2_000, 1e9]
// A tier above 100,000 at five times each grid price, which the grid's prompts pass.
const tiered = (price: ReviewPrice): ReviewPrice => ({
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

describe("long-context tiers (VS-40a)", () => {
  test("priceAt follows Session.costAt's rule: the highest threshold strictly passed, the first listed among equal ones", () => {
    const haiku = { ...HAIKU_55, tiers: [HAIKU_55_TIER] }
    expect(priceAt(haiku, 0)).toBe(haiku)
    expect(priceAt(haiku, 100_000)).toBe(haiku)
    expect(priceAt(haiku, 100_001)).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 })
    expect(priceAt(haiku, 100_001)).not.toHaveProperty("tiers")
    expect(priceAt(haiku, Number.NaN)).toBe(haiku)
    expect(priceAt(HAIKU_55, 1e9)).toBe(HAIKU_55)
    // An unordered list is read as the engine reads it: the highest threshold passed wins, wherever it is listed.
    const unordered = {
      input: 1,
      output: 2,
      tiers: [
        { above: 272_000, input: 4, output: 8 },
        { above: 128_000, input: 2, output: 4 },
      ],
    }
    expect(priceAt(unordered, 128_000)).toBe(unordered)
    expect(priceAt(unordered, 200_000)).toEqual({ input: 2, output: 4 })
    expect(priceAt(unordered, 300_000)).toEqual({ input: 4, output: 8 })
    // Equal thresholds: the first listed, as the engine's stable sort leaves it.
    const repeated = {
      input: 1,
      output: 2,
      tiers: [
        { above: 200_000, input: 3, output: 6 },
        { above: 200_000, input: 5, output: 10 },
      ],
    }
    expect(priceAt(repeated, 200_001)).toEqual({ input: 3, output: 6 })
    // A tier carries its own cache rates: the base ones are not inherited.
    expect(priceAt({ ...HAIKU_55, tiers: [{ above: 10, input: 1, output: 2 }] }, 11)).toEqual({ input: 1, output: 2 })
  })

  // notes-tokenomics.md §6.3, the lane's own model: the large Haiku review pass, P 52,000 and R 3,000 over 20 steps at
  // 1,500 output tokens a step, cached under v2's rule. Steps 18 to 20 pass 100,000.
  test("the Haiku 5.5 example: 3 of 20 steps over 100K cost $0.0695 against $0.0436, and 100,000 itself is base-tier", () => {
    const at = (price: ReviewPrice) =>
      bandCostUsd({
        promptTokens: 52_000,
        band: { steps: 20, growth: 3_000 },
        price,
        reads: "prefix",
        write: "cache-write",
        outputPerStep: 1_500,
      })
    const withTier = at({ ...HAIKU_55, tiers: [HAIKU_55_TIER] })
    const base = at(HAIKU_55)
    expect(withTier).toBeCloseTo(0.069495, 12)
    expect(base).toBeCloseTo(0.043635, 12)
    expect(withTier.toFixed(4)).toBe("0.0695")
    expect(base.toFixed(4)).toBe("0.0436")
    // L(17) = 52,000 + 16 · 3,000 = 100,000 is not over 100,000. One token lower and step 17 is tiered too.
    expect(at({ ...HAIKU_55, tiers: [{ ...HAIKU_55_TIER, above: 99_999 }] })).toBeCloseTo(0.077875, 12)
  })

  // Q40 (caching-off on gpt-5.6 and later) may change whether these routes read the cache at all; the rates here are
  // the committed catalog's for openai/gpt-5.5 at 255cfd83.
  test("the OpenAI 272K tier: double input and 1.5x output above 272,000, with no cache-write rate of its own", () => {
    const gpt = { ...GPT_55, tiers: [GPT_55_TIER] }
    expect(priceAt(gpt, 272_000)).toBe(gpt)
    expect(priceAt(gpt, 272_001)).toEqual({ input: 10, output: 45, cacheRead: 1 })
    const at = (price: ReviewPrice, reads: CacheReads, write: "input" | "cache-write", outputPerStep: number) =>
      bandCostUsd({ promptTokens: 248_000, band: { steps: 10, growth: 4_000 }, price, reads, write, outputPerStep })
    // L(7) = 272,000 is base-tier; steps 8 to 10 are tiered.
    expect(at(gpt, "none", "input", 600)).toBeCloseTo(17.707, 10)
    expect(at(GPT_55, "none", "input", 600)).toBeCloseTo(13.48, 10)
    // Under caching each step writes at the cache-write rate, else its input rate: neither the tier nor the base lists
    // one, so the tier's steps write at $10.
    expect(at(gpt, "prefix", "cache-write", 1_800)).toBeCloseTo(3.703, 10)
    expect(at(GPT_55, "prefix", "cache-write", 1_800)).toBeCloseTo(3.148, 10)
  })

  test("with no tier passed, bandCostUsd is estimateCostUsd's closed form for the same band and reads", () => {
    for (const price of GRID_PRICES)
      for (const promptTokens of GRID_PROMPTS)
        for (const maxSteps of GRID_STEPS) {
          const bands = estimateBands(maxSteps)
          const band = (
            range: EstimateBand,
            reads: CacheReads,
            write: "input" | "cache-write",
            outputPerStep: number,
          ) => bandCostUsd({ promptTokens, band: range, price, reads, write, outputPerStep })
          const legacy = estimateCostUsd({ promptTokens, maxSteps, price })
          expect(band(bands.low, "prompt", "input", OUTPUT_PER_STEP)).toBeCloseTo(legacy.low, 10)
          expect(band(bands.high, "none", "input", OUTPUT_PER_STEP)).toBeCloseTo(legacy.high, 10)
          const share = { low: cacheReadShare(promptTokens, bands.low), high: cacheReadShare(promptTokens, bands.high) }
          const cached = estimateCostUsd({
            promptTokens,
            maxSteps,
            price,
            cacheReadShare: share,
            writePrice: price.cacheWrite ?? price.input,
            outputPerStep: 1_800,
          })
          expect(band(bands.low, "prefix", "cache-write", 1_800)).toBeCloseTo(cached.low, 10)
          expect(band(bands.high, "prefix", "cache-write", 1_800)).toBeCloseTo(cached.high, 10)
          const uncached = estimateCostUsd({
            promptTokens,
            maxSteps,
            price,
            cacheReadShare: { low: 0, high: 0 },
            outputPerStep: 1_800,
          })
          expect(band(bands.low, "none", "input", 1_800)).toBeCloseTo(uncached.low, 10)
          expect(band(bands.high, "none", "input", 1_800)).toBeCloseTo(uncached.high, 10)
        }
    // A band that is not a whole number of steps of at least 1, that shrinks, or whose last prompt is not finite gives
    // NaN, never a loop or a free band.
    const of = (band: EstimateBand, promptTokens = 5_300) =>
      bandCostUsd({ promptTokens, band, price: tiered(HAIKU_55), reads: "none", write: "input", outputPerStep: 600 })
    for (const steps of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5])
      expect(of({ steps, growth: 2_000 })).toBeNaN()
    expect(of({ steps: 5, growth: -1 })).toBeNaN()
    expect(of({ steps: 5, growth: 2_000 }, Number.POSITIVE_INFINITY)).toBeNaN()
    // A billion steps is summed in closed form, a few runs long.
    expect(Number.isFinite(of({ steps: 1e9, growth: 4_000 }))).toBe(true)
  })

  test("estimateCostUsd and nextStepCostUsd never read tiers: HEAD's figures, bit for bit, with tiers attached", () => {
    const estimates = (attach: (price: ReviewPrice) => ReviewPrice) =>
      GRID_PRICES.flatMap((price) =>
        GRID_PROMPTS.flatMap((promptTokens) =>
          GRID_STEPS.map((maxSteps) => estimateCostUsd({ promptTokens, maxSteps, price: attach(price) })),
        ),
      )
    const nextSteps = (attach: (price: ReviewPrice) => ReviewPrice) =>
      GRID_PRICES.flatMap((price) =>
        GRID_CONTEXTS.flatMap((context) =>
          GRID_CACHED.map((cached) => nextStepCostUsd(context, attach(price), cached)),
        ),
      )
    const plain = (price: ReviewPrice) => price
    expect(estimates(plain)).toHaveLength(280)
    expect(digest(estimates(plain))).toBe("25301ac8762b81f606a62ca5d8532cd166b96942bedf4745c8f328f6cf6f1da0")
    expect(digest(estimates(tiered))).toBe("25301ac8762b81f606a62ca5d8532cd166b96942bedf4745c8f328f6cf6f1da0")
    expect(nextSteps(plain)).toHaveLength(75)
    expect(digest(nextSteps(plain))).toBe("7551fe787e121177e25305cb617e5e773beba1b40a2f29178ac0fde6c02d9449")
    expect(digest(nextSteps(tiered))).toBe("7551fe787e121177e25305cb617e5e773beba1b40a2f29178ac0fde6c02d9449")
    // The pin cases above, with a tier their prompts and growth pass.
    const sonnet = tiered({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(estimateCostUsd({ promptTokens: 5_300, maxSteps: 30, price: sonnet })).toEqual({
      low: 0.12725999999999998,
      high: 5.9670000000000005,
    })
    expect(
      estimateCostUsd({ promptTokens: 10_000, maxSteps: 30, price: tiered({ input: 3, output: 15, cacheRead: 0.3 }) }),
    ).toEqual({ low: 0.147, high: 6.390000000000001 })
    expect(
      estimateCostUsd({
        promptTokens: 80_000,
        maxSteps: 0,
        price: tiered({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
      }),
    ).toEqual({ low: 1.2449999999999999, high: 1.2449999999999999 })
    expect(nextStepCostUsd(272_001, tiered(GPT_55), 2_000)).toBe(nextStepCostUsd(272_001, GPT_55, 2_000))
    expect(OUTPUT_PER_STEP).toBe(600)
  })

  test("tierProblems refuses an unordered list, a repeated threshold, a threshold or rate that is not a number, and an unpriced tier", () => {
    const tier = (above: number, extra: Partial<ReviewTier> = {}): ReviewTier => ({
      above,
      input: 1,
      output: 2,
      ...extra,
    })
    expect(tierProblems([])).toEqual([])
    expect(tierProblems([HAIKU_55_TIER])).toEqual([])
    expect(tierProblems([tier(100_000), tier(272_000)])).toEqual([])
    expect(tierProblems([tier(272_000), tier(100_000)])).toEqual([
      "tier 2's threshold, 100000, is below the one before it, 272000: tiers are listed in rising order",
    ])
    expect(tierProblems([tier(200_000), tier(200_000)])).toEqual(["tier 2 repeats the threshold before it, 200000"])
    for (const above of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(tierProblems([tier(above)])).toEqual([`tier 1's threshold, ${above}, is not a number of tokens above 0`])
    expect(tierProblems([tier(100_000, { cacheRead: -0.1 })])).toEqual([
      "tier 1's cache read rate, -0.1, is not a number of 0 or more",
    ])
    expect(tierProblems([tier(100_000, { output: Number.NaN })])).toEqual([
      "tier 1's output rate, NaN, is not a number of 0 or more",
    ])
    expect(tierProblems([tier(100_000, { input: 0, output: 0 })])).toEqual([
      "tier 1 has no input or output rate above 0",
    ])
    // A cache-only tier is still unpriced; a zero cache rate is a rate.
    expect(tierProblems([tier(100_000, { input: 0, output: 0, cacheRead: 1 })])).toHaveLength(1)
    expect(tierProblems([tier(100_000, { cacheRead: 0, cacheWrite: 0 })])).toEqual([])
  })
})

// VS-44c (addendum B §1.10). No runner calls the planner before runner-wiring R3, so these cases are its whole contract.
describe("isolated verification planner (VS-44c)", () => {
  const SONNET = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  const SMALL = { input: 1.1, output: 4.4 }
  const blind = (
    id: string,
    path: string,
    line: number,
    severity: Severity,
    failure?: FailureClass,
  ): BlindCandidate => ({
    id,
    path,
    line,
    side: "RIGHT",
    severity,
    ...(failure
      ? { failure: { class: failure, mechanism: "logic", trigger: "an empty list", impact: "the request fails" } }
      : {}),
  })
  const entry = <C extends BlindCandidate>(
    candidate: C,
    promptTokens = 2_000,
    price: ReviewPrice = SONNET,
    maxSteps = 10,
  ): IsolatedVerifyInput<C> => ({ candidate, promptTokens, maxSteps, price })
  // The batched call's token count, with every argument it was given.
  const counter = () => {
    const seen: (readonly BlindCandidate[])[] = []
    return {
      seen,
      batched: {
        promptTokens: (rest: readonly BlindCandidate[]) => {
          seen.push(rest)
          return 1_000 + 400 * rest.length
        },
        maxSteps: 10,
        price: SONNET,
      },
    }
  }
  const shape = (plan: readonly PlannedVerifyCall[]) =>
    plan.map((call) => ({ kind: call.kind, ids: call.candidates.map((candidate) => candidate.id) }))
  const covered = (plan: readonly PlannedVerifyCall[]) =>
    plan.flatMap((call) => call.positions).toSorted((a, b) => a - b)

  // Every blocking class, an unclassed and an unknown class, and a concern and a nit that would sort first if
  // severity were not the first key.
  const mixed = [
    blind("leak-b5", "b.ts", 5, "blocking", "leak"),
    blind("concern-a1", "a.ts", 1, "concern", "crash"),
    blind("crash-z1", "z.ts", 1, "blocking", "crash"),
    blind("plain-a1", "a.ts", 1, "blocking"),
    blind("auth-y1", "y.ts", 1, "blocking", "auth-bypass"),
    blind("crash-a9", "a.ts", 9, "blocking", "crash"),
    blind("nit-a1", "a.ts", 1, "nit", "crash"),
    blind("meltdown-a1", "a.ts", 1, "blocking", "meltdown" as string as FailureClass),
    blind("crash-a2", "a.ts", 2, "blocking", "crash"),
  ]

  test("isolates the top k blocking candidates by class, path, line and id, and batches the rest in the order given", () => {
    const count = counter()
    const plan = planIsolatedVerify(
      mixed.map((candidate) => entry(candidate)),
      { batched: count.batched },
    )
    expect(shape(plan)).toEqual([
      { kind: "isolated", ids: ["crash-a2"] },
      { kind: "isolated", ids: ["crash-a9"] },
      { kind: "isolated", ids: ["crash-z1"] },
      { kind: "batched", ids: ["leak-b5", "concern-a1", "plain-a1", "auth-y1", "nit-a1", "meltdown-a1"] },
    ])
    expect(plan.map((call) => call.positions)).toEqual([[8], [5], [2], [0, 1, 3, 4, 6, 7]])
    expect(covered(plan)).toEqual(mixed.map((_, index) => index))
    expect(count.seen.map((rest) => rest.map((candidate) => candidate.id))).toEqual([
      ["leak-b5", "concern-a1", "plain-a1", "auth-y1", "nit-a1", "meltdown-a1"],
    ])
    // The whole order: the classes in FAILURE_CLASSES order, then an unknown class with the unclassed (by path, line,
    // then id), and never a concern or a nit.
    expect(
      planIsolatedVerify(
        mixed.map((candidate) => entry(candidate)),
        { k: 7, batched: count.batched },
      ).flatMap((call) => (call.kind === "isolated" ? call.candidates.map((candidate) => candidate.id) : [])),
    ).toEqual(["crash-a2", "crash-a9", "crash-z1", "leak-b5", "auth-y1", "meltdown-a1", "plain-a1"])
    // A known class with a mechanism the enum does not name is no failure either, as decodeFailure reads it, so it
    // ranks with the unclassed.
    const odd: BlindCandidate = {
      ...blind("odd-mechanism", "a.ts", 1, "blocking"),
      failure: {
        class: "crash",
        mechanism: "telepathy" as string as FailureMechanism,
        trigger: "an empty list",
        impact: "the request fails",
      },
    }
    expect(
      shape(
        planIsolatedVerify([entry(odd), entry(blind("leak-z1", "z.ts", 1, "blocking", "leak"))], {
          k: 1,
          batched: counter().batched,
        }),
      ),
    ).toEqual([
      { kind: "isolated", ids: ["leak-z1"] },
      { kind: "batched", ids: ["odd-mechanism"] },
    ])
    // The order given does not move the isolated calls; the batched call follows it.
    const reversed = planIsolatedVerify(
      mixed.toReversed().map((candidate) => entry(candidate)),
      { batched: count.batched },
    )
    expect(shape(reversed)).toEqual([
      { kind: "isolated", ids: ["crash-a2"] },
      { kind: "isolated", ids: ["crash-a9"] },
      { kind: "isolated", ids: ["crash-z1"] },
      { kind: "batched", ids: ["meltdown-a1", "nit-a1", "auth-y1", "plain-a1", "concern-a1", "leak-b5"] },
    ])
    expect(covered(reversed)).toEqual(mixed.map((_, index) => index))
  })

  test("compares paths by code unit, then lines, then ids, and keeps the order given for a full tie", () => {
    const isolatedIds = (candidates: BlindCandidate[], k: number) =>
      planIsolatedVerify(
        candidates.map((candidate) => entry(candidate)),
        { k, batched: counter().batched },
      ).flatMap((call) => (call.kind === "isolated" ? call.candidates.map((candidate) => candidate.id) : []))
    // By code unit "B.ts" sorts before "a.ts"; localeCompare would put "a.ts" first.
    expect("B.ts" < "a.ts").toBe(true)
    expect(
      isolatedIds([blind("lower", "a.ts", 1, "blocking", "crash"), blind("upper", "B.ts", 1, "blocking", "crash")], 1),
    ).toEqual(["upper"])
    expect(
      isolatedIds([blind("later", "a.ts", 30, "blocking", "leak"), blind("earlier", "a.ts", 4, "blocking", "leak")], 1),
    ).toEqual(["earlier"])
    expect(
      isolatedIds([blind("y", "a.ts", 3, "blocking", "crash"), blind("x", "a.ts", 3, "blocking", "crash")], 1),
    ).toEqual(["x"])
    // Two entries with one id (the desktop's legacy rule does not merge them) keep the order given.
    const twins = planIsolatedVerify(
      [entry(blind("same", "a.ts", 3, "blocking", "crash")), entry(blind("same", "a.ts", 3, "blocking", "crash"))],
      { k: 1, batched: counter().batched },
    )
    expect(twins.map((call) => call.positions)).toEqual([[0], [1]])
  })

  test("a k larger than the candidates isolates every blocking one and never a concern or a nit", () => {
    for (const k of [10, Number.POSITIVE_INFINITY]) {
      const count = counter()
      const plan = planIsolatedVerify(
        mixed.map((candidate) => entry(candidate)),
        { k, batched: count.batched },
      )
      expect(plan.filter((call) => call.kind === "isolated")).toHaveLength(7)
      expect(plan.at(-1)).toMatchObject({ kind: "batched", positions: [1, 6] })
      expect(shape(plan).at(-1)).toEqual({ kind: "batched", ids: ["concern-a1", "nit-a1"] })
      expect(count.seen).toHaveLength(1)
    }
    // Blocking candidates alone leave nothing to batch: no batched call, and its count is never asked for.
    const count = counter()
    const blocking = mixed.filter((candidate) => candidate.severity === "blocking")
    const plan = planIsolatedVerify(
      blocking.map((candidate) => entry(candidate)),
      { k: 10, batched: count.batched },
    )
    expect(plan.map((call) => call.kind)).toEqual(Array(blocking.length).fill("isolated"))
    expect(covered(plan)).toEqual(blocking.map((_, index) => index))
    expect(count.seen).toHaveLength(0)
  })

  test("a k of zero, below zero or not a number isolates none, a fraction rounds down, and no candidates plan no call", () => {
    for (const k of [0, -1, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const plan = planIsolatedVerify(
        mixed.map((candidate) => entry(candidate)),
        { k, batched: counter().batched },
      )
      expect(shape(plan)).toEqual([{ kind: "batched", ids: mixed.map((candidate) => candidate.id) }])
      expect(plan[0].positions).toEqual(mixed.map((_, index) => index))
    }
    expect(
      shape(
        planIsolatedVerify(
          mixed.map((candidate) => entry(candidate)),
          { k: 2.9, batched: counter().batched },
        ),
      ).map((call) => call.kind),
    ).toEqual(["isolated", "isolated", "batched"])
    const count = counter()
    expect(planIsolatedVerify([], { batched: count.batched })).toEqual([])
    expect(count.seen).toHaveLength(0)
  })

  // Whole findings, which are structurally blind candidates: the projection, not the type, keeps their text out.
  const SENTINEL = "SENTINEL-reviewer-text"
  const finding = (id: string, severity: Severity, over: Partial<Finding> = {}): Finding => ({
    id,
    path: "src/cart.ts",
    line: 12,
    side: "RIGHT",
    source: "review",
    severity,
    category: "bug",
    title: `The cart total of ${id} skips the discount`,
    body: `The loop in ${id} exits before the discount line is added.`,
    confidence: 0.9,
    ...over,
  })

  test("no reviewer text reaches any planned call, and each holds fresh copies of the blind fields alone", () => {
    // trigger and impact are the reviewer's words and reach the verifier by design (VS-44 item 1), so they carry no
    // sentinel here. A field the schema does not have, such as `note`, is still dropped.
    const failure = {
      class: "crash" as const,
      mechanism: "logic" as const,
      trigger: "an empty cart",
      impact: "checkout throws",
      note: SENTINEL,
    }
    const text = {
      title: SENTINEL,
      body: SENTINEL,
      suggestion: SENTINEL,
      rule: SENTINEL,
      patch: SENTINEL,
      duplicateOf: SENTINEL,
      also: [SENTINEL],
      quotes: [{ path: "src/cart.ts", line: 12, side: "RIGHT" as const, code: SENTINEL }],
      endLine: 14,
      verified: true,
      verifiedBy: "model" as const,
      scope: "introduced" as const,
      failure,
    }
    const findings = [
      finding("a", "blocking", {
        ...text,
        evidence: ["src/a.ts:12", "src/b.ts:3-9", `${SENTINEL} trust me`, "src/c.ts"],
      }),
      finding("b", "blocking", { ...text, evidence: [`${SENTINEL} trust me`] }),
      finding("c", "concern", text),
      finding("d", "nit", { ...text, evidence: ["src/d.ts:1"] }),
      // A class and a mechanism the enums do not name.
      finding("e", "concern", { ...text, failure: { ...failure, class: "meltdown" as string as FailureClass } }),
      finding("f", "nit", { ...text, failure: { ...failure, mechanism: "telepathy" as string as FailureMechanism } }),
    ]
    const seen: (readonly Finding[])[] = []
    const plan = planIsolatedVerify(
      findings.map((candidate) => entry(candidate)),
      {
        k: 1,
        batched: {
          promptTokens: (rest) => {
            seen.push(rest)
            return 1_000
          },
          maxSteps: 10,
          price: SONNET,
        },
      },
    )
    expect(shape(plan)).toEqual([
      { kind: "isolated", ids: ["a"] },
      { kind: "batched", ids: ["b", "c", "d", "e", "f"] },
    ])
    expect(JSON.stringify(plan)).not.toContain(SENTINEL)
    expect(JSON.stringify(plan)).not.toContain("meltdown")
    expect(JSON.stringify(plan)).not.toContain("telepathy")
    const BLIND = ["evidence", "failure", "id", "line", "path", "severity", "side"]
    const planned = plan.flatMap((call) => call.candidates)
    for (const candidate of planned) {
      for (const key of Object.keys(candidate)) expect(BLIND).toContain(key)
      expect(candidate.failure).not.toBe(failure)
      expect(findings).not.toContain(candidate)
    }
    // The four FailureInfo fields alone, and no failure at all for a class or a mechanism the enums do not name.
    const FAILURE = ["class", "impact", "mechanism", "trigger"]
    expect(planned.map((candidate) => Object.keys(candidate.failure ?? {}).toSorted())).toEqual([
      FAILURE,
      FAILURE,
      FAILURE,
      FAILURE,
      [],
      [],
    ])
    expect(planned.map((candidate) => Object.hasOwn(candidate, "failure"))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ])
    const isolated = plan[0].candidates[0]
    expect(isolated.evidence).toEqual(["src/a.ts:12", "src/b.ts:3-9"])
    expect(isolated.evidence).not.toBe(findings[0].evidence)
    expect(plan[1].candidates.map((candidate) => Object.hasOwn(candidate, "evidence"))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ])
    expect(plan[1].candidates[2].evidence).not.toBe(findings[3].evidence)
    // The batched count is the caller's own: it gets its own findings, unprojected, so it can count the prompt it
    // would send (run.ts's batched prompt has each finding's title, body and suggestion).
    expect(seen).toHaveLength(1)
    expect(seen[0].length).toBe(5)
    for (const [index, item] of seen[0].entries()) expect(item).toBe(findings[index + 1])
  })

  test("at k = 0 the one batched estimate is today's verify estimate, and each isolated call is priced on its own entry", () => {
    // run.ts today: estimateCostUsd({ promptTokens: Math.ceil(verifyText.length / 3.5), maxSteps: VERIFY_STEPS (10),
    // price }) over buildVerifyPrompt's text for every candidate.
    const HEAD = "0123456789abcdef0123456789abcdef01234567"
    const tokens = (candidates: readonly Finding[]) =>
      Math.ceil(buildVerifyPrompt({ trust: "untrusted", head: HEAD, candidates: [...candidates] }).length / 3.5)
    const findings = [
      finding("a", "blocking", {
        suggestion: "  total += discount",
        failure: { class: "data-corruption", mechanism: "logic", trigger: "a discount", impact: "a wrong total" },
      }),
      finding("b", "concern", { path: "src/tax.ts", line: 40 }),
      finding("c", "blocking", { path: "src/auth.ts", line: 3 }),
      finding("d", "nit", { path: "src/cart.ts", line: 90 }),
    ]
    const today = estimateCostUsd({ promptTokens: tokens(findings), maxSteps: 10, price: SONNET })
    const batched = { promptTokens: tokens, maxSteps: 10, price: SONNET }
    const plan = planIsolatedVerify(
      findings.map((candidate) => entry(candidate, 0)),
      { k: 0, batched },
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe("batched")
    expect(plan[0].positions).toEqual([0, 1, 2, 3])
    expect(plan[0].estimate.low).toBe(today.low)
    expect(plan[0].estimate.high).toBe(today.high)
    expect(plan.reduce((sum, call) => sum + call.estimate.low, 0)).toBe(today.low)
    expect(plan.reduce((sum, call) => sum + call.estimate.high, 0)).toBe(today.high)

    // At k = 3 each isolated call takes its own entry's tokens, steps and price, and the batched call the count of the
    // rest alone.
    const calls = [
      entry(findings[0], 1_500, SONNET),
      entry(findings[1], 900, SONNET),
      entry(findings[2], 2_500, SMALL, 6),
      entry(findings[3], 700, SMALL),
    ]
    const split = planIsolatedVerify(calls, { k: 3, batched })
    expect(shape(split)).toEqual([
      { kind: "isolated", ids: ["a"] },
      { kind: "isolated", ids: ["c"] },
      { kind: "batched", ids: ["b", "d"] },
    ])
    for (const call of split.filter((item) => item.kind === "isolated")) {
      const own = calls[call.positions[0]]
      expect(call.estimate).toEqual(
        estimateCostUsd({ promptTokens: own.promptTokens, maxSteps: own.maxSteps, price: own.price }),
      )
    }
    expect(split[1].estimate).toEqual(estimateCostUsd({ promptTokens: 2_500, maxSteps: 6, price: SMALL }))
    expect(split[2].estimate).toEqual(
      estimateCostUsd({ promptTokens: tokens([findings[1], findings[3]]), maxSteps: 10, price: SONNET }),
    )
    // A count that is not a number is never priced as free.
    const unknown = planIsolatedVerify([entry(findings[0], Number.NaN), entry(findings[1])], {
      batched: { promptTokens: () => Number.NaN, maxSteps: 10, price: SONNET },
    })
    expect(unknown.map((call) => call.kind)).toEqual(["isolated", "batched"])
    for (const call of unknown) {
      expect(call.estimate.low).toBeNaN()
      expect(call.estimate.high).toBeNaN()
    }
  })
})

describe("large review batch planner (VS-19)", () => {
  const one = (path: string, after = "new") =>
    parseUnifiedDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${after}\n`)[0]!
  const base = "1".repeat(40)
  const head = "2".repeat(40)
  const limits = { maxFiles: 2, maxChangedLines: 4, maxDiffChars: 8_000 }
  test("orders by risk density and preserves fitting impact clusters independently of input and cluster labels", () => {
    const files = ["b.ts", "c.ts", "z.ts", "src/auth/login.ts"].map((path) => one(path))
    const clusters = new Map([
      ["b.ts", "PRIVATE_LABEL"],
      ["z.ts", "PRIVATE_LABEL"],
    ])
    const plan = planReviewBatches({ base, head, files, clusters, limits })
    expect(plan.batches.map((batch) => batch.paths)).toEqual([["src/auth/login.ts"], ["b.ts", "z.ts"], ["c.ts"]])
    expect(
      planReviewBatches({
        base,
        head,
        files: files.toReversed(),
        clusters: new Map([
          ["z.ts", "other"],
          ["b.ts", "other"],
        ]),
        limits,
      }),
    ).toEqual(plan)
    expect(JSON.stringify(plan)).not.toContain("PRIVATE_LABEL")
    expect(new Set(plan.batches.map((batch) => batch.id)).size).toBe(3)
    expect(plan.omitted).toEqual([])
    expect(() => planReviewBatches({ base, head, files: [files[0]!, files[0]!], limits })).toThrow("Duplicate")
    expect(() => planReviewBatches({ base, head: "HEAD", files, limits })).toThrow("commit")
  })
  test("risk per line distinguishes concentrated changes from sheer file size", () => {
    const bulk = { path: "bulk.ts", additions: 1000, deletions: 0 }
    const small = { path: "z.ts", additions: 2, deletions: 0 }
    const auth = { ...small, path: "src/auth/login.ts" }
    expect(orderByRiskDensity([bulk, small, auth])).toEqual([auth, small, bulk])
  })
  test("accounts exact diff separators and refuses individual oversized, truncated or binary changes", () => {
    const files = [one("a.ts"), one("b.ts")]
    const exact = renderPatch(files).length
    const withChars = (maxDiffChars: number) =>
      planReviewBatches({ base, head, files, limits: { ...limits, maxDiffChars } })
    expect(withChars(exact).batches).toHaveLength(1)
    expect(withChars(exact).batches[0]!.diffChars).toBe(exact)
    expect(withChars(exact - 1).batches.map((batch) => batch.paths)).toEqual([["a.ts"], ["b.ts"]])
    const missing = { ...one("truncated.ts"), additions: 20 }
    const binary = { ...one("file.bin"), binary: true }
    const huge = one("huge.ts", "x".repeat(10_000))
    const plan = planReviewBatches({ base, head, files: [missing, binary, huge, ...files], limits })
    expect(plan.omitted.toSorted()).toEqual(["file.bin", "huge.ts", "truncated.ts"])
    expect(plan.batches.flatMap((batch) => batch.paths)).toEqual(["a.ts", "b.ts"])
    expect(planReviewBatches({ base, head, files, limits: { ...limits, maxChangedLines: 1 } }).batches).toEqual([])
    expect(planReviewBatches({ base, head, files, limits: { ...limits, maxFiles: 0 } }).omitted).toEqual([
      "a.ts",
      "b.ts",
    ])
    expect(() => withChars(Number.NaN)).toThrow("limit")
    expect(withChars(exact).id).not.toBe(withChars(exact - 1).id)
    expect(planReviewBatches({ base, head, files: [one("a.ts", "different"), files[1]!], limits }).id).not.toBe(
      planReviewBatches({ base, head, files, limits }).id,
    )
  })
})
