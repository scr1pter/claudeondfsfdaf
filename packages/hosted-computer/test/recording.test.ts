import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { Hosted } from "@vectordevai/schema/hosted"
import { Daemon, RECORDING_FLUSH_MS, type DaemonDeps } from "../src/daemon"
import { Recorder } from "../src/recorder"
import type { Report } from "../src/run-api"

// WP A55 (Done by Morning) on the computer: once an answer says the server keeps this session's recording, hostd
// reports its finished segments among the last ten, uploads each to the signed link the next answer carries, says
// which it uploaded, and at the end of the job flushes the last segments before it reports `done`. A session whose
// answers never mention a recording uploads nothing.

const SESSION = `hs_${"r".repeat(26)}`
const KEY = "k".repeat(43)

function answer(patch: Partial<Hosted.HeartbeatAnswer> = {}): Hosted.HeartbeatAnswer {
  return { state: "running", control: "agent", deadline: 10_000_000, browser: false, viewerKey: KEY, ...patch }
}

function link(n: number) {
  return { n, url: `https://media.example.invalid/slot-${n % 10}.ts`, headers: { "content-length": "100" }, expiresAt: 2_000_000 }
}

function world(respond: (report: Report, index: number) => Hosted.HeartbeatAnswer) {
  const reports: Report[] = []
  const uploads: string[] = []
  const log: string[] = []
  let recording = true
  let settled = 0
  let segments = [0, 1, 2, 3].map((number) => ({ number, bytes: 100, file: `/run/vector/rec/seg-${String(number).padStart(5, "0")}.ts` }))
  const deps: DaemonDeps = {
    session: SESSION,
    generation: 4,
    api: {
      heartbeat: async (report) => {
        reports.push(report)
        return respond(report, reports.length - 1)
      },
    },
    upload: async () => {},
    agent: {
      start: async () => {},
      running: () => true,
      pause: async () => {},
      resume: async () => {},
      ask: () => {},
      kill: async () => {
        log.push("agent kill")
      },
      onExit: () => {},
    },
    browser: { start: async () => {}, stop: async () => {}, running: () => false, pageLoads: () => 0 },
    recorder: {
      start: async () => {
        recording = true
      },
      stop: () => {
        recording = false
        log.push("recorder stop")
      },
      running: () => recording,
    },
    recording: {
      segments: async () => segments,
      settled: async () => {
        settled++
        log.push("settled")
      },
      upload: async (target, file) => {
        uploads.push(`${target.n} ${file}`)
      },
    },
    wipe: async () => {
      log.push("wipe")
    },
    viewer: async () => {},
    pack: async () => ({ file: "/tmp/files.tar.gz", bytes: 1 }),
    discard: async () => {},
    metrics: { cpu: () => 1, egressBytes: async () => 0 },
    clock: () => 1_000_000,
    schedule: () => ({ cancel: () => {} }),
  }
  return {
    daemon: new Daemon(deps),
    reports,
    uploads,
    log,
    settledCount: () => settled,
    setSegments(next: typeof segments) {
      segments = next
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("a job's recording", () => {
  test("a session whose answers never mention a recording reports and uploads nothing", async () => {
    const w = world(() => answer({ job: { prompt: "tidy" } }))
    await w.daemon.tick()
    await w.daemon.tick()
    for (const report of w.reports) {
      expect(report.segments).toBeUndefined()
      expect(report.uploadedSegments).toBeUndefined()
    }
    expect(w.uploads).toEqual([])
  })

  test("finished segments are reported (not the one being written), uploaded to the signed links, then reported as uploaded", async () => {
    const w = world((report) =>
      answer({ recording: { uploads: (report.segments ?? []).map((segment) => link(segment.n)) } }),
    )
    await w.daemon.tick()
    await settle()
    // The first answer asked for the recording; the next report lists finished segments: 0, 1, 2 (3 is being written),
    // at most RECORDING_REPORT_MAX at a time.
    expect(w.reports[1]!.segments).toEqual([
      { n: 0, bytes: 100 },
      { n: 1, bytes: 100 },
      { n: 2, bytes: 100 },
    ])
    expect(w.uploads).toEqual([
      "0 /run/vector/rec/seg-00000.ts",
      "1 /run/vector/rec/seg-00001.ts",
      "2 /run/vector/rec/seg-00002.ts",
    ])
    const last = w.reports.at(-1)!
    expect(last.uploadedSegments).toEqual([0, 1, 2])
    expect(last.segments).toBeUndefined()
    expect(Hosted.RECORDING_REPORT_MAX).toBe(3)
  })

  test("only the last ten finished segments are offered, and an oversized one never is", async () => {
    const w = world((report, index) =>
      index === 0 ? answer({ recording: { uploads: [] } }) : answer({ recording: { uploads: [] } }),
    )
    w.setSegments(
      Array.from({ length: 15 }, (_, number) => ({
        number,
        bytes: number === 6 ? Hosted.RECORDING_SEGMENT_MAX_BYTES + 1 : 100,
        file: `/rec/${number}`,
      })),
    )
    await w.daemon.tick()
    // 14 is being written; the window is 4..13; 6 is too large.
    expect(w.reports[1]!.segments!.map((segment) => segment.n)).toEqual([4, 5, 7])
  })

  test("a failed upload is offered again", async () => {
    let fail = true
    const w = world((report) => answer({ recording: { uploads: (report.segments ?? []).map((segment) => link(segment.n)) } }))
    const deps = (w.daemon as unknown as { deps: DaemonDeps }).deps
    const upload = deps.recording!.upload
    deps.recording!.upload = async (target, file) => {
      if (fail && target.n === 1) throw new Error("refused")
      return upload(target, file)
    }
    await w.daemon.tick()
    await settle()
    expect(w.reports.at(-1)!.uploadedSegments).toEqual([0, 2])
    fail = false
    await w.daemon.tick()
    await settle()
    expect(w.reports.at(-1)!.uploadedSegments).toEqual([0, 1, 2])
  })

  test("the end of a job flushes the last segments (the recorder closed) before it reports done", async () => {
    const w = world((report) => answer({ recording: { uploads: (report.segments ?? []).map((segment) => link(segment.n)) } }))
    await w.daemon.tick()
    await settle()
    expect(w.uploads.map((line) => Number(line.split(" ")[0]))).toEqual([0, 1, 2])
    await w.daemon.finish("agent finished")
    await settle()
    expect(w.settledCount()).toBe(1)
    expect(w.log.indexOf("recorder stop")).toBeLessThan(w.log.indexOf("settled"))
    // Segment 3 was being written; once the recorder stopped it is finished and uploaded before `done`.
    expect(w.uploads.map((line) => Number(line.split(" ")[0]))).toEqual([0, 1, 2, 3])
    const firstDone = w.reports.findIndex((report) => report.done)
    const lastSegments = w.reports.findLastIndex((report) => report.segments?.length)
    expect(firstDone).toBeGreaterThan(lastSegments)
    expect(w.reports[firstDone]!.uploadedSegments).toEqual([0, 1, 2, 3])
    expect(RECORDING_FLUSH_MS).toBe(60_000)
  })

  test("a session that is already over is not flushed", async () => {
    let over = false
    const w = world((report) =>
      over ? answer({ state: "ended" }) : answer({ recording: { uploads: [] } }),
    )
    await w.daemon.tick()
    over = true
    await w.daemon.tick()
    await settle()
    expect(w.settledCount()).toBe(0)
    expect(w.uploads).toEqual([])
    expect(w.reports.at(-1)!.done).toBe(true)
  })
})

describe("the recorder's settled()", () => {
  test("resolves once a stopped ffmpeg exited, and at once when none ran", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vector-rec-"))
    try {
      await writeFile(path.join(dir, "seg-00000.ts"), "x")
      let child: (ChildProcess & EventEmitter) | undefined
      const recorder = new Recorder(dir, {
        uid: undefined,
        spawn: (() => {
          child = new EventEmitter() as ChildProcess & EventEmitter
          ;(child as { kill: (signal: string) => boolean }).kill = () => true
          return child
        }) as never,
      })
      await recorder.settled()
      await recorder.start()
      recorder.stop()
      let done = false
      void recorder.settled().then(() => (done = true))
      await settle()
      expect(done).toBe(false)
      child!.emit("exit", 0)
      await settle()
      expect(done).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
