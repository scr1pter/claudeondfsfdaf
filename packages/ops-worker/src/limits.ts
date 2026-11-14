// The ops Worker's fixed limits (WP A46). A plan's own caps (On Call URLs, interval and domains; Release Guard releases a
// day, watch length and paths) come from the API in each pushed plan (ENTITLEMENTS ops, private copy). The bounds here
// only refuse a plan no real one could be. test/ops-worker-contract.test.ts (repository root) keeps them in line with
// ENTITLEMENTS.

export const OPS_LIMITS = {
  /** A probe that has not answered within this is a failure (timeout). */
  probeTimeoutMs: 8_000,
  /** Probes in flight at once, per account. */
  probesInFlight: 6,
  /** Hosts resolved at once, per account (two DNS-over-HTTPS questions each). */
  lookupsInFlight: 3,
  /**
   * The next alarm is always at least this far ahead. Work due within this of a wake is done in that wake, so checks
   * and watch steps due close together share one wake.
   */
  alarmMinAheadMs: 25_000,
  /**
   * Alarm wakes per clock hour, per account. With checks every minute and a release watch every 30 s, an account needs
   * 120; past the cap the next alarm waits for the next hour.
   */
  maxWakesPerHour: 125,
  /** While the kill flag is set, an account with work re-reads it this often (and does nothing else). */
  killRecheckMs: 10 * 60_000,
  /** Failures in a row before a URL is down. Inconclusive answers neither count nor break the run. */
  failuresInARow: 2,
  /** A release watch starts this long after the deployment reported success, */
  releaseSettleMs: 60_000,
  /** and compares with the last good release this often until the plan's watch length has passed. */
  releaseStepMs: 30_000,
  /** A deployment reported more than this long ago is not watched. */
  releaseMaxAgeMs: 24 * 60 * 60_000,
  /** The largest any plan allows (ENTITLEMENTS Ultra); a config or plan asking more is refused. */
  maxMonitors: 10,
  maxDomains: 10,
  maxReleasePaths: 5,
  maxReleasesPerDay: 100,
  minIntervalSec: 60,
  maxIntervalSec: 3_600,
  maxWatchMin: 120,
  /** A pushed plan's validUntil (periodEnd + 24 h) is never further ahead than this. */
  maxValidAheadMs: 40 * 24 * 60 * 60_000,
  /** State changes, hourly totals and release records older than this are deleted. */
  keepMs: 30 * 24 * 60 * 60_000,
  /** DNS answers are reused for their TTL, clamped to this range. */
  dnsMinCacheMs: 60_000,
  dnsMaxCacheMs: 300_000,
  /** A 5xx HTML answer's first bytes are read to tell a bot challenge from an outage. */
  challengeSniffBytes: 8_192,
  urlMaxLength: 2_048,
  /** Reports to the API: one request carries at most this many events, and gives up after the timeout. */
  callbackTimeoutMs: 10_000,
  callbackBatch: 20,
  /** Undelivered reports are retried with growing gaps, kept at most this many and this long. */
  outboxMax: 200,
  outboxRetryBaseMs: 30_000,
  outboxRetryMaxMs: 60 * 60_000,
  outboxKeepMs: 24 * 60 * 60_000,
  /** Internal API bodies. */
  internalBodyBytes: 32 * 1024,
} as const
