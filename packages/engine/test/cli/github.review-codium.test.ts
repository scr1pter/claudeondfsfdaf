import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { GithubBundle } from "../../src/cli/cmd/github.bundle"
import { withCodiumReview, redactCodiumReviewText } from "../../src/cli/cmd/github.review-codium"
import { verifyGithubRun } from "../../src/cli/cmd/github.cloud"
import { cloudRecorder, holder } from "./github.agent-fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.effect("a Codium review starts with verified authority, stops on heartbeat and settles its partial outcome", () =>
  Effect.gen(function* () {
    const cloud = cloudRecorder({
      heartbeat: (body) => ({
        ok: true,
        stop: typeof body === "object" && body !== null && "state" in body && body.state === "running",
      }),
    })
    const credentials = yield* Effect.promise(() => holder("codium", false))
    expect(credentials.runToken()).toBeUndefined()
    expect(yield* Effect.promise(() => verifyGithubRun(credentials, cloud.services))).toBe(true)
    const ready = yield* Deferred.make<void>()
    const done = yield* Effect.forkChild(
      withCodiumReview(
        (control) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined)
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  if (control.signal.aborted) resolve()
                  else control.signal.addEventListener("abort", () => resolve(), { once: true })
                }),
            )
            expect(control.stopped()).toEqual(GithubBundle.DEADLINE)
            control.outcome("draft")
            return "partial review"
          }),
        {
          env: { VECTOR_RUN_DEADLINE: String(Date.now() + 600_000) },
          credentials,
          services: cloud.services,
        },
      ),
    )
    yield* Deferred.await(ready)
    yield* TestClock.adjust(60_000)
    expect(yield* Fiber.join(done)).toBe("partial review")
    expect(cloud.requests.map((request) => request.path)).toEqual([
      "/api/cloud-agents/heartbeat",
      "/api/cloud-agents/heartbeat",
      "/api/cloud-agents/settle",
    ])
    expect(cloud.requests.at(-1)?.body).toEqual({ outcome: "draft" })
    yield* TestClock.adjust(120_000)
    expect(cloud.requests).toHaveLength(3)
  }),
)

it.effect("a deadline already inside the stop margin denies further model work and still settles", () =>
  Effect.gen(function* () {
    const cloud = cloudRecorder()
    const credentials = yield* Effect.promise(() => holder("codium"))
    const now = Date.now()
    const result = yield* withCodiumReview(
      (control) =>
        Effect.sync(() => {
          expect(control.signal.aborted).toBe(true)
          expect(control.stopped()).toEqual(GithubBundle.DEADLINE)
          control.outcome("draft")
          return 0
        }),
      { env: { VECTOR_RUN_DEADLINE: String(now + 1) }, credentials, services: cloud.services, now: () => now },
    )
    expect(result).toBe(0)
    expect(cloud.requests).toHaveLength(1)
    expect(cloud.requests[0]?.body).toEqual({ outcome: "draft" })
  }),
)

it.effect("an unauthorized holder or missing deadline cannot start a Codium review or cloud lifecycle", () =>
  Effect.gen(function* () {
    const cloud = cloudRecorder()
    for (const authorized of [false, true]) {
      const credentials = yield* Effect.promise(() => holder("codium", authorized))
      let ran = false
      const exit = yield* Effect.exit(
        withCodiumReview(() => Effect.sync(() => (ran = true)), {
          env: authorized ? {} : { VECTOR_RUN_DEADLINE: String(Date.now() + 600_000) },
          credentials,
          services: cloud.services,
        }),
      )
      expect(exit._tag).toBe("Failure")
      expect(ran).toBe(false)
    }
    expect(cloud.requests).toEqual([])
  }),
)

test("Codium review output withholds billing state, plan names, usage percentages and prices", () => {
  const input = "vector-100 Max plan payment_failed past_due dispute fraud closing 72.5% $99.00 €10 £12"
  const output = redactCodiumReviewText(input)
  expect(output).not.toMatch(/vector-(?:10|50|100|200)|Max plan|payment|past_due|dispute|fraud|closing|\d%|[$€£]/i)
  expect(output).toContain("Codium")
  expect(redactCodiumReviewText("Codium · 3 turns")).toBe("Codium · 3 turns")
})
