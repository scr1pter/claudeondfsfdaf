import { $ } from "bun"
import { describe, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import os from "node:os"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Effect } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Worktree.node, [[InstanceStore.bootstrapNode, InstanceBootstrap.node]]))
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

/** Points the data folder at `data` for the rest of the test. */
const useData = (data: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const original = Global.Path.data
      Global.Path.data = data
      return original
    }),
    (original) =>
      Effect.sync(() => {
        Global.Path.data = original
      }),
  )

/** A task checkout at its reserved path under the current data folder, made by Git itself. */
const taskCheckout = Effect.fn("WorktreeRemoveTest.taskCheckout")(function* (root: string) {
  const ctx = yield* InstanceState.context
  const name = `ses_${randomUUID().replaceAll("-", "")}`
  const info = {
    name,
    branch: `vector/subagent/${name}`,
    directory: path.join(Global.Path.data, "task-worktree", ctx.project.id, name),
  }
  yield* Effect.promise(() => fs.mkdir(path.dirname(info.directory), { recursive: true }))
  yield* Effect.promise(() => $`git worktree add --no-checkout -b ${info.branch} ${info.directory}`.cwd(root).quiet())
  return info
})

const listed = (root: string) => Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
const branchExists = (root: string, branch: string) =>
  Effect.promise(() => $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow()).pipe(
    Effect.map((result) => result.exitCode === 0),
  )

describe("Worktree.remove", () => {
  it.instance(
    "a task checkout that is gone is removed with its branch when the data folder is reached through a link",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        // Git lists a worktree under the real path it stored, also after the folder is gone. The reserved path here
        // passes through a link, as a linked home, macOS /var or a Windows short name does.
        const outer = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-worktree-link-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const linked = path.join(outer, "linked-data")
        // A junction on Windows, as elsewhere in these tests; unlink drops only the link.
        yield* Effect.acquireRelease(
          Effect.promise(() =>
            fs.symlink(path.dirname(Global.Path.data), linked, process.platform === "win32" ? "junction" : "dir"),
          ),
          () => Effect.promise(() => fs.unlink(linked)),
        )
        yield* useData(path.join(linked, path.basename(Global.Path.data)))
        const info = yield* taskCheckout(root)
        expect(yield* listed(root)).toContain(info.name)
        yield* Effect.promise(() => fs.rm(info.directory, { recursive: true, force: true }))

        expect(yield* svc.removeForTask(info)).toBe(true)
        expect(yield* listed(root)).not.toContain(info.name)
        expect(yield* branchExists(root, info.branch)).toBe(false)
      }),
    { git: true },
  )

  // 8.3 short names exist only on Windows. Git for Windows stores and lists the long name.
  wintest(
    "a task checkout named by its 8.3 short name is removed with its branch",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const long = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-worktree-short-name-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const short = execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long}').ShortPath`,
          ],
          { encoding: "utf8" },
        ).trim()
        // Hosted runners have 8.3 names on the temp volume (their temp folder is itself RUNNER~1); without one this
        // test would prove nothing.
        expect(short.toLowerCase()).not.toBe(realpathSync.native(long).toLowerCase())
        yield* useData(path.join(short, "data"))
        const info = yield* taskCheckout(root)
        expect(yield* listed(root)).toContain(info.name)

        expect(yield* svc.removeForTask(info)).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs.stat(info.directory).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(yield* listed(root)).not.toContain(info.name)
        expect(yield* branchExists(root, info.branch)).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `vector/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `vector/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )
})
