import { unavailableModel } from "@vectordevai/schema/provider-unavailable"
import { renamedModel } from "@vectordevai/schema/provider-policy"
import { FREE_ROUTER_ID, isFreeModelRef, retainFreeModelSelection } from "@vectordevai/schema/free-model"
import { useLanguage } from "./language"
import { showToast } from "@/utils/toast"
import { takeProviderNotice } from "@/utils/provider-notices"
import { bestOwnFreeModel } from "@vectordevai/core/free-model-choice"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createSimpleContext } from "@vectordevai/ui/context"
import { base64Encode } from "@vectordevai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { hostedServer } from "@/features/local/local-model"
import { Persist, persisted } from "@/utils/persist"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  modelSelectionState,
  normalizeModelVariant,
  resolveModelVariant,
  visibleModelVariants,
} from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const language = useLanguage()

    const id = createMemo(() => params.id || undefined)
    // Deep research is a mode of the composer, not an agent to pick: the research lead is left out by name.
    const list = createMemo(() =>
      sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden && item.name !== "research"),
    )
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    // A Codium model the plan no longer includes is never restored, defaulted or cycled to: every request to it would
    // be refused. The person chooses it from the picker, which opens Change plan instead.
    const validModel = (model: ModelKey) => {
      const info = providers.all().get(model.providerID)?.models[model.modelID]
      return (
        !!info &&
        connected().has(model.providerID) &&
        !(model.providerID === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isLocked(info))
      )
    }

    // A Vector choice stays on the shared allowance, even when the user's own OpenRouter account lists the same model.
    const resolveSelection = (saved: ModelKey) => renamedModel(saved)

    const freeSelection = (model: ModelKey) => isFreeModelRef(model)

    // Saved choices follow a provider rename, so they keep working with their carried-over credential.
    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const saved = item()
        if (!saved) continue
        const model = resolveSelection(saved)
        if (validModel(model) || freeSelection(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return
      return items.find((item) => item.name === name) ?? items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const configuredModel = () => {
      const configured = sync().data.config.model
      if (!configured) return
      const [providerID, ...rest] = configured.split("/")
      const model = resolveSelection({ providerID, modelID: rest.join("/") })
      if (validModel(model) || freeSelection(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        const model = resolveSelection(item)
        if (validModel(model) || freeSelection(model)) return model
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      const connected = providers.connected()
      const free = bestOwnFreeModel(connected.flatMap((provider) => Object.values(provider.models)))
      if (free) return { providerID: "openrouter", modelID: free.id }
      if (connected.some((provider) => provider.id === "openrouter")) return
      // Codium spends the account's credits, so it is never chosen automatically, even as the only provider.
      for (const provider of ModelPlanStatus.automaticProviders(connected)) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        // OpenRouter's free router picks a model at random, so it is never chosen for anyone, even as the only model.
        const first = Object.values(provider.models).find((model) => model.id !== FREE_ROUTER_ID)
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        const retained = retainFreeModelSelection(currentSelection())
        const prev = scope()
        const next = {
          agent: item.name,
          model: retained ?? item.model ?? prev?.model,
          variant: retained ? (model.variant.current() ?? prev?.variant) : (item.variant ?? prev?.variant),
        } satisfies State
        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: next.model,
            variant: next.variant ?? null,
          })
          const session = id()
          if (session) {
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const currentSelection = () =>
      firstModel(
        () => scope()?.model,
        () => agent.current()?.model,
        fallback,
      )
    const current = () => {
      const item = currentSelection()
      if (!item) return
      return models.find(item)
    }

    createEffect(() => {
      if (!sync().data.provider_ready || !savedReady() || !models.ready()) return
      const configured = sync().data.config.model?.split("/")
      const previous = unavailableModel(
        [
          scope()?.model,
          agent.current()?.model,
          configured ? { providerID: configured[0], modelID: configured.slice(1).join("/") } : undefined,
          ...models.recent.list(),
        ],
        validModel,
        (providerID) =>
          providers.all().has(providerID) ||
          providerID in (sync().data.config.provider ?? {}) ||
          !!sync().data.config.disabled_providers?.includes(providerID) ||
          !!sync().data.config.enabled_providers?.includes(providerID),
      )
      if (!previous) return
      const next = current()
      const model = `${previous.providerID}/${previous.modelID}`
      const replacement = next ? `${next.provider.id}/${next.id}` : undefined
      if (!takeProviderNotice(serverSDK().scope, `model:${sdk().directory}:${model}:${replacement ?? "none"}`)) return
      showToast({
        title: language.t("model.unavailable.title"),
        description: replacement
          ? language.t("model.unavailable.replaced", { model, replacement })
          : language.t("model.unavailable.empty", { model }),
        duration: 10000,
      })
    })

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() =>
      models.recent
        .list()
        .map(models.find)
        .filter(
          (item) => item && !(item.provider.id === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isLocked(item)),
        ),
    )

    const model = {
      ready: models.ready,
      current,
      /** The model server the engine says the current model's requests go to, when someone hosts it. */
      hosted: () => {
        const item = current()
        return item ? hostedServer(providers.hosted(), { providerID: item.provider.id, modelID: item.id }) : undefined
      },
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        startTransition(() =>
          batch(() => {
            const next = modelSelectionState(
              item,
              visibleModelVariants(Object.keys(item ? (models.find(item)?.variants ?? {}) : {})),
            )
            if (!next) return
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: next.variant ?? selected(),
            })
            write(next)
            if (!item) return
            if (next.variant !== undefined) models.variant.set(item, next.variant)
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          return normalizeModelVariant(saved, this.list())
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return visibleModelVariants(Object.keys(item.variants))
        },
        set(value: string | undefined) {
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
              write({ variant: value ?? null })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
              }
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      session: {
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return
          const key = handoffKey(serverSDK().scope, dir, session)
          handoff.set(key, next)

          if (dir === sdk().directory) {
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: {
          sessionID: string
          agent: string
          model: ModelKey
          selected?: { providerID: string; modelID: string }
        }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK().scope, sdk().directory, session))) return

          // A session on Codium Auto shows Auto again, not the model it picked for the last message.
          const model = ModelPlanStatus.sessionModel(msg)
          setSaved("session", session, {
            agent: msg.agent,
            model,
            variant: model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})
