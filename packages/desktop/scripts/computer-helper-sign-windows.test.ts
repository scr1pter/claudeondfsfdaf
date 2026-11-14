import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readIdentity } from "./computer-helper-identity"
import { prepareWindowsComputerHelpers, windowsHelperSigningDigest } from "./computer-helper-sign-windows"
import { windowsHelperPowerShellHost } from "./verify-computer-helper-windows"
import type { HelperArchitecture, HelperManifest, NativeCommand } from "./build-computer-helper"

const directory = path.resolve(import.meta.dirname, "..")
const subject = "CN=Vector Fixture, O=Vector Fixture Limited, C=US"
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const security = 64 + 24 + 112 + 4 * 8
const credentials = Object.fromEntries(
  [
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_SECRET",
  ].map((name) => [name, "fixture-value"]),
)

function pe(architecture: HelperArchitecture) {
  const bytes = Buffer.alloc(512)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(architecture === "x64" ? 0x8664 : 0xaa64, 68)
  bytes.writeUInt16LE(240, 84)
  bytes.writeUInt16LE(0x20b, 88)
  bytes.writeUInt32LE(16, 64 + 24 + 108)
  bytes[400] = 0x90
  return bytes
}

function signed(bytes: Buffer) {
  const certificate = Buffer.alloc(16, 0x42)
  certificate.writeUInt32LE(16, 0)
  const result = Buffer.concat([bytes, certificate])
  result.writeUInt32LE(bytes.length, security)
  result.writeUInt32LE(certificate.length, security + 4)
  result.writeUInt32LE(0x12345678, 64 + 24 + 64)
  return result
}

async function fixture(options: { noSignature?: boolean; changeCode?: boolean; changeSource?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-helper-win-sign-"))
  const source = path.join(root, "native ' source")
  const output = path.join(root, "final helpers")
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const events: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const powershell = windowsHelperPowerShellHost()
  const inspected: string[] = []
  const manifests: Partial<Record<HelperArchitecture, HelperManifest>> = {}
  for (const architecture of ["x64", "arm64"] as const) {
    await mkdir(path.join(source, architecture), { recursive: true })
    const bytes = pe(architecture)
    const manifest: HelperManifest = {
      helperVersion: identity.helperVersion,
      protocol: identity.protocol,
      platform: "win32",
      files: { "vector-computer.exe": { sha256: hash(bytes), arch: [architecture] } },
      sourceDigest: "a".repeat(64),
      toolchain: "fixture-toolchain",
    }
    manifests[architecture] = manifest
    await writeFile(path.join(source, architecture, "vector-computer.exe"), bytes)
    await writeFile(path.join(source, architecture, "computer-helper.json"), JSON.stringify(manifest, null, 2) + "\n")
  }
  const run: NativeCommand = async (command, args, input) => {
    events.push({ command, args, env: input.env, timeoutMs: input.timeoutMs })
    if (command === powershell && args.includes("-File")) {
      if (options.noSignature) return { code: 0, stdout: "", stderr: "" }
      for (const file of args.slice(args.indexOf("-File") + 2)) {
        const bytes = signed(await readFile(file))
        if (options.changeCode) bytes[400] ^= 1
        await writeFile(file, bytes)
      }
      if (options.changeSource)
        await writeFile(
          path.join(source, "x64/vector-computer.exe"),
          Buffer.concat([pe("x64"), Buffer.from("unexpected")]),
        )
      return { code: 0, stdout: "Signed both fixed helper files.", stderr: "" }
    }
    if (command === powershell) {
      const file = input.env.VECTOR_VERIFY_COMPUTER_HELPER_PATH!
      const bytes = await readFile(file)
      return {
        code: 0,
        stdout: JSON.stringify(
          bytes.readUInt32LE(security)
            ? { status: "Valid", publisher: subject, thumbprint: "b".repeat(40) }
            : { status: "NotSigned", publisher: null, thumbprint: null },
        ),
        stderr: "",
      }
    }
    const architecture = path.basename(path.dirname(command)) as HelperArchitecture
    expect(inspected.length).toBeGreaterThanOrEqual(3)
    const manifest = manifests[architecture]!
    return {
      code: 0,
      stdout: JSON.stringify({
        arch: architecture,
        helperVersion: manifest.helperVersion,
        platform: "win32",
        protocol: manifest.protocol,
        sourceDigest: manifest.sourceDigest,
      }),
      stderr: "",
    }
  }
  return {
    root,
    source,
    output,
    events,
    powershell,
    manifests,
    dependencies: {
      directory,
      run,
      environment: { GITHUB_ACTIONS: "true", ...credentials },
      expectedSourceDigest: async () => "a".repeat(64),
      inspect: async (_bytes: Uint8Array, architecture: HelperArchitecture) => {
        inspected.push(architecture)
        return { architecture, manifestLanguages: [0] }
      },
    },
  }
}

describe("immutable Windows helper release signing", () => {
  test("the signing digest permits only checksum/certificate changes and preserves tested code", () => {
    const original = pe("x64")
    const final = signed(original)
    expect(windowsHelperSigningDigest(final)).toBe(windowsHelperSigningDigest(original))
    final[400] ^= 1
    expect(windowsHelperSigningDigest(final)).not.toBe(windowsHelperSigningDigest(original))
    final.writeUInt32LE(12, security)
    expect(() => windowsHelperSigningDigest(final)).toThrow("certificate table")
  })

  test("signs both architectures once before returning pins and rewrites only final manifest hashes", async () => {
    const f = await fixture()
    try {
      const pins = await prepareWindowsComputerHelpers(
        { source: f.source, output: f.output, channel: "prod", expectSigning: "authenticode", publisher: subject },
        f.dependencies,
      )
      const signing = f.events.filter((event) => event.args.includes("-File"))
      expect(signing).toHaveLength(1)
      expect(signing[0]!.args.slice(-2)).toEqual([
        path.join(f.output, "x64/vector-computer.exe"),
        path.join(f.output, "arm64/vector-computer.exe"),
      ])
      expect(signing[0]!.env.VECTOR_REQUIRE_WINDOWS_SIGNING).toBe("true")
      expect(signing[0]!.env.AZURE_CLIENT_SECRET).toBe("fixture-value")
      expect(signing[0]!.command).toBe(f.powershell)
      expect(path.win32.isAbsolute(signing[0]!.command)).toBe(true)
      expect(signing[0]!.timeoutMs).toBe(300_000)
      expect(
        f.events
          .filter((event) => !event.args.includes("-File"))
          .every((event) => event.env.AZURE_CLIENT_SECRET === undefined),
      ).toBe(true)
      const observations = f.events.filter((event) => event.args.includes("-EncodedCommand"))
      expect(observations).toHaveLength(4)
      for (const observation of observations) {
        expect(observation.command).toBe(f.powershell)
        expect(path.win32.isAbsolute(observation.command)).toBe(true)
        expect(observation.timeoutMs).toBe(10_000)
        expect(observation.env.AZURE_CLIENT_SECRET).toBeUndefined()
        expect(observation.env.VECTOR_VERIFY_COMPUTER_HELPER_PATH).toEndWith("vector-computer.exe")
        const script = Buffer.from(observation.args.at(-1)!, "base64").toString("utf16le")
        expect(script).toContain("Get-AuthenticodeSignature -LiteralPath $env:VECTOR_VERIFY_COMPUTER_HELPER_PATH")
        expect(script).toContain("[Console]::OpenStandardOutput()")
        expect(script).not.toMatch(/OutputEncoding\s*=|SetConsoleOutputCP/)
        expect(script).not.toContain(observation.env.VECTOR_VERIFY_COMPUTER_HELPER_PATH!)
      }
      for (const architecture of ["x64", "arm64"] as const) {
        const bytes = await readFile(path.join(f.output, architecture, "vector-computer.exe"))
        const manifest = JSON.parse(await readFile(path.join(f.output, architecture, "computer-helper.json"), "utf8"))
        expect(manifest).toEqual({
          ...f.manifests[architecture],
          files: { "vector-computer.exe": { sha256: hash(bytes), arch: [architecture] } },
        })
        expect(pins[architecture]).toBe(hash(bytes))
        expect(await readFile(path.join(f.source, architecture, "vector-computer.exe"))).toEqual(pe(architecture))
      }
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("a restored final artifact verifies against the original code without another signature", async () => {
    const f = await fixture()
    try {
      const input = {
        source: f.source,
        output: f.output,
        channel: "prod" as const,
        expectSigning: "authenticode" as const,
        publisher: subject,
      }
      const pins = await prepareWindowsComputerHelpers(input, f.dependencies)
      const before = await readFile(path.join(f.output, "x64/vector-computer.exe"))
      expect(
        await prepareWindowsComputerHelpers({ ...input, restored: true }, { ...f.dependencies, environment: {} }),
      ).toEqual(pins)
      expect(f.events.filter((event) => event.args.includes("-File"))).toHaveLength(1)
      expect(await readFile(path.join(f.output, "x64/vector-computer.exe"))).toEqual(before)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("restored metadata cannot launder changed code or a wrong architecture", async () => {
    const f = await fixture()
    try {
      const input = {
        source: f.source,
        output: f.output,
        channel: "prod" as const,
        expectSigning: "authenticode" as const,
        publisher: subject,
      }
      await prepareWindowsComputerHelpers(input, f.dependencies)
      const file = path.join(f.output, "arm64/vector-computer.exe")
      const bytes = await readFile(file)
      bytes[400] ^= 1
      await writeFile(file, bytes)
      const manifest = {
        ...f.manifests.arm64!,
        files: { "vector-computer.exe": { sha256: hash(bytes), arch: ["arm64"] } },
      }
      await writeFile(path.join(f.output, "arm64/computer-helper.json"), JSON.stringify(manifest))
      await expect(prepareWindowsComputerHelpers({ ...input, restored: true }, f.dependencies)).rejects.toThrow(
        "tested code",
      )
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("a successful signing command cannot substitute for an actual valid signature", async () => {
    const f = await fixture({ noSignature: true })
    try {
      await expect(
        prepareWindowsComputerHelpers(
          { source: f.source, output: f.output, channel: "prod", expectSigning: "authenticode", publisher: subject },
          f.dependencies,
        ),
      ).rejects.toThrow("configured publisher")
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("a failed shared OS signature observation prevents signing, version execution and returned pins", async () => {
    const f = await fixture()
    try {
      let observations = 0
      const error = await prepareWindowsComputerHelpers(
        { source: f.source, output: f.output, channel: "prod", expectSigning: "authenticode", publisher: subject },
        {
          ...f.dependencies,
          run: async (command, args, settings) => {
            if (command === f.powershell) {
              observations++
              return { code: 23, stdout: "PRIVATE stdout", stderr: "PRIVATE signature error" }
            }
            return f.dependencies.run(command, args, settings)
          },
        },
      ).then(
        () => new Error("Unexpected successful signing preparation"),
        (cause: unknown) => cause,
      )
      expect(String(error)).toContain("[reason=process-exit; exit=23; stage=stdout]")
      expect(String(error)).not.toContain("PRIVATE")
      expect(observations).toBe(1)
      expect(f.events).toEqual([])
      expect(await readFile(path.join(f.source, "x64/vector-computer.exe"))).toEqual(pe("x64"))
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("signing cannot change executable code or mutate the tested original artifact", async () => {
    for (const option of [{ changeCode: true }, { changeSource: true }]) {
      const f = await fixture(option)
      try {
        await expect(
          prepareWindowsComputerHelpers(
            { source: f.source, output: f.output, channel: "prod", expectSigning: "authenticode", publisher: subject },
            f.dependencies,
          ),
        ).rejects.toThrow(option.changeCode ? "tested code" : "artifact changed")
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  })

  test("explicit unsigned releases preserve exact original bytes and never invoke the signer", async () => {
    const f = await fixture()
    try {
      const input = { source: f.source, output: f.output, channel: "prod" as const, expectSigning: "unsigned" as const }
      await expect(prepareWindowsComputerHelpers(input, f.dependencies)).rejects.toThrow("explicit unsigned")
      const pins = await prepareWindowsComputerHelpers(input, {
        ...f.dependencies,
        environment: { VECTOR_ALLOW_UNSIGNED_RELEASE: "true" },
      })
      expect(f.events.some((event) => event.args.includes("-File"))).toBe(false)
      expect(pins).toEqual({ x64: hash(pe("x64")), arm64: hash(pe("arm64")) })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("missing credentials and a company-name substring cannot weaken configured signing policy", async () => {
    for (const environment of [{}, { GITHUB_ACTIONS: "true" }]) {
      const f = await fixture()
      try {
        await expect(
          prepareWindowsComputerHelpers(
            { source: f.source, output: f.output, channel: "prod", expectSigning: "authenticode", publisher: subject },
            { ...f.dependencies, environment },
          ),
        ).rejects.toThrow("credentials are not configured")
        expect(f.events.some((event) => event.args.includes("-File"))).toBe(false)
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
    const f = await fixture()
    try {
      await expect(
        prepareWindowsComputerHelpers(
          {
            source: f.source,
            output: f.output,
            channel: "prod",
            expectSigning: "authenticode",
            publisher: "Vector Fixture",
          },
          f.dependencies,
        ),
      ).rejects.toThrow("configured publisher")
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
