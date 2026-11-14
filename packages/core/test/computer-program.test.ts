import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerProgram } from "../src/computer/program"
import { ComputerSensitive } from "../src/computer/sensitive"

const descriptor = {
  platform: "macos" as const,
  path: "/virtual/example.script",
  name: "Example script",
  binding: "1".repeat(64),
}
const program: Computer.ProgramLaunch = { ...descriptor, key: ComputerProgram.key(descriptor) }

test("program identities bind canonical artifact path and native handler/content binding without an app identity", () => {
  expect(ComputerProgram.valid(program)).toBe(true)
  expect(Schema.is(Computer.AppKey)(program.key)).toBe(false)
  expect(ComputerProgram.same(program, { ...program })).toBe(true)
  for (const changed of [
    { ...program, binding: "2".repeat(64) },
    { ...program, path: "/virtual/other.script" },
    { ...program, name: "Other" },
  ])
    expect(ComputerProgram.same(program, changed)).toBe(false)
  const uncanonical = { ...descriptor, path: "/virtual/../example.script" }
  expect(ComputerProgram.valid({ ...uncanonical, key: ComputerProgram.key(uncanonical) })).toBe(false)
  expect(ComputerProgram.digest(program)).toBe(ComputerSensitive.digest({ kind: "open", path: program.path }))
})

test("public program descriptors cannot expose an ephemeral native launch token", () => {
  expect(
    ComputerProgram.publicLaunch({ ...program, token: "private_native_token" } as Computer.NativeProgramLaunch),
  ).toEqual(program)
  expect(() =>
    Schema.decodeUnknownSync(Computer.ProgramLaunch, { onExcessProperty: "error" })({ ...program, token: "private" }),
  ).toThrow()
})

test("the Node-only program digest matches the shared canonical step digest on both platforms", () => {
  for (const fixture of [
    { platform: "macos", path: '/virtual/A quoted "name" and 😀.script' },
    { platform: "windows", path: "C:\\virtual\\A script with spaces.cmd" },
    { platform: "windows", path: "\\\\server\\share\\A script.cmd" },
  ] as const) {
    const value = { ...descriptor, ...fixture }
    const program = { ...value, key: ComputerProgram.key(value) }
    expect(ComputerProgram.valid(program)).toBe(true)
    expect(ComputerProgram.digest(program)).toBe(ComputerSensitive.digest({ path: fixture.path, kind: "open" }))
  }
})

test("a ProgramKey can authorize only its exact run_program ask and never an app access ask", () => {
  const ask = {
    action: "open",
    why: "run_program",
    path: program.path,
    program,
    target: { appKey: program.key, appName: program.name },
    stepDigest: ComputerProgram.digest(program),
    stepIndex: 0,
  }
  expect(Schema.is(Computer.SensitiveAskMetadata)(ask)).toBe(true)
  expect(Schema.is(Computer.SensitiveAskMetadata)({ ...ask, why: "send" })).toBe(false)
  expect(Schema.is(Computer.SensitiveAskMetadata)({ ...ask, action: "click" })).toBe(false)
  expect(Schema.is(Computer.SensitiveAskMetadata)({ ...ask, path: "/virtual/other.script" })).toBe(false)
  expect(Schema.is(Computer.SensitiveAskMetadata)({ ...ask, program: undefined })).toBe(false)
  expect(
    Schema.is(Computer.AppAskMetadata)({
      action: "use_app",
      level: "interact",
      canAlways: false,
      target: { appKey: program.key, appName: program.name, platform: "macos", category: "general", verified: false },
    }),
  ).toBe(false)
})
