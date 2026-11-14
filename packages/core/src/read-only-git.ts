import { DirectoryIdentityReader } from "./directory-identity"
import { ProcessIsolation } from "./process-isolation"
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
export const INTEGRITY = Object.freeze({
  addressSpace: 512 * 1024 * 1024,
  cpu: 8,
  descriptors: 64,
  objects: 50_000,
  objectBytes: 64 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  output: 4 * 1024 * 1024,
  milliseconds: 10_000,
  opening: 30_000,
  waiting: 8,
})
// The image is acquired from DirectoryIdentityReader's actual fixed distro/runtime proof. This literal never
// forks, imports subprocess/resource, selects tools from PATH, or interprets stdin. All limits precede Git exec.
export const PROCESS_SOURCE = String.raw`import os, sys
try:
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12) or sys.byteorder != "little" or not sys.flags.isolated or not sys.flags.no_site or sys.prefix != "/usr" or sys.exec_prefix != "/usr":
        os._exit(125)
    if set(sys.path) - {"/usr/lib/python312.zip", "/usr/lib/python3.12", "/usr/lib/python3.12/lib-dynload"}:
        os._exit(125)
    if len(sys.argv) < 3 or not os.path.isabs(sys.argv[1]) or len(sys.argv) > 100016:
        os._exit(125)
    if len(set(os.getresuid())) != 1 or os.getuid() == 0 or len(set(os.getresgid())) != 1:
        os._exit(125)
    if "_struct" not in sys.builtin_module_names:
        os._exit(125)
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    for name, module in tuple(sys.modules.items()):
        origin = getattr(module, "__file__", None)
        if origin and not os.path.realpath(origin).startswith("/usr/lib/python3.12/"):
            os._exit(125)
    libc.close_range.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_int)
    libc.close_range.restype = ctypes.c_int
    if libc.close_range(3, 0xffffffff, 0) != 0:
        os._exit(125)
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Caps(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
    header = Header(0x20080522, 0)
    caps = (Caps * 2)()
    libc.capset.argtypes = (ctypes.POINTER(Header), ctypes.POINTER(Caps))
    libc.capget.argtypes = (ctypes.POINTER(Header), ctypes.POINTER(Caps))
    libc.capset.restype = libc.capget.restype = ctypes.c_int
    libc.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    libc.prctl.restype = ctypes.c_int
    if libc.capset(ctypes.byref(header), caps) != 0 or libc.capget(ctypes.byref(header), caps) != 0 or any(c.effective or c.permitted or c.inheritable for c in caps):
        os._exit(125)
    if libc.prctl(47, 4, 0, 0, 0) != 0 or libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(39, 0, 0, 0, 0) != 1:
        os._exit(125)
    class Limit(ctypes.Structure):
        _fields_ = [("soft", ctypes.c_ulong), ("hard", ctypes.c_ulong)]
    if ctypes.sizeof(ctypes.c_ulong) != 8:
        os._exit(125)
    libc.setrlimit.argtypes = (ctypes.c_int, ctypes.POINTER(Limit))
    libc.getrlimit.argtypes = (ctypes.c_int, ctypes.POINTER(Limit))
    libc.setrlimit.restype = libc.getrlimit.restype = ctypes.c_int
    for resource, value in ((9, 536870912), (0, 8), (4, 0), (7, 64), (6, 0)):
        expected = Limit(value, value)
        actual = Limit()
        if libc.setrlimit(resource, ctypes.byref(expected)) != 0 or libc.getrlimit(resource, ctypes.byref(actual)) != 0 or actual.soft != value or actual.hard != value:
            os._exit(125)
    os.execve(sys.argv[1], sys.argv[1:], dict(os.environ))
except BaseException:
    os._exit(125)
`

/** Object headers bound availability, not integrity; only a successful later full fsck authenticates their content. */
export function objectManifest(bytes: Buffer) {
  requireValue(bytes.length > 0 && bytes.length <= INTEGRITY.output, "object manifest exceeds its bound")
  const text = bytes.toString("utf8")
  requireValue(Buffer.from(text).equals(bytes) && text.endsWith("\n"), "object manifest is malformed")
  const seen = new Set<string>()
  let total = 0
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{40}) (blob|tree|commit|tag) (0|[1-9][0-9]{0,12})$/.exec(line)
    requireValue(match && !seen.has(match[1]!), "object manifest is malformed")
    seen.add(match[1]!)
    const size = Number(match[3])
    requireValue(
      seen.size <= INTEGRITY.objects && size <= INTEGRITY.objectBytes && (total += size) <= INTEGRITY.totalBytes,
      "expanded object snapshot exceeds its bound",
    )
  }
  return { objects: seen.size, bytes: total }
}

/** Availability profile only. The real fixed command supplies these bytes; caller data cannot select verifier flags. */
export function fsckProfile(version: Buffer, help: Buffer) {
  requireValue(
    version.length <= 256 && help.length > 0 && help.length <= 16 * 1024,
    "Git verifier capability is unsupported",
  )
  const release = /^git version 2\.(4[3-9]|5[0-6])\.(0|[1-9][0-9]{0,3})\n$/.exec(version.toString("utf8"))
  const usage = help.toString("utf8")
  requireValue(
    release && Buffer.from(usage).equals(help) && usage.startsWith("usage: git fsck "),
    "Git verifier capability is unsupported",
  )
  const option = (name: string) => new RegExp(`(?:^|\\n)[ \\t]+--(?:\\[no-\\])?${name}(?:[ \\t]|$)`).test(usage)
  requireValue(
    ["strict", "full", "cache", "no-reflogs", "no-dangling", "no-progress", "no-name-objects"].every((name) => {
      const base = name.startsWith("no-") ? name.slice(3) : name
      return option(name) || option(base)
    }),
    "Git verifier capability is unsupported",
  )
  const references = option("references")
  requireValue(references === Number(release[1]) >= 50, "Git verifier version and capability do not match")
  return Object.freeze({ references })
}

/** The production caller reads these selectors from its pinned PRIVATE store, not from an owner's live refs. */
export function privateRefShape(
  snapshot: { head: Buffer; refs: readonly string[]; packed: boolean; reftable: boolean },
  expected: string,
) {
  requireValue(
    /^[0-9a-f]{40}$/.test(expected) &&
      snapshot.head.equals(Buffer.from(expected + "\n")) &&
      snapshot.refs.length === 0 &&
      !snapshot.packed &&
      !snapshot.reftable,
    "the private reference database is not an empty detached snapshot",
  )
}

export function commandReason(line: string) {
  if (/^error: cannot fork\(\) for refs: Resource temporarily unavailable$/.test(line)) return "refs-fork" as const
  if (/^error: unknown option `(?:no-)?references'$/.test(line)) return "unsupported-argument" as const
  if (/^fatal: (?:Out of memory|mmap failed): Cannot allocate memory$/.test(line)) return "memory" as const
  return "Unknown" as const
}
type CommandDiagnostic = Readonly<{
  command: "version" | "capability" | "configuration" | "integrity" | "manifest" | "index" | "read"
  exit: number | null
  signal: "none" | "SIGKILL" | "SIGTERM" | "SIGXCPU" | "SIGABRT" | "SIGSEGV" | "SIGBUS" | "other"
  stdout: number
  stderr: number
  reason:
    | "none"
    | "refs-fork"
    | "unsupported-argument"
    | "memory"
    | "Unknown"
    | "output-limit"
    | "expired"
    | "spawn-error"
    | "pipe-error"
}>
const commandDiagnostics = new WeakMap<{ code: number; bytes: Buffer }, CommandDiagnostic>()
function requireCommand(result: { code: number; bytes: Buffer }, codes: readonly number[], reason: string) {
  if (codes.includes(result.code)) return
  const cause = commandDiagnostics.get(result)
  throw new Unavailable(reason, cause ? { cause } : undefined)
}

let executing = false
const waiting = new Set<() => void>()
async function admit(expires: number, signal: AbortSignal) {
  requireValue(!signal.aborted && performance.now() < expires, "Git inspection was cancelled or expired")
  if (executing) {
    requireValue(waiting.size < INTEGRITY.waiting, "Git inspection is busy")
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        waiting.delete(wake)
      }
      const wake = () => {
        clean()
        resolve()
      }
      const cancel = () => {
        clean()
        reject(new Unavailable("Git inspection was cancelled or expired"))
      }
      const timer = setTimeout(cancel, Math.max(0, expires - performance.now()))
      waiting.add(wake)
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }
  executing = true
  return () => {
    const next = waiting.values().next().value
    if (next) next()
    else executing = false
  }
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
  constructor(
    readonly reason: string,
    options?: { cause: CommandDiagnostic },
  ) {
    super(`Read-only Git inspection is unavailable: ${reason}.`, options)
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

interface Resource {
  close: () => Promise<void>
}
interface Operation {
  readonly expires: number
  readonly signal: AbortSignal
  readonly check: () => void
  readonly resources: Set<Resource>
  readonly unsafe: () => void
}
type Command = (
  args: string[],
  input?: Buffer,
  maximum?: number,
  directory?: string,
) => Promise<{ code: number; bytes: Buffer }>
const retained = new Set<{ temporary?: string; resources: Set<Resource> }>()
async function step<A>(context: Operation | undefined, action: () => Promise<A>) {
  context?.check()
  const value = await action()
  context?.check()
  return value
}
async function releaseResource(context: Operation | undefined, resource: Resource) {
  try {
    await resource.close()
  } catch (error) {
    context?.unsafe()
    throw error
  }
  context?.resources.delete(resource)
}
async function acquire<A extends Resource>(context: Operation | undefined, action: () => Promise<A>) {
  context?.check()
  const resource = await action()
  context?.resources.add(resource)
  try {
    context?.check()
    return resource
  } catch (error) {
    await releaseResource(context, resource)
    throw error
  }
}

async function directory(file: string, context?: Operation) {
  const real = await step(context, () => fs.realpath(file))
  requireValue((await step(context, () => fs.lstat(real))).isDirectory(), "invalid metadata directory")
  return real
}

// Linux directory descriptors pin each ancestor. No repository path component is followed as a symlink.
async function openWithin(root: FileHandle, name: string, flags: number, trusted = false, context?: Operation) {
  context?.check()
  const parts = name.split("/")
  requireValue(
    parts.every((part) => part && part !== "." && part !== ".."),
    "invalid metadata path",
  )
  const parents: FileHandle[] = []
  let selected: FileHandle | undefined
  let parent = root
  try {
    try {
      if (trusted) requireValue(await trustedOwner(parent, context), "Git toolchain ancestry is writable")
      for (const component of parts.slice(0, -1)) {
        parent = await acquire(context, () =>
          fs.open(
            `/proc/self/fd/${parent.fd}/${component}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        )
        parents.push(parent)
        if (trusted) requireValue(await trustedOwner(parent, context), "Git toolchain ancestry is writable")
      }
      selected = await acquire(context, () =>
        fs.open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      )
      return selected
    } finally {
      await Promise.all(parents.map((handle) => releaseResource(context, handle)))
    }
  } catch (error) {
    if (selected) await releaseResource(context, selected)
    throw error
  }
}

async function trustedOwner(handle: FileHandle, context?: Operation) {
  const info = await step(context, () => handle.stat())
  return info.uid === 0 && (info.mode & 0o6022) === 0
}

async function trustedProgram(file: string, context?: Operation) {
  const anchor = await acquire(context, () =>
    fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  )
  try {
    const opened = await openWithin(anchor, file.slice(1), constants.O_RDONLY, true, context)
    try {
      return (await step(context, () => opened.stat())).isFile() && (await trustedOwner(opened, context))
    } finally {
      await releaseResource(context, opened)
    }
  } finally {
    await releaseResource(context, anchor)
  }
}

async function pin(file: string, context?: Operation) {
  const anchor = await acquire(context, () =>
    fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  )
  try {
    return await openWithin(anchor, file.slice(1), constants.O_RDONLY | constants.O_DIRECTORY, false, context)
  } finally {
    await releaseResource(context, anchor)
  }
}

async function read(
  root: FileHandle,
  file: string,
  limit: number,
  optional = false,
  context?: Operation,
): Promise<Buffer | undefined> {
  const opened = await openWithin(root, file, constants.O_RDONLY, false, context).catch(
    (error: NodeJS.ErrnoException) => {
      if (optional && error.code === "ENOENT") return
      throw error
    },
  )
  if (!opened) return
  try {
    return await readOpened(opened, limit, context)
  } finally {
    await releaseResource(context, opened)
  }
}

async function readOpened(opened: FileHandle, limit: number, context?: Operation) {
  const before = await step(context, () => opened.stat({ bigint: true }))
  requireValue(before.isFile() && before.size <= BigInt(limit), "nonregular or oversized metadata")
  const result = Buffer.alloc(Number(before.size) + 1)
  let size = 0
  while (size < result.byteLength) {
    const part = await step(context, () => opened.read(result, size, result.byteLength - size, size))
    if (!part.bytesRead) break
    size += part.bytesRead
  }
  const after = await step(context, () => opened.stat({ bigint: true }))
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

async function privateReferences(file: string, expected: string, context: Operation) {
  const root = await pin(file, context)
  try {
    const references = await openWithin(root, "refs", constants.O_RDONLY | constants.O_DIRECTORY, false, context)
    try {
      const directory = await acquire(context, () => fs.opendir(`/proc/self/fd/${references.fd}`))
      try {
        const first = await step(context, () => directory.read())
        const exists = async (name: string) => {
          const item = await openWithin(root, name, constants.O_RDONLY, false, context).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return
              throw error
            },
          )
          if (!item) return false
          await releaseResource(context, item)
          return true
        }
        privateRefShape(
          {
            head: (await read(root, "HEAD", 4096, false, context))!,
            refs: first ? [first.name] : [],
            packed: await exists("packed-refs"),
            reftable: await exists("reftable"),
          },
          expected,
        )
      } finally {
        await releaseResource(context, directory)
      }
    } finally {
      await releaseResource(context, references)
    }
  } finally {
    await releaseResource(context, root)
  }
}

async function executable(excluded: string[], context?: Operation) {
  const names = process.platform === "win32" ? ["git.com", "git.exe"] : ["git"]
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    const root = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!path.isAbsolute(root)) continue
    for (const name of names) {
      const candidate = await step(context, () => fs.realpath(path.join(root, name))).catch(() => undefined)
      if (!candidate || excluded.some((directory) => inside(directory, candidate))) continue
      const info = await step(context, () => fs.stat(candidate))
      if (!info.isFile()) continue
      if (!(await trustedProgram(candidate, context).catch(() => false))) continue
      if (
        !(await step(context, () => fs.access(candidate, constants.X_OK)).then(
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
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  }
}

async function makeCommands(
  file: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opening: Operation,
  isOpen: () => boolean,
) {
  requireValue(
    typeof process.getuid === "function" && process.getuid() !== 0 && process.getuid() === process.geteuid?.(),
    "this host has no supported unprivileged Git verifier",
  )
  const signal = opening.signal
  const image = await DirectoryIdentityReader.pythonImage(opening.expires, signal)
  requireValue(image, "the fixed Git verifier runtime is unavailable")
  try {
    opening.check()
  } catch (error) {
    image.close()
    throw error
  }
  const pending = new Set<Promise<unknown>>()
  const execute = async (
    context: Operation,
    args: string[],
    input?: Buffer,
    maximum = LIMIT.index,
    directory = cwd,
    index?: string,
  ) => {
    requireValue(index === undefined || path.dirname(index) === cwd, "Git's private observation index is unavailable")
    requireValue(directory === cwd || inside(cwd, directory), "Git's private working directory is unavailable")
    const expires = Math.min(context.expires, performance.now() + INTEGRITY.milliseconds)
    const stage: CommandDiagnostic["command"] = args.includes("--version")
      ? "version"
      : args.includes("fsck")
        ? args.includes("-h")
          ? "capability"
          : "integrity"
        : args.includes("config")
          ? "configuration"
          : args.includes("--batch-all-objects")
            ? "manifest"
            : args.includes("read-tree") || args.includes("update-index") || args.includes("ls-files")
              ? "index"
              : "read"
    const check = () => {
      context.check()
      requireValue(
        !signal.aborted && isOpen() && image.isOpen() && performance.now() < expires,
        "Git inspection was cancelled or expired",
      )
    }
    check()
    const release = await admit(expires, signal)
    try {
      check()
      requireValue(await image.validate(expires, signal), "the fixed Git verifier runtime changed")
      check() // No await separates final live-view/image/deadline proof from fixed spawn.
      return await new Promise<{ code: number; bytes: Buffer }>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        let excessive = false
        let stopped = false
        let failed = false
        let failure: "none" | "spawn-error" | "pipe-error" = "none"
        let stdout = 0,
          stderr = 0
        let stderrTail = ""
        let stderrReason: ReturnType<typeof commandReason> | "none" = "none"
        let timer: ReturnType<typeof setTimeout> | undefined
        // The fixed verifier must not bypass required tool isolation. It remains unavailable until adapted.
        requireValue(!ProcessIsolation.required(), "Git inspection cannot bypass required process isolation")
        const child = spawn(DirectoryIdentityReader.PYTHON, ["-I", "-S", "-c", PROCESS_SOURCE, file, ...args], {
          cwd: directory,
          env: index === undefined ? env : { ...env, GIT_INDEX_FILE: index },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        })
        // EMFILE/ENFILE may return a ChildProcess with no pipes and queue its error. Own error/close FIRST.
        child.once("error", () => {
          failed = true
          failure = "spawn-error"
        })
        child.once("close", (code, killed) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", stop)
          try {
            check()
          } catch {
            failed = true
          }
          if (stderrTail && stderrReason === "none") stderrReason = commandReason(stderrTail)
          const metadata: CommandDiagnostic = Object.freeze({
            command: stage,
            exit: code !== null && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
            signal:
              killed === null
                ? "none"
                : ((["SIGKILL", "SIGTERM", "SIGXCPU", "SIGABRT", "SIGSEGV", "SIGBUS"] as const).find(
                    (value) => value === killed,
                  ) ?? "other"),
            stdout: Math.min(stdout, maximum + 1),
            stderr: Math.min(stderr, maximum + 1),
            reason:
              failure !== "none"
                ? failure
                : excessive
                  ? "output-limit"
                  : stopped || signal.aborted || performance.now() >= expires
                    ? "expired"
                    : stderrReason,
          })
          if (failed || stopped || excessive || killed || code === null)
            return reject(new Unavailable("Git exceeded its execution bound", { cause: metadata }))
          const result = { code, bytes: Buffer.concat(chunks) }
          commandDiagnostics.set(result, metadata)
          resolve(result)
        })
        const stop = () => {
          stopped = true
          try {
            child.kill("SIGKILL")
          } catch {
            failed = true
          }
        }
        timer = setTimeout(stop, Math.max(0, expires - performance.now()))
        signal.addEventListener("abort", stop, { once: true })
        if (signal.aborted) stop()
        const count = (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > maximum) {
            excessive = true
            stop()
          }
        }
        child.stdin?.on("error", () => {
          failed = true
          failure = "pipe-error"
          stop()
        })
        child.stdout?.on("error", () => {
          failed = true
          failure = "pipe-error"
          stop()
        })
        child.stderr?.on("error", () => {
          failed = true
          failure = "pipe-error"
          stop()
        })
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.byteLength
          count(chunk)
          if (!excessive) chunks.push(chunk)
        })
        // Repository-controlled diagnostics can contain private config values; never copy them into an error or log.
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.byteLength
          count(chunk)
          if (excessive) return
          const lines = (stderrTail + chunk.toString("utf8")).split("\n")
          const tail = lines.pop() ?? ""
          for (const line of lines) {
            const known = commandReason(line.replace(/\r$/, ""))
            if (known !== "Unknown") stderrReason = known
            else if (stderrReason === "none") stderrReason = "Unknown"
          }
          stderrTail = tail.length <= 1024 ? tail : ""
          if (tail.length > 1024 && stderrReason === "none") stderrReason = "Unknown"
        })
        if (!child.stdin || !child.stdout || !child.stderr) {
          failed = true
          failure = "pipe-error"
          stop()
          return
        }
        try {
          child.stdin.end(input)
        } catch {
          failed = true
          failure = "pipe-error"
          stop()
        }
      })
    } finally {
      release()
    }
  }
  return {
    command: (
      context: Operation,
      args: string[],
      input?: Buffer,
      maximum?: number,
      directory?: string,
      index?: string,
    ) => {
      // Track the complete operation, including admission/preflight, until its sole native PID is reaped.
      const operation = execute(context, [...args], input, maximum, directory, index)
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => {})
      return operation
    },
    close: async () => {
      image.close()
      await Promise.allSettled([...pending])
    },
  }
}

async function configuration(command: Command, data: Buffer | undefined) {
  if (!data) return new Map<string, string>()
  const result = await command(
    ["--no-pager", "config", "--file", "-", "--no-includes", "--null", "--get-regexp", CONFIG],
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

async function head(git: FileHandle, common: FileHandle, captured?: Buffer, context?: Operation) {
  const value = metadataLine(captured ?? (await read(git, "HEAD", 4096, false, context))!)
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
  const loose = await read(common, ref, 4096, true, context)
  if (loose) {
    const oid = metadataLine(loose)
    requireValue(/^[0-9a-f]{40}$/.test(oid), "symbolic or non-SHA1 branch reference is unsupported")
    return oid
  }
  const packed = (await read(common, "packed-refs", LIMIT.refs, true, context))?.toString("utf8") ?? ""
  const matches = packed.split("\n").filter((line) => line.slice(41) === ref)
  requireValue(matches.length === 1 && /^[0-9a-f]{40} /.test(matches[0]!), "the captured branch has no unique commit")
  return matches[0]!.slice(0, 40)
}

async function objects(common: FileHandle, target: string, context: Operation) {
  const source = await openWithin(common, "objects", constants.O_RDONLY | constants.O_DIRECTORY, false, context)
  try {
    requireValue(
      !(await read(source, "info/alternates", LIMIT.config, true, context)),
      "alternate object stores are unsupported",
    )
    await step(context, () => fs.mkdir(target, { mode: 0o700 }))
    let count = 0
    let seen = 0
    let bytes = 0n
    const listing = await acquire(context, () => fs.opendir(`/proc/self/fd/${source.fd}`))
    try {
      for (;;) {
        const fan = await step(context, () => listing.read())
        if (!fan) break
        requireValue(++seen <= LIMIT.files, "object directory listing exceeds its bound")
        if (!/^[0-9a-f]{2}$/.test(fan.name) && fan.name !== "pack") continue
        requireValue(fan.isDirectory() && !fan.isSymbolicLink(), "linked object directories are unsupported")
        const location = await openWithin(source, fan.name, constants.O_RDONLY | constants.O_DIRECTORY, false, context)
        try {
          await step(context, () => fs.mkdir(path.join(target, fan.name), { mode: 0o700 }))
          const entries = await acquire(context, () => fs.opendir(`/proc/self/fd/${location.fd}`))
          try {
            for (;;) {
              const item = await step(context, () => entries.read())
              if (!item) break
              requireValue(++seen <= LIMIT.files, "object directory listing exceeds its bound")
              const allowed =
                fan.name === "pack"
                  ? /^pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)$/.test(item.name)
                  : /^[0-9a-f]{38}$/.test(item.name)
              if (!allowed) continue
              requireValue(item.isFile() && !item.isSymbolicLink(), "linked Git objects are unsupported")
              const opened = await openWithin(location, item.name, constants.O_RDONLY, false, context)
              try {
                const before = await step(context, () => opened.stat({ bigint: true }))
                requireValue(
                  before.isFile() && ++count <= LIMIT.files && (bytes += before.size) <= BigInt(LIMIT.objects),
                  "object snapshot exceeds its bound",
                )
                await copyOpened(opened, path.join(target, fan.name, item.name), before.size, context)
              } finally {
                await releaseResource(context, opened)
              }
            }
          } finally {
            await releaseResource(context, entries)
          }
        } finally {
          await releaseResource(context, location)
        }
      }
    } finally {
      await releaseResource(context, listing)
    }
  } finally {
    await releaseResource(context, source)
  }
}

async function copyOpened(opened: FileHandle, target: string, bound: bigint, context: Operation) {
  const before = await step(context, () => opened.stat({ bigint: true }))
  requireValue(before.isFile() && before.size <= bound, "source file is nonregular or oversized")
  const output = await acquire(context, () =>
    fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
  )
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (position < Number(before.size)) {
      const part = await step(context, () =>
        opened.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position),
      )
      requireValue(part.bytesRead > 0, "source file changed during capture")
      let written = 0
      while (written < part.bytesRead) {
        const result = await step(context, () =>
          output.write(buffer, written, part.bytesRead - written, position + written),
        )
        requireValue(result.bytesWritten > 0, "private snapshot could not be written")
        written += result.bytesWritten
      }
      position += part.bytesRead
    }
    const after = await step(context, () => opened.stat({ bigint: true }))
    requireValue(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      "source file changed during capture",
    )
  } finally {
    await releaseResource(context, output)
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
  /** Synchronous lifetime witness; false as soon as close starts. */
  readonly isOpen: () => boolean
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
  requireValue(!ProcessIsolation.required(), "Git inspection cannot bypass required process isolation")
  const opening = performance.now() + INTEGRITY.opening
  requireValue(!options?.signal?.aborted, "Git snapshot was cancelled")
  requireValue(process.platform === "linux", "this host has no pinned-directory adapter")
  requireValue(retained.size === 0, "prior Git cleanup remains unconfirmed")
  const resources = new Set<Resource>()
  const storage: { temporary?: string; resources: Set<Resource> } = { resources }
  const operations = new Set<Promise<unknown>>()
  let transferred = false
  let closed = false
  let cleanupFailed = false
  let closing: Promise<void> | undefined
  let execution: Awaited<ReturnType<typeof makeCommands>> | undefined
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options?.signal?.addEventListener("abort", cancel, { once: true })
  if (options?.signal?.aborted) cancel()
  const operation = (expires: number): Operation => ({
    expires,
    signal: controller.signal,
    resources,
    check: () =>
      requireValue(
        !closed && !cleanupFailed && !controller.signal.aborted && performance.now() < expires,
        "Git inspection was cancelled or expired",
      ),
    unsafe: () => {
      cleanupFailed = true
      controller.abort()
    },
  })
  const startup = operation(opening)
  const observe = <A>(body: (context: Operation) => Promise<A>) => {
    const context = operation(performance.now() + INTEGRITY.milliseconds)
    const pending = Promise.resolve()
      .then(async () => {
        context.check()
        const value = await body(context)
        context.check()
        return value
      })
      .catch((error) => {
        throw unavailable(error)
      })
    operations.add(pending)
    void pending.finally(() => operations.delete(pending)).catch(() => {})
    return pending
  }
  const close = () => {
    closed = true
    controller.abort()
    return (closing ??= (async () => {
      options?.signal?.removeEventListener("abort", cancel)
      await Promise.allSettled([...operations])
      await execution?.close()
      const results = await Promise.allSettled([...resources].map((resource) => releaseResource(startup, resource)))
      requireValue(
        !cleanupFailed && results.every((result) => result.status === "fulfilled"),
        "Git cleanup remains unconfirmed",
      )
      if (storage.temporary) await fs.rm(storage.temporary, { recursive: true, force: true })
    })().catch(() => {
      retained.add(storage)
      throw new Unavailable("Git cleanup remains unconfirmed; private resources are retained")
    }))
  }
  try {
    const root = await directory(input.directory, startup)
    const git = await directory(input.gitDirectory, startup)
    const common = await directory(input.commonDirectory, startup)
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
    startup.check()
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "vector-readonly-git-"))
    storage.temporary = created
    startup.check()
    const temporary = await step(startup, () => fs.realpath(created))
    storage.temporary = temporary
    requireValue(
      !inside(root, temporary) && !inside(common, temporary) && !inside(path.dirname(common), temporary),
      "temporary metadata would be repository-controlled",
    )
    await step(startup, () => fs.chmod(temporary, 0o700))
    const rootHandle = await pin(root, startup)
    const gitHandle = await pin(git, startup)
    const commonHandle = await pin(common, startup)
    const commonIdentity = await step(startup, () => directoryIdentity(commonHandle, controller.signal))
    requireValue(!options?.signal?.aborted, "Git snapshot was cancelled")
    requireValue(
      !input.commonIdentity || (commonIdentity !== undefined && sameIdentity(input.commonIdentity, commonIdentity)),
      "the admitted common store changed identity",
    )
    const program = await executable([root, common, path.dirname(common)], startup)
    const env = environment(temporary, program)
    const commands = await makeCommands(program, temporary, env, startup, () => !closed)
    execution = commands
    const command: Command = (args, input, maximum, directory) =>
      commands.command(startup, args, input, maximum, directory)
    const base = await configuration(command, await read(commonHandle, "config", LIMIT.config, false, startup))
    const local =
      base.get("extensions.worktreeconfig") === "true"
        ? await configuration(command, await read(gitHandle, "config.worktree", LIMIT.config, true, startup))
        : new Map<string, string>()
    const builtin = new Map([...base, ...local])
    requireValue(builtin.get("core.sparsecheckout") !== "true", "sparse worktrees are unsupported")
    const capturedHead = await head(gitHandle, commonHandle, undefined, startup)
    const capturedRef = (await read(gitHandle, "HEAD", 4096, false, startup))!.toString("utf8").trim()
    const branch = capturedRef.startsWith("ref: refs/heads/") ? capturedRef.slice(16) : undefined
    const index = (await read(gitHandle, "index", LIMIT.index, false, startup))!
    requireValue(index.byteLength >= 12 && index.subarray(0, 4).toString() === "DIRC", "Git index is unsupported")
    const digest = createHash("sha256").update(index).digest("hex")
    const privateGit = path.join(temporary, "git")
    await step(startup, () => fs.mkdir(path.join(privateGit, "refs"), { recursive: true, mode: 0o700 }))
    await step(startup, () => fs.mkdir(path.join(privateGit, "info"), { mode: 0o700 }))
    await step(startup, () =>
      fs.writeFile(path.join(privateGit, "HEAD"), capturedHead + "\n", { mode: 0o600, flag: "wx" }),
    )
    await step(startup, () => fs.writeFile(path.join(privateGit, "index"), index, { mode: 0o600, flag: "wx" }))
    const safe = [
      "[core]",
      "repositoryFormatVersion = 0",
      "bare = false",
      "logAllRefUpdates = false",
      "fsmonitor = false",
      "useBuiltinFSMonitor = false",
      "untrackedCache = false",
      "trustctime = true",
      "checkstat = default",
      "ignorestat = false",
      "sparseCheckout = false",
      "sparseCheckoutCone = false",
      "commitGraph = false",
      "multiPackIndex = false",
      "packedGitWindowSize = 1m",
      "packedGitLimit = 64m",
      "deltaBaseCacheLimit = 16m",
      "bigFileThreshold = 8m",
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
      "[pack]",
      "threads = 1",
      "[index]",
      "threads = 1",
      "[protocol]",
      "allow = never",
      "",
    ]
    await step(startup, () =>
      fs.writeFile(path.join(privateGit, "config"), safe.join("\n"), { mode: 0o600, flag: "wx" }),
    )
    for (const name of ["attributes", "exclude"]) {
      const data = await read(commonHandle, "info/" + name, LIMIT.config, true, startup)
      if (data)
        await step(startup, () => fs.writeFile(path.join(privateGit, "info", name), data, { mode: 0o600, flag: "wx" }))
    }
    const shallow = await read(commonHandle, "shallow", LIMIT.refs, true, startup)
    if (shallow) {
      const boundaries = shallow.toString("ascii").split("\n")
      requireValue(
        boundaries.pop() === "" &&
          boundaries.length > 0 &&
          boundaries.length <= INTEGRITY.objects &&
          boundaries.every((value) => /^[0-9a-f]{40}$/.test(value)) &&
          new Set(boundaries).size === boundaries.length &&
          Buffer.from(boundaries.join("\n") + "\n").equals(shallow),
        "shallow boundaries are unsupported",
      )
      await step(startup, () => fs.writeFile(path.join(privateGit, "shallow"), shallow, { mode: 0o600, flag: "wx" }))
    }
    await objects(commonHandle, path.join(privateGit, "objects"), startup)
    const args = ["--no-pager", "--no-optional-locks", `--git-dir=${privateGit}`, `--work-tree=${root}`]
    const version = await command(["--no-pager", "--version"], undefined, 256)
    requireCommand(version, [0], "Git verifier version is unsupported")
    // Short usage is a fixed builtin parse, not --help/man/pager. Both known legacy129 and modern0 are bounded.
    const help = await command([...args, "fsck", "-h"], undefined, 16 * 1024)
    requireCommand(help, [0, 129], "Git verifier capability is unsupported")
    const profile = (() => {
      try {
        return fsckProfile(version.bytes, help.bytes)
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error
        const cause = commandDiagnostics.get(help)
        throw new Unavailable(error.reason, cause ? { cause } : undefined)
      }
    })()
    const commitType = await command([...args, "cat-file", "-t", capturedHead])
    requireValue(
      commitType.code === 0 && commitType.bytes.equals(Buffer.from("commit\n")),
      "the captured HEAD is not an available commit object",
    )
    const entries = await command([...args, "ls-files", "--stage", "--sparse", "-z"])
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
    const empty = await command([...args, "read-tree", "--empty"])
    requireValue(empty.code === 0, "private index could not be initialized")
    const rebuilt = await command([...args, "update-index", "-z", "--index-info"], entries.bytes)
    requireValue(rebuilt.code === 0, "private index entries could not be restored")
    const capturedTree = await command([...args, "write-tree"], undefined, 41)
    requireValue(
      capturedTree.code === 0 && /^[0-9a-f]{40}\n$/.test(capturedTree.bytes.toString("ascii")),
      "the captured index tree is unavailable",
    )
    const manifest = await command(
      [
        ...args,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        "--unordered",
      ],
      undefined,
      INTEGRITY.output,
    )
    requireValue(manifest.code === 0, "the expanded object manifest is unavailable")
    objectManifest(manifest.bytes)
    await privateReferences(privateGit, capturedHead, startup)
    const integrity = await command(
      [
        ...args,
        "fsck",
        "--strict",
        "--full",
        "--cache",
        "--no-reflogs",
        "--no-dangling",
        "--no-progress",
        "--no-name-objects",
        // Since Git2.50 this separate PRIVATE ref-DB check forks. No live refs were imported, while snapshot_refs,
        // full object hashing/connectivity and the detached HEAD/index/shallow roots remain checked by fsck.
        ...(profile.references ? ["--no-references"] : []),
      ],
      undefined,
      INTEGRITY.output,
    )
    requireCommand(integrity, [0], "the private Git object graph failed integrity verification")
    let observedIndex = digest
    let observations = 0
    const unchanged = async (context: Operation) => {
      context.check()
      const after = (await read(gitHandle, "index", LIMIT.index, false, context))!
      const current = createHash("sha256").update(after).digest("hex")
      if (current !== observedIndex) {
        // Git status refreshes cached stat fields without changing staged content. Interpret changed bytes only
        // through a separate private index, pinned Git/runtime and the already-verified private object store.
        // The captured normalized index used by the review is never replaced or refreshed.
        requireValue(++observations <= LIMIT.files, "index observation count exceeds its bound")
        const candidate = path.join(temporary, `index-observation-${observations}`)
        await step(context, () => fs.writeFile(candidate, after, { mode: 0o600, flag: "wx" }))
        try {
          const staged = await commands.command(
            context,
            [...args, "ls-files", "--stage", "--sparse", "-z"],
            undefined,
            LIMIT.index,
            undefined,
            candidate,
          )
          requireValue(
            staged.code === 0 && staged.bytes.equals(entries.bytes),
            "original Git index content changed during inspection",
          )
          const tree = await commands.command(context, [...args, "write-tree"], undefined, 41, undefined, candidate)
          requireValue(
            tree.code === 0 && tree.bytes.equals(capturedTree.bytes),
            "original Git index tree changed during inspection",
          )
          context.check()
          observedIndex = current
        } finally {
          // The process has settled before removing its exact private file; cancellation cannot grant success.
          await fs.unlink(candidate).catch(() => {
            context.unsafe()
            throw new Unavailable("private index observation cleanup remains unconfirmed")
          })
        }
      }
      requireValue(
        (await head(gitHandle, commonHandle, undefined, context)) === capturedHead &&
          (await read(gitHandle, "HEAD", 4096, false, context))!.toString("utf8").trim() === capturedRef,
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
    const perform = async (operation: Read, context: Operation) => {
      context.check()
      const literal = (file: string) => ":(literal)" + relative(file)
      const diff = [
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ]
      const run = (query: string[], input?: Buffer) => commands.command(context, [...args, ...query], input)
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
          const snapshot = await step(context, () => fs.mkdtemp(path.join(temporary, "added-")))
          try {
            const opened = await openWithin(rootHandle, file, constants.O_RDONLY, false, context)
            try {
              await step(context, () =>
                fs.mkdir(path.dirname(path.join(snapshot, file)), { recursive: true, mode: 0o700 }),
              )
              await copyOpened(opened, path.join(snapshot, file), BigInt(LIMIT.index), context)
              return await commands.command(
                context,
                [...args, "diff", "--no-index", ...diff, "--unified=3", "--", os.devNull, file],
                undefined,
                LIMIT.index,
                snapshot,
              )
            } finally {
              await releaseResource(context, opened)
            }
          } finally {
            try {
              await fs.rm(snapshot, { recursive: true, force: true })
            } catch (error) {
              context.unsafe()
              throw error
            }
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
            "--threads=1",
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
    const safeRead = (operation: Read) => observe((context) => perform(operation, context))
    let statusQueue: Promise<unknown> = Promise.resolve()
    const status = (context: Operation) => {
      // Keep normalized index stat fields empty. A refreshed Git cache missed a real equal-size edit with restored
      // mtime in hosted qualification, despite a changed high-resolution ctime. Never let that cache grant clean status.
      // Serialize status observations; source index cache refreshes remain harmless through the semantic tree proof.
      const pending = statusQueue.then(async () => {
        context.check()
        await unchanged(context)
        const result = await commands.command(context, [
          ...args,
          "status",
          "--porcelain=v1",
          "-z",
          "--no-renames",
          "--untracked-files=all",
          "--ignore-submodules=all",
        ])
        requireValue(result.code === 0, "private worktree status could not be read")
        await unchanged(context)
        return { head: capturedHead, dirty: result.bytes.byteLength !== 0 }
      })
      statusQueue = pending.then(
        () => undefined,
        () => undefined,
      )
      return pending
    }
    await status(startup)
    startup.check()
    transferred = true
    return Object.defineProperty(
      {
        directory: root,
        gitDirectory: git,
        commonDirectory: common,
        commonIdentity,
        head: capturedHead,
        branch,
        shallow: !!shallow?.byteLength,
        isOpen: () => !closed && !controller.signal.aborted,
        status: () => observe(status),
        read: safeRead,
        close,
      },
      "isOpen",
      { writable: false, configurable: false },
    )
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
