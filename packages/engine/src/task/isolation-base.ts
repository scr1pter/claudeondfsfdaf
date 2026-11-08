import path from "node:path"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { Effect, Stream } from "effect"
import { IsolationCopy } from "@vectordevai/core/isolation/copy"
import type { Git } from "@/git"

export type Run = (cwd: string, args: string[], options?: Omit<Git.Options, "cwd">) => Effect.Effect<Buffer, Error>

export type GitBase = {
  parentDirectory: string
  registry: string
  seed: string
  tip: string
  reviewBase?: string
}

const missing = (cause: unknown) => ["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException)?.code ?? "")
const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
const io = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: error })
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
const relative = (file: string) =>
  !!file &&
  !file.includes("\0") &&
  !path.isAbsolute(file) &&
  !path.win32.isAbsolute(file) &&
  !/^[a-z]:/i.test(file) &&
  file.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
const inside = (root: string, file: string) => {
  const value = path.relative(root, file)
  return value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`))
}

/** A logical merge base advances only the selected paths, independently of the child's provenance seed. */
export const advanceGit = Effect.fn("IsolationBase.advanceGit")(function* (
  record: GitBase,
  selected: readonly string[],
  run: Run,
) {
  const base = record.reviewBase ?? record.seed
  if (!oid(base) || !oid(record.tip) || !selected.every(relative))
    return yield* Effect.fail(new Error("The logical Git merge base has an unsafe commit or file path."))
  if (selected.length === 0) return base
  const registry = yield* io(() => directory(record.registry))
  return yield* Effect.acquireUseRelease(
    io(async () => {
      const temporary = path.join(registry, `index-${randomUUID()}`)
      await mkdir(temporary, { mode: 0o700 })
      return temporary
    }),
    (temporary) =>
      Effect.gen(function* () {
        const index = path.join(temporary, "index")
        const env = { GIT_INDEX_FILE: index }
        yield* run(record.parentDirectory, ["read-tree", base], { env })
        yield* io(() => chmod(index, 0o600))
        const patch = yield* run(record.parentDirectory, [
          "--literal-pathspecs",
          "diff",
          "--binary",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          base,
          record.tip,
          "--",
          ...new Set(selected),
        ])
        if (patch.length === 0) return base
        yield* run(record.parentDirectory, ["apply", "--cached", "--binary", "-"], {
          env,
          stdin: Stream.make(patch),
        })
        const tree = (yield* run(record.parentDirectory, ["write-tree"], { env })).toString("utf8").trim()
        if (!oid(tree)) return yield* Effect.fail(new Error("Git returned an invalid logical merge tree."))
        // --default distinguishes an unset identity from an actual Git/configuration failure.
        const name = (yield* run(record.parentDirectory, ["config", "--default", "", "--get", "user.name"]))
          .toString("utf8")
          .trim()
        const email = (yield* run(record.parentDirectory, ["config", "--default", "", "--get", "user.email"]))
          .toString("utf8")
          .trim()
        const commit = (yield* run(
          record.parentDirectory,
          [
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            tree,
            "-p",
            base,
            "-m",
            "Vector: logical merge base after a partial task merge",
          ],
          {
            env: {
              ...(!name ? { GIT_AUTHOR_NAME: "Vector", GIT_COMMITTER_NAME: "Vector" } : {}),
              ...(!email ? { GIT_AUTHOR_EMAIL: "bot@vectordev.ai", GIT_COMMITTER_EMAIL: "bot@vectordev.ai" } : {}),
            },
          },
        ))
          .toString("utf8")
          .trim()
        if (!oid(commit)) return yield* Effect.fail(new Error("Git returned an invalid logical merge commit."))
        return commit
      }),
    (temporary) => io(() => rm(temporary, { recursive: true, force: true })).pipe(Effect.orDie),
  )
})

async function directory(file: string) {
  const info = await lstat(file)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A logical baseline root must be a directory.")
  return realpath(file)
}

/** Inspect every parent without following links, including for a selected path that has been deleted. */
async function entry(root: string, file: string, nonDirectoryIsMissing = false) {
  if (!relative(file)) throw new Error("A logical baseline path must be project-relative.")
  const target = path.resolve(root, file)
  if (!inside(root, target)) throw new Error("A logical baseline path cannot leave its root.")
  const names = path.relative(root, target).split(path.sep)
  for (const [index, name] of names.entries()) {
    const current = path.join(root, ...names.slice(0, index), name)
    const info = await lstat(current).catch((cause) => {
      if (missing(cause)) return undefined
      throw cause
    })
    if (!info) return undefined
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
      throw new Error("A logical baseline cannot follow symbolic or hard links.")
    if (index < names.length - 1 && nonDirectoryIsMissing && info.isFile()) return undefined
    if (index < names.length - 1 && !info.isDirectory())
      throw new Error("A logical baseline parent must be a directory.")
    if (index === names.length - 1) return info
  }
}

/** A baseline version contains private regular files; incidental baseline links are outside the logical file set. */
async function clone(source: string, target: string, current = source) {
  for (const item of await readdir(current, { withFileTypes: true })) {
    const file = path.relative(source, path.join(current, item.name))
    if (!relative(file)) throw new Error("The existing logical baseline contains an unsafe path.")
    const info = await lstat(path.join(source, file))
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await mkdir(path.join(target, file), { mode: 0o700 })
      await clone(source, target, path.join(source, file))
      continue
    }
    if (!info.isFile() || info.nlink !== 1) throw new Error("The existing logical baseline is not a private file tree.")
    await copyFile(path.join(source, file), path.join(target, file), constants.COPYFILE_EXCL)
    await chmod(path.join(target, file), 0o600)
  }
}

async function prune(root: string, file: string) {
  const parent = path.dirname(file)
  if (parent === root || !inside(root, parent)) return
  await rmdir(parent).catch((cause: NodeJS.ErrnoException) => {
    if (missing(cause) || cause.code === "ENOTEMPTY" || cause.code === "EEXIST") return
    throw cause
  })
  if (
    !(await lstat(parent).catch((cause) => {
      if (missing(cause)) return undefined
      throw cause
    }))
  )
    await prune(root, parent)
}

export type CopyBase = { registry: string; directory: string; baselineDirectory: string }

/** Returns an immutable version. Callers publish its basename only after the merge writes succeed. */
export async function advanceCopy(record: CopyBase, selected: readonly string[], maxFileBytes: number) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || !selected.every(relative))
    throw new Error("The logical copy merge base has an unsafe limit or file path.")
  const registry = await directory(record.registry)
  const source = await directory(record.directory)
  const baselinePath = path.relative(path.resolve(record.registry), path.resolve(record.baselineDirectory))
  if (!(await entry(path.resolve(record.registry), baselinePath))?.isDirectory())
    throw new Error("The logical copy baseline must be a private directory inside its registry.")
  const baseline = await directory(record.baselineDirectory)
  if (!inside(registry, baseline) || registry === baseline || inside(registry, source) || inside(source, registry))
    throw new Error("Logical copy baselines must stay inside their registry and outside the working tree.")
  const files = await Promise.all(
    [...new Set(selected)].map(async (file) => {
      const info = await entry(source, file, true)
      if (info && !info.isDirectory() && !info.isFile())
        throw new Error("Only ordinary files can advance a copy baseline.")
      if (info?.isFile() && info.size > maxFileBytes)
        throw new Error("A selected copy baseline file exceeds its size limit.")
      return { file, present: info?.isFile() === true }
    }),
  )
  const name = `base-${randomUUID()}`
  const version = path.join(registry, name)
  const target = path.join(version, "files")
  await mkdir(version, { mode: 0o700 })
  return (async () => {
    await mkdir(target, { mode: 0o700 })
    await clone(baseline, target)
    // Deletions precede additions so a selected file/directory transition cannot consume unselected contents.
    for (const item of files.filter((item) => !item.present).sort((a, b) => b.file.length - a.file.length)) {
      const info = await entry(target, item.file)
      if (info?.isFile()) {
        await unlink(path.join(target, item.file))
        await prune(target, path.join(target, item.file))
      }
    }
    for (const item of files.filter((item) => item.present)) {
      const info = await entry(target, item.file)
      if (info?.isDirectory()) await rmdir(path.join(target, item.file))
      if (info?.isFile()) await unlink(path.join(target, item.file))
      await mkdir(path.dirname(path.join(target, item.file)), { recursive: true, mode: 0o700 })
      await entry(source, item.file)
      await copyFile(path.join(source, item.file), path.join(target, item.file), constants.COPYFILE_EXCL)
      await chmod(path.join(target, item.file), 0o600)
      if ((await lstat(path.join(target, item.file))).size > maxFileBytes)
        throw new Error("A selected copy baseline file exceeds its size limit.")
    }
    const hashes = await IsolationCopy.hashProject(target, maxFileBytes)
    if (Object.values(hashes).includes("missing")) throw new Error("A logical baseline file could not be hashed.")
    await writeFile(path.join(version, "hashes.json"), JSON.stringify(hashes), { flag: "wx", mode: 0o600 })
    return { name, directory: target, hashes }
  })().catch(async (cause) => {
    await rm(version, { recursive: true, force: true })
    throw cause
  })
}

export * as IsolationBase from "./isolation-base"
