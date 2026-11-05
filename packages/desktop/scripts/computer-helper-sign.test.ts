import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hands } from "@vectordevai/schema/hands"
import { APP_IDS } from "./channel-ids"
import { binaryArchitectures } from "./verify-native"
import {
  computerHelperSigningIgnore,
  finalizeComputerHelperMacSigning,
  prepareComputerHelperMacSigning,
  installUnsignedMacComputerHelperFuses,
  signComputerHelperMac,
  signUnsignedMacWithComputerHelper,
  signMacWithComputerHelper,
  verifyComputerHelperMacSignature,
} from "./computer-helper-sign"
import type { HelperManifest, NativeCommand } from "./build-computer-helper"

const empty = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>'
const certificate = "Developer ID Application: Vector Fixture (ABCDEFGHIJ)"
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function fixture(channel: Hands.Channel = "prod", universal = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-helper-sign-"))
  const app = path.join(directory, "Fixture ' release.app")
  const helper = path.join(app, "Contents/Helpers/VectorComputer.app")
  const executable = path.join(helper, "Contents/MacOS/VectorComputer")
  await mkdir(path.dirname(executable), { recursive: true })
  const bytes = Buffer.alloc(universal ? 48 : 32)
  if (universal) {
    bytes.writeUInt32BE(0xcafebabe, 0)
    bytes.writeUInt32BE(2, 4)
    bytes.writeUInt32BE(0x1000007, 8)
    bytes.writeUInt32BE(0x100000c, 28)
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x1000007, 4)
  }
  await writeFile(executable, bytes)
  await writeFile(
    path.join(helper, "Contents/Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${Hands.helperBundleId(APP_IDS[channel])}</string><key>CFBundleExecutable</key><string>VectorComputer</string></dict></plist>`,
  )
  await mkdir(path.join(directory, "native/computer-helper/macos"), { recursive: true })
  await writeFile(path.join(directory, "native/computer-helper/macos/entitlements.plist"), empty)
  const sourceManifest: HelperManifest = {
    helperVersion: "1.0.0",
    protocol: { min: 1, max: 1 },
    platform: "darwin",
    sourceDigest: "a".repeat(64),
    toolchain: "fixture-toolchain",
    files: {
      "VectorComputer.app/Contents/MacOS/VectorComputer": {
        sha256: sha256(bytes),
        arch: universal ? ["x64", "arm64"] : ["x64"],
      },
      "VectorComputer.app/Contents/Info.plist": {
        sha256: sha256(await readFile(path.join(helper, "Contents/Info.plist"))),
        arch: [],
      },
    },
  }
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true })
  await writeFile(path.join(app, "Contents/Resources/computer-helper.json"), JSON.stringify(sourceManifest))
  await writeFile(
    path.join(directory, "native/computer-helper/macos/identity.lock.json"),
    JSON.stringify({
      enforce: true,
      helperVersion: sourceManifest.helperVersion,
      sourceDigest: sourceManifest.sourceDigest,
      toolchain: sourceManifest.toolchain,
      cdhash: { x64: "b".repeat(40), arm64: "b".repeat(40) },
    }),
  )
  const calls: string[][] = []
  const run: NativeCommand = async (command, args) => {
    expect(command).toBe("/usr/bin/codesign")
    calls.push([...args])
    if (args.includes("--entitlements") && args[0] === "--display") return { code: 0, stdout: empty, stderr: "" }
    const signed = calls.some((call) => call.includes("--sign") && call[call.indexOf("--sign") + 1] !== "-")
    return {
      code: 0,
      stdout: "",
      stderr: `Identifier=${Hands.helperBundleId(APP_IDS[channel])}\nCodeDirectory flags=0x10000(runtime)\nCDHash=${"b".repeat(40)}\n${signed ? `Authority=${certificate}\nTeamIdentifier=ABCDEFGHIJ` : "Signature=adhoc\nTeamIdentifier=not set"}\n`,
    }
  }
  return { directory, app, helper, executable, calls, run, channel, sourceManifest }
}

async function arm(f: Awaited<ReturnType<typeof fixture>>) {
  await prepareComputerHelperMacSigning({ app: f.app, channel: f.channel, sourceManifest: f.sourceManifest }, f)
  f.calls.length = 0
}

describe("computer helper macOS signing", () => {
  test("ad-hoc signing uses only the helper plist, runtime and exact beta identifier", async () => {
    const f = await fixture("beta")
    try {
      expect(
        await signComputerHelperMac(
          {
            app: f.app,
            channel: f.channel,
            identity: "-",
            keychain: "must-not-be-used",
            timestamp: "https://unused.invalid",
          },
          f,
        ),
      ).toBe(f.helper)
      expect(f.calls[0]).toEqual([
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        path.join(f.directory, "native/computer-helper/macos/entitlements.plist"),
        "--identifier",
        Hands.helperBundleId(APP_IDS.beta),
        f.helper,
      ])
      expect(f.calls.some((call) => call.includes("--keychain"))).toBe(false)
      expect(f.calls.filter((call) => call[0] === "--display" && call.includes("--arch")).length).toBe(2)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("certificate signing requests timestamp and keychain and checks both actual slices", async () => {
    const f = await fixture("prod", true)
    try {
      await signComputerHelperMac(
        { app: f.app, channel: f.channel, identity: certificate, keychain: "/fixture/keychain" },
        f,
      )
      expect(f.calls[0]).toContain("--timestamp")
      expect(f.calls[0]?.slice(f.calls[0].indexOf("--keychain"), f.calls[0].indexOf("--keychain") + 2)).toEqual([
        "--keychain",
        "/fixture/keychain",
      ])
      expect(
        f.calls
          .filter((call) => call[0] === "--display" && !call.includes("--entitlements"))
          .map((call) => call[call.indexOf("--arch") + 1]),
      ).toEqual(["x86_64", "arm64"])
      await expect(
        signComputerHelperMac({ app: f.app, channel: f.channel, identity: certificate, timestamp: "none" }, f),
      ).rejects.toThrow("secure timestamp")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("wrong Info identity and nonempty source entitlements stop before signing", async () => {
    const f = await fixture()
    try {
      await writeFile(
        path.join(f.directory, "native/computer-helper/macos/entitlements.plist"),
        "<plist><dict><key>extra</key><true/></dict></plist>",
      )
      await expect(signComputerHelperMac({ app: f.app, channel: f.channel, identity: "-" }, f)).rejects.toThrow(
        "empty dictionary",
      )
      expect(f.calls).toEqual([])
      await writeFile(path.join(f.directory, "native/computer-helper/macos/entitlements.plist"), empty)
      await writeFile(
        path.join(f.helper, "Contents/Info.plist"),
        "<plist><dict><key>CFBundleIdentifier</key><string>ai.vector.app.helper</string></dict></plist>",
      )
      await expect(signComputerHelperMac({ app: f.app, channel: f.channel, identity: "-" }, f)).rejects.toThrow(
        "wrong channel identity",
      )
      expect(f.calls).toEqual([])
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("a linked helper outside the app is never signed", async () => {
    const f = await fixture()
    try {
      const outside = path.join(f.directory, "outside.app")
      await cp(f.helper, outside, { recursive: true })
      await rm(f.helper, { recursive: true })
      await symlink(outside, f.helper)
      await expect(signComputerHelperMac({ app: f.app, channel: f.channel, identity: "-" }, f)).rejects.toThrow(
        "inside the app",
      )
      expect(f.calls).toEqual([])
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("signature postchecks refuse wrong identifier, missing runtime, changed kind and nonempty entitlements", async () => {
    const f = await fixture()
    try {
      for (const signature of [
        "Identifier=wrong\nCodeDirectory flags=0x10000(runtime)\nSignature=adhoc",
        "Identifier=ai.vector.app.computer\nSignature=adhoc",
        "Identifier=ai.vector.app.computer\nCodeDirectory flags=0x0(runtime)\nSignature=adhoc",
        "Identifier=ai.vector.app.computer\nCodeDirectory flags=0x10000(runtime)\nAuthority=Unexpected",
      ]) {
        await expect(
          verifyComputerHelperMacSignature(
            { app: f.app, channel: f.channel, identity: "-" },
            { ...f, run: async () => ({ code: 0, stdout: signature, stderr: "" }) },
          ),
        ).rejects.toThrow("retain its own")
      }
      const bad: NativeCommand = async (command, args, options) =>
        args.includes("--entitlements")
          ? { code: 0, stdout: "<plist><dict><key>extra</key><true/></dict></plist>", stderr: "" }
          : f.run(command, args, options)
      await expect(
        verifyComputerHelperMacSignature({ app: f.app, channel: f.channel, identity: "-" }, { ...f, run: bad }),
      ).rejects.toThrow("empty dictionary")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("ignores the exact helper subtree and preserves function/string ignores without prefix collisions", () => {
    const helper = "/fixture/App.app/Contents/Helpers/VectorComputer.app"
    const ignored = computerHelperSigningIgnore(helper, (file) => file.endsWith(".kext"))
    expect(ignored(helper)).toBe(true)
    expect(ignored(path.join(helper, "Contents/MacOS/VectorComputer"))).toBe(true)
    expect(ignored(helper + "-backup/Contents/MacOS/VectorComputer")).toBe(false)
    expect(ignored("/fixture/driver.kext")).toBe(true)
    expect(computerHelperSigningIgnore(helper, ["old-ignore$"])("/fixture/old-ignore")).toBe(true)
  })

  test("outer ad-hoc signing preserves Electron rules while forcing no timestamp or keychain", async () => {
    const f = await fixture("dev")
    try {
      await arm(f)
      await signMacWithComputerHelper(
        {
          app: f.app,
          identity: "-",
          keychain: "unused",
          ignore: (file) => file.endsWith(".kext"),
          optionsForFile: () => ({
            entitlements: "/fixture/electron.plist",
            hardenedRuntime: true,
            timestamp: "https://unused.invalid",
          }),
        },
        { appInfo: { id: APP_IDS.dev }, projectDir: f.directory },
        {
          ...f,
          environment: {},
          signAsync: async (options) => {
            expect(f.calls.filter((call) => call.includes("--sign")).length).toBe(1)
            expect(options.keychain).toBeUndefined()
            expect(typeof options.ignore === "function" && options.ignore(f.helper)).toBe(true)
            expect(typeof options.ignore === "function" && options.ignore("/fixture/driver.kext")).toBe(true)
            expect(options.optionsForFile?.(f.app)).toEqual({
              entitlements: "/fixture/electron.plist",
              hardenedRuntime: true,
              timestamp: "none",
            })
          },
        },
      )
      expect(f.calls.filter((call) => call.includes("--sign")).length).toBe(1)
      expect(f.calls.some((call) => call[0] === "--verify" && call.includes("--deep") && call.at(-1) === f.app)).toBe(
        true,
      )
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("retries only outer signing with builder's bounded three-retry schedule", async () => {
    const f = await fixture()
    const waits: number[] = []
    const attempts: number[] = []
    try {
      await arm(f)
      await signMacWithComputerHelper(
        { app: f.app, identity: certificate },
        { appInfo: { id: APP_IDS.prod }, projectDir: f.directory },
        {
          ...f,
          environment: {},
          wait: async (delay) => {
            waits.push(delay)
          },
          signAsync: async () => {
            attempts.push(1)
            if (attempts.length < 4) throw new Error("transient signing failure")
          },
        },
      )
      expect(attempts).toHaveLength(4)
      expect(waits).toEqual([5000, 10000, 15000])
      expect(f.calls.filter((call) => call.includes("--sign")).length).toBe(1)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("refuses a second helper signature even when outer signing reports success", async () => {
    const f = await fixture()
    try {
      await arm(f)
      await expect(
        signMacWithComputerHelper(
          { app: f.app, identity: certificate },
          { appInfo: { id: APP_IDS.prod }, projectDir: f.directory },
          {
            ...f,
            environment: {},
            signAsync: async () => {
              await writeFile(f.executable, Buffer.concat([await readFile(f.executable), Buffer.from("changed")]))
            },
          },
        ),
      ).rejects.toThrow("changed the separately signed")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("certificate and team checks cover a foreign second architecture", async () => {
    const f = await fixture("prod", true)
    try {
      await arm(f)
      const run: NativeCommand = async (command, args, options) => {
        const result = await f.run(command, args, options)
        return args[0] === "--display" && args.includes("arm64")
          ? { ...result, stderr: result.stderr.replace("TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=KLMNOPQRST") }
          : result
      }
      await expect(
        signMacWithComputerHelper(
          { app: f.app, identity: certificate },
          { appInfo: { id: APP_IDS.prod }, projectDir: f.directory },
          { ...f, environment: {}, run, signAsync: async () => {} },
        ),
      ).rejects.toThrow("same signing certificate and team")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("outer deep signing is refused and retries stop after the builder's bounded allowance", async () => {
    const f = await fixture()
    const calls: number[] = []
    const waits: number[] = []
    try {
      await arm(f)
      await expect(
        signMacWithComputerHelper(
          { app: f.app, identity: certificate, optionsForFile: () => ({ additionalArguments: ["--deep"] }) },
          { appInfo: { id: APP_IDS.prod }, projectDir: f.directory },
          {
            ...f,
            environment: {},
            wait: async (milliseconds) => {
              waits.push(milliseconds)
            },
            signAsync: async (options) => {
              calls.push(1)
              options.optionsForFile?.(f.app)
            },
          },
        ),
      ).rejects.toThrow("must not recursively re-sign")
      expect(calls).toHaveLength(4)
      expect(waits).toEqual([5000, 10000, 15000])
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("refuses unknown app identity, missing selected identity and release skips", async () => {
    const f = await fixture()
    try {
      await expect(
        signMacWithComputerHelper(
          { app: f.app, identity: "-" },
          { appInfo: { id: "unknown" }, projectDir: f.directory },
          f,
        ),
      ).rejects.toThrow("unknown Vector channel")
      await expect(
        signMacWithComputerHelper({ app: f.app }, { appInfo: { id: APP_IDS.prod }, projectDir: f.directory }, f),
      ).rejects.toThrow("was not selected")
      await expect(
        signMacWithComputerHelper(
          { app: f.app, identity: "-" },
          { appInfo: { id: APP_IDS.prod }, projectDir: f.directory },
          { ...f, environment: { VECTOR_COMPUTER_HELPER: "skip" } },
        ),
      ).rejects.toThrow("explicit dev")
      expect(f.calls).toEqual([])
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("captures the actual pre-sign measurement and rewrites final hashes before the outer seal", async () => {
    const f = await fixture()
    try {
      await arm(f)
      await signComputerHelperMac({ app: f.app, channel: f.channel, identity: certificate }, f)
      await writeFile(f.executable, Buffer.concat([await readFile(f.executable), Buffer.from("signed")]))
      const receipt = await finalizeComputerHelperMacSigning(
        {
          app: f.app,
          channel: f.channel,
          signing: "developer-id",
        },
        f,
      )
      const final = await readFile(path.join(f.app, "Contents/Resources/computer-helper.json"))
      expect(receipt.sourceManifest).toEqual(f.sourceManifest)
      expect(receipt.sourceCdhash).toEqual({ x64: "b".repeat(40) })
      expect(receipt.finalManifestSha256).toBe(sha256(final))
      expect(receipt.finalExecutableSha256).toBe(sha256(await readFile(f.executable)))
      expect(JSON.parse(final.toString("utf8")).sourceDigest).toBe(f.sourceManifest.sourceDigest)
      expect(
        JSON.parse(await readFile(path.join(f.app, "Contents/Resources/computer-helper-signing.json"), "utf8")),
      ).toEqual(receipt)
      await expect(
        finalizeComputerHelperMacSigning({ app: f.app, channel: f.channel, signing: "developer-id" }),
      ).rejects.toThrow("baseline is missing")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("signing cannot silently replace copied resources or change the helper file list", async () => {
    for (const added of [false, true]) {
      const f = await fixture()
      try {
        await arm(f)
        if (added) await writeFile(path.join(f.helper, "Contents/extra.txt"), "unexpected")
        else
          await writeFile(
            path.join(f.helper, "Contents/Info.plist"),
            (await readFile(path.join(f.helper, "Contents/Info.plist"), "utf8")) + "\n",
          )
        await expect(
          finalizeComputerHelperMacSigning({ app: f.app, channel: f.channel, signing: "adhoc" }, f),
        ).rejects.toThrow(added ? "file list changed" : "outside its signature")
      } finally {
        await rm(f.directory, { recursive: true, force: true })
      }
    }
  })

  test("prod enforces measured cdhash while other channels still require the measured version and toolchain", async () => {
    for (const channel of ["prod", "beta", "dev"] as const) {
      const f = await fixture(channel)
      try {
        const lockFile = path.join(f.directory, "native/computer-helper/macos/identity.lock.json")
        const lock = JSON.parse(await readFile(lockFile, "utf8"))
        await writeFile(lockFile, JSON.stringify({ ...lock, cdhash: { x64: "c".repeat(40), arm64: "c".repeat(40) } }))
        if (channel === "prod") await expect(arm(f)).rejects.toThrow("measured identity lock")
        else await arm(f)
      } finally {
        await rm(f.directory, { recursive: true, force: true })
      }
      const other = await fixture(channel)
      try {
        const lockFile = path.join(other.directory, "native/computer-helper/macos/identity.lock.json")
        const lock = JSON.parse(await readFile(lockFile, "utf8"))
        await writeFile(lockFile, JSON.stringify({ ...lock, helperVersion: "different" }))
        await expect(arm(other)).rejects.toThrow("enforced identity lock")
      } finally {
        await rm(other.directory, { recursive: true, force: true })
      }
    }
  })

  test("unsigned universal temporary afterPack calls do not sign; the final fuse target signs exactly once", async () => {
    const f = await fixture()
    const signed: string[] = []
    const fused: unknown[] = []
    try {
      await arm(f)
      type Context = {
        appOutDir: string
        electronPlatformName: string
        packager: { appInfo: { productFilename: string } }
      }
      const packager = {
        appInfo: { productFilename: path.basename(f.app).slice(0, -4) },
        async addElectronFuses(context: Context, config: { resetAdHocDarwinSignature?: boolean }): Promise<number> {
          expect(this).toBe(packager)
          fused.push(context, config, f.calls.length)
          return 9
        },
      }
      const input = {
        channel: f.channel,
        signUnsignedMac: async (app: string) => {
          signed.push(app)
          return signUnsignedMacWithComputerHelper({ app, channel: f.channel }, f)
        },
      }
      // afterPack installs the hook for x64-temp, arm64-temp and final-universal contexts.
      for (const _target of ["x64-temp", "arm64-temp", "universal"])
        await installUnsignedMacComputerHelperFuses(packager, input, f)
      expect(signed).toEqual([])
      expect(fused).toEqual([])
      const context = { appOutDir: path.dirname(f.app), electronPlatformName: "darwin", packager }
      const config = { resetAdHocDarwinSignature: true }
      expect(await packager.addElectronFuses(context, config)).toBe(9)
      expect(signed).toEqual([f.app])
      expect(fused.slice(0, 2)).toEqual([context, config])
      expect(
        f.calls
          .filter((call) => call.includes("--sign"))
          .map((call) => ({ app: call.at(-1), deep: call.includes("--deep") })),
      ).toEqual([
        { app: f.app, deep: true },
        { app: f.helper, deep: false },
        { app: f.app, deep: false },
      ])
      const after = f.calls.slice(fused[2] as number)
      expect(
        after.some(
          (call) => call[0] === "--verify" && call.includes("--all-architectures") && call.at(-1) === f.helper,
        ),
      ).toBe(true)
      expect(after.at(-1)).toEqual(["--verify", "--deep", "--strict", f.app])
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("post-fuse checks refuse changed CodeResources even with unchanged executable and cdhash", async () => {
    const f = await fixture()
    try {
      const resource = path.join(f.helper, "Contents/_CodeSignature/CodeResources")
      await mkdir(path.dirname(resource), { recursive: true })
      await writeFile(resource, "before-fuses")
      f.sourceManifest.files["VectorComputer.app/Contents/_CodeSignature/CodeResources"] = {
        sha256: sha256(await readFile(resource)),
        arch: [],
      }
      await writeFile(path.join(f.app, "Contents/Resources/computer-helper.json"), JSON.stringify(f.sourceManifest))
      await arm(f)
      type Context = {
        appOutDir: string
        electronPlatformName: string
        packager: { appInfo: { productFilename: string } }
      }
      const packager = {
        appInfo: { productFilename: path.basename(f.app).slice(0, -4) },
        async addElectronFuses(_context: Context, _config: { resetAdHocDarwinSignature?: boolean }): Promise<number> {
          await writeFile(resource, "after-fuses")
          return 1
        },
      }
      await installUnsignedMacComputerHelperFuses(
        packager,
        {
          channel: f.channel,
          signUnsignedMac: (app) => signUnsignedMacWithComputerHelper({ app, channel: f.channel }, f),
        },
        f,
      )
      await expect(
        packager.addElectronFuses(
          { appOutDir: path.dirname(f.app), electronPlatformName: "darwin", packager },
          { resetAdHocDarwinSignature: true },
        ),
      ).rejects.toThrow("including its signature resources")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  test("unsigned signing refuses a missing baseline before effects and rejects a changed fuse API", async () => {
    const f = await fixture()
    try {
      await expect(signUnsignedMacWithComputerHelper({ app: f.app, channel: f.channel }, f)).rejects.toThrow(
        "baseline is missing",
      )
      expect(f.calls).toEqual([])
      await expect(
        installUnsignedMacComputerHelperFuses(
          { addElectronFuses: async () => 1 },
          { channel: f.channel, signUnsignedMac: async () => undefined },
          f,
        ),
      ).rejects.toThrow("pinned builder fuse hook")
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
})

test.skipIf(process.platform !== "darwin" || !process.env.VECTOR_TEST_CODESIGN_IDENTITY)(
  "native certificate signing preserves the helper's own signature and entitlements",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-helper-native-sign-"))
    const app = path.join(directory, "Fixture.app")
    const helper = path.join(app, "Contents/Helpers/VectorComputer.app")
    try {
      for (const [bundle, identifier, executable] of [
        [app, APP_IDS.dev, "Fixture"],
        [helper, Hands.helperBundleId(APP_IDS.dev), "VectorComputer"],
      ]) {
        await mkdir(path.join(bundle!, "Contents/MacOS"), { recursive: true })
        await cp("/usr/bin/true", path.join(bundle!, "Contents/MacOS", executable!))
        await writeFile(
          path.join(bundle!, "Contents/Info.plist"),
          `<plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`,
        )
      }
      const sourceDirectory = path.resolve(import.meta.dirname, "..")
      await signComputerHelperMac({ app, channel: "dev", identity: "-" })
      const lock = JSON.parse(
        await readFile(path.join(sourceDirectory, "native/computer-helper/macos/identity.lock.json"), "utf8"),
      )
      const sourceManifest: HelperManifest = {
        helperVersion: lock.helperVersion,
        protocol: { min: 1, max: 1 },
        platform: "darwin",
        sourceDigest: lock.sourceDigest,
        toolchain: lock.toolchain,
        files: {},
      }
      for (const relative of [
        "Contents/MacOS/VectorComputer",
        "Contents/Info.plist",
        "Contents/_CodeSignature/CodeResources",
      ])
        sourceManifest.files[`VectorComputer.app/${relative}`] = {
          sha256: sha256(await readFile(path.join(helper, relative))),
          arch: relative.endsWith("/VectorComputer")
            ? (binaryArchitectures(await readFile(path.join(helper, relative))) as ("x64" | "arm64")[])
            : [],
        }
      await mkdir(path.join(app, "Contents/Resources"), { recursive: true })
      await writeFile(path.join(app, "Contents/Resources/computer-helper.json"), JSON.stringify(sourceManifest))
      await prepareComputerHelperMacSigning({ app, channel: "dev", sourceManifest })
      await signMacWithComputerHelper(
        {
          app,
          identity: process.env.VECTOR_TEST_CODESIGN_IDENTITY!,
          keychain: process.env.VECTOR_TEST_CODESIGN_KEYCHAIN,
          platform: "darwin",
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          identityValidation: false,
          optionsForFile: () => ({
            entitlements: path.join(sourceDirectory, "resources/entitlements.plist"),
            hardenedRuntime: true,
          }),
        },
        { appInfo: { id: APP_IDS.dev }, projectDir: sourceDirectory },
        { environment: {} },
      )
      await verifyComputerHelperMacSignature({
        app,
        channel: "dev",
        identity: process.env.VECTOR_TEST_CODESIGN_IDENTITY!,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
