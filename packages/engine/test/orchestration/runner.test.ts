import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { base, harness } from "./fixtures"

test("fans out, checkpoints child identities before completion and writes a bounded final report", async () => {
  const run = harness(base)
  const result = await Effect.runPromise(run.run)
  expect(result.outcome).toBe("completed")
  expect(run.calls).toHaveLength(2)
  expect(result.state.usage).toMatchObject({ launched: 2, steps: 2, tokens: 20, spentUsd: 0.02 })
  expect(run.checkpoints.some((state) => state.nodes.some((node) => node.sessionID && !node.final))).toBe(true)
  expect(run.reports).toHaveLength(1)
  expect(result.report.split("\n")[1]).toMatch(/^Full results: /)
})

test("streams settled items before their source stage ends and respects after barriers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const child = yield* Deferred.make<void>()
      const run = harness(
        {
          ...base,
          stages: [
            { id: "a", prompt: "Do {{item}}", for_each: { items: [1, 2] } },
            { id: "b", prompt: "Read {{item}}", for_each: { from: "a" } },
            { id: "c", prompt: "Summarize {{stages.a.outputs}}", after: ["a"] },
          ],
        },
        {
          launch: (request) =>
            Effect.gen(function* () {
              if (request.marker.stage === "a" && request.marker.item === "1") yield* Deferred.await(release)
              if (request.marker.stage === "b") yield* Deferred.succeed(child, undefined)
              return { status: "completed" as const, output: { stage: request.marker.stage } }
            }),
        },
      )
      const fiber = yield* run.run.pipe(Effect.forkChild)
      yield* Deferred.await(child)
      expect(run.calls.some((call) => call.marker.stage === "c")).toBe(false)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.outcome).toBe("completed")
      expect(run.calls.filter((call) => call.marker.stage === "b")).toHaveLength(2)
      expect(run.calls.filter((call) => call.marker.stage === "c")).toHaveLength(1)
    }),
  )
})

test("verifies, repairs the same producer and resumes the same verifier", async () => {
  let checks = 0
  const run = harness(
    {
      ...base,
      stages: [
        {
          id: "a",
          prompt: "Work",
          verify: {
            agent: "explore",
            prompt: "Check {{output}} at {{round}}",
            output: { schema: { type: "object" } },
            until: { path: "approved", equals: true },
            max_rounds: 2,
          },
        },
      ],
    },
    {
      launch: (request) =>
        Effect.succeed({
          status: "completed",
          output: request.marker.verifier ? { approved: ++checks > 1 } : { changed: true },
        }),
    },
  )
  const result = await Effect.runPromise(run.run)
  expect(result.outcome).toBe("completed")
  expect(run.calls).toHaveLength(4)
  expect(run.calls[2].sessionID).toBeDefined()
  expect(run.calls[3].sessionID).toBeDefined()
  expect(result.state.usage.launched).toBe(2)
  expect(result.state.nodes[0].verified).toBe(true)
  expect(run.calls[2].prompt).toContain("Verifier feedback")
})

test("a user-stopped producer is never retried or repaired", async () => {
  const run = harness(
    { ...base, stages: [{ id: "a", prompt: "Work", retries: 2 }] },
    {
      launch: () => Effect.succeed({ status: "cancelled", error: "Stopped by user" }),
    },
  )
  const result = await Effect.runPromise(run.run)
  expect(run.calls).toHaveLength(1)
  expect(result.outcome).toBe("failed")
  expect(result.state.nodes[0].status).toBe("cancelled")
})

test("parent and nested group agent limits return partial errors without starting extra work", async () => {
  for (const nested of [false, true]) {
    const child = { ...base, limits: { max_agents: 1 } }
    const run = harness(nested ? { ...base, stages: [{ id: "nested", workflow: "child" }] } : child, {
      saved: { child },
    })
    const result = await Effect.runPromise(run.run)
    expect(result.outcome).toBe("failed")
    expect(run.calls).toHaveLength(1)
    expect(result.state.nodes.filter((node) => node.status === "skipped")).toHaveLength(1)
  }
})

test("stage if, item when, projection and nested result selection affect actual launches", async () => {
  const child = {
    ...base,
    stages: [
      { id: "a", prompt: "Work" },
      { id: "ignored", prompt: "Other" },
    ],
    result: { stages: ["a"] },
  }
  const run = harness(
    {
      ...base,
      stages: [
        { id: "nested", workflow: "child" },
        { id: "each", prompt: "{{item}}", for_each: { from: "nested" } },
        { id: "conditional", prompt: "Run", if: { path: "stages.nested.done", gt: 0 } },
        { id: "items", prompt: "{{item}}", for_each: { items: [1, 2] }, when: { equals: 2 } },
      ],
    },
    { saved: { child } },
  )
  const result = await Effect.runPromise(run.run)
  expect(result.outcome).toBe("completed")
  expect(run.calls.filter((call) => call.marker.stage === "each")).toHaveLength(1)
  expect(run.calls.filter((call) => call.marker.stage === "conditional")).toHaveLength(1)
  expect(run.calls.filter((call) => call.marker.stage === "items")).toHaveLength(1)
})
