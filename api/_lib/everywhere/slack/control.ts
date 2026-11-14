import { PLATFORM_HOSTS, platformFetch, readPlatformJson } from "../fetch.js"
import { installToken, type InstallRecord } from "../identity.js"
import type { DataKey } from "../crypto.js"
import { slackObject } from "./verify.js"

/** No-scope, read-only proof. Dispatch timestamps and tokens_revoked user IDs cannot identify an OAuth grant. */
export async function slackAuthorization(input: { readonly installation: string; readonly record: InstallRecord; readonly keys: readonly DataKey[]; readonly fetcher?: typeof fetch }): Promise<"valid" | "unusable" | "hold"> {
  const token = installToken(input.keys, input.installation, input.record)
  if (!token || !input.record.botUserId) return "hold"
  const parts = input.installation.slice(6).split(":")
  const team = parts.find((part) => part.startsWith("T")), enterprise = parts.find((part) => part.startsWith("E"))
  try {
    const response = await platformFetch("slack", new URL("/api/auth.test", `https://${PLATFORM_HOSTS.slack[0]!.host}`), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: "{}",
      signal: AbortSignal.timeout(10_000),
    }, input.fetcher)
    if (response.status === 429 || response.status >= 500) { await response.body?.cancel().catch(() => undefined); return "hold" }
    const body = slackObject(await readPlatformJson(response))
    if (response.ok && body.ok === true && (!team || body.team_id === team) && (!enterprise || body.enterprise_id === enterprise) && body.user_id === input.record.botUserId && typeof body.bot_id === "string" && /^[A-Z0-9]{2,32}$/.test(body.bot_id)) return "valid"
    return body.ok === false && ["invalid_auth", "token_revoked", "account_inactive"].includes(String(body.error)) ? "unusable" : "hold"
  } catch { return "hold" }
}
