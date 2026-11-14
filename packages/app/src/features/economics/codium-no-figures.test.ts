import { expect, test } from "bun:test"
import type { ReviewCost } from "@vectordevai/core/review/types"
import { agentCostLabel } from "../agents/agent-dashboard-model"
import { estimateText, passLines, reviewFooter, reviewSpendText } from "../pull-requests/ai-review"
import { formatSessionCost } from "../../utils/session-cost"
import { spendPill } from "./format-spend"

test("Codium app readouts never print private figures or a zero dollar price beside the plan", () => {
  const cost: ReviewCost = {
    kind: "codium",
    model: "vector-plan/vector-flash",
    costUsd: 999,
    input: 987654,
    output: 1234,
    reasoning: 10,
    cacheRead: 20,
    cacheWrite: 30,
  }
  const labels = [
    reviewFooter({ cost, durationMs: 90000 }),
    ...passLines({
      cost,
      passes: [
        {
          name: "review",
          model: cost.model,
          costKind: "codium",
          costUsd: 999,
          input: 987654,
          output: 1234,
          cacheRead: 20,
        },
      ],
    }),
    reviewSpendText({ codium: true, tokens: 0, costUsd: 0 }),
    estimateText({ files: 3, costKind: "codium" }),
    agentCostLabel({
      runtime: "vector",
      actualCost: "$0.00",
      estimatedCost: "$0.00",
      running: false,
      billing: "codium",
    })!,
    formatSessionCost({
      cost: 0,
      unpricedSteps: 3,
      codiumSteps: 3,
      format: (n) => `$${n.toFixed(2)}`,
      t: (key) => key,
    }),
    spendPill({
      session: { label: "Codium", kind: "codium", codiumSteps: 3 },
      run: { spentUsd: 0, capUsd: 5, state: "ok" },
      running: true,
    }).label,
  ]
  for (const label of labels) {
    expect(label).toContain("Codium")
    // Duration remains visible after a separate footer separator; usage figures never qualify the plan label.
    expect(label).not.toMatch(/Codium\s*(?::\s*)?\d/)
    expect(label).not.toMatch(/Codium\s*·\s*(?:\$|[\d,.]+\s+(?:tokens|in|out))/)
    expect(label).not.toContain("$0.00")
    expect(label).not.toContain("987")
    expect(label).not.toContain("$999")
  }
})

test("mixed app readouts retain proven own figures alongside Codium", () => {
  const cost: ReviewCost = {
    kind: "priced",
    codium: true,
    tokensOwnOnly: true,
    model: "own/coder + vector-plan/vector-flash",
    costUsd: 0.12,
    input: 100,
    output: 20,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const labels = [
    reviewFooter({ cost, durationMs: 0 }),
    reviewSpendText({ codium: true, tokens: 120, costUsd: 0.12 }),
    agentCostLabel({
      runtime: "vector",
      actualCost: "$0.12",
      estimatedCost: "$0.00",
      running: false,
      billing: "codium",
      costKind: "priced",
    })!,
    formatSessionCost({
      cost: 0.12,
      unpricedSteps: 3,
      codiumSteps: 3,
      format: (n) => `$${n.toFixed(2)}`,
      t: (key) => key,
    }),
  ]
  for (const label of labels) {
    expect(label).toContain("$0.12")
    expect(label).toContain("Codium")
    expect(label).not.toContain("$0.00")
    // Label plan §2: never the vector-plan provider id; a Codium model reads "Vector Codium · <model>".
    expect(label).not.toContain("vector-plan")
  }
  expect(labels[0]).toContain("own/coder + Vector Codium · vector-flash · $0.12 + Codium")
})
