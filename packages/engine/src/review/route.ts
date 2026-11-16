// VS-23b (SF-11): the zero data retention route rules (core privacy.ts) at admission. privacy.ts decides; this file
// gathers what it decides on from the provider, and keeps the policy and the decided model of each session Review.run
// creates, so that every provider attempt is admitted against the model its session was decided for. VS-23c's
// transport backstop is to read the same registry by a request's `x-session-id`. Under privacy "standard" nothing here
// asks the provider anything.
//
// What admission cannot see is VS-23c's: provider options changed between attempts, the request body and its features,
// a `Request` body, the native runtime, and helper requests. A model whose destination is computed at send time (a
// base URL with an unfilled `${VARIABLE}`, Vertex's and Bedrock's URLs from project and region) has none admission can
// read, so it is refused as "unknown-destination".

import type { ModelV2 } from "@vectordevai/core/model"
import type { ModelCatalog } from "@vectordevai/core/model-catalog"
import type { ProviderV2 } from "@vectordevai/core/provider"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { OllamaServer } from "@vectordevai/core/local-mode/servers/ollama"
import {
  decideRoute,
  type ReviewPrivacy,
  type RouteDecision,
  type RouteModel,
  type RouteRefusal,
} from "@vectordevai/core/review/privacy"
import type { CostKind, ReviewConfig, ZdrAttestedEntry } from "@vectordevai/core/review/types"
import { Effect, Option } from "effect"
import type { Provider } from "@/provider/provider"
import type { SessionID } from "@/session/schema"

// The route settings a review runs under: `privacy` and `zdrAttested`, from mergeReviewConfig's trusted sources.
export interface Policy {
  readonly privacy: ReviewPrivacy
  readonly attested: readonly ZdrAttestedEntry[]
}

export function policyOf(config: Pick<ReviewConfig, "privacy" | "zdrAttested">): Policy {
  return { privacy: config.privacy ?? "standard", attested: config.zdrAttested ?? [] }
}

// A model to decide, as a resolved model names it. `catalogOrigins` is where the model catalog ships its provider
// (shippedOrigins; model.ts sets it under "zdr" only): its base URL as shipped, or none for a provider defined in
// configuration. Absent means unknown.
export interface Subject {
  readonly providerID: string
  readonly modelID: string
  readonly costKind?: CostKind
  readonly catalogOrigins?: readonly string[]
}

// A route decision, with the model it was made for (keyOf) when the provider has one.
export interface Decided {
  readonly key?: string
  readonly decision: RouteDecision
}

// What a session Review.run created runs under: the review's policy and, under "zdr", the model its pass was decided
// for and that decision.
export interface Registered {
  readonly policy: Policy
  readonly key?: string
  readonly decision?: RouteDecision
}

/**
 * The refusal the model alone decides, before any provider lookup: Vector Codium, a free model, a router or preset,
 * the web plugin's `:online` variant, or a model whose provider requires retention. Undefined when only where its
 * requests go can decide, and under privacy "standard".
 */
export function modelRefusal(subject: Subject, policy: Policy): RouteRefusal | undefined {
  // The model's names and cost kind alone: without a destination nothing else can decide.
  const decision = decideRoute(
    routeModel({ providerID: subject.providerID, modelID: subject.modelID, costKind: subject.costKind }),
    policy,
  )
  return decision.allowed || decision.refusal === "unknown-destination" ? undefined : decision.refusal
}

/**
 * Whether a review may send code to this model while `policy.privacy` is in effect, from what the provider says about
 * it: its catalog entry, its provider's options (base URL, a plugin's `preconnect` and `fetch`, `forwards`) and the line
 * its requests wait in. The model's own refusals come first, so admission never looks up a free or Codium model. A
 * route that privacy.ts allows is refused while any attestation it lists sets `verify: "api"`: nothing can check an
 * account yet (Q20), so an OpenAI attestation with it is refused the same way.
 */
export const decide = Effect.fn("ReviewRoutes.decide")(function* (
  provider: Provider.Interface,
  subject: Subject & {
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
    readonly found?: Provider.Model
  },
  policy: Policy,
): Effect.fn.Return<Decided> {
  if (policy.privacy === "standard") return { decision: { allowed: true, kind: "standard" } }
  const own = modelRefusal(subject, policy)
  if (own) return { decision: { allowed: false, refusal: own } }
  const found =
    subject.found ??
    Option.getOrUndefined(yield* provider.getModel(subject.providerID, subject.modelID).pipe(Effect.option))
  if (!found) return { decision: { allowed: false, refusal: "unknown-destination" } }
  // getProvider indexes the loaded providers by ID, so an unknown one is undefined, whatever its type says.
  const info = yield* provider.getProvider(found.providerID)
  const decision = decideRoute(
    routeModel({ ...subject, found, ...(info ? { options: info.options } : {}), line: yield* provider.line(found) }),
    policy,
  )
  const unverified = decision.allowed && decision.attestations?.some((attestation) => attestation.verify === "api")
  return { key: keyOf(found), decision: unverified ? { allowed: false, refusal: "attestation-unverified" } : decision }
})

/**
 * The route rules' input for a model, from what the provider says about it (decide). Without `found` it has no
 * destination, so only the model's own refusals can decide it.
 * - `destinations`: the origin a plugin's `preconnect` option names, and the base URL requests are sent to (the
 *   provider's `baseURL` option, else the model's URL, else its SDK's own origin). A URL with an unfilled `${VARIABLE}`
 *   names no destination admission can read, so it is unknown.
 * - `defaultOrigins`: where an attestation of the provider ID applies (defaultOrigins below).
 * - `forwards`: the provider's own `fetch` (a plugin's or a sign-in's), which may send anywhere; `forwards: true`; an
 *   Ollama cloud model; and a server on this computer whose steps are not free (Provider.Line.local), which is one Check
 *   models found passes requests on.
 */
export function routeModel(
  input: Subject & {
    readonly found?: Provider.Model
    readonly options?: Readonly<Record<string, unknown>>
    readonly line?: Provider.Line
  },
): RouteModel {
  const found = input.found
  const options = input.options ?? {}
  const sdk = found ? SDK_ORIGINS[found.api.npm] : undefined
  const sent = text(options.baseURL) ?? text(found?.api.url) ?? sdk
  const destinations = (found ? [text(options.preconnect), sent] : [])
    .flatMap((url) => (url === undefined ? [] : [url]))
    .map((url) => (url.includes("${") ? UNFILLED : url))
  const here = destinations.every((url) => {
    const origin = LocalPolicy.origin(url)
    return origin !== undefined && LocalPolicy.loopback(new URL(origin).hostname)
  })
  return {
    providerID: input.providerID,
    modelID: found?.id ?? input.modelID,
    ...(found ? { apiID: found.api.id, npm: found.api.npm } : {}),
    destinations,
    defaultOrigins: defaultOrigins(input.catalogOrigins, sdk),
    ...(found && !found.cost.unpriced ? { price: { input: found.cost.input, output: found.cost.output } } : {}),
    freeModel: input.costKind === "free" || found?.freeModel !== undefined,
    forwards:
      typeof options.fetch === "function" ||
      options.forwards === true ||
      (found !== undefined && OllamaServer.cloud({ name: found.api.id })) ||
      (input.line !== undefined && !input.line.local && destinations.length > 0 && here),
  }
}

/**
 * Where the model catalog ships a provider, for Subject.catalogOrigins, from the catalog and whether the configuration
 * in effect defines the provider. "Defined in configuration" takes a positive signal, since an empty or stale catalog
 * also leaves a provider out:
 * - listed: the base URL the catalog ships the model with, else the provider's; none shipped is unknown (undefined),
 *   so routeModel falls back to the SDK's own origin;
 * - defined in configuration: the catalog loaded, does not list the provider, and the configuration defines it, so it
 *   is shipped nowhere (`[]`);
 * - unknown (undefined) otherwise: an empty catalog (no copy on disk and no snapshot, a failed or disabled fetch,
 *   offline) lists nothing, so a provider missing from it may be a catalog provider whose base URL was moved; and a
 *   provider only a plugin defines says nothing of where it is shipped.
 */
export function shippedOrigins(input: {
  readonly catalog: Readonly<Record<string, ModelCatalog.Provider>>
  readonly configured: boolean
  readonly providerID: string
  readonly modelID: string
}): readonly string[] | undefined {
  const listed = Object.hasOwn(input.catalog, input.providerID) ? input.catalog[input.providerID] : undefined
  if (listed) {
    const entry = Object.hasOwn(listed.models, input.modelID) ? listed.models[input.modelID] : undefined
    const shipped = entry?.provider?.api ?? listed.api
    return shipped ? [shipped] : undefined
  }
  if (Object.keys(input.catalog).length > 0 && input.configured) return []
  return undefined
}

export function register(sessionID: SessionID, entry: Registered) {
  sessions.set(sessionID, entry)
}

export function release(sessionID: SessionID) {
  sessions.delete(sessionID)
}

export function registered(sessionID: string): Registered | undefined {
  return sessions.get(sessionID)
}

/**
 * Whether a provider attempt in this session may be sent under its review's policy, for Review.run's synchronous
 * admission: undefined under "standard" or when the attempt's model is the one the session's pass was decided for and
 * that decision allowed it. A session that is not registered, was never decided, or now sends with another model (a
 * switch of model, URL or SDK) is "unknown-destination".
 */
export function attempt(sessionID: SessionID, model: Provider.Model): RouteRefusal | undefined {
  const entry = sessions.get(sessionID)
  if (!entry) return "unknown-destination"
  if (entry.policy.privacy === "standard") return undefined
  if (!entry.decision || entry.key === undefined || keyOf(model) !== entry.key) return "unknown-destination"
  return entry.decision.allowed ? undefined : entry.decision.refusal
}

// The sessions Review.run created and has not yet released, by session ID.
const sessions = new Map<string, Registered>()

// Where these SDKs send requests when neither configuration nor the catalog names a base URL. A copy of provider.ts's
// SDK_ORIGINS, which is private there; VS-23c's backstop checks again with provider.ts's own requestOrigins.
const SDK_ORIGINS: Record<string, string> = {
  "@ai-sdk/openai": "https://api.openai.com",
  "@ai-sdk/anthropic": "https://api.anthropic.com",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com",
}

// A provider's origin when nothing says where it is shipped: an address no request goes to (`.invalid` never
// resolves), and no OpenRouter's.
const UNKNOWN_ORIGIN = "https://unknown-shipped-origin.invalid"
// A destination with an unfilled variable, as text that reads as no URL.
const UNFILLED = "a base URL with an unfilled variable"

// privacy.ts's `defaultOrigins`, the origins an attestation of the provider ID covers, from `catalogOrigins`
// (shippedOrigins) and the SDK's own origin.
function defaultOrigins(catalogOrigins: readonly string[] | undefined, sdk: string | undefined): readonly string[] {
  // Shipped at a URL the catalog names.
  if (catalogOrigins?.length) return catalogOrigins
  // Listed without a URL, or defined in configuration, on an SDK that names its own origin.
  if (sdk) return [sdk]
  // Defined in configuration and shipped nowhere: none, so its attestation may be an OpenRouter account.
  if (catalogOrigins) return []
  // Unknown: an origin no request goes to, so its attestation covers no host and holds no OpenRouter account, and a
  // direct provider whose base URL was moved to OpenRouter is refused.
  return [UNKNOWN_ORIGIN]
}

// The model a session sends with, as admission compares it: the provider, the model, and the ID, SDK and URL it is
// sent as.
function keyOf(model: Provider.Model) {
  return [model.providerID, model.id, model.api.id, model.api.npm, model.api.url].join("\n")
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export * as ReviewRoutes from "./route"
