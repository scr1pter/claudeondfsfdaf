import { expect } from "bun:test"
import path from "node:path"
import nodeFs from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import { systemError } from "effect/PlatformError"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ConfigImport } from "@/config/import-settings"
import { ConfigMigration } from "@vectordevai/core/config/migration"
import { ConfigParse } from "@/config/parse"
import { GlobalBus } from "@/bus/global"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

// Historical fixture names come from retained attribution, never production code.
const notices = await Bun.file(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url)).text()
const previous = notices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase()
if (!previous) throw new Error("Missing attribution for historical upgrade fixture")

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node])))

it.live("imports neutral JSON and extensionless TOML while retaining the original files", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const [name, text] of [
      ["config.json", '{"permission":{"bash":"deny"}}'],
      ["config", 'provider = "fixture"\nmodel = "model"\n[permission]\nedit = "deny"\n'],
    ]) {
      const directory = path.join(root, name.replace(/\W/g, ""))
      yield* fs.ensureDir(directory)
      yield* fs.writeFileString(path.join(directory, name), text)
      yield* ConfigImport.run(directory)
      expect(yield* fs.readFileString(path.join(directory, name))).toBe(text)
      const imported = yield* fs.readJson(path.join(directory, "vector.jsonc"))
      expect(imported).toMatchObject({
        $schema: "https://vectordev.ai/config.json",
        permission: name === "config" ? { edit: "deny" } : { bash: "deny" },
      })
      expect(yield* ConfigImport.run(directory)).toBeUndefined()
    }
  }),
)

it.live("imports recognized project assets and both config layers once without changing originals", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const source = path.join(directory, `.${previous}`)
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ])
      yield* fs.writeWithDirs(path.join(source, name), `fixture:${name}`)
    yield* fs.writeFileString(
      path.join(source, `${previous}.jsonc`),
      '{"permission":{"bash":"deny"},"theme":"custom","mcp":{"fixture":{"type":"local","command":["fixture"]}}}',
    )
    yield* fs.writeFileString(path.join(source, `${previous}.local.json`), '{"permission":{"edit":"deny"}}')
    yield* fs.writeWithDirs(path.join(directory, ".unrelated", "data.json"), '{"model":"must-not-import"}')
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    const imported = yield* ConfigMigration.discover(input)
    expect(imported).toHaveLength(3)
    const target = path.join(directory, ".vector")
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({
      permission: { bash: "deny" },
      theme: "custom",
    })
    expect(yield* fs.readJson(path.join(target, "vector.local.jsonc"))).toMatchObject({ permission: { edit: "deny" } })
    expect(yield* fs.exists(path.join(source, ".gitignore"))).toBe(false)
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ]) {
      expect(yield* fs.readFileString(path.join(target, name))).toBe(`fixture:${name}`)
      expect(yield* fs.readFileString(path.join(source, name))).toBe(`fixture:${name}`)
    }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
  }),
)

it.live("protects current assets and respects disabled project config during migration", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(directory, `.${previous}`, "agents", "reviewer.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, `.${previous}`, "commands", "review.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, ".vector", "agents", "reviewer.md"), "current")
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    expect(yield* ConfigMigration.discover({ ...input, disableProject: true })).toEqual([])
    expect(String(yield* ConfigMigration.discover(input).pipe(Effect.exit))).toContain("conflict")
    expect(yield* fs.readFileString(path.join(directory, ".vector", "agents", "reviewer.md"))).toBe("current")
    expect(yield* fs.exists(path.join(directory, ".vector", "vector-migration.json"))).toBe(false)
  }),
)

for (const permissionMode of process.platform === "win32" ? ["denied"] : ["posix", "denied"]) {
  it.live(
    `skips unreadable folders and unrelated dot folders that only look like agent folders (${permissionMode})`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const permissions = readPermissions(fs, permissionMode === "denied")
        const home = path.join(root, "home")
        const directory = path.join(home, "project")
        for (const name of [
          "home/.cursor/agents/.keep",
          "home/.cursor/plugins/local/.keep",
          "home/.cursor/mcp.json",
          "home/.oh-my-zsh/plugins/git/git.plugin.zsh",
          "home/.oh-my-zsh/themes/robbyrussell.zsh-theme",
          "home/.oh-my-zsh/tools/upgrade.sh",
          "home/project/.github/agents/reviewer.md",
          "home/project/.github/skills/review/SKILL.md",
          "home/project/.obsidian/plugins/example/main.js",
          "home/project/.obsidian/themes/Minimal/theme.css",
          "home/project/.earlier-agent/agents/reviewer.md",
          "home/project/.earlier-agent/commands/review.md",
          "home/.Trash/deleted.json",
          "home/.locked/locked.json",
        ])
          yield* fs.writeWithDirs(path.join(root, name), "{}")
        yield* fs.writeFileString(
          path.join(home, ".cursor", "mcp.json"),
          '{"mcp":{"docs":{"type":"local","command":["x"]}}}',
        )
        yield* fs.writeFileString(
          path.join(directory, ".earlier-agent", "earlier-agent.json"),
          '{"$schema":"https://earlier-agent.ai/config.json","permission":{"bash":"deny"}}',
        )
        // An unreadable settings file holds nothing to import and never stops loading.
        yield* fs.writeFileString(path.join(directory, "config"), 'model = "must-not-import"\n')
        yield* fs.writeFileString(path.join(home, ".locked", "locked.json"), '{"model":"must-not-import"}')
        const locked = [path.join(home, ".Trash"), path.join(home, ".locked"), path.join(directory, "config")]
        yield* Effect.forEach(locked, (item) => permissions.change(item, 0o000))
        yield* Effect.addFinalizer(() =>
          Effect.forEach(locked, (item) => permissions.change(item, 0o755).pipe(Effect.ignore)),
        )
        const input = { directory, worktree: directory, home, global: path.join(root, "global") }
        expect(
          yield* ConfigMigration.discover(input).pipe(Effect.provideService(FSUtil.Service, permissions.fs)),
        ).toEqual([])
        expect(yield* fs.exists(path.join(home, ".vector"))).toBe(false)
        expect(yield* fs.exists(path.join(directory, ".vector"))).toBe(false)
      }),
  )

  it.live(
    `retries an earlier folder until it can be listed and skips unreadable folders inside it (${permissionMode})`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const permissions = readPermissions(fs, permissionMode === "denied")
        const home = path.join(root, "home")
        const global = path.join(root, "global")
        const parent = path.join(root, "work", "locked")
        const directory = path.join(parent, "app")
        const source = path.join(directory, `.${previous}`)
        yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.json`), '{"model":"fixture/model"}')
        yield* fs.writeWithDirs(path.join(global, "config.json"), '{"model":"fixture/model"}')
        yield* fs.writeWithDirs(path.join(source, `${previous}.json`), '{"permission":{"bash":"deny"}}')
        yield* fs.writeWithDirs(path.join(source, "agents", "reviewer.md"), "reviewer")
        yield* fs.writeWithDirs(path.join(source, "commands", "secret.md"), "secret")
        yield* fs.writeWithDirs(path.join(source, "skills", "locked", "SKILL.md"), "locked")
        // Mode 0o311 keeps the parent traversable, so the project below it stays reachable while its listing fails.
        const modes = [
          [home, 0o000],
          [global, 0o000],
          [parent, 0o311],
          [source, 0o000],
        ] as const
        yield* Effect.forEach(modes, ([item, mode]) => permissions.change(item, mode))
        yield* Effect.addFinalizer(() =>
          Effect.forEach([...modes.map(([item]) => item), path.join(source, "skills", "locked")], (item) =>
            permissions.change(item, 0o755).pipe(Effect.ignore),
          ),
        )
        const input = { directory, worktree: path.join(root, "work"), home, global }
        expect(
          yield* ConfigMigration.discover(input).pipe(Effect.provideService(FSUtil.Service, permissions.fs)),
        ).toEqual([])
        expect(yield* fs.exists(path.join(directory, ".vector"))).toBe(false)

        yield* permissions.change(source, 0o755)
        yield* permissions.change(path.join(source, "commands", "secret.md"), 0o000)
        yield* permissions.change(path.join(source, "skills", "locked"), 0o000)
        const target = path.join(directory, ".vector")
        expect(
          (yield* ConfigMigration.discover(input).pipe(Effect.provideService(FSUtil.Service, permissions.fs))).map(
            (item) => item.target,
          ),
        ).toEqual([path.join(target, "vector.jsonc"), target])
        expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
        expect(yield* fs.readFileString(path.join(target, "agents", "reviewer.md"))).toBe("reviewer")
        expect(yield* fs.exists(path.join(target, "commands", "secret.md"))).toBe(false)
        expect(yield* fs.exists(path.join(target, "skills", "locked"))).toBe(false)
        expect(yield* fs.exists(path.join(target, "vector-migration.json"))).toBe(true)
        yield* Effect.forEach([home, global], (item) => permissions.change(item, 0o755))
        expect(yield* fs.exists(path.join(home, ".vector"))).toBe(false)
        expect(yield* fs.exists(path.join(global, "vector.jsonc"))).toBe(false)
      }),
  )
}

const linkType = process.platform === "win32" ? "junction" : "dir"
// File links need a privilege on Windows, which CI runners hold; elsewhere they always work.
const fileLink = (target: string, link: string) =>
  Effect.promise(() =>
    nodeFs
      .symlink(target, link, "file")
      .then(() => true)
      .catch((error) => {
        if (process.platform === "win32" && error?.code === "EPERM") return false
        throw error
      }),
  )

it.live("never writes through a project's links or outside the workspace while importing before trust", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const outside = path.join(root, "outside")
    const workspace = path.join(root, "workspace")
    const victim = path.join(outside, "victim")
    const original = "outside bytes\n"
    yield* fs.writeWithDirs(victim, original)
    yield* fs.writeWithDirs(path.join(outside, "config.json"), '{"permission":{"bash":"deny"}}')
    const source = path.join(workspace, `.${previous}`)
    yield* fs.writeWithDirs(path.join(source, `${previous}.local.json`), '{"mcp":{"docs":{"enabled":false}}}')
    yield* fs.writeWithDirs(path.join(source, "commands", "review.md"), "review")
    // A .gitignore hard-linked to an outside file, which every OS can create without a privilege.
    yield* fs.ensureDir(path.join(workspace, ".vector"))
    yield* Effect.promise(() => nodeFs.link(victim, path.join(workspace, ".vector", ".gitignore")))
    // A project folder that is really a folder outside the workspace.
    yield* Effect.promise(() => nodeFs.symlink(outside, path.join(workspace, "sub"), linkType))
    const input = {
      directory: path.join(workspace, "sub"),
      worktree: workspace,
      home: path.join(root, "home"),
      global: path.join(root, "global"),
    }
    const imported = yield* ConfigMigration.discover(input)
    expect(imported.map((item) => item.target)).toEqual([path.join(workspace, ".vector")])
    expect(yield* fs.readFileString(victim)).toBe(original)
    expect(yield* fs.exists(path.join(outside, "vector.jsonc"))).toBe(false)
    expect(yield* fs.exists(path.join(workspace, ".vector", "vector.local.jsonc"))).toBe(false)
    expect(yield* fs.readFileString(path.join(workspace, ".vector", "commands", "review.md"))).toBe("review")

    // The same through a symbolic link, which is what a cloned repository carries.
    const linked = path.join(root, "linked")
    yield* fs.writeWithDirs(
      path.join(linked, `.${previous}`, `${previous}.local.json`),
      '{"mcp":{"docs":{"enabled":false}}}',
    )
    yield* fs.ensureDir(path.join(linked, ".vector"))
    if (!(yield* fileLink(victim, path.join(linked, ".vector", ".gitignore")))) return
    yield* fileLink(path.join(outside, "missing"), path.join(linked, "vector.jsonc"))
    yield* fs.writeFileString(path.join(linked, "earlier.json"), '{"permission":{"edit":"deny"}}')
    yield* ConfigMigration.discover({ ...input, directory: linked, worktree: linked })
    expect(yield* fs.readFileString(victim)).toBe(original)
    expect(yield* fs.exists(path.join(outside, "missing"))).toBe(false)
    expect(yield* fs.exists(path.join(linked, ".vector", "vector.local.jsonc"))).toBe(false)
    // The project's own link is left as it was rather than replaced.
    expect((yield* Effect.promise(() => nodeFs.lstat(path.join(linked, "vector.jsonc")))).isSymbolicLink()).toBe(true)
  }),
)

it.live("never imports into a global folder that is really a project link pointing out", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside")
    yield* fs.writeWithDirs(path.join(outside, "config.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.ensureDir(workspace)
    yield* Effect.promise(() => nodeFs.symlink(outside, path.join(workspace, "linked"), linkType))
    const input = { directory: workspace, worktree: workspace, home: path.join(root, "home") }
    expect(yield* ConfigMigration.discover({ ...input, global: path.join(workspace, "linked") })).toEqual([])
    expect(yield* fs.exists(path.join(outside, "vector.jsonc"))).toBe(false)
    // The same folder under another spelling of the workspace, as macOS /tmp, a symlinked checkout or an 8.3 name give.
    const alias = path.join(root, "alias")
    yield* Effect.promise(() => nodeFs.symlink(workspace, alias, linkType))
    expect(yield* ConfigMigration.discover({ ...input, global: path.join(alias, "linked") })).toEqual([])
    expect(yield* fs.exists(path.join(outside, "vector.jsonc"))).toBe(false)
    // The user's own global folder outside the project still imports.
    const imported = yield* ConfigMigration.discover({ ...input, global: outside })
    expect(imported.map((item) => item.target)).toEqual([path.join(outside, "vector.jsonc")])
  }),
)

it.live("imports folders above a non-git workspace only into themselves", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const home = path.join(root, "home")
    const parent = path.join(home, "downloads")
    const directory = path.join(parent, "app")
    const victim = path.join(root, "victim")
    const original = "outside bytes\n"
    yield* fs.writeWithDirs(victim, original)
    yield* fs.writeWithDirs(path.join(parent, "config.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeWithDirs(
      path.join(parent, `.${previous}`, `${previous}.local.json`),
      '{"mcp":{"docs":{"enabled":false}}}',
    )
    yield* fs.ensureDir(path.join(parent, ".vector"))
    yield* Effect.promise(() => nodeFs.link(victim, path.join(parent, ".vector", ".gitignore")))
    yield* fs.writeWithDirs(path.join(directory, "config.json"), '{"permission":{"edit":"deny"}}')
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.json`), '{"model":"fixture/model"}')
    const imported = yield* ConfigMigration.discover({
      directory,
      worktree: "/",
      home,
      global: path.join(root, "global"),
    })
    expect(imported.map((item) => item.target).toSorted()).toEqual(
      [
        path.join(directory, "vector.jsonc"),
        path.join(parent, "vector.jsonc"),
        path.join(home, ".vector", "vector.jsonc"),
      ].toSorted(),
    )
    expect(yield* fs.readFileString(victim)).toBe(original)
    expect(yield* fs.exists(path.join(parent, ".vector", "vector.local.jsonc"))).toBe(false)
  }),
)

it.live("imports a linked earlier folder in the home folder and keeps linked assets as links", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const shared = path.join(root, "shared")
    const directory = path.join(root, "home")
    yield* fs.writeWithDirs(path.join(shared, "earlier", `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.writeWithDirs(path.join(shared, "agent.md"), "linked agent")
    yield* fs.writeWithDirs(path.join(shared, "skills", "review", "SKILL.md"), "linked skill")
    yield* fs.writeWithDirs(path.join(shared, "earlier", "commands", "review.md"), "review")
    yield* fs.ensureDir(path.join(shared, "earlier", "agents"))
    yield* fs.ensureDir(directory)
    const source = path.join(directory, `.${previous}`)
    yield* fs.symlink(path.join(shared, "earlier"), source)
    yield* fs.symlink(path.join(shared, "agent.md"), path.join(source, "agents", "linked.md"))
    yield* fs.symlink(path.join(shared, "missing.md"), path.join(source, "agents", "broken.md"))
    yield* fs.symlink(path.join(shared, "skills"), path.join(source, "skills"))
    // Opened on a repository in the home folder, as a dotfiles setup links the home folder's earlier settings.
    const input = {
      directory: path.join(directory, "project"),
      worktree: path.join(directory, "project"),
      home: directory,
      global: path.join(root, "global"),
    }
    yield* fs.ensureDir(input.directory)
    const target = path.join(directory, ".vector")
    expect((yield* ConfigMigration.discover(input)).map((item) => item.target)).toEqual([
      path.join(target, "vector.jsonc"),
      target,
    ])
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
    expect(yield* fs.readFileString(path.join(target, "commands", "review.md"))).toBe("review")
    expect(yield* fs.readLink(path.join(target, "agents", "linked.md"))).toBe(
      yield* fs.realPath(path.join(shared, "agent.md")),
    )
    expect(yield* fs.readFileString(path.join(target, "skills", "review", "SKILL.md"))).toBe("linked skill")
    expect(yield* fs.readLink(path.join(target, "skills"))).toBe(yield* fs.realPath(path.join(shared, "skills")))
    expect(yield* fs.exists(path.join(target, "agents", "broken.md"))).toBe(false)
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    // An import interrupted before its marker is retried without treating its own links as conflicts.
    yield* fs.remove(path.join(target, "vector-migration.json"))
    expect((yield* ConfigMigration.discover(input)).map((item) => item.target)).toEqual([target])
  }),
)

// A repository can carry a link to the user's own earlier settings elsewhere. Following it would copy their keys into the
// repository before trust, so outside the home folder an earlier folder is imported only where it really lies inside the
// folder that holds it.
it.live("never copies settings through a repository's link to an earlier folder outside it", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const own = path.join(root, "own")
    const directory = path.join(root, "project")
    yield* fs.writeWithDirs(
      path.join(own, `${previous}.json`),
      '{"provider":{"fixture":{"options":{"apiKey":"placeholder-secret"}}}}',
    )
    yield* fs.writeWithDirs(path.join(own, "commands", "review.md"), "review")
    yield* fs.ensureDir(directory)
    yield* Effect.promise(() => nodeFs.symlink(own, path.join(directory, `.${previous}`), linkType))
    const input = { directory, worktree: directory, home: path.join(root, "home"), global: path.join(root, "global") }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    expect(yield* fs.exists(path.join(directory, ".vector"))).toBe(false)
    // A link that stays inside the repository still imports.
    const inner = path.join(root, "inner")
    yield* fs.writeWithDirs(path.join(inner, "config", "earlier", `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* Effect.promise(() =>
      nodeFs.symlink(path.join(inner, "config", "earlier"), path.join(inner, `.${previous}`), linkType),
    )
    const imported = yield* ConfigMigration.discover({ ...input, directory: inner, worktree: inner })
    expect(imported.map((item) => item.target)).toEqual([path.join(inner, ".vector", "vector.jsonc")])
  }),
)

// Any shared folder above a non-git workspace, such as an extracted archive or /tmp, can hold an earlier folder beside a
// linked .vector. That is not the user's to fix, so it is skipped rather than stopping Vector from starting.
it.live("skips a linked .vector beside an earlier folder that is not the home folder's", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const home = path.join(root, "home")
    const parent = path.join(home, "downloads")
    const directory = path.join(parent, "app")
    const outside = path.join(root, "outside")
    yield* fs.writeWithDirs(path.join(parent, `.${previous}`, `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.ensureDir(outside)
    yield* fs.ensureDir(directory)
    yield* Effect.promise(() => nodeFs.symlink(outside, path.join(parent, ".vector"), linkType))
    const input = { directory, worktree: "/", home, global: path.join(root, "global") }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    expect(yield* Effect.promise(() => nodeFs.readdir(outside))).toEqual([])
    // The home folder's own linked .vector still stops with the message that says what to merge.
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.json`), '{"model":"fixture/model"}')
    yield* Effect.promise(() => nodeFs.symlink(outside, path.join(home, ".vector"), linkType))
    const exit = yield* ConfigMigration.discover(input).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Cannot import into linked folder")
  }),
)

it.live("imports config-only earlier project and home folders, including runtime MCP servers", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const directory = path.join(root, "project")
    const source = path.join(directory, `.${previous}`)
    yield* fs.writeWithDirs(
      path.join(source, `${previous}.local.json`),
      JSON.stringify({
        $schema: `https://${previous}.ai/config.json`,
        mcp: { docs: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "placeholder" } } },
      }),
    )
    yield* fs.writeFileString(path.join(source, `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(source, "package.json"), `{"dependencies":{"@${previous}-ai/plugin":"1"}}`)
    yield* fs.writeFileString(path.join(source, ".gitignore"), "node_modules\npackage.json\n")
    yield* fs.writeWithDirs(path.join(source, "node_modules", "fixture", "index.js"), "")
    const home = path.join(root, "home")
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.jsonc`), '{"model":"fixture/model"}')
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, "bin", "fixture"), "")
    const input = { directory, worktree: directory, home, global: path.join(root, "global") }
    const imported = yield* ConfigMigration.discover(input)
    const target = path.join(directory, ".vector")
    expect(imported.map((item) => item.target)).toEqual([
      path.join(home, ".vector", "vector.jsonc"),
      path.join(target, "vector.jsonc"),
      path.join(target, "vector.local.jsonc"),
    ])
    expect(yield* fs.readJson(path.join(home, ".vector", "vector.jsonc"))).toMatchObject({ model: "fixture/model" })
    expect(yield* fs.exists(path.join(home, ".vector", "bin"))).toBe(false)
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
    expect(yield* fs.readJson(path.join(target, "vector.local.jsonc"))).toMatchObject({
      mcp: { docs: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "placeholder" } } },
    })
    expect(yield* fs.exists(path.join(target, "package.json"))).toBe(false)
    expect(yield* fs.exists(path.join(target, "node_modules"))).toBe(false)
    expect(yield* ConfigMigration.discover(input)).toEqual([])
  }),
)

it.live("merges neutral, prior json and jsonc settings once without changing originals", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const originals = {
      "config.json": JSON.stringify({ shell: "/bin/zsh", permission: { bash: "deny" }, model: "neutral/model" }),
      "previous.json": JSON.stringify({
        model: "json/model",
        disabled_providers: ["openai"],
        permission: { edit: "deny" },
      }),
      "previous.jsonc":
        '{\n // Keep this explanation.\n "$schema": "https://example.test/config.json",\n "model": "jsonc/model",\n "mcp": {"docs": {"type": "remote", "url": "https://example.test/mcp"}}\n}',
      "vector.jsonc": '{"$schema":"https://vectordev.ai/config.json"}',
    }
    yield* Effect.forEach(Object.entries(originals), ([file, text]) => fs.writeFileString(path.join(dir, file), text))
    const notices: unknown[] = []
    const listener = (event: { payload: unknown }) => notices.push(event.payload)
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    const result = yield* ConfigImport.run(dir)
    expect(result?.sources.map((file) => path.basename(file))).toEqual([
      "config.json",
      "previous.json",
      "previous.jsonc",
    ])
    const text = yield* fs.readFileString(path.join(dir, "vector.jsonc"))
    expect(ConfigParse.jsonc(text, "test")).toMatchObject({
      $schema: "https://vectordev.ai/config.json",
      shell: "/bin/zsh",
      model: "jsonc/model",
      disabled_providers: ["openai"],
      permission: { bash: "deny", edit: "deny" },
      mcp: { docs: { type: "remote", url: "https://example.test/mcp" } },
    })
    expect(text).toContain("Keep this explanation.")
    expect(notices).toHaveLength(1)
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(notices).toHaveLength(1)
    for (const [file, original] of Object.entries(originals).filter(([file]) => file !== "vector.jsonc")) {
      expect(yield* fs.readFileString(path.join(dir, file))).toBe(original)
    }
  }),
)

it.live("does not overwrite active Vector settings or import unrelated and credential files", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "vector.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "previous.json"), '{"permission":{"bash":"allow"}}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "vector.json"))
    yield* fs.remove(path.join(dir, "previous.json"))
    yield* fs.writeFileString(path.join(dir, "other.json"), '{"repository":"unrelated"}')
    yield* fs.writeFileString(path.join(dir, "auth.json"), '{"model":"must-not-import"}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
  }),
)

it.live("an unrelated extensionless file above a non-git workspace neither stops the import nor is imported", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    // A shared folder above a non-git workspace, as /tmp is: another program's extensionless backup of source code
    // that mentions permission sits beside a real neutral settings file.
    const shared = path.join(root, "shared")
    const directory = path.join(shared, "app")
    const backup = path.join(shared, "v03-backup-x1")
    const source = 'export const rules = {\n  permission: "ask",\n}\n'
    yield* fs.writeWithDirs(backup, source)
    yield* fs.writeWithDirs(path.join(shared, "config"), '[permission]\nedit = "deny"\n')
    yield* fs.ensureDir(directory)
    const imported = yield* ConfigMigration.discover({
      directory,
      worktree: "/",
      home: root,
      global: path.join(root, "global"),
    })
    expect(imported.map((item) => item.sources)).toEqual([[path.join(shared, "config")]])
    expect(yield* fs.readJson(path.join(shared, "vector.jsonc"))).toEqual({
      permission: { edit: "deny" },
      $schema: "https://vectordev.ai/config.json",
    })
    expect(yield* fs.readFileString(backup)).toBe(source)
  }),
)

it.live("a broken neutral settings file that names permission still stops the import", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const directory = path.join(root, "shared", "app")
    const broken = path.join(root, "shared", "config")
    yield* fs.writeWithDirs(broken, 'permission = { edit = "deny"\n')
    yield* fs.ensureDir(directory)
    const exit = yield* ConfigMigration.discover({
      directory,
      worktree: "/",
      home: root,
      global: path.join(root, "global"),
    }).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
      `Cannot import settings from ${broken}. Repair this file before starting Vector.`,
    )
    expect(yield* fs.exists(path.join(root, "shared", "vector.jsonc"))).toBe(false)
  }),
)

it.live(
  "config-shaped files of two families above a non-git workspace stop the import; one alone is imported there",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      // Today's fail-closed contract for a shared folder above a non-git workspace, as /tmp is (CI5 owner question):
      // any config-shaped JSON there is settings, whatever program wrote it.
      const shared = path.join(root, "shared")
      const directory = path.join(shared, "app")
      yield* fs.writeWithDirs(path.join(shared, "a.json"), '{"model":"x/y"}')
      yield* fs.writeWithDirs(path.join(shared, "b.json"), '{"theme":"dark"}')
      yield* fs.ensureDir(directory)
      const input = { directory, worktree: "/", home: root, global: path.join(root, "global") }
      const exit = yield* ConfigMigration.discover(input).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
        `Multiple settings files found in ${shared}.`,
      )
      expect(yield* fs.exists(path.join(shared, "vector.jsonc"))).toBe(false)
      yield* fs.remove(path.join(shared, "b.json"))
      const imported = yield* ConfigMigration.discover(input)
      expect(imported.map((item) => item.sources)).toEqual([[path.join(shared, "a.json")]])
      expect(yield* fs.readJson(path.join(shared, "vector.jsonc"))).toEqual({
        model: "x/y",
        $schema: "https://vectordev.ai/config.json",
      })
    }),
)

it.live("refuses ambiguous config families and malformed schema-identified settings", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "one.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "two.json"), '{"permission":{"bash":"allow"}}')
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Multiple settings files")
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "two.json"))
    yield* fs.writeFileString(
      path.join(dir, "one.json"),
      '{"$schema":"https://example.test/config.json","permission":123}',
    )
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Correct this config")
  }),
)

it.live("imports runtime MCP layers by filename shape in the existing config directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(
      path.join(dir, "previous.local.json"),
      '{"mcp":{"docs":{"type":"remote","url":"https://example.test/mcp"}}}',
    )
    yield* fs.writeFileString(path.join(dir, "previous.local.jsonc"), '{"mcp":{"docs":{"enabled":false}}}')
    yield* fs.writeFileString(path.join(dir, ".gitignore"), "custom-entry\n")
    expect(yield* ConfigImport.run(dir, true)).toBeDefined()
    expect(yield* fs.readFileString(path.join(dir, ".gitignore"))).toBe(
      "custom-entry\nvector.local.json\nvector.local.jsonc\n",
    )
    expect(yield* fs.readJson(path.join(dir, "vector.local.jsonc"))).toMatchObject({
      mcp: { docs: { type: "remote", url: "https://example.test/mcp", enabled: false } },
    })
    expect(yield* ConfigImport.run(dir, true)).toBeUndefined()
  }),
)

// Windows chmod cannot deny reads or directory traversal. Keep real POSIX permissions,
// and scope equivalent read failures to the FS service used by these Windows scenarios.
function readPermissions(fs: FSUtil.Interface, emulateDenials: boolean) {
  const modes = new Map<string, number>()
  const readable = (file: string) => (modes.get(path.resolve(file)) ?? 0o755) & 0o400
  const fail = (method: string, file: string) =>
    Effect.fail(systemError({ _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: file }))
  return {
    change: (file: string, mode: number) =>
      emulateDenials
        ? Effect.sync(() => {
            modes.set(path.resolve(file), mode)
          })
        : fs.chmod(file, mode),
    fs: !emulateDenials
      ? fs
      : FSUtil.Service.of({
          ...fs,
          readDirectoryEntries: (file) =>
            readable(file) ? fs.readDirectoryEntries(file) : fail("readDirectoryEntries", file),
          readFileString: (file, encoding) =>
            readable(file) ? fs.readFileString(file, encoding) : fail("readFileString", file),
          access: (file, options) =>
            options?.readable && !readable(file) ? fail("access", file) : fs.access(file, options),
        }),
  }
}
