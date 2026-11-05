import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
  const needs = { plan: { outputs: { extended: "true", windows: "true", "windows-protocol": "true" } } }
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
