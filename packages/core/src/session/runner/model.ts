export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { HttpOptions, LLMRequest, type Model, type ProviderMetadata } from "@vectordevai/llm"
import * as AnthropicMessages from "@vectordevai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@vectordevai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@vectordevai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@vectordevai/llm/route"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { produce } from "immer"
import { FreeModels } from "../../free-models"
import { FreeModelGuests } from "../../free-model-guests"
import { freeModelMayTrain } from "../../free-model-choice"
import {
  denyDataCollection,
  openRouterModelRouting,
  sendsToOpenRouter,
  sendsToOpenRouterFree,
} from "../../free-model-catalog"
import { ModelPlans } from "../../model-plans"
import { freeModelRoute } from "./free-model-route"
import { modelPlanRoute } from "./model-plan-route"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"
import { WorkspaceTrust } from "../../workspace-trust/workspace-trust"
import { SpendGuard } from "../../spend-guard"
import { NEXT_STEP_SLACK } from "../../review/plan"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { ModelSlots } from "../../local-mode/model-slots"
import { LocalPolicy } from "../../local-mode/policy"
import { Egress } from "../../local-mode/egress"
import { OllamaServer } from "../../local-mode/servers/ollama"
import { LocalSources } from "../../local-mode/sources"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { OFF_IN_LOCAL } from "@vectordevai/schema/provider-unavailable"
import { LocalProbe } from "../../local-mode/probe"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export class UnsafeEndpointError extends Schema.TaggedErrorClass<UnsafeEndpointError>()(
  "SessionRunnerModel.UnsafeEndpointError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    url: Schema.String,
  },
) {
  override get message() {
    return `Provider endpoint must use HTTPS, or HTTP only on your own machine or network: ${this.url}`
  }
}

export class OffInLocalError extends Schema.TaggedErrorClass<OffInLocalError>()("SessionRunnerModel.OffInLocalError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.providerID}/${this.modelID}: off in Vector Local. ${this.reason}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | UnsafeEndpointError
  | OffInLocalError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

const pricing = new WeakMap<Model, ModelV2.Info["cost"]>()

export const withPricing = (model: Model, cost: ModelV2.Info["cost"]) => {
  pricing.set(model, cost)
  return model
}

// Models sent through the free route, which refuses any request that is not priced at zero.
const freeRoutes = new WeakSet<Model>()

export const withFreeRoute = (model: Model) => {
  freeRoutes.add(model)
  return withPricing(model, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
}

// The smallest long-context tier, at 200K or beyond, past which the model's listed price rises. Some catalogs price
// input in bands from 32K up; those bands do not say where to compact.
export const contextTier = (model: Model) => {
  const sizes = (pricing.get(model) ?? []).flatMap((item) =>
    item.tier?.type === "context" && item.tier.size >= 200_000 ? [item.tier.size] : [],
  )
  return sizes.length ? Math.min(...sizes) : undefined
}

// The rates the spend guard estimates the next step at: those a request carrying `contextTokens` is billed at.
export const priceOf = (model: Model, contextTokens: number) => {
  const cost = costAt(model, contextTokens)
  return cost ? SpendGuard.priceOf(cost) : undefined
}

// The rates a request carrying `contextTokens` of context is billed at: the highest long-context tier it passes, else
// the base rates.
const costAt = (model: Model, contextTokens: number) => {
  const costs = pricing.get(model) ?? []
  return (
    costs
      .filter((item) => item.tier?.type === "context" && contextTokens > item.tier.size)
      .sort((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0] ??
    costs.find((item) => item.tier === undefined)
  )
}

// Free models are exempt from the spend guard's dollar checks. An unpriced model is never free; a free-route one is.
export const isFree = (model: Model) =>
  freeRoutes.has(model) ||
  isFreeModel({
    providerID: model.provider,
    id: model.id,
    cost: pricing.get(model)?.find((item) => item.tier === undefined),
  })

// One settled provider step as the spend guard counts it. An unpriced step's cost stays undefined, never $0. A
// catalog entry with no input and no output rate still prices every step at $0, so a step is listed only with real
// catalog rates or a cost the provider reported (Copilot's metered cost). That is Vectorscope's rule, so both call such
// a model unknown. A Vector Codium step carries neither, so it counts as unpriced.
export const spendStep = (
  model: Model,
  settlement: { readonly tokens: Tokens; readonly providerMetadata?: ProviderMetadata; readonly incomplete?: boolean },
  step: { readonly continues: boolean; readonly patched: boolean },
): SpendGuard.Step => {
  const costUsd = calculateCost(model, settlement.tokens, settlement.providerMetadata)
  const contextTokens = settlement.tokens.input + settlement.tokens.cache.read + settlement.tokens.cache.write
  const price = priceOf(model, contextTokens + NEXT_STEP_SLACK)
  return {
    costUsd,
    ...(settlement.incomplete ? { unpriced: true } : {}),
    costKind: SpendGuard.costKindOf({
      free: isFree(model),
      // V2 does not detect OAuth plans yet.
      oauthPlan: false,
      listed:
        reportedUsd(model, settlement.providerMetadata) !== undefined || (costUsd !== undefined && price !== undefined),
      // V2 does not read the server list yet, so only a server on this computer counts, and never for a model it passes
      // on to another service.
      local: ModelSlots.local(model.route.endpoint.baseURL, { model: model.id, forwards: forwarders.has(model) }),
    }),
    price,
    contextTokens,
    cachedTokens: settlement.tokens.cache.read,
    continues: step.continues,
    // V2 does not collect loop signatures yet.
    tools: [],
    patched: step.patched,
  }
}

export const calculateCost = (model: Model, tokens: Tokens, metadata?: ProviderMetadata) => {
  const reported = reportedUsd(model, metadata)
  if (reported !== undefined) return reported

  const selected = costAt(model, tokens.input + tokens.cache.read + tokens.cache.write)
  if (!selected) return undefined
  const cost =
    (tokens.input * selected.input +
      (tokens.output + tokens.reasoning) * selected.output +
      tokens.cache.read * selected.cache.read +
      tokens.cache.write * selected.cache.write) /
    1_000_000
  if (!Number.isFinite(cost)) return undefined
  return Math.max(0, cost)
}

// What the provider reported a step cost, whatever the catalog says.
function reportedUsd(model: Model, metadata?: ProviderMetadata) {
  const totalNanoAiu = metadata?.copilot?.totalNanoAiu
  if (typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0)
    // Copilot bills in nano AI units: 1 AI credit is 1e9 nano-AIU and costs $0.01, so USD = nano-AIU / 1e11.
    return totalNanoAiu / 100_000_000_000
  // Vector Codium is not here: its gateway keeps the provider's charge on vectordev.ai, so a Codium step is unpriced.
  return undefined
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

/** The line a session's requests wait in at a model server someone hosts. */
export type Slots = {
  readonly slots: ModelSlots.Interface
  readonly priority: ModelSlots.Priority
  /** Every provider, so one that points at the same server and configures a smaller count holds these requests to it. */
  readonly providers?: readonly ProviderV2.Info[]
}

// Models whose provider passes every prompt on to other services (`forwards`, as Check models records for a LiteLLM
// proxy), so their steps are never counted as free local ones.
const forwarders = new WeakSet<Model>()

const withDefaults = (
  model: ModelV2.Info,
  route: AnyRoute,
  mayTrain: Effect.Effect<boolean>,
  slots: Slots | undefined,
) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  const trained = sendsToOpenRouter({ providerID: model.providerID, destinations: destinations(model) })
    ? withoutUnconsentedTraining(route, model.api.id, mayTrain)
    : route
  const routed = withSlots(trained, slots, model)
  return routed.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: Object.fromEntries(
      Object.entries(model.request.headers).filter(([, value]) => !/\{(?:env|file):[^}]+\}/.test(value)),
    ),
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

// Fallbacks, presets and plugins in a request to OpenRouter keep working, but some can let OpenRouter answer from another
// model's endpoints, including a free one or one whose provider may train on prompts (openRouterModelRouting). Such a
// request asks OpenRouter to deny data collection unless the user accepted the "May train on your prompts" notice in a
// session no invited guest has worked in. It is checked on the final overlay, after the model's, variant's,
// credential's and any plugin's body, as each request is sent, so a guest's later input is seen too.
const withoutUnconsentedTraining = (route: AnyRoute, modelID: string, mayTrain: Effect.Effect<boolean>) =>
  route.with({
    transport: {
      ...route.transport,
      prepare: (input: Parameters<AnyRoute["transport"]["prepare"]>[0]) =>
        Effect.gen(function* () {
          const body = input.request.http?.body
          if (!openRouterModelRouting(body, modelID).length || (yield* mayTrain))
            return yield* route.transport.prepare(input)
          return yield* route.transport.prepare({
            ...input,
            request: LLMRequest.update(input.request, {
              http: new HttpOptions({ ...input.request.http, body: denyDataCollection(body) }),
            }),
          })
        }),
    },
  })

// A request to a server on this computer or the user's network holds its place in the server's line until its reply
// ends, fails or is interrupted, so helpers on that server wait for it. It waits for a permit by the smallest
// `concurrency` its own provider or another one pointing at the same server sets, as V1 does, so requests from the two
// runners never take turns lifting the limit; with none set, ModelSlots holds the server to one. A cloud API gets a
// line only when such a provider sets `concurrency`, as in V1.
const withSlots = (route: AnyRoute, slots: Slots | undefined, model: ModelV2.Info) => {
  const at = model.api.url === undefined ? undefined : LocalPolicy.origin(model.api.url)
  const counts = [
    model.api.settings,
    ...(slots?.providers ?? []).flatMap((item) =>
      at && item.api.url !== undefined && LocalPolicy.origin(item.api.url) === at ? [item.api.settings] : [],
    ),
  ].flatMap((settings) => {
    const value = settings?.["concurrency"]
    return typeof value === "number" && value > 0 ? [value] : []
  })
  const permits = counts.length ? Math.min(...counts) : undefined
  const origin = ModelSlots.server(model.api.url) ?? (permits !== undefined ? at : undefined)
  if (!slots || !origin) return route
  return route.with({
    transport: {
      ...route.transport,
      frames: (...input: Parameters<AnyRoute["transport"]["frames"]>) =>
        Stream.unwrap(
          slots.slots.take({ origin, permits, priority: slots.priority }).pipe(
            // Only helpers are dropped for a new prompt, and a session's turn is never one.
            Effect.orDie,
            Effect.as(route.transport.frames(...input)),
          ),
        ),
    },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
  /** Whether the user accepted the "May train on your prompts" notice and no invited guest has worked in the session. */
  mayTrain: Effect.Effect<boolean> = Effect.succeed(false),
  slots?: Slots,
): Effect.Effect<Model, UnsupportedApiError | UnsafeEndpointError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  const settled = (built: Model) => {
    if (resolved.api.settings?.["forwards"] === true) forwarders.add(built)
    return withPricing(built, resolved.cost)
  }
  if (resolved.api.url && !WorkspaceTrust.userRemoteUrlAllowed(resolved.api.url)) {
    return Effect.fail(
      new UnsafeEndpointError({ providerID: resolved.providerID, modelID: resolved.id, url: resolved.api.url }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      settled(
        withDefaults(resolved, OpenAIResponses.route, mayTrain, slots)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: resolved.api.id }),
      ),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      settled(
        withDefaults(resolved, AnthropicMessages.route, mayTrain, slots)
          .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
          .model({ id: resolved.api.id }),
      ),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      settled(
        withDefaults(resolved, OpenAICompatibleChat.route, mayTrain, slots)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: resolved.api.id }),
      ),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  mayTrain?: Effect.Effect<boolean>,
  slots?: ModelSlots.Interface,
  /** Every provider, for the smallest count a provider pointing at the same server configures. */
  providers?: readonly ProviderV2.Info[],
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) =>
      fromCatalogModel(
        model,
        credential,
        mayTrain,
        slots ? { slots, priority: session.parentID ? "subagent" : "user", providers } : undefined,
      ),
    ),
  )

export const supported = (model: ModelV2.Info) =>
  model.providerID === ModelPlans.PROVIDER_ID ||
  requiresFreeRoute(model) ||
  (model.api.type === "aisdk" &&
    (model.api.package === "@ai-sdk/openai" ||
      model.api.package === "@ai-sdk/anthropic" ||
      (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined)))

// A free OpenRouter model configured under another name, or under a provider of another name pointed at openrouter.ai,
// is judged by the API ID it sends, so it takes the free route too, which refuses a model it has not reviewed.
function requiresFreeRoute(model: ModelV2.Info) {
  return (
    model.providerID === "vector" ||
    !!model.freeModel ||
    sendsToOpenRouterFree({
      providerID: model.providerID,
      id: model.id,
      apiID: model.api.id,
      destinations: destinations(model),
      price: model.cost.find((cost) => !cost.tier),
    })
  )
}

// Where the SDK packages send a model's requests when the catalog names no address.
const PACKAGE_ORIGINS: Record<string, string> = {
  "@ai-sdk/openai": "https://api.openai.com",
  "@ai-sdk/anthropic": "https://api.anthropic.com",
}

/**
 * Vector Local keeps every model call on the model servers on the list, as the V1 provider does: a turn on any other
 * model fails here, before a route is built or a stream starts, with the notice the V1 provider gives. A listed
 * server's identity is checked against its pin first (Holds.check), so a server that answers as a different one, or
 * says the model runs elsewhere, is refused here too. Nothing is logged, since no model request is made.
 */
export const allowedInLocal = (model: ModelV2.Info, holds?: LocalProbe.Holds) =>
  Effect.gen(function* () {
    const policy = Egress.policy()
    if (!policy.enabled) return
    const url = address(model)
    if (holds && url) yield* Effect.promise(() => holds.check(url, policy, [model.api.id]))
    const reason = localRefusal(model, policy, holds)
    if (reason === undefined) return
    return yield* new OffInLocalError({ providerID: model.providerID, modelID: model.id, reason })
  })

// Why Vector Local refuses a model, or undefined when its requests go to a model server on the list. Vector's own
// models (free models and Vector Codium) and an Ollama cloud model (by its name, or by what its server said when it
// was checked) are never allowed, nor is one whose address is unknown.
function localRefusal(model: ModelV2.Info, policy: LocalMode.Policy, holds?: LocalProbe.Holds) {
  if (model.providerID === ModelPlans.PROVIDER_ID || requiresFreeRoute(model)) return OFF_IN_LOCAL.vector
  const url = address(model)
  if (!url) return OFF_IN_LOCAL.unknown
  if (
    holds
      ? holds.passesOn(url, [model.api.id], policy)
      : ModelSlots.server(url, policy) && OllamaServer.cloud({ name: model.api.id })
  )
    return OFF_IN_LOCAL.ollama
  const held = holds?.held(url)
  if (held) return held
  const verdict = LocalPolicy.decide(policy, { purpose: "inference", url, source: LocalSources.inference(url) })
  if (verdict.decision === "allow") return undefined
  return verdict.rule === "not-allowable" ? OFF_IN_LOCAL.cloud(LocalPolicy.origin(url) ?? url) : OFF_IN_LOCAL.listed
}

// Where a model's requests go: its catalog address, or the SDK package's own.
function address(model: ModelV2.Info) {
  return model.api.url ?? (model.api.type === "aisdk" ? PACKAGE_ORIGINS[model.api.package] : undefined)
}

// Whatever decides where a model's requests go.
function destinations(model: ModelV2.Info) {
  return [model.api.url, model.request.body.baseURL, model.api.type === "aisdk" ? model.api.package : undefined]
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const freeModels = yield* FreeModels.Service
    const modelPlans = yield* ModelPlans.Service
    const freeCredentials = yield* FreeModels.CredentialsService
    const guests = yield* FreeModelGuests.Service
    // Optional so a resolver built without the process's lines, as in tests, sends requests as they come.
    const slots = Option.getOrUndefined(yield* Effect.serviceOption(ModelSlots.Service))
    // Optional for the same reason; the HTTP client model calls go through checks the pin again either way.
    const holds = Option.getOrUndefined(yield* Effect.serviceOption(LocalProbe.HoldsService))
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        const selected = yield* select(catalog, session)
        yield* allowedInLocal(selected, holds)
        if (selected.providerID === ModelPlans.PROVIDER_ID)
          return withPricing(modelPlanRoute(selected, modelPlans, freeCredentials), selected.cost)
        // Configuration can overwrite API metadata or add a free ID after catalog validation.
        // Free intent always crosses the final eligibility and zero-price request guard.
        if (requiresFreeRoute(selected))
          return withFreeRoute(freeModelRoute(selected, freeModels, freeCredentials, guests.marked(session.id)))
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
          // Read as each request is sent. The owner's acceptance never covers a guest's input.
          guests
            .marked(session.id)
            .pipe(Effect.flatMap((guest) => (guest ? Effect.succeed(false) : freeModels.trainingConsent()))),
          slots,
          slots ? yield* catalog.provider.all() : undefined,
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [
    Catalog.node,
    Integration.node,
    FreeModels.node,
    FreeModels.credentialsNode,
    FreeModelGuests.node,
    ModelPlans.node,
    ModelSlots.node,
    LocalProbe.holdsNode,
  ],
})

/**
 * The catalog model a session's next turn runs on: the session's own, else the default, else an automatic choice.
 * Exported so a check made before a prompt is admitted, such as the server's guest check, judges the same model.
 */
export const select = Effect.fn("SessionRunnerModel.select")(function* (
  catalog: Catalog.Interface,
  session: Pick<SessionSchema.Info, "id" | "model">,
) {
  // Location plugins populate and filter the catalog asynchronously during layer startup.
  const defaultModel = session.model
    ? undefined
    : yield* catalog.model
        .default()
        .pipe(
          Effect.mapError((error) =>
            error._tag === "Catalog.DefaultModelUnavailableError"
              ? new ModelUnavailableError({ providerID: error.providerID, modelID: error.modelID })
              : new ModelNotSelectedError({ sessionID: session.id }),
          ),
        )
  const selected = session.model
    ? // A session on Vector's shared allowance stays there, even when the user's own OpenRouter account lists the
      // same model; only a free-model resume moves it to that account, by switching the session's model.
      (yield* catalog.model.available()).find(
        (model) => model.id === session.model?.id && model.providerID === session.model.providerID,
      )
    : defaultModel && supported(defaultModel)
      ? defaultModel
      : yield* catalog.model.available().pipe(Effect.map(automaticModel))
  if (!selected && session.model)
    return yield* new ModelUnavailableError({
      providerID: session.model.providerID,
      modelID: session.model.id,
    })
  if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
  return selected
})

// Codium spends the account's credits, so it is never chosen automatically. Nor is a free model that may train on
// prompts: its notice is accepted for a model someone chose, not for one picked for them.
// With Vector Local on, only a model on a server on the list is chosen.
const automaticModel = (models: readonly ModelV2.Info[]) => {
  const policy = Egress.policy()
  return models.find(
    (model) =>
      supported(model) &&
      model.providerID !== ModelPlans.PROVIDER_ID &&
      !freeModelMayTrain(model) &&
      (!policy.enabled || localRefusal(model, policy) === undefined),
  )
}
