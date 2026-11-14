import { createHash } from "node:crypto"
import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumPlan, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { ApiError } from "./http.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The roadmap vote (WP A34). Max and Ultra vote on what Vector builds next: one ballot per account per quarter, which
 * they can change until the vote closes. Ultra may also nominate one feature a quarter for the next ballot. The owner
 * publishes each quarter's ballot with `script/roadmap-ballot.ts`; results show only after the vote closes, as totals,
 * and only once at least 20 ballots are counted, every one cast by an account whose plan included the vote when it
 * voted. The winner is "planned for the next release cycle": no date, ever.
 *
 * Keys (contract §4.6, under the Codium prefix):
 *   roadmap:<yyyy-qn>:ballot       the ballot the owner publishes: its candidates, when it opens and closes, and the
 *                                  winner the owner picked if the top candidates tied
 *   roadmap:<yyyy-qn>:ballots      HASH voter → {choice, plan, at}: one field per account, replaced until close
 *   roadmap:<yyyy-qn>:nominations  HASH voter → {title, detail?, plan, at}: written once a quarter (HSETNX)
 *   roadmap:quarters               SET of every quarter holding any of these, so deleting an account finds them all
 * A voter is the SHA-256 of the account id under a fixed label, so no key or field names the account. Ballots and
 * nominations are kept until the account is deleted (the A30 privacy draft, `#roadmap-votes`).
 *
 * Who may vote or nominate is the server's decision, from the entitlement snapshot (S1); see api/roadmap/index.ts.
 */

/** Results are published only once this many ballots are counted. */
export const ROADMAP_MINIMUM = 20
export const ROADMAP_TITLE_MAX = 80
export const ROADMAP_DETAIL_MAX = 280
export const ROADMAP_CANDIDATES = { min: 2, max: 10 } as const
/** The words the winner gets, with no date. */
export const ROADMAP_PLANNED = "Planned for the next release cycle."

const QUARTER = /^(\d{4})-q([1-4])$/
const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// Control and invisible formatting characters, including the bidirectional overrides that could make a nomination
// read differently in the owner's terminal than it was written.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/
// A date, a month, a quarter or "soon" in the owner's candidate copy: the vote never promises when.
const DATED =
  /\b(?:19|20)\d{2}\b|\bq[1-4]\b|\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\bsoon\b|\b(?:next|this|coming) (?:week|month|quarter|year|release)\b|\bend of\b/i

export type RoadmapCandidate = { id: string; title: string; detail?: string }
export type RoadmapBallot = {
  v: 1
  quarter: string
  opensAt: number
  closesAt: number
  candidates: RoadmapCandidate[]
  /** Set by the owner only when the top candidates tied. */
  winner?: string
  createdAt: number
}
export type RoadmapCast = { v: 1; choice: string; plan: PlanId; at: number }
export type RoadmapNomination = { v: 1; title: string; detail?: string; plan: PlanId; at: number }

export type RoadmapTotal = { id: string; title: string; votes: number }
export type RoadmapResults =
  | { quarter: string; closedAt: number; minimum: number; published: false; choice?: string }
  | {
      quarter: string
      closedAt: number
      minimum: number
      published: true
      counted: number
      totals: RoadmapTotal[]
      tied: boolean
      winner?: { id: string; title: string; planned: string }
      choice?: string
    }

/** Why the account may not vote now, as the Settings tab words it. */
export type RoadmapRefusal = "plan" | "payment" | "hold" | "unavailable"

/** What GET and POST /api/roadmap answer. */
export type RoadmapView = {
  quarter: string
  /** This quarter's ballot while it is upcoming or open, with the account's own choice. */
  ballot?: {
    quarter: string
    opensAt: number
    closesAt: number
    open: boolean
    candidates: RoadmapCandidate[]
    choice?: string
  }
  /** The most recent vote that has closed. */
  results?: RoadmapResults
  vote: { allowed: boolean; reason?: RoadmapRefusal }
  nominate: { allowed: boolean; nomination?: { title: string; detail?: string; at: number } }
}

// ── Quarters ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The UTC calendar quarter `time` falls in, as `yyyy-qn`. */
export function quarterOf(time: number) {
  const date = new Date(time)
  return `${date.getUTCFullYear()}-q${Math.floor(date.getUTCMonth() / 3) + 1}`
}

export function validQuarter(value: unknown): value is string {
  const match = typeof value === "string" ? QUARTER.exec(value) : null
  return Boolean(match && Number(match[1]) >= 2000 && Number(match[1]) < 10_000)
}

/** The quarter's first millisecond and the first millisecond after it, in UTC. */
export function quarterBounds(quarter: string) {
  const match = QUARTER.exec(quarter)
  if (!match) throw new Error("A quarter is written like 2026-q4.")
  const year = Number(match[1])
  const index = Number(match[2]) - 1
  return { start: Date.UTC(year, index * 3, 1), end: Date.UTC(year, index * 3 + 3, 1) }
}

export function previousQuarter(quarter: string) {
  return quarterOf(quarterBounds(quarter).start - 1)
}

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const key = (mode: StripeMode | undefined, ...parts: string[]) =>
  mode ? codiumKeyIn(mode, "roadmap", ...parts) : codiumKey("roadmap", ...parts)
export const ballotKey = (quarter: string, mode?: StripeMode) => key(mode, quarter, "ballot")
export const ballotsKey = (quarter: string, mode?: StripeMode) => key(mode, quarter, "ballots")
export const nominationsKey = (quarter: string, mode?: StripeMode) => key(mode, quarter, "nominations")
export const quartersKey = (mode?: StripeMode) => key(mode, "quarters")

/** The field an account's ballot and nomination are kept under: a hash, so the store never names the account. */
export function voterField(account: string) {
  return createHash("sha256").update(`vector-roadmap-account:${account}`).digest("hex")
}

/** The vote needs only the store, so it can be listed wherever the store is configured. */
export function roadmapConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()) &&
      (process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()),
  )
}

// ── Text ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A title or detail as stored: whitespace runs become one space, and text with control or invisible formatting
 * characters, or outside `min`..`max` characters, is refused (undefined).
 */
export function roadmapText(value: unknown, max: number, min = 1) {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/g, " ").trim()
  const length = [...text].length
  if (HIDDEN.test(text) || length < min || length > max) return undefined
  return text
}

/** Whether owner copy names a date, a month, a quarter or "soon". */
export function datedCopy(text: string) {
  return DATED.test(text)
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

function parse(raw: unknown) {
  if (typeof raw !== "string") return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function candidate(value: unknown): RoadmapCandidate | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !CANDIDATE_ID.test(value.id)) return undefined
  const title = roadmapText(value.title, ROADMAP_TITLE_MAX, 3)
  if (!title || title !== value.title) return undefined
  if (value.detail === undefined) return { id: value.id, title }
  const detail = roadmapText(value.detail, ROADMAP_DETAIL_MAX)
  return detail && detail === value.detail ? { id: value.id, title, detail } : undefined
}

/** The owner's candidates, checked as `script/roadmap-ballot.ts` writes them, or undefined. */
export function decodeCandidates(value: unknown): RoadmapCandidate[] | undefined {
  if (!Array.isArray(value) || value.length < ROADMAP_CANDIDATES.min || value.length > ROADMAP_CANDIDATES.max)
    return undefined
  const candidates = value.map(candidate)
  if (candidates.some((item) => !item)) return undefined
  const valid = candidates as RoadmapCandidate[]
  return new Set(valid.map((item) => item.id)).size === valid.length ? valid : undefined
}

/** A stored ballot for `quarter`, or undefined for anything else. It opens and closes inside its quarter. */
export function decodeBallot(raw: unknown, quarter: string): RoadmapBallot | undefined {
  const value = parse(raw)
  if (!value || value.v !== 1 || value.quarter !== quarter || !validQuarter(quarter)) return undefined
  const bounds = quarterBounds(quarter)
  const candidates = decodeCandidates(value.candidates)
  if (
    !candidates ||
    !timestamp(value.opensAt) ||
    !timestamp(value.closesAt) ||
    !timestamp(value.createdAt) ||
    value.opensAt < bounds.start ||
    value.closesAt <= value.opensAt ||
    value.closesAt > bounds.end ||
    (value.winner !== undefined && !candidates.some((item) => item.id === value.winner))
  )
    return undefined
  return {
    v: 1,
    quarter,
    opensAt: value.opensAt,
    closesAt: value.closesAt,
    candidates,
    ...(typeof value.winner === "string" ? { winner: value.winner } : {}),
    createdAt: value.createdAt,
  }
}

function decodeCast(raw: unknown): RoadmapCast | undefined {
  const value = parse(raw)
  if (
    !value ||
    value.v !== 1 ||
    typeof value.choice !== "string" ||
    !CANDIDATE_ID.test(value.choice) ||
    !CodiumPlan.isPlanId(value.plan) ||
    !timestamp(value.at)
  )
    return undefined
  return { v: 1, choice: value.choice, plan: value.plan, at: value.at }
}

function decodeNomination(raw: unknown): RoadmapNomination | undefined {
  const value = parse(raw)
  if (!value || value.v !== 1 || !CodiumPlan.isPlanId(value.plan) || !timestamp(value.at)) return undefined
  const title = roadmapText(value.title, ROADMAP_TITLE_MAX, 3)
  const detail = value.detail === undefined ? undefined : roadmapText(value.detail, ROADMAP_DETAIL_MAX)
  if (!title || (value.detail !== undefined && !detail)) return undefined
  return { v: 1, title, ...(detail ? { detail } : {}), plan: value.plan, at: value.at }
}

// ── Counting ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The count of a ballot's votes. A ballot counts only when it was cast before the vote closed, for one of the
 * candidates, by an account whose plan included the vote when it voted (the plan is kept with each ballot); anything
 * else in the hash, whatever wrote it, is left out. Totals list the candidates by votes, then in ballot order.
 */
export function tallyBallots(ballot: RoadmapBallot, values: readonly unknown[]) {
  const votes = new Map(ballot.candidates.map((item) => [item.id, 0]))
  let counted = 0
  for (const raw of values) {
    const cast = decodeCast(raw)
    if (!cast || !ENTITLEMENTS[cast.plan].vote || cast.at >= ballot.closesAt || !votes.has(cast.choice)) continue
    votes.set(cast.choice, votes.get(cast.choice)! + 1)
    counted++
  }
  const totals: RoadmapTotal[] = ballot.candidates
    .map((item) => ({ id: item.id, title: item.title, votes: votes.get(item.id)! }))
    .sort((left, right) => right.votes - left.votes)
  const top = totals[0]!.votes
  const leaders = totals.filter((item) => item.votes === top)
  return { counted, totals, leaders }
}

/** The published answer for a closed ballot: nothing but the minimum below 20 counted ballots. */
export function ballotResults(ballot: RoadmapBallot, values: readonly unknown[], choice?: string): RoadmapResults {
  const base = { quarter: ballot.quarter, closedAt: ballot.closesAt, minimum: ROADMAP_MINIMUM }
  const shown = choice && ballot.candidates.some((item) => item.id === choice) ? { choice } : {}
  const { counted, totals, leaders } = tallyBallots(ballot, values)
  if (counted < ROADMAP_MINIMUM) return { ...base, published: false, ...shown }
  const tied = leaders.length > 1
  const winner = tied ? leaders.find((item) => item.id === ballot.winner) : leaders[0]
  return {
    ...base,
    published: true,
    counted,
    totals,
    tied,
    ...(winner ? { winner: { id: winner.id, title: winner.title, planned: ROADMAP_PLANNED } } : {}),
    ...shown,
  }
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────────

type StoreOptions = { mode?: StripeMode; fetcher?: typeof fetch }

export async function readBallot(quarter: string, options: StoreOptions = {}) {
  return decodeBallot(await persistentStore(["GET", ballotKey(quarter, options.mode)], options.fetcher), quarter)
}

async function readChoice(quarter: string, field: string, fetcher: typeof fetch) {
  return decodeCast(await persistentStore(["HGET", ballotsKey(quarter), field], fetcher))?.choice
}

/** Every ballot cast in `quarter`, as stored. The fields (voters) never leave the store. */
async function readCasts(quarter: string, options: StoreOptions) {
  const values = await persistentStore(["HVALS", ballotsKey(quarter, options.mode)], options.fetcher)
  return Array.isArray(values) ? values : []
}

/**
 * The roadmap as one account sees it at `now`: this quarter's ballot while it is upcoming or open, the account's own
 * choice and nomination, and the results of the most recent vote that closed (this quarter's once it has closed, else
 * last quarter's). `access` is what the route decided from the snapshot.
 */
export async function roadmapView(
  account: string,
  access: { vote: RoadmapView["vote"]; nominate: boolean },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RoadmapView> {
  const quarter = quarterOf(now)
  const previous = previousQuarter(quarter)
  const field = voterField(account)
  const stored = await persistentStore(["MGET", ballotKey(quarter), ballotKey(previous)], fetcher)
  const [currentRaw, previousRaw] = Array.isArray(stored) ? stored : []
  const current = decodeBallot(currentRaw, quarter)
  const closed = current && now >= current.closesAt ? current : decodeBallot(previousRaw, previous)
  const [choice, nominated, results] = await Promise.all([
    current && now < current.closesAt ? readChoice(quarter, field, fetcher) : undefined,
    persistentStore(["HGET", nominationsKey(quarter), field], fetcher).then(decodeNomination),
    closed
      ? Promise.all([readCasts(closed.quarter, { fetcher }), readChoice(closed.quarter, field, fetcher)]).then(
          ([values, own]) => ballotResults(closed, values, own),
        )
      : undefined,
  ])
  return {
    quarter,
    ...(current && now < current.closesAt
      ? {
          ballot: {
            quarter,
            opensAt: current.opensAt,
            closesAt: current.closesAt,
            open: now >= current.opensAt,
            candidates: current.candidates,
            ...(choice && current.candidates.some((item) => item.id === choice) ? { choice } : {}),
          },
        }
      : {}),
    ...(results ? { results } : {}),
    vote: access.vote,
    nominate: {
      allowed: access.nominate && !nominated,
      ...(nominated
        ? {
            nomination: {
              title: nominated.title,
              ...(nominated.detail ? { detail: nominated.detail } : {}),
              at: nominated.at,
            },
          }
        : {}),
    },
  }
}

// ── Voting and nominating ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Casts or replaces the account's ballot in `quarter`, which must be this quarter's open vote. The caller has already
 * checked the account may vote; its plan is kept with the ballot, so the count can tell it was entitled.
 */
export async function castBallot(
  account: string,
  input: { quarter: unknown; choice: unknown; plan: PlanId },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const quarter = quarterOf(now)
  if (input.quarter !== quarter) throw closed()
  const ballot = await readBallot(quarter, { fetcher })
  if (!ballot || now < ballot.opensAt || now >= ballot.closesAt) throw closed()
  if (typeof input.choice !== "string" || !ballot.candidates.some((item) => item.id === input.choice))
    throw new ApiError(400, "ROADMAP_CHOICE_INVALID", "Choose one of the features on this ballot.")
  const cast: RoadmapCast = { v: 1, choice: input.choice, plan: input.plan, at: now }
  await persistentStore(["SADD", quartersKey(), quarter], fetcher)
  await persistentStore(["HSET", ballotsKey(quarter), voterField(account), JSON.stringify(cast)], fetcher)
}

/** Records the account's one nomination of `quarter` (this quarter), or refuses a second. */
export async function nominateFeature(
  account: string,
  input: { quarter: unknown; title: unknown; detail?: unknown; plan: PlanId },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const quarter = quarterOf(now)
  if (input.quarter !== quarter)
    throw new ApiError(409, "ROADMAP_QUARTER_ENDED", "That quarter has ended. Open the roadmap again to nominate.")
  const title = roadmapText(input.title, ROADMAP_TITLE_MAX, 3)
  // The detail is optional: absent, null or blank means none.
  const given = typeof input.detail === "string" ? input.detail.trim() !== "" : input.detail != null
  const detail = given ? roadmapText(input.detail, ROADMAP_DETAIL_MAX) : undefined
  if (!title || (given && !detail))
    throw new ApiError(
      400,
      "ROADMAP_NOMINATION_INVALID",
      `Name the feature in 3 to ${ROADMAP_TITLE_MAX} characters, and describe it in up to ${ROADMAP_DETAIL_MAX}.`,
    )
  const nomination: RoadmapNomination = { v: 1, title, ...(detail ? { detail } : {}), plan: input.plan, at: now }
  await persistentStore(["SADD", quartersKey(), quarter], fetcher)
  const written = await persistentStore(
    ["HSETNX", nominationsKey(quarter), voterField(account), JSON.stringify(nomination)],
    fetcher,
  )
  if (Number(written) !== 1)
    throw new ApiError(409, "ROADMAP_ALREADY_NOMINATED", "You have already nominated a feature this quarter.")
}

function closed() {
  return new ApiError(409, "ROADMAP_CLOSED", "This vote is not open. Open the roadmap again to see the latest.")
}

// ── Deleting an account ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Erases the account's ballots and nominations from every quarter (for account deletion, A57). Returns how many were
 * erased. A closed vote's totals are counted when read, so they drop the erased ballot too.
 */
export async function eraseAccountBallots(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const field = voterField(account)
  const listed = await persistentStore(["SMEMBERS", quartersKey()], fetcher)
  const quarters = new Set([...(Array.isArray(listed) ? listed : []).filter(validQuarter), quarterOf(now)])
  let erased = 0
  for (const quarter of quarters) {
    erased += Number(await persistentStore(["HDEL", ballotsKey(quarter), field], fetcher)) || 0
    erased += Number(await persistentStore(["HDEL", nominationsKey(quarter), field], fetcher)) || 0
  }
  return erased
}

// ── The owner's ballot (script/roadmap-ballot.ts) ──────────────────────────────────────────────────────────────────

type OwnerOptions = { mode: StripeMode; fetcher?: typeof fetch; now?: number }

/**
 * Publishes a quarter's ballot. It opens and closes inside that quarter, closes in the future, and its copy names no
 * date. A published ballot is replaced only with `replace` and only while nobody has voted on it.
 */
export async function openBallot(
  input: { quarter: string; opensAt: number; closesAt: number; candidates: unknown },
  options: OwnerOptions & { replace?: boolean },
) {
  const now = options.now ?? Date.now()
  if (!validQuarter(input.quarter)) throw new Error("A quarter is written like 2026-q4.")
  const bounds = quarterBounds(input.quarter)
  const candidates = decodeCandidates(input.candidates)
  if (!candidates)
    throw new Error(
      `A ballot has ${ROADMAP_CANDIDATES.min} to ${ROADMAP_CANDIDATES.max} candidates, each {id, title, detail?}: ids of ` +
        `lower-case letters, digits and dashes, titles of 3 to ${ROADMAP_TITLE_MAX} characters, details up to ` +
        `${ROADMAP_DETAIL_MAX}, without control characters or extra spaces.`,
    )
  const dated = candidates.find((item) => datedCopy(`${item.title} ${item.detail ?? ""}`))
  if (dated) throw new Error(`Candidate ${dated.id} names a date, month, quarter or "soon". The vote never says when.`)
  if (!timestamp(input.opensAt) || input.opensAt < bounds.start || input.opensAt >= bounds.end)
    throw new Error(`The ballot must open inside ${input.quarter}.`)
  if (!timestamp(input.closesAt) || input.closesAt <= input.opensAt || input.closesAt > bounds.end)
    throw new Error(`The ballot must close after it opens and no later than the end of ${input.quarter}.`)
  if (input.closesAt <= now) throw new Error("The ballot must close in the future.")
  const ballot: RoadmapBallot = {
    v: 1,
    quarter: input.quarter,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    candidates,
    createdAt: now,
  }
  const fetcher = options.fetcher ?? fetch
  const target = ballotKey(input.quarter, options.mode)
  let written = await persistentStore(["SET", target, JSON.stringify(ballot), "NX"], fetcher)
  if (written !== "OK") {
    if (!options.replace) throw new Error(`${input.quarter} already has a ballot. Pass --replace to change it.`)
    const cast = Number(await persistentStore(["HLEN", ballotsKey(input.quarter, options.mode)], fetcher)) || 0
    if (cast > 0)
      throw new Error(
        `${input.quarter}'s ballot has ${cast} vote${cast === 1 ? "" : "s"} and can no longer be replaced.`,
      )
    written = await persistentStore(["SET", target, JSON.stringify(ballot), "XX"], fetcher)
    if (written !== "OK") throw new Error(`${input.quarter}'s ballot could not be replaced.`)
  }
  await persistentStore(["SADD", quartersKey(options.mode), input.quarter], fetcher)
  return ballot
}

/** Moves a ballot's close to `at` (now by default): earlier to end it, or later, but never past its quarter. */
export async function closeBallot(quarter: string, options: OwnerOptions & { at?: number }) {
  const now = options.now ?? Date.now()
  const at = options.at ?? now
  const ballot = await readBallot(quarter, options)
  if (!ballot) throw new Error(`${quarter} has no ballot.`)
  if (now >= ballot.closesAt) throw new Error(`${quarter}'s vote has already closed.`)
  if (at < now || at <= ballot.opensAt || at > quarterBounds(quarter).end)
    throw new Error(`The new close must be from now on, after the ballot opens and within ${quarter}.`)
  const next: RoadmapBallot = { ...ballot, closesAt: at }
  const written = await persistentStore(
    ["SET", ballotKey(quarter, options.mode), JSON.stringify(next), "XX"],
    options.fetcher ?? fetch,
  )
  if (written !== "OK") throw new Error(`${quarter}'s ballot could not be changed.`)
  return next
}

/** The count of a ballot, open or closed, for the owner. */
export async function ownerTally(quarter: string, options: OwnerOptions) {
  const ballot = await readBallot(quarter, options)
  if (!ballot) throw new Error(`${quarter} has no ballot.`)
  return { ballot, ...tallyBallots(ballot, await readCasts(quarter, options)) }
}

/** Records which of the tied top candidates goes first, once the vote has closed with at least 20 ballots. */
export async function decideBallot(quarter: string, winner: string, options: OwnerOptions) {
  const now = options.now ?? Date.now()
  const { ballot, counted, leaders } = await ownerTally(quarter, options)
  if (now < ballot.closesAt) throw new Error(`${quarter}'s vote is still open.`)
  if (counted < ROADMAP_MINIMUM)
    throw new Error(`${quarter} counted ${counted} ballots, fewer than ${ROADMAP_MINIMUM}: no result is published.`)
  if (leaders.length < 2) throw new Error(`${quarter} has a clear winner: ${leaders[0]!.id}.`)
  if (!leaders.some((item) => item.id === winner))
    throw new Error(`Choose one of the tied candidates: ${leaders.map((item) => item.id).join(", ")}.`)
  const next: RoadmapBallot = { ...ballot, winner }
  const written = await persistentStore(
    ["SET", ballotKey(quarter, options.mode), JSON.stringify(next), "XX"],
    options.fetcher ?? fetch,
  )
  if (written !== "OK") throw new Error(`${quarter}'s ballot could not be changed.`)
  return next
}

/** A quarter's nominations, oldest first, without who made them. */
export async function ownerNominations(quarter: string, options: OwnerOptions) {
  const values = await persistentStore(["HVALS", nominationsKey(quarter, options.mode)], options.fetcher ?? fetch)
  return (Array.isArray(values) ? values : [])
    .map(decodeNomination)
    .filter((item): item is RoadmapNomination => Boolean(item))
    .sort((left, right) => left.at - right.at)
}
