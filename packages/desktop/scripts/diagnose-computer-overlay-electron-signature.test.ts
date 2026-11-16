import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  parseElectronSignatureProbeOptions,
  probeComputerOverlayElectronSignatures,
} from "./diagnose-computer-overlay-electron-signature"

const profile = readFileSync(new URL("../resources/entitlements.plist", import.meta.url), "utf8")

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vector-electron-signature-test-")))
  const electron = path.join(root, "node_modules/electron")
  const app = path.join(electron, "dist/Electron.app")
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "42.11.4" } }))
  await writeFile(path.join(electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.4" }))
  await writeFile(path.join(electron, "path.txt"), "Electron.app/Contents/MacOS/Electron\n")
  await writeFile(path.join(app, "Contents/MacOS/Electron"), "controlled Electron bytes")
  await writeFile(
    path.join(app, "Contents/Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>com.github.Electron</string><key>CFBundleShortVersionString</key><string>42.11.4</string></dict></plist>",
  )
  await mkdir(path.join(root, "resources"))
  await writeFile(path.join(root, "resources/entitlements.plist"), profile)
  await mkdir(path.join(app, "Contents/Frameworks/Electron Helper.app/Contents/MacOS"), { recursive: true })
  await writeFile(
    path.join(app, "Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"),
    "controlled nested bytes",
  )
  if (process.platform !== "win32") await symlink("MacOS/Electron", path.join(app, "Contents/relative-link"))
  return { root, electron, app }
}

test("the probe contrasts exact source/copy signatures, preserves copy bytes/relative links and cleans its owned copy", async () => {
  const f = await fixture(),
    output: string[] = [],
    bundles: string[] = []
  try {
    const report = await probeComputerOverlayElectronSignatures({
      directory: f.root,
      write: (message) => output.push(message),
      run: async (binary, args, settings) => {
        expect(binary).toBe("/usr/bin/codesign")
        expect(args.slice(0, 3)).toEqual(["--verify", "--strict", "--all-architectures"])
        expect(settings.cwd).toBe(f.root)
        expect(settings.timeoutMs).toBe(30_000)
        const bundle = args[3]!
        bundles.push(bundle)
        expect(await readFile(path.join(bundle, "Contents/MacOS/Electron"), "utf8")).toBe("controlled Electron bytes")
        if (process.platform !== "win32")
          expect(await readlink(path.join(bundle, "Contents/relative-link"))).toBe("MacOS/Electron")
        return bundles.length === 1
          ? { code: 0, stdout: "successful output stays closed", stderr: "" }
          : { code: 1, stdout: "", stderr: `HEAD${"é".repeat(10000)}TAIL` }
      },
    })
    expect(report).toEqual({ protocol: 1, electronVersion: "42.11.4", source: "verified", copy: "failed" })
    expect(bundles[0]).toBe(f.app)
    expect(bundles[1]!.startsWith(f.electron)).toBe(false)
    expect(output[0]).toContain("role=source result=verified code=0")
    expect(output[1]).toContain("role=copy result=failed code=1")
    const diagnostic = output[2]!.split("role=copy\n")[1]!.split("\nelectron-signature-output-end")[0]!
    expect(diagnostic.startsWith("HEAD")).toBe(true)
    expect(diagnostic.endsWith("TAIL")).toBe(true)
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192)
    expect(diagnostic).not.toContain("�")
    expect(output.join("")).not.toContain("successful output stays closed")
    await expect(lstat(path.resolve(bundles[1]!, "../.."))).rejects.toThrow()
    expect(await readFile(path.join(f.app, "Contents/MacOS/Electron"), "utf8")).toBe("controlled Electron bytes")
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("source signature failure still permits the copy contrast and a thrown command still cleans the owned copy", async () => {
  const f = await fixture(),
    bundles: string[] = []
  const failure = new Error("Controlled command failure")
  try {
    await expect(
      probeComputerOverlayElectronSignatures({
        directory: f.root,
        write: () => {},
        run: async (_binary, args) => {
          bundles.push(args[3]!)
          if (bundles.length === 2) throw failure
          return { code: 1, stdout: "", stderr: "source invalid" }
        },
      }),
    ).rejects.toBe(failure)
    expect(bundles).toHaveLength(2)
    await expect(lstat(path.resolve(bundles[1]!, "../.."))).rejects.toThrow()
    expect((await lstat(f.app)).isDirectory()).toBe(true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("wrong Electron version or executable selection cannot invoke the diagnostic command", async () => {
  const f = await fixture()
  try {
    const run = async () => {
      throw new Error("Codesign must not be reached")
    }
    await writeFile(path.join(f.electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.3" }))
    await expect(probeComputerOverlayElectronSignatures({ directory: f.root, run })).rejects.toThrow(
      "exact pinned Electron",
    )
    await writeFile(path.join(f.electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.4" }))
    await writeFile(path.join(f.electron, "path.txt"), "other-executable\n")
    await expect(probeComputerOverlayElectronSignatures({ directory: f.root, run })).rejects.toThrow(
      "installed macOS Electron bundle",
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("the fast Mac signature probe follows pinned installation and cannot soften the required UI check", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text(),
  ) as {
    jobs: Record<string, { steps: Record<string, unknown>[] }>
  }
  const steps = workflow.jobs["computer-helper-macos-overlay"]!.steps
  const install = steps.findIndex((step) => step.name === "Install the exact pinned Electron runtime")
  const diagnostic = steps[install + 1]!
  const required = steps[install + 2]!
  expect(install).toBeGreaterThanOrEqual(0)
  expect(diagnostic.run).toBe(
    "bun --no-env-file ./scripts/diagnose-computer-overlay-electron-signature.ts --seal-owned-copy",
  )
  expect(diagnostic["continue-on-error"]).toBe(true)
  expect(diagnostic["timeout-minutes"]).toBe(4)
  expect(diagnostic.outputs).toBeUndefined()
  expect(required.run).toBe("bun --no-env-file ./scripts/computer-overlay-smoke.ts")
  expect(required["continue-on-error"]).toBeUndefined()
})

test("copy resealing is a fixed explicit opt-in without selectable paths, identities or metadata", () => {
  expect(parseElectronSignatureProbeOptions([])).toEqual({ sealOwnedCopy: false })
  expect(parseElectronSignatureProbeOptions(["--seal-owned-copy"])).toEqual({ sealOwnedCopy: true })
  for (const args of [
    ["--seal-owned-copy", "--seal-owned-copy"],
    ["--path", "/other/app"],
    ["--seal-owned-copy=false"],
  ])
    expect(() => parseElectronSignatureProbeOptions(args)).toThrow("only the fixed")
})

test.skipIf(process.platform === "win32")(
  "metadata and bounded link context precede a containment rejection without signing",
  async () => {
    const f = await fixture(),
      output: string[] = []
    try {
      const outside = path.join(f.root, "outside-bundle")
      await writeFile(outside, "controlled outside bytes")
      await symlink(outside, path.join(f.app, "Contents/absolute-link"))
      await expect(
        probeComputerOverlayElectronSignatures({
          directory: f.root,
          sealOwnedCopy: true,
          write: (message) => output.push(message),
          run: async (_binary, args) => {
            expect(args).not.toContain("--sign")
            return args.includes("--display")
              ? {
                  code: 0,
                  stdout: "",
                  stderr:
                    "Identifier=Electron\nCodeDirectory v=20500 size=400 flags=0x20002(adhoc,linker-signed) hashes=4+4 location=embedded\n",
                }
              : { code: 1, stdout: "", stderr: "original missing resource envelope" }
          },
        }),
      ).rejects.toThrow("internal relative bundle links")
      const log = output.join("")
      expect(log.indexOf("step=metadata-before")).toBeGreaterThanOrEqual(0)
      expect(log.indexOf("step=metadata-before")).toBeLessThan(log.indexOf("electron-signature-trial-link"))
      expect(log).toContain('"scope":"absolute"')
      expect(log).toContain('"role":"source"')
      expect(log).toContain('"role":"copy"')
      expect(await readFile(outside, "utf8")).toBe("controlled outside bytes")
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

test("the owned root-only seal preserves invalid baselines and requires metadata, nested/source bytes, deep verify and exact version", async () => {
  for (const mode of [
    "success",
    "known-linker-template",
    "unknown-linker-template",
    "wrong-bundle-id",
    "c4-deep-fallback",
    "c4-profile-mismatch",
    "nested-timeout",
    "nested-output-cap",
    "nested-spawn-failed",
    "unrelated-subcomponent",
    "nested-change",
    "metadata-change",
    "security-flag-add",
    "runtime-change",
    "entitlements-change",
    "source-change",
    "deep-failure",
    "version-mismatch",
  ]) {
    const f = await fixture(),
      output: string[] = []
    const state = { sealed: false, copy: "", deepCopy: "", deepSealed: false, launches: 0 }
    const template =
      mode.startsWith("nested-") ||
      mode === "unrelated-subcomponent" ||
      ["known-linker-template", "unknown-linker-template", "c4-deep-fallback", "c4-profile-mismatch"].includes(mode)
    try {
      const physicalTemp = path.join(f.root, "physical-temp")
      await mkdir(physicalTemp)
      const aliasTemp = path.join(f.root, "alias-temp")
      if (process.platform !== "win32") await symlink(physicalTemp, aliasTemp, "dir")
      const pending = probeComputerOverlayElectronSignatures({
        directory: f.root,
        temporaryDirectory: process.platform === "win32" ? physicalTemp : aliasTemp,
        sealOwnedCopy: true,
        write: (message) => output.push(message),
        run: async (binary, args) => {
          if (binary === "/usr/bin/plutil") {
            if (args.includes("-extract")) {
              expect(["CFBundleIdentifier", "CFBundleShortVersionString"]).toContain(args[1])
              expect(args.slice(2, 5)).toEqual(["raw", "-o", "-"])
              const app = path.dirname(path.dirname(args.at(-1)!))
              if (app !== state.copy) state.deepCopy = app
              expect(args.at(-1)).toBe(path.join(app, "Contents/Info.plist"))
              return {
                code: 0,
                stdout:
                  args[1] === "CFBundleShortVersionString"
                    ? "42.11.4\n"
                    : mode === "wrong-bundle-id"
                      ? "other.bundle\n"
                      : "com.github.Electron\n",
                stderr: "",
              }
            }
            expect(args.slice(0, 4)).toEqual(["-convert", "json", "-o", "-"])
            return {
              code: 0,
              stdout: JSON.stringify({
                "com.apple.security.cs.allow-jit": !(
                  mode === "c4-profile-mismatch" && args.at(-1) !== path.join(f.root, "resources/entitlements.plist")
                ),
                "com.apple.security.cs.allow-unsigned-executable-memory": true,
                "com.apple.security.cs.disable-executable-page-protection": true,
                "com.apple.security.cs.disable-library-validation": true,
                "com.apple.security.device.audio-input": true,
              }),
              stderr: "",
            }
          }
          if (binary !== "/usr/bin/codesign") {
            expect(binary).toBe(path.join(state.deepSealed ? state.deepCopy : state.copy, "Contents/MacOS/Electron"))
            expect(args).toEqual(["--version"])
            state.launches++
            return { code: 0, stdout: mode === "version-mismatch" ? "v42.11.3\n" : "v42.11.4\n", stderr: "" }
          }
          const bundle = args.at(-1)!
          if (args.includes("--display")) {
            const freshDeep = bundle !== state.copy && !state.deepSealed
            if (freshDeep) state.deepCopy = bundle
            expect(bundle).toBe(freshDeep || state.deepSealed ? state.deepCopy : state.copy)
            const flags = freshDeep
              ? "0x20002"
              : !state.sealed
                ? template
                  ? "0x20002"
                  : "0x10000"
                : template && !state.deepSealed
                  ? "0x2"
                  : mode === "metadata-change"
                    ? "0x2"
                    : mode === "security-flag-add"
                      ? "0x10102"
                      : "0x10002"
            return {
              code: 0,
              stdout: freshDeep
                ? ""
                : state.deepSealed
                  ? profile
                  : template && mode !== "unknown-linker-template"
                    ? ""
                    : state.sealed && mode === "entitlements-change"
                      ? "<plist><dict><key>changed</key><true/></dict></plist>"
                      : "<plist><dict/></plist>",
              stderr: `Identifier=${freshDeep || (template && !state.sealed) ? "Electron" : "com.github.Electron"}\nCodeDirectory v=20500 size=400 flags=${flags}(runtime) hashes=4+4 location=embedded\n${(Number.parseInt(flags, 16) & 0x10000) === 0 ? "" : `Runtime Version=${state.sealed && mode === "runtime-change" ? "16.0.0" : "15.5.0"}\n`}`,
            }
          }
          if (args.includes("--sign")) {
            if (args.includes("--deep")) {
              expect(args).toEqual([
                "--force",
                "--deep",
                "--sign",
                "-",
                "--options",
                "runtime",
                "--timestamp=none",
                "--entitlements",
                path.join(f.root, "resources/entitlements.plist"),
                bundle,
              ])
              expect(bundle).not.toBe(state.copy)
              expect(await readFile(path.join(bundle, "Contents/MacOS/Electron"), "utf8")).toBe(
                "controlled Electron bytes",
              )
              state.deepCopy = bundle
              state.deepSealed = true
              await writeFile(
                path.join(bundle, "Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"),
                "re-signed nested bytes",
              )
            } else {
              expect(args).toEqual([
                "--force",
                "--sign",
                "-",
                "--timestamp=none",
                ...(template
                  ? ["--identifier", "com.github.Electron"]
                  : ["--preserve-metadata=identifier,entitlements,flags,runtime"]),
                state.copy,
              ])
            }
            expect(bundle.startsWith(f.electron)).toBe(false)
            state.sealed = true
            await writeFile(path.join(bundle, "Contents/MacOS/Electron"), "new root signature bytes")
            await mkdir(path.join(bundle, "Contents/_CodeSignature"))
            await writeFile(path.join(bundle, "Contents/_CodeSignature/CodeResources"), "new resource envelope")
            if (mode === "nested-change" || mode === "source-change")
              await writeFile(
                path.join(
                  mode === "source-change" ? f.app : bundle,
                  "Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper",
                ),
                "unexpected changed bytes",
              )
            return { code: 0, stdout: "", stderr: "" }
          }
          if (
            state.sealed &&
            !state.deepSealed &&
            (mode.startsWith("c4-") || mode.startsWith("nested-") || mode === "unrelated-subcomponent") &&
            args.includes("--deep")
          )
            return {
              code: 1,
              stdout: "",
              stderr: `code object is not signed at all\nIn subcomponent: ${mode === "unrelated-subcomponent" ? f.root : path.join(state.copy, "Contents/Frameworks/Electron Helper.app")}\n`,
              ...(mode.startsWith("nested-")
                ? {
                    failureReason:
                      mode === "nested-timeout"
                        ? ("timed-out" as const)
                        : mode === "nested-output-cap"
                          ? ("output-cap" as const)
                          : ("spawn-failed" as const),
                  }
                : {}),
            }
          if (!state.sealed) {
            if (bundle !== f.app) state.copy = bundle
            return { code: 1, stdout: "", stderr: "original missing resource envelope" }
          }
          expect(args).toEqual(
            args.includes("--deep")
              ? [
                  "--verify",
                  "--deep",
                  "--strict",
                  "--all-architectures",
                  state.deepSealed ? state.deepCopy : state.copy,
                ]
              : ["--verify", "--strict", "--all-architectures", state.deepSealed ? state.deepCopy : state.copy],
          )
          return { code: mode === "deep-failure" && args.includes("--deep") ? 1 : 0, stdout: "", stderr: "" }
        },
      })
      if (["success", "known-linker-template", "c4-deep-fallback"].includes(mode)) {
        const report = await pending
        expect(report.source).toBe("failed")
        expect(report.copy).toBe("failed")
        expect(state.copy.startsWith(physicalTemp + path.sep)).toBe(true)
        expect(state.copy.startsWith(aliasTemp + path.sep)).toBe(false)
        if (mode === "c4-deep-fallback") {
          expect(report.trial).toMatchObject({
            mode: "c4-deep-ad-hoc",
            profileApplied: true,
            profileSha256: createHash("sha256").update(profile).digest("hex"),
            nestedBytePolicy: "re-signed-not-preserved",
            sourceBytesUnchanged: true,
            strictVerified: true,
            deepVerified: true,
            versionVerified: true,
          })
          expect(report.trial).not.toHaveProperty("nestedBytesUnchanged")
          expect(output.join("")).toContain("root-only-result=failed")
          await expect(lstat(path.resolve(state.deepCopy, "../.."))).rejects.toThrow()
        } else {
          expect(report.trial).toMatchObject({
            mode: mode === "known-linker-template" ? "fresh-linker-template-bundle" : "preserved-bundle-metadata",
            metadataPreserved: mode === "success",
            freshBundleTransitionVerified: mode === "known-linker-template",
            nestedBytesUnchanged: true,
            sourceBytesUnchanged: true,
            strictVerified: true,
            deepVerified: true,
            versionVerified: true,
          })
          expect(state.launches).toBe(1)
          expect(output.join("")).toContain(
            "result=verified version=42.11.4 baseline-unchanged=true no-release-credit=true",
          )
        }
        expect(state.launches).toBe(1)
      } else {
        await expect(pending).rejects.toThrow()
        if (mode === "unknown-linker-template") {
          expect(output.join("")).toContain(
            'step=metadata-before {"identifier":"Electron","flags":131074,"runtime":"none"',
          )
          expect(state.sealed).toBe(false)
        }
        expect(state.launches).toBe(mode === "version-mismatch" ? 1 : 0)
        expect(output.join("")).not.toContain("result=verified version=42.11.4")
        if (mode.startsWith("nested-") || mode === "unrelated-subcomponent" || mode === "deep-failure")
          expect(state.deepSealed).toBe(false)
      }
      expect(output.join("")).toContain("role=source result=failed")
      expect(output.join("")).toContain("role=copy result=failed")
      await expect(lstat(path.resolve(state.copy, "../.."))).rejects.toThrow()
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
})
