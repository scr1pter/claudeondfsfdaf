import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Global } from "@vectordevai/core/global"
import { AppProcess } from "@vectordevai/core/process"
import { Hash } from "@vectordevai/core/util/hash"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Snapshot } from "@/snapshot"
import { TestConfig } from "../fixture/config"
import { taskDirectory } from "../fixture/task-directory"
import { testEffect } from "../lib/effect"

const replacements = [
  [
    Config.node,
    TestConfig.layer({
      get: () => Effect.succeed({ snapshot: true, sizing: { subagents: { isolation: { lsp: true, mcp: true } } } }),
    }),
  ],
] as const satisfies LayerNode.Replacements
const disabled = testEffect(
  LayerNode.compile(LayerNode.group([Snapshot.node, CrossSpawnSpawner.node]), [
    ...replacements,
    [
      AppProcess.node,
      Layer.mock(AppProcess.Service)({
        run: () => Effect.die("Snapshot must not start a process in a task workspace"),
      }),
    ],
  ]),
)
const ordinary = testEffect(LayerNode.compile(LayerNode.group([Snapshot.node, CrossSpawnSpawner.node]), replacements))

for (const mode of ["worktree", "copy"] as const) {
  disabled.instance(
    `registered ${mode} tasks never track snapshots, even with snapshot and other isolation opt-ins enabled`,
    () =>
      Effect.gen(function* () {
        const task = yield* taskDirectory(mode)
        const snapshot = yield* Snapshot.Service
        yield* Effect.gen(function* () {
          yield* snapshot.init()
          expect(yield* snapshot.track()).toBeUndefined()
          yield* snapshot.cleanup()
          const shadow = path.join(
            Global.Path.data,
            "snapshot",
            task.context.project.id,
            Hash.fast(task.context.worktree),
          )
          expect(
            yield* Effect.promise(() =>
              fs.access(shadow).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(Effect.provideService(InstanceRef, task.context))
      }),
    { git: true },
  )
}

ordinary.instance(
  "a reserved-looking directory without a registry still tracks snapshots",
  () =>
    Effect.gen(function* () {
      const task = yield* taskDirectory("worktree", false)
      const snapshot = yield* Snapshot.Service
      yield* Effect.promise(() => fs.writeFile(path.join(task.directory, "fixture.txt"), "tracked"))
      yield* Effect.gen(function* () {
        yield* snapshot.init()
        expect(yield* snapshot.track()).toMatch(/^[a-f0-9]{40}$/)
      }).pipe(Effect.provideService(InstanceRef, task.context))
    }),
  { git: true },
)
