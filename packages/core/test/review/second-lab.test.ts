import { describe, expect, test } from "bun:test"
import { labName, labOf } from "../../src/model-lab"
import { ModelPlans } from "../../src/model-plans"
import { parseReviewConfig } from "../../src/review/config"
import { buildSummaryBody, type SummaryInput } from "../../src/review/format"
import { buildJudgePrompt } from "../../src/review/prompt"
import {
  checkedLabs,
  checkedLine,
  notePanelUnavailable,
  noteSameLabPair,
  reviewModels,
  type LabModel,
} from "../../src/review/second-lab"
import { DEFAULT_REVIEW_CONFIG, type Finding, type ReviewCost } from "../../src/review/types"

// WP A35: second-lab reviews. The lab behind a model, the models a review runs on (the plan's review pair on Vector
// Codium, a same-lab pair, a user's own triage model), how many labs checked the result, and the footer line.

const codium = (modelID: string, lab?: string): LabModel => ({ providerID: "vector-plan", modelID, ...(lab ? { lab } : {}) })
const DEEPSEEK = codium("deepseek/deepseek-v4.1-flash-1017", "deepseek")
const DEEPSEEK_LONG = codium("deepseek/deepseek-v4.1-flash-1017:long", "deepseek")
const LUNA = codium("openai/gpt-6-luna", "openai")
const HAIKU = codium("anthropic/claude-haiku-5.5", "anthropic")
const SOL_DEEP = codium("openai/gpt-6.1-sol:deep", "openai")
const SONNET = codium("anthropic/claude-sonnet-5.5", "anthropic")
const AUTO = codium("vector/codium-auto")
// The plan pairs §4.12 names: Plus DeepSeek → Luna with Haiku on the panel, Max DeepSeek → Sol Deep with Sonnet.
const PLUS = { triage: DEEPSEEK, confirm: LUNA, panelJudge: HAIKU }
const MAX = { triage: DEEPSEEK, confirm: SOL_DEEP, panelJudge: SONNET }

describe("labOf", () => {
  test("reads the vendor from routers, Codium ids, first-party providers and model families", () => {
    expect(labOf("vector-plan/deepseek/deepseek-v4.1-flash-1017")).toBe("deepseek")
    expect(labOf("vector-plan/openai/gpt-6.1-sol:deepest")).toBe("openai")
    expect(labOf("vector-plan/moonshotai/kimi-k3.1-pro:long")).toBe("moonshot")
    expect(labOf("openrouter/anthropic/claude-sonnet-4")).toBe("anthropic")
    expect(labOf("openrouter/google/gemini-2.5-pro")).toBe("google")
    expect(labOf("anthropic/claude-opus-4")).toBe("anthropic")
    expect(labOf("openai/o3-mini")).toBe("openai")
    expect(labOf("github-copilot/gpt-5")).toBe("openai")
    expect(labOf("amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")).toBe("anthropic")
    expect(labOf("groq/deepseek-r1-distill-llama-70b")).toBe("deepseek")
    expect(labOf("together/meta-llama/llama-3.3-70b")).toBe("meta")
    expect(labOf("xai/grok-4")).toBe("xai")
    expect(labOf("mistral/devstral-medium")).toBe("mistral")
    expect(labOf("openrouter/z-ai/glm-4.6")).toBe("zhipu")
  })

  test("names no lab when the vendor cannot be told, and a stated lab wins", () => {
    expect(labOf("lmstudio/test-model")).toBeUndefined()
    expect(labOf("vector-plan/vector/codium-auto")).toBeUndefined()
    expect(labOf("vector/openrouter/free")).toBeUndefined()
    expect(labOf("")).toBeUndefined()
    expect(labOf("lmstudio/test-model", "google")).toBe("google")
    expect(labOf("lmstudio/claude-local", "not-a-lab")).toBe("anthropic")
    expect(labName("moonshot")).toBe("Moonshot AI")
  })
})

describe("reviewModels: the plan's review pair on Vector Codium", () => {
  test("Codium Auto or the pair's own triage model runs the pair: first pass on one lab, check on another", () => {
    for (const model of [AUTO, DEEPSEEK])
      expect(reviewModels({ model, panel: false, codium: PLUS, auto: model === AUTO })).toEqual({
        model: LUNA,
        triage: DEEPSEEK,
        notes: [],
      })
    expect(reviewModels({ model: DEEPSEEK, panel: false, codium: MAX })).toEqual({
      model: SOL_DEEP,
      triage: DEEPSEEK,
      notes: [],
    })
  })

  test("a Codium model the settings named checks the pair's first pass", () => {
    expect(reviewModels({ model: SONNET, panel: false, codium: MAX })).toEqual({
      model: SONNET,
      triage: DEEPSEEK,
      notes: [],
    })
  })

  test("a pair whose two models come from the same lab warns and runs one pass", () => {
    const result = reviewModels({ model: DEEPSEEK_LONG, panel: false, codium: MAX })
    expect(result.model).toEqual(DEEPSEEK_LONG)
    expect(result.triage).toBeUndefined()
    expect(result.notes).toEqual([noteSameLabPair("deepseek", "vector-plan/deepseek/deepseek-v4.1-flash-1017:long")])
    expect(result.notes[0]).toContain("one pass")
    // A degenerate catalog pair warns the same way.
    expect(reviewModels({ model: AUTO, auto: true, panel: false, codium: { triage: LUNA, confirm: SOL_DEEP } }).notes)
      .toHaveLength(1)
  })

  test("without a usable pair the review runs one pass on the chosen model, as before", () => {
    // Pro before Sol is accepted: the catalog serves no confirm model.
    expect(reviewModels({ model: DEEPSEEK, panel: false, codium: { triage: DEEPSEEK } })).toEqual({
      model: DEEPSEEK,
      notes: [],
    })
    expect(reviewModels({ model: DEEPSEEK, panel: false })).toEqual({ model: DEEPSEEK, notes: [] })
  })

  test("a triageModel the user set is their own first pass and runs as it always has", () => {
    const cheap = { providerID: "anthropic", modelID: "claude-haiku-4" }
    const strong = { providerID: "anthropic", modelID: "claude-opus-4" }
    // Same lab, own keys: two passes, no warning, and no second-lab line later.
    expect(reviewModels({ model: strong, triage: cheap, panel: false })).toEqual({
      model: strong,
      triage: cheap,
      notes: [],
    })
    expect(checkedLabs({ model: strong, triage: cheap, verified: true })).toBeUndefined()
    // A triageModel equal to the review model is no first pass.
    expect(reviewModels({ model: strong, triage: strong, panel: false })).toEqual({ model: strong, notes: [] })
  })
})

describe("reviewModels: the panel", () => {
  test("the plan's panel judge joins when the three models come from three labs", () => {
    expect(reviewModels({ model: AUTO, auto: true, panel: true, codium: PLUS })).toEqual({
      model: LUNA,
      triage: DEEPSEEK,
      judge: HAIKU,
      notes: [],
    })
    // Off unless asked for.
    expect(reviewModels({ model: AUTO, auto: true, panel: false, codium: PLUS }).judge).toBeUndefined()
  })

  test("own keys build a panel from triageModel, model and judgeModel", () => {
    const triage = { providerID: "openrouter", modelID: "deepseek/deepseek-chat" }
    const model = { providerID: "openai", modelID: "gpt-5" }
    const judge = { providerID: "anthropic", modelID: "claude-sonnet-4" }
    expect(reviewModels({ model, triage, judge, panel: true })).toEqual({ model, triage, judge, notes: [] })
  })

  test("a panel the models cannot form says so and runs without the judge", () => {
    const triage = { providerID: "openrouter", modelID: "deepseek/deepseek-chat" }
    const model = { providerID: "openai", modelID: "gpt-5" }
    for (const input of [
      // No judge at all.
      { model, triage, panel: true },
      // A judge from a lab already on the panel.
      { model, triage, judge: { providerID: "openai", modelID: "o3" }, panel: true },
      // A judge whose lab cannot be named.
      { model, triage, judge: { providerID: "lmstudio", modelID: "local-judge" }, panel: true },
      // No first pass: a single pass has no second lab to add a third to.
      { model, judge: { providerID: "anthropic", modelID: "claude-sonnet-4" }, panel: true },
    ]) {
      const result = reviewModels(input)
      expect(result.judge).toBeUndefined()
      expect(result.notes).toEqual([notePanelUnavailable()])
    }
  })
})

describe("checkedLabs and the footer line", () => {
  test("two labs after a finished check from another lab, three with the panel's judge", () => {
    expect(checkedLabs({ model: LUNA, triage: DEEPSEEK, verified: true })).toBe(2)
    expect(checkedLabs({ model: LUNA, triage: DEEPSEEK, judge: HAIKU, verified: true, judged: true })).toBe(3)
    // A judge that did not finish leaves the two labs that did.
    expect(checkedLabs({ model: LUNA, triage: DEEPSEEK, judge: HAIKU, verified: true, judged: false })).toBe(2)
  })

  test("no line without a finished check from another lab Vector can name", () => {
    expect(checkedLabs({ model: LUNA, verified: true })).toBeUndefined()
    expect(checkedLabs({ model: LUNA, triage: DEEPSEEK, verified: false })).toBeUndefined()
    expect(checkedLabs({ model: SOL_DEEP, triage: LUNA, verified: true })).toBeUndefined()
    expect(
      checkedLabs({ model: { providerID: "lmstudio", modelID: "test-model" }, triage: DEEPSEEK, verified: true }),
    ).toBeUndefined()
  })

  test("the line is words, never a figure", () => {
    expect(checkedLine(2)).toBe("Checked by a second lab")
    expect(checkedLine(3)).toBe("Checked by three labs")
    expect(checkedLine(undefined)).toBeUndefined()
  })

  const cost = (overrides: Partial<ReviewCost>): ReviewCost => ({
    costUsd: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    kind: "codium",
    model: "vector-plan/deepseek/deepseek-v4.1-flash-1017 + vector-plan/openai/gpt-6-luna",
    ...overrides,
  })
  const summary = (overrides: Partial<SummaryInput>): SummaryInput => ({
    head: "a".repeat(40),
    baseRef: "main",
    mode: "full",
    durationMs: 61_000,
    ...overrides,
  })

  test("the summary footer says it on Codium and with your own keys, in GitHub and on the desktop", () => {
    const codiumFooter = buildSummaryBody(summary({ cost: cost({ labs: 2 }) }))
    expect(codiumFooter).toContain("· Codium · Checked by a second lab · 1m 1s")
    const own = cost({
      kind: "priced",
      costUsd: 0.12,
      input: 1_000,
      output: 100,
      model: "openrouter/deepseek/deepseek-chat + openai/gpt-5 + anthropic/claude-sonnet-4",
      labs: 3,
    })
    expect(buildSummaryBody(summary({ cost: own }))).toContain("Checked by three labs")
    expect(buildSummaryBody(summary({ form: "desktop", cost: own }))).toContain("Checked by three labs")
    const plain = buildSummaryBody(summary({ cost: cost({}) }))
    expect(plain).not.toContain("Checked by")
  })
})

describe("review.json and the judge's prompt", () => {
  test("panel and judgeModel are read leniently", () => {
    expect(DEFAULT_REVIEW_CONFIG.panel).toBe(false)
    const parsed = parseReviewConfig({ json: JSON.stringify({ panel: true, judgeModel: " anthropic/claude-sonnet-4 " }) })
    expect(parsed.config).toMatchObject({ panel: true, judgeModel: "anthropic/claude-sonnet-4" })
    expect(parsed.warnings).toEqual([])
    const bad = parseReviewConfig({ json: JSON.stringify({ panel: "yes", judgeModel: "sonnet" }) })
    expect(bad.config.panel).toBe(false)
    expect(bad.config.judgeModel).toBeUndefined()
    expect(bad.warnings).toHaveLength(2)
  })

  test("the judge sees each candidate with the check's verdict, inside the untrusted tag", () => {
    const finding: Finding = {
      id: "f1",
      path: "src/list.ts",
      line: 3,
      side: "RIGHT",
      severity: "blocking",
      category: "bug",
      title: "Returns undefined for the last item",
      body: "items[items.length] is one past the end.",
      confidence: 0.9,
      source: "review",
    }
    const other = { ...finding, id: "f2", title: "Second" }
    const text = buildJudgePrompt({
      trust: "untrusted",
      head: "b".repeat(40),
      candidates: [finding, other],
      checks: [{ id: "f1", verdict: "rejected", reason: "The loop bound stops one short." }],
    })
    expect(text.startsWith("You are the judge on a review panel")).toBe(true)
    expect(text).not.toContain("You are checking candidate findings")
    expect(text).toContain('<untrusted_candidate id="f1"')
    expect(text).toContain("Second reviewer: rejected. The loop bound stops one short.")
    expect(text).toContain("Second reviewer: gave no verdict for this candidate.")
    expect(text.indexOf("Second reviewer: rejected")).toBeLessThan(text.indexOf("</untrusted_candidate>"))
    expect(text).toContain("Finish by calling StructuredOutput once.")
  })
})

describe("the Codium listing", () => {
  test("names each entry's Second opinion judge and its parts in the plan's review pair", () => {
    const entry = (id: string, lab: (typeof ModelPlans.LABS)[number]) =>
      ({ id, name: id, contextLength: 128_000, maxOutputTokens: 8_192, lab }) satisfies ModelPlans.Model
    const catalog = {
      judges: { [DEEPSEEK.modelID]: LUNA.modelID, [LUNA.modelID]: LUNA.modelID },
      review: { triage: DEEPSEEK.modelID, confirm: LUNA.modelID, panelJudge: HAIKU.modelID },
    }
    expect(ModelPlans.listing(entry(DEEPSEEK.modelID, "deepseek"), catalog)).toEqual({
      lab: "deepseek",
      judge: LUNA.modelID,
      review: ["triage"],
    })
    // A judge naming the entry itself is no second opinion, and it is left out.
    expect(ModelPlans.listing(entry(LUNA.modelID, "openai"), catalog)).toEqual({ lab: "openai", review: ["confirm"] })
    // Without the catalog the listing is what it was.
    expect(ModelPlans.listing(entry(HAIKU.modelID, "anthropic"))).toEqual({ lab: "anthropic" })
  })
})
