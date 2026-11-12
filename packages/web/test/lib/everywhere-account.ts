import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { ENV_NAMES } from "../../../../api/_lib/everywhere/config"

/*
 * Fakes for the Vector everywhere account routes (contract section 9). Everything listens on 127.0.0.1 and is started
 * inside the test; every secret is generated here.
 *
 * - `FakeAccounts`: the account service `requireAccountUser` asks (`GET /auth/v1/user`), with one bearer token per
 *   test account.
 * - `RouteHarness`: a loopback HTTP server that hands each request to the route handler under test.
 * - `FakeJira`: the site permission read (`GET /ex/jira/<cloud id>/rest/api/3/mypermissions`) that checks the user
 *   token, and a fetcher that sends `https://api.atlassian.com` calls to it instead.
 */

export type TestAccount = { readonly id: string; readonly email: string; readonly token: string }

export function testAccount(email: string): TestAccount {
  return { id: randomUUID(), email, token: `session-${randomBytes(18).toString("base64url")}` }
}

export class FakeAccounts {
  readonly accounts = new Map<string, TestAccount>()
  calls = 0
  private server?: ReturnType<typeof Bun.serve>
  private previous: Record<string, string | undefined> = {}

  add(account: TestAccount) {
    this.accounts.set(account.token, account)
    return account
  }

  /** Starts the server and points `requireAccountUser` at it. */
  start() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        this.calls++
        if (new URL(request.url).pathname !== "/auth/v1/user") return new Response(null, { status: 404 })
        const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
        const account = token ? this.accounts.get(token) : undefined
        if (!account) return Response.json({ error: "invalid" }, { status: 401 })
        return Response.json({ id: account.id, email: account.email, email_confirmed_at: "2026-01-01T00:00:00Z" })
      },
    })
    this.previous = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    }
    process.env.SUPABASE_URL = this.server.url.origin
    process.env.SUPABASE_PUBLISHABLE_KEY = `publishable-${randomBytes(8).toString("hex")}`
  }

  async stop() {
    await this.server?.stop(true)
    for (const [name, value] of Object.entries(this.previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void

export type RouteAnswer = { readonly status: number; readonly body: any; readonly text: string }

/** A loopback server for route handlers; `use` swaps the handlers between tests. */
export class RouteHarness {
  private handlers: Record<string, Handler> = {}
  private server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const handler = this.handlers[path]
    if (!handler) {
      response.statusCode = 404
      response.end()
      return
    }
    void handler(request, response)
  })
  origin = ""

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  use(api: { link: Handler; links: Handler; installs: Handler; repos: Handler; oauthFinish: Handler }) {
    this.handlers = {
      "/api/everywhere/link": api.link,
      "/api/everywhere/links": api.links,
      "/api/everywhere/installs": api.installs,
      "/api/everywhere/repos": api.repos,
      "/api/everywhere/oauth-finish": api.oauthFinish,
    }
  }

  async call(
    method: string,
    path: string,
    options: { readonly token?: string; readonly body?: unknown; readonly query?: Record<string, string> } = {},
  ): Promise<RouteAnswer> {
    const url = new URL(`${this.origin}${path}`)
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value)
    const response = await fetch(url, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    return { status: response.status, body, text }
  }
}

/** A generated secret long enough for config.ts. */
export function secret() {
  return randomBytes(24).toString("hex")
}

/** An environment with the feature on, the listed platforms configured, and a fresh data key. */
export function everywhereEnv(platforms = "github,slack,linear,jira"): Record<string, string> {
  return {
    [ENV_NAMES.enabled]: "true",
    [ENV_NAMES.dataKey]: randomBytes(32).toString("base64"),
    [ENV_NAMES.platforms]: platforms,
    [ENV_NAMES.slackAppId]: "A0TESTAPP",
    [ENV_NAMES.slackClientId]: "1234.5678",
    [ENV_NAMES.slackClientSecret]: secret(),
    [ENV_NAMES.slackSigningSecret]: secret(),
    [ENV_NAMES.linearClientId]: "linear-test-client",
    [ENV_NAMES.linearClientSecret]: secret(),
    [ENV_NAMES.linearWebhookSecret]: secret(),
    [ENV_NAMES.jiraForgeAppId]: "test-forge-app",
  }
}

/** The site permission read a Jira connect code depends on. `admins` and `members` are user tokens. */
export class FakeJira {
  readonly admins = new Set<string>()
  readonly members = new Set<string>()
  /** Answer every request with this status instead. */
  failWith?: number
  readonly seen: { cloudId: string; permissions: string | null }[] = []
  private server?: ReturnType<typeof Bun.serve>

  start() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        const match = /^\/ex\/jira\/([0-9a-f-]{36})\/rest\/api\/3\/mypermissions$/.exec(url.pathname)
        if (!match) return new Response(null, { status: 404 })
        this.seen.push({ cloudId: match[1]!, permissions: url.searchParams.get("permissions") })
        if (this.failWith) return new Response("broken", { status: this.failWith })
        const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""
        if (!this.admins.has(token) && !this.members.has(token)) return Response.json({}, { status: 401 })
        return Response.json({
          permissions: {
            ADMINISTER: { id: "0", key: "ADMINISTER", type: "GLOBAL", havePermission: this.admins.has(token) },
          },
        })
      },
    })
  }

  async stop() {
    await this.server?.stop(true)
  }

  /** A fetcher that sends Atlassian API calls to this fake; any other host is an error. */
  readonly fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== "api.atlassian.com")
      return Promise.reject(new Error("FakeJira answers only api.atlassian.com."))
    return fetch(`${this.server!.url.origin}${url.pathname}${url.search}`, init)
  }) as typeof fetch
}
