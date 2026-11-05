import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { diagnosticSuites, unitDiagnosticLines, unitDiagnosticMain } from "./computer-helper-unit-diagnostics"

const aggregate = `do {
  try runCommandLineTests()
  _ = try runCaptureTests()
  _ = try runAccessibilityTests()
} catch { exit(1) }
`

describe("standalone native unit diagnostics", () => {
  test("preserves every actual aggregate suite in order without accepting arbitrary calls", async () => {
    const actual = await readFile(new URL("../native/computer-helper/macos/Tests/main.swift", import.meta.url), "utf8")
    expect(diagnosticSuites(actual).length).toBeGreaterThanOrEqual(11)
    expect(diagnosticSuites(actual).slice(-6)).toEqual([
      "runHostOwnershipTests",
      "runProgramLaunchRegistryTests",
      "runAppsTests",
      "runClipboardTests",
      "runEventTapTests",
      "runWatchdogTests",
    ])
    expect(diagnosticSuites(aggregate)).toEqual(["runCommandLineTests", "runCaptureTests", "runAccessibilityTests"])
    for (const invalid of [
      "",
      "try runOwnerCaptureTests()",
      "try runCaptureTests(unsafe())",
      "try runCaptureTests(); arbitrary()",
      "try runCaptureTests()\ntry runCaptureTests()",
      "x".repeat(65_537),
    ])
      expect(() => diagnosticSuites(invalid)).toThrow()
  })

  test("renders only existing fixed suite calls and fixture-only bounded assertion extraction", () => {
    const source = unitDiagnosticMain(aggregate)
    expect([...source.matchAll(/_ = try (run\w+Tests)\(\)/g)].map((match) => match[1])).toEqual(
      diagnosticSuites(aggregate),
    )
    expect(source).toContain("FileHandle.standardOutput.write")
    expect(source).toContain("synthetic.contains(String(describing: type(of: error)))")
    expect(source).toContain('return "unexpected-error"')
    expect(source).toContain("reason.unicodeScalars.prefix(320)")
    expect(source).not.toContain("String(describing: error)")
    expect(source).not.toContain("standardError")
    expect(source.indexOf("BEGIN runCaptureTests")).toBeLessThan(source.indexOf("_ = try runCaptureTests()"))
    expect(source.indexOf("_ = try runCaptureTests()")).toBeLessThan(source.indexOf("PASS runCaptureTests"))
    expect(source.indexOf("documentRefusals.enumerated()")).toBeLessThan(
      source.indexOf("_ = try runAccessibilityTests()"),
    )
    expect(source).toContain('"file:///virtual/a\\0b", "file:///virtual/a%00b"')
    expect(source).toContain("document-refusal-case-\\(index + 1)")
    expect(source).not.toContain("diagnosticWrite(fixture")
    expect(unitDiagnosticMain("try runCaptureTests()\n")).not.toContain("documentRefusals")
    expect(unitDiagnosticMain("try runCaptureTests()\n")).not.toContain("AccessibilityNative.documentURL")
  })

  test("registers native service suites with only their synthetic assertion types", async () => {
    const suites = [
      "runHostOwnershipTests",
      "runProgramLaunchRegistryTests",
      "runAppsTests",
      "runClipboardTests",
      "runEventTapTests",
      "runWatchdogTests",
    ]
    const source = unitDiagnosticMain(suites.map((suite) => `_ = try ${suite}()`).join("\n"))
    expect([...source.matchAll(/_ = try (run\w+Tests)\(\)/g)].map((match) => match[1])).toEqual(suites)
    const failures = await Promise.all(
      ["HostOwnership", "ProgramLaunchRegistry", "Apps", "Clipboard", "EventTap", "Watchdog"].map(async (name) => {
        const swift = await readFile(
          new URL(`../native/computer-helper/macos/Tests/${name}Tests.swift`, import.meta.url),
          "utf8",
        )
        const failure = /private\s+struct\s+([A-Za-z][A-Za-z0-9]*)\s*:\s*Error\b/.exec(swift)?.[1]
        expect(failure).toBeDefined()
        return failure!
      }),
    )
    for (const failure of failures) expect(source).toContain(`"${failure}"`)
    expect(source).not.toContain('"ServerFailure"')
    expect(source).not.toContain("String(describing: error)")
    const output = suites.flatMap((suite) => [
      `vector-unit-diagnostic BEGIN ${suite}`,
      `vector-unit-diagnostic FAIL ${suite} Synthetic fixture assertion`,
    ])
    expect(unitDiagnosticLines(output.join("\n"), suites)).toEqual(output)
    expect(
      unitDiagnosticLines(output.join("\n") + "\nvector-unit-diagnostic FAIL runOwnerAppTests private", suites),
    ).toEqual(output)
  })

  test("keeps a partial crash trail and a bounded synthetic failure while dropping other native output", () => {
    const output = [
      "private helper response",
      "vector-unit-diagnostic BEGIN runCommandLineTests",
      "vector-unit-diagnostic PASS runCommandLineTests",
      "vector-unit-diagnostic BEGIN runCaptureTests",
      "vector-unit-diagnostic FAIL runCaptureTests Expected final masked pixels",
      "vector-unit-diagnostic FAIL runCaptureTests " + "x".repeat(321),
      "vector-unit-diagnostic FAIL runCaptureTests private\u001b[0m",
      "vector-unit-diagnostic PASS runOwnerCaptureTests",
      "vector-unit-diagnostic BEGIN runCaptureTests extra",
    ].join("\n")
    expect(unitDiagnosticLines(output, diagnosticSuites(aggregate))).toEqual(output.split("\n").slice(1, 5))
    expect(unitDiagnosticLines("vector-unit-diagnostic BEGIN runCaptureTests", ["runCaptureTests"])).toEqual([
      "vector-unit-diagnostic BEGIN runCaptureTests",
    ])
    expect(
      unitDiagnosticLines("vector-unit-diagnostic BEGIN runCaptureTests\n".repeat(100), ["runCaptureTests"]),
    ).toHaveLength(3)
    const cases = Array.from(
      { length: 6 },
      (_, index) => `vector-unit-diagnostic FAIL runAccessibilityTests document-refusal-case-${index + 1}`,
    )
    expect(unitDiagnosticLines(cases.join("\n"), ["runAccessibilityTests"])).toEqual(cases)
  })
})
