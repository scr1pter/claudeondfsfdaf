import { isPlatform, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { requireTrustedJsonRequest } from "../abuse.js"
import { requireAccountUser } from "../account.js"
import { ApiError, handleApiError, json, queryValue, readJson, type ApiRequest, type ApiResponse } from "../http.js"
import { platformOn, readConfig, type Env, type EverywhereConfig } from "./config.js"
import { eraseInstallation, type InstallRevoker, type JobEraser } from "./erase.js"
import {
  CODE_LINK_PLATFORMS,
  checkRepositories,
  createState,
  emailNotifier,
  finishOAuth,
  issueLinkCode,
  listInstalls,
  listLinks,
  listMappings,
  oauthUrl,
  readInstall,
  redeemConnectCode,
  removeMapping,
  setMapping,
  unlink,
  type IdentityContext,
  type Notifier,
  type OAuthExchanges,
} from "./identity.js"
import { everywhereStore, type Store } from "./store.js"

/*
 * The signed-in account's Vector everywhere routes on vectordev.ai (contract 3.8, 3.12): link codes, links,
 * installations, repository mappings and the OAuth finish. Every route authenticates the browser session through
 * `requireAccountUser` (a bearer token, never a cookie) and answers 404 before any store read while the feature is off.
 * There is no `allow` route: teammates are not allowed to spend anyone's runs until the owner says yes (Q2).
 *
 * Bodies are small JSON objects. Answers carry ids, platforms and times, never a token or a code's hash.
 */

export type AccountApiDeps = {
  readonly env?: Env
  readonly store?: Store
  /** For `requireAccountUser`'s call to the account service. */
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  /** The platforms' OAuth exchanges: Slack's (VE-11) and Linear's (VE-12) are added here when they exist. */
  readonly exchanges?: OAuthExchanges
  readonly notify?: Notifier
  /** The jobs module's eraser (VE-05). */
  readonly jobs?: JobEraser
  /** The platform adapters' token revocation on disconnect (VE-06, VE-11). */
  readonly revoke?: InstallRevoker
}

const BODY_LIMIT = 8_000

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
  const store = deps.store ?? everywhereStore()
  const now = (deps.now ?? Date.now)()
  return {
    config,
    account: user.id.toLowerCase(),
    email: user.email,
    ctx: { store, keys: config.dataKeys, now, notify: deps.notify ?? emailNotifier(deps.env ?? process.env) },
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

function route(work: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
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
  /**
   * POST {platform, installation?}: a link code for Slack or Jira (sent to the bot in a private place), or for Linear
   * the start of the sign-in that links (3.8). GitHub needs no link (4.1).
   */
  const link = route((request, response) =>
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
  const links = route((request, response) =>
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
  const installs = route((request, response) =>
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
        const record = await readInstall(session.ctx.store, installation)
        if (record?.connector !== session.account) throw notFound()
        const erased = await eraseInstallation(
          {
            store: session.ctx.store,
            now: session.ctx.now,
            ...(deps.jobs ? { jobs: deps.jobs } : {}),
            ...(deps.revoke ? { revoke: deps.revoke } : {}),
          },
          installation,
          "disconnected",
        )
        json(response, 200, { erased: true, links: erased.links, mappings: erased.mappings })
      },
    }),
  )

  /**
   * GET ?installation=: the mappings of an installation the account connected. PUT {installation, place,
   * repositories, private?}: sets a place's repositories. DELETE {installation, place}: removes one. Connector only.
   */
  const repos = route((request, response) =>
    methods(request, response, {
      GET: async () => {
        const session = await begin(request, deps)
        const installation = text(queryValue(request, "installation"), "installation")
        const record = await readInstall(session.ctx.store, installation)
        if (record?.connector !== session.account) throw notFound()
        json(response, 200, { installation, mappings: await listMappings(session.ctx.store, installation) })
      },
      PUT: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
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
        json(response, 200, { mapping: verdict.mapping })
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
  const oauthFinish = route((request, response) =>
    methods(request, response, {
      POST: async () => {
        const session = await begin(request, deps)
        const input = await body(request)
        const result = await finishOAuth(session.ctx, {
          account: session.account,
          email: session.email,
          code: input.code,
          state: input.state,
          exchanges: deps.exchanges ?? {},
          platformOn: (platform) => platformOn(session.config, platform),
        })
        json(response, 200, result)
      },
    }),
  )

  return { link, links, installs, repos, oauthFinish }
}

/** The production routes: environment, store and account service as deployed. */
export const everywhereAccountApi = createAccountApi()
