import type { Message, Part } from "@vectordevai/sdk/v2/client"
import { ResearchConfidence } from "@vectordevai/core/research/confidence"
import { Research } from "@vectordevai/schema/research"
import { Option, Schema } from "effect"

// Deep research in the app (sections 8.1 to 8.4 of the build plan): the composer's mode and chips, the plan card's
// answer, the Sources tab and the report card. Everything here is pure, so the rules are tested without a browser.

/** Shown beside Deep research while it is in preview. */
export const PREVIEW = "Preview"
export const LABEL = "Deep research"
export const DESCRIPTION =
  "Researches a question across the web and this repository's brain, then writes a report with each claim cited. Makes no code changes."
export const PLACEHOLDER = "What should Vector research?"
export const GUEST = "Sources are visible to the repository owner."
export const HELD = "This report and its sources stay private and out of later sessions until you keep them."
export const WRAP_UP = "Write the report now from what you have"
/** Where research searches, as the plan card says it. */
export const SEARCH_WHERE =
  "Search: Google, in each research agent's own browser (DuckDuckGo when Google asks for a check). No search service or key."
export const NO_SEARCH =
  "Nothing is searched on the web here. Research will use this repository's brain, its files and links you paste."
/** How to search, for an engine that gave no reason it searches nowhere. */
export const SETUP =
  "Research searches the web in Vector's desktop app, where each research agent has a browser of its own: open this repository there to search. No search service or key is needed."
export const PAYWALL =
  "Paywalled: Vector kept the public excerpt only. Use Open in browser to read the rest with your own sign-in."
export const VIEW_ONLY =
  "View only: Vector shows snapshots of this research browser. Nothing you do here reaches the page, so nothing signs it in."
/** The agent every Deep research message carries. */
export const AGENT = "research"

// ---------------------------------------------------------------------------------------------------------------
// The composer

export type Mode = "normal" | "quick" | "fast" | "research"

// The Mode menu: Normal, Quick, Fast, then Deep research directly under Fast (owner, 22 Oct).
export const MODES: readonly {
  readonly id: Mode
  readonly label: string
  readonly description: string
  readonly dot: string
  readonly preview?: boolean
}[] = [
  { id: "normal", label: "Normal", description: "Standard execution speed and token use.", dot: "#8a8595" },
  {
    id: "quick",
    label: "Quick",
    description: "Answers simple questions quickly with minimal context and fewer tokens.",
    dot: "#70c7b1",
  },
  {
    id: "fast",
    label: "Fast",
    description: "Targets 1.5x speed with priority capacity and wider parallel execution. Uses more tokens.",
    dot: "#9b6cff",
  },
  { id: "research", label: LABEL, description: DESCRIPTION, dot: "#6ea8fe", preview: true },
]

/**
 * The Mode menu for the selected model. Fast promises priority capacity that a model server someone hosts cannot give,
 * so a model on one is offered no Fast.
 */
export function modesFor(hosted: boolean, research: boolean) {
  return MODES.filter((mode) => !(hosted && mode.id === "fast") && (research || mode.id !== "research"))
}

export const RESEARCH_UNAVAILABLE =
  "Deep research is not available on this engine. Open this repository with the current desktop engine, or choose another mode."

/** The raw engine agent list, before the ordinary agent picker removes the research agent. */
export function hasResearch(agents: readonly { name: string }[] | undefined) {
  return agents?.some((agent) => agent.name === AGENT) === true
}

/** Preserve remembered research intent: an older engine must never silently turn it into a coding request. */
export function requireResearch(requested: boolean, agents: readonly { name: string }[] | undefined) {
  if (requested && !hasResearch(agents)) throw new Error(RESEARCH_UNAVAILABLE)
}

/** The mode a request goes in: Fast picked for another model goes as Normal on a server someone hosts. */
export function sendMode(chosen: Mode, hosted: boolean): Mode {
  return chosen === "fast" && hosted ? "normal" : chosen
}

export type Depth = "auto" | "focused" | "deep"

export const DEPTHS: readonly { readonly value: Depth; readonly label: string; readonly description: string }[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Vector sizes the question: Focused, or Deep when you ask it to be thorough.",
  },
  {
    value: "focused",
    label: "Focused",
    description: "Focused: one agent, plus up to 2 researchers when the question has independent parts",
  },
  { value: "deep", label: "Deep", description: "Deep: up to 4 researchers and a judge" },
]

export const SCOPES: readonly { readonly value: Research.Scope; readonly label: string }[] = [
  { value: "web+brain", label: "Web and brain" },
  { value: "web", label: "Web only" },
  { value: "brain", label: "Brain and files only" },
]

/** The Depth chip as the request's size: Focused is Work, Deep is Thorough, and Auto leaves the sizing to Vector. */
export function sizeOf(depth: Depth) {
  if (depth === "focused") return "standard" as const
  if (depth === "deep") return "thorough" as const
  return undefined
}

export function scopeLabel(scope: Research.Scope) {
  return SCOPES.find((item) => item.value === scope)?.label ?? scope
}

/**
 * The mode a session is in, from the latest message the user sent: Deep research while it went to the research agent.
 * A greeting the quick lane answered on its own (the quick agent without the composer's Quick pick, which sends the
 * Chat size) says nothing about the mode, so the message before it decides.
 */
export function stickyMode(messages: readonly Message[]): "research" | undefined {
  const last = messages.findLast(
    (message) => message.role === "user" && !(message.agent === "quick" && message.size !== "chat"),
  )
  return last?.role === "user" && last.agent === AGENT ? "research" : undefined
}

/** Caps a research run takes when the user set none of their own (section 11.2), as the engine applies them. */
export const LIMITS: Readonly<Record<Research.Depth, { readonly usd: number; readonly steps: number }>> = {
  focused: { usd: 1, steps: 80 },
  deep: { usd: 3, steps: 240 },
}

/**
 * The Cap chip: the user's own run cap when they set one, else research's default for the depth. `local` is the
 * engine's word that the model's steps have no per-token price (a server on this computer or a private one on the list,
 * with no price set), so its cap is a step count; any other model, hosted or not, keeps its dollar cap.
 */
export function capLabel(input: {
  readonly depth: Depth
  readonly local: boolean
  readonly codium?: boolean
  readonly own?: { readonly usd?: number; readonly steps?: number }
  readonly limits?: Partial<Record<Research.Depth, { readonly usd?: number; readonly steps?: number }>>
}) {
  const depth: Research.Depth = input.depth === "deep" ? "deep" : "focused"
  const own = input.own?.usd !== undefined || input.own?.steps !== undefined ? input.own : undefined
  const limits = { ...LIMITS[depth], ...input.limits?.[depth] }
  const steps = own ? own.steps : limits.steps
  if (input.codium) return steps === undefined ? "Codium · no step cap" : `Codium · ${steps} steps`
  if (input.local) return steps === undefined ? "Local · no step cap" : `Local · ${steps} steps`
  const usd = own ? own.usd : limits.usd
  if (usd !== undefined) return `Cap $${usd.toFixed(2)}`
  return steps === undefined ? "No cap" : `Cap ${steps} steps`
}

// A remembered mode per repository is a convenience: it may be missing, or the storage may throw (a private window,
// blocked site data), and the composer then starts in Normal.
const MODE_KEY = "vector.research.mode.v1:"

export type ModeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** Whether a new session in this repository starts in Deep research. */
export function rememberedMode(storage: ModeStorage | undefined, directory: string): "research" | undefined {
  try {
    return storage?.getItem(MODE_KEY + directory) === AGENT ? "research" : undefined
  } catch {
    return undefined
  }
}

/** Remembers the mode picked last in a repository; only Deep research carries over to new sessions. */
export function rememberMode(storage: ModeStorage | undefined, directory: string, mode: Mode) {
  try {
    if (mode === "research") storage?.setItem(MODE_KEY + directory, AGENT)
    else storage?.removeItem(MODE_KEY + directory)
  } catch {
    // A convenience only: the mode still applies to this composer.
  }
}

/** The browser's localStorage, or nothing where reading it throws. */
export function browserStorage(): ModeStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The plan card

export const PLAN_PREFIX = "vector-plan:"
export const START = "Start"
export const START_DEEP = "Start deep"
export const CANCEL = "Cancel"

/** What research_plan puts on its running part for the card (engine `tool/research-plan.ts`, `Card`). */
export type Card = {
  readonly deep: boolean
  readonly deepEstimate?: string
  /** browser or none; an older engine may name its search service, which reads as the web. */
  readonly search: { readonly provider: string; readonly reason?: string }
  /** The user's own sites and format: from their config, and from what they ticked Always for on an earlier card. */
  readonly preferences: {
    readonly prefer: readonly string[]
    readonly avoid: readonly string[]
    readonly format?: Research.Format
  }
  readonly offline: boolean
}

export type PlanCardData = { readonly plan: Research.Plan; readonly estimate?: string; readonly card?: Card }

const decodePlan = Schema.decodeUnknownOption(Research.Plan)
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Research.PlanAnswer))

/** The card's data from the running research_plan part, or nothing when an older engine left it out. */
export function planCard(metadata: Record<string, unknown> | undefined): PlanCardData | undefined {
  const plan = decodePlan(metadata?.plan)
  if (Option.isNone(plan)) return undefined
  const card = metadata?.card
  return {
    plan: plan.value,
    ...(typeof metadata?.estimate === "string" ? { estimate: metadata.estimate } : {}),
    ...(isCard(card) ? { card } : {}),
  }
}

function isCard(value: unknown): value is Card {
  if (!value || typeof value !== "object") return false
  const card = value as Record<string, unknown>
  const search = card.search as Record<string, unknown> | undefined
  const preferences = card.preferences as Record<string, unknown> | undefined
  return (
    typeof card.deep === "boolean" &&
    typeof card.offline === "boolean" &&
    !!search &&
    typeof search.provider === "string" &&
    !!preferences &&
    Array.isArray(preferences.prefer) &&
    Array.isArray(preferences.avoid)
  )
}

/** The research_plan tool part a question belongs to, when the question is a plan card. */
export function planPart(parts: readonly Part[] | undefined, tool: { readonly callID: string } | undefined) {
  if (!tool) return undefined
  return parts?.find(
    (part): part is Extract<Part, { type: "tool" }> =>
      part.type === "tool" && part.tool === "research_plan" && part.callID === tool.callID,
  )
}

/** The fields of a plan the card lets the user change, as the card's store holds them. */
export type Draft = {
  question: string
  subquestions: string[]
  scope: Research.Scope
  prefer_domains: string[]
  avoid_domains: string[]
  format?: Research.Format
  time_window: string
}

export type Remembered = "prefer_domains" | "avoid_domains" | "format"

export function draftOf(plan: Research.Plan): Draft {
  return {
    question: plan.question,
    subquestions: [...plan.subquestions],
    scope: plan.scope,
    prefer_domains: [...(plan.prefer_domains ?? [])],
    avoid_domains: [...(plan.avoid_domains ?? [])],
    ...(plan.format ? { format: plan.format } : {}),
    time_window: plan.time_window ?? "",
  }
}

/** A site the user adds on the card, as a host or a domain: lowercased, without a scheme, a path or "www.". */
export function site(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "")
}

/** What the user changed against the plan Vector proposed, field by field: only those go back to research_plan. */
export function planEdits(proposed: Research.Plan, draft: Readonly<Draft>) {
  const subquestions = draft.subquestions.map((item) => item.trim()).filter(Boolean)
  const prefer = sites(draft.prefer_domains)
  const avoid = sites(draft.avoid_domains)
  const question = draft.question.trim()
  const window = draft.time_window.trim()
  return {
    ...(question !== proposed.question ? { question } : {}),
    ...(!same(subquestions, proposed.subquestions) ? { subquestions } : {}),
    ...(draft.scope !== proposed.scope ? { scope: draft.scope } : {}),
    ...(!same(prefer, proposed.prefer_domains ?? []) ? { prefer_domains: prefer } : {}),
    ...(!same(avoid, proposed.avoid_domains ?? []) ? { avoid_domains: avoid } : {}),
    ...(draft.format && draft.format !== proposed.format ? { format: draft.format } : {}),
    ...(window !== (proposed.time_window ?? "") ? { time_window: window } : {}),
  } satisfies NonNullable<Research.PlanAnswer["plan"]>
}

/** Why the card cannot start yet, in the user's words, or nothing when it can. */
export function planProblem(draft: Readonly<Draft>) {
  const subquestions = draft.subquestions.map((item) => item.trim()).filter(Boolean)
  if (!draft.question.trim()) return "Write the question to research."
  if (draft.question.trim().length > 1_000) return "Shorten the question to 1,000 characters or fewer."
  if (subquestions.length === 0) return "Add at least one sub-question."
  if (subquestions.length > 8) return "Research takes 8 sub-questions at most."
  if (subquestions.some((item) => item.length > 300)) return "Shorten each sub-question to 300 characters or fewer."
  if (draft.time_window.trim().length > 80) return "Shorten the time window to 80 characters or fewer."
  if ([...draft.prefer_domains, ...draft.avoid_domains].some((item) => site(item).length > 253))
    return "A site name can be 253 characters at most."
  return undefined
}

/**
 * The card's answer as research_plan reads it: the button's own label when nothing was edited, else `vector-plan:`
 * with the edited fields and those the user asked Vector to remember.
 */
export function planReply(input: {
  readonly action: "start" | "start-deep" | "cancel"
  readonly proposed: Research.Plan
  readonly draft: Readonly<Draft>
  readonly always: readonly Remembered[]
}) {
  if (input.action === "cancel") return CANCEL
  const plan = planEdits(input.proposed, input.draft)
  const always = input.always.filter((key) => key in plan)
  if (Object.keys(plan).length === 0) return input.action === "start" ? START : START_DEEP
  return encodePlanAnswer({ action: input.action, plan, ...(always.length ? { always } : {}) })
}

export function encodePlanAnswer(answer: Research.PlanAnswer) {
  return PLAN_PREFIX + JSON.stringify(answer)
}

/** The answer research_plan would read from the card's text, or nothing for a typed reply (a steer). */
export function decodePlanAnswer(text: string): Research.PlanAnswer | undefined {
  if (!text.startsWith(PLAN_PREFIX)) return undefined
  return Option.getOrUndefined(decodeAnswer(text.slice(PLAN_PREFIX.length)))
}

/** The plan card's search line. */
export function searchLine(card: Card | undefined) {
  if (!card) return undefined
  if (card.search.provider === "browser") return SEARCH_WHERE
  if (card.search.provider === "none") return NO_SEARCH
  return "Search: the web"
}

/**
 * What the plan card offers beside "Nothing is searched", when research searches nowhere here: the engine's own reason,
 * alone, under Why (it says what holds search back: no desktop browser, or a run told to search nothing, which no
 * set-up changes); how to search, under Set up, only when the engine gave no reason.
 */
export function searchHelp(card: Card | undefined) {
  if (card?.search.provider !== "none") return undefined
  return card.search.reason ? { label: "Why", text: card.search.reason } : { label: "Set up", text: SETUP }
}

// ---------------------------------------------------------------------------------------------------------------
// Runs, sources and the report

/** The research runs a session's tool parts name, oldest first. */
export function sessionRuns(parts: readonly Part[]) {
  return [
    ...new Set(
      parts.flatMap((part) => {
        if (part.type !== "tool" || !part.tool.startsWith("research_")) return []
        const state = part.state
        const runID = "metadata" in state ? state.metadata?.runID : undefined
        return typeof runID === "string" && runID ? [runID] : []
      }),
    ),
  ]
}

/** Addresses this session's agents are reading right now, which the store has not saved yet. */
export function reading(parts: readonly Part[]) {
  return [
    ...new Set(
      parts.flatMap((part) => {
        if (part.type !== "tool" || part.state.status !== "running") return []
        if (part.tool !== "research_read" && part.tool !== "research_browser") return []
        const url = part.state.metadata?.url ?? part.state.input?.url
        return typeof url === "string" && url ? [url] : []
      }),
    ),
  ]
}

const STATUS: Readonly<Record<Research.SourceStatus, string>> = {
  read: "read",
  duplicate: "duplicate",
  robots: "blocked by robots.txt",
  paywalled: "paywalled (excerpt only)",
  "needs-render": "needs the desktop browser",
  failed: "failed",
}

/** A source's status as its row shows it. */
export function statusLabel(source: Pick<Research.Source, "status" | "reason" | "signals">) {
  if (source.status === "duplicate" && source.signals?.duplicate_of)
    return `duplicate of ${source.signals.duplicate_of}`
  if (source.status === "failed" && source.reason) return `failed: ${source.reason}`
  return STATUS[source.status]
}

/** One live chip per research browser (desktop `research-browser.ts`, `Chip`). */
export type BrowserChip = {
  readonly id: string
  readonly runID: string
  readonly sessionID: string
  readonly label: string
  readonly host: string
  readonly state: string
}

/** "Researcher 2 · nature.com · reading" */
export function chipText(chip: BrowserChip) {
  return [chip.label, chip.host, chip.state].filter(Boolean).join(" · ")
}

/** The research browsers of these runs. */
export function runChips(chips: readonly BrowserChip[], runs: readonly string[]) {
  const known = new Set(runs)
  return chips.filter((chip) => known.has(chip.runID))
}

/**
 * A note's quote in a chunk of saved text, found near enough to highlight the way research_note found it: runs of
 * whitespace and soft hyphens count as one space, and straight and curly quote marks as one another. A quote that is
 * not found is simply not highlighted.
 */
export function highlights(text: string, quotes: readonly string[]) {
  const spans = quotes.flatMap((quote) => {
    const words = quote
      .trim()
      .replace(QUOTE_ENDS, "")
      .split(/[\s­]+/)
      .filter(Boolean)
    if (words.length === 0) return []
    const found = new RegExp(words.map(wordPattern).join("[\\s\\u00AD]+"), "iu").exec(text)
    return found ? [{ start: found.index, end: found.index + found[0].length }] : []
  })
  const sorted = spans.toSorted((a, b) => a.start - b.start)
  return sorted.reduce<{ start: number; end: number }[]>((merged, span) => {
    const last = merged.at(-1)
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
      return merged
    }
    merged.push({ ...span })
    return merged
  }, [])
}

/** Text cut at its highlighted spans. */
export function segments(text: string, spans: readonly { start: number; end: number }[]) {
  const out: { text: string; mark: boolean }[] = []
  const end = spans.reduce((at, span) => {
    if (span.start > at) out.push({ text: text.slice(at, span.start), mark: false })
    out.push({ text: text.slice(span.start, span.end), mark: true })
    return span.end
  }, 0)
  if (end < text.length) out.push({ text: text.slice(end), mark: false })
  return out
}

export const CITE_PREFIX = "#vector-cite-"

// The report as the run store rendered it (core `research/report.ts`): each citation is a source chip with a footnote,
// `\[S3 p.12\][^N3]`, and the footnotes' definitions close the report. The app's Markdown has no footnotes, so each
// chip becomes a link the report card turns into a chip, and the definitions are dropped: a chip's hover shows its
// note's quote instead.
const CHIP = /\\\[(S\d+(?: p\.\d+)?)\\\]\[\^(N\d+)\]/g
const FOOTNOTE = /^\[\^N\d+\]: .*$/gm

/** The report's Markdown with its citations as chip links. */
export function reportMarkdown(markdown: string) {
  return markdown
    .replace(CHIP, (_, chip: string, note: string) => `[${chip}](${CITE_PREFIX}${note})`)
    .replace(FOOTNOTE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The note a chip link names. */
export function citedNote(href: string | null | undefined) {
  if (!href?.startsWith(CITE_PREFIX)) return undefined
  const id = href.slice(CITE_PREFIX.length)
  return /^N\d+$/.test(id) ? id : undefined
}

/** What a citation chip says on hover: the note's quote and where it is from. */
export function chipTitle(note: Research.Note | undefined, source: Research.Source | undefined) {
  if (!note) return "This note is no longer in the run."
  const where = [source?.title || source?.site, note.page ? `p.${note.page}` : undefined].filter(Boolean).join(", ")
  return `"${note.quote}"${where ? ` (${note.source}: ${where})` : ` (${note.source})`}`
}

/** A section's confidence line, as the report states it, for its badge. */
export function confidenceOf(text: string) {
  const found = /^Confidence: (High|Medium|Low) \(Vector's estimate\)( · Sources disagree)?$/.exec(text.trim())
  if (!found) return undefined
  return {
    level: found[1]!.toLowerCase() as ResearchConfidence.Level,
    disagree: !!found[2],
    title: ResearchConfidence.HOVER,
  }
}

/** Where "Save to repository" writes a report: `.vector/research/<date>-<slug>.md`, which repository docs skip. */
export function reportPath(question: string, created: number) {
  const date = new Date(created).toISOString().slice(0, 10)
  const slug =
    question
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "research"
  return `.vector/research/${date}-${slug}.md`
}

/** "Keep this format": what Vector remembers about how the user likes research written. */
export function formatPreference(format: Research.Format | undefined) {
  return `Write Deep research results as a ${format ?? "report"}.`
}

/** Bytes as a short size. */
export function size(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** A research route refused someone who is not the repository's owner: the memory routes are the owner's alone. */
export function ownerOnly(status: number | undefined) {
  return status === 401 || status === 403
}

/** The event that opens the Sources tab, from the report card or a research tool row. */
export const OPEN_SOURCES = "vector:open-research-sources"

export type OpenSources = {
  readonly sessionID: string
  readonly runID?: string
  readonly source?: string
  readonly note?: string
}

// Sites as research_plan keeps them: trimmed, lowercased, each once.
function sites(list: readonly string[]) {
  return [...new Set(list.map((item) => item.trim().toLowerCase()).filter(Boolean))]
}

const QUOTE_ENDS = /^["'‘’“”]+|["'‘’“”]+$/g

// One word of a quote as a pattern, with a quote mark in it matching its straight and curly forms.
function wordPattern(input: string) {
  return input
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/['‘’]/g, "['‘’]")
    .replace(/["“”]/g, '["“”]')
}

function same(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
