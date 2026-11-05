import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  computerHelperPackageRequests,
  macPackagePaths,
  packageEnvironment,
  packageRequest,
  requireDeveloperIdApplicationSignature,
} from "./package-desktop"

describe("desktop package request", () => {
  test("signed Mac packages require actual Developer ID Application authority and a team", () => {
    expect(() =>
      requireDeveloperIdApplicationSignature(
        "Authority=Developer ID Application: Fixture (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\n",
      ),
    ).not.toThrow()
    for (const signature of [
      "",
      "Signature=adhoc\nTeamIdentifier=not set",
      "Authority=Apple Development: Fixture\nTeamIdentifier=ABCDEFGHIJ",
      "Authority=Developer ID Application: Fixture\nTeamIdentifier=not set",
      "log Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDEFGHIJ",
      "Authority=Developer ID Application: Fixture\nSignature=adhoc\nTeamIdentifier=ABCDEFGHIJ",
    ])
      expect(() => requireDeveloperIdApplicationSignature(signature)).toThrow("actual Developer ID Application")
  })
  test("prepares exactly the helper platforms and architectures requested by electron-builder", () => {
    const host = { hostPlatform: "linux", hostArchitecture: "x64" }
    expect(computerHelperPackageRequests({ ...host, builderArgs: ["--linux", "--arm64"] })).toEqual([
      { platform: "linux", architectures: [] },
    ])
    expect(
      computerHelperPackageRequests({
        ...host,
        builderArgs: ["--mac", "dmg:arm64", "zip:arm64", "--win=nsis:x64", "--publish", "never"],
      }),
    ).toEqual([
      { platform: "darwin", architectures: ["arm64"] },
      { platform: "win32", architectures: ["x64"] },
    ])
    expect(computerHelperPackageRequests({ ...host, builderArgs: ["--mac=zip", "--universal"] })).toEqual([
      { platform: "darwin", architectures: ["x64", "arm64"] },
    ])
    expect(computerHelperPackageRequests({ ...host, builderArgs: ["--win", "--arm64", "--x64"] })).toEqual([
      { platform: "win32", architectures: ["x64", "arm64"] },
    ])
    expect(
      computerHelperPackageRequests({ hostPlatform: "darwin", hostArchitecture: "arm64", builderArgs: [] }),
    ).toEqual([{ platform: "darwin", architectures: ["arm64"] }])
    expect(() => computerHelperPackageRequests({ ...host, builderArgs: ["--win", "--universal"] })).toThrow(
      "Universal Windows",
    )
    expect(() => computerHelperPackageRequests({ ...host, builderArgs: ["--mac", "--ia32"] })).toThrow("x64 and arm64")
    expect(() => computerHelperPackageRequests({ ...host, builderArgs: ["--win=nsis:ia32"] })).toThrow(
      "supported computer helper",
    )
  })

  test("routes every package script through the release safeguard", async () => {
    const manifest: unknown = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
    expect(manifest).toBeObject()
    if (!manifest || typeof manifest !== "object" || !("scripts" in manifest)) throw new Error("Missing scripts")
    expect(manifest.scripts).toEqual(
      expect.objectContaining({
        prebuild: "bun --no-env-file ./scripts/prebuild.ts",
        build: "bun --no-env-file ./scripts/build-desktop.ts && bun --no-env-file ./scripts/verify-runtime.ts",
        package: "bun --no-env-file ./scripts/package-desktop.ts",
        "package:mac": "bun --no-env-file ./scripts/package-desktop.ts --target=mac",
        "package:win": "bun --no-env-file ./scripts/package-desktop.ts --target=win",
        "package:linux": "bun --no-env-file ./scripts/package-desktop.ts --target=linux",
      }),
    )
  })

  test("unsigned build children receive no signing or Sentry credentials and do not load dotenv", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-package-env-"))
    const environment = {
      CSC_LINK: "fixture-certificate",
      csc_key_password: "fixture-password",
      WIN_CSC_LINK: "fixture-windows-certificate",
      APPLE_ID: "fixture@example.test",
      SENTRY_AUTH_TOKEN: "fixture-token",
      VECTOR_SIGN_MAC: "true",
      VECTOR_NOTARIZE: "true",
      VECTOR_SIGN_DMG: "true",
      GITHUB_SHA: "a".repeat(40),
    }
    try {
      await Bun.write(path.join(directory, ".env.local"), "VECTOR_FIXTURE_DOTENV=must-not-load\n")
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:CSC_|WIN_CSC_|APPLE_|SENTRY_|VECTOR_|GITHUB_SHA)/i.test(name)))))",
        ],
        { cwd: directory, env: packageEnvironment(environment, true), stdout: "pipe", stderr: "pipe" },
      )
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual({
        GITHUB_SHA: environment.GITHUB_SHA,
        VECTOR_SIGN_MAC: "false",
        VECTOR_NOTARIZE: "false",
        VECTOR_SIGN_DMG: "false",
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
      })
      expect(packageEnvironment(environment, false)).toEqual(environment)
      expect(environment.CSC_LINK).toBe("fixture-certificate")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("requires an explicit release channel", () => {
    expect(() => packageRequest({ argv: ["--mac"], version: "1.99.1" })).toThrow("requires an explicit channel")
  })

  test("passes the selected channel only to the build and not electron-builder", () => {
    expect(packageRequest({ argv: ["--channel", "prod", "--mac", "dmg", "--arm64"], version: "1.99.1" })).toEqual({
      channel: "prod",
      target: undefined,
      environment: {
        VECTOR_CHANNEL: "prod",
        VECTOR_VERSION: "1.99.1",
      },
      builderArgs: ["--mac", "dmg", "--arm64"],
    })
  })

  test("adds the package-script target and preserves builder flags", () => {
    expect(
      packageRequest({
        argv: ["--target=linux", "--x64", "--publish", "never"],
        version: "1.99.1",
        environmentChannel: "beta",
      }),
    ).toEqual({
      channel: "beta",
      target: "linux",
      environment: {
        VECTOR_CHANNEL: "beta",
        VECTOR_VERSION: "1.99.1",
      },
      builderArgs: ["--linux", "--x64", "--publish", "never"],
    })
  })

  test.each(["mac", "win", "linux"])("preserves forwarded flags for the named %s package script", (target) => {
    const options = { version: "1.99.1", unsignedRelease: true }
    const flags = ["--x64", "--publish", "never"]
    expect(
      packageRequest({ ...options, argv: [`--target=${target}`, "--", "--channel=prod", ...flags] }).builderArgs,
    ).toEqual([`--${target}`, ...flags])
    expect(
      packageRequest({ ...options, argv: [`--target=${target}`, "--channel", "prod", "--", ...flags] }).builderArgs,
    ).toEqual([`--${target}`, ...flags])
  })

  test("rejects conflicting argument and environment channels", () => {
    expect(() =>
      packageRequest({ argv: ["--channel=prod", "--mac"], version: "1.99.1", environmentChannel: "dev" }),
    ).toThrow("does not match")
  })

  test("pins the bundled runtime to the desktop package version before building", async () => {
    const manifest: unknown = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
    if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
      throw new Error("Missing desktop version")
    }
    const request = packageRequest({ argv: ["--channel=prod", "--mac"], version: manifest.version })
    expect(request.environment).toEqual({
      VECTOR_CHANNEL: "prod",
      VECTOR_VERSION: manifest.version,
    })
  })

  test("forces unsigned production artifacts to remain manual downloads", () => {
    expect(
      packageRequest({
        argv: ["--target=mac", "--arm64"],
        version: "1.99.1",
        environmentChannel: "prod",
        unsignedRelease: true,
      }).builderArgs,
    ).toEqual(["--mac", "--arm64", "--publish", "never"])
    expect(() =>
      packageRequest({
        argv: ["--target=mac", "--publish", "always"],
        version: "1.99.1",
        environmentChannel: "prod",
        unsignedRelease: true,
      }),
    ).toThrow("manual-download-only")
  })

  test.each([
    ["arm64", "dist/mac-arm64/Vector.app"],
    ["x64", "dist/mac/Vector.app"],
  ])("verifies only the %s package selected by the CI invocation", (architecture, expectedPath) => {
    const request = packageRequest({
      argv: ["--", "--mac", "dmg", "zip", `--${architecture}`, "--publish", "never"],
      version: "1.99.1",
      environmentChannel: "prod",
    })
    expect(request.builderArgs).toEqual(["--mac", "dmg", "zip", `--${architecture}`, "--publish", "never"])
    expect(macPackagePaths({ ...request, hostArchitecture: "arm64" })).toEqual([expectedPath])
  })

  test("verifies both architectures only when both were requested", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "dmg", "zip", "--arm64", "--x64"],
        channel: "prod",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac/Vector.app", "dist/mac-arm64/Vector.app"])
  })

  test("supports target-specific architectures and the requested channel", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "dmg:arm64", "zip:arm64", "--x64"],
        channel: "beta",
        hostArchitecture: "x64",
      }),
    ).toEqual(["dist/mac-arm64/Vector Beta.app"])
  })

  test("defaults to the host architecture when no architecture is requested", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "--publish", "never"],
        channel: "dev",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac-arm64/Vector Dev.app"])
  })

  test("supports inline mac targets and universal builds", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac=zip", "--universal"],
        channel: "prod",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac-universal/Vector.app"])
  })
})
