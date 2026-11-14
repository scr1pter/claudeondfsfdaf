import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"
import {
  WINDOWS_NATIVE_CHECKS,
  WINDOWS_NATIVE_REASONS,
  WINDOWS_NATIVE_STAGES,
  WINDOWS_NATIVE_CODES,
} from "./computer-helper-selftest-windows"

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
const lines = (value: unknown) =>
  String(value)
    .trimEnd()
    .split("\n")
    .map((line) => line.trim())

// Run the workflows' actual simple conditions, rather than reproducing their routing logic in the fixture.
function expression(
  value: string,
  inputs: Record<string, unknown>,
  event = "workflow_dispatch",
  ref = "refs/heads/hands",
  needs: Record<string, unknown> = {},
  status: {
    cancelled?: boolean
    success?: boolean
    failure?: boolean
    steps?: Record<string, unknown>
    matrix?: Record<string, unknown>
  } = {},
  definition = helper,
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
      inputs: { ...inputDefaults(definition), ...inputs },
      needs,
      always: () => true,
      cancelled: () => status.cancelled ?? false,
      success: () => status.success ?? true,
      failure: () => status.failure ?? false,
      steps: status.steps ?? {},
      matrix: status.matrix ?? {},
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

function inputDefaults(definition: ReturnType<typeof workflow>) {
  const event = definition === helper ? "workflow_call" : "workflow_dispatch"
  const inputs = record(record(record(definition.document.on)[event]).inputs)
  return Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, record(input).default]))
}

function mainExpression(
  value: string,
  inputs: Record<string, unknown>,
  event = "workflow_dispatch",
  ref = "refs/heads/hands",
) {
  return expression(value, inputs, event, ref, {}, {}, main)
}

function group(value: unknown, inputs: Record<string, unknown>, ref = "refs/heads/hands", definition = main) {
  if (typeof value !== "string") throw new Error("Expected a concurrency group.")
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, code: string) =>
    String(expression(code, inputs, "workflow_dispatch", ref, {}, {}, definition)),
  )
}

function helperGroup(value: unknown, inputs: Record<string, unknown>, ref = "refs/heads/hands") {
  return group(value, inputs, ref, helper)
}

const targets = [
  "all",
  "linux",
  "windows",
  "windows-units",
  "macos-signing",
  "macos-overlay",
  "windows-overlay",
] as const
const booleanSelectors = [
  "computer_helper",
  "desktop_engine_node",
  "hands_ui",
  "hands_benchmark",
  "release_evidence",
  "production_benchmark",
  "offline_footprint",
] as const
const ordinaryJobs = ["computer-helper", "unit", "desktop-engine-node", "engine-linux", "engine-windows", "e2e"]
const targetJobs = {
  all: "computer-helper",
  linux: "computer-helper",
  windows: "computer-helper",
  "windows-units": "computer-helper-windows-units",
  "macos-signing": "computer-helper-macos-signing",
  "macos-overlay": "computer-helper-macos-overlay",
  "windows-overlay": "computer-helper-windows-overlay",
}
const dispatchModes: { inputs: Record<string, unknown>; jobs: string[] }[] = [
  { inputs: {}, jobs: ordinaryJobs },
  ...targets.map((target) => ({
    inputs: { computer_helper: true, computer_helper_target: target },
    jobs: [targetJobs[target]],
  })),
  { inputs: { desktop_engine_node: true }, jobs: ["desktop-engine-node"] },
  { inputs: { hands_ui: true }, jobs: ["hands-ui"] },
  { inputs: { hands_benchmark: true }, jobs: ["hands-benchmark"] },
  { inputs: { hands_ui: true, hands_benchmark: true }, jobs: ["hands-ui", "hands-benchmark"] },
  { inputs: { release_evidence: true }, jobs: ["release-evidence"] },
  { inputs: { production_benchmark: true }, jobs: ["production-benchmark"] },
  { inputs: { offline_footprint: true }, jobs: ["offline-footprint"] },
]

function validateDispatch(inputs: Record<string, unknown>) {
  const validator = record(record(main.document.jobs)["validate-dispatch"])
  const step = steps(validator)[0]!
  return spawnSync("bash", ["--noprofile", "--norc", "-c", String(step.run)], {
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(record(step.env)).map(([name, value]) => [name, String(mainExpression(String(value), inputs))]),
      ),
    },
    encoding: "utf8",
    timeout: 5000,
  })
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

test("dispatch selectors stay within GitHub's input limit and every expensive job waits for validation", () => {
  const inputs = record(record(record(main.document.on).workflow_dispatch).inputs)
  expect(Object.keys(inputs).toSorted()).toEqual([...booleanSelectors, "computer_helper_target"].toSorted())
  expect(Object.keys(inputs)).toHaveLength(8)
  expect(Object.keys(inputs).length).toBeLessThanOrEqual(10)
  expect(inputs.computer_helper_target).toMatchObject({ type: "choice", default: "all", options: [...targets] })
  for (const name of booleanSelectors) expect(inputs[name]).toMatchObject({ type: "boolean", default: false })
  // Undefined inputs used to hide false-vs-undefined routing errors and the helper's true E2E default.
  expect(mainExpression("inputs.offline_footprint", {})).toBe(false)
  expect(mainExpression("inputs.computer_helper_target", {})).toBe("all")
  expect(expression("inputs['full-desktop-e2e']", {})).toBe(true)

  const all = record(main.document.jobs)
  const validator = record(all["validate-dispatch"])
  expect(validator.if).toBeUndefined()
  expect(validator.needs).toBeUndefined()
  expect(validator["runs-on"]).toBe("ubuntu-24.04")
  expect(validator["timeout-minutes"]).toBe(2)
  expect(validator.permissions).toEqual({ contents: "read" })
  expect(validator["continue-on-error"]).toBeUndefined()
  const current = steps(validator)
  expect(current).toHaveLength(1)
  expect(current[0]!.name).toBe("Validate workflow dispatch selectors before setup")
  expect(current[0]!.shell).toBe("bash")
  expect(current[0]!.uses).toBeUndefined()
  expect(current[0]!["continue-on-error"]).toBeUndefined()
  expect(Object.keys(record(current[0]!.env)).toSorted()).toEqual(
    [...booleanSelectors.map((name) => name.toUpperCase()), "COMPUTER_HELPER_TARGET"].toSorted(),
  )
  for (const [name, value] of Object.entries(all)) {
    if (name === "validate-dispatch") continue
    const needs = record(value).needs
    expect(typeof needs === "string" ? [needs] : needs, name).toContain("validate-dispatch")
    expect(String(record(value).if), name).not.toMatch(/always\(\)|failure\(\)/)
  }
})

test("valid native choices, Node, Hands and study modes run only their named jobs", () => {
  const all = record(main.document.jobs)
  for (const mode of dispatchModes)
    for (const [name, value] of Object.entries(all))
      expect(
        mainExpression(String(record(value).if ?? "true"), mode.inputs),
        `${name}: ${JSON.stringify(mode.inputs)}`,
      ).toBe(name === "validate-dispatch" || mode.jobs.includes(name))
  for (const event of ["pull_request", "push"])
    for (const [name, value] of Object.entries(all))
      expect(mainExpression(String(record(value).if ?? "true"), {}, event), `${name}: ${event}`).toBe(
        name === "validate-dispatch" || ordinaryJobs.includes(name),
      )
})

test("the actual cheap validator rejects mixed modes, orphan or unknown targets and nonboolean flags", () => {
  for (const mode of dispatchModes) {
    const result = validateDispatch(mode.inputs)
    expect(result.error).toBeUndefined()
    expect(result.status, `${JSON.stringify(mode.inputs)}: ${result.stdout} ${result.stderr}`).toBe(0)
  }
  for (let bits = 0; bits < 1 << booleanSelectors.length; bits++) {
    const mode = Object.fromEntries(booleanSelectors.map((name, index) => [name, !!(bits & (1 << index))]))
    const groups = [
      mode.computer_helper,
      mode.desktop_engine_node,
      mode.hands_ui || mode.hands_benchmark,
      mode.release_evidence,
      mode.production_benchmark,
      mode.offline_footprint,
    ].filter(Boolean).length
    if (groups > 1)
      for (const [name, value] of Object.entries(record(main.document.jobs))) {
        if (name === "validate-dispatch") continue
        expect(mainExpression(String(record(value).if), mode), name).toBe(false)
      }
  }
  // Keep real Bash process count bounded on Windows; exhaust every condition above without spawning per tuple.
  for (const mode of [
    { computer_helper: true, desktop_engine_node: true },
    { computer_helper: true, hands_ui: true },
    { computer_helper: true, hands_benchmark: true },
    { desktop_engine_node: true, hands_ui: true, hands_benchmark: true },
    { hands_ui: true, release_evidence: true },
    { hands_benchmark: true, production_benchmark: true },
    { offline_footprint: true, release_evidence: true },
    { production_benchmark: true, offline_footprint: true },
    { release_evidence: true, production_benchmark: true },
    { offline_footprint: true, desktop_engine_node: true },
    Object.fromEntries(booleanSelectors.map((name) => [name, true])),
  ])
    expect(validateDispatch(mode).status, JSON.stringify(mode)).toBe(1)
  for (const target of targets.slice(1)) expect(validateDispatch({ computer_helper_target: target }).status).toBe(1)
  for (const target of ["unknown", "WINDOWS", "windows,linux"])
    expect(validateDispatch({ computer_helper: true, computer_helper_target: target }).status).toBe(1)
  for (const flag of booleanSelectors) expect(validateDispatch({ [flag]: "not-boolean" }).status, flag).toBe(1)
})

test("dispatch cancellation groups distinguish every valid mode and cannot be reused by invalid mixed flags", () => {
  const cancellation = record(main.document.concurrency)
  expect(cancellation["cancel-in-progress"]).toBe(true)
  const groups = dispatchModes.map((mode) => group(cancellation.group, mode.inputs))
  expect(new Set(groups).size).toBe(dispatchModes.length)
  for (const mode of dispatchModes)
    expect(group(cancellation.group, mode.inputs, "refs/heads/another-task")).not.toBe(
      group(cancellation.group, mode.inputs),
    )
  for (let bits = 0; bits < 1 << booleanSelectors.length; bits++) {
    const mode = Object.fromEntries(booleanSelectors.map((name, index) => [name, !!(bits & (1 << index))]))
    const selected = [
      mode.computer_helper,
      mode.desktop_engine_node,
      mode.hands_ui || mode.hands_benchmark,
      mode.release_evidence,
      mode.production_benchmark,
      mode.offline_footprint,
    ].filter(Boolean).length
    if (selected > 1) expect(groups).not.toContain(group(cancellation.group, mode))
  }
  expect(group(cancellation.group, {})).toBe(group(cancellation.group, inputDefaults(main)))
  const child = record(helper.document.concurrency)
  expect(child["cancel-in-progress"]).toBe(true)
  const native = helperGroup(child.group, { "artifact-suffix": "fixture" })
  expect(groups).not.toContain(native)
  expect(native).not.toBe(helperGroup(child.group, { "artifact-suffix": "fixture" }, "refs/heads/another-task"))
  expect(mainExpression(String(cancellation.group), {}, "push", "refs/heads/main")).toBe("test-1")
  expect(mainExpression(String(cancellation.group), { computer_helper: true }, "pull_request")).toBe(
    mainExpression(String(cancellation.group), {}, "pull_request"),
  )
})

test("Windows and Linux choices map only their native reusable-workflow selectors", () => {
  const reuse = record(record(main.document.jobs)["computer-helper"])
  for (const event of ["workflow_dispatch", "pull_request", "push"])
    for (const native of [false, true])
      for (const target of targets)
        for (const [selector, selected] of [
          ["windows-only", "windows"],
          ["linux-only", "linux"],
        ])
          expect(
            mainExpression(
              String(record(reuse.with)[selector!]),
              { computer_helper: native, computer_helper_target: target },
              event,
            ),
          ).toBe(event === "workflow_dispatch" && native && target === selected)
  const child = record(helper.document.concurrency)
  const suffix = { "artifact-suffix": "same-immutable-source" }
  expect(helperGroup(child.group, { ...suffix, "windows-only": true })).not.toBe(helperGroup(child.group, suffix))
  expect(helperGroup(child.group, { ...suffix, "windows-only": false })).toBe(helperGroup(child.group, suffix))
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
      expect(upload.name).toContain("needs.plan.outputs.suffix")
      if (typeof upload.path !== "string") throw new Error("Artifact uploads need explicit paths.")
      const filename = upload.path.split("/").at(-1)!
      if (filename === "computer-overlay-smoke.json") {
        expect(step.name).toBe("Preserve only the small overlay manifest diagnostic")
        expect(step.if).toBe("${{ always() && (needs.plan.outputs.desktop == 'true') }}")
        expect(upload).toEqual({
          name: "computer-overlay-darwin-manifest-diagnostic-${{ needs.plan.outputs.suffix }}-${{ github.run_attempt }}",
          path: "packages/desktop/native/out/overlay-darwin/computer-overlay-smoke.json",
          "if-no-files-found": "ignore",
          overwrite: false,
          "retention-days": 7,
        })
        continue
      }
      expect(upload["retention-days"]).toBe(14)
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

test("native summaries expose failed and skipped closed rows in job logs without native payloads", () => {
  const reports = {
    "mac-build": ["computer-darwin-core.json", "computer-darwin-privileged.json"],
    "mac-test": ["computer-darwin-matrix.json", "computer-darwin-matrix-privileged.json"],
    "windows-build": ["computer-win32-core.json", "computer-win32-privileged.json"],
    "windows-arm64-test": ["computer-win32-arm64.json", "computer-win32-arm64-privileged.json"],
  }
  for (const [name, files] of Object.entries(reports)) {
    const summary = steps(job(name)).find(
      (step) => typeof step.run === "string" && step.run.includes('check.status === "skipped"'),
    )!
    expect(summary.if).toBe("${{ always() }}")
    expect(summary["timeout-minutes"]).toBe(2)
    const source = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/.exec(String(summary.run))?.[1]
    expect(source).toBeString()
    const temporary = mkdtempSync(path.join(tmpdir(), "vector-native-summary-"))
    const output = path.join(temporary, "summary.md")
    try {
      const checks = [
        { name: "unit", status: "passed", raw: "PRIVATE UNIT OUTPUT" },
        { name: "privileged.capture-color-patch", status: "failed", reason: "native_operation_failed" },
        { name: "privileged.secure-field-refusal", status: "skipped", reason: "noninteractive_desktop" },
      ]
      for (const file of files)
        writeFileSync(
          path.join(temporary, file),
          JSON.stringify({ checks, image: "PRIVATE SCREENSHOT", stderr: "PRIVATE NATIVE ERROR" }),
        )
      const result = spawnSync("node", ["--input-type=module", "-e", source!], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, RUNNER_TEMP: temporary, GITHUB_STEP_SUMMARY: output, WINDOWS_PROTOCOL: "true" },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe(readFileSync(output, "utf8"))
      for (const file of files)
        expect(result.stdout).toContain(
          `\n${file}: passed=1, failed=1, skipped=1\n- FAILED privileged.capture-color-patch: native_operation_failed\n- SKIPPED privileged.secure-field-refusal: noninteractive_desktop\n`,
        )
      expect(result.stdout).not.toMatch(/PRIVATE|image|stderr|unit:|\"checks\"/)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
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

test("reusable Linux-only and Windows-only cancellation groups remain independent", () => {
  const child = record(helper.document.concurrency)
  const suffix = { "artifact-suffix": "same-immutable-source" }
  const modes = [{}, { "windows-only": true }, { "linux-only": true }, { "windows-only": true, "linux-only": true }]
  expect(new Set(modes.map((mode) => helperGroup(child.group, { ...suffix, ...mode }))).size).toBe(modes.length)
  expect(helperGroup(child.group, { ...suffix, "linux-only": false })).toBe(helperGroup(child.group, suffix))
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

test("Windows unit and diagnostic lanes exercise the packed Main pin reader before native builds", () => {
  const all = record(main.document.jobs)
  const unit = record(all.unit)
  expect(record(record(unit.strategy).matrix).settings).toContainEqual({ name: "windows", host: "windows-latest" })
  const desktop = steps(unit).find((step) => step.name === "Run desktop computer-use tests")!
  expect(desktop["working-directory"]).toBe("packages/desktop")
  expect(desktop.if).toBe("${{ !cancelled() }}")
  expect(String(desktop.run)).toMatch(/for file in [^\n]*\.\/scripts\/verify-computer-helper-windows\.test\.ts(?: |;)/)

  const diagnostic = record(all["computer-helper-windows-units"])
  expect(diagnostic["runs-on"]).toBe("windows-2025")
  expect(record(record(diagnostic.defaults).run)["working-directory"]).toBe("packages/desktop")
  const current = steps(diagnostic)
  const reader = current.find((step) => step.name === "Test the Windows packaged Main pin reader")!
  expect(reader.if).toBeUndefined()
  expect(reader["continue-on-error"]).toBeUndefined()
  expect(reader["timeout-minutes"]).toBe(2)
  expect(String(reader.run)).toContain(
    "bun --no-env-file test --timeout 30000 --only-failures ./scripts/verify-computer-helper-windows.test.ts",
  )
  expect(String(reader.run)).toContain(
    'if ($LASTEXITCODE -ne 0) { throw "Windows packaged Main pin reader tests failed." }',
  )
  expect(current.indexOf(reader)).toBeGreaterThan(
    current.findIndex((step) => step.name === "Install frozen dependencies without lifecycle scripts"),
  )
  expect(current.indexOf(reader)).toBeLessThan(
    current.findIndex((step) => step.name === "Build only the x64 native diagnostic artifacts"),
  )
})

test("Windows diagnostics independently require the hidden signature observer after native runtime checks", () => {
  const current = steps(record(record(main.document.jobs)["computer-helper-windows-units"]))
  const build = current.findIndex((step) => step.name === "Build only the x64 native diagnostic artifacts")
  const observer = current.find(
    (step) => step.name === "Observe the actual built helper signature through the hidden Windows observer",
  )!
  expect(build).toBeGreaterThan(-1)
  expect(current.indexOf(observer)).toBeGreaterThan(build)
  expect(current.indexOf(observer)).toBeGreaterThan(
    current.findIndex((step) => step.name === "Run Windows unit and fresh version/probe checks"),
  )
  expect(observer.if).toBe("${{ always() && steps.native_build.outcome == 'success' }}")
  expect(current[build]!.id).toBe("native_build")
  expect(current.indexOf(observer)).toBeGreaterThan(current.findIndex((step) => step.id === "staged_move_probe"))
  for (const outcome of ["success", "failure", "skipped", "cancelled"])
    for (const successful of [false, true])
      expect(
        expression(
          String(observer.if),
          {},
          "workflow_dispatch",
          "refs/heads/hands",
          {},
          {
            success: successful,
            steps: { native_build: { outcome } },
          },
        ),
      ).toBe(outcome === "success")
  expect(observer["continue-on-error"]).toBeUndefined()
  expect(observer["timeout-minutes"]).toBe(2)
  const script = String(observer.run)
  expect(script).toContain("bun --no-env-file --eval")
  expect(script).toContain(
    'import { observeWindowsHelperAuthenticode } from "./scripts/verify-computer-helper-windows.ts"',
  )
  expect(script).toContain(
    'await observeWindowsHelperAuthenticode(path.resolve("native/out/win32/x64/vector-computer.exe"))',
  )
  expect(script).toContain('actual.status !== "NotSigned" || actual.publisher !== null || actual.thumbprint !== null')
  expect(script).toContain('if ($LASTEXITCODE -ne 0) { throw "The actual hidden Windows signature observer failed." }')
  expect(script).not.toMatch(/--expect-signing|--publisher|continue-on-error|exit 0|process\.env/)
})

test("x64 diagnostics reuse bounded native checks and isolated scenarios without release evidence", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-windows-units"])
  expect(diagnostic["runs-on"]).toBe("windows-2025")
  expect(diagnostic.strategy).toEqual({ "fail-fast": false, matrix: { diagnostic: ["baseline", "move-probe"] } })
  expect(diagnostic.name).toContain("${{ matrix.diagnostic }}")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  expect(diagnostic.needs).toBe("validate-dispatch")
  expect(current[0]!.name).toBe("Checkout repository")
  const script = commands(diagnostic)
  expect(script).toContain("--platform win32 --arch x64 --channel prod --out native/out/win32")
  expect(script).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(script).not.toMatch(/--arch (?:arm64|x64,arm64)|--privileged (?:auto|require)|tar -|native-ready/)
  // Only these labelled manual diagnostics enter the finite native stage; no stage archive is restored.
  const staged = current.find((step) => step.name === "Run the actual medium-token staged overlay diagnostic")!
  const probe = current.find(
    (step) => step.name === "Run the movement probe first on its fresh VM (no release evidence)",
  )!
  for (const step of current.filter((step) => step !== staged && step !== probe))
    expect(JSON.stringify(step), String(step.name)).not.toContain("--native-stage")
  expect(String(staged.run).match(/--native-stage/g)).toHaveLength(1)
  expect(script).not.toContain("computer-overlay-smoke-artifact.ts")
  const uploads = current.filter((step) => String(step.uses).includes("upload-artifact"))
  expect(uploads).toHaveLength(4)
  expect(uploads[0]!.if).toBe("${{ always() }}")
  expect(uploads[0]!.with).toEqual({
    name: "computer-helper-win32-x64-diagnostic-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.diagnostic }}",
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
    name: "computer-helper-win32-direct-node-diagnostic-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.diagnostic }}",
    path: "${{ runner.temp }}/computer-win32-direct-node.json",
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  expect(current.indexOf(compile)).toBeGreaterThan(current.indexOf(protocol))
  expect(current.indexOf(paired)).toBeGreaterThan(current.indexOf(compile))
  expect(current.indexOf(uploads[1]!)).toBeGreaterThan(current.indexOf(paired))
  const isolated = current.find((step) => step.name === "Run explicitly isolated Windows scenarios")!
  const originalIsolated = steps(job("windows-build")).find((step) => step.name === isolated.name)!
  expect(isolated.run).toBe(originalIsolated.run)
  expect(isolated["timeout-minutes"]).toBe(originalIsolated["timeout-minutes"])
  expect(isolated["continue-on-error"]).toBe(true)
  expect(isolated.env).toEqual({ PRIVILEGED_REQUIRED: "false", VECTOR_COMPUTER_TEST_ISOLATED: "1" })
  expect(current.indexOf(isolated)).toBeGreaterThan(current.indexOf(protocol))
  for (const mode of ["baseline", "move-probe", "unknown"])
    for (const successful of [false, true])
      for (const outcome of ["success", "failure", "skipped", "cancelled"])
        expect(
          expression(
            String(isolated.if),
            {},
            "workflow_dispatch",
            "refs/heads/hands",
            {},
            {
              success: successful,
              steps: { required_protocol: { outcome } },
              matrix: { diagnostic: mode },
            },
          ),
        ).toBe(successful && outcome === "success" && mode === "baseline")
  expect(uploads[2]!.if).toBe("${{ always() }}")
  expect(uploads[2]!.with).toEqual({
    name: "computer-helper-win32-x64-isolated-diagnostic-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.diagnostic }}",
    path: "${{ runner.temp }}/computer-win32-privileged.json",
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  expect(current.indexOf(uploads[2]!)).toBeGreaterThan(current.indexOf(isolated))
  const electron = current.find(
    (step) => step.name === "Install the pinned Electron runtime for the staged diagnostic",
  )!
  const stage = current.find((step) => step.name === "Build the source-bound x64 native overlay diagnostic stage")!
  expect(electron["timeout-minutes"]).toBe(5)
  // Each preparation command is followed only by its own throw, so its failure is never reset or ignored.
  expect(lines(electron.run)).toEqual([
    "node node_modules/electron/install.js",
    expect.stringMatching(/^if \(\$LASTEXITCODE -ne 0\) \{ throw "[^"]+" \}$/),
  ])
  expect(stage["timeout-minutes"]).toBe(15)
  expect(lines(stage.run)).toEqual([
    "bun --no-env-file ./scripts/diagnose-build-computer-overlay-smoke.ts --platform win32 --helper native/out/win32/x64 --out native/out/overlay-win32",
    expect.stringMatching(/^if \(\$LASTEXITCODE -ne 0\) \{ throw "[^"]+" \}$/),
  ])
  expect(staged["timeout-minutes"]).toBe(3)
  expect(staged.env).toEqual({ VECTOR_COMPUTER_TEST_ISOLATED: "1", VECTOR_COMPUTER_SMOKE_MOVE_PROBE: "0" })
  expect(record(record(diagnostic.defaults).run).shell).toBe("pwsh")
  // A prerequisite 77 is a summarized skip that ends the step, never a pass; every other nonzero status throws.
  expect(lines(staged.run)).toEqual([
    'bun --no-env-file ./scripts/computer-overlay-smoke.ts --native-stage native/out/overlay-win32 2>&1 | Tee-Object -FilePath "$env:RUNNER_TEMP/computer-win32-staged-diagnostic.log"',
    "$status = $LASTEXITCODE",
    "if ($status -eq 77) {",
    '"SKIPPED: an actual pre-Electron native prerequisite is unavailable." >> $env:GITHUB_STEP_SUMMARY',
    "exit 0",
    "} elseif ($status -ne 0) {",
    expect.stringMatching(/^throw "[^"]+"$/),
    "}",
  ])
  for (const step of [electron, stage, staged]) {
    expect(step.if, String(step.name)).toBe(
      step === staged
        ? "${{ success() && steps.required_protocol.outcome == 'success' && matrix.diagnostic == 'baseline' }}"
        : "${{ success() && steps.required_protocol.outcome == 'success' }}",
    )
    expect(step["continue-on-error"], String(step.name)).toBeUndefined()
    expect(step.shell, String(step.name)).toBeUndefined()
    for (const mode of ["baseline", "move-probe", "unknown"])
      for (const successful of [false, true])
        for (const outcome of ["success", "failure", "skipped", "cancelled"])
          expect(
            expression(
              String(step.if),
              {},
              "workflow_dispatch",
              "refs/heads/hands",
              {},
              { success: successful, steps: { required_protocol: { outcome } }, matrix: { diagnostic: mode } },
            ),
          ).toBe(successful && outcome === "success" && (step !== staged || mode === "baseline"))
  }
  expect(current.indexOf(electron)).toBeGreaterThan(current.indexOf(uploads[2]!))
  expect(current.indexOf(stage)).toBeGreaterThan(current.indexOf(electron))
  expect(current.indexOf(staged)).toBeGreaterThan(current.indexOf(stage))
  expect(current.indexOf(uploads[3]!)).toBeGreaterThan(current.indexOf(staged))
  // The staged evidence is the bounded log and stage manifest only, never the stage itself.
  expect(uploads[3]!.if).toBe("${{ always() }}")
  expect(uploads[3]!.with).toEqual({
    name: "computer-overlay-win32-x64-native-diagnostic-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.diagnostic }}",
    path: expect.any(String),
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  expect(lines(record(uploads[3]!.with).path)).toEqual([
    "${{ runner.temp }}/computer-win32-staged-diagnostic.log",
    "${{ runner.temp }}/computer-win32-move-probe-diagnostic.log",
    "packages/desktop/native/out/overlay-win32/computer-overlay-smoke.json",
  ])
  expect(diagnostic["timeout-minutes"]).toBe(45)
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const name of ["mac", "windows"]) expect(record(release[name]).needs).toContain("computer-helper")
  for (const value of Object.values(release))
    expect(JSON.stringify(value)).not.toContain("computer-helper-windows-units")
})

test("a fresh-VM movement probe cannot contaminate or waive the independent unchanged baseline Stop", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-windows-units"])
  const current = steps(diagnostic)
  expect(diagnostic.strategy).toEqual({ "fail-fast": false, matrix: { diagnostic: ["baseline", "move-probe"] } })
  expect(diagnostic["runs-on"]).toBe("windows-2025")
  expect(diagnostic["continue-on-error"]).toBeUndefined()
  expect(diagnostic.outputs).toBeUndefined()
  expect(current.some((step) => String(step.uses).includes("download-artifact"))).toBe(false)
  const baseline = current.find((step) => step.id === "staged_native")!
  const probe = current.find((step) => step.id === "staged_move_probe")!
  const isolated = current.find((step) => step.name === "Run explicitly isolated Windows scenarios")!
  const upload = current.find((step) => step.name === "Preserve the bounded staged overlay diagnostic evidence")!
  expect(baseline["continue-on-error"]).toBeUndefined()
  expect(record(baseline.env).VECTOR_COMPUTER_SMOKE_MOVE_PROBE).toBe("0")
  expect(probe.if).toBe(
    "${{ success() && steps.required_protocol.outcome == 'success' && matrix.diagnostic == 'move-probe' }}",
  )
  expect(probe["continue-on-error"]).toBeUndefined()
  expect(probe["timeout-minutes"]).toBe(3)
  expect(probe.env).toEqual({ VECTOR_COMPUTER_TEST_ISOLATED: "1", VECTOR_COMPUTER_SMOKE_MOVE_PROBE: "1" })
  expect(String(probe.run).match(/--native-stage/g)).toHaveLength(1)
  expect(String(probe.run)).toContain("DIAGNOSTIC ONLY")
  expect(String(probe.run)).toContain('ForEach-Object { "MOVE-PROBE-ONLY $_" }')
  expect(String(probe.run)).toContain("computer-win32-move-probe-diagnostic.log")
  expect(String(probe.run)).not.toContain('FilePath "$env:RUNNER_TEMP/computer-win32-staged-diagnostic.log"')
  expect(String(probe.run)).toContain("$status = $LASTEXITCODE")
  expect(String(probe.run)).toContain("if ($status -ne 0) { throw")
  expect(String(probe.run)).not.toMatch(/exit 0|--no-sandbox|Remove-Item|SendInput|Clear/)
  expect(current.indexOf(probe)).toBeGreaterThan(current.indexOf(baseline))
  expect(current.indexOf(upload)).toBeGreaterThan(current.indexOf(probe))
  for (const step of current.filter((step) => String(step.uses).includes("upload-artifact")))
    expect(String(record(step.with).name)).toEndWith("-${{ matrix.diagnostic }}")
  // The probe VM performs no prior isolated desktop scenario or baseline DOWN. Conversely,
  // the baseline VM never runs the probe, and its result cannot be replaced by the other leg.
  for (const mode of ["baseline", "move-probe", "unknown"])
    for (const successful of [false, true])
      for (const outcome of ["success", "failure", "skipped", "cancelled"])
        for (const previous of ["success", "failure", "skipped", "cancelled"])
          for (const step of [isolated, baseline, probe])
            expect(
              expression(
                String(step.if),
                {},
                "workflow_dispatch",
                "refs/heads/hands",
                {},
                {
                  success: successful,
                  failure: !successful,
                  steps: { required_protocol: { outcome }, staged_native: { outcome: previous } },
                  matrix: { diagnostic: mode },
                },
              ),
              `${String(step.name)}: ${mode}/${successful}/${outcome}/${previous}`,
            ).toBe(successful && outcome === "success" && mode === (step === probe ? "move-probe" : "baseline"))
})

test("the x64 diagnostic logs closed failed stages and codes without exposing native payloads", () => {
  const current = steps(record(record(main.document.jobs)["computer-helper-windows-units"]))
  const isolated = current.findIndex((step) => step.name === "Run explicitly isolated Windows scenarios")
  const summary = current.find((step) => step.name === "Summarize x64 native diagnostic rows")!
  expect(current.indexOf(summary)).toBeGreaterThan(isolated)
  expect(summary.if).toBe("${{ always() }}")
  expect(summary["timeout-minutes"]).toBe(2)
  expect(summary["continue-on-error"]).toBeUndefined()
  expect(summary.shell).toBe("bash")
  expect(String(summary.run).split("\n").slice(0, 2)).toEqual([
    'VECTOR_WINDOWS_NATIVE_DIAGNOSTICS="$(bun --no-env-file --eval \'import { WINDOWS_NATIVE_CHECKS, WINDOWS_NATIVE_REASONS, WINDOWS_NATIVE_STAGES, WINDOWS_NATIVE_CODES } from "./scripts/computer-helper-selftest-windows.ts"; process.stdout.write(JSON.stringify({ checks: WINDOWS_NATIVE_CHECKS.privileged, reasons: WINDOWS_NATIVE_REASONS, stages: WINDOWS_NATIVE_STAGES, codes: WINDOWS_NATIVE_CODES }))\')"',
    "export VECTOR_WINDOWS_NATIVE_DIAGNOSTICS",
  ])
  const source = /\nnode --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/.exec(String(summary.run))?.[1]
  expect(source).toBeString()
  const temporary = mkdtempSync(path.join(tmpdir(), "vector-native-diagnostic-summary-"))
  const output = path.join(temporary, "summary.md")
  const env = {
    ...process.env,
    RUNNER_TEMP: temporary,
    GITHUB_STEP_SUMMARY: output,
    VECTOR_WINDOWS_NATIVE_DIAGNOSTICS: JSON.stringify({
      checks: WINDOWS_NATIVE_CHECKS.privileged,
      reasons: WINDOWS_NATIVE_REASONS,
      stages: WINDOWS_NATIVE_STAGES,
      codes: WINDOWS_NATIVE_CODES,
    }),
  }
  try {
    const files = ["computer-win32-core.json", "computer-win32-direct-node.json", "computer-win32-privileged.json"]
    const diagnostic = { stage: "capture-window-item-full-ticket-expired", nativeCode: "timeout" }
    for (const file of files)
      writeFileSync(
        path.join(temporary, file),
        JSON.stringify({
          checks: [
            { name: "unit", status: "passed", stdout: "PRIVATE UNIT OUTPUT", ...diagnostic },
            {
              name: "privileged.capture-color-patch",
              status: "failed",
              reason: "native_operation_failed",
              ...diagnostic,
            },
            {
              name: "privileged.secure-field-refusal",
              status: "skipped",
              reason: "noninteractive_desktop",
              ...diagnostic,
            },
          ],
          image: "PRIVATE SCREENSHOT",
          stderr: "PRIVATE NATIVE ERROR",
        }),
      )
    writeFileSync(path.join(temporary, "unrelated.json"), JSON.stringify({ text: "PRIVATE UNRELATED FILE" }))
    const result = spawnSync("node", ["--input-type=module", "-e", source!], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe(readFileSync(output, "utf8"))
    for (const file of files)
      expect(result.stdout).toContain(
        `\n${file}: passed=1, failed=1, skipped=1\n- FAILED privileged.capture-color-patch: native_operation_failed${file === "computer-win32-privileged.json" ? " [stage=capture-window-item-full-ticket-expired, nativeCode=timeout]" : ""}\n- SKIPPED privileged.secure-field-refusal: noninteractive_desktop\n`,
      )
    expect(result.stdout.match(/\[stage=/g)).toHaveLength(1)
    expect(result.stdout).not.toMatch(/PRIVATE|image|stderr|unit:|\"checks\"/)

    const invalid = [
      { stage: "PRIVATE WINDOW TITLE", nativeCode: "timeout" },
      { stage: diagnostic.stage, nativeCode: "PRIVATE NATIVE ERROR" },
      { stage: diagnostic.stage },
      { nativeCode: "timeout" },
      { stage: null, nativeCode: "timeout" },
      { stage: diagnostic.stage, nativeCode: ["timeout"] },
    ]
    writeFileSync(
      path.join(temporary, "computer-win32-privileged.json"),
      JSON.stringify({
        checks: [
          ...invalid.map((value) => ({
            name: "privileged.capture-color-patch",
            status: "failed",
            reason: "native_operation_failed",
            ...value,
          })),
          {
            name: "privileged.capture-color-patch",
            status: "passed",
            reason: "native_operation_failed",
            ...diagnostic,
          },
          { name: "privileged", status: "failed", reason: "native_operation_failed", ...diagnostic },
          { name: "unit", status: "failed", reason: "native_operation_failed", ...diagnostic },
          { name: "privileged.unknown-check", status: "failed", reason: "native_operation_failed", ...diagnostic },
          { name: "privileged.capture-color-patch", status: "failed", reason: "native_failure", ...diagnostic },
        ],
      }),
    )
    const rejected = spawnSync("node", ["--input-type=module", "-e", source!], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    })
    expect(rejected.error).toBeUndefined()
    expect(rejected.status, rejected.stderr).toBe(0)
    expect(rejected.stderr).toBe("")
    expect(rejected.stdout).not.toMatch(/PRIVATE|stage=|nativeCode=/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
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

test("the fast macOS certificate lane shares the real fixture and cleanup without native build or release credit", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-macos-signing"])
  expect(diagnostic["runs-on"]).toBe("macos-15")
  expect(record(diagnostic.env).DEVELOPER_DIR).toBe("/Applications/Xcode_16.4.app/Contents/Developer")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  expect(diagnostic.needs).toBe("validate-dispatch")
  expect(current[0]!.name).toBe("Checkout repository")
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

test("the fast macOS overlay lane runs the real pinned Electron commands without helper/certificate/release work", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-macos-overlay"])
  expect(diagnostic["runs-on"]).toBe("macos-15")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  for (const key of ["outputs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  expect(diagnostic.needs).toBe("validate-dispatch")
  expect(current[0]!.name).toBe("Checkout repository")
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

test("the fast Windows overlay lane preserves stock Electron assertions and bounded logs without native or release work", () => {
  const diagnostic = record(record(main.document.jobs)["computer-helper-windows-overlay"])
  expect(diagnostic["runs-on"]).toBe("windows-2025")
  expect(diagnostic.permissions).toEqual({ contents: "read" })
  expect(record(diagnostic.defaults).run).toEqual({ shell: "pwsh", "working-directory": "packages/desktop" })
  for (const key of ["outputs", "continue-on-error", "environment"]) expect(diagnostic[key]).toBeUndefined()
  const current = steps(diagnostic)
  const original = steps(job("windows-build"))
  const install = current.find((step) => step.name === "Install the exact pinned Electron runtime")!
  expect(install.run).toBe(original.find((step) => step.name === "Install the exact pinned Electron runtime")?.run)
  const smoke = current.find((step) => step.name === "Run real Electron overlay properties and controller lifecycle")!
  expect(smoke.run).toContain("bun --no-env-file ./scripts/computer-overlay-smoke.ts 2>&1 | Tee-Object")
  expect(smoke.run).toContain(
    'if ($LASTEXITCODE -ne 0) { throw "The actual Electron overlay properties or controller lifecycle failed." }',
  )
  expect(smoke["timeout-minutes"]).toBe(3)
  expect(smoke["continue-on-error"]).toBeUndefined()
  const upload = current.at(-1)!
  expect(upload.if).toBe("${{ always() }}")
  expect(upload.with).toEqual({
    name: "computer-overlay-win32-diagnostic-${{ github.sha }}-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/computer-win32-overlay-diagnostic.log",
    "if-no-files-found": "ignore",
    overwrite: false,
    "retention-days": 7,
  })
  expect(commands(diagnostic)).toContain("bun install --frozen-lockfile --ignore-scripts")
  expect(commands(diagnostic)).not.toMatch(
    /build-computer-helper|computer-helper-selftest|--native-stage|--require-native|signing-fixture|tar -|native-ready/,
  )
  for (const step of current) {
    if (typeof step.uses === "string") expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/)
    expect(step.env === undefined || !JSON.stringify(step.env).includes("VECTOR_COMPUTER_TEST_ISOLATED")).toBe(true)
  }
  const release = record(workflow("vector-desktop-release.yml").document.jobs)
  for (const value of Object.values(release))
    expect(JSON.stringify(value)).not.toContain("computer-helper-windows-overlay")
})
