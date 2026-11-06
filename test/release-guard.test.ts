import { RedisClient } from "bun"
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { ops as opsProvisioner, PROVISIONERS } from "../api/_lib/codium-provisioners"
import { readGithubAudit, withRepositoryToken } from "../api/_lib/github-app-server"
import { createGithubWebhookRoute, githubSignature } from "../api/_lib/github-webhook"
import { createOpsWebhookHandler, routeOpsEvent } from "../api/_lib/github-webhook-handlers/ops"
import { opsJson } from "../api/_lib/ops-api"
import {
  downTitle,
  eraseAccountOpsRecords,
  incidentIndexKey,
  incidentKey,
  monitorIncidentId,
  regressedTitle,
  registerOpsRunStarter,
  releaseIncidentId,
  upTitle,
  type AlertSender,
} from "../api/_lib/ops-incidents"
import { appendCapped, claimCounted, OPS_RECORD_SCRIPTS, saveRecord, unclaimCounted } from "../api/_lib/ops-records"
import {
  newOpsSettings,
  syncOpsConfig,
  updateOpsSettings,
  type OpsRepo,
  type OpsSettings,
} from "../api/_lib/ops-settings"
import { opsPlanFor } from "../api/_lib/ops-worker"
import { parsePlan } from "../packages/ops-worker/src/ops-account"
import {
  branchFromRef,
  isMigrationPath,
  isWorkflowPath,
  optInAllows,
  parseOpsJson,
  readRelease,
  releaseDayKey,
  releaseRecordKey,
  revertClaimKey,
  RELEASE_GUARD_LIMITS,
} from "../api/_lib/release-guard"
import { handleOpsIncidents } from "../api/ops/incidents"
import { handleOpsReleases } from "../api/ops/releases"
import { config as workerRouteConfig, handleOpsWorkerReport } from "../api/ops/worker"
import { signInternal } from "../api/_lib/hosted-internal"
import type { CodiumRunTrigger } from "../packages/schema/src/codium-run-trigger"
import type { PlanId } from "../packages/schema/src/codium-plan"
import {
  DAY,
  invoke,
  MAX,
  NOW,
  OpsWorld,
  OTHER,
  PRO,
  ULTRA,
  WEBHOOK_SECRET,
  WORKER_HOST,
  WORKER_SECRET,
} from "./ops-fixture"

// WP A48: Release Guard and incidents. A production deployment the GitHub App reports is checked against the
// repository's .vector/ops.json (read with a read-only one-repository App token, revoked after use) and the plan's
// releases a day (dedupe before increment), then watched by the ops Worker (A46's own code, in memory). A regression the
// Worker reports opens exactly one revert pull request: GitHub's revertPullRequest for one merged pull request, a restore
// commit only on top of the deployed sha, nothing at all when a workflow file is in the range (S9), and the opt-in read
// again before every write. The server never merges. Incidents alert the phone, can be snoozed, and start a fix run only
// on the person's tap. GitHub's API is a fake (test/ops-fixture.ts); nothing reaches GitHub, Cloudflare or Stripe.

let world = new OpsWorld()
let alerts: { account: string; title: string; tag?: string; allowPaused?: boolean }[] = []
const recordAlert: AlertSender = async (account, alert, options) => {
  alerts.push({
    account,
    title: alert.title,
    ...(alert.tag ? { tag: alert.tag } : {}),
    allowPaused: options.allowPaused,
  })
  return { sent: 1, failed: 0, removed: 0 }
}
let triggers: CodiumRunTrigger.RunTrigger[] = []

beforeEach(() => {
  world = new OpsWorld()
  alerts = []
  triggers = []
})
afterEach(() => {
  registerOpsRunStarter(undefined)
  setSystemTime()
  world.close()
})

const REPO = 42
const FULL = `octo-fixture/repo-${REPO}`
const HOST = "shop.example.com"
const sha = (seed: string) => createHash("sha1").update(seed).digest("hex")
const GOOD = sha("good")
const BAD = sha("bad")
const GOOD_TREE = sha("good-tree")
const CHECKOUT = `https://${HOST}/checkout`

/** An account with a verified domain and a repository set up and opted in, its plan pushed to the Worker. */
async function ready(
  account = MAX,
  plan: PlanId = "vector-100",
  repo: Partial<OpsRepo> = {},
  options: { pushPlan?: boolean } = {},
): Promise<OpsSettings> {
  world.seed(account, plan)
  if (options.pushPlan !== false && (plan === "vector-100" || plan === "vector-200"))
    await world.worker.plan(account, plan)
  world.bind(REPO, account)
  const settings = await updateOpsSettings(
    account,
    () => ({
      ...newOpsSettings(),
      domains: [
        {
          domain: HOST,
          token: "t".repeat(32),
          addedAt: world.now,
          since: world.now,
          verifiedAt: world.now,
          method: "dns" as const,
        },
      ],
      monitors: [{ id: "mon_aaaaaaaaaaaaaaaa", url: `https://${HOST}/health`, addedAt: world.now }],
      repos: [
        {
          repositoryId: REPO,
          repository: FULL,
          environment: "Production",
          productionUrl: `https://${HOST}/`,
          paths: ["/", "/checkout"],
          releaseGuard: true,
          shipDesk: false,
          updatedAt: world.now,
          ...repo,
        },
      ],
    }),
    world.fetcher(),
    world.now,
  )
  await syncOpsConfig(account, world.fetcher(), world.now)
  world.github.commitOptIn(REPO, opsJson(settings!, settings!.repos[0]!))
  return settings!
}

let serial = 0
function deployment(commit = BAD, overrides: { status?: object; deployment?: object } = {}) {
  const id = 5000 + ++serial
  return {
    action: "created",
    deployment_status: {
      id: 9000 + serial,
      state: "success",
      environment: "Production",
      created_at: new Date(world.now - 5_000).toISOString(),
      log_url: `https://vercel.com/octo-fixture/shop/dpl_${commit.slice(0, 8)}`,
      target_url: `https://shop-${commit.slice(0, 8)}.vercel.app`,
      ...overrides.status,
    },
    deployment: {
      id,
      sha: commit,
      ref: "main",
      environment: "Production",
      transient_environment: false,
      ...overrides.deployment,
    },
    repository: { id: REPO, full_name: FULL, owner: { id: 7 } },
    installation: { id: 77 },
  }
}
const deliveryEvent = (payload: Record<string, unknown>) => ({
  name: "deployment_status",
  action: "created",
  deliveryId: `d-${++serial}`,
  payload,
})
const intake = (commit = BAD, overrides: Parameters<typeof deployment>[1] = {}) =>
  routeOpsEvent(deliveryEvent(deployment(commit, overrides)), { fetcher: world.fetcher(), clock: () => world.now })
const workerReleases = () => world.worker.actions.filter((action) => action === "release").length

/** Both releases taken (records with their host pages), the good one first. */
async function deployBoth(account = MAX) {
  expect(await intake(GOOD)).toMatchObject({ kind: "release", answer: { accepted: true } })
  world.advance(60_000)
  expect(await intake(BAD)).toMatchObject({ kind: "release", answer: { accepted: true } })
  void account
}

let events = 0
function regression(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: `evt_${String(++events).padStart(16, "0")}`,
    kind: "release.regressed",
    at: world.now,
    repositoryId: REPO,
    environment: "Production",
    sha: BAD,
    deployment: "5002",
    goodSha: GOOD,
    failing: [{ url: CHECKOUT, reason: "status", status: 500 }],
    ...overrides,
  }
}

/** A report from the Worker, signed as the Worker signs it. */
function report(account: string, list: unknown[], options: { body?: string; unsigned?: boolean } = {}) {
  const body = options.body ?? JSON.stringify({ v: 1, account, events: list })
  const headers = options.unsigned
    ? {}
    : signInternal("ops", { method: "POST", path: "/api/ops/worker", body, now: world.now, secret: WORKER_SECRET })
  return invoke(
    (request, response) =>
      handleOpsWorkerReport(request, response, world.fetcher(), () => world.now, { alert: recordAlert }),
    { method: "POST", raw: body, url: "/api/ops/worker", headers },
  )
}

const commitList = (shas: string[]) =>
  shas.map((item, index) => ({
    sha: item,
    commit: { message: `Change number ${index + 1}\n\nWith a body.` },
    author: { login: "octo-person" },
    parents: [{ sha: index ? shas[index - 1] : GOOD }],
  }))

/** The range GOOD...BAD is one squash-merged pull request (#7). */
function squashRange(files: string[] = ["src/app.ts"]) {
  world.github.compares.set(`${REPO}:${GOOD}...${BAD}`, {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    commits: commitList([BAD]),
    files: files.map((filename) => ({ filename, status: "modified" })),
  })
  world.github.commitPulls.set(`${REPO}:${BAD}`, [
    {
      number: 7,
      state: "closed",
      merged_at: new Date(world.now).toISOString(),
      merge_commit_sha: BAD,
      base: { ref: "main", repo: { id: REPO } },
    },
  ])
  world.github.addPull(REPO, { number: 7, merge_commit_sha: BAD, commits: 3 })
}

/** The range GOOD...BAD is three commits from two pull requests; main's head is `head`. */
function mixedRange(options: { head?: string; files?: string[] } = {}) {
  const c1 = sha("c1")
  const c2 = sha("c2")
  world.github.compares.set(`${REPO}:${GOOD}...${BAD}`, {
    status: "ahead",
    ahead_by: 3,
    behind_by: 0,
    commits: commitList([c1, c2, BAD]),
    files: (options.files ?? ["src/app.ts", "src/cart.ts"]).map((filename) => ({ filename, status: "modified" })),
  })
  world.github.commitPulls.set(`${REPO}:${BAD}`, [
    {
      number: 9,
      state: "closed",
      merged_at: new Date(world.now).toISOString(),
      merge_commit_sha: BAD,
      base: { ref: "main", repo: { id: REPO } },
    },
  ])
  world.github.addPull(REPO, { number: 9, merge_commit_sha: BAD, commits: 1 })
  world.github.commits.set(`${REPO}:${BAD}`, { tree: sha("bad-tree"), parents: [c2] })
  world.github.commits.set(`${REPO}:${GOOD}`, { tree: GOOD_TREE, parents: [sha("older")] })
  world.github.refs.set(`${REPO}:main`, options.head ?? BAD)
}

const writes = () => world.github.writes.map((write) => `${write.method} ${write.path}`)
const merges = () => world.github.requests.filter((request) => /\/merge$/.test(request.path))

async function incidents(account = MAX) {
  const answer = await invoke(
    (request, response) => handleOpsIncidents(request, response, world.fetcher(), () => world.now),
    { method: "GET", authorization: world.token(account) },
  )
  expect(answer.status).toBe(200)
  return answer.body.incidents as any[]
}
function incidentAction(body: Record<string, unknown>, account = MAX) {
  return invoke((request, response) => handleOpsIncidents(request, response, world.fetcher(), () => world.now), {
    method: "POST",
    authorization: world.token(account),
    body,
  })
}

// ── .vector/ops.json ────────────────────────────────────────────────────────────────────────────────────────────────

describe("the opt-in", () => {
  test(".vector/ops.json opts in only for its ops id, with Release Guard on, in the same environment", () => {
    const file = {
      opsId: `ops_${"a".repeat(22)}`,
      environment: "Production",
      productionUrl: "https://shop.example.com/",
      paths: ["/"],
      releaseGuard: true,
      shipDesk: false,
    }
    const parsed = parseOpsJson(JSON.stringify({ ...file, extra: "ignored" }))
    expect(parsed).toEqual(file)
    expect(optInAllows(parsed, { opsId: file.opsId, environment: "production" })).toBe(true)
    expect(optInAllows(parsed, { opsId: `ops_${"b".repeat(22)}`, environment: "Production" })).toBe(false)
    expect(optInAllows(parsed, { opsId: file.opsId, environment: "Staging" })).toBe(false)
    expect(optInAllows(parseOpsJson(JSON.stringify({ ...file, releaseGuard: false })), file)).toBe(false)
    expect(optInAllows(undefined, file)).toBe(false)
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ ...file, opsId: "ops_short" }),
      JSON.stringify({ ...file, releaseGuard: "yes" }),
      JSON.stringify({ ...file, paths: ["/", "/a", "/b", "/c", "/d", "/e"] }),
      JSON.stringify({ ...file, padding: "x".repeat(RELEASE_GUARD_LIMITS.optInBytes) }),
    ])
      expect(parseOpsJson(bad)).toBeUndefined()
  })

  test("the intake watches a release where the repository opts in, with a read-only token revoked after use and audited", async () => {
    await ready()
    const outcome = await intake(BAD)
    expect(outcome).toMatchObject({ kind: "release", answer: { accepted: true } })
    expect(world.github.minted).toEqual([
      { repositoryId: REPO, installationId: 77, permissions: { contents: "read", metadata: "read" } },
    ])
    expect(world.github.live()).toEqual([])
    expect(world.github.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /app/installations/77/access_tokens",
      "GET /installation/repositories?per_page=2",
      `GET /repos/${FULL}/contents/.vector/ops.json?ref=${BAD}`,
      "DELETE /installation/token",
    ])
    expect(writes()).toEqual([])
    const record = await readRelease(MAX, REPO, "Production", BAD, world.fetcher())
    expect(record).toMatchObject({
      state: "watching",
      ref: "main",
      targetUrl: `https://vercel.com/octo-fixture/shop/dpl_${BAD.slice(0, 8)}`,
      urls: [`https://${HOST}/`, CHECKOUT],
    })
    const audit = await readGithubAudit(MAX, world.fetcher())
    expect(audit).toEqual([
      expect.objectContaining({
        state: "done",
        purpose: "check",
        reason: "opt-in",
        repositoryId: REPO,
        repository: FULL,
        writes: [],
        revoked: true,
        outcome: "ok",
      }),
    ])
    expect(JSON.stringify(audit)).not.toContain("ghs_")
  })

  test("no file, another account's ops id, Release Guard off, another environment or a malformed file: nothing is watched or counted", async () => {
    const settings = await ready()
    const file = opsJson(settings, settings.repos[0]!)
    const cases: (object | string | null)[] = [
      null,
      { ...file, opsId: `ops_${"z".repeat(22)}` },
      { ...file, releaseGuard: false },
      { ...file, environment: "Staging" },
      "{ not json",
    ]
    for (const [index, variant] of cases.entries()) {
      world.github.commitOptIn(REPO, variant)
      expect(await intake(sha(`case-${index}`))).toEqual({ kind: "ignored", reason: "opt-in" })
    }
    expect(workerReleases()).toBe(0)
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBeUndefined()
    expect(world.github.live()).toEqual([])
  })

  test("without the App here or on the repository nothing is watched; GitHub unreachable fails the delivery and counts nothing", async () => {
    await ready()
    delete process.env.VECTOR_GITHUB_APP_ENABLED
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "app" })
    process.env.VECTOR_GITHUB_APP_ENABLED = "true"
    // The App's code runs only on production deployments.
    process.env.VERCEL_ENV = "preview"
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "app" })
    delete process.env.VERCEL_ENV
    world.github.repos.get(REPO)!.installationId = 78
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "app" })
    world.github.repos.get(REPO)!.installationId = 77
    world.github.down = true
    await expect(intake(BAD)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE", statusCode: 503 })
    world.github.down = false
    world.github.fail(/contents\/\.vector/, 1, 502)
    await expect(intake(BAD)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    expect(world.github.live()).toEqual([])
    expect(workerReleases()).toBe(0)
    expect(await readRelease(MAX, REPO, "Production", BAD, world.fetcher())).toBeUndefined()
    // The redelivery, with GitHub back, is watched.
    expect(await intake(BAD)).toMatchObject({ kind: "release", answer: { accepted: true } })
  })

  test("the binding and the plan come first: no token is minted for an unbound repository or a paused plan", async () => {
    await ready()
    world.bind(REPO, OTHER)
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "not-configured" })
    world.bind(REPO, MAX)
    world.seed(MAX, "vector-100", "paused")
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "plan" })
    world.seed(MAX, "vector-50")
    expect(await intake(BAD)).toEqual({ kind: "ignored", reason: "plan" })
    expect(world.github.minted).toEqual([])
  })
})

// ── The day's cap ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("the day's cap", () => {
  test("dedupe before increment: a release seen again never counts; past the cap it is skipped; the next UTC day starts over", async () => {
    await ready()
    const shas = Array.from({ length: 10 }, (_, index) => sha(`release-${index}`))
    for (const commit of shas) {
      expect(await intake(commit)).toMatchObject({ kind: "release", answer: { accepted: true } })
      world.advance(60_000)
    }
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBe("10")
    // GitHub's second success status for a release, or a redelivery: a duplicate, with no token and no count.
    const minted = world.github.minted.length
    expect(await intake(shas[3])).toEqual({ kind: "release", answer: { accepted: false, reason: "duplicate" } })
    expect(world.github.minted).toHaveLength(minted)
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBe("10")
    // Max's tenth release was the last today.
    const eleventh = sha("release-10")
    expect(await intake(eleventh)).toEqual({ kind: "release", answer: { accepted: false, reason: "daily-limit" } })
    expect(workerReleases()).toBe(10)
    expect(await readRelease(MAX, REPO, "Production", eleventh, world.fetcher())).toMatchObject({
      state: "skipped",
      reason: "daily-limit",
    })
    expect(world.fakes.store.pttl(releaseRecordKey(MAX, REPO, "Production", eleventh))).toBe(
      RELEASE_GUARD_LIMITS.recordMs,
    )
    expect(await intake(eleventh)).toEqual({ kind: "release", answer: { accepted: false, reason: "duplicate" } })
    world.advance(13 * 60 * 60_000)
    world.seed(MAX, "vector-100")
    expect(await intake(sha("tomorrow"))).toMatchObject({ kind: "release", answer: { accepted: true } })
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-05"))).toBe("1")
  })

  test("a delivery cut off before the Worker answered holds its claim for ten minutes only; a watched one for 35 days", async () => {
    await ready()
    const key = releaseRecordKey(MAX, REPO, "Production", BAD)
    const held: number[] = []
    const base = world.fetcher()
    const spying = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).host === WORKER_HOST) held.push(world.fakes.store.pttl(key))
      return base(input, init)
    }) as typeof fetch
    const outcome = await routeOpsEvent(deliveryEvent(deployment(BAD)), { fetcher: spying, clock: () => world.now })
    expect(outcome).toMatchObject({ kind: "release", answer: { accepted: true } })
    expect(held).toEqual([RELEASE_GUARD_LIMITS.pendingMs])
    expect(world.fakes.store.pttl(key)).toBe(RELEASE_GUARD_LIMITS.recordMs)
  })

  test("a Worker that cannot be reached gives the count back; the Worker's own refusal is recorded skipped and not counted", async () => {
    await ready()
    world.worker.down = true
    await expect(intake(BAD)).rejects.toMatchObject({ code: "OPS_UNAVAILABLE" })
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBe("0")
    expect(world.fakes.store.get(releaseRecordKey(MAX, REPO, "Production", BAD))).toBeUndefined()
    world.worker.down = false
    expect(await intake(BAD)).toMatchObject({ kind: "release", answer: { accepted: true } })
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBe("1")

    // An account whose plan the Worker does not hold yet: not watched, not counted, a duplicate when repeated.
    await world.worker.plan(MAX, "vector-100", { releaseGuard: null, version: 2 })
    const unwatched = sha("unwatched")
    expect(await intake(unwatched)).toEqual({ kind: "release", answer: { accepted: false, reason: "not-in-plan" } })
    expect(world.fakes.store.get(releaseDayKey(MAX, "2026-11-04"))).toBe("1")
    expect(await readRelease(MAX, REPO, "Production", unwatched, world.fetcher())).toMatchObject({
      state: "skipped",
      reason: "not-in-plan",
    })
    expect(await intake(unwatched)).toEqual({ kind: "release", answer: { accepted: false, reason: "duplicate" } })
  })
})

// ── Reverts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("reverts", () => {
  test("exactly one merged pull request: GitHub's revertPullRequest, once, with a revert token revoked after use", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.advance(31 * 60_000)
    const answer = await report(MAX, [regression()])
    expect(answer).toMatchObject({ status: 200, body: { ok: true, taken: 1 } })
    expect(writes()).toEqual(["POST /graphql"])
    expect(world.github.writes[0]!.body!.variables).toMatchObject({
      id: "PR_node7",
      title: expect.stringContaining("#7"),
    })
    const body = String(world.github.writes[0]!.body!.variables.body)
    expect(body).toContain("`/checkout`: HTTP 500")
    expect(body).toContain("Vector never merges")
    expect(body).not.toMatch(/Codium|usage|plan|%/i)
    expect(world.github.minted.at(-1)!.permissions).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    })
    expect(world.github.live()).toEqual([])
    expect(merges()).toEqual([])
    const [incident] = await incidents()
    // Undo merges at the revert pull request's head when Vector opened it (GitHub's headRefOid).
    const head = world.github.pulls.get(`${REPO}#901`)!.head.sha
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(incident.release.undo).toEqual({
      kind: "pull-request",
      method: "revert-pr",
      number: 901,
      url: `https://github.com/${FULL}/pull/901`,
      headSha: head,
    })
    expect(incident.release.commits).toEqual([{ sha: BAD, title: "Change number 1", author: "octo-person" }])
    expect(alerts).toEqual([
      {
        account: MAX,
        title: `Release Guard: a release of ${FULL} broke checks. A revert pull request is open.`,
        tag: "release-guard",
        allowPaused: false,
      },
    ])
    const audit = await readGithubAudit(MAX, world.fetcher())
    expect(audit[0]).toMatchObject({
      purpose: "revert",
      writes: [{ kind: "revert-pull-request", number: 7 }],
      revoked: true,
      outcome: "ok",
    })
    expect(await readRelease(MAX, REPO, "Production", BAD, world.fetcher())).toMatchObject({
      state: "regressed",
      incident: releaseIncidentId(REPO, "Production", BAD),
    })
  })

  test("a merge commit whose first parent is the good release, or a rebase of one pull request, is one pull request too", async () => {
    await ready()
    // A merge commit: four commits in range, the pull request's three plus the merge.
    world.github.compares.set(`${REPO}:${GOOD}...${BAD}`, {
      status: "ahead",
      ahead_by: 4,
      behind_by: 0,
      commits: commitList([sha("p1"), sha("p2"), sha("p3"), BAD]),
      files: [{ filename: "src/app.ts" }],
    })
    world.github.commitPulls.set(`${REPO}:${BAD}`, [
      {
        number: 7,
        merged_at: "2026-11-04T11:00:00Z",
        merge_commit_sha: BAD,
        base: { ref: "main", repo: { id: REPO } },
      },
    ])
    world.github.addPull(REPO, { number: 7, merge_commit_sha: BAD, commits: 3 })
    world.github.commits.set(`${REPO}:${BAD}`, { tree: sha("t"), parents: [GOOD, sha("p3")] })
    await report(MAX, [regression()])
    expect(writes()).toEqual(["POST /graphql"])

    // A rebase: as many commits in range as the pull request had, the last one the deployed sha.
    const other = sha("bad-2")
    world.github.compares.set(`${REPO}:${GOOD}...${other}`, {
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      commits: commitList([sha("r1"), other]),
      files: [{ filename: "src/app.ts" }],
    })
    world.github.commitPulls.set(`${REPO}:${other}`, [
      {
        number: 8,
        merged_at: "2026-11-04T11:00:00Z",
        merge_commit_sha: other,
        base: { ref: "main", repo: { id: REPO } },
      },
    ])
    world.github.addPull(REPO, { number: 8, merge_commit_sha: other, commits: 2 })
    await report(MAX, [regression({ sha: other })])
    expect(writes()).toEqual(["POST /graphql", "POST /graphql"])
    expect(world.github.writes[1]!.body!.variables.id).toBe("PR_node8")
  })

  test("anything else: a restore commit of the good tree on top of the deployed sha, on its own branch, with a pull request", async () => {
    await ready()
    await deployBoth()
    mixedRange()
    expect((await report(MAX, [regression()])).status).toBe(200)
    const branch = `vector/revert-${BAD.slice(0, 12)}`
    expect(writes()).toEqual(["POST /git/commits", "POST /git/refs", "POST /pulls"])
    const [commit, ref, pull] = world.github.writes
    expect(commit!.body).toMatchObject({ tree: GOOD_TREE, parents: [BAD] })
    expect(ref!.body).toMatchObject({ ref: `refs/heads/${branch}` })
    expect(pull!.body).toMatchObject({ head: branch, base: "main" })
    expect(String(pull!.body!.body)).toContain("undoes 3 commits")
    // S9: the opt-in was read on main before each of the three writes.
    const optInReads = world.github.requests.filter((request) =>
      request.path.endsWith("/contents/.vector/ops.json?ref=main"),
    )
    expect(optInReads).toHaveLength(3)
    const [incident] = await incidents()
    // Undo merges at the restore commit Vector made, the branch's head when the pull request opened.
    const restored = world.github.refs.get(`${REPO}:${branch}`)
    expect(incident.release.undo).toMatchObject({ kind: "pull-request", method: "restore", headSha: restored })
    expect(world.github.commits.get(`${REPO}:${restored}`)).toEqual({ tree: GOOD_TREE, parents: [BAD] })
    expect(incident.release.commits.map((item: { sha: string }) => item.sha)).toEqual([BAD, sha("c2"), sha("c1")])
    expect(merges()).toEqual([])
  })

  test("no restore commit once the branch moved past the deployed sha: Undo opens GitHub and the host's rollback link", async () => {
    await ready()
    await deployBoth()
    mixedRange({ head: sha("later-work") })
    expect((await report(MAX, [regression()])).status).toBe(200)
    expect(writes()).toEqual([])
    const [incident] = await incidents()
    expect(incident.release.undo).toEqual({
      kind: "manual",
      reason: "head-moved",
      openUrl: `https://github.com/${FULL}/compare/${GOOD}...${BAD}`,
      rollback: { host: "vercel", url: `https://vercel.com/octo-fixture/shop/dpl_${GOOD.slice(0, 8)}` },
    })
    expect(alerts.at(-1)!.title).toBe(`Release Guard: a release of ${FULL} broke checks. Open Vector to undo it.`)
    // The branch a restore commit targets is the deployment's branch; a sha or a tag falls back to the default branch.
    expect(branchFromRef("main")).toBe("main")
    expect(branchFromRef("refs/heads/release/2026")).toBe("release/2026")
    expect(branchFromRef(BAD)).toBeUndefined()
    expect(branchFromRef("refs/tags/v1.2.3")).toBeUndefined()
    expect(branchFromRef("../main")).toBeUndefined()
  })

  test("S9: no App write when a workflow file is in the range, or the range lists too many files to know", async () => {
    await ready()
    await deployBoth()
    squashRange(["src/app.ts", ".github/workflows/deploy.yml"])
    await report(MAX, [regression()])
    expect(writes()).toEqual([])
    let [incident] = await incidents()
    expect(incident.release).toMatchObject({
      workflows: true,
      undo: { kind: "manual", reason: "workflows", rollback: { host: "vercel" } },
    })

    const other = sha("bad-3")
    world.github.compares.set(`${REPO}:${GOOD}...${other}`, {
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      commits: commitList([other]),
      files: Array.from({ length: 300 }, (_, index) => ({ filename: `src/file-${index}.ts` })),
    })
    await report(MAX, [regression({ sha: other })])
    expect(writes()).toEqual([])
    ;[incident] = await incidents()
    expect(incident.release.undo).toMatchObject({ kind: "manual", reason: "workflows" })
    // A renamed workflow counts by its old name too.
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true)
    expect(isWorkflowPath("docs/.github/workflows/ci.yml")).toBe(false)
  })

  test("S9: the opt-in is read again on the target branch right before writing; gone since the release, nothing is written", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.github.commitOptIn(REPO, null, "main")
    await report(MAX, [regression()])
    expect(writes()).toEqual([])
    expect(world.github.requests.map((request) => request.path)).toContain(
      `/repos/${FULL}/contents/.vector/ops.json?ref=main`,
    )
    const [incident] = await incidents()
    expect(incident.release.undo).toMatchObject({ kind: "manual", reason: "opt-in" })
  })

  test("the card lists the commits the revert undoes and warns on migration paths", async () => {
    await ready()
    await deployBoth()
    mixedRange({ files: ["src/app.ts", "db/migrations/0042_orders.sql", "prisma/schema.prisma"] })
    await report(MAX, [regression()])
    const [incident] = await incidents()
    expect(incident.release.migrations).toEqual(["db/migrations/0042_orders.sql", "prisma/schema.prisma"])
    expect(incident.release.totalCommits).toBe(3)
    const body = String(world.github.writes.find((write) => write.path === "/pulls")!.body!.body)
    expect(body).toContain("Warning: this range changes files that look like database migrations")
    expect(body).toContain("`db/migrations/0042_orders.sql`")
    expect(isMigrationPath("supabase/migrations/1_init.sql")).toBe(true)
    expect(isMigrationPath("src/migrate/run.ts")).toBe(true)
    expect(isMigrationPath("src/app.ts")).toBe(false)
  })

  test("the plan, the binding and Release Guard decide: paused, unbound or switched off writes nothing", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.seed(MAX, "vector-100", "paused")
    await report(MAX, [regression()])
    world.seed(MAX, "vector-100")
    world.bind(REPO, OTHER)
    await report(MAX, [regression({ sha: sha("x1") })])
    world.bind(REPO, MAX)
    await updateOpsSettings(
      MAX,
      (current) => ({ ...current!, repos: current!.repos.map((repo) => ({ ...repo, releaseGuard: false })) }),
      world.fetcher(),
      world.now,
    )
    await report(MAX, [regression({ sha: sha("x2") })])
    expect(writes()).toEqual([])
    expect(world.github.minted.filter((token) => token.permissions.contents === "write")).toEqual([])
    const reasons = (await incidents()).map((incident) => incident.release.undo.reason)
    expect(reasons).toEqual(["not-bound", "not-bound", "plan"])
  })

  test("Release Guard off at Vector (the owner's switch, the services, its listing): a report still taken mints no revert token", async () => {
    await ready()
    await deployBoth()
    squashRange()
    // The Worker still reports while its kill flag propagates, or after a flag sync failed.
    world.switchOff("ops")
    expect((await report(MAX, [regression()])).status).toBe(200)
    world.fakes.store.remove([...world.fakes.store.keys()].find((key) => key.endsWith(":switch:ops"))!)
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect((await report(MAX, [regression({ sha: sha("off-2") })])).status).toBe(200)
    expect(writes()).toEqual([])
    expect(world.github.minted.filter((token) => token.permissions.contents === "write")).toEqual([])
    expect((await incidents()).map((incident) => incident.release.undo.reason)).toEqual(["off", "off"])
    // The phone still heard about both.
    expect(alerts.filter((alert) => alert.tag === "release-guard")).toHaveLength(2)
    // Listed, Release Guard opens the revert again.
    process.env.CODIUM_LISTED_PERKS = "release-guard"
    world.advance(60_000)
    const other = sha("off-3")
    world.github.compares.set(`${REPO}:${GOOD}...${other}`, world.github.compares.get(`${REPO}:${GOOD}...${BAD}`)!)
    world.github.commitPulls.set(`${REPO}:${other}`, [
      { number: 7, merged_at: "2026-11-04T11:00:00Z", merge_commit_sha: other, base: { ref: "main", repo: { id: REPO } } },
    ])
    world.github.addPull(REPO, { number: 7, merge_commit_sha: other, commits: 1 })
    await report(MAX, [regression({ sha: other })])
    expect(writes()).toEqual(["POST /graphql"])
  })

  test("the App not installed on the repository, or GitHub refusing the write, leaves Undo to the person", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.github.fail(/POST \/graphql/, 1, 403)
    await report(MAX, [regression()])
    world.advance(60_000)
    world.github.repos.get(REPO)!.installationId = 78
    await report(MAX, [regression({ sha: sha("y") })])
    const reasons = (await incidents()).map((incident) => incident.release.undo.reason)
    expect(reasons).toEqual(["not-installed", "github-refused"])
    expect(world.github.live()).toEqual([])
  })
})

// ── Callback retries ────────────────────────────────────────────────────────────────────────────────────────────────

describe("a report sent again opens one pull request", () => {
  test("GitHub unreachable while opening: 503 and the phone hears now; the resend opens it, once, with no second alert", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.github.fail(/POST \/graphql/, 1)
    const event = regression()
    const first = await report(MAX, [event])
    expect(first).toMatchObject({ status: 503, body: { error: { code: "GITHUB_UNAVAILABLE" } } })
    expect(alerts.map((alert) => alert.title)).toEqual([`Release Guard: a release of ${FULL} broke checks.`])
    expect(world.github.live()).toEqual([])
    world.advance(60_000)
    const second = await report(MAX, [event])
    expect(second).toMatchObject({ status: 200, body: { taken: 1 } })
    expect(writes()).toEqual(["POST /graphql"])
    expect(alerts).toHaveLength(1)
    world.advance(60_000)
    expect((await report(MAX, [event])).body).toMatchObject({ taken: 0, duplicates: 1 })
    expect(writes()).toEqual(["POST /graphql"])
  })

  test("the Worker's report again under new ids, or a second report for the same release, finds the outcome", async () => {
    await ready()
    await deployBoth()
    mixedRange()
    await report(MAX, [regression()])
    world.advance(30_000)
    await report(MAX, [regression(), regression()])
    expect(writes()).toEqual(["POST /git/commits", "POST /git/refs", "POST /pulls"])
    expect(await incidents()).toHaveLength(1)
    expect(alerts).toHaveLength(1)
  })

  test("a pull request an earlier try opened, whose answer was lost, is found and reused: never opened twice", async () => {
    await ready()
    await deployBoth()
    // The restore path: the branch and the pull request are already there, the claim never recorded them.
    mixedRange()
    const branch = `vector/revert-${BAD.slice(0, 12)}`
    const made = world.github.newSha()
    world.github.commits.set(`${REPO}:${made}`, { tree: GOOD_TREE, parents: [BAD] })
    world.github.refs.set(`${REPO}:${branch}`, made)
    world.github.addPull(REPO, {
      number: 950,
      state: "open",
      merged: false,
      base: { ref: "main", repo: { id: REPO } },
      head: { ref: branch, repo: { id: REPO } },
    })
    await report(MAX, [regression()])
    expect(writes()).toEqual([])
    // The branch's restore commit is the head Undo merges at, even when the listing gave none.
    expect((await incidents())[0].release.undo).toMatchObject({ kind: "pull-request", number: 950, headSha: made })

    // The revertPullRequest path: GitHub's revert-<n>-<branch> pull request is already open.
    world.advance(60_000)
    const other = sha("bad-4")
    squashRange()
    world.github.compares.set(`${REPO}:${GOOD}...${other}`, world.github.compares.get(`${REPO}:${GOOD}...${BAD}`)!)
    world.github.commitPulls.set(`${REPO}:${other}`, [
      {
        number: 7,
        merged_at: "2026-11-04T11:00:00Z",
        merge_commit_sha: other,
        base: { ref: "main", repo: { id: REPO } },
      },
    ])
    world.github.addPull(REPO, { number: 7, merge_commit_sha: other, commits: 1 })
    world.github.addPull(REPO, {
      number: 951,
      state: "open",
      merged: false,
      base: { ref: "main", repo: { id: REPO } },
      head: { ref: "revert-7-feature-7", repo: { id: REPO } },
    })
    await report(MAX, [regression({ sha: other })])
    expect(writes()).toEqual([])
    expect((await incidents())[0].release.undo).toMatchObject({ kind: "pull-request", number: 951 })
  })

  test("after eight tries against an unreachable GitHub, Undo is left to the person and the report is taken", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.github.fail(/POST \/graphql/, 100)
    const event = regression()
    for (let attempt = 1; attempt <= RELEASE_GUARD_LIMITS.revertAttempts; attempt++) {
      expect((await report(MAX, [event])).status).toBe(503)
      world.advance(RELEASE_GUARD_LIMITS.revertLeaseMs + 1)
    }
    expect((await report(MAX, [event])).status).toBe(200)
    expect((await incidents())[0].release.undo).toMatchObject({ kind: "manual", reason: "github-unavailable" })
    expect(writes()).toEqual([])
  })

  test("a try still holding the claim makes a resend wait (503), so two tries never write at once", async () => {
    await ready()
    await deployBoth()
    squashRange()
    world.fakes.store.set(
      revertClaimKey(MAX, REPO, "Production", BAD),
      JSON.stringify({
        v: 1,
        state: "opening",
        attempts: 1,
        until: world.now + 60_000,
        owner: "o",
        updatedAt: world.now,
      }),
    )
    expect(await report(MAX, [regression()])).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_REVERT_IN_PROGRESS" } },
    })
    world.advance(61_000)
    expect((await report(MAX, [regression()])).status).toBe(200)
    expect(writes()).toEqual(["POST /graphql"])
  })
})

// ── Incidents, alerts and the route ─────────────────────────────────────────────────────────────────────────────────

describe("incidents and the report route", () => {
  test("the route checks the Worker's signature over the raw body; a malformed envelope is 400; odd events are skipped", async () => {
    expect(workerRouteConfig).toEqual({ api: { bodyParser: false } })
    await ready()
    expect((await report(MAX, [regression()], { unsigned: true })).status).toBe(401)
    const tampered = JSON.stringify({ v: 1, account: MAX, events: [] })
    const headers = signInternal("ops", {
      method: "POST",
      path: "/api/ops/worker",
      body: tampered,
      now: world.now,
      secret: WORKER_SECRET,
    })
    const forged = await invoke(
      (request, response) => handleOpsWorkerReport(request, response, world.fetcher(), () => world.now),
      { method: "POST", raw: tampered.replace("[]", "[1]"), url: "/api/ops/worker", headers },
    )
    expect(forged.status).toBe(401)
    expect((await report(MAX, [], { body: JSON.stringify({ v: 2, account: MAX, events: [] }) })).status).toBe(400)
    const answer = await report(MAX, [
      { v: 1, id: "evt_unknown_kind_01", kind: "monitor.flapping", at: world.now },
      { ...regression(), sha: "not-a-sha" },
      "nonsense",
    ])
    expect(answer).toMatchObject({ status: 200, body: { ok: true, taken: 0, skipped: 3 } })
    expect(await incidents()).toEqual([])
  })

  test("monitor.down opens an incident and alerts the phone (paused plans too); monitor.up resolves it", async () => {
    await ready()
    const since = world.now - 60_000
    const down = {
      v: 1,
      id: "evt_down_0000000001",
      kind: "monitor.down",
      at: world.now,
      monitor: "mon_aaaaaaaaaaaaaaaa",
      since,
      reason: "status",
      status: 503,
    }
    expect((await report(MAX, [down, down])).body).toMatchObject({ taken: 1, duplicates: 1 })
    expect(alerts).toEqual([
      { account: MAX, title: `On Call: ${HOST} failed two checks in a row`, tag: "on-call", allowPaused: true },
    ])
    let [incident] = await incidents()
    expect(incident).toMatchObject({
      id: monitorIncidentId("mon_aaaaaaaaaaaaaaaa", since),
      kind: "monitor",
      state: "open",
      openedAt: since,
      monitor: { id: "mon_aaaaaaaaaaaaaaaa", url: `https://${HOST}/health`, reason: "status", status: 503 },
    })
    world.advance(5 * 60_000)
    await report(MAX, [
      {
        v: 1,
        id: "evt_up_00000000001",
        kind: "monitor.up",
        at: world.now,
        monitor: "mon_aaaaaaaaaaaaaaaa",
        downSince: since,
      },
    ])
    ;[incident] = await incidents()
    expect(incident).toMatchObject({ state: "resolved", resolvedAt: world.now })
    expect(alerts.at(-1)).toMatchObject({ title: `On Call: ${HOST} passes its checks again`, allowPaused: true })
    // Titles stay within the phone alert's 120 characters.
    expect(downTitle(`https://${"a".repeat(120)}.example.com/`)).toBe(
      "On Call: a production check failed twice in a row",
    )
    expect(upTitle(undefined).length).toBeLessThanOrEqual(120)
    expect(regressedTitle("o".repeat(140), undefined)).toBe("Release Guard: a release broke checks.")
  })

  test("snooze takes 1 to 24 hours: a snoozed monitor sends no alert, a snoozed repository gets no revert", async () => {
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [first] = await incidents()
    for (const hours of [0, 25, 1.5, "2"])
      expect((await incidentAction({ id: first.id, action: "snooze", hours })).status).toBe(400)
    expect((await incidentAction({ id: "inc_aaaaaaaaaaaaaaaaaaaaaa", action: "snooze", hours: 2 })).status).toBe(404)
    const snoozed = await incidentAction({ id: first.id, action: "snooze", hours: 4 })
    expect(snoozed).toMatchObject({ status: 200, body: { snoozedUntil: world.now + 4 * 3_600_000 } })
    // Another release of the same repository and environment regresses during the snooze: recorded, nothing else.
    const other = sha("bad-5")
    world.github.compares.set(`${REPO}:${GOOD}...${other}`, world.github.compares.get(`${REPO}:${GOOD}...${BAD}`)!)
    await report(MAX, [regression({ sha: other })])
    expect(writes()).toEqual(["POST /graphql"])
    expect(alerts).toHaveLength(1)
    const list = await incidents()
    expect(list[0]).toMatchObject({
      release: { sha: other, undo: { kind: "manual", reason: "snoozed" } },
      snoozedUntil: world.now + 4 * 3_600_000,
    })
    expect((await incidentAction({ id: first.id, action: "unsnooze" })).body).toEqual({ snoozedUntil: null })
    // A snoozed monitor: an incident, no alert; once the snooze ends, alerts again.
    await incidentAction({ id: first.id, action: "snooze", hours: 1 })
    const down = (id: string, since: number) => ({
      v: 1,
      id,
      kind: "monitor.down",
      at: world.now,
      monitor: "mon_aaaaaaaaaaaaaaaa",
      since,
      reason: "timeout",
    })
    await report(MAX, [down("evt_snoozed_down_01", world.now)])
    const monitorIncident = (await incidents()).find((incident) => incident.kind === "monitor")
    await incidentAction({ id: monitorIncident.id, action: "snooze", hours: 1 })
    await report(MAX, [down("evt_snoozed_down_02", world.now + 1)])
    expect(alerts.filter((alert) => alert.tag === "on-call")).toHaveLength(1)
    world.advance(3_600_001)
    await report(MAX, [down("evt_snoozed_down_03", world.now)])
    expect(alerts.filter((alert) => alert.tag === "on-call")).toHaveLength(2)
  })

  test("release.passed marks the release; the releases route lists them for the account only, never to run tokens", async () => {
    await ready()
    await deployBoth()
    await report(MAX, [
      {
        v: 1,
        id: "evt_passed_00000001",
        kind: "release.passed",
        at: world.now,
        repositoryId: REPO,
        environment: "Production",
        sha: GOOD,
        deployment: "5001",
      },
    ])
    const list = (token: string, url = "/api/ops/releases") =>
      invoke((request, response) => handleOpsReleases(request, response, world.fetcher(), () => world.now), {
        method: "GET",
        authorization: token,
        url,
      })
    const answer = await list(world.token(MAX))
    expect(answer.status).toBe(200)
    expect(answer.body.releases.map((release: { sha: string; state: string }) => [release.sha, release.state])).toEqual(
      [
        [BAD, "watching"],
        [GOOD, "passed"],
      ],
    )
    expect(JSON.stringify(answer.body)).not.toContain("https://")
    expect((await list(world.token(MAX), "/api/ops/releases?repositoryId=43")).body.releases).toEqual([])
    expect((await list(world.token(OTHER))).body.releases).toEqual([])
    expect((await list("vrt_fixture_run_token")).status).toBe(401)
    expect((await list("vht_fixture_run_token")).status).toBe(401)
    world.advance(2 * 60 * 60_000)
    expect((await list(world.token(MAX))).body.releases[0].state).toBe("ended")
  })
})

// ── Fix it ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Fix it", () => {
  const starter = async (trigger: CodiumRunTrigger.RunTrigger) => {
    triggers.push(trigger)
    return { id: `run_${triggers.length}`, url: `https://github.com/${FULL}/actions/runs/${triggers.length}` }
  }

  test("only on the person's tap: no starter yet is 503, and a report never starts a run", async () => {
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [incident] = await incidents()
    expect(await incidentAction({ id: incident.id, action: "fix" })).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_FIX_UNAVAILABLE" } },
    })
    registerOpsRunStarter(starter)
    expect(() => registerOpsRunStarter(starter)).toThrow()
    await report(MAX, [regression({ sha: sha("z") })])
    expect(triggers).toEqual([])
  })

  test("starts a run in the incident's own repository, one per incident, within the plan's fix runs a day", async () => {
    registerOpsRunStarter(starter)
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [incident] = await incidents()
    const started = await incidentAction({ id: incident.id, action: "fix" })
    expect(started).toMatchObject({
      status: 200,
      body: { fix: { at: world.now, url: `https://github.com/${FULL}/actions/runs/1` } },
    })
    expect(triggers).toEqual([
      {
        source: "ops",
        account: MAX,
        target: { kind: "github-run", repositoryId: REPO },
        prompt: expect.stringContaining("/checkout"),
        criteria: [`${CHECKOUT} answers with a success status`],
        purpose: "incident",
      },
    ])
    expect(await incidentAction({ id: incident.id, action: "fix" })).toMatchObject({
      status: 409,
      body: { error: { code: "OPS_FIX_STARTED" } },
    })
    expect((await incidents())[0].fix).toEqual({ at: world.now, url: `https://github.com/${FULL}/actions/runs/1` })
    // Max: three fix runs a day; monitor incidents run in the repository whose production URL is on that host.
    for (let index = 0; index < 3; index++)
      await report(MAX, [
        {
          v: 1,
          id: `evt_fixdown_${index}000000`,
          kind: "monitor.down",
          at: world.now,
          monitor: "mon_aaaaaaaaaaaaaaaa",
          since: world.now - index - 1,
          reason: "network",
        },
      ])
    const downs = (await incidents()).filter((item) => item.kind === "monitor")
    expect((await incidentAction({ id: downs[0].id, action: "fix" })).status).toBe(200)
    expect((await incidentAction({ id: downs[1].id, action: "fix" })).status).toBe(200)
    expect(await incidentAction({ id: downs[2].id, action: "fix" })).toMatchObject({
      status: 429,
      body: { error: { code: "OPS_LIMIT", limit: "fix-runs", max: 3 } },
    })
    expect(triggers.map((trigger) => trigger.target)).toEqual(Array(3).fill({ kind: "github-run", repositoryId: REPO }))
  })

  test("a fix run spends Codium: a session or a marked token only, and only while the incident's perk is listed", async () => {
    registerOpsRunStarter(starter)
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [incident] = await incidents()
    const act = (authorization: string, body: Record<string, unknown>) =>
      invoke((request, response) => handleOpsIncidents(request, response, world.fetcher(), () => world.now), {
        method: "POST",
        authorization,
        body,
      })
    // A token copied from vectordev.ai/auth/cli (no client marker) may snooze, never spend.
    const unmarked = world.token(MAX, "unmarked")
    expect(await act(unmarked, { id: incident.id, action: "fix" })).toMatchObject({
      status: 401,
      body: { error: { code: "CODIUM_SIGN_IN_REQUIRED" } },
    })
    expect((await act(unmarked, { id: incident.id, action: "snooze", hours: 1 })).status).toBe(200)
    expect(triggers).toEqual([])
    // Not listed and not on the owner's allowlist: no fix run, from anyone.
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await act(world.session(MAX), { id: incident.id, action: "fix" })).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_UNAVAILABLE" } },
    })
    process.env.CODIUM_LISTED_PERKS = "release-guard"
    expect((await act(world.session(MAX), { id: incident.id, action: "fix" })).status).toBe(200)
    // The owner's legacy override admits unmarked tokens, as the gateway does.
    await report(MAX, [regression({ sha: sha("fix-2") })])
    const second = (await incidents()).find((item) => item.release.sha === sha("fix-2"))
    process.env.MODEL_PLAN_REQUIRE_MARKED_TOKENS = "false"
    expect((await act(unmarked, { id: second.id, action: "fix" })).status).toBe(200)
    expect(triggers).toHaveLength(2)
  })

  test("a paused plan, Pro, an unbound repository, a starter that fails or a run token: refused, nothing counted", async () => {
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [incident] = await incidents()
    registerOpsRunStarter(async () => {
      throw new Error("Codex unavailable")
    })
    expect(await incidentAction({ id: incident.id, action: "fix" })).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_FIX_UNAVAILABLE" } },
    })
    registerOpsRunStarter(undefined)
    registerOpsRunStarter(starter)
    world.seed(MAX, "vector-100", "paused")
    expect((await incidentAction({ id: incident.id, action: "fix" })).body.error.code).toBe(
      "MODEL_PLAN_PAYMENT_REQUIRED",
    )
    world.seed(MAX, "vector-50")
    expect((await incidentAction({ id: incident.id, action: "fix" })).body.error.code).toBe("CODIUM_PERK_REQUIRED")
    world.seed(MAX, "vector-100")
    world.bind(REPO, OTHER)
    expect((await incidentAction({ id: incident.id, action: "fix" })).body.error.code).toBe("OPS_REPO_NOT_BOUND")
    world.bind(REPO, MAX)
    expect((await incidentAction({ id: incident.id, action: "fix", repositoryId: 43 })).status).toBe(400)
    const run = await invoke(
      (request, response) => handleOpsIncidents(request, response, world.fetcher(), () => world.now),
      {
        method: "POST",
        authorization: "vrt_fixture_run_token",
        body: { id: incident.id, action: "fix" },
      },
    )
    expect(run.status).toBe(401)
    expect(triggers).toEqual([])
    // The failed start gave its claim and its count back: the tap works now.
    expect((await incidentAction({ id: incident.id, action: "fix" })).status).toBe(200)
  })
})

// ── The ops provisioner ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the ops provisioner", () => {
  test("the Worker's plan follows §4.4: checks and watches while active, checks only while paused, nothing after", () => {
    const at = world.now
    const max = world.snapshotFor(MAX, "vector-100")
    expect(opsPlanFor(max, at)).toEqual({
      version: max.version,
      domains: 3,
      onCall: { urls: 5, intervalSec: 300 },
      releaseGuard: { perDay: 10, watchMin: 30, paths: 5 },
      validUntil: max.periodEnd + DAY,
    })
    expect(opsPlanFor(world.snapshotFor(ULTRA, "vector-200", "renewing"), at)).toMatchObject({
      onCall: { urls: 10, intervalSec: 60 },
      releaseGuard: { perDay: 30, watchMin: 60, paths: 5 },
    })
    expect(opsPlanFor(world.snapshotFor(MAX, "vector-100", "paused"), at)).toMatchObject({
      onCall: { urls: 5, intervalSec: 300 },
      releaseGuard: null,
      validUntil: at + 35 * DAY,
    })
    for (const state of ["ended", "frozen"] as const)
      expect(opsPlanFor(world.snapshotFor(MAX, "vector-100", state), at)).toMatchObject({
        onCall: null,
        releaseGuard: null,
        validUntil: at,
      })
    expect(opsPlanFor(world.snapshotFor(PRO, "vector-50"), at)).toMatchObject({
      domains: 0,
      onCall: null,
      validUntil: at,
    })
    expect(PROVISIONERS.map((provisioner) => provisioner.id)).toContain("ops")
    // Every plan with ops caps, in every state, is a plan the Worker accepts as it is.
    for (const plan of ["vector-100", "vector-200"] as const)
      for (const state of ["active", "renewing", "paused", "ended", "frozen"] as const)
        expect(parsePlan(opsPlanFor(world.snapshotFor(MAX, plan, state), at), at)).toBeDefined()
  })

  test("pushes the plan the Worker then watches with; an account that never had ops is not called; closing erases", async () => {
    setSystemTime(new Date(world.now))
    expect(opsProvisioner.configured()).toBe(true)
    await ready(MAX, "vector-100", {}, { pushPlan: false })
    const to = world.snapshotFor(MAX, "vector-100")
    await opsProvisioner.apply({ account: MAX, to, cause: "first_payment" }, world.fetcher())
    expect(world.worker.actions.at(-1)).toBe("plan")
    expect(await intake(BAD)).toMatchObject({ kind: "release", answer: { accepted: true } })
    // Paused: no new watch.
    const paused = world.snapshotFor(MAX, "vector-100", "paused", { previous: to })
    await opsProvisioner.apply({ account: MAX, from: to, to: paused, cause: "payment_failed" }, world.fetcher())
    world.seed(MAX, "vector-100", "renewing")
    expect(await intake(sha("during-pause"))).toEqual({
      kind: "release",
      answer: { accepted: false, reason: "not-in-plan" },
    })

    const calls = world.worker.actions.length
    const pro = world.snapshotFor(PRO, "vector-50")
    await opsProvisioner.apply({ account: PRO, to: pro, cause: "first_payment" }, world.fetcher())
    expect(world.worker.actions).toHaveLength(calls)

    await report(MAX, [regression()])
    const closing = world.snapshotFor(MAX, null, "ended", { reason: "closing", previous: paused })
    await opsProvisioner.apply({ account: MAX, from: paused, to: closing, cause: "closing" }, world.fetcher())
    expect(world.worker.actions.at(-1)).toBe("erase")
    const left = world.fakes.store.keys().filter((key) => key.includes(MAX) && key.includes(":ops:"))
    expect(left).toEqual([])
    opsProvisioner.configured()
    process.env.VECTOR_OPS_ENABLED = "false"
    expect(opsProvisioner.configured()).toBe(false)
  })
})

// ── End to end ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("end to end", () => {
  test("a deployment through the webhook, watched by the Worker, regresses; the Worker's own signed report opens the revert", async () => {
    await ready()
    squashRange()
    const webhook = createGithubWebhookRoute({
      handlers: [createOpsWebhookHandler({ fetcher: world.fetcher(), clock: () => world.now })],
      fetcher: world.fetcher(),
    })
    const deliver = (payload: object) => {
      const raw = JSON.stringify(payload)
      return invoke(webhook, {
        method: "POST",
        raw,
        url: "/api/github/webhook",
        headers: {
          "x-github-event": "deployment_status",
          "x-github-delivery": `e2e-${++serial}-0000-4000-8000-000000000000`,
          "x-hub-signature-256": githubSignature(raw, WEBHOOK_SECRET),
        },
      })
    }
    let forwarded = 0
    const forward = async () => {
      for (const sent of world.worker.net.reports.splice(0)) {
        const headers = Object.fromEntries(new Headers(sent.headers).entries())
        const signedAt = Number(headers["x-vector-internal-timestamp"]) * 1000
        const answer = await invoke(
          (request, response) =>
            handleOpsWorkerReport(request, response, world.fetcher(), () => signedAt, { alert: recordAlert }),
          { method: "POST", raw: sent.body, url: "/api/ops/worker", headers },
        )
        expect(answer.status).toBe(200)
        forwarded++
      }
    }
    const run = async (ms: number) => {
      for (let passed = 0; passed < ms; passed += 30_000) {
        await world.worker.runFor(30_000, (to) => world.advance(to - world.now))
        await forward()
      }
    }
    expect((await deliver(deployment(GOOD))).status).toBe(200)
    await run(33 * 60_000)
    expect(await readRelease(MAX, REPO, "Production", GOOD, world.fetcher())).toMatchObject({ state: "passed" })
    world.worker.net.sites.set(CHECKOUT, () => new Response("broken", { status: 500 }))
    expect((await deliver(deployment(BAD))).status).toBe(200)
    await run(3 * 60_000)
    expect(forwarded).toBeGreaterThanOrEqual(2)
    expect(writes()).toEqual(["POST /graphql"])
    const [incident] = await incidents()
    expect(incident.release).toMatchObject({
      sha: BAD,
      goodSha: GOOD,
      failing: [{ url: CHECKOUT, reason: "status", status: 500 }],
      undo: { kind: "pull-request", method: "revert-pr" },
    })
    expect(merges()).toEqual([])
  })
})

// ── Tokens and erasure ──────────────────────────────────────────────────────────────────────────────────────────────

describe("App tokens and erasure", () => {
  test("a token is for one repository with exactly the permissions asked; a check token cannot write; every token is revoked", async () => {
    await ready()
    const options = { fetcher: world.fetcher(), now: world.now }
    await expect(
      withRepositoryToken(
        { account: MAX, repositoryId: REPO, installationId: 77, purpose: "check", reason: "test" },
        (client) => client.write("POST", "/git/refs", {}, { kind: "branch" }),
        options,
      ),
    ).rejects.toMatchObject({ kind: "refused" })
    // An installation id that is not known is found by the repository's name.
    const repo = await withRepositoryToken(
      { account: MAX, repositoryId: REPO, repository: FULL, purpose: "check", reason: "test" },
      async (client) => client.repository,
      options,
    )
    expect(repo).toEqual({ id: REPO, fullName: FULL, defaultBranch: "main", private: true })
    // A path out of the repository is refused before it is sent.
    await expect(
      withRepositoryToken(
        { account: MAX, repositoryId: REPO, installationId: 77, purpose: "check", reason: "test" },
        (client) => client.get("/../../users/someone"),
        options,
      ),
    ).rejects.toMatchObject({ kind: "refused" })
    expect(world.github.live()).toEqual([])
    // Without the store, no token is minted at all (its audit entry comes first).
    world.fakes.store.down = true
    const minted = world.github.minted.length
    await expect(
      withRepositoryToken(
        { account: MAX, repositoryId: REPO, installationId: 77, purpose: "revert", reason: "test" },
        async () => undefined,
        options,
      ),
    ).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(world.github.minted).toHaveLength(minted)
  })

  test("P5: every incident, release, revert claim, snooze, fix claim, event id and audit entry goes, in both modes", async () => {
    registerOpsRunStarter(async () => ({ id: "run_1" }))
    await ready()
    await deployBoth()
    squashRange()
    await report(MAX, [regression()])
    const [incident] = await incidents()
    await incidentAction({ id: incident.id, action: "snooze", hours: 2 })
    await incidentAction({ id: incident.id, action: "fix" })
    // Another account's records stay.
    world.bind(43, ULTRA)
    const before = world.fakes.store.keys().filter((key) => key.includes(MAX) && key.includes(":ops:"))
    expect(before.some((key) => key.includes(":ops:incident:"))).toBe(true)
    expect(before.some((key) => key.includes(":ops:rg:"))).toBe(true)
    expect(before.some((key) => key.includes(":ops:audit:"))).toBe(true)
    expect(before.some((key) => key.includes(":ops:event:"))).toBe(true)
    // A record left in the other Stripe mode goes too.
    world.fakes.store.set(incidentKey(MAX, incident.id, "live"), "{}")
    world.fakes.store.zset(incidentIndexKey(MAX, "live")).set(incident.id, world.now)
    await eraseAccountOpsRecords(MAX, world.fetcher(), world.now)
    const left = world.fakes.store
      .keys()
      .filter((key) => key.includes(MAX) && key.includes(":ops:") && !key.includes(":ops:settings:"))
    expect(left).toEqual([])
  })
})

// ── On Valkey (CI) ──────────────────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("A48's record scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("compare-and-set with an index, counted claims, giving one back, and capped logs", async () => {
    expect(Object.keys(OPS_RECORD_SCRIPTS)).toEqual(["SAVE", "CLAIM", "UNCLAIM", "AUDIT"])
    const index = { key: "rg-index", score: NOW, member: "a", keepMs: 10_000, max: 2 }
    expect(await saveRecord("doc-a", "", { n: 1 }, 60_000, fetcher, index)).toBe(true)
    expect(await saveRecord("doc-a", "", { n: 2 }, 60_000, fetcher, index)).toBe(false)
    expect(await saveRecord("doc-a", JSON.stringify({ n: 1 }), { n: 2 }, 60_000, fetcher, index)).toBe(true)
    expect(Number(await client!.send("PTTL", ["doc-a"]))).toBeGreaterThan(50_000)
    await saveRecord("doc-b", "", {}, 60_000, fetcher, { ...index, score: NOW + 1, member: "b" })
    await saveRecord("doc-c", "", {}, 60_000, fetcher, { ...index, score: NOW + 2, member: "c" })
    expect(await client!.send("ZRANGE", ["rg-index", "0", "-1"])).toEqual(["b", "c"])
    // Members older than the index keeps are dropped too.
    await saveRecord("doc-d", "", {}, 60_000, fetcher, { ...index, score: NOW + 20_000, member: "d" })
    expect(await client!.send("ZRANGE", ["rg-index", "0", "-1"])).toEqual(["d"])

    const claim = (key: string) =>
      claimCounted(
        { key, counter: "day", value: "v", refused: "r", cap: 2, keepMs: 60_000, counterMs: 60_000 },
        fetcher,
      )
    expect(await claim("c1")).toBe("claimed")
    expect(await claim("c1")).toBe("exists")
    expect(await claim("c2")).toBe("claimed")
    expect(await claim("c3")).toBe("limit")
    expect(await client!.send("GET", ["c3"])).toBe("r")
    expect(await client!.send("GET", ["day"])).toBe("2")
    expect(await unclaimCounted({ key: "c2", counter: "day", value: "other" }, fetcher)).toBe(false)
    expect(await unclaimCounted({ key: "c2", counter: "day", value: "v" }, fetcher)).toBe(true)
    expect(await client!.send("GET", ["day"])).toBe("1")
    expect(await client!.send("EXISTS", ["c2"])).toBe(0)

    for (let index = 0; index < 5; index++)
      await appendCapped("log", `e${index}`, { at: NOW + index, max: 3, keepMs: 60_000 }, fetcher)
    expect(await client!.send("ZRANGE", ["log", "0", "-1"])).toEqual(["e2", "e3", "e4"])
    expect(Number(await client!.send("PTTL", ["log"]))).toBeGreaterThan(50_000)
  })
})
