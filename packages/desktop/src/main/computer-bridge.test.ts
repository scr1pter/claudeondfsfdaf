import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { connect, createServer } from "node:net"
import { PassThrough, Readable } from "node:stream"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

// D13: the Hands bridge in desktop main. Real bridges run on 127.0.0.1 with a recording executor; cases that need a
// client to leave go through createBridgeHandler, because Bun's node:http never reports a disconnect (the Node check
// in test/computer/bridge-node.ts covers those under Node). Nothing here touches the screen, input or permissions.

// The originals are copied first: a factory that spreads the live module namespace hangs Bun.
const real = { ...crypto }
const compared: [number, number][] = []
const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
  compared.push([a.byteLength, b.byteLength])
  return real.timingSafeEqual(a, b)
}
mock.module("node:crypto", () => ({ ...real, default: { ...real, timingSafeEqual }, timingSafeEqual }))

const { ComputerError, createBridgeHandler, startComputerBridge, unavailableExecutor } = await import(
  "./computer-bridge"
)

type Key = import("./computer-bridge").ComputerBridgeKey
type Executor = import("./computer-bridge").ComputerExecutor
type Request = Computer.BridgeRequest

const ENVELOPE = { v: 1, rootSessionID: "ses_root", sessionID: "ses_child", directory: "/work/receipts" } as const
const PROTOCOL_HEADER = Computer.BRIDGE.protocolHeader
const CAPABILITIES: Computer.Capabilities = {
  protocol: 1,
  available: true,
  backend: "fake",
  actions: ["screenshot", "click"],
  features: { background: false, uiTree: true, zoom: true, clipboard: false, locked: false },
}
const STATE: Computer.ComputerState = {
  phase: "working",
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: true,
  stopChord: "Control+Alt+Shift+Escape",
  lease: 4,
  reduceMotion: false,
}
const STATUS = {
  platform: "macos",
  backendVersion: "1.0.0",
  permissions: { screen: "granted", accessibility: "granted" },
  displays: [],
  mode: "foreground",
} as const
const NUMBERS = {
  platform: "macos",
  bundleId: "com.apple.iWork.Numbers",
  apple: true,
  system: false,
  verified: true,
  name: "Numbers",
} as const
const FRAME = {
  id: "frame_1",
  scope: "display",
  display: "display_1",
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  scale: 1,
  image: { w: 100, h: 100 },
  at: 1,
  hash: "0123456789abcdef",
} as const
const BUDGET = { maxWidth: 100, maxHeight: 100, maxPixels: 10_000 }
const WAIT = { kind: "wait", ms: 1 } as const

/** One minimal valid body for every bridge command. */
const REQUESTS: Record<Computer.BridgeCommandName, Request> = {
  status: { ...ENVELOPE, command: "status" },
  acquire: { ...ENVELOPE, command: "acquire", title: "Receipts" },
  release: { ...ENVELOPE, command: "release", lease: 4 },
  access: { ...ENVELOPE, command: "access", lease: 4, app: { name: "Numbers" } },
  grant: { ...ENVELOPE, command: "grant", lease: 4, identity: NUMBERS, level: "interact", requestID: "per_1" },
  remember: { ...ENVELOPE, command: "remember", identity: NUMBERS, requestID: "per_1" },
  listApps: { ...ENVELOPE, command: "listApps", lease: 4 },
  openApp: { ...ENVELOPE, command: "openApp", lease: 4, app: { name: "Numbers" } },
  focusWindow: { ...ENVELOPE, command: "focusWindow", lease: 4, app: { name: "Numbers" } },
  screenshot: { ...ENVELOPE, command: "screenshot", lease: 4, scope: {}, budget: BUDGET },
  zoom: {
    ...ENVELOPE,
    command: "zoom",
    lease: 4,
    frame: "frame_1",
    region: { x0: 0, y0: 0, x1: 9, y1: 9 },
    budget: BUDGET,
  },
  inspect: { ...ENVELOPE, command: "inspect", lease: 4, ref: "ui_1" },
  readUi: { ...ENVELOPE, command: "readUi", lease: 4, app: { name: "Numbers" }, limit: 10 },
  act: { ...ENVELOPE, command: "act", lease: 4, steps: [WAIT], settleMs: 0 },
  handoff: { ...ENVELOPE, command: "handoff", lease: 4, phase: "start", reason: "sign_in" },
  awaitControl: { ...ENVELOPE, command: "awaitControl", lease: 4 },
  heartbeat: { ...ENVELOPE, command: "heartbeat", lease: 4 },
  cancel: { ...ENVELOPE, command: "cancel" },
}

/** A promise with its resolve and reject, for answers a case decides later. */
function deferred<T>() {
  const handle = {} as { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
  handle.promise = new Promise<T>((resolve, reject) => Object.assign(handle, { resolve, reject }))
  return handle
}

/** An executor that records every run and cancel; `answer` decides each run's result. */
function recorder(answer: (request: Request, key: Key) => unknown = () => ({ ok: true })) {
  const runs: { request: Request; key: Key }[] = []
  const cancels: Key[] = []
  const waiting: { count: number; done: () => void }[] = []
  const notify = () =>
    waiting.filter((item) => runs.length + cancels.length >= item.count).forEach((item) => item.done())
  const executor: Executor = {
    run: async (request, key) => {
      runs.push({ request, key })
      notify()
      return (await answer(request, key)) as never
    },
    cancel: (key) => {
      cancels.push(key)
      notify()
    },
  }
  /** Resolves once runs and cancels together reach `count`. */
  const calls = (count: number) =>
    new Promise<void>((done) => {
      waiting.push({ count, done })
      notify()
    })
  return { executor, runs, cancels, calls }
}

const bridges: { stop: () => Promise<void> }[] = []
afterEach(async () => {
  // Spies go back even when a test fails before its end; the node:crypto module mock stays.
  mock.restore()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})
beforeEach(() => {
  compared.length = 0
})

async function start(
  executor: Executor = recorder().executor,
  capabilities: () => Computer.Capabilities | Promise<Computer.Capabilities> = () => CAPABILITIES,
) {
  const bridge = await startComputerBridge({ executor, capabilities })
  bridges.push(bridge)
  return { ...bridge, port: Number(new URL(bridge.url).port) }
}

type Bridge = Awaited<ReturnType<typeof start>>

function headers(bridge: Bridge, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${bridge.token}`, [PROTOCOL_HEADER]: "1", ...extra }
}

function post(bridge: Bridge, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${bridge.url}/computer`, {
    method: "POST",
    headers: headers(bridge, extra),
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  })
}

/** One raw HTTP request on its own connection; the response is read by its Content-Length. */
function raw(port: number, head: string, ...chunks: (string | Buffer)[]) {
  return new Promise<{ status: number; head: string; body: string }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const received: Buffer[] = []
    socket.on("error", reject)
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk)
      const text = Buffer.concat(received).toString("latin1")
      const split = text.indexOf("\r\n\r\n")
      if (split < 0) return
      const top = text.slice(0, split)
      const body = text.slice(split + 4)
      if (body.length < Number(/\r\ncontent-length: *(\d+)/i.exec(top)?.[1] ?? 0)) return
      socket.destroy()
      resolve({ status: Number(top.slice(9, 12)), head: top.toLowerCase(), body })
    })
    socket.once("connect", () => [head, ...chunks].forEach((chunk) => socket.write(chunk)))
  })
}

function rawHead(bridge: Bridge, lines: string[], start = "POST /computer HTTP/1.1") {
  return [start, ...lines, "", ""].join("\r\n")
}

const STATUS_BODY = JSON.stringify(REQUESTS.status)

/** The standard lines of an engine request, without its body framing. */
function engineLines(bridge: Bridge) {
  return [`Host: 127.0.0.1:${bridge.port}`, `Authorization: Bearer ${bridge.token}`, `${PROTOCOL_HEADER}: 1`]
}

describe("bridge server", () => {
  test("listens on a 127.0.0.1 origin with a fresh 32-byte hex token", async () => {
    const one = await start()
    const two = await start()
    expect(one.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(new URL(one.url).origin).toBe(one.url)
    expect(one.token).toMatch(/^[0-9a-f]{64}$/)
    expect(two.token).toMatch(/^[0-9a-f]{64}$/)
    expect(one.token).not.toBe(two.token)
    expect(one.port).not.toBe(two.port)
  })

  test("is bound to 127.0.0.1 alone: another loopback address on its port is refused", async () => {
    const bridge = await start()
    // A wildcard bind would accept both: "::" also takes IPv4, and "0.0.0.0" takes all of 127/8. Each address is
    // used only where this host has it (macOS has no 127.0.0.2, some hosts no IPv6).
    const usable = await Promise.all(
      ["::1", "127.0.0.2"].map(
        (address) =>
          new Promise<string | undefined>((resolve) => {
            const probe = createServer()
            probe.once("error", () => resolve(undefined))
            probe.listen(0, address, () => probe.close(() => resolve(address)))
          }),
      ),
    ).then((addresses) => addresses.filter((address) => address !== undefined))
    expect(usable.length).toBeGreaterThan(0)
    const answers = await Promise.all(
      usable.map(
        (address) =>
          new Promise<string>((resolve) => {
            const socket = connect(bridge.port, address)
            socket.once("connect", () => {
              socket.destroy()
              resolve(`${address} connected`)
            })
            socket.once("error", (error: NodeJS.ErrnoException) => resolve(`${address} ${error.code}`))
          }),
      ),
    )
    expect(answers).toEqual(usable.map((address) => `${address} ECONNREFUSED`))
  })

  test("capabilities answer 200 with the value, dropping an undefined optional key", async () => {
    const bridge = await start(undefined, async () => ({ ...CAPABILITIES, reason: undefined }))
    const response = await fetch(`${bridge.url}/computer/capabilities`, { headers: headers(bridge) })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json()
    expect(body).toEqual(CAPABILITIES)
    expect("reason" in body).toBe(false)
  })

  test("capabilities that throw, reject or have the wrong shape are 409 unavailable", async () => {
    const answers: (() => Computer.Capabilities | Promise<Computer.Capabilities>)[] = [
      () => {
        throw new Error("helper exited")
      },
      () => Promise.reject(new Error("helper exited")),
      () => ({ ...CAPABILITIES, protocol: 2 }) as unknown as Computer.Capabilities,
      () =>
        ({ ...CAPABILITIES, features: { ...CAPABILITIES.features, locked: true } }) as unknown as Computer.Capabilities,
    ]
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    for (const answer of answers) {
      const bridge = await start(undefined, answer)
      const response = await fetch(`${bridge.url}/computer/capabilities`, { headers: headers(bridge) })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ ok: false, code: "unavailable", error: "The computer is not available." })
    }
    expect(warn.mock.calls).toEqual([
      ["Computer bridge capabilities failed", "Error"],
      ["Computer bridge capabilities failed", "Error"],
      ["Computer bridge capabilities do not match their schema"],
      ["Computer bridge capabilities do not match their schema"],
    ])
  })

  test("the warn it is given gets every diagnostic line, and the console none", async () => {
    const logged = spyOn(console, "warn").mockImplementation(() => {})
    const lines: string[][] = []
    const bridge = await startComputerBridge({
      executor: { run: () => Promise.reject(new TypeError("/Users/me/Secret")), cancel: () => {} },
      capabilities: () => ({ ...CAPABILITIES, protocol: 2 }) as unknown as Computer.Capabilities,
      warn: (...line) => void lines.push(line),
    })
    bridges.push(bridge)
    const auth = { authorization: `Bearer ${bridge.token}`, [PROTOCOL_HEADER]: "1" }
    expect((await fetch(`${bridge.url}/computer/capabilities`, { headers: auth })).status).toBe(409)
    expect((await fetch(`${bridge.url}/computer`, { method: "POST", headers: auth, body: STATUS_BODY })).status).toBe(
      409,
    )
    expect(lines).toEqual([
      ["Computer bridge capabilities do not match their schema"],
      ["Computer bridge command failed", "status", "TypeError"],
    ])
    expect(logged).not.toHaveBeenCalled()
  })

  test("a wrong, partial, missing or differently framed token is 401 and runs nothing", async () => {
    const record = recorder()
    const bridge = await start(record.executor)
    const wrong = [
      { authorization: `Bearer ${"0".repeat(64)}` },
      { authorization: `Bearer ${bridge.token}0` },
      { authorization: `Bearer ${bridge.token.slice(0, 32)}` },
      { authorization: `Basic ${bridge.token}` },
      { authorization: bridge.token },
      { authorization: `bearer ${bridge.token}` },
    ]
    for (const extra of wrong) expect((await post(bridge, REQUESTS.status, extra)).status).toBe(401)
    const missing = await fetch(`${bridge.url}/computer`, {
      method: "POST",
      headers: { [PROTOCOL_HEADER]: "1" },
      body: STATUS_BODY,
    })
    expect(missing.status).toBe(401)
    const unknownRoute = await fetch(`${bridge.url}/other`, { headers: { authorization: "Bearer nope" } })
    expect(unknownRoute.status).toBe(401)
    expect(await unknownRoute.json()).toEqual({ error: "Unauthorized" })
    expect(record.runs).toEqual([])
  })

  test("any Host but 127.0.0.1:<port> is 401, the right token notwithstanding", async () => {
    const record = recorder(() => STATUS)
    const bridge = await start(record.executor)
    const auth = [
      `Authorization: Bearer ${bridge.token}`,
      `${PROTOCOL_HEADER}: 1`,
      `Content-Length: ${STATUS_BODY.length}`,
    ]
    for (const host of [
      `localhost:${bridge.port}`,
      "127.0.0.1",
      `127.0.0.1:${bridge.port + 1}`,
      `evil.example:${bridge.port}`,
    ])
      expect((await raw(bridge.port, rawHead(bridge, [`Host: ${host}`, ...auth]), STATUS_BODY)).status).toBe(401)
    const noHost = await raw(bridge.port, rawHead(bridge, auth, "POST /computer HTTP/1.0"), STATUS_BODY)
    expect(noHost.status).toBe(401)
    const right = await raw(bridge.port, rawHead(bridge, [`Host: 127.0.0.1:${bridge.port}`, ...auth]), STATUS_BODY)
    expect(right.status).toBe(200)
    expect(record.runs.map((run) => run.request.command)).toEqual(["status"])
  })

  test("a missing, unknown or malformed protocol header is 426", async () => {
    const record = recorder()
    const bridge = await start(record.executor)
    const noHeader = await fetch(`${bridge.url}/computer`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: STATUS_BODY,
    })
    expect(noHeader.status).toBe(426)
    for (const version of ["2", "0", "1.0", "01", "one", "1, 1"])
      expect((await post(bridge, REQUESTS.status, { [PROTOCOL_HEADER]: version })).status).toBe(426)
    const capabilities = await fetch(`${bridge.url}/computer/capabilities`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    })
    expect(capabilities.status).toBe(426)
    const twice = await raw(
      bridge.port,
      rawHead(bridge, [...engineLines(bridge), `${PROTOCOL_HEADER}: 1`, `Content-Length: ${STATUS_BODY.length}`]),
      STATUS_BODY,
    )
    expect(twice.status).toBe(426)
    expect(record.runs).toEqual([])
  })

  test("a body over 64 KiB is 413 at once, declared or chunked; exactly 64 KiB reaches the executor", async () => {
    const record = recorder((request) => (request.command === "status" ? STATUS : { ok: true }))
    const bridge = await start(record.executor)
    // Declared: answered without sending a byte of the body.
    const declared = await raw(bridge.port, rawHead(bridge, [...engineLines(bridge), "Content-Length: 65537"]))
    expect(declared.status).toBe(413)
    expect(declared.head).toContain("\r\nconnection: close")
    const chunk = (size: number) => `${size.toString(16)}\r\n${" ".repeat(size)}\r\n`
    const chunked = await raw(
      bridge.port,
      rawHead(bridge, [...engineLines(bridge), "Transfer-Encoding: chunked"]),
      ...Array.from({ length: 8 }, () => chunk(8192)),
      chunk(1),
      "0\r\n\r\n",
    )
    expect(chunked.status).toBe(413)
    expect(record.runs).toEqual([])
    const exact = STATUS_BODY.padEnd(Computer.LIMITS.bridgeBodyBytes, " ")
    expect(Buffer.byteLength(exact)).toBe(65_536)
    const response = await post(bridge, exact)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(STATUS)
    expect(record.runs.map((run) => run.request)).toEqual([REQUESTS.status])
  })

  test("invalid bodies are 400 and never reach the executor", async () => {
    const record = recorder(() => Promise.reject(new ComputerError("unavailable", "Not now.")))
    const bridge = await start(record.executor)
    const steps = (count: number) => Array.from({ length: count }, () => WAIT)
    const invalid: (string | Uint8Array | object)[] = [
      "{",
      "",
      "null",
      `\ufeff${STATUS_BODY}`,
      Buffer.concat([
        Buffer.from('{"v":1,"command":"status","rootSessionID":"ses_'),
        Buffer.from([0xff]),
        Buffer.from('","sessionID":"s","directory":"/d"}'),
      ]),
      { ...ENVELOPE, command: "screenshotEverything" },
      { ...REQUESTS.status, v: 2 },
      { ...REQUESTS.status, extra: true },
      { ...REQUESTS.access, app: { name: "Numbers", extra: true } },
      { ...REQUESTS.inspect, ref: "ui_1234567" },
      { ...REQUESTS.inspect, ref: "ref_1" },
      { ...REQUESTS.acquire, title: "Receipts\u202egnp.exe" },
      { ...REQUESTS.acquire, title: "x".repeat(257) },
      { ...REQUESTS.act, steps: steps(11) },
      { ...REQUESTS.act, steps: [] },
      { ...REQUESTS.status, rootSessionID: "" },
    ]
    for (const body of invalid) {
      const response = await post(bridge, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid request" })
    }
    expect(record.runs).toEqual([])
    for (const body of [
      { ...REQUESTS.inspect, ref: "ui_123456" },
      { ...REQUESTS.act, steps: steps(10) },
    ])
      expect((await post(bridge, body)).status).toBe(409)
    expect(record.runs.map((run) => run.request)).toEqual([
      { ...REQUESTS.inspect, ref: "ui_123456" },
      { ...REQUESTS.act, steps: steps(10) },
    ])
  })

  test("other routes, methods and preflights are 404 with no CORS headers", async () => {
    const record = recorder()
    const bridge = await start(record.executor)
    const attempts: [string, string, Record<string, string>?][] = [
      ["GET", "/computer"],
      ["POST", "/computer/capabilities"],
      ["POST", "/computer/"],
      ["POST", "/computer?x=1"],
      ["GET", "/computer/capabilities?x=1"],
      ["POST", "/other"],
      ["PUT", "/computer"],
      ["HEAD", "/computer/capabilities"],
      ["OPTIONS", "/computer", { origin: "https://evil.example", "access-control-request-method": "POST" }],
    ]
    for (const [method, path, extra] of attempts) {
      const response = await fetch(`${bridge.url}${path}`, {
        method,
        headers: headers(bridge, extra),
        body: method === "POST" || method === "PUT" ? STATUS_BODY : undefined,
      })
      expect(response.status).toBe(404)
      expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([])
    }
    expect(record.runs).toEqual([])
  })

  test("a ComputerError is 409 with its code and cleaned text, the token redacted", async () => {
    const bridge = await start({
      run: () =>
        Promise.reject(new ComputerError("not_granted", `Numbers\u0007 is not\u202e allowed.\n${bridge.token}`)),
      cancel: () => {},
    })
    const response = await post(bridge, REQUESTS.act)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      code: "not_granted",
      error: "Numbers is not allowed. [redacted]",
    })
  })

  test("a long or astral ComputerError text still fits the wire and keeps its code", async () => {
    const messages = ["x".repeat(5000), "\u{1F600}".repeat(2000), `a${"\u{1F600}".repeat(1999)}`]
    for (const message of messages) {
      const bridge = await start({ run: () => Promise.reject(new ComputerError("stopped", message)), cancel: () => {} })
      const response = await post(bridge, REQUESTS.act)
      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.code).toBe("stopped")
      expect(body.error.length).toBeLessThanOrEqual(2000)
      expect(body.error.endsWith("…")).toBe(true)
      expect(body.error).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
      expect(Schema.is(Computer.BridgeFailure)(body)).toBe(true)
    }
  })

  test("any other failure is 409 failed with a fixed sentence, logged by command and error name only", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const bridge = await start({
      run: () => Promise.reject(new TypeError("/Users/me/Secret Project failed at token")),
      cancel: () => {},
    })
    const response = await post(bridge, REQUESTS.act)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      code: "failed",
      error: "The computer could not finish this request.",
    })
    // A code the wire does not know, as from a helper built against a newer list: a fixed line with the command,
    // neither the code nor the text.
    const invalid = await start({
      run: () => Promise.reject(new ComputerError("nonsense" as Computer.ComputerErrorCode, "odd /Users/me/Secret")),
      cancel: () => {},
    })
    expect(await (await post(invalid, REQUESTS.screenshot)).json()).toEqual({
      ok: false,
      code: "failed",
      error: "The computer could not finish this request.",
    })
    expect(warn.mock.calls).toEqual([
      ["Computer bridge command failed", "act", "TypeError"],
      ["Computer bridge error code is not known", "screenshot"],
    ])
  })

  test("a result that does not match its command's response is 409 failed", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const answers: [Request, unknown][] = [
      [REQUESTS.act, { done: -1, state: STATE }],
      [REQUESTS.acquire, { lease: 0 }],
      [REQUESTS.acquire, { code: "busy", holder: { title: "Bank\u202e" } }],
      [REQUESTS.status, { ok: true }],
    ]
    for (const [request, answer] of answers) {
      const bridge = await start({ run: async () => answer as never, cancel: () => {} })
      const response = await post(bridge, request)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        ok: false,
        code: "failed",
        error: "The computer could not finish this request.",
      })
    }
    expect(warn.mock.calls.map((call) => call[1])).toEqual(["act", "acquire", "acquire", "status"])
  })

  test("only the declared fields leave main, and undefined optional keys are dropped", async () => {
    const answer = {
      done: 1,
      frame: undefined,
      image: undefined,
      pending: undefined,
      waiting: undefined,
      state: { ...STATE, step: undefined, windowTitle: "Bank statement" },
      windowTitle: "Bank statement",
    }
    const bridge = await start({ run: async () => answer as never, cancel: () => {} })
    const response = await post(bridge, REQUESTS.act)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain("Bank statement")
    expect(JSON.parse(text)).toEqual({ done: 1, state: STATE })
  })

  test("an answer over 8 MiB is 409 frame_too_large; exactly 8 MiB is sent", async () => {
    const prefix = "data:image/png;base64,"
    const encode = Schema.encodeUnknownSync(Computer.BridgeCommands.screenshot.response)
    const overhead = Buffer.byteLength(
      JSON.stringify(encode({ frame: FRAME, image: prefix, visible: [], hiddenCount: 0 })),
    )
    const answer = (bytes: number) => ({
      frame: FRAME,
      image: prefix + "A".repeat(bytes - overhead),
      visible: [],
      hiddenCount: 0,
    })
    const limit = Computer.LIMITS.bridgeResponseBytes
    const fits = await start({ run: async () => answer(limit) as never, cancel: () => {} })
    const sent = await post(fits, REQUESTS.screenshot)
    expect(sent.status).toBe(200)
    expect((await sent.arrayBuffer()).byteLength).toBe(limit)
    const over = await start({ run: async () => answer(limit + 1) as never, cancel: () => {} })
    const refused = await post(over, REQUESTS.screenshot)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      ok: false,
      code: "frame_too_large",
      error: "The computer's answer is too large to send.",
    })
  })

  test("the stub executor answers every command 409 unavailable", async () => {
    const bridge = await start(unavailableExecutor)
    for (const request of Object.values(REQUESTS)) {
      const response = await post(bridge, request)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ ok: false, code: "unavailable", error: "The computer is not available." })
    }
  })

  test("the token is compared with timingSafeEqual over equal lengths, right or wrong", async () => {
    const bridge = await start(recorder(() => STATUS).executor)
    expect((await post(bridge, REQUESTS.status)).status).toBe(200)
    await post(bridge, REQUESTS.status, { authorization: "Bearer short" })
    await post(bridge, REQUESTS.status, { authorization: `Bearer ${bridge.token}${"0".repeat(100)}` })
    expect(compared).toEqual([
      [32, 32],
      [32, 32],
      [32, 32],
    ])
  })

  test("concurrent requests get their own frozen keys with command, root and lease", async () => {
    const both = deferred<void>()
    const record = recorder(async (request) => {
      await both.promise
      return request.command === "heartbeat" ? { state: STATE } : { ok: true }
    })
    const bridge = await start(record.executor)
    const first = post(bridge, { ...REQUESTS.heartbeat, rootSessionID: "ses_a", sessionID: "ses_a" })
    const second = post(bridge, {
      ...REQUESTS.cancel,
      rootSessionID: "ses_b",
      sessionID: "ses_b2",
      directory: "/work/b",
    })
    await record.calls(2)
    both.resolve()
    expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200])
    const keys = record.runs.map((run) => run.key)
    expect(new Set(keys.map((key) => key.id)).size).toBe(2)
    expect(keys.every((key) => Object.isFrozen(key))).toBe(true)
    expect(keys.toSorted((a, b) => a.rootSessionID.localeCompare(b.rootSessionID))).toEqual([
      {
        id: expect.any(Number),
        command: "heartbeat",
        rootSessionID: "ses_a",
        sessionID: "ses_a",
        directory: ENVELOPE.directory,
        lease: 4,
      },
      { id: expect.any(Number), command: "cancel", rootSessionID: "ses_b", sessionID: "ses_b2", directory: "/work/b" },
    ])
    expect("lease" in keys.find((key) => key.command === "cancel")!).toBe(false)
  })

  test("stop() answers an open request 409 unavailable, cancels its work and refuses new connections", async () => {
    const record = recorder(() => new Promise(() => {}))
    const bridge = await start(record.executor)
    const pending = post(bridge, REQUESTS.awaitControl)
    await record.calls(1)
    await bridge.stop()
    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, code: "unavailable", error: "The computer bridge stopped." })
    expect(record.cancels).toEqual([record.runs[0]!.key])
    expect(
      await post(bridge, REQUESTS.status).then(
        () => "answered",
        () => "refused",
      ),
    ).toBe("refused")
    await bridge.stop()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The handler on its own: the client's leaving is the response's close before it finished, as under Node.

const TOKEN = "f".repeat(64)
const HOST = "127.0.0.1:4100"

function request(
  body: string | Readable,
  extra: Record<string, string> = {},
  line = { method: "POST", url: "/computer" },
) {
  const fields: Record<string, string> = {
    host: HOST,
    authorization: `Bearer ${TOKEN}`,
    [PROTOCOL_HEADER]: "1",
    ...extra,
  }
  const stream = typeof body === "string" ? Readable.from([Buffer.from(body)]) : body
  return Object.assign(stream, {
    ...line,
    /** The connection; its 'close' is how a request queued behind another on it learns its client left. */
    socket: new EventEmitter(),
    headers: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name.toLowerCase(), value])),
    rawHeaders: Object.entries(fields).flat(),
  }) as unknown as IncomingMessage
}

/** A response that records what was written; `finish: false` keeps it unfinished, as on a slow connection. */
function response(options = { finish: true }) {
  const ended = deferred<void>()
  const fake = Object.assign(new EventEmitter(), {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: undefined as string | undefined,
    writes: 0,
    writableFinished: false,
    ended: ended.promise,
    writeHead(status: number, headers: Record<string, unknown>) {
      fake.writes++
      fake.status = status
      fake.headers = headers
      return fake
    },
    end(body: string) {
      fake.writes++
      fake.body = body
      ended.resolve()
      if (!options.finish) return fake
      fake.writableFinished = true
      fake.emit("finish")
      fake.emit("close")
      return fake
    },
    /** The client leaves before the answer finished. */
    leave: () => fake.emit("close"),
  })
  return fake
}

function handler(executor: Executor) {
  return createBridgeHandler({ token: TOKEN, host: HOST, executor, capabilities: () => CAPABILITIES })
}

const serve = (bridge: ReturnType<typeof handler>, req: IncomingMessage, res: ReturnType<typeof response>) =>
  bridge.handle(req, res as unknown as ServerResponse)

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("bridge handler", () => {
  test("a client that leaves while a command runs cancels it once, with run's key, and nothing is written", async () => {
    const answer = deferred<unknown>()
    const record = recorder(() => answer.promise)
    const bridge = handler(record.executor)
    const res = response()
    const done = serve(bridge, request(JSON.stringify(REQUESTS.act)), res)
    await record.calls(1)
    res.leave()
    res.leave()
    await record.calls(2)
    answer.resolve({ done: 1, state: STATE })
    await done
    await tick()
    expect(record.cancels).toEqual([record.runs[0]!.key])
    expect(record.cancels[0]).toBe(record.runs[0]!.key)
    expect(res.writes).toBe(0)
  })

  test("a client that leaves after its body is read but before the command starts never starts it", async () => {
    const record = recorder()
    const bridge = handler(record.executor)
    const res = response()
    const req = request(JSON.stringify(REQUESTS.act))
    req.once("end", () => res.leave())
    await serve(bridge, req, res)
    await tick()
    expect(record.runs).toEqual([])
    expect(record.cancels).toEqual([])
    expect(res.writes).toBe(0)
  })

  test("a client that leaves mid-body starts nothing", async () => {
    const record = recorder()
    const bridge = handler(record.executor)
    const res = response()
    const body = new PassThrough()
    const done = serve(bridge, request(body), res)
    body.write(JSON.stringify(REQUESTS.act).slice(0, 20))
    await tick()
    res.leave()
    body.destroy()
    await done
    expect(record.runs).toEqual([])
    expect(record.cancels).toEqual([])
    expect(res.writes).toBe(0)
  })

  test("a close after the answer finished cancels nothing", async () => {
    const record = recorder(() => ({ lease: 3 }))
    const bridge = handler(record.executor)
    const res = response()
    await serve(bridge, request(JSON.stringify(REQUESTS.acquire)), res)
    res.leave()
    await tick()
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body!)).toEqual({ lease: 3 })
    expect(record.cancels).toEqual([])
    expect(record.runs).toHaveLength(1)
  })

  test("an acquire answered with a lease after its client left releases that lease on the same envelope", async () => {
    const answer = deferred<unknown>()
    const record = recorder((request) => (request.command === "acquire" ? answer.promise : { ok: true }))
    const bridge = handler(record.executor)
    const res = response()
    const done = serve(bridge, request(JSON.stringify({ ...REQUESTS.acquire, wait: true })), res)
    await record.calls(1)
    res.leave()
    await record.calls(2)
    answer.resolve({ lease: 9 })
    await done
    await record.calls(3)
    expect(record.cancels).toEqual([record.runs[0]!.key])
    expect(record.runs[1]!.request).toEqual({ ...ENVELOPE, command: "release", lease: 9 })
    expect(record.runs[1]!.key).toEqual({
      ...record.runs[0]!.key,
      id: expect.any(Number),
      command: "release",
      lease: 9,
    })
    expect(record.runs[1]!.key.id).not.toBe(record.runs[0]!.key.id)
    expect(res.writes).toBe(0)
  })

  test("an acquire answered busy or permissions after its client left releases nothing", async () => {
    for (const result of [
      { code: "busy", holder: { title: "Other task" } },
      { code: "permissions", missing: ["screen"] },
    ]) {
      const answer = deferred<unknown>()
      const record = recorder(() => answer.promise)
      const bridge = handler(record.executor)
      const res = response()
      const done = serve(bridge, request(JSON.stringify(REQUESTS.acquire)), res)
      await record.calls(1)
      res.leave()
      answer.resolve(result)
      await done
      await tick()
      expect(record.runs.map((run) => run.request.command)).toEqual(["acquire"])
      expect(record.cancels).toHaveLength(1)
    }
  })

  test("a lease written but cut off before it finished is released, and the settled acquire is not cancelled", async () => {
    const record = recorder((request) => (request.command === "acquire" ? { lease: 5 } : { ok: true }))
    const bridge = handler(record.executor)
    const res = response({ finish: false })
    await serve(bridge, request(JSON.stringify(REQUESTS.acquire)), res)
    expect(JSON.parse(res.body!)).toEqual({ lease: 5 })
    res.leave()
    res.leave()
    await record.calls(2)
    await tick()
    expect(record.cancels).toEqual([])
    expect(record.runs.map((run) => run.request)).toEqual([
      REQUESTS.acquire,
      { ...ENVELOPE, command: "release", lease: 5 },
    ])
  })

  test("a lease that finished reaching the client is never released", async () => {
    const record = recorder((request) => (request.command === "acquire" ? { lease: 5 } : { ok: true }))
    const bridge = handler(record.executor)
    const res = response({ finish: false })
    await serve(bridge, request(JSON.stringify(REQUESTS.acquire)), res)
    res.writableFinished = true
    res.leave()
    await tick()
    expect(record.runs.map((run) => run.request.command)).toEqual(["acquire"])
  })

  test("a request queued on a connection that closes is cancelled, and its late lease released", async () => {
    // Node never fires 'close' on a response queued behind another on a pipelined connection: only the connection's.
    const answer = deferred<unknown>()
    const record = recorder((request) => (request.command === "acquire" ? answer.promise : { ok: true }))
    const bridge = handler(record.executor)
    const req = request(JSON.stringify({ ...REQUESTS.acquire, wait: true }))
    const res = response()
    const done = serve(bridge, req, res)
    await record.calls(1)
    req.socket.emit("close")
    req.socket.emit("close")
    await record.calls(2)
    answer.resolve({ lease: 7 })
    await done
    await record.calls(3)
    expect(record.cancels).toEqual([record.runs[0]!.key])
    expect(record.runs[1]!.request).toEqual({ ...ENVELOPE, command: "release", lease: 7 })
    expect(res.writes).toBe(0)
    expect(req.socket.listenerCount("close")).toBe(0)
  })

  test("an answered request leaves no listener on its connection, and its later close cancels nothing", async () => {
    const record = recorder(() => ({ lease: 3 }))
    const bridge = handler(record.executor)
    const req = request(JSON.stringify(REQUESTS.acquire))
    const res = response()
    await serve(bridge, req, res)
    expect(res.status).toBe(200)
    expect(req.socket.listenerCount("close")).toBe(0)
    req.socket.emit("close")
    await tick()
    expect(record.cancels).toEqual([])
    expect(record.runs.map((run) => run.request.command)).toEqual(["acquire"])
  })

  test("stop() during an acquire cancels it once, answers 409, and releases a lease that arrives later", async () => {
    const answer = deferred<unknown>()
    const record = recorder((request) => (request.command === "acquire" ? answer.promise : { ok: true }))
    const bridge = handler(record.executor)
    const res = response()
    const done = serve(bridge, request(JSON.stringify({ ...REQUESTS.acquire, wait: true })), res)
    await record.calls(1)
    bridge.stop()
    bridge.stop()
    expect(res.status).toBe(409)
    expect(res.headers.connection).toBe("close")
    expect(JSON.parse(res.body!)).toEqual({ ok: false, code: "unavailable", error: "The computer bridge stopped." })
    answer.resolve({ lease: 6 })
    await done
    await record.calls(3)
    expect(record.cancels).toEqual([record.runs[0]!.key])
    expect(record.runs[1]!.request).toEqual({ ...ENVELOPE, command: "release", lease: 6 })
    expect(res.writes).toBe(2)
  })

  test("stop() and the client leaving cancel the same request only once", async () => {
    const record = recorder(() => new Promise(() => {}))
    const bridge = handler(record.executor)
    const res = response({ finish: false })
    void serve(bridge, request(JSON.stringify(REQUESTS.act)), res)
    await record.calls(1)
    bridge.stop()
    res.leave()
    await tick()
    expect(record.cancels).toEqual([record.runs[0]!.key])
  })

  test("stop() answers a request still sending its body and starts nothing; later requests are refused", async () => {
    const record = recorder()
    const bridge = handler(record.executor)
    const res = response()
    const body = new PassThrough()
    const done = serve(bridge, request(body), res)
    body.write(JSON.stringify(REQUESTS.act).slice(0, 20))
    await tick()
    bridge.stop()
    expect(res.status).toBe(409)
    body.end(JSON.stringify(REQUESTS.act).slice(20))
    await done
    const later = response()
    await serve(bridge, request(JSON.stringify(REQUESTS.status)), later)
    expect(later.status).toBe(409)
    expect(JSON.parse(later.body!)).toEqual({ ok: false, code: "unavailable", error: "The computer bridge stopped." })
    const unauthorized = response()
    await serve(bridge, request(JSON.stringify(REQUESTS.status), { authorization: "Bearer nope" }), unauthorized)
    expect(unauthorized.status).toBe(401)
    expect(record.runs).toEqual([])
  })

  test("a refused request's body is never read, and its connection is closed after the answer", async () => {
    const record = recorder()
    const bridge = handler(record.executor)
    const cases: [Record<string, string>, { method: string; url: string }, number][] = [
      [{ authorization: "Bearer nope" }, { method: "POST", url: "/computer" }, 401],
      [{}, { method: "POST", url: "/elsewhere" }, 404],
      [{ [PROTOCOL_HEADER]: "2" }, { method: "POST", url: "/computer" }, 426],
      [{ "content-length": "65537" }, { method: "POST", url: "/computer" }, 413],
    ]
    for (const [extra, line, status] of cases) {
      const body = new PassThrough()
      body.write("x".repeat(1000))
      const res = response()
      await serve(bridge, request(body, extra, line), res)
      expect(res.status).toBe(status)
      expect(res.headers.connection).toBe("close")
      expect(body.readableFlowing).toBe(null)
      expect(body.readableLength).toBe(1000)
    }
    expect(record.runs).toEqual([])
  })

  test("a Host header sent twice is 401, even when both are right", async () => {
    const record = recorder()
    const bridge = handler(record.executor)
    const req = request(JSON.stringify(REQUESTS.status))
    req.rawHeaders.push("Host", HOST)
    const res = response()
    await serve(bridge, req, res)
    expect(res.status).toBe(401)
    expect(record.runs).toEqual([])
  })

  test("a failing cancel, a run that fails after its client left and a failing release are logged, never thrown", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    // An act whose cancel rejects, and which then fails itself after its client left.
    const act = deferred<unknown>()
    const first = response()
    const firstDone = serve(
      handler({ run: () => act.promise as never, cancel: () => Promise.reject(new EvalError("cancel failed")) }),
      request(JSON.stringify(REQUESTS.act)),
      first,
    )
    await tick()
    first.leave()
    await tick()
    act.reject(new Error("the act failed after its client left"))
    await firstDone
    // An acquire whose cancel throws, and whose late lease cannot be released.
    const lease = deferred<unknown>()
    const second = response()
    const secondDone = serve(
      handler({
        run: (request) =>
          (request.command === "release" ? Promise.reject(new RangeError("release failed")) : lease.promise) as never,
        cancel: () => {
          throw new SyntaxError("cancel failed")
        },
      }),
      request(JSON.stringify(REQUESTS.acquire)),
      second,
    )
    await tick()
    second.leave()
    lease.resolve({ lease: 2 })
    await secondDone
    await tick()
    expect(first.writes + second.writes).toBe(0)
    expect(warn.mock.calls).toEqual([
      ["Computer bridge cancel failed", "act", "EvalError"],
      ["Computer bridge command failed", "act", "Error"],
      ["Computer bridge cancel failed", "acquire", "SyntaxError"],
      ["Computer bridge release failed", "RangeError"],
    ])
  })

  test("a result that does not match its command after its client left is logged and releases nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const answer = deferred<unknown>()
    const record = recorder(() => answer.promise)
    const bridge = handler(record.executor)
    const res = response()
    const done = serve(bridge, request(JSON.stringify(REQUESTS.acquire)), res)
    await record.calls(1)
    res.leave()
    answer.resolve({ lease: 0 })
    await done
    await tick()
    expect(record.runs.map((run) => run.request.command)).toEqual(["acquire"])
    expect(res.writes).toBe(0)
    expect(warn.mock.calls).toEqual([["Computer bridge result does not match its command", "acquire"]])
  })

  test("a cancelled run that settles with a code the wire does not know is logged, and a known one is not", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    for (const code of ["halted", "stopped"]) {
      const answer = deferred<unknown>()
      const record = recorder(() => answer.promise)
      const res = response()
      const done = serve(handler(record.executor), request(JSON.stringify(REQUESTS.act)), res)
      await record.calls(1)
      res.leave()
      await record.calls(2)
      answer.reject(new ComputerError(code as Computer.ComputerErrorCode, "The act was stopped."))
      await done
      expect(record.cancels).toEqual([record.runs[0]!.key])
      expect(res.writes).toBe(0)
    }
    expect(warn.mock.calls).toEqual([["Computer bridge error code is not known", "act"]])
  })
})
