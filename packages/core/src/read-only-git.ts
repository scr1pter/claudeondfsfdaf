import { DirectoryIdentityReader } from "./directory-identity"
export * as ReadOnlyGit from "./read-only-git"

import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

const LIMIT = {
  index: 64 * 1024 * 1024,
  config: 64 * 1024,
  refs: 4 * 1024 * 1024,
  objects: 1024 * 1024 * 1024,
  files: 50_000,
}
const CONFIG =
  "^(core\\.(repositoryformatversion|autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode|sparsecheckout|sparsecheckoutcone)|extensions\\..*|include\\.path|includeif\\..*\\.path)$"
const BOOL = new Map([
  ["true", "true"],
  ["yes", "true"],
  ["on", "true"],
  ["1", "true"],
  ["false", "false"],
  ["no", "false"],
  ["off", "false"],
  ["0", "false"],
  ["", "true"],
])

export class Unavailable extends Error {
  readonly code = "READ_ONLY_GIT_UNAVAILABLE"
  constructor(readonly reason: string) {
    super(`Read-only Git inspection is unavailable: ${reason}.`)
  }
}

function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Unavailable(reason)
}

function unavailable(error: unknown) {
  return error instanceof Unavailable ? error : new Unavailable("metadata could not be captured safely")
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
}

async function directory(file: string) {
  const real = await fs.realpath(file)
  requireValue((await fs.lstat(real)).isDirectory(), "invalid metadata directory")
  return real
}

// Linux directory descriptors pin each ancestor. No repository path component is followed as a symlink.
async function openWithin(root: FileHandle, name: string, flags: number, trusted = false) {
  const parts = name.split("/")
  requireValue(
    parts.every((part) => part && part !== "." && part !== ".."),
    "invalid metadata path",
  )
  const parents: FileHandle[] = []
  let parent = root
  try {
    if (trusted) requireValue(await trustedOwner(parent), "Git toolchain ancestry is writable")
    for (const component of parts.slice(0, -1)) {
      parent = await fs.open(
        `/proc/self/fd/${parent.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      parents.push(parent)
      if (trusted) requireValue(await trustedOwner(parent), "Git toolchain ancestry is writable")
    }
    return await fs.open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } finally {
    await Promise.all(parents.map((handle) => handle.close()))
  }
}

async function trustedOwner(handle: FileHandle) {
  const info = await handle.stat()
  return info.uid === 0 && (info.mode & 0o6022) === 0
}

async function trustedProgram(file: string) {
  const anchor = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await openWithin(anchor, file.slice(1), constants.O_RDONLY, true)
    try {
      return (await opened.stat()).isFile() && (await trustedOwner(opened))
    } finally {
      await opened.close()
    }
  } finally {
    await anchor.close()
  }
}

async function pin(file: string) {
  const anchor = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    return await openWithin(anchor, file.slice(1), constants.O_RDONLY | constants.O_DIRECTORY)
  } finally {
    await anchor.close()
  }
}

async function read(root: FileHandle, file: string, limit: number, optional = false): Promise<Buffer | undefined> {
  const opened = await openWithin(root, file, constants.O_RDONLY).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return
    throw error
  })
  if (!opened) return
  try {
    return await readOpened(opened, limit)
  } finally {
    await opened.close()
  }
}

async function readOpened(opened: FileHandle, limit: number) {
  const before = await opened.stat({ bigint: true })
  requireValue(before.isFile() && before.size <= BigInt(limit), "nonregular or oversized metadata")
  const result = Buffer.alloc(Number(before.size) + 1)
  let size = 0
  while (size < result.byteLength) {
    const part = await opened.read(result, size, result.byteLength - size, size)
    if (!part.bytesRead) break
    size += part.bytesRead
  }
  const after = await opened.stat({ bigint: true })
  requireValue(
    size === Number(before.size) &&
      before.size === after.size &&
      before.ino === after.ino &&
      before.dev === after.dev &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs,
    "metadata changed while being captured",
  )
  return result.subarray(0, size)
}

async function executable(excluded: string[]) {
  const names = process.platform === "win32" ? ["git.com", "git.exe"] : ["git"]
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    const root = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!path.isAbsolute(root)) continue
    for (const name of names) {
      const candidate = await fs.realpath(path.join(root, name)).catch(() => undefined)
      if (!candidate || excluded.some((directory) => inside(directory, candidate))) continue
      const info = await fs.stat(candidate)
      if (!info.isFile()) continue
      if (!(await trustedProgram(candidate).catch(() => false))) continue
      if (
        !(await fs.access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        ))
      )
        continue
      return candidate
    }
  }
  throw new Unavailable("no Git executable outside the repository")
}

function environment(temporary: string, executable: string) {
  return {
    PATH: path.dirname(executable),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  }
}

async function command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: Buffer) {
  return new Promise<{ code: number; bytes: Buffer }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let excessive = false
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 10_000)
    child.stdin.on("error", () => {})
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > LIMIT.index) {
        excessive = true
        child.kill("SIGKILL")
        return
      }
      chunks.push(chunk)
    })
    // Repository-controlled diagnostics can contain private config values; never copy them into an error or log.
    child.stderr.resume()
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Unavailable("Git could not start"))
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (excessive || signal || code === null) return reject(new Unavailable("Git exceeded its execution bound"))
      resolve({ code, bytes: Buffer.concat(chunks) })
    })
    child.stdin.end(input)
  })
}

async function configuration(file: string, data: Buffer | undefined, temporary: string, env: NodeJS.ProcessEnv) {
  if (!data) return new Map<string, string>()
  const result = await command(
    file,
    ["--no-pager", "config", "--file", "-", "--no-includes", "--null", "--get-regexp", CONFIG],
    temporary,
    env,
    data,
  )
  requireValue(result.code === 0 || result.code === 1, "Git configuration could not be parsed")
  const values = new Map<string, string>()
  for (const entry of result.bytes.toString("utf8").split("\0").filter(Boolean)) {
    const newline = entry.indexOf("\n")
    requireValue(newline > 0, "invalid configuration encoding")
    const key = entry.slice(0, newline).toLowerCase()
    const value = entry.slice(newline + 1).toLowerCase()
    requireValue(!key.startsWith("include"), "configuration includes are unsupported")
    if (key.startsWith("extensions.")) {
      requireValue(
        (key === "extensions.objectformat" && value === "sha1") ||
          (key === "extensions.refstorage" && value === "files") ||
          (key === "extensions.worktreeconfig" && BOOL.has(value)),
        "repository format is unsupported",
      )
      values.set(key, BOOL.get(value) ?? value)
      continue
    }
    if (key === "core.repositoryformatversion")
      requireValue(value === "0" || value === "1", "repository format version is unsupported")
    else if (key === "core.autocrlf")
      requireValue(BOOL.has(value) || value === "input", "autocrlf setting is unsupported")
    else if (key === "core.eol") requireValue(["lf", "crlf", "native"].includes(value), "EOL setting is unsupported")
    else requireValue(BOOL.has(value), "builtin Git setting is unsupported")
    values.set(key, key === "core.repositoryformatversion" ? value : (BOOL.get(value) ?? value))
  }
  return values
}

async function head(git: FileHandle, common: FileHandle, captured?: Buffer) {
  const value = metadataLine(captured ?? (await read(git, "HEAD", 4096))!)
  requireValue(value === value.trim(), "HEAD contains unsupported whitespace")
  if (/^[0-9a-f]{40}$/.test(value)) return value
  requireValue(value.startsWith("ref: refs/heads/"), "HEAD is neither a commit nor a branch")
  const ref = value.slice(5)
  requireValue(
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
      ref.length <= 1024 &&
      ref.split("/").length <= 64 &&
      !ref.includes("@{") &&
      !ref.includes("..") &&
      !ref.includes("//") &&
      !ref.endsWith("/") &&
      !ref.endsWith(".") &&
      ref.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
    "invalid branch reference",
  )
  const loose = await read(common, ref, 4096, true)
  if (loose) {
    const oid = metadataLine(loose)
    requireValue(/^[0-9a-f]{40}$/.test(oid), "symbolic or non-SHA1 branch reference is unsupported")
    return oid
  }
  const packed = (await read(common, "packed-refs", LIMIT.refs, true))?.toString("utf8") ?? ""
  const matches = packed.split("\n").filter((line) => line.slice(41) === ref)
  requireValue(matches.length === 1 && /^[0-9a-f]{40} /.test(matches[0]!), "the captured branch has no unique commit")
  return matches[0]!.slice(0, 40)
}

async function objects(common: FileHandle, target: string) {
  const source = await openWithin(common, "objects", constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    requireValue(
      !(await read(source, "info/alternates", LIMIT.config, true)),
      "alternate object stores are unsupported",
    )
    await fs.mkdir(target, { mode: 0o700 })
    let count = 0
    let seen = 0
    let bytes = 0n
    const listing = await fs.opendir(`/proc/self/fd/${source.fd}`)
    for await (const fan of listing) {
      requireValue(++seen <= LIMIT.files, "object directory listing exceeds its bound")
      if (!/^[0-9a-f]{2}$/.test(fan.name) && fan.name !== "pack") continue
      requireValue(fan.isDirectory() && !fan.isSymbolicLink(), "linked object directories are unsupported")
      const location = await openWithin(source, fan.name, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await fs.mkdir(path.join(target, fan.name), { mode: 0o700 })
        const entries = await fs.opendir(`/proc/self/fd/${location.fd}`)
        for await (const item of entries) {
          requireValue(++seen <= LIMIT.files, "object directory listing exceeds its bound")
          const allowed =
            fan.name === "pack"
              ? /^pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)$/.test(item.name)
              : /^[0-9a-f]{38}$/.test(item.name)
          if (!allowed) continue
          requireValue(item.isFile() && !item.isSymbolicLink(), "linked Git objects are unsupported")
          const opened = await openWithin(location, item.name, constants.O_RDONLY)
          try {
            const before = await opened.stat({ bigint: true })
            requireValue(
              before.isFile() && ++count <= LIMIT.files && (bytes += before.size) <= BigInt(LIMIT.objects),
              "object snapshot exceeds its bound",
            )
            await copyOpened(opened, path.join(target, fan.name, item.name), before.size)
          } finally {
            await opened.close()
          }
        }
      } finally {
        await location.close()
      }
    }
  } finally {
    await source.close()
  }
}

async function copyOpened(opened: FileHandle, target: string, bound: bigint) {
  const before = await opened.stat({ bigint: true })
  requireValue(before.isFile() && before.size <= bound, "source file is nonregular or oversized")
  const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (position < Number(before.size)) {
      const part = await opened.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position)
      requireValue(part.bytesRead > 0, "source file changed during capture")
      let written = 0
      while (written < part.bytesRead) {
        const result = await output.write(buffer, written, part.bytesRead - written, position + written)
        requireValue(result.bytesWritten > 0, "private snapshot could not be written")
        written += result.bytesWritten
      }
      position += part.bytesRead
    }
    const after = await opened.stat({ bigint: true })
    requireValue(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      "source file changed during capture",
    )
  } finally {
    await output.close()
  }
}

function metadataLine(data: Buffer) {
  const value = data.toString("utf8")
  const line = value.endsWith("\n") ? value.slice(0, -1) : value
  requireValue(Buffer.from(value).equals(data) && line.length > 0 && !/[\x00\r\n]/.test(line), "invalid metadata line")
  return line
}

function metadataValue(value: string) {
  const escapes = new Map([
    ["n", "\n"],
    ["t", "\t"],
    ["b", "\b"],
    ["\\", "\\"],
    ['"', '"'],
  ])
  const result: string[] = []
  let quoted = false
  let end = 0
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (!quoted && (character === "#" || character === ";")) break
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === "\\") {
      const escaped = escapes.get(value[++index] ?? "")
      requireValue(escaped !== undefined, "unsupported configuration escape or continuation")
      result.push(escaped)
      end = result.length
      continue
    }
    if (!quoted && !result.length && /\s/.test(character)) continue
    result.push(character)
    if (quoted || !/\s/.test(character)) end = result.length
  }
  requireValue(!quoted, "unterminated configuration value")
  return result.slice(0, end).join("")
}

// The polling path parses only a deliberately small data grammar. It never asks Git to discover a repository or
// interpret config. Unsupported includes, continuations and extensions refuse; full open still parses/validates the
// real Git configuration and actual commit objects before a model may start.
function metadataConfiguration(data: Buffer) {
  const text = data.toString("utf8")
  requireValue(
    Buffer.from(text).equals(data) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text),
    "invalid configuration encoding",
  )
  const result = new Map<string, string>()
  let section = ""
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.replace(/\r$/, "").trimStart()
    if (!line || /^[#;]/.test(line)) continue
    requireValue(!line.endsWith("\\"), "configuration continuations are unsupported")
    if (line.startsWith("[")) {
      const header = /^\[\s*([a-zA-Z][a-zA-Z0-9.-]*)(?:\s+"((?:[^"\\]|\\["\\])*)")?\s*\]\s*(?:[#;].*)?$/.exec(line)
      requireValue(header, "unsupported configuration section")
      section = header[1]!.toLowerCase()
      requireValue(
        section !== "include" && section !== "includeif" && !section.startsWith("include."),
        "configuration includes are unsupported",
      )
      requireValue(
        !section.startsWith("extensions.") && !(section === "extensions" && header[2] !== undefined),
        "repository extension is unsupported",
      )
      continue
    }
    const entry = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(.*)|\s*(?:[#;].*)?)$/.exec(line)
    requireValue(entry && section, "unsupported configuration entry")
    const key = section + "." + entry[1]!.toLowerCase()
    const value = metadataValue(entry[2] ?? "")
    const normalized = value.toLowerCase()
    if (section === "extensions") {
      requireValue(
        (key === "extensions.objectformat" && normalized === "sha1") ||
          (key === "extensions.refstorage" && normalized === "files") ||
          (key === "extensions.worktreeconfig" && BOOL.has(normalized)),
        "repository format is unsupported",
      )
      result.set(key, BOOL.get(normalized) ?? normalized)
    }
    if (key === "core.repositoryformatversion") {
      requireValue(normalized === "0" || normalized === "1", "repository format version is unsupported")
      result.set(key, normalized)
    }
    if (key === "core.bare") {
      requireValue(BOOL.has(normalized), "bare setting is unsupported")
      result.set(key, BOOL.get(normalized)!)
    }
    if (key === "core.worktree") result.set(key, value)
  }
  return result
}

async function sameDirectory(location: string, expected: FileHandle) {
  const live = await pin(location)
  try {
    const before = await expected.stat({ bigint: true })
    const after = await live.stat({ bigint: true })
    requireValue(before.dev === after.dev && before.ino === after.ino, "the metadata directory changed identity")
  } finally {
    await live.close()
  }
}

export interface Metadata extends Input {
  /** Stable identity read from the same pinned FD that validated the registration. */
  readonly commonIdentity?: DirectoryIdentity
  /** A bounded observation of HEAD/ref metadata, not proof that this commit object exists. */
  readonly head: string
  readonly branch?: string
  readonly objectValidated: false
}

export interface DirectoryIdentity {
  readonly dev: string
  readonly ino: string
  readonly birth: string
}

async function directoryIdentity(handle: FileHandle, signal?: AbortSignal): Promise<DirectoryIdentity | undefined> {
  return DirectoryIdentityReader.read(handle, signal)
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.birth === right.birth
}

/**
 * Lightweight discovery for a known, canonical worktree root. It neither searches parents nor reads the index or
 * object store and starts no Git process. Full open is mandatory before collection/model execution.
 */
export async function metadataHead(knownRoot: string, options?: { signal?: AbortSignal }): Promise<Metadata> {
  requireValue(!options?.signal?.aborted, "Git metadata observation was cancelled")
  requireValue(process.platform === "linux", "this host has no pinned-directory adapter")
  const handles: FileHandle[] = []
  try {
    const root = await directory(knownRoot)
    requireValue(
      root === path.resolve(knownRoot) && !/[\x00\r\n]/.test(root),
      "linked worktree ancestry is unsupported",
    )
    const rootHandle = await pin(root)
    handles.push(rootHandle)
    const marker = await openWithin(rootHandle, ".git", constants.O_RDONLY)
    handles.push(marker)
    const markerIdentity = await marker.stat({ bigint: true })
    requireValue(markerIdentity.isFile() || markerIdentity.isDirectory(), "the worktree Git marker is nonregular")
    const markerBytes = markerIdentity.isFile() ? await readOpened(marker, 4096) : undefined
    const binding = async () => {
      if (!markerBytes) {
        requireValue(!(await read(marker, "commondir", 4096, true)), "redirected primary Git metadata is unsupported")
        return {
          gitDirectory: path.join(root, ".git"),
          commonDirectory: path.join(root, ".git"),
          git: marker,
          common: marker,
          commonBytes: undefined,
          backpointer: undefined,
        }
      }
      const pointer = /^gitdir: (.+)$/.exec(metadataLine(markerBytes))
      requireValue(pointer, "the worktree Git marker is malformed")
      const gitDirectory = path.resolve(root, pointer[1]!)
      requireValue(
        path.basename(path.dirname(gitDirectory)) === "worktrees",
        "unregistered Git directory indirection is unsupported",
      )
      requireValue((await directory(gitDirectory)) === gitDirectory, "linked Git directory ancestry is unsupported")
      const git = await pin(gitDirectory)
      handles.push(git)
      const commonBytes = (await read(git, "commondir", 4096))!
      const commonDirectory = path.resolve(gitDirectory, metadataLine(commonBytes))
      requireValue(
        path.dirname(gitDirectory) === path.join(commonDirectory, "worktrees"),
        "the common directory is outside its worktree registration",
      )
      const backpointer = (await read(git, "gitdir", 4096))!
      requireValue(
        metadataLine(backpointer) === path.join(root, ".git"),
        "the linked worktree backpointer does not match",
      )
      requireValue(
        (await directory(commonDirectory)) === commonDirectory,
        "linked common directory ancestry is unsupported",
      )
      const common = await pin(commonDirectory)
      handles.push(common)
      return { gitDirectory, commonDirectory, git, common, commonBytes, backpointer }
    }
    const current = await binding()
    const configBytes = (await read(current.common, "config", LIMIT.config))!
    const config = metadataConfiguration(configBytes)
    const localBytes =
      config.get("extensions.worktreeconfig") === "true"
        ? await read(current.git, "config.worktree", LIMIT.config, true)
        : undefined
    const local = localBytes ? metadataConfiguration(localBytes) : new Map<string, string>()
    const settings = new Map([...config, ...local])
    requireValue(settings.get("core.bare") !== "true", "bare repositories have no review worktree")
    const worktree = settings.get("core.worktree")
    requireValue(
      worktree === undefined || path.resolve(current.gitDirectory, worktree) === root,
      "the configuration redirects the worktree",
    )
    const captured = (await read(current.git, "HEAD", 4096))!
    const line = metadataLine(captured)
    requireValue(line === line.trim(), "HEAD contains unsupported whitespace")
    const observed = await head(current.git, current.common, captured)
    const commonIdentity = await directoryIdentity(current.common, options?.signal)
    requireValue(!options?.signal?.aborted, "Git metadata observation was cancelled")
    // The long optional identity read precedes every final registration/config/HEAD/path revalidation below.
    const live = await openWithin(rootHandle, ".git", constants.O_RDONLY)
    try {
      const identity = await live.stat({ bigint: true })
      requireValue(
        identity.dev === markerIdentity.dev && identity.ino === markerIdentity.ino,
        "the worktree Git marker changed identity",
      )
      if (markerBytes)
        requireValue((await readOpened(live, 4096)).equals(markerBytes), "the worktree Git marker changed")
    } finally {
      await live.close()
    }
    if (current.commonBytes)
      requireValue(
        (await read(current.git, "commondir", 4096))!.equals(current.commonBytes),
        "the common directory binding changed",
      )
    if (current.backpointer)
      requireValue(
        (await read(current.git, "gitdir", 4096))!.equals(current.backpointer),
        "the linked worktree backpointer changed",
      )
    requireValue(
      (await read(current.common, "config", LIMIT.config))!.equals(configBytes) &&
        (await read(current.git, "HEAD", 4096))!.equals(captured) &&
        (await head(current.git, current.common, captured)) === observed,
      "Git metadata changed during observation",
    )
    if (config.get("extensions.worktreeconfig") === "true") {
      const after = await read(current.git, "config.worktree", LIMIT.config, true)
      requireValue(
        localBytes ? !!after?.equals(localBytes) : after === undefined,
        "worktree configuration changed during observation",
      )
    }
    await sameDirectory(root, rootHandle)
    await sameDirectory(current.gitDirectory, current.git)
    if (current.commonDirectory !== current.gitDirectory) await sameDirectory(current.commonDirectory, current.common)
    requireValue(!options?.signal?.aborted, "Git metadata observation was cancelled")
    return {
      directory: root,
      gitDirectory: current.gitDirectory,
      commonDirectory: current.commonDirectory,
      commonIdentity,
      head: observed,
      branch: line.startsWith("ref: refs/heads/") ? line.slice(16) : undefined,
      objectValidated: false,
    }
  } catch (error) {
    throw unavailable(error)
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

/**
 * Inspect a caller-verified worktree through private metadata. Neither status nor index normalization reads the live
 * repository's executable configuration. Unsupported metadata fails before the caller may start a model.
 * Global/system policy is intentionally excluded; builtin normalization must be explicit in repository/worktree config.
 */
export interface Input {
  readonly directory: string
  readonly gitDirectory: string
  readonly commonDirectory: string
  /** A genuine metadata capture can bind the later private snapshot to that exact store. */
  readonly commonIdentity?: DirectoryIdentity
}

export interface Repository {
  readonly directory: string
  readonly gitDirectory: string
  readonly commonDirectory: string
  readonly commonIdentity?: DirectoryIdentity
  readonly head: string
  readonly branch?: string
  readonly shallow: boolean
  readonly status: () => Promise<{ head: string; dirty: boolean }>
  readonly read: (operation: Read) => Promise<{ code: number; bytes: Buffer }>
  readonly close: () => Promise<void>
}

export type Read =
  | { readonly kind: "status"; readonly untracked?: "normal" | "no" | "all" }
  | { readonly kind: "resolve"; readonly revision: string }
  | { readonly kind: "merge-base"; readonly left: string; readonly right: string }
  | {
      readonly kind: "diff"
      readonly from: string
      readonly to?: string
      readonly cached?: boolean
      readonly names?: boolean
      readonly files?: readonly string[]
      readonly context?: number
    }
  | { readonly kind: "untracked"; readonly ignoredSettings?: boolean }
  | { readonly kind: "added-diff"; readonly file: string }
  | {
      readonly kind: "object"
      readonly revision: string
      readonly file?: string
      readonly action: "blob" | "size" | "exists" | "commit-exists"
    }
  | { readonly kind: "batch-files"; readonly revision: string; readonly files: readonly string[] }
  | { readonly kind: "grep"; readonly revision: string; readonly symbol: string; readonly excludes?: readonly string[] }
  | { readonly kind: "roots"; readonly revision: string }
  | { readonly kind: "history"; readonly revision: string; readonly file: string }
  | {
      readonly kind: "blame"
      readonly revision: string
      readonly file: string
      readonly first: number
      readonly last: number
    }
  | { readonly kind: "tree"; readonly revision: string; readonly file: string }
  | { readonly kind: "subjects"; readonly from: string; readonly to: string }

function relative(file: string) {
  requireValue(
    file.length > 0 &&
      file.length <= 4096 &&
      !/[\x00\r\n]/.test(file) &&
      !path.isAbsolute(file) &&
      !file.includes("\\") &&
      file.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "repository-relative path is unsupported",
  )
  return file
}

/** A scoped private Git view for the entire review collection; callers still enforce their own file/read policy. */
export async function open(input: Input, options?: { signal?: AbortSignal }): Promise<Repository> {
  requireValue(!options?.signal?.aborted, "Git snapshot was cancelled")
  requireValue(process.platform === "linux", "this host has no pinned-directory adapter")
  const root = await directory(input.directory)
  const git = await directory(input.gitDirectory)
  const common = await directory(input.commonDirectory)
  requireValue(
    root === path.resolve(input.directory) &&
      git === path.resolve(input.gitDirectory) &&
      common === path.resolve(input.commonDirectory),
    "linked metadata ancestry is unsupported",
  )
  requireValue(
    git === common || inside(path.join(common, "worktrees"), git),
    "Git metadata is outside the verified repository",
  )
  const handles: FileHandle[] = []
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "vector-readonly-git-"))
  const temporary = await fs.realpath(created).catch(async () => {
    await fs.rm(created, { recursive: true, force: true })
    throw new Unavailable("temporary metadata could not be pinned")
  })
  let transferred = false
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await Promise.all(handles.map((handle) => handle.close()))
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
  try {
    requireValue(
      !inside(root, temporary) && !inside(common, temporary) && !inside(path.dirname(common), temporary),
      "temporary metadata would be repository-controlled",
    )
    await fs.chmod(temporary, 0o700)
    const rootHandle = await pin(root)
    handles.push(rootHandle)
    const gitHandle = await pin(git)
    handles.push(gitHandle)
    const commonHandle = await pin(common)
    handles.push(commonHandle)
    const commonIdentity = await directoryIdentity(commonHandle, options?.signal)
    requireValue(!options?.signal?.aborted, "Git snapshot was cancelled")
    requireValue(
      !input.commonIdentity || (commonIdentity !== undefined && sameIdentity(input.commonIdentity, commonIdentity)),
      "the admitted common store changed identity",
    )
    const program = await executable([root, common, path.dirname(common)])
    const env = environment(temporary, program)
    const base = await configuration(program, await read(commonHandle, "config", LIMIT.config), temporary, env)
    const local =
      base.get("extensions.worktreeconfig") === "true"
        ? await configuration(program, await read(gitHandle, "config.worktree", LIMIT.config, true), temporary, env)
        : new Map<string, string>()
    const builtin = new Map([...base, ...local])
    requireValue(builtin.get("core.sparsecheckout") !== "true", "sparse worktrees are unsupported")
    const capturedHead = await head(gitHandle, commonHandle)
    const capturedRef = (await read(gitHandle, "HEAD", 4096))!.toString("utf8").trim()
    const branch = capturedRef.startsWith("ref: refs/heads/") ? capturedRef.slice(16) : undefined
    const index = (await read(gitHandle, "index", LIMIT.index))!
    requireValue(index.byteLength >= 12 && index.subarray(0, 4).toString() === "DIRC", "Git index is unsupported")
    const digest = createHash("sha256").update(index).digest("hex")
    const privateGit = path.join(temporary, "git")
    await fs.mkdir(path.join(privateGit, "refs"), { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(privateGit, "info"), { mode: 0o700 })
    await fs.writeFile(path.join(privateGit, "HEAD"), capturedHead + "\n", { mode: 0o600, flag: "wx" })
    await fs.writeFile(path.join(privateGit, "index"), index, { mode: 0o600, flag: "wx" })
    const safe = [
      "[core]",
      "repositoryFormatVersion = 0",
      "bare = false",
      "logAllRefUpdates = false",
      "fsmonitor = false",
      "useBuiltinFSMonitor = false",
      "untrackedCache = false",
      "sparseCheckout = false",
      "sparseCheckoutCone = false",
      `hooksPath = ${JSON.stringify(os.devNull)}`,
      `attributesFile = ${JSON.stringify(os.devNull)}`,
      `excludesFile = ${JSON.stringify(os.devNull)}`,
      ...["autocrlf", "eol", "filemode", "symlinks", "ignorecase", "precomposeunicode"].flatMap((key) => {
        const value = builtin.get("core." + key)
        return value === undefined ? [] : [`${key} = ${value}`]
      }),
      "[gc]",
      "auto = 0",
      "[maintenance]",
      "auto = false",
      "[protocol]",
      "allow = never",
      "",
    ]
    await fs.writeFile(path.join(privateGit, "config"), safe.join("\n"), { mode: 0o600, flag: "wx" })
    for (const name of ["attributes", "exclude"]) {
      const data = await read(commonHandle, "info/" + name, LIMIT.config, true)
      if (data) await fs.writeFile(path.join(privateGit, "info", name), data, { mode: 0o600, flag: "wx" })
    }
    const shallow = await read(commonHandle, "shallow", LIMIT.refs, true)
    if (shallow) await fs.writeFile(path.join(privateGit, "shallow"), shallow, { mode: 0o600, flag: "wx" })
    await objects(commonHandle, path.join(privateGit, "objects"))
    const args = ["--no-pager", "--no-optional-locks", `--git-dir=${privateGit}`, `--work-tree=${root}`]
    const commitType = await command(program, [...args, "cat-file", "-t", capturedHead], temporary, env)
    requireValue(
      commitType.code === 0 && commitType.bytes.equals(Buffer.from("commit\n")),
      "the captured HEAD is not an available commit object",
    )
    const entries = await command(program, [...args, "ls-files", "--stage", "--sparse", "-z"], temporary, env)
    requireValue(entries.code === 0, "split, sparse or invalid index is unsupported")
    let count = 0
    let start = 0
    for (let end = 0; end < entries.bytes.length; end++) {
      if (entries.bytes[end] !== 0) continue
      const entry = entries.bytes.subarray(start, end)
      const tab = entry.indexOf(9)
      requireValue(
        tab > 0 &&
          tab < entry.length - 1 &&
          /^(100644|100755|120000) [0-9a-f]{40} 0$/.test(entry.subarray(0, tab).toString("ascii")),
        "submodules, sparse or unmerged entries are unsupported",
      )
      requireValue(++count <= LIMIT.files, "tracked file count exceeds its bound")
      start = end + 1
    }
    requireValue(start === entries.bytes.length, "invalid index entry encoding")
    // Rebuild only the private index. Discard every source stat, fsmonitor, sparse and assume-unchanged cache,
    // including otherwise-valid same-size timestamps; the original index is never refreshed or written.
    const empty = await command(program, [...args, "read-tree", "--empty"], temporary, env)
    requireValue(empty.code === 0, "private index could not be initialized")
    const rebuilt = await command(
      program,
      [...args, "update-index", "-z", "--index-info"],
      temporary,
      env,
      entries.bytes,
    )
    requireValue(rebuilt.code === 0, "private index entries could not be restored")
    const unchanged = async () => {
      requireValue(!closed, "the private Git view is closed")
      const after = (await read(gitHandle, "index", LIMIT.index))!
      requireValue(
        createHash("sha256").update(after).digest("hex") === digest &&
          (await head(gitHandle, commonHandle)) === capturedHead &&
          (await read(gitHandle, "HEAD", 4096))!.toString("utf8").trim() === capturedRef,
        "original Git metadata changed during inspection",
      )
    }
    const revision = (value: string) => {
      requireValue(
        value === "HEAD" || /^[0-9a-f]{40}$/.test(value),
        "only a captured HEAD or exact SHA1 revision is supported",
      )
      return value === "HEAD" ? capturedHead : value
    }
    const perform = async (operation: Read) => {
      requireValue(!closed, "the private Git view is closed")
      const literal = (file: string) => ":(literal)" + relative(file)
      const diff = [
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ]
      const run = (query: string[], input?: Buffer) => command(program, [...args, ...query], temporary, env, input)
      switch (operation.kind) {
        case "status":
          requireValue(
            operation.untracked === undefined || ["normal", "no", "all"].includes(operation.untracked),
            "untracked status mode is unsupported",
          )
          return run([
            "status",
            "--porcelain=v1",
            "--no-renames",
            `--untracked-files=${operation.untracked ?? "all"}`,
            "--ignore-submodules=all",
          ])
        case "resolve":
          return run([
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            revision(operation.revision) + "^{commit}",
          ])
        case "merge-base":
          return run(["merge-base", revision(operation.left), revision(operation.right)])
        case "diff":
          requireValue(!(operation.to && operation.cached), "a diff cannot select both a commit and the index")
          requireValue(
            (operation.files?.length ?? 0) <= LIMIT.files &&
              Number.isSafeInteger(operation.context ?? 3) &&
              (operation.context ?? 3) >= 0 &&
              (operation.context ?? 3) <= 200,
            "diff scope is unsupported",
          )
          return run([
            "diff",
            ...diff,
            ...(operation.names
              ? ["--name-only", "--no-renames", "-z"]
              : ["--find-renames", `--unified=${operation.context ?? 3}`]),
            ...(operation.cached ? ["--cached"] : []),
            revision(operation.from),
            ...(operation.to ? [revision(operation.to)] : []),
            "--",
            ...(operation.files ?? []).map(literal),
          ])
        case "untracked":
          return run(
            operation.ignoredSettings
              ? ["ls-files", "--others", "-z", "--", ":(icase).vector", ":(icase).gitattributes"]
              : ["ls-files", "--others", "--exclude-standard", "-z"],
          )
        case "added-diff": {
          const file = relative(operation.file)
          const snapshot = await fs.mkdtemp(path.join(temporary, "added-"))
          try {
            const opened = await openWithin(rootHandle, file, constants.O_RDONLY)
            try {
              await fs.mkdir(path.dirname(path.join(snapshot, file)), { recursive: true, mode: 0o700 })
              await copyOpened(opened, path.join(snapshot, file), BigInt(LIMIT.index))
              return await command(
                program,
                [...args, "diff", "--no-index", ...diff, "--unified=3", "--", os.devNull, file],
                snapshot,
                env,
              )
            } finally {
              await opened.close()
            }
          } finally {
            await fs.rm(snapshot, { recursive: true, force: true })
          }
        }
        case "object": {
          requireValue(
            ["blob", "size", "exists", "commit-exists"].includes(operation.action),
            "object action is unsupported",
          )
          requireValue(
            !(operation.file && operation.action === "commit-exists"),
            "commit existence cannot select a file",
          )
          requireValue(operation.revision !== "index" || !!operation.file, "an index lookup requires a file")
          const object =
            (operation.revision === "index" ? "" : revision(operation.revision)) +
            (operation.file ? ":" + relative(operation.file) : "") +
            (operation.action === "commit-exists" ? "^{commit}" : "")
          return run([
            "cat-file",
            operation.action === "blob" ? "blob" : operation.action === "size" ? "-s" : "-e",
            object,
          ])
        }
        case "batch-files": {
          requireValue(operation.files.length <= LIMIT.files, "object request count exceeds its bound")
          const data = Buffer.from(
            operation.files.map((file) => revision(operation.revision) + ":" + relative(file) + "\n").join(""),
          )
          requireValue(data.byteLength <= LIMIT.index, "object request input exceeds its bound")
          return run(["cat-file", "--batch", "--follow-symlinks"], data)
        }
        case "grep":
          requireValue(
            operation.symbol.length > 0 && operation.symbol.length <= 1024 && !/[\x00\r\n]/.test(operation.symbol),
            "grep symbol is unsupported",
          )
          requireValue((operation.excludes?.length ?? 0) <= 256, "grep exclude count exceeds its bound")
          return run([
            "grep",
            "-n",
            "-w",
            "-F",
            "-I",
            "--no-color",
            "--full-name",
            "-z",
            "-e",
            operation.symbol,
            revision(operation.revision),
            "--",
            ".",
            ...(operation.excludes ?? []).map((glob) => ":(exclude,glob)" + relative(glob)),
          ])
        case "roots":
          return run(["rev-list", "--max-parents=0", revision(operation.revision)])
        case "history":
          return run([
            "log",
            "--no-ext-diff",
            "--no-textconv",
            "--no-show-signature",
            "-n",
            "5",
            "--no-color",
            "--date=short",
            "--format=%h %an %ad %s",
            revision(operation.revision),
            "--",
            literal(operation.file),
          ])
        case "blame":
          requireValue(
            Number.isSafeInteger(operation.first) &&
              Number.isSafeInteger(operation.last) &&
              operation.first > 0 &&
              operation.last >= operation.first &&
              operation.last <= 2_147_483_647,
            "blame range is unsupported",
          )
          return run([
            "blame",
            "--porcelain",
            "--root",
            "--no-textconv",
            "-L",
            `${operation.first},${operation.last}`,
            revision(operation.revision),
            "--",
            relative(operation.file),
          ])
        case "tree":
          return run(["ls-tree", "-z", revision(operation.revision), "--", literal(operation.file)])
        case "subjects":
          return run([
            "log",
            "--no-ext-diff",
            "--no-textconv",
            "--no-show-signature",
            "--no-color",
            "-n",
            "50",
            "--format=%s",
            revision(operation.from) + ".." + revision(operation.to),
          ])
        default:
          throw new Unavailable("Git operation is not supported by the read-only port")
      }
    }
    const safeRead = (operation: Read) =>
      perform(operation).catch((error) => {
        throw unavailable(error)
      })
    const status = async () => {
      await unchanged()
      const result = await command(
        program,
        [...args, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"],
        temporary,
        env,
      )
      requireValue(result.code === 0, "private worktree status could not be read")
      await unchanged()
      return { head: capturedHead, dirty: result.bytes.byteLength !== 0 }
    }
    await status()
    transferred = true
    return {
      directory: root,
      gitDirectory: git,
      commonDirectory: common,
      commonIdentity,
      head: capturedHead,
      branch,
      shallow: !!shallow?.byteLength,
      status,
      read: safeRead,
      close,
    }
  } catch (error) {
    throw unavailable(error)
  } finally {
    if (!transferred) await close()
  }
}

export async function inspect(input: Input) {
  const repository = await open(input)
  try {
    return await repository.status()
  } finally {
    await repository.close()
  }
}
