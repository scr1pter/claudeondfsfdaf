import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { requireAccountUser, type AccountUser } from "./account.js"
import { verifyDesktopToken } from "./cli-token.js"
import {
  bindingFor,
  bindingsForAccount,
  createBindCode,
  peekBindCode,
  redeemAndBind,
  revokeBinding,
  takeoverAllowed,
} from "./cloud-agents-binding.js"
import { cloudAgentEntitlement } from "./cloud-agents-entitlement.js"
import { githubProof } from "./github-api.js"
import { githubApp, type createGithubApp } from "./github-app.js"
import { githubApiVersion, githubId, githubRecord, githubResponseBytes, githubUnavailable } from "./github-http.js"
import { consumeGithubOidc, verifyGithubOidc, type GithubIdentity } from "./github-oidc.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { requireUnrevokedAccount } from "./revocation.js"

const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Branch = Schema.String.check(Schema.isPattern(/^refs\/heads\/[^\s:~^?*\[\\]{1,240}$/))
const PublicBranch = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)),
  ownerId: Decimal,
  defaultRef: Branch,
})
const decodeBranch = Schema.decodeUnknownOption(Schema.fromJsonString(PublicBranch), { onExcessProperty: "error" })

export async function requireCloudAgentsUser(
  request: ApiRequest,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AccountUser> {
  const authorization = request.headers.authorization
  const token = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] : undefined
  const user = token?.startsWith("vct_") ? verifyDesktopToken(token, now) : await requireAccountUser(request, fetcher)
  await requireUnrevokedAccount(user.id, fetcher)
  return user
}

export function createCloudAgentsApi(
  input: {
    verify?: typeof verifyGithubOidc
    store?: typeof persistentStore
    entitlement?: typeof cloudAgentEntitlement
    app?: ReturnType<typeof createGithubApp>
    now?: () => number
    fetcher?: typeof fetch
  } = {},
) {
  const verify = input.verify ?? verifyGithubOidc
  const store = input.store ?? persistentStore
  const entitlement = input.entitlement ?? cloudAgentEntitlement
  const app = input.app ?? githubApp
  const now = input.now ?? Date.now
  const fetcher = input.fetcher ?? fetch

  async function account(request: ApiRequest, response: ApiResponse, method: "GET" | "POST") {
    cleanUrl(request)
    requireMethod(request, method)
    if (method === "POST") requireTrustedJsonRequest(request, 2_000)
    await ipLimit(request, response)
    return requireCloudAgentsUser(request, fetcher, now())
  }

  async function bindCode(request: ApiRequest, response: ApiResponse) {
    const user = await account(request, response, "POST")
    const body = await objectBody(request)
    if (
      Object.keys(body).some((key) => !["repository", "repositoryId", "githubUserId", "defaultRef"].includes(key)) ||
      typeof body.repository !== "string" ||
      (body.defaultRef !== undefined && typeof body.defaultRef !== "string") ||
      [body.repositoryId, body.githubUserId].some(
        (id) => id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1),
      )
    )
      throw invalidRequest()
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-bind-code-account",
      identifier: user.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    json(
      response,
      200,
      await createBindCode(
        {
          account: user.id,
          repository: body.repository,
          ...(body.repositoryId === undefined ? {} : { repositoryId: String(body.repositoryId) }),
          ...(body.githubUserId === undefined ? {} : { githubUserId: String(body.githubUserId) }),
          ...(body.defaultRef === undefined ? {} : { defaultRef: body.defaultRef }),
          now: now(),
        },
        store,
      ),
    )
  }

  async function bind(request: ApiRequest, response: ApiResponse) {
    cleanUrl(request)
    requireMethod(request, "POST")
    await ipLimit(request, response)
    const { body, identity } = await githubProof(request, response, "bind", verify)
    if (
      Object.keys(body).some((key) => !["code", "workflowVersion"].includes(key)) ||
      typeof body.code !== "string" ||
      typeof body.workflowVersion !== "string" ||
      !/^[1-9]\d{0,3}$/.test(body.workflowVersion)
    )
      throw invalidRequest()
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-bind-repo",
      identifier: identity.repositoryId,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const code = await peekBindCode(body.code, identity, now(), store)
    await requireUnrevokedAccount(code.account, fetcher)
    const current = await bindingFor(identity.repositoryId, store)
    // O6's admin exception needs the App decision before the read-only takeover check.
    const checked = app.configuration().available ? await app.verifyBind(identity) : { installed: false as const }
    if (!checked.installed && !identity.refProtected && identity.ref !== code.defaultRef)
      await publicDefaultBranch(identity)
    const takeover = { adminVerified: checked.installed && checked.adminVerified, allowanceInactive: false }
    if (
      current &&
      !takeoverAllowed(current, { account: code.account, ownerId: identity.ownerId, takeover, now: now() })
    ) {
      // A disabled service says nothing about whether the previous binder's allowance is active.
      const allowance = await entitlement(current.account, { source: "github-dispatch", now: now() }, fetcher)
      takeover.allowanceInactive =
        !allowance.active && allowance.reason !== "service-off" && allowance.reason !== "source-unavailable"
      if (!takeoverAllowed(current, { account: code.account, ownerId: identity.ownerId, takeover, now: now() }))
        throw new ApiError(409, "REPO_BOUND_ELSEWHERE", "This repository is connected to another Vector account.")
    }
    await consumeGithubOidc(identity, store)
    const binding = await redeemAndBind(
      {
        code: body.code,
        account: code.account,
        current: current?.account,
        identity,
        workflowVersion: body.workflowVersion,
        takeover,
        now: now(),
      },
      store,
    )
    json(response, 200, {
      bound: true,
      repository: binding.repository,
      repositoryId: binding.repositoryId,
      generation: binding.generation,
      workflowUpdate: Number(body.workflowVersion) < Number(GithubAgents.WORKFLOW_VERSION),
    })
  }

  async function bindings(request: ApiRequest, response: ApiResponse) {
    const user = await account(request, response, "GET")
    await readLimit(request, response, user.id)
    const records = await bindingsForAccount(user.id, store)
    const allowance = await entitlement(user.id, { source: "github-dispatch", now: now() }, fetcher)
    json(response, 200, {
      bindings: records.map((binding) => ({
        ...(binding.suspended === "binder-left"
          ? {}
          : { repository: binding.repository, binder: { login: binding.binder.login } }),
        repositoryId: binding.repositoryId,
        boundAt: binding.boundAt,
        ...(binding.lastUsedAt === undefined ? {} : { lastUsedAt: binding.lastUsedAt }),
        workflowVersion: binding.workflowVersion,
        codium: allowance.active && !binding.suspended ? "ready" : "unavailable",
        ...(binding.suspended ? { suspended: binding.suspended } : {}),
      })),
    })
  }

  async function unbind(request: ApiRequest, response: ApiResponse) {
    const user = await account(request, response, "POST")
    await readLimit(request, response, user.id)
    const body = await objectBody(request)
    if (Object.keys(body).some((key) => key !== "repositoryId") || !Schema.is(Decimal)(body.repositoryId))
      throw invalidRequest()
    if (!(await revokeBinding(body.repositoryId, user.id, store)))
      throw new ApiError(403, "ACTOR_NOT_ALLOWED", "Only the account that connected this repository may disconnect it.")
    json(response, 200, { ok: true })
  }

  async function publicDefaultBranch(identity: GithubIdentity) {
    if (identity.repositoryVisibility !== "public") throw needsDefaultBranch()
    const key = `vector:cloud-agents:default-branch:${identity.repositoryId}`
    const saved = await store(["GET", key])
    const cached = saved === null ? undefined : Option.getOrUndefined(decodeBranch(saved))
    if (saved !== null && !cached) throw storeUnavailable()
    if (cached?.repository === identity.repository && cached.ownerId === identity.ownerId) {
      if (cached.defaultRef !== identity.ref) throw needsDefaultBranch()
      return
    }
    const response = await fetcher(`https://api.github.com/repos/${identity.repository}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "Vector/Cloud-Agents",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => {
      throw githubUnavailable()
    })
    if (response.status === 404) {
      await response.body?.cancel()
      throw needsDefaultBranch()
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw githubUnavailable()
    }
    const bytes = await githubResponseBytes(response)
    const details = (() => {
      try {
        return githubRecord(JSON.parse(Buffer.from(bytes).toString("utf8")))
      } catch {
        throw githubUnavailable()
      }
    })()
    const defaultRef = `refs/heads/${details.default_branch}`
    if (
      githubId(details.id) !== identity.repositoryId ||
      githubId(githubRecord(details.owner).id) !== identity.ownerId ||
      details.full_name !== identity.repository ||
      details.private !== false ||
      details.visibility !== "public" ||
      typeof details.default_branch !== "string" ||
      !Schema.is(Branch)(defaultRef) ||
      defaultRef !== identity.ref
    )
      throw needsDefaultBranch()
    if (
      (await store([
        "SET",
        key,
        JSON.stringify({ repository: identity.repository, ownerId: identity.ownerId, defaultRef }),
        "EX",
        3600,
      ])) !== "OK"
    )
      throw storeUnavailable()
  }

  return { bindCode: safe(bindCode), bind: safe(bind), bindings: safe(bindings), unbind: safe(unbind) }
}

async function ipLimit(request: ApiRequest, response: ApiResponse) {
  await enforceRateLimit(request, response, {
    scope: "cloud-agents-ip",
    limit: 120,
    windowSeconds: 300,
    requirePersistent: true,
  })
}

async function readLimit(request: ApiRequest, response: ApiResponse, account: string) {
  await enforceRateLimit(request, response, {
    scope: "cloud-agents-account-read",
    identifier: account,
    limit: 60,
    windowSeconds: 300,
    requirePersistent: true,
  })
}

async function objectBody(request: ApiRequest) {
  const body = await readJson<unknown>(request, 2_000)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest()
  return body as Record<string, unknown>
}

function cleanUrl(request: ApiRequest) {
  if (new URL(request.url ?? "/", "https://vectordev.ai").search) throw invalidRequest()
}

function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported repository connection fields.")
}

function needsDefaultBranch() {
  return new ApiError(409, "BIND_NEEDS_DEFAULT_BRANCH", "Connect this repository from its default branch.")
}

function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Repository connections are temporarily unavailable.")
}

function safe(handler: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    await handler(request, response).catch((error: unknown) => {
      if (!request.readableEnded) response.setHeader("connection", "close")
      request.resume()
      const known = error instanceof ApiError ? error : undefined
      const code = known?.code === "ABUSE_PROTECTION_UNAVAILABLE" ? "PERSISTENT_STORE_UNAVAILABLE" : known?.code
      // Authentication and entitlement helpers can mention billing; only neutral wording crosses this boundary.
      json(response, known?.statusCode ?? 503, {
        error: { code: code ?? "CLOUD_AGENTS_UNAVAILABLE", message: "This request could not be completed." },
      })
    })
  }
}

export const cloudAgentsApi = createCloudAgentsApi()
