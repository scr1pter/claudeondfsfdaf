import { createHash, randomBytes } from "node:crypto"
import type { OpsEvent, OpsReport, ProbeReason } from "../../packages/ops-worker/src/protocol.js"
import { CodiumRunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { requireEntitlement } from "./codium-entitlements.js"
import { readSnapshot, requireUsableSnapshot } from "./codium-snapshot.js"
import type { GithubServerOptions } from "./github-app-server.js"
import { ApiError } from "./http.js"
import {
  appendCapped,
  claimCounted,
  indexMembers,
  readRecord,
  readRecords,
  unclaimCounted,
  updateRecord,
  utcDay,
  type IndexEntry,
} from "./ops-records.js"
import { opsPerkOpen, requireOpsPerk } from "./ops-listing.js"
import { readOpsSettings, repositoryBinding, urlHost, type OpsRepo } from "./ops-settings.js"
import { requireOpsService } from "./ops-worker.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import {
  environmentKey,
  eraseAccountReleases,
  hostPage,
  openRevert,
  readRelease,
  recordManualRevert,
  revertClaimKey,
  rollbackLink,
  updateRelease,
  type RevertFacts,
  type RevertOutcome,
} from "./release-guard.js"
import { sendServerAlert } from "./web-push.js"

/*
 * Incidents (WP A48): what the ops Worker reports, kept for the account's cards and sent to its phone.
 *
 * - `monitor.down` (On Call: a verified URL failed twice in a row) opens an incident and sends a phone alert, which On
 *   Call keeps sending while a payment is retried (§4.4: `allowPaused`). `monitor.up` resolves it.
 * - `release.regressed` (Release Guard) opens an incident, opens the one revert pull request (release-guard.ts) when the
 *   repository is still bound to the account with Release Guard on, the plan allows it now, and Release Guard is on at
 *   Vector (the owner's `ops` switch, the ops services and its listing: a Worker still reporting after the switch went
 *   off writes nothing), and alerts the phone.
 * - `release.passed` marks the release record passed.
 *
 * The Worker sends each report until it gets a 2xx, with the same event ids (packages/ops-worker/src/protocol.ts), so
 * each event is taken once: its id is recorded only after it was handled, and everything it does is idempotent
 * (incidents have ids made from what they are about, the revert has its claim, an alert is sent once per incident).
 *
 * The account acts on an incident from its cards: snooze (1 to 24 hours: no alerts and no automatic revert for that URL
 * or that repository and environment), and "Fix it", which starts a run of Vector's GitHub agent in the person's own
 * repository through Codex's `startCloudRun` (registered by the integration commit, A59), only on that tap, within the
 * plan's fix runs a day. Undo is the revert pull request: the person merges it in GitHub, or in the desktop with their
 * own GitHub sign-in. Vector's server never merges.
 */

export const INCIDENT_LIMITS = {
  /** Incidents are kept this long. */
  keepMs: 90 * 24 * 60 * 60_000,
  /** Incidents listed per account. */
  indexMax: 500,
  /** Event ids are remembered longer than the Worker keeps a report (a day). */
  eventsMs: 3 * 24 * 60 * 60_000,
  events: 2_000,
  /** Snoozes, in hours. */
  snoozeMinHours: 1,
  snoozeMaxHours: 24,
  /** A report is handled within this; what is left is answered 503 and sent again. */
  reportBudgetMs: 40_000,
  /** The fix-run day counter outlives its UTC day by a day. */
  counterMs: 2 * 24 * 60 * 60_000,
} as const

const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/
const MONITOR = /^[A-Za-z0-9_-]{1,64}$/
const SHA = /^[0-9a-f]{40}$/
const INCIDENT_ID = /^inc_[A-Za-z0-9_-]{22}$/
const PROBE_REASONS: readonly ProbeReason[] = [
  "status",
  "redirect",
  "timeout",
  "network",
  "dns",
  "auth",
  "rate-limited",
  "challenge",
  "address",
  "resolver",
]

function key(mode: StripeMode | undefined, ...parts: (string | number)[]) {
  return mode ? codiumKeyIn(mode, ...parts) : codiumKey(...parts)
}
export const incidentKey = (account: string, id: string, mode?: StripeMode) => key(mode, "ops", "incident", account, id)
export const incidentIndexKey = (account: string, mode?: StripeMode) => key(mode, "ops", "incident", account, "index")
export const snoozeKey = (account: string, subject: string, mode?: StripeMode) =>
  key(mode, "ops", "incident", account, "snooze", createHash("sha256").update(subject).digest("hex").slice(0, 16))
export const fixClaimKey = (account: string, id: string, mode?: StripeMode) =>
  key(mode, "ops", "incident", account, id, "fix")
export const fixDayKey = (account: string, day: string, mode?: StripeMode) =>
  key(mode, "ops", "incident", account, "fixes", day)
export const opsEventsKey = (account: string, mode?: StripeMode) => key(mode, "ops", "event", account)

function incidentId(...parts: (string | number)[]) {
  return `inc_${createHash("sha256").update(parts.join("\n")).digest("base64url").slice(0, 22)}`
}
/** One monitor's run of failures: the Worker names its start in both `monitor.down` and `monitor.up`. */
export const monitorIncidentId = (monitor: string, since: number) => incidentId("monitor", monitor, since)
export const releaseIncidentId = (repositoryId: number, environment: string, sha: string) =>
  incidentId("release", repositoryId, environmentKey(environment), sha)
const monitorSubject = (monitor: string) => `monitor:${monitor}`
const releaseSubject = (repositoryId: number, environment: string) =>
  `release:${repositoryId}:${environmentKey(environment)}`

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Failing = { url: string; reason: ProbeReason; status?: number }

export type Incident = {
  v: 1
  id: string
  kind: "monitor" | "release"
  state: "open" | "resolved"
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  /** What a snooze covers: the monitor, or the repository and environment. */
  subject: string
  /** The phone alert for it was sent (or could not be: push off, the plan), so it is never sent twice. */
  alerted?: boolean
  /** A snooze was on when it opened: no alert, and Release Guard opened no revert. */
  snoozed?: boolean
  monitor?: { id: string; url?: string; reason: ProbeReason; status?: number }
  release?: {
    repositoryId: number
    repository?: string
    environment: string
    sha: string
    goodSha: string
    deployment: string
    failing: Failing[]
    revert?: RevertOutcome
    facts?: RevertFacts
    rollback?: { host: "vercel" | "netlify" | "host"; url: string }
  }
  fix?: { at: number; repositoryId: number; run?: string; url?: string }
}

function time(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

export function decodeIncident(value: unknown): Incident | undefined {
  const incident = value as Incident
  if (
    !incident ||
    typeof incident !== "object" ||
    incident.v !== 1 ||
    typeof incident.id !== "string" ||
    !INCIDENT_ID.test(incident.id) ||
    (incident.kind !== "monitor" && incident.kind !== "release") ||
    (incident.state !== "open" && incident.state !== "resolved") ||
    !time(incident.openedAt) ||
    !time(incident.updatedAt) ||
    typeof incident.subject !== "string" ||
    (incident.kind === "monitor" && (!incident.monitor || typeof incident.monitor.id !== "string")) ||
    (incident.kind === "release" &&
      (!incident.release ||
        !Number.isSafeInteger(incident.release.repositoryId) ||
        typeof incident.release.sha !== "string" ||
        !Array.isArray(incident.release.failing)))
  )
    return undefined
  return incident
}

function incidentIndex(account: string, incident: Incident): IndexEntry {
  return {
    key: incidentIndexKey(account),
    score: incident.openedAt,
    member: incident.id,
    keepMs: INCIDENT_LIMITS.keepMs,
    max: INCIDENT_LIMITS.indexMax,
  }
}

function changeIncident(
  account: string,
  id: string,
  change: (current: Incident | undefined) => Incident | undefined,
  fetcher: typeof fetch,
) {
  return updateRecord(incidentKey(account, id), decodeIncident, change, INCIDENT_LIMITS.keepMs, fetcher, (value) =>
    incidentIndex(account, value),
  )
}

export async function readIncident(account: string, id: string, fetcher: typeof fetch = fetch) {
  if (!INCIDENT_ID.test(id)) return undefined
  return (await readRecord(incidentKey(account, id), decodeIncident, fetcher)).value
}

async function snoozedUntil(account: string, subject: string, fetcher: typeof fetch, now: number) {
  const value = await persistentStore(["GET", snoozeKey(account, subject)], fetcher)
  const until = Number(value)
  return Number.isSafeInteger(until) && until > now ? until : undefined
}

// ── The Worker's reports ───────────────────────────────────────────────────────────────────────────────────────────

function invalidReport(): never {
  throw new ApiError(400, "OPS_REPORT_INVALID", "This ops report is not valid.")
}

/** A report's envelope, checked. Its events are checked one by one when handled: one malformed event is skipped. */
export function decodeOpsReport(raw: string | Uint8Array): OpsReport {
  let value: unknown
  try {
    value = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"))
  } catch {
    invalidReport()
  }
  const report = value as OpsReport
  if (
    !report ||
    typeof report !== "object" ||
    report.v !== 1 ||
    typeof report.account !== "string" ||
    !ACCOUNT.test(report.account) ||
    !Array.isArray(report.events) ||
    report.events.length > 100
  )
    invalidReport()
  return report
}

function failing(value: unknown): Failing | undefined {
  const item = value as Failing
  if (!item || typeof item !== "object" || typeof item.url !== "string" || item.url.length > 2_048) return undefined
  if (!PROBE_REASONS.includes(item.reason)) return undefined
  if (item.status !== undefined && (!Number.isSafeInteger(item.status) || item.status < 100 || item.status > 599))
    return undefined
  try {
    if (new URL(item.url).protocol !== "https:") return undefined
  } catch {
    return undefined
  }
  return { url: item.url, reason: item.reason, ...(item.status !== undefined ? { status: item.status } : {}) }
}

/** One event, checked by its kind; undefined for a malformed one or a kind this server does not know. */
export function checkedEvent(value: unknown): OpsEvent | undefined {
  const event = value as OpsEvent & Record<string, unknown>
  if (!event || typeof event !== "object" || event.v !== 1) return undefined
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id) || !time(event.at)) return undefined
  switch (event.kind) {
    case "monitor.down":
      if (typeof event.monitor !== "string" || !MONITOR.test(event.monitor) || !time(event.since)) return undefined
      if (!PROBE_REASONS.includes(event.reason)) return undefined
      if (
        event.status !== undefined &&
        (!Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599)
      )
        return undefined
      return event
    case "monitor.up":
      if (typeof event.monitor !== "string" || !MONITOR.test(event.monitor) || !time(event.downSince)) return undefined
      return event
    case "release.regressed":
    case "release.passed": {
      if (!Number.isSafeInteger(event.repositoryId) || event.repositoryId <= 0) return undefined
      if (typeof event.environment !== "string" || !event.environment || event.environment.length > 255)
        return undefined
      if (typeof event.sha !== "string" || !SHA.test(event.sha) || typeof event.deployment !== "string")
        return undefined
      if (event.kind === "release.passed") return event
      if (typeof event.goodSha !== "string" || !SHA.test(event.goodSha) || !Array.isArray(event.failing))
        return undefined
      const list = event.failing.map(failing)
      if (!list.length || list.length > 10 || list.some((item) => !item)) return undefined
      return { ...event, failing: list as Failing[] }
    }
  }
  return undefined
}

export type OpsReportResult = { taken: number; duplicates: number; skipped: number }
/** How a phone alert goes out: `sendServerAlert` (web-push.ts), which checks push, the switch and the plan itself. */
export type AlertSender = (
  account: string,
  alert: { title: string; tag?: string },
  options: { fetcher: typeof fetch; now: number; urgency?: "normal" | "high"; allowPaused?: boolean },
) => Promise<unknown>
export type OpsReportOptions = {
  fetcher?: typeof fetch
  now?: number
  /** The real clock time (ms) by which the report must be answered; events not reached are left for the resend. */
  deadline?: number
  github?: Omit<GithubServerOptions, "fetcher" | "now">
  alert?: AlertSender
}

async function eventTaken(account: string, id: string, fetcher: typeof fetch) {
  return (await persistentStore(["ZSCORE", opsEventsKey(account), id], fetcher)) !== null
}

/** Remembers a taken event: one sorted set per account, so the ids go with the account (P5). */
async function markTaken(account: string, id: string, fetcher: typeof fetch, now: number) {
  await appendCapped(
    opsEventsKey(account),
    id,
    { at: now, max: INCIDENT_LIMITS.events, keepMs: INCIDENT_LIMITS.eventsMs },
    fetcher,
  )
}

/**
 * Handles every event of one report, oldest first. An event already taken is skipped; one this server does not know or
 * that is malformed is skipped too (never retried forever). A failure (the store, GitHub during a revert) stops the
 * report there and is thrown, so the Worker sends it again and the events already taken are not repeated.
 */
export async function handleOpsReport(report: OpsReport, options: OpsReportOptions = {}): Promise<OpsReportResult> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const deadline = options.deadline ?? Date.now() + INCIDENT_LIMITS.reportBudgetMs
  const result: OpsReportResult = { taken: 0, duplicates: 0, skipped: 0 }
  for (const raw of report.events) {
    const event = checkedEvent(raw)
    if (!event) {
      result.skipped++
      continue
    }
    if (await eventTaken(report.account, event.id, fetcher)) {
      result.duplicates++
      continue
    }
    if (Date.now() > deadline)
      throw new ApiError(503, "OPS_REPORT_UNFINISHED", "Part of this report is left for the next try.", {
        retryAfterSeconds: 30,
      })
    await handleEvent(report.account, event, {
      fetcher,
      now,
      github: options.github ?? {},
      alert: options.alert ?? sendServerAlert,
    })
    await markTaken(report.account, event.id, fetcher, now)
    result.taken++
  }
  return result
}

type Context = {
  fetcher: typeof fetch
  now: number
  github: Omit<GithubServerOptions, "fetcher" | "now">
  alert: AlertSender
}

async function handleEvent(account: string, event: OpsEvent, context: Context) {
  switch (event.kind) {
    case "monitor.down":
      return monitorDown(account, event, context)
    case "monitor.up":
      return monitorUp(account, event, context)
    case "release.regressed":
      return releaseRegressed(account, event, context)
    case "release.passed":
      await updateRelease(
        account,
        event,
        (current) => (current.state === "passed" ? undefined : { ...current, state: "passed", endedAt: event.at }),
        context.fetcher,
      )
      return
  }
}

// ── Phone alerts ───────────────────────────────────────────────────────────────────────────────────────────────────

const TITLE_CHARS = 120

/** A title within the phone alert's 120 characters: the specific one, or the plain one when it is too long. */
function title(specific: string, plain: string) {
  return specific.length <= TITLE_CHARS && !/[\u0000-\u001f\u007f]/.test(specific) ? specific : plain
}

function hostOf(url: string | undefined) {
  if (!url) return undefined
  try {
    return urlHost(url)
  } catch {
    return undefined
  }
}

export function downTitle(url: string | undefined) {
  const host = hostOf(url)
  return title(`On Call: ${host} failed two checks in a row`, "On Call: a production check failed twice in a row")
}
export function upTitle(url: string | undefined) {
  const host = hostOf(url)
  return title(`On Call: ${host} passes its checks again`, "On Call: a production check passes again")
}
export function regressedTitle(repository: string | undefined, revert: RevertOutcome | undefined) {
  const tail =
    revert?.state === "opened"
      ? " A revert pull request is open."
      : revert?.state === "manual"
        ? " Open Vector to undo it."
        : ""
  return title(
    `Release Guard: a release of ${repository ?? "your repository"} broke checks.${tail}`,
    `Release Guard: a release broke checks.${tail}`,
  )
}

/** Sends an incident's one alert and records that it was handled (sent, or not sendable). */
async function alertOnce(
  account: string,
  incident: Incident,
  alert: { title: string; tag: "on-call" | "release-guard"; allowPaused: boolean },
  context: Context,
) {
  if (incident.alerted || incident.snoozed) return
  await context.alert(
    account,
    { title: alert.title, tag: alert.tag },
    { fetcher: context.fetcher, now: context.now, urgency: "high", allowPaused: alert.allowPaused },
  )
  await changeIncident(
    account,
    incident.id,
    (current) => (current && !current.alerted ? { ...current, alerted: true, updatedAt: context.now } : undefined),
    context.fetcher,
  )
}

// ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function monitorDown(account: string, event: Extract<OpsEvent, { kind: "monitor.down" }>, context: Context) {
  const { settings } = await readOpsSettings(account, context.fetcher)
  const url = settings?.monitors.find((monitor) => monitor.id === event.monitor)?.url
  const subject = monitorSubject(event.monitor)
  const snoozed = (await snoozedUntil(account, subject, context.fetcher, context.now)) !== undefined
  const id = monitorIncidentId(event.monitor, event.since)
  const incident = await changeIncident(
    account,
    id,
    (current) =>
      current
        ? undefined
        : {
            v: 1,
            id,
            kind: "monitor",
            state: "open",
            openedAt: event.since,
            updatedAt: context.now,
            subject,
            ...(snoozed ? { snoozed: true } : {}),
            monitor: {
              id: event.monitor,
              ...(url ? { url } : {}),
              reason: event.reason,
              ...(event.status !== undefined ? { status: event.status } : {}),
            },
          },
    context.fetcher,
  )
  // On Call's alerts continue while a payment is retried (§4.4).
  if (incident)
    await alertOnce(account, incident, { title: downTitle(url), tag: "on-call", allowPaused: true }, context)
}

async function monitorUp(account: string, event: Extract<OpsEvent, { kind: "monitor.up" }>, context: Context) {
  const id = monitorIncidentId(event.monitor, event.downSince)
  let resolved = false
  const incident = await changeIncident(
    account,
    id,
    (current) => {
      resolved = false
      if (!current || current.state === "resolved") return undefined
      resolved = true
      return { ...current, state: "resolved", resolvedAt: event.at, updatedAt: context.now }
    },
    context.fetcher,
  )
  if (!resolved || !incident?.alerted || incident.snoozed) return
  if ((await snoozedUntil(account, incident.subject, context.fetcher, context.now)) !== undefined) return
  await context.alert(
    account,
    { title: upTitle(incident.monitor?.url), tag: "on-call" },
    { fetcher: context.fetcher, now: context.now, allowPaused: true },
  )
}

async function releaseRegressed(
  account: string,
  event: Extract<OpsEvent, { kind: "release.regressed" }>,
  context: Context,
) {
  const { fetcher, now } = context
  const [binding, { settings }, release, good] = await Promise.all([
    repositoryBinding(event.repositoryId),
    readOpsSettings(account, fetcher),
    readRelease(account, event.repositoryId, event.environment, event.sha, fetcher),
    readRelease(account, event.repositoryId, event.environment, event.goodSha, fetcher),
  ])
  const repo = settings?.repos.find((item) => item.repositoryId === event.repositoryId)
  const repository = repo?.repository ?? (binding?.account === account ? binding.repository : release?.repository)
  const subject = releaseSubject(event.repositoryId, event.environment)
  const snoozed = (await snoozedUntil(account, subject, fetcher, now)) !== undefined
  const id = releaseIncidentId(event.repositoryId, event.environment, event.sha)
  const rollback = rollbackLink(hostPage(good?.targetUrl) ?? hostPage(release?.targetUrl))
  let incident = await changeIncident(
    account,
    id,
    (current) =>
      current
        ? undefined
        : {
            v: 1,
            id,
            kind: "release",
            state: "open",
            openedAt: event.at,
            updatedAt: now,
            subject,
            ...(snoozed ? { snoozed: true } : {}),
            release: {
              repositoryId: event.repositoryId,
              ...(repository ? { repository } : {}),
              environment: event.environment,
              sha: event.sha,
              goodSha: event.goodSha,
              deployment: event.deployment,
              failing: event.failing,
              ...(rollback ? { rollback } : {}),
            },
          },
    fetcher,
  )
  if (!incident) return
  await updateRelease(
    account,
    event,
    (current) =>
      current.state === "regressed" && current.incident === id
        ? undefined
        : { ...current, state: "regressed", endedAt: event.at, incident: id },
    fetcher,
  )

  if (!incident.release?.revert && !incident.snoozed) {
    const decided = await decideRevert(
      account,
      event,
      { repo, binding, settingsOpsId: settings?.opsId, release },
      context,
    )
    if (decided.kind === "unavailable") {
      // GitHub could not be reached: the phone hears about the regression now, the revert comes with the resend.
      await alertOnce(
        account,
        incident,
        { title: regressedTitle(repository, undefined), tag: "release-guard", allowPaused: false },
        context,
      )
      throw decided.error
    }
    incident =
      (await changeIncident(
        account,
        id,
        (current) =>
          current?.release && !current.release.revert
            ? {
                ...current,
                updatedAt: now,
                release: {
                  ...current.release,
                  revert: decided.outcome,
                  ...(decided.facts ? { facts: decided.facts } : {}),
                },
              }
            : undefined,
        fetcher,
      )) ?? incident
  }
  await alertOnce(
    account,
    incident,
    { title: regressedTitle(repository, incident.release?.revert), tag: "release-guard", allowPaused: false },
    context,
  )
}

type Decided =
  | { kind: "decided"; outcome: RevertOutcome; facts?: RevertFacts }
  | { kind: "unavailable"; error: unknown }

/** Whether Vector may open the revert now and, when it may, the revert itself. */
async function decideRevert(
  account: string,
  event: Extract<OpsEvent, { kind: "release.regressed" }>,
  found: {
    repo: OpsRepo | undefined
    binding: Awaited<ReturnType<typeof repositoryBinding>>
    settingsOpsId: string | undefined
    release: Awaited<ReturnType<typeof readRelease>>
  },
  context: Context,
): Promise<Decided> {
  const { fetcher, now } = context
  const manual = async (reason: Parameters<typeof recordManualRevert>[1]): Promise<Decided> => ({
    kind: "decided",
    outcome: await recordManualRevert({ account, ...event }, reason, fetcher, now),
  })
  if (!found.binding || found.binding.account !== account || !found.repo?.releaseGuard || !found.settingsOpsId)
    return manual("not-bound")
  try {
    const snapshot = requireUsableSnapshot(await readSnapshot(account, fetcher), now)
    if (!snapshot.caps.ops?.releaseGuard) return manual("plan")
  } catch (error) {
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return manual("plan")
  }
  // A service switched off stops new work (§2, §4.16): the Worker may still report while its kill flag propagates, or
  // after a flag sync failed, and no revert token is minted then. Nor while Release Guard is not listed.
  try {
    await requireOpsService(fetcher, now)
  } catch (error) {
    if (error instanceof ApiError && (error.code === "OPS_PAUSED" || error.code === "OPS_UNAVAILABLE"))
      return manual("off")
    throw error
  }
  if (!(await opsPerkOpen(account, ["release-guard"], fetcher))) return manual("off")
  try {
    const result = await openRevert(
      {
        account,
        repositoryId: event.repositoryId,
        repository: found.repo.repository,
        ...((found.repo.installationId ?? found.binding.installationId) !== undefined
          ? { installationId: found.repo.installationId ?? found.binding.installationId }
          : {}),
        environment: event.environment,
        sha: event.sha,
        goodSha: event.goodSha,
        opsId: found.settingsOpsId,
        ...(found.release?.ref ? { ref: found.release.ref } : {}),
        failing: event.failing,
      },
      { fetcher, now, ...context.github },
    )
    return { kind: "decided", outcome: result.outcome, ...(result.facts ? { facts: result.facts } : {}) }
  } catch (error) {
    if (error instanceof ApiError && (error.code === "GITHUB_UNAVAILABLE" || error.code === "OPS_REVERT_IN_PROGRESS"))
      return { kind: "unavailable", error }
    throw error
  }
}

// ── The account's cards ────────────────────────────────────────────────────────────────────────────────────────────

export type IncidentUndo =
  /** `headSha`: the commit Undo merges at (GitHub refuses the merge when the branch moved since). */
  | { kind: "pull-request"; method: "revert-pr" | "restore"; number: number; url: string; headSha?: string }
  | { kind: "manual"; reason: string; openUrl?: string; rollback?: { host: string; url: string } }
  | { kind: "pending" }

export type IncidentView = {
  id: string
  kind: "monitor" | "release"
  state: "open" | "resolved"
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  snoozedUntil?: number
  monitor?: { id: string; url?: string; reason: ProbeReason; status?: number }
  release?: {
    repositoryId: number
    repository?: string
    environment: string
    sha: string
    goodSha: string
    failing: Failing[]
    commits: RevertFacts["commits"]
    totalCommits?: number
    migrations: string[]
    workflows: boolean
    undo: IncidentUndo
  }
  fix?: { at: number; url?: string }
}

export function incidentView(incident: Incident, snoozed?: number): IncidentView {
  const release = incident.release
  let undo: IncidentUndo = { kind: "pending" }
  if (release?.revert?.state === "opened")
    undo = {
      kind: "pull-request",
      method: release.revert.method,
      number: release.revert.number,
      url: release.revert.url,
      ...(typeof release.revert.headSha === "string" && SHA.test(release.revert.headSha)
        ? { headSha: release.revert.headSha }
        : {}),
    }
  else if (release && (release.revert?.state === "manual" || incident.snoozed))
    undo = {
      kind: "manual",
      reason: release.revert?.state === "manual" ? release.revert.reason : "snoozed",
      ...(release.facts?.openUrl
        ? { openUrl: release.facts.openUrl }
        : release.repository
          ? { openUrl: `https://github.com/${release.repository}/compare/${release.goodSha}...${release.sha}` }
          : {}),
      ...(release.rollback ? { rollback: release.rollback } : {}),
    }
  return {
    id: incident.id,
    kind: incident.kind,
    state: incident.state,
    openedAt: incident.openedAt,
    updatedAt: incident.updatedAt,
    ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}),
    ...(snoozed ? { snoozedUntil: snoozed } : {}),
    ...(incident.monitor ? { monitor: incident.monitor } : {}),
    ...(release
      ? {
          release: {
            repositoryId: release.repositoryId,
            ...(release.repository ? { repository: release.repository } : {}),
            environment: release.environment,
            sha: release.sha,
            goodSha: release.goodSha,
            failing: release.failing,
            commits: release.facts?.commits ?? [],
            ...(release.facts ? { totalCommits: release.facts.totalCommits } : {}),
            migrations: release.facts?.migrations ?? [],
            workflows: release.facts?.workflows ?? false,
            undo,
          },
        }
      : {}),
    ...(incident.fix ? { fix: { at: incident.fix.at, ...(incident.fix.url ? { url: incident.fix.url } : {}) } } : {}),
  }
}

/** The account's newest incidents, newest first, with any snooze still running. */
export async function listIncidents(account: string, fetcher: typeof fetch = fetch, now = Date.now(), limit = 50) {
  const ids = await indexMembers(incidentIndexKey(account), limit, fetcher)
  const incidents = (
    await readRecords(
      ids.map((id) => incidentKey(account, id)),
      decodeIncident,
      fetcher,
    )
  ).filter((incident): incident is Incident => !!incident)
  const subjects = [...new Set(incidents.map((incident) => incident.subject))]
  const snoozes = subjects.length
    ? await persistentStore(["MGET", ...subjects.map((subject) => snoozeKey(account, subject))], fetcher)
    : []
  const until = new Map(
    subjects.map((subject, index) => {
      const value = Number(Array.isArray(snoozes) ? snoozes[index] : undefined)
      return [subject, Number.isSafeInteger(value) && value > now ? value : undefined] as const
    }),
  )
  return { incidents: incidents.map((incident) => incidentView(incident, until.get(incident.subject))) }
}

function notFound() {
  return new ApiError(404, "OPS_NOT_FOUND", "That incident does not exist.")
}

/** Snoozes an incident's URL, or its repository and environment, for 1 to 24 hours. */
export async function snoozeIncident(
  account: string,
  id: unknown,
  hours: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(hours) ||
    (hours as number) < INCIDENT_LIMITS.snoozeMinHours ||
    (hours as number) > INCIDENT_LIMITS.snoozeMaxHours
  )
    throw new ApiError(400, "OPS_INVALID", "Snooze for 1 to 24 hours.")
  const incident = typeof id === "string" ? await readIncident(account, id, fetcher) : undefined
  if (!incident) throw notFound()
  const until = now + (hours as number) * 3_600_000
  await persistentStore(["SET", snoozeKey(account, incident.subject), String(until), "PX", until - now], fetcher)
  return { snoozedUntil: until }
}

export async function unsnoozeIncident(account: string, id: unknown, fetcher: typeof fetch = fetch) {
  const incident = typeof id === "string" ? await readIncident(account, id, fetcher) : undefined
  if (!incident) throw notFound()
  await persistentStore(["DEL", snoozeKey(account, incident.subject)], fetcher)
  return { snoozedUntil: null }
}

// ── Fix it ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Starts a run of Vector's GitHub agent in the person's own repository: Codex's `startCloudRun(trigger)` (contract
 * §4.18), which the integration commit (A59) registers with `registerOpsRunStarter`. It answers the run's id and, when
 * it has one, a link to follow it.
 */
export type OpsRunStarter = (trigger: CodiumRunTrigger.RunTrigger) => Promise<{ id: string; url?: string }>
let runStarter: OpsRunStarter | undefined

export function registerOpsRunStarter(starter: OpsRunStarter | undefined) {
  if (starter !== undefined && (typeof starter !== "function" || runStarter))
    throw new Error("Fix runs have exactly one starter.")
  runStarter = starter
}

export function opsRunStarter() {
  return runStarter
}

function fixPrompt(incident: Incident) {
  if (incident.kind === "monitor") {
    const url = incident.monitor?.url ?? "a production URL"
    const why = incident.monitor?.status !== undefined ? `HTTP ${incident.monitor.status}` : incident.monitor?.reason
    return {
      prompt: [
        `On Call: ${url} failed two checks in a row (${why}), starting ${new Date(incident.openedAt).toISOString()}.`,
        "Find the cause in this repository and open a pull request with a fix. Do not merge it.",
      ].join("\n"),
      criteria: [`${url} answers with a success status`],
    }
  }
  const release = incident.release!
  const paths = release.failing.map((item) => {
    try {
      return new URL(item.url).pathname
    } catch {
      return "/"
    }
  })
  return {
    prompt: [
      `Release Guard: the release of ${release.sha} (${release.environment}) broke paths that passed on ${release.goodSha}: ${paths.join(", ")}.`,
      "Find the cause in this repository and open a pull request with a fix. Do not merge it.",
    ].join("\n"),
    criteria: release.failing.map((item) => `${item.url} answers with a success status`),
  }
}

/**
 * "Fix it" on an incident card, only ever from the person's tap (this route; nothing starts a fix run on its own). The
 * incident's perk must be listed (On Call for a monitor, Release Guard for a release), the plan must allow ops now (fix
 * runs are off while a payment is owed, §4.4), within its fix runs a day, one per incident; the repository must be in
 * the account's ops settings and still bound to it. The route admits only callers that may spend Codium.
 */
export async function startIncidentFix(
  account: string,
  id: unknown,
  input: { repositoryId?: unknown },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const incident = typeof id === "string" ? await readIncident(account, id, fetcher) : undefined
  if (!incident) throw notFound()
  const starter = runStarter
  if (!starter) throw new ApiError(503, "OPS_FIX_UNAVAILABLE", "Fix runs are not available yet.")
  await requireOpsService(fetcher, now)
  await requireOpsPerk(account, [incident.kind === "release" ? "release-guard" : "on-call"], fetcher)
  const snapshot = await requireEntitlement(account, "ops", fetcher, now)
  const cap = snapshot.caps.ops?.onCall.fixRunsPerDay ?? 0
  if (cap < 1)
    throw new ApiError(403, "CODIUM_PERK_REQUIRED", "Your Vector Codium plan does not include fix runs.", {
      detail: { perk: "ops" },
    })
  const { settings } = await readOpsSettings(account, fetcher)
  const requested =
    input.repositoryId === undefined
      ? undefined
      : Number.isSafeInteger(input.repositoryId) && (input.repositoryId as number) > 0
        ? (input.repositoryId as number)
        : -1
  if (requested === -1) throw new ApiError(400, "OPS_INVALID", "Name the repository by id.")
  let repositoryId = incident.release?.repositoryId
  if (repositoryId !== undefined && requested !== undefined && requested !== repositoryId)
    throw new ApiError(400, "OPS_INVALID", "A release's fix runs in the repository it came from.")
  if (repositoryId === undefined) {
    if (requested !== undefined) repositoryId = requested
    else {
      // The repository whose production URL is on the failing URL's host, when exactly one is.
      const host = hostOf(incident.monitor?.url)
      const matches = (settings?.repos ?? []).filter(
        (repo) => host !== undefined && repo.productionUrl !== undefined && hostOf(repo.productionUrl) === host,
      )
      if (matches.length !== 1)
        throw new ApiError(400, "OPS_FIX_REPOSITORY", "Choose the repository the fix run works in.")
      repositoryId = matches[0]!.repositoryId
    }
  }
  const repo = settings?.repos.find((item) => item.repositoryId === repositoryId)
  const binding = repo ? await repositoryBinding(repositoryId) : undefined
  if (!repo || binding?.account !== account)
    throw new ApiError(409, "OPS_REPO_NOT_BOUND", "Connect this repository to your Vector account first.")

  const claim = JSON.stringify({ at: now, repositoryId, nonce: randomBytes(8).toString("base64url") })
  const counter = fixDayKey(account, utcDay(now))
  const claimed = await claimCounted(
    {
      key: fixClaimKey(account, incident.id),
      counter,
      value: claim,
      cap,
      keepMs: INCIDENT_LIMITS.keepMs,
      counterMs: INCIDENT_LIMITS.counterMs,
    },
    fetcher,
  )
  if (claimed === "exists")
    throw new ApiError(409, "OPS_FIX_STARTED", "A fix run already started for this incident.", {
      detail: incident.fix
        ? { fix: { at: incident.fix.at, ...(incident.fix.url ? { url: incident.fix.url } : {}) } }
        : {},
    })
  if (claimed === "limit")
    throw new ApiError(429, "OPS_LIMIT", "Your Vector Codium plan does not allow more fix runs today.", {
      detail: { limit: "fix-runs", max: cap },
    })
  const { prompt, criteria } = fixPrompt(incident)
  let run: { id: string; url?: string }
  try {
    run = await starter({
      source: "ops",
      account,
      target: { kind: "github-run", repositoryId },
      prompt,
      criteria,
      purpose: "incident",
    })
  } catch (error) {
    await unclaimCounted({ key: fixClaimKey(account, incident.id), counter, value: claim }, fetcher).catch(
      () => undefined,
    )
    if (error instanceof ApiError) throw error
    throw new ApiError(503, "OPS_FIX_UNAVAILABLE", "The fix run could not start. Try again shortly.")
  }
  const runUrl = typeof run?.url === "string" && run.url.startsWith("https://") ? run.url : undefined
  const fix = {
    at: now,
    repositoryId,
    ...(typeof run?.id === "string" ? { run: run.id } : {}),
    ...(runUrl ? { url: runUrl } : {}),
  }
  await changeIncident(
    account,
    incident.id,
    (current) => (current ? { ...current, fix, updatedAt: now } : undefined),
    fetcher,
  )
  return { fix: { at: now, ...(runUrl ? { url: runUrl } : {}) } }
}

// ── Erasure (P5) ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes every incident, snooze, fix claim, event id and App audit entry of the account, and its Release Guard records
 * and revert claims, in both Stripe modes (account deletion, A57; the ops provisioner on `closing`).
 */
export async function eraseAccountOpsRecords(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  for (const mode of ["live", "test"] as const) {
    const index = incidentIndexKey(account, mode)
    const ids = await persistentStore(["ZRANGE", index, "0", "-1"], fetcher)
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => INCIDENT_ID.test(id))
    const keys = [
      index,
      opsEventsKey(account, mode),
      codiumKeyIn(mode, "ops", "audit", account),
      fixDayKey(account, utcDay(now), mode),
      fixDayKey(account, utcDay(now - 86_400_000), mode),
    ]
    const stored = list.length
      ? await persistentStore(["MGET", ...list.map((id) => incidentKey(account, id, mode))], fetcher)
      : []
    list.forEach((id, position) => {
      keys.push(incidentKey(account, id, mode), fixClaimKey(account, id, mode))
      let incident: Incident | undefined
      try {
        incident = decodeIncident(JSON.parse(String((stored as unknown[])[position])))
      } catch {
        incident = undefined
      }
      if (!incident) return
      keys.push(snoozeKey(account, incident.subject, mode))
      if (incident.release)
        keys.push(
          revertClaimKey(
            account,
            incident.release.repositoryId,
            incident.release.environment,
            incident.release.sha,
            mode,
          ),
        )
    })
    for (let start = 0; start < keys.length; start += 200)
      await persistentStore(["DEL", ...keys.slice(start, start + 200)], fetcher)
  }
  await eraseAccountReleases(account, fetcher, now)
}
