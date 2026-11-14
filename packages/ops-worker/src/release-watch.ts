// Release Guard's watch of one production release (WP A46). Pure functions over a watch's state; the account's object
// (ops-account.ts) stores the state, runs the probes and sends the reports.
//
// - A watch starts 60 s after the deployment reported success (at once if that was longer ago, and never more than
//   60 s from now if the reported time is ahead of this clock).
// - Every 30 s until the plan's watch length has passed it probes each of the release's URLs (the production URL with
//   each path from .vector/ops.json) and compares with the last good release: a URL that passed on the last good
//   release and fails twice in a row now is a regression, which ends the watch at once. Inconclusive answers neither
//   count nor break a run of failures. A URL the last good release never passed cannot regress.
// - A watch that ran to its end without a regression is the new last good release, provided it saw at least one
//   conclusive answer. It passes the URLs whose last conclusive answer was ok, and keeps the earlier release's passes for
//   URLs it never got a conclusive answer for.
// - A newer deployment of the same repository and environment ends the watch (superseded); the object dedupes releases
//   by (repository, environment, sha).

import type { ProbeResult } from "./check"
import { OPS_LIMITS } from "./limits"
import type { ProbeReason } from "./protocol"

/** The last good release of a repository and environment: its sha and the URLs that passed on it. */
export type Baseline = { sha: string; ok: string[] }

export type Watch = {
  repositoryId: number
  environment: string
  sha: string
  deployment: string
  /** When the deployment reported success. */
  at: number
  urls: string[]
  startAt: number
  endAt: number
  nextAt: number
  /** Failures in a row, per URL. */
  streaks: Record<string, number>
  /** The last conclusive answer, per URL. */
  last: Record<string, "ok" | "fail">
  /** The latest failure, per URL, for the report. */
  failures: Record<string, { reason: ProbeReason; status?: number }>
  /** The last good release when the watch started; absent for the first release watched. */
  baseline?: Baseline
}

export function watchId(watch: Pick<Watch, "repositoryId" | "environment" | "sha">) {
  return `${watch.repositoryId}\n${watch.environment}\n${watch.sha}`
}

export function sameTarget(
  left: Pick<Watch, "repositoryId" | "environment">,
  right: Pick<Watch, "repositoryId" | "environment">,
) {
  return left.repositoryId === right.repositoryId && left.environment === right.environment
}

/** When a watch of a deployment that reported success at `at` starts and ends. */
export function watchWindow(at: number, now: number, watchMin: number) {
  const startAt = Math.min(Math.max(at + OPS_LIMITS.releaseSettleMs, now), now + OPS_LIMITS.releaseSettleMs)
  return { startAt, endAt: startAt + watchMin * 60_000 }
}

export function newWatch(
  input: { repositoryId: number; environment: string; sha: string; deployment: string; at: number; urls: string[] },
  baseline: Baseline | undefined,
  watchMin: number,
  now: number,
): Watch {
  const { startAt, endAt } = watchWindow(input.at, now, watchMin)
  return {
    repositoryId: input.repositoryId,
    environment: input.environment,
    sha: input.sha,
    deployment: input.deployment,
    at: input.at,
    urls: [...input.urls],
    startAt,
    endAt,
    nextAt: startAt,
    streaks: {},
    last: {},
    failures: {},
    ...(baseline ? { baseline: { sha: baseline.sha, ok: [...baseline.ok] } } : {}),
  }
}

/**
 * Whether a probe round is due within `slack` of now. The first round is never early: the 60 s after success are the
 * release's time to settle.
 */
export function stepDue(watch: Watch, now: number, slack = OPS_LIMITS.alarmMinAheadMs) {
  const early = watch.nextAt === watch.startAt ? 0 : slack
  return watch.nextAt < watch.endAt && watch.nextAt <= now + early
}

/** The next time the watch needs a wake: its next round, or its end. */
export function dueAt(watch: Watch) {
  return watch.nextAt < watch.endAt ? watch.nextAt : watch.endAt
}

/** Applies one round's answers (a URL with no answer this round is left as it was) and schedules the next round. */
export function stepWatch(watch: Watch, results: (url: string) => ProbeResult | undefined, now: number) {
  for (const url of watch.urls) {
    const result = results(url)
    if (!result || result.outcome === "inconclusive") continue
    if (result.outcome === "ok") {
      watch.streaks[url] = 0
      watch.last[url] = "ok"
      continue
    }
    watch.streaks[url] = (watch.streaks[url] ?? 0) + 1
    watch.last[url] = "fail"
    watch.failures[url] = { reason: result.reason, ...(result.status !== undefined ? { status: result.status } : {}) }
  }
  watch.nextAt += OPS_LIMITS.releaseStepMs
  if (watch.nextAt <= now) watch.nextAt = now + OPS_LIMITS.releaseStepMs
}

/** The URLs that passed on the last good release and have now failed twice in a row. Empty: no regression. */
export function regression(watch: Watch) {
  const passed = new Set(watch.baseline?.ok ?? [])
  return watch.urls
    .filter((url) => passed.has(url) && (watch.streaks[url] ?? 0) >= OPS_LIMITS.failuresInARow)
    .map((url) => ({ url, ...(watch.failures[url] ?? { reason: "network" as ProbeReason }) }))
}

/** Whether the watch saw any conclusive answer; one that saw none gives no verdict. */
export function concluded(watch: Watch) {
  return Object.keys(watch.last).length > 0
}

/** The baseline a watch that ran to its end without a regression leaves for the next release. */
export function passedBaseline(watch: Watch): Baseline {
  const earlier = new Set(watch.baseline?.ok ?? [])
  const ok = watch.urls.filter((url) => (watch.last[url] === undefined ? earlier.has(url) : watch.last[url] === "ok"))
  return { sha: watch.sha, ok }
}
