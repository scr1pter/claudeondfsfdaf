import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { lineage } from "@/session/posting"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const children = (graph: Record<string, string[]>) => (id: SessionID) =>
  Effect.succeed((graph[id] ?? []).map((child) => ({ id: SessionID.make(child) })))

describe("posting contributor lineage", () => {
  it.effect("inspects the whole bounded family and deduplicates overlapping roots", () =>
    Effect.gen(function* () {
      const result = yield* lineage(
        ["ses_root", "ses_child"],
        children({
          ses_root: ["ses_child"],
          ses_child: ["ses_grandchild"],
          ses_grandchild: ["ses_leaf"],
        }),
      )
      expect(result).toEqual(["ses_root", "ses_child", "ses_grandchild", "ses_leaf"])
      expect(yield* lineage([], children({}))).toEqual([])
    }),
  )

  it.effect("refuses descendants beyond the depth bound instead of silently truncating", () =>
    Effect.gen(function* () {
      const result = yield* lineage(
        ["ses_0"],
        children({
          ses_0: ["ses_1"],
          ses_1: ["ses_2"],
          ses_2: ["ses_3"],
          ses_3: ["ses_4"],
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(
        yield* lineage(["ses_0"], children({ ses_0: ["ses_1"], ses_1: ["ses_2"], ses_2: ["ses_3"] })),
      ).toHaveLength(4)
    }),
  )

  it.effect("refuses a root or child set beyond the session bound", () =>
    Effect.gen(function* () {
      const roots = Array.from({ length: 201 }, (_, index) => `ses_${index}`)
      expect(Exit.isFailure(yield* lineage(roots, children({})).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* lineage(["ses_root"], children({ ses_root: roots })).pipe(Effect.exit))).toBe(true)
      expect(yield* lineage(roots.slice(0, 200), children({}))).toHaveLength(200)
    }),
  )

  it.effect("a failed child lookup cannot produce an authorized empty family", () =>
    Effect.gen(function* () {
      const result = yield* lineage(["ses_root"], () => Effect.die("unreadable session store")).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  )
})
