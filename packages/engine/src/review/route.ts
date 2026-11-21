// VS-23b (SF-11): the zero data retention route rules (core privacy.ts) at admission. privacy.ts decides; this file
// gathers what it decides on from the provider, and keeps the policy, the decided model and what admission decided on
// for each session Review.run creates, so that every provider attempt is admitted against the model its session was
// decided for. Under privacy "standard" nothing here asks the provider anything.
//
// VS-23c (SF-12a): the transport backstop. provider.ts calls `hold` at the top of every model call's fetch on the plan
// route, the free route and the generic V1 fetch, with the request's `x-session-id`, and `sendBody` on the generic
// fetch's final body; a refusal throws `Refused` before anything is sent. A request of a session registered under
// "zdr" is decided again on what admission decided on plus every destination the transport sees, and its body must be
// a JSON string the body, path and feature checks allow, and it follows no redirect. A request that names a "zdr"
// session the review has released is refused. Every other request, the owner's own (no header), an unregistered
// session's or a "standard" one's, is left exactly as it was.
//
// VS-23c (SF-12b): the session runtime. session/llm.ts calls `turn` before it reads anything or chooses a runtime: a
// "zdr" session sends only its pass's own turns, made with the agent Review.run registered for it, and only on the AI
// SDK runtime, whose fetch is provider.ts's and holds them; never on the native runtime, which sends through
// @vectordevai/llm and never reaches that fetch, nor on a GitLab Duo workflow model's own connection. Its title, memory
// learner, skill drafter, compaction summary and judge requests, its calls once released, and every call of a session
// whose parent is a "zdr" session, are refused there. prompt.ts never starts a compaction of a "zdr" session (`zdr`).
// A model whose destination is computed at send time (a base URL with an unfilled `${VARIABLE}`, Vertex's and
// Bedrock's URLs from project and region) has none admission can read, so it is refused as "unknown-destination".
//
// VS-23d (SF-15): the engine server's own hold. The desktop creates and prompts its review sessions over HTTP, so no
// Review.run registers them. The session HTTP prompt (handlers/session.ts) adopts a `vectorscope.*` session no review
// holds (`known`) when the server's policy (`serverPolicy`: the user config's hidden `review` block alone) or the
// prompt's review scope says "zdr": it registers the session under "zdr", with the attestations of the user config,
// for the prompt's agent and the decision for the prompt's model (`adopt`), so hold and turn refuse an unattested route
// before anything is sent. prompt.ts refuses any run of a `vectorscope.*` session no review holds while either says
// "zdr" (a session forgotten past RELEASED_LIMIT, one from before a restart, a command or a summary). Nothing here
// changes under "standard": nothing is adopted, and every request is sent as before.

import type { ModelV2 } from "@vectordevai/core/model"
import type { ModelCatalog } from "@vectordevai/core/model-catalog"
import type { ProviderV2 } from "@vectordevai/core/provider"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { OllamaServer } from "@vectordevai/core/local-mode/servers/ollama"
import {
  decideRoute,
  directOpenAiRetention,
  zdrBatchBodyRefusal,
  zdrBodyRefusal,
  zdrFeatureRefusal,
  zdrPathRefusal,
  zdrRequestBody,
  type ReviewPrivacy,
  type RouteDecision,
  type RouteKind,
  type RouteModel,
  type RouteRefusal,
} from "@vectordevai/core/review/privacy"
import { mergeReviewConfig, type SourcedReviewKey } from "@vectordevai/core/review/config"
import type { CostKind, ReviewConfig, ZdrAttestedEntry } from "@vectordevai/core/review/types"
import { Effect, Option, Schema } from "effect"
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

// A route decision, with the model it was made for (keyOf) and what it was decided on when the provider has one.
export interface Decided {
  readonly key?: string
  readonly decision: RouteDecision
  readonly decidedOn?: RouteModel
}

// What a session Review.run created runs under: the review's policy, the agent its pass is prompted with and, under
// "zdr", the model its pass was decided for, that decision, and what it was decided on, which the transport (hold)
// decides again with what it sees. Under "zdr" `agent` is the only agent whose requests the session runtime sends for
// the session (turn), so every registrant must set it, or no turn of the session is sent: Review.run sets its pass's
// agent, and the HTTP adoption (adopt, SF-15) the agent the desktop's prompt names.
export interface Registered {
  readonly policy: Policy
  /** Private Brain context was approved only for the original provider endpoint and origins. */
  readonly pinDestinations?: true
  readonly agent?: string
  readonly key?: string
  readonly decision?: RouteDecision
  readonly decidedOn?: RouteModel
}

// What the transport does with a model call (hold): refuse it, or send it on a route of this kind.
export type Held = { readonly refusal: RouteRefusal } | { readonly kind: RouteKind }

// What the session runtime does with a model call (turn): refuse it, or send it on the AI SDK runtime, whose fetch is
// provider.ts's and holds it.
export type Turn = { readonly refusal: RouteRefusal } | { readonly runtime: "ai-sdk" }

/**
 * VS-23c's refusal of a model call, before anything is sent: thrown by provider.ts's fetch (`site` "transport"), or
 * failed by the session runtime before it chose a runtime or built a request (`site` "session", turn). A plain Error,
 * so the AI SDK rethrows it as it is and the session does not retry it.
 */
export class Refused extends Error {
  public override readonly name = "ZdrRouteRefused"

  constructor(
    public readonly refusal: RouteRefusal,
    public readonly site: "transport" | "session" = "transport",
  ) {
    super(
      site === "session"
        ? `Vector did not send this request: this review's privacy is "zdr", and its sessions send only a review pass's own turns, on a connection the route rules hold (${refusal}). Nothing was sent.`
        : `Vector did not send this request: this review's privacy is "zdr", and the route rules refused it (${refusal}). Nothing was sent.`,
    )
  }
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
 * route that privacy.ts allows is refused while any attestation it lists sets `verify: "api"` (verified). The result
 * carries what it was decided on (`decidedOn`), which the session registry keeps for the transport (hold).
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
  const decidedOn = routeModel({
    ...subject,
    found,
    ...(info ? { options: info.options } : {}),
    line: yield* provider.line(found),
  })
  return { key: keyOf(found), decision: verified(decideRoute(decidedOn, policy)), decidedOn }
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

/**
 * VS-23d (SF-15): the route settings the engine server holds a `vectorscope.*` session to when no review registered it:
 * the user config's `review` block alone (Config.getGlobal().review), as mergeReviewConfig reads it on "local". No
 * repository and no environment variable is read here: the desktop, whose sessions these are, reads no REVIEW_*
 * variable either, so both sides decide from the same sources. A value that is not a level reads as "zdr".
 */
export function serverPolicy(global: Partial<Record<SourcedReviewKey, unknown>> | undefined): Policy {
  return policyOf(mergeReviewConfig({ surface: "local", ...(global ? { global } : {}) }).config)
}

/** VS-23d (SF-15): whether a review registered this session and has not released it, or released it under "zdr". */
export function known(sessionID: string): boolean {
  return sessions.has(sessionID) || released.has(sessionID)
}

/**
 * VS-23d (SF-15): registers a `vectorscope.*` session no review holds, under `policy`, as the HTTP prompt that is about
 * to run it names it: with the prompt's agent (turn sends only that agent's turns) and, with a model, the decision for
 * it (decide), which the transport (hold) and attempt then hold each call to. Without a model nothing was decided, so
 * every call is refused. A refused decision is registered too: its calls are refused with that refusal, before
 * anything is sent. The desktop never releases its sessions, so past ADOPTED_LIMIT adoptions the oldest is released:
 * a "zdr" one is remembered as released (release), so a call that still names it stays refused.
 */
export const adopt = Effect.fn("ReviewRoutes.adopt")(function* (
  provider: Provider.Interface,
  input: {
    readonly sessionID: SessionID
    readonly policy: Policy
    readonly agent?: string
    readonly subject?: Subject & { readonly providerID: ProviderV2.ID; readonly modelID: ModelV2.ID }
  },
): Effect.fn.Return<Registered> {
  const decided = input.subject ? yield* decide(provider, input.subject, input.policy) : undefined
  const entry: Registered = { policy: input.policy, ...(input.agent ? { agent: input.agent } : {}), ...decided }
  register(input.sessionID, entry)
  adopted.add(input.sessionID)
  const oldest = adopted.values().next()
  if (adopted.size > ADOPTED_LIMIT && !oldest.done) release(oldest.value)
  return entry
})

export function register(sessionID: SessionID, entry: Registered) {
  released.delete(sessionID)
  sessions.set(sessionID, entry)
}

// A "zdr" session is remembered as released (hold), the oldest forgotten first once there are RELEASED_LIMIT.
export function release(sessionID: SessionID) {
  if (sessions.get(sessionID)?.policy.privacy === "zdr") released.add(sessionID)
  sessions.delete(sessionID)
  adopted.delete(sessionID)
  const oldest = released.values().next()
  if (released.size > RELEASED_LIMIT && !oldest.done) released.delete(oldest.value)
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
export function attempt(sessionID: string, model: Provider.Model): RouteRefusal | undefined {
  const entry = sessions.get(sessionID)
  if (!entry) return "unknown-destination"
  if (entry.policy.privacy === "standard") return undefined
  if (!entry.decision || entry.key === undefined || keyOf(model) !== entry.key) return "unknown-destination"
  return entry.decision.allowed ? undefined : entry.decision.refusal
}

/**
 * VS-23c (SF-12b): whether a session's model calls are a "zdr" review's: registered under "zdr", or released by its
 * review after it was (hold refuses those). False before anything is read while no review session is registered and no
 * released "zdr" one is remembered.
 */
export function zdr(sessionID: string): boolean {
  if (!sessions.size && !released.size) return false
  return released.has(sessionID) || sessions.get(sessionID)?.policy.privacy === "zdr"
}

/**
 * VS-23c (SF-12b): what the session runtime (session/llm.ts) does with a model call, before it reads anything or
 * chooses a runtime. Undefined, so the call takes the path it took before, for every session but a "zdr" review's and
 * its children's. A "zdr" session's call is one of its pass's own turns when it is made with the agent Review.run
 * registered for it (`agent`), at full size: that is sent, on the AI SDK runtime only, whose fetch is provider.ts's and
 * holds it (hold), never on the native runtime, which sends through @vectordevai/llm. This is an allowlist, so every
 * other call is refused: a title, the memory learner or the skill drafter (small), a compaction summary or a judge
 * (another agent), a registration with no agent, a session its review released, and any call of a session whose parent
 * is a "zdr" session (a task or a subagent), which is refused before its first request and so never starts one of its
 * own.
 */
export function turn(input: {
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly agent: string
  readonly small?: boolean
}): Turn | undefined {
  if (!sessions.size && !released.size) return undefined
  if (input.parentSessionID !== undefined && zdr(input.parentSessionID)) return { refusal: "unknown-destination" }
  if (!zdr(input.sessionID)) return undefined
  const entry = sessions.get(input.sessionID)
  return entry && !input.small && entry.agent === input.agent
    ? { runtime: "ai-sdk" }
    : { refusal: "unknown-destination" }
}

/**
 * VS-23c: what the transport does with a model call, from the session its `x-session-id` names (`session` gives
 * undefined without the header, and no `id` when the header names no one session ID; it is read only while some review
 * session is registered or a released "zdr" one is remembered). Undefined, so the call is sent exactly as before, for
 * the owner's own calls, for a session that is not registered and for one registered under "standard". A malformed
 * header is "unattributed-request" while any "zdr" review is registered in this process. A "zdr" session its review
 * released is "unknown-destination": no review holds its route any more, and its history holds the reviewed code.
 * A call of a "zdr" session is decided again before anything is read or sent, on what admission decided on together
 * with what the transport sees: the provider's options now (`options`), the model it sends with, and every origin it
 * sends to (`destinations`: provider.ts requestOrigins with variables filled in, and the request's own URL, read only
 * here). Every origin either side saw must be allowed, and a free model or a forwarding provider either side saw is
 * refused. This decision comes first, so a Codium, free or LAN route names its own refusal; then the call's model must
 * be the one its session was decided for (attempt). Allowed, the kind is the route sendBody checks the body for.
 */
export function hold(input: {
  readonly session: () => { readonly id?: string } | undefined
  readonly model: Provider.Model
  readonly options: Readonly<Record<string, unknown>>
  readonly destinations: () => readonly string[]
}): Held | undefined {
  // No review is running and no "zdr" review has ended in this process: nothing to hold, and the header is not read.
  if (!sessions.size && !released.size) return undefined
  const session = input.session()
  if (!session) return undefined
  const id = session.id
  if (id === undefined)
    return [...sessions.values()].some((entry) => entry.policy.privacy === "zdr")
      ? { refusal: "unattributed-request" }
      : undefined
  if (released.has(id)) return { refusal: "unknown-destination" }
  const entry = sessions.get(id)
  if (!entry || entry.policy.privacy !== "zdr") return undefined
  const seen = routeModel({
    providerID: input.model.providerID,
    modelID: input.model.id,
    found: input.model,
    options: input.options,
  })
  const decidedOn = entry.decidedOn
  const destinations = input.destinations()
  if (entry.pinDestinations) {
    const original = decidedOn?.destinations
    // The SDK can make a request on a later turn after a provider profile changes. Recheck
    // its configured endpoints and every final origin, even when both origins are loopback.
    const origins = new Set(original?.map((url) => (typeof url === "string" ? LocalPolicy.origin(url) : undefined)))
    if (
      !original?.length ||
      origins.has(undefined) ||
      !destinations.length ||
      original.length !== seen.destinations.length ||
      original.some((url, index) => url !== seen.destinations[index]) ||
      destinations.some((url) => !origins.has(LocalPolicy.origin(url)))
    )
      return { refusal: "unknown-destination" }
  }
  const decision = verified(
    decideRoute(
      {
        ...seen,
        destinations: [...(decidedOn?.destinations ?? []), ...seen.destinations, ...destinations],
        // Where an attestation of the provider ID applies is what admission read from the catalog, which the
        // transport cannot see; without it, nowhere.
        defaultOrigins: decidedOn?.defaultOrigins ?? [UNKNOWN_ORIGIN],
        freeModel: seen.freeModel === true || decidedOn?.freeModel === true,
        forwards: seen.forwards === true || decidedOn?.forwards === true,
      },
      entry.policy,
    ),
  )
  if (!decision.allowed) return { refusal: decision.refusal }
  const refusal = attempt(id, input.model)
  return refusal ? { refusal } : { kind: decision.kind }
}

/**
 * VS-23c: the body a held call (hold) sends, or why it may not be sent. It must be a JSON string passed beside the URL,
 * not inside a `Request`, or it is "unreadable-body". Then, by the route and the request's format:
 * - "openrouter-attested": the path (zdrPathRefusal), then zdrRequestBody, whose body is sent (zdrBodyRefusal's reason
 *   when it gives none);
 * - an Anthropic Messages request: zdrFeatureRefusal with its URL, which checks the path too;
 * - any other: the Batch and Files paths (zdrPathRefusal) and body (zdrBatchBodyRefusal), runner-wiring R1, and a Google
 *   request's tools, cache, file references and API path (zdrFeatureRefusal).
 * Held direct OpenAI-family requests enforce the storage and cache policy after provider options are merged.
 */
export function sendBody(input: {
  readonly kind: RouteKind
  readonly npm: string
  readonly url: string
  readonly body: unknown
  readonly request: boolean
  readonly modelID: string
}): { readonly body: string } | { readonly refusal: RouteRefusal } {
  if (input.request || typeof input.body !== "string") return { refusal: "unreadable-body" }
  // A body that is not JSON reads as undefined, which every check below refuses as "unreadable-body".
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.body))
  if (input.kind === "openrouter-attested") {
    const path = zdrPathRefusal(input.url)
    if (path) return { refusal: path }
    const sent = zdrRequestBody(parsed, input.modelID)
    if (!sent) return { refusal: zdrBodyRefusal(parsed, input.modelID) ?? "unreadable-body" }
    return { body: JSON.stringify(sent) }
  }
  const refusal = ANTHROPIC_FORMAT.includes(input.npm)
    ? zdrFeatureRefusal({ format: "anthropic", body: parsed, path: input.url })
    : (zdrPathRefusal(input.url) ??
      zdrBatchBodyRefusal(parsed) ??
      (GOOGLE_FORMAT.includes(input.npm)
        ? zdrFeatureRefusal({ format: "google", body: parsed, path: input.url })
        : undefined))
  if (refusal) return { refusal }
  if (input.kind !== "standard" && OPENAI_FORMAT.includes(input.npm)) {
    const retained = directOpenAiRetention(parsed, input.modelID, input.npm !== "@ai-sdk/openai-compatible")
    if (retained.refusal) return { refusal: retained.refusal }
    if (retained.replacement) return { body: JSON.stringify(retained.replacement) }
  }
  return { body: input.body }
}

// The sessions Review.run created and has not yet released, by session ID.
const sessions = new Map<string, Registered>()
// The "zdr" sessions Review.run released, oldest first: a call that still names one, such as a late helper request or
// the session continued after its review, is refused (hold, turn), and so is a call of a session whose parent is one
// (turn). Bounded, so a long-running server keeps the most recent; one forgotten past the bound is unregistered again.
const released = new Set<string>()
const RELEASED_LIMIT = 4096
// The sessions the engine server adopted (adopt) and has not released, oldest first, so that a long-running server
// holds at most ADOPTED_LIMIT of them.
const adopted = new Set<SessionID>()
export const ADOPTED_LIMIT = 1024

// The SDKs whose requests are Anthropic Messages requests, and Google's, for sendBody's feature checks.
const ANTHROPIC_FORMAT = ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock/anthropic"]
const GOOGLE_FORMAT = ["@ai-sdk/google", "@ai-sdk/google-vertex"]
const OPENAI_FORMAT = ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle", "@ai-sdk/openai-compatible"]

// A route privacy.ts allows is refused while any attestation it lists sets `verify: "api"`: nothing can check an
// account yet (Q20), so an OpenAI attestation with it is refused the same way.
function verified(decision: RouteDecision): RouteDecision {
  return decision.allowed && decision.attestations?.some((attestation) => attestation.verify === "api")
    ? { allowed: false, refusal: "attestation-unverified" }
    : decision
}

// Where these SDKs send requests when neither configuration nor the catalog names a base URL. A copy of provider.ts's
// SDK_ORIGINS, which is private there; VS-23c's backstop (hold) also decides on provider.ts's own requestOrigins.
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
