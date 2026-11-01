import { expect, test } from "bun:test"
import type { StepFinishPart } from "@vectordevai/sdk/v2"
import { stepForOutput } from "@/cli/cmd/run/usage-output"

test("JSON step_finish masks Codium root and delegated parts without changing internal context usage", () => {
  const part: StepFinishPart = {
    id: "part",
    messageID: "msg",
    sessionID: "ses",
    type: "step-finish",
    reason: "stop",
    cost: 99,
    tokens: { input: 987654, output: 1234, reasoning: 12, cache: { read: 5, write: 3 } },
  }
  expect(stepForOutput(part, "own")).toBe(part)
  expect(stepForOutput(part)).not.toHaveProperty("tokens")
  expect(stepForOutput(part)).not.toHaveProperty("billing")
  expect(stepForOutput(part).cost).toBe(99)
  for (const record of [stepForOutput({ ...part, billing: "codium" }), stepForOutput(part, "codium")]) {
    expect(record).toMatchObject({ billing: "codium", cost: 0, unpriced: true })
    expect(record).not.toHaveProperty("tokens")
    expect(JSON.stringify({ type: "step_finish", part: record, subagent: true })).not.toContain("987654")
  }
  expect(part.tokens.input).toBe(987654)
  expect(part.cost).toBe(99)
})
