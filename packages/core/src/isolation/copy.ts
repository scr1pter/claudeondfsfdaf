import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, lstat, mkdir, readdir, readlink, realpath, stat, symlink, unlink } from "node:fs/promises"
import path from "node:path"

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
])

export type Limits = { maxFiles?: number; maxBytes?: number }

export class LimitError extends Error {
  readonly limit: "files" | "bytes"
  readonly maximum: number
  readonly actual: number

  constructor(limit: "files" | "bytes", maximum: number, actual: number) {
    super(`The project copy exceeds its ${limit} limit (${actual} > ${maximum}).`)
    this.name = "IsolationCopy.LimitError"
    this.limit = limit
    this.maximum = maximum
    this.actual = actual
  }
}

const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function skipped(root: string, file: string) {
  return path
    .relative(root, file)
    .split(/[\\/]/)
    .some((part) => EXCLUDED_DIRS.has(part))
}

/** Project diffs keep their existing five-MiB per-file limit and omit symlinks and generated directories. */
export async function listProjectFiles(
  root: string,
  current = root,
  output: string[] = [],
  maxFileBytes = 5 * 1024 * 1024,
): Promise<string[]> {
  if (!inside(path.resolve(root), path.resolve(current))) throw new Error("The project scan cannot leave its root.")
  const place = await realpath(current).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (place && !inside(await realpath(root), place))
    throw new Error("The project scan cannot follow a link outside its root.")
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      await listProjectFiles(root, path.join(current, entry.name), output, maxFileBytes)
      continue
    }
    if (!entry.isFile()) continue
    const fullPath = path.join(current, entry.name)
    const info = await stat(fullPath).catch(() => undefined)
    if (!info || info.size > maxFileBytes) continue
    output.push(path.relative(root, fullPath))
  }
  return output.sort()
}

/** Compare link identities without following them, using the same project exclusions as file capture. */
export async function projectLinks(root: string) {
  const boundary = path.resolve(root)
  const links: Record<string, string> = Object.create(null)
  const scan = async (directory: string): Promise<void> => {
    const current = await lstat(directory)
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("A project scan directory became a link.")
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || EXCLUDED_DIRS.has(entry.name)) continue
      const file = path.join(directory, entry.name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) {
        const target = path.resolve(path.dirname(file), await readlink(file))
        links[path.relative(boundary, file)] = inside(boundary, target)
          ? `internal:${path.relative(boundary, target)}`
          : `external:${target}`
      } else if (info.isDirectory()) await scan(file)
    }
  }
  await scan(boundary)
  return links
}

export async function hashFile(file: string) {
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`Cannot hash a non-file path: ${file}`)
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

export async function hashProject(root: string, maxFileBytes = 5 * 1024 * 1024) {
  const files = await listProjectFiles(root, root, [], maxFileBytes)
  const hashes: Record<string, string> = Object.create(null)
  for (const file of files) hashes[file] = await hashFile(path.join(root, file)).catch(() => "missing")
  return hashes
}

/** Resolves the existing ancestors of a destination that has not been created yet. */
async function destination(file: string): Promise<string> {
  const existing = await realpath(file).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (existing) return existing
  const parent = path.dirname(file)
  if (parent === file) return file
  return path.join(await destination(parent), path.basename(file))
}

/** Refuses existing destination links and hard links before cp could overwrite their targets. */
async function writable(root: string, file: string) {
  const boundary = path.resolve(root)
  const target = path.resolve(file)
  if (!inside(boundary, target)) throw new Error("The copy destination cannot leave its root.")
  const names = path.relative(boundary, target).split(path.sep).filter(Boolean)
  const entries = [boundary, ...names.map((_name, index) => path.join(boundary, ...names.slice(0, index + 1)))]
  for (const entry of entries) {
    const info = await lstat(entry).catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (info?.isSymbolicLink() || (info?.isFile() && info.nlink > 1))
      throw new Error(`The copy destination is a link: ${entry}`)
    if (entry !== target && info && !info.isDirectory())
      throw new Error(`The copy destination is not a directory: ${entry}`)
  }
}

type Link = { source: string; target: string; directory: boolean }

/** Count the same entries as a project copy, including files above the diff/hash limit. */
export async function measureProject(sourcePath: string) {
  const root = await realpath(sourcePath)
  const total = { files: 0, bytes: 0 }
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (skipped(root, file)) continue
      if (entry.isDirectory()) {
        await scan(file)
        continue
      }
      const info = await lstat(file)
      if (info.isSymbolicLink()) {
        const target = await realpath(file).catch((error) => {
          if (missing(error) || (error as NodeJS.ErrnoException)?.code === "ELOOP") return undefined
          throw error
        })
        if (!target || !inside(root, target) || skipped(root, target)) continue
      }
      total.files++
      total.bytes += info.size
    }
  }
  await scan(root)
  return total
}

/** Copies a project with optional admission limits; safe internal links point into the copied tree. */
export async function copyProject(sourcePath: string, targetPath: string, limits: Limits = {}) {
  for (const limit of [limits.maxFiles, limits.maxBytes])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new Error("Copy limits must be non-negative safe integers.")
  const root = await realpath(sourcePath)
  const target = path.resolve(targetPath)
  if (!(await stat(root)).isDirectory()) throw new Error("The project copy source must be a directory.")
  await writable(target, target)
  const resolvedTarget = await destination(target)
  if (inside(root, resolvedTarget) || inside(resolvedTarget, root))
    throw new Error("Project copy source and destination must not overlap.")
  const excluded = new Set<string>()
  const link = async (file: string): Promise<Link | undefined> => {
    const resolved = await realpath(file).catch((error) => {
      if (missing(error) || (error as NodeJS.ErrnoException)?.code === "ELOOP") return undefined
      throw error
    })
    if (!resolved || !inside(root, resolved) || skipped(root, resolved)) {
      excluded.add(path.relative(root, file))
      return undefined
    }
    return {
      source: file,
      target: path.join(target, path.relative(root, resolved)),
      directory: (await stat(resolved)).isDirectory(),
    }
  }
  const counter = () => {
    const total = { files: 0, bytes: 0 }
    return (size: number) => {
      total.files++
      total.bytes += size
      if (limits.maxFiles !== undefined && total.files > limits.maxFiles)
        throw new LimitError("files", limits.maxFiles, total.files)
      if (limits.maxBytes !== undefined && total.bytes > limits.maxBytes)
        throw new LimitError("bytes", limits.maxBytes, total.bytes)
    }
  }
  // Admission counts everything cp will copy, including files larger than the diff/hash limit, before any target write.
  if (limits.maxFiles !== undefined || limits.maxBytes !== undefined) {
    const count = counter()
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (skipped(root, file)) continue
        if (entry.isDirectory()) {
          await scan(file)
          continue
        }
        const info = await lstat(file)
        if (info.isSymbolicLink() && !(await link(file))) continue
        count(info.size)
      }
    }
    await scan(root)
  }
  const links: Link[] = []
  const count = counter()
  await mkdir(path.dirname(target), { recursive: true })
  await cp(root, target, {
    recursive: true,
    dereference: false,
    filter: async (from, to) => {
      if (skipped(root, from)) return false
      const info = await lstat(from)
      if (info.isSymbolicLink()) {
        const safe = await link(from)
        if (safe) {
          count(info.size)
          links.push(safe)
        }
        return false
      }
      await writable(target, to)
      if (info.isFile()) count(info.size)
      return true
    },
  })
  for (const item of links) {
    const to = path.join(target, path.relative(root, item.source))
    await writable(target, to)
    await mkdir(path.dirname(to), { recursive: true })
    await symlink(
      process.platform === "win32" && item.directory
        ? item.target
        : path.relative(path.dirname(to), item.target) || ".",
      to,
      item.directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
    )
  }
  return { skipped: [...excluded].sort() }
}

/** Preserves the exact existing entry, including dangling links, before a merge changes or removes it. */
export async function backupBeforeOverwrite(checkpointPath: string, sourcePath: string, file: string) {
  if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file))
    throw new Error("A backup path must be project-relative.")
  const root = await realpath(sourcePath)
  const from = path.resolve(root, file)
  if (!inside(root, from)) throw new Error("The backup source cannot leave its project.")
  const parent = await realpath(path.dirname(from)).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (!parent) return
  if (!inside(root, parent)) throw new Error("The backup source cannot follow a parent link outside its project.")
  const exists = await lstat(from).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (!exists) return
  const boundary = path.resolve(path.dirname(checkpointPath))
  const to = path.join(boundary, "overwritten", file)
  await prepareBackup(boundary, to)
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: async (_from, target) => {
      await prepareBackup(boundary, target)
      return true
    },
  })
}

/** Repeated backups replace the final link itself; parent links and hard links still fail closed. */
async function prepareBackup(root: string, file: string) {
  await writable(root, path.dirname(file))
  const exists = await lstat(file).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (exists?.isSymbolicLink()) await unlink(file)
  await writable(root, file)
}

export * as IsolationCopy from "./copy"
