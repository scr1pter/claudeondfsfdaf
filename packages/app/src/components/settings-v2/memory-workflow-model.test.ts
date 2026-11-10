import { describe, expect, test } from "bun:test"
import {
  MODES,
  WORKFLOW,
  adviceLabel,
  armRow,
  card,
  controls,
  cost,
  passRate,
  sizeDefault,
  sized,
  tierLabel,
  type WorkflowArmStats,
} from "./memory-workflow-model"

const arm = (input: Partial<WorkflowArmStats> = {}): WorkflowArmStats => ({
  arm: { effortTier: "thorough", effort: "default", split: "solo", providerID: "anthropic", modelID: "claude-x" },
  rows: 10,
  weight: 10,
  signal: 10,
  passRate: 0.9,
  lower: 0.7,
  checkedShare: 1,
  costUsd: 0.41,
  pricedWeight: 10,
  lastAt: 0,
  ...input,
})

const reason =
  "Thorough work here passed 9 of 10 checked runs at default effort (avg $0.41) against 8 of 9 at high (avg $0.93)."

describe("Settings > Memory > Workflow insights", () => {
  test("offers Apply, Observe only and Off", () => {
    expect(MODES.map((item) => [item.value, item.label])).toEqual([
      ["apply", "Apply"],
      ["observe", "Observe only"],
      ["off", "Off"],
    ])
  })

  test("says what each size runs with and the learned default against it, with the reason", () => {
    expect(sizeDefault("thorough")).toBe("High effort, with subagents")
    // Standard is offered subagents and the agent decides when to use them (5.A.1); Light launches none.
    expect(sizeDefault("standard")).toBe("The model's default effort; subagents when the agent decides")
    expect(sizeDefault("light")).toBe("The model's default effort, working solo")
    const learned = card({
      tier: "thorough",
      arms: [arm()],
      advice: { effortTier: "thorough", effort: "default", source: "learned", reason },
      excluded: 2,
    })
    expect(learned).toMatchObject({
      title: "Thorough",
      current: "High effort, with subagents",
      learned: "Learned: Default effort",
      reason,
      excluded: "2 runs left out: you, the agent or config chose the effort, or the run read the web.",
    })
    expect(
      card({
        tier: "thorough",
        arms: [],
        advice: { effortTier: "thorough", subagentModel: "small", source: "explore", reason: "Trying it." },
        excluded: 0,
      }),
    ).toMatchObject({ learned: "Trying: The small model for subagents", excluded: undefined })
    // Outside Apply mode, the card says what would apply.
    expect(
      card({
        tier: "thorough",
        arms: [],
        wouldAdvise: { effortTier: "thorough", split: "solo", source: "learned", reason },
        excluded: 0,
      }).learned,
    ).toBe("Would use: Working solo")
    expect(card({ tier: "light", arms: [], excluded: 0 })).toMatchObject({
      title: "Light",
      learned: "No learned default yet",
    })
    expect(adviceLabel({ effort: "default", split: "solo", subagentModel: "small" })).toBe(
      "Default effort, Working solo, The small model for subagents",
    )
  })

  test("lists each arm by effort, split and model, with runs, pass rate, checked share and cost", () => {
    expect(armRow(arm())).toEqual({
      setting: "Default effort · solo · anthropic/claude-x",
      runs: "10",
      passRate: "9 of 10 (90%)",
      checked: "100%",
      cost: "$0.41",
    })
    expect(
      armRow(
        arm({
          arm: {
            effortTier: "thorough",
            effort: "high",
            split: "subagents",
            providerID: "anthropic",
            modelID: "claude-x",
            subagentModel: "small",
          },
        }),
      ).setting,
    ).toBe("High effort · subagents on the small model · anthropic/claude-x")
  })

  test("says an unknown cost is unknown, never $0, and a size with no checked runs has no rate", () => {
    expect(cost({})).toBe("unknown")
    expect(cost({ costUsd: 0 })).toBe("$0.00")
    expect(passRate({ signal: 0 })).toBe("No checked runs")
    expect(armRow(arm({ costUsd: undefined })).cost).toBe("unknown")
  })

  test("covers the sizes Vector learns for, never Chat", () => {
    expect(sized([{ tier: "chat" }, { tier: "light" }, { tier: "thorough" }]).map((item) => item.tier)).toEqual([
      "light",
      "thorough",
    ])
    expect(tierLabel("standard")).toBe("Standard")
  })

  test("keeps to the precedence and privacy statements", () => {
    expect(WORKFLOW.own).toBe(
      "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged.",
    )
    expect(WORKFLOW.privacy).toBe(
      "Workflow insights record numbers only: size, effort, subagent count, model id, outcome, steps, tokens and cost. They record no prompt or file text.",
    )
    expect(WORKFLOW.reset).toContain("also clears the app's model recommendations")
    for (const text of Object.values(WORKFLOW)) expect(text.toLowerCase()).not.toContain("project")
  })
})

describe("the mode and Explore controls", () => {
  test("show the owner's saved settings, with no repository open or before the insights load", () => {
    const saved = { workflow: "observe" as const, workflowExplore: true }
    expect(controls(saved, undefined)).toEqual({ mode: "observe", explore: true })
    expect(controls(saved, { mode: "apply", explore: false })).toEqual({ mode: "observe", explore: true })
    expect(controls(undefined, { mode: "off", explore: true })).toEqual({ mode: "off", explore: true })
    expect(controls(undefined, undefined)).toEqual({ mode: "apply", explore: false })
  })
})
