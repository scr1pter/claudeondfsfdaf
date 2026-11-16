import { describe, expect, test } from "bun:test"
import {
  computerOverlayStagePaths,
  COMPUTER_OVERLAY_STAGE_BUNDLES,
  parseComputerOverlayBootstrapUnavailable,
  parseComputerOverlayStage,
} from "./computer-overlay-smoke-stage"
import type { HelperManifest } from "./build-computer-helper"

const source = "a".repeat(64)
const identity = { helperVersion: "1.0.10", protocol: { min: 1, max: 1 } }
const input = { platform: "win32" as const, architecture: "x64" as const, sourceDigest: source, identity }
function manifest(platform: "darwin" | "win32" = "win32"): HelperManifest {
  const paths = computerOverlayStagePaths(platform)
  return {
    ...identity,
    platform,
    sourceDigest: source,
    toolchain: "measured-test-toolchain",
    files: Object.fromEntries(
      [paths.driver, paths.electron, paths.defaultApp, ...COMPUTER_OVERLAY_STAGE_BUNDLES].map((name) => [
        name,
        { sha256: "b".repeat(64), arch: ["x64"] },
      ]),
    ),
  }
}
function line(value: unknown) {
  return Buffer.from(JSON.stringify(value) + "\n")
}
const unavailable = {
  id: 1,
  protocol: 1,
  check: "native-os-stop",
  ok: false,
  skipped: true,
  reason: "medium_token_unavailable",
}

describe("separate source-bound computer overlay artifacts", () => {
  test("requires all finite native runtime and bundle artifacts on each actual platform", () => {
    expect(parseComputerOverlayStage(manifest(), input)).toEqual(manifest())
    expect(parseComputerOverlayStage(manifest("darwin"), { ...input, platform: "darwin" })).toEqual(manifest("darwin"))
  })
  test("rejects changed source, helper version and protocol before launch", () => {
    for (const change of [
      { sourceDigest: "c".repeat(64) },
      { helperVersion: "1.0.9" },
      { protocol: { min: 1, max: 2 } },
      { platform: "darwin" },
    ])
      expect(() => parseComputerOverlayStage({ ...manifest(), ...change }, input)).toThrow()
  })
  test("each admitted host requires the actual finite driver, Electron, default app and three bundles", () => {
    for (const name of Object.keys(manifest().files)) {
      const value = manifest()
      delete value.files[name]
      expect(() => parseComputerOverlayStage(value, input)).toThrow("required host")
    }
  })
  test("rejects incompatible host slices instead of running another architecture", () => {
    const value = manifest()
    for (const metadata of Object.values(value.files)) metadata.arch = ["arm64"]
    expect(() => parseComputerOverlayStage(value, input)).toThrow("required host")
  })
  test("does not admit arbitrary scripts, executables or a previous user profile", () => {
    for (const name of ["smoke/unreviewed.mjs", "profile/Preferences", "run.exe", "resources/unreviewed.exe"]) {
      const value = manifest()
      value.files[name] = { sha256: "b".repeat(64), arch: ["x64"] }
      expect(() => parseComputerOverlayStage(value, input)).toThrow("unexpected file")
    }
  })
  test("rejects escaping, ambiguous Windows names and malformed byte metadata", () => {
    for (const name of ["../escape", "/absolute", "electron/../escape", "electron\\escape", "electron/ELECTRON.EXE"]) {
      const value = manifest()
      value.files[name] = { sha256: "b".repeat(64), arch: ["x64"] }
      expect(() => parseComputerOverlayStage(value, input)).toThrow()
    }
    const value = manifest()
    value.files[COMPUTER_OVERLAY_STAGE_BUNDLES[0]]!.sha256 = "unmeasured"
    expect(() => parseComputerOverlayStage(value, input)).toThrow()
  })
  test("a positively unavailable medium-token bootstrap has a distinct truthful report", () => {
    expect(parseComputerOverlayBootstrapUnavailable(line(unavailable), 77)).toEqual({
      protocol: 1,
      platform: "win32",
      skipped: true,
      reason: "elevated_fixture",
    })
    expect(parseComputerOverlayBootstrapUnavailable(line(unavailable), 0)).toBeUndefined()
    expect(parseComputerOverlayBootstrapUnavailable(line(unavailable), 1)).toBeUndefined()
    expect(
      parseComputerOverlayBootstrapUnavailable(line({ ...unavailable, reason: "isolation_required" }), 77)?.reason,
    ).toBe("isolated_desktop_required")
    expect(
      parseComputerOverlayBootstrapUnavailable(line({ ...unavailable, reason: "noninteractive_desktop" }), 77)?.reason,
    ).toBe("native_target_unavailable")
  })
  test("bootstrap admission, assertions and cleanup failures can never become a prerequisite skip", () => {
    for (const reason of [
      "parent_invalid",
      "source_mismatch",
      "bootstrap_failed",
      "cleanup_failed",
      "deadline_exceeded",
      "native_failure",
    ])
      expect(parseComputerOverlayBootstrapUnavailable(line({ ...unavailable, reason }), 77)).toBeUndefined()
  })
  test("bootstrap report cannot fabricate Electron properties or contain arbitrary native detail", () => {
    for (const change of [
      { ok: true },
      { skipped: false },
      { id: 0 },
      { protocol: 2 },
      { check: "overlay-count" },
      { details: "private native content" },
      // The Stop driver's closed failure location never belongs in the launch bootstrap record.
      { stage: "files" },
      { cause: "std_exception" },
      { stage: "files", cause: "std_exception" },
    ])
      expect(parseComputerOverlayBootstrapUnavailable(line({ ...unavailable, ...change }), 77)).toBeUndefined()
  })
  test("bootstrap unavailable is exactly one finite JSON line with no trailing or truncated bytes", () => {
    const value = line(unavailable)
    for (const changed of [value.subarray(1), value.subarray(0, -1), Buffer.concat([value, value]), Buffer.alloc(8197)])
      expect(parseComputerOverlayBootstrapUnavailable(changed, 77)).toBeUndefined()
  })
})
