import { expect, spyOn } from "bun:test"
import path from "path"
import { lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "url"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { PluginLoader } from "@/plugin/loader"
import { TuiConfig } from "../../src/config/tui"
import { resetPromptTrust, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, FSUtil.node])))
const winIt = process.platform === "win32" ? it.instance : it.instance.skip

const globalConfigFiles = ["vector.json", "vector.jsonc", "vector.json", "vector.jsonc", "tui.json", "tui.jsonc"].map(
  (file) => path.join(Global.Path.config, file),
)

const cleanState = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  delete process.env.VECTOR_AGENT_CONFIG
  delete process.env.VECTOR_TUI_CONFIG
  // The global files these tests write are the owner's own config, not a change made after an approval.
  resetPromptTrust()
  yield* Effect.forEach(globalConfigFiles, (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
    discard: true,
  })
})

const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    cleanState,
    () => self,
    () => cleanState,
  )

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

const withPlatform = <A, E, R>(platform: typeof process.platform, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")
      Object.defineProperty(process, "platform", {
        ...original,
        value: platform,
      })
      return original
    }),
    () => self,
    (original) =>
      Effect.sync(() => {
        if (original) Object.defineProperty(process, "platform", original)
      }),
  )

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(
      AppNodeBuilder.build(TuiConfig.node).pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory))),
    ),
  )

const getTuiPluginOrigins = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.pluginOrigins()).pipe(
    Effect.provide(
      AppNodeBuilder.build(TuiConfig.node).pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory))),
    ),
  )

const getTuiState = (directory: string) =>
  TuiConfig.Service.use((svc) =>
    Effect.all({
      config: svc.get(),
      origins: svc.pluginOrigins(),
    }),
  ).pipe(
    Effect.provide(
      AppNodeBuilder.build(TuiConfig.node).pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory))),
    ),
  )

const approveWorkspace = (directory: string) =>
  Effect.promise(async () => {
    const snapshot = await WorkspaceTrust.snapshot(directory, [
      path.join(directory, "vector.json"),
      path.join(directory, "tui.json"),
      path.join(directory, ".vector"),
    ])
    await WorkspaceTrust.approve(Global.Path.state, snapshot)
  })

it.instance("keeps server and tui plugin merge semantics aligned", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const local = path.join(test.directory, ".vector")
      yield* fs.makeDirectory(local, { recursive: true })

      yield* fs.writeJson(path.join(Global.Path.config, "vector.json"), {
        plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(local, "vector.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(local, "tui.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
      })
      // Project plugins load only once the project is trusted, for the server and the TUI alike.
      yield* approveWorkspace(test.directory)

      const server = yield* Config.use.get()
      const tui = yield* getTuiConfig(test.directory)
      const tuiOrigins = yield* getTuiPluginOrigins(test.directory)
      const serverPlugins = (server.plugin ?? []).map((item) => ConfigPlugin.pluginSpecifier(item))
      const tuiPlugins = (tui.plugin ?? []).map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(serverPlugins).toEqual(tuiPlugins)
      expect(serverPlugins).toContain("shared-plugin@2.0.0")
      expect(serverPlugins).not.toContain("shared-plugin@1.0.0")

      const serverOrigins = server.plugin_origins ?? []
      expect(serverOrigins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(serverPlugins)
      expect(tuiOrigins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(tuiPlugins)
      expect(serverOrigins.map((item) => item.scope)).toEqual(tuiOrigins.map((item) => item.scope))
    }),
  ),
)

it.instance("keeps project TUI plugins disabled before workspace trust", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const local = path.join(test.directory, ".vector")
      yield* fs.makeDirectory(local, { recursive: true })

      yield* fs.writeJson(path.join(local, "tui.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
      })

      const tui = yield* getTuiConfig(test.directory)
      const tuiOrigins = yield* getTuiPluginOrigins(test.directory)
      const tuiPlugins = (tui.plugin ?? []).map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(tuiPlugins).toEqual([])
      expect(tuiPlugins).not.toContain("shared-plugin@2.0.0")
      expect(tuiPlugins).not.toContain("local-only@1.0.0")
      expect(tuiOrigins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(tuiPlugins)
      expect(tuiOrigins).toEqual([])
    }),
  ),
)

for (const setting of ["VECTOR_TUI_CONFIG", "VECTOR_AGENT_CONFIG_DIR"] as const) {
  it.instance(`keeps ${setting} project aliases behind workspace trust`, () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const local = path.join(test.directory, "project-settings")
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-alias-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        const alias = path.join(outside, "project-link")
        yield* fs.makeDirectory(local, { recursive: true })
        yield* fs.writeJson(path.join(local, "tui.json"), { theme: "project-alias", plugin: ["./plugin.ts"] })
        yield* fs.writeFileString(path.join(local, "plugin.ts"), 'export const marker = "approved-alias"\n')
        yield* Effect.promise(() => symlink(local, alias, process.platform === "win32" ? "junction" : "dir"))

        yield* withEnv(
          setting,
          setting === "VECTOR_TUI_CONFIG" ? path.join(alias, "tui.json") : alias,
          Effect.gen(function* () {
            const untrusted = yield* withEnv("VECTOR_PURE", "1", getTuiState(test.directory))
            expect(untrusted.config.theme).toBe("project-alias")
            expect(untrusted.config.plugin ?? []).toEqual([])
            expect(untrusted.origins).toEqual([])

            yield* Effect.promise(async () => {
              await WorkspaceTrust.approve(Global.Path.state, await WorkspaceTrust.snapshot(test.directory, [local]))
            })
            const trusted = yield* withEnv("VECTOR_PURE", undefined, getTuiState(test.directory))
            expect(trusted.origins).toHaveLength(1)
            expect(trusted.origins[0].scope).toBe("local")
            const plugin = fileURLToPath(ConfigPlugin.pluginSpecifier(trusted.origins[0].spec))
            expect(plugin).not.toBe(path.join(alias, "plugin.ts"))
            expect(plugin).not.toBe(path.join(local, "plugin.ts"))
            expect(yield* fs.readFileString(plugin)).toContain('marker = "approved-alias"')
          }),
        )
      }),
    ),
  )

  it.instance(`preserves ${setting} plugins from an external owner config`, () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-owner-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        yield* fs.writeJson(path.join(outside, "tui.json"), { theme: "owner-config", plugin: ["./plugin.ts"] })
        yield* fs.writeFileString(path.join(outside, "plugin.ts"), 'export const marker = "owner-config"\n')
        const state = yield* withEnv(
          setting,
          setting === "VECTOR_TUI_CONFIG" ? path.join(outside, "tui.json") : outside,
          withEnv("VECTOR_PURE", "1", getTuiState(test.directory)),
        )
        expect(state.config.theme).toBe("owner-config")
        expect(state.origins).toHaveLength(1)
        expect(state.origins[0].scope).toBe("global")
      }),
    ),
  )

  it.instance(`keeps ${setting} links inside the project local when they point outside`, () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-outside-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        yield* fs.writeJson(path.join(outside, "tui.json"), { plugin: ["./plugin.ts"] })
        yield* fs.writeFileString(path.join(outside, "plugin.ts"), 'export const marker = "outside"\n')
        const alias = path.join(test.directory, "outside-settings")
        yield* Effect.promise(() => symlink(outside, alias, process.platform === "win32" ? "junction" : "dir"))
        const state = yield* withEnv(
          setting,
          setting === "VECTOR_TUI_CONFIG" ? path.join(alias, "tui.json") : alias,
          withEnv("VECTOR_PURE", "1", getTuiState(test.directory)),
        )
        expect(state.config.plugin ?? []).toEqual([])
        expect(state.origins).toEqual([])
      }),
    ),
  )
}

for (const owner of ["home", "home alias", "global config"] as const) {
  it.instance(`preserves known owner TUI plugins when the working directory is ${owner}`, () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const directory = owner === "global config" ? Global.Path.config : test.directory
        const home =
          owner !== "home alias"
            ? directory
            : yield* Effect.gen(function* () {
                const outside = yield* Effect.acquireRelease(
                  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-owner-alias-"))),
                  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
                )
                const alias = path.join(outside, "home-link")
                yield* Effect.promise(() =>
                  symlink(directory, alias, process.platform === "win32" ? "junction" : "dir"),
                )
                return alias
              })
        const config = owner === "global config" ? directory : path.join(home, ".vector")
        yield* fs.makeDirectory(config, { recursive: true })
        yield* fs.writeJson(path.join(config, "tui.json"), { theme: "known-owner", plugin: ["./owner-plugin.ts"] })
        yield* fs.writeFileString(path.join(config, "owner-plugin.ts"), 'export const marker = "known-owner"\n')
        yield* Effect.addFinalizer(() =>
          fs.remove(path.join(config, "owner-plugin.ts"), { force: true }).pipe(Effect.ignore),
        )
        const state = yield* withEnv(
          "VECTOR_TEST_HOME",
          owner === "global config" ? process.env.VECTOR_TEST_HOME : home,
          withEnv("VECTOR_PURE", "1", getTuiState(directory)),
        )
        expect(state.config.theme).toBe("known-owner")
        expect(state.origins).toHaveLength(1)
        expect(state.origins[0].scope).toBe("global")
      }),
    ),
  )
}

it.instance("loads approved project config and plugins from captured bytes after live mutation", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const config = path.join(test.directory, "tui.json")
      const plugin = path.join(test.directory, "plugin.ts")
      const theme = path.join(test.directory, "theme.txt")
      const executed = path.join(test.directory, "changed-executed.txt")
      yield* fs.writeFileString(theme, "approved")
      yield* fs.writeJson(config, { theme: `{file:${theme}}`, plugin: ["./plugin.ts"] })
      yield* fs.writeFileString(
        plugin,
        'export const marker = "approved"\nexport default { id: "approved", tui: async () => {} }\n',
      )
      yield* approveWorkspace(test.directory)

      const checkStatus = WorkspaceTrust.status
      const state = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          spyOn(WorkspaceTrust, "status").mockImplementation(async (stateDirectory, snapshot) => {
            const status = await checkStatus(stateDirectory, snapshot)
            if (!status.trusted) return status
            await Bun.write(config, JSON.stringify({ theme: "changed", plugin: ["./plugin.ts"] }))
            await Bun.write(theme, "changed")
            await Bun.write(
              plugin,
              `await Bun.write(${JSON.stringify(executed)}, "executed")\nexport const marker = "changed"\n`,
            )
            return status
          }),
        ),
        () => getTuiState(test.directory),
        (status) => Effect.sync(() => status.mockRestore()),
      )

      expect(state.config.theme).toBe("approved")
      expect(state.origins).toHaveLength(1)
      const origin = state.origins[0]
      const spec = ConfigPlugin.pluginSpecifier(origin.spec)
      expect(spec).not.toBe(pathToFileURL(plugin).href)
      expect(fileURLToPath(spec)).toContain(path.join(Global.Path.state, "workspace-trust"))
      expect(yield* fs.readFileString(fileURLToPath(spec))).toContain('marker = "approved"')

      const loaded = yield* Effect.promise(() => PluginLoader.loadExternal({ items: state.origins, kind: "tui" }))
      expect(loaded[0]?.mod.marker).toBe("approved")
      expect(yield* fs.existsSafe(executed)).toBe(false)
    }),
  ),
)

it.instance("rejects a trusted project TUI plugin that was not captured", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const config = path.join(test.directory, "tui.json")
      const plugin = path.join(test.directory, "late-plugin.ts")
      const executed = path.join(test.directory, "late-executed.txt")
      yield* fs.writeJson(config, { plugin: ["./late-plugin.ts"] })
      yield* approveWorkspace(test.directory)

      const checkStatus = WorkspaceTrust.status
      const state = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          spyOn(WorkspaceTrust, "status").mockImplementation(async (stateDirectory, snapshot) => {
            const status = await checkStatus(stateDirectory, snapshot)
            if (!status.trusted) return status
            await Bun.write(
              plugin,
              `await Bun.write(${JSON.stringify(executed)}, "executed")\nexport default { tui: async () => {} }\n`,
            )
            return status
          }),
        ),
        () => getTuiState(test.directory),
        (status) => Effect.sync(() => status.mockRestore()),
      )

      expect(state.config.plugin ?? []).toEqual([])
      expect(state.origins).toEqual([])
      expect(yield* Effect.promise(() => PluginLoader.loadExternal({ items: state.origins, kind: "tui" }))).toEqual([])
      expect(yield* fs.existsSafe(executed)).toBe(false)
    }),
  ),
)

it.instance("rejects a trusted project TUI plugin reached through a symlink that leaves the workspace", () =>
  withCleanState(
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-outside-plugin-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      const target = path.join(outside, "outside-plugin.ts")
      const linked = path.join(test.directory, "linked-plugin.ts")
      yield* fs.writeFileString(target, 'export default { id: "linked", tui: async () => {} }\n')
      yield* Effect.promise(() => symlink(target, linked, "file"))
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { plugin: ["./linked-plugin.ts"] })
      yield* approveWorkspace(test.directory)

      const state = yield* getTuiState(test.directory)
      expect(state.config.plugin ?? []).toEqual([])
      expect(state.origins).toEqual([])
      expect(yield* Effect.promise(() => PluginLoader.loadExternal({ items: state.origins, kind: "tui" }))).toEqual([])
    }),
  ),
)

it.instance("loads tui config with the same precedence order as server config paths", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project" })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".vector", "tui.json"),
        JSON.stringify({ theme: "local", diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("local")
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("resolves attention config defaults and overrides", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: true,
        sound: true,
        volume: 0.4,
        sound_pack: "vector.default",
        sounds: {},
      })

      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        attention: {
          enabled: false,
          notifications: false,
          sound: false,
          volume: 0.7,
          sound_pack: "acme.soft",
          sounds: {
            default: path.join(test.directory, "default.mp3"),
            question: pathToFileURL(path.join(test.directory, "question.mp3")).href,
            error: "./error.mp3",
            subagent_done: "./subagent-done.mp3",
          },
        },
      })

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: false,
        sound: false,
        volume: 0.7,
        sound_pack: "acme.soft",
        sounds: {
          default: path.join(test.directory, "default.mp3"),
          question: path.join(test.directory, "question.mp3"),
          error: path.join(test.directory, "error.mp3"),
          subagent_done: path.join(test.directory, "subagent-done.mp3"),
        },
      })
    }),
  ),
)

it.instance("migrates tui-specific keys from vector.json when tui.json does not exist", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const source = path.join(test.directory, "vector.json")
      yield* fs.writeJson(source, {
        theme: "migrated-theme",
        tui: { scroll_speed: 5 },
        keybinds: { app_exit: "ctrl+q" },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("migrated-theme")
      expect(config.scroll_speed).toBe(5)
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      expect(JSON.parse(yield* fs.readFileString(path.join(test.directory, "tui.json")))).toMatchObject({
        theme: "migrated-theme",
        scroll_speed: 5,
      })
      const server = JSON.parse(yield* fs.readFileString(source))
      expect(server.theme).toBeUndefined()
      expect(server.keybinds).toBeUndefined()
      expect(server.tui).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "vector.json.tui-migration.bak"))).toBe(true)
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(true)
    }),
  ),
)

it.instance("migrates project legacy tui keys even when global tui.json already exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(path.join(test.directory, "vector.json"), {
        theme: "project-migrated",
        tui: { scroll_speed: 2 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("project-migrated")
      expect(config.scroll_speed).toBe(2)
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(true)

      const server = JSON.parse(yield* fs.readFileString(path.join(test.directory, "vector.json")))
      expect(server.theme).toBeUndefined()
      expect(server.tui).toBeUndefined()
    }),
  ),
)

it.instance("drops unknown legacy tui keys during migration", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "vector.json"), {
        theme: "migrated-theme",
        tui: { scroll_speed: 2, foo: 1 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("migrated-theme")
      expect(config.scroll_speed).toBe(2)

      const migrated = JSON.parse(yield* fs.readFileString(path.join(test.directory, "tui.json")))
      expect(migrated.scroll_speed).toBe(2)
      expect(migrated.foo).toBeUndefined()
    }),
  ),
)

it.instance("skips migration when vector.jsonc is syntactically invalid", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(
        path.join(test.directory, "vector.jsonc"),
        `{
  "theme": "broken-theme",
  "tui": { "scroll_speed": 2 }
  "username": "still-broken"
}`,
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBeUndefined()
      expect(config.scroll_speed).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(test.directory, "vector.jsonc.tui-migration.bak"))).toBe(false)
      const source = yield* fs.readFileString(path.join(test.directory, "vector.jsonc"))
      expect(source).toContain('"theme": "broken-theme"')
      expect(source).toContain('"tui": { "scroll_speed": 2 }')
    }),
  ),
)

it.instance("skips migration when tui.json already exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "vector.json"), { theme: "legacy" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { diff_style: "stacked" })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBeUndefined()

      const server = JSON.parse(yield* fs.readFileString(path.join(test.directory, "vector.json")))
      expect(server.theme).toBe("legacy")
      expect(yield* fs.existsSafe(path.join(test.directory, "vector.json.tui-migration.bak"))).toBe(false)
    }),
  ),
)

it.instance("continues loading tui config when legacy source cannot be stripped", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const source = path.join(test.directory, "vector.json")
      yield* fs.writeJson(source, { theme: "readonly-theme" })

      yield* Effect.acquireUseRelease(
        fs.chmod(source, 0o444),
        () =>
          Effect.gen(function* () {
            const config = yield* getTuiConfig(test.directory)
            expect(config.theme).toBe("readonly-theme")
            expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(true)

            const server = JSON.parse(yield* fs.readFileString(source))
            expect(server.theme).toBe("readonly-theme")
          }),
        () => fs.chmod(source, 0o644).pipe(Effect.ignore),
      )
    }),
  ),
)

it.instance("migration backup preserves JSONC comments", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(
        path.join(test.directory, "vector.jsonc"),
        `{
  // top-level comment
  "theme": "jsonc-theme",
  "tui": {
    // nested comment
    "scroll_speed": 1.5
  }
}`,
      )

      yield* getTuiConfig(test.directory)
      const backup = yield* fs.readFileString(path.join(test.directory, "vector.jsonc.tui-migration.bak"))
      expect(backup).toContain("// top-level comment")
      expect(backup).toContain("// nested comment")
      expect(backup).toContain('"theme": "jsonc-theme"')
      expect(backup).toContain('"scroll_speed": 1.5')
    }),
  ),
)

it.instance("migrates legacy tui keys across multiple vector.json levels", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "apps", "client")
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeJson(path.join(test.directory, "vector.json"), { theme: "root-theme" })
      yield* fs.writeJson(path.join(nested, "vector.json"), { theme: "nested-theme" })

      const config = yield* getTuiConfig(nested)
      expect(config.theme).toBe("nested-theme")
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(true)
      expect(yield* fs.existsSafe(path.join(nested, "tui.json"))).toBe(true)
    }),
  ),
)

it.instance("flattens nested tui key inside tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        theme: "outer",
        tui: { scroll_speed: 3, diff_style: "stacked" },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.scroll_speed).toBe(3)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBe("outer")
    }),
  ),
)

it.instance("top-level keys in tui.json take precedence over nested tui key", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        diff_style: "auto",
        tui: { diff_style: "stacked", scroll_speed: 2 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("auto")
      expect(config.scroll_speed).toBe(2)
    }),
  ),
)

it.instance("project config takes precedence over VECTOR_TUI_CONFIG (matches VECTOR_AGENT_CONFIG)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project", diff_style: "auto" })
      yield* fs.writeJson(custom, { theme: "custom", diff_style: "stacked" })

      yield* withEnv(
        "VECTOR_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("project")
          expect(config.diff_style).toBe("auto")
        }),
      )
    }),
  ),
)

it.instance("merges keybind overrides across precedence layers", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { keybinds: { app_exit: "ctrl+q" } })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { theme_list: "ctrl+k" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      expect(config.keybinds.get("theme.switch")?.[0]?.key).toBe("ctrl+k")
    }),
  ),
)

it.instance("ignores unknown keybind names without dropping valid overrides from the same file", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        keybinds: {
          session_delete: "ctrl+d",
          not_a_real_keybind: "ctrl+q",
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("session.delete")?.[0]?.key).toBe("ctrl+d")
      expect(config.keybinds.get("not_a_real_keybind")).toEqual([])
    }),
  ),
)

// 4.3: "Stop including helpers" (session.interrupt.all) defaults to <leader>k. A config written for another version that
// names a keybind this one does not know still loads, and keeps its other overrides.
it.instance("resolves session_interrupt_all and still loads an older config with an unknown keybind", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance

      const defaults = yield* getTuiConfig(test.directory)
      expect(defaults.keybinds.get("session.interrupt.all")?.[0]?.key).toBe("<leader>k")

      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        keybinds: {
          app_exit: "ctrl+q",
          session_interrupt_all: "ctrl+alt+s",
          session_retired_keybind: "ctrl+y",
        },
      })
      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      expect(config.keybinds.get("session.interrupt.all")?.[0]?.key).toBe("ctrl+alt+s")
      expect(config.keybinds.get("session_retired_keybind")).toEqual([])
    }),
  ),
)

it.instance("resolves keybind lookup from canonical keybinds", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          leader: { key: { name: "g", ctrl: true } },
          command_list: "alt+p",
          diff_open: "ctrl+j",
          which_key_toggle: "alt+k",
          editor_open: "ctrl+e",
          "prompt.autocomplete.next": "ctrl+j",
          "dialog.prompt.submit": "ctrl+s",
          "dialog.mcp.toggle": "ctrl+t",
          model_favorite_toggle: "ctrl+f",
          "dialog.plugins.install": "shift+i",
        },
        leader_timeout: 1234,
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("leader")?.[0]?.key).toEqual({ name: "g", ctrl: true })
      expect(config.leader_timeout).toBe(1234)
      expect(config.keybinds.get("command.palette.show")?.[0]?.key).toBe("alt+p")
      expect(config.keybinds.get("diff.open")?.[0]?.key).toBe("ctrl+j")
      expect(config.keybinds.get("session.new")?.[0]?.key).toBe("<leader>n")
      expect(config.keybinds.get("which-key.toggle")?.[0]?.key).toBe("alt+k")
      expect(config.keybinds.get("which-key.layout.toggle")?.[0]?.key).toBe("ctrl+alt+shift+k")
      expect(config.keybinds.get("which-key.pending.toggle")?.[0]?.key).toBe("ctrl+alt+shift+p")
      expect(config.keybinds.get("which-key.group.next")?.[0]?.key).toBe("ctrl+alt+right,ctrl+alt+]")
      expect((config.keybinds.get("which-key.toggle")?.[0] as { desc?: unknown } | undefined)?.desc).toBe(
        "Toggle which-key panel",
      )
      expect(config.keybinds.get("prompt.editor")?.[0]?.key).toBe("ctrl+e")
      expect(config.keybinds.get("prompt.autocomplete.next")?.[0]?.key).toBe("ctrl+j")
      expect(config.keybinds.get("dialog.prompt.submit")?.[0]?.key).toBe("ctrl+s")
      expect(config.keybinds.get("dialog.mcp.toggle")?.[0]?.key).toBe("ctrl+t")
      expect(config.keybinds.get("model.dialog.favorite")?.[0]?.key).toBe("ctrl+f")
      expect(config.keybinds.get("dialog.plugins.install")?.[0]?.key).toBe("shift+i")
      expect(
        config.keybinds.gather("plugins.dialog", ["dialog.plugins.install"]).map((binding) => binding.cmd),
      ).toEqual(["dialog.plugins.install"])
    }),
  ),
)

it.instance("keybinds accept OpenTUI binding specs", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          command_list: [{ key: "alt+p", preventDefault: false }],
          editor_open: { key: { name: "e", ctrl: true }, group: "Explicit" },
          "prompt.autocomplete.next": false,
          plugin_manager: "ctrl+shift+p",
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("command.palette.show")).toEqual([
        { key: "alt+p", cmd: "command.palette.show", preventDefault: false, desc: "List available commands" },
      ])
      expect(config.keybinds.get("prompt.editor")?.[0]).toMatchObject({
        key: { name: "e", ctrl: true },
        cmd: "prompt.editor",
        group: "Explicit",
      })
      expect(config.keybinds.get("prompt.autocomplete.next")).toEqual([])
      expect(config.keybinds.get("plugins.list")?.[0]?.key).toBe("ctrl+shift+p")
    }),
  ),
)

winIt("defaults Ctrl+Z to input undo on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

winIt("keeps explicit input undo overrides on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { input_undo: "ctrl+y" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
    }),
  ),
)

winIt("ignores terminal suspend bindings on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { terminal_suspend: "alt+z" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

it.instance("applies Windows keybind defaults", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const test = yield* TestInstance
        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
      }),
    ),
  ),
)

it.instance("ignores explicit keybind terminal suspend binding on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            terminal_suspend: "alt+z",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
      }),
    ),
  ),
)

it.instance("keeps explicit configured keybind input undo on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            input_undo: "ctrl+y",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
      }),
    ),
  ),
)

it.instance("VECTOR_TUI_CONFIG provides settings when no project config exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(custom, { theme: "from-env", diff_style: "stacked" })

      yield* withEnv(
        "VECTOR_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("from-env")
          expect(config.diff_style).toBe("stacked")
        }),
      )
    }),
  ),
)

it.instance("keeps env-named TUI config inside an untrusted project under project trust", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-env-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      const alias = path.join(outside, "project")
      yield* Effect.promise(() => symlink(test.directory, alias, process.platform === "win32" ? "junction" : "dir"))
      yield* fs.writeFileString(
        path.join(test.directory, "env-plugin.ts"),
        'export default { id: "env", tui: async () => {} }\n',
      )
      yield* fs.writeJson(path.join(test.directory, "custom-tui.json"), {
        theme: "from-env",
        plugin: ["./env-plugin.ts"],
      })
      yield* fs.writeWithDirs(
        path.join(test.directory, "config-dir", "tui.json"),
        JSON.stringify({ theme: "from-dir", plugin: ["../env-plugin.ts"] }),
      )

      // Under the project's own spelling and through a link into it, the settings apply but the plugin waits for trust.
      for (const root of [test.directory, alias]) {
        for (const [name, value, theme] of [
          ["VECTOR_TUI_CONFIG", path.join(root, "custom-tui.json"), "from-env"],
          ["VECTOR_AGENT_CONFIG_DIR", path.join(root, "config-dir"), "from-dir"],
        ]) {
          const state = yield* withEnv(name, value, getTuiState(test.directory))
          expect(state.config.theme).toBe(theme)
          expect(state.config.plugin ?? []).toEqual([])
          expect(state.origins).toEqual([])
        }
      }

      // The user's own file outside the project still loads its plugin as theirs.
      yield* fs.writeFileString(
        path.join(outside, "user-plugin.ts"),
        'export default { id: "user", tui: async () => {} }\n',
      )
      yield* fs.writeJson(path.join(outside, "user-tui.json"), { plugin: ["./user-plugin.ts"] })
      const user = yield* withEnv("VECTOR_TUI_CONFIG", path.join(outside, "user-tui.json"), getTuiState(test.directory))
      expect(user.origins.map((item) => item.scope)).toEqual(["global"])
    }),
  ),
)

it.instance("never moves legacy TUI keys through a project's links or out of the workspace", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-migrate-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      const linkType = process.platform === "win32" ? "junction" : "dir"
      const legacy = JSON.stringify({ theme: "outside-theme", keybinds: { app_exit: "ctrl+q" }, other: true }, null, 2)
      const away = path.join(outside, "away")
      yield* fs.writeWithDirs(path.join(away, "vector.json"), legacy)
      // A project .vector that is really a folder outside, and an env-named file reached through a project link.
      yield* Effect.promise(() => symlink(away, path.join(test.directory, ".vector"), linkType))
      yield* Effect.promise(() => symlink(away, path.join(test.directory, "linked"), linkType))
      const snapshot = () => Effect.promise(() => readdir(away).then((names) => names.toSorted()))
      const before = yield* snapshot()

      yield* getTuiConfig(test.directory)
      yield* withEnv(
        "VECTOR_AGENT_CONFIG",
        path.join(test.directory, "linked", "vector.json"),
        getTuiConfig(test.directory),
      )
      expect(yield* snapshot()).toEqual(before)
      expect(yield* Effect.promise(() => readFile(path.join(away, "vector.json"), "utf8"))).toBe(legacy)

      // File links, which is what a cloned repository carries. Windows creates them only with a privilege CI holds.
      const victim = path.join(outside, "settings.json")
      yield* fs.writeFileString(victim, legacy)
      const linked = yield* Effect.promise(() =>
        symlink(victim, path.join(test.directory, "vector.json"), "file")
          .then(() => true)
          .catch((error) => {
            if (process.platform === "win32" && error?.code === "EPERM") return false
            throw error
          }),
      )
      if (!linked) return
      yield* getTuiConfig(test.directory)
      expect(yield* Effect.promise(() => readFile(victim, "utf8"))).toBe(legacy)
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(test.directory, "vector.json.tui-migration.bak"))).toBe(false)

      // A dangling tui.json link beside a plain legacy file must not create the file it points at.
      yield* fs.remove(path.join(test.directory, "vector.json"))
      yield* fs.writeFileString(path.join(test.directory, "vector.json"), legacy)
      yield* Effect.promise(() =>
        symlink(path.join(outside, "created.json"), path.join(test.directory, "tui.json"), "file"),
      )
      yield* getTuiConfig(test.directory)
      expect(yield* fs.existsSafe(path.join(outside, "created.json"))).toBe(false)
      expect(yield* fs.readFileString(path.join(test.directory, "vector.json"))).toBe(legacy)
      expect((yield* Effect.promise(() => lstat(path.join(test.directory, "tui.json")))).isSymbolicLink()).toBe(true)
    }),
  ),
)

it.instance("never moves legacy TUI keys through a .vector above a non-git workspace that links away", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const temporary = (prefix: string) =>
        Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), prefix))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
      // A non-git folder opened one level down, whose .vector is really a folder somewhere else.
      const root = yield* temporary("vector-tui-parent-")
      const outside = yield* temporary("vector-tui-away-")
      const legacy = JSON.stringify({ theme: "outside-theme", keybinds: { app_exit: "ctrl+q" }, other: true }, null, 2)
      yield* fs.writeWithDirs(path.join(outside, "vector.json"), legacy)
      yield* fs.makeDirectory(path.join(root, "app"), { recursive: true })
      yield* Effect.promise(() =>
        symlink(outside, path.join(root, ".vector"), process.platform === "win32" ? "junction" : "dir"),
      )

      yield* getTuiConfig(path.join(root, "app"))
      expect(yield* Effect.promise(() => readdir(outside))).toEqual(["vector.json"])
      expect(yield* Effect.promise(() => readFile(path.join(outside, "vector.json"), "utf8"))).toBe(legacy)
    }),
  ),
)

it.instance("still moves legacy TUI keys out of the user's own env-named config outside the project", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "vector-tui-own-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      yield* fs.writeJson(path.join(outside, "vector.json"), { theme: "user-theme" })
      const config = yield* withEnv("VECTOR_AGENT_CONFIG_DIR", outside, getTuiConfig(test.directory))
      expect(config.theme).toBe("user-theme")
      expect(JSON.parse(yield* fs.readFileString(path.join(outside, "tui.json")))).toMatchObject({
        theme: "user-theme",
      })
      expect(JSON.parse(yield* fs.readFileString(path.join(outside, "vector.json"))).theme).toBeUndefined()
    }),
  ),
)

it.instance("does not derive tui path from VECTOR_AGENT_CONFIG", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const customDir = path.join(test.directory, "custom")
      yield* fs.makeDirectory(customDir, { recursive: true })
      yield* fs.writeJson(path.join(customDir, "vector.json"), { model: "test/model" })
      yield* fs.writeJson(path.join(customDir, "tui.json"), { theme: "should-not-load" })

      yield* withEnv(
        "VECTOR_AGENT_CONFIG",
        path.join(customDir, "vector.json"),
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBeUndefined()
        }),
      )
    }),
  ),
)

it.instance("applies env and file substitutions in tui.json", () =>
  withCleanState(
    withEnv(
      "TUI_THEME_TEST",
      "env-theme",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeFileString(path.join(test.directory, "keybind.txt"), "ctrl+q")
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          theme: "{env:TUI_THEME_TEST}",
          keybinds: { app_exit: "{file:keybind.txt}" },
        })
        // Substitution applies once the project is trusted; before that a project's references stay unread.
        yield* approveWorkspace(test.directory)

        const config = yield* getTuiConfig(test.directory)
        expect(config.theme).toBe("env-theme")
        expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      }),
    ),
  ),
)

it.instance("applies file substitutions when first identical token is in a commented line", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "theme.txt"), "resolved-theme")
      yield* fs.writeFileString(
        path.join(test.directory, "tui.jsonc"),
        `{
  // "theme": "{file:theme.txt}",
  "theme": "{file:theme.txt}"
}`,
      )
      yield* approveWorkspace(test.directory)

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("resolved-theme")
    }),
  ),
)

it.instance("loads .vector/tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(
        path.join(test.directory, ".vector", "tui.json"),
        JSON.stringify({ diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("supports tuple plugin specs with options in tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin: [["acme-plugin@1.2.3", { enabled: true, label: "demo" }]],
      })
      yield* approveWorkspace(test.directory)

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual([["acme-plugin@1.2.3", { enabled: true, label: "demo" }]])
      expect(origins).toEqual([
        {
          spec: ["acme-plugin@1.2.3", { enabled: true, label: "demo" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("deduplicates tuple plugin specs by name with higher precedence winning", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin: [["acme-plugin@1.0.0", { source: "global" }]],
      })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin: [
          ["acme-plugin@2.0.0", { source: "project" }],
          ["second-plugin@3.0.0", { source: "project" }],
        ],
      })
      yield* approveWorkspace(test.directory)

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual([
        ["acme-plugin@2.0.0", { source: "project" }],
        ["second-plugin@3.0.0", { source: "project" }],
      ])
      expect(origins).toEqual([
        {
          spec: ["acme-plugin@2.0.0", { source: "project" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
        {
          spec: ["second-plugin@3.0.0", { source: "project" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("tracks global and local plugin metadata in merged tui config", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { plugin: ["global-plugin@1.0.0"] })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { plugin: ["local-plugin@2.0.0"] })
      yield* approveWorkspace(test.directory)

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual(["global-plugin@1.0.0", "local-plugin@2.0.0"])
      expect(origins).toEqual([
        {
          spec: "global-plugin@1.0.0",
          scope: "global",
          source: path.join(Global.Path.config, "tui.json"),
        },
        {
          spec: "local-plugin@2.0.0",
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("merges plugin_enabled flags across config layers", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin_enabled: {
          "internal:sidebar-context": false,
          "demo.plugin": true,
        },
      })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin_enabled: {
          "demo.plugin": false,
          "local.plugin": true,
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.plugin_enabled).toEqual({
        "internal:sidebar-context": false,
        "demo.plugin": false,
        "local.plugin": true,
      })
    }),
  ),
)

it.instance("silently skips malformed tui.json - load failures degrade to {}", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "tui.json"), '{ "theme": "broken",')
      yield* fs.writeWithDirs(path.join(test.directory, ".vector", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("silently skips non-ENOENT read failures (e.g. tui.json is a directory) - fallback layer still loads", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.makeDirectory(path.join(test.directory, "tui.json"), { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".vector", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("missing tui.json - silently treated as empty (ENOENT path)", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config).toBeDefined()
      expect(config.theme).toBeUndefined()
    }),
  ),
)
