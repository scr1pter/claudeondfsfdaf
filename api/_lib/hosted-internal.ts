import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { codiumKey } from "./codium-keys.js"
import { ApiError, readRawBody, type ApiRequest } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Signed calls between Vector's server and the services it runs (WP A37): the Remote relay and ops Workers and the
 * hosted computers, both ways. A request carries three headers:
 *
 *   x-vector-internal-timestamp   whole seconds since 1970
 *   x-vector-internal-nonce       22 to 64 base64url characters, new for every request
 *   x-vector-internal-signature   base64url HMAC-SHA256 over the canonical string, keyed by the service's key
 *
 * The canonical string is these lines joined by "\n":
 *
 *   vector-internal-v1
 *   <service>                     hosted | relay | ops
 *   <METHOD>                      upper case
 *   <path>                        the request path and query exactly as sent, starting with "/"
 *   <timestamp>
 *   <nonce>
 *   <sha256 of the body, lower-case hex>   (of zero bytes when there is no body)
 *
 * The service's key is HMAC-SHA256(secret, "vector-internal-v1/<service>"), so one shared secret never lets a request
 * signed for one service pass at another. Secrets: VECTOR_HOSTED_INTERNAL_SECRET for `hosted` and `relay`,
 * VECTOR_OPS_SHARED_SECRET for `ops`, each at least 32 characters. A receiver refuses a timestamp more than 300 s from
 * its clock and a nonce it has seen in the last 600 s (every timestamp it could still accept). Outbound calls time out
 * after 10 s and never follow a redirect. The Workers implement the same string in their own `internal.ts`.
 */

export type InternalService = "hosted" | "relay" | "ops"
export const INTERNAL_SKEW_MS = 300_000
export const INTERNAL_TIMEOUT_MS = 10_000
/** How long a seen nonce is remembered: twice the skew, so it outlives every timestamp that could carry it. */
export const INTERNAL_NONCE_KEEP_MS = 2 * INTERNAL_SKEW_MS
export const INTERNAL_HEADERS = Object.freeze({
  timestamp: "x-vector-internal-timestamp",
  nonce: "x-vector-internal-nonce",
  signature: "x-vector-internal-signature",
})
const VERSION = "vector-internal-v1"
const SERVICES: readonly InternalService[] = ["hosted", "relay", "ops"]
const NONCE = /^[A-Za-z0-9_-]{22,64}$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/

/** The configured secret for a service, or undefined when it is missing or shorter than 32 characters. */
export function internalSecret(service: InternalService) {
  const value = (
    service === "ops" ? process.env.VECTOR_OPS_SHARED_SECRET : process.env.VECTOR_HOSTED_INTERNAL_SECRET
  )?.trim()
  return value && value.length >= 32 ? value : undefined
}

/** Whether a service's internal calls can be signed and checked here. */
export function internalConfigured(service: InternalService) {
  return internalSecret(service) !== undefined
}

/** The canonical string a signature covers (see the header comment). */
export function internalCanonical(
  service: InternalService,
  input: { method: string; path: string; timestamp: number; nonce: string; body?: Uint8Array | string },
) {
  return [
    VERSION,
    service,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    createHash("sha256")
      .update(input.body ?? "")
      .digest("hex"),
  ].join("\n")
}

/** The three signature headers for one request. `path` is the path and query as they will be sent. */
export function signInternal(
  service: InternalService,
  input: { method: string; path: string; body?: Uint8Array | string; now?: number; nonce?: string; secret?: string },
): Record<string, string> {
  const secret = input.secret ?? internalSecret(service)
  if (!secret || !SERVICES.includes(service)) throw unavailable()
  if (!input.path.startsWith("/")) throw new Error("An internal request path starts with /.")
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000)
  const nonce = input.nonce ?? randomBytes(16).toString("base64url")
  if (!NONCE.test(nonce)) throw new Error("An internal request nonce is 22 to 64 base64url characters.")
  const canonical = internalCanonical(service, { ...input, timestamp, nonce })
  return {
    [INTERNAL_HEADERS.timestamp]: String(timestamp),
    [INTERNAL_HEADERS.nonce]: nonce,
    [INTERNAL_HEADERS.signature]: createHmac("sha256", serviceKey(secret, service))
      .update(canonical)
      .digest("base64url"),
  }
}

/**
 * A signed request to a service. JSON bodies are sent as given (stringify first); the answer is the plain Response.
 * It never follows a redirect and gives up after 10 s.
 */
export async function internalFetch(
  service: InternalService,
  url: string | URL,
  init: {
    method?: string
    body?: string | Uint8Array
    headers?: Readonly<Record<string, string>>
    signal?: AbortSignal
  } = {},
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response> {
  const target = new URL(String(url))
  const local =
    target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
    process.env.VERCEL_ENV !== "production" &&
    process.env.NODE_ENV !== "production"
  if (target.protocol !== "https:" && !local) throw new Error("Internal requests go to https addresses only.")
  if (target.username || target.password) throw new Error("Internal request addresses carry no credentials.")
  const method = (init.method ?? "POST").toUpperCase()
  const signed = signInternal(service, {
    method,
    path: `${target.pathname}${target.search}`,
    ...(init.body !== undefined ? { body: init.body } : {}),
    now,
  })
  const timeout = AbortSignal.timeout(INTERNAL_TIMEOUT_MS)
  return fetcher(target, {
    method,
    headers: {
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      ...init.headers,
      ...signed,
    },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : Buffer.from(init.body) } : {}),
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  })
}

export type InternalNonceCheck = (service: InternalService, nonce: string, keepMs: number) => Promise<boolean>

/** Records each nonce once (SET NX in the store); false when it was already seen. A store failure throws 503. */
export function storeNonces(fetcher: typeof fetch = fetch): InternalNonceCheck {
  return async (service, nonce, keepMs) =>
    (await persistentStore(
      ["SET", codiumKey("internal", "nonce", service, nonce), "1", "NX", "PX", keepMs],
      fetcher,
    )) === "OK"
}

/**
 * Checks a signed request: the timestamp within 300 s, the signature over the method, path, timestamp, nonce and the
 * raw body, then the nonce never seen before (checked last, so a forged request cannot use up a real nonce). Any
 * failure is 401 `INTERNAL_SIGNATURE_INVALID`; a missing secret is 503.
 */
export async function verifyInternal(
  service: InternalService,
  request: {
    method: string
    path: string
    headers: Readonly<Record<string, string | string[] | undefined>>
    body: Uint8Array | string
  },
  options: { now?: number; secret?: string; nonces?: InternalNonceCheck; fetcher?: typeof fetch } = {},
) {
  const secret = options.secret ?? internalSecret(service)
  if (!secret || !SERVICES.includes(service)) throw unavailable()
  const now = options.now ?? Date.now()
  const timestampText = header(request.headers, INTERNAL_HEADERS.timestamp)
  const nonce = header(request.headers, INTERNAL_HEADERS.nonce)
  const signature = header(request.headers, INTERNAL_HEADERS.signature)
  if (!/^\d{1,12}$/.test(timestampText) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) throw invalid()
  const timestamp = Number(timestampText)
  if (Math.abs(now - timestamp * 1000) > INTERNAL_SKEW_MS) throw invalid()
  if (!request.path.startsWith("/")) throw invalid()
  const expected = Buffer.from(
    createHmac("sha256", serviceKey(secret, service))
      .update(
        internalCanonical(service, {
          method: request.method,
          path: request.path,
          timestamp,
          nonce,
          body: request.body,
        }),
      )
      .digest("base64url"),
  )
  const provided = Buffer.from(signature)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid()
  const nonces = options.nonces ?? storeNonces(options.fetcher)
  if (!(await nonces(service, nonce, INTERNAL_NONCE_KEEP_MS))) throw invalid()
}

/**
 * For an API route a service calls: reads the raw body (the route must export
 * `config = { api: { bodyParser: false } }`), checks the signature, and answers the body.
 */
export async function requireInternalRequest(
  service: InternalService,
  request: ApiRequest,
  options: { now?: number; fetcher?: typeof fetch; limit?: number } = {},
) {
  if (!internalSecret(service)) throw unavailable()
  const body = await readRawBody(request, options.limit ?? 256 * 1024)
  await verifyInternal(
    service,
    { method: request.method ?? "GET", path: request.url ?? "", headers: request.headers, body },
    {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    },
  )
  return body
}

function serviceKey(secret: string, service: InternalService) {
  return createHmac("sha256", secret).update(`${VERSION}/${service}`).digest()
}

function header(headers: Readonly<Record<string, string | string[] | undefined>>, name: string) {
  const value = headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

function invalid() {
  return new ApiError(401, "INTERNAL_SIGNATURE_INVALID", "This internal request is not signed correctly.")
}

function unavailable() {
  return new ApiError(503, "INTERNAL_UNAVAILABLE", "This internal service is not configured.")
}
