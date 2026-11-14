import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ConnectReviewService } from "@/connect/review-service"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

// These test only the private capability, never a fake production session or model.
const helper = {
  prompt: () => Effect.die(new Error("The capability test must not prompt")),
  cancel: () => Effect.void,
}

describe("qualified review service authority", () => {
  it.live("captures read authority before caller arrays can change and expires with its run", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const patterns = ["private.txt"]
      let active = true
      const capability = ConnectReviewService.qualify({
        helper,
        active: () => active,
        readRoot: root,
        readDenies: patterns,
      })
      patterns[0] = "other.txt"
      const scope = yield* ConnectReviewService.scope(capability)
      expect(scope.readRoot).toBe(root)
      expect(scope.readDenies).toContain(path.join(root, "private.txt").replaceAll("\\", "/"))
      expect(scope.readDenies).not.toContain(path.join(root, "other.txt").replaceAll("\\", "/"))
      expect(Object.isFrozen(scope.readDenies)).toBe(true)
      const copied = yield* Effect.exit(ConnectReviewService.scope({ ...capability }))
      expect(Exit.isFailure(copied)).toBe(true)
      const serialized = JSON.parse(JSON.stringify(capability)) as ConnectReviewService.Capability
      expect(Exit.isFailure(yield* Effect.exit(ConnectReviewService.scope(serialized)))).toBe(true)
      active = false
      expect(Exit.isFailure(yield* Effect.exit(ConnectReviewService.scope(capability)))).toBe(true)
    }),
  )

  it.live("invalid read authority never qualifies a service", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      for (const readDenies of [[""], ["x\0y"], Array.from({ length: 1_000 }, () => "*")]) {
        const capability = ConnectReviewService.qualify({ helper, active: () => true, readRoot: root, readDenies })
        expect(Exit.isFailure(yield* Effect.exit(ConnectReviewService.scope(capability)))).toBe(true)
      }
    }),
  )
})
