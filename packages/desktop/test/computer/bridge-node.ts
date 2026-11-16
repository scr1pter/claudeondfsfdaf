// D13: checks the bundled Hands bridge under Node's own node:http, where a client that leaves is reported (Bun's
// node:http never reports it, so the Bun unit test drives those paths through createBridgeHandler instead).
// Usage: node ./test/computer/bridge-node.ts <bundle.mjs>, after
// bun build ./src/main/computer-bridge.ts --target=node --format=esm --outfile <bundle.mjs>.
// Everything stays on 127.0.0.1 with a recording executor; nothing touches the screen, input or OS permissions.

import assert from "node:assert/strict"
import { connect, type Socket } from "node:net"
import { pathToFileURL } from "node:url"

type Bridge = typeof import("../../src/main/computer-bridge")
type Key = import("../../src/main/computer-bridge").ComputerBridgeKey
type Executor = import("../../src/main/computer-bridge").ComputerExecutor
type Request = Parameters<Executor["run"]>[0]

const bundle = process.argv[2]
if (!bundle) {
  console.error("usage: node ./test/computer/bridge-node.ts <bundle.mjs>")
  process.exit(2)
}
const { startComputerBridge }: Bridge = await import(pathToFileURL(bundle).href)

const BOUND_MS = 1000
// Windows retries a SYN that an RST refused (TcpMaxConnectRetransmissions) before it reports ECONNREFUSED, about 1 to
// 2 s even on loopback, so the case that waits for that refusal is bounded by this instead. It is not a bridge
// deadline: that case still requires stop() to resolve in under 900 ms.
const REFUSED_BOUND_MS = 5000
const ENVELOPE = { v: 1, rootSessionID: "ses_root", sessionID: "ses_child", directory: "/work/receipts" } as const
const CAPABILITIES = {
  protocol: 1,
  available: true,
  backend: "fake",
  actions: [],
  features: { background: false, uiTree: false, zoom: false, clipboard: false, locked: false },
} as const

/** A promise with its resolve, for answers a case decides later. */
function deferred<T>() {
  const handle: { resolve: (value: T) => void; promise: Promise<T> } = {
    resolve: () => {},
    promise: Promise.resolve() as Promise<T>,
  }
  handle.promise = new Promise<T>((resolve) => (handle.resolve = resolve))
  return handle
}

/** An executor that records every call and lets the case answer each run. */
function recorder(answer: (request: Request, key: Key) => Promise<unknown>) {
  const runs: { request: Request; key: Key }[] = []
  const cancels: Key[] = []
  const waiting: { count: number; done: () => void }[] = []
  const notify = () =>
    waiting.filter((item) => runs.length + cancels.length >= item.count).forEach((item) => item.done())
  const executor = {
    run: (request: Request, key: Key) => {
      runs.push({ request, key })
      notify()
      return answer(request, key)
    },
    cancel: (key: Key) => {
      cancels.push(key)
      notify()
    },
  } as Executor
  /** Resolves once runs and cancels together reach `count`. */
  const calls = (count: number) =>
    new Promise<void>((done) => {
      waiting.push({ count, done })
      notify()
    })
  return { executor, runs, cancels, calls }
}

async function start(answer: (request: Request, key: Key) => Promise<unknown>) {
  const record = recorder(answer)
  const bridge = await startComputerBridge({ executor: record.executor, capabilities: () => CAPABILITIES })
  const port = Number(new URL(bridge.url).port)
  return { ...record, bridge, port }
}

function head(port: number, token: string, length?: number) {
  return [
    "POST /computer HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${token}`,
    "Vector-Computer-Protocol: 1",
    "Content-Type: application/json",
    length === undefined ? "Transfer-Encoding: chunked" : `Content-Length: ${length}`,
    "",
    "",
  ].join("\r\n")
}

/** A raw connection that collects what the server sends and resolves when the server ends it. */
function open(port: number) {
  const socket = connect(port, "127.0.0.1")
  const received = { text: "" }
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  socket.on("data", (chunk: Buffer) => (received.text += chunk.toString("latin1")))
  socket.on("error", () => {})
  return { socket, received, ended, connected: new Promise<void>((resolve) => socket.once("connect", () => resolve())) }
}

/** Writes chunks until the server closes the connection; returns how many it wrote. */
function stream(socket: Socket) {
  const chunk = `2000\r\n${"x".repeat(0x2000)}\r\n`
  const state = { writes: 0 }
  const timer = setInterval(() => {
    if (socket.destroyed || !socket.writable) return clearInterval(timer)
    socket.write(chunk)
    state.writes++
  }, 2)
  return { state, stop: () => clearInterval(timer) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const CASES: [name: string, run: () => Promise<void>, bound?: number][] = [
  [
    "a client that leaves while an act runs cancels it with run's key",
    async () => {
      const t = await start(() => new Promise(() => {}))
      const body = JSON.stringify({
        ...ENVELOPE,
        command: "act",
        lease: 4,
        steps: [{ kind: "wait", ms: 1 }],
        settleMs: 0,
      })
      const client = open(t.port)
      await client.connected
      client.socket.write(head(t.port, t.bridge.token, Buffer.byteLength(body)) + body)
      await t.calls(1)
      client.socket.destroy()
      await t.calls(2)
      assert.equal(t.cancels.length, 1)
      assert.equal(t.cancels[0], t.runs[0]!.key)
      assert.deepEqual(t.runs[0]!.key, {
        id: 1,
        command: "act",
        rootSessionID: "ses_root",
        sessionID: "ses_child",
        directory: "/work/receipts",
        lease: 4,
      })
      assert.equal(client.received.text, "")
      await t.bridge.stop()
    },
  ],
  [
    "a client that sends a whole act and leaves at once never leaves it running uncancelled",
    async () => {
      const t = await start(() => new Promise(() => {}))
      const body = JSON.stringify({
        ...ENVELOPE,
        command: "act",
        lease: 4,
        steps: [{ kind: "wait", ms: 1 }],
        settleMs: 0,
      })
      const client = open(t.port)
      await client.connected
      client.socket.end(head(t.port, t.bridge.token, Buffer.byteLength(body)) + body)
      client.socket.destroy()
      await sleep(200)
      assert.equal(t.cancels.length, t.runs.length)
      assert.ok(t.cancels.every((key, index) => key === t.runs[index]!.key))
      await t.bridge.stop()
    },
  ],
  [
    "an acquire whose client left before its lease arrived is released on the same envelope",
    async () => {
      const lease = deferred<unknown>()
      const t = await start((request) =>
        request.command === "acquire" ? lease.promise : Promise.resolve({ ok: true }),
      )
      const body = JSON.stringify({ ...ENVELOPE, command: "acquire", title: "Receipts", wait: true })
      const client = open(t.port)
      await client.connected
      client.socket.write(head(t.port, t.bridge.token, Buffer.byteLength(body)) + body)
      await t.calls(1)
      client.socket.destroy()
      await t.calls(2)
      lease.resolve({ lease: 7 })
      await t.calls(3)
      assert.equal(t.cancels[0], t.runs[0]!.key)
      assert.deepEqual(t.runs[1]!.request, { ...ENVELOPE, command: "release", lease: 7 })
      assert.equal(t.runs[1]!.key.command, "release")
      assert.equal(t.runs[1]!.key.lease, 7)
      await t.bridge.stop()
    },
  ],
  [
    "a client that pipelines an act and an acquire, then leaves, cancels both and gets its late lease released",
    async () => {
      // Node fires no 'close' on a response queued behind another; only the connection's close shows the leave.
      const lease = deferred<unknown>()
      const t = await start((request) =>
        request.command === "acquire"
          ? lease.promise
          : request.command === "release"
            ? Promise.resolve({ ok: true })
            : new Promise(() => {}),
      )
      const act = JSON.stringify({
        ...ENVELOPE,
        command: "act",
        lease: 4,
        steps: [{ kind: "wait", ms: 1 }],
        settleMs: 0,
      })
      const acquire = JSON.stringify({ ...ENVELOPE, command: "acquire", title: "Receipts", wait: true })
      const client = open(t.port)
      await client.connected
      client.socket.write(
        head(t.port, t.bridge.token, Buffer.byteLength(act)) +
          act +
          head(t.port, t.bridge.token, Buffer.byteLength(acquire)) +
          acquire,
      )
      await t.calls(2)
      assert.deepEqual(
        t.runs.map((run) => run.request.command),
        ["act", "acquire"],
      )
      client.socket.destroy()
      await t.calls(4)
      const cancelled = t.cancels.toSorted((a, b) => a.id - b.id)
      assert.equal(cancelled.length, 2)
      assert.ok(cancelled.every((key, index) => key === t.runs[index]!.key))
      lease.resolve({ lease: 7 })
      await t.calls(5)
      assert.deepEqual(t.runs[2]!.request, { ...ENVELOPE, command: "release", lease: 7 })
      assert.equal(client.received.text, "")
      await t.bridge.stop()
    },
  ],
  [
    "requests answered one after another on a keep-alive connection leave no listeners behind on it",
    async () => {
      // Each request watches its connection's close; the eleventh listener would print MaxListenersExceededWarning.
      const warnings: string[] = []
      const record = (warning: Error) => warnings.push(warning.name)
      process.on("warning", record)
      const t = await start(() => Promise.resolve({ ok: true }))
      const body = JSON.stringify({ ...ENVELOPE, command: "cancel" })
      const client = open(t.port)
      await client.connected
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        client.socket.write(head(t.port, t.bridge.token, Buffer.byteLength(body)) + body)
        while (client.received.text.split("HTTP/1.1 200 ").length <= count) await sleep(2)
      }
      await sleep(20)
      process.off("warning", record)
      assert.equal(t.runs.length, 12)
      assert.equal(t.cancels.length, 0)
      assert.deepEqual(warnings, [])
      client.socket.destroy()
      await t.bridge.stop()
    },
  ],
  [
    "a request answered normally is neither cancelled nor released",
    async () => {
      // Answered after its body was read: Node has already fired the request's own 'close' by then.
      const t = await start(() => sleep(50).then(() => ({ lease: 3 })))
      const response = await fetch(`${t.bridge.url}/computer`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.bridge.token}`, "vector-computer-protocol": "1" },
        body: JSON.stringify({ ...ENVELOPE, command: "acquire", title: "Receipts" }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { lease: 3 })
      await sleep(100)
      assert.equal(t.runs.length, 1)
      assert.equal(t.cancels.length, 0)
      await t.bridge.stop()
    },
  ],
  [
    "stop() ends a pending long poll with 409 unavailable, cancels it, resolves, and refuses new connections",
    async () => {
      const t = await start(() => new Promise(() => {}))
      const pending = fetch(`${t.bridge.url}/computer`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.bridge.token}`, "vector-computer-protocol": "1" },
        body: JSON.stringify({ ...ENVELOPE, command: "awaitControl", lease: 2 }),
      })
      await t.calls(1)
      const started = Date.now()
      await t.bridge.stop()
      // The 1 s cut is a fallback; a stop that needed it would mean a connection was left open.
      assert.ok(Date.now() - started < 900, `stop took ${Date.now() - started} ms`)
      const response = await pending
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { ok: false, code: "unavailable", error: "The computer bridge stopped." })
      assert.equal(t.cancels.length, 1)
      assert.equal(t.cancels[0], t.runs[0]!.key)
      const refused = await new Promise<string>((resolve) => {
        const socket = connect(t.port, "127.0.0.1")
        socket.once("connect", () => resolve("connected"))
        socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"))
      })
      assert.equal(refused, "ECONNREFUSED")
    },
    REFUSED_BOUND_MS,
  ],
  [
    "a body past 64 KiB is answered 413 while the client is still sending, and the connection closes",
    async () => {
      const t = await start(() => Promise.resolve({ ok: true }))
      const client = open(t.port)
      await client.connected
      client.socket.write(head(t.port, t.bridge.token))
      const sender = stream(client.socket)
      await client.ended
      sender.stop()
      assert.match(client.received.text, /^HTTP\/1\.1 413 /)
      assert.match(client.received.text, /\r\nconnection: close\r\n/i)
      // 64 KiB + 1 needs nine 8 KiB chunks; the server answered long before the client would have stopped.
      assert.ok(sender.state.writes >= 9, `only ${sender.state.writes} chunks were written`)
      assert.equal(t.runs.length, 0)
      await t.bridge.stop()
    },
  ],
  [
    "a request with a wrong token is answered 401 and its endless body is not drained",
    async () => {
      const t = await start(() => Promise.resolve({ ok: true }))
      const client = open(t.port)
      await client.connected
      client.socket.write(head(t.port, "0".repeat(64)))
      const sender = stream(client.socket)
      await client.ended
      sender.stop()
      assert.match(client.received.text, /^HTTP\/1\.1 401 /)
      assert.equal(t.runs.length, 0)
      await t.bridge.stop()
    },
  ],
]

const failed: string[] = []
for (const [name, run, bound = BOUND_MS] of CASES) {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const bounded = new Promise<never>((_, reject) => {
    timer.id = setTimeout(() => reject(new Error(`did not finish within ${bound} ms`)), bound)
  })
  const result = await Promise.race([run(), bounded]).then(
    () => undefined,
    (error: unknown) => error,
  )
  clearTimeout(timer.id)
  if (result === undefined) {
    console.log(`pass: ${name}`)
    continue
  }
  failed.push(name)
  console.error(`FAIL: ${name}\n  ${result instanceof Error ? result.message : String(result)}`)
}
console.log(`${CASES.length - failed.length}/${CASES.length} bridge checks passed under Node ${process.version}`)
process.exit(failed.length ? 1 : 0)
