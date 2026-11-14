import { ABUSE_RATE_LIMIT_SCRIPT } from "../api/_lib/abuse"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"

// WP A33's fakes: the store (the Upstash REST commands the report tracker and the rate limiter send), the owner's
// email (Resend) and a request runner. Nothing here reaches a network: an unexpected address throws.

export const REPORT_KV_URL = "https://kv.support-reports.invalid"
export const ENVIRONMENT = {
  KV_REST_API_URL: REPORT_KV_URL,
  KV_REST_API_TOKEN: "fixture-kv-token",
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  CODIUM_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: undefined,
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  VECTOR_CLI_TOKEN_SECRET: "report-fixture-cli-secret-".padEnd(48, "x"),
  VECTOR_ABUSE_SECRET: "report-fixture-abuse-secret-".padEnd(48, "x"),
  RESEND_API_KEY: "re_fixture",
  RESEND_BASE_URL: undefined,
  VECTOR_PURCHASE_EMAIL_FROM: "Vector <reports@example.invalid>",
  VECTOR_BUG_REPORT_TO: "owner@example.invalid",
} as const

/** Sets ENVIRONMENT (plus overrides) and returns the function that puts the previous environment back. */
export function reportEnvironment(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = { ...ENVIRONMENT, ...overrides }
  const original = new Map(Object.keys(values).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return () =>
    original.forEach((value, name) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
}

type Entry = { kind: "string"; value: string } | { kind: "set"; value: Set<string> }

export class ReportStore {
  readonly data = new Map<string, Entry>()
  readonly expires = new Map<string, number>()
  readonly commands: string[][] = []
  now = Date.now()
  /** Commands for which this returns true fail, as an unreachable store answers. */
  fail: (command: readonly string[]) => boolean = () => false

  private live(key: string) {
    const at = this.expires.get(key)
    if (at !== undefined && at <= this.now) {
      this.data.delete(key)
      this.expires.delete(key)
    }
    return this.data.get(key)
  }

  get(key: string) {
    const entry = this.live(key)
    return entry?.kind === "string" ? entry.value : undefined
  }

  members(key: string) {
    const entry = this.live(key)
    return entry?.kind === "set" ? [...entry.value] : []
  }

  ttl(key: string) {
    if (!this.live(key)) return -2
    const at = this.expires.get(key)
    return at === undefined ? -1 : at - this.now
  }

  keys() {
    return [...this.data.keys()].filter((key) => this.live(key))
  }

  command(input: readonly unknown[]): unknown {
    const command = input.map(String)
    this.commands.push(command)
    if (this.fail(command)) throw new Error("store down")
    const [name, ...args] = command
    switch (name) {
      case "GET":
        return this.get(args[0]!) ?? null
      case "MGET":
        return args.map((key) => this.get(key) ?? null)
      case "SET": {
        const [key, value, ...options] = args
        const exists = Boolean(this.live(key!))
        if ((options.includes("NX") && exists) || (options.includes("XX") && !exists)) return null
        const keep = options.includes("KEEPTTL") ? this.expires.get(key!) : undefined
        this.data.set(key!, { kind: "string", value: value! })
        this.expires.delete(key!)
        const px = options.indexOf("PX")
        if (px >= 0) this.expires.set(key!, this.now + Number(options[px + 1]))
        else if (keep !== undefined) this.expires.set(key!, keep)
        return "OK"
      }
      case "DEL":
        return args.reduce((count, key) => {
          const existed = Boolean(this.live(key))
          this.data.delete(key)
          this.expires.delete(key)
          return count + (existed ? 1 : 0)
        }, 0)
      case "SADD": {
        const entry = this.live(args[0]!)
        const set = entry?.kind === "set" ? entry.value : new Set<string>()
        if (!entry) this.data.set(args[0]!, { kind: "set", value: set })
        const before = set.size
        args.slice(1).forEach((member) => set.add(member))
        return set.size - before
      }
      case "SREM": {
        const entry = this.live(args[0]!)
        if (entry?.kind !== "set") return 0
        const removed = args.slice(1).filter((member) => entry.value.delete(member)).length
        if (!entry.value.size) this.data.delete(args[0]!)
        return removed
      }
      case "SMEMBERS":
        return this.members(args[0]!)
      case "PEXPIRE":
        if (!this.live(args[0]!)) return 0
        this.expires.set(args[0]!, this.now + Number(args[1]))
        return 1
      case "EVAL": {
        // The rate limiter's counter, the only script these routes send.
        if (args[0] !== ABUSE_RATE_LIMIT_SCRIPT) throw new Error(`Unexpected script ${args[0]?.slice(0, 60)}`)
        const key = args[2]!
        const count = Number(this.get(key) ?? 0) + 1
        const ttl = this.expires.get(key)
        this.data.set(key, { kind: "string", value: String(count) })
        if (count === 1) this.expires.set(key, this.now + Number(args[3]) * 1000)
        else if (ttl !== undefined) this.expires.set(key, ttl)
        return [count, Math.ceil(((this.expires.get(key) ?? this.now) - this.now) / 1000)]
      }
    }
    throw new Error(`Unexpected store command ${name}`)
  }
}

export type SentEmail = {
  from: string
  to: string | string[]
  subject: string
  text: string
  html?: string
  reply_to?: unknown
}

/** The store, the owner's email and the `fetch` that reaches only them. */
export function reportFakes() {
  const store = new ReportStore()
  const mail = { sent: [] as SentEmail[], fail: false }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body = init?.body === undefined || init.body === null ? "" : String(init.body)
    if (url.origin === REPORT_KV_URL) {
      try {
        return Response.json({ result: store.command(JSON.parse(body) as unknown[]) })
      } catch {
        return new Response("unavailable", { status: 503 })
      }
    }
    if (url.href === "https://api.resend.com/emails" && init?.method === "POST") {
      if (mail.fail)
        return Response.json({ name: "application_error", message: "Fixture email failure" }, { status: 500 })
      mail.sent.push(JSON.parse(body) as SentEmail)
      return Response.json({ id: `email_${mail.sent.length}` })
    }
    throw new Error(`Unexpected request to ${url.origin}`)
  }) as typeof fetch
  return { store, mail, fetcher }
}

export async function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  request: { method?: string; headers?: Record<string, string>; body?: unknown },
) {
  const headers: Record<string, string> = {}
  return new Promise<{ status: number; headers: Record<string, string>; body: any }>((resolve, reject) => {
    const target = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value)
        return target
      },
      end(value?: string) {
        resolve({ status: target.statusCode, headers, body: value ? JSON.parse(value) : undefined })
        return target
      },
    }
    void handler(
      { method: "POST", ...request, headers: request.headers ?? {} } as unknown as ApiRequest,
      target as unknown as ApiResponse,
    ).catch(reject)
  })
}

export const jsonHeaders = (ip: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-forwarded-for": ip,
  ...extra,
})
