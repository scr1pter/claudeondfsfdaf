import { describe, expect, test } from "bun:test"
import { RELAY_LIMITS } from "../src/limits"
import { CLOSE, FRAME } from "../src/protocol"
import { Harness, deviceId, frame } from "./fakes"

// WP A39: the paired-computer count comes from the ticket (the plan's remote.computers), phones are capped at five
// (§4.2), and frames are at most 64 KiB and 20 a second. A patched client cannot pair more than its plan (S1).

describe("device caps", () => {
  test("a pairing over the plan's computer count is refused; a paired computer reconnects", async () => {
    const h = await Harness.create()
    const first = await h.computer({ computers: 1, name: "Studio" })
    expect(first.socket.closed).toBeUndefined()
    const second = await h.computer({ computers: 1 })
    expect(second.socket.closed).toEqual({ code: CLOSE.REMOTE_DEVICE_LIMIT, reason: "REMOTE_DEVICE_LIMIT" })
    expect(h.devices().map((device) => device.id)).toEqual([first.dev])
    // The same computer again replaces its own connection.
    const again = await h.computer({ computers: 1, dev: first.dev })
    expect(again.socket.closed).toBeUndefined()
    expect(first.socket.closed?.code).toBe(CLOSE.REPLACED)
  })

  test("a patched client asking for more computers than its plan still gets only its ticket's count", async () => {
    const h = await Harness.create()
    for (let index = 0; index < 3; index++) expect((await h.computer({ computers: 3 })).socket.closed).toBeUndefined()
    expect((await h.computer({ computers: 3 })).socket.closed?.code).toBe(CLOSE.REMOTE_DEVICE_LIMIT)
  })

  test("five phones whatever the plan; the sixth is refused", async () => {
    const h = await Harness.create()
    await h.computer({ computers: 5 })
    const phones = []
    for (let index = 0; index < RELAY_LIMITS.phones; index++) phones.push(await h.phone({ computers: 5 }))
    expect(phones.every((phone) => phone.socket.closed === undefined)).toBe(true)
    expect((await h.phone({ computers: 5 })).socket.closed?.code).toBe(CLOSE.REMOTE_DEVICE_LIMIT)
    expect((await h.phone({ computers: 5, dev: phones[0]!.dev })).socket.closed).toBeUndefined()
  })

  test("a plan without Remote computers admits nothing", async () => {
    const h = await Harness.create()
    expect((await h.computer({ computers: 0 })).socket.closed?.code).toBe(CLOSE.REMOTE_DEVICE_LIMIT)
    expect((await h.phone({ computers: 0 })).socket.closed?.code).toBe(CLOSE.REMOTE_DEVICE_LIMIT)
  })

  test("a newer ticket with fewer computers closes the computers paired after the new count", async () => {
    const h = await Harness.create()
    const computers = []
    for (let index = 0; index < 3; index++) {
      computers.push(await h.computer({ computers: 3 }))
      h.advance(1000)
    }
    // A downgrade: the next ticket from the API carries one computer.
    const phone = await h.phone({ computers: 1 })
    expect(phone.socket.closed).toBeUndefined()
    expect(computers.map((computer) => computer.socket.closed?.code)).toEqual([
      undefined,
      CLOSE.REMOTE_DEVICE_LIMIT,
      CLOSE.REMOTE_DEVICE_LIMIT,
    ])
    expect((await h.computer({ computers: 1, dev: computers[2]!.dev })).socket.closed?.code).toBe(
      CLOSE.REMOTE_DEVICE_LIMIT,
    )
    const list = await h.internal("devices", { account: "x" })
    expect(list.body.limits).toEqual({ computers: 1, phones: 5 })
    expect(
      (list.body.devices as Array<{ role: string; overLimit: boolean }>)
        .filter((device) => device.role === "computer")
        .map((device) => device.overLimit),
    ).toEqual([false, true, true])
  })

  test("a ticket issued before the current plan's never undoes it", async () => {
    const h = await Harness.create()
    // A phone fetched its ticket just before a downgrade; the computers then reconnect with the new plan's tickets.
    const stale = await h.ticket({ role: "phone", computers: 1 })
    h.advance(2000)
    const computers = [await h.computer({ computers: 3 }), await h.computer({ computers: 3 })]
    await h.connect({}, stale)
    expect(computers.map((computer) => computer.socket.closed)).toEqual([undefined, undefined])
    expect((await h.internal("devices", { account: "x" })).body.limits).toEqual({ computers: 3, phones: 5 })
  })

  test("a revoked device is refused for good, forgotten, and frees its place", async () => {
    const h = await Harness.create()
    const first = await h.computer({ computers: 1, name: "Old laptop", key: "k".repeat(43) })
    const revoked = await h.internal("revoke-device", { account: "x", device: first.dev })
    expect(revoked).toEqual({ status: 200, body: { revoked: true, closed: 1 } })
    expect(first.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(h.devices()).toEqual([
      { id: first.dev, role: "computer", name: null, public_key: null, revoked_at: h.clock.now },
    ])
    h.advance(1000)
    expect((await h.computer({ computers: 1, dev: first.dev })).socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect((await h.computer({ computers: 1 })).socket.closed).toBeUndefined()
    // A device never seen can be revoked ahead of time.
    const unseen = deviceId()
    expect((await h.internal("revoke-device", { account: "x", device: unseen })).body).toEqual({
      revoked: true,
      closed: 0,
    })
    expect((await h.phone({ dev: unseen })).socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect((await h.internal("revoke-device", { account: "x", device: "nope" })).status).toBe(400)
  })

  test("a device id cannot change role", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    expect((await h.phone({ dev: computer.dev })).socket.closed?.code).toBe(CLOSE.PROTOCOL)
  })
})

describe("frames", () => {
  test("a frame of 64 KiB passes; one byte more closes the sender with 1009", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.message(phone.socket, frame(FRAME.DATA, computer.dev, new Uint8Array(RELAY_LIMITS.frameBytes - 17)))
    expect(computer.socket.frames()).toHaveLength(1)
    await h.message(phone.socket, frame(FRAME.DATA, computer.dev, new Uint8Array(RELAY_LIMITS.frameBytes - 16)))
    expect(phone.socket.closed).toEqual({ code: CLOSE.TOO_LARGE, reason: "TOO_LARGE" })
    expect(computer.socket.frames()).toHaveLength(1)
  })

  test("control text longer than 8 KiB closes the sender", async () => {
    const h = await Harness.create()
    const phone = await h.phone()
    await h.message(phone.socket, JSON.stringify({ t: "presence", pad: "x".repeat(RELAY_LIMITS.controlBytes) }))
    expect(phone.socket.closed?.code).toBe(CLOSE.TOO_LARGE)
  })

  test("20 frames a second on average with bursts of 40; the rest are dropped with a notice", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const payload = new Uint8Array([1, 2, 3])
    for (let index = 0; index < 45; index++) await h.message(phone.socket, frame(FRAME.DATA, computer.dev, payload))
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.burstFrames)
    expect(phone.socket.messages().filter((message) => message.t === "error")).toEqual([
      { t: "error", code: "too-fast" },
    ])
    h.advance(1000)
    for (let index = 0; index < 25; index++) await h.message(phone.socket, frame(FRAME.DATA, computer.dev, payload))
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.burstFrames + RELAY_LIMITS.framesPerSecond)
    expect(phone.socket.closed).toBeUndefined()
  })

  test("a connection that keeps sending too fast is closed", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    for (let index = 0; index < RELAY_LIMITS.burstFrames + RELAY_LIMITS.tooFastRefusals + 1; index++)
      await h.message(phone.socket, frame(FRAME.DATA, computer.dev, new Uint8Array([index & 255])))
    expect(phone.socket.closed).toEqual({ code: CLOSE.TOO_FAST, reason: "TOO_FAST" })
  })

  test("one connection per device: a newer one replaces the older", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const second = await h.phone({ dev: phone.dev })
    expect(phone.socket.closed).toEqual({ code: CLOSE.REPLACED, reason: "REPLACED" })
    expect(second.socket.closed).toBeUndefined()
    await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([7])))
    expect(second.socket.frames()).toHaveLength(1)
    expect(phone.socket.frames()).toHaveLength(0)
  })
})
