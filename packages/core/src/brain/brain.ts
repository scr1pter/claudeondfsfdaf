export * as Brain from "./brain"

import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { Glob } from "../util/glob"
import { Token } from "../util/token"
import { BrainCard } from "./card"
import { BrainCredit } from "./credit"
import { BrainDatabase } from "./database"
import { BrainLearn } from "./learn"
import { BrainLexical } from "./lexical"
import { BrainParse } from "./parse"
import { BrainPaths } from "./paths"
import { BrainPrivate } from "./private"
import { BrainScan } from "./scan"
import { BrainSchema } from "./schema"
import { SkillStore } from "./skill-store"
import { ReviewStore } from "./review-store"
import {
  BrainAnchorTable,
  BrainCodeFileTable,
  BrainCodeLiteralTable,
  BrainCodeSymbolTable,
  BrainDocumentTable,
  BrainEdgeTable,
  BrainEntryTable,
  BrainEventTable,
  BrainEvidenceTable,
  BrainItemTable,
  BrainJobTable,
  BrainPendingTable,
  BrainReviewTable,
  BrainSourceTable,
  BrainStateTable,
  BrainTermTable,
  BrainTombstoneTable,
  BrainUseTable,
  BrainVectorTable,
} from "./sql"

// The Vector brain: one local store for everything durable that steers the agent. Files people write stay theirs and
// are only ever read (repository and personal RULES.md, MEMORY.md, the legacy BRAIN.md); what Vector learns lives in
// brain.db on this computer. Everything on the request path is deterministic code over a few hundred entries, so it
// costs no model call and adds tokens only when something is relevant:
//
// - Tier 0, `digest`: rules, MEMORY.md (to its budget), pinned entries and one index line, byte-stable for a session so
//   the provider's prompt cache keeps it. Nothing at all when there is nothing to say.
// - Tier 1, `recall` once per request message and `attach` when a file is read: BM25 over entries, within a budget set
//   by the request's size; nothing when nothing scores.
// - Tier 2, `search` and `get`: the memory tool, when the agent decides to look.

export const LIMIT = {
  /** Characters of one entry the agent writes; a person may write more. */
  agent: 300,
  user: 1_000,
  /** Active learned entries per repository and for the personal scope; tidying archives the least used past this. */
  repository: 300,
  personal: 300,
  /** Writes the agent may make per request message, new entries and merges alike; past it, writes are refused. */
  perMessage: 3,
  /** Entries waiting for review (proposed or held) that one session may leave, and that one scope may hold. */
  pendingPerSession: 50,
  pending: 200,
  /** Imported entries waiting for review in one scope, counted apart from the rest: a whole export's worth. */
  imported: 500,
  /** Bytes read from one mirrored file. */
  file: 256 * 1024,
  /** Evidence rows and history events one entry keeps, newest first. */
  evidence: 20,
  events: 30,
  /** Archived learned entries kept per repository and for the personal scope; tidying deletes the oldest past this. */
  archived: 500,
} as const

export const BUDGET = {
  /** Tokens of MEMORY.md in the cached prefix; the rest of it is recalled when relevant. */
  memory: 800,
  /** Tokens of pinned entries in the cached prefix. */
  pinned: 300,
  /** Tokens attached when a file is read. */
  attach: 200,
  /** Characters of one search result set. */
  search: 1_200,
} as const

/**
 * Recalled memory as a request carries it; nothing at all for no lines. `newest` says that lines which may disagree
 * (an entry and a later correction of it) come newest first, so the model can tell which one is current. `documents`
 * says some lines are document cards, which the wrapper then calls data, never instructions.
 */
export function recallText(
  lines: readonly string[],
  options?: { readonly newest?: boolean; readonly documents?: boolean },
) {
  if (lines.length === 0) return ""
  return [
    "<vector_memory_recall>",
    `${options?.documents ? "Memory and documents" : "Memory"} that may bear on this request. Rules bind; the rest is advisory, so check it against the code${options?.newest ? ". Where two lines disagree, the first is newer" : ""}${options?.documents ? `. ${BrainCard.DOCUMENTS}` : ""}:`,
    ...lines,
    "</vector_memory_recall>",
  ].join("\n")
}

/**
 * Who a digest or how-you-work lines are for (section 6.4a). owner: an agent whose output stays in the session.
 * outward: a role whose output leaves the machine or reaches the web (Vectorscope's reviewers and its judge, research
 * workers), which gets how the owner works and nothing about them: no MEMORY.md, no fact, nothing learned beside a
 * private document, and decisions and lessons only when they pass the outward screen (BrainPrivate.screened).
 */
export type Audience = "owner" | "outward"

/**
 * Personal entries that say how the owner works, the review notes reviewers get besides, and the owner's terms, which a
 * role gets only when it is given them and its work names them.
 */
export type HabitKind = "preference" | "decision" | "lesson" | "review" | "term"
export const HABIT_KINDS: readonly HabitKind[] = ["preference", "decision", "lesson"]

/** The facets research works from (section 6.4): everything but the owner's tooling. */
export const RESEARCH_FACETS: readonly BrainSchema.Facet[] = ["format", "sources", "style", "vocabulary", "workflow"]

/** When the optional model learner runs: with Vector Local on (the default), with any model, or never. */
export type ModelLearner = "local-only" | "always" | "off"

/**
 * What Vector may learn on its own (section 7.4): at all, which facets, and whether a model may help; how it learns
 * skills and drafts them; and what it does with workflow insights.
 */
export type LearnSettings = {
  readonly learning: boolean
  readonly facets: Readonly<Record<BrainSchema.Facet, boolean>>
  readonly modelLearner: ModelLearner
  readonly skills: BrainSchema.SkillLearning
  readonly skillDrafter: BrainSchema.SkillDrafter
  readonly workflow: BrainSchema.WorkflowLearning
  readonly workflowExplore: boolean
}

/** Tokens of how-you-work lines a role gets, its wrapper counted: a subagent at every size, and a reviewer. */
export const HABITS = { subagent: 100, review: 300 } as const

/** Tokens recalled for a request of each size. A greeting recalls nothing. */
export function recallBudget(tier: "chat" | "light" | "standard" | "thorough") {
  return { chat: 0, light: 200, standard: 300, thorough: 500 }[tier]
}

export type Source = { readonly path: string; readonly type: "rules" | "brain" }

/** Where a request runs, as the brain needs it. Built by the engine from its instance. */
export type Place = {
  /** The repository's ID (shared by its worktrees and Parallel Workspaces), or a folder key outside git. */
  readonly repository: string
  /** The working tree's root, where its failure memory is keyed. */
  readonly root: string
  /** The repository's rules files and legacy BRAIN.md files found for this location. */
  readonly sources: readonly Source[]
  /** The repository has settings the user has not trusted, so memory it ships is held for review. */
  readonly held: boolean
}

export type Evidence =
  | { readonly type: "user" }
  | { readonly type: "message"; readonly quote: string; readonly verified: boolean }
  | {
      readonly type: "file"
      readonly path: string
      readonly quote: string
      readonly hash?: string
      readonly verified: boolean
    }
  | { readonly type: "check"; readonly command: string; readonly verified: boolean }
  /**
   * A quote from a document's record or passage, by its id. `verified`: the quote is that passage's own words, as
   * BrainKnowledge.quoted checks; the brain then checks it states the memory.
   */
  | { readonly type: "document"; readonly path: string; readonly quote: string; readonly verified: boolean }
  /**
   * A run that turned a check green, for a learned skill: the check, and the request it ran for. `verified`: the engine
   * saw the check fail and then pass in that run.
   */
  | { readonly type: "run"; readonly command: string; readonly requestID: string; readonly verified: boolean }

export type Proposal = {
  readonly kind: BrainSchema.LearnedKind
  readonly text: string
  readonly scope: BrainSchema.Scope
  readonly paths?: readonly string[]
  readonly evidence?: Evidence
  /** The entry this one replaces. */
  readonly supersedes?: string
  /** import: read from a file the user imported, so it waits for their approval however it reads. */
  readonly origin: "agent" | "user" | "import"
  /** What a preference or a term is about; a preference's words choose it when absent, and a term is vocabulary. */
  readonly facet?: BrainSchema.Facet
  /**
   * Write it waiting rather than in use. sighting: Vector's learner read it in a long message, so the same words seen
   * again in another session put it in use. review: a model suggested it in a session that read outside content, so
   * only the user puts it in use.
   */
  readonly pending?: "sighting" | "review"
  /**
   * Vector's learner (section 6.3) read it in what the owner typed in a top-level session, or the owner ticked it on a
   * plan card, which only the engine's end-of-request learner and the plan card say. Such a write is personal only when
   * it names nothing of one repository, in the first person or not, so an instruction about how they work anywhere
   * ("always use tables") is personal without a first-person quote and "I prefer Acme's numbers" stays with its
   * repository; its quote is checked against what the owner took back as well as its text. The memory tool's writes
   * never are: a subagent's quote comes from the task its launching agent wrote.
   */
  readonly learner?: boolean
  readonly sessionID?: string
  /** Entries this session's current request message may still make active, counted by the caller. */
  readonly since?: number
  /** Why the caller holds this write for review: the session read untrusted content, or a guest drove it. */
  readonly hold?: BrainSchema.Hold
  /** The session read a private document, so this is withheld where the document is (see `Entry.private`). */
  readonly private?: boolean
}

export type Refusal =
  | "secret"
  | "forgotten"
  | "empty"
  | "too-long"
  | "learning-off"
  | "file-entry"
  | "user-entry"
  | "not-found"
  | "limit"
  | "put-away"
  | "not-a-term"
  /** A learned skill, which only Settings > Memory > Skills and `vector memory skills` change. */
  | "skill-entry"
  /** A learned skill names a command outside its allow lists, or text a skill may not hold. */
  | "unsafe-command"

export type WriteResult =
  | {
      readonly type: "added" | "merged" | "promoted" | "held"
      readonly entry: BrainSchema.Entry
      /** An entry in use that shares most of these words: possibly the one this corrects, which only an update replaces. */
      readonly related?: BrainSchema.Entry
    }
  | { readonly type: "superseded"; readonly entry: BrainSchema.Entry; readonly previous: string }
  | { readonly type: "refused"; readonly reason: Refusal; readonly message: string }

export type Change = {
  readonly text?: string
  readonly pinned?: boolean
  /** Files a preference or a term under another facet. */
  readonly facet?: BrainSchema.Facet
  /** undo: the user takes back what Vector learned. It is put away as theirs to bring back, and not learned again. */
  readonly action?: "approve" | "reject" | "archive" | "restore" | "undo"
}

/** learned: what the agent put in use on its own, newest first, for Settings > Memory's Recently learned. */
export type Filter = "active" | "review" | "archived" | "all" | "learned"

export type Detail = {
  readonly entry: BrainSchema.Entry
  readonly evidence: readonly BrainSchema.Evidence[]
  readonly related: readonly BrainSchema.Entry[]
}

export type Injection = {
  readonly text?: string
  readonly ids: readonly string[]
  readonly tokens: number
  /** Which of `ids` are the user's personal memory (recall and the digest). */
  readonly personal?: readonly string[]
  /** Recall only: the text without personal memory, which is all a session's saved transcript may keep. */
  readonly shared?: string
  /** Recall only: lines that may disagree come newest first, and the text says so. */
  readonly newest?: boolean
}

/** An entry that bears on a request, as recall scored it and before any budget: what documents compete with. */
export type Candidate = {
  readonly id: string
  /** The line recall sends for it. */
  readonly line: string
  readonly score: number
  /** Request terms it shares. */
  readonly matched: readonly string[]
  /** One of its file patterns covers a file the request names. */
  readonly path: boolean
  readonly personal: boolean
  readonly origin: BrainSchema.Origin
  readonly confidence: number
  readonly updatedAt: number
  readonly terms: ReadonlyMap<string, number>
  /** Proven knowledge (BrainCredit.proven): runs that cited it and passed weigh it up, already in `score`. */
  readonly proven: number
}

/** Where a use of memory went: the request it reached, by tier, for outcome credit. */
export type Use = {
  readonly sessionID?: string
  readonly requestID?: string
  readonly tier: "recall" | "brief" | "review"
  readonly tokens: number
}

export type Stats = {
  readonly active: number
  readonly review: number
  readonly archived: number
  readonly rules: number
  readonly learned: number
  readonly digestTokens: number
  readonly learning: boolean
  /** Learned skills of the repository in use and waiting for review, which the counts above leave out. */
  readonly skills: { readonly active: number; readonly review: number }
}

export type Consolidation = {
  readonly skipped: boolean
  readonly merged: number
  /** Always 0: tidying never puts anything in use. Kept for clients that show it. */
  readonly promoted: number
  readonly archived: number
  readonly dropped: number
  readonly stale: number
}

export interface Interface {
  readonly sync: (place: Place) => Effect.Effect<void>
  /** `documents`: the line about the repository's documents, which goes in with the memory index. */
  readonly digest: (
    place: Place,
    options: {
      readonly personal: boolean
      readonly index: boolean
      readonly documents?: string
      /** outward: no MEMORY.md, no pinned fact or private entry, and pinned decisions and lessons screened. */
      readonly audience?: Audience
      /**
       * outward only: the owner's own pinned kinds it keeps besides their rules, all by default. A reviewer of a pull
       * request Vector cannot trust keeps their preferences only (6.4a).
       */
      readonly kinds?: readonly HabitKind[]
      /** outward only: of the owner's pinned preferences and terms, only those of these facets. */
      readonly facets?: readonly BrainSchema.Facet[]
    },
  ) => Effect.Effect<Injection>
  /**
   * How the owner works, for an agent beside the main one (section 6.4a): their own personal entries of `kinds`, never
   * a fact, a MEMORY.md line or a pinned entry (the digest carries those). Lines that bear on `query` or cover one of
   * `files` come first, then what the owner said in general; a line scoped to other files stays out, and so does a term
   * `query` does not name. `budget` counts the lines as `wrap` renders them (recallText by default). outward: every line
   * passes the outward screen. `facets`: of preferences and terms, only those of these facets.
   */
  readonly habits: (
    place: Place,
    input: {
      readonly query: string
      readonly files?: readonly string[]
      readonly budget: number
      readonly audience: Audience
      readonly kinds: readonly HabitKind[]
      readonly facets?: readonly BrainSchema.Facet[]
      readonly exclude?: ReadonlySet<string>
      readonly wrap?: (lines: readonly string[]) => string
      readonly sessionID?: string
      readonly requestID?: string
      /** Where the use is counted: a subagent's brief, or a review. */
      readonly tier: "brief" | "review"
    },
  ) => Effect.Effect<Injection>
  /**
   * What the posting check compares a post with (BrainPosting): how the owner works (personal rules, preferences,
   * decisions, lessons, past failures and review notes) and private facts (MEMORY.md, personal facts, and entries
   * learned beside a private document here), whoever they reached, plus the document cards recalled in `sessionIDs`.
   */
  readonly posting: (
    place: Place,
    input: { readonly sessionIDs: readonly string[] },
  ) => Effect.Effect<{
    readonly habits: readonly string[]
    readonly facts: readonly string[]
    readonly cards: readonly string[]
  }>
  /** The scoring half of recall: entries that bear on a request, best first, before any budget. */
  readonly candidates: (
    place: Place,
    input: {
      readonly query: string
      readonly files?: readonly string[]
      readonly personal: boolean
      readonly exclude?: ReadonlySet<string>
    },
  ) => Effect.Effect<readonly Candidate[]>
  /** Counts entries as sent to a session, as recall does for what it sends. */
  readonly used: (ids: readonly string[], input: Use) => Effect.Effect<void>
  /**
   * Proven knowledge for entries: `helpful` runs that cited them and passed (negative for one the user reverted since).
   * The count never goes below zero, and an entry never gets `harmful` from a run, only from the user.
   */
  readonly credit: (ids: readonly string[], helpful: number) => Effect.Effect<void>
  readonly recall: (
    place: Place,
    input: {
      readonly query: string
      readonly files?: readonly string[]
      readonly budget: number
      readonly personal: boolean
      readonly exclude?: ReadonlySet<string>
      readonly sessionID?: string
      /** The request message it is for, so outcome credit can find what reached it. */
      readonly requestID?: string
      /** Where the use is counted: a request's recall, or a subagent's brief. */
      readonly tier?: "recall" | "brief"
    },
  ) => Effect.Effect<Injection>
  readonly attach: (
    place: Place,
    input: {
      readonly file: string
      readonly personal: boolean
      readonly exclude?: ReadonlySet<string>
      readonly sessionID?: string
    },
  ) => Effect.Effect<Injection>
  readonly search: (
    place: Place,
    input: { readonly query: string; readonly personal: boolean; readonly limit?: number; readonly sessionID?: string },
  ) => Effect.Effect<BrainSchema.Entry[]>
  readonly get: (place: Place, id: string, options: { readonly personal: boolean }) => Effect.Effect<Detail | undefined>
  /** Active entries as recall shows them, by id, for a request that fills recalled memory back in. */
  readonly lines: (
    place: Place,
    ids: readonly string[],
    options: { readonly personal: boolean },
  ) => Effect.Effect<ReadonlyMap<string, string>>
  readonly list: (
    place: Place,
    input: { readonly filter?: Filter; readonly query?: string; readonly scope?: BrainSchema.Scope },
  ) => Effect.Effect<BrainSchema.Entry[]>
  readonly propose: (place: Place, proposal: Proposal) => Effect.Effect<WriteResult>
  /** Owner-click review context only. Ordinary learned proposals cannot write this kind or choose this origin. */
  readonly dismissReview: (
    place: Place,
    input: { readonly text: string; readonly paths: readonly string[]; readonly sessionID: string },
  ) => Effect.Effect<WriteResult>
  readonly update: (
    place: Place,
    id: string,
    change: Change,
    actor: "user" | "agent",
  ) => Effect.Effect<WriteResult | undefined>
  readonly forget: (place: Place, id: string) => Effect.Effect<"forgotten" | "not-found" | "file-entry">
  readonly erase: (place: Place, scope: BrainSchema.Scope | "all") => Effect.Effect<number>
  readonly consolidate: (place: Place, options?: { readonly force?: boolean }) => Effect.Effect<Consolidation>
  readonly stats: (place: Place) => Effect.Effect<Stats>
  readonly learning: () => Effect.Effect<boolean>
  readonly setLearning: (enabled: boolean) => Effect.Effect<void>
  /** What Vector may learn on its own: learning at all, each facet, and the model learner. */
  readonly learnSettings: () => Effect.Effect<LearnSettings>
  readonly setLearnSettings: (change: {
    readonly learning?: boolean
    readonly facets?: Partial<Record<BrainSchema.Facet, boolean>>
    readonly modelLearner?: ModelLearner
    readonly skills?: BrainSchema.SkillLearning
    readonly skillDrafter?: BrainSchema.SkillDrafter
    readonly workflow?: BrainSchema.WorkflowLearning
    readonly workflowExplore?: boolean
  }) => Effect.Effect<LearnSettings>
  /**
   * "Erase what Vector learned in this session": forgets every entry Vector learned whose only evidence is that session,
   * so it is not learned again either. What the user wrote and what other sessions also taught stay. Returns the count.
   */
  readonly eraseSession: (place: Place, sessionID: string) => Effect.Effect<number>
  /** How many writes this session's agent made since `since`, new entries and merges alike, for the per-message cap. */
  readonly written: (sessionID: string, since: number) => Effect.Effect<number>
  /** The user's own memory and rules files, which the brain reads and never writes. */
  readonly files: () => { readonly memory: string; readonly rules: string }
}

export class Service extends Context.Service<Service, Interface>()("@vector/Brain") {}

type Row = typeof BrainEntryTable.$inferSelect
type Transaction = Parameters<Parameters<BrainDatabase.Database["transaction"]>[0]>[0]

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const PERSONAL = ""
const LEARNED: readonly BrainSchema.Origin[] = ["agent", "user", "import"]

const build = (input: { readonly data?: string; readonly config?: string }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const database = yield* BrainDatabase.Service
      return make(database.db, { data: input.data ?? global.data, config: input.config ?? global.config })
    }),
  )

/** The brain over the process's one brain.db, which document knowledge shares. */
export const layer = build({})

/** A brain over its own database file (":memory:" in tests), with its own data and config folders when given. */
export const layerFor = (input: { readonly file: string; readonly data?: string; readonly config?: string }) =>
  build(input).pipe(Layer.provide(BrainDatabase.layerFor(input.file)))

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [BrainDatabase.node, Global.node],
})

function make(db: BrainDatabase.Database, dirs: { readonly data: string; readonly config: string }): Interface {
  const personalFiles = {
    memory: path.join(dirs.config, "MEMORY.md"),
    rules: path.join(dirs.config, "RULES.md"),
  }
  const failureFile = (place: Place) => BrainPaths.failureFile(dirs.data, place.root)
  const repositoryFiles = (place: Place) => [...place.sources.map((source) => source.path), failureFile(place)]

  // What one place may see: its repository's learned entries and the mirrors of its own working tree's files (another
  // worktree's RULES.md may differ), plus the user's own rules always and their personal memory when allowed. What was
  // learned from a private document goes where personal memory goes.
  const visible = (place: Place, personal: boolean) =>
    or(
      and(
        eq(BrainEntryTable.repository_id, place.repository),
        or(isNull(BrainEntryTable.source_file), inArray(BrainEntryTable.source_file, repositoryFiles(place))),
        personal ? undefined : eq(BrainEntryTable.private, false),
      ),
      personal
        ? eq(BrainEntryTable.repository_id, PERSONAL)
        : and(eq(BrainEntryTable.repository_id, PERSONAL), eq(BrainEntryTable.kind, "rule")),
    )

  const bump = (repository: string) =>
    db
      .insert(BrainStateTable)
      .values({ repository_id: repository, revision: 1 })
      .onConflictDoUpdate({
        target: BrainStateTable.repository_id,
        set: { revision: sql`${BrainStateTable.revision} + 1` },
      })
      .run()
      .pipe(Effect.orDie)

  const event = (
    row: Pick<Row, "id" | "repository_id">,
    action: string,
    actor: "user" | "agent" | "vector",
    detail?: Record<string, unknown>,
  ) =>
    db
      .insert(BrainEventTable)
      .values({ entry_id: row.id, repository_id: row.repository_id, at: Date.now(), action, actor, detail })
      .run()
      .pipe(Effect.orDie)

  // --- Mirrors of files -------------------------------------------------------------------------------------------

  type Mirror = {
    readonly path: string
    readonly repository: string
    readonly scope: BrainSchema.Scope
    readonly type: "rules" | "memory" | "brain" | "failures"
    readonly held: boolean
    /** A repository's own file: a link is followed only where it lands inside this working tree. */
    readonly root?: string
  }

  const mirrors = (place: Place): Mirror[] => [
    { path: personalFiles.rules, repository: PERSONAL, scope: "personal", type: "rules", held: false },
    { path: personalFiles.memory, repository: PERSONAL, scope: "personal", type: "memory", held: false },
    ...place.sources.map((source) => ({
      path: source.path,
      repository: place.repository,
      scope: "repository" as const,
      type: source.type,
      // A repository's own rules load as its instructions do. Memory it ships is held until the repository is trusted.
      held: source.type === "brain" && place.held,
      root: place.root,
    })),
    { path: failureFile(place), repository: place.repository, scope: "repository", type: "failures", held: false },
  ]

  const mirror = Effect.fnUntraced(function* (source: Mirror) {
    const stat = yield* Effect.promise(() => statFollowing(source))
    const known = yield* db
      .select()
      .from(BrainSourceTable)
      .where(eq(BrainSourceTable.path, source.path))
      .get()
      .pipe(Effect.orDie)
    if (!stat || !stat.isFile()) {
      if (!known) return
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(BrainEntryTable).where(eq(BrainEntryTable.source_file, source.path)).run()
            yield* tx.delete(BrainSourceTable).where(eq(BrainSourceTable.path, source.path)).run()
          }),
        )
        .pipe(Effect.orDie)
      return yield* bump(source.repository)
    }
    const mtime = Math.round(stat.mtimeMs)
    if (known && known.size === stat.size && known.mtime === mtime && known.held === source.held) return
    const content = yield* Effect.promise(() =>
      fs
        .open(source.path, "r")
        .then(async (handle) => {
          const buffer = Buffer.alloc(Math.min(stat.size, LIMIT.file))
          await handle.read(buffer, 0, buffer.length, 0).finally(() => handle.close())
          return buffer.toString("utf8")
        })
        .catch(() => ""),
    )
    const hash = createHash("sha256").update(content).digest("hex")
    if (known && known.content_hash === hash && known.held === source.held) {
      yield* db
        .update(BrainSourceTable)
        .set({ size: stat.size, mtime, synced_at: Date.now() })
        .where(eq(BrainSourceTable.path, source.path))
        .run()
        .pipe(Effect.orDie)
      return
    }
    const items = parse(source, content)
    const existing = new Map(
      (yield* db
        .select()
        .from(BrainEntryTable)
        .where(eq(BrainEntryTable.source_file, source.path))
        .all()
        .pipe(Effect.orDie)).map((row) => [row.id, row]),
    )
    const now = Date.now()
    const rows = dedupe(items).map((item) => {
      const id = fileId(source.path, item.signature ?? item.text)
      const previous = existing.get(id)
      const hold = itemHold(source, item)
      // The same text keeps the same id, so a person's approval of an instruction-like line survives later reads.
      const approved = previous?.status === "active" && previous.hold_reason === null && hold === "instruction-like"
      const status: BrainSchema.Status = hold && !approved ? "quarantined" : "active"
      return {
        id,
        scope: source.scope,
        repository_id: source.repository,
        kind: item.kind,
        origin: source.type === "failures" ? ("failure-memory" as const) : ("file" as const),
        status,
        pinned: previous?.pinned ?? false,
        // A key pasted into MEMORY.md or a rules file is not sent on to a provider either.
        body: BrainScan.redact(BrainScan.stripHidden(item.text)).text,
        paths: [...item.paths],
        terms: encode(BrainLexical.terms([item.heading ?? "", item.text, ...item.paths].join(" "))),
        norm_hash: normHash(item.text),
        confidence: 1,
        uses: previous?.uses ?? 0,
        helpful: previous?.helpful ?? 0,
        harmful: previous?.harmful ?? 0,
        last_used_at: previous?.last_used_at ?? null,
        created_at: previous?.created_at ?? now,
        updated_at: previous && previous.body === item.text ? previous.updated_at : now,
        superseded_by: null,
        stale: false,
        hold_reason: status === "quarantined" ? hold! : null,
        related: [],
        tier0: false,
        source_file: source.path,
        source_line: item.line,
        origin_session_id: null,
        signature: item.signature ?? null,
        private: false,
        // A file's preference is filed by its words when read (facetOf).
        facet: null,
        term_key: null,
      } satisfies Row
    })
    const rendered = render(source, content, rows)
    const digest = rendered?.text ? { ...rendered, text: BrainScan.redact(rendered.text).text } : rendered
    const tier0 = new Set(digest?.ids ?? [])
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const value = { ...row, tier0: tier0.has(row.id) }
            yield* tx
              .insert(BrainEntryTable)
              .values(value)
              .onConflictDoUpdate({ target: BrainEntryTable.id, set: value })
              .run()
          }
          yield* tx
            .delete(BrainEntryTable)
            .where(
              rows.length
                ? and(
                    eq(BrainEntryTable.source_file, source.path),
                    notInArray(
                      BrainEntryTable.id,
                      rows.map((row) => row.id),
                    ),
                  )
                : eq(BrainEntryTable.source_file, source.path),
            )
            .run()
          const record = {
            path: source.path,
            repository_id: source.repository,
            content_hash: hash,
            size: stat.size,
            mtime,
            held: source.held,
            digest: digest?.text ?? null,
            synced_at: now,
          }
          yield* tx
            .insert(BrainSourceTable)
            .values(record)
            .onConflictDoUpdate({ target: BrainSourceTable.path, set: record })
            .run()
        }),
      )
      .pipe(Effect.orDie)
    yield* bump(source.repository)
  })

  const sync = Effect.fn("Brain.sync")(function* (place: Place) {
    yield* Effect.forEach(mirrors(place), mirror, { discard: true })
  })

  // --- Reading ----------------------------------------------------------------------------------------------------

  const visibleRows = Effect.fnUntraced(function* (
    place: Place,
    personal: boolean,
    statuses: readonly BrainSchema.Status[],
  ) {
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(and(visible(place, personal), inArray(BrainEntryTable.status, [...statuses])))
      .all()
      .pipe(Effect.orDie)
  })

  const used = Effect.fnUntraced(function* (
    ids: readonly string[],
    sessionID: string | undefined,
    tier: "digest" | "recall" | "attach" | "search" | "brief" | "review",
    tokens: number,
    requestID?: string,
  ) {
    if (ids.length === 0) return
    const now = Date.now()
    yield* db
      .update(BrainEntryTable)
      .set({ uses: sql`${BrainEntryTable.uses} + 1`, last_used_at: now })
      .where(inArray(BrainEntryTable.id, [...ids]))
      .run()
      .pipe(Effect.orDie)
    if (!sessionID) return
    yield* db
      .insert(BrainUseTable)
      .values(
        ids.map((id) => ({
          session_id: sessionID,
          entry_id: id,
          tier,
          tokens: Math.round(tokens / ids.length),
          at: now,
          request_id: requestID ?? null,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })

  const credit = Effect.fn("Brain.credit")(function* (ids: readonly string[], helpful: number) {
    if (ids.length === 0 || helpful === 0) return
    yield* db
      .update(BrainEntryTable)
      .set({ helpful: sql`max(0, ${BrainEntryTable.helpful} + ${helpful})` })
      .where(inArray(BrainEntryTable.id, [...ids]))
      .run()
      .pipe(Effect.orDie)
  })

  const digest = Effect.fn("Brain.digest")(function* (
    place: Place,
    options: {
      personal: boolean
      index: boolean
      documents?: string
      audience?: Audience
      kinds?: readonly HabitKind[]
      facets?: readonly BrainSchema.Facet[]
    },
  ) {
    yield* sync(place)
    const outward = options.audience === "outward"
    const kinds = new Set<string>(["rule", ...(options.kinds ?? [...HABIT_KINDS, "failure"])])
    const facets = options.facets ? new Set(options.facets) : undefined
    const paths = [
      personalFiles.rules,
      ...place.sources.filter((source) => source.type === "rules").map((source) => source.path),
      ...(options.personal && !outward ? [personalFiles.memory] : []),
    ]
    const sources = new Map(
      (yield* db
        .select()
        .from(BrainSourceTable)
        .where(inArray(BrainSourceTable.path, paths))
        .all()
        .pipe(Effect.orDie)).map((row) => [row.path, row]),
    )
    // An outward role hears how the owner works, never about them: no MEMORY.md item, no fact and nothing learned
    // beside a private document, only the decisions, lessons and past failures with nothing particular in them, and of
    // the owner's own entries only the kinds (and facets) it was given.
    const rows = (yield* visibleRows(place, options.personal, ["active"])).filter(
      (row) =>
        !outward ||
        (row.source_file !== personalFiles.memory &&
          row.kind !== "fact" &&
          (row.repository_id !== PERSONAL || (kinds.has(row.kind) && inFacets(row, facets))) &&
          BrainPrivate.screened({ kind: row.kind, text: row.body, private: row.private })),
    )
    const pinned = rows
      .filter((row) => row.pinned && !row.tier0 && row.kind !== "review" && !row.stale)
      .toSorted((a, b) => a.created_at - b.created_at)
      .reduce<Row[]>(
        (kept, row) => (tokensOf(kept) + Token.estimate(line(row)) > BUDGET.pinned ? kept : [...kept, row]),
        [],
      )
    const shown = new Set([...rows.filter((row) => row.tier0).map((row) => row.id), ...pinned.map((row) => row.id)])
    const rest = rows.filter((row) => !shown.has(row.id) && row.kind !== "review" && row.kind !== "rule")
    const rules = paths
      .filter((file) => file !== personalFiles.memory)
      .flatMap((file) => {
        const text = sources.get(file)?.digest
        if (!text) return []
        return [
          `${file === personalFiles.rules ? "Your rules (RULES.md in your Vector settings)" : `Repository rules (${label(place, file)})`}:\n${text}`,
        ]
      })
    const memory = sources.get(personalFiles.memory)?.digest
    const advisory = Boolean(memory || pinned.length || rest.length)
    const sections = [
      ...rules,
      ...(memory ? [`What the user told you about themselves (MEMORY.md):\n${memory}`] : []),
      ...(pinned.length ? [`Pinned memory:\n${pinned.map(line).join("\n")}`] : []),
      ...(options.index && rest.length
        ? [
            `Vector also remembers ${rest.length} note${rest.length === 1 ? "" : "s"} about this work (lessons, decisions, facts, past failures); the memory tool searches them.`,
          ]
        : []),
      ...(options.documents ? [options.documents] : []),
    ]
    if (sections.length === 0) return { ids: [], tokens: 0 }
    const text = [
      "<vector_memory>",
      rules.length ? "Rules bind unless the user says otherwise now." : undefined,
      advisory ? "Memory is advisory: the current code and what the user says now win over it." : undefined,
      sections.join("\n\n"),
      "</vector_memory>",
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n")
    // Which of the entries shown are the owner's own (their rules, MEMORY.md and personal entries) or were learned
    // beside a private document, for Vector Local's count of what a request carries.
    const personal = rows
      .filter((row) => shown.has(row.id) && (row.repository_id === PERSONAL || row.private))
      .map((row) => row.id)
    return { text, ids: [...shown], tokens: Token.estimate(text), personal }
  })

  const recallable = Effect.fnUntraced(function* (place: Place, personal: boolean, exclude: ReadonlySet<string>) {
    return (yield* visibleRows(place, personal, ["active"])).filter(
      (row) => !row.tier0 && !row.pinned && !row.stale && row.kind !== "review" && !exclude.has(row.id),
    )
  })

  const candidates = Effect.fn("Brain.candidates")(function* (
    place: Place,
    input: { query: string; files?: readonly string[]; personal: boolean; exclude?: ReadonlySet<string> },
  ) {
    yield* sync(place)
    const rows = yield* recallable(place, input.personal, input.exclude ?? new Set())
    const files = (input.files ?? []).map((file) => BrainPaths.relative(place.root, file))
    const query = BrainLexical.terms([input.query, ...files].join(" "))
    const now = Date.now()
    const ranked = BrainLexical.rank(
      rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
      query,
    )
    const scored = new Map(ranked.map((item) => [item.id, item]))
    return rows
      .flatMap((row): Candidate[] => {
        const lexical = scored.get(row.id)
        const pathHit =
          row.paths.length > 0 && files.some((file) => row.paths.some((pattern) => matches(pattern, file)))
        // A term comes only to a request that names it, whatever else it shares, and then it leads: it says what the
        // request's own words mean.
        const named = row.kind === "term" && BrainLearn.names(input.query, row.term_key ?? "")
        // One shared word is noise in a long request; two, or the only word of a short one, is a topic.
        const relevant =
          row.kind === "term"
            ? named
            : pathHit ||
              (lexical !== undefined &&
                (lexical.matched.length >= 2 || (query.size <= 2 && lexical.matched.length >= 1)))
        if (!relevant) return []
        const recency = Math.max(0.5, 0.995 ** ((now - (row.last_used_at ?? row.updated_at)) / HOUR))
        const proven = BrainCredit.lift({ helpful: row.helpful, harmful: row.harmful, ignored: 0 }, row)
        return [
          {
            id: row.id,
            line: line(row),
            score: ((lexical?.score ?? 0) + (pathHit ? 5 : 0) + (named ? 10 : 0)) * row.confidence * recency * proven,
            matched: lexical?.matched ?? [],
            path: pathHit,
            personal: row.repository_id === PERSONAL || row.private,
            origin: row.origin,
            confidence: row.confidence,
            updatedAt: row.updated_at,
            terms: decode(row.terms),
            proven,
          },
        ]
      })
      .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  })

  const recall = Effect.fn("Brain.recall")(function* (
    place: Place,
    input: {
      query: string
      files?: readonly string[]
      budget: number
      personal: boolean
      exclude?: ReadonlySet<string>
      sessionID?: string
      requestID?: string
      tier?: "recall" | "brief"
    },
  ) {
    if (input.budget <= 0) return { ids: [], tokens: 0 }
    const picked = (yield* candidates(place, input))
      .slice(0, 5)
      // Counted as sent, with the longer header, so recall never passes its budget.
      .reduce<Candidate[]>(
        (kept, item) =>
          Token.estimate(
            recallText(
              [...kept, item].map((candidate) => candidate.line),
              { newest: true },
            ),
          ) > input.budget
            ? kept
            : [...kept, item],
        [],
      )
    if (picked.length === 0) return { ids: [], tokens: 0 }
    const { ordered, newest } = order(picked)
    const text = recallText(
      ordered.map((item) => item.line),
      { newest },
    )
    const tokens = Token.estimate(text)
    yield* used(
      ordered.map((item) => item.id),
      input.sessionID,
      input.tier ?? "recall",
      tokens,
      input.requestID,
    )
    return {
      text,
      ids: ordered.map((item) => item.id),
      tokens,
      personal: ordered.filter((item) => item.personal).map((item) => item.id),
      shared: recallText(
        ordered.filter((item) => !item.personal).map((item) => item.line),
        { newest },
      ),
      newest,
    }
  })

  const lines = Effect.fn("Brain.lines")(function* (
    place: Place,
    ids: readonly string[],
    options: { personal: boolean },
  ) {
    if (ids.length === 0) return new Map<string, string>()
    const rows = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          inArray(BrainEntryTable.id, [...ids]),
          visible(place, options.personal),
          eq(BrainEntryTable.status, "active"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return new Map(rows.map((row) => [row.id, line(row)]))
  })

  const attach = Effect.fn("Brain.attach")(function* (
    place: Place,
    input: { file: string; personal: boolean; exclude?: ReadonlySet<string>; sessionID?: string },
  ) {
    const file = BrainPaths.relative(place.root, input.file)
    if (file.startsWith("../")) return { ids: [], tokens: 0 }
    yield* sync(place)
    const rows = (yield* recallable(place, input.personal, input.exclude ?? new Set())).filter(
      (row) => row.paths.length > 0 && row.paths.some((pattern) => matches(pattern, file)),
    )
    const picked = rows
      .toSorted((a, b) => Number(b.kind === "rule") - Number(a.kind === "rule") || a.id.localeCompare(b.id))
      .reduce<Row[]>((kept, row) => (tokensOf([...kept, row]) > BUDGET.attach ? kept : [...kept, row]), [])
    if (picked.length === 0) return { ids: [], tokens: 0 }
    const text = [`Vector's memory for ${file} (rules bind; the rest is advisory):`, ...picked.map(line)].join("\n")
    const tokens = Token.estimate(text)
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "attach",
      tokens,
    )
    return { text, ids: picked.map((row) => row.id), tokens }
  })

  const habits = Effect.fn("Brain.habits")(function* (
    place: Place,
    input: {
      query: string
      files?: readonly string[]
      budget: number
      audience: Audience
      kinds: readonly HabitKind[]
      facets?: readonly BrainSchema.Facet[]
      exclude?: ReadonlySet<string>
      wrap?: (lines: readonly string[]) => string
      sessionID?: string
      requestID?: string
      tier: "brief" | "review"
    },
  ) {
    if (input.budget <= 0 || input.kinds.length === 0) return { ids: [], tokens: 0 }
    yield* sync(place)
    const exclude = input.exclude ?? new Set<string>()
    const facets = input.facets ? new Set(input.facets) : undefined
    const wrap = input.wrap ?? ((lines: readonly string[]) => recallText(lines))
    const rows = (yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, PERSONAL),
          eq(BrainEntryTable.status, "active"),
          inArray(BrainEntryTable.kind, [...input.kinds]),
        ),
      )
      .all()
      .pipe(Effect.orDie)).filter(
      (row) =>
        !row.pinned &&
        !row.tier0 &&
        !row.stale &&
        row.source_file !== personalFiles.memory &&
        !exclude.has(row.id) &&
        inFacets(row, facets) &&
        (row.kind !== "term" || BrainLearn.names(input.query, row.term_key ?? "")) &&
        (input.audience === "owner" || BrainPrivate.screened({ kind: row.kind, text: row.body, private: row.private })),
    )
    const files = (input.files ?? []).map((file) => BrainPaths.relative(place.root, file))
    const scored = new Map(
      BrainLexical.rank(
        rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
        BrainLexical.terms([input.query, ...files].join(" ")),
      ).map((item) => [item.id, item.score]),
    )
    const picked = rows
      .flatMap((row) => {
        const covered = files.some((file) => row.paths.some((pattern) => matches(pattern, file)))
        // A line scoped to files this work does not touch says nothing about it.
        if (row.paths.length > 0 && !covered) return []
        return [{ row, score: (scored.get(row.id) ?? 0) + (covered ? 5 : 0) }]
      })
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          b.row.uses - a.row.uses ||
          b.row.updated_at - a.row.updated_at ||
          a.row.id.localeCompare(b.row.id),
      )
      .reduce<Row[]>(
        (kept, item) =>
          Token.estimate(wrap([...kept, item.row].map(line))) > input.budget ? kept : [...kept, item.row],
        [],
      )
    if (picked.length === 0) return { ids: [], tokens: 0 }
    const text = wrap(picked.map(line))
    const tokens = Token.estimate(text)
    const ids = picked.map((row) => row.id)
    yield* used(ids, input.sessionID, input.tier, tokens, input.requestID)
    return { text, ids, tokens, personal: ids, shared: "" }
  })

  const posting = Effect.fn("Brain.posting")(function* (place: Place, input: { sessionIDs: readonly string[] }) {
    yield* sync(place)
    const rows = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.status, "active"),
          or(
            eq(BrainEntryTable.repository_id, PERSONAL),
            and(eq(BrainEntryTable.repository_id, place.repository), eq(BrainEntryTable.private, true)),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const fact = (row: Row) => row.private || row.source_file === personalFiles.memory || row.kind === "fact"
    const seen = input.sessionIDs.length
      ? (yield* db
          .selectDistinct({ id: BrainUseTable.entry_id })
          .from(BrainUseTable)
          .where(inArray(BrainUseTable.session_id, [...input.sessionIDs]))
          .all()
          .pipe(Effect.orDie)).map((row) => row.id)
      : []
    const entries = seen.length
      ? new Set(
          (yield* db
            .select({ id: BrainEntryTable.id })
            .from(BrainEntryTable)
            .where(inArray(BrainEntryTable.id, seen))
            .all()
            .pipe(Effect.orDie)).map((row) => row.id),
        )
      : new Set<string>()
    return {
      // Rules, preferences, decisions, lessons, past failures and review notes: everything that is not about them.
      habits: rows.filter((row) => !fact(row)).map((row) => row.body),
      facts: rows.filter(fact).map((row) => row.body),
      // What else those sessions were shown is document cards: the caller checks which are private.
      cards: seen.filter((id) => !entries.has(id)),
    }
  })

  const search = Effect.fn("Brain.search")(function* (
    place: Place,
    input: { query: string; personal: boolean; limit?: number; sessionID?: string },
  ) {
    yield* sync(place)
    const rows = (yield* visibleRows(place, input.personal, ["active"])).filter((row) => row.kind !== "review")
    const query = BrainLexical.terms(input.query)
    const ranked = query.size
      ? BrainLexical.rank(
          rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
          query,
        ).flatMap((item) => rows.filter((row) => row.id === item.id))
      : rows.toSorted((a, b) => (b.last_used_at ?? b.updated_at) - (a.last_used_at ?? a.updated_at))
    const picked = ranked
      .slice(0, input.limit ?? 5)
      .reduce<
        Row[]
      >((kept, row) => (kept.map(line).join("\n").length + line(row).length > BUDGET.search && kept.length ? kept : [...kept, row]), [])
    yield* used(
      picked.map((row) => row.id),
      input.sessionID,
      "search",
      Token.estimate(picked.map(line).join("\n")),
    )
    return picked.map(toEntry)
  })

  const find = Effect.fnUntraced(function* (place: Place, id: string, personal: boolean) {
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(and(eq(BrainEntryTable.id, id), visible(place, personal)))
      .get()
      .pipe(Effect.orDie)
  })

  const get = Effect.fn("Brain.get")(function* (place: Place, id: string, options: { personal: boolean }) {
    const row = yield* find(place, id, options.personal)
    if (!row) return undefined
    const evidence = yield* db
      .select()
      .from(BrainEvidenceTable)
      .where(eq(BrainEvidenceTable.entry_id, id))
      .orderBy(asc(BrainEvidenceTable.created_at))
      .all()
      .pipe(Effect.orDie)
    const related = row.related.length
      ? yield* db
          .select()
          .from(BrainEntryTable)
          .where(
            and(
              inArray(BrainEntryTable.id, row.related),
              visible(place, options.personal),
              eq(BrainEntryTable.status, "active"),
            ),
          )
          .all()
          .pipe(Effect.orDie)
      : []
    return {
      entry: toEntry(row),
      evidence: evidence.map((item) => ({
        type: item.type,
        ...(item.path ? { path: item.path } : {}),
        ...(item.quote ? { quote: item.quote } : {}),
        ...(item.command ? { command: item.command } : {}),
        ...(item.session_id ? { sessionID: item.session_id } : {}),
        createdAt: item.created_at,
      })),
      related: related.map(toEntry),
    }
  })

  // What the agent put in use on its own, newest first: entries it learned whose latest step into use was its own write,
  // not the user approving or restoring them. Settings lists them with Undo.
  const recentlyLearned = Effect.fnUntraced(function* (place: Place, scope: BrainSchema.Scope | undefined) {
    const rows = (yield* visibleRows(place, true, ["active"])).filter(
      (row) => row.origin === "agent" && (!scope || row.scope === scope),
    )
    if (rows.length === 0) return []
    const steps = yield* db
      .select({ entry: BrainEventTable.entry_id, actor: BrainEventTable.actor, at: BrainEventTable.at })
      .from(BrainEventTable)
      .where(
        and(
          inArray(
            BrainEventTable.entry_id,
            rows.map((row) => row.id),
          ),
          inArray(BrainEventTable.action, ["added", "superseded", "promoted", "restored", "approved"]),
        ),
      )
      .orderBy(asc(BrainEventTable.id))
      .all()
      .pipe(Effect.orDie)
    // In id order, so each entry keeps its latest step.
    const latest = new Map(steps.map((step) => [step.entry, step]))
    return rows
      .flatMap((row) => {
        const step = latest.get(row.id)
        return step?.actor === "agent" ? [{ row, at: step.at }] : []
      })
      .toSorted((a, b) => b.at - a.at || b.row.created_at - a.row.created_at)
      .map((item) => toEntry(item.row))
  })

  const list = Effect.fn("Brain.list")(function* (
    place: Place,
    input: { filter?: Filter; query?: string; scope?: BrainSchema.Scope },
  ) {
    yield* sync(place)
    if (input.filter === "learned") return yield* recentlyLearned(place, input.scope)
    const statuses: readonly BrainSchema.Status[] =
      input.filter === "review"
        ? ["proposed", "quarantined"]
        : input.filter === "archived"
          ? ["archived", "superseded"]
          : input.filter === "all"
            ? ["active", "proposed", "quarantined", "archived", "superseded"]
            : ["active"]
    const rows = (yield* visibleRows(place, true, statuses)).filter((row) => !input.scope || row.scope === input.scope)
    const query = input.query?.trim().toLowerCase()
    if (!query) return rows.toSorted(byPlace).map(toEntry)
    const terms = BrainLexical.terms(query)
    const ranked = new Map(
      BrainLexical.rank(
        rows.map((row) => ({ id: row.id, terms: decode(row.terms) })),
        terms,
      ).map((item, index) => [item.id, index]),
    )
    return rows
      .filter((row) => ranked.has(row.id) || row.body.toLowerCase().includes(query) || row.id === query)
      .toSorted((a, b) => (ranked.get(a.id) ?? 1e9) - (ranked.get(b.id) ?? 1e9) || byPlace(a, b))
      .map(toEntry)
  })

  // --- Writing ----------------------------------------------------------------------------------------------------

  const learning = Effect.fn("Brain.learning")(function* () {
    const row = yield* db
      .select()
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, PERSONAL))
      .get()
      .pipe(Effect.orDie)
    return row?.learning ?? true
  })

  const setLearning = Effect.fn("Brain.setLearning")(function* (enabled: boolean) {
    yield* db
      .insert(BrainStateTable)
      .values({ repository_id: PERSONAL, learning: enabled })
      .onConflictDoUpdate({ target: BrainStateTable.repository_id, set: { learning: enabled } })
      .run()
      .pipe(Effect.orDie)
  })

  // Every facet is learned, and the model learner runs only with Vector Local on, until the user says otherwise
  // (section 7.4). Skills wait for review and are drafted by a model only with Vector Local on, and learned workflow
  // defaults apply without exploring, until the owner chooses otherwise; no repository's config can choose for them.
  const learnSettings = Effect.fn("Brain.learnSettings")(function* () {
    const row = yield* db
      .select()
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, PERSONAL))
      .get()
      .pipe(Effect.orDie)
    return {
      learning: row?.learning ?? true,
      facets: Object.fromEntries(
        BrainLearn.FACETS.map((facet) => [facet, row?.learn_facets?.[facet] !== false]),
      ) as Record<BrainSchema.Facet, boolean>,
      modelLearner: row?.model_learner ?? "local-only",
      skills: row?.skill_learning ?? "review",
      skillDrafter: row?.skill_drafter ?? "local-only",
      workflow: row?.workflow_learning ?? "apply",
      workflowExplore: row?.workflow_explore ?? false,
    } satisfies LearnSettings
  })

  const setLearnSettings = Effect.fn("Brain.setLearnSettings")(function* (change: {
    learning?: boolean
    facets?: Partial<Record<BrainSchema.Facet, boolean>>
    modelLearner?: ModelLearner
    skills?: BrainSchema.SkillLearning
    skillDrafter?: BrainSchema.SkillDrafter
    workflow?: BrainSchema.WorkflowLearning
    workflowExplore?: boolean
  }) {
    const current = yield* learnSettings()
    const next = {
      learning: change.learning ?? current.learning,
      learn_facets: { ...current.facets, ...change.facets },
      model_learner: change.modelLearner ?? current.modelLearner,
      skill_learning: change.skills ?? current.skills,
      skill_drafter: change.skillDrafter ?? current.skillDrafter,
      workflow_learning: change.workflow ?? current.workflow,
      workflow_explore: change.workflowExplore ?? current.workflowExplore,
    }
    yield* db
      .insert(BrainStateTable)
      .values({ repository_id: PERSONAL, ...next })
      .onConflictDoUpdate({ target: BrainStateTable.repository_id, set: next })
      .run()
      .pipe(Effect.orDie)
    return yield* learnSettings()
  })

  // Every write that changes memory leaves one evidence row, so this counts merges into known entries as well as new
  // ones, and the agent cannot pile writes onto one entry past the per-message cap either. A learned skill's evidence
  // is Vector's own and counts toward no message's memory writes.
  const written = Effect.fn("Brain.written")(function* (sessionID: string, since: number) {
    const rows = yield* db
      .select({ id: BrainEvidenceTable.id })
      .from(BrainEvidenceTable)
      .innerJoin(BrainEntryTable, eq(BrainEntryTable.id, BrainEvidenceTable.entry_id))
      .where(
        and(
          eq(BrainEvidenceTable.session_id, sessionID),
          sql`${BrainEvidenceTable.created_at} >= ${since}`,
          ne(BrainEntryTable.kind, "skill"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

  // What waits for review in one scope, of the origins given, and how much of it one session left there. Imports are
  // counted apart from what Vector learned and the user wrote, so a large import neither stops Vector learning nor is
  // cut short by what already waits.
  const waiting = Effect.fnUntraced(function* (
    repository: string,
    sessionID: string | undefined,
    origins: readonly BrainSchema.Origin[],
  ) {
    const rows = yield* db
      .select({ session: BrainEntryTable.origin_session_id })
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...origins]),
          inArray(BrainEntryTable.status, ["proposed", "quarantined"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return { all: rows.length, session: sessionID ? rows.filter((row) => row.session === sessionID).length : 0 }
  })

  // Evidence is kept only as far as it was checked, and never with a secret or a hidden character in it: get and export
  // show it, and get sends it to the provider.
  const evidenceRow = (
    entry: string,
    evidence: Evidence | undefined,
    sessionID: string | undefined,
    checked: boolean,
  ) => {
    const base = {
      entry_id: entry,
      session_id: sessionID ?? null,
      created_at: Date.now(),
      path: null,
      quote: null,
      file_hash: null,
      command: null,
    }
    if (!evidence || evidence.type === "user") return { ...base, type: "user" as const }
    if (evidence.type === "message")
      return { ...base, type: "message" as const, quote: checked ? scrub(evidence.quote) : null }
    if (evidence.type === "file")
      return {
        ...base,
        type: "file" as const,
        path: scrub(evidence.path),
        quote: checked ? scrub(evidence.quote) : null,
        file_hash: checked ? (evidence.hash ?? null) : null,
      }
    if (evidence.type === "document")
      return { ...base, type: "document" as const, path: evidence.path, quote: checked ? scrub(evidence.quote) : null }
    if (evidence.type === "run")
      return {
        ...base,
        type: "run" as const,
        quote: evidence.requestID,
        command: checked ? scrub(evidence.command) : null,
      }
    return { ...base, type: "check" as const, command: checked ? scrub(evidence.command) : null }
  }

  // The same evidence from the same session is kept once, so a write the agent repeats changes nothing.
  const seen = Effect.fnUntraced(function* (row: ReturnType<typeof evidenceRow>) {
    const found = yield* db
      .select({ id: BrainEvidenceTable.id })
      .from(BrainEvidenceTable)
      .where(
        and(
          eq(BrainEvidenceTable.entry_id, row.entry_id),
          eq(BrainEvidenceTable.type, row.type),
          row.session_id === null
            ? isNull(BrainEvidenceTable.session_id)
            : eq(BrainEvidenceTable.session_id, row.session_id),
          row.path === null ? isNull(BrainEvidenceTable.path) : eq(BrainEvidenceTable.path, row.path),
          row.quote === null ? isNull(BrainEvidenceTable.quote) : eq(BrainEvidenceTable.quote, row.quote),
          row.command === null ? isNull(BrainEvidenceTable.command) : eq(BrainEvidenceTable.command, row.command),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return found !== undefined
  })

  // An entry keeps its newest evidence; older rows say nothing the newer ones do not.
  const trim = (entry: string) =>
    db
      .delete(BrainEvidenceTable)
      .where(
        and(
          eq(BrainEvidenceTable.entry_id, entry),
          sql`${BrainEvidenceTable.id} NOT IN (SELECT id FROM brain_evidence WHERE entry_id = ${entry} ORDER BY id DESC LIMIT ${LIMIT.evidence})`,
        ),
      )
      .run()
      .pipe(Effect.orDie)

  const tombstoned = Effect.fnUntraced(function* (repository: string, hash: string) {
    const row = yield* db
      .select()
      .from(BrainTombstoneTable)
      .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    return row !== undefined && row.until > Date.now()
  })

  // Whether a quote of the user's words is, or holds, an entry they forgot in this repository or their own: the same
  // words, or every term of it with each of its turns ("always", "never" and what they apply to).
  const quoted = Effect.fnUntraced(function* (repository: string, quote: string) {
    const hash = normHash(quote)
    if ((yield* tombstoned(repository, hash)) || (yield* tombstoned(PERSONAL, hash))) return true
    const terms = BrainLexical.terms(quote)
    const turns = new Set(BrainLexical.polarity(quote).split(" ").filter(Boolean))
    const forgotten = yield* db
      .select({ terms: BrainTombstoneTable.terms, polarity: BrainTombstoneTable.polarity })
      .from(BrainTombstoneTable)
      .where(
        and(
          inArray(BrainTombstoneTable.repository_id, [...new Set([repository, PERSONAL])]),
          gt(BrainTombstoneTable.until, Date.now()),
          isNotNull(BrainTombstoneTable.terms),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return forgotten.some((row) => {
      const own = decode(row.terms!)
      return (
        own.size > 0 &&
        [...own].every(([term, count]) => (terms.get(term) ?? 0) >= count) &&
        (row.polarity ?? "")
          .split(" ")
          .filter(Boolean)
          .every((turn) => turns.has(turn))
      )
    })
  })

  // A replacement that waited for review replaces its entry once it is approved. Only the user's approval replaces what
  // the user wrote.
  const settle = Effect.fnUntraced(function* (id: string, actor: "user" | "agent" | "vector") {
    const targets = (yield* db
      .select()
      .from(BrainEventTable)
      .where(and(eq(BrainEventTable.entry_id, id), eq(BrainEventTable.action, "added")))
      .all()
      .pipe(Effect.orDie)).flatMap((item) => (typeof item.detail?.pending === "string" ? [item.detail.pending] : []))
    if (targets.length === 0) return
    yield* db
      .update(BrainEntryTable)
      .set({ status: "superseded", superseded_by: id, updated_at: Date.now() })
      .where(
        and(
          inArray(BrainEntryTable.id, targets),
          inArray(BrainEntryTable.status, ["active", "proposed"]),
          actor === "user" ? undefined : ne(BrainEntryTable.origin, "user"),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })

  const writeProposal = Effect.fn("Brain.writeProposal")(function* (
    place: Place,
    proposal: Proposal | (Omit<Proposal, "kind" | "origin"> & { readonly kind: "review"; readonly origin: "user" }),
  ) {
    if (proposal.supersedes && (yield* skillEntry(proposal.supersedes))) return refuse("skill-entry", SKILL_ENTRY)
    const agent = proposal.origin === "agent"
    // What a file the user imported says waits for them, however it reads, so a changed file cannot plant memory in use.
    const imported = proposal.origin === "import"
    const actor = agent ? ("agent" as const) : ("user" as const)
    const settings = agent ? yield* learnSettings() : undefined
    if (settings && !settings.learning)
      return refuse("learning-off", "Learning is turned off in Settings > Memory, so nothing was saved.")
    const hiddenText = BrainScan.hidden(proposal.text)
    const cleaned = BrainScan.stripHidden(proposal.text).replace(/\s+/g, " ").trim()
    if (!cleaned) return refuse("empty", "Nothing to save.")
    // A term says what one of the user's words means, and is found again by that word.
    const term = proposal.kind === "term" ? BrainLearn.term(cleaned) : undefined
    if (proposal.kind === "term" && !term)
      return refuse("not-a-term", 'A term reads "When I say X, I mean Y". Save anything else as a preference.')
    const facet =
      proposal.facet ?? (term ? "vocabulary" : proposal.kind === "preference" ? BrainLearn.facetOf(cleaned) : undefined)
    if (settings && facet && !settings.facets[facet])
      return refuse(
        "learning-off",
        `Learning about your ${facet} is turned off in Settings > Memory, so nothing was saved.`,
      )
    const limit = agent ? LIMIT.agent : LIMIT.user
    if (cleaned.length > limit)
      return refuse("too-long", `Keep one memory to ${limit} characters: one fact, lesson or decision per entry.`)
    // A password, passphrase or PIN given with its value is a secret in any wording. What is worth remembering is where
    // the secret is kept, never the secret itself.
    if (agent && BrainScan.credential(cleaned))
      return refuse(
        "secret",
        "That gives a password or passphrase. Memory never stores secrets; save where it is kept instead.",
      )
    const redacted = BrainScan.redact(cleaned)
    if (redacted.redacted && BrainScan.remainder(redacted.text) < 16)
      return refuse("secret", "That is a secret. Memory never stores secrets, keys, tokens or passwords.")
    if (agent && proposal.sessionID !== undefined && proposal.since !== undefined) {
      if ((yield* written(proposal.sessionID, proposal.since)) >= LIMIT.perMessage)
        return refuse(
          "limit",
          `Vector already saved ${LIMIT.perMessage} memories for this message. Keep only the ones that matter most.`,
        )
    }
    const text = redacted.text
    const evidence = proposal.evidence
    // A term replaces the term in use for the same words, as an explicit update would.
    const keyed = term && !proposal.supersedes ? yield* sameTerm(place, term.key, normHash(text)) : undefined
    // What the agent learns goes into use at once unless the session took in outside content (`hold`). Evidence it gives
    // is checked, kept and raises confidence, and counts only for what it says: a quote has to state the memory, and a
    // check has to be the one it names. The user's own words still decide personal memory and changes to theirs.
    const verified =
      !agent || (evidence !== undefined && evidence.type !== "user" && evidence.verified && supports(text, evidence))
    // The user's own words: what they wrote in Settings, or a checked quote of what they said in this conversation.
    const said = !agent || (verified && evidence?.type === "message")
    // Personal memory follows the user into every repository, so it takes what they said about themselves. What Vector's
    // learner read is held to more, whatever voice it is in: it follows them only when it names nothing of one
    // repository, as "I prefer tables" and "always use tables" do and "I prefer Acme's churn numbers from the dashboard"
    // or "always cc jane@acme.com" do not.
    const own =
      !agent ||
      (said &&
        evidence?.type === "message" &&
        (proposal.learner === true ? general(text, evidence.quote, facet) : FIRST_PERSON.test(evidence.quote)))
    const previous = proposal.supersedes ? yield* find(place, proposal.supersedes, true) : keyed
    if (proposal.supersedes && !previous) return refuse("not-found", `No memory ${proposal.supersedes} here.`)
    if (previous && !LEARNED.includes(previous.origin))
      return refuse(
        "file-entry",
        `${previous.id} comes from ${previous.source_file ? path.basename(previous.source_file) : "a file"}; ask the user to edit that file.`,
      )
    // A replacement puts its words in use, so replacing what was put away would bring it back. As with the same words
    // again, the agent may do that only for what it or tidying put away; what was replaced points to its replacement.
    if (agent && previous?.status === "superseded")
      return refuse(
        "put-away",
        `${previous.id} was replaced${previous.superseded_by ? ` by ${previous.superseded_by}` : ""}; change that one instead.`,
      )
    if (agent && previous?.status === "archived" && (yield* archivedBy(previous.id)) === "user")
      return refuse(
        "put-away",
        `${previous.id} was put away. Only the user can bring it back, in Settings > Memory; ask them if it applies again.`,
      )
    // A replacement keeps the scope of what it replaces, and only the user's words change what the user wrote.
    if (previous?.scope === "personal" && !own)
      return refuse(
        "not-found",
        `${previous.id} is the user's own memory; quote what they said about themselves to change it.`,
      )
    if (previous?.origin === "user" && !said)
      return refuse(
        "user-entry",
        `${previous.id} is the user's own entry; quote what they said to change it, or ask them to edit it in Settings > Memory.`,
      )
    const scope: BrainSchema.Scope =
      (previous?.scope ?? proposal.scope) === "personal" && own ? "personal" : "repository"
    const repository = scope === "personal" ? PERSONAL : place.repository
    // What Vector's learner keeps for this repository because it names someone or something in particular ("always
    // cc jane@acme.com", "always ask Priya before merging", "never deploy to acme-prod on Fridays") is memory of the
    // owner, not of the code (section 6.4a). It is kept private, so it goes only where personal memory goes: never to
    // a session an invited guest is in nor to a model that may train on prompts, and no outward role hears it. What
    // names only the code ("always use pnpm in this repo") is the repository's, like the code a guest works on.
    const named =
      proposal.learner === true &&
      scope === "repository" &&
      [text, evidence?.type === "message" ? evidence.quote : text].some((value) => names(value, facet))
    const hash = normHash(text)
    // What the user took out of their own memory is not learned for a repository instead either, nor imported again.
    if ((agent || imported) && ((yield* tombstoned(repository, hash)) || (yield* tombstoned(PERSONAL, hash))))
      return refuse("forgotten", "The user took this out of memory, so it was not saved again.")
    // A model learner writes its own words for what the user typed, so what the user took back is found in the quote
    // too: the same words, or a quote that says all of an entry they forgot, the same way round.
    if (
      agent &&
      proposal.learner === true &&
      evidence?.type === "message" &&
      normalise(evidence.quote) !== normalise(text) &&
      (yield* quoted(repository, evidence.quote))
    )
      return refuse("forgotten", "The user took out a memory that says this, so it was not saved again.")
    // A file the user imported can carry what anyone wrote into it, so it is held as the agent's writes are: what
    // reads as instructions, or hid characters, waits apart from the rest of the import, which one click approves.
    const hold =
      !agent && !imported
        ? undefined
        : (proposal.hold ??
          (hiddenText ? "hidden-unicode" : BrainScan.instructionLike(text) ? "instruction-like" : undefined))
    // A write that waits without being held: Vector's learner read it in a long message, a model suggested it in a
    // session that read outside content, or a file brought it in.
    const pending = hold ? undefined : imported ? ("review" as const) : proposal.pending

    const peers = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...LEARNED]),
          // A learned fact cannot become a dismissal, nor may a dismissal be merged into a model's learned fact.
          proposal.kind === "review" ? eq(BrainEntryTable.kind, "review") : ne(BrainEntryTable.kind, "review"),
          inArray(BrainEntryTable.status, ["active", "proposed", "quarantined", "archived"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const words = BrainLexical.terms([text, ...(proposal.paths ?? [])].join(" "))
    const now = Date.now()

    // The same words again: the entry gains this evidence, and the user writing what waits for review approves it.
    const exact = peers.find((row) => row.norm_hash === hash && row.id !== previous?.id)
    if (exact) {
      // A held write never adds to an entry outside the review queue, so outside content cannot vouch for memory; nor
      // does a model's suggestion from such a session, or an imported file, change what is known.
      if ((hold && exact.status !== "quarantined") || pending === "review" || imported)
        return { type: "merged" as const, entry: toEntry(exact) }
      // What the user put away stays away until they bring it back; the agent may restore only what it or tidying
      // put away.
      if (agent && exact.status === "archived" && (yield* archivedBy(exact.id)) === "user")
        return { type: "merged" as const, entry: toEntry(exact) }
      // A write with nothing from outside behind it goes into use, as a new entry would: a proposal an earlier version
      // left waiting, or what the agent or tidying put away. Only the user approves what was held. Words the learner
      // read in a long message confirm a waiting entry only from another session (a second sighting), and put nothing
      // away back in use.
      const row = evidenceRow(exact.id, evidence, proposal.sessionID, verified)
      const repeated = yield* seen(row)
      const confirms = exact.status === "proposed" && (pending !== "sighting" || !repeated)
      const restores = exact.status === "archived" && pending === undefined
      const approves = !agent && exact.status === "quarantined"
      const status: BrainSchema.Status = confirms || restores || approves ? "active" : exact.status
      // What the user wrote themselves is theirs, so the agent cannot put it away later.
      const origin = agent ? exact.origin : "user"
      const next = {
        status,
        origin,
        hold_reason: approves ? null : exact.hold_reason,
        confidence: Math.max(exact.confidence, confidence(proposal, verified)),
        updated_at: now,
        paths: [...new Set([...exact.paths, ...(proposal.paths ?? [])])],
        // The learner's words make the entry the owner's, as a new entry would be.
        private: exact.private || named,
      }
      // Words already in memory: in use now, or as they were (held, put away or in use), and never held anew.
      const outcome = (entry: BrainSchema.Entry) => ({
        type: status !== exact.status ? ("promoted" as const) : ("merged" as const),
        entry,
      })
      const changed =
        status !== exact.status ||
        origin !== exact.origin ||
        next.confidence !== exact.confidence ||
        next.paths.length !== exact.paths.length ||
        next.private !== exact.private
      // The agent repeating itself changes nothing; the user saving the same words again marks it as just confirmed.
      if (agent && repeated && !changed) return outcome(toEntry(exact))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(BrainEntryTable).set(next).where(eq(BrainEntryTable.id, exact.id)).run()
            if (!repeated) yield* tx.insert(BrainEvidenceTable).values(row).run()
          }),
        )
        .pipe(Effect.orDie)
      yield* trim(exact.id)
      if (status === "active" && exact.status !== "active") yield* settle(exact.id, actor)
      yield* event(exact, confirms ? "promoted" : restores ? "restored" : approves ? "approved" : "merged", actor)
      yield* bump(repository)
      return outcome(toEntry({ ...exact, ...next }))
    }

    // Nor does the agent learn again a close rewording of what the user undid, put away or forgot.
    if (agent && (yield* reworded(repository, peers, { body: text, terms: words })))
      return refuse("forgotten", "The user took out a memory that says this, so it was not saved again.")

    // Another wording of a known entry. Similar words are not the same fact ("Run the web tests from packages/web" and
    // "... from packages/app" share most of them), so a wording only joins an entry when it adds nothing to it.
    const fresh = { body: text, terms: words }
    const similar =
      previous || hold || pending || !agent
        ? undefined
        : peers
            .filter((row) => row.kind === proposal.kind && row.status === "active")
            .map((row) => ({ row, score: BrainLexical.similarity(decode(row.terms), words) }))
            .filter((item) => item.score >= SIMILAR)
            .toSorted((a, b) => b.score - a.score)[0]?.row
    const known = similar ? { body: similar.body, terms: decode(similar.terms) } : undefined
    if (similar && known && within(fresh, known)) {
      if (verified) {
        const row = evidenceRow(similar.id, evidence, proposal.sessionID, true)
        if (!(yield* seen(row))) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(BrainEntryTable)
                  .set({ confidence: Math.max(similar.confidence, confidence(proposal, verified)), updated_at: now })
                  .where(eq(BrainEntryTable.id, similar.id))
                  .run()
                yield* tx.insert(BrainEvidenceTable).values(row).run()
              }),
            )
            .pipe(Effect.orDie)
          yield* trim(similar.id)
          yield* event(similar, "merged", actor)
          yield* bump(repository)
        }
      }
      return { type: "merged" as const, entry: toEntry(similar) }
    }

    const status: BrainSchema.Status = hold ? "quarantined" : pending ? "proposed" : "active"
    if (status !== "active") {
      const queue = yield* waiting(repository, proposal.sessionID, imported ? ["import"] : ["agent", "user"])
      if (imported && queue.all >= LIMIT.imported)
        return refuse(
          "limit",
          "Enough imported memory already waits for the user's review. Approve or reject it in Settings > Memory before importing more.",
        )
      if (!imported && (queue.session >= LIMIT.pendingPerSession || queue.all >= LIMIT.pending))
        return refuse(
          "limit",
          "Enough memory already waits for the user's review. Ask them to go through Settings > Memory before saving more.",
        )
    }
    const id = yield* freshId()
    const others = peers.filter((row) => row.status === "active" && row.id !== previous?.id)
    const related = others
      .map((row) => ({ id: row.id, score: BrainLexical.similarity(decode(row.terms), words) }))
      .filter((item) => item.score >= 0.2)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.id)
    // An entry in use that shares half or more of these words may be the one this corrects. Only an explicit update
    // replaces it, so the writer is told about it instead.
    const near = others
      .map((row) => ({ row, share: overlap(words, decode(row.terms)) }))
      .filter((item) => item.share >= RELATED)
      .toSorted((a, b) => b.share - a.share || b.row.updated_at - a.row.updated_at)[0]?.row
    const row: Row = {
      id,
      scope,
      repository_id: repository,
      kind: proposal.kind,
      origin: proposal.origin,
      status,
      pinned: false,
      body: text,
      paths: [...(proposal.paths ?? [])],
      terms: encode(words),
      norm_hash: hash,
      confidence: confidence(proposal, verified),
      uses: 0,
      helpful: 0,
      harmful: 0,
      last_used_at: null,
      created_at: now,
      updated_at: now,
      superseded_by: null,
      stale: false,
      hold_reason: hold ?? null,
      related: near && !related.includes(near.id) ? [near.id, ...related.slice(0, 2)] : related,
      tier0: false,
      source_file: null,
      source_line: null,
      origin_session_id: proposal.sessionID ?? null,
      signature: null,
      // A replacement for a private entry stays private.
      private: proposal.private === true || previous?.private === true || named,
      facet: facet ?? null,
      term_key: term?.key ?? null,
    }
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(BrainEntryTable).values(row).run()
          yield* tx
            .insert(BrainEvidenceTable)
            .values(evidenceRow(id, evidence, proposal.sessionID, verified))
            .run()
          // A replacement that waits leaves the entry it replaces in use until it is approved.
          if (previous && status === "active")
            yield* tx
              .update(BrainEntryTable)
              .set({ status: "superseded", superseded_by: id, updated_at: now })
              .where(eq(BrainEntryTable.id, previous.id))
              .run()
          if (proposal.origin === "user")
            yield* tx
              .delete(BrainTombstoneTable)
              .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, hash)))
              .run()
        }),
      )
      .pipe(Effect.orDie)
    yield* event(
      row,
      previous && status === "active" ? "superseded" : "added",
      actor,
      previous ? (status === "active" ? { previous: previous.id } : { pending: previous.id }) : undefined,
    )
    if (status === "active") yield* capacity(repository)
    yield* bump(repository)
    const entry = toEntry(row)
    if (previous && status === "active") return { type: "superseded" as const, entry, previous: previous.id }
    const extra = near ? { related: toEntry(near) } : {}
    if (status === "quarantined") return { type: "held" as const, entry, ...extra }
    return { type: "added" as const, entry, ...extra }
  })

  const propose: Interface["propose"] = (place, proposal) =>
    Schema.is(BrainSchema.LearnedKind)(proposal.kind)
      ? writeProposal(place, proposal)
      : Effect.succeed(refuse("user-entry", "Only an owner action can dismiss a review finding."))
  const dismissReview: Interface["dismissReview"] = (place, input) =>
    writeProposal(place, {
      kind: "review",
      origin: "user",
      scope: "repository",
      text: input.text,
      paths: input.paths,
      sessionID: input.sessionID,
      evidence: { type: "user" },
    })

  // The term in use for the same words, in this repository or the user's own, unless it already says these words.
  const sameTerm = Effect.fnUntraced(function* (place: Place, key: string, hash: string) {
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          inArray(BrainEntryTable.repository_id, [place.repository, PERSONAL]),
          eq(BrainEntryTable.kind, "term"),
          eq(BrainEntryTable.status, "active"),
          eq(BrainEntryTable.term_key, key),
          ne(BrainEntryTable.norm_hash, hash),
        ),
      )
      .orderBy(desc(BrainEntryTable.updated_at))
      .get()
      .pipe(Effect.orDie)
  })

  // The entry this one was written to replace, at once or once approved, while that one is still replaced by it. A
  // duplicate tidying merged into it is not one: it says what the undone entry said.
  const replacedBy = Effect.fnUntraced(function* (row: Row) {
    const step = yield* db
      .select({ detail: BrainEventTable.detail })
      .from(BrainEventTable)
      .where(and(eq(BrainEventTable.entry_id, row.id), inArray(BrainEventTable.action, ["superseded", "added"])))
      .orderBy(desc(BrainEventTable.id))
      .get()
      .pipe(Effect.orDie)
    const previous = [step?.detail?.previous, step?.detail?.pending].find(
      (value): value is string => typeof value === "string",
    )
    if (!previous) return undefined
    return yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.id, previous),
          eq(BrainEntryTable.status, "superseded"),
          eq(BrainEntryTable.superseded_by, row.id),
        ),
      )
      .get()
      .pipe(Effect.orDie)
  })

  // Who last put an entry away. An entry with no record of it counts as put away by the user, so it stays away.
  const archivedBy = Effect.fnUntraced(function* (id: string) {
    const row = yield* db
      .select({ actor: BrainEventTable.actor })
      .from(BrainEventTable)
      .where(and(eq(BrainEventTable.entry_id, id), eq(BrainEventTable.action, "archived")))
      .orderBy(desc(BrainEventTable.id))
      .get()
      .pipe(Effect.orDie)
    return row?.actor ?? "user"
  })

  // Whether these words say again, the same way round, what the user took out of memory: an entry they undid or put
  // away, or one they forgot, of this repository or their own. Sharing most terms, or adding none, is saying it again.
  const reworded = Effect.fnUntraced(function* (
    repository: string,
    peers: readonly Row[],
    fresh: { readonly body: string; readonly terms: ReadonlyMap<string, number> },
  ) {
    const way = BrainLexical.polarity(fresh.body)
    const again = (terms: ReadonlyMap<string, number>) =>
      BrainLexical.similarity(terms, fresh.terms) >= SIMILAR ||
      [...fresh.terms].every(([term, count]) => (terms.get(term) ?? 0) >= count)
    const forgotten = yield* db
      .select({ terms: BrainTombstoneTable.terms, polarity: BrainTombstoneTable.polarity })
      .from(BrainTombstoneTable)
      .where(
        and(
          inArray(BrainTombstoneTable.repository_id, [...new Set([repository, PERSONAL])]),
          gt(BrainTombstoneTable.until, Date.now()),
          isNotNull(BrainTombstoneTable.terms),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    if (forgotten.some((row) => row.polarity === way && again(decode(row.terms!)))) return true
    const away = peers.filter(
      (row) => row.status === "archived" && BrainLexical.polarity(row.body) === way && again(decode(row.terms)),
    )
    for (const row of away) if ((yield* archivedBy(row.id)) === "user") return true
    return false
  })

  const freshId = Effect.fnUntraced(function* () {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = `m${base32(randomBytes(4)).slice(0, 5)}`
      const taken = yield* db
        .select({ id: BrainEntryTable.id })
        .from(BrainEntryTable)
        .where(eq(BrainEntryTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!taken) return id
    }
    return `m${base32(randomBytes(8))}`
  })

  // Past the cap, the least useful learned entry goes to the archive: never used, then least recently.
  const capacity = Effect.fnUntraced(function* (repository: string) {
    const rows = yield* db
      .select()
      .from(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, repository),
          inArray(BrainEntryTable.origin, [...LEARNED]),
          eq(BrainEntryTable.status, "active"),
          eq(BrainEntryTable.pinned, false),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const cap = repository === PERSONAL ? LIMIT.personal : LIMIT.repository
    const excess = rows
      .toSorted((a, b) => a.uses - b.uses || (a.last_used_at ?? a.created_at) - (b.last_used_at ?? b.created_at))
      .slice(0, Math.max(0, rows.length - cap))
    if (excess.length === 0) return 0
    yield* db
      .update(BrainEntryTable)
      .set({ status: "archived", updated_at: Date.now() })
      .where(
        inArray(
          BrainEntryTable.id,
          excess.map((row) => row.id),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* Effect.forEach(excess, (row) => event(row, "archived", "vector"), { discard: true })
    return excess.length
  })

  // A learned skill lives outside every place's memory, so `find` never returns one; these checks say why it cannot be
  // changed here rather than that it is not there.
  const skillEntry = Effect.fnUntraced(function* (id: string) {
    const row = yield* db
      .select({ kind: BrainEntryTable.kind })
      .from(BrainEntryTable)
      .where(eq(BrainEntryTable.id, id))
      .get()
      .pipe(Effect.orDie)
    return row?.kind === "skill"
  })

  // The changed content and the event that advances its revocation counter commit together.
  const update = Effect.fn("Brain.update")(function* (
    place: Place,
    id: string,
    change: Change,
    actor: "user" | "agent",
  ) {
    if (yield* skillEntry(id)) return refuse("skill-entry", SKILL_ENTRY)
    const row = yield* find(place, id, true)
    if (!row) return undefined
    const learned = LEARNED.includes(row.origin)
    // The agent changes only what it learned itself; what the user wrote or a file says is theirs to change.
    if (actor === "agent" && row.origin !== "agent")
      return refuse("user-entry", `${row.id} is the user's own; ask them to change it in Settings > Memory.`)
    const now = Date.now()
    if (change.text !== undefined) {
      if (!learned)
        return refuse(
          "file-entry",
          `${row.id} comes from ${row.source_file ? path.basename(row.source_file) : "a file"}; edit that file.`,
        )
      const cleaned = BrainScan.stripHidden(change.text).replace(/\s+/g, " ").trim()
      if (!cleaned) return refuse("empty", "Nothing to save.")
      if (cleaned.length > LIMIT.user) return refuse("too-long", `Keep one memory to ${LIMIT.user} characters.`)
      const redacted = BrainScan.redact(cleaned)
      if (redacted.redacted && BrainScan.remainder(redacted.text) < 16)
        return refuse("secret", "That is a secret. Memory never stores secrets, keys, tokens or passwords.")
      // An edited term is found by its new words; an edited preference is filed by them unless the user says where.
      const term = row.kind === "term" ? BrainLearn.term(redacted.text) : undefined
      if (row.kind === "term" && !term)
        return refuse("not-a-term", 'A term reads "When I say X, I mean Y". Keep its words and change what follows.')
      yield* db
        .update(BrainEntryTable)
        .set({
          body: redacted.text,
          terms: encode(BrainLexical.terms([redacted.text, ...row.paths].join(" "))),
          norm_hash: normHash(redacted.text),
          confidence: actor === "user" ? 1 : row.confidence,
          stale: false,
          updated_at: now,
          ...(term ? { term_key: term.key } : {}),
          ...(row.kind === "preference" && change.facet === undefined
            ? { facet: BrainLearn.facetOf(redacted.text) }
            : {}),
        })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "edited", actor, { previous: row.body })
    }
    if (change.facet !== undefined && (row.kind === "preference" || row.kind === "term")) {
      yield* db
        .update(BrainEntryTable)
        .set({ facet: change.facet, updated_at: now })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "filed", actor, { facet: change.facet })
    }
    if (change.pinned !== undefined) {
      yield* db
        .update(BrainEntryTable)
        .set({ pinned: change.pinned })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, change.pinned ? "pinned" : "unpinned", actor)
    }
    if (change.action === "approve" && (row.status === "proposed" || row.status === "quarantined")) {
      // A repository's own memory waits on trusting the repository, and a hidden character on fixing the file.
      if (!learned && row.hold_reason !== "instruction-like")
        return refuse(
          "file-entry",
          row.hold_reason === "untrusted-repository"
            ? "Trust this repository in Settings to use the memory it ships."
            : `Remove the hidden characters from ${row.source_file ? path.basename(row.source_file) : "the file"}.`,
        )
      yield* db
        .update(BrainEntryTable)
        .set({ status: "active", hold_reason: null, confidence: Math.max(row.confidence, 0.9), updated_at: now })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* settle(id, actor)
      yield* event(row, "approved", actor)
    }
    if (change.action === "reject" && (row.status === "proposed" || row.status === "quarantined")) {
      if (!learned) return refuse("file-entry", "This comes from a file; edit the file to change it.")
      yield* forgetRow(row)
      return { type: "merged" as const, entry: toEntry({ ...row, status: "archived" }) }
    }
    if ((change.action === "archive" || change.action === "restore" || change.action === "undo") && !learned)
      return refuse(
        "file-entry",
        `${row.id} comes from ${row.source_file ? path.basename(row.source_file) : "a file"}; edit that file.`,
      )
    if (change.action === "archive" && row.status === "active") {
      yield* db
        .update(BrainEntryTable)
        .set({ status: "archived", updated_at: now })
        .where(eq(BrainEntryTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* event(row, "archived", actor)
    }
    // Undo takes back what Vector learned: the entry is put away as the user's decision, which only they reverse, a
    // tombstone keeps the agent from learning the same words again, and an entry it replaced comes back.
    if (change.action === "undo" && actor === "user" && row.status === "active") {
      const replaced = yield* replacedBy(row)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(BrainEntryTable)
              .set({ status: "archived", updated_at: now })
              .where(eq(BrainEntryTable.id, id))
              .run()
            yield* tx
              .insert(BrainTombstoneTable)
              .values({ ...tombstoneOf(row), until: now + 180 * DAY })
              .onConflictDoUpdate({
                target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
                set: { until: now + 180 * DAY, terms: row.terms, polarity: BrainLexical.polarity(row.body) },
              })
              .run()
            if (replaced)
              yield* tx
                .update(BrainEntryTable)
                .set({ status: "active", superseded_by: null, updated_at: now })
                .where(eq(BrainEntryTable.id, replaced.id))
                .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* event(row, "archived", actor, { undo: true })
      if (replaced) yield* event(replaced, "restored", actor)
    }
    if (change.action === "restore" && (row.status === "archived" || row.status === "superseded")) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(BrainEntryTable)
              .set({ status: "active", superseded_by: null, updated_at: now })
              .where(eq(BrainEntryTable.id, id))
              .run()
            // The user bringing an undone entry back lifts what kept the agent from learning it.
            if (actor === "user")
              yield* tx
                .delete(BrainTombstoneTable)
                .where(
                  and(
                    eq(BrainTombstoneTable.repository_id, row.repository_id),
                    eq(BrainTombstoneTable.norm_hash, row.norm_hash),
                  ),
                )
                .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* event(row, "restored", actor)
    }
    yield* bump(row.repository_id)
    const next = yield* find(place, id, true)
    return next ? { type: "merged" as const, entry: toEntry(next) } : undefined
  }, (effect) => db.transaction(() => effect).pipe(Effect.orDie))

  // Forgetting is a real delete: the row and its evidence go, and only a hash of the text stays so it is not learned
  // again for 180 days.
  const bumpIn = (tx: Transaction, repository: string) =>
    tx
      .insert(BrainStateTable)
      .values({ repository_id: repository, revision: 1 })
      .onConflictDoUpdate({
        target: BrainStateTable.repository_id,
        set: { revision: sql`${BrainStateTable.revision} + 1` },
      })
      .run()

  // The same forgetting semantics, on the caller's transaction: session erasure cannot partly commit ordinary
  // memory before discovering an invalid review epoch or a failed skill cleanup.
  const forgetIn = Effect.fnUntraced(function* (tx: Transaction, row: Row) {
    yield* tx.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run()
    yield* tx
      .insert(BrainTombstoneTable)
      .values({ ...tombstoneOf(row), until: Date.now() + 180 * DAY })
      .onConflictDoUpdate({
        target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
        set: { until: Date.now() + 180 * DAY, terms: row.terms, polarity: BrainLexical.polarity(row.body) },
      })
      .run()
    yield* tx.delete(BrainUseTable).where(eq(BrainUseTable.entry_id, row.id)).run()
    yield* tx.delete(BrainEventTable).where(eq(BrainEventTable.entry_id, row.id)).run()
    yield* tx
      .insert(BrainEventTable)
      .values({
        entry_id: row.id,
        repository_id: row.repository_id,
        at: Date.now(),
        action: "forgotten",
        actor: "user",
      })
      .run()
    yield* bumpIn(tx, row.repository_id)
  })
  const forgetRow = (row: Row) => db.transaction((tx) => forgetIn(tx, row)).pipe(Effect.orDie)

  const forget = Effect.fn("Brain.forget")(function* (place: Place, id: string) {
    const row = yield* find(place, id, true)
    if (!row) return "not-found" as const
    if (row.origin === "file") return "file-entry" as const
    if (row.origin === "failure-memory" && row.source_file && row.signature) {
      // Failure memory is Vector's own file, so forgetting a record removes it there.
      yield* Effect.promise(() => removeFailure(row.source_file!, row.signature!))
      yield* db.delete(BrainSourceTable).where(eq(BrainSourceTable.path, row.source_file)).run().pipe(Effect.orDie)
    }
    yield* forgetRow(row)
    return "forgotten" as const
  })

  const erase = Effect.fn("Brain.erase")(function* (place: Place, scope: BrainSchema.Scope | "all") {
    const repositories = scope === "personal" ? [PERSONAL] : scope === "repository" ? [place.repository] : undefined
    const where = and(
      inArray(BrainEntryTable.origin, [...LEARNED]),
      repositories ? inArray(BrainEntryTable.repository_id, repositories) : undefined,
    )
    const rows = yield* db
      .select({ id: BrainEntryTable.id })
      .from(BrainEntryTable)
      .where(where)
      .all()
      .pipe(Effect.orDie)
    // Kept originals of the documents erased below, which are not redacted, go with them.
    const kept =
      scope === "personal"
        ? []
        : yield* db
            .select({ hash: BrainDocumentTable.content_hash, format: BrainDocumentTable.format })
            .from(BrainDocumentTable)
            .where(
              and(
                eq(BrainDocumentTable.stored, true),
                repositories ? inArray(BrainDocumentTable.repository_id, repositories) : undefined,
              ),
            )
            .all()
            .pipe(Effect.orDie)
    const skills = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Validate review epochs/witnesses before any generic tombstone deletion can hide a corrupt component.
          const reviews = scope === "personal" ? 0 : yield* ReviewStore.eraseScope(tx, repositories)
          yield* tx.delete(BrainEntryTable).where(where).run()
          yield* tx
            .delete(BrainEventTable)
            .where(repositories ? inArray(BrainEventTable.repository_id, repositories) : undefined)
            .run()
          yield* tx
            .delete(BrainTombstoneTable)
            .where(repositories ? inArray(BrainTombstoneTable.repository_id, repositories) : undefined)
            .run()
          if (rows.length)
            yield* tx
              .delete(BrainUseTable)
              .where(
                inArray(
                  BrainUseTable.entry_id,
                  rows.map((row) => row.id),
                ),
              )
              .run()
          // A content-free event advances the durable revocation counter in this transaction. An all-memory erase
          // uses the personal scope, which every digest observes, even after this event is eventually pruned.
          yield* tx
            .insert(BrainEventTable)
            .values({
              entry_id: "",
              repository_id: scope === "all" || scope === "personal" ? PERSONAL : place.repository,
              at: Date.now(),
              action: "forgotten",
              actor: "user",
            })
            .run()
          // Documents belong to a repository whoever added them, so erasing personal memory keeps them. Sections,
          // passages, records and postings go with their document and item. So do learned skills and workflow insights,
          // which are kept per repository; the repository's marker went with its tombstones above.
          if (scope === "personal") return 0
          const skills = yield* SkillStore.eraseScope(tx, repositories)
          yield* tx
            .delete(BrainUseTable)
            .where(
              inArray(
                BrainUseTable.entry_id,
                tx
                  .select({ ref: BrainItemTable.ref })
                  .from(BrainItemTable)
                  .where(repositories ? inArray(BrainItemTable.repository_id, repositories) : undefined),
              ),
            )
            .run()
          yield* Effect.forEach(
            [
              BrainVectorTable,
              BrainItemTable,
              BrainDocumentTable,
              BrainTermTable,
              BrainAnchorTable,
              BrainPendingTable,
              BrainEdgeTable,
              BrainJobTable,
              BrainReviewTable,
              BrainCodeFileTable,
              BrainCodeSymbolTable,
              BrainCodeLiteralTable,
            ],
            (table) =>
              tx
                .delete(table)
                .where(repositories ? inArray(table.repository_id, repositories) : undefined)
                .run(),
            { discard: true },
          )
          yield* tx
            .update(BrainStateTable)
            .set({
              knowledge_revision: sql`${BrainStateTable.knowledge_revision} + 1`,
              items: 0,
              item_length_sum: 0,
              code_revision: sql`${BrainStateTable.code_revision} + 1`,
              code_head: null,
            })
            .where(repositories ? inArray(BrainStateTable.repository_id, repositories) : undefined)
            .run()
          return skills + reviews
        }),
      )
      .pipe(Effect.orDie)
    if (scope === "all")
      yield* Effect.promise(() => fs.rm(BrainPaths.documents(dirs.data), { recursive: true, force: true }))
    if (scope === "repository" && kept.length > 0) {
      // A copy another repository's document still keeps stays.
      const still = new Set(
        (yield* db
          .select({ hash: BrainDocumentTable.content_hash })
          .from(BrainDocumentTable)
          .where(
            and(
              eq(BrainDocumentTable.stored, true),
              inArray(
                BrainDocumentTable.content_hash,
                kept.map((copy) => copy.hash),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)).map((row) => row.hash),
      )
      yield* Effect.promise(() =>
        Promise.all(
          kept
            .filter((copy) => !still.has(copy.hash))
            .map((copy) =>
              fs.rm(BrainPaths.original(BrainPaths.documents(dirs.data), copy.hash, copy.format), { force: true }),
            ),
        ),
      )
    }
    // What Vector learned in a repository includes its failure memory.
    if (scope !== "personal") {
      const files = scope === "all" ? [path.join(BrainPaths.directory(dirs.data), "failures")] : [failureFile(place)]
      yield* Effect.promise(() => Promise.all(files.map((file) => fs.rm(file, { recursive: true, force: true }))))
      yield* db
        .delete(BrainEntryTable)
        .where(
          scope === "all"
            ? eq(BrainEntryTable.origin, "failure-memory")
            : and(eq(BrainEntryTable.origin, "failure-memory"), eq(BrainEntryTable.source_file, failureFile(place))),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(BrainSourceTable)
        .where(
          scope === "all"
            ? sql`${BrainSourceTable.path} LIKE ${"%" + path.sep + "failures" + path.sep + "%"}`
            : eq(BrainSourceTable.path, failureFile(place)),
        )
        .run()
        .pipe(Effect.orDie)
    }
    if (scope === "all") yield* db.run("VACUUM").pipe(Effect.orDie)
    yield* bump(scope === "personal" ? PERSONAL : place.repository)
    return rows.length + skills
  })

  // What Vector learned in one session alone: its entries whose every piece of evidence came from that session. An
  // entry another session also taught, or the user wrote, stays; what goes is forgotten, so it is not learned again.
  const eraseSession = Effect.fn("Brain.eraseSession")(function* (place: Place, sessionID: string) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Review preflight is first; every ordinary/review/skill mutation below commits or rolls back together.
          const reviews = yield* ReviewStore.eraseSession(tx, place.repository, sessionID)
          const rows = yield* tx
            .select()
            .from(BrainEntryTable)
            .where(
              and(
                inArray(BrainEntryTable.repository_id, [place.repository, PERSONAL]),
                eq(BrainEntryTable.origin, "agent"),
                inArray(
                  BrainEntryTable.id,
                  tx
                    .select({ id: BrainEvidenceTable.entry_id })
                    .from(BrainEvidenceTable)
                    .where(eq(BrainEvidenceTable.session_id, sessionID)),
                ),
              ),
            )
            .all()
          const others = rows.length
            ? new Set(
                (yield* tx
                  .selectDistinct({ id: BrainEvidenceTable.entry_id })
                  .from(BrainEvidenceTable)
                  .where(
                    and(
                      inArray(
                        BrainEvidenceTable.entry_id,
                        rows.map((row) => row.id),
                      ),
                      or(isNull(BrainEvidenceTable.session_id), ne(BrainEvidenceTable.session_id, sessionID)),
                    ),
                  )
                  .all()).map((row) => row.id),
              )
            : new Set<string>()
          const only = rows.filter((row) => !others.has(row.id))
          yield* Effect.forEach(only, (row) => forgetIn(tx, row), { discard: true })
          // Keep the existing rollback/retention policy for skills and entries with evidence from another session.
          const skills = yield* SkillStore.eraseSession(tx, place.repository, sessionID)
          if (skills.changed > 0) yield* bumpIn(tx, place.repository)
          return only.length + skills.removed + reviews
        }),
      )
      .pipe(Effect.orDie)
  })

  // --- Tidying ----------------------------------------------------------------------------------------------------

  const consolidate = Effect.fn("Brain.consolidate")(function* (place: Place, options?: { force?: boolean }) {
    const state = yield* db
      .select()
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, place.repository))
      .get()
      .pipe(Effect.orDie)
    const now = Date.now()
    if (!options?.force && state?.consolidated_at && now - state.consolidated_at < 6 * HOUR)
      return { skipped: true, merged: 0, promoted: 0, archived: 0, dropped: 0, stale: 0 }
    const counts = { merged: 0, archived: 0, dropped: 0, stale: 0 }
    // Proven knowledge halves every 90 days: the counts decay by the time since the last pass, before anything reads
    // them below. The personal scope's own pass time is its state row's.
    const personalState = yield* db
      .select({ at: BrainStateTable.consolidated_at })
      .from(BrainStateTable)
      .where(eq(BrainStateTable.repository_id, PERSONAL))
      .get()
      .pipe(Effect.orDie)
    // A repository's learned skills decay with it.
    for (const [repository, since] of [
      [place.repository, state?.consolidated_at],
      [SkillStore.namespace(place.repository), state?.consolidated_at],
      [PERSONAL, personalState?.at],
    ] as const) {
      const factor = since ? BrainCredit.factor(now - since) : 1
      if (factor < 1)
        yield* db
          .update(BrainEntryTable)
          .set({
            helpful: sql`${BrainEntryTable.helpful} * ${factor}`,
            harmful: sql`${BrainEntryTable.harmful} * ${factor}`,
          })
          .where(
            and(
              eq(BrainEntryTable.repository_id, repository),
              or(gt(BrainEntryTable.helpful, 0), gt(BrainEntryTable.harmful, 0)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
    }
    for (const repository of [place.repository, PERSONAL]) {
      const rows = yield* db
        .select()
        .from(BrainEntryTable)
        .where(
          and(
            eq(BrainEntryTable.repository_id, repository),
            inArray(BrainEntryTable.origin, [...LEARNED]),
            inArray(BrainEntryTable.status, ["active", "proposed", "quarantined"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      // 1. Near-duplicates of an entry in use merge into one: the user's wording first, then one in use, then the
      //    newest. Only a wording that adds nothing to the kept one goes, so two facts that share most of their words
      //    ("from packages/web", "from packages/app") both stay; a proposal an earlier version left waiting may also
      //    fold into an entry in use it only adds words to. Two proposals never merge, so tidying puts nothing in use,
      //    and a correction (a different turn of the same words) stays apart. Entries are bucketed by term, so a pass
      //    compares only entries that share words, and each one's terms are decoded once.
      const live = rows.filter((row) => row.status !== "quarantined").toSorted((a, b) => a.created_at - b.created_at)
      const decoded = new Map(live.map((row) => [row.id, decode(row.terms)]))
      const turns = new Map(live.map((row) => [row.id, BrainLexical.polarity(row.body)]))
      const order = new Map(live.map((row, index) => [row.id, index]))
      const buckets = new Map<string, Row[]>()
      for (const row of live)
        for (const term of decoded.get(row.id)!.keys()) {
          const bucket = buckets.get(term)
          if (bucket) bucket.push(row)
          else buckets.set(term, [row])
        }
      const gone = new Set<string>()
      for (const row of live.filter((item) => item.status === "active")) {
        if (gone.has(row.id)) continue
        const terms = decoded.get(row.id)!
        const shared = new Map<string, { other: Row; count: number }>()
        for (const term of terms.keys())
          for (const other of buckets.get(term) ?? []) {
            if (other.id === row.id || gone.has(other.id)) continue
            // A pair of entries in use is looked at once, from the older one.
            if (other.status === "active" && order.get(other.id)! < order.get(row.id)!) continue
            shared.set(other.id, { other, count: (shared.get(other.id)?.count ?? 0) + 1 })
          }
        const matches = [...shared.values()]
          .filter(({ other, count }) => {
            if (other.kind !== row.kind || turns.get(other.id) !== turns.get(row.id)) return false
            return count / (terms.size + decoded.get(other.id)!.size - count) >= SIMILAR
          })
          .map((item) => item.other)
          .toSorted((a, b) => order.get(a.id)! - order.get(b.id)!)
        for (const other of matches) {
          if (gone.has(row.id)) break
          const keeper =
            rank(other) > rank(row) || (rank(other) === rank(row) && other.status === "active") ? other : row
          const loser = keeper === row ? other : row
          if (loser.pinned) continue
          const kept = { body: keeper.body, terms: decoded.get(keeper.id)! }
          const lost = { body: loser.body, terms: decoded.get(loser.id)! }
          if (!within(lost, kept) && !(loser.status === "proposed" && within(kept, lost))) continue
          gone.add(loser.id)
          counts.merged++
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(BrainEvidenceTable)
                  .set({ entry_id: keeper.id })
                  .where(eq(BrainEvidenceTable.entry_id, loser.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({ status: "superseded", superseded_by: keeper.id, updated_at: now })
                  .where(eq(BrainEntryTable.id, loser.id))
                  .run()
                yield* tx
                  .update(BrainEntryTable)
                  .set({
                    uses: keeper.uses + loser.uses,
                    paths: [...new Set([...keeper.paths, ...loser.paths])],
                    updated_at: now,
                  })
                  .where(eq(BrainEntryTable.id, keeper.id))
                  .run()
              }),
            )
            .pipe(Effect.orDie)
          // Later merges into the same keeper add to what it has now.
          keeper.uses += loser.uses
          keeper.paths = [...new Set([...keeper.paths, ...loser.paths])]
          yield* event(loser, "merged", "vector", { into: keeper.id })
        }
      }
      const kept = rows.filter((row) => !gone.has(row.id))
      // 2. An entry held for review that the user has not looked at in 30 days is dropped, and so is a proposal an
      //    earlier version left waiting. Tidying never puts either in use: planted text reaches every session that reads
      //    it, so what was held goes into use only with the user's approval.
      for (const row of kept) {
        if (row.status === "quarantined" || row.status === "proposed") {
          if (now - row.created_at <= 30 * DAY) continue
          counts.dropped++
          yield* db.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run().pipe(Effect.orDie)
          continue
        }
        // 3. Unused for 90 days, or more often harmful than helpful: archived, where the user can restore it.
        if (
          !row.pinned &&
          ((now - (row.last_used_at ?? row.created_at) > 90 * DAY && row.uses < 2) || row.harmful > row.helpful)
        ) {
          counts.archived++
          yield* db
            .update(BrainEntryTable)
            .set({ status: "archived", updated_at: now })
            .where(eq(BrainEntryTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
          yield* event(row, "archived", "vector")
        }
      }
      counts.archived += yield* capacity(repository)
    }
    // 4. An entry whose cited file changed so the quote is gone is stale: kept out of automatic tiers until re-checked.
    //    Every entry in use is checked against its newest cited line on every tidy. The capacity cap keeps that to a
    //    few hundred entries, and each cited file is read once.
    const cited = yield* db
      .select({
        entry: BrainEvidenceTable.entry_id,
        path: BrainEvidenceTable.path,
        quote: BrainEvidenceTable.quote,
        stale: BrainEntryTable.stale,
      })
      .from(BrainEvidenceTable)
      .innerJoin(BrainEntryTable, eq(BrainEntryTable.id, BrainEvidenceTable.entry_id))
      .where(
        and(
          eq(BrainEvidenceTable.type, "file"),
          eq(BrainEntryTable.repository_id, place.repository),
          eq(BrainEntryTable.status, "active"),
          isNotNull(BrainEvidenceTable.path),
          isNotNull(BrainEvidenceTable.quote),
        ),
      )
      .orderBy(asc(BrainEvidenceTable.id))
      .all()
      .pipe(Effect.orDie)
    const contents = new Map<string, string>()
    for (const item of new Map(cited.map((row) => [row.entry, row])).values()) {
      const target = path.resolve(place.root, item.path!)
      if (!contents.has(target))
        contents.set(target, normalise(yield* Effect.promise(() => fs.readFile(target, "utf8").catch(() => ""))))
      const content = contents.get(target)
      const stale = !content || !content.includes(normalise(item.quote!))
      if (stale === item.stale) continue
      if (stale) counts.stale++
      yield* db
        .update(BrainEntryTable)
        .set({ stale })
        .where(eq(BrainEntryTable.id, item.entry))
        .run()
        .pipe(Effect.orDie)
    }
    // 4b. Mirrors of files that are gone, such as a removed worktree's or Parallel Workspace's rules and BRAIN.md, leave
    //     the brain: nothing else removes them, and every query of the repository scans them. So does the failure
    //     memory of a working tree no session here has read in 90 days; its file stays and is read again if that
    //     working tree is opened.
    const current = new Set(repositoryFiles(place))
    const mirrored = yield* db
      .select()
      .from(BrainSourceTable)
      .where(eq(BrainSourceTable.repository_id, place.repository))
      .all()
      .pipe(Effect.orDie)
    const orphaned: string[] = []
    for (const source of mirrored.filter((item) => !current.has(item.path))) {
      const gone = !(yield* Effect.promise(() => statFollowing(source).then((stat) => stat?.isFile() ?? false)))
      const unread = path.dirname(source.path) === path.dirname(failureFile(place)) && now - source.synced_at > 90 * DAY
      if (gone || unread) orphaned.push(source.path)
    }
    if (orphaned.length)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(BrainEntryTable).where(inArray(BrainEntryTable.source_file, orphaned)).run()
            yield* tx.delete(BrainSourceTable).where(inArray(BrainSourceTable.path, orphaned)).run()
          }),
        )
        .pipe(Effect.orDie)
    // 5. Old links, history and tombstones go, and the archive keeps its newest entries, so the brain stays small
    //    however long it is used: replaced entries after 180 days, the oldest archived past the cap, history past 180
    //    days or an entry's newest events (a pending replacement's link is kept until it is reviewed).
    const scopes = [place.repository, PERSONAL]
    yield* db
      .delete(BrainEntryTable)
      .where(
        and(
          inArray(BrainEntryTable.repository_id, scopes),
          eq(BrainEntryTable.status, "superseded"),
          lt(BrainEntryTable.updated_at, now - 180 * DAY),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    for (const repository of scopes) {
      const archived = yield* db
        .select({ id: BrainEntryTable.id })
        .from(BrainEntryTable)
        .where(
          and(
            eq(BrainEntryTable.repository_id, repository),
            inArray(BrainEntryTable.origin, [...LEARNED]),
            inArray(BrainEntryTable.status, ["archived", "superseded"]),
          ),
        )
        .orderBy(desc(BrainEntryTable.updated_at))
        .all()
        .pipe(Effect.orDie)
      const excess = archived.slice(LIMIT.archived).map((row) => row.id)
      if (excess.length) {
        yield* db.delete(BrainEntryTable).where(inArray(BrainEntryTable.id, excess)).run().pipe(Effect.orDie)
        yield* db.delete(BrainUseTable).where(inArray(BrainUseTable.entry_id, excess)).run().pipe(Effect.orDie)
        yield* db.delete(BrainEventTable).where(inArray(BrainEventTable.entry_id, excess)).run().pipe(Effect.orDie)
      }
    }
    yield* db
      .delete(BrainEventTable)
      .where(
        and(
          inArray(BrainEventTable.repository_id, scopes),
          or(
            lt(BrainEventTable.at, now - 180 * DAY),
            sql`${BrainEventTable.action} != 'added' AND ${BrainEventTable.id} IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY id DESC) AS n FROM brain_event) WHERE n > ${LIMIT.events})`,
          ),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db.delete(BrainTombstoneTable).where(lt(BrainTombstoneTable.until, now)).run().pipe(Effect.orDie)
    yield* db
      .delete(BrainUseTable)
      .where(lt(BrainUseTable.at, now - 30 * DAY))
      .run()
      .pipe(Effect.orDie)
    // 6. Learned skills keep their own rules (SkillStore.tidy): they never merge, and drafts wait 60 days.
    const skills = yield* SkillStore.tidy(db, place, now)
    counts.archived += skills.archived
    counts.dropped += skills.dropped
    counts.stale += skills.stale
    for (const repository of [place.repository, PERSONAL])
      yield* db
        .insert(BrainStateTable)
        .values({ repository_id: repository, consolidated_at: now })
        .onConflictDoUpdate({ target: BrainStateTable.repository_id, set: { consolidated_at: now } })
        .run()
        .pipe(Effect.orDie)
    if (counts.merged + counts.archived + counts.dropped + counts.stale + orphaned.length > 0) {
      yield* bump(place.repository)
      yield* bump(PERSONAL)
    }
    return { skipped: false, promoted: 0, ...counts }
  })

  const stats = Effect.fn("Brain.stats")(function* (place: Place) {
    const rows = yield* db
      .select({ status: BrainEntryTable.status, kind: BrainEntryTable.kind, origin: BrainEntryTable.origin })
      .from(BrainEntryTable)
      .where(visible(place, true))
      .all()
      .pipe(Effect.orDie)
    const shown = yield* digest(place, { personal: true, index: true })
    const skills = yield* db
      .select({ status: BrainEntryTable.status })
      .from(BrainEntryTable)
      .where(eq(BrainEntryTable.repository_id, SkillStore.namespace(place.repository)))
      .all()
      .pipe(Effect.orDie)
    return {
      active: rows.filter((row) => row.status === "active").length,
      review: rows.filter((row) => row.status === "proposed" || row.status === "quarantined").length,
      archived: rows.filter((row) => row.status === "archived" || row.status === "superseded").length,
      rules: rows.filter((row) => row.kind === "rule" && row.status === "active").length,
      learned: rows.filter((row) => LEARNED.includes(row.origin) && row.status === "active").length,
      digestTokens: shown.tokens,
      learning: yield* learning(),
      skills: {
        active: skills.filter((row) => row.status === "active").length,
        review: skills.filter((row) => row.status === "proposed" || row.status === "quarantined").length,
      },
    }
  })

  return {
    sync,
    digest,
    habits,
    posting,
    candidates,
    used: (ids, input) => used(ids, input.sessionID, input.tier, input.tokens, input.requestID),
    credit,
    recall,
    attach,
    search,
    get,
    lines,
    list,
    propose,
    dismissReview,
    update,
    forget,
    erase,
    consolidate,
    stats,
    learning,
    setLearning,
    learnSettings,
    setLearnSettings,
    eraseSession,
    written,
    files: () => personalFiles,
  }
}

// --- Helpers --------------------------------------------------------------------------------------------------------

// A mirrored file, following a link: people keep MEMORY.md and RULES.md in a dotfiles folder and link them in. A
// repository's own link counts only where it lands inside the working tree, as its instruction files do, so a clone
// cannot feed ~/.ssh/id_rsa into a prompt as "rules".
async function statFollowing(source: { readonly path: string; readonly root?: string }) {
  const link = await fs.lstat(source.path).catch(() => undefined)
  if (!link?.isSymbolicLink()) return link
  const target = await fs.realpath(source.path).catch(() => undefined)
  if (!target) return undefined
  if (source.root) {
    const root = await fs.realpath(source.root).catch(() => path.resolve(source.root!))
    const inside = path.relative(root, target)
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined
  }
  return fs.stat(target).catch(() => undefined)
}

function parse(source: { readonly type: "rules" | "memory" | "brain" | "failures" }, content: string) {
  if (source.type === "rules") return BrainParse.rules(content)
  if (source.type === "memory") return BrainParse.memory(content)
  if (source.type === "brain") return BrainParse.brain(content)
  return BrainParse.failures(content)
}

function itemHold(
  source: { readonly type: string; readonly held: boolean },
  item: BrainParse.Item,
): BrainSchema.Hold | undefined {
  if (BrainScan.hidden(item.text)) return "hidden-unicode"
  if (source.held) return "untrusted-repository"
  // A person's own rules and MEMORY.md are instructions by design; memory a repository ships or Vector recorded is not.
  if ((source.type === "brain" || source.type === "failures") && BrainScan.instructionLike(item.text))
    return "instruction-like"
  return undefined
}

function dedupe(items: readonly BrainParse.Item[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.signature ?? normHash(item.text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Rules and MEMORY.md as they go in the cached prefix, and which of their items that covers.
function render(
  source: { readonly type: "rules" | "memory" | "brain" | "failures" },
  content: string,
  rows: readonly Row[],
): { text?: string; ids: string[] } | undefined {
  const byLine = new Map(rows.map((row) => [row.source_line, row]))
  if (source.type === "rules") {
    // A scoped rule binds as much as any other and is a line long, so it goes in whole too: attached only when a file
    // is read, it never reached a file the agent wrote, patched or changed through bash.
    const omit = (item: BrainParse.Item) => {
      const row = byLine.get(item.line)
      return item.kind === "review" || row?.status !== "active"
    }
    const text = BrainParse.rulesText(BrainScan.stripHidden(content), omit)
    return {
      ...(text ? { text } : {}),
      ids: rows.filter((row) => row.status === "active" && row.kind === "rule").map((row) => row.id),
    }
  }
  if (source.type !== "memory") return undefined
  const active = rows.filter((row) => row.status === "active")
  const whole = BrainParse.memoryText(content)
  if (active.length === rows.length && Token.estimate(whole) <= BUDGET.memory)
    return { ...(whole ? { text: whole } : {}), ids: active.map((row) => row.id) }
  // Past its budget, MEMORY.md goes in file order until the budget is spent; the rest is recalled when relevant. Each
  // kept item goes under its heading, and a heading with nothing under it stays too: people write facts as headings
  // ("## I use Neovim").
  const marks = BrainParse.headings(content)
  const section = (line: number) => marks.findLast((mark) => mark.line < line)
  const alone = marks.filter((mark, index) =>
    rows.every(
      (row) => (row.source_line ?? 0) < mark.line || (row.source_line ?? 0) > (marks[index + 1]?.line ?? Infinity),
    ),
  )
  const entries = [
    ...alone.map((mark) => ({ line: mark.line, text: mark.text, row: undefined, heading: undefined })),
    ...active.map((row) => ({
      line: row.source_line ?? 0,
      text: `- ${row.body}`,
      row,
      heading: section(row.source_line ?? 0),
    })),
  ].toSorted((a, b) => a.line - b.line)
  const kept = entries.reduce<{ lines: string[]; rows: Row[]; headed: number[] }>(
    (list, entry) => {
      const head = entry.heading && !list.headed.includes(entry.heading.line) ? [entry.heading] : []
      const lines = [...list.lines, ...head.map((mark) => mark.text), entry.text]
      if (Token.estimate(lines.join("\n")) > BUDGET.memory - 40) return list
      return {
        lines,
        rows: entry.row ? [...list.rows, entry.row] : list.rows,
        headed: [...list.headed, ...head.map((mark) => mark.line)],
      }
    },
    { lines: [], rows: [], headed: [] },
  )
  const more = active.length - kept.rows.length
  const text = [
    ...kept.lines,
    ...(more > 0 ? [`(${more} more saved item${more === 1 ? " is" : "s are"} recalled when relevant.)`] : []),
  ].join("\n")
  return { ...(text ? { text } : {}), ids: kept.rows.map((row) => row.id) }
}

function label(place: Place, file: string) {
  const relativePath = BrainPaths.relative(place.root, file)
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? relativePath : file
}

/** A file pattern from a rule or entry: a glob, or a bare directory that covers everything under it. */
export function matches(pattern: string, file: string) {
  const clean = pattern.replace(/^\.\//, "").replace(/\\/g, "/")
  if (!/[*?[]/.test(clean)) {
    const prefix = clean.replace(/\/$/, "")
    if (file === prefix || file.startsWith(`${prefix}/`)) return true
  }
  return Glob.match(clean, file)
}

function line(row: Pick<Row, "id" | "kind" | "body" | "paths">) {
  const scope = row.paths.length ? ` (${row.paths.slice(0, 3).join(", ")})` : ""
  return `- [${row.id}] ${row.kind}${scope}: ${row.body}`
}

function tokensOf(rows: readonly Pick<Row, "id" | "kind" | "body" | "paths">[]) {
  return Token.estimate(rows.map(line).join("\n"))
}

function normalise(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function normHash(text: string) {
  return createHash("sha256")
    .update(
      BrainScan.stripHidden(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    )
    .digest("hex")
    .slice(0, 24)
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Bytes in the brain's base32 alphabet, which entry ids are written in. */
export function base32(bytes: Uint8Array) {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function fileId(file: string, key: string) {
  return `f${base32(
    createHash("sha256")
      .update(`${file}\0${normalise(key)}`)
      .digest(),
  ).slice(0, 6)}`
}

function encode(terms: ReadonlyMap<string, number>) {
  return JSON.stringify(Object.fromEntries(terms))
}

function decode(terms: string): ReadonlyMap<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(terms) as Record<string, number>))
  } catch {
    return new Map()
  }
}

// Which wording of a duplicate tidying keeps: the user's own, then one in use (checked), then a proposal.
function rank(row: Pick<Row, "origin" | "status">) {
  if (row.origin === "user") return 2
  return row.status === "active" ? 1 : 0
}

function confidence(proposal: Pick<Proposal, "origin" | "evidence">, verified: boolean) {
  if (proposal.origin === "user") return 1
  if (!verified) return 0.5
  return proposal.evidence?.type === "message" ? 0.9 : 0.8
}

/**
 * Recalled entries in the order a request carries them. Learned entries that share most of their words may disagree (a
 * rule and a later correction worded differently), so each such group goes newest first, at the place of its best
 * match; `newest` says some group has more than one line.
 */
export function order<C extends Pick<Candidate, "origin" | "terms" | "updatedAt">>(picked: readonly C[]) {
  const groups = picked.reduce<C[][]>((all, item) => {
    if (all.some((group) => group.includes(item))) return all
    const group = picked.filter(
      (other) =>
        other === item ||
        (LEARNED.includes(item.origin) &&
          LEARNED.includes(other.origin) &&
          !all.some((taken) => taken.includes(other)) &&
          Math.max(overlap(item.terms, other.terms), overlap(other.terms, item.terms)) >= RELATED),
    )
    return [...all, group.toSorted((a, b) => b.updatedAt - a.updatedAt)]
  }, [])
  return { ordered: groups.flat(), newest: groups.some((group) => group.length > 1) }
}

const SKILL_ENTRY = "That is a learned skill. Change learned skills in Settings > Memory > Skills."

/** Texts this alike may be one entry's wordings. They are one entry only when one says nothing the other does not. */
const SIMILAR = 0.72

/** A new entry sharing this much of its terms with one in use may correct it, so the writer hears about that one. */
const RELATED = 0.5

/** The share of `own`'s terms that `other` has too, counting at least two shared terms (or all of a short text). */
function overlap(own: ReadonlyMap<string, number>, other: ReadonlyMap<string, number>) {
  const shared = [...own.keys()].filter((term) => other.has(term)).length
  if (shared < Math.min(2, own.size)) return 0
  return shared / Math.max(1, own.size)
}

// Personal memory is what the user said about themselves.
const FIRST_PERSON = /\b(?:i|me|my|mine|myself)\b/i

// What Vector's learner read in the owner's typed words, about how they work anywhere. Neither its words nor the quote
// may name anything of one repository or company: no path, file or identifier of the code, no email, no host name but
// a public site a sources preference names ("prefer nature.com"), no long number, no name ("the Acme billing tests",
// "cc jane"), nor this repository alone ("in this repo"). It is then what they said about themselves ("I prefer
// tables"), unless it is a catch-all style line about parts of the code ("I'd rather you never call the billing client
// from the controller"), or an instruction in so many words whose facet holds in every repository (format, workflow,
// tooling or sources, as "always use tables" and "never squash merge" do). Anything else stays with its repository,
// where its names belong.
function general(text: string, quote: string, facet: BrainSchema.Facet | undefined) {
  if (facet === undefined) return false
  const plain = [text, quote].every(
    (value) =>
      !BrainLearn.scoped(value) &&
      !names(value, facet) &&
      BrainPrivate.tokens(value, ["path", "identifier"]).every(
        (token) => token.kind === "identifier" && BrainLearn.known(token.value),
      ),
  )
  if (!plain) return false
  if (FIRST_PERSON.test(quote)) return facet !== "style" || !CODE_PART.test(quote)
  return normalise(text) === normalise(quote) && GENERAL_FACETS.has(facet) && BrainLearn.instruction(quote)
}
const GENERAL_FACETS: ReadonlySet<BrainSchema.Facet> = new Set(["format", "workflow", "tooling", "sources"])

// Whether words the learner read name someone or something in particular, which is the owner's and not the code's: a
// person, team, client or system (BrainLearn.particular), an email, a host but a public site a sources preference
// names, or a long number. A path or an identifier names the code.
function names(value: string, facet: BrainSchema.Facet | undefined) {
  return (
    BrainLearn.particular(value) ||
    BrainPrivate.tokens(value, BrainPrivate.SHAPED).some(
      (token) => !(token.kind === "host" && facet === "sources" && publicHost(token.value)),
    )
  )
}
// Parts of a codebase a style line may name, which make it about that codebase.
const CODE_PART =
  /\b(?:clients?|controllers?|services?|modules?|components?|handlers?|functions?|methods?|class(?:es)?|endpoints?|routes?|apis?|files?|folders?|director(?:y|ies)|schemas?|migrations?|quer(?:y|ies)|databases?|config(?:s|uration)?|scripts?|jobs?|workers?|queues?|hooks?|utils?|helpers?|packages?|librar(?:y|ies)|dependenc(?:y|ies)|variables?|fields?|columns?|pages?|screens?|dashboards?|views?|buttons?|forms?)\b/i

// A site anyone can reach: a host name under a public top-level domain, not a machine address or a name of a network
// of one company ("wiki.acme.internal", "build.local").
function publicHost(value: string) {
  return (
    !/^[\d.]+$|:/.test(value) &&
    !/\.(?:internal|local|lan|corp|intra|home|test|example|localhost|invalid)$/i.test(value)
  )
}

// A quote counts as evidence only for a memory it states whole and the same way round; a cited file's path counts as
// part of its quote.
function supports(text: string, evidence: Exclude<Evidence, { readonly type: "user" }>) {
  if (evidence.type === "check" || evidence.type === "run") return BrainLexical.named(text, evidence.command)
  return BrainLexical.states(text, evidence.quote, evidence.type === "file" ? evidence.path : "")
}

/**
 * Whether one wording says nothing the other does not: every term of it, as often, turned the same way. Counting
 * matters: "the web tests from packages/web" names web twice, so "the web tests from packages/app" does not hold it.
 */
function within(
  inner: { readonly body: string; readonly terms: ReadonlyMap<string, number> },
  outer: { readonly body: string; readonly terms: ReadonlyMap<string, number> },
) {
  return (
    BrainLexical.polarity(inner.body) === BrainLexical.polarity(outer.body) &&
    [...inner.terms].every(([term, count]) => (outer.terms.get(term) ?? 0) >= count)
  )
}

function scrub(value: string) {
  return BrainScan.redact(BrainScan.stripHidden(value)).text.slice(0, 240)
}

function refuse(reason: Refusal, message: string): WriteResult {
  return { type: "refused", reason, message }
}

function byPlace(a: Row, b: Row) {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
    (a.source_line ?? 0) - (b.source_line ?? 0) ||
    b.updated_at - a.updated_at
  )
}

function tombstoneOf(row: Row) {
  return {
    repository_id: row.repository_id,
    norm_hash: row.norm_hash,
    terms: row.terms,
    polarity: BrainLexical.polarity(row.body),
  }
}

/** An entry row as the brain hands it out. A learned skill's own fields are BrainSkill's to add. */
export function toEntry(row: Row): BrainSchema.Entry {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    pinned: row.pinned,
    text: row.body,
    paths: row.paths,
    confidence: row.confidence,
    uses: row.uses,
    stale: row.stale,
    ...(row.hold_reason ? { hold: row.hold_reason } : {}),
    ...(row.source_file
      ? { source: { file: row.source_file, ...(row.source_line ? { line: row.source_line } : {}) } }
      : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    related: row.related,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.private ? { private: true } : {}),
    ...(facetOf(row) ? { facet: facetOf(row) } : {}),
    ...(row.kind === "term" && row.term_key
      ? { term: { key: row.term_key, meaning: BrainLearn.term(row.body)?.meaning ?? row.body } }
      : {}),
  }
}

// What a preference or a term is about: its own facet, or, for a preference saved before facets existed, what its words
// name. Other kinds have none.
function facetOf(row: Pick<Row, "kind" | "facet" | "body">): BrainSchema.Facet | undefined {
  if (row.kind === "term") return row.facet ?? "vocabulary"
  if (row.kind !== "preference") return undefined
  return row.facet ?? BrainLearn.facetOf(row.body)
}

// Whether an entry is of one of `facets`: always, for no list, and for a kind no facet covers.
function inFacets(row: Pick<Row, "kind" | "facet" | "body">, facets: ReadonlySet<BrainSchema.Facet> | undefined) {
  const facet = facetOf(row)
  return !facets || facet === undefined || facets.has(facet)
}

async function removeFailure(file: string, signature: string) {
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  if (!raw) return
  const parsed = (() => {
    try {
      return JSON.parse(raw) as { records?: { signature?: unknown }[] }
    } catch {
      return undefined
    }
  })()
  if (!parsed || !Array.isArray(parsed.records)) return
  const next = { ...parsed, records: parsed.records.filter((record) => record?.signature !== signature) }
  const staged = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  await fs.rename(staged, file)
}
