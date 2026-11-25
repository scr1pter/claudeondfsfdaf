import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const holderSource = new URL("../src/tool/shell/windows-holder.ts", import.meta.url)
const processSource = new URL("../src/tool/shell/windows-process.ts", import.meta.url)
// Pin the actual maintained source, independent of the revision that adds this diagnostic.
const sourceSHA = "daf3b29805a8b100ff0843f2c6df4d8e01d8e1464352aeff2602bbba6709ad8e"
const processSHA = "30c42a270453d34d1ec5230a5b2b65c428206cef13f0fa20233943c38353d706"
const executableLimit = 1_048_576
export const startupMs = 15_000
const stopMs = 2_000
const closeMs = 3_000
const stopLine = '{"type":"stop"}\n'
const entryPoint = '\ninternal static class VectorStandaloneEntryPoint { public static int Main() { return VectorShellHolder.Run(); } }\n'
const armEntryPoint = String.raw`
internal static class VectorStandaloneEntryPoint {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native);
  public static int Main() {
    ushort machine,native;
    if(!IsWow64Process2(new IntPtr(-1),out machine,out native) || machine!=0 || native!=0xaa64) return 63;
    return VectorShellHolder.Run();
  }
}
`

const architectures = {
  x64: { runner: "X64", platform: "x64", machine: 0x8664, magic: 0x20b, directories: 112, entryPoint },
  arm64: { runner: "ARM64", platform: "anycpu", machine: 0x14c, magic: 0x10b, directories: 96, entryPoint: armEntryPoint },
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function pinnedSource(bytes, expected) {
  const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n")
  if (sha(original) !== expected) throw new Error("Unexpected holder source")
  return original
}

export function compiledSource(bytes, arch = "x64") {
  const original = pinnedSource(bytes, sourceSHA)
  const source = /^const source = String\.raw`([\s\S]*?)^`$/m.exec(original)
  if (!source || !source[1]) throw new Error("Holder source unavailable")
  return source[1] + architectures[arch].entryPoint
}

function windowsRunner(mode) {
  const env = process.env
  const job = { build: "direct-holder-build", measure: "direct-holder-measure" }[mode]
  const arch = env.VECTOR_DIRECT_HOLDER_ARCH
  const host = mode === "build" ? "x64" : arch
  if (
    !job ||
    (arch !== "x64" && arch !== "arm64") ||
    process.platform !== "win32" ||
    process.arch !== host ||
    env.RUNNER_ARCH !== architectures[host].runner ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.VECTOR_DIRECT_HOLDER_FIXTURE !== "1" ||
    env.GITHUB_JOB !== job
  ) {
    throw new Error("An explicitly authorized hosted Windows diagnostic job is required")
  }
  if (!/^\d{1,30}$/.test(env.GITHUB_RUN_ID ?? "") || !/^\d{1,9}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new Error("Invalid hosted run identity")
  }
  for (const directory of [env.SystemRoot, env.RUNNER_TEMP]) {
    if (!directory || !/^[a-z]:\\/i.test(directory) || path.win32.normalize(directory) !== directory) {
      throw new Error("Invalid Windows directory")
    }
  }
  return {
    arch,
    env,
    systemRoot: env.SystemRoot,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    revision: env.GITHUB_SHA,
    artifact: path.join(env.RUNNER_TEMP, "vector-direct-holder"),
  }
}

export function launchInputs(systemRoot, fixture, env) {
  const cwd = path.win32.join(systemRoot, "System32")
  const file = path.win32.join(cwd, "where.exe")
  const minimal = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) => {
      const value = Object.entries(env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
      return value ? [[key, value]] : []
    }),
  )
  return {
    options: { cwd, env: minimal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    config: JSON.stringify({ file, commandLine: `"${file}" /?`, cwd: fixture, env: minimal }) + "\n",
  }
}

async function regularBytes(filename, maximum) {
  const info = await lstat(filename)
  if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error("Invalid holder build input")
  const bytes = await readFile(filename)
  if (bytes.byteLength !== info.size) throw new Error("Unstable holder build input")
  return bytes
}

export function validateExecutable(bytes, arch = "x64") {
  const expected = architectures[arch]
  const invalid = () => new Error("Expected the selected managed Windows console executable")
  if (bytes.byteLength < 272 || bytes.byteLength > executableLimit || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw invalid()
  }
  const pe = bytes.readUInt32LE(0x3c)
  const optional = pe + 24
  const clr = optional + expected.directories + 14 * 8
  if (pe < 64 || clr + 8 > bytes.byteLength || bytes.readUInt32LE(pe) !== 0x4550) throw invalid()
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const flags = bytes.readUInt16LE(pe + 22)
  if (
    bytes.readUInt16LE(pe + 4) !== expected.machine ||
    optionalSize < expected.directories + 15 * 8 ||
    optional + optionalSize > bytes.byteLength ||
    !(flags & 2) ||
    flags & 0x2000 ||
    bytes.readUInt16LE(optional) !== expected.magic ||
    bytes.readUInt16LE(optional + 68) !== 3 ||
    bytes.readUInt32LE(optional + expected.directories - 4) < 15 ||
    !bytes.readUInt32LE(clr) ||
    bytes.readUInt32LE(clr + 4) < 72
  ) {
    throw invalid()
  }
  if (arch === "arm64") verifyArchitectureNeutralIL(bytes, pe, optional + optionalSize, bytes.readUInt32LE(clr))
}

function verifyArchitectureNeutralIL(bytes, pe, section, clrRva) {
  const count = bytes.readUInt16LE(pe + 6)
  if (count < 1 || count > 96 || section + count * 40 > bytes.byteLength) throw new Error("Invalid PE section table")
  for (let i = 0; i < count; i++, section += 40) {
    const sectionRva = bytes.readUInt32LE(section + 12)
    const rawSize = bytes.readUInt32LE(section + 16)
    const rawOffset = bytes.readUInt32LE(section + 20)
    const delta = clrRva - sectionRva
    if (delta < 0 || delta + 72 > rawSize || rawOffset + delta + 72 > bytes.byteLength) continue
    const flags = bytes.readUInt32LE(rawOffset + delta + 16)
    if ((flags & 1) && !(flags & 0x20002)) return
    break
  }
  throw new Error("Expected architecture-neutral IL without x86 preference")
}

export function artifactReceipt(runner, binary) {
  return Buffer.from(JSON.stringify({
    version: 1,
    arch: runner.arch ?? "x64",
    run: runner.run,
    attempt: runner.attempt,
    revision: runner.revision,
    sourceSHA,
    processSHA,
    executableSHA: sha(binary),
  }))
}

export function artifactDigest(receipt, binary) {
  return createHash("sha256").update(receipt).update(Buffer.of(0)).update(binary).digest("hex")
}

export function validateArtifact(runner, receipt, binary, expectedDigest) {
  if (
    !/^[0-9a-f]{64}$/.test(expectedDigest ?? "") ||
    artifactDigest(receipt, binary) !== expectedDigest ||
    !receipt.equals(artifactReceipt(runner, binary))
  ) {
    throw new Error("The direct-holder artifact does not match its build job")
  }
  validateExecutable(binary, runner.arch)
}

async function build(runner) {
  const source = compiledSource(await regularBytes(holderSource, 65_536), runner.arch)
  pinnedSource(await regularBytes(processSource, 65_536), processSHA)
  const framework = path.win32.join(runner.systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319")
  const compiler = path.win32.join(framework, "csc.exe")
  const references = ["System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(
    (file) => "/reference:" + path.win32.join(framework, file),
  )
  const staging = await mkdtemp(path.join(os.tmpdir(), "vector-direct-holder-build-"))
  try {
    const input = path.join(staging, "VectorShellHolder.cs")
    const output = path.join(staging, "holder.exe")
    await writeFile(input, source, { flag: "wx" })
    const result = spawnSync(
      compiler,
      [
        "/nologo",
        "/noconfig",
        "/target:exe",
        "/platform:" + architectures[runner.arch].platform,
        "/main:VectorStandaloneEntryPoint",
        ...references,
        "/out:" + output,
        input,
      ],
      { ...launchInputs(runner.systemRoot, staging, runner.env).options, stdio: "ignore", timeout: 30_000 },
    )
    if (result.error || result.status !== 0) throw new Error("The stock Windows compiler could not build the fixture")
    const bytes = await regularBytes(output, executableLimit)
    validateExecutable(bytes, runner.arch)
    const receipt = artifactReceipt(runner, bytes)
    await mkdir(runner.artifact)
    await writeFile(path.join(runner.artifact, "holder.exe"), bytes, { flag: "wx" })
    await writeFile(path.join(runner.artifact, "receipt.json"), receipt, { flag: "wx" })
    await appendFile(runner.env.GITHUB_OUTPUT, "payload_digest=" + artifactDigest(receipt, bytes) + "\n")
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
  }
}

export function directReader(StatusReader) {
  const reader = new StatusReader()
  // These are local parser setup only. The direct executable emits the unchanged native steps 4 through 12.
  const prefix = [1, 2, 3].map((step) => 'VECTOR_SHELL/1 {"type":"startup","step":' + step + "}\n").join("")
  if (reader.push(Buffer.from(prefix)).length || reader.startupPhase !== "compiler-returned") {
    throw new Error("Unexpected Windows holder status protocol")
  }
  return reader
}

const realClock = { now: () => performance.now(), schedule: setTimeout, cancel: clearTimeout }

export function observe(launch, config, reader, deliveryTimeline, clock = realClock, launchAt = clock.now()) {
  const elapsed = () => clock.now() - launchAt
  const timings = deliveryTimeline(elapsed)
  return new Promise((resolve) => {
    if (elapsed() >= startupMs) {
      timings.mark("watchdogMs")
      resolve({ outcome: "startup-deadline", timings: timings.snapshot() })
      return
    }
    let child
    try {
      child = launch()
    } catch {
      resolve({ outcome: "spawn-error", timings: timings.snapshot() })
      return
    }
    timings.mark("launchReturnedMs")
    let ready = false
    let proven = false
    let stopping = false
    let finished = false
    let failure
    let killTimer
    let closeTimer

    const finish = (outcome) => {
      if (finished) return
      finished = true
      clock.cancel(watchdog)
      clock.cancel(killTimer)
      clock.cancel(closeTimer)
      resolve({ outcome, timings: timings.snapshot() })
    }
    const stop = (reason) => {
      if (finished) return
      failure ??= reason
      if (stopping) return
      stopping = true
      clock.cancel(watchdog)
      if (child.stdin.writable) child.stdin.end(stopLine)
      killTimer = clock.schedule(() => child.kill(), stopMs)
      closeTimer = clock.schedule(() => {
        timings.mark("closeDeadlineMs")
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(failure ?? "cleanup-deadline")
      }, stopMs + closeMs)
    }
    const timeout = () => {
      timings.mark("watchdogMs")
      stop("startup-deadline")
    }
    const watchdog = clock.schedule(timeout, Math.max(0, startupMs - elapsed()))

    child.once("spawn", () => timings.mark("spawnEventMs"))
    child.once("exit", () => timings.mark("exitMs"))
    child.once("error", () => stop("spawn-error"))
    child.stdin.on("error", () => stop("config-transport-error"))
    child.stdout.on("error", () => stop("output-transport-error"))
    child.stdout.on("data", (chunk) => {
      if (chunk.length) stop("unexpected-payload-output")
    })
    child.stderr.on("error", () => stop("status-transport-error"))
    child.stderr.on("data", (chunk) => {
      if (finished) return
      if (chunk.length) timings.mark("firstStderrMs")
      try {
        const phase = reader.startupPhase
        const messages = reader.push(chunk)
        if (phase === "compiler-returned" && reader.startupPhase !== phase) timings.mark("firstMarkerMs")
        for (const message of messages) {
          if (message.type === "ready") {
            if (ready || proven || reader.startupPhase !== "payload-created") throw new Error("Unexpected ready frame")
            if (elapsed() >= startupMs) {
              timeout()
              continue
            }
            if (stopping) continue
            ready = true
            timings.mark("readyMs")
            stop()
            continue
          }
          if (
            message.type === "error" &&
            ready && stopping && !proven &&
            message.message === "PID acknowledgement refused or timed out" &&
            message.terminationProven === true
          ) {
            proven = true
            continue
          }
          if (message.type === "error" && !ready && !stopping) {
            stop("holder-startup-error")
            continue
          }
          throw new Error("Unexpected holder status")
        }
      } catch {
        stop("invalid-status")
      }
    })
    child.once("close", (code, signal) => {
      if (finished) return
      timings.mark("closeMs")
      try {
        reader.finish()
      } catch {
        failure ??= "invalid-status"
      }
      const outcome = ready && proven && code === 1 && signal === null ? "proven" : "cleanup-unproven"
      finish(failure ?? (code === 63 && signal === null ? "native-architecture-mismatch" : outcome))
    })
    child.stdin.write(config, (error) => {
      timings.mark(error ? "configWriteFailedMs" : "configWrittenMs")
      if (error) stop("config-transport-error")
    })
  })
}

async function measure(runner) {
  compiledSource(await regularBytes(holderSource, 65_536), runner.arch)
  pinnedSource(await regularBytes(processSource, 65_536), processSHA)
  const { StatusReader } = await import(processSource.href)
  const { deliveryTimeline } = await import(holderSource.href)
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vector-direct-holder-cold-"))
  try {
    const { config, options } = launchInputs(runner.systemRoot, fixture, runner.env)
    const reader = directReader(StatusReader)
    const launchAt = realClock.now()
    const executable = await verifiedArtifact(runner)
    const result = await observe(() => spawn(executable, [], options), config, reader, deliveryTimeline, realClock, launchAt)
    console.log(JSON.stringify(result))
    if (result.outcome !== "proven") process.exitCode = 1
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
  }
}

async function verifiedArtifact(runner) {
  const directory = runner.artifact
  if (
    !(await lstat(directory)).isDirectory() ||
    (await realpath(directory)).toLowerCase() !== directory.toLowerCase() ||
    (await readdir(directory)).sort().join("|") !== "holder.exe|receipt.json"
  ) {
    throw new Error("Holder fixture artifact directory is not canonical")
  }
  const receipt = await regularBytes(path.join(directory, "receipt.json"), 1024)
  const executable = path.join(directory, "holder.exe")
  const bytes = await regularBytes(executable, executableLimit)
  validateArtifact(runner, receipt, bytes, runner.env.VECTOR_DIRECT_HOLDER_PAYLOAD_DIGEST)
  return executable
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2]
    const runner = windowsRunner(mode)
    if (mode === "build") await build(runner)
    else if (mode === "measure") await measure(runner)
    else throw new Error("Invalid diagnostic mode")
  } catch {
    console.log(JSON.stringify({ outcome: "diagnostic-setup-failed" }))
    process.exitCode = 1
  }
}
