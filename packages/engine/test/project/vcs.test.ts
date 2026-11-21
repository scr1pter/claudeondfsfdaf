import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppProcess } from "@vectordevai/core/process"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

// Counts the git processes each working folder starts and how many are still running, at the process boundary.
const gitProcesses = new Map<string, { started: number; running: number }>()
const countedProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const original = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...original,
      run: (command, options) => {
        if (command._tag !== "StandardCommand" || command.command !== "git") return original.run(command, options)
        const count = gitProcesses.get(command.options.cwd ?? "") ?? { started: 0, running: 0 }
        gitProcesses.set(command.options.cwd ?? "", count)
        return Effect.suspend(() => {
          count.started++
          count.running++
          return original.run(command, options)
        }).pipe(Effect.ensuring(Effect.sync(() => count.running--)))
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
const countedIt = testEffect(
  LayerNode.compile(LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [AppProcess.node, countedProcess],
  ]),
)

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const output = Effect.fn("VcsTest.output")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  return result.text().trim()
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs init", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  // The lookup's git runs with the checkout as its working folder. When init only forked it, the boot returned with that
  // git still running outside the instance, so nothing waited for it before the folder was removed (Windows EBUSY).
  countedIt.instance(
    "init() returns only after the branch lookup's git has exited",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* init()

        expect(gitProcesses.get(test.directory)?.started).toBeGreaterThan(0)
        expect(gitProcesses.get(test.directory)?.running).toBe(0)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
})

describe("Vcs raw diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "diffRaw() includes staged files before the first commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // An orphan branch has no commit yet, like a repository just made with `git init`.
        yield* git(test.directory, ["checkout", "--orphan", "fresh"])
        yield* write(path.join(test.directory, "staged.txt"), "staged\n")
        yield* write(path.join(test.directory, "loose.txt"), "loose\n")
        yield* git(test.directory, ["add", "staged.txt"])

        const vcs = yield* init()
        const raw = yield* vcs.diffRaw()

        expect(raw).toContain("+++ b/staged.txt")
        expect(raw).toContain("+staged")
        expect(raw).toContain("+++ b/loose.txt")
      }),
    { git: true },
  )

  worktreeIt.live("diffRaw() includes new files when the project is a folder inside the repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const sub = path.join(tmp, "packages", "app")
      yield* write(path.join(sub, "tracked.txt"), "before\n")
      yield* git(tmp, ["add", "."])
      yield* git(tmp, ["commit", "--no-gpg-sign", "-m", "add app"])
      yield* write(path.join(sub, "tracked.txt"), "after\n")
      yield* write(path.join(sub, "new.txt"), "new\n")

      const raw = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* vcs.diffRaw()
      }).pipe(provideInstance(sub))

      expect(raw).toContain("+after")
      expect(raw).toContain("+++ b/packages/app/new.txt")
      expect(raw).toContain("+new")
    }),
  )
})

describe("Vcs branches", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

  it.instance(
    "branches() lists local branches and marks the current one",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["branch", "feature/one"])
        yield* git(test.directory, ["branch", "two"])

        const vcs = yield* init()
        const list = yield* vcs.branches()

        expect(list.current).toBe("main")
        expect(list.branches.map((item) => item.name).toSorted()).toEqual(["feature/one", "main", "two"])
        expect(list.branches.find((item) => item.name === "main")).toMatchObject({ current: true })
        expect(list.branches.find((item) => item.name === "two")).toMatchObject({ current: false })
        expect(list.branches.every((item) => item.checkedOutElsewhere === undefined)).toBe(true)
      }),
    { git: true },
  )

  it.instance("branches() is empty for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      expect(yield* vcs.branches()).toEqual({ current: undefined, branches: [] })
    }),
  )

  it.instance(
    "switchBranch() switches to an existing branch and publishes the new branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["branch", "feature/two"])

        const vcs = yield* init()
        expect(yield* vcs.branch()).toBe("main")
        const pending = yield* nextBranchUpdate()

        const info = yield* vcs.switchBranch({ branch: "feature/two" })

        expect(info.branch).toBe("feature/two")
        expect(yield* vcs.branch()).toBe("feature/two")
        expect(yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))).toBe("feature/two")
        expect((yield* vcs.branches()).current).toBe("feature/two")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() creates a branch from HEAD and keeps uncommitted work",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        const file = path.join(test.directory, "draft.txt")
        yield* write(file, "work in progress\n")

        const vcs = yield* init()
        const info = yield* vcs.switchBranch({ branch: "agent/new-idea", create: true })

        expect(info.branch).toBe("agent/new-idea")
        expect(yield* vcs.branch()).toBe("agent/new-idea")
        expect(yield* read(file)).toBe("work in progress\n")
        expect((yield* vcs.branches()).branches.map((item) => item.name)).toContain("main")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() refuses when uncommitted changes would be overwritten",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        const file = path.join(test.directory, "shared.txt")
        yield* write(file, "one\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "one"])
        yield* git(test.directory, ["switch", "-c", "other"])
        yield* write(file, "two\n")
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-am", "two"])
        yield* git(test.directory, ["switch", "main"])
        yield* write(file, "local edit\n")

        const vcs = yield* init()
        const error = yield* vcs.switchBranch({ branch: "other" }).pipe(Effect.flip)

        expect(error.reason).toBe("dirty")
        expect(error.message).toContain("shared.txt")
        expect(error.message).not.toContain("error:")
        expect(error.message).not.toContain("Aborting")
        expect(yield* vcs.branch()).toBe("main")
        expect(yield* read(file)).toBe("local edit\n")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() refuses to overwrite an ignored file that the target branch tracks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["switch", "-c", "other"])
        yield* write(path.join(test.directory, ".env"), "tracked-on-other\n")
        yield* git(test.directory, ["add", ".env"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "track env"])
        yield* git(test.directory, ["switch", "main"])
        yield* write(path.join(test.directory, ".gitignore"), ".env\n")
        yield* write(path.join(test.directory, ".env"), "SECRET=local\n")

        const vcs = yield* init()
        const error = yield* vcs.switchBranch({ branch: "other" }).pipe(Effect.flip)

        expect(error.reason).toBe("dirty")
        expect(error.message).toContain(".env")
        expect(error.message).not.toContain("error:")
        expect(error.message).not.toContain("Aborting")
        expect(yield* vcs.branch()).toBe("main")
        expect(yield* read(path.join(test.directory, ".env"))).toBe("SECRET=local\n")
      }),
    { git: true },
  )

  it.instance(
    "branches() and switchBranch() handle a tag named like the current branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "v1"])
        yield* git(test.directory, ["branch", "other"])
        yield* git(test.directory, ["tag", "v1"])

        const vcs = yield* init()
        expect(yield* vcs.branch()).toBe("v1")
        const list = yield* vcs.branches()
        expect(list.current).toBe("v1")
        expect(list.branches.find((item) => item.name === "v1")).toEqual({ name: "v1", current: true })

        expect((yield* vcs.switchBranch({ branch: "v1" })).branch).toBe("v1")
        expect((yield* vcs.switchBranch({ branch: "other" })).branch).toBe("other")
        expect((yield* vcs.switchBranch({ branch: "v1" })).branch).toBe("v1")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() refuses to leave detached commits behind but may branch from them",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["branch", "feat"])
        yield* git(test.directory, ["switch", "--detach", "HEAD"])

        const vcs = yield* init()
        expect((yield* vcs.switchBranch({ branch: "feat" })).branch).toBe("feat")
        yield* git(test.directory, ["switch", "--detach", "HEAD"])
        yield* write(path.join(test.directory, "lost.txt"), "only here\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "detached work"])
        const head = yield* output(test.directory, ["rev-parse", "HEAD"])

        const error = yield* vcs.switchBranch({ branch: "main" }).pipe(Effect.flip)
        expect(error.reason).toBe("detached")
        expect(error.message).toContain("1 commit")
        expect(yield* output(test.directory, ["rev-parse", "HEAD"])).toBe(head)

        expect((yield* vcs.switchBranch({ branch: "keep-work", create: true })).branch).toBe("keep-work")
        expect(yield* output(test.directory, ["rev-parse", "keep-work"])).toBe(head)
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() only creates branches in a Vector-managed agent workspace",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["switch", "-c", "vector-parallel/fix-header-1a2b3c4d"])

        const vcs = yield* init()
        const error = yield* vcs.switchBranch({ branch: "main" }).pipe(Effect.flip)
        expect(error.reason).toBe("managed")
        expect(error.message).toContain("managed by Vector")
        expect(yield* vcs.branch()).toBe("vector-parallel/fix-header-1a2b3c4d")

        expect((yield* vcs.switchBranch({ branch: "fix-header-v2", create: true })).branch).toBe("fix-header-v2")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() refuses a branch checked out in another worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const wt = yield* tmpdirScoped()
        const dir = path.join(wt, "elsewhere")
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["worktree", "add", "-b", "busy", dir, "HEAD"])

        const vcs = yield* init()
        const list = yield* vcs.branches()
        const busy = list.branches.find((item) => item.name === "busy")
        expect(busy?.current).toBe(false)
        expect(busy?.checkedOutElsewhere).toBeDefined()
        expect(yield* Effect.promise(() => fs.realpath(busy?.checkedOutElsewhere ?? ""))).toBe(
          yield* Effect.promise(() => fs.realpath(dir)),
        )

        const error = yield* vcs.switchBranch({ branch: "busy" }).pipe(Effect.flip)
        expect(error.reason).toBe("checked-out-elsewhere")
        expect(yield* vcs.branch()).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "switchBranch() rejects invalid, unknown and duplicate names",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["branch", "taken"])
        const vcs = yield* init()

        const invalid = yield* Effect.forEach(["bad..name", "-x", "@{-1}", "HEAD", "with space", ""], (branch) =>
          vcs.switchBranch({ branch, create: true }).pipe(Effect.flip),
        )
        expect(invalid.map((error) => error.reason)).toEqual(Array(6).fill("invalid-name"))

        expect((yield* vcs.switchBranch({ branch: "missing" }).pipe(Effect.flip)).reason).toBe("not-found")
        expect((yield* vcs.switchBranch({ branch: "taken", create: true }).pipe(Effect.flip)).reason).toBe("exists")
        expect(yield* vcs.branch()).toBe("main")
      }),
    { git: true },
  )
})
