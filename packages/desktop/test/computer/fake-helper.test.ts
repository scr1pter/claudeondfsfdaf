import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"

import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { blocklist, COLORS, OVERLAY, type Rgb } from "./fake-desktop"
import { connect, main, manualClock, parseCli, type FakeOptions } from "./fake-helper"
import { decodePng, fit, type Image } from "./png"
import { encodeFrame, readTranscript, replay, type Channel } from "./transcript"

// C1: the fake helper speaks helper protocol v1 over its virtual desktop. Everything runs in-process on a manual
// clock; no test starts a process, captures the real screen or posts real input.

const FIXTURES = path.join(import.meta.dir, "../fixtures/computer-protocol")
const FULL_DISPLAY = { maxWidth: 4096, maxHeight: 4096, maxPixels: 4096 * 4096 }

type Message = Record<string, any>

/** An in-process fake with a request helper that returns the reply, and every frame and event it sent. */
function start(options: FakeOptions = {}) {
  const clock = manualClock(1_000)
  const fake = connect(options, clock)
  const seen: Message[] = []
  const images = new Map<number, Image>()
  const state = { id: 0, exit: undefined as number | null | undefined }
  const drain = () => {
    while (fake.inbox.length) {
      const item = fake.inbox.shift()!
      if (item.kind === "exit") {
        state.exit = item.code
        continue
      }
      const message = JSON.parse(Buffer.from(item.bytes).toString("utf8")) as Message
      seen.push(message)
      if (typeof message.imageBytes !== "number") continue
      const image = fake.inbox.shift()
      if (image?.kind !== "frame" || image.bytes.length !== message.imageBytes) throw new Error("missing image frame")
      images.set(message.id, decodePng(image.bytes))
    }
  }
  const send = (op: string, args: Message = {}) => {
    const id = ++state.id
    fake.channel.write(encodeFrame({ id, op, ...args }))
    drain()
    return id
  }
  const reply = (id: number) => seen.find((message) => message.id === id && "ok" in message)
  const call = (op: string, args: Message = {}) => reply(send(op, args))!
  const desktop = fake.helper.desktop
  const identity = (slot: string) => desktop.app(slot)!.identity
  const begin = (slots: string[], extra: Message = {}) =>
    call("session.begin", {
      sessionId: "test",
      mode: "foreground",
      approved: slots.map(identity),
      vectorPids: [desktop.app("vector")!.pid],
      vectorWindowIds: ["vector-1"],
      overlayWindowIds: [OVERLAY],
      escStops: true,
      stopChord: "Command+Shift+Escape",
      heartbeatMs: 2000,
      ...extra,
    })
  const capture = (target: Message, budget = FULL_DISPLAY, extra: Message = {}) => {
    const header = call("capture", { target, budget, format: "jpeg", ...extra })
    return { header, image: images.get(header.id) }
  }
  const advance = (ms: number) => {
    clock.advance(ms)
    drain()
  }
  const control = (message: Message) => {
    expect(fake.helper.control(message)).toBe(true)
    drain()
  }
  const kinds = () => fake.helper.log.map((entry) => entry.kind)
  const index = (match: (entry: Message) => boolean) => fake.helper.log.findIndex(match)
  return {
    ...fake,
    clock,
    seen,
    images,
    state,
    drain,
    send,
    reply,
    call,
    begin,
    capture,
    advance,
    control,
    identity,
    kinds,
    index,
  }
}

function pixel(image: Image, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4
  return [image.rgba[offset]!, image.rgba[offset + 1]!, image.rgba[offset + 2]!]
}

/** The pixel of a capture showing a global point (the fake samples each pixel at its centre). */
function at(header: Message, x: number, y: number) {
  return [
    Math.floor((x - header.origin.x) * header.imageScale),
    Math.floor((y - header.origin.y) * header.imageScale),
  ] as const
}

const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

/** `masked` must be exactly the painted blocks: every pixel in a rect is a block, every block pixel is in a rect. */
function expectMaskedIsPainted(header: Message, image: Image) {
  const rects = header.masked as { x: number; y: number; w: number; h: number }[]
  const inRect = (x: number, y: number) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
  const block = (color: Rgb) => same(color, COLORS.mask) || same(color, COLORS.vector)
  const wrong: string[] = []
  for (let y = 0; y < image.height && wrong.length < 5; y++)
    for (let x = 0; x < image.width && wrong.length < 5; x++)
      if (block(pixel(image, x, y)) !== inRect(x, y)) wrong.push(`${x},${y}`)
  expect(wrong).toEqual([])
}

describe("conformance transcripts", () => {
  const files = readdirSync(FIXTURES).filter((file) => file.endsWith(".jsonl"))

  test("cover the section 2.11 list", () => {
    expect(files.toSorted()).toEqual(
      [
        "cancel-idle.jsonl",
        "eof.jsonl",
        "frame-too-large.jsonl",
        "heartbeat-loss.jsonl",
        "hello.jsonl",
        "malformed-json.jsonl",
        "permissions.jsonl",
        "session.jsonl",
        "shutdown.jsonl",
        "unsupported-action.jsonl",
      ].toSorted(),
    )
  })

  for (const file of files)
    test(`the fake replays ${file}`, async () => {
      const clock = manualClock(1_000)
      const fake = connect({}, clock)
      const result = await replay(fake.channel, readTranscript(path.join(FIXTURES, file)), {
        name: file,
        wait: async (ms) => clock.advance(ms),
      })
      // The driver skips events, so the fake's own must still be none here.
      expect(result.events).toEqual([])
    })

  // Events may arrive at any time (2.10): a native helper on a runner without grants reports input_detection when a
  // foreground session starts. The fake does the same when the focused field is secure, before answering.
  test("an event a line does not expect is skipped and returned, not matched against the response", async () => {
    for (const file of ["session.jsonl", "heartbeat-loss.jsonl"]) {
      const clock = manualClock(1_000)
      const fake = connect({ scenario: "notes" }, clock)
      expect(fake.helper.control({ type: "focus", windowId: "notes-1", node: "notes.password" })).toBe(true)
      const result = await replay(fake.channel, readTranscript(path.join(FIXTURES, file)), {
        name: file,
        wait: async (ms) => clock.advance(ms),
      })
      expect(result.events).toEqual([
        { event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" },
      ])
    }
  })

  // The driver is the conformance gate for the native helpers, so a frame that a desktop could not decode fails it
  // even when it matches the expected subset.
  test("the driver refuses frames that do not decode", async () => {
    const answering = (frames: Message[]): Channel => ({
      write: () => {},
      end: () => {},
      next: async () => {
        const frame = frames.shift()
        return frame ? { kind: "frame", bytes: Buffer.from(JSON.stringify(frame)) } : undefined
      },
    })
    const hello = { send: { id: 1, op: "hello", protocol: { min: 1, max: 1 } }, expect: { id: 1, ok: true } }
    const failure = { send: { id: 1, op: "teleport" }, expect: { id: 1, ok: false, code: "unsupported_action" } }
    const wait = async () => {}
    await expect(
      replay(answering([{ id: 1, ok: false, code: "unsupported_action" }]), [failure], { wait }),
    ).rejects.toThrow(/does not decode \(not a HelperFailure\)/)
    await expect(replay(answering([{ id: 1, ok: true }]), [hello], { wait })).rejects.toThrow(/not a hello response/)
    await expect(
      replay(answering([{ id: 7, ok: true }]), [{ ...hello, expect: { ok: true } }], { wait }),
    ).rejects.toThrow(/never sent/)
    await expect(
      replay(answering([{ id: 1, ok: false, code: "unsupported_action", error: "no" }]), [failure], { wait }),
    ).resolves.toMatchObject({ messages: [{ id: 1, code: "unsupported_action" }], events: [] })
    // Events are skipped while a line waits for a response or for nothing, but must still decode; a line that
    // expects an event matches it and skips only events of other kinds.
    const tap = { event: "input_detection", alive: false, reason: "tap_disabled" }
    const quiet = { send: { $wait: 10 }, expect: null }
    await expect(
      replay(answering([tap, { id: 1, ok: false, code: "unsupported_action", error: "no" }, tap]), [failure, quiet], {
        wait,
      }),
    ).resolves.toEqual({ messages: [expect.objectContaining({ id: 1 })], events: [tap, tap] })
    await expect(replay(answering([{ event: "teleport" }]), [failure], { wait })).rejects.toThrow(
      /does not decode \(not a HelperEvent\)/,
    )
    await expect(replay(answering([{ id: 9, ok: true }]), [quiet], { wait })).rejects.toThrow(/expected nothing/)
    const stop = { event: "stop", by: "esc" }
    await expect(
      replay(answering([tap, stop]), [{ send: { $wait: 10 }, expect: { event: "stop" } }], { wait }),
    ).resolves.toEqual({ messages: [stop], events: [tap] })
  })
})

describe("capture privacy", () => {
  test("a display capture shows approved apps and the desktop furniture, and paints everything else", () => {
    const fake = start()
    expect(fake.begin(["calculator"]).ok).toBe(true)
    const { header, image } = fake.capture({ display: "1" })
    expect(header).toMatchObject({ ok: true, width: 1000, height: 640, imageScale: 1, displayId: "1" })
    const color = (x: number, y: number) => pixel(image!, ...at(header, x, y))
    expect(color(60, 200)).toEqual(COLORS.calculator)
    // Notes overlaps Calculator's right edge; Calculator is in front there.
    expect(color(260, 200)).toEqual(COLORS.calculator)
    expect(color(400, 200)).toEqual(COLORS.mask)
    expect(color(700, 200)).toEqual(COLORS.mask) // Terminal
    expect(color(100, 450)).toEqual(COLORS.mask) // System Settings
    expect(color(500, 450)).toEqual(COLORS.mask) // the bank app, not approved
    expect(color(850, 50)).toEqual(COLORS.mask) // the notification toast
    expect(color(850, 400)).toEqual(COLORS.vector) // Vector's own window
    expect(color(10, 10)).toEqual(COLORS.menuBar)
    expect(color(5, 300)).toEqual(COLORS.wallpaper)
    // The overlay is excluded, so the frame shows what lies under it.
    const overlay = Array.from({ length: image!.width * image!.height }).some((_, i) =>
      same(pixel(image!, i % image!.width, Math.floor(i / image!.width)), COLORS.overlay),
    )
    expect(overlay).toBe(false)
    expectMaskedIsPainted(header, image!)
    expect(header.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test("an unapproved window above an approved one masks the overlap; the other way round it does not", () => {
    const fake = start()
    fake.begin(["calculator"])
    fake.control({ type: "focus", windowId: "notes-1" })
    const { header, image } = fake.capture({ display: "1" })
    expect(pixel(image!, ...at(header, 260, 200))).toEqual(COLORS.mask)
    expect(pixel(image!, ...at(header, 60, 200))).toEqual(COLORS.calculator)
    expectMaskedIsPainted(header, image!)
    fake.control({ type: "focus", windowId: "calc-1" })
    const again = fake.capture({ display: "1" })
    expect(pixel(again.image!, ...at(again.header, 260, 200))).toEqual(COLORS.calculator)
    expectMaskedIsPainted(again.header, again.image!)
  })

  test("the never floor beats the approved set: Terminal and Vector stay painted and refused", () => {
    const fake = start()
    fake.begin(["calculator", "terminal", "vector"])
    const { header, image } = fake.capture({ display: "1" })
    expect(pixel(image!, ...at(header, 700, 200))).toEqual(COLORS.mask)
    expect(pixel(image!, ...at(header, 850, 400))).toEqual(COLORS.vector)
    expect(fake.capture({ windowId: "terminal-1" }).header).toMatchObject({ ok: false, code: "protected" })
    expect(fake.capture({ windowId: "vector-1" }).header).toMatchObject({ ok: false, code: "protected" })
    const [x, y] = at(header, 700, 200)
    expect(
      fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }),
    ).toMatchObject({ ok: false, code: "protected" })
    expect(fake.call("app.activate", { identity: fake.identity("terminal") })).toMatchObject({ code: "protected" })
    expect(fake.call("ui.tree", { windowId: "terminal-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "protected",
    })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  })

  test("a zoom keeps painted blocks black and cannot stand in for the frame's coordinates", () => {
    const fake = start()
    fake.begin(["calculator"])
    const full = fake.capture({ display: "1" })
    const zoom = fake.capture({ display: "1" }, FULL_DISPLAY, {
      format: "png",
      zoom: { captureId: full.header.captureId, region: { x0: 200, y0: 150, x1: 320, y1: 250 } },
    })
    expect(zoom.header).toMatchObject({ ok: true, width: 120, height: 100 })
    expect(pixel(zoom.image!, 10, 50)).toEqual(COLORS.calculator)
    expect(pixel(zoom.image!, 100, 50)).toEqual(COLORS.mask)
    expectMaskedIsPainted(zoom.header, zoom.image!)
    const click = { x: 10, y: 50, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", { captureId: zoom.header.captureId, ...click })).toMatchObject({
      code: "stale_frame",
    })
    const zoomOfZoom = fake.call("capture", {
      target: { display: "1" },
      budget: FULL_DISPLAY,
      format: "png",
      zoom: { captureId: zoom.header.captureId, region: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    })
    expect(zoomOfZoom).toMatchObject({ ok: false, code: "stale_frame" })
  })

  test("a window capture holds only that window, and a minimized one reports paused", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["calculator", "notes"])
    const { header, image } = fake.capture({ windowId: "calc-1" })
    expect(header).toMatchObject({ ok: true, width: 240, height: 320, masked: [] })
    // Notes covers this part of Calculator on screen, but a window capture never includes another window.
    expect(pixel(image!, 230, 100)).toEqual(COLORS.calculator)
    fake.helper.desktop.minimize("calc-1")
    expect(fake.call("capture", { target: { windowId: "calc-1" }, budget: FULL_DISPLAY, format: "png" })).toEqual({
      id: expect.any(Number),
      ok: true,
      paused: true,
    })
  })
})

describe("stop and held input (INV-R3)", () => {
  function holding(options: FakeOptions = {}) {
    const fake = start(options)
    fake.begin(["calculator"])
    const hold = fake.send("input.hold", {
      pid: fake.helper.desktop.app("calculator")!.pid,
      combo: ["shift"],
      ms: 10_000,
    })
    expect(fake.reply(hold)).toBeUndefined()
    return { fake, hold }
  }
  const released = (fake: ReturnType<typeof start>, reason: string) =>
    fake.index((entry) => entry.kind === "release" && entry.reason === reason && entry.keys.includes("key:shift"))
  const answered = (fake: ReturnType<typeof start>, id: number) =>
    fake.index((entry) => entry.kind === "response" && entry.id === id)

  test("Escape releases held input, then sends stop, and input stays stopped until the next session", () => {
    const { fake, hold } = holding()
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    const release = released(fake, "stop")
    const stop = fake.index((entry) => entry.kind === "event" && entry.event === "stop")
    expect(release).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(release)
    expect(fake.seen.find((message) => message.event === "stop")).toEqual({ event: "stop", by: "esc" })
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "stopped" })
    const pid = fake.helper.desktop.app("calculator")!.pid
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ code: "stopped" })
    fake.begin(["calculator"])
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
  })

  test("the stop chord stops too; with escStops off Escape is only user input, sent without the key", () => {
    const fake = start()
    fake.begin(["calculator"], { escStops: false })
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    expect(fake.seen.filter((message) => "event" in message)).toEqual([{ event: "user_input", kind: "key" }])
    expect(released(fake, "user_input")).toBe(-1)
    const userRelease = fake.index((entry) => entry.kind === "release" && entry.reason === "user_input")
    const userEvent = fake.index((entry) => entry.kind === "event" && entry.event === "user_input")
    expect(userRelease).toBeGreaterThan(-1)
    expect(userEvent).toBeGreaterThan(userRelease)
    fake.control({ type: "user_input", kind: "key", key: "Command+Shift+Escape" })
    expect(fake.seen.find((message) => message.event === "stop")).toEqual({ event: "stop", by: "chord" })
  })

  test("a missed heartbeat releases a hold in flight before it answers stopped, and latches until session.begin", () => {
    const { fake, hold } = holding()
    fake.advance(4_999)
    expect(fake.reply(hold)).toBeUndefined()
    fake.advance(1)
    expect(released(fake, "heartbeat")).toBeGreaterThan(-1)
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "heartbeat"))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "stopped" })
    const pid = fake.helper.desktop.app("calculator")!.pid
    // A late heartbeat does not undo the halt: only a new session does.
    expect(fake.call("heartbeat").ok).toBe(true)
    expect(fake.call("input.type", { pid, text: "1" })).toMatchObject({ code: "stopped" })
    fake.begin(["calculator"])
    expect(fake.call("input.type", { pid, text: "1" })).toMatchObject({ ok: true })
  })

  test("heartbeats every 2 s keep input working well past 5 s", () => {
    const fake = start()
    fake.begin(["calculator"])
    const pid = fake.helper.desktop.app("calculator")!.pid
    for (const _ of [2, 4, 6]) {
      fake.advance(2_000)
      expect(fake.call("heartbeat").ok).toBe(true)
    }
    fake.advance(1_000)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    fake.advance(3_999)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    fake.advance(1)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ code: "stopped" })
  })

  test("releaseAll ends a hold in flight and counts what it released", () => {
    const { fake, hold } = holding()
    const release = fake.send("input.releaseAll")
    expect(fake.reply(release)).toMatchObject({ ok: true, released: 1 })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "request"))
    expect(answered(fake, release)).toBeGreaterThan(answered(fake, hold))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "failed" })
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
  })

  test("cancel releases a hold before it answers, then answers the cancel", () => {
    const { fake, hold } = holding()
    const cancel = fake.send("cancel", { target: hold })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "cancel"))
    expect(answered(fake, cancel)).toBeGreaterThan(answered(fake, hold))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "failed", error: "Cancelled" })
    expect(fake.reply(cancel)).toMatchObject({ ok: true })
  })

  test("end of input releases a hold, then exits 0", () => {
    const { fake } = holding()
    fake.channel.end()
    fake.drain()
    const exit = fake.index((entry) => entry.kind === "exit")
    expect(released(fake, "eof")).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(released(fake, "eof"))
    expect(fake.state.exit).toBe(0)
  })

  test("shutdown releases a hold, answers it, answers the shutdown, then exits 0", () => {
    const { fake, hold } = holding()
    const shutdown = fake.send("shutdown")
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "shutdown"))
    expect(answered(fake, shutdown)).toBeGreaterThan(answered(fake, hold))
    expect(fake.index((entry) => entry.kind === "exit")).toBeGreaterThan(answered(fake, shutdown))
    expect(fake.reply(hold)).toMatchObject({ code: "stopped" })
    expect(fake.state.exit).toBe(0)
  })

  test("cancel reaches a queued op under latency, and is a clean no-op once it has answered", () => {
    const fake = start({ latencyMs: 100 })
    fake.begin(["calculator"])
    fake.advance(100)
    const capture = fake.send("capture", { target: { display: "1" }, budget: FULL_DISPLAY, format: "png" })
    expect(fake.reply(capture)).toBeUndefined()
    expect(fake.call("cancel", { target: capture }).ok).toBe(true)
    expect(fake.reply(capture)).toMatchObject({ ok: false, code: "failed", error: "Cancelled" })
    fake.advance(100)
    expect(fake.images.size).toBe(0)
    expect(fake.call("cancel", { target: capture }).ok).toBe(true)
  })

  test("locking the screen releases input and refuses input and capture until it unlocks", () => {
    const { fake, hold } = holding()
    fake.control({ type: "lock", locked: true })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "locked"))
    expect(fake.reply(hold)).toMatchObject({ code: "locked" })
    expect(fake.seen.find((message) => message.event === "locked")).toEqual({ event: "locked", locked: true })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ code: "locked" })
    fake.control({ type: "lock", locked: false })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ ok: true })
  })

  // M8: the helper never acts on the lock screen, and after a stop nothing comes to the front either.
  test("activation, launch and window focus refuse on a locked screen and after a stop", () => {
    const fake = start()
    fake.begin(["calculator", "notes", "textedit"])
    const desktop = fake.helper.desktop
    const order = desktop.stack().map((window) => window.windowId)
    const bringForward = () => [
      fake.call("app.launch", { identity: fake.identity("textedit") }),
      fake.call("app.activate", { identity: fake.identity("notes") }),
      fake.call("window.focus", { windowId: "notes-1" }),
    ]
    fake.control({ type: "lock", locked: true })
    expect(bringForward()).toMatchObject([{ code: "locked" }, { code: "locked" }, { code: "locked" }])
    fake.control({ type: "lock", locked: false })
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    expect(bringForward()).toMatchObject([{ code: "stopped" }, { code: "stopped" }, { code: "stopped" }])
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(desktop.app("textedit")!.running).toBe(false)
    expect(desktop.stack().map((window) => window.windowId)).toEqual(order)
    expect(fake.helper.log.filter((entry) => entry.kind === "app")).toEqual([])
    fake.begin(["calculator", "notes", "textedit"])
    expect(fake.call("window.focus", { windowId: "notes-1" })).toMatchObject({ ok: true, foreground: true })
    expect(desktop.frontmost().slot).toBe("notes")
  })
})

describe("the never floor from blocklist.json", () => {
  // Identities built from every pattern in the table, with each system and Apple flag, so the file a helper reads
  // decides exactly what ComputerApps decides.
  const identities = ComputerApps.TABLE.flatMap((entry) => [
    ...(entry.macos ?? []).flatMap((pattern) =>
      [true, false].flatMap((apple) =>
        [true, false].map((system) => ({
          app: {
            platform: "macos" as const,
            bundleId: pattern.replace(/\*$/, "x"),
            apple,
            system,
            verified: true,
            name: entry.name,
          },
          signals: {},
        })),
      ),
    ),
    ...(entry.windows?.aumid ?? []).flatMap((pattern) =>
      [true, false].map((system) => ({
        app: {
          platform: "windows" as const,
          kind: "aumid" as const,
          aumid: pattern.replace(/\*$/, "x"),
          system,
          verified: true,
          name: entry.name,
        },
        signals: {},
      })),
    ),
    ...(entry.windows?.binary ?? []).flatMap((binary) =>
      [true, false].map((system) => ({
        app: windowsExe(binary, system, entry.name),
        signals: {},
      })),
    ),
    ...(entry.windows?.windowClass ?? []).map((windowClass) => ({
      app: windowsExe("host.exe", false, entry.name),
      signals: { windowClass },
    })),
  ])

  function windowsExe(binary: string, system: boolean, name: string): Computer.AppIdentity {
    return {
      platform: "windows",
      kind: "exe",
      publisher: "Publisher",
      product: name,
      binary,
      system,
      verified: true,
      name,
      exe: `C:\\Apps\\${binary}`,
    }
  }

  test("agrees with ComputerApps on every table identity, with and without a child shell", () => {
    expect(identities.length).toBeGreaterThan(300)
    const disagreements = identities.flatMap(({ app, signals }) =>
      [signals, { ...signals, childShell: true }].flatMap((value) => {
        const category = blocklist.category(app, value)
        const never = ComputerApps.builtinRule(app, value)?.removable === false
        return category === ComputerApps.category(app, value) && blocklist.isProtected(app, value) === never
          ? []
          : [`${Computer.appKey(app)} ${JSON.stringify(value)}`]
      }),
    )
    expect(disagreements).toEqual([])
  })

  test("protects an unknown OS binary, allows a benign Apple app, and leaves Disk Utility to the desktop", () => {
    const mac = (bundleId: string, apple: boolean, system: boolean): Computer.AppIdentity => ({
      platform: "macos",
      bundleId,
      apple,
      system,
      verified: true,
      name: bundleId,
    })
    expect(blocklist.isProtected(mac("com.apple.someagent", true, true))).toBe(true)
    expect(blocklist.isProtected(mac("com.apple.Notes", true, true))).toBe(false)
    // A benign entry needs an Apple-anchored signature.
    expect(blocklist.isProtected(mac("com.apple.Notes", false, true))).toBe(true)
    const disk = mac("com.apple.DiskUtility", true, true)
    expect(blocklist.isProtected(disk)).toBe(false)
    expect(blocklist.category(disk)).toBe("general")
    expect(ComputerApps.builtinRule(disk)).toMatchObject({ removable: true, reason: "user" })
    expect(blocklist.category(mac("com.jetbrains.intellij", false, false), { childShell: true })).toBe(
      ComputerApps.category(mac("com.jetbrains.intellij", false, false), { childShell: true }),
    )
  })

  test("every fake app and window has its intended category", () => {
    const intended = {
      macos: {
        [OVERLAY]: "vector",
        "toast-1": "security",
        "calc-1": "general",
        "notes-1": "office",
        "bank-1": "general",
        "settings-1": "security",
        "terminal-1": "terminal",
        "vector-1": "vector",
        "menubar-1": "system-ui",
        "dock-1": "system-ui",
        "wallpaper-1": "system-ui",
      },
      windows: {
        [OVERLAY]: "vector",
        "toast-1": "security",
        "calc-1": "general",
        "notes-1": "general",
        "bank-1": "general",
        "settings-1": "security",
        "terminal-1": "terminal",
        "vector-1": "vector",
        "taskbar-1": "system-ui",
        "wallpaper-1": "system-ui",
      },
    } as const
    for (const platform of ["macos", "windows"] as const) {
      const desktop = start({ platform }).helper.desktop
      const categories = Object.fromEntries(
        desktop
          .stack()
          .map((window) => [
            window.windowId,
            ComputerApps.category(
              desktop.appOf(window).identity,
              window.windowClass ? { windowClass: window.windowClass } : {},
            ),
          ]),
      )
      expect(categories).toEqual(intended[platform])
      expect(ComputerApps.category(desktop.app("textedit")!.identity)).toBe("office")
      expect(ComputerApps.category(desktop.app("ide")!.identity)).toBe("developer")
      expect(blocklist.isClickOnly(desktop.app("ide")!.identity)).toBe(true)
      expect(blocklist.isClickOnly(desktop.app("textedit")!.identity)).toBe(false)
    }
  })
})

describe("approval and the refusals", () => {
  test("approval matches the exact app key, escaped exe parts included", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    const notes = fake.identity("notes")
    expect(Computer.appKey(notes)).toBe("app:windows:exe:contoso ltd.|notes %7c pro 100%25|contosonotes.exe")
    // The same text written already escaped is a different app.
    const lookalike = { ...notes, product: "Notes %7c Pro 100%25" }
    fake.begin([], { approved: [lookalike], vectorPids: [600] })
    const display = "\\\\.\\DISPLAY1"
    const first = fake.capture({ display })
    expect(pixel(first.image!, ...at(first.header, 400, 200))).toEqual(COLORS.mask)
    const [x, y] = at(first.header, 400, 200)
    const click = { captureId: first.header.captureId, x, y, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", click)).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [notes] })
    const second = fake.capture({ display })
    expect(pixel(second.image!, ...at(second.header, 400, 200))).toEqual(COLORS.notes)
    expect(fake.call("input.click", { ...click, captureId: second.header.captureId })).toMatchObject({ ok: true })
  })

  test("a secure field refuses typing and setValue, never shows a value, and reports secure input in front", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    const pid = fake.helper.desktop.app("notes")!.pid
    expect(fake.call("input.type", { pid, text: " list" })).toMatchObject({ ok: true })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    expect(fake.seen.at(-1)).toEqual({
      event: "input_detection",
      alive: false,
      reason: "secure_input",
      holder: "Notes",
    })
    expect(fake.call("input.type", { pid, text: "hunter2" })).toMatchObject({ code: "secure_field" })
    // Key by key is typing too (INV-S4); navigation and editing keys and shortcuts are not, so a handoff still works.
    // The rule fails closed: a key it does not know types, and Option is a text modifier on macOS (Option+S is ß).
    for (const combo of [
      ["h"],
      ["Shift", "H"],
      ["KeyH"],
      ["space"],
      ["AltGr", "2"],
      ["h", "2"],
      ["IntlBackslash"],
      ["IntlRo"],
      ["NumpadEqual"],
      ["NumpadComma"],
      ["Option", "KeyS"],
      ["Alt", "Shift", "k"],
      ["fn", "e"],
    ])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "secure_field" })
    expect(fake.call("input.hold", { pid, combo: ["h"], ms: 1000 })).toMatchObject({ code: "secure_field" })
    expect(fake.call("input.hold", { pid, combo: ["IntlYen"], ms: 1000 })).toMatchObject({ code: "secure_field" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(1)
    for (const combo of [
      ["Tab"],
      ["Enter"],
      ["Backspace"],
      ["ArrowLeft"],
      ["Command", "a"],
      ["Control", "a"],
      ["Shift"],
      ["Option", "ArrowLeft"],
      ["Escape"],
      ["PageDown"],
      ["F5"],
      ["MediaPlayPause"],
    ])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
    const tree = fake.call("ui.tree", { pid, maxNodes: 50, maxDepth: 4 })
    const password = tree.nodes.find((item: Message) => item.secure)
    expect(password).toMatchObject({ role: "AXSecureTextField", focused: true })
    expect(password).not.toHaveProperty("value")
    expect(tree.nodes.find((item: Message) => item.name === "Title").value).toBe("Groceries list")
    expect(fake.call("ui.setValue", { ref: password.ref, value: "hunter2" })).toMatchObject({ code: "secure_field" })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    expect(fake.seen.at(-1)).toEqual({ event: "input_detection", alive: true })
    expect(JSON.stringify(fake.helper.log)).not.toContain("hunter2")
  })

  // Windows: Ctrl+Alt is AltGr, and Alt with numpad digits types an Alt code; Alt or Ctrl alone is a shortcut.
  test("on Windows a secure field refuses AltGr and Alt-code typing but takes shortcuts", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    fake.begin(["notes"])
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    const pid = fake.helper.desktop.app("notes")!.pid
    for (const combo of [["Control", "Alt", "KeyQ"], ["Ctrl", "Alt", "2"], ["Alt", "Numpad2"], ["IntlBackslash"]])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "secure_field" })
    for (const combo of [["Control", "a"], ["Alt", "f"], ["Win", "d"], ["Control", "Alt", "Delete"], ["Tab"]])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
  })

  // Secure event input is a macOS signal (M6); Windows has no such state (W9 lists its own reasons). On macOS the event
  // follows every way an app comes to the front, AXRaise included.
  test("secure input is reported on macOS only, and also when AXRaise brings the secure field forward", () => {
    const windows = start({ platform: "windows", scenario: "notes" })
    windows.begin(["notes"])
    windows.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    expect(windows.seen.filter((message) => "event" in message)).toEqual([])
    const pid = windows.helper.desktop.app("notes")!.pid
    expect(windows.call("input.type", { pid, text: "x" })).toMatchObject({ code: "secure_field" })

    const mac = start({ scenario: "notes" })
    mac.begin(["calculator", "notes"])
    mac.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    mac.control({ type: "focus", windowId: "calc-1" })
    const events = () => mac.seen.filter((message) => "event" in message)
    expect(events()).toEqual([
      { event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" },
      { event: "input_detection", alive: true },
    ])
    const tree = mac.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 1 })
    expect(mac.call("ui.perform", { ref: tree.nodes[0].ref, action: "AXRaise" })).toMatchObject({
      ok: true,
      took: true,
    })
    expect(mac.helper.desktop.frontmost().slot).toBe("notes")
    expect(events().at(-1)).toEqual({ event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" })
  })

  // Section 7: typed text is kept as a length only, whichever op typed it, and the user's own keys are never kept.
  test("the action log keeps typed keys as a length and shortcuts as their combo", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    const pid = fake.helper.desktop.app("notes")!.pid
    for (const key of ["h", "u", "n", "t", "e", "r", "2"])
      expect(fake.call("input.key", { pid, combo: [key], repeat: 1 })).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid, combo: ["Shift", "KeyQ"], repeat: 3 })).toMatchObject({ ok: true })
    const hold = fake.send("input.hold", { pid, combo: ["Shift", "z"], ms: 100 })
    fake.advance(100)
    expect(fake.reply(hold)).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid, combo: ["Command", "s"], repeat: 1 })).toMatchObject({ ok: true })
    fake.control({ type: "user_input", kind: "key", key: "j" })
    const input = fake.helper.log.filter((entry) => entry.kind === "input")
    expect(input).toHaveLength(10)
    expect(input.slice(0, 7)).toEqual(
      Array.from({ length: 7 }, () => expect.objectContaining({ op: "key", types: true, length: 1 })),
    )
    expect(input[7]).toMatchObject({ op: "key", types: true, length: 3 })
    expect(input[8]).toMatchObject({ op: "hold", types: true, ms: 100 })
    expect(input.slice(0, 9).every((entry) => !("combo" in entry))).toBe(true)
    expect(input[9]).toMatchObject({ op: "key", combo: ["Command", "s"], repeat: 1 })
    const log = JSON.stringify(fake.helper.log)
    for (const text of ['"h"', '"r"', '"2"', "KeyQ", '"z"', "key:z", '"j"']) expect(log).not.toContain(text)
    expect(log).toContain("key:Shift")
  })

  // 1.5 E and M9: Alongside me acts through the target's elements and app-directed keys without moving the pointer or
  // taking focus; a step that needs the real pointer, or that would bring something forward, answers needs_foreground
  // with no side effect, so the desktop can raise the pointer ask (D19).
  test("a background session acts through elements without taking focus; anything else needs the foreground", () => {
    const fake = start({ scenario: "notes" })
    expect(fake.begin(["calculator", "notes", "textedit"], { mode: "background" })).toMatchObject({ ok: true })
    const desktop = fake.helper.desktop
    const order = () => desktop.stack().map((window) => window.windowId)
    const before = order()
    const pointer = (op: string, x: number, y: number, extra: Message = {}) => {
      const { header } = fake.capture({ display: "1" })
      const [px, py] = at(header, x, y)
      return fake.call(op, { captureId: header.captureId, x: px, y: py, ...extra })
    }
    const click = (x: number, y: number, extra: Message = {}) =>
      pointer("input.click", x, y, { button: "left", count: 1, modifiers: [], ...extra })
    const drag = () => {
      const { header } = fake.capture({ display: "1" })
      const [px, py] = at(header, 70, 170)
      const path = [
        { x: px, y: py },
        { x: px + 5, y: py },
      ]
      return fake.call("input.drag", { captureId: header.captureId, path, button: "left", modifiers: [] })
    }
    // Calculator's 7 behind Notes: pressed through its element.
    expect(click(70, 170)).toMatchObject({ ok: true })
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 50, maxDepth: 4 }).nodes[1].value).toBe("7")
    expect(desktop.frontmost().slot).toBe("notes")
    expect(order()).toEqual(before)
    // Notes' body behind Calculator: focused through its element, then typed into with app-directed keys.
    fake.control({ type: "focus", windowId: "calc-1" })
    const behind = order()
    expect(click(400, 200)).toMatchObject({ ok: true })
    const notes = desktop.app("notes")!.pid
    expect(fake.call("input.type", { pid: notes, text: " list" })).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid: notes, combo: ["Enter"], repeat: 1 })).toMatchObject({ ok: true })
    expect(desktop.window("notes-1")!.nodes.find((item) => item.id === "notes.body")!.value).toBe("Milk, eggs list")
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(order()).toEqual(behind)
    const acted = fake.helper.log.filter((entry) => entry.kind === "input").length
    // Everything that needs the real pointer or would take focus.
    const needs = [
      click(590, 120), // Notes, but no element there
      click(60, 100), // Calculator's display: an element with nothing to press or focus
      click(70, 170, { button: "right" }),
      click(70, 170, { count: 2 }),
      click(70, 170, { modifiers: ["shift"] }),
      pointer("input.move", 70, 170),
      pointer("input.scroll", 400, 200, { dx: 0, dy: 3 }),
      drag(),
      fake.call("app.activate", { identity: fake.identity("notes") }),
      fake.call("app.launch", { identity: fake.identity("textedit") }),
      fake.call("window.focus", { windowId: "notes-1" }),
      fake.call("ui.perform", {
        ref: fake.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 1 }).nodes[0].ref,
        action: "AXRaise",
      }),
    ]
    expect(needs.map((reply) => reply.code)).toEqual(Array.from({ length: needs.length }, () => "needs_foreground"))
    // The never floor and the approved set still answer first.
    expect(click(700, 200)).toMatchObject({ code: "protected" })
    expect(click(500, 500)).toMatchObject({ code: "not_granted" })
    expect(order()).toEqual(behind)
    desktop.minimize("notes-1")
    expect(fake.call("input.type", { pid: notes, text: "x" })).toMatchObject({ code: "needs_foreground" })
    expect(desktop.window("notes-1")!.minimized).toBe(true)
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(acted)
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(desktop.app("textedit")!.running).toBe(false)
  })

  test("a helper without background support refuses a background session", () => {
    for (const options of [{ platform: "windows" }, { disabled: ["background"] }] satisfies FakeOptions[]) {
      const fake = start(options)
      expect(fake.call("hello", { protocol: { min: 1, max: 1 } }).features.background).toBe(false)
      expect(fake.begin(["calculator"], { mode: "background" })).toMatchObject({ code: "unsupported_action" })
      expect(fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header).toMatchObject({
        code: "unavailable",
      })
      expect(fake.begin(["calculator"]).ok).toBe(true)
      expect(fake.call("session.update", { mode: "background" })).toMatchObject({ code: "unsupported_action" })
      expect(fake.call("session.update", { mode: "foreground" }).ok).toBe(true)
    }
  })

  // M6 and W7: IDEs are click-only, so the helper refuses typing into them too, whatever the desktop's gate decided.
  test("a developer app is click-only: clicks, shortcuts and navigation keys work, text input is refused", () => {
    for (const platform of ["macos", "windows"] as const) {
      const fake = start({ platform })
      fake.begin(["ide"])
      expect(fake.call("app.launch", { identity: fake.identity("ide") })).toMatchObject({ ok: true, foreground: true })
      const pid = fake.helper.desktop.app("ide")!.pid
      expect(fake.call("input.type", { pid, text: "rm -rf build" })).toMatchObject({ code: "blocked" })
      // Option types on macOS and Ctrl+Alt is AltGr on Windows; an unknown key name types too.
      const typing = platform === "macos" ? ["Option", "KeyS"] : ["Control", "Alt", "KeyQ"]
      for (const combo of [["x"], ["Shift", "X"], ["KeyX"], ["Digit4"], ["space"], ["IntlBackslash"], typing])
        expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "blocked" })
      expect(fake.call("input.hold", { pid, combo: ["x"], ms: 500 })).toMatchObject({ code: "blocked" })
      const tree = fake.call("ui.tree", { pid, maxNodes: 50, maxDepth: 4 })
      const editor = tree.nodes.find((item: Message) => item.role === "AXTextArea")
      expect(fake.call("ui.setValue", { ref: editor.ref, value: "x" })).toMatchObject({ code: "blocked" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      const shortcut = platform === "macos" ? "Command" : "Control"
      for (const combo of [[shortcut, "s"], ["Enter"], ["ArrowDown"], ["Tab"]])
        expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
      const { header, image } = fake.capture({ display: platform === "macos" ? "1" : "\\\\.\\DISPLAY1" })
      const [x, y] = at(header, 400, 300)
      expect(pixel(image!, x, y)).toEqual(COLORS.ide)
      expect(
        fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }),
      ).toMatchObject({ ok: true })
      expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({
        op: "click",
        windowId: "ide-1",
        node: "ide.text",
      })
    }
  })

  test("ui.tree refuses protected and unapproved apps; refs go stale when the UI changes", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(fake.call("ui.tree", { windowId: "terminal-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "protected",
    })
    expect(fake.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "not_granted",
    })
    const tree = fake.call("ui.tree", { pid: fake.helper.desktop.app("calculator")!.pid, maxNodes: 50, maxDepth: 4 })
    const seven = tree.nodes.find((item: Message) => item.name === "7")
    expect(fake.call("ui.perform", { ref: seven.ref, action: "AXPress" })).toMatchObject({ ok: true, took: true })
    expect(fake.call("ui.perform", { ref: seven.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
    const after = fake.call("ui.tree", { windowId: "calc-1", maxNodes: 50, maxDepth: 4 })
    expect(after.nodes.find((item: Message) => item.name === "Display").value).toBe("7")
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 3, maxDepth: 4 })).toMatchObject({
      truncated: true,
      nodes: expect.any(Array),
    })
  })

  test("a hit-test names the owner of any window, but the element only in an approved app", () => {
    const fake = start()
    fake.begin(["calculator"])
    const { header } = fake.capture({ display: "1" })
    const hit = (x: number, y: number) => {
      const [px, py] = at(header, x, y)
      return fake.call("ui.hittest", { captureId: header.captureId, x: px, y: py })
    }
    const terminal = hit(700, 200)
    expect(terminal).toMatchObject({
      ok: true,
      windowId: "terminal-1",
      owner: fake.identity("terminal"),
      secure: false,
    })
    expect(terminal).not.toHaveProperty("name")
    expect(terminal).not.toHaveProperty("ref")
    expect(terminal).not.toHaveProperty("elementId")
    expect(terminal).not.toHaveProperty("windowTitle")
    const notes = hit(400, 200)
    expect(notes).toMatchObject({ windowId: "notes-1", owner: fake.identity("notes") })
    expect(notes).not.toHaveProperty("name")
    expect(notes).not.toHaveProperty("elementId")
    expect(notes).not.toHaveProperty("windowTitle")
    expect(hit(70, 170)).toMatchObject({ windowId: "calc-1", role: "AXButton", name: "7", ref: expect.any(String) })
  })

  test("pointer input checks the frame first, then the owner, and acts on the window under the point", () => {
    const fake = start()
    fake.begin(["calculator"])
    const { header } = fake.capture({ display: "1" })
    const click = (x: number, y: number) =>
      fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] })
    expect(click(-1, 5)).toMatchObject({ code: "out_of_bounds" })
    expect(click(1000, 5)).toMatchObject({ code: "out_of_bounds" })
    expect(click(...at(header, 400, 200))).toMatchObject({ code: "not_granted" })
    expect(click(...at(header, 10, 10))).toMatchObject({ code: "not_granted" }) // the menu bar is never a target
    expect(click(...at(header, 70, 170))).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toMatchObject([
      { op: "click", windowId: "calc-1", node: "calculator.7" },
    ])
    // Raising Notes over the point means a different window is there now.
    fake.helper.desktop.raise("notes-1")
    expect(click(...at(header, 260, 200))).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [fake.identity("calculator"), fake.identity("notes")] })
    expect(click(...at(header, 260, 200))).toMatchObject({ code: "changed" })
    fake.helper.desktop.move("calc-1", { x: 41, y: 60, w: 240, h: 320 })
    expect(click(...at(header, 70, 170))).toMatchObject({ code: "stale_frame" })
  })

  test("keyboard input goes only to the focused app the step named", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(
      fake.call("input.key", { pid: fake.helper.desktop.app("notes")!.pid, combo: ["a"], repeat: 1 }),
    ).toMatchObject({ code: "changed" })
    fake.control({ type: "focus", windowId: "terminal-1" })
    expect(fake.call("input.type", { pid: fake.helper.desktop.app("terminal")!.pid, text: "rm -rf ~" })).toMatchObject({
      code: "protected",
    })
  })

  test("focused observations retain field identity across value changes and scope it to the helper session", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
    const before = fake.call("ui.focused")
    expect(before).toMatchObject({
      enabled: true,
      editable: true,
      windowTitle: "Groceries",
      layout: { platform: "macos", keys: { KeyQ: { key: "q", shift: "Q" } } },
      focusedMenuShortcuts: [],
    })
    expect(typeof before.elementId).toBe("string")
    expect(
      fake.call("input.type", {
        pid: fake.helper.desktop.app("notes")!.pid,
        windowId: before.windowId,
        ref: before.ref,
        text: "z",
      }),
    ).toMatchObject({ ok: true })
    const after = fake.call("ui.focused")
    expect(after.ref).not.toBe(before.ref)
    expect(after.elementId).toBe(before.elementId)
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    const title = fake.call("ui.focused")
    expect(title.elementId).not.toBe(before.elementId)
    fake.begin(["notes"])
    expect(fake.call("ui.focused").elementId).not.toBe(title.elementId)
  })

  for (const target of [
    { platform: "macos", mode: "foreground" },
    { platform: "windows", mode: "foreground" },
    { platform: "macos", mode: "background" },
  ] as const)
    test(`${target.platform} ${target.mode} keyboard input binds the focused window and element`, () => {
      const fake = start({ scenario: "notes", platform: target.platform })
      fake.begin(["notes", "calculator"], { mode: target.mode })
      fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
      const pid = fake.helper.desktop.app("notes")!.pid
      const before = fake.call("ui.focused")
      const inputs = [
        { op: "input.type", text: "z" },
        { op: "input.key", combo: ["ArrowLeft"], repeat: 1 },
        { op: "input.hold", combo: ["ArrowLeft"], ms: 0 },
      ]
      for (const input of inputs)
        expect(fake.call(input.op, { ...input, pid, windowId: "calc-1" })).toMatchObject({ code: "changed" })
      fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
      expect(fake.call("ui.focused")).toMatchObject({ owner: { pid }, windowId: before.windowId, name: "Title" })
      for (const input of inputs)
        expect(fake.call(input.op, { ...input, pid, windowId: before.windowId, ref: before.ref })).toMatchObject({
          code: "changed",
        })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      for (const input of inputs) {
        const live = fake.call("ui.focused")
        const id = fake.send(input.op, { ...input, pid, windowId: live.windowId, ref: live.ref })
        fake.advance(0)
        expect(fake.reply(id)).toMatchObject({ ok: true })
      }
      expect(fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value).toBe(
        "Groceriesz",
      )
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(3)
    })

  test("the focused reference is checked after a queued typing request reaches the helper", () => {
    const fake = start({ scenario: "notes", latencyMs: 100 })
    fake.begin(["notes"])
    fake.advance(100)
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
    const focused = fake.send("ui.focused")
    fake.advance(100)
    const before = fake.reply(focused)!
    const typing = fake.send("input.type", {
      pid: fake.helper.desktop.app("notes")!.pid,
      windowId: before.windowId,
      ref: before.ref,
      text: "z",
    })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    fake.advance(100)
    expect(fake.reply(typing)).toMatchObject({ code: "changed" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
    expect(fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value).toBe(
      "Groceries",
    )
  })

  test("activation and launch follow the approved set", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(fake.call("app.activate", { identity: fake.identity("notes") })).toMatchObject({ code: "not_granted" })
    expect(fake.call("window.focus", { windowId: "settings-1" })).toMatchObject({ code: "protected" })
    expect(fake.call("app.launch", { identity: fake.identity("textedit") })).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [fake.identity("calculator"), fake.identity("textedit")] })
    expect(fake.call("app.launch", { path: "/System/Applications/TextEdit.app" })).toMatchObject({
      ok: true,
      foreground: true,
    })
    expect(fake.helper.desktop.frontmost().slot).toBe("textedit")
  })

  test("apps.list and input.releaseAll work without a session; ops that act need one", () => {
    const fake = start()
    const list = fake.call("apps.list")
    const titles = Object.fromEntries(
      list.apps.flatMap((app: Message) => app.windows.map((window: Message) => [window.windowId, window.title])),
    )
    expect(titles["calc-1"]).toBe("Calculator")
    expect(titles["terminal-1"]).toBe("")
    expect(titles["settings-1"]).toBe("")
    expect(titles["vector-1"]).toBe("")
    expect(list.apps.some((app: Message) => app.identity.name === "TextEdit")).toBe(false)
    const installed = fake.call("apps.list", { installed: true })
    expect(installed.apps.find((app: Message) => app.identity.name === "TextEdit")).toMatchObject({
      active: false,
      windows: [],
    })
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ code: "unavailable" })
    expect(fake.call("input.key", { pid: 501, combo: ["a"], repeat: 1 })).toMatchObject({ code: "unavailable" })
    fake.begin(["calculator"])
    expect(fake.call("session.end").ok).toBe(true)
    expect(fake.call("apps.list").ok).toBe(true)
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
  })
})

describe("coordinates", () => {
  test("downscaling stays within every budget limit after rounding", () => {
    const budgets = [
      { maxWidth: 1280, maxHeight: 800, maxPixels: 1_048_576 },
      { maxWidth: 4096, maxHeight: 4096, maxPixels: 100_003 },
      { maxWidth: 333, maxHeight: 4096, maxPixels: 4096 * 4096 },
      { maxWidth: 16_384, maxHeight: 16_384, maxPixels: 100 },
      { maxWidth: 1, maxHeight: 1, maxPixels: 1 },
    ]
    for (const size of [
      [2000, 1280],
      [1601, 999],
      [10_000, 1],
      [1, 10_000],
      [640, 400],
    ] as const)
      for (const budget of budgets) {
        const out = fit(size[0], size[1], budget)
        expect(out.width).toBeGreaterThanOrEqual(1)
        expect(out.height).toBeGreaterThanOrEqual(1)
        expect(out.width).toBeLessThanOrEqual(Math.min(budget.maxWidth, size[0]))
        expect(out.height).toBeLessThanOrEqual(Math.min(budget.maxHeight, size[1]))
        expect(out.width * out.height).toBeLessThanOrEqual(budget.maxPixels)
        // Each pixel's centre lies inside the target at the reported scale, unless a side had to be raised to one.
        expect(out.width === 1 || out.width - 0.5 < size[0] * out.scale).toBe(true)
        expect(out.height === 1 || out.height - 0.5 < size[1] * out.scale).toBe(true)
      }
    expect(fit(640, 400, FULL_DISPLAY)).toEqual({ width: 640, height: 400, scale: 1 })
  })

  // When the two sides round down differently, imageScale must still be the one scale both sides were cut with:
  // the smaller of the two ratios would map the last column or row outside the target and leave it unpainted.
  test("a capture under an odd budget paints every pixel and maps its last column and row into the target", () => {
    const fake = start()
    fake.begin(["calculator"])
    const unbounded = { maxHeight: 4096, maxPixels: 4096 * 4096 }
    const opaque = (image: Image) => image.rgba.every((value, index) => index % 4 !== 3 || value === 255)
    const display = fake.capture({ display: "1" }, { maxWidth: 999, ...unbounded })
    expect(display.header).toMatchObject({ ok: true, width: 999, height: 639, imageScale: 0.999 })
    expect(opaque(display.image!)).toBe(true)
    expectMaskedIsPainted(display.header, display.image!)
    const right = display.header.width - 1
    const bottom = display.header.height - 1
    for (const [x, y, windowId] of [
      [right, 0, "menubar-1"],
      [right, bottom, "wallpaper-1"],
      [0, bottom, "wallpaper-1"],
    ] as const)
      expect(fake.call("ui.hittest", { captureId: display.header.captureId, x, y })).toMatchObject({
        ok: true,
        windowId,
      })
    const window = fake.capture({ windowId: "calc-1" }, { maxWidth: 239, ...unbounded })
    expect(window.header).toMatchObject({ ok: true, width: 239, height: 318 })
    const image = window.image!
    expect(
      Array.from({ length: image.width * image.height }).every((_, i) =>
        same(pixel(image, i % image.width, Math.floor(i / image.width)), COLORS.calculator),
      ),
    ).toBe(true)
    const click = { captureId: window.header.captureId, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", { ...click, x: image.width - 1, y: image.height - 1 })).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "calc-1" })
  })

  test("a downscaled capture of a second display with a negative origin maps back to the right window", () => {
    const fake = start({ scenario: "multi-display" })
    fake.begin(["notes"])
    const displays = fake.call("displays.list").displays
    expect(displays).toContainEqual({
      id: "2",
      bounds: { x: -800, y: -200, w: 800, h: 500 },
      pixelSize: { w: 1600, h: 1000 },
      scale: 2,
      primary: false,
    })
    const budget = { maxWidth: 1000, maxHeight: 1000, maxPixels: 500_000 }
    const { header, image } = fake.capture({ display: "2" }, budget)
    expect(header).toMatchObject({ ok: true, origin: { x: -800, y: -200 }, displayId: "2" })
    expect(header.width).toBeLessThanOrEqual(budget.maxWidth)
    expect(header.width * header.height).toBeLessThanOrEqual(budget.maxPixels)
    expect(header.imageScale).toBeLessThan(2)
    const point = at(header, -500, 0)
    expect(pixel(image!, ...point)).toEqual(COLORS.notes)
    expect(fake.call("ui.hittest", { captureId: header.captureId, x: point[0], y: point[1] })).toMatchObject({
      windowId: "notes-1",
      owner: fake.identity("notes"),
    })
    const click = { captureId: header.captureId, x: point[0], y: point[1], button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", click)).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "notes-1" })
    // A zoom of the downscaled frame comes back at the display's native resolution.
    const zoom = fake.capture({ display: "2" }, FULL_DISPLAY, {
      zoom: { captureId: header.captureId, region: { x0: 0, y0: 0, x1: 100, y1: 50 } },
    })
    expect(zoom.header.ok).toBe(true)
    expect(zoom.header.imageScale).toBeCloseTo(2, 1)
    expect(zoom.header.width).toBeGreaterThan(100)
    fake.control({ type: "display_change" })
    expect(fake.seen.at(-1)).toEqual({ event: "display_change" })
    expect(fake.call("input.click", click)).toMatchObject({ code: "stale_frame" })
    expect(fake.call("ui.hittest", { captureId: header.captureId, x: point[0], y: point[1] })).toMatchObject({
      code: "stale_frame",
    })
  })
})

describe("options", () => {
  test("hello answers its own range and refuses a range it does not share", () => {
    const fake = start({ protocol: { min: 2, max: 2 } })
    expect(fake.call("hello", { protocol: { min: 1, max: 1 } })).toMatchObject({
      ok: false,
      code: "helper_incompatible",
    })
    expect(fake.call("hello", { protocol: { min: 1, max: 2 } })).toMatchObject({
      ok: true,
      protocol: { min: 2, max: 2 },
    })
  })

  test("a feature turned off is reported in hello and its op answers unsupported_action", () => {
    const fake = start({ disabled: ["ui.tree"] })
    const hello = fake.call("hello", { protocol: { min: 1, max: 1 } })
    expect(hello.features).toMatchObject({ "ui.tree": false, "capture.display": true, locked: false, background: true })
    fake.begin(["calculator"])
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 10, maxDepth: 2 })).toMatchObject({
      code: "unsupported_action",
    })
    expect(start({ platform: "windows" }).call("hello", { protocol: { min: 1, max: 1 } }).features.background).toBe(
      false,
    )
  })

  // W2's dispatch table: Windows has no permission prompt to request or reset, and no clipboard ops.
  test("on Windows permissions.request, permissions.reset and the clipboard answer unsupported_action", () => {
    const windows = start({ platform: "windows" })
    expect(windows.call("hello", { protocol: { min: 1, max: 1 } }).features).toMatchObject({ clipboard: false })
    for (const op of ["permissions.request", "permissions.reset"])
      expect(windows.call(op, { service: "screen" })).toMatchObject({ code: "unsupported_action" })
    windows.begin(["calculator"])
    expect(windows.call("clipboard.write", { text: "4" })).toMatchObject({ code: "unsupported_action" })
    expect(windows.call("clipboard.read")).toMatchObject({ code: "unsupported_action" })
    expect(windows.helper.log.filter((entry) => entry.kind === "permissions" || entry.kind === "clipboard")).toEqual([])
    const mac = start()
    expect(mac.call("hello", { protocol: { min: 1, max: 1 } }).features).toMatchObject({ clipboard: true })
    expect(mac.call("permissions.reset", { service: "screen" })).toMatchObject({ ok: true })
    mac.begin(["calculator"])
    expect(mac.call("clipboard.write", { text: "4" }).ok).toBe(true)
    expect(mac.call("clipboard.read")).toMatchObject({ ok: true, text: "4" })
  })

  // A feature reported off must behave off, so desktop tests can cover the fallback main owns.
  test("without capture.exclude the overlay is painted; without ui.secureFieldDetect nothing is reported secure", () => {
    const shown = start({ disabled: ["capture.exclude"] })
    shown.begin(["calculator"])
    const { header, image } = shown.capture({ display: "1" })
    // The overlay is one of Vector's windows, so it is painted as a Vector block over the whole display.
    expect(pixel(image!, ...at(header, 60, 200))).toEqual(COLORS.vector)
    expect(header.masked).toContainEqual({ x: 0, y: 0, w: 1000, h: 640 })
    expectMaskedIsPainted(header, image!)
    // It still takes no clicks, so a click goes to the window under it.
    const [x, y] = at(header, 70, 170)
    const click = { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }
    expect(shown.call("input.click", click)).toMatchObject({ ok: true })
    expect(shown.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "calc-1" })

    const blind = start({ scenario: "notes", disabled: ["ui.secureFieldDetect"] })
    blind.begin(["notes"])
    blind.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    const password = blind
      .call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 4 })
      .nodes.find((item: Message) => item.role === "AXSecureTextField")
    expect(password).toMatchObject({ focused: true, secure: false })
    // The OS still hides a password field's value; only the helper's own detection is off.
    expect(password).not.toHaveProperty("value")
    expect(blind.call("ui.focused")).toMatchObject({ windowId: "notes-1", secure: false })
    // The helper cannot tell, so it does not refuse: the desktop's own gate must (D14, D16).
    expect(blind.call("ui.setValue", { ref: password.ref, value: "c" })).toMatchObject({ ok: true, took: true })
    const pid = blind.helper.desktop.app("notes")!.pid
    expect(blind.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    expect(blind.call("input.type", { pid, text: "b" })).toMatchObject({ ok: true })
  })

  test("denied permissions show in status and refuse the ops that need them, without a prompt", () => {
    const mac = start({ deny: ["screen", "accessibility"] })
    expect(mac.call("permissions.status")).toMatchObject({ screen: "denied", accessibility: "denied" })
    mac.begin(["calculator"])
    expect(mac.capture({ display: "1" }).header).toMatchObject({ code: "permissions" })
    expect(mac.call("ui.tree", { windowId: "calc-1", maxNodes: 10, maxDepth: 2 })).toMatchObject({
      code: "permissions",
    })
    expect(mac.call("input.key", { pid: 501, combo: ["a"], repeat: 1 })).toMatchObject({ code: "permissions" })
    expect(mac.call("permissions.request", { service: "screen" })).toMatchObject({ screen: "denied" })
    expect(mac.helper.log.find((entry) => entry.kind === "permissions")).toMatchObject({ service: "screen" })
    const windows = start({ platform: "windows", deny: ["screen"] })
    expect(windows.call("permissions.status")).toMatchObject({
      screen: "n/a",
      accessibility: "n/a",
      captureBlocked: true,
    })
    windows.begin(["calculator"])
    expect(windows.capture({ display: "\\\\.\\DISPLAY1" }).header).toMatchObject({ code: "blocked_by_os" })
  })

  test("crash-after exits 1 without answering, and hang-hello never answers hello", () => {
    const crash = start({ crashAfter: 1 })
    expect(crash.call("permissions.status").ok).toBe(true)
    expect(crash.reply(crash.send("permissions.status"))).toBeUndefined()
    expect(crash.state.exit).toBe(1)
    const hang = start({ hangHello: true })
    expect(hang.reply(hang.send("hello", { protocol: { min: 1, max: 1 } }))).toBeUndefined()
    hang.advance(60_000)
    expect(hang.seen).toEqual([])
    expect(hang.call("permissions.status").ok).toBe(true)
  })

  test("the command line prints its version and probe, and refuses bad usage with exit 2", () => {
    const run = (...argv: string[]) => {
      const out: string[] = []
      const err: string[] = []
      const code = main(argv, { out: (text) => void out.push(text), err: (text) => void err.push(text) })
      return { code, out: out.join(""), err: err.join("") }
    }
    const version = run("--version", "--json")
    expect(version.code).toBe(0)
    expect(JSON.parse(version.out)).toMatchObject({
      helperVersion: "1.0.0",
      protocol: { min: 1, max: 1 },
      platform: "darwin",
    })
    expect(JSON.parse(run("--version", "--json", "--platform", "windows", "--protocol", "1..2").out)).toMatchObject({
      platform: "win32",
      protocol: { min: 1, max: 2 },
    })
    expect(JSON.parse(run("--probe", "--json").out)).toEqual({
      permissions: { screen: "granted", accessibility: "granted" },
      responsible: true,
    })
    expect(JSON.parse(run("--probe", "--json", "--fail", "deny:screen").out).permissions.screen).toBe("denied")
    expect(JSON.parse(run("--probe", "--json", "--platform", "windows", "--fail", "deny:screen").out)).toEqual({
      permissions: { screen: "n/a", accessibility: "n/a" },
      captureBlocked: true,
      elevated: false,
      responsible: true,
    })
    expect(
      parseCli([
        "--stdio",
        "--parent-pid",
        "42",
        "--channel",
        "stdio",
        "--control-fd",
        "4",
        "--features",
        "-ui.tree,-clipboard",
        "--fail",
        "deny:screen",
        "--fail",
        "crash-after:3",
        "--latency",
        "50",
        "--scenario",
        "notes",
      ]),
    ).toEqual({
      mode: "serve",
      parentPid: 42,
      channel: "stdio",
      controlFd: 4,
      options: {
        platform: "macos",
        scenario: "notes",
        disabled: ["ui.tree", "clipboard"],
        crashAfter: 3,
        hangHello: false,
        deny: ["screen"],
        latencyMs: 50,
      },
    })
    for (const argv of [
      [],
      ["--version"],
      ["--stdio"],
      ["--stdio", "--parent-pid", "x"],
      ["--version", "--json", "--frobnicate"],
      ["--version", "--json", "--protocol", "2..1"],
      ["--version", "--json", "--features", "ui.tree"],
      ["--version", "--json", "--fail", "explode"],
      ["--version", "--json", "--platform", "windows", "--fail", "deny:accessibility"],
      ["--stdio", "--parent-pid", "1", "--control-fd", "1"],
    ])
      expect(run(...argv).code).toBe(2)
  })

  test("the fake's sources stay Node-only: no Bun APIs, and only node:, effect and the shared schemas", async () => {
    for (const file of ["fake-helper.ts", "fake-desktop.ts", "png.ts", "transcript.ts"]) {
      const source = await Bun.file(path.join(import.meta.dir, file)).text()
      expect(source).not.toMatch(/\bBun\.|["']bun(?::[\w-]+)?["']/)
      const specifiers = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((match) => match[1]!)
      expect(specifiers.length).toBeGreaterThan(0)
      for (const specifier of specifiers)
        expect(specifier).toMatch(
          /^(?:node:[\w/]+|effect|@vectordevai\/schema\/[\w-]+|\.\/[\w-]+|\.\.\/\.\.\/native\/computer-helper\/[\w-]+\.json)$/,
        )
    }
  })
})
