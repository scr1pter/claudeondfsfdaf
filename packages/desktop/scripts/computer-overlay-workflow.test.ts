import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../../../.github/workflows/computer-helper.yml", import.meta.url), "utf8")
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a workflow mapping.")
  return value as Record<string, unknown>
}
const jobs = record(record(Bun.YAML.parse(source)).jobs)
const job = (name: string) => record(jobs[name])
const steps = (name: string) => {
  const value = job(name).steps
  if (!Array.isArray(value)) throw new Error("Expected executable workflow steps.")
  return value.map(record)
}
const commands = (name: string) =>
  steps(name)
    .flatMap((step) => (typeof step.run === "string" ? [step.run] : []))
    .join("\n")
const lines = (value: unknown) =>
  String(value)
    .trimEnd()
    .split("\n")
    .map((line) => line.trim())
const plan = steps("plan").find((step) => step.id === "plan")!

function desktopPlan(value: string, event: "push" | "workflow_dispatch" | "workflow_call") {
  if (typeof plan.run !== "string") throw new Error("The real desktop plan script is unavailable.")
  // Execute only the actual selection block: no checkout, git, network or desktop command.
  const begin = plan.run.indexOf("desktop=false\n")
  const end = plan.run.indexOf('echo "suffix=', begin)
  if (begin < 0 || end < begin) throw new Error("The real desktop selection block is unavailable.")
  const root = mkdtempSync(path.join(tmpdir(), "vector-computer-workflow-"))
  try {
    const output = path.join(root, "output")
    const result = spawnSync("bash", ["-c", plan.run.slice(begin, end)], {
      timeout: 1000,
      maxBuffer: 4096,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_OUTPUT: output,
        FULL_DESKTOP_E2E: value,
        EVENT_NAME: event,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    })
    if (result.error || result.status !== 0) throw new Error("The actual fixed desktop selection block failed.")
    return readFileSync(output, "utf8").trim()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function condition(value: unknown, desktop: boolean, windowsOnly = false) {
  if (typeof value !== "string") throw new Error("The desktop lane has no bounded routing condition.")
  return runInNewContext(
    value.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1"),
    {
      inputs: { "windows-only": windowsOnly },
      needs: { plan: { outputs: { desktop: desktop ? "true" : "false" } } },
    },
    { timeout: 100 },
  ) as unknown
}

test("an explicit reusable desktop false survives a push caller while direct CI pushes retain coverage", () => {
  expect(record(plan.env).FULL_DESKTOP_E2E).toBe("${{ toJSON(inputs['full-desktop-e2e']) }}")
  expect(desktopPlan("false", "push")).toBe("desktop=false")
  expect(desktopPlan("false", "workflow_call")).toBe("desktop=false")
  expect(desktopPlan("false", "workflow_dispatch")).toBe("desktop=false")
  expect(desktopPlan("true", "workflow_call")).toBe("desktop=true")
  expect(desktopPlan("true", "workflow_dispatch")).toBe("desktop=true")
  expect(desktopPlan('""', "push")).toBe("desktop=true")
})

test("Linux desktop lanes honor the actual plan and Windows-only routing", () => {
  for (const name of ["overlay-linux", "desktop-e2e-linux"]) {
    expect(condition(job(name).if, true, false)).toBe(true)
    expect(condition(job(name).if, false, false)).toBe(false)
    expect(condition(job(name).if, true, true)).toBe(false)
    expect(job(name)["runs-on"]).toBe("ubuntu-24.04")
  }
  expect(job("overlay-linux")["continue-on-error"]).toBeUndefined()
  expect(job("desktop-e2e-linux")["continue-on-error"]).toBe(true)
})

test("native overlay stages are separately restored, source-bound and archived without shipping substitutions", () => {
  for (const [name, platform, helper] of [
    ["mac-build", "darwin", "native/out/darwin"],
    ["windows-build", "win32", "native/out/win32/x64"],
  ]) {
    const current = steps(name!)
    const restore = current.find((step) => step.id === "overlay-restore")!
    expect(restore.if).toContain("inputs['reuse-artifacts']")
    expect(restore.run).toContain(`computer-overlay-smoke-artifact.ts --platform ${platform}`)
    const build = current.find((step) => String(step.name).startsWith("Build the source-bound never-shipped"))!
    expect(build.if).toContain("steps.overlay-restore.outputs.restored != 'true'")
    expect(build.run).toContain(`build-computer-overlay-smoke.ts --platform ${platform} --helper ${helper}`)
    const archive = current.find((step) => String(step.name).startsWith("Archive the verified never-shipped"))!
    expect(archive.run).toContain(
      `computer-overlay-smoke-artifact.ts --platform ${platform} --archive native/out/overlay-${platform}`,
    )
    const upload = current.find((step) => String(step.name).startsWith("Upload the immutable never-shipped"))!
    expect(record(upload.with).name).toBe(`computer-overlay-smoke-${platform}-\${{ needs.plan.outputs.suffix }}`)
    expect(record(upload.with).overwrite).toBe("${{ !inputs['reuse-artifacts'] }}")
    expect(upload.if).toContain("steps.overlay-restore.outputs.restored != 'true'")
  }
})

test("native prerequisite absence never swallows an assertion failure or authorizes a high-token input fallback", () => {
  for (const name of ["mac-build", "windows-build"]) {
    const actual = steps(name).find((step) => String(step.name).startsWith("Run actual isolated"))!
    expect(actual.if).toContain("inputs['isolated-desktop']")
    expect(actual["continue-on-error"]).toBeUndefined()
    expect(job(name)["continue-on-error"]).toBeUndefined()
    // The pinned bodies run under the runner's built-in job shell wrapper, which keeps a nonzero status failing.
    expect(actual.shell).toBeUndefined()
    expect(actual["timeout-minutes"]).toBe(3)
    expect(record(actual.env).VECTOR_COMPUTER_TEST_ISOLATED).toBe("1")
    expect(record(actual.env).PRIVILEGED_REQUIRED).toBe("${{ inputs['privileged-required'] }}")
    expect(actual.run).toContain("--require-native")
    expect(actual.run).toContain("--native-stage")
    expect(actual.run).not.toContain("--no-sandbox")
    expect(String(actual.run)).toMatch(/(?:==|\-eq) 77/)
    expect(String(actual.run)).toMatch(/(?:!=|\-ne) 0/)
    expect(String(actual.run)).not.toMatch(/continue-on-error|elevatedToken/)
  }

  // Only an already permitted pre-Electron prerequisite 77 may end the step successfully, after its explicit skip
  // summary; the smoke's status is read once, right after it runs, and every other nonzero status fails the step.
  const windows = String(
    steps("windows-build").find((step) => String(step.name).startsWith("Run actual isolated"))!.run,
  )
  expect(record(record(job("windows-build").defaults).run).shell).toBe("pwsh")
  expect(lines(windows).filter((line) => !line.startsWith("#"))).toEqual([
    "$required = @()",
    'if ($env:PRIVILEGED_REQUIRED -eq "true") { $required = @("--require-native") }',
    "bun --no-env-file ./scripts/computer-overlay-smoke.ts --native-stage native/out/overlay-win32 @required",
    "$status = $LASTEXITCODE",
    'if ($status -eq 77 -and $env:PRIVILEGED_REQUIRED -ne "true") {',
    '"SKIPPED: an actual pre-Electron native prerequisite is unavailable." >> $env:GITHUB_STEP_SUMMARY',
    "exit 0",
    "} elseif ($status -ne 0) {",
    expect.stringMatching(/^throw "[^"]+"$/),
    "}",
  ])
  // PowerShell keywords and variable names are case-insensitive.
  expect(windows.match(/\bexit\b/gi)).toEqual(["exit"])
  expect(windows.match(/\$LASTEXITCODE\b/gi)).toEqual(["$LASTEXITCODE"])
  expect(windows).not.toContain("||")

  // Bash keeps the smoke's exact status: no exit 0, and a nonzero status other than the permitted 77 exits with itself.
  const mac = String(steps("mac-build").find((step) => String(step.name).startsWith("Run actual isolated"))!.run)
  expect(record(record(job("mac-build").defaults).run).shell).toBe("bash")
  expect(lines(mac)).toEqual([
    "set -euo pipefail",
    "native_args=(--native-stage native/out/overlay-darwin)",
    'if [[ "$PRIVILEGED_REQUIRED" == true ]]; then native_args+=(--require-native); fi',
    "status=0",
    'bun --no-env-file ./scripts/computer-overlay-smoke.ts "${native_args[@]}" || status=$?',
    'if [[ "$status" == 77 && "$PRIVILEGED_REQUIRED" != true ]]; then',
    'echo "SKIPPED: an actual pre-Electron native prerequisite is unavailable." >> "$GITHUB_STEP_SUMMARY"',
    'elif [[ "$status" != 0 ]]; then',
    'exit "$status"',
    "fi",
  ])
  expect(mac).not.toMatch(/\bexit 0\b|\|\|\s*true|set \+e/)
  expect(mac.match(/\bexit\b/g)).toEqual(["exit"])
})

test("Mac compiler feedback after a fatal controller failure cannot grant native, artifact or release credit", () => {
  const current = steps("mac-build")
  const controller = current.find((step) => step.id === "overlay_controller")!
  const build = current.find((step) => String(step.name).startsWith("Build the source-bound never-shipped"))!
  const protectedSteps = current.filter((step) =>
    /^(Run actual isolated macOS overlay|Archive the verified never-shipped|Upload the immutable never-shipped)/.test(
      String(step.name),
    ),
  )
  const evaluate = (
    step: Record<string, unknown>,
    state: { controller?: string; success?: boolean; cancelled?: boolean; desktop?: boolean; restored?: boolean } = {},
  ) =>
    runInNewContext(
      String(step.if)
        .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1")
        .replaceAll("steps.overlay-restore", "steps['overlay-restore']"),
      {
        cancelled: () => state.cancelled ?? false,
        success: () => state.success ?? true,
        steps: {
          overlay_controller: { outcome: state.controller ?? "success" },
          "overlay-restore": { outputs: { restored: state.restored ? "true" : "false" } },
        },
        inputs: { "isolated-desktop": true },
        needs: { plan: { outputs: { desktop: state.desktop === false ? "false" : "true" } } },
      },
      { timeout: 100 },
    ) as unknown

  expect(controller.run).toBe("bun --no-env-file ./scripts/computer-overlay-smoke.ts")
  expect(controller["continue-on-error"]).toBeUndefined()
  expect(build["continue-on-error"]).toBeUndefined()
  expect(job("mac-build")["continue-on-error"]).toBeUndefined()
  expect(evaluate(build)).toBe(true)
  expect(evaluate(build, { controller: "failure", success: false })).toBe(true)
  for (const outcome of ["", "skipped", "cancelled"])
    expect(evaluate(build, { controller: outcome, success: false })).toBe(false)
  for (const state of [{ cancelled: true }, { desktop: false }, { restored: true }])
    expect(evaluate(build, { ...state, controller: "failure", success: false })).toBe(false)
  expect(protectedSteps).toHaveLength(3)
  for (const step of protectedSteps) {
    expect(step.if).toContain("success()")
    expect(evaluate(step)).toBe(true)
    expect(evaluate(step, { controller: "failure", success: false })).toBe(false)
    expect(step["continue-on-error"]).toBeUndefined()
  }
})

test("Linux properties and dev e2e run real pinned Electron and actual Node without a fake host platform", () => {
  expect(commands("overlay-linux")).toContain("node node_modules/electron/install.js")
  expect(commands("overlay-linux")).toContain("kernel.apparmor_restrict_unprivileged_userns=0")
  expect(commands("overlay-linux")).toContain("xvfb-run")
  expect(commands("overlay-linux")).toContain("computer-overlay-smoke.ts")
  expect(commands("overlay-linux")).not.toMatch(/--native-stage|--platform (?:darwin|win32)|--require-native/)
  expect(commands("desktop-e2e-linux")).toContain("./scripts/prebuild.ts")
  expect(commands("desktop-e2e-linux")).toContain("./scripts/build-desktop.ts")
  expect(commands("desktop-e2e-linux")).toContain("--target node --format esm")
  expect(commands("desktop-e2e-linux")).toContain(
    "node ./node_modules/@playwright/test/cli.js test --config=e2e/playwright.config.ts",
  )
  const build = steps("desktop-e2e-linux").find((step) => step.name === "Build the actual dev desktop and Node engine")!
  expect(record(build.env)).toEqual({ VECTOR_CHANNEL: "dev", VECTOR_COMPUTER_HELPER: "skip" })
  const actual = steps("desktop-e2e-linux").find(
    (step) => step.name === "Run actual Node Playwright against the dev Electron",
  )!
  expect(record(actual.env).VECTOR_COMPUTER_E2E_FAKE_HELPER).toBe("${{ runner.temp }}/computer-fake-helper.mjs")
})
