import { createHash } from "node:crypto"
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { ApiError } from "./http.js"
import { githubId, githubResponseBytes, githubUnavailable, type GithubRequest } from "./github-http.js"
import { persistentStore } from "./persistent-store.js"

export const githubOidcIssuer = "https://token.actions.githubusercontent.com"
export const githubOidcJwks = `${githubOidcIssuer}/.well-known/jwks`
export const githubOidcAudiences = {
  token: "https://vectordev.ai/api/github/token",
  installation: "https://vectordev.ai/api/github/installation",
  mint: GithubAgents.AUDIENCE.mint,
  bind: GithubAgents.AUDIENCE.bind,
} as const
export type GithubOidcPurpose = keyof typeof githubOidcAudiences

// The events each audience takes (spec 2.10). The token and installation lists are the v2 App's, unchanged.
const appEvents = ["issue_comment", "issues", "workflow_dispatch", "schedule"]
const audienceEvents: Record<GithubOidcPurpose, string[]> = {
  token: appEvents,
  installation: appEvents,
  mint: [...appEvents, "pull_request_review_comment"],
  bind: ["workflow_dispatch"],
}
const humanActor = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
// A GitHub App's bot login, `<slug>[bot]`, with the App slug's own pattern.
const botActor = /^[a-z0-9][a-z0-9-]{0,98}\[bot\]$/
// A branch name as a ref may carry it after refs/heads/.
const branchName = /^[^\s:~^?*\[\\]{1,240}$/

export function createGithubOidcVerifier(request: GithubRequest = fetch) {
  const keys = createRemoteJWKSet(new URL(githubOidcJwks), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    [customFetch]: async (url, init) => {
      if (String(url) !== githubOidcJwks) throw githubUnavailable()
      const response = await request(githubOidcJwks, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {
        throw githubUnavailable()
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw githubUnavailable()
      }
      return new Response(await githubResponseBytes(response, 64_000), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  return async (token: string, purpose: GithubOidcPurpose) => {
    if (token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw oidcInvalid()
    const header = (() => {
      try {
        return decodeProtectedHeader(token)
      } catch {
        throw oidcInvalid()
      }
    })()
    if (
      header.alg !== "RS256" ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(header.kid) ||
      Object.keys(header).some((key) => !["alg", "typ", "kid"].includes(key))
    )
      throw oidcInvalid()
    const verified = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: githubOidcIssuer,
      audience: githubOidcAudiences[purpose],
      typ: "JWT",
      requiredClaims: ["exp", "iat", "nbf", "jti", "sub"],
      maxTokenAge: 300,
      clockTolerance: 30,
    }).catch((error: unknown) => {
      if (error instanceof ApiError) throw error
      throw oidcInvalid()
    })
    const payload = verified.payload
    const now = Math.floor(Date.now() / 1000)
    if (
      payload.aud !== githubOidcAudiences[purpose] ||
      !Number.isInteger(payload.exp) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.nbf) ||
      payload.exp! <= now ||
      payload.iat! < now - 300 ||
      payload.iat! > now + 30 ||
      payload.nbf! > now + 30 ||
      payload.exp! - payload.iat! > 600 ||
      payload.exp! <= payload.iat! ||
      payload.environment !== undefined ||
      // A top-level workflow's job claims name the workflow itself. Anything else (a reusable workflow, or one claim
      // alone) is refused here, against the raw claims, before workflow_ref and workflow_sha are read below.
      !(
        (payload.job_workflow_ref === undefined && payload.job_workflow_sha === undefined) ||
        (typeof payload.job_workflow_ref === "string" &&
          payload.job_workflow_ref === payload.workflow_ref &&
          typeof payload.job_workflow_sha === "string" &&
          payload.job_workflow_sha === payload.workflow_sha)
      )
    )
      throw oidcInvalid()
    const repository = claim(payload.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
    const owner = claim(payload.repository_owner, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
    if (repository.split("/")[0] !== owner) throw oidcInvalid()
    const event = claim(payload.event_name, /^[a-z_]{1,80}$/)
    // Only a mint takes a review comment, whose ref is the pull request's merge ref.
    const review = purpose === "mint" && event === "pull_request_review_comment"
    // Only a mint takes a bot, and only for a dispatch: the mint then requires Vector's App bot with a ticket (2.8).
    const actorIsBot =
      purpose === "mint" &&
      event === "workflow_dispatch" &&
      typeof payload.actor === "string" &&
      botActor.test(payload.actor)
    const ref = claim(
      payload.ref,
      review ? /^refs\/pull\/[1-9]\d{0,9}\/merge$/ : /^refs\/heads\/[^\s:~^?*\[\\]{1,240}$/,
    )
    // Only mint and bind read the claims 2.10 adds, so only they refuse a malformed one. Token and installation record
    // it as absent and accept exactly what they accepted before.
    const strict = purpose === "mint" || purpose === "bind"
    const runnerEnvironment = addedClaim(payload.runner_environment, /^[a-z][a-z0-9-]{0,39}$/, strict)
    if (purpose === "mint" && runnerEnvironment === undefined) throw oidcInvalid()
    const visibility = addedClaim(payload.repository_visibility, /^(?:public|private|internal)$/, strict)
    const identity = {
      repository,
      repositoryId: claimId(payload.repository_id),
      owner,
      ownerId: claimId(payload.repository_owner_id),
      actor: claim(payload.actor, actorIsBot ? botActor : humanActor),
      actorIsBot,
      actorId: claimId(payload.actor_id),
      runId: claimId(payload.run_id),
      runAttempt: claimId(payload.run_attempt),
      checkRunId: claimId(payload.check_run_id),
      sha: claim(payload.sha, /^[a-f0-9]{40}$/),
      workflowSha: claim(payload.workflow_sha, /^[a-f0-9]{40}$/),
      ref,
      workflowRef: claim(payload.workflow_ref, /^[^\s]{1,512}$/),
      jobWorkflowRef: typeof payload.job_workflow_ref === "string" ? payload.job_workflow_ref : undefined,
      event,
      subject: claim(payload.sub, /^[^\s]{1,800}$/),
      jti: claim(payload.jti, /^[A-Za-z0-9_-]{1,200}$/),
      expiresAt: payload.exp!,
      audience: githubOidcAudiences[purpose],
      runnerEnvironment,
      // GitHub sends the claim as the string "true" or "false".
      refProtected: addedClaim(payload.ref_protected, /^(?:true|false)$/, strict) === "true",
      repositoryVisibility: (["public", "private", "internal"] as const).find((item) => item === visibility),
      pullRequest: review ? Number(ref.split("/")[2]) : undefined,
      headRef: review && typeof payload.head_ref === "string" ? payload.head_ref : undefined,
      baseRef: review && typeof payload.base_ref === "string" ? payload.base_ref : undefined,
    }
    if (
      (review
        ? (payload.ref_type !== undefined && payload.ref_type !== "branch") ||
          identity.headRef === undefined ||
          !branchName.test(identity.headRef) ||
          identity.baseRef === undefined ||
          !branchName.test(identity.baseRef)
        : payload.ref_type !== "branch" ||
          (payload.head_ref !== undefined && payload.head_ref !== "") ||
          (payload.base_ref !== undefined && payload.base_ref !== "")) ||
      identity.workflowRef !== `${repository}/${GithubAgents.WORKFLOW_FILE}@${identity.ref}` ||
      identity.workflowSha !== identity.sha
    )
      throw new ApiError(403, "WORKFLOW_NOT_TRUSTED", "Use the Vector workflow on the repository's default branch.")
    const context = review ? "pull_request" : `ref:${identity.ref}`
    const subjects = [
      `repo:${repository}:${context}`,
      `repo:${owner}@${identity.ownerId}/${repository.split("/")[1]}@${identity.repositoryId}:${context}`,
    ]
    if (!subjects.includes(identity.subject)) throw oidcInvalid()
    if (!audienceEvents[purpose].includes(identity.event))
      throw new ApiError(403, "EVENT_NOT_ALLOWED", "This workflow event is not eligible for Vector App credentials.")
    return identity
  }
}

export type GithubIdentity = Awaited<ReturnType<ReturnType<typeof createGithubOidcVerifier>>>
export const verifyGithubOidc = createGithubOidcVerifier()

export async function consumeGithubOidc(identity: GithubIdentity, store = persistentStore) {
  if (identity.expiresAt <= Math.floor(Date.now() / 1000)) throw oidcInvalid()
  const digest = createHash("sha256").update(`${githubOidcIssuer}|${identity.audience}|${identity.jti}`).digest("hex")
  const ttl = Math.max(1, Math.min(631, identity.expiresAt - Math.floor(Date.now() / 1000) + 31))
  const result = await store(["SET", `vector:github:oidc:${digest}`, "1", "NX", "EX", ttl])
  if (result === "OK") return
  if (result === null)
    throw new ApiError(409, "OIDC_REPLAYED", "Request a new GitHub Actions identity token before retrying.")
  throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected GitHub services are temporarily unavailable.")
}

function claim(value: unknown, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value)) throw oidcInvalid()
  return value
}

// A claim spec 2.10 adds: absent is undefined, and a malformed value is refused when strict, otherwise read as absent.
function addedClaim(value: unknown, pattern: RegExp, strict: boolean) {
  if (value === undefined) return undefined
  if (typeof value === "string" && pattern.test(value)) return value
  if (strict) throw oidcInvalid()
  return undefined
}

function claimId(value: unknown) {
  if (typeof value !== "string") throw oidcInvalid()
  try {
    return githubId(value)
  } catch {
    throw oidcInvalid()
  }
}

function oidcInvalid() {
  return new ApiError(401, "OIDC_INVALID", "The GitHub Actions identity token is invalid or expired.")
}
