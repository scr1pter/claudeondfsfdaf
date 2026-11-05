import { describe, expect, test } from "bun:test"
import {
  COMPUTER_SMOKE_CHECKS,
  COMPUTER_SMOKE_MARK,
  COMPUTER_SMOKE_PHASE_MARK,
  COMPUTER_SMOKE_FAILURE_MARK,
  COMPUTER_SMOKE_PHASES,
  parseComputerSmokePhase,
  parseComputerSmokeFailure,
  computerSmokeRuntimeHint,
  type ComputerSmokeLastPhase,
  parseComputerSmokeReport,
  type ComputerSmokeReport,
} from "./computer-overlay-smoke-report"

const report = (platform: ComputerSmokeReport["platform"] = "darwin"): ComputerSmokeReport => ({
  protocol: 1,
  platform,
  electron: "42.11.4",
  checks: COMPUTER_SMOKE_CHECKS.map((name) => ({ name, ok: true })),
})
const parse = (value: unknown, options: { platform?: string; exitCode?: number; requireNative?: boolean } = {}) =>
  parseComputerSmokeReport(COMPUTER_SMOKE_MARK + JSON.stringify(value), {
    electron: "42.11.4",
    platform: options.platform ?? "darwin",
    exitCode: options.exitCode ?? 0,
    requireNative: options.requireNative,
  })

describe("fixed real Electron computer smoke reports", () => {
  test("preserves the complete catalog and exact runtime without including observed content", () => {
    const value = report()
    expect(parse(value)).toEqual(value)
    expect(COMPUTER_SMOKE_CHECKS).toHaveLength(18)
    expect(new Set(COMPUTER_SMOKE_CHECKS).size).toBe(18)
  })
  test("rejects partial, reordered, duplicate and unknown check catalogs", () => {
    for (const changed of [
      report().checks.slice(1),
      [...report().checks, report().checks[0]],
      report().checks.toReversed(),
      report().checks.map((check, index) => (index === 1 ? report().checks[0] : check)),
      report().checks.map((check, index) => (index === 0 ? { ...check, name: "private-window-title" } : check)),
    ])
      expect(() => parse({ ...report(), checks: changed })).toThrow()
  })
  test("never accepts a native assertion failure as a skip or a successful process", () => {
    const value = report()
    value.checks[16] = { name: "native-os-stop", ok: false, reason: "native_proof_invalid" }
    expect(parse(value, { exitCode: 1 }).checks[16]).toEqual(value.checks[16])
    expect(() => parse(value)).toThrow("exit disagrees")
    expect(() =>
      parse(
        { ...value, checks: value.checks.map((check) => (check.ok ? check : { ...check, skipped: true })) },
        { exitCode: 1 },
      ),
    ).toThrow()
  })
  test("missing positive native grants remain an explicit optional skip and required evidence fails", () => {
    const value = report()
    value.checks[16] = { name: "native-os-stop", ok: false, skipped: true, reason: "native_grants_unavailable" }
    expect(parse(value).checks[16]).toEqual(value.checks[16])
    expect(() => parse(value, { requireNative: true })).toThrow("Required native")
  })
  test("Windows capture non-applicability does not make its real Stop evidence impossible", () => {
    const value = report("win32")
    value.checks[17] = { name: "native-capture-exclusion", ok: false, skipped: true, reason: "not_applicable" }
    expect(parse(value, { platform: "win32", requireNative: true })).toEqual(value)
    expect(() => parse({ ...value, platform: "darwin" })).toThrow()
  })
  test("only the declared Linux compositor checks may skip as unsupported", () => {
    const value = report("linux")
    for (const index of [12, 13, 14, 15, 16, 17])
      value.checks[index] = {
        name: COMPUTER_SMOKE_CHECKS[index]!,
        ok: false,
        skipped: true,
        reason: "linux_properties_only",
      }
    expect(parse(value, { platform: "linux" })).toEqual(value)
    expect(() => parse(value, { platform: "linux", requireNative: true })).toThrow("Required native")
    value.checks[0] = { name: "overlay-count", ok: false, skipped: true, reason: "linux_properties_only" }
    expect(() => parse(value, { platform: "linux" })).toThrow("cannot hide")
  })
  test("native prerequisite skips cannot hide required window or sandbox assertions", () => {
    for (const index of [0, 1, 2, 3, 4, 7, 8, 9, 10, 11]) {
      const value = report()
      value.checks[index] = {
        name: COMPUTER_SMOKE_CHECKS[index]!,
        ok: false,
        skipped: true,
        reason: "native_target_unavailable",
      }
      expect(() => parse(value)).toThrow("cannot hide")
    }
  })
  test("rejects arbitrary native detail, raw payload fields and contradictory booleans", () => {
    for (const entry of [
      { name: "overlay-count", ok: true, skipped: true },
      { name: "overlay-count", ok: true, reason: "assertion_failed" },
      { name: "overlay-count", ok: false, reason: "private secret" },
      { name: "overlay-count", ok: true, image: "private pixels" },
      { name: "overlay-count", ok: "true" },
    ])
      expect(() => parse({ ...report(), checks: [entry, ...report().checks.slice(1)] })).toThrow()
    expect(() => parse({ ...report(), windowTitle: "private" })).toThrow()
  })
  test("a failed check must carry a fixed reason even when the child exits with failure", () => {
    const value = report()
    value.checks[0] = { name: "overlay-count", ok: false }
    expect(() => parse(value, { exitCode: 1 })).toThrow("invalid check")
  })
  test("rejects false runtime/platform/version facts and nonzero exit after complete success", () => {
    for (const change of [{ electron: "42.11.3" }, { platform: "win32" }, { protocol: 2 }, { checks: null }])
      expect(() => parse({ ...report(), ...change })).toThrow()
    expect(() => parse(report(), { exitCode: 1 })).toThrow("exit disagrees")
  })
  test("bounds and uniquely identifies the one machine-readable output line", () => {
    const line = COMPUTER_SMOKE_MARK + JSON.stringify(report())
    expect(
      parseComputerSmokeReport("irrelevant bounded runtime diagnostic\n" + line + "\n", {
        electron: "42.11.4",
        platform: "darwin",
        exitCode: 0,
      }),
    ).toEqual(report())
    for (const text of ["", line + "\n" + line, "x".repeat(65_537) + "\n" + line, COMPUTER_SMOKE_MARK + "{"])
      expect(() => parseComputerSmokeReport(text, { electron: "42.11.4", platform: "darwin", exitCode: 0 })).toThrow()
  })
})

describe("bounded closed Electron smoke diagnostics", () => {
  const receipt = (phase: string) => COMPUTER_SMOKE_PHASE_MARK + JSON.stringify({ protocol: 1, phase })
  test("tracks the actual six phases and the cleanup branch after a properties failure", () => {
    let previous: ComputerSmokeLastPhase = "none"
    for (const phase of COMPUTER_SMOKE_PHASES) previous = parseComputerSmokePhase(receipt(phase), previous)
    expect(previous).toBe("report")
    expect(parseComputerSmokePhase(receipt("cleanup"), "properties")).toBe("cleanup")
    expect(() => parseComputerSmokePhase(receipt("report"), "none")).toThrow()
    expect(() => parseComputerSmokePhase(receipt("properties"), "properties")).toThrow()
    expect(() => parseComputerSmokePhase(receipt("boot"), "ready")).toThrow()
  })
  test("phase records reject payloads, unknown phases and unbounded output", () => {
    for (const value of [
      { protocol: 2, phase: "boot" },
      { protocol: 1, phase: "private-window-title" },
      { protocol: 1, phase: "boot", cookie: "private" },
      { phase: "boot" },
    ])
      expect(() => parseComputerSmokePhase(COMPUTER_SMOKE_PHASE_MARK + JSON.stringify(value))).toThrow()
    expect(() => parseComputerSmokePhase(receipt("boot") + " ".repeat(161))).toThrow()
    expect(() => parseComputerSmokePhase(COMPUTER_SMOKE_PHASE_MARK + "{")).toThrow()
  })
  test("runtime stderr is classified into fixed hints without returning any raw field", () => {
    for (const [text, hint] of [
      ["Authorization required, but no authorization protocol specified\n/private/xauthority-cookie", "display_auth"],
      ["Missing X server or $DISPLAY: private-display-value", "display_unavailable"],
      ["The platform failed to initialize. Exiting.", "display_unavailable"],
      ["No usable sandbox! private-runtime-path", "sandbox_unavailable"],
      ["Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/fixture/main.mjs'", "loader_failed"],
      ["ordinary unrelated runtime message /private/path", "none"],
    ])
      expect(computerSmokeRuntimeHint(text!)).toBe(hint)
    expect(
      computerSmokeRuntimeHint("Authorization required, but no authorization protocol specified" + " ".repeat(8193)),
    ).toBe("none")
  })
  test("failure receipts admit only fixed causes, last phases and hints", () => {
    const value = { protocol: 1, cause: "deadline_exceeded", phase: "none", hint: "display_auth" }
    expect(parseComputerSmokeFailure(COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify(value))).toEqual(value)
    for (const patch of [
      { cause: "private error text" },
      { phase: "private-window" },
      { hint: "private-cookie" },
      { details: "private text" },
      { protocol: 2 },
    ])
      expect(() =>
        parseComputerSmokeFailure(COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify({ ...value, ...patch })),
      ).toThrow()
  })
  test("progress and runtime hints never substitute for the actual assertion report", () => {
    const phases = COMPUTER_SMOKE_PHASES.map(receipt).join("\n")
    expect(() => parseComputerSmokeReport(phases, { electron: "42.11.4", platform: "linux", exitCode: 0 })).toThrow(
      "exactly one",
    )
    expect(
      parseComputerSmokeReport(phases + "\n" + COMPUTER_SMOKE_MARK + JSON.stringify(report()), {
        electron: "42.11.4",
        platform: "darwin",
        exitCode: 0,
      }),
    ).toEqual(report())
  })
})
