import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ]),
)

const withEnv = <A, E, R>(name: string, value: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

it.instance(
  "inherits captured project TUI input omitted from loaded prompt files and refuses a changed child input",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      const input = path.join(test.directory, "ui", "custom-tui.json")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(input))
        await fs.writeFile(input, JSON.stringify({ theme: "dark" }))
        await WorkspaceTrust.approve(Global.Path.state, await WorkspaceTrust.snapshot(test.directory, [input]))
      })
      yield* withEnv(
        "VECTOR_TUI_CONFIG",
        input,
        Effect.gen(function* () {
          expect((yield* config.trust()).trusted).toBe(true)
          expect((yield* config.loaded()).files).not.toContain(input)
          yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
          expect(yield* config.inheritTrust(child)).toBe(true)
          const copiedInput = path.join(child, "ui", "custom-tui.json")
          const approved = yield* Effect.promise(() => WorkspaceTrust.snapshot(child, [copiedInput]))
          expect((yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, approved))).trusted).toBe(true)

          yield* Effect.promise(() => fs.writeFile(copiedInput, JSON.stringify({ theme: "light" })))
          expect(yield* config.inheritTrust(child)).toBe(false)
          const changed = yield* Effect.promise(() => WorkspaceTrust.snapshot(child, [copiedInput]))
          expect((yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, changed))).trusted).toBe(false)
        }),
      )
    }),
  { git: true, config: { model: "fixture/model" } },
)

it.instance(
  "refuses an untrusted source even when the child has equal settings",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      yield* config.get()
      yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
      expect(yield* config.inheritTrust(child)).toBe(false)
    }),
  { git: true, config: { model: "fixture/model" } },
)

it.instance(
  "rechecks parent approval after the Config state has already loaded",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      expect((yield* config.trust()).trusted).toBe(true)
      yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
      yield* Effect.promise(() => WorkspaceTrust.forget(Global.Path.state, test.directory))
      expect(yield* config.inheritTrust(child)).toBe(false)
    }),
  { git: true, trusted: true, config: { model: "fixture/model" } },
)

it.instance(
  "pure mode cannot inherit a previously stored parent approval",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
      yield* withEnv(
        "VECTOR_PURE",
        "true",
        Effect.gen(function* () {
          yield* config.get()
          expect(yield* config.inheritTrust(child)).toBe(false)
        }),
      )
    }),
  { git: true, trusted: true, config: { model: "fixture/model" } },
)

it.instance(
  "pure mode also refuses inheritance after trusted Config state was cached",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      expect((yield* config.trust()).trusted).toBe(true)
      yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
      expect(yield* withEnv("VECTOR_PURE", "true", config.inheritTrust(child))).toBe(false)
    }),
  { git: true, trusted: true, config: { model: "fixture/model" } },
)

it.instance(
  "child capture failures return false without approving incomplete inputs",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const child = yield* tmpdirScoped()
      expect((yield* config.trust()).trusted).toBe(true)
      yield* Effect.promise(() => fs.cp(test.directory, child, { recursive: true }))
      // The trust capture budget refuses this file before any executable project config can load.
      yield* Effect.promise(() => fs.writeFile(path.join(child, "tui.json"), Buffer.alloc(8 * 1024 * 1024 + 1)))
      expect(yield* config.inheritTrust(child)).toBe(false)
    }),
  { git: true, trusted: true, config: { model: "fixture/model" } },
)
