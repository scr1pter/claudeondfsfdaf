import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { GithubSecrets } from "./github.secrets"

const execute = promisify(execFile)
const USER = GithubAgents.SANDBOX_USER
const AGENT_HOME = `/home/${USER}`
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const FILE_COMMANDS = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"] as const
const State = z
  .object({
    v: z.literal(1),
    workspace: z.string(),
    mode: z.enum(["codium", "own-key"]),
    sudo: z.boolean(),
    uid: z.number().int().positive().optional(),
    gid: z.number().int().positive().optional(),
    prepared: z.boolean(),
  })
  .strict()
type State = z.infer<typeof State>
type Env = Readonly<Record<string, string | undefined>>

function refused() {
  return new Error("The GitHub agent sandbox could not verify its isolation or cleanup. The run is refused.")
}

function mode(env: Env) {
  if (env.GITHUB_ACTIONS !== "true") throw refused()
  if (env.VECTOR_MODE !== "codium" && env.VECTOR_MODE !== "own-key") throw refused()
  if (env.VECTOR_MODE === "codium" && env.VECTOR_AGENT_SUDO === "1") throw refused()
  if (!["github-hosted", "self-hosted"].includes(env.RUNNER_ENVIRONMENT ?? "")) throw refused()
  if (env.VECTOR_MODE === "codium" && env.RUNNER_ENVIRONMENT !== "github-hosted") throw refused()
  return env.VECTOR_MODE
}

function absolute(value: string | undefined) {
  if (!value || !path.isAbsolute(value) || value.includes("\0") || path.resolve(value) !== value) throw refused()
  return value
}

function checkoutPath(env: Env) {
  const workspace = absolute(env.GITHUB_WORKSPACE)
  const temporary = absolute(env.RUNNER_TEMP)
  if (
    workspace === "/" ||
    workspace === env.HOME ||
    workspace === temporary ||
    temporary.startsWith(workspace + "/") ||
    workspace.startsWith(temporary + "/")
  )
    throw refused()
  return workspace
}

async function checkout(env: Env) {
  const workspace = checkoutPath(env)
  if ((await fs.realpath(workspace)) !== workspace || !(await fs.lstat(workspace)).isDirectory()) throw refused()
  return workspace
}

async function command(file: string, args: readonly string[], allowed = [0]) {
  const result = await execute(file, [...args], {
    env: { PATH: SYSTEM_PATH, LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
  }).then(
    (value) => ({ code: 0, stdout: value.stdout }),
    (error: { code?: unknown; stdout?: unknown }) => ({
      code: typeof error.code === "number" ? error.code : -1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
    }),
  )
  if (!allowed.includes(result.code)) throw refused()
  return result
}

const sudo = (args: readonly string[], allowed?: number[]) => command("/usr/bin/sudo", ["-n", ...args], allowed)

async function privateDirectory(directory: string, create = false) {
  if (create)
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw refused()
    })
  const info = await fs.lstat(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await fs.realpath(directory)) !== directory
  )
    throw refused()
}

function stateDirectory(env: Env) {
  return path.join(absolute(env.RUNNER_TEMP), "vector-sandbox")
}

async function readState(env: Env) {
  const directory = stateDirectory(env)
  const exists = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw refused()
  })
  if (!exists) return
  await privateDirectory(directory)
  const file = await fs.open(path.join(directory, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw refused()
    const raw = await file.readFile("utf8")
    if (Buffer.byteLength(raw) > 4096) throw refused()
    return State.parse(JSON.parse(raw))
  } finally {
    await file.close()
  }
}

async function writeState(env: Env, state: State, first = false) {
  const directory = stateDirectory(env)
  await privateDirectory(directory, first)
  const file = await fs.open(
    path.join(directory, "state.json"),
    constants.O_WRONLY | constants.O_NOFOLLOW | (first ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC),
    0o600,
  )
  try {
    await file.writeFile(JSON.stringify(state))
  } finally {
    await file.close()
  }
}

/** The caller supplies only trusted paths; no secret name or credential enters the child's OS environment. */
export function sandboxEnvironment(
  env: Env,
  locations: { home: string; temporary: string; event: string },
): Record<string, string> {
  mode(env)
  const names = new Set(env.VECTOR_SECRET_ENV_NAMES?.split(",") ?? [])
  return {
    ...Object.fromEntries(
      GithubAgents.SANDBOX_ENV_ALLOW.flatMap((name) =>
        env[name] === undefined || names.has(name) || GithubAgents.SECRET_NAME_PATTERN.test(name)
          ? []
          : [[name, env[name]!]],
      ),
    ),
    HOME: absolute(locations.home),
    RUNNER_TEMP: absolute(locations.temporary),
    GITHUB_EVENT_PATH: absolute(locations.event),
    VECTOR_SECRET_CHANNEL: "stdin",
  }
}

/** Capture only the selected credential domain. Other inherited keys never travel to the engine. */
export async function secretChannel(
  env: Env,
  files: { readRunToken: typeof GithubSecrets.readRunToken } = GithubSecrets,
) {
  const selected = mode(env)
  const holder = GithubSecrets.createGithubSecrets()
  const capture = {
    v: 1,
    githubToken: env.GITHUB_TOKEN,
    ...(selected === "codium"
      ? { runToken: await files.readRunToken(env), keys: {} }
      : {
          cliToken: env.VECTOR_CLI_TOKEN,
          keys: Object.fromEntries(
            (env.VECTOR_SECRET_ENV_NAMES?.split(",").filter(Boolean) ?? []).map((name) => [name, env[name] ?? ""]),
          ),
        }),
  }
  await holder.load(
    { ...env, VECTOR_SECRET_CHANNEL: "stdin" },
    (async function* () {
      yield JSON.stringify(capture) + "\n"
    })(),
  )
  return JSON.stringify(capture) + "\n"
}

/** Copy only a bounded, unlinked regular file, including checks on the parent directory. */
export async function copyBundleFile(source: string, destination: string, name: string) {
  const limit =
    name === "patch.diff"
      ? GithubAgents.PATCH_LIMITS.bytes
      : name === "summary.json"
        ? GithubAgents.PATCH_LIMITS.summaryBytes
        : name === "session.vsa"
          ? GithubAgents.PATCH_LIMITS.sessionBytes
          : undefined
  if (!limit || (await fs.realpath(source)) !== path.resolve(source)) throw refused()
  if (!(await fs.lstat(source)).isDirectory()) throw refused()
  await privateDirectory(destination, true)
  const input = await fs.open(path.join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await input.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw refused()
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const part = await input.read(buffer, size, buffer.length - size, size)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    if (size > limit) throw refused()
    const output = await fs.open(
      path.join(destination, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await output.writeFile(buffer.subarray(0, size))
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

export async function prepare(env: Env = process.env) {
  if (process.platform !== "linux") throw refused()
  const selected = mode(env)
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") throw refused()
  const workspace = await checkout(env)
  if ((await command("/usr/bin/id", ["-u", USER], [0, 1])).code === 0) throw refused()
  const state: State = { v: 1, workspace, mode: selected, sudo: env.VECTOR_AGENT_SUDO === "1", prepared: false }
  await writeState(env, state, true)
  if ((await fs.stat(workspace)).dev !== (await fs.stat(stateDirectory(env))).dev) throw refused()
  await sudo([
    "/usr/sbin/useradd",
    "--user-group",
    "--create-home",
    "--home-dir",
    AGENT_HOME,
    "--shell",
    "/bin/bash",
    "--no-log-init",
    USER,
  ])
  state.uid = Number((await command("/usr/bin/id", ["-u", USER])).stdout.trim())
  state.gid = Number((await command("/usr/bin/id", ["-g", USER])).stdout.trim())
  State.parse(state)
  await writeState(env, state)
  await sudo([
    "/usr/bin/install",
    "-d",
    "-m",
    "0700",
    "-o",
    String(state.uid),
    "-g",
    String(state.gid),
    `${AGENT_HOME}/tmp`,
  ])
  await sudo(["/usr/bin/chown", "-hR", `${state.uid}:${state.gid}`, "--", workspace])
  await sudo(["/usr/bin/systemctl", "stop", "docker.socket", "docker.service"])
  if (await fs.lstat("/var/run/docker.sock").catch(() => undefined))
    await sudo(["/usr/bin/chmod", "0600", "/var/run/docker.sock"])
  const before = Number((await fs.readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8")).trim())
  if (!Number.isInteger(before) || before < 0) throw refused()
  if (before < 2) await sudo(["/usr/sbin/sysctl", "-w", "kernel.yama.ptrace_scope=2"])
  if (Number((await fs.readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8")).trim()) < 2) throw refused()
  // A pipe core handler can ignore RLIMIT_CORE. Disable that route as well as enforcing a hard zero on the child.
  await sudo(["/usr/sbin/sysctl", "-w", "kernel.core_pattern=/dev/null"])
  if ((await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim() !== "/dev/null") throw refused()
  const event = absolute(env.GITHUB_EVENT_PATH)
  if (!(await fs.stat(event)).isFile() || (await fs.stat(event)).size > 10_000_000) throw refused()
  await sudo([
    "/usr/bin/install",
    "-m",
    "0400",
    "-o",
    String(state.uid),
    "-g",
    String(state.gid),
    "--",
    event,
    `${AGENT_HOME}/event.json`,
  ])
  if (state.sudo) {
    const file = path.join(stateDirectory(env), "sudoers")
    await fs.writeFile(file, `${USER} ALL=(ALL) NOPASSWD: ALL\n`, { mode: 0o600, flag: "wx" })
    await sudo(["/usr/sbin/visudo", "-cf", file])
    await sudo(["/usr/bin/install", "-m", "0440", "-o", "root", "-g", "root", "--", file, `/etc/sudoers.d/${USER}`])
  }
  const asAgent = [
    "/usr/bin/prlimit",
    "--core=0:0",
    "--",
    "/usr/bin/setpriv",
    `--reuid=${state.uid}`,
    `--regid=${state.gid}`,
    "--clear-groups",
    ...(!state.sudo ? ["--no-new-privs"] : []),
    "--",
    "/usr/bin/env",
    "-i",
    `PATH=${SYSTEM_PATH}`,
  ]
  const groups = (await sudo([...asAgent, "/usr/bin/id", "-G"])).stdout.trim()
  if (groups !== String(state.gid)) throw refused()
  if ((await sudo([...asAgent, "/usr/bin/sudo", "-n", "true"], [0, 1])).code !== (state.sudo ? 0 : 1)) throw refused()
  if ((await sudo([...asAgent, "/usr/bin/docker", "info"], [0, 1])).code === 0) throw refused()
  for (const name of FILE_COMMANDS) {
    const file = env[name]
    if (!file) continue
    const ancestors = [absolute(file)]
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      ancestors.push(parent)
      if (parent === path.dirname(parent)) break
    }
    for (const target of ancestors)
      if ((await sudo([...asAgent, "/usr/bin/test", "-w", target], [0, 1])).code === 0) throw refused()
  }
  state.prepared = true
  await writeState(env, state)
}

async function executable(name: string, env: Env) {
  if (name.includes("/") && !path.isAbsolute(name)) throw refused()
  const candidates = path.isAbsolute(name)
    ? [name]
    : (env.PATH ?? SYSTEM_PATH)
        .split(path.delimiter)
        .filter(path.isAbsolute)
        .map((directory) => path.join(directory, name))
  for (const candidate of candidates) {
    if (
      !(await fs.access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      continue
    const resolved = await fs.realpath(candidate)
    if ((await fs.stat(resolved)).isFile()) return resolved
  }
  throw refused()
}

export async function run(args: readonly string[], env: Env = process.env) {
  if (process.platform !== "linux") throw refused()
  mode(env)
  if (!args.length || args.some((value) => value.includes("\0"))) throw refused()
  const workspace = await checkout(env)
  const node = await executable("node", env)
  const binary = await executable(args[0]!, env)
  const hosted = env.RUNNER_ENVIRONMENT === "github-hosted"
  const state = hosted ? await readState(env) : undefined
  if (
    hosted &&
    (!state?.prepared || !state.uid || !state.gid || state.workspace !== workspace || state.mode !== env.VECTOR_MODE)
  )
    throw refused()
  if (
    hosted &&
    ((await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim() !== "/dev/null" ||
      Number((await fs.readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8")).trim()) < 2 ||
      Number((await command("/usr/bin/id", ["-u", USER])).stdout.trim()) !== state!.uid)
  )
    throw refused()
  const home = hosted ? AGENT_HOME : absolute(env.HOME)
  const temporary = path.join(home, "tmp", "vector-agent")
  if (hosted)
    await sudo(["/usr/bin/install", "-d", "-m", "0700", "-o", String(state!.uid), "-g", String(state!.gid), temporary])
  if (!hosted) {
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 })
    console.warn("This self-hosted own-key run uses a clean credential channel but has no separate-user sandbox.")
  }
  const clean = sandboxEnvironment(env, {
    home,
    temporary,
    event: hosted ? `${AGENT_HOME}/event.json` : absolute(env.GITHUB_EVENT_PATH),
  })
  clean.PATH = `${path.dirname(node)}:${SYSTEM_PATH}`
  const channel = await secretChannel(env)
  const launcher = hosted ? "/usr/bin/sudo" : binary
  const arguments_ = hosted
    ? [
        "-n",
        "/usr/bin/prlimit",
        "--core=0:0",
        "--",
        "/usr/bin/setpriv",
        `--reuid=${state!.uid}`,
        `--regid=${state!.gid}`,
        "--clear-groups",
        ...(!state!.sudo ? ["--no-new-privs"] : []),
        "--",
        "/usr/bin/env",
        "-i",
        ...Object.entries(clean).map(([name, value]) => `${name}=${value}`),
        binary,
        ...args.slice(1),
      ]
    : args.slice(1)
  return new Promise<number>((resolve, reject) => {
    const child = spawn(launcher, arguments_, {
      cwd: workspace,
      env: hosted ? { PATH: SYSTEM_PATH } : clean,
      stdio: ["pipe", "inherit", "inherit"],
    })
    const stop = () => child.kill("SIGTERM")
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)
    const cleanup = () => {
      process.removeListener("SIGTERM", stop)
      process.removeListener("SIGINT", stop)
    }
    child.once("error", () => {
      cleanup()
      reject(refused())
    })
    child.once("close", (code, signal) => {
      cleanup()
      resolve(code ?? (signal === "SIGINT" ? 130 : 143))
    })
    child.stdin.on("error", () => child.kill("SIGTERM"))
    child.stdin.end(channel)
  })
}

export async function finish(env: Env = process.env) {
  if (process.platform !== "linux") throw refused()
  mode(env)
  let cancelled = false
  const interrupt = () => {
    cancelled = true
    process.exitCode = 130
  }
  const terminate = () => {
    cancelled = true
    process.exitCode = 143
  }
  // Signals record cancellation only. No environment path is touched until private state establishes authority.
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    const hosted = env.RUNNER_ENVIRONMENT === "github-hosted"
    const state = hosted ? await readState(env) : undefined
    if (hosted && !state) return
    const workspace = checkoutPath(env)
    if (state && state.workspace !== workspace) throw refused()
    const quarantine = hosted ? path.join(stateDirectory(env), "checkout") : workspace
    if (hosted)
      await fs.rename(workspace, quarantine).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw refused()
      })
    // The original checkout is absent before any slow process or tree operation. Even forced termination from here
    // cannot make checkout's post step execute an agent-written configuration at its original path.
    let stopped = !hosted
    try {
      if (hosted) {
        if (!state?.uid || !state.gid) {
          if (state?.prepared) throw refused()
          stopped = true
        } else {
          if (Number((await command("/usr/bin/id", ["-u", USER])).stdout.trim()) !== state.uid) throw refused()
          for (let attempt = 0; attempt < 20 && !stopped; attempt++) {
            await sudo(["/usr/bin/pkill", "-KILL", "-u", String(state.uid)], [0, 1])
            const rows = (await command("/usr/bin/ps", ["-eo", "uid=,stat="])).stdout.trim().split("\n")
            stopped = !rows.some((line) => {
              const [uid, status] = line.trim().split(/\s+/)
              return Number(uid) === state.uid && !status?.startsWith("Z")
            })
            if (!stopped) await new Promise((resolve) => setTimeout(resolve, 100))
          }
          if (!stopped) throw new Error("The sandbox could not stop every agent process. Artifact upload is refused.")
          if (await fs.lstat(quarantine).catch(() => undefined))
            await sudo(["/usr/bin/chown", "-hR", `${process.getuid?.()}:${process.getgid?.()}`, "--", quarantine])
        }
      }
      if (!cancelled)
        for (const name of [...GithubAgents.BUNDLE_FILES, GithubAgents.SESSION_FILE]) {
          const directory = path.join(
            absolute(env.RUNNER_TEMP),
            name === GithubAgents.SESSION_FILE ? "vector-session" : "vector-out",
          )
          await copyBundleFile(path.join(quarantine, GithubAgents.BUNDLE_DIR), directory, name).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw refused()
            },
          )
        }
    } finally {
      const removed = await (
        hosted ? sudo(["/usr/bin/rm", "-rf", "--", quarantine]) : fs.rm(workspace, { recursive: true, force: true })
      ).then(
        () => true,
        () => false,
      )
      const privilegesRemoved =
        !state?.sudo ||
        (await sudo(["/usr/bin/rm", "-f", "--", `/etc/sudoers.d/${USER}`]).then(
          () => true,
          () => false,
        ))
      if (hosted && stopped && removed && privilegesRemoved) await fs.rm(stateDirectory(env), { recursive: true })
      if (!removed || !privilegesRemoved)
        throw new Error("The sandbox could not complete checkout or privilege cleanup. Artifact upload is refused.")
    }
    if (cancelled) throw new Error("Sandbox cleanup completed after cancellation. Artifact upload is refused.")
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", terminate)
  }
}
