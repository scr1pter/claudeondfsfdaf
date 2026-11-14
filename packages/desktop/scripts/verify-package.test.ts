import { describe, expect, test } from "bun:test"
import {
  buildIdentityPath,
  checkComputerHelper,
  checkPackagedApp,
  checkUpdaterMetadata,
  updaterMetadataPath,
} from "./verify-package"
import type { HelperManifest } from "./build-computer-helper"
import type { ComputerHelperCheckInput } from "./verify-computer-helper"

const good = `provider: generic
url: https://example.public.blob.vercel-storage.com/releases/vector-updates
updaterCacheDirName: vector-desktop-updater
`

describe("verifying a packaged app can self-update", () => {
  test("a --dir build is rejected", () => {
    // The 1.19.96 regression: packaged, launchable, and every update check
    // failed with ENOENT on app-update.yml.
    const result = checkUpdaterMetadata({ present: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("--dir")
  })

  test("a real target with a feed is accepted", () => {
    expect(checkUpdaterMetadata({ present: true, contents: good })).toEqual({ ok: true })
  })

  test("a file without a feed url is rejected", () => {
    const result = checkUpdaterMetadata({ present: true, contents: "provider: generic\n" })
    expect(result.ok).toBe(false)
  })

  test("a non-https feed is rejected", () => {
    const result = checkUpdaterMetadata({
      present: true,
      contents: "provider: generic\nurl: http://example.com/releases\n",
    })
    expect(result.ok).toBe(false)
  })

  test("the metadata lives where electron-updater looks for it", () => {
    expect(updaterMetadataPath("/Applications/Vector.app")).toBe(
      "/Applications/Vector.app/Contents/Resources/app-update.yml",
    )
    expect(buildIdentityPath("/Applications/Vector.app")).toBe(
      "/Applications/Vector.app/Contents/Resources/vector-build.json",
    )
  })

  test("rejects the production shell around dev-compiled output", () => {
    const result = checkPackagedApp({
      bundleID: "ai.vector.app",
      version: "1.19.99",
      buildIdentity: {
        present: true,
        contents: JSON.stringify({
          schemaVersion: 1,
          channel: "dev",
          version: "1.19.99",
          requiredCliVersion: "1.17.14",
        }),
      },
      updaterMetadata: { present: true, contents: good },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("mixed-channel")
  })

  test("accepts a production package built and configured as production", () => {
    expect(
      checkPackagedApp({
        bundleID: "ai.vector.app",
        version: "1.19.99",
        buildIdentity: {
          present: true,
          contents: JSON.stringify({
            schemaVersion: 1,
            channel: "prod",
            version: "1.19.99",
            requiredCliVersion: "1.17.14",
          }),
        },
        updaterMetadata: { present: true, contents: good },
      }),
    ).toEqual({ ok: true })
  })

  test("rejects a production package pointed at the beta feed", () => {
    const result = checkPackagedApp({
      bundleID: "ai.vector.app",
      version: "1.19.99",
      buildIdentity: {
        present: true,
        contents: JSON.stringify({
          schemaVersion: 1,
          channel: "prod",
          version: "1.19.99",
          requiredCliVersion: "1.17.14",
        }),
      },
      updaterMetadata: {
        present: true,
        contents: "provider: generic\nurl: https://example.com/releases/vector-beta-updates\n",
      },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("wrong update feed")
  })

  test("allows a development package only without a release feed", () => {
    expect(
      checkPackagedApp({
        bundleID: "ai.vector.app.dev",
        version: "1.19.99",
        buildIdentity: {
          present: true,
          contents: JSON.stringify({
            schemaVersion: 1,
            channel: "dev",
            version: "1.19.99",
            requiredCliVersion: "1.17.14",
          }),
        },
        updaterMetadata: { present: false },
      }),
    ).toEqual({ ok: true })
  })
})

const helperManifest = (): HelperManifest => ({
  helperVersion: "1.0.10",
  platform: "darwin",
  protocol: { min: 1, max: 1 },
  sourceDigest: "a".repeat(64),
  toolchain: "measured-swift-toolchain",
  files: {
    "VectorComputer.app/Contents/MacOS/VectorComputer": { sha256: "b".repeat(64), arch: ["x64", "arm64"] },
  },
})
const helperSignature = (input: { id?: string; developerID?: boolean; team?: string; runtime?: boolean } = {}) =>
  [
    `Identifier=${input.id ?? "ai.vector.app.computer"}`,
    `CodeDirectory v=20500 size=512 flags=0x${input.runtime === false ? "0(none)" : "10000(runtime)"}`,
    `CDHash=${"c".repeat(40)}`,
    ...(input.developerID
      ? [
          "Authority=Developer ID Application: Vector (ABCDE12345)",
          "Authority=Developer ID Certification Authority",
          "Authority=Apple Root CA",
          `TeamIdentifier=${input.team ?? "ABCDE12345"}`,
          "Timestamp=Nov 5, 2026 at 1:00:00 PM",
        ]
      : ["Signature=adhoc", "TeamIdentifier=not set"]),
  ].join("\n")
const validHelper = (): ComputerHelperCheckInput => ({
  bundleID: "ai.vector.app",
  helperBundleID: "ai.vector.app.computer",
  helperVersion: "1.0.10",
  expectedHelperVersion: "1.0.10",
  manifest: helperManifest(),
  architectures: ["x64", "arm64"],
  signatureText: [helperSignature(), helperSignature()],
  entitlements: [{}, {}],
  expectSigning: "adhoc",
  asarStrings: [],
})

describe("packaged computer helper release facts", () => {
  test("accepts each exact channel identifier and an independently observed signature for each slice", () => {
    for (const bundleID of ["ai.vector.app", "ai.vector.app.beta", "ai.vector.app.dev"]) {
      expect(
        checkComputerHelper({
          ...validHelper(),
          bundleID,
          helperBundleID: `${bundleID}.computer`,
          signatureText: [
            helperSignature({ id: `${bundleID}.computer` }),
            helperSignature({ id: `${bundleID}.computer` }),
          ],
        }),
      ).toEqual({ ok: true })
    }
  })

  test("refuses a missing helper, another channel and Electron helper identities", () => {
    for (const helperBundleID of [
      undefined,
      "ai.vector.app.beta.computer",
      "ai.vector.app.helper",
      "ai.vector.app.helper.computer",
    ])
      expect(checkComputerHelper({ ...validHelper(), helperBundleID }).ok).toBe(false)
    expect(checkComputerHelper({ ...validHelper(), bundleID: "example.vector" }).ok).toBe(false)
    expect(checkComputerHelper({ ...validHelper(), manifest: undefined }).ok).toBe(false)
  })

  test("binds the Info version to the manifest and current source identity", () => {
    for (const changed of [
      { helperVersion: undefined },
      { helperVersion: "1.0.9" },
      { expectedHelperVersion: "1.0.11" },
    ])
      expect(checkComputerHelper({ ...validHelper(), ...changed }).ok).toBe(false)
    expect(checkComputerHelper({ ...validHelper(), manifest: { ...helperManifest(), platform: "win32" } }).ok).toBe(
      false,
    )
  })

  test("refuses missing, duplicate or mismatched universal architecture facts", () => {
    for (const architectures of [undefined, [], ["x64"], ["x64", "x64"], ["x64", "ia32"], ["x64", "arm64", "ia32"]])
      expect(checkComputerHelper({ ...validHelper(), architectures }).ok).toBe(false)
    const manifest = helperManifest()
    manifest.files["VectorComputer.app/Contents/MacOS/VectorComputer"]!.arch = ["x64"]
    expect(checkComputerHelper({ ...validHelper(), manifest }).ok).toBe(false)
    expect(checkComputerHelper({ ...validHelper(), signatureText: [helperSignature()] }).ok).toBe(false)
  })

  test("checks empty entitlements independently on every architecture", () => {
    for (const entitlements of [
      undefined,
      [{}],
      [{}, { "com.apple.security.cs.allow-jit": true }],
      [null, {}],
      [[], {}],
    ])
      expect(checkComputerHelper({ ...validHelper(), entitlements }).ok).toBe(false)
  })

  test("refuses a wrong signature identifier, missing runtime and a signing-kind mismatch", () => {
    for (const signature of [
      helperSignature({ id: "ai.vector.app.helper" }),
      helperSignature({ runtime: false }),
      helperSignature({ developerID: true }),
      "not a code signature",
    ])
      expect(checkComputerHelper({ ...validHelper(), signatureText: [helperSignature(), signature] }).ok).toBe(false)
  })

  test("Developer ID requires the observed desktop team and secure timestamp on both slices", () => {
    const signed = {
      ...validHelper(),
      expectSigning: "developer-id" as const,
      appTeamID: "ABCDE12345",
      signatureText: [helperSignature({ developerID: true }), helperSignature({ developerID: true })],
    }
    expect(checkComputerHelper(signed)).toEqual({ ok: true })
    for (const appTeamID of [undefined, "OTHER12345", "not set"])
      expect(checkComputerHelper({ ...signed, appTeamID }).ok).toBe(false)
    expect(
      checkComputerHelper({
        ...signed,
        signatureText: [signed.signatureText[0]!, helperSignature({ developerID: true, team: "OTHER12345" })],
      }).ok,
    ).toBe(false)
    expect(
      checkComputerHelper({
        ...signed,
        signatureText: [signed.signatureText[0]!, signed.signatureText[1]!.replace(/\nTimestamp=.+/, "")],
      }).ok,
    ).toBe(false)
  })

  test("release channels require an archive audit and reject fake-helper or test-fixture bytes", () => {
    for (const bundleID of ["ai.vector.app", "ai.vector.app.beta"]) {
      const input = {
        ...validHelper(),
        bundleID,
        helperBundleID: `${bundleID}.computer`,
        signatureText: [
          helperSignature({ id: `${bundleID}.computer` }),
          helperSignature({ id: `${bundleID}.computer` }),
        ],
      }
      for (const asarStrings of [undefined, ["const command = VECTOR_COMPUTER_HELPER_COMMAND"], ["__vectorE2E"]])
        expect(checkComputerHelper({ ...input, asarStrings }).ok).toBe(false)
    }
    expect(
      checkComputerHelper({
        ...validHelper(),
        bundleID: "ai.vector.app.dev",
        helperBundleID: "ai.vector.app.dev.computer",
        signatureText: [
          helperSignature({ id: "ai.vector.app.dev.computer" }),
          helperSignature({ id: "ai.vector.app.dev.computer" }),
        ],
        asarStrings: ["VECTOR_COMPUTER_HELPER_COMMAND", "__vectorE2E"],
      }).ok,
    ).toBe(true)
  })
})
