// What the cloud computer's screens show (WP A56), shared by the desktop (the composer's "Run on my cloud computer",
// the bar above the composer and the live view window) and the phone app's Cloud computer page. Every answer from
// vectordev.ai is read field by field: a malformed entry is dropped and an unknown value ignored, so a newer server
// never breaks a screen. Display only: the server decides every start, take-over and stop from the plan (S1). Pure
// TypeScript: no DOM, Node or Solid import.
//
// Copy rules: the cloud computer is one Vector runs for you, and its copy never mentions GitHub or Actions (H4); nothing
// shows an amount, a price or a token count, only shares and counts (P1); a Done by Morning job "aims to deliver by" a
// time and promises nothing (H3).

import {
  downloadLinkAllowed,
  LIMITS,
  pullRequestLinkAllowed,
  recordingLinkAllowed,
  SIZES,
  viewerLinkAllowed,
  type HostedSize,
} from "./hosted-requests"

export const USING_LINE = "Vector is using its cloud computer"
export const CONTROL_LINE = "You have control of the cloud computer"
export const DELIVER_LABEL = "Aims to deliver by"
export const COMPOSER_ACTION = "Run on my cloud computer"
export const HOSTED_LINE =
  "A computer Vector runs for you: close the laptop and Vector finishes the job. Watch it live and take over whenever you like. Password, card and CAPTCHA steps are always handed to you, and the browser profile is wiped after each job."

const SESSION_STATES = ["starting", "running", "takeover", "wrapping", "stopping", "ended"] as const
export type SessionState = (typeof SESSION_STATES)[number]
const LIVE: readonly SessionState[] = ["starting", "running", "takeover", "wrapping", "stopping"]
const HANDOFFS = ["credential", "payment_details", "captcha", "other"] as const
export type Handoff = (typeof HANDOFFS)[number]
const ACCESS = ["start", "continue", "wrap", "stop"] as const
export type Access = (typeof ACCESS)[number]
const JOB_STATES = ["queued", "running", "reported", "incomplete", "cancelled", "missed"] as const
export type JobState = (typeof JOB_STATES)[number]
const QUEUE_STATES = ["open", "waiting", "paused", "closed"] as const
export type QueueState = (typeof QUEUE_STATES)[number]
export const BANDS = [
  "under 1%",
  "1–2%",
  "2–5%",
  "5–10%",
  "10–20%",
  "20–40%",
  "over 40%",
  "more than your month",
] as const
export type Band = (typeof BANDS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const share = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
const text = (value: unknown, max = 2_048) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined
const oneOf = <T extends string>(values: readonly T[], value: unknown) =>
  values.some((item) => item === value) ? (value as T) : undefined
const list = <T>(value: unknown, decode: (item: unknown) => T | undefined): T[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const decoded = decode(item)
        return decoded === undefined ? [] : [decoded]
      })
    : []

// ── What shows ─────────────────────────────────────────────────────────────────────────────────────────────────────

type StatusLike = {
  listed?: readonly string[] | ReadonlySet<string>
  entitlements?: Readonly<Record<string, unknown>>
  signedIn?: boolean
  error?: unknown
}

const listedSet = (status: StatusLike | undefined) => new Set<string>(status?.listed ? [...status.listed] : [])

/** Whether the cloud computer shows: listed (H1) while the plan's public entitlements include it. */
export function computerShown(status: StatusLike | undefined) {
  if (!status || status.signedIn === false || status.error) return false
  return listedSet(status).has("computer") && isRecord(status.entitlements?.hosted)
}

/** Whether Done by Morning shows: listed (it lists only with the cloud computer) and in the plan. */
export function overnightShown(status: StatusLike | undefined) {
  return computerShown(status) && listedSet(status).has("overnight") && isRecord(status?.entitlements?.overnight)
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedSession = {
  id: string
  state: SessionState
  reason?: string
  computer: number
  size: HostedSize
  title?: string
  createdAt: number
  deadline: number
  runningAt?: number
  endedAt?: number
  wrapBy?: number
  takeover?: { since: number; until: number }
  download?: { requestedAt: number; readyAt?: number }
  handoff?: { reason: Handoff; since: number }
}

export function decodeSession(value: unknown): HostedSession | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 64)
  const state = oneOf(SESSION_STATES, value.state)
  const size = oneOf(SIZES, value.size)
  if (!id || !/^hs_[a-z2-7]{26}$/.test(id) || !state || !size || !count(value.computer)) return undefined
  if (!time(value.createdAt) || !time(value.deadline)) return undefined
  const takeover = isRecord(value.takeover) && time(value.takeover.since) && time(value.takeover.until)
    ? { since: value.takeover.since, until: value.takeover.until }
    : undefined
  const download =
    isRecord(value.download) && time(value.download.requestedAt)
      ? {
          requestedAt: value.download.requestedAt,
          ...(time(value.download.readyAt) ? { readyAt: value.download.readyAt } : {}),
        }
      : undefined
  const handoffReason = isRecord(value.handoff) ? oneOf(HANDOFFS, value.handoff.reason) : undefined
  const handoff =
    handoffReason && isRecord(value.handoff) && time(value.handoff.since)
      ? { reason: handoffReason, since: value.handoff.since }
      : undefined
  return {
    id,
    state,
    ...(text(value.reason, 40) ? { reason: value.reason as string } : {}),
    computer: value.computer,
    size,
    ...(text(value.title, LIMITS.title) ? { title: value.title as string } : {}),
    createdAt: value.createdAt,
    deadline: value.deadline,
    ...(time(value.runningAt) ? { runningAt: value.runningAt } : {}),
    ...(time(value.endedAt) ? { endedAt: value.endedAt } : {}),
    ...(time(value.wrapBy) ? { wrapBy: value.wrapBy } : {}),
    ...(takeover && state === "takeover" ? { takeover } : {}),
    ...(download ? { download } : {}),
    ...(handoff && state === "running" ? { handoff } : {}),
  }
}

export const isLive = (session: Pick<HostedSession, "state">) => LIVE.includes(session.state)

export function decodeSessions(body: unknown) {
  return list(isRecord(body) ? body.sessions : undefined, decodeSession)
}

/** A start, stop, take-over or release answers `{session}`. */
export function decodeSessionAnswer(body: unknown) {
  return isRecord(body) ? decodeSession(body.session) : undefined
}

export type HostedPlan = {
  computers: number
  hours: number
  jobMinutes: number
  diskDays: number
  sizes: HostedSize[]
  browser: boolean
  rampUntil?: number
}

export type HostedStatus = {
  available: boolean
  access: Access
  onHold: boolean
  plan?: HostedPlan
  /** The share of this month's cloud computer hours used, 0..1. */
  hoursUsed?: number
  sessions: HostedSession[]
}

export function decodeHostedStatus(body: unknown): HostedStatus | undefined {
  if (!isRecord(body)) return undefined
  const access = oneOf(ACCESS, body.access)
  if (!access) return undefined
  const plan = isRecord(body.plan) ? body.plan : undefined
  const sizes = plan ? list(plan.sizes, (item) => oneOf(SIZES, item)) : []
  const decodedPlan =
    plan &&
    count(plan.computers) &&
    count(plan.hours) &&
    count(plan.jobMinutes) &&
    count(plan.diskDays) &&
    sizes.length > 0
      ? {
          computers: plan.computers as number,
          hours: plan.hours as number,
          jobMinutes: plan.jobMinutes as number,
          diskDays: plan.diskDays as number,
          sizes,
          browser: plan.browser === true,
          ...(time(plan.rampUntil) ? { rampUntil: plan.rampUntil } : {}),
        }
      : undefined
  const hours = isRecord(body.hours) && share(body.hours.used) ? body.hours.used : undefined
  return {
    available: body.available === true,
    access,
    onHold: body.onHold === true,
    ...(decodedPlan ? { plan: decodedPlan } : {}),
    ...(hours !== undefined ? { hoursUsed: hours } : {}),
    sessions: list(body.sessions, decodeSession),
  }
}

/** Whether a new session may start now, as far as the screens can tell (the server decides). */
export function canStart(status: HostedStatus | undefined) {
  return Boolean(status && status.available && status.access === "start" && !status.onHold && status.plan)
}

/** A whole-percent share for a meter (H5): `used + left = 100`. */
export function hoursLine(status: HostedStatus | undefined) {
  if (status?.hoursUsed === undefined) return undefined
  const used = Math.round(status.hoursUsed * 100)
  return `${100 - used}% of this month's cloud computer hours left`
}

export function decodeViewer(body: unknown) {
  if (!isRecord(body) || !viewerLinkAllowed(body.url)) return undefined
  const mode = body.mode === "control" ? "control" : body.mode === "view" ? "view" : undefined
  if (!mode || !time(body.expiresAt)) return undefined
  return { url: body.url as string, mode, expiresAt: body.expiresAt } as const
}

export function decodeDownload(body: unknown, site?: string) {
  if (!isRecord(body)) return undefined
  if (body.ready === false) return { ready: false as const }
  if (body.ready !== true || !downloadLinkAllowed(body.url, site) || !time(body.expiresAt)) return undefined
  return { ready: true as const, url: body.url as string, expiresAt: body.expiresAt }
}

// ── Copy ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function stateLabel(session: Pick<HostedSession, "state">) {
  switch (session.state) {
    case "starting":
      return "Starting the computer"
    case "running":
      return "Working"
    case "takeover":
      return "You have control"
    case "wrapping":
      return "Saving its work before it stops"
    case "stopping":
      return "Stopping"
    case "ended":
      return "Ended"
  }
}

const END_REASONS: Record<string, string> = {
  stopped: "You stopped it.",
  finished: "Vector finished the job.",
  deadline: "It reached the job's time limit.",
  idle: "Nothing happened for 10 minutes.",
  heartbeat: "The computer stopped answering.",
  hours: "This month's cloud computer hours ran out.",
  usage: "This month's Codium ran out.",
  plan: "Your plan stopped it.",
  frozen: "Your plan is on hold.",
  switch: "Vector paused the cloud computer for now.",
  abuse: "It passed a fair-use limit.",
  failed: "The computer could not start. Only the time it ran counts.",
  closing: "Your account is being deleted.",
  lapsed: "Vector could not keep the job running.",
}

export function reasonLine(session: Pick<HostedSession, "state" | "reason">) {
  if (!session.reason) return undefined
  return END_REASONS[session.reason]
}

/** The line on the purple-edged bar: who has the computer now. */
export function sessionLine(session: Pick<HostedSession, "state">) {
  return session.state === "takeover" ? CONTROL_LINE : USING_LINE
}

/** What the person can do with a live session now, as far as the screens can tell (the server decides). */
export function sessionControls(session: Pick<HostedSession, "state">) {
  const viewable = session.state === "running" || session.state === "takeover" || session.state === "wrapping"
  return {
    watch: viewable && session.state !== "takeover",
    takeover: session.state === "running",
    control: session.state === "takeover",
    release: session.state === "takeover",
    stop: session.state !== "ended" && session.state !== "stopping",
    files: viewable,
  }
}

/** How long a take-over has left before control goes back to Vector (30 minutes at most at a time). */
export function takeoverLine(session: Pick<HostedSession, "state" | "takeover">, now = Date.now()) {
  if (session.state !== "takeover" || !session.takeover) return undefined
  const minutes = Math.max(0, Math.ceil((session.takeover.until - now) / 60_000))
  return minutes <= 1
    ? "Control goes back to Vector in a minute."
    : `Control goes back to Vector in ${minutes} minutes, or when you give it back.`
}

export function handoffLine(handoff: { reason: Handoff } | undefined) {
  switch (handoff?.reason) {
    case "credential":
      return "Vector needs you: it reached a password or one-time-code field. Take over to type it yourself."
    case "payment_details":
      return "Vector needs you: it reached a card field. Take over to type it yourself."
    case "captcha":
      return "Vector needs you: it reached a CAPTCHA. Take over to answer it."
    case "other":
      return "Vector needs you. Take over to help."
    default:
      return undefined
  }
}

export function accessLine(status: HostedStatus | undefined) {
  if (!status) return undefined
  if (status.onHold) return "Your cloud computer is on hold. Contact Vector support to look at it with you."
  switch (status.access) {
    case "continue":
      return "Your plan is renewing: running jobs continue, and new ones can start once it renews."
    case "wrap":
      return "A payment needs attention: running jobs save their work and stop. Update your card to start new ones."
    case "stop":
      return "Your plan does not run the cloud computer right now."
  }
  if (!status.available) return "The cloud computer is not taking new jobs right now. Try again later."
  return undefined
}

export function rampLine(plan: HostedPlan | undefined, now = Date.now()) {
  if (!plan?.rampUntil || plan.rampUntil <= now) return undefined
  return "A new Max or Ultra plan starts with a shorter cloud computer allowance for its first days."
}

export const SIZE_LABELS: Record<HostedSize, string> = {
  standard: "Standard",
  large: "Large (counts double)",
}

/** The job lengths offered: 15 minutes up to the plan's longest job. */
export function minuteChoices(jobMinutes: number | undefined) {
  const cap = Math.min(LIMITS.minutesMax, Math.max(0, jobMinutes ?? 0))
  const choices = [15, 30, 60, 120, 240, 480, 720].filter((minutes) => minutes <= cap)
  if (cap >= LIMITS.minutesMin && !choices.includes(cap)) choices.push(cap)
  return choices
}

export function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${minutes} minutes`
}

/** The estimate's band (P2): the same bands as every Codium estimate, never an amount. */
export function decodeEstimate(body: unknown) {
  if (!isRecord(body)) return undefined
  const band = oneOf(BANDS, body.share)
  if (!band) return undefined
  const today = oneOf(BANDS, body.todayShare)
  return { share: band, ...(today ? { todayShare: today } : {}) }
}

/**
 * The pre-start ceiling: the most the computer's time for this job can use of the month, from the estimate. Codium
 * requests the agent makes on the computer count as well, as they do on this computer.
 */
export function ceilingLine(estimate: { share: Band; todayShare?: Band } | undefined) {
  if (!estimate) return undefined
  if (estimate.share === "more than your month")
    return "This job's computer time could use more than what is left of your month. Choose a shorter job or the standard size."
  const today =
    estimate.todayShare && estimate.todayShare !== estimate.share ? `, and up to ${estimate.todayShare} of today's limit` : ""
  return `The computer's time for this job uses at most ${estimate.share} of your month${today}. Its Codium requests count too.`
}

/** Text for a refusal, from vectordev.ai's own words where it gave them. */
export function hostedErrorText(failure: { status?: number; code?: string; message?: string } | undefined) {
  if (!failure) return "Vector could not reach the cloud computer. Try again shortly."
  if (failure.code === "LOCAL_OFF" || failure.code === "SIGN_IN") return failure.message ?? "Sign in to Vector."
  if (failure.status === 0) return "Vector could not be reached. Check your connection."
  return failure.message?.trim() ? failure.message.trim().slice(0, 300) : "Something went wrong. Try again shortly."
}

// ── Done by Morning ────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedReport = {
  summary: string
  links: { title?: string; url: string }[]
  pullRequest?: string
  submittedAt: number
  judged: boolean
  judge?: { model: string; lab: string }
  results: { criterion: string; pass: boolean; note?: string }[]
}

export type HostedJob = {
  id: string
  state: JobState
  reason?: string
  title?: string
  prompt: string
  criteria: string[]
  size: HostedSize
  jobMinutes: number
  deliverBy: number
  startAfter: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  session?: string
  recurring?: string
  report?: HostedReport
  recording?: { segments: number; until: number }
  approvedAt?: number
}

const https = (value: unknown) => {
  const url = text(value)
  if (!url) return undefined
  try {
    return new URL(url).protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

function decodeReport(value: unknown): HostedReport | undefined {
  if (!isRecord(value) || !time(value.submittedAt)) return undefined
  const summary = text(value.summary, 4_000)
  if (!summary) return undefined
  const judge =
    isRecord(value.judge) && text(value.judge.model, 200) && text(value.judge.lab, 60)
      ? { model: value.judge.model as string, lab: value.judge.lab as string }
      : undefined
  return {
    summary,
    links: list(value.links, (item) => {
      if (!isRecord(item)) return undefined
      const url = https(item.url)
      if (!url) return undefined
      return { ...(text(item.title, 120) ? { title: item.title as string } : {}), url }
    }),
    ...(pullRequestLinkAllowed(value.pullRequest) ? { pullRequest: value.pullRequest as string } : {}),
    submittedAt: value.submittedAt,
    judged: value.judged === true,
    ...(judge ? { judge } : {}),
    results: list(value.results, (item) =>
      isRecord(item) && text(item.criterion, 300) && typeof item.pass === "boolean"
        ? {
            criterion: item.criterion as string,
            pass: item.pass,
            ...(text(item.note, 500) ? { note: item.note as string } : {}),
          }
        : undefined,
    ),
  }
}

export function decodeJob(value: unknown): HostedJob | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 64)
  const state = oneOf(JOB_STATES, value.state)
  const size = oneOf(SIZES, value.size)
  const prompt = text(value.prompt, LIMITS.jobPrompt + 1_000)
  if (!id || !/^jb_[a-z2-7]{26}$/.test(id) || !state || !size || !prompt) return undefined
  if (!count(value.jobMinutes) || !time(value.deliverBy) || !time(value.startAfter) || !time(value.createdAt))
    return undefined
  const report = decodeReport(value.report)
  return {
    id,
    state,
    ...(text(value.reason, 40) ? { reason: value.reason as string } : {}),
    ...(text(value.title, LIMITS.title) ? { title: value.title as string } : {}),
    prompt,
    criteria: list(value.criteria, (item) => text(item, LIMITS.criterion)),
    size,
    jobMinutes: value.jobMinutes,
    deliverBy: value.deliverBy,
    startAfter: value.startAfter,
    createdAt: value.createdAt,
    ...(time(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(time(value.endedAt) ? { endedAt: value.endedAt } : {}),
    ...(text(value.session, 64) ? { session: value.session as string } : {}),
    ...(text(value.recurring, 64) ? { recurring: value.recurring as string } : {}),
    ...(report ? { report } : {}),
    ...(isRecord(value.recording) && count(value.recording.segments) && time(value.recording.until)
      ? { recording: { segments: value.recording.segments, until: value.recording.until } }
      : {}),
    ...(time(value.approvedAt) ? { approvedAt: value.approvedAt } : {}),
  }
}

export type HostedJobs = {
  available: boolean
  queue: QueueState
  plan?: { perNight: number; atOnce: number; recurringPerDay: number }
  jobs: HostedJob[]
}

export function decodeJobs(body: unknown): HostedJobs | undefined {
  if (!isRecord(body)) return undefined
  const queue = oneOf(QUEUE_STATES, body.queue)
  if (!queue) return undefined
  const plan =
    isRecord(body.plan) && count(body.plan.perNight) && count(body.plan.atOnce) && count(body.plan.recurringPerDay)
      ? { perNight: body.plan.perNight, atOnce: body.plan.atOnce, recurringPerDay: body.plan.recurringPerDay }
      : undefined
  return { available: body.available === true, queue, ...(plan ? { plan } : {}), jobs: list(body.jobs, decodeJob) }
}

/** One job with its recording's 15-minute links (`GET /api/hosted/jobs/<id>`). */
export function decodeJobAnswer(body: unknown) {
  if (!isRecord(body)) return undefined
  const job = decodeJob(body.job)
  if (!job) return undefined
  const segments = isRecord(body.recording)
    ? list(body.recording.segments, (item) =>
        isRecord(item) && count(item.n) && recordingLinkAllowed(item.url) && time(item.expiresAt)
          ? { n: item.n, url: item.url as string, expiresAt: item.expiresAt }
          : undefined,
      )
    : []
  return { job, segments }
}

/** Approve answers the pull request's address for this client to open; the server merges nothing (S9). */
export function decodeApprove(body: unknown) {
  if (!isRecord(body) || !pullRequestLinkAllowed(body.url)) return undefined
  return { url: body.url as string, job: decodeJob(body.job) }
}

export function jobStateLabel(job: Pick<HostedJob, "state">) {
  switch (job.state) {
    case "queued":
      return "Queued"
    case "running":
      return "Running"
    case "reported":
      return "Report ready"
    case "incomplete":
      return "Ended without a report"
    case "cancelled":
      return "Cancelled"
    case "missed":
      return "Could not start in time"
  }
}

export function queueLine(jobs: HostedJobs | undefined) {
  switch (jobs?.queue) {
    case "waiting":
      return "Queued jobs wait: your plan is renewing, or Vector paused the cloud computer for now."
    case "paused":
      return "Queued jobs are paused until a payment goes through."
    case "closed":
      return "Your plan does not include Done by Morning right now."
    default:
      return undefined
  }
}

const JOB_REASONS: Record<string, string> = {
  cancelled: "You cancelled it.",
  plan: "Your plan's queue was cancelled.",
  frozen: "Your plan is on hold.",
  closing: "Your account is being deleted.",
  hours: "This month's cloud computer hours ran out.",
  usage: "This month's Codium ran out.",
  paused: "A payment needed attention when it was due to start.",
  late: "It could not start in time to deliver by then.",
  refused: "Your plan did not allow it when it was due to start.",
  failed: "The cloud computer could not start, so Vector stopped trying.",
}

/** Why a job was cancelled, missed or ended without a report, in a sentence. */
export function jobReasonLine(job: Pick<HostedJob, "reason">) {
  if (!job.reason) return undefined
  return JOB_REASONS[job.reason] ?? END_REASONS[job.reason]
}

/**
 * The report's verdict line. The pass or fail per criterion is what Vector's agent reported after asking a judge model:
 * the server checks that it asked, not what the judge answered, so the line never says another lab checked the work
 * (P8 review).
 */
export function verdictLine(report: HostedReport) {
  if (!report.judged) return "This report has no pass or fail for each criterion."
  const passed = report.results.filter((result) => result.pass).length
  return `Vector reports ${passed} of ${report.results.length} criteria met.`
}

/**
 * When a job queued now would aim to deliver by default: the next 7:00 on this computer's clock that is at least an
 * hour away (so the job fits) and within a day, the window the server takes.
 */
export function defaultDeliverBy(now: number) {
  const date = new Date(now)
  date.setHours(7, 0, 0, 0)
  if (date.getTime() - now < 60 * 60_000) date.setDate(date.getDate() + 1)
  return Math.min(date.getTime(), now + 24 * 60 * 60_000 - 60_000)
}

/** A `HH:MM` time from a time input, as the next such time within a day; undefined when it is not one. */
export function deliverByFromTime(value: string, now: number) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  const date = new Date(now)
  date.setHours(hours, minutes, 0, 0)
  if (date.getTime() - now < 30 * 60_000) date.setDate(date.getDate() + 1)
  const at = date.getTime()
  return at - now <= 24 * 60 * 60_000 ? at : undefined
}

export function timeInputValue(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
