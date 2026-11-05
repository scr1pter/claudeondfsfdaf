import { createHash, randomBytes } from "node:crypto"
import type { ProbeReason, ReleaseAnswer, ReleaseBody } from "../../packages/ops-worker/src/protocol.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import {
  GithubServerError,
  githubServerError,
  withRepositoryToken,
  type GithubRepoClient,
  type GithubServerOptions,
} from "./github-app-server.js"
import { ApiError } from "./http.js"
import {
  claimCounted,
  indexMembers,
  readRecord,
  readRecords,
  saveRecord,
  unclaimCounted,
  updateRecord,
  utcDay,
  type IndexEntry,
} from "./ops-records.js"
import { opsRelease } from "./ops-worker.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Release Guard (WP A48). A production deployment that GitHub reports as a success is watched by the ops Worker (A46);
 * if it breaks a path that passed on the last good release, Vector opens one revert pull request and the person merges
 * it. Vector's server never merges (S9).
 *
 * The intake (`releaseIntake`, called from the GitHub webhook's ops handler for a bound repository with Release Guard on,
 * a usable plan and verified URLs) checks, in order: the release is new (one record per repository, environment and
 * sha); the repository's `.vector/ops.json` at the deployed commit opts in for this account (its `opsId`, Release Guard
 * on, the same environment), read with a read-only one-repository App token; and the plan's releases a day, counted only
 * after the dedupe (one script: dedupe before increment). Then the Worker is asked to watch it.
 *
 * A regression (`openRevert`, from the Worker's `release.regressed` report) opens at most one revert pull request per
 * repository, environment and sha: a claim in the store (SET NX semantics, kept 35 days) holds the outcome, and a retry
 * of the report finds it. Writing needs a `revert` App token and, read again right before the writes, the opt-in in
 * `.vector/ops.json` on the branch the pull request targets. Then:
 * - when the range from the last good release to the deployed sha is exactly one merged pull request, GitHub's own
 *   GraphQL `revertPullRequest`;
 * - otherwise a restore commit (the last good release's tree, on top of the deployed sha) on its own branch, with a pull
 *   request, only when the target branch's head is still the deployed sha;
 * - never when a workflow file (.github/workflows/) is in the range, or the file list is too long to know: then nothing
 *   is written and the card offers "open in GitHub" and the host's rollback link.
 * Every revert names the commits it undoes and warns when the range touches files that look like database migrations.
 * A pull request found already open from an earlier try (an answer lost on the way) is reused, never opened twice.
 */

export const RELEASE_GUARD_LIMITS = {
  /** Release records and revert claims are kept this long (the Worker keeps 30 days of releases). */
  recordMs: 35 * 24 * 60 * 60_000,
  /**
   * A release claimed at the intake but not yet answered by the Worker holds its claim this long, so a delivery cut off
   * mid-way (the function stopped) does not leave the release a "duplicate" for weeks.
   */
  pendingMs: 10 * 60_000,
  /** Releases listed per account. */
  indexMax: 500,
  /** The day's release counter outlives its UTC day by a day. */
  counterMs: 2 * 24 * 60 * 60_000,
  /** .vector/ops.json is a few lines; anything larger is not an opt-in. */
  optInBytes: 4_096,
  /** Commits a card and a pull request body list. */
  commitsShown: 50,
  /** Migration paths a card lists. */
  migrationsShown: 20,
  /** GitHub's compare lists at most 300 files; a range that reaches it may hold files not listed. */
  compareFiles: 300,
  /** A revert attempt holds its claim this long, so a retry that arrives meanwhile waits for it. */
  revertLeaseMs: 2 * 60_000,
  /** Tries before a revert that keeps meeting an unavailable GitHub is left to the person. */
  revertAttempts: 8,
} as const

const SHA = /^[0-9a-f]{40}$/
const OPS_ID = /^ops_[A-Za-z0-9_-]{22}$/
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/

/** The environment's part of a key: GitHub names environments freely, so it is hashed (without case). */
export function environmentKey(environment: string) {
  return createHash("sha256").update(environment.toLowerCase()).digest("hex").slice(0, 16)
}

function key(mode: StripeMode | undefined, ...parts: (string | number)[]) {
  return mode ? codiumKeyIn(mode, ...parts) : codiumKey(...parts)
}

export const releaseRecordKey = (
  account: string,
  repositoryId: number,
  environment: string,
  sha: string,
  mode?: StripeMode,
) => key(mode, "ops", "rg", account, repositoryId, environmentKey(environment), sha)
export const releaseIndexKey = (account: string, mode?: StripeMode) => key(mode, "ops", "rg", account, "index")
export const releaseDayKey = (account: string, day: string, mode?: StripeMode) =>
  key(mode, "ops", "rg", account, "day", day)
export const revertClaimKey = (
  account: string,
  repositoryId: number,
  environment: string,
  sha: string,
  mode?: StripeMode,
) => key(mode, "ops", "rg", account, "revert", repositoryId, environmentKey(environment), sha)
const releaseMember = (repositoryId: number, environment: string, sha: string) =>
  `${repositoryId}:${environmentKey(environment)}:${sha}`

// ── .vector/ops.json ───────────────────────────────────────────────────────────────────────────────────────────────

/** The repository's opt-in to server writes (contract §4.15). */
export type OpsJsonFile = {
  opsId: string
  environment: string
  productionUrl?: string
  paths: string[]
  releaseGuard: boolean
  shipDesk: boolean
}

/** .vector/ops.json, checked by shape. Unknown fields are ignored; a file that is not this shape opts in to nothing. */
export function parseOpsJson(text: string): OpsJsonFile | undefined {
  if (text.length > RELEASE_GUARD_LIMITS.optInBytes) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const file = value as Record<string, unknown>
  if (typeof file.opsId !== "string" || !OPS_ID.test(file.opsId)) return undefined
  if (typeof file.environment !== "string" || !file.environment || file.environment.length > 255) return undefined
  if (file.productionUrl !== undefined && typeof file.productionUrl !== "string") return undefined
  const paths = file.paths === undefined ? [] : file.paths
  if (!Array.isArray(paths) || paths.length > 5 || !paths.every((path) => typeof path === "string")) return undefined
  if (typeof file.releaseGuard !== "boolean" || typeof file.shipDesk !== "boolean") return undefined
  return {
    opsId: file.opsId,
    environment: file.environment,
    ...(typeof file.productionUrl === "string" ? { productionUrl: file.productionUrl } : {}),
    paths: paths as string[],
    releaseGuard: file.releaseGuard,
    shipDesk: file.shipDesk,
  }
}

/** Whether the file lets this account's Release Guard act here: its ops id, Release Guard on, the same environment. */
export function optInAllows(file: OpsJsonFile | undefined, input: { opsId: string; environment: string }) {
  return (
    file !== undefined &&
    file.opsId === input.opsId &&
    file.releaseGuard === true &&
    file.environment.toLowerCase() === input.environment.toLowerCase()
  )
}

/** .vector/ops.json at `ref`, or undefined when it is missing, too large or not the right shape. */
export async function readOptIn(client: GithubRepoClient, ref: string): Promise<OpsJsonFile | undefined> {
  const answer = await client.get(`/contents/.vector/ops.json?ref=${encodeURIComponent(ref)}`)
  const file = answer as { type?: unknown; encoding?: unknown; content?: unknown; size?: unknown } | undefined
  if (!file || file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") return undefined
  if (typeof file.size === "number" && file.size > RELEASE_GUARD_LIMITS.optInBytes) return undefined
  const text = Buffer.from(file.content.replace(/\s+/g, ""), "base64").toString("utf8")
  return parseOpsJson(text)
}

// ── Release records ────────────────────────────────────────────────────────────────────────────────────────────────

export type ReleaseState = "pending" | "watching" | "skipped" | "passed" | "regressed"

/** What Vector keeps about one watched release (`ops:rg:…`): no page content, only what the cards and links need. */
export type ReleaseRecord = {
  v: 1
  repositoryId: number
  repository: string
  environment: string
  sha: string
  deployment: string
  /** When the deployment reported success. */
  at: number
  receivedAt: number
  /** The deployment's ref (a branch, a tag or a sha), for the branch a restore commit targets. */
  ref?: string
  /** The host's page for this deployment (where it can be promoted or rolled back), https only. */
  targetUrl?: string
  urls: string[]
  state: ReleaseState
  reason?: string
  startAt?: number
  endAt?: number
  endedAt?: number
  incident?: string
}

function time(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

export function decodeRelease(value: unknown): ReleaseRecord | undefined {
  const record = value as ReleaseRecord
  if (
    !record ||
    typeof record !== "object" ||
    record.v !== 1 ||
    !Number.isSafeInteger(record.repositoryId) ||
    typeof record.repository !== "string" ||
    typeof record.environment !== "string" ||
    typeof record.sha !== "string" ||
    !SHA.test(record.sha) ||
    typeof record.deployment !== "string" ||
    !time(record.at) ||
    !time(record.receivedAt) ||
    !Array.isArray(record.urls) ||
    !record.urls.every((url) => typeof url === "string") ||
    !["pending", "watching", "skipped", "passed", "regressed"].includes(record.state) ||
    (record.ref !== undefined && typeof record.ref !== "string") ||
    (record.targetUrl !== undefined && typeof record.targetUrl !== "string") ||
    (record.reason !== undefined && typeof record.reason !== "string") ||
    (record.startAt !== undefined && !time(record.startAt)) ||
    (record.endAt !== undefined && !time(record.endAt)) ||
    (record.endedAt !== undefined && !time(record.endedAt)) ||
    (record.incident !== undefined && typeof record.incident !== "string")
  )
    return undefined
  return record
}

function releaseIndex(account: string, record: Pick<ReleaseRecord, "repositoryId" | "environment" | "sha" | "at">) {
  return {
    key: releaseIndexKey(account),
    score: record.at,
    member: releaseMember(record.repositoryId, record.environment, record.sha),
    keepMs: RELEASE_GUARD_LIMITS.recordMs,
    max: RELEASE_GUARD_LIMITS.indexMax,
  } satisfies IndexEntry
}

export async function readRelease(
  account: string,
  repositoryId: number,
  environment: string,
  sha: string,
  fetcher: typeof fetch = fetch,
) {
  return (await readRecord(releaseRecordKey(account, repositoryId, environment, sha), decodeRelease, fetcher)).value
}

/** Changes a release record when there is one (a report about a release Vector has no record of changes nothing). */
export async function updateRelease(
  account: string,
  input: { repositoryId: number; environment: string; sha: string },
  change: (current: ReleaseRecord) => ReleaseRecord | undefined,
  fetcher: typeof fetch = fetch,
) {
  return updateRecord(
    releaseRecordKey(account, input.repositoryId, input.environment, input.sha),
    decodeRelease,
    (current) => (current ? change(current) : undefined),
    RELEASE_GUARD_LIMITS.recordMs,
    fetcher,
  )
}

/** The account's newest releases, newest first. */
export async function listReleases(account: string, fetcher: typeof fetch = fetch, limit = 50) {
  const members = await indexMembers(releaseIndexKey(account), limit, fetcher)
  const keys = members.flatMap((member) => {
    const [repositoryId, environment, sha] = member.split(":")
    return repositoryId && environment && sha ? [codiumKey("ops", "rg", account, repositoryId, environment, sha)] : []
  })
  return (await readRecords(keys, decodeRelease, fetcher)).filter((record): record is ReleaseRecord => !!record)
}

/** An https page on the host for a deployment, kept for the rollback link; anything else is dropped. */
export function hostPage(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

/** The host's rollback link for a page Vector kept, named after the host when Vector knows it. */
export function rollbackLink(page: string | undefined) {
  if (!page) return undefined
  const host = new URL(page).hostname
  const name =
    host === "vercel.com" || host.endsWith(".vercel.com") ? "vercel" : host.endsWith("netlify.com") ? "netlify" : "host"
  return { host: name, url: page } as const
}

// ── The intake ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReleaseIntakeInput = Omit<ReleaseBody, "account"> & {
  account: string
  repository: string
  opsId: string
  installationId?: number
  /** The plan's Release Guard releases a day (ENTITLEMENTS ops.releaseGuard.perDay, from the snapshot). */
  perDay: number
  ref?: string
  targetUrl?: string
}
export type ReleaseIntakeOutcome =
  | { kind: "release"; answer: ReleaseAnswer }
  | { kind: "ignored"; reason: "opt-in" | "app" }

/**
 * A production release that passed the webhook's checks (bound repository, Release Guard on, usable plan, verified
 * URLs): dedupe, the repository's opt-in, the day's cap, then the Worker. A GitHub that cannot be reached, a store or a
 * Worker that cannot, throws 503 so the delivery can be sent again; a missing opt-in or App is the answer.
 */
export async function releaseIntake(
  input: ReleaseIntakeInput,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  github: Omit<GithubServerOptions, "fetcher" | "now"> = {},
): Promise<ReleaseIntakeOutcome> {
  const recordKey = releaseRecordKey(input.account, input.repositoryId, input.environment, input.sha)
  // A release seen before (GitHub's second success status, a redelivery) costs no token and no count.
  if ((await readRecord(recordKey, decodeRelease, fetcher)).value)
    return { kind: "release", answer: { accepted: false, reason: "duplicate" } }

  let file: OpsJsonFile | undefined
  try {
    file = await withRepositoryToken(
      {
        account: input.account,
        repositoryId: input.repositoryId,
        repository: input.repository,
        ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
        purpose: "check",
        reason: "opt-in",
      },
      (client) => readOptIn(client, input.sha),
      { fetcher, now, ...github },
    )
  } catch (error) {
    if (!githubServerError(error)) throw error
    if (error.kind === "not-installed") return { kind: "ignored", reason: "app" }
    if (error.kind === "unavailable") throw githubUnavailable()
    return { kind: "ignored", reason: "opt-in" }
  }
  if (!optInAllows(file, input)) return { kind: "ignored", reason: "opt-in" }

  const base: ReleaseRecord = {
    v: 1,
    repositoryId: input.repositoryId,
    repository: input.repository,
    environment: input.environment,
    sha: input.sha,
    deployment: input.deployment,
    at: input.at,
    receivedAt: now,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
    urls: input.urls,
    state: "pending",
  }
  const pending = JSON.stringify({ ...base, claim: randomBytes(8).toString("base64url") })
  const index = releaseIndex(input.account, base)
  const counter = releaseDayKey(input.account, utcDay(now))
  const refused: ReleaseRecord = { ...base, state: "skipped", reason: "daily-limit", endedAt: now }
  const claim = await claimCounted(
    {
      key: recordKey,
      counter,
      value: pending,
      refused: JSON.stringify(refused),
      cap: input.perDay,
      keepMs: RELEASE_GUARD_LIMITS.pendingMs,
      counterMs: RELEASE_GUARD_LIMITS.counterMs,
      index,
    },
    fetcher,
  )
  if (claim === "exists") return { kind: "release", answer: { accepted: false, reason: "duplicate" } }
  if (claim === "limit") {
    // Kept as long as any release record, so the releases list shows it.
    await saveRecord(recordKey, JSON.stringify(refused), refused, RELEASE_GUARD_LIMITS.recordMs, fetcher)
    return { kind: "release", answer: { accepted: false, reason: "daily-limit" } }
  }

  let answer: ReleaseAnswer
  try {
    answer = await opsRelease(
      {
        account: input.account,
        repositoryId: input.repositoryId,
        environment: input.environment,
        sha: input.sha,
        deployment: input.deployment,
        at: input.at,
        urls: input.urls,
      },
      fetcher,
      now,
    )
  } catch (error) {
    // Given back, so a redelivery can try again with nothing counted twice.
    await unclaimCounted({ key: recordKey, counter, value: pending, index }, fetcher).catch(() => undefined)
    throw error
  }
  if (answer.accepted) {
    await saveRecord(
      recordKey,
      pending,
      { ...base, state: "watching", startAt: answer.startAt, endAt: answer.endAt } satisfies ReleaseRecord,
      RELEASE_GUARD_LIMITS.recordMs,
      fetcher,
    )
  } else {
    // The Worker did not watch it (its own duplicate, the plan it holds, a stale report…): not counted against the day,
    // and recorded as skipped so a repeat is a duplicate here too.
    await unclaimCounted({ key: recordKey, counter, value: pending, index }, fetcher)
    await saveRecord(
      recordKey,
      "",
      { ...base, state: "skipped", reason: answer.reason, endedAt: now } satisfies ReleaseRecord,
      RELEASE_GUARD_LIMITS.recordMs,
      fetcher,
      index,
    )
  }
  return { kind: "release", answer }
}

function githubUnavailable() {
  return new ApiError(503, "GITHUB_UNAVAILABLE", "GitHub could not be reached. Try again shortly.", {
    retryAfterSeconds: 60,
  })
}

// ── Reverts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ManualReason =
  /** A workflow file (.github/workflows/) is in the range, or the range has too many files to know. */
  | "workflows"
  /** The deployed sha is not a descendant of the last good release (or is the same commit). */
  | "range"
  /** The target branch has moved past the deployed sha, so a restore commit would undo later work. */
  | "head-moved"
  /** .vector/ops.json on the target branch does not opt in (S9). */
  | "opt-in"
  /** The App is not set up here or not installed on the repository. */
  | "not-installed"
  /** GitHub refused the write. */
  | "github-refused"
  /** GitHub stayed unreachable for every try. */
  | "github-unavailable"
  /** A branch Vector would use already holds something else. */
  | "branch-exists"
  /** The repository is no longer bound to the account, or Release Guard is off for it. */
  | "not-bound"
  /** The plan does not allow a new revert now (paused, ended, frozen, no Release Guard). */
  | "plan"

export type RevertOutcome =
  | { state: "opened"; method: "revert-pr" | "restore"; number: number; url: string; branch?: string }
  | { state: "manual"; reason: ManualReason }

/** What a card shows about the range a revert undoes. */
export type RevertFacts = {
  commits: { sha: string; title: string; author?: string }[]
  totalCommits: number
  migrations: string[]
  workflows: boolean
  /** "Open in GitHub": the merged pull request, or the comparison of the two releases. */
  openUrl: string
  base?: string
}

type RevertClaim = {
  v: 1
  state: "opening" | "waiting" | "opened" | "manual"
  attempts: number
  until?: number
  owner?: string
  outcome?: RevertOutcome
  facts?: RevertFacts
  updatedAt: number
}

function decodeClaim(value: unknown): RevertClaim | undefined {
  const claim = value as RevertClaim
  if (
    !claim ||
    typeof claim !== "object" ||
    claim.v !== 1 ||
    !["opening", "waiting", "opened", "manual"].includes(claim.state) ||
    !Number.isSafeInteger(claim.attempts) ||
    !time(claim.updatedAt)
  )
    return undefined
  return claim
}

export type RevertInput = {
  account: string
  repositoryId: number
  repository: string
  installationId?: number
  environment: string
  sha: string
  goodSha: string
  opsId: string
  /** The deployment's ref, from the release record, when known. */
  ref?: string
  failing: { url: string; reason: ProbeReason; status?: number }[]
}

/** Any revert outcome already recorded for this release, with the card's facts (undefined while none is). */
export async function readRevert(
  account: string,
  input: { repositoryId: number; environment: string; sha: string },
  fetcher: typeof fetch = fetch,
) {
  const { value } = await readRecord(
    revertClaimKey(account, input.repositoryId, input.environment, input.sha),
    decodeClaim,
    fetcher,
  )
  return value
}

/** Records a revert that was decided without GitHub (the plan, the binding, a snooze): no claim on a write. */
export async function recordManualRevert(
  input: Pick<RevertInput, "account" | "repositoryId" | "environment" | "sha">,
  reason: ManualReason,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RevertOutcome> {
  const key = revertClaimKey(input.account, input.repositoryId, input.environment, input.sha)
  const outcome: RevertOutcome = { state: "manual", reason }
  const stored = await updateRecord(
    key,
    decodeClaim,
    (current): RevertClaim | undefined =>
      current && (current.state === "opened" || current.state === "manual" || current.state === "opening")
        ? undefined
        : { v: 1, state: "manual", attempts: current?.attempts ?? 0, outcome, updatedAt: now },
    RELEASE_GUARD_LIMITS.recordMs,
    fetcher,
  )
  return stored?.outcome ?? outcome
}

/**
 * Opens the one revert for a regressed release, or answers the outcome already recorded. Throws 503 when GitHub cannot
 * be reached (or another try is running), so the Worker sends the report again; after `revertAttempts` tries the
 * revert is left to the person ("github-unavailable").
 */
export async function openRevert(
  input: RevertInput,
  options: GithubServerOptions = {},
): Promise<{ outcome: RevertOutcome; facts?: RevertFacts }> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const key = revertClaimKey(input.account, input.repositoryId, input.environment, input.sha)
  let claimed: RevertClaim | undefined
  let claimText = ""
  for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
    const { value: current, raw } = await readRecord(key, decodeClaim, fetcher)
    if (current?.outcome && (current.state === "opened" || current.state === "manual"))
      return { outcome: current.outcome, ...(current.facts ? { facts: current.facts } : {}) }
    if (current?.state === "opening" && (current.until ?? 0) > now)
      throw new ApiError(503, "OPS_REVERT_IN_PROGRESS", "A revert for this release is being opened.", {
        retryAfterSeconds: 30,
      })
    const attempts = (current?.attempts ?? 0) + 1
    if (attempts > RELEASE_GUARD_LIMITS.revertAttempts) {
      const outcome: RevertOutcome = { state: "manual", reason: "github-unavailable" }
      const done: RevertClaim = {
        v: 1,
        state: "manual",
        attempts: current?.attempts ?? 0,
        outcome,
        ...(current?.facts ? { facts: current.facts } : {}),
        updatedAt: now,
      }
      if (await saveRecord(key, raw, done, RELEASE_GUARD_LIMITS.recordMs, fetcher))
        return { outcome, ...(current?.facts ? { facts: current.facts } : {}) }
      continue
    }
    const next: RevertClaim = {
      v: 1,
      state: "opening",
      attempts,
      until: now + RELEASE_GUARD_LIMITS.revertLeaseMs,
      owner: randomBytes(8).toString("base64url"),
      ...(current?.facts ? { facts: current.facts } : {}),
      updatedAt: now,
    }
    if (await saveRecord(key, raw, next, RELEASE_GUARD_LIMITS.recordMs, fetcher)) {
      claimed = next
      claimText = JSON.stringify(next)
    }
  }
  if (!claimed) throw new ApiError(409, "OPS_BUSY", "This revert changed at the same time. Try again.")

  let facts: RevertFacts | undefined = claimed.facts
  const finish = async (state: RevertClaim["state"], outcome?: RevertOutcome) => {
    const value: RevertClaim = {
      v: 1,
      state,
      attempts: claimed!.attempts,
      ...(outcome ? { outcome } : {}),
      ...(facts ? { facts } : {}),
      updatedAt: now,
    }
    await saveRecord(key, claimText, value, RELEASE_GUARD_LIMITS.recordMs, fetcher)
  }
  try {
    const outcome = await withRepositoryToken(
      {
        account: input.account,
        repositoryId: input.repositoryId,
        repository: input.repository,
        ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
        purpose: "revert",
        reason: "revert",
      },
      async (client) => {
        const result = await revertWith(client, input)
        facts = result.facts ?? facts
        return result.outcome
      },
      options,
    )
    await finish(outcome.state === "opened" ? "opened" : "manual", outcome)
    return { outcome, ...(facts ? { facts } : {}) }
  } catch (error) {
    if (githubServerError(error) && error.kind !== "unavailable") {
      const outcome: RevertOutcome = {
        state: "manual",
        reason: error.kind === "not-installed" ? "not-installed" : "github-refused",
      }
      await finish("manual", outcome)
      return { outcome, ...(facts ? { facts } : {}) }
    }
    // GitHub (or the store) could not be reached: the claim waits for the next try.
    await finish("waiting").catch(() => undefined)
    if (githubServerError(error)) throw githubUnavailable()
    throw error
  }
}

type Plan =
  | { method: "manual"; reason: ManualReason; base: string; facts?: RevertFacts }
  | {
      method: "revert-pr"
      base: string
      facts: RevertFacts
      pull: { number: number; nodeId: string; url: string; headRef: string }
    }
  | { method: "restore"; base: string; facts: RevertFacts; goodTree: string }

async function revertWith(
  client: GithubRepoClient,
  input: RevertInput,
): Promise<{ outcome: RevertOutcome; facts?: RevertFacts }> {
  const plan = await planRevert(client, input)
  const manual = (reason: ManualReason) => ({
    outcome: { state: "manual", reason } as RevertOutcome,
    ...(plan.facts ? { facts: plan.facts } : {}),
  })
  if (plan.method === "manual") return manual(plan.reason)
  // S9: the opt-in is read again on the branch the pull request targets right before every write (each commit, branch,
  // pull request or GraphQL revert); gone at any of them, nothing more is written.
  const optedIn = async () => {
    if (!optInAllows(await readOptIn(client, plan.base), input)) throw new OptInGone()
  }
  const guarded: GithubRepoClient = {
    repository: client.repository,
    purpose: client.purpose,
    get: (path) => client.get(path),
    write: async (method, path, body, audit) => {
      await optedIn()
      return client.write(method, path, body, audit)
    },
    graphql: async (query, variables, audit) => {
      if (audit) await optedIn()
      return client.graphql(query, variables, audit)
    },
  }
  try {
    if (plan.method === "revert-pr")
      return { outcome: await revertPullRequest(guarded, input, plan), facts: plan.facts }
    return { outcome: await restoreCommit(guarded, input, plan), facts: plan.facts }
  } catch (error) {
    if (error instanceof OptInGone) return manual("opt-in")
    throw error
  }
}

/** The repository's .vector/ops.json no longer opts in: no write. */
class OptInGone extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function positive(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}
function encodeBranch(branch: string) {
  return branch.split("/").map(encodeURIComponent).join("/")
}

/** A file under .github/workflows/: the App has no Workflows permission and Vector never writes one. */
export function isWorkflowPath(path: string) {
  return path.startsWith(".github/workflows/")
}

const MIGRATION = [
  /(^|\/)migrations?\//i,
  /(^|\/)migrate\//i,
  /(^|\/)alembic\//i,
  /(^|\/)flyway\//i,
  /(^|\/)liquibase\//i,
  /(^|\/)drizzle\//i,
  /(^|\/)schema\.prisma$/i,
  /\.sql$/i,
]
/** A file that looks like a database migration or schema: reverting code does not undo it. */
export function isMigrationPath(path: string) {
  return MIGRATION.some((pattern) => pattern.test(path))
}

/** The branch a deployment ref names, when it names one (not a sha or a tag). */
export function branchFromRef(ref: string | undefined) {
  if (!ref) return undefined
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  if (name.startsWith("refs/") || /^[0-9a-f]{7,40}$/.test(name) || !BRANCH.test(name) || name.includes(".."))
    return undefined
  return name
}

/**
 * Everything a revert needs, read with the token before anything is written: the range's commits and files, whether
 * it is exactly one merged pull request, the target branch and its head.
 */
async function planRevert(client: GithubRepoClient, input: RevertInput): Promise<Plan> {
  const repository = client.repository
  const compareUrl = `https://github.com/${repository.fullName}/compare/${input.goodSha}...${input.sha}`
  const compare = record(await client.get(`/compare/${input.goodSha}...${input.sha}`))
  const fallbackBase = branchFromRef(input.ref) ?? repository.defaultBranch
  if (!compare) return { method: "manual", reason: "range", base: fallbackBase }
  const commitList = Array.isArray(compare.commits) ? compare.commits.map(record).filter((item) => !!item) : []
  const files = Array.isArray(compare.files) ? compare.files.map(record).filter((item) => !!item) : []
  const names = files.flatMap((file) =>
    [file.filename, file.previous_filename].filter((name): name is string => typeof name === "string"),
  )
  const ahead = Number.isSafeInteger(compare.ahead_by) ? (compare.ahead_by as number) : 0
  const facts: RevertFacts = {
    commits: commitList
      .slice(-RELEASE_GUARD_LIMITS.commitsShown)
      .reverse()
      .flatMap((commit) => {
        if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) return []
        const message = typeof record(commit.commit)?.message === "string" ? String(record(commit.commit)!.message) : ""
        const author = record(commit.author)?.login
        return [
          {
            sha: commit.sha,
            title: message.split("\n")[0]!.slice(0, 120),
            ...(typeof author === "string" ? { author } : {}),
          },
        ]
      }),
    totalCommits: ahead,
    migrations: [...new Set(names.filter(isMigrationPath))].slice(0, RELEASE_GUARD_LIMITS.migrationsShown),
    workflows: files.length >= RELEASE_GUARD_LIMITS.compareFiles || names.some(isWorkflowPath),
    openUrl: compareUrl,
  }
  if (compare.status !== "ahead" || compare.behind_by !== 0 || ahead < 1)
    return { method: "manual", reason: "range", base: fallbackBase, facts }
  if (facts.workflows) return { method: "manual", reason: "workflows", base: fallbackBase, facts }

  // Exactly one merged pull request: the deployed sha is its merge commit and the range is only that pull request.
  const associated = await client.get(`/commits/${input.sha}/pulls`)
  const merged = (Array.isArray(associated) ? associated : [])
    .map(record)
    .filter(
      (pull) =>
        !!pull &&
        typeof pull.merged_at === "string" &&
        pull.merge_commit_sha === input.sha &&
        positive(record(record(pull.base)?.repo)?.id) === repository.id,
    )
  if (merged.length === 1) {
    const number = positive(merged[0]!.number)
    const pull = number ? record(await client.get(`/pulls/${number}`)) : undefined
    if (pull && pull.merged === true && pull.merge_commit_sha === input.sha) {
      const commits = positive(pull.commits)
      let single = ahead === 1 || (commits !== undefined && ahead === commits)
      if (!single) {
        const head = record(await client.get(`/git/commits/${input.sha}`))
        const parents = Array.isArray(head?.parents) ? head.parents.map(record) : []
        single = parents.length === 2 && parents[0]?.sha === input.goodSha
      }
      const base = record(pull.base)?.ref
      const headRef = record(pull.head)?.ref
      if (
        single &&
        typeof base === "string" &&
        typeof headRef === "string" &&
        typeof pull.node_id === "string" &&
        typeof pull.html_url === "string" &&
        pull.html_url.startsWith("https://github.com/")
      )
        return {
          method: "revert-pr",
          base,
          facts: { ...facts, openUrl: pull.html_url, base },
          pull: { number: number!, nodeId: pull.node_id, url: pull.html_url, headRef },
        }
    }
  }

  // Otherwise a restore commit, only on top of the deployed sha: the target branch's head must still be it.
  let base = fallbackBase
  let head = record(await client.get(`/git/ref/heads/${encodeBranch(base)}`))
  if (!head && base !== repository.defaultBranch) {
    base = repository.defaultBranch
    head = record(await client.get(`/git/ref/heads/${encodeBranch(base)}`))
  }
  const withBase = { ...facts, base }
  if (record(head?.object)?.sha !== input.sha) return { method: "manual", reason: "head-moved", base, facts: withBase }
  const good = record(await client.get(`/git/commits/${input.goodSha}`))
  const goodTree = record(good?.tree)?.sha
  if (typeof goodTree !== "string" || !SHA.test(goodTree))
    return { method: "manual", reason: "range", base, facts: withBase }
  return { method: "restore", base, facts: withBase, goodTree }
}

function reasonText(failure: { reason: ProbeReason; status?: number }) {
  if (failure.status !== undefined && (failure.reason === "status" || failure.reason === "redirect"))
    return `HTTP ${failure.status}`
  switch (failure.reason) {
    case "timeout":
      return "no answer in time"
    case "network":
      return "the connection failed"
    case "dns":
      return "the name did not resolve"
    case "redirect":
      return "redirected to another site"
    default:
      return failure.status !== undefined ? `HTTP ${failure.status}` : failure.reason
  }
}

function pathOf(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`.slice(0, 200)
  } catch {
    return "/"
  }
}

/** The pull request's text: what broke, what it undoes, the migration warning, and that Vector never merges. */
export function revertBody(input: RevertInput, facts: RevertFacts) {
  const short = (sha: string) => sha.slice(0, 7)
  const lines = [
    `Release Guard found that the release of \`${short(input.sha)}\` (${input.environment}) broke checks that passed on the last good release, \`${short(input.goodSha)}\`.`,
    "",
    "Failing now:",
    ...input.failing.slice(0, 5).map((failure) => `- \`${pathOf(failure.url)}\`: ${reasonText(failure)}`),
    "",
    `This pull request undoes ${facts.totalCommits === 1 ? "1 commit" : `${facts.totalCommits} commits`}:`,
    ...facts.commits.slice(0, 20).map((commit) => `- ${short(commit.sha)} ${commit.title.replaceAll("`", "'")}`),
    ...(facts.totalCommits > 20 ? [`- and ${facts.totalCommits - 20} more`] : []),
  ]
  if (facts.migrations.length)
    lines.push(
      "",
      "Warning: this range changes files that look like database migrations:",
      ...facts.migrations.slice(0, 10).map((path) => `- \`${path}\``),
      "Reverting code does not undo a migration that already ran. Check the database before you merge.",
    )
  lines.push("", "Vector never merges. Review this pull request and merge it yourself if it is right.")
  return lines.join("\n")
}

const REVERT_MUTATION = [
  "mutation($id: ID!, $title: String!, $body: String!) {",
  "  revertPullRequest(input: {pullRequestId: $id, title: $title, body: $body, draft: false}) {",
  "    revertPullRequest { number url headRefName }",
  "  }",
  "}",
].join("\n")

/** An open pull request into `base` whose head branch is in this repository and matches `head`. */
async function findOpenPull(client: GithubRepoClient, base: string, head: (ref: string) => boolean, exact?: string) {
  const owner = client.repository.fullName.split("/")[0]!
  const query = exact ? `&head=${encodeURIComponent(`${owner}:${exact}`)}` : ""
  const list = await client.get(`/pulls?state=open&base=${encodeURIComponent(base)}${query}&per_page=100`)
  for (const pull of (Array.isArray(list) ? list : []).map(record)) {
    const headRepo = positive(record(record(pull?.head)?.repo)?.id)
    const ref = record(pull?.head)?.ref
    const number = positive(pull?.number)
    if (
      number &&
      headRepo === client.repository.id &&
      typeof ref === "string" &&
      head(ref) &&
      typeof pull?.html_url === "string"
    )
      return { number, url: pull.html_url, ref }
  }
  return undefined
}

async function revertPullRequest(
  client: GithubRepoClient,
  input: RevertInput,
  plan: Extract<Plan, { method: "revert-pr" }>,
): Promise<RevertOutcome> {
  // GitHub names a revert's branch revert-<number>-<head branch>. One already open (an earlier try whose answer was
  // lost) is reused.
  const prefix = `revert-${plan.pull.number}-`
  const existing =
    (await findOpenPull(client, plan.base, (ref) => ref.startsWith(prefix), `${prefix}${plan.pull.headRef}`)) ??
    (await findOpenPull(client, plan.base, (ref) => ref.startsWith(prefix)))
  if (existing) return { state: "opened", method: "revert-pr", number: existing.number, url: existing.url }
  const data = await client.graphql(
    REVERT_MUTATION,
    {
      id: plan.pull.nodeId,
      title: `Revert #${plan.pull.number}: Release Guard found a regression`,
      body: revertBody(input, plan.facts),
    },
    { kind: "revert-pull-request", number: plan.pull.number },
  )
  const created = record(record(data.revertPullRequest)?.revertPullRequest)
  const number = positive(created?.number)
  if (!number || typeof created?.url !== "string") throw new GithubServerError("unavailable")
  return { state: "opened", method: "revert-pr", number, url: created.url }
}

async function restoreCommit(
  client: GithubRepoClient,
  input: RevertInput,
  plan: Extract<Plan, { method: "restore" }>,
): Promise<RevertOutcome> {
  const branch = `vector/revert-${input.sha.slice(0, 12)}`
  const ours = async (sha: unknown) => {
    if (typeof sha !== "string" || !SHA.test(sha)) return false
    const commit = record(await client.get(`/git/commits/${sha}`))
    const parents = Array.isArray(commit?.parents) ? commit.parents.map(record) : []
    return record(commit?.tree)?.sha === plan.goodTree && parents.length === 1 && parents[0]?.sha === input.sha
  }
  const existingRef = record(await client.get(`/git/ref/heads/${encodeBranch(branch)}`))
  if (existingRef) {
    if (!(await ours(record(existingRef.object)?.sha))) return { state: "manual", reason: "branch-exists" }
  } else {
    const message = [
      `Revert to ${input.goodSha.slice(0, 7)} (Release Guard)`,
      "",
      `The release of ${input.sha.slice(0, 7)} broke checks that passed on ${input.goodSha.slice(0, 7)}.`,
      `This commit restores the files of ${input.goodSha.slice(0, 7)}.`,
    ].join("\n")
    const commit = record(
      await client.write(
        "POST",
        "/git/commits",
        { message, tree: plan.goodTree, parents: [input.sha] },
        { kind: "restore-commit" },
      ),
    )
    const sha = commit?.sha
    if (typeof sha !== "string" || !SHA.test(sha)) throw new GithubServerError("unavailable")
    try {
      await client.write("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha }, { kind: "branch", ref: branch })
    } catch (error) {
      // Made at the same moment by another try: use it only when it is the same restore.
      if (!githubServerError(error) || error.kind !== "conflict") throw error
      const raced = record(await client.get(`/git/ref/heads/${encodeBranch(branch)}`))
      if (!(await ours(record(raced?.object)?.sha))) return { state: "manual", reason: "branch-exists" }
    }
  }
  const open = await findOpenPull(client, plan.base, (ref) => ref === branch, branch)
  if (open) return { state: "opened", method: "restore", number: open.number, url: open.url, branch }
  let created: Record<string, unknown> | undefined
  try {
    created = record(
      await client.write(
        "POST",
        "/pulls",
        {
          title: `Revert to ${input.goodSha.slice(0, 7)}: Release Guard found a regression`,
          head: branch,
          base: plan.base,
          body: revertBody(input, plan.facts),
        },
        { kind: "pull-request", ref: branch },
      ),
    )
  } catch (error) {
    if (!githubServerError(error) || error.kind !== "conflict") throw error
    const raced = await findOpenPull(client, plan.base, (ref) => ref === branch, branch)
    if (raced) return { state: "opened", method: "restore", number: raced.number, url: raced.url, branch }
    throw error
  }
  const number = positive(created?.number)
  if (!number || typeof created?.html_url !== "string") throw new GithubServerError("unavailable")
  return { state: "opened", method: "restore", number, url: created.html_url, branch }
}

// ── Erasure (P5) ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes every release record, revert claim and day counter of the account, in both Stripe modes (account deletion,
 * A57). A day counter lives two days, so today's and yesterday's are the only ones there can be.
 */
export async function eraseAccountReleases(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  for (const mode of ["live", "test"] as const) {
    const index = releaseIndexKey(account, mode)
    const members = await persistentStore(["ZRANGE", index, "0", "-1"], fetcher)
    const keys: string[] = [
      index,
      releaseDayKey(account, utcDay(now), mode),
      releaseDayKey(account, utcDay(now - 86_400_000), mode),
    ]
    for (const member of Array.isArray(members) ? members : []) {
      const [repositoryId, environment, sha] = String(member).split(":")
      if (!repositoryId || !environment || !sha) continue
      keys.push(
        codiumKeyIn(mode, "ops", "rg", account, repositoryId, environment, sha),
        codiumKeyIn(mode, "ops", "rg", account, "revert", repositoryId, environment, sha),
      )
    }
    for (let start = 0; start < keys.length; start += 200)
      await persistentStore(["DEL", ...keys.slice(start, start + 200)], fetcher)
  }
}
