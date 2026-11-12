import { CodiumRunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import { isPoolPurpose, validRunId, type PoolPurpose } from "./codium-pool.js"
import { modelPlanRequireMarkedTokens, modelPlansMinClient } from "./model-plan-config.js"
import { ApiError, type ApiRequest } from "./http.js"
import { requireUnrevokedAccount, requireUnrevokedCliToken } from "./revocation.js"

export type ModelPlanCaller = {
  account: { id: string }
  kind: "desktop" | "cli" | "run"
  purpose: PoolPurpose
  run?: {
    id: string
    source: CodiumRunTrigger.RunSource
    deadline: number
    ceilingShare?: number
    service: "cloud-agents" | "hosted"
    sessionId?: string
  }
}
type RunPrefix = "vrt_" | "vht_"
type RunVerifier = (token: string) => Promise<ModelPlanCaller>
const CLIENT = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** Independent registries let tests exercise future service verifiers without replacing production registrations. */
export function createRunVerifierRegistry() {
  const verifiers = new Map<RunPrefix, RunVerifier>()
  return {
    register(prefix: RunPrefix, verify: RunVerifier) {
      if ((prefix !== "vrt_" && prefix !== "vht_") || typeof verify !== "function" || verifiers.has(prefix))
        throw new Error("A Codium run prefix must have exactly one verifier.")
      verifiers.set(prefix, verify)
    },
    async verify(token: string, now: number) {
      const prefix = token.slice(0, 4)
      if (prefix !== "vrt_" && prefix !== "vht_") throw signInRequired()
      const verify = verifiers.get(prefix)
      if (!verify) throw runExpired()
      const caller = await verify(token).catch((error: unknown) => {
        if (error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)) throw runExpired()
        throw error
      })
      if (
        !caller ||
        caller.kind !== "run" ||
        !caller.account ||
        typeof caller.account.id !== "string" ||
        !ACCOUNT.test(caller.account.id) ||
        !isPoolPurpose(caller.purpose) ||
        !caller.run ||
        typeof caller.run.id !== "string" ||
        // One grammar with admission: the run id is part of every held member and of `run:<id>` (§4.6), so a verifier
        // must mint ids without ':' and at most 128 characters, unique across accounts.
        !validRunId(caller.run.id) ||
        ![...CodiumRunTrigger.ENABLED_SOURCES].some((source) => source === caller.run!.source) ||
        !Number.isSafeInteger(caller.run.deadline) ||
        caller.run.deadline <= now ||
        caller.run.service !== (prefix === "vrt_" ? "cloud-agents" : "hosted") ||
        (caller.run.ceilingShare !== undefined &&
          (!Number.isFinite(caller.run.ceilingShare) || caller.run.ceilingShare <= 0 || caller.run.ceilingShare > 1)) ||
        (caller.run.sessionId !== undefined &&
          (typeof caller.run.sessionId !== "string" || !ID.test(caller.run.sessionId))) ||
        (prefix === "vht_" && !caller.run.sessionId)
      )
        throw runExpired()
      return caller
    },
  }
}
const runVerifiers = createRunVerifierRegistry()

/** Services register their domain-bound verifier through static imports; an unknown prefix never falls back. */
export function registerRunVerifier(prefix: RunPrefix, verify: RunVerifier) {
  runVerifiers.register(prefix, verify)
}

/** Client hints only choose protocol compatibility. They never establish identity, tier or spending authority. */
export function requireModelPlanClient(request: Pick<ApiRequest, "headers">) {
  const version = header(request, "x-vector-client")
  if (version === "local" && process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production")
    return version
  if (!CLIENT.test(version)) throw updateRequired()
  const minimum = modelPlansMinClient().split(".").map(Number)
  const compared = version
    .split(".")
    .map(Number)
    .map((component, index) => component - minimum[index]!)
    .find((difference) => difference !== 0)
  if (compared !== undefined && compared < 0) throw updateRequired()
  return version
}

/**
 * Only the paid chat, catalog and estimate use this marked/run-token gate; account and billing auth remain separate.
 * `unmarked` lets an unmarked account token through as a CLI caller whatever the marked-token switch says: estimate
 * answers it, since such a token may already read status, which says more (§4.13).
 */
export async function requireModelPlanCaller(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  registry = runVerifiers,
  accepts: { unmarked?: boolean } = {},
): Promise<ModelPlanCaller> {
  const authorization = header(request, "authorization")
  if (authorization.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization))
    throw signInRequired()
  const token = authorization.slice(7)
  if (token.startsWith("vrt_") || token.startsWith("vht_")) {
    const caller = await registry.verify(token, now)
    await requireUnrevokedAccount(caller.account.id, fetcher)
    return caller
  }
  if (!token.startsWith("vct_")) throw signInRequired()
  const claims = await requireUnrevokedCliToken(token, fetcher, now).catch((error: unknown) => {
    if (error instanceof ApiError && error.statusCode === 401) throw signInRequired()
    throw error
  })
  if (claims.client !== "desktop" && claims.client !== "cli" && !accepts.unmarked && modelPlanRequireMarkedTokens())
    throw signInRequired()
  const purpose = header(request, "x-vector-purpose")
  return {
    account: { id: claims.id },
    // The explicit legacy override admits unmarked grants as CLI callers, never desktop billing authority.
    kind: claims.client === "desktop" ? "desktop" : "cli",
    purpose: isPoolPurpose(purpose) && purpose !== "cloud-agents" && purpose !== "hosted" ? purpose : "task",
  }
}

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return typeof value === "string" ? value : ""
}
function signInRequired() {
  return new ApiError(
    401,
    "CODIUM_SIGN_IN_REQUIRED",
    "Sign in to Vector again or run vector login to use Vector Codium.",
  )
}
function runExpired() {
  return new ApiError(
    401,
    "MODEL_PLAN_RUN_EXPIRED",
    "This run is no longer authorized. Save your work and finish the run.",
  )
}
function updateRequired() {
  return new ApiError(426, "CODIUM_UPDATE_REQUIRED", "Update Vector to keep using Vector Codium.")
}
