// The ops Worker's interface with Vector's API (WP A46). Pure types and constants with no imports, so the API (A47, A48,
// A50) can import them without pulling in Worker code.
//
// The API calls the Worker: POST https://<worker>/internal/v1/<action>, signed with WP A37's HMAC under the `ops`
// service key (VECTOR_OPS_SHARED_SECRET on the API, INTERNAL_SECRET on the Worker). Each body is a JSON object; every
// action but `flags` names the account.
//
//   plan {account, plan}                     what the account's plan allows, from its entitlement snapshot (§4.4):
//                                            onCall null stops checks, releaseGuard null stops new watches, and
//                                            validUntil (periodEnd + 24 h) stops everything by itself once it passes;
//                                            a plan older than the stored one (by version) is ignored
//   config {account, domains, monitors}      the verified domains (in verification order) and the On Call URLs (in the
//                                            order they were added), replacing what was there
//   release {account, repositoryId, ...}     a production deployment reported success: watch it (Release Guard)
//   state {account}                          what the Worker knows: each monitor's state, recent changes, hourly totals,
//                                            recent releases and running watches
//   suspend {account, suspended, reason, at} the ops guard or the owner holds the account: nothing runs while held;
//                                            ordered by `at`, so a late update never undoes a newer one
//   erase {account}                          everything the account's object holds (P5, A57)
//   flags {kill}                             the Worker's kill flag (the owner's `ops` switch)
//
// The Worker reports to the API: POST <API_ORIGIN>/api/ops/worker with an OpsReport body, signed the same way (the API
// checks it with requireInternalRequest("ops", …)). A 2xx answer means every event in it was taken; anything else and
// the Worker sends the same events again later, with the same ids, so the API must dedupe by event id.

export const OPS_INTERNAL_PREFIX = "/internal/v1/"
export const OPS_CALLBACK_PATH = "/api/ops/worker"

export type OpsAction = "plan" | "config" | "release" | "state" | "suspend" | "erase" | "flags"

/** The plan's ops caps (ENTITLEMENTS ops, private copy) and how long they hold. */
export type OpsPlan = {
  /** The entitlement snapshot's version. A plan with a lower version than the stored one is ignored. */
  version: number
  /** Verified domains used, in verification order (ENTITLEMENTS ops.onCall.domains). */
  domains: number
  /** null: no checks (frozen, ended, On Call not listed). */
  onCall: { urls: number; intervalSec: number } | null
  /** null: no new watches (paused, frozen, Release Guard not listed). */
  releaseGuard: { perDay: number; watchMin: number; paths: number } | null
  /** Milliseconds. Nothing runs from this time on until a newer plan arrives (periodEnd + 24 h; now to stop at once). */
  validUntil: number
}

export type PlanBody = { account: string; plan: OpsPlan }

export type ConfigBody = {
  account: string
  /** Lower-case host names the account verified (A47), at most 10. Only these are ever probed. */
  domains: string[]
  /** On Call URLs: https on 443 on a verified host; ids are 1-64 letters, digits, `_` or `-`. At most 10. */
  monitors: { id: string; url: string }[]
}

export type ReleaseBody = {
  account: string
  repositoryId: number
  environment: string
  /** The deployed commit, 40 hex digits. Releases are deduped by (repository, environment, sha). */
  sha: string
  /** GitHub's deployment id, as text. */
  deployment: string
  /** When the deployment reported success, milliseconds. */
  at: number
  /** The production URL with each Release Guard path (.vector/ops.json), on verified hosts; at most the plan's paths. */
  urls: string[]
}

export type SuspendBody = { account: string; suspended: boolean; reason: "guard" | "owner"; at: number }

export type ReleaseAnswer =
  | { accepted: true; startAt: number; endAt: number }
  | {
      accepted: false
      reason: "not-in-plan" | "off" | "stale" | "older" | "duplicate" | "daily-limit" | "not-verified"
    }

/** Why a probe came out as it did. */
export type ProbeReason =
  // ok
  | "status" // 2xx, or 304
  | "redirect" // a 3xx to the same origin (not followed); as a failure, a 3xx elsewhere or with no usable Location
  // failure
  | "timeout"
  | "network"
  | "dns" // the host has no address
  // inconclusive
  | "auth" // 401 or 403
  | "rate-limited" // 429
  | "challenge" // a bot check answered instead of the site
  | "address" // the host resolves to a private or reserved address: never probed
  | "resolver" // the DNS lookup itself failed
export type ProbeOutcome = "ok" | "fail" | "inconclusive"

export type MonitorState = "unknown" | "up" | "down"
export type ReleaseState = "watching" | "passed" | "regressed" | "superseded" | "stopped" | "skipped"

export type OpsEvent =
  | {
      v: 1
      id: string
      kind: "monitor.down"
      at: number
      monitor: string
      since: number
      reason: ProbeReason
      status?: number
    }
  | { v: 1; id: string; kind: "monitor.up"; at: number; monitor: string; downSince: number }
  | {
      v: 1
      id: string
      kind: "release.regressed"
      at: number
      repositoryId: number
      environment: string
      sha: string
      deployment: string
      /** The last good release's sha, which the regressed paths passed on. */
      goodSha: string
      failing: { url: string; reason: ProbeReason; status?: number }[]
    }
  | {
      v: 1
      id: string
      kind: "release.passed"
      at: number
      repositoryId: number
      environment: string
      sha: string
      deployment: string
    }

/** One report: the events of one account, oldest first. */
export type OpsReport = { v: 1; account: string; events: OpsEvent[] }
