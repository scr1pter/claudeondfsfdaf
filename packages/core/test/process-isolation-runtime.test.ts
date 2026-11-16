import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { LinuxIsolation } from "../src/process-isolation/linux"
import { ProcessIsolationRuntime } from "../src/process-isolation/runtime"
import { ProcessIsolation } from "../src/process-isolation"

const spec = (): LinuxIsolation.PublicSpec => ({
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
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function fixture() {
  const rows = new Map<string, ProcessIsolationRuntime.Metadata>()
  const files = new Map<string, Uint8Array>()
  const calls = { open: [] as string[], close: [] as string[], read: [] as { name: string; limit: number }[] }
  const hooks: {
    open?: (name: string) => void
    stat?: (name: string, count: number) => ProcessIsolationRuntime.Metadata | undefined
    read?: (name: string, bytes: Uint8Array) => Uint8Array
    close?: (name: string) => void
    canonical?: (name: string, value: string) => string
  } = {}
  let inode = 0n
  const row = (kind: ProcessIsolationRuntime.Metadata["kind"], size = 0) => ({
    kind,
    device: 1n,
    inode: ++inode,
    uid: 0,
    gid: 0,
    mode: kind === "file" ? 0o100444 : kind === "directory" ? 0o40755 : 0o120777,
    links: 1n,
    size: BigInt(size),
    modified: 10n,
    changed: 20n,
  })
  const get = (name: string) => {
    const value = rows.get(name)
    if (!value) throw new Error("PRIVATE_READER_DIAGNOSTIC")
    return value
  }
  const put = (name: string, bytes: Uint8Array) => {
    files.set(name, bytes)
    rows.set(name, row("file", bytes.length))
    for (let parent = path.posix.dirname(name); ; parent = path.posix.dirname(parent)) {
      if (!rows.has(parent)) rows.set(parent, row("directory"))
      if (parent === "/") break
    }
  }
  const asset = new TextEncoder().encode("# immutable synthetic asset; never imported or executed\n")
  put(LinuxIsolation.ENTRY, asset)
  put(LinuxIsolation.SPEC, new TextEncoder().encode(JSON.stringify(spec())))
  put("/usr/bin/python3.12", new Uint8Array([1]))
  rows.set("/usr/bin/python3.12", { ...get("/usr/bin/python3.12"), mode: 0o100755 })
  rows.set(LinuxIsolation.PYTHON, row("other"))
  const reader: ProcessIsolationRuntime.Reader = {
    canonical: (name) => {
      const value = name === LinuxIsolation.PYTHON ? "/usr/bin/python3.12" : name
      return hooks.canonical?.(name, value) ?? value
    },
    metadata: (name) => ({ ...get(name) }),
    open: (name) => {
      hooks.open?.(name)
      get(name)
      calls.open.push(name)
      let count = 0
      return {
        metadata: () => hooks.stat?.(name, ++count) ?? { ...get(name) },
        read: (limit) => {
          calls.read.push({ name, limit })
          const value = files.get(name)
          if (!value) throw new Error("PRIVATE_READER_DIAGNOSTIC")
          return hooks.read?.(name, value) ?? value.slice()
        },
        close: () => {
          calls.close.push(name)
          hooks.close?.(name)
        },
      }
    },
  }
  return { reader: ProcessIsolationRuntime.create(reader), calls, hooks, rows, files, get, put, asset, sha: sha(asset) }
}

test("the fixed reader attests bounded same-FD bytes and closes both readers without executing them", () => {
  const f = fixture()
  const value = f.reader.read(f.sha)
  expect(value.python).toBe("/usr/bin/python3.12")
  expect(value.spec).toEqual(spec())
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.spec)).toBe(true)
  expect(Object.isFrozen(value.spec.keeper)).toBe(true)
  expect(f.calls.open).toEqual([LinuxIsolation.ENTRY, LinuxIsolation.SPEC])
  expect(f.calls.close).toEqual(f.calls.open)
  expect(f.calls.read).toEqual([
    { name: LinuxIsolation.ENTRY, limit: 131_072 },
    { name: LinuxIsolation.SPEC, limit: 65_536 },
  ])
})

test("missing or mismatched compiled hashes and invalid UTF-8/NUL assets never produce a ready plan", () => {
  for (const digest of [undefined, "", "A".repeat(64), "0".repeat(63)]) {
    const f = fixture()
    expect(() => f.reader.read(digest)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.open).toEqual([])
  }
  const changed = fixture()
  expect(() => changed.reader.read("0".repeat(64))).toThrow(LinuxIsolation.Unavailable)
  expect(changed.calls.close).toEqual([LinuxIsolation.ENTRY])
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0])]) {
    const f = fixture()
    f.put(LinuxIsolation.ENTRY, bytes)
    expect(() => f.reader.read(sha(bytes))).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.close).toEqual([LinuxIsolation.ENTRY])
  }
})

test("each fixed file must be single-link Root-owned regular exact0444 and bounded before reading", () => {
  for (const name of [LinuxIsolation.ENTRY, LinuxIsolation.SPEC]) {
    for (const patch of [
      { kind: "other" as const },
      { uid: 1002 },
      { gid: 1002 },
      { mode: 0o100644 },
      { links: 2n },
      { size: 0n },
      { size: BigInt(name === LinuxIsolation.ENTRY ? 131_073 : 65_537) },
    ]) {
      const f = fixture()
      f.rows.set(name, { ...f.get(name), ...patch })
      expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
      expect(f.calls.read.some((call) => call.name === name)).toBe(false)
      expect(f.calls.close).toEqual(f.calls.open)
    }
  }
})

test("fixed ancestry, system Python target and alias ownership cannot come from a writable alternate path", () => {
  for (const name of ["/", "/usr", "/usr/libexec", LinuxIsolation.ROOT]) {
    const f = fixture()
    f.rows.set(name, { ...f.get(name), mode: 0o40775 })
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.close).toEqual(f.calls.open)
  }
  for (const name of [LinuxIsolation.PYTHON, "/usr/bin/python3.12"]) {
    const f = fixture()
    f.rows.set(name, { ...f.get(name), uid: 1002 })
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.open).toEqual([])
  }
  for (const target of ["/tmp/python3", "/usr/local/bin/python3", "/usr/bin/not-python"]) {
    const f = fixture()
    f.hooks.canonical = (name, value) => (name === LinuxIsolation.PYTHON ? target : value)
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.open).toEqual([])
  }
  const f = fixture()
  f.hooks.canonical = (name, value) => (name === LinuxIsolation.ENTRY ? "/repo/entry.py" : value)
  expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
  expect(f.calls.open).toEqual([])
})

test("path replacement before open and same-FD mutation while reading both refuse and close the actual reader", () => {
  const replaced = fixture()
  replaced.hooks.open = (name) => {
    if (name === LinuxIsolation.ENTRY) replaced.rows.set(name, { ...replaced.get(name), inode: 900n })
  }
  expect(() => replaced.reader.read(replaced.sha)).toThrow(LinuxIsolation.Unavailable)
  expect(replaced.calls.read).toEqual([])
  expect(replaced.calls.close).toEqual([LinuxIsolation.ENTRY])
  for (const patch of [{ inode: 900n }, { changed: 900n }, { modified: 900n }, { links: 2n }, { uid: 1002 }]) {
    const f = fixture()
    f.hooks.read = (name, bytes) => {
      if (name === LinuxIsolation.ENTRY) f.rows.set(name, { ...f.get(name), ...patch })
      return bytes
    }
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.close).toEqual([LinuxIsolation.ENTRY])
  }
})

test("short reads, overlong reads and strict malformed/excess spec fields cannot become ready", () => {
  for (const overlong of [false, true]) {
    const f = fixture()
    f.hooks.read = (name, bytes) =>
      name !== LinuxIsolation.ENTRY ? bytes : overlong ? new Uint8Array(131_073) : bytes.subarray(1)
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.close).toEqual([LinuxIsolation.ENTRY])
  }
  for (const bytes of [
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode("{"),
    new TextEncoder().encode(JSON.stringify({ ...spec(), helper: "/repo/helper" })),
    new TextEncoder().encode(JSON.stringify({ ...spec(), uid: 0 })),
  ]) {
    const f = fixture()
    f.put(LinuxIsolation.SPEC, bytes)
    expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.close).toEqual([LinuxIsolation.ENTRY, LinuxIsolation.SPEC])
  }
})

test("there is no retained ready cache after spec removal or interpreter/alias replacement", () => {
  const f = fixture()
  f.reader.read(f.sha)
  f.rows.delete(LinuxIsolation.SPEC)
  expect(() => f.reader.read(f.sha)).toThrow(LinuxIsolation.Unavailable)
  expect(f.calls.open.filter((name) => name === LinuxIsolation.ENTRY)).toHaveLength(2)
  expect(f.calls.close).toEqual(f.calls.open)
  for (const name of [LinuxIsolation.PYTHON, "/usr/bin/python3.12"]) {
    const changed = fixture()
    changed.hooks.read = (file, bytes) => {
      if (file === LinuxIsolation.SPEC) changed.rows.set(name, { ...changed.get(name), inode: 900n })
      return bytes
    }
    expect(() => changed.reader.read(changed.sha)).toThrow(LinuxIsolation.Unavailable)
    expect(changed.calls.close).toEqual([LinuxIsolation.ENTRY, LinuxIsolation.SPEC])
  }
})

test("reader failures expose a fixed refusal and close every acquired descriptor", () => {
  for (const stage of ["open", "stat", "read", "close"] as const) {
    const f = fixture()
    f.hooks[stage] = () => {
      throw new Error("PRIVATE_READER_DIAGNOSTIC")
    }
    let failure: unknown
    try {
      f.reader.read(f.sha)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LinuxIsolation.Unavailable)
    expect(String(failure)).not.toContain("PRIVATE_READER_DIAGNOSTIC")
    expect(f.calls.close).toEqual(f.calls.open)
  }
})

test("native planning captures the actual parent and keeps argv/env/stdio behind a fixed non-shell entry", () => {
  const f = fixture()
  const env = { PATH: "/usr/bin", VECTOR_SYNTHETIC: "literal", PYTHONPATH: "/repo" }
  const options: ProcessIsolationRuntime.Options = {
    cwd: spec().stage,
    env,
    stdio: ["pipe", "pipe", "inherit"],
    additionalFDs: [],
  }
  // A caller's extra property is never forwarded into the trusted parent identity.
  const supplied = Object.assign({}, options, { parentPID: 1 })
  if (process.platform !== "linux") {
    expect(() => f.reader.plan(f.sha, "/bin/echo", ["literal"], supplied)).toThrow(LinuxIsolation.Unavailable)
    expect(f.calls.open).toEqual([])
    return
  }
  const plan = f.reader.plan(f.sha, "/bin/echo", ["--parent", "1", "literal"], supplied)
  expect(plan.file).toBe(LinuxIsolation.PYTHON)
  expect(plan.args.slice(0, 9)).toEqual([
    "-I",
    "-S",
    LinuxIsolation.ENTRY,
    "exec",
    "--parent",
    String(process.pid),
    "--cwd",
    spec().stage,
    "--",
  ])
  expect(plan.args.slice(9)).toEqual(["/bin/echo", "--parent", "1", "literal"])
  expect(plan.options.shell).toBe(false)
  expect(plan.options.env).toEqual(env)
  expect(Object.isFrozen(plan.options.env)).toBe(true)
  expect(plan.isolation).toBe("native")
  expect(plan.cancellation).toBe("native-owner")
  expect(f.calls.close).toEqual(f.calls.open)
})

test("native unsupported extra descriptors refuse before fixed-file IO and loader hooks cannot produce a plan", () => {
  const options: ProcessIsolationRuntime.Options = {
    cwd: spec().stage,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
    additionalFDs: [],
  }
  for (const fd of [0, 3, 1000]) {
    const f = fixture()
    expect(() => f.reader.plan(f.sha, "/bin/true", [], { ...options, additionalFDs: [fd] })).toThrow(
      LinuxIsolation.Unavailable,
    )
    expect(f.calls.open).toEqual([])
  }
  for (const name of ["LD_PRELOAD", "LD_AUDIT", "GLIBC_TUNABLES"]) {
    const f = fixture()
    expect(() => f.reader.plan(f.sha, "/bin/true", [], { ...options, env: { [name]: "untrusted" } })).toThrow(
      LinuxIsolation.Unavailable,
    )
    expect(f.calls.close).toEqual(f.calls.open)
  }
})

test("source/default command planning keeps ordinary launch semantics and metadata cannot enable native mode", () => {
  const metadata = ProcessIsolation.nativeBuild()
  expect(metadata).toEqual({ enabled: false, entrySHA: undefined })
  expect(Object.isFrozen(metadata)).toBe(true)
  expect(Reflect.set(metadata, "enabled", true)).toBe(false)
  const env = { LD_PRELOAD: "ordinary-local-value", PATH: "/user/bin" }
  const plan = ProcessIsolation.commandPlan("ordinary-command", ["literal"], {
    cwd: "/ordinary",
    shell: "/bin/sh",
    env,
    stdio: ["inherit", "ignore", "pipe"],
    additionalFDs: [3],
  })
  expect(plan).toEqual({
    file: "ordinary-command",
    args: ["literal"],
    options: { cwd: "/ordinary", shell: "/bin/sh", env },
    isolation: "plain",
    cancellation: "process-group",
  })
  expect(ProcessIsolation.nativeBuild().enabled).toBe(false)
})
