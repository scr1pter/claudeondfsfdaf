export * as LinuxIsolation from "./linux"

import path from "node:path"

// These paths describe an installed ABI, not a caller-selected executable or metadata source.
export const ABI = 1
export const ROOT = "/usr/libexec/vector-sandbox/v1"
export const ENTRY = `${ROOT}/entry.py`
export const SPEC = `${ROOT}/run.json`
export const PRIVATE = `${ROOT}/private/state.json`
export const PYTHON = "/usr/bin/python3"
// First supported native host: GitHubHosted Ubuntu24.04. No caller-selected temporary mount exists.
export const HOST_TEMP = "/home/runner/work/_temp"
export const MASKS = Object.freeze(["/home/vector-agent", "/tmp", "/var/tmp", "/run", HOST_TEMP] as const)
export const CONTAINERS = Object.freeze([
  "/mnt/vector-agent-sandbox",
  "/var/lib/vector-agent-sandbox",
  "/home/vector-agent-sandbox",
] as const)
export const LIMITS = Object.freeze({
  metadataBytes: 65_536,
  pathBytes: 4_096,
  args: 512,
  argBytes: 65_536,
  argvBytes: 262_144,
  environmentBytes: 262_144,
  startupMilliseconds: 5_000,
  stopMilliseconds: 2_000,
  requests: 256,
})
export const DESCRIPTORS = Object.freeze({
  closeFrom: 3,
  closeThrough: 0xffff_ffff,
  payload: Object.freeze([0, 1, 2] as const),
})
type Container = (typeof CONTAINERS)[number]
type Namespace = Readonly<{ user: number; mnt: number; pid: number }>
type ProcessIdentity = Readonly<{ pid: number; start: string }>
type DeviceInode = Readonly<{ device: number; inode: number }>
export interface PublicSpec {
  readonly v: 1
  readonly container: Container
  readonly uid: number
  readonly gid: number
  readonly stage: string
  readonly scratch: string
  readonly directory: string
  readonly socket: string
  readonly nonce: string
  readonly namespaces: Namespace
  readonly devices: Namespace
  readonly keeper: ProcessIdentity
  readonly broker: ProcessIdentity & Readonly<{ uid: 0; gid: 0 }>
  readonly socketIdentity: Readonly<{ device: number; inode: number }>
}
export interface MaskProof {
  readonly v: 2
  readonly sourceDigest: string
  readonly constructionNamespace: Readonly<{
    mount: DeviceInode
    parentMount: DeviceInode
    user: DeviceInode
    root: DeviceInode
  }>
  readonly keeperNamespace: DeviceInode
  readonly protectedMountTargets: readonly string[]
}

export class Unavailable extends Error {
  readonly code = "LINUX_ISOLATION_UNAVAILABLE"
  constructor() {
    super("The installed Linux tool boundary could not verify its fixed contract. The command is refused.")
  }
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Unavailable()
}
export function hostedTemporary(value: unknown) {
  requireValue(value === HOST_TEMP)
  return HOST_TEMP
}
/** Actual protected mount targets are evidence only; different-device nested mounts are equally unsupported. */
export function assertMaskMountTargets(value: unknown) {
  requireValue(Array.isArray(value) && value.length <= 64)
  const targets: readonly unknown[] = value
  for (const target of targets) {
    canonical(target)
    requireValue(!MASKS.some((parent) => target !== parent && target.startsWith(parent + "/")))
  }
  requireValue(MASKS.every((parent) => targets.includes(parent)))
}
/** Structural v2 evidence only; native code must prove the bound source closure and live visible masks. */
export function parseMaskProof(value: unknown, spec: PublicSpec): MaskProof {
  const publicSpec = parseSpec(spec)
  shape(value, ["v", "sourceDigest", "constructionNamespace", "keeperNamespace", "protectedMountTargets"])
  requireValue(value.v === 2 && typeof value.sourceDigest === "string" && /^[0-9a-f]{64}$/.test(value.sourceDigest))
  shape(value.constructionNamespace, ["mount", "parentMount", "user", "root"])
  const constructionNamespace = Object.freeze({
    mount: deviceInode(value.constructionNamespace.mount),
    parentMount: deviceInode(value.constructionNamespace.parentMount),
    user: deviceInode(value.constructionNamespace.user),
    root: deviceInode(value.constructionNamespace.root),
  })
  const keeperNamespace = deviceInode(value.keeperNamespace)
  requireValue(
    (constructionNamespace.mount.device !== constructionNamespace.parentMount.device ||
      constructionNamespace.mount.inode !== constructionNamespace.parentMount.inode) &&
      keeperNamespace.device === publicSpec.devices.mnt &&
      keeperNamespace.inode === publicSpec.namespaces.mnt &&
      (keeperNamespace.device !== constructionNamespace.mount.device ||
        keeperNamespace.inode !== constructionNamespace.mount.inode) &&
      (keeperNamespace.device !== constructionNamespace.parentMount.device ||
        keeperNamespace.inode !== constructionNamespace.parentMount.inode) &&
      (constructionNamespace.user.device !== publicSpec.devices.user ||
        constructionNamespace.user.inode !== publicSpec.namespaces.user),
  )
  requireValue(Array.isArray(value.protectedMountTargets) && value.protectedMountTargets.length <= 64)
  const protectedMountTargets = Array.from(value.protectedMountTargets, (target: unknown) => {
    canonical(target)
    requireValue(MASKS.some((parent) => target === parent || target.startsWith(parent + "/")))
    return target
  })
  requireValue(
    MASKS.every((parent) => protectedMountTargets.includes(parent)) &&
      protectedMountTargets.every(
        (target, index) => index === 0 || codepointBefore(protectedMountTargets[index - 1]!, target),
      ),
  )
  const proof = Object.freeze<MaskProof>({
    v: 2,
    sourceDigest: value.sourceDigest,
    constructionNamespace,
    keeperNamespace,
    protectedMountTargets: Object.freeze(protectedMountTargets),
  })
  requireValue(Buffer.byteLength(JSON.stringify(proof)) <= 32_768)
  return proof
}
/** An immutable engine/runtime placed under a hidden parent cannot be exposed as an exception. */
export function assertUnmaskedRuntime(value: string) {
  canonical(value)
  requireValue(!MASKS.some((parent) => value === parent || value.startsWith(parent + "/")))
}
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value))
  const found = Reflect.ownKeys(value)
  requireValue(found.length === keys.length && found.every((key) => typeof key === "string" && keys.includes(key)))
}
function integer(value: unknown): asserts value is number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
}
function canonical(value: unknown): asserts value is string {
  requireValue(
    typeof value === "string" &&
      value.isWellFormed() &&
      Buffer.byteLength(value) <= LIMITS.pathBytes &&
      path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      (value === "/" || !value.endsWith("/")) &&
      !/[\x00-\x1f\x7f]/.test(value),
  )
}
function deviceInode(value: unknown): DeviceInode {
  shape(value, ["device", "inode"])
  integer(value.device)
  integer(value.inode)
  return Object.freeze({ device: value.device, inode: value.inode })
}
function codepointBefore(left: string, right: string) {
  const candidate = right[Symbol.iterator]()
  for (const character of left) {
    const next = candidate.next()
    if (next.done) return false
    if (character !== next.value) return character.codePointAt(0)! < next.value.codePointAt(0)!
  }
  return !candidate.next().done
}
function identity(value: unknown): ProcessIdentity {
  shape(value, ["pid", "start"])
  integer(value.pid)
  requireValue(value.pid > 1 && typeof value.start === "string" && /^[1-9][0-9]{0,31}$/.test(value.start))
  return Object.freeze({ pid: value.pid, start: value.start })
}
function namespaces(value: unknown): Namespace {
  shape(value, ["user", "mnt", "pid"])
  integer(value.user)
  integer(value.mnt)
  integer(value.pid)
  return Object.freeze({ user: value.user, mnt: value.mnt, pid: value.pid })
}
function container(value: unknown): value is Container {
  return typeof value === "string" && CONTAINERS.some((candidate) => candidate === value)
}

/** Structural metadata validation only. The native bridge must independently prove root ownership and live identity. */
export function parseSpec(value: unknown): PublicSpec {
  shape(value, [
    "v",
    "container",
    "uid",
    "gid",
    "stage",
    "scratch",
    "directory",
    "socket",
    "nonce",
    "namespaces",
    "devices",
    "keeper",
    "broker",
    "socketIdentity",
  ])
  requireValue(value.v === ABI && container(value.container))
  integer(value.uid)
  integer(value.gid)
  canonical(value.stage)
  canonical(value.scratch)
  canonical(value.directory)
  canonical(value.socket)
  requireValue(
    value.stage === `${value.container}/checkout` &&
      value.scratch === `${value.container}/tool-scratch` &&
      value.directory === `${value.container}/tool-namespaces` &&
      value.socket === `${value.directory}/broker.sock` &&
      typeof value.nonce === "string" &&
      /^[0-9a-f]{32}$/.test(value.nonce),
  )
  const keeper = identity(value.keeper)
  shape(value.broker, ["pid", "start", "uid", "gid"])
  const broker = identity({ pid: value.broker.pid, start: value.broker.start })
  requireValue(value.broker.uid === 0 && value.broker.gid === 0 && keeper.pid !== broker.pid)
  shape(value.socketIdentity, ["device", "inode"])
  integer(value.socketIdentity.device)
  integer(value.socketIdentity.inode)
  return Object.freeze<PublicSpec>({
    v: ABI,
    container: value.container,
    uid: value.uid,
    gid: value.gid,
    stage: value.stage,
    scratch: value.scratch,
    directory: value.directory,
    socket: value.socket,
    nonce: value.nonce,
    namespaces: namespaces(value.namespaces),
    devices: namespaces(value.devices),
    keeper,
    broker: Object.freeze<PublicSpec["broker"]>({ ...broker, uid: 0, gid: 0 }),
    socketIdentity: Object.freeze({ device: value.socketIdentity.device, inode: value.socketIdentity.inode }),
  })
}

export function decodeSpec(bytes: Uint8Array): PublicSpec {
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= LIMITS.metadataBytes)
  try {
    return parseSpec(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  } catch {
    throw new Unavailable()
  }
}
function argument(value: string) {
  requireValue(
    typeof value === "string" &&
      value.isWellFormed() &&
      !value.includes("\0") &&
      Buffer.byteLength(value) <= LIMITS.argBytes,
  )
}
function loaderSafe(environment: Readonly<Record<string, string | undefined>>) {
  let bytes = 0
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    argument(name)
    argument(value)
    requireValue(
      name.length > 0 &&
        !name.includes("=") &&
        !/^(?:LD_|DYLD_)/.test(name) &&
        !["GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "LIBPATH", "SHLIB_PATH"].includes(name),
    )
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2
  }
  requireValue(bytes <= LIMITS.environmentBytes)
}

/** Pure ABI plan; it neither grants a scope nor installs/enables the production floor. */
export function planLaunch(
  file: string,
  args: readonly string[],
  options: {
    readonly platform: NodeJS.Platform
    /** The trusted spawning process's own PID, never a tool argument, environment value or public-spec field. */
    readonly parentPID: number
    readonly cwd: string
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly shell?: boolean | string
    readonly extraFDs?: readonly number[]
  },
  spec: PublicSpec,
) {
  requireValue(options.platform === "linux")
  integer(options.parentPID)
  requireValue(options.parentPID > 1)
  parseSpec(spec)
  canonical(options.cwd)
  requireValue(
    !["/proc", "/sys", "/dev"].some((prefix) => options.cwd === prefix || options.cwd.startsWith(prefix + "/")),
  )
  requireValue(!options.extraFDs?.length)
  requireValue(file.length > 0 && args.length <= LIMITS.args)
  const executable = typeof options.shell === "string" ? options.shell : options.shell ? "/bin/sh" : file
  const argv = options.shell ? ["-c", [file, ...args].join(" ")] : [...args]
  argument(executable)
  requireValue(executable.length > 0)
  for (const value of [file, ...args, ...argv]) argument(value)
  requireValue([executable, ...argv].reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0) <= LIMITS.argvBytes)
  loaderSafe(options.env ?? {})
  return Object.freeze({
    file: PYTHON,
    args: Object.freeze([
      "-I",
      "-S",
      ENTRY,
      "exec",
      "--parent",
      String(options.parentPID),
      "--cwd",
      options.cwd,
      "--",
      executable,
      ...argv,
    ]),
    shell: false as const,
    descriptors: DESCRIPTORS,
    startupBarrier: "outer-authorized-owned-pid-namespace-init" as const,
  })
}

export type Phase =
  | "recorded"
  | "keeper-ready"
  | "broker-pending"
  | "adopted"
  | "quiesced"
  | "uid-stopped"
  | "broker-stopped"
export interface Lifetime {
  readonly phase: Phase
  readonly cancelled: boolean
  readonly failed: boolean
}
export function recorded(): Lifetime {
  return Object.freeze<Lifetime>({ phase: "recorded", cancelled: false, failed: false })
}
export function advance(state: Lifetime, event: Phase | "cancel" | "failure"): Lifetime {
  if (event === "cancel" || event === "failure")
    return Object.freeze({
      ...state,
      cancelled: state.cancelled || event === "cancel",
      failed: state.failed || event === "failure",
    })
  const next: Record<Phase, Phase | undefined> = {
    recorded: "keeper-ready",
    "keeper-ready": "broker-pending",
    "broker-pending": "adopted",
    adopted: "quiesced",
    quiesced: "uid-stopped",
    "uid-stopped": "broker-stopped",
    "broker-stopped": undefined,
  }
  requireValue(next[state.phase] === event)
  return Object.freeze({ ...state, phase: event })
}
export function artifactsAllowed(state: Lifetime) {
  return state.phase === "broker-stopped" && !state.cancelled && !state.failed
}
export interface CommandLifetime {
  /** exec-authorized is the outer shim's masked decision after init ownership; later cancellation must stop/reap. */
  readonly phase: "created" | "guardian-owned" | "init-owned" | "exec-authorized" | "exec-released" | "reaped"
  readonly cancelled: boolean
}
export function commandCreated(): CommandLifetime {
  return Object.freeze<CommandLifetime>({ phase: "created", cancelled: false })
}
export function commandAdvance(state: CommandLifetime, event: CommandLifetime["phase"] | "cancel"): CommandLifetime {
  if (event === "cancel") return Object.freeze({ ...state, cancelled: true })
  requireValue(
    (event === "guardian-owned" && state.phase === "created") ||
      (event === "init-owned" && state.phase === "guardian-owned") ||
      (event === "exec-authorized" && state.phase === "init-owned" && !state.cancelled) ||
      (event === "exec-released" && state.phase === "exec-authorized") ||
      (event === "reaped" && state.phase !== "reaped"),
  )
  return Object.freeze({ ...state, phase: event })
}
