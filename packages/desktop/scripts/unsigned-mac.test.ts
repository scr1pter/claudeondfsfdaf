import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Hands } from "@vectordevai/schema/hands"
import { APP_IDS } from "./channel-ids"
import { buildNodeComputerHelperPackage, loadComputerHelperSigningNode } from "./computer-helper-package-node"
import type { HelperManifest } from "./build-computer-helper"

test.skipIf(process.platform !== "darwin")(
  "unsigned Mac signing preserves runtime entitlements and release fuses without a certificate",
  async () => {
    const values = {
      VECTOR_ALLOW_UNSIGNED_RELEASE: "true",
      VECTOR_CHANNEL: "prod",
      VECTOR_SIGN_MAC: "false",
      VECTOR_NOTARIZE: "false",
      VECTOR_SIGN_DMG: "false",
    }
    const previous = Object.fromEntries(
      [...Object.keys(values), "VECTOR_COMPUTER_HELPER_SIGN_SHA256"].map((key) => [key, process.env[key]]),
    )
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-unsigned-mac-"))
    Object.assign(process.env, values)
    try {
      const module = await import("../electron-builder.config.ts?unsigned-native-fixture")
      const packageDir = path.resolve(import.meta.dirname, "..")
      const compiled = await buildNodeComputerHelperPackage(packageDir)
      process.env.VECTOR_COMPUTER_HELPER_SIGN_SHA256 = compiled.signing.sha256
      const app = path.join(directory, "Fixture ' release.app")
      const require = createRequire(import.meta.url)
      const builder = createRequire(require.resolve("electron-builder/package.json"))
      const { PlatformPackager } = await import(builder.resolve("app-builder-lib"))
      const library = createRequire(builder.resolve("app-builder-lib/package.json"))
      const { createPackage } = await import(library.resolve("@electron/asar"))
      const { computeData } = await import(library.resolve("app-builder-lib/out/asar/integrity.js"))
      const { flipFuses, getCurrentFuseWire, FuseV1Options } = await import(library.resolve("@electron/fuses"))
      const { FuseState } = await import(library.resolve("@electron/fuses/dist/constants"))
      const run = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 10_000 })
      const copied = run([
        "/usr/bin/ditto",
        path.join(path.dirname(require.resolve("electron/package.json")), "dist/Electron.app"),
        app,
      ])
      expect(copied.exitCode, copied.stderr.toString()).toBe(0)
      const source = path.join(directory, "fixture-source")
      const resources = path.join(app, "Contents/Resources")
      const helper = path.join(app, "Contents/Helpers/VectorComputer.app")
      await mkdir(path.dirname(helper), { recursive: true })
      await cp(path.join(packageDir, "native/out/darwin/VectorComputer.app"), helper, { recursive: true })
      await cp(
        path.join(packageDir, "native/out/darwin/computer-helper.json"),
        path.join(resources, "computer-helper.json"),
      )
      const sourceManifest: HelperManifest = JSON.parse(
        await readFile(path.join(resources, "computer-helper.json"), "utf8"),
      )
      await Bun.write(
        path.join(source, "package.json"),
        JSON.stringify({ name: "vector-signature-fixture", version: "1.0.0", main: "main.cjs" }),
      )
      await Bun.write(
        path.join(source, "main.cjs"),
        `const { app } = require("electron")
app.setPath("userData", ${JSON.stringify(path.join(directory, "user-data"))})
process.stdout.write("fixture-started\\n")
app.exit(0)
`,
      )
      await createPackage(source, path.join(resources, "app.asar"))
      const metadata = run([
        "/usr/bin/plutil",
        "-replace",
        "ElectronAsarIntegrity",
        "-json",
        JSON.stringify(
          await computeData({
            resourcesPath: resources,
            resourcesRelativePath: "Resources",
            resourcesDestinationPath: resources,
          }),
        ),
        path.join(app, "Contents/Info.plist"),
      ])
      expect(metadata.exitCode, metadata.stderr.toString()).toBe(0)
      const signer = await loadComputerHelperSigningNode({ directory: packageDir, environment: process.env })
      await signer.prepareComputerHelperMacSigning(
        { app, channel: "prod", sourceManifest },
        { directory: packageDir, environment: process.env },
      )
      const packager = {
        appInfo: { productFilename: path.basename(app).slice(0, -4) },
        async addElectronFuses(
          _context: {
            appOutDir: string
            electronPlatformName: string
            packager: { appInfo: { productFilename: string } }
          },
          config: { resetAdHocDarwinSignature?: boolean },
        ) {
          return flipFuses(app, config)
        },
      }
      await signer.installUnsignedMacComputerHelperFuses(
        packager,
        { channel: "prod", signUnsignedMac: module.signUnsignedMac },
        { directory: packageDir, environment: process.env },
      )
      await packager.addElectronFuses(
        { appOutDir: directory, electronPlatformName: "darwin", packager },
        await PlatformPackager.prototype.generateFuseConfig(module.default.electronFuses),
      )
      const verified = run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
      expect(verified.exitCode, verified.stderr.toString()).toBe(0)
      const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", app])
      expect(signature.exitCode).toBe(0)
      expect(signature.stderr.toString()).toContain("Signature=adhoc")
      expect(signature.stderr.toString()).toContain("runtime")
      const helperSignature = run(["/usr/bin/codesign", "--display", "--verbose=4", helper])
      expect(helperSignature.exitCode, helperSignature.stderr.toString()).toBe(0)
      expect(helperSignature.stderr.toString()).toContain(`Identifier=${Hands.helperBundleId(APP_IDS.prod)}`)
      expect(helperSignature.stderr.toString()).toContain("Signature=adhoc")
      expect(helperSignature.stderr.toString()).toContain("runtime")
      const helperEntitlements = run(["/usr/bin/codesign", "--display", "--entitlements", ":-", "--xml", helper])
      expect(helperEntitlements.exitCode).toBe(0)
      const helperDictionary = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], {
        stdin: helperEntitlements.stdout,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(helperDictionary.exitCode, helperDictionary.stderr.toString()).toBe(0)
      expect(JSON.parse(helperDictionary.stdout.toString())).toEqual({})
      const expected = run([
        "/usr/bin/plutil",
        "-convert",
        "json",
        "-o",
        "-",
        path.join(import.meta.dir, "../resources/entitlements.plist"),
      ])
      expect(expected.exitCode).toBe(0)
      for (const bundle of [app, path.join(app, "Contents/Frameworks/Electron Helper.app")]) {
        const entitlements = run(["/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", bundle])
        expect(entitlements.exitCode).toBe(0)
        const actual = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], {
          stdin: entitlements.stdout,
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(actual.exitCode).toBe(0)
        expect(JSON.parse(actual.stdout.toString())).toEqual(JSON.parse(expected.stdout.toString()))
      }
      const fuses = await getCurrentFuseWire(app)
      expect(fuses[FuseV1Options.RunAsNode]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(FuseState.ENABLE)
      expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FuseState.ENABLE)
      expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(FuseState.DISABLE)
      const started = run([path.join(app, "Contents/MacOS/Electron")])
      expect(started.exitCode, started.stderr.toString()).toBe(0)
      expect(started.stdout.toString().trim()).toBe("fixture-started")
      const helperInfo = path.join(helper, "Contents/Info.plist")
      const infoBefore = await readFile(helperInfo)
      await writeFile(helperInfo, Buffer.concat([infoBefore, Buffer.from("\n<!-- tampered -->\n")]))
      expect(run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]).exitCode).not.toBe(0)
      await writeFile(helperInfo, infoBefore)
      expect(run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]).exitCode).toBe(0)
      await Bun.write(path.join(app, "Contents/Resources/unsigned-fixture-tamper.txt"), "tampered")
      expect(run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]).exitCode).not.toBe(0)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
  90_000,
)
