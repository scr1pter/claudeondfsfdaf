import {
  LIMITS,
  githubThreadUrl,
  installationPlatform,
  isPlatform,
  type DeclineCode,
  type JobState,
  type Outcome,
  type PlatformId,
  type RefusalCode,
} from "../../../packages/schema/src/everywhere.js"
import { sanitizeReply, type Ending } from "../../../packages/schema/src/everywhere-policy.js"
import { requireTrustedJsonRequest } from "../abuse.js"
import { requireAccountUser } from "../account.js"
import type { RepoBinding } from "../cloud-agents-binding.js"
import { ApiError, handleApiError, json, queryValue, readJson, type ApiRequest, type ApiResponse } from "../http.js"
import { persistentStore } from "../persistent-store.js"
import { codiumAccountAuthority } from "./adapters/account.js"
import { createRepositoryPort } from "./adapters/cloud-agents.js"
import { readAudit, type AuditEntry } from "./audit.js"
import { checkAccount } from "./authority.js"
import { platformOn, readConfig, type Env, type EverywhereConfig } from "./config.js"
import { eraseInstallation, type InstallRevoker, type JobEraser } from "./erase.js"
import {
  CODE_LINK_PLATFORMS,
  addTrackerRepository,
  checkRepositories,
  createState,
  emailNotifier,
  finishOAuth,
  issueLinkCode,
  listInstalls,
  listLinks,
  listMappings,
  oauthUrl,
  readInstall, readInstallSnapshot, readInstallState,
  redeemConnectCode,
  removeMapping,
  setMapping,
  unlink,
  type IdentityContext,
  type InstallRecord,
  type Notifier,
  type OAuthExchanges,
  type RepoMapping,
} from "./identity.js"
import type { Ports } from "./ports.js"
import { jobEraser, openReply, openSummary, readJobHistory, type JobRecord, type JobRoute } from "./jobs.js"
import { KEEP_MS } from "./keys.js"
import { platformExchanges } from "./oauth-exchanges.js"
import { revokeSlack } from "./slack/install.js"
import { revokeLinear } from "./linear/install.js"
import { everywhereStore, type Store } from "./store.js"

/*
 * The signed-in account's Vector everywhere routes on vectordev.ai (contract 3.8, 3.12): link codes, links,
 * installations, repository mappings, the OAuth finish, and two reads: the account's jobs of the last 30 days and its
 * audit log of the last 90 (E16), each capped at 100 and scoped to the account (E18). Job links come from a result or
 * from a GitHub handoff with the same active repository binding generation. The one free text either read answers is a job's
 * `summary`: the sealed settle summary of a job in a private place (a Slack DM) that the signed-in account asked for and
 * whose post has not gone out, cleaned by sanitizeReply as posts are (`privateSummary`); a shared place's is never
 * answered. Whether it stays is the lead's 3.12/3.7 ruling (EV-23). Every route authenticates the browser session through
 * `requireAccountUser` (a bearer token, never a cookie) and answers 404 before any store read while the feature is off.
 * There is no `allow` route: teammates are not allowed to spend anyone's runs until the owner says yes (Q2).
 *
 * Bodies are small JSON objects. Answers carry ids, platforms and times, never a token or a code's hash.
 */

export type AccountApiDeps = {
  readonly accountAuthority?: import("./authority.js").AccountAuthorityPort
  readonly env?: Env
  readonly store?: Store
  /** For `requireAccountUser`'s call to the account service and, with no `store`, the default store's calls. */
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  readonly repository?: NonNullable<Ports["repository"]>
  /**
   * Replaces the default exchanges, oauth-exchanges.ts `platformExchanges`: Slack's install (VE-11) and Linear's
   * install and sign-in link (VE-12), built per request for each platform in `config.platforms` (listed in
   * VECTOR_EVERYWHERE_PLATFORMS with complete settings, and empty while the feature is off). In identity.ts
   * `finishOAuth`, a platform that is not on (`platformOn`) answers 404 first; one that is on but has no exchange for
   * the purpose answers 501 EVERYWHERE_UNAVAILABLE.
   */
  readonly exchanges?: OAuthExchanges
  readonly notify?: Notifier
  /** The jobs module's eraser; the default is jobs.ts `jobEraser` over this store (VE-05). */
  readonly jobs?: JobEraser
  /** The platform adapters' token revocation on disconnect (VE-06, VE-11). */
  readonly revoke?: InstallRevoker
}

const BODY_LIMIT = 8_000
/** The most jobs GET history answers, newest first (3.12). */
export const HISTORY_LIMIT = 100
/** The most entries GET audit answers, newest first (E16). */
export const AUDIT_PAGE = 100

/** A job as the account's job list shows it: ids, fixed codes, times and verified links. */
export type AccountJob = {
  readonly jid: string
  readonly platform: PlatformId
  readonly installation: string
  readonly state: JobState
  readonly route?: JobRoute
  readonly outcome?: Outcome
  readonly code?: RefusalCode | DeclineCode
  readonly ending?: Ending
  readonly repository: string
  readonly issue?: string
  /** The reply went to a shared place: its summary is never answered here. */
  readonly shared: boolean
  readonly receivedAt: number
  readonly endedAt?: number
  readonly prUrl?: string
  readonly threadUrl?: string
  /** A private place's summary not yet posted, for the account that asked, cleaned as posts are (`privateSummary`). */
  readonly summary?: string
}

/** An audit entry without the computer's id or another account's id: `byOther` says another account acted. */
export type AccountAuditEntry = Omit<AuditEntry, "device" | "actor"> & { readonly byOther?: true }

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Not found.")
}

type Session = {
  readonly config: EverywhereConfig
  readonly account: string
  readonly email: string
  readonly ctx: IdentityContext
}

async function begin(request: ApiRequest, deps: AccountApiDeps): Promise<Session> {
  const config = readConfig(deps.env ?? process.env)
  if (!config.enabled) throw notFound()
  const user = await requireAccountUser(request, deps.fetcher ?? fetch)
  const store = deps.store ?? everywhereStore(deps.fetcher ?? fetch, deps.accountAuthority ?? codiumAccountAuthority)
  const now = (deps.now ?? Date.now)()
  await checkAccount({ store, accountAuthority: deps.accountAuthority }, user.id)
  return {
    config,
    account: user.id.toLowerCase(),
    email: user.email,
    ctx: { store, keys: config.dataKeys, now, accountAuthority: deps.accountAuthority, notify: deps.notify ?? emailNotifier(deps.env ?? process.env) },
  }
}

async function body(request: ApiRequest): Promise<Record<string, unknown>> {
  requireTrustedJsonRequest(request, BODY_LIMIT)
  const value = await readJson<unknown>(request, BODY_LIMIT)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ApiError(400, "EVERYWHERE_INVALID", "This request is not valid.")
  return value as Record<string, unknown>
}

function platformField(value: unknown): PlatformId {
  if (!isPlatform(value)) throw new ApiError(400, "EVERYWHERE_INVALID", "Name a platform: slack, linear or jira.")
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new ApiError(400, "EVERYWHERE_INVALID", `This request needs a valid ${field}.`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

function mappingForAccount({ privateSetAt: _privateSetAt, ...mapping }: RepoMapping) {
  return mapping
}

function requirePlatform(config: EverywhereConfig, platform: PlatformId) {
  if (!platformOn(config, platform)) throw notFound()
}

function methods(
  request: ApiRequest,
  response: ApiResponse,
  table: Partial<Record<"GET" | "POST" | "PUT" | "DELETE", () => Promise<void>>>,
): Promise<void> {
  const run = table[request.method as keyof typeof table]
  if (run) return run()
  response.setHeader("allow", Object.keys(table).join(", "))
  throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${Object.keys(table).join(" or ")} for this endpoint.`)
}

/** With Vector everywhere off, every route and method answers 404 with no `allow` header, before anything else. */
function route(deps: AccountApiDeps, work: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      if (!readConfig(deps.env ?? process.env).enabled) throw notFound()
      await work(request, response)
    } catch (error) {
      handleApiError(response, error)
    }
  }
}

const LINK_NOTE: Readonly<Record<string, string>> = {
  slack: "Send this only to the Vector bot in a direct message. Never give it to a person.",
  jira: "Send this only to Vector in Rovo chat. Never give it to a person.",
}

export function createAccountApi(deps: AccountApiDeps = {}) {
  const verifyRepository = deps.repository ?? createRepositoryPort()

  /**
   * POST {platform, installation?}: a link code for Slack or Jira (sent to the bot in a private place), or for Linear
   * the start of the sign-in that links (3.8). GitHub needs no link (4.1).
   */
  const link = route(deps, (request, response) =>
    methods(request, response, {
      POST: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const platform = platformField(input.platform)
        if (platform === "github")
          throw new ApiError(
            400,
            "EVERYWHERE_UNSUPPORTED",
            "GitHub needs no link: Vector reads ids from GitHub itself.",
          )
        requirePlatform(session.config, platform)
        const installation = optionalText(input.installation, "installation")
        if ((CODE_LINK_PLATFORMS as readonly string[]).includes(platform)) {
          const issued = await issueLinkCode(session.ctx, {
            account: session.account,
            email: session.email,
            platform,
            ...(installation !== undefined ? { installation } : {}),
          })
          json(response, 200, { platform, code: issued.code, expiresAt: issued.expiresAt, note: LINK_NOTE[platform] })
          return
        }
        const started = await createState(session.ctx, { account: session.account, platform, purpose: "link" })
        const url = oauthUrl(session.config, { platform, purpose: "link", state: started.state })
        if (!url) throw notFound()
        json(response, 200, { platform, state: started.state, url, expiresAt: started.expiresAt })
      },
    }),
  )

  /** GET: the account's links. DELETE {installation, userId}: removes one of the account's own links. */
  const links = route(deps, (request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        json(response, 200, { links: await listLinks(session.ctx.store, session.account) })
      },
      DELETE: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const result = await unlink(session.ctx, {
          installation: text(input.installation, "installation"),
          userId: text(input.userId, "userId"),
          account: session.account,
        })
        if (!result.ok) throw notFound()
        json(response, 200, { unlinked: true })
      },
    }),
  )

  /**
   * GET: the installations the account connected. POST {platform: slack | linear, installation?}: starts an install
   * (an OAuth state and the authorize URL). POST {platform: jira, code, cloudId?}: redeems a Jira site connect code.
   * DELETE {installation}: the connector disconnects, which erases the installation (E13).
   */
  const installs = route(deps, (request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        json(response, 200, { installs: await listInstalls(session.ctx.store, session.account) })
      },
      POST: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const platform = platformField(input.platform)
        if (platform === "github")
          throw new ApiError(400, "EVERYWHERE_UNSUPPORTED", "The GitHub App is installed from GitHub, not here.")
        requirePlatform(session.config, platform)
        if (platform === "jira") {
          const verdict = await redeemConnectCode(session.ctx, {
            account: session.account,
            code: text(input.code, "code"),
            ...(input.cloudId !== undefined ? { cloudId: text(input.cloudId, "cloudId") } : {}),
          })
          if (!verdict.ok && verdict.code === "code-invalid")
            throw new ApiError(400, "EVERYWHERE_CODE_INVALID", "That connect code is not valid or has expired.")
          if (!verdict.ok)
            throw new ApiError(409, "EVERYWHERE_INSTALLED_ELSEWHERE", "Another account connected this site.")
          json(response, 200, { platform, installation: verdict.installation, change: verdict.change })
          return
        }
        const installation = optionalText(input.installation, "installation")
        const started = await createState(session.ctx, {
          account: session.account,
          platform,
          purpose: "install",
          ...(installation !== undefined ? { installation } : {}),
        })
        const url = oauthUrl(session.config, { platform, purpose: "install", state: started.state })
        if (!url) throw notFound()
        json(response, 200, { platform, state: started.state, url, expiresAt: started.expiresAt })
      },
      DELETE: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const installation = text(input.installation, "installation")
        const snapshot = await readInstallState(session.ctx.store, installation)
        if (snapshot?.record.connector !== session.account) throw notFound()
        const erased = await eraseInstallation(
          {
            store: session.ctx.store,
            accountAuthority: session.ctx.accountAuthority,
            now: session.ctx.now,
            jobs: deps.jobs ?? jobEraser(session.ctx.store, () => session.ctx.now),
            // A caller replacing the native exchanges also owns that transport's revocation port.
            ...(deps.revoke ? { revoke: deps.revoke } : deps.exchanges === undefined ? {
              revoke: (installation: string, record: InstallRecord, beforeRequest: () => Promise<void>) => installation.startsWith("linear:")
                ? revokeLinear(installation, record, session.config.dataKeys, deps.fetcher, beforeRequest) : revokeSlack(installation, record, session.config.dataKeys, deps.fetcher, beforeRequest),
            } : {}),
          },
          installation,
          "disconnected", { expected: snapshot },
        )
        json(response, erased.nativePending ? 202 : 200, { erased: !erased.nativePending, links: erased.links, mappings: erased.mappings,
          ...(erased.nativePending ? { closing: true, nextAction: "review-native-revocation" } : {}) })
      },
    }),
  )

  /**
   * GET ?installation=: the mappings of an installation the account connected. PUT {installation, place,
   * repositories, private?}: sets a place's repositories. PUT {installation, place, addRepository}: verifies and
   * adds a Linear or Jira mapping entry. DELETE {installation, place}: removes a mapping. Connector only.
   */
  const repos = route(deps, (request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        const installation = text(queryValue(request, "installation"), "installation")
        const snapshot = await readInstallState(session.ctx.store, installation)
        if (snapshot?.record.connector !== session.account) throw notFound()
        const mappings = await listMappings(session.ctx.store, installation)
        await checkAccount(session.ctx, session.account)
        if ((await readInstallState(session.ctx.store, installation))?.raw !== snapshot.raw) throw notFound()
        json(response, 200, { installation, mappings: mappings.map(mappingForAccount) })
      },
      PUT: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        if (Object.hasOwn(input, "addRepository")) {
          if (Object.keys(input).some((key) => key !== "addRepository" && key !== "installation" && key !== "place"))
            throw new ApiError(400, "EVERYWHERE_INVALID", "Send the installation, place and one repository to add.")
          const installation = text(input.installation, "installation")
          const platform = installationPlatform(installation)
          if (platform !== "linear" && platform !== "jira") throw notFound()
          requirePlatform(session.config, platform)
          const verdict = await addTrackerRepository(session.ctx, {
            account: session.account,
            installation,
            place: text(input.place, "place"),
            fullName: text(input.addRepository, "repository"),
            verifyRepository,
          })
          if (!verdict.ok) {
            if (verdict.code === "repository-unverified")
              throw new ApiError(400, "EVERYWHERE_REPOSITORY_UNVERIFIED", "Choose a repository connected to your Vector account.")
            throw notFound()
          }
          json(response, 200, { mapping: mappingForAccount(verdict.mapping) })
          return
        }
        const repositories = checkRepositories(input.repositories)
        if (!repositories)
          throw new ApiError(400, "EVERYWHERE_INVALID", "Name at most 20 repositories as owner/name, each once.")
        if (input.private !== undefined && typeof input.private !== "boolean")
          throw new ApiError(400, "EVERYWHERE_INVALID", "private is true or false.")
        const verdict = await setMapping(session.ctx, {
          account: session.account,
          installation: text(input.installation, "installation"),
          place: text(input.place, "place"),
          repositories,
          ...(input.private !== undefined ? { private: input.private as boolean } : {}),
        })
        if (!verdict.ok) throw notFound()
        json(response, 200, { mapping: mappingForAccount(verdict.mapping) })
      },
      DELETE: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const verdict = await removeMapping(session.ctx, {
          account: session.account,
          installation: text(input.installation, "installation"),
          place: text(input.place, "place"),
        })
        if (!verdict.ok) throw notFound()
        json(response, 200, { removed: verdict.removed })
      },
    }),
  )

  /** POST {code, state}: the OAuth landing page finishes an install or a sign-in link (3.8). */
  const oauthFinish = route(deps, (request, response) =>
    methods(request, response, {
      POST: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const result = await finishOAuth(session.ctx, {
          account: session.account,
          email: session.email,
          code: input.code,
          state: input.state,
          exchanges: deps.exchanges ?? platformExchanges(session.config, deps.fetcher, () => session.ctx.now),
          platformOn: (platform) => platformOn(session.config, platform),
        })
        json(response, 200, result)
      },
    }),
  )

  /**
   * GET: the account's jobs of the last 30 days, newest first, at most HISTORY_LIMIT (3.12): only jobs it sponsors
   * (E18), each as `accountJob` shows it. `capped` says there were more; `skipped` counts records that did not decode.
   */
  const history = route(deps, (request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        const read = await readJobHistory(session.ctx.store, session.account, {
          now: session.ctx.now,
          limit: HISTORY_LIMIT,
        })
        // One installation read per installation, however many of its jobs hold a summary.
        const [installs, githubBindings] = await Promise.all([
          Promise.all(
            [...new Set(read.jobs.filter((job) => summaryHeld(session, job)).map((job) => job.installation))].map(
              async (installation) =>
                [installation, await readInstallSnapshot(session.ctx.store, installation)] as const,
            ),
          ),
          platformOn(session.config, "github") && read.jobs.some((job) => ownedGithubReference(session.account, job))
            ? accountGithubBindings(session.account, deps.fetcher).catch(() => [])
            : [],
        ])
        const snapshots = new Map(installs)
        const bindings = new Map(githubBindings.map((binding) => [binding.repositoryId, binding]))
        const jobs = read.jobs.map((job) =>
          accountJob(
            job,
            privateSummary(session, job, snapshots.get(job.installation)),
            boundGithubThread(session, job, bindings.get(String(job.repository.id))),
          ),
        )
        // As GET repos: an account closed during the reads gets nothing.
        await checkAccount(session.ctx, session.account)
        json(response, 200, { jobs, capped: read.capped, skipped: read.skipped })
      },
    }),
  )

  /**
   * GET: the account's audit log of the last 90 days, newest first, at most AUDIT_PAGE (E16, 3.13). Entries carry ids
   * and fixed codes; the computer's id and another account's id are left out.
   */
  const audit = route(deps, (request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        const cutoff = session.ctx.now - KEEP_MS.audit
        const entries = (await readAudit(session.ctx.store, session.account, AUDIT_PAGE))
          .filter((entry) => entry.at >= cutoff)
          .map((entry) => accountAuditEntry(entry, session.account))
        await checkAccount(session.ctx, session.account)
        json(response, 200, { entries })
      },
    }),
  )

  return { link, links, installs, repos, oauthFinish, history, audit }
}

function accountJob(job: JobRecord, summary: string | undefined, threadUrl: string | undefined): AccountJob {
  return {
    jid: job.jid,
    platform: job.platform,
    installation: job.installation,
    state: job.state,
    ...(job.route !== undefined ? { route: job.route } : {}),
    ...(job.outcome !== undefined ? { outcome: job.outcome } : {}),
    ...(job.code !== undefined ? { code: job.code } : {}),
    ...(job.ending !== undefined ? { ending: job.ending } : {}),
    repository: job.repository.fullName,
    ...(job.issue !== undefined ? { issue: job.issue.key } : {}),
    shared: job.shared,
    receivedAt: job.receivedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.result?.prUrl !== undefined ? { prUrl: job.result.prUrl } : {}),
    ...(threadUrl !== undefined ? { threadUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
  }
}

/** Reuse the protected account's stored repo bindings. This read never contacts GitHub. */
async function accountGithubBindings(account: string, fetcher: typeof fetch = fetch) {
  const { bindingsForAccount } = await import("../cloud-agents-binding.js")
  return bindingsForAccount(account, (command) => persistentStore(command, fetcher))
}

function ownedGithubReference(account: string, job: JobRecord) {
  const reference = job.github
  if (
    job.platform !== "github" ||
    job.requester.account !== account ||
    reference?.actorId === undefined ||
    reference.event === undefined ||
    String(reference.actorId) !== job.requester.userId
  )
    return undefined
  return reference
}

/** A stored handoff still owned by the same binding may expose its canonical issue or pull request page. */
function boundGithubThread(session: Session, job: JobRecord, binding: RepoBinding | undefined) {
  const reference = ownedGithubReference(session.account, job)
  if (
    !reference ||
    !binding ||
    binding.account !== session.account ||
    binding.suspended !== undefined ||
    binding.repository.toLowerCase() !== job.repository.fullName.toLowerCase() ||
    binding.binder.githubId !== job.requester.userId ||
    job.installation !== `github:${binding.installationId}`
  )
    return undefined
  const generation = openReply(session.ctx, job)?.githubBindingGeneration
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation !== binding.generation
  )
    return undefined
  return githubThreadUrl(job.repository.fullName, reference.kind, reference.number)
}

/**
 * A settle summary still held for a job in a private place (a Slack DM), only for the account that asked. A summary
 * is erased once posted (3.2), so this is one whose post has not gone out. A shared place's summary is never answered
 * (the private result surface is not built). It is opened only while the installation is the one the job ran under
 * (`install`, its current record): after a disconnect, or any install after the job was received, it stays hidden
 * (E13). The computer cleans a summary before settle, but the server does not rely on it: the text goes through
 * `sanitizeReply` as the post does (3.7), so a secret or code is withheld and a link to another host removed.
 */
function privateSummary(session: Session, job: JobRecord, install: { readonly record: InstallRecord } | undefined) {
  if (!summaryHeld(session, job) || !install || install.record.installedAt > job.receivedAt) return undefined
  const opened = openSummary(session.ctx, job)
  if (opened === undefined) return undefined
  const clean = sanitizeReply(opened, {
    platform: job.platform,
    repository: job.repository.fullName,
    maxChars: LIMITS.summaryChars,
  }).text
  return clean === "" ? undefined : clean
}

/** A private place's job that the signed-in account asked for and that still holds a sealed summary. */
function summaryHeld(session: Session, job: JobRecord) {
  return !job.shared && job.requester.account === session.account && job.summaryEnc !== undefined
}

function accountAuditEntry(entry: AuditEntry, account: string): AccountAuditEntry {
  return {
    id: entry.id,
    at: entry.at,
    event: entry.event,
    ...(entry.platform !== undefined ? { platform: entry.platform } : {}),
    ...(entry.installation !== undefined ? { installation: entry.installation } : {}),
    ...(entry.jid !== undefined ? { jid: entry.jid } : {}),
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ...(entry.userId !== undefined ? { userId: entry.userId } : {}),
    ...(entry.actor !== undefined && entry.actor !== account ? { byOther: true as const } : {}),
  }
}

/** The production routes: environment, store and account service as deployed. */
export const everywhereAccountApi = createAccountApi()
