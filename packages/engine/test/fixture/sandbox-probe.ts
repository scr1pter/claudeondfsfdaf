import fs from "node:fs/promises"
import { constants, fstatSync } from "node:fs"
import path from "node:path"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { GithubSessionProof } from "../../src/cli/cmd/github.session-proof"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { probeToolProcesses, withToolProbeProfile } from "./sandbox-tool-probe"

const execute = promisify(execFile)
const self = fileURLToPath(import.meta.url)
const markers = [
  "probe-oidc-private-73af",
  "probe-github-private-92bc",
  "vct_probe.signature",
  "vrt_probe.signature",
  "probe-provider-private-44de",
  // A ticket-shaped value an earlier, unsandboxed step wrote through $GITHUB_OUTPUT, as the Codium agent job's Ship Desk
  // ticket step writes its capture ticket before the sandbox (V31). The runner's file-command files must not show it.
  "vcap_probe-capture-ticket-private-5e1c-000000000",
]
const trigger = "/tmp/vector-sandbox-probe-next-step"
const escaped = "/tmp/vector-sandbox-probe-detached-escaped"

function syntheticProofIdentity() {
  const proof = fstatSync(3, { bigint: true })
  if (!proof.isFile() || proof.size !== 0n)
    throw new Error("The disposable Codium fixture was missing its empty dummy proof descriptor")
  return `${proof.dev}:${proof.ino}`
}

async function identity(pid: number) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  const status = await fs.readFile(`/proc/${pid}/status`, "utf8")
  return {
    pid,
    uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
    start: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
  }
}

async function crashProtection() {
  const controls = ProcessIsolation.launch(process.execPath, [self, "--crash-controls"])
  const { core, noNewPrivileges } = JSON.parse((await execute(controls.file, controls.args)).stdout)
  if (core !== "/dev/null" || noNewPrivileges !== true)
    throw new Error("The inherited crash/privilege controls are not effective in the actual isolated child")
  const directory = path.join(process.cwd(), "probe-crash")
  await fs.mkdir(directory)
  const before: string[] = await fs.readdir("/var/crash").catch(() => [])
  const isolated = ProcessIsolation.launch(process.execPath, [self, "--crash"], { cwd: directory })
  const child = spawn(isolated.file, isolated.args, {
    cwd: directory,
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  })
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  child.stdin.end(`probe-crash-${randomUUID()}`)
  const aborted = await ended
  if (aborted.signal !== "SIGABRT" && aborted.code !== 134) throw new Error("The synthetic crash did not occur")
  const generated = await fs.readdir(directory)
  const reports = (await fs.readdir("/var/crash").catch(() => [])).filter((name) => !before.includes(name))
  if (generated.length || reports.length) throw new Error("A crash artifact was created")
  return { core, hardZero: true, noNewPrivileges, noDump: true }
}

async function scan(parent: number) {
  const leaks: string[] = []
  for (const pid of (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    for (const name of ["environ", "cmdline"]) {
      const data = await fs.readFile(`/proc/${pid}/${name}`, "utf8").catch(() => "")
      if (markers.some((value) => data.includes(value)) || data.includes("ACTIONS_RUNTIME_TOKEN="))
        leaks.push(`${pid}/${name}`)
    }
  }
  const memory = await fs.open(`/proc/${parent}/mem`, "r").then(
    async (file) => {
      await file.close()
      return true
    },
    () => false,
  )
  const writable: string[] = []
  const metadata = JSON.parse(await fs.readFile("/opt/vector-sandbox-probe-paths.json", "utf8"))
  if (typeof metadata.commands !== "string" || !path.isAbsolute(metadata.commands))
    throw new Error("Missing trusted command directory")
  const directory: string = metadata.commands
  const enumeration = await fs.readdir(directory).then(
    (names) => ({ names, denied: false }),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EACCES" && error.code !== "EPERM")
        throw new Error("The actual runner command directory is unavailable")
      return { names: [] as string[], denied: true }
    },
  )
  if (!enumeration.denied && !enumeration.names.length) throw new Error("The runner command scan had no actual files")
  for (const name of enumeration.names) {
    const file = path.join(directory, name)
    const input = await fs
      .open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EACCES" && error.code !== "EPERM") throw new Error("Unexpected file-command read failure")
        return undefined
      })
    if (input)
      try {
        const info = await input.stat()
        if (!info.isFile() || info.size > 1_048_576) throw new Error("Unexpected runner command file")
        const bytes = Buffer.alloc(1_048_577)
        let size = 0
        while (size < bytes.length) {
          const part = await input.read(bytes, size, bytes.length - size, size)
          if (!part.bytesRead) break
          size += part.bytesRead
        }
        if (size > 1_048_576) throw new Error("Runner command file grew past the probe bound")
        const content = bytes.subarray(0, size).toString("utf8")
        if (markers.some((value) => content.includes(value)) || content.includes("ACTIONS_RUNTIME_TOKEN="))
          leaks.push(`file-command/${name}`)
      } finally {
        await input.close()
      }
    const written = await (async () => {
      const output = await fs.open(
        file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        await output.writeFile("VECTOR_SANDBOX_ESCAPED=1\n")
      } finally {
        await output.close()
      }
    })().then(
      () => true,
      () => false,
    )
    if (written) writable.push(name)
  }
  const permitted = (command: string, args: string[]) =>
    execute(command, args, { timeout: 5000 }).then(
      () => true,
      () => false,
    )
  return {
    leaks,
    memory,
    writable,
    commandDirectoryChecked: true,
    enumerationDenied: enumeration.denied,
    sudo: await permitted("/usr/bin/sudo", ["-n", "true"]),
    docker: await permitted("/usr/bin/docker", ["info"]),
  }
}

if (process.argv[2] === "--module-load-check") {
  // Packaging smoke only: imports initialize, but no filesystem/process probe or credential channel is entered.
  console.log("Sandbox probe modules loaded")
} else if (process.argv[2] === "--pty-fixture-check") {
  // An isolated build check can supply an empty temporary descriptor without entering the private channel.
  ProcessIsolation.requireIsolation()
  const { probePtyDescriptors } = await import("./sandbox-pty-probe")
  await probePtyDescriptors(syntheticProofIdentity())
  console.log("Staged PTY descriptor check passed")
} else if (process.argv[2] === "--crash-controls") {
  const limits = await fs.readFile("/proc/self/limits", "utf8")
  const status = await fs.readFile("/proc/self/status", "utf8")
  if (!/Max core file size\s+0\s+0\s+bytes/.test(limits)) throw new Error("Missing inherited hard zero core limit")
  console.log(
    JSON.stringify({
      core: (await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim(),
      noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    }),
  )
} else if (process.argv[2] === "--crash") {
  const capture: Buffer[] = []
  for await (const chunk of process.stdin) capture.push(Buffer.from(chunk))
  if (!Buffer.concat(capture).toString("utf8").startsWith("probe-crash-"))
    throw new Error("Missing synthetic crash value")
  process.kill(process.pid, "SIGABRT")
} else if (process.argv[2] === "--scan") {
  console.log(JSON.stringify(await scan(Number(process.argv[3]))))
} else if (process.argv[2] === "--detached") {
  console.log("ready")
  while (!(await fs.stat(trigger).catch(() => undefined))) await new Promise((resolve) => setTimeout(resolve, 25))
  await scan(process.ppid)
  await fs.writeFile(escaped, "A detached agent survived cleanup")
} else if (process.argv[2] === "--assert") {
  const report = JSON.parse(
    await fs.readFile(path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "observed.json"), "utf8"),
  )
  const failure = process.env.PROBE_SCENARIO !== "success"
  if (process.env.PROBE_FINISH_OUTCOME !== (failure ? "failure" : "success"))
    throw new Error("Unexpected cleanup outcome")
  if (process.env.PROBE_UPLOAD_OUTCOME !== (failure ? "skipped" : "success"))
    throw new Error("The artifact boundary gate did not match cleanup")
  // The positive control: the runner did record the planted step output the probe must not have found.
  if (process.env.PROBE_PLANTED !== markers[5]) throw new Error("The planted step output was not recorded")
  if (!report.crash?.hardZero || !report.crash?.noDump || !report.crash?.noNewPrivileges)
    throw new Error("Missing crash isolation evidence")
  // The bubblewrap floor's own fields hold only in a build that has it; every other guard holds in both.
  if (report.toolProcess?.floor !== ProcessIsolation.FLOOR)
    throw new Error("The tool probe's floor does not match this build")
  if (
    ProcessIsolation.FLOOR &&
    (!report.toolProcess.targetInvisible || !report.toolProcess.signalBlocked || !report.toolProcess.engineProcHidden)
  )
    throw new Error("Missing actual ShellTool process-namespace acceptance")
  if (
    !report.toolProcess?.actualShellTool ||
    report.toolProcess?.shellProofExcluded !== (process.env.VECTOR_MODE === "codium") ||
    report.ptyProofExcluded !== (process.env.VECTOR_MODE === "codium") ||
    !report.toolProcess?.sameUid ||
    !report.toolProcess?.inspectorStayedClosed ||
    !report.toolProcess?.controlInspectorOpened ||
    !report.toolProcess?.activeInspectorRefused ||
    !report.toolProcess?.utilityLaunch ||
    !report.toolProcess?.lspLaunch ||
    !report.toolProcess?.mcpLaunch ||
    !report.toolProcess?.effectLaunch ||
    !report.toolProcess?.actualFileToolsRefused ||
    !report.toolProcess?.nativeLoaderRefused ||
    !report.toolProcess?.ordinaryEnvironmentPreserved ||
    !report.toolProcess?.loaderControlExecuted
  )
    throw new Error("Missing actual ShellTool process-isolation acceptance")
  if (
    !report.channel ||
    !report.scan.commandDirectoryChecked ||
    report.scan.leaks.length ||
    report.scan.memory ||
    report.scan.writable.length ||
    report.scan.sudo ||
    report.scan.docker
  )
    throw new Error(`The sandbox probe found an isolation failure: ${JSON.stringify(report.scan.leaks)}`)
  const stage = JSON.parse(
    await fs.readFile(path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "stage.json"), "utf8"),
  )
  if (stage.workspace !== process.env.GITHUB_WORKSPACE || stage.uid !== report.detached.uid)
    throw new Error("The observed staging identity changed")
  const original = await fs.lstat(stage.workspace)
  if (
    !original.isDirectory() ||
    original.uid !== process.getuid?.() ||
    (original.mode & 0o777) !== 0o700 ||
    (await fs.realpath(stage.workspace)) !== stage.workspace ||
    (await fs.readdir(stage.workspace)).length
  )
    throw new Error("The original workspace is not an empty private runner placeholder")
  if (
    await fs.lstat(stage.container).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
  )
    throw new Error("The staged checkout survived cleanup")
  if (stage.detached.pid !== report.detached.pid || stage.detached.uid !== report.detached.uid)
    throw new Error("The trusted detached-process observation changed")
  const current = await identity(report.detached.pid).catch(() => undefined)
  const status = await fs.readFile(`/proc/${report.detached.pid}/status`, "utf8").catch(() => "")
  if (
    current?.uid === report.detached.uid &&
    current?.start === stage.detached.start &&
    status &&
    !/^State:\s+Z/m.test(status)
  )
    throw new Error("A detached agent process survived cleanup")
  const rows = (await execute("/usr/bin/ps", ["-eo", "uid=,stat="])).stdout.trim().split("\n")
  if (
    rows.some((row) => {
      const [uid, state] = row.trim().split(/\s+/)
      return Number(uid) === report.detached.uid && !state?.startsWith("Z")
    })
  )
    throw new Error("A live agent process survived cleanup")
  const uploaded = await fs
    .stat(path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "upload-allowed"))
    .catch(() => undefined)
  if (Boolean(uploaded) === failure) throw new Error("A failed cleanup reached the artifact boundary")
  const session = await fs
    .readFile(path.join(process.env.RUNNER_TEMP!, "vector-session", "session.vsa"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
  if (process.env.PROBE_SCENARIO === "session-replaced" && session)
    throw new Error("The runner copied model-planted session bytes")
  if (
    !failure &&
    process.env.VECTOR_MODE === "codium" &&
    session?.toString() !== "synthetic ciphertext output for the disposable provenance probe"
  )
    throw new Error("The runner did not preserve the trusted exact session bytes")
  if (
    !failure &&
    JSON.stringify(
      JSON.parse(await fs.readFile(path.join(process.env.RUNNER_TEMP!, "vector-out", "summary.json"), "utf8")),
    ) !== JSON.stringify(report)
  )
    throw new Error("Bundle bytes changed during copying")
  if (process.env.VECTOR_SANDBOX_ESCAPED !== undefined) throw new Error("The next step's environment was changed")
  await fs.writeFile(trigger, "next step")
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (await fs.stat(escaped).catch(() => undefined)) throw new Error("The detached process reached the next step")
  console.log(
    "Sandbox probe passed: channel private, runner capabilities inaccessible, detached child stopped, staged checkout removed, original workspace empty.",
  )
} else {
  if (!(await fs.stat(process.env.GITHUB_WORKSPACE!)).isDirectory())
    throw new Error("The agent cannot access the checkout by its absolute path")
  await GithubSecrets.credentials.load()
  const holder = GithubSecrets.credentials
  const channel =
    holder.githubToken() === markers[1] &&
    (process.env.VECTOR_MODE === "codium"
      ? holder.pendingRunToken() === markers[3] &&
        holder.cliToken() === undefined &&
        Object.keys(holder.providerKeys()).length === 0
      : holder.cliToken() === markers[2] &&
        holder.pendingRunToken() === undefined &&
        holder.providerKeys().DEEPSEEK_KEY === markers[4])
  if (!channel) throw new Error("The probe could not receive its private credential channel")
  // The home is created empty, never from the runner image's /etc/skel and its toolchains, with an agent-owned .config.
  const config = await fs.lstat(path.join(process.env.HOME!, ".config"))
  if (
    (await fs.readdir(process.env.HOME!)).some((name) =>
      [".rustup", ".cargo", ".nvm", ".dotnet", ".bash_profile", ".bashrc", ".profile"].includes(name),
    ) ||
    !config.isDirectory() ||
    config.uid !== process.getuid?.()
  )
    throw new Error("The agent home was not created empty with its own .config")
  const codium = process.env.VECTOR_MODE === "codium"
  if (codium && !holder.sessionProof()) throw new Error("The disposable Codium fixture has no evidence of its proof descriptor")
  const syntheticProof = codium ? syntheticProofIdentity() : undefined
  const toolProcess = await withToolProbeProfile(
    (root) => probeToolProcesses(root, syntheticProof),
    syntheticProof
      ? async () => {
          const { probePtyDescriptors } = await import("./sandbox-pty-probe")
          await probePtyDescriptors(syntheticProof)
        }
      : undefined,
  )
  // This is a real shell child of the engine-shaped process; it receives only the OS environment, never the holder.
  const scanner = ProcessIsolation.launch("/bin/bash", [
    "--noprofile",
    "--norc",
    "-c",
    'exec "$1" "$2" --scan "$3"',
    "probe",
    process.execPath,
    self,
    String(process.pid),
  ])
  const child = await execute(scanner.file, scanner.args, { timeout: 15_000 })
  const report = JSON.parse(child.stdout)
  const crash = await crashProtection()
  const detached = spawn(process.execPath, [self, "--detached"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Detached probe did not start")), 5000)
    detached.once("error", reject)
    detached.stdout.once("data", () => {
      clearTimeout(timer)
      resolve()
    })
  })
  detached.stdout.destroy()
  detached.unref()
  const detachedIdentity = { pid: detached.pid!, uid: process.getuid?.() }
  await fs.mkdir("vector-out", { recursive: true })
  await fs.writeFile("vector-out/patch.diff", "", { mode: 0o600 })
  await fs.writeFile(
    "vector-out/summary.json",
    JSON.stringify({
      channel,
      scan: report,
      crash,
      toolProcess,
      ptyProofExcluded: syntheticProof !== undefined,
      detached: detachedIdentity,
    }),
    { mode: 0o600 },
  )
  if (process.env.VECTOR_MODE === "codium") {
    // This fixture tests private provenance and byte binding, not the separate real encryption codec.
    const bytes = Buffer.from("synthetic ciphertext output for the disposable provenance probe")
    await fs.writeFile("vector-out/session.vsa", bytes, { mode: 0o600, flag: "wx" })
    if (!GithubSessionProof.attestSessionArtifact(bytes)) throw new Error("The trusted session proof was not recorded")
    if (process.argv.includes("--session-replaced"))
      await fs.writeFile("vector-out/session.vsa", "model-planted plaintext after the trusted writer")
  }
  if (process.argv.includes("--bundle-refusal")) {
    await fs.unlink("vector-out/patch.diff")
    await fs.symlink("/etc/passwd", "vector-out/patch.diff")
  }
  if (report.leaks.length || report.memory || report.writable.length || report.sudo || report.docker)
    throw new Error("The probe found an isolation failure")
}
