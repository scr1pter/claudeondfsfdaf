export * as Hosted from "./hosted.js"

/*
 * The cloud computer's shared vocabulary (contract WP A51): what the API (api/_lib/hosted-*.ts), the desktop and the
 * phone (WP A56) say about a computer Vector hosts. Browser-safe: no Node imports, and never a rate, a price or an
 * amount. What an hour costs stays in api/_lib/hosted-rates.ts, which only the API imports (P1).
 *
 * Copy about the cloud computer always says Vector hosts it and never mentions GitHub or Actions (H4).
 */

/** The computer sizes a plan may include (`Entitlements.hosted.sizes`). */
export const SIZES = ["standard", "large"] as const
export type Size = (typeof SIZES)[number]

export function isSize(value: unknown): value is Size {
  return SIZES.some((size) => size === value)
}

/**
 * How many of the plan's cloud computer hours one hour on each size uses: the large size counts double (§1.1). The
 * plan's hours are counted in these weighted minutes.
 */
export const SIZE_WEIGHT: Readonly<Record<Size, number>> = Object.freeze({ standard: 1, large: 2 })

/**
 * What an account's plan state lets its cloud computers do (contract §4.4, the cloud computer row):
 * - `start`     active: new sessions start within the plan's caps (with the trust ramp);
 * - `continue`  renewing: running sessions continue, no new ones;
 * - `wrap`      paused: running sessions wrap up, snapshot and stop within `WRAP_MS`; the queue waits;
 * - `stop`      ended or frozen, or no plan: nothing runs.
 */
export const ACCESS = ["start", "continue", "wrap", "stop"] as const
export type Access = (typeof ACCESS)[number]

/** A paused account's running sessions stop within this long (§4.4). */
export const WRAP_MS = 5 * 60_000

/**
 * The one port a cloud computer exposes (WP A52): its viewer proxy (WP A54), which serves the live view and take-over
 * behind the single-use viewer tokens of WP A53. Nothing else on the computer is reachable from outside.
 */
export const VIEWER_PORT = 6080

/**
 * The dedicated host a cloud computer reaches Vector's API through (WP A52). The provider's egress proxy adds the
 * session's `vht_` run token to requests for this host only, so the token never exists inside the computer, and the
 * computer's browser is barred from it by its URL policy (WP A54), so no web page can borrow it. The API refuses
 * requests here that carry `Origin`, `Sec-Fetch-*` or cookies (S7, WP A53).
 */
export const RUN_API_HOST = "hosted-run.vectordev.ai"

/**
 * What happens to a computer's disk when nothing may run (§4.4): kept for the plan's `diskDays` while a plan is live;
 * kept `ENDED_DISK_DAYS` for download after a plan ends (with a notice), then deleted; kept while a dispute is open and
 * deleted `LOST_DISPUTE_DISK_DAYS` after it is lost.
 */
export const ENDED_DISK_DAYS = 14
export const LOST_DISPUTE_DISK_DAYS = 30

/** The service's error codes (contract §4.10). Every message is plain copy with no amount. */
export const ERROR_CODES = {
  HOSTED_NOT_INCLUDED: 403,
  HOSTED_BUSY: 429,
  HOSTED_HOURS_USED: 402,
  HOSTED_PAUSED: 402,
  HOSTED_FROZEN: 403,
  HOSTED_UNAVAILABLE: 503,
  HOSTED_SESSION_PAUSED: 409,
  // Not in §4.10's list; added by WP A51 (request, running, moved) and WP A53 (the rest).
  HOSTED_REQUEST: 400,
  HOSTED_SESSION_RUNNING: 409,
  HOSTED_SESSION_MOVED: 409,
  HOSTED_SESSION_NOT_FOUND: 404,
  HOSTED_SESSION_ENDED: 409,
  HOSTED_TAKEOVER_REQUIRED: 409,
  HOSTED_RUN_REFUSED: 403,
  HOSTED_DOWNLOAD_UNAVAILABLE: 409,
  // Done by Morning (WP A55).
  HOSTED_JOB_NOT_FOUND: 404,
  HOSTED_JOB_LIMIT: 429,
  HOSTED_JOB_STATE: 409,
  HOSTED_JOB_REFUSED: 403,
  HOSTED_JOB_JUDGE: 409,
} as const
export type ErrorCode = keyof typeof ERROR_CODES

/**
 * The share of the month's cloud computer hours used, as a whole percent between 0 and 1 (status `meters.hosted.used`,
 * H5): weighted minutes used over the plan's hours. A plan with no hours reads as used up.
 */
export function hoursUsedShare(usedMinutes: number, hours: number) {
  if (!(hours > 0)) return 1
  const used = Number.isFinite(usedMinutes) ? Math.max(0, usedMinutes) : 0
  return Math.min(100, Math.round((used / (hours * 60)) * 100)) / 100
}

// ── Sessions (WP A53) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A session is one job on one cloud computer, from start to stop (WP A53). Its states:
 * - `starting`  the first block of time is held and the computer is being made or resumed;
 * - `running`   the agent works on the computer;
 * - `takeover`  the person has control: the agent is paused (its model requests are refused) and nothing is recorded;
 * - `wrapping`  the session must stop by `wrapBy` (its job's deadline, a plan that no longer allows it, or no more time
 *               could be held): the agent saves its work and the computer snapshots its disk;
 * - `stopping`  the computer is being stopped;
 * - `ended`     the computer is stopped and the session's time is charged.
 */
export const SESSION_STATES = ["starting", "running", "takeover", "wrapping", "stopping", "ended"] as const
export type SessionState = (typeof SESSION_STATES)[number]
/** The states in which a computer runs (and its time counts). */
export const LIVE_STATES: readonly SessionState[] = ["starting", "running", "takeover", "wrapping", "stopping"]

/**
 * Why a session wraps up or ended: the person stopped it, the agent finished, its deadline, 10 minutes with nothing
 * done, the computer stopped answering, the plan's hours or the month's (or the day's) Codium used up, a plan state
 * that no longer allows it, a hold on the account, the owner's switch, a fair-use limit, a start that failed, account
 * deletion, or time that could not be held.
 */
export const END_REASONS = [
  "stopped",
  "finished",
  "deadline",
  "idle",
  "heartbeat",
  "hours",
  "usage",
  "plan",
  "frozen",
  "switch",
  "abuse",
  "failed",
  "closing",
  "lapsed",
] as const
export type EndReason = (typeof END_REASONS)[number]

/** Where a session was started from (a subset of the run trigger's sources, §4.17). */
export const SESSION_SOURCES = ["desktop", "cli", "phone", "schedule"] as const
export type SessionSource = (typeof SESSION_SOURCES)[number]

/** A session id: `hs_` and 26 lower-case base32 letters (RFC 4648, a-z and 2-7), and nothing else. */
const SESSION_ID_START = /^hs_[a-z2-7]{26}/
export const SESSION_ID = {
  test: (value: string) => typeof value === "string" && value.length === 29 && SESSION_ID_START.test(value),
} as const

/** The longest job prompt a session takes, in characters, and its title. */
export const PROMPT_MAX = 32_000
export const TITLE_MAX = 120

/** The computer's daemon reports to Vector this often while a session runs. */
export const HEARTBEAT_MS = 30_000
/** A computer that has not reported for this long is stopped. */
export const HEARTBEAT_LOST_MS = 3 * 60_000
/** A computer has this long after it starts to send its first report. */
export const BOOT_GRACE_MS = 5 * 60_000
/** A session with no agent activity (no model request, nothing the daemon reports) for this long is stopped. */
export const IDLE_MS = 10 * 60_000
/** The person may hold control for at most this long at a time; control then goes back to the agent. */
export const TAKEOVER_MS = 30 * 60_000

/** How a viewer token lets its holder use the live view: watch, or (during a take-over) control. */
export const VIEWER_MODES = ["view", "control"] as const
export type ViewerMode = (typeof VIEWER_MODES)[number]
/** A viewer token is valid this long, and only once. */
export const VIEWER_TOKEN_MS = 5 * 60_000
/**
 * Viewer tokens: `vvt1.<payload>.<signature>`, base64url. The payload is JSON
 * `{aud: "vector-viewer", sid, computer, mode, jti, iat, exp}` (seconds), and the signature is Ed25519 over
 * `VIEWER_TOKEN_CONTEXT + payload`. The token travels in the live view URL's fragment (`#vt=<token>`), so it never
 * reaches a server log or a referrer. The computer's viewer proxy (WP A54) checks the signature with the public key the
 * session's heartbeat answers carry, the audience, the session and computer, the expiry, and that the jti was not used
 * before on that computer.
 */
export const VIEWER_TOKEN_PREFIX = "vvt1"
export const VIEWER_TOKEN_CONTEXT = "vector-viewer-token-v1."
export const VIEWER_FRAGMENT = "vt"

/** A session's files, packed by the computer on request, are downloadable through a link valid this long. */
export const DOWNLOAD_LINK_MS = 24 * 3_600_000

/**
 * The boot step (WP A53 → WP A54). After a computer starts, Vector runs this command on it, as root, detached, with
 * `--run-host <host> --session <id>` and nothing else: no credential. The computer's daemon then calls
 * `POST https://<host>/api/hosted/sessions/<id>/heartbeat` with no credential of its own (the provider's egress proxy
 * adds the session's run token), and the first answer carries the job.
 */
export const BOOT_COMMAND = "/opt/vector/boot.sh"

/** A session as its owner sees it: states, times and counts only, never an amount (P1). */
export type SessionView = {
  id: string
  state: SessionState
  reason?: EndReason
  computer: number
  size: Size
  source: SessionSource
  title?: string
  createdAt: number
  deadline: number
  runningAt?: number
  endedAt?: number
  wrapBy?: number
  takeover?: { since: number; until: number }
  download?: { requestedAt: number; readyAt?: number }
  /**
   * The computer is waiting for the person (WP A56): its credential guard met a password, one-time-code or card field,
   * or a CAPTCHA, and handed the computer over. Sent only while the agent has control; taking over answers it.
   */
  handoff?: { reason: Handoff; since: number }
}

/**
 * Why the computer asks for the person (WP A54): its credential guard met a password or one-time-code field
 * (`credential`) or a card field (`payment_details`), a CAPTCHA (`captcha`), or the agent asked (`other`). The agent's
 * own words never travel: the reason is all the server hears.
 */
export const HANDOFFS = ["credential", "payment_details", "captcha", "other"] as const
export type Handoff = (typeof HANDOFFS)[number]

/**
 * The computer's daemon's report (`POST …/heartbeat`). Counters are cumulative for the session; the server works out
 * what changed. `archiveBytes` answers a download request with the size of the packed files. `generation` is the base
 * image generation the computer's disk was made from (WP A54), and `handoff` the latest hand-over the person has not
 * taken yet.
 */
export type Heartbeat = {
  cpu?: number
  activeAt?: number
  pageLoads?: number
  egressBytes?: number
  booted?: boolean
  done?: boolean
  archiveBytes?: number
  uploaded?: boolean
  generation?: number
  handoff?: Handoff
  /**
   * Done by Morning (WP A55): finished recording segments not yet uploaded (their numbers and sizes, at most
   * `RECORDING_REPORT_MAX`), and the segments uploaded since. Sent only after an answer carried `recording`.
   */
  segments?: { n: number; bytes: number }[]
  uploadedSegments?: number[]
  /**
   * The daemon's own key (32 random bytes, base64url), sent until a heartbeat answered 200 (P8 review). The first beat
   * that carries one registers it for the session; the job is handed out only to beats signed with it, so the agent
   * (which starts after that) can never register its own.
   */
  hostdKey?: string
  /** HMAC-SHA256 of `hostdMacInput(session, body without mac)` with the daemon's key, base64url (`HOSTD_MAC`). */
  mac?: string
}

/** The daemon's key and a heartbeat's signature, as base64url (32 bytes each: 43 characters). */
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}/
export const HOSTD_KEY = {
  test: (value: string) => typeof value === "string" && value.length === 43 && BASE64URL_43.test(value),
} as const
export const HOSTD_MAC = HOSTD_KEY

/**
 * What a heartbeat's `mac` signs (P8 review): the session id and the body's JSON, `mac` left out. The server signs the
 * body it parsed again with `JSON.stringify`, which gives back the text the daemon made with `JSON.stringify`.
 */
export function hostdMacInput(session: string, body: Readonly<Record<string, unknown>>) {
  return "vector-hostd-beat-v1\n" + session + "\n" + JSON.stringify(body)
}

/** What the daemon is told on each heartbeat. */
export type HeartbeatAnswer = {
  state: SessionState
  /** Who controls the computer: the agent, or the person (take-over: pause the agent, stop recording). */
  control: "agent" | "person"
  deadline: number
  wrapBy?: number
  /** Whether the computer's browser may be used yet (§4.2's trust ramp). */
  browser: boolean
  /** The Ed25519 public key viewer tokens are checked with, base64url (32 bytes). */
  viewerKey: string
  /** The job, until the daemon says it booted. */
  job?: { prompt: string; title?: string }
  /** The person asked for the session's files: pack them and report their size as `archiveBytes` (WP A54). */
  pack?: boolean
  /** Where to upload the packed files, once their size is known. */
  upload?: { url: string; headers: Record<string, string>; expiresAt: number }
  /**
   * Done by Morning (WP A55): this session runs a queued job, so its screen recording is kept for the job's report.
   * Present (possibly with no links) on every answer to such a session; `uploads` signs one PUT per segment reported.
   */
  recording?: { uploads: { n: number; url: string; headers: Record<string, string>; expiresAt: number }[] }
}

// ── Done by Morning (WP A55) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A queued job (Done by Morning): the person queues it with success criteria and a time it aims to be delivered by; it
 * waits in the queue until its start, runs as one session on the person's cloud computer, and ends with a report with
 * a pass or fail per criterion, which the agent sends after asking a judge model from another lab (the server checks
 * that it asked, not what the judge said). Its states:
 * - `queued`      waiting for its start, a free computer and the plan's jobs at once;
 * - `running`     its session runs (and, once the agent reported, waits for its pass or fail per criterion);
 * - `reported`    the report is in (with a pass or fail per criterion, or without when no judge could be named);
 * - `incomplete`  the session ended with no report;
 * - `cancelled`   the person cancelled it, or the plan's queue was cancelled (ended plan, dispute, account deletion);
 * - `missed`      it could not start before the time it aimed to deliver by.
 */
export const JOB_STATES = ["queued", "running", "reported", "incomplete", "cancelled", "missed"] as const
export type JobState = (typeof JOB_STATES)[number]
/** The states a job no longer leaves. */
export const JOB_FINAL_STATES: readonly JobState[] = ["reported", "incomplete", "cancelled", "missed"]

/**
 * Why a job was cancelled or missed, or (for `incomplete`) why its session ended (`END_REASONS`): the person cancelled
 * it; the plan's queue was cancelled (`plan`, `frozen`, `closing`); it could not start in time because the plan's hours
 * or the month's usage ran out, the queue was paused or closed, or the plan no longer allowed it (`late`, `refused`).
 */
export const JOB_REASONS = ["cancelled", "plan", "frozen", "closing", "hours", "usage", "paused", "late", "refused"] as const
export type JobReason = (typeof JOB_REASONS)[number] | EndReason

/** The queue as the person's surfaces show it: open, waiting (a renewal or a pause by Vector), paused (a payment), closed. */
export const QUEUE_STATES = ["open", "waiting", "paused", "closed"] as const
export type QueueState = (typeof QUEUE_STATES)[number]

/** Job ids: `jb_` and 26 lower-case base32 letters. Recurring job ids: `jr_` and 26. */
const JOB_ID_START = /^jb_[a-z2-7]{26}/
const RECURRING_ID_START = /^jr_[a-z2-7]{26}/
export const JOB_ID = {
  test: (value: string) => typeof value === "string" && value.length === 29 && JOB_ID_START.test(value),
} as const
export const RECURRING_ID = {
  test: (value: string) => typeof value === "string" && value.length === 29 && RECURRING_ID_START.test(value),
} as const

/** A job's own words: at most this many characters, so the session's prompt (with the criteria and rules) fits. */
export const JOB_PROMPT_MAX = 24_000
/** Success criteria: at least one, at most this many, each at most `CRITERION_MAX` characters on one line. */
export const CRITERIA_MAX = 10
export const CRITERION_MAX = 300
/** Public pages a job may name (a recurring job must name at least one): https, port 443, at most 2,048 characters. */
export const PAGES_MAX = 5
export const PAGE_URL_MAX = 2_048
/** A job is queued for at most a day ahead and to deliver at least this long after it is queued. */
export const DELIVER_MIN_MS = 30 * 60_000
export const DELIVER_MAX_MS = 24 * 3_600_000
/** The shortest job, in minutes. */
export const JOB_MINUTES_MIN = 15
/**
 * The copy every surface uses for a job's time: Vector aims for it and promises nothing (H3). A job that cannot start
 * in time is `missed`, never started late.
 */
export const DELIVER_LABEL = "Aims to deliver by"

/** A report: a summary, links, an optional pull request to approve, and a pass or fail per criterion. */
export const SUMMARY_MAX = 4_000
export const LINKS_MAX = 20
export const LINK_TITLE_MAX = 120
export const NOTE_MAX = 500

/**
 * The report's recording: the last `RECORDING_SEGMENTS` one-minute segments of the job's screen (nothing of a
 * take-over is recorded), each at most `RECORDING_SEGMENT_MAX_BYTES`, kept `RECORDING_DAYS` days after the job ended and
 * shown only to the job's owner. A heartbeat reports at most `RECORDING_REPORT_MAX` segments at a time.
 */
export const RECORDING_SEGMENTS = 10
export const RECORDING_SEGMENT_MAX_BYTES = 32 * 1024 * 1024
export const RECORDING_DAYS = 30
export const RECORDING_REPORT_MAX = 3

/** A recurring job runs once on each chosen UTC weekday (0 = Sunday) at a UTC time of day (minutes after midnight). */
export type RecurringView = {
  id: string
  title?: string
  prompt: string
  criteria: string[]
  pages: string[]
  size: Size
  jobMinutes: number
  timeOfDay: number
  days: number[]
  createdAt: number
  nextAt: number
}

/**
 * A report as its owner sees it. `judge` names the model from another lab the agent was told to ask, when one could be
 * named; `results` are what the agent reported for each criterion (the server does not see the judge's answer).
 */
export type ReportView = {
  summary: string
  links: { title?: string; url: string }[]
  pullRequest?: string
  submittedAt: number
  judged: boolean
  judge?: { model: string; lab: string }
  results?: { criterion: string; pass: boolean; note?: string }[]
}

/** A job as its owner sees it: states, times, counts and its own words only, never an amount (P1). */
export type JobView = {
  id: string
  state: JobState
  reason?: JobReason
  title?: string
  prompt: string
  criteria: string[]
  pages?: string[]
  size: Size
  jobMinutes: number
  deliverBy: number
  startAfter: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  session?: string
  recurring?: string
  report?: ReportView
  recording?: { segments: number; until: number }
  approvedAt?: number
}
