import { afterEach, expect, test } from "bun:test"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { Worktree } from "@/worktree"
import { Npm } from "@vectordevai/core/npm"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Bootstrap is independently covered by the real LSP/MCP/snapshot isolation files. These tests use real Git,
// instances, sessions, agents and jobs, and never invoke a model or a package installation.
const bootstrap = Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })
// TaskIsolation.make, which some tests run with a service replaced, closes a retiring checkout's terminals in these
// location services: the shared layer, so the same instance its node gets.
const locations = LayerNode.make({ service: LocationServiceMap.Service, layer: locationServiceMapLayer, deps: [] })
const layer = AppNodeBuilder.build(
  LayerNode.group([
    TaskIsolation.node,
    locations,
    Worktree.node,
    InstanceStore.node,
    Session.node,
    SessionRunState.node,
    BackgroundJob.node,
    Git.node,
    Agent.node,
    Config.node,
    CrossSpawnSpawner.node,
    SessionAudience.node,
    Database.node,
  ]),
  [
    [InstanceStore.bootstrapNode, bootstrap],
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
  ],
)
const it = testEffect(layer)
afterEach(() => disposeAllInstances())

const git = Effect.fn("IsolationTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.text().trim()
})
const write = (directory: string, file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })
const contents = (directory: string, file: string) =>
  Effect.promise(() => fs.readFile(path.join(directory, file), "utf8"))
const exists = (file: string | undefined) =>
  Effect.promise(() =>
    file
      ? fs.access(file).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false),
  )
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
  Effect.gen(function* () {
    const exit = yield* effect.pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code })
  })

const fixture = Effect.gen(function* () {
  const home = yield* InstanceState.context
  // Git for Windows defaults to autocrlf=true, so the task checkout, and a merge's checkout bytes, would turn LF into
  // CRLF. These tests compare exact bytes, so pin LF; "autocrlf merges use checkout bytes…" turns it on itself.
  if (home.project.vcs === "git") yield* git(home.directory, ["config", "core.autocrlf", "false"])
  const sessions = yield* Session.Service
  const isolation = yield* TaskIsolation.Service
  const agents = yield* Agent.Service
  const parent = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: parent.id })
  const agent = yield* agents.get("general")
  const recordPath = path.join(Global.Path.data, "task-isolation", home.project.id, child.id, "record.json")
  const workPath = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.disposeDirectory(workPath)
      const service = yield* Git.Service
      yield* service.run(["worktree", "remove", "--force", workPath], { cwd: home.directory })
      yield* service.run(["branch", "-D", `vector/subagent/${child.id}`], { cwd: home.directory })
      yield* Effect.promise(async () => {
        await fs.rm(workPath, { recursive: true, force: true })
        await fs.rm(path.dirname(recordPath), { recursive: true, force: true })
      })
      TaskClaims.unprotect(child.id)
      TaskPlace.drop(child.id)
      TaskPlace.drop(parent.id)
    }).pipe(Effect.orDie),
  )
  const reserve = () => isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Fixture", agent })
  const start = Effect.gen(function* () {
    yield* reserve()
    return yield* isolation.start(child.id)
  })
  const settle = () => isolation.settle({ taskID: child.id, attempt: 1 })
  return { home, sessions, isolation, parent, child, agent, recordPath, workPath, reserve, start, settle }
})

const smallCapture = {
  fileBytes: 100,
  minFreeBytes: 0,
  copyBytes: 1024 * 1024,
  copyFiles: 20_000,
  patchBytes: 256 * 1024,
}

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  it.instance(
    `Git ${flag} cannot hide supported capture or a later unsaved write`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "flagged.txt", "original\n")
        yield* git(f.home.directory, ["add", "flagged.txt"])
        yield* git(f.home.directory, ["commit", "-m", "flag baseline"])
        yield* f.start
        yield* git(f.workPath, ["update-index", flag, "flagged.txt"])
        yield* write(f.workPath, "flagged.txt", "captured\n")
        const saved = yield* f.settle()
        expect(saved.state).toBe("changed")
        expect(yield* git(f.workPath, ["show", `${saved.tip}:flagged.txt`])).toBe("captured")
        yield* git(f.workPath, ["update-index", flag, "flagged.txt"])
        yield* write(f.workPath, "flagged.txt", "late write\n")
        yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "unsaved")
        yield* failure(f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }), "unsaved")
        expect(yield* contents(f.workPath, "flagged.txt")).toBe("late write\n")
        expect(yield* contents(f.home.directory, "flagged.txt")).toBe("original\n")
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: true },
  )

  it.instance(
    `Git ${flag} cannot hide changed oversized baseline bytes`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "flagged.txt", "x".repeat(101))
        yield* git(f.home.directory, ["add", "flagged.txt"])
        yield* git(f.home.directory, ["commit", "-m", "large flag baseline"])
        yield* f.start
        yield* git(f.workPath, ["update-index", flag, "flagged.txt"])
        yield* write(f.workPath, "flagged.txt", "y".repeat(101))
        expect((yield* f.settle()).state).toBe("failed")
        expect(yield* contents(f.workPath, "flagged.txt")).toBe("y".repeat(101))
        expect(yield* contents(f.home.directory, "flagged.txt")).toBe("x".repeat(101))
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: true },
  )

  it.instance(
    `Git seed captures ${flag} parent bytes without changing the parent index`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "flagged.txt", "original\n")
        yield* git(f.home.directory, ["add", "flagged.txt"])
        yield* git(f.home.directory, ["commit", "-m", "parent flag baseline"])
        yield* git(f.home.directory, ["update-index", flag, "flagged.txt"])
        yield* write(f.home.directory, "flagged.txt", "parent WIP\n")
        const index = path.resolve(f.home.directory, yield* git(f.home.directory, ["rev-parse", "--git-path", "index"]))
        const before = yield* Effect.promise(() => fs.readFile(index))
        yield* f.start
        expect(yield* contents(f.workPath, "flagged.txt")).toBe("parent WIP\n")
        expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
      }),
    { git: true },
  )
}

it.instance(
  "Git seed preserves absent sparse entries without changing the parent index",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "sparse.txt", "tracked baseline\n")
      yield* git(f.home.directory, ["add", "sparse.txt"])
      yield* git(f.home.directory, ["commit", "-m", "sparse baseline"])
      yield* git(f.home.directory, ["update-index", "--skip-worktree", "sparse.txt"])
      yield* Effect.promise(() => fs.unlink(path.join(f.home.directory, "sparse.txt")))
      const index = path.resolve(f.home.directory, yield* git(f.home.directory, ["rev-parse", "--git-path", "index"]))
      const before = yield* Effect.promise(() => fs.readFile(index))
      yield* f.start
      expect(yield* contents(f.workPath, "sparse.txt")).toBe("tracked baseline\n")
      expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
      expect((yield* f.settle()).state).toBe("unchanged")
    }),
  { git: true },
)

for (const file of ["normalized.txt", "__proto__"])
  it.instance(
    `Git unchanged oversized CRLF ${file} bytes preserve their raw baseline through Git normalization`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, ".gitattributes", `${file} text eol=crlf\n`)
        yield* write(f.home.directory, file, "line\r\n".repeat(20))
        yield* git(f.home.directory, ["add", ".gitattributes", file])
        yield* git(f.home.directory, ["commit", "-m", "CRLF baseline"])
        yield* f.start
        expect(yield* contents(f.workPath, file)).toBe("line\r\n".repeat(20))
        expect((yield* f.settle()).state).toBe("unchanged")
        expect(yield* exists(f.workPath)).toBe(false)
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: true },
  )

it.instance("copy files named __proto__, constructor and toString can be captured and merged", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.start
    for (const file of ["__proto__", "constructor", "toString"]) yield* write(f.workPath, file, "captured\n")
    expect((yield* f.settle()).state).toBe("changed")
    yield* f.isolation.merge({ taskID: f.child.id, files: ["__proto__"], by: { kind: "owner" } })
    yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
    yield* write(f.workPath, "__proto__", "follow-up\n")
    expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })).state).toBe("changed")
    yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
    expect(yield* contents(f.home.directory, "__proto__")).toBe("follow-up\n")
    expect(yield* contents(f.home.directory, "constructor")).toBe("captured\n")
    expect(yield* contents(f.home.directory, "toString")).toBe("captured\n")
  }),
)

for (const change of ["delete", "shrink"]) {
  it.instance(`copy oversized baseline ${change} retains the original recoverable bytes`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "large.txt", "x".repeat(101))
      yield* f.start
      if (change === "delete") yield* Effect.promise(() => fs.unlink(path.join(f.workPath, "large.txt")))
      else yield* write(f.workPath, "large.txt", "smaller\n")
      expect((yield* f.settle()).state).toBe("failed")
      expect(yield* exists(f.workPath)).toBe(true)
      expect(yield* contents(f.home.directory, "large.txt")).toBe("x".repeat(101))
      expect(yield* contents(path.dirname(f.recordPath), "baseline/large.txt")).toBe("x".repeat(101))
    }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
  )
}

if (process.platform !== "win32") {
  it.instance("copy new __proto__ symlink output is retained instead of silently excluded", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.start
      yield* Effect.promise(() => fs.symlink("missing-target", path.join(f.workPath, "__proto__")))
      expect((yield* f.settle()).state).toBe("failed")
      expect(yield* Effect.promise(() => fs.readlink(path.join(f.workPath, "__proto__")))).toBe("missing-target")
      yield* f.isolation.enqueue(f.child.id)
      expect(yield* f.isolation.sweep({ force: true })).toEqual([])
    }),
  )

  for (const change of ["new", "changed", "deleted"]) {
    it.instance(`copy ${change} symlink output is retained instead of silently excluded`, () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "target.txt", "target\n")
        if (change !== "new")
          yield* Effect.promise(() => fs.symlink("target.txt", path.join(f.home.directory, "link.txt")))
        yield* f.start
        if (change !== "new") yield* Effect.promise(() => fs.unlink(path.join(f.workPath, "link.txt")))
        if (change !== "deleted")
          yield* Effect.promise(() =>
            fs.symlink(change === "new" ? "target.txt" : "other.txt", path.join(f.workPath, "link.txt")),
          )
        expect((yield* f.settle()).state).toBe("failed")
        expect(yield* exists(f.workPath)).toBe(true)
        yield* failure(f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }), "unsaved")
        if (change !== "deleted")
          expect(yield* Effect.promise(() => fs.readlink(path.join(f.workPath, "link.txt")))).toBe(
            change === "new" ? "target.txt" : "other.txt",
          )
      }),
    )
  }

  it.instance("copy unchanged inherited links remain allowed after partial merge and resume", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "target.txt", "target\n")
      yield* Effect.promise(() => fs.symlink("target.txt", path.join(f.home.directory, "link.txt")))
      yield* f.start
      yield* write(f.workPath, "one.txt", "one\n")
      yield* write(f.workPath, "two.txt", "two\n")
      yield* f.settle()
      yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
      yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
      const result = yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
      expect(result.state).toBe("changed")
      yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* contents(f.home.directory, "two.txt")).toBe("two\n")
      expect(yield* Effect.promise(() => fs.readlink(path.join(f.home.directory, "link.txt")))).toBe("target.txt")
    }),
  )
}

for (const gitProject of [true, false]) {
  it.instance(
    `${gitProject ? "Git" : "copy"} unchanged pre-existing oversized bytes allow intentional unchanged cleanup`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "large-baseline.bin", "x".repeat(101))
        if (gitProject) {
          yield* git(f.home.directory, ["add", "large-baseline.bin"])
          yield* git(f.home.directory, ["commit", "-m", "large baseline"])
        }
        yield* f.start
        expect((yield* f.settle()).state).toBe("unchanged")
        expect(yield* exists(f.workPath)).toBe(false)
        expect(yield* contents(f.home.directory, "large-baseline.bin")).toBe("x".repeat(101))
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: gitProject },
  )

  it.instance(
    `${gitProject ? "Git" : "copy"} changed pre-existing oversized bytes are retained even when their size stays equal`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "large-baseline.bin", "x".repeat(101))
        if (gitProject) {
          yield* git(f.home.directory, ["add", "large-baseline.bin"])
          yield* git(f.home.directory, ["commit", "-m", "large baseline"])
        }
        yield* f.start
        yield* write(f.workPath, "large-baseline.bin", "y".repeat(101))
        expect((yield* f.settle()).state).toBe("failed")
        expect(yield* contents(f.workPath, "large-baseline.bin")).toBe("y".repeat(101))
        expect(yield* contents(f.home.directory, "large-baseline.bin")).toBe("x".repeat(101))
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: gitProject },
  )

  it.instance(
    `${gitProject ? "Git" : "copy"} late oversized output blocks full merge, discard and sweep before any parent write`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.start
        yield* write(f.workPath, "supported.txt", "supported\n")
        expect((yield* f.settle()).state).toBe("changed")
        yield* write(f.workPath, "late.bin", "x".repeat(101))
        yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "unsupported")
        expect(yield* exists(path.join(f.home.directory, "supported.txt"))).toBe(false)
        yield* failure(f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }), "unsaved")
        yield* f.isolation.enqueue(f.child.id)
        expect(yield* f.isolation.sweep({ force: true })).toEqual([])
        expect(yield* contents(f.workPath, "late.bin")).toBe("x".repeat(101))
        expect(yield* contents(f.workPath, "supported.txt")).toBe("supported\n")
      }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
    { git: gitProject },
  )
}

it.instance(
  "initial ignored oversized inputs remain intentionally excluded from the Git checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, ".gitignore", "ignored.bin\n")
      yield* write(f.home.directory, "ignored.bin", "x".repeat(101))
      yield* f.start
      expect(yield* exists(path.join(f.workPath, "ignored.bin"))).toBe(false)
      expect((yield* f.settle()).state).toBe("unchanged")
      expect(yield* contents(f.home.directory, "ignored.bin")).toBe("x".repeat(101))
    }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
  { git: true },
)

it.instance(
  "normal settlement disables root post-commit hooks while actually saving supported files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.start
      yield* write(f.workPath, "post-commit", "#!/bin/sh\ntouch hook-ran\n")
      yield* Effect.promise(() => fs.chmod(path.join(f.workPath, "post-commit"), 0o755))
      yield* git(f.workPath, ["config", "core.hooksPath", "."])
      yield* write(f.workPath, "normal.txt", "normal\n")
      const result = yield* f.settle()
      expect(result.state).toBe("changed")
      expect(result.tip).not.toBe(result.seed)
      expect(yield* exists(path.join(f.workPath, "hook-ran"))).toBe(false)
    }),
  { git: true },
)

it.instance("retains an oversized copy replacement instead of deleting the parent's small baseline file", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* write(f.home.directory, "existing.txt", "small baseline\n")
    yield* f.start
    yield* write(f.workPath, "existing.txt", "x".repeat(101))
    const saved = yield* f.settle()
    if (saved.state === "changed") yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
    expect(yield* contents(f.home.directory, "existing.txt")).toBe("small baseline\n")
    expect(saved.state).toBe("failed")
    expect(yield* contents(f.workPath, "existing.txt")).toBe("x".repeat(101))
    expect(saved.error).toContain("retained")
    yield* write(f.workPath, "existing.txt", "recovered\n")
    const recovered = yield* f.isolation.reconcile(f.child.id)
    expect(recovered.state).toBe("changed")
    expect(recovered.error).toBeUndefined()
    yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
    expect(yield* contents(f.home.directory, "existing.txt")).toBe("recovered\n")
  }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
)

it.instance(
  "retains an only oversized Git output instead of removing it as unchanged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.start
      yield* write(f.workPath, "only-output.bin", "x".repeat(101))
      const saved = yield* f.settle()
      expect(yield* exists(f.workPath)).toBe(true)
      expect(saved.state).toBe("failed")
      expect(yield* contents(f.workPath, "only-output.bin")).toBe("x".repeat(101))
      expect(saved.error).toContain("retained")
      yield* write(f.workPath, "only-output.bin", "recovered\n")
      expect((yield* f.isolation.reconcile(f.child.id)).state).toBe("changed")
      yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* contents(f.home.directory, "only-output.bin")).toBe("recovered\n")
    }).pipe(Effect.provideService(TaskIsolation.Limits, smallCapture)),
  { git: true },
)

it.instance(
  "seed captures staged, unstaged and untracked files without touching the real index",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "staged.txt", "staged\n")
      yield* git(f.home.directory, ["add", "staged.txt"])
      yield* write(f.home.directory, "staged.txt", "unstaged on top\n")
      yield* write(f.home.directory, "untracked.txt", "new\n")
      yield* write(f.home.directory, ".gitignore", "ignored.txt\n")
      yield* write(f.home.directory, "ignored.txt", "ignored\n")
      yield* write(f.home.directory, "too-large", "x".repeat(101))
      const index = path.resolve(f.home.directory, yield* git(f.home.directory, ["rev-parse", "--git-path", "index"]))
      const before = yield* Effect.promise(() => fs.readFile(index))
      const started = yield* f.start
      expect(yield* contents(started.work.directory, "staged.txt")).toBe("unstaged on top\n")
      expect(yield* contents(started.work.directory, "untracked.txt")).toBe("new\n")
      expect(yield* exists(path.join(started.work.directory, "ignored.txt"))).toBe(false)
      expect(yield* exists(path.join(started.work.directory, "too-large"))).toBe(false)
      expect(started.record.skipped).toContain("too-large")
      expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
      expect(TaskClaims.gitDirectories()).not.toEqual({})
      expect((yield* f.settle()).state).toBe("unchanged")
    }).pipe(
      Effect.provideService(TaskIsolation.Limits, {
        fileBytes: 100,
        minFreeBytes: 0,
        copyBytes: 1024 ** 3,
        copyFiles: 20_000,
        patchBytes: 256 * 1024,
      }),
    ),
  { git: true },
)

// F.4: reserve's check reads the free space before any checkout of the launches that passed it together is written,
// so start checks again under the folder's lock, where each earlier creation has already used its share.
it.instance(
  "start checks the free disk space again under the folder's lock, and fails with disk when it ran out",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const limits = (minFreeBytes: number) => ({
        fileBytes: 50 * 1024 * 1024,
        minFreeBytes,
        copyBytes: 1024 ** 3,
        copyFiles: 20_000,
        patchBytes: 256 * 1024,
      })
      yield* f.reserve().pipe(Effect.provideService(TaskIsolation.Limits, limits(0)))
      // Other checkouts used the space after this one's check passed.
      yield* failure(
        f.isolation
          .start(f.child.id)
          .pipe(Effect.provideService(TaskIsolation.Limits, limits(Number.MAX_SAFE_INTEGER))),
        "disk",
      )
      expect(yield* exists(f.workPath)).toBe(false)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("failed")
    }),
  { git: true },
)

it.instance(
  "unchanged removes the checkout, reserved branch and inherited trust",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      const trust = yield* Effect.promise(() => WorkspaceTrust.snapshot(started.work.directory, []))
      expect((yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, trust))).trusted).toBe(true)
      const result = yield* f.settle()
      expect(result.state).toBe("unchanged")
      expect(yield* exists(started.work.directory)).toBe(false)
      expect(yield* git(f.home.directory, ["branch", "--list", result.branch!])).toBe("")
      expect((yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, trust))).trusted).toBe(false)
      expect((yield* f.settle()).state).toBe("unchanged")
    }),
  { git: true, trusted: true },
)

it.instance(
  "changed saves despite failing hooks and signing configuration, with bounded private diffs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "result.txt", "result\n".repeat(100))
      yield* git(started.work.directory, ["config", "commit.gpgsign", "true"])
      const hooks = path.join(f.home.directory, ".git", "hooks", "pre-commit")
      yield* Effect.promise(async () => {
        await fs.writeFile(hooks, "#!/bin/sh\nexit 1\n")
        await fs.chmod(hooks, 0o755)
      })
      const result = yield* f.settle()
      expect(result.state).toBe("changed")
      expect(result.files).toEqual([
        { path: "result.txt", status: "added", additions: 100, deletions: 0, binary: false },
      ])
      yield* failure(f.isolation.changes({ taskID: f.child.id, diff: true }), "forbidden")
      const changes = yield* f.isolation.changes({ taskID: f.child.id, diff: true, control: true })
      expect(changes.truncated).toBe(true)
      expect(Buffer.byteLength(changes.patch ?? "")).toBeLessThanOrEqual(128)
    }).pipe(
      Effect.provideService(TaskIsolation.Limits, {
        fileBytes: 50 * 1024 * 1024,
        minFreeBytes: 0,
        copyBytes: 1024 ** 3,
        copyFiles: 20_000,
        patchBytes: 128,
      }),
    ),
  { git: true },
)

it.instance(
  "clean merge writes only selected blobs, leaves the index intact and creates a checkpoint",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "parent.txt", "parent staged\n")
      yield* git(f.home.directory, ["add", "parent.txt"])
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* write(started.work.directory, "two.txt", "two\n")
      yield* f.settle()
      const index = path.resolve(f.home.directory, yield* git(f.home.directory, ["rev-parse", "--git-path", "index"]))
      const before = yield* Effect.promise(() => fs.readFile(index))
      const partial = yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
      expect(partial.record.state).toBe("changed")
      expect(partial.remaining).toEqual(["two.txt"])
      expect(yield* exists(path.join(partial.checkpoint!, "manifest.json"))).toBe(true)
      expect(yield* contents(f.home.directory, "one.txt")).toBe("one\n")
      expect(yield* exists(path.join(f.home.directory, "two.txt"))).toBe(false)
      const rest = yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
      expect(rest.record.state).toBe("merged")
      expect(yield* contents(f.home.directory, "two.txt")).toBe("two\n")
      expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "a conflicting merge refuses without changing parent files or its index",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "same.txt", "base\n")
      yield* git(f.home.directory, ["add", "same.txt"])
      yield* git(f.home.directory, ["commit", "-m", "base"])
      const started = yield* f.start
      yield* write(started.work.directory, "same.txt", "child\n")
      yield* f.settle()
      yield* write(f.home.directory, "same.txt", "parent\n")
      const index = path.join(f.home.directory, ".git", "index")
      const before = yield* Effect.promise(() => fs.readFile(index))
      yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "conflict")
      expect(yield* contents(f.home.directory, "same.txt")).toBe("parent\n")
      expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
    }),
  { git: true },
)

it.instance(
  "an owner may back up and replace an untracked collision; an agent cannot force it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "new.txt", "child\n")
      yield* f.settle()
      yield* write(f.home.directory, "new.txt", "parent untracked\n")
      yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "conflict")
      const merged = yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" }, force: true })
      expect(yield* contents(f.home.directory, "new.txt")).toBe("child\n")
      expect(yield* contents(merged.checkpoint!, "overwritten/new.txt")).toBe("parent untracked\n")
    }),
  { git: true },
)

it.instance(
  "discard retains a patch, and resume recreates a removed checkout from current files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "changed.txt", "saved\n")
      yield* f.settle()
      const discarded = yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* exists(discarded.saved)).toBe(true)
      expect(yield* exists(f.workPath)).toBe(false)
      yield* write(f.home.directory, "current.txt", "current\n")
      const resumed = yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
      expect(resumed.record.state).toBe("running")
      expect(yield* contents(f.workPath, "current.txt")).toBe("current\n")
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })).state).toBe("unchanged")
    }),
  { git: true },
)

it.instance(
  "a child that drops the seed is recorded as diverged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "parent-wip.txt", "seed\n")
      const started = yield* f.start
      yield* git(f.workPath, ["reset", "--hard", "HEAD~1"])
      const result = yield* f.settle()
      expect(result.state).toBe("diverged")
    }),
  { git: true },
)

it.instance(
  "sparse checkouts and read-only agents are refused before reserving anything",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* git(f.home.directory, ["config", "core.sparseCheckout", "true"])
      yield* failure(f.reserve(), "sparse")
      expect(yield* exists(f.recordPath)).toBe(false)
      yield* git(f.home.directory, ["config", "core.sparseCheckout", "false"])
      for (const name of ["review", "explore", "judge", "security", "research", "researcher", "research-judge"])
        yield* failure(f.isolation.check({ parentSessionID: f.parent.id, agent: { ...f.agent, name } }), "readonly")
      // Read-only agents are named exactly, as task claims name them: a user's editing agent whose name only starts
      // with one of those words is a writer, and may work in isolation.
      for (const name of ["reviewer-fix", "Security-hardening", "explorer"])
        expect((yield* f.isolation.check({ parentSessionID: f.parent.id, agent: { ...f.agent, name } })).mode).toBe(
          "worktree",
        )
    }),
  { git: true },
)

it.instance(
  "agent resolution is checked in the work instance before returning execution context",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.isolation.reserve({
        taskID: f.child.id,
        parentSessionID: f.parent.id,
        title: "Mismatch",
        agent: { ...f.agent, permission: [] },
      })
      yield* failure(f.isolation.start(f.child.id), "agent")
      expect((yield* f.isolation.get(f.child.id)).state).toBe("failed")
      expect(TaskPlace.get(f.child.id)?.work.directory).not.toBe(f.workPath)
    }),
  { git: true },
)

it.instance(
  "registered ignored links are excluded and their targets survive settle/removal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, ".gitignore", "node_modules\n")
      yield* write(f.home.directory, "node_modules/keep.txt", "keep\n")
      const config = yield* Effect.promise(() => import("@/config/config"))
      const original = yield* config.Config.Service
      const isolation = yield* TaskIsolation.make.pipe(
        Effect.provideService(config.Config.Service, {
          ...original,
          get: () => Effect.succeed({ sizing: { subagents: { isolation: { link: ["node_modules"] } } } }),
        }),
      )
      yield* isolation.reserve({ taskID: f.child.id, parentSessionID: f.parent.id, title: "Links", agent: f.agent })
      yield* isolation.start(f.child.id)
      expect(yield* contents(f.workPath, "node_modules/keep.txt")).toBe("keep\n")
      expect((yield* isolation.settle({ taskID: f.child.id, attempt: 1 })).state).toBe("unchanged")
      expect(yield* contents(f.home.directory, "node_modules/keep.txt")).toBe("keep\n")
    }),
  { git: true },
)

it.instance(
  "forged registry directories cannot redirect discard or sweep to another folder",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "saved.txt", "child\n")
      const record = yield* f.settle()
      const outside = yield* tmpdirScoped()
      yield* write(outside, "keep.txt", "keep\n")
      yield* Effect.promise(() =>
        fs.writeFile(f.recordPath, JSON.stringify({ ...record, directory: outside, deleted: true })),
      )
      yield* failure(f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }), "registry")
      expect(yield* f.isolation.sweep({ force: true })).toEqual([])
      expect(yield* contents(outside, "keep.txt")).toBe("keep\n")
    }),
  { git: true },
)

it.instance(
  "a merge through a symlinked target directory is refused",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "directory/new.txt", "child\n")
      yield* f.settle()
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        fs.symlink(
          outside,
          path.join(f.home.directory, "directory"),
          process.platform === "win32" ? "junction" : "dir",
        ),
      )
      yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "path")
      expect(yield* exists(path.join(outside, "new.txt"))).toBe(false)
    }),
  { git: true },
)

it.instance(
  "settle joins an active shared grandchild before saving and retiring its work context",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      const jobs = yield* BackgroundJob.Service
      const grandchild = yield* TaskPlace.within(f.child.id)(f.sessions.create({ parentID: f.child.id }))
      yield* Effect.addFinalizer(() => Effect.sync(() => TaskPlace.drop(grandchild.id)))
      const ready = yield* Deferred.make<void>()
      yield* TaskPlace.within(f.child.id)(
        jobs.start({
          id: grandchild.id,
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(write(started.work.directory, "grandchild-finally.txt", "joined before snapshot\n")),
          ),
        }),
      )
      yield* Deferred.await(ready)
      const result = yield* f.settle()
      expect(result.state).toBe("changed")
      expect(result.files.map((file) => file.path)).toContain("grandchild-finally.txt")
      expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(f.home.directory)
      yield* failure(f.isolation.admit(grandchild.id), "retired")
      const resumed = yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
      expect(TaskPlace.get(grandchild.id)?.work.directory).toBe(resumed.work.directory)
      yield* f.isolation.admit(grandchild.id)
      yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
    }),
  { git: true },
)

it.instance("copy mode uses baseline conflicts and supports merge without creating Git metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* write(f.home.directory, "copy.txt", "base\n")
    const started = yield* f.start
    expect(started.record.mode).toBe("copy")
    expect(yield* exists(path.join(f.workPath, ".git"))).toBe(false)
    yield* write(f.workPath, "copy.txt", "child\n")
    yield* f.settle()
    const result = yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
    expect(result.record.state).toBe("merged")
    expect(yield* contents(f.home.directory, "copy.txt")).toBe("child\n")
    const archived = yield* f.isolation.changes({ taskID: f.child.id, diff: true, control: true })
    expect(archived.patch).toContain("vector-isolation-copy-v1")
  }),
)

it.instance("copy mode starts, saves and merges when the data folder is reached through a link", () =>
  Effect.gen(function* () {
    // The data folder's own path may pass through a link (a linked home or ~/.local, /tmp and /var on macOS, a short
    // or mapped path on Windows). Only links at or below the data folder are refused.
    const original = Global.Path.data
    const linked = path.join(yield* tmpdirScoped(), "linked-share")
    yield* Effect.promise(() =>
      fs.symlink(path.dirname(original), linked, process.platform === "win32" ? "junction" : "dir"),
    )
    Global.Path.data = path.join(linked, path.basename(original))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Global.Path.data = original
      }),
    )
    const f = yield* fixture
    yield* write(f.home.directory, "copy.txt", "base\n")
    const started = yield* f.start
    expect(started.record.mode).toBe("copy")
    yield* write(f.workPath, "copy.txt", "child\n")
    expect((yield* f.settle()).state).toBe("changed")
    expect((yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe("merged")
    expect(yield* contents(f.home.directory, "copy.txt")).toBe("child\n")
  }),
)

it.instance("copy admission counts files larger than the hash limit before any checkout write", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* write(f.home.directory, "large.bin", "x".repeat(5 * 1024 * 1024 + 1))
    yield* failure(f.reserve(), "copy_limit")
    expect(yield* exists(f.recordPath)).toBe(false)
    expect(yield* exists(f.workPath)).toBe(false)
  }).pipe(
    Effect.provideService(TaskIsolation.Limits, {
      fileBytes: 100,
      minFreeBytes: 0,
      copyBytes: 1024,
      copyFiles: 20_000,
      patchBytes: 256 * 1024,
    }),
  ),
)

it.instance(
  "stale settlement cannot retire a resumed attempt or lose rebuilt protections",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const first = yield* f.start
      yield* write(first.work.directory, "changed.txt", "changed\n")
      yield* f.settle()
      TaskClaims.unprotect(f.child.id)
      const resumed = yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
      expect(TaskClaims.protectedTrees().some((entry) => entry.taskID === f.child.id && !!entry.gitDirectory)).toBe(
        true,
      )
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 1 })).attempt).toBe(2)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("running")
      expect(TaskPlace.get(f.child.id)?.work.directory).toBe(resumed.work.directory)
      yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
    }),
  { git: true },
)

it.instance(
  "redirecting a child's .git cannot change the parent's index or HEAD during settlement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.start
      yield* write(f.workPath, "child.txt", "child\n")
      const before = yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, ".git", "index")))
      const head = yield* git(f.home.directory, ["rev-parse", "HEAD"])
      const pointer = yield* contents(f.workPath, ".git")
      yield* write(f.workPath, ".git", `gitdir: ${path.join(f.home.directory, ".git")}\n`)
      expect((yield* f.settle()).state).toBe("failed")
      expect(yield* git(f.home.directory, ["rev-parse", "HEAD"])).toBe(head)
      expect(yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, ".git", "index")))).toEqual(before)
      yield* write(f.workPath, ".git", pointer)
    }),
  { git: true },
)

it.instance(
  "corrupt retired registries refuse direct child and descendant admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.start
      const grandchild = yield* TaskPlace.within(f.child.id)(f.sessions.create({ parentID: f.child.id }))
      yield* Effect.addFinalizer(() => Effect.sync(() => TaskPlace.drop(grandchild.id)))
      yield* f.settle()
      yield* Effect.promise(() => fs.writeFile(f.recordPath, "not json"))
      expect(Exit.isFailure(yield* f.isolation.admit(f.child.id).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* f.isolation.admit(grandchild.id).pipe(Effect.exit))).toBe(true)
    }),
  { git: true },
)

it.instance(
  "settle waits for an already-cancelling grandchild's gated final write",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      const jobs = yield* BackgroundJob.Service
      const grandchild = yield* TaskPlace.within(f.child.id)(f.sessions.create({ parentID: f.child.id }))
      yield* Effect.addFinalizer(() => Effect.sync(() => TaskPlace.drop(grandchild.id)))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const settled = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* TaskPlace.within(f.child.id)(
        jobs.start({
          id: grandchild.id,
          type: "task",
          run: Effect.never.pipe(
            Effect.ensuring(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(write(started.work.directory, "closing.txt", "included\n")),
                Effect.uninterruptible,
              ),
            ),
          ),
        }),
      )
      const cancelling = yield* TaskPlace.within(f.child.id)(jobs.cancel(grandchild.id)).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const saving = yield* f.settle().pipe(
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(settled)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancelling)
      expect((yield* Fiber.join(saving)).files.map((file) => file.path)).toContain("closing.txt")
    }),
  { git: true },
)

it.instance(
  "settle retains oversized blobs already added by the child together with supported output",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "oversized.txt", "x".repeat(101))
      yield* git(f.workPath, ["add", "oversized.txt"])
      yield* write(started.work.directory, "normal.txt", "normal\n")
      const result = yield* f.settle()
      expect(result.state).toBe("failed")
      expect(result.skipped).toContain("oversized.txt")
      expect(result.files.map((file) => file.path)).not.toContain("oversized.txt")
      expect(yield* contents(f.workPath, "oversized.txt")).toBe("x".repeat(101))
      expect(yield* contents(f.workPath, "normal.txt")).toBe("normal\n")
      expect(result.error).toContain("retained")
    }).pipe(
      Effect.provideService(TaskIsolation.Limits, {
        fileBytes: 100,
        minFreeBytes: 0,
        copyBytes: 1024 ** 3,
        copyFiles: 20_000,
        patchBytes: 256 * 1024,
      }),
    ),
  { git: true },
)

it.instance(
  "stacked changes require their dependency to merge first",
  () =>
    Effect.gen(function* () {
      const dependency = yield* fixture
      const started = yield* dependency.start
      yield* write(started.work.directory, "dep.txt", "dependency\n")
      yield* dependency.settle()
      const f = yield* fixture
      yield* f.isolation.reserve({
        taskID: f.child.id,
        parentSessionID: f.parent.id,
        title: "Stack",
        agent: f.agent,
        dependsOn: [dependency.child.id],
      })
      yield* f.isolation.start(f.child.id)
      expect(yield* contents(f.workPath, "dep.txt")).toBe("dependency\n")
      yield* write(f.workPath, "result.txt", "result\n")
      yield* f.settle()
      yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "stacked")
      yield* dependency.isolation.merge({ taskID: dependency.child.id, by: { kind: "owner" } })
      expect((yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe("merged")
    }),
  { git: true },
)

it.instance(
  "a dependency discarded after the reservation is not stacked, so the reservation still starts and merges",
  () =>
    Effect.gen(function* () {
      const dependency = yield* fixture
      const started = yield* dependency.start
      yield* write(started.work.directory, "dep.txt", "dependency\n")
      expect((yield* dependency.settle()).state).toBe("changed")
      const f = yield* fixture
      const reserved = yield* f.isolation.reserve({
        taskID: f.child.id,
        parentSessionID: f.parent.id,
        title: "Stack",
        agent: f.agent,
        dependsOn: [dependency.child.id],
      })
      expect(reserved.stacked).toEqual([dependency.child.id])
      yield* dependency.isolation.discard({ taskID: dependency.child.id, by: { kind: "owner" } })
      yield* f.isolation.start(f.child.id)
      expect((yield* f.isolation.get(f.child.id)).stacked).toEqual([])
      expect(yield* exists(path.join(f.workPath, "dep.txt"))).toBe(false)
      yield* write(f.workPath, "result.txt", "result\n")
      yield* f.settle()
      expect((yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe("merged")
    }),
  { git: true },
)

it.instance(
  "sweep removes only queued registered tasks and retains their recovery patches",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "result.txt", "result\n")
      yield* f.settle()
      yield* f.isolation.enqueue(f.child.id)
      expect(yield* f.isolation.sweep({ force: true })).toContain(f.child.id)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("discarded")
      expect(yield* exists(f.workPath)).toBe(false)
      expect(yield* Effect.promise(() => fs.readdir(path.join(path.dirname(f.recordPath), "patches")))).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "a resumed kept task and a deleted conversation's changes do not count toward max_kept; the latter are swept on the next pass",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "result.txt", "result\n")
      expect((yield* f.settle()).state).toBe("changed")
      // Nineteen other changed tasks wait for review, so with this one the project is at the default cap of 20.
      const record = JSON.parse(yield* contents(f.recordPath, ""))
      const others = Array.from({ length: 19 }, (_, index) => `kept_${index}_${f.child.id}`)
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          Promise.all(
            others.map(async (taskID) => {
              const registry = path.join(path.dirname(path.dirname(f.recordPath)), taskID)
              await fs.mkdir(registry, { recursive: true, mode: 0o700 })
              await fs.writeFile(
                path.join(registry, "record.json"),
                JSON.stringify({
                  ...record,
                  taskID,
                  directory: path.join(path.dirname(f.workPath), taskID),
                  branch: `vector/subagent/${taskID}`,
                }),
                { mode: 0o600 },
              )
            }),
          ),
        ),
        () =>
          Effect.promise(() =>
            Promise.all(
              others.map((taskID) =>
                fs.rm(path.join(path.dirname(path.dirname(f.recordPath)), taskID), { recursive: true, force: true }),
              ),
            ),
          ),
      )
      // The boot pass has run, so the registry scan is spent for this project in this process.
      expect(yield* f.isolation.sweep()).toEqual([])
      yield* failure(f.isolation.check({ parentSessionID: f.parent.id, agent: f.agent }), "kept")
      // Resuming a task that is one of the kept ones adds none, so it is admitted at the cap.
      yield* f.isolation.check({ parentSessionID: f.parent.id, agent: f.agent, resumeID: f.child.id })
      yield* f.sessions.remove(f.child.id)
      expect((yield* f.isolation.get(f.child.id)).deleted).toBe(true)
      // Its changes can no longer be reviewed, so they no longer hold a place under the cap.
      yield* f.isolation.check({ parentSessionID: f.parent.id, agent: f.agent })
      // The next pass sweeps it; its patch is kept.
      expect(yield* f.isolation.sweep()).toEqual([f.child.id])
      expect((yield* f.isolation.get(f.child.id)).state).toBe("discarded")
      expect(yield* exists(f.workPath)).toBe(false)
      expect(yield* Effect.promise(() => fs.readdir(path.join(path.dirname(f.recordPath), "patches")))).toHaveLength(1)
      expect(yield* f.isolation.sweep()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "reconcile restores a real checkpoint from an interrupted merge",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* write(started.work.directory, "two.txt", "two\n")
      yield* f.settle()
      const partial = yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
      const pending = { ...partial.record, mergeCompleted: false, merged: [] }
      yield* Effect.promise(() => fs.writeFile(f.recordPath, JSON.stringify(pending)))
      expect(yield* contents(f.home.directory, "one.txt")).toBe("one\n")
      const restored = yield* f.isolation.reconcile(f.child.id)
      expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
      expect(restored.state).toBe("changed")
      expect(restored.mergeStartedAt).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "recovery undoes only what an interrupted merge left and keeps files changed since",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, "edited.txt", "parent\n")
      yield* git(f.home.directory, ["add", "edited.txt"])
      yield* git(f.home.directory, ["commit", "-m", "edited baseline"])
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* write(started.work.directory, "two.txt", "two\n")
      yield* write(started.work.directory, "edited.txt", "child\n")
      yield* write(started.work.directory, "later.txt", "later\n")
      yield* f.settle()
      const selected = ["one.txt", "two.txt", "edited.txt"]
      const partial = yield* f.isolation.merge({ taskID: f.child.id, files: selected, by: { kind: "owner" } })
      // A crash after the writes and before the record says the merge finished; the user then kept working.
      yield* Effect.promise(() =>
        fs.writeFile(f.recordPath, JSON.stringify({ ...partial.record, mergeCompleted: false, merged: [] })),
      )
      yield* write(f.home.directory, "two.txt", "two\nmine\n")
      yield* write(f.home.directory, "edited.txt", "child\nmine\n")
      const restored = yield* f.isolation.reconcile(f.child.id)
      // What the merge wrote and nobody changed is undone; what changed since is left as it is.
      expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
      expect(yield* contents(f.home.directory, "two.txt")).toBe("two\nmine\n")
      expect(yield* contents(f.home.directory, "edited.txt")).toBe("child\nmine\n")
      expect(restored).toMatchObject({ state: "changed", merged: [] })
      expect(restored.mergeStartedAt).toBeUndefined()
      expect(restored.error).toContain("edited.txt")
      expect(restored.error).toContain("two.txt")
      expect(restored.error).not.toContain("one.txt")
    }),
  { git: true },
)

it.instance(
  "a partial merge stopped while its next base is built has written nothing, so recovery cannot undo later edits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* write(started.work.directory, "two.txt", "two\n")
      yield* f.settle()
      const real = yield* Git.Service
      const reached = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined))
      // The same registry and per-task lock, with the commit of a partial merge's next logical base held.
      const merging = yield* TaskIsolation.make.pipe(
        Effect.provideService(Git.Service, {
          ...real,
          run: (args, options) =>
            args.includes("Vector: logical merge base after a partial task merge")
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(held)),
                  Effect.andThen(real.run(args, options)),
                )
              : real.run(args, options),
        }),
      )
      const fiber = yield* merging
        .merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(reached).pipe(Effect.timeout("10 seconds"))
      // The request is dropped there (a closed window, a Stop of the calling turn).
      yield* Fiber.interrupt(fiber)
      expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
      const record = yield* f.isolation.get(f.child.id)
      expect(record).toMatchObject({ state: "changed", merged: [] })
      expect(record.mergeCompleted).not.toBe(false)
      // The user writes that path in the parent later; the next start's recovery leaves it alone.
      yield* write(f.home.directory, "one.txt", "mine\n")
      yield* f.isolation.reconcile(f.child.id)
      expect(yield* contents(f.home.directory, "one.txt")).toBe("mine\n")
      const merged = yield* f.isolation.merge({ taskID: f.child.id, files: ["two.txt"], by: { kind: "owner" } })
      expect(merged.remaining).toEqual(["one.txt"])
      expect(yield* contents(f.home.directory, "two.txt")).toBe("two\n")
    }),
  { git: true },
)

it.instance(
  "autocrlf merges use checkout bytes while preserving the parent's existing index",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* git(f.home.directory, ["config", "core.autocrlf", "true"])
      yield* write(f.home.directory, "crlf.txt", "base\r\n")
      yield* git(f.home.directory, ["add", "crlf.txt"])
      yield* git(f.home.directory, ["commit", "-m", "CRLF"])
      const started = yield* f.start
      yield* write(started.work.directory, "crlf.txt", "changed\r\n")
      yield* f.settle()
      const index = yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, ".git", "index")))
      yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* contents(f.home.directory, "crlf.txt")).toBe("changed\r\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, ".git", "index")))).toEqual(index)
    }),
  { git: true },
)

it.instance(
  "metadata cannot authorize cleanup outside the reserved registry checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "saved.txt", "saved\n")
      yield* f.settle()
      const outside = yield* tmpdirScoped()
      yield* write(outside, "keep.txt", "keep\n")
      yield* f.sessions.setMetadata({
        sessionID: f.child.id,
        metadata: { subagent: { isolation: { directory: outside, branch: "main", state: "changed" } } },
      })
      yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* contents(outside, "keep.txt")).toBe("keep\n")
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "an expected-branch removal refuses branch drift between outer verification and removal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "saved.txt", "saved\n")
      yield* f.settle()
      const worktrees = yield* Worktree.Service
      const changing = {
        ...worktrees,
        removeForTask: (info: Worktree.Info & { branch: string }) =>
          git(info.directory, ["switch", "-c", "unrelated-owner-branch"]).pipe(
            Effect.andThen(worktrees.removeForTask(info)),
          ),
      }
      expect(
        Exit.isFailure(
          yield* f.isolation
            .discard({ taskID: f.child.id, by: { kind: "owner" } })
            .pipe(Effect.provideService(Worktree.Service, changing), Effect.exit),
        ),
      ).toBe(true)
      expect(yield* git(f.home.directory, ["branch", "--list", "unrelated-owner-branch"])).toContain(
        "unrelated-owner-branch",
      )
      expect(yield* exists(f.workPath)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "an escaping added symlink is refused before any parent write",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      const outside = yield* tmpdirScoped()
      // A real directory link on every platform: Git for Windows reads an NTFS junction as a directory, so a junction
      // never becomes a Git link for the merge to refuse. Hosted Windows runners may create symbolic links.
      yield* Effect.promise(() => fs.symlink(outside, path.join(started.work.directory, "escape"), "dir"))
      expect((yield* f.settle()).state).toBe("changed")
      yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "path")
      expect(yield* exists(path.join(f.home.directory, "escape"))).toBe(false)
    }),
  { git: true },
)

it.instance(
  "reconcile saves an orphaned running attempt without cancelling the home registry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "saved.txt", "saved\n")
      const saved = yield* f.settle()
      yield* write(f.workPath, "after-restart.txt", "recover\n")
      yield* Effect.promise(() =>
        fs.writeFile(f.recordPath, JSON.stringify({ ...saved, state: "running", settledAttempt: undefined })),
      )
      const jobs = yield* BackgroundJob.Service
      const unrelated = yield* jobs.start({ type: "unrelated", run: Effect.never })
      const recovered = yield* f.isolation.reconcile(f.child.id)
      expect(recovered.state).toBe("changed")
      expect(recovered.files.map((file) => file.path)).toContain("after-restart.txt")
      expect((yield* jobs.get(unrelated.id))?.status).toBe("running")
      yield* jobs.cancel(unrelated.id)
    }),
  { git: true },
)

it.instance(
  "failed settlement retains actual edits through discard and sweep until a real snapshot is saved",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(f.workPath, "unsaved.txt", "precious partial changes\n")
      const lock = path.join(started.record.gitDirectory!, "index.lock")
      yield* Effect.promise(() => fs.writeFile(lock, "fixture lock"))
      expect((yield* f.settle()).state).toBe("failed")
      yield* failure(f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }), "unsaved")
      yield* f.isolation.enqueue(f.child.id)
      expect(yield* f.isolation.sweep({ force: true })).toEqual([])
      expect(yield* contents(f.workPath, "unsaved.txt")).toBe("precious partial changes\n")
      yield* Effect.promise(() => fs.rm(lock, { force: true }))
      expect((yield* f.isolation.reconcile(f.child.id)).state).toBe("changed")
      const discarded = yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })
      expect(yield* Effect.promise(() => fs.readFile(discarded.saved!, "utf8"))).toContain("precious partial changes")
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "a deleted conversation's failed save is not run again on every sweep; the next start retries it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(f.workPath, "unsaved.txt", "precious partial changes\n")
      const lock = path.join(started.record.gitDirectory!, "index.lock")
      yield* Effect.promise(() => fs.writeFile(lock, "fixture lock"))
      expect((yield* f.settle()).state).toBe("failed")
      yield* f.sessions.remove(f.child.id)
      expect((yield* f.isolation.get(f.child.id)).deleted).toBe(true)
      // Every save writes a new record file (a freed inode number can come back, its write time cannot), so these show
      // whether a pass saved the record again.
      const written = Effect.promise(() => fs.stat(f.recordPath, { bigint: true })).pipe(
        Effect.map((stat) => `${stat.ino}:${stat.mtimeNs}`),
      )
      const before = yield* written
      // The registry scan, then a later pass (every 5 minutes in TaskRecovery).
      expect(yield* f.isolation.sweep()).toEqual([])
      expect(yield* f.isolation.sweep()).toEqual([])
      expect(yield* written).toBe(before)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("failed")
      expect(yield* contents(f.workPath, "unsaved.txt")).toBe("precious partial changes\n")
      // The next start: TaskRecovery's boot pass retries the save, then its sweep scans the registry again.
      yield* Effect.promise(() => fs.rm(lock, { force: true }))
      expect((yield* f.isolation.reconcile(f.child.id)).state).toBe("changed")
      expect(yield* f.isolation.sweep({ force: true })).toEqual([f.child.id])
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "a running task's changes are read without Git, so a Stop's settling mark never waits behind a Changes view",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "result.txt", "result\n")
      const real = yield* Git.Service
      const held = yield* Deferred.make<void>()
      const gate = { on: false }
      yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined))
      // The same registry and per-task lock, with every Git call held while the gate is on.
      const viewing = yield* TaskIsolation.make.pipe(
        Effect.provideService(Git.Service, {
          ...real,
          run: (args, options) =>
            gate.on ? Deferred.await(held).pipe(Effect.andThen(real.run(args, options))) : real.run(args, options),
        }),
      )
      gate.on = true
      const view = yield* viewing
        .changes({ taskID: f.child.id, diff: true, control: true, review: true })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      // A Stop's completion barrier records settling under the same lock.
      const marked = yield* f.isolation.markSettling(f.child.id, 1).pipe(Effect.timeout("5 seconds"))
      expect(marked?.state).toBe("settling")
      const changes = yield* Fiber.join(view).pipe(Effect.timeout("5 seconds"))
      expect(changes).toMatchObject({ mergeable: "blocked", truncated: false })
      expect(changes.patch).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "recovery binds a genuine checkout interrupted between raw creation and its metadata save",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const worktrees = yield* Worktree.Service
      const interrupted = {
        ...worktrees,
        createForTask: (info: Worktree.Info, options: { from: string; env?: Record<string, string | undefined> }) =>
          worktrees
            .createForTask(info, options)
            .pipe(
              Effect.andThen(
                Effect.fail(new Worktree.CreateFailedError({ message: "fixture crash after raw creation" })),
              ),
            ),
      }
      expect(
        Exit.isFailure(yield* f.start.pipe(Effect.provideService(Worktree.Service, interrupted), Effect.exit)),
      ).toBe(true)
      const retained = yield* f.isolation.get(f.child.id)
      expect(retained.gitDirectory).toBeUndefined()
      expect(yield* exists(f.workPath)).toBe(true)
      expect((yield* f.isolation.reconcile(f.child.id)).state).toBe("unchanged")
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "a failed running-record save after resume releases its loaded instance and work placement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "saved.txt", "saved\n")
      yield* f.settle()
      const store = yield* InstanceStore.Service
      const backup = `${f.recordPath}.fixture-backup`
      const damaged = {
        ...store,
        load: (input: Parameters<InstanceStore.Interface["load"]>[0]) =>
          store.load(input).pipe(
            Effect.tap(() =>
              input.directory !== f.workPath
                ? Effect.void
                : Effect.promise(async () => {
                    await fs.rename(f.recordPath, backup)
                    await fs.mkdir(f.recordPath)
                  }),
            ),
          ),
      }
      const result = yield* f.isolation
        .resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
        .pipe(Effect.provideService(InstanceStore.Service, damaged), Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(TaskPlace.get(f.child.id)?.work.directory).toBe(f.home.directory)
      expect((yield* store.loaded()).some((entry) => entry.directory === f.workPath)).toBe(false)
      yield* Effect.promise(async () => {
        await fs.rmdir(f.recordPath)
        await fs.rename(backup, f.recordPath)
      })
      expect((yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe("discarded")
    }),
  { git: true },
)

it.instance(
  "sweep retires a deleted reservation without inventing a worktree to remove",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.reserve()
      yield* f.isolation.enqueue(f.child.id)
      expect(yield* f.isolation.sweep({ force: true })).toContain(f.child.id)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("unchanged")
      expect(yield* exists(f.workPath)).toBe(false)
    }),
  { git: true },
)

it.instance(
  "replacing a configured link's ancestor cannot unlink anything outside the checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* write(f.home.directory, ".gitignore", "deps/node_modules\n")
      yield* write(f.home.directory, "deps/node_modules/keep.txt", "original\n")
      const config = yield* Config.Service
      const isolation = yield* TaskIsolation.make.pipe(
        Effect.provideService(Config.Service, {
          ...config,
          get: () => Effect.succeed({ sizing: { subagents: { isolation: { link: ["deps/node_modules"] } } } }),
        }),
      )
      yield* isolation.reserve({
        taskID: f.child.id,
        parentSessionID: f.parent.id,
        title: "Nested link",
        agent: f.agent,
      })
      yield* isolation.start(f.child.id)
      const outside = yield* tmpdirScoped()
      const target = yield* tmpdirScoped()
      yield* write(target, "keep.txt", "outside\n")
      yield* Effect.promise(async () => {
        await fs.symlink(target, path.join(outside, "node_modules"), process.platform === "win32" ? "junction" : "dir")
        await fs.rm(path.join(f.workPath, "deps"), { recursive: true })
        await fs.symlink(outside, path.join(f.workPath, "deps"), process.platform === "win32" ? "junction" : "dir")
      })
      yield* isolation.settle({ taskID: f.child.id, attempt: 1 })
      expect(
        Exit.isFailure(yield* isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }).pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* exists(path.join(outside, "node_modules"))).toBe(true)
      expect(yield* contents(target, "keep.txt")).toBe("outside\n")
    }),
  { git: true },
)

if (process.platform !== "win32")
  it.instance(
    "oversized literal wildcard names are not mistaken for tracked pathspec matches",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.home.directory, "tracked.txt", "tracked\n")
        yield* git(f.home.directory, ["add", "tracked.txt"])
        yield* write(f.home.directory, "*", "x".repeat(101))
        const started = yield* f.start
        expect(started.record.skipped).toContain("*")
        expect(yield* exists(path.join(f.workPath, "*"))).toBe(false)
        yield* f.settle()
      }).pipe(
        Effect.provideService(TaskIsolation.Limits, {
          fileBytes: 100,
          minFreeBytes: 0,
          copyBytes: 1024 ** 3,
          copyFiles: 20_000,
          patchBytes: 256 * 1024,
        }),
      ),
    { git: true },
  )

for (const gitProject of [true, false])
  it.instance(
    `${gitProject ? "Git" : "copy"} follow-ups can delete an already merged addition after a partial merge`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const started = yield* f.start
        yield* write(started.work.directory, "one.txt", "first\n")
        yield* write(started.work.directory, "two.txt", "remaining\n")
        yield* f.settle()
        yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
        const resumed = yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
        yield* Effect.promise(() => fs.unlink(path.join(resumed.work.directory, "one.txt")))
        yield* write(resumed.work.directory, "two.txt", "updated remaining\n")
        const saved = yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
        expect(saved.state).toBe("changed")
        expect(saved.files).toContainEqual(expect.objectContaining({ path: "one.txt", status: "deleted" }))
        expect(saved.merged).toEqual([])
        yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
        expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
        expect(yield* contents(f.home.directory, "two.txt")).toBe("updated remaining\n")
      }),
    { git: gitProject },
  )

for (const gitProject of [true, false])
  it.instance(
    `${gitProject ? "Git" : "copy"} owner includeStacked applies dependency changes as well as the child's own delta`,
    () =>
      Effect.gen(function* () {
        const dependency = yield* fixture
        const started = yield* dependency.start
        yield* write(started.work.directory, "dependency.txt", "dependency\n")
        yield* dependency.settle()
        const f = yield* fixture
        yield* f.isolation.reserve({
          taskID: f.child.id,
          parentSessionID: f.parent.id,
          title: "Included stack",
          agent: f.agent,
          dependsOn: [dependency.child.id],
        })
        yield* f.isolation.start(f.child.id)
        expect(yield* contents(f.workPath, "dependency.txt")).toBe("dependency\n")
        yield* write(f.workPath, "result.txt", "result\n")
        yield* f.settle()
        yield* failure(f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } }), "stacked")
        const merged = yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" }, includeStacked: true })
        expect(merged.merged.sort()).toEqual(["dependency.txt", "result.txt"])
        expect(yield* contents(f.home.directory, "dependency.txt")).toBe("dependency\n")
        expect(yield* contents(f.home.directory, "result.txt")).toBe("result\n")
      }),
    { git: gitProject },
  )

it.instance(
  "a redirected per-worktree core.worktree cannot stage the parent's working files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      const index = path.join(f.home.directory, ".git", "index")
      const before = yield* Effect.promise(() => fs.readFile(index))
      const head = yield* git(f.home.directory, ["rev-parse", "HEAD"])
      yield* git(f.home.directory, ["config", "extensions.worktreeConfig", "true"])
      yield* git(f.workPath, ["config", "--worktree", "core.worktree", f.home.directory])
      yield* write(f.home.directory, "parent-wip.txt", "must not be staged by child\n")
      expect((yield* f.settle()).state).toBe("failed")
      expect(yield* Effect.promise(() => fs.readFile(index))).toEqual(before)
      expect(yield* git(f.home.directory, ["rev-parse", "HEAD"])).toBe(head)
      expect(yield* contents(f.home.directory, "parent-wip.txt")).toBe("must not be staged by child\n")
    }),
  { git: true },
)

it.instance(
  "duplicate start or active resume cannot retire the current attempt or rewrite a settled result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* failure(f.isolation.start(f.child.id), "state")
      yield* failure(f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent }), "running")
      expect((yield* f.isolation.get(f.child.id)).state).toBe("running")
      expect(TaskPlace.get(f.child.id)?.work.directory).toBe(started.work.directory)
      yield* write(started.work.directory, "still-running.txt", "kept\n")
      expect((yield* f.settle()).state).toBe("changed")
      yield* failure(f.isolation.start(f.child.id), "state")
      expect((yield* f.isolation.get(f.child.id)).state).toBe("changed")
      expect(yield* contents(f.workPath, "still-running.txt")).toBe("kept\n")
    }),
  { git: true },
)

/** A parent agent's merge whose edit prompt waits until the test answers it. */
const promptedMerge = Effect.fn("IsolationTest.promptedMerge")(function* (
  isolation: TaskIsolation.Interface,
  taskID: string,
  parentID: string,
) {
  const asked = yield* Deferred.make<string>()
  const answer = yield* Deferred.make<void>()
  yield* Effect.addFinalizer(() => Deferred.succeed(answer, undefined))
  const fiber = yield* isolation
    .merge({
      taskID,
      by: {
        kind: "agent",
        sessionID: parentID,
        ask: (input) => Deferred.succeed(asked, input.metadata.diff).pipe(Effect.andThen(Deferred.await(answer))),
        assertWritable: () => Effect.void,
        assertExternalDirectory: () => Effect.void,
      },
    })
    .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
  const diff = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
  return { diff, approve: Deferred.succeed(answer, undefined).pipe(Effect.andThen(Fiber.join(fiber))) }
})

it.instance(
  "an agent's merge prompt holds no task lock: the owner reviews and discards meanwhile, and the late approval writes nothing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* f.settle()
      const prompt = yield* promptedMerge(f.isolation, f.child.id, f.parent.id)
      expect(prompt.diff).toContain("one.txt")
      // While the user has not answered, the owner opens the same changes, then discards the task.
      const view = yield* f.isolation
        .changes({ taskID: f.child.id, diff: true, control: true, review: true })
        .pipe(Effect.timeout("10 seconds"))
      expect(view).toMatchObject({ mergeable: "clean" })
      expect(view.patch).toContain("one.txt")
      yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } }).pipe(Effect.timeout("10 seconds"))
      const exit = yield* prompt.approve
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "state" })
      expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
      expect((yield* f.isolation.get(f.child.id)).state).toBe("discarded")
    }),
  { git: true },
)

it.instance(
  "an approval of a result that was resumed and saved again while it waited is refused and writes nothing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* f.settle()
      const prompt = yield* promptedMerge(f.isolation, f.child.id, f.parent.id)
      expect(prompt.diff).toContain("+one")
      yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent }).pipe(Effect.timeout("10 seconds"))
      yield* write(f.workPath, "one.txt", "rewritten\n")
      expect((yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })).state).toBe("changed")
      // The user approved the diff they saw, which is no longer the task's result.
      const exit = yield* prompt.approve
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "state" })
      expect(yield* exists(path.join(f.home.directory, "one.txt"))).toBe(false)
      expect((yield* f.isolation.get(f.child.id)).merged).toEqual([])
    }),
  { git: true },
)

it.instance(
  "an agent's approval still merges after the owner's Changes view meanwhile, which only caches its assessment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* f.settle()
      const prompt = yield* promptedMerge(f.isolation, f.child.id, f.parent.id)
      const before = (yield* f.isolation.get(f.child.id)).mergeKey
      // Review (route 4 with diff=true) saves mergeKey and mergeable while the user has not answered.
      const view = yield* f.isolation
        .changes({ taskID: f.child.id, diff: true, control: true, review: true })
        .pipe(Effect.timeout("10 seconds"))
      expect(view.mergeable).toBe("clean")
      expect((yield* f.isolation.get(f.child.id)).mergeKey).not.toBe(before)
      const exit = yield* prompt.approve
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* contents(f.home.directory, "one.txt")).toBe("one\n")
      expect((yield* f.isolation.get(f.child.id)).state).toBe("merged")
    }),
  { git: true },
)

for (const gitProject of [true, false])
  for (const action of ["edit", "delete"])
    it.instance(
      `${gitProject ? "Git" : "copy"} includeStacked preserves its partial base through resume and ${action}`,
      () =>
        Effect.gen(function* () {
          const dependency = yield* fixture
          const dep = yield* dependency.start
          yield* write(dep.work.directory, "dependency.txt", "dependency\n")
          yield* dependency.settle()
          const f = yield* fixture
          yield* f.isolation.reserve({
            taskID: f.child.id,
            parentSessionID: f.parent.id,
            title: "Partial stack",
            agent: f.agent,
            dependsOn: [dependency.child.id],
          })
          yield* f.isolation.start(f.child.id)
          yield* write(f.workPath, "own.txt", "one\n")
          yield* f.settle()
          yield* f.isolation.merge({
            taskID: f.child.id,
            files: ["own.txt"],
            by: { kind: "owner" },
            includeStacked: true,
          })
          yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
          if (action === "edit") yield* write(f.workPath, "own.txt", "two\n")
          else yield* Effect.promise(() => fs.unlink(path.join(f.workPath, "own.txt")))
          yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
          const by = {
            kind: "agent" as const,
            sessionID: f.parent.id,
            ask: () => Effect.void,
            assertWritable: () => Effect.void,
            assertExternalDirectory: () => Effect.void,
          }
          yield* failure(f.isolation.merge({ taskID: f.child.id, by, includeStacked: true }), "forbidden")
          yield* failure(f.isolation.merge({ taskID: f.child.id, by }), "stacked")
          yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" }, includeStacked: true })
          expect(yield* contents(f.home.directory, "dependency.txt")).toBe("dependency\n")
          if (action === "edit") expect(yield* contents(f.home.directory, "own.txt")).toBe("two\n")
          else expect(yield* exists(path.join(f.home.directory, "own.txt"))).toBe(false)
        }),
      { git: gitProject },
      // Two isolated starts, a resume, three saves and two stacked merges: the Git cases took 27.5 s on hosted Windows
      // runners before the final checkout removal, so the default 30 s leaves them no room there.
      60_000,
    )

const gc = (directory: string) =>
  git(directory, ["-c", "gc.reflogExpireUnreachable=now", "gc", "--prune=now", "--quiet"])
const pinned = (directory: string, taskID: string) =>
  git(directory, ["for-each-ref", "--format=%(refname)", `refs/vector/isolation/${taskID}`])

it.instance(
  "a partial merge's logical base survives Git's gc, so the rest can still be reviewed and merged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const started = yield* f.start
      yield* write(started.work.directory, "one.txt", "one\n")
      yield* write(started.work.directory, "two.txt", "two\n")
      yield* f.settle()
      const partial = yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
      expect(partial.record.reviewBase).toBeDefined()
      // Weeks of the user's own commits end in an automatic gc, which prunes every commit no ref reaches.
      yield* gc(f.home.directory)
      const view = yield* f.isolation.changes({ taskID: f.child.id, diff: true, control: true, review: true })
      expect(view.patch).toContain("+two")
      expect(view.patch).not.toContain("+one")
      expect((yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe("merged")
      expect(yield* contents(f.home.directory, "two.txt")).toBe("two\n")
      // The pins go with the checkout.
      expect(yield* pinned(f.home.directory, f.child.id)).toBe("")
    }),
  { git: true },
)

it.instance(
  "a stacked task's pre-stack seed survives Git's gc through an includeStacked merge and a discard",
  () =>
    Effect.gen(function* () {
      const dependency = yield* fixture
      const dep = yield* dependency.start
      yield* write(dep.work.directory, "dependency.txt", "dependency\n")
      yield* dependency.settle()
      const f = yield* fixture
      // The parent's uncommitted change makes the pre-stack seed a commit of its own.
      yield* write(f.home.directory, "parent.txt", "parent\n")
      yield* f.isolation.reserve({
        taskID: f.child.id,
        parentSessionID: f.parent.id,
        title: "Stacked",
        agent: f.agent,
        dependsOn: [dependency.child.id],
      })
      yield* f.isolation.start(f.child.id)
      yield* write(f.workPath, "own.txt", "own\n")
      yield* write(f.workPath, "later.txt", "later\n")
      yield* f.settle()
      yield* gc(f.home.directory)
      yield* f.isolation.merge({ taskID: f.child.id, files: ["own.txt"], by: { kind: "owner" }, includeStacked: true })
      yield* gc(f.home.directory)
      const discarded = yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })
      expect(discarded.record.state).toBe("discarded")
      const saved = yield* Effect.promise(() => fs.readFile(discarded.saved!, "utf8"))
      expect(saved).toContain("+later")
      expect(saved).toContain("+dependency")
      expect(yield* pinned(f.home.directory, f.child.id)).toBe("")
    }),
  { git: true },
  // Two isolated starts, two saves, a stacked merge and a discard, with two full gc runs.
  60_000,
)

test("a merge's link that cannot be made leaves the parent's file in place", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vector-isolation-place-"))
  const target = path.join(dir, "linked.txt")
  await fs.writeFile(target, "parent\n")
  // A target with a NUL byte is refused by the link call itself, like a Windows account without the link privilege.
  await expect(TaskIsolation.place(target, { symlink: "bad\0target" })).rejects.toThrow()
  expect(await fs.readFile(target, "utf8")).toBe("parent\n")
  expect(await fs.readdir(dir)).toEqual(["linked.txt"])
  await TaskIsolation.place(target, { symlink: "other.txt" })
  expect(await fs.readlink(target)).toBe("other.txt")
  await fs.rm(dir, { recursive: true, force: true })
})

for (const via of ["settle", "reconcile"] as const)
  it.instance(
    `an isolated start that fails before its checkout exists ends unchanged with its error through ${via}`,
    () =>
      Effect.gen(function* () {
        const dependency = yield* fixture
        yield* write(dependency.home.directory, "same.txt", "base\n")
        yield* git(dependency.home.directory, ["add", "same.txt"])
        yield* git(dependency.home.directory, ["commit", "-m", "base"])
        const dep = yield* dependency.start
        yield* write(dep.work.directory, "same.txt", "dependency\n")
        yield* dependency.settle()
        const f = yield* fixture
        // The parent changed the same line since, so stacking the dependency conflicts before any checkout exists.
        yield* write(f.home.directory, "same.txt", "parent\n")
        yield* f.isolation.reserve({
          taskID: f.child.id,
          parentSessionID: f.parent.id,
          title: "Conflicting stack",
          agent: f.agent,
          dependsOn: [dependency.child.id],
        })
        expect(Exit.isFailure(yield* f.isolation.start(f.child.id).pipe(Effect.exit))).toBe(true)
        const failed = yield* f.isolation.get(f.child.id)
        expect(failed.state).toBe("failed")
        // The job's save barrier settles the attempt (TaskIsolation.complete); a restart's recovery reconciles it.
        const ended = via === "settle" ? yield* f.settle() : yield* f.isolation.reconcile(f.child.id)
        expect(ended.state).toBe("unchanged")
        expect(ended.error).toBe(failed.error)
        expect(TaskIsolation.report(ended)).toContain("could not be prepared")
        expect(yield* exists(f.workPath)).toBe(false)
        expect((yield* f.settle()).state).toBe("unchanged")
        expect((yield* f.isolation.discard({ taskID: f.child.id, by: { kind: "owner" } })).record.state).toBe(
          "unchanged",
        )
      }),
    { git: true },
  )

it.instance("a copy resume after an unchanged save copies a fresh baseline, with its links", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const registry = path.dirname(f.recordPath)
    yield* write(f.home.directory, "target.txt", "target\n")
    yield* write(f.home.directory, "gone.txt", "gone\n")
    yield* Effect.promise(() => fs.symlink("target.txt", path.join(f.home.directory, "link.txt")))
    yield* f.start
    expect((yield* f.settle()).state).toBe("unchanged")
    // The removed copy takes its baseline with it.
    expect(yield* exists(path.join(registry, "baseline"))).toBe(false)
    expect(yield* exists(path.join(registry, "baseline.json"))).toBe(false)
    // An earlier attempt's baseline left in place (by a crash mid-start, say) holds a link and a file since deleted.
    yield* write(path.join(registry, "baseline"), "gone.txt", "gone\n")
    yield* Effect.promise(() => fs.symlink("target.txt", path.join(registry, "baseline", "link.txt")))
    yield* Effect.promise(() => fs.unlink(path.join(f.home.directory, "gone.txt")))
    yield* f.isolation.resume({ taskID: f.child.id, attempt: 2, agent: f.agent })
    expect(yield* exists(path.join(registry, "baseline", "gone.txt"))).toBe(false)
    yield* write(f.workPath, "one.txt", "one\n")
    const saved = yield* f.isolation.settle({ taskID: f.child.id, attempt: 2 })
    expect(saved.state).toBe("changed")
    expect(saved.files.map((file) => file.path)).toEqual(["one.txt"])
  }),
)

it.instance("copy merges keep only the baseline they use, and none once the task is merged", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const registry = path.dirname(f.recordPath)
    const bases = Effect.promise(async () => (await fs.readdir(registry)).filter((name) => name.startsWith("base-")))
    yield* f.start
    for (const file of ["one.txt", "two.txt", "three.txt"]) yield* write(f.workPath, file, `${file}\n`)
    yield* f.settle()
    const first = yield* f.isolation.merge({ taskID: f.child.id, files: ["one.txt"], by: { kind: "owner" } })
    expect(yield* bases).toEqual([first.record.copyBase!])
    const second = yield* f.isolation.merge({ taskID: f.child.id, files: ["two.txt"], by: { kind: "owner" } })
    expect(yield* bases).toEqual([second.record.copyBase!])
    const rest = yield* f.isolation.merge({ taskID: f.child.id, by: { kind: "owner" } })
    expect(rest.record.state).toBe("merged")
    expect(yield* bases).toEqual([])
    expect(yield* exists(path.join(registry, "baseline"))).toBe(false)
    // The saved patch, the checkpoints and the record stay.
    expect(yield* exists(rest.record.savedPatch)).toBe(true)
    expect(yield* exists(f.recordPath)).toBe(true)
    expect((yield* f.isolation.changes({ taskID: f.child.id, diff: true, control: true })).patch).toContain("three.txt")
  }),
)
