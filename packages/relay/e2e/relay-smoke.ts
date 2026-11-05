// CI only (WP A39): runs the relay on Cloudflare's local runtime under `wrangler dev --local` and checks, over real
// WebSockets, that ciphertext passes byte for byte, that heartbeats are answered by the runtime, and that revoking a
// device, killing the account, setting the kill flag and erasing close the right sockets. It generates throwaway keys
// and passes them as local variables; nothing here is a real secret and nothing is deployed.
//
//   bun run smoke        (from packages/relay; needs Node for wrangler)

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { base64url } from "../src/bytes"
import { signInternal } from "../src/internal"
import { CLOSE, FRAME, RELAY_SUBPROTOCOL, decodeFrame, encodeFrame } from "../src/protocol"
import { signTicket, type TicketClaims } from "../src/ticket"

const root = path.join(import.meta.dir, "..")
const port = 8787 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const ACCOUNT = "acct_smoke_0001"
const INTERNAL_SECRET = base64url(crypto.getRandomValues(new Uint8Array(32)))
const ACCOUNT_KEY = base64url(crypto.getRandomValues(new Uint8Array(32)))
const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))

const failures: string[] = []
async function check(name: string, run: () => Promise<void>) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const device = () => base64url(crypto.getRandomValues(new Uint8Array(16)))

function ticket(overrides: Partial<TicketClaims>) {
  const iat = Math.floor(Date.now() / 1000)
  return signTicket(
    {
      v: 1,
      aud: "vector-relay",
      sub: ACCOUNT,
      role: "computer",
      dev: device(),
      computers: 3,
      rank: 2,
      epoch: "smoke_epoch_0000001",
      periodEnd: Date.now() + 86_400_000,
      iat,
      exp: iat + 300,
      jti: base64url(crypto.getRandomValues(new Uint8Array(18))),
      ...overrides,
    },
    keys.privateKey,
  )
}

type Client = {
  socket: WebSocket
  texts: string[]
  frames: Uint8Array[]
  closed: Promise<number>
  next(predicate: (client: Client) => boolean, ms?: number): Promise<void>
}

/** Opens a connection; resolves once open, rejects when the handshake fails. */
function open(text: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/connect`, [RELAY_SUBPROTOCOL, text])
    socket.binaryType = "arraybuffer"
    let resolveClosed: (code: number) => void = () => {}
    const client: Client = {
      socket,
      texts: [],
      frames: [],
      closed: new Promise((done) => (resolveClosed = done)),
      async next(predicate, ms = 5000) {
        const end = Date.now() + ms
        while (!predicate(client)) {
          if (Date.now() > end) throw new Error("timed out waiting for the relay")
          await Bun.sleep(25)
        }
      },
    }
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") client.texts.push(event.data)
      else client.frames.push(new Uint8Array(event.data as ArrayBuffer))
    })
    socket.addEventListener("close", (event) => resolveClosed(event.code))
    socket.addEventListener("open", () => resolve(client))
    socket.addEventListener("error", () => reject(new Error("handshake failed")))
  })
}

async function closedWith(client: Client, ms = 5000) {
  return Promise.race([client.closed, Bun.sleep(ms).then(() => -1)])
}

async function internal(action: string, body: Record<string, unknown>) {
  const text = JSON.stringify(body)
  const pathName = `/internal/v1/${action}`
  const headers = await signInternal(INTERNAL_SECRET, { method: "POST", path: pathName, body: text, now: Date.now() })
  const response = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: text,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const state = await mkdtemp(path.join(tmpdir(), "vector-relay-smoke-"))
const wrangler = Bun.spawn(
  [
    "node",
    path.join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    state,
    "--var",
    `TICKET_PUBLIC_KEYS:${publicKey}`,
    "--var",
    `INTERNAL_SECRET:${INTERNAL_SECRET}`,
    "--var",
    `ACCOUNT_KEY:${ACCOUNT_KEY}`,
  ],
  {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
)

try {
  const ready = Date.now() + 90_000
  for (;;) {
    const healthy = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (healthy) break
    if (Date.now() > ready || wrangler.exitCode !== null) throw new Error("wrangler dev did not start")
    await Bun.sleep(500)
  }

  await check("a forged ticket fails the handshake", async () => {
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
    const iat = Math.floor(Date.now() / 1000)
    const forged = await signTicket(
      {
        v: 1,
        aud: "vector-relay",
        sub: ACCOUNT,
        role: "phone",
        dev: device(),
        computers: 3,
        rank: 2,
        epoch: "smoke_epoch_0000001",
        periodEnd: Date.now() + 1,
        iat,
        exp: iat + 300,
        jti: base64url(crypto.getRandomValues(new Uint8Array(18))),
      },
      other.privateKey,
    )
    const refused = await open(forged).then(
      () => false,
      () => true,
    )
    assert(refused, "a forged ticket was admitted")
  })

  const computerId = device()
  const phoneId = device()
  const computer = await open(await ticket({ role: "computer", dev: computerId, name: "Smoke computer" }))
  const phone = await open(await ticket({ role: "phone", dev: phoneId, name: "Smoke phone" }))

  await check("the handshake answers vector.v1 and the relay says hello", async () => {
    assert(computer.socket.protocol === RELAY_SUBPROTOCOL, `protocol ${computer.socket.protocol}`)
    assert(phone.socket.protocol === RELAY_SUBPROTOCOL, `protocol ${phone.socket.protocol}`)
    await phone.next((client) => client.texts.some((text) => text.includes('"hello"')))
    await computer.next((client) => client.texts.some((text) => text.includes('"peers"') && text.includes(phoneId)))
  })

  await check("the runtime answers the heartbeat", async () => {
    phone.socket.send("ping")
    await phone.next((client) => client.texts.includes("pong"))
  })

  await check("ciphertext passes byte for byte both ways", async () => {
    const id = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0))
    const up = crypto.getRandomValues(new Uint8Array(4096))
    phone.socket.send(encodeFrame(FRAME.DATA, id(computerId), up))
    await computer.next((client) => client.frames.length === 1)
    const received = decodeFrame(computer.frames[0]!)!
    assert(base64url(received.device) === phoneId, "the sender's id was not in the header")
    assert(Buffer.from(received.ciphertext).equals(Buffer.from(up)), "the ciphertext changed on the way up")
    const down = new Uint8Array(64 * 1024 - 17).map((_, index) => (index * 31) & 255)
    computer.socket.send(encodeFrame(FRAME.DATA, id(phoneId), down))
    await phone.next((client) => client.frames.length === 1)
    const back = decodeFrame(phone.frames[0]!)!
    assert(base64url(back.device) === computerId, "the sender's id was not in the header")
    assert(Buffer.from(back.ciphertext).equals(Buffer.from(down)), "the ciphertext changed on the way down")
  })

  await check("presence sees the computer online", async () => {
    const presence = await internal("presence", { account: ACCOUNT })
    assert(presence.status === 200 && presence.body.online === true, JSON.stringify(presence))
  })

  await check("revoking the phone closes its socket", async () => {
    const result = await internal("revoke-device", { account: ACCOUNT, device: phoneId })
    assert(result.status === 200, JSON.stringify(result))
    assert((await closedWith(phone)) === CLOSE.REMOTE_REVOKED, "the phone was not closed with REMOTE_REVOKED")
  })

  await check("kill closes the computer and refuses tickets issued before it", async () => {
    const early = await ticket({ role: "computer", dev: computerId })
    await Bun.sleep(1100)
    const result = await internal("kill", { account: ACCOUNT })
    assert(result.status === 200, JSON.stringify(result))
    assert((await closedWith(computer)) === CLOSE.REMOTE_REVOKED, "the computer was not closed with REMOTE_REVOKED")
    const stale = await open(early)
    assert((await closedWith(stale)) === CLOSE.REMOTE_REVOKED, "a ticket from before the kill was admitted")
    await Bun.sleep(1100)
    const fresh = await open(await ticket({ role: "computer", dev: computerId }))
    assert((await closedWith(fresh, 1500)) === -1, "a ticket from after the kill was refused")
    fresh.socket.close()
  })

  await check("the kill flag turns the relay off and back on", async () => {
    assert((await internal("flags", { kill: true })).status === 200, "the flag was not set")
    const off = await open(await ticket({ role: "computer", dev: computerId }))
    assert((await closedWith(off)) === CLOSE.RELAY_OFF, "a connection was admitted while the relay was off")
    assert((await internal("flags", { kill: false })).status === 200, "the flag was not cleared")
    const on = await open(await ticket({ role: "computer", dev: computerId }))
    assert((await closedWith(on, 1500)) === -1, "the relay stayed off")
    on.socket.close()
  })

  await check("erase closes everything, leaves no device and refuses tickets issued before it", async () => {
    const live = await open(await ticket({ role: "computer", dev: computerId }))
    await live.next((client) => client.texts.some((text) => text.includes('"hello"')))
    const early = await ticket({ role: "phone", dev: device() })
    const result = await internal("erase", { account: ACCOUNT })
    assert(result.status === 200, JSON.stringify(result))
    assert((await closedWith(live)) === CLOSE.REMOTE_REVOKED, "erase did not close the computer")
    const stale = await open(early)
    assert((await closedWith(stale)) === CLOSE.REMOTE_REVOKED, "a ticket from before the erase was admitted")
    const devices = await internal("devices", { account: ACCOUNT })
    assert(Array.isArray(devices.body.devices) && devices.body.devices.length === 0, JSON.stringify(devices.body))
  })

  await check("job.offer is reserved", async () => {
    const result = await internal("job-offer", { account: ACCOUNT })
    assert(result.status === 501, JSON.stringify(result))
  })
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.log(`FAIL ${failures.at(-1)}`)
} finally {
  wrangler.kill()
  await wrangler.exited
  await rm(state, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} relay smoke check(s) failed` : "\nrelay smoke passed")
process.exit(failures.length ? 1 : 0)
