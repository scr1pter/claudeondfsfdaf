import { ACCOUNT_ID_PATTERN, installationPlatform, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { ApiError } from "../http.js"
import { appendAudit, type AuditEvent, type ERASE_REASONS } from "./audit.js"
import { PLACE_PATTERN, installationAuthority, linkMember, parseLinkMember, readInstall, readInstallState, type InstallRecord } from "./identity.js"
import { authorizedCommands, authorityChanged, fencedStore } from "./authority.js"
import { randomBytes } from "node:crypto"
import { jobEraser } from "./jobs.js"
import { eraseJiraTaskAccount, eraseJiraTaskInstallation } from "./jira/task-store.js"
import { everywhereKeys, userIdValid } from "./keys.js"
import { deleteKeys, everywhereStore, getValue, removeMembers, setMembers, type Store } from "./store.js"

/*
 * Erasing (contract E13). Slack `app_uninstalled` and `tokens_revoked`, Linear's revocation, a disconnect on
 * vectordev.ai and account deletion remove the installation, its links, its mappings and its live job bodies.
 *
 * Every record is found through its index set (identity.ts writes the index before the record), so nothing scans the
 * store. Live jobs belong to the jobs module (VE-05, jobs.ts), which erases them through the `jobs` seam.
 *
 * R-C9: Codium's account deletion runs `EVERYWHERE_ERASE_PART` once codium-erase.ts imports this module and registers
 * it with `registerErasePart` (Codium's file, so the registration line is theirs).
 */

export type EraseReason = Exclude<(typeof ERASE_REASONS)[number], "unlinked">

/** The jobs module's half of erasing (VE-05): cancel live jobs and erase their bodies. */
export type JobEraser = {
  readonly installation: (installation: string, store?: Store) => Promise<void>
  readonly account: (account: string) => Promise<void>
}

/** A platform adapter's chance to revoke the installation's token before its record goes (best effort). */
export type RevocationOutcome = "confirmed" | "uncertain"
export type InstallRevoker = (installation: string, record: InstallRecord, beforeRequest: () => Promise<void>) => Promise<RevocationOutcome>

export type EraseContext = {
  readonly store: Store
  readonly accountAuthority?: import("./authority.js").AccountAuthorityPort
  readonly now: number
  readonly jobs?: JobEraser
  readonly revoke?: InstallRevoker
}

export type InstallationErased = {
  /** An installation record existed. */
  readonly installed: boolean
  readonly links: number
  readonly mappings: number
  /** Local contents are erased, but a native outcome cannot safely permit reconnect. */
  readonly nativePending?: true
}

const EVENT: Readonly<Record<EraseReason, AuditEvent>> = {
  uninstalled: "uninstall",
  "tokens-revoked": "uninstall",
  revoked: "uninstall",
  disconnected: "disconnect",
  "account-deleted": "erase",
}

function report(step: string) {
  console.error("Vector everywhere: an erase step failed", { step })
}

/**
 * Erases an installation: its live jobs, every link made on it, every mapping, and last its record (and so its token).
 * The connector's log records why, and every linked account's log records the unlink, except the log of an account
 * being deleted. Safe to run again: a second run finds nothing, and a run that stopped part way (a store error, a job
 * that kept changing) leaves the record in place, so the disconnect, the platform's retry or the account deletion's
 * next pass can run it again and erase what is left.
 */
export async function eraseInstallation(
  ctx: EraseContext,
  installation: string,
  reason: EraseReason,
  options: { readonly deletedAccount?: string; readonly expected?: { readonly record: InstallRecord; readonly raw: string };
    readonly control?: { readonly key: string; readonly ttlMs: number } } = {},
): Promise<InstallationErased> {
  const platform = installationPlatform(installation)
  if (!platform) throw new RangeError("Not an installation key.")
  const deleted = options.deletedAccount?.toLowerCase()
  const snapshot = await readInstallState(ctx.store, installation)
  if (!snapshot) return { installed: false, links: 0, mappings: 0 }
  const expected = options.expected ?? snapshot
  if (snapshot.raw !== expected.raw && (!snapshot.record.closing || snapshot.record.closing.authority !== installationAuthority(expected) || snapshot.record.connector !== expected.record.connector)) throw authorityChanged()
  let record = snapshot.record
  let closing: NonNullable<InstallRecord["closing"]> = record.closing ?? { id: randomBytes(16).toString("base64url"), at: ctx.now, reason, authority: installationAuthority(snapshot),
    ...(ctx.revoke && record.tokenEnc ? { revocation: "pending" as const } : {}) }
  const revocationOwner = !record.closing && closing.revocation === "pending"
  let raw = record.closing ? snapshot.raw : JSON.stringify({ ...record, closing })
  if (!record.closing) {
    await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: expected.raw },
      ...(options.control ? [{ key: options.control.key }] : [])], [
      ["SET", everywhereKeys.install(installation), raw], ["SET", everywhereKeys.installEpoch(installation), closing.id], ["ZADD", everywhereKeys.closingInstalls(), ctx.now, installation],
      ...(options.control ? [["SET", options.control.key, `${closing.authority}:${closing.id}`, "PX", options.control.ttlMs]] : []),
    ])
  } else if (options.control && !await getValue(ctx.store, options.control.key)) {
    await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: raw }, { key: options.control.key }], [
      ["SET", options.control.key, `${closing.authority}:${closing.id}`, "PX", options.control.ttlMs],
    ])
  }
  if (revocationOwner && ctx.revoke) {
    const capturedClosing = raw
    let outcome: RevocationOutcome = "uncertain"
    try {
      outcome = await ctx.revoke(installation, record, async () => {
        if (await getValue(ctx.store, everywhereKeys.install(installation)) !== capturedClosing) throw authorityChanged()
      })
    } catch { report("revoke") }
    const current = await readInstallState(ctx.store, installation)
    if (!current?.record.closing || current.record.closing.id !== closing.id || current.record.closing.authority !== closing.authority || current.record.connector !== record.connector) throw authorityChanged()
    // A concurrent local scrub can retain this same closing generation; it never turns a different grant into A.
    record = current.record
    closing = { ...current.record.closing, revocation: outcome === "confirmed" ? "confirmed" : "uncertain" }
    raw = JSON.stringify({ ...record, closing })
    await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: current.raw }], [["SET", everywhereKeys.install(installation), raw]])
  }
  // Closing changes the captured value before the first cleanup. Every stale admission now fails its atomic proof.
  const scoped = { ...ctx, store: fencedStore(ctx.store, [{ key: everywhereKeys.install(installation), value: raw }]) }
  const first = await eraseContents(scoped, installation, platform, reason, deleted, closing.authority)
  const late = await eraseContents(scoped, installation, platform, reason, deleted, closing.authority)
  if (closing.revocation === "pending" || closing.revocation === "uncertain") {
    // Never let a second caller finalize a grant while the first revoke may still reach the native service.
    // Private credentials/content still go, including during account deletion without an active-account adapter.
    closing = { ...closing, revocation: "uncertain" }
    const marker: InstallRecord = { connector: record.connector, ...(record.revision ? { revision: record.revision } : {}), scopes: [], installedAt: record.installedAt, closing }
    await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: raw }], [["SET", everywhereKeys.install(installation), JSON.stringify(marker)]])
    return { installed: true, links: first.links + late.links, mappings: first.mappings + late.mappings, nativePending: true }
  }
  await authorizedCommands(ctx.store, [{ key: everywhereKeys.install(installation), value: raw }], [
    ["DEL", everywhereKeys.install(installation), everywhereKeys.installHold(installation, closing.authority)], ["SREM", everywhereKeys.installs(record.connector), installation],
    ["ZREM", everywhereKeys.closingInstalls(), installation],
  ])

  if (record && record.connector !== deleted)
    await appendAudit(
      ctx.store,
      record.connector,
      { event: EVENT[reason], platform, installation, code: reason },
      ctx.now, ctx.accountAuthority,
    )
  return { installed: record !== undefined, links: first.links + late.links, mappings: first.mappings + late.mappings }
}

/** An installation's live jobs, links and mappings, each found through its index. */
async function eraseContents(
  ctx: EraseContext,
  installation: string,
  platform: PlatformId,
  reason: EraseReason,
  deleted: string | undefined,
  authority?: string,
): Promise<{ links: number; mappings: number }> {
  await (ctx.jobs ?? jobEraser(ctx.store, () => ctx.now)).installation(installation, ctx.store)
  if (platform === "jira" && authority) await eraseJiraTaskInstallation(ctx.store, installation, authority)

  let links = 0
  const linkedKey = everywhereKeys.linked(installation)
  for (const userId of await setMembers(ctx.store, linkedKey)) {
    if (!userIdValid(installation, userId)) continue
    const key = everywhereKeys.link(installation, userId)
    const raw = await getValue(ctx.store, key)
    await deleteKeys(ctx.store, key)
    const account = linkAccount(raw)
    if (!account) continue
    links++
    await removeMembers(ctx.store, everywhereKeys.links(account), linkMember(installation, userId))
    if (account !== deleted)
      await appendAudit(ctx.store, account, { event: "unlink", platform, installation, userId, code: reason }, ctx.now, ctx.accountAuthority)
  }
  await deleteKeys(ctx.store, linkedKey)

  let mappings = 0
  const reposKey = everywhereKeys.repos(installation)
  for (const place of await setMembers(ctx.store, reposKey)) {
    if (!PLACE_PATTERN.test(place)) continue
    mappings += await deleteKeys(ctx.store, everywhereKeys.repo(installation, place))
  }
  await deleteKeys(ctx.store, reposKey)
  return { links, mappings }
}

function linkAccount(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const account = (parsed as { account?: unknown } | null)?.account
    return typeof account === "string" && ACCOUNT_ID_PATTERN.test(account) ? account.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/**
 * Erases everything Vector everywhere keeps for an account (account deletion, R-C9): the installations it connected
 * (with their links, mappings and jobs), its links on other people's installations, its live link code, its jobs and
 * its audit log.
 */
export async function eraseEverywhereAccount(ctx: EraseContext, account: string): Promise<void> {
  const owner = account.toLowerCase()
  // Permanent local tombstone precedes every read/cleanup; late writers cannot recreate any local account data.
  await ctx.store(["SET", everywhereKeys.accountClosed(owner), "closed"])
  const installsKey = everywhereKeys.installs(owner)
  for (const installation of await setMembers(ctx.store, installsKey)) {
    if (!installationPlatform(installation)) continue
    const snapshot = await readInstallState(ctx.store, installation)
    if (snapshot?.record.connector === owner)
      await eraseInstallation(ctx, installation, "account-deleted", { deletedAccount: owner, expected: snapshot })
  }

  const linksKey = everywhereKeys.links(owner)
  for (const member of await setMembers(ctx.store, linksKey)) {
    const parsed = parseLinkMember(member)
    if (!parsed) continue
    const key = everywhereKeys.link(parsed.installation, parsed.userId)
    const raw = await getValue(ctx.store, key)
    if (linkAccount(raw) !== owner) continue
    try {
      await authorizedCommands(ctx.store, [{ key, value: raw }], [["DEL", key],
        ["SREM", everywhereKeys.linked(parsed.installation), parsed.userId], ["SREM", linksKey, member]])
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "EVERYWHERE_AUTHORITY_CHANGED") throw error
    }
  }

  const pointer = everywhereKeys.linkCodes(owner)
  const code = await getValue(ctx.store, pointer)
  if (code !== undefined && /^[0-9a-f]{64}$/.test(code)) await deleteKeys(ctx.store, everywhereKeys.linkCode(code))

  await (ctx.jobs ?? jobEraser(ctx.store, () => ctx.now)).account(owner)
  await eraseJiraTaskAccount(ctx.store, owner)
  const states = await ctx.store(["ZRANGE", everywhereKeys.accountStates(owner), 0, 31])
  for (const state of Array.isArray(states) ? states : []) if (typeof state === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(state)) await deleteKeys(ctx.store, everywhereKeys.state(state))
  await deleteKeys(
    ctx.store,
    linksKey,
    installsKey,
    pointer,
    everywhereKeys.jobs(owner),
    everywhereKeys.seen(owner),
    everywhereKeys.audit(owner),
    everywhereKeys.accountStates(owner),
  )
}

/**
 * What Codium's account deletion hands each part (codium-erase.ts `EraseContext`): its fetcher, the deletion's clock,
 * and the real time by which a long part must stop. Repeated here, since this branch cannot import Codium's file.
 */
export type CodiumEraseContext = { readonly fetcher: typeof fetch; readonly now: number; readonly deadline?: number }

/** Whether this deployment has the store at all, as `persistentStore` reads it: a deployment without one holds nothing. */
export function everywhereStoreConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const url = env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim()
  const token = env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim()
  return Boolean(url && token)
}

/**
 * The part Codium's account deletion runs (R-C9), in the shape of Codium's `ErasePart`: `configured` says whether the
 * store exists (not whether the feature is on, so an account's records are erased after the feature was switched off),
 * and `erase` uses the deletion's own fetcher and clock, with the jobs module's eraser.
 */
export const EVERYWHERE_ERASE_PART = {
  id: "everywhere",
  configured: (): boolean => everywhereStoreConfigured(),
  erase: (account: string, context: CodiumEraseContext): Promise<void> => {
    const store = everywhereStore(context.fetcher)
    return eraseEverywhereAccount({ store, now: context.now, jobs: jobEraser(store, () => context.now) }, account)
  },
} as const
