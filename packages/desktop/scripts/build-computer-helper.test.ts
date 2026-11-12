import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  buildComputerHelper,
  COMPUTER_HELPER_BUILD_INPUTS,
  checkIdentityLock,
  computeSourceDigest,
  createManifest,
  MAC_TEST_TARGET,
  WINDOWS_TEST_ARTIFACTS,
  parseBuildOptions,
  parseHelperManifest,
  renderHelperPlist,
  sourceDigestFor,
  swiftArguments,
  verifyPrebuiltHelper,
  verifyMacTestArtifacts,
  verifyWindowsTestArtifacts,
  windowsToolchainSelection,
} from "./build-computer-helper"
import type { HelperManifest, IdentityLock, NativeCommand } from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"

const directory = fileURLToPath(new URL("../", import.meta.url))
const hash = "a".repeat(64)
const codeHash = "b".repeat(40)
// Synthetic native-environment observations, not measured owner or CI toolchain evidence.
const windowsEnvironment = { VCToolsVersion: "14.44.35207", WindowsSDKVersion: "10.0.26100.0\\" }
const baseline: IdentityLock = {
  enforce: true,
  helperVersion: "1.0.0",
  sourceDigest: hash,
  toolchain: "measured Swift",
  cdhash: { x64: codeHash, arm64: codeHash },
}
const manifest: HelperManifest = {
  helperVersion: "1.0.0",
  protocol: { min: 1, max: 1 },
  platform: "darwin",
  sourceDigest: hash,
  toolchain: "measured Swift",
  files: { "VectorComputer.app/Contents/MacOS/VectorComputer": { sha256: hash, arch: ["x64", "arm64"] } },
}

async function fixture<T>(run: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "vector-computer-build-"))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test(
  "actual Node compiler collection retains late diagnostics and separates bounds from compiler exits",
  () =>
    fixture(async (root) => {
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL("./build-computer-helper.ts", import.meta.url))],
        outdir: root,
        target: "node",
        format: "esm",
        naming: "native-command.mjs",
      })
      expect(built.success).toBe(true)
      const observed = spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          String.raw`
        const driver = await import(process.argv[1]);
        const settings = {cwd: process.cwd(), env: {...process.env, PRIVATE_ENV: "ENV_SECRET"}, timeoutMs: 5000};
        const summarize = result => ({
          code: result.code, reason: result.failureReason,
          bytes: Buffer.byteLength(result.diagnostic ?? ""),
          head: result.diagnostic?.includes("COMPILER_HEAD"),
          tail: result.diagnostic?.includes("LATE_MSVC_ERROR"),
          stderr: result.diagnostic?.includes("COMPILER_STDERR"),
          truncated: result.diagnostic?.includes("[native output truncated]"),
        });
        const late = await driver.runNativeCommand(process.execPath, ["-e",
          'process.stderr.write("COMPILER_STDERR\\n");process.stdout.write("COMPILER_HEAD\\n"+"λ".repeat(50000)+"\\nLATE_MSVC_ERROR\\n",()=>process.exit(2))'], settings);
        const capped = await driver.runNativeCommand(process.execPath, ["-e",
          'process.stdout.write("COMPILER_HEAD\\n"+"x".repeat(4*1024*1024+65536),()=>process.exit(0))'], settings);
        const deadline = await driver.runNativeCommand(process.execPath, ["-e",
          'setTimeout(()=>process.exit(0),3000)'], {...settings, timeoutMs: 150});
        const missing = await driver.runNativeCommand("vector-no-such-native-compiler", ["ARG_SECRET"], settings);
        const invalid = await driver.runNativeCommand("invalid\0compiler", ["ARG_SECRET"], settings);
        console.log(JSON.stringify({late: summarize(late), capped: summarize(capped), deadline: summarize(deadline), missing, invalid}));
      `,
          pathToFileURL(path.join(root, "native-command.mjs")).href,
        ],
        { cwd: directory, encoding: "utf8", timeout: 15_000, maxBuffer: 65_536 },
      )
      expect(observed.error).toBeUndefined()
      expect(observed.status, observed.stderr).toBe(0)
      const report = JSON.parse(observed.stdout)
      expect(report.late).toMatchObject({ code: 2, head: true, tail: true, truncated: true })
      expect(report.late.reason).toBeUndefined()
      expect(report.late.bytes).toBeLessThanOrEqual(32_768)
      expect(report.capped).toMatchObject({ code: 1, reason: "output-cap", head: true, truncated: true })
      expect(report.capped.bytes).toBeLessThanOrEqual(32_768)
      expect(report.deadline).toMatchObject({ code: 1, reason: "timed-out" })
      for (const result of [report.missing, report.invalid])
        expect(result).toMatchObject({ code: 1, stdout: "", stderr: "", failureReason: "spawn-failed" })
      expect(observed.stdout).not.toContain("ARG_SECRET")
      expect(observed.stdout).not.toContain("ENV_SECRET")
    }),
  25_000,
)

describe("computer helper build planning", () => {
  test("Windows toolset and SDK selectors use the actual developer environment and reject unmeasured values", () => {
    expect(windowsToolchainSelection(windowsEnvironment)).toEqual({ toolset: "14.44.35207", sdk: "10.0.26100.0" })
    expect(windowsToolchainSelection({ ...windowsEnvironment, WindowsSDKVersion: "10.0.22621.0" }).sdk).toBe(
      "10.0.22621.0",
    )
    for (const environment of [{}, { VCToolsVersion: "14.44.35207" }, { WindowsSDKVersion: "10.0.26100.0" }])
      expect(() => windowsToolchainSelection(environment)).toThrow("requires VCToolsVersion and WindowsSDKVersion")
    for (const environment of [
      { ...windowsEnvironment, VCToolsVersion: "latest" },
      { ...windowsEnvironment, VCToolsVersion: "14.44.35207,host=x86" },
      { ...windowsEnvironment, WindowsSDKVersion: "10.0" },
      { ...windowsEnvironment, WindowsSDKVersion: "10.0.26100.0,version=10.0" },
    ])
      expect(() => windowsToolchainSelection(environment)).toThrow("invalid VCToolsVersion or WindowsSDKVersion")
  })
  test("Windows defaults to its supported native CPU while explicit cross-builds remain selectable", () => {
    expect(parseBuildOptions([], { host: "win32", hostArchitecture: "arm64" }).architectures).toEqual(["arm64"])
    expect(parseBuildOptions([], { host: "win32", hostArchitecture: "x64" }).architectures).toEqual(["x64"])
    expect(parseBuildOptions([], { host: "win32", hostArchitecture: "ia32" }).architectures).toEqual(["x64"])
    expect(parseBuildOptions(["--arch", "x64"], { host: "win32", hostArchitecture: "arm64" }).architectures).toEqual([
      "x64",
    ])
    expect(parseBuildOptions([], { host: "darwin", hostArchitecture: "arm64" }).architectures).toEqual(["x64", "arm64"])
  })
  test("defaults to production universal macOS and normalizes explicit slices", () => {
    const options = parseBuildOptions([], { host: "darwin", directory: "/fixture" })
    expect(options).toEqual({
      platform: "darwin",
      architectures: ["x64", "arm64"],
      channel: "prod",
      out: path.resolve("/fixture/native/out/darwin"),
      checkLock: false,
      prebuilt: false,
    })
    expect(
      parseBuildOptions(["--platform=win32", "--arch", "arm64,x64", "--channel", "beta"], { host: "linux" })
        .architectures,
    ).toEqual(["x64", "arm64"])
    expect(
      parseBuildOptions(["--platform", "darwin", "--arch", "x64", "--out", "result"], {
        directory: "/fixture",
        prebuilt: "true",
      }).out,
    ).toBe(path.resolve("/fixture/result"))
  })

  test("refuses duplicate, missing, incompatible and ambiguous flags", () => {
    for (const argv of [
      ["--platform", "linux"],
      ["--platform", "darwin", "--arch", "x64,x64"],
      ["--platform", "win32", "--arch", "universal"],
      ["--platform", "darwin", "--arch", "armv7"],
      ["--platform", "darwin", "--channel", "unknown"],
      ["--out"],
      ["--mystery"],
      ["--platform", "darwin", "--platform", "darwin"],
      ["--platform", "darwin", "--check-lock", "--check-lock"],
      ["--platform", "darwin", "--channel", "beta", "--check-lock"],
      ["--platform", "win32", "--check-lock"],
    ])
      expect(() => parseBuildOptions(argv)).toThrow()
    expect(() => parseBuildOptions(["--platform", "darwin"], { prebuilt: "/unverified/binary" })).toThrow()
  })

  test("plans the actual minimum deployment target, native frameworks and stable paths per slice", () => {
    const input = {
      sources: ["/fixture/Sources/z.swift", "/fixture/Sources/main.swift"],
      generated: "/tmp/generated/Identity.swift",
      output: "/tmp/bin",
      sourceRoot: "/fixture",
      sdk: "/SDK",
    }
    const arm = swiftArguments({ ...input, arch: "arm64" })
    const intel = swiftArguments({ ...input, arch: "x64" })
    expect(arm.slice(0, 6)).toEqual(["--sdk", "macosx", "swiftc", "-O", "-wmo", "-target"])
    expect(arm).toContain("arm64-apple-macos14.0")
    expect(intel).toContain("x86_64-apple-macos14.0")
    expect(arm).toContain("/fixture=.")
    expect(arm).toContain("/tmp/generated=./generated")
    expect(arm).toContain("Security")
    expect(arm).toContain("Carbon")
    expect(arm).toContain("ImageIO")
    expect(arm).toContain("CoreText")
    expect(arm).toContain("CryptoKit")
    expect(arm.indexOf(input.sources[1]!)).toBeLessThan(arm.indexOf(input.sources[0]!))
    expect(arm.slice(-3)).toEqual([input.generated, "-o", input.output])
    expect(arm).not.toContain("-parse-as-library")
  })

  test("source identity is order-independent but binds names, bytes and the measured toolchain", () => {
    const first = { path: "Sources/a.swift", bytes: Buffer.from("ab") }
    const second = { path: "Sources/b.swift", bytes: Buffer.from("c") }
    expect(computeSourceDigest([first, second], "Swift 1")).toBe(computeSourceDigest([second, first], "Swift 1"))
    expect(computeSourceDigest([first, second], "Swift 1")).not.toBe(computeSourceDigest([first, second], "Swift 2"))
    expect(computeSourceDigest([first, second], "Swift 1")).not.toBe(
      computeSourceDigest(
        [
          { ...first, bytes: Buffer.from("a") },
          { ...second, bytes: Buffer.from("bc") },
        ],
        "Swift 1",
      ),
    )
    expect(() => computeSourceDigest([first, first], "Swift 1")).toThrow()
    expect(() => computeSourceDigest([{ ...first, path: "../outside.swift" }], "Swift 1")).toThrow()
    expect(() => computeSourceDigest([first], "")).toThrow()
  })

  test("the manifest has a fixed shape, stable file ordering and no build timestamps", () => {
    const result = createManifest({
      ...manifest,
      files: { z: { sha256: hash, arch: ["arm64", "x64"] }, a: { sha256: hash, arch: ["x64"] } },
    })
    expect(Object.keys(result.files)).toEqual(["a", "z"])
    expect(result.files.z!.arch).toEqual(["x64", "arm64"])
    expect(Object.keys(result)).toEqual(["helperVersion", "protocol", "platform", "files", "sourceDigest", "toolchain"])
    expect(() => parseHelperManifest({ ...manifest, builtAt: 123 })).toThrow()
    for (const file of ["../escape", "/absolute", "a/../b", "a\\b", "C:escape", "a//b"])
      expect(() => parseHelperManifest({ ...manifest, files: { [file]: { sha256: hash, arch: ["x64"] } } })).toThrow()
    expect(() =>
      parseHelperManifest({
        ...manifest,
        platform: "win32",
        files: { "A.exe": { sha256: hash, arch: ["x64"] }, "a.exe": { sha256: hash, arch: ["x64"] } },
      }),
    ).toThrow()
  })

  test("the six M10 substitutions are complete and escaped without treating values as template syntax", () => {
    const values = {
      HELPER_BUNDLE_ID: "ai.vector.app.computer",
      HELPER_EXECUTABLE: "VectorComputer",
      HELPER_NAME: "A & <B>",
      HELPER_VERSION: "1.0.0",
      MINIMUM_SYSTEM_VERSION: "14.0",
      SOURCE_DIGEST: hash,
    }
    const template = Object.keys(values)
      .map((key) => `<string>{{${key}}}</string>`)
      .join("\n")
    expect(renderHelperPlist(template, values)).toContain("A &amp; &lt;B&gt;")
    expect(() => renderHelperPlist(`${template}{{UNKNOWN}}`, values)).toThrow()
    expect(() => renderHelperPlist(template.replace("{{SOURCE_DIGEST}}", ""), values)).toThrow()
    expect(() => renderHelperPlist(template, { ...values, SOURCE_DIGEST: "unmeasured" })).toThrow()
  })
})

describe("the macOS helper identity lock", () => {
  test("the explicit bootstrap lock always fails instead of fabricating native evidence", async () => {
    const lock: unknown = JSON.parse(
      await readFile(path.join(directory, "native/computer-helper/macos/identity.lock.json"), "utf8"),
    )
    expect((lock as IdentityLock).enforce).toBe(true)
    const bootstrap = { enforce: true, helperVersion: "1.0.0", sourceDigest: null, toolchain: null, cdhash: {} }
    expect(checkIdentityLock(bootstrap, baseline)).toEqual({
      ok: false,
      enforced: true,
      problems: ["The macOS helper identity lock has no measured native baseline."],
    })
    if ((lock as IdentityLock).sourceDigest === null) expect(checkIdentityLock(lock, baseline).ok).toBe(false)
    else expect((lock as IdentityLock).sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(checkIdentityLock({ ...baseline, enforce: false, sourceDigest: null }, baseline).ok).toBe(false)
  })

  test("source changes need a helper version bump and every cdhash change needs a reviewed lock", () => {
    expect(checkIdentityLock(baseline, baseline).ok).toBe(true)
    expect(checkIdentityLock(baseline, { ...baseline, sourceDigest: "c".repeat(64) }).problems).toContain(
      "Helper sources or toolchain changed without a helperVersion bump.",
    )
    expect(checkIdentityLock(baseline, { ...baseline, helperVersion: "1.0.1", sourceDigest: "c".repeat(64) }).ok).toBe(
      false,
    )
    expect(checkIdentityLock(baseline, { ...baseline, cdhash: { x64: "d".repeat(40) } }).ok).toBe(false)
    expect(checkIdentityLock(baseline, { ...baseline, toolchain: "Swift changed" }).ok).toBe(false)
    expect(checkIdentityLock(baseline, { ...baseline, cdhash: {} }).ok).toBe(false)
  })
})

describe("native build boundaries", () => {
  test("a prebuilt Mac lock check requires a native host before invoking any command", async () => {
    const options = parseBuildOptions(["--platform", "darwin", "--check-lock"], { prebuilt: "true" })
    const run: NativeCommand = async () => {
      throw new Error("Unexpected native command")
    }
    await expect(buildComputerHelper(options, { host: "linux", run })).rejects.toMatchObject({
      exitCode: 2,
      message: "Read macOS cdhash values on macOS.",
    })
  })

  test("an ARM64 Windows prebuilt verifies bytes and headers on x64 without executing a foreign PE", () =>
    fixture(async (root) => {
      for (const item of [
        "native/computer-helper/identity.json",
        "native/computer-helper/blocklist.json",
        "icons/prod/icon.ico",
        ...COMPUTER_HELPER_BUILD_INPUTS,
      ]) {
        await mkdir(path.dirname(path.join(root, item)), { recursive: true })
        await cp(path.join(directory, item), path.join(root, item))
      }
      await mkdir(path.join(root, "native/computer-helper/windows/src"), { recursive: true })
      await writeFile(
        path.join(root, "native/computer-helper/windows/src/main.cpp"),
        "// Virtual compiler fixture; never compiled or executed.\n",
      )
      const generated = generateIdentitySources(path.join(root, "native/build/generated"), {
        identity: path.join(root, "native/computer-helper/identity.json"),
        blocklist: path.join(root, "native/computer-helper/blocklist.json"),
      }).find((file) => file.endsWith("Identity.swift"))!
      const identity = readIdentity(path.join(root, "native/computer-helper/identity.json"))
      const output = path.join(root, "out/arm64")
      await mkdir(output, { recursive: true })
      const binary = Buffer.alloc(128)
      binary.writeUInt16LE(0x5a4d)
      binary.writeUInt32LE(64, 0x3c)
      binary.writeUInt32LE(0x4550, 64)
      binary.writeUInt16LE(0xaa64, 68)
      await writeFile(path.join(output, identity.windows.executable), binary)
      const current = createManifest({
        helperVersion: identity.helperVersion,
        protocol: identity.protocol,
        platform: "win32",
        toolchain: "virtual MSVC fixture",
        sourceDigest: await sourceDigestFor(root, "win32", "prod", "virtual MSVC fixture", generated),
        files: {
          [identity.windows.executable]: { sha256: createHash("sha256").update(binary).digest("hex"), arch: ["arm64"] },
        },
      })
      await writeFile(path.join(output, "computer-helper.json"), JSON.stringify(current))
      const calls: string[] = []
      const run: NativeCommand = async (command) => {
        calls.push(command)
        return {
          code: 0,
          stdout: JSON.stringify({
            helperVersion: identity.helperVersion,
            protocol: identity.protocol,
            platform: "win32",
            arch: "arm64",
            sourceDigest: current.sourceDigest,
          }),
          stderr: "",
        }
      }
      expect(
        await verifyPrebuiltHelper(output, "win32", ["arm64"], {
          directory: root,
          host: "win32",
          hostArchitecture: "x64",
          run,
        }),
      ).toEqual(current)
      expect(calls).toEqual([])
      expect(
        await verifyPrebuiltHelper(output, "win32", ["arm64"], {
          directory: root,
          host: "win32",
          hostArchitecture: "arm64",
          run,
        }),
      ).toEqual(current)
      expect(calls).toEqual([path.join(await realpath(output), identity.windows.executable)])
      calls.length = 0
      await writeFile(path.join(output, identity.windows.executable), Buffer.from("corrupt PE fixture"))
      await expect(
        verifyPrebuiltHelper(output, "win32", ["arm64"], {
          directory: root,
          host: "win32",
          hostArchitecture: "x64",
          run,
        }),
      ).rejects.toThrow("hash check")
      expect(calls).toEqual([])
    }))
  test("cross-host Windows builds exit with usage status before any native command", async () => {
    const options = parseBuildOptions(["--platform", "win32"], { directory })
    const run: NativeCommand = async () => {
      throw new Error("Unexpected native command")
    }
    await expect(buildComputerHelper(options, { directory, host: "linux", run })).rejects.toMatchObject({
      exitCode: 2,
      message: "build the Windows helper on Windows or pass VECTOR_COMPUTER_HELPER_PREBUILT",
    })
  })

  for (const changedInput of ["source", "identity.h", "blocklist.h"]) {
    test(`Windows refuses to emit a manifest when ${changedInput} changes during compilation`, () =>
      fixture(async (root) => {
        for (const item of [
          "native/computer-helper/identity.json",
          "native/computer-helper/blocklist.json",
          "icons/prod/icon.ico",
          ...COMPUTER_HELPER_BUILD_INPUTS,
        ]) {
          await mkdir(path.dirname(path.join(root, item)), { recursive: true })
          await cp(path.join(directory, item), path.join(root, item))
        }
        const native = path.join(root, "native/computer-helper/windows")
        await mkdir(path.join(native, "src"), { recursive: true })
        await writeFile(path.join(native, "CMakeLists.txt"), "# Injected CMake fixture; no native tool runs.\n")
        const source = path.join(native, "src/main.cpp")
        await writeFile(source, "// Original source fixture.\n")
        const identity = readIdentity(path.join(root, "native/computer-helper/identity.json"))
        const run: NativeCommand = async (command, args) => {
          if (command === "cmake" && args[0] === "--version")
            return { code: 0, stdout: "cmake version 3.31.6", stderr: "" }
          if (command === "cl")
            return { code: 0, stdout: "Microsoft C/C++ Compiler Version 19.99.99999 for x64", stderr: "" }
          if (command === "cmake" && args[0] === "--build") {
            const release = path.join(args[1]!, "Release")
            await mkdir(release, { recursive: true })
            for (const file of [
              identity.windows.executable,
              WINDOWS_TEST_ARTIFACTS.unit,
              WINDOWS_TEST_ARTIFACTS.target,
              WINDOWS_TEST_ARTIFACTS.caller,
            ])
              await writeFile(path.join(release, file), "virtual compiler output")
            const changed =
              changedInput === "source"
                ? source
                : path.join(root, "native/build/computer-helper-win32/generated", changedInput)
            await writeFile(changed, "// Actual compiler input changed while the injected compiler ran.\n")
          }
          return { code: 0, stdout: "", stderr: "" }
        }
        const options = parseBuildOptions(["--platform", "win32", "--arch", "x64", "--out", "out"], { directory: root })
        await expect(
          buildComputerHelper(options, {
            directory: root,
            host: "win32",
            hostArchitecture: "x64",
            environment: windowsEnvironment,
            run,
          }),
        ).rejects.toThrow("inputs changed during compilation")
        await expect(readFile(path.join(root, "out/x64/computer-helper.json"))).rejects.toMatchObject({
          code: "ENOENT",
        })
      }))
  }

  test("Windows pins both compiler slices to the observed toolset and exact SDK and records those observations", () =>
    fixture(async (root) => {
      for (const item of [
        "native/computer-helper/identity.json",
        "native/computer-helper/blocklist.json",
        "icons/prod/icon.ico",
        ...COMPUTER_HELPER_BUILD_INPUTS,
      ]) {
        await mkdir(path.dirname(path.join(root, item)), { recursive: true })
        await cp(path.join(directory, item), path.join(root, item))
      }
      const native = path.join(root, "native/computer-helper/windows")
      await mkdir(native, { recursive: true })
      await writeFile(path.join(native, "CMakeLists.txt"), "# Injected native toolchain-selection fixture.\n")
      const identity = readIdentity(path.join(root, "native/computer-helper/identity.json"))
      const calls: string[][] = []
      const architectures = new Map<string, string>()
      const run: NativeCommand = async (command, args) => {
        calls.push([command, ...args])
        if (command === "cmake" && args[0] === "--version")
          return { code: 0, stdout: "cmake version 3.31.6", stderr: "" }
        if (command === "cl")
          return { code: 0, stdout: "Microsoft C/C++ Compiler Version 19.44.35222 for x64", stderr: "" }
        if (command === "cmake" && args[0] === "-S") {
          architectures.set(args[args.indexOf("-B") + 1]!, args[args.indexOf("-A") + 1]!.split(",")[0]!)
        }
        if (command === "cmake" && args[0] === "--build") {
          const release = path.join(args[1]!, "Release")
          await mkdir(release, { recursive: true })
          const bytes = Buffer.alloc(128)
          bytes.writeUInt16LE(0x5a4d)
          bytes.writeUInt32LE(64, 0x3c)
          bytes.writeUInt32LE(0x4550, 64)
          bytes.writeUInt16LE(architectures.get(args[1]!) === "x64" ? 0x8664 : 0xaa64, 68)
          bytes.writeUInt16LE(0x20b, 88)
          for (const file of [
            identity.windows.executable,
            WINDOWS_TEST_ARTIFACTS.unit,
            WINDOWS_TEST_ARTIFACTS.target,
            WINDOWS_TEST_ARTIFACTS.caller,
          ])
            await writeFile(path.join(release, file), bytes)
        }
        if (command.endsWith(identity.windows.executable)) {
          const current = JSON.parse(
            await readFile(path.join(path.dirname(command), "computer-helper.json"), "utf8"),
          ) as HelperManifest
          return {
            code: 0,
            stdout: JSON.stringify({
              helperVersion: current.helperVersion,
              protocol: current.protocol,
              platform: "win32",
              arch: "x64",
              sourceDigest: current.sourceDigest,
            }),
            stderr: "",
          }
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const options = parseBuildOptions(["--platform", "win32", "--arch", "x64,arm64", "--out", "out"], {
        directory: root,
      })
      const outputs = await buildComputerHelper(options, {
        directory: root,
        host: "win32",
        hostArchitecture: "x64",
        environment: windowsEnvironment,
        run,
      })
      expect(outputs).toHaveLength(2)
      expect(outputs[0]!.sourceDigest).toBe(outputs[1]!.sourceDigest)
      expect(outputs[0]!.toolchain).toBe(
        "cmake version 3.31.6\nmsvc:19.44.35222\nvc-tools:14.44.35207\nwindows-sdk:10.0.26100.0",
      )
      const configure = calls.filter((call) => call[0] === "cmake" && call[1] === "-S")
      expect(configure.map((call) => call[call.indexOf("-A") + 1])).toEqual([
        "x64,version=10.0.26100.0",
        "ARM64,version=10.0.26100.0",
      ])
      expect(configure.every((call) => call[call.indexOf("-T") + 1] === "version=14.44.35207")).toBe(true)
      expect(configure.every((call) => call.includes("--fresh"))).toBe(true)
      expect(calls.filter((call) => call[0]!.endsWith(identity.windows.executable))).toHaveLength(1)
      const tests = path.join(root, "out/x64/tests")
      const checked = await verifyWindowsTestArtifacts(tests, "x64", { directory: root, helperManifest: outputs[0]! })
      expect(checked.files[WINDOWS_TEST_ARTIFACTS.caller]?.arch).toEqual(["x64"])
      expect(Object.keys(outputs[0]!.files)).toEqual([identity.windows.executable])
      const manifestFile = path.join(tests, WINDOWS_TEST_ARTIFACTS.manifest)
      const originalManifest = await readFile(manifestFile, "utf8")
      const callerFile = path.join(tests, WINDOWS_TEST_ARTIFACTS.caller)
      const originalCaller = await readFile(callerFile)
      for (const mutation of ["bytes", "architecture", "format"] as const) {
        const changed = Buffer.from(originalCaller)
        if (mutation === "bytes") changed[100] = 1
        if (mutation === "architecture") changed.writeUInt16LE(0xaa64, 68)
        if (mutation === "format") changed.writeUInt16LE(0, 0)
        await writeFile(callerFile, changed)
        if (mutation !== "bytes") {
          const updated = JSON.parse(originalManifest) as HelperManifest
          updated.files[WINDOWS_TEST_ARTIFACTS.caller]!.sha256 = createHash("sha256").update(changed).digest("hex")
          await writeFile(manifestFile, JSON.stringify(updated))
        }
        await expect(
          verifyWindowsTestArtifacts(tests, "x64", { directory: root, helperManifest: outputs[0]! }),
        ).rejects.toThrow("hash, PE or architecture")
        await writeFile(callerFile, originalCaller)
        await writeFile(manifestFile, originalManifest)
      }
      await writeFile(path.join(tests, "unexpected.dll"), "Unclassified test artifact")
      await expect(
        verifyWindowsTestArtifacts(tests, "x64", { directory: root, helperManifest: outputs[0]! }),
      ).rejects.toThrow("outside its manifest")
      await rm(path.join(tests, "unexpected.dll"))
      await expect(
        verifyWindowsTestArtifacts(tests, "x64", {
          directory: root,
          helperManifest: { ...outputs[0]!, sourceDigest: "0".repeat(64) },
        }),
      ).rejects.toThrow("does not match the helper")
      await writeFile(path.join(native, "changed-source.cpp"), "// Source changed after the measured fixture build.\n")
      await expect(
        verifyWindowsTestArtifacts(tests, "x64", { directory: root, helperManifest: outputs[0]! }),
      ).rejects.toThrow("source digest")
      await rm(path.join(native, "changed-source.cpp"))
      calls.length = 0
      await expect(
        buildComputerHelper(options, { directory: root, host: "win32", environment: {}, run }),
      ).rejects.toMatchObject({ exitCode: 2 })
      expect(calls).toEqual([])
      const olderCMake: NativeCommand = async (command, args, settings) => {
        if (command === "cmake" && args[0] === "--version")
          return { code: 0, stdout: "cmake version 3.26.6", stderr: "" }
        return run(command, args, settings)
      }
      await expect(
        buildComputerHelper(options, {
          directory: root,
          host: "win32",
          environment: windowsEnvironment,
          run: olderCMake,
        }),
      ).rejects.toThrow("CMake 3.27 or newer")
    }))

  test("a serial injected universal build hashes final signed shipping bytes and emits a failing lock candidate", () =>
    fixture(async (root) => {
      for (const item of ["native/computer-helper", "icons/prod", ...COMPUTER_HELPER_BUILD_INPUTS]) {
        await mkdir(path.dirname(path.join(root, item)), { recursive: true })
        await cp(path.join(directory, item), path.join(root, item), { recursive: true })
      }
      const calls: string[][] = []
      let active = false
      const run: NativeCommand = async (command, args, options) => {
        expect(active).toBe(false)
        active = true
        try {
          calls.push([command, ...args])
          expect(options.env.ZERO_AR_DATE).toBe("1")
          if (command === "xcodebuild") return { code: 0, stdout: "Xcode fixture\nBuild fixture", stderr: "" }
          if (args.includes("--version")) {
            if (command === "xcrun") return { code: 0, stdout: "Apple Swift fixture", stderr: "" }
            const current = JSON.parse(
              await readFile(path.join(root, "out/computer-helper.json"), "utf8"),
            ) as HelperManifest
            return {
              code: 0,
              stdout: JSON.stringify({
                helperVersion: current.helperVersion,
                protocol: current.protocol,
                platform: "darwin",
                arch: "x64",
                sourceDigest: current.sourceDigest,
              }),
              stderr: "",
            }
          }
          if (args.includes("--show-sdk-version")) return { code: 0, stdout: "fixture-sdk", stderr: "" }
          if (args.includes("--show-sdk-path")) return { code: 0, stdout: "/fixture-sdk", stderr: "" }
          if (command === "xcrun" && args.includes("swiftc")) {
            const output = args[args.indexOf("-o") + 1]!
            const binary = Buffer.alloc(32)
            binary.writeUInt32LE(0xfeedfacf)
            binary.writeUInt32LE(args.some((arg) => arg === "arm64-apple-macos14.0") ? 0x100000c : 0x1000007, 4)
            await writeFile(output, binary)
          }
          if (args[0] === "lipo") {
            const binary = Buffer.alloc(48)
            binary.writeUInt32BE(0xcafebabe)
            binary.writeUInt32BE(2, 4)
            binary.writeUInt32BE(0x1000007, 8)
            binary.writeUInt32BE(0x100000c, 28)
            await writeFile(args[args.indexOf("-output") + 1]!, binary)
          }
          if (command.endsWith("codesign") && args.includes("--force")) {
            const bundle = args.at(-1)!
            await mkdir(path.join(bundle, "Contents/_CodeSignature"), { recursive: true })
            await writeFile(path.join(bundle, "Contents/_CodeSignature/CodeResources"), "signed fixture resources")
            const file = path.join(
              bundle,
              "Contents/MacOS",
              path.basename(bundle) === MAC_TEST_TARGET.bundle ? MAC_TEST_TARGET.executable : "VectorComputer",
            )
            await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("signed fixture bytes")]))
          }
          if (command.endsWith("codesign") && args.includes("--display"))
            return args.includes("--entitlements")
              ? { code: 0, stdout: '<plist version="1.0"><dict/></plist>', stderr: "" }
              : {
                  code: 0,
                  stdout: "",
                  stderr: `Identifier=${MAC_TEST_TARGET.bundleId}\nSignature=adhoc\nCodeDirectory flags=0x10000(runtime)\n`,
                }
          return { code: 0, stdout: "", stderr: args.includes("-dvvv") ? `CDHash=${codeHash}\n` : "" }
        } finally {
          active = false
        }
      }
      const options = parseBuildOptions(["--platform", "darwin", "--out", "out", "--check-lock"], { directory: root })
      const lockFile = path.join(root, "native/computer-helper/macos/identity.lock.json")
      await writeFile(
        lockFile,
        JSON.stringify({ enforce: true, helperVersion: "1.0.0", sourceDigest: null, toolchain: null, cdhash: {} }),
      )
      const before = await readFile(lockFile, "utf8")
      await expect(
        buildComputerHelper(options, { directory: root, host: "darwin", environment: {}, run }),
      ).rejects.toThrow("no measured native baseline")
      expect(await readFile(lockFile, "utf8")).toBe(before)
      const result = JSON.parse(await readFile(path.join(root, "out/computer-helper.json"), "utf8")) as HelperManifest
      const shipping = await readFile(path.join(root, "out/VectorComputer.app/Contents/MacOS/VectorComputer"))
      expect(result.files["VectorComputer.app/Contents/MacOS/VectorComputer"]!.sha256).toBe(
        createHash("sha256").update(shipping).digest("hex"),
      )
      expect(Object.keys(result.files).some((file) => file.startsWith("tests/"))).toBe(false)
      expect(result.files["VectorComputer.app/Contents/_CodeSignature/CodeResources"]).toBeDefined()
      const computed = JSON.parse(
        await readFile(path.join(root, "out/identity.lock.computed.json"), "utf8"),
      ) as IdentityLock
      expect(computed.cdhash).toEqual({ x64: codeHash, arm64: codeHash })
      const compilations = calls.filter((call) => call.includes("swiftc") && call.includes("-o"))
      expect(compilations).toHaveLength(8)
      const unit = compilations.find((call) => call.at(-1)?.endsWith("unit"))!
      expect(unit.filter((file) => path.basename(file) === "main.swift")).toEqual([
        path.join(root, "native/computer-helper/macos/Tests/main.swift"),
      ])
      const caller = compilations.find((call) => call.at(-1)?.endsWith("caller"))!
      expect(caller).toContain(path.join(root, "native/computer-helper/macos/TestSupport/Caller/main.swift"))
      expect(caller).not.toContain("-parse-as-library")
      const targetBuilds = compilations.filter((call) => call.at(-1)?.endsWith("test-target"))
      expect(targetBuilds).toHaveLength(2)
      for (const call of targetBuilds) {
        const sources = call.filter((file) => file.endsWith(".swift"))
        expect(sources).toContain(path.join(root, "native/computer-helper/macos/TestTarget/main.swift"))
        expect(
          sources.every((file) =>
            file.startsWith(path.join(root, "native/computer-helper/macos/TestTarget") + path.sep),
          ),
        ).toBe(true)
        expect(call[call.indexOf("-module-name") + 1]).toBe(MAC_TEST_TARGET.executable)
      }
      expect(
        calls.filter((call) => call[0]!.endsWith("codesign") && call.includes("--force")).map((call) => call.at(-1)),
      ).toEqual([path.join(root, "out/VectorComputer.app"), path.join(root, "out/tests", MAC_TEST_TARGET.bundle)])
      const targetSign = calls.find(
        (call) =>
          call[0]!.endsWith("codesign") && call.includes("--force") && call.at(-1)?.endsWith(MAC_TEST_TARGET.bundle),
      )!
      expect(targetSign).toContain("runtime")
      expect(targetSign).toContain("--timestamp=none")
      expect(targetSign[targetSign.indexOf("--identifier") + 1]).toBe(MAC_TEST_TARGET.bundleId)
      expect(targetSign[targetSign.indexOf("--entitlements") + 1]).toBe(
        path.join(root, "native/computer-helper/macos/entitlements.plist"),
      )
      const tests = path.join(root, "out/tests")
      const testManifestFile = path.join(tests, MAC_TEST_TARGET.manifest)
      const testManifest = JSON.parse(await readFile(testManifestFile, "utf8")) as HelperManifest
      expect(testManifest.sourceDigest).toBe(result.sourceDigest)
      expect(testManifest.helperVersion).toBe(result.helperVersion)
      expect(testManifest.toolchain).toBe(result.toolchain)
      expect(Object.keys(testManifest.files).sort()).toEqual([
        "VectorComputerCaller",
        "VectorComputerTestTarget.app/Contents/Info.plist",
        "VectorComputerTestTarget.app/Contents/MacOS/VectorComputerTestTarget",
        "VectorComputerTestTarget.app/Contents/_CodeSignature/CodeResources",
        "VectorComputerTests",
      ])
      const testExecutable = path.join(tests, MAC_TEST_TARGET.bundle, "Contents/MacOS", MAC_TEST_TARGET.executable)
      const testBytes = await readFile(testExecutable)
      expect(testManifest.files[`${MAC_TEST_TARGET.bundle}/Contents/MacOS/${MAC_TEST_TARGET.executable}`]!.sha256).toBe(
        createHash("sha256").update(testBytes).digest("hex"),
      )
      expect(
        await verifyMacTestArtifacts(tests, ["x64", "arm64"], {
          directory: root,
          host: "linux",
          helperManifest: result,
        }),
      ).toEqual(testManifest)
      await expect(
        verifyMacTestArtifacts(tests, ["x64"], {
          directory: root,
          host: "linux",
          helperManifest: { ...result, sourceDigest: "0".repeat(64) },
        }),
      ).rejects.toThrow("manifest does not match")
      await writeFile(testExecutable, "changed target bytes")
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow("hash")
      await writeFile(testExecutable, testBytes)
      const armOnlyTarget = Buffer.alloc(32)
      armOnlyTarget.writeUInt32LE(0xfeedfacf)
      armOnlyTarget.writeUInt32LE(0x100000c, 4)
      await writeFile(testExecutable, armOnlyTarget)
      const wrongArchitecture = structuredClone(testManifest)
      wrongArchitecture.files[`${MAC_TEST_TARGET.bundle}/Contents/MacOS/${MAC_TEST_TARGET.executable}`]!.sha256 =
        createHash("sha256").update(armOnlyTarget).digest("hex")
      await writeFile(testManifestFile, JSON.stringify(wrongArchitecture))
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow(
        "wrong architecture",
      )
      await writeFile(testExecutable, testBytes)
      await writeFile(testManifestFile, JSON.stringify(testManifest))
      const pe = Buffer.alloc(128)
      pe.writeUInt16LE(0x5a4d)
      pe.writeUInt32LE(64, 0x3c)
      pe.writeUInt32LE(0x4550, 64)
      pe.writeUInt16LE(0x8664, 68)
      const wrongFormat = structuredClone(testManifest)
      const originals = new Map<string, Buffer>()
      for (const metadata of Object.values(wrongFormat.files)) metadata.arch = ["x64"]
      for (const relative of [
        "VectorComputerTests",
        "VectorComputerCaller",
        `${MAC_TEST_TARGET.bundle}/Contents/MacOS/${MAC_TEST_TARGET.executable}`,
      ]) {
        const file = path.join(tests, relative)
        originals.set(file, await readFile(file))
        await writeFile(file, pe)
        wrongFormat.files[relative]!.sha256 = createHash("sha256").update(pe).digest("hex")
      }
      await writeFile(testManifestFile, JSON.stringify(wrongFormat))
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow("Mach-O")
      for (const [file, bytes] of originals) await writeFile(file, bytes)
      await writeFile(testManifestFile, JSON.stringify(testManifest))
      const missingCaller = structuredClone(testManifest)
      delete missingCaller.files.VectorComputerCaller
      await writeFile(testManifestFile, JSON.stringify(missingCaller))
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow(
        "expected layout",
      )
      await writeFile(testManifestFile, JSON.stringify(testManifest))
      const infoFile = path.join(tests, MAC_TEST_TARGET.bundle, "Contents/Info.plist")
      const infoBytes = await readFile(infoFile)
      const changedInfo = Buffer.from(infoBytes.toString().replace(MAC_TEST_TARGET.bundleId, "com.example.Other"))
      await writeFile(infoFile, changedInfo)
      const changedManifest = structuredClone(testManifest)
      changedManifest.files[`${MAC_TEST_TARGET.bundle}/Contents/Info.plist`]!.sha256 = createHash("sha256")
        .update(changedInfo)
        .digest("hex")
      await writeFile(testManifestFile, JSON.stringify(changedManifest))
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow(
        "metadata",
      )
      await writeFile(infoFile, infoBytes)
      await writeFile(testManifestFile, JSON.stringify(testManifest))
      await writeFile(path.join(tests, "unexpected"), "unmanifested artifact")
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow(
        "outside its manifest",
      )
      await rm(path.join(tests, "unexpected"))
      const targetSource = path.join(root, "native/computer-helper/macos/TestTarget/main.swift")
      const sourceBytes = await readFile(targetSource)
      await writeFile(targetSource, Buffer.concat([sourceBytes, Buffer.from("\n// changed source\n")]))
      await expect(verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "linux" })).rejects.toThrow(
        "source digest",
      )
      await writeFile(targetSource, sourceBytes)
      const signatureCalls: string[][] = []
      const signature: NativeCommand = async (command, args) => {
        expect(command).toBe("/usr/bin/codesign")
        signatureCalls.push([...args])
        if (args.includes("--verify")) return { code: 0, stdout: "", stderr: "" }
        if (args.includes("--entitlements"))
          return { code: 0, stdout: '<plist version="1.0"><dict/></plist>', stderr: "" }
        return {
          code: 0,
          stdout: "",
          stderr: `Identifier=${MAC_TEST_TARGET.bundleId}\nSignature=adhoc\nCodeDirectory flags=0x10000(runtime)\n`,
        }
      }
      await verifyMacTestArtifacts(tests, ["x64", "arm64"], { directory: root, host: "darwin", run: signature })
      expect(signatureCalls).toHaveLength(5)
      expect(signatureCalls[0]).toContain("--all-architectures")
      expect(
        signatureCalls.filter((args) => args.includes("--arch")).map((args) => args[args.indexOf("--arch") + 1]),
      ).toEqual(["x86_64", "x86_64", "arm64", "arm64"])
      for (const invalid of ["identifier", "runtime", "adhoc", "entitlements", "signature"]) {
        const reject: NativeCommand = async (command, args, settings) => {
          const normal = await signature(command, args, settings)
          if (invalid === "signature" && args.includes("--verify")) return { ...normal, code: 1 }
          if (invalid === "entitlements" && args.includes("--entitlements"))
            return {
              ...normal,
              stdout: "<plist><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>",
            }
          return ["identifier", "runtime", "adhoc"].includes(invalid) &&
            args.includes("--display") &&
            !args.includes("--entitlements")
            ? {
                ...normal,
                stderr: normal.stderr.replace(
                  invalid === "identifier"
                    ? MAC_TEST_TARGET.bundleId
                    : invalid === "runtime"
                      ? "runtime"
                      : "Signature=adhoc",
                  invalid === "identifier"
                    ? "com.example.Other"
                    : invalid === "runtime"
                      ? "none"
                      : "Signature=Developer ID",
                ),
              }
            : normal
        }
        await expect(
          verifyMacTestArtifacts(tests, ["x64"], { directory: root, host: "darwin", run: reject }),
        ).rejects.toThrow(
          invalid === "signature"
            ? "signature is invalid"
            : invalid === "entitlements"
              ? "empty dictionary"
              : "hardened ad-hoc",
        )
      }
      expect(
        await verifyPrebuiltHelper(path.join(root, "out"), "darwin", ["x64", "arm64"], {
          directory: root,
          host: "linux",
        }),
      ).toEqual(result)
      const executable = path.join(root, "out/VectorComputer.app/Contents/MacOS/VectorComputer")
      await writeFile(executable, "corrupt fixture")
      await expect(
        verifyPrebuiltHelper(path.join(root, "out"), "darwin", ["x64"], { directory: root, host: "linux" }),
      ).rejects.toThrow("hash check")
      const armOnly = Buffer.alloc(32)
      armOnly.writeUInt32LE(0xfeedfacf)
      armOnly.writeUInt32LE(0x100000c, 4)
      await writeFile(executable, armOnly)
      result.files["VectorComputer.app/Contents/MacOS/VectorComputer"]!.sha256 = createHash("sha256")
        .update(armOnly)
        .digest("hex")
      await writeFile(path.join(root, "out/computer-helper.json"), JSON.stringify(result))
      await expect(
        verifyPrebuiltHelper(path.join(root, "out"), "darwin", ["x64"], { directory: root, host: "linux" }),
      ).rejects.toThrow("wrong architecture")
      result.files["VectorComputer.app/Contents/MacOS/VectorComputer"]!.arch = ["arm64"]
      await writeFile(path.join(root, "out/computer-helper.json"), JSON.stringify(result))
      const nativeChecks: string[] = []
      const signatureOnly: NativeCommand = async (command, args) => {
        nativeChecks.push(command)
        expect(args).toContain("--verify")
        return { code: 0, stdout: "", stderr: "" }
      }
      expect(
        await verifyPrebuiltHelper(path.join(root, "out"), "darwin", ["arm64"], {
          directory: root,
          host: "darwin",
          hostArchitecture: "x64",
          run: signatureOnly,
        }),
      ).toEqual(result)
      expect(nativeChecks).toEqual(["/usr/bin/codesign"])
    }))
})
