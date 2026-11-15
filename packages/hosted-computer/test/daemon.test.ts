import { describe, expect, test } from "bun:test"
import type { Hosted } from "@vectordevai/schema/hosted"
import { Daemon, type DaemonDeps, type Job } from "../src/daemon"
import type { Report } from "../src/run-api"

// WP A54 (with WP A53's heartbeat): hostd starts the job from the first answer and reports `booted`; pauses everything
// and stops recording during a take-over; asks the agent to finish when wrapping and ends it before `wrapBy`; closes
// the browser when the trust ramp says so; packs and uploads files when asked; and when the job ends for any reason
// stops the browser, wipes its profile and reports `done`. H1b: a download-only session starts nothing of a job and
// only packs and uploads the disk.

const SESSION = `hs_${"e".repeat(26)}`
const KEY = "k".repeat(43)

function answer(patch: Partial<Hosted.HeartbeatAnswer> = {}): Hosted.HeartbeatAnswer {
  return { state: "running", control: "agent", deadline: 10_000_000, browser: true, viewerKey: KEY, ...patch }
}

function world(
  answers: (Hosted.HeartbeatAnswer | Error | Promise<Hosted.HeartbeatAnswer>)[],
  options: {
    browserStart?: () => Promise<void>
    beforePack?: () => void
    beforeUpload?: () => void | Promise<void>
  } = {},
) {
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
      // Awaited only when it returns a promise, so the other cases keep their timing.
      const gate = options.beforeUpload?.()
      if (gate) await gate
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
      options.beforePack?.()
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
    // A job session is unchanged by H1b: the job still runs, nothing reports done, and once the copy is dropped the
    // upload is no longer reported.
    expect(w.reports.some((report) => report.done)).toBe(false)
    expect(w.daemon.acting()).toBe(true)
    await w.daemon.tick()
    expect(w.reports.at(-1)).not.toHaveProperty("uploaded")
    expect(w.reports.at(-1)).not.toHaveProperty("archiveBytes")
  })
})

describe("download-only sessions (H1b)", () => {
  const link = {
    url: "https://bucket.example.test/hosted/files.tar.gz?sig=1",
    headers: { "content-length": "2048" },
    expiresAt: 2_000_000,
  }
  const files = "/var/lib/vector/pack/files.tar.gz"
  const download = (patch: Partial<Hosted.HeartbeatAnswer> = {}) =>
    answer({ mode: "download", browser: false, ...patch })
  const idle = { booted: false, done: false, control: "agent" as const, wrapping: false, browser: false }

  test("start no agent, browser, recorder or viewer state; pack and upload once, then keep reporting it", async () => {
    // The last answer (no pack, no link: what today's server answers while a beat says `uploaded`, until its check
    // confirms the upload) repeats.
    const w = world([download({ pack: true }), download({ upload: link }), download()])
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    await w.daemon.tick()
    await w.daemon.tick()
    expect(w.log).toEqual(["pack", `upload ${files}`, `discard ${files}`])
    expect(w.viewer).toEqual([])
    expect(w.reports[0]).toEqual({ cpu: 12, pageLoads: 7, egressBytes: 5000, generation: 4 })
    expect(w.reports.some((report) => report.archiveBytes === 2048 && !report.uploaded)).toBe(true)
    // The copy is gone, but the size and the upload stay reported, so the server checks it again on every beat.
    const first = w.reports.findIndex((report) => report.uploaded)
    expect(first).toBeGreaterThan(0)
    expect(w.reports.length - first).toBeGreaterThanOrEqual(3)
    for (const report of w.reports.slice(first)) expect(report).toMatchObject({ uploaded: true, archiveBytes: 2048 })
    // The server ends the session once it confirmed the upload; hostd never says booted or done on its own.
    expect(w.reports.some((report) => report.booted || report.done)).toBe(false)
    expect(w.daemon.status()).toEqual(idle)
    expect(w.daemon.acting()).toBe(false)
  })

  test("the download mode wins over a job, the browser and a take-over, and later answers cannot undo it", async () => {
    const w = world([
      download({ job: { prompt: "fix the tests" }, browser: true }),
      answer({ job: { prompt: "fix the tests" } }),
      answer({ state: "takeover", control: "person" }),
    ])
    for (let i = 0; i < 3; i++) await w.daemon.tick()
    await settle()
    expect(w.log).toEqual([])
    expect(w.viewer).toEqual([])
    expect(w.daemon.acting()).toBe(false)
    expect(w.daemon.status()).toEqual(idle)
  })

  test("asked for the files again after a beat that said uploaded, it packs again and uploads anew", async () => {
    // Today's server never asks: while a beat says `uploaded` it only checks the upload. A later server may, when its
    // check finds the object missing or of another size (H1 computer deviations, O4).
    const w = world([
      download({ pack: true }),
      download({ upload: link }),
      download({ upload: link }),
      download({ upload: link }),
      download(),
    ])
    await w.daemon.tick()
    for (let i = 0; i < 10; i++) await settle()
    const once = ["pack", `upload ${files}`, `discard ${files}`]
    expect(w.log).toEqual([...once, ...once])
    // The new pack's size goes out without `uploaded`, so the next link is signed for it.
    const again = w.reports.findIndex((report, i) => !report.uploaded && w.reports[i - 1]?.uploaded === true)
    expect(again).toBeGreaterThan(0)
    expect(w.reports[again]).toMatchObject({ archiveBytes: 2048 })
    expect(w.reports.at(-1)).toMatchObject({ uploaded: true, archiveBytes: 2048 })
  })

  test("a request for the files answered to a beat from before the upload went through changes nothing", async () => {
    let uploadDone = () => {}
    let answerLate = (_: Hosted.HeartbeatAnswer) => {}
    const late = new Promise<Hosted.HeartbeatAnswer>((resolve) => (answerLate = resolve))
    const w = world([download({ pack: true }), download({ upload: link }), late, download()], {
      beforeUpload: () => new Promise<void>((resolve) => (uploadDone = resolve)),
    })
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    // A beat goes out while the upload is under way, and its answer comes back after the upload went through.
    const beat = w.daemon.tick()
    await settle()
    expect(w.reports.at(-1)).toMatchObject({ archiveBytes: 2048 })
    expect(w.reports.at(-1)).not.toHaveProperty("uploaded")
    uploadDone()
    await settle()
    answerLate(download({ pack: true, upload: link }))
    await beat
    for (let i = 0; i < 5; i++) await settle()
    expect(w.log).toEqual(["pack", `upload ${files}`, `discard ${files}`])
    expect(w.reports.at(-1)).toMatchObject({ uploaded: true, archiveBytes: 2048 })
  })

  test("a failed pack is tried again when asked again, and a failed upload with the next link", async () => {
    let packs = 0
    let uploads = 0
    const pack = download({ pack: true })
    const upload = download({ upload: link })
    const w = world([pack, pack, upload, upload, download()], {
      beforePack: () => {
        if (++packs === 1) throw new Error("tar failed")
      },
      beforeUpload: () => {
        if (++uploads === 1) throw new Error("network down")
      },
    })
    // The first pack fails; asked again, it packs, and the upload to the link that follows fails.
    await w.daemon.tick()
    await settle()
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    expect(uploads).toBe(1)
    // The next beat reports the size without `uploaded`, and the next link takes it.
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    expect(packs).toBe(2)
    expect(uploads).toBe(2)
    expect(w.lines).toEqual(expect.arrayContaining(["packing the files failed", "uploading the files failed"]))
    expect(w.log).toEqual(["pack", `upload ${files}`, `discard ${files}`])
    expect(w.reports.at(-1)).toMatchObject({ archiveBytes: 2048, uploaded: true })
  })

  test("it ends only when the session is over, then reports done; nothing is packed after that", async () => {
    const stopped = world([download({ state: "stopping", pack: true }), download({ state: "ended" })])
    await stopped.daemon.tick()
    await settle()
    expect(stopped.log).toEqual(["agent kill", "wipe"])
    expect(stopped.lines).toContain("finishing: session over")
    expect(stopped.reports.at(-1)).toMatchObject({ done: true })
    // A refusal that means the session is over ends it too, and a later answer asking for the files packs nothing.
    const refused = world([Object.assign(new Error("refused"), { status: 403 }), download({ pack: true })])
    await refused.daemon.tick()
    await settle()
    expect(refused.log).toEqual(["agent kill", "wipe"])
    expect(refused.viewer).toEqual([])
  })

  test("answers without a mode or a job start nothing of the agent, even when they ask for the files", async () => {
    // This runs H1b's own daemon, so it pins the path shared with older builds, not an older build. That a hostd from
    // before H1b starts no agent for a download session rests on the server never sending one a job:
    // test/hosted-sessions-api.test.ts:691 (the root API tests) pins that.
    const w = world([
      answer({ browser: false, pack: true }),
      answer({ browser: false, upload: link }),
      answer({ browser: false }),
    ])
    await w.daemon.tick()
    for (let i = 0; i < 5; i++) await settle()
    expect(w.log).toEqual(["pack", `upload ${files}`, `discard ${files}`])
    // That is the job path: it writes the viewer state and drops the copy once the server stopped asking.
    expect(w.viewer.length).toBeGreaterThan(0)
    expect(w.reports.some((report) => report.booted || report.done)).toBe(false)
  })

  test("a job session stays one: a download answer after its job started changes nothing", async () => {
    const w = world([
      answer({ job: { prompt: "p" } }),
      answer(),
      answer({ mode: "download", state: "takeover", control: "person" }),
    ])
    await w.daemon.tick()
    w.log.length = 0
    await w.daemon.tick()
    expect(w.log).toEqual(["recorder stop", "agent pause"])
    expect(w.viewer.at(-1)?.control).toBe("person")
    expect(w.daemon.status()).toMatchObject({ booted: true, control: "person", browser: true })
  })
})
