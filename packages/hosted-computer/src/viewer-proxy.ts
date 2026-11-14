import { createPublicKey, verify, type KeyObject } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { connect, createServer, type Server, type Socket } from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Hosted } from "@vectordevai/schema/hosted"
import { VIEWER_STATE, VNC_SOCKET } from "./limits"
import { ClientFilter } from "./rfb"
import { checkUpgrade, encodeFrame, FrameReader, OPCODE } from "./websocket"

/*
 * The viewer proxy (contract WP A54): the cloud computer's only listener on the network (Hosted.VIEWER_PORT), run as
 * its own unprivileged user. It serves the live view page and bridges it to the computer's VNC server, which listens on
 * a Unix socket only this user can reach (never TCP). A connection needs a viewer token (WP A53's `vvt1.` format):
 * signed by Vector with the key the session's heartbeat carries, for this session, unexpired and never used before on
 * this computer. The page reads the token from its URL fragment and sends it as the first WebSocket message, so it never
 * appears in a request line or a log. "view" tokens get the picture only: the proxy drops their keyboard, pointer and
 * clipboard messages. "control" tokens give input only while the person holds a take-over, and lose the connection
 * when control goes back to the agent.
 */

/** What hostd tells the proxy (a file on a memory disk only hostd writes). */
export type ViewerState = { session: string; key: string; control: "agent" | "person"; updatedAt: number }

export type ViewerClaims = { aud: string; sid: string; computer: string; mode: Hosted.ViewerMode; jti: string; iat: number; exp: number }

const COMPUTER = /^vh-[a-f0-9]{16}-[1-9]$/
const MAX_CONNECTIONS = 4
const ATTEMPTS_PER_MINUTE = 30
const TOKEN_WAIT_MS = 5_000
const STATE_POLL_MS = 1_000

/** Parses hostd's state file; undefined unless every field is well formed. */
export function parseState(text: string): ViewerState | undefined {
  try {
    const value = JSON.parse(text) as Partial<ViewerState>
    if (
      typeof value.session === "string" &&
      Hosted.SESSION_ID.test(value.session) &&
      typeof value.key === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.key) &&
      (value.control === "agent" || value.control === "person") &&
      typeof value.updatedAt === "number"
    )
      return value as ViewerState
  } catch {}
  return undefined
}

/**
 * Checks a viewer token as WP A53's reference check does (signature, audience, mode, lifetime), for this computer's
 * session. The computer's own name is not known on the computer, and a session runs on exactly one computer, so the
 * session is what binds a token here; the name must still be well formed.
 */
export function checkViewerToken(token: string, state: ViewerState, now: number): ViewerClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== Hosted.VIEWER_TOKEN_PREFIX) return undefined
  if (!/^[A-Za-z0-9_-]{16,2048}$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2]!)) return undefined
  let key: KeyObject
  try {
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: state.key }, format: "jwk" })
  } catch {
    return undefined
  }
  if (!verify(null, Buffer.from(Hosted.VIEWER_TOKEN_CONTEXT + parts[1]), key, Buffer.from(parts[2]!, "base64url"))) return undefined
  let claims: ViewerClaims
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as ViewerClaims
  } catch {
    return undefined
  }
  const seconds = Math.floor(now / 1000)
  if (
    claims.aud !== "vector-viewer" ||
    claims.sid !== state.session ||
    typeof claims.computer !== "string" ||
    !COMPUTER.test(claims.computer) ||
    !Hosted.VIEWER_MODES.includes(claims.mode) ||
    typeof claims.jti !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(claims.jti) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !(claims.exp > seconds) ||
    claims.iat > seconds + 60 ||
    claims.exp - claims.iat > Hosted.VIEWER_TOKEN_MS / 1000
  )
    return undefined
  return claims
}

/** The jtis this computer accepted, each kept until its token would have expired anyway. */
export class UsedTokens {
  private readonly used = new Map<string, number>()

  /** Records a jti; false when it was used before (a replay). */
  claim(jti: string, exp: number, now: number) {
    for (const [key, until] of this.used) if (until * 1000 <= now) this.used.delete(key)
    if (this.used.has(jti)) return false
    if (this.used.size >= 10_000) return false
    this.used.set(jti, exp)
    return true
  }
}

export type ProxyOptions = {
  port?: number
  host?: string
  vncSocket?: string
  readState?: () => Promise<ViewerState | undefined>
  page?: { html: string; script: string }
  clock?: () => number
  /** Origins allowed to open the live view socket; by default the page's own (https and the request's Host). */
  origin?: (origin: string, host: string) => boolean
  dial?: (socketPath: string) => Socket
}

const sameOrigin = (origin: string, host: string) => origin === `https://${host}`

/** The live view page's security headers: nothing loads but its own script; it may not be framed by others. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://vectordev.ai https://remote.vectordev.ai",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
}

/** One HTTP request head: method, path and lower-cased headers. Undefined when it is not one. */
export function parseHead(text: string) {
  const lines = text.split("\r\n")
  const match = /^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "")
  if (!match) return undefined
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim()
  }
  return { method: match[1]!, path: match[2]!, headers }
}

const MAX_HEAD = 8 * 1024

/**
 * The proxy's server. It speaks just enough HTTP/1.1 itself (a request head, one answer, then close or upgrade), so the
 * same code runs on Node in the image and under the tests.
 */
export function createViewerProxy(options: ProxyOptions = {}): Server {
  const clock = options.clock ?? Date.now
  const readState =
    options.readState ??
    (async () => parseState(await readFile(VIEWER_STATE, "utf8").catch(() => "")))
  const origin = options.origin ?? sameOrigin
  const dial = options.dial ?? ((socketPath: string) => connect(socketPath))
  const page = options.page ?? loadPage()
  const used = new UsedTokens()
  const open = new Set<{ control: boolean }>()
  let attempts: number[] = []

  const answer = (socket: Socket, status: string, headers: Record<string, string> = {}, body = "") => {
    const lines = Object.entries({ ...headers, "content-length": String(Buffer.byteLength(body)), connection: "close" }).map(
      ([name, value]) => `${name}: ${value}`,
    )
    socket.end(`HTTP/1.1 ${status}\r\n${lines.join("\r\n")}\r\n\r\n${body}`)
  }

  const server = createServer((socket) => {
    let head = Buffer.alloc(0)
    const timer = setTimeout(() => socket.destroy(), 10_000)
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) {
        if (head.length > MAX_HEAD) socket.destroy()
        return
      }
      socket.off("data", onData)
      clearTimeout(timer)
      const rest = head.subarray(end + 4)
      const request = parseHead(head.subarray(0, end).toString("latin1"))
      if (!request) return answer(socket, "400 Bad Request")
      const pathname = new URL(request.path, "http://viewer").pathname
      if (request.headers.upgrade !== undefined) return upgrade(socket, request, pathname, rest)
      if (request.method !== "GET" && request.method !== "HEAD") return answer(socket, "405 Method Not Allowed", { allow: "GET" })
      const body = (text: string) => (request.method === "HEAD" ? "" : text)
      if (pathname === "/" || pathname === "/index.html")
        return answer(socket, "200 OK", { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" }, body(page.html))
      if (pathname === "/viewer.js")
        return answer(socket, "200 OK", { ...PAGE_HEADERS, "content-type": "text/javascript; charset=utf-8" }, body(page.script))
      return answer(socket, "404 Not Found", { "cache-control": "no-store" })
    }
    socket.on("data", onData)
    socket.on("error", () => socket.destroy())
  })

  function upgrade(socket: Socket, request: NonNullable<ReturnType<typeof parseHead>>, pathname: string, rest: Buffer) {
    if (pathname !== "/socket" || request.method !== "GET") return answer(socket, "404 Not Found")
    const now = clock()
    attempts = attempts.filter((at) => at > now - 60_000)
    if (attempts.length >= ATTEMPTS_PER_MINUTE || open.size >= MAX_CONNECTIONS) return answer(socket, "429 Too Many Requests")
    attempts.push(now)
    const host = request.headers.host ?? ""
    const accept = checkUpgrade(request.headers, (sent) => origin(sent, host))
    if (!accept) return answer(socket, "400 Bad Request")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    )
    bridge(socket, rest)
  }

  function bridge(socket: Socket, early: Buffer) {
    const reader = new FrameReader()
    let vnc: Socket | undefined
    let filter: ClientFilter | undefined
    let closed = false
    const entry = { control: false }
    const close = (code = 1000, reason = "") => {
      if (closed) return
      closed = true
      open.delete(entry)
      clearTimeout(waiting)
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      socket.end(encodeFrame(OPCODE.close, payload))
      vnc?.destroy()
    }
    const waiting = setTimeout(() => close(4000, "no token"), TOKEN_WAIT_MS)
    open.add(entry)
    let checking = false

    const onFrames = async (chunk: Buffer) => {
      let messages
      try {
        messages = reader.push(chunk)
      } catch {
        return close(1002, "protocol error")
      }
      for (const message of messages) {
        if (closed) return
        if (message.opcode === OPCODE.close) return close()
        if (message.opcode === OPCODE.ping) {
          socket.write(encodeFrame(OPCODE.pong, message.data))
          continue
        }
        if (message.opcode === OPCODE.pong) continue
        if (!filter) {
          // The first message is the token; nothing else is read until it has been checked.
          if (checking || message.opcode !== OPCODE.text) return close(4003, "token required")
          checking = true
          socket.pause()
          const state = await readState()
          const at = clock()
          const claims = state ? checkViewerToken(message.data.toString("utf8").trim(), state, at) : undefined
          if (!state || !claims || !used.claim(claims.jti, claims.exp, at)) return close(4003, "token refused")
          clearTimeout(waiting)
          entry.control = claims.mode === "control"
          // Input only for a control token, and only while the person holds the computer.
          let current = state
          filter = new ClientFilter(() => entry.control && current.control === "person")
          const poll = setInterval(async () => {
            const next = await readState()
            if (!next || next.session !== current.session) return close(4002, "session ended")
            current = next
            if (entry.control && next.control !== "person") close(4001, "control ended")
          }, STATE_POLL_MS)
          poll.unref?.()
          socket.on("close", () => clearInterval(poll))
          vnc = dial(options.vncSocket ?? VNC_SOCKET)
          vnc.on("data", (data: Buffer) => {
            if (!closed) socket.write(encodeFrame(OPCODE.binary, data))
          })
          vnc.on("error", () => close(1011, "display unavailable"))
          vnc.on("close", () => close(1011, "display closed"))
          socket.resume()
          continue
        }
        if (message.opcode !== OPCODE.binary) return close(1003, "binary only")
        try {
          for (const part of filter.push(message.data)) vnc?.write(part)
        } catch {
          return close(1002, "protocol error")
        }
      }
    }
    socket.on("data", onFrames)
    socket.on("error", () => close())
    socket.on("close", () => close())
    if (early.length) void onFrames(early)
  }

  return server
}

function loadPage() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const dir of [here, path.join(here, "..", "image")]) {
    try {
      return {
        html: readFileSync(path.join(dir, "viewer.html"), "utf8"),
        script: readFileSync(path.join(dir, "viewer.js"), "utf8"),
      }
    } catch {}
  }
  return { html: "<!doctype html><title>Live view</title>", script: "" }
}

/** Started by boot.sh as the viewer user: `node viewer-proxy.mjs`. */
async function main() {
  const server = createViewerProxy()
  server.listen(Hosted.VIEWER_PORT, "0.0.0.0")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
