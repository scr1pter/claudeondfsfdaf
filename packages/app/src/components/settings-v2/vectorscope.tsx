import { Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { Config } from "@vectordevai/sdk/v2/client"
import { Button } from "@vectordevai/ui/button"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { SelectV2 } from "@vectordevai/ui/v2/select-v2"
import { ModelSelectorPopoverV2, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useModels } from "@/context/models"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { modelDisplayName } from "@/utils/provider-brand"
import { MIN_CONTEXT } from "@vectordevai/core/review/plan"
import {
  readVectorScope,
  vectorScopeDraft,
  vectorScopeKey,
  vectorScopeLocked,
  vectorScopePatch,
  type VectorScopeSettings,
} from "./vectorscope-model"

export function SettingsVectorScopeV2(props: {
  config: (Config & { locked?: readonly string[] }) | undefined
  save: (patch: Config) => Promise<Config>
  confirm: (title: string, apply: () => void) => void
}) {
  const models = useModels()
  const language = useLanguage()
  // Temporary focused CI data. These plain records only observe reads already
  // made by this host; the test snapshots them without subscribing to state.
  const host = globalThis as typeof globalThis & {
    scopeSettingsTrace?: { instances: number; snapshots: Map<number, () => unknown>; snapshot?: () => unknown }
  }
  const diagnostic: NonNullable<typeof host.scopeSettingsTrace> = (host.scopeSettingsTrace ??= {
    instances: 0,
    snapshots: new Map(),
  })
  const instance = ++diagnostic.instances
  const counts = new Map<string, number>()
  const inputs: { phase: string; value: unknown }[] = []
  const identities = new WeakMap<object, number>()
  let identitySequence = 0
  const identity = (value: object | undefined) => {
    if (!value) return undefined
    const previous = identities.get(value)
    if (previous !== undefined) return previous
    const next = ++identitySequence
    identities.set(value, next)
    return next
  }
  const trace = (phase: string, value: unknown) => {
    counts.set(phase, (counts.get(phase) ?? 0) + 1)
    inputs.push({ phase, value })
    if (inputs.length > 24) inputs.shift()
  }
  diagnostic.snapshots.set(instance, () => ({ counts: Object.fromEntries(counts), inputs: [...inputs] }))
  if (diagnostic.snapshots.size > 8) {
    const first = diagnostic.snapshots.keys().next().value
    if (first !== undefined) diagnostic.snapshots.delete(first)
  }
  diagnostic.snapshot = () =>
    [...diagnostic.snapshots].map(([instance, snapshot]) => ({ instance, records: snapshot() }))
  let root: HTMLDivElement | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const saved = createMemo(() => {
    const config = props.config
    const value = readVectorScope(config)
    trace("saved", { config: identity(config), value: identity(value), ...value })
    return value
  })
  const [state, setState] = createStore({
    draft: { model: "", variant: "", disabled: false } as VectorScopeSettings,
    base: "",
    pending: false,
    error: "",
    saved: false,
    overlayZIndex: undefined as number | undefined,
    portalMount: undefined as HTMLElement | undefined,
  })
  onMount(() => {
    // DialogV2 renders Kobalte.Content with this slot. Portalling inside
    // it keeps both popups within the modal's focus and hide-outside scope.
    const content = root?.closest<HTMLElement>('[data-slot="dialog-content"]')
    if (content) setState("portalMount", content)
    const layer = root?.closest<HTMLElement>("[data-dialog-layer]")
    if (!layer) return
    // DialogProvider's actual layer is above ordinary body-portalled menus.
    // Keep these popups above that dialog and below the next pushed layer.
    const zIndex = Number(getComputedStyle(layer).zIndex)
    if (Number.isFinite(zIndex)) setState("overlayZIndex", zIndex + 1)
  })
  const dirty = () => vectorScopeKey(state.draft) !== state.base
  const locked = () => vectorScopeLocked(props.config?.locked ?? [])
  const inactive = () => disposed || !saved() || state.pending || locked()
  createEffect(
    on(saved, (value) => {
      if (!value || state.pending || (state.base && dirty())) return
      trace("saved-synchronize", { value: identity(value), ...value })
      setState({ draft: value, base: vectorScopeKey(value) })
    }),
  )
  const current = () => {
    const list = models.list()
    let draftIdentity: number | undefined
    let requested: string | undefined
    const value = list.find((model) => {
      const key = `${model.provider.id}/${model.id}`
      const draft = state.draft
      requested = draft.model
      draftIdentity = identity(draft)
      return key === requested
    })
    trace("current", { list: identity(list), draft: draftIdentity, requested, selected: identity(value) })
    return value
  }
  const variants = () => {
    const options = [
      { value: "", label: "Default" },
      ...Object.keys(current()?.variants ?? {}).map((value) => ({ value, label: value })),
      ...(state.draft.variant && !(state.draft.variant in (current()?.variants ?? {}))
        ? [{ value: state.draft.variant, label: `Unavailable: ${state.draft.variant}` }]
        : []),
    ]
    trace("variants", { options: identity(options), values: options.map((option) => option.value) })
    return options
  }
  const picker: ModelSelectorModelState = {
    list: () => models.list().filter((model) => model.capabilities.toolcall && model.limit.context >= MIN_CONTEXT),
    visible: models.visible,
    current,
    set: (key) => {
      if (!key || inactive()) return
      setState({
        draft: { ...state.draft, model: `${key.providerID}/${key.modelID}`, variant: "" },
        error: "",
        saved: false,
      })
    },
  }
  const change = (patch: Partial<VectorScopeSettings>) => {
    const blocked = inactive()
    trace("change-request", { blocked, ...patch })
    if (!blocked) {
      const draft = state.draft
      const previous = { ...draft }
      const next = vectorScopeDraft(previous, patch)
      trace("change", { draft: identity(draft), previous, next })
      if (!next) return
      trace("change-write", next)
      setState({ draft: next, error: "", saved: false })
    }
  }
  const apply = async () => {
    if (inactive() || !dirty()) return
    const request = { ...state.draft }
    setState({ pending: true, error: "", saved: false })
    await props
      .save(vectorScopePatch(request))
      .then((config) => {
        if (disposed) return
        const actual = readVectorScope(config)!
        if (vectorScopeKey(actual) !== vectorScopeKey(request)) {
          setState("error", "The engine kept different settings. Discard your changes to view the saved values.")
          return
        }
        setState({ draft: actual, base: vectorScopeKey(actual), saved: true })
      })
      .catch((error: unknown) => {
        if (!disposed) setState("error", formatServerError(error, language.t))
      })
      .finally(() => {
        if (!disposed) setState("pending", false)
      })
  }
  const discard = () => {
    const value = saved()
    if (value) setState({ draft: value, base: vectorScopeKey(value), error: "", saved: false })
  }
  return (
    <div
      ref={root}
      class="settings-v2-card settings-v2-card--wide"
      data-component="vectorscope-settings"
      aria-busy={state.pending}
    >
      <div class="settings-v2-card-head" style={{ "grid-template-columns": "1fr" }}>
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">VectorScope</h3>
          <p class="settings-v2-card-description">
            Choose the model for new VectorScope reviews. These settings are separate from Review and Security
            subagents.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <div class="settings-v2-row-modern">
          <div class="settings-v2-row-copy">
            <div class="settings-v2-row-title">Enable reviews</div>
            <div class="settings-v2-row-description">Turning reviews off prevents new VectorScope reviews.</div>
          </div>
          <Switch
            checked={!state.draft.disabled}
            disabled={inactive()}
            onChange={(enabled) => change({ disabled: !enabled })}
            hideLabel
          >
            Enable VectorScope reviews
          </Switch>
        </div>
        <div class="settings-v2-row-modern">
          <div class="settings-v2-row-copy">
            <div class="settings-v2-row-title">Review model</div>
            <div class="settings-v2-row-description">
              Local and connected provider models work without a GitHub sign-in.
            </div>
          </div>
          <ModelSelectorPopoverV2
            model={picker}
            overlayZIndex={state.overlayZIndex}
            portalMount={state.portalMount}
            triggerAs="button"
            triggerProps={{
              type: "button",
              disabled: inactive(),
              "aria-label": "VectorScope model",
              class: "settings-v2-row-control",
            }}
          >
            {current()
              ? modelDisplayName(current()!)
              : state.draft.model
                ? `Unavailable: ${state.draft.model}`
                : "Use default model"}
          </ModelSelectorPopoverV2>
        </div>
        <div class="settings-v2-row-modern">
          <div class="settings-v2-row-copy">
            <div class="settings-v2-row-title">Model variant</div>
          </div>
          <SelectV2
            aria-label="VectorScope variant"
            overlayZIndex={state.overlayZIndex}
            portalMount={state.portalMount}
            appearance="inline"
            disabled={inactive() || !state.draft.model}
            options={variants()}
            current={variants().find((option) => option.value === state.draft.variant)}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) => option && change({ variant: option.value })}
          />
        </div>
        <div class="settings-v2-row-modern settings-v2-row-modern--stacked">
          <Show when={locked()}>
            <p class="settings-v2-row-description">Your organization manages these settings.</p>
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
          <Show when={state.saved}>
            <p role="status">VectorScope settings saved.</p>
          </Show>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={inactive() || !dirty()}
              onClick={() => props.confirm("Save VectorScope settings?", () => void apply())}
            >
              {state.pending ? "Saving…" : "Save VectorScope settings"}
            </Button>
            <Button
              variant="ghost"
              disabled={inactive() || !state.draft.model}
              onClick={() => change({ model: "", variant: "" })}
            >
              Use default model
            </Button>
            <Button variant="ghost" disabled={inactive() || !dirty()} onClick={discard}>
              Discard changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
