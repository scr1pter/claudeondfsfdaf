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
const STAGING_PARENTS = ["/mnt", "/var/lib", "/home"] as const
const STAGING_CONTAINERS = STAGING_PARENTS.map((parent) => path.join(parent, "vector-agent-sandbox"))
const FILE_COMMANDS = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"] as const
const State = z
  .object({
    v: z.literal(1),
    workspace: z.string(),
    container: z.string().refine((value) => STAGING_CONTAINERS.includes(value)),
    created: z.boolean(),
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

async function command(file: string, args: readonly string[], allowed = [0], timeout = 30_000) {
  const result = await execute(file, [...args], {
    env: { PATH: SYSTEM_PATH, LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout,
    maxBuffer: 65_536,
  }).then(
    (value) => ({ code: 0, stdout: value.stdout }),
    (error: { code?: unknown; stdout?: unknown }) => ({
      code: typeof error.code === "number" ? error.code : -1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
    }),
  )
  if (!allowed.includes(result.code)) {
    // Fixed executable names only: argv/stdout/stderr can contain private paths or credentials.
    const operation = file === "/usr/bin/sudo" ? args[1] : file
    throw new Error(`Sandbox operation ${path.basename(operation ?? file)} failed or timed out; the run is refused.`)
  }
  return result
}

const sudo = (args: readonly string[], allowed?: number[], timeout?: number) =>
  command("/usr/bin/sudo", ["-n", ...args], allowed, timeout)

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

/** Inspect without following repository links before any recursive ownership change. */
export async function validateCheckoutTree(directory: string) {
  const root = await fs.lstat(directory)
  if (!root.isDirectory() || (await fs.realpath(directory)) !== directory) throw refused()
  let entries = 0
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 64) throw refused()
    const handle = await fs.opendir(current)
    for await (const entry of handle) {
      if (++entries > 200_000) throw refused()
      const name = path.join(current, entry.name)
      const info = await fs.lstat(name)
      if (info.dev !== root.dev) throw refused()
      if (info.isDirectory()) await walk(name, depth + 1)
      else if (info.isFile()) {
        if (info.nlink !== 1) throw refused()
      } else if (!info.isSymbolicLink()) throw refused()
    }
  }
  await walk(directory, 0)
}

async function trustedParent(directory: string) {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await fs.lstat(current)
    if (
      !info.isDirectory() ||
      info.uid !== 0 ||
      info.mode & 0o022 ||
      !(info.mode & 0o001) ||
      (await fs.realpath(current)) !== current
    )
      throw refused()
    if (current === path.dirname(current)) break
  }
}

async function stagingContainer(workspace: string) {
  const device = (await fs.lstat(workspace)).dev
  for (const parent of STAGING_PARENTS) {
    try {
      await trustedParent(parent)
      if ((await fs.lstat(parent)).dev !== device) continue
      const candidate = path.join(parent, "vector-agent-sandbox")
      if (
        await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw refused()
          return undefined
        })
      )
        continue
      return candidate
    } catch {
      // Only fixed candidates are considered; unsupported layouts are refused, never recursively copied.
    }
  }
  throw refused()
}

async function verifyContainer(container: string, ready = false) {
  if (!STAGING_CONTAINERS.includes(container)) throw refused()
  await trustedParent(path.dirname(container))
  const info = await fs.lstat(container)
  const permissions = info.mode & 0o777
  if (
    !info.isDirectory() ||
    (await fs.realpath(container)) !== container ||
    (ready
      ? info.uid !== 0 || permissions !== 0o755
      : !(
          (info.uid === 0 && [0o700, 0o755].includes(permissions)) ||
          (info.uid === process.getuid?.() && permissions === 0o700)
        ))
  )
    throw refused()
}

async function placeholder(workspace: string, create = false) {
  if (create)
    await fs.mkdir(workspace, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw refused()
    })
  await privateDirectory(workspace)
  if ((await fs.readdir(workspace)).length !== 0) throw refused()
}

async function prepareBundle(directory: string) {
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw refused()
    return undefined
  })
  if (!info) return
  if (!info.isDirectory() || (await fs.realpath(directory)) !== directory) throw refused()
  const owner = `${process.getuid?.()}:${process.getgid?.()}`
  await sudo(["/usr/bin/chown", "-h", owner, "--", directory])
  await sudo(["/usr/bin/chmod", "0700", "--", directory])
  for (const name of [...GithubAgents.BUNDLE_FILES, GithubAgents.SESSION_FILE]) {
    const file = path.join(directory, name)
    const item = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw refused()
      return undefined
    })
    if (!item) continue
    const limit =
      name === "patch.diff"
        ? GithubAgents.PATCH_LIMITS.bytes
        : name === "summary.json"
          ? GithubAgents.PATCH_LIMITS.summaryBytes
          : GithubAgents.PATCH_LIMITS.sessionBytes
    if (!item.isFile() || item.nlink !== 1 || item.size > limit) throw refused()
    await sudo(["/usr/bin/chown", "-h", owner, "--", file])
    await sudo(["/usr/bin/chmod", "0600", "--", file])
  }
}

/** The caller supplies only trusted paths; no secret name or credential enters the child's OS environment. */
export function sandboxEnvironment(
  env: Env,
  locations: { home: string; temporary: string; event: string; node: string },
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
    // Keep installed Go/Rust/other runner toolchains reachable, while pinning the resolved Node interpreter and
    // excluding current-directory/relative lookups. The parent supplies this PATH before any agent code runs.
    PATH: [
      ...new Set([
        path.dirname(absolute(locations.node)),
        ...(names.has("PATH") ? [] : (env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute)),
        ...SYSTEM_PATH.split(":"),
      ]),
    ].join(path.delimiter),
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
  await validateCheckoutTree(workspace)
  const container = await stagingContainer(workspace)
  const staged = path.join(container, "checkout")
  const state: State = {
    v: 1,
    workspace,
    container,
    created: false,
    mode: selected,
    sudo: env.VECTOR_AGENT_SUDO === "1",
    prepared: false,
  }
  // Record cleanup authority before creating the container or moving the checkout.
  await writeState(env, state, true)
  await sudo(["/usr/bin/mkdir", "-m", "0700", "--", container])
  state.created = true
  await writeState(env, state)
  await sudo(["/usr/bin/chown", "-h", `${process.getuid?.()}:${process.getgid?.()}`, "--", container])
  await verifyContainer(container)
  await privateDirectory(path.join(container, "cleanup"), true)
  // rename(2) cannot fall back to recursive copying. A partial preparation never restores repository contents.
  await fs.rename(workspace, staged)
  await placeholder(workspace, true)
  await sudo(["/usr/bin/chown", "-h", "0:0", "--", container])
  await sudo(["/usr/bin/chmod", "0755", "--", container])
  await verifyContainer(container, true)
  await sudo(
    [
      "/usr/sbin/useradd",
      "--user-group",
      "--create-home",
      "--home-dir",
      AGENT_HOME,
      "--shell",
      "/bin/bash",
      "--no-log-init",
      USER,
    ],
    undefined,
    120_000,
  )
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
  await sudo(["/usr/bin/chown", "-hR", `${state.uid}:${state.gid}`, "--", staged])
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
    (!state?.prepared ||
      !state.created ||
      !state.uid ||
      !state.gid ||
      state.workspace !== workspace ||
      state.mode !== env.VECTOR_MODE)
  )
    throw refused()
  if (
    hosted &&
    ((await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim() !== "/dev/null" ||
      Number((await fs.readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8")).trim()) < 2 ||
      Number((await command("/usr/bin/id", ["-u", USER])).stdout.trim()) !== state!.uid)
  )
    throw refused()
  if (hosted) {
    await verifyContainer(state!.container, true)
    await placeholder(workspace)
  }
  const working = hosted ? path.join(state!.container, "checkout") : workspace
  if ((await fs.realpath(working)) !== working || !(await fs.lstat(working)).isDirectory()) throw refused()
  const home = hosted ? AGENT_HOME : absolute(env.HOME)
  const temporary = path.join(home, "tmp", "vector-agent")
  if (hosted)
    await sudo(["/usr/bin/install", "-d", "-m", "0700", "-o", String(state!.uid), "-g", String(state!.gid), temporary])
  if (!hosted) {
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 })
    console.warn("This self-hosted own-key run uses a clean credential channel but has no separate-user sandbox.")
  }
  const clean = sandboxEnvironment(env, {
    node,
    home,
    temporary,
    event: hosted ? `${AGENT_HOME}/event.json` : absolute(env.GITHUB_EVENT_PATH),
  })
  clean.GITHUB_WORKSPACE = working
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
        `--chdir=${working}`,
        ...Object.entries(clean).map(([name, value]) => `${name}=${value}`),
        binary,
        ...args.slice(1),
      ]
    : args.slice(1)
  return new Promise<number>((resolve, reject) => {
    const child = spawn(launcher, arguments_, {
      // GNU env changes to the staged directory only after setpriv. A mode-0700 checkout is owned by the agent.
      cwd: hosted ? workspace : working,
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
    if (state && !state.created) {
      if (state.prepared || state.uid || state.gid) throw refused()
      // No move or user creation preceded this phase. Never inspect/copy/remove another operation's container.
      await fs.rm(stateDirectory(env), { recursive: true })
      return
    }
    const container = state?.container
    let quarantine = workspace
    let cleanupAllowed = false
    let isolationError: unknown
    try {
      if (hosted) {
        if (!container || (!state?.created && (state?.prepared || state?.uid))) throw refused()
        quarantine = path.join(container, "cleanup", "checkout")
        // A selected path is not ownership. Only an exclusive mkdir acknowledged in private state grants cleanup.
        if (state?.created) {
          await trustedParent(path.dirname(container))
          cleanupAllowed = true
          const exists = await fs.lstat(container).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw refused()
            return undefined
          })
          if (exists) {
            await verifyContainer(container)
            // Close traversal first. The agent never obtains parent-write permission during this transition.
            await sudo(["/usr/bin/chmod", "0700", "--", container])
            await sudo(["/usr/bin/chown", "-h", `${process.getuid?.()}:${process.getgid?.()}`, "--", container])
            await privateDirectory(container)
            const staged = path.join(container, "checkout")
            const checkoutExists = await fs.lstat(staged).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw refused()
              return undefined
            })
            if (checkoutExists) {
              if (!checkoutExists.isDirectory() || (await fs.realpath(staged)) !== staged) throw refused()
              await privateDirectory(path.join(container, "cleanup"), true)
              await placeholder(workspace, true)
              await sudo(["/usr/bin/chown", "-h", `${process.getuid?.()}:${process.getgid?.()}`, "--", staged])
              await sudo(["/usr/bin/chmod", "0700", "--", staged])
              await fs.rename(staged, quarantine)
            } else if (state?.prepared) await placeholder(workspace)
          } else if (state?.prepared) await placeholder(workspace)
        }
      }
    } catch (error) {
      // Failure to seal/quarantine still requires UID shutdown and owned-path cleanup, but never artifact copying.
      isolationError = error
    }
    // The original workspace was replaced before agent launch. Post actions never regain an agent-written tree.
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
          if (!cancelled && !isolationError && (await fs.lstat(quarantine).catch(() => undefined)))
            await prepareBundle(path.join(quarantine, GithubAgents.BUNDLE_DIR))
        }
      }
      if (isolationError) throw isolationError
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
        hosted
          ? !state?.created
            ? Promise.resolve()
            : cleanupAllowed
              ? sudo(["/usr/bin/rm", "-rf", "--", container!])
              : Promise.reject(refused())
          : fs.rm(workspace, { recursive: true, force: true })
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
