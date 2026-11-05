import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runNativeCommand, swiftArguments } from "./build-computer-helper"
import { generateIdentitySources } from "./computer-helper-identity"

const directory = fileURLToPath(new URL("../", import.meta.url))
const knownSuites = new Set([
  "runCommandLineTests",
  "runProtocolTests",
  "runServerTests",
  "runLifecycleTests",
  "runPackagedSelfTestTests",
  "runPrivilegedSelfTestTests",
  "runOverlayDriverPolicyTests",
  "runBlocklistTests",
  "runPermissionsTests",
  "runGeometryTests",
  "runCaptureTests",
  "runAccessibilityRegistryTests",
  "runAccessibilityTests",
  "runAccessibilityTextTests",
  "runMenuSafetyTests",
  "runHeldInputTests",
  "runInputTests",
  "runInputKeySafetyTests",
  "runHostOwnershipTests",
  "runProgramLaunchRegistryTests",
  "runAppsTests",
  "runClipboardTests",
  "runEventTapTests",
  "runWatchdogTests",
])
const marker = "vector-unit-diagnostic"

/** Follow the checkout's actual aggregate, without accepting arbitrary Swift expressions or CLI selections. */
export function diagnosticSuites(main: string) {
  if (Buffer.byteLength(main) > 65_536) throw new Error("The native unit aggregate is too large.")
  const calls = [...main.matchAll(/^\s*(?:_\s*=\s*)?try\s+(run[A-Za-z0-9]+Tests)\(\)\s*$/gm)].map((match) => match[1]!)
  const mentions = [...main.matchAll(/\brun[A-Za-z0-9]+Tests\s*\(/g)]
  if (
    !calls.length ||
    calls.length !== mentions.length ||
    new Set(calls).size !== calls.length ||
    calls.some((name) => !knownSuites.has(name))
  )
    throw new Error("The native unit aggregate contains an unknown or ambiguous suite.")
  return calls
}

/** No test source is rewritten. Only known synthetic assertion types may disclose bounded fixture messages. */
export function unitDiagnosticMain(main: string) {
  const suites = diagnosticSuites(main)
  const documentProbe = suites.includes("runAccessibilityTests")
    ? `    let documentRefusals = ["file:///virtual/a\\0b", "file:///virtual/a%00b", "file:///virtual/a?query=secret",
        "file:///virtual/a#fragment", "file://remote.example/virtual/a", "https://example.test/a"]
    for (index, fixture) in documentRefusals.enumerated() {
        if AccessibilityNative.documentURL(fixture as CFString) != nil {
            diagnosticWrite("${marker} FAIL runAccessibilityTests document-refusal-case-\\(index + 1)")
        }
    }
`
    : ""
  return `import Foundation
import Darwin

private func diagnosticWrite(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\\n").utf8))
}

private func diagnosticReason(_ error: Error) -> String {
    let synthetic: Set<String> = ["ProtocolTestFailure", "ServerTestError", "LifecycleTestFailure",
        "PackagedSelfTestFailure", "PrivilegedSelfTestTestFailure", "BlocklistTestFailure", "PermissionTestFailure", "GeometryTestFailure",
        "CaptureTestFailure", "AccessibilityRegistryTestFailure", "AccessibilityTestFailure",
        "AccessibilityTextTestFailure", "MenuSafetyTestFailure",
        "HeldInputTestFailure", "InputTestFailure", "InputKeySafetyTestFailure",
        "HostOwnershipTestFailure", "ProgramRegistryTestFailure", "AppsTestFailure", "ClipboardTestFailure",
        "EventTapTestFailure", "WatchdogTestFailure"]
    guard synthetic.contains(String(describing: type(of: error))),
          let reason = Mirror(reflecting: error).children.first(where: {
              $0.label == "message" || $0.label == "description" || $0.label == "failed"
          })?.value as? String else { return "unexpected-error" }
    let bounded = reason.unicodeScalars.prefix(320).map { scalar -> String in
        (0x20...0x7e).contains(scalar.value) ? String(scalar) : "?"
    }.joined()
    return bounded.isEmpty ? "empty-fixture-assertion" : bounded
}

${suites
  .map(
    (suite) => `diagnosticWrite("${marker} BEGIN ${suite}")
do {
${suite === "runAccessibilityTests" ? documentProbe : ""}    _ = try ${suite}()
    diagnosticWrite("${marker} PASS ${suite}")
} catch {
    diagnosticWrite("${marker} FAIL ${suite} " + diagnosticReason(error))
    exit(1)
}`,
  )
  .join("\n")}
exit(0)
`
}

/** Drop all other stdout/stderr: neither native payloads nor arbitrary error descriptions enter diagnostics. */
export function unitDiagnosticLines(output: string, suites: readonly string[]) {
  const known = new Set(suites)
  return output
    .slice(0, 65_536)
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^vector-unit-diagnostic (BEGIN|PASS|FAIL) (run[A-Za-z0-9]+Tests)(?: ([\x20-\x7e]{1,320}))?$/.exec(
        line,
      )
      return !!match && known.has(match[2]!) && (match[1] === "FAIL" ? !!match[3] : match[3] === undefined)
    })
    .slice(0, suites.length * 3 + (known.has("runAccessibilityTests") ? 6 : 0))
}

async function swiftFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) throw new Error("The native unit sources contain a symbolic link.")
        const file = path.join(root, entry.name)
        if (entry.isDirectory()) return swiftFiles(file)
        return entry.isFile() && entry.name.endsWith(".swift") && entry.name !== "main.swift" ? [file] : []
      }),
    )
  ).flat()
}

async function runUnitDiagnostics() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || process.argv.length !== 2)
    throw new Error("Unit diagnostics require a native macOS runner and take no arguments.")
  const temporary = process.env.RUNNER_TEMP
  if (!temporary || !path.isAbsolute(temporary)) throw new Error("Unit diagnostics require RUNNER_TEMP.")
  const scratch = await mkdtemp(path.join(await realpath(temporary), "vector-computer-unit-diagnostics-"))
  try {
    const native = path.join(directory, "native/computer-helper/macos")
    const aggregate = await readFile(path.join(native, "Tests/main.swift"), "utf8")
    const suites = diagnosticSuites(aggregate)
    const main = path.join(scratch, "main.swift")
    await writeFile(main, unitDiagnosticMain(aggregate))
    const generated = generateIdentitySources(path.join(scratch, "generated"), {
      identity: path.join(directory, "native/computer-helper/identity.json"),
      blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
    }).find((file) => file.endsWith("Identity.swift"))!
    const settings = { cwd: directory, env: { ...process.env, ZERO_AR_DATE: "1" }, timeoutMs: 300_000 }
    const swift = await runNativeCommand("xcrun", ["--sdk", "macosx", "swiftc", "--version"], {
      ...settings,
      timeoutMs: 10_000,
    })
    if (swift.code !== 0 || !swift.stdout.trim()) throw new Error("The native Swift compiler is unavailable.")
    const version = swift.stdout
      .split(/\r?\n/, 1)[0]!
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 256)
    process.stdout.write(`${marker} TOOLCHAIN ${version}\n`)
    const sdk = await runNativeCommand("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
      ...settings,
      timeoutMs: 10_000,
    })
    if (sdk.code !== 0 || !path.isAbsolute(sdk.stdout.trim())) throw new Error("The native SDK is unavailable.")
    const executable = path.join(scratch, "VectorComputerUnitDiagnostics")
    const sources = [
      ...(
        await Promise.all([swiftFiles(path.join(native, "Sources")), swiftFiles(path.join(native, "Tests"))])
      ).flat(),
      path.join(native, "TestOverlayDriver/Policy.swift"),
      path.join(native, "TestOverlayDriver/PolicyTests.swift"),
    ]
    const compiled = await runNativeCommand(
      "xcrun",
      swiftArguments({
        arch: process.arch === "x64" ? "x64" : "arm64",
        sources: [...sources, main],
        generated,
        output: executable,
        sourceRoot: native,
        sdk: sdk.stdout.trim(),
      }),
      settings,
    )
    if (compiled.code !== 0) {
      // Compiler diagnostics contain checkout source locations, not helper frames or OS observations.
      process.stderr.write(compiled.stderr.slice(0, 32_768))
      throw new Error("The diagnostic unit compilation failed.")
    }
    const result = await runNativeCommand(executable, [], { ...settings, timeoutMs: 30_000 })
    const lines = unitDiagnosticLines(result.stdout, suites)
    for (const line of lines) process.stdout.write(line + "\n")
    const expected = suites.flatMap((suite) => [`${marker} BEGIN ${suite}`, `${marker} PASS ${suite}`])
    const complete = lines.length === expected.length && lines.every((line, index) => line === expected[index])
    const code = Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : "other"
    process.stdout.write(`${marker} EXIT ${code}${complete ? " complete" : " incomplete"}\n`)
    return result.code === 0 && complete ? 0 : 1
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runUnitDiagnostics()
  } catch {
    process.stderr.write("Computer helper standalone unit diagnostics could not complete.\n")
    process.exitCode = 1
  }
}
