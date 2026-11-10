import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  COMPUTER_OVERLAY_ENTRYPOINTS,
  computerOverlayModuleReferences,
  computerOverlaySourceDigest,
  computerOverlaySourceGraph,
  verifyComputerOverlayBundleGraph,
} from "./computer-overlay-smoke-source"
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vector-overlay-source-test-"))
  temporary.push(root)
  const desktop = path.join(root, "packages/desktop")
  for (const file of [
    "package.json",
    "bun.lock",
    "packages/desktop/package.json",
    "packages/desktop/tsconfig.json",
    ...COMPUTER_OVERLAY_ENTRYPOINTS.map((entry) => `packages/desktop/${entry.input}`),
    "packages/desktop/src/main/dependency.ts",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(
      path.join(root, file),
      file === "package.json"
        ? JSON.stringify({ packageManager: "bun@1.3.14" })
        : file.endsWith(".json")
          ? "{}"
          : file.endsWith("computer-overlay-smoke-electron.ts")
            ? 'import "../src/main/dependency"\n'
            : "export const fixture = 1\n",
    )
  }
  return {
    root,
    desktop,
    entry: path.join(desktop, COMPUTER_OVERLAY_ENTRYPOINTS[0].input),
    dependency: path.join(desktop, "src/main/dependency.ts"),
  }
}
describe("independent overlay source admission", () => {
  test("a local assertion named require never invents a dependency from a string expression", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      import { value } from "./real-dependency"
      function require(value: unknown): asserts value { if (!value) throw new Error("assertion") }
      const result = { lease: 1 }
      require("lease" in result)
      require(value)
    `,
    )
    expect(references).toEqual(["./real-dependency"])
  })
  test("lexical require shadows apply only inside their actual scope", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      const outside = require("./outer-dependency")
      function check(result: object) {
        function require(value: unknown): asserts value { if (!value) throw new Error("assertion") }
        require("lease" in result)
      }
      const again = require.resolve("./resolved-dependency")
    `,
    )
    expect(references).toEqual(["./outer-dependency", "./resolved-dependency"])
  })
  test("real Node module loaders require one literal import and cannot hide runtime-selected modules", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      import { createRequire } from "node:module"
      const load = createRequire(import.meta.url)
      const loaded = load("./actual-dependency")
      export * from "./exported-dependency"
      type Shape = import("./type-dependency").Shape
    `,
    )
    expect(references).toEqual(["node:module", "./actual-dependency", "./exported-dependency", "./type-dependency"])
    for (const source of [
      'const name = "./dependency"; require(name)',
      'const result = {}; require("lease" in result)',
      'const name = "./dependency"; require.resolve(name)',
      'const name = "./dependency"; module.require(name)',
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load(name)',
      'const name = "./dependency"; import(name)',
    ])
      expect(() => computerOverlayModuleReferences("/fixture/entry.ts", source)).toThrow("unbounded runtime import")
  })

  test("only the native Windows bootstrap enables renderer accessibility before Electron starts", async () => {
    const desktop = fileURLToPath(new URL("../", import.meta.url))
    const driver = await readFile(path.join(desktop, "native/computer-helper/windows/src/overlay_driver.cpp"), "utf8")
    const launch = driver.match(/^int launch_electron\([^]*?^\}/m)?.[0]
    expect(launch).toBeString()
    const command = launch!.match(/std::wstring command = ([^\n]+);/)?.[1]
    expect(command).toBeString()
    expect(command!.match(/--force-renderer-accessibility/g)).toHaveLength(1)
    expect(command!.indexOf("--force-renderer-accessibility")).toBeLessThan(command!.indexOf("files.main.path"))
    expect(launch!.indexOf("std::wstring command")).toBeLessThan(launch!.indexOf("CreateProcessAsUserW("))
    expect(launch!.indexOf("std::wstring command")).toBeLessThan(launch!.indexOf("CreateProcessW("))
    expect(launch).toContain("const auto preserved = command")
    expect(launch).toContain("command = preserved; launched = CreateProcessAsUserW(")
    expect(driver.replace(launch!, "")).not.toContain("--force-renderer-accessibility")
    expect(driver).toContain("if (options.mode == OverlayDriverMode::launch_electron)")
    const smoke = await readFile(path.join(desktop, "scripts/computer-overlay-smoke.ts"), "utf8")
    expect(smoke).toContain('const bootstrapStage = process.platform === "win32" ? stage : undefined')
    expect(smoke).toContain('? ["--launch-electron", "--nonce", nonce]')
    for (const file of [
      "scripts/computer-overlay-smoke.ts",
      "scripts/computer-overlay-smoke-electron.ts",
      "native/computer-helper/macos/TestOverlayDriver/main.swift",
      "src/main/index.ts",
      "test/computer/fake-helper.ts",
    ])
      expect(await readFile(path.join(desktop, file), "utf8"), file).not.toContain("--force-renderer-accessibility")
    expect(await readFile(path.join(desktop, "scripts/computer-overlay-smoke-electron.ts"), "utf8")).toContain(
      "app.setAccessibilitySupportEnabled(true)",
    )
  })
  test("the optional UIA observer owns only a shared atomic phase across late native work", async () => {
    const native = path.join(fileURLToPath(new URL("../", import.meta.url)), "native/computer-helper/windows/src")
    const header = await readFile(path.join(native, "uia_native.h"), "utf8")
    const implementation = await readFile(path.join(native, "uia_native.cpp"), "utf8")
    const driver = await readFile(path.join(native, "overlay_driver.cpp"), "utf8")
    expect(header).toContain("system(std::shared_ptr<WindowsUiaDiagnostic> diagnostic = {})")
    expect(header).toContain("std::atomic<WindowsUiaPhase> phase{WindowsUiaPhase::none}")
    expect(header).toContain("std::atomic<WindowsUiaPhase>::is_always_lock_free")
    expect(header.match(/friend class NativeUia;/g)).toHaveLength(1)
    expect(header.match(/enum class WindowsUiaPhase/g)).toHaveLength(1)
    expect(implementation).toContain("std::shared_ptr<WindowsUiaDiagnostic> diagnostic;")
    expect(implementation).toContain("actor->diagnostic = std::move(diagnostic)")
    expect(implementation).toContain("[self = shared_from_this(), promise, ticket, body = std::move(body)]")
    expect(implementation).toContain("state->phase.store(phase, std::memory_order_relaxed)")
    expect(implementation).not.toMatch(/WindowsUiaDiagnostic\s*[*&]/)
    expect(driver).toContain("std::make_shared<WindowsUiaDiagnostic>()")
    expect(driver).toContain("WindowsUiaBackend::system(uia_diagnostic)")
    expect(driver).toContain("diagnostic->phase.load(std::memory_order_relaxed)")
    const rootFailure = driver.slice(
      driver.indexOf("try { root = uia.root(window); }"),
      driver.indexOf("stage = OverlayDriverStage::stop_hit;"),
    )
    expect(rootFailure.match(/uia\.available\(\)/g)).toHaveLength(1)
    expect(rootFailure).toContain("if (available && diagnostic)")
    for (const phase of ["uninitialized", "cancellation_unavailable", "timer_unavailable", "expired"])
      expect(implementation).toContain(`WindowsComObservation::${phase}: note(WindowsUiaPhase::actor_com_${phase})`)
    expect(implementation).toContain("if (!actor_->diagnostic) return;")
    expect(
      implementation.match(/if \(!budget\.current\(\)\) \{ self->note_budget_failure\(budget\); unavailable\(\); \}/g),
    ).toHaveLength(2)
  })
  test("only keyboard focusability uses its documented negative default and cannot authorize focus", async () => {
    const native = path.join(fileURLToPath(new URL("../", import.meta.url)), "native/computer-helper/windows/src")
    const implementation = await readFile(path.join(native, "uia_native.cpp"), "utf8")
    const service = await readFile(path.join(native, "accessibility.cpp"), "utf8")
    const security = implementation.slice(
      implementation.indexOf("UiaSecurity security("),
      implementation.indexOf("UiaName name("),
    )
    expect(security.match(/GetCachedPropertyValueEx\([^;]+, FALSE,/g)).toHaveLength(1)
    expect(security).toContain("GetCachedPropertyValueEx(UIA_IsKeyboardFocusablePropertyId, FALSE, &keyboard.value)")
    expect(security).toContain("FAILED(cached->GetCachedPropertyValueEx(id, TRUE, &result)) || result.vt != expected")
    expect(security).toContain("GetCachedPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, &password.value)")
    for (const [property, kind] of [
      ["ProcessId", "VT_I4"],
      ["ControlType", "VT_I4"],
      ["IsEnabled", "VT_BOOL"],
      ["HasKeyboardFocus", "VT_BOOL"],
    ])
      expect(security).toContain(`property(UIA_${property}PropertyId, ${kind},`)
    expect(security).toContain("classify_uia_keyboard_focusable(keyboard_status, keyboard.value)")
    expect(security).toContain("result.keyboard_focusable = *keyboard_focusable")
    expect(security).toContain(
      "FAILED(keyboard_status) ? WindowsUiaPhase::security_keyboard_query_failed : WindowsUiaPhase::security_keyboard_variant_invalid",
    )
    expect(implementation).toContain(
      'if (action == L"AXRaise" || action == L"SetFocus") { if (!state.keyboard_focusable) return false;',
    )
    expect(service).toContain(
      'if (!setting && (*payload == L"SetFocus" || *payload == L"AXRaise") && !prepared.native.security.keyboard_focusable) failure(L"unsupported_action");',
    )
    expect(implementation).toContain("live.keyboard_focusable != old.keyboard_focusable")
    expect(implementation).toContain("value.boolVal == VARIANT_TRUE")
  })
  test("pattern flags require explicit booleans or exact unsupported-marker capability proofs", async () => {
    const native = path.join(fileURLToPath(new URL("../", import.meta.url)), "native/computer-helper/windows/src")
    const implementation = await readFile(path.join(native, "uia_native.cpp"), "utf8")
    const reader = implementation.slice(
      implementation.indexOf("struct PatternPhases"),
      implementation.indexOf("IUIAutomationElement* native("),
    )
    expect(reader).toContain("cached->GetCachedPropertyValueEx(property, TRUE, &reported.value)")
    expect(reader).toContain("if (status != S_OK) { note(phases.query_failed); unavailable(); }")
    const boolean = reader.slice(
      reader.indexOf("if (reported.value.vt == VT_BOOL)"),
      reader.indexOf("// Availability defaults"),
    )
    expect(boolean).toContain("if (reported.value.boolVal == VARIANT_TRUE) return true;")
    expect(boolean).toContain("if (reported.value.boolVal == VARIANT_FALSE) return false;")
    expect(boolean).toContain("note(phases.variant_invalid); unavailable();")
    expect(reader).toContain("if (reported.value.vt != VT_UNKNOWN || !reported.value.punkVal)")
    const marker = reader.indexOf(
      "automation_->CheckNotSupported(reported.value, &unsupported) != S_OK || unsupported != TRUE",
    )
    const probe = reader.indexOf("element->GetCurrentPatternAs(pattern, IID_PPV_ARGS(capability.put()))")
    expect(marker).toBeGreaterThan(reader.indexOf("if (reported.value.vt == VT_BOOL)"))
    expect(probe).toBeGreaterThan(marker)
    expect(reader.match(/GetCurrentPatternAs/g)).toHaveLength(1)
    expect(reader).toContain("GetCurrentPatternAs(pattern, IID_PPV_ARGS(capability.put())); current_call();")
    expect(reader).toContain("classify_uia_pattern_support(probed, static_cast<bool>(capability))")
    expect(implementation.match(/classify_uia_pattern_support\(/g)).toHaveLength(2)
    const refused = reader.slice(reader.indexOf("if (!support)"), reader.indexOf("return *support;"))
    expect(refused).toContain(
      "probed == S_OK && !capability ? phases.probe_empty : probed == E_NOINTERFACE ? phases.probe_no_interface : phases.probe_invalid",
    )
    expect(refused).toContain("unavailable();")
    expect(refused).not.toMatch(/current_call|GetCurrentPatternAs|return/)
    expect(implementation).toContain("if (status == S_OK) return interface_present;")
    expect(implementation).toContain("if (status == UIA_E_NOTSUPPORTED && !interface_present) return false;")
    expect(reader).not.toMatch(/get_CurrentValue|get_DocumentRange|GetAttributeValue|GetText/)
    const security = implementation.slice(
      implementation.indexOf("UiaSecurity security("),
      implementation.indexOf("UiaName name("),
    )
    for (const pattern of ["Value", "Text"]) {
      const call = `pattern_available<IUIAutomation${pattern}Pattern>(cached.get(), element, UIA_Is${pattern}PatternAvailablePropertyId, UIA_${pattern}PatternId,`
      expect(security).toContain(call)
      expect(security.indexOf(call)).toBeLessThan(security.indexOf("classify_uia_password("))
    }
    expect(security).toContain("result.value_pattern = value_pattern; result.text_pattern = text_pattern;")
    expect(security).not.toContain("GetCachedPropertyValueEx(UIA_IsValuePatternAvailablePropertyId, FALSE")
    expect(security).not.toContain("GetCachedPropertyValueEx(UIA_IsTextPatternAvailablePropertyId, FALSE")
    expect(implementation).toContain("if (status == S_OK) return interface_present;")
    expect(implementation).toContain("if (status == UIA_E_NOTSUPPORTED && !interface_present) return false;")
  })
  test("admits the actual production overlay, native smoke and fake helper workspace graph", async () => {
    const graph = await computerOverlaySourceGraph(fileURLToPath(new URL("../", import.meta.url)))
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/src/main/computer-overlay.ts")
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/test/computer/fake-helper.ts")
  })
  test("resolves transitive actual workspace source and compiler/package inputs without a supplied file list", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop)
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/src/main/dependency.ts")
    expect(graph.entries.map((entry) => entry.path)).toContain("bun.lock")
    expect(graph.bunVersion).toBe("1.3.14")
    expect(new Set(graph.entries.map((entry) => entry.path)).size).toBe(graph.entries.length)
  })
  test("admits only the explicit Electron original-fs builtin while preserving its source and compiler binding", async () => {
    const value = await fixture()
    await writeFile(value.dependency, 'import originalFs from "original-fs"; export const raw = originalFs.promises\n')
    const graph = await computerOverlaySourceGraph(value.desktop)
    const consumed = graph.entries.find((entry) => entry.path === "packages/desktop/src/main/dependency.ts")!
    expect(Buffer.from(consumed.bytes).toString("utf8")).toContain('from "original-fs"')
    const built = await Bun.build({
      entrypoints: [value.entry],
      target: "node",
      format: "esm",
      outdir: path.join(value.root, "out"),
      naming: "main.mjs",
      metafile: true,
      external: ["electron", "original-fs"],
      allowUnresolved: ["original-fs"],
    })
    expect(built.success).toBe(true)
    await verifyComputerOverlayBundleGraph(built.metafile, value.desktop, graph, COMPUTER_OVERLAY_ENTRYPOINTS[0].input)
    await writeFile(value.dependency, 'import "unadmitted-electron-builtin"\n')
    await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow("unresolved import")
  })
  test("a transitive source change or native C2 digest changes dedicated overlay authority", async () => {
    const value = await fixture(),
      before = await computerOverlaySourceGraph(value.desktop)
    await writeFile(value.dependency, "export const fixture = 2\n")
    const after = await computerOverlaySourceGraph(value.desktop)
    expect(computerOverlaySourceDigest("a".repeat(64), before)).not.toBe(
      computerOverlaySourceDigest("a".repeat(64), after),
    )
    expect(computerOverlaySourceDigest("b".repeat(64), before)).not.toBe(
      computerOverlaySourceDigest("a".repeat(64), before),
    )
    expect(computerOverlaySourceDigest("a".repeat(64), { ...before, entries: before.entries.toReversed() })).toBe(
      computerOverlaySourceDigest("a".repeat(64), before),
    )
  })
  test("rejects unresolved and runtime-selected imports instead of trusting an incomplete graph", async () => {
    const value = await fixture()
    for (const source of ['import "./missing"', 'const name = "./dependency"; void import(name)']) {
      await writeFile(value.entry, source)
      await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow()
    }
  })
  test("requires an exact repository Bun compiler pin", async () => {
    const value = await fixture()
    for (const packageManager of ["bun@latest", "bun@^1.3.14", "node@24", undefined]) {
      await writeFile(path.join(value.root, "package.json"), JSON.stringify({ packageManager }))
      await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow("exactly pinned")
    }
  })
  test("the pinned Bun compiler produces admissible real input metadata", async () => {
    const value = await fixture()
    const graph = await computerOverlaySourceGraph(value.desktop)
    const result = await Bun.build({
      entrypoints: [value.entry],
      target: "node",
      format: "esm",
      outdir: path.join(value.root, "out"),
      naming: "main.mjs",
      metafile: true,
      allowUnresolved: [],
    })
    expect(result.success).toBe(true)
    expect(result.outputs).toHaveLength(1)
    await verifyComputerOverlayBundleGraph(result.metafile, value.desktop, graph, COMPUTER_OVERLAY_ENTRYPOINTS[0].input)
  })
  test("actual compiler workspace metadata must match independently admitted bytes", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop)
    const metadata = { inputs: { [value.entry]: { bytes: (await readFile(value.entry)).length, imports: [] } } }
    await verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)
    await writeFile(value.entry, "export const altered = true")
    await expect(verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)).rejects.toThrow("admitted graph")
  })
  test("compiler input lists cannot add an unadmitted workspace file or omit bounded metadata", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop),
      unadmitted = path.join(value.desktop, "unadmitted.ts")
    await writeFile(unadmitted, "export const hidden = true")
    await expect(
      verifyComputerOverlayBundleGraph({ inputs: { [unadmitted]: { bytes: 25, imports: [] } } }, value.desktop, graph),
    ).rejects.toThrow("admitted graph")
    for (const metadata of [undefined, {}, { inputs: {} }, { inputs: { [value.entry]: { bytes: -1, imports: [] } } }])
      await expect(verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)).rejects.toThrow()
  })
  test("digest inputs are ordered, unique, relative and measured", async () => {
    const graph = {
      entries: [{ path: "source.ts", bytes: Buffer.from("source") }],
      bunVersion: "1.3.14",
      resolverVersion: "5.6.2",
    }
    expect(computerOverlaySourceDigest("a".repeat(64), graph)).toMatch(/^[a-f0-9]{64}$/)
    for (const changed of [
      { ...graph, entries: [...graph.entries, ...graph.entries] },
      { ...graph, entries: [{ ...graph.entries[0]!, path: "../escape" }] },
      { ...graph, bunVersion: "latest" },
      { ...graph, entries: [] },
    ])
      expect(() => computerOverlaySourceDigest("a".repeat(64), changed)).toThrow()
    expect(() => computerOverlaySourceDigest("unmeasured", graph)).toThrow()
  })
})
