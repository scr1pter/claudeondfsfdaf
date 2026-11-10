import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { IsolationBase } from "@/task/isolation-base"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, CrossSpawnSpawner.node])))
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

it.live("a logical Git base advances selected files without changing the index, branch or working files", () =>
  Effect.gen(function* () {
    const repository = yield* tmpdirScoped({ git: true })
    const registry = yield* tmpdirScoped()
    const git = yield* Git.Service
    const run: IsolationBase.Run = (cwd, args, options) =>
      git
        .run(args, { ...options, cwd })
        .pipe(
          Effect.flatMap((result) =>
            result.exitCode !== 0 || result.truncated
              ? Effect.fail(new Error(result.stderr.toString("utf8") || "Git command failed"))
              : Effect.succeed(result.stdout),
          ),
        )
    const text = (args: string[]) => run(repository, args).pipe(Effect.map((bytes) => bytes.toString("utf8").trim()))
    const seed = yield* text(["rev-parse", "HEAD"])
    yield* Effect.promise(async () => {
      await writeFile(path.join(repository, "one.txt"), "one\n")
      await writeFile(path.join(repository, "two.txt"), "two\n")
    })
    yield* text(["add", "-A"])
    yield* text(["commit", "-m", "child changes"])
    const tip = yield* text(["rev-parse", "HEAD"])
    const branch = yield* text(["symbolic-ref", "HEAD"])
    const index = path.resolve(repository, yield* text(["rev-parse", "--git-path", "index"]))
    const before = yield* Effect.promise(() => readFile(index))
    const base = yield* IsolationBase.advanceGit({ parentDirectory: repository, registry, seed, tip }, ["one.txt"], run)
    expect(yield* text(["ls-tree", "-r", "--name-only", base])).toBe("one.txt")
    expect(yield* text(["show", `${base}:one.txt`])).toBe("one")
    expect(yield* text(["rev-parse", `${base}^`])).toBe(seed)
    expect(yield* text(["rev-parse", "HEAD"])).toBe(tip)
    expect(yield* text(["symbolic-ref", "HEAD"])).toBe(branch)
    expect(yield* Effect.promise(() => readFile(index))).toEqual(before)
    expect(yield* Effect.promise(() => readFile(path.join(repository, "one.txt"), "utf8"))).toBe("one\n")
    expect(yield* Effect.promise(() => readFile(path.join(repository, "two.txt"), "utf8"))).toBe("two\n")
    expect(yield* Effect.promise(() => readdir(registry))).toEqual([])
    const second = yield* IsolationBase.advanceGit(
      { parentDirectory: repository, registry, seed, tip, reviewBase: base },
      ["two.txt"],
      run,
    )
    expect(yield* text(["ls-tree", "-r", "--name-only", second])).toBe("one.txt\ntwo.txt")
    expect(yield* text(["rev-parse", `${second}^`])).toBe(base)
    expect(yield* Effect.promise(() => readFile(index))).toEqual(before)
  }),
)

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-logical-base-")))
  temporary.push(root)
  const registry = path.join(root, "registry")
  const directory = path.join(root, "work")
  const baselineDirectory = path.join(registry, "baseline")
  await mkdir(baselineDirectory, { recursive: true })
  await mkdir(directory)
  return { root, registry, directory, baselineDirectory }
}

async function put(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

describe("immutable logical copy bases", () => {
  test("overlays only selected files and deletions while retaining both previous baselines", async () => {
    const record = await fixture()
    await put(record.baselineDirectory, "one.txt", "old one")
    await put(record.baselineDirectory, "two.txt", "old two")
    await put(record.baselineDirectory, "deleted.txt", "old deletion")
    await put(record.directory, "one.txt", "new one")
    await put(record.directory, "two.txt", "new two")
    const first = await IsolationBase.advanceCopy(record, ["one.txt", "deleted.txt"], 1024)
    expect(first.name).toMatch(/^base-[a-f0-9-]+$/)
    expect(first.directory).toBe(path.join(record.registry, first.name, "files"))
    expect(await readFile(path.join(first.directory, "one.txt"), "utf8")).toBe("new one")
    expect(await readFile(path.join(first.directory, "two.txt"), "utf8")).toBe("old two")
    expect((await readdir(first.directory)).sort()).toEqual(["one.txt", "two.txt"])
    expect(JSON.parse(await readFile(path.join(record.registry, first.name, "hashes.json"), "utf8"))).toEqual(
      first.hashes,
    )
    const second = await IsolationBase.advanceCopy({ ...record, baselineDirectory: first.directory }, ["two.txt"], 1024)
    expect(second.name).not.toBe(first.name)
    expect(await readFile(path.join(second.directory, "two.txt"), "utf8")).toBe("new two")
    expect(await readFile(path.join(first.directory, "two.txt"), "utf8")).toBe("old two")
    expect(await readFile(path.join(record.baselineDirectory, "one.txt"), "utf8")).toBe("old one")
    expect(await readFile(path.join(record.baselineDirectory, "deleted.txt"), "utf8")).toBe("old deletion")
    if (process.platform !== "win32") {
      expect((await stat(path.join(record.registry, second.name))).mode & 0o777).toBe(0o700)
      expect((await stat(second.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(second.directory, "two.txt"))).mode & 0o777).toBe(0o600)
      expect((await stat(path.join(record.registry, second.name, "hashes.json"))).mode & 0o777).toBe(0o600)
    }
  })

  test("rejects traversal and absolute selected paths without creating a baseline version", async () => {
    const record = await fixture()
    await put(record.root, "outside.txt", "untouched")
    for (const file of ["../outside.txt", path.join(record.root, "outside.txt"), "C:\\outside.txt", ".git/config"])
      await expect(IsolationBase.advanceCopy(record, [file], 1024)).rejects.toThrow()
    expect(await readdir(record.registry)).toEqual(["baseline"])
    expect(await readFile(path.join(record.root, "outside.txt"), "utf8")).toBe("untouched")
  })

  test("preserves file-to-directory and directory-to-file transitions without altering the old baseline", async () => {
    const record = await fixture()
    await put(record.baselineDirectory, "was-directory/old.txt", "old nested file")
    await put(record.baselineDirectory, "was-file", "old ordinary file")
    await put(record.directory, "was-directory", "new ordinary file")
    await put(record.directory, "was-file/new.txt", "new nested file")
    const next = await IsolationBase.advanceCopy(
      record,
      ["was-directory/old.txt", "was-directory", "was-file", "was-file/new.txt"],
      1024,
    )
    expect(await readFile(path.join(next.directory, "was-directory"), "utf8")).toBe("new ordinary file")
    expect(await readFile(path.join(next.directory, "was-file/new.txt"), "utf8")).toBe("new nested file")
    expect(await readFile(path.join(record.baselineDirectory, "was-file"), "utf8")).toBe("old ordinary file")
    expect(await readFile(path.join(record.baselineDirectory, "was-directory/old.txt"), "utf8")).toBe("old nested file")
  })

  test("rejects an escaping selected parent link and leaves outside contents untouched", async () => {
    const record = await fixture()
    const outside = path.join(record.root, "outside")
    await put(outside, "file.txt", "untouched")
    await symlink(outside, path.join(record.directory, "escape"), process.platform === "win32" ? "junction" : "dir")
    await expect(IsolationBase.advanceCopy(record, ["escape/file.txt"], 1024)).rejects.toThrow("links")
    expect(await readdir(record.registry)).toEqual(["baseline"])
    expect(await readFile(path.join(outside, "file.txt"), "utf8")).toBe("untouched")
  })

  test.skipIf(process.platform === "win32")(
    "rejects a selected link instead of following it or treating it as deleted",
    async () => {
      const record = await fixture()
      await put(record.baselineDirectory, "file.txt", "old")
      await symlink(path.join(record.root, "missing"), path.join(record.directory, "file.txt"))
      await expect(IsolationBase.advanceCopy(record, ["file.txt"], 1024)).rejects.toThrow("links")
      expect(await readFile(path.join(record.baselineDirectory, "file.txt"), "utf8")).toBe("old")
      expect((await lstat(path.join(record.directory, "file.txt"))).isSymbolicLink()).toBe(true)
      expect(await readdir(record.registry)).toEqual(["baseline"])
    },
  )
})
