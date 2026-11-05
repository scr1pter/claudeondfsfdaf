import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Hands } from "@vectordevai/schema/hands"
import { WINDOWS_NATIVE_CHECKS } from "./computer-helper-selftest-windows"
import { encodeComputerHelperPins } from "../src/shared/computer-helper-pins"
import {
  checkWindowsHelperAuthenticode,
  checkWindowsHelperExecutionManifest,
  checkWindowsHelperFinalBytes,
  checkWindowsHelperFinalVersion,
  extractWindowsHelperCompiledPins,
  inspectWindowsHelperPe,
  parseWindowsHelperAuthenticode,
  verifyComputerHelperWindows,
} from "./verify-computer-helper-windows"
import type { HelperArchitecture, HelperManifest, NativeCommand } from "./build-computer-helper"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const executionManifest = `<?xml version="1.0" encoding="UTF-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
</assembly>`
type FixtureImage = {
  newHeader: { fileHeader: { machine: number; characteristics: number }; optionalHeader: { subsystem: number } }
  generate(): ArrayBuffer
}
type FixtureResource = {
  entries: { type: number; id: number; lang: number; codepage: number; bin: ArrayBuffer }[]
  outputResource(image: FixtureImage): void
}

function pe(architecture: HelperArchitecture = "x64", xml = executionManifest, extraManifest?: string) {
  const require = createRequire(import.meta.url)
  const builder = createRequire(require.resolve("electron-builder/package.json"))
  const library = createRequire(builder.resolve("app-builder-lib/package.json"))
  const reader: {
    NtExecutable: { createEmpty(is32bit: boolean, isDLL: boolean): FixtureImage }
    NtExecutableResource: { from(image: FixtureImage): FixtureResource }
  } = require(library.resolve("resedit"))
  const image = reader.NtExecutable.createEmpty(false, false)
  image.newHeader.fileHeader.machine = architecture === "x64" ? 0x8664 : 0xaa64
  image.newHeader.fileHeader.characteristics |= 0x2
  image.newHeader.optionalHeader.subsystem = 2
  const resources = reader.NtExecutableResource.from(image)
  const buffer = (text: string) => Uint8Array.from(Buffer.from(text)).buffer
  resources.entries = [
    { type: 24, id: 1, lang: 1033, codepage: 65001, bin: buffer(xml) },
    ...(extraManifest ? [{ type: 24, id: 1, lang: 1031, codepage: 65001, bin: buffer(extraManifest) }] : []),
  ]
  resources.outputResource(image)
  return Buffer.from(image.generate())
}
const helperManifest = (bytes: Uint8Array, architecture: HelperArchitecture = "x64"): HelperManifest => ({
  helperVersion: "1.0.10",
  protocol: { min: 1, max: 1 },
  platform: "win32",
  sourceDigest: "a".repeat(64),
  toolchain: "measured-msvc-toolchain",
  files: { "vector-computer.exe": { sha256: digest(bytes), arch: [architecture] } },
})

describe("Windows helper final PE and execution posture", () => {
  test("reads both real PE resource layouts without loading or executing a native image", async () => {
    for (const architecture of ["x64", "arm64"] as const)
      expect(await inspectWindowsHelperPe(pe(architecture), architecture)).toEqual({
        architecture,
        manifestLanguages: [1033],
      })
  })

  test("refuses wrong machine, non-executable images and the wrong subsystem", async () => {
    await expect(inspectWindowsHelperPe(pe("arm64"), "x64")).rejects.toThrow("machine")
    for (const mutate of [
      (bytes: Buffer, offset: number) => bytes.writeUInt16LE(0x2002, offset + 22),
      (bytes: Buffer, offset: number) => bytes.writeUInt16LE(0, offset + 22),
      (bytes: Buffer, offset: number) => bytes.writeUInt16LE(3, offset + 24 + 68),
      (bytes: Buffer, offset: number) => bytes.writeUInt16LE(0x10b, offset + 24),
    ]) {
      const bytes = pe()
      mutate(bytes, bytes.readUInt32LE(0x3c))
      await expect(inspectWindowsHelperPe(bytes, "x64")).rejects.toThrow()
    }
    await expect(inspectWindowsHelperPe(Buffer.from("not a PE"), "x64")).rejects.toThrow("PE")
  })

  test("checks every language manifest instead of selecting the first safe one", async () => {
    expect(
      (
        await inspectWindowsHelperPe(pe("x64", executionManifest, executionManifest), "x64")
      ).manifestLanguages.toSorted(),
    ).toEqual([1031, 1033])
    await expect(
      inspectWindowsHelperPe(
        pe("x64", executionManifest, executionManifest.replace('uiAccess="false"', 'uiAccess="true"')),
        "x64",
      ),
    ).rejects.toThrow("uiAccess")
  })

  test("asInvoker and explicit uiAccess false are mandatory before the first native launch", async () => {
    await expect(checkWindowsHelperExecutionManifest(Buffer.from(executionManifest))).resolves.toBeUndefined()
    for (const xml of [
      executionManifest.replace("asInvoker", "requireAdministrator"),
      executionManifest.replace("asInvoker", "highestAvailable"),
      executionManifest.replace(' uiAccess="false"', ""),
      executionManifest.replace('uiAccess="false"', 'uiAccess="true"'),
    ])
      await expect(checkWindowsHelperExecutionManifest(Buffer.from(xml))).rejects.toThrow()
  })

  test("rejects lookalike namespaces, misplaced policy, duplicates and malformed or external XML", async () => {
    for (const xml of [
      executionManifest.replace("asm.v3", "asm.v2"),
      executionManifest.replace("requestedPrivileges", "unrelated").replace("/requestedPrivileges", "/unrelated"),
      executionManifest.replace(
        "<requestedExecutionLevel",
        '<requestedExecutionLevel level="asInvoker" uiAccess="false"/><requestedExecutionLevel',
      ),
      executionManifest.replace("</assembly>", ""),
      executionManifest.replace("<assembly", '<!DOCTYPE assembly SYSTEM "file:///private"><assembly'),
      executionManifest.replace('level="asInvoker"', 'level="asInvoker" level="requireAdministrator"'),
    ])
      await expect(checkWindowsHelperExecutionManifest(Buffer.from(xml))).rejects.toThrow()
  })
})

describe("Windows helper signing and final byte pin", () => {
  test("requires coherent actual Authenticode status rather than a friendly publisher string", () => {
    expect(parseWindowsHelperAuthenticode({ status: "NotSigned", publisher: null, thumbprint: null })).toEqual({
      status: "NotSigned",
      publisher: null,
      thumbprint: null,
    })
    expect(
      parseWindowsHelperAuthenticode({ status: "Valid", publisher: "Vector Publisher", thumbprint: "A".repeat(40) })
        .thumbprint,
    ).toBe("a".repeat(40))
    for (const status of ["HashMismatch", "NotTrusted", "UnknownError", "NotSupported", "FileNotFound"])
      expect(() =>
        parseWindowsHelperAuthenticode({ status, publisher: "Vector Publisher", thumbprint: "a".repeat(40) }),
      ).toThrow()
    for (const value of [
      { status: "Valid", publisher: null, thumbprint: null },
      { status: "NotSigned", publisher: "Vector Publisher", thumbprint: "a".repeat(40) },
      { status: "Valid", publisher: "Vector Publisher", thumbprint: "bad" },
      { status: "Valid", publisher: "Vector Publisher", thumbprint: "a".repeat(40), extra: true },
    ])
      expect(() => parseWindowsHelperAuthenticode(value)).toThrow()
  })

  test("unsigned mode and configured signed mode are mutually exclusive", () => {
    const unsigned = parseWindowsHelperAuthenticode({ status: "NotSigned", publisher: null, thumbprint: null })
    const signed = parseWindowsHelperAuthenticode({
      status: "Valid",
      publisher: "Vector Publisher",
      thumbprint: "a".repeat(40),
    })
    expect(() => checkWindowsHelperAuthenticode(unsigned, "unsigned")).not.toThrow()
    expect(() => checkWindowsHelperAuthenticode(signed, "authenticode", "Vector Publisher")).not.toThrow()
    expect(() => checkWindowsHelperAuthenticode(signed, "unsigned")).toThrow()
    expect(() => checkWindowsHelperAuthenticode(unsigned, "authenticode", "Vector Publisher")).toThrow()
    for (const publisher of [undefined, "Publisher", "Vector Publisher extra", "Vector Publisher\n"])
      expect(() => checkWindowsHelperAuthenticode(signed, "authenticode", publisher)).toThrow()
  })

  test("the actual post-sign executable, final manifest and compiled pin must all agree", () => {
    const bytes = pe()
    const manifest = helperManifest(bytes)
    expect(() =>
      checkWindowsHelperFinalBytes({ bytes, manifest, architecture: "x64", compiledHashes: { x64: digest(bytes) } }),
    ).not.toThrow()
    for (const compiledHashes of [{}, { arm64: digest(bytes) }, { x64: "b".repeat(64) }])
      expect(() => checkWindowsHelperFinalBytes({ bytes, manifest, architecture: "x64", compiledHashes })).toThrow(
        "compiled Main",
      )
    expect(() =>
      checkWindowsHelperFinalBytes({
        bytes: Buffer.concat([bytes, Buffer.from("second signature")]),
        manifest,
        architecture: "x64",
        compiledHashes: { x64: digest(bytes) },
      }),
    ).toThrow("compiled Main")
    expect(() =>
      checkWindowsHelperFinalBytes({
        bytes,
        manifest,
        architecture: "arm64",
        compiledHashes: { arm64: digest(bytes) },
      }),
    ).toThrow()
    expect(() =>
      checkWindowsHelperFinalBytes({
        bytes,
        manifest: {
          ...manifest,
          files: { ...manifest.files, "vector-computer-tests.exe": manifest.files["vector-computer.exe"]! },
        },
        architecture: "x64",
        compiledHashes: { x64: digest(bytes) },
      }),
    ).toThrow()
  })

  test("version output binds architecture, version, protocol and channel source digest", () => {
    const manifest = helperManifest(pe())
    const value = {
      arch: "x64",
      helperVersion: manifest.helperVersion,
      protocol: manifest.protocol,
      platform: "win32",
      sourceDigest: manifest.sourceDigest,
    }
    expect(() => checkWindowsHelperFinalVersion(value, manifest, "x64")).not.toThrow()
    for (const changed of [
      { ...value, arch: "arm64" },
      { ...value, helperVersion: "1.0.9" },
      { ...value, platform: "darwin" },
      { ...value, sourceDigest: "f".repeat(64) },
      { ...value, protocol: { min: 1, max: 2 } },
      { ...value, extra: true },
    ])
      expect(() => checkWindowsHelperFinalVersion(changed, manifest, "x64")).toThrow("version")
  })
})

async function fixture(
  signature = { status: "NotSigned", publisher: null as string | null, thumbprint: null as string | null },
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-helper-win-final-"))
  const app = path.join(directory, "unpacked Windows app")
  const helper = path.join(app, "resources/computer/vector-computer.exe")
  const bytes = pe()
  const manifest = helperManifest(bytes)
  await mkdir(path.dirname(helper), { recursive: true })
  await writeFile(helper, bytes)
  await writeFile(path.join(path.dirname(helper), "computer-helper.json"), JSON.stringify(manifest))
  const source = path.join(directory, "asar-source")
  await mkdir(path.join(source, "out/main"), { recursive: true })
  await writeFile(path.join(source, "package.json"), JSON.stringify({ main: "./out/main/index.js" }))
  await writeFile(
    path.join(source, "out/main/index.js"),
    `export const pins=${JSON.stringify(encodeComputerHelperPins({ x64: digest(bytes) }))};`,
  )
  const require = createRequire(import.meta.url)
  const builder = createRequire(require.resolve("electron-builder/package.json"))
  const library = createRequire(builder.resolve("app-builder-lib/package.json"))
  const asar: { createPackage(source: string, destination: string): Promise<unknown> } = require(
    library.resolve("@electron/asar"),
  )
  await asar.createPackage(source, path.join(app, "resources/app.asar"))
  await mkdir(path.join(directory, "native/computer-helper"), { recursive: true })
  await writeFile(
    path.join(directory, "native/computer-helper/identity.json"),
    JSON.stringify({
      displayName: Hands.NAME,
      helperVersion: manifest.helperVersion,
      protocol: manifest.protocol,
      bundleIdSuffix: "computer",
      mac: { bundle: "VectorComputer.app", executable: "VectorComputer", minimumSystemVersion: "14.0" },
      windows: { executable: "vector-computer.exe", minimumBuild: 19041 },
    }),
  )
  const calls: { command: string; args: readonly string[]; environment: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const run: NativeCommand = async (command, args, settings) => {
    calls.push({ command, args, environment: settings.env, timeoutMs: settings.timeoutMs })
    if (command.toLowerCase().endsWith("powershell.exe"))
      return { code: 0, stdout: JSON.stringify(signature), stderr: "" }
    if (command !== helper) throw new Error("Unexpected executable")
    if (args[0] === "--version")
      return {
        code: 0,
        stdout: JSON.stringify({
          arch: "x64",
          helperVersion: manifest.helperVersion,
          protocol: manifest.protocol,
          platform: "win32",
          sourceDigest: manifest.sourceDigest,
        }),
        stderr: "",
      }
    if (args[0] === "--self-test=packaged")
      return {
        code: 0,
        stdout: JSON.stringify({ checks: WINDOWS_NATIVE_CHECKS.packaged.map((name) => ({ name, ok: true })) }),
        stderr: "",
      }
    throw new Error("Unexpected operation")
  }
  const input = {
    app,
    architecture: "x64" as const,
    channel: "prod" as const,
    expectSigning: "unsigned" as const,
    compiledHashes: { x64: digest(bytes) },
  }
  return {
    directory,
    app,
    helper,
    bytes,
    manifest,
    calls,
    run,
    input,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

describe("Windows final-location executable admission", () => {
  test("the hash map comes from the actual packed Main JavaScript", async () => {
    const value = await fixture()
    try {
      expect(await extractWindowsHelperCompiledPins(value.app)).toEqual({ x64: digest(value.bytes) })
      await writeFile(path.join(value.app, "resources/computer/pins.json"), JSON.stringify({ x64: "f".repeat(64) }))
      expect(await extractWindowsHelperCompiledPins(value.app)).toEqual({ x64: digest(value.bytes) })
    } finally {
      await value.cleanup()
    }
  })
  test("observes signing through a fixed encoded command and private literal-path environment", async () => {
    const value = await fixture()
    try {
      expect(
        (
          await verifyComputerHelperWindows(value.input, {
            directory: value.directory,
            run: value.run,
            expectedSourceDigest: async () => value.manifest.sourceDigest,
          })
        ).signature.status,
      ).toBe("NotSigned")
      expect(value.calls.map((call) => call.args[0])).toEqual(["-NoLogo", "--version", "--self-test=packaged"])
      const observed = value.calls[0]!
      expect(observed.environment.VECTOR_VERIFY_COMPUTER_HELPER_PATH).toBe(value.helper)
      const script = Buffer.from(observed.args.at(-1)!, "base64").toString("utf16le")
      expect(script).toContain("Get-AuthenticodeSignature -LiteralPath $env:VECTOR_VERIFY_COMPUTER_HELPER_PATH")
      expect(script).toContain("$publisher = $signature.SignerCertificate.Subject")
      expect(script).not.toContain("SimpleName")
      expect(script).not.toContain(value.helper)
      expect(observed.args).not.toContain(value.helper)
      expect(value.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 10_000)).toBe(true)
    } finally {
      await value.cleanup()
    }
  })

  test("signed verification compares the complete certificate Subject before helper execution", async () => {
    const publisher = "CN=Vector Publisher, O=Vector, C=US"
    const value = await fixture({ status: "Valid", publisher, thumbprint: "a".repeat(40) })
    try {
      const dependencies = {
        directory: value.directory,
        run: value.run,
        expectedSourceDigest: async () => value.manifest.sourceDigest,
      }
      await expect(
        verifyComputerHelperWindows(
          { ...value.input, expectSigning: "authenticode", publisher: "Vector Publisher" },
          dependencies,
        ),
      ).rejects.toThrow("configured publisher")
      expect(value.calls.some((call) => call.args[0] === "--version")).toBe(false)
      expect(
        (
          await verifyComputerHelperWindows(
            { ...value.input, expectSigning: "authenticode", publisher },
            dependencies,
          )
        ).signature.publisher,
      ).toBe(publisher)
      expect(value.calls.some((call) => call.args[0] === "--self-test=packaged")).toBe(true)
    } finally {
      await value.cleanup()
    }
  })

  test("a wrong compiled pin prevents PowerShell and helper execution", async () => {
    const value = await fixture()
    try {
      await expect(
        verifyComputerHelperWindows(
          { ...value.input, compiledHashes: { x64: "f".repeat(64) } },
          { directory: value.directory, run: value.run, expectedSourceDigest: async () => value.manifest.sourceDigest },
        ),
      ).rejects.toThrow("compiled Main")
      expect(value.calls).toEqual([])
    } finally {
      await value.cleanup()
    }
  })

  test("wrong signature status cannot reach version or packaged self-tests", async () => {
    const value = await fixture()
    try {
      await expect(
        verifyComputerHelperWindows(value.input, {
          directory: value.directory,
          expectedSourceDigest: async () => value.manifest.sourceDigest,
          run: async (command, args, settings) =>
            command.toLowerCase().endsWith("powershell.exe")
              ? {
                  code: 0,
                  stdout: JSON.stringify({ status: "HashMismatch", publisher: null, thumbprint: null }),
                  stderr: "",
                }
              : value.run(command, args, settings),
        }),
      ).rejects.toThrow("Authenticode")
      expect(value.calls).toEqual([])
    } finally {
      await value.cleanup()
    }
  })

  test("wrong version and failed packaged checks fail from the final executable location", async () => {
    const value = await fixture()
    try {
      await expect(
        verifyComputerHelperWindows(value.input, {
          directory: value.directory,
          expectedSourceDigest: async () => value.manifest.sourceDigest,
          run: async (command, args, settings) =>
            args[0] === "--version"
              ? { code: 0, stdout: JSON.stringify({ helperVersion: "1.0.9" }), stderr: "" }
              : value.run(command, args, settings),
        }),
      ).rejects.toThrow("version")
      expect(value.calls.some((call) => call.args[0] === "--self-test=packaged")).toBe(false)
      await expect(
        verifyComputerHelperWindows(value.input, {
          directory: value.directory,
          expectedSourceDigest: async () => value.manifest.sourceDigest,
          run: async (command, args, settings) =>
            args[0] === "--self-test=packaged"
              ? {
                  code: 1,
                  stdout: JSON.stringify({
                    checks: WINDOWS_NATIVE_CHECKS.packaged.map((name) => ({ name, ok: false })),
                  }),
                  stderr: "",
                }
              : value.run(command, args, settings),
        }),
      ).rejects.toThrow("packaged self-test")
    } finally {
      await value.cleanup()
    }
  })

  test("shipping test artifacts and missing helpers fail before any native command", async () => {
    const value = await fixture()
    try {
      await writeFile(path.join(path.dirname(value.helper), "vector-computer-tests.exe"), "test-only")
      await expect(
        verifyComputerHelperWindows(value.input, {
          directory: value.directory,
          run: value.run,
          expectedSourceDigest: async () => value.manifest.sourceDigest,
        }),
      ).rejects.toThrow("unexpected")
      expect(value.calls).toEqual([])
    } finally {
      await value.cleanup()
    }
  })
})
