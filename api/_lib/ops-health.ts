import { checkServerIdentity, connect, type PeerCertificate } from "node:tls"
import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { ApiError } from "./http.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { readOpsRoster, type RosterEntry } from "./ops-accounts.js"
import { DOH_ENDPOINT } from "./ops-domains.js"
import type { AlertSender } from "./ops-incidents.js"
import { readOpsSettings, verifiedDomains } from "./ops-settings.js"
import { opsConfigured } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"
import { safeAddresses, SafeFetchError, systemResolve } from "./safe-fetch.js"
import { sendServerAlert } from "./web-push.js"

/*
 * Domain health for On Call (WP A50; contract A50: "daily certificate expiry via node:tls, domain expiry via RDAP, DNS
 * drift via DNS-over-HTTPS"), run by the daily `/api/ops/domains` job after A47's re-verification. For each account
 * on the ops roster (its plan gives the Worker work now, paused included: §4.4 keeps On Call's checks and alerts through
 * Stripe's retry window), each domain it verified, within the plan's domain count:
 *
 * - the certificate: a TLS handshake (node:tls) to a public address of the domain (S8: private, loopback, link-local and
 *   metadata addresses are refused before connecting), with the domain as the server name. It reads when the
 *   certificate expires, whether its chain is trusted and whether it names the domain. A Worker cannot see the server
 *   certificate, which is why this runs here (contract Appendix A item 5).
 * - the registration: RDAP, from the registry IANA's bootstrap file names for the top-level domain (no redirect is
 *   followed), at the shortest name the registry knows: when the registration expires.
 * - DNS drift: the zone's name servers and the domain's CNAME, over DNS-over-HTTPS (Cloudflare's resolver, as for
 *   verification). A change from the last reading is drift. Address records are not compared: CDNs rotate them.
 *
 * Findings show on the domain in the ops screens, and a title-only phone alert (P7, tag `on-call`) goes out once per
 * finding: a certificate 14 and 3 days before it expires and once it is broken, a registration 30 and 7 days before,
 * and once per DNS change. Nothing here follows a redirect, sends the account's data anywhere or stores more than dates,
 * name servers and a CNAME target.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export const OPS_HEALTH = {
  /** An account is checked again once its last check is this old (the job runs daily). */
  everyMs: 20 * HOUR_MS,
  /** Each TLS handshake, RDAP request and DNS question gives up after this. */
  timeoutMs: 5_000,
  /** Accounts checked at once, and domains at once within one account. */
  accounts: 4,
  domains: 3,
  /** Alerts before a certificate expires (days), */
  certificateDays: [14, 3],
  /** and before a registration expires. */
  registrationDays: [30, 7],
  /** The largest RDAP answer or bootstrap file read. */
  rdapBytes: 512 * 1024,
  /** IANA's bootstrap file is reused this long. */
  bootstrapMs: DAY_MS,
  /** Labels tried for the registered name: example.com, then example.co.uk, then one more. */
  zoneLabels: [2, 3, 4],
} as const

export const RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json"

function key(mode: StripeMode | undefined, ...parts: string[]) {
  return mode ? codiumKeyIn(mode, ...parts) : codiumKey(...parts)
}
export const opsHealthKey = (account: string, mode?: StripeMode) => key(mode, "ops", "health", account)
export const opsHealthCheckedKey = (mode?: StripeMode) => key(mode, "ops", "health", "checked")

// ── Readings ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type CertificateReading =
  | { result: "ok"; expiresAt: number }
  | { result: "problem"; problem: "expired" | "untrusted" | "name"; expiresAt?: number }
  | { result: "unknown"; reason: "unreachable" | "address" }

export type CertificateReader = (domain: string) => Promise<CertificateReading>

/** Reads the certificate a domain serves on 443, over node:tls to a checked public address. */
export function nodeCertificateReader(
  resolve: (hostname: string) => Promise<readonly string[]> = systemResolve,
): CertificateReader {
  return async (domain) => {
    let addresses: string[]
    try {
      addresses = await safeAddresses(new URL(`https://${domain}/`), resolve)
    } catch (error) {
      return {
        result: "unknown",
        reason: error instanceof SafeFetchError && error.reason === "address" ? "address" : "unreachable",
      }
    }
    return new Promise<CertificateReading>((done) => {
      let settled = false
      const finish = (reading: CertificateReading) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        done(reading)
      }
      const socket = connect({
        host: addresses[0],
        port: 443,
        servername: domain,
        // The chain is judged below, so an expired or untrusted certificate is read rather than refused.
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      })
      const timer = setTimeout(() => finish({ result: "unknown", reason: "unreachable" }), OPS_HEALTH.timeoutMs)
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate() as PeerCertificate | undefined
        finish(judgeCertificate(domain, certificate, socket.authorized, socket.authorizationError, Date.now()))
      })
      socket.once("error", () => finish({ result: "unknown", reason: "unreachable" }))
    })
  }
}

/** What a handshake's certificate says: its expiry, and whether it is expired, untrusted or for another name. */
export function judgeCertificate(
  domain: string,
  certificate: Pick<PeerCertificate, "valid_to" | "subject" | "subjectaltname"> | undefined,
  authorized: boolean,
  error: Error | string | null | undefined,
  now: number,
): CertificateReading {
  if (!certificate || !certificate.valid_to) return { result: "unknown", reason: "unreachable" }
  const expiresAt = Date.parse(certificate.valid_to)
  const when = Number.isFinite(expiresAt) ? { expiresAt } : {}
  const code = typeof error === "string" ? error : ((error as { code?: string } | null | undefined)?.code ?? "")
  if ((Number.isFinite(expiresAt) && expiresAt <= now) || code === "CERT_HAS_EXPIRED")
    return { result: "problem", problem: "expired", ...when }
  if (!authorized) return { result: "problem", problem: "untrusted", ...when }
  if (checkServerIdentity(domain, certificate as PeerCertificate))
    return { result: "problem", problem: "name", ...when }
  return Number.isFinite(expiresAt) ? { result: "ok", expiresAt } : { result: "unknown", reason: "unreachable" }
}

export type RegistrationReading = { result: "ok"; zone: string; expiresAt?: number } | { result: "unknown" }

let bootstrap: { at: number; services: Map<string, string[]> } | undefined

/** Forgets IANA's bootstrap file (tests). */
export function resetRdapBootstrap() {
  bootstrap = undefined
}

async function boundedJson(response: Response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const text = await response.text().catch(() => "")
  if (!text || text.length > OPS_HEALTH.rdapBytes) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function rdapServices(fetcher: typeof fetch, now: number) {
  if (bootstrap && now - bootstrap.at < OPS_HEALTH.bootstrapMs) return bootstrap.services
  const response = await fetcher(RDAP_BOOTSTRAP, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(OPS_HEALTH.timeoutMs),
  }).catch(() => undefined)
  const body = response ? ((await boundedJson(response)) as { services?: unknown } | undefined) : undefined
  if (!body || !Array.isArray(body.services)) return undefined
  const services = new Map<string, string[]>()
  for (const entry of body.services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue
    const bases = (entry[1] as unknown[]).filter(
      (base): base is string => typeof base === "string" && /^https:\/\/[^\s?#]+\/$/.test(base),
    )
    if (!bases.length) continue
    for (const tld of entry[0] as unknown[]) if (typeof tld === "string") services.set(tld.toLowerCase(), bases)
  }
  bootstrap = { at: now, services }
  return services
}

/** The registration's expiry from RDAP, at the shortest name under the domain the registry knows. */
export async function readRegistration(
  domain: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RegistrationReading> {
  const labels = domain.split(".")
  const services = await rdapServices(fetcher, now)
  const base = services?.get(labels.at(-1)!)?.[0]
  if (!base) return { result: "unknown" }
  for (const count of OPS_HEALTH.zoneLabels) {
    if (count > labels.length) break
    const zone = labels.slice(-count).join(".")
    const response = await fetcher(`${base}domain/${zone}`, {
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(OPS_HEALTH.timeoutMs),
    }).catch(() => undefined)
    if (!response) return { result: "unknown" }
    // Not a name the registry has: a longer one may be (example.co.uk after co.uk).
    if (response.status === 404 || response.status === 400) {
      await response.body?.cancel().catch(() => undefined)
      continue
    }
    const body = (await boundedJson(response)) as { events?: unknown } | undefined
    if (!body) return { result: "unknown" }
    const events = Array.isArray(body.events) ? body.events : []
    const expiration = events.find(
      (event) => (event as { eventAction?: unknown } | null)?.eventAction === "expiration",
    ) as { eventDate?: unknown } | undefined
    const at = typeof expiration?.eventDate === "string" ? Date.parse(expiration.eventDate) : Number.NaN
    return Number.isFinite(at) ? { result: "ok", zone, expiresAt: at } : { result: "ok", zone }
  }
  return { result: "unknown" }
}

/** A DNS-over-HTTPS answer's records of one type, lower-case without the final dot; undefined when the lookup failed. */
export async function dohRecords(name: string, type: "NS" | "CNAME", fetcher: typeof fetch = fetch) {
  const code = type === "NS" ? 2 : 5
  const response = await fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
    method: "GET",
    headers: { accept: "application/dns-json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(OPS_HEALTH.timeoutMs),
  }).catch(() => undefined)
  const body = response
    ? ((await boundedJson(response)) as { Status?: unknown; Answer?: unknown } | undefined)
    : undefined
  if (!body) return undefined
  if (body.Status === 3) return []
  if (body.Status !== 0) return undefined
  const answers = Array.isArray(body.Answer) ? body.Answer : []
  const records = answers.flatMap((answer) => {
    const { type: kind, data, name: owner } = (answer ?? {}) as { type?: unknown; data?: unknown; name?: unknown }
    // A CNAME question answers the chain; only the domain's own record counts.
    if (kind !== code || typeof data !== "string") return []
    if (type === "CNAME" && typeof owner === "string" && owner.toLowerCase().replace(/\.$/, "") !== name) return []
    return [data.trim().toLowerCase().replace(/\.$/, "")]
  })
  return [...new Set(records)].sort()
}

// ── The record ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type DomainHealth = {
  checkedAt: number
  certificate?: { expiresAt?: number; problem?: "expired" | "untrusted" | "name"; checkedAt: number }
  registration?: { zone: string; expiresAt?: number; checkedAt: number }
  dns?: { ns: string[]; cname?: string; changedAt?: number; checkedAt: number }
  /** Findings already alerted: `cert-14`, `cert-3`, `cert-expired`, `reg-30`, `dns-<hash>`… with when. */
  alerted?: Record<string, number>
}
export type HealthRecord = { v: 1; domains: Record<string, DomainHealth> }

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}
function time(value: unknown) {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)
}

export function decodeHealth(raw: unknown): HealthRecord | undefined {
  if (typeof raw !== "string") return undefined
  let value: HealthRecord
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || value.v !== 1 || !value.domains || typeof value.domains !== "object") return undefined
  for (const health of Object.values(value.domains)) {
    if (!health || !time(health.checkedAt)) return undefined
    if (health.certificate && (!time(health.certificate.expiresAt) || !time(health.certificate.checkedAt)))
      return undefined
    if (health.registration && (typeof health.registration.zone !== "string" || !time(health.registration.expiresAt)))
      return undefined
    if (health.dns && (!strings(health.dns.ns) || !time(health.dns.changedAt))) return undefined
  }
  return value
}

export async function readHealth(account: string, fetcher: typeof fetch = fetch): Promise<HealthRecord> {
  const raw = await persistentStore(["GET", opsHealthKey(account)], fetcher)
  return decodeHealth(raw) ?? { v: 1, domains: {} }
}

/** What the screens show about a domain's health: dates and plain findings, no names of servers. */
export type DomainHealthView = {
  checkedAt: number
  certificate?: { expiresAt?: number; problem?: "expired" | "untrusted" | "name" }
  registration?: { expiresAt: number }
  dnsChangedAt?: number
}

export function healthView(health: DomainHealth | undefined): DomainHealthView | undefined {
  if (!health) return undefined
  return {
    checkedAt: health.checkedAt,
    ...(health.certificate
      ? {
          certificate: {
            ...(health.certificate.expiresAt !== undefined ? { expiresAt: health.certificate.expiresAt } : {}),
            ...(health.certificate.problem ? { problem: health.certificate.problem } : {}),
          },
        }
      : {}),
    ...(health.registration?.expiresAt !== undefined
      ? { registration: { expiresAt: health.registration.expiresAt } }
      : {}),
    ...(health.dns?.changedAt !== undefined ? { dnsChangedAt: health.dns.changedAt } : {}),
  }
}

// ── Findings and alerts ────────────────────────────────────────────────────────────────────────────────────────────

function daysLeft(at: number, now: number) {
  return Math.max(0, Math.ceil((at - now) / DAY_MS))
}

/** The alerts a domain's new health calls for that were not sent before, with their titles (titles only, P7). */
export function healthFindings(domain: string, health: DomainHealth, now: number) {
  const found: { id: string; title: string }[] = []
  const certificate = health.certificate
  if (certificate?.problem)
    found.push({
      id: `cert-${certificate.problem}`,
      title:
        certificate.problem === "expired"
          ? `On Call: the certificate for ${domain} has expired`
          : `On Call: browsers may not trust the certificate for ${domain}`,
    })
  else if (certificate?.expiresAt !== undefined) {
    const left = daysLeft(certificate.expiresAt, now)
    const step = [...OPS_HEALTH.certificateDays].sort((a, b) => a - b).find((days) => left <= days)
    if (step !== undefined)
      found.push({
        id: `cert-${step}-${certificate.expiresAt}`,
        title: `On Call: the certificate for ${domain} expires in ${left} day${left === 1 ? "" : "s"}`,
      })
  }
  const registration = health.registration
  if (registration?.expiresAt !== undefined) {
    const left = daysLeft(registration.expiresAt, now)
    const step = [...OPS_HEALTH.registrationDays].sort((a, b) => a - b).find((days) => left <= days)
    if (step !== undefined)
      found.push({
        id: `reg-${step}-${registration.expiresAt}`,
        title: `On Call: the registration of ${registration.zone} ends in ${left} day${left === 1 ? "" : "s"}`,
      })
  }
  if (health.dns?.changedAt !== undefined)
    found.push({ id: `dns-${health.dns.changedAt}`, title: `On Call: the DNS for ${domain} changed` })
  return found.filter((finding) => health.alerted?.[finding.id] === undefined)
}

function sameRecords(left: { ns: string[]; cname?: string }, right: { ns: string[]; cname?: string }) {
  return left.ns.join(" ") === right.ns.join(" ") && (left.cname ?? "") === (right.cname ?? "")
}

export type HealthReaders = {
  certificate?: CertificateReader
  registration?: (domain: string) => Promise<RegistrationReading>
  dns?: (name: string, type: "NS" | "CNAME") => Promise<string[] | undefined>
}

/**
 * One domain's new health from its last: readings that could not be taken keep what was known, a DNS change is one
 * with name servers on both sides (an empty answer is not a change), and the alerted findings carry over.
 */
export async function checkDomainHealth(
  domain: string,
  previous: DomainHealth | undefined,
  readers: Required<HealthReaders>,
  now: number,
): Promise<DomainHealth> {
  const [certificate, registration, cname] = await Promise.all([
    readers.certificate(domain).catch((): CertificateReading => ({ result: "unknown", reason: "unreachable" })),
    readers.registration(domain).catch((): RegistrationReading => ({ result: "unknown" })),
    readers.dns(domain, "CNAME").catch(() => undefined),
  ])
  const zone =
    registration.result === "ok"
      ? registration.zone
      : (previous?.registration?.zone ?? domain.split(".").slice(-2).join("."))
  const ns = await readers.dns(zone, "NS").catch(() => undefined)
  const next: DomainHealth = { checkedAt: now, ...(previous?.alerted ? { alerted: { ...previous.alerted } } : {}) }
  if (certificate.result === "ok") next.certificate = { expiresAt: certificate.expiresAt, checkedAt: now }
  else if (certificate.result === "problem")
    next.certificate = {
      problem: certificate.problem,
      ...(certificate.expiresAt !== undefined ? { expiresAt: certificate.expiresAt } : {}),
      checkedAt: now,
    }
  else if (previous?.certificate) next.certificate = previous.certificate
  if (registration.result === "ok")
    next.registration = {
      zone: registration.zone,
      ...(registration.expiresAt !== undefined ? { expiresAt: registration.expiresAt } : {}),
      checkedAt: now,
    }
  else if (previous?.registration) next.registration = previous.registration
  if (ns && ns.length && cname !== undefined) {
    const reading = { ns, ...(cname[0] ? { cname: cname[0] } : {}) }
    const before = previous?.dns
    const changed = before && before.ns.length > 0 && !sameRecords(before, reading)
    next.dns = {
      ...reading,
      ...(changed ? { changedAt: now } : before?.changedAt !== undefined ? { changedAt: before.changedAt } : {}),
      checkedAt: now,
    }
  } else if (previous?.dns) next.dns = previous.dns
  return next
}

export type HealthRunResult = {
  enabled: boolean
  accounts: number
  domains: number
  alerts: number
  failures: number
  more: boolean
}

export type HealthRunInput = {
  fetcher?: typeof fetch
  clock?: () => number
  /** When the run must stop (real clock ms). */
  deadline: number
  readers?: HealthReaders
  alert?: AlertSender
}

async function checkedTimes(fetcher: typeof fetch) {
  const raw = await persistentStore(["ZRANGEBYSCORE", opsHealthCheckedKey(), "-inf", "+inf", "WITHSCORES"], fetcher)
  if (!Array.isArray(raw))
    throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Domain health records could not be read.")
  const times = new Map<string, number>()
  for (let index = 0; index + 1 < raw.length; index += 2) times.set(String(raw[index]), Number(raw[index + 1]))
  return times
}

async function checkAccount(
  entry: RosterEntry,
  input: HealthRunInput,
  readers: Required<HealthReaders>,
  result: HealthRunResult,
) {
  const fetcher = input.fetcher ?? fetch
  const now = (input.clock ?? Date.now)()
  const { settings } = await readOpsSettings(entry.account, fetcher)
  const limit = ENTITLEMENTS[entry.plan].ops?.onCall.domains ?? 0
  const domains = settings ? verifiedDomains(settings, now).slice(0, limit) : []
  const previous = await readHealth(entry.account, fetcher)
  const next: HealthRecord = { v: 1, domains: {} }
  const queue = [...domains]
  const work = async () => {
    for (let domain = queue.shift(); domain; domain = queue.shift())
      next.domains[domain] = await checkDomainHealth(domain, previous.domains[domain], readers, now)
  }
  await Promise.all(Array.from({ length: OPS_HEALTH.domains }, work))
  const alert = input.alert ?? sendServerAlert
  for (const domain of domains) {
    const health = next.domains[domain]!
    for (const finding of healthFindings(domain, health, now)) {
      await alert(entry.account, { title: finding.title, tag: "on-call" }, { fetcher, now, allowPaused: true }).catch(
        () => undefined,
      )
      health.alerted = { ...health.alerted, [finding.id]: now }
      result.alerts++
    }
    // Findings that no longer apply are forgotten, so the record keeps only what may still be sent.
    if (health.alerted)
      for (const id of Object.keys(health.alerted))
        if (now - health.alerted[id]! > 120 * DAY_MS) delete health.alerted[id]
  }
  // Domains no longer verified (or past the plan's count) drop out of the record.
  if (domains.length)
    await persistentStore(
      ["SET", opsHealthKey(entry.account), JSON.stringify(next), "PX", String(40 * DAY_MS)],
      fetcher,
    )
  else await persistentStore(["DEL", opsHealthKey(entry.account)], fetcher)
  await persistentStore(["ZADD", opsHealthCheckedKey(), now, entry.account], fetcher)
  result.accounts++
  result.domains += domains.length
}

/** The daily health run over the ops roster, least recently checked first, until the deadline. */
export async function runDomainHealth(input: HealthRunInput): Promise<HealthRunResult> {
  const fetcher = input.fetcher ?? fetch
  const clock = input.clock ?? Date.now
  const result: HealthRunResult = {
    enabled: opsConfigured(),
    accounts: 0,
    domains: 0,
    alerts: 0,
    failures: 0,
    more: false,
  }
  if (!result.enabled) return result
  const readers: Required<HealthReaders> = {
    certificate: input.readers?.certificate ?? nodeCertificateReader(),
    registration: input.readers?.registration ?? ((domain) => readRegistration(domain, fetcher, clock())),
    dns: input.readers?.dns ?? ((name, type) => dohRecords(name, type, fetcher)),
  }
  const [roster, checked] = await Promise.all([readOpsRoster(fetcher), checkedTimes(fetcher)])
  const now = clock()
  const queue = roster
    .filter((entry) => (checked.get(entry.account) ?? 0) <= now - OPS_HEALTH.everyMs)
    .sort((left, right) => (checked.get(left.account) ?? 0) - (checked.get(right.account) ?? 0))
  const work = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (clock() >= input.deadline) {
        queue.unshift(entry)
        return
      }
      await checkAccount(entry, input, readers, result).catch(() => {
        result.failures++
      })
    }
  }
  await Promise.all(Array.from({ length: OPS_HEALTH.accounts }, work))
  result.more = queue.length > 0
  return result
}

/** Deletes an account's domain health, in both Stripe modes (account deletion, a lost dispute's erasure). */
export async function eraseAccountOpsHealth(account: string, fetcher: typeof fetch = fetch) {
  for (const mode of ["live", "test"] as const) {
    await persistentStore(["DEL", opsHealthKey(account, mode)], fetcher)
    await persistentStore(["ZREM", opsHealthCheckedKey(mode), account], fetcher)
  }
}
