import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Hands } from "@vectordevai/schema/hands"
import { APP_IDS } from "./channel-ids"
import { createManifest, renderHelperPlist, sourceDigestFor } from "./build-computer-helper"
import type { HelperArchitecture, HelperManifest, HelperPlatform, NativeCommand } from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import { computerHelperPaths, ensureComputerHelper, prepareComputerHelper } from "./computer-helper-package"

const directory = fileURLToPath(new URL("../", import.meta.url))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const environment = { VECTOR_COMPUTER_HELPER_PREBUILT: "true" }

// Header fixtures exercise package validation, never native execution. Commands are injected below.
function pe(arch: HelperArchitecture) {
  const bytes = Buffer.alloc(512)
  bytes.writeUInt16LE(0x5a4d)
  bytes.writeUInt32LE(128, 0x3c)
  bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 132)
  bytes.writeUInt16LE(1, 134)
  bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(2, 150)
  bytes.writeUInt16LE(0x20b, 152)
  bytes.writeUInt16LE(2, 220)
  return bytes
}
function macho(arch: HelperArchitecture) {
  const bytes = Buffer.alloc(104)
  bytes.writeUInt32LE(0xfeedfacf)
  bytes.writeUInt32LE(arch === "x64" ? 0x1000007 : 0x100000c, 4)
  bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(72, 20)
  bytes.writeUInt32LE(0x19, 32)
  bytes.writeUInt32LE(72, 36)
  return bytes
}
function universal() {
  const bytes = Buffer.alloc(8 + 40 + 208)
  bytes.writeUInt32BE(0xcafebabe)
  bytes.writeUInt32BE(2, 4)
  for (const [index, arch] of (["x64", "arm64"] as const).entries()) {
    bytes.writeUInt32BE(arch === "x64" ? 0x1000007 : 0x100000c, 8 + index * 20)
    bytes.writeUInt32BE(48 + index * 104, 16 + index * 20)
    bytes.writeUInt32BE(104, 20 + index * 20)
    macho(arch).copy(bytes, 48 + index * 104)
  }
  return bytes
}

async function fixture<T>(
  platform: HelperPlatform,
  channel: Hands.Channel,
  architectures: HelperArchitecture[],
  work: (value: {
    root: string
    manifests: Map<string, HelperManifest>
    run: NativeCommand
    calls: { command: string; args: readonly string[] }[]
    copy: (arch: HelperArchitecture | "universal") => Promise<Parameters<typeof prepareComputerHelper>[0]>
    rehash: (relative: string, bytes: Buffer, arch?: HelperArchitecture) => Promise<void>
  }) => Promise<T>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "vector-helper-package-"))
  try {
    for (const relative of [
      "native/computer-helper/identity.json",
      "native/computer-helper/blocklist.json",
      `native/computer-helper/${platform === "darwin" ? "macos" : "windows"}`,
      "scripts/build-computer-helper.ts",
      "scripts/computer-helper-identity.ts",
      "scripts/channel-ids.ts",
      ...(["prod", "beta", "dev"] as const).map(
        (name) => `icons/${name}/icon.${platform === "darwin" ? "icns" : "ico"}`,
      ),
    ]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
      await cp(path.join(directory, relative), path.join(root, relative), { recursive: true })
    }
    const identity = readIdentity(path.join(root, "native/computer-helper/identity.json"))
    const generated = generateIdentitySources(path.join(root, "generated"), {
      identity: path.join(root, "native/computer-helper/identity.json"),
      blocklist: path.join(root, "native/computer-helper/blocklist.json"),
    })
    const toolchain = "injected native package fixture"
    const sourceDigest = await sourceDigestFor(
      root,
      platform,
      channel,
      toolchain,
      generated.find((file) => file.endsWith("Identity.swift"))!,
    )
    const manifests = new Map<string, HelperManifest>()
    for (const arch of platform === "darwin" ? [undefined] : architectures) {
      const paths = computerHelperPaths(platform, channel, arch, root)!
      const files: Record<string, Buffer> =
        platform === "win32"
          ? { "vector-computer.exe": pe(arch!) }
          : {
              "VectorComputer.app/Contents/MacOS/VectorComputer":
                architectures.length === 2 ? universal() : macho(architectures[0]!),
              "VectorComputer.app/Contents/Info.plist": Buffer.from(
                renderHelperPlist(
                  await readFile(path.join(root, "native/computer-helper/macos/Info.plist.template"), "utf8"),
                  {
                    HELPER_BUNDLE_ID: Hands.helperBundleId(APP_IDS[channel]),
                    HELPER_EXECUTABLE: identity.mac.executable,
                    HELPER_NAME: Hands.helperName(channel),
                    HELPER_VERSION: identity.helperVersion,
                    MINIMUM_SYSTEM_VERSION: identity.mac.minimumSystemVersion,
                    SOURCE_DIGEST: sourceDigest,
                  },
                ),
              ),
              "VectorComputer.app/Contents/Resources/AppIcon.icns": await readFile(
                path.join(root, `icons/${channel}/icon.icns`),
              ),
              "VectorComputer.app/Contents/_CodeSignature/CodeResources": Buffer.from(
                "injected signature resource, not a measured signature",
              ),
            }
      for (const [relative, bytes] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(paths.sourceRoot, relative)), { recursive: true })
        await writeFile(path.join(paths.sourceRoot, relative), bytes)
      }
      const manifest = createManifest({
        helperVersion: identity.helperVersion,
        protocol: identity.protocol,
        platform,
        sourceDigest,
        toolchain,
        files: Object.fromEntries(
          Object.entries(files).map(([relative, bytes]) => [
            relative,
            { sha256: digest(bytes), arch: arch ? [arch] : architectures },
          ]),
        ),
      })
      manifests.set(arch ?? "universal", manifest)
      await writeFile(paths.sourceManifest, JSON.stringify(manifest))
    }
    const calls: { command: string; args: readonly string[] }[] = []
    const run: NativeCommand = async (command, args) => {
      calls.push({ command, args })
      if (command === "/usr/bin/codesign" && args[0] === "--verify") return { code: 0, stdout: "", stderr: "" }
      const arch =
        platform === "win32"
          ? path.basename(path.dirname(command))
          : architectures.includes(process.arch as HelperArchitecture)
            ? process.arch
            : architectures[0]!
      const manifest = manifests.get(platform === "darwin" ? "universal" : arch)!
      if (
        command.endsWith(platform === "darwin" ? "/VectorComputer" : "vector-computer.exe") &&
        args.join() === "--version,--json"
      )
        return {
          code: 0,
          stdout: JSON.stringify({
            helperVersion: manifest.helperVersion,
            protocol: manifest.protocol,
            platform,
            arch,
            sourceDigest: manifest.sourceDigest,
          }),
          stderr: "",
        }
      throw new Error(`Unexpected native command in package fixture: ${path.basename(command)}`)
    }
    const copy = async (arch: HelperArchitecture | "universal") => {
      const paths = computerHelperPaths(platform, channel, arch, root)!
      const name = channel === "prod" ? "Vector" : channel === "beta" ? "Vector Beta" : "Vector Dev"
      const appOutDir = path.join(root, "dist", arch)
      if (platform === "darwin") {
        await mkdir(path.join(appOutDir, `${name}.app/Contents/Helpers`), { recursive: true })
        await cp(paths.sourceBundle!, path.join(appOutDir, `${name}.app`, paths.packaged.bundle!), { recursive: true })
        await mkdir(path.join(appOutDir, `${name}.app/Contents/Resources`), { recursive: true })
        await cp(paths.sourceManifest, path.join(appOutDir, `${name}.app`, paths.packaged.manifest))
      } else {
        await mkdir(path.join(appOutDir, "resources/computer"), { recursive: true })
        await cp(paths.sourceExecutable, path.join(appOutDir, paths.packaged.executable))
        await cp(paths.sourceManifest, path.join(appOutDir, paths.packaged.manifest))
      }
      return { electronPlatformName: platform, arch, appOutDir, packager: { appInfo: { productFilename: name } } }
    }
    const rehash = async (relative: string, bytes: Buffer, arch?: HelperArchitecture) => {
      const paths = computerHelperPaths(platform, channel, arch, root)!
      await writeFile(path.join(paths.sourceRoot, relative), bytes)
      const manifest = manifests.get(arch ?? "universal")!
      manifest.files[relative]!.sha256 = digest(bytes)
      await writeFile(paths.sourceManifest, JSON.stringify(manifest))
    }
    return await work({ root, manifests, run, calls, copy, rehash })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("computer helper package planning", () => {
  test("paths preserve the platform install contract, channel names and builder architecture macro", () => {
    const mac = computerHelperPaths("darwin", "beta", "universal", "/package")!
    expect(mac.extraFiles).toEqual([
      { from: path.resolve("/package/native/out/darwin/VectorComputer.app"), to: "Helpers/VectorComputer.app" },
    ])
    expect(mac.packaged.executable).toBe("Contents/Helpers/VectorComputer.app/Contents/MacOS/VectorComputer")
    expect(mac.packaged.manifest).toBe("Contents/Resources/computer-helper.json")
    const windows = computerHelperPaths("win32", "prod", undefined, "/package")!
    expect(windows.sourceRoot).toBe(path.resolve("/package/native/out/win32/${arch}"))
    expect(windows.extraResources).toEqual([
      { from: windows.sourceRoot, to: "computer", filter: ["vector-computer.exe", "computer-helper.json"] },
    ])
    expect(computerHelperPaths("linux", "prod")).toBeUndefined()
  })
  test("Linux needs no helper and only an explicitly skipped dev build can omit one", async () => {
    const run: NativeCommand = async () => {
      throw new Error("No native command expected")
    }
    expect(
      await ensureComputerHelper({ platform: "linux", architectures: [], channel: "prod", environment: {}, run }),
    ).toEqual({ skipped: true, manifests: [], windowsHashes: {} })
    expect(
      (
        await ensureComputerHelper({
          platform: "darwin",
          architectures: [],
          channel: "dev",
          environment: { VECTOR_COMPUTER_HELPER: "skip" },
          run,
        })
      ).skipped,
    ).toBe(true)
    for (const channel of ["prod", "beta"] as const)
      await expect(
        ensureComputerHelper({
          platform: "darwin",
          architectures: ["x64"],
          channel,
          environment: { VECTOR_COMPUTER_HELPER: "skip" },
          run,
        }),
      ).rejects.toThrow("explicit dev")
    await expect(
      ensureComputerHelper({
        platform: "win32",
        architectures: ["x64"],
        channel: "dev",
        environment: { VECTOR_COMPUTER_HELPER: "true" },
        run,
      }),
    ).rejects.toThrow("only accepts")
  })
  test("invalid environment, channels, architecture ambiguity and forged host observations fail before native commands", async () => {
    const base = { platform: "win32", architectures: ["x64"], channel: "prod", environment: {} } as const
    await expect(
      ensureComputerHelper({ ...base, environment: { VECTOR_COMPUTER_HELPER_PREBUILT: "yes" } }),
    ).rejects.toThrow("true or false")
    await expect(ensureComputerHelper({ ...base, environment: { VECTOR_CHANNEL: "beta" } })).rejects.toThrow("differs")
    await expect(ensureComputerHelper({ ...base, architectures: ["x64", "x64"] })).rejects.toThrow("unambiguous")
    await expect(
      ensureComputerHelper({ ...base, host: process.platform === "linux" ? "darwin" : "linux" }),
    ).rejects.toThrow("actual host")
    await expect(ensureComputerHelper({ ...base, checkLock: true })).rejects.toThrow("production helper")
    await expect(
      ensureComputerHelper({ ...base, platform: "darwin", channel: "beta", checkLock: true }),
    ).rejects.toThrow("production helper")
  })
  test("a cross-host build is refused instead of pretending a compiler or signature verifier exists", async () => {
    const target = process.platform === "darwin" ? "win32" : "darwin"
    await expect(
      ensureComputerHelper({ platform: target, architectures: ["x64"], channel: "dev", directory, environment: {} }),
    ).rejects.toThrow("build the")
  })
})

describe("verified shipping helper bytes", () => {
  test("both Windows slices are verified and return the hashes of actual manifest-bound executables", () =>
    fixture("win32", "prod", ["x64", "arm64"], async ({ root, run, manifests }) => {
      const result = await ensureComputerHelper({
        platform: "win32",
        architectures: ["arm64", "x64"],
        channel: "prod",
        directory: root,
        environment,
        run,
      })
      expect(result.manifests).toHaveLength(2)
      expect(result.windowsHashes).toEqual({
        x64: manifests.get("x64")!.files["vector-computer.exe"]!.sha256,
        arm64: manifests.get("arm64")!.files["vector-computer.exe"]!.sha256,
      })
    }))
  test("a wrong channel cannot reuse another channel's source digest", () =>
    fixture("win32", "dev", ["x64"], async ({ root, run }) => {
      await expect(
        ensureComputerHelper({
          platform: "win32",
          architectures: ["x64"],
          channel: "prod",
          directory: root,
          environment,
          run,
        }),
      ).rejects.toThrow("source digest")
    }))
  test("rehashing a non-PE does not make an ELF architecture an acceptable Windows helper", () =>
    fixture("win32", "prod", ["x64"], async ({ root, run, rehash }) => {
      const elf = Buffer.alloc(512)
      elf.writeUInt32BE(0x7f454c46)
      elf[5] = 1
      elf.writeUInt16LE(0x3e, 18)
      await rehash("vector-computer.exe", elf, "x64")
      await expect(
        ensureComputerHelper({
          platform: "win32",
          architectures: ["x64"],
          channel: "prod",
          directory: root,
          environment,
          run,
        }),
      ).rejects.toThrow("PE executable")
    }))
  test("macOS universal output keeps its full signed channel metadata and every copied byte unchanged", () =>
    fixture("darwin", "beta", ["x64", "arm64"], async ({ root, run, calls, copy }) => {
      const paths = computerHelperPaths("darwin", "beta", "universal", root)!
      const before = await readFile(path.join(paths.sourceBundle!, "Contents/Info.plist"))
      expect(
        (
          await ensureComputerHelper({
            platform: "darwin",
            architectures: ["universal"],
            channel: "beta",
            directory: root,
            environment,
            run,
          })
        ).manifests,
      ).toHaveLength(1)
      const context = await copy("universal")
      expect(
        (await prepareComputerHelper(context, { channel: "beta", directory: root, environment, run })).skipped,
      ).toBe(false)
      expect(
        await readFile(
          path.join(context.appOutDir, "Vector Beta.app/Contents/Helpers/VectorComputer.app/Contents/Info.plist"),
        ),
      ).toEqual(before)
      expect(await readFile(path.join(paths.sourceBundle!, "Contents/Info.plist"))).toEqual(before)
      expect(calls.every((call) => call.command !== "/usr/bin/plutil" && !call.args.includes("--sign"))).toBe(true)
      if (process.platform !== "darwin") expect(calls).toHaveLength(0)
    }))
  test("a rehashed Mac Info.plist is refused instead of relabeled during packaging", () =>
    fixture("darwin", "prod", ["x64"], async ({ root, run, rehash }) => {
      const relative = "VectorComputer.app/Contents/Info.plist"
      const paths = computerHelperPaths("darwin", "prod", "x64", root)!
      const changed = Buffer.from(
        (await readFile(path.join(paths.sourceRoot, relative), "utf8")).replace(
          "ai.vector.app.computer",
          "ai.vector.app.beta.computer",
        ),
      )
      await rehash(relative, changed)
      await expect(
        ensureComputerHelper({
          platform: "darwin",
          architectures: ["x64"],
          channel: "prod",
          directory: root,
          environment,
          run,
        }),
      ).rejects.toThrow("Info.plist")
      expect(await readFile(path.join(paths.sourceRoot, relative))).toEqual(changed)
    }))
  test("a rehashed channel icon is refused even though the manifest hash was also replaced", () =>
    fixture("darwin", "dev", ["x64"], async ({ root, run, rehash }) => {
      await rehash("VectorComputer.app/Contents/Resources/AppIcon.icns", Buffer.from("another icon"))
      await expect(
        ensureComputerHelper({
          platform: "darwin",
          architectures: ["x64"],
          channel: "dev",
          directory: root,
          environment,
          run,
        }),
      ).rejects.toThrow("icon")
    }))
  test("a PE with the right CPU cannot impersonate a Mac executable", () =>
    fixture("darwin", "prod", ["x64"], async ({ root, run, rehash }) => {
      await rehash("VectorComputer.app/Contents/MacOS/VectorComputer", pe("x64"))
      await expect(
        ensureComputerHelper({
          platform: "darwin",
          architectures: ["x64"],
          channel: "prod",
          directory: root,
          environment,
          run,
        }),
      ).rejects.toThrow("Mach-O")
    }))
})

describe("afterPack verification", () => {
  test("the real packaged architecture selects its own unchanged Windows helper", () =>
    fixture("win32", "beta", ["x64", "arm64"], async ({ root, run, copy, manifests }) => {
      const context = await copy("arm64")
      const result = await prepareComputerHelper(
        { ...context, arch: 3 },
        { channel: "beta", directory: root, environment, run },
      )
      expect(result.windowsHashes).toEqual({ arm64: manifests.get("arm64")!.files["vector-computer.exe"]!.sha256 })
      await expect(
        prepareComputerHelper({ ...context, arch: 0 }, { channel: "beta", directory: root, environment, run }),
      ).rejects.toThrow("architecture")
    }))
  test("a changed packaged executable cannot keep its build hash", () =>
    fixture("win32", "prod", ["x64"], async ({ root, run, copy }) => {
      const context = await copy("x64")
      const file = path.join(context.appOutDir, "resources/computer/vector-computer.exe")
      const bytes = await readFile(file)
      bytes[511] = 1
      await writeFile(file, bytes)
      await expect(
        prepareComputerHelper(context, { channel: "prod", directory: root, environment, run }),
      ).rejects.toThrow("hash check")
    }))
  test("test executables, extra files and a substituted packaged manifest never ship as helper resources", () =>
    fixture("win32", "prod", ["x64"], async ({ root, run, copy }) => {
      const context = await copy("x64")
      const extra = path.join(context.appOutDir, "resources/computer/vector-computer-tests.exe")
      await writeFile(extra, pe("x64"))
      await expect(
        prepareComputerHelper(context, { channel: "prod", directory: root, environment, run }),
      ).rejects.toThrow("unexpected or missing")
      await rm(extra)
      await writeFile(path.join(context.appOutDir, "resources/computer/computer-helper.json"), "{}")
      await expect(
        prepareComputerHelper(context, { channel: "prod", directory: root, environment, run }),
      ).rejects.toThrow("manifest differs")
    }))
  test.skipIf(process.platform === "win32")(
    "a packaged symbolic link is refused even when it points at the matching source bytes",
    () =>
      fixture("win32", "prod", ["x64"], async ({ root, run, copy }) => {
        const context = await copy("x64")
        const file = path.join(context.appOutDir, "resources/computer/vector-computer.exe")
        await rm(file)
        await symlink(computerHelperPaths("win32", "prod", "x64", root)!.sourceExecutable, file)
        await expect(
          prepareComputerHelper(context, { channel: "prod", directory: root, environment, run }),
        ).rejects.toThrow("symbolic links")
      }),
  )
  test("explicit dev skip and Linux afterPack require no native directory or app name", async () => {
    const context = {
      electronPlatformName: "darwin",
      arch: 1,
      appOutDir: "/absent",
      packager: { appInfo: { productFilename: "" } },
    }
    expect(
      (await prepareComputerHelper(context, { channel: "dev", environment: { VECTOR_COMPUTER_HELPER: "skip" } }))
        .skipped,
    ).toBe(true)
    expect(
      (await prepareComputerHelper({ ...context, electronPlatformName: "linux" }, { channel: "prod", environment: {} }))
        .skipped,
    ).toBe(true)
  })
})
