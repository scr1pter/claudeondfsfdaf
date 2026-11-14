// One Durable Object per account (WP A46), named by HMAC(ACCOUNT_KEY, account). It runs the account's On Call checks
// and Release Guard watches from one alarm, keeps their state in its SQLite storage, and reports what it finds to the
// API. It keeps the account id only to name the account in those reports.
//
// Costs stay near the estimate because the object sleeps between wakes and does all due work in each wake:
// - one alarm, at the next due time and always at least 25 s ahead; work due within those 25 s is done in the same
//   wake, so checks and watch steps share wakes, and wakes are capped per clock hour;
// - probes run at most 6 at a time, each with an 8 s timeout;
// - storage holds state changes and hourly totals only: each wake writes one row of running state (streaks, due
//   times, the hour's counters), and a row per monitor when an hour ends or a state changes;
// - nothing runs once the pushed plan's validUntil (periodEnd + 24 h) passes, so a lost update from the API stops
//   checks by itself, and the Worker's kill flag stops everything.

import { base64url } from "./bytes"
import { pool, probe, resolutionResult, type ProbeResult } from "./check"
import { INTERNAL_NONCE_KEEP_MS, callbackOrigin, internalSecret, sendReport } from "./internal"
import { OPS_LIMITS } from "./limits"
import type { MonitorState, OpsEvent, OpsPlan, ProbeReason, ReleaseAnswer, ReleaseState } from "./protocol"
import {
  concluded,
  dueAt,
  newWatch,
  passedBaseline,
  regression,
  sameTarget,
  stepDue,
  stepWatch,
  watchId,
  type Baseline,
  type Watch,
} from "./release-watch"
import { workersRuntime, type DurableObjectState, type Env, type Runtime, type SqlValue } from "./runtime"
import { probeTarget, resolvePublic, validHostname, type Resolution } from "./ssrf"

/** The internal request's nonce, which the object records so a signed request is applied once. */
export const NONCE_HEADER = "x-vector-ops-nonce"
/** When the API signed the request (ms), compared with an erasure. */
export const SIGNED_AT_HEADER = "x-vector-ops-signed-at"
/** OPS_FLAGS key whose value "1" turns the Worker off. */
export const KILL_KEY = "kill"
export const INTERNAL_ACTIONS = ["plan", "config", "release", "state", "suspend", "erase", "flags"] as const
export type InternalAction = (typeof INTERNAL_ACTIONS)[number]

const HOUR_MS = 3_600_000
const NONCE = /^[A-Za-z0-9_-]{22,64}$/
const MONITOR_ID = /^[A-Za-z0-9_-]{1,64}$/
const SHA = /^[0-9a-f]{40}$/
const DEPLOYMENT = /^[A-Za-z0-9_-]{1,64}$/
const ENVIRONMENT = /^[^\u0000-\u001f\u007f]{1,255}$/
const ACCOUNT = /^[\x21-\x7e]{1,128}$/
const WRITES: readonly InternalAction[] = ["plan", "config", "release", "suspend"]

type HourTotals = { hour: number; ok: number; failed: number; inconclusive: number; ms: number }
type MonitorRun = {
  url: string
  due: number
  streak: number
  failSince?: number
  state: MonitorState
  since: number
  checkedAt?: number
  reason?: ProbeReason
  status?: number
  hour: HourTotals
}
type DnsEntry = { kind: "public" | "blocked" | "missing"; until: number }
type RunState = {
  v: 1
  monitors: Record<string, MonitorRun>
  watches: Watch[]
  dns: Record<string, DnsEntry>
  wakes: { hour: number; count: number }
}
type Suspension = { reason: "guard" | "owner"; at: number }
type MonitorRow = { id: string; url: string; host: string; position: number }
type Wake = {
  monitors: { id: string; url: string }[]
  watches: { id: string; urls: string[] }[]
  urls: string[]
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, position INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS changes (monitor TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, status INTEGER)",
  "CREATE INDEX IF NOT EXISTS changes_at ON changes (at)",
  "CREATE TABLE IF NOT EXISTS hourly (monitor TEXT NOT NULL, hour INTEGER NOT NULL, ok INTEGER NOT NULL, failed INTEGER NOT NULL, inconclusive INTEGER NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY (monitor, hour))",
  "CREATE TABLE IF NOT EXISTS releases (repo INTEGER NOT NULL, environment TEXT NOT NULL, sha TEXT NOT NULL, deployment TEXT NOT NULL, at INTEGER NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL, ended_at INTEGER, PRIMARY KEY (repo, environment, sha))",
  "CREATE TABLE IF NOT EXISTS baselines (repo INTEGER NOT NULL, environment TEXT NOT NULL, sha TEXT NOT NULL, ok TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repo, environment))",
  "CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS seen_expiry ON seen (expires_at)",
]

export class OpsAccount {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private readonly runtime: Runtime

  /** The runtime calls this with `ctx` and `env`; tests pass a fake runtime (clock and outbound fetch). */
  constructor(ctx: DurableObjectState, env: Env, runtime: Runtime = workersRuntime()) {
    this.ctx = ctx
    this.env = env
    this.runtime = runtime
    this.migrate()
  }

  async fetch(request: Request): Promise<Response> {
    const now = this.runtime.now()
    const action = /^\/internal\/([a-z-]{1,32})$/.exec(new URL(request.url).pathname)?.[1]
    if (!action || request.method !== "POST" || !(INTERNAL_ACTIONS as readonly string[]).includes(action))
      return failure(404, "OPS_NOT_FOUND")
    return this.internal(action as InternalAction, request, now)
  }

  /** The one alarm: the kill flag, then every check and watch round due, then the reports. */
  async alarm(): Promise<void> {
    const now = this.runtime.now()
    try {
      if (await this.killed()) {
        const run = this.run()
        this.countWake(run, now)
        this.save(run)
        if (this.hasWork(now)) await this.ctx.storage.setAlarm(now + OPS_LIMITS.killRecheckMs)
        else await this.ctx.storage.deleteAlarm()
        return
      }
      const wake = this.planWake(now)
      const { results, dns } = await this.probeAll(wake, now)
      this.applyWake(wake, results, dns, now)
      await this.deliver(this.runtime.now())
    } catch {
      // The schedule below still runs, so one bad wake never stops the account's checks.
    }
    try {
      await this.schedule(this.runtime.now())
    } catch {
      // Nothing to do: the runtime retries a failed alarm.
    }
  }

  // The internal API (signed by the API; the Worker checked the signature)

  private async internal(action: InternalAction, request: Request, now: number): Promise<Response> {
    const nonce = request.headers.get(NONCE_HEADER) ?? ""
    const signedAt = Number(request.headers.get(SIGNED_AT_HEADER) ?? "")
    if (
      !NONCE.test(nonce) ||
      !Number.isSafeInteger(signedAt) ||
      !this.once(`n:${nonce}`, now + INTERNAL_NONCE_KEEP_MS, now)
    )
      return failure(401, "INTERNAL_SIGNATURE_INVALID")
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure(400, "INTERNAL_BAD_REQUEST")
      body = parsed as Record<string, unknown>
    } catch {
      return failure(400, "INTERNAL_BAD_REQUEST")
    }
    if (action === "flags") return this.flags(body)
    if (typeof body.account !== "string" || !ACCOUNT.test(body.account)) return failure(400, "INTERNAL_BAD_REQUEST")
    const known = this.meta<string>("account")
    if (known !== undefined && known !== body.account) return failure(409, "OPS_MISROUTED")
    if (action === "erase") return this.erase(now)
    if (action === "state") return answer(this.state(now))
    // A call signed before an erasure (delayed on the way) must not fill the object again.
    const erasedAt = this.meta<number>("erased_at")
    if (WRITES.includes(action) && erasedAt !== undefined && signedAt <= erasedAt) return failure(409, "OPS_ERASED")
    let response: Response
    switch (action) {
      case "plan":
        response = this.plan(body, now)
        break
      case "config":
        response = this.config(body, now)
        break
      case "release":
        response = await this.release(body, now)
        break
      case "suspend":
        response = this.suspend(body, now)
        break
      default:
        return failure(404, "OPS_NOT_FOUND")
    }
    if (response.ok && known === undefined) this.setMeta("account", body.account)
    await this.schedule(now)
    return response
  }

  /** What the plan allows (§4.4, from the snapshot). A plan older than the stored one, by version, is ignored. */
  private plan(body: Record<string, unknown>, now: number) {
    const plan = parsePlan(body.plan, now)
    if (!plan) return failure(400, "INTERNAL_BAD_REQUEST")
    const current = this.meta<OpsPlan>("plan")
    if (current && plan.version < current.version) return answer({ applied: false, version: current.version })
    this.setMeta("plan", plan)
    const run = this.run()
    // A shorter interval (an upgrade) applies from now, not after the old one runs out.
    if (plan.onCall)
      for (const monitor of Object.values(run.monitors))
        monitor.due = Math.min(monitor.due, now + plan.onCall.intervalSec * 1000)
    this.settleWatches(run, now)
    this.save(run)
    return answer({ applied: true, version: plan.version })
  }

  /** The verified domains and the On Call URLs, replacing what was there. A changed URL starts its monitor over. */
  private config(body: Record<string, unknown>, now: number) {
    const config = parseConfig(body)
    if (!config) return failure(400, "INTERNAL_BAD_REQUEST")
    const run = this.run()
    const join = this.joinDue(run, now)
    const keep = new Set<string>()
    this.sql("DELETE FROM monitors")
    config.monitors.forEach((monitor, position) => {
      this.sql(
        "INSERT INTO monitors (id, url, host, position) VALUES (?, ?, ?, ?)",
        monitor.id,
        monitor.url,
        monitor.host,
        position,
      )
      keep.add(monitor.id)
      if (run.monitors[monitor.id]?.url === monitor.url) return
      if (run.monitors[monitor.id]) this.forgetMonitor(monitor.id)
      run.monitors[monitor.id] = freshMonitor(monitor.url, join, now)
    })
    for (const id of Object.keys(run.monitors)) {
      if (keep.has(id)) continue
      delete run.monitors[id]
      this.forgetMonitor(id)
    }
    this.setMeta("domains", config.domains)
    this.save(run)
    return answer({ monitors: config.monitors.length, probed: this.probedMonitors(this.meta<OpsPlan>("plan")).length })
  }

  /**
   * A production release to watch. In order: the plan, the kill flag and the age; a newer deployment ends the running
   * watch of the same repository and environment; then the dedupe by (repository, environment, sha), then the daily cap,
   * so a repeated report never counts twice.
   */
  private async release(body: Record<string, unknown>, now: number): Promise<Response> {
    const input = parseRelease(body)
    if (!input) return failure(400, "INTERNAL_BAD_REQUEST")
    // The one await comes first: from here on everything is read and written with nothing else running in between.
    const killed = await this.killed()
    const plan = this.meta<OpsPlan>("plan")
    if (!plan?.releaseGuard || !this.active(plan, now)) return answer({ accepted: false, reason: "not-in-plan" })
    if (killed) return answer({ accepted: false, reason: "off" } satisfies ReleaseAnswer)
    if (input.at < now - OPS_LIMITS.releaseMaxAgeMs) return answer({ accepted: false, reason: "stale" })
    const newest = this.sql<{ at: number | null }>(
      "SELECT max(at) AS at FROM releases WHERE repo = ? AND environment = ?",
      input.repositoryId,
      input.environment,
    )[0]?.at
    const known = this.sql<{ sha: string }>(
      "SELECT sha FROM releases WHERE repo = ? AND environment = ? AND sha = ?",
      input.repositoryId,
      input.environment,
      input.sha,
    ).length
    if (!known && typeof newest === "number" && input.at < newest) return answer({ accepted: false, reason: "older" })
    const run = this.run()
    for (const watch of run.watches)
      if (sameTarget(watch, input) && watch.sha !== input.sha && watch.at <= input.at)
        this.endWatch(watch, "superseded", now)
    run.watches = run.watches.filter((watch) => this.releaseState(watch) === "watching")
    if (known) {
      this.save(run)
      return answer({ accepted: false, reason: "duplicate" } satisfies ReleaseAnswer)
    }
    const verified = this.verified(plan)
    const urls = [
      ...new Set(
        input.urls.flatMap((url) => {
          const target = probeTarget(url, verified)
          return target.ok ? [target.url] : []
        }),
      ),
    ].slice(0, plan.releaseGuard.paths)
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000
    const today =
      this.sql<{ count: number }>(
        "SELECT count(*) AS count FROM releases WHERE received_at >= ? AND state != 'skipped'",
        dayStart,
      )[0]?.count ?? 0
    const refusal: ReleaseAnswer | undefined =
      today >= plan.releaseGuard.perDay
        ? { accepted: false, reason: "daily-limit" }
        : !urls.length
          ? { accepted: false, reason: "not-verified" }
          : undefined
    this.sql(
      "INSERT INTO releases (repo, environment, sha, deployment, at, received_at, state, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      input.repositoryId,
      input.environment,
      input.sha,
      input.deployment,
      input.at,
      now,
      refusal ? "skipped" : "watching",
      refusal ? now : null,
    )
    if (refusal) {
      this.save(run)
      return answer(refusal)
    }
    const baseline = this.baseline(input.repositoryId, input.environment)
    const watch = newWatch({ ...input, urls }, baseline, plan.releaseGuard.watchMin, now)
    run.watches.push(watch)
    this.save(run)
    return answer({ accepted: true, startAt: watch.startAt, endAt: watch.endAt } satisfies ReleaseAnswer)
  }

  /** The ops guard or the owner holds the account; nothing runs until lifted. Ordered by `at`. */
  private suspend(body: Record<string, unknown>, now: number) {
    if (
      typeof body.suspended !== "boolean" ||
      typeof body.at !== "number" ||
      !Number.isSafeInteger(body.at) ||
      body.at <= 0 ||
      (body.reason !== "guard" && body.reason !== "owner")
    )
      return failure(400, "INTERNAL_BAD_REQUEST")
    if (body.at < (this.meta<number>("suspend_at") ?? 0))
      return answer({ applied: false, suspended: this.meta<Suspension>("suspended") !== undefined })
    this.setMeta("suspend_at", body.at)
    if (body.suspended) this.setMeta("suspended", { reason: body.reason, at: body.at } satisfies Suspension)
    else this.deleteMeta("suspended")
    const run = this.run()
    this.settleWatches(run, now)
    this.save(run)
    return answer({ applied: true, suspended: body.suspended })
  }

  /** What the Worker knows about the account. URLs are left out: the API has them, by monitor id. */
  private state(now: number) {
    const plan = this.meta<OpsPlan>("plan")
    const run = this.run()
    const verified = this.verified(plan)
    const probed = new Set(this.probedMonitors(plan).map((monitor) => monitor.id))
    const monitors = this.sql<MonitorRow>("SELECT * FROM monitors ORDER BY position").map((row) => {
      const monitor = run.monitors[row.id]
      return {
        id: row.id,
        probed: probed.has(row.id),
        verified: verified.has(row.host),
        state: monitor?.state ?? "unknown",
        ...(monitor && monitor.state !== "unknown" ? { since: monitor.since } : {}),
        ...(monitor?.checkedAt !== undefined ? { checkedAt: monitor.checkedAt } : {}),
        ...(monitor?.reason ? { reason: monitor.reason } : {}),
        ...(monitor?.status !== undefined ? { status: monitor.status } : {}),
      }
    })
    const hourly = this.sql<{
      monitor: string
      hour: number
      ok: number
      failed: number
      inconclusive: number
      ms: number
    }>("SELECT * FROM hourly WHERE hour >= ? ORDER BY hour, monitor", now - 48 * HOUR_MS)
    for (const [id, monitor] of Object.entries(run.monitors))
      if (monitor.hour.ok + monitor.hour.failed + monitor.hour.inconclusive > 0)
        hourly.push({ monitor: id, ...monitor.hour })
    return {
      active: this.active(plan, now),
      plan: plan ? { version: plan.version, validUntil: plan.validUntil } : null,
      suspended: this.meta<Suspension>("suspended") !== undefined,
      monitors,
      changes: this.sql<{ monitor: string; at: number; state: string; reason: string | null; status: number | null }>(
        "SELECT monitor, at, state, reason, status FROM changes ORDER BY at DESC LIMIT 100",
      ).map((row) => ({
        monitor: row.monitor,
        at: row.at,
        state: row.state,
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.status !== null ? { status: row.status } : {}),
      })),
      hourly: hourly.map((row) => ({
        monitor: row.monitor,
        hour: row.hour,
        ok: row.ok,
        failed: row.failed,
        inconclusive: row.inconclusive,
        ...(row.ok ? { averageMs: Math.round(row.ms / row.ok) } : {}),
      })),
      releases: this.sql<{
        repo: number
        environment: string
        sha: string
        deployment: string
        at: number
        state: string
        ended_at: number | null
      }>(
        "SELECT repo, environment, sha, deployment, at, state, ended_at FROM releases ORDER BY received_at DESC LIMIT 20",
      ).map((row) => ({
        repositoryId: row.repo,
        environment: row.environment,
        sha: row.sha,
        deployment: row.deployment,
        at: row.at,
        state: row.state,
        ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      })),
      watches: run.watches.map((watch) => ({
        repositoryId: watch.repositoryId,
        environment: watch.environment,
        sha: watch.sha,
        startAt: watch.startAt,
        endAt: watch.endAt,
      })),
      pendingReports: this.sql<{ count: number }>("SELECT count(*) AS count FROM outbox")[0]?.count ?? 0,
    }
  }

  /**
   * Account deletion (P5, called by A57): the alarm and everything stored are deleted. Two things that hold nothing
   * about the account stay: the nonces already used, until they expire, and the erasure time, so a call signed before
   * the erasure and delivered late is refused instead of filling the object again.
   */
  private async erase(now: number) {
    const used = this.sql<{ id: string; expires_at: number }>(
      "SELECT id, expires_at FROM seen WHERE expires_at >= ?",
      now,
    )
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.migrate()
    for (const row of used) this.sql("INSERT INTO seen (id, expires_at) VALUES (?, ?)", row.id, row.expires_at)
    this.setMeta("erased_at", now)
    return answer({ erased: true })
  }

  /** The Worker's kill flag, written by the API when the owner's `ops` switch changes (through the control object). */
  private async flags(body: Record<string, unknown>) {
    if (typeof body.kill !== "boolean") return failure(400, "INTERNAL_BAD_REQUEST")
    if (body.kill) await this.env.OPS_FLAGS.put(KILL_KEY, "1")
    else await this.env.OPS_FLAGS.delete(KILL_KEY)
    return answer({ kill: body.kill })
  }

  // One wake: what is due, the probes, then the results (read and written again with no await in between, so a config
  // or release that arrived while the probes ran is kept)

  private planWake(now: number): Wake {
    const plan = this.meta<OpsPlan>("plan")
    const run = this.run()
    if (!plan || !this.active(plan, now)) return { monitors: [], watches: [], urls: [] }
    const slack = OPS_LIMITS.alarmMinAheadMs
    const monitors = this.probedMonitors(plan)
      .filter((row) => {
        const monitor = run.monitors[row.id]
        return monitor?.url === row.url && monitor.due <= now + slack
      })
      .map((row) => ({ id: row.id, url: row.url }))
    const verified = this.verified(plan)
    const watches = run.watches
      .filter((watch) => stepDue(watch, now))
      .map((watch) => ({
        id: watchId(watch),
        urls: watch.urls.filter((url) => {
          const target = probeTarget(url, verified)
          return target.ok
        }),
      }))
    const urls = [...new Set([...monitors.map((monitor) => monitor.url), ...watches.flatMap((watch) => watch.urls)])]
    return { monitors, watches, urls }
  }

  private async probeAll(wake: Wake, now: number) {
    const results = new Map<string, ProbeResult>()
    const fresh: Record<string, DnsEntry> = {}
    if (!wake.urls.length) return { results, dns: fresh }
    const cached = this.run().dns
    const hosts = [...new Set(wake.urls.map((url) => new URL(url).hostname))]
    const resolutions = new Map<string, Resolution>()
    const lookups = hosts.filter((host) => {
      const entry = cached[host]
      if (entry && entry.until > now) {
        resolutions.set(host, entry.kind === "public" ? { kind: "public", ttlMs: 0 } : { kind: entry.kind })
        return false
      }
      return true
    })
    await pool(lookups, OPS_LIMITS.lookupsInFlight, async (host) => {
      const resolution = await resolvePublic(host, this.runtime.fetch)
      resolutions.set(host, resolution)
      if (resolution.kind === "public") fresh[host] = { kind: "public", until: now + resolution.ttlMs }
      else if (resolution.kind !== "error")
        fresh[host] = { kind: resolution.kind, until: now + OPS_LIMITS.dnsMinCacheMs }
    })
    await pool(wake.urls, OPS_LIMITS.probesInFlight, async (url) => {
      const resolution = resolutions.get(new URL(url).hostname) ?? { kind: "error" as const }
      results.set(
        url,
        resolution.kind === "public"
          ? await probe(url, { fetch: this.runtime.fetch, now: () => this.runtime.now() })
          : resolutionResult(resolution),
      )
    })
    return { results, dns: fresh }
  }

  private applyWake(wake: Wake, results: Map<string, ProbeResult>, dns: Record<string, DnsEntry>, now: number) {
    const run = this.run()
    this.countWake(run, now)
    for (const [host, entry] of Object.entries(dns)) run.dns[host] = entry
    for (const [host, entry] of Object.entries(run.dns)) if (entry.until <= now) delete run.dns[host]
    const plan = this.meta<OpsPlan>("plan")
    for (const due of wake.monitors) {
      const monitor = run.monitors[due.id]
      const result = results.get(due.url)
      if (!monitor || monitor.url !== due.url || !result || !plan?.onCall) continue
      this.applyMonitor(due.id, monitor, result, plan.onCall.intervalSec * 1000, now)
    }
    const hour = hourOf(now)
    for (const [id, monitor] of Object.entries(run.monitors))
      if (monitor.hour.hour < hour) this.rollHour(id, monitor, now)
    const stepped = new Set(wake.watches.map((watch) => watch.id))
    for (const watch of run.watches) {
      if (stepped.has(watchId(watch))) stepWatch(watch, (url) => results.get(url), now)
      const failing = regression(watch)
      if (failing.length) {
        this.endWatch(watch, "regressed", now)
        this.queue(
          {
            kind: "release.regressed",
            repositoryId: watch.repositoryId,
            environment: watch.environment,
            sha: watch.sha,
            deployment: watch.deployment,
            goodSha: watch.baseline!.sha,
            failing,
          },
          now,
        )
      } else if (now + OPS_LIMITS.alarmMinAheadMs >= watch.endAt) {
        if (!concluded(watch)) {
          this.endWatch(watch, "stopped", now)
          continue
        }
        this.endWatch(watch, "passed", now)
        const baseline = passedBaseline(watch)
        this.sql(
          "INSERT INTO baselines (repo, environment, sha, ok, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo, environment) DO UPDATE SET sha = excluded.sha, ok = excluded.ok, at = excluded.at",
          watch.repositoryId,
          watch.environment,
          baseline.sha,
          JSON.stringify(baseline.ok),
          now,
        )
        this.queue(
          {
            kind: "release.passed",
            repositoryId: watch.repositoryId,
            environment: watch.environment,
            sha: watch.sha,
            deployment: watch.deployment,
          },
          now,
        )
      }
    }
    this.settleWatches(run, now)
    this.save(run)
    this.prune(now)
  }

  /** One On Call result: the hour's counters, the run of failures, and a state change with its report. */
  private applyMonitor(id: string, monitor: MonitorRun, result: ProbeResult, intervalMs: number, now: number) {
    if (monitor.hour.hour < hourOf(now)) this.rollHour(id, monitor, now)
    monitor.checkedAt = now
    monitor.reason = result.reason
    if (result.status !== undefined) monitor.status = result.status
    else delete monitor.status
    monitor.due += intervalMs
    if (monitor.due <= now) monitor.due = now + intervalMs
    if (result.outcome === "inconclusive") {
      monitor.hour.inconclusive++
      return
    }
    if (result.outcome === "ok") {
      monitor.hour.ok++
      monitor.hour.ms += Math.round(result.ms)
      monitor.streak = 0
      delete monitor.failSince
      if (monitor.state === "up") return
      if (monitor.state === "down") this.queue({ kind: "monitor.up", monitor: id, downSince: monitor.since }, now)
      monitor.state = "up"
      monitor.since = now
      this.change(id, "up", now)
      return
    }
    monitor.hour.failed++
    monitor.streak++
    monitor.failSince ??= now
    if (monitor.state === "down" || monitor.streak < OPS_LIMITS.failuresInARow) return
    monitor.state = "down"
    monitor.since = monitor.failSince
    this.change(id, "down", now, result.reason, result.status)
    this.queue(
      {
        kind: "monitor.down",
        monitor: id,
        since: monitor.since,
        reason: result.reason,
        ...(result.status !== undefined ? { status: result.status } : {}),
      },
      now,
    )
  }

  /** Writes a finished hour's totals (only when there were any) and starts the current hour. */
  private rollHour(id: string, monitor: MonitorRun, now: number) {
    const totals = monitor.hour
    if (totals.ok + totals.failed + totals.inconclusive > 0)
      this.sql(
        "INSERT INTO hourly (monitor, hour, ok, failed, inconclusive, ms) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(monitor, hour) DO UPDATE SET ok = hourly.ok + excluded.ok, failed = hourly.failed + excluded.failed, " +
          "inconclusive = hourly.inconclusive + excluded.inconclusive, ms = hourly.ms + excluded.ms",
        id,
        totals.hour,
        totals.ok,
        totals.failed,
        totals.inconclusive,
        totals.ms,
      )
    monitor.hour = emptyHour(now)
  }

  private change(id: string, state: MonitorState, now: number, reason?: ProbeReason, status?: number) {
    this.sql(
      "INSERT INTO changes (monitor, at, state, reason, status) VALUES (?, ?, ?, ?, ?)",
      id,
      now,
      state,
      reason ?? null,
      status ?? null,
    )
  }

  /** Ends every watch that may not continue: the plan lapsed or the account is held. */
  private settleWatches(run: RunState, now: number) {
    if (!this.active(this.meta<OpsPlan>("plan"), now))
      for (const watch of run.watches) if (this.releaseState(watch) === "watching") this.endWatch(watch, "stopped", now)
    run.watches = run.watches.filter((watch) => this.releaseState(watch) === "watching")
  }

  private endWatch(watch: Watch, state: Exclude<ReleaseState, "watching" | "skipped">, now: number) {
    this.sql(
      "UPDATE releases SET state = ?, ended_at = ? WHERE repo = ? AND environment = ? AND sha = ? AND state = 'watching'",
      state,
      now,
      watch.repositoryId,
      watch.environment,
      watch.sha,
    )
  }

  private releaseState(watch: Watch): ReleaseState | undefined {
    return this.sql<{ state: ReleaseState }>(
      "SELECT state FROM releases WHERE repo = ? AND environment = ? AND sha = ?",
      watch.repositoryId,
      watch.environment,
      watch.sha,
    )[0]?.state
  }

  private baseline(repo: number, environment: string): Baseline | undefined {
    const row = this.sql<{ sha: string; ok: string }>(
      "SELECT sha, ok FROM baselines WHERE repo = ? AND environment = ?",
      repo,
      environment,
    )[0]
    if (!row) return undefined
    try {
      const ok: unknown = JSON.parse(row.ok)
      return Array.isArray(ok)
        ? { sha: row.sha, ok: ok.filter((url): url is string => typeof url === "string") }
        : undefined
    } catch {
      return undefined
    }
  }

  // Reports to the API

  private queue(event: DistributiveOmit<OpsEvent, "v" | "id" | "at">, now: number) {
    const id = base64url(crypto.getRandomValues(new Uint8Array(16)))
    const body = JSON.stringify({ v: 1, id, at: now, ...event })
    this.sql("INSERT INTO outbox (id, body, attempts, next_at, created_at) VALUES (?, ?, 0, ?, ?)", id, body, now, now)
    this.sql(
      "DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)",
      OPS_LIMITS.outboxMax,
    )
  }

  /**
   * Sends the due reports, oldest first, in one signed request. A 2xx answer removes them; anything else keeps them
   * for a later wake, 30 s later and doubling to an hour. Reports older than a day are dropped.
   */
  private async deliver(now: number) {
    this.sql("DELETE FROM outbox WHERE created_at < ?", now - OPS_LIMITS.outboxKeepMs)
    const target = this.reportTarget()
    if (!target) return
    const rows = this.sql<{ id: string; body: string; attempts: number }>(
      "SELECT id, body, attempts FROM outbox WHERE next_at <= ? ORDER BY created_at, id LIMIT ?",
      now,
      OPS_LIMITS.callbackBatch,
    )
    if (!rows.length) return
    const events = rows.map((row) => JSON.parse(row.body) as OpsEvent)
    const delivered = await sendReport(this.runtime.fetch, {
      origin: target.origin,
      secret: target.secret,
      body: JSON.stringify({ v: 1, account: target.account, events }),
      now,
    })
    for (const row of rows) {
      if (delivered) this.sql("DELETE FROM outbox WHERE id = ?", row.id)
      else
        this.sql(
          "UPDATE outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?",
          now + Math.min(OPS_LIMITS.outboxRetryBaseMs * 2 ** row.attempts, OPS_LIMITS.outboxRetryMaxMs),
          row.id,
        )
    }
  }

  private reportTarget() {
    const account = this.meta<string>("account")
    const origin = callbackOrigin(this.env.API_ORIGIN)
    const secret = internalSecret(this.env.INTERNAL_SECRET)
    return account && origin && secret ? { account, origin, secret } : undefined
  }

  // The alarm

  /**
   * One alarm at the earliest due check, watch round, watch end, report retry or plan expiry; at least 25 s ahead, and
   * in the next clock hour once this one has had its wakes. No work, no alarm.
   */
  private async schedule(now: number) {
    const due = this.dueTimes(now)
    if (!due.length) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    let at = Math.max(Math.min(...due), now + OPS_LIMITS.alarmMinAheadMs)
    const wakes = this.run().wakes
    if (wakes.hour === hourOf(at) && wakes.count >= OPS_LIMITS.maxWakesPerHour) at = wakes.hour + HOUR_MS
    if ((await this.ctx.storage.getAlarm()) !== at) await this.ctx.storage.setAlarm(at)
  }

  private dueTimes(now: number) {
    const plan = this.meta<OpsPlan>("plan")
    const due: number[] = []
    if (plan && this.active(plan, now)) {
      const run = this.run()
      for (const row of this.probedMonitors(plan)) {
        const monitor = run.monitors[row.id]
        if (monitor?.url === row.url) due.push(monitor.due)
      }
      for (const watch of run.watches) due.push(dueAt(watch))
      // A wake when the plan lapses ends what is running, even if nothing else is due before then.
      if (due.length) due.push(plan.validUntil)
    }
    if (this.reportTarget()) {
      const next = this.sql<{ at: number | null }>("SELECT min(next_at) AS at FROM outbox")[0]?.at
      if (typeof next === "number") due.push(next)
    }
    return due
  }

  private hasWork(now: number) {
    return this.dueTimes(now).length > 0
  }

  private countWake(run: RunState, now: number) {
    const hour = hourOf(now)
    if (run.wakes.hour !== hour) run.wakes = { hour, count: 0 }
    run.wakes.count++
  }

  // Plan, monitors and helpers

  private active(plan: OpsPlan | undefined, now: number): plan is OpsPlan {
    return !!plan && now < plan.validUntil && this.meta<Suspension>("suspended") === undefined
  }

  /** The verified domains the plan uses: the first `plan.domains`, in verification order. */
  private verified(plan: OpsPlan | undefined) {
    return new Set((this.meta<string[]>("domains") ?? []).slice(0, plan?.domains ?? 0))
  }

  /** The monitors checked: the first `onCall.urls` (in the order added) whose host is a verified domain the plan uses. */
  private probedMonitors(plan: OpsPlan | undefined): MonitorRow[] {
    if (!plan?.onCall) return []
    const verified = this.verified(plan)
    return this.sql<MonitorRow>("SELECT * FROM monitors ORDER BY position")
      .filter((row) => verified.has(row.host))
      .slice(0, plan.onCall.urls)
  }

  /** A new monitor joins the next round of the others, so the account's checks share wakes. */
  private joinDue(run: RunState, now: number) {
    const dues = Object.values(run.monitors)
      .map((monitor) => monitor.due)
      .filter((due) => due >= now)
    return dues.length ? Math.min(...dues) : now
  }

  private forgetMonitor(id: string) {
    this.sql("DELETE FROM changes WHERE monitor = ?", id)
    this.sql("DELETE FROM hourly WHERE monitor = ?", id)
  }

  /** At most once an hour: state changes, hourly totals, finished releases and nonces past their keep. */
  private prune(now: number) {
    if (now - (this.meta<number>("pruned_at") ?? 0) < HOUR_MS) return
    const before = now - OPS_LIMITS.keepMs
    this.sql("DELETE FROM changes WHERE at < ?", before)
    this.sql("DELETE FROM hourly WHERE hour < ?", before)
    this.sql("DELETE FROM releases WHERE received_at < ? AND state != 'watching'", before)
    this.sql("DELETE FROM seen WHERE expires_at < ?", now)
    this.setMeta("pruned_at", now)
  }

  /** The kill flag. A flag that cannot be read counts as set: the Worker fails closed. */
  private async killed() {
    try {
      return (await this.env.OPS_FLAGS.get(KILL_KEY)) === "1"
    } catch {
      return true
    }
  }

  private run(): RunState {
    const stored = this.meta<RunState>("run")
    if (stored?.v === 1 && stored.monitors && Array.isArray(stored.watches) && stored.dns && stored.wakes) return stored
    return { v: 1, monitors: {}, watches: [], dns: {}, wakes: { hour: 0, count: 0 } }
  }

  private save(run: RunState) {
    this.setMeta("run", run)
  }

  // Storage

  private migrate() {
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement)
  }

  private sql<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Row[] {
    return this.ctx.storage.sql.exec<Row>(query, ...bindings).toArray()
  }

  private meta<T>(key: string): T | undefined {
    const row = this.sql<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)[0]
    if (!row) return undefined
    try {
      return JSON.parse(row.v) as T
    } catch {
      return undefined
    }
  }

  private setMeta(key: string, value: unknown) {
    this.sql(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key,
      JSON.stringify(value),
    )
  }

  private deleteMeta(key: string) {
    this.sql("DELETE FROM meta WHERE k = ?", key)
  }

  /** Records an id (an internal nonce) once; false when it was already seen and has not expired. */
  private once(id: string, expiresAt: number, now: number) {
    this.sql("DELETE FROM seen WHERE expires_at < ?", now)
    if (this.sql("SELECT 1 AS hit FROM seen WHERE id = ?", id).length) return false
    this.sql("INSERT INTO seen (id, expires_at) VALUES (?, ?)", id, expiresAt)
    return true
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function hourOf(now: number) {
  return Math.floor(now / HOUR_MS) * HOUR_MS
}

function emptyHour(now: number): HourTotals {
  return { hour: hourOf(now), ok: 0, failed: 0, inconclusive: 0, ms: 0 }
}

function freshMonitor(url: string, due: number, now: number): MonitorRun {
  return { url, due, streak: 0, state: "unknown", since: now, hour: emptyHour(now) }
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}

/** A pushed plan within the bounds any real plan keeps (ENTITLEMENTS, checked in the root contract test). */
export function parsePlan(input: unknown, now: number): OpsPlan | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const plan = input as Record<string, unknown>
  if (!integer(plan.version, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (!integer(plan.domains, 0, OPS_LIMITS.maxDomains)) return undefined
  if (!integer(plan.validUntil, 0, now + OPS_LIMITS.maxValidAheadMs)) return undefined
  let onCall: OpsPlan["onCall"] = null
  if (plan.onCall !== null) {
    const value = plan.onCall as Record<string, unknown> | undefined
    if (
      !value ||
      typeof value !== "object" ||
      !integer(value.urls, 1, OPS_LIMITS.maxMonitors) ||
      !integer(value.intervalSec, OPS_LIMITS.minIntervalSec, OPS_LIMITS.maxIntervalSec)
    )
      return undefined
    onCall = { urls: value.urls, intervalSec: value.intervalSec }
  }
  let releaseGuard: OpsPlan["releaseGuard"] = null
  if (plan.releaseGuard !== null) {
    const value = plan.releaseGuard as Record<string, unknown> | undefined
    if (
      !value ||
      typeof value !== "object" ||
      !integer(value.perDay, 1, OPS_LIMITS.maxReleasesPerDay) ||
      !integer(value.watchMin, 1, OPS_LIMITS.maxWatchMin) ||
      !integer(value.paths, 1, OPS_LIMITS.maxReleasePaths)
    )
      return undefined
    releaseGuard = { perDay: value.perDay, watchMin: value.watchMin, paths: value.paths }
  }
  return { version: plan.version, domains: plan.domains, onCall, releaseGuard, validUntil: plan.validUntil }
}

function parseConfig(body: Record<string, unknown>) {
  const { domains, monitors } = body
  if (!Array.isArray(domains) || domains.length > OPS_LIMITS.maxDomains) return undefined
  if (!domains.every(validHostname) || new Set(domains).size !== domains.length) return undefined
  if (!Array.isArray(monitors) || monitors.length > OPS_LIMITS.maxMonitors) return undefined
  const parsed: { id: string; url: string; host: string }[] = []
  for (const entry of monitors) {
    if (!entry || typeof entry !== "object") return undefined
    const { id, url } = entry as { id?: unknown; url?: unknown }
    if (typeof id !== "string" || !MONITOR_ID.test(id)) return undefined
    const target = probeTarget(url)
    if (!target.ok) return undefined
    parsed.push({ id, url: target.url, host: target.host })
  }
  if (new Set(parsed.map((monitor) => monitor.id)).size !== parsed.length) return undefined
  return { domains: domains as string[], monitors: parsed }
}

function parseRelease(body: Record<string, unknown>) {
  const { repositoryId, environment, sha, deployment, at, urls } = body
  if (!integer(repositoryId, 1, Number.MAX_SAFE_INTEGER)) return undefined
  if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) return undefined
  if (typeof sha !== "string" || !SHA.test(sha)) return undefined
  if (typeof deployment !== "string" || !DEPLOYMENT.test(deployment)) return undefined
  if (!integer(at, 1, Number.MAX_SAFE_INTEGER)) return undefined
  if (!Array.isArray(urls) || !urls.length || urls.length > OPS_LIMITS.maxReleasePaths) return undefined
  const normalised: string[] = []
  for (const url of urls) {
    const target = probeTarget(url)
    if (!target.ok) return undefined
    normalised.push(target.url)
  }
  return { repositoryId, environment, sha, deployment, at, urls: normalised }
}

export function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export function failure(status: number, code: string) {
  return answer({ error: { code } }, status)
}
