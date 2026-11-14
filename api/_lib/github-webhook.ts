import { createHmac, timingSafeEqual } from "node:crypto"
import { codiumKey } from "./codium-keys.js"
import { ApiError, json, readRawBody, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The shared GitHub webhook router (contract WP A47 and §4.18 amendment 14; the handler shape is Codex's
 * vector-at-mention spec 2.14). The GitHub App sends every webhook to `POST /api/github/webhook`, and each part of Vector
 * that needs GitHub's events registers a handler here instead of running its own route: Codium's ops handler
 * (`github-webhook-handlers/ops.ts`) and Codex's cloud-agents handler (`github-webhook-handlers/cloud-agents.ts`, added
 * to the route's list by the integration commit, A59).
 *
 * A delivery goes through, in order:
 * 1. the signature: `x-hub-signature-256` is HMAC-SHA256 over the raw body under VECTOR_GITHUB_APP_WEBHOOK_SECRET,
 *    compared in constant time (S4). Nothing is parsed or stored before it passes;
 * 2. the event filter: a `ping`, or an event no handler named, is answered 200 at once. This runs before any store read,
 *    so the events GitHub sends that nobody uses cost nothing;
 * 3. the dedupe by `x-github-delivery`: the delivery is marked pending (SET NX, 60 s), so a delivery sent twice at once
 *    runs once, and done (7 days) once every handler finished. GitHub never redelivers on its own; a redelivery someone
 *    asks for carries the same id, so a finished one is answered 200 and not run again. When any handler fails, the mark
 *    is removed and the answer is 500, so a later redelivery runs every handler again (handlers are idempotent);
 * 4. the handlers that named the event, at once, each with its own copy of the payload and at most 8 s, inside GitHub's
 *    10-second wait.
 *
 * Handlers are idempotent and never throw on a payload they do not recognise: they ignore it. They throw only when
 * something they need is unavailable (the store, say), which makes the delivery fail so it can be sent again. Nothing
 * here logs a payload; a failing handler is logged by its id, the delivery id and the error code.
 */

/** One delivery, as every handler receives it (vector-at-mention spec 2.14). */
export type GithubWebhookEvent = {
  name: string
  action?: string
  deliveryId: string
  payload: Record<string, unknown>
}
/** A part of Vector that takes GitHub's events: the events it wants by name, and what it does with each. */
export type GithubWebhookHandler = {
  id: string
  events: readonly string[]
  handle(event: GithubWebhookEvent): Promise<void>
}

/**
 * The events the GitHub App subscribes to (owner step 14; Codex's spec 2.11.6). A handler naming any other event is
 * refused when the route loads, since GitHub would never send it.
 */
export const GITHUB_APP_WEBHOOK_EVENTS = [
  "installation",
  "installation_repositories",
  "repository",
  "pull_request",
  "deployment_status",
] as const

export const GITHUB_WEBHOOK_LIMITS = {
  /** GitHub caps a payload at 25 MB; nothing the handlers read comes near this. Larger bodies get 413. */
  bodyBytes: 2 * 1024 * 1024,
  /** Each handler's time, inside the 10 s GitHub waits for an answer. */
  handlerMs: 8_000,
  /** How long a delivery stays marked as running, so a second copy waits instead of running alongside. */
  pendingMs: 60_000,
  /** How long a finished delivery's id is kept. GitHub lets a delivery be redelivered for 3 days. */
  keepMs: 7 * 24 * 60 * 60_000,
  /** The secret's shortest accepted length. */
  secretChars: 32,
} as const

const HANDLER_ID = /^[a-z][a-z0-9-]{0,39}$/
const EVENT = /^[a-z][a-z_]{0,63}$/
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/
const ACTION = /^[a-z][a-z_]{0,63}$/
const SIGNATURE = /^sha256=([0-9a-f]{64})$/

/** VECTOR_GITHUB_APP_WEBHOOK_SECRET when it is set and long enough; undefined otherwise (the route answers 503). */
export function githubWebhookSecret(env: Record<string, string | undefined> = process.env) {
  const value = env.VECTOR_GITHUB_APP_WEBHOOK_SECRET?.trim()
  return value && value.length >= GITHUB_WEBHOOK_LIMITS.secretChars ? value : undefined
}

/** The `x-hub-signature-256` value GitHub sends for `body` under `secret`. */
export function githubSignature(body: Uint8Array | string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

/** Whether `header` is GitHub's signature of exactly these bytes under `secret`, compared in constant time. */
export function verifyGithubSignature(body: Uint8Array, header: unknown, secret: string) {
  const supplied = typeof header === "string" ? SIGNATURE.exec(header.trim().toLowerCase())?.[1] : undefined
  if (!supplied) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(Buffer.from(supplied, "hex"), expected)
}

/** The store key that dedupes one delivery, under the Codium prefix. */
export function githubDeliveryKey(deliveryId: string) {
  return codiumKey("github", "delivery", deliveryId)
}

/**
 * The handlers as the route runs them, checked once when it loads: each id unique and well formed, and each event one
 * the App subscribes to, named once. A mistake here is a deployment error, not a delivery error.
 */
export function checkGithubWebhookHandlers(handlers: readonly GithubWebhookHandler[]) {
  const ids = new Set<string>()
  for (const handler of handlers) {
    if (!HANDLER_ID.test(handler.id) || ids.has(handler.id))
      throw new Error(`GitHub webhook handler id "${handler.id}" is malformed or used twice.`)
    ids.add(handler.id)
    if (
      !handler.events.length ||
      new Set(handler.events).size !== handler.events.length ||
      handler.events.some((event) => !(GITHUB_APP_WEBHOOK_EVENTS as readonly string[]).includes(event))
    )
      throw new Error(`GitHub webhook handler "${handler.id}" names an event the GitHub App does not subscribe to.`)
    if (typeof handler.handle !== "function") throw new Error(`GitHub webhook handler "${handler.id}" cannot handle.`)
  }
  return Object.freeze([...handlers])
}

/** Every event name some handler takes: the filter in step 2. */
export function githubWebhookEvents(handlers: readonly GithubWebhookHandler[]) {
  return new Set(handlers.flatMap((handler) => handler.events))
}

export type GithubWebhookRouteOptions = {
  handlers: readonly GithubWebhookHandler[]
  fetcher?: typeof fetch
  secret?: () => string | undefined
  handlerMs?: number
}

/** The route: `createGithubWebhookRoute({handlers})` is `api/github/webhook.ts`'s default export. */
export function createGithubWebhookRoute(options: GithubWebhookRouteOptions) {
  const handlers = checkGithubWebhookHandlers(options.handlers)
  const events = githubWebhookEvents(handlers)
  return async function githubWebhook(request: ApiRequest, response: ApiResponse) {
    response.setHeader("x-content-type-options", "nosniff")
    try {
      await deliver(request, response, {
        handlers,
        events,
        fetcher: options.fetcher ?? fetch,
        secret: (options.secret ?? githubWebhookSecret)(),
        handlerMs: options.handlerMs ?? GITHUB_WEBHOOK_LIMITS.handlerMs,
      })
    } catch (error) {
      if (!request.readableEnded) {
        response.setHeader("connection", "close")
        request.resume()
      }
      const known =
        error instanceof ApiError
          ? error
          : new ApiError(500, "GITHUB_WEBHOOK_FAILED", "This GitHub delivery could not be handled.")
      if (known.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(known.retryAfterSeconds))
      json(response, known.statusCode, { error: { code: known.code, message: known.message } })
    }
  }
}

async function deliver(
  request: ApiRequest,
  response: ApiResponse,
  input: {
    handlers: readonly GithubWebhookHandler[]
    events: ReadonlySet<string>
    fetcher: typeof fetch
    secret: string | undefined
    handlerMs: number
  },
) {
  if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
  if (!input.secret)
    throw new ApiError(503, "GITHUB_WEBHOOK_UNAVAILABLE", "GitHub webhooks are not configured on this server.")
  const raw = await readRawBody(request, GITHUB_WEBHOOK_LIMITS.bodyBytes)
  if (!verifyGithubSignature(raw, header(request, "x-hub-signature-256"), input.secret))
    throw new ApiError(401, "GITHUB_WEBHOOK_SIGNATURE_INVALID", "This GitHub delivery is not signed correctly.")
  const name = header(request, "x-github-event")
  const deliveryId = header(request, "x-github-delivery")
  if (!name || !EVENT.test(name) || !deliveryId || !DELIVERY.test(deliveryId))
    throw new ApiError(400, "GITHUB_WEBHOOK_INVALID", "This GitHub delivery is missing its event or delivery id.")
  // Step 2: answered before anything is parsed or stored.
  if (name === "ping" || !input.events.has(name)) return json(response, 200, { ok: true, ignored: true })
  const text = Buffer.from(raw).toString("utf8")
  const first = parseObject(text)
  if (!first) throw new ApiError(400, "GITHUB_WEBHOOK_INVALID", "This GitHub delivery's body is not a JSON object.")
  const action = typeof first.action === "string" && ACTION.test(first.action) ? first.action : undefined

  // Step 3.
  const key = githubDeliveryKey(deliveryId)
  if (!(await mark(key, input.fetcher))) {
    const state = await persistentStore(["GET", key], input.fetcher)
    if (state === "done") return json(response, 200, { ok: true, duplicate: true })
    throw new ApiError(
      409,
      "GITHUB_DELIVERY_IN_PROGRESS",
      "This GitHub delivery is being handled. Try again shortly.",
      {
        retryAfterSeconds: Math.ceil(GITHUB_WEBHOOK_LIMITS.pendingMs / 1000),
      },
    )
  }

  // Step 4. Each handler gets its own copy, so one cannot change what another sees.
  const matched = input.handlers.filter((handler) => handler.events.includes(name))
  const results = await Promise.allSettled(
    matched.map((handler, index) =>
      within(
        handler.handle({
          name,
          ...(action ? { action } : {}),
          deliveryId,
          payload: index === 0 ? first : parseObject(text)!,
        }),
        input.handlerMs,
      ),
    ),
  )
  const failed = results.flatMap((result, index) => (result.status === "rejected" ? [{ index, result }] : []))
  if (failed.length) {
    for (const { index, result } of failed)
      console.error("Vector GitHub webhook handler failed", {
        handler: matched[index]!.id,
        delivery: deliveryId,
        code: result.reason instanceof ApiError ? result.reason.code : "error",
      })
    // The mark goes, so a redelivery runs every handler again; a failure to remove it only delays that by 60 s.
    await persistentStore(["DEL", key], input.fetcher).catch(() => undefined)
    throw new ApiError(500, "GITHUB_WEBHOOK_FAILED", "This GitHub delivery could not be handled. Redeliver it later.")
  }
  await persistentStore(["SET", key, "done", "PX", GITHUB_WEBHOOK_LIMITS.keepMs], input.fetcher).catch(() => undefined)
  json(response, 200, { ok: true })
}

/** Marks the delivery as running; false when it is already running or done. A store failure throws 503. */
async function mark(key: string, fetcher: typeof fetch) {
  const result = await persistentStore(["SET", key, "pending", "NX", "PX", GITHUB_WEBHOOK_LIMITS.pendingMs], fetcher)
  return result === "OK"
}

function within(work: Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(504, "GITHUB_WEBHOOK_TIMEOUT", "A handler ran out of time.")), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}
