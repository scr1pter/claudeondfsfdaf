import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import type { GithubIsolation } from "../../src/cli/cmd/github.isolation"

/** CI-only immutable fixtures. None of these helpers is a production authorization or launcher service. */
export const ROOT = "/usr/libexec/vector-native-shell"
export const MANIFEST = `${ROOT}/manifest.json`
export const ENGINE = `${ROOT}/engine.mjs`
export const HOST = `${ROOT}/host.mjs`
export const PAYLOAD = `${ROOT}/payload.mjs`
export const PREFIX = "VECTOR_NATIVE_SHELL "
export const CASES = [
  "inspect",
  "nonzero",
  "timeout",
  "abort",
  "shell-pipeline",
  "stdio",
  "delayed",
  "pipeline",
  "fd-source",
  "fd-dest",
] as const
// Host witness refusal vocabulary. Each role reports only these fixed labels, closed case and operation names, an exit
// code and the failureMetadata control projection; never a message, path, stderr, argv or secret.
export const FAILURE_PREFIX = "VECTOR_NATIVE_SHELL_FAILURE "
export const OBSERVER_PREFIX = "VECTOR_NATIVE_SHELL_OBSERVER "
export const OBSERVER_OPERATIONS = [
  "controls",
  "register",
  "control",
  "kill-engine",
  "snapshot",
  "inspect",
  "ack",
  "hints",
  "counters",
] as const
export const RUN_OPERATIONS = ["install", "realpath", "stat", "id", "setpriv"] as const
export const RUN_SYSCALLS = ["open", "read", "lstat", "stat", "realpath", "scandir", "access", "mkdir"] as const
export const RUN_ERRNOS = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EROFS", "EEXIST", "EISDIR"] as const
// Exact copies of production messages; github.isolation.test.ts proves each one still exists verbatim.
export const RUN_REFUSALS = {
  "run-refused": "The GitHub agent sandbox could not verify its isolation or cleanup. The run is refused.",
  "run-adapter": "The trusted Linux runner adapter refused its fixed installation or lifetime contract.",
  "run-engine-executable": "The GitHub engine executable is inside a writable agent directory. The run is refused.",
} as const
const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>
// Closed exit classes of the host's failure-only runtime probe (runtimeProbe in native-shell-host.ts).
export const PROBE_EXITS = ["zero", "abort", "signal", "other", "error"] as const
export type ProbeExit = (typeof PROBE_EXITS)[number]
// `empty` is the production engine sandbox's own proc treatment (ProcessIsolation.engineArguments). `own` is the
// candidate engine segment, a private PID namespace with its own read-only procfs. Only the probe uses either; it
// starts a runtime with `-e 0` and never the engine.
export const PROBE_PROC = Object.freeze({
  empty: Object.freeze(["--tmpfs", "/proc", "--remount-ro", "/proc"] as const),
  own: Object.freeze(["--unshare-pid", "--proc", "/proc", "--remount-ro", "/proc"] as const),
})
export const SHELL_STAGES = Object.freeze({
  host: [
    "host-configuration",
    "host-environment",
    "host-controls",
    "host-driver-start",
    "host-engine-ready",
    "host-signal-control",
    "host-round-begin",
    "host-round-done",
    "host-engine-summary",
    "host-driver-exit",
    "host-protocol",
    "host-deadline",
    "host-close",
    "host-final-snapshot",
    "host-receipt",
  ] as const,
  observer: [
    "observer-start",
    "observer-operation",
    "observer-controls-hosted",
    "observer-controls-drop",
    "observer-controls-agent",
    "observer-controls-readonly",
    "observer-output",
  ] as const,
  driver: ["driver-channel", "driver-secrets", "driver-run"] as const,
  engine: ["engine-identity", "engine-setup", "engine-round", "engine-finish"] as const,
  run: [
    "run-refused",
    "run-adapter",
    "run-engine-executable",
    "run-isolation",
    "run-unavailable",
    ...RUN_OPERATIONS.map((name) => `run-operation-${name}` as const),
    ...RUN_SYSCALLS.flatMap((syscall) => RUN_ERRNOS.map((code) => `run-errno-${syscall}-${lower(code)}` as const)),
    "run-other",
  ],
  // The engine's own runtime under each proc treatment (25), then Node under the empty proc only (5).
  probe: [
    ...PROBE_EXITS.flatMap((empty) => PROBE_EXITS.map((own) => `probe-empty-${empty}-own-${own}` as const)),
    ...PROBE_EXITS.map((exit) => `probe-node-${exit}` as const),
  ],
})
export type ShellStage<K extends keyof typeof SHELL_STAGES> = (typeof SHELL_STAGES)[K][number]
export interface ShellFailure {
  host: ShellStage<"host">
  case: string | null
  operation: string | null
  observer: ShellStage<"observer"> | null
  driver: ShellStage<"driver"> | null
  run: ShellStage<"run"> | null
  driverExit: number | null
  probe: `probe-empty-${ProbeExit}-own-${ProbeExit}` | null
  probeNode: `probe-node-${ProbeExit}` | null
  engine: ShellStage<"engine"> | null
  engineCase: string | null
  control: GithubIsolation.FailureCause | null
}
export function shellStage<K extends keyof typeof SHELL_STAGES>(kind: K, value: unknown): value is ShellStage<K> {
  return typeof value === "string" && SHELL_STAGES[kind].some((item: string) => item === value)
}
export function shellCase(value: unknown) {
  return typeof value === "string" && [...CASES, "death"].some((item) => item === value)
}
/** The one fixed stage line Root's observer excepthook writes, or null for anything else. */
export function observerStage(stderr: unknown): ShellStage<"observer"> | null {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 4096) return null
  const lines = stderr.split("\n").filter((line) => line.startsWith(OBSERVER_PREFIX))
  if (lines.length !== 1) return null
  const stage = /^VECTOR_NATIVE_SHELL_OBSERVER \{"stage":"([a-z-]{1,64})"\}$/.exec(lines[0]!)?.[1]
  return shellStage("observer", stage) ? stage : null
}
/** Classify a sandbox run() error by its exact message or an allowlisted errno only. The message never leaves. */
export function runError(error: unknown, isolation: string): ShellStage<"run"> {
  if (error instanceof LinuxIsolation.Unavailable) return "run-unavailable"
  if (!(error instanceof Error)) return "run-other"
  const message = ownValue(error, "message")
  const refusal = Object.entries(RUN_REFUSALS).find((entry) => entry[1] === message)?.[0]
  if (shellStage("run", refusal)) return refusal
  if (message === isolation) return "run-isolation"
  const operation = `run-operation-${
    typeof message === "string"
      ? /^Sandbox operation ([a-z]{1,16}) (?:timed out|exited \d{1,3}|failed); the run is refused\.$/.exec(message)?.[1]
      : undefined
  }`
  if (shellStage("run", operation)) return operation
  const code = ownValue(error, "code")
  const syscall = ownValue(error, "syscall")
  const errno = `run-errno-${String(syscall)}-${String(code).toLowerCase()}`
  if (
    RUN_ERRNOS.some((item) => item === code) &&
    RUN_SYSCALLS.some((item) => item === syscall) &&
    shellStage("run", errno)
  )
    return errno
  return "run-other"
}
// Own data properties only: an accessor is never called.
function ownValue(error: Error, name: string): unknown {
  const property = Object.getOwnPropertyDescriptor(error, name)
  return property && Object.hasOwn(property, "value") ? property.value : undefined
}
/**
 * sudo's fixed argv for one probe start: the engine sandbox's bwrap groups with one of the two PROBE_PROC treatments,
 * then run()'s prlimit, setpriv and `env -i` chain, then a copied Root runtime evaluating `0`. policy.test.ts ties
 * these tokens to ProcessIsolation.engineArguments and to run() in github.sandbox.ts.
 */
export function probeArguments(proc: readonly string[], runtime: string, uid: number, gid: number) {
  need(proc === PROBE_PROC.empty || proc === PROBE_PROC.own)
  need(runtime === `${ROOT}/runtime/node` || runtime === `${ROOT}/runtime/bun`)
  need(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0)
  return [
    "-n",
    "/usr/bin/bwrap",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    ...proc,
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--chdir",
    "/",
    "--",
    "/usr/bin/prlimit",
    "--core=0:0",
    "--",
    "/usr/bin/setpriv",
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--no-new-privs",
    "--",
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    runtime,
    "-e",
    "0",
  ]
}
/**
 * Classify one probe start from its execFile outcome: undefined is success. bwrap reports a child's signal n as
 * 128 + n, so 134 is SIGABRT and 129-192 covers Linux signals 1-64, real-time signals included. A timeout kill, a
 * signal on sudo itself, a missing code or anything else is `error`.
 */
export function probeExit(error: unknown): ProbeExit {
  if (error === undefined) return "zero"
  if (!(error instanceof Error)) return "error"
  const code = ownValue(error, "code")
  const signal = ownValue(error, "signal")
  if (ownValue(error, "killed") === true || (signal !== undefined && signal !== null)) return "error"
  if (typeof code !== "number" || !Number.isInteger(code)) return "error"
  if (code === 134) return "abort"
  if (code >= 129 && code <= 192) return "signal"
  if (code >= 1 && code <= 255) return "other"
  return "error"
}
export function probeStage(empty: ProbeExit, own: ProbeExit) {
  return `probe-empty-${empty}-own-${own}` as const
}
export function probeNodeStage(exit: ProbeExit) {
  return `probe-node-${exit}` as const
}
/**
 * Re-encode only the closed witness fields as one bounded stderr line. If any other field fails its own validation,
 * the line carries the closed host stage alone, so a refusal always prints a label; without one it prints nothing.
 */
export function shellFailure(value: unknown): string | undefined {
  if (!plain(value) || !shellStage("host", value.host)) return
  const minimal = FAILURE_PREFIX + JSON.stringify({ v: 1, host: value.host }) + "\n"
  const nullable = (item: unknown, valid: (item: unknown) => boolean) => item === null || valid(item)
  const control = failureControl(value.control)
  if (
    !nullable(value.case, shellCase) ||
    !nullable(value.operation, (item) => OBSERVER_OPERATIONS.some((name) => name === item)) ||
    !nullable(value.observer, (item) => shellStage("observer", item)) ||
    !nullable(value.driver, (item) => shellStage("driver", item)) ||
    !nullable(value.run, (item) => shellStage("run", item)) ||
    !nullable(value.driverExit, (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255) ||
    !nullable(value.probe, (item) => shellStage("probe", item) && item.startsWith("probe-empty-")) ||
    !nullable(value.probeNode, (item) => shellStage("probe", item) && item.startsWith("probe-node-")) ||
    !nullable(value.engine, (item) => shellStage("engine", item)) ||
    !nullable(value.engineCase, shellCase) ||
    control === undefined
  )
    return minimal
  const text =
    FAILURE_PREFIX +
    JSON.stringify({
      v: 1,
      host: value.host,
      case: value.case,
      operation: value.operation,
      observer: value.observer,
      driver: value.driver,
      run: value.run,
      driverExit: value.driverExit,
      probe: value.probe,
      probeNode: value.probeNode,
      engine: value.engine,
      engineCase: value.engineCase,
      control,
    }) +
    "\n"
  return Buffer.byteLength(text) <= 4096 ? text : minimal
}
const RECORD_KEYS = ["v", "event", "origin", "operation", "stage", "class", "errno", "exit", "signal"] as const
// The host accepts a control projection only through GithubIsolation.failureMetadata. This second, structural pass
// rebuilds fixed keys whose values are bounded tokens, small integers or null, so free text cannot ride along. The
// 128-character token bound exceeds the longest FAILURE_STAGES label (86 characters, a keeper startup log label);
// github.isolation.test.ts carries every keeper startup label through this line.
function failureControl(value: unknown) {
  if (value === null) return null
  if (!plain(value) || !sameKeys(value, ["v", "event", "records"])) return
  if (value.v !== 1 || value.event !== "native-control-failure" || !Array.isArray(value.records)) return
  if (value.records.length < 1 || value.records.length > 4) return
  const records = value.records.map((row: unknown) => {
    if (!plain(row) || !sameKeys(row, RECORD_KEYS)) return
    const valid = RECORD_KEYS.every((key) => {
      const item = row[key]
      return (
        item === null ||
        (typeof item === "string" && /^[A-Za-z0-9-]{1,128}$/.test(item)) ||
        (Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)
      )
    })
    return valid ? Object.fromEntries(RECORD_KEYS.map((key) => [key, row[key]])) : undefined
  })
  if (!records.every((row) => row !== undefined)) return
  return { v: 1, event: "native-control-failure", records }
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function sameKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const found = Reflect.ownKeys(value)
  return found.length === keys.length && found.every((key) => typeof key === "string" && keys.includes(key))
}
export const ARTIFACT = Buffer.from("synthetic native-shell session ciphertext\n")
// Exact supporting outputs from the coherent fixture build; a new output requires an explicit reviewed update.
export const SUPPORT_ASSETS = Object.freeze([
  "ort-wasm-simd-threaded-r821n12y.wasm",
  "photon_rs_bg-bq08arze.wasm",
  "tree-sitter-3jzf13jk.wasm",
  "tree-sitter-bash-hq5s6fxb.wasm",
  "tree-sitter-powershell-ryb2ffqs.wasm",
])
export interface Asset {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
// The hosted temporary root stays a canary although only its runner home ancestor is a mask root.
export const CANARY_ROOTS = Object.freeze([
  ...LinuxIsolation.MASKS,
  LinuxIsolation.HOST_TEMP,
  "/home/vector-agent/.config/vector",
  "/home/vector-agent/.local/share/vector",
  "/home/vector-agent/.cache/vector",
  "/home/vector-agent/tmp/vector-agent",
])
export interface Manifest {
  readonly v: 1
  readonly nonce: string
  readonly runtime: "node" | "bun"
  readonly runtimePath: string
  readonly mode: "own-key" | "codium"
  readonly family: "baseline" | "engine-death"
  readonly observer: string
  readonly sourceRevision: string
  readonly fixtureSHA256: { readonly engine: string; readonly host: string; readonly payload: string }
  readonly assets: readonly Asset[]
}
export function need(value: unknown, message = "Native Shell fixture contract refused"): asserts value {
  if (!value) throw new Error(message)
}
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  need(plain(value) && sameKeys(value, keys))
}
export const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
export function decodeManifest(value: unknown): Manifest {
  exact(value, [
    "v",
    "nonce",
    "runtime",
    "runtimePath",
    "mode",
    "family",
    "observer",
    "sourceRevision",
    "fixtureSHA256",
    "assets",
  ])
  need(value.v === 1 && typeof value.nonce === "string" && /^[a-f0-9]{32}$/.test(value.nonce))
  need(value.runtime === "node" || value.runtime === "bun")
  need(value.mode === "own-key" || value.mode === "codium")
  need(value.family === "baseline" || value.family === "engine-death")
  need(typeof value.runtimePath === "string" && value.runtimePath === `${ROOT}/runtime/${value.runtime}`)
  need(
    typeof value.observer === "string" &&
      LinuxIsolation.CONTAINERS.some((parent) => value.observer === parent + "/native-shell-observer"),
  )
  need(typeof value.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(value.sourceRevision))
  exact(value.fixtureSHA256, ["engine", "host", "payload"])
  const hashes = value.fixtureSHA256
  need(typeof hashes.engine === "string" && /^[a-f0-9]{64}$/.test(hashes.engine))
  need(typeof hashes.host === "string" && /^[a-f0-9]{64}$/.test(hashes.host))
  need(typeof hashes.payload === "string" && /^[a-f0-9]{64}$/.test(hashes.payload))
  need(Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 32)
  const assets = value.assets.map((entry: unknown): Asset => {
    exact(entry, ["path", "bytes", "sha256"])
    need(
      typeof entry.path === "string" &&
        entry.path.length <= 256 &&
        entry.path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part)),
    )
    need(
      typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= 268_435_456,
    )
    need(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))
    return Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })
  })
  need(
    assets.every((entry, index) => index === 0 || assets[index - 1]!.path < entry.path) &&
      assets.reduce((sum, entry) => sum + entry.bytes, 0) <= 536_870_912,
  )
  const required = new Set([
    "engine.mjs",
    "host.mjs",
    "payload.mjs",
    "runtime/node",
    ...(value.runtime === "bun" ? ["runtime/bun"] : []),
    ...SUPPORT_ASSETS,
  ])
  need(assets.length === required.size && assets.every((entry) => required.has(entry.path)))
  need(
    assets.some((entry) => entry.path === "engine.mjs" && entry.sha256 === hashes.engine) &&
      assets.some((entry) => entry.path === "host.mjs" && entry.sha256 === hashes.host) &&
      assets.some((entry) => entry.path === "payload.mjs" && entry.sha256 === hashes.payload),
  )
  return Object.freeze({
    v: 1,
    nonce: value.nonce,
    runtime: value.runtime,
    runtimePath: value.runtimePath,
    mode: value.mode,
    family: value.family,
    observer: value.observer,
    sourceRevision: value.sourceRevision,
    fixtureSHA256: Object.freeze({ engine: hashes.engine, host: hashes.host, payload: hashes.payload }),
    assets: Object.freeze(assets),
  })
}
export async function boundedFile(name: string, limit: number) {
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    need(before.isFile() && before.nlink === 1n && before.size >= 0n && before.size <= BigInt(limit))
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const value = await file.read(bytes, size, bytes.length - size, size)
      if (value.bytesRead === 0) break
      size += value.bytesRead
    }
    const after = await file.stat({ bigint: true })
    need(
      BigInt(size) === before.size &&
        size <= limit &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        before.size === after.size &&
        before.uid === after.uid &&
        before.gid === after.gid &&
        before.mode === after.mode &&
        after.nlink === 1n,
    )
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}
export async function rootFile(name: string, limit: number) {
  await rootAncestry(name)
  const before = await fs.lstat(name, { bigint: true })
  need(
    before.isFile() && before.uid === 0n && before.gid === 0n && before.nlink === 1n && !(Number(before.mode) & 0o022),
  )
  const bytes = await boundedFile(name, limit)
  const after = await fs.lstat(name, { bigint: true })
  need(sameFile(before, after))
  return bytes
}
async function rootAncestry(name: string) {
  need(path.posix.isAbsolute(name) && path.posix.normalize(name) === name && (await fs.realpath(name)) === name)
  for (let parent = path.posix.dirname(name); ; parent = path.posix.dirname(parent)) {
    const info = await fs.lstat(parent)
    need(
      info.isDirectory() &&
        info.uid === 0 &&
        info.gid === 0 &&
        !(info.mode & 0o022) &&
        (await fs.realpath(parent)) === parent,
    )
    if (parent === "/") break
  }
}
const sameFile = (first: BigIntStats, second: BigIntStats) =>
  first.dev === second.dev &&
  first.ino === second.ino &&
  first.size === second.size &&
  first.mtimeNs === second.mtimeNs &&
  first.ctimeNs === second.ctimeNs &&
  first.mode === second.mode &&
  first.uid === second.uid &&
  first.gid === second.gid &&
  first.nlink === second.nlink

export async function verifyAssets(manifest: Manifest) {
  // The Root installer performs this before starting Host. Host/driver repeat before capture, then Engine
  // repeats after the actual global loader. Root-owned nonwritable ancestry excludes mutable package fallbacks.
  for (const asset of manifest.assets) {
    const name = `${ROOT}/${asset.path}`
    await rootAncestry(name)
    const linked = await fs.lstat(name, { bigint: true })
    const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat({ bigint: true })
      need(
        sameFile(linked, before) &&
          before.isFile() &&
          before.uid === 0n &&
          before.gid === 0n &&
          before.nlink === 1n &&
          !(Number(before.mode) & 0o022) &&
          before.size === BigInt(asset.bytes),
      )
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(65_536)
      let size = 0
      while (true) {
        const block = await file.read(buffer, 0, Math.min(buffer.length, asset.bytes - size + 1), size)
        if (block.bytesRead === 0) break
        size += block.bytesRead
        need(size <= asset.bytes)
        hash.update(buffer.subarray(0, block.bytesRead))
      }
      need(
        size === asset.bytes &&
          hash.digest("hex") === asset.sha256 &&
          sameFile(before, await file.stat({ bigint: true })) &&
          sameFile(before, await fs.lstat(name, { bigint: true })),
      )
    } finally {
      await file.close()
    }
  }
}
export const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
export const counters = (spec: LinuxIsolation.PublicSpec, manifest: Manifest) =>
  `${spec.stage}/.native-shell-${manifest.nonce}`
export function validCase(value: string) {
  need([...CASES, "death"].some((item) => item === value))
  return value
}
export async function acknowledgement(
  manifest: Manifest,
  name: string,
  phase: "baseline" | "release" | "abort" | "stopped" | "summary",
) {
  need(name === "engine" || [...CASES, "death"].some((item) => item === name))
  const target = `${manifest.observer}/${name}-${phase}.ack`
  const deadline = Date.now() + 5_000
  while (true) {
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (info) {
      // Root is unmapped in the nested payload. The mapped agent must never own/write an acknowledgement.
      need(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          info.size === 0 &&
          !(info.mode & 0o022) &&
          info.uid !== process.getuid?.() &&
          (await fs.realpath(target)) === target,
      )
      return
    }
    need(Date.now() < deadline, "Missing fixed host acknowledgement")
    await setTimeout(10)
  }
}

async function main() {
  need(process.platform === "linux" && process.getuid?.() === 1000 && process.getgid?.() === 1000)
  need(process.argv.length === 4)
  const mode = process.argv[2]
  const name = validCase(process.argv[3]!)
  need(
    mode !== undefined &&
      [
        "inspect",
        "nonzero",
        "timeout",
        "abort",
        "death",
        "stdio",
        "delayed",
        "pipe-source",
        "pipe-sink",
        "daemon",
      ].includes(mode),
  )
  // Public metadata is data here; only the external host supplies verdicts/Root authority.
  const manifest = decodeManifest(json(await boundedFile(MANIFEST, 16_384)))
  const spec = LinuxIsolation.decodeSpec(await boundedFile(LinuxIsolation.SPEC, 65_536))
  need(manifest.nonce === spec.nonce && manifest.observer === spec.container + "/native-shell-observer")
  const directory = counters(spec, manifest)
  const prefix = `${directory}/${name}-${mode}`
  await fs.writeFile(prefix + ".count", "1\n", { mode: 0o600, flag: "wx" })
  const namespaces = Object.fromEntries(
    await Promise.all(
      ["user", "mnt", "pid"].map(async (kind) => {
        const info = await fs.stat(`/proc/self/ns/${kind}`, { bigint: true })
        return [kind, { device: String(info.dev), inode: String(info.ino) }]
      }),
    ),
  )
  const ready = {
    v: 1,
    case: name,
    mode,
    pid: process.pid,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    namespaces,
  }
  await fs.writeFile(prefix + ".tmp", JSON.stringify(ready) + "\n", { mode: 0o600, flag: "wx" })
  await fs.rename(prefix + ".tmp", prefix + ".json")
  if (mode === "daemon") {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {})
    setInterval(() => {}, 1000)
    return
  }
  if (["timeout", "abort", "death"].includes(mode)) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {})
    const daemon = spawn("/usr/bin/setsid", [manifest.runtimePath, PAYLOAD, "daemon", name], {
      stdio: "ignore",
      env: process.env,
    })
    daemon.once("error", () => {
      process.exitCode = 125
    })
    setInterval(() => {}, 1000)
    return
  }
  await acknowledgement(manifest, name, "release")
  if (mode === "pipe-source") {
    process.stdout.write("native-pipeline-input\n")
    return
  }
  if (mode === "delayed") {
    process.stdout.write("d".repeat(4096))
    return
  }
  if (mode === "stdio" || mode === "pipe-sink") {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const block = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += block.length
      need(bytes <= 1_048_576)
      chunks.push(block)
    }
    const input = Buffer.concat(chunks)
    process.stdout.write(Buffer.concat([Buffer.from("OUT:"), input]))
    process.stderr.write(`ERR:${digest(input)}\n`)
    return
  }
  if (mode === "nonzero") {
    process.stdout.write("native-nonzero-stdout\n")
    process.stderr.write("native-nonzero-stderr\n")
    process.exitCode = 17
    return
  }
  need(mode === "inspect")
  const status = await fs.readFile("/proc/self/status", "utf8")
  need(/^Groups:\s*$/m.test(status) && /^NoNewPrivs:\s+1\s*$/m.test(status))
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    need(new RegExp(`^${field}:\\s+0+\\s*$`, "m").test(status))
  for (const variable of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "VECTOR_CLI_TOKEN",
    "DEEPSEEK_KEY",
    "VECTOR_GITHUB_SESSION_PROOF",
    "VECTOR_GITHUB_TOOL_PID_NAMESPACE",
  ])
    need(process.env[variable] === undefined)
  const parent: unknown = json(await boundedFile(`${directory}/engine.json`, 4096))
  exact(parent, ["pid"])
  need(typeof parent.pid === "number" && Number.isSafeInteger(parent.pid) && parent.pid > 1)
  let signaled = false
  try {
    process.kill(parent.pid, "SIGUSR2")
    signaled = true
  } catch (error) {
    need(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))
  }
  need(!signaled)
  const targets = CANARY_ROOTS.flatMap((root) =>
    [root, "/proc/self/root" + root, "/proc/1/root" + root].map(
      (alias) => `${alias}/native-shell-canary-${manifest.nonce}`,
    ),
  )
  targets.push(
    `/var/run/native-shell-canary-${manifest.nonce}`,
    `${spec.stage}/native-shell-canary-link`,
    `/proc/${parent.pid}/cmdline`,
  )
  // Beneath the runner home only the empty mask may answer, through the command's own root as well: EACCES there
  // would mean host DAC hid the canary instead. Only the /proc/1/root alias may also be refused by permission.
  const hosted = [LinuxIsolation.RUNNER_HOME, "/proc/self/root" + LinuxIsolation.RUNNER_HOME]
  for (const target of targets) {
    let visible = false
    try {
      await fs.readFile(target)
      visible = true
    } catch (error) {
      need(
        error instanceof Error &&
          "code" in error &&
          (hosted.some((root) => target.startsWith(root + "/"))
            ? error.code === "ENOENT"
            : ["ENOENT", "EACCES", "ESRCH", "EPERM"].includes(String(error.code))),
      )
    }
    need(!visible)
  }
  for (const base of LinuxIsolation.MASKS) {
    for (const alias of [base, "/proc/self/root" + base, "/proc/1/root" + base]) {
      let readonly = false
      try {
        await fs.writeFile(`${alias}/native-shell-write-${manifest.nonce}`, "denied", { flag: "wx" })
      } catch (error) {
        readonly = error instanceof Error && "code" in error && error.code === "EROFS"
      }
      need(readonly)
    }
  }
  // The hidden hosted temporary root cannot be rebuilt inside the empty read-only runner home mask.
  for (const alias of [
    path.dirname(LinuxIsolation.HOST_TEMP),
    "/proc/self/root" + path.dirname(LinuxIsolation.HOST_TEMP),
  ]) {
    let readonly = false
    try {
      await fs.mkdir(alias)
    } catch (error) {
      readonly = error instanceof Error && "code" in error && error.code === "EROFS"
    }
    need(readonly)
  }
  const trusted = `${ROOT}/readonly-control.txt`
  let immutable = false
  try {
    await fs.writeFile(trusted, "denied")
  } catch (error) {
    immutable = error instanceof Error && "code" in error && error.code === "EROFS"
  }
  need(immutable)
  need(
    process.env.HOME === process.env.TMPDIR &&
      process.env.TMPDIR === process.env.RUNNER_TEMP &&
      typeof process.env.TMPDIR === "string" &&
      process.env.TMPDIR.startsWith(spec.scratch + "/"),
  )
  for (const root of [spec.stage, process.env.TMPDIR]) {
    const file = `${root}/native-shell-writable-${manifest.nonce}`
    await fs.writeFile(file, "writable\n", { flag: "wx", mode: 0o600 })
    need((await fs.readFile(file, "utf8")) === "writable\n")
    await fs.unlink(file)
  }
  process.stdout.write("native-inspect-stdout\n")
  process.stderr.write("native-inspect-stderr\n")
}

// The other two fixture bundles import only these shared pure/bounded helpers; they never run the payload role.
if (process.argv[1] === PAYLOAD)
  void main().catch(() => {
    process.stderr.write("Native Shell payload refused\n")
    process.exitCode = 125
  })
