import {
  ACCOUNT_ID_PATTERN,
  DEVICE_ID_PATTERN,
  JOB_ID_PATTERN,
  PLATFORMS,
  RANDOM_ID_PATTERN,
  TIMING,
  installationPlatform,
  type PlatformId,
} from "../../../packages/schema/src/everywhere.js"
import { ApiError } from "../http.js"
import { sha256Hex } from "./signature.js"

/*
 * Every store key Vector everywhere uses (contract 3.13), with how long each is kept. Keys start with
 * `vector:everywhere:` and are built only here, so everywhere code never reads or writes another feature's records.
 * Every part is checked against the shape its id has; a part that is not well formed is refused, so two different
 * records can never share a key.
 */

export const EVERYWHERE_PREFIX = "vector:everywhere:"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long each kind of record is kept, in milliseconds. Records with no entry are kept until changed or erased. */
export const KEEP_MS = {
  linkCode: 10 * MINUTE,
  connectCode: 10 * MINUTE,
  state: 10 * MINUTE,
  /** VE-04: failed link code attempts by one platform user are counted for an hour. */
  linkTries: HOUR,
  job: 30 * DAY,
  jobBody: TIMING.bodyTtlMs,
  ready: DAY,
  handoff: DAY,
  deliveryPending: MINUTE,
  deliveryDone: 7 * DAY,
  offer: TIMING.offerReplayMs,
  seen: 30 * DAY,
  ticket: DAY,
  jiraTask: 2 * DAY,
  audit: 90 * DAY,
} as const

/** The audit log keeps at most this many entries per account. */
export const AUDIT_MAX_ENTRIES = 1_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_HEX = /^[0-9a-f]{64}$/
/** Ids a platform or a peer chooses whose shape is not pinned: kept when plain, hashed otherwise. */
const PLAIN_PART = /^[A-Za-z0-9._-]{1,128}$/

/** Platform user ids. Slack `U…`/`W…`, Linear UUIDs, Jira account ids (which may hold a colon), GitHub numbers. */
export const USER_ID_PATTERNS: Readonly<Record<PlatformId, RegExp>> = {
  github: /^[1-9][0-9]{0,15}$/,
  slack: /^[A-Z0-9]{2,32}$/,
  linear: UUID,
  jira: /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64})?$/,
}

/** A place an installation maps to repositories: a Slack channel, a Linear team id, a Jira project key. */
const PLACE = /^[A-Za-z0-9_-]{1,128}$/
/** An OAuth state id (3.8): random, URL-safe. */
const STATE_ID = /^[A-Za-z0-9_-]{16,128}$/
/** A cap counter's window: a UTC day (`d20261111`) or hour (`h2026111114`). */
const COUNT_WINDOW = /^(?:d[0-9]{8}|h[0-9]{10})$/
/** @vector's ticket hash (R-A1), hex or base64url. */
const TICKET_HASH = /^[A-Za-z0-9_-]{16,128}$/

function invalid(): never {
  throw new ApiError(400, "EVERYWHERE_INVALID_ID", "An id in this request is not valid.")
}

function key(...parts: readonly string[]) {
  for (const part of parts) if (!part || /[\s\x00-\x1f\x7f]/.test(part)) invalid()
  return `${EVERYWHERE_PREFIX}${parts.join(":")}`
}

function account(value: string) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) invalid()
  return value.toLowerCase()
}

function installation(value: string) {
  if (!installationPlatform(value)) invalid()
  return value
}

function platform(value: string): PlatformId {
  const found = PLATFORMS.find((candidate) => candidate === value)
  if (!found) invalid()
  return found
}

function jid(value: string) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) invalid()
  return value
}

function positive(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid()
  return String(value)
}

function matching(value: string, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value)) invalid()
  return value
}

/**
 * A part whose shape a platform or a peer chooses (a delivery id, a Forge token id, an A2A task id): kept as written
 * when it is plain, otherwise its SHA-256 after `~`, which no plain part contains, so the two forms never meet.
 */
export function freePart(value: string) {
  if (typeof value !== "string" || !value || value.length > 512) invalid()
  return PLAIN_PART.test(value) ? value : `~${sha256Hex(value)}`
}

/** Whether `userId` is a well-formed user id for the installation's platform. */
export function userIdValid(installationKey: string, userId: string) {
  const owner = installationPlatform(installationKey)
  return owner !== undefined && typeof userId === "string" && USER_ID_PATTERNS[owner].test(userId)
}

function user(installationKey: string, userId: string) {
  if (!userIdValid(installationKey, userId)) invalid()
  return userId
}

export const everywhereKeys = {
  install: (installationKey: string) => key("install", installation(installationKey)),
  installs: (accountId: string) => key("installs", account(accountId)),
  link: (installationKey: string, userId: string) =>
    key("link", installation(installationKey), user(installationKey, userId)),
  links: (accountId: string) => key("links", account(accountId)),
  linkCode: (codeHash: string) => key("linkcode", matching(codeHash, SHA256_HEX)),
  /** VE-04: the hash of the account's one live link code, so a newer code (or erasing the account) ends older ones. */
  linkCodes: (accountId: string) => key("linkcodes", account(accountId)),
  /** VE-04: failed link code attempts by one platform user in the last hour. */
  linkTries: (installationKey: string, userId: string) =>
    key("linktries", installation(installationKey), user(installationKey, userId)),
  connectCode: (codeHash: string) => key("connectcode", matching(codeHash, SHA256_HEX)),
  state: (id: string) => key("state", matching(id, STATE_ID)),
  repo: (installationKey: string, place: string) => key("repo", installation(installationKey), matching(place, PLACE)),
  /** VE-04: the user ids linked on an installation, so erasing it finds every link without scanning (E13). */
  linked: (installationKey: string) => key("linked", installation(installationKey)),
  /** VE-04: the places of an installation that have a repository mapping, for the same reason. */
  repos: (installationKey: string) => key("repos", installation(installationKey)),
  job: (jobId: string) => key("job", jid(jobId)),
  jobBody: (jobId: string) => key("job", jid(jobId), "body"),
  jobs: (sponsor: string) => key("jobs", account(sponsor)),
  jobsDue: () => key("jobs", "due"),
  /** VE-05: the live jobs on an installation, so erasing it finds them without scanning (E13). */
  installationJobs: (installationKey: string) => key("livejobs", installation(installationKey)),
  /** VE-05: every job an account sponsored in the last 30 days, for its job list and for account erase. */
  jobHistory: (sponsor: string) => key("history", account(sponsor)),
  ready: (device: string) => key("ready", matching(device, DEVICE_ID_PATTERN)),
  fit: (jti: string) => key("fit", freePart(jti)),
  handoff: (repositoryId: number, runId: number) => key("handoff", positive(repositoryId), positive(runId)),
  count: (scope: string, window: string) =>
    key("count", matching(scope, /^(?:sponsor|requester|installation):\S+$/), matching(window, COUNT_WINDOW)),
  delivery: (platformId: string, deliveryId: string) => key("delivery", platform(platformId), freePart(deliveryId)),
  offer: (jti: string) => key("offer", matching(jti, RANDOM_ID_PATTERN)),
  seen: (accountId: string) => key("seen", account(accountId)),
  ticket: (hash: string) => key("ticket", matching(hash, TICKET_HASH)),
  jiraTask: (taskId: string) => key("jira", "task", freePart(taskId)),
  audit: (accountId: string) => key("audit", account(accountId)),
} as const

/** Cap counter scopes (3.9): per sponsor, per requester (an installation's user) and per installation. */
export const capScopes = {
  sponsor: (accountId: string) => `sponsor:${account(accountId)}`,
  requester: (installationKey: string, userId: string) =>
    `requester:${installation(installationKey)}:${user(installationKey, userId)}`,
  installation: (installationKey: string) => `installation:${installation(installationKey)}`,
} as const

/** Whether a key is one of Vector everywhere's. */
export function isEverywhereKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(EVERYWHERE_PREFIX) && value.length > EVERYWHERE_PREFIX.length
}
