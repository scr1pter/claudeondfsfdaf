import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { Computer } from "@vectordevai/schema/computer"
import { createFakeHelper, manualClock } from "../test/computer/fake-helper"
import { encodeFrame, frameReader, type Line, type Received } from "../test/computer/transcript"
import { WINDOWS_TEST_ARTIFACTS, type HelperManifest } from "./build-computer-helper"
import { EXECUTABLE_NAMES } from "./channel-ids"
import { readIdentity } from "./computer-helper-identity"
import { WindowsCheckFailure } from "./computer-helper-windows-diagnostics"
import {
  WINDOWS_NATIVE_CHECKS,
  WINDOWS_NATIVE_CODES,
  WINDOWS_NATIVE_REASONS,
  WINDOWS_NATIVE_STAGES,
  createWindowsVerifiedFixture,
  verifyWindowsNativeFiles,
  windowsNativeChannel,
  windowsNativeSelfTestChecks,
  type VerifiedWindowsArtifacts,
} from "./computer-helper-selftest-windows"
import {
  CORE_TRANSCRIPTS,
  MAC_NATIVE_CHECKS,
  classifySelfTestExit,
  lifecycleTopologyFailure,
  lifecycleDescendants,
  lifecycleProcessAlive,
  nativeSelfTestChecks,
  parseSelfTestArgs,
  runComputerHelperSelfTest,
  transcriptFailureReason,
  validateCoreTranscript,
  waitForLifecycleExit,
  type Command,
  type CommandResult,
  type NativeChannel,
  type SelfTestDependencies,
  type SelfTestOptions,
  type VerifiedFixture,
} from "./computer-helper-selftest"

const fixtures = fileURLToPath(new URL("../test/fixtures/computer-protocol", import.meta.url))
const desktopDirectory = fileURLToPath(new URL("../", import.meta.url))
const options: SelfTestOptions = {
  platform: "darwin",
  bin: "/virtual/VectorComputer.app/Contents/MacOS/VectorComputer",
  tests: "/virtual/tests",
  fixtures,
  privileged: "off",
}
const hello: Line[] = [{ send: { id: 1, op: "hello", protocol: { min: 1, max: 1 } }, expect: { id: 1, ok: true } }]

function fixture(input: { keyboard?: boolean; minimal?: boolean; platform?: "macos" | "windows" } = {}) {
  const state = {
    clock: manualClock(),
    closed: 0,
    opened: 0,
    probes: 0,
    commands: [] as Command[],
    unverified: 0,
    eof: 0,
    parent: 0,
    privileged: [] as string[],
  }
  const native: VerifiedFixture = {
    async probe() {
      state.probes++
      return { permissions: { screen: "denied", accessibility: "denied" }, responsible: true, elevated: false }
    },
    async open(): Promise<NativeChannel> {
      state.opened++
      state.clock = manualClock()
      const inbox: Received[] = []
      const reader = frameReader({ onFrame: (bytes) => inbox.push({ kind: "frame", bytes }) })
      const helper = createFakeHelper(
        { disabled: input.keyboard ? [] : ["input.keyboard"], platform: input.platform },
        {
          clock: state.clock,
          write: (bytes) => reader.push(bytes),
          exit: (code) => inbox.push({ kind: "exit", code }),
        },
      )
      return {
        write: (bytes) => helper.receive(bytes),
        end: () => helper.endOfInput(),
        next: async () => inbox.shift(),
        dispose: async () => {
          helper.endOfInput()
        },
      }
    },
    async unverifiedParent() {
      state.unverified++
      return true
    },
    async eof() {
      state.eof++
      return true
    },
    async parentDeath() {
      state.parent++
      return true
    },
    async privileged(target) {
      if (state.closed) throw new Error("The verified fixture has already closed")
      state.privileged.push(target)
      return {
        code: 0,
        stdout: JSON.stringify({ checks: MAC_NATIVE_CHECKS.privileged.map((name) => ({ name, ok: true })) }),
      }
    },
    async close() {
      state.closed++
    },
  }
  const dependencies: SelfTestDependencies = {
    platform: "darwin",
    fixture: async () => native,
    files: async () => ({ unit: "/virtual/tests/VectorComputerTests" }),
    wait: async (ms) => state.clock.advance(ms),
    ...(input.minimal ? { transcript: async () => hello } : {}),
    async command(command) {
      state.commands.push(command)
      if (!command.args.length) return { code: 0, stdout: "Unit checks passed" }
      const mode = command.args.includes("--self-test=packaged")
        ? "packaged"
        : command.args.includes("--self-test=control")
          ? "targetControl"
          : "unprivileged"
      return {
        code: 0,
        stdout: JSON.stringify({ checks: MAC_NATIVE_CHECKS[mode].map((name) => ({ name, ok: true })) }),
      }
    },
  }
  return { state, native, dependencies }
}

async function windowsArtifacts() {
  const root = await mkdtemp(path.join(tmpdir(), "vector-computer-driver-test-"))
  const tests = path.join(root, "tests")
  await mkdir(tests)
  const executable = readIdentity().windows.executable
  const bin = path.join(root, executable)
  const bytes = Buffer.alloc(256, 0x42)
  bytes.write("MZ")
  bytes.writeUInt32LE(128, 0x3c)
  bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(0x8664, 132)
  bytes.writeUInt16LE(0x20b, 152)
  const hash = createHash("sha256").update(bytes).digest("hex")
  await writeFile(bin, bytes)
  for (const name of [WINDOWS_TEST_ARTIFACTS.unit, WINDOWS_TEST_ARTIFACTS.caller, WINDOWS_TEST_ARTIFACTS.target])
    await writeFile(path.join(tests, name), bytes)
  const helperManifest: HelperManifest = {
    helperVersion: readIdentity().helperVersion,
    protocol: { min: 1, max: 1 },
    platform: "win32",
    files: { [executable]: { sha256: hash, arch: ["x64"] } },
    sourceDigest: "1".repeat(64),
    toolchain: "injected-actual-test-toolchain",
  }
  const testManifest: HelperManifest = {
    ...helperManifest,
    files: Object.fromEntries(
      [WINDOWS_TEST_ARTIFACTS.unit, WINDOWS_TEST_ARTIFACTS.caller, WINDOWS_TEST_ARTIFACTS.target].map((name) => [
        name,
        { sha256: hash, arch: ["x64"] },
      ]),
    ),
  }
  await writeFile(path.join(root, "computer-helper.json"), JSON.stringify(helperManifest))
  await writeFile(path.join(tests, "computer-helper-tests.json"), JSON.stringify(testManifest))
  const files: VerifiedWindowsArtifacts = {
    bin,
    unit: path.join(tests, WINDOWS_TEST_ARTIFACTS.unit),
    caller: path.join(tests, WINDOWS_TEST_ARTIFACTS.caller),
    target: path.join(tests, WINDOWS_TEST_ARTIFACTS.target),
    channel: "beta",
    helperManifest,
    testManifest,
  }
  return { root, files, options: { ...options, platform: "win32" as const, bin, tests } }
}

test("Windows reports require exact native catalogs, fixed reasons and coherent pass/fail/skip exits", () => {
  for (const mode of ["unprivileged", "packaged", "eof", "parentDeath", "targetControl"] as const) {
    const checks = WINDOWS_NATIVE_CHECKS[mode].map((name) => ({ name, ok: true }))
    expect(windowsNativeSelfTestChecks(JSON.stringify({ checks }), mode, 0)).toEqual(checks)
    for (const invalid of [
      { checks: [] },
      { checks: [...checks, checks[0]] },
      { checks, private: "PRIVATE" },
      { checks: checks.map((item) => ({ ...item, name: "PRIVATE" })) },
      { checks: checks.map((item) => ({ ...item, detail: "PRIVATE" })) },
      { checks: checks.map((item) => ({ ...item, ok: false, skipped: true })) },
    ])
      expect(() => windowsNativeSelfTestChecks(JSON.stringify(invalid), mode, 0)).toThrow()
    expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks }), mode, 77)).toThrow()
  }
  const passed = WINDOWS_NATIVE_CHECKS.privileged.map((name) => ({ name, ok: true }))
  expect(windowsNativeSelfTestChecks(JSON.stringify({ checks: passed }), "privileged", 0)).toEqual(passed)
  const checks = passed.map((entry) => ({ ...entry, ok: false, skipped: true, detail: "noninteractive_desktop" }))
  expect(windowsNativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 77)).toEqual(checks)
  expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 0)).toThrow()
  expect(() =>
    windowsNativeSelfTestChecks(
      JSON.stringify({ checks: [{ ...checks[0], ok: true, skipped: false }, ...checks.slice(1)] }),
      "privileged",
      0,
    ),
  ).toThrow()
  const failed = checks.map((entry, index) =>
    index === 1 ? { ...entry, skipped: false, detail: "assertion_failed" } : entry,
  )
  expect(windowsNativeSelfTestChecks(JSON.stringify({ checks: failed }), "privileged", 1)).toEqual(failed)
  expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks: failed }), "privileged", 77)).toThrow()
  for (const detail of WINDOWS_NATIVE_REASONS) {
    const failed = passed.map((entry, index) => (index === 0 ? { ...entry, ok: false, detail } : entry))
    expect(windowsNativeSelfTestChecks(JSON.stringify({ checks: failed }), "privileged", 1)).toEqual(failed)
  }
  for (const invalid of [
    checks.slice(1),
    [...checks, checks[0]],
    [...checks].reverse(),
    checks.map((entry) => ({ ...entry, detail: "PRIVATE" })),
    checks.map((entry) => ({ ...entry, extra: "PRIVATE" })),
    checks.map((entry) => ({ ...entry, detail: "target_validation_failed" })),
    checks.map((entry) => ({ ...entry, detail: "assertion_failed" })),
    checks.map((entry) => ({ name: entry.name, ok: entry.ok, skipped: entry.skipped })),
  ])
    expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks: invalid }), "privileged", 77)).toThrow()
})

test("Windows failed privileged rows accept only paired closed stage and native-code diagnostics", () => {
  const passed = WINDOWS_NATIVE_CHECKS.privileged.map((name) => ({ name, ok: true }))
  const failed = {
    ...passed[2],
    ok: false,
    detail: "native_operation_failed",
    stage: "installed-list-reply",
    nativeCode: "unavailable",
  }
  for (const entry of [
    ...WINDOWS_NATIVE_STAGES.map((stage) => ({ ...failed, stage })),
    ...WINDOWS_NATIVE_CODES.map((nativeCode) => ({ ...failed, nativeCode })),
    { ...failed, skipped: false },
  ]) {
    const checks = passed.map((item, index) => (index === 2 ? entry : item))
    expect(windowsNativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 1)).toEqual(checks)
    expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 77)).toThrow()
  }
  for (const entry of [
    { ...failed, stage: "PRIVATE" },
    { ...failed, nativeCode: "PRIVATE" },
    { ...failed, stage: undefined },
    { ...failed, nativeCode: undefined },
    { ...failed, detail: undefined },
    { ...failed, detail: "" },
    { ...failed, ok: true },
    { ...failed, skipped: true, detail: "noninteractive_desktop" },
  ]) {
    const checks = passed.map((item, index) => (index === 2 ? entry : item))
    const code = entry.ok ? 0 : "skipped" in entry && entry.skipped ? 77 : 1
    expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks }), "privileged", code)).toThrow()
  }
  for (const mode of ["unprivileged", "packaged", "eof", "parentDeath", "targetControl"] as const) {
    const checks = WINDOWS_NATIVE_CHECKS[mode].map((name, index) =>
      index === 0 ? { ...failed, name, detail: undefined } : { name, ok: true },
    )
    expect(() => windowsNativeSelfTestChecks(JSON.stringify({ checks }), mode, 1)).toThrow()
  }
  const macChecks = MAC_NATIVE_CHECKS.privileged.map((name, index) =>
    index === 0 ? { ...failed, name } : { name, ok: true },
  )
  expect(() => nativeSelfTestChecks(JSON.stringify({ checks: macChecks }), "privileged", 1)).toThrow()
  expect(WINDOWS_NATIVE_CODES).toEqual([...Computer.ComputerErrorCode.literals, "unknown"])
})

test("Windows privileged diagnostic enums match the native report allowlists exactly", async () => {
  const source = await readFile(
    path.join(desktopDirectory, "native/computer-helper/windows/src/privileged_self_test.h"),
    "utf8",
  )
  for (const [name, expected] of [
    ["windows_privileged_stages", WINDOWS_NATIVE_STAGES],
    ["windows_privileged_native_codes", WINDOWS_NATIVE_CODES],
  ] as const) {
    const declaration = source.match(new RegExp(`${name}\\s*\\{([^}]+)\\};`))?.[1]
    expect(declaration).toBeDefined()
    expect([...declaration!.matchAll(/L"([^"]+)"/g)].map((match) => match[1])).toEqual([...expected])
  }
})

test("Windows channel inference verifies all test artifacts before the first helper version launch", async () => {
  const prepared = await windowsArtifacts()
  const order: string[] = []
  try {
    const files = await verifyWindowsNativeFiles(prepared.options, desktopDirectory, "x64", {
      source: async (_directory, _platform, channel, toolchain) => {
        order.push(`source.${channel}`)
        expect(toolchain).toBe(prepared.files.helperManifest.toolchain)
        return channel === "beta" ? prepared.files.helperManifest.sourceDigest : "2".repeat(64)
      },
      tests: async (root, architecture, input) => {
        order.push("all-test-bytes-verified")
        expect(root).toBe(prepared.options.tests)
        expect(architecture).toBe("x64")
        expect(input.channel).toBe("beta")
        expect(input.helperManifest).toEqual(prepared.files.helperManifest)
        return prepared.files.testManifest
      },
      helper: async (root, platform, architectures, input) => {
        order.push("helper-pe-hash-and-version")
        expect(root).toBe(prepared.root)
        expect(platform).toBe("win32")
        expect(architectures).toEqual(["x64"])
        expect(input?.channel).toBe("beta")
        expect(input?.directory).toBe(desktopDirectory)
        expect(input?.host).toBeUndefined()
        expect(order.indexOf("all-test-bytes-verified")).toBeLessThan(order.indexOf("helper-pe-hash-and-version"))
        return prepared.files.helperManifest
      },
    })
    expect(files.channel).toBe("beta")
    expect(files.unit).toBe(prepared.files.unit)
    expect(order.filter((item) => item.startsWith("source."))).toHaveLength(3)
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
})

test("missing or ambiguous Windows source channels and invalid test bytes cannot launch a helper", async () => {
  const prepared = await windowsArtifacts()
  let launches = 0
  try {
    for (const ambiguous of [false, true]) {
      await expect(
        verifyWindowsNativeFiles(prepared.options, desktopDirectory, "x64", {
          source: async () => (ambiguous ? "1" : "2").repeat(64),
          helper: async () => {
            launches++
            return prepared.files.helperManifest
          },
        }),
      ).rejects.toThrow("channel")
    }
    await expect(
      verifyWindowsNativeFiles(prepared.options, desktopDirectory, "x64", {
        source: async (_directory, _platform, channel) => (channel === "beta" ? "1" : "2").repeat(64),
        tests: async () => {
          throw new Error("PRIVATE stale caller bytes")
        },
        helper: async () => {
          launches++
          return prepared.files.helperManifest
        },
      }),
    ).rejects.toThrow()
    expect(launches).toBe(0)
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
})

test("Windows fixtures bind copied Caller/helper bytes and use only manifested native lifecycle modes", async () => {
  const prepared = await windowsArtifacts()
  const commands: Command[] = []
  const channels: { executable: string; args: string[] }[] = []
  try {
    const native = await createWindowsVerifiedFixture(prepared.options, desktopDirectory, prepared.files, {
      async command(command) {
        commands.push(command)
        if (command.args.includes("--probe"))
          return {
            code: 0,
            stdout:
              '{"permissions":{"screen":"n/a","accessibility":"n/a"},"responsible":true,"elevated":false,"captureBlocked":false}',
          }
        const mode = command.args.includes("--self-test=lifecycle-eof") ? "eof" : "parentDeath"
        return {
          code: 0,
          stdout: JSON.stringify({ checks: WINDOWS_NATIVE_CHECKS[mode].map((name) => ({ name, ok: true })) }),
        }
      },
      channel(executable, args) {
        channels.push({ executable, args })
        return { write() {}, end() {}, next: async () => ({ kind: "exit", code: 1 }), dispose: async () => {} }
      },
    })
    const running = await native.open()
    await running.dispose()
    const caller = channels[0]!.executable
    expect(path.basename(caller)).toBe(`${EXECUTABLE_NAMES.beta}.exe`)
    expect(channels[0]!.args).toEqual(["--stdio"])
    expect(await readFile(caller)).toEqual(await readFile(prepared.files.caller))
    expect(await readFile(path.join(path.dirname(caller), "resources/computer/vector-computer.exe"))).toEqual(
      await readFile(prepared.files.bin),
    )
    const staged = path.join(path.dirname(caller), "resources/computer")
    expect(await readFile(path.join(staged, "tests", WINDOWS_TEST_ARTIFACTS.target))).toEqual(
      await readFile(prepared.files.target),
    )
    expect(JSON.parse(await readFile(path.join(staged, "computer-helper.json"), "utf8"))).toEqual(
      prepared.files.helperManifest,
    )
    expect(JSON.parse(await readFile(path.join(staged, "tests/computer-helper-tests.json"), "utf8"))).toEqual(
      prepared.files.testManifest,
    )
    await native.probe()
    expect(commands[0]?.windowsDiagnostic).toBe("caller")
    expect(await native.unverifiedParent()).toBe(true)
    expect(channels[1]!.args).toEqual(["--stdio", "--parent-pid", String(process.pid)])
    expect(await native.eof()).toBe(true)
    expect(await native.parentDeath()).toBe(true)
    await expect(native.privileged(path.join(prepared.root, "other-target.exe"))).rejects.toThrow("changed")
    await native.privileged(prepared.files.target)
    expect(commands.map((item) => [item.executable, item.args])).toEqual([
      [caller, ["--probe", "--json"]],
      [prepared.files.unit, ["--self-test=lifecycle-eof"]],
      [prepared.files.unit, ["--self-test=lifecycle-parent-death"]],
      [caller, ["--self-test=privileged"]],
    ])
    expect(commands.at(-1)?.timeoutMs).toBe(150_000)
    await native.close()
    await expect(native.open()).rejects.toThrow("closed")
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
})

test("Windows verified fixture preserves only closed startup and probe-shape failure categories", async () => {
  const prepared = await windowsArtifacts()
  let outcome: { code: number; stdout: string; timedOut?: boolean } = { code: 1, stdout: "PRIVATE" }
  try {
    let transportError = false
    const native = await createWindowsVerifiedFixture(prepared.options, desktopDirectory, prepared.files, {
      command: async () => outcome,
      channel: () => ({
        write() {},
        end() {},
        next: async () => {
          if (transportError) throw new Error("PRIVATE EPIPE")
          return { kind: "exit", code: 1 }
        },
        dispose: async () => {},
        startupDiagnostic: () => ({ caller: "medium.layout" }),
      }),
    })
    await expect(native.probe()).rejects.toThrow("windows-probe-exit-1")
    outcome = { code: 0, stdout: "PRIVATE" }
    await expect(native.probe()).rejects.toThrow("windows-probe-invalid-json")
    outcome = {
      code: 0,
      stdout: JSON.stringify({
        permissions: { screen: "n/a", accessibility: "n/a" },
        responsible: false,
        elevated: false,
        captureBlocked: true,
      }),
    }
    await expect(native.probe()).rejects.toThrow("windows-probe-invalid-responsible")
    const channel = await native.open()
    await expect(channel.next(1000)).rejects.toThrow("windows-caller-medium.layout")
    transportError = true
    await expect(channel.next(1000)).rejects.toThrow("windows-caller-medium.layout")
    await channel.dispose()
    await native.close()
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
})

test("Windows fixture launches only from its canonical owned directory through an ancestor alias", async () => {
  const prepared = await windowsArtifacts()
  const actual = path.join(prepared.root, "actual")
  const alias = path.join(prepared.root, "alias")
  let launches = 0
  try {
    await mkdir(actual)
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
    const created = await mkdtemp(path.join(alias, "owned-"))
    const canonical = await realpath(created)
    expect(created).not.toBe(canonical)
    const native = await createWindowsVerifiedFixture(prepared.options, desktopDirectory, prepared.files, {
      temporary: async () => created,
      command: async () => {
        throw new Error("unreachable")
      },
      channel(executable) {
        launches++
        expect(path.dirname(executable)).toBe(canonical)
        return { write() {}, end() {}, next: async () => ({ kind: "exit", code: 1 }), dispose: async () => {} }
      },
    })
    const channel = await native.open()
    expect(launches).toBe(1)
    expect(await readFile(path.join(canonical, `${EXECUTABLE_NAMES.beta}.exe`))).toEqual(
      await readFile(prepared.files.caller),
    )
    await channel.dispose()
    await native.close()
    await expect(readFile(path.join(canonical, `${EXECUTABLE_NAMES.beta}.exe`))).rejects.toThrow()
  } finally {
    await rm(prepared.root, { recursive: true, force: true })
  }
})

test("Windows copy drift refuses admission before a Caller, unit or helper can execute", async () => {
  for (const artifact of ["caller", "bin", "target"] as const) {
    const prepared = await windowsArtifacts()
    let launches = 0
    try {
      await writeFile(prepared.files[artifact], "changed since source verification")
      await expect(
        createWindowsVerifiedFixture(prepared.options, desktopDirectory, prepared.files, {
          command: async () => {
            launches++
            return { code: 0, stdout: "PRIVATE" }
          },
          channel: () => {
            launches++
            throw new Error("unreachable")
          },
        }),
      ).rejects.toThrow("changed")
      expect(launches).toBe(0)
    } finally {
      await rm(prepared.root, { recursive: true, force: true })
    }
  }
})

test("Windows staged manifests must retain the verified helper and test facts before any child runs", async () => {
  for (const name of ["computer-helper.json", "tests/computer-helper-tests.json"]) {
    const prepared = await windowsArtifacts()
    let launches = 0
    try {
      const file = path.join(prepared.root, name)
      const manifest = JSON.parse(await readFile(file, "utf8"))
      await writeFile(file, JSON.stringify({ ...manifest, sourceDigest: "9".repeat(64) }))
      await expect(
        createWindowsVerifiedFixture(prepared.options, desktopDirectory, prepared.files, {
          command: async () => {
            launches++
            return { code: 0, stdout: "PRIVATE" }
          },
          channel: () => {
            launches++
            throw new Error("unreachable")
          },
        }),
      ).rejects.toThrow("manifest")
      expect(launches).toBe(0)
    } finally {
      await rm(prepared.root, { recursive: true, force: true })
    }
  }
})

test("Windows channel uses three stdio pipes, preserves framed bytes, and kills only its owned child handle", async () => {
  const child = new EventEmitter()
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough()
  const sent: Buffer[] = []
  stdin.on("data", (bytes: Buffer) => sent.push(bytes))
  let kills = 0
  const processState = Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      kills++
      Object.assign(child, { signalCode: "SIGKILL" })
      child.emit("close", null)
      return true
    },
  })
  const channel = windowsNativeChannel("verified-caller.exe", ["--stdio"], ((
    executable: string,
    args: readonly string[],
    setup: unknown,
  ) => {
    expect(executable).toBe("verified-caller.exe")
    expect(args).toEqual(["--stdio"])
    expect(setup).toEqual({ stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    return processState
  }) as unknown as typeof import("node:child_process").spawn)
  const frame = encodeFrame({ id: 1, ok: true })
  channel.write(frame)
  expect(Buffer.concat(sent)).toEqual(Buffer.from(frame))
  stderr.write("PRIVATE native diagnostics")
  stdout.write(frame.subarray(0, 3))
  stdout.write(frame.subarray(3))
  expect(await channel.next(10)).toEqual({ kind: "frame", bytes: Buffer.from(frame.subarray(4)) })
  channel.end()
  await channel.dispose()
  expect(kills).toBe(1)
})

function windowsDriverFixture() {
  const fake = fixture({ minimal: true, platform: "windows" })
  fake.dependencies.platform = "win32"
  fake.dependencies.files = async () => ({
    unit: "/virtual/tests/vector-computer-tests.exe",
    target: "/virtual/tests/computer-test-target.exe",
  })
  fake.native.probe = async () => ({
    permissions: { screen: "n/a", accessibility: "n/a" },
    responsible: true,
    elevated: false,
    captureBlocked: true,
  })
  fake.dependencies.command = async (command) => {
    fake.state.commands.push(command)
    return command.args.length === 0
      ? { code: 0, stdout: "Windows native unit checks passed" }
      : {
          code: 0,
          stdout: JSON.stringify({
            checks: WINDOWS_NATIVE_CHECKS[
              command.args.includes("--self-test=control") ? "targetControl" : "unprivileged"
            ].map((name) => ({ name, ok: true })),
          }),
        }
  }
  fake.native.privileged = async () => ({
    code: 77,
    stdout: JSON.stringify({
      checks: WINDOWS_NATIVE_CHECKS.privileged.map((name) => ({
        name,
        ok: false,
        skipped: true,
        detail: "noninteractive_desktop",
      })),
    }),
  })
  return fake
}

test("Windows report retains closed unit/Caller evidence while every observed failure remains failed", async () => {
  const fake = windowsDriverFixture()
  const command = fake.dependencies.command!
  fake.dependencies.command = async (input) =>
    input.args.length
      ? command(input)
      : {
          code: 1,
          stdout: "PRIVATE",
          diagnostic: {
            schemaVersion: 1,
            trigger: "complete",
            spawned: true,
            exitObserved: true,
            closeObserved: true,
            signaled: false,
            stdoutBytes: 7,
            stderrBytes: 64,
            elapsedMs: 10,
            exitAfterMs: 9,
            closeAfterMs: 10,
            sample: { status: "not-requested", suites: [], waits: [] },
            windows: {
              unitSuite: "lifecycle",
              unitFailure: "integration.reply-pipe",
              caller: "initial.helper-child-exit-failure",
              helper: "safe-start",
              tokenRoute: "restricted-fallback",
              desktop: "owned-proved",
            },
          },
        }
  fake.native.probe = async () => {
    throw new WindowsCheckFailure("windows-caller-medium.layout")
  }
  const result = await runComputerHelperSelfTest({ ...options, platform: "win32" }, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "unit")).toEqual({
    name: "unit",
    status: "failed",
    reason:
      "windows-unit-failure-integration.reply-pipe.caller-initial.helper-child-exit-failure.route-restricted-fallback.desktop-owned-proved.helper-safe-start",
  })
  expect(result.checks.find((check) => check.name === "probe.first")).toEqual({
    name: "probe.first",
    status: "failed",
    reason: "windows-caller-medium.layout",
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
  expect(fake.state.closed).toBe(1)
  expect(transcriptFailureReason("hello", new WindowsCheckFailure("windows-caller-medium.layout"))).toBe(
    "windows-caller-medium.layout",
  )
})

test("Windows driver runs the target-control smoke before native prerequisite skips and retains fixed reasons", async () => {
  const fake = windowsDriverFixture()
  const privileged = fake.native.privileged
  fake.native.privileged = async (target) => {
    expect(fake.state.commands.filter((command) => command.args.includes("--self-test=control"))).toHaveLength(1)
    return privileged(target)
  }
  const result = await runComputerHelperSelfTest(
    { ...options, platform: "win32", privileged: "auto" },
    fake.dependencies,
  )
  expect(result.code).toBe(0)
  expect(result.checks.find((item) => item.name === "packaged.packaged-pe")?.status).toBe("passed")
  expect(result.checks.find((item) => item.name === "privileged.privileged-isolated-target")).toMatchObject({
    status: "skipped",
    reason: "noninteractive_desktop",
  })
  expect(result.checks.find((item) => item.name === "target-control")?.status).toBe("passed")
  expect(result.checks.find((item) => item.name === "target-control.windows-test-target-control-schema")?.status).toBe(
    "passed",
  )
  expect(result.checks.find((item) => item.name === "conformance.heartbeat-loss")?.status).toBe("skipped")
  expect(fake.state.closed).toBe(1)
})

test("Windows driver preserves validated privileged diagnostics and the failed aggregate result", async () => {
  const fake = windowsDriverFixture()
  fake.native.privileged = async () => ({
    code: 1,
    stdout: JSON.stringify({
      checks: WINDOWS_NATIVE_CHECKS.privileged.map((name, index) =>
        index === 2
          ? {
              name,
              ok: false,
              detail: "native_operation_failed",
              stage: "installed-list-native",
              nativeCode: "unavailable",
            }
          : { name, ok: true },
      ),
    }),
  })
  const result = await runComputerHelperSelfTest(
    { ...options, platform: "win32", privileged: "auto" },
    fake.dependencies,
  )
  expect(result.code).toBe(1)
  expect(result.checks.find((item) => item.name === "privileged")).toEqual({
    name: "privileged",
    status: "failed",
    reason: "native-check-failed",
  })
  expect(result.checks.find((item) => item.name === "privileged.apps-installed-target")).toEqual({
    name: "privileged.apps-installed-target",
    status: "failed",
    reason: "native_operation_failed",
    stage: "installed-list-native",
    nativeCode: "unavailable",
  })
  expect(result.checks.filter((item) => item.stage !== undefined || item.nativeCode !== undefined)).toHaveLength(1)
  expect(fake.state.closed).toBe(1)
})

test("Windows target-control and admission/assertion failures stay failures even when optional scenarios can skip", async () => {
  for (const defect of ["control", "admission", "assertion", "inconsistent-skip", "private-reason"] as const) {
    const fake = windowsDriverFixture()
    if (defect === "control") {
      const command = fake.dependencies.command!
      fake.dependencies.command = async (input) =>
        input.args.includes("--self-test=control")
          ? {
              code: 1,
              stdout: JSON.stringify({
                checks: WINDOWS_NATIVE_CHECKS.targetControl.map((name) => ({ name, ok: false })),
              }),
            }
          : command(input)
      fake.native.privileged = async () => {
        throw new Error("An invalid target must not start scenarios")
      }
    } else {
      fake.native.privileged = async () => ({
        code: defect === "inconsistent-skip" ? 77 : 1,
        stdout: JSON.stringify({
          checks: WINDOWS_NATIVE_CHECKS.privileged.map((name, index) =>
            index === 0
              ? {
                  name,
                  ok: false,
                  detail:
                    defect === "admission"
                      ? "target_validation_failed"
                      : defect === "private-reason"
                        ? "PRIVATE"
                        : "assertion_failed",
                }
              : { name, ok: false, skipped: true, detail: "noninteractive_desktop" },
          ),
        }),
      })
    }
    const result = await runComputerHelperSelfTest(
      { ...options, platform: "win32", privileged: "auto" },
      fake.dependencies,
    )
    expect(result.code).toBe(1)
    expect(result.checks.find((item) => item.name === "privileged")?.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    if (defect === "admission")
      expect(result.checks.find((item) => item.name === "privileged.privileged-isolated-target")?.reason).toBe(
        "target_validation_failed",
      )
    expect(fake.state.closed).toBe(1)
  }
})

test("Windows probes cannot omit native capture/token facts or substitute a macOS helper", async () => {
  for (const invalid of ["missing-capture", "wrong-token", "wrong-platform"] as const) {
    const fake = fixture({ minimal: true, platform: invalid === "wrong-platform" ? "macos" : "windows" })
    fake.dependencies.platform = "win32"
    fake.native.probe = async () => ({
      permissions: { screen: "n/a", accessibility: "n/a" },
      responsible: true,
      elevated: invalid === "wrong-token",
      ...(invalid === "missing-capture" ? {} : { captureBlocked: true }),
    })
    fake.dependencies.command = async (command) =>
      command.args.length === 0
        ? { code: 0, stdout: "native units passed" }
        : {
            code: 0,
            stdout: JSON.stringify({ checks: WINDOWS_NATIVE_CHECKS.unprivileged.map((name) => ({ name, ok: true })) }),
          }
    const result = await runComputerHelperSelfTest({ ...options, platform: "win32" }, fake.dependencies)
    expect(result.code).toBe(1)
    expect(
      result.checks.find((item) => item.name === (invalid === "wrong-platform" ? "responsible" : "probe.first"))
        ?.status,
    ).toBe("failed")
    expect(fake.state.closed).toBe(1)
  }
})

test("native:test defaults to privileged off and resolves host-native output paths", () => {
  const mac = parseSelfTestArgs([], "darwin", "arm64")
  expect(mac.privileged).toBe("off")
  expect(mac.bin.endsWith(path.join("native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer"))).toBe(true)
  expect(mac.tests.endsWith(path.join("native/out/darwin/tests"))).toBe(true)
  const win = parseSelfTestArgs([], "win32", "arm64")
  expect(win.bin.endsWith(path.join("native/out/win32/arm64/vector-computer.exe"))).toBe(true)
  expect(() => parseSelfTestArgs([], "linux")).toThrow()
  expect(() => parseSelfTestArgs(["--privileged", "yes"], "darwin")).toThrow()
  expect(() => parseSelfTestArgs(["--unknown"], "darwin")).toThrow()
})

test("77 is a visible skip unless privileged checks are required", () => {
  for (const mode of ["auto", "off"] as const) expect(classifySelfTestExit(77, mode)).toBe("skipped")
  expect(classifySelfTestExit(77, "require")).toBe("failed")
  expect(classifySelfTestExit(0, "require")).toBe("passed")
  expect(classifySelfTestExit(1, "off")).toBe("failed")
  expect(classifySelfTestExit(null, "off")).toBe("failed")
})

test("native reports require the complete fixed catalog and coherent exits", () => {
  for (const mode of ["unprivileged", "packaged", "privileged", "targetControl"] as const) {
    const checks = MAC_NATIVE_CHECKS[mode].map((name) => ({ name, ok: true }))
    expect(nativeSelfTestChecks(JSON.stringify({ checks }), mode, 0)).toEqual(checks)
    for (const invalid of [
      { checks: checks.slice(1) },
      { checks: [...checks, checks[0]] },
      { checks: checks.map((entry, index) => (index === 0 ? { ...entry, name: "private-dynamic-name" } : entry)) },
      ...(checks.length > 1 ? [{ checks: checks.toReversed() }] : []),
      { checks, image: "PRIVATE" },
      { checks: checks.map((entry, index) => (index === 0 ? { ...entry, detail: "PRIVATE" } : entry)) },
      { checks: checks.map((entry, index) => (index === 0 ? { ...entry, typedText: "PRIVATE" } : entry)) },
    ])
      expect(() => nativeSelfTestChecks(JSON.stringify(invalid), mode, 0)).toThrow()
    for (const code of [1, 77, null])
      expect(() => nativeSelfTestChecks(JSON.stringify({ checks }), mode, code)).toThrow()
  }
  const skipped = MAC_NATIVE_CHECKS.privileged.map((name) => ({
    name,
    ok: false,
    skipped: true,
    detail: "accessibility_denied",
  }))
  expect(nativeSelfTestChecks(JSON.stringify({ checks: skipped }), "privileged", 77)).toEqual(skipped)
  expect(() => nativeSelfTestChecks(JSON.stringify({ checks: skipped }), "privileged", 0)).toThrow()
  const failed = skipped.map((entry, index) =>
    index === 0 ? { ...entry, skipped: false, detail: "target_validation_failed" } : entry,
  )
  expect(nativeSelfTestChecks(JSON.stringify({ checks: failed }), "privileged", 1)).toEqual(failed)
  expect(() => nativeSelfTestChecks(JSON.stringify({ checks: failed }), "privileged", 77)).toThrow()
  for (const detail of [
    "target_spawn_failed",
    "target_handshake_failed",
    "target_process_changed",
    "target_responsibility_missing",
    "target_state_invalid",
    "target_identity_unavailable",
    "target_options_invalid",
    "target_bundle_invalid",
    "target_control_invalid",
    "target_application_failed",
    "target_report_invalid",
    "target_encoding_failed",
    "target_output_failed",
    "target_exited",
    "target_crashed",
    "target_snapshot_invalid",
    "target_not_ready",
    "target_window_geometry_invalid",
    "target_view_geometry_invalid",
  ]) {
    const checks = failed.map((entry, index) => (index === 0 ? { ...entry, detail } : entry))
    expect(nativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 1)).toEqual(checks)
    expect(() => nativeSelfTestChecks(JSON.stringify({ checks }), "privileged", 77)).toThrow()
  }
  expect(() => nativeSelfTestChecks(" ".repeat(32_769), "privileged", 77)).toThrow()
})

test("invalid native artifacts stop every subprocess and verified caller before admission", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.files = async () => {
    throw new Error("Synthetic artifact mismatch")
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "unit")).toMatchObject({
    status: "failed",
    reason: "unverified-native-artifacts",
  })
  expect(fake.state.commands).toEqual([])
  expect(fake.state.opened).toBe(0)
  expect(fake.state.probes).toBe(0)
  expect(fake.state.privileged).toEqual([])
})

test("privileged tests stay off even when a verified isolated target is available", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.files = async () => ({
    unit: "/virtual/tests/VectorComputerTests",
    target: "/virtual/tests/VectorComputerTestTarget.app",
  })
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(fake.state.privileged).toEqual([])
  expect(fake.state.closed).toBe(1)
  expect(result.checks.find((check) => check.name === "target-control")).toMatchObject({ status: "passed" })
  expect(fake.state.commands.find((command) => command.args.includes("--self-test=control"))).toMatchObject({
    executable: "/virtual/tests/VectorComputerTestTarget.app/Contents/MacOS/VectorComputerTestTarget",
  })
  expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
    status: "skipped",
    reason: "disabled",
  })
})

test("failed required core checks prevent privileged input and still close the verified caller", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.files = async () => ({
    unit: "/virtual/tests/VectorComputerTests",
    target: "/virtual/tests/VectorComputerTestTarget.app",
  })
  fake.native.eof = async () => false
  const result = await runComputerHelperSelfTest({ ...options, privileged: "require" }, fake.dependencies)
  expect(result.code).toBe(1)
  expect(fake.state.privileged).toEqual([])
  expect(fake.state.closed).toBe(1)
  expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
    status: "failed",
    reason: "required-core-check-failed",
  })
})

test("a malformed privileged report cannot leak payloads or bypass fixture cleanup", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.files = async () => ({
    unit: "/virtual/tests/VectorComputerTests",
    target: "/virtual/tests/VectorComputerTestTarget.app",
  })
  fake.native.privileged = async () => ({
    code: 0,
    stdout: JSON.stringify({
      checks: MAC_NATIVE_CHECKS.privileged.map((name) => ({ name, ok: true, detail: "PRIVATE" })),
    }),
  })
  const result = await runComputerHelperSelfTest({ ...options, privileged: "auto" }, fake.dependencies)
  expect(result.code).toBe(1)
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
  expect(fake.state.closed).toBe(1)
  expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
    status: "failed",
    reason: "invalid-native-result",
  })
})

test("transcript diagnostics identify a bounded line and failure class without response data", () => {
  const cases = [
    ['conformance.frame-too-large:1: expected {"id":0}, got nothing', "line-1-timeout"],
    ['conformance.frame-too-large:2: received a frame that does not decode (not JSON): "PRIVATE"', "line-2-decode"],
    ['conformance.frame-too-large:2: expected {"id":1}, got {"private":"PRIVATE"}', "line-2-mismatch"],
    ['conformance.frame-too-large:1: expected {"id":0}, got exit 1', "line-1-unexpected-exit-1"],
    ["conformance.frame-too-large:2: PRIVATE UNCLASSIFIED ERROR", "line-2-failed"],
  ] as const
  for (const [message, reason] of cases) {
    const result = transcriptFailureReason("frame-too-large", new Error(message))
    expect(result).toBe(reason)
    expect(result).not.toContain("PRIVATE")
  }
  expect(
    transcriptFailureReason("hello", new Error("The conformance fixture contains a non-isolated operation.")),
  ).toBe("fixture-policy")
  expect(transcriptFailureReason("hello", new Error("/PRIVATE/hello.jsonl:2: not a {send, expect} line"))).toBe(
    "fixture-format",
  )
})

test("native failure diagnostics retain bounded exit statuses and only missing versus extra topology", () => {
  for (const code of [0, 1, 70, 137, 255]) {
    expect(
      transcriptFailureReason(
        "frame-too-large",
        new Error(`conformance.frame-too-large:1: expected PRIVATE, got exit ${code}`),
      ),
    ).toBe(`line-1-unexpected-exit-${code}`)
  }
  for (const code of ["-1", "256", "999999999999999999999", "null"]) {
    expect(
      transcriptFailureReason(
        "frame-too-large",
        new Error(`conformance.frame-too-large:1: expected PRIVATE, got exit ${code}`),
      ),
    ).toBe("line-1-unexpected-exit")
  }
  for (const role of ["supervisor", "worker"] as const) {
    expect(lifecycleTopologyFailure(role, 0)).toBe(`${role}-missing`)
    expect(lifecycleTopologyFailure(role, 1)).toBeUndefined()
    for (const count of [2, 3, 1_000_000]) expect(lifecycleTopologyFailure(role, count)).toBe(`${role}-extra`)
  }
})

function inspectedProcess(stdout: string, code = 0): CommandResult {
  return {
    code,
    stdout,
    diagnostic: {
      schemaVersion: 1,
      trigger: "complete",
      spawned: true,
      exitObserved: true,
      closeObserved: true,
      signaled: false,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      elapsedMs: 1,
      exitAfterMs: 1,
      closeAfterMs: 1,
      sample: { status: "not-requested", suites: [], waits: [] },
    },
  }
}

test("Mac topology inspections retain stage and fail closed on incomplete command outcomes", () => {
  for (const role of ["supervisor", "worker"] as const) {
    expect(lifecycleDescendants(role, inspectedProcess("123\n"))).toEqual([123])
    expect(lifecycleDescendants(role, inspectedProcess("123\n456\n"))).toEqual([123, 456])
    expect(lifecycleDescendants(role, inspectedProcess("", 1))).toEqual([])
    const complete = inspectedProcess("123\n")
    for (const [result, reason] of [
      [{ ...complete, timedOut: true }, "timeout"],
      [{ ...complete, diagnostic: { ...complete.diagnostic!, trigger: "wall-deadline" } }, "timeout"],
      [{ ...complete, diagnostic: { ...complete.diagnostic!, trigger: "spawn-failed" } }, "spawn-failed"],
      [{ ...complete, diagnostic: { ...complete.diagnostic!, trigger: "io-error" } }, "incomplete"],
      [{ ...complete, diagnostic: { ...complete.diagnostic!, trigger: "output-cap" } }, "incomplete"],
      [{ ...complete, diagnostic: { ...complete.diagnostic!, closeObserved: false } }, "incomplete"],
      [{ ...complete, diagnostic: undefined }, "incomplete"],
      [inspectedProcess("PRIVATE", 2), "exit-status"],
      [inspectedProcess("PRIVATE"), "malformed-stdout"],
      [inspectedProcess("123\n", 1), "malformed-stdout"],
    ] as const)
      expect(() => lifecycleDescendants(role, result)).toThrow(`${role}-pgrep-${reason}`)
  }
})

test("Mac liveness requires completed ps evidence or a genuine ESRCH including race-to-exit", async () => {
  for (const role of ["supervisor", "worker"] as const) {
    let inspections = 0
    const missing = () => {
      throw Object.assign(new Error("PRIVATE"), { code: "ESRCH" })
    }
    const inspect = async () => {
      inspections++
      return inspectedProcess("S+")
    }
    expect(await lifecycleProcessAlive(role, missing, inspect)).toBe(false)
    expect(inspections).toBe(0)
    for (const status of ["S", "Ss", "R+", "T", "U", "I"]) {
      expect(
        await lifecycleProcessAlive(
          role,
          () => {},
          async () => inspectedProcess(status),
        ),
      ).toBe(true)
    }
    for (const status of ["Z", "Z+", "Zs"]) {
      expect(
        await lifecycleProcessAlive(
          role,
          () => {},
          async () => inspectedProcess(status),
        ),
      ).toBe(false)
    }
    let probes = 0
    expect(
      await lifecycleProcessAlive(
        role,
        () => {
          if (++probes === 2) missing()
        },
        async () => inspectedProcess("", 1),
      ),
    ).toBe(false)
    expect(probes).toBe(2)
    for (const [result, reason] of [
      [{ ...inspectedProcess("Z"), timedOut: true }, "timeout"],
      [
        { ...inspectedProcess("Z"), diagnostic: { ...inspectedProcess("Z").diagnostic!, trigger: "io-error" } },
        "incomplete",
      ],
      [
        { ...inspectedProcess("Z"), diagnostic: { ...inspectedProcess("Z").diagnostic!, trigger: "spawn-failed" } },
        "spawn-failed",
      ],
      [inspectedProcess("", 1), "exit-status"],
      [inspectedProcess("PRIVATE", 2), "exit-status"],
      [inspectedProcess(""), "malformed-stdout"],
      [inspectedProcess("Zombie PRIVATE"), "malformed-stdout"],
      [inspectedProcess("Z\nS"), "malformed-stdout"],
    ] as const) {
      await expect(
        lifecycleProcessAlive(
          role,
          () => {},
          async () => result,
        ),
      ).rejects.toThrow(`${role}-ps-${reason}`)
    }
    for (const [code, reason] of [
      ["EPERM", "probe-denied"],
      ["PRIVATE", "probe-failed"],
    ] as const) {
      await expect(
        lifecycleProcessAlive(
          role,
          () => {
            throw Object.assign(new Error("PRIVATE"), { code })
          },
          inspect,
        ),
      ).rejects.toThrow(`${role}-ps-${reason}`)
    }
    expect(inspections).toBe(0)
  }
})

test("lifecycle exit accepts only global environment events within its original deadline", async () => {
  let now = 0
  const waits: number[] = []
  const messages: Received[] = [
    { kind: "frame", bytes: Buffer.from('{"event":"locked","locked":false}') },
    { kind: "frame", bytes: Buffer.from('{"event":"display_change"}') },
    { kind: "exit", code: 0 },
  ]
  const elapsed = [75, 125, 25]
  const result = await waitForLifecycleExit(
    {
      next: async (ms) => {
        waits.push(ms)
        now += elapsed.shift()!
        return messages.shift()
      },
    },
    1000,
    () => now,
  )
  expect(result).toEqual({ kind: "exit", code: 0 })
  expect(waits).toEqual([1000, 925, 800])
  expect(now).toBe(225)
})

test("hello-only lifecycle checks reject session-scoped events with private-free reason codes", async () => {
  for (const event of [
    { event: "user_input", kind: "key", pid: 101 },
    { event: "stop", by: "chord" },
    { event: "input_detection", alive: false, reason: "secure_input", holder: "PRIVATE" },
    { event: "exit", code: 0 },
  ]) {
    await expect(
      waitForLifecycleExit(
        { next: async () => ({ kind: "frame", bytes: Buffer.from(JSON.stringify(event)) }) },
        1000,
        () => 0,
      ),
    ).rejects.toMatchObject({
      reason: `unexpected-lifecycle-event-${event.event}`,
      message: `unexpected-lifecycle-event-${event.event}`,
    })
  }
})

test("lifecycle checks reject responses, image data, malformed and excess event fields", async () => {
  for (const bytes of [
    Buffer.from("{not JSON"),
    Buffer.from([0, 255, 128, 0]),
    Buffer.from('{"id":1,"ok":true}'),
    Buffer.from('{"imageBytes":1}'),
    Buffer.from('{"event":"locked","locked":"false"}'),
    Buffer.from('{"event":"locked","locked":false,"id":1}'),
    Buffer.from('{"event":"display_change","imageBytes":1}'),
    Buffer.from('{"event":"display_change","private":"PRIVATE"}'),
    Buffer.from('{"event":"unknown"}'),
    Buffer.from("[]"),
    Buffer.alloc(1025, 32),
  ]) {
    await expect(
      waitForLifecycleExit({ next: async () => ({ kind: "frame", bytes }) }, 1000, () => 0),
    ).rejects.toMatchObject({ reason: "unexpected-lifecycle-frame", message: "unexpected-lifecycle-frame" })
  }
})

test("lifecycle events cannot restart the exit deadline or hide an event flood", async () => {
  let now = 0
  const waits: number[] = []
  let reads = 0
  await expect(
    waitForLifecycleExit(
      {
        next: async (ms) => {
          waits.push(ms)
          reads++
          now += reads === 3 ? 201 : 400
          return reads === 3
            ? { kind: "exit", code: 0 }
            : { kind: "frame", bytes: Buffer.from('{"event":"locked","locked":false}') }
        },
      },
      1000,
      () => now,
    ),
  ).rejects.toMatchObject({ reason: "caller-exit-deadline" })
  expect(waits).toEqual([1000, 600, 200])
  reads = 0
  await expect(
    waitForLifecycleExit(
      {
        next: async () => {
          reads++
          return { kind: "frame", bytes: Buffer.from('{"event":"display_change"}') }
        },
      },
      1000,
      () => 0,
    ),
  ).rejects.toMatchObject({ reason: "lifecycle-event-limit" })
  expect(reads).toBe(17)
})

test("lifecycle exit rejects elapsed or invalid clocks and still requires an actual process exit", async () => {
  for (const receivedAt of [1000, 1001, -1, Number.NaN]) {
    let now = 0
    await expect(
      waitForLifecycleExit(
        {
          next: async () => {
            now = receivedAt
            return { kind: "exit", code: 0 }
          },
        },
        1000,
        () => now,
      ),
    ).rejects.toMatchObject({ reason: "caller-exit-deadline" })
  }
  await expect(waitForLifecycleExit({ next: async () => undefined }, 1000, () => 0)).rejects.toMatchObject({
    reason: "caller-exit-deadline",
  })
})

test("transcript diagnostics discard unknown fixtures, arbitrary errors, and out-of-range lines", () => {
  for (const message of [
    "conformance.hello:1: expected PRIVATE, got nothing",
    "conformance.frame-too-large:0: expected PRIVATE, got nothing",
    "conformance.frame-too-large:1001: expected PRIVATE, got nothing",
    "conformance.frame-too-large:999999999999999999: expected PRIVATE, got nothing",
    "PRIVATE arbitrary child stderr",
  ])
    expect(transcriptFailureReason("frame-too-large", new Error(message))).toBe("transcript-failed")
  expect(transcriptFailureReason("unknown", new Error("conformance.unknown:1: expected PRIVATE, got nothing"))).toBe(
    "transcript-failed",
  )
  expect(transcriptFailureReason("hello", { message: "PRIVATE" })).toBe("transcript-failed")
})

test("M1 runs the nine applicable actual C1 transcripts and visibly skips keyboard heartbeat coverage", async () => {
  const fake = fixture()
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(
    result.checks.filter((check) => check.name.startsWith("conformance.") && check.status === "passed"),
  ).toHaveLength(9)
  expect(result.checks.find((check) => check.name === "conformance.heartbeat-loss")).toEqual({
    name: "conformance.heartbeat-loss",
    status: "skipped",
    reason: "requires-input.keyboard",
  })
  expect(fake.state.commands.map((command) => command.args)).toEqual([
    [],
    ["--self-test=unprivileged"],
    ["--self-test=packaged"],
  ])
  expect(fake.state.unverified).toBe(1)
  expect(fake.state.eof).toBe(1)
  expect(fake.state.parent).toBe(1)
  expect(fake.state.probes).toBe(2)
  expect(fake.state.closed).toBe(1)
  expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
    status: "skipped",
    reason: "disabled",
  })
})

test("a helper advertising keyboard support must pass unchanged heartbeat-loss assertions", async () => {
  const fake = fixture({ keyboard: true })
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(
    result.checks.filter((check) => check.name.startsWith("conformance.") && check.status === "passed"),
  ).toHaveLength(10)
  expect(fake.state.opened).toBe(CORE_TRANSCRIPTS.length + 1)
})

test("two one-shot probes validate separate observations without recording grant details", async () => {
  const fake = fixture({ minimal: true })
  fake.native.probe = async () => {
    fake.state.probes++
    return {
      permissions: {
        screen: fake.state.probes === 1 ? "notDetermined" : "granted",
        accessibility: "restricted",
        postEvent: "denied",
      },
      responsible: true,
      elevated: false,
      detail: "PRIVATE PROBE OUTPUT",
    }
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(fake.state.probes).toBe(2)
  expect(result.checks.filter((check) => check.name.startsWith("probe."))).toEqual([
    { name: "probe.first", status: "passed" },
    { name: "probe.fresh", status: "passed" },
  ])
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|notDetermined|granted|restricted|postEvent/)
})

test("a probe needs valid permission states, its own responsibility, and an explicitly unelevated token", async () => {
  for (const invalid of [
    { permissions: { screen: "unknown", accessibility: "denied" }, responsible: true, elevated: false },
    { permissions: { screen: "denied" }, responsible: true, elevated: false },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: false, elevated: false },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: true, elevated: true },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: true },
  ]) {
    const fake = fixture({ minimal: true })
    fake.native.probe = async () => {
      fake.state.probes++
      return invalid
    }
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(fake.state.probes).toBe(2)
    expect(
      result.checks
        .filter((check) => check.name.startsWith("probe."))
        .every((check) => check.status === "failed" && check.reason === "native-probe-failed"),
    ).toBe(true)
  }
})

test("auto skips an absent isolated target while require fails without launching privileged scenarios", async () => {
  for (const mode of ["auto", "require"] as const) {
    const fake = fixture({ minimal: true })
    const result = await runComputerHelperSelfTest({ ...options, privileged: mode }, fake.dependencies)
    expect(result.code).toBe(mode === "require" ? 1 : 0)
    expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
      status: mode === "require" ? "failed" : "skipped",
      reason: "isolated-target-unavailable",
    })
    expect(fake.state.commands.some((command) => command.args.includes("--self-test=privileged"))).toBe(false)
  }
})

test("optional native 77 stays skipped and required native 77 fails against the fixed isolated target", async () => {
  for (const mode of ["auto", "require"] as const) {
    const fake = fixture({ minimal: true })
    fake.dependencies.files = async () => ({
      unit: "/virtual/tests/VectorComputerTests",
      target: "/virtual/tests/VectorComputerTestTarget.app",
    })
    fake.native.privileged = async (target) => {
      expect(fake.state.closed).toBe(0)
      fake.state.privileged.push(target)
      return {
        code: 77,
        stdout: JSON.stringify({
          checks: MAC_NATIVE_CHECKS.privileged.map((name) => ({
            name,
            ok: false,
            skipped: true,
            detail: "accessibility_denied",
          })),
        }),
      }
    }
    const result = await runComputerHelperSelfTest({ ...options, privileged: mode }, fake.dependencies)
    expect(result.code).toBe(mode === "require" ? 1 : 0)
    expect(result.checks.find((check) => check.name === "privileged")?.status).toBe(
      mode === "require" ? "failed" : "skipped",
    )
    expect(fake.state.privileged).toEqual(["/virtual/tests/VectorComputerTestTarget.app"])
    expect(fake.state.commands.some((command) => command.args.includes("--self-test=privileged"))).toBe(false)
    expect(fake.state.closed).toBe(1)
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  }
})

test("unit, unprivileged and packaged checks cannot skip required grant-free coverage with exit 77", async () => {
  for (const name of ["unit", "unprivileged", "packaged"]) {
    const fake = fixture({ minimal: true })
    const command = fake.dependencies.command!
    fake.dependencies.command = async (value) => {
      const current = value.args.length === 0 ? "unit" : value.args[0]?.replace("--self-test=", "")
      if (current !== name) return command(value)
      return { code: 77, stdout: JSON.stringify({ checks: [{ name: "strict-cli", ok: false, skipped: true }] }) }
    }
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(result.checks.find((check) => check.name === name)).toMatchObject({
      status: "failed",
      reason: "unexpected-core-skip",
    })
  }
})

test("raw child reports, unknown check names, and conformance diagnostics never enter the summary", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.command = async (command) =>
    command.args.length
      ? {
          code: 0,
          stdout: JSON.stringify({
            checks: [
              { name: "clipboard-secret-42", ok: true, detail: "PRIVATE TYPED TEXT", image: "data:image/png;SECRET" },
            ],
          }),
        }
      : { code: 0, stdout: "PRIVATE UNIT OUTPUT" }
  fake.dependencies.transcript = async () => {
    throw new Error("PRIVATE TRANSCRIPT SCREEN TEXT")
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|clipboard-secret/)
  expect(result.checks.find((check) => check.name === "unprivileged")).toMatchObject({
    status: "failed",
    reason: "invalid-native-result",
  })
  expect(result.checks.some((check) => check.name === "unprivileged.check-1")).toBe(false)
  expect(result.checks.find((check) => check.name === "conformance.hello")).toMatchObject({
    status: "failed",
    reason: "transcript-failed",
  })
})

test("a fixture loss after hello marks all unrun checks failed and always closes the fixture", async () => {
  const fake = fixture({ minimal: true })
  const open = fake.native.open
  fake.native.open = async () => {
    if (fake.state.opened) throw new Error("The virtual caller stopped")
    return open()
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "responsible")?.status).toBe("passed")
  expect(result.checks.find((check) => check.name === "conformance.hello")?.status).toBe("failed")
  expect(result.checks.some((check) => check.reason === "not-run")).toBe(false)
  expect(fake.state.closed).toBe(1)
})

test("responsibility false cannot turn a functioning framed helper into accepted native evidence", async () => {
  const fake = fixture({ minimal: true })
  const open = fake.native.open
  fake.native.open = async () => {
    const channel = await open()
    return {
      ...channel,
      async next(ms) {
        const value = await channel.next(ms)
        if (value?.kind !== "frame") return value
        const message = JSON.parse(Buffer.from(value.bytes).toString("utf8"))
        message.responsible = false
        return { kind: "frame", bytes: Buffer.from(JSON.stringify(message)) }
      },
    }
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "responsible")).toMatchObject({ status: "failed" })
  expect(fake.state.closed).toBe(1)
})

test("grant-free fixture validation refuses prompts, granted owners, foreign input, and oversize changes", () => {
  for (const send of [
    { id: 1, op: "permissions.request", service: "screen" },
    { id: 1, op: "session.begin", approved: [{ pid: 1 }] },
    { id: 1, op: "input.type", pid: 1, text: "Do not type" },
    { $raw: JSON.stringify({ id: 1, op: "permissions.reset", service: "screen" }) },
    { $oversize: 123 },
  ])
    expect(() => validateCoreTranscript("hello", [{ send, expect: null }])).toThrow()
  expect(() =>
    validateCoreTranscript("heartbeat-loss", [
      { send: { id: 3, op: "input.key", pid: 99999, combo: ["a"], repeat: 1 }, expect: null },
    ]),
  ).not.toThrow()
})

test("raw conformance rejects parser ambiguity and permits only the exact C1 malformed sentinel", () => {
  for (const raw of [
    '{"id":1,"op":"permissions.request","op":"hello","service":"screen"}',
    '{"id":1,"op":"permissions.reset","service":"screen",}',
    '{"id":1,"op":"permissions.request","service":"screen",}',
    '{"id":1,"op":"hello",}',
    '{"id":1,"op":"hello","op":"hello"}',
    '{"id":1,"op":"\\u0068ello"}',
    '{ "id":1,"op":"hello"}',
    '{"id":1,"op":"permissions.request"',
    "{arbitrary malformed input",
    "{not json ",
  ])
    expect(() => validateCoreTranscript("malformed-json", [{ send: { $raw: raw }, expect: null }])).toThrow()
  expect(() => validateCoreTranscript("hello", [{ send: { $raw: "{not json" }, expect: null }])).toThrow()
  for (const raw of ["{not json", "[1,2,3]", '{"op":"hello","protocol":{"min":1,"max":1}}'])
    expect(() => validateCoreTranscript("malformed-json", [{ send: { $raw: raw }, expect: null }])).not.toThrow()
})

test("a mismatched host refuses before any child command or fixture can start", async () => {
  const fake = fixture()
  await expect(runComputerHelperSelfTest(options, { ...fake.dependencies, platform: "linux" })).rejects.toThrow()
  expect(fake.state.commands).toEqual([])
  expect(fake.state.opened).toBe(0)
})

test("unclassified or missing transcripts fail the catalog before any native command or fixture starts", async () => {
  const known = CORE_TRANSCRIPTS.map((name) => `${name}.jsonl`)
  for (const catalog of [
    [...known, "private-unclassified-scenario.jsonl"],
    [...known, "nested/new-case.jsonl"],
    known.slice(1),
  ]) {
    const fake = fixture({ minimal: true })
    let fixtureCalls = 0
    const create = fake.dependencies.fixture!
    fake.dependencies.fixture = async (value) => {
      fixtureCalls++
      return create(value)
    }
    fake.dependencies.catalog = async () => catalog
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(result.checks.find((check) => check.name === "catalog")).toEqual({
      name: "catalog",
      status: "failed",
      reason: "unclassified-fixture-catalog",
    })
    expect(fake.state.commands).toEqual([])
    expect(fixtureCalls).toBe(0)
    expect(fake.state.opened).toBe(0)
    expect(fake.state.probes).toBe(0)
    expect(JSON.stringify(result)).not.toMatch(/private-unclassified|new-case|nested/)
  }
})
