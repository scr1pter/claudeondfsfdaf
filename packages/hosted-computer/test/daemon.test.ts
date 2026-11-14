import { describe, expect, test } from "bun:test"
import type { Hosted } from "@vectordevai/schema/hosted"
import { Daemon, type DaemonDeps, type Job } from "../src/daemon"
import type { Report } from "../src/run-api"

// WP A54 (with WP A53's heartbeat): hostd starts the job from the first answer and reports `booted`; pauses everything
// and stops recording during a take-over; asks the agent to finish when wrapping and ends it before `wrapBy`; closes
// the browser when the trust ramp says so; packs and uploads files when asked; and when the job ends for any reason
// stops the browser, wipes its profile and reports `done`.

const SESSION = `hs_${"e".repeat(26)}`
const KEY = "k".repeat(43)

function answer(patch: Partial<Hosted.HeartbeatAnswer> = {}): Hosted.HeartbeatAnswer {
  return { state: "running", control: "agent", deadline: 10_000_000, browser: true, viewerKey: KEY, ...patch }
}

function world(answers: (Hosted.HeartbeatAnswer | Error)[], options: { browserStart?: () => Promise<void> } = {}) {
  const log: string[] = []
  /** hostd's own log lines. */
  const lines: string[] = []
  const reports: Report[] = []
  const viewer: { control: string; key: string }[] = []
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = []
  let exit: (() => void) | undefined
  let agentRunning = false
  let browserRunning = false
  let recording = false
  const deps: DaemonDeps = {
    session: SESSION,
    generation: 4,
    api: {
      heartbeat: async (report) => {
        reports.push(report)
        const next = answers.length > 1 ? answers.shift()! : answers[0]!
        if (next instanceof Error) throw next
        return next
      },
    },
    upload: async (_link, file) => {
      log.push(`upload ${file}`)
    },
    agent: {
      start: async (job: Job) => {
        agentRunning = true
        log.push(`agent start ${job.prompt}`)
      },
      running: () => agentRunning,
      pause: async () => {
        log.push("agent pause")
      },
      resume: async () => {
        log.push("agent resume")
      },
      ask: () => {
        log.push("agent ask")
      },
      kill: async () => {
        agentRunning = false
        log.push("agent kill")
      },
      onExit: (listener) => {
        exit = listener
      },
    },
    browser: {
      start: async () => {
        browserRunning = true
        log.push("browser start")
        await options.browserStart?.()
      },
      stop: async () => {
        if (browserRunning) log.push("browser stop")
        browserRunning = false
      },
      running: () => browserRunning,
      pageLoads: () => 7,
    },
    recorder: {
      start: async () => {
        recording = true
        log.push("recorder start")
      },
      stop: () => {
        if (recording) log.push("recorder stop")
        recording = false
      },
      running: () => recording,
    },
    wipe: async () => {
      log.push("wipe")
    },
    viewer: async (state) => {
      viewer.push({ control: state.control, key: state.key })
    },
    pack: async () => {
      log.push("pack")
      return { file: "/var/lib/vector/pack/files.tar.gz", bytes: 2048 }
    },
    discard: async (file) => {
      log.push(`discard ${file}`)
    },
    metrics: { cpu: () => 12, egressBytes: async () => 5000 },
    clock: () => 1_000_000,
    log: (line) => lines.push(line),
    schedule: (ms, run) => {
      const timer = { ms, run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
  }
  const daemon = new Daemon(deps)
  return { daemon, log, lines, reports, viewer, timers, agentExit: () => exit?.(), browserGone: () => (browserRunning = false) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("the session loop", () => {
  test("the job starts the agent, the browser and the recorder, and the next report says booted", async () => {
    const w = world([answer({ job: { prompt: "fix the tests" } }), answer()])
    await w.daemon.tick()
    expect(w.log).toEqual(["agent start fix the tests", "browser start", "recorder start"])
    expect(w.reports[0]).toEqual({ cpu: 12, pageLoads: 7, egressBytes: 5000, generation: 4 })
    expect(w.reports[1]).toMatchObject({ booted: true, generation: 4 })
    expect(w.viewer.at(-1)).toEqual({ control: "agent", key: KEY })
    // A job never starts twice, even if an answer repeats it.
    await w.daemon.tick()
    expect(w.log.filter((line) => line.startsWith("agent start"))).toHaveLength(1)
  })

  test("without the trust ramp's go-ahead the browser stays closed, and closes when the ramp withdraws it", async () => {
    // Each tick that starts the job reports again at once (to say booted), so it reads two answers.
    const w = world([answer({ job: { prompt: "p" }, browser: false }), answer({ browser: false }), answer({ browser: true }), answer({ browser: false })])
    await w.daemon.tick()
    expect(w.log).not.toContain("browser start")
    await w.daemon.tick()
    expect(w.log).toContain("browser start")
    await w.daemon.tick()
    expect(w.log).toContain("browser stop")
  })

  test("a browser that went away is started again without holding up the heartbeat, and a failed start is logged", async () => {
    let starts = 0
    let fail: (() => void) | undefined
    const w = world([answer({ job: { prompt: "p" } }), answer()], {
      browserStart: () => {
        starts++
        if (starts === 1) return Promise.resolve()
        return new Promise((_resolve, reject) => (fail = () => reject(new Error("Target.setDiscoverTargets timed out"))))
      },
    })
    await w.daemon.tick()
    expect(starts).toBe(1)
    // Its guard went down and hostd ended it: the next heartbeat starts it again, and returns while it starts.
    w.browserGone()
    await w.daemon.tick()
    expect(starts).toBe(2)
    // It counts as running while it starts, so no second one is started.
    await w.daemon.tick()
    expect(starts).toBe(2)
    fail!()
    await settle()
    expect(w.lines).toContain("browser did not start")
  })

  test("a take-over pauses the agent and stops recording; handing back resumes both", async () => {
    const w = world([answer({ job: { prompt: "p" } }), answer(), answer({ state: "takeover", control: "person" }), answer()])
    await w.daemon.tick()
    w.log.length = 0
    await w.daemon.tick()
    expect(w.log).toEqual(["recorder stop", "agent pause"])
    expect(w.viewer.at(-1)?.control).toBe("person")
    expect(w.daemon.acting()).toBe(false)
    w.log.length = 0
    await w.daemon.tick()
    expect(w.log).toEqual(["agent resume", "recorder start"])
    expect(w.daemon.acting()).toBe(true)
  })

  test("a hand-over is reported until the person takes over", async () => {
    const w = world([answer({ job: { prompt: "p" } }), answer(), answer({ state: "takeover", control: "person" }), answer({ state: "takeover", control: "person" })])
    await w.daemon.tick()
    w.daemon.handOff("captcha")
    await settle()
    expect(w.reports.at(-1)).toMatchObject({ handoff: "captcha" })
    await w.daemon.tick()
    await w.daemon.tick()
    expect(w.reports.at(-1)?.handoff).toBeUndefined()
  })

  test("wrapping asks the agent to finish and ends it before wrapBy; the profile is wiped and done reported", async () => {
    const w = world([answer({ job: { prompt: "p" } }), answer({ state: "wrapping", wrapBy: 1_000_000 + 120_000 }), answer({ state: "wrapping" })])
    await w.daemon.tick()
    await w.daemon.tick()
    expect(w.log).toContain("agent ask")
    expect(w.timers[0]!.ms).toBe(100_000)
    w.timers[0]!.run()
    await settle()
    expect(w.log.slice(-4)).toEqual(["recorder stop", "agent kill", "browser stop", "wipe"])
    expect(w.reports.at(-1)).toMatchObject({ done: true, booted: true })
  })

  test("when the agent finishes on its own the job ends the same way, once", async () => {
    const w = world([answer({ job: { prompt: "p" } }), answer()])
    await w.daemon.tick()
    w.agentExit()
    w.agentExit()
    await settle()
    expect(w.log.filter((line) => line === "wipe")).toHaveLength(1)
    expect(w.reports.at(-1)).toMatchObject({ done: true })
  })

  test("a stopping or ended session, or a refusal meaning the session is over, ends everything", async () => {
    for (const final of [answer({ state: "stopping" }), Object.assign(new Error("refused"), { status: 401 })]) {
      const w = world([answer({ job: { prompt: "p" } }), final])
      await w.daemon.tick()
      await w.daemon.tick()
      await settle()
      expect(w.log).toContain("wipe")
      expect(w.log).toContain("agent kill")
    }
    // A passing network failure is not the end.
    const w = world([answer({ job: { prompt: "p" } }), new Error("network down"), answer()])
    await w.daemon.tick()
    await w.daemon.tick()
    expect(w.log).not.toContain("wipe")
  })

  test("asked for the files, hostd packs them, reports the size, uploads to the link, and drops its copy once accepted", async () => {
    const link = { url: "https://bucket.example.test/hosted/files.tar.gz?sig=1", headers: { "content-length": "2048" }, expiresAt: 2_000_000 }
    const w = world([answer({ job: { prompt: "p" } }), answer(), answer({ pack: true }), answer({ upload: link }), answer()])
    await w.daemon.tick()
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    expect(w.log).toContain("pack")
    expect(w.reports.some((report) => report.archiveBytes === 2048)).toBe(true)
    expect(w.log).toContain("upload /var/lib/vector/pack/files.tar.gz")
    expect(w.reports.some((report) => report.uploaded === true)).toBe(true)
    expect(w.log).toContain("discard /var/lib/vector/pack/files.tar.gz")
  })
})
