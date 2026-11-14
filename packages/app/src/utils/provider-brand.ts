import {
  FREE_MODELS_TITLE,
  freeModelName,
  freeModelSource,
  freeModelTrainingLabel,
  freeModelRegionLabel,
  freeModelChoices,
  freeModelOrder,
} from "@vectordevai/core/free-model-choice"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Billing } from "@vectordevai/schema/billing"
import type { FreeDataPolicy } from "@vectordevai/schema/free-model"
import { providerAllowed, providerUsable } from "@vectordevai/schema/provider-policy"

export const isHiddenProvider = (id: string, provider?: Parameters<typeof providerUsable>[1]) =>
  !providerUsable(id, provider)

export function brandProviderName(id: string, name?: string | null): string {
  return name?.trim() || id
}

/* ---- Model picker ------------------------------------------------------------
   Pure helpers behind the model picker (components/dialog-select-model.tsx). They
   live in this module, not the component, so bun can unit-test them: importing the
   .tsx pulls in Solid's client-only build.

   The provider response removes credentials. The picker only reads the harmless
   sign-in placeholder in provider.options.apiKey. */

/** The fields the picker reads. Structural, so tests can pass plain objects. */
export type PickerModel = {
  id: string
  name: string
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: FreeDataPolicy }
  release_date?: string
  capabilities?: {
    reasoning?: boolean
    toolcall?: boolean
    output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
  }
  /** Config-shaped fallbacks, read only where `capabilities` lacks the field. */
  tool_call?: boolean
  modalities?: { output?: readonly string[] }
  limit?: { context?: number }
  cost?: unknown
  /** What Vector Codium's list says about the entry: Auto, locked, manual-only or a preview. */
  codium?: ModelPlanStatus.Listing
  provider: {
    id: string
    name?: string
    source?: string
    /** Env var names the provider reads. A single one is its key. */
    env?: readonly string[]
    options?: Record<string, unknown>
  }
}

/** Whether a model can hold a coding conversation: it calls tools, answers in text, and
    isn't a voice model. An API key also connects image models (gpt-image-2) and realtime
    voice models (gpt-realtime-2.1), which can't. Audio output alone doesn't make a voice
    model, since some coding models list it too (Azure's gpt-5.1-codex), so voice is read
    from the model id.
    A missing field never hides a model. `capabilities` is read first, the config shape
    (tool_call, modalities.output) fills a gap, and with neither the model stays. The server
    reports every output flag false when a catalogue entry has no modalities
    (engine/src/provider/provider.ts), so an output record with nothing set counts as
    missing too. */
const VOICE_MODEL = /realtime|audio|tts|transcribe|(^|[-_.])live([-_.]|$)/i

export function isCodingModel(model: PickerModel) {
  const toolcall = model.capabilities?.toolcall ?? model.tool_call
  if (toolcall === false) return false
  const output = model.capabilities?.output
  if (output && Object.values(output).some((value) => value === true))
    return output.text !== false && !(output.audio === true && VOICE_MODEL.test(model.id))
  const listed = model.modalities?.output
  if (listed && listed.length > 0)
    return listed.includes("text") && !(listed.includes("audio") && VOICE_MODEL.test(model.id))
  return true
}

export type AccessKind = "key" | "codium" | "none"

export type ModelAccess = {
  kind: AccessKind
  /** Caption for a row or section label; "" when there is nothing honest to claim. */
  label: string
  /** Full sentence for the title attribute. */
  title: string
  /** Lower-case phrase for the row's aria-label. */
  spoken: string
}

const NO_ACCESS: ModelAccess = { kind: "none", label: "", title: "", spoken: "" }
const CODIUM_ACCESS: ModelAccess = {
  kind: "codium",
  label: "Codium",
  title: "Included in your Vector Codium plan",
  spoken: "included in your Codium plan",
}

export const costInput = (cost: unknown): number | undefined => {
  if (Array.isArray(cost)) {
    const values = cost.map((item) => costInput(item)).filter((value): value is number => value !== undefined)
    return values.length > 0 ? Math.max(0, ...values) : undefined
  }
  if (!cost || typeof cost !== "object" || !("input" in cost)) return undefined
  const value = (cost as { input?: unknown }).input
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Describe verified user credentials; price alone never means Vector includes a model. */
export function modelAccess(model: PickerModel): ModelAccess {
  const provider = model.provider
  if (isHiddenProvider(provider.id, provider)) return NO_ACCESS
  // Vector Codium models are included in the signed-in account's Codium plan, never paid from an API key.
  if (Billing.isCodium(provider.id)) return CODIUM_ACCESS
  // An OAuth loader placeholder is not evidence that an API key pays for this model.
  if (provider.options?.apiKey === "vector-oauth-dummy-key") return NO_ACCESS
  const cost = costInput(model.cost)
  if (cost === undefined || cost <= 0) return NO_ACCESS
  // An env var is the key only when it's the provider's single var, the server's own rule.
  // Vertex and Bedrock also connect from project, region and credential-file vars.
  if (provider.source === "api" || (provider.source === "env" && provider.env?.length === 1))
    return {
      kind: "key",
      label: "API key",
      title: `Uses your ${brandProviderName(provider.id, provider.name)} API key`,
      spoken: "uses your API key",
    }
  return NO_ACCESS
}

export function modelDisplayName(model: PickerModel) {
  return freeModelName(model)
}

/** A free model Vector provides, listed under Free models inside of Vector. A copy on the user's own account is that
    provider's model and is listed with it. */
const providedByVector = (model: PickerModel) => model.freeModel?.source === "shared"

/** The name a picker row shows. A free model on the user's own account keeps "(free)", since its provider's list can
    also hold the paid model of the same name and the row carries nothing else to tell them apart. */
export function pickerModelName(model: PickerModel) {
  const name = modelDisplayName(model)
  if (model.freeModel?.source !== "openrouter" || /\(free\)\s*$/i.test(name)) return name
  return `${name} (free)`
}

/** "400K", "262K", "1M", "1.5M". Millions round down to one decimal, so the caption never
    overstates the window (1,050,000 reads "1M"); the title carries the exact figure. */
export function contextLabel(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return ""
  const thousands = Math.round(tokens / 1000)
  if (thousands < 1000) return `${Math.max(1, thousands)}K`
  const millions = Math.floor(thousands / 100) / 10
  return `${millions >= 10 ? Math.floor(millions) : millions}M`
}

export function contextTitle(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return ""
  return `${tokens.toLocaleString("en-US")}-token context window`
}

export const NEW_RELEASE_DAYS = 60
const DAY_MS = 86_400_000

/** release_date is an ISO date ("2026-09-04"), which Date.parse reads as UTC midnight. */
export function releaseTime(model: Pick<PickerModel, "release_date">): number | undefined {
  if (!model.release_date) return undefined
  const time = Date.parse(model.release_date)
  return Number.isFinite(time) ? time : undefined
}

/** Released in the last 60 days. Callers capture `now` once per open so the flag can't
    flip while the picker is showing; a day of slack absorbs clock and time-zone skew. */
export function isNewRelease(model: Pick<PickerModel, "release_date">, now: number) {
  const time = releaseTime(model)
  if (time === undefined) return false
  return time >= now - NEW_RELEASE_DAYS * DAY_MS && time <= now + DAY_MS
}

// UTC, because the date is UTC midnight: local time would show the day before in the Americas.
const RELEASE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

export function releaseTitle(model: Pick<PickerModel, "release_date">) {
  const time = releaseTime(model)
  return time === undefined ? "" : `Released ${RELEASE_FORMAT.format(time)}`
}

const WORD_BREAK = /[\s\-_.]+/

/** Search provider details and model capabilities as well as the model name. */
function specWords(model: PickerModel, now: number) {
  const words: string[] = []
  const access = modelAccess(model)
  if (access.kind === "key") words.push("api", "key")
  if (access.kind === "codium") words.push("codium")
  if (model.capabilities?.reasoning) words.push("reasoning")
  if (isNewRelease(model, now)) words.push("new")
  const context = contextLabel(model.limit?.context).toLowerCase()
  if (context) words.push(context)
  return words
}

/** Lower is better; undefined means no match. `term` must be trimmed and lower-cased.
    0: the name starts with it. 1: a word of the name does. 2: the name or id contains it.
    3: the provider name contains it, or (2+ characters) a spec word starts with it. */
export function matchRank(model: PickerModel, term: string, now: number): number | undefined {
  if (!term) return 0
  const name = model.name.toLowerCase()
  if (name.startsWith(term)) return 0
  if (name.split(WORD_BREAK).some((word) => word.startsWith(term))) return 1
  if (name.includes(term) || model.id.toLowerCase().includes(term)) return 2
  if (brandProviderName(model.provider.id, model.provider.name).toLowerCase().includes(term)) return 3
  if (term.length >= 2 && specWords(model, now).some((word) => word.startsWith(term))) return 3
  return undefined
}

export const pickerModelKey = (model: { id: string; provider: { id: string } }) => `${model.provider.id}:${model.id}`

/** "GPT-6 Astra, OpenAI, 1M context, reasoning, new" */
export function modelAriaLabel(model: PickerModel, now: number) {
  const access = modelAccess(model)
  const context = contextLabel(model.limit?.context)
  return [
    pickerModelName(model),
    brandProviderName(model.provider.id, model.provider.name),
    context ? `${context} context` : "",
    model.capabilities?.reasoning ? "reasoning" : "",
    isNewRelease(model, now) ? "new" : "",
    // A Codium model the plan does not include says which plan does, instead of claiming the account's plan.
    codiumBadge(model)?.title.toLowerCase() ?? freeModelSource(model) ?? access.spoken,
    freeModelTrainingLabel(model) ?? "",
    freeModelRegionLabel(model) ?? "",
  ]
    .filter(Boolean)
    .join(", ")
}

/** The row's hover tooltip, one fact per line, with the details and exact figures the
    row itself leaves out or rounds:
    "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026" */
export function modelTitle(model: PickerModel) {
  const access = modelAccess(model)
  const about = [
    brandProviderName(model.provider.id, model.provider.name),
    model.capabilities?.reasoning ? "Reasoning" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return [
    pickerModelName(model),
    about,
    contextTitle(model.limit?.context),
    releaseTitle(model),
    codiumBadge(model)?.title ?? freeModelSource(model) ?? access.title,
    freeModelTrainingLabel(model) ?? "",
    freeModelRegionLabel(model) ?? "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** The badge beside a Codium entry the plan does not include ("Codium · Pro") or a preview ("Preview · Ultra"). */
export function codiumBadge(model: PickerModel) {
  if (model.provider.id !== ModelPlanStatus.PROVIDER_ID) return
  return ModelPlanStatus.listingBadge(model.codium)
}

/**
 * What choosing a row does: a Codium model the plan does not include opens Change plan instead of being chosen, since
 * every request to it would be refused (label plan §10). Everything else is chosen.
 */
export function pickModel<T extends PickerModel>(model: T, actions: { set: (model: T) => void; plans: () => void }) {
  if (model.provider.id === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isLocked(model)) return actions.plans()
  actions.set(model)
}

export type PickerSectionKind = "recent" | "provider" | "free"

/** One section of the picker. Its header shows only the mark, the label and how many models it holds: how a model is
    paid for, and what its provider may do with prompts, are in each row's tooltip, never on a header. */
export type PickerSection<T extends PickerModel = PickerModel> = {
  id: string
  kind: PickerSectionKind
  label: string
  /** The provider whose mark sits on the header (provider sections only). */
  providerID?: string
  items: T[]
}

export const RECENT_SECTION_LIMIT = 3

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

/** Newest first, undated last, then by name with numbers compared as numbers. */
function byRelease(a: PickerModel, b: PickerModel) {
  const at = releaseTime(a)
  const bt = releaseTime(b)
  if (at !== bt) {
    if (at === undefined) return 1
    if (bt === undefined) return -1
    return bt - at
  }
  return collator.compare(a.name, b.name)
}

/** Group connected coding models by provider. Without a search, the recent choices come first, above every provider
    and above Free models inside of Vector. Every section below lists all of its models, recent ones included, so a
    header's count is its provider's total and matches the rows it opens. Free models inside of Vector holds the free
    models Vector provides; a copy on the user's own account sits with that provider's other models.
    A `fixed` list, a host's own such as an external agent's CLI models, keeps the order its models came in (it leads
    with its CLI's default) and leaves out what the top section shows: it is always open and has no count, so a
    repeat would only show the same row twice. */
export function buildModelSections<T extends PickerModel>(input: {
  models: readonly T[]
  term?: string
  currentKey?: string
  recentKeys?: readonly string[]
  now: number
  popular?: readonly string[]
  fixed?: boolean
}): PickerSection<T>[] {
  const term = (input.term ?? "").trim().toLowerCase()
  // Both copies of a free model are listed, Vector's first; each runs where its section says.
  const models = freeModelChoices(
    input.models.filter((model) => !isHiddenProvider(model.provider.id, model.provider) && isCodingModel(model)),
  )
  const sections: PickerSection<T>[] = []
  const recent: T[] = []
  if (!term) {
    const byKey = new Map(models.map((model) => [pickerModelKey(model), model]))
    const history = new Set(input.recentKeys)
    for (const key of [input.currentKey, ...(input.recentKeys ?? [])]) {
      if (recent.length >= RECENT_SECTION_LIMIT) break
      const model = key ? byKey.get(key) : undefined
      if (!model || recent.includes(model)) continue
      recent.push(model)
    }
    if (recent.length > 0)
      sections.push({
        id: "recent",
        kind: "recent",
        label: recent.some((model) => history.has(pickerModelKey(model))) ? "Recently used" : "Current model",
        items: recent,
      })
  }

  const taken = new Set(input.fixed ? recent.map(pickerModelKey) : [])
  const free = models.filter(
    (model) =>
      providedByVector(model) && !taken.has(pickerModelKey(model)) && matchRank(model, term, input.now) !== undefined,
  )
  if (free.length) {
    sections.push({
      id: "free",
      kind: "free",
      label: FREE_MODELS_TITLE,
      items: free.sort((a, b) => freeModelOrder(a, b) || byRelease(a, b)),
    })
    free.forEach((model) => taken.add(pickerModelKey(model)))
  }

  const ranks = new Map<T, number>()
  const groups = new Map<string, T[]>()
  for (const model of models) {
    const key = pickerModelKey(model)
    if (taken.has(key)) continue
    const rank = matchRank(model, term, input.now)
    if (rank === undefined) continue
    taken.add(key)
    ranks.set(model, rank)
    const group = groups.get(model.provider.id)
    if (group) group.push(model)
    else groups.set(model.provider.id, [model])
  }
  const rank = (model: T) => ranks.get(model) ?? 0
  // Vector Codium keeps its catalog's order with Codium Auto pinned first: its models list no release date, so sorting
  // by date and name would put Claude Haiku 5.5, the model that uses the plan fastest, first.
  const pinned = (model: T) =>
    model.provider.id === ModelPlanStatus.PROVIDER_ID && ModelPlanStatus.isAuto(model) ? 0 : 1
  const order = (a: T, b: T) =>
    rank(a) - rank(b) ||
    (a.provider.id === ModelPlanStatus.PROVIDER_ID ? pinned(a) - pinned(b) : 0) ||
    (input.fixed || a.provider.id === ModelPlanStatus.PROVIDER_ID ? 0 : byRelease(a, b))

  const popular = (input.popular ?? []).filter(providerAllowed)
  const popularity = (id: string) => {
    const index = popular.indexOf(id)
    return index === -1 ? popular.length : index
  }
  const providers = Array.from(groups, ([id, items]) => ({
    id,
    items: items.sort(order),
    label: brandProviderName(id, items[0].provider.name),
  })).sort((a, b) => popularity(a.id) - popularity(b.id) || collator.compare(a.label, b.label))
  const listed: PickerSection<T>[] = providers.map((provider) => ({
    id: `provider:${provider.id}`,
    kind: "provider",
    label: provider.label,
    providerID: provider.id,
    items: provider.items,
  }))
  // Each section's first row is its best match. The sort is stable, so equally good
  // sections keep the order above.
  if (term) listed.sort((a, b) => rank(a.items[0]) - rank(b.items[0]))

  return [...sections, ...listed]
}

/** A row's key, for keyboard order and the row's data-option-key. A model in the top section is listed again under its
    provider, so the top section's rows carry their own prefix and no two rows share a key. */
export const pickerRowKey = (section: Pick<PickerSection, "kind">, model: { id: string; provider: { id: string } }) =>
  section.kind === "recent" ? `recent:${pickerModelKey(model)}` : pickerModelKey(model)

/** Keyboard order: every row, in render order. */
export function pickerKeys(sections: readonly PickerSection[]) {
  return sections.flatMap((section) => section.items.map((item) => pickerRowKey(section, item)))
}

/* ---- Open and closed sections ------------------------------------------------
   Each section below the top one has a header that opens and closes its rows. */

export type PickerSectionView<T extends PickerModel = PickerModel> = {
  section: PickerSection<T>
  /** The header is a button that opens and closes the section. */
  toggle: boolean
  /** The section's rows are shown. */
  open: boolean
}

/** How each section shows. Recently used (or Current model) is always open. Every other header opens and closes its
    section, even when it is the only one, so clicking a provider always does something. While searching, every
    section with a match is open and no header toggles, which leaves `open` as it was for when the search is cleared. */
export function pickerSectionViews<T extends PickerModel>(
  sections: readonly PickerSection<T>[],
  open: ReadonlySet<string>,
  term: string,
): PickerSectionView<T>[] {
  const searching = term.trim() !== ""
  return sections.map((section) => {
    const toggle = !searching && section.kind !== "recent"
    return { section, toggle, open: !toggle || open.has(section.id) }
  })
}

export const pickerHeaderKey = (section: Pick<PickerSection, "id">) => `section:${section.id}`

/** A header's spoken label: "Anthropic, 3 models". The header shows the count on its own, so it reads the same. */
export const pickerSectionLabel = (section: Pick<PickerSection, "label" | "items">) =>
  `${section.label}, ${section.items.length} ${section.items.length === 1 ? "model" : "models"}`

/** Keyboard order, in render order: each header that toggles, then its section's rows when it is open. `headers` maps
    a header's key to its section, so a model key can never be mistaken for one, and `rows` maps each visible row's key
    to its model. */
export function pickerNavigation<T extends PickerModel>(views: readonly PickerSectionView<T>[]) {
  const headers = new Map(
    views.filter((view) => view.toggle).map((view) => [pickerHeaderKey(view.section), view.section.id]),
  )
  const rows = new Map(
    views.flatMap((view) =>
      view.open ? view.section.items.map((item) => [pickerRowKey(view.section, item), item] as const) : [],
    ),
  )
  const keys = views.flatMap((view) => [
    ...(view.toggle ? [pickerHeaderKey(view.section)] : []),
    ...(view.open ? view.section.items.map((item) => pickerRowKey(view.section, item)) : []),
  ])
  return { keys, headers, rows }
}

/** The first visible row holding the current model: its row in the top section while that shows, otherwise its row
    under its provider. */
export function pickerCurrentRow(
  navigation: { keys: readonly string[]; rows: ReadonlyMap<string, PickerModel> },
  currentKey: string | undefined,
) {
  if (!currentKey) return undefined
  return navigation.keys.find((key) => {
    const item = navigation.rows.get(key)
    return item !== undefined && pickerModelKey(item) === currentKey
  })
}

export type PickerKeyAction = { move: string } | { toggle: string } | { select: string }

/** What a key pressed in the picker's search box does. The arrow keys move through the visible rows and headers,
    wrapping at either end; Enter or Space on a header toggles that section; Enter on anything else selects it. Space
    on a row types into search, so it returns nothing. `keys` is the whole keyboard order, Connect provider included. */
export function pickerKeyAction(
  event: { key: string; isComposing?: boolean },
  navigation: { keys: readonly string[]; headers: ReadonlyMap<string, string> },
  active: string,
): PickerKeyAction | undefined {
  const keys = navigation.keys
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (keys.length === 0) return
    const index = keys.indexOf(active)
    const start = index === -1 ? 0 : index
    const delta = event.key === "ArrowDown" ? 1 : -1
    return { move: keys[(start + delta + keys.length) % keys.length] }
  }
  if (event.isComposing) return
  const section = navigation.headers.get(active)
  if (section && (event.key === "Enter" || event.key === " ")) return { toggle: section }
  if (event.key === "Enter" && active) return { select: active }
  return undefined
}

const OPEN_SECTIONS_KEY = "vector.model-picker.open-sections.v1"

/** The sections a picker last left open. Storage that refuses reads, or holds something else, opens none, so the
    picker still works. */
export function readOpenSections(
  storage: () => Pick<Storage, "getItem"> | undefined = () => localStorage,
): Set<string> {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(OPEN_SECTIONS_KEY) ?? "[]")
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

/** Remembers the open sections for the next picker. Storage that refuses writes only forgets them. */
export function writeOpenSections(
  open: ReadonlySet<string>,
  storage: () => Pick<Storage, "setItem"> | undefined = () => localStorage,
) {
  try {
    storage()?.setItem(OPEN_SECTIONS_KEY, JSON.stringify([...open]))
  } catch {
    // Blocked storage: this picker still opens and closes sections; the next one starts with them closed.
  }
}

/** `open` with one section opened or closed. */
export function toggleOpenSection(open: ReadonlySet<string>, id: string) {
  const next = new Set(open)
  if (!next.delete(id)) next.add(id)
  return next
}
