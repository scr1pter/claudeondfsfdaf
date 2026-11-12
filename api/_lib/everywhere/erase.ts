import { ACCOUNT_ID_PATTERN, installationPlatform, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { appendAudit, type AuditEvent, type ERASE_REASONS } from "./audit.js"
import { PLACE_PATTERN, installationAuthority, linkMember, parseLinkMember, readInstall, readInstallSnapshot, type InstallRecord } from "./identity.js"
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
  readonly installation: (installation: string) => Promise<void>
  readonly account: (account: string) => Promise<void>
}

/** A platform adapter's chance to revoke the installation's token before its record goes (best effort). */
export type InstallRevoker = (installation: string, record: InstallRecord) => Promise<void>

export type EraseContext = {
  readonly store: Store
  readonly now: number
  readonly jobs?: JobEraser
  readonly revoke?: InstallRevoker
}

export type InstallationErased = {
  /** An installation record existed. */
  readonly installed: boolean
  readonly links: number
  readonly mappings: number
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
  options: { readonly deletedAccount?: string } = {},
): Promise<InstallationErased> {
  const platform = installationPlatform(installation)
  if (!platform) throw new RangeError("Not an installation key.")
  const deleted = options.deletedAccount?.toLowerCase()
  const snapshot = await readInstallSnapshot(ctx.store, installation)
  const record = snapshot?.record
  if (record && ctx.revoke) await ctx.revoke(installation, record).catch(() => report("revoke"))

  const first = await eraseContents(ctx, installation, platform, reason, deleted, snapshot && installationAuthority(snapshot))
  // The record last, with its place in the connector's index: from here on nothing new is linked, mapped or posted.
  await deleteKeys(ctx.store, everywhereKeys.install(installation))
  if (record) await removeMembers(ctx.store, everywhereKeys.installs(record.connector), installation)
  // Once more without the record, for anything a call that passed its installation check just before the record went
  // wrote while the steps above ran. It usually finds nothing.
  const late = await eraseContents(ctx, installation, platform, reason, deleted, snapshot && installationAuthority(snapshot))

  if (record && record.connector !== deleted)
    await appendAudit(
      ctx.store,
      record.connector,
      { event: EVENT[reason], platform, installation, code: reason },
      ctx.now,
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
  if (ctx.jobs) await ctx.jobs.installation(installation)
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
      await appendAudit(ctx.store, account, { event: "unlink", platform, installation, userId, code: reason }, ctx.now)
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
  const installsKey = everywhereKeys.installs(owner)
  for (const installation of await setMembers(ctx.store, installsKey)) {
    if (!installationPlatform(installation)) continue
    const record = await readInstall(ctx.store, installation)
    if (record?.connector === owner)
      await eraseInstallation(ctx, installation, "account-deleted", { deletedAccount: owner })
  }

  const linksKey = everywhereKeys.links(owner)
  for (const member of await setMembers(ctx.store, linksKey)) {
    const parsed = parseLinkMember(member)
    if (!parsed) continue
    const key = everywhereKeys.link(parsed.installation, parsed.userId)
    if (linkAccount(await getValue(ctx.store, key)) !== owner) continue
    await deleteKeys(ctx.store, key)
    await removeMembers(ctx.store, everywhereKeys.linked(parsed.installation), parsed.userId)
  }

  const pointer = everywhereKeys.linkCodes(owner)
  const code = await getValue(ctx.store, pointer)
  if (code !== undefined && /^[0-9a-f]{64}$/.test(code)) await deleteKeys(ctx.store, everywhereKeys.linkCode(code))

  if (ctx.jobs) await ctx.jobs.account(owner)
  await eraseJiraTaskAccount(ctx.store, owner)
  await deleteKeys(
    ctx.store,
    linksKey,
    installsKey,
    pointer,
    everywhereKeys.jobs(owner),
    everywhereKeys.seen(owner),
    everywhereKeys.audit(owner),
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
