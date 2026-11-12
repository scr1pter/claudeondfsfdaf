import {
  FREE_MODELS_TITLE,
  FREE_MODEL_TRAINING_LABEL,
  freeModelMayTrain,
  freeModelName,
  freeModelSource,
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_SCOPE,
  freeModelTrainingLabel,
  freeModelRegionLabel,
  freeModelTrainingRefusal,
  freeModelChoices,
  type FreeModelChoice,
} from "@vectordevai/core/free-model-choice"
import open from "open"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogConfirm } from "../ui/dialog-confirm"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createMemo, createSignal, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { isHiddenProvider } from "../util/model"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [query, setQuery] = createSignal("")
  // Account models can arrive after startup, as when vectordev.ai answers a first Codium catalog read slowly.
  onMount(() => void sync.refreshProviders().catch(() => undefined))

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider || isHiddenProvider(provider.id, provider)) return []
        const model = provider.models[item.modelID]
        if (!model || model.freeModel) return []
        const title = freeModelName({ id: model.id, name: model.name ?? item.modelID })
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title,
            description: modelDescription(provider.id, model.codium, provider.name),
            category,
            onSelect: () => {
              void onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      filter((provider) => !isHiddenProvider(provider.id, provider)),
      sortBy((provider) => provider.name),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const title = freeModelName({ id: model, name: info.name ?? model })
            const codium = provider.id === ModelPlanStatus.PROVIDER_ID
            return {
              id: model,
              name: title,
              freeModel: info.freeModel,
              value: { providerID: provider.id, modelID: model },
              title,
              releaseDate: info.release_date,
              auto: codium && ModelPlanStatus.isAuto({ id: model, codium: info.codium }),
              description: info.freeModel
                ? [freeModelSource(info), freeModelTrainingLabel(info), freeModelRegionLabel(info)]
                    .filter(Boolean)
                    .join(" · ")
                : modelDescription(
                    provider.id,
                    info.codium,
                    favorites.some((item) => item.providerID === provider.id && item.modelID === model)
                      ? "(Favorite)"
                      : undefined,
                  ),
              category: info.freeModel ? FREE_MODELS_TITLE : connected() ? provider.name : undefined,
              // What search reads (searchModelOptions): the catalogue name and, once a provider
              // is connected, its name. Never the heading.
              searchName: title,
              searchProvider: connected() ? provider.name : undefined,
              onSelect() {
                void onSelect(provider.id, model)
              },
            }
          }),
          filter((option) => {
            if (!showSections || option.freeModel) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined, provider.id),
        ),
      ),
      // Both copies of a free model are listed, the shared one first; each runs where its description says.
      freeModelChoices,
      (options) => [...options.filter((option) => option.freeModel), ...options.filter((option) => !option.freeModel)],
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...searchModelOptions(needle, providerOptions),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  async function onSelect(providerID: string, modelID: string) {
    const info = sync.data.provider.find((item) => item.id === providerID)?.models[modelID]
    if (
      info &&
      !(await confirmCodiumChoice({
        providerID,
        model: { id: modelID, codium: info.codium },
        ask: (title, message) =>
          DialogConfirm.show(dialog, title, message, "Change plan").then((value) => value === true),
        open: (url) => void open(url).catch(() => undefined),
      }))
    )
      return
    if (
      info &&
      !(await confirmFreeModelChoice({
        model: info,
        freeModels: sdk.client.provider.freeModels,
        ask: (title, message) => DialogConfirm.show(dialog, title, message, "Accept").then((value) => value === true),
        notify: (message) => toast.show({ variant: "error", message }),
      }))
    )
      return
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

/** Search model names and connected provider names, never section headings. */
export function searchModelOptions<
  T extends {
    searchName: string
    searchProvider?: string
    footer?: string
    releaseDate: string | number
    title: string
  },
>(needle: string, options: T[]) {
  return sortModelOptions(
    fuzzysort.go(needle, options, { keys: ["searchName", "searchProvider"] }).map((x) => x.obj),
    false,
  )
}

export function sortModelOptions<
  T extends { footer?: string; releaseDate: string | number; title: string; auto?: boolean },
>(options: T[], _newestFirst: boolean, providerID?: string) {
  // Vector Codium keeps its catalog's order with Codium Auto pinned first: its models list no release date, so sorting
  // by date and title would put Claude Haiku 5.5, the model that uses the plan fastest, first.
  if (providerID === ModelPlanStatus.PROVIDER_ID)
    return [...options.filter((option) => option.auto), ...options.filter((option) => !option.auto)]
  return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
}

/**
 * The line under a model's name in the list. A locked or preview Codium entry shows its badge ("Codium · Max",
 * "Preview · Ultra") in every section, Favorites and Recent included, so a model the plan no longer includes never
 * reads as one it does; any other row keeps `fallback` (its provider's name, or "(Favorite)").
 */
export function modelDescription(providerID: string, codium: ModelPlanStatus.Listing | undefined, fallback?: string) {
  if (providerID !== ModelPlanStatus.PROVIDER_ID) return fallback
  return ModelPlanStatus.listingBadge(codium)?.label ?? fallback
}

/**
 * Whether a Codium model may be chosen. One the account's plan does not include is never chosen, since every request to
 * it would be refused: the person is asked whether to change plan, which opens their account page (label plan §10).
 */
export async function confirmCodiumChoice(input: {
  providerID: string
  model: { id: string; codium?: ModelPlanStatus.Listing }
  ask: (title: string, message: string) => Promise<boolean>
  open: (url: string) => void
}) {
  if (input.providerID !== ModelPlanStatus.PROVIDER_ID || !ModelPlanStatus.isLocked(input.model)) return true
  const badge = ModelPlanStatus.listingBadge(input.model.codium)
  if (await input.ask(badge?.label ?? "Vector Codium", `${badge?.title ?? "Not included in your plan"}. Change plan?`))
    input.open(ModelPlanStatus.MANAGE_URL)
  return false
}

/**
 * Whether a model may be chosen. A free model whose provider may train on prompts is chosen only after the one-time
 * acceptance, which the engine also requires before it sends anything to one; the question says the acceptance covers
 * every labelled model. A refused acceptance, as for an invited guest, keeps the current model and says why.
 */
export async function confirmFreeModelChoice(input: {
  model: Pick<FreeModelChoice, "freeModel">
  freeModels: Pick<ReturnType<typeof useSDK>["client"]["provider"]["freeModels"], "consent" | "setConsent">
  ask: (title: string, message: string) => Promise<boolean>
  notify: (message: string) => void
}) {
  if (!freeModelMayTrain(input.model)) return true
  const consent = await input.freeModels.consent().catch(() => undefined)
  if (consent?.data?.training === true) return true
  const message = `${FREE_MODEL_TRAINING_DISCLAIMER} ${FREE_MODEL_TRAINING_SCOPE}`
  if (!(await input.ask(freeModelTrainingLabel(input.model) ?? FREE_MODEL_TRAINING_LABEL, message))) return false
  const recorded = await input.freeModels.setConsent({ freeModelConsent: { training: true } }).catch(() => undefined)
  if (recorded?.data?.training === true) return true
  input.notify(freeModelTrainingRefusal(recorded?.response?.status))
  return false
}
