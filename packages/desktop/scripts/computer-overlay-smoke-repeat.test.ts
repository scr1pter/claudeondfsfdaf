import { expect, test } from "bun:test"
import desktop from "../package.json"
import { computerStopRepeatCount, measureComputerStop, observeComputerStop } from "./computer-overlay-smoke-repeat"
import {
  COMPUTER_SMOKE_CHECKS,
  COMPUTER_SMOKE_FAILURE_MARK,
  COMPUTER_SMOKE_MARK,
  COMPUTER_SMOKE_NATIVE_MARK,
  type ComputerSmokeCheck,
} from "./computer-overlay-smoke-report"

const driver = (stop: unknown, exitCode: number) =>
  COMPUTER_SMOKE_NATIVE_MARK + JSON.stringify({ protocol: 1, kind: "result", phase: "exit", stop, exitCode })
const report = (checks: Record<string, Omit<ComputerSmokeCheck, "name">> = {}) =>
  COMPUTER_SMOKE_MARK +
  JSON.stringify({
    protocol: 1,
    platform: "win32",
    electron: desktop.devDependencies.electron,
    checks: COMPUTER_SMOKE_CHECKS.map((name) => ({
      name,
      ...(checks[name] ??
        (name === "native-capture-exclusion" || name === "overlay-workspaces"
          ? { ok: false, skipped: true, reason: "not_applicable" }
          : { ok: true })),
    })),
  })
const failure = (cause: string) =>
  COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify({ protocol: 1, cause, phase: "report", hint: "none" })
const good = { stdout: [driver({ ok: true }, 0), report()].join("\r\n") + "\r\n", stderr: "", exitCode: 0 }
const failedReport = report({
  "native-os-stop": { ok: false, reason: "native_proof_invalid" },
  "native-capture-exclusion": { ok: false, reason: "native_proof_invalid" },
})
const uia = { lookup: "first", call: "root", actor: "retired", expiry: "caller-wait", hresult: "unobserved" }
const failed = (stage: string, facts: typeof uia | null = uia, cause = "core_failure:no_ui_tree") => ({
  stdout: `${driver({ ok: false, reason: "native_failure", stage, cause, ...(facts ? { uia: facts } : {}) }, 1)}\n${failedReport}\n`,
  stderr: failure("assertion_failed") + "\n",
  exitCode: 1,
})

test("counts only the closed, observed first-root signature and validated native passes", () => {
  expect(observeComputerStop(good)).toEqual({ status: "passed", stage: null, uia: null })
  for (const stage of ["uia-root-element", "uia-runtime-id", "uia-prepare-connection"]) {
    expect(observeComputerStop(failed(stage))).toEqual({
      status: "hf7",
      stage,
      cause: "core_failure:no_ui_tree",
      uia,
      reason: "native_proof_invalid",
    })
    expect(observeComputerStop(failed(stage, { ...uia, lookup: "refresh" })).status).toBe("failed")
    expect(observeComputerStop(failed(stage, { ...uia, actor: "healthy", expiry: "none" })).status).toBe("failed")
  }
  expect(observeComputerStop(failed("uia-root-element", uia, "core_failure:timeout")).status).toBe("failed")
  expect(observeComputerStop(failed("post", null, "core_failure:changed"))).toMatchObject({
    status: "failed",
    stage: "post",
    cause: "core_failure:changed",
    uia: null,
  })
})

test("reports which first root attempt failed without changing its classification", () => {
  for (const rootAttempt of ["initial", "replacement"]) {
    const traced = { ...uia, rootAttempt }
    expect(observeComputerStop(failed("uia-root-wrap", traced))).toMatchObject({
      status: "failed",
      stage: "uia-root-wrap",
      uia: traced,
    })
    expect(observeComputerStop(failed("uia-root-element", traced)).status).toBe("hf7")
  }
  const traced = { ...uia, rootAttempt: "replacement" }
  for (const invalid of [
    { ...traced, rootAttempt: "third" },
    { ...traced, lookup: "refresh" },
    { ...traced, call: "hit" },
  ]) {
    expect(observeComputerStop(failed("uia-root-wrap", invalid)).reason).toBe("malformed_evidence")
  }
  expect(observeComputerStop(failed("uia-root-wrap")).uia).toEqual(uia)
})

test("skips, missing evidence, timeouts and malformed or inconsistent reports stay visible", () => {
  const prerun =
    'computer-smoke-unavailable {"protocol":1,"platform":"win32","skipped":true,"reason":"elevated_fixture"}\n'
  expect(observeComputerStop({ stdout: prerun, stderr: "", exitCode: 77 })).toEqual({
    status: "skipped",
    stage: null,
    uia: null,
    reason: "elevated_fixture",
  })
  const skipReport = report({ "native-os-stop": { ok: false, skipped: true, reason: "elevated_fixture" } })
  for (const stdout of [
    skipReport,
    [driver({ ok: false, skipped: true, reason: "elevated_parent" }, 77), skipReport].join("\n"),
  ])
    expect(observeComputerStop({ ...good, stdout }).status).toBe("skipped")
  expect(observeComputerStop({ stdout: "", stderr: failure("deadline_exceeded"), exitCode: 1 }).status).toBe("timeout")
  expect(observeComputerStop({ ...good, stdout: report() }).reason).toBe("missing_native_result")
  expect(observeComputerStop({ ...good, stdout: "" }).reason).toBe("missing_report")
  expect(observeComputerStop({ ...good, stdout: COMPUTER_SMOKE_NATIVE_MARK + "{" }).reason).toBe("malformed_evidence")
  expect(observeComputerStop({ ...good, stdout: good.stdout + good.stdout }).reason).toBe("ambiguous_evidence")
  expect(observeComputerStop({ ...good, stdout: prerun + good.stdout, exitCode: 77 }).reason).toBe("invalid_skip")
  expect(observeComputerStop({ ...good, exitCode: 1 }).status).toBe("invalid")
  expect(observeComputerStop({ ...good, overflow: true }).reason).toBe("output_limit")
  expect(
    observeComputerStop({
      stdout: [driver({ ok: true }, 0), report({ "overlay-count": { ok: false, reason: "assertion_failed" } })].join(
        "\n",
      ),
      stderr: failure("assertion_failed"),
      exitCode: 1,
    }).reason,
  ).toBe("other_smoke_assertion")
})

function jsonRow(line: string) {
  return JSON.parse(line.slice(line.indexOf(" ") + 1))
}

test("a disabled run spawns nothing and an enabled run reports one row per fresh, serial invocation", async () => {
  const lines: string[] = []
  let attempts = 0
  let active = 0
  let time = 0
  const options = { stageAvailable: true, now: () => time }
  const run = async () => {
    expect(active++).toBe(0)
    const attempt = ++attempts
    await Promise.resolve()
    active--
    time += 18000
    if (attempt === 1) return { ...good, stdout: good.stdout + "PRIVATE WINDOW TITLE\n" }
    if (attempt === 2) return { ...failed("uia-root-element"), nativeProofMs: 1900 }
    if (attempt === 3) return { stdout: "", stderr: "PRIVATE STDERR\n", exitCode: 1 }
    throw new Error("PRIVATE SPAWN ERROR")
  }
  const write = (line: string) => lines.push(line)
  expect(await measureComputerStop("1", run, write, options)).toBe(0)
  expect(attempts).toBe(0)
  expect(lines).toEqual([])
  expect(await measureComputerStop("4", run, write, options)).toBe(1)
  expect(attempts).toBe(4)
  expect(lines).toHaveLength(5)
  expect(lines.join("\n")).not.toContain("PRIVATE")
  expect(lines.slice(0, -1).map((line) => jsonRow(line).status)).toEqual(["passed", "hf7", "invalid", "invalid"])
  expect(jsonRow(lines[1]!)).toMatchObject({
    sample: 2,
    elapsedMs: 18000,
    nativeProofMs: 1900,
    stage: "uia-root-element",
    uia,
  })
  expect(jsonRow(lines[4]!)).toEqual({
    requested: 4,
    completed: 4,
    usable: 2,
    passed: 1,
    hf7: 1,
    failed: 0,
    skipped: 0,
    invalid: 2,
    timeout: 0,
    elapsedMs: 72000,
  })
})

test("50 timely observations fit and the separate deadline never implies a complete or clean result", async () => {
  const lines: string[] = []
  let time = 0
  const write = (line: string) => lines.push(line)
  const now = () => time
  const fast = async () => {
    time += 19000
    return good
  }
  expect(await measureComputerStop("50", fast, write, { stageAvailable: true, now })).toBe(0)
  expect(lines).toHaveLength(51)
  expect(jsonRow(lines.at(-1)!)).toMatchObject({ requested: 50, completed: 50, usable: 50, elapsedMs: 950000 })
  lines.length = 0
  const slow = async () => {
    time += 120000
    return good
  }
  expect(await measureComputerStop("50", slow, write, { stageAvailable: true, now })).toBe(1)
  expect(jsonRow(lines.at(-1)!)).toMatchObject({ requested: 50, completed: 15, usable: 15, incomplete: "step_budget" })
  lines.length = 0
  expect(await measureComputerStop("50", fast, write, { stageAvailable: false, now })).toBe(1)
  expect(lines).toHaveLength(1)
  expect(jsonRow(lines[0]!)).toMatchObject({ requested: 50, completed: 0, usable: 0, incomplete: "stage_unavailable" })
  for (const count of ["", "0", "-1", "01", "2.5", "51", "2x"]) expect(() => computerStopRepeatCount(count)).toThrow()
})
