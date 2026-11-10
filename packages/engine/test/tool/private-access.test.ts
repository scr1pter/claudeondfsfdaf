import { expect } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { AppProcess } from "@vectordevai/core/process"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionSchema } from "@vectordevai/core/session/schema"
import type { ForbiddenError } from "@vectordevai/protocol/errors"
import { FileAccess } from "@vectordevai/server/fs-access"
import { Git } from "@/git"
import { FileLock } from "@/tool/file-lock"
import { PrivateAccess } from "@/tool/private-access"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Git.node, SessionAudience.node, AppProcess.node, CrossSpawnSpawner.node])),
)

const setup = Effect.gen(function* () {
  const instance = yield* TestInstance
  const git = yield* Git.Service
  const audience = yield* SessionAudience.Service
  const parent = yield* tmpdirScoped()
  const directory = path.join(parent, "isolated")
  const id = SessionSchema.ID.create()
  const guestID = SessionSchema.ID.create()
  const ownerID = SessionSchema.ID.create()
  const branch = `vector/subagent/${id}`
  const run = Effect.fnUntraced(function* (args: string[], cwd = instance.directory) {
    const result = yield* git.run(args, { cwd })
    expect(result.exitCode).toBe(0)
    return result.text().replace(/\r?\n$/, "")
  })
  yield* Effect.promise(() =>
    fs.writeFile(path.join(instance.directory, "public.ts"), "export const publicValue = 1\n"),
  )
  yield* run(["add", "public.ts"])
  yield* run(["commit", "-m", "public fixture"])
  yield* run(["worktree", "add", "-b", branch, directory])
  yield* Effect.promise(() =>
    fs.writeFile(path.join(directory, "secret.ts"), 'export const secret = "CODE_ONLY_PRIVATE"\n'),
  )
  yield* run(["add", "secret.ts"], directory)
  yield* run(["commit", "-m", "private fixture"], directory)
  const tip = yield* run(["rev-parse", "HEAD"], directory)
  const metadata = yield* run(["rev-parse", "--absolute-git-dir"], directory)
  const common = yield* run(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const registry = path.join(parent, "task-isolation", id)
  yield* Effect.promise(() => fs.mkdir(registry, { recursive: true }))
  for (const target of [directory, metadata, registry])
    yield* audience.fenceIsolation({ sessionID: id, actor: "owner", directory: target })
  yield* audience.markGuest(guestID)
  const calls: string[][] = []
  const observed: Git.Interface = {
    ...git,
    run: (args, options) => Effect.sync(() => calls.push(args)).pipe(Effect.andThen(git.run(args, options))),
  }
  const access = PrivateAccess.make({ sessionID: guestID, audience, git: observed, instance })
  const owner = PrivateAccess.make({ sessionID: ownerID, audience, git: observed, instance })
  return {
    instance,
    git: observed,
    audience,
    access,
    owner,
    directory,
    parent,
    registry,
    common,
    metadata,
    tip,
    branch,
    run,
    calls,
  }
})

it.instance(
  "guest Git refuses code-only private history before the requested subprocess; owners can read it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const args = ["show", `${fixture.tip}:secret.ts`]
      const failure = yield* fixture.access
        .git(fixture.instance.directory, { args })
        .pipe(Effect.andThen(fixture.git.run(args, { cwd: fixture.instance.directory })), Effect.flip)
      expect(failure).toBeInstanceOf(PrivateAccess.Refused)
      expect(fixture.calls.some((args) => args.includes("show"))).toBe(false)
      expect(JSON.stringify(failure)).not.toContain(fixture.directory)
      yield* fixture.owner.git(fixture.instance.directory, { args })
      const result = yield* fixture.git.run(args, { cwd: fixture.instance.directory })
      expect(result.exitCode).toBe(0)
      expect(result.text()).toContain("CODE_ONLY_PRIVATE")
    }),
  { git: true },
)

it.instance(
  "guest file guards protect checkout, registry, metadata, ancestors and shared object bytes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      for (const file of [
        path.join(fixture.directory, "secret.ts"),
        path.join(fixture.registry, "record.json"),
        path.join(fixture.metadata, "HEAD"),
        path.join(fixture.common, "packed-refs"),
        path.join(fixture.common, "objects", fixture.tip.slice(0, 2), fixture.tip.slice(2)),
      ]) {
        expect(yield* fixture.access.read([file]).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
        yield* fixture.owner.read([file])
      }
      expect(yield* fixture.access.read([fixture.parent], { ancestors: true }).pipe(Effect.flip)).toBeInstanceOf(
        PrivateAccess.Refused,
      )
      yield* fixture.access.read([path.join(fixture.instance.directory, "public.ts")])
      const alias = path.join(fixture.parent, "alias.ts")
      yield* Effect.promise(() => fs.symlink(path.join(fixture.directory, "secret.ts"), alias))
      expect(yield* fixture.access.read([alias]).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
    }),
  { git: true },
)

it.instance(
  "actual Git routing cannot hide a private repository behind a public cwd",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const other = yield* tmpdirScoped({ git: true })
      const routes: Array<{ env?: Record<string, string>; args: string[] }> = [
        { args: ["git", "-C", fixture.instance.directory, "show", fixture.tip] },
        { args: [`--git-dir=${fixture.common}`, "show", fixture.tip] },
        { args: ["--work-tree", fixture.directory, "show", fixture.tip] },
        { env: { GIT_DIR: fixture.common }, args: ["show", fixture.tip] },
        { env: { GIT_WORK_TREE: fixture.directory }, args: ["show", fixture.tip] },
        { env: { GIT_OBJECT_DIRECTORY: path.join(fixture.common, "objects") }, args: ["show", fixture.tip] },
        {
          env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fixture.common, "objects") },
          args: ["show", fixture.tip],
        },
      ]
      for (const options of routes)
        expect(yield* fixture.access.git(other, options).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
      // A routing probe must never execute the caller's show, or their arbitrary global configuration.
      expect(fixture.calls.some((args) => args.includes("show"))).toBe(false)
      expect(
        yield* fixture.access.git(other, { args: ["-c", "alias.secret=!cat private", "secret"] }).pipe(Effect.flip),
      ).toBeInstanceOf(PrivateAccess.Refused)
    }),
  { git: true },
)

it.instance(
  "an unrelated public repository remains available to guest Git and file reads",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const other = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(other, "public.ts"), "public"))
      yield* fixture.access.read([path.join(other, "public.ts")])
      yield* fixture.access.git(other, { args: ["git", "-C", other, "show", "HEAD"] })
      const result = yield* fixture.git.run(["show", "HEAD"], { cwd: other })
      expect(result.exitCode).toBe(0)
    }),
  { git: true },
)

it.instance(
  "removing a private worktree and branch retains the guest shared-history refusal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.run(["worktree", "remove", "--force", fixture.directory])
      yield* fixture.run(["branch", "-D", fixture.branch])
      expect(
        yield* fixture.access.git(fixture.instance.directory, { args: ["show", fixture.tip] }).pipe(Effect.flip),
      ).toBeInstanceOf(PrivateAccess.Refused)
      expect(yield* fixture.access.read([path.join(fixture.common, "objects")]).pipe(Effect.flip)).toBeInstanceOf(
        PrivateAccess.Refused,
      )
      yield* fixture.owner.git(fixture.instance.directory)
      expect(yield* fixture.run(["show", `${fixture.tip}:secret.ts`])).toContain("CODE_ONLY_PRIVATE")
    }),
  { git: true },
)

it.instance(
  "output and file guards recheck durable state instead of caching earlier public results",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const file = path.join(fixture.instance.directory, "public.ts")
      yield* fixture.access.read([file])
      yield* fixture.audience.fenceIsolation({ sessionID: SessionSchema.ID.create(), actor: "owner", directory: file })
      expect(yield* fixture.access.read([file]).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
      const value = { output: `checkout: ${fixture.directory}` }
      expect(yield* fixture.owner.output(value)).toBe(value)
      expect(yield* fixture.access.output(value).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
      expect(yield* fixture.access.output(JSON.stringify(value)).pipe(Effect.flip)).toBeInstanceOf(
        PrivateAccess.Refused,
      )
      expect(yield* fixture.access.output({ output: "ordinary public result" })).toEqual({
        output: "ordinary public result",
      })
      const verifiedGuest = PrivateAccess.make({
        guest: true,
        audience: fixture.audience,
        git: fixture.git,
        instance: fixture.instance,
      })
      expect(yield* verifiedGuest.read([fixture.directory]).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
      const verifiedOwner = PrivateAccess.make({
        guest: false,
        audience: fixture.audience,
        git: fixture.git,
        instance: fixture.instance,
      })
      yield* verifiedOwner.read([fixture.directory])
    }),
  { git: true },
)

it.instance(
  "a guest may list and search the shared checkout above .git, but not its private metadata or its Git history",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      // File tools skip .git, so the task's linked metadata inside it does not make the checkout private.
      yield* fixture.access.read([fixture.instance.directory], { ancestors: true })
      yield* fixture.access.read([path.join(fixture.instance.directory, "public.ts")])
      for (const selected of [fixture.common, path.join(fixture.common, "worktrees"), fixture.metadata])
        expect(yield* fixture.access.read([selected], { ancestors: true }).pipe(Effect.flip)).toBeInstanceOf(
          PrivateAccess.Refused,
        )
      // Git shares one object store and ref namespace with the private worktree, so every guest Git command in this
      // repository is refused, read-only ones included (a conservative rule; see the WP28 deviations).
      for (const args of [["status"], ["log", "--all", "--oneline"], ["worktree", "list"]])
        expect(yield* fixture.access.git(fixture.instance.directory, { args }).pipe(Effect.flip)).toBeInstanceOf(
          PrivateAccess.Refused,
        )
      // Settings the command itself adds cannot steer the probe to another repository.
      expect(
        yield* fixture.access
          .git(fixture.instance.directory, { env: { GIT_CONFIG_COUNT: "1" }, args: ["status"] })
          .pipe(Effect.flip),
      ).toBeInstanceOf(PrivateAccess.Refused)
    }),
  { git: true },
)

it.live("a macOS file-lock key, folded on a case-insensitive volume, is still recognised as private", () =>
  Effect.gen(function* () {
    const parent = yield* tmpdirScoped()
    const directory = path.join(parent, "Task-Worktree", "Ses_Mixed")
    yield* Effect.promise(() => fs.mkdir(path.join(directory, "src"), { recursive: true }))
    yield* Effect.acquireRelease(
      Effect.sync(() => FileLock.useProbe(() => true)),
      () => Effect.sync(() => FileLock.useProbe()),
    )
    const audience = SessionAudience.make(yield* Database.Service, "darwin")
    yield* audience.fenceIsolation({ sessionID: "ses_mac_folded", actor: "owner", directory })
    // PrivateAccess asks with FileLock keys; on such a volume they are the lowercased real path.
    const key = FileLock.key(path.join(directory, "src", "secret.ts"), "darwin")
    expect(key).toBe(key.toLowerCase())
    expect(yield* audience.isPrivateDirectory(key)).toBe(true)
    expect(yield* audience.overlapsPrivateDirectory(FileLock.key(parent, "darwin"))).toBe(true)
    expect(yield* audience.containsPrivateText(`cat ${key}`)).toBe(true)
  }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
)

it.instance(
  "the server's file guard compares Git's common directory folded on macOS, so a .GIT spelling reaches no shared bytes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const appProcess = yield* AppProcess.Service
      const object = (folder: string) =>
        path.join(fixture.instance.directory, folder, "objects", fixture.tip.slice(0, 2), fixture.tip.slice(2))
      const outcome = (read: Effect.Effect<void, ForbiddenError>) =>
        read.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "allowed" }))
      const linux = FileAccess.make({ audience: fixture.audience, process: appProcess, platform: "linux" })
      expect(yield* outcome(linux(object(".git"), false))).toBe("ForbiddenError")
      // On a case-sensitive file system .GIT is another, absent folder. On a host that ignores case (Windows here) it
      // is the shared .git under another spelling, and stays guarded.
      const distinct = !existsSync(path.join(fixture.instance.directory, ".GIT"))
      expect(yield* outcome(linux(object(".GIT"), false))).toBe(distinct ? "allowed" : "ForbiddenError")
      yield* Effect.gen(function* () {
        // On a volume that ignores case .GIT is the shared .git, while Git prints its common directory as ".git".
        const audience = SessionAudience.make(yield* Database.Service, "darwin")
        yield* audience.fenceIsolation({ sessionID: "ses_mac_common", actor: "owner", directory: fixture.metadata })
        const mac = FileAccess.make({ audience, process: appProcess, platform: "darwin" })
        for (const file of [
          object(".GIT"),
          path.join(fixture.instance.directory, ".GIT", "refs", "heads", fixture.branch),
        ])
          expect(yield* outcome(mac(file, false)), file).toBe("ForbiddenError")
        expect(yield* outcome(mac(object(".GIT"), true))).toBe("allowed")
        expect(yield* outcome(mac(path.join(fixture.instance.directory, "public.ts"), false))).toBe("allowed")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")))
    }),
  { git: true },
)

// Before isolation is first used no private root exists, so nothing a guest reads can overlap one, and the guards run no
// Git probe: a host where Git cannot run (not installed, a macOS stub without the Command Line Tools) still serves
// guests. Once a root exists, a probe that Git cannot answer refuses.
it.instance(
  "with no private root anywhere, guest guards need no Git; once one exists, an unanswered probe refuses",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const git = yield* Git.Service
      const appProcess = yield* AppProcess.Service
      const empty = yield* tmpdirScoped()
      const file = path.join(instance.directory, "notes.txt")
      yield* Effect.promise(() => fs.writeFile(file, "public"))
      yield* Effect.gen(function* () {
        const audience = SessionAudience.make(yield* Database.Service)
        const guestID = SessionSchema.ID.create()
        yield* audience.markGuest(guestID)
        const access = PrivateAccess.make({ sessionID: guestID, audience, git, instance })
        const server = FileAccess.make({ audience, process: appProcess })
        // Git cannot run: the only folder on PATH is empty.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.PATH
            process.env.PATH = empty
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              process.env.PATH = previous
            }),
        )
        yield* access.read([file])
        yield* access.read([instance.directory], { ancestors: true })
        yield* access.git(instance.directory, { args: ["status"] })
        yield* server(file, false)
        yield* audience.fenceIsolation({ sessionID: SessionSchema.ID.create(), actor: "owner", directory: empty })
        expect(yield* access.read([file]).pipe(Effect.flip)).toBeInstanceOf(PrivateAccess.Refused)
        expect((yield* server(file, false).pipe(Effect.flip))._tag).toBe("ForbiddenError")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")))
    }),
)

// A Linux machine with the German locale sources can make Git answer in German, as it does for a user whose desktop
// runs in German: a locale built into a private folder (LOCPATH) and a one-message catalog (GIT_TEXTDOMAINDIR).
const translatable =
  process.platform === "linux" && Bun.which("localedef") !== null && existsSync("/usr/share/i18n/locales/de_DE")
const NOT_A_REPOSITORY = "not a git repository (or any of the parent directories): %s"

;(translatable ? it.instance : it.instance.skip)(
  "guest Git discovery recognises a folder outside any repository whatever language Git speaks",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const appProcess = yield* AppProcess.Service
      const languages = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(languages, "locales"))
        await fs.mkdir(path.join(languages, "messages", "de", "LC_MESSAGES"), { recursive: true })
        await fs.writeFile(
          path.join(languages, "messages", "de", "LC_MESSAGES", "git.mo"),
          catalog({
            "": "Content-Type: text/plain; charset=UTF-8\n",
            [NOT_A_REPOSITORY]: "Kein Git-Repository (oder irgendeines der Elternverzeichnisse): %s",
          }),
        )
      })
      const built = Bun.spawnSync([
        "localedef",
        "-i",
        "de_DE",
        "-f",
        "UTF-8",
        path.join(languages, "locales", "de_DE.UTF-8"),
      ])
      expect(built.exitCode).toBe(0)
      const language = {
        LOCPATH: path.join(languages, "locales"),
        LC_ALL: "de_DE.UTF-8",
        LANGUAGE: "de",
        GIT_TEXTDOMAINDIR: path.join(languages, "messages"),
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = Object.fromEntries(Object.keys(language).map((key) => [key, process.env[key]]))
          Object.assign(process.env, language)
          return saved
        }),
        (saved) =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key]
              if (value !== undefined) process.env[key] = value
            }
          }),
      )
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "notes.txt"), "public"))
      // Git now answers in German here, as the engine's own environment would make it.
      const answer = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: outside, env: process.env })
      expect(answer.stderr.toString()).toContain("Kein Git-Repository")
      yield* fixture.access.read([path.join(outside, "notes.txt")])
      yield* fixture.access.git(outside, { args: ["status"] })
      yield* FileAccess.make({ audience: fixture.audience, process: appProcess })(
        path.join(outside, "notes.txt"),
        false,
      )
      // The private repository stays refused.
      expect(
        yield* fixture.access.git(fixture.instance.directory, { args: ["status"] }).pipe(Effect.flip),
      ).toBeInstanceOf(PrivateAccess.Refused)
    }),
  { git: true },
)

/** A GNU message catalog (.mo) holding `messages`, sorted by message ID as the format requires. */
function catalog(messages: Record<string, string>) {
  const encoder = new TextEncoder()
  const ids = Object.keys(messages).sort()
  const originals = ids.map((id) => encoder.encode(id))
  const translations = ids.map((id) => encoder.encode(messages[id]))
  const start = 28 + ids.length * 16
  const length = (items: Uint8Array[]) => items.reduce((sum, item) => sum + item.length + 1, 0)
  const buffer = Buffer.alloc(start + length(originals) + length(translations))
  buffer.writeUInt32LE(0x950412de, 0)
  buffer.writeUInt32LE(ids.length, 8)
  buffer.writeUInt32LE(28, 12)
  buffer.writeUInt32LE(28 + ids.length * 8, 16)
  ;[originals, translations].reduce((offset, items, table) => {
    return items.reduce((at, item, index) => {
      buffer.writeUInt32LE(item.length, 28 + table * ids.length * 8 + index * 8)
      buffer.writeUInt32LE(at, 28 + table * ids.length * 8 + index * 8 + 4)
      buffer.set(item, at)
      return at + item.length + 1
    }, offset)
  }, start)
  return buffer
}
