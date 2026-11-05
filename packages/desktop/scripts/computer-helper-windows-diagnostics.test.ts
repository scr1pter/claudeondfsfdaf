import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  WINDOWS_CALLER_STAGES,
  WINDOWS_UNIT_FAILURE_LABELS,
  WINDOWS_UNIT_SUITES,
  WindowsCheckFailure,
  WindowsDiagnosticReader,
  windowsCommandReason,
  windowsDiagnostic,
} from "./computer-helper-windows-diagnostics"

const bytes = (value: string) => Buffer.from(value)

test("Windows unit catalog binds existing fixed native suite and failure labels", async () => {
  const main = await readFile(new URL("../native/computer-helper/windows/tests/main.cpp", import.meta.url), "utf8")
  const integration = await readFile(new URL("../native/computer-helper/windows/tests/integration_tests.cpp", import.meta.url), "utf8")
  expect([...main.matchAll(/run_check\("([a-z0-9-]+)"/g)].map(match => match[1])).toEqual([...WINDOWS_UNIT_SUITES])
  const labels = [...new Set([...(main + "\n" + integration).matchAll(/"([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)"/g)].map(match => match[1]!))].toSorted()
  expect(labels).toEqual([...WINDOWS_UNIT_FAILURE_LABELS])
  const caller = await readFile(new URL("../native/computer-helper/windows/tests/caller.cpp", import.meta.url), "utf8")
  const stages = [...caller.matchAll(/stage = "([a-z-]+)"/g)].map(match => match[1]!)
  const exits = [...caller.matchAll(/"((?:bootstrap|helper)-child-exit-[a-z-]+)"/g)].map(match => match[1]!)
  expect([...new Set([...stages, ...exits])].toSorted()).toEqual([...WINDOWS_CALLER_STAGES].toSorted())
  const forwarded = integration.match(/constexpr std::array<std::string_view, 39> stages\{([^;]+)\};/s)?.[1] ?? ""
  expect([...forwarded.matchAll(/"([a-z-]+)"/g)].map(match => match[1])).toEqual([...WINDOWS_CALLER_STAGES])
})

test("split lines preserve only exact unit failure and Caller stage, with the first cause retained", () => {
  const reader = new WindowsDiagnosticReader("unit")
  for (const chunk of ["PASS identity-and-", "blocklist\r\nPASS server\nPASS unknown-secret\n"]) reader.consume(bytes(chunk), "stdout")
  for (const chunk of ["private /owner/secret\nFAIL integration.reply-", "pipe\nvector-caller-failure medium.layout\nvector-caller-failure initial.child-exit\n"]) reader.consume(bytes(chunk), "stderr")
  expect(reader.finish()).toEqual({unitSuite: "server", unitFailure: "integration.reply-pipe", caller: "medium.layout"})
  expect(windowsCommandReason({code: 1, diagnostic: {windows: reader.finish()}}, "probe")).toBe("windows-caller-medium.layout")
})

test("unknown fields, incomplete lines, overlong lines and output past the bound never serialize", () => {
  const reader = new WindowsDiagnosticReader("caller")
  reader.consume(bytes("x".repeat(193) + "vector-caller-failure initial.layout\nvector-caller-failure initial.private-secret\nFAIL integration.reply-pipe\nvector-caller-failure medium.layout"), "stderr")
  expect(reader.finish()).toEqual({})
  const bounded = new WindowsDiagnosticReader("caller")
  bounded.consume(bytes("x".repeat(65_536) + "\nvector-caller-failure initial.layout\n"), "stderr")
  expect(bounded.finish()).toEqual({})
  for (const value of [{caller: "initial.secret"}, {unitFailure: "integration.owner-secret"}, {unitSuite: "owner-secret"}, {caller: "medium.layout", path: "/owner"}])
    expect(() => windowsDiagnostic(value)).toThrow()
  for (const reason of ["private-secret", "windows-caller-medium.secret", "windows-probe-exit-999", "windows-probe-exit-001"])
    expect(() => new WindowsCheckFailure(reason)).toThrow()
})

test("command outcome categories retain finite exit and bound failures without a pass conversion", () => {
  expect(windowsCommandReason({code: 1}, "probe")).toBe("windows-probe-exit-1")
  expect(windowsCommandReason({code: 3221225477}, "probe")).toBe("windows-probe-exit-unknown")
  expect(windowsCommandReason({code: 0, timedOut: true}, "channel")).toBe("windows-channel-deadline")
  expect(() => { new WindowsCheckFailure("windows-probe-invalid-responsible") }).not.toThrow()
  const reader = new WindowsDiagnosticReader("caller")
  reader.consume(bytes("vector-caller-failure initial.layout-helper-ancestors\n"), "stderr")
  expect(reader.finish()).toEqual({caller: "initial.layout-helper-ancestors"})
})

test("bootstrap/helper exits and fixed helper messages retain the primary child cause only", () => {
  const overflow = new WindowsDiagnosticReader("caller")
  overflow.consume(bytes("vector-caller-failure initial.helper-child-exit-stack-overflow\nprivate-stack-content\n"), "stderr")
  expect(overflow.finish()).toEqual({caller: "initial.helper-child-exit-stack-overflow"})
  for (const stage of WINDOWS_CALLER_STAGES) {
    const reader = new WindowsDiagnosticReader("caller")
    reader.consume(bytes(`vector-caller-failure medium.${stage}\nvector-caller-failure initial.bootstrap-child-exit-failure\n`), "stderr")
    expect(reader.finish().caller).toBe(`medium.${stage}`)
    expect(new WindowsCheckFailure(windowsCommandReason({code: 1, diagnostic: {windows: reader.finish()}}, "probe")).reason).toBe(`windows-caller-medium.${stage}`)
  }
  const helper = new WindowsDiagnosticReader("unit")
  helper.consume(bytes("The computer helper could not start safely.\nvector-caller-failure initial.helper-child-exit-failure\nThe helper process token could not be read.\n"), "stderr")
  expect(helper.finish()).toEqual({helper: "safe-start", caller: "initial.helper-child-exit-failure"})
  expect(windowsCommandReason({code: 1, diagnostic: {windows: helper.finish()}}, "probe")).toBe("windows-caller-initial.helper-child-exit-failure.helper-safe-start")
  expect(new WindowsCheckFailure("windows-caller-initial.helper-child-exit-failure.helper-safe-start").reason).toBe("windows-caller-initial.helper-child-exit-failure.helper-safe-start")
  const token = new WindowsDiagnosticReader("caller")
  token.consume(bytes("The helper process token could not be read.\ntoken.step.private-secret\n"), "stderr")
  expect(windowsCommandReason({code: 1, diagnostic: {windows: token.finish()}}, "probe")).toBe("windows-helper-token-read")
  expect(() => windowsDiagnostic({helper: "private-secret"})).toThrow()
  expect(() => new WindowsCheckFailure("windows-caller-initial.helper-child-exit-failure.helper-private-secret")).toThrow()
})
