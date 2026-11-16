import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { withRunHeartbeat } from "../../src/cli/cmd/github.lifecycle"
import type { Services } from "../../src/cli/cmd/github.cloud"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
it.effect("run heartbeats stop with their scope and settle the final outcome", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const stopped = Promise.withResolvers<void>()
    const calls: { path: string; body: unknown }[] = []
    let beats = 0
    const services: Services = {
      oidc: async () => {
        throw new Error("no OIDC")
      },
      mask: () => {},
      now: Date.now,
      monotonic: () => performance.now(),
      wait: async () => {},
      notice: () => {},
      request: async (url, init) => {
        calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) })
        expect(init.redirect).toBe("error")
        return Response.json(url.endsWith("heartbeat") ? { ok: true, stop: ++beats === 2 } : { ok: true })
      },
    }
    const task = Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.promise(() => stopped.promise)))
    const fiber = yield* Effect.forkChild(
      withRunHeartbeat(task, {
        credentials: { runToken: () => "vrt_e30.c2ln" },
        services,
        onStop: () => stopped.resolve(),
        outcome: () => "draft",
      }),
    )
    yield* Deferred.await(ready)
    yield* TestClock.adjust(60_000)
    expect(beats).toBe(1)
    yield* TestClock.adjust(60_000)
    yield* Fiber.join(fiber)
    expect(beats).toBe(2)
    expect(calls.at(-1)).toEqual({ path: "/api/cloud-agents/settle", body: { outcome: "draft" } })
    yield* TestClock.adjust(120_000)
    expect(calls).toHaveLength(3)
  }),
)

it.effect("own-key execution starts no cloud heartbeat or settlement", () =>
  Effect.gen(function* () {
    let calls = 0
    const services: Services = {
      oidc: async () => "unused",
      mask: () => {},
      now: Date.now,
      monotonic: () => performance.now(),
      wait: async () => {},
      notice: () => {},
      request: async () => {
        calls++
        throw new Error("unexpected cloud request")
      },
    }
    const result = yield* withRunHeartbeat(Effect.succeed("own-key"), {
      credentials: { runToken: () => undefined },
      services,
      onStop: () => {},
      outcome: () => "changes",
    })
    expect(result).toBe("own-key")
    yield* TestClock.adjust(120_000)
    expect(calls).toBe(0)
  }),
)
