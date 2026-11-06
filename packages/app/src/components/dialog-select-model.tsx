import { freeModelRegionLabel, freeModelTrainingLabel } from "@vectordevai/core/free-model-choice"
import { Billing } from "@vectordevai/schema/billing"
import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  JSX,
  onMount,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import type { ModelKey } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { ProviderIcon } from "@vectordevai/ui/provider-icon"
import { Icon } from "@vectordevai/ui/v2/icon"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { Dialog as DialogV2, DialogBody, DialogTitle } from "@vectordevai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { offInLocalProviders, type OffModel } from "@/features/local/local-model"
import { useCodiumPurchase } from "@/components/codium-purchase"
import {
  brandProviderName,
  buildModelSections,
  codiumBadge,
  contextLabel,
  modelAriaLabel,
  modelTitle,
  pickerCurrentRow,
  pickerHeaderKey,
  pickerKeyAction,
  pickerModelKey,
  pickerModelName,
  pickerNavigation,
  pickModel,
  pickerRowKey,
  pickerSectionLabel,
  pickerSectionViews,
  readOpenSections,
  toggleOpenSection,
  writeOpenSections,
  type PickerModel,
  type PickerSection,
  type PickerSectionView,
} from "@/utils/provider-brand"

type ModelState = ReturnType<typeof useLocal>["model"]
/** Minimal surface the selector popover needs — lets other screens (e.g. Parallel Workspaces, or an external agent's
    own CLI models) host the exact same picker with their own selection. Rows only need the fields the picker reads,
    so a list need not come from a connected provider. Without `recent`, the top section is just the current model,
    under "Current model". */
export type ModelSelectorModelState = {
  list: () => readonly PickerModel[]
  visible: (key: ModelKey) => boolean
  current: () => PickerModel | undefined
  set: (key: ModelKey | undefined, options?: { recent?: boolean }) => void
  recent?: () => readonly (PickerModel | undefined)[]
}
type ModelItem = PickerModel
type ModelSection = PickerSection<ModelItem>
type ModelSectionView = PickerSectionView<ModelItem>

const connectKey = "action:connect-provider"

/** The models a picker can show, the ordered sections both views render, and which of
    them are open. Rows and keyboard order both come from sections() through views(), so
    they can't drift apart, and buildModelSections leaves out models that can't hold a
    coding conversation for both views and search alike. Which sections are open is kept
    for the next picker, in either view. The picker never renders or logs provider.key or
    provider.options. A `fixed` list (an external agent's CLI models) keeps its own order,
    shows every section open, and has no Connect provider row. A model in Recently used is
    listed again under its provider everywhere else, so rows are keyed by pickerRowKey. */
function createModelSections(input: {
  model: ModelSelectorModelState
  provider: () => string | undefined
  search: () => string
  now: () => number
  fixed?: boolean
}) {
  const models = createMemo(() => {
    const provider = input.provider()
    return input.model
      .list()
      .filter((item) => input.model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (provider ? item.provider.id === provider : true))
  })
  const current = () => {
    const value = input.model.current()
    return value ? pickerModelKey(value) : undefined
  }
  const sections = createMemo(() =>
    buildModelSections({
      models: models(),
      term: input.search(),
      currentKey: current(),
      recentKeys: input.model.recent?.().flatMap((item) => (item ? [pickerModelKey(item)] : [])),
      now: input.now(),
      popular: popularProviders,
      fixed: input.fixed,
    }),
  )
  const [open, setOpenSections] = createSignal(readOpenSections())
  const views = createMemo(() =>
    pickerSectionViews(sections(), open(), input.search()).map((view) =>
      input.fixed ? { ...view, toggle: false, open: true } : view,
    ),
  )
  // Navigation order is render order: every visible header and row, then Connect provider.
  const navigation = createMemo(() => {
    const visible = pickerNavigation(views())
    return input.fixed ? visible : { ...visible, keys: [...visible.keys, connectKey] }
  })
  // Where the highlight rests when nothing else holds it: the current model's first visible row, which is its row in
  // Recently used while that shows.
  const currentRow = () => pickerCurrentRow(navigation(), current())
  const toggle = (id: string) => {
    const next = toggleOpenSection(open(), id)
    setOpenSections(next)
    writeOpenSections(next)
  }
  // Another picker may have opened or closed sections since this one last showed.
  const reload = () => setOpenSections(readOpenSections())
  return { current, currentRow, sections, views, navigation, toggle, reload }
}

/** Pointer highlight that follows real movement only. Rows render under a resting
    pointer (when the picker opens, on every keystroke, while the arrow keys scroll the
    list), and the browser then reports the pointer again at the same spot. Acting on
    that would steal the keyboard highlight. */
function createPointerGuard() {
  let last: string | undefined
  return (event: MouseEvent) => {
    const at = `${event.clientX},${event.clientY}`
    const moved = last !== undefined && last !== at
    last = at
    return moved
  }
}

/** Vector's own models (Free models inside of Vector, Vector Codium) carry Vector's chip, drawn in the text colour like
    every other provider's mark. */
const VECTOR_MARKS = new Set(["vector", Billing.CODIUM_PROVIDER_ID])

function ProviderMark(props: { id?: string }) {
  return (
    <Show
      when={props.id && !VECTOR_MARKS.has(props.id) ? props.id : undefined}
      fallback={
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round">
          <rect x="4" y="4" width="8" height="8" rx="2" />
          <rect x="6.75" y="6.75" width="2.5" height="2.5" rx="0.5" />
          <path d="M6.5 1.75v1.5M9.5 1.75v1.5M6.5 12.75v1.5M9.5 12.75v1.5M1.75 6.5h1.5M1.75 9.5h1.5M12.75 6.5h1.5M12.75 9.5h1.5" />
        </svg>
      }
    >
      {(id) => <ProviderIcon id={id()} width={14} height={14} />}
    </Show>
  )
}

/** One model on one line, shared by both views: the name, then on the right the yellow "May train on your prompts"
    tag where it applies and a muted context size. Rows in Recently used carry their provider's mark, since that
    section mixes providers (each is listed under its provider too); rows under a provider leave the gutter empty, so
    every name starts on one edge. Everything else (provider, how it is paid for, release date) is in the row's
    tooltip, which the caller sets. */
function ModelRow(props: { item: ModelItem; mark: boolean }) {
  return (
    <>
      <span data-slot="model-row-icon" aria-hidden="true">
        <Show when={props.mark}>
          <ProviderMark id={props.item.provider.id} />
        </Show>
      </span>
      <span data-slot="model-row-name">{pickerModelName(props.item)}</span>
      <Show when={freeModelTrainingLabel(props.item)}>
        {(label) => <span data-slot="model-row-training">{label()}</span>}
      </Show>
      <Show when={freeModelRegionLabel(props.item)}>
        {(label) => <span data-slot="model-row-region">{label()}</span>}
      </Show>
      <Show when={codiumBadge(props.item)}>{(badge) => <span data-slot="model-row-badge">{badge().label}</span>}</Show>
      <span data-slot="model-row-context">{contextLabel(props.item.limit?.context)}</span>
    </>
  )
}

/** A section's header when it opens and closes the section: one plain row with the mark, the name, a muted model count
    and a chevron that points down while the rows show. The count and chevron sit in the rows' context and check
    columns. Pressing it keeps focus in search, so typing and the arrow keys still drive the list. Any other header
    (Recently used, an external agent's own list, every section while searching) is a small caption over its rows. */
function SectionToggle(props: {
  view: ModelSectionView
  rows: string
  active: boolean
  onHover: (event: MouseEvent) => void
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-model-section-toggle=""
      data-option-key={pickerHeaderKey(props.view.section)}
      data-active={props.active ? "" : undefined}
      aria-label={pickerSectionLabel(props.view.section)}
      aria-expanded={props.view.open}
      aria-controls={props.view.open ? props.rows : undefined}
      // A cancelled mousedown never moves focus; a cancelled pointerdown still can.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={(event) => props.onHover(event)}
      onClick={() => props.onToggle()}
    >
      <span data-slot="model-row-icon" aria-hidden="true">
        <ProviderMark id={props.view.section.providerID} />
      </span>
      <span data-slot="model-section-name">{props.view.section.label}</span>
      <span data-slot="model-section-count" aria-hidden="true">
        {props.view.section.items.length}
      </span>
      <span data-slot="model-section-chevron" data-expanded={props.view.open ? "" : undefined} aria-hidden="true">
        <Icon name="chevron-down" size="small" />
      </span>
    </button>
  )
}

/** The one search field on top of both views: a magnifier, the field and, while it holds text, a clear button. */
function PickerSearch(props: {
  ref: (el: HTMLInputElement) => void
  value: string
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  autofocus?: boolean
}) {
  const language = useLanguage()
  return (
    <div data-slot="model-picker-search">
      <Icon name="magnifying-glass" size="small" />
      <input
        ref={props.ref}
        type="search"
        value={props.value}
        placeholder={language.t("dialog.model.search.placeholder")}
        aria-label={language.t("dialog.model.search.placeholder")}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        autofocus={props.autofocus}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => props.onKeyDown(event)}
      />
      <Show when={props.value}>
        <button
          type="button"
          data-slot="model-picker-search-clear"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onInput("")}
          aria-label={language.t("common.clear")}
        >
          <Icon name="close" size="small" />
        </button>
      </Show>
    </div>
  )
}

/** What Vector Local keeps out of the picker, from the provider list the picker reads, so nothing leaves it silently. */
function useOffInLocal(directory?: () => string | undefined) {
  const serverSync = useServerSync()
  return createMemo(() => {
    const dir = directory?.()
    const child = dir ? serverSync().child(dir)[0] : undefined
    const catalog = child?.provider_ready ? child.provider : serverSync().data.provider
    return offInLocalProviders(catalog.unavailable).map((item) => ({
      ...item,
      name: brandProviderName(item.id, catalog.all.get(item.id)?.name),
    }))
  })
}

/** The collapsed "Off in Vector Local" group under the models: each provider Vector Local keeps off, and why. */
function OffInLocalGroup(props: { items: readonly (OffModel & { name: string })[] }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Show when={props.items.length > 0}>
      <div data-model-section="off-in-local" data-component="model-off-in-local" class="flex flex-col">
        <button
          type="button"
          data-slot="menu-v2-group-label"
          data-action="model-off-in-local-toggle"
          aria-expanded={open()}
          class="flex w-full items-center gap-1.5 text-left"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="flex shrink-0 transition-transform" classList={{ "-rotate-90": !open() }} aria-hidden="true">
            <Icon name="chevron-down" size="small" />
          </span>
          <span data-slot="model-section-name">Off in Vector Local ({props.items.length})</span>
        </button>
        <Show when={open()}>
          <For each={props.items}>
            {(item) => (
              <div data-slot="model-off-in-local-row" class="flex flex-col gap-0.5 py-1.5 pr-3 pl-[34px]">
                <span class="text-sm leading-5 text-v2-text-text-muted">{item.name}</span>
                <span class="text-[11px] leading-4 text-v2-text-text-faint">{item.why}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

function PickerEmpty(props: { term: string }) {
  const language = useLanguage()
  return (
    <Show
      when={props.term.trim()}
      fallback={
        <div data-slot="model-picker-empty">
          <span>No models to show</span>
          <span>Connect a provider below to see more.</span>
        </div>
      }
    >
      <div data-slot="model-picker-empty">
        <span>{language.t("dialog.model.empty")}</span>
      </div>
    </Show>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelSelectorModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: () => void
  /** The list is the host's own, such as the models an external agent's CLI accepts, not Vector's providers: it
      keeps its order, every section stays open, and there is nothing to connect or refresh. */
  fixedCatalog?: boolean
}) {
  const model = props.model ?? useLocal().model
  const serverSync = useServerSync()
  const language = useLanguage()
  const dialog = useDialog()
  const codiumPlans = useCodiumPurchase()
  // `now` is captured when the popover opens, so what search and spoken labels say about a model's age can't change
  // while it's showing.
  const [store, setStore] = createStore({ open: false, search: "", active: "", now: Date.now() })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let restoreTrigger = true
  let pointerMoved = createPointerGuard()

  const picker = createModelSections({
    model,
    provider: () => props.provider,
    search: () => store.search,
    now: () => store.now,
    fixed: props.fixedCatalog,
  })
  const sections = picker.sections
  const offInLocal = useOffInLocal()
  const keys = () => picker.navigation().keys
  const uid = createUniqueId()
  // An unset or stale highlight (the list changed under it, or its section closed) falls back to the current model's
  // row, then the first row or header.
  const active = createMemo(() => {
    const options = keys()
    if (options.includes(store.active)) return store.active
    return picker.currentRow() ?? options[0] ?? ""
  })
  const activeItem = () => {
    const key = active()
    return key ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(key)}"]`) : undefined
  }
  const afterClose = (callback: () => void) => {
    const complete = () => {
      if (contentRef?.isConnected) {
        requestAnimationFrame(complete)
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(callback))
    }
    requestAnimationFrame(complete)
  }
  const setOpen = (open: boolean) => {
    if (open) {
      // Account models can arrive after the list was first read, as when vectordev.ai answers a first Codium
      // catalog read slowly; opening the picker reads the list again so they show up.
      if (!props.fixedCatalog) void serverSync().refreshProviders()
      restoreTrigger = true
      pointerMoved = createPointerGuard()
      picker.reload()
      setStore({ open: true, now: Date.now(), active: "" })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  // Kobalte focuses the menu item under the pointer; keep typing and the arrow keys in search.
  const hover = (event: MouseEvent, key: string) => {
    if (pointerMoved(event)) setStore("active", key)
    if (document.activeElement !== searchRef) setTimeout(() => searchRef?.focus())
  }
  const select = (item: ModelItem) => {
    pickModel(item, {
      set: (chosen) => model.set({ modelID: chosen.id, providerID: chosen.provider.id }, { recent: true }),
      plans: codiumPlans,
    })
    props.onClose?.()
  }
  const selectModel = (item: ModelItem) => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => select(item))
  }
  const connectProvider = () => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => {
      void import("./dialog-select-provider").then((x) => {
        dialog.show(() => <x.DialogSelectProvider />)
      })
    })
  }
  const selectKey = (key: string) => {
    const item = picker.navigation().rows.get(key)
    if (item) {
      selectModel(item)
      return
    }
    if (key === connectKey) connectProvider()
  }
  const moveTo = (key: string) => {
    setStore("active", key)
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  // The header stays highlighted, so Enter or Space toggles it straight back.
  const toggleSection = (section: ModelSection) => {
    picker.toggle(section.id)
    moveTo(pickerHeaderKey(section))
  }
  const setSearch = (value: string) => {
    setStore("search", value)
    // The first rendered row becomes active on every keystroke; with no match, Connect provider.
    setStore("active", keys()[0] ?? (props.fixedCatalog ? "" : connectKey))
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(el: HTMLDivElement) => (contentRef = el)}
          class="vector-model-popover w-[400px] overflow-hidden rounded-xl border border-[color:var(--vx-line-strong)] bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={() => (restoreTrigger = false)}
          onFocusOutside={() => (restoreTrigger = false)}
          onCloseAutoFocus={(event) => {
            if (!restoreTrigger) event.preventDefault()
          }}
        >
          <PickerSearch
            ref={(el) => (searchRef = el)}
            value={store.search}
            onInput={setSearch}
            onKeyDown={(event) => {
              if (event.key === "Tab") return
              event.stopPropagation()
              if (event.key === "Escape") {
                event.preventDefault()
                restoreTrigger = false
                setOpen(false)
                afterClose(() => props.onClose?.())
                return
              }
              if (event.altKey || event.metaKey) return
              const action = pickerKeyAction(event, picker.navigation(), active())
              if (!action) return
              event.preventDefault()
              if ("move" in action) return moveTo(action.move)
              if ("toggle" in action) {
                const section = sections().find((item) => item.id === action.toggle)
                if (section) toggleSection(section)
                return
              }
              selectKey(action.select)
            }}
          />
          {/* The popover grows up from its trigger, so a list with sections to open keeps one height and opening one
              never moves the search field. A fixed list never opens or closes anything and fits its rows. */}
          <ScrollView
            data-slot="model-selector-scroll"
            class={props.fixedCatalog ? "max-h-[360px] min-h-0" : "h-[360px] min-h-0"}
          >
            <div data-slot="model-picker-list">
              <Show when={sections().length > 0} fallback={<PickerEmpty term={store.search} />}>
                <For each={picker.views()}>
                  {(view) => {
                    const section = view.section
                    const rows = `${uid}-${section.id}`
                    return (
                      <MenuV2.Group
                        data-model-section={section.kind}
                        aria-label={view.toggle ? section.label : undefined}
                      >
                        <Show when={view.toggle} fallback={<MenuV2.GroupLabel>{section.label}</MenuV2.GroupLabel>}>
                          <SectionToggle
                            view={view}
                            rows={rows}
                            active={active() === pickerHeaderKey(section)}
                            onHover={(event) => hover(event, pickerHeaderKey(section))}
                            onToggle={() => toggleSection(section)}
                          />
                        </Show>
                        <Show when={view.open}>
                          <MenuV2.RadioGroup id={rows} value={picker.current()}>
                            <For each={section.items}>
                              {(item) => {
                                const key = pickerRowKey(section, item)
                                const value = pickerModelKey(item)
                                return (
                                  <MenuV2.RadioItem
                                    value={value}
                                    data-option-key={key}
                                    data-active={active() === key ? "" : undefined}
                                    data-selected-model={picker.current() === value ? true : undefined}
                                    aria-label={modelAriaLabel(item, store.now)}
                                    title={modelTitle(item)}
                                    onMouseMove={(event: MouseEvent) => hover(event, key)}
                                    onSelect={() => selectModel(item)}
                                  >
                                    <ModelRow item={item} mark={section.kind === "recent"} />
                                  </MenuV2.RadioItem>
                                )
                              }}
                            </For>
                          </MenuV2.RadioGroup>
                        </Show>
                      </MenuV2.Group>
                    )
                  }}
                </For>
              </Show>
              <Show when={!store.search.trim()}>
                <OffInLocalGroup items={offInLocal()} />
              </Show>
            </div>
          </ScrollView>
          <Show when={!props.fixedCatalog}>
            <div data-slot="model-picker-footer">
              <MenuV2.Item
                data-option-key={connectKey}
                data-active={active() === connectKey ? "" : undefined}
                onMouseMove={(event: MouseEvent) => hover(event, connectKey)}
                onSelect={connectProvider}
              >
                <span data-slot="model-row-icon" aria-hidden="true">
                  <Icon name="plus" size="small" />
                </span>
                <span data-slot="model-row-name">{language.t("command.provider.connect")}</span>
              </MenuV2.Item>
            </div>
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

/** Dialog-chrome counterpart to {@link ModelSelectorPopoverV2}, and the main surface: the
    composer's model button and mod+' open it through the model.choose command. Same
    sections, rows and keyboard order as the popover. */
export const DialogSelectModelV2: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const serverSync = useServerSync()
  const language = useLanguage()
  const dialog = useDialog()
  const codiumPlans = useCodiumPurchase()
  const directory = () => decode64(local.slug())
  // Account models can arrive after the list was first read, as when vectordev.ai answers a first Codium catalog
  // read slowly; opening the picker reads the list again so they show up.
  onMount(() => void serverSync().refreshProviders())
  const [search, setSearch] = createSignal("")
  const [picked, setPicked] = createSignal("")
  // Captured once, so what search and spoken labels say about a model's age can't change while the dialog is open.
  const now = Date.now()
  const pointerMoved = createPointerGuard()
  let listRef: HTMLDivElement | undefined

  const picker = createModelSections({ model, provider: () => props.provider, search, now: () => now })
  const sections = picker.sections
  const offInLocal = useOffInLocal(directory)
  // Navigation order is render order, as in the popover: every visible header and row, then Connect provider.
  const keys = () => picker.navigation().keys
  const uid = createUniqueId()
  // Unset or stale (providers still syncing at mount, a search that removed the row, or a
  // closed section): fall back to the current model's row, which is the first row, then to
  // the first row or header.
  const active = createMemo(() => {
    const options = keys()
    if (options.includes(picked())) return picked()
    return picker.currentRow() ?? options[0] ?? ""
  })
  const scrollToActive = () =>
    queueMicrotask(() => {
      const key = active()
      if (!key) return
      listRef
        ?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  // Typing and clearing both land here, so the highlight is always the first row shown;
  // with no match, Connect provider.
  const updateSearch = (value: string) => {
    setSearch(value)
    setPicked(keys()[0] ?? connectKey)
    scrollToActive()
  }

  const select = (item: ModelItem) =>
    pickModel(item, {
      set: (chosen) => {
        model.set({ modelID: chosen.id, providerID: chosen.provider.id }, { recent: true })
        dialog.close()
      },
      plans: () => {
        dialog.close()
        codiumPlans()
      },
    })
  const moveTo = (key: string) => {
    setPicked(key)
    scrollToActive()
  }
  // The header stays highlighted, so Enter or Space toggles it straight back.
  const toggleSection = (section: ModelSection) => {
    picker.toggle(section.id)
    moveTo(pickerHeaderKey(section))
  }
  const selectKey = (key: string) => {
    const item = picker.navigation().rows.get(key)
    if (item) {
      select(item)
      return
    }
    if (key === connectKey) connectProvider()
  }
  const connectProvider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider directory={directory} />)
    })
  }

  return (
    <DialogV2 size="large" class="vector-select-model-dialog">
      {/* Search is the top of the dialog; the title is for assistive tech. Escape or a click outside closes it. */}
      <div class="sr-only">
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
      </div>
      <PickerSearch
        // `autofocus` is ignored on an input inserted after page load, and the composer keeps focus when its model
        // button opens this dialog. Focus search once it's in the DOM, so typing filters and the arrow keys drive
        // the list.
        ref={(el) => requestAnimationFrame(() => el.focus())}
        autofocus
        value={search()}
        onInput={updateSearch}
        onKeyDown={(event) => {
          const action = pickerKeyAction(event, picker.navigation(), active())
          if (!action) return
          event.preventDefault()
          if ("move" in action) return moveTo(action.move)
          if ("toggle" in action) {
            const section = sections().find((item) => item.id === action.toggle)
            if (section) toggleSection(section)
            return
          }
          selectKey(action.select)
        }}
      />
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <ScrollView data-slot="select-model-scroll" class="min-h-0 flex-1">
          <div ref={listRef} data-slot="model-picker-list">
            <Show when={sections().length > 0} fallback={<PickerEmpty term={search()} />}>
              <For each={picker.views()}>
                {(view) => {
                  const section = view.section
                  const rows = `${uid}-${section.id}`
                  return (
                    <div data-model-section={section.kind}>
                      <Show when={view.toggle} fallback={<div data-slot="menu-v2-group-label">{section.label}</div>}>
                        <SectionToggle
                          view={view}
                          rows={rows}
                          active={active() === pickerHeaderKey(section)}
                          onHover={(event) => {
                            if (pointerMoved(event)) setPicked(pickerHeaderKey(section))
                          }}
                          onToggle={() => toggleSection(section)}
                        />
                      </Show>
                      <Show when={view.open}>
                        <div id={rows} role="group" aria-label={section.label}>
                          <For each={section.items}>
                            {(item) => {
                              const key = pickerRowKey(section, item)
                              const checked = () => picker.current() === pickerModelKey(item)
                              return (
                                <button
                                  type="button"
                                  data-component="menu-v2-item"
                                  data-option-key={key}
                                  data-active={active() === key ? "" : undefined}
                                  data-checked={checked() ? "" : undefined}
                                  aria-current={checked() ? "true" : undefined}
                                  aria-label={modelAriaLabel(item, now)}
                                  title={modelTitle(item)}
                                  onMouseMove={(event) => {
                                    if (pointerMoved(event)) setPicked(key)
                                  }}
                                  onClick={() => select(item)}
                                >
                                  <span data-slot="menu-v2-item-content">
                                    <ModelRow item={item} mark={section.kind === "recent"} />
                                  </span>
                                  <span data-slot="model-row-check" aria-hidden="true">
                                    <Icon name="check" size="small" />
                                  </span>
                                </button>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
            <Show when={!search().trim()}>
              <OffInLocalGroup items={offInLocal()} />
            </Show>
          </div>
        </ScrollView>
        <div data-slot="model-picker-footer">
          <button
            type="button"
            data-component="menu-v2-item"
            data-option-key={connectKey}
            data-active={active() === connectKey ? "" : undefined}
            onMouseMove={(event) => {
              if (pointerMoved(event)) setPicked(connectKey)
            }}
            onClick={connectProvider}
          >
            <span data-slot="menu-v2-item-content">
              <span data-slot="model-row-icon" aria-hidden="true">
                <Icon name="plus" size="small" />
              </span>
              <span data-slot="model-row-name">{language.t("command.provider.connect")}</span>
            </span>
          </button>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
