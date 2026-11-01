import { expect, test } from "bun:test"
import type { StepFinishPart, ToolPart } from "@vectordevai/sdk/v2"
import { stepForOutput, toolForOutput } from "@/cli/cmd/run/usage-output"

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

test("task JSON omits editable aggregate quantities including forged proof and nested batch records", () => {
  const usage = { tokensOwnOnly: true, tokens: { input: 987654 }, total: 987654, cost: 0.12, toolUses: 2 }
  for (const tasks of [
    [
      { index: 0, usage },
      { index: 1, tasks: [{ usage }] },
    ],
    { first: { usage }, second: { tasks: { nested: { usage } } } },
    { usage },
  ]) {
    const part: ToolPart = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      tool: "task",
      callID: "call",
      state: {
        status: "completed",
        input: {},
        output: "report",
        title: "task",
        time: { start: 1, end: 2 },
        metadata: { usage, tasks, subagent: { usage }, unrelated: { tokens: "language tokens" } },
      },
    }
    const before = JSON.stringify(part)
    const printed = toolForOutput(part)
    expect(JSON.stringify(printed)).not.toContain("987654")
    expect(JSON.stringify(printed)).not.toContain("tokensOwnOnly")
    if (printed.state.status !== "completed") throw new Error("completed task output changed state")
    expect(printed.state.metadata).toMatchObject({
      usage: { cost: 0.12, toolUses: 2 },
      unrelated: { tokens: "language tokens" },
    })
    expect(JSON.stringify(part)).toBe(before)
    const unrelated = { ...part, tool: "custom" }
    expect(toolForOutput(unrelated)).toBe(unrelated)
  }
})
