import { expect, test } from "bun:test"
import { WorkflowLimits } from "../../src/orchestration/limits"

test("defaults and CPU clamps bound concurrency", () => {
  const limits = WorkflowLimits.resolve({}, {}, 32)
  expect(limits).toMatchObject({
    maxAgents: 100,
    concurrency: 16,
    steps: 4000,
    perAgentSteps: 60,
    minutes: 120,
    runs: 1,
  })
  expect(WorkflowLimits.resolve({}, {}, 1).concurrency).toBe(1)
  expect(WorkflowLimits.resolve({}, {}, 6).concurrency).toBe(4)
  expect(WorkflowLimits.resolve({ concurrency: 8 }, { concurrency: 3 }, 32).concurrency).toBe(3)
  expect(WorkflowLimits.resolve({ max_agents: 1000 }, { max_agents: 1000 }, 32).maxAgents).toBe(1000)
})

test("above-default plans require elevated approval", () => {
  expect(WorkflowLimits.exceeds({ steps: 4000, minutes: 120 })).toBe(false)
  expect(WorkflowLimits.exceeds({ steps: 4001 })).toBe(true)
  expect(WorkflowLimits.exceeds({ usd: 3 }, { usd: 2 })).toBe(true)
  expect(WorkflowLimits.exceeds({ per_agent_usd: 3 }, { per_agent_usd: 2 })).toBe(true)
  expect(() => WorkflowLimits.resolve({ minutes: 0 })).toThrow()
})

test("resume counters enforce every ceiling and only time or tokens require immediate abort", () => {
  const limits = WorkflowLimits.resolve({ max_agents: 2, steps: 4, usd: 3, tokens: 8, minutes: 1 }, {}, 4)
  const usage = { launched: 0, steps: 0, spentUsd: 0, tokens: 0, elapsedMs: 0 }
  expect(WorkflowLimits.check(limits, usage)).toBeUndefined()
  expect(WorkflowLimits.check(limits, { ...usage, launched: 2 })).toMatchObject({ reason: "agents", abort: false })
  expect(WorkflowLimits.check(limits, { ...usage, steps: 4 })).toMatchObject({ reason: "steps", abort: false })
  expect(WorkflowLimits.check(limits, { ...usage, spentUsd: 3 })).toMatchObject({ reason: "usd", abort: false })
  expect(WorkflowLimits.check(limits, { ...usage, tokens: 8 })).toMatchObject({ reason: "tokens", abort: true })
  expect(WorkflowLimits.check(limits, { ...usage, elapsedMs: 60000 })).toMatchObject({ reason: "minutes", abort: true })
  expect(WorkflowLimits.check(limits, { ...usage, delegatedStopped: true })?.reason).toBe("delegated")
  expect(WorkflowLimits.check(limits, { ...usage, ledgerStopped: true })?.reason).toBe("ledger")
  expect(WorkflowLimits.paused({ ...usage, waitingMs: 60000 })).toBe(true)
  expect(WorkflowLimits.paused({ ...usage, waitingMs: 59999 })).toBe(false)
})
