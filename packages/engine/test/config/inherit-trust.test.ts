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
import { ConfigPaths } from "@/config/paths"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const configLayer = (experimentalConnect: boolean) =>
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect })],
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ])
const it = testEffect(configLayer(true))
const off = testEffect(configLayer(false))

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

const providerConfig = { model: "fixture/model", provider: { fixture: { models: { model: { name: "Fixture" } } } } }
const linkType = process.platform === "win32" ? "junction" : "dir"

off.instance(
  "Connect off preserves already trusted ordinary settings and consistent directory aliases",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const parent = yield* InstanceRef
      if (!parent) throw new Error("Missing parent instance")
      expect((yield* config.trust()).trusted).toBe(true)
      expect((yield* config.get()).provider?.fixture?.models?.model).toEqual({ name: "Fixture" })
      const outside = yield* tmpdirScoped()
      const alias = path.join(outside, "project")
      yield* Effect.promise(() => fs.symlink(test.directory, alias, linkType))
      const context = { ...parent, directory: alias, worktree: alias }
      expect((yield* config.trust().pipe(Effect.provideService(InstanceRef, context))).trusted).toBe(true)
      expect(
        (yield* config.get().pipe(Effect.provideService(InstanceRef, context))).provider?.fixture?.models?.model,
      ).toEqual({ name: "Fixture" })
    }),
  { git: true, trusted: true, config: providerConfig },
)

it.instance("an unavailable canonical scope refuses project trust without crashing the actual Config service", () =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const parent = yield* InstanceRef
    if (!parent) throw new Error("Missing parent instance")
    const target = yield* tmpdirScoped()
    const outside = yield* tmpdirScoped()
    const file = path.join(target, "vector.json")
    yield* Effect.promise(() => fs.writeFile(file, JSON.stringify(providerConfig)))
    const context = { ...parent, directory: target, worktree: outside }
    expect((yield* config.trust().pipe(Effect.provideService(InstanceRef, context))).trusted).toBe(false)
    expect((yield* config.get().pipe(Effect.provideService(InstanceRef, context))).provider?.fixture).toBeUndefined()
    expect(yield* config.trustedPath(file).pipe(Effect.provideService(InstanceRef, context))).toBeUndefined()
  }),
)

it.instance(
  "mixed real-directory and aliased-worktree spellings load only the exact inherited project bytes",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const store = yield* InstanceStore.Service
      const parent = yield* InstanceRef
      if (!parent) throw new Error("Missing parent instance")
      const target = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const alias = path.join(outside, "checkout")
      expect((yield* config.trust()).trusted).toBe(true)
      yield* Effect.promise(async () => {
        await fs.cp(test.directory, target, { recursive: true })
        await fs.symlink(target, alias, linkType)
      })
      expect(yield* config.inheritTrust(alias)).toBe(true)
      const child = yield* store.load({ directory: target, worktree: alias, project: parent.project })
      yield* Effect.addFinalizer(() => store.dispose(child))
      expect(child.directory).toBe(target)
      expect(child.worktree).toBe(alias)
      expect((yield* config.trust().pipe(Effect.provideService(InstanceRef, child))).trusted).toBe(true)
      expect(
        (yield* config.get().pipe(Effect.provideService(InstanceRef, child))).provider?.fixture?.models?.model,
      ).toEqual({
        name: "Fixture",
      })
      const [approved, inherited] = yield* Effect.promise(() =>
        Promise.all([
          WorkspaceTrust.snapshot(test.directory, [path.join(test.directory, "vector.json")]),
          WorkspaceTrust.snapshot(target, [path.join(target, "vector.json")]),
        ]),
      )
      expect(WorkspaceTrust.contentKey(inherited)).toBe(WorkspaceTrust.contentKey(approved))
      expect((yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, inherited))).trusted).toBe(true)
    }),
  { git: true, trusted: true, config: providerConfig },
)

it.instance(
  "changed child bytes cannot inherit approval through a worktree alias",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const store = yield* InstanceStore.Service
      const parent = yield* InstanceRef
      if (!parent) throw new Error("Missing parent instance")
      const target = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const alias = path.join(outside, "checkout")
      expect((yield* config.trust()).trusted).toBe(true)
      const original = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "vector.json"), "utf8"))
      yield* Effect.promise(async () => {
        await fs.cp(test.directory, target, { recursive: true })
        await fs.appendFile(path.join(target, "vector.json"), "\n ")
        await fs.symlink(target, alias, linkType)
      })
      expect(yield* config.inheritTrust(alias)).toBe(false)
      const child = yield* store.load({ directory: target, worktree: alias, project: parent.project })
      yield* Effect.addFinalizer(() => store.dispose(child))
      expect((yield* config.trust().pipe(Effect.provideService(InstanceRef, child))).trusted).toBe(false)
      expect((yield* config.get().pipe(Effect.provideService(InstanceRef, child))).provider?.fixture).toBeUndefined()
      expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "vector.json"), "utf8"))).toBe(original)
    }),
  { git: true, trusted: true, config: providerConfig },
)

it.instance(
  "retargeting a worktree alias cannot move an inherited approval to a different checkout with identical bytes",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* Config.Service
      const store = yield* InstanceStore.Service
      const parent = yield* InstanceRef
      if (!parent) throw new Error("Missing parent instance")
      const target = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const alias = path.join(outside, "checkout")
      expect((yield* config.trust()).trusted).toBe(true)
      yield* Effect.promise(async () => {
        await fs.cp(test.directory, target, { recursive: true })
        await fs.cp(test.directory, other, { recursive: true })
        await fs.symlink(target, alias, linkType)
      })
      expect(yield* config.inheritTrust(alias)).toBe(true)
      yield* Effect.promise(async () => {
        await fs.unlink(alias)
        await fs.symlink(other, alias, linkType)
      })
      yield* Effect.promise(async () =>
        expect(ConfigPaths.canonicalScope({ directory: target, worktree: alias })).rejects.toThrow("outside"),
      )
      const child = yield* store.load({ directory: other, worktree: alias, project: parent.project })
      yield* Effect.addFinalizer(() => store.dispose(child))
      expect((yield* config.trust().pipe(Effect.provideService(InstanceRef, child))).trusted).toBe(false)
      expect((yield* config.get().pipe(Effect.provideService(InstanceRef, child))).provider?.fixture).toBeUndefined()
    }),
  { git: true, trusted: true, config: providerConfig },
)

it.live("canonical config scopes reject missing paths and files instead of assuming lexical directory authority", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const file = path.join(directory, "not-a-directory")
    yield* Effect.promise(() => fs.writeFile(file, "fixture"))
    yield* Effect.promise(async () =>
      expect(
        ConfigPaths.canonicalScope({ directory: path.join(directory, "missing"), worktree: directory }),
      ).rejects.toThrow(),
    )
    yield* Effect.promise(async () =>
      expect(ConfigPaths.canonicalScope({ directory: file, worktree: directory })).rejects.toThrow("directory"),
    )
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
