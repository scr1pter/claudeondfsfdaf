import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { Recorder, recorderArgs } from "../src/recorder"
import { RECORDER_SEGMENTS_MAX } from "../src/limits"

// WP A54: the recorder takes the screen at 2 frames a second in 1-minute segments, is off during a take-over (a stop
// and a later start leave a gap, never an overwrite), and keeps its memory disk under a cap.

function fakeSpawn() {
  const started: { args: string[]; uid?: number; signals: string[] }[] = []
  const spawn = (_file: string, args: string[], options: { uid?: number }) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const record = { args, ...(options.uid !== undefined ? { uid: options.uid } : {}), signals: [] as string[] }
    started.push(record)
    ;(child as { kill: (signal: string) => boolean }).kill = (signal: string) => {
      record.signals.push(signal)
      queueMicrotask(() => child.emit("exit", 0))
      return true
    }
    return child
  }
  return { spawn, started }
}

describe("the recorder", () => {
  test("2 frames a second from the display, 1-minute MPEG-TS segments, no sound", () => {
    const args = recorderArgs("/run/vector/rec/s", 7).join(" ")
    expect(args).toContain("-f x11grab -framerate 2")
    expect(args).toContain("-segment_time 60")
    expect(args).toContain("-segment_start_number 7")
    expect(args).toContain("/run/vector/rec/s/seg-%05d.ts")
    expect(args).not.toMatch(/pulse|alsa|-f audio/)
  })

  test("stopping for a take-over and starting again continues the numbering", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-rec-"))
    try {
      const fake = fakeSpawn()
      const recorder = new Recorder(dir, { spawn: fake.spawn as never, uid: undefined })
      await recorder.start()
      writeFileSync(path.join(dir, "seg-00000.ts"), "x")
      writeFileSync(path.join(dir, "seg-00001.ts"), "x")
      recorder.stop()
      expect(fake.started[0]!.signals).toEqual(["SIGINT"])
      expect(recorder.running()).toBe(false)
      await recorder.start()
      expect(fake.started[1]!.args).toContain("2")
      expect(fake.started[1]!.args[fake.started[1]!.args.indexOf("-segment_start_number") + 1]).toBe("2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the oldest finished segments are dropped beyond the cap; the one being written is kept", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-rec-"))
    try {
      const recorder = new Recorder(dir, { spawn: fakeSpawn().spawn as never, uid: undefined })
      for (let i = 0; i < RECORDER_SEGMENTS_MAX + 3; i++) writeFileSync(path.join(dir, `seg-${String(i).padStart(5, "0")}.ts`), "x")
      writeFileSync(path.join(dir, "notes.txt"), "not a segment")
      expect(await recorder.prune()).toBe(3)
      const segments = await recorder.segments()
      expect(segments).toHaveLength(RECORDER_SEGMENTS_MAX)
      expect(segments[0]!.number).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
