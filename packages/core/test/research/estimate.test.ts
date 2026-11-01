import { describe, expect, test } from "bun:test"
import { ResearchEstimate } from "../../src/research/estimate"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

// $3 per million input tokens, $0.30 per million cached, $15 per million output.
const price = { input: 3, cacheRead: 0.3, output: 15 }

describe("ResearchEstimate.estimate", () => {
  // One agent: 1 search, 2 pages and 3 notes take 1 + 2 + 1 steps, plus 4 of its own. Each step sends the 10,000-token
  // base prompt and the share of the 2 pages' 2,000 tokens read before it: 0, 286, 571, 857, 1,143, 1,429, 1,714, 2,000.
  const single = ResearchEstimate.estimate({
    pages: 2,
    searches: 1,
    notes: 3,
    prompt: 10_000,
    chunkTokens: 1_000,
    kind: "priced",
    price,
  })

  test("counts one agent's steps and the input they re-send", () => {
    expect(single.calls).toBe(8)
    expect(single.input).toBe(88_000)
    expect(single.output).toBe(8 * ResearchEstimate.OUTPUT_PER_STEP)
    expect(single.agents).toEqual([{ role: "lead", steps: 8, input: 88_000, uncached: 12_000 }])
  })

  test("prices the low figure with cache reads and the high one without", () => {
    // High: 88,000 input at $3/M plus 8 steps of 600 output at $15/M.
    expect(single.usd!.high).toBeCloseTo(0.264 + 0.072, 10)
    // Low: 12,000 new input at $3/M, 76,000 cached at $0.30/M, and the same output.
    expect(single.usd!.low).toBeCloseTo(0.036 + 0.0228 + 0.072, 10)
  })

  test("assumes 0.4 notes per page when the plan does not say", () => {
    // 15 pages give 6 notes, 2 steps; with 8 searches and 4 of its own, 29 steps.
    expect(
      ResearchEstimate.estimate({ pages: 15, searches: 8, prompt: 20_000, chunkTokens: 1_200, kind: "free" }).calls,
    ).toBe(29)
  })

  // Two researchers share 2 searches, 4 pages and 4 notes: 1 + 2 + 1 steps each, plus 2 of their own, on a 6,000-token
  // prompt growing by their 2 pages of 600. The lead plans, starts each and writes the report from what they return
  // (4 + 2 steps, growing by 2 returns of 400), and the judge reads 4 notes with their passages in one call.
  const deep = ResearchEstimate.estimate({
    pages: 4,
    searches: 2,
    notes: 4,
    researchers: 2,
    judge: true,
    prompt: 10_000,
    researcherPrompt: 6_000,
    chunkTokens: 600,
    kind: "local",
    speed: { outputPerSecond: 20, firstTokenSeconds: 0.5, promptPerSecond: 1_000 },
  })

  test("adds each researcher's share, the lead's synthesis and the judge", () => {
    expect(deep.agents).toEqual([
      { role: "lead", steps: 6, input: 62_400, uncached: 10_800 },
      { role: "researcher", steps: 6, input: 39_600, uncached: 7_200 },
      { role: "researcher", steps: 6, input: 39_600, uncached: 7_200 },
      { role: "judge", steps: 1, input: 4_120, uncached: 4_120 },
    ])
    expect(deep.calls).toBe(19)
    expect(deep.input).toBe(145_720)
  })

  test("gives a local model's time from its measured speed, and no dollar figure", () => {
    expect(deep.usd).toBeUndefined()
    // 19 calls of 0.5 s to the first token and 600 tokens at 20 a second, plus 29,320 new prompt tokens at 1,000 a second.
    expect(deep.minutes).toBeCloseTo((19 * 30.5 + 29.32) / 60, 10)
  })

  test("gives no time without a measured speed, and no price for a model without one", () => {
    expect(
      ResearchEstimate.estimate({ pages: 1, searches: 1, prompt: 1_000, chunkTokens: 600, kind: "local" }).minutes,
    ).toBeUndefined()
    expect(
      ResearchEstimate.estimate({ pages: 1, searches: 1, prompt: 1_000, chunkTokens: 600, kind: "unknown", price }).usd,
    ).toBeUndefined()
  })
})

describe("ResearchEstimate.copy", () => {
  const line = (
    kind: Parameters<typeof ResearchEstimate.copy>[0]["kind"],
    extra: Partial<Parameters<typeof ResearchEstimate.copy>[0]> = {},
  ) =>
    ResearchEstimate.copy({
      pages: 25,
      searches: 8,
      estimate: { calls: 60, input: 0, output: 0, usd: { low: 0.4, high: 1.1 }, minutes: 9.2, agents: [] },
      kind,
      capSteps: 120,
      ...extra,
    })

  test("words each kind of model the way the plan card shows it, always as an estimate", () => {
    expect(line("priced", { capUsd: 1 })).toBe(
      "About 25 pages and 8 searches. Estimated $0.40–$1.10 at list prices. Cap $1.00.",
    )
    expect(line("priced")).toBe("About 25 pages and 8 searches. Estimated $0.40–$1.10 at list prices. Step cap 120.")
    expect(line("local")).toBe(
      "About 25 pages and 8 searches, about 60 calls to your local model. No per-token charge. Step cap 120. On this server that is about 9 minutes.",
    )
    expect(line("free")).toBe(
      "About 25 pages and 8 searches. No per-token charge on this free model, within its daily limits. Step cap 120.",
    )
    expect(line("plan")).toBe("About 25 pages and 8 searches. Counts toward your plan's usage limits. Step cap 120.")
    expect(line("unknown")).toBe(
      "About 25 pages and 8 searches. This model has no listed price, so Vector cannot estimate the cost. Step cap 120.",
    )
  })

  test("formats the single-agent estimate in dollars and cents", () => {
    const estimate = ResearchEstimate.estimate({
      pages: 2,
      searches: 1,
      notes: 3,
      prompt: 10_000,
      chunkTokens: 1_000,
      kind: "priced",
      price,
    })
    expect(ResearchEstimate.copy({ pages: 2, searches: 1, estimate, kind: "priced", capUsd: 1, capSteps: 80 })).toBe(
      "About 2 pages and 1 search. Estimated $0.13–$0.34 at list prices. Cap $1.00.",
    )
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})

test("Codium research never exposes a price estimate even when catalog prices exist", () => {
  const estimate = ResearchEstimate.estimate({
    pages: 2,
    searches: 1,
    prompt: 1000,
    chunkTokens: 1000,
    kind: "codium",
    price,
  })
  expect(estimate.usd).toBeUndefined()
  const copy = ResearchEstimate.copy({ pages: 2, searches: 1, estimate, kind: "codium", capUsd: 1, capSteps: 80 })
  expect(copy).toContain("Uses your Vector Codium plan; Vector shows no cost estimate for Codium.")
  expect(copy).toContain("Step cap 80")
  expect(copy).not.toContain("$")
  expect(copy).not.toContain("tokens")
})
