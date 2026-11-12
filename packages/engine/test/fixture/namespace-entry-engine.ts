import fs from "node:fs/promises"
import { constants, fstatSync } from "node:fs"
import os from "node:os"
import { spawn } from "node:child_process"
import timers from "node:timers"
import { setTimeout } from "node:timers/promises"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"

// Disposable CI experiment only. This does not replace any production launcher or actual-tool assertion.
const metadata = "/usr/libexec/vector-namespace-probe/vector-namespace-entry.json"
const launcher = "/usr/libexec/vector-namespace-probe/vector-namespace-entry.py"
const containers = ["/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox"]
const proofFlags = [
  "entry",
  "fdClosed",
  "highFdControl",
  "stdio",
  "privateProc",
  "signalBlocked",
  "groupsEmpty",
  "capabilitiesDropped",
  "noNewPrivileges",
  "readOnly",
  "worktreeWritable",
  "scratchWritable",
  "ancestorUserDenied",
  "ancestorPidDenied",
  "ancestorMountDenied",
  "brokerProtocolRejected",
] as const

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function payloadIdentity(value: unknown) {
  requireValue(record(value) && value.uid === 1000 && value.gid === 1000, "The nested tool identity changed")
  for (const key of ["uidMap", "gidMap"])
    requireValue(
      Array.isArray(value[key]) && JSON.stringify(value[key]) === "[1000,0,1]",
      "The nested tool mapping is broader than expected",
    )
  for (const key of ["userNamespace", "pidNamespace", "privatePid"])
    requireValue(
      typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] > 0,
      "The nested tool namespace identity is invalid",
    )
  return value
}

function emit(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(value) + "\n")
}

async function readSpec() {
  const file = await fs.open(metadata, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    requireValue(
      info.isFile() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o022) && info.size <= 65_536,
      "The root prototype metadata is unavailable or mutable",
    )
    const value: unknown = JSON.parse(await file.readFile("utf8"))
    requireValue(record(value) && value.v === 1, "Invalid prototype metadata")
    requireValue(
      record(value.broker) &&
        typeof value.broker.pid === "number" &&
        value.broker.pid > 1 &&
        value.broker.uid === 0 &&
        value.broker.gid === 0 &&
        typeof value.broker.start === "string" &&
        value.brokerRootPeerDenied === true,
      "The namespace broker has no root-sealed startup proof",
    )
    requireValue(typeof value.container === "string" && containers.includes(value.container), "Invalid prototype scope")
    requireValue(
      record(value.canary) && value.canary.path === value.container + "/trusted-namespace-canary/module.py",
      "Invalid trusted-code canary",
    )
    requireValue(value.observer === value.container + "/namespace-observer", "Invalid observer directory")
    requireValue(
      typeof value.uid === "number" && value.uid > 0 && typeof value.gid === "number" && value.gid > 0,
      "Invalid disposable identity",
    )
    requireValue(process.getuid?.() === value.uid && process.getgid?.() === value.gid, "The engine identity changed")
    const directory = await fs.lstat(value.observer)
    requireValue(
      directory.isDirectory() && directory.uid === 0 && !(directory.mode & 0o022),
      "The observer directory is not root-owned",
    )
    return { observer: value.observer, checkout: value.container + "/checkout", canary: value.canary.path }
  } finally {
    await file.close()
  }
}

async function ack(directory: string, index: number, phase: "baseline" | "spawned" | "ready" | "stopped" | "summary") {
  const path = `${directory}/${index}-${phase}.ack`
  const deadline = Date.now() + 5000
  while (true) {
    const file = await fs
      .open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      })
    if (file) {
      try {
        const info = await file.stat()
        requireValue(
          info.isFile() && info.uid === 0 && info.nlink === 1 && info.size === 0 && !(info.mode & 0o022),
          "The host acknowledgement is not authentic",
        )
        return
      } finally {
        await file.close()
      }
    }
    requireValue(Date.now() < deadline, "The host did not acknowledge the fixed namespace phase")
    await setTimeout(10)
  }
}

async function bounded<T>(promise: Promise<T>, message: string) {
  let timer: ReturnType<typeof timers.setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = timers.setTimeout(() => reject(new Error(message)), 5000)
      }),
    ])
  } finally {
    timers.clearTimeout(timer)
  }
}

async function assertReadOnlyEngine(scope: { checkout: string; canary: string }) {
  const temporary = ProcessIsolation.ENGINE_HOME + "/tmp/vector-agent"
  requireValue(
    process.cwd() === scope.checkout &&
      process.env.TMPDIR === temporary &&
      process.env.RUNNER_TEMP === temporary &&
      os.tmpdir() === temporary,
    "The engine writable worktree or temporary scope changed",
  )
  for (const directory of [scope.checkout, ...ProcessIsolation.ENGINE_PRIVATE_DIRECTORIES]) {
    const file = `${directory}/namespace-engine-write-${process.pid}`
    await fs.writeFile(file, "verified private engine write\n", { flag: "wx", mode: 0o600 })
    requireValue(
      (await fs.readFile(file, "utf8")) === "verified private engine write\n",
      "A private engine write failed",
    )
    await fs.unlink(file)
  }
  const attempts = [
    () => fs.writeFile(scope.canary, "poisoned Python dependency\n"),
    () =>
      fs.writeFile(
        "/usr/libexec/vector-namespace-probe/future-step-dependency.mjs",
        "export const value = 'poisoned-dependency'\n",
      ),
    () => fs.writeFile("/usr/libexec/vector-namespace-probe/future-step.mjs", "console.log('poisoned-next-step')\n"),
    () => fs.writeFile(`${ProcessIsolation.ENGINE_HOME}/namespace-home-poison-${process.pid}`, "poisoned home\n"),
    () => fs.writeFile(`/tmp/namespace-host-tmp-poison-${process.pid}`, "poisoned host temporary\n"),
    // Never write/truncate the real runtime, even if an old boundary accidentally allows this open.
    async () => {
      const opened = await fs.open(process.execPath, constants.O_WRONLY)
      await opened.close()
    },
  ]
  for (const [index, attempt] of attempts.entries()) {
    try {
      await attempt()
    } catch (error) {
      requireValue(
        error instanceof Error && "code" in error && error.code === "EROFS",
        `Engine read-only control ${index} did not fail through the read-only mount (${error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "invalid"})`,
      )
      continue
    }
    throw new Error(`Engine read-only control ${index} mutated or opened a trusted path`)
  }
}

async function main() {
  requireValue(process.platform === "linux", "The namespace prototype is Linux-only")
  await GithubSecrets.credentials.load()
  requireValue(
    GithubSecrets.credentials.loaded() &&
      GithubSecrets.credentials.pendingRunToken() !== undefined &&
      GithubSecrets.credentials.isolatedTools() &&
      GithubSecrets.credentials.sessionProof() &&
      ProcessIsolation.required(),
    "The actual private Codium channel was not loaded",
  )
  requireValue((await fs.readdir("/proc")).length === 0, "The credential-holding engine proc is not empty")
  const proof = fstatSync(3, { bigint: true })
  requireValue(proof.isFile(), "The actual private proof descriptor is missing")
  const spec = await readSpec()
  await assertReadOnlyEngine(spec)
  requireValue((await fs.readdir(spec.observer)).length === 0, "The observer directory contains stale acknowledgements")
  const environment = untrustedChildEnvironment(process.env)
  const rejected = (() => {
    try {
      ProcessIsolation.assertLoaderEnvironment({ ...environment, LD_PRELOAD: "/fixed-never-executed-probe.so" })
      return false
    } catch {
      return true
    }
  })()
  requireValue(rejected, "The mandatory native loader guard accepted the hostile control")
  ProcessIsolation.assertLoaderEnvironment(environment)
  emit({
    event: "namespace-engine-ready",
    v: 1,
    pid: process.pid,
    privateHolder: true,
    emptyProc: true,
    loaderRejected: true,
    engineReadOnlyObserved: true,
    proof: { device: String(proof.dev), inode: String(proof.ino) },
  })
  await ack(spec.observer, 0, "baseline")

  const rounds: Array<Record<string, unknown>> = []
  for (let index = 0; index < 9; index++) {
    const mode = index === 0 ? "normal" : index <= 4 ? "delay" : "wait"
    ProcessIsolation.assertLoaderEnvironment(environment)
    // FD3 is deliberately inherited only by this immutable trusted entry shim. It closes all extra FDs before setns.
    const child = spawn("/usr/bin/python3", ["-I", "-S", launcher, "launch", String(process.pid), mode], {
      env: environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", 3],
    })
    requireValue(child.stdin && child.stdout && child.stderr, "The fixed launcher stdio pipes are unavailable")
    const ready = Promise.withResolvers<void>()
    let readySeen = false
    let result: Record<string, unknown> | undefined
    let observedIdentity: Record<string, unknown> | undefined
    let output = ""
    let stderrBytes = 0
    let stderr = ""
    let protocolError: Error | undefined
    let closed = false
    child.stdin.on("error", () => {})
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderr.length < 1600) stderr += chunk.toString("utf8").slice(0, 1600 - stderr.length)
      if (stderrBytes > 16_384) protocolError ??= new Error("The fixed launcher emitted excessive diagnostics")
    })
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.length > 16_384) {
        protocolError ??= new Error("The fixed launcher exceeded its protocol bound")
        return
      }
      while (output.includes("\n")) {
        const end = output.indexOf("\n")
        const line = output.slice(0, end)
        output = output.slice(end + 1)
        try {
          const value: unknown = JSON.parse(line)
          requireValue(record(value) && value.v === 1, "Invalid fixed launcher protocol")
          if (value.event === "namespace-ready") {
            requireValue(!readySeen, "The fixed launcher repeated readiness")
            observedIdentity = payloadIdentity(value.identity)
            readySeen = true
            ready.resolve()
            continue
          }
          requireValue(
            value.event === "namespace-result" && mode === "normal" && readySeen && !result,
            "Unexpected fixed launcher result",
          )
          requireValue(
            proofFlags.every((flag) => value[flag] === true),
            "A namespace-entry assertion did not pass",
          )
          requireValue(
            JSON.stringify(payloadIdentity(value.identity)) === JSON.stringify(observedIdentity),
            "The payload identity changed between readiness and completion",
          )
          result = value
        } catch (error) {
          protocolError ??= new Error(
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "The fixed launcher protocol was refused",
          )
        }
      }
    })
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => {
        closed = true
        resolve({ code, signal })
      })
    })
    // Attach rejection handling immediately even while waiting for the host's independent observation.
    void ended.catch(() => {})
    let escalated = false
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve)
          child.once("error", reject)
        }),
        "The fixed namespace launcher did not spawn",
      )
      requireValue(child.pid !== undefined && child.pid > 1, "The fixed namespace launcher has no PID")
      emit({ event: "namespace-launch", v: 1, index, mode, pid: child.pid, phase: "spawned" })
      await ack(spec.observer, index, "spawned")
      requireValue(!closed, "The namespace launcher ended before the intended test phase")
      if (mode !== "delay") child.stdin.end("namespace-entry-stdio\n")
      if (mode === "wait") {
        await bounded(
          Promise.race([
            ready.promise,
            ended.then(() => {
              throw new Error("The payload ended before readiness")
            }),
          ]),
          "The namespace payload did not acknowledge readiness",
        )
        emit({
          event: "namespace-launch",
          v: 1,
          index,
          mode,
          pid: child.pid,
          phase: "ready",
          identity: observedIdentity,
        })
        await ack(spec.observer, index, "ready")
        requireValue(!closed, "The namespace payload ended before cancellation")
      }
      if (mode !== "normal") {
        process.kill(-child.pid, "SIGTERM")
        if (await Promise.race([ended.then(() => false), setTimeout(1000, true, { ref: false })])) {
          escalated = true
          process.kill(-child.pid, "SIGKILL")
        }
      }
      const exit = await bounded(ended, "The namespace launcher did not stop within its deadline")
      if (protocolError) throw protocolError
      requireValue(output === "", "The namespace launcher did not complete its bounded protocol")
      if (mode === "normal") {
        requireValue(
          exit.code === 0 && exit.signal === null && readySeen && result,
          `The positive namespace-entry control failed: ${GithubSecrets.credentials.redact(stderr)}`,
        )
      } else {
        requireValue(
          exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code === 143 || exit.code === 137,
          "The cancellation case did not end through an observed termination signal",
        )
      }
      rounds.push({ index, mode, pid: child.pid, ...exit, escalated, readySeen })
      emit({
        event: "namespace-complete",
        v: 1,
        index,
        mode,
        pid: child.pid,
        outcome: mode === "normal" ? "normal" : "cancelled",
        ...exit,
        escalated,
        readySeen,
      })
      await ack(spec.observer, index, "stopped")
    } finally {
      if (!closed && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH")
            process.stderr.write("The fixed launcher could not signal its owned group during failed-probe cleanup.\n")
        }
      }
    }
  }
  requireValue(
    rounds.length === 9 && (await fs.readdir("/proc")).length === 0,
    "The namespace experiment did not complete",
  )
  emit({
    event: "namespace-engine-summary",
    v: 1,
    prototypeOnly: true,
    engineReadOnlyQualified: false,
    privateHolder: true,
    emptyProc: true,
    loaderRejected: true,
    engineReadOnlyObserved: true,
    rounds: rounds.length,
    positive: true,
    earlyCancellations: 4,
    readyCancellations: 4,
  })
  // The host's final no-survivor check still requires the engine baseline to be alive.
  await ack(spec.observer, 9, "summary")
}

if (process.argv.slice(2).join(" ") === "--module-load-check") {
  console.log("Namespace engine fixture modules loaded")
} else {
  requireValue(process.argv.length === 2, "Unexpected namespace engine invocation")
  await main()
}
