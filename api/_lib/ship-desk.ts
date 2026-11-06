import { createHash, randomBytes } from "node:crypto"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { ShipDesk } from "../../packages/schema/src/ship-desk.js"
import { cloudRunReader, type CloudRunReader } from "./cloud-run-reader.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { meterKey, METER_KEEP_MS, readSnapshot, requireUsableSnapshot } from "./codium-snapshot.js"
import {
  githubServerConfigured,
  githubServerError,
  withRepositoryToken,
  type GithubRepoClient,
  type GithubServerOptions,
} from "./github-app-server.js"
import type { OpsPullRequest } from "./github-webhook-handlers/ops.js"
import { ApiError } from "./http.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { opsPerkOpen, requireOpsPerk } from "./ops-listing.js"
import { appendCapped, indexMembers, readRecord, readRecords, updateRecord } from "./ops-records.js"
import { readOpsSettings, repositoryBinding } from "./ops-settings.js"
import { requireOpsService } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"
import { presignR2, r2Configured } from "./r2-presign.js"
import { readOptIn } from "./release-guard.js"
import { sendServerAlert } from "./web-push.js"

/*
 * Ship Desk (contract WP A49): pull requests from Codium runs of Vector's GitHub agent become private cards with the
 * head commit's check runs, the run's verdict and before/after screenshots, to approve from the phone or the desktop.
 *
 * Cards. The GitHub webhook's ops handler (github-webhook-handlers/ops.ts) passes each pull request opened from a branch
 * of the same repository by the App's bot, or by `github-actions[bot]` with the run marker Vector's publish step writes
 * (`<!-- vector:rid <rid> -->`), in a repository bound to the account with Ship Desk on in its settings. A card is made
 * only when:
 * - the marker names a run of that repository; for `github-actions[bot]`, which anyone with write access can act as,
 *   Codex's run record must also say the run is this account's, in this repository (the App's bot cannot be acted as);
 * - the plan allows new cards now (active, or renewing within grace, with `caps.ops.shipDesk`: §4.4's Ship Desk row),
 *   the ops services are configured, the owner's `ops` switch is on, Ship Desk is listed (ops-listing.ts) and the
 *   GitHub App is set up here;
 * - the repository's `.vector/ops.json` on the pull request's base branch names the account's ops id with
 *   `shipDesk: true` (read with a read-only one-repository App token, revoked after use);
 * - one script, in one step, finds no card for this (repository, pull request) and no card for this run, then counts the
 *   card against the plan's cards a month (`meter:<account>:<meterEpoch>:ship-desk-cards`). Dedupe comes before the
 *   count: a card is counted once per (repository, pull request), however many events the pull request sends.
 * Later events update the card (new head, ready for review, merged, closed) whatever the plan, so a paused or ended
 * account's cards stay readable until they expire, after the plan's `keepDays`. A frozen account's cards and images are
 * hidden, not deleted.
 *
 * Verdict. From Codex's run record (`CloudRun.verdict`, registered at A59 through cloud-run-reader.ts), with the
 * repository id matched; never from the pull request's body. Check runs come from GitHub's API with the same read-only
 * token, refreshed when a card is opened.
 *
 * Capture. `vector ship capture --pr <n>` runs in a separate job with no `id-token` and no run token. The run's own token
 * asks `POST /api/ops/uploads {action: "ticket"}` for a capture ticket for its run (so for one pull request), in a
 * private repository only; the capture job then uploads at most `shipDesk.images` PNG or WebP files straight to R2
 * through signed links, inside one 15-minute window from the ticket's first upload, and each file is checked by its
 * signature and size before the card shows it. GitHub prints a job's environment in its log, so the ticket can be read
 * there by anyone who reads the repository's logs: the capture job's first request therefore binds the ticket to a
 * random proof that job made (`proof`, stored hashed), and every later request must carry it. Images are read back only by the card's account, through 60-second signed links (image.ts).
 *
 * Vector's server never merges: Approve opens the pull request in GitHub, or the desktop merges it with the person's own
 * GitHub sign-in (A50).
 */

export const SHIP_DESK_LIMITS = {
  /**
   * A card's record outlives its `expiresAt` by this (WP A50), hidden from every reader, so the ops cleanup
   * (api/_lib/ops-cleanup.ts) can still find its images and delete them with it; the cleanup runs daily.
   */
  retainMs: 3 * 86_400_000,
  /** Cards listed per account, and how long the index keeps a card (the longest `keepDays`, its retention and a day). */
  indexMax: 2_000,
  indexKeepMs: 94 * 86_400_000,
  /** Cards a list answer carries. */
  listed: 50,
  /** A card's check runs are read again when it is opened, at most this often. */
  refreshMs: 60_000,
  /** Check runs older than this are read again while any is still running. */
  checksStaleMs: 2 * 60_000,
  /** Run records read to find a card's run (Codex's index keeps 200). */
  runs: 200,
  /** Each request to R2. */
  r2Ms: 8_000,
  /** A signed link to an image lives this long. */
  imageLinkSeconds: 60,
  /** Tickets a run may hold at once (a capture that failed asks again). */
  ticketsPerHour: 120,
  /** The longest a ticket lives in all. */
  ticketMaxMs: 4 * 3_600_000,
} as const

export const SHIP_DESK_CARD_METER = "ship-desk-cards"

const SHA = /^[0-9a-f]{40}$/
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/actions\/runs\/\d{1,20}$/
const CHECK_STATUSES = ["queued", "in_progress", "completed", "waiting", "requested", "pending"] as const
const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
] as const

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function key(mode: StripeMode | undefined, ...parts: (string | number)[]) {
  return mode ? codiumKeyIn(mode, ...parts) : codiumKey(...parts)
}
export const cardKey = (account: string, id: string, mode?: StripeMode) => key(mode, "ops", "card", account, id)
export const cardIndexKey = (account: string, mode?: StripeMode) => key(mode, "ops", "cards", account)
export const cardRunKey = (account: string, rid: string, mode?: StripeMode) =>
  key(mode, "ops", "card", account, "run", rid)
export const cardRefreshKey = (account: string, id: string, mode?: StripeMode) =>
  key(mode, "ops", "card", account, id, "refresh")
export const ticketKey = (hash: string, mode?: StripeMode) => key(mode, "ops", "card", "ticket", hash)
export const ticketIndexKey = (account: string, mode?: StripeMode) => key(mode, "ops", "card", account, "tickets")

/** A card's id: the same for one (repository, pull request) every time, so events find it without an index. */
export function cardId(repositoryId: number, number: number) {
  return `crd_${createHash("sha256").update(`${repositoryId}#${number}`).digest("base64url").slice(0, 22)}`
}

export const ticketHash = (ticket: string) => createHash("sha256").update(ticket).digest("hex")

function accountTag(account: string) {
  return createHash("sha256").update(`ship-desk\n${account}`).digest("hex").slice(0, 32)
}

/** Where an image lives in `vector-media`: by mode and keep days, so the bucket's lifecycle rules match the plan's. */
export function imageObjectKey(
  input: { account: string; card: string; capture: string; n: number; type: ShipDesk.ImageType; keepDays: number },
  mode: StripeMode = stripeMode(),
) {
  return [
    "ship-desk",
    mode,
    `k${input.keepDays}`,
    accountTag(input.account),
    input.card,
    input.capture,
    `${input.n}.${ShipDesk.extension(input.type)}`,
  ].join("/")
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CheckRun = {
  name: string
  status: (typeof CHECK_STATUSES)[number]
  conclusion?: (typeof CHECK_CONCLUSIONS)[number]
}
export type CardChecks = { at: number; sha: string; total: number; items: CheckRun[] }
export type CardImage = {
  n: number
  slot: ShipDesk.Slot
  route: string
  type: ShipDesk.ImageType
  bytes: number
  width: number
  height: number
  key: string
}
export type PendingFile = {
  n: number
  slot: ShipDesk.Slot
  route: string
  type: ShipDesk.ImageType
  bytes: number
  key: string
}

export type Card = {
  v: 1
  id: string
  repositoryId: number
  repository: string
  number: number
  url: string
  title?: string
  author: "app" | "actions"
  state: "open" | "merged" | "closed"
  draft: boolean
  baseRef: string
  baseSha?: string
  headSha: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  keepDays: number
  rid?: string
  verdict?: { value: "pass" | "fail" | "none"; final: boolean; at: number }
  runUrl?: string
  checks?: CardChecks
  images: CardImage[]
  /** The head commit the images were taken of. */
  imagesSha?: string
  imagesAt?: number
  capture?: { id: string; ticket: string; until: number; files: PendingFile[] }
}

function time(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function decodeFile(value: unknown): PendingFile | undefined {
  const file = record(value)
  if (
    !file ||
    !positive(file.n) ||
    (file.slot !== "before" && file.slot !== "after") ||
    !ShipDesk.validRoute(file.route) ||
    !ShipDesk.IMAGE_TYPES.includes(file.type as ShipDesk.ImageType) ||
    !positive(file.bytes) ||
    typeof file.key !== "string"
  )
    return undefined
  return file as PendingFile
}

export function decodeCard(value: unknown): Card | undefined {
  const card = record(value) as Card | undefined
  if (
    !card ||
    card.v !== 1 ||
    typeof card.id !== "string" ||
    !ShipDesk.CARD_ID.test(card.id) ||
    !positive(card.repositoryId) ||
    typeof card.repository !== "string" ||
    !positive(card.number) ||
    typeof card.url !== "string" ||
    (card.author !== "app" && card.author !== "actions") ||
    !["open", "merged", "closed"].includes(card.state) ||
    typeof card.draft !== "boolean" ||
    typeof card.baseRef !== "string" ||
    typeof card.headSha !== "string" ||
    !SHA.test(card.headSha) ||
    !time(card.createdAt) ||
    !time(card.updatedAt) ||
    !time(card.expiresAt) ||
    !positive(card.keepDays) ||
    !Array.isArray(card.images) ||
    !card.images.every((image) => decodeFile(image) && positive(image.width) && positive(image.height)) ||
    (card.capture !== undefined &&
      (!record(card.capture) ||
        typeof card.capture.id !== "string" ||
        typeof card.capture.ticket !== "string" ||
        !time(card.capture.until) ||
        !Array.isArray(card.capture.files) ||
        !card.capture.files.every((file) => decodeFile(file))))
  )
    return undefined
  return card
}

export type Ticket = {
  v: 1
  account: string
  repositoryId: number
  rid: string
  mintedAt: number
  expiresAt: number
  /** SHA-256 (hex) of the proof the first request carried: the capture job this ticket now belongs to. */
  proof?: string
  boundAt?: number
  firstUse?: number
  finished?: boolean
}

function decodeTicket(value: unknown): Ticket | undefined {
  const ticket = record(value) as Ticket | undefined
  if (
    !ticket ||
    ticket.v !== 1 ||
    typeof ticket.account !== "string" ||
    !positive(ticket.repositoryId) ||
    ShipDesk.runRepository(ticket.rid) !== ticket.repositoryId ||
    !time(ticket.mintedAt) ||
    !time(ticket.expiresAt) ||
    (ticket.proof !== undefined && (typeof ticket.proof !== "string" || !/^[0-9a-f]{64}$/.test(ticket.proof))) ||
    (ticket.boundAt !== undefined && !time(ticket.boundAt)) ||
    (ticket.firstUse !== undefined && !time(ticket.firstUse)) ||
    (ticket.finished !== undefined && typeof ticket.finished !== "boolean")
  )
    return undefined
  return ticket
}

export async function readCard(account: string, id: string, fetcher: typeof fetch = fetch) {
  if (!ShipDesk.CARD_ID.test(id)) return undefined
  return (await readRecord(cardKey(account, id), decodeCard, fetcher)).value
}

/**
 * Changes a card while it lives: `change` gets the stored card and answers the new one, or undefined to change nothing
 * (it may run again when another write came first, so it must be pure). A card's lifetime never moves. Answers the card
 * as stored afterwards and whether this call wrote it.
 */
async function saveCard(
  account: string,
  id: string,
  change: (current: Card) => Card | undefined,
  fetcher: typeof fetch,
  now: number,
): Promise<{ card: Card; written: boolean } | undefined> {
  const read = await readCard(account, id, fetcher)
  if (!read || read.expiresAt <= now) return undefined
  let written = false
  const card = await updateRecord(
    cardKey(account, id),
    decodeCard,
    (current) => {
      written = false
      if (!current || current.expiresAt !== read.expiresAt) return undefined
      const next = change(current)
      written = next !== undefined
      return next
    },
    read.expiresAt + SHIP_DESK_LIMITS.retainMs - now,
    fetcher,
  )
  return card ? { card, written } : undefined
}

// CARD. KEYS: the card, the run's card, the period's card meter, the account's card index. ARGV: the card, its id, the
// plan's cards a month, the card's lifetime in ms (its retention included), when the meter expires (ms), the index
// score, the oldest score the index keeps, the most members it keeps, the index's lifetime in ms. Dedupe before
// increment: a card that exists answers 0 and a run that already has a card 2, before the meter is read; -1 when the
// month's cards are used; 1 when the card was made and counted.
const CARD = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end",
  "local used = tonumber(redis.call('GET', KEYS[3]) or '0') or 0",
  "if used >= tonumber(ARGV[3]) then return -1 end",
  "redis.call('INCR', KEYS[3])",
  "redis.call('PEXPIREAT', KEYS[3], ARGV[5])",
  "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])",
  "redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[4])",
  "redis.call('ZADD', KEYS[4], ARGV[6], ARGV[2])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', '(' .. ARGV[7])",
  "redis.call('ZREMRANGEBYRANK', KEYS[4], 0, -1 - tonumber(ARGV[8]))",
  "redis.call('PEXPIRE', KEYS[4], ARGV[9])",
  "return 1",
].join(" ")

export const SHIP_DESK_SCRIPTS = Object.freeze({ CARD })

function unreadable(): never {
  throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Vector's production check records could not be read.")
}

async function createCard(
  account: string,
  card: Card,
  snapshot: EntitlementSnapshot,
  cap: number,
  fetcher: typeof fetch,
) {
  const result = await persistentStore(
    [
      "EVAL",
      CARD,
      "4",
      cardKey(account, card.id),
      cardRunKey(account, card.rid!),
      meterKey(snapshot, SHIP_DESK_CARD_METER),
      cardIndexKey(account),
      JSON.stringify(card),
      card.id,
      String(cap),
      String(card.expiresAt - card.createdAt + SHIP_DESK_LIMITS.retainMs),
      String(snapshot.periodEnd + METER_KEEP_MS),
      String(card.createdAt),
      String(card.createdAt - SHIP_DESK_LIMITS.indexKeepMs),
      String(SHIP_DESK_LIMITS.indexMax),
      String(SHIP_DESK_LIMITS.indexKeepMs),
    ],
    fetcher,
  )
  if (result === 1) return "created" as const
  if (result === 0) return "exists" as const
  if (result === 2) return "run-used" as const
  if (result === -1) return "limit" as const
  unreadable()
}

// ── Codex's run records ────────────────────────────────────────────────────────────────────────────────────────────

export type RunFacts = {
  rid: string
  repositoryId: number
  verdict?: "pass" | "fail" | "none"
  ended: boolean
  url?: string
}
export type RunLookup = { available: false } | { available: true; run?: RunFacts }

/** One run record as Ship Desk reads it: the run id, its repository id, and how it ended. Nothing else is kept. */
export function runFacts(input: unknown): RunFacts | undefined {
  const run = record(input)
  if (!run || typeof run.rid !== "string" || ShipDesk.runRepository(run.rid) === undefined) return undefined
  const repositoryId = typeof run.repositoryId === "number" ? run.repositoryId : Number(run.repositoryId)
  if (!positive(repositoryId) || (typeof run.repositoryId === "string" && !/^[1-9]\d{0,19}$/.test(run.repositoryId)))
    return undefined
  const verdict = run.verdict === "pass" || run.verdict === "fail" || run.verdict === "none" ? run.verdict : undefined
  const url = typeof run.runUrl === "string" && RUN_URL.test(run.runUrl) ? run.runUrl : undefined
  return {
    rid: run.rid,
    repositoryId,
    ...(verdict ? { verdict } : {}),
    ended: time(run.endedAt),
    ...(url ? { url } : {}),
  }
}

/**
 * The account's run with this id in this repository, from Codex's run records. `available: false` while no reader is
 * registered (before A59) or it fails; a record of another repository is no match.
 */
export async function lookupRun(
  account: string,
  rid: string,
  repositoryId: number,
  reader: CloudRunReader | undefined,
): Promise<RunLookup> {
  if (!reader) return { available: false }
  let records: readonly unknown[]
  try {
    records = await reader(account, { limit: SHIP_DESK_LIMITS.runs })
  } catch {
    return { available: false }
  }
  if (!Array.isArray(records)) return { available: false }
  for (const item of records) {
    const run = runFacts(item)
    if (run?.rid === rid) return { available: true, ...(run.repositoryId === repositoryId ? { run } : {}) }
  }
  return { available: true }
}

function verdictOf(run: RunFacts | undefined, now: number): Card["verdict"] {
  if (!run) return undefined
  return { value: run.verdict ?? "none", final: run.ended && run.verdict !== undefined, at: now }
}

// ── GitHub ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The head commit's newest check runs, as a card lists them: names and states only. */
export async function readChecks(client: GithubRepoClient, sha: string, now: number): Promise<CardChecks | undefined> {
  const answer = record(await client.get(`/commits/${sha}/check-runs?per_page=50&filter=latest`))
  if (!answer || !Array.isArray(answer.check_runs)) return undefined
  const items = answer.check_runs.flatMap((item): CheckRun[] => {
    const run = record(item)
    if (!run || typeof run.name !== "string" || !run.name.trim()) return []
    const status = CHECK_STATUSES.find((value) => value === run.status)
    if (!status) return []
    const conclusion = CHECK_CONCLUSIONS.find((value) => value === run.conclusion)
    return [
      {
        name: run.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100),
        status,
        ...(status === "completed" && conclusion ? { conclusion } : {}),
      },
    ]
  })
  const total = Number.isSafeInteger(answer.total_count) ? (answer.total_count as number) : items.length
  return { at: now, sha, total: Math.max(total, items.length), items: items.slice(0, ShipDesk.LIMITS.checks) }
}

function pendingChecks(checks: CardChecks | undefined) {
  return !checks || checks.total === 0 || checks.items.some((item) => item.status !== "completed")
}

// ── Intake ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ShipDeskAlert = (
  account: string,
  alert: { title: string; tag?: string },
  options: { fetcher: typeof fetch; now: number },
) => Promise<unknown>

export type ShipDeskContext = {
  fetcher?: typeof fetch
  now?: number
  github?: Omit<GithubServerOptions, "fetcher" | "now">
  /** Codex's run records; defaults to the registered reader, null for none. */
  reader?: CloudRunReader | null
  alert?: ShipDeskAlert
}

export type ShipDeskOutcome =
  | { kind: "created"; card: string }
  | { kind: "updated"; card: string }
  | {
      kind: "ignored"
      reason:
        | "closed"
        | "no-run"
        | "run-unverified"
        | "run-used"
        | "plan"
        | "off"
        | "not-installed"
        | "opt-in"
        | "limit"
        | "not-listed"
    }

function readerOf(context: ShipDeskContext) {
  return context.reader === null ? undefined : (context.reader ?? cloudRunReader())
}

function ignored(reason: Extract<ShipDeskOutcome, { kind: "ignored" }>["reason"]): ShipDeskOutcome {
  return { kind: "ignored", reason }
}

function storeDown(error: unknown) {
  return error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE"
}

function githubUnavailable() {
  return new ApiError(503, "GITHUB_UNAVAILABLE", "GitHub could not be reached. Try again shortly.")
}

/** "<repository> #<n> is ready on Ship Desk", at most 120 characters. */
export function readyTitle(repository: string, number: number) {
  const tail = ` #${number} is ready on Ship Desk`
  const name = repository.length + tail.length > 120 ? `${repository.slice(0, 119 - tail.length)}…` : repository
  return `${name}${tail}`
}

function cleanTitle(title: string | undefined) {
  if (typeof title !== "string") return undefined
  const text = title.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  return text ? text.slice(0, ShipDesk.LIMITS.titleChars) : undefined
}

/**
 * What Ship Desk does with one pull request event (registered with the webhook's ops handler by api/github/webhook.ts).
 * Throws only when the store or GitHub cannot be reached, so the delivery fails and can be sent again; everything else
 * is an outcome, and everything it does is idempotent.
 */
export async function shipDeskIntake(pull: OpsPullRequest, context: ShipDeskContext = {}): Promise<ShipDeskOutcome> {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  const id = cardId(pull.repositoryId, pull.number)
  const existing = await readCard(pull.account, id, fetcher)
  if (existing && existing.expiresAt > now) return update(existing, pull, context, fetcher, now)
  return create(pull, context, fetcher, now)
}

async function claimRun(account: string, rid: string, card: Card, now: number, fetcher: typeof fetch) {
  const result = await persistentStore(
    ["SET", cardRunKey(account, rid), card.id, "PX", String(Math.max(1, card.expiresAt - now)), "NX"],
    fetcher,
  )
  if (result === "OK") return true
  return (await persistentStore(["GET", cardRunKey(account, rid)], fetcher)) === card.id
}

async function update(
  card: Card,
  pull: OpsPullRequest,
  context: ShipDeskContext,
  fetcher: typeof fetch,
  now: number,
): Promise<ShipDeskOutcome> {
  // A later run on the same pull request (the agent pushing to its own branch) names its run in the body: the card
  // follows it, once the run is checked the same way a new card's is and no other card holds it.
  let rid: string | undefined
  let run: RunFacts | undefined
  if (pull.rid && pull.rid !== card.rid && ShipDesk.runRepository(pull.rid) === card.repositoryId) {
    const found = await lookupRun(pull.account, pull.rid, card.repositoryId, readerOf(context))
    const trusted = pull.author === "app" || (found.available && found.run !== undefined)
    if (trusted && (await claimRun(pull.account, pull.rid, card, now, fetcher))) {
      rid = pull.rid
      run = found.available ? found.run : undefined
    }
  }
  const title = cleanTitle(pull.title)
  await saveCard(
    pull.account,
    card.id,
    (current) => {
      const next: Card = { ...current, updatedAt: now, draft: pull.draft }
      if (title) next.title = title
      if (pull.action === "closed") next.state = pull.merged ? "merged" : "closed"
      else if (pull.action === "reopened") next.state = "open"
      if (pull.baseSha && SHA.test(pull.baseSha)) next.baseSha = pull.baseSha
      if (pull.baseRef) next.baseRef = pull.baseRef
      if (pull.headSha !== current.headSha) {
        next.headSha = pull.headSha
        delete next.checks
      }
      if (rid) {
        next.rid = rid
        const verdict = verdictOf(run, now)
        if (verdict) next.verdict = verdict
        else delete next.verdict
        if (run?.url) next.runUrl = run.url
        else delete next.runUrl
      }
      return next
    },
    fetcher,
    now,
  )
  return { kind: "updated", card: card.id }
}

async function create(
  pull: OpsPullRequest,
  context: ShipDeskContext,
  fetcher: typeof fetch,
  now: number,
): Promise<ShipDeskOutcome> {
  const account = pull.account
  if (pull.action === "closed") return ignored("closed")
  const rid = pull.rid
  if (!rid || ShipDesk.runRepository(rid) !== pull.repositoryId) return ignored("no-run")

  let snapshot: EntitlementSnapshot
  try {
    snapshot = requireUsableSnapshot(await readSnapshot(account, fetcher), now)
  } catch (error) {
    if (storeDown(error)) throw error
    return ignored("plan")
  }
  const caps = snapshot.caps.ops?.shipDesk
  if (!caps || caps.cardsPerMonth < 1 || caps.keepDays < 1) return ignored("plan")
  if (!githubServerConfigured(context.github?.configuration)) return ignored("off")
  try {
    await requireOpsService(fetcher, now)
  } catch (error) {
    if (storeDown(error)) throw error
    return ignored("off")
  }
  if (!(await opsPerkOpen(account, ["ship-desk"], fetcher))) return ignored("not-listed")
  const held = await persistentStore(["GET", cardRunKey(account, rid)], fetcher)
  if (held !== null && held !== undefined) return ignored("run-used")

  const found = await lookupRun(account, rid, pull.repositoryId, readerOf(context))
  if (pull.author === "actions") {
    if (!found.available) return ignored("run-unverified")
    if (!found.run) return ignored("no-run")
  }
  const run = found.available ? found.run : undefined

  let checks: CardChecks | undefined
  let optedIn = false
  try {
    await withRepositoryToken(
      {
        account,
        repositoryId: pull.repositoryId,
        repository: pull.repository,
        ...(pull.installationId !== undefined ? { installationId: pull.installationId } : {}),
        purpose: "ship",
        reason: "ship-desk",
      },
      async (client) => {
        const file = await readOptIn(client, pull.baseRef)
        optedIn = file !== undefined && file.opsId === pull.opsId && file.shipDesk === true
        if (!optedIn) return
        // A card is still worth making when the checks cannot be read now; opening it reads them again.
        checks = await readChecks(client, pull.headSha, now).catch(() => undefined)
      },
      { fetcher, now, ...context.github },
    )
  } catch (error) {
    if (githubServerError(error)) {
      if (error.kind === "unavailable") throw githubUnavailable()
      return ignored("not-installed")
    }
    throw error
  }
  if (!optedIn) return ignored("opt-in")

  const title = cleanTitle(pull.title)
  const verdict = verdictOf(run, now)
  const card: Card = {
    v: 1,
    id: cardId(pull.repositoryId, pull.number),
    repositoryId: pull.repositoryId,
    repository: pull.repository,
    number: pull.number,
    url: pull.url,
    ...(title ? { title } : {}),
    author: pull.author,
    state: "open",
    draft: pull.draft,
    baseRef: pull.baseRef,
    ...(pull.baseSha && SHA.test(pull.baseSha) ? { baseSha: pull.baseSha } : {}),
    headSha: pull.headSha,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + caps.keepDays * 86_400_000,
    keepDays: caps.keepDays,
    rid,
    ...(verdict ? { verdict } : {}),
    ...(run?.url ? { runUrl: run.url } : {}),
    ...(checks ? { checks } : {}),
    images: [],
  }
  const result = await createCard(account, card, snapshot, caps.cardsPerMonth, fetcher)
  if (result === "exists") {
    // Another event made it first: this one is an update.
    const current = await readCard(account, card.id, fetcher)
    return current ? update(current, pull, context, fetcher, now) : ignored("run-used")
  }
  if (result === "run-used") return ignored("run-used")
  if (result === "limit") return ignored("limit")
  // A phone alert, titles only (P7); the person may not have the phone app, so a failed send changes nothing.
  const alert: ShipDeskAlert = context.alert ?? ((who, payload, options) => sendServerAlert(who, payload, options))
  await alert(account, { title: readyTitle(pull.repository, pull.number), tag: "ship-desk" }, { fetcher, now }).catch(
    () => undefined,
  )
  return { kind: "created", card: card.id }
}

// ── The account's cards ────────────────────────────────────────────────────────────────────────────────────────────

export type CardView = {
  id: string
  repository: string
  number: number
  url: string
  title?: string
  state: Card["state"]
  draft: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number
  verdict?: { value: "pass" | "fail" | "none"; final: boolean }
  run?: { url: string }
  checks?: { at: number; total: number; passed: number; failed: number; pending: number; items: CheckRun[] }
  images: { n: number; slot: ShipDesk.Slot; route: string; type: ShipDesk.ImageType; width: number; height: number }[]
  /** The images are of an older head commit than the pull request's. */
  imagesOutdated?: boolean
  /** Approve: open the pull request in GitHub; the desktop may merge it with the person's own GitHub sign-in. */
  approve: { url: string; repository: string; number: number; headSha: string }
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"])

export function cardView(card: Card): CardView {
  const checks = card.checks
  return {
    id: card.id,
    repository: card.repository,
    number: card.number,
    url: card.url,
    ...(card.title ? { title: card.title } : {}),
    state: card.state,
    draft: card.draft,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    expiresAt: card.expiresAt,
    ...(card.verdict ? { verdict: { value: card.verdict.value, final: card.verdict.final } } : {}),
    ...(card.runUrl ? { run: { url: card.runUrl } } : {}),
    ...(checks && checks.sha === card.headSha
      ? {
          checks: {
            at: checks.at,
            total: checks.total,
            passed: checks.items.filter((item) => item.conclusion === "success").length,
            failed: checks.items.filter((item) => item.conclusion && FAILED.has(item.conclusion)).length,
            pending: checks.items.filter((item) => item.status !== "completed").length,
            items: checks.items,
          },
        }
      : {}),
    images: card.images.map((image) => ({
      n: image.n,
      slot: image.slot,
      route: image.route,
      type: image.type,
      width: image.width,
      height: image.height,
    })),
    ...(card.images.length && card.imagesSha && card.imagesSha !== card.headSha ? { imagesOutdated: true } : {}),
    approve: { url: card.url, repository: card.repository, number: card.number, headSha: card.headSha },
  }
}

/** Whether the account's cards are hidden: a frozen plan hides them (and their images), never deletes them (§4.4). */
export async function cardsHidden(account: string, fetcher: typeof fetch = fetch) {
  return (await readSnapshot(account, fetcher))?.state === "frozen"
}

/** The account's newest cards, newest first, without asking GitHub anything. */
export async function listCards(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (await cardsHidden(account, fetcher)) return { cards: [] as CardView[], hidden: true }
  const ids = await indexMembers(cardIndexKey(account), SHIP_DESK_LIMITS.listed * 2, fetcher)
  const cards = (
    await readRecords(
      ids.map((id) => cardKey(account, id)),
      decodeCard,
      fetcher,
    )
  )
    .filter((card): card is Card => card !== undefined && card.expiresAt > now)
    .slice(0, SHIP_DESK_LIMITS.listed)
  return { cards: cards.map(cardView), hidden: false }
}

function notFound() {
  return new ApiError(404, "SHIP_DESK_NOT_FOUND", "That card does not exist.")
}

function hiddenError() {
  return new ApiError(403, "SHIP_DESK_HIDDEN", "Ship Desk is on hold for this account while its payment is reviewed.")
}

/**
 * One card, with its check runs and verdict read again when they may have changed: the checks while the pull request is
 * open and some are still running (or none were found yet), at most once a minute, only while the plan allows Ship Desk
 * now; the verdict until the run's record says it ended. A failed read keeps what the card had.
 */
export async function openCard(account: string, id: unknown, context: ShipDeskContext = {}) {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  if (typeof id !== "string") throw notFound()
  if (await cardsHidden(account, fetcher)) throw hiddenError()
  let card = await readCard(account, id, fetcher)
  if (!card || card.expiresAt <= now) throw notFound()

  const wantChecks =
    card.state === "open" &&
    (!card.checks ||
      card.checks.sha !== card.headSha ||
      (now - card.checks.at > SHIP_DESK_LIMITS.checksStaleMs && pendingChecks(card.checks)))
  const reader = readerOf(context)
  const wantVerdict = card.rid !== undefined && !card.verdict?.final && reader !== undefined
  if (!wantChecks && !wantVerdict) return { card: cardView(card) }
  const locked = await persistentStore(
    ["SET", cardRefreshKey(account, card.id), String(now), "PX", String(SHIP_DESK_LIMITS.refreshMs), "NX"],
    fetcher,
  )
  if (locked !== "OK") return { card: cardView(card) }

  let checks: CardChecks | undefined
  if (wantChecks && githubServerConfigured(context.github?.configuration)) {
    let usable = false
    try {
      usable = requireUsableSnapshot(await readSnapshot(account, fetcher), now).caps.ops?.shipDesk !== undefined
    } catch (error) {
      if (storeDown(error)) throw error
    }
    const head = card.headSha
    if (usable)
      checks = await withRepositoryToken(
        {
          account,
          repositoryId: card.repositoryId,
          repository: card.repository,
          purpose: "ship",
          reason: "ship-desk-checks",
        },
        (client) => readChecks(client, head, now),
        { fetcher, now, ...context.github },
      ).catch((error: unknown) => {
        if (storeDown(error)) throw error
        return undefined
      })
  }
  const run = wantVerdict ? await lookupRun(account, card.rid!, card.repositoryId, reader) : undefined
  const found = run?.available ? run.run : undefined
  if (!checks && !found) return { card: cardView(card) }
  const saved = await saveCard(
    account,
    card.id,
    (current) => {
      const next: Card = { ...current }
      if (checks && checks.sha === current.headSha) next.checks = checks
      if (found && found.rid === current.rid) {
        next.verdict = verdictOf(found, now)
        if (found.url) next.runUrl = found.url
      }
      return next
    },
    fetcher,
    now,
  )
  return { card: cardView(saved?.card ?? card) }
}

// ── Capture tickets ────────────────────────────────────────────────────────────────────────────────────────────────

function ticketInvalid() {
  return new ApiError(401, "SHIP_DESK_TICKET_INVALID", "This capture ticket is not valid. Run the capture again.")
}

function mediaUnavailable() {
  return new ApiError(503, "R2_UNAVAILABLE", "File storage is temporarily unavailable.")
}

/**
 * A capture ticket for a run of Vector's GitHub agent, asked for with the run's own token (`vrt_`, verified by the
 * registered run verifier; the caller passes the account and run it proved). The run id names its repository, which
 * must be bound to the account with Ship Desk on, and private (read with a read-only App token: a public repository's
 * Actions logs, which show the ticket, are public); Ship Desk must be listed and the plan must allow it now. The ticket
 * uploads only to the card of the pull request carrying this run's marker; it must be first used before the run's
 * deadline plus an hour, its first request binds it to that capture job's proof, and the capture then has 15 minutes
 * from its first start.
 */
export async function mintCaptureTicket(
  input: { account: string; rid: string; deadline: number },
  context: ShipDeskContext = {},
): Promise<ShipDesk.TicketAnswer> {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  const repositoryId = ShipDesk.runRepository(input.rid)
  if (repositoryId === undefined)
    throw new ApiError(
      403,
      "SHIP_DESK_RUN_INVALID",
      "Only a run of Vector's GitHub agent can ask for a capture ticket.",
    )
  await requireOpsService(fetcher, now)
  if (!r2Configured("media")) throw mediaUnavailable()
  await requireOpsPerk(input.account, ["ship-desk"], fetcher)
  const snapshot = requireUsableSnapshot(await readSnapshot(input.account, fetcher), now)
  if (!snapshot.caps.ops?.shipDesk)
    throw new ApiError(403, "CODIUM_PERK_REQUIRED", "Your Vector Codium plan does not include Ship Desk.", {
      detail: { perk: "ship-desk" },
    })
  const binding = await repositoryBinding(repositoryId)
  if (binding?.account !== input.account)
    throw new ApiError(409, "OPS_REPO_NOT_BOUND", "Connect this repository to your Vector account first.")
  const { settings } = await readOpsSettings(input.account, fetcher)
  const repo = settings?.repos.find((item) => item.repositoryId === repositoryId && item.shipDesk)
  if (!repo) throw new ApiError(403, "SHIP_DESK_OFF", "Ship Desk is not on for this repository.")
  // GitHub prints a step's environment in its log, which anyone can read on a public repository.
  let visible: boolean
  try {
    visible = await withRepositoryToken(
      {
        account: input.account,
        repositoryId,
        repository: binding.repository,
        ...((repo.installationId ?? binding.installationId) !== undefined
          ? { installationId: repo.installationId ?? binding.installationId }
          : {}),
        purpose: "ship",
        reason: "ship-ticket",
      },
      async (client) => !client.repository.private,
      { fetcher, now, ...context.github },
    )
  } catch (error) {
    if (githubServerError(error)) {
      if (error.kind === "unavailable") throw githubUnavailable()
      throw new ApiError(403, "SHIP_DESK_OFF", "Vector's GitHub App is not installed on this repository.")
    }
    throw error
  }
  if (visible)
    throw new ApiError(
      403,
      "SHIP_DESK_PUBLIC_REPOSITORY",
      "Ship Desk takes screenshots in private repositories only: a public repository's Actions logs are public.",
    )

  const ticket = `${ShipDesk.TICKET_PREFIX}${randomBytes(32).toString("base64url")}`
  const expiresAt = Math.min(
    now + SHIP_DESK_LIMITS.ticketMaxMs,
    Math.max(now, input.deadline) + ShipDesk.LIMITS.ticketGraceMs,
  )
  const value: Ticket = { v: 1, account: input.account, repositoryId, rid: input.rid, mintedAt: now, expiresAt }
  const hash = ticketHash(ticket)
  const keep = expiresAt + ShipDesk.LIMITS.windowMs - now
  // The account's tickets are listed first, so erasing the account finds every one that may still live.
  await appendCapped(
    ticketIndexKey(input.account),
    hash,
    { at: now, max: 500, keepMs: SHIP_DESK_LIMITS.ticketMaxMs * 2 },
    fetcher,
  )
  if (
    (await persistentStore(["SET", ticketKey(hash), JSON.stringify(value), "PX", String(keep), "NX"], fetcher)) !== "OK"
  )
    throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Vector's production check records could not be read.")
  return { ticket, expiresAt }
}

/**
 * The ticket, bound to the capture job that first used it: the first request (of any action) stores the hash of the
 * proof it carried, and every later one must carry the same proof. A ticket read from a job's log is then of no use.
 */
async function readTicket(ticket: unknown, proof: unknown, fetcher: typeof fetch, now: number) {
  if (typeof ticket !== "string" || !ShipDesk.TICKET.test(ticket)) throw ticketInvalid()
  if (typeof proof !== "string" || !ShipDesk.PROOF.test(proof))
    throw new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", "Send the capture's proof. Update Vector in the workflow.")
  const hash = ticketHash(ticket)
  const mine = createHash("sha256").update(proof).digest("hex")
  let { value } = await readRecord(ticketKey(hash), decodeTicket, fetcher)
  if (!value) throw ticketInvalid()
  const open = (current: Ticket) =>
    current.firstUse === undefined ? now <= current.expiresAt : now <= current.firstUse + ShipDesk.LIMITS.windowMs
  if (!open(value))
    throw new ApiError(410, "SHIP_DESK_TICKET_EXPIRED", "This capture ticket's time is up. Run the capture again.")
  if (value.proof === undefined) {
    const expiresAt = value.expiresAt
    value = await updateRecord(
      ticketKey(hash),
      decodeTicket,
      (current) => (current && current.proof === undefined ? { ...current, proof: mine, boundAt: now } : undefined),
      Math.max(1, expiresAt + ShipDesk.LIMITS.windowMs + ShipDesk.LIMITS.ticketGraceMs - now),
      fetcher,
    )
    if (!value) throw ticketInvalid()
  }
  if (value.proof !== mine)
    throw new ApiError(
      403,
      "SHIP_DESK_TICKET_BOUND",
      "Another capture job already uses this capture ticket. Run the whole workflow again for a new one.",
    )
  return { ticket: value, hash }
}

/** The card a ticket may capture: the pull request `pr` of the ticket's repository, carrying the ticket's run. */
async function ticketCard(ticket: Ticket, pr: unknown, fetcher: typeof fetch, now: number) {
  if (!positive(pr)) throw new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", "Name the pull request by number.")
  if (await cardsHidden(ticket.account, fetcher)) throw hiddenError()
  const card = await readCard(ticket.account, cardId(ticket.repositoryId, pr), fetcher)
  if (!card || card.expiresAt <= now)
    throw new ApiError(
      409,
      "SHIP_DESK_CARD_PENDING",
      "Ship Desk has no card for this pull request yet. Try again shortly.",
      {
        detail: { retryAfterMs: 10_000 },
      },
    )
  if (card.rid !== ticket.rid)
    throw new ApiError(403, "SHIP_DESK_TICKET_MISMATCH", "This capture ticket is for another pull request.")
  if (card.state !== "open")
    throw new ApiError(409, "SHIP_DESK_CLOSED", "This pull request is closed; its card takes no new images.")
  return card
}

function imageLimit(card: Card, snapshot: EntitlementSnapshot | undefined) {
  return Math.min(ShipDesk.LIMITS.files, snapshot?.caps.ops?.shipDesk.images ?? ShipDesk.LIMITS.files)
}

/** `{action: "card", pr}`: what the capture shoots. Starts nothing. */
export async function captureCard(
  input: { ticket: unknown; pr: unknown; proof: unknown },
  context: ShipDeskContext = {},
): Promise<ShipDesk.CardAnswer> {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  const { ticket } = await readTicket(input.ticket, input.proof, fetcher, now)
  const card = await ticketCard(ticket, input.pr, fetcher, now)
  return {
    repository: card.repository,
    number: card.number,
    baseRef: card.baseRef,
    ...(card.baseSha ? { baseSha: card.baseSha } : {}),
    headSha: card.headSha,
    files: imageLimit(card, await readSnapshot(ticket.account, fetcher)),
  }
}

function captureInvalid(message: string) {
  return new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", message)
}

/** The files a capture declares, checked: at most the card's image count, each slot and route once, sizes in range. */
export function captureFiles(value: unknown, limit: number): ShipDesk.CaptureFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit)
    throw captureInvalid(`Send 1 to ${limit} files.`)
  const seen = new Set<string>()
  return value.map((item) => {
    const file = record(item)
    if (
      !file ||
      Object.keys(file).some((name) => !["slot", "route", "bytes", "type"].includes(name)) ||
      (file.slot !== "before" && file.slot !== "after") ||
      !ShipDesk.validRoute(file.route) ||
      !ShipDesk.IMAGE_TYPES.includes(file.type as ShipDesk.ImageType) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < ShipDesk.LIMITS.imageMinBytes ||
      (file.bytes as number) > ShipDesk.LIMITS.imageBytes
    )
      throw captureInvalid("Each file is a PNG or WebP screenshot of a route, before or after, up to 5 MB.")
    const slot = `${file.slot} ${file.route}`
    if (seen.has(slot)) throw captureInvalid("Send each route once before and once after.")
    seen.add(slot)
    return { slot: file.slot, route: file.route, bytes: file.bytes as number, type: file.type as ShipDesk.ImageType }
  })
}

async function r2Send(
  method: "HEAD" | "GET" | "DELETE",
  objectKey: string,
  fetcher: typeof fetch,
  now: number,
  headers: Record<string, string> = {},
) {
  const signed = presignR2("media", { method, key: objectKey, expiresIn: 60, now })
  return fetcher(signed.url, {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(SHIP_DESK_LIMITS.r2Ms),
    cache: "no-store",
  })
}

/** Deletes card images from `vector-media` (the ops cleanup, WP A50); false when any delete failed or R2 is off. */
export async function deleteCardObjects(keys: readonly string[], fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!r2Configured("media")) return false
  return deleteObjects(keys, fetcher, now)
}

/** Deletes objects from `vector-media`; a missing object is fine. Answers whether every delete was taken. */
async function deleteObjects(keys: readonly string[], fetcher: typeof fetch, now: number) {
  let ok = true
  for (const objectKey of keys) {
    const response = await r2Send("DELETE", objectKey, fetcher, now).catch(() => undefined)
    await response?.body?.cancel().catch(() => undefined)
    if (!response || (!response.ok && response.status !== 404)) ok = false
  }
  return ok
}

async function prefix(response: Response, bytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  while (length < bytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out.slice(0, bytes)
}

/**
 * `{action: "start", pr, files}`: the ticket's first use opens its 15-minute window. Signs one upload per file, each
 * for its exact size and image type, to an object only this capture names. A start again before finishing replaces
 * the pending capture (a failed upload is retried this way).
 */
export async function startCapture(
  input: { ticket: unknown; pr: unknown; files: unknown; proof: unknown },
  context: ShipDeskContext = {},
): Promise<ShipDesk.StartAnswer> {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  if (!r2Configured("media")) throw mediaUnavailable()
  await requireOpsService(fetcher, now)
  const { ticket, hash } = await readTicket(input.ticket, input.proof, fetcher, now)
  if (ticket.finished)
    throw new ApiError(409, "SHIP_DESK_CAPTURE_DONE", "This capture ticket already finished. Run the capture again.")
  const card = await ticketCard(ticket, input.pr, fetcher, now)
  const files = captureFiles(input.files, imageLimit(card, await readSnapshot(ticket.account, fetcher)))

  // The window opens on the first start and never moves. The record outlives it by an hour, so a late request is told
  // its time is up rather than that the ticket is unknown.
  const opened = await updateRecord(
    ticketKey(hash),
    decodeTicket,
    (current) => (current && current.firstUse === undefined ? { ...current, firstUse: now } : undefined),
    ShipDesk.LIMITS.windowMs + ShipDesk.LIMITS.ticketGraceMs,
    fetcher,
  )
  const firstUse = opened?.firstUse ?? now
  const until = firstUse + ShipDesk.LIMITS.windowMs
  if (now > until)
    throw new ApiError(410, "SHIP_DESK_TICKET_EXPIRED", "This capture ticket's time is up. Run the capture again.")

  const capture = `cap_${randomBytes(16).toString("base64url").slice(0, 22)}`
  const pending: PendingFile[] = files.map((file, index) => ({
    n: index + 1,
    ...file,
    key: imageObjectKey({
      account: ticket.account,
      card: card.id,
      capture,
      n: index + 1,
      type: file.type,
      keepDays: card.keepDays,
    }),
  }))
  let replaced: PendingFile[] = []
  const saved = await saveCard(
    ticket.account,
    card.id,
    (current) => {
      if (current.rid !== ticket.rid || current.state !== "open") return undefined
      replaced = current.capture?.files ?? []
      return { ...current, capture: { id: capture, ticket: hash, until, files: pending }, updatedAt: now }
    },
    fetcher,
    now,
  )
  if (!saved?.written || saved.card.capture?.id !== capture)
    throw new ApiError(409, "OPS_BUSY", "This changed at the same time somewhere else. Try again.")
  if (replaced.length)
    await deleteObjects(
      replaced.map((file) => file.key),
      fetcher,
      now,
    )
  const expiresIn = Math.max(1, Math.min(900, Math.floor((until - now) / 1000)))
  return {
    capture,
    until,
    uploads: pending.map((file) => {
      const signed = presignR2("media", {
        method: "PUT",
        key: file.key,
        contentLength: file.bytes,
        contentType: file.type,
        expiresIn,
        now,
      })
      return {
        n: file.n,
        url: signed.url,
        method: "PUT" as const,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      }
    }),
  }
}

/**
 * `{action: "finish", pr, capture}`, inside the window: each upload is read back (its size with HEAD, its first bytes
 * with a ranged GET) and kept only when its signature says PNG or WebP of the declared type and its size is the one
 * signed. Anything else is deleted. The card then shows this capture's images, and the previous capture's are deleted.
 */
export async function finishCapture(
  input: { ticket: unknown; pr: unknown; capture: unknown; proof: unknown },
  context: ShipDeskContext = {},
): Promise<ShipDesk.FinishAnswer> {
  const fetcher = context.fetcher ?? fetch
  const now = context.now ?? Date.now()
  if (!r2Configured("media")) throw mediaUnavailable()
  const { ticket, hash } = await readTicket(input.ticket, input.proof, fetcher, now)
  const card = await ticketCard(ticket, input.pr, fetcher, now)
  if (
    typeof input.capture !== "string" ||
    !ShipDesk.CAPTURE_ID.test(input.capture) ||
    card.capture?.id !== input.capture ||
    card.capture.ticket !== hash
  )
    throw new ApiError(409, "SHIP_DESK_CAPTURE_UNKNOWN", "This capture was replaced or never started.")
  if (now > card.capture.until)
    throw new ApiError(410, "SHIP_DESK_TICKET_EXPIRED", "This capture ticket's time is up. Run the capture again.")

  const kept: CardImage[] = []
  const refused: ShipDesk.FinishAnswer["refused"] = []
  for (const file of card.capture.files) {
    const head = await r2Send("HEAD", file.key, fetcher, now).catch(() => undefined)
    await head?.body?.cancel().catch(() => undefined)
    if (!head) throw mediaUnavailable()
    if (head.status === 404) {
      refused.push({ n: file.n, reason: "missing" })
      continue
    }
    if (!head.ok) throw mediaUnavailable()
    if (Number(head.headers.get("content-length")) !== file.bytes) {
      refused.push({ n: file.n, reason: "size" })
      continue
    }
    const got = await r2Send("GET", file.key, fetcher, now, { range: "bytes=0-63" }).catch(() => undefined)
    if (!got || (got.status !== 200 && got.status !== 206)) {
      await got?.body?.cancel().catch(() => undefined)
      throw mediaUnavailable()
    }
    const sniffed = ShipDesk.sniffImage(await prefix(got, 64))
    if (!sniffed || sniffed.type !== file.type) {
      refused.push({ n: file.n, reason: "type" })
      continue
    }
    kept.push({ ...file, width: sniffed.width, height: sniffed.height })
  }
  const bad = card.capture.files.filter((file) => !kept.some((image) => image.n === file.n)).map((file) => file.key)
  await deleteObjects(bad, fetcher, now)

  let previous: CardImage[] = []
  const saved = await saveCard(
    ticket.account,
    card.id,
    (current) => {
      if (current.capture?.id !== input.capture) return undefined
      previous = current.images
      const next: Card = {
        ...current,
        images: kept,
        imagesSha: current.headSha,
        imagesAt: now,
        updatedAt: now,
      }
      delete next.capture
      return next
    },
    fetcher,
    now,
  )
  if (!saved?.written)
    throw new ApiError(409, "SHIP_DESK_CAPTURE_UNKNOWN", "This capture was replaced or never started.")
  await updateRecord(
    ticketKey(hash),
    decodeTicket,
    (current) => (current ? { ...current, finished: true } : undefined),
    Math.max(1, (ticket.firstUse ?? now) + ShipDesk.LIMITS.windowMs + ShipDesk.LIMITS.ticketGraceMs - now),
    fetcher,
  )
  if (previous.length)
    await deleteObjects(
      previous.map((image) => image.key),
      fetcher,
      now,
    )
  return { images: kept.length, refused }
}

// ── Images ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A 60-second signed link to one of a card's images, for the card's own account only. The link pins the stored image
 * type, `no-store` and an attachment disposition, so opened on its own it downloads instead of rendering.
 */
export async function imageLink(
  account: string,
  id: unknown,
  n: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!r2Configured("media")) throw mediaUnavailable()
  if (typeof id !== "string" || !ShipDesk.CARD_ID.test(id)) throw notFound()
  const index = typeof n === "string" && /^[1-9]\d?$/.test(n) ? Number(n) : typeof n === "number" ? n : Number.NaN
  if (await cardsHidden(account, fetcher)) throw hiddenError()
  const card = await readCard(account, id, fetcher)
  const image = card && card.expiresAt > now ? card.images.find((item) => item.n === index) : undefined
  if (!image) throw notFound()
  const signed = presignR2("media", {
    method: "GET",
    key: image.key,
    expiresIn: SHIP_DESK_LIMITS.imageLinkSeconds,
    response: {
      contentType: image.type,
      cacheControl: "no-store, private",
      contentDisposition: `attachment; filename="${card!.id}-${image.n}.${ShipDesk.extension(image.type)}"`,
    },
    now,
  })
  return { url: signed.url, expiresAt: signed.expiresAt, type: image.type, width: image.width, height: image.height }
}

// ── The status meter's figure ──────────────────────────────────────────────────────────────────────────────────────

/** Cards counted this period, from the period's meter (`meters.shipDesk`). */
export async function cardsUsed(snapshot: EntitlementSnapshot, fetcher: typeof fetch) {
  const raw = await persistentStore(["GET", meterKey(snapshot, SHIP_DESK_CARD_METER)], fetcher)
  const used = raw === null || raw === undefined ? 0 : Number(raw)
  return Number.isSafeInteger(used) && used >= 0 ? used : undefined
}

// ── Erasure (P5) ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes every card of the account, in both Stripe modes, with its images and pending uploads in `vector-media`, the
 * run claims, refresh locks and capture tickets (account deletion, A57; the ops provisioner on `closing`). The period's
 * card counter is a count with no content; it expires with the period's meters. Throws when storage cannot be reached,
 * so the provisioner tries again.
 */
export async function eraseAccountShipDesk(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  for (const mode of ["live", "test"] as const) {
    const index = cardIndexKey(account, mode)
    const ids = await persistentStore(["ZRANGE", index, "0", "-1"], fetcher)
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => ShipDesk.CARD_ID.test(id))
    const hashes = await persistentStore(["ZRANGE", ticketIndexKey(account, mode), "0", "-1"], fetcher)
    const tickets = (Array.isArray(hashes) ? hashes : []).map(String).filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    const stored = list.length
      ? await persistentStore(["MGET", ...list.map((id) => cardKey(account, id, mode))], fetcher)
      : []
    const keys = [index, ticketIndexKey(account, mode), ...tickets.map((hash) => ticketKey(hash, mode))]
    const objects: string[] = []
    list.forEach((id, position) => {
      keys.push(cardKey(account, id, mode), cardRefreshKey(account, id, mode))
      let card: Card | undefined
      try {
        card = decodeCard(JSON.parse(String((stored as unknown[])[position])))
      } catch {
        card = undefined
      }
      if (!card) return
      if (card.rid) keys.push(cardRunKey(account, card.rid, mode))
      objects.push(...card.images.map((image) => image.key), ...(card.capture?.files.map((file) => file.key) ?? []))
    })
    if (objects.length) {
      if (!r2Configured("media")) throw mediaUnavailable()
      if (!(await deleteObjects(objects, fetcher, now))) throw mediaUnavailable()
    }
    for (let start = 0; start < keys.length; start += 200)
      await persistentStore(["DEL", ...keys.slice(start, start + 200)], fetcher)
  }
}
