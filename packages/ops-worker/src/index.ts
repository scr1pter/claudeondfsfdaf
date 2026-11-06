// Vector's ops Worker (WP A46): On Call checks and Release Guard watches, one Durable Object per account. Routes:
//
//   POST /internal/v1/<name>  The API's signed calls (internal.ts, protocol.ts): plan, config, release, state, suspend,
//                             erase, flags.
//   GET  /health              {ok:true}
//
// The Worker probes only https URLs on hosts the account verified, never follows a redirect, and reports to the API
// (POST <API_ORIGIN>/api/ops/worker, signed). It never logs an account, a URL or an answer.

import { INTERNAL_ACTIONS, NONCE_HEADER, OpsAccount, SIGNED_AT_HEADER, answer, failure } from "./ops-account"
import { accountHandle, internalSecret, verifyInternalSignature } from "./internal"
import { OPS_LIMITS } from "./limits"
import { OPS_INTERNAL_PREFIX } from "./protocol"
import { workersRuntime, type Env, type Runtime } from "./runtime"

export { OpsAccount }

/** The object that records nonces for calls not about one account (the kill flag). Account names are 64 hex digits. */
const CONTROL_OBJECT = "control"
const ACCOUNT = /^[\x21-\x7e]{1,128}$/

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, workersRuntime())
  },
}

export async function handleRequest(request: Request, env: Env, runtime: Runtime): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/health") return request.method === "GET" ? answer({ ok: true }) : failure(405, "OPS_METHOD")
  if (url.pathname.startsWith(OPS_INTERNAL_PREFIX)) return internal(request, env, runtime, url)
  return failure(404, "OPS_NOT_FOUND")
}

async function internal(request: Request, env: Env, runtime: Runtime, url: URL): Promise<Response> {
  if (request.method !== "POST") return failure(405, "OPS_METHOD")
  const action = url.pathname.slice(OPS_INTERNAL_PREFIX.length)
  if (!(INTERNAL_ACTIONS as readonly string[]).includes(action)) return failure(404, "OPS_NOT_FOUND")
  const secret = internalSecret(env.INTERNAL_SECRET)
  if (!secret) return failure(503, "INTERNAL_UNAVAILABLE")
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > OPS_LIMITS.internalBodyBytes) return failure(413, "INTERNAL_TOO_LARGE")
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength > OPS_LIMITS.internalBodyBytes) return failure(413, "INTERNAL_TOO_LARGE")
  const check = await verifyInternalSignature(
    secret,
    { method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body },
    runtime.now(),
  )
  if (!check.ok) return failure(401, "INTERNAL_SIGNATURE_INVALID")
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
  const stub = env.OPS_ACCOUNT.get(env.OPS_ACCOUNT.idFromName(name))
  // A fresh request: nothing the caller sent reaches the object except the checked body, its nonce and when it was signed.
  return stub.fetch(
    new Request(`https://ops.invalid/internal/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [NONCE_HEADER]: check.nonce,
        [SIGNED_AT_HEADER]: String(check.signedAt),
      },
      body: JSON.stringify(parsed),
    }),
  )
}
