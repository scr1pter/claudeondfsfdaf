import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { LinuxIsolationBuild } from "@vectordevai/core/process-isolation/build"
import { GithubIsolationBuild } from "./github.isolation-build"

// Only Root's exact-module build plugin replaces the inactive source stub. No ambient global/env lookup exists.

export const PROFILE_PATH = "/etc/apparmor.d/vector-sandbox-v1"
export const PROFILE = `abi <abi/4.0>,
profile vector-sandbox-v1 flags=(attach_disconnected,mediate_deleted) {
  file,
  network,
  unix,
  signal,
  ptrace,
  capability setuid,
  capability setgid,
  capability setpcap,
  capability setfcap,
  capability dac_override,
  capability sys_admin,
  capability sys_chroot,
  mount,
  umount,
  pivot_root,
  userns,
}
`
const PROFILE_SHA = digest(PROFILE)
const PARENTS = ["/", "/usr", "/usr/libexec", "/etc", "/etc/apparmor.d"] as const
const BASE = "/usr/libexec/vector-sandbox"
const REFUSAL = "The trusted Linux runner adapter refused its fixed installation or lifetime contract."
const FAILURE_PREFIX = "VECTOR_NATIVE_CONTROL_FAILURE "
const OPERATIONS = ["install", "prepare", "inspect", "cleanup", "unknown"] as const
const FAILURE_CLASSES = [
  "RuntimeError",
  "PermissionError",
  "FileNotFoundError",
  "ProcessLookupError",
  "NotADirectoryError",
  "FileExistsError",
  "BlockingIOError",
  "OSError",
  "ValueError",
  "KeyError",
  "IndexError",
  "TypeError",
  "AssertionError",
  "TimeoutExpired",
  "TimeoutError",
  "CalledProcessError",
  "JSONDecodeError",
  "UnicodeDecodeError",
  "BrokenPipeError",
  "EOFError",
  "OverflowError",
  "SpawnError",
  "IOError",
  "OutputBound",
  "ChildExit",
  "DecodeError",
  "Unknown",
] as const
const FAILURE_ERRNOS = [
  "EPERM",
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EEXIST",
  "EBUSY",
  "EAGAIN",
  "EINVAL",
  "EBADF",
  "ESRCH",
  "EPIPE",
  "ETIMEDOUT",
  "ENOSYS",
  "EOPNOTSUPP",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
  "EROFS",
  "EOVERFLOW",
  "EIO",
  "ENOSPC",
] as const
const FAILURE_SIGNALS = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGSEGV",
  "SIGPIPE",
  "SIGTERM",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGSYS",
] as const
const FAILURE_STAGES = {
  entry: [
    "entry-start",
    "prepare-construction-input",
    "prepare-construction-private",
    "prepare-input",
    "prepare-masks",
    "prepare-mask-os-chain",
    "prepare-mask-os-open",
    "prepare-mask-os-stat",
    "prepare-mask-os-read",
    "prepare-mask-os-decode",
    "prepare-mask-os-version",
    "prepare-mask-runner-lookup",
    "prepare-mask-runner-identity",
    "prepare-mask-mount-table",
    "prepare-mask-origins",
    "prepare-mask-aliases",
    // The fixed mask/step product carries no path or host metadata. Keep it aligned with entry.py.
    ...["home", "tmp", "var-tmp", "run", "host-temp"].flatMap((mask) => [
      ...[
        "target-stat",
        "target-type",
        "target-canonical",
        "target-owner",
        "parent-stat",
        "parent-type",
        "parent-owner",
        "parent-mode",
        "parent-canonical",
        "mount-present",
        "mount-device",
      ].map((step) => `prepare-mask-${mask}-${step}`),
      ...(mask === "home" || mask === "host-temp" ? [`prepare-mask-${mask}-target-mode`] : []),
    ]),
    "prepare-images",
    "prepare-record",
    "prepare-keeper-start",
    "prepare-keeper-wait",
    "prepare-keeper-child-exit",
    "prepare-keeper-timeout",
    "prepare-keeper-ready-record",
    ...["child-exit", "timeout"].flatMap((outcome) =>
      ["identity", "capabilities", "environment", "ready-write"].map((phase) => `prepare-keeper-${outcome}-${phase}`),
    ),
    "prepare-keeper-identity",
    "prepare-namespaces",
    "prepare-mounts",
    "prepare-mask-proof",
    "prepare-endpoint",
    "prepare-broker-start",
    "prepare-broker-ready",
    "prepare-broker-adopt",
    "prepare-broker-mask-proof",
    "prepare-publish",
    "cleanup-input",
    "cleanup-quiesce",
    "cleanup-uid-stop",
    "cleanup-broker-stop",
    "cleanup-images",
    "cleanup-proof",
    "cleanup-receipt",
  ],
  control: [
    "control-start",
    "control-input",
    "control-parents",
    "control-executables",
    "install-input",
    "install-files",
    "control-lock",
    "control-receipt",
    "control-files",
    "policy-load",
    "policy-proof",
    "native-prepare",
    "native-state",
    "native-public",
    "live-processes",
    "live-namespaces",
    "live-endpoint",
    "live-client",
    "live-final",
    "native-cleanup",
    "cleanup-receipt",
    "cleanup-state",
    "control-output",
  ],
  client: [
    "client-start",
    "client-input",
    "client-source",
    "client-request",
    "client-masks",
    "client-capabilities",
    "client-identity",
    "client-admission",
    "client-close",
    "client-output",
  ],
  transport: ["spawn", "stdin", "timeout", "stdout-bound", "stderr-bound", "close", "decode"],
} as const
export interface FailureRecord {
  readonly v: 1
  readonly event: "native-control-failure"
  readonly origin: keyof typeof FAILURE_STAGES
  readonly operation: (typeof OPERATIONS)[number]
  readonly stage: string
  readonly class: (typeof FAILURE_CLASSES)[number]
  readonly errno: (typeof FAILURE_ERRNOS)[number] | null
  readonly exit: number | null
  readonly signal: (typeof FAILURE_SIGNALS)[number] | null
}
export interface FailureCause {
  readonly v: 1
  readonly event: "native-control-failure"
  readonly records: readonly FailureRecord[]
}
function member<const T extends readonly string[]>(items: T, value: unknown): value is T[number] {
  return typeof value === "string" && items.some((item) => item === value)
}
function failureObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function failureData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!failureObject(value)) return
  const names = Reflect.ownKeys(value)
  if (names.length !== keys.length || !names.every((name) => typeof name === "string" && keys.includes(name))) return
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return
    // Create own data slots, so neither a source getter nor an inherited setter can participate in projection.
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
  }
  return result
}
function failureArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return
  const descriptor = Object.getOwnPropertyDescriptor(value, "length")
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return
  const length: unknown = descriptor.value
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 4) return
  const names = Reflect.ownKeys(value)
  if (
    names.length !== length + 1 ||
    !names.every(
      (name) => name === "length" || (typeof name === "string" && /^(0|[1-3])$/.test(name) && Number(name) < length),
    )
  )
    return
  const result: unknown[] = []
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    if (!item || !Object.hasOwn(item, "value")) return
    result.push(item.value)
  }
  return result
}
function failureRecord(value: unknown): FailureRecord | undefined {
  const keys = ["v", "event", "origin", "operation", "stage", "class", "errno", "exit", "signal"]
  const row = failureData(value, keys)
  if (!row) return
  if (
    row.v !== 1 ||
    row.event !== "native-control-failure" ||
    !member(["entry", "control", "client", "transport"] as const, row.origin) ||
    !member(OPERATIONS, row.operation) ||
    !member(FAILURE_STAGES[row.origin], row.stage) ||
    !member(FAILURE_CLASSES, row.class) ||
    (row.errno !== null && !member(FAILURE_ERRNOS, row.errno)) ||
    (row.exit !== null &&
      (typeof row.exit !== "number" || !Number.isInteger(row.exit) || row.exit < 0 || row.exit > 255)) ||
    (row.signal !== null && !member(FAILURE_SIGNALS, row.signal))
  )
    return
  return {
    v: 1,
    event: "native-control-failure",
    origin: row.origin,
    operation: row.operation,
    stage: row.stage,
    class: row.class,
    errno: row.errno,
    exit: row.exit,
    signal: row.signal,
  }
}
/** Passive error metadata only. Unrecognized bytes/fields are never forwarded and never change admission. */
export function decodeFailureRecords(
  bytes: Uint8Array,
  operation: (typeof OPERATIONS)[number],
): readonly FailureRecord[] {
  if (bytes.byteLength > 4096) return []
  try {
    const result: FailureRecord[] = []
    for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")) {
      if (!line.startsWith(FAILURE_PREFIX)) continue
      const row = failureRecord(JSON.parse(line.slice(FAILURE_PREFIX.length)))
      if (
        !row ||
        row.origin === "transport" ||
        row.operation !== operation ||
        result.some((previous) => previous.origin === row.origin) ||
        result.length >= 3
      )
        return []
      result.push(row)
    }
    return result
  } catch {
    return []
  }
}
/** Project only the bounded, exact error cause; never expose message/stack/argv from an arbitrary exception. */
export function failureMetadata(error: unknown): FailureCause | undefined {
  try {
    if (!(error instanceof Error)) return
    const property = Object.getOwnPropertyDescriptor(error, "cause")
    if (!property || !Object.hasOwn(property, "value")) return
    const cause: unknown = property.value
    const value = failureData(cause, ["v", "event", "records"])
    if (!value || value.v !== 1 || value.event !== "native-control-failure") return
    const rows = failureArray(value.records)
    if (!rows) return
    const checked: FailureRecord[] = [],
      origins = new Set<FailureRecord["origin"]>()
    for (let index = 0; index < rows.length; index++) {
      const row = failureRecord(rows[index])
      if (
        !row ||
        (index === 0 && row.origin !== "transport") ||
        origins.has(row.origin) ||
        (index > 0 && row.operation !== checked[0].operation)
      )
        return
      origins.add(row.origin)
      checked.push(row)
    }
    return { v: 1, event: "native-control-failure", records: checked }
  } catch {
    return
  }
}

export interface Asset {
  readonly v: 1
  readonly entry: string
  readonly sha256: string
}
export interface Scope {
  readonly container: string
  readonly uid: number
  readonly gid: number
}
export interface State extends Scope {
  readonly v: 1
  readonly phase: "intent" | "ready"
  readonly installNonce: string
  readonly assetSHA: string
  readonly namespaceNonce?: string
}
export interface Metadata {
  readonly kind: "directory" | "file" | "other"
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly canonical: string
  readonly nlink: number
  readonly sha256?: string
}
export interface Invocation {
  readonly file: "/usr/bin/sudo"
  readonly args: readonly string[]
  readonly input: string
  readonly timeout: number
  readonly maxOutput: number
  readonly env: Readonly<Record<string, string>>
}
export interface Ports {
  readonly temporary: string
  readonly asset: Asset
  readonly inspect: (name: string) => Promise<Metadata | undefined>
  readonly execute: (invocation: Invocation) => Promise<string>
  readonly nonce: () => string
}

function refused(): never {
  throw new Error(REFUSAL)
}
function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused()
  const found = Reflect.ownKeys(value)
  if (found.length !== keys.length || found.some((key) => typeof key !== "string" || !keys.includes(key))) refused()
}
function hex(value: unknown, size: number): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${size}}$`).test(value)) refused()
}
function scope(value: Scope) {
  if (!LinuxIsolation.CONTAINERS.some((container) => container === value.container)) refused()
  for (const id of [value.uid, value.gid]) if (!Number.isSafeInteger(id) || id <= 0 || id > 0x7fff_ffff) refused()
}
export function parseState(value: unknown): State {
  const keys = ["v", "phase", "container", "uid", "gid", "installNonce", "assetSHA"]
  if (value && typeof value === "object" && "phase" in value && value.phase === "ready") keys.push("namespaceNonce")
  exact(value, keys)
  if (value.v !== 1 || (value.phase !== "intent" && value.phase !== "ready")) refused()
  if (typeof value.container !== "string" || typeof value.uid !== "number" || typeof value.gid !== "number") refused()
  scope({ container: value.container, uid: value.uid, gid: value.gid })
  hex(value.installNonce, 32)
  hex(value.assetSHA, 64)
  const namespaceNonce = value.phase === "ready" ? value.namespaceNonce : undefined
  if (value.phase === "ready") hex(namespaceNonce, 32)
  return Object.freeze<State>({
    v: 1,
    phase: value.phase,
    container: value.container,
    uid: value.uid,
    gid: value.gid,
    installNonce: value.installNonce,
    assetSHA: value.assetSHA,
    ...(typeof namespaceNonce === "string" ? { namespaceNonce } : {}),
  })
}
export function validState(value: unknown) {
  try {
    parseState(value)
    return true
  } catch {
    return false
  }
}

// These enum-only hooks never format an exception message, traceback, argv, environment or metadata body.
const FAILURE_PYTHON =
  `DIAGNOSTIC_CLASSES = ${JSON.stringify(FAILURE_CLASSES)}\nDIAGNOSTIC_ERRNOS = ${JSON.stringify(FAILURE_ERRNOS)}\n` +
  String.raw`
import errno, json, sys
DIAGNOSTIC_ORIGIN = "control"
DIAGNOSTIC_OPERATION = "unknown"
DIAGNOSTIC_STAGE = "control-start"
def diagnostic_failure(kind, error, trace):
    try:
        name = type(error).__name__
        number = getattr(error,"errno",None)
        code = errno.errorcode.get(number) if type(number) is int else None
        result = getattr(error,"returncode",None)
        signals = {1:"SIGHUP",2:"SIGINT",3:"SIGQUIT",4:"SIGILL",6:"SIGABRT",7:"SIGBUS",8:"SIGFPE",9:"SIGKILL",
                   11:"SIGSEGV",13:"SIGPIPE",15:"SIGTERM",24:"SIGXCPU",25:"SIGXFSZ",31:"SIGSYS"}
        value = {"v":1,"event":"native-control-failure","origin":DIAGNOSTIC_ORIGIN,
                 "operation":DIAGNOSTIC_OPERATION if DIAGNOSTIC_OPERATION in ("install","prepare","inspect","cleanup") else "unknown",
                 "stage":DIAGNOSTIC_STAGE,"class":name if name in DIAGNOSTIC_CLASSES else "Unknown",
                 "errno":code if code in DIAGNOSTIC_ERRNOS else None,
                 "exit":result if type(result) is int and 0 <= result <= 255 else None,
                 "signal":signals.get(-result) if type(result) is int and result < 0 else None}
        encoded = "VECTOR_NATIVE_CONTROL_FAILURE " + json.dumps(value,separators=(",",":")) + "\n"
        if len(encoded.encode("ascii")) <= 1024: sys.stderr.write(encoded); sys.stderr.flush()
    except BaseException: pass
sys.excepthook = diagnostic_failure
`

// Fixed root control program. The sole stdin payload is the build-embedded asset; command paths are never inputs.
// Its lock is held across prepare/inspect/cleanup. A busy/missing/partial owner refuses, never adopts or retries.
const CONTROL =
  `PROFILE = ${JSON.stringify(PROFILE)}\n` +
  FAILURE_PYTHON +
  String.raw`
import array, fcntl, hashlib, json, os, pathlib, select, stat, subprocess, sys
ROOT = "/usr/libexec/vector-sandbox/v1"
BASE = "/usr/libexec/vector-sandbox"
ENTRY = ROOT + "/entry.py"
PRIVATE = ROOT + "/private"
INSTALL = PRIVATE + "/install.json"
LOCK = PRIVATE + "/install.lock"
POLICY = "/etc/apparmor.d/vector-sandbox-v1"
PROFILES = "/sys/kernel/security/apparmor/profiles"
ENV = {"PATH":"/usr/bin:/bin","LC_ALL":"C"}
def need(ok):
    if not ok: raise RuntimeError("Fixed runner control refused")
def sha(data): return hashlib.sha256(data).hexdigest()
def secure(name, mode, directory=False):
    item = os.lstat(name)
    need(os.path.realpath(name) == name and item.st_uid == item.st_gid == 0 and stat.S_IMODE(item.st_mode) == mode)
    need(stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode) and item.st_nlink == 1)
    for parent in pathlib.Path(name).parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and
             os.path.realpath(parent) == str(parent))
    return item
def read(name, mode, limit):
    secure(name, mode)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1 and
             stat.S_IMODE(info.st_mode) == mode and info.st_size <= limit)
        data = os.read(fd, limit + 1)
        need(len(data) == info.st_size and len(data) <= limit)
        return data
    finally: os.close(fd)
def write(name, data, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally: os.close(fd)
def record(value, first=False):
    data = json.dumps(value,separators=(",",":")).encode("ascii")
    if first: write(INSTALL, data, 0o600); return
    temporary = PRIVATE + "/install-" + os.urandom(16).hex() + ".tmp"
    write(temporary, data, 0o600)
    os.replace(temporary, INSTALL)
def loaded():
    with open(PROFILES,"rb") as stream: data = stream.read(1048577)
    need(len(data) <= 1048576)
    return [line for line in data.decode("ascii","strict").splitlines() if line.startswith("vector-sandbox-v1 ")]
def executable(name):
    resolved = os.path.realpath(name)
    need(resolved.startswith("/usr/") and not resolved.startswith(("/usr/local/","/usr/libexec/vector-sandbox/")))
    item = os.lstat(resolved)
    need(stat.S_ISREG(item.st_mode) and item.st_uid == item.st_gid == 0 and not item.st_mode & 0o022 and
         item.st_mode & 0o111)
    secure(resolved,stat.S_IMODE(item.st_mode))
    return resolved
def native_state():
    value = json.loads(read(PRIVATE + "/state.json", 0o600, 65536).decode("utf-8","strict"))
    public = value["public"]
    need(public["uid"] == uid and public["gid"] == gid and public["container"] == container and
         public["stage"] == container + "/checkout" and public["scratch"] == container + "/tool-scratch" and
         public["directory"] == container + "/tool-namespaces" and
         public["socket"] == container + "/tool-namespaces/broker.sock")
    return value
# A separate fixed, secret-free client runs as the disposable agent, because the broker intentionally refuses Root.
# It compiles only digest-verified production source bytes, closes every received handle, and never enters it.
CLIENT = r'''` +
  FAILURE_PYTHON +
  String.raw`
DIAGNOSTIC_ORIGIN = "client"
DIAGNOSTIC_STAGE = "client-start"
import ctypes, errno, hashlib, json, os, pathlib, stat, sys
from types import SimpleNamespace
sys.dont_write_bytecode = True
def need(ok):
    if not ok: raise RuntimeError("Fixed status asset refused")
entry = "/usr/libexec/vector-sandbox/v1/entry.py"
DIAGNOSTIC_STAGE = "client-input"
need(len(sys.argv) == 3 and len(sys.argv[1]) == 64 and all(c in "0123456789abcdef" for c in sys.argv[1]) and sys.argv[2] in ("prepare","inspect"))
DIAGNOSTIC_OPERATION = sys.argv[2]
DIAGNOSTIC_STAGE = "client-source"
need(os.path.realpath(entry) == entry)
for parent in pathlib.Path(entry).parents:
    info = parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and
         os.path.realpath(parent) == str(parent))
source = os.open(entry,os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
try:
    before = os.fstat(source)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and before.st_nlink == 1 and
         stat.S_IMODE(before.st_mode) == 0o444 and 0 < before.st_size <= 131072)
    code = os.read(source,131073)
    after = os.fstat(source)
    need(len(code) == before.st_size and len(code) <= 131072 and hashlib.sha256(code).hexdigest() == sys.argv[1] and
         (after.st_dev,after.st_ino,after.st_uid,after.st_gid,after.st_nlink,after.st_mode,after.st_size,
          after.st_mtime_ns,after.st_ctime_ns) ==
         (before.st_dev,before.st_ino,before.st_uid,before.st_gid,before.st_nlink,before.st_mode,before.st_size,
          before.st_mtime_ns,before.st_ctime_ns))
finally: os.close(source)
# No SourceFileLoader/import/cache fallback: this exact validated byte buffer defines protocol functions only.
namespace = {"__name__":"vector_native_status","__file__":entry}
exec(compile(code,entry,"exec",dont_inherit=True),namespace)
native = SimpleNamespace(**namespace)
DIAGNOSTIC_STAGE = "client-request"
request = json.loads(sys.stdin.buffer.read(65537).decode("utf-8","strict"))
need(type(request) is dict and set(request) == {"public","maskSources"})
public = native.validate_spec(request["public"])
DIAGNOSTIC_STAGE = "client-masks"
mask_proof = native.validate_masks(public["keeper"]["pid"],public["keeper"]["start"],public["uid"],public["gid"],request["maskSources"])
DIAGNOSTIC_STAGE = "client-capabilities"
for capability in range(64):
    if native.LIBC.prctl(24, capability, 0, 0, 0) != 0:
        native.require(ctypes.get_errno() == errno.EINVAL)
native.require(native.LIBC.prctl(47,4,0,0,0) == 0 and native.LIBC.prctl(38,1,0,0,0) == 0)
DIAGNOSTIC_STAGE = "client-identity"
os.setgroups([])
os.setresgid(public["gid"],public["gid"],public["gid"])
os.setresuid(public["uid"],public["uid"],public["uid"])
native.require(os.getgroups() == [] and os.getuid() == public["uid"] and os.getgid() == public["gid"])
native.assert_capabilities_dropped()
DIAGNOSTIC_STAGE = "client-admission"
descriptors = native.receive_namespaces(public)
DIAGNOSTIC_STAGE = "client-close"
try: native.require(len(descriptors) == 3)
finally:
    for descriptor in descriptors.values(): os.close(descriptor)
DIAGNOSTIC_STAGE = "client-output"
encoded = json.dumps({"v":1,"event":"broker-live","nonce":public["nonce"],"masks":True,
                      "maskProof":mask_proof},separators=(",",":"),ensure_ascii=False).encode("utf-8","strict")
need(len(encoded) + 1 <= 40960)
sys.stdout.buffer.write(encoded + b"\n"); sys.stdout.buffer.flush()
'''
def mask_proof(value, public):
    # Structural transport validation never grants authority: CLIENT produced this object only after
    # digest-verified native source checks and broker admission, and ready() checks the current public spec.
    need(type(value) is dict and set(value) ==
         {"v","sourceDigest","constructionNamespace","keeperNamespace","protectedMountTargets"} and
         type(value["v"]) is int and value["v"] == 2)
    digest = value["sourceDigest"]
    need(type(digest) is str and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest))
    construction = value["constructionNamespace"]
    need(type(construction) is dict and set(construction) == {"mount","parentMount","user","root"})
    for identity in (*construction.values(), value["keeperNamespace"]):
        need(type(identity) is dict and set(identity) == {"device","inode"} and
             all(type(item) is int and 0 < item <= 9007199254740991 for item in identity.values()))
    keeper = value["keeperNamespace"]
    need(construction["mount"] != construction["parentMount"] and
         keeper == {"device":public["devices"]["mnt"],"inode":public["namespaces"]["mnt"]} and
         keeper != construction["mount"] and keeper != construction["parentMount"] and
         construction["user"] != {"device":public["devices"]["user"],"inode":public["namespaces"]["user"]})
    targets = value["protectedMountTargets"]
    parents = ("/home/vector-agent","/tmp","/var/tmp","/run","/home/runner/work/_temp")
    need(type(targets) is list and len(targets) <= 64)
    for target in targets:
        need(type(target) is str and 0 < len(target.encode("utf-8","strict")) <= 4096 and
             target.startswith("/") and os.path.normpath(target) == target and
             not any(ord(char) < 32 or ord(char) == 127 for char in target) and
             any(target == parent or target.startswith(parent + "/") for parent in parents))
    need(targets == sorted(set(targets)) and all(parent in targets for parent in parents) and
         len(json.dumps(value,separators=(",",":"),ensure_ascii=False).encode("utf-8","strict")) <= 32768)
    return value
def proc_text(pid, name, limit=65536):
    with open(f"/proc/{pid}/{name}","rb") as stream: data = stream.read(limit + 1)
    need(len(data) <= limit)
    return data.decode("ascii","strict")
def identity(row, user, group):
    pid = row["pid"]
    need(type(pid) is int and pid > 1)
    text = proc_text(pid,"stat",8192)
    fields = text[text.rindex(")") + 2:].split()
    status = dict(line.split(":",1) for line in proc_text(pid,"status").splitlines() if ":" in line)
    need(len(fields) >= 20 and fields[19] == row["start"] and fields[0] not in ("Z","X","x") and
         status["Pid"].split() == [str(pid)] and status["Uid"].split() == [str(user)] * 4 and
         status["Gid"].split() == [str(group)] * 4)
def endpoint(public):
    secure(public["directory"],0o755,True)
    item = os.lstat(public["socket"])
    need(os.path.realpath(public["socket"]) == public["socket"] and stat.S_ISSOCK(item.st_mode) and
         item.st_uid == 0 and item.st_gid == gid and stat.S_IMODE(item.st_mode) == 0o660 and
         item.st_dev == public["socketIdentity"]["device"] and item.st_ino == public["socketIdentity"]["inode"])
def live(public, mask_sources):
    global DIAGNOSTIC_STAGE
    descriptors = []
    try:
        DIAGNOSTIC_STAGE = "live-processes"
        # Pin first. Reused PID paths cannot pass the final poll of the original process identity.
        for row in (public["keeper"],public["broker"]): descriptors.append(os.pidfd_open(row["pid"],0))
        identity(public["keeper"],uid,gid); identity(public["broker"],0,0)
        namespace_fds = {}
        try:
            DIAGNOSTIC_STAGE = "live-namespaces"
            kinds = {"user":0x10000000,"mnt":0x00020000,"pid":0x20000000}
            for kind, number in kinds.items():
                fd = os.open(f"/proc/{public['keeper']['pid']}/ns/{kind}",os.O_RDONLY | os.O_CLOEXEC)
                namespace_fds[kind] = fd
                info = os.fstat(fd)
                need(info.st_dev == public["devices"][kind] and info.st_ino == public["namespaces"][kind] and
                     fcntl.ioctl(fd,0xB703) == number)
            owner = array.array("I",[0]); fcntl.ioctl(namespace_fds["user"],0xB704,owner,True)
            need(owner[0] == uid)
            for kind in ("mnt","pid"):
                owner_fd = fcntl.ioctl(namespace_fds[kind],0xB701)
                try: need(os.fstat(owner_fd).st_ino == public["namespaces"]["user"])
                finally: os.close(owner_fd)
            need(proc_text(public["keeper"]["pid"],"uid_map").split() == ["0",str(uid),"1"] and
                 proc_text(public["keeper"]["pid"],"gid_map").split() == ["0",str(gid),"1"])
            DIAGNOSTIC_STAGE = "live-endpoint"
            endpoint(public)
            DIAGNOSTIC_STAGE = "live-client"
            probe = subprocess.run([python,"-I","-S","-B","-c",CLIENT,asset_sha,operation],input=json.dumps({"public":public,"maskSources":mask_sources},separators=(",",":"),ensure_ascii=False).encode("utf-8","strict"),
                                   stdout=subprocess.PIPE,stderr=sys.stderr,check=True,timeout=3,
                                   env=ENV,close_fds=True)
            need(len(probe.stdout) <= 40960)
            proof = json.loads(probe.stdout.decode("utf-8","strict"))
            need(type(proof) is dict and set(proof) == {"v","event","nonce","masks","maskProof"} and
                 proof["v"] == 1 and proof["event"] == "broker-live" and proof["nonce"] == public["nonce"] and
                 proof["masks"] is True)
            evidence = mask_proof(proof["maskProof"], public)
            need(evidence["sourceDigest"] == mask_sources["digest"] and
                 evidence["constructionNamespace"] == mask_sources["namespace"])
            DIAGNOSTIC_STAGE = "live-final"
            endpoint(public)
            identity(public["keeper"],uid,gid); identity(public["broker"],0,0)
            for fd in descriptors:
                poll = select.poll(); poll.register(fd,select.POLLIN); need(not poll.poll(0))
            return {"keeper":True,"broker":True,"namespaces":True,"socket":True,"admission":True,"masks":True,
                    "maskProof":evidence}
        finally:
            for fd in namespace_fds.values(): os.close(fd)
    finally:
        for fd in descriptors: os.close(fd)
DIAGNOSTIC_STAGE = "control-input"
need(os.geteuid() == 0 and sys.version_info >= (3,12) and len(sys.argv) == 8)
operation, uid, gid, container, nonce, asset_sha, profile_sha = sys.argv[1:]
DIAGNOSTIC_OPERATION = operation
uid, gid = int(uid), int(gid)
need(operation in ("install","prepare","inspect","cleanup") and 0 < uid <= 2147483647 and 0 < gid <= 2147483647)
need(container in ("/mnt/vector-agent-sandbox","/var/lib/vector-agent-sandbox","/home/vector-agent-sandbox"))
need(len(nonce) == 32 and len(asset_sha) == len(profile_sha) == 64 and
     all(c in "0123456789abcdef" for c in nonce + asset_sha + profile_sha))
need(sha(PROFILE.encode("utf-8")) == profile_sha)
DIAGNOSTIC_STAGE = "control-parents"
for parent in ("/","/usr","/usr/libexec","/etc","/etc/apparmor.d"): secure(parent,0o755,True)
DIAGNOSTIC_STAGE = "control-executables"
python = executable("/usr/bin/python3")
parser = executable("/usr/sbin/apparmor_parser")
expected = {"v":1,"uid":uid,"gid":gid,"container":container,"nonce":nonce,"assetSHA":asset_sha,"profileSHA":profile_sha}
if operation == "install":
    DIAGNOSTIC_STAGE = "install-input"
    data = sys.stdin.buffer.read(262145)
    need(len(data) <= 262144)
    asset = json.loads(data.decode("utf-8","strict"))
    need(set(asset) == {"v","entry","sha256"} and type(asset["v"]) is int and asset["v"] == 1)
    code = asset["entry"].encode("utf-8","strict")
    need(0 < len(code) <= 131072 and sha(code) == asset["sha256"] == asset_sha)
    need(not os.path.lexists(BASE) and not os.path.lexists(POLICY) and not loaded())
    DIAGNOSTIC_STAGE = "install-files"
    os.mkdir(BASE,0o755); os.chmod(BASE,0o755)
    os.mkdir(ROOT,0o755); os.chmod(ROOT,0o755)
    os.mkdir(PRIVATE,0o700); os.chmod(PRIVATE,0o700)
    write(LOCK,b"",0o600)
    record({**expected,"phase":"files"},True)
    write(ENTRY,code,0o444)
    write(POLICY,PROFILE.encode("utf-8"),0o444)
DIAGNOSTIC_STAGE = "control-lock"
secure(BASE,0o755,True); secure(ROOT,0o755,True); secure(PRIVATE,0o700,True)
lock = os.open(LOCK,os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
try:
    info = os.fstat(lock)
    need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1 and
         stat.S_IMODE(info.st_mode) == 0o600)
    fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    DIAGNOSTIC_STAGE = "control-receipt"
    installation = json.loads(read(INSTALL,0o600,4096).decode("ascii","strict"))
    need(set(installation) == set(expected) | {"phase"} and all(installation[key] == item for key,item in expected.items()))
    DIAGNOSTIC_STAGE = "control-files"
    need(sha(read(ENTRY,0o444,131072)) == asset_sha and sha(read(POLICY,0o444,4096)) == profile_sha)
    if operation == "install":
        need(installation["phase"] == "files" and not loaded())
        DIAGNOSTIC_STAGE = "policy-load"
        subprocess.run([parser,"--add",POLICY],check=True,timeout=5,env=ENV,
                       stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=sys.stderr,close_fds=True)
        DIAGNOSTIC_STAGE = "policy-proof"
        need(loaded() == ["vector-sandbox-v1 (enforce)"])
        installation["phase"] = "installed"; record(installation)
        DIAGNOSTIC_STAGE = "control-output"
        print(json.dumps({"v":1,"event":"installed","installNonce":nonce,"assetSHA":asset_sha,"profileSHA":profile_sha}),flush=True)
    else:
        DIAGNOSTIC_STAGE = "policy-proof"
        need(loaded() == ["vector-sandbox-v1 (enforce)"])
        if operation == "prepare":
            need(installation["phase"] == "installed")
            installation["phase"] = "preparing"; record(installation)
            # The trusted setup child retains this secret-free lifetime lock if its controller dies. Its own
            # keeper/broker close_fds/pass_fds omit the lock, so cleanup cannot overtake still-running setup.
            DIAGNOSTIC_STAGE = "native-prepare"
            subprocess.run([python,"-I","-S",ENTRY,"prepare",str(uid),str(gid),container],
                           check=True,timeout=45,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                           stderr=sys.stderr,close_fds=True,pass_fds=(lock,))
        DIAGNOSTIC_STAGE = "native-state"
        value = native_state()
        if operation in ("prepare","inspect"):
            need(installation["phase"] == ("preparing" if operation == "prepare" else "ready") and
                 value["phase"] == "adopted" and value["brokerPending"] is False)
            DIAGNOSTIC_STAGE = "native-public"
            public = json.loads(read(ROOT + "/run.json",0o444,65536).decode("utf-8","strict"))
            need(public == value["public"])
            proof = live(public, value["maskSources"])
            if operation == "prepare": installation["phase"] = "ready"; record(installation)
            DIAGNOSTIC_STAGE = "control-output"
            encoded = json.dumps({"v":1,"event":"ready","installNonce":nonce,"assetSHA":asset_sha,"public":public,
                                  "live":proof},separators=(",",":"),ensure_ascii=False).encode("utf-8","strict")
            sys.stdout.buffer.write(encoded + b"\n"); sys.stdout.buffer.flush()
        else:
            need(installation["phase"] in ("preparing","ready"))
            DIAGNOSTIC_STAGE = "native-cleanup"
            result = subprocess.run([python,"-I","-S",ENTRY,"cleanup"],check=True,timeout=15,env=ENV,
                                    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=sys.stderr,
                                    close_fds=True,pass_fds=(lock,))
            DIAGNOSTIC_STAGE = "cleanup-receipt"
            need(len(result.stdout) <= 4096)
            receipt = json.loads(result.stdout.decode("ascii","strict"))
            need(receipt == {"v":1,"event":"isolation-stopped","uidStoppedBeforeBroker":True,
                             "brokerStopped":True,"nonce":value["public"]["nonce"]})
            DIAGNOSTIC_STAGE = "cleanup-state"
            after = native_state()
            need(after["phase"] == "broker-stopped" and after["public"] == value["public"] and
                 not os.path.lexists(ROOT + "/run.json"))
            installation["phase"] = "stopped"; record(installation)
            DIAGNOSTIC_STAGE = "control-output"
            print(json.dumps({"v":1,"event":"stopped","installNonce":nonce,"assetSHA":asset_sha,
                              "namespaceNonce":receipt["nonce"],"uidStoppedBeforeBroker":True,"brokerStopped":True}),flush=True)
finally: os.close(lock)
`

/** Check both directions before a launcher selects its pre-capture implementation. */
export function assertBuildCoherence(
  core: { readonly enabled: boolean; readonly entrySHA: string | undefined },
  engine: { readonly enabled: boolean; readonly asset: Asset | undefined },
) {
  if (core.enabled !== engine.enabled) refused()
  if (!core.enabled && core.entrySHA === undefined && engine.asset === undefined) return
  if (
    !engine.asset ||
    !/^[a-f0-9]{64}$/.test(core.entrySHA ?? "") ||
    core.entrySHA !== engine.asset.sha256 ||
    engine.asset.sha256 !== digest(engine.asset.entry)
  )
    refused()
}

export function enabled() {
  assertBuildCoherence(LinuxIsolationBuild, GithubIsolationBuild)
  return GithubIsolationBuild.enabled
}

/** Only trusted runner code constructs this port. It is never a request/configuration JSON service. */
export function create(ports: Ports) {
  LinuxIsolation.hostedTemporary(ports.temporary)
  exact(ports.asset, ["v", "entry", "sha256"])
  if (ports.asset.v !== 1 || typeof ports.asset.entry !== "string" || !ports.asset.entry.isWellFormed()) refused()
  hex(ports.asset.sha256, 64)
  if (
    !ports.asset.entry ||
    Buffer.byteLength(ports.asset.entry) > 131_072 ||
    digest(ports.asset.entry) !== ports.asset.sha256
  )
    refused()
  // Freeze a copy: a dependency cannot retarget the next root invocation after intent was persisted.
  const asset = Object.freeze({ ...ports.asset })
  async function metadata(name: string, mode: number, kind: Metadata["kind"], sha256?: string) {
    const item = await ports.inspect(name)
    if (
      !item ||
      item.canonical !== name ||
      item.kind !== kind ||
      item.uid !== 0 ||
      item.gid !== 0 ||
      item.mode !== mode
    )
      refused()
    if (kind === "file" && (item.nlink !== 1 || item.sha256 !== sha256)) refused()
  }
  async function parents() {
    for (const name of PARENTS) await metadata(name, 0o755, "directory")
  }
  async function installed() {
    await parents()
    await metadata(BASE, 0o755, "directory")
    await metadata(LinuxIsolation.ROOT, 0o755, "directory")
    await metadata(`${LinuxIsolation.ROOT}/private`, 0o700, "directory")
    await metadata(LinuxIsolation.ENTRY, 0o444, "file", asset.sha256)
    await metadata(PROFILE_PATH, 0o444, "file", PROFILE_SHA)
  }
  function matching(input: State) {
    const state = parseState(input)
    if (state.assetSHA !== asset.sha256) refused()
    return state
  }
  async function invoke(operation: "install" | "prepare" | "inspect" | "cleanup", state: State) {
    const output = await ports.execute({
      file: "/usr/bin/sudo",
      args: Object.freeze([
        "-n",
        LinuxIsolation.PYTHON,
        "-I",
        "-S",
        "-c",
        CONTROL,
        operation,
        String(state.uid),
        String(state.gid),
        state.container,
        state.installNonce,
        state.assetSHA,
        PROFILE_SHA,
      ]),
      input: operation === "install" ? JSON.stringify(asset) : "",
      timeout: operation === "prepare" ? 50_000 : operation === "cleanup" ? 20_000 : 10_000,
      maxOutput: 65_536,
      env: Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C" }),
    })
    if (typeof output !== "string" || Buffer.byteLength(output) > 65_536) refused()
    const result: unknown = JSON.parse(output)
    return result
  }
  function ready(result: unknown, state: State) {
    exact(result, ["v", "event", "installNonce", "assetSHA", "public", "live"])
    if (
      result.v !== 1 ||
      result.event !== "ready" ||
      result.installNonce !== state.installNonce ||
      result.assetSHA !== state.assetSHA
    )
      refused()
    exact(result.live, ["keeper", "broker", "namespaces", "socket", "admission", "masks", "maskProof"])
    for (const key of ["keeper", "broker", "namespaces", "socket", "admission", "masks"])
      if (result.live[key] !== true) refused()
    const spec = LinuxIsolation.parseSpec(result.public)
    if (
      spec.container !== state.container ||
      spec.uid !== state.uid ||
      spec.gid !== state.gid ||
      (state.phase === "ready" && spec.nonce !== state.namespaceNonce)
    )
      refused()
    LinuxIsolation.parseMaskProof(result.live.maskProof, spec)
    return parseState({ ...state, phase: "ready", namespaceNonce: spec.nonce })
  }
  return Object.freeze({
    intent(input: Scope) {
      scope(input)
      return parseState({
        v: 1,
        phase: "intent",
        container: input.container,
        uid: input.uid,
        gid: input.gid,
        installNonce: ports.nonce(),
        assetSHA: asset.sha256,
      })
    },
    async prepare(input: State) {
      const state = matching(input)
      if (state.phase !== "intent") refused()
      await parents()
      const result = await invoke("install", state)
      exact(result, ["v", "event", "installNonce", "assetSHA", "profileSHA"])
      if (
        result.v !== 1 ||
        result.event !== "installed" ||
        result.installNonce !== state.installNonce ||
        result.assetSHA !== asset.sha256 ||
        result.profileSHA !== PROFILE_SHA
      )
        refused()
      await installed()
      return ready(await invoke("prepare", state), state)
    },
    async validate(input: State) {
      const state = matching(input)
      if (state.phase !== "ready") refused()
      await installed()
      return ready(await invoke("inspect", state), state)
    },
    async cleanup(input: State) {
      const state = matching(input)
      await installed()
      const result = await invoke("cleanup", state)
      exact(result, [
        "v",
        "event",
        "installNonce",
        "assetSHA",
        "namespaceNonce",
        "uidStoppedBeforeBroker",
        "brokerStopped",
      ])
      if (
        result.v !== 1 ||
        result.event !== "stopped" ||
        result.installNonce !== state.installNonce ||
        result.assetSHA !== asset.sha256 ||
        result.uidStoppedBeforeBroker !== true ||
        result.brokerStopped !== true
      )
        refused()
      hex(result.namespaceNonce, 32)
      if (state.phase === "ready" && result.namespaceNonce !== state.namespaceNonce) refused()
      return Object.freeze({ artifactsAllowed: state.phase === "ready", namespaceNonce: result.namespaceNonce })
    },
  })
}
export type Adapter = ReturnType<typeof create>

async function inspect(name: string): Promise<Metadata | undefined> {
  const item = await fs.lstat(name).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error(REFUSAL)
  })
  if (!item) return
  const canonical = await fs.realpath(name)
  const base = { uid: item.uid, gid: item.gid, mode: item.mode & 0o7777, canonical, nlink: item.nlink }
  if (item.isSymbolicLink()) return { ...base, kind: "other" }
  if (item.isDirectory()) return { ...base, kind: "directory" }
  if (!item.isFile() || ![LinuxIsolation.ENTRY, PROFILE_PATH].includes(name)) return { ...base, kind: "other" }
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const pinned = await file.stat()
    if (!pinned.isFile() || pinned.dev !== item.dev || pinned.ino !== item.ino || pinned.size > 131_072) refused()
    const bytes = Buffer.alloc(131_073)
    const result = await file.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead !== pinned.size || result.bytesRead > 131_072) refused()
    const after = await file.stat()
    if (
      after.size !== pinned.size ||
      after.mode !== pinned.mode ||
      after.uid !== pinned.uid ||
      after.gid !== pinned.gid ||
      after.nlink !== pinned.nlink ||
      after.mtimeMs !== pinned.mtimeMs ||
      after.ctimeMs !== pinned.ctimeMs
    )
      refused()
    return { ...base, kind: "file", sha256: digest(bytes.subarray(0, result.bytesRead)) }
  } finally {
    await file.close()
  }
}

function executionFailure(
  invocation: Invocation,
  stage: (typeof FAILURE_STAGES.transport)[number],
  stderr: Uint8Array,
  code?: number | null,
  signal?: string | null,
  error?: unknown,
) {
  const candidate = invocation.args[6]
  const operation = member(OPERATIONS, candidate) ? candidate : "unknown"
  const classes: Record<(typeof FAILURE_STAGES.transport)[number], FailureRecord["class"]> = {
    spawn: "SpawnError",
    stdin: "IOError",
    timeout: "TimeoutExpired",
    "stdout-bound": "OutputBound",
    "stderr-bound": "OutputBound",
    close: "ChildExit",
    decode: "DecodeError",
  }
  const property = failureObject(error) ? Object.getOwnPropertyDescriptor(error, "code") : undefined
  const errno: unknown = property && Object.hasOwn(property, "value") ? property.value : null
  const transport: FailureRecord = {
    v: 1,
    event: "native-control-failure",
    origin: "transport",
    operation,
    stage,
    class: classes[stage],
    errno: member(FAILURE_ERRNOS, errno) ? errno : null,
    exit: typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
    signal: member(FAILURE_SIGNALS, signal) ? signal : null,
  }
  const cause: FailureCause = {
    v: 1,
    event: "native-control-failure",
    records: [transport, ...decodeFailureRecords(stderr, operation)],
  }
  return new Error(REFUSAL, { cause })
}

function execute(invocation: Invocation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, [...invocation.args], { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] })
    const output: Buffer[] = []
    const stderr = Buffer.alloc(4096)
    let size = 0
    let stderrSize = 0
    let failed = false
    const fail = (stage: (typeof FAILURE_STAGES.transport)[number], error?: unknown) => {
      if (failed) return
      failed = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      reject(executionFailure(invocation, stage, stderr.subarray(0, stderrSize), null, null, error))
    }
    const timer = setTimeout(() => fail("timeout"), invocation.timeout)
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return
      size = Math.min(invocation.maxOutput + 1, size + chunk.length)
      if (size > invocation.maxOutput) {
        fail("stdout-bound")
        return
      }
      output.push(chunk)
    })
    // Drain the same private pipe continuously. Retain at most its final 4KiB, with the original combined output
    // limit and timeout unchanged. Only strict enum records can leave on an Error.cause; raw bytes never leave.
    child.stderr.on("data", (chunk: Buffer) => {
      if (failed) return
      if (chunk.length >= stderr.length) {
        chunk.copy(stderr, 0, chunk.length - stderr.length)
        stderrSize = stderr.length
      } else {
        const drop = Math.max(0, stderrSize + chunk.length - stderr.length)
        if (drop) stderr.copy(stderr, 0, drop, stderrSize)
        chunk.copy(stderr, stderrSize - drop)
        stderrSize = stderrSize - drop + chunk.length
      }
      size = Math.min(invocation.maxOutput + 1, size + chunk.length)
      if (size > invocation.maxOutput) fail("stderr-bound")
    })
    child.on("error", (error) => fail("spawn", error))
    child.stdin.on("error", (error) => fail("stdin", error))
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (failed) return
      if (code !== 0) {
        reject(executionFailure(invocation, "close", stderr.subarray(0, stderrSize), code, signal))
        return
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)))
      } catch {
        reject(executionFailure(invocation, "decode", stderr.subarray(0, stderrSize), code, signal))
      }
    })
    child.stdin.end(invocation.input)
  })
}

/** Compile-time CI selection only. True + absent/bad bytes refuses; it never selects the legacy tool path. */
export function fromBuild(temporary: string | undefined): Adapter {
  if (!enabled() || GithubIsolationBuild.asset === undefined) refused()
  return create({
    asset: GithubIsolationBuild.asset,
    temporary: LinuxIsolation.hostedTemporary(temporary),
    inspect,
    execute,
    nonce: () => randomBytes(16).toString("hex"),
  })
}

export * as GithubIsolation from "./github.isolation"
