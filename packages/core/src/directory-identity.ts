export * as DirectoryIdentityReader from "./directory-identity"

import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { release } from "node:os"

// One trusted system metadata read, not a caller-selected process capability. This port does not authenticate a
// repository or a person. It returns no proof when the supported runtime, kernel bits or cleanup are unavailable.
export const PYTHON = "/usr/bin/python3"
export const LIMIT = Object.freeze({ output: 512, milliseconds: 5_000, reap: 1_000, files: 8_192, libraries: 128 })
export const MASK = 0x901 // STATX_TYPE | STATX_INO | STATX_BTIME
export interface Info {
  readonly dev: string
  readonly ino: string
  readonly birth: string
}
export interface Basic {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
}
const pending = new Set<ChildProcess>()

export const SOURCE = String.raw`import sys, os
if sys.platform != "linux" or sys.version_info[:2] != (3, 12) or sys.byteorder != "little" or not sys.flags.isolated or not sys.flags.no_site or sys.prefix != "/usr" or sys.exec_prefix != "/usr":
    os._exit(125)
if set(os.environ) - {"PATH", "LC_ALL", "LC_CTYPE"}:
    os._exit(125)
allowed = {"/usr/lib/python312.zip", "/usr/lib/python3.12", "/usr/lib/python3.12/lib-dynload"}
if set(sys.path) - allowed:
    os._exit(125)
if "_struct" not in sys.builtin_module_names:
    os._exit(125)
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
libc.close_range.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_int)
libc.close_range.restype = ctypes.c_int
if libc.close_range(4, 0xffffffff, 0) != 0:
    os._exit(125)
for name, module in tuple(sys.modules.items()):
    origin = getattr(module, "__file__", None)
    if origin and not os.path.realpath(origin).startswith("/usr/lib/python3.12/"):
        os._exit(125)
class Stamp(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_int64), ("nanoseconds", ctypes.c_uint32), ("reserved", ctypes.c_int32)]
class Statx(ctypes.Structure):
    _fields_ = [("mask", ctypes.c_uint32), ("blocksize", ctypes.c_uint32), ("attributes", ctypes.c_uint64),
                ("links", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32),
                ("mode", ctypes.c_uint16), ("padding", ctypes.c_uint16), ("inode", ctypes.c_uint64),
                ("size", ctypes.c_uint64), ("blocks", ctypes.c_uint64), ("attributes_mask", ctypes.c_uint64),
                ("access", Stamp), ("birth", Stamp), ("change", Stamp), ("modified", Stamp),
                ("rdev_major", ctypes.c_uint32), ("rdev_minor", ctypes.c_uint32),
                ("dev_major", ctypes.c_uint32), ("dev_minor", ctypes.c_uint32), ("tail", ctypes.c_byte * 112)]
if ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(Statx) != 256 or Statx.birth.offset != 80 or Statx.dev_major.offset != 136:
    os._exit(125)
libc.statx.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx))
libc.statx.restype = ctypes.c_int
before = os.fstat(3)
result = Statx()
if before.st_mode & 0o170000 != 0o040000 or libc.statx(3, b"", 0x1000, 0x901, ctypes.byref(result)) != 0:
    os._exit(125)
after = os.fstat(3)
device = os.makedev(result.dev_major, result.dev_minor)
if result.mask & 0x901 != 0x901 or result.mode & 0o170000 != 0o040000 or not (before.st_dev == after.st_dev == device and before.st_ino == after.st_ino == result.inode) or before.st_mode != after.st_mode or result.birth.seconds < 0 or result.birth.seconds > 253402300799 or result.birth.nanoseconds >= 1000000000:
    os._exit(125)
os.write(1, ('{"v":1,"mask":%d,"mode":%d,"dev":"%d","ino":"%d","seconds":"%d","nanoseconds":%d}\n' % (result.mask, result.mode, device, result.inode, result.birth.seconds, result.birth.nanoseconds)).encode("ascii"))
`

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
const digits = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]{0,31})$/.test(value)
/** Strict wire decoding only. Successful bytes are not authority without the actual trusted process/FD boundary. */
export function decode(bytes: Uint8Array, before: Basic, after: Basic): Info | undefined {
  if (!bytes.length || bytes.length > LIMIT.output) return
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return
  }
  if (!Buffer.from(JSON.stringify(value) + "\n").equals(Buffer.from(bytes))) return
  const keys = ["v", "mask", "mode", "dev", "ino", "seconds", "nanoseconds"]
  if (
    !object(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.v !== 1 ||
    typeof value.mask !== "number" ||
    !Number.isInteger(value.mask) ||
    value.mask < 0 ||
    value.mask > 0xffffffff ||
    (value.mask & MASK) !== MASK ||
    typeof value.mode !== "number" ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0xffff ||
    (value.mode & 0o170000) !== 0o040000 ||
    !digits(value.dev) ||
    !digits(value.ino) ||
    !digits(value.seconds) ||
    typeof value.nanoseconds !== "number" ||
    !Number.isInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds >= 1_000_000_000
  )
    return
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    (before.mode & 0o170000n) !== 0o040000n ||
    BigInt(value.dev) !== before.dev ||
    BigInt(value.ino) !== before.ino ||
    before.ino <= 0n ||
    BigInt(value.seconds) > 253402300799n
  )
    return
  const birth = BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds)
  if (birth <= 0n) return
  return Object.freeze({ dev: value.dev, ino: value.ino, birth: birth.toString() })
}

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Unverifiable system metadata runtime")
}
const ascii = (bytes: Buffer, offset: number, end: number) => {
  requireValue(offset >= 0 && offset < end && end <= bytes.length)
  const stop = bytes.indexOf(0, offset)
  requireValue(stop >= offset && stop < end && stop - offset <= 4096)
  const value = bytes.subarray(offset, stop).toString("ascii")
  requireValue(Buffer.from(value, "ascii").equals(bytes.subarray(offset, stop)) && !/[\x00-\x1f\x7f]/.test(value))
  return value
}
function cacheName(value: string) {
  requireValue(/^[A-Za-z0-9_.+-]{1,256}$/.test(value))
  return value.replace(/[0-9]+/g, (part) => {
    requireValue(part.length <= 9)
    return String(Number(part))
  })
}
const cacheCompare = (a: string, b: string) => {
  const left = cacheName(a).match(/[0-9]+|[^0-9]/g) ?? [],
    right = cacheName(b).match(/[0-9]+|[^0-9]/g) ?? []
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index],
      y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^[0-9]/.test(x),
      ny = /^[0-9]/.test(y)
    const compared = nx && ny ? Number(x) - Number(y) : nx ? 1 : ny ? -1 : x.charCodeAt(0) - y.charCodeAt(0)
    if (compared) return compared
  }
  return 0
}
export interface Library {
  readonly path: string
  readonly baseline: boolean
}
/** Supported glibc cache1.1 only. Exact native flags and usable baseline are required by the runtime proof. */
export function cacheLibraries(bytes: Buffer, arch: "x64" | "arm64") {
  requireValue(
    bytes.length > 48 &&
      bytes.length <= 8 * 1024 * 1024 &&
      bytes.subarray(0, 20).toString("ascii") === "glibc-ld.so.cache1.1" &&
      (bytes[28] === 0 || bytes[28] === 2),
  )
  const count = bytes.readUInt32LE(20),
    length = bytes.readUInt32LE(24),
    begin = 48 + count * 24,
    end = begin + length
  requireValue(count <= 16_384 && begin <= bytes.length && end <= bytes.length)
  const result = new Map<string, Library[]>()
  let previous: string | undefined
  for (let index = 0; index < count; index++) {
    const at = 48 + index * 24,
      flags = bytes.readUInt32LE(at),
      key = bytes.readUInt32LE(at + 4),
      target = bytes.readUInt32LE(at + 8)
    requireValue(key >= begin && target >= begin)
    const name = ascii(bytes, key, end),
      file = ascii(bytes, target, end),
      normalized = cacheName(name)
    requireValue(previous === undefined || cacheCompare(previous, name) >= 0)
    previous = name
    if ((flags & 0xff00) !== (arch === "x64" ? 0x0300 : 0x0a00)) continue
    requireValue(
      flags === (arch === "x64" ? 0x303 : 0xa03) && path.posix.isAbsolute(file) && path.posix.normalize(file) === file,
    )
    result.set(normalized, [
      ...(result.get(normalized) ?? []),
      { path: file, baseline: bytes.readUInt32LE(at + 12) === 0 && bytes.readBigUInt64LE(at + 16) === 0n },
    ])
  }
  return result
}
/** Bounded ELF64 little-endian dependency reader. Runtime search overrides/filter/audit objects refuse. */
export function elfDependencies(bytes: Buffer, arch: "x64" | "arm64", kernel?: number) {
  requireValue(
    bytes.length >= 64 &&
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes[6] === 1 &&
      (bytes[7] === 0 || bytes[7] === 3) &&
      bytes.subarray(8, 16).every((value) => value === 0) &&
      (bytes.readUInt16LE(16) === 2 || bytes.readUInt16LE(16) === 3) &&
      bytes.readUInt32LE(20) === 1 &&
      bytes.readUInt16LE(52) === 64 &&
      bytes.readUInt16LE(18) === (arch === "x64" ? 62 : 183),
  )
  const start = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56)
  requireValue(
    Number.isSafeInteger(start) && size === 56 && count > 0 && count <= 128 && start + size * count <= bytes.length,
  )
  const loads: { offset: number; address: bigint; size: bigint }[] = []
  let dynamic: { offset: number; size: number } | undefined
  let interpreter: string | undefined
  for (let index = 0; index < count; index++) {
    const at = start + index * size,
      type = bytes.readUInt32LE(at),
      offset = Number(bytes.readBigUInt64LE(at + 8)),
      length = Number(bytes.readBigUInt64LE(at + 32))
    requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset + length <= bytes.length)
    if (type === 4) {
      for (let note = offset; note < offset + length; ) {
        requireValue(note + 12 <= offset + length)
        const names = bytes.readUInt32LE(note),
          data = bytes.readUInt32LE(note + 4),
          kind = bytes.readUInt32LE(note + 8),
          named = note + 12,
          payload = named + Math.ceil(names / 4) * 4,
          next = payload + Math.ceil(data / 4) * 4
        requireValue(next <= offset + length && next > note)
        if (kind === 1 && names === 4 && bytes.subarray(named, named + 4).equals(Buffer.from([71, 78, 85, 0]))) {
          requireValue(data === 16 && bytes.readUInt32LE(payload) === 0 && kernel !== undefined)
          const major = bytes.readUInt32LE(payload + 4),
            minor = bytes.readUInt32LE(payload + 8),
            patch = bytes.readUInt32LE(payload + 12)
          requireValue(major <= 255 && minor <= 255 && patch <= 255 && major * 65536 + minor * 256 + patch <= kernel)
        }
        note = next
      }
    }
    if (type === 1)
      loads.push({ offset, address: bytes.readBigUInt64LE(at + 16), size: bytes.readBigUInt64LE(at + 32) })
    if (type === 2) {
      requireValue(!dynamic && length <= 65_536 && length % 16 === 0)
      dynamic = { offset, size: length }
    }
    if (type === 3) {
      requireValue(!interpreter && length <= 4096)
      interpreter = ascii(bytes, offset, offset + length)
    }
  }
  requireValue(dynamic)
  const names: number[] = []
  let strings: bigint | undefined,
    length: number | undefined,
    ended = false
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
    const tag = bytes.readBigInt64LE(at),
      value = bytes.readBigUInt64LE(at + 8)
    if (tag === 0n) {
      ended = true
      break
    }
    requireValue(![15n, 29n, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag))
    if (tag === 0x6ffffffbn) requireValue((value & 0x800n) === 0n)
    if (tag === 1n) {
      requireValue(value <= 1_048_576n)
      names.push(Number(value))
    }
    if (tag === 5n) {
      requireValue(strings === undefined)
      strings = value
    }
    if (tag === 10n) {
      requireValue(length === undefined && value <= 1_048_576n)
      length = Number(value)
    }
  }
  requireValue(ended && names.length <= 128)
  if (!names.length) return { needed: [], interpreter }
  requireValue(strings !== undefined && length !== undefined && length > 0)
  const stringAddress = strings
  const stringLength = length
  const load = loads.find(
    (value) => stringAddress >= value.address && stringAddress + BigInt(stringLength) <= value.address + value.size,
  )
  requireValue(load)
  const offset = load.offset + Number(stringAddress - load.address)
  const needed = names.map((name) => {
    requireValue(name < stringLength)
    const result = ascii(bytes, offset + name, offset + stringLength)
    requireValue(/^[A-Za-z0-9_.+-]{1,256}$/.test(result))
    return result
  })
  return { needed, interpreter }
}

export interface PackageProfile {
  readonly version: string
  readonly architecture: "amd64" | "arm64"
  readonly shared: boolean
}
const packageText = (value: string, maximum: number) => {
  requireValue(value.length > 0 && value.length <= maximum && !/[\0\r]/.test(value))
  return value
}
/** A fixed supported local distro installation, not a remote package-authenticity assertion. */
export function packageProfile(osRelease: string, status: string, arch: "x64" | "arm64"): PackageProfile {
  const release = new Map<string, string>()
  for (const line of packageText(osRelease, 65_536).split("\n")) {
    if (!line || line.startsWith("#")) continue
    const entry = /^([A-Z][A-Z0-9_]*)=(?:"([^"\\]*)"|'([^'\\]*)'|([^\s"'\\]*))$/.exec(line)
    requireValue(entry && !release.has(entry[1]))
    release.set(entry[1], entry[2] ?? entry[3] ?? entry[4])
  }
  requireValue(
    release.get("ID") === "ubuntu" &&
      release.get("VERSION_ID") === "24.04" &&
      release.get("VERSION_CODENAME") === "noble" &&
      release.get("UBUNTU_CODENAME") === "noble",
  )
  const architecture = arch === "x64" ? "amd64" : "arm64"
  const records: Map<string, string>[] = []
  for (const paragraph of packageText(status, 16 * 1024 * 1024).split("\n\n")) {
    if (!paragraph.trim()) continue
    requireValue(records.length < 16_384)
    const record = new Map<string, string>()
    let previous: string | undefined
    for (const line of paragraph.split("\n")) {
      if (!line) continue
      if (/^[ \t]/.test(line)) {
        requireValue(previous)
        record.set(previous, record.get(previous) + "\n" + line)
        continue
      }
      const field = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/.exec(line)
      requireValue(field && record.size < 256)
      const name = field[1].toLowerCase()
      requireValue(!record.has(name))
      record.set(name, field[2])
      previous = name
    }
    requireValue(record.has("package"))
    records.push(record)
  }
  const installed = (name: "python3.12-minimal" | "libpython3.12t64", required: boolean) => {
    const candidates = records.filter((record) => record.get("package") === name)
    if (!candidates.length && !required) return
    requireValue(candidates.length === 1)
    const record = candidates[0],
      version = record.get("version"),
      source = record.get("source")
    requireValue(
      record.get("status") === "install ok installed" &&
        record.get("architecture") === architecture &&
        typeof version === "string" &&
        /^3\.12\.3-1(?:ubuntu0\.[1-9][0-9]{0,5})?$/.test(version) &&
        (source === "python3.12" || source === `python3.12 (${version})`),
    )
    return version
  }
  const version = installed("python3.12-minimal", true)
  requireValue(version)
  const library = installed("libpython3.12t64", false)
  requireValue(library === undefined || library === version)
  return Object.freeze({ version, architecture, shared: library !== undefined })
}

/** MD5 is consistency with the trusted installed-file record; it is never an authenticity claim. */
export function packageImage(list: string, sums: string, member: string, image: Buffer) {
  requireValue(
    [
      "/usr/bin/python3.12",
      "/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0",
      "/usr/lib/aarch64-linux-gnu/libpython3.12.so.1.0",
    ].includes(member),
  )
  const members = new Set<string>()
  for (const line of packageText(list, 4 * 1024 * 1024).split("\n")) {
    if (!line) continue
    requireValue(
      members.size < 65_536 &&
        !/[\x00-\x1f\x7f]/.test(line) &&
        (line === "/." || (path.posix.isAbsolute(line) && path.posix.normalize(line) === line)) &&
        !members.has(line),
    )
    members.add(line)
  }
  requireValue(members.has(member))
  const digests = new Map<string, string>()
  for (const line of packageText(sums, 4 * 1024 * 1024).split("\n")) {
    if (!line) continue
    const entry = /^([0-9a-f]{32})  ([^\x00-\x1f\x7f]+)$/.exec(line)
    requireValue(entry && digests.size < 65_536)
    const file = entry[2]
    requireValue(!path.posix.isAbsolute(file) && path.posix.normalize(file) === file && !file.startsWith("../"))
    requireValue(members.has("/" + file) && !digests.has(file))
    digests.set(file, entry[1])
  }
  requireValue(digests.get(member.slice(1)) === createHash("md5").update(image).digest("hex"))
}

type Check = (() => void) & { readonly directories: Set<string> }
const step = async <A>(check: Check, operation: () => Promise<A>): Promise<A> => {
  check()
  const value = await operation()
  check()
  return value
}
async function immutable(file: string, check: Check) {
  requireValue(path.isAbsolute(file) && path.normalize(file) === file)
  const directories = new Set<string>()
  for (let current = file; ; current = path.dirname(current)) {
    // Only proven runtime DIRECTORY ancestry is reused, within this one read. Every leaf remains fresh.
    if (current !== file && check.directories.has(current)) break
    const named = await step(check, () => fs.lstat(current, { bigint: true }))
    requireValue(named.uid === 0n && (named.isSymbolicLink() || (named.mode & 0o022n) === 0n))
    if (named.isDirectory()) directories.add(current)
    if (current === "/") break
  }
  const canonical = await step(check, () => fs.realpath(file))
  for (let current = canonical; ; current = path.dirname(current)) {
    if (current !== canonical && check.directories.has(current)) break
    const info = await step(check, () => fs.lstat(current, { bigint: true }))
    requireValue(info.uid === 0n && (info.mode & 0o022n) === 0n && !info.isSymbolicLink())
    if (info.isDirectory()) directories.add(current)
    if (current === "/") break
  }
  const info = await step(check, () => fs.stat(canonical, { bigint: true }))
  requireValue((info.isFile() || info.isDirectory()) && (info.mode & 0o6000n) === 0n)
  // Publish only after BOTH ancestry walks and the leaf proof completed successfully.
  for (const directory of directories) check.directories.add(directory)
  return { canonical, info }
}
async function bytes(file: string, maximum: number, check: Check) {
  const checked = await immutable(file, check)
  requireValue(checked.info.isFile() && checked.info.size <= BigInt(maximum))
  check()
  // A resource-producing await must enter finally even if cancellation arrived during open.
  const handle = await fs.open(checked.canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    check()
    const before = await step(check, () => handle.stat({ bigint: true }))
    const result = await step(check, () => handle.readFile())
    const after = await step(check, () => handle.stat({ bigint: true }))
    requireValue(
      before.dev === checked.info.dev &&
        before.ino === checked.info.ino &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        BigInt(result.length) === after.size &&
        result.length <= maximum,
    )
    return result
  } finally {
    // Cleanup is unconditional; cancellation never skips closing a leased runtime file.
    await handle.close()
  }
}
const exists = (file: string, check: Check) =>
  step(check, () =>
    fs.lstat(file).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
        return false
      },
    ),
  )
const absent = async (file: string, check: Check) => {
  requireValue(!(await exists(file, check)))
}
/** Stock noble compiles _struct into the already-bound interpreter/libpython image. Only _ctypes is dynamic. */
export function extensionProfile(extensions: readonly string[], arch: "x64" | "arm64") {
  const expected = `/usr/lib/python3.12/lib-dynload/_ctypes.cpython-312-${arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu.so`
  requireValue(extensions.length === 1 && extensions[0] === expected)
  return expected
}
async function getpathOverrides(file: string, check: Check) {
  // CPython3.12 Modules/getpath.py: command-line isolation cannot disable ._pth, pyvenv or build discovery.
  await absent(file + "._pth", check)
  const directory = path.dirname(file)
  for (const candidate of [
    path.join(directory, "pyvenv.cfg"),
    path.join(path.dirname(directory), "pyvenv.cfg"),
    path.join(directory, "pybuilddir.txt"),
    path.join(directory, "Modules/Setup.local"),
  ])
    await absent(candidate, check)
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, "lib/python3.12")
    if (await exists(candidate, check))
      requireValue((await immutable(candidate, check)).canonical === "/usr/lib/python3.12")
    await absent(path.join(current, "lib/python312.zip"), check)
    if (current === "/") break
  }
}
async function runtime(arch: "x64" | "arm64", check: Check) {
  check()
  const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+.]|$)/.exec(release())
  requireValue(version)
  const parts = version.slice(1).map(Number)
  requireValue(parts.length === 3 && parts.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 255))
  const kernel = parts.reduce((total, value) => total * 256 + value, 0)
  requireValue(kernel >= 5 * 65536 + 9 * 256)
  const executable = await immutable(PYTHON, check)
  requireValue(executable.canonical === "/usr/bin/python3.12" && executable.info.isFile())
  // The fixed root-owned distro installation and package DB are trusted. Bind the actual image to that
  // installed stock noble source-package profile before any interpreter startup; MD5 is not authenticity.
  const text = (value: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(value)
  const profile = packageProfile(
    text(await bytes("/etc/os-release", 65_536, check)),
    text(await bytes("/var/lib/dpkg/status", 16 * 1024 * 1024, check)),
    arch,
  )
  const installedImage = async (name: "python3.12-minimal" | "libpython3.12t64", file: string, image: Buffer) => {
    const prefix =
      name === "python3.12-minimal"
        ? "/var/lib/dpkg/info/python3.12-minimal"
        : `/var/lib/dpkg/info/libpython3.12t64:${profile.architecture}`
    packageImage(
      text(await bytes(prefix + ".list", 4 * 1024 * 1024, check)),
      text(await bytes(prefix + ".md5sums", 4 * 1024 * 1024, check)),
      file,
      image,
    )
  }
  await getpathOverrides(PYTHON, check)
  await getpathOverrides(executable.canonical, check)
  if (await exists("/etc/ld.so.preload", check))
    requireValue((await bytes("/etc/ld.so.preload", 4096, check)).toString("utf8").trim() === "")
  const cache = cacheLibraries(await bytes("/etc/ld.so.cache", 8 * 1024 * 1024, check), arch)
  const visited = new Set<string>(),
    extensions: string[] = []
  let files = 0
  const walk = async (file: string, depth = 0): Promise<void> => {
    check()
    requireValue(depth <= 32 && ++files <= LIMIT.files)
    const current = await immutable(file, check)
    if (visited.has(current.canonical)) return
    visited.add(current.canonical)
    if (current.info.isDirectory()) {
      for (const name of await step(check, () => fs.readdir(current.canonical)))
        await walk(path.join(current.canonical, name), depth + 1)
    } else if (/\/(?:_ctypes|_struct)\.cpython-312-(?:x86_64|aarch64)-linux-gnu\.so$/.test(current.canonical))
      extensions.push(current.canonical)
  }
  requireValue((await immutable("/usr/lib/python3.12/os.py", check)).info.isFile())
  requireValue((await immutable("/usr/lib/python3.12/lib-dynload", check)).info.isDirectory())
  await walk("/usr/lib/python3.12")
  const extension = extensionProfile(extensions, arch)
  const libraries = new Set<string>()
  const verify = async (file: string): Promise<void> => {
    check()
    // Preserve lexical AND canonical library names: either may supply getpath's dladdr-adjacent ._pth.
    await getpathOverrides(file, check)
    const checked = await immutable(file, check)
    await getpathOverrides(checked.canonical, check)
    if (libraries.has(checked.canonical)) return
    requireValue(libraries.size < LIMIT.libraries)
    libraries.add(checked.canonical)
    const image = await bytes(checked.canonical, 64 * 1024 * 1024, check)
    if (file === PYTHON) await installedImage("python3.12-minimal", checked.canonical, image)
    if (path.basename(file).startsWith("libpython") || path.basename(checked.canonical).startsWith("libpython")) {
      requireValue(
        profile.shared &&
          checked.canonical === `/usr/lib/${arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu/libpython3.12.so.1.0`,
      )
      await installedImage("libpython3.12t64", checked.canonical, image)
    }
    const dependency = elfDependencies(image, arch, kernel)
    if (file === PYTHON) requireValue(dependency.interpreter)
    if (dependency.interpreter) {
      const loader = await immutable(dependency.interpreter, check)
      requireValue(
        path.basename(loader.canonical) === (arch === "x64" ? "ld-linux-x86-64.so.2" : "ld-linux-aarch64.so.1") &&
          ["/usr/lib/", "/usr/lib64/", "/lib/", "/lib64/"].some((prefix) => loader.canonical.startsWith(prefix)),
      )
      await verify(dependency.interpreter)
    }
    for (const name of dependency.needed) {
      const candidates = cache.get(cacheName(name))
      // Cache lookup precedes every glibc default/hwcaps search. A usable baseline must exist; NO fallback is inferred.
      requireValue(candidates)
      requireValue(candidates.some((candidate) => candidate.baseline) && candidates.length <= 64)
      for (const candidate of candidates) await verify(candidate.path)
    }
  }
  await verify(PYTHON)
  await verify(extension)
  check()
  return executable
}

/** A leased actual directory FD is the only input capability. Cancellation can refuse; it can never grant identity. */
export function read(handle: FileHandle, signal?: AbortSignal): Promise<Info | undefined> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return Promise.resolve(undefined)
  const arch = process.arch === "x64" ? "x64" : "arm64"
  const expires = performance.now() + LIMIT.milliseconds,
    workExpires = expires - LIMIT.reap,
    controller = new AbortController()
  const check: Check = Object.assign(
    () => {
      requireValue(!signal?.aborted && !controller.signal.aborted && performance.now() < workExpires)
    },
    { directories: new Set<string>() },
  )
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: Info) => {
      if (settled) return
      settled = true
      clearTimeout(work)
      clearTimeout(hard)
      signal?.removeEventListener("abort", cancel)
      if (!value) controller.abort()
      resolve(!signal?.aborted && performance.now() < expires ? value : undefined)
    }
    const cancel = () => {
      controller.abort()
      finish()
    }
    const work = setTimeout(() => controller.abort(), Math.max(0, workExpires - performance.now()))
    const hard = setTimeout(
      () => {
        controller.abort()
        finish()
      },
      Math.max(0, expires - performance.now()),
    )
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return
    }
    const operation = async () => {
      const before = await step(check, () => handle.stat({ bigint: true }))
      if (!before.isDirectory() || before.ino <= 0n || handle.fd < 0) return
      const proof = await runtime(arch, check)
      check() // No await or queued callback separates this final check from the fixed spawn.
      const result = await new Promise<Buffer | undefined>((done) => {
        check()
        const child = spawn(PYTHON, ["-I", "-S", "-c", SOURCE], {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          shell: false,
          stdio: ["ignore", "pipe", "ignore", handle.fd],
        })
        pending.add(child)
        const output: Buffer[] = []
        let size = 0,
          stopped = false,
          closed = false
        const stop = () => {
          stopped = true
          if (!closed)
            try {
              child.kill("SIGKILL")
            } catch {}
        }
        controller.signal.addEventListener("abort", stop, { once: true })
        if (controller.signal.aborted) stop()
        child.stdout?.on("data", (part: Buffer) => {
          size += part.length
          if (size > LIMIT.output) stop()
          else output.push(part)
        })
        child.once("error", () => {
          stop()
          done(undefined)
        })
        child.once("close", (code, killed) => {
          closed = true
          pending.delete(child)
          controller.signal.removeEventListener("abort", stop)
          done(!stopped && code === 0 && killed === null ? Buffer.concat(output) : undefined)
        })
      })
      check()
      if (!result) return
      const after = await step(check, () => handle.stat({ bigint: true }))
      const current = await immutable(PYTHON, check)
      check()
      if (
        current.canonical !== proof.canonical ||
        current.info.dev !== proof.info.dev ||
        current.info.ino !== proof.info.ino ||
        current.info.mtimeNs !== proof.info.mtimeNs ||
        current.info.ctimeNs !== proof.info.ctimeNs
      )
        return
      return decode(result, before, after)
    }
    // In-flight readonly filesystem IO may complete after cancellation; every continuation checks before doing more.
    // A late ChildProcess remains owned in pending until close. The caller never receives a cleanup/identity success.
    operation().then(finish, () => finish())
  })
}
