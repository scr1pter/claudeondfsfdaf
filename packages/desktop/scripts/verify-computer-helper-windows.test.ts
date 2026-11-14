import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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
  observeWindowsHelperAuthenticode,
  parseWindowsHelperAuthenticode,
  verifyComputerHelperWindows,
  windowsHelperPowerShellHost,
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

describe("Windows Authenticode observation without a console", () => {
  test("requires the fixed absolute PowerShell 7 toolchain host, without PATH or legacy fallback", () => {
    expect(windowsHelperPowerShellHost("C:\\Program Files")).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
    expect(windowsHelperPowerShellHost("D:\\Program Files")).toBe("D:\\Program Files\\PowerShell\\7\\pwsh.exe")
    for (const invalid of [
      "",
      "Program Files",
      "C:Program Files",
      "\\\\host\\Program Files",
      "C:\\tools",
      "C:\\Program Files\\..",
      "C:\\Program Files\0",
      "C:\\Program Files\n",
      "C:\\Program Files\r\n",
    ])
      expect(() => windowsHelperPowerShellHost(invalid)).toThrow("fixed PowerShell 7 installation")
  })

  test("uses the real fixed cmdlet and binary UTF-8 stdout without changing the console code page", async () => {
    const file = path.resolve(os.tmpdir(), "helper's literal [path] $é.exe")
    const publisher = "CN=Vectör 研究, O=Vector, C=US"
    const calls: { command: string; args: readonly string[]; settings: Parameters<NativeCommand>[2] }[] = []
    expect(
      await observeWindowsHelperAuthenticode(file, {
        directory: os.tmpdir(),
        run: async (command, args, settings) => {
          calls.push({ command, args, settings })
          return {
            code: 0,
            stdout: JSON.stringify({ status: "Valid", publisher, thumbprint: "A".repeat(40) }),
            stderr: "",
          }
        },
      }),
    ).toEqual({ status: "Valid", publisher, thumbprint: "a".repeat(40) })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe(windowsHelperPowerShellHost())
    expect(path.win32.isAbsolute(call.command)).toBe(true)
    expect(call.command).toMatch(/\\PowerShell\\7\\pwsh\.exe$/)
    expect(call.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    expect(call.settings.timeoutMs).toBe(5000)
    expect(call.settings.cwd).toBe(path.resolve(os.tmpdir()))
    expect(call.settings.env.VECTOR_VERIFY_COMPUTER_HELPER_PATH).toBe(file)
    const script = Buffer.from(call.args[4]!, "base64").toString("utf16le")
    expect(script).toContain("Get-AuthenticodeSignature -LiteralPath $env:VECTOR_VERIFY_COMPUTER_HELPER_PATH")
    expect(script).toContain("ConvertTo-Json -Compress")
    expect(script).toContain("[System.Text.UTF8Encoding]::new($false).GetBytes($json)")
    expect(script).toContain("[Console]::OpenStandardOutput()")
    expect(script).toContain("$output.Write($bytes, 0, $bytes.Length)")
    expect(script).toContain("$output.Flush()")
    expect(script).not.toMatch(/OutputEncoding\s*=|SetConsoleOutputCP|Set-Content|Out-File/)
    expect(script).not.toContain(file)
    expect(call.args).not.toContain(file)
  })

  test("reports only closed process and script stages when the OS observation fails", async () => {
    const file = path.resolve(os.tmpdir(), "PRIVATE literal helper.exe")
    for (const failure of [
      { code: 21, stage: "signature", reason: "process-exit" },
      { code: 22, stage: "serialize", reason: "process-exit" },
      { code: 23, stage: "stdout", reason: "process-exit" },
      { code: 1, stage: "process", reason: "process-exit" },
      { code: 1, stage: "process", reason: "timed-out", failureReason: "timed-out" as const },
      { code: 1, stage: "process", reason: "output-cap", failureReason: "output-cap" as const },
      { code: 1, stage: "process", reason: "spawn-failed", failureReason: "spawn-failed" as const },
    ]) {
      const error = await observeWindowsHelperAuthenticode(file, {
        run: async () => ({
          ...failure,
          stdout: "PRIVATE stdout",
          stderr: "PRIVATE certificate/host error",
          diagnostic: "PRIVATE runner output",
        }),
      }).then(
        () => new Error("Unexpected successful signature observation"),
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(`[reason=${failure.reason}; exit=${failure.code}; stage=${failure.stage}]`)
      expect(String(error)).not.toContain("PRIVATE")
    }
    for (const asynchronous of [false, true]) {
      const thrown = await observeWindowsHelperAuthenticode(file, {
        run: () => {
          if (asynchronous) return Promise.reject(new Error("PRIVATE runner exception"))
          throw new Error("PRIVATE runner exception")
        },
      }).then(
        () => new Error("Unexpected successful signature observation"),
        (cause: unknown) => cause,
      )
      expect(String(thrown)).toContain("[reason=runner-threw; exit=unknown; stage=process]")
      expect(String(thrown)).not.toContain("PRIVATE")
    }
  })

  test("retains bounded output, strict signature data and literal absolute-path admission", async () => {
    const file = path.resolve(os.tmpdir(), "helper.exe")
    for (const stdout of [
      "PRIVATE malformed JSON",
      "",
      JSON.stringify({ status: "NotSigned", publisher: null, thumbprint: null, extra: true }),
    ])
      await expect(
        observeWindowsHelperAuthenticode(file, {
          run: async () => ({ code: 0, stdout, stderr: "" }),
        }),
      ).rejects.toThrow("Authenticode observation is invalid")
    await expect(
      observeWindowsHelperAuthenticode(file, {
        run: async () => ({ code: 0, stdout: " ".repeat(65_537), stderr: "" }),
      }),
    ).rejects.toThrow("[reason=output-limit; exit=0; stage=process]")
    let calls = 0
    for (const invalid of ["relative.exe", file + "\0.exe"])
      await expect(
        observeWindowsHelperAuthenticode(invalid, {
          run: async () => {
            calls++
            return { code: 0, stdout: "", stderr: "" }
          },
        }),
      ).rejects.toThrow("absolute literal path")
    expect(calls).toBe(0)
  })

  test("uses only the supplied observer environment and retains the two existing deadline profiles", async () => {
    const file = path.resolve(os.tmpdir(), "actual helper.exe")
    for (const timeoutMs of [5000, 10000] as const) {
      const calls: Parameters<NativeCommand>[2][] = []
      await observeWindowsHelperAuthenticode(file, {
        environment: { PATH: "observation-only", VECTOR_VERIFY_COMPUTER_HELPER_PATH: "untrusted replacement" },
        timeoutMs,
        run: async (_command, _args, settings) => {
          calls.push(settings)
          return {
            code: 0,
            stdout: JSON.stringify({ status: "NotSigned", publisher: null, thumbprint: null }),
            stderr: "",
          }
        },
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.timeoutMs).toBe(timeoutMs)
      expect(calls[0]!.env).toEqual({ PATH: "observation-only", VECTOR_VERIFY_COMPUTER_HELPER_PATH: file })
    }
    let calls = 0
    for (const timeoutMs of [null, false, "5000", 0, -1, 4999, 5001, 9999, 10001, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        observeWindowsHelperAuthenticode(file, {
          timeoutMs: timeoutMs as 5000,
          run: async () => {
            calls++
            return { code: 0, stdout: "", stderr: "" }
          },
        }),
      ).rejects.toThrow("timeout is invalid")
    expect(calls).toBe(0)
  })
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
  // The verifier canonicalizes its app root. Windows temp paths may use an 8.3 alias, so bind fixture paths to
  // the same actual directory before asserting which exact executable the verifier admitted.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-helper-win-final-")))
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
  const powershell = windowsHelperPowerShellHost()
  const run: NativeCommand = async (command, args, settings) => {
    calls.push({ command, args, environment: settings.env, timeoutMs: settings.timeoutMs })
    if (command === powershell) return { code: 0, stdout: JSON.stringify(signature), stderr: "" }
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
    powershell,
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
  test("the release x64 verifier reads the packed Main pins through the asar reader's Windows backslash names", async () => {
    const value = await fixture()
    try {
      const require = createRequire(import.meta.url)
      const builder = createRequire(require.resolve("electron-builder/package.json"))
      const library = createRequire(builder.resolve("app-builder-lib/package.json"))
      const asar: {
        listPackage(file: string): string[]
        statFile(
          file: string,
          entry: string,
          followLinks?: boolean,
        ): { size?: number; unpacked?: boolean; link?: string }
        extractFile(file: string, entry: string): Buffer
      } = require(library.resolve("@electron/asar"))
      // The simulated naming rules below are those of the pinned reader; a bumped reader must revisit them.
      expect(
        await Bun.file(path.resolve(path.dirname(library.resolve("@electron/asar")), "../package.json")).json(),
      ).toMatchObject({ name: "@electron/asar", version: "3.4.1" })
      // On Windows the pinned reader lists path.win32 joins and splits a nested read on "\\", so a "/" name is absent
      // there (preview 42454176369, Windows desktop apps step 15). This reads the same real archive with those rules;
      // on a Windows host the real reader already names entries this way, so the case holds there unchanged.
      const host = (entry: string) => {
        if (entry.includes("/")) throw new Error(`"${entry}" was not found in this archive`)
        return entry.split("\\").join(path.sep)
      }
      const windows = (listed: (names: string[]) => string[]) => ({
        listPackage: (file: string) => listed(asar.listPackage(file).map((entry) => entry.replaceAll("/", "\\"))),
        statFile: (file: string, entry: string, followLinks?: boolean) => asar.statFile(file, host(entry), followLinks),
        extractFile: (file: string, entry: string) => asar.extractFile(file, host(entry)),
      })
      expect(
        await extractWindowsHelperCompiledPins(value.app, { asar: windows((names) => names), separator: "\\" }),
      ).toEqual({ x64: digest(value.bytes) })
      await expect(
        extractWindowsHelperCompiledPins(value.app, {
          asar: windows((names) => [...names, "\\out\\main\\index.js"]),
          separator: "\\",
        }),
      ).rejects.toThrow("missing or ambiguous")
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
      expect(observed.command).toBe(value.powershell)
      expect(path.win32.isAbsolute(observed.command)).toBe(true)
      expect(path.isAbsolute(value.helper)).toBe(true)
      expect(value.calls.slice(1).map((call) => call.command)).toEqual([value.helper, value.helper])
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
        (await verifyComputerHelperWindows({ ...value.input, expectSigning: "authenticode", publisher }, dependencies))
          .signature.publisher,
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
            command === value.powershell
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
