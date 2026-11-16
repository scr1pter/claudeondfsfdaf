import fs from "node:fs"
import path from "node:path"
import { isMainThread } from "node:worker_threads"
import { LinuxIsolation } from "./process-isolation/linux"
import { LinuxIsolationBuild } from "./process-isolation/build"
import { ProcessIsolationRuntime } from "./process-isolation/runtime"

export const BINARY = "/usr/bin/bwrap"
export const REFUSAL = "The GitHub run cannot isolate its tool processes. The command is refused."
export const ENGINE_HOME = "/home/vector-agent"
export const ENGINE_PRIVATE_DIRECTORIES = Object.freeze([
  `${ENGINE_HOME}/.local/share/vector`,
  `${ENGINE_HOME}/.local/state/vector`,
  `${ENGINE_HOME}/.config/vector`,
  `${ENGINE_HOME}/.cache/vector`,
  `${ENGINE_HOME}/tmp/vector-agent`,
])
const ENGINE_CONTAINERS = ["/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox"]
/**
 * Build-time selection of the bubblewrap tool floor: each tool in a fresh user, PID, IPC and UTS namespace with its own
 * proc, and the engine under an empty proc. This build holds it off. GitHub's ubuntu-24.04 image refuses an unconfined,
 * unprivileged bwrap its user namespace, and a tool's nested bwrap cannot start under the engine's empty proc, so the
 * floor cannot run on a hosted runner as built (deviations, "V16 bubblewrap floor held"). Native isolation replaces it
 * before any hosted activation. There is no runtime, environment or configuration switch, and nothing lowers it.
 */
export const FLOOR: boolean = false
let enabled = false
const externalCode = new WeakSet<object>()
const guardedExternalCode = new WeakSet<object>()

/** Called once by the actual private-channel loader. There is deliberately no lowering/reset API. */
export function requireIsolation() {
  enabled = true
}

/**
 * Whether this process runs a hosted GitHub agent. The kernel path guard and the native loader refusal then apply to
 * every tool, whether or not the build has the bubblewrap floor.
 */
export function required() {
  return enabled
}

/** Immutable implementation selection only; private-channel authority still comes exclusively from its loader. */
export function nativeBuild() {
  return Object.freeze({ enabled: LinuxIsolationBuild.enabled, entrySHA: LinuxIsolationBuild.entrySHA })
}

function assertNativeCompartment() {
  // A Worker's module-local required flag cannot stand in for its holder's authority. Until a trusted bridge
  // exists, native CI builds refuse process creation in that compartment even when its local flag is false.
  if (LinuxIsolationBuild.enabled && !isMainThread) throw new LinuxIsolation.Unavailable()
}

export interface CommandOptions extends ProcessIsolationRuntime.Options {}
export interface CommandPlan {
  readonly file: string
  readonly args: readonly string[]
  readonly options: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean | string }>
  readonly isolation: "plain" | "legacy" | "native"
  readonly cancellation: "process-group" | "native-owner"
}

/** Additive only: the shared spawner is not migrated by this inactive Core foundation checkpoint. */
export function commandPlan(file: string, args: readonly string[], options: CommandOptions): CommandPlan {
  assertNativeCompartment()
  if (!required() || !LinuxIsolationBuild.enabled) {
    const selected = launch(file, args, options)
    return Object.freeze({
      file: selected.file,
      args: Object.freeze([...selected.args]),
      options: Object.freeze({ cwd: options.cwd, env: options.env, shell: selected.shell }),
      isolation: required() ? "legacy" : "plain",
      cancellation: "process-group",
    })
  }
  assertLoaderEnvironment(options.env ?? process.env)
  return ProcessIsolationRuntime.plan(LinuxIsolationBuild.entrySHA, file, args, options)
}

/** The actual private-channel loader makes this process-long authority monotonic; configuration cannot lower it. */
export function assertExternalCodeAllowed() {
  if (enabled) throw new Error("GitHub credential holders cannot load external executable modules.")
}

/** Restrictive provenance survives SDK/language caches; there is deliberately no unmark/reset operation. */
export function markExternalCode<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) externalCode.add(value)
  return value
}

export function isExternalCode(value: unknown) {
  return value !== null && (typeof value === "object" || typeof value === "function") && externalCode.has(value)
}

export function assertExternalValueAllowed(value: unknown) {
  if (isExternalCode(value)) assertExternalCodeAllowed()
}

/** Protect retained executable handles too, including metadata getters and methods captured before activation. */
export function guardExternalObject<T extends object>(value: T): T {
  if (!isExternalCode(value)) return value
  assertExternalCodeAllowed()
  if (guardedExternalCode.has(value)) return value
  // Snapshot the language handle's shape with guarded accessors. This also preserves Proxy invariants when a
  // consumer freezes the facade or the source model already has nonconfigurable methods/getters.
  const prototype = Reflect.getPrototypeOf(value)
  const target: T = Object.create(
    prototype === null || prototype === Object.prototype ? prototype : guardExternalObject(markExternalCode(prototype)),
  )
  const methods = new WeakMap<object, (...args: unknown[]) => unknown>()
  const read = (key: PropertyKey) => {
    assertExternalCodeAllowed()
    const item = Reflect.get(value, key, value)
    if (typeof item !== "function") return item
    const cached = methods.get(item)
    if (cached) return cached
    const method = (...args: unknown[]) => {
      assertExternalCodeAllowed()
      const result = Reflect.apply(item, value, args)
      assertExternalCodeAllowed()
      return result
    }
    methods.set(item, method)
    return method
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => read(key),
      ...(("value" in descriptor ? descriptor.writable : descriptor.set)
        ? {
            set(this: object, next: unknown) {
              assertExternalCodeAllowed()
              // A compiled fitted model derives from this facade; assigning its wrappers must not overwrite the SDK.
              if (this !== guarded) {
                Object.defineProperty(this, key, { configurable: true, enumerable: true, writable: true, value: next })
                return
              }
              if (!Reflect.set(value, key, next, value))
                throw new TypeError(`Cannot assign model property ${String(key)}`)
            },
          }
        : {}),
    })
  }
  const guarded = new Proxy(target, {
    get: (_target, key, receiver) => {
      assertExternalCodeAllowed()
      return Object.hasOwn(target, key) ? Reflect.get(target, key, receiver) : read(key)
    },
    has: (_target, key) => {
      assertExternalCodeAllowed()
      return Reflect.has(target, key)
    },
    ownKeys: () => {
      assertExternalCodeAllowed()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor: (_target, key) => {
      assertExternalCodeAllowed()
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    getPrototypeOf: () => {
      assertExternalCodeAllowed()
      return Reflect.getPrototypeOf(target)
    },
    set: (_target, key, next, receiver) => {
      assertExternalCodeAllowed()
      return Reflect.set(target, key, next, receiver)
    },
    deleteProperty: (_target, key) => {
      assertExternalCodeAllowed()
      return Reflect.deleteProperty(target, key)
    },
    defineProperty: (_target, key, descriptor) => {
      assertExternalCodeAllowed()
      return Reflect.defineProperty(target, key, descriptor)
    },
    setPrototypeOf: (_target, prototype) => {
      assertExternalCodeAllowed()
      return Reflect.setPrototypeOf(target, prototype)
    },
    isExtensible: () => {
      assertExternalCodeAllowed()
      return Reflect.isExtensible(target)
    },
    preventExtensions: () => {
      assertExternalCodeAllowed()
      return Reflect.preventExtensions(target)
    },
  })
  guardedExternalCode.add(guarded)
  return markExternalCode(guarded)
}

export function assertBinary() {
  if (process.platform !== "linux") throw new Error(REFUSAL)
  const info = fs.lstatSync(BINARY, { throwIfNoEntry: false })
  if (!info?.isFile() || info.uid !== 0 || info.mode & 0o022 || fs.realpathSync(BINARY) !== BINARY)
    throw new Error(REFUSAL)
}

export interface EngineScope {
  /** Both paths come from the hosted runner's verified private state, never a repository or tool request. */
  readonly cwd: string
  readonly container: string
  /** The runner's existing private 0600 regular file; the agent cannot reopen its pathname. */
  readonly proofFile?: string
}

/** Only the exact checkout and fixed agent-private data roots are writable; proc stays empty and read-only. */
export function engineArguments(file: string, args: readonly string[], scope: EngineScope) {
  const directories = engineWritableDirectories(scope)
  return [
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    ...directories.flatMap((directory) => ["--bind", directory, directory]),
    // Root opens FD3 after bwrap, then drops identity. This single file retains the runner's private DAC boundary.
    ...(scope.proofFile ? ["--bind", scope.proofFile, scope.proofFile] : []),
    // Ordinary binds are nodev; mount only bwrap's standard private devices, never the host /dev tree.
    "--dev",
    "/dev",
    "--tmpfs",
    "/proc",
    "--remount-ro",
    "/proc",
    // These capabilities exist only in the trusted root bridge before setpriv drops the UID and sets no-new-privs.
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--chdir",
    scope.cwd,
    "--",
    file,
    ...args,
  ]
}

export function engineWritableDirectories(scope: EngineScope) {
  if (
    !ENGINE_CONTAINERS.includes(scope.container) ||
    !path.posix.isAbsolute(scope.cwd) ||
    path.posix.normalize(scope.cwd) !== scope.cwd ||
    scope.cwd.includes("\0")
  )
    throw new Error(REFUSAL)
  const directories = [`${scope.container}/checkout`, ...ENGINE_PRIVATE_DIRECTORIES]
  if (scope.proofFile !== undefined) {
    const proof = scope.proofFile
    if (
      !path.posix.isAbsolute(proof) ||
      path.posix.normalize(proof) !== proof ||
      proof.includes("\0") ||
      path.posix.basename(proof) !== "session-proof.json" ||
      path.posix.basename(path.posix.dirname(proof)) !== "vector-sandbox" ||
      directories.some((directory) => proof === directory || proof.startsWith(directory + "/")) ||
      proof === ENGINE_HOME ||
      proof.startsWith(ENGINE_HOME + "/") ||
      KERNEL.some((prefix) => proof === prefix || proof.startsWith(prefix + "/"))
    )
      throw new Error(REFUSAL)
    if (process.platform === "linux") assertKernelPath(proof)
  }
  return directories
}

/** Neither the holder nor its interpreter may execute from a model-writable directory. */
export function assertEngineExecutable(file: string, scope: EngineScope) {
  if (!path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.includes("\0"))
    throw new Error(REFUSAL)
  if (engineWritableDirectories(scope).some((directory) => file === directory || file.startsWith(directory + "/")))
    throw new Error("The GitHub engine executable is inside a writable agent directory. The run is refused.")
}

export function argumentsForTool(file: string, args: readonly string[], cwd: string) {
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--bind",
    "/",
    "/",
    // Ordinary binds are nodev; mount only bwrap's standard private devices, never the host /dev tree.
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
    "--",
    file,
    ...args,
  ]
}

type LaunchOptions = { cwd?: string; shell?: boolean | string; env?: NodeJS.ProcessEnv }

export function launch(file: string, args: readonly string[], options: LaunchOptions = {}) {
  return decide(file, args, options, { guarded: required(), floor: FLOOR })
}

/** The launch decision for an explicit hosted guard and floor; `launch` passes this process's own. */
export function decide(
  file: string,
  args: readonly string[],
  options: LaunchOptions,
  boundary: { guarded: boolean; floor: boolean },
) {
  assertNativeCompartment()
  if (!boundary.guarded) return { file, args: [...args], shell: options.shell }
  // Native builds may only launch through a typed commandPlan with its single cancellation owner.
  if (LinuxIsolationBuild.enabled) throw new LinuxIsolation.Unavailable()
  assertLoaderEnvironment(options.env ?? process.env)
  // Hosted agents run on Linux only. Refusing elsewhere keeps every launcher, with or without the floor, in one rule.
  if (process.platform !== "linux") throw new Error(REFUSAL)
  if (!boundary.floor) return { file, args: [...args], shell: options.shell }
  assertBinary()
  const executable = typeof options.shell === "string" ? options.shell : options.shell ? "/bin/sh" : file
  const argv = options.shell ? ["-c", [file, ...args].join(" ")] : args
  return { file: BINARY, args: argumentsForTool(executable, argv, options.cwd ?? process.cwd()), shell: false }
}

const KERNEL = ["/proc", "/sys", "/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"]

/** Native loader hooks run before bwrap can enter its namespaces; configuration validation is not the final boundary. */
export function assertLoaderEnvironment(env: NodeJS.ProcessEnv) {
  if (
    Object.entries(env).some(
      ([name, value]) =>
        value !== undefined &&
        (/^(?:LD_|DYLD_)/.test(name) ||
          ["GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "LIBPATH", "SHLIB_PATH"].includes(name)),
    )
  )
    throw new Error("GitHub agent tools cannot set a native loader environment.")
}

/** Refuse kernel paths before a filesystem tool asks permission, including links that traverse a kernel alias. */
export function assertToolPath(target: string) {
  if (!required()) return
  assertKernelPath(target)
}

export function assertKernelPath(target: string) {
  let pending = (path.isAbsolute(target) ? target : process.cwd() + "/" + target).split("/").filter(Boolean)
  let current = "/"
  let links = 0
  while (pending.length) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") {
      current = path.dirname(current)
      continue
    }
    const candidate = path.join(current, part)
    if (KERNEL.some((prefix) => candidate === prefix || candidate.startsWith(prefix + "/")))
      throw new Error("GitHub agent tools cannot access kernel process files.")
    const info = fs.lstatSync(candidate, { throwIfNoEntry: false })
    if (!info?.isSymbolicLink()) {
      current = candidate
      continue
    }
    if (++links > 40) throw new Error("GitHub agent tools cannot resolve this file safely.")
    const link = fs.readlinkSync(candidate)
    pending = [
      ...(path.isAbsolute(link) ? link : path.dirname(candidate) + "/" + link).split("/").filter(Boolean),
      ...pending,
    ]
    current = "/"
  }
}

export * as ProcessIsolation from "./process-isolation"
