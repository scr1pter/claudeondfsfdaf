import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import {
  observeComputerSmokeWindowRegions,
  parseComputerSmokeWindowRegions,
  COMPUTER_SMOKE_REGION_PHASE_MARK,
  COMPUTER_SMOKE_REGION_PHASES,
  COMPUTER_SMOKE_REGION_TIMEOUT_MS,
  COMPUTER_SMOKE_REGION_WARM_TIMEOUT_MS,
  computerSmokeRegionProgress,
  computerSmokeRegionDeadline,
  computerSmokeRegionElapsed,
  runComputerSmokeRegionBridge,
  warmComputerSmokeRegionCompiler,
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

// UTF-16LE SHA-256 of the embedded observer script at origin/main 15f3ba77; the observer source is unchanged.
const REGION_SCRIPT_SHA256 = "0049ef8603fe93d3f5fa48184d3100adba2d582c362165e22ab49640328baac8"
const WARM_SOURCE = [
  "",
  "$ErrorActionPreference = 'Stop'",
  "$WarningPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -TypeDefinition 'public static class VectorRegionWarm {}' -Language CSharp",
  "[Console]::Out.WriteLine('ok')",
  "",
].join("\n")
const capture = () => {
  const calls: Parameters<ComputerSmokeRegionRunner>[0][] = []
  return {
    calls,
    run:
      (result: Awaited<ReturnType<ComputerSmokeRegionRunner>>): ComputerSmokeRegionRunner =>
      async (request) => {
        calls.push(request)
        return result
      },
  }
}

test("the observer keeps its whole 15-second limit and the exact embedded script", async () => {
  const observed = capture()
  await observeComputerSmokeWindowRegions([{ handle: handle(), expected }], {
    run: observed.run({ code: 0, stdout: JSON.stringify(proof()) }),
  })
  const request = observed.calls[0]!
  expect(COMPUTER_SMOKE_REGION_TIMEOUT_MS).toBe(15_000)
  expect(request.timeoutMs).toBe(15_000)
  expect(createHash("sha256").update(Buffer.from(request.args[3]!, "base64")).digest("hex")).toBe(REGION_SCRIPT_SHA256)
})

test("the compiler warm-up runs only the same protected command with a fixed trivial source and no stdin", async () => {
  const observed = capture()
  await observeComputerSmokeWindowRegions([{ handle: handle(), expected }], {
    run: observed.run({ code: 0, stdout: JSON.stringify(proof()) }),
  })
  const warm = capture()
  expect(await warmComputerSmokeRegionCompiler({ run: warm.run({ code: 0, stdout: "ok\r\n" }) })).toEqual({
    ok: true,
    ms: expect.any(Number),
  })
  expect(warm.calls).toHaveLength(1)
  const request = warm.calls[0]!
  expect(request.command).toBe(observed.calls[0]!.command)
  expect(request.args.slice(0, 3)).toEqual(observed.calls[0]!.args.slice(0, 3))
  expect(request.args).toHaveLength(4)
  expect(Buffer.from(request.args[3]!, "base64").toString("utf16le")).toBe(WARM_SOURCE)
  expect(request.stdin).toBe("")
  expect(COMPUTER_SMOKE_REGION_WARM_TIMEOUT_MS).toBe(60_000)
  expect(request.timeoutMs).toBe(60_000)
  expect(request.maxBytes).toBe(65_536)
})

test("warm-up failures stay closed and fixed", async () => {
  const cases: [Awaited<ReturnType<ComputerSmokeRegionRunner>>, string][] = [
    [{ code: 0, stdout: "ok\n" }, "ok"],
    [{ code: 1, stdout: "" }, "compile"],
    [{ code: 0, stdout: "PRIVATE\n" }, "output"],
    [{ code: null, stdout: "", failed: true, reason: "launch" }, "launch"],
    [{ code: null, stdout: "", failed: true, reason: "output" }, "output"],
    [{ code: null, stdout: "", failed: true, reason: "deadline_launch" }, "deadline"],
    [{ code: null, stdout: "", failed: true, reason: "deadline" }, "deadline"],
  ]
  for (const [result, reason] of cases) {
    const warm = await warmComputerSmokeRegionCompiler({ run: async () => result })
    expect(Object.keys(warm).toSorted()).toEqual(reason === "ok" ? ["ms", "ok"] : ["ms", "ok", "reason"])
    expect(warm.ok ? "ok" : warm.reason).toBe(reason)
    expect(Number.isSafeInteger(warm.ms) && warm.ms >= 0).toBe(true)
  }
  expect(
    await warmComputerSmokeRegionCompiler({
      run: async () => {
        throw new Error("PRIVATE")
      },
    }),
  ).toEqual({ ok: false, reason: "output", ms: expect.any(Number) })
  if (process.platform !== "win32")
    expect(await warmComputerSmokeRegionCompiler()).toEqual({ ok: false, reason: "unsupported_platform", ms: 0 })
})

test("a warm-up result can never satisfy the region observer", async () => {
  const input = [{ handle: handle(), expected }]
  for (const stdout of [
    "ok\n",
    "ok\r\n",
    JSON.stringify({ protocol: 1, ok: true, ms: 12 }),
    JSON.stringify({ protocol: 1, ok: true, windows: [], ms: 12 }),
  ])
    expect(await observeComputerSmokeWindowRegions(input, { run: async () => ({ code: 0, stdout }) })).toEqual({
      ok: false,
      reason: "output",
    })
})

const child = (body: string): Parameters<ComputerSmokeRegionRunner>[0] => ({
  command: process.execPath,
  args: ["-e", body],
  stdin: "",
  timeoutMs: COMPUTER_SMOKE_REGION_TIMEOUT_MS,
  maxBytes: 65_536,
})
const mark = (phase: string) => JSON.stringify(COMPUTER_SMOKE_REGION_PHASE_MARK + phase + "\n")
const phaseTimes = (elapsed: Record<string, number> | undefined) => {
  if (!elapsed) throw new Error("Expected measured phase arrival times.")
  const values = Object.values(elapsed)
  for (const [index, value] of values.entries()) {
    expect(Number.isSafeInteger(value) && value >= 0 && value <= COMPUTER_SMOKE_REGION_TIMEOUT_MS).toBe(true)
    if (index > 0) expect(value).toBeGreaterThanOrEqual(values[index - 1]!)
  }
  return Object.keys(elapsed)
}

test("the actual runner measures ordered marker arrival from spawn without changing a completed result", async () => {
  const steps = COMPUTER_SMOKE_REGION_PHASES.map(
    (phase, index) => `setTimeout(() => process.stderr.write(${mark(phase)}), ${index * 40})`,
  )
  const result = await runComputerSmokeRegionBridge(
    child(
      steps.join(";") +
        `;setTimeout(() => { process.stdout.write(${JSON.stringify(JSON.stringify(proof()) + "\n")}); process.exitCode = 0 }, 240)`,
    ),
  )
  expect(result.failed).toBe(false)
  expect(result.reason).toBeUndefined()
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(proof())
  expect(phaseTimes(result.elapsed)).toEqual([...COMPUTER_SMOKE_REGION_PHASES])
  expect(computerSmokeRegionElapsed(result.elapsed, COMPUTER_SMOKE_REGION_TIMEOUT_MS)).toEqual(result.elapsed)
})

test("the actual runner's deadline keeps its unchanged mapping and only the phases reached", async () => {
  const hold = "setInterval(() => {}, 1000)"
  const cases = [
    [hold, "deadline_launch", []],
    [`process.stderr.write(${mark("compile")});${hold}`, "deadline_compile", ["compile"]],
    [`process.stderr.write(${mark("compile")} + ${mark("input")});${hold}`, "deadline_input", ["compile", "input"]],
    [`process.stderr.write(${mark("input")});${hold}`, "deadline", []],
  ] as const
  // Each local child holds until its own runner deadline kills it; the cases run side by side.
  const results = await Promise.all(
    cases.map(([body]) => runComputerSmokeRegionBridge({ ...child(body), timeoutMs: 4000 })),
  )
  for (const [index, [, reason, phases]] of cases.entries()) {
    const result = results[index]!
    expect(result).toEqual({ code: null, stdout: "", failed: true, reason, elapsed: expect.any(Object) })
    expect(phaseTimes(result.elapsed)).toEqual([...phases])
    for (const value of Object.values(result.elapsed!)) expect(value).toBeLessThanOrEqual(4000)
  }
})

test("observed phase timing passes through only in its closed bounded shape and never decides the verdict", async () => {
  const input = [{ handle: handle(), expected }]
  const elapsed = { compile: 180, input: 1900 }
  expect(
    await observeComputerSmokeWindowRegions(input, {
      run: async () => ({ code: null, stdout: "", failed: true, reason: "deadline_input", elapsed }),
    }),
  ).toEqual({ ok: false, reason: "deadline_input", elapsed })
  const full = { compile: 100, input: 1200, parent: 1210, region: 1215, output: 1230 }
  expect(
    await observeComputerSmokeWindowRegions(input, {
      run: async () => ({ code: 0, stdout: JSON.stringify(proof()), elapsed: full }),
    }),
  ).toEqual({ ok: true, windows: proof().windows, elapsed: full })
  for (const forged of [
    { input: 5 },
    { compile: 10, input: 5 },
    { compile: -1 },
    { compile: 1.5 },
    { compile: 15_001 },
    { compile: 1, PRIVATE: 2 },
    { compile: "1" },
    [1],
    "PRIVATE",
  ])
    expect(
      await observeComputerSmokeWindowRegions(input, {
        run: async () => ({ code: 0, stdout: JSON.stringify(proof()), elapsed: forged as never }),
      }),
    ).toEqual({ ok: true, windows: proof().windows })
  expect(computerSmokeRegionElapsed({}, COMPUTER_SMOKE_REGION_TIMEOUT_MS)).toEqual({})
})
