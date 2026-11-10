import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { oauthJSON } from "./device"
import { OauthCallbackPage } from "./page"

export type LoopbackRegistration = {
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  redirectUri: string
  scope: string
  authorization?: Readonly<Record<string, string>>
}

/** An isolated listener/verifier per sign-in. All callback secrets remain in memory. */
export async function authorizeLoopback(
  registration: LoopbackRegistration,
  signal: AbortSignal,
  dependencies?: { fetch?: typeof fetch; timeoutMs?: number },
) {
  const redirect = new URL(registration.redirectUri)
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(redirect.hostname) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !redirect.port
  )
    throw new Error("Register a loopback callback URI for Vector before signing in.")
  for (const value of [registration.authorizeUrl, registration.tokenUrl]) {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("OAuth requires a secure provider endpoint.")
  }
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(registration.clientId))
    throw new Error("Configure Vector's owned client registration before signing in.")
  signal.throwIfAborted()
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const listener = await listenLoopback({ redirect, state, signal, timeoutMs: dependencies?.timeoutMs })
  const completion = listener.code
    .then(async (value) => {
      listener.signal.throwIfAborted()
      const result = await oauthJSON(
        registration.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: registration.clientId,
          code: value,
          redirect_uri: redirect.href,
          code_verifier: verifier,
        },
        listener.signal,
        dependencies?.fetch,
      )
      if (!result.ok || result.value.error) throw new Error("Provider sign-in could not complete. Start sign-in again.")
      listener.signal.throwIfAborted()
      return result.value
    })
    .finally(listener.close)
  void completion.catch(() => undefined)
  const url = new URL(registration.authorizeUrl)
  url.search = new URLSearchParams({
    ...registration.authorization,
    client_id: registration.clientId,
    response_type: "code",
    redirect_uri: redirect.href,
    scope: registration.scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  }).toString()
  return {
    url: url.href,
    instructions:
      "Complete authorization in a browser on this computer, then return to Vector. For a remote engine, use device sign-in or forward the callback port.",
    complete: () => completion,
    close: listener.cancel,
  }
}

/**
 * A one-use loopback callback listener on 127.0.0.1 for `redirect` (port 0 binds a free port and updates `redirect`).
 * It answers only a GET of the redirect path with this Host, compares `state` in constant time, takes one code and
 * answers any later callback 409, refuses an `error` callback, and closes on the first code, on `signal`, on `cancel`
 * or after `timeoutMs`. `signal` on the result aborts once it closes, so work that follows the code can stop with it.
 */
export async function listenLoopback(input: {
  redirect: URL
  state: string
  signal: AbortSignal
  timeoutMs?: number
  /** Who is signing in, for the errors: "Provider sign-in" unless given. */
  name?: string
  /** The callback page's provider line. */
  provider?: string
}) {
  const redirect = input.redirect
  const name = input.name ?? "Provider sign-in"
  const code = Promise.withResolvers<string>()
  let claimed = false
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store")
    response.setHeader("referrer-policy", "no-referrer")
    response.setHeader("x-content-type-options", "nosniff")
    if (request.method !== "GET" || request.headers.host !== redirect.host || (request.url?.length ?? 0) > 8192)
      return response.writeHead(400).end("Invalid callback")
    const url = URL.parse(request.url ?? "/", redirect.origin)
    if (!url || url.origin !== redirect.origin || url.pathname !== redirect.pathname)
      return response.writeHead(404).end()
    if (claimed) return response.writeHead(409).end("Authorization already received")
    const received = Buffer.from(url.searchParams.get("state") ?? "")
    const expected = Buffer.from(input.state)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return response.writeHead(400).end("Invalid authorization state")
    if (url.searchParams.has("error")) {
      claimed = true
      code.reject(new Error(`${name} was declined. Start sign-in again.`))
      return response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(OauthCallbackPage.error("The account was not connected.", { provider: input.provider }))
    }
    const value = url.searchParams.get("code")
    if (
      !value ||
      value.length > 4096 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1
    )
      return response.writeHead(400).end("Invalid authorization code")
    claimed = true
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(OauthCallbackPage.received({ provider: input.provider }))
    code.resolve(value)
  })
  // Attach rejection handling before a callback/abort can arrive.
  void code.promise.catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error("Vector could not bind its registered loopback callback. Close other sign-in attempts and retry."),
      ),
    )
    server.listen(Number(redirect.port), "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Vector could not start its loopback callback.")
  }
  redirect.port = String(address.port)
  const controller = new AbortController()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    controller.abort()
    clearTimeout(timeout)
    input.signal.removeEventListener("abort", cancel)
    server.closeAllConnections()
    server.close()
  }
  const cancel = () => {
    code.reject(new Error(`${name} was cancelled.`))
    close()
  }
  const timeout = setTimeout(
    () => {
      code.reject(new Error(`${name} timed out. Start sign-in again.`))
      close()
    },
    input.timeoutMs ?? 10 * 60_000,
  )
  timeout.unref()
  input.signal.addEventListener("abort", cancel, { once: true })
  if (input.signal.aborted) cancel()
  return { redirect, code: code.promise, signal: controller.signal, close, cancel }
}
