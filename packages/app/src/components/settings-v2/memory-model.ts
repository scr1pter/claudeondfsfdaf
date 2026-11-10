// What the Memory page says about each entry, kept apart from the page so the wording is tested and stays honest.

export type MemoryKind =
  | "rule"
  | "preference"
  | "decision"
  | "lesson"
  | "fact"
  | "failure"
  | "review"
  | "term"
  | "skill"
export type MemoryStatus = "active" | "proposed" | "quarantined" | "archived" | "superseded"
export type MemoryHold =
  | "web"
  | "mcp"
  | "subagent"
  | "untrusted-repository"
  | "guest"
  | "instruction-like"
  | "hidden-unicode"
  | "hidden-text"
  | "suggested"

export type MemoryFacet = "format" | "workflow" | "vocabulary" | "tooling" | "sources" | "style"

export type MemoryEntryView = {
  id: string
  scope: "repository" | "personal"
  kind: MemoryKind
  origin: "file" | "user" | "agent" | "failure-memory" | "import"
  status: MemoryStatus
  pinned: boolean
  text: string
  paths: readonly string[]
  uses: number
  stale: boolean
  hold?: MemoryHold
  source?: { file: string; line?: number }
  lastUsedAt?: number
  createdAt?: number
  updatedAt: number
  /**
   * Kept from guests and from models that may train on prompts: learned from a private document, or from what the
   * user typed that names someone or something in particular.
   */
  private?: boolean
  /** What a preference or a term is about. */
  facet?: MemoryFacet
  /** A term's word or phrase and what the user means by it. */
  term?: { key: string; meaning: string }
}

export type MemoryFiles = { memory: string; rules: string; repository: readonly string[] }

export type MemoryFilter = "active" | "review" | "archived" | "all"

/**
 * Settings > Memory's sections: memory, the skills Vector learned, what it learned about the user, what workflows got
 * checks passing for less, documents, research, and the local model documents are searched by meaning with.
 */
export type MemoryTab = "memory" | "skills" | "about" | "workflow" | "documents" | "research" | "model"

export const MEMORY_TABS: readonly { value: MemoryTab; label: string }[] = [
  { value: "memory", label: "Memory" },
  { value: "skills", label: "Skills" },
  { value: "about", label: "About you" },
  { value: "workflow", label: "Workflow insights" },
  { value: "documents", label: "Documents" },
  { value: "research", label: "Research" },
  { value: "model", label: "Search model" },
]

export const MEMORY_FILTERS: readonly { value: MemoryFilter; label: string }[] = [
  { value: "active", label: "In use" },
  { value: "review", label: "Needs review" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "Everything" },
]

export const MEMORY_KINDS: readonly { value: "preference" | "decision" | "lesson" | "fact"; label: string }[] = [
  { value: "lesson", label: "Lesson" },
  { value: "decision", label: "Decision" },
  { value: "preference", label: "Preference" },
  { value: "fact", label: "Fact" },
]

export function kindLabel(kind: MemoryKind) {
  return {
    rule: "Rule",
    preference: "Preference",
    decision: "Decision",
    lesson: "Lesson",
    fact: "Fact",
    failure: "Past failure",
    review: "Review note",
    term: "Term",
    skill: "Learned skill",
  }[kind]
}

function basename(file: string) {
  return file.split(/[\\/]/).pop() ?? file
}

/** Where an entry comes from, in the words the page shows under it. */
export function originLabel(entry: Pick<MemoryEntryView, "origin" | "source" | "scope">, files?: MemoryFiles) {
  if (entry.origin === "user") return "You added this"
  if (entry.origin === "agent") return "Vector learned this"
  if (entry.origin === "failure-memory") return "Failure memory from checks Vector ran"
  if (entry.origin === "import") return "You imported this"
  const file = entry.source?.file ?? ""
  if (files && file === files.memory) return "From your MEMORY.md"
  if (files && file === files.rules) return "From your RULES.md"
  const name = basename(file)
  if (name === "BRAIN.md") return "From the repository's BRAIN.md (read-only)"
  if (name === "RULES.md") return "From the repository's .vector/RULES.md"
  return name ? `From ${name}` : "From a file"
}

/** Why an entry waits for the user before Vector uses it. Without a hold, where it came from says why. */
export function holdLabel(hold: MemoryHold | undefined, origin?: MemoryEntryView["origin"]) {
  if (hold === "web")
    return "Learned in a session that read web content, held an imported transcript or an issue's text, or ran a command that reaches outside this computer."
  if (hold === "mcp") return "Learned in a session that used an MCP tool or an MCP server's prompt."
  if (hold === "subagent") return "Learned from a subagent's report."
  if (hold === "guest") return "Learned while an invited guest was in the session."
  if (hold === "untrusted-repository") return "This repository's settings are not trusted yet, so its memory waits."
  if (hold === "instruction-like") return "It reads like an instruction to the agent, so it waits for you."
  if (hold === "hidden-unicode") return "It contains hidden characters. Fix the file to use it."
  if (hold === "hidden-text") return "It has text a reader of the document would not see, so it waits for you."
  if (hold === "suggested") return "Vector offered to keep it without you asking, so it waits for you."
  if (origin === "import") return IMPORTED
  if (origin === "agent")
    return "Vector read this in a longer message, a model suggested it, or an earlier version of Vector could not check its evidence, so it is used once you approve it. Something Vector read in a longer message also goes into use when you say it again in another session."
  return "An earlier version of Vector held this because it could not check its evidence. It is used once you approve it."
}

/** What an import says, and what an imported entry waiting for review says. */
export const IMPORTED = "Imported items wait for your approval."

/**
 * What the page says once the user adds a memory: what the engine kept, not what was typed. The engine stores the
 * user's words as a new entry beside any that say something similar (it never replaces one on its own), but it removes
 * a secret and keeps one copy of the same words.
 */
export function savedNotice(
  entry: Pick<MemoryEntryView, "text" | "status" | "updatedAt" | "createdAt">,
  typed: string,
) {
  if (entry.status !== "active") return "Saved for your review. Vector uses it once you approve it."
  if (entry.createdAt !== undefined && entry.updatedAt - entry.createdAt > 1000)
    return `This was already in memory, and it is in use: "${entry.text}"`
  if (entry.text.includes("[redacted]") && !typed.includes("[redacted]"))
    return "Saved without the secret it contained. Vector will use it when it is relevant."
  return "Saved. Vector will use it when it is relevant."
}

/** Only what Vector or the user saved here can be edited here; a file someone wrote is changed in that file. */
export function editable(entry: Pick<MemoryEntryView, "origin">) {
  return entry.origin === "user" || entry.origin === "agent" || entry.origin === "import"
}

/** Where to change an entry that comes from a file: the user's own file by name, a repository file by its path in it. */
export function fileLabel(file: string, files?: MemoryFiles, root?: string) {
  if (files && file === files.memory) return "your MEMORY.md"
  if (files && file === files.rules) return "your RULES.md"
  const base = root?.replace(/[\\/]+$/, "")
  if (base && (file.startsWith(`${base}/`) || file.startsWith(`${base}\\`)))
    return file.slice(base.length + 1).replaceAll("\\", "/")
  return basename(file)
}

/** Pinning puts an entry in every request; rules are already there, and review notes only ever go to reviews. */
export function pinnable(entry: Pick<MemoryEntryView, "kind" | "status">) {
  return entry.status === "active" && entry.kind !== "rule" && entry.kind !== "review"
}

export function forgettable(entry: Pick<MemoryEntryView, "origin">) {
  return entry.origin !== "file"
}

export function approvable(entry: Pick<MemoryEntryView, "status" | "origin" | "hold">) {
  if (entry.status !== "proposed" && entry.status !== "quarantined") return false
  if (entry.origin === "file" || entry.origin === "failure-memory") return entry.hold === "instruction-like"
  return true
}

export function rejectable(entry: Pick<MemoryEntryView, "status" | "origin">) {
  return (entry.status === "proposed" || entry.status === "quarantined") && editable(entry)
}

/** How many of Recently learned show before "Show all". */
export const RECENT = 8

/** What the page says once the user undoes something Vector learned. */
export const UNDONE = "Undone. Vector will not learn it again; restore it from Archived to bring it back."

export function summary(stats: { active: number; review: number; archived: number; digestTokens: number }) {
  return [
    `${stats.active} in use`,
    ...(stats.review > 0 ? [`${stats.review} to review`] : []),
    ...(stats.archived > 0 ? [`${stats.archived} archived`] : []),
    stats.digestTokens > 0
      ? `about ${stats.digestTokens.toLocaleString()} tokens in every request`
      : "nothing added to requests until there is memory",
  ].join(" · ")
}

export function usage(entry: Pick<MemoryEntryView, "uses" | "lastUsedAt">, now = Date.now()) {
  if (!entry.uses || !entry.lastUsedAt) return "Not used yet"
  const days = Math.floor((now - entry.lastUsedAt) / 86_400_000)
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return `Used ${entry.uses} time${entry.uses === 1 ? "" : "s"}, last ${when}`
}

// Settings > Memory > About you (section 6.5): what Vector learned about how the user works, grouped by what it is
// about, each kind with its own switch.

/** The facets of how the user works, in the order About you lists them, with what each covers. */
export const FACETS: readonly { value: MemoryFacet; label: string; description: string }[] = [
  { value: "format", label: "Formats", description: "Tables, bullets, charts, units, citation style and length." },
  { value: "workflow", label: "Workflow", description: "Pull requests, CI, merging, tests, commits and deploys." },
  { value: "vocabulary", label: "What you mean", description: "Words and phrases you use, and what you mean by them." },
  { value: "tooling", label: "Tools", description: "Package manager, editor and languages." },
  { value: "sources", label: "Sources", description: "Papers, primary sources, and sites you prefer or avoid." },
  { value: "style", label: "Style", description: "Everything else about how you like things done." },
]

export type AboutGroup = {
  /** A facet, or "other" for decisions, lessons and facts about the user, which no facet covers. */
  value: MemoryFacet | "other"
  label: string
  description: string
  entries: MemoryEntryView[]
}

/** How long Undo stays offered on what Vector learned; after that, Forget takes it back. */
export const UNDO_DAYS = 7

const DAY = 86_400_000

/**
 * What About you lists: what Vector learned about the user, what they added and what they imported, in use or waiting
 * for them, in groups by facet. Rules and MEMORY.md stay in their files (the Memory tab shows them), review notes go to
 * reviews only, and what was undone or replaced is under Archived. Every facet has a group, so each can be switched
 * off before Vector has learned anything of its kind.
 */
export function aboutYou(entries: readonly MemoryEntryView[]): AboutGroup[] {
  const shown = entries
    .filter(
      (entry) =>
        entry.scope === "personal" &&
        entry.origin !== "file" &&
        entry.origin !== "failure-memory" &&
        entry.kind !== "rule" &&
        entry.kind !== "review" &&
        entry.kind !== "failure" &&
        (entry.status === "active" || entry.status === "proposed" || entry.status === "quarantined"),
    )
    .toSorted((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt))
  const other = shown.filter((entry) => facetOf(entry) === undefined)
  return [
    ...FACETS.map((facet) => ({ ...facet, entries: shown.filter((entry) => facetOf(entry) === facet.value) })),
    ...(other.length > 0
      ? [
          {
            value: "other" as const,
            label: "Other things about you",
            description: "Decisions, lessons and facts Vector keeps about you.",
            entries: other,
          },
        ]
      : []),
  ]
}

/** An entry's facet: its own, or for one saved before facets existed, a term's vocabulary and a preference's style. */
export function facetOf(entry: Pick<MemoryEntryView, "facet" | "kind">): MemoryFacet | undefined {
  if (entry.facet) return entry.facet
  if (entry.kind === "term") return "vocabulary"
  if (entry.kind === "preference") return "style"
  return undefined
}

/** What an item reads as: a term as what the user means, anything else as its words. */
export function entryText(entry: Pick<MemoryEntryView, "kind" | "text" | "term">) {
  if (entry.kind === "term" && entry.term) return `When you say "${entry.term.key}" you mean: ${entry.term.meaning}`
  return entry.text
}

/** Undo is for what Vector put in use on its own, in its first week; after that the user forgets it instead. */
export function undoable(
  entry: Pick<MemoryEntryView, "origin" | "status" | "createdAt" | "updatedAt">,
  now = Date.now(),
) {
  if (entry.origin !== "agent" || entry.status !== "active") return false
  return now - (entry.createdAt ?? entry.updatedAt) <= UNDO_DAYS * DAY
}

/** When an item was learned, added or imported, in the words the page shows. */
export function learnedWhen(entry: Pick<MemoryEntryView, "origin" | "createdAt" | "updatedAt">, now = Date.now()) {
  const days = Math.floor((now - (entry.createdAt ?? entry.updatedAt)) / DAY)
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  if (entry.origin === "user") return `You added this ${when}`
  if (entry.origin === "import") return `You imported this ${when}`
  return `Vector learned this ${when}`
}

type Evidence = { type: string; quote?: string; sessionID?: string }

/**
 * The words an item came from and the session it was learned in, from its evidence. The quote is shown only when it
 * says more than the item: what Vector's learner keeps is the user's own clause, so its quote is the item's words.
 */
export function cameFrom(entry: Pick<MemoryEntryView, "text">, evidence: readonly Evidence[]) {
  const said = evidence.find((item) => item.type === "message" && item.quote?.trim())
  const quote = said?.quote?.trim()
  const session = evidence.find((item) => item.sessionID)?.sessionID
  return {
    ...(quote && simplified(quote) !== simplified(entry.text) ? { quote } : {}),
    ...(session ? { sessionID: session } : {}),
  }
}

function simplified(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** Imported entries "Approve all" puts in use: only those waiting for nothing but approval, never one held. */
export function approvableImports(entries: readonly Pick<MemoryEntryView, "id" | "status" | "origin" | "hold">[]) {
  return entries.filter((entry) => entry.origin === "import" && entry.status === "proposed" && !entry.hold)
}

/** What the page says after an import. */
export function importNotice(result: { entries: readonly unknown[]; known: number; refused: number; over: number }) {
  const count = result.entries.length
  return [
    count > 0 ? `Imported ${count} item${count === 1 ? "" : "s"}. ${IMPORTED}` : "Nothing new to import.",
    ...(result.known > 0 ? [`${result.known} ${result.known === 1 ? "was" : "were"} already in memory.`] : []),
    ...(result.refused > 0
      ? [
          `${result.refused} ${result.refused === 1 ? "was" : "were"} left out: forgotten before, a secret, too long, or past what may wait for review.`,
        ]
      : []),
    ...(result.over > 0
      ? [`${result.over} past the 500 one import brings in ${result.over === 1 ? "was" : "were"} left out.`]
      : []),
  ].join(" ")
}

/** The name an export downloads as. */
export function exportName(scope: "personal" | "repository" | "all", format: "markdown" | "json") {
  const what = scope === "personal" ? "about-you" : scope === "repository" ? "repository" : "all"
  return `vector-memory-${what}.${format === "json" ? "json" : "md"}`
}

/** About you's own words (section 17). */
export const ABOUT = {
  title: "What Vector learned about you",
  intro:
    "Vector learns from what you type: the formats and kinds of data you like, what you mean by words you use, and how you like things done. Each item shows the words it came from. Undo, edit, forget or turn off any kind.",
  sensitive: "Vector tries not to keep sensitive personal details.",
  storage:
    "Your brain is a file on this computer (brain.db). You can see, change, export or erase everything in it. With Vector Local on, its contents go only to the model servers you list, and the network log shows which requests carried them.",
  agents:
    "Every agent uses what Vector has learned about you: coding, subagents, the Vectorscope reviews you run in Vector and Deep research. Sessions with invited guests, and free models that may train on your prompts, get none of it. Reviews and research see how you work, not facts about you.",
  erase:
    "Erase removes it from the brain and stops Vector using it. The sessions it came from keep their messages until you delete them. A model server you host may keep its own logs.",
  guest: "What Vector learned about you is the repository owner's, so it shows only to them.",
  failed: "Vector could not read what it learned about you. Try again in a moment.",
  off: "Vector does not learn this kind. What it learned of it stays until you forget it.",
}

/** "Erase what Vector learned in this session", and what it leaves. */
export const ERASE_SESSION = {
  action: "Erase what Vector learned in this session",
  /** The same, from Settings, for the session an item came from. */
  there: "Erase what Vector learned in that session",
  confirm:
    "Vector forgets every entry whose only evidence is the session, and does not learn it again. It also forgets the Deep research runs the session started. What you wrote, and what other sessions also taught it, stay. The session keeps its messages until you delete it.",
  done: (count: number) =>
    count === 0
      ? "Vector had learned nothing that only this session taught it."
      : `Erased ${count} thing${count === 1 ? "" : "s"} Vector learned only in this session.`,
}

/** The optional model learner's choices (section 7.4), with Vector Local the default. */
export const MODEL_LEARNER: readonly { value: "local-only" | "always" | "off"; label: string }[] = [
  { value: "local-only", label: "With Vector Local only" },
  { value: "always", label: "With any model" },
  { value: "off", label: "Off" },
]
