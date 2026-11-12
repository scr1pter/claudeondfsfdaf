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
  const hooks: { reply?: (operation: string, result: unknown) => unknown; installed?: () => void } = {}
  const embedded = asset()
  const ports: GithubIsolation.Ports = {
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
            live: { keeper: true, broker: true, namespaces: true, socket: true, admission: true },
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
  return { adapter, embedded, ports, files, calls, operations, publicSpec, hooks }
}

test("native selection is compile-time only and absent build bytes cannot activate a runtime path", () => {
  expect(GithubIsolation.enabled()).toBe(false)
  expect(() => GithubIsolation.fromBuild()).toThrow()
  expect(GithubIsolation.validState({ ...scope, native: true })).toBe(false)
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
    expect(call.args).not.toContain("/workspace/packages/core/src/process-isolation/linux/entry.py")
    expect(call.input).toBe(call.args[6] === "install" ? JSON.stringify(f.embedded) : "")
  }
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

test("structural adopted JSON alone cannot substitute for live process, namespace, socket and broker admission proof", async () => {
  for (const missing of ["all", "keeper", "broker", "namespaces", "socket", "admission"]) {
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
        live: { keeper: true, broker: true, namespaces: true, socket: true, admission: true, [missing]: false },
      }
    }
    await expect(f.adapter.validate(ready)).rejects.toThrow()
    expect(f.operations).toEqual(["install", "prepare", "inspect"])
  }
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
    await expect(run([process.execPath, "--version"], env)).rejects.toThrow("trusted Linux runner adapter")
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
