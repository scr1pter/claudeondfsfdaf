import { Buffer } from "node:buffer"
import { expect, test } from "bun:test"
import {
  observeComputerSmokeWindowRegions,
  parseComputerSmokeWindowRegions,
  COMPUTER_SMOKE_REGION_PHASE_MARK,
  COMPUTER_SMOKE_REGION_PHASES,
  computerSmokeRegionProgress,
  computerSmokeRegionDeadline,
  type ComputerSmokeRegionRunner,
} from "./computer-overlay-smoke-window-region"

const expected = { x: -1024, y: 744, width: 1024, height: 24 }
const proof = () => ({
  protocol: 1,
  ok: true,
  windows: [
    {
      index: 0,
      windowRect: { ...expected, height: 39 },
      regionRect: { ...expected },
      owned: true,
      simple: true,
      matches: true,
    },
  ],
})
function handle(value = 0xaabbccdd11223344n) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(value)
  return bytes
}

test("native region receipts retain actual outer39 and region24, and independently verify physical extents", () => {
  const raw = proof()
  const parsed = parseComputerSmokeWindowRegions(JSON.stringify(raw), [expected])
  expect(parsed).toEqual({ ok: true, windows: raw.windows })
  if (!parsed.ok) throw new Error("Expected a validated fixture.")
  expect(parsed.windows[0]!.windowRect.height).toBe(39)
  expect(parsed.windows[0]!.regionRect.height).toBe(24)
  expect(parsed.windows[0]!.regionRect).not.toBe(raw.windows[0]!.regionRect)
  const mismatch = proof()
  mismatch.windows[0]!.regionRect.height = 25
  mismatch.windows[0]!.matches = false
  expect(parseComputerSmokeWindowRegions(JSON.stringify(mismatch), [expected])).toEqual({
    ok: true,
    windows: mismatch.windows,
  })
  mismatch.windows[0]!.matches = true
  expect(() => parseComputerSmokeWindowRegions(JSON.stringify(mismatch), [expected])).toThrow()
})

test("region receipt parser rejects private fields, foreign or complex claims, order drift and unbounded data", () => {
  const row = proof().windows[0]!
  for (const patch of [
    { index: 1 },
    { owned: false },
    { simple: false },
    { matches: "true" },
    { handle: "PRIVATE" },
    { pid: 12 },
    { windowRect: { ...row.windowRect, title: "PRIVATE" } },
    { regionRect: { ...row.regionRect, x: -1025 } },
    { regionRect: { ...row.regionRect, height: 0 } },
    { regionRect: { ...row.regionRect, width: 1024.5 } },
    { windowRect: { ...row.windowRect, height: 1_000_001 } },
  ])
    expect(() =>
      parseComputerSmokeWindowRegions(JSON.stringify({ ...proof(), windows: [{ ...row, ...patch }] }), [expected]),
    ).toThrow()
  for (const patch of [{ protocol: 2 }, { path: "PRIVATE" }, { windows: [] }, { windows: [row, row] }])
    expect(() => parseComputerSmokeWindowRegions(JSON.stringify({ ...proof(), ...patch }), [expected])).toThrow()
  expect(() => parseComputerSmokeWindowRegions(" ".repeat(65_537), [expected])).toThrow()
  expect(() => parseComputerSmokeWindowRegions("PRIVATE", [expected])).toThrow()
  expect(() => parseComputerSmokeWindowRegions(JSON.stringify(proof()), [])).toThrow()
})

test("only closed native bridge failure stages survive parsing", () => {
  for (const reason of ["compile", "parent", "owner", "region", "liveness", "output"])
    expect(parseComputerSmokeWindowRegions(JSON.stringify({ protocol: 1, ok: false, reason }), [expected])).toEqual({
      ok: false,
      reason,
    })
  for (const reason of ["PRIVATE path", "permissions_granted", "deadline"])
    expect(() =>
      parseComputerSmokeWindowRegions(JSON.stringify({ protocol: 1, ok: false, reason }), [expected]),
    ).toThrow()
  expect(() =>
    parseComputerSmokeWindowRegions(JSON.stringify({ protocol: 1, ok: false, reason: "owner", error: "PRIVATE" }), [
      expected,
    ]),
  ).toThrow()
})

test("the bridge sends only bounded stdin handles to one fixed noninteractive system command", async () => {
  const calls: Parameters<ComputerSmokeRegionRunner>[0][] = []
  const run: ComputerSmokeRegionRunner = async (request) => {
    calls.push(request)
    return { code: 0, stdout: JSON.stringify(proof()) }
  }
  expect(await observeComputerSmokeWindowRegions([{ handle: handle(), expected }], { run })).toEqual({
    ok: true,
    windows: proof().windows,
  })
  expect(calls).toHaveLength(1)
  const request = calls[0]!
  expect(request.command.toLowerCase()).toMatch(/^[a-z]:\\program files\\powershell\\7\\pwsh\.exe$/)
  expect(request.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
  expect(request.args).toHaveLength(4)
  expect(request.args[3]!.length).toBeLessThan(30_000)
  expect(request.args.some((argument) => /executionpolicy|bypass/i.test(argument))).toBe(false)
  expect(Buffer.from(request.args[3]!, "base64").toString("utf16le")).not.toContain("aabbccdd11223344")
  expect(JSON.parse(request.stdin)).toEqual({ protocol: 1, windows: [{ handle: "aabbccdd11223344", expected }] })
  expect(request.timeoutMs).toBe(15_000)
  expect(request.maxBytes).toBe(65_536)
})

test("bad handles, supplied selectors and excess windows never launch a child", async () => {
  let calls = 0
  const run: ComputerSmokeRegionRunner = async () => {
    calls++
    return { code: 0, stdout: JSON.stringify(proof()) }
  }
  for (const windows of [
    [],
    [{ handle: Buffer.alloc(7), expected }],
    [{ handle: handle(0n), expected }],
    [
      { handle: handle(), expected },
      { handle: handle(), expected },
    ],
    [{ handle: handle(), expected: { ...expected, width: 0 } }],
    [{ handle: handle(), expected, pid: 10 }],
    Array.from({ length: 257 }, (_, index) => ({ handle: handle(BigInt(index + 1)), expected })),
  ])
    expect(await observeComputerSmokeWindowRegions(windows, { run })).toEqual({ ok: false, reason: "invalid_windows" })
  expect(calls).toBe(0)
})

test("child faults, exit mismatches and forged results fail closed with fixed reasons", async () => {
  const input = [{ handle: handle(), expected }]
  expect(
    await observeComputerSmokeWindowRegions(input, {
      run: async () => {
        throw new Error("PRIVATE")
      },
    }),
  ).toEqual({ ok: false, reason: "output" })
  for (const reason of [
    "launch",
    "output",
    "deadline",
    "deadline_launch",
    "deadline_compile",
    "deadline_input",
    "deadline_parent",
    "deadline_region",
    "deadline_output",
  ] as const)
    expect(
      await observeComputerSmokeWindowRegions(input, {
        run: async () => ({ code: null, stdout: "PRIVATE", failed: true, reason }),
      }),
    ).toEqual({ ok: false, reason })
  expect(
    await observeComputerSmokeWindowRegions(input, { run: async () => ({ code: 1, stdout: JSON.stringify(proof()) }) }),
  ).toEqual({ ok: false, reason: "output" })
  expect(await observeComputerSmokeWindowRegions(input, { run: async () => ({ code: 0, stdout: "PRIVATE" }) })).toEqual(
    { ok: false, reason: "output" },
  )
  expect(
    await observeComputerSmokeWindowRegions(input, {
      run: async () => ({ code: 1, stdout: JSON.stringify({ protocol: 1, ok: false, reason: "region" }) }),
    }),
  ).toEqual({ ok: false, reason: "region" })
})

test("streamed bridge progress retains only five complete ordered fixed markers across chunk boundaries", () => {
  const progress = computerSmokeRegionProgress()
  progress.feed("PRIVATE stderr\n" + COMPUTER_SMOKE_REGION_PHASE_MARK.slice(0, 9))
  progress.feed(COMPUTER_SMOKE_REGION_PHASE_MARK.slice(9) + "compile\r")
  progress.feed("\n")
  for (const phase of COMPUTER_SMOKE_REGION_PHASES.slice(1))
    progress.feed(Buffer.from(COMPUTER_SMOKE_REGION_PHASE_MARK + phase + "\r\n"))
  const result = progress.finish()
  expect(result).toEqual({ phase: "output", count: 5, invalid: false })
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
  progress.feed(COMPUTER_SMOKE_REGION_PHASE_MARK + "compile\n")
  expect(progress.finish()).toEqual(result)
})

test("malformed, replayed, oversized and unterminated progress cannot create a deadline phase", () => {
  const marker = (phase: string) => COMPUTER_SMOKE_REGION_PHASE_MARK + phase + "\n"
  for (const source of [
    marker("input"),
    marker("compile") + marker("compile"),
    marker("compile") + marker("parent"),
    COMPUTER_SMOKE_REGION_PHASES.map(marker).join("") + marker("output"),
    marker("PRIVATE_PID_123"),
    COMPUTER_SMOKE_REGION_PHASE_MARK + "compile",
    COMPUTER_SMOKE_REGION_PHASE_MARK + "x".repeat(300) + "\n",
    "x".repeat(65_537),
  ]) {
    const progress = computerSmokeRegionProgress()
    progress.feed(source)
    const result = progress.finish()
    expect(result.invalid).toBe(true)
    expect(result.count).toBeLessThanOrEqual(5)
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    expect(computerSmokeRegionDeadline(result, true)).toBe("deadline")
  }
  const ordinary = computerSmokeRegionProgress()
  ordinary.feed("PRIVATE" + "x".repeat(1000) + "\nunknown partial")
  expect(ordinary.finish()).toEqual({ count: 0, invalid: false })
})

test("the unchanged deadline identifies only trusted launch or phase observations", () => {
  expect(computerSmokeRegionDeadline({ count: 0, invalid: false }, false)).toBe("deadline")
  expect(computerSmokeRegionDeadline({ count: 0, invalid: false }, true)).toBe("deadline_launch")
  const progress = computerSmokeRegionProgress()
  for (const phase of COMPUTER_SMOKE_REGION_PHASES) {
    const single = computerSmokeRegionProgress()
    for (const known of COMPUTER_SMOKE_REGION_PHASES.slice(0, COMPUTER_SMOKE_REGION_PHASES.indexOf(phase) + 1))
      single.feed(COMPUTER_SMOKE_REGION_PHASE_MARK + known + "\n")
    expect(computerSmokeRegionDeadline(single.finish(), true)).toBe("deadline_" + phase)
  }
  expect(computerSmokeRegionDeadline({ phase: "compile", count: 2, invalid: false }, true)).toBe("deadline")
  expect(computerSmokeRegionDeadline(progress.finish(), true)).toBe("deadline_launch")
})
