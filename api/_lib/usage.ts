import { createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { UsageReport } from "../../packages/schema/src/usage-report.js"
import { UsageSummary } from "../../packages/schema/src/usage-summary.js"
import { verifyCliToken } from "./cli-token.js"
import { designLabOwners, requireDesignLabOwner } from "./design-lab.js"
import { ApiError, type ApiRequest } from "./http.js"

/**
 * Usage counts: how many installs and accounts use Vector each day and how much model use they report,
 * never what they do.
 * Rows live in Supabase behind the RPCs in docs/vector/owner-actions/sql/usage.sql and are
 * written only with the server's service-role key. Recording is best effort: every call is
 * bounded by a short timeout and its failure never reaches the request that triggered it.
 */

const RECORD_TIMEOUT_MS = 1_500
// Only the owner's dashboard waits on this, never a user's request.
const SUMMARY_TIMEOUT_MS = 8_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// The values of Node's process.platform and process.arch the CLI can run on.
const CLI_PLATFORMS = ["aix", "android", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos", "win32"] as const
const CLI_ARCHES = ["arm", "arm64", "ia32", "loong64", "ppc64", "riscv64", "s390x", "x64"] as const
// process.platform-process.arch, as the CLI reports it in x-vector-platform.
const CLI_PLATFORM = new RegExp(`^(${CLI_PLATFORMS.join("|")})-(${CLI_ARCHES.join("|")})$`)
// A share link's token: 32 random bytes, base64url. It travels in the page's address fragment and then in this
// header, never in a URL the server sees.
export const SHARE_HEADER = "x-vector-usage-share"
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/
// Models and custom effort levels used by fewer people than this are left off a shared link: a custom provider,
// model or effort name could point at one person or company. Vector's own effort levels name nobody.
const SHARE_MINIMUM_PEOPLE = 3
// Vector's own effort levels, as the engine labels them. Their labels come from here, never from a report.
const BUILT_IN_EFFORTS = new Map([
  ["default", "Default"],
  ["light", "Light"],
  ["balanced", "Balanced"],
  ["extra", "Extra"],
  ["max", "Max"],
])

const Version = Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(VERSION))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))
const InstallId = Schema.String.check(Schema.isUUID(4))

/**
 * The usage check-in, exactly as the desktop app and the CLI send it. The CLI's install ID is checked but not stored:
 * its counts are kept per account, so one person's terminals count once.
 */
export const Checkin = Schema.Union([
  Schema.Struct({
    installId: InstallId,
    client: Schema.Literal("desktop"),
    version: Version,
    platform: Schema.Literals(["darwin", "win32", "linux"]),
    arch: Schema.Literals(["x64", "arm64"]),
    sessions: Count,
    subagentSessions: Count,
    usage: Schema.optionalKey(UsageReport.Report),
  }),
  Schema.Struct({
    installId: InstallId,
    client: Schema.Literal("cli"),
    version: Version,
    platform: Schema.Literals(CLI_PLATFORMS),
    arch: Schema.Literals(CLI_ARCHES),
    usage: Schema.optionalKey(UsageReport.Report),
  }),
])
export const decodeCheckin = Schema.decodeUnknownOption(Checkin, { onExcessProperty: "error" })
const decodeSummary = Schema.decodeUnknownOption(UsageSummary.Summary)
// What the share-link functions in usage.sql answer.
const decodeOpened = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("ok"), expiresAt: Schema.String.check(Schema.isMaxLength(40)) }),
    Schema.Struct({ status: Schema.Literals(["expired", "revoked", "missing", "invalid"]) }),
  ]),
)
const decodeCreated = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("ok"), share: UsageSummary.Link }),
    Schema.Struct({ status: Schema.Literal("limit") }),
  ]),
)
const decodeListed = Schema.decodeUnknownOption(
  Schema.Struct({ status: Schema.Literal("ok"), shares: Schema.Array(UsageSummary.Link) }),
)
const decodeRevoked = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Literals(["ok", "missing"]) }))
const ShareRequest = Schema.Struct({
  label: Schema.String.check(
    Schema.makeFilter((label: string) => {
      const trimmed = label.trim()
      // No control characters: the label is the owner's own note, drawn as text in their list.
      return trimmed.length >= 1 && trimmed.length <= 80 && !/\p{Cc}/u.test(trimmed)
    }),
  ),
  days: Schema.Literals([7, 14, 30]),
})
export const decodeShareRequest = Schema.decodeUnknownOption(ShareRequest, { onExcessProperty: "error" })

export type UsageRecord =
  | {
      client: "desktop"
      installId: string
      accountId?: string
      version: string
      platform: string
      arch: string
      sessions: number
      subagentSessions: number
      usage?: UsageReport.Report
    }
  | { client: "cli"; accountId: string; version: string; platform: string; arch: string; usage?: UsageReport.Report }

/** Never rejects. Answers nothing when usage storage is not configured. */
export function recordUsage(input: UsageRecord, fetcher: typeof fetch = fetch) {
  return rpc("vector_usage_record", { request: input }, RECORD_TIMEOUT_MS, fetcher).then(
    () => undefined,
    () => undefined,
  )
}

/** Never rejects. */
export function recordDownload(
  input: { accountId: string; target: string; version: string },
  fetcher: typeof fetch = fetch,
) {
  if (!UUID.test(input.accountId)) return Promise.resolve()
  return rpc("vector_usage_download", { request: input }, RECORD_TIMEOUT_MS, fetcher).then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Records the CLI's daily account verification as one day of CLI use. Only a CLI that sends its
 * version also honours VECTOR_DISABLE_USAGE, so requests without these headers are not counted.
 * Never rejects.
 */
export async function recordCliUsage(
  request: Pick<ApiRequest, "headers">,
  accountId: string,
  fetcher: typeof fetch = fetch,
) {
  if (header(request, "x-vector-usage")?.trim().toLowerCase() === "off") return
  const version = header(request, "x-vector-version")?.trim()
  const platform = CLI_PLATFORM.exec(header(request, "x-vector-platform")?.trim() ?? "")
  if (!version || version.length > 32 || !VERSION.test(version)) return
  if (!platform?.[1] || !platform[2] || !UUID.test(accountId)) return
  await recordUsage({ client: "cli", accountId, version, platform: platform[1], arch: platform[2] }, fetcher)
}

/** Removes every count linked to an account. True only when storage confirmed it. */
export function forgetUsage(accountId: string, fetcher: typeof fetch = fetch) {
  if (!UUID.test(accountId)) return Promise.resolve(false)
  return rpc("vector_usage_forget", { account: accountId }, RECORD_TIMEOUT_MS, fetcher).then(
    (payload) => payload !== undefined,
    () => false,
  )
}

/** Everyone's counts but the dashboard owners' own: their accounts, installs and downloads are left out. */
export async function usageSummary(fetcher: typeof fetch = fetch) {
  const summary = Option.getOrUndefined(
    decodeSummary(await ownerRpc("vector_usage_summary", { excludeEmails: usageOwners() }, fetcher)),
  )
  if (!summary) throw unavailable()
  return {
    ...summary,
    efforts: summary.efforts.map((effort) => ({ ...effort, label: BUILT_IN_EFFORTS.get(effort.id) ?? effort.label })),
  }
}

/**
 * The summary as a read-only share link shows it: the same aggregates, without the models and custom effort levels
 * fewer than three accounts use (model use is kept only with an account, so its people are accounts), and without the
 * sessions and model use of a day fewer than three people were active, which could be one person's day. Shares stay
 * fractions of everyone's tokens, so what is left out shows as the remainder.
 */
export function shareableSummary(summary: UsageSummary.Summary): UsageSummary.Summary {
  return {
    ...summary,
    daily: summary.daily.map((day) =>
      day.active >= SHARE_MINIMUM_PEOPLE
        ? day
        : { ...day, sessions: 0, subagentSessions: 0, tokens: 0, cost: 0, tasks: 0 },
    ),
    models: summary.models.filter((model) => model.people >= SHARE_MINIMUM_PEOPLE),
    efforts: summary.efforts.filter(
      (effort) => BUILT_IN_EFFORTS.has(effort.id) || effort.people >= SHARE_MINIMUM_PEOPLE,
    ),
  }
}

/** The share token a request carries, undefined without one, or null when the header is there but malformed. */
export function shareToken(request: Pick<ApiRequest, "headers">) {
  const value = header(request, SHARE_HEADER)
  if (value === undefined) return undefined
  return SHARE_TOKEN.test(value.trim()) ? value.trim() : null
}

/** Checks a share link and counts one view. Answers when it stops working, or throws why it does not work. */
export async function openShare(token: string, fetcher: typeof fetch = fetch) {
  const opened = Option.getOrUndefined(
    decodeOpened(await ownerRpc("vector_usage_share_open", { tokenHash: shareHash(token) }, fetcher)),
  )
  if (!opened) throw unavailable()
  if (opened.status === "ok") return { expiresAt: opened.expiresAt }
  if (opened.status === "expired") throw new ApiError(410, "SHARE_EXPIRED", "This link has expired.")
  if (opened.status === "revoked") throw new ApiError(410, "SHARE_REVOKED", "This link has been turned off.")
  throw new ApiError(404, "SHARE_NOT_FOUND", "This link is not valid.")
}

/** Makes a share link. The token is returned once and only its hash is stored. */
export async function createShare(input: { label: string; days: 7 | 14 | 30 }, fetcher: typeof fetch = fetch) {
  const token = randomBytes(32).toString("base64url")
  const created = Option.getOrUndefined(
    decodeCreated(
      await ownerRpc(
        "vector_usage_share_create",
        { tokenHash: shareHash(token), label: input.label.trim(), days: input.days },
        fetcher,
      ),
    ),
  )
  if (!created) throw unavailable()
  if (created.status === "limit")
    throw new ApiError(409, "SHARE_LIMIT", "There are already 50 live links. Turn one off first.")
  return { token, share: created.share }
}

export async function listShares(fetcher: typeof fetch = fetch) {
  const listed = Option.getOrUndefined(decodeListed(await ownerRpc("vector_usage_share_list", {}, fetcher)))
  if (!listed) throw unavailable()
  return listed.shares
}

export async function revokeShare(id: string, fetcher: typeof fetch = fetch) {
  if (!UUID.test(id)) throw new ApiError(400, "SHARE_INVALID", "This link is not valid.")
  const revoked = Option.getOrUndefined(decodeRevoked(await ownerRpc("vector_usage_share_revoke", { id }, fetcher)))
  if (!revoked) throw unavailable()
  if (revoked.status === "missing") throw new ApiError(404, "SHARE_NOT_FOUND", "This link is not valid.")
}

/**
 * The account behind a desktop check-in, from the Vector account token the desktop already holds.
 * Undefined for a missing, forged or expired token: the check-in is then counted without an account.
 */
export function usageAccount(request: Pick<ApiRequest, "headers">) {
  const token = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header(request, "authorization") ?? "")?.[1]
  if (!token) return undefined
  const id = Option.getOrUndefined(Option.liftThrowable(verifyCliToken)(token))?.id
  return id && UUID.test(id) ? id : undefined
}

export function usageOwners() {
  const configured = process.env.VECTOR_ADMIN_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  return configured?.length ? configured : designLabOwners()
}

/** The same Google-only owner check as the Design Lab, against the admin allowlist. */
export function requireUsageOwner(request: Pick<ApiRequest, "headers">, fetcher: typeof fetch = fetch) {
  return requireDesignLabOwner(request, fetcher, usageOwners())
}

/**
 * Lets counting finish after the response without delaying it. Vercel keeps a function running
 * only for work registered with its request context, which is the hook @vercel/functions'
 * waitUntil reads; this repository does not depend on that package. Elsewhere the work runs on.
 */
export function afterResponse(work: Promise<unknown>) {
  const settled = work.then(
    () => undefined,
    () => undefined,
  )
  const context = Reflect.get(globalThis, Symbol.for("@vercel/request-context")) as
    | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }
    | undefined
  context?.get?.()?.waitUntil?.(settled)
}

function shareHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function unavailable() {
  return new ApiError(503, "USAGE_UNAVAILABLE", "Usage counts are not available right now.")
}

/** For the owner's dashboard and its share links: unconfigured or failing storage is reported as unavailable. */
async function ownerRpc(name: string, request: unknown, fetcher: typeof fetch) {
  const payload = await rpc(name, { request }, SUMMARY_TIMEOUT_MS, fetcher).catch(() => {
    throw unavailable()
  })
  if (payload === undefined) throw unavailable()
  return payload
}

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function storage() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) return undefined
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    return undefined
  return { url, key }
}

/** Undefined when usage storage is not configured; rejects when it is configured but fails. */
async function rpc(name: string, body: unknown, timeout: number, fetcher: typeof fetch) {
  const target = storage()
  if (!target) return undefined
  const response = await fetcher(`${target.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: { "content-type": "application/json", apikey: target.key, authorization: `Bearer ${target.key}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Usage storage answered ${response.status}`)
  }
  return boundedJson(response)
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  const state = { bytes: 0 }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.bytes += next.value.byteLength
    if (state.bytes > 1_000_000) {
      await reader.cancel().catch(() => undefined)
      throw new Error("Usage storage answered too much")
    }
    chunks.push(next.value)
  }
  return Option.getOrNull(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
  )
}
