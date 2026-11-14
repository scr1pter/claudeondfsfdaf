import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { IsolationCopy } from "../../src/isolation/copy"

const temporary: string[] = []
const junction = process.platform === "win32" ? "junction" : "dir"
const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0

async function scratch() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-copy-")))
  temporary.push(root)
  const source = path.join(root, "project")
  const target = path.join(root, "copy")
  const checkpoint = path.join(root, "checkpoint", "state.patch")
  await mkdir(source)
  return { root, source, target, checkpoint }
}

async function put(root: string, file: string, content: string) {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

const absent = (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
    throw error
  })
const saved = (checkpoint: string, file: string) => path.join(path.dirname(checkpoint), "overwritten", file)

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("IsolationCopy project listing and hashing", () => {
  test("link inventories normalize copied internal targets and omit generated directories without following links", async () => {
    const { root, source, target } = await scratch()
    await mkdir(path.join(source, "real"))
    await mkdir(path.join(source, "node_modules"))
    await mkdir(path.join(root, "outside"))
    await symlink(path.join(source, "real"), path.join(source, "inside"), junction)
    await symlink(path.join(source, "real"), path.join(source, "__proto__"), junction)
    await symlink(path.join(root, "outside"), path.join(source, "outside"), junction)
    await symlink(path.join(root, "outside"), path.join(source, "node_modules", "ignored"), junction)
    const links = await IsolationCopy.projectLinks(source)
    expect(links.inside).toBe("internal:real")
    expect(links.outside).toBe(`external:${path.join(root, "outside")}`)
    expect(Object.keys(links).sort()).toEqual(["__proto__", "inside", "outside"])
    await IsolationCopy.copyProject(source, target)
    expect(await IsolationCopy.projectLinks(target)).toEqual({
      inside: "internal:real",
      ["__proto__"]: "internal:real",
    })
  })

  test("hashes files named after prototype properties as ordinary own entries", async () => {
    const { source } = await scratch()
    for (const file of ["__proto__", "constructor", "toString"]) await put(source, file, file)
    const hashes = await IsolationCopy.hashProject(source)
    expect(Object.keys(hashes).sort()).toEqual(["__proto__", "constructor", "toString"])
    for (const file of Object.keys(hashes))
      expect(hashes[file]).toBe(await IsolationCopy.hashFile(path.join(source, file)))
  })

  test("keeps sorted regular files and the existing exclusions and five-MiB diff cap", async () => {
    const { source } = await scratch()
    for (const file of [
      "z.txt",
      "src/a.ts",
      ".env",
      ".DS_Store",
      ".git/config",
      "node_modules/a.js",
      "dist/bundle.js",
      "src/build/out.js",
      "coverage/result.json",
    ])
      await put(source, file, file)
    await put(source, "large.bin", "")
    await truncate(path.join(source, "large.bin"), 5 * 1024 * 1024 + 1)
    expect(await IsolationCopy.listProjectFiles(source)).toEqual([".env", path.join("src", "a.ts"), "z.txt"])
  })

  test("hashes content with SHA-256 and builds the existing relative-file map", async () => {
    const { source } = await scratch()
    await put(source, "hello.txt", "hello")
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    expect(await IsolationCopy.hashFile(path.join(source, "hello.txt"))).toBe(digest)
    expect(await IsolationCopy.hashProject(source)).toEqual({ "hello.txt": digest })
    await expect(IsolationCopy.hashFile(source)).rejects.toThrow("non-file")
  })

  test("does not scan an explicit current directory outside the root", async () => {
    const { root, source } = await scratch()
    await expect(IsolationCopy.listProjectFiles(source, root)).rejects.toThrow("leave its root")
  })
})

describe("IsolationCopy project copies", () => {
  test("copies regular and large files while excluding generated directory contents", async () => {
    const { source, target } = await scratch()
    await put(source, "src/app.ts", "export const app = true")
    await put(source, ".DS_Store", "kept by the existing copy behavior")
    await put(source, "large.bin", "")
    await truncate(path.join(source, "large.bin"), 5 * 1024 * 1024 + 1)
    for (const file of [".git/config", "node_modules/dependency.js", "src/build/output.js", ".cache/data"])
      await put(source, file, "excluded")
    expect(await IsolationCopy.copyProject(source, target)).toEqual({ skipped: [] })
    expect(await readFile(path.join(target, "src/app.ts"), "utf8")).toBe("export const app = true")
    expect((await stat(path.join(target, "large.bin"))).size).toBe(5 * 1024 * 1024 + 1)
    expect(await readFile(path.join(target, ".DS_Store"), "utf8")).toBe("kept by the existing copy behavior")
    for (const file of [".git", "node_modules", "src/build", ".cache"])
      expect(await absent(path.join(target, file))).toBeUndefined()
  })

  test("a project root under a directory named build is still a project", async () => {
    const { root, target } = await scratch()
    const source = path.join(root, "build", "source")
    await put(source, "app.ts", "source")
    await IsolationCopy.copyProject(source, target)
    expect(await readFile(path.join(target, "app.ts"), "utf8")).toBe("source")
  })

  test("refuses the file-count limit before creating the target", async () => {
    const { source, target } = await scratch()
    await put(source, "a", "a")
    await put(source, "b", "b")
    await expect(IsolationCopy.copyProject(source, target, { maxFiles: 1 })).rejects.toMatchObject({
      name: "IsolationCopy.LimitError",
      limit: "files",
      maximum: 1,
      actual: 2,
    })
    expect(await absent(target)).toBeUndefined()
  })

  test("refuses the byte limit before writes, including files the diff scanner omits", async () => {
    const { source, target } = await scratch()
    await put(source, "large.bin", "")
    await truncate(path.join(source, "large.bin"), 5 * 1024 * 1024 + 1)
    expect(await IsolationCopy.listProjectFiles(source)).toEqual([])
    await expect(IsolationCopy.copyProject(source, target, { maxBytes: 5 * 1024 * 1024 })).rejects.toMatchObject({
      limit: "bytes",
      maximum: 5 * 1024 * 1024,
      actual: 5 * 1024 * 1024 + 1,
    })
    expect(await absent(target)).toBeUndefined()
  })

  test("exact limits allow a copy and excluded content does not consume them", async () => {
    const { source, target } = await scratch()
    await put(source, "app.ts", "hello")
    await put(source, "node_modules/a", "much more than the limit")
    await IsolationCopy.copyProject(source, target, { maxFiles: 1, maxBytes: 5 })
    expect(await readFile(path.join(target, "app.ts"), "utf8")).toBe("hello")
  })

  test("invalid limits are refused before a target is written", async () => {
    const { source, target } = await scratch()
    for (const limit of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN])
      await expect(IsolationCopy.copyProject(source, target, { maxBytes: limit })).rejects.toThrow(
        "non-negative safe integers",
      )
    expect(await absent(target)).toBeUndefined()
  })

  test("skips an escaping directory link and rebases an internal directory link into the copy", async () => {
    const { root, source, target } = await scratch()
    const outside = path.join(root, "outside")
    await put(outside, "private.txt", "untouched")
    await put(source, "assets/file.txt", "source")
    await symlink(outside, path.join(source, "escape"), junction)
    await symlink(path.join(source, "assets"), path.join(source, "alias"), junction)
    const result = await IsolationCopy.copyProject(source, target)
    expect(result.skipped).toEqual(["escape"])
    expect(await absent(path.join(target, "escape"))).toBeUndefined()
    expect(await realpath(path.join(target, "alias"))).toBe(await realpath(path.join(target, "assets")))
    await writeFile(path.join(target, "alias/file.txt"), "isolated")
    expect(await readFile(path.join(source, "assets/file.txt"), "utf8")).toBe("source")
    expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe("untouched")
  })

  test.skipIf(process.platform === "win32")("rebases safe file links and skips dangling or cyclic links", async () => {
    const { source, target } = await scratch()
    await put(source, "assets/file.txt", "source")
    await symlink("./assets/file.txt", path.join(source, "file-link"))
    await symlink("./missing.txt", path.join(source, "broken"))
    await symlink("./loop-b", path.join(source, "loop-a"))
    await symlink("./loop-a", path.join(source, "loop-b"))
    const result = await IsolationCopy.copyProject(source, target)
    expect(result.skipped).toEqual(["broken", "loop-a", "loop-b"])
    expect(await realpath(path.join(target, "file-link"))).toBe(path.join(target, "assets/file.txt"))
    expect(await readlink(path.join(target, "file-link"))).toBe(path.join("assets", "file.txt"))
    await writeFile(path.join(target, "file-link"), "isolated")
    expect(await readFile(path.join(source, "assets/file.txt"), "utf8")).toBe("source")
  })

  test("does not retain an internal link whose target is an excluded directory", async () => {
    const { source, target } = await scratch()
    await put(source, "node_modules/a", "excluded")
    await symlink(path.join(source, "node_modules"), path.join(source, "dependencies"), junction)
    expect((await IsolationCopy.copyProject(source, target)).skipped).toEqual(["dependencies"])
    expect(await absent(path.join(target, "dependencies"))).toBeUndefined()
  })

  test("rebases an internal link to the project root", async () => {
    const { source, target } = await scratch()
    await put(source, "app.ts", "source")
    await symlink(source, path.join(source, "self"), junction)
    await IsolationCopy.copyProject(source, target)
    expect(await realpath(path.join(target, "self"))).toBe(target)
    await writeFile(path.join(target, "self/app.ts"), "isolated")
    expect(await readFile(path.join(source, "app.ts"), "utf8")).toBe("source")
  })

  test("refuses overlapping source and target trees", async () => {
    const { root, source } = await scratch()
    await put(source, "keep.txt", "source")
    for (const target of [source, path.join(source, "nested"), root])
      await expect(IsolationCopy.copyProject(source, target)).rejects.toThrow("must not overlap")
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("source")
  })

  test("refuses target root and nested directory symlinks without writing outside the target", async () => {
    const { root, source, target } = await scratch()
    const outside = path.join(root, "outside")
    await put(outside, "keep.txt", "untouched")
    await put(source, "src/keep.txt", "replacement")
    await symlink(outside, target, junction)
    await expect(IsolationCopy.copyProject(source, target)).rejects.toThrow("destination is a link")
    // unlink drops only the link, where Bun's rm fails on a link to a folder on Windows.
    await unlink(target)
    await mkdir(target)
    await symlink(outside, path.join(target, "src"), junction)
    await expect(IsolationCopy.copyProject(source, target)).rejects.toThrow("destination is a link")
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("untouched")
  })

  test("refuses a destination hard link before overwriting its shared contents", async () => {
    const { root, source, target } = await scratch()
    await put(root, "outside.txt", "untouched")
    await put(source, "file.txt", "replacement")
    await mkdir(target)
    await link(path.join(root, "outside.txt"), path.join(target, "file.txt"))
    await expect(IsolationCopy.copyProject(source, target)).rejects.toThrow("destination is a link")
    expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("untouched")
  })
})

describe("IsolationCopy merge backups", () => {
  test("preserves nested files, directories and the latest version of an overwritten file", async () => {
    const { source, checkpoint } = await scratch()
    await put(source, "src/a.txt", "first")
    await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "src/a.txt")
    expect(await readFile(saved(checkpoint, "src/a.txt"), "utf8")).toBe("first")
    await put(source, "src/a.txt", "second")
    await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "src")
    expect(await readFile(saved(checkpoint, "src/a.txt"), "utf8")).toBe("second")
  })

  test("does not create a placeholder for a source that never existed", async () => {
    const { source, checkpoint } = await scratch()
    await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "missing/new.txt")
    expect(await absent(path.dirname(checkpoint))).toBeUndefined()
  })

  test.skipIf(process.platform === "win32")(
    "preserves dangling and external symlinks verbatim rather than their targets",
    async () => {
      const { root, source, checkpoint } = await scratch()
      await symlink("./missing-target", path.join(source, "broken"))
      await symlink(path.join(root, "outside"), path.join(source, "external"))
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "broken")
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "external")
      expect((await lstat(saved(checkpoint, "broken"))).isSymbolicLink()).toBe(true)
      expect(await readlink(saved(checkpoint, "broken"))).toBe("./missing-target")
      expect(await readlink(saved(checkpoint, "external"))).toBe(path.join(root, "outside"))
    },
  )

  test.skipIf(process.platform === "win32")("can back up the same dangling link repeatedly", async () => {
    const { source, checkpoint } = await scratch()
    await symlink("./missing-target", path.join(source, "broken"))
    await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "broken")
    await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "broken")
    expect((await lstat(saved(checkpoint, "broken"))).isSymbolicLink()).toBe(true)
    expect(await readlink(saved(checkpoint, "broken"))).toBe("./missing-target")
  })

  test.skipIf(process.platform === "win32")(
    "replaces nested internal-link backups without following them",
    async () => {
      const { source, checkpoint } = await scratch()
      await put(source, "src/real.txt", "source")
      await symlink("./real.txt", path.join(source, "src/alias.txt"))
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "src")
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "src")
      expect(await readlink(saved(checkpoint, "src/alias.txt"))).toBe("./real.txt")
      expect(await readFile(saved(checkpoint, "src/real.txt"), "utf8")).toBe("source")
    },
  )

  test.skipIf(process.platform === "win32")(
    "replaces a previous link backup with the latest regular file",
    async () => {
      const { root, source, checkpoint } = await scratch()
      const outside = path.join(root, "outside.txt")
      await writeFile(outside, "untouched")
      await symlink(outside, path.join(source, "entry"))
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "entry")
      await rm(path.join(source, "entry"))
      await put(source, "entry", "latest")
      await IsolationCopy.backupBeforeOverwrite(checkpoint, source, "entry")
      expect((await lstat(saved(checkpoint, "entry"))).isFile()).toBe(true)
      expect(await readFile(saved(checkpoint, "entry"), "utf8")).toBe("latest")
      expect(await readFile(outside, "utf8")).toBe("untouched")
    },
  )

  test("refuses traversal or absolute file arguments", async () => {
    const { root, source, checkpoint } = await scratch()
    for (const file of ["../outside.txt", path.join(root, "outside.txt"), "C:\\outside.txt"])
      await expect(IsolationCopy.backupBeforeOverwrite(checkpoint, source, file)).rejects.toThrow()
    expect(await absent(path.dirname(checkpoint))).toBeUndefined()
  })

  test("refuses an escaping source parent or backup destination directory link", async () => {
    const { root, source, checkpoint } = await scratch()
    const outside = path.join(root, "outside")
    await put(outside, "file.txt", "untouched")
    await symlink(outside, path.join(source, "escape"), junction)
    await expect(IsolationCopy.backupBeforeOverwrite(checkpoint, source, "escape/file.txt")).rejects.toThrow(
      "parent link",
    )
    await put(source, "file.txt", "source")
    await symlink(outside, path.dirname(checkpoint), junction)
    await expect(IsolationCopy.backupBeforeOverwrite(checkpoint, source, "file.txt")).rejects.toThrow(
      "destination is a link",
    )
    expect(await readFile(path.join(outside, "file.txt"), "utf8")).toBe("untouched")
  })

  test("propagates a backup destination failure before any original can be overwritten", async () => {
    const { root, source } = await scratch()
    const blocked = path.join(root, "blocked")
    await writeFile(blocked, "not a directory")
    await put(source, "file.txt", "irreplaceable")
    await expect(
      IsolationCopy.backupBeforeOverwrite(path.join(blocked, "state.patch"), source, "file.txt"),
    ).rejects.toThrow()
    expect(await readFile(path.join(source, "file.txt"), "utf8")).toBe("irreplaceable")
  })

  test("refuses a hard-linked backup before overwriting its shared contents", async () => {
    const { root, source, checkpoint } = await scratch()
    await put(root, "outside.txt", "untouched")
    await put(source, "file.txt", "source")
    await mkdir(path.dirname(saved(checkpoint, "file.txt")), { recursive: true })
    await link(path.join(root, "outside.txt"), saved(checkpoint, "file.txt"))
    await expect(IsolationCopy.backupBeforeOverwrite(checkpoint, source, "file.txt")).rejects.toThrow(
      "destination is a link",
    )
    expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("untouched")
    expect(await readFile(path.join(source, "file.txt"), "utf8")).toBe("source")
  })

  test.skipIf(!canDenyRead)("propagates source lookup errors instead of reporting a missing backup", async () => {
    const { source, checkpoint } = await scratch()
    await put(source, "private/file.txt", "irreplaceable")
    await chmod(path.join(source, "private"), 0o000)
    try {
      await expect(IsolationCopy.backupBeforeOverwrite(checkpoint, source, "private/file.txt")).rejects.toThrow()
    } finally {
      await chmod(path.join(source, "private"), 0o700)
    }
  })
})
