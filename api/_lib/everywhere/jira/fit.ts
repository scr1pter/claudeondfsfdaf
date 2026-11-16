import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose"
import { ApiError } from "../../http.js"
import { platformFetch, readPlatformJson } from "../fetch.js"
import { USER_ID_PATTERNS } from "../keys.js"

export const FIT_JWKS = "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"
export const FIT_ISSUER = "forge/invocation-token"
export const JIRA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APP = /^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/i
const INSTALLATION = /^ari:cloud:ecosystem::installation\/[0-9a-f-]{36}$/i
export function jiraObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function invalid() { return new ApiError(401, "JIRA_INVOCATION_INVALID", "The Jira invocation could not be verified.") }
export type ForgeInvocation = {
  readonly cloudId: string
  readonly installationId: string
  readonly principal?: string
  readonly moduleKey: string
  readonly jti: string
  readonly expiresAt: number
}

/** Fixed commercial JWKS, one-hour cache and bounded unknown-key refresh. No URL from a claim is fetched. */
export function createFitVerifier(input: { readonly appId: () => string | undefined; readonly fetcher?: typeof fetch; readonly now?: () => number }) {
  const now = input.now ?? Date.now
  let cached: { at: number; kids: ReadonlySet<string>; resolve: ReturnType<typeof createLocalJWKSet> } | undefined
  let loading: Promise<void> | undefined
  let lastUnknown = -Infinity
  const load = () => loading ??= (async () => {
    const response = await platformFetch("jira", FIT_JWKS, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) }, input.fetcher)
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw invalid() }
    const set = jiraObject(await readPlatformJson(response, 64_000))
    if (!Array.isArray(set.keys) || !set.keys.length || set.keys.length > 20) throw invalid()
    const keys = set.keys.map(jiraObject)
    if (keys.some((key) => key.kty !== "RSA" || typeof key.kid !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key.kid) ||
      typeof key.n !== "string" || key.n.length < 342 || key.n.length > 2048 || typeof key.e !== "string" || key.e.length > 16 ||
      (key.alg !== undefined && key.alg !== "RS256") || (key.use !== undefined && key.use !== "sig") || ["d", "p", "q", "dp", "dq", "qi"].some((part) => key[part] !== undefined))) throw invalid()
    cached = { at: now(), kids: new Set(keys.map((key) => String(key.kid))), resolve: createLocalJWKSet({ keys } as JSONWebKeySet) }
  })().finally(() => { loading = undefined })

  return async (token: string): Promise<ForgeInvocation> => {
    try {
      const appId = input.appId()
      if (!appId || !APP.test(appId) || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid()
      const header = decodeProtectedHeader(token)
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[\x21-\x7e]{1,200}$/.test(header.kid) ||
        (header.typ !== undefined && header.typ !== "JWT") || Object.keys(header).some((key) => !["alg", "kid", "typ"].includes(key))) throw invalid()
      const previous = cached
      if (!cached || now() - cached.at >= 3_600_000) await load()
      if (previous && !cached!.kids.has(header.kid) && now() - lastUnknown >= 30_000) { lastUnknown = now(); await load() }
      const verified = await jwtVerify(token, cached!.resolve, { algorithms: ["RS256"], issuer: FIT_ISSUER, audience: appId,
        requiredClaims: ["exp", "iat", "nbf", "jti"], maxTokenAge: 300, currentDate: new Date(now()), clockTolerance: 5 })
      const payload = verified.payload
      const app = jiraObject(payload.app)
      const context = jiraObject(payload.context)
      const seconds = Math.floor(now() / 1000)
      if (payload.aud !== appId || app.id !== appId || payload.icLabel !== undefined || typeof app.installationId !== "string" || !INSTALLATION.test(app.installationId) ||
        typeof context.cloudId !== "string" || !JIRA_UUID.test(context.cloudId) || app.apiBaseUrl !== `https://api.atlassian.com/ex/jira/${context.cloudId.toLowerCase()}` ||
        typeof jiraObject(app.module).key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(String(jiraObject(app.module).key)) ||
        typeof payload.jti !== "string" || !/^[\x21-\x7e]{1,200}$/.test(payload.jti) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
        payload.exp! <= seconds || payload.exp! - payload.iat! > 600 || payload.iat! > seconds + 5 ||
        (payload.principal !== undefined && (typeof payload.principal !== "string" || !USER_ID_PATTERNS.jira.test(payload.principal)))) throw invalid()
      return { cloudId: context.cloudId.toLowerCase(), installationId: app.installationId, moduleKey: String(jiraObject(app.module).key),
        jti: payload.jti, expiresAt: payload.exp! * 1000, ...(typeof payload.principal === "string" ? { principal: payload.principal } : {}) }
    } catch { throw invalid() }
  }
}
