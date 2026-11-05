import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a workflow mapping.")
  return value as Record<string, unknown>
}

function workflow(name: string) {
  const source = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8")
  return { source, document: record(Bun.YAML.parse(source)) }
}

const helper = workflow("computer-helper.yml")
const main = workflow("test.yml")
const jobs = record(helper.document.jobs)
const job = (name: string) => record(jobs[name])
const nativeJobs = ["mac-build", "mac-test", "windows-build", "windows-arm64-test"]
const steps = (value: Record<string, unknown>) => {
  if (!Array.isArray(value.steps)) throw new Error("Expected executable workflow steps.")
  return value.steps.map(record)
}
const commands = (value: Record<string, unknown>) =>
  steps(value)
    .flatMap((step) => (typeof step.run === "string" ? [step.run] : []))
    .join("\n")
    .replace(/(?:\\|`)\r?\n\s*/g, " ")

// Run the workflows' actual simple conditions, rather than reproducing their routing logic in the fixture.
function expression(
  value: string,
  inputs: Record<string, unknown>,
  event = "workflow_dispatch",
  ref = "refs/heads/hands",
  needs: Record<string, unknown> = {},
  status: { cancelled?: boolean } = {},
) {
  // GitHub permits hyphens in dotted property names; translate those accesses outside string literals.
  const code = value
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1")
    .replace(/'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|\.([A-Za-z_][A-Za-z0-9_-]*)/g, (match, property: string | undefined) =>
      property?.includes("-") ? `[${JSON.stringify(property)}]` : match,
    )
  return runInNewContext(
    code,
    {
      inputs,
      needs,
      always: () => true,
      cancelled: () => status.cancelled ?? false,
      github: {
        workflow: "test",
        ref,
        sha: "fixture-sha",
        event_name: event,
        run_id: 1,
        event: { pull_request: event === "pull_request" ? { number: 1 } : {} },
      },
      format: (template: string, ...args: unknown[]) =>
        template.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
    },
    { timeout: 100 },
  ) as unknown
}

function group(value: unknown, inputs: Record<string, unknown>, ref = "refs/heads/hands") {
  if (typeof value !== "string") throw new Error("Expected a concurrency group.")
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, code: string) =>
    String(expression(code, inputs, "workflow_dispatch", ref)),
  )
}

test("the native workflow has safe reusable/manual defaults and the temporary CI branch trigger", () => {
  const events = record(helper.document.on)
  expect(record(events.push).branches).toContain("ci/computer-**")
  for (const event of ["workflow_call", "workflow_dispatch"]) {
    const inputs = record(record(events[event]).inputs)
    expect(record(inputs["artifact-suffix"]).type).toBe("string")
    expect(inputs["privileged-required"]).toMatchObject({ type: "boolean", default: false })
    expect(inputs["full-desktop-e2e"]).toMatchObject({ type: "boolean", default: true })
    expect(inputs["isolated-desktop"]).toMatchObject({ type: "boolean", default: false })
    expect(inputs["windows-only"]).toMatchObject({ type: "boolean", default: false })
    expect(inputs["linux-only"]).toMatchObject({ type: "boolean", default: false })
    expect(inputs["reuse-artifacts"]).toMatchObject({ type: "boolean", default: false })
    expect(inputs["helper-channel"]).toMatchObject({ default: "prod" })
  }
  const outputs = record(record(events.workflow_call).outputs)
  for (const platform of ["darwin", "win32"])
    expect(record(outputs[`${platform}-digest`]).value).toMatch(/\$\{\{\s*jobs\.[\w-]+\.outputs\.[\w-]+\s*\}\}/)
})

test("native jobs and privileged checks have independent deadlines with explicit owner opt-in", () => {
  for (const [name, value] of Object.entries(jobs)) {
    const current = record(value)
    expect(current["timeout-minutes"], `${name} needs a job deadline`).toBeNumber()
    expect(current["timeout-minutes"] as number).toBeGreaterThan(0)
    expect(current["timeout-minutes"] as number).toBeLessThanOrEqual(90)
    const privileged = steps(current).filter(
      (step) => typeof step.run === "string" && /--privileged(?:\s+|=)["']?(?:auto|require|\$)/.test(step.run),
    )
    if (nativeJobs.includes(name))
      expect(privileged.length, `${name} must retain a controlled privileged check`).toBeGreaterThan(0)
    for (const step of privileged) {
      expect(step["timeout-minutes"], `${name} privileged checks need their own deadline`).toBeNumber()
      expect(String(step["continue-on-error"]).replace(/\s+/g, "")).toMatch(
        /^\$\{\{!inputs(?:\['privileged-required'\]|\.privileged-required)\}\}$/,
      )
      expect(`${step.if ?? ""} ${step.run}`).toContain("isolated-desktop")
      expect(`${step.run} ${JSON.stringify(step.env ?? {})}`).toContain("privileged-required")
    }
    const required = steps(current).filter(
      (step) => typeof step.run === "string" && /--privileged(?:\s+|=)off/.test(step.run),
    )
    for (const step of required) expect(step["continue-on-error"]).toBeUndefined()
  }
})

test("native scenario isolation is explicit and confined to opt-in native steps", () => {
  const isolated = [
    "Run explicitly isolated Windows scenarios",
    "Run explicitly isolated ARM64 scenarios",
    "Run actual isolated macOS overlay Stop and capture",
    "Run actual isolated medium-token Windows overlay Stop",
  ]
  const found: string[] = []
  for (const value of Object.values(jobs)) {
    for (const step of steps(record(value))) {
      if (!step.env || record(step.env).VECTOR_COMPUTER_TEST_ISOLATED === undefined) continue
      expect(isolated).toContain(step.name)
      expect(record(step.env).VECTOR_COMPUTER_TEST_ISOLATED).toBe("1")
      expect(String(step.if)).toContain("isolated-desktop")
      if (String(step.name).startsWith("Run actual isolated")) expect(String(step.run)).toContain("--native-stage")
      else expect(String(step.run)).toContain("--platform win32")
      found.push(String(step.name))
    }
  }
  expect(found.toSorted()).toEqual(isolated.toSorted())
})

test("native actions are pinned, read-only and do not restore helper binaries from caches", () => {
  expect(helper.document.permissions).toEqual({ contents: "read" })
  expect(helper.source).not.toMatch(/\$\{\{[^}]*\bsecrets\./)
  for (const [name, value] of Object.entries(jobs)) {
    const current = record(value)
    expect(current.secrets).toBeUndefined()
    if (current.permissions !== undefined)
      expect(current.permissions).toEqual(
        name === "mac-build" || name === "windows-build" ? { contents: "read", actions: "read" } : { contents: "read" },
      )
    for (const step of steps(current)) {
      if (typeof step.uses !== "string") continue
      expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/)
      expect(step.uses).not.toMatch(/^actions\/cache(?:\/|@)/)
    }
  }
})

test("every native runner installs frozen dependencies without package scripts", () => {
  for (const name of nativeJobs) {
    const install = commands(job(name))
    expect(install, `${name} must use the committed dependency graph`).toMatch(/bun\s+install[^\n]*--frozen-lockfile/)
    expect(install, `${name} must not execute dependency install scripts`).toMatch(
      /bun\s+install[^\n]*--ignore-scripts/,
    )
    expect(install, `${name} must run native core checks without OS input`).toMatch(/--privileged(?:\s+|=)off/)
  }
})

test("the normal test workflow supplies only the native lane's read permissions", () => {
  const reuse = record(record(main.document.jobs)["computer-helper"])
  expect(reuse.uses).toBe("./.github/workflows/computer-helper.yml")
  expect(reuse.permissions).toEqual({ contents: "read", actions: "read" })
  expect(reuse.secrets).toBeUndefined()
  expect(reuse["timeout-minutes"]).toBeUndefined()
  expect(record(reuse.with)["artifact-suffix"]).toContain("github.sha")
  expect(record(reuse.with)["isolated-desktop"]).toBe(true)
  expect(main.source).not.toContain("pull_request_target:")
})

test("a native-only dispatch excludes ordinary and focused jobs without sharing their cancellation group", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const selected = { computer_helper: true, hands_ui: true, hands_benchmark: true }
  for (const [name, value] of Object.entries(all)) {
    const current = record(value)
    expect(typeof current.if, `${name} must respect native-only dispatch`).toBe("string")
    expect(expression(String(current.if), selected), `${name} has incorrect native-only routing`).toBe(
      name === "computer-helper",
    )
  }
  expect(
    expression(String(record(all["computer-helper"]).if), {
      computer_helper: false,
      hands_ui: true,
      hands_benchmark: false,
    }),
  ).toBe(false)
  expect(expression(String(record(all["computer-helper"]).if), {}, "pull_request")).toBe(true)
  expect(expression(String(record(all["computer-helper"]).if), {}, "push", "refs/heads/main")).toBe(true)

  const cancellation = record(main.document.concurrency)
  const modes = [
    { computer_helper: true, hands_ui: false, hands_benchmark: false },
    { computer_helper: false, hands_ui: false, hands_benchmark: false },
    { computer_helper: false, hands_ui: true, hands_benchmark: false },
    { computer_helper: false, hands_ui: false, hands_benchmark: true },
  ]
  expect(new Set(modes.map((mode) => group(cancellation.group, mode))).size).toBe(modes.length)
  const child = record(helper.document.concurrency)
  expect(child["cancel-in-progress"]).toBe(true)
  const native = group(child.group, { "artifact-suffix": "fixture" })
  expect(native).not.toBe(group(cancellation.group, modes[0]!))
  expect(native).not.toBe(group(child.group, { "artifact-suffix": "fixture" }, "refs/heads/another-task"))
})

test("Windows-only dispatch is explicit, native-only and independent of all-native cancellation", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper_windows_only).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const reuse = record(all["computer-helper"])
  const selector = record(reuse.with)["windows-only"]
  expect(typeof selector).toBe("string")
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const windows of [false, true]) {
        const mode = {
          computer_helper: native,
          computer_helper_windows_only: windows,
          hands_ui: false,
          hands_benchmark: false,
        }
        expect(expression(String(selector), mode, event)).toBe(event === "workflow_dispatch" && native && windows)
      }
  const windows = { computer_helper: true, computer_helper_windows_only: true, hands_ui: true, hands_benchmark: true }
  for (const [name, value] of Object.entries(all))
    expect(expression(String(record(value).if), windows), `${name} has incorrect Windows-only routing`).toBe(
      name === "computer-helper",
    )
  // The flag by itself leaves ordinary full-regression routing and cancellation unchanged.
  const baseline = { computer_helper: false, hands_ui: false, hands_benchmark: false }
  for (const value of Object.values(all)) {
    const condition = String(record(value).if)
    expect(expression(condition, { ...baseline, computer_helper_windows_only: true })).toBe(
      expression(condition, baseline),
    )
  }
  const cancellation = record(main.document.concurrency)
  const native = { ...baseline, computer_helper: true }
  expect(group(cancellation.group, windows)).not.toBe(group(cancellation.group, native))
  expect(group(cancellation.group, { ...baseline, computer_helper_windows_only: true })).toBe(
    group(cancellation.group, baseline),
  )
  const child = record(helper.document.concurrency)
  const suffix = { "artifact-suffix": "same-immutable-source" }
  expect(group(child.group, { ...suffix, "windows-only": true })).not.toBe(group(child.group, suffix))
  expect(group(child.group, { ...suffix, "windows-only": false })).toBe(group(child.group, suffix))
})

test("Windows-only native coverage keeps both architectures and required checks while skipping macOS", () => {
  const needs = {
    plan: { outputs: { extended: "true", windows: "true", "windows-protocol": "true" } },
    "mac-build": { result: "success", outputs: { "native-ready": "true" } },
  }
  for (const windows of [false, true]) {
    const inputs = { "windows-only": windows }
    for (const name of ["mac-build", "mac-test"])
      expect(expression(String(job(name).if), inputs, "workflow_dispatch", "refs/heads/hands", needs)).toBe(!windows)
    for (const name of ["windows-build", "windows-arm64-test"]) {
      const current = job(name)
      expect(expression(String(current.if), inputs, "workflow_dispatch", "refs/heads/hands", needs)).toBe(true)
      expect(current.needs).not.toContain("mac-build")
      const required = steps(current).filter(
        (step) => typeof step.run === "string" && /--privileged(?:\s+|=)off/.test(step.run),
      )
      expect(required).toHaveLength(1)
      expect(required[0]?.["continue-on-error"]).toBeUndefined()
      expect(expression(String(required[0]?.if), inputs, "workflow_dispatch", "refs/heads/hands", needs)).toBe(true)
    }
  }
  const narrow = { plan: { outputs: { ...needs.plan.outputs, extended: "false" } } }
  expect(expression(String(job("mac-test").if), {}, "pull_request", "refs/heads/hands", narrow)).toBe(false)
  expect(expression(String(job("windows-arm64-test").if), {}, "pull_request", "refs/heads/hands", narrow)).toBe(false)
  expect(
    expression(
      String(job("windows-arm64-test").if),
      { "windows-only": true },
      "pull_request",
      "refs/heads/hands",
      narrow,
    ),
  ).toBe(true)
})

test("the native lane covers supported runners and only expands PR matrices for relevant changes", () => {
  expect(job("mac-build")["runs-on"]).toBe("macos-15")
  expect(record(job("mac-build").env).DEVELOPER_DIR).toBe("/Applications/Xcode_16.4.app/Contents/Developer")
  expect(record(record(job("mac-test").strategy).matrix).host).toEqual(["macos-15-intel", "macos-26"])
  expect(job("windows-build")["runs-on"]).toBe("windows-2025")
  expect(job("windows-arm64-test")["runs-on"]).toBe("windows-11-arm")
  for (const name of ["mac-test", "windows-arm64-test"]) expect(job(name).if).toContain("needs.plan.outputs.extended")
  const plan = commands(job("plan"))
  expect(plan).toMatch(/extended=true[\s\S]*pull_request[\s\S]*extended=false/)
  const filter = plan.match(/rg\s+-q\s+'([^']+)'/)?.[1]
  expect(filter, "PR coverage needs an actual changed-path filter").toBeDefined()
  const matches = new RegExp(filter!)
  for (const file of [
    "packages/desktop/native/computer-helper/macos/Sources/Server.swift",
    "packages/desktop/src/main/computer-session.ts",
    "packages/desktop/scripts/build-computer-helper.ts",
    "packages/app/src/features/computer/main-copy.ts",
    "packages/engine/src/computer/protection.ts",
    "packages/schema/src/computer.ts",
    ".github/workflows/computer-helper.yml",
  ])
    expect(matches.test(file), `${file} needs the native matrix`).toBe(true)
  expect(matches.test("docs/unrelated-note.md")).toBe(false)
  expect(plan).toContain("windows/CMakeLists.txt")
  expect(plan).toContain("windows/src/protocol.cpp")
  expect(plan).toContain("SKIPPED")
  for (const name of ["windows-build", "windows-arm64-test"]) {
    expect(job(name).if).toContain("needs.plan.outputs.windows")
    const core = steps(job(name)).find(
      (step) => typeof step.run === "string" && /--privileged(?:\s+|=)off/.test(step.run),
    )
    expect(core?.if).toContain("windows-protocol")
  }
})

test("macOS rebuilds and checks shipping bytes before enforcing the measured lock", () => {
  const mac = steps(job("mac-build"))
  const builds = mac
    .filter((step) => step.id === "build")
    .flatMap((step) =>
      typeof step.run === "string"
        ? step.run
            .split("\n")
            .filter(
              (line) =>
                line.includes("build-computer-helper.ts") &&
                line.includes("--platform darwin") &&
                !line.includes("--check-lock"),
            )
        : [],
    )
  expect(builds).toHaveLength(2)
  for (const build of builds) expect(build).toMatch(/--arch\s+universal.*--channel\s+"\$VECTOR_CHANNEL"/)
  const output = builds.map((build) => build.match(/--out\s+(\S+)/)?.[1])
  expect(output.every(Boolean)).toBe(true)
  expect(new Set(output).size).toBe(2)
  const verify = mac.find((step) => typeof step.run === "string" && /\bcmp\s/.test(step.run))
  expect(verify?.run).toContain("computer-helper.json")
  expect(verify?.run).toContain('createHash("sha256")')
  expect(verify?.run).toContain("manifest.files")
  expect(verify?.["continue-on-error"]).toBeUndefined()
  const lock = mac.find((step) => typeof step.run === "string" && step.run.includes("--check-lock"))
  expect(lock?.if).toContain("success()")
  expect(lock?.["continue-on-error"]).toBeUndefined()
  expect(record(lock?.env).VECTOR_COMPUTER_HELPER_PREBUILT).toBe("true")
  const matrix = commands(job("mac-test"))
  expect(matrix).toMatch(/tar\s+-xpf/)
  expect(matrix).toMatch(/codesign\s+--verify\s+--strict/)
  expect(matrix).toContain("--check-lock")
  expect(commands(job("windows-build"))).toContain("--arch x64,arm64")
  expect(commands(job("windows-arm64-test"))).toContain("--arch arm64")
})

test("shipping and test archives preserve executable modes while failure diagnostics remain available", () => {
  const required = new Set([
    "computer-helper-darwin.tar",
    "computer-helper-darwin-tests.tar",
    "computer-helper-win32.tar",
    "computer-helper-win32-tests.tar",
  ])
  let candidates = 0
  let reports = 0
  for (const value of Object.values(jobs))
    for (const step of steps(record(value))) {
      if (typeof step.uses !== "string" || !step.uses.startsWith("actions/upload-artifact@")) continue
      const upload = record(step.with)
      expect(upload["retention-days"]).toBe(14)
      expect(upload.name).toContain("needs.plan.outputs.suffix")
      if (typeof upload.path !== "string") throw new Error("Artifact uploads need explicit paths.")
      const filename = upload.path.split("/").at(-1)!
      if (required.has(filename)) {
        expect(expression(String(upload.overwrite), { "reuse-artifacts": false })).toBe(true)
        expect(expression(String(upload.overwrite), { "reuse-artifacts": true })).toBe(false)
        expect(step.if).toContain("steps.restore.outputs.restored")
        required.delete(filename)
        expect(upload["if-no-files-found"]).toBe("error")
        continue
      }
      if (/^computer-overlay-smoke-(?:darwin|win32)\.tar$/.test(filename)) {
        expect(expression(String(upload.overwrite), { "reuse-artifacts": false })).toBe(true)
        expect(expression(String(upload.overwrite), { "reuse-artifacts": true })).toBe(false)
        expect(step.if).toContain("steps.overlay-restore.outputs.restored")
        expect(upload["if-no-files-found"]).toBe("error")
        continue
      }
      expect(upload.overwrite).toBe(true)
      expect(upload.path).toMatch(/\.json$/)
      expect(step.if).toContain("always()")
      if (filename === "identity.lock.computed.json") candidates++
      else reports++
    }
  expect(required.size).toBe(0)
  expect(candidates).toBeGreaterThan(0)
  expect(reports).toBeGreaterThan(0)
  const mac = commands(job("mac-build"))
  expect(mac).toMatch(/tar\s+-cpf[^\n]+VectorComputer\.app\s+computer-helper\.json/)
  expect(mac).toMatch(/tar\s+-cpf[^\n]+darwin\s+tests/)
  for (const name of nativeJobs) {
    const summary = steps(job(name)).filter(
      (step) => typeof step.run === "string" && step.run.includes("GITHUB_STEP_SUMMARY"),
    )
    expect(summary.length, `${name} must report skipped native checks`).toBeGreaterThan(0)
    expect(summary.some((step) => String(step.run).includes('check.status === "skipped"'))).toBe(true)
    expect(summary.some((step) => String(step.run).includes('check.status === "failed"'))).toBe(true)
  }
})

test("optional native unit failures retain separate bounded suite diagnostics", () => {
  for (const name of ["mac-build", "mac-test"]) {
    const current = steps(job(name))
    const isolated = current.findIndex((step) => step.id === "isolated")
    const diagnostics = current.findIndex((step) => step.name === "Diagnose failed optional native units separately")
    expect(isolated).toBeGreaterThan(-1)
    expect(diagnostics).toBeGreaterThan(isolated)
    const step = current[diagnostics]!
    expect(String(step.if)).toContain("steps.isolated.outcome == 'failure'")
    expect(step["continue-on-error"]).toBe(true)
    expect(step["timeout-minutes"]).toBe(8)
    expect(String(step.run)).toContain('check.name === "unit" && check.status === "failed"')
    expect(String(step.run)).toContain("computer-helper-unit-diagnostics.ts")
  }
})

test("focused Node smoke keeps normal CI gates and uses its own cancellation group", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.desktop_engine_node).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const focused = {
    desktop_engine_node: true,
    computer_helper: true,
    computer_helper_windows_units_only: true,
    computer_helper_macos_signing_only: true,
    computer_helper_macos_overlay_only: true,
    hands_ui: true,
    hands_benchmark: true,
  }
  for (const [name, value] of Object.entries(all)) {
    const current = record(value)
    expect(expression(String(current.if), focused), name).toBe(name === "desktop-engine-node")
    if (
      ![
        "hands-ui",
        "hands-benchmark",
        "computer-helper-windows-units",
        "computer-helper-macos-signing",
        "computer-helper-macos-overlay",
      ].includes(name)
    ) {
      expect(expression(String(current.if), {}), name).toBe(true)
      expect(expression(String(current.if), {}, "pull_request"), name).toBe(true)
    }
  }
  const cancellation = record(main.document.concurrency)
  expect(group(cancellation.group, focused)).not.toBe(group(cancellation.group, {}))
  expect(group(cancellation.group, focused)).not.toBe(group(cancellation.group, { computer_helper: true }))
})

test("Linux-only dispatch keeps ordinary gates and native cancellation groups independent", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper_linux_only).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const reuse = record(all["computer-helper"])
  const selector = record(reuse.with)["linux-only"]
  expect(typeof selector).toBe("string")
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const linux of [false, true])
        expect(
          expression(String(selector), { computer_helper: native, computer_helper_linux_only: linux }, event),
        ).toBe(event === "workflow_dispatch" && native && linux)
  const linux = { computer_helper: true, computer_helper_linux_only: true, hands_ui: true, hands_benchmark: true }
  for (const [name, value] of Object.entries(all))
    expect(expression(String(record(value).if), linux), `${name} has incorrect Linux-only routing`).toBe(
      name === "computer-helper",
    )
  const baseline = { computer_helper: false, hands_ui: false, hands_benchmark: false }
  for (const value of Object.values(all))
    for (const event of ["workflow_dispatch", "pull_request", "push"])
      expect(expression(String(record(value).if), { ...baseline, computer_helper_linux_only: true }, event)).toBe(
        expression(String(record(value).if), baseline, event),
      )
  const cancellation = record(main.document.concurrency)
  const modes = [
    { computer_helper: true },
    { computer_helper: true, computer_helper_windows_only: true },
    { computer_helper: true, computer_helper_linux_only: true },
    { computer_helper: true, computer_helper_windows_only: true, computer_helper_linux_only: true },
    { desktop_engine_node: true },
  ]
  expect(new Set(modes.map((mode) => group(cancellation.group, mode))).size).toBe(modes.length)
  expect(group(cancellation.group, { ...baseline, computer_helper_linux_only: true })).toBe(
    group(cancellation.group, baseline),
  )
  const child = record(helper.document.concurrency)
  const suffix = { "artifact-suffix": "same-immutable-source" }
  const childModes = [
    {},
    { "windows-only": true },
    { "linux-only": true },
    { "windows-only": true, "linux-only": true },
  ]
  expect(new Set(childModes.map((mode) => group(child.group, { ...suffix, ...mode }))).size).toBe(childModes.length)
  expect(group(child.group, { ...suffix, "linux-only": false })).toBe(group(child.group, suffix))
})

test("Linux-only runs both real Electron lanes and skips every native OS lane", () => {
  const needs = {
    plan: { outputs: { extended: "true", windows: "true", "windows-protocol": "true", desktop: "true" } },
    "mac-build": { result: "success", outputs: { "native-ready": "true" } },
  }
  for (const mode of [{}, { "windows-only": true }, { "linux-only": true }]) {
    for (const name of nativeJobs) {
      const expected = !mode["linux-only"] && (!mode["windows-only"] || name.startsWith("windows"))
      expect(expression(String(job(name).if), mode, "workflow_dispatch", "refs/heads/hands", needs), name).toBe(
        expected,
      )
    }
    for (const name of ["overlay-linux", "desktop-e2e-linux"])
      expect(expression(String(job(name).if), mode, "workflow_dispatch", "refs/heads/hands", needs), name).toBe(
        !mode["windows-only"],
      )
  }
  const plan = commands(job("plan"))
  const begin = plan.indexOf("desktop=false\n")
  const end = plan.indexOf('echo "suffix=', begin)
  expect(begin).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(begin)
  const temporary = mkdtempSync(path.join(tmpdir(), "vector-computer-linux-plan-"))
  const output = path.join(temporary, "output")
  try {
    for (const linux of ["true", "false"])
      for (const desktop of ["true", "false"])
        for (const event of ["workflow_dispatch", "workflow_call", "push"]) {
          rmSync(output, { force: true })
          const result = spawnSync(
            "bash",
            ["--noprofile", "--norc", "-c", `set -euo pipefail\n${plan.slice(begin, end)}`],
            {
              env: {
                ...process.env,
                LINUX_ONLY: linux,
                FULL_DESKTOP_E2E: desktop,
                EVENT_NAME: event,
                GITHUB_OUTPUT: output,
              },
              encoding: "utf8",
              timeout: 5000,
            },
          )
          expect(result.status).toBe(0)
          expect(readFileSync(output, "utf8").trim()).toBe(`desktop=${linux === "true" || desktop === "true"}`)
        }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("the actual native plan refuses simultaneous Linux-only and Windows-only selectors", () => {
  const guard = commands(job("plan")).match(
    /# HELPER_PLATFORM_GUARD_BEGIN\n([\s\S]*?)\n\s*# HELPER_PLATFORM_GUARD_END/,
  )?.[1]
  expect(guard).toBeDefined()
  for (const linux of ["true", "false"])
    for (const windows of ["true", "false"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${guard}`], {
        env: { ...process.env, LINUX_ONLY: linux, WINDOWS_ONLY: windows },
        encoding: "utf8",
        timeout: 5000,
      })
      expect(result.status).toBe(linux === "true" && windows === "true" ? 1 : 0)
      if (result.status === 1) expect(result.stdout).toContain("linux-only and windows-only cannot both be selected")
    }
})

test("macOS admits matrix artifacts only after core and lock checks, before signing or Electron fixtures", () => {
  const build = job("mac-build")
  const current = steps(build)
  const index = (name: string) => current.findIndex((step) => step.name === name)
  const ordered = [
    "Run required grant-free native checks",
    "Summarize native checks without payloads",
    "Enforce the measured production identity lock",
    "Require the measured macOS helper version and toolchain for this channel",
    "Expose the verified source digest",
    "Archive shipping files and native test executables separately",
    "Upload shipping helper",
    "Upload native tests",
    "Admit verified native artifacts for the independent macOS matrix",
    "Check helper signing contracts and actual Node modules",
    "Install the pinned Electron runtime for the unsigned signing fixture",
    "Run real Electron overlay properties and controller lifecycle",
  ].map(index)
  for (const position of ordered) expect(position).toBeGreaterThanOrEqual(0)
  expect(ordered).toEqual(ordered.toSorted((first, second) => first - second))
  const ready = current.find((step) => step.id === "native-ready")!
  expect(record(build.outputs)["native-ready"]).toBe("${{ steps.native-ready.outputs.value }}")
  expect(ready.run).toBe('echo "value=true" >> "$GITHUB_OUTPUT"')
  expect(ready["continue-on-error"]).toBeUndefined()
  for (const step of current.slice(
    index("Expose the verified source digest"),
    index("Check helper signing contracts and actual Node modules"),
  )) {
    expect(step["continue-on-error"]).toBeUndefined()
    expect(String(step.if ?? "")).not.toContain("always()")
  }
  const code = String(ready.if).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1")
  for (const successful of [false, true])
    for (const restored of [false, true])
      for (const shipping of ["success", "failure", "skipped"])
        for (const tests of ["success", "failure", "skipped"])
          expect(
            runInNewContext(
              code,
              {
                success: () => successful,
                steps: {
                  restore: { outputs: { restored: String(restored) } },
                  "shipping-artifact": { outcome: shipping },
                  "native-tests-artifact": { outcome: tests },
                },
              },
              { timeout: 100 },
            ),
          ).toBe(successful && (restored || (shipping === "success" && tests === "success")))
})

test("the macOS matrix can diagnose admitted artifacts after later fixture failures without authorizing release", () => {
  const matrix = job("mac-test")
  expect(matrix.needs).toEqual(["plan", "mac-build"])
  expect(String(matrix.if)).toContain("always()")
  for (const result of ["success", "failure", "cancelled", "skipped"])
    for (const ready of ["true", "false", ""])
      for (const extended of ["true", "false"]) {
        const needs = {
          plan: { result: "success", outputs: { extended } },
          "mac-build": { result, outputs: { "native-ready": ready } },
        }
        expect(expression(String(matrix.if), {}, "workflow_dispatch", "refs/heads/hands", needs)).toBe(
          ready === "true" && extended === "true",
        )
        expect(
          expression(String(matrix.if), {}, "workflow_dispatch", "refs/heads/hands", needs, { cancelled: true }),
        ).toBe(false)
        for (const inputs of [{ "windows-only": true }, { "linux-only": true }])
          expect(expression(String(matrix.if), inputs, "workflow_dispatch", "refs/heads/hands", needs)).toBe(false)
      }
  expect(job("mac-build")["continue-on-error"]).toBeUndefined()
  expect(matrix["continue-on-error"]).toBeUndefined()
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const name of ["mac", "windows"]) {
    const current = record(release[name])
    expect(current.needs).toContain("computer-helper")
    expect(String(current.if ?? "")).not.toMatch(/always\(\)|native-ready/)
    expect(current["continue-on-error"]).toBeUndefined()
  }
  const helperRelease = record(release["computer-helper"])
  expect(helperRelease.uses).toBe("./.github/workflows/computer-helper.yml")
  expect(helperRelease["continue-on-error"]).toBeUndefined()
})

test("x64 unit diagnostics require explicit native dispatch and keep independent cancellation groups", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper_windows_units_only).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const diagnostic = record(all["computer-helper-windows-units"])
  const selected = { computer_helper: true, computer_helper_windows_units_only: true }
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const units of [false, true])
        expect(
          expression(
            String(diagnostic.if),
            { computer_helper: native, computer_helper_windows_units_only: units },
            event,
          ),
        ).toBe(event === "workflow_dispatch" && native && units)
  for (const [name, value] of Object.entries(all)) {
    expect(expression(String(record(value).if), selected), name).toBe(name === "computer-helper-windows-units")
    for (const event of ["workflow_dispatch", "pull_request", "push"])
      expect(expression(String(record(value).if), { computer_helper_windows_units_only: true }, event), name).toBe(
        expression(String(record(value).if), {}, event),
      )
  }
  const modes = [
    selected,
    { computer_helper: true },
    { computer_helper: true, computer_helper_windows_only: true },
    { computer_helper: true, computer_helper_linux_only: true },
    { desktop_engine_node: true },
    { ...selected, computer_helper_windows_only: true },
    { ...selected, computer_helper_linux_only: true },
  ]
  expect(new Set(modes.map((mode) => group(record(main.document.concurrency).group, mode))).size).toBe(modes.length)
})

test("x64 diagnostics reuse exact bounded native checks and publish no release evidence", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-windows-units"])
  expect(diagnostic["runs-on"]).toBe("windows-2025")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "needs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  const guard = current[0]!
  expect(guard.name).toBe("Reject incompatible diagnostic selectors before setup")
  for (const windows of ["true", "false"])
    for (const linux of ["true", "false"])
      expect(
        spawnSync("bash", ["--noprofile", "--norc", "-c", String(guard.run)], {
          env: { ...process.env, WINDOWS_ONLY: windows, LINUX_ONLY: linux },
          timeout: 5000,
        }).status,
      ).toBe(windows === "true" || linux === "true" ? 1 : 0)
  const script = commands(diagnostic)
  expect(script).toContain("--platform win32 --arch x64 --channel prod --out native/out/win32")
  expect(script).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(script).not.toMatch(
    /--arch (?:arm64|x64,arm64)|--privileged (?:auto|require)|--native-stage|tar -|native-ready/,
  )
  const uploads = current.filter((step) => String(step.uses).includes("upload-artifact"))
  expect(uploads).toHaveLength(2)
  expect(uploads[0]!.if).toBe("${{ always() }}")
  expect(uploads[0]!.with).toEqual({
    name: "computer-helper-win32-x64-diagnostic-${{ github.sha }}-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/computer-win32-core.json",
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  const checks = current.find((step) => step.name === "Run Windows unit and fresh version/probe checks")!
  expect(checks.run).toBe(steps(job("windows-build")).find((step) => step.name === checks.name)?.run)
  expect(checks["timeout-minutes"]).toBe(5)
  expect(checks["continue-on-error"]).toBeUndefined()
  const protocol = current.find((step) => step.name === "Run required Windows protocol and lifecycle checks")!
  expect(protocol.run).toBe(steps(job("windows-build")).find((step) => step.name === protocol.name)?.run)
  expect(protocol.if).toBeUndefined()
  expect(protocol["continue-on-error"]).toBeUndefined()
  expect(protocol["timeout-minutes"]).toBe(8)
  expect(current.indexOf(protocol)).toBeGreaterThan(current.indexOf(checks))
  expect(current.indexOf(uploads[0]!)).toBeGreaterThan(current.indexOf(protocol))
  expect(protocol.id).toBe("required_protocol")
  const compile = current.find((step) => step.id === "direct_node_compile")!
  const paired = current.find((step) => step.name === "Diagnose the same Windows self-test with a direct Node parent")!
  expect(compile.if).toBe("${{ failure() && steps.required_protocol.outcome == 'failure' }}")
  expect(paired.if).toBe(
    "${{ failure() && steps.required_protocol.outcome == 'failure' && steps.direct_node_compile.outcome == 'success' }}",
  )
  expect(compile["continue-on-error"]).toBe(true)
  expect(paired["continue-on-error"]).toBe(true)
  expect(compile["timeout-minutes"]).toBe(2)
  expect(paired["timeout-minutes"]).toBe(protocol["timeout-minutes"])
  expect(String(compile.run)).toContain(
    'import { buildNodeSelfTest } from "./scripts/computer-helper-selftest-node.ts"',
  )
  expect(String(compile.run)).toContain('await buildNodeSelfTest(path.resolve("native/build/selftest-direct-node"))')
  expect(String(compile.run)).not.toMatch(/runNodeSelfTest\(|spawn\(|runSelfTestCLI\(/)
  const original = String(protocol.run).split("\n")[0]!
  const direct = String(paired.run).split("\n")[0]!
  expect(direct).toBe(
    original
      .replace(
        "bun --no-env-file ./scripts/computer-helper-selftest-node.ts",
        "node ./native/build/selftest-direct-node/run.mjs",
      )
      .replace("computer-win32-core.json", "computer-win32-direct-node.json"),
  )
  expect(uploads[1]!.if).toBe("${{ always() && steps.required_protocol.outcome == 'failure' }}")
  expect(uploads[1]!.with).toEqual({
    name: "computer-helper-win32-direct-node-diagnostic-${{ github.sha }}-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/computer-win32-direct-node.json",
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  expect(current.indexOf(compile)).toBeGreaterThan(current.indexOf(protocol))
  expect(current.indexOf(paired)).toBeGreaterThan(current.indexOf(compile))
  expect(current.indexOf(uploads[1]!)).toBeGreaterThan(current.indexOf(paired))
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const name of ["mac", "windows"]) expect(record(release[name]).needs).toContain("computer-helper")
  for (const value of Object.values(release))
    expect(JSON.stringify(value)).not.toContain("computer-helper-windows-units")
})

test("successful direct Windows checks forward only deduplicated fixed Caller context receipts", () => {
  const check = steps(record(record(main.document.jobs)["computer-helper-windows-units"])).find(
    (step) => step.name === "Run Windows unit and fresh version/probe checks",
  )!
  const body = String(check.run)
    .split("<<'NODE'\n")[1]!
    .replace(/\nNODE\s*$/, "")
    .replace(/^import .*$/gm, "")
  const emitted: string[] = []
  const receipt = "vector-caller-context initial r=linked d=parent o=u a=g c=s"
  const second = "vector-caller-context initial r=serving d=owned o=x a=d c=s"
  const unknown = "vector-caller-context initial r=restricted d=parent o=n a=n c=q"
  const generic = "vector-caller-context initial r=restricted d=parent o=u a=n c=r"
  const repaired = "vector-caller-context initial r=restricted d=parent o=u a=g c=b"
  const stderr = [
    receipt,
    "PRIVATE",
    receipt,
    second,
    unknown,
    generic,
    repaired,
    "vector-caller-context initial r=PRIVATE d=parent o=u a=g c=s",
    "vector-caller-context initial r=linked d=parent o=PRIVATE a=g c=s",
    "vector-caller-context initial r=linked d=parent o=u a=PRIVATE c=s",
    "vector-caller-context initial r=linked d=parent o=u a=g c=PRIVATE",
    "vector-caller-context initial r=linked d=parent o=u a=g",
    "vector-caller-context initial r=linked d=parent",
    second + " PRIVATE",
  ].join("\n")
  let calls = 0
  runInNewContext(
    body,
    {
      path,
      readFileSync: () => JSON.stringify({ sourceDigest: "fixture-digest" }),
      spawnSync(_file: string, args: string[], options: Record<string, unknown>) {
        calls++
        expect(options).toMatchObject({ timeout: 30000, maxBuffer: 65536, windowsHide: true })
        const stdout = args.includes("--version")
          ? JSON.stringify({ sourceDigest: "fixture-digest", arch: "x64" })
          : args.includes("--probe")
            ? JSON.stringify({
                permissions: { screen: "n/a", accessibility: "n/a" },
                captureBlocked: false,
                elevated: false,
              })
            : ""
        return { status: 0, stdout, stderr }
      },
      process: { stderr: { write: (text: string) => emitted.push(text) } },
    },
    { timeout: 1000 },
  )
  expect(calls).toBe(4)
  expect(emitted).toEqual([receipt + "\n", second + "\n", unknown + "\n", generic + "\n", repaired + "\n"])
  expect(emitted.join("")).not.toContain("PRIVATE")
})

test("macOS certificate diagnostics are explicit, isolated and keep default and Node routes intact", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper_macos_signing_only).toMatchObject({ type: "boolean", default: false })
  const all = record(main.document.jobs)
  const diagnostic = record(all["computer-helper-macos-signing"])
  const selected = { computer_helper: true, computer_helper_macos_signing_only: true }
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const signing of [false, true])
        expect(
          expression(
            String(diagnostic.if),
            { computer_helper: native, computer_helper_macos_signing_only: signing },
            event,
          ),
        ).toBe(event === "workflow_dispatch" && native && signing)
  for (const [name, value] of Object.entries(all)) {
    expect(expression(String(record(value).if), selected), name).toBe(name === "computer-helper-macos-signing")
    for (const event of ["workflow_dispatch", "pull_request", "push"])
      expect(expression(String(record(value).if), { computer_helper_macos_signing_only: true }, event), name).toBe(
        expression(String(record(value).if), {}, event),
      )
  }
  const modes = [
    {},
    { computer_helper_windows_only: true },
    { computer_helper_linux_only: true },
    { computer_helper_windows_units_only: true },
  ].flatMap((mode) => [
    { computer_helper: true, ...mode },
    { ...selected, ...mode },
  ])
  expect(new Set(modes.map((mode) => group(record(main.document.concurrency).group, mode))).size).toBe(modes.length)
})

test("the fast macOS certificate lane shares the real fixture and cleanup without native build or release credit", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-macos-signing"])
  expect(diagnostic["runs-on"]).toBe("macos-15")
  expect(record(diagnostic.env).DEVELOPER_DIR).toBe("/Applications/Xcode_16.4.app/Contents/Developer")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "needs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  expect(current[0]!.name).toBe("Reject incompatible signing selectors before setup")
  for (const windows of ["true", "false"])
    for (const linux of ["true", "false"])
      for (const units of ["true", "false"])
        expect(
          spawnSync("bash", ["--noprofile", "--norc", "-c", String(current[0]!.run)], {
            env: { ...process.env, WINDOWS_ONLY: windows, LINUX_ONLY: linux, WINDOWS_UNITS_ONLY: units },
            timeout: 5000,
          }).status,
        ).toBe([windows, linux, units].includes("true") ? 1 : 0)
  for (const name of [
    "Verify certificate signing with a temporary trusted CI identity",
    "Remove any interrupted signing fixture trust and keychain",
  ]) {
    const step = current.find((step) => step.name === name)!
    expect(step.run).toBe(steps(job("mac-build")).find((step) => step.name === name)?.run)
    expect(step["continue-on-error"]).toBeUndefined()
  }
  expect(current.at(-1)!.if).toBe("${{ always() && steps.checkout.outcome == 'success' }}")
  expect(commands(diagnostic)).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(commands(diagnostic)).not.toMatch(
    /build-computer-helper|computer-helper-selftest|--native-stage|tar -|native-ready/,
  )
  expect(current.some((step) => String(step.uses).includes("upload-artifact"))).toBe(false)
  const fixture = readFileSync(
    new URL("../../../.github/scripts/computer-helper-signing-fixture.sh", import.meta.url),
    "utf8",
  )
  expect(fixture).toContain(
    'sudo /usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign -k "$keychain" "$certificate"',
  )
  expect(fixture).toContain('VECTOR_TEST_CODESIGN_CERTIFICATE="$certificate"')
  expect(fixture).toContain("--test-name-pattern '^native certificate signing'")
  expect(fixture).toContain('bash "$GITHUB_WORKSPACE/.github/scripts/computer-helper-signing-cleanup.sh"')
  expect(fixture).not.toMatch(/build-computer-helper|--timestamp=none/)
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const name of ["mac", "windows"]) expect(record(release[name]).needs).toContain("computer-helper")
  for (const value of Object.values(release))
    expect(JSON.stringify(value)).not.toContain("computer-helper-macos-signing")
})

test("macOS overlay diagnostics require explicit native dispatch and keep all cancellation groups independent", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(inputs.computer_helper_macos_overlay_only).toMatchObject({ type: "boolean", default: false })
  expect(Object.keys(inputs).length).toBeLessThanOrEqual(10)
  const all = record(main.document.jobs)
  const diagnostic = record(all["computer-helper-macos-overlay"])
  const selected = { computer_helper: true, computer_helper_macos_overlay_only: true }
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const overlay of [false, true])
        expect(
          expression(
            String(diagnostic.if),
            { computer_helper: native, computer_helper_macos_overlay_only: overlay },
            event,
          ),
        ).toBe(event === "workflow_dispatch" && native && overlay)
  for (const [name, value] of Object.entries(all)) {
    expect(expression(String(record(value).if), selected), name).toBe(name === "computer-helper-macos-overlay")
    for (const event of ["workflow_dispatch", "pull_request", "push"])
      expect(expression(String(record(value).if), { computer_helper_macos_overlay_only: true }, event), name).toBe(
        expression(String(record(value).if), {}, event),
      )
  }
  const modes = [
    {},
    { computer_helper_windows_only: true },
    { computer_helper_linux_only: true },
    { computer_helper_windows_units_only: true },
    { computer_helper_macos_signing_only: true },
  ].flatMap((mode) => [
    { computer_helper: true, ...mode },
    { ...selected, ...mode },
  ])
  expect(new Set(modes.map((mode) => group(record(main.document.concurrency).group, mode))).size).toBe(modes.length)
})

test("the fast macOS overlay lane runs the real pinned Electron commands without helper/certificate/release work", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-macos-overlay"])
  expect(diagnostic["runs-on"]).toBe("macos-15")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "needs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  expect(current[0]!.name).toBe("Reject incompatible overlay selectors before setup")
  for (let bits = 0; bits < 16; bits++)
    expect(
      spawnSync("bash", ["--noprofile", "--norc", "-c", String(current[0]!.run)], {
        env: {
          ...process.env,
          WINDOWS_ONLY: String(Boolean(bits & 1)),
          LINUX_ONLY: String(Boolean(bits & 2)),
          WINDOWS_UNITS_ONLY: String(Boolean(bits & 4)),
          MACOS_SIGNING_ONLY: String(Boolean(bits & 8)),
        },
        timeout: 5000,
      }).status,
    ).toBe(bits === 0 ? 0 : 1)
  for (const name of [
    "Install the exact pinned Electron runtime",
    "Run real Electron overlay properties and controller lifecycle",
  ]) {
    const step = current.find((step) => step.name === name)!
    expect(step.run).toBe(steps(job("mac-build")).find((step) => step.name === name)?.run)
    expect(step.if).toBeUndefined()
    expect(step["continue-on-error"]).toBeUndefined()
  }
  expect(commands(diagnostic)).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(commands(diagnostic)).not.toMatch(/build-computer-helper|--native-stage|signing-fixture|tar -|native-ready/)
  expect(current.some((step) => String(step.uses).includes("upload-artifact"))).toBe(false)
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const value of Object.values(release))
    expect(JSON.stringify(value)).not.toContain("computer-helper-macos-overlay")
})
