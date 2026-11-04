import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { isPlanId, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Founding members (contract WP A31). The founding window is the earlier of `CODIUM_FOUNDING_LIMIT` paid founders
 * (default 500) or `CODIUM_FOUNDING_DAYS` (default 90) after `sales-opened-at`, the moment of the first paid month
 * (`MODEL_PLANS_SALES_OPENED_AT` overrides it). While it is open and `founding` is listed, a first checkout reserves a
 * slot and marks the checkout and its subscription with a founding token; the first paid reconcile turns the token into
 * a number with one script, so a replayed or parallel `invoice.paid` assigns one number and counts it once (M13).
 *
 * What a founding member keeps, all enforced on the server:
 * - the mark: the number, on the account's status (the app chip and Settings) and, by opt-in, the founders page;
 * - the lock: "your price won't go up while you stay subscribed". When a price rises, the old price stays accepted at
 *   its old amount (`STRIPE_MODEL_PLAN_LEGACY_PRICES_<price>`, model-plan-config.ts); a plan change pays that plan's
 *   current price;
 * - +10% usage on Plus and Pro only (`ENTITLEMENTS[plan].foundingBoost`). An upgrade to Max or Ultra keeps the mark and
 *   the lock, not the boost; the server copies the token onto upgrade checkouts.
 * Founding ends when its subscription is deleted (`customer.subscription.deleted`): not on a scheduled cancellation that
 * is resumed, not on a failed payment, and not when an upgrade supersedes it, since the upgrade carries the token.
 *
 * Store keys (all under the mode prefix): `founding:count`, `founding:member:<account>` (a hash: number, token,
 * subscription, at, listed, ended), `founding:reserved` (a sorted set of tokens by expiry), and for the opt-in founders
 * page `founding:listed` (accounts by number), `founding:names` (account → display name) and `founding:slug`.
 */

const DAY_MS = 86_400_000

export const FOUNDING = {
  defaultLimit: 500,
  maxLimit: 100_000,
  defaultDays: 90,
  maxDays: 3650,
  /** A slot reserved at checkout outlives the checkout by this much, so a payment confirmed late still finds it. */
  reservationGraceMs: 2 * DAY_MS,
  /** The founders page is reachable only by its random slug until this many founders are listed on it. */
  publicAfter: 30,
  nameMax: 40,
} as const

const TOKEN = /^f_[0-9a-f]{24}$/

/** Whether `value` is a founding token the server put on a checkout or subscription. */
export function validFoundingToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value)
}

/** The founding token for one checkout attempt, derived from its idempotency key so a retried request reuses it. */
export function foundingToken(seed: string) {
  return `f_${createHash("sha256").update(`vector-founding-v1:${seed}`).digest("hex").slice(0, 24)}`
}

/**
 * The monthly credits a subscription grants with the founding boost: +10% (to the cent) on a plan that has one, when
 * the subscription carries a founding token. Every other plan and subscription gets `credits` unchanged.
 */
export function foundingCredits(credits: number, plan: string | undefined, token: unknown) {
  if (!validFoundingToken(token) || !plan || !isPlanId(plan)) return credits
  const boost = ENTITLEMENTS[plan].foundingBoost
  return boost === null ? credits : Math.round(credits * boost * 100) / 100
}

// ── Configuration ────────────────────────────────────────────────────────────────────────────────────────────────

export function foundingLimit() {
  return integerSetting("CODIUM_FOUNDING_LIMIT", FOUNDING.defaultLimit, 0, FOUNDING.maxLimit)
}

export function foundingDays() {
  return integerSetting("CODIUM_FOUNDING_DAYS", FOUNDING.defaultDays, 0, FOUNDING.maxDays)
}

/** The owner's override of when sales opened (ms), from an ISO date or milliseconds; undefined when unset. */
export function salesOpenedOverride() {
  const configured = process.env.MODEL_PLANS_SALES_OPENED_AT?.trim()
  if (!configured) return undefined
  const at = /^\d{1,15}$/.test(configured) ? Number(configured) : Date.parse(configured)
  if (!Number.isSafeInteger(at) || at <= 0) throw configurationError()
  return at
}

/**
 * What is wrong with the founding settings, by env name only, for the owner page. An invalid setting closes only the
 * founding window (`foundingWindow`, `reserveFoundingSlot`); it never turns Codium off, so the people already paying
 * keep the Codium they paid for.
 */
export function foundingConfigProblems() {
  const checks: [string, () => unknown][] = [
    ["CODIUM_FOUNDING_LIMIT", foundingLimit],
    ["CODIUM_FOUNDING_DAYS", foundingDays],
    ["MODEL_PLANS_SALES_OPENED_AT", salesOpenedOverride],
  ]
  return checks.flatMap(([name, read]) => {
    try {
      read()
      return []
    } catch {
      return [`${name} is out of range`]
    }
  })
}

/** Whether the owner lists founding (`CODIUM_LISTED_PERKS`); the founders page's provisioner runs only then. */
export function foundingOffered() {
  return (process.env.CODIUM_LISTED_PERKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes("founding")
}

// ── Keys and scripts ─────────────────────────────────────────────────────────────────────────────────────────────

const countKey = () => codiumKey("founding", "count")
const memberKey = (account: string) => codiumKey("founding", "member", account)
const reservedKey = () => codiumKey("founding", "reserved")
const listedKey = () => codiumKey("founding", "listed")
const namesKey = () => codiumKey("founding", "names")
const slugKey = () => codiumKey("founding", "slug")
const openedKey = () => codiumKey("sales-opened-at")

/**
 * WINDOW. The founders counted (KEYS[2]), the slots still reserved at ARGV[1] (KEYS[1], scored by expiry) and when sales
 * opened: ARGV[2] when the owner overrides it, else KEYS[3], else ''. Reads only.
 */
const WINDOW = [
  "local opened = ARGV[2]",
  "if opened == '' then opened = redis.call('GET', KEYS[3]) or '' end",
  "return {tonumber(redis.call('GET', KEYS[2]) or '0') or 0, redis.call('ZCOUNT', KEYS[1], '(' .. ARGV[1], '+inf'), opened}",
].join(" ")

/**
 * RESERVE. Holds founding slot ARGV[1] until ARGV[2] (ms) in KEYS[1] while the window is open at ARGV[3]: a slot already
 * held is kept (its expiry only grows); an account that already has a founding record (KEYS[4]), current or ended, gets
 * none; the window closes ARGV[5] ms after sales opened (ARGV[6], else KEYS[3]) and once the founders counted (KEYS[2])
 * plus the slots held reach ARGV[4]. Expired slots are dropped first. Returns 1 when held, 0 when refused.
 */
const RESERVE = [
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])",
  "local held = redis.call('ZSCORE', KEYS[1], ARGV[1])",
  "if held then if tonumber(ARGV[2]) > tonumber(held) then redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]) end return 1 end",
  "if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end",
  "local opened = ARGV[6]",
  "if opened == '' then opened = redis.call('GET', KEYS[3]) or '' end",
  "if opened ~= '' and tonumber(ARGV[3]) >= tonumber(opened) + tonumber(ARGV[5]) then return 0 end",
  "local count = tonumber(redis.call('GET', KEYS[2]) or '0') or 0",
  "if count + redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end",
  "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])",
  "return 1",
].join(" ")

/**
 * ASSIGN. The account's founding record (KEYS[1]) as a flat field list. When it has none yet, the next number is taken
 * from KEYS[2], the slot ARGV[1] is released from KEYS[3], and the record is written with token ARGV[1], subscription
 * ARGV[2] and time ARGV[3], all in one step. A replayed or parallel payment finds the record and changes nothing.
 */
const ASSIGN = [
  "if redis.call('HEXISTS', KEYS[1], 'number') == 1 then return redis.call('HGETALL', KEYS[1]) end",
  "redis.call('ZREM', KEYS[3], ARGV[1])",
  "local n = redis.call('INCR', KEYS[2])",
  "redis.call('HSET', KEYS[1], 'number', n, 'token', ARGV[1], 'subscription', ARGV[2], 'at', ARGV[3])",
  "return redis.call('HGETALL', KEYS[1])",
].join(" ")

/** READ. The account's founding record (KEYS[1]) as a flat field list, empty when there is none. */
const READ = "return redis.call('HGETALL', KEYS[1])"

/** CARRY. Moves a current (not ended) record (KEYS[1]) to subscription ARGV[1]: an upgrade carried the token. */
const CARRY = [
  "if redis.call('HEXISTS', KEYS[1], 'number') == 0 or redis.call('HEXISTS', KEYS[1], 'ended') == 1 then return 0 end",
  "redis.call('HSET', KEYS[1], 'subscription', ARGV[1])",
  "return 1",
].join(" ")

/**
 * END. Marks the record (KEYS[1]) ended at ARGV[2] (kept, so the account never gets a second number), takes account
 * ARGV[1] off the founders page (KEYS[2]) and forgets its display name (KEYS[3]). Returns 0 when there is no record.
 */
const END = [
  "if redis.call('HEXISTS', KEYS[1], 'number') == 0 then return 0 end",
  "if redis.call('HEXISTS', KEYS[1], 'ended') == 0 then redis.call('HSET', KEYS[1], 'ended', ARGV[2]) end",
  "redis.call('ZREM', KEYS[2], ARGV[1])",
  "redis.call('HDEL', KEYS[3], ARGV[1])",
  "return 1",
].join(" ")

/**
 * OPT. A current founder's choice for the founders page: listed ARGV[2] ('1' or '0') on the record (KEYS[1]) and display
 * name ARGV[3] ('' for none) in KEYS[3]; then account ARGV[1] is on the page (KEYS[2], by number) only while listed and
 * not hidden (ARGV[4] '1' while the plan is frozen). Returns 0, changing nothing, without a current record.
 */
const OPT = [
  "if redis.call('HEXISTS', KEYS[1], 'number') == 0 or redis.call('HEXISTS', KEYS[1], 'ended') == 1 then return 0 end",
  "redis.call('HSET', KEYS[1], 'listed', ARGV[2])",
  "if ARGV[3] == '' then redis.call('HDEL', KEYS[3], ARGV[1]) else redis.call('HSET', KEYS[3], ARGV[1], ARGV[3]) end",
  "if ARGV[2] == '1' and ARGV[4] == '0' then redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[1], 'number'), ARGV[1])",
  "else redis.call('ZREM', KEYS[2], ARGV[1]) end",
  "return 1",
].join(" ")

/**
 * SYNC. Puts account ARGV[1] on the founders page (KEYS[2]) when its record (KEYS[1]) is current and listed and the plan
 * is not frozen (ARGV[2] '0'), and takes it off otherwise. Returns 1 when shown.
 */
const SYNC = [
  "if redis.call('HEXISTS', KEYS[1], 'number') == 1 and redis.call('HEXISTS', KEYS[1], 'ended') == 0",
  "and redis.call('HGET', KEYS[1], 'listed') == '1' and ARGV[2] == '0' then",
  "redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[1], 'number'), ARGV[1]) return 1 end",
  "redis.call('ZREM', KEYS[2], ARGV[1])",
  "return 0",
].join(" ")

/** LIST. The founders page: number and display name ('' for none) of every listed founder (KEYS[1]; names KEYS[2]). */
const LIST = [
  "local rows = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')",
  "local out = {}",
  "for i = 1, #rows, 2 do out[#out + 1] = rows[i + 1] out[#out + 1] = redis.call('HGET', KEYS[2], rows[i]) or '' end",
  "return out",
].join(" ")

/** ERASE. Account deletion: the record (KEYS[1]), its place on the page (KEYS[2]) and its name (KEYS[3]) go. */
const ERASE = [
  "redis.call('DEL', KEYS[1])",
  "redis.call('ZREM', KEYS[2], ARGV[1])",
  "redis.call('HDEL', KEYS[3], ARGV[1])",
  "return 1",
].join(" ")

/** The scripts, for the tests and any store fake that has to recognise them. */
export const FOUNDING_SCRIPTS = Object.freeze({ WINDOW, RESERVE, ASSIGN, READ, CARRY, END, OPT, SYNC, LIST, ERASE })

// ── The window and slots ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The founding window at `now`: open until `CODIUM_FOUNDING_DAYS` after sales opened (before the first paid month it
 * has not started, so it is open) and while the founders counted plus the slots reserved stay under the limit.
 * Invalid settings close it.
 */
export async function foundingWindow(fetcher: typeof fetch = fetch, now = Date.now()) {
  let limit: number
  let days: number
  let override: number | undefined
  try {
    limit = foundingLimit()
    days = foundingDays()
    override = salesOpenedOverride()
  } catch {
    return { open: false as const }
  }
  const result = await persistentStore(
    ["EVAL", WINDOW, 3, reservedKey(), countKey(), openedKey(), now, override ?? ""],
    fetcher,
  )
  const [count, reserved, opened] = Array.isArray(result) ? result : []
  const counted = Number(count)
  const held = Number(reserved)
  const openedAt = opened === "" || opened === null || opened === undefined ? undefined : Number(opened)
  if (!Number.isSafeInteger(counted) || !Number.isSafeInteger(held) || (openedAt !== undefined && !(openedAt > 0)))
    throw storeError()
  const closesAt = openedAt === undefined ? undefined : openedAt + days * DAY_MS
  const open = counted + held < limit && (closesAt === undefined || now < closesAt)
  return { open, counted, reserved: held, ...(closesAt === undefined ? {} : { closesAt }) }
}

/** Whether a checkout now could still become a founding membership (the listing's readiness check). */
export async function foundingWindowOpen(fetcher: typeof fetch = fetch, now = Date.now()) {
  return (await foundingWindow(fetcher, now)).open
}

/**
 * Reserves the founding slot `token` for `account`'s checkout until `until` (ms). False when the window is closed or full,
 * its settings are invalid, or the account already has (or had) a founding membership; the checkout then sells no
 * founding membership.
 */
export async function reserveFoundingSlot(
  token: string,
  until: number,
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!validFoundingToken(token)) throw storeError()
  let limit: number
  let days: number
  let override: number | undefined
  try {
    limit = foundingLimit()
    days = foundingDays()
    override = salesOpenedOverride()
  } catch {
    // Invalid settings close the window, as in foundingWindow: the checkout goes ahead without founding.
    return false
  }
  const result = await persistentStore(
    [
      "EVAL",
      RESERVE,
      4,
      reservedKey(),
      countKey(),
      openedKey(),
      memberKey(account),
      token,
      until,
      now,
      limit,
      days * DAY_MS,
      override ?? "",
    ],
    fetcher,
  )
  if (result !== 0 && result !== 1) throw storeError()
  return result === 1
}

/** Gives a slot back: its checkout expired or was replaced. Idempotent. */
export async function releaseFoundingSlot(token: string, fetcher: typeof fetch = fetch) {
  if (!validFoundingToken(token)) return
  await persistentStore(["ZREM", reservedKey(), token], fetcher)
}

// ── Members ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type FoundingMember = {
  number: number
  token: string
  /** The subscription that carries the membership now (the first one, then each upgrade's). */
  subscription: string
  at: number
  listed: boolean
  ended?: number
}

function decodeMember(raw: unknown): FoundingMember | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const fields = new Map<string, string>()
  for (let index = 0; index + 1 < raw.length; index += 2) fields.set(String(raw[index]), String(raw[index + 1]))
  const number = Number(fields.get("number"))
  const at = Number(fields.get("at"))
  const ended = fields.has("ended") ? Number(fields.get("ended")) : undefined
  const token = fields.get("token")
  const subscription = fields.get("subscription")
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !Number.isSafeInteger(at) ||
    !validFoundingToken(token) ||
    !subscription ||
    (ended !== undefined && !Number.isSafeInteger(ended))
  )
    throw storeError()
  return {
    number,
    token,
    subscription,
    at,
    listed: fields.get("listed") === "1",
    ...(ended === undefined ? {} : { ended }),
  }
}

/** The account's founding record, current or ended, or undefined when it never had one. */
export async function readFoundingMember(account: string, fetcher: typeof fetch = fetch) {
  return decodeMember(await persistentStore(["EVAL", READ, 1, memberKey(account)], fetcher))
}

/**
 * The account's founding number for `token`, assigned now if it has none: one script reads or writes the record, so a
 * replayed or parallel payment gets the same number and the count rises once (M13). A token is only ever put on a
 * subscription whose slot was reserved, so assignment never checks the window again.
 */
export async function assignFoundingNumber(
  account: string,
  token: string,
  subscription: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!validFoundingToken(token)) throw storeError()
  const member = decodeMember(
    await persistentStore(
      ["EVAL", ASSIGN, 3, memberKey(account), countKey(), reservedKey(), token, subscription, now],
      fetcher,
    ),
  )
  if (!member) throw storeError()
  return member
}

/** A subscription of the account as reconcile lists it: its id, Stripe status and founding token, if any. */
export type FoundingSubscription = { id: string; status: string; token?: string }

/** Stripe statuses after which a subscription can never be paid again. */
const FINISHED = new Set(["canceled", "incomplete_expired"])

/**
 * Brings the account's founding membership in line with its subscriptions, inside reconcile, and answers what its
 * snapshot carries (`founding: {number, boost}`), or undefined:
 * - the governing paid month carrying a token assigns the number (once);
 * - when that month is an upgrade carrying the member's token, the membership moves to it;
 * - when the subscription carrying it is deleted and no other live subscription carries the token, it ends for good;
 * - `boost` holds while the governing subscription carries the token on a plan with a founding boost (Plus, Pro);
 * - a founder who chose the founders page is hidden from it while the plan is frozen and shown again after (§4.4). This
 *   happens here, not only in the `founding` provisioner, so it holds whether or not `founding` is still listed.
 * Accounts whose subscriptions carry no token make no store call.
 */
export async function settleFounding(
  input: {
    account: string
    /** The governing subscription's paid month, only while the account is active. */
    paid?: { id: string; token?: string }
    governing?: { id: string; plan: PlanId }
    subscriptions: readonly FoundingSubscription[]
    /** Whether the snapshot this reconcile writes is frozen (a dispute, a fraud warning or the owner's hold). */
    frozen?: boolean
    now: number
  },
  fetcher: typeof fetch = fetch,
): Promise<{ number: number; boost: boolean } | undefined> {
  if (!input.subscriptions.some((subscription) => validFoundingToken(subscription.token))) return undefined
  let member = await readFoundingMember(input.account, fetcher)
  if (!member && input.paid && validFoundingToken(input.paid.token))
    member = await assignFoundingNumber(input.account, input.paid.token, input.paid.id, fetcher, input.now)
  if (!member || member.ended !== undefined) return undefined
  const paid = input.paid
  if (paid && paid.token === member.token && paid.id !== member.subscription) {
    const moved = await persistentStore(["EVAL", CARRY, 1, memberKey(input.account), paid.id], fetcher)
    if (moved !== 0 && moved !== 1) throw storeError()
    member = { ...member, subscription: paid.id }
  }
  const carrier = input.subscriptions.find((subscription) => subscription.id === member!.subscription)
  const carried = input.subscriptions.some(
    (subscription) =>
      subscription.id !== carrier?.id && subscription.token === member!.token && !FINISHED.has(subscription.status),
  )
  if (carrier?.status === "canceled" && !carried) {
    await persistentStore(
      ["EVAL", END, 3, memberKey(input.account), listedKey(), namesKey(), input.account, input.now],
      fetcher,
    )
    return undefined
  }
  if (member.listed) await syncFoundersListing(input.account, input.frozen === true, fetcher)
  const governing = input.governing
  const token = governing && input.subscriptions.find((subscription) => subscription.id === governing.id)?.token
  return {
    number: member.number,
    boost: !!governing && token === member.token && ENTITLEMENTS[governing.plan].foundingBoost !== null,
  }
}

// ── The founders page ────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a display name may be shown: 1–40 letters, digits, spaces and . ' _ -, starting with a letter or digit. */
export function validFoundersName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    [...value].length >= 1 &&
    [...value].length <= FOUNDING.nameMax &&
    /^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u.test(value) &&
    !/\s{2}/.test(value)
  )
}

/**
 * A founder's choice for the founders page. Shown only while listed and the plan is not frozen (`hidden`). False when
 * the account is not a current founding member.
 */
export async function setFoundersListing(
  account: string,
  choice: { listed: boolean; name?: string },
  hidden: boolean,
  fetcher: typeof fetch = fetch,
) {
  if (choice.name !== undefined && !validFoundersName(choice.name))
    throw new ApiError(400, "FOUNDERS_NAME_INVALID", "Use up to 40 letters, numbers, spaces, dots or dashes.")
  const result = await persistentStore(
    [
      "EVAL",
      OPT,
      3,
      memberKey(account),
      listedKey(),
      namesKey(),
      account,
      choice.listed ? "1" : "0",
      choice.listed ? (choice.name ?? "") : "",
      hidden ? "1" : "0",
    ],
    fetcher,
  )
  if (result !== 0 && result !== 1) throw storeError()
  return result === 1
}

/** The display name a founder chose for the founders page, if any. */
export async function readFoundersName(account: string, fetcher: typeof fetch = fetch) {
  const name = await persistentStore(["HGET", namesKey(), account], fetcher)
  return validFoundersName(name) ? name : undefined
}

/** Converges the account's place on the founders page with its record and plan state (the `founding` provisioner). */
export async function syncFoundersListing(account: string, hidden: boolean, fetcher: typeof fetch = fetch) {
  const result = await persistentStore(
    ["EVAL", SYNC, 2, memberKey(account), listedKey(), account, hidden ? "1" : "0"],
    fetcher,
  )
  if (result !== 0 && result !== 1) throw storeError()
  return result === 1
}

/** Account deletion (P5): the founding record, its place on the founders page and its name go. The count stays. */
export async function eraseFounding(account: string, fetcher: typeof fetch = fetch) {
  await persistentStore(["EVAL", ERASE, 3, memberKey(account), listedKey(), namesKey(), account], fetcher)
}

/** The founders page's random slug, made the first time anyone asks. */
export async function foundersSlug(fetcher: typeof fetch = fetch) {
  const stored = await persistentStore(["GET", slugKey()], fetcher)
  if (typeof stored === "string" && /^[A-Za-z0-9_-]{22}$/.test(stored)) return stored
  await persistentStore(["SET", slugKey(), randomBytes(16).toString("base64url"), "NX"], fetcher)
  const made = await persistentStore(["GET", slugKey()], fetcher)
  if (typeof made !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(made)) throw storeError()
  return made
}

/** The founders page's address on the website, for founders to share: by slug until it is public. */
export function foundersPageUrl(origin: string, slug: string) {
  return `${origin}/founders#${slug}`
}

export type Founder = { number: number; name?: string }

/**
 * The founders page: every listed founder by number, with the display name they chose. Public once
 * `FOUNDING.publicAfter` founders are listed; before that only a request with the right slug sees it (404 otherwise).
 */
export async function foundersPage(slug: string | undefined, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(["EVAL", LIST, 2, listedKey(), namesKey()], fetcher)
  if (!Array.isArray(raw) || raw.length % 2) throw storeError()
  const founders: Founder[] = []
  for (let index = 0; index < raw.length; index += 2) {
    const number = Number(raw[index])
    const name = String(raw[index + 1] ?? "")
    if (!Number.isSafeInteger(number) || number < 1) throw storeError()
    founders.push({ number, ...(name && validFoundersName(name) ? { name } : {}) })
  }
  const open = founders.length >= FOUNDING.publicAfter
  if (!open) {
    const stored = await persistentStore(["GET", slugKey()], fetcher)
    if (typeof stored !== "string" || !slug || !sameSecret(slug, stored))
      throw new ApiError(404, "FOUNDERS_NOT_PUBLIC", "This page is not public yet.")
  }
  return { public: open, founders }
}

/** A founder's badge as SVG: "Vector Codium founding member #N", with the display name when one is shown. */
export function foundersBadge(founder: Founder) {
  const label = `Founding member #${founder.number}`
  const name = founder.name ? escapeXml(founder.name) : ""
  const width = 260
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="56" viewBox="0 0 ${width} 56" role="img" aria-label="Vector Codium ${escapeXml(label)}${name ? `: ${name}` : ""}">`,
    `<rect width="${width}" height="56" rx="10" fill="#17122b"/>`,
    `<rect x="1" y="1" width="${width - 2}" height="54" rx="9" fill="none" stroke="#8b5cf6" stroke-opacity="0.6"/>`,
    `<text x="16" y="23" fill="#c4b5fd" font-family="system-ui, sans-serif" font-size="12">Vector Codium</text>`,
    `<text x="16" y="42" fill="#ffffff" font-family="system-ui, sans-serif" font-size="15" font-weight="600">${escapeXml(label)}</text>`,
    name
      ? `<text x="${width - 16}" y="42" fill="#c4b5fd" font-family="system-ui, sans-serif" font-size="12" text-anchor="end">${name}</text>`
      : "",
    "</svg>",
  ].join("")
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

function sameSecret(given: string, stored: string) {
  const a = createHash("sha256").update(given).digest()
  const b = createHash("sha256").update(stored).digest()
  return timingSafeEqual(a, b)
}

function integerSetting(name: string, fallback: number, min: number, max: number) {
  const configured = process.env[name]?.trim()
  if (!configured) return fallback
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configurationError()
  return value
}

function configurationError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}

function storeError() {
  return new ApiError(503, "CODIUM_FOUNDING_UNAVAILABLE", "Founding membership could not be read. Try again.")
}
