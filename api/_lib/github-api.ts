import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { githubApp, type createGithubApp } from "./github-app.js"
import { consumeGithubOidc, verifyGithubOidc, type GithubIdentity, type GithubOidcPurpose } from "./github-oidc.js"
import { ApiError, json, readJson, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"

export function createGithubApi(
  input: {
    app?: ReturnType<typeof createGithubApp>
    verify?: typeof verifyGithubOidc
    store?: typeof persistentStore
  } = {},
) {
  const app = input.app ?? githubApp
  const verify = input.verify ?? verifyGithubOidc
  const store = input.store ?? persistentStore

  async function installation(request: ApiRequest, response: ApiResponse) {
    requireCleanUrl(request)
    if (request.method === "GET") return json(response, 200, app.configuration())
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    const verified = await githubProof(request, response, "installation", verify)
    if (Object.keys(verified.body).length) throw invalidRequest()
    const result = await app.installation(verified.identity)
    if (result.retryAfterSeconds) response.setHeader("retry-after", String(result.retryAfterSeconds))
    json(response, 200, result)
  }

  async function token(request: ApiRequest, response: ApiResponse) {
    requireCleanUrl(request)
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const verified = await githubProof(request, response, "token", verify)
    const purpose = verified.body.purpose
    const pullRequest = verified.body.pullRequest
    if (
      Object.keys(verified.body).some((key) => !["purpose", "pullRequest"].includes(key)) ||
      (purpose !== "task" && purpose !== "review" && purpose !== "publish") ||
      (pullRequest !== undefined &&
        (typeof pullRequest !== "number" ||
          !Number.isSafeInteger(pullRequest) ||
          pullRequest < 1 ||
          pullRequest > 2_147_483_647))
    )
      throw invalidRequest()
    const result = await app.token(verified.identity, purpose, pullRequest, async () => {
      await mintLimits(request, response, verified.identity)
      await consumeGithubOidc(verified.identity, store)
    })
    console.info("Vector GitHub App credential issued", {
      repositoryId: verified.identity.repositoryId,
      runId: verified.identity.runId,
      runAttempt: verified.identity.runAttempt,
      checkRunId: verified.identity.checkRunId,
      purpose,
    })
    json(response, 200, result)
  }

  return {
    installation: safe(installation),
    token: safe(token),
  }
}

export async function githubProof(
  request: ApiRequest,
  response: ApiResponse,
  purpose: GithubOidcPurpose,
  verify: typeof verifyGithubOidc = verifyGithubOidc,
) {
  requireTrustedJsonRequest(request, 2_000)
  await enforceRateLimit(request, response, {
    scope: "github-oidc-ip",
    limit: 60,
    windowSeconds: 300,
    requirePersistent: true,
  })
  const authorization = request.headers.authorization
  if (
    typeof authorization !== "string" ||
    authorization.length > 16_400 ||
    !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)
  )
    throw new ApiError(401, "OIDC_INVALID", "A GitHub Actions identity token is required.")
  const body = await readJson<unknown>(request, 2_000)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest()
  const identity = await verify(authorization.slice(7), purpose)
  await enforceRateLimit(request, response, {
    scope: `github-oidc-${purpose}`,
    identifier: identity.repositoryId,
    limit: 60,
    windowSeconds: 300,
    requirePersistent: true,
  })
  return { body: body as Record<string, unknown>, identity }
}

async function mintLimits(request: ApiRequest, response: ApiResponse, identity: GithubIdentity) {
  await enforceRateLimit(request, response, {
    scope: "github-token-job",
    identifier: `${identity.repositoryId}:${identity.runId}:${identity.runAttempt}:${identity.checkRunId}`,
    limit: 3,
    windowSeconds: 3600,
    requirePersistent: true,
  })
  await enforceRateLimit(request, response, {
    scope: "github-token-repository",
    identifier: identity.repositoryId,
    limit: 20,
    windowSeconds: 3600,
    requirePersistent: true,
  })
}

function requireCleanUrl(request: ApiRequest) {
  if (new URL(request.url ?? "/", "https://vectordev.ai").search) throw invalidRequest()
}

function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported GitHub exchange fields.")
}

function safe(handler: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    await handler(request, response).catch((error: unknown) => {
      if (!request.readableEnded) response.setHeader("connection", "close")
      request.resume()
      const known =
        error instanceof ApiError
          ? error
          : new ApiError(503, "GITHUB_UNAVAILABLE", "GitHub verification is temporarily unavailable.")
      const code = known.code === "ABUSE_PROTECTION_UNAVAILABLE" ? "PERSISTENT_STORE_UNAVAILABLE" : known.code
      // Upstream errors can contain authorization headers. Never log or serialize them.
      json(response, known.statusCode, { error: { code, message: known.message } })
    })
  }
}

export const githubApi = createGithubApi()
