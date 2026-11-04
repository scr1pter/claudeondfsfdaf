import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildComputerHelper,
  checkIdentityLock,
  computeSourceDigest,
  createManifest,
  parseBuildOptions,
  parseHelperManifest,
  renderHelperPlist,
  sourceDigestFor,
  swiftArguments,
  verifyPrebuiltHelper,
} from "./build-computer-helper"
import type { HelperManifest, IdentityLock, NativeCommand } from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"

const directory = fileURLToPath(new URL("../", import.meta.url))
const hash = "a".repeat(64)
const codeHash = "b".repeat(40)
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

describe("computer helper build planning", () => {
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
        "scripts/build-computer-helper.ts",
        "scripts/computer-helper-identity.ts",
        "scripts/channel-ids.ts",
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

  test("Windows refuses to emit a manifest when native inputs change during compilation", () =>
    fixture(async (root) => {
      for (const item of [
        "native/computer-helper/identity.json",
        "native/computer-helper/blocklist.json",
        "icons/prod/icon.ico",
        "scripts/build-computer-helper.ts",
        "scripts/computer-helper-identity.ts",
        "scripts/channel-ids.ts",
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
          return { code: 0, stdout: "cmake version fixture", stderr: "" }
        if (command === "cl")
          return { code: 0, stdout: "Microsoft C/C++ Compiler Version 19.99.99999 for x64", stderr: "" }
        if (command === "cmake" && args[0] === "--build") {
          const release = path.join(args[1]!, "Release")
          await mkdir(release, { recursive: true })
          for (const file of [identity.windows.executable, "vector-computer-tests.exe", "computer-test-target.exe"])
            await writeFile(path.join(release, file), "virtual compiler output")
          await writeFile(source, "// Source changed while the injected compiler ran.\n")
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const options = parseBuildOptions(["--platform", "win32", "--arch", "x64", "--out", "out"], { directory: root })
      await expect(
        buildComputerHelper(options, { directory: root, host: "win32", hostArchitecture: "x64", environment: {}, run }),
      ).rejects.toThrow("inputs changed during compilation")
      await expect(readFile(path.join(root, "out/x64/computer-helper.json"))).rejects.toMatchObject({ code: "ENOENT" })
    }))

  test("a serial injected universal build hashes final signed shipping bytes and emits a failing lock candidate", () =>
    fixture(async (root) => {
      for (const item of [
        "native/computer-helper",
        "icons/prod",
        "scripts/build-computer-helper.ts",
        "scripts/computer-helper-identity.ts",
        "scripts/channel-ids.ts",
      ]) {
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
            const file = path.join(bundle, "Contents/MacOS/VectorComputer")
            await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("signed fixture bytes")]))
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
      expect(compilations).toHaveLength(6)
      const unit = compilations.find((call) => call.at(-1)?.endsWith("unit"))!
      expect(unit.filter((file) => file.endsWith("/main.swift"))).toEqual([
        path.join(root, "native/computer-helper/macos/Tests/main.swift"),
      ])
      const caller = compilations.find((call) => call.at(-1)?.endsWith("caller"))!
      expect(caller).toContain(path.join(root, "native/computer-helper/macos/TestSupport/Caller/main.swift"))
      expect(caller).not.toContain("-parse-as-library")
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
