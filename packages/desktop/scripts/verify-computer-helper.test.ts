import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hands } from "@vectordevai/schema/hands"
import {
  checkComputerHelperSigningProvenance,
  checkComputerHelperVersion,
  emptyComputerHelperEntitlements,
  parseComputerHelperSigningReceipt,
  parseMacCodeSignature,
  parseVerifyComputerHelperArgs,
  verifyComputerHelperMac,
} from "./verify-computer-helper"
import { MAC_NATIVE_CHECKS } from "./computer-helper-selftest"
import type { HelperManifest, NativeCommand } from "./build-computer-helper"
import type { ComputerHelperSigningReceipt } from "./computer-helper-sign"

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const executableName = "VectorComputer.app/Contents/MacOS/VectorComputer"
const cdhash = { x64: "c".repeat(40), arm64: "d".repeat(40) }
const executable = Buffer.alloc(64)
executable.writeUInt32BE(0xcafebabe, 0)
executable.writeUInt32BE(2, 4)
executable.writeUInt32BE(0x1000007, 8)
executable.writeUInt32BE(0x100000c, 28)
const manifest = (): HelperManifest => ({
  helperVersion: "1.0.10",
  protocol: { min: 1, max: 1 },
  platform: "darwin",
  sourceDigest: "a".repeat(64),
  toolchain: "measured-swift-toolchain",
  files: {
    [executableName]: { sha256: hash(executable), arch: ["x64", "arm64"] },
    "VectorComputer.app/Contents/Info.plist": { sha256: hash("helper-info"), arch: ["x64", "arm64"] },
    "VectorComputer.app/Contents/_CodeSignature/CodeResources": {
      sha256: hash("code-resources"),
      arch: ["x64", "arm64"],
    },
  },
})
const receipt = (): ComputerHelperSigningReceipt => ({
  schemaVersion: 1,
  channel: "prod",
  sourceManifest: manifest(),
  sourceCdhash: { ...cdhash },
  finalManifestSha256: hash(JSON.stringify(manifest())),
  finalExecutableSha256: hash(executable),
  signing: "adhoc",
})
const lock = () => ({
  enforce: true,
  helperVersion: "1.0.10",
  sourceDigest: "a".repeat(64),
  toolchain: "measured-swift-toolchain",
  cdhash: { ...cdhash },
})
const provenance = () => ({
  receipt: receipt(),
  manifest: manifest(),
  manifestBytes: Buffer.from(JSON.stringify(manifest())),
  executableBytes: executable,
  channel: "prod" as const,
  expectSigning: "adhoc" as const,
  expectedSourceDigest: "a".repeat(64),
  lock: lock(),
})
const signature = (id = "ai.vector.app.computer", arch: "x64" | "arm64" = "x64") => `Executable=/fixture/helper
Identifier=${id}
CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=16+3 location=embedded
CDHash=${cdhash[arch]}
Signature=adhoc
TeamIdentifier=not set
`

describe("final computer helper signature and provenance parsing", () => {
  test("parses an explicitly selected slice and rejects duplicate or incomplete facts", () => {
    expect(parseMacCodeSignature(signature())).toEqual({
      identifier: "ai.vector.app.computer",
      cdhash: cdhash.x64,
      runtime: true,
      signing: "adhoc",
      authorities: [],
    })
    for (const changed of [
      signature() + "CDHash=" + cdhash.arm64,
      signature() + "Identifier=other",
      signature().replace(/^CDHash=.+\n/m, ""),
      signature().replace(cdhash.x64, "not-a-hash"),
      signature() + "Authority=Developer ID Application: spoof",
    ])
      expect(() => parseMacCodeSignature(changed)).toThrow()
  })

  test("runtime comes from the actual numeric flag rather than an unrelated display word", () => {
    expect(parseMacCodeSignature(signature().replace("0x10000(runtime)", "0x0(runtime)")).runtime).toBe(false)
    expect(() => parseMacCodeSignature("x".repeat(65_537))).toThrow("limit")
  })

  test("empty entitlements must be an actual empty plist dictionary", () => {
    for (const value of [
      '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
      "<plist><dict>\n</dict></plist>",
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>',
    ])
      expect(emptyComputerHelperEntitlements(value)).toBe(true)
    for (const value of [
      "",
      "<dict/>",
      "<plist><array/></plist>",
      "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>",
      "<plist><dict/></plist><plist><dict/></plist>",
      "<plist><dict/></plist>unparsed trailing data",
    ])
      expect(emptyComputerHelperEntitlements(value)).toBe(false)
  })

  test("a strict receipt retains the unexpanded source manifest and rejects unknown or malformed evidence", () => {
    expect(parseComputerHelperSigningReceipt(receipt())).toEqual(receipt())
    for (const changed of [
      { ...receipt(), extra: true },
      { ...receipt(), channel: "unknown" },
      { ...receipt(), signing: "certificate" },
      { ...receipt(), finalManifestSha256: "bad" },
      { ...receipt(), sourceCdhash: { x64: cdhash.x64 } },
      { ...receipt(), sourceCdhash: { ...cdhash, ia32: cdhash.x64 } },
      { ...receipt(), sourceManifest: { ...manifest(), extra: true } },
    ])
      expect(() => parseComputerHelperSigningReceipt(changed)).toThrow()
  })

  test("matches the full measured production source identity", () => {
    expect(checkComputerHelperSigningProvenance(provenance())).toEqual([])
    for (const changed of [
      { ...lock(), helperVersion: "1.0.9" },
      { ...lock(), sourceDigest: "f".repeat(64) },
      { ...lock(), toolchain: "different" },
      { ...lock(), cdhash: { ...cdhash, arm64: "f".repeat(40) } },
    ])
      expect(() => checkComputerHelperSigningProvenance({ ...provenance(), lock: changed })).toThrow()
    expect(
      checkComputerHelperSigningProvenance({
        ...provenance(),
        lock: { ...lock(), enforce: false, cdhash: { ...cdhash, arm64: "f".repeat(40) } },
      }),
    ).toEqual(["The arm64 helper cdhash changed; review and commit the measured identity lock."])
    expect(() =>
      checkComputerHelperSigningProvenance({ ...provenance(), lock: { ...lock(), enforce: false, cdhash: {} } }),
    ).toThrow("measured")
  })

  test("receipt hashes bind final executable and exact manifest bytes", () => {
    expect(() =>
      checkComputerHelperSigningProvenance({ ...provenance(), executableBytes: Buffer.from("changed") }),
    ).toThrow("final package bytes")
    expect(() =>
      checkComputerHelperSigningProvenance({
        ...provenance(),
        manifestBytes: Buffer.from(JSON.stringify(manifest(), null, 2)),
      }),
    ).toThrow("final package bytes")
    expect(() =>
      checkComputerHelperSigningProvenance({ ...provenance(), expectedSourceDigest: "f".repeat(64) }),
    ).toThrow("source provenance")
  })

  test("signing may update signature bytes while preserving every source resource and architecture", () => {
    const final = manifest()
    final.files[executableName]!.sha256 = hash("new-signature")
    final.files["VectorComputer.app/Contents/_CodeSignature/CodeResources"]!.sha256 = hash("new-seal")
    const signedReceipt = {
      ...receipt(),
      finalManifestSha256: hash(JSON.stringify(final)),
      finalExecutableSha256: hash("new-signature"),
      signing: "developer-id" as const,
    }
    expect(
      checkComputerHelperSigningProvenance({
        ...provenance(),
        receipt: signedReceipt,
        manifest: final,
        manifestBytes: Buffer.from(JSON.stringify(final)),
        executableBytes: Buffer.from("new-signature"),
        expectSigning: "developer-id",
      }),
    ).toEqual([])
    final.files["VectorComputer.app/Contents/Info.plist"]!.sha256 = hash("relabeled")
    expect(() =>
      checkComputerHelperSigningProvenance({
        ...provenance(),
        receipt: { ...signedReceipt, finalManifestSha256: hash(JSON.stringify(final)) },
        manifest: final,
        manifestBytes: Buffer.from(JSON.stringify(final)),
        executableBytes: Buffer.from("new-signature"),
        expectSigning: "developer-id",
      }),
    ).toThrow("immutable")
  })

  test("beta/dev source digests are recomputed for their channel rather than compared to a production cdhash", () => {
    for (const channel of ["beta", "dev"] as const) {
      const channelManifest = { ...manifest(), sourceDigest: "e".repeat(64) }
      const channelReceipt = {
        ...receipt(),
        channel,
        sourceManifest: channelManifest,
        sourceCdhash: { x64: "1".repeat(40), arm64: "2".repeat(40) },
        finalManifestSha256: hash(JSON.stringify(channelManifest)),
      }
      expect(
        checkComputerHelperSigningProvenance({
          ...provenance(),
          channel,
          receipt: channelReceipt,
          manifest: channelManifest,
          manifestBytes: Buffer.from(JSON.stringify(channelManifest)),
          expectedSourceDigest: channelManifest.sourceDigest,
        }),
      ).toEqual([])
      expect(() =>
        checkComputerHelperSigningProvenance({
          ...provenance(),
          channel,
          receipt: channelReceipt,
          manifest: channelManifest,
          manifestBytes: Buffer.from(JSON.stringify(channelManifest)),
        }),
      ).toThrow("source provenance")
    }
  })

  test("version output must match every manifest field with one supported running architecture", () => {
    const good = {
      helperVersion: "1.0.10",
      platform: "darwin",
      protocol: { min: 1, max: 1 },
      arch: "arm64",
      sourceDigest: "a".repeat(64),
    }
    expect(() => checkComputerHelperVersion(good, manifest())).not.toThrow()
    for (const changed of [
      { ...good, helperVersion: "1.0.9" },
      { ...good, platform: "win32" },
      { ...good, arch: "ia32" },
      { ...good, sourceDigest: "b".repeat(64) },
      { ...good, protocol: { min: 1, max: 2 } },
      { ...good, extra: true },
    ])
      expect(() => checkComputerHelperVersion(changed, manifest())).toThrow("version")
  })

  test("the explicit CLI rejects duplicate, missing and unrelated arguments", () => {
    expect(parseVerifyComputerHelperArgs(["--app", "/fixture/Vector.app", "--expect-signing=adhoc"])).toEqual({
      app: path.resolve("/fixture/Vector.app"),
      expectSigning: "adhoc",
    })
    for (const args of [
      [],
      ["--app", "/fixture/Vector.app"],
      ["--app", "/fixture/Vector.app", "--expect-signing", "unknown"],
      ["--app", "/a", "--app", "/b", "--expect-signing", "adhoc"],
      ["--app", "/a", "--expect-signing", "adhoc", "--expect-signing", "developer-id"],
      ["--app", "/a", "--expect-signing", "adhoc", "unexpected"],
    ])
      expect(() => parseVerifyComputerHelperArgs(args)).toThrow()
  })
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-helper-final-"))
  const app = path.join(directory, "Vector.app")
  const files = {
    "Contents/Info.plist": "outer-info",
    "Contents/Resources/app.asar": "production renderer",
    "Contents/Resources/computer-helper.json": JSON.stringify(manifest()),
    "Contents/Resources/computer-helper-signing.json": JSON.stringify(receipt()),
    [`Contents/Helpers/${executableName}`]: executable,
    "Contents/Helpers/VectorComputer.app/Contents/Info.plist": "helper-info",
    "Contents/Helpers/VectorComputer.app/Contents/_CodeSignature/CodeResources": "code-resources",
  }
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(app, file)), { recursive: true })
    await writeFile(path.join(app, file), contents)
  }
  await mkdir(path.join(directory, "native/computer-helper/macos"), { recursive: true })
  await writeFile(path.join(directory, "native/computer-helper/macos/identity.lock.json"), JSON.stringify(lock()))
  await writeFile(
    path.join(directory, "native/computer-helper/identity.json"),
    JSON.stringify({
      displayName: Hands.NAME,
      helperVersion: "1.0.10",
      protocol: { min: 1, max: 1 },
      bundleIdSuffix: "computer",
      mac: { bundle: "VectorComputer.app", executable: "VectorComputer", minimumSystemVersion: "14.0" },
      windows: { executable: "vector-computer.exe", minimumBuild: 19041 },
    }),
  )
  const calls: { command: string; args: readonly string[] }[] = []
  const run: NativeCommand = async (command, args) => {
    calls.push({ command, args })
    if (command === "/usr/bin/plutil") {
      const value =
        args[1] === "CFBundleIdentifier"
          ? args.at(-1)?.includes("Helpers")
            ? "ai.vector.app.computer"
            : "ai.vector.app"
          : args[1] === "CFBundleShortVersionString"
            ? "1.0.10"
            : "a".repeat(64)
      return { code: 0, stdout: value, stderr: "" }
    }
    if (command === "/usr/bin/codesign") {
      if (args.includes("--verify")) return { code: 0, stdout: "", stderr: "" }
      if (args.includes("--entitlements"))
        return { code: 0, stdout: '<plist version="1.0"><dict/></plist>', stderr: "" }
      return {
        code: 0,
        stdout: "",
        stderr: signature(
          args.at(-1) === app ? "ai.vector.app" : "ai.vector.app.computer",
          args.includes("arm64") ? "arm64" : "x64",
        ),
      }
    }
    if (command !== path.join(app, "Contents/Helpers/VectorComputer.app/Contents/MacOS/VectorComputer"))
      throw new Error("Unexpected executable")
    if (args.join(" ") === "--version --json")
      return {
        code: 0,
        stdout: JSON.stringify({
          helperVersion: "1.0.10",
          platform: "darwin",
          protocol: { min: 1, max: 1 },
          sourceDigest: "a".repeat(64),
          arch: "arm64",
        }),
        stderr: "",
      }
    if (args[0] === "--self-test=packaged")
      return {
        code: 0,
        stdout: JSON.stringify({ checks: MAC_NATIVE_CHECKS.packaged.map((name) => ({ name, ok: true })) }),
        stderr: "",
      }
    throw new Error("Unexpected native operation")
  }
  return { directory, app, calls, run, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

describe("final-location verifier admission", () => {
  test("checks source/signature/manifest before running the two finite final-location commands", async () => {
    const value = await fixture()
    try {
      expect(
        (
          await verifyComputerHelperMac(
            { app: value.app, expectSigning: "adhoc" },
            { directory: value.directory, run: value.run, expectedSourceDigest: async () => "a".repeat(64) },
          )
        ).warnings,
      ).toEqual([])
      expect(value.calls.filter((call) => !call.command.startsWith("/usr/bin/")).map((call) => call.args)).toEqual([
        ["--version", "--json"],
        ["--self-test=packaged"],
      ])
      expect(value.calls.find((call) => call.args.includes("--deep"))?.args).toContain(value.app)
    } finally {
      await value.cleanup()
    }
  })

  test("an unsealed provenance receipt never admits executable self-tests", async () => {
    const value = await fixture()
    try {
      await expect(
        verifyComputerHelperMac(
          { app: value.app, expectSigning: "adhoc" },
          {
            directory: value.directory,
            expectedSourceDigest: async () => "a".repeat(64),
            run: async (command, args, settings) =>
              args.includes("--deep")
                ? { code: 1, stdout: "", stderr: "private failure text" }
                : value.run(command, args, settings),
          },
        ),
      ).rejects.toThrow("does not seal")
      expect(value.calls.some((call) => !call.command.startsWith("/usr/bin/"))).toBe(false)
    } finally {
      await value.cleanup()
    }
  })

  test("a version mismatch cannot reach the packaged self-test", async () => {
    const value = await fixture()
    try {
      await expect(
        verifyComputerHelperMac(
          { app: value.app, expectSigning: "adhoc" },
          {
            directory: value.directory,
            expectedSourceDigest: async () => "a".repeat(64),
            run: async (command, args, settings) =>
              args[0] === "--version"
                ? { code: 0, stdout: JSON.stringify({ helperVersion: "1.0.9" }), stderr: "" }
                : value.run(command, args, settings),
          },
        ),
      ).rejects.toThrow("version")
      expect(value.calls.some((call) => call.args[0] === "--self-test=packaged")).toBe(false)
    } finally {
      await value.cleanup()
    }
  })

  test("archive markers and changed final bytes stop executable admission", async () => {
    const value = await fixture()
    try {
      await writeFile(
        path.join(value.app, "Contents/Resources/app.asar"),
        "x".repeat(65_530) + "VECTOR_COMPUTER_HELPER_COMMAND",
      )
      await expect(
        verifyComputerHelperMac(
          { app: value.app, expectSigning: "adhoc" },
          { directory: value.directory, run: value.run, expectedSourceDigest: async () => "a".repeat(64) },
        ),
      ).rejects.toThrow("archive")
      expect(value.calls.some((call) => !call.command.startsWith("/usr/bin/"))).toBe(false)
      await writeFile(path.join(value.app, "Contents/Helpers", executableName), "changed")
      await expect(
        verifyComputerHelperMac(
          { app: value.app, expectSigning: "adhoc" },
          { directory: value.directory, run: value.run, expectedSourceDigest: async () => "a".repeat(64) },
        ),
      ).rejects.toThrow("manifest hash")
    } finally {
      await value.cleanup()
    }
  })
})
