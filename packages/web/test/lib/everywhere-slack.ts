import { randomBytes, randomUUID } from "node:crypto"
import { hmacSha256Hex } from "../../../../api/_lib/everywhere/signature"
import { OAUTH, readInstall, recordInstall } from "../../../../api/_lib/everywhere/identity"
import { PLATFORM_HOSTS } from "../../../../api/_lib/everywhere/fetch"
import { routerFixture } from "./everywhere-router"

/** Generated-token loopback Web API. Calls retain only test data and are never sent to a real workspace. */
export class FakeSlack {
  calls: { method: string; body: Record<string, unknown>; http: string; authorization: string | null }[] = []
  user: Record<string, unknown> = { id: "U0ALICE01", team_id: "T0123ABCD", is_bot: false, deleted: false, is_restricted: false, is_ultra_restricted: false, is_admin: true }
  messages: unknown[] = []
  grant: Record<string, unknown> = {}
  answer?: (method: string, body: Record<string, unknown>) => Response | undefined | Promise<Response | undefined>
  private server?: ReturnType<typeof Bun.serve>
  private seq = 0

  start() {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const url = new URL(request.url)
      const method = url.pathname.slice("/api/".length)
      const body = request.method === "GET" ? Object.fromEntries(url.searchParams) :
        request.headers.get("content-type")?.startsWith("application/json") ? await request.json() as Record<string, unknown> : Object.fromEntries(new URLSearchParams(await request.text()))
      this.calls.push({ method, body, http: request.method, authorization: request.headers.get("authorization") })
      const custom = await this.answer?.(method, body)
      if (custom) return custom
      if (method === "auth.revoke") return Response.json({ ok: true, revoked: true })
      if (method === "auth.test") return Response.json({ ok: true, team_id: "T0123ABCD", user_id: "U0BOT0001", bot_id: "B0BOT0001" })
      if (method === "users.info") return Response.json({ ok: true, user: this.user })
      if (method === "conversations.replies") return Response.json({ ok: true, messages: this.messages })
      if (method === "oauth.v2.access") return Response.json({ ok: true, ...this.grant })
      const ts = `1731335400.${String(++this.seq).padStart(6, "0")}`
      return Response.json({ ok: true, ts, message_ts: ts })
    } })
  }
  stop() { return this.server?.stop(true) }
  readonly fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== PLATFORM_HOSTS.slack[0]!.host || !url.pathname.startsWith("/api/") || !this.server) throw new Error("Unexpected fake Slack address")
    return fetch(new URL(`${url.pathname}${url.search}`, this.server.url), init)
  }) as typeof fetch
}

export async function slackFixture() {
  const f = routerFixture()
  const token = `xoxb-${randomBytes(24).toString("hex")}`
  const installation = "slack:T0123ABCD"
  await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation, token, scopes: OAUTH.slack.scopes.install,
    botUserId: "U0BOT0001", installer: { userId: "U0ALICE01", admin: true } } })
  const envelope = (text = "<@U0BOT0001> Fix the login button", event: Record<string, unknown> = {}) => ({
    type: "event_callback", event_id: `Ev${randomUUID().replace(/-/g, "")}`, team_id: "T0123ABCD", api_app_id: f.config.slack!.appId,
    authorizations: [{ team_id: "T0123ABCD", user_id: "U0BOT0001", is_bot: true, is_enterprise_install: false }],
    event: { type: "app_mention", user: "U0ALICE01", channel: "C123", text, ts: "1731335400.000100", ...event },
  })
  const sign = (body: string, timestamp = String(Math.floor(f.fake.clock.now / 1000))) => ({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${hmacSha256Hex(f.config.slack!.signingSecret, `v0:${timestamp}:`, body)}`,
  })
  const record = await readInstall(f.store, installation)
  if (!record) throw new Error("Fixture Slack installation was not stored")
  return { ...f, token, installation, envelope, sign, record }
}
