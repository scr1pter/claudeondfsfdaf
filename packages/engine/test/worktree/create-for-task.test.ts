import { afterEach, describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { symlink } from "node:fs/promises"
import { Context, Effect, Layer, Exit, Cause } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { AppProcess } from "@vectordevai/core/process"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { GlobalBus } from "../../src/bus/global"
import { Git } from "../../src/git"
import { FileLock } from "../../src/tool/file-lock"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

interface Call {
  args: readonly string[]
  cwd?: string
  env?: Record<string, string | undefined>
}
class Calls extends Context.Service<Calls, Call[]>()("WorktreeTest.Calls") {}

// Observe the real process boundary: the checkout and Git metadata remain real.
const callsLayer = Layer.sync(Calls, () => [])
const callsNode = LayerNode.make({ service: Calls, layer: callsLayer, deps: [] })
const observedProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const original = yield* AppProcess.Service
    const calls = yield* Calls
    return AppProcess.Service.of({
      ...original,
      run: (command, options) => {
        if (command._tag === "StandardCommand" && command.command === "git") {
          calls.push({ args: command.args, cwd: command.options.cwd, env: command.options.env })
          if (command.args.includes("reset") && command.options.env?.VECTOR_TASK_TEST_RESET_FAILURE === "1")
            return Effect.succeed({
              command: "git reset",
              exitCode: 128,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("simulated checkout failure"),
              stdoutTruncated: false,
              stderrTruncated: false,
            })
        }
        return original.run(command, options)
      },
    })
  }),
).pipe(Layer.provide(Layer.merge(callsLayer, LayerNode.compile(AppProcess.node))))
const layer = LayerNode.compile(
  LayerNode.group([Worktree.node, FSUtil.node, Git.node, Project.node, InstanceStore.node, callsNode]),
  [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [AppProcess.node, observedProcess],
  ],
)
const it = testEffect(layer)

const git = Effect.fn("TaskWorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
  return result.text().trim()
})

const taskInfo = Effect.fn("TaskWorktreeTest.info")(function* () {
  const ctx = yield* InstanceState.context
  const name = `ses_${randomUUID().replaceAll("-", "")}`
  const info: Worktree.Info = {
    name,
    branch: `vector/subagent/${name}`,
    directory: path.join(Global.Path.data, "task-worktree", ctx.project.id, name),
  }
  const record = path.join(Global.Path.data, "task-isolation", ctx.project.id, name, "record.json")
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const service = yield* Git.Service
      const fs = yield* FSUtil.Service
      yield* service.run(["worktree", "remove", "--force", info.directory], { cwd: ctx.worktree })
      yield* service.run(["branch", "-D", info.branch!], { cwd: ctx.worktree })
      yield* fs.remove(path.dirname(record), { recursive: true, force: true }).pipe(Effect.orDie)
      yield* fs.remove(info.directory, { recursive: true, force: true }).pipe(Effect.orDie)
    }).pipe(Effect.orDie),
  )
  return { info, record }
})

describe("Worktree.createForTask", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "populates a seed with LFS disabled and caller env, without loading an instance or registering a sandbox",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const service = yield* Worktree.Service
        const project = yield* Project.Service
        const store = yield* InstanceStore.Service
        const calls = yield* Calls
        const { info } = yield* taskInfo()
        // Git for Windows defaults to autocrlf=true, which would check the seed out with CRLF; this compares bytes.
        yield* git(ctx.directory, ["config", "core.autocrlf", "false"])
        yield* fs.writeWithDirs(path.join(ctx.directory, "tracked.txt"), "seed content\n")
        yield* git(ctx.directory, ["add", "tracked.txt"])
        yield* git(ctx.directory, ["commit", "-m", "seed"])
        const seed = yield* git(ctx.directory, ["rev-parse", "HEAD"])
        yield* fs.writeWithDirs(path.join(ctx.directory, "tracked.txt"), "parent work in progress\n")
        const loaded = (yield* store.loaded()).map((value) => value.directory)
        const sandboxes = yield* project.sandboxes(ctx.project.id)
        const events: string[] = []
        const on = (event: { payload: { type: string } }) => events.push(event.payload.type)
        GlobalBus.on("event", on)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
        calls.length = 0

        expect(
          yield* service.createForTask(info, {
            from: seed,
            env: { VECTOR_TASK_TEST_MARKER: "inherited", GIT_LFS_SKIP_SMUDGE: "0" },
          }),
        ).toEqual(info)

        expect(yield* fs.readFileString(path.join(info.directory, "tracked.txt"))).toBe("seed content\n")
        expect(yield* fs.readFileString(path.join(ctx.directory, "tracked.txt"))).toBe("parent work in progress\n")
        expect(yield* git(info.directory, ["symbolic-ref", "--short", "HEAD"])).toBe(info.branch!)
        expect((yield* store.loaded()).map((value) => value.directory)).toEqual(loaded)
        expect(yield* project.sandboxes(ctx.project.id)).toEqual(sandboxes)
        expect(events).not.toContain(Worktree.Event.Ready.type)
        const creation = calls.filter((call) => call.env?.VECTOR_TASK_TEST_MARKER === "inherited")
        expect(creation).toHaveLength(3)
        expect(creation.every((call) => call.env?.GIT_LFS_SKIP_SMUDGE === "1")).toBe(true)
        expect(creation.every((call) => call.args.includes("core.fsmonitor=false"))).toBe(true)
        expect(creation.some((call) => call.args.includes("--no-checkout"))).toBe(true)
        if (process.platform === "win32")
          expect(creation.every((call) => call.args.includes("core.longpaths=true"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "filters only task worktrees whose registry location and branch agree with Git",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const service = yield* Worktree.Service
        const { info, record } = yield* taskInfo()
        // list() names folders by their real path, case-folded on Windows; compare where both land.
        const listed = () =>
          service
            .list()
            .pipe(
              Effect.map((items) =>
                items.some((value) => FileLock.key(value.directory) === FileLock.key(info.directory)),
              ),
            )
        yield* service.createForTask(info, { from: "HEAD" })
        expect(yield* listed()).toBe(true)
        yield* fs.writeWithDirs(record, "not json")
        expect(yield* listed()).toBe(true)
        yield* fs.writeJson(record, { directory: info.directory, branch: "vector/ordinary" })
        expect(yield* listed()).toBe(true)
        yield* fs.writeJson(record, { directory: path.dirname(info.directory), branch: info.branch })
        expect(yield* listed()).toBe(true)
        yield* fs.writeJson(record, { directory: info.directory, branch: info.branch })
        expect(yield* listed()).toBe(false)
        // Branch drift makes the stale record insufficient to hide a checkout.
        yield* git(info.directory, ["checkout", "--detach"])
        expect(yield* listed()).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "rejects a foreign location, nonreserved branch, option seed, and an existing destination before creating a branch",
    () =>
      Effect.gen(function* () {
        const service = yield* Worktree.Service
        const fs = yield* FSUtil.Service
        const { info } = yield* taskInfo()
        const root = (yield* TestInstance).directory
        const cases = [
          { info: { ...info, directory: path.join(root, "outside") }, from: "HEAD" },
          { info: { ...info, name: "../escape" }, from: "HEAD" },
          { info: { ...info, branch: "vector/ordinary" }, from: "HEAD" },
          { info, from: "--orphan" },
          { info, from: "" },
        ]
        for (const value of cases) {
          const exit = yield* Effect.exit(service.createForTask(value.info, { from: value.from }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.CreateFailedError)
        }
        yield* fs.makeDirectory(info.directory, { recursive: true })
        expect(Exit.isFailure(yield* Effect.exit(service.createForTask(info, { from: "HEAD" })))).toBe(true)
        yield* fs.remove(info.directory, { recursive: true })
        const outside = path.join(root, "outside")
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(path.join(outside, "keep.txt"), "untouched")
        yield* Effect.promise(() => symlink(outside, info.directory, process.platform === "win32" ? "junction" : "dir"))
        expect(Exit.isFailure(yield* Effect.exit(service.createForTask(info, { from: "HEAD" })))).toBe(true)
        expect(yield* fs.readFileString(path.join(outside, "keep.txt"))).toBe("untouched")
        const gitService = yield* Git.Service
        const result = yield* gitService.run(["show-ref", "--verify", `refs/heads/${info.branch}`], { cwd: root })
        expect(result.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "leaves failed population and its registry available for authoritative recovery",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const root = (yield* TestInstance).directory
        const service = yield* Worktree.Service
        const { info, record } = yield* taskInfo()
        yield* fs.makeDirectory(path.dirname(record), { recursive: true })
        yield* fs.writeJson(record, { directory: info.directory, branch: info.branch, state: "preparing" })
        const exit = yield* Effect.exit(
          service.createForTask(info, { from: "HEAD", env: { VECTOR_TASK_TEST_RESET_FAILURE: "1" } }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.CreateFailedError)
        // Git lists the real path it stored, with forward slashes and long names on Windows.
        const listed = (yield* git(root, ["worktree", "list", "--porcelain"]))
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => FileLock.key(line.slice("worktree ".length)))
        expect(listed).toContain(FileLock.key(info.directory))
        expect(yield* fs.exists(record)).toBe(true)
        expect(yield* git(info.directory, ["symbolic-ref", "--short", "HEAD"])).toBe(info.branch!)
      }),
    { git: true },
  )

  it.instance("refuses a non-Git project", () =>
    Effect.gen(function* () {
      const service = yield* Worktree.Service
      const { info } = yield* taskInfo()
      const exit = yield* Effect.exit(service.createForTask(info, { from: "HEAD" }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
    }),
  )
})
