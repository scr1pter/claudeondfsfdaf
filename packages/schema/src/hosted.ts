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
}

/**
 * The computer's daemon's report (`POST …/heartbeat`). Counters are cumulative for the session; the server works out
 * what changed. `archiveBytes` answers a download request with the size of the packed files.
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
  /** Where to upload the packed files, when the person asked for them. */
  upload?: { url: string; headers: Record<string, string>; expiresAt: number }
}
