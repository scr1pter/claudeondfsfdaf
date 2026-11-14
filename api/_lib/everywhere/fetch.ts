import type { PlatformId } from "../../../packages/schema/src/everywhere.js"
import { ApiError } from "../http.js"

/*
 * Every outbound platform call goes through `platformFetch` (contract 6.2), which allows only that platform's own API
 * hosts, over https on the default port, with no user name or password, and never follows a redirect. A repository
 * mapping, a payload or a stored value can therefore never point the server, or a platform token, at another host.
 */

/** A host and the paths on it a platform's calls use: an entry ending in `/` is a prefix, any other is exact. */
export type PlatformHost = { readonly host: string; readonly paths: readonly string[] }

export const PLATFORM_HOSTS: Readonly<Record<PlatformId, readonly PlatformHost[]>> = {
  // REST: issue comments, draft pull requests, repository visibility, collaborator permission.
  github: [{ host: "api.github.com", paths: ["/"] }],
  // Web API methods (`chat.postMessage`, `oauth.v2.access`, `users.info`, ...).
  slack: [{ host: "slack.com", paths: ["/api/"] }],
  // GraphQL, and the OAuth token exchange and revoke.
  linear: [{ host: "api.linear.app", paths: ["/graphql", "/oauth/"] }],
  // The site's REST API through the Forge remote's API base URL, and the Forge Invocation Token keys.
  jira: [
    { host: "api.atlassian.com", paths: ["/ex/jira/"] },
    { host: "forge.cdn.prod.atlassian-dev.net", paths: ["/.well-known/jwks.json"] },
  ],
}

/** The longest a platform call may take unless the caller passes its own signal. */
export const PLATFORM_TIMEOUT_MS = 10_000
/** The largest platform answer `readPlatformJson` reads. */
export const PLATFORM_RESPONSE_LIMIT = 1024 * 1024

function pathAllowed(path: string, allowed: readonly string[]) {
  return allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry))
}

/** The parsed URL when `platform` may call it; undefined otherwise. */
export function platformUrl(platform: PlatformId, url: string | URL): URL | undefined {
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_HOSTS, platform)) return undefined
  const hosts = PLATFORM_HOSTS[platform]
  let parsed: URL
  try {
    parsed = new URL(typeof url === "string" ? url : url.href)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return undefined
  // Dot segments and encoded slashes could step outside an allowed path once a server decodes them.
  if (/%2e|%2f|%5c/i.test(parsed.pathname)) return undefined
  const entry = hosts.find((candidate) => candidate.host === parsed.hostname)
  if (!entry || !pathAllowed(parsed.pathname, entry.paths)) return undefined
  return parsed
}

function refused() {
  return new ApiError(500, "EVERYWHERE_HOST_REFUSED", "Vector everywhere refused to call that address.")
}

/**
 * Fetches a platform API URL. Refuses (before any request) a URL outside the platform's hosts and paths. Redirects
 * are errors, and the call times out after 10 s unless `init.signal` is given. `fetcher` is injected in tests.
 */
export async function platformFetch(
  platform: PlatformId,
  url: string | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const target = platformUrl(platform, url)
  if (!target) throw refused()
  return fetcher(target.href, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
  })
}

function tooLarge() {
  return new ApiError(502, "EVERYWHERE_PLATFORM_ANSWER", "A platform answered in a way Vector everywhere cannot read.")
}

/** Reads a platform's JSON answer, refusing one larger than `limit` bytes without reading the rest. */
export async function readPlatformJson(response: Response, limit = PLATFORM_RESPONSE_LIMIT): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (!reader) throw tooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw tooLarge()
  }
}
