import { describe, expect, test } from "bun:test"
import { RELAY_LIMITS } from "../src/limits"
import { CLOSE, FRAME } from "../src/protocol"
import { Harness, frame } from "./fakes"

// WP A39: the object sleeps unless someone is watching. The alarm runs only while a viewer is attached; viewers idle
// for 30 minutes are closed; silent connections are closed; a viewer refreshes its ticket in-band; a computer's data
// frames are dropped when no viewer is attached, and a computer that keeps sending them is closed.

describe("alarm", () => {
  test("armed only while a viewer is attached", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    expect(h.state.alarm).toBeNull()
    const phone = await h.phone()
    expect(h.state.alarm).toBe(h.clock.now + RELAY_LIMITS.alarmEveryMs)
    await h.run(5 * 60_000)
    expect(h.state.alarm).not.toBeNull()
    await h.disconnect(phone.socket)
    expect(h.state.alarm).toBeNull()
    expect(computer.socket.closed).toBeUndefined()
    // Hours with only a computer attached: no alarm ever fires.
    const writes = h.state.alarmWrites
    await h.run(3 * 60 * 60_000)
    expect(h.state.alarmWrites).toBe(writes)
    expect(computer.socket.closed).toBeUndefined()
  })

  test("the alarm reads the kill flag and closes everyone when it is set", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    h.kv.values.set("kill", "1")
    await h.run(RELAY_LIMITS.alarmEveryMs)
    expect(phone.socket.closed?.code).toBe(CLOSE.RELAY_OFF)
    expect(computer.socket.closed?.code).toBe(CLOSE.RELAY_OFF)
    expect(h.state.alarm).toBeNull()
  })
})

describe("idle viewers", () => {
  /** Lets time pass while the phone app does what it does on its own: heartbeats and a ticket refresh every 4 minutes. */
  async function idle(h: Harness, phone: { socket: import("./fakes").FakeSocket; dev: string }, ms: number) {
    const end = h.clock.now + ms
    while (h.clock.now < end && !phone.socket.closed) {
      await h.run(Math.min(4 * 60_000, end - h.clock.now))
      if (!phone.socket.closed)
        await h.message(
          phone.socket,
          JSON.stringify({ t: "refresh", ticket: await h.ticket({ role: "phone", dev: phone.dev }) }),
        )
    }
  }

  test("a viewer that sends no data for 30 minutes is closed; heartbeats and refreshes do not count", async () => {
    const h = await Harness.create()
    await h.computer()
    const phone = await h.phone()
    const from = h.clock.now
    await idle(h, phone, 29 * 60_000)
    expect(phone.socket.closed).toBeUndefined()
    // Within one alarm period of the 30 minutes.
    await idle(h, phone, 2 * 60_000)
    expect(phone.socket.closed).toEqual({ code: CLOSE.IDLE, reason: "IDLE" })
    expect(h.clock.now - from).toBeGreaterThanOrEqual(RELAY_LIMITS.viewerIdleMs)
    expect(h.clock.now - from).toBeLessThanOrEqual(RELAY_LIMITS.viewerIdleMs + RELAY_LIMITS.alarmEveryMs)
    expect(h.state.alarm).toBeNull()
  })

  test("a data frame is activity, and activity survives hibernation through the attachment", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await idle(h, phone, 20 * 60_000)
    await h.message(phone.socket, frame(FRAME.DATA, computer.dev, new Uint8Array([1])))
    expect(computer.socket.frames()).toHaveLength(1)
    // Hibernation drops everything in memory; the attachment kept the activity time.
    h.wake()
    await idle(h, phone, 25 * 60_000)
    expect(phone.socket.closed).toBeUndefined()
    await idle(h, phone, 7 * 60_000)
    expect(phone.socket.closed?.code).toBe(CLOSE.IDLE)
  })
})

describe("silent connections and tickets", () => {
  test("a connection with no heartbeat for 75 s is closed", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.run(2 * 60_000, { silent: new Set([phone.socket]) })
    expect(phone.socket.closed).toEqual({ code: CLOSE.STALE, reason: "STALE" })
    expect(computer.socket.closed).toBeUndefined()
    // A computer that went silent is closed the next time the object wakes.
    await h.run(2 * 60_000, { silent: new Set([computer.socket]) })
    expect(computer.socket.closed).toBeUndefined()
    await h.phone()
    expect(computer.socket.closed?.code).toBe(CLOSE.STALE)
  })

  test("a viewer refreshes its ticket in-band; without a refresh it is closed a minute after expiry", async () => {
    const h = await Harness.create()
    await h.computer()
    const kept = await h.phone()
    const lapsed = await h.phone()
    for (let index = 0; index < 3; index++) {
      await h.run(4 * 60_000)
      await h.message(
        kept.socket,
        JSON.stringify({ t: "refresh", ticket: await h.ticket({ role: "phone", dev: kept.dev }) }),
      )
      expect(kept.socket.last("refreshed")).toEqual({ t: "refreshed", exp: Math.floor(h.clock.now / 1000) + 300 })
    }
    expect(kept.socket.closed).toBeUndefined()
    expect(lapsed.socket.closed?.code).toBe(CLOSE.TICKET_EXPIRED)
  })

  test("a refresh must be a new ticket for the same account, device and role", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const refresh = async (ticket: string) => {
      h.advance(1500)
      await h.message(phone.socket, JSON.stringify({ t: "refresh", ticket }))
      return phone.socket.messages().at(-1)
    }
    expect(await refresh(await h.ticket({ role: "phone" }))).toEqual({ t: "error", code: "ticket-invalid" })
    expect(await refresh(await h.ticket({ role: "computer", dev: phone.dev }))).toEqual({
      t: "error",
      code: "ticket-invalid",
    })
    expect(await refresh(await h.ticket({ role: "phone", dev: phone.dev, sub: "acct_other" }))).toEqual({
      t: "error",
      code: "ticket-invalid",
    })
    expect(await refresh("vt1.garbage.ticket")).toEqual({ t: "error", code: "ticket-invalid" })
    const good = await h.ticket({ role: "phone", dev: phone.dev })
    expect((await refresh(good))?.t).toBe("refreshed")
    expect(await refresh(good)).toEqual({ t: "error", code: "ticket-invalid" })
    expect(phone.socket.closed).toBeUndefined()
    expect(computer.socket.closed).toBeUndefined()
  })

  test("an idle computer's lapsed ticket only stops its frames; a viewer arriving asks it to refresh", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    await h.run(30 * 60_000)
    expect(computer.socket.closed).toBeUndefined()
    const phone = await h.phone()
    expect(computer.socket.last("peers")).toMatchObject({ viewers: 1, refresh: true })
    await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([9])))
    expect(phone.socket.frames()).toHaveLength(0)
    expect(computer.socket.last("error")).toEqual({ t: "error", code: "ticket-expired" })
    await h.message(
      computer.socket,
      JSON.stringify({ t: "refresh", ticket: await h.ticket({ role: "computer", dev: computer.dev }) }),
    )
    await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([9])))
    expect(phone.socket.frames()).toHaveLength(1)
  })

  test("a computer whose ticket lapsed more than a day ago is closed when the object next wakes", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    await h.run(RELAY_LIMITS.computerTicketMaxAgeMs + 10 * 60_000, { step: 60_000 })
    expect(computer.socket.closed).toBeUndefined()
    await h.phone()
    expect(computer.socket.closed?.code).toBe(CLOSE.TICKET_EXPIRED)
  })
})

describe("no viewer", () => {
  test("a computer's frames are dropped with no viewer, and a computer that keeps sending is closed", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.disconnect(phone.socket)
    for (let index = 0; index < RELAY_LIMITS.noViewerFrames - 1; index++) {
      await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([index])))
      h.advance(2_000)
    }
    expect(computer.socket.closed).toBeUndefined()
    expect(computer.socket.last("error")).toEqual({ t: "error", code: "no-viewer" })
    await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([99])))
    expect(computer.socket.closed).toEqual({ code: CLOSE.NO_VIEWER, reason: "NO_VIEWER" })
  })

  test("a few stray frames spread out never close the computer", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.disconnect(phone.socket)
    for (let index = 0; index < 3 * RELAY_LIMITS.noViewerFrames; index++) {
      await h.message(computer.socket, frame(FRAME.DATA, phone.dev, new Uint8Array([index & 255])))
      h.advance(RELAY_LIMITS.noViewerWindowMs / (RELAY_LIMITS.noViewerFrames - 2))
      h.ping(computer.socket)
    }
    expect(computer.socket.closed).toBeUndefined()
  })

  test("the computer is told when viewers come and go, so it streams only while someone watches", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    expect(computer.socket.messages()[0]).toMatchObject({ t: "hello", viewers: 0, peers: [] })
    const phone = await h.phone({ name: "Pixel", key: "p".repeat(43) })
    expect(computer.socket.last("peers")).toEqual({
      t: "peers",
      peers: [{ device: phone.dev, role: "phone", name: "Pixel", key: "p".repeat(43) }],
      viewers: 1,
    })
    expect(phone.socket.messages()[0]).toMatchObject({
      t: "hello",
      role: "phone",
      peers: [{ device: computer.dev, role: "computer", name: "Studio" }],
    })
    await h.disconnect(phone.socket)
    expect(computer.socket.last("peers")).toEqual({ t: "peers", peers: [], viewers: 0 })
  })
})
