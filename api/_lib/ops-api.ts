import type { Entitlements } from "../../packages/schema/src/codium-entitlements.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { requireAccountUser } from "./account.js"
import { readEntitlement, requireEntitlement, requireUsableSnapshot } from "./codium-entitlements.js"
import { ApiError, readJson, type ApiRequest, type ApiResponse } from "./http.js"
import { checkDomain, normalizeDomain, verificationRecord, type DomainCheck } from "./ops-domains.js"
import {
  applyDomainCheck,
  domainRecheckAt,
  domainStatus,
  environmentName,
  monitorUrl,
  newDomainToken,
  newMonitorId,
  newOpsSettings,
  OPS_SETTINGS_LIMITS,
  opsDomainsDueKey,
  productionUrl,
  readOpsSettings,
  releasePath,
  releaseUrls,
  repoBindingsAvailable,
  repositoryBinding,
  syncOpsConfig,
  updateOpsSettings,
  urlHost,
  verifiedDomains,
  workerBehind,
  type OpsDomain,
  type OpsMonitor,
  type OpsRepo,
  type OpsSettings,
} from "./ops-settings.js"
import { healthView, readHealth, type DomainHealthView } from "./ops-health.js"
import { opsConfigured } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"
import { requireUnrevokedAccount, requireUnrevokedCliToken } from "./revocation.js"
import { phoneAppOrigin } from "./web-push.js"

/*
 * What the ops routes do (WP A47): `/api/ops/domains`, `/api/ops/monitors` and `/api/ops/repos`, for the desktop app
 * and the phone app (A50 builds their screens).
 *
 * - Who: a Vector account token (`vct_`, unrevoked) or a website session; run tokens (`vrt_`, `vht_`) get 401 (S3).
 * - Reading and removing work whatever the plan, so settings can always be seen and taken away.
 * - Adding or changing anything needs the ops services configured and the owner's `ops` switch on (503 OPS_UNAVAILABLE,
 *   OPS_PAUSED), and a plan whose snapshot includes the ops perks now: Max or Ultra, active or renewing within grace
 *   (`requireEntitlement(account, "ops")`, S1). Every count comes from the snapshot's caps (ENTITLEMENTS ops): domains
 *   and URLs from `onCall`, paths from `releaseGuard`. A patched client cannot widen any of them.
 * - A monitor or a Release Guard production URL must be on a domain the account verified (403 OPS_DOMAIN_UNVERIFIED).
 * - A repository can be set up only while it is bound to the account (409 OPS_REPO_NOT_BOUND; the binding is Codex's).
 *
 * After a change to domains or monitors the Worker's copy is updated (`synced` in the answer says whether it took it).
 */

export type OpsCaller = { account: string; via: "token" | "session" }
export type OpsCaps = NonNullable<Entitlements["ops"]>

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

/** The account behind an ops request. Run tokens and anything that is not a bearer credential get 401 before any lookup. */
export async function requireOpsCaller(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OpsCaller> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(request, "authorization"))?.[1]
  if (!bearer || bearer.length > 8192 || bearer.startsWith("vrt_") || bearer.startsWith("vht_"))
    throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to Vector to set up production checks.")
  if (bearer.startsWith("vct_"))
    return { account: (await requireUnrevokedCliToken(bearer, fetcher, now)).id, via: "token" }
  const user = await requireAccountUser(request, fetcher)
  await requireUnrevokedAccount(user.id, fetcher)
  return { account: user.id, via: "session" }
}

/** An hourly limit per account for one kind of ops request. */
export function opsRateLimit(
  request: ApiRequest,
  response: ApiResponse,
  scope: "ops-read" | "ops-write" | "ops-verify",
  account: string,
  limit: number,
  fetcher: typeof fetch = fetch,
) {
  return enforceRateLimit(
    request,
    response,
    { scope, identifier: account, limit, windowSeconds: 3600, requirePersistent: true },
    fetcher,
  )
}

/**
 * A write's JSON body, checked as such: from the site, the phone app or the desktop app (no origin), at most 4 KiB, an
 * object with only the named fields.
 */
export async function readOpsBody(request: ApiRequest, fields: readonly string[]) {
  const phone = phoneAppOrigin()
  requireTrustedJsonRequest(request, 4_096, phone ? [phone] : [])
  const body = await readJson<unknown>(request, 4_096)
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "OPS_INVALID", "Send the settings as a JSON object.")
  if (Object.keys(body).some((key) => !fields.includes(key)))
    throw new ApiError(400, "OPS_INVALID", `Send only ${fields.join(", ")}.`)
  return body as Record<string, unknown>
}

/** The plan's ops caps when it allows adding ops settings now (S1), or the plan's refusal. Reads only the snapshot. */
export async function requireOpsCaps(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const snapshot = await requireEntitlement(account, "ops", fetcher, now)
  return snapshot.caps.ops!
}

/** The plan's ops caps for display, or null when the plan does not allow ops now. Never throws for the plan's state. */
export async function readOpsCaps(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  try {
    return requireUsableSnapshot(await readEntitlement(account, fetcher, now), now).caps.ops ?? null
  } catch (error) {
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return null
  }
}

function invalid(message: string) {
  return new ApiError(400, "OPS_INVALID", message)
}

function limit(kind: "domains" | "urls" | "repos" | "paths", max: number) {
  return new ApiError(429, "OPS_LIMIT", "Your Vector Codium plan does not allow more of these.", {
    detail: { limit: kind, max },
  })
}

function unverified(domain: string) {
  return new ApiError(403, "OPS_DOMAIN_UNVERIFIED", "Verify this domain first.", { detail: { domain } })
}

function notFound() {
  return new ApiError(404, "OPS_NOT_FOUND", "That production check setting does not exist.")
}

// ── Domains ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsDomainView = {
  domain: string
  status: "pending" | "verified" | "lost"
  method?: "dns" | "http"
  verifiedAt?: number
  nextCheckAt?: number
  /** Verified, but past the plan's domain count (in verification order): the Worker does not use it. */
  overLimit: boolean
  /** What to publish (and keep published: verification is checked again weekly). */
  record: ReturnType<typeof verificationRecord>
  /** WP A50: the daily job's last reading of the certificate, the registration and the DNS. */
  health?: DomainHealthView
}

export function domainView(domain: OpsDomain, settings: OpsSettings, caps: OpsCaps | null, now: number): OpsDomainView {
  const status = domainStatus(domain, now)
  const position = verifiedDomains(settings, now).indexOf(domain.domain)
  const next = domainRecheckAt(domain)
  return {
    domain: domain.domain,
    status,
    ...(status === "verified" && domain.method ? { method: domain.method } : {}),
    ...(domain.verifiedAt !== undefined ? { verifiedAt: domain.verifiedAt } : {}),
    ...(status === "verified" && next !== undefined ? { nextCheckAt: next } : {}),
    overLimit: position >= 0 && (caps === null || position >= caps.onCall.domains),
    record: verificationRecord(domain.domain, domain.token),
  }
}

export async function listOpsDomains(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const [{ settings }, caps, health] = await Promise.all([
    readOpsSettings(account, fetcher),
    readOpsCaps(account, fetcher, now),
    readHealth(account, fetcher),
  ])
  const current = settings ?? newOpsSettings()
  return {
    domains: current.domains.map((domain) => {
      const view = domainView(domain, current, caps, now)
      const found = view.status === "verified" ? healthView(health.domains[domain.domain]) : undefined
      return found ? { ...view, health: found } : view
    }),
    limits: caps ? { domains: caps.onCall.domains } : null,
    synced: !settings || !workerBehind(account, settings, now),
  }
}

/** Adds a domain to verify (or answers the one already there), within the plan's domain count. */
export async function addOpsDomain(
  account: string,
  input: unknown,
  caps: OpsCaps,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const domain = normalizeDomain(input)
  if (!domain) throw invalid("Enter a domain name such as example.com, without https:// or a path.")
  const settings = await updateOpsSettings(
    account,
    (current) => {
      const base = current ?? newOpsSettings()
      if (base.domains.some((entry) => entry.domain === domain)) return undefined
      if (base.domains.length >= caps.onCall.domains) throw limit("domains", caps.onCall.domains)
      return { ...base, domains: [...base.domains, { domain, token: newDomainToken(), addedAt: now }] }
    },
    fetcher,
    now,
  )
  const entry = settings!.domains.find((item) => item.domain === domain)!
  return { domain: domainView(entry, settings!, caps, now) }
}

export type OpsVerifyOptions = { check?: (domain: string, token: string) => Promise<DomainCheck> }

/** Checks a domain now (the account asked) and updates the Worker when its verified set changed. */
export async function verifyOpsDomain(
  account: string,
  input: unknown,
  caps: OpsCaps,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  options: OpsVerifyOptions = {},
) {
  const domain = normalizeDomain(input)
  if (!domain) throw invalid("Enter a domain name such as example.com, without https:// or a path.")
  const { settings } = await readOpsSettings(account, fetcher)
  const entry = settings?.domains.find((item) => item.domain === domain)
  if (!entry) throw notFound()
  const check = await (options.check ?? ((name, token) => checkDomain(name, token, { fetcher })))(domain, entry.token)
  const saved = await updateOpsSettings(
    account,
    (current) => {
      const found = current?.domains.find((item) => item.domain === domain && item.token === entry.token)
      if (!current || !found) throw notFound()
      return {
        ...current,
        domains: current.domains.map((item) => (item === found ? applyDomainCheck(item, check, now) : item)),
      }
    },
    fetcher,
    now,
  )
  const synced = await syncOpsConfig(account, fetcher, now)
  const updated = saved!.domains.find((item) => item.domain === domain)!
  return { domain: domainView(updated, saved!, caps, now), result: check.result, synced: synced !== "failed" }
}

/** Removes a domain, and the monitors on it (the Worker would never probe them again). */
export async function removeOpsDomain(
  account: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const domain = normalizeDomain(input)
  if (!domain) throw invalid("Enter a domain name such as example.com, without https:// or a path.")
  let removed = false
  await updateOpsSettings(
    account,
    (current) => {
      removed = false
      if (!current?.domains.some((item) => item.domain === domain)) return undefined
      removed = true
      return {
        ...current,
        domains: current.domains.filter((item) => item.domain !== domain),
        monitors: current.monitors.filter((monitor) => urlHost(monitor.url) !== domain),
      }
    },
    fetcher,
    now,
  )
  const synced = removed ? await syncOpsConfig(account, fetcher, now) : "unchanged"
  return { removed, synced: synced !== "failed" }
}

export type ReverifyResult = {
  enabled: boolean
  accounts: number
  checked: number
  verified: number
  lost: number
  inconclusive: number
  workerUpdates: number
  workerFailures: number
  /** Accounts whose settings could not be read or saved this run; they stay due. */
  failures: number
  more: boolean
}

/**
 * The daily job's re-verification (contract §4.19 `/api/ops/domains`, 04:10 UTC): each account whose next domain
 * re-check, or a Worker update that failed, is due. Each verified domain is checked again a week after its last success
 * (a day after a check that could not be read); the Worker gets the new verified set when it changed. Stops within the
 * time budget and leaves the rest for the next run.
 */
export async function reverifyOpsDomains(input: {
  fetcher?: typeof fetch
  clock?: () => number
  budgetMs: number
  check?: (domain: string, token: string) => Promise<DomainCheck>
  batch?: number
}): Promise<ReverifyResult> {
  const fetcher = input.fetcher ?? fetch
  const clock = input.clock ?? Date.now
  const started = clock()
  const result: ReverifyResult = {
    enabled: opsConfigured(),
    accounts: 0,
    checked: 0,
    verified: 0,
    lost: 0,
    inconclusive: 0,
    workerUpdates: 0,
    workerFailures: 0,
    failures: 0,
    more: false,
  }
  if (!result.enabled) return result
  const batch = input.batch ?? 200
  const due = await persistentStore(
    ["ZRANGEBYSCORE", opsDomainsDueKey(), "-inf", String(started), "LIMIT", "0", String(batch)],
    fetcher,
  )
  if (!Array.isArray(due)) throw new ApiError(503, "OPS_UNAVAILABLE", "Vector's production checks are unavailable.")
  const check = input.check ?? ((name: string, token: string) => checkDomain(name, token, { fetcher }))
  for (const account of due) {
    if (typeof account !== "string") continue
    if (clock() - started > input.budgetMs) {
      result.more = true
      break
    }
    try {
      const now = clock()
      const { settings } = await readOpsSettings(account, fetcher)
      if (!settings) {
        // Settings erased by a path that could not reach the due set: nothing is due for this account any more.
        await persistentStore(["ZREM", opsDomainsDueKey(), account], fetcher)
        continue
      }
      const targets = settings.domains.filter((domain) => (domainRecheckAt(domain) ?? Infinity) <= now)
      const checks = new Map(
        await Promise.all(
          targets.map(
            async (domain) => [`${domain.domain} ${domain.token}`, await check(domain.domain, domain.token)] as const,
          ),
        ),
      )
      // Always saved, even with nothing checked, so the due set gets this account's next time.
      const saved = await updateOpsSettings(
        account,
        (current) =>
          current && {
            ...current,
            domains: current.domains.map((domain) => {
              const outcome = checks.get(`${domain.domain} ${domain.token}`)
              return outcome ? applyDomainCheck(domain, outcome, now) : domain
            }),
          },
        fetcher,
        now,
      )
      result.accounts++
      result.checked += checks.size
      for (const outcome of checks.values())
        if (outcome.result === "verified") result.verified++
        else if (outcome.result === "inconclusive") result.inconclusive++
      // Every target was verified and not lost before its check (domainRecheckAt), so a lost one now lost it here.
      result.lost += targets.filter(
        (domain) =>
          saved?.domains.find((item) => item.domain === domain.domain && item.token === domain.token)?.lostAt !==
          undefined,
      ).length
      const synced = await syncOpsConfig(account, fetcher, now)
      if (synced === "synced") result.workerUpdates++
      if (synced === "failed") result.workerFailures++
    } catch {
      // One account's settings that cannot be read or saved never stop the others; it stays due for the next run.
      result.failures++
    }
  }
  if (due.length >= batch) result.more = true
  return result
}

// ── Monitors ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsMonitorView = {
  id: string
  url: string
  addedAt: number
  /** Its domain is verified now. */
  domainVerified: boolean
  /** The Worker checks it: its domain is among the plan's verified domains, and it is among the plan's URLs. */
  checked: boolean
}

/** Which monitors the Worker probes: the first `urls` (in the order added) on the first `domains` verified domains. */
function checkedMonitors(settings: OpsSettings, caps: OpsCaps | null, now: number) {
  if (!caps) return new Set<string>()
  const domains = new Set(verifiedDomains(settings, now).slice(0, caps.onCall.domains))
  return new Set(
    settings.monitors
      .filter((monitor) => domains.has(urlHost(monitor.url)))
      .slice(0, caps.onCall.urls)
      .map((monitor) => monitor.id),
  )
}

export function monitorView(monitor: OpsMonitor, settings: OpsSettings, caps: OpsCaps | null, now: number) {
  const verified = new Set(verifiedDomains(settings, now))
  return {
    id: monitor.id,
    url: monitor.url,
    addedAt: monitor.addedAt,
    domainVerified: verified.has(urlHost(monitor.url)),
    checked: checkedMonitors(settings, caps, now).has(monitor.id),
  } satisfies OpsMonitorView
}

export async function listOpsMonitors(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const [{ settings }, caps] = await Promise.all([
    readOpsSettings(account, fetcher),
    readOpsCaps(account, fetcher, now),
  ])
  const current = settings ?? newOpsSettings()
  return {
    monitors: current.monitors.map((monitor) => monitorView(monitor, current, caps, now)),
    limits: caps ? { urls: caps.onCall.urls, intervalSec: caps.onCall.intervalSec } : null,
    synced: !settings || !workerBehind(account, settings, now),
  }
}

/** Adds an On Call URL on a verified domain, within the plan's URL count (or answers the same URL already there). */
export async function addOpsMonitor(
  account: string,
  input: unknown,
  caps: OpsCaps,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const url = monitorUrl(input)
  if (!url) throw invalid("Enter an https address on port 443, such as https://example.com/health.")
  const host = urlHost(url)
  const settings = await updateOpsSettings(
    account,
    (current) => {
      const base = current ?? newOpsSettings()
      if (base.monitors.some((monitor) => monitor.url === url)) return undefined
      if (!verifiedDomains(base, now).includes(host)) throw unverified(host)
      if (base.monitors.length >= caps.onCall.urls) throw limit("urls", caps.onCall.urls)
      return { ...base, monitors: [...base.monitors, { id: newMonitorId(), url, addedAt: now }] }
    },
    fetcher,
    now,
  )
  const synced = await syncOpsConfig(account, fetcher, now)
  const monitor = settings!.monitors.find((item) => item.url === url)!
  return { monitor: monitorView(monitor, settings!, caps, now), synced: synced !== "failed" }
}

export async function removeOpsMonitor(
  account: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (typeof input !== "string" || !/^mon_[A-Za-z0-9_-]{16}$/.test(input)) throw invalid("Name the monitor to remove.")
  let removed = false
  await updateOpsSettings(
    account,
    (current) => {
      removed = Boolean(current?.monitors.some((monitor) => monitor.id === input))
      return removed
        ? { ...current!, monitors: current!.monitors.filter((monitor) => monitor.id !== input) }
        : undefined
    },
    fetcher,
    now,
  )
  const synced = removed ? await syncOpsConfig(account, fetcher, now) : "unchanged"
  return { removed, synced: synced !== "failed" }
}

// ── Repositories ───────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsRepoInput = {
  repositoryId: number
  environment: string
  productionUrl?: string
  paths: string[]
  releaseGuard: boolean
  shipDesk: boolean
}

/** The repository settings a request asks for, checked by shape. The plan's counts are checked when saving. */
export function parseOpsRepo(input: unknown): OpsRepoInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Send the repository's settings.")
  const body = input as Record<string, unknown>
  const allowed = new Set(["repositoryId", "environment", "productionUrl", "paths", "releaseGuard", "shipDesk"])
  if (Object.keys(body).some((key) => !allowed.has(key))) throw invalid("Send only the repository's settings.")
  const repositoryId = body.repositoryId
  if (!Number.isSafeInteger(repositoryId) || (repositoryId as number) <= 0) throw invalid("Name the repository by id.")
  if (!environmentName(body.environment))
    throw invalid("Name the deployment environment Release Guard watches, such as Production.")
  const url =
    body.productionUrl === undefined || body.productionUrl === null ? undefined : productionUrl(body.productionUrl)
  if (body.productionUrl !== undefined && body.productionUrl !== null && !url)
    throw invalid("Enter the production address as https://example.com, without a query.")
  const rawPaths = body.paths === undefined ? [] : body.paths
  if (!Array.isArray(rawPaths) || rawPaths.length > OPS_SETTINGS_LIMITS.paths)
    throw invalid(`List at most ${OPS_SETTINGS_LIMITS.paths} paths.`)
  const paths = rawPaths.map(releasePath)
  if (paths.some((path) => !path) || new Set(paths).size !== paths.length)
    throw invalid("Each path starts with / and appears once.")
  if (typeof body.releaseGuard !== "boolean" || typeof body.shipDesk !== "boolean")
    throw invalid("Say whether Release Guard and Ship Desk are on.")
  if (body.releaseGuard && !url) throw invalid("Release Guard needs the production address.")
  return {
    repositoryId: repositoryId as number,
    environment: body.environment,
    ...(url ? { productionUrl: url } : {}),
    paths: paths as string[],
    releaseGuard: body.releaseGuard,
    shipDesk: body.shipDesk,
  }
}

export type OpsRepoView = Omit<OpsRepo, "installationId"> & { bound: boolean; overLimit: boolean }

/** The .vector/ops.json a repository commits to opt in to server writes (contract §4.15). */
export function opsJson(settings: Pick<OpsSettings, "opsId">, repo: OpsRepo) {
  return {
    opsId: settings.opsId,
    environment: repo.environment,
    ...(repo.productionUrl ? { productionUrl: repo.productionUrl } : {}),
    paths: repo.paths,
    releaseGuard: repo.releaseGuard,
    shipDesk: repo.shipDesk,
  }
}

function repoView(repo: OpsRepo, bound: boolean, caps: OpsCaps | null): OpsRepoView {
  const { installationId: _installation, ...rest } = repo
  return { ...rest, bound, overLimit: caps !== null && repo.paths.length > caps.releaseGuard.paths }
}

export async function listOpsRepos(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const [{ settings }, caps] = await Promise.all([
    readOpsSettings(account, fetcher),
    readOpsCaps(account, fetcher, now),
  ])
  const repos = settings?.repos ?? []
  const bound = await Promise.all(
    repos.map(async (repo) => (await repositoryBinding(repo.repositoryId))?.account === account),
  )
  return {
    opsId: settings?.opsId ?? null,
    available: repoBindingsAvailable(),
    repos: repos.map((repo, index) => repoView(repo, bound[index]!, caps)),
    limits: caps ? { repos: OPS_SETTINGS_LIMITS.repos, paths: caps.releaseGuard.paths } : null,
  }
}

/** Sets up Release Guard and Ship Desk for a repository bound to the account. Answers the .vector/ops.json to commit. */
export async function saveOpsRepo(
  account: string,
  input: OpsRepoInput,
  caps: OpsCaps,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const binding = await repositoryBinding(input.repositoryId)
  if (!binding || binding.account !== account)
    throw new ApiError(409, "OPS_REPO_NOT_BOUND", "Connect this repository to your Vector account first.")
  if (input.paths.length > caps.releaseGuard.paths) throw limit("paths", caps.releaseGuard.paths)
  const settings = await updateOpsSettings(
    account,
    (current) => {
      const base = current ?? newOpsSettings()
      if (input.releaseGuard && input.productionUrl) {
        const host = urlHost(input.productionUrl)
        if (!verifiedDomains(base, now).includes(host)) throw unverified(host)
      }
      const existing = base.repos.find((repo) => repo.repositoryId === input.repositoryId)
      if (!existing && base.repos.length >= OPS_SETTINGS_LIMITS.repos) throw limit("repos", OPS_SETTINGS_LIMITS.repos)
      const installationId = binding.installationId ?? existing?.installationId
      const repo: OpsRepo = {
        repositoryId: input.repositoryId,
        repository: binding.repository,
        environment: input.environment,
        ...(input.productionUrl ? { productionUrl: input.productionUrl } : {}),
        paths: input.paths,
        releaseGuard: input.releaseGuard,
        shipDesk: input.shipDesk,
        ...(installationId !== undefined ? { installationId } : {}),
        updatedAt: now,
      }
      return {
        ...base,
        repos: existing ? base.repos.map((item) => (item === existing ? repo : item)) : [...base.repos, repo],
      }
    },
    fetcher,
    now,
  )
  const repo = settings!.repos.find((item) => item.repositoryId === input.repositoryId)!
  return { repo: repoView(repo, true, caps), opsJson: opsJson(settings!, repo), urls: releaseUrls(repo) }
}

export async function removeOpsRepo(account: string, input: unknown, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) throw invalid("Name the repository by id.")
  let removed = false
  await updateOpsSettings(
    account,
    (current) => {
      removed = Boolean(current?.repos.some((repo) => repo.repositoryId === input))
      return removed ? { ...current!, repos: current!.repos.filter((repo) => repo.repositoryId !== input) } : undefined
    },
    fetcher,
    now,
  )
  return { removed }
}
