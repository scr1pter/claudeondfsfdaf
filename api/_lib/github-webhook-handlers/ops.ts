import type { ReleaseAnswer } from "../../../packages/ops-worker/src/protocol.js"
import { readSnapshot, requireUsableSnapshot } from "../codium-snapshot.js"
import type { GithubWebhookEvent, GithubWebhookHandler } from "../github-webhook.js"
import { ApiError } from "../http.js"
import {
  dropOpsRepositories,
  readOpsSettings,
  releaseUrls,
  repositoryBinding,
  updateOpsSettings,
  urlHost,
  verifiedDomains,
  type OpsRepo,
  type OpsSettings,
} from "../ops-settings.js"
import { opsConfigured, opsRelease, requireOpsService } from "../ops-worker.js"

/*
 * Codium's ops handler on the shared GitHub webhook router (WP A47). It takes:
 *
 * - `deployment_status` → Release Guard. A deployment that reported `success`, for a repository bound to an account
 *   whose ops settings turn Release Guard on and name this deployment's environment (compared without case; transient
 *   environments never count), is sent to the ops Worker to watch (`release`). The account's plan must allow Release
 *   Guard now (active or renewing within grace, a plan with ops caps: §4.4's Release Guard row), the ops services must
 *   be configured and the owner's `ops` switch on. The URLs are the production URL joined with each path, on domains the
 *   account verified, at most the plan's path count. The Worker dedupes by (repository, environment, sha) and counts the
 *   plan's releases a day; A48 adds the .vector/ops.json check and the revert PR.
 * - `pull_request` → Ship Desk. A pull request the GitHub App's bot opened from a branch of the same repository, in a
 *   repository whose settings turn Ship Desk on, goes to the Ship Desk intake. A49 registers that intake (cards,
 *   counting, plan checks); until then it is not acted on.
 * - `installation` (deleted), `installation_repositories` (removed) and `repository` (deleted, transferred) → the
 *   settings of those repositories are dropped from every account that has them.
 *
 * Anything else, and any payload this handler does not recognise, is ignored. A repository's owner is its binding
 * (ops-settings.ts `repositoryBinding`), never a name or an id in the payload alone. The handler throws only when the
 * store or the Worker cannot be reached, so the delivery fails and can be sent again; everything it does is idempotent.
 */

export const OPS_WEBHOOK_EVENTS = [
  "deployment_status",
  "pull_request",
  "installation",
  "installation_repositories",
  "repository",
] as const

/** Pull request actions Ship Desk is told about. */
export const SHIP_DESK_ACTIONS = ["opened", "reopened", "synchronize", "ready_for_review", "closed"] as const

/** A pull request Ship Desk may make a card of (A49). The intake checks the plan and counts cards itself. */
export type OpsPullRequest = {
  account: string
  repositoryId: number
  repository: string
  number: number
  action: (typeof SHIP_DESK_ACTIONS)[number]
  headSha: string
  merged: boolean
  draft: boolean
  url: string
  installationId?: number
  deliveryId: string
}
export type ShipDeskIntake = (pull: OpsPullRequest) => Promise<void>

let shipDeskIntake: ShipDeskIntake | undefined

/** A49 registers the Ship Desk intake here. */
export function registerShipDeskIntake(intake: ShipDeskIntake | undefined) {
  shipDeskIntake = intake
}

export type OpsWebhookOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "release"; answer: ReleaseAnswer }
  | { kind: "ship-desk" }
  | { kind: "dropped"; repositories: number }

export type OpsWebhookContext = { fetcher?: typeof fetch; clock?: () => number }

const SHA = /^[0-9a-f]{40}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}
function ignored(reason: string): OpsWebhookOutcome {
  return { kind: "ignored", reason }
}

/** The GitHub App bot's login (`<slug>[bot]`), from VECTOR_GITHUB_APP_SLUG; undefined while no App is registered. */
export function appBotLogin(env: Record<string, string | undefined> = process.env) {
  const slug = env.VECTOR_GITHUB_APP_SLUG?.trim()
  return slug && SLUG.test(slug) ? `${slug}[bot]` : undefined
}

/** What the handler does with one delivery. `opsWebhookHandler` runs this and drops the outcome. */
export async function routeOpsEvent(
  event: GithubWebhookEvent,
  context: OpsWebhookContext = {},
): Promise<OpsWebhookOutcome> {
  const fetcher = context.fetcher ?? fetch
  const clock = context.clock ?? Date.now
  switch (event.name) {
    case "deployment_status":
      return deployment(event, fetcher, clock)
    case "pull_request":
      return pullRequest(event, fetcher, clock)
    case "installation":
      if (event.action !== "deleted") return ignored("action")
      return drop(event.payload, "repositories", true, fetcher, clock)
    case "installation_repositories":
      if (event.action !== "removed") return ignored("action")
      return drop(event.payload, "repositories_removed", false, fetcher, clock)
    case "repository": {
      if (event.action !== "deleted" && event.action !== "transferred") return ignored("action")
      const repositoryId = positive(record(event.payload.repository)?.id)
      if (!repositoryId) return ignored("payload")
      return {
        kind: "dropped",
        repositories: await dropOpsRepositories({ repositoryIds: [repositoryId] }, fetcher, clock()),
      }
    }
  }
  return ignored("event")
}

async function drop(
  payload: Record<string, unknown>,
  field: "repositories" | "repositories_removed",
  uninstall: boolean,
  fetcher: typeof fetch,
  clock: () => number,
): Promise<OpsWebhookOutcome> {
  const list = payload[field]
  const repositoryIds = Array.isArray(list) ? list.flatMap((item) => positive(record(item)?.id) ?? []) : []
  const installationId = uninstall ? positive(record(payload.installation)?.id) : undefined
  if (!repositoryIds.length && installationId === undefined) return ignored("payload")
  return {
    kind: "dropped",
    repositories: await dropOpsRepositories(
      { repositoryIds, ...(installationId !== undefined ? { installationId } : {}) },
      fetcher,
      clock(),
    ),
  }
}

type Configured =
  | { found: false; reason: "unbound" | "not-configured" }
  | { found: true; account: string; settings: OpsSettings; repo: OpsRepo }

/** The bound account and its settings for the repository, or why there are none. */
async function configured(repositoryId: number, fetcher: typeof fetch): Promise<Configured> {
  const binding = await repositoryBinding(repositoryId)
  if (!binding) return { found: false, reason: "unbound" }
  const { settings } = await readOpsSettings(binding.account, fetcher)
  const repo = settings?.repos.find((item) => item.repositoryId === repositoryId)
  if (!settings || !repo) return { found: false, reason: "not-configured" }
  return { found: true, account: binding.account, settings, repo }
}

/** Records the App installation a delivery came through, when the settings did not have it, for a later uninstall. */
async function learnInstallation(
  account: string,
  repo: OpsRepo,
  payload: Record<string, unknown>,
  fetcher: typeof fetch,
  now: number,
) {
  const installationId = positive(record(payload.installation)?.id)
  if (installationId === undefined || installationId === repo.installationId) return
  await updateOpsSettings(
    account,
    (current) => {
      const found = current?.repos.find((item) => item.repositoryId === repo.repositoryId)
      if (!current || !found || found.installationId === installationId) return undefined
      return {
        ...current,
        repos: current.repos.map((item) => (item === found ? { ...item, installationId } : item)),
      }
    },
    fetcher,
    now,
  )
}

/** The plan's Release Guard caps when the account's snapshot allows a new watch now; undefined otherwise. */
async function releaseCaps(account: string, fetcher: typeof fetch, now: number) {
  try {
    return requireUsableSnapshot(await readSnapshot(account, fetcher), now).caps.ops?.releaseGuard ?? undefined
  } catch (error) {
    // The store being down is a failure to retry; every other refusal is the plan's answer (paused, ended, frozen…).
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return undefined
  }
}

async function deployment(
  event: GithubWebhookEvent,
  fetcher: typeof fetch,
  clock: () => number,
): Promise<OpsWebhookOutcome> {
  if (event.action !== undefined && event.action !== "created") return ignored("action")
  const status = record(event.payload.deployment_status)
  const deploy = record(event.payload.deployment)
  const repositoryId = positive(record(event.payload.repository)?.id)
  if (!status || !deploy || !repositoryId) return ignored("payload")
  if (status.state !== "success") return ignored("state")
  if (deploy.transient_environment === true) return ignored("transient")
  const environment =
    typeof status.environment === "string" && status.environment
      ? status.environment
      : typeof deploy.environment === "string"
        ? deploy.environment
        : undefined
  const sha = typeof deploy.sha === "string" ? deploy.sha.toLowerCase() : undefined
  const deploymentId = positive(deploy.id)
  if (!environment || environment.length > 255 || /[\u0000-\u001f\u007f]/.test(environment)) return ignored("payload")
  if (!sha || !SHA.test(sha) || !deploymentId) return ignored("payload")

  const found = await configured(repositoryId, fetcher)
  if (!found.found) return ignored(found.reason)
  const { account, settings, repo } = found
  if (!repo.releaseGuard) return ignored("release-guard-off")
  if (repo.environment.toLowerCase() !== environment.toLowerCase()) return ignored("environment")
  const now = clock()
  await learnInstallation(account, repo, event.payload, fetcher, now)
  if (!opsConfigured()) return ignored("off")
  try {
    await requireOpsService(fetcher, now)
  } catch (error) {
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return ignored("off")
  }
  const caps = await releaseCaps(account, fetcher, now)
  if (!caps) return ignored("plan")
  const verified = new Set(verifiedDomains(settings, now))
  const urls = releaseUrls(repo)
    .filter((url) => verified.has(urlHost(url)))
    .slice(0, caps.paths)
  if (!urls.length) return ignored("not-verified")
  const reported = typeof status.created_at === "string" ? Date.parse(status.created_at) : Number.NaN
  const answer = await opsRelease(
    {
      account,
      repositoryId,
      environment,
      sha,
      deployment: String(deploymentId),
      at: Number.isSafeInteger(reported) && reported > 0 ? reported : now,
      urls,
    },
    fetcher,
    now,
  )
  return { kind: "release", answer }
}

async function pullRequest(
  event: GithubWebhookEvent,
  fetcher: typeof fetch,
  clock: () => number,
): Promise<OpsWebhookOutcome> {
  const action = SHIP_DESK_ACTIONS.find((item) => item === event.action)
  if (!action) return ignored("action")
  const pull = record(event.payload.pull_request)
  const repositoryId = positive(record(event.payload.repository)?.id)
  const number = positive(pull?.number)
  if (!pull || !repositoryId || !number) return ignored("payload")
  // App-bot-authored: the bot of Vector's own GitHub App, never another bot or a person.
  const author = record(pull.user)
  const bot = appBotLogin()
  if (!bot || author?.type !== "Bot" || author.login !== bot) return ignored("author")
  // Same-repo: the head branch lives in the repository the pull request targets (no fork).
  const headRepo = positive(record(record(pull.head)?.repo)?.id)
  const baseRepo = positive(record(record(pull.base)?.repo)?.id)
  if (headRepo !== repositoryId || baseRepo !== repositoryId) return ignored("fork")
  const headSha = typeof record(pull.head)?.sha === "string" ? String(record(pull.head)!.sha).toLowerCase() : ""
  const url = typeof pull.html_url === "string" && pull.html_url.startsWith("https://") ? pull.html_url : undefined
  if (!SHA.test(headSha) || !url) return ignored("payload")

  const found = await configured(repositoryId, fetcher)
  if (!found.found) return ignored(found.reason)
  if (!found.repo.shipDesk) return ignored("ship-desk-off")
  const now = clock()
  await learnInstallation(found.account, found.repo, event.payload, fetcher, now)
  if (!shipDeskIntake) return ignored("ship-desk-unavailable")
  const installationId = positive(record(event.payload.installation)?.id)
  await shipDeskIntake({
    account: found.account,
    repositoryId,
    repository: found.repo.repository,
    number,
    action,
    headSha,
    merged: pull.merged === true,
    draft: pull.draft === true,
    url,
    ...(installationId !== undefined ? { installationId } : {}),
    deliveryId: event.deliveryId,
  })
  return { kind: "ship-desk" }
}

/** The ops handler with its own fetch and clock (tests); the route registers `opsWebhookHandler`. */
export function createOpsWebhookHandler(context: OpsWebhookContext = {}): GithubWebhookHandler {
  return {
    id: "ops",
    events: OPS_WEBHOOK_EVENTS,
    async handle(event) {
      await routeOpsEvent(event, context)
    },
  }
}

export const opsWebhookHandler = createOpsWebhookHandler()
