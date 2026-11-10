import { isFreeModel } from "@vectordevai/schema/free-model"
import { Billing } from "@vectordevai/schema/billing"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
// Which model a review runs on (section 2.9), what it costs (section 5.5), and the 32k context floor.

import { providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { REVIEW_CONFIG_PATH } from "@vectordevai/core/review/config"
import { contextRefusal, type ReviewPrice } from "@vectordevai/core/review/plan"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { CostKind, Trigger } from "@vectordevai/core/review/types"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { ModelV2 } from "@vectordevai/core/model"

export interface ResolvedModel {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
  context: number
  price?: ReviewPrice // only for "priced": the dollar cap needs a price
  costKind: CostKind
}

export class ReviewModelError extends Schema.TaggedErrorClass<ReviewModelError>()("ReviewModelError", {
  message: Schema.String,
}) {}

export interface ResolveInput {
  trigger: Trigger
  flag?: string // `vector review --model`
  config?: string // `model` from .vector/review.json
  env?: Record<string, string | undefined> // MODEL and REVIEW_AUTO_MODEL; process.env by default
  exact?: string // this "provider/model" and no other, such as review.json's triageModel
}

// CI (auto and command): REVIEW_AUTO_MODEL for automatic runs only, then review.json, then MODEL.
// Project config is disabled in CI, so a pull request cannot choose the model through
// agent.review.model.
// Local (local and desktop): --model, review.json, agent.review.model from the user's config, the configured
// default model. CI may use an available free model without a provider key.
export const resolveReviewModel = Effect.fn("ReviewModel.resolve")(function* (input: ResolveInput) {
  const env = input.env ?? process.env
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const catalog = yield* ModelCatalog.Service

  const ci = input.trigger === "auto" || input.trigger === "command"
  const agent = ci ? undefined : (yield* config.get()).agent?.["review"]
  // Each source names its setting, so a workflow's refusal points at the one that chose the model.
  const picked = (
    ci
      ? [
          { value: input.exact, setting: TRIAGE_SETTING },
          { value: input.trigger === "auto" ? env.REVIEW_AUTO_MODEL : undefined, setting: AUTO_SETTING },
          { value: input.config, setting: CONFIG_SETTING },
          { value: env.MODEL, setting: MODEL_SETTING },
        ]
      : [
          { value: input.exact, setting: TRIAGE_SETTING },
          { value: input.flag, setting: "--model" },
          { value: input.config, setting: CONFIG_SETTING },
          { value: agent?.model, setting: "agent.review.model" },
        ]
  )
    .map((source) => ({ ...source, value: source.value?.trim() }))
    .find((source) => !!source.value)
  const chosen = picked?.value
  const free =
    chosen || !ci
      ? undefined
      : // An unattended review never sends code to a free model whose provider may train on it.
        Object.values(yield* provider.list())
          .flatMap((item) => Object.values(item.models))
          .find((model) => isFreeModel(model) && !freeModelMayTrain(model))
  const configured = chosen || ci ? undefined : yield* provider.defaultModel().pipe(Effect.option)
  const name =
    chosen ??
    (free ? `${free.providerID}/${free.id}` : undefined) ??
    (configured?._tag === "Some" ? `${configured.value.providerID}/${configured.value.modelID}` : undefined)

  if (!name)
    return yield* new ReviewModelError({
      message: ci
        ? "No review model is set. Set MODEL or REVIEW_AUTO_MODEL in the workflow, or model in .vector/review.json, and provide that provider's key."
        : "No review model is set. Pass --model, set model in .vector/review.json, or connect a provider in Vector.",
    })

  const ref = Provider.parseModel(name)
  if (!ref.providerID || !ref.modelID)
    return yield* new ReviewModelError({
      message: `Invalid model ${name}. Model must be in the format "provider/model".`,
    })
  const model = yield* provider.getModel(ref.providerID, ref.modelID).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Vector Local keeps the model off: say why, rather than asking for a key.
        if (!ci && error.unavailable?.reason === "off-in-local")
          return yield* new ReviewModelError({ message: `${name} cannot review: ${error.unavailable.message}` })
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

  return {
    providerID: model.providerID,
    modelID: model.id,
    // The agent's variant applies only when the agent's own model was chosen, as elsewhere in the engine.
    ...(chosen && chosen === agent?.model && agent.variant ? { variant: agent.variant } : {}),
    context: model.limit.context,
    ...(costKind === "priced" ? { price: SpendGuard.priceOf(model.cost) } : {}),
    costKind,
  } satisfies ResolvedModel
})

const AUTO_SETTING = `REVIEW_AUTO_MODEL in ${WORKFLOW_FILE}`
const CONFIG_SETTING = `model in ${REVIEW_CONFIG_PATH}`
const TRIAGE_SETTING = `triageModel in ${REVIEW_CONFIG_PATH}`
const MODEL_SETTING = `MODEL in ${WORKFLOW_FILE}`

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
