import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, readFileSync } from "node:fs"
import { chmod, chown, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Hosted } from "@vectordevai/schema/hosted"
import { parseToolInput, PROTOCOL, type HandoffReason } from "./actions"
import { Computer, type ImageFormat } from "./computer"
import { Daemon, type AgentControl, type BrowserControl, type Job } from "./daemon"
import { checkRepository, GitError, HostGit, type Access, type Repository, type TokenSource } from "./git"
import { BrowserGuard, CdpPipe, guardView } from "./guard"
import {
  AGENT_HOME,
  AGENT_UID,
  BINARIES,
  BROWSER_PROFILE,
  BROWSER_UID,
  DISPLAY,
  DISPLAY_UID,
  DOWNLOADS_DIR,
  GENERATION_FILE,
  HOSTD_SOCKET,
  KILL_GRACE_MS,
  LOG_DIR,
  PACK_DIR,
  RECORDINGS_DIR,
  SCREEN,
  SHARE_GID,
  VIEWER_STATE,
  VIEWER_UID,
  WORK_DIR,
  X_GID,
  XAUTHORITY,
} from "./limits"
import { continueAll, killAll, linuxProcs, stopAll, ToolCalls, type ProcTable } from "./procs"
import { Recorder } from "./recorder"
import { dropTo, runProgram, type Runner } from "./run"
import { RunApi, type Transport, httpsTransport } from "./run-api"
import { browserPaths, wipeBrowser } from "./wipe"

/*
 * hostd, the cloud computer's daemon (contract WP A54). boot.sh starts it as root with exactly `--run-host <host>
 * --session <id>` (WP A53's boot step). It runs the session loop (daemon.ts), starts the agent as its own user, holds
 * the browser by its debugging pipe, and answers the agent on a Unix socket only the agent's user can open:
 *
 *   POST /v1/computer  {v: 1, input, format?}        one computer action in the local computer-use format (actions.ts)
 *   POST /v1/tool      {phase: "begin"|"end", id, pgid?}  tool-call bounds: what a call leaves running is killed
 *   POST /v1/git       {op: "clone"|"fetch"|"push", repository: {owner, name}, directory, branch?}
 *   GET  /v1/status    the session's state as hostd knows it
 *
 * It holds no credential. GitHub tokens for git are fetched per operation from the run-API host (git.ts).
 */

export type BootArgs = { runHost: string; session: string }

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** boot.sh's two arguments, exactly; anything else is refused. */
export function parseArgs(argv: readonly string[]): BootArgs {
  if (argv.length !== 4 || argv[0] !== "--run-host" || argv[2] !== "--session") throw new Error("usage: hostd --run-host <host> --session <id>")
  const runHost = argv[1]!
  const session = argv[3]!
  if (!HOST.test(runHost) || !Hosted.SESSION_ID.test(session)) throw new Error("usage: hostd --run-host <host> --session <id>")
  return { runHost, session }
}

/** The environment the agent starts with: where things are, and no secret of any kind. */
export function agentEnv(args: BootArgs): Record<string, string> {
  return {
    HOME: AGENT_HOME,
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    NO_COLOR: "1",
    VECTOR_HOSTED: "1",
    VECTOR_HOSTED_SESSION: args.session,
    VECTOR_HOSTED_RUN_HOST: args.runHost,
    VECTOR_COMPUTER_SOCKET: HOSTD_SOCKET,
  }
}

/**
 * Sets the file mode mask, then runs the rest of the arguments as given (they are never read by the shell). hostd itself
 * runs with 077, which suits it, not the agent's tools or the browser's downloads.
 */
function withUmask(mask: string, command: readonly string[]) {
  return ["/bin/sh", "-c", `umask ${mask} && exec "$@"`, "sh", ...command]
}

/** The agent's command line: Vector's CLI running the job's prompt in the agent's work folder. */
export function agentCommand(job: Job) {
  return dropTo(AGENT_UID, AGENT_UID, [SHARE_GID], withUmask("022", [
    BINARIES.vector,
    "run",
    "--format",
    "json",
    ...(job.title ? ["--title", job.title.slice(0, Hosted.TITLE_MAX)] : []),
    "--",
    job.prompt.slice(0, Hosted.PROMPT_MAX),
  ]))
}

/**
 * The browser's command line: Chromium under its managed policy (image/chromium-policies.json), its profile on the
 * memory disk, and the debugging pipe on fds 3 and 4 for hostd only. Its own sandbox stays on.
 */
export function browserCommand() {
  // Downloads land group-readable in the agent's downloads folder (group share).
  return dropTo(BROWSER_UID, BROWSER_UID, [X_GID, SHARE_GID], withUmask("007", [
    BINARIES.chromium,
    `--user-data-dir=${BROWSER_PROFILE}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--password-store=basic",
    "--disable-background-networking",
    `--disk-cache-size=${100 * 1024 * 1024}`,
    "--window-position=0,0",
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    "--start-maximized",
    "about:blank",
  ]))
}

// ── Real services ──────────────────────────────────────────────────────────────────────────────────────────────────

class Agent implements AgentControl {
  private child: ChildProcess | undefined
  private readonly listeners: (() => void)[] = []

  constructor(
    private readonly args: BootArgs,
    private readonly procs: ProcTable,
    private readonly touch: () => void,
  ) {}

  pid() {
    return this.child?.pid
  }

  async start(job: Job) {
    if (this.child) return
    const [file, ...rest] = agentCommand(job)
    const log = createWriteStream(path.join(LOG_DIR, "agent.log"), { flags: "a", mode: 0o600 })
    const child = spawn(file!, rest, {
      cwd: WORK_DIR,
      env: agentEnv(this.args),
      // Its own process group, so a wrap-up reaches everything it started that stayed in the group.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child
    let logged = 0
    const write = (chunk: Buffer) => {
      this.touch()
      if (logged < 8 * 1024 * 1024) {
        logged += chunk.length
        log.write(chunk)
      }
    }
    child.stdout?.on("data", write)
    child.stderr?.on("data", write)
    log.on("error", () => {})
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      this.child = undefined
      log.end()
      for (const listener of this.listeners) listener()
    }
    // An agent that cannot start ends the job the same way as one that finished.
    child.on("error", end)
    child.on("exit", end)
  }

  running() {
    return this.child !== undefined
  }
  async pause() {
    await stopAll(this.procs, AGENT_UID)
  }
  async resume() {
    await continueAll(this.procs, AGENT_UID)
  }
  ask() {
    const pid = this.child?.pid
    if (pid) {
      try {
        process.kill(-pid, "SIGCONT")
        process.kill(-pid, "SIGTERM")
      } catch {}
    }
  }
  async kill() {
    this.ask()
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS))
    await killAll(this.procs, AGENT_UID)
  }
  onExit(listener: () => void) {
    this.listeners.push(listener)
  }
}

class Browser implements BrowserControl {
  private child: ChildProcess | undefined
  private guard: BrowserGuard | undefined
  private loads = 0

  constructor(private readonly guardSource: string) {}

  /** What the computer asks before an action: see guardView (no browser, its guard, or a guard that is down). */
  current() {
    return guardView(this.child !== undefined, this.guard)
  }

  async start() {
    if (this.child) return
    const [file, ...rest] = browserCommand()
    const paths = browserPaths()
    const child = spawn(file!, rest, {
      env: { DISPLAY, XAUTHORITY, HOME: paths.home, LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    })
    this.child = child
    const toBrowser = child.stdio[3] as NodeJS.WritableStream
    const fromBrowser = child.stdio[4] as NodeJS.ReadableStream
    const pipe = new CdpPipe((chunk) => toBrowser.write(chunk))
    fromBrowser.on("data", (chunk: Buffer) => pipe.feed(chunk))
    toBrowser.on("error", () => {})
    fromBrowser.on("error", () => {})
    const guard = new BrowserGuard(pipe, this.guardSource)
    const gone = () => {
      if (this.child !== child) return
      if (this.guard) this.loads += this.guard.pageLoads()
      this.guard = undefined
      this.child = undefined
      pipe.close()
    }
    child.on("error", gone)
    child.on("exit", gone)
    try {
      await guard.start()
    } catch (error) {
      // The guard could not take hold of the browser, so the browser is not left running without it (until it has
      // exited, guardView refuses typing). The daemon starts it again on a later heartbeat.
      child.kill("SIGKILL")
      throw error
    }
    if (this.child === child) this.guard = guard
  }

  async stop() {
    const child = this.child
    if (!child) return
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, KILL_GRACE_MS)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  running() {
    return this.child !== undefined
  }

  pageLoads() {
    return this.loads + (this.guard?.pageLoads() ?? 0)
  }
}

/** The bytes the agent, browser and git users sent, from the firewall's counter (image/nftables.conf). */
export function parseEgressCounter(json: string): number | undefined {
  try {
    const items = (JSON.parse(json) as { nftables?: { counter?: { name?: string; bytes?: number } }[] }).nftables ?? []
    const counter = items.find((item) => item.counter?.name === "egress")?.counter
    return typeof counter?.bytes === "number" && Number.isSafeInteger(counter.bytes) ? counter.bytes : undefined
  } catch {
    return undefined
  }
}

/** The processor's busy share since the last reading, from /proc/stat. */
export function cpuReader(read: () => string = () => readFileSync("/proc/stat", "utf8")) {
  let last: { busy: number; total: number } | undefined
  return () => {
    let line: string
    try {
      line = read().split("\n")[0] ?? ""
    } catch {
      return undefined
    }
    const fields = line.trim().split(/\s+/).slice(1).map(Number)
    if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return undefined
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0)
    const total = fields.reduce((sum, value) => sum + value, 0)
    const busy = total - idle
    const previous = last
    last = { busy, total }
    if (!previous || total <= previous.total) return undefined
    return Math.max(0, Math.min(100, Math.round(((busy - previous.busy) / (total - previous.total)) * 100)))
  }
}

/** Packs the agent's work (read as the agent, so nothing it cannot read is packed) into root's pack folder. */
export async function packWork(maxBytes = 5 * 1024 ** 3): Promise<{ file: string; bytes: number }> {
  await mkdir(PACK_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(PACK_DIR, "files.tar.gz")
  await rm(file, { force: true })
  const [setpriv, ...rest] = dropTo(AGENT_UID, AGENT_UID, [], [BINARIES.tar, "-C", WORK_DIR, "--exclude=./.vector-push-*", "-czf", "-", "."])
  const child = spawn(setpriv!, rest, { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] })
  const out = createWriteStream(file, { mode: 0o600 })
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        child.kill("SIGKILL")
        reject(new Error("too large"))
      }
    })
    child.stdout!.pipe(out)
    out.on("error", reject)
    child.on("error", reject)
    child.on("close", (code) => (code === 0 && bytes <= maxBytes ? resolve() : reject(new Error("tar failed"))))
  }).catch(async (error) => {
    await rm(file, { force: true })
    throw error
  })
  await new Promise<void>((resolve) => out.end(resolve))
  return { file, bytes }
}

/** Writes the viewer proxy's state atomically, readable by the viewer user only. */
async function writeViewerState(state: { session: string; key: string; control: "agent" | "person" }) {
  const file = VIEWER_STATE
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify({ ...state, updatedAt: Date.now() }), { mode: 0o640 })
  await chown(temp, 0, VIEWER_UID)
  await rename(temp, file)
}

/** Tokens for git come from the run-API host, per operation (the provider adds the run token on the way). */
function tokenSource(api: { transport: Transport; runHost: string; session: string }): TokenSource {
  return async (repository: Repository, access: Access) => {
    checkRepository(repository)
    const body = Buffer.from(JSON.stringify({ repository, access }))
    const answer = await api.transport({
      method: "POST",
      host: api.runHost,
      path: `/api/hosted/sessions/${api.session}/git-token`,
      headers: { "content-type": "application/json", accept: "application/json", "content-length": String(body.length) },
      body,
      timeoutMs: 15_000,
    })
    if (answer.status !== 200) throw new GitError("Vector did not hand out a token for this repository.")
    return JSON.parse(answer.body.toString("utf8")) as { token: string; expiresAt: number }
  }
}

// ── The agent's socket ─────────────────────────────────────────────────────────────────────────────────────────────

export type ApiDeps = {
  computer: Pick<Computer, "execute">
  tools: Pick<ToolCalls, "begin" | "end">
  git: Pick<HostGit, "clone" | "fetch" | "push">
  daemon: Pick<Daemon, "acting" | "status" | "touch">
}

async function body(request: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > max) throw new Error("too large")
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function send(response: ServerResponse, status: number, value: unknown) {
  const text = JSON.stringify(value)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text)
}

/** The agent's API (see the top of this file). */
export function createAgentApi(deps: ApiDeps): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://hostd")
      if (request.method === "GET" && url.pathname === "/v1/status") return send(response, 200, deps.daemon.status())
      if (request.method !== "POST") return send(response, 405, { ok: false, message: "Use POST." })
      const input = (await body(request)) as Record<string, unknown>
      deps.daemon.touch()
      if (url.pathname === "/v1/computer") {
        if (input.v !== PROTOCOL) return send(response, 400, { ok: false, code: "failed", message: "Unknown protocol version." })
        const format: ImageFormat = input.format === "webp" ? "webp" : "jpeg"
        let parsed
        try {
          parsed = parseToolInput(input.input)
        } catch (error) {
          return send(response, 400, { ok: false, code: "failed", message: (error as Error).message })
        }
        return send(response, 200, await deps.computer.execute(parsed, format))
      }
      if (url.pathname === "/v1/tool") {
        const id = typeof input.id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(input.id) ? input.id : undefined
        if (!id) return send(response, 400, { ok: false, message: "A tool call needs an id." })
        if (input.phase === "begin") {
          const pgid = typeof input.pgid === "number" && Number.isSafeInteger(input.pgid) && input.pgid > 1 ? input.pgid : undefined
          await deps.tools.begin(id, pgid)
          return send(response, 200, { ok: true })
        }
        if (input.phase === "end") return send(response, 200, { ok: true, killed: await deps.tools.end(id) })
        return send(response, 400, { ok: false, message: "phase must be begin or end." })
      }
      if (url.pathname === "/v1/git") {
        if (!deps.daemon.acting()) return send(response, 409, { ok: false, message: "The agent is not working right now." })
        const repository = input.repository as Repository
        const directory = typeof input.directory === "string" ? input.directory : ""
        try {
          checkRepository(repository ?? { owner: "", name: "" })
          if (input.op === "clone") return send(response, 200, { ok: true, path: await deps.git.clone(repository, directory) })
          if (input.op === "fetch") {
            await deps.git.fetch(repository, directory)
            return send(response, 200, { ok: true })
          }
          if (input.op === "push" && typeof input.branch === "string") {
            await deps.git.push(repository, directory, input.branch)
            return send(response, 200, { ok: true })
          }
          return send(response, 400, { ok: false, message: "op must be clone, fetch or push (with a branch)." })
        } catch (error) {
          return send(response, 200, { ok: false, message: error instanceof GitError ? error.message : "git could not finish." })
        }
      }
      return send(response, 404, { ok: false, message: "Not found." })
    } catch {
      return send(response, 400, { ok: false, message: "The request could not be read." })
    }
  })
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function readGeneration() {
  try {
    const value = Number(readFileSync(GENERATION_FILE, "utf8").trim())
    return Number.isSafeInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function guardSource() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const file of [path.join(here, "credential-guard.js"), path.join(here, "..", "image", "credential-guard.js")]) {
    try {
      return readFileSync(file, "utf8")
    } catch {}
  }
  throw new Error("credential-guard.js is missing")
}

export async function main(argv: readonly string[], transport: Transport = httpsTransport, run: Runner = runProgram) {
  const args = parseArgs(argv)
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} hostd: ${line}\n`)
  const procs = linuxProcs
  await mkdir(path.dirname(HOSTD_SOCKET), { recursive: true })
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })
  const recordings = path.join(RECORDINGS_DIR, args.session)
  await mkdir(recordings, { recursive: true, mode: 0o750 })
  // The recorder runs as the display user.
  await chown(recordings, DISPLAY_UID, 0)

  const api = new RunApi(args.runHost, args.session, transport, `vector-hostd/${readGeneration()}`)
  let daemon!: Daemon
  const touch = () => daemon?.touch()
  const agent = new Agent(args, procs, touch)
  const browser = new Browser(guardSource())
  const recorder = new Recorder(recordings)
  const cpu = cpuReader()
  daemon = new Daemon({
    session: args.session,
    generation: readGeneration(),
    api,
    upload: (link, file) => api.upload(link, file),
    agent,
    browser,
    recorder,
    recording: {
      segments: async () =>
        (await recorder.segments()).map((segment) => ({
          number: segment.number,
          bytes: segment.bytes,
          file: path.join(recordings, segment.name),
        })),
      settled: () => recorder.settled(),
      upload: (link, file) => api.upload(link, file),
    },
    wipe: async () => {
      await wipeBrowser()
    },
    viewer: writeViewerState,
    pack: () => packWork(),
    discard: (file) => unlink(file),
    metrics: {
      cpu,
      egressBytes: async () => {
        const result = await run(BINARIES.nft, ["-j", "list", "counter", "inet", "vector", "egress"], { timeoutMs: 5_000 })
        return result.code === 0 ? parseEgressCounter(result.stdout.toString("utf8")) : undefined
      },
    },
    log,
  })
  const handoff = (reason: HandoffReason) =>
    daemon.handOff(Hosted.HANDOFFS.find((value) => value === reason) ?? "other")
  const computer = new Computer({
    run,
    guard: () => browser.current(),
    paused: () => !daemon.acting(),
    activity: (at) => daemon.touch(at),
    handoff,
  })
  const tools = new ToolCalls(procs, AGENT_UID, () => agent.pid())
  const git = new HostGit({
    run,
    tokens: tokenSource({ transport, runHost: args.runHost, session: args.session }),
    pauseAgent: async () => {
      await stopAll(procs, AGENT_UID)
      return async () => {
        if (daemon.acting()) await continueAll(procs, AGENT_UID)
      }
    },
  })

  await mkdir(DOWNLOADS_DIR, { recursive: true, mode: 0o2770 }).catch(() => {})
  await chown(DOWNLOADS_DIR, AGENT_UID, SHARE_GID).catch(() => {})
  await rm(HOSTD_SOCKET, { force: true })
  const server = createAgentApi({ computer, tools, git, daemon })
  await new Promise<void>((resolve) => server.listen(HOSTD_SOCKET, resolve))
  await chown(HOSTD_SOCKET, 0, AGENT_UID)
  await chmod(HOSTD_SOCKET, 0o660)

  const loop = async () => {
    await daemon.tick()
    setTimeout(loop, Hosted.HEARTBEAT_MS)
  }
  setInterval(() => void recorder.prune(), 60_000).unref()
  log(`started for ${args.session}`)
  await loop()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hostd: ${(error as Error).message}\n`)
    process.exit(1)
  })

// What the image's own checks (test/docker/in-image.mjs) use from the bundle.
export { BrowserGuard, CdpPipe } from "./guard"
export { wipeBrowser } from "./wipe"
