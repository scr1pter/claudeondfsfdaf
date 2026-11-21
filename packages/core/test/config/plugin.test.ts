import path from "path"
import fs from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@vectordevai/core/agent"
import { Config } from "@vectordevai/core/config"
import { ConfigExternalPlugin } from "@vectordevai/core/config/plugin/external"
import { ConfigReferencePlugin } from "@vectordevai/core/config/plugin/reference"
import { ConfigSkillPlugin } from "@vectordevai/core/config/plugin/skill"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Location } from "@vectordevai/core/location"
import { Npm } from "@vectordevai/core/npm"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { Reference } from "@vectordevai/core/reference"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SkillV2 } from "@vectordevai/core/skill"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("Executable config plugins", () => {
  it.effect("excludes untrusted project skills and references while preserving executable entries", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const skills = yield* SkillV2.Service
      const references = yield* Reference.Service
      const host = yield* PluginHost.make(plugins)
      const globalDirectory = new Config.Directory({
        type: "directory",
        path: AbsolutePath.make("/global/.vector"),
      })
      const projectDirectory = new Config.Directory({
        type: "directory",
        path: AbsolutePath.make("/project/.vector"),
      })
      const globalDocument = new Config.Document({
        type: "document",
        info: decode({
          skills: ["/global/skills", "https://1.1.1.1/catalog/"],
          references: { docs: "/global/docs" },
        }),
      })
      const projectDocument = new Config.Document({
        type: "document",
        path: "/project/vector.json",
        info: decode({
          skills: ["/project/skills", "http://127.0.0.1/catalog/"],
          references: {
            docs: "/project/docs",
            private: { repository: "https://127.0.0.1/owner/repo.git" },
          },
        }),
      })
      const config = Config.Service.of({
        entries: () => Effect.succeed([globalDirectory, globalDocument, projectDirectory, projectDocument]),
        executable: (entry) => entry !== projectDirectory && entry !== projectDocument,
      })
      const global = Global.Service.of({ ...Global.make(), home: "/home/test" })

      yield* ConfigSkillPlugin.Plugin.effect(host).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(Global.Service, global),
      )
      yield* ConfigReferencePlugin.Plugin.effect(host).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(Global.Service, global),
      )

      expect(yield* skills.sources()).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(globalDirectory.path, "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(globalDirectory.path, "skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/global/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://1.1.1.1/catalog/" }),
      ])
      expect(yield* references.list()).toEqual([
        new Reference.Info({
          name: "docs",
          path: AbsolutePath.make("/global/docs"),
          source: Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/global/docs") }),
        }),
      ])
    }),
  )
})

describe("ConfigExternalPlugin", () => {
  it.live("does not import a project plugin before workspace trust", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const fsUtil = yield* FSUtil.Service
          const location = yield* Location.Service
          const npm = yield* Npm.Service
          const host = yield* PluginHost.make(plugins)
          const plugin = path.join(tmp.path, "malicious.ts")
          const marker = path.join(tmp.path, "imported.txt")
          yield* Effect.promise(() =>
            Bun.write(
              plugin,
              `await Bun.write(${JSON.stringify(marker)}, "imported")\nexport default { id: "bad", effect: () => {} }\n`,
            ),
          )
          const document = new Config.Document({
            type: "document",
            path: path.join(tmp.path, "vector.json"),
            info: decode({ plugins: [plugin] }),
          })

          yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
            Effect.provideService(PluginV2.Service, plugins),
            Effect.provideService(FSUtil.Service, fsUtil),
            Effect.provideService(Location.Service, location),
            Effect.provideService(Npm.Service, npm),
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () => Effect.succeed([document]),
                executable: (entry) => entry !== document,
              }),
            ),
          )
          yield* Effect.sleep("20 millis")
          expect(yield* Effect.promise(() => fs.stat(marker).catch(() => undefined))).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("imports the approved plugin bytes from a private snapshot after the live file changes", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (directories) =>
        Effect.promise(() => Promise.all(directories.map((directory) => directory[Symbol.asyncDispose]()))),
    ).pipe(
      Effect.flatMap(([tmp, state]) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const fsUtil = yield* FSUtil.Service
          const location = yield* Location.Service
          const npm = yield* Npm.Service
          const host = yield* PluginHost.make(plugins)
          const plugin = path.join(tmp.path, "plugin.ts")
          const configFile = path.join(tmp.path, "vector.json")
          const marker = path.join(tmp.path, "imported.txt")
          yield* Effect.promise(async () => {
            await Bun.write(configFile, JSON.stringify({ plugins: ["./plugin.ts"] }))
            await Bun.write(
              plugin,
              `await Bun.write(${JSON.stringify(marker)}, "approved")\nexport default { id: "approved", effect: () => {} }\n`,
            )
          })
          const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(tmp.path, [configFile]))
          yield* Effect.promise(() => WorkspaceTrust.approve(state.path, snapshot))
          const trusted = yield* Effect.promise(() => WorkspaceTrust.materialize(state.path, snapshot))
          yield* Effect.promise(() =>
            Bun.write(
              plugin,
              `await Bun.write(${JSON.stringify(marker)}, "changed")\nexport default { id: "changed", effect: () => {} }\n`,
            ),
          )
          const document = new Config.Document({
            type: "document",
            path: configFile,
            info: decode({ plugins: ["./plugin.ts"] }),
          })

          yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
            Effect.provideService(PluginV2.Service, plugins),
            Effect.provideService(FSUtil.Service, fsUtil),
            Effect.provideService(Location.Service, location),
            Effect.provideService(Npm.Service, npm),
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () => Effect.succeed([document]),
                executable: () => true,
                executablePath: (_, input) => WorkspaceTrust.materializedPath(trusted, input),
              }),
            ),
          )
          // The plugin's Bun.write creates the marker before it writes the bytes, and on Windows a reader can see the
          // empty file in between, so wait for the content rather than the name.
          let imported = ""
          for (let attempt = 0; attempt < 100 && imported === ""; attempt++) {
            imported = yield* fsUtil.readFileString(marker).pipe(Effect.orElseSucceed(() => ""))
            if (imported === "") yield* Effect.sleep("10 millis")
          }
          expect(imported).toBe("approved")
        }),
      ),
    ),
  )

  it.live("resolves and loads a configured Promise plugin with options", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)
      const document = path.join(import.meta.dir, "vector.json")

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: document,
                  info: decode({
                    plugins: [
                      {
                        package: "../plugin/fixtures/config-promise-plugin.ts",
                        options: { description: "Loaded from config" },
                      },
                    ],
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Loaded from config",
        mode: "subagent",
      })
    }),
  )

  it.live("loads a configured Effect plugin with options", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: path.join(import.meta.dir, "vector.json"),
                  info: decode({
                    plugins: [
                      {
                        package: "../plugin/fixtures/config-effect-plugin.ts",
                        options: { description: "Effect plugin from config" },
                      },
                    ],
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "effect-configured")).toMatchObject({
        description: "Effect plugin from config",
        mode: "subagent",
      })
    }),
  )

  it.live("ignores invalid plugins and continues loading", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: path.join(import.meta.dir, "vector.json"),
                  info: decode({
                    plugins: [
                      "../plugin/fixtures/missing-plugin.ts",
                      "../plugin/fixtures/invalid-plugin.ts",
                      {
                        package: "../plugin/fixtures/config-promise-plugin.ts",
                        options: { description: "Loaded after invalid plugins" },
                      },
                    ],
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Loaded after invalid plugins",
      })
    }),
  )

  it.live("installs and resolves npm plugin packages", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const host = yield* PluginHost.make(plugins)
      const installed: string[] = []
      const add = (spec: string) =>
        Effect.sync(() => {
          installed.push(spec)
          return {
            directory: import.meta.dir,
            entrypoint: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
          }
        })
      const npm = Npm.Service.of({
        add,
        addAs: (_source, spec) => add(spec),
        install: () => Effect.void,
        which: () => Effect.succeed(undefined),
        whichAs: () => Effect.succeed(undefined),
      })

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({
                    plugins: [
                      "mutable-plugin",
                      {
                        package: "example-plugin@1.0.0",
                        options: { description: "Installed from npm" },
                      },
                    ],
                  }),
                }),
              ]),
            // A project must pin its plugins; the mutable one is skipped.
            scope: () => "project",
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Installed from npm",
      })
      expect(installed).toEqual(["example-plugin@1.0.0"])
    }),
  )

  it.live("loads an unpinned plugin from the user's global config", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const host = yield* PluginHost.make(plugins)
      const installed: string[] = []
      const add = (spec: string) =>
        Effect.sync(() => {
          installed.push(spec)
          return {
            directory: import.meta.dir,
            entrypoint: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
          }
        })
      const npm = Npm.Service.of({
        add,
        addAs: (_source, spec) => add(spec),
        install: () => Effect.void,
        which: () => Effect.succeed(undefined),
        whichAs: () => Effect.succeed(undefined),
      })

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({
                    plugins: [{ package: "mutable-plugin", options: { description: "Latest from npm" } }],
                  }),
                }),
              ]),
            scope: () => "global",
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Latest from npm",
      })
      expect(installed).toEqual(["mutable-plugin"])
    }),
  )

  it.live("loads plugin files from config directories", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({
                  type: "directory",
                  path: AbsolutePath.make(path.join(import.meta.dir, "fixtures")),
                }),
              ]),
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "directory")).toMatchObject({
        description: "Loaded from plugin directory",
        mode: "subagent",
      })
    }),
  )
})

const waitForAgent = Effect.fnUntraced(function* (agents: AgentV2.Interface, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const agent = yield* agents.get(AgentV2.ID.make(id))
    if (agent) return agent
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die(`Timed out waiting for agent ${id}`)
})
