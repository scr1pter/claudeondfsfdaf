import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  checkGithubWebhookHandlers,
  createGithubWebhookRoute,
  GITHUB_APP_WEBHOOK_EVENTS,
  githubDeliveryKey,
  githubSignature,
  githubWebhookSecret,
  verifyGithubSignature,
  type GithubWebhookEvent,
  type GithubWebhookHandler,
} from "../api/_lib/github-webhook"
import {
  appBotLogin,
  createOpsWebhookHandler,
  registerShipDeskIntake,
  routeOpsEvent,
  type OpsPullRequest,
} from "../api/_lib/github-webhook-handlers/ops"
import {
  cloudAgentsWebhookHandler,
  createCloudAgentsWebhookHandler,
} from "../api/_lib/github-webhook-handlers/cloud-agents"
import type { RepoBinding, SuspendReason } from "../api/_lib/cloud-agents-binding"
import { switchKey } from "../api/_lib/codium-switches"
import { ApiError } from "../api/_lib/http"
import {
  opsInstallationIndexKey,
  opsRepoIndexKey,
  readOpsSettings,
  syncOpsConfig,
  updateOpsSettings,
  newOpsSettings,
  type OpsRepo,
} from "../api/_lib/ops-settings"
import { opsJson } from "../api/_lib/ops-api"
import webhookRoute, { config as webhookConfig, GITHUB_WEBHOOK_HANDLERS } from "../api/github/webhook"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { APP_SLUG, DAY, invoke, MAX, OpsWorld, OTHER, PRO, ULTRA, WEBHOOK_SECRET } from "./ops-fixture"

// WP A47: the shared GitHub webhook router and Codium's ops handler on it. The router checks the signature over the raw
// body (S4), answers events nobody takes before any store read, dedupes by delivery id and runs each handler that named
// the event, in the shape Codex's handler expects (vector-at-mention spec 2.14). The ops handler sends a successful
// production deployment to the ops Worker (A46's own code, in memory), hands App-bot pull requests to Ship Desk's
// intake and drops the settings of repositories an uninstall or a removal takes away. Nothing reaches GitHub.

let world: OpsWorld
beforeEach(() => {
  world = new OpsWorld()
  // api/github/webhook.ts registers Ship Desk's intake when it loads (WP A49); these cases register their own.
  registerShipDeskIntake(undefined)
})
afterEach(() => {
  registerShipDeskIntake(undefined)
  world.close()
})

const SHA = "a".repeat(40)

function recorder(id: string, events: readonly string[], behaviour?: (event: GithubWebhookEvent) => Promise<void>) {
  const seen: GithubWebhookEvent[] = []
  const handler: GithubWebhookHandler = {
    id,
    events,
    async handle(event) {
      seen.push(event)
      await behaviour?.(event)
    },
  }
  return { seen, handler }
}

let deliveries = 0
function deliver(
  route: ReturnType<typeof createGithubWebhookRoute>,
  input: {
    event: string
    payload?: unknown
    delivery?: string
    raw?: string
    signature?: string | null
    method?: string
    headers?: Record<string, string>
  },
) {
  const raw = input.raw ?? JSON.stringify(input.payload ?? {})
  const signature = input.signature === undefined ? githubSignature(raw, WEBHOOK_SECRET) : input.signature
  return invoke(route, {
    method: input.method ?? "POST",
    raw,
    url: "/api/github/webhook",
    headers: {
      "x-github-event": input.event,
      "x-github-delivery": input.delivery ?? `0000000${++deliveries}-a47a-11f0-8000-000000000000`,
      ...(signature !== null ? { "x-hub-signature-256": signature } : {}),
      ...input.headers,
    },
  })
}

// ── The router ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the router", () => {
  test("a signed delivery reaches each handler that named its event, in Codex's 2.14 shape", async () => {
    const ops = recorder("ops", ["deployment_status", "repository"])
    const codex = recorder("cloud-agents", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [ops.handler, codex.handler], fetcher: world.fetcher() })
    const payload = { action: "renamed", repository: { id: 42, full_name: "octo/new-name" } }
    const answer = await deliver(route, {
      event: "repository",
      payload,
      delivery: "11111111-2222-3333-4444-555555555555",
    })
    expect(answer).toMatchObject({ status: 200, body: { ok: true } })
    const expected = {
      name: "repository",
      action: "renamed",
      deliveryId: "11111111-2222-3333-4444-555555555555",
      payload,
    }
    expect(ops.seen).toEqual([expected])
    expect(codex.seen).toEqual([expected])
    expect(world.fakes.store.get(githubDeliveryKey("11111111-2222-3333-4444-555555555555"))).toBe("done")
    // A deployment goes only to the handler that named it.
    await deliver(route, { event: "deployment_status", payload: { action: "created" } })
    expect(ops.seen).toHaveLength(2)
    expect(codex.seen).toHaveLength(1)
  })

  test("a ping, and an event no handler takes, are answered before anything is parsed or stored", async () => {
    const ops = recorder("ops", ["deployment_status"])
    const route = createGithubWebhookRoute({ handlers: [ops.handler], fetcher: world.fetcher() })
    for (const event of ["ping", "push", "issues", "check_run", "repository"])
      expect(await deliver(route, { event, raw: "not even json" })).toMatchObject({
        status: 200,
        body: { ok: true, ignored: true },
      })
    expect(world.fakes.store.commands).toEqual([])
    expect(ops.seen).toEqual([])
  })

  test("S4: a missing, malformed, wrong-secret or tampered signature gets 401 before anything is read or stored", async () => {
    const ops = recorder("ops", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [ops.handler], fetcher: world.fetcher() })
    const raw = JSON.stringify({ action: "deleted", repository: { id: 42 } })
    for (const signature of [
      null,
      "",
      "sha1=0000",
      `sha256=${"0".repeat(64)}`,
      githubSignature(raw, "another-secret-of-the-same-length-000000000000"),
      githubSignature(`${raw} `, WEBHOOK_SECRET),
      `${githubSignature(raw, WEBHOOK_SECRET)}00`,
    ])
      expect(await deliver(route, { event: "repository", raw, signature })).toMatchObject({
        status: 401,
        body: { error: { code: "GITHUB_WEBHOOK_SIGNATURE_INVALID" } },
      })
    // Even a ping needs the signature.
    expect((await deliver(route, { event: "ping", raw: "{}", signature: null })).status).toBe(401)
    expect(world.fakes.store.commands).toEqual([])
    expect(ops.seen).toEqual([])
    // Upper-case hex is GitHub's digest too.
    expect(
      verifyGithubSignature(Buffer.from(raw), githubSignature(raw, WEBHOOK_SECRET).toUpperCase(), WEBHOOK_SECRET),
    ).toBe(true)
  })

  test("without a webhook secret of at least 32 characters, every delivery gets 503", async () => {
    const route = createGithubWebhookRoute({
      handlers: [recorder("ops", ["repository"]).handler],
      fetcher: world.fetcher(),
    })
    process.env.VECTOR_GITHUB_APP_WEBHOOK_SECRET = "too-short"
    expect(githubWebhookSecret()).toBeUndefined()
    expect(await deliver(route, { event: "ping" })).toMatchObject({
      status: 503,
      body: { error: { code: "GITHUB_WEBHOOK_UNAVAILABLE" } },
    })
    delete process.env.VECTOR_GITHUB_APP_WEBHOOK_SECRET
    expect((await deliver(route, { event: "ping" })).status).toBe(503)
  })

  test("a delivery runs once: a finished one sent again answers duplicate, one still running answers 409", async () => {
    const ops = recorder("ops", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [ops.handler], fetcher: world.fetcher() })
    const delivery = "aaaaaaaa-0000-4000-8000-000000000001"
    const payload = { action: "deleted", repository: { id: 42 } }
    expect((await deliver(route, { event: "repository", payload, delivery })).body).toEqual({ ok: true })
    expect((await deliver(route, { event: "repository", payload, delivery })).body).toEqual({
      ok: true,
      duplicate: true,
    })
    expect(ops.seen).toHaveLength(1)
    world.fakes.store.set(githubDeliveryKey("aaaaaaaa-0000-4000-8000-000000000002"), "pending")
    const running = await deliver(route, {
      event: "repository",
      payload,
      delivery: "aaaaaaaa-0000-4000-8000-000000000002",
    })
    expect(running).toMatchObject({ status: 409, body: { error: { code: "GITHUB_DELIVERY_IN_PROGRESS" } } })
    expect(running.headers["retry-after"]).toBe("60")
    expect(ops.seen).toHaveLength(1)
    // The finished mark lasts a week; the running one a minute.
    expect(world.fakes.store.pttl(githubDeliveryKey(delivery))).toBe(7 * DAY)
  })

  test("a failing handler fails the delivery and frees it for a redelivery; the others still ran", async () => {
    let failures = 1
    const flaky = recorder("ops", ["repository"], async () => {
      if (failures-- > 0) throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "down")
    })
    const steady = recorder("cloud-agents", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [flaky.handler, steady.handler], fetcher: world.fetcher() })
    const delivery = "bbbbbbbb-0000-4000-8000-000000000001"
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const failed = await deliver(route, {
        event: "repository",
        payload: { action: "deleted", secret: "x" },
        delivery,
      })
      expect(failed).toMatchObject({ status: 500, body: { error: { code: "GITHUB_WEBHOOK_FAILED" } } })
      expect(steady.seen).toHaveLength(1)
      expect(world.fakes.store.get(githubDeliveryKey(delivery))).toBeUndefined()
      // Logged by handler, delivery and code only: never the payload.
      expect(errors.mock.calls).toEqual([
        ["Vector GitHub webhook handler failed", { handler: "ops", delivery, code: "PERSISTENT_STORE_UNAVAILABLE" }],
      ])
    } finally {
      errors.mockRestore()
    }
    expect((await deliver(route, { event: "repository", payload: { action: "deleted" }, delivery })).body).toEqual({
      ok: true,
    })
    expect(flaky.seen).toHaveLength(2)
    expect(steady.seen).toHaveLength(2)
  })

  test("a handler that runs out of time fails the delivery; each handler gets its own copy of the payload", async () => {
    const slow = recorder("slow", ["repository"], () => new Promise((resolve) => setTimeout(resolve, 200)))
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const route = createGithubWebhookRoute({ handlers: [slow.handler], fetcher: world.fetcher(), handlerMs: 20 })
      expect((await deliver(route, { event: "repository", payload: { action: "deleted" } })).status).toBe(500)
    } finally {
      errors.mockRestore()
    }
    const changer = recorder("changer", ["repository"], async (event) => {
      ;(event.payload.repository as { name: string }).name = "changed"
    })
    const reader = recorder("reader", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [changer.handler, reader.handler], fetcher: world.fetcher() })
    await deliver(route, { event: "repository", payload: { action: "renamed", repository: { name: "original" } } })
    expect(reader.seen[0]!.payload).toEqual({ action: "renamed", repository: { name: "original" } })
  })

  test("malformed deliveries: another method, a missing event or delivery id, a body that is not an object, too large", async () => {
    const route = createGithubWebhookRoute({
      handlers: [recorder("ops", ["repository"]).handler],
      fetcher: world.fetcher(),
    })
    expect((await deliver(route, { event: "repository", method: "GET" })).status).toBe(405)
    expect((await deliver(route, { event: "" })).status).toBe(400)
    expect((await deliver(route, { event: "Repository!" })).status).toBe(400)
    expect((await deliver(route, { event: "repository", delivery: "not/a/delivery" })).status).toBe(400)
    for (const raw of ["[]", "null", "42", "{"])
      expect(await deliver(route, { event: "repository", raw })).toMatchObject({
        status: 400,
        body: { error: { code: "GITHUB_WEBHOOK_INVALID" } },
      })
    const large = JSON.stringify({ action: "deleted", padding: "x".repeat(2 * 1024 * 1024) })
    expect((await deliver(route, { event: "repository", raw: large })).status).toBe(413)
  })

  test("a store that cannot be reached fails a delivery with 503, so it can be sent again", async () => {
    const ops = recorder("ops", ["repository"])
    const route = createGithubWebhookRoute({ handlers: [ops.handler], fetcher: world.fetcher() })
    world.fakes.store.down = true
    expect(await deliver(route, { event: "repository", payload: { action: "deleted" } })).toMatchObject({
      status: 503,
      body: { error: { code: "PERSISTENT_STORE_UNAVAILABLE" } },
    })
    expect(ops.seen).toEqual([])
  })

  test("handlers are checked when the route loads: one id each, and only events the App subscribes to", () => {
    const ok = recorder("ops", ["deployment_status"]).handler
    expect(() => checkGithubWebhookHandlers([ok, recorder("ops", ["repository"]).handler])).toThrow("used twice")
    expect(() => checkGithubWebhookHandlers([recorder("Ops!", ["repository"]).handler])).toThrow("malformed")
    expect(() => checkGithubWebhookHandlers([recorder("x", ["push"]).handler])).toThrow("does not subscribe")
    expect(() => checkGithubWebhookHandlers([recorder("x", []).handler])).toThrow("does not subscribe")
    expect(() => checkGithubWebhookHandlers([recorder("x", ["repository", "repository"]).handler])).toThrow()
    expect(checkGithubWebhookHandlers([ok])).toEqual([ok])
  })
})

describe("the route", () => {
  test("takes the raw body and registers the actual ops and cloud-agent handlers together", async () => {
    expect(webhookConfig).toEqual({ api: { bodyParser: false } })
    expect(GITHUB_WEBHOOK_HANDLERS.map((handler) => handler.id)).toEqual(["ops", "cloud-agents"])
    expect(GITHUB_WEBHOOK_HANDLERS).toContain(cloudAgentsWebhookHandler)
    for (const handler of GITHUB_WEBHOOK_HANDLERS)
      for (const event of handler.events) expect(GITHUB_APP_WEBHOOK_EVENTS as readonly string[]).toContain(event)
    expect(cloudAgentsWebhookHandler.events).toEqual(["repository"])
    expect(checkGithubWebhookHandlers(GITHUB_WEBHOOK_HANDLERS)).toHaveLength(2)
    // The deployed route reads its secret per request.
    delete process.env.VECTOR_GITHUB_APP_WEBHOOK_SECRET
    expect((await deliver(webhookRoute, { event: "ping" })).status).toBe(503)
  })
})

// ── The ops handler ─────────────────────────────────────────────────────────────────────────────────────────────────

const REPO = 42

function repoSettings(overrides: Partial<OpsRepo> = {}): OpsRepo {
  return {
    repositoryId: REPO,
    repository: `octo-fixture/repo-${REPO}`,
    environment: "Production",
    productionUrl: "https://shop.example.com/",
    paths: ["/", "/checkout"],
    releaseGuard: true,
    shipDesk: true,
    updatedAt: world.now,
    ...overrides,
  }
}

/** An account with a verified domain and a repository set up, its plan pushed to the Worker and its config sent. */
async function ready(account = MAX, plan: PlanId = "vector-100", repo: Partial<OpsRepo> = {}) {
  world.seed(account, plan)
  if (plan === "vector-100" || plan === "vector-200") await world.worker.plan(account, plan)
  world.bind(REPO, account)
  const settings = await updateOpsSettings(
    account,
    () => ({
      ...newOpsSettings(),
      domains: [
        {
          domain: "shop.example.com",
          token: "t".repeat(32),
          addedAt: world.now,
          since: world.now,
          verifiedAt: world.now,
          method: "dns" as const,
        },
      ],
      repos: [repoSettings(repo)],
    }),
    world.fetcher(),
    world.now,
  )
  expect(await syncOpsConfig(account, world.fetcher(), world.now)).toBe("synced")
  // WP A48: the repository's .vector/ops.json opts in, as /api/ops/repos tells the account to commit it.
  world.github.commitOptIn(REPO, opsJson(settings!, settings!.repos[0]!))
}

function deploymentStatus(overrides: { status?: object; deployment?: object; root?: object } = {}) {
  return {
    action: "created",
    deployment_status: {
      id: 9001,
      state: "success",
      environment: "Production",
      created_at: new Date(world.now - 5_000).toISOString(),
      ...overrides.status,
    },
    deployment: {
      id: 5001,
      sha: SHA,
      environment: "Production",
      transient_environment: false,
      ...overrides.deployment,
    },
    repository: { id: REPO, full_name: `octo-fixture/repo-${REPO}`, owner: { id: 7 } },
    installation: { id: 77 },
    ...overrides.root,
  }
}

const event = (name: string, payload: Record<string, unknown>, action = payload.action as string | undefined) =>
  ({ name, ...(action ? { action } : {}), deliveryId: `d-${++deliveries}`, payload }) satisfies GithubWebhookEvent
const route = (input: GithubWebhookEvent) => routeOpsEvent(input, { fetcher: world.fetcher(), clock: () => world.now })
const releases = () => world.worker.actions.filter((action) => action === "release").length

describe("deployments → Release Guard", () => {
  test("a production deployment that succeeded is sent to the Worker to watch, with its URLs on verified domains", async () => {
    await ready()
    const outcome = await route(event("deployment_status", deploymentStatus()))
    expect(outcome).toEqual({
      kind: "release",
      answer: { accepted: true, startAt: world.now - 5_000 + 60_000, endAt: world.now - 5_000 + 60_000 + 30 * 60_000 },
    })
    expect(world.worker.bodies.at(-1)).toEqual({
      account: MAX,
      repositoryId: REPO,
      environment: "Production",
      sha: SHA,
      deployment: "5001",
      at: world.now - 5_000,
      urls: ["https://shop.example.com/", "https://shop.example.com/checkout"],
    })
    // The same release again (a redelivery, or GitHub's second status) is the Worker's duplicate.
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({
      kind: "release",
      answer: { accepted: false, reason: "duplicate" },
    })
  })

  test("through the router: the deployment reaches the Worker once, and a redelivery is not sent again", async () => {
    await ready()
    const webhook = createGithubWebhookRoute({
      handlers: [createOpsWebhookHandler({ fetcher: world.fetcher(), clock: () => world.now })],
      fetcher: world.fetcher(),
    })
    const delivery = "cccccccc-0000-4000-8000-000000000001"
    expect(
      (await deliver(webhook, { event: "deployment_status", payload: deploymentStatus(), delivery })).body,
    ).toEqual({
      ok: true,
    })
    expect(
      (await deliver(webhook, { event: "deployment_status", payload: deploymentStatus(), delivery })).body,
    ).toEqual({
      ok: true,
      duplicate: true,
    })
    expect(releases()).toBe(1)
  })

  test("only a success, in the environment the settings name (without case), and never a transient one", async () => {
    await ready()
    for (const state of ["failure", "error", "pending", "in_progress", "queued", "inactive"])
      expect(await route(event("deployment_status", deploymentStatus({ status: { state } })))).toEqual({
        kind: "ignored",
        reason: "state",
      })
    expect(await route(event("deployment_status", deploymentStatus({ status: { environment: "Preview" } })))).toEqual({
      kind: "ignored",
      reason: "environment",
    })
    expect(
      await route(event("deployment_status", deploymentStatus({ deployment: { transient_environment: true } }))),
    ).toEqual({ kind: "ignored", reason: "transient" })
    expect(await route(event("deployment_status", deploymentStatus({ root: { action: "edited" } })))).toEqual({
      kind: "ignored",
      reason: "action",
    })
    expect(releases()).toBe(0)
    const lower = await route(event("deployment_status", deploymentStatus({ status: { environment: "production" } })))
    expect(lower).toMatchObject({ kind: "release", answer: { accepted: true } })
  })

  test("the repository's binding decides the account: unbound, not set up, Release Guard off, or bound elsewhere do nothing", async () => {
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "unbound" })
    await ready(MAX, "vector-100", { releaseGuard: false })
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({
      kind: "ignored",
      reason: "release-guard-off",
    })
    await ready()
    // The binding moved to another account: Max's settings are no longer its to act on.
    world.bind(REPO, OTHER)
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({
      kind: "ignored",
      reason: "not-configured",
    })
    world.bind(REPO, MAX, { suspended: "transferred" })
    expect((await route(event("deployment_status", deploymentStatus()))).kind).toBe("ignored")
    expect(releases()).toBe(0)
  })

  test("the plan and the service decide: no watch while paused, frozen, ended, on Pro, with ops off or unlisted", async () => {
    await ready()
    for (const state of ["paused", "frozen", "ended"] as const) {
      world.seed(MAX, "vector-100", state)
      expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "plan" })
    }
    world.seed(MAX, "vector-50")
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "plan" })
    world.seed(MAX, "vector-100")
    world.switchOff("ops")
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "off" })
    world.fakes.store.remove(switchKey("ops"))
    delete process.env.VECTOR_OPS_ENABLED
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "off" })
    expect(releases()).toBe(0)
    process.env.VECTOR_OPS_ENABLED = "true"
    // Release Guard not listed, and the account not on the owner's allowlist: no watch either.
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await route(event("deployment_status", deploymentStatus()))).toEqual({
      kind: "ignored",
      reason: "not-listed",
    })
    expect(releases()).toBe(0)
    process.env.CODIUM_LISTED_PERKS = "release-guard"
    world.seed(MAX, "vector-100", "renewing")
    expect((await route(event("deployment_status", deploymentStatus()))).kind).toBe("release")
  })

  test("a production URL whose domain is no longer verified starts no watch", async () => {
    await ready()
    world.advance(15 * DAY)
    world.seed(MAX, "vector-100")
    expect(
      await route(
        event("deployment_status", deploymentStatus({ status: { created_at: new Date(world.now).toISOString() } })),
      ),
    ).toEqual({
      kind: "ignored",
      reason: "not-verified",
    })
    expect(releases()).toBe(0)
  })

  test("the App installation a delivery came through is recorded, for an uninstall that lists no repositories", async () => {
    await ready()
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos[0]?.installationId).toBeUndefined()
    await route(event("deployment_status", deploymentStatus()))
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos[0]?.installationId).toBe(77)
    expect(world.fakes.store.live(opsInstallationIndexKey(77))).toMatchObject({ value: new Set([MAX]) })
  })

  test("a store or a Worker that cannot be reached fails the delivery, so it can be sent again", async () => {
    await ready()
    world.worker.down = true
    await expect(route(event("deployment_status", deploymentStatus()))).rejects.toMatchObject({
      code: "OPS_UNAVAILABLE",
    })
    world.worker.down = false
    world.fakes.store.down = true
    await expect(route(event("deployment_status", deploymentStatus()))).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
  })
})

// ── Pull requests → Ship Desk ───────────────────────────────────────────────────────────────────────────────────────

function pullRequest(overrides: { pull?: Record<string, unknown>; root?: Record<string, unknown> } = {}) {
  return {
    action: "opened",
    number: 12,
    pull_request: {
      number: 12,
      html_url: `https://github.com/octo-fixture/repo-${REPO}/pull/12`,
      user: { login: `${APP_SLUG}[bot]`, type: "Bot" },
      head: { sha: "b".repeat(40), ref: "vector/fix", repo: { id: REPO } },
      base: { ref: "main", repo: { id: REPO } },
      merged: false,
      draft: false,
      body: "<!-- vector:rid gh-42-1-1-1 -->",
      ...overrides.pull,
    },
    repository: { id: REPO, full_name: `octo-fixture/repo-${REPO}` },
    installation: { id: 77 },
    ...overrides.root,
  }
}

describe("pull requests → Ship Desk", () => {
  test("a pull request the App's bot opened from the same repository goes to Ship Desk's intake", async () => {
    await ready()
    const taken: OpsPullRequest[] = []
    registerShipDeskIntake(async (pull) => {
      taken.push(pull)
    })
    expect(appBotLogin()).toBe(`${APP_SLUG}[bot]`)
    const input = event("pull_request", pullRequest())
    expect(await route(input)).toEqual({ kind: "ship-desk" })
    expect(taken).toEqual([
      {
        account: MAX,
        repositoryId: REPO,
        repository: `octo-fixture/repo-${REPO}`,
        number: 12,
        action: "opened",
        headSha: "b".repeat(40),
        merged: false,
        draft: false,
        url: `https://github.com/octo-fixture/repo-${REPO}/pull/12`,
        installationId: 77,
        deliveryId: input.deliveryId,
        // WP A49: what Ship Desk's intake also needs.
        author: "app",
        rid: "gh-42-1-1-1",
        baseRef: "main",
        opsId: (await readOpsSettings(MAX, world.fetcher())).settings!.opsId,
      },
    ])
    for (const action of ["reopened", "synchronize", "ready_for_review", "closed"])
      expect(await route(event("pull_request", pullRequest({ root: { action } })))).toEqual({ kind: "ship-desk" })
  })

  test("people, other bots, forks, an unregistered App, Ship Desk off, or no intake yet: nothing", async () => {
    await ready()
    const taken: OpsPullRequest[] = []
    const intake = async (pull: OpsPullRequest) => {
      taken.push(pull)
    }
    expect(await route(event("pull_request", pullRequest()))).toEqual({
      kind: "ignored",
      reason: "ship-desk-unavailable",
    })
    registerShipDeskIntake(intake)
    const cases: [Parameters<typeof pullRequest>[0], string][] = [
      [{ pull: { user: { login: "octocat", type: "User" } } }, "author"],
      [{ pull: { user: { login: "dependabot[bot]", type: "Bot" } } }, "author"],
      [{ pull: { user: { login: `${APP_SLUG}[bot]`, type: "User" } } }, "author"],
      [{ pull: { head: { sha: "b".repeat(40), repo: { id: 999 } } } }, "fork"],
      [{ pull: { head: { sha: "b".repeat(40), repo: null } } }, "fork"],
      [{ root: { action: "labeled" } }, "action"],
      [{ root: { action: "edited" } }, "action"],
    ]
    for (const [change, reason] of cases)
      expect(await route(event("pull_request", pullRequest(change)))).toEqual({ kind: "ignored", reason })
    delete process.env.VECTOR_GITHUB_APP_SLUG
    expect(await route(event("pull_request", pullRequest()))).toEqual({ kind: "ignored", reason: "author" })
    process.env.VECTOR_GITHUB_APP_SLUG = APP_SLUG
    await ready(MAX, "vector-100", { shipDesk: false })
    expect(await route(event("pull_request", pullRequest()))).toEqual({ kind: "ignored", reason: "ship-desk-off" })
    expect(taken).toEqual([])
  })
})

// ── Removals ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function twoAccountsWithRepo() {
  await ready(MAX, "vector-100")
  world.seed(ULTRA, "vector-200")
  await updateOpsSettings(
    ULTRA,
    () => ({ ...newOpsSettings(), repos: [repoSettings({ shipDesk: true })] }),
    world.fetcher(),
    world.now,
  )
}

describe("removals drop settings", () => {
  test("an uninstall drops the settings of the repositories it lists, from every account that has them", async () => {
    await twoAccountsWithRepo()
    const outcome = await route(
      event("installation", { action: "deleted", installation: { id: 99 }, repositories: [{ id: REPO }, { id: 5 }] }),
    )
    expect(outcome).toEqual({ kind: "dropped", repositories: 2 })
    for (const account of [MAX, ULTRA])
      expect((await readOpsSettings(account, world.fetcher())).settings?.repos).toEqual([])
    expect(world.fakes.store.live(opsRepoIndexKey(REPO))).toBeUndefined()
    // The domains stay: they belong to the account, not to the repository.
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.domains).toHaveLength(1)
  })

  test("an uninstall that lists no repositories drops those recorded under its installation", async () => {
    await ready()
    await route(event("deployment_status", deploymentStatus()))
    expect(await route(event("installation", { action: "deleted", installation: { id: 77 } }))).toEqual({
      kind: "dropped",
      repositories: 1,
    })
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toEqual([])
    expect(world.fakes.store.live(opsInstallationIndexKey(77))).toBeUndefined()
  })

  test("a repository removed from the App, deleted or transferred is dropped; other actions do nothing", async () => {
    await twoAccountsWithRepo()
    expect(
      await route(event("installation_repositories", { action: "removed", repositories_removed: [{ id: REPO }] })),
    ).toEqual({ kind: "dropped", repositories: 2 })
    for (const action of ["deleted", "transferred"]) {
      await twoAccountsWithRepo()
      expect(await route(event("repository", { action, repository: { id: REPO } }))).toEqual({
        kind: "dropped",
        repositories: 2,
      })
    }
    await twoAccountsWithRepo()
    for (const [name, payload] of [
      ["repository", { action: "renamed", repository: { id: REPO } }],
      ["repository", { action: "archived", repository: { id: REPO } }],
      ["installation", { action: "suspend", installation: { id: 77 } }],
      ["installation", { action: "created", installation: { id: 77 }, repositories: [{ id: REPO }] }],
      ["installation_repositories", { action: "added", repositories_added: [{ id: REPO }] }],
    ] as const)
      expect(await route(event(name, payload))).toEqual({ kind: "ignored", reason: "action" })
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toHaveLength(1)
  })

  test("payloads the handler does not recognise are ignored, never thrown", async () => {
    await ready()
    const strange: [string, Record<string, unknown>][] = [
      ["deployment_status", { action: "created" }],
      [
        "deployment_status",
        { action: "created", deployment_status: "success", deployment: {}, repository: { id: REPO } },
      ],
      ["deployment_status", deploymentStatus({ root: { repository: { id: "42" } } })],
      ["deployment_status", deploymentStatus({ deployment: { sha: "not-a-sha" } })],
      ["deployment_status", deploymentStatus({ deployment: { id: -1 } })],
      ["deployment_status", deploymentStatus({ status: { environment: "\u0000" }, deployment: { environment: 7 } })],
      ["pull_request", { action: "opened", pull_request: [] }],
      ["pull_request", pullRequest({ pull: { number: "12" } })],
      ["pull_request", pullRequest({ pull: { html_url: "javascript:alert(1)" } })],
      ["installation", { action: "deleted", repositories: "all" }],
      ["installation", { action: "deleted", installation: { id: 0 }, repositories: [null, { id: "x" }] }],
      ["installation_repositories", { action: "removed", repositories_removed: {} }],
      ["repository", { action: "deleted", repository: null }],
      ["check_run", { action: "completed" }],
    ]
    for (const [name, payload] of strange) expect((await route(event(name, payload))).kind).toBe("ignored")
    expect(releases()).toBe(0)
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toHaveLength(1)
  })

  test("through the router, a repository deletion reaches both the ops handler and Codex's", async () => {
    await ready()
    const codex = recorder("cloud-agents", ["repository"])
    const webhook = createGithubWebhookRoute({
      handlers: [createOpsWebhookHandler({ fetcher: world.fetcher(), clock: () => world.now }), codex.handler],
      fetcher: world.fetcher(),
    })
    expect(
      (await deliver(webhook, { event: "repository", payload: { action: "deleted", repository: { id: REPO } } })).body,
    ).toEqual({
      ok: true,
    })
    expect(codex.seen).toHaveLength(1)
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toEqual([])
  })
})

test("a Pro account with settings left over never reaches the Worker", async () => {
  await ready(PRO, "vector-50")
  expect(await route(event("deployment_status", deploymentStatus()))).toEqual({ kind: "ignored", reason: "plan" })
  expect(releases()).toBe(0)
})

// The production registration topology, with the real handler factory's persistence seam and the real ops handler.
// These cases prove signed routing/fanout/retry; the binding helpers' atomic Redis fences are tested separately.
function cloudBindingFixture() {
  const state = {
    binding: {
      repositoryId: String(REPO),
      ownerId: "7",
      repository: "old/project",
      account: MAX,
      visibility: "private",
      defaultRef: "refs/heads/main",
      generation: 1,
      binder: { githubId: "9", login: "writer" },
      workflowVersion: "3",
      boundAt: world.now,
    } as RepoBinding,
    reads: [] as string[],
    suspended: [] as { generation: number; reason: SuspendReason }[],
    renamed: [] as string[],
    fail: false,
  }
  const handler = createCloudAgentsWebhookHandler({
    bindingFor: async (repositoryId) => {
      state.reads.push(repositoryId)
      return state.binding.repositoryId === repositoryId ? { ...state.binding } : undefined
    },
    suspendBinding: async (binding, reason) => {
      if (state.fail) throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "fixture-only failure")
      if (state.binding.account !== binding.account || state.binding.generation !== binding.generation) return
      state.suspended.push({ generation: binding.generation, reason })
      state.binding = { ...state.binding, generation: binding.generation + 1, suspended: reason }
    },
    renameBinding: async (_repositoryId, repository) => {
      state.renamed.push(repository)
      state.binding = { ...state.binding, repository }
    },
  })
  const route = createGithubWebhookRoute({
    handlers: GITHUB_WEBHOOK_HANDLERS.map((registered) => {
      if (registered.id === "ops") return createOpsWebhookHandler({ fetcher: world.fetcher(), clock: () => world.now })
      if (registered === cloudAgentsWebhookHandler) return handler
      throw new Error("Provide a scoped dependency seam for the new registered handler")
    }),
    fetcher: world.fetcher(),
  })
  return { state, route }
}

describe("the registered cloud-agent repository handler through the signed router", () => {
  test("a signed deletion reaches both real handlers once; invalid signatures reach neither", async () => {
    await ready()
    const f = cloudBindingFixture()
    const payload = { action: "deleted", repository: { id: REPO } }
    const before = world.fakes.store.commands.length
    expect(
      (await deliver(f.route, { event: "repository", payload, signature: `sha256=${"0".repeat(64)}` })).status,
    ).toBe(401)
    expect(f.state.reads).toEqual([])
    expect(world.fakes.store.commands).toHaveLength(before)
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toHaveLength(1)
    const delivery = "cccccccc-0000-4000-8000-000000000001"
    expect(await deliver(f.route, { event: "repository", payload, delivery })).toMatchObject({
      status: 200,
      body: { ok: true },
    })
    expect(f.state.suspended).toEqual([{ generation: 1, reason: "deleted" }])
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toEqual([])
    expect(await deliver(f.route, { event: "repository", payload, delivery })).toMatchObject({
      status: 200,
      body: { ok: true, duplicate: true },
    })
    expect(f.state.suspended).toHaveLength(1)
    expect(world.fakes.store.get(githubDeliveryKey(delivery))).toBe("done")
  })

  test("signed transfer and rename preserve a new owner's binding and ignore malformed repository data", async () => {
    const transferred = cloudBindingFixture()
    const transfer = { action: "transferred", repository: { id: REPO, owner: { id: 8 }, full_name: "new/project" } }
    expect((await deliver(transferred.route, { event: "repository", payload: transfer })).status).toBe(200)
    expect((await deliver(transferred.route, { event: "repository", payload: transfer })).status).toBe(200)
    expect(transferred.state.suspended).toEqual([{ generation: 1, reason: "transferred" }])
    const rebound = cloudBindingFixture()
    rebound.state.binding = { ...rebound.state.binding, ownerId: "8", account: OTHER, generation: 7 }
    expect((await deliver(rebound.route, { event: "repository", payload: transfer })).status).toBe(200)
    expect(rebound.state.suspended).toEqual([])
    expect(rebound.state.binding).toMatchObject({ ownerId: "8", account: OTHER, generation: 7 })
    const renamed = cloudBindingFixture()
    const rename = { action: "renamed", repository: { id: REPO, full_name: "new/project" } }
    expect((await deliver(renamed.route, { event: "repository", payload: rename })).status).toBe(200)
    expect((await deliver(renamed.route, { event: "repository", payload: rename })).status).toBe(200)
    expect(renamed.state.renamed).toEqual(["new/project"])
    expect(renamed.state.binding).toMatchObject({ repository: "new/project", account: MAX, generation: 1 })
    const reads = renamed.state.reads.length
    for (const payload of [
      { action: "edited", repository: { id: REPO } },
      { action: "deleted", repository: null },
      { action: "transferred", repository: { id: REPO, owner: { id: "invalid" } } },
      { action: "renamed", repository: { id: REPO, full_name: "../bad" } },
    ])
      expect((await deliver(renamed.route, { event: "repository", payload })).status).toBe(200)
    expect(renamed.state.reads).toHaveLength(reads)
  })

  test("a binding persistence failure releases the signed delivery for an idempotent retry without logging payload", async () => {
    await ready()
    const f = cloudBindingFixture()
    f.state.fail = true
    const delivery = "cccccccc-0000-4000-8000-000000000002"
    const payload = { action: "deleted", repository: { id: REPO }, privateContext: "DO_NOT_LOG_REPOSITORY_CONTEXT" }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await deliver(f.route, { event: "repository", payload, delivery })).toMatchObject({
        status: 500,
        body: { error: { code: "GITHUB_WEBHOOK_FAILED" } },
      })
      expect(f.state.suspended).toEqual([])
      expect(world.fakes.store.get(githubDeliveryKey(delivery))).toBeUndefined()
      expect(errors.mock.calls).toEqual([
        [
          "Vector GitHub webhook handler failed",
          { handler: "cloud-agents", delivery, code: "PERSISTENT_STORE_UNAVAILABLE" },
        ],
      ])
      f.state.fail = false
      expect(await deliver(f.route, { event: "repository", payload, delivery })).toMatchObject({
        status: 200,
        body: { ok: true },
      })
      expect(f.state.suspended).toEqual([{ generation: 1, reason: "deleted" }])
      expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toEqual([])
      expect(await deliver(f.route, { event: "repository", payload, delivery })).toMatchObject({
        status: 200,
        body: { duplicate: true },
      })
    } finally {
      errors.mockRestore()
    }
  })
})
