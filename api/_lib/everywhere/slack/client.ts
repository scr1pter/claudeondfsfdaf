import { ApiError } from "../../http.js"
import { PLATFORM_HOSTS, platformFetch, readPlatformJson } from "../fetch.js"
import { slackObject } from "./verify.js"

const METHODS = ["users.info", "conversations.replies", "agents.sessions.setStatus", "agents.sessions.rename", "chat.postMessage", "chat.update", "chat.postEphemeral", "oauth.v2.access", "auth.revoke"] as const
export type SlackMethod = (typeof METHODS)[number]

/** Only definitive platform refusals may clear a first-post attempt receipt. */
export class SlackFailure extends ApiError {
  constructor(readonly uncertain: boolean, readonly retryMs = 0) {
    super(503, uncertain ? "SLACK_DELIVERY_UNCERTAIN" : "SLACK_UNAVAILABLE", "Slack is temporarily unavailable.")
  }
}

export function createSlackClient(input: {
  readonly token?: string
  readonly fetcher?: typeof fetch
  readonly revoked?: () => Promise<void>
  readonly now?: () => number
  readonly cooldown?: { read(method: SlackMethod): Promise<number>; write(method: SlackMethod, at: number, ttlMs: number): Promise<void> }
}) {
  let after = 0
  return async (method: SlackMethod, body: Readonly<Record<string, unknown>>) => {
    if (!METHODS.includes(method)) throw new RangeError("Unsupported Slack method")
    const now = input.now ?? Date.now
    const blockedUntil = Math.max(after, await input.cooldown?.read(method) ?? 0)
    if (now() < blockedUntil) throw new SlackFailure(false, blockedUntil - now())
    const url = new URL(`/api/${method}`, `https://${PLATFORM_HOSTS.slack[0]!.host}`)
    const get = method === "conversations.replies"
    const form = method === "oauth.v2.access"
    if (get) for (const [name, value] of Object.entries(body)) url.searchParams.set(name, String(value))
    let response: Response
    try {
      response = await platformFetch("slack", url, { method: get ? "GET" : "POST",
        headers: { ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          ...(!get ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" } : {}) },
        ...(!get ? { body: form ? new URLSearchParams(Object.entries(body).map(([name, value]) => [name, String(value)])) : JSON.stringify(body) } : {}),
      }, input.fetcher)
    } catch { throw new SlackFailure(true) }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"))
      const retryMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 24 * 60 * 60_000) : 60_000
      after = now() + retryMs
      await input.cooldown?.write(method, after, retryMs)
      await response.body?.cancel().catch(() => undefined)
      throw new SlackFailure(false, retryMs)
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      await input.revoked?.()
      throw new SlackFailure(false)
    }
    if (response.status >= 500) { await response.body?.cancel().catch(() => undefined); throw new SlackFailure(true) }
    let result: Record<string, unknown>
    try { result = slackObject(await readPlatformJson(response)) } catch { throw new SlackFailure(true) }
    if (result.ok !== true || !response.ok) {
      if (["invalid_auth", "token_revoked", "account_inactive"].includes(String(result.error))) await input.revoked?.()
      throw new SlackFailure(["fatal_error", "internal_error", "request_timeout", "service_unavailable"].includes(String(result.error)))
    }
    return result
  }
}

export type SlackClient = ReturnType<typeof createSlackClient>
