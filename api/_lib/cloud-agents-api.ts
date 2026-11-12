import { Option, Schema } from "effect"
import { randomBytes } from "node:crypto"
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
  suspendBinding,
  touchBinding,
} from "./cloud-agents-binding.js"
import { cloudAgentEntitlement, cloudAgentRevokedBefore } from "./cloud-agents-entitlement.js"
import { liveRun, releaseRun, reportRun, reserveBoundRun, settleRecordedRun } from "./cloud-agents-ledger.js"
import { mintRunToken, requireRunToken, requireSettlementToken } from "./cloud-agents-run-token.js"
import { listCloudRuns, recordRunStart } from "./cloud-agents-runs.js"
import { peekRunTicket } from "./cloud-agents-start.js"
import { githubProof } from "./github-api.js"
import { githubApp, type createGithubApp } from "./github-app.js"
import { githubApiVersion, githubId, githubRecord, githubResponseBytes, githubUnavailable } from "./github-http.js"
import { consumeGithubOidc, verifyGithubOidc, type GithubIdentity } from "./github-oidc.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { requireUnrevokedAccount } from "./revocation.js"
import { cloudRunArtifactKey } from "./cloud-agents-artifact.js"

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
    revokedBefore?: typeof cloudAgentRevokedBefore
    app?: ReturnType<typeof createGithubApp>
    now?: () => number
    fetcher?: typeof fetch
  } = {},
) {
  const verify = input.verify ?? verifyGithubOidc
  const store = input.store ?? persistentStore
  const entitlement = input.entitlement ?? cloudAgentEntitlement
  const revokedBefore = input.revokedBefore ?? cloudAgentRevokedBefore
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
        ...(checked.installed ? { installationId: checked.installationId } : {}),
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

  async function runs(request: ApiRequest, response: ApiResponse) {
    const user = await account(request, response, "GET")
    await readLimit(request, response, user.id)
    json(response, 200, { runs: await listCloudRuns(user.id, {}, store) })
  }

  async function mint(request: ApiRequest, response: ApiResponse) {
    cleanUrl(request)
    requireMethod(request, "POST")
    const { body, identity } = await githubProof(request, response, "mint", verify)
    if (
      Object.keys(body).some(
        (key) => !["purpose", "thread", "workflowVersion", "commentId", "pullRequest", "ticket"].includes(key),
      ) ||
      (body.purpose !== "task" && body.purpose !== "review") ||
      typeof body.thread !== "string" ||
      !GithubAgents.THREAD_PATTERN.test(body.thread) ||
      typeof body.workflowVersion !== "string" ||
      !/^[1-9]\d{0,3}$/.test(body.workflowVersion) ||
      [body.commentId, body.pullRequest].some(
        (id) => id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1),
      ) ||
      (body.ticket !== undefined && (typeof body.ticket !== "string" || body.ticket.length > 256))
    )
      throw invalidRequest()
    if (Number(body.workflowVersion) < 3)
      throw new ApiError(426, "WORKFLOW_UPDATE_REQUIRED", "Update this repository's Vector workflow.")
    if (identity.runnerEnvironment !== "github-hosted")
      throw new ApiError(403, "RUNNER_NOT_SUPPORTED", "Use one of GitHub’s runners.")
    const binding = await bindingFor(identity.repositoryId, store)
    if (!binding) throw new ApiError(404, "REPO_NOT_BOUND", "This repository is not connected.")
    await requireUnrevokedAccount(binding.account, fetcher).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "CLI_TOKEN_INVALID")
        throw new ApiError(404, "REPO_NOT_BOUND", "This repository is not connected.")
      throw error
    })
    if (binding.ownerId !== identity.ownerId) await suspendBinding(binding, "transferred", store)
    if (binding.suspended || binding.ownerId !== identity.ownerId)
      throw new ApiError(409, "BINDING_SUSPENDED", "Connect this repository again.")
    if (
      !["issue_comment", "issues", "pull_request_review_comment", "workflow_dispatch", "schedule"].includes(
        identity.event,
      )
    )
      throw new ApiError(403, "EVENT_NOT_ALLOWED", "This event cannot start a run.")
    if (identity.event !== "pull_request_review_comment" && identity.ref !== binding.defaultRef)
      throw new ApiError(403, "WORKFLOW_NOT_TRUSTED", "Use the repository's default workflow.")
    const rid = GithubAgents.runId(identity.repositoryId, identity.runId, identity.runAttempt, identity.checkRunId)
    const config = app.configuration()
    const slug = config.available ? GithubAgents.slugFromInstallUrl(config.installUrl) : undefined
    const bot =
      identity.actorIsBot && !!slug && identity.actor === `${slug}[bot]` && identity.event === "workflow_dispatch"
    if ((identity.actorIsBot && !bot) || (!bot && body.ticket !== undefined))
      throw new ApiError(403, "ACTOR_NOT_ALLOWED", "This actor cannot start a run.")
    const ticket = bot ? await peekRunTicket(body.ticket, identity, binding, { app, store, now }) : undefined
    const previous = bot && !ticket ? await liveRun(binding.account, rid, store) : undefined
    const renewal =
      previous &&
      previous.gen === binding.generation &&
      previous.repo === identity.repositoryId &&
      previous.src === "github-dispatch" &&
      previous.triggerSource !== undefined &&
      previous.triggerPurpose !== undefined
        ? { jti: previous.jti, trigger: { source: previous.triggerSource, purpose: previous.triggerPurpose } }
        : undefined
    if (bot && !ticket && !renewal) throw new ApiError(403, "ACTOR_NOT_ALLOWED", "This actor cannot start a run.")
    const trigger = ticket ? { source: ticket.source, purpose: ticket.purpose } : renewal?.trigger
    const checked = app.configuration().available
      ? await app.verifyRun(identity, {
          job: body.purpose === "review" ? "review" : "agent",
          thread: body.thread,
          ...(typeof body.commentId === "number" ? { commentId: body.commentId } : {}),
          ...(typeof body.pullRequest === "number" ? { pullRequest: body.pullRequest } : {}),
          binder: binding.binder,
          account: binding.account,
          defaultRef: binding.defaultRef,
          generation: binding.generation,
          ...(bot ? { bot: true } : {}),
        })
      : { installed: false as const }
    if (bot && !checked.installed) throw new ApiError(403, "ACTOR_NOT_ALLOWED", "This actor cannot start a run.")
    if (checked.installed && checked.binder === "binder-left") {
      await suspendBinding(binding, "binder-left", store)
      throw new ApiError(409, "BINDING_SUSPENDED", "Connect this repository again.")
    }
    if (!checked.installed && identity.event === "pull_request_review_comment")
      throw new ApiError(403, "EVENT_NEEDS_APP", "Use a PR conversation comment.")
    const source =
      identity.event === "schedule"
        ? "github-schedule"
        : identity.event === "workflow_dispatch"
          ? "github-dispatch"
          : "github-comment"
    const purpose =
      source === "github-schedule"
        ? "scheduled"
        : trigger
          ? trigger.purpose === "review"
            ? "review"
            : "task"
          : body.purpose
    const at = now()
    const allowance = await entitlement(binding.account, { source, now: at }, fetcher)
    if (!allowance.active) {
      if (allowance.reason === "service-off")
        throw new ApiError(503, "MODEL_PLANS_DISABLED", "Cloud agents are unavailable.")
      if (allowance.reason === "source-unavailable")
        throw new ApiError(403, "CLOUD_AGENTS_SOURCE_UNAVAILABLE", "This source is unavailable.")
      throw new ApiError(403, "BINDING_UNAVAILABLE", "Codium is unavailable for this repository.")
    }
    if (source === "github-schedule" && allowance.limits.scheduledPerDay === 0)
      throw new RunRefusal(403, "CODIUM_PERK_REQUIRED", { perk: "scheduled" })
    await ipLimit(request, response)
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-mint-job",
      identifier: rid,
      limit: 30,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-mint-repo",
      identifier: identity.repositoryId,
      limit: 120,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    await consumeGithubOidc(identity, store)
    const jti = randomBytes(16).toString("base64url")
    const reservedAt = now()
    const reserved = await reserveBoundRun(
      {
        account: binding.account,
        rid,
        repositoryId: identity.repositoryId,
        thread: body.thread,
        generation: binding.generation,
        jti,
        source,
        purpose,
        allowance,
        now: reservedAt,
        ...(trigger ? { trigger } : {}),
        ...(ticket ? { consumeKey: ticket.key } : {}),
        ...(renewal ? { renewalJti: renewal.jti } : {}),
      },
      store,
    )
    if (!reserved.ok) {
      if ("refusal" in reserved) throw new ApiError(403, "ACTOR_NOT_ALLOWED", "This actor cannot start a run.")
      throw new RunRefusal(429, "MODEL_PLAN_RUN_LIMIT", { limit: reserved.limit })
    }
    const token = await (async () => {
      const signed = mintRunToken({
        sub: binding.account,
        rid,
        repo: identity.repositoryId,
        thr: reserved.thread,
        gen: binding.generation,
        src: reserved.source,
        pur: reserved.purpose,
        epoch: reserved.epoch,
        dl: reserved.deadline,
        iat: reservedAt,
        jti,
        cs: allowance.limits.runCeilingShare,
      })
      await touchBinding(identity.repositoryId, reservedAt, store)
      await recordRunStart(
        {
          account: binding.account,
          generation: binding.generation,
          jti,
          rid,
          thread: reserved.thread,
          repository: identity.repository,
          repositoryId: identity.repositoryId,
          runId: identity.runId,
          event: identity.event,
          source: reserved.source,
          purpose: reserved.purpose,
          startedAt: reserved.startedAt,
          actor: { login: identity.actor, id: identity.actorId },
          ...(reserved.trigger ? { trigger: reserved.trigger } : {}),
        },
        store,
      )
      return signed
    })().catch(async (error: unknown) => {
      if (!reserved.renewed) await releaseRun(binding.account, rid, { ...reserved, jti }, store)
      throw error
    })
    console.info("Vector cloud-agents mint", {
      repositoryId: identity.repositoryId,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      checkRunId: identity.checkRunId,
      source: reserved.source,
      purpose: reserved.purpose,
    })
    json(response, 200, {
      token: token.token,
      runId: rid,
      deadline: token.deadline,
      heartbeatSeconds: GithubAgents.HEARTBEAT_SECONDS,
      idleSeconds: GithubAgents.IDLE_SECONDS,
    })
  }

  async function heartbeat(request: ApiRequest, response: ApiResponse) {
    cleanUrl(request)
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-heartbeat-ip",
      limit: 300,
      windowSeconds: 300,
      requirePersistent: true,
    })
    const body = await objectBody(request)
    if (Object.keys(body).some((key) => key !== "state") || (body.state !== "starting" && body.state !== "running"))
      throw invalidRequest()
    const at = now()
    const claims = await requireRunToken(request, { allowAfterDeadline: true }, { now: at, store, revokedBefore })
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-heartbeat-run",
      identifier: claims.rid,
      limit: 90,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const reported = await reportRun(claims.sub, claims.rid, claims, at, store)
    if (!reported.live) throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized.")
    json(response, 200, { ok: true, stop: at >= reported.deadline - GithubAgents.STOP_MARGIN_SECONDS * 1000 })
  }

  async function settle(request: ApiRequest, response: ApiResponse) {
    cleanUrl(request)
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await ipLimit(request, response)
    const body = await objectBody(request)
    if (
      Object.keys(body).some((key) => key !== "outcome") ||
      !Schema.is(Schema.Literals(GithubAgents.OUTCOME))(body.outcome)
    )
      throw invalidRequest()
    const at = now()
    const claims = await requireSettlementToken(request, { now: at, store, revokedBefore })
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-settle-run",
      identifier: claims.rid,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    await settleRecordedRun(claims.sub, claims.rid, claims, { outcome: body.outcome, now: at }, store)
    json(response, 200, { ok: true })
  }

  async function artifactKey(request: ApiRequest, response: ApiResponse) {
    cleanUrl(request)
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await ipLimit(request, response)
    const body = await objectBody(request)
    if (Object.keys(body).some((key) => key !== "thread") || typeof body.thread !== "string") throw invalidRequest()
    const claims = await requireRunToken(request, { allowAfterDeadline: false }, { now: now(), store, revokedBefore })
    if (body.thread !== claims.thr) throw invalidRequest()
    await enforceRateLimit(request, response, {
      scope: "cloud-agents-artifact-key-run",
      identifier: claims.rid,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    json(response, 200, cloudRunArtifactKey(claims))
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

  return {
    bindCode: safe(bindCode),
    bind: safe(bind),
    bindings: safe(bindings),
    unbind: safe(unbind),
    runs: safe(runs),
    mint: safe(mint),
    heartbeat: safe(heartbeat),
    settle: safe(settle),
    artifactKey: safe(artifactKey),
  }
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

class RunRefusal extends ApiError {
  constructor(
    status: number,
    code: "MODEL_PLAN_RUN_LIMIT" | "CODIUM_PERK_REQUIRED",
    readonly fields: { limit: "hours" | "at-once" | "scheduled" } | { perk: "scheduled" },
  ) {
    super(status, code, "This request could not be completed.")
  }
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
        error: {
          code: code ?? "CLOUD_AGENTS_UNAVAILABLE",
          message: "This request could not be completed.",
          ...(known instanceof RunRefusal ? known.fields : {}),
        },
      })
    })
  }
}

export const cloudAgentsApi = createCloudAgentsApi()
