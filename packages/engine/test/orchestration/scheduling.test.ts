import { expect, test } from "bun:test"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { base, harness } from "./fixtures"

const settle = Effect.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Effect.yieldNow
})

test("the in-flight cap bounds actual task calls", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let active = 0
      let peak = 0
      const run = harness(
        {
          ...base,
          limits: { concurrency: 2 },
          stages: [{ id: "a", prompt: "Work", for_each: { items: [1, 2, 3, 4] } }],
        },
        {
          launch: () =>
            Effect.gen(function* () {
              active += 1
              peak = Math.max(peak, active)
              if (active === 2) yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              active -= 1
              return { status: "completed" as const, output: true }
            }),
        },
      )
      const fiber = yield* run.run.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(run.calls).toHaveLength(2)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).outcome).toBe("completed")
      expect(peak).toBe(2)
      expect(run.calls).toHaveLength(4)
    }),
  )
})

test("two exclusive writers and an owned-path writer share the root gate", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const firstRelease = yield* Deferred.make<void>()
      const secondRelease = yield* Deferred.make<void>()
      const run = harness(
        {
          ...base,
          defaults: { agent: "general" },
          stages: [
            { id: "a", prompt: "Write" },
            { id: "b", prompt: "Write" },
            { id: "c", prompt: "Write", owned_paths: ["src/c.ts"] },
          ],
        },
        {
          launch: (request) =>
            Effect.gen(function* () {
              if (request.marker.stage === "a") {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(firstRelease)
              }
              if (request.marker.stage === "b") {
                yield* Deferred.succeed(second, undefined)
                yield* Deferred.await(secondRelease)
              }
              return { status: "completed" as const, output: true }
            }),
        },
      )
      const fiber = yield* run.run.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* settle
      expect(run.calls.map((call) => call.marker.stage)).toEqual(["a"])
      yield* Deferred.succeed(firstRelease, undefined)
      yield* Deferred.await(second)
      yield* settle
      expect(run.calls.map((call) => call.marker.stage)).toEqual(["a", "b"])
      yield* Deferred.succeed(secondRelease, undefined)
      expect((yield* Fiber.join(fiber)).outcome).toBe("completed")
      expect(run.calls.map((call) => call.marker.stage)).toEqual(["a", "b", "c"])
    }),
  )
})

test("verification keep, drop and fail policies preserve their distinct outcomes", async () => {
  for (const on_fail of ["keep", "drop", "fail"] as const) {
    const run = harness(
      {
        ...base,
        stages: [
          {
            id: "a",
            prompt: "Produce",
            verify: {
              agent: "explore",
              prompt: "Verify",
              output: { schema: { type: "object" } },
              until: { path: "ok", equals: true },
              max_rounds: 1,
              on_fail,
            },
          },
        ],
      },
      {
        launch: (request) =>
          Effect.succeed({ status: "completed", output: request.marker.verifier ? { ok: false } : "result" }),
      },
    )
    const result = await Effect.runPromise(run.run)
    expect(run.calls).toHaveLength(2)
    expect(result.outcome).toBe(on_fail === "fail" ? "failed" : "completed")
    expect(result.results).toEqual(on_fail === "keep" ? ["result"] : [])
    expect(result.state.nodes[0].verified).toBe(false)
  }
})

test("on_error skip allows unrelated stages and fail stops admission", async () => {
  for (const on_error of ["skip", "fail"] as const) {
    const run = harness(
      {
        ...base,
        limits: { concurrency: 1 },
        stages: [
          { id: "a", prompt: "Fail", retries: 0, on_error },
          { id: "b", prompt: "Other" },
        ],
      },
      {
        launch: (request) =>
          Effect.succeed(
            request.marker.stage === "a"
              ? { status: "failed", error: "Expected failure" }
              : { status: "completed", output: true },
          ),
      },
    )
    const result = await Effect.runPromise(run.run)
    expect(result.outcome).toBe(on_error === "skip" ? "completed" : "failed")
    expect(run.calls).toHaveLength(on_error === "skip" ? 2 : 1)
  }
})

test("a stopped nested group does not consume or block unrelated outer work", async () => {
  const run = harness(
    {
      ...base,
      stages: [
        { id: "nested", workflow: "child" },
        { id: "outer", prompt: "Continue" },
      ],
    },
    {
      saved: { child: { ...base, limits: { max_agents: 1 } } },
    },
  )
  const result = await Effect.runPromise(run.run)
  expect(result.outcome).toBe("failed")
  expect(run.calls.filter((call) => call.marker.stage === "outer")).toHaveLength(1)
  expect(run.calls.filter((call) => call.marker.stage.startsWith("nested."))).toHaveLength(1)
})

test("sixty seconds waiting pauses both new nodes and verifier follow-ups", async () => {
  for (const verify of [false, true])
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let waiting = true
        const run = harness(
          {
            ...base,
            limits: { concurrency: 1 },
            stages: [
              {
                id: "a",
                prompt: "Work",
                ...(verify
                  ? {
                      verify: {
                        agent: "explore",
                        prompt: "Check",
                        output: { schema: { type: "object" } },
                        until: { path: "ok", equals: true },
                      },
                    }
                  : { for_each: { items: [1, 2] } }),
              },
            ],
          },
          {
            observe: () =>
              Effect.succeed({
                usage: { steps: 0, tokens: 0, spentUsd: 0 },
                waiting: waiting ? { ses_workflow_test_1: 0 } : undefined,
              }),
            launch: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return { status: "completed" as const, output: { ok: true } }
              }),
          },
        )
        const fiber = yield* run.run.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild)
        yield* Deferred.await(entered)
        yield* clock.adjust("61 seconds")
        yield* Deferred.succeed(release, undefined)
        yield* clock.adjust("1 second")
        expect(run.calls).toHaveLength(1)
        waiting = false
        yield* clock.adjust("1 second")
        expect((yield* Fiber.join(fiber)).outcome).toBe("completed")
        expect(run.calls).toHaveLength(2)
      }).pipe(Effect.scoped),
    )
})

test("token and time ceilings interrupt active tasks and preserve a partial error", async () => {
  for (const kind of ["tokens", "minutes"] as const)
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const entered = yield* Deferred.make<void>()
        let used = 0
        let interrupted = 0
        const run = harness(
          { ...base, limits: { [kind]: kind === "tokens" ? 10 : 1 }, stages: [{ id: "a", prompt: "Work" }] },
          {
            observe: () => Effect.succeed({ usage: { steps: 0, tokens: used, spentUsd: 0 } }),
            launch: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted += 1
                  }),
                ),
              ),
          },
        )
        const fiber = yield* run.run.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild)
        yield* Deferred.await(entered)
        used = 10
        yield* clock.adjust(kind === "minutes" ? "1 minute" : "50 millis")
        const result = yield* Fiber.join(fiber)
        expect(result.outcome).toBe("failed")
        expect(result.report).toContain(kind === "minutes" ? "time limit" : "token limit")
        expect(interrupted).toBe(1)
      }).pipe(Effect.scoped),
    )
})

test("progress writes are throttled and unchanged active work receives a thirty-second heartbeat", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const entered = yield* Deferred.make<void>()
      const times: number[] = []
      const run = harness(
        { ...base, stages: [{ id: "a", prompt: "Work" }] },
        {
          launch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          progress: () =>
            Clock.currentTimeMillis.pipe(
              Effect.tap((now) =>
                Effect.sync(() => {
                  times.push(now)
                }),
              ),
              Effect.asVoid,
            ),
        },
      )
      const fiber = yield* run.run.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild)
      yield* Deferred.await(entered)
      yield* clock.adjust("61 seconds")
      expect(times.length).toBeGreaterThanOrEqual(3)
      const gaps = times.slice(1).map((time, index) => time - times[index])
      expect(gaps.every((gap) => gap >= 1000 && gap <= 30_000)).toBe(true)
      expect(gaps.filter((gap) => gap === 30_000).length).toBeGreaterThanOrEqual(1)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped),
  )
})
