import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { Computer } from "@vectordevai/schema/computer"
import { OVERLAY } from "../../test/computer/fake-desktop"
import { createFakeHelper, manualClock, type FakeOptions } from "../../test/computer/fake-helper"
import { decodePng } from "../../test/computer/png"
import { readTranscript, replay, type Channel, type Received } from "../../test/computer/transcript"
import { NativeHelperBackend } from "./computer-backend"
import { createHelperClient, type HelperChannel } from "./computer-helper"
import { FrameDecoder } from "./computer-protocol"

// Everything here is an in-process virtual desktop. No process, Electron, real display or OS consent API runs.
const FIXTURES = path.join(import.meta.dir, "../../test/fixtures/computer-protocol")

describe("native-helper protocol conformance", () => {
  // Malformed and oversized requests deliberately cannot pass the typed client's request validator. Replay those
  // raw fixtures through the actual incoming codec; the typed backend/client path is exercised below as well.
  for (const platform of ["macos", "windows"] as const)
    for (const file of readdirSync(FIXTURES).filter((file) => file.endsWith(".jsonl")))
      test(`${platform}: ${file}`, async () => {
        const clock = manualClock(1000)
        const inbox: Received[] = []
        const errors: string[] = []
        const decoder = new FrameDecoder({
          onMessage: (message) => inbox.push({ kind: "frame", bytes: Buffer.from(JSON.stringify(message)) }),
          onImage: (header, bytes) => {
            inbox.push({ kind: "frame", bytes: Buffer.from(JSON.stringify(header)) }, { kind: "frame", bytes })
          },
          onError: (code, error) => errors.push(`${code}: ${error}`),
        })
        const helper = createFakeHelper(
          { platform },
          {
            clock,
            write: (bytes) => {
              // The native pipe can split anywhere, including within a length prefix or multibyte string.
              for (let offset = 0; offset < bytes.byteLength; offset += 31)
                decoder.push(bytes.subarray(offset, offset + 31))
            },
            exit: (code) => {
              decoder.end()
              inbox.push({ kind: "exit", code })
            },
          },
        )
        const channel: Channel = {
          write: (bytes) => helper.receive(bytes),
          end: () => helper.endOfInput(),
          next: async () => inbox.shift(),
        }
        try {
          await replay(channel, readTranscript(path.join(FIXTURES, file)), {
            name: `${platform}/${file}`,
            wait: async (ms) => clock.advance(ms),
          })
          expect(errors).toEqual([])
        } finally {
          helper.endOfInput()
        }
      })
})

function connect(options: FakeOptions = {}) {
  const clock = manualClock(1000)
  const data = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(event: { code?: number; signal?: string }) => void>()
  const helper = createFakeHelper(options, {
    clock,
    write: (bytes) => {
      for (const callback of data) callback(bytes)
    },
    exit: (code) => {
      for (const callback of exits) callback({ code })
    },
  })
  const channel: HelperChannel = {
    write: (bytes) => helper.receive(bytes),
    end: () => helper.endOfInput(),
    kill: () => helper.endOfInput(),
    onData: (callback) => {
      data.add(callback)
      return () => void data.delete(callback)
    },
    onExit: (callback) => {
      exits.add(callback)
      return () => void exits.delete(callback)
    },
  }
  const client = createHelperClient(channel, { clock })
  return { helper, clock, client, backend: new NativeHelperBackend(client, "fake") }
}

describe("NativeHelperBackend on the actual codec and client", () => {
  for (const platform of ["macos", "windows"] as const)
    test(`${platform}: maps session, observation, input and event operations against the fake`, async () => {
      const fake = connect({ platform, scenario: "notes" })
      const backend = fake.backend
      const events: Computer.HelperEvent[] = []
      const unlisten = backend.onEvent((event) => events.push(event))
      try {
        expect(backend.capabilities().actions).toEqual([])
        const hello = await backend.hello()
        expect(hello.helper.platform).toBe(platform)
        expect(backend.capabilities().actions).toContain("screenshot")
        expect(backend.capabilities().actions).toContain("read_ui")
        expect(backend.capabilities().actions).not.toContain("mouse_down")
        expect(backend.capabilities().features.locked).toBe(false)
        expect(await backend.permissions()).toMatchObject(
          platform === "macos"
            ? { screen: "granted", accessibility: "granted" }
            : { screen: "n/a", accessibility: "n/a", captureBlocked: false },
        )
        const notes = fake.helper.desktop.app("notes")!
        const phase = { sessionId: "backend-conformance", phaseRevision: 0 }
        const session: Computer.SessionBegin = {
          ...phase,
          paused: true,
          mode: "foreground",
          approved: [notes.identity],
          vectorPids: [fake.helper.desktop.app("vector")!.pid],
          vectorWindowIds: ["vector-1"],
          overlayWindowIds: [OVERLAY],
          escStops: false,
          stopChord: platform === "macos" ? "Command+Shift+Escape" : "Control+Alt+Shift+Escape",
          heartbeatMs: Computer.LIMITS.heartbeatMs,
        }
        await backend.beginSession(session)
        await backend.updateSession({ ...phase, paused: false, escStops: true, mode: "foreground" })
        await backend.heartbeat()
        expect((await backend.displays()).length).toBeGreaterThan(0)
        expect((await backend.apps({ installed: true })).some((app) => app.identity.name === notes.identity.name)).toBe(
          true,
        )
        await backend.activate(notes.identity, phase)
        await backend.launch(notes.identity, phase)
        const launchPath =
          notes.identity.platform === "macos"
            ? notes.identity.path
            : "exe" in notes.identity
              ? notes.identity.exe
              : undefined
        if (launchPath) await backend.launch({ path: launchPath }, phase)
        await backend.focusWindow("notes-1", phase)
        const tree = await backend.tree({ op: "ui.tree", pid: notes.pid, maxNodes: 100, maxDepth: 8 }, 15000)
        expect(tree.nodes.length).toBeGreaterThan(0)
        const frame = await backend.capture(
          {
            op: "capture",
            target: { windowId: "notes-1" },
            budget: { maxWidth: 800, maxHeight: 600, maxPixels: 480000 },
            format: "jpeg",
          },
          10000,
        )
        // The fake intentionally answers PNG even when asked for JPEG; no requested-format assumption is valid.
        expect(Array.from(frame.bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
        expect(decodePng(frame.bytes).width).toBe(frame.header.width)
        expect(frame.header.imageBytes).toBe(frame.bytes.byteLength)
        const title = tree.nodes.find((node) => node.name === "Title")!
        const x = Math.floor((title.bounds.x + title.bounds.w / 2 - frame.header.origin.x) * frame.header.imageScale)
        const y = Math.floor((title.bounds.y + title.bounds.h / 2 - frame.header.origin.y) * frame.header.imageScale)
        const hit = await backend.hitTest(frame.header.captureId, x, y)
        expect(hit.owner).toEqual(notes.identity)
        expect(hit.name).toBe("Title")
        expect((await backend.focused()).owner).toEqual(notes.identity)
        await backend.input(
          { op: "input.scroll", ...phase, captureId: frame.header.captureId, x, y, dx: 0, dy: 123, unit: "pixel" },
          10000,
        )
        expect(fake.helper.log.find((entry) => entry.kind === "input" && entry.op === "scroll")).toMatchObject({
          dy: 123,
          unit: "pixel",
        })
        await backend.input({ op: "input.key", ...phase, pid: notes.pid, combo: ["ArrowRight"], repeat: 1 }, 10000)
        await backend.input({ op: "input.type", ...phase, pid: notes.pid, text: "Hello, 世界" }, 10000)
        expect(await backend.releaseAll()).toBe(0)
        await backend.cancel()
        fake.helper.control({ type: "lock", locked: true })
        expect(events).toContainEqual({ event: "locked", locked: true })
        await backend.endSession()
      } finally {
        unlisten()
        await backend.close()
      }
    })

  test("missing features narrow capabilities and returned snapshots cannot enable an operation", async () => {
    const fake = connect({ disabled: ["ui.tree", "input.pointer", "input.unicode", "capture.zoom"] })
    try {
      const hello = await fake.backend.hello()
      hello.features["ui.tree"] = true
      const capabilities = fake.backend.capabilities()
      expect(capabilities.actions).not.toContain("read_ui")
      expect(capabilities.actions).not.toContain("click")
      expect(capabilities.actions).not.toContain("type")
      expect(capabilities.actions).not.toContain("zoom")
      expect(capabilities.actions).toContain("key")
      capabilities.features["ui.tree"] = true
      capabilities.actions.push("read_ui")
      expect(fake.backend.capabilities().actions).not.toContain("read_ui")
    } finally {
      await fake.backend.close()
    }
  })

  test("an exit clears negotiated capabilities and listeners may be unsubscribed", async () => {
    const fake = connect()
    await fake.backend.hello()
    const events: Computer.HelperEvent[] = []
    const unlisten = fake.backend.onEvent((event) => events.push(event))
    unlisten()
    fake.helper.endOfInput()
    expect(fake.backend.capabilities().actions).toEqual([])
    expect(events).toEqual([])
    await fake.backend.close()
  })

  test("a helper without capture exclusion receives no capture or coordinate input", async () => {
    const fake = connect({ disabled: ["capture.exclude"] })
    try {
      await fake.backend.hello()
      expect(fake.backend.capabilities().actions).not.toContain("screenshot")
      await expect(
        fake.backend.capture(
          {
            op: "capture",
            target: { display: "1" },
            budget: { maxWidth: 800, maxHeight: 600, maxPixels: 480000 },
            format: "png",
          },
          10000,
        ),
      ).rejects.toMatchObject({ code: "unsupported_action" })
      await expect(
        fake.backend.input(
          { op: "input.click", captureId: "untrusted", x: 1, y: 1, button: "left", count: 1, modifiers: [] },
          10000,
        ),
      ).rejects.toMatchObject({ code: "unsupported_action" })
      expect(fake.helper.log.some((entry) => entry.kind === "capture" || entry.kind === "input")).toBe(false)
    } finally {
      await fake.backend.close()
    }
  })

  test("missing secure-field detection refuses every text path before it reaches the helper", async () => {
    const fake = connect({ disabled: ["ui.secureFieldDetect"] })
    try {
      await fake.backend.hello()
      expect(fake.backend.capabilities().actions).not.toContain("type")
      expect(fake.backend.capabilities().actions).not.toContain("key")
      for (const input of [
        { op: "input.type", pid: 502, text: "private" },
        { op: "input.key", pid: 502, combo: ["x"], repeat: 1 },
        { op: "input.hold", pid: 502, combo: ["x"], ms: 1 },
      ] satisfies Computer.InputOp[])
        await expect(fake.backend.input(input, 10000)).rejects.toMatchObject({ code: "unsupported_action" })
      await expect(fake.backend.setValue("ui_1", "private")).rejects.toMatchObject({ code: "unsupported_action" })
      expect(fake.helper.log.some((entry) => entry.kind === "input" || entry.kind === "ui")).toBe(false)
    } finally {
      await fake.backend.close()
    }
  })

  test("session updates bind the expected holder phase and cannot replace Vector's process exclusions", async () => {
    const calls: { op: Computer.HelperOpName; args?: Record<string, unknown> }[] = []
    const backend = new NativeHelperBackend({
      request: async <T>(op: Computer.HelperOpName, args?: Record<string, unknown>) => {
        calls.push({ op, args })
        return {} as T
      },
      onEvent: () => () => {},
      close: async () => {},
    })
    await backend.updateSession({
      sessionId: "current",
      phaseRevision: 7,
      paused: true,
      vectorPids: [1234],
      vectorWindowIds: ["replacement"],
      heartbeatMs: 2000,
      stopChord: "Other",
      escStops: true,
      overlayWindowIds: ["overlay"],
      approved: [],
    })
    expect(calls).toEqual([
      {
        op: "session.update",
        args: {
          sessionId: "current",
          phaseRevision: 7,
          approved: [],
          escStops: true,
          paused: true,
          overlayWindowIds: ["overlay"],
        },
      },
    ])
    await backend.close()
  })

  test("helper failures retain their refusal code rather than becoming an empty result", async () => {
    const fake = connect()
    try {
      await fake.backend.hello()
      await expect(
        fake.backend.tree({ op: "ui.tree", pid: 99999, maxNodes: 10, maxDepth: 2 }, 15000),
      ).rejects.toMatchObject({
        code: "unavailable",
      })
      await expect(fake.backend.cancel("-1")).rejects.toMatchObject({ code: "failed" })
      await expect(fake.backend.cancel("9007199254740992")).rejects.toMatchObject({ code: "failed" })
    } finally {
      await fake.backend.close()
    }
  })
})
