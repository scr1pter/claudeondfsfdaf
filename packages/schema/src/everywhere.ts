export * as Everywhere from "./everywhere.js"

/*
 * Vector everywhere: the shapes the vectordev.ai intake, the jobs routes, the desktop runner and core share, with their
 * ids, size limits and cap defaults, and the decoders that hold them at every boundary. The contract is
 * docs/vector/build/vector-everywhere-spec.md (sections 3.3, 3.4 and 3.9).
 *
 * This module imports nothing and uses no runtime-specific API (only `globalThis.crypto.getRandomValues` and `URL`,
 * which Node, Bun, browsers and Workers all have), so api/, core and the desktop main process can all load it.
 *
 * Every decoder answers `{ok: false, error}` instead of throwing. An error names the field and a fixed reason and never
 * repeats the value it refused, so it can be logged as it stands.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------------------------------

export const PLATFORMS = ["github", "slack", "linear", "jira"] as const
export type PlatformId = (typeof PLATFORMS)[number]

/** What started an inbound trigger. Only the first four ever become jobs; `stop` and `command` act on the platform. */
export const TRIGGER_KINDS = ["mention", "assign", "dm", "followup", "stop", "command"] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]
const JOB_KINDS: readonly TriggerKind[] = ["mention", "assign", "dm", "followup"]

/** Who wrote a piece of context. Every one of them reaches the model as untrusted data. */
export const CONTEXT_SOURCES = ["requester", "teammate", "external", "bot", "platform"] as const
export type ContextSource = (typeof CONTEXT_SOURCES)[number]

/** Control words, accepted only from the requester's own message, parsed after the mention (3.1). */
export const CONTROL_WORDS = ["help", "link", "unlink", "status", "stop", "repo"] as const
export type ControlWord = (typeof CONTROL_WORDS)[number]

/** The fixed task for a delegation or assignment that carries no words of the requester's own. */
export const DELEGATION_TASK = { linear: "Work on this issue.", jira: "Work on this work item." } as const

export const ROUTES = ["laptop", "actions", "queue", "refuse"] as const
export type Route = (typeof ROUTES)[number]

/** Job states (3.4). The last six are terminal. */
export const JOB_STATES = [
  "received",
  "offered",
  "claimed",
  "running",
  "dispatched",
  "waiting",
  "settled",
  "refused",
  "expired",
  "failed",
  "lost",
  "cancelled",
] as const
export type JobState = (typeof JOB_STATES)[number]
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "settled",
  "refused",
  "expired",
  "failed",
  "lost",
  "cancelled",
])

export const MILESTONES = ["started", "reading", "editing", "testing", "pushing", "heartbeat"] as const
export type Milestone = (typeof MILESTONES)[number]

export const OUTCOMES = [
  "changes",
  "no-changes",
  "failed",
  "refused",
  "needs-approval",
  "over-budget",
  "cancelled",
  "interrupted",
  "held",
  "expired",
] as const
export type Outcome = (typeof OUTCOMES)[number]

export const REPLY_FORMATS = ["slack", "markdown", "jira"] as const
export type ReplyFormat = (typeof REPLY_FORMATS)[number]
/** How each platform's replies are written: Slack mrkdwn, Markdown, or Jira plain text. */
export const REPLY_FORMAT: Readonly<Record<PlatformId, ReplyFormat>> = {
  github: "markdown",
  slack: "slack",
  linear: "markdown",
  jira: "jira",
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusal and decline codes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Why a computer turned an offered or claimed job down (3.4 step 5a, 3.5 steps 2 and 3, 4.1 item 1). `busy` and
 * `trigger-changed` let the router move on (to Actions, the queue, or for a GitHub handoff `handled: false`); the
 * others are lasting, and when every computer gives one the job is refused with that reason's own text.
 */
export const DECLINE_CODES = [
  "busy",
  "trigger-changed",
  "not-mapped",
  "local-mode",
  "off",
  "model-not-allowed",
] as const
export type DeclineCode = (typeof DECLINE_CODES)[number]
export const LASTING_DECLINES: ReadonlySet<DeclineCode> = new Set<DeclineCode>([
  "not-mapped",
  "local-mode",
  "off",
  "model-not-allowed",
])

/** Why the server made no job, or ended one before it ran. Each has one fixed text (VE-02 `renderRefusal`). */
export const REFUSAL_CODES = [
  /** The global or platform switch is off (3.4 step 1). */
  "switched-off",
  /** The requester has no link; answered with the private link prompt (3.4 step 2). */
  "not-linked",
  /** A Slack Connect user from another organisation (3.8). */
  "external",
  /** A Slack guest (3.8). */
  "guest",
  /** Any bot. */
  "bot",
  /** A Jira automation, a Linear app user: no person behind the request (3.8). */
  "automation",
  /** The installation is unknown or nobody connected it (a Jira site before its connect code, 4.4). */
  "not-connected",
  /** A link code sent in a shared place: refused and burned (3.8). */
  "shared-place",
  /** A link code that is unknown, used or expired. */
  "link-invalid",
  /** The sponsor's plan has no `everywhere` perk (3.4 step 3). */
  "not-in-plan",
  /** The sponsor does not allow this requester (3.9). */
  "not-allowed",
  /** A server cap is full (3.9). */
  "over-limit",
  /** No computer, no Actions route and no queue (3.4 step 7). */
  "no-place",
  /** A public repository on the Actions route (3.6). */
  "public-repository",
  /** Lasting declines from every computer (3.4 step 5a). */
  "not-mapped",
  "local-mode",
  "off",
  "model-not-allowed",
  /** A call the platform may make that Vector everywhere does not take (Rovo chat beyond `link`, streaming). */
  "unsupported",
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

// ---------------------------------------------------------------------------------------------------------------------
// Ids and their patterns
// ---------------------------------------------------------------------------------------------------------------------

/** Lowercase Crockford base32: in ASCII order, so ids sort as their times do, and safe in branch names. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
const BASE32 = "[0-9a-hjkmnp-tv-z]"

export const JOB_ID_PREFIX = "vej_"
/** `vej_`, then 10 characters of the creation time in milliseconds, then 12 random characters (60 bits). */
export const JOB_ID_PATTERN = new RegExp(`^vej_${BASE32}{22}$`)
/** Lease ids and offer `jti`s: 26 random characters (130 bits). */
export const RANDOM_ID_PATTERN = new RegExp(`^${BASE32}{26}$`)
/** Codium Remote's device ids (16 random bytes, base64url), which a computer names itself by on the jobs routes. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/
/** Vector account ids, as `requireAccountUser` accepts them. */
export const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `owner/name` as @vector checks it before it writes a repository into the system layer, so no newline gets in. */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
/** A Linear identifier ("ENG-123") or a Jira key ("PROJ-123"). */
export const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,9}-[0-9]{1,7}$/
/** `vector/ve-<12 characters of the jid>`, or `vector/ve-<issue key>-<8 characters of the jid>` for Linear and Jira. */
export const BRANCH_PATTERN = /^vector\/ve-(?:[0-9a-z]{12}|[A-Za-z][A-Za-z0-9_]{0,9}-[0-9]{1,7}-[0-9a-z]{8})$/
/** A pull request on github.com; the first group is the repository. */
export const PR_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100})\/pull\/[1-9][0-9]{0,9}$/
/** A commit id: SHA-1, or SHA-256 for repositories that use it. */
export const HEAD_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** A permission id such as `bash` or `webfetch`: never a pattern, a path or a command. */
export const PERMISSION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** The offer signing key's id, from VECTOR_EVERYWHERE_OFFER_KEY_ID. */
export const OFFER_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const SLACK_ID = "[A-Z0-9]{2,20}"

/**
 * Installation keys (1). Slack: `slack:E…:T…` for a workspace in an Enterprise Grid organisation, `slack:T…` for a
 * workspace on its own, `slack:E…` for an organisation-wide install. Linear organisation ids and Jira cloud ids are
 * UUIDs; GitHub installation ids are numbers.
 */
export const INSTALLATION_PATTERNS: Readonly<Record<PlatformId, RegExp>> = {
  github: /^github:[1-9][0-9]{0,15}$/,
  slack: new RegExp(`^slack:(?:E${SLACK_ID}:T${SLACK_ID}|T${SLACK_ID}|E${SLACK_ID})$`),
  linear: new RegExp(`^linear:${UUID}$`),
  jira: new RegExp(`^jira:${UUID}$`),
}

/** Where a thread link may point for each platform. */
const THREAD_HOSTS: Readonly<Record<PlatformId, (host: string) => boolean>> = {
  github: (host) => host === "github.com",
  slack: (host) => host === "slack.com" || host.endsWith(".slack.com"),
  linear: (host) => host === "linear.app",
  jira: (host) => host.endsWith(".atlassian.net"),
}

function randomChars(count: number) {
  // 256 is a multiple of 32, so masking each byte keeps every character equally likely.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(count))
  let out = ""
  for (const byte of bytes) out += ALPHABET.charAt(byte & 31)
  return out
}

/** A new job id. Ids made later sort after earlier ones, to the millisecond. */
export function createJobId(now: number = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 50) throw new RangeError("A job id needs a time in ms.")
  let time = ""
  let rest = now
  for (let index = 0; index < 10; index++) {
    time = ALPHABET.charAt(rest % 32) + time
    rest = Math.floor(rest / 32)
  }
  return `${JOB_ID_PREFIX}${time}${randomChars(12)}`
}

/** A lease id or an offer `jti`. */
export function randomId() {
  return randomChars(26)
}

export function isPlatform(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value)
}

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value)
}

export function isIssueKey(value: unknown): value is string {
  return typeof value === "string" && ISSUE_KEY_PATTERN.test(value)
}

export function isBranch(value: unknown): value is string {
  return typeof value === "string" && BRANCH_PATTERN.test(value)
}

export function isRepositoryName(value: unknown): value is string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) return false
  const name = value.slice(value.indexOf("/") + 1)
  return name !== "." && name !== ".."
}

/** Canonical display link only: ids and repository names never become an arbitrary host or URL. No I/O. */
export function githubThreadUrl(repository: unknown, kind: unknown, number: unknown): string | undefined {
  if (!isRepositoryName(repository) || (kind !== "issue" && kind !== "pr") || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined
  return `https://github.com/${repository}/${kind === "pr" ? "pull" : "issues"}/${number}`
}

/** The platform an installation key belongs to, when it is well formed. */
export function installationPlatform(key: unknown): PlatformId | undefined {
  if (typeof key !== "string") return undefined
  return PLATFORMS.find((platform) => INSTALLATION_PATTERNS[platform].test(key))
}

/** Whether `url` is an https link on `platform`'s own host, with no user name or password in it. */
export function threadUrlAllowed(platform: PlatformId, url: string) {
  if (url.length > LIMITS.urlChars) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    THREAD_HOSTS[platform](parsed.hostname)
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------------------------------------------------

export const OFFER_PREFIX = "vef1."
export const OFFER_AUDIENCE = "vector-everywhere-offer"
/** The Ed25519 signature covers this prefix followed by the payload (3.3). */
export const OFFER_SIGNING_PREFIX = "vector-everywhere-offer-v1."
/** `vef1.<base64url JSON claims>.<base64url Ed25519 signature>`; an Ed25519 signature is 64 bytes, 86 characters. */
export const OFFER_PATTERN = /^vef1\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{86})$/

/**
 * The parts of an offer string, before any check of its signature: `signed` is what the signature must cover. The
 * caller verifies the signature against a pinned key, then decodes `payload` and passes it to `decodeOfferClaims`.
 */
export function offerParts(offer: unknown): { payload: string; signature: string; signed: string } | undefined {
  if (typeof offer !== "string") return undefined
  const match = OFFER_PATTERN.exec(offer)
  if (!match) return undefined
  const payload = match[1] ?? ""
  const signature = match[2] ?? ""
  return { payload, signature, signed: `${OFFER_SIGNING_PREFIX}${payload}` }
}

// ---------------------------------------------------------------------------------------------------------------------
// Size limits, timings and cap defaults
// ---------------------------------------------------------------------------------------------------------------------

/** Lengths are JavaScript string lengths (UTF-16 code units). */
export const LIMITS = {
  /** One context item's text. */
  itemChars: 4_000,
  /** The requester's own words. */
  taskChars: 8_000,
  contextItems: 30,
  /** All context items' text together. */
  contextChars: 24_000,
  /** A settle summary, posting-checked on the computer. */
  summaryChars: 1_500,
  requesterLabelChars: 64,
  threadRefChars: 512,
  urlChars: 2_048,
  deliveryIdChars: 200,
  userIdChars: 128,
  /** Permission ids a `needs-approval` settle may list. */
  needs: 32,
  /** The largest file count a report or settle may carry. */
  files: 100_000,
  /** The largest reply a job may ask for. */
  replyChars: 40_000,
  /** Messages of a Slack thread read for one mention (Q5). */
  threadMessages: 15,
} as const

/** The largest request body each intake reads (3.2 step 1); GitHub's is the handoff call. */
export const BODY_LIMITS: Readonly<Record<PlatformId, number>> = {
  github: 16 * 1024,
  slack: 256 * 1024,
  linear: 1024 * 1024,
  jira: 1024 * 1024,
}

const MINUTE = 60_000

/** Job timings in milliseconds (3.3, 3.4, 3.5, 4.4). */
export const TIMING = {
  /** How long an offer may live: `exp − iat`. */
  offerTtlMs: 30_000,
  /** How long the router waits for a claim after offering. */
  offerWindowMs: 20_000,
  /** How long a used offer `jti` is remembered. */
  offerReplayMs: 60 * MINUTE,
  leaseMs: 5 * MINUTE,
  heartbeatMs: MINUTE,
  /** Reports go at most this often, or on a milestone change. */
  reportEveryMs: 30_000,
  /** How long a job body is kept. */
  bodyTtlMs: 120 * MINUTE,
  /** How long a job may wait for the computer: always less than the body lives. */
  queueMs: 115 * MINUTE,
  jiraQueueMs: 10 * MINUTE,
  jiraRunMs: 35 * MINUTE,
  /** A Jira job is closed by then, whatever it is doing; the Jira task itself ends at 60 minutes. */
  jiraEndMs: 50 * MINUTE,
  /** A dispatch whose start hook has not come by then fails (the ticket TTL). */
  dispatchStartMs: 900_000,
  /** How often a computer that wants jobs asks for waiting ones. */
  pendingEveryMs: 5 * MINUTE,
} as const

/** Server caps, all checked before a job starts (3.9). */
export const SERVER_CAPS = {
  sponsorPerDay: 30,
  sponsorLive: 3,
  requesterPerHour: 6,
  installationPerDay: 200,
} as const

/**
 * A computer's own caps (3.9): the default and the highest value its settings accept. Dollars must be above 0; the
 * rest are whole numbers from 1. The runner applies the lower of these and the job's `limits`.
 */
export const COMPUTER_CAPS = {
  maxUsd: { default: 2, max: 50 },
  minutes: { default: 45, max: 120 },
  atOnce: { default: 1, max: 3 },
  perDay: { default: 20, max: 100 },
} as const

/** The step budget an unattended prompt carries (3.5 step 6). */
export const RUN_STEPS = 200

// ---------------------------------------------------------------------------------------------------------------------
// The envelope (3.3)
// ---------------------------------------------------------------------------------------------------------------------

export type UntrustedItem = {
  readonly from: "requester" | "teammate" | "external" | "bot" | "platform"
  readonly text: string // ≤ 4,000 chars each
}

/** What an adapter hands the intake after verify, filter and parse. */
export type InboundTrigger = {
  readonly platform: PlatformId
  readonly installation: string // "slack:E…:T…", "linear:<org>", "jira:<cloudId>", "github:<id>"
  readonly deliveryId: string
  readonly actor: {
    readonly userId: string
    readonly external: boolean
    readonly guest: boolean
    readonly bot: boolean
  }
  readonly kind: "mention" | "assign" | "dm" | "followup" | "stop" | "command"
  readonly thread: { readonly ref: string; readonly url?: string } // platform reference, never shown to the model as an instruction
  readonly task: string // ≤ 8,000 chars
  readonly context: readonly UntrustedItem[] // ≤ 30 items, ≤ 24,000 chars in all
  readonly repository?: { readonly fullName?: string; readonly id?: number }
  readonly github?: { readonly kind: "issue" | "pr"; readonly number: number; readonly commentId?: number }
  readonly issue?: { readonly key: string } // Linear identifier or Jira key, for branch and PR title
  readonly shared: boolean // the destination is a shared place (1)
}

/** What a computer receives when it claims a job. */
export type EverywhereJob = {
  readonly v: 1
  readonly jid: string // vej_…
  readonly platform: PlatformId
  readonly kind: InboundTrigger["kind"]
  readonly requester: { readonly label: string; readonly self: boolean } // label ≤ 64 chars, sanitized; never placed in the task
  readonly repository: { readonly id: number; readonly fullName: string; readonly shared: boolean } // shared: a public repository
  readonly issue?: { readonly key: string } // Linear identifier ("ENG-123") or Jira key ("PROJ-123")
  readonly task: string
  readonly context: readonly UntrustedItem[]
  readonly github?: InboundTrigger["github"] // GitHub jobs carry a reference only
  readonly limits: { readonly maxUsd: number; readonly minutes: number; readonly deadline: number } // the computer applies the lower of these and its own caps
  readonly reply: { readonly format: "slack" | "markdown" | "jira"; readonly maxChars: number }
  readonly lease: { readonly id: string; readonly expiresAt: number }
}

export type Report = {
  readonly jid: string
  readonly lease: string
  readonly seq: number
  readonly milestone: (typeof MILESTONES)[number]
  readonly files?: number // counts only
}

export type Settle = {
  readonly jid: string
  readonly lease: string
  readonly outcome: (typeof OUTCOMES)[number] // "held": changes kept on the computer (secret scan, posting check or Q8)
  readonly summary?: string // ≤ 1,500 chars, posting-checked on the computer (headless)
  readonly needs?: readonly string[] // permission ids only (e.g. "bash"), never patterns or commands
  readonly branch?: string // "vector/ve-<12 chars of jid>" or "vector/ve-<issue key>-<8 chars of jid>"
  readonly prUrl?: string // https://github.com/<repository.fullName>/pull/<n>, checked by the server
  readonly headSha?: string
  readonly files?: number
  readonly checks?: "skipped" // the commit carries [skip ci]
}

/** Times are milliseconds since the epoch, as Vector's other signed tokens use. */
export type OfferClaims = {
  readonly v: 1
  readonly kid: string
  readonly aud: "vector-everywhere-offer"
  readonly sub: string // Vector account id
  readonly jid: string
  readonly iat: number
  readonly exp: number
  readonly jti: string // exp − iat ≤ 30 s
}

/** `POST /api/everywhere/jobs/claim`. */
export type Claim = { readonly jid: string; readonly device: string }

/** `POST /api/everywhere/jobs/decline`. A decline after a claim (for example `not-mapped`) names its lease. */
export type Decline = {
  readonly jid: string
  readonly device: string
  readonly reason: DeclineCode
  readonly lease?: string
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers shared by the decoders, the server and the runner
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A display name as it may be shown: letters, marks, digits, spaces and `.`, `_`, `'`, `’` and `-` only, so it can
 * carry no mention, markup, link, control or direction-changing character; whitespace collapsed; at most 64
 * characters. A name with nothing left becomes "Requester".
 */
export function sanitizeLabel(value: string) {
  const cleaned = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}\s._'’-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  let out = ""
  for (const character of cleaned) {
    if (out.length + character.length > LIMITS.requesterLabelChars) break
    out += character
  }
  out = out.trim()
  return out === "" ? "Requester" : out
}

/**
 * Text that holds a fenced code block or looks like a diff: a hunk header, a file header pair, or `diff --git`. Every
 * line end a renderer honours counts (CR, CRLF, U+0085, U+2028, U+2029), invisible format and control characters are
 * ignored, and a line may start with spaces, so none of them can hide a diff from the settle decoder (E4).
 */
export function looksLikeCode(value: string) {
  const text = value
    .replace(/\r\n?|[\u0085\u2028\u2029\u000b\u000c]/g, "\n")
    .replace(/[\p{Cf}\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/gu, "")
  return (
    /(?:^|\n)[^\S\n]*(?:```|~~~)/.test(text) ||
    /(?:^|\n)[^\S\n]*@@[ \t]/.test(text) ||
    /(?:^|\n)[^\S\n]*--- [^\n]*\n[^\S\n]*\+\+\+ /.test(text) ||
    /(?:^|\n)[^\S\n]*diff --git /.test(text)
  )
}

/** The total text length of a context list. */
export function contextChars(context: readonly UntrustedItem[]) {
  let total = 0
  for (const item of context) total += item.text.length
  return total
}

// ---------------------------------------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------------------------------------

export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

// Plain fields rather than a parameter property, so the module also loads where TypeScript is only stripped.
class Refusal {
  readonly error: string
  constructor(error: string) {
    this.error = error
  }
}

function refuse(path: string, reason: string): never {
  throw new Refusal(`${path}: ${reason}`)
}

function run<T>(decode: () => T): Decoded<T> {
  try {
    return { ok: true, value: decode() }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.error }
    throw error
  }
}

type Fields = Record<string, unknown>

function object(value: unknown, path: string, keys?: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(path, "not an object")
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) refuse(path, "not a plain object")
  // The field's name is never repeated: it is the sender's text.
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(path, "unknown field")
  return value as Fields
}

/** An own field; an absent field and one set to undefined both read as undefined. */
function field(fields: Fields, key: string) {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined
}

function string(value: unknown, path: string, max: number, min = 0): string {
  if (typeof value !== "string") refuse(path, "not a string")
  if (value.length > max) refuse(path, "too long")
  if (value.length < min) refuse(path, min === 1 ? "empty" : "too short")
  return value
}

function matching(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string") refuse(path, "not a string")
  if (!pattern.test(value)) refuse(path, "malformed")
  return value
}

function integer(value: unknown, path: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) refuse(path, "not a whole number")
  if (value < min || value > max) refuse(path, "out of range")
  return value
}

function positive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(path, "not a number")
  if (value <= 0) refuse(path, "out of range")
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") refuse(path, "not a boolean")
  return value
}

function member<T extends string>(value: unknown, path: string, list: readonly T[]): T {
  if (typeof value !== "string" || !(list as readonly string[]).includes(value)) refuse(path, "not allowed")
  return value as T
}

/** Printable ASCII with no spaces: platform ids and delivery ids. */
const TOKEN = /^[\x21-\x7e]+$/
/** Control characters, which no single-line reference may hold. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function context(value: unknown, path: string): UntrustedItem[] {
  if (!Array.isArray(value)) refuse(path, "not a list")
  if (value.length > LIMITS.contextItems) refuse(path, "too many items")
  let total = 0
  const items = value.map((entry: unknown, index): UntrustedItem => {
    const at = `${path}[${index}]`
    const item = object(entry, at, ["from", "text"])
    const from = member(field(item, "from"), `${at}.from`, CONTEXT_SOURCES)
    const text = string(field(item, "text"), `${at}.text`, LIMITS.itemChars)
    total += text.length
    return { from, text }
  })
  if (total > LIMITS.contextChars) refuse(path, "too long")
  return items
}

function issue(value: unknown, path: string, platform: PlatformId): { key: string } | undefined {
  if (value === undefined) return undefined
  if (platform !== "linear" && platform !== "jira") refuse(path, "not allowed")
  const fields = object(value, path, ["key"])
  return { key: matching(field(fields, "key"), `${path}.key`, ISSUE_KEY_PATTERN) }
}

function githubReference(value: unknown, path: string, platform: PlatformId): InboundTrigger["github"] {
  if (platform !== "github") {
    if (value !== undefined) refuse(path, "not allowed")
    return undefined
  }
  if (value === undefined) refuse(path, "required")
  const fields = object(value, path, ["kind", "number", "commentId"])
  const kind = member(field(fields, "kind"), `${path}.kind`, ["issue", "pr"] as const)
  const number = integer(field(fields, "number"), `${path}.number`, 1)
  const commentId = field(fields, "commentId")
  return commentId === undefined
    ? { kind, number }
    : { kind, number, commentId: integer(commentId, `${path}.commentId`, 1) }
}

function repositoryName(value: unknown, path: string): string {
  if (!isRepositoryName(value)) refuse(path, "malformed")
  return value
}

/**
 * GitHub thread text never reaches Vector's servers (4.1): the laptop reads the thread itself, so a GitHub trigger or
 * job carries a reference and no text.
 */
function noGithubText(platform: PlatformId, task: string, items: readonly UntrustedItem[]) {
  if (platform !== "github") return
  if (task !== "") refuse("task", "not allowed")
  if (items.length > 0) refuse("context", "not allowed")
}

const TRIGGER_KEYS = [
  "platform",
  "installation",
  "deliveryId",
  "actor",
  "kind",
  "thread",
  "task",
  "context",
  "repository",
  "github",
  "issue",
  "shared",
] as const

/** An adapter's parsed trigger, before the intake acts on it. Unknown fields are refused. */
export function decodeInboundTrigger(input: unknown): Decoded<InboundTrigger> {
  return run(() => {
    const fields = object(input, "trigger", TRIGGER_KEYS)
    const platform = member(field(fields, "platform"), "platform", PLATFORMS)
    const installation = matching(field(fields, "installation"), "installation", INSTALLATION_PATTERNS[platform])
    const deliveryId = matching(
      string(field(fields, "deliveryId"), "deliveryId", LIMITS.deliveryIdChars, 1),
      "deliveryId",
      TOKEN,
    )

    const actorFields = object(field(fields, "actor"), "actor", ["userId", "external", "guest", "bot"])
    const actor = {
      userId: matching(
        string(field(actorFields, "userId"), "actor.userId", LIMITS.userIdChars, 1),
        "actor.userId",
        TOKEN,
      ),
      external: boolean(field(actorFields, "external"), "actor.external"),
      guest: boolean(field(actorFields, "guest"), "actor.guest"),
      bot: boolean(field(actorFields, "bot"), "actor.bot"),
    }

    const kind = member(field(fields, "kind"), "kind", TRIGGER_KINDS)

    const threadFields = object(field(fields, "thread"), "thread", ["ref", "url"])
    const ref = string(field(threadFields, "ref"), "thread.ref", LIMITS.threadRefChars, 1)
    if (CONTROL.test(ref)) refuse("thread.ref", "malformed")
    const url = field(threadFields, "url")
    if (url !== undefined && (typeof url !== "string" || !threadUrlAllowed(platform, url)))
      refuse("thread.url", "not allowed")
    const thread = url === undefined ? { ref } : { ref, url: url as string }

    const task = string(field(fields, "task"), "task", LIMITS.taskChars)
    const items = context(field(fields, "context"), "context")
    noGithubText(platform, task, items)

    let repository: InboundTrigger["repository"]
    const repositoryValue = field(fields, "repository")
    if (repositoryValue !== undefined) {
      const repositoryFields = object(repositoryValue, "repository", ["fullName", "id"])
      const fullName = field(repositoryFields, "fullName")
      const id = field(repositoryFields, "id")
      repository = {
        ...(fullName === undefined ? {} : { fullName: repositoryName(fullName, "repository.fullName") }),
        ...(id === undefined ? {} : { id: integer(id, "repository.id", 1) }),
      }
    }

    const github = githubReference(field(fields, "github"), "github", platform)
    const issueKey = issue(field(fields, "issue"), "issue", platform)
    const shared = boolean(field(fields, "shared"), "shared")

    return {
      platform,
      installation,
      deliveryId,
      actor,
      kind,
      thread,
      task,
      context: items,
      ...(repository ? { repository } : {}),
      ...(github ? { github } : {}),
      ...(issueKey ? { issue: issueKey } : {}),
      shared,
    }
  })
}

/**
 * A claimed job, as the computer reads it. The server may add optional fields in a later version, so fields this
 * decoder does not know are dropped rather than refused; the runner only ever reads the object this returns.
 */
export function decodeJob(input: unknown): Decoded<EverywhereJob> {
  return run(() => {
    const fields = object(input, "job")
    if (field(fields, "v") !== 1) refuse("v", "not allowed")
    const jid = matching(field(fields, "jid"), "jid", JOB_ID_PATTERN)
    const platform = member(field(fields, "platform"), "platform", PLATFORMS)
    // A stop or a control word never becomes a job.
    const kind = member(field(fields, "kind"), "kind", JOB_KINDS)

    const requesterFields = object(field(fields, "requester"), "requester")
    const label = string(field(requesterFields, "label"), "requester.label", LIMITS.requesterLabelChars, 1)
    if (sanitizeLabel(label) !== label) refuse("requester.label", "not sanitized")
    const requester = { label, self: boolean(field(requesterFields, "self"), "requester.self") }

    const repositoryFields = object(field(fields, "repository"), "repository")
    const repository = {
      id: integer(field(repositoryFields, "id"), "repository.id", 1),
      fullName: repositoryName(field(repositoryFields, "fullName"), "repository.fullName"),
      shared: boolean(field(repositoryFields, "shared"), "repository.shared"),
    }

    const issueKey = issue(field(fields, "issue"), "issue", platform)
    const task = string(field(fields, "task"), "task", LIMITS.taskChars)
    // A job never starts with an empty task, except a GitHub job, whose task the laptop reads from the thread.
    if (platform !== "github" && task.trim() === "") refuse("task", "empty")
    const items = context(field(fields, "context"), "context")
    noGithubText(platform, task, items)
    const github = githubReference(field(fields, "github"), "github", platform)

    // The computer applies the lower of these and its own caps, so a higher server value is read, not refused.
    const limitFields = object(field(fields, "limits"), "limits")
    const limits = {
      maxUsd: positive(field(limitFields, "maxUsd"), "limits.maxUsd"),
      minutes: positive(field(limitFields, "minutes"), "limits.minutes"),
      deadline: integer(field(limitFields, "deadline"), "limits.deadline", 1),
    }

    const replyFields = object(field(fields, "reply"), "reply")
    const format = member(field(replyFields, "format"), "reply.format", REPLY_FORMATS)
    if (format !== REPLY_FORMAT[platform]) refuse("reply.format", "not allowed")
    const reply = { format, maxChars: integer(field(replyFields, "maxChars"), "reply.maxChars", 1, LIMITS.replyChars) }

    const leaseFields = object(field(fields, "lease"), "lease")
    const lease = {
      id: matching(field(leaseFields, "id"), "lease.id", RANDOM_ID_PATTERN),
      expiresAt: integer(field(leaseFields, "expiresAt"), "lease.expiresAt", 1),
    }

    return {
      v: 1 as const,
      jid,
      platform,
      kind,
      requester,
      repository,
      ...(issueKey ? { issue: issueKey } : {}),
      task,
      context: items,
      ...(github ? { github } : {}),
      limits,
      reply,
      lease,
    }
  })
}

/** A milestone report or heartbeat: ids, a milestone and a count. Any other field, text above all, is refused. */
export function decodeReport(input: unknown): Decoded<Report> {
  return run(() => {
    const fields = object(input, "report", ["jid", "lease", "seq", "milestone", "files"])
    const files = field(fields, "files")
    return {
      jid: matching(field(fields, "jid"), "jid", JOB_ID_PATTERN),
      lease: matching(field(fields, "lease"), "lease", RANDOM_ID_PATTERN),
      seq: integer(field(fields, "seq"), "seq", 0),
      milestone: member(field(fields, "milestone"), "milestone", MILESTONES),
      ...(files === undefined ? {} : { files: integer(files, "files", 0, LIMITS.files) }),
    }
  })
}

const SETTLE_KEYS = [
  "jid",
  "lease",
  "outcome",
  "summary",
  "needs",
  "branch",
  "prUrl",
  "headSha",
  "files",
  "checks",
] as const

/**
 * A job's result from the computer. It carries a short summary and links, never code or pull request text: unknown
 * fields (a PR title or body among them) are refused, and so is a summary over 1,500 characters or one that looks like
 * code. With `expect.repository`, a PR URL on any other repository is refused.
 */
export function decodeSettle(input: unknown, expect: { readonly repository?: string } = {}): Decoded<Settle> {
  return run(() => {
    const fields = object(input, "settle", SETTLE_KEYS)
    const jid = matching(field(fields, "jid"), "jid", JOB_ID_PATTERN)
    const lease = matching(field(fields, "lease"), "lease", RANDOM_ID_PATTERN)
    const outcome = member(field(fields, "outcome"), "outcome", OUTCOMES)

    const summaryValue = field(fields, "summary")
    let summary: string | undefined
    if (summaryValue !== undefined) {
      summary = string(summaryValue, "summary", LIMITS.summaryChars)
      if (looksLikeCode(summary)) refuse("summary", "looks like code")
    }

    const needsValue = field(fields, "needs")
    let needs: string[] | undefined
    if (needsValue !== undefined) {
      if (!Array.isArray(needsValue)) refuse("needs", "not a list")
      if (needsValue.length > LIMITS.needs) refuse("needs", "too many items")
      needs = needsValue.map((entry: unknown, index) => matching(entry, `needs[${index}]`, PERMISSION_ID_PATTERN))
    }

    const branchValue = field(fields, "branch")
    const branch = branchValue === undefined ? undefined : matching(branchValue, "branch", BRANCH_PATTERN)

    const prUrlValue = field(fields, "prUrl")
    let prUrl: string | undefined
    if (prUrlValue !== undefined) {
      prUrl = matching(prUrlValue, "prUrl", PR_URL_PATTERN)
      const repository = PR_URL_PATTERN.exec(prUrl)?.[1] ?? ""
      if (!isRepositoryName(repository)) refuse("prUrl", "malformed")
      // GitHub owner and repository names are case-insensitive.
      if (expect.repository !== undefined && repository.toLowerCase() !== expect.repository.toLowerCase())
        refuse("prUrl", "other repository")
    }

    const headShaValue = field(fields, "headSha")
    const headSha = headShaValue === undefined ? undefined : matching(headShaValue, "headSha", HEAD_SHA_PATTERN)
    const filesValue = field(fields, "files")
    const files = filesValue === undefined ? undefined : integer(filesValue, "files", 0, LIMITS.files)
    const checksValue = field(fields, "checks")
    const checks = checksValue === undefined ? undefined : member(checksValue, "checks", ["skipped"] as const)

    return {
      jid,
      lease,
      outcome,
      ...(summary === undefined ? {} : { summary }),
      ...(needs === undefined ? {} : { needs }),
      ...(branch === undefined ? {} : { branch }),
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(files === undefined ? {} : { files }),
      ...(checks === undefined ? {} : { checks }),
    }
  })
}

/**
 * An offer's claims, after its signature checked out. This holds the shape and the 30-second life; the verifier still
 * checks `kid` against its pinned keys, `sub` against its own account, `exp` against its clock and `jti` against the
 * offers it has seen.
 */
export function decodeOfferClaims(input: unknown): Decoded<OfferClaims> {
  return run(() => {
    const fields = object(input, "offer", ["v", "kid", "aud", "sub", "jid", "iat", "exp", "jti"])
    if (field(fields, "v") !== 1) refuse("v", "not allowed")
    if (field(fields, "aud") !== OFFER_AUDIENCE) refuse("aud", "not allowed")
    const iat = integer(field(fields, "iat"), "iat", 0)
    const exp = integer(field(fields, "exp"), "exp", 0)
    if (exp <= iat || exp - iat > TIMING.offerTtlMs) refuse("exp", "out of range")
    return {
      v: 1 as const,
      kid: matching(field(fields, "kid"), "kid", OFFER_KEY_ID_PATTERN),
      aud: OFFER_AUDIENCE,
      sub: matching(field(fields, "sub"), "sub", ACCOUNT_ID_PATTERN),
      jid: matching(field(fields, "jid"), "jid", JOB_ID_PATTERN),
      iat,
      exp,
      jti: matching(field(fields, "jti"), "jti", RANDOM_ID_PATTERN),
    }
  })
}

export function decodeClaim(input: unknown): Decoded<Claim> {
  return run(() => {
    const fields = object(input, "claim", ["jid", "device"])
    return {
      jid: matching(field(fields, "jid"), "jid", JOB_ID_PATTERN),
      device: matching(field(fields, "device"), "device", DEVICE_ID_PATTERN),
    }
  })
}

export function decodeDecline(input: unknown): Decoded<Decline> {
  return run(() => {
    const fields = object(input, "decline", ["jid", "device", "reason", "lease"])
    const lease = field(fields, "lease")
    return {
      jid: matching(field(fields, "jid"), "jid", JOB_ID_PATTERN),
      device: matching(field(fields, "device"), "device", DEVICE_ID_PATTERN),
      reason: member(field(fields, "reason"), "reason", DECLINE_CODES),
      ...(lease === undefined ? {} : { lease: matching(lease, "lease", RANDOM_ID_PATTERN) }),
    }
  })
}
