import { expect, test } from "bun:test"
import { LinuxIsolation } from "../src/process-isolation/linux"

const fixture = () => ({
  v: 1,
  container: "/mnt/vector-agent-sandbox",
  uid: 1002,
  gid: 1002,
  stage: "/mnt/vector-agent-sandbox/checkout",
  scratch: "/mnt/vector-agent-sandbox/tool-scratch",
  directory: "/mnt/vector-agent-sandbox/tool-namespaces",
  socket: "/mnt/vector-agent-sandbox/tool-namespaces/broker.sock",
  nonce: "a".repeat(32),
  namespaces: { user: 11, mnt: 12, pid: 13 },
  devices: { user: 4, mnt: 4, pid: 4 },
  keeper: { pid: 101, start: "500" },
  broker: { pid: 102, start: "501", uid: 0, gid: 0 },
  socketIdentity: { device: 5, inode: 123 },
})
const options = (cwd: string) => ({ platform: "linux" as const, parentPID: 4123, cwd })

test("the first supported hosted temporary root is fixed, never selected by a caller", () => {
  expect(LinuxIsolation.hostedTemporary("/home/runner/work/_temp")).toBe(LinuxIsolation.HOST_TEMP)
  for (const value of [
    undefined,
    null,
    7,
    "/tmp",
    "relative",
    "/home/runner/work/_temp/",
    "/home/runner/work/_temp/../other",
    "/home/other/work/_temp",
  ])
    expect(() => LinuxIsolation.hostedTemporary(value)).toThrow(LinuxIsolation.Unavailable)
})

test("hidden roots never contain the installed entry, fixed broker or permitted external toolchain", () => {
  expect(LinuxIsolation.MASKS).toEqual(["/home/vector-agent", "/tmp", "/var/tmp", "/run", "/home/runner/work/_temp"])
  expect(Object.isFrozen(LinuxIsolation.MASKS)).toBe(true)
  for (const file of [
    LinuxIsolation.ENTRY,
    "/usr/bin/python3",
    "/usr/bin/node",
    "/opt/hostedtoolcache/node/bin/node",
    ...LinuxIsolation.CONTAINERS.map((container) => container + "/tool-namespaces/broker.sock"),
  ])
    expect(() => LinuxIsolation.assertUnmaskedRuntime(file)).not.toThrow()
  for (const root of LinuxIsolation.MASKS)
    for (const file of [root, root + "/runtime-or-data"])
      expect(() => LinuxIsolation.assertUnmaskedRuntime(file)).toThrow(LinuxIsolation.Unavailable)
})

test("a protected nested filesystem is unsupported even when its outside alias uses another device", () => {
  const mounts = [
    { target: "/", device: "8:1" },
    { target: "/tmp/private", device: "0:99" },
    { target: "/mnt/leak", device: "0:99" },
  ]
  expect(() =>
    LinuxIsolation.assertMaskMountTargets([...LinuxIsolation.MASKS, ...mounts.map((row) => row.target)]),
  ).toThrow(LinuxIsolation.Unavailable)
  // The unsupported target, rather than a comparison against the protected parent's device, drives refusal.
  expect(() => LinuxIsolation.assertMaskMountTargets([...LinuxIsolation.MASKS, "/mnt/leak"])).not.toThrow()
  for (const parent of LinuxIsolation.MASKS)
    expect(() => LinuxIsolation.assertMaskMountTargets([...LinuxIsolation.MASKS, parent + "/nested"])).toThrow(
      LinuxIsolation.Unavailable,
    )
  expect(() => LinuxIsolation.assertMaskMountTargets([])).toThrow(LinuxIsolation.Unavailable)
})

test("the fixed ABI keeps arbitrary command arguments behind its separator without executing or selecting a helper", () => {
  const spec = LinuxIsolation.parseSpec(fixture())
  const plan = LinuxIsolation.planLaunch(
    "node",
    ["--eval", "console.log('fixture')", "--cwd", "/untrusted", "--parent", "1"],
    options(spec.stage),
    spec,
  )
  expect(plan.file).toBe("/usr/bin/python3")
  expect(plan.args).toEqual([
    "-I",
    "-S",
    LinuxIsolation.ENTRY,
    "exec",
    "--parent",
    "4123",
    "--cwd",
    spec.stage,
    "--",
    "node",
    "--eval",
    "console.log('fixture')",
    "--cwd",
    "/untrusted",
    "--parent",
    "1",
  ])
  expect(plan.shell).toBe(false)
  expect(plan.startupBarrier).toBe("outer-authorized-owned-pid-namespace-init")
  expect(LinuxIsolation.ENTRY).toBe("/usr/libexec/vector-sandbox/v1/entry.py")
  expect(Object.isFrozen(plan.args)).toBe(true)
})

test("the bootstrap parent identity is required from the trusted planner and cannot come from metadata or payload data", () => {
  const spec = LinuxIsolation.parseSpec(fixture())
  for (const parentPID of [0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    expect(() => LinuxIsolation.planLaunch("/bin/true", [], { ...options(spec.stage), parentPID }, spec)).toThrow(
      LinuxIsolation.Unavailable,
    )
  expect(() => LinuxIsolation.parseSpec({ ...fixture(), parentPID: 4123 })).toThrow(LinuxIsolation.Unavailable)
  const plan = LinuxIsolation.planLaunch(
    "/bin/true",
    ["--parent", "1"],
    { ...options(spec.stage), env: { VECTOR_PARENT_PID: "1" } },
    spec,
  )
  expect(plan.args.slice(3, 8)).toEqual(["exec", "--parent", "4123", "--cwd", spec.stage])
  expect(plan.args.slice(8)).toEqual(["--", "/bin/true", "--parent", "1"])
})

test("metadata accepts exact disposable namespace identity only and never grants authority through unknown fields", () => {
  for (const value of [
    { ...fixture(), token: "not-a-metadata-field" },
    { ...fixture(), container: "/tmp/redirect" },
    { ...fixture(), stage: "/mnt/vector-agent-sandbox/checkout/../other" },
    { ...fixture(), scratch: "/home/vector-agent/.cache/vector" },
    { ...fixture(), directory: "/proc/self/fd" },
    { ...fixture(), socket: "/tmp/broker.sock" },
    { ...fixture(), nonce: "A".repeat(32) },
    { ...fixture(), uid: 0 },
    { ...fixture(), namespaces: { user: 11, mnt: 12, pid: 13, host: 14 } },
    { ...fixture(), namespaces: { user: 11, mnt: -1, pid: 13 } },
    { ...fixture(), broker: { pid: 102, start: "501", uid: 1002, gid: 1002 } },
    { ...fixture(), broker: { pid: 101, start: "500", uid: 0, gid: 0 } },
    { ...fixture(), keeper: { pid: 1, start: "500" } },
    { ...fixture(), keeper: { pid: 101, start: "0500" } },
  ])
    expect(() => LinuxIsolation.parseSpec(value)).toThrow(LinuxIsolation.Unavailable)
  const raw = fixture()
  const spec = LinuxIsolation.parseSpec(raw)
  raw.namespaces.user = 999
  expect(spec.namespaces.user).toBe(11)
  expect(Object.isFrozen(spec.namespaces)).toBe(true)
  expect(Object.isFrozen(spec.broker)).toBe(true)
})

test("the bounded metadata decoder rejects malformed bytes and oversized data rather than replacement-decoding", () => {
  expect(LinuxIsolation.decodeSpec(Buffer.from(JSON.stringify(fixture()))).uid).toBe(1002)
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(LinuxIsolation.LIMITS.metadataBytes + 1),
    Buffer.from([0x80]),
    Buffer.from("{"),
  ])
    expect(() => LinuxIsolation.decodeSpec(bytes)).toThrow(LinuxIsolation.Unavailable)
})

test("own-key needs no proof descriptor while every plan closes all descriptors beyond real stdio", () => {
  const spec = LinuxIsolation.parseSpec(fixture())
  const plan = LinuxIsolation.planLaunch("/bin/true", [], options(spec.stage), spec)
  expect(plan.descriptors).toEqual({ closeFrom: 3, closeThrough: 0xffff_ffff, payload: [0, 1, 2] })
  expect(plan.args).not.toContain("fd3")
  for (const extraFDs of [[3], [2003]])
    expect(() => LinuxIsolation.planLaunch("/bin/true", [], { ...options(spec.stage), extraFDs }, spec)).toThrow(
      LinuxIsolation.Unavailable,
    )
})

test("unsupported paths, loader hooks, argument sizes and stdio capabilities cannot silently gain a raw fallback", () => {
  const spec = LinuxIsolation.parseSpec(fixture())
  for (const cwd of ["relative", "/tmp/../etc", "/proc/1", "/sys", "/dev/fd/3", "/" + "x".repeat(4096), "/tmp/\uD800"])
    expect(() => LinuxIsolation.planLaunch("/bin/true", [], options(cwd), spec)).toThrow(LinuxIsolation.Unavailable)
  for (const name of ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "GCONV_PATH", "GLIBC_TUNABLES"])
    expect(() =>
      LinuxIsolation.planLaunch("/bin/true", [], { ...options(spec.stage), env: { [name]: "fixture" } }, spec),
    ).toThrow(LinuxIsolation.Unavailable)
  expect(() => LinuxIsolation.planLaunch("/bin/true", ["x".repeat(65_537)], options(spec.stage), spec)).toThrow(
    LinuxIsolation.Unavailable,
  )
  expect(() =>
    LinuxIsolation.planLaunch(
      "/bin/true",
      Array.from({ length: 513 }, () => "x"),
      options(spec.stage),
      spec,
    ),
  ).toThrow(LinuxIsolation.Unavailable)
  for (const platform of ["darwin", "win32", "freebsd"] as const)
    expect(() => LinuxIsolation.planLaunch("/bin/true", [], { ...options(spec.stage), platform }, spec)).toThrow(
      LinuxIsolation.Unavailable,
    )
  const shell = LinuxIsolation.planLaunch("printf fixture", [], { ...options(spec.stage), shell: true }, spec)
  expect(shell.args.slice(-3)).toEqual(["/bin/sh", "-c", "printf fixture"])
  expect(shell.shell).toBe(false)
})

test("artifact authority requires adopted broker, stopped admission, stopped UID and stopped broker in that order", () => {
  let state = LinuxIsolation.recorded()
  expect(() => LinuxIsolation.advance(state, "adopted")).toThrow(LinuxIsolation.Unavailable)
  for (const phase of ["keeper-ready", "broker-pending", "adopted", "quiesced", "uid-stopped"] as const) {
    state = LinuxIsolation.advance(state, phase)
    expect(LinuxIsolation.artifactsAllowed(state)).toBe(false)
    if (phase === "quiesced")
      expect(() => LinuxIsolation.advance(state, "broker-stopped")).toThrow(LinuxIsolation.Unavailable)
  }
  state = LinuxIsolation.advance(state, "broker-stopped")
  expect(LinuxIsolation.artifactsAllowed(state)).toBe(true)
  expect(LinuxIsolation.artifactsAllowed(LinuxIsolation.advance(state, "cancel"))).toBe(false)
  expect(LinuxIsolation.artifactsAllowed(LinuxIsolation.advance(state, "failure"))).toBe(false)
  let failed = LinuxIsolation.advance(LinuxIsolation.recorded(), "failure")
  for (const phase of [
    "keeper-ready",
    "broker-pending",
    "adopted",
    "quiesced",
    "uid-stopped",
    "broker-stopped",
  ] as const)
    failed = LinuxIsolation.advance(failed, phase)
  expect(LinuxIsolation.artifactsAllowed(failed)).toBe(false)
})

test("outer cancellation before the composed decision cannot authorize an independently ready guardian", () => {
  let state = LinuxIsolation.commandCreated()
  for (const phase of ["guardian-owned", "init-owned"] as const) {
    expect(() => LinuxIsolation.commandAdvance(state, "exec-authorized")).toThrow(LinuxIsolation.Unavailable)
    expect(() => LinuxIsolation.commandAdvance(state, "exec-released")).toThrow(LinuxIsolation.Unavailable)
    state = LinuxIsolation.commandAdvance(state, phase)
  }
  expect(() => LinuxIsolation.commandAdvance(state, "exec-released")).toThrow(LinuxIsolation.Unavailable)
  const cancelled = LinuxIsolation.commandAdvance(state, "cancel")
  expect(() => LinuxIsolation.commandAdvance(cancelled, "exec-authorized")).toThrow(LinuxIsolation.Unavailable)
  expect(() => LinuxIsolation.commandAdvance(cancelled, "exec-released")).toThrow(LinuxIsolation.Unavailable)
  expect(LinuxIsolation.commandAdvance(cancelled, "reaped")).toMatchObject({ phase: "reaped", cancelled: true })
})

test("post-authorization cancellation still requires reaping even when init dispatch races it", () => {
  let state = LinuxIsolation.commandCreated()
  for (const phase of ["guardian-owned", "init-owned", "exec-authorized"] as const)
    state = LinuxIsolation.commandAdvance(state, phase)
  state = LinuxIsolation.commandAdvance(state, "cancel")
  expect(LinuxIsolation.commandAdvance(state, "reaped")).toMatchObject({ phase: "reaped", cancelled: true })
  const dispatched = LinuxIsolation.commandAdvance(state, "exec-released")
  expect(dispatched).toMatchObject({ phase: "exec-released", cancelled: true })
  expect(LinuxIsolation.commandAdvance(dispatched, "reaped")).toMatchObject({ phase: "reaped", cancelled: true })
  expect(() => LinuxIsolation.commandAdvance(dispatched, "exec-authorized")).toThrow(LinuxIsolation.Unavailable)
})
