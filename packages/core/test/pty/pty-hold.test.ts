import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap, RcMap } from "effect"
import { TestClock } from "effect/testing"
import { Location } from "@vectordevai/core/location"
import { Pty } from "@vectordevai/core/pty"
import { PtyHold } from "@vectordevai/core/pty/hold"
import { PtyID } from "@vectordevai/core/pty/schema"
import { AbsolutePath } from "@vectordevai/core/schema"
import { it } from "../lib/effect"

// A location map like core's (location-services.ts): idle services end after their time to live. Its terminal service
// is a fake that records each watch, so a test can end the terminal.
const fixture = Effect.gen(function* () {
  const ends: ((event: { exitCode?: number }) => void)[] = []
  const state = { built: 0, ended: 0 }
  const map = yield* LayerMap.make(
    (_: Location.Ref) =>
      Layer.effect(
        Pty.Service,
        Effect.acquireRelease(
          Effect.sync(() => {
            state.built++
            return Pty.Service.of({
              attach: (_id: PtyID, input: Pty.AttachInput) =>
                Effect.sync(() => {
                  ends.push(input.onEnd)
                  return { replay: "", cursor: 0, write: () => {}, activate: () => {}, detach: () => {} }
                }),
            } as unknown as Pty.Interface)
          }),
          () => Effect.sync(() => void state.ended++),
        ),
      ),
    { idleTimeToLive: "60 minutes" },
  )
  const ref = Location.Ref.make({ directory: AbsolutePath.make("/tmp/vector-pty-hold") })
  return { map, ref, ends, state }
})

describe("PtyHold", () => {
  it.effect("a running terminal keeps its location's services past their idle time, until it ends", () =>
    Effect.gen(function* () {
      const { map, ref, ends, state } = yield* fixture
      const held = yield* PtyHold.whileRunning(map as never, ref, PtyID.make("pty_held")).pipe(
        Effect.provide(map.get(ref)),
      )
      expect(held).toBe(true)
      yield* TestClock.adjust("3 hours")
      expect(yield* RcMap.has(map.rcMap, ref)).toBe(true)
      expect(state).toEqual({ built: 1, ended: 0 })
      // The program exits: the hold is let go, and the services end after their idle time, as before.
      ends[0]({ exitCode: 0 })
      ends[0]({ exitCode: 0 })
      yield* Effect.yieldNow
      yield* TestClock.adjust("61 minutes")
      expect(yield* RcMap.has(map.rcMap, ref)).toBe(false)
      expect(state).toEqual({ built: 1, ended: 1 })
    }),
  )

  it.effect("a location with no running terminal ends after its idle time", () =>
    Effect.gen(function* () {
      const { map, ref, state } = yield* fixture
      yield* Pty.Service.pipe(Effect.provide(map.get(ref)))
      yield* TestClock.adjust("61 minutes")
      expect(yield* RcMap.has(map.rcMap, ref)).toBe(false)
      expect(state.ended).toBe(1)
    }),
  )
})
