import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { parseBridgeRequest, parseProtocol } from "./computer-bridge-input"

// The engine's way to Hands in desktop main (contract section 2.8): a loopback server of its own, apart from the
// browser bridge, that checks every request before any work and hands each decoded command to an executor. Order
// of checks: Host and token (401) before the route (404), the protocol (426), the size (413) and the body (400), so
// a caller without the token learns nothing and its body is never kept. Only the executor's own refusals are 409.
// A client that leaves cancels the work it started (INV-R4), and a lease acquired for a client that is gone is
// released, never left holding the computer (E6.7). Its diagnostics go to the `warn` it is given (D22 passes desktop
// main's log file), as fixed lines with command and error names only.

const STOPPED = "The computer bridge stopped."
const UNAVAILABLE = "The computer is not available."
const FAILED = "The computer could not finish this request."
const ERROR_UNITS = 2000

/** An executor refusal; the bridge answers it 409 with its code. D14, D16 and D19 throw it. */
export class ComputerError extends Error {
  readonly code: Computer.ComputerErrorCode
  constructor(code: Computer.ComputerErrorCode, message: string) {
    super(message)
    this.name = "ComputerError"
    this.code = code
  }
}

/** One bridge request as the executor sees it (the contract's requestKey): frozen, and new for every request. */
export type ComputerBridgeKey = Readonly<{
  id: number
  command: Computer.BridgeCommandName
  rootSessionID: string
  sessionID: string
  directory: string
  lease?: number
}>

export type BridgeResponse<C extends Computer.BridgeCommandName> =
  (typeof Computer.BridgeCommands)[C]["response"]["Type"]

export interface ComputerExecutor {
  /** Runs one decoded command. A ComputerError with a known code answers 409 with it; anything else is 409 failed. */
  run<R extends Computer.BridgeRequest>(request: R, key: ComputerBridgeKey): Promise<BridgeResponse<R["command"]>>
  /** The client left while `run` for this key was pending: stop that work and release held input (D19). */
  cancel(key: ComputerBridgeKey): void | Promise<void>
}

export type ComputerCapabilities = () => Computer.Capabilities | Promise<Computer.Capabilities>

/** Where the bridge's fixed diagnostic lines go. Desktop main's console never reaches its log files. */
type Warn = (message: string, ...fields: string[]) => void

/** The executor until D19: every command is refused as unavailable. */
export const unavailableExecutor: ComputerExecutor = {
  run: () => Promise.reject(new ComputerError("unavailable", UNAVAILABLE)),
  cancel: () => {},
}

type Run = { key: ComputerBridgeKey; settled: boolean; cancelled: boolean }

type Flight = {
  response: ServerResponse
  /** The client went away before its answer finished. */
  left: boolean
  /** An answer was written, or given up because the client left or the bridge stopped. */
  answered: boolean
  run?: Run
  /** The lease in an acquire's answer while that answer is still on its way to the client. */
  lease?: number
}

/** The request handler on its own, so tests can drive disconnects that Bun's node:http never reports. */
export function createBridgeHandler(input: {
  token: string
  /** Exactly `127.0.0.1:<port>`. */
  host: string
  executor: ComputerExecutor
  capabilities: ComputerCapabilities
  /** Defaults to the console, for tests and the Node check. */
  warn?: Warn
}) {
  const warn: Warn = input.warn ?? ((...line) => console.warn(...line))
  // Hashing both sides gives timingSafeEqual equal lengths whatever the caller sent.
  const expected = createHash("sha256").update(`Bearer ${input.token}`).digest()
  const flights = new Set<Flight>()
  const state = { stopped: false, id: 0 }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const flight: Flight = { response, left: false, answered: false }
    flights.add(flight)
    // Attached before anything else, so a client that leaves at any point is seen. Node fires the request's own
    // 'close' as soon as its body is read, so only a close before the response finished means the client left: the
    // response's own, or its connection's. A response queued behind another on a pipelined connection never gets a
    // 'close' of its own, so the connection's is the only sign that its client left.
    const socket = request.socket
    const leave = () => {
      // The response's close follows every answer that finished, so a keep-alive connection gathers no listeners.
      socket.off("close", leave)
      if (response.writableFinished || flight.left) return
      flight.left = true
      flights.delete(flight)
      if (flight.run && !flight.run.settled) cancel(flight.run)
      if (flight.run && flight.lease !== undefined) release(flight.run.key, flight.lease)
      flight.lease = undefined
    }
    response.once("close", leave)
    socket.once("close", leave)

    const sent = createHash("sha256").update(single(request, "authorization") ?? "")
    const authorized = timingSafeEqual(sent.digest(), expected)
    if (single(request, "host") !== input.host || !authorized) return refuse(flight, 401, "Unauthorized")
    if (state.stopped) return fail(flight, "unavailable", STOPPED, true)
    const capabilities = request.method === "GET" && request.url === Computer.BRIDGE.capabilitiesPath
    if (!capabilities && !(request.method === "POST" && request.url === Computer.BRIDGE.commandPath))
      return refuse(flight, 404, "Not found")
    if (!parseProtocol(single(request, Computer.BRIDGE.protocolHeader)))
      return refuse(flight, 426, "Unsupported protocol version")
    if (capabilities) return answerCapabilities(flight)

    const body = await readBody(request)
    if (flight.answered || flight.left) return
    if (body === "too_large") return refuse(flight, 413, "Request too large")
    const parsed = body && parseBridgeRequest(body)
    if (!parsed) return refuse(flight, 400, "Invalid request")

    const run: Run = { key: keyOf(parsed), settled: false, cancelled: false }
    flight.run = run
    const outcome = await Promise.resolve()
      .then(() => input.executor.run(parsed, run.key))
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    run.settled = true
    // A ComputerError is a refusal only with a code the wire knows: a cast code, as from a newer helper's frame, is
    // an executor bug like any other rejection.
    const refusal =
      !outcome.ok && outcome.error instanceof ComputerError && Schema.is(Computer.ComputerErrorCode)(outcome.error.code)
        ? outcome.error
        : undefined
    // Encoding keeps only the fields the command's response declares, and an explicit undefined optional key is
    // dropped rather than refused, so nothing the executor did not mean to send leaves main.
    const encoded = outcome.ok
      ? Schema.encodeUnknownOption(Computer.BridgeCommands[parsed.command].response)(outcome.value)
      : Option.none()
    // Logged whether or not the client is still there: a failure after it left, as in a cancelled act, is a bug too.
    if (!outcome.ok && !(outcome.error instanceof ComputerError))
      warn("Computer bridge command failed", parsed.command, errorName(outcome.error))
    if (!outcome.ok && outcome.error instanceof ComputerError && !refusal)
      warn("Computer bridge error code is not known", parsed.command)
    if (outcome.ok && Option.isNone(encoded)) warn("Computer bridge result does not match its command", parsed.command)
    const lease =
      parsed.command === "acquire" && Option.isSome(encoded) && "lease" in encoded.value
        ? encoded.value.lease
        : undefined
    if (flight.answered || flight.left) {
      if (lease !== undefined) release(run.key, lease)
      return
    }
    if (!outcome.ok) return refusal ? fail(flight, refusal.code, refusal.message) : fail(flight, "failed", FAILED)
    if (Option.isNone(encoded)) return fail(flight, "failed", FAILED)
    const text = JSON.stringify(encoded.value)
    if (Buffer.byteLength(text) > Computer.LIMITS.bridgeResponseBytes)
      return fail(flight, "frame_too_large", "The computer's answer is too large to send.")
    flight.lease = lease
    send(flight, 200, text)
  }

  async function answerCapabilities(flight: Flight) {
    const outcome = await Promise.resolve()
      .then(input.capabilities)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    if (!outcome.ok) {
      warn("Computer bridge capabilities failed", errorName(outcome.error))
      return fail(flight, "unavailable", UNAVAILABLE)
    }
    const encoded = Schema.encodeUnknownOption(Computer.Capabilities)(outcome.value)
    // A fixed line without the value, so a wrong shape that makes Hands unavailable still shows in the logs.
    if (Option.isNone(encoded)) {
      warn("Computer bridge capabilities do not match their schema")
      return fail(flight, "unavailable", UNAVAILABLE)
    }
    send(flight, 200, JSON.stringify(encoded.value))
  }

  function keyOf(request: Computer.BridgeRequest): ComputerBridgeKey {
    return Object.freeze({
      id: ++state.id,
      command: request.command,
      rootSessionID: request.rootSessionID,
      sessionID: request.sessionID,
      directory: request.directory,
      ...("lease" in request && request.lease !== undefined ? { lease: request.lease } : {}),
    })
  }

  function cancel(run: Run) {
    if (run.cancelled) return
    run.cancelled = true
    void Promise.resolve()
      .then(() => input.executor.cancel(run.key))
      .catch((error: unknown) => warn("Computer bridge cancel failed", run.key.command, errorName(error)))
  }

  /** Gives back a lease its client never received, on the acquire's own envelope. */
  function release(key: ComputerBridgeKey, lease: number) {
    const request = {
      v: Computer.PROTOCOL,
      command: "release",
      rootSessionID: key.rootSessionID,
      sessionID: key.sessionID,
      directory: key.directory,
      lease,
    } as const
    void Promise.resolve()
      .then(() => input.executor.run(request, keyOf(request)))
      .catch((error: unknown) => warn("Computer bridge release failed", errorName(error)))
  }

  function fail(flight: Flight, code: Computer.ComputerErrorCode, message: string, close = false) {
    const body = Schema.encodeUnknownOption(Computer.BridgeFailure)({
      ok: false,
      code,
      error: failureText(message, input.token),
    })
    const failure = Option.getOrElse(body, () => ({ ok: false, code: "failed", error: FAILED }))
    send(flight, 409, JSON.stringify(failure), close)
  }

  /** A refusal before or instead of reading the body; the connection closes after it, so no body is drained. */
  function refuse(flight: Flight, status: 400 | 401 | 404 | 413 | 426, error: string) {
    send(flight, status, JSON.stringify({ error }), true)
  }

  function send(flight: Flight, status: number, body: string, close = false) {
    if (flight.answered) return
    flight.answered = true
    flights.delete(flight)
    if (flight.left) return
    flight.response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(close ? { connection: "close" } : {}),
    })
    flight.response.end(body)
  }

  /** Cancels the work in flight, answers every open request 409 unavailable, then refuses new work. */
  function stop() {
    state.stopped = true
    for (const flight of [...flights]) {
      if (flight.run && !flight.run.settled) cancel(flight.run)
      fail(flight, "unavailable", STOPPED, true)
    }
  }

  return { handle, stop }
}

export async function startComputerBridge(input: {
  executor: ComputerExecutor
  capabilities: ComputerCapabilities
  /** Desktop main passes its log file's warn; defaults to the console. */
  warn?: Warn
}) {
  const warn: Warn = input.warn ?? ((...line) => console.warn(...line))
  const token = randomBytes(32).toString("hex")
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, Computer.BRIDGE.host, () => {
      server.off("error", reject)
      const address = server.address()
      if (address && typeof address === "object") return resolve(address.port)
      server.close()
      reject(new Error("The computer bridge failed to bind."))
    })
  })
  const host = `${Computer.BRIDGE.host}:${port}`
  const handler = createBridgeHandler({ token, host, executor: input.executor, capabilities: input.capabilities, warn })
  server.on("request", (request: IncomingMessage, response: ServerResponse) =>
    handler.handle(request, response).catch((error: unknown) => {
      warn("Computer bridge request failed", errorName(error))
      response.destroy()
    }),
  )
  server.on("error", (error) => warn("Computer bridge server error", errorName(error)))

  const closing: { done?: Promise<void> } = {}
  // Bounded for will-quit: open requests are answered first, then any connection still open after 1 s is cut.
  const stop = () =>
    (closing.done ??= new Promise<void>((resolve) => {
      handler.stop()
      const timer = setTimeout(() => {
        server.closeAllConnections()
        resolve()
      }, 1000)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
      server.closeIdleConnections()
    }))
  return { url: `http://${host}`, token, stop }
}

/** A header's value when the request carries it exactly once, in any letter case. */
function single(request: IncomingMessage, name: string) {
  const lower = name.toLowerCase()
  const values = request.rawHeaders.flatMap((value, index, all) =>
    index % 2 === 1 && all[index - 1]!.toLowerCase() === lower ? [value.trim()] : [],
  )
  return values.length === 1 ? values[0] : undefined
}

/** Reads a body up to the limit. Past it, the rest is read and dropped, never kept. */
function readBody(request: IncomingMessage) {
  return new Promise<Buffer | "too_large" | undefined>((resolve) => {
    if (Number(request.headers["content-length"]) > Computer.LIMITS.bridgeBodyBytes) return resolve("too_large")
    const chunks: Buffer[] = []
    let bytes = 0
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= Computer.LIMITS.bridgeBodyBytes) return void chunks.push(chunk)
      chunks.length = 0
      resolve("too_large")
    })
    request.once("end", () => resolve(Buffer.concat(chunks)))
    // A client that leaves mid-body: the response's close marks it, so the handler only stops here.
    request.once("error", () => resolve(undefined))
    request.once("close", () => resolve(undefined))
  })
}

/** The 409 text: the token never appears, and it fits the wire's 2000 UTF-16 units even for astral text. */
function failureText(message: string, token: string) {
  const text = Computer.clean(message.replaceAll(token, "[redacted]"), ERROR_UNITS)
  if (text.length <= ERROR_UNITS) return text
  // clean counts code points; the wire bound counts UTF-16 units, so cut again without splitting a surrogate pair.
  const cut = text.slice(0, ERROR_UNITS - 1)
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd() + "…"
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}
