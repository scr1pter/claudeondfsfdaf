import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@vectordevai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Hash } from "@vectordevai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@vectordevai/core/global"
import { Info } from "@vectordevai/schema/file-diff"
import { TaskPlace } from "@/task/place"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

// A snapshot's tree object is gone from the shadow repo — almost always because
// `git gc --prune` collected it. Callers must treat this as a hard failure:
// the old behaviour was to read an unreadable snapshot as "this file was not in
// it" and delete the user's file.
export class SnapshotUnavailableError extends Schema.TaggedErrorClass<SnapshotUnavailableError>()(
  "SnapshotUnavailableError",
  {
    hash: Schema.String,
    file: Schema.optional(Schema.String),
  },
) {}

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
// The shadow repo's own settings. untrackedCache, manyFiles and the index settings tune very large worktrees so the
// first add stays bounded.
const SHADOW_CONFIG = [
  "[core]",
  "\tautocrlf = false",
  "\tlongpaths = true",
  "\tsymlinks = true",
  "\tfsmonitor = false",
  "\tuntrackedCache = true",
  "[feature]",
  "\tmanyFiles = true",
  "[index]",
  "\tversion = 4",
  "\tthreads = true",
  "",
].join("\n")
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void, SnapshotUnavailableError>
  readonly revert: (patches: Patch[]) => Effect.Effect<void, SnapshotUnavailableError>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const isolated = TaskPlace.isTaskDirectory(ctx.directory) || TaskPlace.isTaskDirectory(ctx.worktree)
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (isolated) return false
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const cache = { exclude: undefined as string | undefined, anchored: new Set<string>() }

        // Where the source repository keeps its exclude file does not change while the instance lives, so git is asked
        // once; the file itself is still checked and read on every sync, since its content can change.
        const excludes = Effect.fnUntraced(function* () {
          if (!cache.exclude) {
            const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
              cwd: state.worktree,
            })
            cache.exclude = result.text.trim() || undefined
          }
          if (!cache.exclude) return
          if (!(yield* exists(cache.exclude))) return
          return cache.exclude
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        // write-tree leaves the tree unreferenced, so the periodic `git gc
        // --prune` below is free to collect it and the snapshot silently stops
        // existing. Wrapping it in a commit under refs/vector keeps it
        // reachable for as long as the shadow repo lives. A tree this process already anchored keeps its ref, so an
        // unchanged worktree, the usual case between one step's closing snapshot and the next step's opening one,
        // spawns no further git processes here.
        const anchor = Effect.fnUntraced(function* (hash: string) {
          if (!hash || cache.anchored.has(hash)) return
          const commit = yield* git([...core, ...args(["commit-tree", hash, "-m", "vector snapshot"])], {
            cwd: state.directory,
            env: {
              GIT_AUTHOR_NAME: "Vector",
              GIT_AUTHOR_EMAIL: "noreply@vectordev.ai",
              GIT_COMMITTER_NAME: "Vector",
              GIT_COMMITTER_EMAIL: "noreply@vectordev.ai",
            },
          })
          if (commit.code !== 0 || !commit.text.trim()) {
            yield* Effect.logWarning("failed to anchor snapshot", { hash, stderr: commit.stderr })
            return
          }
          const ref = yield* git([
            "--git-dir",
            state.gitdir,
            "update-ref",
            `refs/vector/snapshot/${hash}`,
            commit.text.trim(),
          ])
          if (ref.code !== 0) {
            yield* Effect.logWarning("failed to write snapshot ref", { hash, stderr: ref.stderr })
            return
          }
          cache.anchored.add(hash)
        })

        // Whether the snapshot's tree can still be read. This is the difference
        // between "the file was not in this snapshot" and "the snapshot is
        // gone", which look identical from a failed ls-tree.
        const readable = Effect.fnUntraced(function* (hash: string) {
          const result = yield* git([...core, ...args(["cat-file", "-e", `${hash}^{tree}`])], { cwd: state.worktree })
          return result.code === 0
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                // A fresh repo has none of this process's anchors.
                cache.anchored.clear()
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                // One write instead of a `git config` process per setting. Git reads a repeated section as one, the
                // last value of a key winning, so this is the configuration those commands would leave.
                const file = path.join(state.gitdir, "config")
                if (yield* exists(file))
                  yield* fs
                    .writeFileString(file, `${(yield* read(file)).trimEnd()}\n${SHADOW_CONFIG}`)
                    .pipe(Effect.catch((error) => Effect.logWarning("failed to configure snapshot repo", { error })))
                yield* seed()
                yield* Effect.logInfo("initialized")
              }
              yield* add()
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              yield* anchor(hash)
              yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              // --no-renames: rename detection collapses a delete+create pair
              // into one entry whose --name-only output is only the destination,
              // so revert would delete the new file and never restore the old
              // one — both halves of a rename gone. diffFull already disables it.
              const result = yield* git(
                [
                  ...quote,
                  ...args(["diff", "--cached", "--no-ext-diff", "--no-renames", "--name-only", hash, "--", "."]),
                ],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return yield* Effect.fail(new SnapshotUnavailableError({ hash: snapshot }))
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
              // Returning void here told the caller the checkout had succeeded,
              // so a failed undo was reported to the user as a completed one.
              return yield* Effect.fail(new SnapshotUnavailableError({ hash: snapshot }))
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                // ls-tree fails both when the path is absent from the tree and
                // when the tree itself is unreadable. Only the first means the
                // file did not exist at snapshot time; the second means we are
                // about to delete work we can no longer restore, so fail loudly
                // instead.
                if (!(yield* readable(op.hash))) {
                  yield* Effect.logError("snapshot is no longer readable, refusing to delete", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return yield* Effect.fail(new SnapshotUnavailableError({ hash: op.hash, file: op.file }))
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                // `quote`, not `core`: with core.quotepath at its default git
                // C-quotes any non-ASCII name, so `have` would hold
                // "caf\303\251.txt" while op.rel is café.txt — every such file
                // then failed the membership test below and was deleted as
                // "not in the snapshot".
                const tree = yield* git(
                  [...quote, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                // The same fail-closed rule single() applies: deleting because a
                // file is "not in the snapshot" is only safe when the snapshot
                // itself is readable — otherwise an unreadable tree reads as an
                // empty one and this loop would delete everything in the batch.
                const treeReadable = yield* readable(first.hash)
                for (const op of run) {
                  if (have.has(op.rel)) continue
                  if (!treeReadable) {
                    yield* Effect.logWarning("snapshot unreadable, refusing to delete", {
                      file: op.file,
                      hash: op.hash,
                    })
                    continue
                  }
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--no-renames", hash, "--", "."])],
                {
                  cwd: state.worktree,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    { stdin: refs.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before, after),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        if (!isolated)
          yield* cleanup().pipe(
            Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
            Effect.repeat(Schedule.spaced(Duration.hours(1))),
            Effect.delay(Duration.minutes(1)),
            Effect.forkScoped,
          )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."
