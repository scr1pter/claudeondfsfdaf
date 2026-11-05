import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Computer } from "@vectordevai/schema/computer"
import { createFakeHelper, manualClock, type FakeOptions } from "../../test/computer/fake-helper"
import { NativeHelperBackend } from "./computer-backend"
import { createHelperClient, type HelperChannel } from "./computer-helper"
import { encodeFrame, FrameDecoder } from "./computer-protocol"

// The actual client codecs drive a virtual clipboard; these checks start no process and read no OS clipboard.
function connect(options: FakeOptions = {}, advertiseClipboard?: boolean) {
  const clock = manualClock(1000)
  const data = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(value: { code?: number }) => void>()
  const operations: string[] = []
  const decoder = new FrameDecoder({
    onMessage: (message) => operations.push((message as { op: string }).op),
    onImage: () => {},
    onError: () => {},
  })
  const helper = createFakeHelper(options, {
    clock,
    write: (bytes) => {
      const value = JSON.parse(Buffer.from(bytes).subarray(4).toString("utf8")) as Record<string, unknown>
      const frame =
        advertiseClipboard !== undefined && value.ok === true && "helper" in value
          ? encodeFrame({
              ...value,
              features: { ...(value.features as Record<string, boolean>), clipboard: advertiseClipboard },
            })
          : bytes
      for (const callback of data) callback(frame)
    },
    exit: (code) => {
      for (const callback of exits) callback({ code })
    },
  })
  const channel: HelperChannel = {
    write: (bytes) => {
      decoder.push(bytes)
      helper.receive(bytes)
    },
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
  return { helper, operations, backend: new NativeHelperBackend(createHelperClient(channel, { clock }), "fake") }
}

const PHASE = { sessionId: "clipboard-backend", phaseRevision: 1 }
const SESSION: Computer.SessionBegin = {
  ...PHASE,
  mode: "foreground",
  paused: false,
  approved: [],
  vectorPids: [],
  vectorWindowIds: [],
  overlayWindowIds: [],
  escStops: false,
  stopChord: "Command+Shift+Escape",
  heartbeatMs: Computer.LIMITS.heartbeatMs,
}

test("native clipboard uses the existing validated wire shapes and phase fence", async () => {
  const fake = connect({ platform: "macos" })
  try {
    await fake.backend.beginSession(SESSION)
    const original = fake.helper.desktop.clipboard
    expect(await fake.backend.readClipboard()).toBe(original)
    await fake.backend.writeClipboard("Synthetic e\u0301 猫🙂", PHASE)
    expect(await fake.backend.readClipboard()).toBe("Synthetic e\u0301 猫🙂")
    expect(fake.helper.log.filter((entry) => entry.kind === "clipboard")).toEqual([
      { kind: "clipboard", action: "write", length: "Synthetic e\u0301 猫🙂".length, at: 1000 },
    ])
    await fake.backend.writeClipboard(original, PHASE)
    expect(await fake.backend.readClipboard()).toBe(original)
    await expect(fake.backend.writeClipboard("Stale", { ...PHASE, phaseRevision: 0 })).rejects.toMatchObject({
      code: "changed",
    })
    expect(fake.helper.desktop.clipboard).toBe(original)
  } finally {
    await fake.backend.close()
  }
})

test("disabled native clipboard is refused before any clipboard request", async () => {
  for (const options of [{ platform: "windows" }, { platform: "macos", disabled: ["clipboard"] }] as const) {
    const fake = connect(options)
    try {
      await expect(fake.backend.readClipboard()).rejects.toMatchObject({ code: "unsupported_action" })
      await expect(fake.backend.writeClipboard("Synthetic", PHASE)).rejects.toMatchObject({
        code: "unsupported_action",
      })
      expect(fake.operations.filter((op) => op.startsWith("clipboard."))).toEqual([])
      expect(fake.backend.capabilities().features.clipboard).toBe(false)
    } finally {
      await fake.backend.close()
    }
  }
})

test("native clipboard wire validation refuses an oversized UTF16 payload before mutation", async () => {
  const fake = connect({ platform: "macos" })
  try {
    await fake.backend.beginSession(SESSION)
    const original = fake.helper.desktop.clipboard
    await expect(fake.backend.writeClipboard("🙂".repeat(500001), PHASE)).rejects.toMatchObject({ code: "failed" })
    expect(fake.operations).not.toContain("clipboard.write")
    expect(fake.helper.desktop.clipboard).toBe(original)
  } finally {
    await fake.backend.close()
  }
})

test("a Windows helper cannot advertise the macOS-only clipboard operations into use", async () => {
  const fake = connect({ platform: "windows" }, true)
  try {
    expect((await fake.backend.hello()).features.clipboard).toBe(true)
    expect(fake.backend.capabilities().features.clipboard).toBe(false)
    await expect(fake.backend.readClipboard()).rejects.toMatchObject({ code: "unsupported_action" })
    await expect(fake.backend.writeClipboard("Synthetic", PHASE)).rejects.toMatchObject({ code: "unsupported_action" })
    expect(fake.operations.filter((op) => op.startsWith("clipboard."))).toEqual([])
  } finally {
    await fake.backend.close()
  }
})

test("native clipboard methods cannot start a new helper after the backend closes", async () => {
  const fake = connect({ platform: "macos" })
  await fake.backend.hello()
  await fake.backend.close()
  const count = fake.operations.length
  await expect(fake.backend.readClipboard()).rejects.toMatchObject({ code: "unavailable" })
  await expect(fake.backend.writeClipboard("Synthetic", PHASE)).rejects.toMatchObject({ code: "unavailable" })
  expect(fake.operations.length).toBe(count)
})
