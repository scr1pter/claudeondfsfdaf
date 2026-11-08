import { providerNoticeTracker, unavailableModel } from "@vectordevai/schema/provider-unavailable"
import { renamedModel } from "@vectordevai/schema/provider-policy"
import { FREE_ROUTER_ID, isFreeModelRef, retainFreeModelSelection } from "@vectordevai/schema/free-model"
import { bestOwnFreeModel } from "@vectordevai/core/free-model-choice"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"
import { modelDisplayName, modelProviderName } from "../util/model"

const takeNotice = providerNoticeTracker()

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

/**
 * The favorites after toggling `model`, or undefined when it cannot be added. A favorite is always removable, even one
 * that is no longer valid (a Codium model the plan stopped including still shows under Favorites with its badge); only
 * adding one asks `valid`.
 */
export function toggledFavorites(
  model: { providerID: string; modelID: string },
  favorites: { providerID: string; modelID: string }[],
  valid: (model: { providerID: string; modelID: string }) => boolean,
) {
  const same = (item: { providerID: string; modelID: string }) =>
    item.providerID === model.providerID && item.modelID === model.modelID
  if (favorites.some(same)) return favorites.filter((item) => !same(item))
  if (!valid(model)) return
  return [model, ...favorites]
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    // A Codium model the plan no longer includes is never restored or cycled to: every request to it would be refused.
    // The person chooses it from the model list, which asks to change plan instead.
    function isModelValid(model: { providerID: string; modelID: string }) {
      const info = sync.data.provider.find((item) => item.id === model.providerID)?.models[model.modelID]
      return !!info && !(model.providerID === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isLocked(info))
    }

    // A Vector choice stays on the shared allowance, even when the user's own OpenRouter account lists the same model.
    function resolveSelection(saved: { providerID: string; modelID: string }) {
      return renamedModel(saved)
    }

    const freeSelection = (model: { providerID: string; modelID: string }) => isFreeModelRef(model)

    // Saved choices follow a provider rename, so they keep working with their carried-over credential.
    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const saved = modelFn()
        if (!saved) continue
        const model = resolveSelection(saved)
        if (isModelValid(model) || freeSelection(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          const retained = retainFreeModelSelection(model.selection())
          batch(() => {
            setAgentStore("current", name)
            if (retained) model.set(retained)
          })
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            this.set(value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const model = resolveSelection(parseModel(args.model))
          if (isModelValid(model) || freeSelection(model)) return model
        }

        if (sync.data.config.model) {
          const model = resolveSelection(parseModel(sync.data.config.model))
          if (isModelValid(model) || freeSelection(model)) return model
        }

        for (const item of modelStore.recent) {
          const model = resolveSelection(item)
          if (isModelValid(model) || freeSelection(model)) return model
        }

        // Never a may-train model ahead of a no-training one, and never OpenRouter's free router.
        const free = bestOwnFreeModel(sync.data.provider.flatMap((provider) => Object.values(provider.models)))
        if (free) return { providerID: "openrouter", modelID: free.id }
        if (sync.data.provider.some((provider) => provider.id === "openrouter")) return
        // Codium spends the account's credits, so it is never chosen automatically, even as the only provider.
        const provider = ModelPlanStatus.automaticProviders(sync.data.provider)[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        // OpenRouter's free router picks a model at random, so it is never chosen for anyone, even as the only model.
        const firstModel = Object.values(provider.models).find((model) => model.id !== FREE_ROUTER_ID)
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const selection = createMemo(() => {
        const a = agent.current()
        return getFirstValidModel(
          () => a && modelStore.model[a.name],
          () => a && a.model,
          fallbackModel,
        )
      })
      const currentModel = createMemo(() => {
        const selected = selection()
        if (!selected || !isModelValid(selected)) return
        return selected
      })

      createEffect(() => {
        if (sync.status === "loading" || !modelStore.ready) return
        const a = agent.current()
        const previous = unavailableModel(
          [
            a && modelStore.model[a.name],
            a?.model,
            args.model ? parseModel(args.model) : undefined,
            sync.data.config.model ? parseModel(sync.data.config.model) : undefined,
            ...modelStore.recent,
          ],
          isModelValid,
          (providerID) =>
            sync.data.provider.some((provider) => provider.id === providerID) ||
            providerID in (sync.data.config.provider ?? {}) ||
            !!sync.data.config.disabled_providers?.includes(providerID) ||
            !!sync.data.config.enabled_providers?.includes(providerID),
        )
        const messages = (sync.data.provider_next.unavailable ?? [])
          .filter((item) => takeNotice(sdk.url, `credential:${item.id}:${item.reason}`))
          .map((item) => item.message)
        if (previous) {
          const next = currentModel()
          const old = `${previous.providerID}/${previous.modelID}`
          const replacement = next ? `${next.providerID}/${next.modelID}` : undefined
          if (takeNotice(sdk.url, `model:${sdk.directory}:${old}:${replacement ?? "none"}`)) {
            messages.push(
              replacement
                ? `${old} is unavailable. Vector selected ${replacement}. Check this model's pricing before continuing.`
                : `${old} is unavailable. Connect a provider or choose another model.`,
            )
          }
        }
        // The TUI has one toast slot; combine startup notices so none overwrite another.
        if (messages.length) toast.show({ variant: "warning", message: messages.join("\n\n"), duration: 15000 })
      })

      return {
        selection,
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider && info ? modelProviderName(provider, info) : (provider?.name ?? value.providerID),
            model: provider && info ? modelDisplayName(provider, info) : value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent.filter(
            (item) =>
              isModelValid(item) || (item.providerID === current.providerID && item.modelID === current.modelID),
          )
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            const a = agent.current()
            if (!a) return
            // Retain a restored preference until the catalog is ready so the fallback notice can name it.
            setModelStore("model", a.name, model)
            if (!isModelValid(model)) return
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            const next = toggledFavorites(model, modelStore.favorite, isModelValid)
            if (!next) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    const result = {
      model,
      agent,
      mcp,
      session,
      permission,
    }
    return result
  },
})
