import { expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkflowSources } from "@/orchestration/sources"
import { base, harness } from "./fixtures"

test("a large nested fan-out only admits bounded pending work and reports a partial limit result", async () => {
  const child = {
    ...base,
    stages: Array.from({ length: 32 }, (_, index) => ({
      id: `s${index}`,
      prompt: "Work {{item}}",
      for_each: { items: Array.from({ length: 1000 }, (_, item) => item) },
    })),
  }
  const run = harness(
    {
      ...base,
      limits: { max_agents: 3 },
      stages: Array.from({ length: 32 }, (_, index) => ({ id: `g${index}`, workflow: "child" })),
    },
    { saved: { child } },
  )
  const result = await Effect.runPromise(run.run)
  expect(run.calls).toHaveLength(3)
  expect(result.outcome).toBe("failed")
  expect(result.report).toContain("agent limit")
  expect(Math.max(...run.checkpoints.map((state) => state.nodes.length))).toBeLessThanOrEqual(4)
  expect(result.results).toHaveLength(3)
})

test("streaming projection stops pulling after an explicit source limit", () => {
  const values = [{ rank: 1 }, { rank: 2 }]
  Object.defineProperty(values, 2, {
    get: () => {
      throw new Error("unused tail was read")
    },
  })
  const output = [{ stage: "a", key: "source", value: values }]
  expect(
    WorkflowSources.project({ from: "a", limit: 2 }, output, { complete: true }).map((item) => item.value),
  ).toEqual([{ rank: 1 }, { rank: 2 }])
})

test("oversized sorting fails visibly with completed upstream results preserved", async () => {
  const values = Array.from({ length: 32_001 }, (_, rank) => ({ rank }))
  const run = harness(
    {
      ...base,
      stages: [
        { id: "a", prompt: "Produce" },
        { id: "b", prompt: "Consume", for_each: { from: "a", sort_by: "rank", limit: 1 } },
      ],
      result: { stages: ["a"] },
    },
    { launch: () => Effect.succeed({ status: "completed", output: values }) },
  )
  const result = await Effect.runPromise(run.run)
  expect(run.calls).toHaveLength(1)
  expect(result.outcome).toBe("failed")
  expect(result.report).toContain("32,000 buffered items")
  expect(result.results).toEqual([values])
})

test("new logical nodes are refused at the persistence ceiling with an explicit partial error", async () => {
  const run = harness(
    {
      ...base,
      stages: [
        { id: "a", prompt: "Produce" },
        { id: "b", prompt: "Filtered", for_each: { from: "a" }, when: { equals: "absent" } },
      ],
    },
    {
      launch: () =>
        Effect.succeed({ status: "completed", output: Array.from({ length: 32_001 }, (_, index) => index) }),
    },
  )
  const result = await Effect.runPromise(run.run)
  expect(run.calls).toHaveLength(1)
  expect(result.outcome).toBe("failed")
  expect(result.report).toContain("32,000 nodes")
  expect(result.state.nodes).toHaveLength(32_000)
})

test("checkpoint refusal stops admission and still writes an explicit partial report", async () => {
  const run = harness(base, { checkpoint: () => Effect.die(new Error("Checkpoint byte ceiling exceeded")) })
  const result = await Effect.runPromise(run.run)
  expect(run.calls).toHaveLength(0)
  expect(result.outcome).toBe("failed")
  expect(result.state.usage.launched).toBe(0)
  expect(result.report).toContain("Checkpoint byte ceiling exceeded")
  expect(result.report.split("\n")[1]).toMatch(/^Full results: /)
  expect(run.reports).toHaveLength(1)
})
