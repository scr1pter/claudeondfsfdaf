import { isFreeModel } from "@vectordevai/schema/free-model"
import { Billing } from "@vectordevai/schema/billing"
import { FREE_MODEL_TRAINING_LABEL, freeModelMayTrain } from "@vectordevai/core/free-model-choice"
// Which model a review runs on (section 2.9), what it costs (section 5.5), and the 32k context floor.

import { providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { Effect, Option, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { REVIEW_CONFIG_PATH } from "@vectordevai/core/review/config"
import type { ModelSubject } from "@vectordevai/core/review/model-evidence"
import { contextRefusal, type ReviewPrice } from "@vectordevai/core/review/plan"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { CostKind, Trigger } from "@vectordevai/core/review/types"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { ModelV2 } from "@vectordevai/core/model"
import { VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { ROUTE_REFUSALS, type RouteRefusal } from "@vectordevai/core/review/privacy"
import { labName } from "@vectordevai/core/model-lab"
import { labOfModel } from "@vectordevai/core/review/second-lab"
import { ReviewAuthor } from "./author"
import { ReviewRoutes } from "./route"

export interface ResolvedModel {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
  context: number
  price?: ReviewPrice // only for "priced": the dollar cap needs a price
  costKind: CostKind
  // What model evidence (VS-07) reads: which setting chose the model, or the default Vector fell back to, and the
  // catalog's facts about it. Descriptive only; nothing changes which model runs. Absent on models built by hand.
  subject?: ModelSubject
  /** The CLI also holds the actual dispatch to the stricter route when this switch takes place. */
  inversion?: { note: string; privacy: "zdr" }
  // VS-23b: where the model catalog ships the model's provider, for the route rules (ReviewRoutes.shippedOrigins): its
  // base URL as shipped, or none for a provider defined in configuration. Set only under privacy "zdr", and absent when
  // that is unknown (the catalog lists the provider without a URL, or is empty), so a standard resolution is unchanged.
  catalogOrigins?: readonly string[]
}

export class ReviewModelError extends Schema.TaggedErrorClass<ReviewModelError>()("ReviewModelError", {
  message: Schema.String,
  // VS-23b: set when privacy "zdr" refused the model (ReviewRoutes): the "provider/model" and the route rules' reason. A
  // caller that reads them reviews nothing and says why (format.ts notePrivacyRefused), and never tries another model.
  model: Schema.optional(Schema.String),
  refusal: Schema.optional(Schema.Literals(ROUTE_REFUSALS)),
}) {}

export interface ResolveInput {
  trigger: Trigger
  author?: ReviewAuthor.Proof
  flag?: string // `vector review --model`
  config?: string // `model` from .vector/review.json
  env?: Record<string, string | undefined> // MODEL and REVIEW_AUTO_MODEL; process.env by default
  exact?: string // this "provider/model" and no other, such as review.json's triageModel
  // review.json's "modelEvidence": "warn" (VS-07, off by default). A local model the provider retired is then refused
  // with that reason, as a workflow's already is, instead of as one that is not available.
  evidence?: boolean
  /** Internal service identity; absent preserves the generic review setting. */
  identity?: "vectorscope"
  // VS-23b: the review's route settings (ReviewRoutes.policyOf). Under privacy "zdr" the chosen model must have a route
  // the rules allow (core privacy.ts), or resolution fails with a ReviewModelError that carries the refusal, and CI
  // never falls back to a free model. Absent, or "standard", changes nothing.
  route?: ReviewRoutes.Policy
}

// CI (auto and command): REVIEW_AUTO_MODEL for automatic runs only, then review.json, then MODEL.
// Project config is disabled in CI, so a pull request cannot choose the model through
// agent.review.model.
// Local (local and desktop): --model, review.json, agent.review.model from the user's config, the configured
// default model. CI may use an available free model without a provider key.
const configured = Effect.fn("ReviewModel.configured")(function* (input: ResolveInput, ownerAlternate = false) {
  const exactSetting = ownerAlternate ? "review.alternateModel in your global Vector settings" : TRIAGE_SETTING
  const env = input.env ?? process.env
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const catalog = yield* ModelCatalog.Service

  const ci = input.trigger === "auto" || input.trigger === "command"
  const route = input.route?.privacy === "zdr" ? input.route : undefined
  const scope = input.identity === VECTORSCOPE_AGENT
  if (scope && ci)
    return yield* new ReviewModelError({ message: "The VectorScope service requires a local review model selection." })
  const global = scope ? yield* config.getGlobal() : undefined
  const agent = ci ? undefined : scope ? global?.agent?.[VECTORSCOPE_AGENT] : (yield* config.get()).agent?.["review"]
  if (scope && agent?.disable)
    return yield* new ReviewModelError({ message: "VectorScope is disabled in agent.vectorscope." })
  // Each source names its setting, so a workflow's refusal points at the one that chose the model.
  const picked = (
    ci
      ? [
          { value: input.exact, setting: exactSetting },
          { value: input.trigger === "auto" ? env.REVIEW_AUTO_MODEL : undefined, setting: AUTO_SETTING },
          { value: input.config, setting: CONFIG_SETTING },
          { value: env.MODEL, setting: MODEL_SETTING },
        ]
      : [
          { value: input.exact, setting: exactSetting },
          { value: input.flag, setting: "--model" },
          { value: input.config, setting: CONFIG_SETTING },
          { value: agent?.model, setting: scope ? "agent.vectorscope.model" : "agent.review.model" },
        ]
  )
    .map((source) => ({ ...source, value: source.value?.trim() }))
    .find((source) => !!source.value)
  const chosen = picked?.value
  // Under "zdr" a free model is refused, so there is no free fallback to take.
  const free =
    chosen || !ci || route
      ? undefined
      : // An unattended review never sends code to a free model whose provider may train on it.
        Object.values(yield* provider.list())
          .flatMap((item) => Object.values(item.models))
          .find((model) => isFreeModel(model) && !freeModelMayTrain(model))
  // Service defaults come from the owner, never an ambient project model. When
  // no project model is set the existing provider fallback is owner history and
  // the available catalog. Explicit/pinned selections above always win.
  const configured =
    chosen || ci
      ? undefined
      : scope && global?.model
        ? Option.some(Provider.parseModel(global.model))
        : scope && (yield* config.get()).model
          ? undefined
          : yield* provider.defaultModel().pipe(Effect.option)
  const name =
    chosen ??
    (free ? `${free.providerID}/${free.id}` : undefined) ??
    (configured?._tag === "Some" ? `${configured.value.providerID}/${configured.value.modelID}` : undefined)

  if (!name)
    return yield* new ReviewModelError({
      message: ci
        ? `No review model is set. Set MODEL or REVIEW_AUTO_MODEL in the workflow, or model in .vector/review.json, and provide that provider's key.${route ? ' Under privacy "zdr" Vector never falls back to a free model.' : ""}`
        : scope
          ? "No VectorScope model is set. Choose agent.vectorscope.model in your Vector settings or provide an explicit or pinned review model."
          : "No review model is set. Pass --model, set model in .vector/review.json, or connect a provider in Vector.",
    })

  const ref = Provider.parseModel(name)
  if (!ref.providerID || !ref.modelID)
    return yield* new ReviewModelError({
      message: `Invalid model ${name}. Model must be in the format "provider/model".`,
    })
  const refused = (refusal: RouteRefusal) =>
    new ReviewModelError({
      model: name,
      refusal,
      message: `${name} has no zero data retention route Vector may use while privacy is "zdr" (${refusal}).`,
    })
  // The model's own refusals (Vector Codium, a free model, a router, a Covered Model) need no lookup, so a refused free
  // or Codium model is never looked up, nor said to be unavailable.
  const early = route ? ReviewRoutes.modelRefusal(ref, route) : undefined
  if (early) return yield* refused(early)
  const model = yield* provider.getModel(ref.providerID, ref.modelID).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Vector Local keeps the model off: say why, rather than asking for a key.
        if (!ci && error.unavailable?.reason === "off-in-local")
          return yield* new ReviewModelError({ message: `${name} cannot review: ${error.unavailable.message}` })
        if (!ci && input.evidence) {
          const provider = (yield* catalog.get())[ref.providerID]
          const listed =
            provider && Object.hasOwn(provider.models, ref.modelID) ? provider.models[ref.modelID] : undefined
          if (listed?.status === "deprecated")
            return yield* new ReviewModelError({
              message: `${provider!.name} has retired ${ref.modelID}. Set ${picked?.setting ?? "--model"} to one of its current models.`,
            })
        }
        if (!ci)
          return yield* new ReviewModelError({ message: `${name} is not available. Check the provider and its key.` })
        const listed = (yield* catalog.get())[ref.providerID]
        return yield* new ReviewModelError({
          // Only the free default has no setting; MODEL is the one that replaces it.
          message: workflowRefusal({
            name,
            modelID: ref.modelID,
            setting: picked?.setting ?? MODEL_SETTING,
            listed,
            error,
            env,
          }),
        })
      }),
    ),
  )
  // Where the catalog ships the provider, which an attestation of the provider ID covers (privacy.ts defaultOrigins).
  const catalogOrigins = route
    ? ReviewRoutes.shippedOrigins({
        catalog: yield* catalog.get(),
        configured: Object.hasOwn((yield* config.get()).provider ?? {}, model.providerID),
        providerID: model.providerID,
        modelID: model.id,
      })
    : undefined
  if (route) {
    const decided = yield* ReviewRoutes.decide(
      provider,
      { providerID: model.providerID, modelID: model.id, found: model, ...(catalogOrigins ? { catalogOrigins } : {}) },
      route,
    )
    if (!decided.decision.allowed) return yield* refused(decided.decision.refusal)
  }
  const refusal = contextRefusal(name, model.limit.context)
  if (refusal) return yield* new ReviewModelError({ message: refusal })

  const signIn = yield* auth.get(model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  // A review on a server on this computer, or on a private one on the model server list in effect (the user's or the
  // company's, without an edit still held for the owner), has no per-token price.
  const local = (yield* provider.line(model))?.local ?? false
  // Label plan §4.3: a Vector Codium model is "codium" before any catalog price or sign-in, so it has no dollar price
  // and the runner holds it to the review token stop.
  const costKind = SpendGuard.costKindOf({
    codium: Billing.isCodium(model.providerID),
    free: isFreeModel(model),
    oauthPlan:
      signIn?.type === "oauth" &&
      providerCredentialAllowed(model.providerID, signIn, Boolean(model.api.npm || model.api.url)),
    listed: model.cost.input > 0 || model.cost.output > 0,
    local,
  })

  // The agent's variant applies only when the agent's own model was chosen, as elsewhere in the engine.
  const variant =
    !ownerAlternate &&
    chosen &&
    chosen === agent?.model &&
    agent.variant &&
    (!scope || picked?.setting === "agent.vectorscope.model")
      ? agent.variant
      : undefined
  const subject: ModelSubject = {
    model: `${model.providerID}/${model.id}`,
    ...(variant ? { variant } : {}),
    free: isFreeModel(model),
    ...(model.freeModel
      ? {
          freeModel: {
            source: model.freeModel.source,
            ...(model.freeModel.dataPolicy ? { dataPolicy: model.freeModel.dataPolicy } : {}),
          },
        }
      : {}),
    status: model.status,
    choice: picked
      ? { explicit: true, setting: picked.setting }
      : { explicit: false, setting: free ? FREE_DEFAULT : "your default model" },
  }

  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(variant ? { variant } : {}),
    context: model.limit.context,
    ...(costKind === "priced" ? { price: SpendGuard.priceOf(model.cost) } : {}),
    costKind,
    subject,
    ...(catalogOrigins ? { catalogOrigins } : {}),
  } satisfies ResolvedModel
})

export const resolveReviewModel = Effect.fn("ReviewModel.resolve")(function* (input: ResolveInput) {
  const lab = ReviewAuthor.trustedLab(input.author)
  const env = input.env ?? process.env
  if (lab && !ReviewAuthor.localEnvironment(input.trigger, env))
    return yield* new ReviewModelError({ message: "Authorship inversion requires a trusted local review outside CI." })
  const primary: ResolvedModel = yield* configured(input)
  if (!lab || input.exact || labOfModel(primary) !== lab) return primary

  const settings = yield* (yield* Config.Service).getGlobal()
  const ownerAgent = settings.agent?.[input.identity === VECTORSCOPE_AGENT ? VECTORSCOPE_AGENT : "review"]
  const ownerModel = ownerAgent?.model ?? settings.model
  const ownerVariant = ownerAgent?.model ? ownerAgent.variant : undefined
  const alternate = settings.review?.alternateModel
  const primaryName = `${primary.providerID}/${primary.modelID}`
  if (settings.review?.inversion !== "local" || ownerModel !== primaryName || ownerVariant !== primary.variant)
    return primary
  if (typeof alternate !== "string")
    return yield* new ReviewModelError({
      message: "Set an equal-tier review.alternateModel in your global Vector settings to invert a same-lab review.",
    })
  const alternateName = alternate.trim()
  if (!/^[a-zA-Z0-9._:@+/-]{1,256}$/.test(alternateName))
    return yield* new ReviewModelError({
      message: "The equal-tier alternate in your global review settings must name a provider/model.",
    })
  const alternateLab = labOfModel(Provider.parseModel(alternateName))
  if (!alternateLab || alternateLab === lab)
    return yield* new ReviewModelError({
      message: "The equal-tier alternate in your global review settings must have a known, different model lab.",
    })
  const route = { privacy: "zdr" as const, attested: input.route?.attested ?? [] }
  // Validate the original model as well as its substitute. The pair may never run on a training route.
  const checked = yield* configured({ ...input, route })
  const replacement = yield* configured({ ...input, route, exact: alternateName }, true)
  if (
    freeModelMayTrain({ freeModel: checked.subject?.freeModel }) ||
    freeModelMayTrain({ freeModel: replacement.subject?.freeModel })
  )
    return yield* new ReviewModelError({
      message: "An authorship inversion model may train on prompts; no review ran.",
    })
  if (labOfModel(replacement) !== alternateLab)
    return yield* new ReviewModelError({
      message: "The equal-tier alternate resolved to an unexpected lab; no review ran.",
    })
  return {
    ...replacement,
    inversion: {
      privacy: "zdr" as const,
      note: `A local assistant snapshot attributes this change to ${labName(lab)}. VectorScope switched from ${primaryName} to your equal-tier alternate ${replacement.providerID}/${replacement.modelID}.`,
    },
  } satisfies ResolvedModel
})

const AUTO_SETTING = `REVIEW_AUTO_MODEL in ${WORKFLOW_FILE}`
const CONFIG_SETTING = `model in ${REVIEW_CONFIG_PATH}`
const TRIAGE_SETTING = `triageModel in ${REVIEW_CONFIG_PATH}`
const MODEL_SETTING = `MODEL in ${WORKFLOW_FILE}`
// The model an unattended review falls back to without one: the rule above, in words.
const FREE_DEFAULT = `an available free model not labelled "${FREE_MODEL_TRAINING_LABEL}"`

// Why a workflow's model cannot run. A missing secret is the usual cause: the provider is in the catalog but never
// loaded, because the review step's env does not pass its key. A retired model never loads, key or not. Only a
// provider Vector no longer lists in the MODEL that `vector github install` wrote means the workflow is out of date.
function workflowRefusal(input: {
  name: string
  modelID: string
  setting: string // the setting that chose the model, such as "MODEL in .github/workflows/vector.yml"
  listed: ModelCatalog.Provider | undefined
  error: Provider.ModelNotFoundError
  env: Record<string, string | undefined>
}) {
  if (input.error.unavailable) return `${input.name} cannot run in this workflow. ${input.error.unavailable.message}`
  // Vector's free models come from vectordev.ai for the workflow's Vector account, not from the model catalog.
  if (input.error.providerID === ProviderV2.ID.vector)
    return input.env.VECTOR_CLI_TOKEN
      ? `vectordev.ai did not offer ${input.name} to this workflow. Check that the VECTOR_CLI_TOKEN secret is current, or set ${input.setting} to another model.`
      : `${input.name} needs the repository secret VECTOR_CLI_TOKEN. Create one at vectordev.ai/auth/cli.`
  // The install writes MODEL; reinstalling changes no other setting.
  const reinstall = input.setting === MODEL_SETTING
  if (!input.listed)
    return reinstall
      ? "This workflow was set up by an older Vector; run vector github install again."
      : `Vector does not list the provider of ${input.name}. Set ${input.setting} to a current model.`
  const listed = Object.hasOwn(input.listed.models, input.modelID) ? input.listed.models[input.modelID] : undefined
  if (!listed) {
    const suggestions = input.error.suggestions?.length ? ` Did you mean ${input.error.suggestions.join(", ")}?` : ""
    return `${input.listed.name} has no model ${input.modelID}.${suggestions} Set ${input.setting} to one of its models${reinstall ? ", or run vector github install again" : ""}.`
  }
  // Vector drops retired catalog models when it loads a provider.
  if (listed.status === "deprecated")
    return `${input.listed.name} has retired ${input.modelID}. Set ${input.setting} to one of its current models.`
  // GitHub passes a secret that does not exist as an empty string.
  const key = input.listed.env.find((name) => input.env[name]?.trim())
  if (key)
    return `Vector could not load ${input.name} in this workflow, although ${key} is set. Set ${input.setting} to another model.`
  const keys = input.listed.env.length ? input.listed.env.join(" or ") : `${input.listed.name}'s credentials`
  return `${input.name} needs ${keys}. Add it as a repository secret and pass it to the Review step in ${WORKFLOW_FILE}.`
}

export * as ReviewModel from "./model"
