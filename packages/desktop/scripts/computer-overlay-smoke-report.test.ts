import { describe, expect, test } from "bun:test"
import { Script } from "node:vm"
import { EventEmitter } from "node:events"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerOverlayPage } from "@vectordevai/app/computer/overlay-page"
import {
  COMPUTER_SMOKE_CHECKS,
  COMPUTER_SMOKE_MARK,
  COMPUTER_SMOKE_PHASE_MARK,
  COMPUTER_SMOKE_CONTROLLER_MARK,
  COMPUTER_SMOKE_CONTROLLER_STEPS,
  parseComputerSmokeController,
  COMPUTER_SMOKE_GEOMETRY_MARK,
  COMPUTER_SMOKE_NATIVE_MARK,
  parseComputerSmokeNativeDiagnostic,
  parseComputerSmokeGeometry,
  type ComputerSmokeControllerStep,
  COMPUTER_SMOKE_FAILURE_MARK,
  COMPUTER_SMOKE_PHASES,
  parseComputerSmokePhase,
  parseComputerSmokeFailure,
  computerSmokeRuntimeHint,
  computerSmokeLoaderHint,
  computerSmokeLoaderModule,
  computerSmokeBootstrapSource,
  computerSmokeBannerProbe,
  computerSmokeControllerReady,
  COMPUTER_SMOKE_TRANSPARENCY_PROBE,
  computerSmokeTransparentBackground,
  COMPUTER_SMOKE_LOADER_STARTED,
  type ComputerSmokeLastPhase,
  parseComputerSmokeReport,
  type ComputerSmokeReport,
  COMPUTER_SMOKE_EXCEPTION_MARK,
  computerSmokeException,
  parseComputerSmokeException,
  installComputerSmokeExceptionHooks,
  type ComputerSmokeException,
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

test("geometry diagnostics retain only bounded owned-window rectangles, native sizes and a fixed kind", () => {
  const value = {
    protocol: 1,
    window: 3,
    kind: "left",
    expected: { x: -1920, y: 12, width: 12, height: 1056 },
    actual: { x: -1920, y: 12, width: 64, height: 1056 },
    minimum: [12, 1056],
    maximum: [0, 0],
    content: [64, 1056],
  }
  const line = (value: unknown) => COMPUTER_SMOKE_GEOMETRY_MARK + JSON.stringify(value)
  const parsed = parseComputerSmokeGeometry(line(value))
  expect(parsed).toEqual(value)
  expect(parsed).not.toBe(value)
  expect(parsed.expected).not.toBe(value.expected)
  expect(parsed.minimum).not.toBe(value.minimum)
  expect(parsed.maximum).not.toBe(value.maximum)
  expect(parsed.content).not.toBe(value.content)
  const failed = report("win32")
  failed.checks[1] = { name: "overlay-bounds", ok: false, reason: "assertion_failed" }
  const stdout = line(value) + "\n" + COMPUTER_SMOKE_MARK + JSON.stringify(failed)
  expect(parseComputerSmokeReport(stdout, { electron: failed.electron, platform: "win32", exitCode: 1 })).toEqual(
    failed,
  )
  expect(() =>
    parseComputerSmokeReport(stdout, { electron: failed.electron, platform: "win32", exitCode: 0 }),
  ).toThrow()
  for (const patch of [
    { protocol: 2 },
    { window: -1 },
    { window: 129 },
    { window: 0.5 },
    { kind: "private-window-title" },
    { kind: ["left"] },
    { expected: { ...value.expected, title: "PRIVATE" } },
    { actual: { ...value.actual, path: "PRIVATE" } },
    { expected: { x: 0, y: 0, width: 1 } },
    { actual: { ...value.actual, width: 0 } },
    { actual: { ...value.actual, x: 1_000_001 } },
    { actual: { ...value.actual, y: Number.POSITIVE_INFINITY } },
    { actual: { ...value.actual, width: "64" } },
    { minimum: undefined },
    { minimum: [12] },
    { maximum: [0, 0, 1] },
    { content: [64, "PRIVATE"] },
    { minimum: [-1, 24] },
    { maximum: [0, 1_000_001] },
    { content: [1, Number.NaN] },
    { content: { width: 64, height: 1056 } },
    { display: "PRIVATE" },
  ])
    expect(() => parseComputerSmokeGeometry(line({ ...value, ...patch }))).toThrow()
  expect(() => parseComputerSmokeGeometry(line(value) + " ".repeat(513))).toThrow()
  expect(() => parseComputerSmokeGeometry(COMPUTER_SMOKE_GEOMETRY_MARK + "{")).toThrow()
})

test("native proof diagnostics retain fixed boundary/result facts without changing failed reports or exits", () => {
  const line = (value: unknown) => COMPUTER_SMOKE_NATIVE_MARK + JSON.stringify(value)
  const boundary = { protocol: 1, kind: "boundary", phase: "ready", cause: "stream_invalid" }
  expect(parseComputerSmokeNativeDiagnostic(line(boundary))).toEqual(boundary)
  const artifact = {
    ...boundary,
    phase: "artifact",
    cause: "file_hash",
    role: "fake",
    ordinal: 17,
    architecture: "arm64",
  }
  expect(parseComputerSmokeNativeDiagnostic(line(artifact))).toEqual(artifact)
  for (const patch of [
    { role: "PRIVATE" },
    { ordinal: -1 },
    { ordinal: 8192 },
    { ordinal: 1.5 },
    { ordinal: "PRIVATE" },
    { role: undefined },
    { architecture: "aarch64" },
    { architecture: "PRIVATE" },
    { phase: "ready" },
    { path: "PRIVATE" },
    { hash: "PRIVATE" },
  ])
    expect(() => parseComputerSmokeNativeDiagnostic(line({ ...artifact, ...patch }))).toThrow()
  const result = {
    protocol: 1,
    kind: "result",
    phase: "exit",
    stop: { ok: false, reason: "parent_invalid" },
    exitCode: 1,
  }
  const parsed = parseComputerSmokeNativeDiagnostic(line(result))
  expect(parsed).toEqual(result)
  expect(parsed).not.toBe(result)
  if (parsed.kind !== "result") throw new Error("Expected result diagnostic.")
  expect(parsed.stop).not.toBe(result.stop)
  const skipped = {
    ...result,
    stop: { ok: false, skipped: true, reason: "screen_denied" },
    capture: { ok: false, skipped: true, reason: "screen_denied" },
    exitCode: 77,
  }
  expect(parseComputerSmokeNativeDiagnostic(line(skipped))).toEqual(skipped)
  expect(parseComputerSmokeNativeDiagnostic(line({ ...result, stop: { ok: true }, exitCode: 0 }))).toEqual({
    ...result,
    stop: { ok: true },
    exitCode: 0,
  })
  const failed = report("darwin")
  failed.checks[16] = { name: "native-os-stop", ok: false, reason: "native_proof_invalid" }
  failed.checks[17] = { name: "native-capture-exclusion", ok: false, reason: "native_proof_invalid" }
  const stdout = line(result) + "\n" + line(boundary) + "\n" + COMPUTER_SMOKE_MARK + JSON.stringify(failed)
  expect(parseComputerSmokeReport(stdout, { electron: failed.electron, platform: "darwin", exitCode: 1 })).toEqual(
    failed,
  )
  expect(() =>
    parseComputerSmokeReport(stdout, { electron: failed.electron, platform: "darwin", exitCode: 0 }),
  ).toThrow()
  for (const patch of [
    { protocol: 2 },
    { kind: "PRIVATE" },
    { phase: "PRIVATE" },
    { stop: { ok: false, reason: "PRIVATE" } },
    { stop: { ok: false, reason: "artifact_invalid", skipped: true } },
    { stop: { ok: true, reason: "screen_denied" } },
    { stop: { ok: false } },
    { stop: { ok: false, reason: "parent_invalid", path: "PRIVATE" } },
    { capture: { ok: false, reason: "PRIVATE" } },
    { capture: { ok: false, skipped: true, reason: "capture_failed" } },
    { exitCode: -1 },
    { exitCode: 256 },
    { exitCode: "1" },
    { nonce: "PRIVATE" },
    { path: "PRIVATE" },
    { pid: 123 },
    { stderr: "PRIVATE" },
  ])
    expect(() => parseComputerSmokeNativeDiagnostic(line({ ...result, ...patch }))).toThrow()
  for (const patch of [{ cause: "PRIVATE" }, { phase: "PRIVATE" }, { stop: { ok: true } }, { error: "PRIVATE" }])
    expect(() => parseComputerSmokeNativeDiagnostic(line({ ...boundary, ...patch }))).toThrow()
  expect(() => parseComputerSmokeNativeDiagnostic(line(result) + " ".repeat(513))).toThrow()
  expect(() => parseComputerSmokeNativeDiagnostic(COMPUTER_SMOKE_NATIVE_MARK + "{")).toThrow()
})

describe("fixed real Electron computer smoke reports", () => {
  test("checks fixed banner title separately from delivered Working state and enabled Stop", () => {
    const view = ComputerOverlayPage.bannerView({
      phase: "working",
      backend: "local-macos",
      mode: "foreground",
      holder: { sessionID: "smoke", directory: "/fixture", title: "Controlled", startedAt: 1, actions: 0 },
      apps: [],
      queue: [],
      escStops: false,
      stopChord: Hands.STOP_CHORD.darwin,
      lease: 1,
      reduceMotion: true,
    })
    expect(view?.line).toBe("Working")
    expect(ComputerOverlayPage.bannerPage()).toContain(`<span class="title">${Hands.BANNER}</span>`)
    const elements = {
      ".title": { textContent: Hands.BANNER },
      ".line": { textContent: view!.line },
      'button[data-action="stop"]': { textContent: "Stop", disabled: false },
    }
    const script = new Script(computerSmokeBannerProbe(Hands.BANNER, view!.line))
    const observe = () =>
      script.runInNewContext({
        document: { querySelector: (selector: keyof typeof elements) => elements[selector] },
      })
    expect(observe()).toBe(true)
    elements[".line"].textContent = Hands.BANNER
    expect(observe()).toBe(false)
    elements[".line"].textContent = view!.line
    elements['button[data-action="stop"]'].disabled = true
    expect(observe()).toBe(false)
  })
  test("requires native RGB, configured window alpha and independently observed page alpha", () => {
    const config = { transparent: true, backgroundColor: "#00000000" }
    const root = { backgroundColor: "rgba(0, 0, 0, 0)" }
    const body = { backgroundColor: "rgba(0, 0, 0, 0)" }
    const script = new Script(COMPUTER_SMOKE_TRANSPARENCY_PROBE)
    const observe = () =>
      script.runInNewContext({
        document: { documentElement: root, body },
        getComputedStyle: (element: typeof root) => element,
      })
    expect(observe()).toBe(true)
    expect(computerSmokeTransparentBackground(config, "#000000", observe())).toBe(true)
    // The documented getter drops alpha: never infer transparency from native black alone.
    for (const color of ["#ffffff", "#00000000", "transparent"])
      expect(computerSmokeTransparentBackground(config, color, observe())).toBe(false)
    expect(computerSmokeTransparentBackground({ ...config, transparent: false }, "#000000", true)).toBe(false)
    expect(computerSmokeTransparentBackground({ ...config, backgroundColor: "#ff000000" }, "#000000", true)).toBe(false)
    root.backgroundColor = "rgb(0, 0, 0)"
    expect(observe()).toBe(false)
    expect(computerSmokeTransparentBackground(config, "#000000", observe())).toBe(false)
    root.backgroundColor = "rgba(0, 0, 0, 0)"
    body.backgroundColor = "rgba(0, 0, 0, 1)"
    expect(observe()).toBe(false)
  })
  test("controller fault admission waits for its indicator and rejects pre-ready lease or window loss", async () => {
    const ready = Promise.withResolvers<void>()
    let armed = false
    const live = { isDestroyed: () => false, isVisible: () => true }
    const pending = computerSmokeControllerReady(
      ready.promise,
      () => true,
      () => [live],
    ).then(() => {
      armed = true
    })
    await Promise.resolve()
    expect(armed).toBe(false)
    ready.resolve()
    await pending
    expect(armed).toBe(true)

    for (const loss of ["lease", "absent", "hidden", "destroyed"] as const) {
      const delayed = Promise.withResolvers<void>()
      let current = true
      let visible = true
      let destroyed = false
      let owned = true
      let injected = false
      const indicator = { isDestroyed: () => destroyed, isVisible: () => visible }
      const admission = computerSmokeControllerReady(
        delayed.promise,
        () => current,
        () => (owned ? [indicator] : []),
      ).then(() => {
        injected = true
      })
      const refused = admission.then(
        () => undefined,
        (error: unknown) => error,
      )
      if (loss === "lease") current = false
      if (loss === "absent") owned = false
      if (loss === "hidden") visible = false
      if (loss === "destroyed") destroyed = true
      delayed.resolve()
      expect(await refused).toBeInstanceOf(Error)
      expect(injected).toBe(false)
    }
    await expect(
      computerSmokeControllerReady(
        Promise.reject(new Error("not ready")),
        () => true,
        () => [live],
      ),
    ).rejects.toThrow("not ready")
  })
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
  test("controller receipts identify only ordered fixed owned-fixture waits", () => {
    const receipt = (step: string) => COMPUTER_SMOKE_CONTROLLER_MARK + JSON.stringify({ protocol: 1, step })
    let previous: ComputerSmokeControllerStep | undefined
    for (const step of COMPUTER_SMOKE_CONTROLLER_STEPS) previous = parseComputerSmokeController(receipt(step), previous)
    expect(previous).toBe("native-close")
    expect(parseComputerSmokeController(receipt("stop-close"), "stop-acquire")).toBe("stop-close")
    for (const step of ["stop-check", "PRIVATE", "native-close"])
      expect(() => parseComputerSmokeController(receipt(step))).toThrow()
    expect(() => parseComputerSmokeController(receipt("stop-check"), "stop-check")).toThrow()
    expect(() => parseComputerSmokeController(receipt("stop-acquire"), "stop-close")).toThrow()
    for (const value of [
      { protocol: 2, step: "underlay" },
      { protocol: 1, step: "underlay", private: "PRIVATE" },
    ])
      expect(() => parseComputerSmokeController(COMPUTER_SMOKE_CONTROLLER_MARK + JSON.stringify(value))).toThrow()
    expect(() => parseComputerSmokeController(receipt("underlay") + " ".repeat(161))).toThrow()
  })
  test("runtime stderr is classified into fixed hints without returning any raw field", () => {
    for (const [text, hint] of [
      ["Authorization required, but no authorization protocol specified\n/private/xauthority-cookie", "display_auth"],
      ["Missing X server or $DISPLAY: private-display-value", "display_unavailable"],
      ["The platform failed to initialize. Exiting.", "display_unavailable"],
      ["No usable sandbox! private-runtime-path", "sandbox_unavailable"],
      ["Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/fixture/main.mjs'", "loader_module_not_found"],
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

describe("generic Electron ESM loader catch boundary", () => {
  const cases: readonly (readonly [unknown, string])[] = [
    [{ code: "ERR_MODULE_NOT_FOUND", message: "/private/module-path" }, "loader_module_not_found"],
    [{ code: "ERR_REQUIRE_ESM", message: "/private/module-path" }, "loader_require_esm"],
    [{ code: "ERR_REQUIRE_ASYNC_MODULE", message: "/private/module-path" }, "loader_require_async"],
    [{ code: "ERR_UNKNOWN_FILE_EXTENSION", message: "/private/extension" }, "loader_extension"],
    [new ReferenceError("Bun is not defined"), "loader_bun_undefined"],
    [new ReferenceError("require is not defined in ES module scope"), "loader_require_undefined"],
    [new ReferenceError("__dirname is not defined in ES module scope"), "loader_dirname_undefined"],
    [new ReferenceError("__filename is not defined in ES module scope"), "loader_filename_undefined"],
    [
      new SyntaxError("The requested module '/private/module' does not provide an export named 'private'"),
      "loader_named_export",
    ],
    [new Error("The screen module cannot be used before the app ready event"), "loader_app_not_ready"],
    [new ReferenceError("a private identifier is absent"), "loader_reference_error"],
    [new TypeError("private application text"), "loader_type_error"],
    [new SyntaxError("private application text"), "loader_syntax_error"],
    [{ code: "private-code", name: "private-name", message: "private application text" }, "loader_failed"],
  ]
  test("actual loader error codes and names project to closed hints without returning their text", () => {
    for (const [value, hint] of cases) expect(computerSmokeLoaderHint(value)).toBe(hint)
    expect(
      computerSmokeLoaderHint({
        get code() {
          throw new Error("private getter")
        },
      }),
    ).toBe("loader_failed")
    expect(computerSmokeLoaderHint(null)).toBe("loader_failed")
    expect(computerSmokeRuntimeHint("Error [ERR_REQUIRE_ASYNC_MODULE]: private source path")).toBe(
      "loader_require_async",
    )
  })
  test("the generated CJS catch boundary parses and targets only its fixed sibling bundle", () => {
    const source = computerSmokeBootstrapSource()
    expect(() => new Script(source)).not.toThrow()
    expect(source).toContain(COMPUTER_SMOKE_LOADER_STARTED)
    expect(source).toContain('path.join(__dirname, "computer-overlay-smoke-electron.mjs")')
    expect(source).not.toMatch(/process\.argv|process\.env|console\.|error\.stack/)
    expect(source.indexOf('app.setPath("sessionData"')).toBeLessThan(source.indexOf("import(mainURL)"))
  })
  test("the child CJS classifier matches the parent's pure classification without executing Electron or imports", () => {
    const source = computerSmokeBootstrapSource()
    const classifier = source.slice(source.indexOf("const codes ="), source.indexOf("function failed("))
    const script = new Script(classifier + "\nhint(error)")
    for (const [error, hint] of cases) expect(script.runInNewContext({ error }, { timeout: 100 })).toBe(hint)
  })
})

describe("closed loader module categories", () => {
  const mainURL = "file:///isolated/smoke/computer-overlay-smoke-electron.mjs"
  const cases: readonly (readonly [unknown, string])[] = [
    [{ message: "Cannot find package 'electron' imported from /private/source" }, "electron"],
    [{ message: 'Cannot find module "jsonc-parser"', url: mainURL }, "jsonc-parser"],
    [{ moduleName: "electron" }, "electron"],
    [{ moduleName: "electron/main" }, "other"],
    [{ moduleName: "jsonc-parser/unknown" }, "other"],
    [{ moduleName: "node:fs/promises" }, "node_builtin"],
    [{ message: "Cannot find module 'fs/promises'" }, "node_builtin"],
    [{ moduleName: "@vectordevai/schema/computer" }, "workspace"],
    [{ url: mainURL }, "relative_main"],
    [{ moduleName: "./computer-overlay-smoke-electron.mjs" }, "relative_main"],
    [{ message: "Cannot find module './impl/parser'" }, "relative_other"],
    [{ moduleName: "../private/dependency" }, "relative_other"],
    [{ moduleName: "/private/dependency" }, "absolute"],
    [{ moduleName: String.raw`C:\private\dependency` }, "absolute"],
    [{ url: "file:///different/smoke/computer-overlay-smoke-electron.mjs" }, "absolute"],
    [{ path: "/private/package.json" }, "absolute"],
    [{ moduleName: "unlisted-package", url: mainURL }, "other"],
    [{ message: "private arbitrary text" }, "other"],
    [
      {
        get moduleName() {
          throw new Error("private getter")
        },
      },
      "other",
    ],
    [null, "other"],
  ]
  test("returns exact allowed package ids or path classes without returning requested text", () => {
    for (const [error, category] of cases) expect(computerSmokeLoaderModule(error, mainURL)).toBe(category)
    expect(
      computerSmokeLoaderModule(
        {
          get message() {
            throw new Error("private getter")
          },
        },
        mainURL,
      ),
    ).toBe("other")
  })
  test("generated CJS categorization matches the pure classifier without executing Electron or imports", () => {
    const source = computerSmokeBootstrapSource()
    const classifier = source.slice(source.indexOf("const codes ="), source.indexOf("function failed("))
    expect(classifier).not.toContain("pathToFileURL")
    const script = new Script(classifier + "\nmoduleKind(error, expectedMain)")
    for (const [error, category] of cases)
      expect(script.runInNewContext({ error, expectedMain: mainURL }, { timeout: 100 })).toBe(category)
  })
  test("failure receipts preserve only the closed module category and reject arbitrary fields", () => {
    const value = {
      protocol: 1,
      cause: "runtime_failed",
      phase: "none",
      hint: "loader_module_not_found",
      module: "relative_other",
    }
    expect(parseComputerSmokeFailure(COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify(value))).toEqual(value)
    for (const patch of [
      { module: "/private/path" },
      { module: "private-package" },
      { moduleName: "private-package" },
      { path: "/private/path" },
      { url: "file:///private/path" },
    ])
      expect(() =>
        parseComputerSmokeFailure(COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify({ ...value, ...patch })),
      ).toThrow()
  })
})

describe("closed fatal Electron exception diagnostics", () => {
  const bundle = "file:///PRIVATE/fixture/computer-overlay-smoke-electron.mjs"
  const receipt = (value: unknown) => COMPUTER_SMOKE_EXCEPTION_MARK + JSON.stringify(value)
  test("classifies standard errors and only exact owned bundle locations without observed text", () => {
    const error = Object.assign(new TypeError("PRIVATE user text"), {
      code: "EPIPE",
      stack: `TypeError: PRIVATE user text\n    at PRIVATE_FN (file:///PRIVATE/other.mjs:11:8)\n    at Object.close27 (${bundle}:123:45)\n    at lost (${bundle}:222:1)`,
    })
    const value = computerSmokeException("uncaughtException", error, bundle)
    expect(value).toEqual({
      protocol: 1,
      origin: "uncaughtException",
      name: "TypeError",
      code: "EPIPE",
      at: { fn: "close", line: 123, column: 45 },
    })
    expect(parseComputerSmokeException(receipt(value))).toEqual(value)
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|user text|file:/)
    expect(
      computerSmokeException(
        "unhandledRejection",
        { name: "PRIVATE", code: "PRIVATE", stack: `PRIVATE\n at PRIVATE_FN (${bundle}:3:4)` },
        bundle,
      ),
    ).toEqual({
      protocol: 1,
      origin: "unhandledRejection",
      name: "other",
      code: "none",
      at: { fn: "other", line: 3, column: 4 },
    })
    expect(computerSmokeException("unhandledRejection", { stack: `PRIVATE\n at ${bundle}:3:4` }, bundle).at).toEqual({
      fn: "anonymous",
      line: 3,
      column: 4,
    })
  })
  test("never invokes custom error getters, formatting or string coercion", () => {
    let reads = 0
    const hostile = Object.defineProperties(
      {},
      Object.fromEntries(
        ["name", "code", "stack", "message", "toString"].map((key) => [
          key,
          {
            get() {
              reads++
              throw new Error("PRIVATE")
            },
          },
        ]),
      ),
    )
    expect(computerSmokeException("uncaughtException", hostile, bundle)).toEqual({
      protocol: 1,
      origin: "uncaughtException",
      name: "other",
      code: "none",
    })
    expect(reads).toBe(0)
    const lazy = Object.defineProperty(new Error(), "message", {
      get() {
        reads++
        throw new Error("PRIVATE")
      },
    })
    expect(computerSmokeException("uncaughtException", lazy, bundle).at).toBeUndefined()
    expect(reads).toBe(0)
    const stopped = computerSmokeException(
      "uncaughtException",
      {
        name: "ComputerError",
        code: "stopped",
        stack: `ComputerError: PRIVATE\n at requireRun (${bundle}:1000:2)\n at Timeout._onTimeout (${bundle}:1200:4)`,
      },
      bundle,
    )
    expect(stopped).toEqual({
      protocol: 1,
      origin: "uncaughtException",
      name: "other",
      code: "stopped",
      at: { fn: "requireRun", line: 1000, column: 2 },
    })
    expect(parseComputerSmokeException(receipt(stopped))).toEqual(stopped)
    for (const reason of [
      undefined,
      null,
      "PRIVATE",
      123,
      Symbol("PRIVATE"),
      {
        toString() {
          throw new Error("PRIVATE")
        },
      },
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("PRIVATE")
          },
        },
      ),
    ])
      expect(() => computerSmokeException("unhandledRejection", reason, bundle)).not.toThrow()
    const inherited = Object.create(
      Object.defineProperty({}, "name", {
        get() {
          reads++
          return "Error"
        },
      }),
    )
    expect(computerSmokeException("uncaughtException", inherited, bundle).name).toBe("other")
    expect(reads).toBe(0)
  })
  test("foreign, truncated and out-of-bound stack frames cannot become an owned location", () => {
    for (const stack of [
      `PRIVATE ${bundle}:1:2`,
      `Error\n at close (${bundle}.PRIVATE:1:2)`,
      `Error\n at close (${bundle}?PRIVATE:1:2)`,
      `Error\n at close (${bundle}:0:1)`,
      `Error\n at close (${bundle}:1:10000001)`,
      "PRIVATE".repeat(1400) + `\n at close (${bundle}:1:2)`,
      "Error\n" + "    at PRIVATE (file:///PRIVATE/other.mjs:1:2)\n".repeat(32) + ` at close (${bundle}:1:2)`,
    ])
      expect(computerSmokeException("uncaughtException", { stack }, bundle).at).toBeUndefined()
    expect(
      computerSmokeException(
        "uncaughtException",
        { stack: `Error\n at close (${bundle}:1:2)` },
        "https://PRIVATE/computer-overlay-smoke-electron.mjs",
      ).at,
    ).toBeUndefined()
  })
  test("strict receipts reject private fields, unknown categories and invalid locations", () => {
    const fixed: ComputerSmokeException = {
      protocol: 1,
      origin: "uncaughtException",
      name: "Error",
      code: "none",
      at: { fn: "close", line: 1, column: 1 },
    }
    expect(parseComputerSmokeException(receipt(fixed))).toEqual(fixed)
    for (const value of [
      { ...fixed, protocol: 2 },
      { ...fixed, origin: "PRIVATE" },
      { ...fixed, name: "PRIVATE" },
      { ...fixed, code: "PRIVATE" },
      { ...fixed, message: "PRIVATE" },
      { ...fixed, stack: "PRIVATE" },
      { ...fixed, at: null },
      { ...fixed, at: { ...fixed.at, fn: "PRIVATE" } },
      { ...fixed, at: { ...fixed.at, line: 0 } },
      { ...fixed, at: { ...fixed.at, column: 1.5 } },
      { ...fixed, at: { ...fixed.at, line: 10000001 } },
      { ...fixed, at: { ...fixed.at, path: "PRIVATE" } },
    ])
      expect(() => parseComputerSmokeException(receipt(value))).toThrow()
    expect(() => parseComputerSmokeException(receipt(fixed) + " ".repeat(513))).toThrow()
    expect(() => parseComputerSmokeException(COMPUTER_SMOKE_EXCEPTION_MARK + "{")).toThrow()
  })
  test("actual EventEmitter listener count suppresses Electron's default dialog and reports only first failure", () => {
    const events = new EventEmitter()
    let dialogs = 0
    const failures: ComputerSmokeException[] = []
    // Exact condition from Electron42.11.4 browser/init.ts's existing first listener.
    events.on("uncaughtException", () => {
      if (events.listenerCount("uncaughtException") > 1) return
      dialogs++
    })
    installComputerSmokeExceptionHooks(events, bundle, (value) => failures.push(value))
    events.emit("uncaughtException", Object.assign(new Error("PRIVATE"), { code: "ERR_STREAM_DESTROYED" }))
    events.emit("unhandledRejection", new RangeError("PRIVATE"))
    events.emit("uncaughtException", new Error("PRIVATE"))
    expect(dialogs).toBe(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ origin: "uncaughtException", name: "Error", code: "ERR_STREAM_DESTROYED" })
    expect(events.listenerCount("uncaughtException")).toBe(2)
    expect(events.listenerCount("unhandledRejection")).toBe(1)
    const rejection = new EventEmitter()
    const rejected: ComputerSmokeException[] = []
    installComputerSmokeExceptionHooks(rejection, bundle, (value) => rejected.push(value))
    rejection.emit("unhandledRejection", new RangeError("PRIVATE"))
    rejection.emit("uncaughtException", new Error("PRIVATE"))
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ origin: "unhandledRejection", name: "RangeError", code: "none" })
    expect(JSON.stringify([...failures, ...rejected])).not.toContain("PRIVATE")
  })
})
