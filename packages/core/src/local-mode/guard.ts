export * as EgressGuard from "./guard"

import dns from "node:dns"
import fs from "node:fs"
import http from "node:http"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import { fileURLToPath } from "node:url"
import workerThreads from "node:worker_threads"
import { Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { InstallationLocal } from "../installation/version"
import { EgressAttribution } from "./attribution"
import { ForwardProxy } from "./forward-proxy"
import { LocalPolicy } from "./policy"

// The backstop under Vector Local's labelled call sites. This is the one place Vector patches globals on purpose. It is
// the first import of every entry point (the CLI, the TUI's engine thread, the desktop's engine and main process, and
// the brain's background reader), so no module captures an original before it is wrapped.
//
// It wraps fetch (and fetch.preconnect), WebSocket, Bun.connect, `net.Socket.prototype.connect` (which net, tls,
// node:https and Node's own fetch use) and, under Bun, the start of a node:http client request, whose client goes
// through Bun's native fetch past the other wraps. Each connection is decided by its destination before it is made:
// - A labelled call site (Egress.fetch, EgressHttpClient, the research browsers' proxy) decides its own request and
//   runs it in an attribution scope that grants that request's destinations; only those pass as that request, so
//   code that runs inside an inherited scope cannot reach an unrelated host.
// - Anything else is purpose `unknown`: with Vector Local on it reaches only this computer and the model servers on
//   the list, and is otherwise blocked and logged with the first stack frame outside this file.
// - fetch follows redirects itself, so every hop is decided before it is made.
// - A proxy is decided as a way off this computer: fetch is decided on its target URL before it reaches a proxy, and
//   at the socket layer a connection to a configured proxy (HTTP(S)_PROXY, ALL_PROXY, a fetch's `proxy` option) counts
//   as the internet, so an unlabelled request through a corporate proxy is still blocked. Node only uses the proxy
//   environment once `http.setGlobalProxyFromEnv` ran; treating the proxy as the internet is right either way.
// - Only a request for the internet may go through the proxy environment. One for this computer or your network (a
//   local model's prompt included) goes direct: its host joins NO_PROXY before it is sent (`direct`), in the exact
//   spelling Bun matches, which fetch reads at each request, and the proxy is never granted to it, so a client that
//   still sends it there (Node's node:http agent reads the environment once) is refused at the socket. Under Bun,
//   whose fetch and node:http client reach a proxy natively, past the socket wrap, a request for this computer or
//   your network that the proxy environment would still carry, as Bun reads it, is refused before it is sent, and
//   logged as refused, never as sent.
// - A Bun worker's fetch does not read the proxy settings its own process.env shows (Bun 1.3). It reads its starting
//   thread's as they were when it started, except that a variable the process started with keeps the value it
//   started with; and given an `env`, as every Worker the guard wraps is, it ignores both that and what the worker
//   writes later. So in a worker `carried` reads the settings its starting thread worked out for it
//   (`fetchEnvironment`), and `direct` there changes nothing for its own fetch. Before a Worker starts, its starting
//   thread puts this computer, and while Vector Local is on the model servers on the list, on its NO_PROXY, which
//   reaches the worker unless the process started with NO_PROXY set. A request the worker's settings would still send
//   to a proxy, such as one for a server listed after it started, is refused there with the NO_PROXY advice.
// - A model server on the list whose name is an internet name (`gpu.corp.example.com`) counts as the internet here, so
//   it may go through the company's proxy like any other request for the internet. Whether a listed server should go
//   direct whatever its name is the owner's decision; until then this is how it works.
// - A name allowed because its name says where it is (`localhost`, `nas.local`, `box.tail1.ts.net`) must resolve
//   there: a socket's lookup that answers outside is refused before anything connects, and fetch and Bun.connect
//   look the name up first. A name on the model server list is decided on the list instead, since a company's
//   `gpu.internal` may sit on its own public range; a loopback name must still resolve to loopback.
// - fetch reaches only http, https, file, data and blob addresses; any other scheme (Bun's s3:, whose name is a bucket
//   and not where it connects) is refused while the guard decides connections.
// - Under Bun, every Worker started through the global `Worker` or the `node:worker_threads` module object preloads
//   these same wraps (guard-worker.ts) before its own code runs, with Vector Local on or off, and gets the policy in
//   effect through its environment. The threads of a process then keep one policy and one log between them (Egress),
//   so a Worker's blocked connection is in the log the app reads, and a policy that changes reaches every thread. A
//   worker entry that seals itself (`backstop-worker.ts`, the brain's reader) puts the strict guard in place of the
//   one the preload installed (`unfollow`), and a Worker started in a sealed thread is sealed too.
// With Vector Local off, each wrap costs one call and logs nothing; a Worker still preloads the wraps, to follow.
//
// Strict mode, for tests (VECTOR_TEST_EGRESS=strict), refuses any connection off this computer and throws. Under Bun it
// also runs a proxy of its own on 127.0.0.1 and points the proxy environment at it for every name but loopback's
// (`127.0.0.1`, `localhost`, `[::1]` go direct), so Bun.fetch, a fetch captured before the guard was installed,
// node:http and a Worker's fetch are refused too, and it preloads its wraps in Workers started through the global
// `Worker` or the `node:worker_threads` module object. Node needs no such proxy: its fetch, node:http and WebSocket
// all connect through net, which the socket wrap decides. Node has no preload either, so a Node worker is guarded
// when its entry imports `backstop-worker.ts` first, as the brain's reader does. The variables that ask for strict
// mode (ENVIRONMENT) are read only from a source checkout, never in a release build or the desktop app, and never
// where the environment turns Vector Local on (`strictFromEnvironment`): the agent can set them for a nested `vector`,
// and they would loosen it.
//
// Neither mode covers:
// - UDP and DNS lookups themselves, and the connections of child processes (the programs the agent runs make their
//   own; in strict mode a child that keeps the proxy environment has its HTTP refused, but not its raw sockets);
// - Bun.fetch, which Bun makes read-only, and a fetch or WebSocket class captured before install, outside strict mode
//   (in strict mode Bun.fetch and a captured fetch go through the guard's proxy, but a captured WebSocket class
//   connects directly, since Bun's WebSocket does not read the proxy environment). Vector's own code never calls
//   Bun.fetch, which a test checks, and the guard is the first import of every entry point. Under Bun the `undici`
//   package's fetch is Bun.fetch, so the requests of the libraries that use it, such as @actions/github's Octokit
//   (`vector github`), are not seen either;
// - a Bun.connect captured before install, including `import { connect } from "bun"`;
// - Bun.SQL (postgres) and Bun.RedisClient, which connect natively;
// - in strict mode, Bun.fetch once a test sets NO_PROXY or a proxy variable of its own after install;
// - under Bun, a proxy variable or NO_PROXY that was deleted from the environment and set again: Bun's fetch never sees
//   the new value, so the guard empties a variable rather than deleting it, and nothing in Vector deletes one;
// - under Bun, a Worker class imported by name from node:worker_threads (`import { Worker } from ...`), even in a
//   module loaded after install, since Bun does not update named imports of built-in modules. In strict mode its fetch
//   still goes through the strict proxy. A worker entry that imports `backstop-worker.ts` first, as the brain's reader
//   does, is guarded however it was started. Under Node, named imports loaded after install see the wrapped class;
// - under Node, a Worker whose entry does not import `backstop-worker.ts` first, with Vector Local on: Node has no
//   preload, and the desktop's engine starts no worker but the brain's reader. Under Bun, a Worker in a build whose
//   worker preload is missing while Vector Local is on (the CLI's build carries it; strict mode refuses the worker);
// - under Bun, the lookup of a name a node:http client request uses: that request is decided by its name only;
// - under Bun, the lookup fetch makes itself after the guard checked a name allowed by its name: Bun's fetch cannot be
//   told to connect to the address the guard checked without changing the URL the caller sees, so a resolver that
//   answers differently the second time is not caught there (Node's sockets connect to the address they checked);
// - under Bun, the npm `ws` package: Bun replaces it with its own client, which keeps a WebSocket class of its own and
//   reads no global, so a `ws` socket is never seen here. Its one call site, the OpenAI plugin's ws.ts, decides each
//   socket itself before it opens (and phase L5's model-call gate decides the request first). Under Node, `ws`
//   connects through net and is decided.

export class EgressBlocked extends Error {
  override readonly name = "EgressBlocked"
  constructor(
    readonly host: string,
    readonly kind: Attempt["kind"],
    readonly rule?: LocalMode.Rule,
    reason?: string,
  ) {
    super(
      reason
        ? `Vector Local blocked a connection to ${host}. ${reason}`
        : `Vector blocked a connection to ${host}: only this computer is reachable here.`,
    )
  }
}

export type Attempt = {
  /** `proxied` is a request a client sent through the strict guard's own proxy. */
  readonly kind: "fetch" | "socket" | "http" | "websocket" | "proxied"
  readonly host: string
  readonly port?: number
  /** The origin, never the path or query. */
  readonly url?: string
  readonly method?: string
  readonly allowed: boolean
}

/** A connection the guard decided itself while Vector Local is on, for the network log. */
export type Recorded = {
  readonly attempt: Attempt
  readonly verdict: LocalPolicy.Verdict
  readonly scope: EgressAttribution.Scope | undefined
  /** For a blocked connection: the first stack frame outside the guard. */
  readonly frame?: string
}

export type Options = {
  /** The policy in effect, read at every connection. */
  readonly policy: () => LocalMode.Policy
  /** Gets each connection the guard decided itself, except the ones it allowed to this computer. */
  readonly record?: (input: Recorded) => void
}

export type StrictOptions = {
  /** Names the caller pins to this computer itself, such as a test resolver's `*.web.test`. */
  readonly names?: readonly string[]
  /**
   * Whether to run the guard's own proxy and point the proxy environment at it, under Bun. Off in a Worker, which
   * reaches its parent's proxy through the environment it shares. Under Node there is never one: everything there
   * connects through the socket wrap, and Node binds a server only after `listen` returns.
   */
  readonly proxy?: boolean
  /**
   * The strict guard proxy of the process or thread that started this one, which its proxy environment points at and
   * which therefore counts as this guard's own (`strictFromEnvironment().proxy`). Never read from the environment
   * here: only where strict mode applies may a test name it.
   */
  readonly parentProxy?: string
  /**
   * Whether a refused socket, node:http request or WebSocket throws where it is made (the default, for tests) or fails
   * the way a refused connection does, with an `error` event: a worker thread that makes no connections of its own
   * uses that.
   */
  readonly throws?: boolean
}

export type Handle = {
  /** Every connection attempt since the guard was installed (the last 2,000), allowed or not. */
  readonly attempts: () => readonly Attempt[]
  /** Restores every original, and the proxy environment as it was. */
  readonly uninstall: () => void
}

/** What a Worker reads to install strict mode too: on, the pinned names, and the parent's proxy. Tests only. */
export const ENVIRONMENT = {
  strict: "VECTOR_TEST_EGRESS",
  names: "VECTOR_TEST_EGRESS_NAMES",
  proxy: "VECTOR_TEST_EGRESS_PROXY",
} as const

/**
 * What the Worker wrap hands a Worker it starts, as JSON in its environment (`handed` reads it): the policy in effect
 * and the proxy settings the worker's fetch will read, or that the thread that started it is sealed.
 */
export const WORKER_POLICY = "VECTOR_EGRESS_WORKER_POLICY"

const Handed = Schema.Union([
  Schema.Struct({
    policy: LocalMode.Policy,
    proxy: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({ sealed: Schema.Literal(true) }),
])
const decodeHanded = Schema.decodeUnknownOption(Schema.fromJsonString(Handed))
// The names this computer's loopback goes by, which every Worker's proxy settings send direct (`direct`).
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

// The release build's path to guard-worker.ts, which it bundles as an entry point of its own (engine/script/build.ts).
declare const VECTOR_GUARD_WORKER_PATH: string | undefined

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
const NO_PROXY_VARIABLES = ["NO_PROXY", "no_proxy"]
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
// Schemes fetch reads on this computer itself.
const LOCAL_PROTOCOLS = new Set(["file:", "data:", "blob:"])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
export const MAX_REDIRECTS = 20
const MAX_ATTEMPTS = 2_000
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"]
// What a redirect to another origin drops, as Bun's and Node's fetch do.
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "cookie2", "host"]
const RESOLVED_OUTSIDE = "Its name says it is on this computer or your network, but it resolved to an address outside."
const PROXY_HOP =
  "It is a proxy, which can pass a request anywhere; only a request for the internet that a part of Vector labelled may use it. A request for this computer or your network goes direct: add its host to NO_PROXY."
export const PROXY_LOCAL =
  "It is for this computer or your network, but the proxy environment would still send it through a proxy. Add its host to NO_PROXY as Bun reads it: the name itself, or an IPv6 address in brackets."
// Only this guard's own frames are skipped when the log names the code that made a blocked connection.
const OWN_FRAME = /local-mode[\\/](?:guard|attribution|egress|http-client|forward-proxy)\.[jt]s/
// Whether the variables that ask for strict mode may be read: from a source checkout only. A release build sets its
// channel (InstallationLocal), and the desktop app runs in Electron, which `vector` and its tests run as Node.
const TEST_HOOKS = InstallationLocal && !(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE)

// One guard per thread, shared by every copy of this module a bundle loads: the desktop's engine carries its own copy
// of core beside the one its entry point imports first.
const KEY = Symbol.for("vector.egress.guard")
type ProxySettings = Readonly<Record<string, string | undefined>>
type GuardState = {
  handle?: Handle
  /** Which guard is installed: Vector Local's, or the strict one (tests, and a sealed thread). */
  mode?: "local" | "strict"
  /** The strict guard's own proxy while it is installed. */
  own?: string
  /** Whether the build carried guard-worker.ts, looked at once. */
  preload?: boolean
  /**
   * Under Bun, in a worker: the proxy settings its fetch reads, as they were when it started (`fetchEnvironment`). It
   * outlives the guard, which the worker's own entry may install again.
   */
  environment?: ProxySettings
  /** On the main thread: the proxy settings the process started with. */
  started?: ProxySettings
}
const holder = globalThis as unknown as { [KEY]?: GuardState }
const state: GuardState = (holder[KEY] ??= {})
// The proxy settings this process started with, which a Bun worker it starts reads whatever was written since
// (`workerEnvironment`). This module is the first import, so nothing has written them yet.
if (workerThreads.isMainThread) state.started ??= proxySettings(process.env)

type Fetch = typeof globalThis.fetch
type FetchInit = RequestInit & { readonly proxy?: string | { readonly url: string }; readonly unix?: string }
export type Hop = FetchInit & { readonly method: string; readonly headers: Headers }
type Connect = (this: net.Socket, ...input: unknown[]) => net.Socket
type BunConnectOptions = {
  readonly hostname?: string
  readonly host?: string
  readonly port?: number
  readonly unix?: string
}
type BunSockets = { connect: (options: BunConnectOptions) => Promise<unknown> }
type Preconnect = (target: string | URL, options?: unknown) => void
type WorkerOptions = { readonly preload?: string | readonly string[]; readonly env?: unknown }
type Lookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) => void
type Judged = { readonly blocked?: EgressBlocked; readonly within?: EgressAttribution.Within }
type Judge = (attempt: Omit<Attempt, "allowed">) => Judged

/**
 * Whether a host stays on this computer: a loopback name or address, or a name the caller pinned there. A name under
 * `localhost` is not counted by its name alone, since a resolver without RFC 6761's rule may answer it from upstream.
 */
export function local(host: string, names: readonly string[] = []) {
  return LocalPolicy.loopback(host) || names.some((name) => LocalPolicy.domainMatches(host, name))
}

/**
 * The proxies a request to `target` may go through under this environment: every variable for its scheme, then
 * HTTP_PROXY for https (Node's fetch falls back to it) and ALL_PROXY, since clients differ on which spelling wins. Empty
 * only when NO_PROXY sends it direct as Bun reads it (`bypassed`), the narrowest reading of the clients Vector runs.
 */
export function environmentProxies(target: URL, env: ProxySettings = fetchEnvironment()) {
  const secure = target.protocol === "https:" || target.protocol === "wss:"
  const proxies = [
    ...(secure ? [env.HTTPS_PROXY, env.https_proxy] : []),
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ].filter((value): value is string => Boolean(value))
  // Bun reads no_proxy before NO_PROXY, and an empty one as unset.
  if (bypassed(target, secure ? "443" : "80", env.no_proxy || env.NO_PROXY || "")) return []
  return [...new Set(proxies)]
}

/**
 * Whether the proxy environment would still carry a request for `url` under Bun, whose fetch and node:http client
 * reach a proxy natively, past the socket wrap. Only a request for this computer or your network is checked, after
 * `direct` sent its host around the proxy; a `proxy` the caller gave is its own choice, and the strict guard's own
 * proxy decides what it carries. The settings are the ones this thread's fetch reads (`fetchEnvironment`): in a Bun
 * worker, those it started with, which `direct` does not change. Bun 1.3 reads only the variable for the request's
 * scheme; this reads every one `environmentProxies` lists, so it may refuse a request Bun would have sent direct, never
 * the other way round.
 */
export function carried(url: URL, given?: FetchInit["proxy"], env: ProxySettings = fetchEnvironment()) {
  if (!process.versions.bun || given || LocalPolicy.hostClass(url.hostname) === "internet") return false
  return environmentProxies(url, env).some((item) => item !== state.own)
}

/**
 * The proxy settings this thread's fetch and node:http read: process.env, read at each request, except in a Bun
 * worker, whose fetch keeps the settings of the thread that started it as they were then. There they are the settings
 * that thread handed it (`handed`), or else the worker's own as its guard first found them, before `direct` wrote
 * anything.
 */
export function fetchEnvironment(): ProxySettings {
  if (!process.versions.bun || workerThreads.isMainThread) return process.env
  state.environment ??= proxySettings(process.env)
  return state.environment
}

/**
 * What the Worker wrap handed this worker (WORKER_POLICY), read once and removed, so neither the programs it starts
 * nor its own Workers inherit it: the policy in effect where it started, with the proxy settings its fetch reads, or
 * that the thread that started it is sealed. Undefined on the main thread, where a value can only have been inherited,
 * and in a worker the wrap did not start.
 */
export function handed(env: Record<string, string | undefined> = process.env) {
  const text = workerThreads.isMainThread ? undefined : env[WORKER_POLICY]
  delete env[WORKER_POLICY]
  const value = text === undefined ? undefined : Option.getOrUndefined(decodeHanded(text))
  if (value && "policy" in value && value.proxy && process.versions.bun) state.environment ??= value.proxy
  return value
}

// The proxy settings a Bun Worker this thread starts now will read (`fetchEnvironment`): a variable the process
// started with keeps that value there, and any other has its value now. A worker's own Workers get what it reads.
function workerEnvironment(): ProxySettings {
  if (!workerThreads.isMainThread) return fetchEnvironment()
  return { ...proxySettings(process.env), ...state.started }
}

// The proxy variables and both NO_PROXY spellings of an environment, read one by one: Bun leaves a variable set while
// it runs out of process.env's own keys.
function proxySettings(env: ProxySettings) {
  return Object.fromEntries(
    [...PROXY_VARIABLES, ...NO_PROXY_VARIABLES].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  ) as Record<string, string>
}

/**
 * Where a name that is allowed by its name alone must resolve: loopback for `localhost`, the private ranges for a
 * name on the user's network, and those plus Tailscale's 100.64.0.0/10 for a `*.ts.net` name. Undefined for an
 * address, and for a name whose place its name does not say.
 */
export function within(host: string): EgressAttribution.Within | undefined {
  const name = LocalPolicy.host(host)
  if (!name || net.isIP(name)) return undefined
  const place = LocalPolicy.hostClass(name)
  if (place === "this-computer") return "loopback"
  if (place === "your-network") return name.endsWith(".ts.net") ? "tailnet" : "private"
  return undefined
}

/**
 * Where a destination's name must resolve before it is reached: `within` for a name allowed by its name alone. An
 * origin on the model server list that may be reached wherever its name resolves (`exempt`, LocalPolicy.exempt: a
 * company's own endpoint, or the user's while no lock limits them to the user's network) keeps only a loopback name's
 * check; the list decides the rest.
 */
function checkedPlace(host: string, exempt: boolean) {
  const place = within(host)
  return exempt && place !== "loopback" ? undefined : place
}

/** Whether a resolved address is where `within` says its name must be. */
export function inside(address: string, place: EgressAttribution.Within) {
  const found = LocalPolicy.hostClass(address)
  if (place === "loopback") return found === "this-computer"
  if (found === "this-computer" || found === "your-network") return true
  const octets = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address)
  return place === "tailnet" && Number(octets?.[1]) === 100 && Number(octets?.[2]) >= 64 && Number(octets?.[2]) <= 127
}

/**
 * The hosts and ports a request to `url` connects to: its own, and any proxy that would carry it. The proxy
 * environment carries only a request for the internet; one for this computer or your network goes direct (`direct`).
 * A `proxy` the caller gives is its own choice. For an origin on the model server list that may be reached wherever
 * its name resolves (`exempt`, LocalPolicy.exempt), where its name resolves is not checked, except that a loopback
 * name must stay on loopback.
 */
export function destinations(
  url: URL,
  options: { readonly proxy?: FetchInit["proxy"]; readonly exempt?: boolean } = {},
): EgressAttribution.Grant[] {
  const given = typeof options.proxy === "string" ? options.proxy : options.proxy?.url
  const internet = LocalPolicy.hostClass(url.hostname) === "internet"
  const proxies = (given ? [given] : internet ? environmentProxies(url) : [])
    .filter((item) => URL.canParse(item))
    .map((item) => new URL(item))
  return [
    { host: url.hostname, port: portOf(url), within: checkedPlace(url.hostname, options.exempt === true) },
    ...proxies.map((item) => ({ host: item.hostname, port: portOf(item) })),
  ]
}

/**
 * Sends requests for `host` around the proxy environment when it is on this computer or your network: the host joins
 * NO_PROXY and no_proxy (one list, the union of both, so a client that prefers either spelling keeps every entry), in
 * every form a client matches (`noProxyEntries`), unless both lists already hold each of them. It is added even when
 * another entry covers the host for a client that reads NO_PROXY more widely: Bun honours neither a bare IPv6 address
 * (`::1`) nor a `*.name` wildcard. Bun and Node read the list at each fetch, so a corporate proxy never sees a local
 * model's prompt. Only the strict guard's own proxy, in the thread that runs it, is left to decide what it carries. In
 * a Bun worker this reaches only the programs the worker starts, not its own fetch (`fetchEnvironment`).
 */
export function direct(host: string) {
  const name = LocalPolicy.host(host)
  if (!name || LocalPolicy.hostClass(name) === "internet") return
  if (!PROXY_VARIABLES.some((key) => process.env[key] && process.env[key] !== state.own)) return
  const wanted = noProxyEntries(host)
  const entries = (key: string) =>
    (process.env[key] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  if (
    NO_PROXY_VARIABLES.every((key) =>
      wanted.every((entry) => entries(key).some((item) => item.toLowerCase() === entry)),
    )
  )
    return
  const joined = [...new Set([...NO_PROXY_VARIABLES.flatMap(entries), ...wanted])].join(",")
  NO_PROXY_VARIABLES.forEach((key) => {
    process.env[key] = joined
  })
}

/**
 * Strict mode as a process's environment asks for it (ENVIRONMENT), for a test's child process or Worker, or undefined
 * when it does not apply: only in a source checkout (`hooks`, false in a release build and in the desktop app), and
 * never where Vector Local is on (`local`: the environment turns it on, or the backstop started pending because
 * something Vector Local reads may), since the agent can set these for a nested `vector`, and the pinned names would
 * let hosts through and a proxy it took for its own would carry local requests. Such a process is decided by Vector
 * Local's guard instead.
 */
export function strictFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  hooks = TEST_HOOKS,
  local = LocalPolicy.resolve({ env }).enabled,
) {
  if (!hooks || env[ENVIRONMENT.strict] !== "strict" || local) return undefined
  return {
    names: (env[ENVIRONMENT.names] ?? "").split(",").filter(Boolean),
    proxy: env[ENVIRONMENT.proxy] || undefined,
  }
}

export function installed() {
  return state.handle !== undefined
}

/**
 * Whether the guard installed is the strict one (installStrict), which refuses every connection off this computer and
 * logs every attempt. `installed()` is also true for Vector Local's guard, which follows the user's policy and logs
 * nothing while Vector Local is off.
 */
export function strictInstalled() {
  return state.mode === "strict"
}

/**
 * Removes the Vector Local guard the worker preload installed (guard-worker.ts), so a worker entry that seals itself
 * (backstop-worker.ts) can put the strict guard in its place: the preload's guard follows the policy of the process,
 * which may allow more. A strict guard the preload installed in a test stays.
 */
export function unfollow() {
  if (!workerThreads.isMainThread && state.mode === "local") state.handle?.uninstall()
}

/**
 * Installs the backstop: every connection is decided under the policy `options.policy` returns at that moment. A
 * refused fetch or Bun.connect rejects with EgressBlocked; a refused socket or node:http request fails with it as its
 * `error` event, the way a refused connection does; a refused WebSocket throws.
 */
export function install(options: Options): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const attempts: Attempt[] = []
  const judge: Judge = (attempt) => {
    const policy = options.policy()
    const scope = EgressAttribution.current()
    const grant = scope?.grants?.find((item) => sameHost(item.host, attempt.host) && samePort(item.port, attempt.port))
    if (grant) return keep(attempts, { ...attempt, allowed: true }, { within: grant.within })
    const decided = socketVerdict(policy, attempt)
    const verdict = decided.verdict
    const allowed = verdict.decision === "allow"
    const outcome = { ...attempt, allowed }
    if (!allowed || verdict.class !== "this-computer")
      options.record?.({ attempt: outcome, verdict, scope, ...(allowed ? {} : { frame: frame() }) })
    if (!allowed)
      return keep(attempts, outcome, {
        blocked: new EgressBlocked(attempt.host, attempt.kind, verdict.rule, verdict.reason),
      })
    const exempt = verdict.class === "listed" && decided.url !== undefined && LocalPolicy.exempt(policy, decided.url)
    return keep(attempts, outcome, { within: checkedPlace(attempt.host, exempt) })
  }
  // A refusal the guard made itself, logged with the code that made the connection.
  const refused = (attempt: Omit<Attempt, "allowed">, rule: LocalMode.Rule, reason: string) => {
    options.record?.({
      attempt: { ...attempt, allowed: false },
      verdict: { decision: "block", rule, class: LocalPolicy.hostClass(attempt.host), reason, allowable: false },
      scope: EgressAttribution.current(),
      frame: frame(),
    })
    return new EgressBlocked(attempt.host, attempt.kind, rule, reason)
  }
  // A name that resolved outside where it said it was is logged as its own refusal.
  const outside = (attempt: Omit<Attempt, "allowed">) => refused(attempt, "resolved-outside", RESOLVED_OUTSIDE)
  // A request for this computer or your network goes around the proxy environment; under Bun one it would still
  // carry is refused, since Bun reaches the proxy past the socket wrap.
  const around = (attempt: Omit<Attempt, "allowed">, url: URL, given: FetchInit["proxy"]) => {
    direct(url.hostname)
    if (!carried(url, given)) return undefined
    keep(attempts, { ...attempt, allowed: false }, {})
    return refused(attempt, "proxy-environment", PROXY_LOCAL)
  }
  // Only the explicit `proxy` option needs a decision of its own: the proxy environment is the user's, and the request
  // was decided on its target before it reaches that proxy.
  const proxied = (_target: URL, init: FetchInit | undefined) => {
    const given = typeof init?.proxy === "string" ? init.proxy : init?.proxy?.url
    if (!given || !URL.canParse(given)) return undefined
    const proxy = new URL(given)
    return judgeHop({ kind: "fetch", host: proxy.hostname, port: portOf(proxy), url: proxy.origin })
  }
  // A proxy: only a request a labelled call site granted it to may use it.
  const judgeHop = (attempt: Omit<Attempt, "allowed">): EgressBlocked | undefined => {
    const scope = EgressAttribution.current()
    if (scope?.grants?.some((item) => sameHost(item.host, attempt.host) && samePort(item.port, attempt.port))) return
    const verdict: LocalPolicy.Verdict = {
      decision: "block",
      rule: "unlabelled",
      class: "internet",
      reason: PROXY_HOP,
      allowable: false,
    }
    options.record?.({ attempt: { ...attempt, allowed: false }, verdict, scope, frame: frame() })
    keep(attempts, { ...attempt, allowed: false }, {})
    return new EgressBlocked(attempt.host, attempt.kind, "unlabelled", PROXY_HOP)
  }
  const socketJudge: Judge = (attempt) => {
    if (configuredProxy(attempt.host, attempt.port)) {
      const blocked = judgeHop(attempt)
      return blocked ? { blocked } : {}
    }
    return judge(attempt)
  }
  return wrap({
    active: () => options.policy().enabled,
    judge,
    socketJudge,
    proxied,
    around,
    outside,
    throws: false,
    attempts,
    // Under Bun a Worker gets these wraps preloaded, with the policy in effect when it starts; Egress keeps it current
    // there. Node has no preload (see the comment at the top). The worker's fetch keeps this thread's proxy settings as
    // they are when it starts (`fetchEnvironment`), so this computer, and while Vector Local is on the model servers on
    // the list, go on NO_PROXY first, and the worker is told the settings it will read.
    ...(process.versions.bun && {
      worker: {
        env: () => {
          const policy = options.policy()
          const listed = policy.enabled ? policy.endpoints.map((item) => item.origin) : []
          ;[...LOOPBACK, ...listed.filter((item) => URL.canParse(item)).map((item) => new URL(item).hostname)].forEach(
            direct,
          )
          return { [WORKER_POLICY]: JSON.stringify({ policy, proxy: workerEnvironment() }) }
        },
        always: true,
      },
    }),
    mode: "local",
  })
}

/** Installs the guard in strict mode: any connection that leaves this computer is refused before it is made. */
export function installStrict(options: StrictOptions = {}): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const names = options.names ?? []
  const attempts: Attempt[] = []
  const judge: Judge = (attempt) => {
    const allowed = local(attempt.host, names)
    return keep(
      attempts,
      { ...attempt, allowed },
      allowed ? {} : { blocked: new EgressBlocked(attempt.host, attempt.kind) },
    )
  }

  const originalConnect = net.Socket.prototype.connect as unknown as Connect
  const proxy =
    options.proxy === false || !process.versions.bun
      ? undefined
      : ForwardProxy.startSync((destination) => {
          const judged = judge({
            kind: "proxied",
            host: destination.host,
            port: destination.port,
            url: destination.url,
          })
          if (judged.blocked) return ForwardProxy.FORBIDDEN(judged.blocked.message)
          // A name the caller pinned to this computer is reached on 127.0.0.1, as its resolver would answer.
          const pinned = names.some((name) => LocalPolicy.domainMatches(destination.host, name))
          return {
            connect: (connected) => {
              const upstream = new net.Socket()
              originalConnect.call(upstream, destination.port, pinned ? "127.0.0.1" : destination.host, connected)
              return upstream
            },
          }
        })
  const ownProxy = proxy?.url ?? options.parentProxy
  const saved = [...PROXY_VARIABLES, ...NO_PROXY_VARIABLES, ...Object.values(ENVIRONMENT)].map(
    (key) => [key, process.env[key]] as const,
  )
  const strictEnvironment = {
    [ENVIRONMENT.strict]: "strict",
    [ENVIRONMENT.names]: names.join(","),
    ...(ownProxy && {
      [ENVIRONMENT.proxy]: ownProxy,
      ...Object.fromEntries(PROXY_VARIABLES.map((key) => [key, ownProxy])),
      // This computer's own names go direct, so a request to a server here fails or answers as it would without the
      // guard: through a proxy a refused connection reads as the proxy's 502, and a connection is not the caller's own.
      ...Object.fromEntries(NO_PROXY_VARIABLES.map((key) => [key, LOOPBACK.join(",")])),
    }),
  }
  // A Worker writes its own copy too, for the programs it starts; under Bun its own fetch already reads the proxy
  // settings of the thread that started it, which point at this proxy.
  if (ownProxy) Object.assign(process.env, strictEnvironment)
  // A sealed thread (one that fails a refused connection rather than throwing: a worker that makes no connections of
  // its own) seals the Workers it starts too, outside a test as well, where the test variables mean nothing.
  const sealed = options.throws === false
  state.own = ownProxy

  // Any proxy but the guard's own carries a request off this computer, whatever its target.
  const proxied = (target: URL, init: FetchInit | undefined) => {
    const given = typeof init?.proxy === "string" ? init.proxy : init?.proxy?.url
    const other = (given ? [given] : environmentProxies(target)).find((item) => item !== ownProxy)
    if (!other) return undefined
    const host = URL.canParse(other) ? new URL(other).hostname : other
    keep(
      attempts,
      { kind: "fetch", host, url: URL.canParse(other) ? new URL(other).origin : undefined, allowed: false },
      {},
    )
    return new EgressBlocked(host, "fetch")
  }
  const handle = wrap({
    active: () => true,
    judge,
    socketJudge: judge,
    proxied,
    // Its own proxy refuses anything it would carry off this computer.
    around: () => undefined,
    outside: (attempt) => new EgressBlocked(attempt.host, attempt.kind),
    throws: options.throws !== false,
    attempts,
    worker: {
      env: () =>
        sealed ? { ...strictEnvironment, [WORKER_POLICY]: JSON.stringify({ sealed: true }) } : strictEnvironment,
      always: sealed,
    },
    mode: "strict",
    stop: () => {
      proxy?.stop()
      state.own = undefined
      // Bun's fetch reads the proxy environment at each request, and deleting a variable does not reach it, so a
      // variable that was unset is emptied first. NO_PROXY stays, empty: Bun never sees a variable set again once it
      // was deleted, and `direct` may need it later.
      if (ownProxy)
        saved.forEach(([key, value]) => {
          process.env[key] = value ?? ""
          if (value === undefined && !NO_PROXY_VARIABLES.includes(key)) delete process.env[key]
        })
    },
  })
  return handle
}

/**
 * The redirect a fetch would follow itself: 303, and 301 or 302 after a POST, become a GET without a body; a body
 * is resent only when it can be read twice; credentials (Authorization, Proxy-Authorization, cookies) and Host are
 * dropped when the origin changes.
 */
export function redirectHop(hop: Hop, status: number, from: URL, next: URL): Hop {
  const method = hop.method.toUpperCase()
  const get =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  const headers = new Headers(hop.headers)
  if (get) BODY_HEADERS.forEach((name) => headers.delete(name))
  if (from.origin !== next.origin) CREDENTIAL_HEADERS.forEach((name) => headers.delete(name))
  if (!get && hop.body != null && !replayable(hop.body))
    throw new TypeError("A redirect that resends a streamed request body cannot be followed.")
  return { ...hop, method: get ? "GET" : hop.method, body: get ? null : hop.body, headers }
}

/** Whether a response is a redirect fetch would follow, and where to. */
export function redirectTarget(response: Response, from: URL) {
  const location = response.headers.get("location")
  if (!REDIRECTS.has(response.status) || location === null) return undefined
  const next = new URL(location, from)
  if (next.protocol !== "http:" && next.protocol !== "https:")
    throw new TypeError(`A redirect to ${next.protocol} cannot be followed.`)
  return next
}

/**
 * The first hop of a fetch call, as `redirectHop` reads it. `body`, when given, is the body the hop carries instead of
 * the call's own, which is then not read.
 */
export function firstHop(input: Parameters<Fetch>[0], init: FetchInit | undefined, body?: BodyInit | null): Hop {
  const request = input instanceof Request ? input : undefined
  return {
    ...init,
    method: methodOf(input, init),
    headers: new Headers(init?.headers ?? request?.headers),
    body: body !== undefined ? body : (init?.body ?? request?.body ?? null),
    signal: init?.signal ?? request?.signal,
    redirect: "manual",
  }
}

/**
 * The first hop of a fetch call that follows redirects. A Request's own body is a stream the first send reads, so a
 * copy of it is kept, which a 307 or 308 resends as fetch would. The Request is cloned before anything reads its body:
 * Bun 1.3 sends an empty body for a Request whose `body` was read before it was cloned, once the Request carries Bun's
 * own `timeout` option, as the SDK's requests do.
 */
export async function followedHop(input: Parameters<Fetch>[0], init: FetchInit | undefined): Promise<Hop> {
  if (!(input instanceof Request) || init?.body != null) return firstHop(input, init)
  const copy = input.clone()
  return firstHop(input, init, copy.body === null ? null : await copy.blob())
}

/** A fetch call's method, read without touching its body. */
function methodOf(input: Parameters<Fetch>[0], init: FetchInit | undefined) {
  return init?.method ?? (input instanceof Request ? input.method : "GET")
}

type Wrap = {
  /** Whether connections are decided at all; false passes every call straight through. */
  readonly active: () => boolean
  readonly judge: Judge
  /** The judge for raw sockets, which also see the proxies a client was configured with. */
  readonly socketJudge: Judge
  readonly proxied: (target: URL, init: FetchInit | undefined) => EgressBlocked | undefined
  /** Sends a request for this computer or your network around the proxy environment, or refuses it. */
  readonly around: (
    attempt: Omit<Attempt, "allowed">,
    url: URL,
    given: FetchInit["proxy"] | undefined,
  ) => EgressBlocked | undefined
  readonly outside: (attempt: Omit<Attempt, "allowed">) => EgressBlocked
  readonly throws: boolean
  readonly attempts: Attempt[]
  /**
   * The guard preloaded in every Worker it sees started, with `env` added to the Worker's environment: to the one the
   * caller gives, or, when `always`, to a copy of this process's (strict mode writes its own into the process instead).
   */
  readonly worker?: { readonly env: () => Readonly<Record<string, string>>; readonly always: boolean }
  readonly mode: "local" | "strict"
  readonly stop?: () => void
}

function wrap(input: Wrap): Handle {
  // In a Bun worker, the proxy settings its fetch reads are taken now, before `direct` writes anything there.
  fetchEnvironment()
  const originalFetch = globalThis.fetch
  // Bun's fetch has preconnect; Node's has none, and gets none.
  const originalPreconnect = (originalFetch as { preconnect?: Preconnect }).preconnect
  // A name allowed by its name alone is looked up first; one that resolves outside is refused before fetch runs.
  const resolved = async (attempt: Omit<Attempt, "allowed">, place: EgressAttribution.Within | undefined) => {
    if (!place) return undefined
    const addresses = await dns.promises.lookup(bare(attempt.host), { all: true }).catch(() => undefined)
    // A name that does not resolve fails in fetch itself, with its own error.
    if (!addresses) return undefined
    return addresses.every((item) => inside(item.address, place)) ? undefined : input.outside(attempt)
  }
  // A request for this computer or your network goes direct, around the proxy environment, before it is decided.
  const decide = (url: URL, init: FetchInit | undefined, method: string) => {
    const attempt = { kind: "fetch" as const, host: url.hostname, port: portOf(url), url: url.origin, method }
    const around = input.around(attempt, url, init?.proxy)
    if (around) return { attempt, judged: { blocked: around }, blocked: around }
    const judged = input.judge(attempt)
    return { attempt, judged, blocked: judged.blocked ?? input.proxied(url, init) }
  }
  // An allowed unlabelled request runs with its own destinations granted, so the socket it opens through Node's fetch,
  // or the proxy that carries it, passes as this request.
  const send = (target: URL, init: FetchInit | undefined, judged: Judged, run: () => Promise<Response>) => {
    const scope = EgressAttribution.current()
    const [own, ...proxies] = destinations(target, { proxy: init?.proxy })
    return EgressAttribution.granted(
      {
        source: scope?.source ?? "unlabelled",
        purpose: scope?.purpose ?? "unknown",
        grants: [...(scope?.grants ?? []), { ...own!, within: judged.within }, ...proxies],
      },
      run,
    )
  }
  const follow = async (response: Response, from: URL, hop: Hop, count: number): Promise<Response> => {
    const next = redirectTarget(response, from)
    if (!next) {
      if (count > 0) Object.defineProperty(response, "redirected", { value: true })
      return response
    }
    if (count >= MAX_REDIRECTS) throw new TypeError(`Too many redirects: more than ${MAX_REDIRECTS}.`)
    await response.body?.cancel()
    const following = redirectHop(hop, response.status, from, next)
    const checked = decide(next, following, following.method)
    if (checked.blocked) throw checked.blocked
    const outside = await resolved(checked.attempt, checked.judged.within)
    if (outside) throw outside
    return follow(
      await send(next, following, checked.judged, () => originalFetch(next, following)),
      next,
      following,
      count + 1,
    )
  }
  const fetch = ((target: Parameters<Fetch>[0], init?: FetchInit) => {
    if (!input.active()) return originalFetch(target, init)
    const address = target instanceof Request ? target.url : String(target)
    // A Unix socket, a data: or blob: URL and an address fetch cannot parse never leave the computer through here.
    if (init?.unix || !URL.canParse(address)) return originalFetch(target, init)
    const url = new URL(address)
    if (LOCAL_PROTOCOLS.has(url.protocol)) return originalFetch(target, init)
    // Any other scheme fetch reaches itself is decided as an address with no http or https host, which is refused.
    if (!WEB_PROTOCOLS.has(url.protocol))
      return Promise.reject(
        input.judge({ kind: "fetch", host: `${url.protocol}//${url.host}`, url: `${url.protocol}//${url.host}` })
          .blocked ?? new EgressBlocked(url.protocol, "fetch"),
      )
    const checked = decide(url, init, methodOf(target, init))
    if (checked.blocked) return Promise.reject(checked.blocked)
    const mode = init?.redirect ?? (target instanceof Request ? target.redirect : "follow")
    return resolved(checked.attempt, checked.judged.within).then(async (outside) => {
      if (outside) throw outside
      if (mode !== "follow") return send(url, init, checked.judged, () => originalFetch(target, init))
      const first = await followedHop(target, init)
      return send(url, init, checked.judged, () => originalFetch(target, { ...init, redirect: "manual" })).then(
        (response) => follow(response, url, first, 0),
      )
    })
  }) as Fetch
  // Preconnecting opens a connection, and for https sends the name, so it is decided too; a refused one does nothing.
  if (originalPreconnect)
    (fetch as { preconnect?: Preconnect }).preconnect = (target, options) => {
      if (!input.active() || !URL.canParse(String(target))) return originalPreconnect(target, options)
      if (decide(new URL(String(target)), undefined, "CONNECT").blocked) return
      return originalPreconnect(target, options)
    }
  globalThis.fetch = fetch

  // A runtime without a global WebSocket (Node before 22) has none to wrap.
  const OriginalWebSocket = globalThis.WebSocket as typeof globalThis.WebSocket | undefined
  if (OriginalWebSocket) globalThis.WebSocket = guardedWebSocket(OriginalWebSocket, input)

  // Read from globalThis, so this module also type-checks and runs where there is no Bun.
  const sockets = (globalThis as unknown as { Bun?: BunSockets }).Bun
  const originalBunConnect = sockets?.connect
  if (sockets && originalBunConnect)
    sockets.connect = (options) => {
      if (!input.active() || options.unix) return originalBunConnect(options)
      // Bun reads `hostname` first and then `host`.
      const attempt = {
        kind: "socket" as const,
        host: options.hostname ?? options.host ?? "localhost",
        port: options.port,
      }
      const judged = input.socketJudge(attempt)
      if (judged.blocked) return Promise.reject(judged.blocked)
      return resolved(attempt, judged.within).then((outside) =>
        outside ? Promise.reject(outside) : originalBunConnect(options),
      )
    }

  const originalConnect = net.Socket.prototype.connect as unknown as Connect
  const socket = net.Socket.prototype as unknown as { connect: unknown }
  socket.connect = function (this: net.Socket, ...args: unknown[]) {
    if (!input.active()) return originalConnect.apply(this, args)
    const destination = socketDestination(args)
    if (!destination) return originalConnect.apply(this, args)
    const attempt = { kind: "socket" as const, ...destination }
    const judged = input.socketJudge(attempt)
    if (judged.blocked) return refuse(this, judged.blocked, input.throws)
    if (!judged.within || net.isIP(bare(destination.host))) return originalConnect.apply(this, args)
    return originalConnect.apply(
      this,
      checkedLookup(args, judged.within, () => input.outside(attempt)),
    )
  }

  // Bun's node:http client goes through its own fetch, past both wraps above, once the request starts. Under Node the
  // request's socket goes through the socket wrap instead.
  const request = http.ClientRequest.prototype as unknown as { [key: string]: unknown }
  const methods = process.versions.bun ? ["end", "write", "flushHeaders"] : []
  const own = Object.fromEntries(methods.map((key) => [key, Object.getOwnPropertyDescriptor(request, key)]))
  const decided = new WeakSet<object>()
  methods.forEach((key) => {
    const original = request[key] as (...input: unknown[]) => unknown
    request[key] = function (this: http.ClientRequest & { socketPath?: string; port?: unknown }, ...args: unknown[]) {
      if (!input.active() || decided.has(this) || this.socketPath) return original.apply(this, args)
      decided.add(this)
      const host = String(this.host ?? "localhost")
      const attempt = { kind: "http" as const, host, port: numberOf(this.port), method: this.method }
      // Bun's client reads the proxy environment the way its fetch does.
      const address = `${this.protocol === "https:" ? "https" : "http"}://${bracketed(host)}${attempt.port === undefined ? "" : `:${attempt.port}`}`
      const around = URL.canParse(address) ? input.around(attempt, new URL(address), undefined) : undefined
      const blocked = around ?? input.judge(attempt).blocked
      if (!blocked) return original.apply(this, args)
      if (input.throws) throw blocked
      // Bun's request emits nothing when it is destroyed before it starts, so the refusal is its error event.
      process.nextTick(() => {
        this.emit("error", blocked)
        this.destroy()
      })
      return key === "write" ? false : this
    }
  })

  // These same wraps are preloaded in every Worker the guard sees started (Bun's `preload`; Node ignores it, and its
  // workers get the environment): strict mode's with the names and the proxy it reads from its environment, Vector
  // Local's with the policy in effect. Node has no global Worker, only node:worker_threads' one, so only the classes
  // this runtime has are wrapped. Local mode can start Workers without a bundled preload; strict mode must refuse.
  const threads = workerThreads as unknown as { Worker?: typeof workerThreads.Worker }
  const OriginalWorker = globalThis.Worker as typeof globalThis.Worker | undefined
  const OriginalThreadWorker = threads.Worker
  const worker = input.worker
  if (worker) {
    const guarded = (options: WorkerOptions | undefined) => {
      const preload = workerPreload()
      if (input.mode === "strict" && !preloadable(preload))
        throw new Error("Vector did not start this worker because its network guard preload is unavailable.")
      const added = worker.env()
      const given = options?.env
      const env =
        given && typeof given === "object"
          ? { ...given, ...added }
          : worker.always && given === undefined
            ? { ...process.env, ...added }
            : undefined
      return {
        ...options,
        ...(worker.always && !preloadable(preload) ? {} : { preload: [preload, ...[options?.preload ?? []].flat()] }),
        ...(env ? { env } : {}),
      }
    }
    if (OriginalWorker)
      globalThis.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, guarded(options) as never)
        }
      } as typeof globalThis.Worker
    if (OriginalThreadWorker)
      threads.Worker = class extends OriginalThreadWorker {
        constructor(file: string | URL, options?: WorkerOptions) {
          super(file, guarded(options) as never)
        }
      }
    syncBuiltinESMExports()
  }

  const handle: Handle = {
    attempts: () => [...input.attempts],
    uninstall: () => {
      globalThis.fetch = originalFetch
      if (OriginalWebSocket) globalThis.WebSocket = OriginalWebSocket
      if (worker && OriginalWorker) globalThis.Worker = OriginalWorker
      if (worker && OriginalThreadWorker) threads.Worker = OriginalThreadWorker
      if (worker) syncBuiltinESMExports()
      if (sockets && originalBunConnect) sockets.connect = originalBunConnect
      socket.connect = originalConnect
      // A method Bun's prototype did not have of its own goes back to the one it inherits.
      Object.entries(own).forEach(([key, descriptor]) =>
        descriptor ? Object.defineProperty(request, key, descriptor) : delete request[key],
      )
      input.stop?.()
      state.handle = undefined
      state.mode = undefined
    },
  }
  state.handle = handle
  state.mode = input.mode
  return handle
}

function guardedWebSocket(Original: typeof globalThis.WebSocket, input: Wrap) {
  return class extends Original {
    constructor(url: string | URL, protocols?: unknown) {
      // An address WebSocket cannot parse fails in its own constructor, with its own error.
      if (input.active() && URL.canParse(String(url))) {
        const target = new URL(String(url))
        const judged = input.judge({
          kind: "websocket",
          host: target.hostname,
          port: portOf(target),
          url: target.origin,
        })
        if (judged.blocked) throw judged.blocked
        // Bun's WebSocket takes a `proxy` of its own in its options; the proxy environment it does not read. Node's
        // reads it once its global proxy is set, so a WebSocket to this computer or your network goes direct.
        const proxy = proxyOption(protocols)
        const blocked = proxy === undefined ? undefined : input.proxied(target, { proxy })
        if (blocked) throw blocked
        direct(target.hostname)
      }
      super(url, protocols as never)
    }
  } as typeof globalThis.WebSocket
}

function keep(attempts: Attempt[], attempt: Attempt, judged: Judged): Judged {
  attempts.push(attempt)
  if (attempts.length > MAX_ATTEMPTS) attempts.splice(0, attempts.length - MAX_ATTEMPTS)
  return judged
}

// A refused socket either throws where it is made (strict mode) or fails on the next tick with an `error` event.
function refuse(socket: net.Socket, blocked: EgressBlocked, throws: boolean) {
  if (throws) throw blocked
  process.nextTick(() => socket.destroy(blocked))
  return socket
}

// An unlabelled connection under the policy: decided as purpose `unknown` on its URL, or for a raw socket on its host
// and port, which is on the list when an endpoint of either scheme names that host and port.
function socketVerdict(policy: LocalMode.Policy, attempt: Omit<Attempt, "allowed">) {
  const port = attempt.port === undefined ? "" : `:${attempt.port}`
  const candidates = attempt.url
    ? [attempt.url.replace(/^ws(s?):/, "http$1:")]
    : [`http://${bracketed(attempt.host)}${port}`, `https://${bracketed(attempt.host)}${port}`]
  const verdicts = candidates
    .filter((item) => URL.canParse(item))
    .map((url) => ({ url, verdict: LocalPolicy.decide(policy, { purpose: "unknown", url, source: "unlabelled" }) }))
  return (
    verdicts.find((item) => item.verdict.decision === "allow") ??
    verdicts[0] ?? {
      url: undefined,
      verdict: LocalPolicy.decide(policy, { purpose: "unknown", url: "about:blank", source: "unlabelled" }),
    }
  )
}

// Eval/blob workers can have no filesystem base, and Windows requires a drive in a file URL. Only resolve a preload
// when starting a child, so the bundled reader can install its own guard; an invalid child preload still fails closed.
function workerPreload() {
  return typeof VECTOR_GUARD_WORKER_PATH === "string"
    ? VECTOR_GUARD_WORKER_PATH
    : fileURLToPath(new URL("./guard-worker.ts", import.meta.url))
}

// Whether the build carried guard-worker.ts, looked at once: a Worker whose preload is missing would not start.
function preloadable(preload: string) {
  state.preload ??= fs.existsSync(preload)
  return state.preload
}

// A proxy this thread's environment names, or, in a Bun worker, the settings its fetch reads.
function configuredProxy(host: string, port: number | undefined) {
  return [process.env, fetchEnvironment()]
    .flatMap((env) => PROXY_VARIABLES.map((key) => env[key]))
    .filter((value): value is string => Boolean(value) && URL.canParse(value!))
    .map((value) => new URL(value))
    .some((proxy) => sameHost(proxy.hostname, host) && samePort(portOf(proxy), port))
}

function sameHost(left: string, right: string) {
  const a = LocalPolicy.host(left)
  return a !== undefined && a === LocalPolicy.host(right)
}

function samePort(granted: number | undefined, port: number | undefined) {
  return granted === undefined || port === undefined || granted === port
}

function portOf(url: URL) {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80
}

function bare(host: string) {
  return host.replace(/^\[|\]$/g, "")
}

// The NO_PROXY entries that send a request for `host` direct in every client: the host as its address spells it, which
// Bun matches, and as a resolver reads it (no trailing dot, IPv4 written out); an IPv6 address both in brackets, the
// only form Bun matches, and bare, the form Node matches.
function noProxyEntries(host: string) {
  const spelled = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  return [...new Set([spelled, LocalPolicy.host(host) ?? spelled])].flatMap((item) =>
    item.includes(":") ? [`[${item}]`, item] : [item],
  )
}

// An IPv6 address in brackets, as a URL writes its host.
function bracketed(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

// The first frame of the call that made a blocked connection, outside this guard and the runtime's own modules.
function frame() {
  const lines = (new Error().stack ?? "").split("\n").slice(1)
  return lines
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith("at ") && !OWN_FRAME.test(line) && !/\((?:node:|native)|^at (?:node:|native)/.test(line),
    )
    ?.slice(3)
}

// `{ proxy }` in a WebSocket's options (Bun), as a string or `{ url }`.
function proxyOption(options: unknown) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  const proxy = (options as { proxy?: unknown }).proxy
  if (typeof proxy === "string") return proxy
  if (proxy && typeof proxy === "object" && typeof (proxy as { url?: unknown }).url === "string")
    return (proxy as { url: string }).url
  return undefined
}

// The same call with a lookup that refuses an answer outside `place`: on the options object, which `connect(port,
// host)` becomes, or on the normalized `[options, listener]` array net.connect passes, replaced in place so the array
// keeps the marker Node reads.
function checkedLookup(args: unknown[], place: EgressAttribution.Within, refused: () => EgressBlocked): unknown[] {
  const listener = args.find((item) => typeof item === "function")
  const checked = (base: Lookup | undefined): Lookup => {
    const lookup = base ?? (dns.lookup as unknown as Lookup)
    return (hostname, options, callback) => {
      const done = typeof options === "function" ? (options as typeof callback) : callback
      lookup(hostname, typeof options === "function" ? {} : options, (error, address, family) => {
        if (error) return done(error, address, family)
        const found = Array.isArray(address) ? address.map((item) => item.address) : [address]
        if (found.every((item) => inside(item, place))) return done(null, address, family)
        done(refused() as NodeJS.ErrnoException, address, family)
      })
    }
  }
  const first = args[0]
  if (Array.isArray(first)) {
    const options = first[0] as { lookup?: Lookup }
    first[0] = { ...options, lookup: checked(options.lookup) }
    return args
  }
  if (first && typeof first === "object") {
    const options = first as { lookup?: Lookup }
    return [{ ...options, lookup: checked(options.lookup) }, ...(listener ? [listener] : [])]
  }
  return [
    { port: Number(first), host: typeof args[1] === "string" ? args[1] : "localhost", lookup: checked(undefined) },
    ...(listener ? [listener] : []),
  ]
}

function replayable(body: BodyInit) {
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  )
}

// Whether NO_PROXY sends a request to `target` direct, as Bun reads it, which is the narrowest of the clients Vector
// runs: comma-separated entries, each `*`, a name (which covers the names under it) or `.name`, with an optional port,
// matched without case. An IPv6 address counts only in brackets (`[::1]`), and neither `*.name` nor an address range
// counts at all; Node's fetch reads more, so what this says goes direct does for both.
function bypassed(target: URL, port: string, list: string) {
  const host = target.hostname.toLowerCase()
  const at = target.port || port
  return list
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true
      const parsed = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(entry)
      if (!parsed?.[1] || (parsed[2] && parsed[2] !== at)) return false
      const base = parsed[1].replace(/^\./, "")
      return base !== "" && (host === base || host.endsWith(`.${base}`))
    })
}

// `connect(options, listener)`, `connect(port, host, listener)`, `connect(path, listener)`, or the normalized
// `[options, listener]` array Node and Bun pass from `net.connect`. A Unix socket or a Windows pipe stays local. A
// string is a pipe only when it is not a number, as Node's isPipeName reads it: " 80", "0x50", "80.0", "8e1" and "+80"
// are ports.
function socketDestination(args: readonly unknown[]): { host: string; port?: number } | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === "string" && !(Number(first) >= 0)) return undefined
  if (typeof first === "number" || typeof first === "string")
    return { host: typeof args[1] === "string" && args[1] ? args[1] : "localhost", port: Number(first) }
  if (!first || typeof first !== "object") return undefined
  const options = first as { path?: unknown; host?: unknown; port?: unknown }
  if (options.path) return undefined
  return {
    host: typeof options.host === "string" && options.host ? options.host : "localhost",
    port: numberOf(options.port),
  }
}

function numberOf(value: unknown) {
  const port = Number(value)
  return Number.isFinite(port) ? port : undefined
}
