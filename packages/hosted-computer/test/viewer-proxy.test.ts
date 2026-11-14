import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import net, { type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hosted } from "@vectordevai/schema/hosted"
import { ClientFilter, MESSAGE, VERSION } from "../src/rfb"
import { checkViewerToken, createViewerProxy, PAGE_HEADERS, parseState, UsedTokens, type ViewerState } from "../src/viewer-proxy"
import { acceptKey, checkUpgrade, encodeFrame, FrameReader, OPCODE } from "../src/websocket"

// WP A54: the viewer proxy is the computer's only network listener. A connection needs a single-use, five-minute viewer
// token for this session (WP A53's format, signed with the key the heartbeat carries); "view" gets the picture only,
// whatever the page sends; "control" gives input only during a take-over and ends with it. VNC is a Unix socket.

const SESSION = `hs_${"c".repeat(26)}`
const NOW = 1_800_000_000_000
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const KEY = (publicKey.export({ format: "jwk" }) as { x: string }).x
const STATE: ViewerState = { session: SESSION, key: KEY, control: "agent", updatedAt: NOW }

function mint(claims: Record<string, unknown> = {}, key = privateKey) {
  const iat = Math.floor(NOW / 1000)
  const payload = Buffer.from(
    JSON.stringify({ aud: "vector-viewer", sid: SESSION, computer: "vh-0123456789abcdef-1", mode: "view", jti: randomBytes(16).toString("base64url"), iat, exp: iat + 300, ...claims }),
  ).toString("base64url")
  const signature = sign(null, Buffer.from(Hosted.VIEWER_TOKEN_CONTEXT + payload), key).toString("base64url")
  return `${Hosted.VIEWER_TOKEN_PREFIX}.${payload}.${signature}`
}

describe("viewer tokens", () => {
  test("a token for this session, signed with the heartbeat's key and unexpired, is accepted", () => {
    expect(checkViewerToken(mint(), STATE, NOW)).toMatchObject({ sid: SESSION, mode: "view" })
    expect(checkViewerToken(mint({ mode: "control" }), STATE, NOW)).toMatchObject({ mode: "control" })
  })

  test("another key, session, audience, mode or a token past its five minutes is refused", () => {
    const other = generateKeyPairSync("ed25519").privateKey
    expect(checkViewerToken(mint({}, other), STATE, NOW)).toBeUndefined()
    expect(checkViewerToken(mint({ sid: `hs_${"d".repeat(26)}` }), STATE, NOW)).toBeUndefined()
    expect(checkViewerToken(mint({ aud: "vector-relay" }), STATE, NOW)).toBeUndefined()
    expect(checkViewerToken(mint({ mode: "admin" }), STATE, NOW)).toBeUndefined()
    expect(checkViewerToken(mint({ computer: "../etc" }), STATE, NOW)).toBeUndefined()
    expect(checkViewerToken(mint(), STATE, NOW + Hosted.VIEWER_TOKEN_MS)).toBeUndefined()
    const iat = Math.floor(NOW / 1000)
    expect(checkViewerToken(mint({ exp: iat + 3600 }), STATE, NOW)).toBeUndefined()
    const token = mint()
    const flipped = token.slice(0, -10) + (token.at(-10) === "A" ? "B" : "A") + token.slice(-9)
    expect(checkViewerToken(flipped, STATE, NOW)).toBeUndefined()
    expect(checkViewerToken("vvt1.e30.x", STATE, NOW)).toBeUndefined()
  })

  test("each token is used once on this computer, and the record forgets expired ones", () => {
    const used = new UsedTokens()
    expect(used.claim("jti-1", NOW / 1000 + 300, NOW)).toBe(true)
    expect(used.claim("jti-1", NOW / 1000 + 300, NOW)).toBe(false)
    expect(used.claim("jti-1", NOW / 1000 + 300, NOW + 301_000)).toBe(true)
  })

  test("hostd's state file is read only when every field is well formed", () => {
    expect(parseState(JSON.stringify(STATE))).toEqual(STATE)
    expect(parseState(JSON.stringify({ ...STATE, control: "everyone" }))).toBeUndefined()
    expect(parseState(JSON.stringify({ ...STATE, key: "short" }))).toBeUndefined()
    expect(parseState("not json")).toBeUndefined()
  })
})

describe("what a viewer may send to the VNC server", () => {
  const handshake = Buffer.concat([Buffer.from(VERSION, "latin1"), Buffer.from([1]), Buffer.from([0])])
  const pointer = Buffer.from([MESSAGE.pointer, 1, 0, 10, 0, 20])
  const key = Buffer.from([MESSAGE.key, 1, 0, 0, 0, 0, 0, 0x61])
  const cut = Buffer.concat([Buffer.from([MESSAGE.cutText, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")])
  const update = Buffer.from([MESSAGE.updateRequest, 1, 0, 0, 0, 0, 5, 0, 3, 32])

  test("view mode passes the handshake and update requests but drops keys, pointer and clipboard", () => {
    const filter = new ClientFilter(() => false)
    const out = Buffer.concat(filter.push(Buffer.concat([handshake, pointer, key, cut, update])))
    // The shared flag is forced on: the viewer sent 0, the server receives 1.
    expect(out).toEqual(Buffer.concat([Buffer.from(VERSION, "latin1"), Buffer.from([1]), Buffer.from([1]), update]))
    expect(filter.dropped).toBe(3)
  })

  test("control mode passes input, also when it arrives a byte at a time", () => {
    const filter = new ClientFilter(() => true)
    const all = Buffer.concat([handshake, pointer, key])
    const out: Buffer[] = []
    for (const byte of all) out.push(...filter.push(Buffer.from([byte])))
    expect(Buffer.concat(out).subarray(handshake.length)).toEqual(Buffer.concat([pointer, key]))
  })

  test("other versions, a VNC password, unknown messages and oversized fields end the connection", () => {
    expect(() => new ClientFilter(() => true).push(Buffer.from("RFB 003.003\n"))).toThrow()
    expect(() => new ClientFilter(() => true).push(Buffer.concat([Buffer.from(VERSION), Buffer.from([2])]))).toThrow()
    expect(() => new ClientFilter(() => true).push(Buffer.concat([handshake, Buffer.from([250])]))).toThrow()
    expect(() => new ClientFilter(() => true).push(Buffer.concat([handshake, Buffer.from([MESSAGE.setEncodings, 0, 0x01, 0])]))).toThrow()
    expect(() =>
      new ClientFilter(() => true).push(Buffer.concat([handshake, Buffer.from([MESSAGE.cutText, 0, 0, 0, 0x7f, 0, 0, 0])])),
    ).toThrow()
  })
})

describe("WebSocket frames", () => {
  test("the accept key follows RFC 6455's example", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  })

  test("only a same-origin version-13 upgrade is accepted", () => {
    const headers = {
      upgrade: "websocket",
      connection: "keep-alive, Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      origin: "https://sb.example.test",
    }
    const same = (origin: string) => origin === "https://sb.example.test"
    expect(checkUpgrade(headers, same)).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    expect(checkUpgrade({ ...headers, origin: "https://evil.example" }, same)).toBeUndefined()
    expect(checkUpgrade({ ...headers, origin: undefined }, same)).toBeUndefined()
    expect(checkUpgrade({ ...headers, "sec-websocket-version": "8" }, same)).toBeUndefined()
  })

  test("client frames must be masked; fragments join; big frames are refused", () => {
    const reader = new FrameReader()
    expect(() => reader.push(encodeFrame(OPCODE.text, Buffer.from("hi")))).toThrow()
    const masked = (opcode: number, data: Buffer, fin = true) => {
      const mask = randomBytes(4)
      return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length]), mask, Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]!))])
    }
    const joined = new FrameReader().push(Buffer.concat([masked(OPCODE.binary, Buffer.from("ab"), false), masked(OPCODE.continuation, Buffer.from("cd"))]))
    expect(joined).toEqual([{ opcode: OPCODE.binary, data: Buffer.from("abcd") }])
    const huge = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x7f, 0, 0, 0])
    expect(() => new FrameReader().push(huge)).toThrow()
  })
})

// ── The proxy, end to end, with a stand-in VNC server on a Unix socket ─────────────────────────────────────────────

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function proxyWorld(initial: ViewerState = STATE) {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-viewer-"))
  const socketPath = path.join(dir, "vnc.sock")
  const received: Buffer[] = []
  const vnc = net.createServer((client) => {
    client.write(VERSION)
    client.on("data", (chunk) => received.push(chunk))
  })
  await new Promise<void>((resolve) => vnc.listen(socketPath, resolve))
  let state: ViewerState | undefined = initial
  const proxy = createViewerProxy({
    vncSocket: socketPath,
    readState: async () => state,
    page: { html: "<!doctype html><title>Live view</title>", script: "/* viewer */" },
    clock: () => NOW,
    origin: (origin, host) => origin === `https://${host}`,
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const port = (proxy.address() as AddressInfo).port
  cleanups.push(() => {
    proxy.close()
    vnc.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { port, received, setState: (next: ViewerState | undefined) => (state = next) }
}

/** A masked client frame, with the 16-bit length form for payloads over 125 bytes (a viewer token is longer). */
function clientFrame(opcode: number, data: Buffer) {
  const mask = randomBytes(4)
  const header = data.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | data.length]) : Buffer.from([0x80 | opcode, 0x80 | 126, data.length >> 8, data.length & 255])
  return Buffer.concat([header, mask, Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]!))])
}

/** A raw WebSocket client: upgrades, sends the token, then hands back a way to send binary frames and read events. */
function connect(port: number, token: string, origin = `https://127.0.0.1:${port}`) {
  const socket = net.connect(port, "127.0.0.1")
  const events: { binary: Buffer[]; close?: number; status?: string } = { binary: [] }
  let buffer = Buffer.alloc(0)
  let upgraded = false
  const frame = (opcode: number, data: Buffer) => socket.write(clientFrame(opcode, data))
  socket.on("connect", () =>
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
    ),
  )
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n")
      if (end < 0) return
      events.status = buffer.subarray(0, buffer.indexOf("\r\n")).toString()
      if (!events.status.includes("101")) return
      upgraded = true
      buffer = buffer.subarray(end + 4)
      frame(OPCODE.text, Buffer.from(token))
    }
    while (buffer.length >= 2) {
      const length = buffer[1]! & 0x7f
      if (length > 125 || buffer.length < 2 + length) break
      const opcode = buffer[0]! & 0x0f
      const data = buffer.subarray(2, 2 + length)
      buffer = buffer.subarray(2 + length)
      if (opcode === OPCODE.close) events.close = data.readUInt16BE(0)
      if (opcode === OPCODE.binary) events.binary.push(Buffer.from(data))
    }
  })
  socket.on("error", () => {})
  cleanups.push(() => socket.destroy())
  return { events, send: (data: Buffer) => frame(OPCODE.binary, data) }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
  return check()
}

describe("the proxy", () => {
  test("a view token gets the VNC server's picture; its keys and pointer never reach the server", async () => {
    const w = await proxyWorld()
    const viewer = connect(w.port, mint())
    expect(await until(() => viewer.events.binary.length > 0)).toBe(true)
    expect(Buffer.concat(viewer.events.binary).toString("latin1")).toBe(VERSION)
    viewer.send(Buffer.concat([Buffer.from(VERSION), Buffer.from([1, 0])]))
    viewer.send(Buffer.from([MESSAGE.pointer, 1, 0, 10, 0, 20]))
    viewer.send(Buffer.from([MESSAGE.updateRequest, 0, 0, 0, 0, 0, 5, 0, 3, 32]))
    expect(await until(() => Buffer.concat(w.received).length >= 24)).toBe(true)
    const sent = Buffer.concat(w.received)
    expect(sent.subarray(12, 14)).toEqual(Buffer.from([1, 1]))
    expect(sent.subarray(14)).toEqual(Buffer.from([MESSAGE.updateRequest, 0, 0, 0, 0, 0, 5, 0, 3, 32]))
  })

  test("a token works once; a second connection with it is closed with 4003", async () => {
    const w = await proxyWorld()
    const token = mint()
    const first = connect(w.port, token)
    expect(await until(() => first.events.binary.length > 0)).toBe(true)
    const second = connect(w.port, token)
    expect(await until(() => second.events.close !== undefined)).toBe(true)
    expect(second.events.close).toBe(4003)
  })

  test("a control token gives input during a take-over, and loses the connection when control goes back", async () => {
    const w = await proxyWorld({ ...STATE, control: "person" })
    const viewer = connect(w.port, mint({ mode: "control" }))
    expect(await until(() => viewer.events.binary.length > 0)).toBe(true)
    viewer.send(Buffer.concat([Buffer.from(VERSION), Buffer.from([1, 1])]))
    viewer.send(Buffer.from([MESSAGE.pointer, 1, 0, 10, 0, 20]))
    expect(await until(() => Buffer.concat(w.received).length >= 20)).toBe(true)
    expect(Buffer.concat(w.received).subarray(14)).toEqual(Buffer.from([MESSAGE.pointer, 1, 0, 10, 0, 20]))
    w.setState({ ...STATE, control: "agent" })
    expect(await until(() => viewer.events.close !== undefined, 4000)).toBe(true)
    expect(viewer.events.close).toBe(4001)
  })

  test("before the first heartbeat (no key yet) nothing is accepted; another origin cannot upgrade", async () => {
    const w = await proxyWorld()
    w.setState(undefined)
    const early = connect(w.port, mint())
    expect(await until(() => early.events.close !== undefined)).toBe(true)
    expect(early.events.close).toBe(4003)
    w.setState(STATE)
    const foreign = connect(w.port, mint(), "https://attacker.example")
    expect(await until(() => foreign.events.status !== undefined)).toBe(true)
    expect(foreign.events.status).toContain("400")
  })

  test("the page is served with a strict policy; nothing else is", async () => {
    const w = await proxyWorld()
    const page = await fetch(`http://127.0.0.1:${w.port}/`)
    expect(page.status).toBe(200)
    for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(page.headers.get(name)).toBe(value)
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect((await fetch(`http://127.0.0.1:${w.port}/state.json`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${w.port}/`, { method: "POST" })).status).toBe(405)
  })
})
