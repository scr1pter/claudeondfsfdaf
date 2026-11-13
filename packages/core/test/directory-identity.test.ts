import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { DirectoryIdentityReader } from "../src/directory-identity"
import { tmpdir } from "./fixture/tmpdir"

const basic = () => ({ dev: 2049n, ino: 123n, mode: 0o40755n })
const fact = () => ({
  v: 1,
  mask: 0x901,
  mode: 0o40755,
  dev: "2049",
  ino: "123",
  seconds: "1700000000",
  nanoseconds: 123,
})
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n")

test("positive kernel capability, not a numeric timestamp/ctime heuristic, supplies the exact same-FD identity", () => {
  expect(DirectoryIdentityReader.decode(bytes(fact()), basic(), basic())).toEqual({
    dev: "2049",
    ino: "123",
    birth: "1700000000000000123",
  })
  for (const mask of [0, 1, 0x100, 0x800, 0x101, 0x801, 0x900])
    expect(DirectoryIdentityReader.decode(bytes({ ...fact(), mask }), basic(), basic())).toBeUndefined()
  // No ctime comparison exists in this protocol: equality is legitimate when the kernel reports BTIME.
  const equal = { ...basic(), ctimeNs: 1700000000000000123n }
  expect(DirectoryIdentityReader.decode(bytes(fact()), equal, equal)?.birth).toBe(equal.ctimeNs.toString())
})

test("foreign inode/device, changed lease, nondirectory and malformed result cannot grant identity", () => {
  for (const value of [
    { ...fact(), v: 2 },
    { ...fact(), mask: 0x100000000 },
    { ...fact(), mask: 0x901 + 0.5 },
    { ...fact(), dev: "02049" },
    { ...fact(), ino: "124" },
    { ...fact(), dev: "2050" },
    { ...fact(), mode: 0o100644 },
    { ...fact(), seconds: "-1" },
    { ...fact(), seconds: "253402300800" },
    { ...fact(), nanoseconds: 1e9 },
    { ...fact(), nanoseconds: -1 },
    { ...fact(), nanoseconds: 0.5 },
    { ...fact(), surprise: true },
    { ...fact(), nanoseconds: "123" },
    { ...fact(), ino: null },
  ])
    expect(DirectoryIdentityReader.decode(bytes(value), basic(), basic())).toBeUndefined()
  for (const after of [
    { ...basic(), dev: 2n },
    { ...basic(), ino: 124n },
    { ...basic(), mode: 0o40700n },
  ])
    expect(DirectoryIdentityReader.decode(bytes(fact()), basic(), after)).toBeUndefined()
  for (const value of [
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.alloc(513),
    Buffer.from(JSON.stringify(fact())),
    Buffer.from(JSON.stringify(fact()) + " \n"),
    Buffer.from(JSON.stringify(fact()).replace('"v":1', '"v":2,"v":1') + "\n"),
  ])
    expect(DirectoryIdentityReader.decode(value, basic(), basic())).toBeUndefined()
})

function cache(
  entries: readonly { name: string; file: string; flags?: number; osversion?: number; hwcap?: bigint }[] = [
    { name: "libc.so.6", file: "/lib/x86_64-linux-gnu/libc.so.6" },
  ],
) {
  const strings = entries.flatMap((entry) => [Buffer.from(entry.name + "\0"), Buffer.from(entry.file + "\0")])
  const begin = 48 + 24 * entries.length,
    size = strings.reduce((sum, value) => sum + value.length, 0),
    value = Buffer.alloc(begin + size)
  value.write("glibc-ld.so.cache1.1", 0, "ascii")
  value[28] = 2
  value.writeUInt32LE(entries.length, 20)
  value.writeUInt32LE(size, 24)
  let at = begin
  entries.forEach((entry, index) => {
    const key = Buffer.from(entry.name + "\0"),
      file = Buffer.from(entry.file + "\0"),
      row = 48 + index * 24
    value.writeUInt32LE(entry.flags ?? 0x303, row)
    value.writeUInt32LE(at, row + 4)
    key.copy(value, at)
    at += key.length
    value.writeUInt32LE(at, row + 8)
    file.copy(value, at)
    at += file.length
    value.writeUInt32LE(entry.osversion ?? 0, row + 12)
    value.writeBigUInt64LE(entry.hwcap ?? 0n, row + 16)
  })
  return value
}
test("only bounded supported loader-cache records may identify dependency candidates", () => {
  expect(DirectoryIdentityReader.cacheLibraries(cache(), "x64").get("libc.so.6")).toEqual([
    { path: "/lib/x86_64-linux-gnu/libc.so.6", baseline: true },
  ])
  expect(DirectoryIdentityReader.cacheLibraries(cache(), "arm64").size).toBe(0)
  const named = cache([
    { name: "liba.so.10", file: "/lib/ten.so" },
    { name: "liba.so.02", file: "/lib/two.so" },
    { name: "liba.so.2", file: "/lib/other.so", hwcap: 1n << 62n },
  ])
  expect(DirectoryIdentityReader.cacheLibraries(named, "x64").get("liba.so.2")).toEqual([
    { path: "/lib/two.so", baseline: true },
    { path: "/lib/other.so", baseline: false },
  ])
  expect(() =>
    DirectoryIdentityReader.cacheLibraries(
      cache([
        { name: "liba.so.2", file: "/lib/a.so" },
        { name: "liba.so.10", file: "/lib/b.so" },
      ]),
      "x64",
    ),
  ).toThrow()
  expect(() =>
    DirectoryIdentityReader.cacheLibraries(cache([{ name: "libc.so.6", file: "/lib/c.so", flags: 0x301 }]), "x64"),
  ).toThrow()
  const endian = cache()
  endian[28] = 3
  expect(() => DirectoryIdentityReader.cacheLibraries(endian, "x64")).toThrow()
  const outside = cache()
  outside.writeUInt32LE(5, 56)
  const excess = cache()
  excess.writeUInt32LE(0xffffffff, 20)
  const malformed = cache()
  malformed[malformed.length - 1] = 65
  for (const value of [outside, excess, malformed, Buffer.alloc(48), cache().subarray(0, -1)])
    expect(() => DirectoryIdentityReader.cacheLibraries(value, "x64")).toThrow()
})
function elf() {
  const value = Buffer.alloc(256)
  Buffer.from([127, 69, 76, 70, 2, 1, 1, 0]).copy(value)
  value.writeUInt16LE(3, 16)
  value.writeUInt16LE(62, 18)
  value.writeUInt32LE(1, 20)
  value.writeUInt16LE(64, 52)
  value.writeBigUInt64LE(64n, 32)
  value.writeUInt16LE(56, 54)
  value.writeUInt16LE(2, 56)
  value.writeUInt32LE(1, 64)
  value.writeBigUInt64LE(0n, 72)
  value.writeBigUInt64LE(0n, 80)
  value.writeBigUInt64LE(256n, 96)
  value.writeUInt32LE(2, 120)
  value.writeBigUInt64LE(176n, 128)
  value.writeBigUInt64LE(64n, 152)
  value.writeBigInt64LE(1n, 176)
  value.writeBigUInt64LE(0n, 184)
  value.writeBigInt64LE(5n, 192)
  value.writeBigUInt64LE(240n, 200)
  value.writeBigInt64LE(10n, 208)
  value.writeBigUInt64LE(10n, 216)
  value.write("libc.so.6\0", 240, "ascii")
  return value
}
test("ELF metadata supplies bounded dependencies and rejects search-path/audit redirection before execution", () => {
  expect(DirectoryIdentityReader.elfDependencies(elf(), "x64").needed).toEqual(["libc.so.6"])
  const executable = elf()
  executable.writeUInt16LE(2, 16)
  executable[7] = 3
  expect(DirectoryIdentityReader.elfDependencies(executable, "x64").needed).toEqual(["libc.so.6"])
  for (const type of [0, 1, 4, 0xffff]) {
    const value = elf()
    value.writeUInt16LE(type, 16)
    expect(() => DirectoryIdentityReader.elfDependencies(value, "x64")).toThrow()
  }
  const corruptions: readonly [number, number][] = [
    [6, 0],
    [6, 2],
    [7, 255],
    [8, 1],
    [9, 1],
    [20, 0],
    [20, 2],
    [52, 0],
  ]
  for (const [offset, invalid] of corruptions) {
    const value = elf()
    value[offset] = invalid
    expect(() => DirectoryIdentityReader.elfDependencies(value, "x64")).toThrow()
  }
  for (const tag of [15n, 29n, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn]) {
    const value = elf()
    value.writeBigInt64LE(tag, 176)
    expect(() => DirectoryIdentityReader.elfDependencies(value, "x64")).toThrow()
  }
  const outside = elf()
  outside.writeBigUInt64LE(500n, 200)
  const count = elf()
  count.writeUInt16LE(129, 56)
  const unterminated = elf()
  unterminated.fill(65, 240)
  for (const value of [outside, count, unterminated, Buffer.alloc(64), elf().subarray(0, 200)])
    expect(() => DirectoryIdentityReader.elfDependencies(value, "x64")).toThrow()
  expect(() => DirectoryIdentityReader.elfDependencies(elf(), "arm64")).toThrow()
})

test("GNU ABI notes and NODEFLIB cannot make claimed baseline fall through to unverified defaults", () => {
  const value = Buffer.alloc(352),
    base = elf()
  base.copy(value, 0, 0, 176)
  value.writeUInt16LE(3, 56)
  value.writeBigUInt64LE(352n, 96)
  value.writeBigUInt64LE(240n, 128)
  value.writeUInt32LE(4, 176)
  value.writeBigUInt64LE(320n, 184)
  value.writeBigUInt64LE(32n, 208)
  base.copy(value, 240, 176, 240)
  value.writeBigUInt64LE(304n, 264)
  value.write("libc.so.6\0", 304, "ascii")
  value.writeUInt32LE(4, 320)
  value.writeUInt32LE(16, 324)
  value.writeUInt32LE(1, 328)
  value.write("GNU\0", 332, "ascii")
  value.writeUInt32LE(3, 340)
  value.writeUInt32LE(2, 344)
  expect(DirectoryIdentityReader.elfDependencies(value, "x64", 0x060800).needed).toEqual(["libc.so.6"])
  expect(() => DirectoryIdentityReader.elfDependencies(value, "x64")).toThrow()
  expect(() => DirectoryIdentityReader.elfDependencies(value, "x64", 0x020600)).toThrow()
  const foreign = Buffer.from(value)
  foreign.writeUInt32LE(1, 336)
  expect(() => DirectoryIdentityReader.elfDependencies(foreign, "x64", 0x060800)).toThrow()
  const disabled = elf()
  disabled.writeBigInt64LE(0x6ffffffbn, 176)
  disabled.writeBigUInt64LE(0x800n, 184)
  expect(() => DirectoryIdentityReader.elfDependencies(disabled, "x64", 0x060800)).toThrow()
})

const osRelease = 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n'
function installedPackage(name = "python3.12-minimal", architecture = "amd64", version = "3.12.3-1ubuntu0.17") {
  return `Package: ${name}\nStatus: install ok installed\nArchitecture: ${architecture}\nSource: python3.12\nVersion: ${version}\nDescription: trusted installed profile\n continued description\n\n`
}
test("the fixed trusted installed noble profile binds source, version and native architecture before startup", () => {
  expect(DirectoryIdentityReader.packageProfile(osRelease, installedPackage(), "x64")).toEqual({
    version: "3.12.3-1ubuntu0.17",
    architecture: "amd64",
    shared: false,
  })
  expect(
    DirectoryIdentityReader.packageProfile(
      osRelease,
      installedPackage("python3.12-minimal", "arm64") + installedPackage("libpython3.12t64", "arm64"),
      "arm64",
    ),
  ).toEqual({ version: "3.12.3-1ubuntu0.17", architecture: "arm64", shared: true })
  expect(
    DirectoryIdentityReader.packageProfile(
      osRelease,
      installedPackage("python3.12-minimal", "amd64", "3.12.3-1"),
      "x64",
    ).version,
  ).toBe("3.12.3-1")
  expect(
    DirectoryIdentityReader.packageProfile(
      osRelease,
      installedPackage().replace("Source: python3.12", "Source: python3.12 (3.12.3-1ubuntu0.17)"),
      "x64",
    ).version,
  ).toBe("3.12.3-1ubuntu0.17")
})
test("foreign, modified, duplicate, malformed or mismatched installed package identities cannot attest a compiled profile", () => {
  for (const release of [
    osRelease.replace("ubuntu", "debian"),
    osRelease.replace("24.04", "24.10"),
    osRelease.replace("noble", "oracular"),
    osRelease + "ID=ubuntu\n",
    osRelease + 'BROKEN="unterminated\n',
  ])
    expect(() => DirectoryIdentityReader.packageProfile(release, installedPackage(), "x64")).toThrow()
  for (const status of [
    installedPackage("python3.12-minimal", "arm64"),
    installedPackage("python3.12-minimal", "amd64", "3.12.3-1ubuntu0.17+local1"),
    installedPackage("python3.12-minimal", "amd64", "3.13.0-1"),
    installedPackage().replace("Source: python3.12", "Source: custom-python"),
    installedPackage().replace("Source: python3.12", "Source: python3.12 (3.12.3-1ubuntu0.16)"),
    installedPackage().replace("install ok installed", "deinstall ok config-files"),
    installedPackage().replace("Version:", "Architecture: amd64\nVersion:"),
    installedPackage() + installedPackage(),
    installedPackage() + installedPackage("libpython3.12t64", "amd64", "3.12.3-1ubuntu0.16"),
    installedPackage() + " orphaned continuation\n",
    installedPackage().replace("Package:", "Package\r:"),
    "",
  ])
    expect(() => DirectoryIdentityReader.packageProfile(osRelease, status, "x64")).toThrow()
})
test("exact immutable package membership and installed-file digest bind the interpreter or shared getpath image", () => {
  const image = Buffer.from("synthetic stock image bytes"),
    digest = createHash("md5").update(image).digest("hex")
  for (const member of [
    "/usr/bin/python3.12",
    "/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0",
    "/usr/lib/aarch64-linux-gnu/libpython3.12.so.1.0",
  ]) {
    const list = `/.\n/usr\n${member}\n`,
      sums = `${digest}  ${member.slice(1)}\n`
    expect(() => DirectoryIdentityReader.packageImage(list, sums, member, image)).not.toThrow()
    for (const candidate of [Buffer.from("modified image"), Buffer.concat([image, Buffer.from([0])])])
      expect(() => DirectoryIdentityReader.packageImage(list, sums, member, candidate)).toThrow()
    for (const malformed of [
      sums + sums,
      sums.replace(digest, "0".repeat(32)),
      sums.replace("  ", " "),
      sums.replace("usr/", "../"),
    ])
      expect(() => DirectoryIdentityReader.packageImage(list, malformed, member, image)).toThrow()
    for (const malformed of [
      list + member + "\n",
      list.replace(member, "/usr/bin/other"),
      list + "/bad/../path\n",
      list + "/bad\tpath\n",
    ])
      expect(() => DirectoryIdentityReader.packageImage(malformed, sums, member, image)).toThrow()
    expect(() => DirectoryIdentityReader.packageImage(list, sums, "/usr/bin/custom-python", image)).toThrow()
  }
})
test("the exact stock noble extension profile requires native ctypes while struct stays in the bound image", () => {
  const x64 = "/usr/lib/python3.12/lib-dynload/_ctypes.cpython-312-x86_64-linux-gnu.so",
    arm64 = "/usr/lib/python3.12/lib-dynload/_ctypes.cpython-312-aarch64-linux-gnu.so",
    struct = "/usr/lib/python3.12/lib-dynload/_struct.cpython-312-x86_64-linux-gnu.so"
  expect(DirectoryIdentityReader.extensionProfile([x64], "x64")).toBe(x64)
  expect(DirectoryIdentityReader.extensionProfile([arm64], "arm64")).toBe(arm64)
  for (const profile of [
    [],
    [arm64],
    [x64, x64],
    [x64, struct],
    [struct],
    [x64.replace("/usr/lib/", "/usr/local/lib/")],
  ])
    expect(() => DirectoryIdentityReader.extensionProfile(profile, "x64")).toThrow()
  expect(() => DirectoryIdentityReader.extensionProfile([x64], "arm64")).toThrow()
})
function traceMask(text: string) {
  const names = new Map([
    ["STATX_TYPE", 1],
    ["STATX_MODE", 2],
    ["STATX_NLINK", 4],
    ["STATX_UID", 8],
    ["STATX_GID", 16],
    ["STATX_ATIME", 32],
    ["STATX_MTIME", 64],
    ["STATX_CTIME", 128],
    ["STATX_INO", 256],
    ["STATX_SIZE", 512],
    ["STATX_BLOCKS", 1024],
    ["STATX_BTIME", 2048],
    ["STATX_MNT_ID", 4096],
    ["STATX_DIOALIGN", 8192],
    ["STATX_BASIC_STATS", 0x7ff],
    ["STATX_ALL", 0xfff],
  ])
  let result = 0
  const seen = new Set<string>()
  for (const token of text.split("|").map((value) => value.trim())) {
    if (!token || seen.has(token)) return
    seen.add(token)
    const value = names.get(token) ?? (/^(?:0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(token) ? Number(token) : undefined)
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return
    result = (result | value) >>> 0
  }
  return result
}
function traceProof(text: string, birth: boolean) {
  let close: number | undefined
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^close_range\(4, (?:4294967295|~0U), 0\)\s+= 0$/.test(line)) close = index
    const call = /^statx\(3, "", ([^,]+), ([^,]+), \{stx_mask=([^,}]+),.*\}\)\s+= 0$/.exec(line)
    if (!call || close === undefined || close >= index) continue
    const flags = call[1].split("|").map((flag) => flag.trim())
    if (
      !flags.includes("AT_EMPTY_PATH") ||
      new Set(flags).size !== flags.length ||
      flags.some((flag) => flag !== "AT_EMPTY_PATH" && flag !== "AT_STATX_SYNC_AS_STAT") ||
      traceMask(call[2]) !== DirectoryIdentityReader.MASK
    )
      continue
    const mask = traceMask(call[3])
    if (mask === undefined || (mask & 0x101) !== 0x101 || ((mask & 0x800) !== 0) !== birth) continue
    return { close, statx: index, mask }
  }
}
test("actual strace statx flags preserve exact same-FD empty-path and capability semantics", () => {
  const close = "close_range(4, 4294967295, 0) = 0\n",
    call =
      'statx(3, "", AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH, STATX_TYPE|STATX_INO|STATX_BTIME, {stx_mask=STATX_ALL|STATX_MNT_ID, stx_blksize=4096}) = 0'
  for (const flags of ["AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH", "AT_EMPTY_PATH|AT_STATX_SYNC_AS_STAT", "AT_EMPTY_PATH"])
    expect(traceProof(close + call.replace("AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH", flags), true)).toEqual({
      close: 0,
      statx: 1,
      mask: 0x1fff,
    })
  expect(
    traceProof(close + call.replace("STATX_ALL|STATX_MNT_ID", "STATX_BASIC_STATS|STATX_MNT_ID"), false)?.mask,
  ).toBe(0x17ff)
  expect(traceProof(close.replace("4294967295", "~0U") + call, true)?.mask).toBe(0x1fff)
  expect(traceProof(close + call.replace("STATX_ALL|STATX_MNT_ID", "0x1fff"), true)?.mask).toBe(0x1fff)
  for (const broken of [
    call + "\n" + close,
    close.replace("= 0", "= -1 EPERM (Operation not permitted)") + call,
    close.replace("close_range(4", "close_range(5") + call,
    close + call.replace("statx(3", "statx(4"),
    close + call.replace('3, ""', '3, "foreign"'),
    ...[
      "AT_STATX_SYNC_AS_STAT",
      "AT_STATX_FORCE_SYNC|AT_EMPTY_PATH",
      "AT_STATX_DONT_SYNC|AT_EMPTY_PATH",
      "AT_EMPTY_PATH|AT_NO_AUTOMOUNT",
    ].map((flags) => close + call.replace("AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH", flags)),
    close + call.replace("STATX_TYPE|STATX_INO|STATX_BTIME", "STATX_TYPE|STATX_INO"),
    close + call.replace("STATX_ALL|STATX_MNT_ID", "STATX_INO|STATX_BTIME"),
    close + call.replace("STATX_ALL|STATX_MNT_ID", "STATX_BASIC_STATS|STATX_MNT_ID"),
    close + call.replace("STATX_ALL|STATX_MNT_ID", "STATX_UNKNOWN"),
    close + call.replace("= 0", "= -1 ENOSYS (Function not implemented)"),
  ])
    expect(traceProof(broken, true)).toBeUndefined()
  expect(traceProof(close + call, false)).toBeUndefined()
})
// Root runs only these contract cases locally. Actual execution is manual CI-only; this test switch grants no runtime authority.
const ci = test.skipIf(process.env.VECTOR_DIRECTORY_IDENTITY_CI !== "1" || process.platform !== "linux")

test("a cancelled, expired or invalid image-lease request refuses before runtime discovery", async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  expect(await DirectoryIdentityReader.pythonImage(performance.now() + 10_000, cancelled.signal)).toBeUndefined()
  expect(await DirectoryIdentityReader.pythonImage(performance.now() - 1)).toBeUndefined()
  expect(await DirectoryIdentityReader.pythonImage(NaN)).toBeUndefined()
})

ci(
  "an image lease is scope-local, freshly checked for each launch and permanently retired on close",
  async () => {
    const cancelled = new AbortController()
    const image = await DirectoryIdentityReader.pythonImage(performance.now() + 10_000, cancelled.signal)
    expect(image).toBeDefined()
    if (!image) throw new Error("Actual installed runtime did not qualify")
    try {
      expect(image.isOpen()).toBe(true)
      expect(await image.validate(performance.now() + 10_000)).toBe(true)
      expect(await image.validate(performance.now() - 1)).toBe(false)
      const aborted = new AbortController()
      aborted.abort()
      expect(await image.validate(performance.now() + 10_000, aborted.signal)).toBe(false)
      cancelled.abort()
      expect(image.isOpen()).toBe(false)
      expect(await image.validate(performance.now() + 10_000)).toBe(false)
    } finally {
      image.close()
    }
    expect(image.isOpen()).toBe(false)
    expect(await image.validate(performance.now() + 10_000)).toBe(false)
  },
  30_000,
)
const WRAPPER = String.raw`import os, sys, resource
resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
secret = os.open(sys.argv[1], os.O_RDONLY)
os.dup2(secret, 3, inheritable=True)
os.dup2(secret, 2003, inheritable=True)
os.set_inheritable(3, True)
os.set_inheritable(2003, True)
if not (os.get_inheritable(3) and os.get_inheritable(2003)):
    os._exit(125)
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 4096))
os.execve(sys.argv[2], sys.argv[2:], {"PATH":"/usr/bin:/bin","LC_ALL":"C"})
`
const owned = new Map<string, string>()
async function witnessDirectory() {
  if (owned.size) throw new Error("A prior CI service has unconfirmed cleanup; refusing more witnesses")
  const temporary = await tmpdir()
  return {
    path: temporary.path,
    async [Symbol.asyncDispose]() {
      // Keep synthetic files while any service/launcher could still use them. Never hide a leak by disposal.
      if ([...owned.values()].includes(temporary.path))
        throw new Error("CI service cleanup is unconfirmed; retaining its temporary tree and controller ownership")
      await temporary[Symbol.asyncDispose]()
    },
  }
}
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const unsupportedObserver = (text: string) => text.split(/\r?\n/).some((line) => /^strace:[^\r\n]*seccomp/i.test(line))
function diagnostic(text: string) {
  if (unsupportedObserver(text)) return { stage: "strace-filter", class: "Unsupported", code: "SECCOMP_UNAVAILABLE" }
  const fixtures = new Map([
    ["Missing CI fixture inputs", "fixture-input"],
    ["No actual lowered descriptor limit", "fixture-prlimit"],
    ["Missing actual inherited private descriptor", "fixture-private-fd"],
    ["Missing actual child start identity", "fixture-child-start"],
    ["Missing actual replacement repository", "fixture-replacement"],
    ["Wrong actual pinned directory", "fixture-directory"],
    ["Actual proof child was not reaped", "fixture-child-reap"],
    ["First anonymous runtime proof was unavailable", "fixture-parent-positive"],
    ["Missing anonymous runtime mount proof", "fixture-parent-mount"],
    ["A new read reused stale runtime parent authority", "fixture-parent-reuse"],
  ])
  // Match only an emitted error line, never the quoted source excerpts printed with a stack trace.
  const fixture = [...text.matchAll(/^[ \t]*(?:Error|error): ([^\r\n]*)$/gm)]
    .map((line) => fixtures.get(line[1]))
    .find((stage) => stage !== undefined)
  const names = [
    "ArgumentError",
    "BlockingIOError",
    "FileNotFoundError",
    "ImportError",
    "ModuleNotFoundError",
    "OSError",
    "PermissionError",
    "RuntimeError",
    "SyntaxError",
    "TypeError",
    "ValueError",
    "RangeError",
    "ReferenceError",
    "Error",
  ] as const
  const python = /Traceback \(most recent call last\)|Fatal Python error:/.test(text),
    stage =
      fixture ??
      (/(?:^|\n)strace:/.test(text)
        ? "strace"
        : python
          ? "python-wrapper"
          : /(?:^|\n)(?:Failed to |Unknown assignment|Job for )/.test(text)
            ? "systemd"
            : "runtime-fixture")
  const kind = fixture
    ? "Error"
    : (names.find((name) => new RegExp(`(?:^|\\n)(?:ctypes\\.)?${name}(?::| \\[)`).test(text)) ?? "Unknown")
  const number = /\[Errno ([0-9]{1,3})\]/.exec(text)?.[1]
  const errors = new Map([
    ["1", "EPERM"],
    ["2", "ENOENT"],
    ["9", "EBADF"],
    ["12", "ENOMEM"],
    ["13", "EACCES"],
    ["22", "EINVAL"],
    ["23", "ENFILE"],
    ["24", "EMFILE"],
    ["38", "ENOSYS"],
  ])
  const codes = [
    "ERR_MODULE_NOT_FOUND",
    "ERR_UNKNOWN_BUILTIN_MODULE",
    "ERR_INVALID_ARG_TYPE",
    "ERR_OUT_OF_RANGE",
    "ERR_ACCESS_DENIED",
    "ERR_UNKNOWN_FILE_EXTENSION",
    "ERR_REQUIRE_ESM",
    "ERR_DLOPEN_FAILED",
    "EBADF",
    "EACCES",
    "ENOENT",
    "EPERM",
    "EMFILE",
    "ENFILE",
    "ENOSYS",
    "EINVAL",
  ] as const
  const phrases = [
    ["No such file or directory", "ENOENT"],
    ["Permission denied", "EACCES"],
    ["Operation not permitted", "EPERM"],
    ["Bad file descriptor", "EBADF"],
    ["Too many open files", "EMFILE"],
    ["Function not implemented", "ENOSYS"],
    ["Invalid argument", "EINVAL"],
  ] as const
  const code = number
    ? (errors.get(number) ?? "Unknown")
    : (codes.find((code) => new RegExp(`\\b${code}\\b`).test(text)) ??
      phrases.find(([phrase]) => text.includes(phrase))?.[1] ??
      "Unknown")
  return { stage, class: kind, code }
}
test("CI failure diagnostics expose only fixed metadata and never echo stderr paths, environment or body", () => {
  expect(
    diagnostic(
      'Traceback (most recent call last):\n  File "/private/example.py", line 1\nOSError: [Errno 9] private body and environment=value',
    ),
  ).toEqual({ stage: "python-wrapper", class: "OSError", code: "EBADF" })
  expect(diagnostic("node:internal/modules/example\nError: private body\n  code: 'ERR_MODULE_NOT_FOUND'")).toEqual({
    stage: "runtime-fixture",
    class: "Error",
    code: "ERR_MODULE_NOT_FOUND",
  })
  expect(diagnostic("strace: private/path: Permission denied")).toEqual({
    stage: "strace",
    class: "Unknown",
    code: "EACCES",
  })
  expect(diagnostic("Failed to start private-unit.service: private body")).toEqual({
    stage: "systemd",
    class: "Unknown",
    code: "Unknown",
  })
  const secret = "PRIVATE_VALUE_THAT_MUST_NEVER_BE_LOGGED"
  expect(JSON.stringify(diagnostic(secret.repeat(100)))).not.toContain(secret)
  expect(diagnostic(secret)).toEqual({ stage: "runtime-fixture", class: "Unknown", code: "Unknown" })
  for (const message of [
    "strace: seccomp filter is requested but unavailable",
    "strace: Seccomp filter is requested but there are no syscalls to filter.  See -e trace to filter syscalls.",
    "strace: --seccomp-bpf cannot be used without -f/--follow-forks, disabling",
    "strace: --seccomp-bpf is not enabled because it is not compatible with --syscall-limit",
    "strace: prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER): Operation not permitted",
  ]) {
    expect(unsupportedObserver(message)).toBe(true)
    expect(diagnostic(message + " " + secret)).toEqual({
      stage: "strace-filter",
      class: "Unsupported",
      code: "SECCOMP_UNAVAILABLE",
    })
    expect(unsupportedObserver(`20 | const source = "${message}"`)).toBe(false)
    expect(JSON.stringify(diagnostic(message + " " + secret))).not.toContain(secret)
  }
  for (const [message, stage] of [
    ["Missing CI fixture inputs", "fixture-input"],
    ["No actual lowered descriptor limit", "fixture-prlimit"],
    ["Missing actual inherited private descriptor", "fixture-private-fd"],
    ["Missing actual child start identity", "fixture-child-start"],
    ["Missing actual replacement repository", "fixture-replacement"],
    ["Wrong actual pinned directory", "fixture-directory"],
    ["Actual proof child was not reaped", "fixture-child-reap"],
    ["First anonymous runtime proof was unavailable", "fixture-parent-positive"],
    ["Missing anonymous runtime mount proof", "fixture-parent-mount"],
    ["A new read reused stale runtime parent authority", "fixture-parent-reuse"],
  ]) {
    for (const prefix of ["Error", "error"])
      expect(diagnostic(`${prefix}: ${message}\n    at /private/example.js:1:1`)).toEqual({
        stage,
        class: "Error",
        code: "Unknown",
      })
    expect(diagnostic(`20 | throw new Error("${message}")\nError: ${secret}`).stage).toBe("runtime-fixture")
    expect(JSON.stringify(diagnostic(`Error: ${message} ${secret}`))).not.toContain(secret)
    expect(diagnostic(`Error: ${message} ${secret}`).stage).toBe("runtime-fixture")
  }
  expect(diagnostic(`Error: EINVAL: invalid argument, read /private/file\n  code: 'EINVAL'`)).toEqual({
    stage: "runtime-fixture",
    class: "Error",
    code: "EINVAL",
  })
})
async function control(operation: "stop" | "kill" | "reset-failed", unit: string) {
  return await new Promise<number | null>((resolve, reject) => {
    const options = operation === "kill" ? ["--kill-whom=all", "--signal=SIGKILL"] : []
    // The timeout runs as root too. A wedged systemctl cannot outlive this finite control invocation.
    const child = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/timeout",
        "--signal=KILL",
        "6s",
        "/usr/bin/systemctl",
        "--no-pager",
        "--no-ask-password",
        ...options,
        operation,
        unit,
      ],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: "ignore" },
    )
    child.once("error", reject)
    child.once("close", resolve)
  })
}
async function run(
  command: string[],
  environment: Record<string, string>,
  options: { directory: string; root?: boolean },
) {
  if (
    (await fs.statfs("/sys/fs/cgroup", { bigint: true })).type !== 0x63677270n ||
    !(await fs.stat("/run/systemd/system")).isDirectory()
  )
    throw new Error("Actual CI witnesses require systemd and cgroup v2; no weaker lifetime fallback")
  const unit = `vector-directory-identity-${randomUUID().replaceAll("-", "")}.service`,
    group = `/sys/fs/cgroup/system.slice/${unit}`,
    permit = path.join(options.directory, unit + ".permit")
  const user = options.root ? 0 : process.getuid?.(),
    gid = options.root ? 0 : process.getgid?.()
  if (user === undefined || gid === undefined) throw new Error("Missing actual CI process identity")
  for (const [key, value] of Object.entries(environment))
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) throw new Error("Invalid fixed CI environment")
  await fs.writeFile(permit, "one launch\n", { flag: "wx", mode: 0o600 })
  owned.set(unit, options.directory)
  let child: ReturnType<typeof spawn> | undefined,
    closed = false,
    output = "",
    size = 0,
    errorOutput = "",
    errorSize = 0,
    failure: "timeout" | "stdout-bound" | "stderr-bound" | "spawn" | "observer-unavailable" | undefined
  let release: ((code: number | null) => void) | undefined
  const completion = new Promise<number | null>((resolve) => {
    release = resolve
  })
  let wake: (() => void) | undefined
  const event = new Promise<void>((resolve) => {
    wake = resolve
  })
  const timer = setTimeout(() => {
    failure = "timeout"
    wake?.()
  }, 30_000)
  try {
    child = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/systemd-run",
        "--quiet",
        "--wait",
        "--pipe",
        "--expand-environment=no",
        `--unit=${unit}`,
        "--slice=system.slice",
        "--service-type=exec",
        "--property=KillMode=control-group",
        "--property=ExitType=cgroup",
        "--property=RuntimeMaxSec=20s",
        "--property=TimeoutStopSec=2s",
        "--property=SendSIGKILL=yes",
        "--property=Delegate=no",
        `--property=User=${user}`,
        `--property=Group=${gid}`,
        "--property=WorkingDirectory=/",
        `--property=ConditionPathExists=${permit}`,
        "/usr/bin/env",
        "-i",
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...command,
      ],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] },
    )
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) {
        failure = "stdout-bound"
        wake?.()
      } else output += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const available = Math.max(0, 4096 - errorSize)
      errorOutput += chunk.subarray(0, available).toString()
      errorSize += chunk.length
      if (errorSize > 4096) {
        failure = "stderr-bound"
        wake?.()
      } else if (unsupportedObserver(errorOutput)) {
        failure = "observer-unavailable"
        wake?.()
      }
    })
    child.once("error", () => {
      failure = "spawn"
      wake?.()
    })
    child.once("close", (code) => {
      closed = true
      release?.(code)
      wake?.()
    })
    await event
  } catch {
    failure = "spawn"
  } finally {
    clearTimeout(timer)
    // Remove the condition FIRST: delayed registration may never start its payload after cancellation.
    await fs.rm(permit, { force: true })
    await control("stop", unit)
    await control("kill", unit)
    const deadline = performance.now() + 3000
    let empty = false
    do {
      empty = await fs.readFile(path.join(group, "cgroup.events"), "utf8").then(
        (value) => /^populated 0$/m.test(value),
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return true // Kernel removal of this exact cgroup proves it has no members/descendants.
        },
      )
      if (empty) break
      await pause(25)
    } while (performance.now() < deadline)
    if (!child) closed = true // A synchronous spawn refusal created no launcher or service request.
    if (!closed && child) {
      child.kill("SIGTERM")
      await Promise.race([completion, pause(1000)])
      if (!closed) {
        child.kill("SIGKILL")
        await Promise.race([completion, pause(1000)])
      }
    }
    if (!empty || !closed) throw new Error("Owned CI service/launcher cleanup is unconfirmed")
    await control("reset-failed", unit)
    owned.delete(unit)
  }
  const code = child ? await completion : null
  // The private stderr buffer never leaves this classifier. Emit only fixed enum metadata after cleanup.
  if (failure || code !== 0)
    throw new Error(
      `CI_WITNESS_FAILURE ${JSON.stringify({ exit: code, reason: failure ?? "exit", ...diagnostic(errorOutput) })}`,
    )
  return { code, output }
}

for (const name of ["node", "bun"] as const)
  test.skipIf(process.env.VECTOR_READONLY_GIT_INTEGRITY_CI !== "1" || process.platform !== "linux")(
    `actual ${name} parent FD exhaustion refuses safely after native spawn failure and recovers its admission`,
    async () => {
      await using temporary = await witnessDirectory()
      const entry = path.join(temporary.path, "exhaustion.ts")
      await fs.writeFile(
        entry,
        `
import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {ReadOnlyGit} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/read-only-git.ts"))}
const directory=process.argv[2]
if(!directory||!process.getuid?.()) throw new Error("This control requires an actual nonroot process")
fs.mkdirSync(directory)
const env={PATH:"/usr/bin:/bin",HOME:directory,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}
const git=(args)=>execFileSync("/usr/bin/git",["-C",directory,...args],{env,stdio:"ignore"})
git(["init","-q"])
fs.writeFileSync(path.join(directory,"probe.txt"),"owned fixture\\n")
git(["add","probe.txt"])
git(["-c","user.name=Fixture","-c","user.email=fixture@vector.test","-c","commit.gpgsign=false","commit","-q","-m","Fixture"])
const repository=await ReadOnlyGit.open({directory,gitDirectory:path.join(directory,".git"),commonDirectory:path.join(directory,".git")})
const held=[]
let refused=false
try {
  try {for(;;)held.push(fs.openSync("/dev/null","r"))}
  catch(error){assert.equal(error.code,"EMFILE")}
  assert.ok(held.length>16)
  const spare=held.pop()
  if(spare===undefined)throw new Error("Missing actual spare descriptor")
  fs.closeSync(spare)
  try {await repository.read({kind:"object",action:"size",revision:"HEAD",file:"probe.txt"})}
  catch(error){assert.ok(error instanceof ReadOnlyGit.Unavailable);refused=true}
} finally {for(const fd of held)fs.closeSync(fd)}
assert.equal(refused,true)
const recovered=await repository.read({kind:"object",action:"size",revision:"HEAD",file:"probe.txt"})
assert.equal(recovered.code,0)
await repository.close()
assert.equal(repository.isOpen(),false)
process.stdout.write(JSON.stringify({refused:true,recovered:true,closed:true})+"\\n")
`,
      )
      const built = await Bun.build({
        entrypoints: [entry],
        target: "node",
        outdir: temporary.path,
        naming: "exhaustion.mjs",
      })
      expect(built.success).toBe(true)
      const runtime = Bun.which(name)
      if (!runtime) throw new Error("Missing actual CI runtime")
      const trace = path.join(temporary.path, "exhaustion.trace")
      const result = await run(
        [
          "strace",
          "--seccomp-bpf",
          "-f",
          "-s",
          "96",
          "-e",
          "trace=pipe,pipe2,socketpair,execve",
          "-o",
          trace,
          "/usr/bin/prlimit",
          "--nofile=128:128",
          await fs.realpath(runtime),
          path.join(temporary.path, "exhaustion.mjs"),
          path.join(temporary.path, "repository"),
        ],
        { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        { directory: temporary.path },
      )
      expect(result.code).toBe(0)
      expect(JSON.parse(result.output)).toEqual({ refused: true, recovered: true, closed: true })
      expect(await fs.readFile(trace, "utf8")).toMatch(/(?:pipe2?|socketpair)(?:\(| resumed>)[^\n]*EMFILE/)
    },
    30_000,
  )

for (const name of ["node", "bun"] as const)
  for (const scenario of [
    "positive",
    "unsupported",
    "timeout",
    "cancel-preflight",
    "cancel-child",
    "metadata-race",
  ] as const)
    ci(
      `actual ${name}/${scenario} uses fixed sameFD proof with privateFD3/highFD above actual loweredlimit and scrubbed startup hooks`,
      async () => {
        await using temporary = await witnessDirectory()
        const target = path.join(temporary.path, "directory"),
          proof = path.join(temporary.path, "private.txt"),
          marker = path.join(temporary.path, "poisoned")
        await fs.mkdir(target)
        await fs.writeFile(proof, createHash("sha256").update(temporary.path).digest("hex"))
        await fs.writeFile(
          path.join(temporary.path, "ctypes.py"),
          `open(${JSON.stringify(marker)},'w').write('bad')\nraise RuntimeError('untrusted')\n`,
        )
        await fs.copyFile(path.join(temporary.path, "ctypes.py"), path.join(temporary.path, "sitecustomize.py"))
        const built = await Bun.build({
          entrypoints: [path.join(import.meta.dir, "fixture/directory-identity.ts")],
          target: "node",
          outdir: temporary.path,
          naming: "witness.mjs",
        })
        expect(built.success).toBe(true)
        const fixture = path.join(temporary.path, "witness.mjs")
        const replacement = path.join(temporary.path, "replacement")
        if (scenario === "metadata-race") {
          await fs.mkdir(replacement)
          const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
          for (const folder of [target, replacement]) {
            expect((await run(["/usr/bin/git", "init", "-q", folder], env, { directory: temporary.path })).code).toBe(0)
            expect(
              (
                await run(
                  [
                    "/usr/bin/git",
                    "-C",
                    folder,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@vector.test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "root",
                  ],
                  env,
                  { directory: temporary.path },
                )
              ).code,
            ).toBe(0)
          }
        }
        const runtime = Bun.which(name)
        if (!runtime) throw new Error("Missing actual CI runtime")
        const command = [
          "/usr/bin/python3",
          "-I",
          "-S",
          "-c",
          WRAPPER,
          proof,
          await fs.realpath(runtime),
          fixture,
          scenario === "unsupported" ? "/proc" : target,
          proof,
          scenario,
          replacement,
        ]
        const traced = await run(
          [
            "strace",
            "--seccomp-bpf",
            "-f",
            "-ff",
            "-s",
            "64",
            "-e",
            "trace=statx,close_range,execve,wait4,waitid,kill",
            "-o",
            path.join(temporary.path, "trace"),
            ...command,
          ],
          { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
          { directory: temporary.path },
        )
        expect(traced.code).toBe(0)
        const result: unknown = JSON.parse(traced.output)
        expect(result).toMatchObject({
          runtime: name,
          inheritedPrivateDescriptors: [3, 2003],
          value:
            scenario === "positive"
              ? { dev: expect.any(String), ino: expect.any(String), birth: expect.any(String) }
              : null,
          loweredLimit: 256,
        })
        expect(
          await fs.lstat(marker).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        const traces = await Promise.all(
          (await fs.readdir(temporary.path))
            .filter((file) => file.startsWith("trace."))
            .map((file) => fs.readFile(path.join(temporary.path, file), "utf8")),
        )
        if (scenario === "positive" || scenario === "unsupported") {
          const helper = traces.flatMap((text) => {
            const proof = traceProof(text, scenario === "positive")
            return proof ? [proof] : []
          })[0]
          expect(helper).toBeDefined()
          if (!helper) throw new Error("Missing actual fixed helper syscall witness")
          expect(helper.close).toBeLessThan(helper.statx)
          expect(helper.mask & DirectoryIdentityReader.MASK).toBe(scenario === "positive" ? 0x901 : 0x101)
        }
        if (scenario === "cancel-preflight") expect(result).toMatchObject({ observedChild: false })
        if (scenario === "metadata-race") expect(result).toMatchObject({ observedChild: true, rejected: true })
        if (scenario === "timeout" || scenario === "cancel-child") {
          expect(result).toMatchObject({ observedChild: true })
          expect(traces.some((text) => text.includes("killed by SIGKILL"))).toBe(true)
          expect(traces.some((text) => /wait4\(|waitid\(/.test(text) && text.includes("SIGKILL"))).toBe(true)
        }
      },
      60_000,
    )

// Root-only CI runs this inside a private mount namespace. It never changes the host's Python or stdlib.
const POISON_RUNTIME = String.raw`import os, sys, ctypes, resource
libc = ctypes.CDLL(None, use_errno=True)
libc.unshare.argtypes = (ctypes.c_int,)
libc.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
if os.geteuid() != 0 or libc.unshare(0x20000) != 0 or libc.mount(None, b"/", None, 0x4000 | 0x40000, None) != 0:
    os._exit(125)
kind = sys.argv[1]
replacement = sys.argv[2]
if kind in {"binary", "module", "cache", "cache-baseline", "image", "package-record"}:
    target = {"binary":b"/usr/bin/python3.12", "module":b"/usr/lib/python3.12/ctypes/__init__.py", "cache":b"/etc/ld.so.cache", "cache-baseline":b"/etc/ld.so.cache", "image":b"/usr/bin/python3.12", "package-record":b"/var/lib/dpkg/info/python3.12-minimal.md5sums"}[kind]
    with open(target, "rb") as source:
        original = source.read()
    changed = original
    if kind == "cache":
        changed = b"X" + original[1:]
    elif kind == "cache-baseline":
        if len(original) < 48 or original[:20] != b"glibc-ld.so.cache1.1":
            os._exit(125)
        count = int.from_bytes(original[20:24], "little")
        if not 0 < count <= 16384 or 48 + count * 24 > len(original):
            os._exit(125)
        changed = bytearray(original)
        for index in range(count):
            at = 48 + index * 24 + 12
            changed[at:at+4] = (1).to_bytes(4, "little")
    elif kind == "image":
        changed = original + b"\0"
    elif kind == "package-record":
        lines = original.splitlines(keepends=True)
        found = 0
        for index, line in enumerate(lines):
            if line[32:] == b"  usr/bin/python3.12\n":
                lines[index] = b"0" * 32 + line[32:]
                found += 1
        if found != 1:
            os._exit(125)
        changed = b"".join(lines)
    with open(replacement, "wb") as output:
        output.write(changed)
    os.chmod(replacement, 0o755 if kind == "image" else 0o644 if kind in {"cache", "cache-baseline", "package-record"} else 0o777)
    if libc.mount(os.fsencode(replacement), target, None, 0x1000, None) != 0:
        os._exit(125)
else:
    if kind not in {"adjacent-pth", "pyvenv", "builddir", "parent-recheck"}:
        os._exit(125)
    # New override names are created ONLY on an anonymous private tmpfs, never on the host's /usr/bin.
    files = {"python3.12":"/usr/bin/python3.12", "prlimit":"/usr/bin/prlimit"}
    if os.path.dirname(sys.argv[4]) == "/usr/bin":
        files[os.path.basename(sys.argv[4])] = sys.argv[4]
    captured = {}
    for name, filename in files.items():
        with open(filename, "rb") as source:
            captured[name] = source.read()
    os.mkdir(replacement, 0o755)
    if libc.mount(b"tmpfs", os.fsencode(replacement), b"tmpfs", 0, b"mode=0755") != 0:
        os._exit(125)
    for name, content in captured.items():
        with open(os.path.join(replacement, name), "wb") as output:
            output.write(content)
        os.chmod(os.path.join(replacement, name), 0o755)
    os.symlink("python3.12", os.path.join(replacement, "python3"))
    if kind == "parent-recheck":
        with open(os.path.join(replacement, ".vector-identity-private-runtime"), "w") as output:
            output.write("anonymous-fixture-only\n")
    else:
        override = {"adjacent-pth":"python3.12._pth", "pyvenv":"pyvenv.cfg", "builddir":"pybuilddir.txt"}[kind]
        with open(os.path.join(replacement, override), "w") as output:
            poison = os.path.dirname(sys.argv[3])
            output.write({"adjacent-pth":"/usr/lib/python3.12\n/usr/lib/python3.12/lib-dynload\n" + poison + "\nimport site\n", "pyvenv":"home = " + poison + "\n", "builddir":poison + "\n"}[kind])
    if libc.mount(os.fsencode(replacement), b"/usr/bin", None, 0x1000, None) != 0:
        os._exit(125)
resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
secret = os.open(sys.argv[3], os.O_RDONLY)
os.dup2(secret, 3, inheritable=True)
os.dup2(secret, 2003, inheritable=True)
os.set_inheritable(3, True)
os.set_inheritable(2003, True)
if not (os.get_inheritable(3) and os.get_inheritable(2003)):
    os._exit(125)
os.execve(sys.argv[4], sys.argv[4:], {"PATH":"/usr/bin:/bin","LC_ALL":"C"})
`
const rootCI = test.skipIf(
  process.env.VECTOR_DIRECTORY_IDENTITY_CI !== "1" ||
    process.env.VECTOR_DIRECTORY_IDENTITY_ROOT_CI !== "1" ||
    process.platform !== "linux",
)

const CACHE_LEASE_NAMESPACE = String.raw`import os, sys, ctypes
libc=ctypes.CDLL(None,use_errno=True)
libc.unshare.argtypes=(ctypes.c_int,)
libc.mount.argtypes=(ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p)
if os.geteuid()!=0 or libc.unshare(0x20000)!=0 or libc.mount(None,b"/",None,0x4000|0x40000,None)!=0:
    os._exit(125)
os.execve(sys.argv[1],sys.argv[1:],{"PATH":"/usr/bin:/bin","LC_ALL":"C"})
`
for (const name of ["node", "bun"] as const)
  test.skipIf(
    process.env.VECTOR_READONLY_GIT_INTEGRITY_CI !== "1" ||
      process.env.VECTOR_DIRECTORY_IDENTITY_ROOT_CI !== "1" ||
      process.platform !== "linux",
  )(
    `an actual ${name} cache rebind in a private mount namespace retires the parsed image graph before another launch`,
    async () => {
      await using temporary = await witnessDirectory()
      const entry = path.join(temporary.path, "cache-lease.ts")
      await fs.writeFile(
        entry,
        `
import fs from "node:fs/promises"
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {DirectoryIdentityReader} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/directory-identity.ts"))}
const image=await DirectoryIdentityReader.pythonImage(performance.now()+10000)
assert.ok(image)
try {
  assert.equal(await image.validate(performance.now()+10000),true)
  const before=await fs.stat("/etc/ld.so.cache",{bigint:true})
  const bytes=await fs.readFile("/etc/ld.so.cache")
  await fs.writeFile(process.argv[2],bytes,{mode:0o644,flag:"wx"})
  execFileSync("/usr/bin/python3",["-I","-S","-c",${JSON.stringify(String.raw`import os,sys,ctypes
libc=ctypes.CDLL(None,use_errno=True)
libc.mount.argtypes=(ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p)
if libc.mount(os.fsencode(sys.argv[1]),b"/etc/ld.so.cache",None,0x1000,None)!=0:
    os._exit(125)
`)},process.argv[2]],{env:{PATH:"/usr/bin:/bin",LC_ALL:"C"},stdio:"ignore"})
  const after=await fs.stat("/etc/ld.so.cache",{bigint:true})
  assert.ok(before.dev!==after.dev||before.ino!==after.ino)
  assert.ok((await fs.readFile("/etc/ld.so.cache")).equals(bytes))
  assert.equal(await image.validate(performance.now()+10000),false)
  process.stdout.write(JSON.stringify({initial:true,changed:true,refused:true})+"\\n")
}finally{image.close()}
`,
      )
      expect(
        (await Bun.build({ entrypoints: [entry], target: "node", outdir: temporary.path, naming: "cache-lease.mjs" }))
          .success,
      ).toBe(true)
      const runtime = Bun.which(name)
      if (!runtime) throw new Error("Missing actual CI runtime")
      const result = await run(
        [
          "/usr/bin/python3",
          "-I",
          "-S",
          "-c",
          CACHE_LEASE_NAMESPACE,
          await fs.realpath(runtime),
          path.join(temporary.path, "cache-lease.mjs"),
          path.join(temporary.path, "cache-replacement"),
        ],
        { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        { directory: temporary.path, root: true },
      )
      expect(result.code).toBe(0)
      expect(JSON.parse(result.output)).toEqual({ initial: true, changed: true, refused: true })
    },
    30_000,
  )

for (const name of ["node", "bun"] as const)
  for (const poison of [
    "binary",
    "module",
    "image",
    "package-record",
    "cache",
    "cache-baseline",
    "adjacent-pth",
    "pyvenv",
    "builddir",
    "parent-recheck",
  ] as const)
    rootCI(
      poison === "parent-recheck"
        ? `actual ${name} rechecks anonymous runtime parent authority on a second read without another helper spawn`
        : `actual ${name} refuses ${poison} runtime provenance in a private mount namespace before launching the proof helper`,
      async () => {
        await using temporary = await witnessDirectory()
        const target = path.join(temporary.path, "directory"),
          proof = path.join(temporary.path, "private.txt"),
          replacement = path.join(temporary.path, "runtime-copy"),
          marker = path.join(temporary.path, "untrusted-startup-ran")
        await fs.mkdir(target)
        await fs.writeFile(proof, "synthetic-private-channel-only")
        await fs.writeFile(
          path.join(temporary.path, "sitecustomize.py"),
          `open(${JSON.stringify(marker)},'w').write('bad')\n`,
        )
        const built = await Bun.build({
          entrypoints: [path.join(import.meta.dir, "fixture/directory-identity.ts")],
          target: "node",
          outdir: temporary.path,
          naming: "witness.mjs",
        })
        expect(built.success).toBe(true)
        const runtime = Bun.which(name)
        if (!runtime) throw new Error("Missing actual CI runtime")
        const result = await run(
          [
            "strace",
            "--seccomp-bpf",
            "-f",
            "-ff",
            "-s",
            "96",
            "-e",
            "trace=execve",
            "-o",
            path.join(temporary.path, "trace"),
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            POISON_RUNTIME,
            poison,
            replacement,
            proof,
            await fs.realpath(runtime),
            path.join(temporary.path, "witness.mjs"),
            target,
            proof,
            poison === "parent-recheck" ? "parent-recheck" : "positive",
          ],
          { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
          { directory: temporary.path, root: true },
        )
        expect(result.code).toBe(0)
        expect(JSON.parse(result.output)).toMatchObject({
          runtime: name,
          value:
            poison === "parent-recheck"
              ? { dev: expect.any(String), ino: expect.any(String), birth: expect.any(String) }
              : null,
          loweredLimit: 256,
          inheritedPrivateDescriptors: [3, 2003],
          ...(poison === "parent-recheck" ? { rechecked: true, secondValue: null } : { observedChild: false }),
        })
        const traces = await Promise.all(
          (await fs.readdir(temporary.path))
            .filter((file) => file.startsWith("trace."))
            .map((file) => fs.readFile(path.join(temporary.path, file), "utf8")),
        )
        expect(traces.length).toBeGreaterThan(0)
        const helpers = traces
          .flatMap((trace) => trace.split("\n"))
          .filter((line) => line.includes('"-c", "import sys, os\\n'))
        expect(helpers).toHaveLength(poison === "parent-recheck" ? 1 : 0)
        expect(
          await fs.lstat(marker).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        if (poison === "binary" || poison === "module")
          expect(await fs.stat(replacement).then((info) => info.mode & 0o777)).toBe(0o777)
        if (poison === "cache") expect((await fs.readFile(replacement))[0]).toBe(88)
        if (poison === "cache-baseline") expect((await fs.readFile(replacement)).readUInt32LE(60)).toBe(1)
        if (poison === "image") {
          expect((await fs.readFile(replacement)).at(-1)).toBe(0)
          expect((await fs.stat(replacement)).size).toBe((await fs.stat("/usr/bin/python3.12")).size + 1)
          expect((await fs.stat(replacement)).mode & 0o777).toBe(0o755)
        }
        if (poison === "package-record")
          expect(await fs.readFile(replacement, "utf8")).toContain(`${"0".repeat(32)}  usr/bin/python3.12\n`)
        if (poison === "adjacent-pth" || poison === "pyvenv" || poison === "builddir" || poison === "parent-recheck")
          expect(await fs.readdir(replacement)).toEqual([])
      },
      60_000,
    )
