import { describe, expect, test } from "bun:test"
import { RELAY_LIMITS } from "../src/limits"
import { CLOSE, FRAME } from "../src/protocol"
import { EPOCH, Harness, frame } from "./fakes"

// WP A39 and §4.2: viewer time per period is capped by the plan's viewer-hours (60 / 100 / 200 / 200), awake time at
// 1.5× that. Viewer time is counted in memory from the stored start and written at most once a minute while viewers
// stay; meters belong to the period's epoch, so a renewal starts them over.

const MINUTE = 60_000

/** Sends a data frame from the phone every second for `ms`, answering heartbeats and firing alarms like the runtime. */
async function stream(
  h: Harness,
  phone: { socket: import("./fakes").FakeSocket; dev: string },
  computer: string,
  ms: number,
) {
  const end = h.clock.now + ms
  while (h.clock.now < end && !phone.socket.closed) {
    await h.run(1000, { step: 1000 })
    await h.message(phone.socket, frame(FRAME.DATA, computer, new Uint8Array([1])))
    if ((h.clock.now / 1000) % 240 === 0)
      await h.message(
        phone.socket,
        JSON.stringify({ t: "refresh", ticket: await h.ticket({ role: "phone", dev: phone.dev }) }),
      )
  }
}

describe("viewer time", () => {
  test("runs while at least one viewer is attached, once however many phones watch", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const first = await h.phone()
    const second = await h.phone()
    await h.watch([first, second], 10 * MINUTE, { computer: computer.dev })
    await h.disconnect(first.socket)
    await h.watch([second], 5 * MINUTE, { computer: computer.dev })
    await h.disconnect(second.socket)
    expect(first.socket.closed).toBeUndefined()
    expect(h.meter("viewer")).toBe(15 * MINUTE)
    // Nobody watching: no viewer time.
    await h.run(30 * MINUTE)
    expect(h.meter("viewer")).toBe(15 * MINUTE)
  })

  test("is written at most once a minute however busy the connection is", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    const writes = () => h.state.sql.statements.filter((query) => query.startsWith("INSERT INTO meters")).length
    const flushes = () =>
      h.state.sql.statements.filter((query) => query.includes("'flushed_at'") || query.startsWith("INSERT INTO meta"))
        .length
    const before = writes()
    await stream(h, phone, computer.dev, 30_000)
    // Thirty frames in thirty seconds, and no meter write yet.
    expect(computer.socket.frames()).toHaveLength(30)
    expect(writes()).toBe(before)
    await stream(h, phone, computer.dev, 9.5 * MINUTE)
    expect(phone.socket.closed).toBeUndefined()
    expect(computer.socket.frames()).toHaveLength(600)
    // Ten minutes: at most one viewer write and one awake write a minute.
    expect(writes() - before).toBeLessThanOrEqual(2 * 10)
    expect(writes() - before).toBeGreaterThanOrEqual(2 * 9)
    expect(flushes()).toBeGreaterThan(0)
  })

  test("survives hibernation: the stored start and the meter carry over to a new instance", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    await h.watch([phone], 5 * MINUTE + 30_000, { computer: computer.dev })
    h.wake()
    await h.watch([phone], 4 * MINUTE + 30_000, { computer: computer.dev })
    await h.disconnect(phone.socket)
    expect(h.meter("viewer")).toBe(10 * MINUTE)
  })

  test("used up: viewers are closed and refused for the rest of the period; computers still connect", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ viewerHours: 1 })
    const phone = await h.phone({ viewerHours: 1 })
    const options = { computer: computer.dev, claims: { viewerHours: 1 } }
    await h.watch([phone], 59 * MINUTE, options)
    expect(phone.socket.closed).toBeUndefined()
    await h.watch([phone], 2 * MINUTE, options)
    expect(phone.socket.closed).toEqual({ code: CLOSE.REMOTE_FAIR_USE, reason: "REMOTE_FAIR_USE" })
    expect(h.meter("viewer")).toBeGreaterThanOrEqual(60 * MINUTE)
    expect(h.meter("viewer")).toBeLessThanOrEqual(61 * MINUTE)
    expect((await h.phone({ viewerHours: 1 })).socket.closed?.code).toBe(CLOSE.REMOTE_FAIR_USE)
    expect(computer.socket.closed).toBeUndefined()
    expect((await h.computer({ viewerHours: 1, dev: computer.dev })).socket.closed).toBeUndefined()
    expect((await h.internal("devices", { account: "x" })).body.fairUse).toBe("viewer")
    // A renewal brings a new epoch: the meters start over.
    const renewed = await h.phone({
      viewerHours: 1,
      epoch: "epoch_fixture_0000002",
      periodEnd: h.clock.now + 30 * 86_400_000,
    })
    expect(renewed.socket.closed).toBeUndefined()
    expect(h.meter("viewer", "epoch_fixture_0000002")).toBe(0)
    expect(h.meter("viewer", EPOCH)).toBeGreaterThanOrEqual(60 * MINUTE)
  })

  test("a larger plan's viewer-hours raise the cap at once", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ viewerHours: 1 })
    const phone = await h.phone({ viewerHours: 1 })
    await h.watch([phone], 56 * MINUTE, { computer: computer.dev, claims: { viewerHours: 1 } })
    expect(phone.socket.closed).toBeUndefined()
    // An upgrade within the period: the API's next ticket carries the new plan's hours and a new epoch.
    const upgraded = { viewerHours: 200, epoch: "epoch_fixture_upgrade1" }
    await h.message(
      phone.socket,
      JSON.stringify({ t: "refresh", ticket: await h.ticket({ ...upgraded, role: "phone", dev: phone.dev }) }),
    )
    await h.watch([phone], 30 * MINUTE, { computer: computer.dev, claims: upgraded })
    expect(phone.socket.closed).toBeUndefined()
    expect((await h.internal("devices", { account: "x" })).body.fairUse).toBe("ok")
    expect(h.meter("viewer", "epoch_fixture_upgrade1")).toBeGreaterThanOrEqual(25 * MINUTE)
  })
})

describe("awake time", () => {
  test("counts the time the object is kept awake, even with no viewer, and is capped at 1.5× viewer-hours", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ viewerHours: 1 })
    // A computer that keeps the object awake with control messages and no viewer. Viewer time stays at zero.
    let sent = 0
    while (!computer.socket.closed && sent < 2000) {
      h.advance(5_000)
      h.ping(computer.socket)
      await h.message(computer.socket, JSON.stringify({ t: "presence" }))
      sent++
    }
    expect(computer.socket.closed).toEqual({ code: CLOSE.REMOTE_FAIR_USE, reason: "REMOTE_FAIR_USE" })
    const awakeLimit = 1 * 3_600_000 * RELAY_LIMITS.awakeFactor
    // Every 5 s of messages is 5 s awake: the cap is reached after about 90 minutes of it.
    expect(sent * 5_000).toBeGreaterThanOrEqual(awakeLimit - 20_000)
    expect(sent * 5_000).toBeLessThanOrEqual(awakeLimit + RELAY_LIMITS.fairCheckEveryMs + 20_000)
    expect(h.meter("viewer")).toBe(0)
    // Everyone is refused for the rest of the period.
    expect((await h.computer({ viewerHours: 1, dev: computer.dev })).socket.closed?.code).toBe(CLOSE.REMOTE_FAIR_USE)
    expect((await h.phone({ viewerHours: 1 })).socket.closed?.code).toBe(CLOSE.REMOTE_FAIR_USE)
  })

  test("an idle object costs nothing: hibernated hours with heartbeats only add no awake time", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ viewerHours: 1 })
    const start = h.meter("awake")
    // Heartbeats are answered by the runtime, so the object sees no event for hours.
    await h.run(10 * 60 * MINUTE, { step: MINUTE })
    expect(h.meter("awake")).toBe(start)
    expect(computer.socket.closed).toBeUndefined()
  })

  test("is stored per epoch and kept 40 days past the period's end", async () => {
    const h = await Harness.create()
    const periodEnd = h.clock.now + 10 * 86_400_000
    await h.computer({ periodEnd })
    const phone = await h.phone({ periodEnd })
    await h.run(3 * MINUTE)
    await h.disconnect(phone.socket)
    const rows = h.state.sql.rows<{ name: string; expires_at: number }>(
      "SELECT name, expires_at FROM meters ORDER BY name",
    )
    expect(rows.map((row) => row.name)).toEqual(["awake", "viewer"])
    expect(new Set(rows.map((row) => row.expires_at))).toEqual(new Set([periodEnd + 40 * 86_400_000]))
  })
})
