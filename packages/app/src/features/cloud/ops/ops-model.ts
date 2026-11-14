// What the production-check screens show (WP A50), shared by the phone app's Production page and the desktop's
// Settings → Production. Every answer from vectordev.ai is read field by field: a malformed entry is dropped and an
// unknown value ignored, so a newer server never breaks a screen. Display only: the server decides every action from
// the plan (S1). Pure TypeScript: no DOM, Node or Solid import.
//
// Copy rules: On Call is "Vector's agent", never a person, and promises no availability or response time (H3); nothing
// shows a usage share, a plan's price or an amount (P1); Undo and Approve open the pull request or merge it with the
// person's own GitHub sign-in, because Vector's server never merges (S9).

export const OPS_PERKS = ["on-call", "release-guard", "ship-desk"] as const
export type OpsPerk = (typeof OPS_PERKS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max = 2_048) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined
const https = (value: unknown) => {
  const url = text(value)
  if (!url) return undefined
  try {
    return new URL(url).protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}
const list = <T>(value: unknown, decode: (item: unknown) => T | undefined): T[] =>
  Array.isArray(value) ? value.flatMap((item) => (decode(item) === undefined ? [] : [decode(item)!])) : []

// ── What shows ─────────────────────────────────────────────────────────────────────────────────────────────────────

type StatusLike = { listed?: readonly string[] | ReadonlySet<string>; entitlements?: Readonly<Record<string, unknown>> }

function listedSet(status: StatusLike | undefined) {
  const listed = status?.listed
  return new Set<string>(listed ? [...listed] : [])
}

/** The ops parts this account's screens show: those listed (H1), while the plan's public entitlements include ops. */
export function opsParts(status: StatusLike | undefined): OpsPerk[] {
  const listed = listedSet(status)
  if (!isRecord(status?.entitlements?.ops)) return []
  return OPS_PERKS.filter((perk) => listed.has(perk))
}

/** Whether Settings → Production shows. */
export function opsTab(status: (StatusLike & { signedIn?: boolean; error?: unknown }) | undefined) {
  return Boolean(status && status.signedIn !== false && !status.error && opsParts(status).length > 0)
}

/** Which sections a screen shows for the listed parts. */
export function opsSections(parts: readonly OpsPerk[]) {
  const has = (perk: OpsPerk) => parts.includes(perk)
  return {
    incidents: has("on-call") || has("release-guard"),
    releases: has("release-guard"),
    cards: has("ship-desk"),
    monitors: has("on-call"),
    // Release Guard probes only verified domains too, so domains show with either.
    domains: has("on-call") || has("release-guard"),
  }
}

export const ON_CALL_LINE =
  "On Call: alerts after two failed checks in a row on your verified URLs and domains. Vector's agent is on call, not a person."
export const RELEASE_GUARD_LINE =
  "Release Guard: watches each production release your host reports to GitHub and opens a revert pull request for you to merge when one breaks what the last one didn't."
export const SHIP_DESK_LINE =
  "Ship Desk: cards for pull requests from Codium runs, with their checks, the judge's verdict and before and after screenshots."

export const PART_LINES: Record<OpsPerk, string> = {
  "on-call": ON_CALL_LINE,
  "release-guard": RELEASE_GUARD_LINE,
  "ship-desk": SHIP_DESK_LINE,
}

// ── Incidents ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsUndo =
  /** `headSha`: the commit the revert pull request had when Vector opened it; Undo merges only at that commit. */
  | { kind: "pull-request"; number: number; url: string; headSha?: string }
  | { kind: "manual"; reason: string; openUrl?: string; rollback?: { host: string; url: string } }
  | { kind: "pending" }

export type OpsIncident = {
  id: string
  kind: "monitor" | "release"
  state: "open" | "resolved"
  openedAt: number
  resolvedAt?: number
  snoozedUntil?: number
  monitor?: { url?: string; reason: string; status?: number }
  release?: {
    repositoryId: number
    repository?: string
    environment: string
    sha: string
    goodSha: string
    failing: { url: string; status?: number }[]
    commits: { sha: string; title: string; author?: string }[]
    totalCommits?: number
    migrations: string[]
    workflows: boolean
    undo: OpsUndo
  }
  fix?: { at: number; url?: string }
}

function decodeUndo(value: unknown): OpsUndo {
  if (!isRecord(value)) return { kind: "pending" }
  if (value.kind === "pull-request" && count(value.number) && https(value.url))
    return {
      kind: "pull-request",
      number: value.number,
      url: value.url as string,
      ...(typeof value.headSha === "string" && /^[0-9a-f]{40}$/.test(value.headSha) ? { headSha: value.headSha } : {}),
    }
  if (value.kind === "manual") {
    const rollback = isRecord(value.rollback) && https(value.rollback.url) ? value.rollback : undefined
    return {
      kind: "manual",
      reason: text(value.reason, 64) ?? "manual",
      ...(https(value.openUrl) ? { openUrl: value.openUrl as string } : {}),
      ...(rollback ? { rollback: { host: text(rollback.host, 32) ?? "host", url: rollback.url as string } } : {}),
    }
  }
  return { kind: "pending" }
}

function decodeIncident(value: unknown): OpsIncident | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !/^inc_[A-Za-z0-9_-]{22}$/.test(value.id)) return undefined
  if ((value.kind !== "monitor" && value.kind !== "release") || (value.state !== "open" && value.state !== "resolved"))
    return undefined
  if (!time(value.openedAt)) return undefined
  const monitor = isRecord(value.monitor) ? value.monitor : undefined
  const release = isRecord(value.release) ? value.release : undefined
  if (value.kind === "release" && (!release || !count(release.repositoryId) || typeof release.sha !== "string"))
    return undefined
  return {
    id: value.id,
    kind: value.kind,
    state: value.state,
    openedAt: value.openedAt,
    ...(time(value.resolvedAt) ? { resolvedAt: value.resolvedAt } : {}),
    ...(time(value.snoozedUntil) ? { snoozedUntil: value.snoozedUntil } : {}),
    ...(value.kind === "monitor"
      ? {
          monitor: {
            ...(https(monitor?.url) ? { url: monitor!.url as string } : {}),
            reason: text(monitor?.reason, 32) ?? "status",
            ...(count(monitor?.status) ? { status: monitor!.status as number } : {}),
          },
        }
      : {}),
    ...(release
      ? {
          release: {
            repositoryId: release.repositoryId as number,
            ...(text(release.repository, 200) ? { repository: release.repository as string } : {}),
            environment: text(release.environment, 255) ?? "production",
            sha: release.sha as string,
            goodSha: text(release.goodSha, 64) ?? "",
            failing: list(release.failing, (item) =>
              isRecord(item) && https(item.url)
                ? { url: item.url as string, ...(count(item.status) ? { status: item.status as number } : {}) }
                : undefined,
            ),
            commits: list(release.commits, (item) =>
              isRecord(item) && typeof item.sha === "string" && typeof item.title === "string"
                ? {
                    sha: item.sha,
                    title: item.title.slice(0, 200),
                    ...(text(item.author, 100) ? { author: item.author as string } : {}),
                  }
                : undefined,
            ),
            ...(count(release.totalCommits) ? { totalCommits: release.totalCommits } : {}),
            migrations: list(release.migrations, (item) => text(item, 400)),
            workflows: release.workflows === true,
            undo: decodeUndo(release.undo),
          },
        }
      : {}),
    ...(isRecord(value.fix) && time(value.fix.at)
      ? { fix: { at: value.fix.at, ...(https(value.fix.url) ? { url: value.fix.url as string } : {}) } }
      : {}),
  }
}

export function decodeIncidents(body: unknown): OpsIncident[] {
  return list(isRecord(body) ? body.incidents : undefined, decodeIncident)
}

function hostOf(url: string | undefined) {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function pathOf(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** One line naming what happened. */
export function incidentTitle(incident: OpsIncident) {
  if (incident.kind === "monitor") {
    const host = hostOf(incident.monitor?.url) ?? "A production check"
    return incident.state === "open" ? `${host} failed two checks in a row` : `${host} passed its checks again`
  }
  const release = incident.release!
  return `A release of ${release.repository ?? "your repository"} broke checks that passed before`
}

const REASONS: Record<string, string> = {
  timeout: "no answer within 8 seconds",
  network: "the connection failed",
  dns: "the name has no address",
  redirect: "a redirect to another site",
  status: "an error status",
}

/** What failed, in plain words. */
export function incidentDetail(incident: OpsIncident) {
  if (incident.kind === "monitor") {
    const monitor = incident.monitor
    if (!monitor) return ""
    const why = monitor.status !== undefined ? `HTTP ${monitor.status}` : (REASONS[monitor.reason] ?? monitor.reason)
    return monitor.url ? `${monitor.url}: ${why}` : why
  }
  const release = incident.release!
  const paths = release.failing.map(
    (item) => pathOf(item.url) + (item.status !== undefined ? ` (HTTP ${item.status})` : ""),
  )
  return `${release.environment}, ${release.sha.slice(0, 7)}: ${paths.join(", ") || "its checks"}`
}

/** The host's name for "Roll back in …", from the link the server kept. */
export function rollbackLabel(host: string) {
  if (host === "vercel") return "Roll back in Vercel"
  if (host === "netlify") return "Roll back on Netlify"
  return "Roll back at your host"
}

const MANUAL: Record<string, string> = {
  workflows: "The release changed workflow files, so Vector did not open a revert pull request.",
  range: "Vector could not tell which commits to undo.",
  "head-moved": "New commits landed after the release, so Vector did not revert on top of them.",
  "opt-in": ".vector/ops.json in the repository does not allow Vector to open pull requests.",
  "not-installed": "Vector's GitHub App is not installed on this repository.",
  "github-refused": "GitHub refused the revert pull request.",
  "github-unavailable": "GitHub could not be reached to open the revert pull request.",
  "branch-exists": "A branch Vector would use already exists.",
  "not-bound": "This repository is no longer connected to your account.",
  plan: "Your plan does not allow a new revert right now.",
  off: "Release Guard was off on Vector when this happened, so it opened no revert pull request.",
  snoozed: "Release Guard was snoozed when this happened, so it opened no revert pull request.",
}

/** Why a release has no revert pull request, in plain words. */
export function manualReason(reason: string) {
  return MANUAL[reason] ?? "Vector did not open a revert pull request for this release."
}

/** Snooze choices, in hours (1 to 24). */
export const SNOOZE_HOURS = [1, 4, 24] as const

/** Whether "Fix it" may be offered: once per incident, while it is open (the server checks the plan and the count). */
export function canFix(incident: OpsIncident, parts: readonly OpsPerk[]) {
  return (
    !incident.fix &&
    incident.state === "open" &&
    parts.includes(incident.kind === "monitor" ? "on-call" : "release-guard")
  )
}

// ── Releases ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsRelease = {
  repository?: string
  environment: string
  sha: string
  at: number
  state: string
  reason?: string
  endAt?: number
}

export function decodeReleases(body: unknown): OpsRelease[] {
  return list(isRecord(body) ? body.releases : undefined, (item) =>
    isRecord(item) && typeof item.sha === "string" && time(item.at) && typeof item.state === "string"
      ? {
          ...(text(item.repository, 200) ? { repository: item.repository as string } : {}),
          environment: text(item.environment, 255) ?? "production",
          sha: item.sha,
          at: item.at,
          state: item.state,
          ...(text(item.reason, 64) ? { reason: item.reason as string } : {}),
          ...(time(item.endAt) ? { endAt: item.endAt } : {}),
        }
      : undefined,
  )
}

const RELEASE_STATES: Record<string, string> = {
  pending: "Starting to watch",
  watching: "Watching",
  passed: "Passed",
  regressed: "Broke checks",
  skipped: "Not watched",
  ended: "Watch ended without a verdict",
}

export function releaseLine(release: OpsRelease) {
  const state = RELEASE_STATES[release.state] ?? release.state
  const why =
    release.state === "skipped" && release.reason === "daily-limit" ? " (the plan's releases a day were used)" : ""
  return `${release.repository ?? "Repository"} · ${release.environment} · ${release.sha.slice(0, 7)}: ${state}${why}`
}

// ── Ship Desk cards ────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsCardImage = { n: number; slot: "before" | "after"; route: string; width: number; height: number }

export type OpsCard = {
  id: string
  repository: string
  number: number
  url: string
  title?: string
  state: "open" | "merged" | "closed"
  draft: boolean
  createdAt: number
  expiresAt: number
  verdict?: { value: "pass" | "fail" | "none"; final: boolean }
  run?: string
  checks?: {
    total: number
    passed: number
    failed: number
    pending: number
    items: { name: string; status: string; conclusion?: string }[]
  }
  images: OpsCardImage[]
  imagesOutdated: boolean
  approve: { url: string; repository: string; number: number; headSha: string }
}

function decodeCard(value: unknown): OpsCard | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !/^crd_[A-Za-z0-9_-]{22}$/.test(value.id)) return undefined
  const approve = isRecord(value.approve) ? value.approve : undefined
  if (
    typeof value.repository !== "string" ||
    !count(value.number) ||
    !https(value.url) ||
    !["open", "merged", "closed"].includes(value.state as string) ||
    !time(value.createdAt) ||
    !time(value.expiresAt) ||
    !approve ||
    !https(approve.url) ||
    typeof approve.headSha !== "string"
  )
    return undefined
  const verdict =
    isRecord(value.verdict) && ["pass", "fail", "none"].includes(value.verdict.value as string)
      ? value.verdict
      : undefined
  const checks = isRecord(value.checks) ? value.checks : undefined
  return {
    id: value.id,
    repository: value.repository,
    number: value.number,
    url: value.url as string,
    ...(text(value.title, 200) ? { title: value.title as string } : {}),
    state: value.state as OpsCard["state"],
    draft: value.draft === true,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(verdict
      ? { verdict: { value: verdict.value as "pass" | "fail" | "none", final: verdict.final === true } }
      : {}),
    ...(isRecord(value.run) && https(value.run.url) ? { run: value.run.url as string } : {}),
    ...(checks && count(checks.total) && count(checks.passed) && count(checks.failed) && count(checks.pending)
      ? {
          checks: {
            total: checks.total,
            passed: checks.passed,
            failed: checks.failed,
            pending: checks.pending,
            items: list(checks.items, (item) =>
              isRecord(item) && typeof item.name === "string" && typeof item.status === "string"
                ? {
                    name: item.name.slice(0, 100),
                    status: item.status,
                    ...(typeof item.conclusion === "string" ? { conclusion: item.conclusion } : {}),
                  }
                : undefined,
            ),
          },
        }
      : {}),
    images: list(value.images, (item) =>
      isRecord(item) &&
      count(item.n) &&
      (item.slot === "before" || item.slot === "after") &&
      typeof item.route === "string" &&
      count(item.width) &&
      count(item.height)
        ? { n: item.n, slot: item.slot, route: item.route, width: item.width, height: item.height }
        : undefined,
    ),
    imagesOutdated: value.imagesOutdated === true,
    approve: {
      url: approve.url as string,
      repository: typeof approve.repository === "string" ? approve.repository : value.repository,
      number: count(approve.number) ? approve.number : value.number,
      headSha: approve.headSha,
    },
  }
}

export function decodeCards(body: unknown): { cards: OpsCard[]; hidden: boolean } {
  const value = isRecord(body) ? body : {}
  return { cards: list(value.cards, decodeCard), hidden: value.hidden === true }
}

export function decodeCardAnswer(body: unknown): OpsCard | undefined {
  return isRecord(body) ? decodeCard(body.card) : undefined
}

/** The before and after shots of each route, in route order, for the comparison slider. */
export function imagePairs(card: Pick<OpsCard, "images">) {
  const routes = new Map<string, { route: string; before?: OpsCardImage; after?: OpsCardImage }>()
  for (const image of [...card.images].sort((left, right) => left.n - right.n)) {
    const pair = routes.get(image.route) ?? { route: image.route }
    pair[image.slot] = image
    routes.set(image.route, pair)
  }
  return [...routes.values()]
}

/** The clip that shows the "after" shot left of the slider's position (0 to 100), as a CSS clip-path. */
export function sliderClip(position: number) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(position) ? position : 50))
  return `inset(0 ${Math.round((100 - clamped) * 100) / 100}% 0 0)`
}

export function checksLine(card: OpsCard) {
  const checks = card.checks
  if (!checks || checks.total === 0) return "No checks reported yet."
  const parts = [`${checks.passed} passed`]
  if (checks.failed) parts.push(`${checks.failed} failed`)
  if (checks.pending) parts.push(`${checks.pending} running`)
  return `Checks: ${parts.join(", ")} of ${checks.total}.`
}

export function verdictLine(card: OpsCard) {
  const verdict = card.verdict
  if (!verdict) return "No verdict from the run yet."
  const word = verdict.value === "pass" ? "passed" : verdict.value === "fail" ? "failed" : "gave no verdict"
  return `The judge ${word}${verdict.final ? "" : " (the run is still going)"}.`
}

export function cardState(card: OpsCard) {
  if (card.state === "merged") return "Merged"
  if (card.state === "closed") return "Closed"
  return card.draft ? "Draft" : "Ready to review"
}

// ── Monitors and domains ───────────────────────────────────────────────────────────────────────────────────────────

export type OpsMonitor = { id: string; url: string; domainVerified: boolean; checked: boolean }

export function decodeMonitors(body: unknown) {
  const value = isRecord(body) ? body : {}
  const limits =
    isRecord(value.limits) && count(value.limits.urls) && count(value.limits.intervalSec) ? value.limits : undefined
  return {
    monitors: list(value.monitors, (item): OpsMonitor | undefined =>
      isRecord(item) && typeof item.id === "string" && https(item.url)
        ? {
            id: item.id,
            url: item.url as string,
            domainVerified: item.domainVerified === true,
            checked: item.checked === true,
          }
        : undefined,
    ),
    limits: limits ? { urls: limits.urls as number, intervalSec: limits.intervalSec as number } : undefined,
  }
}

export type OpsDomainHealth = {
  checkedAt: number
  certificate?: { expiresAt?: number; problem?: string }
  registration?: { expiresAt: number }
  dnsChangedAt?: number
}

export type OpsDomain = {
  domain: string
  status: "pending" | "verified" | "lost"
  overLimit: boolean
  nextCheckAt?: number
  record?: { txt: { name: string; value: string }; file: { url: string; body: string } }
  health?: OpsDomainHealth
}

function decodeHealth(value: unknown): OpsDomainHealth | undefined {
  if (!isRecord(value) || !time(value.checkedAt)) return undefined
  const certificate = isRecord(value.certificate) ? value.certificate : undefined
  return {
    checkedAt: value.checkedAt,
    ...(certificate
      ? {
          certificate: {
            ...(time(certificate.expiresAt) ? { expiresAt: certificate.expiresAt } : {}),
            ...(text(certificate.problem, 32) ? { problem: certificate.problem as string } : {}),
          },
        }
      : {}),
    ...(isRecord(value.registration) && time(value.registration.expiresAt)
      ? { registration: { expiresAt: value.registration.expiresAt } }
      : {}),
    ...(time(value.dnsChangedAt) ? { dnsChangedAt: value.dnsChangedAt } : {}),
  }
}

export function decodeDomains(body: unknown) {
  const value = isRecord(body) ? body : {}
  return {
    domains: list(value.domains, (item): OpsDomain | undefined => {
      if (!isRecord(item) || typeof item.domain !== "string") return undefined
      if (item.status !== "pending" && item.status !== "verified" && item.status !== "lost") return undefined
      const record = isRecord(item.record) ? item.record : undefined
      const txt = isRecord(record?.txt) ? record!.txt : undefined
      const file = isRecord(record?.file) ? record!.file : undefined
      const health = decodeHealth(item.health)
      return {
        domain: item.domain,
        status: item.status,
        overLimit: item.overLimit === true,
        ...(time(item.nextCheckAt) ? { nextCheckAt: item.nextCheckAt } : {}),
        ...(txt &&
        file &&
        typeof txt.name === "string" &&
        typeof txt.value === "string" &&
        https(file.url) &&
        typeof file.body === "string"
          ? {
              record: { txt: { name: txt.name, value: txt.value }, file: { url: file.url as string, body: file.body } },
            }
          : {}),
        ...(health ? { health } : {}),
      }
    }),
    limit: isRecord(value.limits) && count(value.limits.domains) ? (value.limits.domains as number) : undefined,
  }
}

const DAY_MS = 86_400_000

function days(at: number, now: number) {
  return Math.max(0, Math.ceil((at - now) / DAY_MS))
}

/** Plain lines for a domain's health, warnings first. */
export function healthLines(health: OpsDomainHealth | undefined, now: number, formatDate: (at: number) => string) {
  if (!health) return []
  const lines: { text: string; warn: boolean }[] = []
  const certificate = health.certificate
  if (certificate?.problem === "expired") lines.push({ text: "The certificate has expired.", warn: true })
  else if (certificate?.problem === "untrusted")
    lines.push({ text: "Browsers may not trust the certificate.", warn: true })
  else if (certificate?.problem === "name") lines.push({ text: "The certificate is for another name.", warn: true })
  else if (certificate?.expiresAt !== undefined) {
    const left = days(certificate.expiresAt, now)
    lines.push({ text: `Certificate expires in ${left} day${left === 1 ? "" : "s"}.`, warn: left <= 14 })
  }
  if (health.registration) {
    const left = days(health.registration.expiresAt, now)
    lines.push({
      text: `Registration ends ${formatDate(health.registration.expiresAt)}.`,
      warn: left <= 30,
    })
  }
  if (health.dnsChangedAt !== undefined)
    lines.push({
      text: `Its DNS changed on ${formatDate(health.dnsChangedAt)}.`,
      warn: now - health.dnsChangedAt < 14 * DAY_MS,
    })
  return lines
}

export function domainStatusLine(domain: OpsDomain) {
  if (domain.status === "verified")
    return domain.overLimit ? "Verified, past your plan's domains: not checked" : "Verified"
  if (domain.status === "lost") return "No longer verified: publish the record again"
  return "Waiting for verification"
}

/** How often the plan checks each URL, in words. */
export function intervalLine(intervalSec: number) {
  return intervalSec < 120 ? "every minute" : `every ${Math.round(intervalSec / 60)} minutes`
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal in plain words: the server's own message, or one for the codes the screens meet. */
export function opsErrorText(error: { status?: number; code?: string; message?: string } | undefined) {
  switch (error?.code) {
    case "OPS_PAUSED":
      return "Production checks are paused for now. Try again later."
    case "OPS_UNAVAILABLE":
      return "Production checks are not available right now."
    case "OPS_FIX_UNAVAILABLE":
      return "Fix runs are not available yet."
    case "OPS_FIX_STARTED":
      return "A fix run already started for this incident."
    case "MODEL_PLAN_PAYMENT_REQUIRED":
      return "Your plan is paused until its payment goes through. Fix it on vectordev.ai/account."
    case "SHIP_DESK_HIDDEN":
      return "Ship Desk is on hold for this account while a payment is reviewed."
  }
  if (error?.status === 401) return "Sign in to Vector again."
  return error?.message?.trim() || "Vector could not do that. Try again."
}

/** When something happened, in words a person reads at a glance. */
export function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}
