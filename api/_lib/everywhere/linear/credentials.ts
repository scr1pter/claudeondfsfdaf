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

export type LinearCredentials = { readonly access: string; readonly refresh: string; readonly expiresAt: number; readonly refreshUntil: number } & (
  | { readonly v: 1; readonly verification?: never }
  /** Version 2 makes older deployments refuse an unverified pair instead of using their fresh-access shortcut. */
  | { readonly v: 2; readonly verification: "pending" | "rejected" }
)
const TOKEN = /^[\x21-\x7e]{1,3000}$/

export function parseLinearCredentials(value: string | undefined): LinearCredentials | undefined {
  try {
    const item = linearObject(JSON.parse(value ?? "null"))
    if (typeof item.access !== "string" || !TOKEN.test(item.access) || typeof item.refresh !== "string" || !TOKEN.test(item.refresh) ||
      typeof item.expiresAt !== "number" || !Number.isSafeInteger(item.expiresAt) || typeof item.refreshUntil !== "number" || !Number.isSafeInteger(item.refreshUntil))
      return undefined
    const pair = { access: item.access, refresh: item.refresh, expiresAt: item.expiresAt, refreshUntil: item.refreshUntil }
    if (item.v === 1 && item.verification === undefined) return { v: 1, ...pair }
    if (item.v === 2 && (item.verification === "pending" || item.verification === "rejected"))
      return { v: 2, ...pair, verification: item.verification }
    return undefined
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
    if (credentials.verification === "rejected") throw new ApiError(503, "LINEAR_RECONNECT_REQUIRED", "Reconnect Linear to continue.")
    return { ...snapshot, credentials }
  }
  const initial = await read()
  if (initial.credentials.expiresAt - ctx().now > 60_000 && !initial.credentials.verification)
    return { token: initial.credentials.access, record: initial.record }
  const lock = everywhereKeys.linearRefresh(input.installation)
  const owner = randomUUID()
  if (!await setValue(ctx().store, lock, owner, { ttlMs: 30_000, onlyNew: true })) throw new ApiError(503, "LINEAR_REFRESH_BUSY", "Linear authorization is being renewed. Try again shortly.")
  try {
    const current = await read()
    if (current.credentials.expiresAt - ctx().now > 60_000 && !current.credentials.verification)
      return { token: current.credentials.access, record: current.record }
    const save = async (snapshot: typeof current, credentials: LinearCredentials) => {
      const record = { ...snapshot.record, tokenEnc: seal(ctx().keys, JSON.stringify(credentials), everywhereKeys.install(input.installation)) }
      const raw = JSON.stringify(record)
      await authorizedCommands(ctx().store, await installGuards(ctx(), input.installation, snapshot), [["SET", everywhereKeys.install(input.installation), raw]])
      return { record, raw, credentials }
    }
    const refresh = async () => {
      if (current.credentials.refreshUntil <= ctx().now) throw new ApiError(503, "LINEAR_RECONNECT_REQUIRED", "Reconnect Linear to continue.")
      const remaining = input.deadline === undefined ? 10_000 : Math.min(10_000, input.deadline - ctx().now)
      if (remaining <= 0) throw new ApiError(503, "LINEAR_AUTH_UNAVAILABLE", "Linear is temporarily unavailable.")
      const renewed = linearGrant(await linearOAuth(input.config, { grant_type: "refresh_token", refresh_token: current.credentials.refresh }, input.fetcher, remaining), current.record.scopes, ctx().now)
      // A delayed refresh can outlive erasure or reconnect. Never make another native call under that old authority.
      if ((await readInstallSnapshot(ctx().store, input.installation))?.raw !== current.raw)
        throw new ApiError(409, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
      await checkInstallAuthority(ctx(), input.installation, current)
      // Linear may already have invalidated the old refresh token. Preserve the replacement before any fallible
      // viewer request, but mark it pending so a retry cannot return it through the fresh-access shortcut.
      return save(current, { ...renewed, v: 2, verification: "pending" })
    }
    const pending = current.credentials.expiresAt - ctx().now > 60_000 ? current : await refresh()
    const me = await linearApi({ token: pending.credentials.access, fetcher: input.fetcher, now: () => ctx().now, deadline: input.deadline,
      beforeRequest: async () => {
        await checkInstallAuthority(ctx(), input.installation, pending)
        if ((await readInstallSnapshot(ctx().store, input.installation))?.raw !== pending.raw)
          throw new ApiError(409, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
      },
    })("viewer")
    const viewer = linearObject(me.viewer)
    if (!linearId(viewer.id) || typeof viewer.app !== "boolean" || typeof viewer.active !== "boolean" ||
      !linearId(linearObject(viewer.organization).id) || !linearId(linearObject(me.organization).id))
      throw new ApiError(503, "LINEAR_AUTH_UNAVAILABLE", "Linear is temporarily unavailable.")
    if (viewer.id !== pending.record.botUserId || viewer.app !== true || viewer.active !== true ||
      linearObject(viewer.organization).id !== input.installation.slice("linear:".length) || linearObject(me.organization).id !== linearObject(viewer.organization).id) {
      await save(pending, { ...pending.credentials, v: 2, verification: "rejected" })
      throw new ApiError(503, "LINEAR_AUTH_CHANGED", "The Linear authorization changed. Reconnect to continue.")
    }
    const { verification: _verification, ...credentials } = pending.credentials
    const verified = await save(pending, { ...credentials, v: 1 })
    return { token: pending.credentials.access, record: verified.record }
  } finally { await swapValue(ctx().store, lock, owner, undefined) }
}
