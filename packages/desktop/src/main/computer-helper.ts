import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { release } from "node:os"
import path from "node:path"
import { type Duplex } from "node:stream"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerError } from "./computer-bridge"
import { encodeFrame, FrameDecoder } from "./computer-protocol"

/** Availability reasons are distinct from wire error codes. D21 keeps this reason for onboarding. */
export class HelperUnavailableError extends ComputerError {
  constructor(
    readonly reason: "helper_missing",
    message: string,
  ) {
    super("unavailable", message)
  }
}

export interface HelperClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const clock: HelperClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface HelperChannel {
  write(bytes: Uint8Array): void
  end(): void
  kill(): void
  onData(cb: (bytes: Uint8Array) => void): () => void
  onExit(cb: (event: { code?: number; signal?: string }) => void): () => void
}

export interface HelperClient {
  request<T>(op: Computer.HelperOpName, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  onEvent(cb: (event: Computer.HelperEvent) => void): () => void
  close(): Promise<void>
}

type Pending = {
  op: Computer.HelperOpName
  timer: unknown
  resolve(value: unknown): void
  reject(error: ComputerError): void
}

/** One framed channel, also usable with the in-process fake. No OS work occurs here. */
export function createHelperClient(
  channel: HelperChannel,
  options: { clock?: HelperClock; onTimeout?: (op: Computer.HelperOpName, id: number) => void } = {},
): HelperClient {
  const time = options.clock ?? clock
  const pending = new Map<number, Pending>()
  const listeners = new Set<(event: Computer.HelperEvent) => void>()
  const state = { next: 1, closed: false, recovering: false, closing: false, killed: false }
  const cleanups: (() => void)[] = []

  function kill() {
    if (state.killed) return
    state.killed = true
    channel.kill()
  }

  function finish(error: ComputerError, event?: Computer.HelperEvent) {
    if (state.closed) return
    state.closed = true
    for (const cleanup of cleanups.splice(0)) cleanup()
    for (const entry of pending.values()) {
      time.clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    if (event) for (const listener of listeners) listener(event)
  }

  function fail(code: Computer.ComputerErrorCode, message: string) {
    finish(new ComputerError(code, message), { event: "exit" })
    kill()
  }

  function answer(value: unknown, image?: Uint8Array) {
    if (state.closed) return
    if (!value || typeof value !== "object") return fail("failed", "The helper returned an invalid message.")
    if (!("id" in value)) {
      const event = Schema.decodeUnknownOption(Computer.HelperEvent)(value)
      if (Option.isNone(event) || event.value.event === "exit")
        return fail("failed", "The helper returned an invalid event.")
      for (const listener of listeners) listener(event.value)
      return
    }
    if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0 || (value.id as number) >= state.next)
      return fail("failed", "The helper returned an invalid request id.")
    const id = value.id as number
    const entry = pending.get(id)
    // A reply to a timed-out/cancelled request can arrive after cleanup. IDs are never reused.
    if (!entry) return
    if (
      entry.op === "input.setup" &&
      Object.keys(value).some(
        (key) =>
          !(
            "ok" in value && value.ok === false
              ? ["id", "ok", "code", "error"]
              : ["id", "ok", "state", "mouse", "keyboard"]
          ).includes(key),
      )
    )
      return fail("failed", "The helper returned an invalid input setup response.")
    const failure = Schema.decodeUnknownOption(Computer.HelperFailure)(value)
    if (Option.isSome(failure)) {
      pending.delete(id)
      time.clearTimeout(entry.timer)
      entry.reject(new ComputerError(failure.value.code, failure.value.error))
      return
    }
    const response = Schema.decodeUnknownOption(Computer.helperResponse(entry.op))(value)
    if (Option.isNone(response)) return fail("failed", "The helper returned an invalid response.")
    if (entry.op === "capture" && "imageBytes" in response.value && !image)
      return fail("failed", "The helper returned an incomplete image.")
    if (image && entry.op !== "capture") return fail("failed", "The helper returned an unexpected image.")
    const { id: responseId, ok, ...result } = response.value
    pending.delete(id)
    time.clearTimeout(entry.timer)
    entry.resolve(image ? { ...result, bytes: image } : result)
  }

  const decoder = new FrameDecoder({
    onMessage: (value) => answer(value),
    onImage: (header, bytes) => answer(header, bytes),
    onError: fail,
  })
  cleanups.push(channel.onData((bytes) => !state.closed && decoder.push(bytes)))
  cleanups.push(
    channel.onExit((event) => {
      decoder.end()
      kill()
      finish(new HelperUnavailableError("helper_missing", "The computer helper stopped."), { event: "exit", ...event })
    }),
  )

  async function recover(op: Computer.HelperOpName, id: number) {
    options.onTimeout?.(op, id)
    if (state.closed || state.recovering || state.closing) return
    state.recovering = true
    // Send cancel before release; neither is allowed to hold the other up. Both must acknowledge within 2 s.
    const results = await Promise.allSettled([
      request("cancel", { target: id }, 2000, true),
      request("input.releaseAll", {}, 2000, true),
    ])
    state.recovering = false
    if (results.some((result) => result.status === "rejected"))
      fail("timeout", "The computer helper did not release input after a timeout.")
  }

  function request<T>(
    op: Computer.HelperOpName,
    args: Record<string, unknown> = {},
    timeoutMs = op === "capture" ? Computer.LIMITS.captureMs : op === "ui.tree" ? Computer.LIMITS.uiTreeMs : 5000,
    cleanup = false,
  ): Promise<T> {
    if (op === "input.setup" && Object.keys(args).some((key) => key !== "action"))
      return Promise.reject(new ComputerError("failed", "The input setup request is invalid."))
    if (state.closed || (state.closing && !cleanup))
      return Promise.reject(new HelperUnavailableError("helper_missing", "The computer helper is not running."))
    if (state.recovering && !cleanup)
      return Promise.reject(new ComputerError("stopped", "The computer helper is releasing input."))
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
      return Promise.reject(new ComputerError("failed", "The helper deadline is invalid."))
    if (state.next >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(new ComputerError("failed", "The helper request ids were exhausted."))
    const id = state.next++
    const input = Schema.encodeUnknownOption(Computer.helperRequest(op))({ ...args, op, id })
    if (Option.isNone(input)) return Promise.reject(new ComputerError("failed", "The helper request is invalid."))
    return new Promise<T>((resolve, reject) => {
      const timer = time.setTimeout(() => {
        pending.delete(id)
        reject(new ComputerError("timeout", "The computer helper did not answer in time."))
        if (!cleanup && op !== "hello") void recover(op, id)
        if (op === "hello") fail("helper_incompatible", "The computer helper did not answer hello.")
      }, timeoutMs)
      pending.set(id, { op, timer, resolve: (value) => resolve(value as T), reject })
      try {
        channel.write(encodeFrame(input.value))
      } catch {
        fail("unavailable", "The computer helper channel could not be written.")
      }
    })
  }

  return {
    request: (op, args, timeoutMs) =>
      request(op, args, timeoutMs ?? (op.startsWith("input.") ? Computer.LIMITS.inputStepMs : undefined)),
    onEvent(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    async close() {
      if (state.closing || state.closed) return
      state.closing = true
      await request("input.releaseAll", {}, 300, true).catch(() => {})
      await request("shutdown", {}, 300, true).catch(() => {})
      channel.end()
      finish(new ComputerError("stopped", "The computer helper was stopped."))
      kill()
      listeners.clear()
    },
  }
}

type Platform = "darwin" | "win32" | "linux"
type Channel = "dev" | "beta" | "prod"
type Paths = { appPath?: string; resourcesPath?: string; devRoot?: string }

export function helperPath(platform: Platform, channel: Channel, packaged: boolean, paths: Paths = {}) {
  if (platform === "linux") throw new ComputerError("unsupported_os", "Computer use is not supported on this OS.")
  if (!packaged)
    return platform === "darwin"
      ? path.join(paths.devRoot ?? process.cwd(), "native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer")
      : path.join(paths.devRoot ?? process.cwd(), "native/out/win32/vector-computer.exe")
  return platform === "darwin"
    ? path.join(
        paths.appPath ?? path.resolve(path.dirname(process.execPath), "../.."),
        "Contents/Helpers/VectorComputer.app/Contents/MacOS/VectorComputer",
      )
    : path.win32.join(
        paths.resourcesPath ?? path.win32.join(path.win32.dirname(process.execPath), "resources"),
        "computer/vector-computer.exe",
      )
}

/** The override is absent from beta/prod bundles, rather than merely ignored at runtime. */
export function developmentHelperCommand(channel: Channel): string[] | undefined {
  const text =
    typeof import.meta.env !== "undefined" && import.meta.env.VECTOR_CHANNEL === "dev" && channel === "dev"
      ? process.env.VECTOR_COMPUTER_HELPER_COMMAND
      : undefined
  if (!text) return
  const value = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))(text)
  if (
    Option.isNone(value) ||
    value.value.length === 0 ||
    value.value.some((item) => item.includes("\0")) ||
    !value.value[0]
  )
    throw new HelperUnavailableError("helper_missing", "The development helper command is invalid.")
  return [...value.value]
}

type CommandResult = { code: number | null; stdout: string }

function command(argv: readonly string[], timeoutMs = 5000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const chunks: Buffer[] = []
    const state = { size: 0, done: false }
    const finish = (error?: Error, code: number | null = null) => {
      if (state.done) return
      state.done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") })
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new ComputerError("timeout", "The helper check timed out."))
    }, timeoutMs)
    const collect = (bytes: Buffer) => {
      state.size += bytes.length
      if (state.size > 64 * 1024) {
        child.kill("SIGKILL")
        finish(new ComputerError("failed", "The helper check returned too much data."))
        return
      }
      chunks.push(bytes)
    }
    // codesign writes its identity to stderr. Neither stream is ever logged.
    child.stdout!.on("data", collect)
    child.stderr!.on("data", collect)
    child.once("error", () =>
      finish(new HelperUnavailableError("helper_missing", "The computer helper could not be checked.")),
    )
    child.once("close", (code) => finish(undefined, code))
  })
}

export async function preflight(input: {
  platform: Platform
  os: string
  executable: string
  appPath?: string
  arch: string
  hashes?: Readonly<Record<string, string>>
  run?: (argv: readonly string[]) => Promise<CommandResult>
  read?: (file: string) => Promise<Uint8Array>
}) {
  const version = input.os.split(".").map(Number)
  if (
    input.platform === "linux" ||
    (input.platform === "darwin" && (!Number.isInteger(version[0]) || version[0]! < 23)) ||
    (input.platform === "win32" && (version[0] !== 10 || !Number.isInteger(version[2]) || version[2]! < 19041))
  )
    throw new ComputerError("unsupported_os", "Computer use is not supported on this OS version.")
  const run = input.run ?? command
  if (input.platform === "win32") {
    const expected = input.hashes?.[input.arch]
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
      throw new HelperUnavailableError("helper_missing", "The computer helper has no trusted build hash.")
    const bytes = await (input.read ?? readFile)(input.executable).catch(() => undefined)
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase())
      throw new HelperUnavailableError("helper_missing", "The computer helper does not match this build.")
    return
  }
  const bundle = path.resolve(input.executable, "../../..")
  const app = input.appPath ?? path.resolve(path.dirname(process.execPath), "../..")
  const identity = await run(["/usr/bin/codesign", "-dv", "--verbose=4", app])
  if (identity.code !== 0)
    throw new HelperUnavailableError("helper_missing", "Vector's signing identity could not be checked.")
  const team = identity.stdout.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1]
  if (!team && !/^Signature=adhoc\r?$/m.test(identity.stdout))
    throw new HelperUnavailableError("helper_missing", "Vector's signing identity could not be verified.")
  const verify = await run([
    "/usr/bin/codesign",
    "--verify",
    "--strict",
    ...(team ? ["-R", `anchor apple generic and certificate leaf[subject.OU] = "${team}"`] : []),
    bundle,
  ])
  if (verify.code !== 0)
    throw new HelperUnavailableError("helper_missing", "The computer helper signature does not match Vector.")
}

export function spawnHelper(executable: string, args: readonly string[], platform: Platform): HelperChannel {
  const child = spawn(executable, [...args], {
    detached: true,
    windowsHide: true,
    stdio: platform === "darwin" ? ["ignore", "ignore", "pipe", "pipe"] : ["pipe", "pipe", "ignore"],
  })
  const data = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(event: { code?: number; signal?: string }) => void>()
  const input = platform === "darwin" ? (child.stdio[3] as Duplex) : child.stdin!
  const output = platform === "darwin" ? (child.stdio[3] as Duplex) : child.stdout!
  output.on("data", (bytes: Buffer) => {
    for (const cb of data) cb(bytes)
  })
  // Drain bounded pipe chunks without storing or logging private helper output.
  child.stderr?.on("data", () => {})
  let ended = false
  const exit = (code?: number, signal?: string) => {
    if (ended) return
    ended = true
    for (const cb of exits) cb({ ...(code !== undefined ? { code } : {}), ...(signal ? { signal } : {}) })
  }
  child.once("error", () => exit())
  child.once("exit", (code, signal) => exit(code ?? undefined, signal ?? undefined))
  output.once("error", () => exit())
  output.once("end", () => exit())
  input.once("error", () => exit())
  return {
    write: (bytes) => {
      if (ended) throw new Error("closed")
      input.write(bytes)
    },
    end: () => input.end(),
    kill() {
      if (!child.pid) return
      if (platform === "win32") child.kill("SIGKILL")
      else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    },
    onData(cb) {
      data.add(cb)
      return () => void data.delete(cb)
    },
    onExit(cb) {
      exits.add(cb)
      if (ended) queueMicrotask(() => cb({}))
      return () => void exits.delete(cb)
    },
  }
}

/** Owns one helper; a crash during a run is latched until explicit Resume. D18 owns the pause UI. */
export class ComputerHelper implements HelperClient {
  private readonly listeners = new Set<(event: Computer.HelperEvent) => void>()
  private readonly restarts: number[] = []
  private client?: HelperClient
  private starting?: Promise<Computer.HelperHello>
  private refreshing?: Promise<Computer.HelperHello>
  private retiring?: Promise<void>
  private greeting?: Computer.HelperHello
  private heartbeatTimer?: unknown
  private restartTimer?: unknown
  private stopped = false
  private active = false
  private needsResume = false
  private generation = 0
  private launches = 0
  private identity?: Promise<CommandResult>
  private readonly time: HelperClock

  constructor(
    private readonly options: Paths & {
      platform: Platform
      channel: Channel
      packaged: boolean
      os?: string
      arch?: string
      hashes?: Readonly<Record<string, string>>
      clock?: HelperClock
      check?: (executable: string) => Promise<void>
      /** Injected native signing metadata only; production shares the cached codesign identity with preflight. */
      signingIdentity?: () => Promise<CommandResult>
      spawn?: (executable: string, args: readonly string[], platform: Platform) => HelperChannel
      probeCommand?: (argv: readonly string[]) => Promise<CommandResult>
    },
  ) {
    this.time = options.clock ?? clock
  }

  setRunActive(active: boolean) {
    this.active = active
  }

  /** Intentional permission replacement retains a paused task; transport dependency loss does not. */
  isRefreshing() {
    return this.refreshing !== undefined
  }

  private check(executable: string) {
    if (this.options.check) return this.options.check(executable)
    return preflight({
      platform: this.options.platform,
      os: this.options.os ?? release(),
      executable,
      appPath: this.options.appPath,
      arch: this.options.arch ?? process.arch,
      hashes: this.options.hashes,
      run: (argv) => (argv[1] === "-dv" ? this.signingIdentity() : command(argv)),
    })
  }

  private signingIdentity() {
    const app = this.options.appPath ?? path.resolve(path.dirname(process.execPath), "../..")
    return (this.identity ??=
      this.options.signingIdentity?.() ?? command(["/usr/bin/codesign", "-dv", "--verbose=4", app]))
  }

  /** Runtime trust observation, independent of release channel and packaging flags. Unknown fails closed. */
  async runtimeSigningKind(): Promise<"adhoc" | "signed" | "unknown"> {
    try {
      if (this.options.platform === "win32") {
        await this.check(helperPath(this.options.platform, this.options.channel, this.options.packaged, this.options))
        return "signed"
      }
      if (this.options.platform !== "darwin") return "unknown"
      const identity = await this.signingIdentity()
      if (identity.code !== 0) return "unknown"
      const team = identity.stdout.match(/^TeamIdentifier=(.*)$/m)?.[1]?.trim()
      const adhoc = /^Signature=adhoc\r?$/m.test(identity.stdout)
      if (team && /^[A-Z0-9]{10}$/.test(team)) return adhoc ? "unknown" : "signed"
      if (team !== undefined && team !== "not set") return "unknown"
      return adhoc ? "adhoc" : "unknown"
    } catch {
      return "unknown"
    }
  }

  start(): Promise<Computer.HelperHello> {
    if (this.stopped || this.needsResume)
      return Promise.reject(
        new HelperUnavailableError("helper_missing", "Resume is required to start the computer helper."),
      )
    if (this.refreshing) return this.refreshing
    if (this.greeting) return Promise.resolve(this.greeting)
    if (this.starting) return this.starting
    this.time.clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const generation = ++this.generation
    const retiring = this.retiring
    const starting = (retiring ? retiring.then(() => this.launch(generation)) : this.launch(generation)).finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
    this.starting = starting
    return starting
  }

  private current(generation: number) {
    if (this.stopped || generation !== this.generation)
      throw new ComputerError("stopped", "The computer helper startup was superseded.")
  }

  private async launch(generation: number) {
    this.current(generation)
    const executable = helperPath(this.options.platform, this.options.channel, this.options.packaged, this.options)
    const override = developmentHelperCommand(this.options.channel)
    if (!override) await this.check(executable)
    this.current(generation)
    // All post-initial launches share one budget, including demand-driven starts after a crash or bad hello.
    const now = this.time.now()
    while (this.restarts.length && this.restarts[0]! <= now - 60_000) this.restarts.shift()
    if (this.launches > 0) {
      if (this.restarts.length >= Computer.LIMITS.helperRestartsPerMinute)
        throw new HelperUnavailableError(
          "helper_missing",
          "The computer helper has restarted too often. Try again shortly.",
        )
      this.restarts.push(now)
    }
    this.launches++
    const channel = (this.options.spawn ?? spawnHelper)(
      override?.[0] ?? executable,
      [...(override?.slice(1) ?? []), "--stdio", "--parent-pid", String(process.pid)],
      this.options.platform,
    )
    const client = createHelperClient(channel, { clock: this.time })
    this.client = client
    const lost = (event: Extract<Computer.HelperEvent, { event: "exit" }>, closeChannel = false) => {
      if (generation !== this.generation || this.client !== client || this.stopped) return
      this.time.clearTimeout(this.heartbeatTimer)
      this.time.clearTimeout(this.restartTimer)
      this.heartbeatTimer = this.restartTimer = undefined
      this.client = undefined
      this.greeting = undefined
      // Latch before listeners retire the run and clear active. A stale task never restarts itself.
      this.needsResume ||= this.active
      const retiring = closeChannel ? client.close().catch(() => {}) : Promise.resolve()
      if (closeChannel) {
        this.retiring = retiring
        void retiring.finally(() => {
          if (this.retiring === retiring) this.retiring = undefined
        })
      }
      for (const listener of this.listeners)
        try {
          listener(event)
        } catch {
          /* One listener cannot retain somebody else's authority. */
        }
      const restart = () => {
        if (generation !== this.generation || this.stopped || this.client || this.needsResume || this.active) return
        this.restartTimer = this.time.setTimeout(() => {
          if (generation !== this.generation || this.stopped) return
          this.restartTimer = undefined
          void this.restart().catch(() => {})
        }, 100)
      }
      if (!this.active && !this.needsResume) {
        if (closeChannel) void retiring.then(restart)
        else restart()
      }
    }
    client.onEvent((event) => {
      if (generation !== this.generation || this.client !== client || this.stopped) return
      if (event.event === "exit") return lost(event)
      for (const listener of this.listeners) listener(event)
    })
    const hello = await client
      .request<Computer.HelperHello>("hello", { protocol: { min: Computer.PROTOCOL, max: Computer.PROTOCOL } }, 5000)
      .catch(async (error) => {
        await client.close()
        this.current(generation)
        throw error
      })
    if (
      hello.protocol.min > Computer.PROTOCOL ||
      hello.protocol.max < Computer.PROTOCOL ||
      hello.protocol.min > hello.protocol.max ||
      hello.limits.maxFrameBytes > Computer.LIMITS.helperFrameBytes
    ) {
      await client.close()
      throw new ComputerError("helper_incompatible", "The computer helper is incompatible with this build.")
    }
    if (!hello.responsible) {
      await client.close()
      throw new ComputerError("responsible_missing", "The computer helper does not hold its own OS permissions.")
    }
    if (this.stopped || generation !== this.generation || this.client !== client)
      throw new ComputerError("stopped", "The computer helper stopped during startup.")
    this.greeting = hello
    const beat = () => {
      if (this.stopped || this.client !== client) return
      void client.request("heartbeat", {}, 2000).catch(() => lost({ event: "exit" }, true))
      this.heartbeatTimer = this.time.setTimeout(beat, Computer.LIMITS.heartbeatMs)
    }
    this.heartbeatTimer = this.time.setTimeout(beat, Computer.LIMITS.heartbeatMs)
    return hello
  }

  private async restart() {
    if (this.stopped || this.needsResume || this.active) return
    await this.start()
  }

  async resume() {
    if (this.stopped) throw new ComputerError("stopped", "The computer helper was stopped.")
    this.needsResume = false
    return this.start()
  }

  /** Refresh process-cached grants without resuming a task. D18 receives one exit and requires explicit Resume. */
  refreshPermissions(): Promise<Computer.HelperHello> {
    if (this.stopped) return Promise.reject(new ComputerError("stopped", "The computer helper was stopped."))
    if (this.refreshing) return this.refreshing
    const generation = ++this.generation
    const client = this.client
    this.client = undefined
    this.greeting = undefined
    this.starting = undefined
    this.needsResume ||= this.active
    this.time.clearTimeout(this.heartbeatTimer)
    this.time.clearTimeout(this.restartTimer)
    this.heartbeatTimer = this.restartTimer = undefined
    // Delay cleanup by one microtask so reentrant listeners see the shared refresh operation first.
    const retiring = Promise.resolve().then(() => client?.close())
    const refreshing = retiring
      .then(() => this.launch(generation))
      .finally(() => {
        if (this.refreshing === refreshing) this.refreshing = undefined
        if (this.retiring === retiring) this.retiring = undefined
      })
    this.retiring = retiring
    this.refreshing = refreshing
    for (const listener of this.listeners)
      try {
        listener({ event: "exit" })
      } catch {
        /* A failed listener cannot prevent the other owners from invalidating the retired channel. */
      }
    return refreshing
  }

  async request<T>(op: Computer.HelperOpName, args?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const permission = ["permissions.status", "permissions.request", "permissions.reset", "input.setup"].includes(op)
    const starting =
      this.needsResume && permission
        ? (this.refreshing ?? (this.greeting ? Promise.resolve(this.greeting) : this.refreshPermissions()))
        : this.start()
    const generation = this.generation
    const hello = await starting
    this.current(generation)
    if (this.needsResume && !permission)
      throw new HelperUnavailableError("helper_missing", "Resume is required to use the computer helper.")
    if (op === "hello") return hello as T
    const client = this.client
    if (!client) throw new HelperUnavailableError("helper_missing", "The computer helper stopped.")
    return client.request(op, args, timeoutMs)
  }

  onEvent(cb: (event: Computer.HelperEvent) => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  async probe() {
    const executable = helperPath(this.options.platform, this.options.channel, this.options.packaged, this.options)
    const override = developmentHelperCommand(this.options.channel)
    if (!override) await this.check(executable)
    const result = await (this.options.probeCommand ?? command)([...(override ?? [executable]), "--probe", "--json"])
    const schema = Schema.Struct({
      permissions: Computer.PermissionsStatus,
      responsible: Schema.Boolean,
      captureBlocked: Schema.optional(Schema.Boolean),
      elevated: Schema.optional(Schema.Boolean),
    })
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(result.stdout)
    if (result.code !== 0 || Option.isNone(parsed))
      throw new HelperUnavailableError("helper_missing", "The computer helper probe failed.")
    return parsed.value
  }

  async close() {
    this.stopped = true
    this.generation++
    this.time.clearTimeout(this.heartbeatTimer)
    this.time.clearTimeout(this.restartTimer)
    this.heartbeatTimer = this.restartTimer = undefined
    const client = this.client
    this.client = undefined
    this.greeting = undefined
    await Promise.all([client?.close(), this.retiring])
    this.listeners.clear()
  }
}
