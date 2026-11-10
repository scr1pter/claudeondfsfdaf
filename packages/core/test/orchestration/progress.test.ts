import { expect, test } from "bun:test"
import { WorkflowPlan } from "../../src/orchestration/plan"
import { WorkflowProgress } from "../../src/orchestration/progress"

test("progress reconciles durable node keys and gives waiting work priority", () => {
  const built = WorkflowPlan.build(
    { version: 1, title: "Run", stages: [{ id: "a", prompt: "Work" }] },
    {
      agents: [{ name: "general", allowed: true, writes: false }],
      cpus: 4,
    },
  )
  if (!built.plan) throw new Error("Plan was refused")
  const result = WorkflowProgress.of(
    built.plan,
    [
      { key: "old", stage: "a", status: "failed" },
      { key: "old", stage: "a", status: "completed" },
      { key: "run", stage: "a", status: "running" },
      { key: "ask", stage: "a", item: "needs approval", status: "waiting" },
    ],
    { launched: 4, steps: 5, tokens: 100, elapsedMs: 5000, spentUsd: 0 },
  )
  expect(result.stages[0]).toMatchObject({ done: 1, failed: 0, running: 1, waiting: 1 })
  expect(result.item).toBe("needs approval")
  expect(result.agents).toEqual({ launched: 4, max: 100, running: 2 })
})
