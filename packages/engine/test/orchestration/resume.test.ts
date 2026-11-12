import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import type { WorkflowRunner } from "@/orchestration/runner"
import { base, harness } from "./fixtures"

const verified = {
  ...base,
  stages: [
    {
      id: "a",
      prompt: "Produce",
      verify: {
        agent: "explore",
        prompt: "Verify {{output}}",
        output: { schema: { type: "object" } },
        until: { path: "approved", equals: true },
        max_rounds: 2,
      },
    },
  ],
}

test("completed matching nodes reuse their outputs and preserve all spend counters", async () => {
  const first = await Effect.runPromise(harness(base).run)
  const second = harness(base, { seed: first.state })
  const resumed = await Effect.runPromise(second.run)
  expect(second.calls).toHaveLength(0)
  expect(resumed.results).toEqual(first.results)
  expect(resumed.state.usage).toMatchObject({ launched: 2, steps: 2, tokens: 20, spentUsd: 0.02 })
})

test("raising an agent limit resumes unadmitted nodes instead of retaining a permanent skip", async () => {
  const first = await Effect.runPromise(harness({ ...base, limits: { max_agents: 1 } }).run)
  expect(first.outcome).toBe("failed")
  const second = harness({ ...base, limits: { max_agents: 2 } }, { seed: first.state })
  const resumed = await Effect.runPromise(second.run)
  expect(second.calls).toHaveLength(1)
  expect(resumed.outcome).toBe("completed")
  expect(resumed.state.usage).toMatchObject({ launched: 2, steps: 2, tokens: 20, spentUsd: 0.02 })
})

test("interrupted agents continue in their checkpointed sessions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const first = harness(
        { ...base, stages: [{ id: "a", prompt: "Work" }] },
        { launch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
      )
      const fiber = yield* first.run.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const child = first.checkpoints.findLast((state) => state.nodes[0]?.sessionID)?.nodes[0].sessionID
      expect(child).toBeDefined()
      yield* Fiber.interrupt(fiber)
      const second = harness({ ...base, stages: [{ id: "a", prompt: "Work" }] }, { seed: first.checkpoints.at(-1)! })
      const resumed = yield* second.run
      expect(second.calls).toHaveLength(1)
      expect(second.calls[0].sessionID).toBe(child)
      expect(resumed.state.usage.launched).toBe(1)
    }),
  )
})

for (const boundary of ["producer", "verifier"] as const)
  test(`restart after ${boundary} completion consumes its checkpoint instead of calling it again`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        let blocked = false
        const checkpoint = (state: WorkflowRunner.State) =>
          Effect.gen(function* () {
            const node = state.nodes[0]
            const matches =
              boundary === "producer"
                ? node?.execution === "verifier" && !node.verifierID
                : node?.pendingResult?.verifier === true
            if (blocked || !matches) return
            blocked = true
            yield* Deferred.succeed(reached, undefined)
            yield* Effect.never
          })
        const first = harness(verified, {
          checkpoint,
          launch: (request) =>
            Effect.succeed({
              status: "completed",
              output: request.marker.verifier ? { approved: true } : { changed: true },
            }),
        })
        const fiber = yield* first.run.pipe(Effect.forkChild)
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(fiber)
        const second = harness(verified, {
          seed: first.checkpoints.at(-1)!,
          launch: () => Effect.succeed({ status: "completed", output: { approved: true } }),
        })
        const resumed = yield* second.run
        expect(second.calls).toHaveLength(boundary === "producer" ? 1 : 0)
        if (second.calls.length) expect(second.calls[0].marker.verifier).toBe(true)
        expect(resumed.outcome).toBe("completed")
        expect(resumed.state.nodes[0].verified).toBe(true)
      }),
    )
  })

test("outputs_file is available before downstream launch and keeps its path across resume", async () => {
  const spec = {
    ...base,
    stages: [
      { id: "a", prompt: "Produce" },
      { id: "b", prompt: "Read {{stages.a.outputs_file}}" },
    ],
  }
  const firstRun = harness(spec)
  const first = await Effect.runPromise(firstRun.run)
  expect(first.outcome).toBe("completed")
  expect(firstRun.calls[1].prompt).toContain(first.state.files!.a.path)
  const second = harness(spec, { seed: first.state })
  const resumed = await Effect.runPromise(second.run)
  expect(second.calls).toHaveLength(0)
  expect(resumed.state.files!.a).toEqual(first.state.files!.a)
})

test("settlement order survives resume for batches and last-output templates", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const settled = yield* Deferred.make<void>()
      const spec = {
        ...base,
        stages: [
          ...base.stages,
          { id: "b", prompt: "Read {{item}} {{stages.a.output}}", for_each: { from: "a", batch: 2 } },
        ],
      }
      const first = harness(spec, {
        checkpoint: (state) =>
          state.nodes.some((node) => node.stage === "a" && node.itemKey === "1" && node.status === "completed")
            ? Deferred.succeed(settled, undefined).pipe(Effect.asVoid)
            : Effect.void,
        launch: (request) =>
          Effect.gen(function* () {
            if (request.marker.stage === "a" && request.marker.item === "0") yield* Deferred.await(release)
            return { status: "completed" as const, output: { item: request.marker.item } }
          }),
      })
      const fiber = yield* first.run.pipe(Effect.forkChild)
      yield* Deferred.await(settled)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      const second = harness(spec, { seed: result.state })
      const resumed = yield* second.run
      expect(second.calls).toHaveLength(0)
      expect(resumed.results).toEqual(result.results)
    }),
  )
})

test("editing a stage reruns it and its descendants while independent completed work stays reusable", async () => {
  const spec = {
    ...base,
    stages: [
      { id: "a", prompt: "First" },
      { id: "b", prompt: "Read {{stages.a.output}}" },
      { id: "c", prompt: "Independent" },
    ],
  }
  const first = await Effect.runPromise(harness(spec).run)
  const second = harness(
    { ...spec, stages: [{ id: "a", prompt: "Changed" }, ...spec.stages.slice(1)] },
    { seed: first.state },
  )
  const resumed = await Effect.runPromise(second.run)
  expect(second.calls.map((call) => call.marker.stage)).toEqual(["a", "b"])
  expect(resumed.state.usage.launched).toBe(5)
})

test("retained failures remain errors and cancelled children are not automatically resumed", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const spec = { ...base, stages: [{ id: "a", prompt: "Work", retries: 0 }] }
    const first = await Effect.runPromise(
      harness(spec, { launch: () => Effect.succeed({ status, error: "Stopped" }) }).run,
    )
    const second = harness(spec, { seed: first.state, retryFailed: false })
    const resumed = await Effect.runPromise(second.run)
    expect(second.calls).toHaveLength(0)
    expect(resumed.outcome).toBe("failed")
  }
})

test("default resume reruns a failed final node in its own session and carries its earlier usage", async () => {
  const spec = { ...base, stages: [{ id: "a", prompt: "Work", retries: 0 }] }
  const first = await Effect.runPromise(
    harness(spec, { launch: () => Effect.succeed({ status: "failed", error: "Broken" }) }).run,
  )
  expect(first.outcome).toBe("failed")
  const failed = first.state.nodes[0]
  expect(failed).toMatchObject({ status: "failed", final: true })
  // retry_failed defaults to true: exactly the failed node launches again, in the session it already has.
  const second = harness(spec, { seed: first.state })
  const resumed = await Effect.runPromise(second.run)
  expect(second.calls).toHaveLength(1)
  expect(second.calls[0].sessionID).toBe(failed.sessionID!)
  expect(resumed.outcome).toBe("completed")
  expect(resumed.state.nodes[0]).toMatchObject({ status: "completed", final: true })
  expect(resumed.state.usage).toMatchObject({ launched: 1, steps: 2, tokens: 20, spentUsd: 0.02 })
})
