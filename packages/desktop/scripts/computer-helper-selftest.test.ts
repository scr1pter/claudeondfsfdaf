import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFakeHelper, manualClock } from "../test/computer/fake-helper"
import { frameReader, type Line, type Received } from "../test/computer/transcript"
import {
  CORE_TRANSCRIPTS,
  classifySelfTestExit,
  parseSelfTestArgs,
  runComputerHelperSelfTest,
  transcriptFailureReason,
  validateCoreTranscript,
  type Command,
  type NativeChannel,
  type SelfTestDependencies,
  type SelfTestOptions,
  type VerifiedFixture,
} from "./computer-helper-selftest"

const fixtures = fileURLToPath(new URL("../test/fixtures/computer-protocol", import.meta.url))
const options: SelfTestOptions = {
  platform: "darwin",
  bin: "/virtual/VectorComputer.app/Contents/MacOS/VectorComputer",
  tests: "/virtual/tests",
  fixtures,
  privileged: "off",
}
const hello: Line[] = [{ send: { id: 1, op: "hello", protocol: { min: 1, max: 1 } }, expect: { id: 1, ok: true } }]

function fixture(input: { keyboard?: boolean; minimal?: boolean } = {}) {
  const state = {
    clock: manualClock(),
    closed: 0,
    opened: 0,
    probes: 0,
    commands: [] as Command[],
    unverified: 0,
    eof: 0,
    parent: 0,
  }
  const native: VerifiedFixture = {
    async probe() {
      state.probes++
      return { permissions: { screen: "denied", accessibility: "denied" }, responsible: true, elevated: false }
    },
    async open(): Promise<NativeChannel> {
      state.opened++
      state.clock = manualClock()
      const inbox: Received[] = []
      const reader = frameReader({ onFrame: (bytes) => inbox.push({ kind: "frame", bytes }) })
      const helper = createFakeHelper(
        { disabled: input.keyboard ? [] : ["input.keyboard"] },
        {
          clock: state.clock,
          write: (bytes) => reader.push(bytes),
          exit: (code) => inbox.push({ kind: "exit", code }),
        },
      )
      return {
        write: (bytes) => helper.receive(bytes),
        end: () => helper.endOfInput(),
        next: async () => inbox.shift(),
        dispose: async () => {
          helper.endOfInput()
        },
      }
    },
    async unverifiedParent() {
      state.unverified++
      return true
    },
    async eof() {
      state.eof++
      return true
    },
    async parentDeath() {
      state.parent++
      return true
    },
    async close() {
      state.closed++
    },
  }
  const dependencies: SelfTestDependencies = {
    platform: "darwin",
    fixture: async () => native,
    files: async () => ({ unit: "/virtual/tests/VectorComputerTests" }),
    wait: async (ms) => state.clock.advance(ms),
    ...(input.minimal ? { transcript: async () => hello } : {}),
    async command(command) {
      state.commands.push(command)
      if (!command.args.length) return { code: 0, stdout: "Unit checks passed" }
      return { code: 0, stdout: JSON.stringify({ checks: [{ name: "strict-cli", ok: true }] }) }
    },
  }
  return { state, native, dependencies }
}

test("native:test defaults to privileged off and resolves host-native output paths", () => {
  const mac = parseSelfTestArgs([], "darwin", "arm64")
  expect(mac.privileged).toBe("off")
  expect(mac.bin.endsWith(path.join("native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer"))).toBe(true)
  expect(mac.tests.endsWith(path.join("native/out/darwin/tests"))).toBe(true)
  const win = parseSelfTestArgs([], "win32", "arm64")
  expect(win.bin.endsWith(path.join("native/out/win32/arm64/vector-computer.exe"))).toBe(true)
  expect(() => parseSelfTestArgs([], "linux")).toThrow()
  expect(() => parseSelfTestArgs(["--privileged", "yes"], "darwin")).toThrow()
  expect(() => parseSelfTestArgs(["--unknown"], "darwin")).toThrow()
})

test("77 is a visible skip unless privileged checks are required", () => {
  for (const mode of ["auto", "off"] as const) expect(classifySelfTestExit(77, mode)).toBe("skipped")
  expect(classifySelfTestExit(77, "require")).toBe("failed")
  expect(classifySelfTestExit(0, "require")).toBe("passed")
  expect(classifySelfTestExit(1, "off")).toBe("failed")
  expect(classifySelfTestExit(null, "off")).toBe("failed")
})

test("transcript diagnostics identify a bounded line and failure class without response data", () => {
  const cases = [
    ['conformance.frame-too-large:1: expected {"id":0}, got nothing', "line-1-timeout"],
    ['conformance.frame-too-large:2: received a frame that does not decode (not JSON): "PRIVATE"', "line-2-decode"],
    ['conformance.frame-too-large:2: expected {"id":1}, got {"private":"PRIVATE"}', "line-2-mismatch"],
    ['conformance.frame-too-large:1: expected {"id":0}, got exit 1', "line-1-unexpected-exit"],
    ["conformance.frame-too-large:2: PRIVATE UNCLASSIFIED ERROR", "line-2-failed"],
  ] as const
  for (const [message, reason] of cases) {
    const result = transcriptFailureReason("frame-too-large", new Error(message))
    expect(result).toBe(reason)
    expect(result).not.toContain("PRIVATE")
  }
  expect(
    transcriptFailureReason("hello", new Error("The conformance fixture contains a non-isolated operation.")),
  ).toBe("fixture-policy")
  expect(transcriptFailureReason("hello", new Error("/PRIVATE/hello.jsonl:2: not a {send, expect} line"))).toBe(
    "fixture-format",
  )
})

test("transcript diagnostics discard unknown fixtures, arbitrary errors, and out-of-range lines", () => {
  for (const message of [
    "conformance.hello:1: expected PRIVATE, got nothing",
    "conformance.frame-too-large:0: expected PRIVATE, got nothing",
    "conformance.frame-too-large:1001: expected PRIVATE, got nothing",
    "conformance.frame-too-large:999999999999999999: expected PRIVATE, got nothing",
    "PRIVATE arbitrary child stderr",
  ])
    expect(transcriptFailureReason("frame-too-large", new Error(message))).toBe("transcript-failed")
  expect(transcriptFailureReason("unknown", new Error("conformance.unknown:1: expected PRIVATE, got nothing"))).toBe(
    "transcript-failed",
  )
  expect(transcriptFailureReason("hello", { message: "PRIVATE" })).toBe("transcript-failed")
})

test("M1 runs the nine applicable actual C1 transcripts and visibly skips keyboard heartbeat coverage", async () => {
  const fake = fixture()
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(
    result.checks.filter((check) => check.name.startsWith("conformance.") && check.status === "passed"),
  ).toHaveLength(9)
  expect(result.checks.find((check) => check.name === "conformance.heartbeat-loss")).toEqual({
    name: "conformance.heartbeat-loss",
    status: "skipped",
    reason: "requires-input.keyboard",
  })
  expect(fake.state.commands.map((command) => command.args)).toEqual([
    [],
    ["--self-test=unprivileged"],
    ["--self-test=packaged"],
  ])
  expect(fake.state.unverified).toBe(1)
  expect(fake.state.eof).toBe(1)
  expect(fake.state.parent).toBe(1)
  expect(fake.state.probes).toBe(2)
  expect(fake.state.closed).toBe(1)
  expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
    status: "skipped",
    reason: "disabled",
  })
})

test("a helper advertising keyboard support must pass unchanged heartbeat-loss assertions", async () => {
  const fake = fixture({ keyboard: true })
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(
    result.checks.filter((check) => check.name.startsWith("conformance.") && check.status === "passed"),
  ).toHaveLength(10)
  expect(fake.state.opened).toBe(CORE_TRANSCRIPTS.length + 1)
})

test("two one-shot probes validate separate observations without recording grant details", async () => {
  const fake = fixture({ minimal: true })
  fake.native.probe = async () => {
    fake.state.probes++
    return {
      permissions: {
        screen: fake.state.probes === 1 ? "notDetermined" : "granted",
        accessibility: "restricted",
        postEvent: "denied",
      },
      responsible: true,
      elevated: false,
      detail: "PRIVATE PROBE OUTPUT",
    }
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(0)
  expect(fake.state.probes).toBe(2)
  expect(result.checks.filter((check) => check.name.startsWith("probe."))).toEqual([
    { name: "probe.first", status: "passed" },
    { name: "probe.fresh", status: "passed" },
  ])
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|notDetermined|granted|restricted|postEvent/)
})

test("a probe needs valid permission states, its own responsibility, and an explicitly unelevated token", async () => {
  for (const invalid of [
    { permissions: { screen: "unknown", accessibility: "denied" }, responsible: true, elevated: false },
    { permissions: { screen: "denied" }, responsible: true, elevated: false },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: false, elevated: false },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: true, elevated: true },
    { permissions: { screen: "denied", accessibility: "denied" }, responsible: true },
  ]) {
    const fake = fixture({ minimal: true })
    fake.native.probe = async () => {
      fake.state.probes++
      return invalid
    }
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(fake.state.probes).toBe(2)
    expect(
      result.checks
        .filter((check) => check.name.startsWith("probe."))
        .every((check) => check.status === "failed" && check.reason === "native-probe-failed"),
    ).toBe(true)
  }
})

test("auto skips an absent isolated target while require fails without launching privileged scenarios", async () => {
  for (const mode of ["auto", "require"] as const) {
    const fake = fixture({ minimal: true })
    const result = await runComputerHelperSelfTest({ ...options, privileged: mode }, fake.dependencies)
    expect(result.code).toBe(mode === "require" ? 1 : 0)
    expect(result.checks.find((check) => check.name === "privileged")).toMatchObject({
      status: mode === "require" ? "failed" : "skipped",
      reason: "isolated-target-unavailable",
    })
    expect(fake.state.commands.some((command) => command.args.includes("--self-test=privileged"))).toBe(false)
  }
})

test("optional native 77 stays skipped and required native 77 fails against the fixed isolated target", async () => {
  for (const mode of ["auto", "require"] as const) {
    const fake = fixture({ minimal: true })
    fake.dependencies.files = async () => ({
      unit: "/virtual/tests/VectorComputerTests",
      target: "/virtual/tests/VectorComputerTestTarget.app",
    })
    const command = fake.dependencies.command!
    fake.dependencies.command = async (value) => {
      if (!value.args.includes("--self-test=privileged")) return command(value)
      fake.state.commands.push(value)
      return {
        code: 77,
        stdout: JSON.stringify({
          checks: [{ name: "privileged-native-checks", ok: false, skipped: true, detail: "PRIVATE SCREEN CONTENT" }],
        }),
      }
    }
    const result = await runComputerHelperSelfTest({ ...options, privileged: mode }, fake.dependencies)
    expect(result.code).toBe(mode === "require" ? 1 : 0)
    expect(result.checks.find((check) => check.name === "privileged")?.status).toBe(
      mode === "require" ? "failed" : "skipped",
    )
    expect(fake.state.commands.at(-1)?.args).toEqual([
      "--self-test=privileged",
      "--target",
      "/virtual/tests/VectorComputerTestTarget.app",
    ])
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  }
})

test("unit, unprivileged and packaged checks cannot skip required grant-free coverage with exit 77", async () => {
  for (const name of ["unit", "unprivileged", "packaged"]) {
    const fake = fixture({ minimal: true })
    const command = fake.dependencies.command!
    fake.dependencies.command = async (value) => {
      const current = value.args.length === 0 ? "unit" : value.args[0]?.replace("--self-test=", "")
      if (current !== name) return command(value)
      return { code: 77, stdout: JSON.stringify({ checks: [{ name: "strict-cli", ok: false, skipped: true }] }) }
    }
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(result.checks.find((check) => check.name === name)).toMatchObject({
      status: "failed",
      reason: "unexpected-core-skip",
    })
  }
})

test("raw child reports, unknown check names, and conformance diagnostics never enter the summary", async () => {
  const fake = fixture({ minimal: true })
  fake.dependencies.command = async (command) =>
    command.args.length
      ? {
          code: 0,
          stdout: JSON.stringify({
            checks: [
              { name: "clipboard-secret-42", ok: true, detail: "PRIVATE TYPED TEXT", image: "data:image/png;SECRET" },
            ],
          }),
        }
      : { code: 0, stdout: "PRIVATE UNIT OUTPUT" }
  fake.dependencies.transcript = async () => {
    throw new Error("PRIVATE TRANSCRIPT SCREEN TEXT")
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|clipboard-secret/)
  expect(result.checks.find((check) => check.name === "unprivileged.check-1")?.status).toBe("passed")
  expect(result.checks.find((check) => check.name === "conformance.hello")).toMatchObject({
    status: "failed",
    reason: "transcript-failed",
  })
})

test("a fixture loss after hello marks all unrun checks failed and always closes the fixture", async () => {
  const fake = fixture({ minimal: true })
  const open = fake.native.open
  fake.native.open = async () => {
    if (fake.state.opened) throw new Error("The virtual caller stopped")
    return open()
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "responsible")?.status).toBe("passed")
  expect(result.checks.find((check) => check.name === "conformance.hello")?.status).toBe("failed")
  expect(result.checks.some((check) => check.reason === "not-run")).toBe(false)
  expect(fake.state.closed).toBe(1)
})

test("responsibility false cannot turn a functioning framed helper into accepted native evidence", async () => {
  const fake = fixture({ minimal: true })
  const open = fake.native.open
  fake.native.open = async () => {
    const channel = await open()
    return {
      ...channel,
      async next(ms) {
        const value = await channel.next(ms)
        if (value?.kind !== "frame") return value
        const message = JSON.parse(Buffer.from(value.bytes).toString("utf8"))
        message.responsible = false
        return { kind: "frame", bytes: Buffer.from(JSON.stringify(message)) }
      },
    }
  }
  const result = await runComputerHelperSelfTest(options, fake.dependencies)
  expect(result.code).toBe(1)
  expect(result.checks.find((check) => check.name === "responsible")).toMatchObject({ status: "failed" })
  expect(fake.state.closed).toBe(1)
})

test("grant-free fixture validation refuses prompts, granted owners, foreign input, and oversize changes", () => {
  for (const send of [
    { id: 1, op: "permissions.request", service: "screen" },
    { id: 1, op: "session.begin", approved: [{ pid: 1 }] },
    { id: 1, op: "input.type", pid: 1, text: "Do not type" },
    { $raw: JSON.stringify({ id: 1, op: "permissions.reset", service: "screen" }) },
    { $oversize: 123 },
  ])
    expect(() => validateCoreTranscript("hello", [{ send, expect: null }])).toThrow()
  expect(() =>
    validateCoreTranscript("heartbeat-loss", [
      { send: { id: 3, op: "input.key", pid: 99999, combo: ["a"], repeat: 1 }, expect: null },
    ]),
  ).not.toThrow()
})

test("raw conformance rejects parser ambiguity and permits only the exact C1 malformed sentinel", () => {
  for (const raw of [
    '{"id":1,"op":"permissions.request","op":"hello","service":"screen"}',
    '{"id":1,"op":"permissions.reset","service":"screen",}',
    '{"id":1,"op":"permissions.request","service":"screen",}',
    '{"id":1,"op":"hello",}',
    '{"id":1,"op":"hello","op":"hello"}',
    '{"id":1,"op":"\\u0068ello"}',
    '{ "id":1,"op":"hello"}',
    '{"id":1,"op":"permissions.request"',
    "{arbitrary malformed input",
    "{not json ",
  ])
    expect(() => validateCoreTranscript("malformed-json", [{ send: { $raw: raw }, expect: null }])).toThrow()
  expect(() => validateCoreTranscript("hello", [{ send: { $raw: "{not json" }, expect: null }])).toThrow()
  for (const raw of ["{not json", "[1,2,3]", '{"op":"hello","protocol":{"min":1,"max":1}}'])
    expect(() => validateCoreTranscript("malformed-json", [{ send: { $raw: raw }, expect: null }])).not.toThrow()
})

test("a mismatched host refuses before any child command or fixture can start", async () => {
  const fake = fixture()
  await expect(runComputerHelperSelfTest(options, { ...fake.dependencies, platform: "linux" })).rejects.toThrow()
  expect(fake.state.commands).toEqual([])
  expect(fake.state.opened).toBe(0)
})

test("unclassified or missing transcripts fail the catalog before any native command or fixture starts", async () => {
  const known = CORE_TRANSCRIPTS.map((name) => `${name}.jsonl`)
  for (const catalog of [
    [...known, "private-unclassified-scenario.jsonl"],
    [...known, "nested/new-case.jsonl"],
    known.slice(1),
  ]) {
    const fake = fixture({ minimal: true })
    let fixtureCalls = 0
    const create = fake.dependencies.fixture!
    fake.dependencies.fixture = async (value) => {
      fixtureCalls++
      return create(value)
    }
    fake.dependencies.catalog = async () => catalog
    const result = await runComputerHelperSelfTest(options, fake.dependencies)
    expect(result.code).toBe(1)
    expect(result.checks.find((check) => check.name === "catalog")).toEqual({
      name: "catalog",
      status: "failed",
      reason: "unclassified-fixture-catalog",
    })
    expect(fake.state.commands).toEqual([])
    expect(fixtureCalls).toBe(0)
    expect(fake.state.opened).toBe(0)
    expect(fake.state.probes).toBe(0)
    expect(JSON.stringify(result)).not.toMatch(/private-unclassified|new-case|nested/)
  }
})
