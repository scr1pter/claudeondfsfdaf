import { createHash, randomBytes } from "node:crypto"
import type { ConfigBody } from "../../packages/ops-worker/src/protocol.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { opsHostname, OPS_VERIFY, type DomainCheck } from "./ops-domains.js"
import { opsConfig, opsConfigured } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The ops settings of one account (WP A47): the domains it verified, its On Call URLs and its Release Guard and Ship
 * Desk repositories. They are one JSON document, `ops:settings:<account>` under the Codium prefix, changed only by a
 * compare-and-set script (SAVE) that also keeps three indexes in step:
 *
 * - `ops:repo:<repositoryId>`: the accounts with settings for a repository, so GitHub's installation and repository
 *   removals find every one to drop;
 * - `ops:installation:<installationId>`: the accounts with a repository of that App installation, for an uninstall
 *   whose payload does not list the repositories;
 * - `ops:domains:due`: a sorted set of accounts by when their next domain re-check (or a Worker update that failed) is
 *   due, read by the daily `/api/ops/domains` job.
 *
 * Each repository's owner is decided by its binding, which Codex's @vector build keeps (`bindingFor`, contract §4.18;
 * one account per repository id). This build never imports Codex's files: the integration commit (A59) registers the
 * reader with `registerRepoBindingReader((id) => bindingFor(id))`. Until then no repository is bound, so none can be
 * configured and no deployment or pull request is acted on.
 *
 * The ops Worker (A46) holds a copy of the domains and monitors (`config`). After every change the document's Worker
 * part is hashed and, when it differs from the last copy the Worker accepted, sent again (syncOpsConfig).
 */

export const OPS_SETTINGS_LIMITS = {
  /** Repositories per account (server-only; .vector/ops.json has one per repository). */
  repos: 20,
  /** Release Guard paths per repository: .vector/ops.json `paths[≤5]`, and the plan's own count below that. */
  paths: 5,
  pathChars: 256,
  environmentChars: 255,
  urlChars: 2_048,
  /** Compare-and-set attempts before 409 OPS_BUSY. */
  attempts: 4,
  /** A Worker update that failed is retried by the daily job once this has passed. */
  resyncMs: 15 * 60_000,
} as const

export type OpsDomain = {
  domain: string
  /** The value the account publishes, `vector-verify=<token>`. */
  token: string
  addedAt: number
  /** When it first became verified (and again after it was lost): the Worker's verification order. */
  since?: number
  /** The last successful check. */
  verifiedAt?: number
  method?: "dns" | "http"
  /** A re-check that could not be read is tried again at this time. */
  retryAt?: number
  /** A re-check found the token gone, so verification ended. */
  lostAt?: number
  checkedAt?: number
}
export type OpsMonitor = { id: string; url: string; addedAt: number }
export type OpsRepo = {
  repositoryId: number
  /** "owner/name", from the binding. */
  repository: string
  /** The deployment environment Release Guard watches (compared without case). */
  environment: string
  productionUrl?: string
  paths: string[]
  releaseGuard: boolean
  shipDesk: boolean
  /** The GitHub App installation, once known (from the binding or a delivery). */
  installationId?: number
  updatedAt: number
}
export type OpsSettings = {
  v: 1
  /** Named in the repository's .vector/ops.json, so a server write (A48) can check the file opts in for this account. */
  opsId: string
  revision: number
  /** The hash of the last domains and monitors the Worker accepted. */
  synced?: string
  domains: OpsDomain[]
  monitors: OpsMonitor[]
  repos: OpsRepo[]
}

export type OpsDomainStatus = "pending" | "verified" | "lost"

// ── Keys and scripts ───────────────────────────────────────────────────────────────────────────────────────────────

export const opsSettingsKey = (account: string, mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "settings", account) : codiumKey("ops", "settings", account)
export const opsRepoIndexKey = (repositoryId: number, mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "repo", repositoryId) : codiumKey("ops", "repo", repositoryId)
export const opsInstallationIndexKey = (installationId: number, mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "installation", installationId) : codiumKey("ops", "installation", installationId)
export const opsDomainsDueKey = (mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "domains", "due") : codiumKey("ops", "domains", "due")

// KEYS: the settings, the due set, then index sets. ARGV: the value read ("" when missing), the new value ("" to
// delete), the account, the due score ("" to leave the due set), then "+" or "-" for each index set. Nothing is written
// unless the stored value is still the one read.
const SAVE = [
  "local current = redis.call('GET', KEYS[1])",
  "if (current or '') ~= ARGV[1] then return 0 end",
  "if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end",
  "if ARGV[4] == '' then redis.call('ZREM', KEYS[2], ARGV[3]) else redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3]) end",
  "for i = 3, #KEYS do",
  "  if ARGV[i + 2] == '+' then redis.call('SADD', KEYS[i], ARGV[3]) else redis.call('SREM', KEYS[i], ARGV[3]) end",
  "end",
  "return 1",
].join(" ")
// KEYS: index sets. Answers each set's members, in order.
const MEMBERS = [
  "local out = {}",
  "for i = 1, #KEYS do out[i] = redis.call('SMEMBERS', KEYS[i]) end",
  "return out",
].join(" ")
// KEYS: one index set. ARGV: the account. Removes a stale member whose settings no longer name the index.
const FORGET = "return redis.call('SREM', KEYS[1], ARGV[1])"

export const OPS_SETTINGS_SCRIPTS = Object.freeze({ SAVE, MEMBERS, FORGET })

// ── Decoding ───────────────────────────────────────────────────────────────────────────────────────────────────────

const OPS_ID = /^ops_[A-Za-z0-9_-]{22}$/
const TOKEN = /^[A-Za-z0-9_-]{32}$/
const MONITOR_ID = /^mon_[A-Za-z0-9_-]{16}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const HASH = /^[0-9a-f]{32}$/

function time(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
function optionalTime(value: unknown) {
  return value === undefined || time(value)
}
function id(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function unreadable(): never {
  throw new ApiError(503, "OPS_SETTINGS_UNREADABLE", "Vector's production check settings could not be read.")
}

function decodeDomain(value: unknown): OpsDomain {
  const domain = value as OpsDomain
  if (
    !domain ||
    typeof domain !== "object" ||
    !opsHostname(domain.domain) ||
    typeof domain.token !== "string" ||
    !TOKEN.test(domain.token) ||
    !time(domain.addedAt) ||
    !optionalTime(domain.since) ||
    !optionalTime(domain.verifiedAt) ||
    !optionalTime(domain.retryAt) ||
    !optionalTime(domain.lostAt) ||
    !optionalTime(domain.checkedAt) ||
    (domain.method !== undefined && domain.method !== "dns" && domain.method !== "http")
  )
    unreadable()
  return domain
}

function decodeMonitor(value: unknown): OpsMonitor {
  const monitor = value as OpsMonitor
  if (
    !monitor ||
    typeof monitor !== "object" ||
    typeof monitor.id !== "string" ||
    !MONITOR_ID.test(monitor.id) ||
    !monitorUrl(monitor.url) ||
    !time(monitor.addedAt)
  )
    unreadable()
  return monitor
}

function decodeRepo(value: unknown): OpsRepo {
  const repo = value as OpsRepo
  if (
    !repo ||
    typeof repo !== "object" ||
    !id(repo.repositoryId) ||
    typeof repo.repository !== "string" ||
    !REPOSITORY.test(repo.repository) ||
    !environmentName(repo.environment) ||
    (repo.productionUrl !== undefined && !productionUrl(repo.productionUrl)) ||
    !Array.isArray(repo.paths) ||
    repo.paths.length > OPS_SETTINGS_LIMITS.paths ||
    !repo.paths.every((path) => releasePath(path) === path) ||
    typeof repo.releaseGuard !== "boolean" ||
    typeof repo.shipDesk !== "boolean" ||
    (repo.installationId !== undefined && !id(repo.installationId)) ||
    !time(repo.updatedAt)
  )
    unreadable()
  return repo
}

/** A stored document, checked field by field. A malformed one is 503: settings are never guessed at. */
export function decodeOpsSettings(raw: unknown): OpsSettings | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "string") unreadable()
  let value: OpsSettings
  try {
    value = JSON.parse(raw) as OpsSettings
  } catch {
    unreadable()
  }
  if (
    !value ||
    typeof value !== "object" ||
    value.v !== 1 ||
    typeof value.opsId !== "string" ||
    !OPS_ID.test(value.opsId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    (value.synced !== undefined && (typeof value.synced !== "string" || !HASH.test(value.synced))) ||
    !Array.isArray(value.domains) ||
    !Array.isArray(value.monitors) ||
    !Array.isArray(value.repos)
  )
    unreadable()
  return {
    v: 1,
    opsId: value.opsId,
    revision: value.revision,
    ...(value.synced ? { synced: value.synced } : {}),
    domains: value.domains.map(decodeDomain),
    monitors: value.monitors.map(decodeMonitor),
    repos: value.repos.map(decodeRepo),
  }
}

// ── Field rules (shared with the routes) ───────────────────────────────────────────────────────────────────────────

/**
 * An On Call or production URL the Worker will take (packages/ops-worker/src/ssrf.ts probeTarget): https on 443, no
 * credentials, a host name the Worker may probe, at most 2,048 characters; normalised, without a fragment.
 */
export function monitorUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > OPS_SETTINGS_LIMITS.urlChars) return undefined
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443"))
    return undefined
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (host.startsWith("[") || !opsHostname(host)) return undefined
  url.hash = ""
  return url.href.length <= OPS_SETTINGS_LIMITS.urlChars ? url.href : undefined
}

/** A production URL: a monitor URL with no query (the Release Guard paths are joined to it). */
export function productionUrl(input: unknown): string | undefined {
  const url = monitorUrl(input)
  return url && !new URL(url).search ? url : undefined
}

/** The host of a URL this module accepted. */
export function urlHost(url: string) {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "")
}

/** A Release Guard path: `/` then printable characters, no `//` start, no fragment, at most 256 characters. */
export function releasePath(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > OPS_SETTINGS_LIMITS.pathChars) return undefined
  if (!input.startsWith("/") || input.startsWith("//") || !/^[\x21-\x7e]+$/.test(input) || input.includes("#"))
    return undefined
  return input
}

/** A deployment environment name, as GitHub reports it: 1 to 255 characters, no control characters. */
export function environmentName(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= OPS_SETTINGS_LIMITS.environmentChars &&
    input.trim() === input &&
    !/[\u0000-\u001f\u007f]/.test(input)
  )
}

/** The URLs Release Guard watches for a repository: its production URL joined with each path (or `/`). */
export function releaseUrls(repo: Pick<OpsRepo, "productionUrl" | "paths">) {
  if (!repo.productionUrl) return []
  const base = new URL(repo.productionUrl)
  return (repo.paths.length ? repo.paths : ["/"]).flatMap((path) => {
    const url = monitorUrl(new URL(path, base.origin).href)
    return url ? [url] : []
  })
}

// ── Domains ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a domain counts as verified now: a success, no failure since, and at most 14 days since that success. */
export function domainVerified(domain: OpsDomain, now: number) {
  return domain.verifiedAt !== undefined && domain.lostAt === undefined && now < domain.verifiedAt + OPS_VERIFY.graceMs
}

export function domainStatus(domain: OpsDomain, now: number): OpsDomainStatus {
  if (domainVerified(domain, now)) return "verified"
  return domain.verifiedAt === undefined ? "pending" : "lost"
}

/** The verified domains in verification order (first verified first), as the Worker's domain cap counts them. */
export function verifiedDomains(settings: Pick<OpsSettings, "domains">, now: number) {
  return settings.domains
    .filter((domain) => domainVerified(domain, now))
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || (a.domain < b.domain ? -1 : 1))
    .map((domain) => domain.domain)
}

/**
 * When a domain that was verified is next checked again: a week after its last success, or the retry time after a
 * check that could not be read. A domain that was never verified, or was lost, is checked only when the account asks.
 */
export function domainRecheckAt(domain: OpsDomain) {
  if (domain.verifiedAt === undefined || domain.lostAt !== undefined) return undefined
  return domain.retryAt ?? domain.verifiedAt + OPS_VERIFY.recheckMs
}

/**
 * A domain after a check (contract A47: re-verified weekly). A success verifies it (keeping its place in the order when
 * it was still verified). A failure ends a verification; a pending domain stays pending. A check that could not be read
 * changes nothing but the retry time, until 14 days have passed since the last success, when verification ends.
 */
export function applyDomainCheck(domain: OpsDomain, check: DomainCheck, now: number): OpsDomain {
  const { retryAt: _retry, lostAt: _lost, since: _since, ...rest } = domain
  if (check.result === "verified")
    return {
      ...rest,
      since: domainVerified(domain, now) ? (domain.since ?? now) : now,
      verifiedAt: now,
      method: check.method,
      checkedAt: now,
    }
  const live = domain.verifiedAt !== undefined && domain.lostAt === undefined
  if (!live) return { ...domain, checkedAt: now }
  if (check.result === "failed" || now >= domain.verifiedAt! + OPS_VERIFY.graceMs)
    return { ...rest, lostAt: now, checkedAt: now }
  return { ...domain, retryAt: now + OPS_VERIFY.retryMs, checkedAt: now }
}

// ── The Worker's copy ──────────────────────────────────────────────────────────────────────────────────────────────

/** What the Worker holds for the account (protocol.ts `config`): verified domains in order, then every monitor. */
export function workerConfig(account: string, settings: Pick<OpsSettings, "domains" | "monitors">, now: number) {
  return {
    account,
    domains: verifiedDomains(settings, now),
    monitors: settings.monitors.map((monitor) => ({ id: monitor.id, url: monitor.url })),
  } satisfies ConfigBody
}

export function configHash(config: Pick<ConfigBody, "domains" | "monitors">) {
  return createHash("sha256")
    .update(JSON.stringify({ domains: config.domains, monitors: config.monitors }))
    .digest("hex")
    .slice(0, 32)
}

/**
 * Whether the Worker's copy is behind the document. An account that never sent the Worker anything and has nothing to
 * send (repositories only) is not behind.
 */
export function workerBehind(account: string, settings: OpsSettings, now: number) {
  const config = workerConfig(account, settings, now)
  if (settings.synced === undefined && !config.domains.length && !config.monitors.length) return false
  return settings.synced !== configHash(config)
}

/** The due set's score: the next domain re-check, or a retry of a Worker update that failed; "" for neither. */
function dueScore(account: string, settings: OpsSettings | undefined, now: number) {
  if (!settings) return ""
  const times = settings.domains.flatMap((domain) => {
    const at = domainRecheckAt(domain)
    return at === undefined ? [] : [at]
  })
  if (workerBehind(account, settings, now)) times.push(now + OPS_SETTINGS_LIMITS.resyncMs)
  return times.length ? String(Math.min(...times)) : ""
}

// ── Reading and writing ────────────────────────────────────────────────────────────────────────────────────────────

export function newOpsSettings(): OpsSettings {
  return {
    v: 1,
    opsId: `ops_${randomBytes(16).toString("base64url")}`,
    revision: 0,
    domains: [],
    monitors: [],
    repos: [],
  }
}

export function newDomainToken() {
  return randomBytes(24).toString("base64url")
}

export function newMonitorId() {
  return `mon_${randomBytes(12).toString("base64url")}`
}

/** The account's settings and the stored text they came from (the compare-and-set's expected value). */
export async function readOpsSettings(account: string, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(["GET", opsSettingsKey(account)], fetcher)
  return { settings: decodeOpsSettings(raw), raw: typeof raw === "string" ? raw : "" }
}

function indexSets(settings: OpsSettings | undefined) {
  const repos = new Set(settings?.repos.map((repo) => repo.repositoryId) ?? [])
  const installations = new Set(
    settings?.repos.flatMap((repo) => (repo.installationId === undefined ? [] : [repo.installationId])) ?? [],
  )
  return { repos, installations }
}

/**
 * Changes the account's settings: `change` gets the current document (undefined when there is none) and answers the new
 * one, or undefined to change nothing. It runs again on a concurrent write, so it must be pure; an ApiError it throws
 * (a limit, a missing entry) reaches the caller. Answers the settings as stored.
 */
export async function updateOpsSettings(
  account: string,
  change: (current: OpsSettings | undefined) => OpsSettings | undefined,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OpsSettings | undefined> {
  for (let attempt = 0; attempt < OPS_SETTINGS_LIMITS.attempts; attempt++) {
    const { settings, raw } = await readOpsSettings(account, fetcher)
    const changed = change(settings)
    if (!changed) return settings
    const next: OpsSettings = { ...changed, revision: (settings?.revision ?? 0) + 1 }
    if (await saveOpsSettings(account, raw, settings, next, fetcher, now)) return next
  }
  throw new ApiError(409, "OPS_BUSY", "Your production check settings changed at the same time. Try again.")
}

async function saveOpsSettings(
  account: string,
  raw: string,
  previous: OpsSettings | undefined,
  next: OpsSettings | undefined,
  fetcher: typeof fetch,
  now: number,
) {
  const before = indexSets(previous)
  const after = indexSets(next)
  const keys = [opsSettingsKey(account), opsDomainsDueKey()]
  const marks: string[] = []
  for (const repo of new Set([...before.repos, ...after.repos])) {
    if (before.repos.has(repo) === after.repos.has(repo)) continue
    keys.push(opsRepoIndexKey(repo))
    marks.push(after.repos.has(repo) ? "+" : "-")
  }
  for (const installation of new Set([...before.installations, ...after.installations])) {
    if (before.installations.has(installation) === after.installations.has(installation)) continue
    keys.push(opsInstallationIndexKey(installation))
    marks.push(after.installations.has(installation) ? "+" : "-")
  }
  const result = await persistentStore(
    [
      "EVAL",
      SAVE,
      String(keys.length),
      ...keys,
      raw,
      next ? JSON.stringify(next) : "",
      account,
      dueScore(account, next, now),
      ...marks,
    ],
    fetcher,
  )
  if (result !== 0 && result !== 1) unreadable()
  return result === 1
}

/**
 * Sends the Worker the account's domains and monitors when its copy is behind, and records that it took them. "off"
 * when the Worker is not configured; "failed" when it could not be reached (the daily job retries).
 */
export async function syncOpsConfig(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<"synced" | "unchanged" | "failed" | "off"> {
  if (!opsConfigured()) return "off"
  const { settings } = await readOpsSettings(account, fetcher)
  if (!settings) return "unchanged"
  if (!workerBehind(account, settings, now)) return "unchanged"
  const config = workerConfig(account, settings, now)
  const hash = configHash(config)
  try {
    await opsConfig(config, fetcher, now)
  } catch {
    return "failed"
  }
  await updateOpsSettings(
    account,
    (current) =>
      current && current.synced !== hash && configHash(workerConfig(account, current, now)) === hash
        ? { ...current, synced: hash }
        : undefined,
    fetcher,
    now,
  )
  return "synced"
}

/** The accounts in each index set, read in one round trip (at most 500 sets per call). */
async function indexMembers(keys: readonly string[], fetcher: typeof fetch) {
  const members: string[][] = []
  for (let start = 0; start < keys.length; start += 500) {
    const chunk = keys.slice(start, start + 500)
    const result = await persistentStore(["EVAL", MEMBERS, String(chunk.length), ...chunk], fetcher)
    if (!Array.isArray(result) || result.length !== chunk.length) unreadable()
    for (const entry of result) {
      if (!Array.isArray(entry) || !entry.every((member) => typeof member === "string")) unreadable()
      members.push(entry as string[])
    }
  }
  return members
}

/**
 * Drops the settings of these repositories from every account that has them, and the repositories of `installation`
 * when it is given (an uninstall). Answers how many repository settings went. The Worker holds no repository settings,
 * so nothing is sent to it.
 */
export async function dropOpsRepositories(
  input: { repositoryIds: readonly number[]; installationId?: number },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const repositoryIds = [...new Set(input.repositoryIds.filter(id))]
  const keys = repositoryIds.map((repo) => opsRepoIndexKey(repo))
  if (input.installationId !== undefined) keys.push(opsInstallationIndexKey(input.installationId))
  if (!keys.length) return 0
  const members = await indexMembers(keys, fetcher)
  const accounts = new Set(members.flat())
  const gone = new Set(repositoryIds)
  const untouched = new Set<string>()
  let dropped = 0
  for (const account of accounts) {
    let removed = 0
    await updateOpsSettings(
      account,
      (current) => {
        removed = 0
        if (!current) return undefined
        const repos = current.repos.filter(
          (repo) =>
            !gone.has(repo.repositoryId) &&
            (input.installationId === undefined || repo.installationId !== input.installationId),
        )
        removed = current.repos.length - repos.length
        return removed ? { ...current, repos } : undefined
      },
      fetcher,
      now,
    )
    dropped += removed
    if (!removed) untouched.add(account)
  }
  // The save above removes each index entry it changes. An account whose settings had nothing to drop is a stale entry
  // (its own write removed the repository first), removed here so the set does not grow.
  for (const [index, key] of keys.entries())
    for (const account of members[index]!)
      if (untouched.has(account) && !(await stillIndexed(account, key, fetcher)))
        await persistentStore(["EVAL", FORGET, "1", key, account], fetcher)
  return dropped
}

async function stillIndexed(account: string, key: string, fetcher: typeof fetch) {
  const { settings } = await readOpsSettings(account, fetcher)
  if (!settings) return false
  return settings.repos.some(
    (repo) =>
      opsRepoIndexKey(repo.repositoryId) === key ||
      (repo.installationId !== undefined && opsInstallationIndexKey(repo.installationId) === key),
  )
}

/**
 * Deletes the account's ops settings and its index entries, in both Stripe modes (P5; account deletion, A57, calls
 * it). The Worker's copy is erased by its own `erase` action.
 */
export async function eraseAccountOpsSettings(account: string, fetcher: typeof fetch = fetch) {
  for (const mode of ["live", "test"] as const) {
    for (let attempt = 0; attempt < OPS_SETTINGS_LIMITS.attempts; attempt++) {
      const raw = await persistentStore(["GET", opsSettingsKey(account, mode)], fetcher)
      if (raw === null || raw === undefined) break
      let previous: OpsSettings | undefined
      try {
        previous = decodeOpsSettings(raw)
      } catch {
        previous = undefined
      }
      const sets = indexSets(previous)
      const keys = [
        opsSettingsKey(account, mode),
        opsDomainsDueKey(mode),
        ...[...sets.repos].map((repo) => opsRepoIndexKey(repo, mode)),
        ...[...sets.installations].map((installation) => opsInstallationIndexKey(installation, mode)),
      ]
      const result = await persistentStore(
        ["EVAL", SAVE, String(keys.length), ...keys, String(raw), "", account, "", ...keys.slice(2).map(() => "-")],
        fetcher,
      )
      if (result === 1) break
    }
  }
}

// ── Repository bindings (Codex's, registered at A59) ───────────────────────────────────────────────────────────────

/** The fields of Codex's RepoBinding (api/_lib/cloud-agents-binding.ts on vector-at-mention) that ops reads. */
export type OpsRepoBinding = {
  account: string
  repository: string
  installationId?: string | number
  suspended?: string
}
export type OpsBindingReader = (repositoryId: string) => Promise<OpsRepoBinding | undefined>

let bindingReader: OpsBindingReader | undefined

/** Registers the reader of repository bindings (A59: `registerRepoBindingReader((id) => bindingFor(id))`). */
export function registerRepoBindingReader(reader: OpsBindingReader | undefined) {
  bindingReader = reader
}

/** Whether bindings can be read at all (A59 registered the reader). */
export function repoBindingsAvailable() {
  return bindingReader !== undefined
}

const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The account a repository is bound to, with its full name and App installation, or undefined when there is no
 * reader, no binding, or a suspended one (transferred, deleted, or the binder lost access). A reader failure (the
 * store) is thrown.
 */
export async function repositoryBinding(repositoryId: number) {
  if (!bindingReader || !id(repositoryId)) return undefined
  const binding = await bindingReader(String(repositoryId))
  if (!binding || binding.suspended !== undefined) return undefined
  if (typeof binding.account !== "string" || !ACCOUNT.test(binding.account)) return undefined
  if (typeof binding.repository !== "string" || !REPOSITORY.test(binding.repository)) return undefined
  const installation = Number(binding.installationId)
  return {
    account: binding.account,
    repository: binding.repository,
    ...(binding.installationId !== undefined && id(installation) ? { installationId: installation } : {}),
  }
}
