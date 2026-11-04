import { describe, expect, test } from "bun:test"
import { base64url, utf8 } from "../src/bytes"
import { CLOSE, FRAME, decodeFrame, encodeFrame } from "../src/protocol"
import { Harness, deviceId, frame, token } from "./fakes"

// WP A39: the relay passes ciphertext between an account's phones and computers byte for byte and stores none of it;
// the API's internal calls revoke, suspend, list, query presence and erase; job.offer is reserved.

const id = (device: string) =>
  Uint8Array.from(atob(device.replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0))

describe("data", () => {
  test("ciphertext passes byte for byte; only the header's device turns from the target into the sender", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const up = crypto.getRandomValues(new Uint8Array(4096))
    await h.message(phone.socket, encodeFrame(FRAME.DATA, id(computer.dev), up))
    const received = computer.socket.frames()
    expect(received).toHaveLength(1)
    const decoded = decodeFrame(received[0]!)!
    expect(decoded.kind).toBe(FRAME.DATA)
    expect(base64url(decoded.device)).toBe(phone.dev)
    expect(decoded.ciphertext).toEqual(up)
    // The largest frame back down, every byte value included.
    const down = new Uint8Array(64 * 1024 - 17).map((_, index) => index & 255)
    await h.message(computer.socket, encodeFrame(FRAME.DATA, id(phone.dev), down))
    const back = decodeFrame(phone.socket.frames()[0]!)!
    expect(base64url(back.device)).toBe(computer.dev)
    expect(back.ciphertext).toEqual(down)
  })

  test("frames go only between a phone and a computer of the same account, and only to a connected device", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const otherComputer = await h.computer()
    const phone = await h.phone()
    const otherPhone = await h.phone()
    const payload = new Uint8Array([1, 2, 3])
    await h.message(phone.socket, frame(FRAME.DATA, otherPhone.dev, payload))
    h.advance(1500)
    await h.message(computer.socket, frame(FRAME.DATA, otherComputer.dev, payload))
    h.advance(1500)
    await h.message(phone.socket, frame(FRAME.DATA, deviceId(), payload))
    expect(otherPhone.socket.frames()).toHaveLength(0)
    expect(otherComputer.socket.frames()).toHaveLength(0)
    expect(phone.socket.messages().filter((message) => message.t === "error")).toEqual([
      { t: "error", code: "no-peer" },
      { t: "error", code: "no-peer" },
    ])
    expect(computer.socket.last("error")).toEqual({ t: "error", code: "no-peer" })
  })

  test("the relay stores no frame: nothing it keeps contains the ciphertext", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const marker = utf8("PLAINTEXT-MARKER-THE-RELAY-MUST-NEVER-KEEP")
    for (let index = 0; index < 10; index++) {
      await h.message(phone.socket, frame(FRAME.DATA, computer.dev, marker))
      await h.message(computer.socket, frame(FRAME.DATA, phone.dev, marker))
    }
    await h.run(3 * 60_000)
    await h.disconnect(phone.socket)
    const stored = JSON.stringify(h.state.sql.tables().map((table) => h.state.sql.rows(`SELECT * FROM ${table}`)))
    expect(stored).not.toContain("PLAINTEXT-MARKER")
    expect(stored).not.toContain(base64url(marker))
    for (const entry of h.state.entries)
      expect(JSON.stringify(entry.socket.deserializeAttachment())).not.toContain("MARKER")
  })

  test("job.offer is reserved for the server: a client sending it gets a notice and nothing is passed on", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.message(phone.socket, frame(FRAME.JOB_OFFER, computer.dev, new Uint8Array([1])))
    expect(computer.socket.frames()).toHaveLength(0)
    expect(phone.socket.last("error")).toEqual({ t: "error", code: "reserved" })
    h.advance(1500)
    await h.message(computer.socket, JSON.stringify({ t: "job.offer", job: "anything" }))
    expect(computer.socket.last("error")).toEqual({ t: "error", code: "reserved" })
    expect(phone.socket.frames()).toHaveLength(0)
  })

  test("unknown kinds, short frames and unknown control messages get notices, at most one a second", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.message(phone.socket, frame(0x7f, computer.dev, new Uint8Array([1])))
    await h.message(phone.socket, new Uint8Array([FRAME.DATA, 1, 2]))
    expect(phone.socket.messages().filter((message) => message.t === "error")).toEqual([
      { t: "error", code: "bad-frame" },
    ])
    h.advance(1000)
    await h.message(phone.socket, new Uint8Array([FRAME.DATA, 1, 2]))
    h.advance(1000)
    await h.message(phone.socket, "not json")
    h.advance(1000)
    await h.message(phone.socket, JSON.stringify({ t: "launch" }))
    expect(
      phone.socket
        .messages()
        .filter((message) => message.t === "error")
        .map((message) => message.code),
    ).toEqual(["bad-frame", "bad-frame", "bad-frame", "unknown"])
    expect(computer.socket.frames()).toHaveLength(0)
  })
})

describe("internal calls", () => {
  test("presence answers whether a computer is online, for isComputerOnline (§4.17)", async () => {
    const h = await Harness.create()
    expect((await h.internal("presence", { account: "x" })).body).toEqual({ online: false, computers: [], viewers: 0 })
    const computer = await h.computer({ name: "Studio" })
    const phone = await h.phone()
    expect((await h.internal("presence", { account: "x" })).body).toEqual({
      online: true,
      computers: [{ device: computer.dev, name: "Studio" }],
      viewers: 1,
    })
    await h.message(phone.socket, JSON.stringify({ t: "presence" }))
    expect(phone.socket.last("peers")).toMatchObject({
      peers: [{ device: computer.dev, role: "computer", name: "Studio" }],
    })
    await h.disconnect(computer.socket)
    expect((await h.internal("presence", { account: "x" })).body).toMatchObject({ online: false })
  })

  test("devices lists what Settings shows: id, role, name, key, paired and last seen, online", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio", key: "c".repeat(43) })
    h.advance(1000)
    const phone = await h.phone({ name: "Pixel" })
    await h.disconnect(phone.socket)
    const list = await h.internal("devices", { account: "x" })
    expect(list.body).toEqual({
      devices: [
        {
          device: computer.dev,
          role: "computer",
          name: "Studio",
          key: "c".repeat(43),
          pairedAt: h.clock.now - 1000,
          lastSeen: h.clock.now - 1000,
          online: true,
          overLimit: false,
        },
        {
          device: phone.dev,
          role: "phone",
          name: "Pixel",
          pairedAt: h.clock.now,
          lastSeen: h.clock.now,
          online: false,
          overLimit: false,
        },
      ],
      limits: { computers: 3, phones: 5 },
      fairUse: "ok",
    })
  })

  test("kill revokes every connection and every ticket issued before it", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const early = await h.ticket({ role: "phone" })
    h.advance(1000)
    const killed = await h.internal("kill", { account: "x" })
    expect(killed.body).toEqual({ revokedBefore: h.clock.now, closed: 2 })
    expect(computer.socket.closed).toEqual({ code: CLOSE.REMOTE_REVOKED, reason: "REMOTE_REVOKED" })
    expect(phone.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect((await h.connect({}, early)).socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    h.advance(1000)
    expect((await h.computer({ dev: computer.dev })).socket.closed).toBeUndefined()
    // `before` is the API's revokedBefore: tickets issued at or after it stay.
    const fresh = await h.phone({ dev: phone.dev })
    h.advance(1000)
    await h.internal("kill", { account: "x", before: h.clock.now - 1000 })
    expect(fresh.socket.closed).toBeUndefined()
    await h.internal("kill", { account: "x", before: h.clock.now + 60_000 })
    expect(fresh.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    // `before` is never in the future: a ticket minted a second later is admitted.
    h.advance(1000)
    expect((await h.phone({ dev: phone.dev })).socket.closed).toBeUndefined()
    expect((await h.internal("kill", { account: "x", before: "soon" })).status).toBe(400)
  })

  test("suspend closes everything and refuses new connections until lifted; a late, older update changes nothing", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const at = h.clock.now
    expect((await h.internal("suspend", { account: "x", suspended: true, reason: "frozen", at })).body).toEqual({
      applied: true,
      suspended: true,
      closed: 2,
    })
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect(phone.socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect((await h.phone({ dev: phone.dev })).socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    // A "lift" sent before the freeze but delivered after it is ignored.
    expect((await h.internal("suspend", { account: "x", suspended: false, at: at - 1 })).body).toEqual({
      applied: false,
      suspended: true,
      closed: 0,
    })
    expect((await h.computer({ dev: computer.dev })).socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect((await h.internal("suspend", { account: "x", suspended: false, at: at + 1 })).body).toMatchObject({
      applied: true,
    })
    expect((await h.computer({ dev: computer.dev })).socket.closed).toBeUndefined()
    for (const bad of [{ suspended: "yes", at }, { suspended: true }, { suspended: true, at, reason: "other" }])
      expect((await h.internal("suspend", { account: "x", ...bad })).status).toBe(400)
  })

  test("erase closes every connection and deletes everything the object stored (P5)", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    const phone = await h.phone({ name: "Pixel" })
    await h.run(2 * 60_000)
    expect(h.devices()).toHaveLength(2)
    expect((await h.internal("erase", { account: "x" })).body).toEqual({ erased: true })
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(phone.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(h.state.alarm).toBeNull()
    for (const table of h.state.sql.tables())
      expect({ table, rows: h.state.sql.rows(`SELECT * FROM ${table}`) }).toEqual({ table, rows: [] })
    // The closes arriving afterwards store nothing again.
    h.advance(2 * 60_000)
    await h.disconnect(computer.socket)
    await h.disconnect(phone.socket)
    for (const table of h.state.sql.tables())
      expect({ table, rows: h.state.sql.rows(`SELECT * FROM ${table}`) }).toEqual({ table, rows: [] })
  })

  test("a signed call reaches the object once: its nonce is remembered", async () => {
    const h = await Harness.create()
    const nonce = token() + token()
    expect((await h.internal("presence", { account: "x" }, nonce)).status).toBe(200)
    expect((await h.internal("presence", { account: "x" }, nonce)).status).toBe(401)
    expect((await h.internal("presence", { account: "x" }, "short")).status).toBe(401)
    expect((await h.internal("unknown-action", { account: "x" })).status).toBe(404)
  })
})

describe("hibernation", () => {
  test("a new instance over the same storage and sockets keeps relaying and keeps the devices", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    h.advance(1000)
    const phone = await h.phone()
    h.wake()
    const payload = crypto.getRandomValues(new Uint8Array(100))
    await h.message(phone.socket, frame(FRAME.DATA, computer.dev, payload))
    expect(decodeFrame(computer.socket.frames()[0]!)!.ciphertext).toEqual(payload)
    expect((await h.internal("presence", { account: "x" })).body).toMatchObject({ online: true, viewers: 1 })
    expect(h.devices().map((device) => device.name)).toEqual(["Studio", null])
  })

  test("the object is pinned to the first account it served", async () => {
    const h = await Harness.create()
    await h.computer()
    const other = await h.connect({ sub: "acct_fixture_9999" })
    expect(other.response.status).toBe(409)
    expect(other.socket).toBeUndefined()
  })
})
