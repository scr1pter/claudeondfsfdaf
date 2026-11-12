export * as ServerAuth from "./auth"

import { legacyName } from "@vectordevai/core/flag/legacy"
import { SessionV2 } from "@vectordevai/core/session"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import type { Principal } from "@vectordevai/protocol/middleware/authorization"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { realpathSync, statSync } from "node:fs"
import { isIP } from "node:net"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

/** Which configured credential pair a request matched. */
export type Identity = "owner" | "guest"

// Guest fields are optional so owner-only configs (and the vector package's
// twin of this service, which shares the key id) stay mutually assignable.
export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  /** Also accepted as the owner username; set only while no username is configured. */
  readonly legacyUsername?: string
  readonly guestPassword?: Option.Option<string>
  readonly guestUsername?: string
  readonly guestWorkspaceIDs?: ReadonlyArray<string>
  readonly guestWorkspaceDirectories?: Readonly<Record<string, string>>
  readonly guestSessionIDs?: ReadonlyArray<string>
}

export class Config extends Context.Service<Config, Info>()("@vector/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const config = yield* EffectConfig.all({
          password: EffectConfig.string("VECTOR_SERVER_PASSWORD").pipe(EffectConfig.option),
          username: EffectConfig.string("VECTOR_SERVER_USERNAME").pipe(EffectConfig.option),
          guestPassword: EffectConfig.string("VECTOR_SERVER_GUEST_PASSWORD").pipe(EffectConfig.option),
          guestUsername: EffectConfig.string("VECTOR_SERVER_GUEST_USERNAME").pipe(EffectConfig.withDefault("guest")),
          guestWorkspaces: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACES").pipe(EffectConfig.option),
          guestWorkspaceDirectories: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES").pipe(
            EffectConfig.option,
          ),
          guestSessions: EffectConfig.string("VECTOR_SERVER_GUEST_SESSIONS").pipe(EffectConfig.option),
        })
        return Config.of({
          password: config.password,
          guestPassword: config.guestPassword,
          guestUsername: config.guestUsername,
          guestWorkspaceIDs: claims(config.guestWorkspaces, Schema.decodeUnknownOption(WorkspaceV2.ID)),
          guestWorkspaceDirectories: directoryClaims(config.guestWorkspaceDirectories),
          guestSessionIDs: claims(config.guestSessions, Schema.decodeUnknownOption(SessionV2.ID)),
          username: Option.getOrElse(config.username, () => "vector"),
          // The earlier product defaulted the owner username to its own name, and saved
          // connections and scripts still send it. The password is still required.
          legacyUsername: Option.isNone(config.username) ? legacyName : undefined,
        })
      }),
    )
  }
}

// Any configured credential turns authentication on. Reading only the owner
// password would leave a server started with just a guest password wide open —
// the opposite of what configuring a password means.
export function required(config: Info) {
  const set = (value: Option.Option<string> | undefined) =>
    Option.match(value ?? Option.none(), { onNone: () => false, onSome: (item) => item !== "" })
  return set(config.password) || set(config.guestPassword)
}

/** The identity a credential pair matches, or undefined when it matches neither. */
export function identity(credentials: DecodedCredentials, config: Info): Identity | undefined {
  const password = Redacted.value(credentials.password)
  if (
    Option.isSome(config.password) &&
    config.password.value !== "" &&
    (credentials.username === config.username || credentials.username === config.legacyUsername) &&
    password === config.password.value
  )
    return "owner"
  const guestPassword = config.guestPassword ?? Option.none<string>()
  if (
    Option.isSome(guestPassword) &&
    guestPassword.value !== "" &&
    credentials.username === (config.guestUsername ?? "guest") &&
    password === guestPassword.value
  )
    return "guest"
  return undefined
}

// A guest invited through `vector invite` uses the same API surface as the
// owner, so the v2 routes accept either pair.
export function authorized(credentials: DecodedCredentials, config: Info) {
  return identity(credentials, config) !== undefined
}

export function principal(identity: Identity, config: Info): Principal {
  if (identity === "owner") return { kind: "owner", username: config.username }
  return {
    kind: "guest",
    username: config.guestUsername ?? "guest",
    workspaceIDs: new Set(config.guestWorkspaceIDs ?? []),
    workspaceDirectories: canonicalDirectories(config.guestWorkspaceDirectories),
    sessionIDs: new Set(config.guestSessionIDs ?? []),
  }
}

function directoryClaims(input: Option.Option<string>) {
  if (Option.isNone(input)) return {}
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.value)
  if (Option.isNone(json)) return {}
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))(json.value),
    () => ({}),
  )
}

function canonicalDirectories(input: Readonly<Record<string, string>> | undefined) {
  return new Map(
    Object.entries(input ?? {}).flatMap(([workspaceID, directory]) => {
      try {
        const canonical = realpathSync(directory)
        if (!statSync(canonical).isDirectory()) return []
        return [[workspaceID, canonical] as const]
      } catch {
        return []
      }
    }),
  )
}

export function ownerPrincipal(config: Info): Principal {
  return { kind: "owner", username: config.username }
}

const guestBootstrapRoutes = new Set([
  "/global/health",
  "/global/event",
  "/global/config",
  "/project",
  "/project/current",
])

// The guest gate judges the route the router matched, never the request path: the router ignores case, repeated
// and trailing slashes and anything after ';' or '?', and a URL parser reads a leading '//' as a host and resolves
// '..', so any re-parsed spelling of an owner-only route can differ from the route that actually runs.
// A guest is refused every owner-only route, and so are owner credentials carrying the forwarded-guest marker
// (`forwarded`), except a warp's steal. There the marker, which engines before WP28 send, says a guest worked in the
// session on the sending engine, and its handler takes the request as a guest's: it refuses a private session and
// records guest input before the move. The marker therefore only narrows what the same credentials may do without it,
// and the replica the warp has already replayed keeps its guest provenance.
export const refusedRequest = Effect.fnUntraced(function* (guest: boolean, forwarded: boolean) {
  if (!guest && !forwarded) return false
  const request = yield* HttpServerRequest.HttpServerRequest
  const route = yield* HttpRouter.RouteContext
  if (!guest && request.method === "POST" && route.route.path === "/sync/steal") return false
  return isOwnerOnlyRoute(request.method, route.route.path)
})

/** Whether a guest is refused `route`, the matched route's declared path pattern (e.g. `/session/:sessionID/shell`). */
export function isOwnerOnlyRoute(method: string, route: string) {
  if (route === "/experimental/workflow/saved" || route === "/experimental/workflow/validate") return true
  if (method === "POST" && /^\/experimental\/session\/[^/]+\/workflow(?:\/[^/]+\/resume)?$/.test(route)) return true
  if (route === "/api/session/import" || /\/session\/[^/]+\/share(?:\/|$)/.test(route)) return true
  if (route.startsWith("/api/pty") || route.startsWith("/pty")) return true
  // The session shell route runs its command on the host with no permission prompt, and a slash
  // command can run its template's shell snippets, so both are as powerful as a terminal. init runs the
  // init command, which the owner's config can replace with a template of its own.
  if (/\/session\/[^/]+\/(?:shell|command|init)(?:\/|$)/.test(route)) return true
  // Approving a permission request is how a session crosses the workspace boundary (an outside
  // directory, a guarded file), so only the owner may answer one, even for a guest's own session.
  if (/\/permission\/[^/]+\/reply(?:\/|$)/.test(route) || /\/session\/[^/]+\/permissions\//.test(route)) return true
  // The v2 request lists span every session on the server. A guest reads its own through the
  // session-scoped routes instead.
  if (route.startsWith("/api/permission/request") || route.startsWith("/api/question/request")) return true
  if (route.startsWith("/api/credential") || route.startsWith("/api/permission/saved")) return true
  // Memory is the owner's own: their rules, what they told Vector about themselves and what it learned in their work.
  if (route === "/memory" || route.startsWith("/memory/")) return true
  // Vector Local is the owner's: its settings, the model servers they listed, the services they allowed and the
  // network log of every session. Reading the log would show a guest where the owner's other sessions went.
  if (route === "/local" || route.startsWith("/local/")) return true
  // The held prompt files are paths in the owner's home, and approving them loads what an agent may have written there.
  if (route === "/config/prompt-trust" || route.startsWith("/config/prompt-trust/")) return true
  // Connected tools expose repository findings and can start work: every method requires the owner.
  if (
    route === "/experimental/connect" ||
    route.startsWith("/experimental/connect/") ||
    /^\/experimental\/session\/[^/]+\/connect$/.test(route)
  )
    return true
  if (route.startsWith("/experimental/project/") && route.includes("/copy")) return true
  // Creating a worktree runs the project's start command and an extra startup command from the request, and removing
  // or resetting one discards the owner's work in a directory outside the guest's workspace.
  if (route.startsWith("/experimental/worktree")) return method !== "GET" && method !== "HEAD"
  // Committing and switching branches run the repository's git hooks, programs that run as the owner.
  if (route === "/vcs/commit" || route === "/vcs/switch") return true
  // Merging writes an isolated subagent's changes into the owner's checkout, and discarding deletes its worktree.
  if (/\/experimental\/session\/[^/]+\/tasks\/[^/]+\/(?:merge|discard)$/.test(route)) return true
  if (
    route.startsWith("/global/") ||
    route === "/experimental/console" ||
    route.startsWith("/experimental/console/") ||
    route.startsWith("/experimental/control-plane") ||
    route.startsWith("/experimental/workspace") ||
    route.startsWith("/project") ||
    route.startsWith("/sync") ||
    route.startsWith("/tui")
  )
    // The app loads from these, so a guest may read them; their handlers narrow what a guest sees to its workspace.
    return !((method === "GET" || method === "HEAD") && guestBootstrapRoutes.has(route))
  if (method === "GET" || method === "HEAD") return false
  return (
    route.startsWith("/api/integration") ||
    route.startsWith("/auth/") ||
    route.startsWith("/provider/") ||
    route.startsWith("/mcp") ||
    route === "/config" ||
    route.startsWith("/config/") ||
    route === "/instance/dispose"
  )
}

/**
 * A listener receives the password in every plain HTTP request, so it accepts one only on loopback, or on a network
 * its operator marked trusted with --trusted-network, matching `vector serve`. Clients may still send a password to
 * the user's own network (see assertSecurePasswordTransport), where the operator made that choice.
 */
export function assertSecurePasswordListen(hostname: string, password: string | undefined, trustedNetwork: boolean) {
  if (!password || trustedNetwork || isLoopbackHostname(hostname)) return
  throw new Error(
    `Refusing to accept the server password over plain HTTP on ${hostname}. On a network you trust, such as a container bridge or a private LAN, pass --trusted-network; otherwise bind loopback behind a TLS reverse proxy or tunnel.`,
  )
}

export function assertSecurePasswordTransport(target: string | URL, password: string | undefined) {
  if (!password) return
  if (typeof target === "string" && !target.includes("://")) {
    if (isLocalNetworkHostname(target)) return
    throw new Error(`Refusing to send or accept a reusable password over cleartext transport to ${target}`)
  }
  const url = target instanceof URL ? target : new URL(target)
  if (url.protocol === "https:" || url.protocol === "wss:" || isLocalNetworkHostname(url.hostname)) return
  throw new Error(`Refusing to send or accept a reusable password over cleartext transport to ${url.hostname}`)
}

export function unauthorizedMessage(credentials: DecodedCredentials, config: Info) {
  const guestPassword = config.guestPassword ?? Option.none<string>()
  const usernames = [
    ...(Option.isSome(config.password) && config.password.value !== "" ? [config.username] : []),
    ...(Option.isSome(guestPassword) && guestPassword.value !== "" ? [config.guestUsername ?? "guest"] : []),
  ]
  if (
    !credentials.username ||
    credentials.username === config.legacyUsername ||
    usernames.includes(credentials.username)
  )
    return "Authentication required"
  return `Authentication required. Use the configured server username: ${usernames.join(" or ")}.`
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.VECTOR_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.VECTOR_SERVER_USERNAME ?? "vector"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

function claims<A extends string>(input: Option.Option<string>, decode: (input: unknown) => Option.Option<A>) {
  if (Option.isNone(input)) return []
  return input.value
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .flatMap((value): A[] => Option.match(decode(value), { onNone: () => [], onSome: (claim) => [claim] }))
}

function isLocalNetworkHostname(input: string) {
  const hostname = input
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (isLoopbackHostname(hostname)) return true
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".").map(Number)
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    )
  }
  if (isIP(hostname) === 6) return /^f[cd][0-9a-f]{2}:/.test(hostname) || /^fe[89ab][0-9a-f]:/.test(hostname)
  if (hostname.includes(":")) return false
  return !hostname.includes(".") || /\.(?:local|lan|home|internal|home\.arpa)$/.test(hostname)
}

function isLoopbackHostname(input: string) {
  const hostname = input
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (hostname === "localhost") return true
  if (isIP(hostname) === 4) return hostname.startsWith("127.")
  if (isIP(hostname) !== 6) return false
  const normalized = new URL(`http://[${hostname}]`).hostname
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(normalized)
}
