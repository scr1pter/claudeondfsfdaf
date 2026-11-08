export * as WorkspaceTrust from "./workspace-trust"

import { constants, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import whichPkg from "which"
import { Flock } from "../util/flock"
import { WebFetchRequest } from "../util/webfetch-request"

const version = 1 as const
const filename = "workspace-trust.json"
const cacheDirectory = "workspace-trust"
const emptyBunConfig = "empty-bunfig.toml"
const ignoredDirectories = new Set([".git", "node_modules"])
const ignoredFiles = new Set([".DS_Store", ".gitignore"])
// What Vector itself writes into a .vector directory during normal work: plans, project memory, team rules, failure
// memory and team handoffs. None of it is ever executed, and fingerprinting it would revoke an approval the moment
// the next session wrote a plan.
const managedData = new Set(["plans", "BRAIN.md", "RULES.md", "failure-memory.json", "team.json", "team-outbox"])
const configNames = new Set([
  "vector.json",
  "vector.jsonc",
  "vector.local.json",
  "vector.local.jsonc",
  "tui.json",
  "tui.jsonc",
])
const maxFiles = 10_000
const maxDirectories = 10_000
const maxBytes = 64 * 1024 * 1024
const maxFileBytes = 8 * 1024 * 1024
const maxDepth = 64
const maxDirectoryEntries = 10_000
const captured = Symbol("WorkspaceTrust.captured")
const capturedDirectories = Symbol("WorkspaceTrust.capturedDirectories")
const executionDirectories = Symbol("WorkspaceTrust.executionDirectories")
const requestedWorkspace = Symbol("WorkspaceTrust.requestedWorkspace")
const unavailable = Symbol("WorkspaceTrust.unavailable")

type StoredTrust = {
  path: string
  fingerprint: string
}

type Store = {
  version: typeof version
  workspaces: Record<string, StoredTrust>
}

type CapturedFile = {
  content: Buffer
  mode: number
}

export type Snapshot = {
  workspace: string
  fingerprint: string
  readonly [captured]: ReadonlyMap<string, CapturedFile>
  readonly [capturedDirectories]: ReadonlySet<string>
  readonly [executionDirectories]: ReadonlySet<string>
  readonly [requestedWorkspace]: string
  readonly [unavailable]?: string
}

export type TrustedSnapshot = Snapshot & {
  directory: string
}

export type Status = {
  workspace: string
  fingerprint: string
  trusted: boolean
}

export async function snapshot(workspace: string, inputs: readonly string[]): Promise<Snapshot> {
  const requested = path.resolve(workspace)
  const canonical = await canonicalize(workspace)
  const files = new Map<string, CapturedFile>()
  const directories = new Set<string>()
  const cwdDirectories = new Set<string>()
  const budget = { files: 0, bytes: 0 }
  const names = Array.from(configNames)
  const normalize = (input: string) => normalizeInput(input, requested, canonical)
  const normalizedInputs = inputs.map(normalize)
  const expanded = [
    ...normalizedInputs,
    ...names.map((name) => path.join(canonical, name)),
    path.join(canonical, ".vector"),
    path.join(canonical, ".agents", "skills"),
    path.join(canonical, ".claude", "skills"),
    ...normalizedInputs.flatMap((input) =>
      configNames.has(path.basename(input))
        ? [
            ...names.map((name) => path.join(path.dirname(input), name)),
            path.join(path.dirname(input), ".vector"),
            path.join(path.dirname(input), ".agents", "skills"),
            path.join(path.dirname(input), ".claude", "skills"),
          ]
        : [],
    ),
  ]

  for (const input of new Set(expanded.map((item) => path.resolve(item)))) {
    await collect(input, files, directories, budget, canonical)
  }
  const configs = Array.from(files).filter(([file]) => configNames.has(path.basename(file)))
  for (const [file, value] of configs) {
    const config = readConfig(value.content)
    for (const input of [
      ...executableInputs(config, { source: file, workspace: canonical }),
      ...fileInputs(config, file),
    ]) {
      await collect(normalize(input), files, directories, budget, canonical)
    }
    for (const directory of executableDirectories(config, canonical)) {
      await collectExecutionDirectory(normalize(directory), cwdDirectories)
    }
  }

  const hash = createHash("sha256").update(`workspace\0${canonical}\0`)
  for (const [file, value] of Array.from(files).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`path\0${file}\0mode\0${value.mode & 0o777}\0`)
    hash.update(value.content)
    hash.update("\0")
  }
  for (const directory of Array.from(cwdDirectories).sort()) hash.update(`cwd\0${directory}\0`)
  return {
    workspace: canonical,
    fingerprint: hash.digest("hex"),
    [captured]: files,
    [capturedDirectories]: directories,
    [executionDirectories]: cwdDirectories,
    [requestedWorkspace]: requested,
  }
}

export async function unavailableSnapshot(workspace: string, cause: unknown): Promise<Snapshot> {
  const requested = path.resolve(workspace)
  const canonical = await canonicalize(workspace)
  const reason = cause instanceof Error ? cause.message : String(cause)
  return {
    workspace: canonical,
    fingerprint: createHash("sha256").update(`unavailable\0${canonical}\0${reason}`).digest("hex"),
    [captured]: new Map(),
    [capturedDirectories]: new Set(),
    [executionDirectories]: new Set(),
    [requestedWorkspace]: requested,
    [unavailable]: reason,
  }
}

export function unavailableReason(current: Snapshot) {
  return current[unavailable]
}

/** Whether the workspace has any project config or .vector content that trust would decide about. */
export function hasInputs(current: Snapshot) {
  return current[captured].size > 0
}

/** Compares approved inputs across a workspace copy without rebasing external dependencies. */
export function contentKey(current: Snapshot) {
  if (current[unavailable] !== undefined)
    throw new Error(`Workspace trust snapshot unavailable: ${current[unavailable]}`)
  const identity = (file: string) =>
    contains(current.workspace, file) ? `workspace:${path.relative(current.workspace, file)}` : `external:${file}`
  const hash = createHash("sha256").update("workspace-content\0")
  for (const [file, value] of Array.from(current[captured], ([file, value]) => [identity(file), value] as const).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    hash.update(`file\0${JSON.stringify([file, value.mode & 0o777, value.content.length])}\0`)
    hash.update(value.content)
  }
  for (const directory of Array.from(current[executionDirectories], identity).sort()) {
    hash.update(`cwd\0${JSON.stringify(directory)}\0`)
  }
  return hash.digest("hex")
}

export async function status(stateDirectory: string, current: Snapshot): Promise<Status> {
  if (current[unavailable] !== undefined) {
    return { workspace: current.workspace, fingerprint: current.fingerprint, trusted: false }
  }
  const store = await readStore(stateDirectory)
  const trusted = store.workspaces[key(current.workspace)]
  return {
    workspace: current.workspace,
    fingerprint: current.fingerprint,
    trusted: trusted?.path === current.workspace && trusted.fingerprint === current.fingerprint,
  }
}

export async function approve(stateDirectory: string, current: Snapshot) {
  if (current[unavailable] !== undefined)
    throw new Error(`Workspace trust snapshot unavailable: ${current[unavailable]}`)
  const target = path.join(stateDirectory, filename)
  await Flock.withLock(
    target,
    async () => {
      const store = await readStore(stateDirectory)
      store.workspaces[key(current.workspace)] = {
        path: current.workspace,
        fingerprint: current.fingerprint,
      }
      await writeStore(stateDirectory, store)
    },
    { dir: path.join(stateDirectory, "locks") },
  )
}

export async function inherit(stateDirectory: string, parent: Snapshot, child: Snapshot): Promise<boolean> {
  if (parent[unavailable] !== undefined || child[unavailable] !== undefined || contentKey(parent) !== contentKey(child))
    return false
  return Flock.withLock(
    path.join(stateDirectory, filename),
    async () => {
      const store = await readStore(stateDirectory)
      const approved = store.workspaces[key(parent.workspace)]
      // Approval and revocation use this same lock: a stale in-memory trusted flag grants nothing here.
      if (approved?.path !== parent.workspace || approved.fingerprint !== parent.fingerprint) return false
      store.workspaces[key(child.workspace)] = { path: child.workspace, fingerprint: child.fingerprint }
      await writeStore(stateDirectory, store)
      return true
    },
    { dir: path.join(stateDirectory, "locks") },
  )
}

export async function forget(stateDirectory: string, workspace: string) {
  const canonical = await canonicalize(workspace)
  await Flock.withLock(
    path.join(stateDirectory, filename),
    async () => {
      const store = await readStore(stateDirectory)
      if (!Object.hasOwn(store.workspaces, key(canonical))) return
      delete store.workspaces[key(canonical)]
      // Stored fingerprints are unvalidated data, never paths to remove from the materialized cache.
      await writeStore(stateDirectory, store)
    },
    { dir: path.join(stateDirectory, "locks") },
  )
}

export function readFileString(current: Snapshot, file: string) {
  return current[captured].get(snapshotPath(current, file))?.content.toString("utf8")
}

export async function materialize(stateDirectory: string, current: Snapshot): Promise<TrustedSnapshot> {
  if (current[unavailable] !== undefined)
    throw new Error(`Workspace trust snapshot unavailable: ${current[unavailable]}`)
  const parent = path.join(stateDirectory, cacheDirectory)
  const target = path.join(parent, current.fingerprint)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const existing = await fs.lstat(target).catch(() => undefined)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Trusted workspace cache ${target} is not a private directory`)
    }
    await verifyMaterialized(target, current)
    return { ...current, directory: target }
  }

  const temporary = await fs.mkdtemp(path.join(parent, `.${current.fingerprint}.`))
  try {
    await ensureEmptyBunConfig(temporary)
    for (const directory of new Set([...current[capturedDirectories], ...current[executionDirectories]])) {
      await fs.mkdir(path.join(temporary, materializedRelativePath(directory)), { recursive: true, mode: 0o700 })
    }
    for (const [file, value] of current[captured]) {
      const destination = path.join(temporary, materializedRelativePath(file))
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await fs.writeFile(destination, value.content, { flag: "wx", mode: value.mode & 0o111 ? 0o500 : 0o400 })
    }
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true })
    // Another process may have atomically published the same fingerprint first.
    // Accept its copy only after validating every approved file; unrelated runtime
    // artifacts beside those files do not change which captured paths are used.
    const winner = await fs.lstat(target).catch(() => undefined)
    if (!winner?.isDirectory() || winner.isSymbolicLink()) throw error
    await verifyMaterialized(target, current)
  }
  return { ...current, directory: target }
}

export function materializedPath(current: TrustedSnapshot, input: string) {
  const target = materializedPathOption(current, input)
  if (!target) throw new Error(`Workspace trust input changed or was not captured: ${input}`)
  return target
}

export function materializedPathOption(current: TrustedSnapshot, input: string): string | undefined {
  const resolved = path.resolve(input)
  if (contains(current.directory, resolved)) return resolved
  const source = snapshotPath(current, resolved)
  if (!hasCapturedPath(current, source) && !current[executionDirectories].has(source)) return undefined
  return path.join(current.directory, materializedRelativePath(source))
}

export function remoteUrlAllowed(value: string) {
  if (isWindowsPath(value)) return false
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

/**
 * An endpoint the user configured themselves: https anywhere, or plain http to their own machine or network
 * (loopback, private, link-local and CGNAT addresses, or a local-only name such as `gpu-box` or `nas.local`). Plain
 * http to any other host would send credentials in clear text, so it is refused.
 */
export function userRemoteUrlAllowed(value: string) {
  if (remoteUrlAllowed(value)) return true
  if (isWindowsPath(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" || url.username || url.password) return false
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (isIP(hostname)) return WebFetchRequest.isPrivateAddress(hostname)
  return !hostname.includes(".") || /\.(?:local|lan|home|internal|localhost|home\.arpa)$/.test(hostname)
}

export function executableInputs(config: unknown, context: { source: string; workspace: string }) {
  if (!isRecord(config)) return []
  const source = path.dirname(context.source)
  const plugins = [
    ...(Array.isArray(config.plugin) ? config.plugin : []).map((entry) => (Array.isArray(entry) ? entry[0] : entry)),
    ...(Array.isArray(config.plugins) ? config.plugins : []).map((entry) => (isRecord(entry) ? entry.package : entry)),
  ]
  const mcp = isRecord(config.mcp) ? config.mcp : {}
  const servers = isRecord(mcp.servers) ? mcp.servers : mcp
  return Array.from(
    new Set([
      ...plugins.flatMap((spec) => localPath(spec, source)),
      ...localPath(config.shell, source),
      ...commandInputs(config.formatter, context.workspace),
      ...commandInputs(config.lsp, context.workspace),
      ...Object.values(servers).flatMap((server) => {
        if (!isRecord(server) || !Array.isArray(server.command)) return []
        const cwd = typeof server.cwd === "string" ? path.resolve(context.workspace, server.cwd) : context.workspace
        return server.command.flatMap((value, index) => localPath(value, cwd, index > 0))
      }),
    ]),
  )
}

export function materializedCommand(
  current: TrustedSnapshot,
  command: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): { command: string[]; cwd: string } | undefined {
  if (
    !command.length ||
    packageRunners.has(executableName(command[0])) ||
    launcherCommands.has(executableName(command[0])) ||
    unsafeProjectEnvironment(environment)
  ) {
    return undefined
  }
  const directory = materializedPathOption(current, cwd)
  if (!directory) return undefined
  const mapped = command.map((value, index) => materializedCommandValue(current, value, cwd, index > 0))
  if (!mapped.every((value): value is string => value !== undefined)) return undefined
  const directExecutable = localPath(command[0], cwd)[0]
  const script = interpreterScript(command)
  if (script === "ambiguous") return undefined
  // A program found on this machine's PATH outside the repository (prettier, gofmt, a language server) is bound to
  // its absolute path and still runs from the approved snapshot's cwd, so relative lookups stay inside approved
  // bytes. A program inside the repository must itself be part of the snapshot.
  if (script === "unknown" && directExecutable && !materializedPathOption(current, directExecutable)) return undefined
  if (typeof script === "number") {
    const input = localPath(command[script], cwd, true)[0]
    if (!input || !materializedPathOption(current, input)) return undefined
  }
  const executable = directExecutable ? mapped[0] : hostExecutable(current, command[0])
  if (!executable) return undefined
  const bound = [executable, ...mapped.slice(1)]
  if (executableName(command[0]) === "bun" && typeof script === "number") {
    return {
      command: [
        executable,
        "--no-env-file",
        `--config=${path.join(current.directory, emptyBunConfig)}`,
        ...bound.slice(1),
      ],
      cwd: directory,
    }
  }
  return { command: bound, cwd: directory }
}

export function hostExecutable(current: TrustedSnapshot, command: string) {
  const found = whichPkg.sync(command, {
    nothrow: true,
    path: process.env.PATH ?? process.env.Path,
    pathExt: process.env.PATHEXT ?? process.env.PathExt,
  })
  if (typeof found !== "string") return
  try {
    const resolved = realpathSync(found)
    if (!contains(current.workspace, resolved)) return resolved
    return materializedPathOption(current, resolved)
  } catch {
    return
  }
}

async function canonicalize(workspace: string) {
  const normalized = path.normalize(await realpath(path.resolve(workspace)))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

// A workspace that is gone, such as a removed task checkout, keys as it did while it existed: its deepest existing
// ancestor resolves through the same realpath, so a data folder reached through a link or a Windows 8.3 short temp
// path still meets the key stored under the real path.
async function realpath(target: string): Promise<string> {
  const resolved = await fs.realpath(target).catch(() => undefined)
  if (resolved) return resolved
  const parent = path.dirname(target)
  if (parent === target) return target
  return path.join(await realpath(parent), path.basename(target))
}

async function collect(
  input: string,
  files: Map<string, CapturedFile>,
  directories: Set<string>,
  budget: { files: number; bytes: number },
  workspace: string,
  source = input,
  seen = new Set<string>(),
  ancestors: ReadonlySet<string> = new Set<string>(),
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) throw new Error(`Workspace trust traversal exceeded ${maxDepth} levels at ${input}`)
  const link = await fs.lstat(source).catch(() => undefined)
  if (!link || ignoredFiles.has(path.basename(input))) return
  if (vectorManagedData(input)) return
  const target = link.isSymbolicLink() ? await followedLink(source, input, workspace) : path.resolve(source)
  if (!target) return
  // Every part of the path read from is real: a link is followed only through followedLink, never by a parent.
  const real = await fs.realpath(target).catch(() => undefined)
  if (!real || normalizePath(real) !== normalizePath(target)) return
  const stat = link.isSymbolicLink() ? await fs.stat(real).catch(() => undefined) : link
  const resolved = path.resolve(input)
  if (!stat || seen.has(resolved)) return
  seen.add(resolved)
  if (stat.isFile()) {
    if (files.has(resolved)) return
    const value = await captureFile(real)
    budget.files++
    budget.bytes += value.content.byteLength
    if (budget.files > maxFiles) throw new Error(`Workspace trust traversal exceeded ${maxFiles} files`)
    if (budget.bytes > maxBytes) throw new Error(`Workspace trust traversal exceeded ${maxBytes} bytes`)
    files.set(resolved, value)
    return
  }
  if (!stat.isDirectory() || ignoredDirectories.has(path.basename(input)) || ancestors.has(real)) return
  directories.add(resolved)
  if (directories.size > maxDirectories) {
    throw new Error(`Workspace trust traversal exceeded ${maxDirectories} directories`)
  }

  const chain = new Set([...ancestors, real])
  const directory = await fs.opendir(real)
  let count = 0
  for await (const entry of directory) {
    count++
    if (count > maxDirectoryEntries) {
      throw new Error(`Workspace trust traversal exceeded ${maxDirectoryEntries} entries in ${input}`)
    }
    if (ignoredDirectories.has(entry.name) || ignoredFiles.has(entry.name)) continue
    await collect(
      path.join(input, entry.name),
      files,
      directories,
      budget,
      workspace,
      path.join(real, entry.name),
      seen,
      chain,
      depth + 1,
    )
  }
}

// A link is followed when its target stays in the workspace (a config shared inside a monorepo), or when it is a
// config file whose target is a regular file elsewhere (a vector.json kept with the user's dotfiles). Its bytes are
// captured under the link's own path, so an approval covers exactly what was read and a change to the target
// changes the fingerprint. A linked directory outside the workspace is never walked.
async function followedLink(source: string, input: string, workspace: string) {
  const real = await fs.realpath(source).catch(() => undefined)
  if (!real) return
  if (contains(workspace, normalizePath(real))) return real
  if (!configNames.has(path.basename(input))) return
  const stat = await fs.stat(real).catch(() => undefined)
  return stat?.isFile() ? real : undefined
}

function vectorManagedData(input: string) {
  if (path.basename(path.dirname(input)) !== ".vector") return false
  const name = path.basename(input)
  return managedData.has(name) || name.startsWith("team-outbox.jsonl")
}

async function collectExecutionDirectory(input: string, directories: Set<string>) {
  const stat = await fs.lstat(input).catch(() => undefined)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return
  const resolved = path.resolve(input)
  const real = await fs.realpath(input).catch(() => undefined)
  if (!real || normalizePath(real) !== normalizePath(resolved)) return
  directories.add(resolved)
  if (directories.size > maxDirectories) {
    throw new Error(`Workspace trust traversal exceeded ${maxDirectories} execution directories`)
  }
}

async function captureFile(file: string): Promise<CapturedFile> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`Workspace trust input is not a regular file: ${file}`)
    if (stat.size > maxFileBytes) throw new Error(`Workspace trust input exceeds ${maxFileBytes} bytes: ${file}`)
    return { content: await handle.readFile(), mode: stat.mode }
  } finally {
    await handle.close()
  }
}

// jsonc-parser recovers from malformed input instead of throwing.
function readConfig(content: Buffer) {
  return parse(content.toString("utf8")) as unknown
}

function fileInputs(config: unknown, source: string) {
  const values: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{file:([^}]+)\}/g)) values.push(match[1]!)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (isRecord(value)) Object.values(value).forEach(visit)
  }
  visit(config)
  // A {file:...} reference is always a path, so a bare name such as `notes.txt` is a file next to the config.
  return values.flatMap((value) =>
    value.startsWith("~/") ? [path.join(os.homedir(), value.slice(2))] : localPath(value, path.dirname(source), true),
  )
}

function commandInputs(config: unknown, base: string) {
  if (!isRecord(config)) return []
  return Object.values(config).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.command)) return []
    const cwd = typeof entry.cwd === "string" ? path.resolve(base, entry.cwd) : base
    return entry.command.flatMap((value, index) => localPath(value, cwd, index > 0))
  })
}

function executableDirectories(config: unknown, workspace: string) {
  if (!isRecord(config)) return []
  const commands = (value: unknown, cwdWithoutCommand = false) => {
    if (!isRecord(value)) return []
    return Object.values(value).flatMap((entry) => {
      if (
        !isRecord(entry) ||
        (!Array.isArray(entry.command) && !(cwdWithoutCommand && typeof entry.cwd === "string"))
      ) {
        return []
      }
      return [typeof entry.cwd === "string" ? path.resolve(workspace, entry.cwd) : workspace]
    })
  }
  const mcp = isRecord(config.mcp) ? config.mcp : {}
  return [
    ...commands(config.formatter, true),
    ...commands(config.lsp, true),
    ...commands(isRecord(mcp.servers) ? mcp.servers : mcp),
  ]
}

function localPath(value: unknown, base: string, bare = false) {
  if (typeof value !== "string") return []
  if (value.startsWith("file:")) {
    try {
      return [fileURLToPath(value)]
    } catch {
      return []
    }
  }
  if (isWindowsPath(value))
    return [process.platform === "win32" ? path.resolve(base, value) : path.win32.normalize(value)]
  if (URL.canParse(value)) return []
  if (path.isAbsolute(value)) return [value]
  if (value.includes("/") || value.includes("\\")) return [path.resolve(base, value)]
  if (bare && value) return [path.resolve(base, value)]
  return []
}

function materializedCommandValue(
  current: TrustedSnapshot,
  value: string,
  base: string,
  bare: boolean,
): string | undefined {
  const input = localPath(value, base, bare)[0]
  if (input) {
    const target = materializedPathOption(current, input)
    if (target) return target
    if (!bare || path.isAbsolute(value) || isWindowsPath(value) || value.includes("/") || value.includes("\\")) {
      return undefined
    }
  }
  if (URL.canParse(value)) return value
  return value
}

const packageRunners = new Set([
  "bunx",
  "corepack",
  "npm",
  "npx",
  "pipx",
  "pnpm",
  "pnpx",
  "uv",
  "uvx",
  "yarn",
  "yarnpkg",
])
const launcherCommands = new Set([
  "busybox",
  "chrt",
  "command",
  "doas",
  "env",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "setsid",
  "start",
  "stdbuf",
  "sudo",
  "systemd-run",
  "taskset",
  "time",
  "timeout",
  "xargs",
])

const unsafeEnvironmentKeys = new Set([
  "APPDATA",
  "BASHOPTS",
  "BASH_ENV",
  "BUN_OPTIONS",
  "BUNDLE_GEMFILE",
  "CDPATH",
  "CLASSPATH",
  "COMSPEC",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_SHARED_STORE",
  "DOTNET_STARTUP_HOOKS",
  "ENV",
  "GEM_HOME",
  "GEM_PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GOENV",
  "GOPATH",
  "GOROOT",
  "GOTOOLDIR",
  "HOME",
  "JDK_JAVA_OPTIONS",
  "JAVA_TOOL_OPTIONS",
  "LOCALAPPDATA",
  "LOCPATH",
  "_JAVA_OPTIONS",
  "GCONV_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NLSPATH",
  "OLDPWD",
  "PATH",
  "PATHEXT",
  "PERL5DB",
  "PERL5LIB",
  "PERL5OPT",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PYTHONHOME",
  "PYTHONBREAKPOINT",
  "PYTHONEXECUTABLE",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PWD",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTC_WRAPPER",
  "RUBYLIB",
  "RUBYOPT",
  "SHELL",
  "SHELLOPTS",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "ZDOTDIR",
])

export function unsafeProjectEnvironment(environment: Readonly<Record<string, string>> | undefined) {
  if (!environment) return false
  return Object.keys(environment).some((key) => {
    const normalized = key.toUpperCase()
    return (
      unsafeEnvironmentKeys.has(normalized) ||
      normalized.startsWith("BASH_FUNC_") ||
      normalized.startsWith("LD_") ||
      normalized.startsWith("DYLD_") ||
      normalized.startsWith("LUA_INIT")
    )
  })
}

function interpreterScript(command: readonly string[]): number | "safe" | "ambiguous" | "unknown" {
  const first = command[0]
  if (!first) return "ambiguous"
  const executable = executableName(first)
  const argument = command[1]
  if (["node", "nodejs"].includes(executable)) {
    if (!argument || ["-h", "--help", "-v", "--version"].includes(argument)) return "safe"
    if (["-e", "--eval", "-p", "--print"].includes(argument)) return "ambiguous"
    return argument.startsWith("-") ? "ambiguous" : 1
  }
  if (["bun", "tsx", "ts-node", "ts-node-esm"].includes(executable)) {
    if (!argument || ["-h", "--help", "-v", "--version"].includes(argument)) return "safe"
    if (["-e", "--eval"].includes(argument)) return "ambiguous"
    if (["run", "x", "exec", "add", "install", "pm"].includes(argument) || argument.startsWith("-")) {
      return "ambiguous"
    }
    return 1
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    if (!argument || ["-h", "--help", "-v", "--version"].includes(argument.toLowerCase())) return "safe"
    if (argument === "-c") return "ambiguous"
    return argument.startsWith("-") ? "ambiguous" : 1
  }
  if (["bash", "dash", "fish", "ksh", "perl", "php", "ruby", "sh", "zsh"].includes(executable)) {
    if (!argument || ["-h", "--help", "-v", "--version"].includes(argument)) return "safe"
    if (["-c", "-e", "-r"].includes(argument)) return "ambiguous"
    return argument.startsWith("-") ? "ambiguous" : 1
  }
  if (executable === "deno") {
    if (!argument || ["help", "lsp", "--help", "--version"].includes(argument)) return "safe"
    if (argument === "eval") return "ambiguous"
    if (argument !== "run" || !command[2] || command[2].startsWith("-")) return "ambiguous"
    return 2
  }
  if (executable === "java") {
    if (!argument || ["-h", "--help", "-version", "--version"].includes(argument)) return "safe"
    if (argument !== "-jar" || !command[2]) return "ambiguous"
    return 2
  }
  if (executable === "dotnet") {
    if (!argument || ["-h", "--help", "--info", "--version"].includes(argument)) return "safe"
    if (argument === "run" || argument.startsWith("-")) return "ambiguous"
    return 1
  }
  if (["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
    return "ambiguous"
  }
  return command.length === 1 ? "safe" : "unknown"
}

function executableName(value: string) {
  return path.win32
    .basename(path.basename(value))
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/i, "")
}

function isWindowsPath(value: string) {
  return /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")
}

function normalizeInput(input: string, requested: string, canonical: string) {
  const resolved = path.resolve(input)
  if (!contains(requested, resolved)) return resolved
  return path.resolve(canonical, path.relative(requested, resolved))
}

function snapshotPath(current: Snapshot, input: string) {
  return normalizeInput(input, current[requestedWorkspace], current.workspace)
}

function hasCapturedPath(current: Snapshot, input: string) {
  if (current[captured].has(input)) return true
  if (current[capturedDirectories].has(input)) return true
  const prefix = input.endsWith(path.sep) ? input : `${input}${path.sep}`
  return Array.from(current[captured].keys()).some((file) => file.startsWith(prefix))
}

function materializedRelativePath(file: string) {
  const parsed = path.parse(file)
  const volume = createHash("sha256").update(parsed.root.toLowerCase()).digest("hex").slice(0, 16)
  return path.join(`volume-${volume}`, path.relative(parsed.root, file))
}

async function verifyMaterialized(directory: string, current: Snapshot) {
  for (const [source, value] of current[captured]) {
    const file = path.join(directory, materializedRelativePath(source))
    const hit = await captureFile(file).catch(() => undefined)
    if (!hit || !hit.content.equals(value.content) || (hit.mode & 0o111 ? 1 : 0) !== (value.mode & 0o111 ? 1 : 0)) {
      throw new Error(`Trusted workspace cache ${directory} changed at ${file}`)
    }
  }
  for (const source of new Set([...current[capturedDirectories], ...current[executionDirectories]])) {
    const target = path.join(directory, materializedRelativePath(source))
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Trusted workspace cache ${directory} is missing ${target}`)
    }
  }
  await ensureEmptyBunConfig(directory)
}

async function ensureEmptyBunConfig(directory: string) {
  // Captured inputs live under volume-<hash>/, so this private runtime file cannot collide with approved inputs.
  // Exclusive creation also upgrades older caches without changing the user's approval fingerprint.
  const file = path.join(directory, emptyBunConfig)
  await fs.writeFile(file, "", { flag: "wx", mode: 0o400 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const stat = await fs.lstat(file)
  const captured = stat.isFile() && !stat.isSymbolicLink() && stat.size === 0 ? await captureFile(file) : undefined
  if (!captured || captured.content.length !== 0) {
    throw new Error(`Trusted workspace cache ${directory} changed at ${file}`)
  }
}

function contains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizePath(input: string) {
  const normalized = path.normalize(input)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function key(workspace: string) {
  return createHash("sha256").update(workspace).digest("hex")
}

async function readStore(stateDirectory: string): Promise<Store> {
  const parsed = await fs
    .readFile(path.join(stateDirectory, filename), "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version, workspaces: {} }
  if (!("version" in parsed) || parsed.version !== version) return { version, workspaces: {} }
  if (!("workspaces" in parsed) || !parsed.workspaces || typeof parsed.workspaces !== "object") {
    return { version, workspaces: {} }
  }
  return parsed as Store
}

async function writeStore(stateDirectory: string, store: Store) {
  await fs.mkdir(stateDirectory, { recursive: true })
  const target = path.join(stateDirectory, filename)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(temporary, target)
}
