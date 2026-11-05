// Vector Remote's relay Worker (WP A39). Routes:
//
//   GET  /v1/connect          WebSocket upgrade. The ticket comes in Sec-WebSocket-Protocol next to `vector.v1`; the
//                             Worker checks it, reads its kill flag, and hands the connection to the account's object.
//   POST /internal/v1/<name>  The API's signed calls (internal.ts): kill, suspend, presence, devices, revoke-device,
//                             erase, flags. job-offer is reserved (§4.17) and answers 501.
//   GET  /health              {ok:true}
//
// The relay forwards only ciphertext and never logs a ticket, an account or a frame.

import { AccountRelay, INTERNAL_ACTIONS, KILL_KEY, NONCE_HEADER, TICKET_HEADER, answer, failure } from "./account-relay"
import { internalSecret, verifyInternalSignature } from "./internal"
import { RELAY_LIMITS } from "./limits"
import { CLOSE, CLOSE_REASON, CONNECT_PATH, RELAY_SUBPROTOCOL } from "./protocol"
import { workersRuntime, type Env, type Runtime } from "./runtime"
import { TICKET_PREFIX, accountHandle, importTicketKeys, verifyTicket } from "./ticket"

export { AccountRelay }

/** The object that records nonces for calls not about one account (the kill flag). Account names are 64 hex digits. */
const CONTROL_OBJECT = "control"
const INTERNAL_PREFIX = "/internal/v1/"
const ACCOUNT = /^[\x21-\x7e]{1,128}$/
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, workersRuntime())
  },
}

export async function handleRequest(request: Request, env: Env, runtime: Runtime): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/health") return request.method === "GET" ? answer({ ok: true }) : failure(405, "RELAY_METHOD")
  if (url.pathname === CONNECT_PATH) return connect(request, env, runtime)
  if (url.pathname.startsWith(INTERNAL_PREFIX)) return internal(request, env, runtime, url)
  return failure(404, "RELAY_NOT_FOUND")
}

/** The offered subprotocols must be exactly `vector.v1` and one ticket, both valid tokens. */
export function offeredTicket(header: string | null): string | undefined {
  if (!header || header.length > 8192) return undefined
  const offered = header.split(",").map((value) => value.trim())
  if (offered.length !== 2 || offered.some((value) => !TOKEN.test(value))) return undefined
  if (!offered.includes(RELAY_SUBPROTOCOL)) return undefined
  const ticket = offered.find((value) => value !== RELAY_SUBPROTOCOL)
  return ticket?.startsWith(`${TICKET_PREFIX}.`) ? ticket : undefined
}

async function connect(request: Request, env: Env, runtime: Runtime): Promise<Response> {
  if (request.method !== "GET") return failure(405, "RELAY_METHOD")
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure(426, "RELAY_UPGRADE_REQUIRED")
  const ticket = offeredTicket(request.headers.get("sec-websocket-protocol"))
  if (!ticket) return failure(400, "RELAY_PROTOCOL_REQUIRED")
  const keys = await importTicketKeys(env.TICKET_PUBLIC_KEYS)
  if (!keys.length) return failure(503, "RELAY_UNAVAILABLE")
  const check = await verifyTicket(ticket, keys, runtime.now())
  if (!check.ok) return failure(401, "RELAY_TICKET_INVALID")
  const handle = await accountHandle(env.ACCOUNT_KEY, check.claims.sub)
  if (!handle) return failure(503, "RELAY_UNAVAILABLE")
  if (await killed(env)) {
    const { client, server } = runtime.pair()
    server.accept?.()
    server.close(CLOSE.RELAY_OFF, CLOSE_REASON[CLOSE.RELAY_OFF])
    return runtime.upgrade(client, { "sec-websocket-protocol": RELAY_SUBPROTOCOL })
  }
  const stub = env.ACCOUNT_RELAY.get(env.ACCOUNT_RELAY.idFromName(handle))
  // A fresh request: nothing the client sent reaches the object except the upgrade and the ticket.
  return stub.fetch(
    new Request("https://relay.invalid/connect", { headers: { upgrade: "websocket", [TICKET_HEADER]: ticket } }),
  )
}

async function internal(request: Request, env: Env, runtime: Runtime, url: URL): Promise<Response> {
  if (request.method !== "POST") return failure(405, "RELAY_METHOD")
  const action = url.pathname.slice(INTERNAL_PREFIX.length)
  if (action !== "job-offer" && !(INTERNAL_ACTIONS as readonly string[]).includes(action))
    return failure(404, "RELAY_NOT_FOUND")
  const secret = internalSecret(env.INTERNAL_SECRET)
  if (!secret) return failure(503, "INTERNAL_UNAVAILABLE")
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > RELAY_LIMITS.internalBodyBytes) return failure(413, "INTERNAL_TOO_LARGE")
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength > RELAY_LIMITS.internalBodyBytes) return failure(413, "INTERNAL_TOO_LARGE")
  const check = await verifyInternalSignature(
    secret,
    { method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body },
    runtime.now(),
  )
  if (!check.ok) return failure(401, "INTERNAL_SIGNATURE_INVALID")
  // §4.17: the envelope kind exists so a later release can offer a job to an online computer. Nothing sends it yet.
  if (action === "job-offer") return failure(501, "RELAY_JOB_OFFER_RESERVED")
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return failure(400, "INTERNAL_BAD_REQUEST")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure(400, "INTERNAL_BAD_REQUEST")
  let name = CONTROL_OBJECT
  if (action !== "flags") {
    const account = (parsed as { account?: unknown }).account
    if (typeof account !== "string" || !ACCOUNT.test(account)) return failure(400, "INTERNAL_BAD_REQUEST")
    const handle = await accountHandle(env.ACCOUNT_KEY, account)
    if (!handle) return failure(503, "INTERNAL_UNAVAILABLE")
    name = handle
  }
  const stub = env.ACCOUNT_RELAY.get(env.ACCOUNT_RELAY.idFromName(name))
  return stub.fetch(
    new Request(`https://relay.invalid/internal/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", [NONCE_HEADER]: check.nonce },
      body: JSON.stringify(parsed),
    }),
  )
}

/** The Worker's kill flag, read on every connection. A flag that cannot be read counts as set. */
async function killed(env: Env) {
  try {
    return (await env.REMOTE_FLAGS.get(KILL_KEY)) === "1"
  } catch {
    return true
  }
}
