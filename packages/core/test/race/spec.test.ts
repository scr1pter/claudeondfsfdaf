import { expect, test } from "bun:test"
import { RaceSpec } from "../../src/race/spec"
import { WorkflowPlan } from "../../src/orchestration/plan"

const input = { prompt: "Fix the failing parser and verify it.", lanes: [{ ref: "openrouter/anthropic/claude-sonnet" }, { ref: "openrouter/openai/gpt-6" }], judge: { ref: "openrouter/google/gemini-4" } }
test("races use independent worktrees and a bounded judge after every lane", () => {
  const spec = RaceSpec.build(input)
  const plan = WorkflowPlan.build(spec, { agents: [{ name: "general", allowed: true, writes: true, asks: [] }, { name: "review", allowed: true, writes: false, asks: [] }], cpus: 8, source: "owner", modelAllowed: () => true })
  expect(plan.ok).toBe(true)
  expect(spec.stages.slice(0, 2).map((stage) => "isolation" in stage && stage.isolation)).toEqual(["worktree", "worktree"])
  expect(spec.stages.at(-1)).toMatchObject({ agent: "review", after: ["lane_1", "lane_2"] })
  expect(spec.limits).toMatchObject({ max_agents: 3, steps: 90, minutes: 30 })
  expect(JSON.stringify(spec)).not.toContain("merge automatically")
})
test("duplicate labs, unrecognized labs and unbounded requests are refused before any work", () => {
  expect(() => RaceSpec.build({ ...input, judge: { ref: "openrouter/anthropic/claude-opus" } })).toThrow("unused lab")
  expect(() => RaceSpec.build({ ...input, lanes: [{ ref: "lmstudio/unknown" }, input.lanes[1]!] })).toThrow("know the lab")
  expect(() => RaceSpec.build({ ...input, steps: 501 })).toThrow("500")
  expect(() => RaceSpec.build({ ...input, prompt: "" })).toThrow("Describe")
})
