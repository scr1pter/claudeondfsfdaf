import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"

const execute = promisify(execFile)
const self = fileURLToPath(import.meta.url)
const markers = [
  "probe-oidc-private-73af",
  "probe-github-private-92bc",
  "vct_probe.signature",
  "vrt_probe.signature",
  "probe-provider-private-44de",
]
const trigger = "/tmp/vector-sandbox-probe-next-step"
const escaped = "/tmp/vector-sandbox-probe-detached-escaped"

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
  const limits = await fs.readFile("/proc/self/limits", "utf8")
  const status = await fs.readFile("/proc/self/status", "utf8")
  const core = (await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim()
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(status)
  if (core !== "/dev/null" || !/Max core file size\s+0\s+0\s+bytes/.test(limits) || !noNewPrivileges)
    throw new Error("The crash/privilege controls are not effective in the child")
  const directory = path.join(process.cwd(), "probe-crash")
  await fs.mkdir(directory)
  const before: string[] = await fs.readdir("/var/crash").catch(() => [])
  const child = spawn(process.execPath, [self, "--crash"], {
    cwd: directory,
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  })
  const ended = new Promise<string | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (_code, signal) => resolve(signal))
  })
  child.stdin.end(`probe-crash-${randomUUID()}`)
  if ((await ended) !== "SIGABRT") throw new Error("The synthetic crash did not occur")
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

if (process.argv[2] === "--crash") {
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
  if (!report.crash?.hardZero || !report.crash?.noDump || !report.crash?.noNewPrivileges)
    throw new Error("Missing crash isolation evidence")
  if (
    !report.channel ||
    !report.scan.commandDirectoryChecked ||
    report.scan.leaks.length ||
    report.scan.memory ||
    report.scan.writable.length ||
    report.scan.sudo ||
    report.scan.docker
  )
    throw new Error("The sandbox probe found an isolation failure")
  if (await fs.stat(process.env.GITHUB_WORKSPACE!).catch(() => undefined))
    throw new Error("The checkout survived cleanup")
  const current = await identity(report.detached.pid).catch(() => undefined)
  const status = await fs.readFile(`/proc/${report.detached.pid}/status`, "utf8").catch(() => "")
  if (
    current?.uid === report.detached.uid &&
    current?.start === report.detached.start &&
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
    "Sandbox probe passed: channel private, runner capabilities inaccessible, detached child stopped, checkout removed.",
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
  // This is a real shell child of the engine-shaped process; it receives only the OS environment, never the holder.
  const child = await execute(
    "/bin/bash",
    ["--noprofile", "--norc", "-c", 'exec "$1" "$2" --scan "$3"', "probe", process.execPath, self, String(process.pid)],
    { timeout: 15_000 },
  )
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
  const detachedIdentity = await identity(detached.pid!)
  await fs.mkdir("vector-out", { recursive: true })
  await fs.writeFile("vector-out/patch.diff", "", { mode: 0o600 })
  await fs.writeFile(
    "vector-out/summary.json",
    JSON.stringify({ channel, scan: report, crash, detached: detachedIdentity }),
    { mode: 0o600 },
  )
  await fs.writeFile("vector-out/session.vsa", "synthetic probe session", { mode: 0o600 })
  if (process.argv.includes("--bundle-refusal")) {
    await fs.unlink("vector-out/patch.diff")
    await fs.symlink("/etc/passwd", "vector-out/patch.diff")
  }
  if (report.leaks.length || report.memory || report.writable.length || report.sudo || report.docker)
    throw new Error("The probe found an isolation failure")
}
