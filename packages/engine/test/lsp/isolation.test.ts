import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { TestConfig } from "../fixture/config"
import { taskDirectory } from "../fixture/task-directory"
import { testEffect } from "../lib/effect"

const fakeServer = path.resolve(import.meta.dir, "../fixture/lsp/fake-lsp-server.js")
const launch =
  'require("node:fs").writeFileSync(process.argv[1], "started"); import(require("node:url").pathToFileURL(process.argv[2]).href)'
const layer = (optIn = false) =>
  LayerNode.compile(LayerNode.group([LSP.node, CrossSpawnSpawner.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableLspDownload: true })],
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.gen(function* () {
            const directory = yield* InstanceState.directory
            return {
              lsp: {
                fixture: {
                  command: ["node", "-e", launch, path.join(directory, "lsp-started"), fakeServer],
                  extensions: [".isolated"],
                },
              },
              ...(optIn ? { sizing: { subagents: { isolation: { lsp: true } } } } : {}),
            }
          }),
        trust: () =>
          Effect.succeed({ workspace: "", fingerprint: "fixture", trusted: true, ignored: false, settings: true }),
      }),
    ],
  ])

const disabled = testEffect(layer())
const enabled = testEffect(layer(true))

for (const mode of ["worktree", "copy"] as const) {
  disabled.instance(
    `registered ${mode} task directories never start LSP by default`,
    () =>
      Effect.gen(function* () {
        const task = yield* taskDirectory(mode)
        const lsp = yield* LSP.Service
        const file = path.join(task.directory, "file.isolated")
        yield* Effect.promise(() => fs.writeFile(file, "fixture"))
        yield* Effect.gen(function* () {
          yield* lsp.init()
          expect(yield* lsp.hasClients(file)).toBe(false)
          yield* lsp.touchFile(file)
          expect(yield* lsp.status()).toEqual([])
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(task.directory, "lsp-started")).then(
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

enabled.instance(
  "an explicit user isolation.lsp opt-in starts the configured server",
  () =>
    Effect.gen(function* () {
      const task = yield* taskDirectory()
      const lsp = yield* LSP.Service
      const file = path.join(task.directory, "file.isolated")
      yield* Effect.promise(() => fs.writeFile(file, "fixture"))
      yield* Effect.gen(function* () {
        yield* lsp.init()
        expect(yield* lsp.hasClients(file)).toBe(true)
        yield* lsp.touchFile(file)
        expect((yield* lsp.status()).map((item) => item.id)).toContain("fixture")
        expect(yield* Effect.promise(() => fs.readFile(path.join(task.directory, "lsp-started"), "utf8"))).toBe(
          "started",
        )
      }).pipe(Effect.provideService(InstanceRef, task.context))
    }),
  { git: true },
)

disabled.instance(
  "a reserved-looking directory without a registry keeps ordinary LSP behavior",
  () =>
    Effect.gen(function* () {
      const task = yield* taskDirectory("worktree", false)
      const lsp = yield* LSP.Service
      const file = path.join(task.directory, "file.isolated")
      yield* Effect.promise(() => fs.writeFile(file, "fixture"))
      yield* Effect.gen(function* () {
        yield* lsp.touchFile(file)
        expect((yield* lsp.status()).map((item) => item.id)).toContain("fixture")
      }).pipe(Effect.provideService(InstanceRef, task.context))
    }),
  { git: true },
)
