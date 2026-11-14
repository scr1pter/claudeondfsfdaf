import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a workflow mapping.")
  return value as Record<string, unknown>
}
const source = readFileSync(new URL("../../../.github/workflows/vector-desktop-release.yml", import.meta.url), "utf8")
const nativeSource = readFileSync(new URL("../../../.github/workflows/computer-helper.yml", import.meta.url), "utf8")
const release = record(Bun.YAML.parse(source))
const jobs = record(release.jobs)
const nativeJobs = record(record(Bun.YAML.parse(nativeSource)).jobs)
const job = (name: string) => record(jobs[name])
const steps = (value: Record<string, unknown>) => {
  if (!Array.isArray(value.steps)) throw new Error("Expected workflow steps.")
  return value.steps.map(record)
}
const commands = (value: Record<string, unknown>) =>
  steps(value)
    .flatMap((step) => (typeof step.run === "string" ? [step.run] : []))
    .join("\n")
const expression = (value: string, dryRun: boolean, secrets: object = {}, prerelease = false) =>
  runInNewContext(
    value.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1"),
    { inputs: { dry_run: dryRun, prerelease }, secrets },
    { timeout: 100 },
  ) as unknown

test("release builds depend on tested immutable helper artifacts without attempt-specific names", () => {
  const helper = job("computer-helper")
  expect(helper.needs).toBe("prepare")
  expect(helper.uses).toBe("./.github/workflows/computer-helper.yml")
  expect(helper.permissions).toEqual({ contents: "read", actions: "read" })
  expect(helper.secrets).toBeUndefined()
  expect(helper.with).toEqual({
    "artifact-suffix": "${{ inputs.tag || github.ref_name }}",
    "helper-channel": "${{ inputs.prerelease && 'beta' || 'prod' }}",
    "reuse-artifacts": true,
    "full-desktop-e2e": false,
    "privileged-required": false,
    "isolated-desktop": false,
  })
  for (const name of ["mac", "windows"]) expect(job(name).needs).toContain("computer-helper")
  for (const value of Object.values(jobs)) {
    const current = record(value)
    if (!Array.isArray(current.steps)) continue
    for (const step of steps(current)) {
      if (typeof step.uses === "string" && step.uses.startsWith("actions/cache"))
        expect(JSON.stringify(step.with)).not.toMatch(/native\/out|resources\/computer/)
      const settings = step.with === undefined ? undefined : record(step.with)
      if (typeof settings?.name === "string" && settings.name.startsWith("computer-helper-"))
        expect(settings.name).not.toContain("run_attempt")
    }
  }
})

test("native reuse restores first, retains fresh required checks and prevents immutable helper overwrites", () => {
  for (const name of ["mac-build", "windows-build"]) {
    const native = record(nativeJobs[name])
    expect(native.permissions).toEqual({ contents: "read", actions: "read" })
    const restore = steps(native).find((step) => step.id === "restore")!
    expect(restore.if).toContain("inputs['reuse-artifacts']")
    expect(restore.run).toContain("computer-helper-artifact.ts")
    const checks = steps(native).filter((step) => typeof step.run === "string" && /--privileged\s+off/.test(step.run))
    expect(checks).toHaveLength(1)
    expect(checks[0]!["continue-on-error"]).toBeUndefined()
    expect(String(checks[0]!.if)).not.toContain("restore")
    expect(commands(native)).toContain("--format=ustar --no-xattrs --no-acls --no-fflags")
    for (const step of steps(native)) {
      const settings = step.with === undefined ? undefined : record(step.with)
      if (typeof settings?.path !== "string" || !settings.path.endsWith(".tar")) continue
      if (typeof settings.name !== "string" || !settings.name.startsWith("computer-helper-")) continue
      expect(step.if).toContain("steps.restore.outputs.restored")
      expect(settings.overwrite).toBe("${{ !inputs['reuse-artifacts'] }}")
    }
  }
  for (const [name, value] of Object.entries(nativeJobs))
    if (record(value).permissions !== undefined)
      expect(record(value).permissions).toEqual(
        name === "mac-build" || name === "windows-build" ? { contents: "read", actions: "read" } : { contents: "read" },
      )
})

test("Windows signing and immutable restoration finish before Main pins compile", () => {
  const windows = steps(job("windows"))
  const signing = windows.findIndex((step) => String(step.name).startsWith("Sign or verify both final helper copies"))
  const build = windows.findIndex((step) => step.name === "Build desktop app")
  expect(signing).toBeGreaterThan(0)
  expect(signing).toBeLessThan(build)
  expect(windows[signing]!.run).toContain("computer-helper-sign-windows.ts")
  expect(windows[signing]!.run).toContain("VECTOR_COMPUTER_HELPER_SHA256=")
  expect(windows.findIndex((step) => step.id === "helper-final")).toBeLessThan(signing)
  const immutable = windows.find((step) => step.name === "Preserve immutable final Windows helper bytes")!
  expect(record(immutable.with).overwrite).toBe(false)
  expect(immutable.if).toContain("steps.helper-final.outputs.restored")
  const packageStep = windows.find((step) => step.name === "Package signed installer")!
  expect(record(packageStep.env).VECTOR_COMPUTER_HELPER_PREBUILT).toBe("true")
  expect(readFileSync(new URL("../electron-builder.config.ts", import.meta.url), "utf8")).toContain(
    'signExts: ["!vector-computer.exe"]',
  )
  expect(commands(job("windows"))).toContain(
    "SignerCertificate.Subject -cne $env:VECTOR_COMPUTER_HELPER_PUBLISHER_SUBJECT",
  )
})

test("final verification runs for every platform and ARM64 executes its exact package on ARM64", () => {
  const mac = steps(job("mac"))
  for (const step of mac.filter((step) => String(step.name).startsWith("Package signed and notarized")))
    expect(record(step.env).VECTOR_COMPUTER_HELPER_PREBUILT).toBe("true")
  expect(commands(job("mac"))).toContain("--check-lock")
  expect(commands(job("mac"))).toContain(
    'verify-computer-helper.ts --app "$app" --channel "$VECTOR_CHANNEL" --expect-signing "$signing"',
  )
  expect(commands(job("mac"))).toContain(
    'spctl --assess --type execute --verbose=4 "$app/Contents/Helpers/VectorComputer.app"',
  )
  const arm = job("windows-arm64-helper")
  expect(arm["runs-on"]).toBe("windows-11-arm")
  expect(arm.needs).toEqual(["prepare", "windows"])
  expect(commands(arm)).toContain("--expected-id $env:PROOF_ID --expected-digest $env:PROOF_DIGEST")
  expect(commands(arm)).toContain('"--arch", "arm64"')
  expect(commands(arm)).toContain("verify-computer-helper.ts")
  expect(steps(arm).every((step) => step["continue-on-error"] === undefined)).toBe(true)
  expect(job("release").needs).toContain("windows-arm64-helper")
  expect(commands(job("windows"))).toContain("resources/app.asar resources/computer")
  expect(commands(job("linux"))).toContain("test ! -e packages/desktop/dist/linux-unpacked/resources/computer")
  expect(commands(job("linux"))).toContain("test ! -e packages/desktop/dist/linux-arm64-unpacked/resources/computer")
})

test("the actual preview guard permits only explicit unsigned same-repository dispatches on hands", () => {
  const validation = steps(job("prepare")).find((step) => step.name === "Validate tag, version, and release notes")!
  const guard = String(validation.run).match(
    /# HANDS_DRY_RUN_GUARD_BEGIN\n([\s\S]*?)\n\s*# HANDS_DRY_RUN_GUARD_END/,
  )?.[1]
  expect(guard).toBeDefined()
  const environment = {
    DRY_RUN: "true",
    REQUESTED_UNSIGNED: "true",
    PRERELEASE: "false",
    GITHUB_REPOSITORY: "fixture/repo",
    EVENT_REPOSITORY: "fixture/repo",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/hands",
  }
  const status = (changed: Record<string, string>) =>
    spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${guard}`], {
      env: { ...process.env, ...environment, ...changed },
      encoding: "utf8",
      timeout: 5000,
    }).status
  expect(status({})).toBe(0)
  for (const changed of [
    { REQUESTED_UNSIGNED: "false" },
    { PRERELEASE: "true" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/heads/ci/computer-example" },
    { EVENT_REPOSITORY: "fork/repo" },
    { GITHUB_REPOSITORY: "" },
  ])
    expect(status(changed)).not.toBe(0)
  expect(status({ DRY_RUN: "false", GITHUB_REF: "refs/tags/v1.99.112", GITHUB_EVENT_NAME: "push" })).toBe(0)
})

test("preview jobs cannot consume production secrets or reach the protected publishing job", () => {
  const publish = job("release")
  expect(publish.environment).toBe("production-release")
  expect(expression(String(publish.if), true)).toBe(false)
  expect(expression(String(publish.if), false)).toBe(true)
  const unreadable = new Proxy(
    {},
    {
      get() {
        throw new Error("A preview attempted to read a production secret")
      },
    },
  )
  const configured = new Proxy(
    {},
    {
      get() {
        return "configured-fixture-secret"
      },
    },
  )
  for (const value of source.match(/\$\{\{[^}]*\bsecrets\.[^}]*\}\}/g) ?? []) {
    expect(expression(value, true, unreadable)).toBe("")
    expect(expression(value, false, configured)).toBe("configured-fixture-secret")
  }
  const protectedEnvironment = steps(job("prepare")).find(
    (step) => step.name === "Require protected release environment",
  )!
  expect(expression(String(protectedEnvironment.if), true)).toBe(false)
  expect(commands(job("credentials"))).toContain('if [ "$RELEASE_DRY_RUN" = "true" ]; then exit 0; fi')
  expect(commands(job("prepare"))).toContain('if [ "$DRY_RUN" != "true" ]; then')
  expect(commands(job("prepare"))).toContain('git merge-base --is-ancestor "$source_commit" origin/main')
  expect(commands(job("prepare"))).toContain('[ "$allowlisted" = "true" ]')
})

test("release checks bind helper changes to notes while the public asset allowlist remains unchanged", () => {
  const prepare = commands(job("prepare"))
  expect(prepare).toContain("native/computer-helper/macos/identity.lock.json")
  expect(prepare).toContain("release-caveat.ts --tag")
  const allowlist = steps(job("release")).find((step) => step.name === "Validate assets and create checksums")!
  expect(allowlist.run).not.toContain("computer-helper")
  expect(source).toContain("VECTOR_COMPUTER_HELPER_PUBLISHER_SUBJECT")
  for (const [name, value] of Object.entries(jobs)) {
    const current = record(value)
    if (!Array.isArray(current.steps) || name === "release") continue
    expect(commands(current)).not.toMatch(
      /\bgit\s+push\b|\bgh\s+release\s+(?:create|upload|edit)\b|\b(?:sst|vercel)\s+deploy\b/,
    )
  }
})

test("the release and reusable native lane keep channel identities, source checks and artifacts aligned", () => {
  const environment = record(release.env)
  const helper = record(job("computer-helper").with)
  for (const prerelease of [false, true]) {
    const channel = prerelease ? "beta" : "prod"
    expect(expression(String(environment.VECTOR_CHANNEL), false, {}, prerelease)).toBe(channel)
    expect(expression(String(helper["helper-channel"]), false, {}, prerelease)).toBe(channel)
    expect(expression(String(environment.VECTOR_PRODUCT_NAME), false, {}, prerelease)).toBe(
      prerelease ? "Vector Beta" : "Vector",
    )
  }
  expect(environment.HELPER_ARTIFACT_SUFFIX).toBe(
    "${{ inputs.tag || github.ref_name }}${{ inputs.prerelease && '-beta' || '' }}",
  )
  for (const name of ["mac", "windows", "linux"]) {
    const current = steps(job(name))
    for (const step of current)
      if (step.env && record(step.env).VECTOR_CHANNEL !== undefined)
        expect(record(step.env).VECTOR_CHANNEL).toBe("${{ env.VECTOR_CHANNEL }}")
    expect(commands(job(name))).not.toMatch(/--channel\s+prod|"--channel",\s+"prod"|VECTOR_CHANNEL="prod"/)
  }
  for (const name of ["mac", "windows", "windows-arm64-helper"])
    expect(commands(job(name))).toContain("HELPER_ARTIFACT_SUFFIX")
  expect(commands(job("mac"))).toContain('-name "$VECTOR_PRODUCT_NAME.app"')
  expect(commands(job("mac"))).toContain('if [ "$VECTOR_CHANNEL" = prod ]; then helper_args+=(--check-lock); fi')
  expect(commands(job("mac"))).toContain(
    "lock.helperVersion !== manifest.helperVersion || lock.toolchain !== manifest.toolchain",
  )
  const verifyPackage = steps(job("mac")).find(
    (step) => step.name === "Verify packaged apps can reach the update feed and pass the byte audit",
  )!
  expect(record(verifyPackage.env).VECTOR_SIGN_MAC).toBe(
    "${{ needs.prepare.outputs.unsigned != 'true' && 'true' || 'false' }}",
  )
  const nativeDocument = record(Bun.YAML.parse(nativeSource))
  const events = record(nativeDocument.on)
  expect(record(record(record(events.workflow_call).inputs)["helper-channel"])).toMatchObject({
    type: "string",
    default: "prod",
  })
  expect(record(record(record(events.workflow_dispatch).inputs)["helper-channel"])).toMatchObject({
    type: "choice",
    default: "prod",
    options: ["prod", "beta", "dev"],
  })
  const nativePlan = commands(record(nativeJobs.plan))
  const guard = nativePlan.match(/# HELPER_CHANNEL_GUARD_BEGIN\n([\s\S]*?)\n\s*# HELPER_CHANNEL_GUARD_END/)?.[1]
  expect(guard).toBeDefined()
  const channelGuard = (channel: string) =>
    spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${guard}\nprintf '%s' "$ARTIFACT_SUFFIX"`], {
      env: { ...process.env, VECTOR_CHANNEL: channel, ARTIFACT_SUFFIX: "fixture" },
      encoding: "utf8",
      timeout: 5000,
    })
  for (const channel of ["prod", "beta", "dev"]) {
    const result = channelGuard(channel)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(channel === "prod" ? "fixture" : `fixture-${channel}`)
  }
  for (const invalid of ["", "stable", "PROD", "prod;exit 0", "beta/../prod"])
    expect(channelGuard(invalid).status).not.toBe(0)
  const nativeMac = record(nativeJobs["mac-build"])
  const lock = steps(nativeMac).find((step) => step.id === "lock")!
  const candidate = steps(nativeMac).find((step) => step.name === "Preserve measured lock candidate")!
  for (const step of [lock, candidate]) {
    expect(String(step.if)).toContain("(inputs['helper-channel'] || 'prod') == 'prod'")
    expect(step["continue-on-error"]).toBeUndefined()
  }
  expect(commands(nativeMac)).toContain(
    "lock.helperVersion !== manifest.helperVersion || lock.toolchain !== manifest.toolchain",
  )
  for (const name of ["mac-build", "mac-test"])
    expect(commands(record(nativeJobs[name]))).toContain('--channel "$VECTOR_CHANNEL"')
  for (const name of ["windows-build", "windows-arm64-test"])
    expect(commands(record(nativeJobs[name]))).toContain("--channel $env:VECTOR_CHANNEL")
})

test("the preview caveat adapter receives explicit guarded context without changing production notes", () => {
  const caveat = steps(job("prepare")).find(
    (step) => step.name === "Require the access re-ask caveat after a measured helper change",
  )!
  expect(caveat.env).toEqual({
    TAG: "${{ env.RELEASE_TAG }}",
    REQUESTED_UNSIGNED: "${{ inputs.allow_unsigned || false }}",
    EVENT_REPOSITORY: "${{ github.event.repository.full_name }}",
  })
  expect(caveat.run).toContain('--hands-preview "$RELEASE_DRY_RUN"')
  expect(record(release.env).RELEASE_DRY_RUN).toBe("${{ inputs.dry_run || false }}")
  expect(record(release.env).RELEASE_PRERELEASE).toBe("${{ inputs.prerelease || false }}")
  expect(record(release.env).VECTOR_CHANNEL).toBe("${{ inputs.prerelease && 'beta' || 'prod' }}")
  expect(caveat["continue-on-error"]).toBeUndefined()
})
