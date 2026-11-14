import { randomUUID } from "node:crypto"
import { ApiError } from "../../http.js"
import type { LinearConfig } from "../config.js"
import { seal } from "../crypto.js"
import { PLATFORM_HOSTS, platformFetch, readPlatformJson } from "../fetch.js"
import { checkInstallAuthority, installGuards, installToken, readInstallSnapshot, type IdentityContext, type InstallRecord } from "../identity.js"
import { everywhereKeys } from "../keys.js"
import { authorizedCommands } from "../authority.js"
import { setValue, swapValue } from "../store.js"
import { linearApi } from "./client.js"
import { linearId, linearObject } from "./verify.js"

export type LinearCredentials = { readonly v: 1; readonly access: string; readonly refresh: string; readonly expiresAt: number; readonly refreshUntil: number }
const TOKEN = /^[\x21-\x7e]{1,3000}$/

export function parseLinearCredentials(value: string | undefined): LinearCredentials | undefined {
  try {
    const item = linearObject(JSON.parse(value ?? "null"))
    return item.v === 1 && typeof item.access === "string" && TOKEN.test(item.access) && typeof item.refresh === "string" && TOKEN.test(item.refresh) &&
      typeof item.expiresAt === "number" && Number.isSafeInteger(item.expiresAt) && typeof item.refreshUntil === "number" && Number.isSafeInteger(item.refreshUntil)
      ? { v: 1, access: item.access, refresh: item.refresh, expiresAt: item.expiresAt, refreshUntil: item.refreshUntil } : undefined
  } catch { return undefined }
}

export function linearGrant(value: unknown, scopes: readonly string[], now: number): LinearCredentials {
  const item = linearObject(value)
  const returned = typeof item.scope === "string" ? item.scope.split(/[\s,]+/).filter(Boolean) : Array.isArray(item.scope) ? item.scope : []
  if (String(item.token_type).toLowerCase() !== "bearer" || typeof item.access_token !== "string" || !TOKEN.test(item.access_token) ||
    typeof item.refresh_token !== "string" || !TOKEN.test(item.refresh_token) || !Number.isSafeInteger(item.expires_in) ||
    Number(item.expires_in) <= 0 || Number(item.expires_in) > 2_592_000 || returned.length !== scopes.length || scopes.some((scope) => !returned.includes(scope)))
    throw new ApiError(400, "LINEAR_GRANT_INVALID", "Linear did not return the requested authorization.")
  return { v: 1, access: item.access_token, refresh: item.refresh_token, expiresAt: now + Number(item.expires_in) * 1000, refreshUntil: now + 30 * 86_400_000 }
}

export async function linearOAuth(config: LinearConfig, body: Readonly<Record<string, string>>, fetcher?: typeof fetch, timeoutMs = 10_000): Promise<unknown> {
  const response = await platformFetch("linear", new URL("/oauth/token", `https://${PLATFORM_HOSTS.linear[0]!.host}`), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: config.clientId, client_secret: config.clientSecret }), signal: AbortSignal.timeout(timeoutMs),
  }, fetcher)
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ApiError(503, "LINEAR_AUTH_UNAVAILABLE", "Reconnect Linear to continue.") }
  return readPlatformJson(response)
}

/** A refresh preserves authorization revision; exact-record CAS cannot overwrite reconnect or restore an erased install. */
export async function linearAccess(input: {
  readonly context: () => IdentityContext
  readonly config: LinearConfig
  readonly installation: string
  readonly fetcher?: typeof fetch
  readonly deadline?: number
}): Promise<{ readonly token: string; readonly record: InstallRecord }> {
  const ctx = input.context
  const read = async () => {
    const snapshot = await readInstallSnapshot(ctx().store, input.installation)
    const credentials = snapshot && parseLinearCredentials(installToken(ctx().keys, input.installation, snapshot.record))
    if (!snapshot || !credentials) throw new ApiError(503, "LINEAR_RECONNECT_REQUIRED", "Reconnect Linear to continue.")
    await checkInstallAuthority(ctx(), input.installation, snapshot)
    return { ...snapshot, credentials }
  }
  const initial = await read()
  if (initial.credentials.expiresAt - ctx().now > 60_000) return { token: initial.credentials.access, record: initial.record }
  if (initial.credentials.refreshUntil <= ctx().now) throw new ApiError(503, "LINEAR_RECONNECT_REQUIRED", "Reconnect Linear to continue.")
  const lock = everywhereKeys.linearRefresh(input.installation)
  const owner = randomUUID()
  if (!await setValue(ctx().store, lock, owner, { ttlMs: 30_000, onlyNew: true })) throw new ApiError(503, "LINEAR_REFRESH_BUSY", "Linear authorization is being renewed. Try again shortly.")
  try {
    const current = await read()
    if (current.credentials.expiresAt - ctx().now > 60_000) return { token: current.credentials.access, record: current.record }
    const remaining = input.deadline === undefined ? 10_000 : Math.min(10_000, input.deadline - ctx().now)
    if (remaining <= 0) throw new ApiError(503, "LINEAR_AUTH_UNAVAILABLE", "Linear is temporarily unavailable.")
    const renewed = linearGrant(await linearOAuth(input.config, { grant_type: "refresh_token", refresh_token: current.credentials.refresh }, input.fetcher, remaining), current.record.scopes, ctx().now)
    // A delayed refresh can outlive erasure or reconnect. Never make another native call under that old authority.
    if ((await readInstallSnapshot(ctx().store, input.installation))?.raw !== current.raw)
      throw new ApiError(409, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
    await checkInstallAuthority(ctx(), input.installation, current)
    const me = await linearApi({ token: renewed.access, fetcher: input.fetcher, now: () => ctx().now, deadline: input.deadline,
      beforeRequest: async () => {
        await checkInstallAuthority(ctx(), input.installation, current)
        if ((await readInstallSnapshot(ctx().store, input.installation))?.raw !== current.raw)
          throw new ApiError(409, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
      },
    })("viewer")
    const viewer = linearObject(me.viewer)
    if (!linearId(viewer.id) || viewer.id !== current.record.botUserId || viewer.app !== true || viewer.active !== true ||
      linearObject(viewer.organization).id !== input.installation.slice("linear:".length) || linearObject(me.organization).id !== linearObject(viewer.organization).id)
      throw new ApiError(503, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
    const next = { ...current.record, tokenEnc: seal(ctx().keys, JSON.stringify(renewed), everywhereKeys.install(input.installation)) }
    await authorizedCommands(ctx().store, await installGuards(ctx(), input.installation, current), [["SET", everywhereKeys.install(input.installation), JSON.stringify(next)]])
    return { token: renewed.access, record: next }
  } finally { await swapValue(ctx().store, lock, owner, undefined) }
}
