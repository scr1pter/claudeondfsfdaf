export * as LocalPolicy from "./policy"

import { Option, Schema } from "effect"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import type { ConfigLocalV1 } from "../v1/config/local"
import { LocalSources } from "./sources"

// Vector Local's rules as pure functions: where a host is, which policy is in effect, and whether a request may go.
// Nothing here reads the environment, the disk or the network, and nothing here is imported for its side effects, so
// the backstop guard can load it first in every entry point. Callers pass the policy they resolved at start.

export type Class = LocalMode.DestinationClass
export type HostClass = Exclude<Class, "listed">

export type Request = {
  readonly purpose: LocalMode.Purpose
  readonly url: string | URL
  /** The registry source making the request, which allow entries name. */
  readonly source?: string
  /** A check the user started themselves, such as Check for updates. */
  readonly manual?: boolean
  /** A one-time grant the user gave for this request, such as a model download. */
  readonly granted?: boolean
}

export type Verdict = {
  readonly decision: LocalMode.Decision
  readonly rule: LocalMode.Rule
  readonly class: Class
  readonly reason: string
  /** Whether an allow entry could let a blocked request through, so the UI offers Allow… */
  readonly allowable: boolean
}

export type Sources = {
  readonly managed?: ConfigLocalV1.Info
  readonly global?: ConfigLocalV1.Info
  /** A repository's own `local` block. It is never applied; passing it records the warning the pane shows. */
  readonly repository?: unknown
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Cloud API hosts a user may not list as a model server; a managed file still may. Default: the registry's. */
  readonly cloudHosts?: readonly string[]
}

export const OFF: LocalMode.Policy = {
  enabled: false,
  web: "ask",
  lock: false,
  endpoints: [],
  web_domains: { allow: [], deny: [] },
  allow: [],
  user_may: [],
  locked_keys: [],
  endpoint_domains: [],
  warnings: [],
}

// Until the policy is resolved, only this computer is reachable, for every purpose.
export const PENDING: LocalMode.Policy = { ...OFF, enabled: true, web: "none", pending: true }

// Keys only a managed file may set.
export const MANAGED_ONLY = [
  "lock",
  "user_may",
  "locked_keys",
  "endpoint_domains",
  "updates",
  "models_dir",
  "catalog_path",
  "recommend",
] as const

export const REPOSITORY_IGNORED =
  "Ignored the local block in this repository's config: only your user config and your company's policy can set Vector Local."

const VECTOR_SERVICES = new Set<LocalMode.Purpose>([
  "catalog",
  "policy",
  "account",
  "usage",
  "crash",
  "telemetry",
  "support",
  "release-notes",
  "asset",
  "help",
  "share",
])
const WEB = new Set<LocalMode.Purpose>(["web-page", "browser", "research-reader", "research-browser"])
const DOWNLOADS = new Set<LocalMode.Purpose>(["model-download", "tool-download", "plugin", "lsp-install"])
const CONNECTED = new Set<LocalMode.Purpose>(["integration", "mcp", "config-remote"])
// Vector's own inference (free models and Vector Codium) is never allowable under Vector Local, and no list holds it.
const VECTOR_HOSTS = ["vectordev.ai"]
const VECTOR_REFUSED =
  "Free models provided by Vector and Vector Codium send prompts through vectordev.ai to the services that run them, outside the servers you list."
const WEB_ORDER: Record<LocalMode.Web, number> = { ask: 0, network: 1, none: 2 }
const WEB_SETTINGS = ["ask", "network", "none"] as const satisfies readonly LocalMode.Web[]

/** The stricter of two Web access settings. */
export function stricter(left: LocalMode.Web, right: LocalMode.Web | undefined): LocalMode.Web {
  if (!right || WEB_ORDER[right] <= WEB_ORDER[left]) return left
  return right
}

/**
 * A host as a URL parser and the system resolver read it: lowercase, punycode, decimal, octal and hex IPv4 forms
 * written out, IPv6 without brackets or zone, and no trailing dot. Undefined when it is not a host at all. Only an
 * IPv6 address has a zone (`fe80::1%en0`); a `%` anywhere else is not a host, since a resolver would be asked for the
 * whole name while the part before it was judged.
 */
export function host(input: string) {
  const bare = input
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  const [raw = "", zone, ...rest] = bare.split("%")
  if (rest.length > 0 || (zone !== undefined && (!raw.includes(":") || !/^[\w.-]+$/.test(zone)))) return undefined
  if (!raw || /[\s/@?#\\]/.test(raw)) return undefined
  const address = raw.includes(":") ? `http://[${raw}]/` : `http://${raw}/`
  if (!URL.canParse(address)) return undefined
  return new URL(address).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

/**
 * Where a host is, by its name or address alone. A name that is not obviously local is on the internet. A name under
 * `localhost` (`app.localhost`) is not this computer by its name alone: a resolver without RFC 6761's rule may answer
 * it from upstream DNS, so only Vector Local's resolver, once it pins one to loopback, counts it as here.
 */
export function hostClass(input: string): HostClass {
  const name = host(input)
  if (!name) return "internet"
  if (name === "localhost") return "this-computer"
  const v4 = ipv4(name)
  if (v4) return ipv4Class(v4)
  const v6 = ipv6(name)
  if (v6) return ipv6Class(v6)
  // Tailscale's names are private even though their 100.64.0.0/10 addresses are shared with ISPs.
  if (name.endsWith(".ts.net")) return "your-network"
  if (!name.includes(".")) return "your-network"
  if ([".local", ".lan", ".internal", ".home.arpa"].some((suffix) => name.endsWith(suffix))) return "your-network"
  return "internet"
}

export function loopback(input: string) {
  return hostClass(input) === "this-computer"
}

/** An http or https origin with a normalised host and no default port, or undefined. */
export function origin(input: string | URL) {
  const url = parse(input)
  if (!url) return undefined
  const name = host(url.hostname)
  if (!name) return undefined
  return `${url.protocol}//${name.includes(":") ? `[${name}]` : name}${url.port ? `:${url.port}` : ""}`
}

/** The class of a request's destination under a policy: listed when an endpoint matches, else where its host is. */
export function classify(policy: LocalMode.Policy, input: string | URL): Class {
  const url = parse(input)
  if (!url) return "internet"
  if (listed(policy, url)) return "listed"
  return hostClass(url.hostname)
}

/** Whether the url's origin is on the model server list. */
export function listed(policy: LocalMode.Policy, input: string | URL) {
  const url = parse(input)
  if (!url) return false
  return policy.endpoints.some((endpoint) => endpointMatches(endpoint, url))
}

/**
 * Whether the policy names the url's origin outside the model server list: it matches a managed `endpoint_domains`
 * pattern, or its host is a site on `web_domains.allow` (the company's, and the user's where the user may add one).
 */
export function named(policy: LocalMode.Policy, input: string | URL) {
  const url = parse(input)
  const normal = url ? origin(url) : undefined
  if (!url || !normal) return false
  return policy.endpoint_domains.some((pattern) => endpointPattern(normal, pattern)) || webAllowed(policy, url.hostname)
}

/**
 * Whether a listed origin may be reached wherever its name resolves: a company's own endpoint always, since its
 * `gpu.internal` may sit on its own public range, and the user's while no lock limits the user to their network.
 * Under a lock, a name the user listed that says it is on their network must resolve there.
 */
export function exempt(policy: LocalMode.Policy, input: string | URL) {
  const url = parse(input)
  if (!url) return false
  return policy.endpoints.some(
    (endpoint) => endpointMatches(endpoint, url) && (endpoint.from === "managed" || !policy.lock),
  )
}

/** Whether a host is `pattern` or under it. A leading "*." is the same as none. */
export function domainMatches(input: string, pattern: string) {
  const name = host(input)
  const base = host(pattern.replace(/^\*\./, ""))
  if (!name || !base) return false
  return name === base || name.endsWith(`.${base}`)
}

/**
 * Whether a host matches a pattern from a list of hosts: a name or `*.name`, as `domainMatches` reads it, or a name
 * with `*` inside a label, such as `*-aiplatform.googleapis.com` or `bedrock-runtime.*.amazonaws.com`, where the `*`
 * stands for a region or a resource name. Either covers the names under it too.
 */
export function hostMatches(input: string, pattern: string) {
  const inner = pattern.trim().toLowerCase().replace(/^\*\./, "")
  if (!inner.includes("*")) return domainMatches(input, pattern)
  const name = host(input)
  if (!name) return false
  const source = inner
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-z0-9-]+")
  return new RegExp(`^(?:[a-z0-9-]+\\.)*${source}$`).test(name)
}

/**
 * The cheap gate a labelled call site asks before it builds a request: true when the source cannot be sent at all
 * under this policy, so it is skipped without an attempt and without a log line. Requests that depend on their
 * destination (model calls, web pages, downloads) are always decided per request instead.
 */
export function blocks(
  policy: LocalMode.Policy,
  source: { readonly id: string; readonly local: LocalMode.SourceLocal; readonly purpose: LocalMode.Purpose },
) {
  if (!policy.enabled) return false
  if (source.purpose === "inference") return false
  if (source.local === "not-allowable") return true
  if (source.local !== "blocked" && source.local !== "allow-with-reason") return false
  return !policy.allow.some((entry) => entry.source === source.id)
}

/** Whether a request may go under the policy in effect. Local off allows everything. */
export function decide(policy: LocalMode.Policy, request: Request): Verdict {
  const url = parse(request.url)
  const cls = url ? classify(policy, url) : "internet"
  const verdict = (decision: LocalMode.Decision, rule: LocalMode.Rule, reason: string, allowable = false) => ({
    decision,
    rule,
    class: cls,
    reason,
    allowable,
  })
  if (!policy.enabled) return verdict("allow", "local-off", "Vector Local is off.")
  if (!url) return verdict("block", "unlabelled", "This request has no http or https address.")
  const name = url.hostname
  // Where the host is, whether or not it is also on the list: the web rules go by place, model calls by the list.
  const place = hostClass(name)
  const onList = cls === "listed"
  const nearby = place === "this-computer" || place === "your-network"
  if (policy.pending)
    return place === "this-computer"
      ? verdict("allow", "pending", "Vector Local is starting; this computer is reachable.")
      : verdict(
          "block",
          "pending",
          "Vector Local is starting, so only this computer is reachable until its policy is read.",
        )
  const allowed = allowEntry(policy, request.source, name)
  const offline = policy.web === "none" && place === "internet"
  // A source the registry marks not allowable stays blocked whatever the user allows. Only a cloud AI service the
  // company lists itself (a private cloud deployment) lets its model calls through; a listed Ollama server's cloud
  // models, free models and Vector Codium stay off, since the company listed the server, not where they go.
  const registered = request.source === undefined ? undefined : LocalSources.get(request.source)
  if (registered?.local === "not-allowable" && !(request.source === "cloud-inference" && companyListed(policy, url)))
    return verdict(
      "block",
      "not-allowable",
      "This service sends your work outside the servers you listed, so Vector Local keeps it off.",
    )

  if (request.purpose === "inference") {
    if (VECTOR_HOSTS.some((item) => domainMatches(name, item))) return verdict("block", "not-allowable", VECTOR_REFUSED)
    if (onList) return verdict("allow", "listed", "This model server is on your list.")
    return verdict("block", "not-listed", "Model calls go only to the model servers on your list.")
  }

  if (request.purpose === "web-search") {
    if (policy.web === "none") return verdict("block", "web-none", "Web access is set to None, so searches are off.")
    if (policy.web === "network" && !nearby && !webAllowed(policy, name))
      return verdict("block", "web-network", "Web access is set to your network only.")
    if (onList) return verdict("allow", "listed", "This search server is on your list.")
    if (allowed) return verdict("allow", "allowed-source", `You allowed this search service: ${allowed.reason}`)
    return verdict(
      "block",
      "not-listed",
      "Searches go only to a search server on your list or a service you allow.",
      true,
    )
  }

  if (WEB.has(request.purpose)) {
    if (place === "this-computer") return verdict("allow", "loopback", "Pages on this computer stay on this computer.")
    if (policy.web_domains.deny.some((pattern) => domainMatches(name, pattern)))
      return verdict("block", "web-deny", "This site is on the list of sites Vector never reaches.")
    if (policy.web === "none") return verdict("block", "web-none", "Web access is set to None.")
    if (policy.web === "ask")
      return verdict("allow", "web-ask", "Web access is set to Ask; the usual approval still applies.")
    if (nearby || webAllowed(policy, name))
      return verdict("allow", "web-allow", "This site is on your network or on your company's list.")
    return verdict("block", "web-network", "Web access is set to your network only.")
  }

  if (VECTOR_SERVICES.has(request.purpose)) {
    if (place === "this-computer") return verdict("allow", "loopback", "This request stays on this computer.")
    if (offline) return verdict("block", "web-none", "Web access is set to None, so Vector makes no internet requests.")
    if (allowed) return verdict("allow", "allowed-source", `You allowed this service: ${allowed.reason}`)
    return verdict(
      "block",
      "vector-service",
      "Vector Local blocks requests to Vector's own services unless you allow one.",
      true,
    )
  }

  if (request.purpose === "updates") {
    if (policy.updates && origin(policy.updates.url) === origin(url))
      return verdict("allow", "mirror", "Updates come from your company's mirror.")
    if (offline) return verdict("block", "web-none", "Web access is set to None, so Vector does not check for updates.")
    if (request.manual)
      return verdict("ask", "manual-check", "You asked to check for updates; Vector asks before it does.")
    return verdict("block", "automatic-update", "Vector Local turns off automatic update checks.", true)
  }

  if (DOWNLOADS.has(request.purpose)) {
    if (onList || place === "this-computer")
      return verdict("allow", "listed", "This download comes from a server on your list.")
    if (offline) return verdict("block", "web-none", "Web access is set to None, so Vector downloads nothing.")
    if (allowed) return verdict("allow", "allowed-source", `You allowed this download: ${allowed.reason}`)
    if (request.granted) return verdict("allow", "download-grant", "You allowed this download once.")
    return verdict("ask", "download-grant", "Vector asks before it downloads this, once.", true)
  }

  if (request.purpose === "git-remote") {
    if (nearby || onList) return verdict("allow", "private-remote", "This git server is on your computer or network.")
    if (offline) return verdict("block", "web-none", "Web access is set to None, so git reaches no internet server.")
    if (policy.web === "network" && !webAllowed(policy, name))
      return verdict("block", "web-network", "Web access is set to your network only.")
    if (allowed) return verdict("allow", "allowed-source", `You allowed this git server: ${allowed.reason}`)
    return verdict(
      "block",
      "not-listed",
      "Vector Local blocks Vector's own git requests to internet servers unless you allow one.",
      true,
    )
  }

  if (CONNECTED.has(request.purpose)) {
    if (onList || place === "this-computer")
      return verdict("allow", "listed", "This server is on this computer or on your list.")
    if (offline) return verdict("block", "web-none", "Web access is set to None.")
    if (allowed) return verdict("allow", "allowed-source", `You allowed this service: ${allowed.reason}`)
    return verdict(
      "block",
      "not-listed",
      "Vector Local blocks this service unless you list its host or allow it.",
      true,
    )
  }

  if (onList || place === "this-computer")
    return verdict("allow", "listed", "This request stays on this computer or your list.")
  return verdict("block", "unlabelled", "Vector Local blocks requests no part of Vector labelled.")
}

/**
 * The policy in effect, from the managed file and the user's own config. The environment can only tighten it:
 * VECTOR_LOCAL=1 turns it on, VECTOR_LOCAL_WEB sets a stricter Web access, and VECTOR_LOCAL_POLICY (the desktop's
 * policy for an engine in WSL) can add enabled, a stricter Web access and endpoints, never a lock. A repository's
 * block is never read.
 */
export function resolve(input: Sources): LocalMode.Policy {
  const warnings: string[] = []
  if (input.repository !== undefined) warnings.push(REPOSITORY_IGNORED)
  const managed = input.managed ?? {}
  const user = userBlock(input.global, warnings)
  const environment = environmentBlock(input.env ?? {}, warnings)
  const lock = managed.lock === true
  // Without a lock the user may change every key; managed values still come first, as managed config does.
  const userMay = new Set<string>(lock ? (managed.user_may ?? []) : ["endpoints", "allow", "web_domains", "web"])
  if (lock) lockedOut(user, userMay, warnings)
  const web = [
    userMay.has("web") ? user.web : undefined,
    environment.web,
    environment.policy?.web,
  ].reduce<LocalMode.Web>((current, next) => stricter(current, next), managed.web ?? "ask")
  // Turning Vector Local on only tightens, so any source may; only a lock forces it.
  const enabled =
    lock ||
    managed.enabled === true ||
    user.enabled === true ||
    environment.enabled ||
    environment.policy?.enabled === true
  const rules = {
    lock,
    patterns: managed.endpoint_domains ?? [],
    cloud: input.cloudHosts ?? LocalSources.CLOUD_INFERENCE_HOSTS,
  }
  const endpoints = dedupe([
    ...(managed.endpoints ?? []).flatMap((item) => managedEndpoint(item, warnings)),
    ...(userMay.has("endpoints")
      ? [
          ...(user.endpoints ?? []).map((item) => ({ origin: item, from: "user" as const })),
          ...(environment.policy?.endpoints ?? []).map((item) => ({ origin: item, from: "environment" as const })),
        ].flatMap((item) => userEndpoint(item, rules, warnings))
      : []),
  ])
  return {
    enabled,
    web,
    lock,
    endpoints,
    web_domains: {
      allow: [
        ...(managed.web_domains?.allow ?? []),
        ...(userMay.has("web_domains") ? (user.web_domains?.allow ?? []) : []),
      ],
      // A site a user never wants reached only tightens, so it always applies.
      deny: [...(managed.web_domains?.deny ?? []), ...(user.web_domains?.deny ?? [])],
    },
    allow: [...(managed.allow ?? []), ...(userMay.has("allow") ? (user.allow ?? []) : [])],
    ...(managed.updates ? { updates: managed.updates } : {}),
    user_may: lock ? [...userMay] : [],
    locked_keys: managed.locked_keys ?? [],
    endpoint_domains: managed.endpoint_domains ?? [],
    ...pinsOf(managed, user),
    warnings,
  }
}

// The servers' identity pins, by origin as requests name it. A company's pin for a server wins over the user's.
function pinsOf(managed: ConfigLocalV1.Info, user: ConfigLocalV1.Info) {
  const pins = Object.fromEntries(
    [...Object.entries(user.pins ?? {}), ...Object.entries(managed.pins ?? {})].flatMap(([key, pin]) => {
      const at = origin(key)
      return at ? [[at, pin] as const] : []
    }),
  )
  return Object.keys(pins).length > 0 ? { pins } : {}
}

function parse(input: string | URL) {
  if (!(input instanceof URL) && !URL.canParse(input)) return undefined
  const url = input instanceof URL ? input : new URL(input)
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
}

// Under a lock, the user's own values for keys outside `user_may` are dropped; the pane says which.
function lockedOut(user: ConfigLocalV1.Info, userMay: ReadonlySet<string>, warnings: string[]) {
  const dropped = [
    user.endpoints?.length && !userMay.has("endpoints") ? "endpoints" : undefined,
    user.allow?.length && !userMay.has("allow") ? "allow" : undefined,
    user.web_domains?.allow?.length && !userMay.has("web_domains") ? "web_domains.allow" : undefined,
    user.web !== undefined && !userMay.has("web") ? "web" : undefined,
  ].filter((key): key is string => key !== undefined)
  if (dropped.length > 0)
    warnings.push(`Your company set Vector Local, so ${dropped.join(", ")} in your user config do not apply.`)
}

/**
 * The allow entry that lets `source`'s request to `name` through, if any. An entry's hosts limit it to those hosts and
 * the names under them; an entry with none covers every host the source's labelled requests go to. The registry's
 * hosts are not that limit: they are the hosts a source usually reaches, and a source also follows redirects and
 * mirrors the registry does not list (Hugging Face's download hosts, GitHub's attachment and release-asset hosts, the
 * language-server installers' other hosts, a cloud computer's viewer, VECTOR_MODELS_URL), while a source whose address
 * the user or company sets lists none. Narrowing host-less entries waits on a registry audit.
 */
function allowEntry(policy: LocalMode.Policy, source: string | undefined, name: string) {
  if (!source) return undefined
  return policy.allow.find(
    (entry) =>
      entry.source === source && (!entry.hosts?.length || entry.hosts.some((pattern) => hostMatches(name, pattern))),
  )
}

function companyListed(policy: LocalMode.Policy, url: URL) {
  return policy.endpoints.some((endpoint) => endpoint.from === "managed" && endpointMatches(endpoint, url))
}

function webAllowed(policy: LocalMode.Policy, name: string) {
  return policy.web_domains.allow.some((pattern) => domainMatches(name, pattern))
}

function endpointMatches(endpoint: LocalMode.Endpoint, url: URL) {
  if (endpoint.from !== "managed") return origin(endpoint.origin) === origin(url)
  const range = cidr(endpoint.origin)
  if (range) return range(url.hostname)
  const wildcard = /^(https?:)\/\/\*\.([^/:]+)(?::(\d+))?\/?$/i.exec(endpoint.origin.trim())
  if (!wildcard) return origin(endpoint.origin) === origin(url)
  const name = host(url.hostname)
  const base = host(wildcard[2]!)
  const port = wildcard[3] ?? ""
  return Boolean(
    name && base && url.protocol === wildcard[1]!.toLowerCase() && url.port === port && name.endsWith(`.${base}`),
  )
}

// "10.0.0.0/8" or "fd00::/8": a range of addresses, matched against an address literal only. A name's addresses are
// unknown at this layer, so a name never matches a range here.
function cidr(input: string) {
  const match = /^\[?([0-9a-f.:]+)\]?\/(\d{1,3})$/i.exec(input.trim())
  if (!match) return undefined
  const bits = Number(match[2])
  const v4 = ipv4(match[1]!)
  if (v4 && bits <= 32)
    return (candidate: string) => {
      const name = host(candidate)
      const value = name ? ipv4(name) : undefined
      return Boolean(value && prefix(v4, value, bits, 8))
    }
  const v6 = ipv6(match[1]!)
  if (v6 && bits <= 128)
    return (candidate: string) => {
      const name = host(candidate)
      const value = name ? ipv6(name) : undefined
      return Boolean(value && prefix(v6, value, bits, 16))
    }
  return undefined
}

function prefix(range: readonly number[], value: readonly number[], bits: number, width: number) {
  return range.every((part, index) => {
    const keep = Math.max(0, Math.min(width, bits - index * width))
    if (keep === 0) return true
    const mask = ((1 << keep) - 1) << (width - keep)
    return (part & mask) === ((value[index] ?? 0) & mask)
  })
}

function managedEndpoint(item: string, warnings: string[]): LocalMode.Endpoint[] {
  const normal = origin(item)
  const wildcard = /^https?:\/\/\*\.([^/:]+)/i.exec(item.trim())?.[1]
  const name = wildcard ?? (normal ? new URL(normal).hostname : undefined)
  // Vector's own models are never a server the company hosts, so no policy can list them.
  if (name && VECTOR_HOSTS.some((pattern) => domainMatches(name, pattern))) {
    warnings.push(`Ignored ${item.trim()} in your company's policy: ${VECTOR_REFUSED}`)
    return []
  }
  if (cidr(item) || wildcard || normal) return [{ origin: item.trim(), from: "managed" }]
  warnings.push(`Ignored a model server in your company's policy that is not an http or https address: ${item}`)
  return []
}

function userEndpoint(
  item: { origin: string; from: "user" | "environment" },
  rules: { lock: boolean; patterns: readonly string[]; cloud: readonly string[] },
  warnings: string[],
): LocalMode.Endpoint[] {
  if (cidr(item.origin) || item.origin.includes("*")) {
    warnings.push(`Ignored ${item.origin}: address ranges and wildcards are read from your company's policy only.`)
    return []
  }
  const normal = origin(item.origin)
  if (!normal) {
    warnings.push(`Ignored a model server that is not an http or https address: ${item.origin}`)
    return []
  }
  const name = new URL(normal).hostname
  if (VECTOR_HOSTS.some((pattern) => domainMatches(name, pattern))) {
    warnings.push(`Ignored ${normal}: ${VECTOR_REFUSED}`)
    return []
  }
  if (rules.cloud.some((pattern) => hostMatches(name, pattern)) || LocalSources.digestListed(name)) {
    warnings.push(
      `Ignored ${normal}: it is a cloud AI service, not a server you host. Your company's policy can list it.`,
    )
    return []
  }
  if (
    rules.lock &&
    hostClass(name) === "internet" &&
    !rules.patterns.some((pattern) => endpointPattern(normal, pattern))
  ) {
    warnings.push(`Ignored ${normal}: your company allows only servers on your network or the ones it names.`)
    return []
  }
  return [{ origin: normal, from: item.from }]
}

function endpointPattern(normal: string, pattern: string) {
  const range = cidr(pattern)
  const name = new URL(normal).hostname
  if (range) return range(name)
  return endpointMatches({ origin: pattern, from: "managed" }, new URL(normal)) || domainMatches(name, pattern)
}

function userBlock(block: ConfigLocalV1.Info | undefined, warnings: string[]) {
  if (!block) return {}
  const present = MANAGED_ONLY.filter((key) => block[key] !== undefined)
  if (present.length > 0)
    warnings.push(`Ignored ${present.join(", ")} in your user config: only your company's policy can set them.`)
  return Object.fromEntries(
    Object.entries(block).filter(([key]) => !(MANAGED_ONLY as readonly string[]).includes(key)),
  ) as ConfigLocalV1.Info
}

function environmentBlock(env: Readonly<Record<string, string | undefined>>, warnings: string[]) {
  const flag = env.VECTOR_LOCAL?.trim().toLowerCase()
  const webValue = env.VECTOR_LOCAL_WEB?.trim().toLowerCase()
  const web = WEB_SETTINGS.find((setting) => setting !== "ask" && setting === webValue)
  if (webValue && !web) warnings.push(`Ignored VECTOR_LOCAL_WEB=${webValue}: it can only be none or network.`)
  return {
    enabled: flag === "1" || flag === "true",
    web,
    policy: environmentPolicy(env.VECTOR_LOCAL_POLICY, warnings),
  }
}

// The desktop's policy for an engine it starts in WSL. It is the user's own setting, so it can add and tighten, but it
// cannot lock, allow a service or allow a site.
function environmentPolicy(text: string | undefined, warnings: string[]) {
  if (!text?.trim()) return undefined
  const value = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text))
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Ignored VECTOR_LOCAL_POLICY: it is not a JSON object.")
    return undefined
  }
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !["enabled", "web", "endpoints"].includes(key))
  if (extra.length > 0)
    warnings.push(`Ignored ${extra.join(", ")} in VECTOR_LOCAL_POLICY: it can only add enabled, web and endpoints.`)
  const web = WEB_SETTINGS.find((setting) => setting === record.web)
  return {
    enabled: record.enabled === true,
    web,
    endpoints: Array.isArray(record.endpoints)
      ? record.endpoints.filter((item): item is string => typeof item === "string")
      : [],
  }
}

function dedupe(endpoints: readonly LocalMode.Endpoint[]) {
  const seen = new Set<string>()
  return endpoints.filter((endpoint) => {
    const key =
      endpoint.from === "managed" ? `managed ${endpoint.origin}` : (origin(endpoint.origin) ?? endpoint.origin)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function ipv4(name: string) {
  const parts = name.split(".")
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

function ipv4Class(octets: readonly number[]): HostClass {
  const [a = -1, b = -1] = octets
  if (a === 127 || octets.every((octet) => octet === 0)) return "this-computer"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
    return "your-network"
  // 100.64.0.0/10 is shared ISP space (CGNAT), not the user's network.
  return "internet"
}

function ipv6(name: string) {
  if (!name.includes(":")) return undefined
  const halves = name.split("::")
  if (halves.length > 2) return undefined
  const read = (part: string) => {
    if (!part) return []
    const pieces = part.split(":")
    const last = pieces.at(-1) ?? ""
    const tail = last.includes(".") ? ipv4(last) : undefined
    if (last.includes(".") && !tail) return undefined
    const head = (tail ? pieces.slice(0, -1) : pieces).map((piece) =>
      /^[0-9a-f]{1,4}$/.test(piece) ? Number.parseInt(piece, 16) : Number.NaN,
    )
    return tail ? [...head, tail[0]! * 256 + tail[1]!, tail[2]! * 256 + tail[3]!] : head
  }
  const left = read(halves[0] ?? "")
  const right = read(halves[1] ?? "")
  if (!left || !right) return undefined
  const groups =
    halves.length === 1 ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff))
    return undefined
  return groups
}

function ipv6Class(groups: readonly number[]): HostClass {
  const zero = groups.slice(0, 7).every((group) => group === 0)
  if (zero && (groups[7] === 1 || groups[7] === 0)) return "this-computer"
  // An IPv4-mapped address (::ffff:a.b.c.d) is that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return ipv4Class([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff])
  if ((groups[0]! & 0xfe00) === 0xfc00 || (groups[0]! & 0xffc0) === 0xfe80) return "your-network"
  return "internet"
}
