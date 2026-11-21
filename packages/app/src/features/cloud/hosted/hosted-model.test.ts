import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  accessLine,
  canStart,
  ceilingLine,
  computerShown,
  CONTROL_LINE,
  decodeApprove,
  decodeDownload,
  decodeEstimate,
  decodeHostedStatus,
  decodeJob,
  decodeJobAnswer,
  decodeJobs,
  decodeSession,
  decodeSessions,
  decodeViewer,
  defaultDeliverBy,
  deliverByFromTime,
  DOWNLOAD_ACTION,
  DOWNLOAD_LINE,
  handoffLine,
  hostedErrorText,
  hoursLine,
  jobReasonLine,
  keptCandidate,
  keptLabels,
  keptLine,
  keptNote,
  keptView,
  linkLine,
  minuteChoices,
  minutesLabel,
  overnightShown,
  queueLine,
  rampLine,
  reasonLine,
  sessionControls,
  sessionLine,
  stateLabel,
  takeoverLine,
  USING_LINE,
  verdictLine,
} from "./hosted-model"

// WP A56: what the cloud computer's screens show. Answers are read field by field (a newer server never breaks a
// screen), nothing shows an amount (P1), the cloud computer's copy never mentions GitHub or Actions and promises
// nothing (H3, H4), and a perk shows only when listed and in the plan (H1). The server decides everything (S1).

const NOW = Date.UTC(2026, 10, 10, 21, 0)
const SESSION = `hs_${"a".repeat(26)}`
const JOB = `jb_${"b".repeat(26)}`
const TOKEN = "vvt1.eyJhdWQiOiJ2ZWN0b3Itdmlld2VyIn0.c2lnbmF0dXJl"

const session = (patch: Record<string, unknown> = {}) => ({
  id: SESSION,
  state: "running",
  computer: 1,
  size: "standard",
  source: "desktop",
  title: "Docs",
  createdAt: NOW - 600_000,
  deadline: NOW + 3_000_000,
  runningAt: NOW - 500_000,
  ...patch,
})

describe("what shows (H1)", () => {
  const status = (listed: string[], entitlements: Record<string, unknown>) => ({
    signedIn: true,
    listed,
    entitlements,
  })
  test("the cloud computer shows only when listed and in the plan; Done by Morning only with it", () => {
    const hosted = { computers: 1, hours: 20, jobMin: 240, diskDays: 7, sizes: ["standard"] }
    const overnight = { perNight: 3, atOnce: 1, recurringPerDay: 5 }
    expect(computerShown(status(["computer"], { hosted }))).toBe(true)
    expect(computerShown(status([], { hosted }))).toBe(false)
    expect(computerShown(status(["computer"], { hosted: null }))).toBe(false)
    expect(computerShown({ ...status(["computer"], { hosted }), signedIn: false })).toBe(false)
    expect(computerShown({ ...status(["computer"], { hosted }), error: "x" })).toBe(false)
    expect(computerShown(undefined)).toBe(false)
    expect(overnightShown(status(["computer", "overnight"], { hosted, overnight }))).toBe(true)
    expect(overnightShown(status(["overnight"], { hosted, overnight }))).toBe(false)
    expect(overnightShown(status(["computer", "overnight"], { hosted }))).toBe(false)
  })
})

describe("sessions", () => {
  test("decodes the server's session view; drops malformed ones; keeps a hand-over only while running", () => {
    expect(decodeSession(session())).toMatchObject({ id: SESSION, state: "running", computer: 1, size: "standard" })
    expect(decodeSession(session({ handoff: { reason: "captcha", since: NOW } }))?.handoff).toEqual({
      reason: "captcha",
      since: NOW,
    })
    expect(decodeSession(session({ state: "takeover", handoff: { reason: "captcha", since: NOW } }))?.handoff).toBeUndefined()
    expect(decodeSession(session({ handoff: { reason: "anything", since: NOW } }))?.handoff).toBeUndefined()
    expect(
      decodeSession(session({ state: "takeover", takeover: { since: NOW, until: NOW + 1_800_000 } }))?.takeover,
    ).toEqual({ since: NOW, until: NOW + 1_800_000 })
    for (const bad of [
      session({ id: "hs_short" }),
      session({ state: "flying" }),
      session({ size: "huge" }),
      session({ computer: -1 }),
      session({ deadline: "soon" }),
      null,
      [],
    ])
      expect(decodeSession(bad)).toBeUndefined()
    expect(decodeSessions({ sessions: [session(), { id: 1 }, session({ id: `hs_${"c".repeat(26)}` })] })).toHaveLength(2)
  })

  test("the purple bar's line, actions and take-over time", () => {
    const running = decodeSession(session())!
    const takeover = decodeSession(session({ state: "takeover", takeover: { since: NOW, until: NOW + 12 * 60_000 } }))!
    expect(sessionLine(running)).toBe(USING_LINE)
    expect(USING_LINE).toBe("Vector is using its cloud computer")
    expect(sessionLine(takeover)).toBe(CONTROL_LINE)
    expect(sessionControls(running)).toEqual({
      watch: true,
      takeover: true,
      control: false,
      release: false,
      stop: true,
      files: true,
    })
    expect(sessionControls(takeover)).toMatchObject({ watch: false, takeover: false, control: true, release: true })
    expect(sessionControls({ state: "starting" })).toMatchObject({ watch: false, takeover: false, stop: true, files: false })
    expect(sessionControls({ state: "stopping" }).stop).toBe(false)
    expect(sessionControls({ state: "wrapping" })).toMatchObject({ watch: true, takeover: false })
    expect(takeoverLine(takeover, NOW)).toBe("Control goes back to Vector in 12 minutes, or when you give it back.")
    expect(takeoverLine(running, NOW)).toBeUndefined()
  })

  test("a hand-over asks the person to take over, and names only the kind of step", () => {
    expect(handoffLine({ reason: "credential" })).toContain("Take over")
    expect(handoffLine({ reason: "payment_details" })).toContain("card field")
    expect(handoffLine({ reason: "captcha" })).toContain("CAPTCHA")
    expect(handoffLine(undefined)).toBeUndefined()
  })

  test("status: plan caps, the share of hours used as a whole percent, and what the plan's state allows", () => {
    const decoded = decodeHostedStatus({
      available: true,
      access: "start",
      plan: { computers: 1, hours: 20, jobMinutes: 240, diskDays: 7, sizes: ["standard"], browser: true, rampUntil: NOW + 1 },
      hours: { used: 0.256 },
      sessions: [session()],
    })!
    expect(decoded.plan).toMatchObject({ computers: 1, jobMinutes: 240, sizes: ["standard"], browser: true })
    expect(canStart(decoded)).toBe(true)
    expect(hoursLine(decoded)).toBe("74% of this month's cloud computer hours left")
    expect(rampLine(decoded.plan, NOW)).toContain("first days")
    expect(rampLine(decoded.plan, NOW + 2)).toBeUndefined()
    expect(decoded.sessions).toHaveLength(1)
    expect(decodeHostedStatus({ access: "nope" })).toBeUndefined()
    const held = decodeHostedStatus({ available: true, access: "stop", onHold: true, sessions: [] })!
    expect(canStart(held)).toBe(false)
    expect(accessLine(held)).toContain("on hold")
    expect(accessLine(decodeHostedStatus({ available: true, access: "wrap", sessions: [] }))).toContain("payment")
    expect(accessLine(decodeHostedStatus({ available: false, access: "start", sessions: [] }))).toContain("not taking")
    expect(canStart(decodeHostedStatus({ available: true, access: "start", sessions: [] }))).toBe(false)
  })

  test("job lengths run from 15 minutes to the plan's longest job", () => {
    expect(minuteChoices(240)).toEqual([15, 30, 60, 120, 240])
    expect(minuteChoices(720)).toEqual([15, 30, 60, 120, 240, 480, 720])
    expect(minuteChoices(100)).toEqual([15, 30, 60, 100])
    expect(minuteChoices(0)).toEqual([])
    expect(minutesLabel(30)).toBe("30 minutes")
    expect(minutesLabel(60)).toBe("1 hour")
    expect(minutesLabel(240)).toBe("4 hours")
  })

  test("viewer and files answers are taken only with links the client may open", () => {
    expect(decodeViewer({ url: `https://vh.sandbox.example#vt=${TOKEN}`, mode: "view", expiresAt: NOW })).toEqual({
      url: `https://vh.sandbox.example#vt=${TOKEN}`,
      mode: "view",
      expiresAt: NOW,
    })
    expect(decodeViewer({ url: "https://elsewhere.example/", mode: "view", expiresAt: NOW })).toBeUndefined()
    expect(decodeDownload({ ready: false })).toEqual({ ready: false })
    const url = `https://vectordev.ai/api/hosted/sessions/${SESSION}/download?t=x`
    expect(decodeDownload({ ready: true, url, expiresAt: NOW })).toEqual({ ready: true, url, expiresAt: NOW })
    expect(decodeDownload({ ready: true, url: "https://elsewhere.example/x", expiresAt: NOW })).toBeUndefined()
  })

  test("end reasons read as sentences", () => {
    expect(reasonLine({ state: "ended", reason: "idle" })).toBe("Nothing happened for 10 minutes.")
    // A computer that started but did not boot ran and was charged (M8): the line never says nothing was used.
    expect(reasonLine({ state: "ended", reason: "failed" })).toBe("The computer could not start. Only the time it ran counts.")
    expect(jobReasonLine({ reason: "failed" })).toBe("The cloud computer could not start, so Vector stopped trying.")
    expect(reasonLine({ state: "ended" })).toBeUndefined()
  })
})

describe("the pre-start ceiling (P2)", () => {
  test("is a band from the estimate, never an amount", () => {
    expect(decodeEstimate({ share: "2–5%" })).toEqual({ share: "2–5%" })
    expect(decodeEstimate({ share: "2–5%", todayShare: "10–20%" })).toEqual({ share: "2–5%", todayShare: "10–20%" })
    expect(decodeEstimate({ share: "3.2%" })).toBeUndefined()
    expect(decodeEstimate({ share: 0.03 })).toBeUndefined()
    expect(ceilingLine({ share: "2–5%" })).toBe(
      "The computer's time for this job uses at most 2–5% of your month. Its Codium requests count too.",
    )
    expect(ceilingLine({ share: "2–5%", todayShare: "10–20%" })).toContain("up to 10–20% of today's limit")
    expect(ceilingLine({ share: "more than your month" })).toContain("more than what is left")
    expect(ceilingLine(undefined)).toBeUndefined()
  })

  test("refusals use vectordev.ai's own words, trimmed", () => {
    expect(hostedErrorText({ status: 403, code: "HOSTED_NOT_INCLUDED", message: "Not in your plan." })).toBe(
      "Not in your plan.",
    )
    expect(hostedErrorText({ status: 0 })).toContain("could not be reached")
    expect(hostedErrorText(undefined)).toContain("could not reach")
    expect(hostedErrorText({ message: "x".repeat(400) })).toHaveLength(300)
  })
})

describe("Done by Morning", () => {
  const job = (patch: Record<string, unknown> = {}) => ({
    id: JOB,
    state: "reported",
    prompt: "Check the signup page",
    criteria: ["Loads", "Has a form"],
    size: "standard",
    jobMinutes: 30,
    deliverBy: NOW + 36_000_000,
    startAfter: NOW,
    createdAt: NOW,
    report: {
      summary: "Both pass.",
      links: [{ title: "Page", url: "https://example.com/signup" }, { url: "http://example.com/insecure" }],
      pullRequest: "https://github.com/acme/site/pull/7",
      submittedAt: NOW + 1,
      judged: true,
      judge: { model: "Claude Sonnet 5.5", lab: "anthropic" },
      results: [
        { criterion: "Loads", pass: true },
        { criterion: "Has a form", pass: false, note: "No submit button" },
      ],
    },
    recording: { segments: 4, until: NOW + 30 * 86_400_000 },
    ...patch,
  })

  test("decodes jobs, reports (https links only) and the queue", () => {
    const decoded = decodeJob(job())!
    expect(decoded.report?.links).toEqual([{ title: "Page", url: "https://example.com/signup" }])
    expect(decoded.report?.pullRequest).toBe("https://github.com/acme/site/pull/7")
    // The agent reports the results; the server never sees the judge's answer, so no line says another lab checked them.
    expect(verdictLine(decoded.report!)).toBe("Vector reports 1 of 2 criteria met.")
    expect(verdictLine({ ...decoded.report!, judged: false })).toBe("This report has no pass or fail for each criterion.")
    expect(verdictLine(decoded.report!)).not.toMatch(/lab|checked/i)
    expect(decodeJob(job({ report: { ...job().report, pullRequest: "https://evil.example/pull/1" } }))?.report?.pullRequest).toBeUndefined()
    expect(decodeJob(job({ id: "jb_x" }))).toBeUndefined()
    const jobs = decodeJobs({ queue: "paused", plan: { perNight: 3, atOnce: 1, recurringPerDay: 5 }, jobs: [job(), {}] })!
    expect(jobs.jobs).toHaveLength(1)
    expect(queueLine(jobs)).toContain("payment")
    expect(decodeJobs({ queue: "unknown" })).toBeUndefined()
    expect(jobReasonLine({ reason: "late" })).toContain("in time")
    expect(jobReasonLine({ reason: "idle" })).toBe("Nothing happened for 10 minutes.")
  })

  test("one job's recording links are R2 signed links only; Approve answers the pull request to open", () => {
    const answer = decodeJobAnswer({
      job: job(),
      recording: {
        segments: [
          { n: 1, url: `https://${"ab".repeat(16)}.r2.cloudflarestorage.com/vector-media/r/1.ts?X-Amz-Signature=1`, expiresAt: NOW },
          { n: 2, url: "https://elsewhere.example/2.ts", expiresAt: NOW },
        ],
      },
    })!
    expect(answer.segments.map((segment) => segment.n)).toEqual([1])
    expect(decodeApprove({ url: "https://github.com/acme/site/pull/7", job: job() })?.url).toBe(
      "https://github.com/acme/site/pull/7",
    )
    expect(decodeApprove({ url: "https://elsewhere.example/pull/7" })).toBeUndefined()
  })

  test("deliver-by times fall within the next day, at least half an hour away", () => {
    const at = defaultDeliverBy(NOW)
    expect(at - NOW).toBeGreaterThanOrEqual(60 * 60_000)
    expect(at - NOW).toBeLessThan(24 * 60 * 60_000)
    const local = new Date(NOW)
    const soon = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`
    // The same clock time as now is tomorrow, not in the past.
    expect(deliverByFromTime(soon, NOW)! - NOW).toBe(24 * 60 * 60_000)
    expect(deliverByFromTime("25:00", NOW)).toBeUndefined()
    expect(deliverByFromTime("7am", NOW)).toBeUndefined()
  })
})

describe("download-only start (H1c)", () => {
  const DAY = 86_400_000
  const DOWNLOAD = `hs_${"d".repeat(26)}`
  const plan = (patch: Record<string, unknown> = {}) => ({
    signedIn: true,
    customer: true,
    listed: ["computer"],
    entitlements: {},
    ...patch,
  })
  const download = (patch: Record<string, unknown> = {}) =>
    session({ id: DOWNLOAD, mode: "download", title: undefined, download: { requestedAt: NOW - 60_000 }, ...patch })
  const hosted = (kept: unknown, patch: Record<string, unknown> = {}) =>
    decodeHostedStatus({ available: true, access: "stop", sessions: [], kept, ...patch })

  test("asked about only for a customer with the computer listed and not in the plan", () => {
    expect(keptCandidate(plan())).toBe(true)
    expect(keptCandidate(plan({ listed: new Set(["computer"]) }))).toBe(true)
    expect(keptCandidate(plan({ entitlements: { hosted: null } }))).toBe(true)
    // In the plan: the cloud computer itself shows (computerShown), not the offer.
    expect(keptCandidate(plan({ entitlements: { hosted: { computers: 1 } } }))).toBe(false)
    // Not listed, an allowlisted account before listing included (H1): nothing is asked.
    expect(keptCandidate(plan({ listed: [] }))).toBe(false)
    expect(keptCandidate(plan({ customer: false }))).toBe(false)
    expect(keptCandidate(plan({ customer: undefined }))).toBe(false)
    expect(keptCandidate(plan({ signedIn: false }))).toBe(false)
    expect(keptCandidate(plan({ error: "offline" }))).toBe(false)
    expect(keptCandidate(undefined)).toBe(false)
  })

  test("the status's kept disks are read leniently", () => {
    const until = NOW + 14 * DAY
    const two = { state: "open", until, disks: [{ computer: 1 }, { computer: 2, session: download({ computer: 2 }) }] }
    expect(hosted(two)?.kept).toEqual({
      state: "open",
      until,
      disks: [{ computer: 1 }, { computer: 2, session: decodeSession(download({ computer: 2 }))! }],
    })
    for (const bad of [
      { state: "maybe", until, disks: [{ computer: 1 }] },
      { state: "open", disks: [{ computer: 1 }] },
      { state: "open", until: "soon", disks: [{ computer: 1 }] },
      { state: "open", until, disks: [{ computer: 0 }, { computer: 4 }, { computer: 1.5 }, { computer: "1" }] },
      { state: "open", until, disks: [] },
      "open",
    ])
      expect(hosted(bad)?.kept).toBeUndefined()
    const odd = hosted({
      state: "closed",
      until,
      disks: [
        // A job session without packed files, and another computer's session, are not this computer's offer.
        { computer: 1, session: session() },
        { computer: 2, session: download({ computer: 3 }) },
        { computer: 2, session: download({ computer: 2 }) },
        { computer: 3, session: session({ computer: 3, download: { requestedAt: NOW - 1, readyAt: NOW } }) },
      ],
    })!.kept!
    expect(odd.disks.map((disk) => [disk.computer, disk.session?.id])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, SESSION],
    ])
  })

  test("window open: a start per computer with nothing running, and the days left as a count", () => {
    const view = keptView(hosted({ state: "open", until: NOW + 12.5 * DAY, disks: [{ computer: 1 }] }), NOW)!
    expect(view).toEqual({
      state: "open",
      onHold: false,
      until: NOW + 12.5 * DAY,
      days: 12,
      computers: [{ computer: 1, busy: false, start: true }],
    })
    expect(keptLine(view)).toBe("Kept for download for 12 more days, then deleted.")
    expect(keptNote(view)).toBeUndefined()
    expect(keptLine({ days: 1 })).toBe("Kept for download for 1 more day, then deleted.")
    const left = (ms: number) => keptView(hosted({ state: "open", until: NOW + ms, disks: [{ computer: 1 }] }), NOW)!
    expect(keptLine(left(27 * 3_600_000))).toBe("Kept for download for 1 more day, then deleted.")
    expect(keptLine(left(3 * 3_600_000))).toBe("Kept for download for less than a day, then deleted.")
    expect(keptLabels({ computer: 1 }, false)).toEqual({ start: DOWNLOAD_ACTION, open: "Open the download" })
    expect(DOWNLOAD_ACTION).toBe("Download your files")
    expect(keptLabels({ computer: 1, ready: DOWNLOAD }, false).start).toBe("Pack them again")
    expect(keptLabels({ computer: 2 }, true)).toEqual({
      start: "Download computer 2's files",
      open: "Open computer 2's download",
    })
    expect(keptLabels({ computer: 2, ready: DOWNLOAD }, true).start).toBe("Pack computer 2's files again")
  })

  test("window late or closed: no start, packed files still offered; past the date nothing", () => {
    const ready = download({ state: "ended", reason: "finished", download: { requestedAt: NOW - 1, readyAt: NOW - 1 } })
    const late = keptView(hosted({ state: "late", until: NOW + 30 * 60_000, disks: [{ computer: 1 }] }), NOW)!
    expect(late.computers).toEqual([{ computer: 1, busy: false, start: false }])
    expect(keptNote(late)).toBe("Too little time is left to get them ready before they are deleted.")
    const closed = keptView(
      hosted({ state: "closed", until: NOW + DAY, disks: [{ computer: 1, session: ready }] }),
      NOW,
    )!
    expect(closed.computers).toEqual([{ computer: 1, busy: false, ready: DOWNLOAD, start: false }])
    expect(keptNote(closed)).toBe("Getting them ready again is not available right now.")
    // Closed with nothing packed has nothing to offer.
    expect(keptView(hosted({ state: "closed", until: NOW + DAY, disks: [{ computer: 1 }] }), NOW)).toBeUndefined()
    expect(keptView(hosted({ state: "open", until: NOW, disks: [{ computer: 1 }] }), NOW)).toBeUndefined()
    const past = { state: "open", until: NOW - 1, disks: [{ computer: 1, session: ready }] }
    expect(keptView(hosted(past), NOW)).toBeUndefined()
  })

  test("frozen, on hold or unavailable: no start; packed files only", () => {
    const ready = download({ state: "ended", reason: "finished", download: { requestedAt: NOW - 1, readyAt: NOW - 1 } })
    const open = { state: "open", until: NOW + DAY, disks: [{ computer: 1, session: ready }] }
    const held = keptView(hosted(open, { onHold: true }), NOW)!
    expect(held).toMatchObject({
      state: "closed",
      onHold: true,
      computers: [{ computer: 1, ready: DOWNLOAD, start: false }],
    })
    expect(keptNote(held)).toContain("on hold")
    const unavailable = keptView(hosted(open, { available: false }), NOW)
    expect(unavailable?.computers[0]).toMatchObject({ ready: DOWNLOAD, start: false })
    // Nothing packed and nothing may start: no offer at all.
    expect(keptView(hosted({ ...open, disks: [{ computer: 1 }] }, { onHold: true }), NOW)).toBeUndefined()
    expect(keptView(hosted({ ...open, disks: [{ computer: 1 }] }, { available: false }), NOW)).toBeUndefined()
    // No kept disks in the status (a frozen plan or a lost dispute: the server sends none).
    expect(keptView(hosted(undefined), NOW)).toBeUndefined()
    expect(keptView(undefined, NOW)).toBeUndefined()
  })

  test("refusals show H1a's own words", () => {
    for (const [status, code, message] of [
      [402, "MODEL_PLAN_EXHAUSTED", "Your Vector Codium plan cannot cover getting this computer's files ready."],
      [409, "HOSTED_DOWNLOAD_UNAVAILABLE", "Too little time is left before this computer's disk is deleted."],
      [429, "HOSTED_BUSY", "This computer is already getting its files ready."],
      [403, "HOSTED_FROZEN", "The cloud computer is on hold for this account."],
    ] as const)
      expect(hostedErrorText({ status, code, message })).toBe(message)
  })

  test("a download-only session: its mode, line, state, controls and end", () => {
    expect(decodeSession(download())?.mode).toBe("download")
    expect(decodeSession(download({ mode: "job" }))?.mode).toBeUndefined()
    expect(decodeSession(session({ mode: "elsewhere" }))?.mode).toBeUndefined()
    expect(decodeSession(download({ handoff: { reason: "captcha", since: NOW } }))?.handoff).toBeUndefined()
    const packing = decodeSession(download())!
    expect(sessionLine(packing)).toBe(DOWNLOAD_LINE)
    expect(stateLabel(decodeSession(download({ state: "starting" }))!)).toBe("Starting the computer")
    expect(stateLabel(packing)).toBe("Packing and uploading the files")
    const ready = decodeSession(download({ download: { requestedAt: NOW - 60_000, readyAt: NOW } }))!
    expect(stateLabel(ready)).toBe("Your files are ready")
    expect(stateLabel(decodeSession(download({ state: "stopping" }))!)).toBe("Stopping")
    expect(sessionControls(packing)).toEqual({
      watch: false,
      takeover: false,
      control: false,
      release: false,
      stop: true,
      files: false,
    })
    expect(sessionControls(ready)).toMatchObject({ watch: false, takeover: false, stop: true, files: true })
    expect(sessionControls(decodeSession(download({ state: "stopping" }))!).stop).toBe(false)
    expect(reasonLine({ ...ready, state: "ended", reason: "finished" })).toBe("Your files are ready.")
    // The reaper also ends one "finished" when the computer said it was done without uploading (hosted-crons.ts).
    expect(reasonLine({ ...packing, state: "ended", reason: "finished" })).toBe(
      "The computer stopped before its files were ready.",
    )
    expect(reasonLine({ ...packing, state: "ended", reason: "deadline" })).toBe(
      "The computer could not get the files ready in time.",
    )
    expect(reasonLine({ ...packing, state: "ended", reason: "stopped" })).toBe("You stopped it.")
    // A job session's lines are unchanged.
    expect(sessionLine(decodeSession(session())!)).toBe(USING_LINE)
    expect(reasonLine({ state: "ended", reason: "finished" })).toBe("Vector finished the job.")
  })

  test("progress: busy while its download runs, ready once packed, and why it ended without files", () => {
    const until = NOW + 5 * DAY
    const view = (sessionOn1: unknown) =>
      keptView(hosted({ state: "open", until, disks: [{ computer: 1, session: sessionOn1 }, { computer: 2 }] }), NOW)!
    expect(view(download()).computers).toEqual([
      { computer: 1, busy: true, start: false },
      { computer: 2, busy: false, start: true },
    ])
    expect(view(download({ download: { requestedAt: NOW - 1, readyAt: NOW } })).computers[0]).toEqual({
      computer: 1,
      busy: true,
      ready: DOWNLOAD,
      start: false,
    })
    expect(view(download({ state: "ended", reason: "deadline" })).computers[0]).toEqual({
      computer: 1,
      busy: false,
      ended: "The computer could not get the files ready in time.",
      start: true,
    })
    // A job session's packed files count: they are a copy of the same disk (H1a R11).
    const job = session({ state: "ended", reason: "stopped", download: { requestedAt: NOW - 2, readyAt: NOW - 1 } })
    expect(view(job).computers[0]).toEqual({ computer: 1, busy: false, ready: SESSION, start: true })
  })

  test("a download link's end comes from the link", () => {
    expect(linkLine(NOW, () => "Nov 10, 9:00 PM")).toBe("Its link works until Nov 10, 9:00 PM.")
    expect(linkLine(undefined, () => "never")).toBeUndefined()
  })
})

describe("copy (P1, H3, H4)", () => {
  const directory = import.meta.dir
  const sources = [
    ...readdirSync(directory)
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => path.join(directory, file)),
    path.join(directory, "../../../phone/routes/computer.tsx"),
  ]

  test("no amount, price or token count; no GitHub or Actions; no promise", () => {
    expect(sources.length).toBeGreaterThan(2)
    for (const file of sources) {
      // Comments explain the rules, so they name what the copy must not; only code and copy are checked.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/\$\{/g, "")
      expect({ file, found: code.match(/\$\d|\bUSD\b|\bcredits?\b|\btokens? left\b/gi) ?? [] }).toEqual({ file, found: [] })
      expect({ file, found: code.match(/\bGitHub\b|\bActions\b/g) ?? [] }).toEqual({ file, found: [] })
      expect({ file, found: code.match(/guarantee|24\/7|\bSLA\b|exclusive|uptime|every pull request/gi) ?? [] }).toEqual({
        file,
        found: [],
      })
    }
  })
})
