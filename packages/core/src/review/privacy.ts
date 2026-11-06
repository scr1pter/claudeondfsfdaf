// Zero data retention route rules (VectorScope upgrade contract, VS-23a): which routes a review may send code on while
// `privacy` is "zdr", and the OpenRouter request body such a review sends. Pure and browser-safe.
//
// Nothing calls this yet. VS-23b's admission (model resolution and Review.run) will call decideRoute for every model a
// review may use, and VS-23c's transport backstop will call it again at the top of resolveSDK and apply zdrRequestBody
// to the final body of a request on an "openrouter-attested" route. Every other allowed route sends its body unchanged:
// `provider` is OpenRouter's field, which a direct provider or a model server does not read.
//
// ZDR reduces retention; it cannot rule it out (invariant I-3). A provider may keep content its safety systems flag
// (Anthropic up to two years), legal holds override any agreement, and account settings Vector cannot see, such as
// OpenRouter's logging and Safety Retention, still apply. An entry in `zdrAttested` is the owner's statement about
// those; nothing here checks it.

import {
  denyDataCollection,
  isOpenRouterFreeModel,
  isOpenRouterURL,
  openRouterModelRouting,
  sendsToOpenRouter,
  sendsToOpenRouterFree,
} from "../free-model-catalog"
import { LocalPolicy } from "../local-mode/policy"
import { ModelPlanStatus } from "../model-plan-status"
import type { ReviewConfig } from "./types"

export type ReviewPrivacy = NonNullable<ReviewConfig["privacy"]>

// Why a route is refused (contract §1.2). The transport backstop (VS-23c) also refuses a Batch request ("batch") and a
// request whose session cannot be told ("unattributed-request").
export const ROUTE_REFUSALS = [
  "free-model",
  "router-or-preset",
  "fallback-models",
  "plugins",
  "unattested-provider",
  "unattested-openrouter",
  "unattested-network-server",
  "retention-required-model",
  "codium-unaccepted",
  "batch",
  "unreadable-body",
  "unattributed-request",
  "unknown-destination",
] as const
export type RouteRefusal = (typeof ROUTE_REFUSALS)[number]

// How an allowed route is allowed:
// - "standard": privacy is "standard", so no rule applies, as before VS-23;
// - "loopback": a server on this computer that passes nothing on;
// - "openrouter-attested": OpenRouter on an attested account, sent with zdrRequestBody;
// - "attested-provider": an attested provider at an origin it reaches without configuration (`defaultOrigins`);
// - "attested-host": a model server or host listed in `zdrAttested`.
export type RouteKind = "standard" | "loopback" | "openrouter-attested" | "attested-provider" | "attested-host"
export type RouteDecision = { allowed: true; kind: RouteKind } | { allowed: false; refusal: RouteRefusal }

export interface RouteModel {
  providerID: string
  modelID: string
  // The ID sent, when configuration sends one other than modelID (`api.id`).
  apiID?: string
  // The SDK package, such as @ai-sdk/anthropic. It is no place a request goes, but OpenRouter's names OpenRouter.
  npm?: string
  // Where requests go, as URLs: the model's and its provider's base URLs, and the origins the requests are actually
  // sent to (provider.ts requestOrigins: the base URL with its variables filled in, else the SDK's own origin, and a
  // plugin's preconnect origin). Every one must be allowed, and with none nothing says where requests go, so the caller
  // passes the SDK's default origin too. Every text here is read as a URL, so a bare name (`gpu-box`) is unknown.
  destinations: readonly unknown[]
  // The origins the provider reaches without configuration: provider.ts SDK_ORIGINS, or the catalog's URL as shipped.
  // An attestation of the provider ID covers only these, so a base URL set anywhere else needs its own host attested.
  defaultOrigins?: readonly string[]
  // The listed price, undefined when unpriced. A zero price on an OpenRouter route is free (sendsToOpenRouterFree), as
  // resolveSDK decides when it sends a model down the free route.
  price?: { readonly input: number; readonly output: number }
  // The catalog lists it as a free model.
  freeModel?: boolean
  // The server passes this model on to a service no destination names, such as an Ollama cloud model, which a local
  // Ollama server sends to ollama.com (LocalProbe holds.passesOn).
  forwards?: boolean
}

/**
 * Whether a review may send code to this model while `privacy` is `policy.privacy`. `policy.attested` is
 * `zdrAttested`: provider IDs (`openrouter` for an OpenRouter account) and model server hosts, with a port for that
 * port alone or without one for every port.
 * The model's own refusals come first, so no attestation overrides them: Vector Codium, free models, routers and
 * presets, the web plugin's `:online` variant, and models whose provider requires retention. Then every destination
 * must be allowed:
 * - Vector's own site (Codium and the free route) is refused;
 * - a model whose requests go to OpenRouter needs its provider ID attested, as the account, and only a provider that
 *   reaches OpenRouter without configuration (`openrouter`, or one whose `defaultOrigins` are OpenRouter's or that has
 *   none, such as a provider defined in configuration) holds an account there; OpenRouter itself over https and a
 *   stand-in on this computer (a local proxy or a test server) pass requests on to that account, and any other hop,
 *   OpenRouter over plain http included, must be an attested host as well;
 * - otherwise a server on this computer is allowed, a server on your network only when its host is attested, and a host
 *   on the internet when it is attested, or when the provider ID is attested and it is one of `defaultOrigins`.
 */
export function decideRoute(
  model: RouteModel,
  policy: { privacy: ReviewPrivacy; attested: readonly string[] },
): RouteDecision {
  if (policy.privacy === "standard") return { allowed: true, kind: "standard" }
  const refusal = modelRefusal(model)
  if (refusal) return refuse(refusal)
  if (model.forwards) return refuse("unknown-destination")
  const origins = requestOrigins(model.destinations)
  if (!origins?.length) return refuse("unknown-destination")
  // An untyped caller (a raw global config) may pass entries that are not text; they attest nothing.
  const entries = policy.attested.filter((entry): entry is string => typeof entry === "string")
  const attested = {
    provider: entries.some((entry) => entry.trim() === model.providerID),
    hosts: entries.flatMap((entry) => attestedHost(entry) ?? []),
    defaults: (model.defaultOrigins ?? []).flatMap((item) => LocalPolicy.origin(item.trim()) ?? []),
  }
  if (sendsToOpenRouter({ providerID: model.providerID, destinations: destinations(model) }))
    return openRouterRoute(origins, {
      ...attested,
      // The owner attests one agreement per provider ID: a direct provider's covers that provider, not an OpenRouter
      // account its base URL may be moved to.
      provider:
        attested.provider &&
        (model.providerID === "openrouter" || !model.defaultOrigins?.length || attested.defaults.some(isOpenRouterURL)),
    })
  const verdicts = origins.map((origin) =>
    hostClassOf(origin) === "this-computer" ? "loopback" : serverVerdict(origin, attested),
  )
  const refused = verdicts.find(isRefusal)
  if (refused) return refuse(refused)
  const kind = verdicts.find((verdict) => verdict === "attested-host" || verdict === "attested-provider")
  return { allowed: true, kind: kind ?? "loopback" }
}

/**
 * Why a request body may not go to OpenRouter on a ZDR route, or undefined when zdrRequestBody may send it. `modelID`
 * is the ID the request was made for; the body's own `model` is what OpenRouter routes on, so both are checked.
 */
export function zdrBodyRefusal(body: unknown, modelID: string): RouteRefusal | undefined {
  const fields = record(body)
  if (!fields) return "unreadable-body"
  const named = idRefusal([modelID, fields.model])
  if (named) return named
  const routing = openRouterModelRouting(fields, undefined)
  if (routing.includes("preset")) return "router-or-preset"
  if (routing.some((field) => field !== "plugins")) return "fallback-models"
  // Any plugin list, the web plugin that keeps the model (openRouterModelRouting allows it), an empty list and one that
  // turns a plugin off included, and a web search setting: both may send the query to a search provider.
  if (["plugins", "web_search_options"].some((key) => Object.hasOwn(fields, key))) return "plugins"
  return undefined
}

/**
 * The body a request to OpenRouter sends on a ZDR route: `provider.zdr` true and `provider.data_collection` "deny",
 * whatever the configuration set there, and every other provider preference as it was (order, only, ignore,
 * allow_fallbacks, sort, max_price, quantizations, and a require_parameters already set). It never adds
 * require_parameters, which is not a privacy control, and never changes its input. Undefined, so the caller refuses the
 * request, when zdrBodyRefusal names a reason.
 */
export function zdrRequestBody(body: unknown, modelID: string): Record<string, unknown> | undefined {
  const fields = record(body)
  if (!fields || zdrBodyRefusal(fields, modelID)) return undefined
  return denyDataCollection({ ...fields, provider: { ...record(fields.provider), zdr: true } })
}

// OpenRouter's `:online` variant turns on its web plugin, which sends the query to a search provider, wherever it sits
// in a stacked variant (`:online:nitro`, `:nitro:online`). From OpenRouter's model variants as recalled: its docs could
// not be read here, so VS-23c's fake server checks the wire.
const ONLINE = /:online(?:$|[:@])/
// Anthropic's Covered Models need 30-day retention and are not available under ZDR unless Anthropic expressly
// authorizes the organization: Claude Fable 5 and 5.1 and Mythos 5 and 5.1, read 2026-11-05 [enablers §1.6]. Matched
// as a token on every provider (OpenRouter, Bedrock, Vertex and aliases), so a digit may follow (`fable5`) and a letter
// may not (`fabled-coder`). Update when Anthropic changes the list.
const RETENTION_REQUIRED = /(?:^|[^a-z0-9])(?:fable|mythos)(?![a-z])/
const CODIUM_HOST = new URL(ModelPlanStatus.SITE).hostname

// `port` is undefined when the entry named none, and then the host is attested on every port.
type AttestedHost = { host: string; port?: string }
type Attested = { provider: boolean; hosts: readonly AttestedHost[]; defaults: readonly string[] }

function modelRefusal(model: RouteModel): RouteRefusal | undefined {
  if (model.providerID === ModelPlanStatus.PROVIDER_ID) return "codium-unaccepted"
  // Vector's free models, the catalog's free flag, and anything resolveSDK would send down the free route.
  if (
    model.freeModel ||
    model.providerID === "vector" ||
    sendsToOpenRouterFree({ ...model, id: model.modelID, destinations: destinations(model), price: model.price })
  )
    return "free-model"
  return idRefusal([model.modelID, model.apiID])
}

// What decides where a model's requests go, as free-model-catalog.ts reads it: the URLs and the SDK package.
function destinations(model: RouteModel) {
  return [model.npm, ...model.destinations]
}

// The refusals a model ID alone decides, for decideRoute and for the body's own `model`: a free variant, the free
// router or a stealth model; one of OpenRouter's routers or a preset; the web plugin's variant; a Covered Model.
function idRefusal(ids: readonly unknown[]): RouteRefusal | undefined {
  const names = ids.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim().toLowerCase()] : []))
  if (names.some((id) => isOpenRouterFreeModel(id, undefined))) return "free-model"
  if (names.some((id) => openRouterModelRouting(undefined, id).length > 0)) return "router-or-preset"
  if (names.some((id) => ONLINE.test(id))) return "plugins"
  if (names.some((id) => RETENTION_REQUIRED.test(id))) return "retention-required-model"
  return undefined
}

// The http and https origins of a model's destinations, or undefined when one of them is no place a request can be
// read as going: another scheme, no host, or text that is not a URL (a bare name included). Blank values are unset.
function requestOrigins(destinations: readonly unknown[]) {
  const urls = destinations.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
  const origins = urls.flatMap((item) => LocalPolicy.origin(item) ?? [])
  return origins.length === urls.length ? origins : undefined
}

// A model whose requests go to OpenRouter. OpenRouter itself over https, and a stand-in for it on this computer, pass
// requests on to the account, which `attested.provider` covers; any other hop must be an allowed server in its own
// right, and OpenRouter over plain http is such a hop, since it would carry the code and the account's key in clear.
function openRouterRoute(origins: readonly string[], attested: Attested): RouteDecision {
  const hop = origins
    .filter(
      (origin) =>
        !(isOpenRouterURL(origin) && origin.startsWith("https://")) && hostClassOf(origin) !== "this-computer",
    )
    .map((origin) => serverVerdict(origin, { ...attested, defaults: [] }))
    .find(isRefusal)
  if (hop) return refuse(hop)
  return attested.provider ? { allowed: true, kind: "openrouter-attested" } : refuse("unattested-openrouter")
}

// A destination that is neither this computer nor OpenRouter: Vector's own site, a server on your network, or a host
// on the internet. A provider-ID attestation never covers a server on your network.
function serverVerdict(origin: string, attested: Attested): RouteRefusal | "attested-host" | "attested-provider" {
  const host = hostOf(origin)
  if (host === CODIUM_HOST || host.endsWith(`.${CODIUM_HOST}`)) return "codium-unaccepted"
  const port = portOf(origin)
  if (attested.hosts.some((item) => item.host === host && (item.port === undefined || item.port === port)))
    return "attested-host"
  if (LocalPolicy.hostClass(host) === "your-network") return "unattested-network-server"
  return attested.provider && attested.defaults.includes(origin) ? "attested-provider" : "unattested-provider"
}

// An entry of `zdrAttested` as a host: a name or address in any case, alone for every port or with one port
// (`gpu-box:8080`, `[fd00::1]:8080`; a bare IPv6 address names no port). Undefined for a URL or anything else that
// names no host. Every entry is read both ways: `gpu-box` attests a host of that name and a provider of that ID, both
// the owner's own statement, and each reading covers only its own rule above.
function attestedHost(entry: string): AttestedHost | undefined {
  const text = entry.trim()
  const bare = LocalPolicy.host(text)
  if (bare) return { host: bare }
  if (/[\s/@?#\\]/.test(text) || !URL.canParse(`http://${text}`)) return undefined
  const url = new URL(`http://${text}`)
  const host = LocalPolicy.host(url.hostname)
  if (!host) return undefined
  // The URL drops http's own port, so an entry that names :80 reads as no port there.
  return /:\d+$/.test(text) ? { host, port: url.port || "80" } : { host }
}

function hostOf(origin: string) {
  return LocalPolicy.host(new URL(origin).hostname) ?? ""
}

// The port an origin's requests use: LocalPolicy.origin leaves a scheme's own port out.
function portOf(origin: string) {
  const url = new URL(origin)
  return url.port || (url.protocol === "https:" ? "443" : "80")
}

function hostClassOf(origin: string) {
  return LocalPolicy.hostClass(hostOf(origin))
}

function isRefusal(verdict: string): verdict is RouteRefusal {
  return (ROUTE_REFUSALS as readonly string[]).includes(verdict)
}

function refuse(refusal: RouteRefusal): RouteDecision {
  return { allowed: false, refusal }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
