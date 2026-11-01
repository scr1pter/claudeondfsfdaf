import {
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODEL_TRAINING_REFUSED_TERMINAL,
  FREE_MODELS_SIGN_IN_TERMINAL,
  FREE_MODELS_TITLE,
  freeModelMayTrain,
  freeModelName,
  freeModelSource,
  freeModelTrainingLabel,
  freeModelRegionLabel,
  freeModelChoices,
} from "@vectordevai/core/free-model-choice"
import { FreeModels } from "@vectordevai/core/free-models"
import { EOL } from "os"
import { Effect } from "effect"
import { Flag } from "@vectordevai/core/flag/flag"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@vectordevai/core/provider"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the model catalog from the configured mirror",
        type: "boolean",
      })
      .option("accept-training", {
        describe: 'accept, once, that free models labelled "May train on your prompts" may receive your prompts',
        type: "boolean",
      })
      .option("decline-training", {
        describe: "withdraw that acceptance; prompts to those models are then refused before anything is sent",
        type: "boolean",
      })
      .conflicts("accept-training", "decline-training"),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    // The engine reads this file before every free-model request, so a running desktop app sees the change at once.
    const consent = FreeModels.createClient({ consentFile: FreeModels.trainingConsentFile() })
    if (args.acceptTraining || args.declineTraining) {
      const accepted = yield* Effect.promise(() => consent.setTrainingConsent(!!args.acceptTraining))
      UI.println(
        accepted
          ? // The one place here that explains the label; the list below shows the label alone.
            `Accepted. Free models labelled "${FREE_MODEL_TRAINING_LABEL}": their providers may log your prompts, code and outputs and use them to train their models. Vector itself never trains on your prompts. Run "vector models --decline-training" to withdraw.`
          : `Withdrawn. Prompts to free models labelled "${FREE_MODEL_TRAINING_LABEL}" are refused until you accept again.`,
      )
    }
    if (args.refresh) {
      const enabled =
        Flag.VECTOR_MODELS_URL && ModelCatalog.mirrorURL(Flag.VECTOR_MODELS_URL) && !Flag.VECTOR_DISABLE_MODELS_FETCH
      if (enabled) yield* ModelCatalog.Service.use((s) => s.refresh(true))
      UI.println(
        enabled
          ? "Model catalog refresh attempted; the last available catalog remains usable if the mirror is offline."
          : "Using the bundled model catalog. Set VECTOR_MODELS_URL to a Vector-hosted mirror to enable refresh.",
      )
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    // Both copies of a model are listed, the shared one first: a vector/… selector keeps the shared allowance even
    // while an OpenRouter account is connected, and an openrouter/… one runs on that account.
    const free = freeModelChoices(
      Object.values(providers).flatMap((provider) => Object.values(provider.models)),
    ).filter((model) => model.freeModel && (!args.provider || model.providerID === args.provider))
    // Human guidance goes to stderr; stdout keeps copyable, script-friendly model selectors.
    if (free.length) {
      UI.println(FREE_MODELS_TITLE)
      free.forEach((model) =>
        UI.println(
          `  ${freeModelName(model)} — ${[freeModelSource(model), freeModelTrainingLabel(model), freeModelRegionLabel(model)].filter(Boolean).join(" · ")} (${model.providerID}/${model.id})`,
        ),
      )
      if (free.some(freeModelMayTrain) && !(yield* Effect.promise(() => consent.trainingConsent())))
        UI.println(`  ${FREE_MODEL_TRAINING_REFUSED_TERMINAL}`)
    }
    // Signed out, the shared models are missing rather than listed, even beside an OpenRouter account's own copies, so
    // say how to get them.
    if (
      !free.some((model) => model.freeModel?.source === "shared") &&
      (!args.provider || args.provider === ProviderV2.ID.vector) &&
      (yield* provider.freeSignIn())
    )
      UI.println(FREE_MODELS_SIGN_IN_TERMINAL)

    const codium = providers[ProviderV2.ID.make(ModelPlans.PROVIDER_ID)]
    if (codium && (!args.provider || args.provider === ModelPlans.PROVIDER_ID))
      codiumLines(Object.values(codium.models)).forEach((line) => UI.println(line))

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => a.localeCompare(b))

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})

/**
 * What `vector models` says about Vector Codium, on stderr beside the selectors: how many models the plan includes,
 * Codium Auto when the plan has it, and the models a higher plan includes, by name and plan only. Never a price, credits
 * or an amount.
 */
export function codiumLines(models: readonly { id: string; name: string; codium?: ModelPlanStatus.Listing }[]) {
  const included = models.filter((model) => !ModelPlanStatus.isAuto(model) && !ModelPlanStatus.isLocked(model))
  const auto = models.find(ModelPlanStatus.isAuto)
  const locked = models.flatMap((model) =>
    model.codium?.locked ? [`${model.name} (${model.codium.locked.name})`] : [],
  )
  return [
    `${ModelPlans.PROVIDER_NAME}: ${included.length} ${included.length === 1 ? "model" : "models"} included in your plan (${ModelPlans.PROVIDER_ID}/…). Run "vector codium" for your plan and usage.`,
    ...(auto ? [`  Codium Auto picks a model for each message (${ModelPlans.PROVIDER_ID}/${auto.id})`] : []),
    ...(locked.length
      ? [`  Locked: ${locked.join(", ")}. Change plan to use them: ${ModelPlanStatus.MANAGE_URL}`]
      : []),
  ]
}
