import { expect, test } from "bun:test"
import type { BrowserWindowConstructorOptions } from "electron"
import {
  COMPUTER_SMOKE_WINDOW_PROBE_MARK,
  COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS,
  acceptComputerSmokeWindowProbe,
  computerSmokeWindowProbes,
  parseComputerSmokeWindowProbe,
  type ComputerSmokeWindowProbe,
} from "./computer-overlay-smoke-window-probe"
import { COMPUTER_SMOKE_CHECKS, COMPUTER_SMOKE_MARK, parseComputerSmokeReport } from "./computer-overlay-smoke-report"

const receipt = {
  protocol: 1,
  variant: "baseline",
  requested: { x: -1024, y: 0, width: 1024, height: 24 },
  actual: { x: -1024, y: 0, width: 1024, height: 39 },
  minimum: [1024, 39],
  maximum: [1024, 39],
  content: [1024, 39],
  resizable: false,
}
const line = (value: unknown) => COMPUTER_SMOKE_WINDOW_PROBE_MARK + JSON.stringify(value)

test("window probe receipts contain only fixed variants, bounded numbers and final resizability", () => {
  const parsed = parseComputerSmokeWindowProbe(line(receipt))
  expect(parsed).toEqual(receipt)
  expect(parsed).not.toBe(receipt)
  for (const key of ["requested", "actual", "minimum", "maximum", "content"] as const)
    expect(parsed[key]).not.toBe(receipt[key])
  for (const patch of [
    { protocol: 2 },
    { variant: "PRIVATE_TITLE" },
    { resizable: 0 },
    { pid: 123 },
    { requested: { ...receipt.requested, path: "PRIVATE" } },
    { actual: { ...receipt.actual, hwnd: "PRIVATE" } },
    { actual: { ...receipt.actual, width: 0 } },
    { actual: { ...receipt.actual, height: 1_000_001 } },
    { minimum: [-1, 0] },
    { maximum: [0, "PRIVATE"] },
    { content: [1024] },
    { content: [1, 2, 3] },
    { maximum: [1, 0.5] },
  ])
    expect(() => parseComputerSmokeWindowProbe(line({ ...receipt, ...patch }))).toThrow()
  expect(() => parseComputerSmokeWindowProbe(line({ ...receipt, content: undefined }))).toThrow()
  expect(() => parseComputerSmokeWindowProbe(line(receipt) + " ".repeat(513))).toThrow()
  expect(() => parseComputerSmokeWindowProbe(COMPUTER_SMOKE_WINDOW_PROBE_MARK + "{")).toThrow()
})

test("the real progress collector accepts only four unique live Windows properties receipts", () => {
  const seen = new Set<ComputerSmokeWindowProbe["variant"]>()
  const input = { platform: "win32", phase: "properties", terminal: false, seen } as const
  expect(acceptComputerSmokeWindowProbe(line(receipt), input)).toEqual(receipt)
  expect(() => acceptComputerSmokeWindowProbe(line(receipt), input)).toThrow()
  for (const variant of COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS.slice(1))
    expect(acceptComputerSmokeWindowProbe(line({ ...receipt, variant }), input).variant).toBe(variant)
  expect(seen.size).toBe(4)
  expect(() => acceptComputerSmokeWindowProbe(line(receipt), input)).toThrow()
  for (const patch of [{ platform: "darwin" }, { terminal: true }, { phase: "controller" as const }])
    expect(() => acceptComputerSmokeWindowProbe(line(receipt), { ...input, seen: new Set(), ...patch })).toThrow()
})

function fixture(failedRead = false) {
  const windows: {
    options: BrowserWindowConstructorOptions
    bounds: typeof receipt.actual
    resizable: boolean
    destroyed: boolean
    calls: string[]
  }[] = []
  const create = (options: BrowserWindowConstructorOptions) => {
    const value = {
      options,
      bounds: { ...receipt.requested, height: options.resizable ? 24 : 39 },
      resizable: options.resizable === true,
      destroyed: false,
      calls: [] as string[],
    }
    windows.push(value)
    return {
      getBounds: () => {
        if (failedRead) throw new Error("PRIVATE")
        return { ...value.bounds }
      },
      getContentBounds: () => ({ ...value.bounds }),
      getMinimumSize: (): [number, number] => (value.resizable ? [0, 0] : [value.bounds.width, value.bounds.height]),
      getMaximumSize: (): [number, number] => (value.resizable ? [0, 0] : [value.bounds.width, value.bounds.height]),
      isResizable: () => value.resizable,
      setBounds: (bounds: typeof receipt.actual) => {
        value.calls.push("bounds")
        value.bounds = { ...bounds }
      },
      setResizable: (resizable: boolean) => {
        value.calls.push("resizable")
        value.resizable = resizable
      },
      isDestroyed: () => value.destroyed,
      destroy: () => {
        value.calls.push("destroy")
        value.destroyed = true
      },
    }
  }
  return { windows, create }
}

test("four fixed constructor variants stay hidden, preserve the base policy and destroy each owned window", () => {
  const f = fixture()
  const options = {
    transparent: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  }
  const probes = computerSmokeWindowProbes({ bounds: receipt.requested, options, create: f.create })
  expect(probes.map((probe) => probe.variant)).toEqual([...COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS])
  expect(probes.map((probe) => probe.actual.height)).toEqual([39, 24, 24, 39])
  expect(probes.map((probe) => probe.resizable)).toEqual([false, true, false, false])
  expect(f.windows).toHaveLength(4)
  for (const window of f.windows) {
    expect(window.options.show).toBe(false)
    expect(window.options.focusable).toBe(false)
    expect(window.options.webPreferences).toEqual(options.webPreferences)
    expect(window.destroyed).toBe(true)
  }
  expect(f.windows[2]!.calls).toEqual(["bounds", "resizable", "destroy"])
  expect(f.windows[3]!.options).toMatchObject({ minWidth: 1024, maxWidth: 1024, minHeight: 24, maxHeight: 24 })
  expect(options).not.toHaveProperty("minHeight")
})

test("unavailable observations emit no data and still destroy every created window", () => {
  const f = fixture(true)
  expect(computerSmokeWindowProbes({ bounds: receipt.requested, options: {}, create: f.create })).toEqual([])
  expect(f.windows).toHaveLength(4)
  expect(f.windows.every((window) => window.destroyed)).toBe(true)
})

test("window observations cannot turn the original bounds failure into a successful report", () => {
  const checks = COMPUTER_SMOKE_CHECKS.map((name) => ({ name, ok: true }))
  checks[1] = { name: "overlay-bounds", ok: false }
  const report = {
    protocol: 1,
    platform: "win32",
    electron: "42.11.4",
    checks: checks.map((check) => (check.ok ? check : { ...check, reason: "assertion_failed" })),
  }
  const stdout = line(receipt) + "\n" + COMPUTER_SMOKE_MARK + JSON.stringify(report)
  expect(parseComputerSmokeReport(stdout, { electron: report.electron, platform: "win32", exitCode: 1 })).toEqual(
    report,
  )
  expect(() =>
    parseComputerSmokeReport(stdout, { electron: report.electron, platform: "win32", exitCode: 0 }),
  ).toThrow()
})
