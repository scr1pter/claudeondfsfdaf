import { createPrivateKey } from "node:crypto"
import { importPKCS8, SignJWT } from "jose"
import { ApiError } from "./http.js"
import {
  githubApiVersion,
  githubId,
  githubRecord,
  githubResponseBytes,
  githubUnavailable,
  type GithubRequest,
} from "./github-http.js"
import { githubOidcAudiences, type GithubIdentity } from "./github-oidc.js"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { parseReviewCommand } from "../../packages/core/src/review/command.js"
import { persistentStore } from "./persistent-store.js"

export const githubTokenPermissions = {
  task: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "write",
    checks: "read",
    metadata: "read",
  },
  publish: { contents: "write", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
  review: { contents: "read", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
} as const
export type GithubTokenPurpose = keyof typeof githubTokenPermissions
export type GithubTokenResult = {
  token: string
  expiresAt: string
  repositoryId: string
  repository: string
  permissions: (typeof githubTokenPermissions)[GithubTokenPurpose]
  bot: { login: string; id: number }
}
export type GithubAppConfiguration = { id: string; clientId: string; slug: string; privateKey: string }
export type GithubRunVerification = {
  job: "agent" | "review"
  commentId?: number
  pullRequest?: number
  thread: string
  bot?: boolean
  binder: { githubId: string; login: string }
  account: string
  defaultRef: string
  generation: number
}
const validationPermissions = {
  issues: "read",
  contents: "read",
  actions: "read",
  pull_requests: "read",
  checks: "read",
  metadata: "read",
} as const
const githubApi = "https://api.github.com"
const saveBinderCache =
  "if redis.call('GET', KEYS[2]) then return 'revoked' end; return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])"

export function githubAppConfiguration(
  env: Record<string, string | undefined> = process.env,
): GithubAppConfiguration | undefined {
  if (env.VECTOR_GITHUB_APP_ENABLED !== "true" || (env.VERCEL_ENV && env.VERCEL_ENV !== "production")) return undefined
  const id = env.VECTOR_GITHUB_APP_ID ?? ""
  const clientId = env.VECTOR_GITHUB_APP_CLIENT_ID ?? ""
  const slug = env.VECTOR_GITHUB_APP_SLUG ?? ""
  const privateKey = (env.VECTOR_GITHUB_APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n")
  if (
    !/^[1-9]\d{0,15}$/.test(id) ||
    BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(clientId) ||
    !/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(slug) ||
    privateKey.length > 16_384 ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)
  )
    throw notConfigured()
  return { id, clientId, slug, privateKey }
}

export function createGithubApp(
  input: {
    configuration?: () => GithubAppConfiguration | undefined
    store?: typeof persistentStore
    request?: GithubRequest
  } = {},
) {
  const configuration = input.configuration ?? githubAppConfiguration
  const request = input.request ?? fetch
  const store = input.store ?? persistentStore

  async function api(
    pathname: string,
    token?: string,
    options: { method?: string; body?: unknown; missing?: boolean } = {},
  ) {
    if (!pathname.startsWith("/") || pathname.startsWith("//")) throw githubUnavailable()
    const response = await request(`${githubApi}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "Vector/GitHub-App",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => {
      throw githubUnavailable()
    })
    if (response.status === 404 && options.missing) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw githubUnavailable()
    }
    if (response.status === 204) {
      await response.body?.cancel()
      return undefined
    }
    const bytes = await githubResponseBytes(response)
    try {
      return githubRecord(JSON.parse(Buffer.from(bytes).toString("utf8")))
    } catch {
      throw githubUnavailable()
    }
  }

  async function appJwt(config: GithubAppConfiguration) {
    const key = (() => {
      try {
        const privateKey = createPrivateKey(config.privateKey)
        if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
          throw notConfigured()
        return privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      } catch {
        throw notConfigured()
      }
    })()
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(config.clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 300)
      .sign(await importPKCS8(key, "RS256"))
      .catch(() => {
        throw notConfigured()
      })
  }

  async function revoke(token: string) {
    await api("/installation/token", token, { method: "DELETE" })
  }

  async function mint(
    jwt: string,
    installationId: string,
    identity: Pick<GithubIdentity, "repositoryId" | "ownerId"> & { repository?: string },
    permissions: Record<string, string>,
  ) {
    const result = await api(`/app/installations/${installationId}/access_tokens`, jwt, {
      method: "POST",
      body: { repository_ids: [Number(identity.repositoryId)], permissions },
    })
    const token = result?.token
    // GitHub's 2026 stateless installation tokens contain base64url/JWT separators. Never admit whitespace/headers.
    if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{20,2048}$/.test(token)) throw githubUnavailable()
    try {
      const expiresAt = result!.expires_at
      if (
        typeof expiresAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.now() ||
        Date.parse(expiresAt) > Date.now() + 3_660_000
      )
        throw githubUnavailable()
      const granted = githubRecord(result!.permissions)
      if (
        Object.keys(granted).length !== Object.keys(permissions).length ||
        Object.entries(permissions).some(([key, value]) => granted[key] !== value)
      )
        throw githubUnavailable()
      // The create response does not always include repository objects. Verify
      // actual access with the new token before it can leave the server.
      const scope = await api("/installation/repositories?per_page=2", token)
      if (scope?.total_count !== 1 || !Array.isArray(scope.repositories) || scope.repositories.length !== 1)
        throw githubUnavailable()
      const repository = githubRecord(scope.repositories[0])
      if (
        githubId(repository.id) !== identity.repositoryId ||
        (identity.repository !== undefined && repository.full_name !== identity.repository) ||
        typeof repository.full_name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.full_name) ||
        githubId(githubRecord(repository.owner).id) !== identity.ownerId
      )
        throw githubUnavailable()
      return { token, expiresAt, repository: repository.full_name }
    } catch (error) {
      await revoke(token)
      throw error
    }
  }

  async function authorize(
    identity: GithubIdentity,
    purpose?: GithubTokenPurpose,
    pullRequest?: number,
    verification?: GithubRunVerification | { job: "bind" },
  ) {
    const config = configuration()
    if (!config) throw notConfigured()
    const jwt = await appJwt(config)
    const metadata = await api("/app", jwt)
    if (githubId(metadata?.id) !== config.id || metadata?.slug !== config.slug) throw notConfigured()
    const root = `/repos/${identity.repository}`
    const installation = await api(`${root}/installation`, jwt, { missing: true })
    if (!installation)
      return { installed: false as const, installUrl: installUrl(config), repositoryId: identity.repositoryId }
    if (
      githubId(installation.app_id) !== config.id ||
      githubId(githubRecord(installation.account).id) !== identity.ownerId ||
      installation.suspended_at !== null
    )
      throw denied("REPOSITORY_MISMATCH", "This repository's App installation is unavailable.")
    const installationId = githubId(installation.id)
    const validation = await mint(jwt, installationId, identity, validationPermissions)
    let verified: { defaultRef: string; adminVerified: boolean; binder: "ok" | "binder-left" } | undefined
    try {
      const repository = await api(root, validation.token)
      if (
        githubId(repository?.id) !== identity.repositoryId ||
        repository?.full_name !== identity.repository ||
        githubId(githubRecord(repository.owner).id) !== identity.ownerId ||
        repository.archived === true ||
        repository.disabled === true
      )
        throw denied("REPOSITORY_MISMATCH", "The repository identity no longer matches this workflow.")
      const review = verification && "binder" in verification && identity.event === "pull_request_review_comment"
      const defaultRef = `refs/heads/${repository.default_branch}`
      if (
        typeof repository.default_branch !== "string" ||
        (verification && "binder" in verification && verification.defaultRef !== defaultRef) ||
        (!review && identity.ref !== defaultRef)
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "Use the Vector workflow on the repository's current default branch.")
      const pr = review ? await api(`${root}/pulls/${githubId(verification.pullRequest)}`, validation.token) : undefined
      if (
        review &&
        (githubId(pr?.number) !== String(verification.pullRequest) ||
          identity.pullRequest !== verification.pullRequest ||
          pr?.state !== "open" ||
          githubId(githubRecord(githubRecord(pr?.base).repo).id) !== identity.repositoryId ||
          githubId(githubRecord(githubRecord(pr?.head).repo).id) !== identity.repositoryId)
      )
        throw denied("EVENT_NOT_ALLOWED", "This pull request cannot start a Vector run.")
      const head = pr ? githubRecord(pr.head) : undefined
      const base = pr ? githubRecord(pr.base) : undefined
      if (
        review &&
        (pr?.merge_commit_sha !== identity.sha ||
          head?.ref !== identity.headRef ||
          base?.ref !== identity.baseRef ||
          typeof head?.sha !== "string" ||
          !/^[a-f0-9]{40}$/.test(head.sha))
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "The pull request no longer matches this workflow.")
      const expectedSha = head?.sha ?? identity.sha
      const expectedBranch = head?.ref ?? repository.default_branch
      if (review) {
        const file = `${root}/contents/${GithubAgents.WORKFLOW_FILE}?ref=`
        const source = await api(file + encodeURIComponent(identity.workflowSha), validation.token)
        const trusted = await api(file + encodeURIComponent(defaultRef), validation.token)
        if (
          source?.type !== "file" ||
          trusted?.type !== "file" ||
          typeof source.sha !== "string" ||
          !/^[a-f0-9]{40}$/.test(source.sha) ||
          source.sha !== trusted.sha
        )
          throw denied("WORKFLOW_NOT_TRUSTED", "The pull request changed the Vector workflow.")
      }
      const run = await api(`${root}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`, validation.token)
      if (
        githubId(run?.id) !== identity.runId ||
        githubId(run?.run_attempt) !== identity.runAttempt ||
        run?.event !== identity.event ||
        run?.head_sha !== expectedSha ||
        run?.head_branch !== expectedBranch ||
        run?.status !== "in_progress" ||
        githubId(githubRecord(run.repository).id) !== identity.repositoryId ||
        githubId(githubRecord(run.head_repository).id) !== identity.repositoryId ||
        run.path !== ".github/workflows/vector.yml"
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "This workflow run is not an active trusted Vector job.")
      const workflow = await api(`${root}/actions/workflows/${githubId(run.workflow_id)}`, validation.token)
      if (
        githubId(workflow?.id) !== githubId(run.workflow_id) ||
        workflow?.path !== ".github/workflows/vector.yml" ||
        workflow?.state !== "active"
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "The default-branch Vector workflow is not active.")
      const actor = githubRecord(run.actor)
      const bot =
        verification && "bot" in verification && verification.bot === true
          ? await api(`/users/${config.slug}%5Bbot%5D`)
          : undefined
      if (
        githubId(actor.id) !== identity.actorId ||
        actor.login !== identity.actor ||
        (bot
          ? identity.event !== "workflow_dispatch" ||
            !identity.actorIsBot ||
            actor.type !== "Bot" ||
            bot.type !== "Bot" ||
            bot.login !== `${config.slug}[bot]` ||
            actor.login !== bot.login ||
            githubId(bot.id) !== identity.actorId
          : actor.type !== "User")
      )
        throw denied("ACTOR_NOT_ALLOWED", "The workflow actor is not authorized for App credentials.")
      let adminVerified = false
      for (const user of [actor, githubRecord(run.triggering_actor)]) {
        if (bot && user.type === "Bot" && user.login === bot.login && githubId(user.id) === identity.actorId) continue
        if (
          user.type !== "User" ||
          typeof user.login !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)
        )
          throw denied("ACTOR_NOT_ALLOWED", "Only authorized people can trigger elevated Vector jobs.")
        const permission = await api(`${root}/collaborators/${user.login}/permission`, validation.token)
        const checked = githubRecord(permission?.user)
        if (
          githubId(checked.id) !== githubId(user.id) ||
          checked.login !== user.login ||
          !["admin", "maintain", "write"].includes(String(permission?.permission))
        )
          throw denied("ACTOR_NOT_ALLOWED", "The workflow actor no longer has repository write permission.")
        if (githubId(user.id) === identity.actorId && permission?.permission === "admin") adminVerified = true
      }
      const jobs: Record<string, unknown>[] = []
      for (let page = 1; page <= 5; page++) {
        const result = await api(
          `${root}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100&page=${page}`,
          validation.token,
        )
        if (
          !Array.isArray(result?.jobs) ||
          !Number.isSafeInteger(result.total_count) ||
          Number(result.total_count) > 500 ||
          result.jobs.length > 100
        )
          throw denied("WORKFLOW_NOT_TRUSTED", "The workflow job list cannot be verified.")
        jobs.push(...result.jobs.map(githubRecord))
        if (jobs.length >= Number(result.total_count)) break
      }
      const matching = jobs.filter(
        (job) => job.check_run_url === `${githubApi}${root}/check-runs/${identity.checkRunId}`,
      )
      const job = matching[0]
      const profile = Object.entries(GithubAgents.JOB).find(([, name]) => name === job?.name)?.[0]
      const expected = verification?.job ?? (purpose === "task" ? "legacyTask" : purpose)
      if (
        matching.length !== 1 ||
        !profile ||
        (expected ? profile !== expected : !["legacyTask", "review", "publish"].includes(profile)) ||
        job?.status !== "in_progress" ||
        githubId(job.run_id) !== identity.runId ||
        job.head_sha !== expectedSha ||
        job.head_branch !== expectedBranch
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "The identity token does not belong to the expected active Vector job.")
      if (!Array.isArray(run.pull_requests) || run.pull_requests.length > 20) throw githubUnavailable()
      const numbers = new Set(run.pull_requests.map((pr) => Number(githubId(githubRecord(pr).number))))
      if (pullRequest !== undefined) numbers.add(pullRequest)
      for (const number of numbers) {
        const pr = await api(`${root}/pulls/${number}`, validation.token)
        if (
          githubId(pr?.number) !== String(number) ||
          githubId(githubRecord(githubRecord(pr?.base).repo).id) !== identity.repositoryId ||
          githubId(githubRecord(githubRecord(pr?.head).repo).id) !== identity.repositoryId
        )
          throw denied("EVENT_NOT_ALLOWED", "Fork pull requests use the existing GitHub-token review path.")
      }
      if (verification && "binder" in verification) {
        await verifyThread(identity, verification, root, validation.token, config.slug)
        verified = {
          defaultRef,
          adminVerified,
          binder: await verifyBinder(identity, verification, root, validation.token),
        }
      }
      if (verification?.job === "bind") verified = { defaultRef, adminVerified, binder: "ok" }
    } finally {
      // Never retain the private-repository validation credential in the server.
      // Failure to revoke stops issuance of the final write credential.
      await revoke(validation.token)
    }
    const bot = await api(`/users/${config.slug}%5Bbot%5D`)
    if (bot?.login !== `${config.slug}[bot]` || bot?.type !== "Bot") throw notConfigured()
    return {
      installed: true as const,
      verified,
      repositoryId: identity.repositoryId,
      repository: identity.repository,
      installUrl: installUrl(config),
      installationId,
      jwt,
      bot: { login: bot.login, id: Number(githubId(bot.id)) },
    }
  }

  async function verifyThread(
    identity: GithubIdentity,
    options: GithubRunVerification,
    root: string,
    token: string,
    slug: string,
  ) {
    const review = identity.event === "pull_request_review_comment"
    const comment = identity.event === "issue_comment" || review
    if (!comment && identity.event !== "issues") return
    if (!/^[1-9]\d{0,9}$/.test(options.thread))
      throw denied("EVENT_NOT_ALLOWED", "The conversation does not match this run.")
    const item = await api(
      comment
        ? `${root}/${review ? "pulls" : "issues"}/comments/${githubId(options.commentId)}`
        : `${root}/issues/${options.thread}`,
      token,
    )
    if (!item) throw githubUnavailable()
    const author = githubRecord(item.user)
    if (author.type !== "User" || githubId(author.id) !== identity.actorId || author.login !== identity.actor)
      throw denied("ACTOR_NOT_ALLOWED", "The conversation author is not the workflow actor.")
    if (
      comment
        ? githubId(item.id) !== String(options.commentId) ||
          item[review ? "pull_request_url" : "issue_url"] !==
            `${githubApi}${root}/${review ? "pulls" : "issues"}/${options.thread}` ||
          (review && options.thread !== String(options.pullRequest))
        : githubId(item.number) !== options.thread
    )
      throw denied("EVENT_NOT_ALLOWED", "The conversation does not match this run.")
    // issue_comment OIDC does not say whether the thread is a PR; discover it from GitHub, never from the body.
    const issue = comment && !review ? await api(`${root}/issues/${options.thread}`, token) : item
    if (!review && issue?.pull_request) {
      const pr = await api(`${root}/pulls/${options.thread}`, token)
      if (
        githubId(pr?.number) !== options.thread ||
        githubId(githubRecord(githubRecord(pr?.base).repo).id) !== identity.repositoryId ||
        githubId(githubRecord(githubRecord(pr?.head).repo).id) !== identity.repositoryId
      )
        throw denied("EVENT_NOT_ALLOWED", "This pull request cannot start a Vector run.")
    }
    const texts = comment ? [item.body] : [item.title, item.body]
    const kinds = texts
      .filter((text): text is string => typeof text === "string")
      .map((text) => parseReviewCommand(text, GithubAgents.mentions(slug)).kind)
    if (comment ? !kinds.some((kind) => kind !== "none") : !kinds.includes("task"))
      throw denied("COMMENT_CHANGED", "The conversation no longer requests Vector work.")
  }

  async function verifyBinder(
    identity: GithubIdentity,
    options: GithubRunVerification,
    root: string,
    token: string,
  ): Promise<"ok" | "binder-left"> {
    const key = `vector:cloud-agents:binder-ok:${identity.repositoryId}`
    const value = JSON.stringify({
      account: options.account,
      githubId: githubId(options.binder.githubId),
      generation: options.generation,
    })
    const read = await Promise.resolve()
      .then(() => store(["GET", key]))
      .catch(() => {
        throw storeUnavailable()
      })
    if (read !== null && typeof read !== "string") throw storeUnavailable()
    if (read === value) return "ok"
    if (read !== null) {
      const cached: unknown = (() => {
        try {
          return JSON.parse(read)
        } catch {
          throw storeUnavailable()
        }
      })()
      if (
        !cached ||
        typeof cached !== "object" ||
        Array.isArray(cached) ||
        Object.keys(cached).length !== ("account" in cached ? 3 : 2) ||
        ("account" in cached &&
          (typeof cached.account !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cached.account))) ||
        !("githubId" in cached) ||
        !("generation" in cached) ||
        typeof cached.githubId !== "string" ||
        !/^[1-9]\d{0,15}$/.test(cached.githubId) ||
        typeof cached.generation !== "number" ||
        !Number.isSafeInteger(cached.generation) ||
        cached.generation < 1
      )
        throw storeUnavailable()
    }
    // Legacy caches have no account attribution. Never reuse them; a fresh successful check writes the new format.
    const user = await api(`/user/${options.binder.githubId}`, token, { missing: true })
    if (!user) return "binder-left"
    if (
      githubId(user.id) !== options.binder.githubId ||
      user.type !== "User" ||
      typeof user.login !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)
    )
      throw githubUnavailable()
    const permission = await api(`${root}/collaborators/${user.login}/permission`, token, { missing: true })
    if (!permission) return "binder-left"
    const checked = githubRecord(permission.user)
    if (githubId(checked.id) !== options.binder.githubId || checked.login !== user.login) throw githubUnavailable()
    if (!["write", "maintain", "admin"].includes(String(permission.permission))) return "binder-left"
    const saved = await Promise.resolve()
      .then(() => store(["EVAL", saveBinderCache, "2", key, `vector:cli-revoked:${options.account}`, value, 3600]))
      .catch(() => {
        throw storeUnavailable()
      })
    if (saved !== "OK") throw storeUnavailable()
    return "ok"
  }

  return {
    configuration() {
      const config = configuration()
      return config ? { available: true, installUrl: installUrl(config) } : { available: false }
    },
    async dispatch(
      repositoryId: string,
      input: { ref: string; prompt: string; ticket: string; ownerId: string; installationId: string },
    ) {
      if (
        !/^[1-9]\d{0,15}$/.test(repositoryId) ||
        !Number.isSafeInteger(Number(repositoryId)) ||
        !/^refs\/heads\/[^\s:~^?*\[\\]{1,240}$/.test(input.ref) ||
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        !/^vtk_[A-Za-z0-9_-]{43}$/.test(input.ticket)
      )
        throw new ApiError(400, "INVALID_REQUEST", "Send only a supported workflow dispatch.")
      const config = configuration()
      if (!config) throw notConfigured()
      const jwt = await appJwt(config)
      const metadata = await api("/app", jwt)
      if (githubId(metadata?.id) !== config.id || metadata?.slug !== config.slug) throw notConfigured()
      // The installation id came from App-backed bind, never a caller body or broad installation enumeration.
      if (!/^[1-9]\d{0,15}$/.test(input.installationId) || !Number.isSafeInteger(Number(input.installationId)))
        throw new ApiError(400, "INVALID_REQUEST", "A verified installation is required.")
      const installation = await api(`/app/installations/${input.installationId}`, jwt, { missing: true })
      if (!installation)
        throw new ApiError(404, "APP_NOT_INSTALLED", "Reconnect this repository with the Vector GitHub App.")
      if (
        githubId(installation.id) !== input.installationId ||
        githubId(installation.app_id) !== config.id ||
        githubId(githubRecord(installation.account).id) !== input.ownerId ||
        installation.suspended_at !== null
      )
        throw denied("REPOSITORY_MISMATCH", "This repository's App installation is unavailable.")
      // The restricted token's repository list supplies the current name after a rename and proves id + owner.
      const credential = await mint(
        jwt,
        input.installationId,
        { repositoryId, ownerId: input.ownerId },
        { actions: "write", metadata: "read" },
      )
      const root = `/repos/${credential.repository}`
      try {
        await api(`${root}/actions/workflows/vector.yml/dispatches`, credential.token, {
          method: "POST",
          body: { ref: input.ref, inputs: { mode: "task", prompt: input.prompt, ticket: input.ticket } },
        })
      } finally {
        await revoke(credential.token)
      }
    },
    async verifyRun(identity: GithubIdentity, options: GithubRunVerification) {
      if (
        identity.audience !== githubOidcAudiences.mint ||
        !["agent", "review"].includes(options.job) ||
        !GithubAgents.THREAD_PATTERN.test(options.thread) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.account) ||
        !Number.isSafeInteger(options.generation) ||
        options.generation < 1
      )
        throw denied("WORKFLOW_NOT_TRUSTED", "A verified Vector run identity is required.")
      const authorized = await authorize(identity, undefined, options.pullRequest, options)
      if (!authorized.installed) return { installed: false as const }
      return { installed: true as const, binder: authorized.verified!.binder }
    },
    async verifyBind(identity: GithubIdentity) {
      if (identity.audience !== githubOidcAudiences.bind || identity.event !== "workflow_dispatch")
        throw denied("EVENT_NOT_ALLOWED", "A verified binding dispatch is required.")
      const authorized = await authorize(identity, undefined, undefined, { job: "bind" })
      if (!authorized.installed) return { installed: false as const }
      return {
        installed: true as const,
        defaultRef: authorized.verified!.defaultRef,
        adminVerified: authorized.verified!.adminVerified,
        installationId: authorized.installationId,
      }
    },
    async installation(identity: GithubIdentity) {
      const authorized = await authorize(identity)
      return {
        installed: authorized.installed,
        repositoryId: identity.repositoryId,
        installUrl: authorized.installUrl,
        ...(!authorized.installed ? { retryAfterSeconds: 10 } : {}),
      }
    },
    async token(
      identity: GithubIdentity,
      purpose: GithubTokenPurpose,
      pullRequest: number | undefined,
      beforeMint: () => Promise<void>,
    ): Promise<GithubTokenResult> {
      const authorized = await authorize(identity, purpose, pullRequest)
      if (!authorized.installed)
        throw new ApiError(404, "APP_NOT_INSTALLED", "Install the Vector GitHub App on this repository first.")
      await beforeMint()
      const token = await mint(authorized.jwt, authorized.installationId, identity, githubTokenPermissions[purpose])
      return {
        ...token,
        repositoryId: identity.repositoryId,
        repository: identity.repository,
        permissions: githubTokenPermissions[purpose],
        bot: authorized.bot,
      }
    },
  }
}

function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected GitHub services are temporarily unavailable.")
}

function installUrl(config: GithubAppConfiguration) {
  return `https://github.com/apps/${config.slug}/installations/new`
}
function denied(code: string, message: string) {
  return new ApiError(403, code, message)
}
function notConfigured() {
  return new ApiError(
    503,
    "GITHUB_APP_NOT_CONFIGURED",
    "Vector GitHub App authentication is not enabled or configured.",
  )
}

export const githubApp = createGithubApp()
