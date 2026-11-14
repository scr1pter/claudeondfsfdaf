import { createHash, randomBytes } from "node:crypto"
import type { Entitlements } from "../../packages/schema/src/codium-entitlements.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The report tracker (WP A33). A bug report gets a random id, `r_` and 26 base32 letters, which the desktop keeps with a
 * short title of its own. The server keeps only metadata under that id for 180 days: when it arrived, the status the
 * owner sets, and the plan tag. Never the message, the reply address or anything else the person wrote (P4), as the
 * privacy draft (A30, `#report-tracking`) says. The owner sets statuses with `script/report-status.ts`; the public
 * changelog lists `sha256(id)[0:16]` for each report a release fixed, so the desktop can say "A problem you reported
 * is fixed in this version" without asking anyone.
 *
 * Keys (contract §4.6, under the Codium prefix): `reports:<id>` holds the record, and `reports:acct:<hash>` is the set
 * of ids an account sent while signed in, kept only so deleting the account can erase them (A57).
 *
 * The tracker is free and has nothing to do with Stripe, but the prefix follows the Stripe mode, and production writes
 * under `test` until a live key is configured. So a live server reads and erases under both prefixes (`reportModes`),
 * and a report sent before go-live keeps its status and is still erased with its account. A test server never reads
 * the live prefix.
 */

export const REPORT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000
export const REPORT_ID = /^r_[a-z2-7]{26}$/
/** The statuses the owner sets. Clients read any status they do not know as "received". */
export const REPORT_STATUSES = ["received", "read", "fixing", "fixed", "closed"] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]
export type ReportTag = Entitlements["reports"]["tag"]

export type ReportRecord = {
  v: 1
  status: ReportStatus
  createdAt: number
  updatedAt: number
  /** The plan tag, while a plan was active when the report was sent. */
  tag?: ReportTag
  readFirst?: boolean
  /** The release that fixed it, and the fixing commit. */
  fixedIn?: string
  commit?: string
}

/** What anyone holding a report's id may read about it. */
export type ReportView = {
  id: string
  status: ReportStatus
  updatedAt: number
  fixedIn?: string
  commit?: string
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const COMMIT = /^[0-9a-f]{7,40}$/
const TAGS: readonly ReportTag[] = ["plus", "pro", "max", "ultra"]
const RECORD_FIELDS = new Set(["v", "status", "createdAt", "updatedAt", "tag", "readFirst", "fixedIn", "commit"])

/** Whether bug reports can reach the owner from this deployment (the same settings `api/support/bug-report.ts` needs). */
export function reportEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() &&
      process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim() &&
      process.env.VECTOR_BUG_REPORT_TO?.trim(),
  )
}

/** A new report id: `r_` and 26 letters of lower-case base32, 130 random bits. */
export function newReportId() {
  const bytes = randomBytes(17)
  let bits = 0
  let value = 0
  let text = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && text.length < 26) {
      text += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return `r_${text}`
}

export function validReportId(value: unknown): value is string {
  return typeof value === "string" && REPORT_ID.test(value)
}

/** What the public changelog lists for a fixed report: the first 16 hex digits of the id's SHA-256. */
export function reportHash(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

export function validReportVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value)
}

export function validReportCommit(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value)
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return REPORT_STATUSES.some((status) => status === value)
}

export const reportKey = (id: string, mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "reports", id) : codiumKey("reports", id)

/** The account's index of report ids. The account id is hashed, so the key names no one. */
export const accountReportsKey = (account: string, mode: StripeMode = stripeMode()) =>
  codiumKeyIn(mode, "reports", "acct", createHash("sha256").update(`vector-report-account:${account}`).digest("hex"))

/** The prefixes reports are read and erased under: the current mode first, and on a live server the test one too. */
export function reportModes(mode: StripeMode = stripeMode()): StripeMode[] {
  return mode === "live" ? ["live", "test"] : ["test"]
}

/** The subject tag on the owner's email: `[Plus]`, `[Pro]`, `[Max · read first]`, `[Ultra · read first]`. */
export function reportSubjectTag(reports: Pick<Entitlements["reports"], "tag" | "readFirst">) {
  const name = reports.tag.charAt(0).toUpperCase() + reports.tag.slice(1)
  return `[${name}${reports.readFirst ? " · read first" : ""}]`
}

/** A stored record, or undefined for anything that is not exactly one this module writes. */
export function decodeReportRecord(raw: unknown): ReportRecord | undefined {
  if (typeof raw !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !RECORD_FIELDS.has(key))) return undefined
  if (
    record.v !== 1 ||
    !isReportStatus(record.status) ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.updatedAt) ||
    (record.tag !== undefined && !TAGS.includes(record.tag as ReportTag)) ||
    (record.readFirst !== undefined && typeof record.readFirst !== "boolean") ||
    (record.fixedIn !== undefined && !validReportVersion(record.fixedIn)) ||
    (record.commit !== undefined && !validReportCommit(record.commit))
  )
    return undefined
  return record as ReportRecord
}

/**
 * Stores a new report's record, and links it to the account that sent it while signed in. Only the fields below are
 * written; the caller has no way to pass the message or the reply address. Returns false when the store could not be
 * written, and the report then goes out without an id.
 */
export async function createReportRecord(
  id: string,
  input: { tag?: ReportTag; readFirst?: boolean; account?: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!validReportId(id)) return false
  const record: ReportRecord = {
    v: 1,
    status: "received",
    createdAt: now,
    updatedAt: now,
    ...(input.tag && TAGS.includes(input.tag) ? { tag: input.tag, readFirst: input.readFirst === true } : {}),
  }
  try {
    const written = await persistentStore(
      ["SET", reportKey(id), JSON.stringify(record), "PX", REPORT_RETENTION_MS, "NX"],
      fetcher,
    )
    if (written !== "OK") return false
    if (input.account) {
      const index = accountReportsKey(input.account)
      await persistentStore(["SADD", index, id], fetcher)
      await persistentStore(["PEXPIRE", index, REPORT_RETENTION_MS], fetcher)
    }
    return true
  } catch {
    return false
  }
}

/** Removes a record whose report never went out. Best effort: it expires on its own anyway. */
export async function discardReportRecord(id: string, account: string | undefined, fetcher: typeof fetch = fetch) {
  await persistentStore(["DEL", reportKey(id)], fetcher).catch(() => undefined)
  if (account) await persistentStore(["SREM", accountReportsKey(account), id], fetcher).catch(() => undefined)
}

/**
 * The public view of each id that has a record. Ids without one (never stored, or older than 180 days) are left out. A
 * live server also looks under the test prefix, where reports sent before go-live are (`reportModes`).
 */
export async function readReportViews(ids: readonly string[], fetcher: typeof fetch = fetch): Promise<ReportView[]> {
  const unique = [...new Set(ids.filter(validReportId))]
  if (!unique.length) return []
  const modes = reportModes()
  const raw = await persistentStore(
    ["MGET", ...modes.flatMap((mode) => unique.map((id) => reportKey(id, mode)))],
    fetcher,
  )
  if (!Array.isArray(raw) || raw.length !== unique.length * modes.length) return []
  return unique.flatMap((id, index) => {
    const record = modes
      .map((_, at) => decodeReportRecord(raw[at * unique.length + index]))
      .find((value) => value !== undefined)
    if (!record) return []
    return [
      {
        id,
        status: record.status,
        updatedAt: record.updatedAt,
        ...(record.fixedIn ? { fixedIn: record.fixedIn } : {}),
        ...(record.commit ? { commit: record.commit } : {}),
      },
    ]
  })
}

/**
 * Sets a report's status, for the owner's script. `fixed` needs the release that fixed it. The record keeps its
 * expiry, and a report that is gone (never stored, expired, or erased with its account) is never created again.
 * Returns the updated record, or undefined when the report is not in the store under `mode`.
 */
export async function setReportStatus(
  id: string,
  update: { status: ReportStatus; fixedIn?: string; commit?: string },
  options: { mode?: StripeMode; fetcher?: typeof fetch; now?: number } = {},
) {
  if (!validReportId(id)) throw new Error("A report id is r_ followed by 26 letters and digits.")
  if (!isReportStatus(update.status)) throw new Error(`A status is one of: ${REPORT_STATUSES.join(", ")}.`)
  if (update.fixedIn !== undefined && !validReportVersion(update.fixedIn))
    throw new Error("The fixing release is a version like 1.99.114.")
  if (update.commit !== undefined && !validReportCommit(update.commit))
    throw new Error("The fixing commit is 7 to 40 lower-case hex digits.")
  if (update.status === "fixed" && !update.fixedIn) throw new Error("A fixed report needs the release that fixed it.")
  const fetcher = options.fetcher ?? fetch
  const key = reportKey(id, options.mode)
  const current = decodeReportRecord(await persistentStore(["GET", key], fetcher))
  if (!current) return undefined
  const { fixedIn: _fixedIn, commit: _commit, ...kept } = current
  const next: ReportRecord = {
    ...kept,
    status: update.status,
    updatedAt: options.now ?? Date.now(),
    // A release and commit belong to a fix; another status drops them unless given again.
    ...(update.fixedIn ? { fixedIn: update.fixedIn } : {}),
    ...(update.commit ? { commit: update.commit } : {}),
  }
  const written = await persistentStore(["SET", key, JSON.stringify(next), "XX", "KEEPTTL"], fetcher)
  return written === "OK" ? next : undefined
}

/**
 * Erases every report an account sent while signed in, and the index itself (for account deletion, A57), under every
 * prefix reports are read from (`reportModes`), so reports sent before go-live go too. Reports sent signed out were
 * never linked to anyone. Returns how many records were erased.
 */
export async function eraseAccountReports(account: string, fetcher: typeof fetch = fetch) {
  let erased = 0
  for (const mode of reportModes()) {
    const index = accountReportsKey(account, mode)
    const members = await persistentStore(["SMEMBERS", index], fetcher)
    const ids = Array.isArray(members) ? members.filter(validReportId) : []
    if (ids.length)
      erased += Number(await persistentStore(["DEL", ...ids.map((id) => reportKey(id, mode))], fetcher)) || 0
    await persistentStore(["DEL", index], fetcher)
  }
  return erased
}
