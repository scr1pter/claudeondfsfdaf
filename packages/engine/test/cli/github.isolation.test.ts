import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { GithubIsolation } from "../../src/cli/cmd/github.isolation"
import { run, finish } from "../../src/cli/cmd/github.sandbox"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const asset = () => ({
  v: 1 as const,
  entry: "# Inert contract bytes; never executed.\n",
  sha256: sha("# Inert contract bytes; never executed.\n"),
})
const scope = { uid: 1002, gid: 1002, container: LinuxIsolation.CONTAINERS[0] }

const failureRecord = (): GithubIsolation.FailureRecord => ({
  v: 1,
  event: "native-control-failure",
  origin: "entry",
  operation: "prepare",
  stage: "prepare-keeper-wait",
  class: "PermissionError",
  errno: "EPERM",
  exit: 125,
  signal: null,
})
const failureBytes = (value: unknown) => Buffer.from("VECTOR_NATIVE_CONTROL_FAILURE " + JSON.stringify(value) + "\n")
test("private native diagnostics project only strict operation, phase and error enums", () => {
  const entry = failureRecord()
  const outer: GithubIsolation.FailureRecord = {
    ...entry,
    origin: "control",
    stage: "native-prepare",
    class: "CalledProcessError",
    errno: null,
  }
  const privateText = "private-path /owner/secret; stdin=synthetic-private-token; source=never-forward\n"
  const found = GithubIsolation.decodeFailureRecords(
    Buffer.concat([Buffer.from(privateText), failureBytes(entry), failureBytes(outer)]),
    "prepare",
  )
  expect(found).toEqual([entry, outer])
  expect(JSON.stringify(found)).not.toContain("synthetic-private-token")
  expect(JSON.stringify(found)).not.toContain("/owner/")
})
test("fixed mask predicate stages survive private projection without exposing host layout", () => {
  for (const stage of [
    "prepare-construction-input",
    "prepare-construction-private",
    "prepare-mask-os-chain",
    "prepare-mask-os-decode",
    "prepare-mask-os-version",
    "prepare-mask-runner-identity",
    "prepare-mask-mount-table",
    "prepare-mask-origins",
    "prepare-mask-home-target-owner",
    "prepare-mask-home-target-mode",
    "prepare-mask-tmp-target-type",
    "prepare-mask-var-tmp-target-canonical",
    "prepare-mask-run-parent-stat",
    "prepare-mask-run-parent-type",
    "prepare-mask-run-parent-owner",
    "prepare-mask-host-temp-parent-mode",
    "prepare-mask-host-temp-parent-canonical",
    "prepare-mask-host-temp-target-mode",
    "prepare-mask-host-temp-mount-present",
    "prepare-mask-host-temp-mount-device",
    "prepare-mask-aliases",
    "prepare-broker-mask-proof",
  ]) {
    const entry = { ...failureRecord(), stage, class: "RuntimeError" as const, errno: null, exit: null }
    const transport: GithubIsolation.FailureRecord = {
      ...entry,
      origin: "transport",
      stage: "close",
      class: "ChildExit",
      exit: 1,
    }
    expect(GithubIsolation.decodeFailureRecords(failureBytes(entry), "prepare")).toEqual([entry])
    const cause: GithubIsolation.FailureCause = { v: 1, event: "native-control-failure", records: [transport, entry] }
    expect(GithubIsolation.failureMetadata(new Error("private host metadata", { cause }))).toEqual(cause)
  }
})
test("mask diagnostic vocabulary rejects paths, invented predicates and wrong origins", () => {
  const entry = { ...failureRecord(), stage: "prepare-mask-host-temp-parent-mode" }
  for (const stage of [
    "prepare-mask-guest-parent-mode",
    "prepare-mask-/home/private-parent-mode",
    "prepare-mask-host-temp-parent-mode:0755",
    "prepare-mask-host-temp-parent-mode\nprivate-value",
    "prepare-mask-host-temp-parent-private",
    "prepare-mask-tmp-target-mode",
    "prepare-mask-run-target-mode",
    "prepare-mask-nested",
    "prepare-mask-home-nested",
    "prepare-mask-tmp-nested",
    "prepare-mask-var-tmp-nested",
    "prepare-mask-run-nested",
    "prepare-mask-host-temp-nested",
    "prepare-mask-guest-nested",
    "prepare-mask-/run/private-nested",
    "prepare-mask-run-nested:private-value",
  ])
    expect(GithubIsolation.decodeFailureRecords(failureBytes({ ...entry, stage }), "prepare")).toEqual([])
  for (const origin of ["control", "client", "transport"])
    expect(GithubIsolation.decodeFailureRecords(failureBytes({ ...entry, origin }), "prepare")).toEqual([])
  for (const origin of ["control", "client", "transport"])
    expect(
      GithubIsolation.decodeFailureRecords(
        failureBytes({ ...entry, origin, stage: "prepare-mask-origins" }),
        "prepare",
      ),
    ).toEqual([])
  expect(
    GithubIsolation.decodeFailureRecords(failureBytes({ ...entry, mode: "0755", owner: "private" }), "prepare"),
  ).toEqual([])
})
test("fixed keeper failure stages project only bounded outcome, phase and error enums", () => {
  for (const stage of [
    "prepare-keeper-child-exit",
    "prepare-keeper-timeout",
    "prepare-keeper-ready-record",
    ...["child-exit", "timeout"].flatMap((outcome) =>
      ["identity", "capabilities", "environment", "ready-write"].map((phase) => `prepare-keeper-${outcome}-${phase}`),
    ),
  ]) {
    const timeout = stage.startsWith("prepare-keeper-timeout")
    const readyRecord = stage === "prepare-keeper-ready-record"
    const entry: GithubIsolation.FailureRecord = {
      ...failureRecord(),
      stage,
      class: timeout ? "TimeoutExpired" : readyRecord ? "RuntimeError" : "CalledProcessError",
      errno: null,
      exit: timeout || readyRecord ? null : 125,
      signal: null,
    }
    const transport: GithubIsolation.FailureRecord = {
      ...entry,
      origin: "transport",
      stage: "close",
      class: "ChildExit",
      exit: 1,
    }
    expect(GithubIsolation.decodeFailureRecords(failureBytes(entry), "prepare")).toEqual([entry])
    const cause: GithubIsolation.FailureCause = { v: 1, event: "native-control-failure", records: [transport, entry] }
    expect(GithubIsolation.failureMetadata(new Error("private keeper diagnostics", { cause }))).toEqual(cause)
    if (!timeout && !readyRecord) {
      const signaled: GithubIsolation.FailureRecord = { ...entry, exit: null, signal: "SIGKILL" }
      expect(GithubIsolation.decodeFailureRecords(failureBytes(signaled), "prepare")).toEqual([signaled])
    }
  }
})
test("keeper diagnostic vocabulary rejects invented phases, raw paths, extra fields and wrong origins", () => {
  const entry: GithubIsolation.FailureRecord = {
    ...failureRecord(),
    stage: "prepare-keeper-child-exit-identity",
    class: "CalledProcessError",
    errno: null,
    exit: 125,
  }
  for (const stage of [
    "prepare-keeper-child-exit-network",
    "prepare-keeper-timeout-private",
    "prepare-keeper-stopped-identity",
    "prepare-keeper-child-exit-/run/private",
    "prepare-keeper-timeout-environment:/owner/private",
    "prepare-keeper-child-exit-identity-125",
    "prepare-keeper-ready-record-/owner/private",
    "prepare-keeper-timeout-ready-write\nprivate-value",
    "live-final",
  ])
    expect(GithubIsolation.decodeFailureRecords(failureBytes({ ...entry, stage }), "prepare")).toEqual([])
  for (const origin of ["control", "client", "transport"])
    expect(GithubIsolation.decodeFailureRecords(failureBytes({ ...entry, origin }), "prepare")).toEqual([])
  for (const value of [
    { ...entry, phase: "identity" },
    { ...entry, outcome: "child-exit" },
    { ...entry, path: "/owner/private" },
    { ...entry, class: "KeeperChildExit" },
    { ...entry, signal: "SIGPRIVATE" },
  ])
    expect(GithubIsolation.decodeFailureRecords(failureBytes(value), "prepare")).toEqual([])
})
test("malformed, overbound, cross-operation or secret-bearing diagnostic records never leave stderr", () => {
  const ordinary = failureRecord()
  for (const value of [
    { ...ordinary, message: "synthetic-private-token" },
    { ...ordinary, argv: ["private"] },
    { ...ordinary, environment: { secret: "private" } },
    { ...ordinary, nonce: "a".repeat(32) },
    { ...ordinary, source: "private source" },
    { ...ordinary, class: "PrivateExceptionName" },
    { ...ordinary, errno: "/owner/private" },
    { ...ordinary, exit: -1 },
    { ...ordinary, exit: 256 },
    { ...ordinary, exit: 1.5 },
    { ...ordinary, signal: "private" },
    { ...ordinary, operation: "cleanup" },
    { ...ordinary, stage: "/owner/private" },
    { ...ordinary, origin: "transport", stage: "close" },
    { ...ordinary, origin: "client" },
  ])
    expect(GithubIsolation.decodeFailureRecords(failureBytes(value), "prepare")).toEqual([])
  expect(
    GithubIsolation.decodeFailureRecords(Buffer.concat([failureBytes(ordinary), failureBytes(ordinary)]), "prepare"),
  ).toEqual([])
  expect(GithubIsolation.decodeFailureRecords(Buffer.alloc(4097, 65), "prepare")).toEqual([])
  expect(GithubIsolation.decodeFailureRecords(Buffer.from([0xff]), "prepare")).toEqual([])
  expect(GithubIsolation.decodeFailureRecords(Buffer.from("VECTOR_NATIVE_CONTROL_FAILURE {\n"), "prepare")).toEqual([])
})
test("controller metadata never reads an exception message, stack or an accessor cause", () => {
  const record = failureRecord()
  const transport: GithubIsolation.FailureRecord = {
    ...record,
    origin: "transport",
    stage: "close",
    class: "ChildExit",
    errno: null,
    exit: 1,
  }
  const cause: GithubIsolation.FailureCause = { v: 1, event: "native-control-failure", records: [transport, record] }
  const error = new Error("synthetic-private-message", { cause })
  expect(GithubIsolation.failureMetadata(error)).toEqual(cause)
  expect(JSON.stringify(GithubIsolation.failureMetadata(error))).not.toContain("synthetic-private")
  let accessed = false
  Object.defineProperty(error, "cause", {
    get() {
      accessed = true
      throw new Error("private getter")
    },
  })
  expect(GithubIsolation.failureMetadata(error)).toBeUndefined()
  expect(accessed).toBe(false)
  expect(GithubIsolation.failureMetadata(new Error("private", { cause: { ...cause, raw: "private" } }))).toBeUndefined()
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { ...cause, records: [...cause.records, { ...record, body: "private" }] } }),
    ),
  ).toBeUndefined()
  expect(
    GithubIsolation.failureMetadata(new Error("private", { cause: { ...cause, records: [record] } })),
  ).toBeUndefined()
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { ...cause, records: [transport, record, record] } }),
    ),
  ).toBeUndefined()
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { ...cause, records: [transport, { ...record, operation: "cleanup" }] } }),
    ),
  ).toBeUndefined()
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { ...cause, records: Array.from({ length: 5 }, failureRecord) } }),
    ),
  ).toBeUndefined()
})

test("nested changing diagnostic getters are rejected without exposing their second private value", () => {
  const transport: GithubIsolation.FailureRecord = {
    ...failureRecord(),
    origin: "transport",
    stage: "close",
    class: "ChildExit",
  }
  let stageReads = 0,
    recordsReads = 0
  const changing = { ...failureRecord() }
  Object.defineProperty(changing, "stage", {
    get() {
      stageReads++
      return stageReads === 1 ? "prepare-keeper-wait" : "synthetic-private-getter-value"
    },
  })
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { v: 1, event: "native-control-failure", records: [transport, changing] } }),
    ),
  ).toBeUndefined()
  expect(stageReads).toBe(0)
  const cause = { v: 1, event: "native-control-failure" }
  Object.defineProperty(cause, "records", {
    get() {
      recordsReads++
      return [transport, failureRecord()]
    },
  })
  expect(GithubIsolation.failureMetadata(new Error("private", { cause }))).toBeUndefined()
  expect(recordsReads).toBe(0)
})
test("diagnostic array indices are data snapshots and overridden mapping code is never called", () => {
  const transport: GithubIsolation.FailureRecord = {
    ...failureRecord(),
    origin: "transport",
    stage: "close",
    class: "ChildExit",
  }
  const rows = [transport, failureRecord()]
  let indexReads = 0,
    mapReads = 0
  Object.defineProperty(rows, "1", {
    get() {
      indexReads++
      return { ...failureRecord(), stage: "synthetic-private-index" }
    },
  })
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { v: 1, event: "native-control-failure", records: rows } }),
    ),
  ).toBeUndefined()
  expect(indexReads).toBe(0)
  const mapped = [transport, failureRecord()]
  Object.defineProperty(mapped, "map", {
    get() {
      mapReads++
      throw new Error("synthetic-private-map")
    },
  })
  expect(
    GithubIsolation.failureMetadata(
      new Error("private", { cause: { v: 1, event: "native-control-failure", records: mapped } }),
    ),
  ).toBeUndefined()
  expect(mapReads).toBe(0)
  const inherited = [transport, failureRecord()]
  Object.setPrototypeOf(inherited, {
    map() {
      mapReads++
      return [{ ...failureRecord(), stage: "synthetic-private-map" }]
    },
  })
  const projected = GithubIsolation.failureMetadata(
    new Error("private", { cause: { v: 1, event: "native-control-failure", records: inherited } }),
  )
  expect(projected?.records).toEqual([transport, failureRecord()])
  expect(JSON.stringify(projected)).not.toContain("synthetic-private")
  expect(mapReads).toBe(0)
})

test("build coherence accepts only matching immutable source or bundled selections", () => {
  const embedded = asset()
  expect(() =>
    GithubIsolation.assertBuildCoherence({ enabled: false, entrySHA: undefined }, { enabled: false, asset: undefined }),
  ).not.toThrow()
  for (const enabled of [false, true])
    expect(() =>
      GithubIsolation.assertBuildCoherence({ enabled, entrySHA: embedded.sha256 }, { enabled, asset: embedded }),
    ).not.toThrow()

  const refused: Parameters<typeof GithubIsolation.assertBuildCoherence>[] = [
    [
      { enabled: false, entrySHA: embedded.sha256 },
      { enabled: true, asset: embedded },
    ],
    [
      { enabled: true, entrySHA: embedded.sha256 },
      { enabled: false, asset: embedded },
    ],
    [
      { enabled: true, entrySHA: undefined },
      { enabled: true, asset: embedded },
    ],
    [
      { enabled: true, entrySHA: embedded.sha256 },
      { enabled: true, asset: undefined },
    ],
    [
      { enabled: false, entrySHA: undefined },
      { enabled: false, asset: embedded },
    ],
    [
      { enabled: false, entrySHA: embedded.sha256 },
      { enabled: false, asset: undefined },
    ],
    [
      { enabled: true, entrySHA: "g".repeat(64) },
      { enabled: true, asset: embedded },
    ],
    [
      { enabled: true, entrySHA: "f".repeat(64) },
      { enabled: true, asset: embedded },
    ],
    [
      { enabled: true, entrySHA: embedded.sha256 },
      { enabled: true, asset: { ...embedded, entry: embedded.entry + "# changed\n" } },
    ],
    [
      { enabled: true, entrySHA: undefined },
      { enabled: true, asset: undefined },
    ],
  ]
  for (const [core, engine] of refused) expect(() => GithubIsolation.assertBuildCoherence(core, engine)).toThrow()
})

function fixture() {
  const files = new Map<string, GithubIsolation.Metadata>()
  function directory(name: string, mode = 0o755) {
    files.set(name, { canonical: name, kind: "directory", uid: 0, gid: 0, mode, nlink: 1 })
  }
  for (const name of ["/", "/usr", "/usr/libexec", "/etc", "/etc/apparmor.d"]) directory(name)
  const calls: GithubIsolation.Invocation[] = []
  const operations: string[] = []
  const publicSpec = {
    v: 1,
    ...scope,
    stage: scope.container + "/checkout",
    scratch: scope.container + "/tool-scratch",
    directory: scope.container + "/tool-namespaces",
    socket: scope.container + "/tool-namespaces/broker.sock",
    nonce: "b".repeat(32),
    namespaces: { user: 11, mnt: 12, pid: 13 },
    devices: { user: 4, mnt: 4, pid: 4 },
    keeper: { pid: 101, start: "500" },
    broker: { pid: 102, start: "501", uid: 0, gid: 0 },
    socketIdentity: { device: 5, inode: 123 },
  }
  const maskProof = {
    v: 2 as const,
    sourceDigest: "c".repeat(64),
    constructionNamespace: {
      mount: { device: 4, inode: 1012 },
      parentMount: { device: 4, inode: 1010 },
      user: { device: 4, inode: 1001 },
      root: { device: 8, inode: 2 },
    },
    keeperNamespace: { device: publicSpec.devices.mnt, inode: publicSpec.namespaces.mnt },
    protectedMountTargets: [...LinuxIsolation.MASKS, "/run/credentials"].sort(),
  }
  const hooks: { reply?: (operation: string, result: unknown) => unknown; installed?: () => void } = {}
  const embedded = asset()
  const ports: GithubIsolation.Ports = {
    temporary: LinuxIsolation.HOST_TEMP,
    asset: embedded,
    inspect: async (name) => files.get(name),
    nonce: () => "a".repeat(32),
    async execute(invocation) {
      calls.push(invocation)
      const operation = invocation.args[6]
      if (!operation) throw new Error("No fixed operation")
      operations.push(operation)
      const common = { v: 1, installNonce: "a".repeat(32), assetSHA: embedded.sha256 }
      const result = (() => {
        if (operation === "install") {
          directory("/usr/libexec/vector-sandbox")
          directory(LinuxIsolation.ROOT)
          directory(`${LinuxIsolation.ROOT}/private`, 0o700)
          files.set(LinuxIsolation.ENTRY, {
            canonical: LinuxIsolation.ENTRY,
            kind: "file",
            uid: 0,
            gid: 0,
            mode: 0o444,
            nlink: 1,
            sha256: embedded.sha256,
          })
          files.set(GithubIsolation.PROFILE_PATH, {
            canonical: GithubIsolation.PROFILE_PATH,
            kind: "file",
            uid: 0,
            gid: 0,
            mode: 0o444,
            nlink: 1,
            sha256: sha(GithubIsolation.PROFILE),
          })
          hooks.installed?.()
          return { ...common, event: "installed", profileSHA: sha(GithubIsolation.PROFILE) }
        }
        if (operation === "prepare" || operation === "inspect")
          return {
            ...common,
            event: "ready",
            public: publicSpec,
            live: {
              keeper: true,
              broker: true,
              namespaces: true,
              socket: true,
              admission: true,
              masks: true,
              maskProof,
            },
          }
        if (operation === "cleanup")
          return {
            ...common,
            event: "stopped",
            namespaceNonce: publicSpec.nonce,
            uidStoppedBeforeBroker: true,
            brokerStopped: true,
          }
        throw new Error("Unexpected fixed operation")
      })()
      const output = JSON.stringify(hooks.reply ? hooks.reply(operation, result) : result)
      if (typeof output !== "string") throw new Error("No bounded fake receipt")
      return output
    },
  }
  const adapter = GithubIsolation.create(ports)
  return { adapter, embedded, ports, files, calls, operations, publicSpec, maskProof, hooks }
}

test("native selection is compile-time only and absent build bytes cannot activate a runtime path", () => {
  expect(GithubIsolation.enabled()).toBe(false)
  expect(() => GithubIsolation.fromBuild(LinuxIsolation.HOST_TEMP)).toThrow()
  expect(GithubIsolation.validState({ ...scope, native: true })).toBe(false)
})

test("unsupported hosted temporary parents refuse before any privileged executor", () => {
  const f = fixture()
  for (const temporary of ["/tmp", "/alternate", "/home/runner/work/_temp/", "/home/runner/work/_temp/../other"])
    expect(() => GithubIsolation.create({ ...f.ports, temporary })).toThrow(LinuxIsolation.Unavailable)
  expect(f.calls).toHaveLength(0)
})

test("intent precedes root work and only verified native cleanup admits artifact preparation", async () => {
  const f = fixture()
  const intent = f.adapter.intent(scope)
  expect(f.calls).toHaveLength(0)
  expect(Object.isFrozen(intent)).toBe(true)
  expect(intent.phase).toBe("intent")
  await expect(f.adapter.validate(intent)).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  const ready = await f.adapter.prepare(intent)
  expect(f.operations).toEqual(["install", "prepare"])
  expect(ready).toMatchObject({ phase: "ready", namespaceNonce: f.publicSpec.nonce })
  expect(await f.adapter.validate(ready)).toEqual(ready)
  expect(await f.adapter.cleanup(ready)).toEqual({ artifactsAllowed: true, namespaceNonce: f.publicSpec.nonce })
  expect(f.operations).toEqual(["install", "prepare", "inspect", "cleanup"])
})

test("fixed commands contain no source path fallback or inherited credentials and carry bytes only to installation", async () => {
  const f = fixture()
  const ready = await f.adapter.prepare(f.adapter.intent(scope))
  await f.adapter.validate(ready)
  await f.adapter.cleanup(ready)
  for (const call of f.calls) {
    expect(call.file).toBe("/usr/bin/sudo")
    expect(call.args.slice(0, 5)).toEqual(["-n", "/usr/bin/python3", "-I", "-S", "-c"])
    expect(call.args.slice(7, 12)).toEqual(["1002", "1002", scope.container, "a".repeat(32), f.embedded.sha256])
    expect(call.env).toEqual({ PATH: "/usr/bin:/bin", LC_ALL: "C" })
    expect(call.maxOutput).toBe(65_536)
    expect(call.timeout).toBe(call.args[6] === "prepare" ? 50_000 : call.args[6] === "cleanup" ? 20_000 : 10_000)
    expect(call.args).not.toContain("/workspace/packages/core/src/process-isolation/linux/entry.py")
    expect(call.input).toBe(call.args[6] === "install" ? JSON.stringify(f.embedded) : "")
  }
  const control = f.calls[0]?.args[5]
  if (typeof control !== "string") throw new Error("No fixed native controller source")
  expect(control).toContain("need(len(encoded) + 1 <= 40960)")
  expect(control).toContain("need(len(probe.stdout) <= 40960)")
  expect(control).toContain('json.loads(probe.stdout.decode("utf-8","strict"))')
  expect(control).toContain('separators=(",",":"),ensure_ascii=False).encode("utf-8","strict")')
  expect(control).toContain('evidence["sourceDigest"] == mask_sources["digest"]')
  expect(control).toContain('evidence["constructionNamespace"] == mask_sources["namespace"]')
})

test("noncanonical, writable, wrong-owner and symlink ancestors refuse before any root execution", async () => {
  for (const patch of [
    { canonical: "/elsewhere" },
    { mode: 0o777 },
    { uid: 1002 },
    { gid: 1002 },
    { kind: "other" as const },
  ]) {
    const f = fixture()
    const name = "/usr/libexec"
    const original = f.files.get(name)
    if (!original) throw new Error("Missing ordinary fixed ancestor")
    f.files.set(name, { ...original, ...patch })
    await expect(f.adapter.prepare(f.adapter.intent(scope))).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  }
})

test("wrong installed bytes, linked files, private permissions and profile digests refuse before native prepare", async () => {
  for (const target of [LinuxIsolation.ENTRY, GithubIsolation.PROFILE_PATH, `${LinuxIsolation.ROOT}/private`]) {
    const f = fixture()
    f.hooks.installed = () => {
      const item = f.files.get(target)
      if (!item) throw new Error("Missing installed contract object")
      f.files.set(
        target,
        target.endsWith("/private")
          ? { ...item, mode: 0o755 }
          : target === LinuxIsolation.ENTRY
            ? { ...item, nlink: 2 }
            : { ...item, sha256: "f".repeat(64) },
      )
    }
    await expect(f.adapter.prepare(f.adapter.intent(scope))).rejects.toThrow()
    expect(f.operations).toEqual(["install"])
  }
  const f = fixture()
  f.embedded.entry = "changed after construction"
  expect((await f.adapter.prepare(f.adapter.intent(scope))).phase).toBe("ready")
  expect(f.operations).toEqual(["install", "prepare"])
  const installation = f.calls[0]
  if (!installation) throw new Error("No ordinary installation control")
  expect(JSON.parse(installation.input).entry).toBe("# Inert contract bytes; never executed.\n")
})

test("installed and ready receipts must bind the same job, asset, fixed directory, UID and namespace nonce", async () => {
  for (const mutation of ["installNonce", "assetSHA", "container", "uid", "nonce", "extra"]) {
    const f = fixture()
    const intent = f.adapter.intent(scope)
    const ready = await f.adapter.prepare(intent)
    f.hooks.reply = (operation, result) => {
      if (operation !== "inspect" || !result || typeof result !== "object") return result
      if (mutation === "installNonce") return { ...result, installNonce: "c".repeat(32) }
      if (mutation === "assetSHA") return { ...result, assetSHA: "d".repeat(64) }
      if (mutation === "extra") return { ...result, approved: true }
      return {
        ...result,
        public: {
          ...f.publicSpec,
          [mutation]: mutation === "uid" ? 2002 : mutation === "nonce" ? "c".repeat(32) : "/tmp/repository-selected",
        },
      }
    }
    await expect(f.adapter.validate(ready)).rejects.toThrow()
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
})

test("a lost or malformed installation response cannot advance to native prepare or a fallback", async () => {
  for (const broken of ["installNonce", "profileSHA", "extra"]) {
    const f = fixture()
    f.hooks.reply = (operation, result) =>
      operation === "install" && result && typeof result === "object"
        ? { ...result, [broken]: broken === "extra" ? true : "f".repeat(broken === "profileSHA" ? 64 : 32) }
        : result
    await expect(f.adapter.prepare(f.adapter.intent(scope))).rejects.toThrow()
    expect(f.operations).toEqual(["install"])
  }
  const f = fixture()
  const calls: GithubIsolation.Invocation[] = []
  const adapter = GithubIsolation.create({
    ...f.ports,
    execute: async (invocation) => {
      calls.push(invocation)
      throw new Error("Fixed executor response was lost")
    },
  })
  await expect(adapter.prepare(adapter.intent(scope))).rejects.toThrow()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.args[6]).toBe("install")
  expect(f.operations).toEqual([])
})

test("a diagnostic failure record is never a successful native installation or cleanup receipt", async () => {
  for (const operation of ["install", "cleanup"]) {
    const f = fixture()
    const intent = f.adapter.intent(scope)
    const ready = operation === "cleanup" ? await f.adapter.prepare(intent) : undefined
    f.hooks.reply = (called, result) =>
      called === operation ? { v: 1, event: "native-control-failure", records: [failureRecord()] } : result
    let admitted = false
    await expect(
      (ready ? f.adapter.cleanup(ready) : f.adapter.prepare(intent)).then(() => {
        admitted = true
      }),
    ).rejects.toThrow()
    expect(admitted).toBe(false)
    expect(f.operations).toEqual(operation === "install" ? ["install"] : ["install", "prepare", "cleanup"])
  }
})

test("structural adopted JSON alone cannot substitute for live process, namespace, socket and broker admission proof", async () => {
  for (const missing of ["all", "keeper", "broker", "namespaces", "socket", "admission", "masks"]) {
    const f = fixture()
    const ready = await f.adapter.prepare(f.adapter.intent(scope))
    f.hooks.reply = (operation, result) => {
      if (operation !== "inspect" || !result || typeof result !== "object") return result
      if (missing === "all")
        return {
          v: 1,
          event: "ready",
          installNonce: ready.installNonce,
          assetSHA: ready.assetSHA,
          public: f.publicSpec,
        }
      return {
        ...result,
        live: {
          keeper: true,
          broker: true,
          namespaces: true,
          socket: true,
          admission: true,
          masks: true,
          maskProof: f.maskProof,
          [missing]: false,
        },
      }
    }
    await expect(f.adapter.validate(ready)).rejects.toThrow()
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
})

test("verified v2 nested mask evidence survives prepare and inspect while raw target arrays remain strict", async () => {
  const f = fixture()
  const ready = await f.adapter.prepare(f.adapter.intent(scope))
  expect(f.maskProof.protectedMountTargets).toContain("/run/credentials")
  expect(() => LinuxIsolation.assertMaskMountTargets(f.maskProof.protectedMountTargets)).toThrow(
    LinuxIsolation.Unavailable,
  )
  expect(await f.adapter.validate(ready)).toEqual(ready)
  expect(f.operations).toEqual(["install", "prepare", "inspect"])
})

test("positive live flags cannot replace exact v2 source evidence with malformed or outside target proof", async () => {
  const proof = fixture().maskProof
  for (const maskProof of [
    null,
    [...LinuxIsolation.MASKS],
    { ...proof, v: 1 },
    { ...proof, v: "2" },
    { ...proof, sourceDigest: "C".repeat(64) },
    { ...proof, sourceDigest: "c".repeat(63) },
    { ...proof, sourceDigest: undefined },
    { ...proof, digest: "d".repeat(64) },
    { ...proof, approved: true },
    { ...proof, protectedMountTargets: [...proof.protectedMountTargets, "/mnt/outside"].sort() },
    { ...proof, protectedMountTargets: [...proof.protectedMountTargets, "/tmp/"].sort() },
    { ...proof, protectedMountTargets: [...proof.protectedMountTargets, "/tmp"].sort() },
    { ...proof, protectedMountTargets: proof.protectedMountTargets.filter((target) => target !== "/run") },
    { ...proof, keeperNamespace: { ...proof.keeperNamespace, inode: 13 } },
    { ...proof, keeperNamespace: { ...proof.keeperNamespace, device: 5 } },
    { ...proof, constructionNamespace: { ...proof.constructionNamespace, mount: proof.keeperNamespace } },
    { ...proof, constructionNamespace: { ...proof.constructionNamespace, parentMount: proof.keeperNamespace } },
  ]) {
    const f = fixture()
    const ready = await f.adapter.prepare(f.adapter.intent(scope))
    f.hooks.reply = (operation, result) =>
      operation === "inspect" && result && typeof result === "object"
        ? {
            ...result,
            live: {
              keeper: true,
              broker: true,
              namespaces: true,
              socket: true,
              admission: true,
              masks: true,
              maskProof,
            },
          }
        : result
    await expect(f.adapter.validate(ready)).rejects.toThrow(LinuxIsolation.Unavailable)
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
})

test("ready evidence has no raw mount-target fallback or extra parallel authority field", async () => {
  const proof = fixture().maskProof
  for (const live of [
    {
      keeper: true,
      broker: true,
      namespaces: true,
      socket: true,
      admission: true,
      masks: true,
    },
    {
      keeper: true,
      broker: true,
      namespaces: true,
      socket: true,
      admission: true,
      masks: true,
      protectedMountTargets: [...LinuxIsolation.MASKS],
    },
    {
      keeper: true,
      broker: true,
      namespaces: true,
      socket: true,
      admission: true,
      masks: true,
      maskProof: proof,
      protectedMountTargets: [...LinuxIsolation.MASKS],
    },
  ]) {
    const f = fixture()
    const ready = await f.adapter.prepare(f.adapter.intent(scope))
    f.hooks.reply = (operation, result) =>
      operation === "inspect" && result && typeof result === "object" ? { ...result, live } : result
    await expect(f.adapter.validate(ready)).rejects.toThrow()
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
})

test("v2 mask evidence binds the current public keeper namespace for each live receipt", async () => {
  for (const matching of [false, true]) {
    const f = fixture()
    const ready = await f.adapter.prepare(f.adapter.intent(scope))
    const updated = { ...f.publicSpec, namespaces: { ...f.publicSpec.namespaces, mnt: 14 } }
    f.hooks.reply = (operation, result) =>
      operation === "inspect" && result && typeof result === "object"
        ? {
            ...result,
            public: updated,
            live: {
              keeper: true,
              broker: true,
              namespaces: true,
              socket: true,
              admission: true,
              masks: true,
              maskProof: matching
                ? { ...f.maskProof, keeperNamespace: { device: updated.devices.mnt, inode: updated.namespaces.mnt } }
                : f.maskProof,
            },
          }
        : result
    if (!matching) await expect(f.adapter.validate(ready)).rejects.toThrow(LinuxIsolation.Unavailable)
    if (matching) expect(await f.adapter.validate(ready)).toEqual(ready)
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
})

test("bounded UTF-8 v2 evidence can exceed the former client limit without widening the outer receipt cap", async () => {
  const f = fixture()
  const maskProof = {
    ...f.maskProof,
    protectedMountTargets: [
      ...f.maskProof.protectedMountTargets,
      ...Array.from({ length: 8 }, (_, index) => `/tmp/p${index}-` + "λ".repeat(400)),
    ].sort(),
  }
  expect(Buffer.byteLength(JSON.stringify(maskProof))).toBeGreaterThan(4096)
  expect(Buffer.byteLength(JSON.stringify(maskProof))).toBeLessThanOrEqual(32_768)
  f.hooks.reply = (operation, result) =>
    (operation === "prepare" || operation === "inspect") && result && typeof result === "object"
      ? {
          ...result,
          live: {
            keeper: true,
            broker: true,
            namespaces: true,
            socket: true,
            admission: true,
            masks: true,
            maskProof,
          },
        }
      : result
  const ready = await f.adapter.prepare(f.adapter.intent(scope))
  expect(await f.adapter.validate(ready)).toEqual(ready)
  expect(f.calls.every((call) => call.maxOutput === 65_536)).toBe(true)
})

test("actual Sandbox rejects a required native run without intent and preserves its failed-before-intent fence", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vector-native-fence-")))
  const workspace = path.join(directory, "checkout")
  const temporary = path.join(directory, "temporary")
  const stateDirectory = path.join(temporary, "vector-sandbox")
  await fs.mkdir(workspace, { mode: 0o700 })
  await fs.mkdir(temporary, { mode: 0o700 })
  await fs.mkdir(stateDirectory, { mode: 0o700 })
  const statePath = path.join(stateDirectory, "state.json")
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    VECTOR_MODE: "codium",
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    PATH: process.env.PATH,
    GITHUB_TOKEN: "fixture-only",
    VECTOR_CLI_TOKEN: "vct_fixture.signature",
  }
  try {
    const state = {
      v: 1,
      workspace,
      container: scope.container,
      created: true,
      mode: "codium",
      sudo: false,
      uid: scope.uid,
      gid: scope.gid,
      prepared: true,
      isolatedTools: true,
      nativeRequired: true,
    }
    await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: "wx" })
    await expect(run([process.execPath, "--version"], env)).rejects.toThrow(
      process.platform === "linux"
        ? "trusted Linux runner adapter"
        : "The GitHub agent sandbox could not verify its isolation or cleanup. The run is refused.",
    )
    expect(await fs.readFile(statePath, "utf8")).toBe(JSON.stringify(state))
    const failedBeforeIntent = JSON.stringify({
      v: 1,
      workspace,
      container: scope.container,
      created: false,
      mode: "codium",
      sudo: false,
      prepared: false,
      nativeRequired: true,
    })
    await fs.writeFile(statePath, failedBeforeIntent)
    await expect(finish(env)).rejects.toThrow()
    expect(await fs.readFile(statePath, "utf8")).toBe(failedBeforeIntent)
    expect(await fs.readdir(temporary)).toEqual(["vector-sandbox"])
    expect(await fs.readdir(workspace)).toEqual([])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("cleanup refusal or reversed/missing native stop facts never admit an artifact fallback", async () => {
  for (const broken of ["uidStoppedBeforeBroker", "brokerStopped", "namespaceNonce", "installNonce", "extra"]) {
    const f = fixture()
    const ready = await f.adapter.prepare(f.adapter.intent(scope))
    f.hooks.reply = (operation, result) =>
      operation === "cleanup" && result && typeof result === "object"
        ? { ...result, [broken]: broken === "extra" ? true : broken.endsWith("Nonce") ? "f".repeat(32) : false }
        : result
    let copied = false
    await expect(
      f.adapter.cleanup(ready).then(() => {
        copied = true
      }),
    ).rejects.toThrow()
    expect(copied).toBe(false)
    expect(f.operations).toEqual(["install", "prepare", "cleanup"])
  }
  const f = fixture()
  const intent = f.adapter.intent(scope)
  await f.adapter.prepare(intent)
  expect((await f.adapter.cleanup(intent)).artifactsAllowed).toBe(false)
})

test("asset corruption and unsupported scope or JSON authority fail without an executor", () => {
  const f = fixture()
  for (const candidate of [
    { ...asset(), sha256: "0".repeat(64) },
    { ...asset(), entry: "\ud800" },
  ])
    expect(() => GithubIsolation.create({ ...f.ports, asset: candidate })).toThrow()
  for (const candidate of [
    { ...scope, uid: 0 },
    { ...scope, gid: 1.5 },
    { ...scope, container: "/tmp/chosen" },
  ])
    expect(() => f.adapter.intent(candidate)).toThrow()
  const intent = f.adapter.intent(scope)
  expect(() => GithubIsolation.parseState({ ...intent, approved: true })).toThrow()
  expect(() => GithubIsolation.parseState({ ...intent, phase: "ready" })).toThrow()
  expect(f.calls).toHaveLength(0)
})
