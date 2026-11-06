import { describe, expect, test } from "bun:test"
import { noteTriageUnchecked, noteVerifyUnfinished } from "@vectordevai/core/review/format"
import {
  combineCostKinds,
  contextRefusal,
  diffBudgetChars,
  estimateBands,
  estimateCostUsd,
  MIN_CONTEXT,
  nextStepCostUsd,
  OUTPUT_PER_STEP,
  passInputTokens,
  planSpecialists,
  verifyCandidates,
  verifyUnanswered,
  verifyUnconfirmed,
  type ReviewPrice,
  type VerifyRule,
} from "@vectordevai/core/review/plan"
import type { Finding, ReviewConfig, Severity, Trust } from "@vectordevai/core/review/types"

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
