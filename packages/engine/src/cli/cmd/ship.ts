import type { Argv } from "yargs"
import { spawn } from "node:child_process"
import { constants as fsConstants, existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { ShipDesk } from "@vectordevai/schema/ship-desk"
import { cmd } from "./cmd"
import { UI } from "../ui"

// `vector ship capture --pr <n>` (contract WP A49): Ship Desk's before/after screenshots of a pull request from a Codium
// run of Vector's GitHub agent. It runs in its own job of the person's workflow, after the run published its pull
// request, holding only a capture ticket (VECTOR_CAPTURE_TICKET): no `id-token` and no run token, because this job runs
// the repository's own code (install, build, start) to take the screenshots. The ticket names one run, so one pull
// request, and uploads at most 8 PNG files inside a 15-minute window, straight to storage through links vectordev.ai
// signs; the server checks each file before the card shows it.
//
// What runs comes from `.vector/ship.json` on the pull request's base commit, never from the pull request itself:
// `{install?, build?, start, port, routes[]}`. Each route is shot on the base commit (before, in a temporary worktree)
// and on the pull request's head (after, in the checkout), with the browser already on GitHub's runners (Chrome), and the
// app is stopped after each. Connections: vectordev.ai's capture API, the signed storage links and the app on this
// computer, all labelled ship-desk.
//
// `vector ship ticket` asks for the ticket with the run's own token, in the job that minted that token, before the
// repository is checked out, and hands it to the capture job as the job's `capture` output.
//
// It runs under Node; it never needs a Vector account.

/** Ship Desk's requests (the capture API, its signed links, the app on 127.0.0.1), labelled ship-desk. */
export const send = (url: string, init: RequestInit) => Egress.fetch("ship-desk", url, init)

export const CAPTURE_LIMITS = {
  installMs: 15 * 60_000,
  buildMs: 15 * 60_000,
  /** How long the app may take to answer on its port. */
  readyMs: 3 * 60_000,
  /** One screenshot. */
  shotMs: 60_000,
  /** How long to wait for the card while the pull request's event reaches vectordev.ai. */
  cardWaitMs: 2 * 60_000,
  viewport: { width: 1280, height: 800 },
  requestMs: 30_000,
} as const

export class ShipError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/**
 * Why this job must not capture, or undefined when it may: the job can mint GitHub OIDC tokens (`id-token: write`), or
 * holds a run token or a Vector account token. The capture job runs the repository's code, which could read any of them.
 */
export function captureEnvironmentProblem(
  env: Record<string, string | undefined>,
  exists: (file: string) => boolean,
): string | undefined {
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL || env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    return "This job can mint GitHub OIDC tokens. Run Ship Desk's capture in a job without id-token: write."
  if (env.RUNNER_TEMP && exists(path.join(env.RUNNER_TEMP, "vector-secrets", "run-token")))
    return "This job holds a Vector run token. Run Ship Desk's capture in its own job."
  if (env.VECTOR_CLI_TOKEN)
    return "This job holds VECTOR_CLI_TOKEN. Ship Desk's capture job holds only its capture ticket."
  return undefined
}

/** The environment the repository's commands run with: Vector's tickets, tokens and secrets taken out. */
export function childEnvironment(env: Record<string, string | undefined>) {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^ACTIONS_ID_TOKEN_REQUEST_/.test(name)) continue
    if (/^VECTOR_/.test(name) && /(TICKET|TOKEN|SECRET|KEY)/.test(name)) continue
    out[name] = value
  }
  return out
}

// ── The capture API ────────────────────────────────────────────────────────────────────────────────────────────────

export type Send = (url: string, init: RequestInit) => Promise<Response>

export type CaptureApi = {
  card(pr: number): Promise<ShipDesk.CardAnswer>
  start(pr: number, files: ShipDesk.CaptureFile[]): Promise<ShipDesk.StartAnswer>
  finish(pr: number, capture: string): Promise<ShipDesk.FinishAnswer>
  put(upload: ShipDesk.StartAnswer["uploads"][number], bytes: Uint8Array): Promise<void>
}

/** The site the ticket was issued by: VECTOR_SITE_URL or vectordev.ai, `https:` (plain http only for this computer). */
export function siteOrigin(value: string | undefined) {
  const url = new URL(value?.trim() || "https://vectordev.ai")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new ShipError("VECTOR_SITE_URL must be an https address.")
  return url.origin
}

export function captureApi(input: { site: string; ticket: string; send?: Send }): CaptureApi {
  const sender = input.send ?? send
  const post = async <T>(body: Record<string, unknown>): Promise<T> => {
    let response: Response
    try {
      response = await sender(`${input.site}/api/ops/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.ticket}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(CAPTURE_LIMITS.requestMs),
      })
    } catch {
      throw new ShipError("vectordev.ai could not be reached.")
    }
    const text = await response.text().catch(() => "")
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown; retryAfterMs?: unknown } } | undefined)
        ?.error
      throw new ShipError(
        typeof error?.message === "string" ? error.message : `vectordev.ai answered ${response.status}.`,
        typeof error?.code === "string" ? error.code : undefined,
        response.status,
        typeof error?.retryAfterMs === "number" ? error.retryAfterMs : undefined,
      )
    }
    if (!parsed || typeof parsed !== "object") throw new ShipError("vectordev.ai answered something unexpected.")
    return parsed as T
  }
  return {
    card: (pr) => post({ action: "card", pr }),
    start: (pr, files) => post({ action: "start", pr, files }),
    finish: (pr, capture) => post({ action: "finish", pr, capture }),
    async put(upload, bytes) {
      const target = new URL(upload.url)
      if (target.protocol !== "https:") throw new ShipError("The upload link is not an https address.")
      if (
        upload.headers["content-length"] !== undefined &&
        upload.headers["content-length"] !== String(bytes.byteLength)
      )
        throw new ShipError("A screenshot changed size before its upload.")
      let response: Response
      try {
        response = await sender(upload.url, {
          method: "PUT",
          // fetch sends the body's own length, which is the size the link signed; the other signed headers go as given.
          headers: Object.fromEntries(
            Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
          ),
          body: new Blob([new Uint8Array(bytes)]),
          redirect: "error",
          signal: AbortSignal.timeout(CAPTURE_LIMITS.requestMs * 2),
        })
      } catch {
        throw new ShipError("A screenshot could not be uploaded.")
      }
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) throw new ShipError(`A screenshot upload was refused (${response.status}).`)
    },
  }
}

// ── Processes ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Started = { stop(): Promise<void>; exited: Promise<number> }

/** Everything the capture does on this computer; tests replace it. */
export type Runner = {
  /** Runs a shell command to the end; its exit code, or -1 when it ran out of time. */
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<number>
  /** Starts the app's shell command in its own process group. */
  start(command: string, cwd: string, env: Record<string, string>): Started
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>
  /** Whether something answers HTTP on 127.0.0.1:<port>. */
  answers(port: number): Promise<boolean>
  /** Shoots `url` into `file` (PNG). */
  shoot(url: string, file: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

function startShell(command: string, cwd: string, env: Record<string, string>): Started {
  const child = spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "inherit", "inherit"] })
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? -1))
    child.once("error", () => resolve(-1))
  })
  return {
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      killGroup(child.pid, "SIGTERM")
      const done = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
      ])
      if (!done) killGroup(child.pid, "SIGKILL")
    },
  }
}

/** The browser to shoot with: `--chrome`, CHROME_PATH, or Chrome or Chromium on PATH (as on GitHub's runners). */
export async function findChrome(explicit: string | undefined, env: Record<string, string | undefined>) {
  const candidates = explicit
    ? [explicit]
    : env.CHROME_PATH
      ? [env.CHROME_PATH]
      : [
          ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) =>
            (env.PATH ?? "")
              .split(path.delimiter)
              .filter(Boolean)
              .map((dir) => path.join(dir, name)),
          ),
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
  for (const file of candidates) {
    if (
      await fs.access(file, fsConstants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return file
  }
  return undefined
}

export function nodeRunner(input: { chrome: string; sandbox: boolean; profile: string }): Runner {
  return {
    async run(command, cwd, env, timeoutMs) {
      const started = startShell(command, cwd, env)
      const timer = new Promise<number>((resolve) => setTimeout(() => resolve(-1), timeoutMs).unref())
      const code = await Promise.race([started.exited, timer])
      if (code === -1) await started.stop()
      return code
    },
    start: startShell,
    git(args, cwd) {
      return new Promise((resolve) => {
        const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
        const chunks: Buffer[] = []
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
        child.once("error", () => resolve({ code: -1, stdout: "" }))
        child.once("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }))
      })
    },
    async answers(port) {
      const response = await send(`http://127.0.0.1:${port}/`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined)
      await response?.body?.cancel().catch(() => undefined)
      return response !== undefined
    },
    shoot(url, file) {
      return new Promise((resolve) => {
        const args = [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          `--user-data-dir=${input.profile}`,
          `--window-size=${CAPTURE_LIMITS.viewport.width},${CAPTURE_LIMITS.viewport.height}`,
          "--virtual-time-budget=8000",
          `--screenshot=${file}`,
          ...(input.sandbox ? [] : ["--no-sandbox"]),
          url,
        ]
        const child = spawn(input.chrome, args, { stdio: "ignore", detached: true })
        const timer = setTimeout(() => killGroup(child.pid, "SIGKILL"), CAPTURE_LIMITS.shotMs)
        child.once("error", () => {
          clearTimeout(timer)
          resolve(false)
        })
        child.once("exit", (code) => {
          clearTimeout(timer)
          resolve(code === 0)
        })
      })
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

// ── The capture ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Shot = { slot: ShipDesk.Slot; route: string; file: string; bytes: Uint8Array }

export type CaptureResult =
  | { kind: "uploaded"; images: number; refused: ShipDesk.FinishAnswer["refused"]; shots: Shot[] }
  | { kind: "skipped"; reason: string }

async function cardWhenReady(api: CaptureApi, pr: number, runner: Runner) {
  const deadline = Date.now() + CAPTURE_LIMITS.cardWaitMs
  for (;;) {
    try {
      return await api.card(pr)
    } catch (error) {
      if (!(error instanceof ShipError) || error.code !== "SHIP_DESK_CARD_PENDING" || Date.now() >= deadline)
        throw error
      await runner.sleep(Math.min(Math.max(error.retryAfterMs ?? 10_000, 1_000), 15_000))
    }
  }
}

async function shootSlot(input: {
  slot: ShipDesk.Slot
  cwd: string
  ship: ShipDesk.ShipJson
  routes: string[]
  out: string
  runner: Runner
  log: (line: string) => void
}): Promise<Shot[]> {
  const { runner, ship, log } = input
  const env = { ...childEnvironment(process.env), PORT: String(ship.port) }
  for (const [name, command, limit] of [
    ["install", ship.install, CAPTURE_LIMITS.installMs],
    ["build", ship.build, CAPTURE_LIMITS.buildMs],
  ] as const) {
    if (!command) continue
    log(`${input.slot}: ${name}`)
    const code = await runner.run(command, input.cwd, env, limit)
    if (code !== 0) throw new ShipError(`${input.slot}: ${name} ${code === -1 ? "ran out of time" : `exited ${code}`}.`)
  }
  log(`${input.slot}: starting the app on port ${ship.port}`)
  const app = runner.start(ship.start, input.cwd, env)
  let exited = false
  void app.exited.then(() => {
    exited = true
  })
  try {
    const deadline = Date.now() + CAPTURE_LIMITS.readyMs
    while (!(await runner.answers(ship.port))) {
      if (exited) throw new ShipError(`${input.slot}: the app stopped before it answered on port ${ship.port}.`)
      if (Date.now() >= deadline) throw new ShipError(`${input.slot}: the app did not answer on port ${ship.port}.`)
      await runner.sleep(1_000)
    }
    const shots: Shot[] = []
    for (const [index, route] of input.routes.entries()) {
      const file = path.join(input.out, `${input.slot}-${index + 1}.png`)
      if (!(await runner.shoot(`http://127.0.0.1:${ship.port}${route}`, file))) {
        log(`${input.slot}: ${route} could not be shot`)
        continue
      }
      const bytes = new Uint8Array(await fs.readFile(file).catch(() => Buffer.alloc(0)))
      const image = ShipDesk.sniffImage(bytes.subarray(0, 64))
      if (!image || image.type !== "image/png" || bytes.byteLength > ShipDesk.LIMITS.imageBytes) {
        log(`${input.slot}: ${route} gave no usable PNG (at most 5 MB)`)
        continue
      }
      shots.push({ slot: input.slot, route, file, bytes })
    }
    return shots
  } finally {
    await app.stop()
  }
}

/**
 * The whole capture: the card (waiting while the pull request's event reaches vectordev.ai), the checkout checked to be
 * the pull request's head, `.vector/ship.json` from the base commit, the before and after screenshots, then one start,
 * the uploads and one finish inside the ticket's window. Nothing to capture is a skip, not a failure.
 */
export async function captureShots(input: {
  pr: number
  dir: string
  api: CaptureApi
  runner: Runner
  work: string
  log?: (line: string) => void
}): Promise<CaptureResult> {
  const { api, runner, pr } = input
  const log = input.log ?? (() => {})
  const card = await cardWhenReady(api, pr, runner)
  const head = (await runner.git(["rev-parse", "HEAD"], input.dir)).stdout.trim()
  if (head !== card.headSha)
    throw new ShipError(`Check out the pull request's head commit (${card.headSha.slice(0, 7)}) before capturing.`)
  if (!card.baseSha || (await runner.git(["cat-file", "-e", `${card.baseSha}^{commit}`], input.dir)).code !== 0)
    return { kind: "skipped", reason: "The base commit is not in this checkout. Check out with fetch-depth: 0." }
  const config = await runner.git(["show", `${card.baseSha}:.vector/ship.json`], input.dir)
  if (config.code !== 0) return { kind: "skipped", reason: "The base branch has no .vector/ship.json." }
  const ship = ShipDesk.parseShipJson(config.stdout)
  if (!ship) return { kind: "skipped", reason: "The base branch's .vector/ship.json is not valid." }
  const routes = ship.routes.slice(0, Math.max(1, Math.floor(card.files / 2)))

  const shots: Shot[] = []
  const before = path.join(input.work, "before")
  const added = await runner.git(["worktree", "add", "--detach", before, card.baseSha], input.dir)
  if (added.code === 0) {
    try {
      shots.push(...(await shootSlot({ slot: "before", cwd: before, ship, routes, out: input.work, runner, log })))
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    } finally {
      await runner.git(["worktree", "remove", "--force", before], input.dir)
    }
  } else log("before: the base commit could not be checked out")
  try {
    shots.push(...(await shootSlot({ slot: "after", cwd: input.dir, ship, routes, out: input.work, runner, log })))
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
  }
  const files = shots.slice(0, card.files)
  if (!files.length) return { kind: "skipped", reason: "No screenshot could be taken." }

  const started = await api.start(
    pr,
    files.map((shot) => ({
      slot: shot.slot,
      route: shot.route,
      bytes: shot.bytes.byteLength,
      type: "image/png" as const,
    })),
  )
  for (const upload of started.uploads) {
    const shot = files[upload.n - 1]
    if (shot) await api.put(upload, shot.bytes)
  }
  const finished = await api.finish(pr, started.capture)
  return { kind: "uploaded", images: finished.images, refused: finished.refused, shots: files }
}

// ── The ticket ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where Vector's GitHub agent keeps its run token in the job that minted it (directory 0700, file 0600). */
export function runTokenFile(env: Record<string, string | undefined>) {
  return env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, "vector-secrets", "run-token") : undefined
}

export type TicketResult = { kind: "ticket"; ticket: string; expiresAt: number } | { kind: "none"; reason: string }

/**
 * Asks vectordev.ai for a capture ticket with the run's own token. Run it in the job that holds the run token, before
 * the repository is checked out; the capture job then gets the ticket and nothing else. A refusal (Ship Desk off for
 * the repository, a plan without it, the service paused) is not a failure: there is simply nothing to capture.
 */
export async function requestTicket(input: { site: string; token: string; send?: Send }): Promise<TicketResult> {
  const sender = input.send ?? send
  if (!/^vrt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)) return { kind: "none", reason: "No run token." }
  let response: Response
  try {
    response = await sender(`${input.site}/api/ops/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "ticket" }),
      redirect: "error",
      signal: AbortSignal.timeout(CAPTURE_LIMITS.requestMs),
    })
  } catch {
    return { kind: "none", reason: "vectordev.ai could not be reached." }
  }
  const body = (await response.json().catch(() => undefined)) as
    | { ticket?: unknown; expiresAt?: unknown; error?: { message?: unknown } }
    | undefined
  if (response.ok && typeof body?.ticket === "string" && ShipDesk.TICKET.test(body.ticket))
    return { kind: "ticket", ticket: body.ticket, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : 0 }
  return {
    kind: "none",
    reason: typeof body?.error?.message === "string" ? body.error.message : `vectordev.ai answered ${response.status}.`,
  }
}

const ShipTicketCommand = cmd({
  command: "ticket",
  describe: "ask for a Ship Desk capture ticket with the run's own token (in the job that minted it)",
  builder: (yargs: Argv) =>
    yargs.option("token-file", {
      type: "string",
      describe: "the run token's file (default: $RUNNER_TEMP/vector-secrets/run-token)",
    }),
  async handler(args) {
    const file = typeof args["token-file"] === "string" ? args["token-file"] : runTokenFile(process.env)
    const token = file ? (await fs.readFile(file, "utf8").catch(() => "")).trim() : ""
    let site: string
    try {
      site = siteOrigin(process.env.VECTOR_SITE_URL)
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }
    const result = await requestTicket({ site, token })
    if (result.kind === "none") {
      UI.println(`Ship Desk: no capture ticket. ${result.reason}`)
      return
    }
    // The ticket goes to the capture job as this job's output. It is not masked (GitHub drops a masked output): it can
    // only add screenshots to this run's own card for 15 minutes, and the capture job's own code can read it anyway.
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `capture=${result.ticket}\n`)
    else UI.println(result.ticket)
    UI.println("Ship Desk: capture ticket ready.")
  },
})

// ── The command ────────────────────────────────────────────────────────────────────────────────────────────────────

const ShipCaptureCommand = cmd({
  command: "capture",
  describe: "take Ship Desk's before and after screenshots of a pull request (a GitHub Actions job)",
  builder: (yargs: Argv) =>
    yargs
      .option("pr", { type: "number", demandOption: true, describe: "the pull request's number" })
      .option("ticket", { type: "string", describe: "the capture ticket (default: VECTOR_CAPTURE_TICKET)" })
      .option("chrome", {
        type: "string",
        describe: "the browser to shoot with (default: CHROME_PATH, or Chrome on PATH)",
      })
      .option("sandbox", {
        type: "boolean",
        default: true,
        describe: "keep the browser's sandbox (--no-sandbox to turn it off)",
      })
      .option("keep", { type: "string", describe: "also copy the screenshots into this folder" }),
  async handler(args) {
    const pr = Number(args.pr)
    try {
      if (process.platform === "win32") throw new ShipError("Ship Desk's capture runs on Linux or macOS.")
      if (!Number.isSafeInteger(pr) || pr < 1) throw new ShipError("Name the pull request with --pr <number>.")
      const problem = captureEnvironmentProblem(process.env, existsSync)
      if (problem) throw new ShipError(problem)
      const ticket = (typeof args.ticket === "string" ? args.ticket : process.env.VECTOR_CAPTURE_TICKET)?.trim() ?? ""
      if (!ShipDesk.TICKET.test(ticket)) throw new ShipError("Set VECTOR_CAPTURE_TICKET to the run's capture ticket.")
      delete process.env.VECTOR_CAPTURE_TICKET
      const chrome = await findChrome(typeof args.chrome === "string" ? args.chrome : undefined, process.env)
      if (!chrome) throw new ShipError("No Chrome or Chromium was found. Set CHROME_PATH or pass --chrome.")
      const work = await fs.mkdtemp(path.join(os.tmpdir(), "vector-ship-"))
      try {
        const result = await captureShots({
          pr,
          dir: process.cwd(),
          api: captureApi({ site: siteOrigin(process.env.VECTOR_SITE_URL), ticket }),
          runner: nodeRunner({ chrome, sandbox: args.sandbox !== false, profile: path.join(work, "profile") }),
          work,
          log: (line) => UI.println(UI.Style.TEXT_DIM + line + UI.Style.TEXT_NORMAL),
        })
        if (result.kind === "skipped") {
          UI.println(`Ship Desk: nothing captured. ${result.reason}`)
          return
        }
        if (typeof args.keep === "string") {
          await fs.mkdir(args.keep, { recursive: true })
          for (const shot of result.shots) await fs.copyFile(shot.file, path.join(args.keep, path.basename(shot.file)))
        }
        UI.println(
          `Ship Desk: ${result.images} screenshot${result.images === 1 ? "" : "s"} added to the card` +
            (result.refused.length ? `; ${result.refused.length} refused` : "") +
            ".",
        )
      } finally {
        await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})

/** `vector ship`: hidden from help, because Ship Desk is shown only once it is listed (H1). */
export const ShipCommand = cmd({
  command: "ship",
  describe: false,
  builder: (yargs: Argv) => yargs.command(ShipCaptureCommand).command(ShipTicketCommand).demandCommand(),
  async handler() {},
})
