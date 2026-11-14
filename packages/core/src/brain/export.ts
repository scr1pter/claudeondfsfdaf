export * as BrainExport from "./export"

import { Effect, Option, Schema } from "effect"
import path from "node:path"
import type { Brain } from "./brain"
import type { BrainKnowledge } from "./knowledge"
import { BrainLearn } from "./learn"
import { BrainSchema } from "./schema"
import { BrainSkill } from "./skill"
import { Item, Document, File } from "./memory-file-codec"

export { Item, Document, File } from "./memory-file-codec"

// Export and import of memory (section 6.5), shared by `vector memory export` and Settings > Memory: everything the
// brain keeps for this repository, for the user or both, as a Markdown page a person can read (a section per kind, each
// entry with its evidence below it, then what Vector read from documents) or as JSON. An import reads either back, and
// every entry it brings in waits for the user's approval ("Approve all" is one click), so a changed file cannot plant
// memory in use. What reads as instructions to the agent or hides characters is held apart from the rest, so that one
// click does not put it in use either. Forgotten entries are not imported again. Learned skills go with their
// repository's memory, without the failure excerpt, and come back through BrainSkill's own gate, waiting for review.

export type Scope = "personal" | "repository" | "all"
export type Format = "markdown" | "json"

export const LIMIT = {
  /** Characters of one import, and entries it may bring in. */
  text: 2 * 1024 * 1024,
  entries: 500,
} as const

/** What an export of `scope` holds, as data. */
export const collect = Effect.fn("BrainExport.collect")(function* (input: {
  readonly brain: Brain.Interface
  readonly knowledge: BrainKnowledge.Interface
  readonly place: Brain.Place
  readonly scope: Scope
  /** Learned skills, which a repository's export carries when given. */
  readonly skills?: BrainSkill.Interface
}) {
  const entries = (yield* input.brain.list(input.place, {
    filter: "all",
    ...(input.scope === "all" ? {} : { scope: input.scope }),
  })).toSorted((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.createdAt - b.createdAt)
  const items = yield* Effect.forEach(entries, (entry) =>
    input.brain.get(input.place, entry.id, { personal: true }).pipe(
      Effect.map(
        (detail): Item => ({
          id: entry.id,
          scope: entry.scope,
          kind: entry.kind,
          status: entry.status,
          text: entry.text,
          ...(entry.facet ? { facet: entry.facet } : {}),
          paths: entry.paths,
          pinned: entry.pinned,
          ...(entry.private ? { private: true } : {}),
          ...(entry.source ? { file: entry.source.file } : {}),
          evidence: detail?.evidence ?? [],
          createdAt: entry.createdAt,
        }),
      ),
    ),
  )
  const skills = input.skills && input.scope !== "personal" ? input.skills : undefined
  const learned = skills
    ? yield* Effect.forEach(yield* skills.list(input.place, "all"), (entry) =>
        skills.get(input.place, entry.id).pipe(
          Effect.map(
            (detail): Item => ({
              id: entry.id,
              scope: entry.scope,
              kind: entry.kind,
              status: entry.status,
              text: entry.text,
              paths: entry.paths,
              pinned: false,
              ...(entry.private ? { private: true } : {}),
              evidence: detail?.evidence ?? [],
              createdAt: entry.createdAt,
              ...(entry.skill
                ? {
                    skill: {
                      name: entry.skill.name,
                      description: entry.skill.description,
                      procedure: entry.skill.procedure,
                      checks: entry.skill.checks,
                      commands: entry.skill.commands,
                      version: entry.skill.version,
                    },
                  }
                : {}),
            }),
          ),
        ),
      )
    : []
  // Documents are the repository's, whoever added them.
  const documents = input.scope === "personal" ? [] : yield* input.knowledge.documents(input.place, { personal: true })
  const read = yield* Effect.forEach(documents, (document) =>
    Effect.gen(function* () {
      const records: BrainSchema.Record[] = []
      for (let cursor: string | undefined = undefined; ; ) {
        const page: BrainKnowledge.RecordPage = yield* input.knowledge.records(input.place, {
          document: document.id,
          limit: 100,
          ...(cursor ? { cursor } : {}),
          personal: true,
        })
        records.push(...page.records)
        if (!page.cursor) break
        cursor = page.cursor
      }
      return {
        id: document.id,
        title: document.title,
        format: document.format,
        origin: document.origin,
        visibility: document.visibility,
        status: document.status,
        version: document.version,
        ...(document.pages ? { pages: document.pages } : {}),
        records: records.map((record) => ({
          id: record.id,
          kind: record.kind,
          card: record.card,
          ...(record.page ? { page: record.page } : {}),
        })),
      } satisfies Document
    }),
  )
  return {
    format: "vector-memory",
    version: 1,
    scope: input.scope,
    exportedAt: Date.now(),
    entries: items,
    documents: read,
    ...(learned.length ? { skills: learned } : {}),
  } satisfies File
})

/** An export as text: Markdown to read, or JSON. */
export const render = Effect.fn("BrainExport.render")(function* (input: {
  readonly brain: Brain.Interface
  readonly knowledge: BrainKnowledge.Interface
  readonly place: Brain.Place
  readonly scope: Scope
  readonly format: Format
  readonly skills?: BrainSkill.Interface
}) {
  const file = yield* collect(input)
  if (input.format === "json") return `${JSON.stringify(Schema.encodeSync(File)(file), null, 2)}\n`
  return markdown(file)
})

/** A readable page per kind, each entry with its evidence below it, then the documents: open your brain and read it. */
export function markdown(file: File) {
  const all = [...file.entries, ...(file.skills ?? [])]
  const sections = KINDS.flatMap((kind) => {
    const items = all.filter((entry) => entry.kind === kind)
    if (items.length === 0) return []
    if (kind === "skill") return [`## ${HEADINGS[kind]}`, "", ...items.flatMap(skillMarkdown)]
    return [
      `## ${HEADINGS[kind]}`,
      "",
      ...items.flatMap((entry) => {
        const marks = [
          entry.scope,
          entry.facet,
          entry.status === "active" ? undefined : entry.status,
          entry.pinned ? "pinned" : undefined,
          entry.private ? "private" : undefined,
        ].filter((mark): mark is string => mark !== undefined)
        return [
          `- **${entry.id}** ${oneLine(entry.text)} _(${marks.join(", ")})_`,
          ...(entry.file ? [`  - from ${path.basename(entry.file)}`] : []),
          ...(entry.paths.length ? [`  - paths: ${entry.paths.map((item) => `\`${oneLine(item)}\``).join(", ")}`] : []),
          ...entry.evidence.map(
            (item) =>
              `  - ${new Date(item.createdAt).toISOString().slice(0, 10)} | ${item.type}${item.quote ? `: "${oneLine(item.quote)}"` : ""}${item.command ? `: \`${oneLine(item.command)}\`` : ""}`,
          ),
        ]
      }),
      "",
    ]
  })
  const documents = file.documents.flatMap((document) => [
    `### ${oneLine(document.title)}`,
    "",
    `${document.format}${document.pages ? `, ${document.pages} pages` : ""}, ${document.origin}, ${document.visibility}, ${document.status}${document.version > 1 ? `, version ${document.version}` : ""}`,
    "",
    ...document.records.map(
      (record) =>
        `- **${record.id}** ${record.kind}${record.page ? ` (p.${record.page})` : ""}: ${oneLine(record.card)}`,
    ),
    "",
  ])
  return `${["# Vector memory", "", ...sections, ...(documents.length ? ["## Documents", "", ...documents] : [])].join("\n")}\n`
}

/** One entry an import would bring in. */
export type Incoming = {
  readonly kind: BrainSchema.LearnedKind
  readonly text: string
  readonly scope: BrainSchema.Scope
  readonly facet?: BrainSchema.Facet
  /** The files it is about, so it is recalled for them alone as before. */
  readonly paths?: readonly string[]
  /** It was withheld where a private document is (see `Entry.private`), and stays so once imported. */
  readonly private?: boolean
}

/**
 * What an import file holds that Vector may bring in: preferences, decisions, lessons, facts and terms, from a JSON
 * export or a Markdown one (or any Markdown list under the same headings). Rules, MEMORY.md lines, past failures and
 * review notes live in files of their own or in Vector's checks, so they are left out, as is anything already left out
 * of use (archived or replaced).
 */
export function parse(text: string): Incoming[] {
  const json = Schema.decodeUnknownOption(Schema.fromJsonString(File))(text.trim())
  return Option.isSome(json) ? fromJson(json.value) : fromMarkdown(text)
}

/** A learned skill an import would bring in, through BrainSkill's gate. */
export type IncomingSkill = {
  readonly name: string
  readonly description: string
  readonly procedure: string
  readonly checks: readonly string[]
  readonly commands: readonly string[]
  readonly paths: readonly string[]
  readonly private?: boolean
}

/**
 * The learned skills an import file holds that Vector may bring in: those in use or waiting, from a JSON export or a
 * Markdown one (`### name`, its description, its checks, commands and paths, then its steps in a fenced block).
 */
export function skills(text: string): IncomingSkill[] {
  const json = Schema.decodeUnknownOption(Schema.fromJsonString(File))(text.trim())
  if (Option.isNone(json)) return skillsFromMarkdown(text)
  return [...json.value.entries, ...(json.value.skills ?? [])].flatMap((entry) =>
    entry.kind === "skill" && entry.skill && (entry.status === "active" || entry.status === "proposed")
      ? [
          {
            name: entry.skill.name,
            description: entry.skill.description,
            procedure: entry.skill.procedure,
            checks: entry.skill.checks,
            commands: entry.skill.commands,
            paths: entry.paths,
            ...(entry.private ? { private: true } : {}),
          },
        ]
      : [],
  )
}

/** What an import did: the entries it brought in, all waiting for approval, and what it left out. */
export type Imported = {
  readonly entries: readonly BrainSchema.Entry[]
  /** Entries already in memory, the same words. */
  readonly known: number
  /** Entries the brain refused: forgotten, secret, too long, not a term, or past what may wait for review. */
  readonly refused: number
  /** Entries past LIMIT.entries, which one import does not bring in. */
  readonly over: number
}

/**
 * Imports a file's entries into the brain, each one waiting for the user's approval, with the files it is about and
 * its private mark. An import never makes anything less private: an entry it holds again is left as it is, and a pin
 * is the user's to give again once they approve it, so a changed file cannot put a line in every request.
 */
export const importText = Effect.fn("BrainExport.importText")(function* (input: {
  readonly brain: Brain.Interface
  readonly place: Brain.Place
  readonly text: string
  /** Learned skills are imported when given; each waits for review, and an unsafe command refuses it. */
  readonly skills?: BrainSkill.Interface
}) {
  const all = parse(input.text)
  const learned = input.skills
  const drafts = learned ? skills(input.text) : []
  const results = yield* Effect.forEach(all.slice(0, LIMIT.entries), (item) =>
    input.brain.propose(input.place, {
      kind: item.kind,
      text: item.text,
      scope: item.scope,
      ...(item.facet ? { facet: item.facet } : {}),
      ...(item.paths?.length ? { paths: item.paths } : {}),
      ...(item.private ? { private: true } : {}),
      origin: "import",
      evidence: { type: "user" },
    }),
  )
  const imported = learned
    ? yield* Effect.forEach(drafts, (skill) =>
        learned.propose(
          input.place,
          {
            key: skill.name.slice(BrainSkill.PREFIX.length),
            name: skill.name,
            description: skill.description,
            procedure: skill.procedure,
            checks: skill.checks,
            commands: skill.commands,
            paths: skill.paths,
            drafter: "rules",
          },
          { origin: "import", evidence: { type: "user" }, ...(skill.private ? { private: true } : {}) },
        ),
      )
    : []
  const every = [...results, ...imported]
  const entries = every.flatMap((result) => (result.type === "added" || result.type === "held" ? [result.entry] : []))
  return {
    entries,
    known: every.filter((result) => result.type === "merged" || result.type === "promoted").length,
    refused: every.filter((result) => result.type === "refused").length,
    over: Math.max(0, all.length - LIMIT.entries),
  } satisfies Imported
})

// --- Brain Vault restore (contract A43) -------------------------------------------------------------------------------
//
// A vault backup is the person's own memory, sealed on their computer with their vault key and opened with it, so its
// restore is trusted where a file import is not: what was in use comes back in use, what waited for review waits
// again, and pins stay. It still goes entry by entry through the brain's own writes, never by copying brain.db (whose
// migrations have no forward guard), so the brain's checks for secrets, forgotten entries and its per-scope limits
// apply, and an entry already in memory is left as this computer has it. A file of more than LIMIT.entries or
// LIMIT.text is restored in batches of that size instead of being cut short.

/** The export versions a vault restore reads. A newer one is refused (`minReader` normally refuses it first). */
export const RESTORE_VERSIONS: readonly number[] = [1]

/** A memory file from a vault backup, when it is JSON of a version this build restores. */
export function decodeBackup(text: string): File | undefined {
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  const version = (parsed as { version?: unknown } | undefined)?.version
  if (typeof version !== "number" || !RESTORE_VERSIONS.includes(version)) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(File)(parsed))
}

/** The entries of `file` a restore brings back: learned kinds, not mirrored from a file, in use or waiting. */
function restorable(file: File) {
  return file.entries.filter(
    (entry) =>
      IMPORTED.has(entry.kind) &&
      !entry.file &&
      (entry.status === "active" || entry.status === "proposed" || entry.status === "quarantined"),
  )
}

/** `items` in order, cut into batches of at most LIMIT.entries entries and LIMIT.text characters of JSON each. */
export function batches<T>(items: readonly T[], size: (item: T) => number = (item) => JSON.stringify(item).length) {
  const out: T[][] = []
  let current: T[] = []
  let length = 0
  for (const item of items) {
    const next = size(item)
    if (current.length > 0 && (current.length >= LIMIT.entries || length + next > LIMIT.text)) {
      out.push(current)
      current = []
      length = 0
    }
    current.push(item)
    length += next
  }
  if (current.length) out.push(current)
  return out
}

/** What a vault restore did with one memory file. */
export type Restored = {
  /** Entries brought back, and of them those in use, pinned, and waiting for review as they were. */
  readonly restored: number
  readonly active: number
  readonly pinned: number
  readonly waiting: number
  /** Entries already in memory here, left as they are. */
  readonly known: number
  /** Entries the brain refused: forgotten here, a secret, or past what may wait for review. */
  readonly refused: number
  readonly batches: number
}

/**
 * Restores a memory file from the person's own vault into `place`'s repository (or their personal memory). `trust`
 * names the one source that may restore approval and pins: a vault backup that opened with the vault key.
 */
export const restore = Effect.fn("BrainExport.restore")(function* (input: {
  readonly brain: Brain.Interface
  readonly place: Brain.Place
  readonly file: File
  readonly trust: "vault"
}) {
  const counts = { restored: 0, active: 0, pinned: 0, waiting: 0, known: 0, refused: 0 }
  const parts = batches(restorable(input.file))
  for (const part of parts) {
    for (const item of part) {
      const result = yield* input.brain.propose(input.place, {
        kind: item.kind as BrainSchema.LearnedKind,
        text: item.text,
        scope: item.scope,
        ...(item.facet ? { facet: item.facet } : {}),
        ...(item.paths.length ? { paths: item.paths } : {}),
        ...(item.private ? { private: true } : {}),
        origin: "import",
        evidence: { type: "user" },
      })
      if (result.type === "refused") {
        counts.refused++
        continue
      }
      if (result.type !== "added" && result.type !== "held") {
        counts.known++
        continue
      }
      counts.restored++
      // Approved at once, entry by entry, so what was in use never fills the review queue's import limit.
      const approve = item.status === "active"
      const change: Brain.Change = {
        ...(item.pinned ? { pinned: true } : {}),
        ...(approve ? { action: "approve" as const } : {}),
      }
      const updated =
        item.pinned || approve ? yield* input.brain.update(input.place, result.entry.id, change, "user") : undefined
      const entry = updated && updated.type !== "refused" ? updated.entry : result.entry
      if (entry.status === "active") counts.active++
      else counts.waiting++
      if (entry.pinned) counts.pinned++
    }
  }
  return { ...counts, batches: parts.length } satisfies Restored
})

const KINDS: readonly BrainSchema.Kind[] = [
  "rule",
  "preference",
  "term",
  "decision",
  "lesson",
  "fact",
  "failure",
  "review",
  "skill",
]

const HEADINGS: Record<BrainSchema.Kind, string> = {
  rule: "Rules",
  preference: "Preferences",
  term: "Terms",
  decision: "Decisions",
  lesson: "Lessons",
  fact: "Facts",
  failure: "Failures",
  review: "Reviews",
  skill: "Skills",
}

const IMPORTED: ReadonlySet<string> = new Set(BrainSchema.LearnedKind.literals)

function fromJson(file: File): Incoming[] {
  return file.entries.flatMap((entry) =>
    IMPORTED.has(entry.kind) && !entry.file && (entry.status === "active" || entry.status === "proposed")
      ? [
          {
            kind: entry.kind as BrainSchema.LearnedKind,
            text: entry.text,
            scope: entry.scope,
            ...(entry.facet ? { facet: entry.facet } : {}),
            ...(entry.paths.length ? { paths: entry.paths } : {}),
            ...(entry.private ? { private: true } : {}),
          },
        ]
      : [],
  )
}

// Markdown: a "## Preferences" (or Terms, Decisions, Lessons, Facts) heading, then one entry per top-level bullet,
// with the export's id and marks when it has them, "private" among them. An indented "paths:" bullet gives the files
// the entry above it is about; other indented bullets are evidence, and the rest is ignored.
function fromMarkdown(text: string): Incoming[] {
  const kinds = new Map(
    Object.entries(HEADINGS).map(([kind, heading]) => [heading.toLowerCase(), kind as BrainSchema.Kind]),
  )
  return text.split(/\r?\n/).reduce<{ kind?: BrainSchema.Kind; items: Incoming[]; open?: boolean; fence?: string }>(
    (state, line) => {
      // A skill's steps are a fenced block, whose headings and bullets are its own, never entries.
      const fence = fenced(state.fence, line)
      if (fence !== state.fence || state.fence) return { ...state, fence }
      const heading = /^##\s+(.+?)\s*$/.exec(line)
      if (heading) return { kind: kinds.get(heading[1]!.toLowerCase()), items: state.items }
      if (/^#\s/.test(line)) return { items: state.items }
      const paths = /^\s+[-*]\s+paths:\s+(.+?)\s*$/.exec(line)
      if (paths) {
        const last = state.items.at(-1)
        if (!state.open || !last) return state
        const files = [...paths[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean)
        return { ...state, items: [...state.items.slice(0, -1), { ...last, paths: [...(last.paths ?? []), ...files] }] }
      }
      const bullet = /^[-*]\s+(?:\*\*[^*\s]+\*\*\s+)?(.+?)(?:\s+_\(([^)]*)\)_)?\s*$/.exec(line)
      // A bullet left out leaves out what is indented below it too.
      if (bullet && (!state.kind || !IMPORTED.has(state.kind))) return { ...state, open: false }
      if (!bullet || !state.kind) return state
      const marks = (bullet[2] ?? "").split(",").map((mark) => mark.trim())
      if (marks.some((mark) => mark === "archived" || mark === "superseded" || mark === "quarantined"))
        return { ...state, open: false }
      const kind = state.kind as BrainSchema.LearnedKind
      const facet = marks.find((mark): mark is BrainSchema.Facet =>
        BrainLearn.FACETS.includes(mark as BrainSchema.Facet),
      )
      const scope = marks.includes("repository")
        ? ("repository" as const)
        : marks.includes("personal") || kind === "preference" || kind === "term"
          ? ("personal" as const)
          : ("repository" as const)
      return {
        kind: state.kind,
        open: true,
        items: [
          ...state.items,
          {
            kind,
            text: bullet[1]!,
            scope,
            ...(facet ? { facet } : {}),
            ...(marks.includes("private") ? { private: true } : {}),
          },
        ],
      }
    },
    { items: [] },
  ).items
}

// A skill in Markdown: its name (and status when not in use), its description, what it runs and touches, and its steps
// in a fence longer than any run of backticks they hold.
function skillMarkdown(entry: Item) {
  if (!entry.skill) return []
  const fence = "`".repeat(Math.max(3, ...[...entry.skill.procedure.matchAll(/`+/g)].map((run) => run[0].length + 1)))
  const list = (label: string, values: readonly string[]) =>
    values.length ? [`- ${label}: ${values.map((value) => `\`${oneLine(value)}\``).join(", ")}`] : []
  return [
    `### ${entry.skill.name}${entry.status === "active" ? "" : ` _(${entry.status})_`}`,
    "",
    oneLine(entry.skill.description),
    "",
    ...list("checks", entry.skill.checks),
    ...list("commands", entry.skill.commands),
    ...list("paths", entry.paths),
    "",
    `${fence}markdown`,
    entry.skill.procedure.trim(),
    fence,
    "",
  ]
}

// Skills under a "## Skills" heading of a Markdown export, read back. A skill's first fenced block is its steps.
function skillsFromMarkdown(text: string): IncomingSkill[] {
  type Open = {
    readonly name: string
    readonly description?: string
    readonly checks: readonly string[]
    readonly commands: readonly string[]
    readonly paths: readonly string[]
    readonly steps?: readonly string[]
  }
  type State = {
    readonly section: boolean
    readonly open?: Open
    readonly fence?: string
    readonly items: IncomingSkill[]
  }
  const done = (open: Open | undefined): IncomingSkill[] =>
    open?.description && open.steps
      ? [
          {
            name: open.name,
            description: open.description,
            procedure: open.steps.join("\n"),
            checks: open.checks,
            commands: open.commands,
            paths: open.paths,
          },
        ]
      : []
  const state = text.split(/\r?\n/).reduce<State>(
    (state, line) => {
      const fence = fenced(state.fence, line)
      if (state.fence) {
        if (!fence) return { ...state, fence }
        return state.open?.steps ? { ...state, open: { ...state.open, steps: [...state.open.steps, line] } } : state
      }
      if (fence)
        return {
          ...state,
          fence,
          ...(state.section && state.open && !state.open.steps ? { open: { ...state.open, steps: [] } } : {}),
        }
      const section = /^##\s+(.+?)\s*$/.exec(line)
      if (section)
        return { section: section[1]!.toLowerCase() === "skills", items: [...state.items, ...done(state.open)] }
      if (!state.section) return state
      const heading = /^###\s+(\S+)(?:\s+_\(([^)]*)\)_)?\s*$/.exec(line)
      if (heading)
        return {
          ...state,
          items: [...state.items, ...done(state.open)],
          // What was put away or held stays out, as an entry does.
          open: ["archived", "superseded", "quarantined"].includes(heading[2]?.trim() ?? "")
            ? undefined
            : { name: heading[1]!, checks: [], commands: [], paths: [] },
        }
      if (!state.open || state.open.steps || !line.trim()) return state
      const listed = /^[-*]\s+(checks|commands|paths):\s+(.+?)\s*$/.exec(line)
      if (listed)
        return {
          ...state,
          open: {
            ...state.open,
            [listed[1]!]: [...listed[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()),
          },
        }
      return state.open.description === undefined
        ? { ...state, open: { ...state.open, description: line.trim() } }
        : state
    },
    { section: false, items: [] },
  )
  return [...state.items, ...done(state.open)]
}

// The fence a line leaves open: one it opens, none once it closes the open one, or the open one unchanged.
function fenced(open: string | undefined, line: string) {
  const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
  if (!open) return marker
  return marker && line.trim() === marker && marker.startsWith(open) ? undefined : open
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
